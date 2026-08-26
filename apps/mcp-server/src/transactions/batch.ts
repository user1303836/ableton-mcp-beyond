import { createHash, randomBytes } from "node:crypto";
import type { AsyncLiveAdapter, LiveAdapter, LiveOperationContext, LiveRef, LiveSnapshot, LiveStatus } from "../live.js";

/**
 * Compound batch transactions: one preview/apply/undo cycle over an ordered,
 * bounded list of composable operations drawn from an explicit allowlist.
 *
 * Semantics (issue #51):
 * - One read-only preview resolves every target, validates per-operation
 *   preconditions, refuses duplicate mutation targets, and captures the exact
 *   merged prior state used for rollback and undo.
 * - Apply executes operations in order with checkpoint fencing: each step
 *   revalidates its preview-time preconditions against fresh authoritative
 *   state immediately before dispatch, and every completed step is recorded
 *   so a lost acknowledgement reconciles instead of re-executing.
 * - A clean mid-batch refusal rolls every completed step back to its exact
 *   captured prior state and reports the failing operation index; if the
 *   rollback itself fails, the batch becomes uncertain and an exact-key retry
 *   resumes the recorded compensation checkpoints.
 * - One undo record covers the whole batch: `live_undo` restores the captured
 *   prior state in reverse order with the same fencing.
 */

export const BATCH_TRANSACTION_TTL_MS = 30_000;
export const MAX_BATCH_OPERATIONS = 32;

export const BATCH_OPERATION_KINDS = ["mixer.set", "device.parameter.set", "clip.set", "track.rename", "scene.rename", "track.create", "routing.arm"] as const;
export type BatchOperationKind = typeof BATCH_OPERATION_KINDS[number];

export type BatchOperation =
  | { kind: "mixer.set"; trackRef: string; volume?: number; pan?: number; mute?: boolean; solo?: boolean; cueVolume?: number; sends?: number[] }
  | { kind: "device.parameter.set"; deviceRef: string; parameterRef: string; value: number }
  | { kind: "clip.set"; clipRef: string; muted?: boolean; colorIndex?: number; looping?: boolean; loopStart?: number; loopEnd?: number }
  | { kind: "track.rename"; trackRef: string; name: string }
  | { kind: "scene.rename"; sceneRef: string; name: string }
  | { kind: "track.create"; name: string; trackKind: "audio" | "midi"; index?: number }
  | { kind: "routing.arm"; trackRef: string; armed: boolean };

/** Capabilities and registry operations each batch operation kind requires. */
export const BATCH_OPERATION_REQUIREMENTS: Record<BatchOperationKind, { capabilities: string[]; operations: string[] }> = {
  "mixer.set": { capabilities: ["mixing"], operations: ["snapshot", "mixer.set"] },
  "device.parameter.set": { capabilities: ["devices", "parameters", "device.parameter.write"], operations: ["snapshot", "device.parameter.set"] },
  "clip.set": { capabilities: ["clips"], operations: ["snapshot", "clip.set"] },
  "track.rename": { capabilities: ["tracks"], operations: ["snapshot", "track.rename"] },
  "scene.rename": { capabilities: ["scenes"], operations: ["snapshot", "scene.rename"] },
  // track.delete is required as well: rollback and undo of a created track are
  // exact identity-and-fingerprint-bound deletions of transaction-owned state.
  "track.create": { capabilities: ["session.structure"], operations: ["snapshot", "track.create", "track.delete"] },
  "routing.arm": { capabilities: ["routing"], operations: ["snapshot", "routing.set"] },
};

/** The individual mutation tool whose deployment policy governs each kind. */
export const BATCH_OPERATION_POLICY_TOOLS: Record<BatchOperationKind, string> = {
  "mixer.set": "live_mixer_apply",
  "device.parameter.set": "live_device_parameter_apply",
  "clip.set": "live_clip_properties_apply",
  "track.rename": "live_object_rename_apply",
  "scene.rename": "live_object_rename_apply",
  "track.create": "live_session_structure_apply",
  "routing.arm": "live_routing_apply",
};

export interface BatchOperationPlan {
  index: number;
  kind: BatchOperationKind;
  summary: string;
  target: Record<string, unknown>;
  prior: Record<string, unknown>;
  proposed: Record<string, unknown>;
}

interface BatchStep { completed: boolean; result?: unknown }

export interface BatchRecord {
  transactionId: string;
  epoch: number;
  expiresAt: number;
  state: "previewed" | "applying" | "applied" | "undoing" | "undone" | "uncertain";
  operations: BatchOperation[];
  plans: BatchOperationPlan[];
  requiredCapabilities: string[];
  requiredOperations: string[];
  steps: BatchStep[];
  undoSteps?: BatchStep[];
  created?: Array<{ stepIndex: number; ref: string; objectIdentity: string; fingerprint: string }>;
  recoveryMode?: "apply" | "compensate";
  applyKey?: string;
  undoKey?: string;
  failedIndex?: number;
  failureReason?: string;
}

type Row = Record<string, unknown>;

function isObject(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string { if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Row; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; }
function fingerprint(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function isNonEmptyString(value: unknown, maxLength: number): value is string { return typeof value === "string" && value.length >= 1 && value.length <= maxLength; }

function structureRevision(snapshot: LiveSnapshot): string {
  const identity = { tracks: snapshot.tracks.map((item, index) => [item.ref, item.objectIdentity, item.name, item.kind, index]), scenes: snapshot.scenes.map((item, index) => [item.ref, item.objectIdentity, item.name, index]) };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

const MIXER_STATE_FIELDS = ["volume", "pan", "mute", "solo", "cueVolume", "sends"] as const;

function mixerTarget(snapshot: LiveSnapshot, trackRef: string): { track: Row; mixer: Row } {
  const track = (snapshot.tracks as unknown as Row[]).find((item) => item.ref === trackRef);
  if (!track || !isObject(track.mixer) || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("transaction batch requires a track with an exact authoritative mixer identity");
  const mixer = track.mixer;
  const nullableIdentity = (value: unknown): boolean => value === null || isNonEmptyString(value, 256);
  if (!nullableIdentity(mixer.volumeIdentity) || !nullableIdentity(mixer.panIdentity) || !nullableIdentity(mixer.cueIdentity) || !Array.isArray(mixer.sendIdentities) || !mixer.sendIdentities.every((identity) => isNonEmptyString(identity, 256)) || !Array.isArray(mixer.sendRefs) || mixer.sendRefs.length !== mixer.sendIdentities.length) throw new Error("transaction batch mixer parameter identities are incomplete");
  return { track, mixer };
}

function mixerAuthority(target: { track: Row; mixer: Row }): Row {
  const state = Object.fromEntries(MIXER_STATE_FIELDS.map((field) => [field, clone(target.mixer[field] ?? null)]));
  return { expectedObjectIdentity: target.track.objectIdentity, expectedVolumeIdentity: target.mixer.volumeIdentity, expectedPanIdentity: target.mixer.panIdentity, expectedCueIdentity: target.mixer.cueIdentity, expectedSendIdentities: clone(target.mixer.sendIdentities), expectedStateRevision: fingerprint(state) };
}

function flattenDeviceRows(values: unknown): Row[] {
  const flattened: Row[] = [];
  const visit = (value: unknown): void => {
    if (!isObject(value) || flattened.length >= 512) return;
    flattened.push(value);
    if (Array.isArray(value.chains)) for (const chain of value.chains) if (isObject(chain) && Array.isArray(chain.devices)) for (const device of chain.devices) visit(device);
    if (Array.isArray(value.drumPads)) for (const pad of value.drumPads) if (isObject(pad) && Array.isArray(pad.chains)) for (const chain of pad.chains) if (isObject(chain) && Array.isArray(chain.devices)) for (const device of chain.devices) visit(device);
  };
  if (Array.isArray(values)) for (const value of values) visit(value);
  return flattened;
}

function parameterTarget(snapshot: LiveSnapshot, deviceRef: string, parameterRef: string): { device: Row; parameter: Row; track: Row } {
  for (const track of snapshot.tracks as unknown as Row[]) {
    const device = flattenDeviceRows(track.devices).find((item) => item.ref === deviceRef);
    const parameter = Array.isArray(device?.parameters) ? (device!.parameters as unknown[]).filter(isObject).find((item) => item.ref === parameterRef) : undefined;
    if (device && parameter) return { device, parameter, track };
  }
  throw new Error("transaction batch device and parameter references are not authoritative children");
}

function parameterRevision(parameter: Row): number { return typeof parameter.revision === "number" ? parameter.revision : 1; }

function parameterAuthority(snapshot: LiveSnapshot, parameterRef: string): Row {
  for (const track of snapshot.tracks as unknown as Row[]) {
    const trackRef = typeof track.ref === "string" ? track.ref : undefined;
    const trackIdentity = typeof track.objectIdentity === "string" ? track.objectIdentity : undefined;
    const visit = (candidate: unknown): Row | undefined => {
      if (!Array.isArray(candidate) || candidate.length > 256 || !candidate.every(isObject)) return undefined;
      for (const device of candidate as Row[]) {
        const deviceRef = typeof device.ref === "string" ? device.ref : undefined;
        const deviceIdentity = typeof device.objectIdentity === "string" ? device.objectIdentity : undefined;
        const parameters = (Array.isArray(device.parameters) ? device.parameters : []) as unknown[];
        const macros = (Array.isArray(device.macros) ? device.macros : []) as unknown[];
        const rows = [...parameters, ...macros].filter(isObject);
        const siblings = rows.map((row) => typeof row.ref === "string" && typeof row.objectIdentity === "string" ? { ref: row.ref, objectIdentity: row.objectIdentity } : undefined);
        if (trackRef && trackIdentity && deviceRef && deviceIdentity && siblings.every((row) => row !== undefined)) {
          const found = rows.find((row) => row.ref === parameterRef);
          if (found && typeof found.objectIdentity === "string") return { ref: parameterRef, parameterIdentity: found.objectIdentity, ownerRef: deviceRef, ownerIdentity: deviceIdentity, trackRef, trackIdentity, siblings };
        }
        if (Array.isArray(device.chains)) for (const chain of device.chains) if (isObject(chain)) { const found = visit(chain.devices); if (found) return found; }
        if (Array.isArray(device.drumPads)) for (const pad of device.drumPads) if (isObject(pad) && Array.isArray(pad.chains)) for (const chain of pad.chains) if (isObject(chain)) { const found = visit(chain.devices); if (found) return found; }
      }
      return undefined;
    };
    const found = visit(track.devices ?? []);
    if (found) return found;
  }
  throw new Error("transaction batch parameter lacks exact hierarchy authority");
}

function clipRow(snapshot: LiveSnapshot, clipRef: string): { track?: Row; clip: Row; arrangement: boolean; takeLane?: Row } {
  for (const track of snapshot.tracks as unknown as Row[]) {
    const clip = ((track.clips as unknown[]) ?? []).filter(isObject).find((item) => item.ref === clipRef);
    if (clip) return { track, clip, arrangement: false };
    for (const lane of ((track.takeLanes as unknown[]) ?? []).filter(isObject)) {
      const laneClip = ((lane.clips as unknown[]) ?? []).filter(isObject).find((item) => item.ref === clipRef);
      if (laneClip) return { track, clip: laneClip, arrangement: true, takeLane: lane };
    }
  }
  const arrangementClips = (snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? [];
  const arrangement = arrangementClips.filter(isObject).find((item) => item.ref === clipRef);
  if (arrangement) { const track = (snapshot.tracks as unknown as Row[]).find((item) => item.ref === arrangement.trackRef); return { ...(track ? { track } : {}), clip: arrangement, arrangement: true }; }
  throw new Error("transaction batch clip reference is not authoritative");
}

function clipAuthority(snapshot: LiveSnapshot, clipRef: string): Row {
  const located = clipRow(snapshot, clipRef);
  if (!isNonEmptyString(located.clip.objectIdentity, 256)) throw new Error("transaction batch clip lacks exact object identity");
  if (located.arrangement) {
    if (!located.track || !isNonEmptyString(located.track.ref, 256) || !isNonEmptyString(located.track.objectIdentity, 256)) throw new Error("transaction batch Arrangement clip hierarchy authority is incomplete");
    const siblings = ((snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? []).filter(isObject).filter((item) => item.trackRef === located.track!.ref).map((item) => ({ ref: item.ref, objectIdentity: item.objectIdentity }));
    return { expectedObjectIdentity: located.clip.objectIdentity, expectedAuthorityRevision: fingerprint({ clip: { ref: clipRef, objectIdentity: located.clip.objectIdentity }, owner: { ref: located.track.ref, objectIdentity: located.track.objectIdentity }, siblings }) };
  }
  const track = located.track!;
  if (!isNonEmptyString(track.ref, 256) || !isNonEmptyString(track.objectIdentity, 256) || !Array.isArray(track.clipSlots)) throw new Error("transaction batch clip track authority is incomplete");
  const slot = (track.clipSlots as unknown[]).filter(isObject).find((candidate) => candidate.clipRef === clipRef);
  const scene = slot && (snapshot.scenes as unknown as Row[]).find((candidate) => candidate.index === slot.sceneIndex);
  if (!slot || !scene || !isNonEmptyString(slot.ref, 256) || !isNonEmptyString(slot.objectIdentity, 256) || !isNonEmptyString(scene.ref, 256) || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("transaction batch clip slot or scene authority is incomplete");
  return { expectedObjectIdentity: located.clip.objectIdentity, expectedTrackRef: track.ref, expectedTrackIdentity: track.objectIdentity, expectedSlotRef: slot.ref, expectedSlotIdentity: slot.objectIdentity, expectedSceneRef: scene.ref, expectedSceneIdentity: scene.objectIdentity };
}

const CLIP_STATE_FIELDS = ["muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove"] as const;

function clipPropertiesMutationAuthority(snapshot: LiveSnapshot, clipRef: string): Row {
  const located = clipRow(snapshot, clipRef);
  const state = Object.fromEntries(CLIP_STATE_FIELDS.map((field) => [field, located.clip[field] ?? null]));
  const authority = clipAuthority(snapshot, clipRef);
  const expectedAuthorityRevision = located.arrangement ? authority.expectedAuthorityRevision as string : fingerprint(authority);
  return { expectedObjectIdentity: authority.expectedObjectIdentity, expectedAuthorityRevision, expectedStateRevision: fingerprint(state) };
}

function trackCreatedFingerprint(snapshot: LiveSnapshot, reference: string): string {
  const track = snapshot.tracks.find((row) => row.ref === reference);
  if (!track) throw new Error("transaction batch created-track fingerprint is unavailable");
  const ownedTrack = { ...track, clipSlots: (track.clipSlots ?? []).filter((slot) => slot.empty !== true || slot.clipRef != null) } as unknown as Row;
  const arrangementClips = (snapshot.arrangement.clips ?? []).filter((clip) => clip.trackRef === reference || clip.parentRef === reference);
  return fingerprint({ track: ownedTrack, arrangementClips });
}

function routingStateRevision(track: Row): string {
  if (!isObject(track.routing)) throw new Error("transaction batch routing state is unavailable");
  return fingerprint({ inputType: track.routing.inputType ?? null, inputSubRouting: track.routing.inputSubRouting ?? null, outputType: track.routing.outputType ?? null, outputSubRouting: track.routing.outputSubRouting ?? null, arm: track.armed ?? null, monitoring: track.monitoringState ?? null });
}

function routingTarget(snapshot: LiveSnapshot, trackRef: string): Row {
  const track = (snapshot.tracks as unknown as Row[]).find((item) => item.ref === trackRef);
  if (!track || !isObject(track.routing) || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("transaction batch requires a track with exact authoritative routing identity");
  return track;
}

function validateBatchOperation(value: unknown, index: number): BatchOperation {
  if (!isObject(value) || typeof value.kind !== "string" || !(BATCH_OPERATION_KINDS as readonly string[]).includes(value.kind)) throw new Error(`transaction batch operation ${index} kind is not in the composable allowlist`);
  const keys = (allowed: string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
  switch (value.kind as BatchOperationKind) {
    case "mixer.set": {
      if (!keys(["kind", "trackRef", "volume", "pan", "mute", "solo", "cueVolume", "sends"]) || !isNonEmptyString(value.trackRef, 256)) throw new Error(`transaction batch operation ${index} requires an exact trackRef`);
      const proposed: Record<string, unknown> = {};
      for (const field of ["volume", "pan", "mute", "solo", "cueVolume", "sends"] as const) {
        const fieldValue = value[field];
        if (fieldValue === undefined) continue;
        if (field === "mute" || field === "solo") { if (typeof fieldValue !== "boolean") throw new Error(`transaction batch operation ${index} ${field} must be boolean`); }
        else if (field === "sends") { if (!Array.isArray(fieldValue) || fieldValue.length > 64 || !fieldValue.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1)) throw new Error(`transaction batch operation ${index} sends must be 0-1 values`); }
        else if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || (field === "pan" ? Math.abs(fieldValue) > 1 : (fieldValue < 0 || fieldValue > 1))) throw new Error(`transaction batch operation ${index} ${field} is out of bounds`);
        proposed[field] = fieldValue;
      }
      if (Object.keys(proposed).length === 0) throw new Error(`transaction batch operation ${index} requires at least one mixer field`);
      return { kind: "mixer.set", trackRef: value.trackRef, ...proposed } as BatchOperation;
    }
    case "device.parameter.set": {
      if (!keys(["kind", "deviceRef", "parameterRef", "value"]) || !isNonEmptyString(value.deviceRef, 256) || !isNonEmptyString(value.parameterRef, 256) || typeof value.value !== "number" || !Number.isFinite(value.value)) throw new Error(`transaction batch operation ${index} requires deviceRef, parameterRef, and a finite value`);
      return { kind: "device.parameter.set", deviceRef: value.deviceRef, parameterRef: value.parameterRef, value: value.value };
    }
    case "clip.set": {
      if (!keys(["kind", "clipRef", "muted", "colorIndex", "looping", "loopStart", "loopEnd"]) || !isNonEmptyString(value.clipRef, 256)) throw new Error(`transaction batch operation ${index} requires an exact clipRef`);
      if (value.muted !== undefined && typeof value.muted !== "boolean") throw new Error(`transaction batch operation ${index} muted must be boolean`);
      if (value.looping !== undefined && typeof value.looping !== "boolean") throw new Error(`transaction batch operation ${index} looping must be boolean`);
      if (value.colorIndex !== undefined && (!Number.isInteger(value.colorIndex) || (value.colorIndex as number) < 0 || (value.colorIndex as number) > 69)) throw new Error(`transaction batch operation ${index} colorIndex is out of bounds`);
      for (const field of ["loopStart", "loopEnd"] as const) if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field] as number) || (value[field] as number) < 0 || (value[field] as number) > 1_000_000_000)) throw new Error(`transaction batch operation ${index} ${field} is out of bounds`);
      const proposed: Record<string, unknown> = {};
      for (const field of ["muted", "colorIndex", "looping", "loopStart", "loopEnd"] as const) if (value[field] !== undefined) proposed[field] = value[field];
      if (Object.keys(proposed).length === 0) throw new Error(`transaction batch operation ${index} requires at least one clip field`);
      return { kind: "clip.set", clipRef: value.clipRef, ...proposed } as BatchOperation;
    }
    case "track.rename": {
      if (!keys(["kind", "trackRef", "name"]) || !isNonEmptyString(value.trackRef, 256) || !isNonEmptyString(value.name, 256)) throw new Error(`transaction batch operation ${index} requires trackRef and a non-empty name`);
      return { kind: "track.rename", trackRef: value.trackRef, name: value.name };
    }
    case "scene.rename": {
      if (!keys(["kind", "sceneRef", "name"]) || !isNonEmptyString(value.sceneRef, 256) || !isNonEmptyString(value.name, 256)) throw new Error(`transaction batch operation ${index} requires sceneRef and a non-empty name`);
      return { kind: "scene.rename", sceneRef: value.sceneRef, name: value.name };
    }
    case "track.create": {
      if (!keys(["kind", "name", "trackKind", "index"]) || !isNonEmptyString(value.name, 128) || (value.trackKind !== "audio" && value.trackKind !== "midi") || (value.index !== undefined && (!Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 10_000))) throw new Error(`transaction batch operation ${index} requires a name, trackKind audio|midi, and an optional bounded index`);
      return { kind: "track.create", name: value.name, trackKind: value.trackKind, ...(value.index === undefined ? {} : { index: value.index as number }) };
    }
    case "routing.arm": {
      if (!keys(["kind", "trackRef", "armed"]) || !isNonEmptyString(value.trackRef, 256) || typeof value.armed !== "boolean") throw new Error(`transaction batch operation ${index} requires trackRef and a boolean armed`);
      return { kind: "routing.arm", trackRef: value.trackRef, armed: value.armed };
    }
  }
}

/** The mutation-target deduplication key: one operation per exact target per batch. */
function batchTargetKey(operation: BatchOperation): string | undefined {
  switch (operation.kind) {
    case "mixer.set": return `mixer:${operation.trackRef}`;
    case "device.parameter.set": return `parameter:${operation.parameterRef}`;
    case "clip.set": return `clip:${operation.clipRef}`;
    case "track.rename": return `rename:${operation.trackRef}`;
    case "scene.rename": return `rename:${operation.sceneRef}`;
    case "track.create": return undefined;
    case "routing.arm": return `routing:${operation.trackRef}`;
  }
}

export class BatchTransactionManager {
  private static readonly MAX_RECORDS = 64;
  private readonly records = new Map<string, BatchRecord>();
  private readonly idempotency = new Map<string, { transactionId: string; result: unknown }>();
  constructor(private readonly adapter: LiveAdapter) {}

  private retain(record: BatchRecord): void {
    const now = Date.now(); const protectedStates = new Set(["applying", "applied", "undoing", "uncertain"]);
    for (const [id, candidate] of this.records) if (candidate.expiresAt <= now && !protectedStates.has(candidate.state)) this.records.delete(id);
    for (const [key, candidate] of this.idempotency) if (!this.records.has(candidate.transactionId)) this.idempotency.delete(key);
    while (this.records.size >= BatchTransactionManager.MAX_RECORDS) {
      const oldest = [...this.records].find(([, candidate]) => !protectedStates.has(candidate.state));
      if (!oldest) throw new Error("transaction batch capacity is exhausted by recovery-protected work");
      this.records.delete(oldest[0]);
    }
    this.records.set(record.transactionId, record);
  }

  private asyncAdapter(): AsyncLiveAdapter {
    const value = this.adapter as Partial<AsyncLiveAdapter>;
    if (typeof value.snapshotAsync !== "function" || typeof value.getAsync !== "function" || typeof value.invokeAsync !== "function") throw new Error("live adapter does not support asynchronous operations");
    return this.adapter as AsyncLiveAdapter;
  }

  private require(capabilities: string[], operations: string[]): LiveStatus {
    const status = this.adapter.status();
    if (!status.connected || status.epoch === null) throw new Error("live-capability-unavailable:connection");
    for (const capability of capabilities) if (!status.capabilities.includes(capability as never)) throw new Error(`live-capability-unavailable:${capability}`);
    for (const operation of operations) if (!status.operations?.includes(operation)) throw new Error(`live-operation-unavailable:${operation}`);
    return status;
  }

  /** Resolve one operation against a fresh snapshot into its exact plan (or revalidate
   *  a preview-time plan against that state when `prior` is supplied). */
  private planOperation(snapshot: LiveSnapshot, operation: BatchOperation, index: number): BatchOperationPlan {
    switch (operation.kind) {
      case "mixer.set": {
        const target = mixerTarget(snapshot, operation.trackRef);
        const proposed = Object.fromEntries(MIXER_STATE_FIELDS.filter((field) => operation[field] !== undefined).map((field) => [field, clone(operation[field])]));
        if (Array.isArray(proposed.sends) && (proposed.sends as unknown[]).length > (target.mixer.sends as unknown[]).length) throw new Error(`transaction batch operation ${index} proposes more sends than the track exposes`);
        if (proposed.cueVolume !== undefined && target.mixer.cueRef === null) throw new Error(`transaction batch operation ${index} cue volume is unavailable on this track`);
        if (proposed.volume !== undefined && target.mixer.volumeRef === null) throw new Error(`transaction batch operation ${index} volume is unavailable on this track`);
        if (proposed.pan !== undefined && target.mixer.panRef === null) throw new Error(`transaction batch operation ${index} pan is unavailable on this track`);
        const prior = Object.fromEntries(Object.keys(proposed).map((field) => [field, clone(target.mixer[field] ?? null)]));
        return { index, kind: operation.kind, summary: `set mixer ${Object.keys(proposed).join(", ")} on ${operation.trackRef}`, target: { trackRef: operation.trackRef, trackIdentity: target.track.objectIdentity, name: target.track.name }, prior: { ...prior, stateRevision: fingerprint(Object.fromEntries(MIXER_STATE_FIELDS.map((field) => [field, clone(target.mixer[field] ?? null)]))) }, proposed };
      }
      case "device.parameter.set": {
        const target = parameterTarget(snapshot, operation.deviceRef, operation.parameterRef);
        if ((target.device.enabled as boolean | undefined) === false || (target.parameter.enabled as boolean | undefined) === false || target.parameter.automatable !== true) throw new Error(`transaction batch operation ${index} parameter is disabled or not supported for guarded adjustment`);
        const quantization = typeof target.parameter.quantization === "number" ? target.parameter.quantization : 0;
        if (typeof target.parameter.min !== "number" || typeof target.parameter.max !== "number" || operation.value < target.parameter.min || operation.value > target.parameter.max) throw new Error(`transaction batch operation ${index} value is outside authoritative bounds`);
        if (quantization > 0 && Math.abs((operation.value - (target.parameter.min as number)) / quantization - Math.round((operation.value - (target.parameter.min as number)) / quantization)) > 1e-9) throw new Error(`transaction batch operation ${index} value does not match authoritative quantization`);
        if (typeof target.parameter.value !== "number" || !Number.isFinite(target.parameter.value)) throw new Error(`transaction batch operation ${index} parameter value is unavailable`);
        const authority = parameterAuthority(snapshot, operation.parameterRef);
        return { index, kind: operation.kind, summary: `set ${operation.parameterRef} to ${operation.value}`, target: { deviceRef: operation.deviceRef, parameterRef: operation.parameterRef, name: target.parameter.name, trackRef: target.track.ref }, prior: { value: target.parameter.value, revision: parameterRevision(target.parameter), authorityDigest: fingerprint(authority) }, proposed: { value: operation.value } };
      }
      case "clip.set": {
        const located = clipRow(snapshot, operation.clipRef);
        const fields = (["muted", "colorIndex", "looping", "loopStart", "loopEnd"] as const).filter((field) => operation[field] !== undefined);
        if (fields.some((field) => operation[field] !== undefined && (located.clip[field] === null || located.clip[field] === undefined))) throw new Error(`transaction batch operation ${index} field is unavailable on this exact clip`);
        if (located.clip.isAudio === true && fields.some((field) => field === "looping" || field === "loopStart" || field === "loopEnd")) throw new Error(`transaction batch operation ${index} audio clip loop editing uses live_audio_clip_preview`);
        if (operation.loopStart !== undefined && operation.loopEnd !== undefined && (operation.loopEnd as number) < (operation.loopStart as number)) throw new Error(`transaction batch operation ${index} loopEnd precedes loopStart`);
        const proposed = Object.fromEntries(fields.map((field) => [field, clone(operation[field])]));
        const prior = Object.fromEntries(fields.map((field) => [field, clone(located.clip[field] ?? null)]));
        return { index, kind: operation.kind, summary: `set clip ${fields.join(", ")} on ${operation.clipRef}`, target: { clipRef: operation.clipRef, clipIdentity: located.clip.objectIdentity, name: located.clip.name, arrangement: located.arrangement }, prior: { ...prior, stateRevision: fingerprint(Object.fromEntries(CLIP_STATE_FIELDS.map((field) => [field, located.clip[field] ?? null]))) }, proposed };
      }
      case "track.rename": {
        const track = (snapshot.tracks as unknown as Row[]).find((item) => item.ref === operation.trackRef);
        if (!track || !isNonEmptyString(track.objectIdentity, 256) || typeof track.name !== "string") throw new Error(`transaction batch operation ${index} track rename target lacks exact authoritative identity`);
        if (track.name === operation.name) throw new Error(`transaction batch operation ${index} rename would not change the target`);
        return { index, kind: operation.kind, summary: `rename track ${operation.trackRef} to ${operation.name}`, target: { trackRef: operation.trackRef, trackIdentity: track.objectIdentity }, prior: { name: track.name }, proposed: { name: operation.name } };
      }
      case "scene.rename": {
        const scene = (snapshot.scenes as unknown as Row[]).find((item) => item.ref === operation.sceneRef);
        if (!scene || !isNonEmptyString(scene.objectIdentity, 256) || typeof scene.name !== "string") throw new Error(`transaction batch operation ${index} scene rename target lacks exact authoritative identity`);
        if (scene.name === operation.name) throw new Error(`transaction batch operation ${index} rename would not change the target`);
        return { index, kind: operation.kind, summary: `rename scene ${operation.sceneRef} to ${operation.name}`, target: { sceneRef: operation.sceneRef, sceneIdentity: scene.objectIdentity, index: scene.index }, prior: { name: scene.name }, proposed: { name: operation.name } };
      }
      case "track.create": {
        const existingNames = new Set([...snapshot.tracks.map((item) => item.name), ...snapshot.scenes.map((item) => item.name)]);
        if (existingNames.has(operation.name)) throw new Error(`transaction batch operation ${index} track name already exists in the Set`);
        const regularTracks = snapshot.tracks.filter((item) => !["return", "main", "master"].includes(item.kind));
        if (operation.index !== undefined && operation.index > regularTracks.length) throw new Error(`transaction batch operation ${index} track index exceeds the current regular-track collection`);
        return { index, kind: operation.kind, summary: `create ${operation.trackKind} track ${operation.name}`, target: { name: operation.name, trackKind: operation.trackKind, ...(operation.index === undefined ? {} : { index: operation.index }) }, prior: { existed: false, structureRevision: structureRevision(snapshot) }, proposed: { name: operation.name, trackKind: operation.trackKind } };
      }
      case "routing.arm": {
        const track = routingTarget(snapshot, operation.trackRef);
        if (typeof track.armed !== "boolean") throw new Error(`transaction batch operation ${index} arm is unavailable on this exact track`);
        return { index, kind: operation.kind, summary: `${operation.armed ? "arm" : "disarm"} track ${operation.trackRef}`, target: { trackRef: operation.trackRef, trackIdentity: track.objectIdentity, name: track.name }, prior: { armed: track.armed, stateRevision: routingStateRevision(track) }, proposed: { armed: operation.armed } };
      }
    }
  }

  async previewAsync(request: unknown): Promise<unknown> {
    if (!isObject(request) || !Array.isArray(request.operations) || request.operations.length < 1 || request.operations.length > MAX_BATCH_OPERATIONS || Object.keys(request).some((key) => key !== "operations")) throw new Error(`transaction batch requires 1-${MAX_BATCH_OPERATIONS} operations`);
    const operations = request.operations.map((operation, index) => validateBatchOperation(operation, index));
    const targetKeys = new Set<string>();
    for (const operation of operations) {
      const key = batchTargetKey(operation);
      if (key !== undefined) { if (targetKeys.has(key)) throw new Error(`transaction batch mutates the same exact target twice (${key}); split it into sequential batches`); targetKeys.add(key); }
    }
    const createNames = operations.filter((operation) => operation.kind === "track.create").map((operation) => (operation as { name: string }).name);
    if (new Set(createNames).size !== createNames.length) throw new Error("transaction batch creates the same track name twice");
    const requiredCapabilities = [...new Set(operations.flatMap((operation) => BATCH_OPERATION_REQUIREMENTS[operation.kind].capabilities))];
    const requiredOperations = [...new Set(operations.flatMap((operation) => BATCH_OPERATION_REQUIREMENTS[operation.kind].operations))];
    const status = this.require(requiredCapabilities, requiredOperations);
    const adapter = this.asyncAdapter();
    const snapshot = await adapter.snapshotAsync();
    const plans = operations.map((operation, index) => this.planOperation(snapshot, operation, index));
    const record: BatchRecord = { transactionId: `batch_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, expiresAt: Date.now() + BATCH_TRANSACTION_TTL_MS, state: "previewed", operations: clone(operations), plans, requiredCapabilities, requiredOperations, steps: plans.map(() => ({ completed: false })) };
    this.retain(record);
    return clone({ transactionId: record.transactionId, epoch: record.epoch, operations: plans, summary: { operationCount: plans.length, kinds: [...new Set(operations.map((operation) => operation.kind))], targets: plans.map((plan) => plan.summary) }, impact: "applies-atomic-batch", confirmation: "apply", expiresAt: record.expiresAt });
  }

  /** Build the exact dispatch arguments for one step against fresh state. */
  private stepArgs(snapshot: LiveSnapshot, record: BatchRecord, index: number): { operation: "mixer.set" | "device.parameter.set" | "clip.set" | "track.rename" | "scene.rename" | "track.create" | "routing.set"; args: Row } {
    const operation = record.operations[index]!;
    const plan = record.plans[index]!;
    switch (operation.kind) {
      case "mixer.set": {
        const target = mixerTarget(snapshot, operation.trackRef);
        const currentState = Object.fromEntries(MIXER_STATE_FIELDS.map((field) => [field, clone(target.mixer[field] ?? null)]));
        if (target.track.objectIdentity !== plan.target.trackIdentity || fingerprint(currentState) !== plan.prior.stateRevision) throw new Error(`transaction batch step ${index} mixer target or state changed since preview`);
        return { operation: "mixer.set", args: { ref: operation.trackRef, ...plan.proposed, ...mixerAuthority(target) } };
      }
      case "device.parameter.set": {
        const target = parameterTarget(snapshot, operation.deviceRef, operation.parameterRef);
        const authority = parameterAuthority(snapshot, operation.parameterRef);
        if (target.parameter.value !== plan.prior.value || parameterRevision(target.parameter) !== plan.prior.revision || fingerprint(authority) !== plan.prior.authorityDigest) throw new Error(`transaction batch step ${index} parameter identity, value, or revision changed since preview`);
        return { operation: "device.parameter.set", args: { ref: operation.parameterRef, value: operation.value, expectedRevision: parameterRevision(target.parameter), expectedObjectIdentity: authority.parameterIdentity, expectedOwnerRef: authority.ownerRef, expectedOwnerIdentity: authority.ownerIdentity, expectedTrackRef: authority.trackRef, expectedTrackIdentity: authority.trackIdentity, expectedSiblings: clone(authority.siblings) } };
      }
      case "clip.set": {
        const located = clipRow(snapshot, operation.clipRef);
        const currentState = Object.fromEntries(CLIP_STATE_FIELDS.map((field) => [field, located.clip[field] ?? null]));
        if (located.clip.objectIdentity !== plan.target.clipIdentity || fingerprint(currentState) !== plan.prior.stateRevision) throw new Error(`transaction batch step ${index} clip identity or state changed since preview`);
        return { operation: "clip.set", args: { ref: operation.clipRef, ...plan.proposed, ...clipPropertiesMutationAuthority(snapshot, operation.clipRef) } };
      }
      case "track.rename": {
        const track = (snapshot.tracks as unknown as Row[]).find((item) => item.ref === operation.trackRef);
        if (!track || track.objectIdentity !== plan.target.trackIdentity || track.name !== plan.prior.name) throw new Error(`transaction batch step ${index} track identity or name changed since preview`);
        return { operation: "track.rename", args: { ref: operation.trackRef, name: operation.name, expectedName: plan.prior.name, expectedObjectIdentity: plan.target.trackIdentity, expectedAuthorityRevision: structureRevision(snapshot) } };
      }
      case "scene.rename": {
        const scene = (snapshot.scenes as unknown as Row[]).find((item) => item.ref === operation.sceneRef);
        if (!scene || scene.objectIdentity !== plan.target.sceneIdentity || scene.name !== plan.prior.name) throw new Error(`transaction batch step ${index} scene identity or name changed since preview`);
        return { operation: "scene.rename", args: { ref: operation.sceneRef, name: operation.name, expectedName: plan.prior.name, expectedObjectIdentity: plan.target.sceneIdentity, expectedAuthorityRevision: structureRevision(snapshot) } };
      }
      case "track.create": {
        const existingNames = new Set([...snapshot.tracks.map((item) => item.name), ...snapshot.scenes.map((item) => item.name)]);
        if (existingNames.has(operation.name)) throw new Error(`transaction batch step ${index} track name already exists`);
        return { operation: "track.create", args: { name: operation.name, kind: operation.trackKind, ...(operation.index === undefined ? {} : { index: operation.index }), expectedStructureRevision: structureRevision(snapshot) } };
      }
      case "routing.arm": {
        const track = routingTarget(snapshot, operation.trackRef);
        if (track.objectIdentity !== plan.target.trackIdentity || routingStateRevision(track) !== plan.prior.stateRevision || track.armed !== plan.prior.armed) throw new Error(`transaction batch step ${index} routing target or state changed since preview`);
        return { operation: "routing.set", args: { ref: operation.trackRef, arm: operation.armed, expectedObjectIdentity: track.objectIdentity, expectedStateRevision: routingStateRevision(track) } };
      }
    }
  }

  /** Read-only exact postcondition check used during lost-acknowledgement
   *  reconciliation: when the step's verified postcondition already holds in
   *  fresh authoritative state, the earlier dispatch provably landed and the
   *  checkpoint is completed without re-dispatching. Returns false when the
   *  postcondition is absent (the step is then revalidated and dispatched) or
   *  unprovable (track.create, where ownership identity was never recorded). */
  private stepPostconditionPresent(snapshot: LiveSnapshot, record: BatchRecord, index: number): boolean {
    const operation = record.operations[index]!;
    const plan = record.plans[index]!;
    try {
      switch (operation.kind) {
        case "mixer.set": {
          const target = mixerTarget(snapshot, operation.trackRef);
          if (target.track.objectIdentity !== plan.target.trackIdentity) return false;
          return Object.entries(plan.proposed).every(([field, value]) => JSON.stringify(target.mixer[field] ?? null) === JSON.stringify(value ?? null));
        }
        case "device.parameter.set": {
          const target = parameterTarget(snapshot, operation.deviceRef, operation.parameterRef);
          return target.parameter.value === operation.value && parameterRevision(target.parameter) > (plan.prior.revision as number);
        }
        case "clip.set": {
          const located = clipRow(snapshot, operation.clipRef);
          if (located.clip.objectIdentity !== plan.target.clipIdentity) return false;
          return Object.entries(plan.proposed).every(([field, value]) => JSON.stringify(located.clip[field] ?? null) === JSON.stringify(value ?? null));
        }
        case "track.rename": case "scene.rename": {
          const rows = (operation.kind === "track.rename" ? snapshot.tracks : snapshot.scenes) as unknown as Row[];
          const reference = operation.kind === "track.rename" ? operation.trackRef : operation.sceneRef;
          const identity = operation.kind === "track.rename" ? plan.target.trackIdentity : plan.target.sceneIdentity;
          const row = rows.find((item) => item.ref === reference);
          return row !== undefined && row.objectIdentity === identity && row.name === operation.name;
        }
        case "track.create": return false;
        case "routing.arm": {
          const track = routingTarget(snapshot, operation.trackRef);
          return track.objectIdentity === plan.target.trackIdentity && track.armed === operation.armed;
        }
      }
    } catch { return false; }
  }

  /** Verify one dispatched step landed exactly, and capture its result summary. */
  private async verifyStepAsync(adapter: AsyncLiveAdapter, context: LiveOperationContext | undefined, record: BatchRecord, index: number, result: unknown): Promise<Record<string, unknown>> {
    const operation = record.operations[index]!;
    const plan = record.plans[index]!;
    const snapshot = await adapter.snapshotAsync(context);
    switch (operation.kind) {
      case "mixer.set": {
        if (!isObject(result) || result.changed !== true) throw new Error(`transaction batch step ${index} mixer change was not confirmed`);
        const target = mixerTarget(snapshot, operation.trackRef);
        for (const [field, value] of Object.entries(plan.proposed)) if (JSON.stringify(target.mixer[field] ?? null) !== JSON.stringify(value ?? null)) throw new Error(`transaction batch step ${index} mixer postcondition was not confirmed`);
        return { index, kind: operation.kind, trackRef: operation.trackRef, applied: clone(plan.proposed) };
      }
      case "device.parameter.set": {
        const target = parameterTarget(snapshot, operation.deviceRef, operation.parameterRef);
        if (target.parameter.value !== operation.value || parameterRevision(target.parameter) <= (plan.prior.revision as number)) throw new Error(`transaction batch step ${index} parameter postcondition was not confirmed`);
        return { index, kind: operation.kind, parameterRef: operation.parameterRef, value: target.parameter.value, revision: parameterRevision(target.parameter) };
      }
      case "clip.set": {
        if (!isObject(result) || result.changed !== true) throw new Error(`transaction batch step ${index} clip change was not confirmed`);
        const located = clipRow(snapshot, operation.clipRef);
        for (const [field, value] of Object.entries(plan.proposed)) if (JSON.stringify(located.clip[field] ?? null) !== JSON.stringify(value ?? null)) throw new Error(`transaction batch step ${index} clip postcondition was not confirmed`);
        return { index, kind: operation.kind, clipRef: operation.clipRef, applied: clone(plan.proposed) };
      }
      case "track.rename": case "scene.rename": {
        const rows = (operation.kind === "track.rename" ? snapshot.tracks : snapshot.scenes) as unknown as Row[];
        const reference = operation.kind === "track.rename" ? operation.trackRef : operation.sceneRef;
        const row = rows.find((item) => item.ref === reference);
        if (!row || row.name !== operation.name) throw new Error(`transaction batch step ${index} rename postcondition was not confirmed`);
        return { index, kind: operation.kind, ref: reference, name: operation.name };
      }
      case "track.create": {
        if (!isObject(result) || !isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64)) throw new Error(`transaction batch step ${index} track creation did not return exact identity and fingerprint`);
        const track = snapshot.tracks.find((item) => item.ref === result.ref);
        if (!track || track.objectIdentity !== result.objectIdentity || track.name !== operation.name) throw new Error(`transaction batch step ${index} track creation postcondition was not confirmed`);
        const createdFingerprint = trackCreatedFingerprint(snapshot, result.ref as string);
        record.created = [...(record.created ?? []), { stepIndex: index, ref: result.ref, objectIdentity: result.objectIdentity, fingerprint: createdFingerprint }];
        return { index, kind: operation.kind, ref: result.ref, name: operation.name, trackIndex: result.index };
      }
      case "routing.arm": {
        if (!isObject(result) || result.changed !== true) throw new Error(`transaction batch step ${index} routing change was not confirmed`);
        const track = routingTarget(snapshot, operation.trackRef);
        if (track.armed !== operation.armed) throw new Error(`transaction batch step ${index} arm postcondition was not confirmed`);
        return { index, kind: operation.kind, trackRef: operation.trackRef, armed: operation.armed };
      }
    }
  }

  /** Execute the inverse of every completed step in reverse order, restoring the
   *  exact captured prior state. Checkpoints make an exact-key retry resumable. */
  private async revertAsync(adapter: AsyncLiveAdapter, context: LiveOperationContext | undefined, record: BatchRecord, mode: "rollback" | "undo"): Promise<number> {
    record.undoSteps ??= record.operations.map(() => ({ completed: false }));
    const steps = record.undoSteps;
    let reverted = 0;
    for (let index = record.operations.length - 1; index >= 0; index -= 1) {
      if (mode === "rollback" && !record.steps[index]?.completed) continue;
      if (steps[index]?.completed) continue;
      const operation = record.operations[index]!;
      const plan = record.plans[index]!;
      const snapshot = await adapter.snapshotAsync(context);
      switch (operation.kind) {
        case "mixer.set": {
          const target = mixerTarget(snapshot, operation.trackRef);
          if (target.track.objectIdentity !== plan.target.trackIdentity) throw new Error(`transaction batch ${mode} step ${index} mixer target identity changed`);
          for (const [field, value] of Object.entries(plan.proposed)) if (JSON.stringify(target.mixer[field] ?? null) !== JSON.stringify(value ?? null)) throw new Error(`transaction batch ${mode} step ${index} mixer state changed after apply`);
          await adapter.invokeAsync({ operation: "mixer.set", args: { ref: operation.trackRef, ...Object.fromEntries(Object.keys(plan.proposed).map((field) => [field, plan.prior[field] ?? null])), ...mixerAuthority(target) } }, context);
          const verified = mixerTarget(await adapter.snapshotAsync(context), operation.trackRef);
          for (const field of Object.keys(plan.proposed)) if (JSON.stringify(verified.mixer[field] ?? null) !== JSON.stringify(plan.prior[field] ?? null)) throw new Error(`transaction batch ${mode} step ${index} mixer prior-state restoration was not confirmed`);
          break;
        }
        case "device.parameter.set": {
          const target = parameterTarget(snapshot, operation.deviceRef, operation.parameterRef);
          const authority = parameterAuthority(snapshot, operation.parameterRef);
          if (target.parameter.value !== plan.proposed.value || fingerprint(authority) !== plan.prior.authorityDigest) throw new Error(`transaction batch ${mode} step ${index} parameter value or identity changed after apply`);
          await adapter.invokeAsync({ operation: "device.parameter.set", args: { ref: operation.parameterRef, value: plan.prior.value, expectedRevision: parameterRevision(target.parameter), expectedObjectIdentity: authority.parameterIdentity, expectedOwnerRef: authority.ownerRef, expectedOwnerIdentity: authority.ownerIdentity, expectedTrackRef: authority.trackRef, expectedTrackIdentity: authority.trackIdentity, expectedSiblings: clone(authority.siblings) } }, context);
          const verified = parameterTarget((await adapter.snapshotAsync(context)), operation.deviceRef, operation.parameterRef);
          if (verified.parameter.value !== plan.prior.value) throw new Error(`transaction batch ${mode} step ${index} parameter prior-value restoration was not confirmed`);
          break;
        }
        case "clip.set": {
          const located = clipRow(snapshot, operation.clipRef);
          if (located.clip.objectIdentity !== plan.target.clipIdentity) throw new Error(`transaction batch ${mode} step ${index} clip identity changed after apply`);
          for (const [field, value] of Object.entries(plan.proposed)) if (JSON.stringify(located.clip[field] ?? null) !== JSON.stringify(value ?? null)) throw new Error(`transaction batch ${mode} step ${index} clip state changed after apply`);
          await adapter.invokeAsync({ operation: "clip.set", args: { ref: operation.clipRef, ...Object.fromEntries(Object.keys(plan.proposed).map((field) => [field, plan.prior[field] ?? null])), ...clipPropertiesMutationAuthority(snapshot, operation.clipRef) } }, context);
          const verified = clipRow(await adapter.snapshotAsync(context), operation.clipRef);
          for (const field of Object.keys(plan.proposed)) if (JSON.stringify(verified.clip[field] ?? null) !== JSON.stringify(plan.prior[field] ?? null)) throw new Error(`transaction batch ${mode} step ${index} clip prior-state restoration was not confirmed`);
          break;
        }
        case "track.rename": case "scene.rename": {
          const rows = (operation.kind === "track.rename" ? snapshot.tracks : snapshot.scenes) as unknown as Row[];
          const reference = operation.kind === "track.rename" ? operation.trackRef : operation.sceneRef;
          const identity = operation.kind === "track.rename" ? plan.target.trackIdentity : plan.target.sceneIdentity;
          const row = rows.find((item) => item.ref === reference);
          if (!row || row.objectIdentity !== identity || row.name !== operation.name) throw new Error(`transaction batch ${mode} step ${index} rename target identity or name changed after apply`);
          await adapter.invokeAsync({ operation: operation.kind, args: { ref: reference, name: plan.prior.name, expectedName: operation.name, expectedObjectIdentity: identity, expectedAuthorityRevision: structureRevision(snapshot) } }, context);
          const verified = (operation.kind === "track.rename" ? (await adapter.snapshotAsync(context)).tracks : (await adapter.snapshotAsync(context)).scenes) as unknown as Row[];
          if (verified.find((item) => item.ref === reference)?.name !== plan.prior.name) throw new Error(`transaction batch ${mode} step ${index} rename prior-name restoration was not confirmed`);
          break;
        }
        case "track.create": {
          const owned = (record.created ?? []).find((item) => item.stepIndex === index);
          if (!owned) throw new Error(`transaction batch ${mode} step ${index} created-track record is unavailable`);
          const track = snapshot.tracks.find((item) => item.ref === owned.ref);
          if (!track || track.objectIdentity !== owned.objectIdentity || trackCreatedFingerprint(snapshot, owned.ref) !== owned.fingerprint) throw new Error(`transaction batch ${mode} step ${index} created track changed after creation; deletion refused`);
          await adapter.invokeAsync({ operation: "track.delete", args: { ref: owned.ref, expectedStructureRevision: structureRevision(snapshot), expectedObjectIdentity: owned.objectIdentity } }, context);
          if ((await adapter.snapshotAsync(context)).tracks.some((item) => item.ref === owned.ref)) throw new Error(`transaction batch ${mode} step ${index} created-track deletion was not confirmed`);
          break;
        }
        case "routing.arm": {
          const track = routingTarget(snapshot, operation.trackRef);
          if (track.objectIdentity !== plan.target.trackIdentity) throw new Error(`transaction batch ${mode} step ${index} routing target identity changed`);
          if (track.armed !== operation.armed) throw new Error(`transaction batch ${mode} step ${index} arm state changed after apply`);
          await adapter.invokeAsync({ operation: "routing.set", args: { ref: operation.trackRef, arm: plan.prior.armed, expectedObjectIdentity: track.objectIdentity, expectedStateRevision: routingStateRevision(track) } }, context);
          const verified = routingTarget(await adapter.snapshotAsync(context), operation.trackRef);
          if (verified.armed !== plan.prior.armed) throw new Error(`transaction batch ${mode} step ${index} arm prior-state restoration was not confirmed`);
          break;
        }
      }
      steps[index] = { completed: true };
      reverted += 1;
    }
    return reverted;
  }

  async applyAsync(transactionId: string, confirmation: unknown, idempotencyKey: string, context?: LiveOperationContext): Promise<unknown> {
    if (confirmation !== "apply") throw new Error("confirmation=apply is required");
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) { if (existing.transactionId !== transactionId) throw new Error("idempotency key conflicts with another transaction"); return { ...clone(existing.result as object), idempotent: true }; }
    const record = this.records.get(transactionId);
    if (!record || (record.state === "previewed" && record.expiresAt <= Date.now())) throw new Error("transaction batch preview expired; preview again");
    if (record.state === "applied" && record.applyKey === idempotencyKey) return { ...clone(this.idempotency.get(idempotencyKey)?.result as object ?? { transactionId, state: "applied" }), idempotent: true };
    const reconciliation = record.state === "uncertain" && record.applyKey === idempotencyKey;
    if (record.state === "uncertain" && !reconciliation) throw new Error("transaction batch state is uncertain; reconcile with the exact original idempotency key");
    if ((record.state !== "previewed" && !reconciliation)) throw new Error("transaction batch is no longer applicable");
    const adapter = this.asyncAdapter();
    if (reconciliation) await adapter.snapshotAsync(context);
    const status = this.require(record.requiredCapabilities, record.requiredOperations);
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; preview again");
    if (reconciliation && record.recoveryMode === "compensate") {
      try { const reverted = await this.revertAsync(adapter, context, record, "rollback"); record.state = "undone"; return { transactionId, state: "compensated", failedIndex: record.failedIndex, reason: record.failureReason, rolledBack: reverted, idempotent: false }; }
      catch (cause) { record.state = "uncertain"; throw cause; }
    }
    record.state = "applying"; record.recoveryMode = "apply"; record.applyKey = idempotencyKey;
    const applied: Array<Record<string, unknown>> = record.steps.map((step, index) => (step.completed && isObject(step.result) ? clone(step.result) : { index, kind: record.operations[index]!.kind, replayed: step.completed }));
    try {
      for (let index = 0; index < record.operations.length; index += 1) {
        if (record.steps[index]?.completed) continue;
        const snapshot = await adapter.snapshotAsync(context);
        if (reconciliation && this.stepPostconditionPresent(snapshot, record, index)) {
          const replayed = { index, kind: record.operations[index]!.kind, replayed: true, note: "the exact step postcondition was already present at reconciliation; the recorded checkpoint was completed without re-dispatch" };
          record.steps[index] = { completed: true, result: replayed };
          applied[index] = replayed;
          continue;
        }
        const step = this.stepArgs(snapshot, record, index);
        const result = await adapter.invokeAsync({ operation: step.operation, args: step.args }, context);
        const verified = await this.verifyStepAsync(adapter, context, record, index, result);
        record.steps[index] = { completed: true, result: verified };
        applied[index] = verified;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/uncertain|disconnect|timeout|cancellation/i.test(message)) { record.state = "uncertain"; record.recoveryMode = "apply"; throw cause; }
      record.failedIndex = record.steps.findIndex((step) => !step.completed);
      record.failureReason = message.length > 160 ? `${message.slice(0, 157)}...` : message;
      record.recoveryMode = "compensate";
      try {
        const reverted = await this.revertAsync(adapter, context, record, "rollback");
        record.state = "undone";
        return { transactionId, state: "compensated", failedIndex: record.failedIndex, reason: record.failureReason, rolledBack: reverted, idempotent: false };
      } catch (compensationCause) {
        record.state = "uncertain";
        throw new Error(`transaction batch failed at operation ${record.failedIndex} and exact rollback failed; reconcile with the exact original idempotency key (${compensationCause instanceof Error ? compensationCause.message : String(compensationCause)})`);
      }
    }
    record.state = "applied";
    const result = { transactionId, state: "applied", operations: applied, epoch: record.epoch, idempotent: false };
    this.idempotency.set(idempotencyKey, { transactionId, result: clone(result) });
    return result;
  }

  async undoAsync(transactionId: string, confirmation: unknown, idempotencyKey: string, context?: LiveOperationContext): Promise<unknown> {
    if (confirmation !== "undo") throw new Error("confirmation=undo is required");
    const record = this.records.get(transactionId);
    if (record?.state === "undone" && record.undoKey === idempotencyKey) return { transactionId, state: "undone", idempotent: true };
    if (!record) throw new Error("Only an applied or exact-key uncertain batch transaction can be undone");
    const reconciliation = record.state === "uncertain" && record.undoKey === idempotencyKey;
    if (!reconciliation && record.state !== "applied") throw new Error("Only an applied or exact-key uncertain batch transaction can be undone");
    const adapter = this.asyncAdapter(); const status = this.require(record.requiredCapabilities, record.requiredOperations);
    if (status.epoch !== record.epoch) throw new Error("Live connection epoch changed; undo refused");
    if (!record.steps.every((step) => step.completed)) throw new Error("transaction batch has unapplied steps and cannot be undone as a whole");
    record.state = "undoing"; record.undoKey = idempotencyKey;
    try {
      const reverted = await this.revertAsync(adapter, context, record, "undo");
      record.state = "undone";
      return { transactionId, state: "undone", restored: reverted, idempotent: false };
    } catch (cause) { record.state = "uncertain"; throw cause; }
  }

  isFinalizable(transactionId: string): boolean { const record = this.records.get(transactionId); return !!record && ["uncertain", "applied", "undone"].includes(record.state); }

  finalize(transactionId: string): { transactionId: string; finalized: true; priorState: string } {
    const record = this.records.get(transactionId); if (!record || !["uncertain", "applied", "undone"].includes(record.state)) throw new Error("transaction batch recovery record is not finalizable");
    const priorState = record.state; this.records.delete(transactionId); for (const [key, value] of this.idempotency) if (value.transactionId === transactionId) this.idempotency.delete(key);
    return { transactionId, finalized: true, priorState };
  }
}
