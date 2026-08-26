import { createHash, randomBytes } from "node:crypto";
import type { AsyncLiveAdapter, LiveAdapter, LiveOperationContext, LiveSnapshot, LiveStatus } from "../live.js";
import { canonical, fingerprint, flattenDeviceRows, isNonEmptyString, isObject, parameterAuthority, parameterRevision, parameterTarget } from "./batch.js";

/**
 * Device/rack parameter-state snapshots: save a device's (or rack subtree's)
 * parameter values to a named owner-scoped file, recall them later onto the
 * same or an equivalent device, and optionally interpolate ("morph") between
 * two states by an explicit 0..1 amount (issue #50).
 *
 * Snapshot files are schema-versioned JSON with a content digest and a
 * privacy profile: parameter and device names only — never project paths,
 * session refs, object identities, or filesystem paths.
 *
 * Recall is compatibility-fenced: the recorded device class identity
 * (className, falling back to display name, plus kind) must match the target,
 * and the recorded parameter-layout fingerprint must match unless the caller
 * explicitly opts into partial-layout recall. Device-class mismatch — and
 * layout mismatch without the opt-in — refuse before any write with a
 * per-parameter incompatibility report. Read-only, disabled, missing, or
 * rebounded parameters are skipped with explicit per-parameter dispositions.
 *
 * Morph is computed host-side: float64 linear interpolation with documented
 * deterministic quantization rounding (half-up from the parameter minimum),
 * so identical inputs and amount always produce identical values.
 */

export const DEVICE_STATE_SCHEMA = "ableton-mcp-device-state/v1";
export const DEVICE_STATE_TRANSACTION_TTL_MS = 30_000;
export const MAX_DEVICE_STATE_PARAMETERS = 1024;

export interface DeviceStateParameterRow {
  path: string;
  name: string;
  value: number;
  min: number;
  max: number;
  quantization: number;
}

export interface DeviceStateFileCore {
  schema: typeof DEVICE_STATE_SCHEMA;
  name: string;
  device: { identity: { name: string; className: string | null; kind: string }; parameterCount: number; layoutFingerprint: string };
  privacy: { profile: string; note: string };
  parameters: DeviceStateParameterRow[];
}

export interface DeviceStateFile extends DeviceStateFileCore {
  savedAt: string;
  digest: string;
}

type Row = Record<string, unknown>;

function clone<T>(value: T): T { return structuredClone(value); }

function deviceIdentity(row: Row): { name: string; className: string | null; kind: string } {
  if (!isNonEmptyString(row.name, 256)) throw new Error("device state requires a named device row");
  return { name: row.name, className: typeof row.className === "string" && row.className.length > 0 && row.className.length <= 256 ? row.className : null, kind: typeof row.kind === "string" ? row.kind : "device" };
}

/** The comparable class key: the device className when the Live shape exposes
 *  it, otherwise the display name (documented fallback evidence). */
function deviceClassKey(identity: { name: string; className: string | null; kind: string }): string {
  return `${identity.kind}:${identity.className ?? identity.name}`;
}

interface SubtreeRow extends DeviceStateParameterRow {
  parameterRef: string;
  deviceRef: string;
  automatable: boolean;
  enabled: boolean;
  deviceEnabled: boolean;
}

/** Walk a device subtree (chains and drum-pad chains) into stable named
 *  parameter paths: `Device/Chain[index]/…/Device[index]/Parameter`. Every
 *  nested sibling segment includes its zero-based array index so duplicate
 *  display names remain independently addressable without persisting refs.
 *  Refs are captured for the live transaction only. */
function subtreeParameters(device: Row, prefix = "", siblingIndex?: number): SubtreeRow[] {
  const rows: SubtreeRow[] = [];
  const deviceName = isNonEmptyString(device.name, 256) ? device.name : "unnamed";
  const deviceRef = typeof device.ref === "string" ? device.ref : "";
  const base = `${prefix}${deviceName}${siblingIndex === undefined ? "" : `[${siblingIndex}]`}`;
  const parameters = (Array.isArray(device.parameters) ? device.parameters : []) as unknown[];
  for (const parameter of parameters.filter(isObject)) {
    if (!isNonEmptyString(parameter.ref, 256) || !isNonEmptyString(parameter.name, 256)) throw new Error("device state parameter identity is unavailable");
    if (typeof parameter.value !== "number" || !Number.isFinite(parameter.value) || typeof parameter.min !== "number" || typeof parameter.max !== "number") continue;
    const quantization = typeof parameter.quantization === "number" && Number.isFinite(parameter.quantization) ? parameter.quantization : 0;
    rows.push({ path: `${base}/${parameter.name}`, name: parameter.name, value: parameter.value, min: parameter.min, max: parameter.max, quantization, parameterRef: parameter.ref, deviceRef, automatable: parameter.automatable === true, enabled: parameter.enabled !== false, deviceEnabled: device.enabled !== false });
  }
  const visitChild = (child: unknown, segment: string, index: number): void => { if (isObject(child)) rows.push(...subtreeParameters(child, `${base}/${segment}/`, index)); };
  const chains = (Array.isArray(device.chains) ? device.chains : []) as unknown[];
  chains.forEach((chain, chainIndex) => {
    if (!isObject(chain)) return;
    const chainName = isNonEmptyString(chain.name, 256) ? chain.name : `chain-${String(chain.index ?? chainIndex)}`;
    const chainSegment = `${chainName}[${chainIndex}]`;
    ((Array.isArray(chain.devices) ? chain.devices : []) as unknown[]).forEach((child, childIndex) => visitChild(child, chainSegment, childIndex));
  });
  const drumPads = (Array.isArray(device.drumPads) ? device.drumPads : []) as unknown[];
  drumPads.forEach((pad, padIndex) => {
    if (!isObject(pad)) return;
    const padName = isNonEmptyString(pad.name, 256) ? pad.name : `pad-${String(pad.index ?? padIndex)}`;
    ((Array.isArray(pad.chains) ? pad.chains : []) as unknown[]).forEach((chain, chainIndex) => {
      if (!isObject(chain)) return;
      const chainName = isNonEmptyString(chain.name, 256) ? chain.name : `chain-${String(chain.index ?? chainIndex)}`;
      const segment = `${padName}[${padIndex}]/${chainName}[${chainIndex}]`;
      ((Array.isArray(chain.devices) ? chain.devices : []) as unknown[]).forEach((child, childIndex) => visitChild(child, segment, childIndex));
    });
  });
  return rows;
}

function layoutFingerprint(rows: ReadonlyArray<Pick<SubtreeRow, "path" | "min" | "max" | "quantization">>): string {
  return fingerprint(rows.map((row) => ({ path: row.path, min: row.min, max: row.max, quantization: row.quantization })));
}

function deviceStateDigest(core: DeviceStateFileCore): string {
  return createHash("sha256").update(canonical({ schema: core.schema, device: core.device, parameters: core.parameters })).digest("hex");
}

function findDeviceRow(snapshot: LiveSnapshot, deviceRef: string): Row {
  for (const track of snapshot.tracks as unknown as Row[]) {
    const found = flattenDeviceRows(track.devices).find((item) => item.ref === deviceRef);
    if (found) return found;
  }
  throw new Error("device state target reference is not an authoritative device");
}

/** Build the versioned snapshot file object for one device subtree. */
export function buildDeviceStateFile(snapshot: LiveSnapshot, deviceRef: string, name: string): DeviceStateFile {
  const row = findDeviceRow(snapshot, deviceRef);
  const identity = deviceIdentity(row);
  const subtree = subtreeParameters(row);
  if (subtree.length < 1 || subtree.length > MAX_DEVICE_STATE_PARAMETERS) throw new Error("device state requires 1-1024 numeric parameters in the target subtree");
  const core: DeviceStateFileCore = {
    schema: DEVICE_STATE_SCHEMA,
    name,
    device: { identity, parameterCount: subtree.length, layoutFingerprint: layoutFingerprint(subtree) },
    privacy: { profile: "device-state/v1", note: "parameter and device names only; no project paths, session refs, object identities, or filesystem paths are persisted" },
    parameters: subtree.map(({ path, name: parameterName, value, min, max, quantization }) => ({ path, name: parameterName, value, min, max, quantization })),
  };
  return { ...core, savedAt: new Date().toISOString(), digest: deviceStateDigest(core) };
}

/** Validate an untrusted parsed JSON value as a device-state file, verifying
 *  schema version, shape, bounds, and the content digest. */
export function validateDeviceStateFile(data: unknown): DeviceStateFile {
  if (!isObject(data)) throw new Error("device state file is not a JSON object");
  if (data.schema !== DEVICE_STATE_SCHEMA) throw new Error(`device state file schema is unsupported (expected ${DEVICE_STATE_SCHEMA})`);
  if (!isNonEmptyString(data.name, 64) || !isNonEmptyString(data.savedAt, 64) || !isNonEmptyString(data.digest, 64) || !/^[a-f0-9]{64}$/.test(data.digest)) throw new Error("device state file name, timestamp, or digest is invalid");
  if (!isObject(data.device) || !isObject(data.device.identity) || !isNonEmptyString(data.device.identity.name, 256) || (data.device.identity.className !== null && !isNonEmptyString(data.device.identity.className, 256)) || !isNonEmptyString(data.device.identity.kind, 64) || !Number.isInteger(data.device.parameterCount) || !isNonEmptyString(data.device.layoutFingerprint, 64)) throw new Error("device state file device identity is invalid");
  if (!isObject(data.privacy) || typeof data.privacy.profile !== "string") throw new Error("device state file privacy profile is missing");
  if (!Array.isArray(data.parameters) || data.parameters.length < 1 || data.parameters.length > MAX_DEVICE_STATE_PARAMETERS || data.parameters.length !== data.device.parameterCount) throw new Error("device state file parameter list is invalid");
  const seen = new Set<string>();
  for (const row of data.parameters) {
    if (!isObject(row) || !isNonEmptyString(row.path, 512) || !isNonEmptyString(row.name, 256) || typeof row.value !== "number" || !Number.isFinite(row.value) || typeof row.min !== "number" || typeof row.max !== "number" || !(row.min <= row.max) || typeof row.quantization !== "number" || !Number.isFinite(row.quantization) || row.quantization < 0 || row.value < row.min || row.value > row.max) throw new Error("device state file parameter row is invalid");
    if (seen.has(row.path)) throw new Error("device state file contains a duplicate parameter path");
    seen.add(row.path);
  }
  const file = clone(data) as unknown as DeviceStateFile;
  if (deviceStateDigest(file) !== data.digest) throw new Error("device state file content digest does not match; the file was modified or corrupted");
  return file;
}

export type DeviceStateDisposition = "applicable" | "skipped-read-only" | "skipped-missing" | "skipped-rebound";

export interface DeviceStateDispositionRow {
  path: string;
  disposition: DeviceStateDisposition;
  reason?: string;
  fileValue: number;
  proposedValue?: number;
  targetValue?: number;
  parameterRef?: string;
  deviceRef?: string;
}

/** Deterministic morph: float64 lerp, then half-up quantization rounding from
 *  the parameter minimum and clamping to authoritative bounds. Identical
 *  inputs and amount always produce identical values. */
export function morphValue(from: number, to: number, amount: number, min: number, max: number, quantization: number): number {
  const raw = from + (to - from) * amount;
  if (quantization > 0) {
    const steps = Math.round((raw - min) / quantization);
    const maxSteps = Math.round((max - min) / quantization);
    return min + Math.min(Math.max(steps, 0), maxSteps) * quantization;
  }
  return Math.min(Math.max(raw, min), max);
}

export interface DeviceStatePlan {
  deviceRef: string;
  identity: { name: string; className: string | null; kind: string };
  layoutFingerprint: string;
  dispositions: DeviceStateDispositionRow[];
  applicable: number;
  skipped: number;
}

/** Compute per-parameter applicability of one validated snapshot file against
 *  a live target subtree. Class-identity mismatches throw (hard refusal with
 *  the report attached); layout mismatches throw unless allowPartialLayout. */
export function planDeviceStateRecall(snapshot: LiveSnapshot, file: DeviceStateFile, targetDeviceRef: string, options: { allowPartialLayout?: boolean; morphFrom?: { kind: "file"; file: DeviceStateFile } | { kind: "live" }; amount?: number } = {}): DeviceStatePlan {
  const row = findDeviceRow(snapshot, targetDeviceRef);
  const identity = deviceIdentity(row);
  const subtree = subtreeParameters(row);
  const report = (reason: string): Error => {
    const dispositions = file.parameters.map((parameter) => {
      const target = subtree.find((candidate) => candidate.path === parameter.path);
      return { path: parameter.path, disposition: target === undefined ? "skipped-missing" : (target.min !== parameter.min || target.max !== parameter.max || target.quantization !== parameter.quantization) ? "skipped-rebound" : "skipped-read-only", reason, fileValue: parameter.value, ...(target ? { targetValue: target.value } : {}) } satisfies DeviceStateDispositionRow;
    });
    const failure = new Error(reason) as Error & { deviceStateReport?: unknown };
    failure.deviceStateReport = { refused: true, reason, target: { deviceRef: targetDeviceRef, identity, layoutFingerprint: layoutFingerprint(subtree) }, file: { name: file.name, identity: file.device.identity, layoutFingerprint: file.device.layoutFingerprint }, dispositions };
    return failure;
  };
  if (deviceClassKey(identity) !== deviceClassKey(file.device.identity)) throw report(`device state device class does not match the target (${deviceClassKey(file.device.identity)} vs ${deviceClassKey(identity)})`);
  const targetFingerprint = layoutFingerprint(subtree);
  const allowPartial = options.allowPartialLayout === true;
  if (targetFingerprint !== file.device.layoutFingerprint && !allowPartial) throw report("device state parameter-layout fingerprint does not match the target; re-save a fresh snapshot or pass allowPartialLayout for a partial recall with per-parameter skips");
  const amount = options.amount;
  const morphFrom = options.morphFrom;
  if (morphFrom !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1)) throw new Error("device state morph requires an explicit amount from 0 to 1");
  let morphFile: DeviceStateFile | undefined;
  if (morphFrom?.kind === "file") {
    if (deviceClassKey(identity) !== deviceClassKey(morphFrom.file.device.identity)) throw report("device state morph source device class does not match the target");
    morphFile = morphFrom.file;
  }
  const dispositions: DeviceStateDispositionRow[] = [];
  for (const parameter of file.parameters) {
    const target = subtree.find((candidate) => candidate.path === parameter.path);
    if (target === undefined) { dispositions.push({ path: parameter.path, disposition: "skipped-missing", reason: "no parameter with this stable path exists on the target", fileValue: parameter.value }); continue; }
    if (target.min !== parameter.min || target.max !== parameter.max || target.quantization !== parameter.quantization) { dispositions.push({ path: parameter.path, disposition: "skipped-rebound", reason: "target bounds or quantization differ from the snapshot", fileValue: parameter.value, targetValue: target.value }); continue; }
    if (!target.automatable || !target.enabled || !target.deviceEnabled) { dispositions.push({ path: parameter.path, disposition: "skipped-read-only", reason: "parameter is disabled or not automatable on the target", fileValue: parameter.value, targetValue: target.value }); continue; }
    let proposed = parameter.value;
    if (morphFrom !== undefined) {
      let fromValue: number;
      if (morphFrom.kind === "live") fromValue = target.value;
      else {
        const sourceRow = morphFile!.parameters.find((candidate) => candidate.path === parameter.path);
        if (sourceRow === undefined) { dispositions.push({ path: parameter.path, disposition: "skipped-missing", reason: "the morph source snapshot has no parameter with this stable path", fileValue: parameter.value, targetValue: target.value }); continue; }
        fromValue = sourceRow.value;
      }
      proposed = morphValue(fromValue, parameter.value, amount as number, parameter.min, parameter.max, parameter.quantization);
    }
    dispositions.push({ path: parameter.path, disposition: "applicable", fileValue: parameter.value, proposedValue: proposed, targetValue: target.value, parameterRef: target.parameterRef, deviceRef: target.deviceRef });
  }
  const applicable = dispositions.filter((row) => row.disposition === "applicable").length;
  if (applicable === 0) throw report("device state recall has no applicable parameters on the target");
  return { deviceRef: targetDeviceRef, identity, layoutFingerprint: targetFingerprint, dispositions, applicable, skipped: dispositions.length - applicable };
}

interface DeviceStateStep {
  parameterRef: string;
  deviceRef: string;
  path: string;
  priorValue: number;
  priorRevision: number;
  authorityDigest: string;
  proposedValue: number;
  completed: boolean;
  result?: unknown;
}

export interface DeviceStateRecord {
  transactionId: string;
  epoch: number;
  expiresAt: number;
  state: "previewed" | "applying" | "applied" | "undoing" | "undone" | "uncertain";
  deviceRef: string;
  mode: "recall" | "morph";
  amount?: number;
  steps: DeviceStateStep[];
  undoSteps?: Array<{ completed: boolean }>;
  applyKey?: string;
  undoKey?: string;
  failedIndex?: number;
  failureReason?: string;
}

const DEVICE_STATE_CAPABILITIES = ["devices", "parameters", "device.parameter.write"];
const DEVICE_STATE_OPERATIONS = ["snapshot", "device.parameter.set"];

export class DeviceStateTransactionManager {
  private static readonly MAX_RECORDS = 64;
  private readonly records = new Map<string, DeviceStateRecord>();
  private readonly idempotency = new Map<string, { transactionId: string; result: unknown }>();
  constructor(private readonly adapter: LiveAdapter) {}

  private retain(record: DeviceStateRecord): void {
    const now = Date.now(); const protectedStates = new Set(["applying", "applied", "undoing", "uncertain"]);
    for (const [id, candidate] of this.records) if (candidate.expiresAt <= now && !protectedStates.has(candidate.state)) this.records.delete(id);
    for (const [key, candidate] of this.idempotency) if (!this.records.has(candidate.transactionId)) this.idempotency.delete(key);
    while (this.records.size >= DeviceStateTransactionManager.MAX_RECORDS) {
      const oldest = [...this.records].find(([, candidate]) => !protectedStates.has(candidate.state));
      if (!oldest) throw new Error("device state transaction capacity is exhausted by recovery-protected work");
      this.records.delete(oldest[0]);
    }
    this.records.set(record.transactionId, record);
  }

  private asyncAdapter(): AsyncLiveAdapter {
    const value = this.adapter as Partial<AsyncLiveAdapter>;
    if (typeof value.snapshotAsync !== "function" || typeof value.invokeAsync !== "function") throw new Error("live adapter does not support asynchronous operations");
    return this.adapter as AsyncLiveAdapter;
  }

  private require(): LiveStatus {
    const status = this.adapter.status();
    if (!status.connected || status.epoch === null) throw new Error("live-capability-unavailable:connection");
    for (const capability of DEVICE_STATE_CAPABILITIES) if (!status.capabilities.includes(capability as never)) throw new Error(`live-capability-unavailable:${capability}`);
    for (const operation of DEVICE_STATE_OPERATIONS) if (!status.operations?.includes(operation)) throw new Error(`live-operation-unavailable:${operation}`);
    return status;
  }

  /** Preview from a computed recall plan: captures exact prior values and
   *  hierarchy-authority digests for every applicable parameter. */
  async previewAsync(plan: DeviceStatePlan, mode: "recall" | "morph", amount?: number): Promise<unknown> {
    const status = this.require();
    const snapshot = await this.asyncAdapter().snapshotAsync();
    const steps: DeviceStateStep[] = plan.dispositions.filter((row) => row.disposition === "applicable").map((row) => {
      const target = parameterTarget(snapshot, row.deviceRef as string, row.parameterRef as string);
      const authority = parameterAuthority(snapshot, row.parameterRef as string);
      if (typeof target.parameter.value !== "number" || !Number.isFinite(target.parameter.value)) throw new Error(`device state parameter ${row.path} has no authoritative numeric value`);
      return { parameterRef: row.parameterRef as string, deviceRef: row.deviceRef as string, path: row.path, priorValue: target.parameter.value, priorRevision: parameterRevision(target.parameter), authorityDigest: fingerprint(authority), proposedValue: row.proposedValue as number, completed: false };
    });
    const record: DeviceStateRecord = { transactionId: `devstate_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, expiresAt: Date.now() + DEVICE_STATE_TRANSACTION_TTL_MS, state: "previewed", deviceRef: plan.deviceRef, mode, ...(amount === undefined ? {} : { amount }), steps };
    this.retain(record);
    return { transactionId: record.transactionId, epoch: record.epoch, expiresAt: record.expiresAt };
  }

  private stepArgs(snapshot: LiveSnapshot, step: DeviceStateStep, value: number, expectedRevision: number): Row {
    const authority = parameterAuthority(snapshot, step.parameterRef);
    return { ref: step.parameterRef, value, expectedRevision, expectedObjectIdentity: authority.parameterIdentity, expectedOwnerRef: authority.ownerRef, expectedOwnerIdentity: authority.ownerIdentity, expectedTrackRef: authority.trackRef, expectedTrackIdentity: authority.trackIdentity, expectedSiblings: clone(authority.siblings) };
  }

  private stepPostconditionPresent(snapshot: LiveSnapshot, step: DeviceStateStep): boolean {
    try {
      const target = parameterTarget(snapshot, step.deviceRef, step.parameterRef);
      return target.parameter.value === step.proposedValue && parameterRevision(target.parameter) > step.priorRevision;
    } catch { return false; }
  }

  private async revertAsync(adapter: AsyncLiveAdapter, context: LiveOperationContext | undefined, record: DeviceStateRecord, mode: "rollback" | "undo"): Promise<number> {
    record.undoSteps ??= record.steps.map(() => ({ completed: false }));
    let reverted = 0;
    for (let index = record.steps.length - 1; index >= 0; index -= 1) {
      const step = record.steps[index]!;
      if (mode === "rollback" && !step.completed) continue;
      if (record.undoSteps[index]?.completed) continue;
      const snapshot = await adapter.snapshotAsync(context);
      const target = parameterTarget(snapshot, step.deviceRef, step.parameterRef);
      const authority = parameterAuthority(snapshot, step.parameterRef);
      if (target.parameter.value !== step.proposedValue || fingerprint(authority) !== step.authorityDigest) throw new Error(`device state ${mode} step ${index} (${step.path}) parameter value or identity changed after apply`);
      await adapter.invokeAsync({ operation: "device.parameter.set", args: this.stepArgs(snapshot, step, step.priorValue, parameterRevision(target.parameter)) }, context);
      const verified = parameterTarget(await adapter.snapshotAsync(context), step.deviceRef, step.parameterRef);
      if (verified.parameter.value !== step.priorValue) throw new Error(`device state ${mode} step ${index} (${step.path}) prior-value restoration was not confirmed`);
      record.undoSteps[index] = { completed: true };
      reverted += 1;
    }
    return reverted;
  }

  async applyAsync(transactionId: string, confirmation: unknown, idempotencyKey: string, context?: LiveOperationContext): Promise<unknown> {
    if (confirmation !== "apply") throw new Error("confirmation=apply is required");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) { if (existing.transactionId !== transactionId) throw new Error("idempotency key conflicts with another transaction"); return { ...clone(existing.result as object), idempotent: true }; }
    const record = this.records.get(transactionId);
    if (!record || (record.state === "previewed" && record.expiresAt <= Date.now())) throw new Error("device state preview expired; preview again");
    const reconciliation = record.state === "uncertain" && record.applyKey === idempotencyKey;
    if (record.state === "uncertain" && !reconciliation) throw new Error("device state is uncertain; reconcile with the exact original idempotency key");
    if (record.state !== "previewed" && !reconciliation) throw new Error("device state transaction is no longer applicable");
    const adapter = this.asyncAdapter();
    if (reconciliation) await adapter.snapshotAsync(context);
    const status = this.require();
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; preview again");
    record.state = "applying"; record.applyKey = idempotencyKey;
    const results: unknown[] = record.steps.map((step, index) => step.completed && isObject(step.result) ? clone(step.result) : { index, path: step.path, replayed: step.completed });
    try {
      for (let index = 0; index < record.steps.length; index += 1) {
        const step = record.steps[index]!;
        if (step.completed) continue;
        const snapshot = await adapter.snapshotAsync(context);
        if (reconciliation && this.stepPostconditionPresent(snapshot, step)) {
          const replayed = { index, path: step.path, replayed: true, note: "the exact step postcondition was already present at reconciliation; the recorded checkpoint was completed without re-dispatch" };
          step.completed = true; step.result = replayed; results[index] = replayed;
          continue;
        }
        const target = parameterTarget(snapshot, step.deviceRef, step.parameterRef);
        const authority = parameterAuthority(snapshot, step.parameterRef);
        if (target.parameter.value !== step.priorValue || parameterRevision(target.parameter) !== step.priorRevision || fingerprint(authority) !== step.authorityDigest) throw new Error(`device state step ${index} (${step.path}) parameter identity, value, or revision changed since preview`);
        await adapter.invokeAsync({ operation: "device.parameter.set", args: this.stepArgs(snapshot, step, step.proposedValue, step.priorRevision) }, context);
        const verified = parameterTarget(await adapter.snapshotAsync(context), step.deviceRef, step.parameterRef);
        if (verified.parameter.value !== step.proposedValue || parameterRevision(verified.parameter) <= step.priorRevision) throw new Error(`device state step ${index} (${step.path}) postcondition was not confirmed`);
        step.completed = true; step.result = { index, path: step.path, value: verified.parameter.value, revision: parameterRevision(verified.parameter) };
        results[index] = step.result;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/uncertain|disconnect|timeout|cancellation/i.test(message)) { record.state = "uncertain"; throw cause; }
      record.failedIndex = record.steps.findIndex((step) => !step.completed);
      record.failureReason = message.length > 160 ? `${message.slice(0, 157)}...` : message;
      try {
        const reverted = await this.revertAsync(adapter, context, record, "rollback");
        record.state = "undone";
        return { transactionId, state: "compensated", failedIndex: record.failedIndex, reason: record.failureReason, rolledBack: reverted, idempotent: false };
      } catch (compensationCause) {
        record.state = "uncertain";
        throw new Error(`device state recall failed at step ${record.failedIndex} and exact rollback failed; reconcile with the exact original idempotency key (${compensationCause instanceof Error ? compensationCause.message : String(compensationCause)})`);
      }
    }
    record.state = "applied";
    const result = { transactionId, state: "applied", mode: record.mode, ...(record.amount === undefined ? {} : { amount: record.amount }), deviceRef: record.deviceRef, applied: results, epoch: record.epoch, idempotent: false };
    this.idempotency.set(idempotencyKey, { transactionId, result: clone(result) });
    return result;
  }

  async undoAsync(transactionId: string, confirmation: unknown, idempotencyKey: string, context?: LiveOperationContext): Promise<unknown> {
    if (confirmation !== "undo") throw new Error("confirmation=undo is required");
    const record = this.records.get(transactionId);
    if (record?.state === "undone" && record.undoKey === idempotencyKey) return { transactionId, state: "undone", idempotent: true };
    if (!record) throw new Error("Only an applied or exact-key uncertain device-state transaction can be undone");
    const reconciliation = record.state === "uncertain" && record.undoKey === idempotencyKey;
    if (!reconciliation && record.state !== "applied") throw new Error("Only an applied or exact-key uncertain device-state transaction can be undone");
    const adapter = this.asyncAdapter(); const status = this.require();
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; undo refused");
    record.state = "undoing"; record.undoKey = idempotencyKey;
    try {
      const reverted = await this.revertAsync(adapter, context, record, "undo");
      record.state = "undone";
      return { transactionId, state: "undone", restored: reverted, idempotent: false };
    } catch (cause) { record.state = "uncertain"; throw cause; }
  }

  isFinalizable(transactionId: string): boolean { const record = this.records.get(transactionId); return !!record && ["uncertain", "applied", "undone"].includes(record.state); }

  finalize(transactionId: string): { transactionId: string; finalized: true; priorState: string } {
    const record = this.records.get(transactionId); if (!record || !["uncertain", "applied", "undone"].includes(record.state)) throw new Error("device state recovery record is not finalizable");
    const priorState = record.state; this.records.delete(transactionId); for (const [key, value] of this.idempotency) if (value.transactionId === transactionId) this.idempotency.delete(key);
    return { transactionId, finalized: true, priorState };
  }
}
