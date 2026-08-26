import type { Readable, Writable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync, createReadStream, constants as fsConstants, chmodSync, unlinkSync, lstatSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join as joinPath } from "node:path";
import { sep } from "node:path";
import { homedir } from "node:os";
import { AnalysisRunner, type EncodedAnalysisSource } from "./analysis-runner.js";
import type { PcmAnalysis } from "./analysis.js";
import type { ConventionalChannelLabel } from "./audio-standards.js";
import { captureMediaIsAbsent, decodeOwnedWaveFile, unlinkLateCaptureCompanions, unlinkOwnedCaptureFile, type DecodedCaptureFile } from "./audio-file.js";
import { diagnoseAudioWithLiveContext, type AudioDiagnosis } from "./audio-diagnosis.js";
import { LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_REGISTRY_OPERATIONS, LIVE_UNAVAILABLE_CAPABILITIES, UnavailableLiveAdapter, type LiveAdapter, type LiveCapability, type LiveEvent, type LiveInvocation, type LiveOperationContext, type LiveRef, type LiveSnapshot, type LiveStatus, type Track, type TakeLane } from "./live.js";
import { serveStdio, type RecordContext } from "./stdio.js";
import { projectBackup, projectInfo, projectLimitation } from "./project.js";
import { SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES, SEMANTIC_PROJECT_MAX_RECORDS, assembleSemanticProjectPages, createSemanticProjectSnapshot, pageSemanticProjectSnapshot, type SemanticPrivacyProfile, type SemanticProjectArtifact, type SemanticProjectPage } from "./project-semantic.js";
import { diffSemanticProjectSnapshots, pageSemanticProjectDiff } from "./project-semantic-diff.js";
import { createOfflineAlsArtifact, extractAlsMidi, lintAlsModel, readAlsModel } from "./als.js";
import { SessionMidiTransactionManager, discoverSession } from "./transactions/session-midi.js";
import { GENERATIVE_TRANSFORMS, MIDI_TRANSFORM_LARGE_UPDATE_THRESHOLD, MIDI_TRANSFORM_TYPES, applyMidiTransform, diffNotes, midiExpressionProbe, noteContentDigest, noteIdentityDigest, type MidiTransformType } from "./midi-transforms.js";
import { estimateKey } from "./key-estimation.js";
import { JOURNEY_IDS, JOURNEY_PROMPTS, journeyResource, planUserJourney, renderJourneyPrompt, type ExperienceLevel, type JourneyId } from "./journeys.js";
import type { AsyncLiveAdapter } from "./live.js";
import { PACKAGE_VERSION } from "./delivery.js";
import { DEFAULT_TOOL_POLICY, TOOL_POLICY_PROFILES, liveMutationAvailable, parseToolPolicySpec, resolveToolVisibility, toolCatalogEntry, toolPolicyFromEnv, visibleToolDescriptors, type ToolPolicySpec, type ToolVisibilityRow } from "./tool-catalog.js";

export const PROTOCOL_VERSION = "2025-11-25";
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_REQUEST_IDS = 4096;
const MAX_TOOL_CALLS_PER_MINUTE = 120;

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type TempoTransactionState = "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone";
interface TempoTransaction {
  id: string;
  setRef: LiveRef;
  setIdentity: string;
  priorTempo: number;
  proposedTempo: number;
  appliedTempo?: number;
  epoch: number;
  expiresAt: number;
  state: TempoTransactionState;
  applyKey?: string;
  undoKey?: string;
}
interface ArrangementTransaction {
  id: string; epoch: number; revision: string; start: number; end: number; startName: string; endName: string;
  prior: Array<{ ref: LiveRef; objectIdentity: string; name: string; position: number }>; created?: Array<{ ref: LiveRef; objectIdentity: string; name: string; position: number; fingerprint: string }>;
  recoverySteps?: Array<{ args: JsonObject; result?: { ref: LiveRef; objectIdentity: string; name: string; position: number; createdFingerprint: string } }>;
  compensationSteps?: Array<{ args: JsonObject; completed: boolean }>;
  recoveryMode?: "apply" | "compensate";
  expiresAt: number; state: "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone"; applyKey?: string; undoKey?: string;
}
interface SessionStructureItem { kind: "track" | "scene"; name: string; trackKind?: "audio" | "midi"; index: number; }
interface SessionStructureTransaction {
  id: string; epoch: number; revision: string; proposed: SessionStructureItem[];
  priorTracks: Array<{ ref: LiveRef; name: string; kind: string; index: number }>;
  priorScenes: Array<{ ref: LiveRef; name: string; index: number }>;
  created?: Array<{ ref: LiveRef; objectIdentity: string; kind: "track" | "scene"; name: string; index: number; fingerprint: string }>;
  recoverySteps?: Array<{ operation: "track.create" | "scene.create"; args: JsonObject; result?: { ref: LiveRef; objectIdentity: string; name: string; index: number; createdFingerprint: string } }>;
  compensationSteps?: Array<{ operation: "track.delete" | "scene.delete"; args: JsonObject; completed: boolean }>;
  recoveryMode?: "apply" | "compensate";
  expiresAt: number; state: "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone"; applyKey?: string; undoKey?: string;
}
interface DeviceParameterTransaction {
  id: string;
  epoch: number;
  deviceRef: LiveRef;
  parameterRef: LiveRef;
  authority: JsonObject;
  priorValue: number;
  proposedValue: number;
  confirmation: string;
  priorRevision: number;
  appliedRevision?: number;
  applyKey?: string;
  undoKey?: string;
  expiresAt: number;
  state: "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone";
}
interface SessionAuditionTransaction {
  id: string;
  epoch: number;
  sceneRef: LiveRef;
  sceneRevision: string;
  playbackRevision: string;
  eligibleTargetKeys: string[];
  authorityRevision: string;
  setName: string;
  setIdentity: string;
  outputSafety: JsonObject;
  confirmation: string;
  stopConfirmation: string;
  expiresAt: number;
  applyKey?: string;
  stopKey?: string;
  state: "previewed" | "applying" | "applied" | "stopping" | "stopped" | "uncertain";
  launched?: unknown;
  inflight?: Promise<JsonObject>;
}
interface AudioCaptureTransaction {
  id: string;
  captureId: string;
  epoch: number;
  setName: string;
  sourceSlotRef: LiveRef;
  destinationSlotRef: LiveRef;
  destinationTrackRef: LiveRef;
  fence: string;
  prior: JsonObject;
  durationMs: number;
  outputSafety: JsonObject;
  confirmation: string;
  expiresAt: number;
  state: "previewed" | "applying" | "capturing" | "analyzing" | "completed" | "cancelled" | "uncertain";
  applyKey?: string;
  mapperToken?: string;
  startedAt?: number;
  result?: JsonObject;
  startDispatched?: boolean;
  rawPrimaryUnlinked?: boolean;
  projectFilePath?: string;
  abortController?: AbortController;
  waiters?: number;
  inflight?: Promise<JsonObject | null>;
}
interface TransportTransaction {
  id: string;
  epoch: number;
  setRef: LiveRef;
  setIdentity: string;
  prior: { position: number | null; loop: { enabled: boolean | null; start: number | null; length: number | null }; punchIn: boolean | null; punchOut: boolean | null; metronome: boolean | null };
  proposed: Record<string, number | boolean>;
  playbackRevision: string;
  appliedRevision?: string;
  expiresAt: number;
  applyKey?: string;
  undoKey?: string;
  state: "previewed" | "applied" | "uncertain" | "undone";
}
interface ClipLaunchTransaction {
  id: string;
  epoch: number;
  slotRef: LiveRef;
  trackRef: LiveRef;
  sceneRef: LiveRef;
  sceneIndex: number;
  clipRef: LiveRef;
  trackIdentity: string;
  sceneIdentity: string;
  slotIdentity: string;
  clipIdentity: string;
  targetKey: string;
  playbackRevision: string;
  outputSafety: JsonObject;
  confirmation: string;
  stopConfirmation: string;
  expiresAt: number;
  applyKey?: string;
  stopKey?: string;
  state: "previewed" | "applying" | "applied" | "stopping" | "stopped" | "uncertain";
  uncertainPhase?: "apply" | "stop";
  inflight?: Promise<JsonObject>;
}
interface NoteEditTransaction {
  id: string;
  epoch: number;
  kind: "update" | "delete";
  clipRef: LiveRef;
  authority: JsonObject;
  notesRevision: string;
  fence: string;
  appliedFence?: string;
  expectedAppliedFence: string;
  patches?: Array<Record<string, unknown>>;
  noteIds?: number[];
  priorNotes: Array<Record<string, unknown>>;
  priorAllNotes: Array<Record<string, unknown>>;
  expiresAt: number;
  applyKey?: string;
  undoKey?: string;
  undoExpectedFence?: string;
  state: "previewed" | "applying" | "applied" | "undoing" | "undone" | "uncertain";
}
interface ClipLifecycleTransaction {
  id: string;
  epoch: number;
  kind: "rename" | "duplicate" | "arrangement-create" | "arrangement-delete" | "arrangement-audio-create" | "arrangement-take-lane-create" | "move" | "audio-set" | "mixer-set" | "automation" | "browser-load" | "device" | "routing-set" | "recording" | "backup" | "realtime-arm" | "capture-midi" | "scene-capture" | "view" | "locator-jump" | "clip-set" | "session-audio-create" | "warp-marker" | "clip-action" | "note-target" | "midi-transform" | "tuning" | "groove" | "scene-set" | "scene-fire" | "transport-action" | "track-structure" | "track-set" | "song-set" | "device-delete" | "track-view" | "selection" | "clip-view" | "device-view" | "dialog" | "mixer-extended" | "chain-mixer" | "device-io" | "device-advanced" | "chain-set" | "drum-pad" | "rack" | "rack-view" | "device-specialized" | "looper" | "simpler";
  fence: string;
  clipRef?: LiveRef;
  payload: Record<string, unknown>;
  prior?: Record<string, unknown>;
  expiresAt: number;
  applyKey?: string;
  undoKey?: string;
  state: "previewed" | "applying" | "applied" | "undoing" | "undone" | "uncertain";
  created?: Record<string, unknown>;
  inflight?: Promise<Record<string, unknown>>;
}

const REQUEST_ID_MAX_LENGTH = 128;
const SERVER_VERSION = PACKAGE_VERSION;
const TRANSACTION_TTL_MS = 30_000;
const MAX_TRANSACTIONS = 256;
const AUDITION_TTL_MS = 30_000;
// Real-Live snapshot reads take seconds on populated sets, and launch/stop
// state propagates asynchronously at quantization boundaries; the deadline
// must cover snapshot + dispatch + polled verification.
const AUDITION_DEADLINE_MS = 15_000;
// Structure ownership checks can require multiple complete real-Live snapshots
// around one create/delete. Each step receives a fresh protocol-bounded window.
const STRUCTURE_STEP_DEADLINE_MS = 45_000;
// A complete MIDI transaction crosses snapshot plus two separately authorized
// mutations and authoritative readback. An explicit context may extend the
// configured default timeout while remaining bounded by the bridge protocol.
const SESSION_MIDI_TRANSACTION_DEADLINE_MS = 30_000;
const MAX_AUDITION_TRANSACTIONS = 64;
const MONITORABLE_TRACK_KINDS = new Set(["regular", "audio", "midi"]);

const resources = [
  { uri: "ableton://capabilities", name: "Capability catalog", description: "Implemented and unavailable host capabilities.", mimeType: "application/json" },
  { uri: "ableton://safety", name: "Live safety contract", description: "The host's read-only and unavailable-capability guarantees.", mimeType: "text/markdown" },
  { uri: "ableton://max-extension", name: "Max extension contract", description: "Versioned packet-level extension point for operator-authored Max clients; no bundled .amxd or max capability is implied.", mimeType: "application/json" },
  { uri: "ableton://journeys", name: "Capability-aware user journeys", description: "Five bounded composition, sound-design, reference, recording, and performance journeys with truthful availability and fallback.", mimeType: "application/json" },
] as const;

const prompts = [
  {
    name: "analyze_audio",
    description: "Prepare a bounded, local PCM analysis request without changing Live state.",
    arguments: [
      { name: "sampleRate", description: "PCM sample rate in Hz.", required: true },
      { name: "channels", description: "Optional interleaved channel count.", required: false },
    ],
  },
  {
    name: "change_tempo_safely",
    description: "Discover, preview, confirm, verify, and undo a reversible tempo change.",
    arguments: [],
  },
  ...JOURNEY_PROMPTS,
] as const;

const safetyResource = [
  "# Live safety contract",
  "",
  "This host does not connect to Ableton Live unless an explicit adapter is installed.",
  "With the default adapter, Live is unavailable and no Live operations occur. If a configured adapter reports the exact protocol and negotiated operation capability, tempo apply and guarded undo are explicit project mutations and are never implied by read-only tools.",
  "Local analysis accepts caller-supplied PCM and returns aggregate standards measurements only. It never attributes that PCM to Live without explicit provenance.",
  "When and only when a real Remote Script negotiates audio.capture.resampling, a separate confirmed workflow can play one exact source clip, record one exact empty destination slot, analyze the bounded WAV in an isolated worker, then delete the owned clip and unlink the raw file. A mapper watchdog and independent emergency tool stop capture after cancellation or host failure.",
  "No read-only tool starts playback, records, writes files, or mutates a project. Mutation tools disclose their impact and require an expiring confirmation.",
].join("\n");

export { UnavailableLiveAdapter } from "./live.js";
export type { AsyncLiveAdapter, LiveAdapter, LiveRef, LiveSnapshot, LiveStatus } from "./live.js";


const hostUnavailableCapabilities = ["resources.subscribe", "filesystem", "network", "delivery"] as const;
const unavailableCapabilities = [...hostUnavailableCapabilities, "live.mutations", "live.transport", "live.recording", "live.routing", "live.audio", "live.midi", "realtime", "live.audio.analysis", "live.audio.capture.resampling", ...LIVE_UNAVAILABLE_CAPABILITIES] as const;
const liveResource = { uri: "ableton://live-workflow", name: "Safe tempo workflow", description: "Discover, preview, confirm, apply, verify, and undo a tempo change.", mimeType: "text/markdown" } as const;
const liveWorkflowResource = [
  "# Safe tempo workflow",
  "",
  "1. Call live_status and live_snapshot to establish the adapter and epoch.",
  "2. Call live_tempo_preview; preview never mutates Live and returns a transactionId.",
  "3. Call live_tempo_apply with confirmation=apply and a fresh idempotencyKey.",
  "4. Call live_snapshot to verify the authoritative tempo.",
  "5. Call live_undo with confirmation=undo to restore the captured tempo when no newer change intervened.",
].join("\n");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown, maxLength = REQUEST_ID_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isDiscoveryFilter(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!isObject(value) || Object.keys(value).length > 8) return false;
  return Object.entries(value).every(([key, item]) => isNonEmptyString(key, 64) && (item === null || typeof item === "boolean" || (typeof item === "string" && item.length <= 256) || (typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER)));
}

function isIdempotencyKey(value: unknown): value is string { return typeof value === "string" && value.length >= 8 && value.length <= 128; }

function canonicalMutationIdentity(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error("mutation authority is too deeply nested");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("mutation authority contains a non-finite number"); return JSON.stringify(Object.is(value, -0) ? 0 : value); }
  if (typeof value === "string") { if (value.length > 16_384) throw new Error("mutation authority string is too large"); return JSON.stringify(value); }
  if (Array.isArray(value)) { if (value.length > 256) throw new Error("mutation authority array is too large"); return `[${value.map((item) => canonicalMutationIdentity(item, depth + 1)).join(",")}]`; }
  if (isObject(value)) { const keys = Object.keys(value).sort(); if (keys.length > 256) throw new Error("mutation authority object is too large"); return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalMutationIdentity(value[key], depth + 1)}`).join(",")}}`; }
  throw new Error("mutation authority contains an unsupported value");
}

function response(id: RequestId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function error(id: RequestId | null, code: number, message: string, data?: unknown): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textContent(text: string): JsonObject {
  return { type: "text", text };
}

const ACTIVE_TRANSACTION_STATES = new Set(["applying", "stopping", "undoing", "capturing", "analyzing"]);
const IN_FLIGHT_TRANSACTION_IDS = new Set<string>();
const RECOVERY_PROTECTED_STATES = new Set([...ACTIVE_TRANSACTION_STATES, "applied", "uncertain"]);

function isRetirableAppliedTransaction(candidate: unknown): boolean {
  const record = candidate as { state?: unknown; kind?: unknown; payload?: Record<string, unknown> };
  if (record.state !== "applied" || typeof record.kind !== "string") return false;
  const action = record.payload?.action as string | undefined;
  switch (record.kind) {
    case "scene-fire": case "transport-action": case "dialog": case "clip-action": return true;
    case "looper": return action !== "set";
    case "rack": return action !== undefined && action !== "set";
    case "device-advanced": return ["re-enable-automation", "save-comparison", "set-bank"].includes(action ?? "");
    case "drum-pad": return action === "delete-all-chains";
    default: return false;
  }
}
class BoundedTransactionMap<T extends { expiresAt: number; state: string }> extends Map<string, T> {
  public constructor(private readonly capacity = MAX_AUDITION_TRANSACTIONS, private readonly onDelete?: (value: T) => void) { super(); }
  public override delete(key: string): boolean {
    const value = this.get(key);
    if (!super.delete(key)) return false;
    // Terminal cleanup hook (staged-file release); never let cleanup break bookkeeping.
    if (value !== undefined) { try { this.onDelete?.(value); } catch { /* best-effort transaction cleanup hook */ } }
    return true;
  }
  public override set(key: string, value: T): this {
    const now = Date.now();
    // Applied non-undoable records retire at their advertised TTL so
    // acknowledged momentary actions cannot exhaust protected capacity
    // permanently; undoable applied records keep their replay/undo authority,
    // and uncertain records stay protected until explicit recovery.
    for (const [candidateKey, candidate] of this) if (candidate.expiresAt <= now && (!RECOVERY_PROTECTED_STATES.has(candidate.state) || isRetirableAppliedTransaction(candidate)) && !IN_FLIGHT_TRANSACTION_IDS.has(candidateKey)) this.delete(candidateKey);
    if (!this.has(key)) while (this.size >= this.capacity) {
      const oldest = [...this].find(([candidateKey, candidate]) => !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(candidateKey));
      if (!oldest) throw new Error("transaction capacity is exhausted by recovery-protected work");
      this.delete(oldest[0]);
    }
    return super.set(key, value);
  }
}

export class McpHost {
  private initialized = false;
  private initializedNotification = false;
  private shuttingDown = false;
  private readonly seenIds = new Set<string>();
  private readonly idOrder: string[] = [];
  private readonly toolCallTimes: number[] = [];
  private readonly analysisRunner = new AnalysisRunner();
  private readonly audioCaptureTransactions = new BoundedTransactionMap<AudioCaptureTransaction>();
  private readonly transactions = new BoundedTransactionMap<TempoTransaction>(MAX_TRANSACTIONS);
  private readonly arrangementTransactions = new BoundedTransactionMap<ArrangementTransaction>();
  private readonly sessionStructureTransactions = new BoundedTransactionMap<SessionStructureTransaction>();
  private readonly deviceParameterTransactions = new BoundedTransactionMap<DeviceParameterTransaction>();
  private readonly midiTransactions: SessionMidiTransactionManager;
  private readonly inFlightMutations = new Map<string, { idempotencyKey: string; argumentDigest: string; promise: Promise<JsonObject | null>; controller: AbortController; waiters: number; settled: boolean }>();
  private readonly auditionTransactions = new BoundedTransactionMap<SessionAuditionTransaction>();
  private readonly transportTransactions = new BoundedTransactionMap<TransportTransaction>();
  private readonly clipLaunchTransactions = new BoundedTransactionMap<ClipLaunchTransaction>();
  private readonly noteEditTransactions = new BoundedTransactionMap<NoteEditTransaction>();
  private readonly clipLifecycleTransactions = new BoundedTransactionMap<ClipLifecycleTransaction>(MAX_AUDITION_TRANSACTIONS, (value) => {
    if ((value.kind === "session-audio-create" || value.kind === "simpler") && typeof value.payload?.filePath === "string") this.releaseStagedImportFile(value.payload.filePath);
  });
  private readonly undoRecoveryPlans = new WeakMap<object, { idempotencyKey: string; steps: Array<{ operation: LiveInvocation["operation"]; args: Record<string, unknown>; completed: boolean; result?: unknown }> }>();
  private recoveryFinalizationInFlight = false;
  private activeAsyncOperations = 0;
  private toolPolicy: ToolPolicySpec;
  private toolListFingerprint: string | undefined;

  public constructor(private readonly adapter: LiveAdapter = new UnavailableLiveAdapter(), options: { toolPolicy?: ToolPolicySpec | unknown; importStagingDir?: string } = {}) {
    this.midiTransactions = new SessionMidiTransactionManager(adapter);
    this.toolPolicy = options.toolPolicy === undefined ? DEFAULT_TOOL_POLICY : parseToolPolicySpec(options.toolPolicy);
    this.importStagingDirOption = options.importStagingDir;
  }

  /** The effective deployment tool policy (profile plus explicit overrides). */
  public effectiveToolPolicy(): ToolPolicySpec { return this.toolPolicy; }

  /** Replace the runtime tool policy and notify peers when the visible set changed. */
  public setToolPolicy(policy: unknown): ToolPolicySpec {
    this.toolPolicy = parseToolPolicySpec(policy);
    this.noteToolListChanged();
    return this.toolPolicy;
  }

  private async singleFlightMutation(name: string, id: RequestId, args: unknown, execute: (signal?: AbortSignal) => Promise<JsonObject | null>, callerSignal?: AbortSignal): Promise<JsonObject | null> {
    if (this.recoveryFinalizationInFlight && name !== "live_recovery_finalize") throw new Error("recovery finalization safety barrier is in progress");
    if (name === "live_recovery_finalize") return await execute(callerSignal);
    if (!isObject(args) || !isNonEmptyString(args.idempotencyKey, 128)) { this.activeAsyncOperations += 1; try { return await execute(callerSignal); } finally { this.activeAsyncOperations -= 1; } }
    const transactionId = isNonEmptyString(args.transactionId, 128) ? args.transactionId : isNonEmptyString(args.captureId, 128) ? args.captureId : null;
    const identity = transactionId ? `operation:${name}:transaction:${transactionId}` : `operation:${name}:key:${args.idempotencyKey}`;
    const argumentDigest = createHash("sha256").update(canonicalMutationIdentity(args)).digest("hex");
    let flight = this.inFlightMutations.get(identity);
    const joined = flight !== undefined;
    if (flight && (flight.idempotencyKey !== args.idempotencyKey || flight.argumentDigest !== argumentDigest)) throw new Error("operation is already applying with different idempotency or authority arguments");
    if (!flight && transactionId && IN_FLIGHT_TRANSACTION_IDS.has(transactionId)) throw new Error("transaction recovery or finalization is already in progress");
    if (!flight) {
      const controller = new AbortController();
      flight = { idempotencyKey: args.idempotencyKey, argumentDigest, controller, waiters: 0, settled: false, promise: undefined as unknown as Promise<JsonObject | null> };
      const owned = flight;
      if (transactionId) IN_FLIGHT_TRANSACTION_IDS.add(transactionId);
      this.activeAsyncOperations += 1;
      owned.promise = execute(controller.signal).then(async (outcome) => {
        if (transactionId && outcome && isObject(outcome.result) && outcome.result.isError === false) { const retire = (this.adapter as Partial<{ retireTransactionAsync(transactionId: string, context?: LiveOperationContext): Promise<unknown> }>).retireTransactionAsync; if (typeof retire === "function") { try { await retire.call(this.adapter, transactionId, { deadlineMs: Date.now() + 5_000 }); } catch { /* bounded bridge ledger remains conservative until a later terminal acknowledgement */ } } }
        return outcome;
      }).finally(() => {
        this.activeAsyncOperations -= 1; owned.settled = true;
        if (transactionId) IN_FLIGHT_TRANSACTION_IDS.delete(transactionId);
        if (this.inFlightMutations.get(identity) === owned) this.inFlightMutations.delete(identity);
      });
      void owned.promise.catch(() => undefined);
      this.inFlightMutations.set(identity, owned);
    }
    flight.waiters += 1;
    const aborted = Symbol("caller-aborted");
    let onAbort: (() => void) | undefined;
    const callerAbort = callerSignal ? new Promise<typeof aborted>((resolve) => {
      onAbort = () => resolve(aborted);
      if (callerSignal.aborted) onAbort(); else callerSignal.addEventListener("abort", onAbort, { once: true });
    }) : undefined;
    try {
      const outcome = callerAbort ? await Promise.race([flight.promise, callerAbort]) : await flight.promise;
      if (outcome === aborted || outcome === null) return null;
      if (!joined) return outcome;
      const replay = structuredClone(outcome); replay.id = id;
      const result = replay.result;
      if (isObject(result) && Array.isArray(result.content) && isObject(result.content[0]) && typeof result.content[0].text === "string") {
        try { const value = JSON.parse(result.content[0].text) as unknown; if (isObject(value)) { value.idempotent = true; result.content[0].text = JSON.stringify(value); } } catch { /* preserve non-JSON text */ }
      }
      return replay;
    } finally {
      if (onAbort && callerSignal) callerSignal.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    }
  }

  /** Promise-based request entrypoint for process-backed adapters. The legacy
   * handle() remains for deterministic in-process callers. */
  public async handleAsync(input: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (signal?.aborted) return null;
    // JSON-RPC notifications are never answered on either request path.
    if (isObject(input) && input.id === undefined) return this.handle(input);
    if (!isObject(input) || input.method !== "tools/call" || !isObject(input.params) || typeof input.params.name !== "string") return this.handle(input);
    const name = input.params.name;
    const toolArguments = input.params.arguments;
    if (![ "live_status", "audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop", "live_session_structure_preview", "live_session_structure_apply", "live_object_rename_preview", "live_object_rename_apply", "live_snapshot", "live_discover", "live_device_parameter_preview", "live_device_parameter_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_midi_transform_preview", "live_midi_transform_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo", "live_recovery_finalize", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi_preview", "live_capture_midi_apply", "live_scene_capture_preview", "live_scene_capture_apply", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_snapshot_export", "live_project_snapshot_diff", "als_read", "als_lint", "als_diff", "live_project_backup_preview", "live_project_backup_apply", "live_realtime_arm_preview", "live_realtime_arm_apply", "live_realtime_disarm", "live_realtime_stats", "live_view_preview", "live_view_apply", "live_locator_jump_preview", "live_locator_jump_apply", "live_clip_properties_preview", "live_clip_properties_apply", "live_audio_import_preview", "live_audio_import_apply", "live_warp_marker_preview", "live_warp_marker_apply", "live_clip_action_preview", "live_clip_action_apply", "live_note_edit_preview", "live_note_edit_apply", "live_note_read", "live_key_estimate", "live_tuning_preview", "live_tuning_apply", "live_groove_preview", "live_groove_apply", "live_scene_preview", "live_scene_apply", "live_scene_fire_preview", "live_scene_fire_apply", "live_song_state", "live_song_settings_preview", "live_song_settings_apply", "live_transport_action_preview", "live_transport_action_apply", "live_track_structure_preview", "live_track_structure_apply", "live_device_delete_preview", "live_device_delete_apply", "live_track_view_preview", "live_track_view_apply", "live_track_properties_preview", "live_track_properties_apply", "live_selection_preview", "live_selection_apply", "live_clip_view_preview", "live_clip_view_apply", "live_device_view_preview", "live_device_view_apply", "live_performance_read", "live_mixer_extended_preview", "live_mixer_extended_apply", "live_chain_mixer_preview", "live_chain_mixer_apply", "live_device_io_preview", "live_device_io_apply", "live_device_advanced_preview", "live_device_advanced_apply", "live_chain_preview", "live_chain_apply", "live_drum_pad_preview", "live_drum_pad_apply", "live_rack_preview", "live_rack_apply", "live_rack_view_preview", "live_rack_view_apply", "live_device_specialized_preview", "live_device_specialized_apply", "live_looper_preview", "live_looper_apply", "live_simpler_preview", "live_simpler_apply", "live_observe_subscribe", "live_observe_poll", "live_observe_unsubscribe", "live_browser_roots", "live_browser_inspect", "live_arrangement_automation_read", "live_take_lane_read", "live_comp_read", "live_warp_marker_read", "live_application_dialog_preview", "live_application_dialog_apply"].includes(name)) return this.handle(input);
    // Reuse the synchronous validator and request bookkeeping, then execute the
    // adapter operation asynchronously. Invalid requests never reach Live.
    const id = this.requestId(input.id);
    if (id === null || input.jsonrpc !== "2.0" || !hasOnly(input, ["jsonrpc", "id", "method", "params", "_meta"])) return error(null, -32600, "Invalid Request");
    const key = `${typeof id}:${String(id)}`;
    if (this.seenIds.has(key)) return error(id, -32600, "Duplicate request identifier");
    this.seenIds.add(key); this.idOrder.push(key);
    if (this.idOrder.length > MAX_TRACKED_REQUEST_IDS) { const expired = this.idOrder.shift(); if (expired !== undefined) this.seenIds.delete(expired); }
    if (this.shuttingDown) return error(id, -32600, "Server is shutting down");
    if (!this.initialized) return error(id, -32002, "Server has not been initialized");
    if (!this.initializedNotification && name !== "live_status") return error(id, -32002, "Server has not received initialized notification");
    this.noteToolListChanged();
    if (!this.toolCallable(name)) return this.toolGateError(id, name);
    try {
      const execute = async (operationSignal: AbortSignal | undefined = signal): Promise<JsonObject | null> => {
      const signal = operationSignal;
      if (signal?.aborted) return null;
      if (name === "live_status") return await this.liveStatusAsync(id);
      if (name === "audio_analyze") return await this.audioAnalyzeAsync(id, toolArguments, signal);
      if (name === "audio_compare_reference") return await this.audioCompareReferenceAsync(id, toolArguments, signal);
      if (name === "audio_diagnose_live_context") return await this.audioDiagnoseLiveContextAsync(id, toolArguments, signal);
      if (name === "live_audio_capture_preview") return await this.liveAudioCapturePreviewAsync(id, toolArguments);
      if (name === "live_audio_capture_apply") return await this.liveAudioCaptureApplyAsync(id, toolArguments, signal);
      if (name === "live_audio_capture_status") return await this.liveAudioCaptureStatusAsync(id, toolArguments);
      if (name === "live_audio_capture_emergency_stop") return await this.liveAudioCaptureEmergencyStopAsync(id, toolArguments);
      if (name === "live_session_structure_preview") return await this.liveSessionStructurePreviewAsync(id, toolArguments);
      if (name === "live_session_structure_apply") return await this.liveSessionStructureApplyAsync(id, toolArguments, signal);
      if (name === "live_object_rename_preview") return await this.liveObjectRenamePreviewAsync(id, toolArguments);
      if (name === "live_object_rename_apply") return await this.liveObjectRenameApplyAsync(id, toolArguments, signal);
      if (name === "live_snapshot") return await this.liveSnapshotAsync(id, toolArguments);
      if (name === "live_discover") return await this.liveDiscoverAsync(id, toolArguments);
      if (name === "live_session_audition_preview") return await this.liveSessionAuditionPreviewAsync(id, toolArguments);
      if (name === "live_session_audition_apply") return await this.liveSessionAuditionApplyAsync(id, toolArguments, signal);
      if (name === "live_session_audition_stop") return await this.liveSessionAuditionStopAsync(id, toolArguments, signal);
      if (name === "live_session_emergency_stop") return await this.liveSessionEmergencyStopAsync(id, toolArguments, signal);
      if (name === "live_transport_preview") return await this.liveTransportPreviewAsync(id, toolArguments);
      if (name === "live_transport_apply") return await this.liveTransportApplyAsync(id, toolArguments, signal);
      if (name === "live_clip_launch_preview") return await this.liveClipLaunchPreviewAsync(id, toolArguments);
      if (name === "live_clip_launch_apply") return await this.liveClipLaunchApplyAsync(id, toolArguments, signal);
      if (name === "live_clip_launch_stop") return await this.liveClipLaunchStopAsync(id, toolArguments, signal);
      if (name === "live_capture_midi_preview") return await this.liveCapturePreviewAsync(id, toolArguments, "capture-midi");
      if (name === "live_capture_midi_apply") return await this.liveCaptureApplyAsync(id, toolArguments, "capture-midi", signal);
      if (name === "live_scene_capture_preview") return await this.liveCapturePreviewAsync(id, toolArguments, "scene-capture");
      if (name === "live_scene_capture_apply") return await this.liveCaptureApplyAsync(id, toolArguments, "scene-capture", signal);
      if (name === "live_note_update_preview") return await this.liveNoteEditPreviewAsync(id, toolArguments, "update");
      if (name === "live_note_update_apply") return await this.liveNoteEditApplyAsync(id, toolArguments, "update", signal);
      if (name === "live_note_delete_preview") return await this.liveNoteEditPreviewAsync(id, toolArguments, "delete");
      if (name === "live_note_delete_apply") return await this.liveNoteEditApplyAsync(id, toolArguments, "delete", signal);
      if (name === "live_clip_duplicate_preview") return await this.liveClipDuplicatePreviewAsync(id, toolArguments);
      if (name === "live_clip_duplicate_apply") return await this.liveClipDuplicateApplyAsync(id, toolArguments, signal);
      if (name === "live_arrangement_clip_preview") return await this.liveArrangementClipPreviewAsync(id, toolArguments);
      if (name === "live_arrangement_clip_apply") return await this.liveArrangementClipApplyAsync(id, toolArguments, signal);
      if (name === "live_clip_move_preview") return await this.liveClipMovePreviewAsync(id, toolArguments);
      if (name === "live_clip_move_apply") return await this.liveClipMoveApplyAsync(id, toolArguments, signal);
      if (name === "live_audio_clip_preview") return await this.liveAudioClipPreviewAsync(id, toolArguments);
      if (name === "live_audio_clip_apply") return await this.liveAudioClipApplyAsync(id, toolArguments, signal);
      if (name === "live_mixer_preview") return await this.liveMixerPreviewAsync(id, toolArguments);
      if (name === "live_mixer_apply") return await this.liveMixerApplyAsync(id, toolArguments, signal);
      if (name === "live_view_preview") return await this.liveViewPreviewAsync(id, toolArguments);
      if (name === "live_view_apply") return await this.liveViewApplyAsync(id, toolArguments, signal);
      if (name === "live_locator_jump_preview") return await this.liveLocatorJumpPreviewAsync(id, toolArguments);
      if (name === "live_locator_jump_apply") return await this.liveLocatorJumpApplyAsync(id, toolArguments, signal);
      if (name === "live_clip_properties_preview") return await this.liveClipPropertiesPreviewAsync(id, toolArguments);
      if (name === "live_clip_properties_apply") return await this.liveClipPropertiesApplyAsync(id, toolArguments, signal);
      if (name === "live_audio_import_preview") return await this.liveAudioImportPreviewAsync(id, toolArguments);
      if (name === "live_audio_import_apply") return await this.liveAudioImportApplyAsync(id, toolArguments, signal);
      if (name === "live_warp_marker_preview") return await this.liveWarpMarkerPreviewAsync(id, toolArguments);
      if (name === "live_warp_marker_apply") return await this.liveWarpMarkerApplyAsync(id, toolArguments, signal);
      if (name === "live_clip_action_preview") return await this.liveClipActionPreviewAsync(id, toolArguments);
      if (name === "live_clip_action_apply") return await this.liveClipActionApplyAsync(id, toolArguments, signal);
      if (name === "live_note_edit_preview") return await this.liveNoteTargetPreviewAsync(id, toolArguments);
      if (name === "live_note_edit_apply") return await this.liveNoteTargetApplyAsync(id, toolArguments, signal);
      if (name === "live_note_read") return await this.liveNoteReadAsync(id, toolArguments);
      if (name === "live_key_estimate") return await this.liveKeyEstimateAsync(id, toolArguments);
      if (name === "live_tuning_preview") return await this.liveTuningPreviewAsync(id, toolArguments);
      if (name === "live_tuning_apply") return await this.liveTuningApplyAsync(id, toolArguments, signal);
      if (name === "live_groove_preview") return await this.liveGroovePreviewAsync(id, toolArguments);
      if (name === "live_groove_apply") return await this.liveGrooveApplyAsync(id, toolArguments, signal);
      if (name === "live_scene_preview") return await this.liveScenePreviewAsync(id, toolArguments);
      if (name === "live_scene_apply") return await this.liveSceneApplyAsync(id, toolArguments, signal);
      if (name === "live_scene_fire_preview") return await this.liveSceneFirePreviewAsync(id, toolArguments);
      if (name === "live_scene_fire_apply") return await this.liveSceneFireApplyAsync(id, toolArguments, signal);
      if (name === "live_song_state") return await this.liveSongStateAsync(id, toolArguments);
      if (name === "live_song_settings_preview") return await this.liveSongSettingsPreviewAsync(id, toolArguments);
      if (name === "live_song_settings_apply") return await this.liveSongSettingsApplyAsync(id, toolArguments, signal);
      if (name === "live_transport_action_preview") return await this.liveTransportActionPreviewAsync(id, toolArguments);
      if (name === "live_transport_action_apply") return await this.liveTransportActionApplyAsync(id, toolArguments, signal);
      if (name === "live_track_structure_preview") return await this.liveTrackStructurePreviewAsync(id, toolArguments);
      if (name === "live_track_structure_apply") return await this.liveTrackStructureApplyAsync(id, toolArguments, signal);
      if (name === "live_device_delete_preview") return await this.liveDeviceDeletePreviewAsync(id, toolArguments);
      if (name === "live_device_delete_apply") return await this.liveDeviceDeleteApplyAsync(id, toolArguments, signal);
      if (name === "live_track_view_preview") return await this.liveTrackViewPreviewAsync(id, toolArguments);
      if (name === "live_track_view_apply") return await this.liveTrackViewApplyAsync(id, toolArguments, signal);
      if (name === "live_track_properties_preview") return await this.liveTrackPropertiesPreviewAsync(id, toolArguments);
      if (name === "live_track_properties_apply") return await this.liveTrackPropertiesApplyAsync(id, toolArguments, signal);
      if (name === "live_selection_preview") return await this.liveSelectionPreviewAsync(id, toolArguments);
      if (name === "live_selection_apply") return await this.liveSelectionApplyAsync(id, toolArguments, signal);
      if (name === "live_clip_view_preview") return await this.liveClipViewPreviewAsync(id, toolArguments);
      if (name === "live_clip_view_apply") return await this.liveClipViewApplyAsync(id, toolArguments, signal);
      if (name === "live_device_view_preview") return await this.liveDeviceViewPreviewAsync(id, toolArguments);
      if (name === "live_device_view_apply") return await this.liveDeviceViewApplyAsync(id, toolArguments, signal);
      if (name === "live_performance_read") return await this.livePerformanceReadAsync(id, toolArguments);
      if (name === "live_mixer_extended_preview") return await this.liveMixerExtendedPreviewAsync(id, toolArguments);
      if (name === "live_mixer_extended_apply") return await this.liveMixerExtendedApplyAsync(id, toolArguments, signal);
      if (name === "live_chain_mixer_preview") return await this.liveChainMixerPreviewAsync(id, toolArguments);
      if (name === "live_chain_mixer_apply") return await this.liveChainMixerApplyAsync(id, toolArguments, signal);
      if (name === "live_device_io_preview") return await this.liveDeviceIoPreviewAsync(id, toolArguments);
      if (name === "live_device_io_apply") return await this.liveDeviceIoApplyAsync(id, toolArguments, signal);
      if (name === "live_device_advanced_preview") return await this.liveDeviceAdvancedPreviewAsync(id, toolArguments);
      if (name === "live_device_advanced_apply") return await this.liveDeviceAdvancedApplyAsync(id, toolArguments, signal);
      if (name === "live_chain_preview") return await this.liveChainPreviewAsync(id, toolArguments);
      if (name === "live_chain_apply") return await this.liveChainApplyAsync(id, toolArguments, signal);
      if (name === "live_drum_pad_preview") return await this.liveDrumPadPreviewAsync(id, toolArguments);
      if (name === "live_drum_pad_apply") return await this.liveDrumPadApplyAsync(id, toolArguments, signal);
      if (name === "live_rack_preview") return await this.liveRackPreviewAsync(id, toolArguments);
      if (name === "live_rack_apply") return await this.liveRackApplyAsync(id, toolArguments, signal);
      if (name === "live_rack_view_preview") return await this.liveRackViewPreviewAsync(id, toolArguments);
      if (name === "live_rack_view_apply") return await this.liveRackViewApplyAsync(id, toolArguments, signal);
      if (name === "live_device_specialized_preview") return await this.liveDeviceSpecializedPreviewAsync(id, toolArguments);
      if (name === "live_device_specialized_apply") return await this.liveDeviceSpecializedApplyAsync(id, toolArguments, signal);
      if (name === "live_looper_preview") return await this.liveLooperPreviewAsync(id, toolArguments);
      if (name === "live_looper_apply") return await this.liveLooperApplyAsync(id, toolArguments, signal);
      if (name === "live_simpler_preview") return await this.liveSimplerPreviewAsync(id, toolArguments);
      if (name === "live_simpler_apply") return await this.liveSimplerApplyAsync(id, toolArguments, signal);
      if (name === "live_observe_subscribe") return await this.liveObserveSubscribeAsync(id, toolArguments);
      if (name === "live_observe_poll") return await this.liveObservePollAsync(id, toolArguments);
      if (name === "live_observe_unsubscribe") return await this.liveObserveUnsubscribeAsync(id, toolArguments);
      if (name === "live_browser_roots") return await this.liveBrowserRootsAsync(id, toolArguments);
      if (name === "live_browser_inspect") return await this.liveBrowserInspectAsync(id, toolArguments);
      if (name === "live_arrangement_automation_read") return await this.liveArrangementAutomationReadAsync(id, toolArguments);
      if (name === "live_take_lane_read") return await this.liveTakeLaneReadAsync(id, toolArguments);
      if (name === "live_comp_read") return await this.liveCompReadAsync(id, toolArguments);
      if (name === "live_warp_marker_read") return await this.liveWarpMarkerReadAsync(id, toolArguments);
      if (name === "live_application_dialog_preview") return await this.liveApplicationDialogPreviewAsync(id, toolArguments);
      if (name === "live_application_dialog_apply") return await this.liveApplicationDialogApplyAsync(id, toolArguments, signal);
      if (name === "live_automation_preview") return await this.liveAutomationPreviewAsync(id, toolArguments);
      if (name === "live_automation_apply") return await this.liveAutomationApplyAsync(id, toolArguments, signal);
      if (name === "live_browser_search") return await this.liveBrowserSearchAsync(id, toolArguments);
      if (name === "live_browser_load_preview") return await this.liveBrowserLoadPreviewAsync(id, toolArguments);
      if (name === "live_browser_load_apply") return await this.liveBrowserLoadApplyAsync(id, toolArguments, signal);
      if (name === "live_device_preview") return await this.liveDevicePreviewAsync(id, toolArguments);
      if (name === "live_device_apply") return await this.liveDeviceApplyAsync(id, toolArguments, signal);
      if (name === "live_routing_preview") return await this.liveRoutingPreviewAsync(id, toolArguments);
      if (name === "live_routing_apply") return await this.liveRoutingApplyAsync(id, toolArguments, signal);
      if (name === "live_recording_preview") return await this.liveRecordingPreviewAsync(id, toolArguments);
      if (name === "live_recording_apply") return await this.liveRecordingApplyAsync(id, toolArguments, signal);
      if (name === "live_subscribe") return await this.liveSubscribeAsync(id, toolArguments);
      if (name === "live_unsubscribe") return await this.liveUnsubscribeAsync(id, toolArguments);
      if (name === "live_project_info") return await this.liveProjectInfoAsync(id, toolArguments);
      if (name === "live_project_snapshot_export") return await this.liveProjectSnapshotExportAsync(id, toolArguments);
      if (name === "live_project_snapshot_diff") return this.liveProjectSnapshotDiff(id, toolArguments);
      if (name === "als_read") return this.alsRead(id, toolArguments);
      if (name === "als_lint") return this.alsLint(id, toolArguments);
      if (name === "als_diff") return this.alsDiff(id, toolArguments);
      if (name === "live_project_backup_preview") return await this.liveProjectBackupPreviewAsync(id, toolArguments);
      if (name === "live_project_backup_apply") return await this.liveProjectBackupApplyAsync(id, toolArguments, signal);
      if (name === "live_realtime_arm_preview") return await this.liveRealtimeArmPreviewAsync(id, toolArguments);
      if (name === "live_realtime_arm_apply") return await this.liveRealtimeArmApplyAsync(id, toolArguments, signal);
      if (name === "live_realtime_disarm") return await this.liveRealtimeDisarmAsync(id, toolArguments);
      if (name === "live_realtime_stats") return await this.liveRealtimeStatsAsync(id, toolArguments);
      if (name === "live_device_parameter_preview") return await this.liveDeviceParameterPreviewAsync(id, toolArguments);
      if (name === "live_device_parameter_apply") return await this.liveDeviceParameterApplyAsync(id, toolArguments, signal);
      if (name === "live_midi_clip_preview") return await this.liveMidiPreviewAsync(id, toolArguments);
      if (name === "live_midi_clip_apply") return await this.liveMidiApplyAsync(id, toolArguments, signal);
      if (name === "live_midi_transform_preview") return await this.liveMidiTransformPreviewAsync(id, toolArguments);
      if (name === "live_midi_transform_apply") return await this.liveMidiTransformApplyAsync(id, toolArguments, signal);
      if (name === "live_arrangement_section_preview") return await this.liveArrangementPreviewAsync(id, toolArguments);
      if (name === "live_arrangement_section_apply") return await this.liveArrangementApplyAsync(id, toolArguments, signal);
      if (name === "live_tempo_preview") return await this.liveTempoPreviewAsync(id, toolArguments);
      if (name === "live_tempo_apply") return await this.liveTempoApplyAsync(id, toolArguments, signal);
      if (name === "live_recovery_finalize") return await this.liveRecoveryFinalizeAsync(id, toolArguments);
      const result = await this.liveUndoAsync(id, toolArguments, signal);
      return signal?.aborted ? null : result;
      };
      return await this.singleFlightMutation(name, id, toolArguments, execute, signal);
    } catch (cause) { return this.adapterToolError(id, cause, "The asynchronous Live operation failed; inspect authoritative state before retrying."); }
  }

  private base64FloatCount(value: unknown): number | null {
    if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
    let contentLength = value.length;
    let paddingLength = 0;
    const paddingStart = value.indexOf("=");
    if (paddingStart >= 0) {
      const padding = value.slice(paddingStart);
      if ((padding !== "=" && padding !== "==") || paddingStart < 2) return null;
      contentLength = paddingStart;
      paddingLength = padding.length;
    }
    for (let index = 0; index < contentLength; index += 1) {
      const code = value.charCodeAt(index);
      if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) return null;
    }
    const bytes = value.length / 4 * 3 - paddingLength;
    return Number.isSafeInteger(bytes) && bytes > 0 && bytes % 4 === 0 ? bytes / 4 : null;
  }

  private encodedAnalysisSource(value: unknown, maxChannels: number, allowFrameSize: boolean): { source: EncodedAnalysisSource; sampleCount: number } | undefined {
    if (!isObject(value) || !hasOnly(value, allowFrameSize ? ["pcmBase64", "sampleRate", "channels", "channelLayout", "frameSize"] : ["pcmBase64", "sampleRate", "channels", "channelLayout"])) return undefined;
    const sampleCount = this.base64FloatCount(value.pcmBase64);
    const channels = value.channels === undefined ? 1 : value.channels;
    if (sampleCount === null || !isIntegerInRange(value.sampleRate, 8_000, 384_000) || !isIntegerInRange(channels, 1, maxChannels) || sampleCount % channels !== 0) return undefined;
    if (allowFrameSize && value.frameSize !== undefined && !isIntegerInRange(value.frameSize, 256, 4_096)) return undefined;
    const allowedLabels = new Set(["M", "L", "R", "C", "Ls", "Rs", "LFE"]);
    let channelLayout: ConventionalChannelLabel[] | undefined;
    if (value.channelLayout !== undefined) {
      if (!Array.isArray(value.channelLayout) || value.channelLayout.length !== channels || new Set(value.channelLayout).size !== value.channelLayout.length || value.channelLayout.some((item) => typeof item !== "string" || !allowedLabels.has(item))) return undefined;
      channelLayout = value.channelLayout as ConventionalChannelLabel[];
    }
    return {
      sampleCount,
      source: {
        pcmBase64: value.pcmBase64 as string,
        sampleRate: value.sampleRate as number,
        ...(value.channels === undefined ? {} : { channels }),
        ...(channelLayout ? { channelLayout } : {}),
        ...(allowFrameSize && value.frameSize !== undefined ? { frameSize: value.frameSize as number } : {}),
      },
    };
  }

  private consumeAnalysisRateLimit(): boolean {
    const now = Date.now();
    while (this.toolCallTimes.length > 0 && now - (this.toolCallTimes[0] ?? now) >= 60_000) this.toolCallTimes.shift();
    if (this.toolCallTimes.length >= MAX_TOOL_CALLS_PER_MINUTE) return false;
    this.toolCallTimes.push(now);
    return true;
  }

  private async audioAnalyzeAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    const parsed = this.encodedAnalysisSource(params, 32, true);
    if (!parsed || parsed.sampleCount > 10_000_000) return error(id, -32602, "audio_analyze requires bounded normalized float32 pcmBase64, sampleRate, and matching channel metadata");
    if (!this.consumeAnalysisRateLimit()) return error(id, -32029, "Tool invocation rate limit exceeded");
    try {
      const result = await this.analysisRunner.run({ mode: "analyze", source: parsed.source }, signal);
      if (signal?.aborted) return null;
      return response(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
    } catch (cause) {
      if (signal?.aborted) return null;
      const message = cause instanceof Error ? cause.message : "analysis job failed";
      return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: message, remediation: "Provide bounded little-endian float32 PCM normalized to [-1, 1], or retry after the isolated worker queue clears." }) }], isError: true });
    }
  }

  private async audioCompareReferenceAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["project", "reference", "alignment"])) return error(id, -32602, "audio_compare_reference requires project and reference PCM sources");
    const project = this.encodedAnalysisSource(params.project, 2, false);
    const reference = this.encodedAnalysisSource(params.reference, 2, false);
    if (!project || !reference || project.source.sampleRate < 32_000 || project.source.sampleRate > 96_000 || reference.source.sampleRate < 32_000 || reference.source.sampleRate > 96_000 || project.sampleCount + reference.sampleCount > 4_000_000) return error(id, -32602, "audio comparison sources must use the validated 32000-96000 Hz range and fit the 4000000-sample pair limit");
    let alignment: { mode?: "auto" | "manual" | "disabled"; maxLagSeconds?: number; manualOffsetSeconds?: number } | undefined;
    if (params.alignment !== undefined) {
      if (!isObject(params.alignment) || !hasOnly(params.alignment, ["mode", "maxLagSeconds", "manualOffsetSeconds"]) || (params.alignment.mode !== undefined && !["auto", "manual", "disabled"].includes(String(params.alignment.mode))) || (params.alignment.maxLagSeconds !== undefined && (typeof params.alignment.maxLagSeconds !== "number" || !Number.isFinite(params.alignment.maxLagSeconds) || params.alignment.maxLagSeconds < 0 || params.alignment.maxLagSeconds > 10)) || (params.alignment.manualOffsetSeconds !== undefined && (typeof params.alignment.manualOffsetSeconds !== "number" || !Number.isFinite(params.alignment.manualOffsetSeconds) || Math.abs(params.alignment.manualOffsetSeconds) > 10))) return error(id, -32602, "audio comparison alignment is invalid");
      alignment = params.alignment as typeof alignment;
    }
    if (!this.consumeAnalysisRateLimit()) return error(id, -32029, "Tool invocation rate limit exceeded");
    try {
      const result = await this.analysisRunner.run({ mode: "compare", project: project.source, reference: reference.source, ...(alignment ? { alignment } : {}) }, signal);
      if (signal?.aborted) return null;
      return response(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
    } catch (cause) {
      if (signal?.aborted) return null;
      const message = cause instanceof Error ? cause.message : "reference comparison failed";
      return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: message, remediation: "Use bounded PCM sources, explicit manual alignment for ambiguous material, or retry after the isolated worker queue clears." }) }], isError: true });
    }
  }

  private encodeFloat32Le(samples: Float32Array): string {
    const bytes = Buffer.allocUnsafe(samples.length * 4);
    for (let index = 0; index < samples.length; index += 1) bytes.writeFloatLE(samples[index] ?? 0, index * 4);
    return bytes.toString("base64");
  }

  private waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("operation cancelled"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
      const abort = (): void => { clearTimeout(timer); reject(new Error("operation cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private captureStatusRedacted(status: JsonObject): JsonObject {
    const clip = isObject(status.clip) ? status.clip : undefined;
    return {
      ...status,
      recoveryToken: undefined,
      ...(clip ? { clip: { ref: clip.ref, name: clip.name, length: clip.length, isAudio: clip.isAudio, fileAvailable: typeof clip.filePath === "string" && clip.filePath.length > 0 } } : {}),
    };
  }

  private requireCaptureCapability(status: LiveStatus, recoveryOnly = false): void {
    const required = recoveryOnly
      ? ["audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"]
      : ["audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"];
    if (!status.connected || status.epoch === null || status.provenance !== "real-live" || (!recoveryOnly && !(status.capabilities ?? []).includes("audio.capture.resampling")) || required.some((operation) => !(status.operations ?? []).includes(operation))) throw new Error("verified real-Live resampling capture capability is unavailable");
  }

  private async audioDiagnoseLiveContextAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["pcmBase64", "sampleRate", "channels", "channelLayout", "trackRef", "provenance"]) || !isNonEmptyString(params.trackRef, 256) || !isObject(params.provenance) || !hasOnly(params.provenance, ["observedAt", "description"]) || !isNonEmptyString(params.provenance.observedAt, 128) || !isNonEmptyString(params.provenance.description, 512)) return error(id, -32602, "bounded PCM, trackRef, and explicit source provenance are required");
    const parsed = this.encodedAnalysisSource({ pcmBase64: params.pcmBase64, sampleRate: params.sampleRate, ...(params.channels === undefined ? {} : { channels: params.channels }), ...(params.channelLayout === undefined ? {} : { channelLayout: params.channelLayout }) }, 2, false);
    if (!parsed || parsed.sampleCount > 4_000_000) return error(id, -32602, "diagnosis PCM metadata is invalid or exceeds the bounded source limit");
    if (!this.consumeAnalysisRateLimit()) return error(id, -32029, "Tool invocation rate limit exceeded");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || status.epoch === null || !(status.capabilities ?? []).includes("session.read")) throw new Error("fresh Live context is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync({ signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const analysis = await this.analysisRunner.run({ mode: "analyze", source: parsed.source }, signal) as PcmAnalysis;
      if (signal?.aborted) return null;
      const diagnosis = diagnoseAudioWithLiveContext(analysis, snapshot, status.epoch, params.trackRef as LiveRef, { kind: "caller-supplied-pcm", observedAt: params.provenance.observedAt, description: params.provenance.description });
      return this.successText(id, { analysis, diagnosis });
    } catch (cause) {
      if (signal?.aborted) return null;
      return this.adapterToolError(id, cause, "Audio was not attributed to Live; refresh the exact track context and source provenance before retrying.");
    }
  }

  private async liveAudioCapturePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["setName", "sourceSlotRef", "destinationSlotRef", "durationSeconds", "consent", "outputSafety"]) || !isNonEmptyString(params.setName, 256) || !isNonEmptyString(params.sourceSlotRef, 256) || !isNonEmptyString(params.destinationSlotRef, 256) || typeof params.durationSeconds !== "number" || !Number.isFinite(params.durationSeconds) || params.durationSeconds < 1 || params.durationSeconds > 9 || params.consent !== "ephemeral-analysis-and-delete") return error(id, -32602, "exact Set/slots, 1-9 second duration, consent, and output safety are required");
    try {
      this.validateOutputSafety(params.outputSafety);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      this.requireCaptureCapability(status);
      const adapter = this.asyncAdapter();
      const plan = await adapter.invokeAsync({ operation: "audio.capture.inspect", args: { setName: params.setName, sourceSlotRef: params.sourceSlotRef, destinationSlotRef: params.destinationSlotRef } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as JsonObject;
      if (plan.supported !== true || !isNonEmptyString(plan.fence, 64) || !isNonEmptyString(plan.destinationTrackRef, 256) || !isObject(plan.prior)) throw new Error("capture mapper did not return a complete authoritative plan");
      const transaction: AudioCaptureTransaction = {
        id: `audio_capture_${randomBytes(18).toString("base64url")}`,
        captureId: `capture_${randomBytes(18).toString("base64url")}`,
        epoch: status.epoch!,
        setName: params.setName,
        sourceSlotRef: params.sourceSlotRef as LiveRef,
        destinationSlotRef: params.destinationSlotRef as LiveRef,
        destinationTrackRef: plan.destinationTrackRef as LiveRef,
        fence: plan.fence,
        prior: structuredClone(plan.prior),
        durationMs: Math.round(params.durationSeconds * 1_000),
        outputSafety: structuredClone(params.outputSafety as JsonObject),
        confirmation: randomBytes(32).toString("base64url"),
        expiresAt: Date.now() + 60_000,
        state: "previewed",
      };
      this.retainBoundedTransaction(this.audioCaptureTransactions, transaction, "audio capture");
      return this.successText(id, { transactionId: transaction.id, captureId: transaction.captureId, epoch: transaction.epoch, sourceSlotRef: transaction.sourceSlotRef, destinationSlotRef: transaction.destinationSlotRef, destinationTrackRef: transaction.destinationTrackRef, captureMode: plan.captureMode, prior: transaction.prior, durationSeconds: transaction.durationMs / 1_000, consent: params.consent, rawRetention: "ephemeral-until-analysis-then-unlink", outputSafety: transaction.outputSafety, audibleImpact: "plays-one-exact-session-clip-while-recording-one-exact-resampling-slot", confirmation: transaction.confirmation, expiresAt: transaction.expiresAt, recovery: { watchdog: true, statusTool: "live_audio_capture_status", emergencyTool: "live_audio_capture_emergency_stop" } });
    } catch (cause) { return this.adapterToolError(id, cause, "Capture preview made no changes; choose a real-Live source clip and exact empty audio destination slot in the disposable Set."); }
  }

  private async captureMapperStatus(adapter: AsyncLiveAdapter): Promise<JsonObject> {
    return await adapter.invokeAsync({ operation: "audio.capture.status", args: {} }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as JsonObject;
  }

  private async waitForCapturedMedia(adapter: AsyncLiveAdapter, signal?: AbortSignal, deadline = Date.now() + 5_000): Promise<JsonObject> {
    let status = await this.captureMapperStatus(adapter);
    while (Date.now() < deadline) {
      if (status.state === "failed") throw new Error("capture mapper reported failed cleanup or stop state");
      if (status.playbackStopped === true && isObject(status.clip) && isNonEmptyString(status.clip.ref, 256) && isNonEmptyString(status.clip.filePath, 4_096)) return status;
      await this.waitFor(100, signal);
      status = await this.captureMapperStatus(adapter);
    }
    throw new Error("capture media identity did not become authoritative before the bounded deadline");
  }

  private captureSourceTrack(snapshot: LiveSnapshot, slotRef: LiveRef): LiveRef {
    const track = snapshot.tracks.find((candidate) => (candidate.clipSlots ?? []).some((slot) => slot.ref === slotRef));
    if (!track) throw new Error("capture source slot is absent from the fresh diagnosis snapshot");
    return track.ref;
  }

  private async recoverAudioCapture(transaction: AudioCaptureTransaction, acquired?: DecodedCaptureFile): Promise<{ safe: boolean; residual: string[] }> {
    const residual: string[] = [];
    let media = acquired;
    let rawConfirmedAbsent = false;
    const includeMapperResidual = (status: JsonObject, prefix: string): void => {
      if (Array.isArray(status.residual)) for (const item of status.residual) if (typeof item === "string" && item) residual.push(`${prefix}:${item}`);
    };
    try {
      const adapter = this.asyncAdapter();
      let status = await this.captureMapperStatus(adapter);
      if (status.state === "idle") {
        if (transaction.startDispatched || transaction.mapperToken || media) residual.push("capture-lifecycle-is-not-observable");
        return { safe: residual.length === 0, residual: [...new Set(residual)] };
      }
      // Never inspect, acquire, clean, or unlink a different lifecycle merely
      // because it happens to be the mapper's current captured state.
      if (status.captureId !== transaction.captureId || status.sourceSlotRef !== transaction.sourceSlotRef || status.destinationSlotRef !== transaction.destinationSlotRef) {
        residual.push("foreign-capture-lifecycle-observed");
        return { safe: false, residual };
      }
      includeMapperResidual(status, "mapper");
      if (status.active === true || status.playbackStopped !== true || status.state === "active" || status.state === "failed") {
        try {
          await adapter.invokeAsync({ operation: "audio.capture.emergency-stop", args: { captureId: transaction.captureId, sourceSlotRef: transaction.sourceSlotRef, destinationSlotRef: transaction.destinationSlotRef } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
        } catch { residual.push("capture-emergency-stop-unverified"); }
        status = await this.captureMapperStatus(adapter);
        if (status.captureId !== transaction.captureId) {
          residual.push("capture-identity-changed-during-recovery");
          return { safe: false, residual: [...new Set(residual)] };
        }
        const stopDeadline = Date.now() + 5_000;
        while ((status.active === true || status.playbackStopped !== true) && Date.now() < stopDeadline) {
          await this.waitFor(100);
          status = await this.captureMapperStatus(adapter);
          if (status.captureId !== transaction.captureId) break;
        }
        includeMapperResidual(status, "mapper-after-stop");
      }
      if (status.active === true || status.playbackStopped !== true) residual.push("capture-playback-not-stopped");
      if ((status.state === "stopped" || status.state === "captured" || status.state === "failed") && !isObject(status.clip)) {
        const expiresAt = typeof status.expiresAt === "number" ? status.expiresAt : Date.now();
        const finalizationDeadline = Math.min(Date.now() + 12_000, Math.max(Date.now() + 5_000, expiresAt + 2_000));
        try { status = await this.waitForCapturedMedia(adapter, undefined, finalizationDeadline); }
        catch { residual.push("capture-media-finalization-unresolved"); status = await this.captureMapperStatus(adapter); }
      }
      if (status.captureId !== transaction.captureId) {
        residual.push("capture-identity-changed-before-cleanup");
        return { safe: false, residual: [...new Set(residual)] };
      }
      const clip = isObject(status.clip) ? status.clip : undefined;
      const token = transaction.mapperToken ?? (typeof status.recoveryToken === "string" ? status.recoveryToken : undefined);
      if (!media && clip && isNonEmptyString(clip.filePath, 4_096)) {
        try {
          const snapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
          if (typeof snapshot.set.filePath === "string" && snapshot.set.filePath) {
            transaction.projectFilePath = snapshot.set.filePath;
            media = await decodeOwnedWaveFile(clip.filePath, snapshot.set.filePath, transaction.startedAt ?? Date.now());
          }
          else residual.push("saved-project-path-unavailable");
        } catch {
          try {
            const snapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
            if (typeof snapshot.set.filePath === "string" && snapshot.set.filePath.length > 0) transaction.projectFilePath = snapshot.set.filePath;
            rawConfirmedAbsent = typeof snapshot.set.filePath === "string" && snapshot.set.filePath.length > 0 && await captureMediaIsAbsent(clip.filePath as string, snapshot.set.filePath);
            if (!rawConfirmedAbsent) residual.push("raw-media-could-not-be-verified-for-unlink");
          } catch { residual.push("raw-media-could-not-be-verified-for-unlink"); }
        }
      }
      // Remove verified raw media before deleting Live's only authoritative
      // clip/path record. A crash can therefore never leave raw media after
      // mapper cleanup with no recovery identity.
      const cleanedMedia = media;
      let rawCleanupSafe = rawConfirmedAbsent || transaction.rawPrimaryUnlinked === true || (!media && status.state === "cleaned");
      if (media && !transaction.rawPrimaryUnlinked) {
        try { await unlinkOwnedCaptureFile(media); transaction.rawPrimaryUnlinked = true; rawCleanupSafe = true; }
        catch { residual.push("transaction-owned-raw-file-not-unlinked"); }
      }
      let liveCleanupSafe = status.state === "cleaned";
      if (clip && isNonEmptyString(clip.ref, 256) && token && rawCleanupSafe) {
        try {
          const cleaned = await adapter.invokeAsync({ operation: "audio.capture.cleanup", args: { captureId: transaction.captureId, token, expectedClipRef: clip.ref } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as JsonObject;
          includeMapperResidual(cleaned, "mapper-cleanup");
          liveCleanupSafe = true;
        } catch { residual.push("transaction-owned-live-clip-not-cleaned"); }
      } else if (status.state !== "cleaned") residual.push(!rawCleanupSafe ? "capture-live-clip-retained-for-raw-recovery" : clip ? "capture-cleanup-authority-unavailable" : "capture-live-clip-state-unresolved");
      if (cleanedMedia && liveCleanupSafe && transaction.projectFilePath) {
        try {
          await unlinkLateCaptureCompanions(cleanedMedia);
          if (!await captureMediaIsAbsent(cleanedMedia.realPath, transaction.projectFilePath)) throw new Error("capture media remains after late companion sweep");
          media = undefined;
        } catch { residual.push("late-capture-companion-not-cleaned"); }
      }
      const finalStatus = await this.captureMapperStatus(adapter);
      if (finalStatus.captureId !== transaction.captureId) residual.push("capture-final-identity-mismatch");
      includeMapperResidual(finalStatus, "mapper-final");
      if (finalStatus.active === true || finalStatus.playbackStopped !== true) residual.push("capture-remains-active");
      if (finalStatus.state !== "cleaned") residual.push("capture-lifecycle-not-cleaned");
      if (isObject(finalStatus.clip)) residual.push("capture-clip-remains-present");

      try {
        const snapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
        const transport = snapshot.playback.transport;
        if (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || snapshot.playback.firedTargets.length > 0 || snapshot.playback.playingTargets.length > 0) residual.push("fresh-playback-readback-not-stopped");
        const destinationTrackRef = isNonEmptyString(finalStatus.destinationTrackRef, 256) ? finalStatus.destinationTrackRef : transaction.destinationTrackRef;
        const destination = snapshot.tracks.find((track) => track.ref === destinationTrackRef || (track.clipSlots ?? []).some((slot) => slot.ref === transaction.destinationSlotRef));
        const destinationSlot = destination?.clipSlots?.find((slot) => slot.ref === transaction.destinationSlotRef);
        if (!destination || !destinationSlot || destinationSlot.empty !== true || destinationSlot.clipRef) residual.push("fresh-destination-slot-not-empty");
        if (destination && transaction.prior.arm !== undefined && destination.armed !== transaction.prior.arm) residual.push("fresh-destination-arm-not-restored");
        if (destination && transaction.prior.monitoring !== undefined && destination.monitoringState !== transaction.prior.monitoring) residual.push("fresh-destination-monitoring-not-restored");
        if (destination && transaction.prior.route !== undefined && destination.routing?.inputType !== transaction.prior.route) residual.push("fresh-destination-route-not-restored");
        if (destination && transaction.prior.arm === undefined && destination.armed !== false) residual.push("fresh-destination-remains-armed");
      } catch { residual.push("fresh-recovery-snapshot-unavailable"); }
    } catch { residual.push("capture-emergency-recovery-unavailable"); }
    return { safe: residual.length === 0, residual: [...new Set(residual)] };
  }

  private async awaitAudioCaptureApply(id: RequestId, transaction: AudioCaptureTransaction, signal?: AbortSignal): Promise<JsonObject | null> {
    const inflight = transaction.inflight;
    if (!inflight) return this.transactionError(id, "Audio-capture apply is no longer in flight");
    transaction.waiters = (transaction.waiters ?? 0) + 1;
    let callerAborted = signal?.aborted === true;
    let removeAbort: (() => void) | undefined;
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      if (callerAborted) { resolve({ kind: "aborted" }); return; }
      if (signal) {
        const listener = (): void => { callerAborted = true; resolve({ kind: "aborted" }); };
        signal.addEventListener("abort", listener, { once: true });
        removeAbort = () => signal.removeEventListener("abort", listener);
      }
    });
    try {
      const settled = await Promise.race([inflight.then((value) => ({ kind: "settled" as const, value })), aborted]);
      if (settled.kind === "aborted") return null;
      return settled.value === null ? null : { ...settled.value, id };
    } finally {
      removeAbort?.();
      transaction.waiters = Math.max(0, (transaction.waiters ?? 1) - 1);
      // A caller cancellation suppresses only that caller's response. Shared
      // capture is cancelled when no idempotent waiter remains.
      if (callerAborted && transaction.waiters === 0) transaction.abortController?.abort();
    }
  }

  private async liveAudioCaptureApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isIdempotencyKey(params.idempotencyKey)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
    const transaction = this.audioCaptureTransactions.get(params.transactionId);
    if (!transaction) return this.transactionError(id, "Unknown or expired audio-capture transaction");
    if (params.confirmation !== transaction.confirmation) return this.transactionError(id, "Audio-capture confirmation is invalid");
    if (transaction.state === "completed" && transaction.applyKey === params.idempotencyKey && transaction.result) return this.successText(id, { ...transaction.result, idempotent: true });
    if (transaction.inflight) {
      if (transaction.applyKey !== params.idempotencyKey) return this.transactionError(id, "Audio-capture apply is already in progress with a different idempotency key");
      return this.awaitAudioCaptureApply(id, transaction, signal);
    }
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Audio-capture preview expired or is no longer applicable");
    if (signal?.aborted) return null;
    transaction.applyKey = params.idempotencyKey;
    transaction.state = "applying";
    transaction.abortController = new AbortController();
    const inflight = this.dispatchAudioCaptureApply(id, transaction, transaction.abortController.signal);
    transaction.inflight = inflight;
    void inflight.finally(() => {
      if (transaction.inflight === inflight) transaction.inflight = undefined;
      transaction.abortController = undefined;
    });
    return this.awaitAudioCaptureApply(id, transaction, signal);
  }

  private async dispatchAudioCaptureApply(id: RequestId, transaction: AudioCaptureTransaction, signal?: AbortSignal): Promise<JsonObject | null> {
    let acquired: DecodedCaptureFile | undefined;
    try {
      this.validateOutputSafety(transaction.outputSafety);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      this.requireCaptureCapability(status);
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; capture must be previewed again");
      const adapter = this.asyncAdapter();
      if (signal?.aborted) throw new Error("audio capture cancelled before audible dispatch");
      transaction.startedAt = Date.now();
      transaction.startDispatched = true;
      const started = await adapter.invokeAsync({ operation: "audio.capture.start", args: { captureId: transaction.captureId, setName: transaction.setName, sourceSlotRef: transaction.sourceSlotRef, destinationSlotRef: transaction.destinationSlotRef, fence: transaction.fence, maxDurationMs: Math.min(10_000, transaction.durationMs + 3_000), outputSafety: transaction.outputSafety } }, { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id }) as JsonObject;
      if (!isNonEmptyString(started.token, 128) || started.state !== "active") throw new Error("capture mapper did not confirm bounded authority");
      transaction.mapperToken = started.token;
      transaction.state = "capturing";
      await this.waitFor(transaction.durationMs, signal);
      await adapter.invokeAsync({ operation: "audio.capture.stop", args: { captureId: transaction.captureId, token: transaction.mapperToken } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id });
      const captureStatus = await this.waitForCapturedMedia(adapter, signal);
      if (Array.isArray(captureStatus.residual) && captureStatus.residual.length > 0) throw new Error("capture mapper reported residual state");
      const clip = captureStatus.clip as JsonObject;
      const snapshot = await adapter.snapshotAsync({ signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id });
      if (typeof snapshot.set.filePath !== "string" || !snapshot.set.filePath) throw new Error("capture requires an authoritatively saved Live Set path");
      transaction.projectFilePath = snapshot.set.filePath;
      acquired = await decodeOwnedWaveFile(clip.filePath as string, snapshot.set.filePath, transaction.startedAt);
      transaction.state = "analyzing";
      const source: EncodedAnalysisSource = { pcmBase64: this.encodeFloat32Le(acquired.samples), sampleRate: acquired.sampleRate, channels: acquired.channels, channelLayout: acquired.channels === 1 ? ["M"] : ["L", "R"] };
      const analysis = await this.analysisRunner.run({ mode: "analyze", source }, signal) as PcmAnalysis;
      const sourceTrackRef = this.captureSourceTrack(snapshot, transaction.sourceSlotRef);
      const diagnosis: AudioDiagnosis = diagnoseAudioWithLiveContext(analysis, snapshot, transaction.epoch, sourceTrackRef, { kind: "verified-live-resampling-capture", observedAt: new Date().toISOString(), description: "Mapper-owned Session-slot Resampling capture", captureId: transaction.captureId });
      const mediaSummary = { format: acquired.format, bitsPerSample: acquired.bitsPerSample, sampleRate: acquired.sampleRate, channels: acquired.channels, durationSeconds: acquired.durationSeconds, byteLength: acquired.byteLength, byteLengthBounded: true, rawPathReturned: false };
      // Keep the mapper-owned clip/path as recovery authority until the
      // descriptor-fenced raw media has been quarantined and unlinked.
      await unlinkOwnedCaptureFile(acquired);
      transaction.rawPrimaryUnlinked = true;
      await adapter.invokeAsync({ operation: "audio.capture.cleanup", args: { captureId: transaction.captureId, token: transaction.mapperToken, expectedClipRef: clip.ref } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id });
      await unlinkLateCaptureCompanions(acquired);
      if (!await captureMediaIsAbsent(acquired.realPath, transaction.projectFilePath)) throw new Error("capture media did not verify absent after Live clip cleanup");
      acquired = undefined;
      const finalStatus = await this.captureMapperStatus(adapter);
      const finalSnapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const transport = finalSnapshot.playback.transport;
      const destination = finalSnapshot.tracks.find((track) => track.ref === transaction.destinationTrackRef);
      if (finalStatus.state !== "cleaned" || finalStatus.active !== false || transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || !destination || destination.armed !== transaction.prior.arm || destination.monitoringState !== transaction.prior.monitoring || destination.routing?.inputType !== transaction.prior.route) throw new Error("capture teardown did not verify the exact stopped baseline");
      const result: JsonObject = {
        transactionId: transaction.id,
        captureId: transaction.captureId,
        state: "completed",
        provenance: "real-live",
        sourceSlotRef: transaction.sourceSlotRef,
        destinationSlotRef: transaction.destinationSlotRef,
        durationRequestedSeconds: transaction.durationMs / 1_000,
        media: mediaSummary,
        analysis,
        diagnosis,
        cleanup: { captureStopped: true, transportStopped: true, routingRestored: true, armRestored: true, monitoringRestored: true, liveClipDeleted: true, rawFileUnlinked: true, rawAudioRetained: false },
        idempotent: false,
      };
      transaction.result = result;
      transaction.state = "completed";
      return this.successText(id, result);
    } catch (cause) {
      const recovery = await this.recoverAudioCapture(transaction, acquired);
      transaction.state = signal?.aborted && recovery.safe ? "cancelled" : "uncertain";
      if (signal?.aborted) return null;
      // Filesystem/native adapter errors can embed absolute media paths. Keep
      // the MCP failure stable and path-free; detailed diagnostics stay on the
      // redacted stderr/operator boundary.
      const failureClass = cause instanceof RangeError ? "bounded-input-or-media-validation" : "capture-lifecycle-failure";
      return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: "capture lifecycle did not reach a verified clean completion", failureClass, captureId: transaction.captureId, state: transaction.state, cleanup: recovery, remediation: recovery.safe ? "Preview again from fresh stopped state." : "Use live_audio_capture_status and the independent emergency-stop tool; do not retry capture while residual state remains." }) }], isError: true });
    }
  }

  private async liveAudioCaptureStatusAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.utilityParams(params)) return error(id, -32602, "capture status takes no arguments");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      this.requireCaptureCapability(status, true);
      const capture = await this.captureMapperStatus(this.asyncAdapter());
      return this.successText(id, this.captureStatusRedacted(capture));
    } catch (cause) { return this.adapterToolError(id, cause, "Capture status is unavailable; independently verify Live recording, transport, arm, monitoring, and routing state."); }
  }

  private async liveAudioCaptureEmergencyStopAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["confirmation", "captureId", "sourceSlotRef", "destinationSlotRef"]) || params.confirmation !== "emergency-stop-and-clean" || !isNonEmptyString(params.captureId, 128) || !isNonEmptyString(params.sourceSlotRef, 256) || !isNonEmptyString(params.destinationSlotRef, 256)) return error(id, -32602, "exact fresh capture identities and confirmation are required");
    const synthetic: AudioCaptureTransaction = { id: `recovery_${params.captureId}`, captureId: params.captureId, epoch: 0, setName: "recovery", sourceSlotRef: params.sourceSlotRef as LiveRef, destinationSlotRef: params.destinationSlotRef as LiveRef, destinationTrackRef: params.destinationSlotRef as LiveRef, fence: "", prior: {}, durationMs: 0, outputSafety: {}, confirmation: "", expiresAt: Date.now() + 10_000, state: "uncertain" };
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }); this.requireCaptureCapability(status, true);
      const observed = await this.captureMapperStatus(this.asyncAdapter());
      if (observed.captureId !== params.captureId || observed.sourceSlotRef !== params.sourceSlotRef || observed.destinationSlotRef !== params.destinationSlotRef) throw new Error("capture emergency observation is stale or inexact");
      synthetic.epoch = status.epoch!; synthetic.startedAt = typeof observed.startedAt === "number" ? observed.startedAt : Date.now(); synthetic.mapperToken = typeof observed.recoveryToken === "string" ? observed.recoveryToken : undefined;
      const recovery = await this.recoverAudioCapture(synthetic);
      return this.successText(id, { captureId: params.captureId, state: recovery.safe ? "cleaned" : "uncertain", stopped: true, cleanup: recovery, rawPathReturned: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Emergency capture cleanup is uncertain; manually stop Live and inspect the exact destination slot and project media."); }
  }

  private asyncAdapter(): AsyncLiveAdapter {
    const value = this.adapter as Partial<AsyncLiveAdapter>;
    if (typeof value.snapshotAsync !== "function" || typeof value.discoverAsync !== "function" || typeof value.getAsync !== "function" || typeof value.invokeAsync !== "function") throw new Error("live adapter does not support asynchronous operations");
    return this.adapter as AsyncLiveAdapter;
  }

  /** Status fresh at call time; operation/capability gates must not rely on a
   * connect-time advertisement after the Live shape may have changed. */
  private async freshStatus(context?: { deadlineMs?: number }): Promise<LiveStatus> {
    const adapter = this.adapter as Partial<AsyncLiveAdapter & { refreshStatusAsync?: (context?: { deadlineMs?: number }) => Promise<LiveStatus> }>;
    if (typeof adapter.refreshStatusAsync !== "function") return this.adapter.status();
    const refreshed = await adapter.refreshStatusAsync(context);
    // A refresh can change the negotiated operation/capability set; announce
    // the effective discovery change immediately rather than on a later call.
    this.noteToolListChanged();
    return refreshed;
  }

  private validateStructureItems(params: unknown): { tracks: SessionStructureItem[]; scenes: SessionStructureItem[] } | undefined {
    if (!isObject(params) || !hasOnly(params, ["tracks", "scenes"]) || !Array.isArray(params.tracks) || !Array.isArray(params.scenes) || params.tracks.length > 16 || params.scenes.length > 32) return undefined;
    const names = new Set<string>();
    const parse = (items: unknown[], kind: "track" | "scene"): SessionStructureItem[] | undefined => {
      const result: SessionStructureItem[] = [];
      for (const [position, item] of items.entries()) {
        if (!isObject(item) || !hasOnly(item, kind === "track" ? ["name", "kind", "index"] : ["name", "index"]) || !isNonEmptyString(item.name, 128) || names.has(item.name)) return undefined;
        names.add(item.name);
        if (kind === "track" && item.kind !== "audio" && item.kind !== "midi") return undefined;
        const index = item.index === undefined ? position : item.index;
        if (!isIntegerInRange(index, 0, kind === "track" ? 1024 : 1024)) return undefined;
        result.push({ kind, name: item.name, ...(kind === "track" ? { trackKind: item.kind as "audio" | "midi" } : {}), index });
      }
      return result;
    };
    const tracks = parse(params.tracks, "track"); const scenes = parse(params.scenes, "scene");
    return tracks && scenes ? { tracks, scenes } : undefined;
  }

  private structureRevision(snapshot: LiveSnapshot): string {
    const identity = { tracks: snapshot.tracks.map((item, index) => [item.ref, item.objectIdentity, item.name, item.kind, index]), scenes: snapshot.scenes.map((item, index) => [item.ref, item.objectIdentity, item.name, index]) };
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }

  private sessionStructureOwnedRow(snapshot: LiveSnapshot, item: NonNullable<SessionStructureTransaction["created"]>[number]): LiveSnapshot["tracks"][number] | LiveSnapshot["scenes"][number] | undefined {
    const rows = item.kind === "track" ? snapshot.tracks : snapshot.scenes;
    const matches = rows.filter((row) => row.objectIdentity === item.objectIdentity);
    if (matches.length > 1) throw new Error("transaction-owned Session structure identity is ambiguous");
    if (matches[0] && matches[0].ref !== item.ref) throw new Error("transaction-owned Session structure shifted from its exact reference");
    return matches[0];
  }

  private sessionStructureCreatedFingerprint(snapshot: LiveSnapshot, kind: "track" | "scene", reference: LiveRef): string {
    if (kind === "track") { const track = snapshot.tracks.find((row) => row.ref === reference); if (!track) throw new Error("created track fingerprint is unavailable"); const ownedTrack = { ...track, clipSlots: (track.clipSlots ?? []).filter((slot) => slot.empty !== true || slot.clipRef != null) }; const arrangementClips = (snapshot.arrangement.clips ?? []).filter((clip) => clip.trackRef === reference || clip.parentRef === reference); return this.captureObjectFingerprint({ track: ownedTrack, arrangementClips }); }
    const scene = snapshot.scenes.find((row) => row.ref === reference); if (!scene) throw new Error("created scene fingerprint is unavailable"); const sceneRow = scene as unknown as JsonObject; const sceneIdentity = { ref: scene.ref, parentRef: sceneRow.parentRef ?? null, objectIdentity: scene.objectIdentity ?? null, name: scene.name, triggerable: sceneRow.triggerable ?? null };
    const contents = snapshot.tracks.map((track) => { const slot = track.clipSlots?.find((row) => row.sceneIndex === scene.index); const clip = slot?.clipRef ? track.clips.find((row) => row.ref === slot.clipRef) : undefined; const slotRow = slot as unknown as JsonObject | undefined; const ownedSlot = slot ? { ref: slot.ref, parentRef: slot.parentRef ?? null, trackRef: slotRow?.trackRef ?? null, objectIdentity: slot.objectIdentity ?? null, clipRef: slot.clipRef ?? null, empty: slot.empty } : null; return { trackRef: track.ref, trackIdentity: track.objectIdentity ?? null, slot: ownedSlot, clip: clip ?? null }; });
    return this.captureObjectFingerprint({ scene: sceneIdentity, contents });
  }

  private async liveSessionStructurePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const proposed = this.validateStructureItems(params);
    if (!proposed) return error(id, -32602, "tracks and scenes must contain bounded, unique, valid entries");
    try {
      const status = this.requireConnected("session.structure"); const snapshot = await this.asyncAdapter().snapshotAsync();
      const existingNames = new Set([...snapshot.tracks.map((item) => item.name), ...snapshot.scenes.map((item) => item.name)]);
      if ([...proposed.tracks, ...proposed.scenes].some((item) => existingNames.has(item.name))) throw new Error("track or scene name already exists");
      const regularTracks = snapshot.tracks.filter((item) => !["return", "main", "master"].includes(item.kind));
      let availableTrackIndex = regularTracks.length;
      for (const item of proposed.tracks) { if (item.index > availableTrackIndex) return error(id, -32602, "track index exceeds the current regular-track collection"); availableTrackIndex += 1; }
      let availableSceneIndex = snapshot.scenes.length;
      for (const item of proposed.scenes) { if (item.index > availableSceneIndex) return error(id, -32602, "scene index exceeds the current scene collection"); availableSceneIndex += 1; }
      const transaction: SessionStructureTransaction = {
        id: `structure_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: this.structureRevision(snapshot),
        proposed: [...proposed.tracks, ...proposed.scenes], priorTracks: regularTracks.map((item, index) => ({ ref: item.ref, name: item.name, kind: item.kind, index })),
        priorScenes: snapshot.scenes.map((item, index) => ({ ref: item.ref, name: item.name, index })), expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed",
      };
      this.sessionStructureTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior: { tracks: transaction.priorTracks, scenes: transaction.priorScenes }, proposed: transaction.proposed, impact: "creates-session-structure", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Session structure preview failed without mutation; discover current names and ordering."); }
  }

  private async compensateSessionStructureAsync(transaction: SessionStructureTransaction, adapter: AsyncLiveAdapter, context: LiveOperationContext): Promise<void> {
    const created = transaction.created ?? []; transaction.compensationSteps ??=[]; transaction.recoveryMode = "compensate";
    const boundedContext = (): LiveOperationContext => ({ ...context, deadlineMs: Date.now() + STRUCTURE_STEP_DEADLINE_MS });
    for (let index = 0; index < [...created].reverse().length; index += 1) { const item = [...created].reverse()[index]!; let step = transaction.compensationSteps[index];
      if (!step) { const snapshot = await adapter.snapshotAsync(boundedContext()); const row = this.sessionStructureOwnedRow(snapshot, item); if (!row) continue; if (this.sessionStructureCreatedFingerprint(snapshot, item.kind, item.ref) !== item.fingerprint) throw new Error("transaction-owned Session structure changed before compensation"); step = { operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision: this.structureRevision(snapshot), expectedObjectIdentity: item.objectIdentity }, completed: false }; transaction.compensationSteps[index] = step; }
      if (!step.completed) { await adapter.invokeAsync({ operation: step.operation, args: step.args }, boundedContext()); step.completed = true; }
    }
    const after = await adapter.snapshotAsync(boundedContext()); if (created.some((item) => this.sessionStructureOwnedRow(after, item) !== undefined)) throw new Error("Session-structure compensation left transaction-owned objects");
  }

  private async liveSessionStructureApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.sessionStructureTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Session-structure transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if ((transaction.state !== "previewed" && !reconciliation) || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Session-structure preview expired or is no longer applicable");
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.structure"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = (): LiveOperationContext => ({ signal, deadlineMs: Date.now() + STRUCTURE_STEP_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string });
      if (reconciliation && transaction.recoveryMode === "compensate") { try { await this.compensateSessionStructureAsync(transaction, adapter, context()); transaction.state = "undone"; return this.successText(id, { transactionId: transaction.id, state: "compensated", residuals: [], idempotent: false }); } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Session-structure compensation remains uncertain; inspect authoritative structure."); } }
      const current = await adapter.snapshotAsync(context());
      if (!reconciliation && this.structureRevision(current) !== transaction.revision) return this.transactionError(id, "Session structure changed since preview");
      const created: NonNullable<SessionStructureTransaction["created"]> = transaction.created ? [...transaction.created] : []; let dispatchAmbiguous = false;
      transaction.recoverySteps ??= []; transaction.recoveryMode = "apply"; transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      try {
        for (let stepIndex = 0; stepIndex < transaction.proposed.length; stepIndex += 1) {
          const item = transaction.proposed[stepIndex]!; const operation = item.kind === "track" ? "track.create" : "scene.create";
          let step = transaction.recoverySteps[stepIndex];
          if (!step) { const expectedStructureRevision = this.structureRevision(await adapter.snapshotAsync(context())); step = { operation, args: { name: item.name, ...(item.kind === "track" ? { kind: item.trackKind } : {}), index: item.index, expectedStructureRevision } }; transaction.recoverySteps[stepIndex] = step; }
          let result = step.result;
          if (!result) { dispatchAmbiguous = true; result = await adapter.invokeAsync({ operation: step.operation, args: step.args }, context()) as { ref: LiveRef; objectIdentity: string; name: string; index: number; createdFingerprint: string }; dispatchAmbiguous = false; }
          if (!result?.ref || typeof result.objectIdentity !== "string" || !isNonEmptyString(result.createdFingerprint, 64)) throw new Error(`Live did not return atomic created ${item.kind} ownership evidence`);
          step.result = { ref: result.ref, objectIdentity: result.objectIdentity, name: result.name, index: result.index ?? item.index, createdFingerprint: result.createdFingerprint };
          if (!created.some((entry) => entry.ref === result.ref)) created.push({ ref: result.ref, objectIdentity: result.objectIdentity, kind: item.kind, name: result.name, index: result.index ?? item.index, fingerprint: result.createdFingerprint });
          transaction.created = created; const owned = created.find((entry) => entry.ref === result!.ref)!; const observed = await adapter.snapshotAsync(context()); const row = owned.kind === "track" ? observed.tracks.find((candidate) => candidate.ref === owned.ref) : observed.scenes.find((candidate) => candidate.ref === owned.ref); if (!row || row.objectIdentity !== owned.objectIdentity || this.sessionStructureCreatedFingerprint(observed, owned.kind, owned.ref) !== owned.fingerprint) throw new Error("created Session structure changed after atomic creation");
          if (result.name !== item.name) throw new Error(`Live did not confirm created ${item.kind}`);
        }
        const verified = await adapter.snapshotAsync(context());
        if (!created.every((item) => (item.kind === "track" ? verified.tracks.some((track) => track.ref === item.ref && track.objectIdentity === item.objectIdentity && track.name === item.name) : verified.scenes.some((scene) => scene.ref === item.ref && scene.objectIdentity === item.objectIdentity && scene.name === item.name)) && this.sessionStructureCreatedFingerprint(verified, item.kind, item.ref) === item.fingerprint)) throw new Error("Live did not confirm unchanged atomically owned Session structure");
      } catch (cause) {
        if (dispatchAmbiguous) { transaction.created = created; transaction.recoveryMode = "apply"; throw cause; }
        transaction.created = created;
        try { await this.compensateSessionStructureAsync(transaction, adapter, context()); transaction.state = "undone"; }
        catch { transaction.state = "uncertain"; transaction.recoveryMode = "compensate"; throw new Error("Session-structure apply compensation failed; retry the exact key to reconcile cleanup"); }
        throw cause;
      }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { if (transaction.state === "applying") transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Session-structure apply is uncertain; read authoritative tracks and scenes before retrying."); }
  }

  private takeLaneRow(snapshot: LiveSnapshot, reference: LiveRef): { track: Track; lane: TakeLane } {
    for (const track of snapshot.tracks) {
      const lane = (track.takeLanes ?? []).find((candidate: TakeLane) => candidate.ref === reference);
      if (lane) return { track, lane };
    }
    throw new Error("take-lane reference is unknown");
  }

  private renameAuthorityRevision(snapshot: LiveSnapshot, kind: string, reference: LiveRef): string {
    if (kind === "track" || kind === "scene") return this.structureRevision(snapshot);
    if (kind === "locator") return this.locatorRevision(snapshot);
    if (kind === "takeLane") { const located = this.takeLaneRow(snapshot, reference); const siblings = located.track.takeLanes!.map((lane) => ({ ref: lane.ref, objectIdentity: lane.objectIdentity, name: lane.name })); return createHash("sha256").update(canonicalMutationIdentity(siblings)).digest("hex"); }
    if (kind === "clip") return createHash("sha256").update(canonicalMutationIdentity(this.clipAuthority(snapshot, reference))).digest("hex");
    if (kind === "device") { const row = this.deviceRow(snapshot, reference); return createHash("sha256").update(canonicalMutationIdentity({ ref: row.device.ref, objectIdentity: row.device.objectIdentity, trackRef: row.track.ref, trackIdentity: row.track.objectIdentity, ownerRef: row.ownerRef, ownerIdentity: row.ownerIdentity, siblings: row.siblings })).digest("hex"); }
    throw new Error("rename authority kind is unsupported");
  }

  private async liveObjectRenamePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const kinds = ["track", "scene", "clip", "device", "locator", "takeLane"] as const;
    if (!isObject(params) || !hasOnly(params, ["kind", "ref", "name"]) || !kinds.includes(params.kind as typeof kinds[number]) || !isNonEmptyString(params.ref, 256) || !isNonEmptyString(params.name, 256)) return error(id, -32602, "kind, ref, and a non-empty name are required");
    try {
      const status = this.requireConnected("session.read"); const operation = (params.kind === "takeLane" ? "take-lane.rename" : `${params.kind}.rename`) as LiveInvocation["operation"];
      if (!status.operations?.includes(operation)) throw new Error(`${operation} is unavailable on this Live shape`);
      const adapter = this.asyncAdapter(); const snapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (params.kind === "track" && !snapshot.tracks.some((track) => track.ref === params.ref)) throw new Error("track rename is limited to regular Set tracks");
      const current = await adapter.getAsync(params.ref as LiveRef, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { ref?: unknown; objectIdentity?: unknown; name?: unknown } | undefined;
      if (!current || current.ref !== params.ref || !isNonEmptyString(current.objectIdentity, 256) || typeof current.name !== "string") throw new Error("rename target lacks exact authoritative object identity");
      if (current.name === params.name) throw new Error("rename would not change the target");
      const transaction: ClipLifecycleTransaction = { id: `rename_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "rename", fence: JSON.stringify({ ref: params.ref, objectIdentity: current.objectIdentity, name: current.name, kind: params.kind }), clipRef: params.ref as LiveRef, payload: { kind: params.kind, name: params.name, expectedAuthorityRevision: this.renameAuthorityRevision(snapshot, params.kind as string, params.ref as LiveRef) }, prior: { name: current.name, objectIdentity: current.objectIdentity }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "rename");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, target: { kind: params.kind, ref: params.ref, objectIdentity: current.objectIdentity, currentName: current.name }, proposedName: params.name, impact: "renames-one-live-object", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Rename preview failed without mutation; rediscover the exact target."); }
  }

  private async liveObjectRenameApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "rename" || !transaction.clipRef || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired rename transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", name: transaction.payload.name, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state === "uncertain" && !reconciliation) return this.transactionError(id, "Uncertain rename apply requires the exact original idempotency key");
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Rename transaction is no longer applicable");
    try {
      const status = reconciliation ? await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) : this.requireConnected("session.read"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const current = await adapter.getAsync(transaction.clipRef, context) as { ref?: unknown; objectIdentity?: unknown; name?: unknown } | undefined;
      const exactIdentity = current?.ref === transaction.clipRef && current?.objectIdentity === transaction.prior?.objectIdentity;
      const priorState = exactIdentity && current?.name === transaction.prior?.name; const appliedState = exactIdentity && current?.name === transaction.payload.name;
      if ((!reconciliation && JSON.stringify({ ref: current?.ref, objectIdentity: current?.objectIdentity, name: current?.name, kind: transaction.payload.kind }) !== transaction.fence) || (reconciliation && !priorState && !appliedState)) return this.transactionError(id, "Rename target identity or name conflicts with the retained transaction");
      transaction.applyKey = params.idempotencyKey as string;
      const operation = (transaction.payload.kind === "takeLane" ? "take-lane.rename" : `${transaction.payload.kind}.rename`) as LiveInvocation["operation"];
      transaction.state = "applying";
      await adapter.invokeAsync({ operation, args: { ref: transaction.clipRef, name: transaction.payload.name, expectedName: transaction.prior?.name, expectedObjectIdentity: transaction.prior?.objectIdentity, expectedAuthorityRevision: transaction.payload.expectedAuthorityRevision } }, context);
      const verified = await adapter.getAsync(transaction.clipRef, context) as { objectIdentity?: unknown; name?: unknown } | undefined;
      if (!verified || verified.objectIdentity !== transaction.prior?.objectIdentity || verified.name !== transaction.payload.name) throw new Error("rename postcondition was not confirmed for the exact target");
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", ref: transaction.clipRef, name: verified.name, ...(reconciliation ? { reconciled: true } : {}), idempotent: false });
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); if (transaction.state === "applying") { const safelyCancelled = !reconciliation && /cancelled before dispatch/.test(message); transaction.state = safelyCancelled ? "previewed" : "uncertain"; if (safelyCancelled) delete transaction.applyKey; } return this.adapterToolError(id, cause, "Rename state may be uncertain; reconcile with the exact original key after fresh discovery."); }
  }

  private async liveSnapshotAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid live_snapshot parameters");
    const status = this.requireConnected("session.read");
    return this.successText(id, { epoch: status.epoch, snapshot: await this.asyncAdapter().snapshotAsync() });
  }

  private async liveDiscoverAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const kinds = ["set", "track", "return-track", "main-track", "scene", "clip-slot", "session-clip", "arrangement-clip", "note", "locator", "device", "parameter", "selection", "routing-choice", "session-playback"] as const;
    if (!isObject(params) || !hasOnly(params, ["kind", "parent", "filter", "fields", "budget", "limit", "cursor"]) || !kinds.includes(params.kind as typeof kinds[number]) || (["clip-slot", "session-clip", "arrangement-clip", "note", "device", "parameter", "routing-choice"].includes(String(params.kind)) && !isNonEmptyString(params.parent, 256)) || (params.parent !== undefined && !isNonEmptyString(params.parent, 256)) || (params.filter !== undefined && !isDiscoveryFilter(params.filter)) || (params.fields !== undefined && (!Array.isArray(params.fields) || params.fields.length > 32 || params.fields.some((field) => !isNonEmptyString(field, 64)))) || (params.budget !== undefined && !isIntegerInRange(params.budget, 1, 10_000)) || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 100)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 1024))) return error(id, -32602, "kind, parent, filter, fields, budget, limit, and cursor are invalid");
    return this.successText(id, await this.asyncAdapter().discoverAsync({ kind: params.kind as import("./live.js").LiveDiscoveryKind, parent: params.parent as string | undefined, filter: params.filter as Record<string, unknown> | undefined, fields: params.fields as string[] | undefined, budget: (params.budget as number | undefined) ?? 1000, limit: (params.limit as number | undefined) ?? 50, cursor: params.cursor as string | undefined }));
  }

  private auditionAuthorityRevision(snapshot: LiveSnapshot, sceneRef: LiveRef, eligibleTargetKeys: string[]): string {
    const scene = snapshot.scenes.find((item) => item.ref === sceneRef); if (!scene) throw new Error("audition scene is not authoritative");
    const targets = [...eligibleTargetKeys].sort().map((key) => {
      const [trackRef, slotRef, expectedSceneRef] = key.split("|"); const track = snapshot.tracks.find((item) => item.ref === trackRef); const slot = track?.clipSlots?.find((item) => item.ref === slotRef); const clip = slot?.clipRef ? track?.clips.find((item) => item.ref === slot.clipRef) : undefined;
      if (!track || !slot || !clip || expectedSceneRef !== sceneRef) throw new Error("audition target hierarchy is incomplete");
      return { trackRef: track.ref, trackIdentity: track.objectIdentity, slotRef: slot.ref, slotIdentity: slot.objectIdentity, sceneRef: scene.ref, sceneIdentity: scene.objectIdentity, clipRef: clip.ref, clipIdentity: clip.objectIdentity };
    });
    return createHash("sha256").update(canonicalMutationIdentity({ set: { ref: snapshot.set.ref, objectIdentity: snapshot.set.objectIdentity }, scene: { ref: scene.ref, objectIdentity: scene.objectIdentity, index: scene.index }, targets })).digest("hex");
  }

  private auditionSnapshot(snapshot: LiveSnapshot, sceneRef: LiveRef): { set: JsonObject; scene: JsonObject; tracks: JsonObject[]; playback: LiveSnapshot["playback"]; playbackRevision: string; eligibleTargetKeys: string[] } {
    const set = snapshot.set as unknown as JsonObject;
    const scene = snapshot.scenes.find((item) => item.ref === sceneRef) as unknown as JsonObject | undefined;
    if (!scene || !Number.isInteger(scene.index)) throw new Error("audition scene is not authoritative");
    const tracks = snapshot.tracks as unknown as JsonObject[];
    const playback = snapshot.playback;
    if (!playback || !Array.isArray(playback.firedTargets) || !Array.isArray(playback.playingTargets)) throw new Error("authoritative Session playback is unavailable");
    const eligibleTargetKeys = tracks.flatMap((track) => Array.isArray(track.clipSlots) ? (track.clipSlots as unknown[]).filter(isObject).filter((slot) => slot.sceneIndex === scene.index && typeof slot.ref === "string" && typeof track.ref === "string" && typeof slot.clipRef === "string").map((slot) => `${track.ref}|${slot.ref}|${sceneRef}`) : []);
    if (eligibleTargetKeys.some((key) => key.split("|").length !== 3)) throw new Error("audition references are not encodable as target keys");
    const playbackRevision = JSON.stringify({ playback, tracks: tracks.map((track) => ({ ref: track.ref, armed: track.armed, monitoringState: track.monitoringState, playingSlotIndex: track.playingSlotIndex, firedSlotIndex: track.firedSlotIndex })), scenes: snapshot.scenes });
    return { set, scene, tracks, playback, playbackRevision, eligibleTargetKeys };
  }

  private validateAuditionSafety(status: LiveStatus, set: JsonObject, tracks: JsonObject[], playback: LiveSnapshot["playback"], outputSafety: unknown, setName: string): void {
    if (!isObject(outputSafety) || !hasOnly(outputSafety, ["safe", "provenance", "observedAt", "scope"]) || outputSafety.safe !== true || !isNonEmptyString(outputSafety.provenance, 512) || outputSafety.provenance === "unknown" || outputSafety.provenance === "simulator") throw new Error("explicit authoritative output-safety evidence is required");
    if (set.name !== setName) throw new Error("disposable Set identity does not match authoritative state");
    const transport = playback.transport;
    if (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false) throw new Error("audition requires stopped, non-recording authoritative playback state");
    if (!transport.launchQuantization.normalized || ["none", "unknown", "free"].includes(transport.launchQuantization.normalized)) throw new Error("launch quantization is unsafe or unknown");
    if (tracks.some((track) => MONITORABLE_TRACK_KINDS.has(String(track.kind)) ? (track.armed !== false || !["off", "auto"].includes(String(track.monitoringState))) : (track.armed === true || track.monitoringState === "in"))) throw new Error("armed, input-monitored, or unknown-monitoring target prevents audition");
    if (playback.firedTargets.length > 0 || playback.playingTargets.length > 0) throw new Error("existing Session playback prevents audition");
    const operations = status.operations ?? [];
    if (!(operations.includes("session.audition-launch") && operations.includes("session.audition-stop") && operations.includes("session.emergency-stop") && operations.includes("session.playback"))) throw new Error("required guarded audition, emergency stop, and playback inspection operations are unavailable");
  }

  private async liveSessionAuditionPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["sceneRef", "setName", "outputSafety"]) || !isNonEmptyString(params.sceneRef, 256) || !isNonEmptyString(params.setName, 256) || !isObject(params.outputSafety)) return error(id, -32602, "sceneRef, setName, and outputSafety are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const state = this.auditionSnapshot(snapshot, params.sceneRef as LiveRef);
      this.validateAuditionSafety(status, state.set, state.tracks, state.playback, params.outputSafety, params.setName);
      if (state.eligibleTargetKeys.length === 0) throw new Error("audition scene has no authoritative playable clip slots");
      if (!isNonEmptyString(state.set.objectIdentity, 256)) throw new Error("disposable Set identity is unavailable");
      const transaction: SessionAuditionTransaction = { id: `audition_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, sceneRef: params.sceneRef as LiveRef, sceneRevision: JSON.stringify(state.scene), playbackRevision: state.playbackRevision, eligibleTargetKeys: state.eligibleTargetKeys, authorityRevision: this.auditionAuthorityRevision(snapshot, params.sceneRef as LiveRef, state.eligibleTargetKeys), setName: params.setName, setIdentity: state.set.objectIdentity as string, outputSafety: structuredClone(params.outputSafety as JsonObject), confirmation: randomBytes(32).toString("base64url"), stopConfirmation: randomBytes(32).toString("base64url"), expiresAt: Date.now() + AUDITION_TTL_MS, state: "previewed" };
      this.retainAuditionTransaction(transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, scene: state.scene, sceneRevision: transaction.sceneRevision, playbackRevision: transaction.playbackRevision, eligibleTargets: transaction.eligibleTargetKeys, disposableSet: { expected: transaction.setName, observed: state.set.name, matches: true }, baseline: { stopped: true, arrangementRecord: false, sessionRecord: false }, launchQuantization: state.playback.transport.launchQuantization, outputSafety: transaction.outputSafety, audibleImpact: "potentially-audible-session-scene-launch", confirmation: transaction.confirmation, stopConfirmation: transaction.stopConfirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Audition preview refused; obtain fresh authoritative discovery and explicit output-safety evidence."); }
  }

  private retainAuditionTransaction(transaction: SessionAuditionTransaction): void {
    const now = Date.now();
    for (const [key, candidate] of this.auditionTransactions) if (candidate.expiresAt <= now && !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(key)) this.auditionTransactions.delete(key);
    while (this.auditionTransactions.size >= MAX_AUDITION_TRANSACTIONS) {
      const oldest = [...this.auditionTransactions].find(([candidateKey, candidate]) => !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(candidateKey));
      if (!oldest) throw new Error("audition transaction capacity is exhausted by in-flight auditions");
      this.auditionTransactions.delete(oldest[0]);
    }
    this.auditionTransactions.set(transaction.id, transaction);
  }

  private async liveSessionAuditionApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isIdempotencyKey(params.idempotencyKey)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
    const transaction = this.auditionTransactions.get(params.transactionId as string);
    if (!transaction || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired audition transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation) return this.successText(id, { transactionId: transaction.id, state: "applied", launched: transaction.launched, stopConfirmation: transaction.stopConfirmation, idempotent: true });
    if (transaction.state === "applying") {
      if (transaction.applyKey !== params.idempotencyKey || transaction.confirmation !== params.confirmation || !transaction.inflight) return this.transactionError(id, "Audition apply is already in progress with a different request");
      try {
        const outcome = await transaction.inflight;
        return this.successText(id, { ...outcome, idempotent: true });
      } catch (cause) {
        return this.auditionApplyError(id, cause, transaction);
      }
    }
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation;
    if ((transaction.state !== "previewed" && !reconciliation) || transaction.confirmation !== params.confirmation) return this.transactionError(id, "Exact audition confirmation is required");
    if (signal?.aborted) return null;
    // Reserve the transaction synchronously before any await so a concurrent
    // duplicate cannot observe "previewed" and dispatch a second launch.
    transaction.state = "applying";
    transaction.applyKey = params.idempotencyKey as string;
    const inflight = this.dispatchAuditionApply(transaction, signal, reconciliation);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.auditionApplyError(id, cause, transaction);
    }
  }

  private auditionApplyError(id: RequestId, cause: unknown, transaction: SessionAuditionTransaction): JsonObject {
    return this.adapterToolError(id, cause, transaction.state === "previewed" ? "Audition apply failed before dispatch; the preview remains available until expiry." : "Audition state is uncertain; do not retry. Perform fresh playback discovery before stopping or recovering.");
  }

  private async dispatchAuditionApply(transaction: SessionAuditionTransaction, signal?: AbortSignal, reconciliation = false): Promise<JsonObject> {
    // A reconciled transaction may have dispatched previously, so its
    // pre-dispatch failures must preserve uncertain rather than restore the
    // preview (mirroring the capture apply path).
    let dispatched = reconciliation;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id };
      const before = await adapter.snapshotAsync(context); const state = this.auditionSnapshot(before, transaction.sceneRef);
      // Reconciliation after a real acknowledgement loss: if every active
      // target belongs to this transaction (matching scene, subset of the
      // eligible targets), the unacked launch did dispatch — reconcile to
      // applied without re-dispatching (the mapper execution ledger makes
      // replay safe), mirroring the clip-launch precedent.
      const activeTargets = [...state.playback.firedTargets, ...state.playback.playingTargets];
      if (reconciliation && activeTargets.length > 0) {
        if (activeTargets.some((target) => target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("external playback appeared during audition reconciliation");
        transaction.launched = { launched: transaction.sceneRef, targets: activeTargets };
        transaction.state = "applied";
        return { transactionId: transaction.id, state: "applied", launched: transaction.launched, verified: { sceneRef: transaction.sceneRef, firedOrPlaying: true }, stopConfirmation: transaction.stopConfirmation, reconciled: true };
      }
      // The authority fence, safety evidence, and all dynamic preconditions are
      // rechecked host-side immediately before the single potentially audible
      // dispatch on both the initial and the reconciliation path.
      if (JSON.stringify(state.scene) !== transaction.sceneRevision || state.playbackRevision !== transaction.playbackRevision || state.set.objectIdentity !== transaction.setIdentity || this.auditionAuthorityRevision(before, transaction.sceneRef, transaction.eligibleTargetKeys) !== transaction.authorityRevision) throw new Error("audition state or identity hierarchy changed since preview");
      this.validateAuditionSafety(status, state.set, state.tracks, state.playback, transaction.outputSafety, transaction.setName);
      const scene = state.scene; const playbackRevision = state.playback.revision;
      if (signal?.aborted) throw new Error("audition apply cancelled before dispatch");
      dispatched = true;
      const result = await adapter.invokeAsync({ operation: "session.audition-launch", args: { ref: transaction.sceneRef, setName: transaction.setName, sceneName: scene.name, sceneIndex: scene.index, playbackRevision, eligibleTargets: transaction.eligibleTargetKeys, expectedSetIdentity: transaction.setIdentity, expectedAuthorityRevision: transaction.authorityRevision, outputSafety: transaction.outputSafety } }, context) as { launched?: unknown; targets?: unknown };
      const targets = Array.isArray(result?.targets) ? result.targets : [];
      if (result?.launched !== transaction.sceneRef || targets.some((target) => !isObject(target) || target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("guarded launch result does not match the audition target");
      transaction.launched = { launched: result.launched, targets };
      // Live applies a scene fire asynchronously at the launch quantization
      // boundary; poll fresh authoritative state for exact fired/playing
      // evidence until the operation deadline.
      let verified = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        const activeTargets = [...after.playback.firedTargets, ...after.playback.playingTargets];
        if (activeTargets.some((target) => target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("external playback appeared during launch verification");
        if (activeTargets.length > 0) { verified = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!verified) throw new Error("scene launch was not confirmed by fresh fired or playing target evidence");
      transaction.state = "applied";
      return { transactionId: transaction.id, state: "applied", launched: transaction.launched, verified: { sceneRef: transaction.sceneRef, firedOrPlaying: true }, stopConfirmation: transaction.stopConfirmation };
    } catch (cause) {
      // A failure proven to be pre-dispatch restores the preview and clears the
      // reserved key; anything else is an explicitly uncertain audible state.
      transaction.state = dispatched ? "uncertain" : "previewed";
      if (!dispatched) delete transaction.applyKey;
      throw cause;
    }
  }

  private async liveSessionAuditionStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isIdempotencyKey(params.idempotencyKey)) return error(id, -32602, "transactionId, exact stop confirmation, and idempotencyKey are required");
    const transaction = this.auditionTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown audition transaction");
    if (transaction.state === "stopped" && transaction.stopKey === params.idempotencyKey && params.confirmation === transaction.stopConfirmation) return this.successText(id, { transactionId: transaction.id, state: "stopped", idempotent: true });
    if (params.confirmation !== transaction.stopConfirmation) return this.transactionError(id, "Exact audition stop confirmation is required");
    if (transaction.state === "stopping") {
      if (transaction.stopKey !== params.idempotencyKey || !transaction.inflight) return this.transactionError(id, "Audition stop is already in progress with a different request");
      try {
        const outcome = await transaction.inflight;
        return this.successText(id, { ...outcome, idempotent: true });
      } catch (cause) {
        return this.adapterToolError(id, cause, "Stop is uncertain; do not retry. Perform fresh authoritative playback discovery.");
      }
    }
    if (!(transaction.state === "applied" || transaction.state === "uncertain")) return this.transactionError(id, "Only mapper-owned applied or uncertain audition playback can be stopped");
    if (transaction.state === "uncertain" && transaction.stopKey !== undefined && transaction.stopKey !== params.idempotencyKey) return this.transactionError(id, "Uncertain audition stop requires the exact original idempotency key");
    if (signal?.aborted) return null;
    const stoppingUncertain = transaction.state === "uncertain";
    transaction.state = "stopping";
    transaction.stopKey = params.idempotencyKey as string;
    const inflight = this.dispatchAuditionStop(transaction, signal, stoppingUncertain);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Stop is uncertain; do not retry. Perform fresh authoritative playback discovery.");
    }
  }

  private async dispatchAuditionStop(transaction: SessionAuditionTransaction, signal?: AbortSignal, stoppingUncertain = false): Promise<JsonObject> {
    let dispatched = false;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; stop refused");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.stopKey, transactionId: transaction.id };
      const beforeSnapshot = await adapter.snapshotAsync(context); const before = this.auditionSnapshot(beforeSnapshot, transaction.sceneRef);
      if (JSON.stringify(before.scene) !== transaction.sceneRevision || before.set.name !== transaction.setName || before.set.objectIdentity !== transaction.setIdentity || this.auditionAuthorityRevision(beforeSnapshot, transaction.sceneRef, transaction.eligibleTargetKeys) !== transaction.authorityRevision || before.playback.transport.arrangementRecord !== false || before.playback.transport.sessionRecord !== false || before.tracks.some((track) => MONITORABLE_TRACK_KINDS.has(String(track.kind)) ? (track.armed !== false || !["off", "auto"].includes(String(track.monitoringState))) : (track.armed === true || track.monitoringState === "in"))) throw new Error("audition ownership or safety state changed; stop refused");
      const activeTargets = [...before.playback.firedTargets, ...before.playback.playingTargets];
      if (activeTargets.length > 0) {
        if (activeTargets.some((target) => target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("owned playback is unknown or external playback is active; global stop refused");
        if (signal?.aborted) throw new Error("audition stop cancelled before dispatch");
        dispatched = true;
        await adapter.invokeAsync({ operation: "session.audition-stop", args: { ref: transaction.sceneRef, setName: transaction.setName, eligibleTargets: transaction.eligibleTargetKeys, expectedSetIdentity: transaction.setIdentity, expectedAuthorityRevision: transaction.authorityRevision } }, context);
      }
      // Stop state also propagates asynchronously; poll fresh authoritative
      // reads until the transport and every slot is verifiably stopped.
      let confirmed = false;
      while (Date.now() < context.deadlineMs - 250) {
        const state = await adapter.snapshotAsync(context);
        if (state.playback.transport.playing === false && state.playback.firedTargets.length === 0 && state.playback.playingTargets.length === 0) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error("stop acknowledged without fresh stopped verification");
      transaction.state = "stopped";
      return { transactionId: transaction.id, state: "stopped", restoredBaseline: true };
    } catch (cause) {
      // A stop that never dispatched proves nothing about Live changed: keep an
      // uncertain record uncertain; only an applied record returns to applied.
      transaction.state = dispatched || stoppingUncertain ? "uncertain" : "applied";
      throw cause;
    }
  }

  private async liveSessionEmergencyStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["confirmation", "expectedTargets", "expectedRecording", "idempotencyKey"]) || params.confirmation !== "emergency-stop" || !["stopped", "session", "arrangement", "both"].includes(String(params.expectedRecording)) || !Array.isArray(params.expectedTargets) || params.expectedTargets.length > 256 || new Set(params.expectedTargets).size !== params.expectedTargets.length || !params.expectedTargets.every((item) => isNonEmptyString(item, 1024)) || (params.idempotencyKey !== undefined && !isIdempotencyKey(params.idempotencyKey))) return error(id, -32602, "confirmation=emergency-stop plus exact freshly observed active playback targets and recording mode are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("session.emergency-stop")) throw new Error("emergency stop operation is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const playback = snapshot.playback;
      if (!playback || !Array.isArray(playback.firedTargets) || !Array.isArray(playback.playingTargets)) throw new Error("authoritative Session playback is unavailable");
      const activeKeys = [...new Set([...playback.firedTargets, ...playback.playingTargets].map((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))].sort();
      const expectedKeys = [...(params.expectedTargets as string[])].sort();
      if (activeKeys.length !== expectedKeys.length || activeKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("expected targets do not match fresh authoritative playback; perform fresh discovery");
      if (signal?.aborted) return null;
      const sessionRecord = playback.transport.sessionRecord === true; const arrangementRecord = playback.transport.arrangementRecord === true;
      const expectedRecording = sessionRecord && arrangementRecord ? "both" : sessionRecord ? "session" : arrangementRecord ? "arrangement" : "stopped";
      if (params.expectedRecording !== expectedRecording) throw new Error("expected recording mode does not match fresh authoritative playback; perform fresh discovery");
      const result = await adapter.invokeAsync({ operation: "session.emergency-stop", args: { expectedTargets: activeKeys, expectedRecording } }, context) as { stopped?: unknown; stoppedTargets?: unknown; recordingStopped?: unknown };
      let confirmed = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        if (after.playback.transport.playing === false && after.playback.transport.sessionRecord === false && after.playback.transport.arrangementRecord === false && after.playback.firedTargets.length === 0 && after.playback.playingTargets.length === 0) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error("emergency stop was not confirmed by fresh authoritative state");
      return this.successText(id, { stopped: true, stoppedTargets: result.stoppedTargets ?? activeKeys, recordingStopped: result.recordingStopped === true });
    } catch (cause) { return this.adapterToolError(id, cause, "Emergency stop is uncertain; perform fresh authoritative playback discovery before any further action."); }
  }

  private static readonly TRANSPORT_FIELDS = ["position", "loopEnabled", "loopStart", "loopLength", "metronome", "punchIn", "punchOut"] as const;

  private async liveTransportPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, [...McpHost.TRANSPORT_FIELDS])) return error(id, -32602, "only bounded transport fields are accepted");
    const proposed: Record<string, number | boolean> = {};
    for (const field of McpHost.TRANSPORT_FIELDS) {
      const value = params[field];
      if (value === undefined) continue;
      if (["loopEnabled", "metronome", "punchIn", "punchOut"].includes(field)) { if (typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`); }
      else if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field === "loopLength" && value <= 0)) return error(id, -32602, `${field} is out of bounds`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one transport field is required");
    try {
      const status = this.requireConnected("transport");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const transport = snapshot.playback?.transport;
      if (!transport || !transport.loop || !isNonEmptyString(snapshot.set.objectIdentity, 256)) return this.transactionError(id, "authoritative transport Set identity is unavailable");
      const transaction: TransportTransaction = { id: `transport_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, setRef: snapshot.set.ref, setIdentity: snapshot.set.objectIdentity, prior: structuredClone({ position: transport.position, loop: transport.loop, punchIn: transport.punchIn, punchOut: transport.punchOut, metronome: transport.metronome }), proposed, playbackRevision: snapshot.playback.revision, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.transportTransactions, transaction, "transport");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, prior: transaction.prior, proposed, playbackRevision: transaction.playbackRevision, impact: "transport-state", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Transport preview requires fresh authoritative playback state."); }
  }

  private async confirmTransportPosition(adapter: AsyncLiveAdapter, context: { signal?: AbortSignal; deadlineMs: number }, proposed: number): Promise<void> {
    // Live applies playhead moves asynchronously; accept the position once it
    // lands within tolerance, allowing bounded drift while the transport plays.
    while (Date.now() < context.deadlineMs - 250) {
      const after = await adapter.snapshotAsync(context);
      const current = after.playback.transport.position;
      const playing = after.playback.transport.playing === true;
      if (typeof current === "number" && (playing ? (current >= proposed - 0.26 && current <= proposed + 2.5) : Math.abs(current - proposed) <= 0.26)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("transport position was not confirmed by fresh playback state");
  }

  private async liveTransportApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.transportTransactions.get(params.transactionId as string);
    if (!transaction || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired transport transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      if (!reconciliation && (snapshot.set.ref !== transaction.setRef || snapshot.set.objectIdentity !== transaction.setIdentity || snapshot.playback.revision !== transaction.playbackRevision)) return this.transactionError(id, "transport Set identity or state changed since preview; preview again");
      const result = await adapter.invokeAsync({ operation: "transport.set", args: { ...transaction.proposed, expectedRevision: transaction.playbackRevision, setRef: transaction.setRef, expectedObjectIdentity: transaction.setIdentity } }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true || typeof result.revision !== "string") throw new Error("transport change was not confirmed");
      if (typeof transaction.proposed.position === "number") await this.confirmTransportPosition(adapter, context, transaction.proposed.position);
      transaction.appliedRevision = result.revision;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Transport state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveTransportUndoAsync(id: RequestId, transaction: TransportTransaction, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonObject> {
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.undoKey === params.idempotencyKey;
    if (transaction.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain transport transaction can be undone");
    try {
      this.beginUndoRecovery(transaction, params.idempotencyKey as string);
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (reconciliation) await this.replayUndoRecovery(transaction, adapter, context);
      const snapshot = await adapter.snapshotAsync(context);
      const prior = transaction.prior;
      const restore: Record<string, number | boolean> = {};
      for (const field of Object.keys(transaction.proposed)) {
        if (field === "position" && typeof prior.position === "number") restore.position = prior.position;
        if (field === "loopEnabled" && typeof prior.loop.enabled === "boolean") restore.loopEnabled = prior.loop.enabled;
        if (field === "loopStart" && typeof prior.loop.start === "number") restore.loopStart = prior.loop.start;
        if (field === "loopLength" && typeof prior.loop.length === "number") restore.loopLength = prior.loop.length;
        if (field === "metronome" && typeof prior.metronome === "boolean") restore.metronome = prior.metronome;
        if (field === "punchIn" && typeof prior.punchIn === "boolean") restore.punchIn = prior.punchIn;
        if (field === "punchOut" && typeof prior.punchOut === "boolean") restore.punchOut = prior.punchOut;
      }
      if (snapshot.set.ref !== transaction.setRef || snapshot.set.objectIdentity !== transaction.setIdentity) return this.transactionError(id, "transport Set identity changed after apply; undo refused");
      if (!reconciliation && (transaction.appliedRevision === undefined || snapshot.playback.revision !== transaction.appliedRevision)) return this.transactionError(id, "transport state revision changed after apply; undo refused");
      const current = snapshot.playback.transport;
      if (reconciliation) {
        for (const [field, restored] of Object.entries(restore)) { const observed = field === "loopEnabled" ? current.loop.enabled : field === "loopStart" ? current.loop.start : field === "loopLength" ? current.loop.length : (current as unknown as JsonObject)[field]; if (field === "position" ? (typeof observed !== "number" || typeof restored !== "number" || Math.abs(observed - restored) > 0.26) : observed !== restored) throw new Error("transport undo replay did not restore the exact prior state"); }
      } else {
        for (const [field, proposed] of Object.entries(transaction.proposed)) { const observed = field === "loopEnabled" ? current.loop.enabled : field === "loopStart" ? current.loop.start : field === "loopLength" ? current.loop.length : (current as unknown as JsonObject)[field]; if (field === "position" ? (typeof observed !== "number" || typeof proposed !== "number" || Math.abs(observed - proposed) > 0.26) : observed !== proposed) return this.transactionError(id, "transport field changed after apply; undo refused"); }
        const result = await this.invokeUndoRecovery(transaction, adapter, "transport.set", { ...restore, expectedRevision: snapshot.playback.revision, setRef: transaction.setRef, expectedObjectIdentity: transaction.setIdentity }, context) as { changed?: unknown; revision?: unknown };
        if (result.changed !== true) throw new Error("transport undo was not confirmed");
      }
      if (typeof restore.position === "number") await this.confirmTransportPosition(adapter, context, restore.position);
      transaction.undoKey = params.idempotencyKey as string;
      transaction.state = "undone";
      return this.successText(id, { transactionId: transaction.id, state: "undone", restored: restore, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Transport undo is uncertain; perform fresh discovery."); }
  }

  private retainBoundedTransaction<T extends { id: string; expiresAt: number; state: string }>(map: Map<string, T>, transaction: T, kind: string): void {
    const now = Date.now();
    for (const [key, candidate] of map) if (candidate.expiresAt <= now && !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(key)) map.delete(key);
    while (map.size >= MAX_AUDITION_TRANSACTIONS) {
      const oldest = [...map].find(([candidateKey, candidate]) => !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(candidateKey));
      if (!oldest) throw new Error(`${kind} transaction capacity is exhausted by in-flight work`);
      map.delete(oldest[0]);
    }
    map.set(transaction.id, transaction);
  }

  private validateOutputSafety(outputSafety: unknown): void {
    if (!isObject(outputSafety) || !hasOnly(outputSafety, ["safe", "provenance", "observedAt", "scope"]) || outputSafety.safe !== true || !isNonEmptyString(outputSafety.provenance, 512) || outputSafety.provenance === "unknown" || outputSafety.provenance === "simulator") throw new Error("explicit authoritative output-safety evidence is required");
  }

  private async liveClipLaunchPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["slotRef", "outputSafety"]) || !isNonEmptyString(params.slotRef, 256)) return error(id, -32602, "slotRef and outputSafety evidence are required");
    try {
      this.validateOutputSafety(params.outputSafety);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("session.clip-launch")) throw new Error("clip launch operation is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const transport = snapshot.playback?.transport;
      if (!transport) throw new Error("authoritative playback state is unavailable");
      if (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || snapshot.playback.firedTargets.length > 0 || snapshot.playback.playingTargets.length > 0) throw new Error("clip launch requires a stopped, non-recording baseline with no active Session targets");
      const target = (snapshot.tracks as unknown as JsonObject[]).flatMap((track) => Array.isArray(track.clipSlots) ? (track.clipSlots as unknown[]).filter(isObject).filter((slot) => slot.ref === params.slotRef).map((slot) => ({ track, slot })) : [])[0];
      if (!target || typeof target.slot.clipRef !== "string" || typeof target.slot.sceneIndex !== "number" || typeof target.track.ref !== "string") throw new Error("clip slot with an authoritative clip is required");
      const scene = snapshot.scenes.find((item) => item.index === target.slot.sceneIndex);
      const clip = (target.track.clips as unknown as JsonObject[]).find((item) => item.ref === target.slot.clipRef);
      if (!scene || typeof target.track.objectIdentity !== "string" || typeof scene.objectIdentity !== "string" || typeof target.slot.objectIdentity !== "string" || !clip || typeof clip.objectIdentity !== "string") throw new Error("clip-launch target lacks exact authoritative object identity");
      const targetKey = `${target.track.ref}|${target.slot.ref}|${scene.ref}`;
      if (targetKey.split("|").length !== 3) throw new Error("clip references are not encodable as a target key");
      const transaction: ClipLaunchTransaction = { id: `cliplaunch_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, slotRef: params.slotRef as LiveRef, trackRef: target.track.ref as LiveRef, sceneRef: scene.ref, sceneIndex: scene.index, clipRef: target.slot.clipRef as LiveRef, trackIdentity: target.track.objectIdentity, sceneIdentity: scene.objectIdentity, slotIdentity: target.slot.objectIdentity, clipIdentity: clip.objectIdentity, targetKey, playbackRevision: snapshot.playback.revision, outputSafety: structuredClone(params.outputSafety as JsonObject), confirmation: randomBytes(32).toString("base64url"), stopConfirmation: randomBytes(32).toString("base64url"), expiresAt: Date.now() + AUDITION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLaunchTransactions, transaction, "clip launch");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, target: { slotRef: transaction.slotRef, trackRef: transaction.trackRef, sceneRef: transaction.sceneRef, sceneIndex: transaction.sceneIndex, clipRef: transaction.clipRef, trackIdentity: transaction.trackIdentity, sceneIdentity: transaction.sceneIdentity, slotIdentity: transaction.slotIdentity, clipIdentity: transaction.clipIdentity, targetKey }, playbackRevision: transaction.playbackRevision, audibleImpact: "potentially-audible-clip-launch", confirmation: transaction.confirmation, stopConfirmation: transaction.stopConfirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-launch preview refused; obtain fresh authoritative discovery and explicit output-safety evidence."); }
  }

  private async liveClipLaunchApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isIdempotencyKey(params.idempotencyKey)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
    const transaction = this.clipLaunchTransactions.get(params.transactionId as string);
    if (!transaction || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-launch transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation) return this.successText(id, { transactionId: transaction.id, state: "applied", stopConfirmation: transaction.stopConfirmation, idempotent: true });
    if (transaction.state === "stopped" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation) return this.successText(id, { transactionId: transaction.id, state: "stopped", stopConfirmation: transaction.stopConfirmation, idempotent: true });
    if (transaction.state === "applying") {
      if (transaction.applyKey !== params.idempotencyKey || transaction.confirmation !== params.confirmation || !transaction.inflight) return this.transactionError(id, "Clip-launch apply is already in progress with a different request");
      try {
        const outcome = await transaction.inflight;
        return this.successText(id, { ...outcome, idempotent: true });
      } catch (cause) {
        return this.adapterToolError(id, cause, "Clip-launch state is uncertain; reconcile only with the exact original key or use the exact stop workflow after fresh playback discovery.");
      }
    }
    const uncertainPhase = transaction.uncertainPhase ?? (transaction.stopKey ? "stop" : "apply");
    const reconciliation = transaction.state === "uncertain" && uncertainPhase === "apply" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation;
    if (transaction.state === "uncertain" && !reconciliation) return this.transactionError(id, "Uncertain clip-launch apply requires the exact original confirmation and idempotency key");
    if ((transaction.state !== "previewed" && !reconciliation) || transaction.confirmation !== params.confirmation) return this.transactionError(id, "Exact clip-launch confirmation is required");
    if (signal?.aborted) return null;
    if (reconciliation) { const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; clip-launch reconciliation refused"); }
    transaction.state = "applying";
    transaction.applyKey = params.idempotencyKey as string;
    const inflight = this.dispatchClipLaunchApply(transaction, signal, reconciliation);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Clip-launch state is uncertain; reconcile only with the exact original key or use the exact stop workflow after fresh playback discovery.");
    }
  }

  private async dispatchClipLaunchApply(transaction: ClipLaunchTransaction, signal?: AbortSignal, reconciliation = false): Promise<JsonObject> {
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id };
      const snapshot = await adapter.snapshotAsync(context);
      const transport = snapshot.playback?.transport;
      if (!transport) throw new Error("authoritative playback state is unavailable");
      const activeTargets = [...snapshot.playback.firedTargets, ...snapshot.playback.playingTargets]; const oursAlreadyActive = activeTargets.some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey);
      if (!reconciliation && snapshot.playback.revision !== transaction.playbackRevision) throw new Error("playback state changed since preview");
      if ((!reconciliation && (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || activeTargets.length > 0)) || (reconciliation && !oursAlreadyActive && (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || activeTargets.length > 0))) throw new Error("clip launch requires a stopped, non-recording baseline with no conflicting Session targets");
      const currentTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === transaction.trackRef && track.objectIdentity === transaction.trackIdentity);
      const currentSlot = currentTrack && Array.isArray(currentTrack.clipSlots) ? (currentTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.ref === transaction.slotRef && slot.objectIdentity === transaction.slotIdentity && slot.clipRef === transaction.clipRef && slot.sceneIndex === transaction.sceneIndex) : undefined;
      const currentClip = currentTrack && Array.isArray(currentTrack.clips) ? (currentTrack.clips as unknown[]).filter(isObject).find((clip) => clip.ref === transaction.clipRef && clip.objectIdentity === transaction.clipIdentity) : undefined;
      const currentScene = (snapshot.scenes as unknown as JsonObject[]).find((scene) => scene.ref === transaction.sceneRef && scene.objectIdentity === transaction.sceneIdentity && scene.index === transaction.sceneIndex);
      if (!currentTrack || !currentSlot || !currentClip || !currentScene) throw new Error("clip-launch target identity changed since preview");
      this.validateOutputSafety(transaction.outputSafety);
      if (reconciliation && oursAlreadyActive) { transaction.state = "applied"; delete transaction.uncertainPhase; return { transactionId: transaction.id, state: "applied", verified: { targetKey: transaction.targetKey, firedOrPlaying: true }, stopConfirmation: transaction.stopConfirmation, reconciled: true }; }
      if (signal?.aborted) throw new Error("clip launch cancelled before dispatch");
      const result = await adapter.invokeAsync({ operation: "session.clip-launch", args: { slotRef: transaction.slotRef, trackRef: transaction.trackRef, sceneRef: transaction.sceneRef, sceneIndex: transaction.sceneIndex, clipRef: transaction.clipRef, trackIdentity: transaction.trackIdentity, sceneIdentity: transaction.sceneIdentity, slotIdentity: transaction.slotIdentity, clipIdentity: transaction.clipIdentity, playbackRevision: transaction.playbackRevision, outputSafety: transaction.outputSafety } }, context) as { launched?: unknown; targets?: unknown };
      if (result.launched !== transaction.slotRef) throw new Error("clip launch result does not match the previewed slot");
      let verified = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        const activeTargets = [...after.playback.firedTargets, ...after.playback.playingTargets];
        if (activeTargets.some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey)) { verified = true; break; }
        if (reconciliation && after.playback.transport.playing === false && after.playback.transport.arrangementRecord === false && after.playback.transport.sessionRecord === false && activeTargets.length === 0) { transaction.state = "stopped"; delete transaction.uncertainPhase; return { transactionId: transaction.id, state: "stopped", verified: { targetKey: transaction.targetKey, firedOrPlaying: false, launchEnded: true }, stopConfirmation: transaction.stopConfirmation, reconciled: true }; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!verified) throw new Error("clip launch was not confirmed by fresh fired or playing target evidence");
      transaction.state = "applied"; delete transaction.uncertainPhase;
      return { transactionId: transaction.id, state: "applied", verified: { targetKey: transaction.targetKey, firedOrPlaying: true }, stopConfirmation: transaction.stopConfirmation, ...(reconciliation ? { reconciled: true } : {}) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause); const safelyCancelled = !reconciliation && /cancelled before dispatch/.test(message);
      transaction.state = safelyCancelled ? "previewed" : "uncertain";
      if (safelyCancelled) { delete transaction.applyKey; delete transaction.uncertainPhase; } else transaction.uncertainPhase = "apply";
      throw cause;
    }
  }

  private async liveClipLaunchStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isIdempotencyKey(params.idempotencyKey)) return error(id, -32602, "transactionId, exact stop confirmation, and idempotencyKey are required");
    const transaction = this.clipLaunchTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown clip-launch transaction");
    if (transaction.state === "stopped" && transaction.stopKey === params.idempotencyKey && params.confirmation === transaction.stopConfirmation) return this.successText(id, { transactionId: transaction.id, state: "stopped", idempotent: true });
    if (params.confirmation !== transaction.stopConfirmation) return this.transactionError(id, "Exact clip-launch stop confirmation is required");
    if (transaction.state === "stopping") {
      if (transaction.stopKey !== params.idempotencyKey || !transaction.inflight) return this.transactionError(id, "Clip-launch stop is already in progress with a different request");
      try {
        const outcome = await transaction.inflight;
        return this.successText(id, { ...outcome, idempotent: true });
      } catch (cause) {
        return this.adapterToolError(id, cause, "Clip-launch stop is uncertain; perform fresh playback discovery.");
      }
    }
    if (!(transaction.state === "applied" || transaction.state === "uncertain")) return this.transactionError(id, "Only an applied or uncertain clip launch can be stopped");
    const uncertainPhase = transaction.uncertainPhase ?? (transaction.stopKey ? "stop" : "apply"); const stoppingUncertainApply = transaction.state === "uncertain" && uncertainPhase === "apply";
    if (transaction.state === "uncertain" && uncertainPhase === "stop" && transaction.stopKey !== params.idempotencyKey) return this.transactionError(id, "Uncertain clip stop requires the exact original idempotency key");
    if (signal?.aborted) return null;
    transaction.state = "stopping";
    transaction.stopKey = params.idempotencyKey as string;
    const inflight = this.dispatchClipLaunchStop(transaction, signal, stoppingUncertainApply);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Clip-launch stop is uncertain; perform fresh playback discovery.");
    }
  }

  private async dispatchClipLaunchStop(transaction: ClipLaunchTransaction, signal?: AbortSignal, stoppingUncertainApply = false): Promise<JsonObject> {
    let dispatched = false;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; stop refused");
      if (!(status.operations ?? []).includes("session.clip-stop")) throw new Error("track stop operation is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.stopKey, transactionId: transaction.id };
      const before = await adapter.snapshotAsync(context);
      const ours = [...before.playback.firedTargets, ...before.playback.playingTargets].some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey);
      if (ours) {
        const currentTrack = (before.tracks as unknown as JsonObject[]).find((track) => track.ref === transaction.trackRef && track.objectIdentity === transaction.trackIdentity);
        const currentSlot = currentTrack && Array.isArray(currentTrack.clipSlots) ? (currentTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.ref === transaction.slotRef && slot.objectIdentity === transaction.slotIdentity && slot.clipRef === transaction.clipRef && slot.sceneIndex === transaction.sceneIndex) : undefined;
        const currentClip = currentTrack && Array.isArray(currentTrack.clips) ? (currentTrack.clips as unknown[]).filter(isObject).find((clip) => clip.ref === transaction.clipRef && clip.objectIdentity === transaction.clipIdentity) : undefined;
        const currentScene = (before.scenes as unknown as JsonObject[]).find((scene) => scene.ref === transaction.sceneRef && scene.objectIdentity === transaction.sceneIdentity && scene.index === transaction.sceneIndex);
        if (!currentTrack || !currentSlot || !currentClip || !currentScene) throw new Error("clip-stop target identity changed; guarded stop refused");
        if (signal?.aborted) throw new Error("clip-launch stop cancelled before dispatch");
        dispatched = true;
        await adapter.invokeAsync({ operation: "session.clip-stop", args: { slotRef: transaction.slotRef, trackRef: transaction.trackRef, sceneRef: transaction.sceneRef, sceneIndex: transaction.sceneIndex, clipRef: transaction.clipRef, trackIdentity: transaction.trackIdentity, sceneIdentity: transaction.sceneIdentity, slotIdentity: transaction.slotIdentity, clipIdentity: transaction.clipIdentity } }, context);
      }
      let confirmed = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        const still = [...after.playback.firedTargets, ...after.playback.playingTargets].some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey);
        if (!still) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error("clip stop was not confirmed by fresh authoritative state");
      transaction.state = "stopped"; delete transaction.uncertainPhase;
      return { transactionId: transaction.id, state: "stopped", targetCleared: true };
    } catch (cause) {
      if (dispatched) { transaction.state = "uncertain"; transaction.uncertainPhase = "stop"; }
      else if (stoppingUncertainApply) { transaction.state = "uncertain"; transaction.uncertainPhase = "apply"; }
      else { transaction.state = "applied"; delete transaction.uncertainPhase; }
      throw cause;
    }
  }

  private routingWouldCreateCycle(snapshot: LiveSnapshot, targetRef: string, proposed: Record<string, unknown>): boolean {
    const tracks = (snapshot.tracks as unknown as JsonObject[]).filter((track) => typeof track.ref === "string" && typeof track.name === "string" && isObject(track.routing));
    const refsByName = new Map<string, string[]>();
    for (const track of tracks) {
      const refs = refsByName.get(track.name as string) ?? [];
      refs.push(track.ref as string);
      refsByName.set(track.name as string, refs);
    }
    const edges = new Map<string, Set<string>>(tracks.map((track) => [track.ref as string, new Set<string>()]));
    for (const track of tracks) {
      const routing = track.routing as JsonObject;
      const effective = (field: "inputType" | "outputType"): unknown => track.ref === targetRef && Object.prototype.hasOwnProperty.call(proposed, field) ? proposed[field] : routing[field];
      const output = effective("outputType");
      if (typeof output === "string") for (const destination of refsByName.get(output) ?? []) edges.get(track.ref as string)?.add(destination);
      const input = effective("inputType");
      if (typeof input === "string") for (const source of refsByName.get(input) ?? []) edges.get(source)?.add(track.ref as string);
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const cycle = (reference: string): boolean => {
      if (visiting.has(reference)) return true;
      if (visited.has(reference)) return false;
      visiting.add(reference);
      for (const destination of edges.get(reference) ?? []) if (cycle(destination)) return true;
      visiting.delete(reference); visited.add(reference); return false;
    };
    return [...edges.keys()].some(cycle);
  }

  private routingStateRevision(track: JsonObject): string {
    if (!isObject(track.routing)) throw new Error("routing state is unavailable");
    const state = { inputType: track.routing.inputType ?? null, inputSubRouting: track.routing.inputSubRouting ?? null, outputType: track.routing.outputType ?? null, outputSubRouting: track.routing.outputSubRouting ?? null, arm: track.armed ?? null, monitoring: track.monitoringState ?? null };
    return createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex");
  }

  private async liveRoutingPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["inputType", "inputSubRouting", "outputType", "outputSubRouting", "arm", "monitoring"] as const;
    if (!isObject(params) || !hasOnly(params, ["trackRef", ...fields]) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "trackRef is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "arm") { if (typeof value !== "boolean") return error(id, -32602, "arm must be boolean"); }
      else if (field === "monitoring") { if (!["in", "auto", "off"].includes(String(value))) return error(id, -32602, "monitoring must be in, auto, or off"); }
      else if (!isNonEmptyString(value, 256) && value !== "") return error(id, -32602, `${field} is invalid`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one routing field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("routing.set")) throw new Error("routing editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.trackRef);
      if (!track || !isObject(track.routing) || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track with exact authoritative routing identity is required");
      if (this.routingWouldCreateCycle(snapshot, params.trackRef as string, proposed)) throw new Error("routing would create a direct or transitive feedback loop");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = structuredClone((track.routing as JsonObject)[field] ?? (field === "arm" ? track.armed : field === "monitoring" ? track.monitoringState : null));
      const fence = JSON.stringify({ ref: params.trackRef, objectIdentity: track.objectIdentity, routing: track.routing, armed: track.armed, monitoringState: track.monitoringState });
      const transaction: ClipLifecycleTransaction = { id: `routing_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "routing-set", fence, clipRef: params.trackRef as LiveRef, payload: { ref: params.trackRef, ...proposed, expectedObjectIdentity: track.objectIdentity, expectedStateRevision: this.routingStateRevision(track) }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "routing");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, trackRef: params.trackRef, prior, proposed, impact: "edits-routing", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Routing preview requires fresh authoritative state."); }
  }

  private async liveRoutingApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "routing-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired routing transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.clipRef);
        if (!track || JSON.stringify({ ref: transaction.clipRef, objectIdentity: track.objectIdentity, routing: track.routing, armed: track.armed, monitoringState: track.monitoringState }) !== transaction.fence) return this.transactionError(id, "routing target or state changed since preview; preview again");
        if (this.routingWouldCreateCycle(snapshot, transaction.clipRef as string, transaction.payload)) return this.transactionError(id, "routing would create a direct or transitive feedback loop"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "routing.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("routing change was not confirmed");
      const after = await adapter.snapshotAsync(context); const appliedTrack = (after.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.clipRef);
      if (!appliedTrack || appliedTrack.objectIdentity !== transaction.payload.expectedObjectIdentity) throw new Error("routing target identity changed after apply");
      const observedRouting = { inputType: (appliedTrack.routing as JsonObject).inputType, inputSubRouting: (appliedTrack.routing as JsonObject).inputSubRouting, outputType: (appliedTrack.routing as JsonObject).outputType, outputSubRouting: (appliedTrack.routing as JsonObject).outputSubRouting, arm: appliedTrack.armed, monitoring: appliedTrack.monitoringState }; for (const key of Object.keys(transaction.prior ?? {})) if (observedRouting[key as keyof typeof observedRouting] !== transaction.payload[key]) throw new Error("routing postcondition was not confirmed");
      transaction.created = { inputType: (appliedTrack.routing as JsonObject).inputType, inputSubRouting: (appliedTrack.routing as JsonObject).inputSubRouting, outputType: (appliedTrack.routing as JsonObject).outputType, outputSubRouting: (appliedTrack.routing as JsonObject).outputSubRouting, arm: appliedTrack.armed, monitoring: appliedTrack.monitoringState };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Routing state is uncertain; perform fresh discovery before retrying."); }
  }

  private eventEmitter: ((value: string) => Promise<void>) | undefined;
  private readonly eventQueue: string[] = [];
  private eventOverflow = 0;
  private eventFlushPromise: Promise<void> | undefined;
  private eventOutputFailed = false;

  setEventEmitter(emitter: (value: string) => Promise<void>): void {
    this.eventEmitter = emitter;
    this.eventOutputFailed = false;
    const adapter = this.adapter as Partial<LiveAdapter>;
    if (typeof adapter.subscribe === "function") {
      adapter.subscribe((event) => this.onLiveEvent(event));
    }
    // Internal adapter-status channel (distinct from the public LiveEvent
    // stream): connect/disconnect and negotiated-shape changes invalidate the
    // advertised tool list as they happen.
    const subscribeStatus = (this.adapter as Partial<{ subscribeStatus(listener: (status: LiveStatus) => void): () => void }>).subscribeStatus;
    if (typeof subscribeStatus === "function") {
      subscribeStatus.call(this.adapter, () => this.noteToolListChanged());
    }
  }

  private scheduleEventFlush(): void {
    if (this.eventFlushPromise || this.eventOutputFailed || !this.eventEmitter) return;
    this.eventFlushPromise = (async () => {
      while (this.eventQueue.length > 0 || this.eventOverflow > 0) {
        const queued = this.eventQueue.shift();
        if (queued !== undefined) await this.eventEmitter!(queued);
        else {
          const dropped = this.eventOverflow; this.eventOverflow = 0;
          await this.eventEmitter!(JSON.stringify({ jsonrpc: "2.0", method: "notifications/live_event_overflow", params: { epoch: this.safeAdapterStatus().epoch, dropped, resnapshot: true } }));
        }
      }
    })().catch(() => {
      this.eventOutputFailed = true;
      this.eventQueue.length = 0;
      this.eventOverflow = 0;
    }).finally(() => {
      this.eventFlushPromise = undefined;
      if (!this.eventOutputFailed && (this.eventQueue.length > 0 || this.eventOverflow > 0)) this.scheduleEventFlush();
    });
  }

  private onLiveEvent(event: LiveEvent): void {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "notifications/live_event", params: event });
    if (this.eventQueue.length >= 256) this.eventOverflow = Math.min(Number.MAX_SAFE_INTEGER, this.eventOverflow + 1);
    else this.eventQueue.push(line);
    if (event.type === "reset") this.noteToolListChanged();
    this.scheduleEventFlush();
  }

  /** Fingerprint of the inputs that determine the visible tool list. */
  private toolListStateFingerprint(): string {
    const status = this.safeAdapterStatus();
    return createHash("sha256").update(canonicalMutationIdentity({ connected: status.connected, epoch: status.epoch, adapter: status.adapter, operations: status.operations ?? [], capabilities: status.capabilities, policy: this.toolPolicy })).digest("hex");
  }

  /** Emit `notifications/tools/list_changed` once per effective discovery change. */
  private noteToolListChanged(): void {
    if (!this.initializedNotification || this.eventEmitter === undefined) { this.toolListFingerprint = undefined; return; }
    const fingerprint = this.toolListStateFingerprint();
    const prior = this.toolListFingerprint;
    this.toolListFingerprint = fingerprint;
    if (prior === undefined || prior === fingerprint) return;
    if (this.eventQueue.length >= 256) this.eventOverflow = Math.min(Number.MAX_SAFE_INTEGER, this.eventOverflow + 1);
    else this.eventQueue.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    this.scheduleEventFlush();
  }

  private toolVisibilityRows(): readonly ToolVisibilityRow[] {
    return resolveToolVisibility(this.safeAdapterStatus(), this.toolPolicy);
  }

  /** Server-side dispatch gate: a tool is callable only when it is currently visible in tools/list. */
  private toolCallable(name: string): boolean {
    return this.toolVisibilityRows().some((row) => row.entry.name === name && row.visible);
  }

  /** Hidden tools never reach a handler: known but currently unavailable or policy-denied tools fail closed with a truthful reason. */
  private toolGateError(id: RequestId, name: string): JsonObject {
    if (toolCatalogEntry(name) === undefined) return error(id, -32601, "Tool not found");
    const row = this.toolVisibilityRows().find((candidate) => candidate.entry.name === name);
    const reason = row !== undefined && row.executable && !row.policyAllowed ? "tool-denied-by-deployment-policy" : "tool-unavailable-in-current-live-shape";
    return response(id, { content: [{ type: "text", text: JSON.stringify({ reason, remediation: "Consult the capabilities resource for the executable tools and effective deployment policy; hidden tools are never dispatched." }) }], isError: true });
  }

  /** Map a transaction to the tool that owns its apply path for policy re-checks at undo/emergency dispatch. */
  private transactionOwnerTool(transactionId: string, kind?: string): string | undefined {
    const byPrefix: Record<string, string> = { tempo_: "live_tempo_apply", arrangement_: "live_arrangement_section_apply", structure_: "live_session_structure_apply", parameter_: "live_device_parameter_apply", audition_: "live_session_audition_apply", transport_: "live_transport_apply", transportaction_: "live_transport_action_apply", cliplaunch_: "live_clip_launch_apply", noteupdate_: "live_note_update_apply", notedelete_: "live_note_delete_apply", midi_: "live_midi_clip_apply", miditransform_: "live_midi_transform_apply", capture_: "live_audio_capture_apply", audio_capture_: "live_audio_capture_apply", capturemidi_: "live_capture_midi_apply", scenecapture_: "live_scene_capture_apply", clipdup_: "live_clip_duplicate_apply", arrclip_: "live_arrangement_clip_apply", clipmove_: "live_clip_move_apply", audioimport_: "live_audio_import_apply", audioclip_: "live_audio_clip_apply", warp_: "live_warp_marker_apply", noteedit_: "live_note_edit_apply", rename_: "live_object_rename_apply", routing_: "live_routing_apply", backup_: "live_project_backup_apply", recording_: "live_recording_apply", realtime_: "live_realtime_arm_apply", browserload_: "live_browser_load_apply", device_: "live_device_apply", mixer_: "live_mixer_apply", mixerext_: "live_mixer_extended_apply", view_: "live_view_apply", locjump_: "live_locator_jump_apply", clipset_: "live_clip_properties_apply", clipaction_: "live_clip_action_apply", tuning_: "live_tuning_apply", groove_: "live_groove_apply", sceneset_: "live_scene_apply", trackset_: "live_track_properties_apply", songset_: "live_song_settings_apply", scenefire_: "live_scene_fire_apply", trackstruct_: "live_track_structure_apply", devdel_: "live_device_delete_apply", trackview_: "live_track_view_apply", selection_: "live_selection_apply", clipview_: "live_clip_view_apply", devview_: "live_device_view_apply", dialog_: "live_application_dialog_apply", chainmix_: "live_chain_mixer_apply", devio_: "live_device_io_apply", devadv_: "live_device_advanced_apply", chainset_: "live_chain_apply", drumpad_: "live_drum_pad_apply", rack_: "live_rack_apply", rackview_: "live_rack_view_apply", devspec_: "live_device_specialized_apply", looper_: "live_looper_apply", simpler_: "live_simpler_apply", automation_: "live_automation_apply" };
    const prefixes = Object.keys(byPrefix).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) if (transactionId.startsWith(prefix)) return byPrefix[prefix];
    const byKind: Record<string, string> = { "audio-set": "live_audio_clip_apply", "mixer-set": "live_mixer_apply", automation: "live_automation_apply", "browser-load": "live_browser_load_apply", device: "live_device_apply", "routing-set": "live_routing_apply", recording: "live_recording_apply", backup: "live_project_backup_apply", "realtime-arm": "live_realtime_arm_apply", view: "live_view_apply", "locator-jump": "live_locator_jump_apply", "clip-set": "live_clip_properties_apply", "clip-action": "live_clip_action_apply", tuning: "live_tuning_apply", groove: "live_groove_apply", "scene-set": "live_scene_apply", "track-set": "live_track_properties_apply", "song-set": "live_song_settings_apply", "scene-fire": "live_scene_fire_apply", "transport-action": "live_transport_action_apply", "track-structure": "live_track_structure_apply", "device-delete": "live_device_delete_apply", "track-view": "live_track_view_apply", selection: "live_selection_apply", "clip-view": "live_clip_view_apply", "device-view": "live_device_view_apply", dialog: "live_application_dialog_apply", "mixer-extended": "live_mixer_extended_apply", "chain-mixer": "live_chain_mixer_apply", "device-io": "live_device_io_apply", "device-advanced": "live_device_advanced_apply", "chain-set": "live_chain_apply", "drum-pad": "live_drum_pad_apply", rack: "live_rack_apply", "rack-view": "live_rack_view_apply", "device-specialized": "live_device_specialized_apply", looper: "live_looper_apply", simpler: "live_simpler_apply", rename: "live_object_rename_apply", "warp-marker": "live_warp_marker_apply", "note-target": "live_note_edit_apply", duplicate: "live_clip_duplicate_apply", move: "live_clip_move_apply", "session-audio-create": "live_audio_import_apply", "capture-midi": "live_capture_midi_apply", "scene-capture": "live_scene_capture_apply", "arrangement-create": "live_arrangement_clip_apply", "arrangement-audio-create": "live_arrangement_clip_apply", "arrangement-take-lane-create": "live_arrangement_clip_apply" };
    return kind !== undefined ? byKind[kind] : undefined;
  }

  /** Policy gate for follow-up dispatch (apply/undo/emergency paths re-checked by owning tool name). */
  private policyAllowsTool(name: string | undefined): boolean {
    if (name === undefined) return true;
    return this.toolVisibilityRows().some((row) => row.entry.name === name && row.policyAllowed);
  }

  private async liveProjectSnapshotExportAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const profiles = ["strict", "collaboration", "local"] as const;
    if (!isObject(params) || !hasOnly(params, ["profile", "limit", "cursor"]) || (params.profile !== undefined && !profiles.includes(params.profile as typeof profiles[number])) || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 200)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 4096))) return error(id, -32602, "profile, limit, and cursor are invalid");
    try {
      const status = this.requireConnected("session.read");
      if (!(status.operations ?? []).includes("snapshot")) throw new Error("snapshot operation is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const projectPath = typeof snapshot.set.filePath === "string" && snapshot.set.filePath.length > 0 ? snapshot.set.filePath : undefined;
      const artifact = createSemanticProjectSnapshot(snapshot, { profile: (params.profile ?? "collaboration") as SemanticPrivacyProfile, exporterVersion: SERVER_VERSION, live: { protocol: status.protocol, adapter: status.adapter, provenance: status.provenance, registryHash: status.registryHash }, ...(projectPath ? { projectPath } : {}) });
      return this.successText(id, pageSemanticProjectSnapshot(artifact, { ...(params.limit !== undefined ? { limit: params.limit as number } : {}), ...(params.cursor !== undefined ? { cursor: params.cursor as string } : {}) }));
    } catch (cause) { return this.adapterToolError(id, cause, "Semantic snapshot export is read-only; retry only after a fresh readable snapshot or restart paging from the first page."); }
  }

  private liveProjectSnapshotDiff(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["beforePages", "afterPages", "limit", "cursor"]) || !Array.isArray(params.beforePages) || params.beforePages.length < 1 || params.beforePages.length > 512 || !Array.isArray(params.afterPages) || params.afterPages.length < 1 || params.afterPages.length > 512 || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 200)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 4096))) return error(id, -32602, "complete bounded beforePages and afterPages plus optional limit/cursor are required");
    try {
      if (Buffer.byteLength(JSON.stringify({ beforePages: params.beforePages, afterPages: params.afterPages }), "utf8") > SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES) throw new Error("combined semantic snapshot bundles exceed the bounded diff input size");
      const before = assembleSemanticProjectPages(params.beforePages as SemanticProjectPage[]); const after = assembleSemanticProjectPages(params.afterPages as SemanticProjectPage[]);
      const diff = diffSemanticProjectSnapshots(before, after);
      return this.successText(id, pageSemanticProjectDiff(diff, { ...(params.limit !== undefined ? { limit: params.limit as number } : {}), ...(params.cursor !== undefined ? { cursor: params.cursor as string } : {}) }));
    } catch (cause) { return this.adapterToolError(id, cause, "Semantic diff requires complete untampered page bundles with the same schema and privacy profile; no merge was attempted."); }
  }

  private alsFileAuthority(path: unknown, allowedRoot: unknown): { canonicalPath: string; canonicalRoot: string } {
    if (!isNonEmptyString(path, 4096) || !isNonEmptyString(allowedRoot, 1024)) throw new Error("path and allowedRoot are required");
    if (!(path.startsWith("/") || /^[A-Za-z]:/.test(path))) throw new Error("path must be an absolute path");
    const canonicalRoot = realpathSync(allowedRoot);
    const canonicalPath = realpathSync(path);
    if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep)) throw new Error("path escapes the allowed root");
    if (extname(canonicalPath).toLowerCase() !== ".als") throw new Error("path must be an .als file");
    const stats = statSync(canonicalPath);
    if (!stats.isFile()) throw new Error("path is not a regular file");
    return { canonicalPath, canonicalRoot };
  }

  private alsProfileParam(value: unknown, fallback: SemanticPrivacyProfile = "collaboration"): SemanticPrivacyProfile {
    if (value === undefined) return fallback;
    if (value !== "strict" && value !== "collaboration" && value !== "local") throw new Error("profile must be strict, collaboration, or local");
    return value;
  }

  private alsRead(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["path", "allowedRoot", "profile", "limit", "cursor", "includeNotes", "maxRecords"]) || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 200)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 4096)) || (params.maxRecords !== undefined && !isIntegerInRange(params.maxRecords, 1, SEMANTIC_PROJECT_MAX_RECORDS)) || (params.includeNotes !== undefined && typeof params.includeNotes !== "boolean")) return error(id, -32602, "path, allowedRoot, and optional profile/limit/cursor/includeNotes/maxRecords are required");
    try {
      const authority = this.alsFileAuthority(params.path, params.allowedRoot);
      const { source, model } = readAlsModel(authority.canonicalPath);
      const artifact = createOfflineAlsArtifact(source, model, { profile: this.alsProfileParam(params.profile), exporterVersion: PACKAGE_VERSION, ...(params.maxRecords !== undefined ? { maxRecords: params.maxRecords as number } : {}) });
      const page = pageSemanticProjectSnapshot(artifact, { ...(params.limit !== undefined ? { limit: params.limit as number } : {}), ...(params.cursor !== undefined ? { cursor: params.cursor as string } : {}) });
      let midi: unknown;
      if (params.includeNotes === true) {
        const rows = extractAlsMidi(model);
        let budget = 4096; let truncated = false;
        const boundedRows = rows.map((row) => {
          if (budget <= 0) { truncated = true; return { ...row, notes: [] }; }
          const kept = row.notes.slice(0, budget); budget -= kept.length;
          if (kept.length < row.notes.length) truncated = true;
          return { ...row, notes: kept };
        }).filter((row, index) => index === 0 || row.notes.length > 0 || !truncated);
        midi = { clips: boundedRows, truncated, noteBudget: 4096 };
      }
      return this.successText(id, { page, provenance: "offline-file", ...(midi !== undefined ? { midi } : {}) });
    } catch (cause) { return this.adapterToolError(id, cause, "Offline .als reading requires one owner-authorized regular file under the allowed root; sections that cannot be reconstructed offline are marked unavailable."); }
  }

  private alsLint(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["path", "allowedRoot"])) return error(id, -32602, "path and allowedRoot are required");
    try {
      const authority = this.alsFileAuthority(params.path, params.allowedRoot);
      const { model } = readAlsModel(authority.canonicalPath);
      const { findings, truncated } = lintAlsModel(model, { allowedRoot: authority.canonicalRoot });
      const bySeverity: Record<string, number> = {};
      const byCheck: Record<string, number> = {};
      for (const finding of findings) { bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1; byCheck[finding.check] = (byCheck[finding.check] ?? 0) + 1; }
      return this.successText(id, { findings, truncated, summary: { total: findings.length, bySeverity, byCheck }, parseNotes: model.parseNotes });
    } catch (cause) { return this.adapterToolError(id, cause, "Offline .als lint requires one owner-authorized regular file under the allowed root; findings are never fixes."); }
  }

  private alsDiff(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["before", "after", "limit", "cursor"]) || !isObject(params.before) || !isObject(params.after) || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 200)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 4096))) return error(id, -32602, "before and after sides plus optional limit/cursor are required");
    const side = (value: unknown, otherProfile: SemanticPrivacyProfile | undefined): SemanticProjectArtifact => {
      if (!isObject(value) || !hasOnly(value, ["als", "pages"])) throw new Error("each diff side must be an object with exactly one of als or pages");
      if (value.als !== undefined) {
        if (!isObject(value.als) || !hasOnly(value.als, ["path", "allowedRoot", "profile"])) throw new Error("an als side requires path and allowedRoot with optional profile");
        const alsArgs = value.als as Record<string, unknown>;
        const authority = this.alsFileAuthority(alsArgs.path, alsArgs.allowedRoot);
        const { source, model } = readAlsModel(authority.canonicalPath);
        return createOfflineAlsArtifact(source, model, { profile: this.alsProfileParam(alsArgs.profile, otherProfile ?? "collaboration"), exporterVersion: PACKAGE_VERSION });
      }
      if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 512) throw new Error("a pages side requires 1-512 complete pages");
      return assembleSemanticProjectPages(value.pages as SemanticProjectPage[]);
    };
    try {
      const before = side(params.before, undefined);
      const after = side(params.after, before.policy.profile);
      if (before.policy.profile !== after.policy.profile) throw new Error("semantic diff sides must share one privacy profile");
      const diff = diffSemanticProjectSnapshots(before, after);
      return this.successText(id, pageSemanticProjectDiff(diff, { ...(params.limit !== undefined ? { limit: params.limit as number } : {}), ...(params.cursor !== undefined ? { cursor: params.cursor as string } : {}) }));
    } catch (cause) { return this.adapterToolError(id, cause, "Offline .als diff requires owner-authorized files or complete untampered page bundles with one shared privacy profile; no merge was attempted."); }
  }

  private async liveProjectInfoAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, [])) return error(id, -32602, "no arguments accepted");
    try {
      this.requireConnected("session.read");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const filePath = snapshot.set.filePath;
      if (typeof filePath !== "string" || filePath.length === 0) return this.successText(id, { exists: false, note: "the current set has never been saved to disk" });
      return this.successText(id, projectInfo(filePath));
    } catch (cause) { return this.adapterToolError(id, cause, "Project info requires the current set path and host file access."); }
  }

  private async liveProjectBackupPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["confirmation", "allowedRoot"]) || params.confirmation !== "backup" || !isNonEmptyString(params.allowedRoot, 4096)) return error(id, -32602, "confirmation=backup and an explicit absolute allowedRoot are required");
    try {
      this.requireConnected("session.read");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const filePath = snapshot.set.filePath;
      if (typeof filePath !== "string" || filePath.length === 0) return this.transactionError(id, "the current set has never been saved to disk; save it through Live's UI first (save is a negotiated API limitation)");
      const manifest = projectInfo(filePath); if (!manifest.sha256 || manifest.size === undefined || manifest.mtimeMs === undefined) throw new Error("current Set manifest is unavailable");
      const fence = JSON.stringify({ path: filePath, size: manifest.size, mtimeMs: manifest.mtimeMs, sha256: manifest.sha256 });
      const transaction: ClipLifecycleTransaction = { id: `backup_${randomBytes(18).toString("base64url")}`, epoch: (this.safeAdapterStatus().epoch ?? 0) as number, kind: "backup", fence, payload: { path: filePath, allowedRoot: params.allowedRoot, size: manifest.size, mtimeMs: manifest.mtimeMs, sha256: manifest.sha256 }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "project backup");
      return this.successText(id, { transactionId: transaction.id, path: filePath, manifest: { size: manifest.size, mtimeMs: manifest.mtimeMs, sha256: manifest.sha256 }, allowedRoot: params.allowedRoot, impact: "creates-verified-backup", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Project backup preview requires the current set path."); }
  }

  private async liveProjectBackupApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "backup" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired backup transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", backup: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const snapshot = await this.asyncAdapter().snapshotAsync();
      if (snapshot.set.filePath !== transaction.payload.path) return this.transactionError(id, "the current set path changed since preview; preview again");
      const current = projectInfo(transaction.payload.path as string); const currentFence = JSON.stringify({ path: current.path, size: current.size, mtimeMs: current.mtimeMs, sha256: current.sha256 });
      if (currentFence !== transaction.fence) return this.transactionError(id, "the current Set content changed since preview; preview again");
      const result = projectBackup(transaction.payload.path as string, { allowedRoot: transaction.payload.allowedRoot as string, expectedSha256: transaction.payload.sha256 as string, expectedSize: transaction.payload.size as number, expectedMtimeMs: transaction.payload.mtimeMs as number });
      if (!result.verified) throw new Error("backup verification failed");
      transaction.created = result as unknown as Record<string, unknown>;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", backup: result.backup, manifest: result.manifest, verified: result.verified, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Project backup is uncertain; verify the backup file before relying on it."); }
  }

  private async liveSubscribeAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const types = ["transport", "object", "reset"];
    const validTypes = !isObject(params) || params.types === undefined || (Array.isArray(params.types) && params.types.length <= types.length && new Set(params.types).size === params.types.length && params.types.every((item: unknown) => typeof item === "string" && types.includes(item)));
    if (!isObject(params) || !hasOnly(params, ["types"]) || !validTypes) return error(id, -32602, "types must be a unique bounded subset of transport, object, reset");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("subscriptions")) throw new Error("subscriptions are unavailable");
      if (!(status.operations ?? []).includes("subscribe")) throw new Error("subscription operation is unavailable");
      const adapter = this.asyncAdapter();
      const subscribeArgs: Record<string, unknown> = {};
      if (params.types !== undefined) subscribeArgs.types = params.types;
      const result = await adapter.invokeAsync({ operation: "subscribe", args: subscribeArgs }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { subscribed?: unknown; subscriptionId?: unknown };
      if (result.subscribed !== true || typeof result.subscriptionId !== "string") throw new Error("subscription was not confirmed");
      return this.successText(id, { subscribed: true, subscriptionId: result.subscriptionId, epoch: status.epoch, resnapshot: "use live_snapshot for a fresh authoritative state at any point" });
    } catch (cause) { return this.adapterToolError(id, cause, "Subscription requires a connected Live adapter."); }
  }

  private async liveUnsubscribeAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, [])) return error(id, -32602, "no arguments accepted");
    try {
      const adapter = this.asyncAdapter();
      const result = await adapter.invokeAsync({ operation: "subscribe", args: { types: [] } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { subscribed?: unknown };
      return this.successText(id, { subscribed: result.subscribed === true });
    } catch (cause) { return this.adapterToolError(id, cause, "Unsubscribe failed."); }
  }

  private async liveRecordingPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["action", "lane", "intent", "destinationTrackRef", "outputSafety"]) || (params.action !== "start" && params.action !== "stop") || (params.lane !== "session" && params.lane !== "arrangement") || !isNonEmptyString(params.intent, 256)) return error(id, -32602, "action, lane, and intent are required");
    try {
      this.validateOutputSafety(params.outputSafety);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.lane === "session" ? "recording.session" : "recording.arrangement";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} control is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const transport = snapshot.playback?.transport;
      if (!transport) throw new Error("authoritative playback state is unavailable");
      let destinationTrackIdentity: string | null = null;
      if (params.action === "start") {
        const alreadyRecording = params.lane === "session" ? transport.sessionRecord === true : transport.arrangementRecord === true;
        if (alreadyRecording) throw new Error(`${params.lane} recording is already active`);
        if (!isNonEmptyString(params.destinationTrackRef, 256)) throw new Error("recording start requires an explicit destination track");
        const destination = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.destinationTrackRef);
        if (!destination || !isNonEmptyString(destination.objectIdentity, 256)) throw new Error("destination track identity is not authoritative");
        destinationTrackIdentity = destination.objectIdentity;
        if (destination.armed !== true) throw new Error("destination track is not armed for recording; arm it through live_routing_preview first");
        const additionallyArmed = (snapshot.tracks as unknown as JsonObject[]).filter((item) => item.ref !== params.destinationTrackRef && item.armed === true);
        if (additionallyArmed.length > 0) throw new Error("recording start requires the exact destination to be the only armed track");
      }
      const fence = JSON.stringify({ sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord, playing: transport.playing });
      const transaction: ClipLifecycleTransaction = { id: `recording_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "recording", fence, payload: { action: params.action, lane: params.lane, intent: params.intent, outputSafety: structuredClone(params.outputSafety as JsonObject), destinationTrackRef: params.action === "start" ? params.destinationTrackRef : null, destinationTrackIdentity }, prior: { sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "recording");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, lane: params.lane, intent: params.intent, prior: transaction.prior, impact: params.action === "start" ? "starts-recording" : "stops-recording", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Recording preview refused; obtain fresh authoritative state and explicit output-safety evidence."); }
  }

  private async liveRecordingApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "recording" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired recording transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const transport = snapshot.playback?.transport;
      if (!reconciliation && (!transport || JSON.stringify({ sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord, playing: transport.playing }) !== transaction.fence)) { transaction.state = "uncertain"; return this.transactionError(id, "recording state changed since preview; preview again"); }
      if (!reconciliation && transaction.payload.action === "start") {
        const destinationRef = transaction.payload.destinationTrackRef;
        const armed = (snapshot.tracks as unknown as JsonObject[]).filter((track) => track.armed === true);
        if (!isNonEmptyString(destinationRef, 256) || !isNonEmptyString(transaction.payload.destinationTrackIdentity, 256) || armed.length !== 1 || armed[0]?.ref !== destinationRef || armed[0]?.objectIdentity !== transaction.payload.destinationTrackIdentity) { transaction.state = "uncertain"; return this.transactionError(id, "recording arm or destination identity changed since preview; preview again"); }
      }
      const operation = transaction.payload.lane === "session" ? "recording.session" : "recording.arrangement";
      const prior = transaction.prior as Record<string, unknown>;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args: {
        action: transaction.payload.action,
        expectedSessionRecord: prior.sessionRecord,
        expectedArrangementRecord: prior.arrangementRecord,
        destinationTrackRef: transaction.payload.destinationTrackRef ?? null,
        destinationTrackIdentity: transaction.payload.destinationTrackIdentity ?? null,
        outputSafety: transaction.payload.outputSafety,
      } }, context) as { recording?: unknown };
      const expected = transaction.payload.action === "start";
      if (result.recording !== expected) throw new Error("recording change was not confirmed");
      // Recording state applies asynchronously; confirm through fresh reads.
      const recordField = transaction.payload.lane === "session" ? "sessionRecord" : "arrangementRecord";
      let confirmed = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        if (after.playback.transport[recordField] === expected) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error("recording change was not confirmed by fresh playback state");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", recording: result.recording, lane: transaction.payload.lane, idempotent: false });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain";
      if (transaction.state === "previewed") delete transaction.applyKey;
      return this.adapterToolError(id, cause, "Recording state is uncertain; perform fresh discovery and use the emergency stop path if needed.");
    }
  }

  private realtimeParameterTargets(snapshot: LiveSnapshot, references: string[]): JsonObject[] {
    const available = new Map<string, JsonObject>();
    const add = (reference: string, value: unknown, details: JsonObject, authority: JsonObject): void => {
      available.set(reference, { ref: reference, value: typeof value === "number" && Number.isFinite(value) ? value : null, ...details, authority });
    };
    let authorityBudget = 0;
    let exhausted = false;
    const consumeAuthority = (amount: number): boolean => {
      if (authorityBudget + amount > 1024) { exhausted = true; return false; }
      authorityBudget += amount;
      return true;
    };
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      if (exhausted) break;
      const trackRef = typeof track.ref === "string" ? track.ref : undefined;
      const trackIdentity = typeof track.objectIdentity === "string" ? track.objectIdentity : undefined;
      const mixer = isObject(track.mixer) ? track.mixer : undefined;
      if (mixer && trackRef && trackIdentity) {
        const mixerRows: Array<{ ref: string; objectIdentity: string; value: unknown; kind: string; sendIndex?: number }> = [];
        let complete = true;
        for (const [ref, objectIdentity, value, kind] of [[mixer.volumeRef, mixer.volumeIdentity, mixer.volume, "mixer-volume"], [mixer.panRef, mixer.panIdentity, mixer.pan, "mixer-pan"], [mixer.cueRef, mixer.cueIdentity, mixer.cueVolume, "mixer-cue"]]) {
          if (ref === null || ref === undefined) { if (objectIdentity !== null && objectIdentity !== undefined) complete = false; continue; }
          if (typeof ref !== "string" || typeof objectIdentity !== "string") { complete = false; continue; }
          mixerRows.push({ ref, objectIdentity, value, kind: String(kind) });
        }
        const sendRefs = Array.isArray(mixer.sendRefs) ? mixer.sendRefs : [];
        const sends = Array.isArray(mixer.sends) ? mixer.sends : [];
        const sendIdentities = Array.isArray(mixer.sendIdentities) ? mixer.sendIdentities : [];
        if (sendRefs.length !== sendIdentities.length) complete = false;
        sendRefs.forEach((ref, index) => {
          if (typeof ref !== "string" || typeof sendIdentities[index] !== "string") { complete = false; return; }
          mixerRows.push({ ref, objectIdentity: sendIdentities[index], value: sends[index], kind: "mixer-send", sendIndex: index });
        });
        if (!complete || mixerRows.length > 256 || !consumeAuthority(mixerRows.length)) { exhausted = true; break; }
        const siblings = mixerRows.map(({ ref, objectIdentity }) => ({ ref, objectIdentity }));
        for (const row of mixerRows) add(row.ref, row.value, { kind: row.kind, parameterIdentity: row.objectIdentity, trackRef, trackIdentity, ...(row.sendIndex === undefined ? {} : { sendIndex: row.sendIndex }) }, { ref: row.ref, parameterIdentity: row.objectIdentity, ownerRef: trackRef, ownerIdentity: trackIdentity, trackRef, trackIdentity, siblings });
      }
      const visitDevices = (candidate: unknown): void => {
        if (exhausted) return;
        if (!Array.isArray(candidate) || candidate.length > 256 || !candidate.every(isObject)) { exhausted = true; return; }
        for (const device of candidate) {
          if (!consumeAuthority(1)) return;
          const deviceRef = typeof device.ref === "string" ? device.ref : undefined;
          const deviceIdentity = typeof device.objectIdentity === "string" ? device.objectIdentity : undefined;
          const rawParameters = Array.isArray(device.parameters) ? device.parameters : [];
          const rawMacros = Array.isArray(device.macros) ? device.macros : [];
          const rowsComplete = rawParameters.every(isObject) && rawMacros.every(isObject) && rawParameters.length + rawMacros.length <= 256;
          if (!rowsComplete) { exhausted = true; return; }
          const parameters = rawParameters as JsonObject[];
          const rows = [...parameters, ...rawMacros as JsonObject[]];
          if (!consumeAuthority(rows.length)) return;
          const siblingRows = rows.map((row) => typeof row.ref === "string" && typeof row.objectIdentity === "string" ? { ref: row.ref, objectIdentity: row.objectIdentity } : undefined);
          const siblings = siblingRows.every((row) => row !== undefined) ? siblingRows as Array<{ ref: string; objectIdentity: string }> : undefined;
          if (trackRef && trackIdentity && deviceRef && deviceIdentity && siblings) for (const [index, parameter] of rows.entries()) {
            const parameterRef = parameter.ref as string;
            const parameterIdentity = parameter.objectIdentity as string;
            const kind = index < parameters.length ? "device-parameter" : "rack-macro";
            add(parameterRef, parameter.value, { kind, parameterIdentity, deviceRef, deviceIdentity, trackRef, trackIdentity, ...(kind === "device-parameter" ? { min: parameter.min ?? null, max: parameter.max ?? null, enabled: parameter.enabled ?? null, automatable: parameter.automatable ?? null, revision: parameter.revision ?? null } : {}) }, { ref: parameterRef, parameterIdentity, ownerRef: deviceRef, ownerIdentity: deviceIdentity, trackRef, trackIdentity, siblings });
          }
          const chains = Array.isArray(device.chains) ? device.chains : [];
          if (chains.length > 256 || !chains.every(isObject)) { exhausted = true; return; }
          for (const chain of chains) { if (!consumeAuthority(1)) return; visitDevices(chain.devices); if (exhausted) return; }
          const drumPads = Array.isArray(device.drumPads) ? device.drumPads : [];
          if (drumPads.length > 256 || !drumPads.every(isObject)) { exhausted = true; return; }
          for (const pad of drumPads) {
            if (!consumeAuthority(1)) return;
            const padChains = Array.isArray(pad.chains) ? pad.chains : [];
            if (padChains.length > 256 || !padChains.every(isObject)) { exhausted = true; return; }
            for (const chain of padChains) { if (!consumeAuthority(1)) return; visitDevices(chain.devices); if (exhausted) return; }
          }
        }
      };
      visitDevices(track.devices ?? []);
    }
    return references.map((reference) => {
      const target = available.get(reference);
      if (!target || !isObject(target.authority)) throw new Error(`realtime parameter ref lacks exact authoritative identity: ${reference}`);
      return target;
    });
  }

  private async liveRealtimeArmPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const allowedChannels = new Set(["udp-json", "osc", "xy", "max"]);
    const validChannels = isObject(params) && Array.isArray(params.channels) && params.channels.length >= 1 && params.channels.length <= 4 && new Set(params.channels).size === params.channels.length && params.channels.every((item) => typeof item === "string" && allowedChannels.has(item));
    const validParameterRefs = isObject(params) && Array.isArray(params.parameterRefs) && params.parameterRefs.length <= 32 && new Set(params.parameterRefs).size === params.parameterRefs.length && params.parameterRefs.every((item) => isNonEmptyString(item, 256));
    const validSourcePorts = isObject(params) && (params.sourcePorts === undefined || (Array.isArray(params.sourcePorts) && params.sourcePorts.length <= 16 && new Set(params.sourcePorts).size === params.sourcePorts.length && params.sourcePorts.every((item) => isIntegerInRange(item, 1, 65535))));
    if (!isObject(params) || !hasOnly(params, ["ttlMs", "channels", "parameterRefs", "sourcePorts", "outputSafety"]) || !validChannels || !validParameterRefs || !validSourcePorts || (params.ttlMs !== undefined && !isIntegerInRange(params.ttlMs, 1000, 30000))) return error(id, -32602, "channels, parameterRefs, optional ttlMs/sourcePorts, and outputSafety are invalid");
    try {
      this.validateOutputSafety(params.outputSafety);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || status.provenance !== "real-live") throw new Error("realtime control requires authoritative real-Live provenance");
      for (const operation of ["realtime.arm", "realtime.disarm", "realtime.stats"]) if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const ttlMs = (params.ttlMs as number | undefined) ?? 10_000;
      const parameterRefs = [...(params.parameterRefs as string[])];
      const targets = parameterRefs.length > 0 ? this.realtimeParameterTargets(await this.asyncAdapter().snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }), parameterRefs) : [];
      const targetAuthorities = targets.map((target) => structuredClone(target.authority));
      const payload: Record<string, unknown> = { ttlMs, channels: structuredClone(params.channels), parameterRefs, targetAuthorities, outputSafety: structuredClone(params.outputSafety as JsonObject) };
      if (params.sourcePorts !== undefined) payload.sourcePorts = structuredClone(params.sourcePorts);
      const fence = JSON.stringify({ epoch: status.epoch, registryHash: status.registryHash, operations: ["realtime.arm", "realtime.disarm", "realtime.stats"], targets });
      const transaction: ClipLifecycleTransaction = { id: `realtime_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "realtime-arm", fence, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "realtime arm");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ttlMs, channels: payload.channels, parameterTargets: targets, sourcePorts: payload.sourcePorts ?? [], outputSafety: payload.outputSafety, impact: "temporarily-authorizes-bounded-realtime-control", packetLimitBytes: 512, sustainedRatePerSecond: 64, burst: 16, confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Realtime arming requires configured loopback UDP, real-Live provenance, and explicit output-safety evidence."); }
  }

  private async liveRealtimeArmApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "realtime-arm" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired realtime-arm transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", endpoint: transaction.created, idempotent: true });
    if (transaction.state === "applying") {
      if (transaction.applyKey !== params.idempotencyKey || !transaction.inflight) return this.transactionError(id, "Realtime arm apply is already in progress with a different request");
      try {
        const endpoint = await transaction.inflight;
        return this.successText(id, { transactionId: transaction.id, state: "applied", endpoint, idempotent: true, recovery: "live_realtime_disarm or live_session_emergency_stop remains independent of a realtime packet" });
      } catch (cause) { return this.adapterToolError(id, cause, "Realtime arm state is uncertain; disarm through the authenticated control channel before retrying."); }
    }
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    transaction.state = "applying";
    transaction.applyKey = params.idempotencyKey as string;
    const inflight = this.dispatchRealtimeArmApply(transaction, signal);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const endpoint = await inflight;
      return this.successText(id, { transactionId: transaction.id, state: "applied", endpoint, idempotent: false, recovery: "live_realtime_disarm or live_session_emergency_stop remains independent of a realtime packet" });
    } catch (cause) { return this.adapterToolError(id, cause, "Realtime arm state is uncertain; disarm through the authenticated control channel before retrying."); }
  }

  private async dispatchRealtimeArmApply(transaction: ClipLifecycleTransaction, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      this.validateOutputSafety(transaction.payload.outputSafety);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || status.provenance !== "real-live" || status.epoch !== transaction.epoch) throw new Error("Live connection or provenance changed; preview again");
      const parameterRefs = transaction.payload.parameterRefs as string[];
      const targets = parameterRefs.length > 0 ? this.realtimeParameterTargets(await this.asyncAdapter().snapshotAsync({ signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id }), parameterRefs) : [];
      if (JSON.stringify({ epoch: status.epoch, registryHash: status.registryHash, operations: ["realtime.arm", "realtime.disarm", "realtime.stats"], targets }) !== transaction.fence) throw new Error("realtime control contract or parameter targets changed; preview again");
      if (signal?.aborted) throw new Error("realtime arm cancelled before dispatch");
      const args: Record<string, unknown> = { ttlMs: transaction.payload.ttlMs, channels: transaction.payload.channels, parameterRefs, targetAuthorities: targets.map((target) => target.authority), outputSafety: transaction.payload.outputSafety };
      if (transaction.payload.sourcePorts !== undefined) args.sourcePorts = transaction.payload.sourcePorts;
      const result = await this.asyncAdapter().invokeAsync({ operation: "realtime.arm", args }, { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id }) as Record<string, unknown>;
      if (!isIntegerInRange(result.port, 1, 65535) || !isNonEmptyString(result.host, 64) || !isNonEmptyString(result.token, 128) || !Number.isInteger(result.expiresAt) || (result.expiresAt as number) <= Date.now() || !Array.isArray(result.channels) || JSON.stringify(result.channels) !== JSON.stringify(transaction.payload.channels) || !Array.isArray(result.parameterRefs) || JSON.stringify(result.parameterRefs) !== JSON.stringify(parameterRefs)) throw new Error("realtime arming was not confirmed with the requested bounded endpoint and exact targets");
      transaction.created = structuredClone(result);
      transaction.state = "applied";
      return transaction.created;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain";
      throw cause;
    }
  }

  private async liveRealtimeDisarmAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["confirmation"]) || params.confirmation !== "disarm") return error(id, -32602, "confirmation=disarm is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.operations ?? []).includes("realtime.disarm")) throw new Error("realtime disarm is unavailable");
      const result = await this.asyncAdapter().invokeAsync({ operation: "realtime.disarm", args: {} }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as Record<string, unknown>;
      if (result.armed !== false) throw new Error("realtime disarm was not confirmed");
      return this.successText(id, { armed: false, disarmed: true });
    } catch (cause) { return this.adapterToolError(id, cause, "Realtime disarm failed; use the separately authorized emergency-stop path if playback may be active."); }
  }

  private async liveRealtimeStatsAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, [])) return error(id, -32602, "no arguments accepted");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.operations ?? []).includes("realtime.stats")) throw new Error("realtime stats are unavailable");
      const result = await this.asyncAdapter().invokeAsync({ operation: "realtime.stats", args: {} }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as Record<string, unknown>;
      return this.successText(id, result);
    } catch (cause) { return this.adapterToolError(id, cause, "Realtime stats require the configured loopback control plane."); }
  }

  private flattenDeviceRows(values: unknown): JsonObject[] {
    const flattened: JsonObject[] = [];
    const visit = (value: unknown): void => {
      if (!isObject(value) || flattened.length >= 512) return;
      flattened.push(value);
      if (Array.isArray(value.chains)) for (const chain of value.chains) if (isObject(chain) && Array.isArray(chain.devices)) for (const device of chain.devices) visit(device);
      if (Array.isArray(value.drumPads)) for (const pad of value.drumPads) if (isObject(pad) && Array.isArray(pad.chains)) for (const chain of pad.chains) if (isObject(chain) && Array.isArray(chain.devices)) for (const device of chain.devices) visit(device);
    };
    if (Array.isArray(values)) for (const value of values) visit(value);
    return flattened;
  }

  private deviceRow(snapshot: LiveSnapshot, deviceRef: LiveRef): { track: JsonObject; device: JsonObject; ownerRef: string; ownerIdentity: string; siblings: Array<{ ref: string; objectIdentity: string }> } {
    const visit = (values: unknown, ownerRef: string, ownerIdentity: string): { device: JsonObject; ownerRef: string; ownerIdentity: string; siblings: Array<{ ref: string; objectIdentity: string }> } | undefined => {
      if (!Array.isArray(values)) return undefined;
      const siblings = values.map((item) => {
        if (!isObject(item) || typeof item.ref !== "string" || typeof item.objectIdentity !== "string") throw new Error("device sibling identity is unavailable");
        return { ref: item.ref, objectIdentity: item.objectIdentity };
      });
      for (const value of values) {
        if (!isObject(value)) continue;
        if (value.ref === deviceRef) return { device: value, ownerRef, ownerIdentity, siblings };
        if (Array.isArray(value.chains)) for (const chain of value.chains) if (isObject(chain) && typeof chain.ref === "string" && typeof chain.objectIdentity === "string") { const found = visit(chain.devices, chain.ref, chain.objectIdentity); if (found) return found; }
        if (Array.isArray(value.drumPads)) for (const pad of value.drumPads) if (isObject(pad) && Array.isArray(pad.chains)) for (const chain of pad.chains) if (isObject(chain) && typeof chain.ref === "string" && typeof chain.objectIdentity === "string") { const found = visit(chain.devices, chain.ref, chain.objectIdentity); if (found) return found; }
      }
      return undefined;
    };
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      if (typeof track.ref !== "string" || typeof track.objectIdentity !== "string") continue;
      const found = visit(track.devices, track.ref, track.objectIdentity);
      if (found) return { track, ...found };
    }
    throw new Error("device reference is not authoritative");
  }

  private deviceFence(row: { track: JsonObject; device: JsonObject; ownerRef: string; ownerIdentity: string; siblings: Array<{ ref: string; objectIdentity: string }> }): string {
    return JSON.stringify({ ref: row.device.ref, objectIdentity: row.device.objectIdentity, track: row.track.ref, ownerRef: row.ownerRef, ownerIdentity: row.ownerIdentity, siblings: row.siblings, enabled: row.device.enabled ?? null });
  }

  private trackDeviceAuthority(track: JsonObject): { expectedTrackIdentity: string; expectedSiblings: Array<{ ref: string; objectIdentity: string }> } {
    if (!isNonEmptyString(track.objectIdentity, 256) || !Array.isArray(track.devices) || track.devices.length > 256) throw new Error("track device authority is incomplete");
    const siblings = (track.devices as unknown[]).map((device) => {
      if (!isObject(device) || !isNonEmptyString(device.ref, 256) || !isNonEmptyString(device.objectIdentity, 256)) throw new Error("device sibling identity is incomplete");
      return { ref: device.ref, objectIdentity: device.objectIdentity };
    });
    return { expectedTrackIdentity: track.objectIdentity, expectedSiblings: siblings };
  }

  private async deleteOwnedDeviceAsync(adapter: AsyncLiveAdapter, reference: LiveRef, objectIdentity: string, context: LiveOperationContext, expectedFingerprint?: string, recoveryRecord?: object, allowAbsent = false): Promise<void> {
    const snapshot = await adapter.snapshotAsync(context); let located: ReturnType<McpHost["deviceRow"]>;
    try { located = this.deviceRow(snapshot, reference); } catch (cause) { if (allowAbsent) return; throw cause; }
    if (located.device.objectIdentity !== objectIdentity) throw new Error("owned device identity changed before cleanup");
    if (expectedFingerprint && this.captureObjectFingerprint(located.device) !== expectedFingerprint) throw new Error("transaction-owned device was modified after creation; cleanup refused");
    const args = { ref: reference, expectedObjectIdentity: objectIdentity, expectedOwnerRef: located.ownerRef, expectedOwnerIdentity: located.ownerIdentity, expectedSiblings: located.siblings, expectedTrackRef: located.track.ref, expectedTrackIdentity: located.track.objectIdentity };
    if (recoveryRecord) await this.invokeUndoRecovery(recoveryRecord, adapter, "device.delete", args, context); else await adapter.invokeAsync({ operation: "device.delete", args }, context);
    try { this.deviceRow(await adapter.snapshotAsync(context), reference); } catch { return; }
    throw new Error("owned device cleanup was not confirmed");
  }

  private async liveBrowserSearchAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const categories = ["instruments", "audio_effects", "midi_effects", "drums", "plugins", "packs", "max_for_live", "clips"];
    if (!isObject(params) || !hasOnly(params, ["category", "query", "limit"]) || (params.category !== undefined && !categories.includes(String(params.category))) || (params.query !== undefined && !isNonEmptyString(params.query, 256) && params.query !== "") || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 100))) return error(id, -32602, "category, query, and limit are invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("browser.search")) throw new Error("the Live Browser is unavailable");
      const adapter = this.asyncAdapter();
      const searchArgs: Record<string, unknown> = {};
      if (params.category !== undefined) searchArgs.category = params.category;
      if (params.query !== undefined) searchArgs.query = params.query;
      if (params.limit !== undefined) searchArgs.limit = params.limit;
      const result = await adapter.invokeAsync({ operation: "browser.search", args: searchArgs }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { items?: unknown };
      return this.successText(id, { items: Array.isArray(result.items) ? result.items : [] });
    } catch (cause) { return this.adapterToolError(id, cause, "Browser search requires an available Live Browser."); }
  }

  /** Revision-bound opaque paging for read-only probe surfaces: cursors carry
   * the content revision so external edits invalidate them instead of silently
   * returning shifted pages. */
  private probePage<T>(items: T[], revision: string, limit: unknown, cursor: unknown, maxLimit: number): { items: T[]; total: number; returned: number; complete: boolean; nextCursor?: string } {
    const boundedLimit = limit === undefined ? maxLimit : limit;
    if (!Number.isInteger(boundedLimit) || (boundedLimit as number) < 1 || (boundedLimit as number) > maxLimit) throw new RangeError(`limit must be an integer from 1 to ${maxLimit}`);
    let offset = 0;
    if (cursor !== undefined) {
      if (!isNonEmptyString(cursor, 1024)) throw new RangeError("cursor is invalid");
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new RangeError("cursor is invalid"); }
      if (!isObject(decoded) || decoded.revision !== revision || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 0 || (decoded.offset as number) > items.length) throw new Error("probe cursor is stale; request a fresh first page");
      offset = decoded.offset as number;
    }
    const page = items.slice(offset, offset + (boundedLimit as number));
    const nextOffset = offset + page.length;
    const complete = nextOffset >= items.length;
    return { items: page, total: items.length, returned: page.length, complete, ...(complete ? {} : { nextCursor: Buffer.from(JSON.stringify({ revision, offset: nextOffset })).toString("base64url") }) };
  }

  private probeEnvelope(status: LiveStatus): Record<string, unknown> {
    return { adapter: status.adapter, provenance: status.provenance ?? "unknown", epoch: status.epoch, protocol: status.protocol, environment: status.environment ?? null };
  }

  private async liveArrangementAutomationReadAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "parameterRef", "limit", "cursor"]) || !isNonEmptyString(params.clipRef, 256) || !isNonEmptyString(params.parameterRef, 256)) return error(id, -32602, "clipRef and parameterRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("arrangement.read")) throw new Error("arrangement read capability is unavailable");
      if (!(status.operations ?? []).includes("arrangement.automation.read")) throw new Error("arrangement automation read is unavailable");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const located = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (!located.arrangement) throw new Error("arrangement automation requires an exact Arrangement clip reference");
      if (!isNonEmptyString(located.clip.objectIdentity, 256)) throw new Error("arrangement clip identity is not authoritative");
      const parameter = this.parameterRow(snapshot, params.parameterRef as LiveRef);
      const read = await adapter.invokeAsync({ operation: "arrangement.automation.read", args: { clipRef: params.clipRef, parameterRef: params.parameterRef } }, context) as { available?: unknown; exists?: unknown; points?: unknown };
      if (typeof read.available !== "boolean" || typeof read.exists !== "boolean" || !Array.isArray(read.points) || read.points.length > 512) throw new Error("arrangement automation read returned an unbounded or malformed result");
      const points = read.points.filter(isObject).map((point) => ({ time: point.time, value: point.value })).filter((point) => typeof point.time === "number" && Number.isFinite(point.time) && typeof point.value === "number" && Number.isFinite(point.value)).sort((a, b) => (a.time as number) - (b.time as number));
      if (points.length !== read.points.length) throw new Error("arrangement automation points are unreadable");
      const revision = createHash("sha256").update(canonicalMutationIdentity({ clipRef: params.clipRef, clipIdentity: located.clip.objectIdentity, parameterRef: params.parameterRef, points })).digest("hex");
      const page = this.probePage(points, revision, params.limit, params.cursor, 512);
      return this.successText(id, {
        clip: { ref: params.clipRef, objectIdentity: located.clip.objectIdentity, arrangement: true, start: located.clip.start, length: located.clip.length },
        parameter: { ref: params.parameterRef, name: typeof parameter.name === "string" ? parameter.name : null, ownerRef: typeof parameter.parentRef === "string" ? parameter.parentRef : null, identity: typeof parameter.objectIdentity === "string" ? parameter.objectIdentity : null },
        envelope: { available: read.available, exists: read.exists },
        range: points.length > 0 ? { from: points[0]!.time, to: points[points.length - 1]!.time } : null,
        points: page.items,
        paging: { limit: page.returned, total: page.total, complete: page.complete, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), pointBound: 512 },
        curve: { available: false, reason: "curve shapes are not exposed by the negotiated arrangement.automation.read contract" },
        revision,
        sessionState: {
          arrangementOverdub: snapshot.song?.arrangementOverdub ?? null,
          sessionAutomationRecord: snapshot.song?.sessionAutomationRecord ?? null,
          reEnableAutomationEnabled: snapshot.song?.reEnableAutomationEnabled ?? null,
          note: snapshot.song ? "authoritative song automation-record state at read time" : "the adapter did not expose song automation-record state; external controller state is not authoritatively enumerable",
        },
        mutation: { advertised: false, note: "no arrangement automation create/delete/insert operation is advertised; mutation requires a separate reviewed issue with exact prior-state restoration evidence" },
        probe: this.probeEnvelope(status),
      });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement automation read requires a fresh authoritative shape; restart paging from the first page when a cursor is stale."); }
  }

  private async liveTakeLaneReadAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["trackRef", "limit", "cursor"]) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "trackRef is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("takes")) throw new Error("take-lane read capability is unavailable");
      if (!(status.operations ?? []).includes("audio.take-lane.read")) throw new Error("take-lane read is unavailable");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const read = await adapter.invokeAsync({ operation: "audio.take-lane.read", args: { trackRef: params.trackRef } }, context) as { lanes?: unknown };
      if (!Array.isArray(read.lanes) || read.lanes.length > 128) throw new Error("take-lane read returned an unbounded or malformed result");
      const advertised = read.lanes.filter(isObject).map((lane) => ({ ref: lane.ref, name: lane.name }));
      if (advertised.some((lane) => !isNonEmptyString(lane.ref, 256) || typeof lane.name !== "string")) throw new Error("take-lane identity is malformed");
      const snapshot = await adapter.snapshotAsync(context);
      const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.trackRef);
      if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("take-lane track identity is not authoritative");
      const laneRows = ((track.takeLanes as unknown[]) ?? []).filter(isObject);
      const lanes = advertised.map((advertisedLane) => {
        const row = laneRows.find((candidate) => candidate.ref === advertisedLane.ref);
        const clips = ((row?.clips as unknown[]) ?? []).filter(isObject).map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity ?? null, start: clip.start, length: clip.length, fingerprint: createHash("sha256").update(canonicalMutationIdentity({ ref: clip.ref, objectIdentity: clip.objectIdentity ?? null, content: this.boundedClipContentDigest(clip) })).digest("hex") }));
        return { ref: advertisedLane.ref, name: advertisedLane.name, index: typeof row?.index === "number" ? row.index : null, objectIdentity: typeof row?.objectIdentity === "string" ? row.objectIdentity : null, clips, clipCount: clips.length };
      });
      const laneRevision = createHash("sha256").update(canonicalMutationIdentity({ trackRef: params.trackRef, trackIdentity: track.objectIdentity, lanes })).digest("hex");
      const mainLaneClips = (snapshot.arrangementClips ?? []).filter((item) => item.trackRef === params.trackRef).map((item) => ({ ref: item.clip.ref, objectIdentity: item.clip.objectIdentity ?? null, start: item.clip.start, length: item.clip.length }));
      const page = this.probePage(lanes, laneRevision, params.limit, params.cursor, 128);
      return this.successText(id, {
        track: { ref: params.trackRef, objectIdentity: track.objectIdentity },
        lanes: page.items,
        mainLane: { arrangementClips: mainLaneClips, clipCount: mainLaneClips.length },
        paging: { limit: page.returned, total: page.total, complete: page.complete, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), laneBound: 128 },
        revision: laneRevision,
        relationships: { compSourceSegments: "not enumerable through the public LOM; see live_comp_read for adapter-negotiated segment evidence", audition: "not started by this tool", mutation: "no lane creation/deletion, take promotion, or main-lane change is performed" },
        probe: this.probeEnvelope(status),
      });
    } catch (cause) { return this.adapterToolError(id, cause, "Take-lane read requires a fresh authoritative track; restart paging from the first page when a cursor is stale."); }
  }

  private async liveCompReadAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "limit", "cursor"]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("takes")) throw new Error("comp read capability is unavailable");
      if (!(status.operations ?? []).includes("audio.comp.read")) throw new Error("comp read is unavailable on this Live shape (the public LOM exposes no comp-region API)");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const located = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (!isNonEmptyString(located.clip.objectIdentity, 256)) throw new Error("comp read requires exact clip identity");
      const read = await adapter.invokeAsync({ operation: "audio.comp.read", args: { clipRef: params.clipRef } }, context) as { segments?: unknown };
      if (!Array.isArray(read.segments) || read.segments.length > 512) throw new Error("comp read returned an unbounded or malformed result");
      const track = located.track as JsonObject | undefined;
      const laneRows = ((track?.takeLanes as unknown[]) ?? []).filter(isObject);
      const segments = read.segments.filter(isObject).map((segment) => {
        const lane = laneRows.find((candidate) => candidate.ref === segment.laneRef);
        return { laneRef: segment.laneRef, laneName: typeof lane?.name === "string" ? lane.name : null, laneIdentity: typeof lane?.objectIdentity === "string" ? lane.objectIdentity : null, from: segment.from, to: segment.to };
      }).filter((segment) => typeof segment.laneRef === "string" && typeof segment.from === "number" && Number.isFinite(segment.from) && typeof segment.to === "number" && Number.isFinite(segment.to) && (segment.to as number) > (segment.from as number));
      if (segments.length !== read.segments.length) throw new Error("comp segments are unreadable");
      segments.sort((a, b) => (a.from as number) - (b.from as number));
      const revision = createHash("sha256").update(canonicalMutationIdentity({ clipRef: params.clipRef, clipIdentity: located.clip.objectIdentity, segments })).digest("hex");
      const page = this.probePage(segments, revision, params.limit, params.cursor, 512);
      return this.successText(id, {
        clip: { ref: params.clipRef, objectIdentity: located.clip.objectIdentity, start: located.clip.start, length: located.clip.length },
        segments: page.items,
        paging: { limit: page.returned, total: page.total, complete: page.complete, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), segmentBound: 512 },
        revision,
        relationships: { sourceHighlightFidelity: "not inferred; the public LOM exposes no comp-promotion or source-highlight API", note: "segments are adapter-reported only when audio.comp.read is negotiated; no best-take ranking is performed" },
        probe: this.probeEnvelope(status),
      });
    } catch (cause) { return this.adapterToolError(id, cause, "Comp read requires a fresh authoritative clip; unsupported relationships are reported explicitly, never inferred."); }
  }

  private async liveWarpMarkerReadAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "limit", "cursor"]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("warp")) throw new Error("warp capability is unavailable");
      if (!(status.operations ?? []).includes("audio.warp-marker.read")) throw new Error("warp-marker read is unavailable");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const located = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (located.clip.kind !== "audio" && located.clip.isAudio !== true) throw new Error("warp markers require an audio clip");
      const read = await adapter.invokeAsync({ operation: "audio.warp-marker.read", args: { ref: params.clipRef } }, context) as { revision?: unknown; markers?: unknown };
      if (!isNonEmptyString(read.revision, 64) || !Array.isArray(read.markers) || read.markers.length > 256) throw new Error("warp-marker read returned an unbounded or malformed result");
      const markers = read.markers.filter(isObject).map((marker) => ({ beatTime: marker.beatTime, sampleTime: marker.sampleTime })).filter((marker) => typeof marker.beatTime === "number" && Number.isFinite(marker.beatTime) && typeof marker.sampleTime === "number" && Number.isFinite(marker.sampleTime)).sort((a, b) => (a.beatTime as number) - (b.beatTime as number));
      if (markers.length !== read.markers.length) throw new Error("warp markers are unreadable");
      const beatMonotonic = markers.every((marker, index) => index === 0 || (marker.beatTime as number) > (markers[index - 1]!.beatTime as number));
      const sampleMonotonic = markers.every((marker, index) => index === 0 || (marker.sampleTime as number) >= (markers[index - 1]!.sampleTime as number));
      const collectionRevision = this.warpMarkerCollectionRevision(markers as Array<{ beatTime: number; sampleTime: number }>);
      const page = this.probePage(markers, collectionRevision, params.limit, params.cursor, 256);
      const operations = new Set(status.operations ?? []);
      return this.successText(id, {
        clip: { ref: params.clipRef, objectIdentity: typeof located.clip.objectIdentity === "string" ? located.clip.objectIdentity : null },
        markers: page.items,
        paging: { limit: page.returned, total: page.total, complete: page.complete, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), markerBound: 256 },
        monotonic: { beatTime: beatMonotonic, sampleTime: sampleMonotonic },
        revisions: { adapter: read.revision, collection: collectionRevision, clipAuthority: this.clipAuthorityDigest(snapshot, params.clipRef as LiveRef) },
        identity: { addressedBy: "beatTime", stableMarkerIdsExposed: false, note: "the API exposes no separate warp-marker identity; repeated reads prove only collection-revision stability" },
        mutationFeasibility: {
          add: operations.has("audio.warp-marker.add"), move: operations.has("audio.warp-marker.move"), delete: operations.has("audio.warp-marker.delete"),
          advertisedByThisTool: false,
          note: "read-only probe: mutation feasibility is reported from negotiated operations only; a guarded mutation requires a separate reviewed issue with complete prior-state restoration",
        },
        probe: this.probeEnvelope(status),
      });
    } catch (cause) { return this.adapterToolError(id, cause, "Warp-marker read requires a fresh authoritative audio clip; restart paging from the first page when a cursor is stale."); }
  }

  private async liveBrowserInspectAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["itemId"]) || !isNonEmptyString(params.itemId, 256)) return error(id, -32602, "itemId is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("browser")) throw new Error("browser capability is unavailable");
      if (!(status.operations ?? []).includes("browser.inspect")) throw new Error("browser item inspection is unavailable");
      const adapter = this.asyncAdapter();
      const item = await adapter.invokeAsync({ operation: "browser.inspect", args: { itemId: params.itemId } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { id?: unknown; objectIdentity?: unknown; name?: unknown; category?: unknown; path?: unknown; isDevice?: unknown };
      if (item.id !== params.itemId || !isNonEmptyString(item.objectIdentity, 256) || typeof item.name !== "string" || typeof item.category !== "string" || typeof item.isDevice !== "boolean") throw new Error("browser item lacks exact authoritative identity");
      // The browser-internal path (e.g. "instruments/Drum Rack") is metadata, not
      // a filesystem path; raw private paths are never returned by this surface.
      const internalPath = typeof item.path === "string" && !item.path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(item.path) ? item.path : null;
      const identityRevision = createHash("sha256").update(canonicalMutationIdentity({ id: item.id, objectIdentity: item.objectIdentity, name: item.name, category: item.category, path: internalPath, isDevice: item.isDevice })).digest("hex");
      const operations = status.operations ?? [];
      const loadable = item.isDevice === true && operations.includes("browser.load");
      return this.successText(id, {
        item: { id: item.id, name: item.name, category: item.category, path: internalPath, isDevice: item.isDevice },
        identity: { objectIdentity: item.objectIdentity, revision: identityRevision },
        loadability: { loadable, reason: loadable ? "loadable through live_browser_load_preview with exact identity fencing" : item.isDevice === true ? "browser.load is not negotiated on this Live shape" : "only device items are loadable; samples, clips, and packs report inspect-only" },
        provenance: { adapter: status.adapter, epoch: status.epoch, operations: ["browser.inspect"] },
      });
    } catch (cause) { return this.adapterToolError(id, cause, "Browser inspection requires an available Live Browser and an exact item id from a fresh search."); }
  }

  private async liveBrowserLoadPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["itemId", "trackRef"]) || !isNonEmptyString(params.itemId, 256) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "itemId and trackRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("browser.load") || !(status.operations ?? []).includes("browser.inspect")) throw new Error("browser loading or item inspection is unavailable");
      const adapter = this.asyncAdapter();
      const item = await adapter.invokeAsync({ operation: "browser.inspect", args: { itemId: params.itemId } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { id?: unknown; objectIdentity?: unknown; name?: unknown; isDevice?: unknown; path?: unknown; category?: unknown };
      if (item.id !== params.itemId || item.isDevice !== true || typeof item.name !== "string" || !isNonEmptyString(item.objectIdentity, 256)) throw new Error("browser item lacks exact track-loadable identity");
      const snapshot = await adapter.snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.trackRef);
      if (!track || !["regular", "group", "audio", "midi"].includes(String(track.kind))) throw new Error("browser loading is limited to regular Set tracks");
      const authority = this.trackDeviceAuthority(track);
      const fence = JSON.stringify({ track: params.trackRef, ...authority });
      const transaction: ClipLifecycleTransaction = { id: `browserload_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "browser-load", fence, clipRef: params.trackRef as LiveRef, payload: { itemId: params.itemId, trackRef: params.trackRef, expectedName: item.name, expectedItemIdentity: item.objectIdentity, ...authority }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "browser load");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, item: { id: item.id, name: item.name, path: item.path, category: item.category, isDevice: true }, trackRef: params.trackRef, impact: "loads-browser-device", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Browser-load preview requires fresh authoritative state."); }
  }

  private async liveBrowserLoadApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "browser-load" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired browser-load transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.payload.trackRef);
        if (!track || !["regular", "group", "audio", "midi"].includes(String(track.kind)) || JSON.stringify({ track: transaction.payload.trackRef, ...this.trackDeviceAuthority(track) }) !== transaction.fence) return this.transactionError(id, "track identity or devices changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "browser.load", args: transaction.payload }, context) as { loaded?: unknown; deviceRef?: unknown; deviceObjectIdentity?: unknown; createdFingerprint?: unknown };
      if (result.loaded !== true || !isNonEmptyString(result.deviceRef, 256) || !isNonEmptyString(result.deviceObjectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64)) throw new Error("browser load did not return exact created device identity");
      const createdDevice = this.deviceRow(await adapter.snapshotAsync(context), result.deviceRef as LiveRef); if (createdDevice.device.objectIdentity !== result.deviceObjectIdentity) throw new Error("browser-loaded device identity was not confirmed");
      if (this.captureObjectFingerprint(createdDevice.device) !== result.createdFingerprint) throw new Error("browser-loaded device creation fingerprint was not confirmed");
      transaction.created = { deviceRef: result.deviceRef, objectIdentity: result.deviceObjectIdentity, fingerprint: result.createdFingerprint };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", deviceRef: transaction.created.deviceRef, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Browser load is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveDevicePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (isObject(params) && params.action === "delete") return this.transactionError(id, "Arbitrary device deletion is unavailable; use live_undo only for an exact transaction-created device");
    const actions = ["insert", "enable", "move"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "trackRef", "deviceName", "deviceRef", "index", "enabled"]) || !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "action insert/enable/move is required; arbitrary device deletion is unavailable");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const payload: Record<string, unknown> = { action: params.action };
      let fence = ""; let prior: Record<string, unknown> | undefined;
      if (params.action === "insert") {
        if (!(status.operations ?? []).includes("device.insert")) throw new Error("device insertion is unavailable");
        if (!isNonEmptyString(params.trackRef, 256) || !isNonEmptyString(params.deviceName, 256)) return error(id, -32602, "trackRef and deviceName are required for insert");
        if (params.index !== undefined && (!Number.isInteger(params.index) || (params.index as number) < -1 || (params.index as number) > 256)) return error(id, -32602, "index is invalid");
        const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.trackRef);
        if (!track) throw new Error("track is not authoritative");
        const authority = this.trackDeviceAuthority(track);
        payload.trackRef = params.trackRef; payload.deviceName = params.deviceName; Object.assign(payload, authority);
        if (params.index !== undefined) payload.index = params.index;
        fence = JSON.stringify({ track: params.trackRef, ...authority });
      } else {
        if (!isNonEmptyString(params.deviceRef, 256)) return error(id, -32602, "deviceRef is required");
        const operation = params.action === "enable" ? "device.enable" : "device.move";
        if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
        const located = this.deviceRow(snapshot, params.deviceRef as LiveRef); const { device } = located;
        if (!isNonEmptyString(device.objectIdentity, 256)) throw new Error("device object identity is unavailable");
        if (params.action === "enable" && typeof params.enabled !== "boolean") return error(id, -32602, "enabled must be boolean");
        if (params.action === "move" && (!Number.isInteger(params.index) || (params.index as number) < 0 || (params.index as number) > 256)) return error(id, -32602, "index is invalid");
        payload.ref = params.deviceRef; payload.expectedObjectIdentity = device.objectIdentity; payload.expectedOwnerRef = located.ownerRef; payload.expectedOwnerIdentity = located.ownerIdentity; payload.expectedSiblings = located.siblings; payload.expectedTrackRef = located.track.ref; payload.expectedTrackIdentity = located.track.objectIdentity;
        if (params.action === "enable") { if (typeof device.enabled !== "boolean") throw new Error("device enable state is unavailable"); payload.enabled = params.enabled; payload.expectedStateRevision = createHash("sha256").update(canonicalMutationIdentity({ enabled: device.enabled })).digest("hex"); prior = { enabled: device.enabled }; }
        if (params.action === "move") { payload.index = params.index; prior = { index: located.siblings.findIndex((sibling) => sibling.ref === device.ref) }; }
        fence = this.deviceFence(located);
      }
      const transaction: ClipLifecycleTransaction = { id: `device_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device", fence, clipRef: (params.deviceRef ?? params.trackRef) as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, payload, impact: `device-${params.action}`, confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device preview requires fresh authoritative state."); }
  }

  private async liveDeviceApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired device transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const action = transaction.payload.action as string;
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context);
        if (action === "insert") { const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.payload.trackRef);
          if (!track || JSON.stringify({ track: transaction.payload.trackRef, ...this.trackDeviceAuthority(track) }) !== transaction.fence) return this.transactionError(id, "track identity or devices changed since preview; preview again");
        } else { const located = this.deviceRow(snapshot, transaction.payload.ref as LiveRef); if (this.deviceFence(located) !== transaction.fence) return this.transactionError(id, "device state changed since preview; preview again"); }
      }
      const operation = action === "insert" ? "device.insert" : action === "enable" ? "device.enable" : "device.move";
      const args: Record<string, unknown> = { ...transaction.payload };
      delete args.action;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      if ((action === "insert" || action === "move") && (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || (action === "insert" && !isNonEmptyString(result.createdFingerprint, 64)))) throw new Error(`device ${action} did not return exact identity`);
      if (action === "move" && result.objectIdentity !== transaction.payload.expectedObjectIdentity) throw new Error("device move returned a different object identity");
      transaction.created = result;
      if (action === "insert") { const createdDevice = this.deviceRow(await adapter.snapshotAsync(context), result.ref as LiveRef); if (createdDevice.device.objectIdentity !== result.objectIdentity || this.captureObjectFingerprint(createdDevice.device) !== result.createdFingerprint) throw new Error("inserted device identity or creation fingerprint was not confirmed"); transaction.created.fingerprint = result.createdFingerprint; }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Device state is uncertain; perform fresh discovery before retrying."); }
  }

  private mixerTarget(snapshot: LiveSnapshot, trackRef: LiveRef): { track: JsonObject; mixer: JsonObject } {
    const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === trackRef);
    if (!track || !isObject(track.mixer) || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track with an exact authoritative mixer identity is required");
    const mixer = track.mixer as JsonObject;
    const nullableIdentity = (value: unknown): boolean => value === null || isNonEmptyString(value, 256);
    if (!nullableIdentity(mixer.volumeIdentity) || !nullableIdentity(mixer.panIdentity) || !nullableIdentity(mixer.cueIdentity) || !Array.isArray(mixer.sendIdentities) || !mixer.sendIdentities.every((identity) => isNonEmptyString(identity, 256)) || !Array.isArray(mixer.sendRefs) || mixer.sendRefs.length !== mixer.sendIdentities.length) throw new Error("mixer parameter identities are incomplete");
    return { track, mixer };
  }

  private mixerRow(snapshot: LiveSnapshot, trackRef: LiveRef): JsonObject { return this.mixerTarget(snapshot, trackRef).mixer; }

  private mixerAuthority(target: { track: JsonObject; mixer: JsonObject }): JsonObject {
    const state = Object.fromEntries(["volume", "pan", "mute", "solo", "cueVolume", "sends"].map((field) => [field, structuredClone(target.mixer[field] ?? null)]));
    return { expectedObjectIdentity: target.track.objectIdentity, expectedVolumeIdentity: target.mixer.volumeIdentity, expectedPanIdentity: target.mixer.panIdentity, expectedCueIdentity: target.mixer.cueIdentity, expectedSendIdentities: structuredClone(target.mixer.sendIdentities), expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
  }

  private async liveMixerPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["volume", "pan", "mute", "solo", "cueVolume", "sends"] as const;
    if (!isObject(params) || !hasOnly(params, ["trackRef", ...fields]) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "trackRef is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "mute" || field === "solo") { if (typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`); }
      else if (field === "sends") { if (!Array.isArray(value) || value.length > 64 || !value.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1)) return error(id, -32602, "sends must be 0-1 values"); }
      else if (typeof value !== "number" || !Number.isFinite(value) || (field === "pan" ? Math.abs(value) > 1 : (value < 0 || value > 1))) return error(id, -32602, `${field} is out of bounds`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one mixer field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("mixer.set")) throw new Error("mixer editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const target = this.mixerTarget(snapshot, params.trackRef as LiveRef); const mixer = target.mixer;
      if (Array.isArray(proposed.sends) && (proposed.sends as unknown[]).length > (mixer.sends as unknown[]).length) throw new Error("track has fewer sends than proposed");
      if (proposed.cueVolume !== undefined && mixer.cueRef === null) throw new Error("cue volume is unavailable on this track");
      if (proposed.volume !== undefined && mixer.volumeRef === null) throw new Error("volume is unavailable on this track");
      if (proposed.pan !== undefined && mixer.panRef === null) throw new Error("pan is unavailable on this track");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = structuredClone(mixer[field] ?? null);
      const fence = JSON.stringify({ ref: params.trackRef, objectIdentity: target.track.objectIdentity, mixer });
      const transaction: ClipLifecycleTransaction = { id: `mixer_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "mixer-set", fence, clipRef: params.trackRef as LiveRef, payload: { ref: params.trackRef, ...proposed, ...this.mixerAuthority(target) }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "mixer");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, trackRef: params.trackRef, prior, proposed, impact: "edits-mixer", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Mixer preview requires fresh authoritative state."); }
  }

  private async liveMixerApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "mixer-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired mixer transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const target = this.mixerTarget(await adapter.snapshotAsync(context), transaction.clipRef!); const mixer = target.mixer;
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: target.track.objectIdentity, mixer }) !== transaction.fence) return this.transactionError(id, "mixer target or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "mixer.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("mixer change was not confirmed");
      const verified = this.mixerTarget(await adapter.snapshotAsync(context), transaction.clipRef!); for (const field of ["volume", "pan", "mute", "solo", "cueVolume", "sends"]) if (Object.prototype.hasOwnProperty.call(transaction.payload, field) && JSON.stringify(verified.mixer[field]) !== JSON.stringify(transaction.payload[field])) throw new Error("mixer postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Mixer state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveViewPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["zoom-in", "zoom-out", "scroll-left", "scroll-right", "follow-on", "follow-off", "collapse-track", "expand-track", "hide-view", "focus-view", "browser-toggle"] as const;
    if (!isObject(params) || !hasOnly(params, ["view", "action", "trackRef"])) return error(id, -32602, "view or action is required");
    if (params.action === "hide-view" || params.action === "focus-view") { if (!isNonEmptyString(params.view, 64)) return error(id, -32602, "view name is required for hide/focus actions"); }
    else if ((params.view === undefined) === (params.action === undefined)) return error(id, -32602, "exactly one of view or action is required");
    if (params.view !== undefined && !isNonEmptyString(params.view, 64)) return error(id, -32602, "view must be a 1-64 character string");
    if (params.action !== undefined && !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "action is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = (params.view !== undefined && params.action === undefined) ? "view.set" : "view.control";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const proposed: Record<string, unknown> = {};
      if (params.action === "hide-view" || params.action === "focus-view") { proposed.action = params.action; proposed.view = params.view; }
      else if (params.view !== undefined) proposed.view = params.view;
      else {
        proposed.action = params.action;
        if (params.action === "collapse-track" || params.action === "expand-track") {
          if (!isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "trackRef is required for track collapse actions");
          const snapshot = await this.asyncAdapter().snapshotAsync();
          if (!(snapshot.tracks as unknown as JsonObject[]).some((candidate) => candidate.ref === params.trackRef)) throw new Error("track reference is unknown");
          proposed.trackRef = params.trackRef;
        }
      }
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const prior = { view: snapshot.view ?? null };
      const fence = JSON.stringify({ operation, proposed, epoch: status.epoch });
      const transaction: ClipLifecycleTransaction = { id: `view_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "view", fence, payload: { operation, ...proposed }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "view");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, operation, proposed, prior, impact: "changes-live-ui", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "View preview requires a fresh connection."); }
  }

  private async liveViewApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "view" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired view transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const operation = transaction.payload.operation;
      if (operation !== "view.set" && operation !== "view.control") return this.transactionError(id, "view transaction payload is invalid");
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "operation"));
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      if (operation === "view.set" && result.visible !== true) throw new Error("view change was not confirmed");
      if (operation === "view.control" && result.done !== true) throw new Error("view control was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "View state is uncertain; check Live's visible view before retrying."); }
  }

  private async liveLocatorJumpPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["direction", "ref"])) return error(id, -32602, "direction (next|previous) or ref is required");
    if ((params.direction === undefined) === (params.ref === undefined)) return error(id, -32602, "exactly one of direction or ref is required");
    if (params.direction !== undefined && params.direction !== "next" && params.direction !== "previous") return error(id, -32602, "direction must be next or previous");
    if (params.ref !== undefined && !isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (params.ref !== undefined) {
        if (!(status.operations ?? []).includes("locator.jump-to")) throw new Error("locator jump-to is unavailable");
        const snapshot = await this.asyncAdapter().snapshotAsync();
        const locator = (snapshot.arrangement.locators ?? []).find((candidate) => candidate.ref === params.ref);
        if (!locator || !isNonEmptyString(locator.objectIdentity, 256)) return this.transactionError(id, "locator reference is unknown");
        const collectionRevision = createHash("sha256").update(canonicalMutationIdentity(snapshot.arrangement.locators)).digest("hex");
        const payload: Record<string, unknown> = { ref: params.ref, expectedObjectIdentity: locator.objectIdentity, expectedCollectionRevision: collectionRevision };
        const fence = JSON.stringify({ ref: params.ref, objectIdentity: locator.objectIdentity, locators: snapshot.arrangement.locators.map((item) => item.position) });
        const transaction: ClipLifecycleTransaction = { id: `locjump_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "locator-jump", fence, payload: { jumpTo: true, ...payload }, prior: { position: snapshot.playback.transport.position ?? 0, target: locator.position }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
        this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "locator jump");
        return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, target: locator.position, impact: "moves-playhead", confirmation: "apply", expiresAt: transaction.expiresAt });
      }
      if (!(status.operations ?? []).includes("locator.jump")) throw new Error("locator jump is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const position = (snapshot.playback.transport.position ?? 0) as number;
      const times = ((snapshot.arrangement.locators ?? []) as Array<{ position?: unknown }>).map((locator) => locator.position).filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
      const target = params.direction === "next" ? times.find((time) => time > position + 1e-9) ?? null : [...times].reverse().find((time) => time < position - 1e-9) ?? null;
      const fence = JSON.stringify({ direction: params.direction, position, locators: times });
      const transaction: ClipLifecycleTransaction = { id: `locjump_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "locator-jump", fence, payload: { direction: params.direction }, prior: { position, target }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "locator jump");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, direction: params.direction, current: position, target, impact: "moves-playhead", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Locator-jump preview requires fresh authoritative state."); }
  }

  private async liveLocatorJumpApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "locator-jump" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired locator-jump transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) {
        const snapshot = await adapter.snapshotAsync(context);
        if (transaction.payload.jumpTo === true) {
          const locator = (snapshot.arrangement.locators ?? []).find((candidate) => candidate.ref === transaction.payload.ref);
          const fence = JSON.stringify({ ref: transaction.payload.ref, objectIdentity: locator?.objectIdentity, locators: (snapshot.arrangement.locators ?? []).map((item) => item.position) });
          if (!locator || fence !== transaction.fence) return this.transactionError(id, "locator identity or collection changed since preview; preview again");
        } else {
          const position = (snapshot.playback.transport.position ?? 0) as number;
          const times = ((snapshot.arrangement.locators ?? []) as Array<{ position?: unknown }>).map((locator) => locator.position).filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
          if (JSON.stringify({ direction: transaction.payload.direction, position, locators: times }) !== transaction.fence) return this.transactionError(id, "Playhead or locators changed since preview; preview again");
        }
      }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = transaction.payload.jumpTo === true
        ? await adapter.invokeAsync({ operation: "locator.jump-to", args: { ref: transaction.payload.ref, expectedObjectIdentity: transaction.payload.expectedObjectIdentity, expectedCollectionRevision: transaction.payload.expectedCollectionRevision } }, context) as Record<string, unknown>
        : await adapter.invokeAsync({ operation: "locator.jump", args: { direction: transaction.payload.direction } }, context) as Record<string, unknown>;
      if (typeof result.position !== "number" || !Number.isFinite(result.position) || result.position < 0) throw new Error("locator jump was not confirmed");
      if (transaction.payload.jumpTo === true && Math.abs(result.position - ((transaction.prior as { target: number }).target)) > 1e-6) throw new Error("locator jump did not land on the exact cue");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Playhead state is uncertain; perform fresh discovery before retrying."); }
  }

  private clipPropertiesMutationAuthority(snapshot: LiveSnapshot, clipRef: LiveRef): JsonObject {
    const located = this.clipRow(snapshot, clipRef); const fields = ["muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove", "launchMode", "launchQuantization", "legato", "ramMode", "velocityAmount"];
    const state = Object.fromEntries(fields.map((field) => [field, located.clip[field] ?? null]));
    const expectedAuthorityRevision = this.clipAuthorityDigest(snapshot, clipRef);
    return { expectedObjectIdentity: located.clip.objectIdentity, expectedAuthorityRevision, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
  }

  private async liveClipPropertiesPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["muted", "colorIndex", "looping", "loopStart", "loopEnd", "launchMode", "launchQuantization", "legato", "ramMode", "velocityAmount"] as const;
    if (!isObject(params) || !hasOnly(params, ["clipRef", "grooveRef", ...fields]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "muted" || field === "looping" || field === "legato" || field === "ramMode") { if (typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`); }
      else if (field === "colorIndex") { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 69) return error(id, -32602, "colorIndex is out of bounds"); }
      else if (field === "launchMode") { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 3) return error(id, -32602, "launchMode is out of bounds"); }
      else if (field === "launchQuantization") { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 14) return error(id, -32602, "launchQuantization is out of bounds"); }
      else if (field === "velocityAmount") { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return error(id, -32602, "velocityAmount is out of bounds"); }
      else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return error(id, -32602, `${field} is out of bounds`);
      proposed[field] = value;
    }
    if (params.grooveRef !== undefined && params.grooveRef !== null && !isNonEmptyString(params.grooveRef, 256)) return error(id, -32602, "grooveRef must be a groove reference or null");
    if (params.grooveRef !== undefined) proposed.grooveRef = params.grooveRef;
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one clip field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("clip.set")) throw new Error("clip editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (row.clip.isAudio === true && Object.keys(proposed).some((field) => field === "looping" || field === "loopStart" || field === "loopEnd")) return this.transactionError(id, "audio clip loop editing uses live_audio_clip_preview");
      if (row.clip.isAudio === true && proposed.velocityAmount !== undefined) return this.transactionError(id, "velocityAmount is only available on MIDI clips");
      if (row.clip.isAudio !== true && proposed.ramMode !== undefined) return this.transactionError(id, "ramMode is only available on audio clips");
      if ((proposed.launchMode !== undefined || proposed.launchQuantization !== undefined) && (row.clip.isPlaying === true || row.clip.isTriggered === true)) return this.transactionError(id, "launch behavior changes on a playing or triggered clip are refused");
      if (fields.some((field) => proposed[field] !== undefined && (row.clip[field] === null || row.clip[field] === undefined))) return this.transactionError(id, "one or more requested clip fields are unavailable on this exact clip");
      if (params.grooveRef !== undefined && params.grooveRef !== null) { const grooves = (snapshot.groovePool?.grooves ?? []); if (!grooves.some((groove) => groove.ref === params.grooveRef)) return this.transactionError(id, "groove reference is unknown"); }
      const finalStart = (proposed.loopStart ?? row.clip.loopStart ?? null) as number | null; const finalEnd = (proposed.loopEnd ?? row.clip.loopEnd ?? null) as number | null;
      if (finalStart !== null && finalEnd !== null && finalStart > finalEnd) return error(id, -32602, "loopStart must not exceed loopEnd");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) { if (field === "grooveRef") prior.groove = structuredClone(row.clip.groove ?? null); else prior[field] = row.clip[field] ?? null; }
      const authority = this.clipPropertiesMutationAuthority(snapshot, params.clipRef as LiveRef);
      const fence = JSON.stringify({ ref: params.clipRef, objectIdentity: authority.expectedObjectIdentity, fields: fields.map((field) => row.clip[field] ?? null) });
      const transaction: ClipLifecycleTransaction = { id: `clipset_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "clip-set", fence, clipRef: params.clipRef as LiveRef, payload: { ref: params.clipRef, ...proposed, ...authority }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip properties");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, prior, proposed, impact: "edits-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-properties preview requires fresh authoritative state."); }
  }

  private async liveClipPropertiesApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "clip-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-properties transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const fields = ["muted", "colorIndex", "looping", "loopStart", "loopEnd", "launchMode", "launchQuantization", "legato", "ramMode", "velocityAmount"] as const;
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, transaction.clipRef!);
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: row.clip.objectIdentity, fields: fields.map((field) => row.clip[field] ?? null) }) !== transaction.fence) return this.transactionError(id, "clip identity or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "clip.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("clip change was not confirmed");
      const verified = this.clipRow(await adapter.snapshotAsync(context), transaction.clipRef!).clip; for (const field of fields) if (Object.prototype.hasOwnProperty.call(transaction.payload, field) && verified[field] !== transaction.payload[field]) throw new Error("clip postcondition was not confirmed");
      if (Object.prototype.hasOwnProperty.call(transaction.payload, "grooveRef")) { const observedRef = (verified.groove as { ref?: unknown } | null | undefined)?.ref ?? null; if (observedRef !== transaction.payload.grooveRef) throw new Error("clip groove assignment was not confirmed"); }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip state is uncertain; perform fresh discovery before retrying."); }
  }

  private static readonly AUDIO_IMPORT_EXTENSIONS = new Set([".wav", ".wave", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);
  private static readonly AUDIO_IMPORT_MAX_BYTES = 512 * 1024 * 1024;

  /** Container magic-byte validation: the declared extension must match the
   * file's actual container signature (fail closed on mismatch). */
  private static audioImportHeaderMatches(extension: string, header: Buffer): boolean {
    const ascii = (from: number, to: number): string => header.subarray(from, to).toString("latin1");
    if (extension === ".wav" || extension === ".wave") return header.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    if (extension === ".aif" || extension === ".aiff") return header.length >= 12 && ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 12));
    if (extension === ".flac") return header.length >= 4 && ascii(0, 4) === "fLaC";
    if (extension === ".ogg") return header.length >= 4 && ascii(0, 4) === "OggS";
    if (extension === ".mp3") return header.length >= 3 && (ascii(0, 3) === "ID3" || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0));
    if (extension === ".m4a") return header.length >= 8 && ascii(4, 8) === "ftyp";
    return false;
  }

  private async audioImportFileAuthority(filePath: unknown, allowedRoot: unknown): Promise<{ canonicalPath: string; size: number; mtimeMs: number; sha256: string }> {
    if (!isNonEmptyString(filePath, 1024) || !isNonEmptyString(allowedRoot, 1024)) throw new Error("filePath and allowedRoot are required");
    if (!(filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath))) throw new Error("filePath must be an absolute path");
    const canonicalRoot = realpathSync(allowedRoot);
    const canonicalPath = realpathSync(filePath);
    if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep)) throw new Error("filePath escapes the allowed root");
    const stats = statSync(canonicalPath);
    if (!stats.isFile()) throw new Error("filePath is not a regular file");
    if (stats.size <= 0 || stats.size > McpHost.AUDIO_IMPORT_MAX_BYTES) throw new Error("filePath size is outside the import bound");
    const extension = canonicalPath.slice(canonicalPath.lastIndexOf(".")).toLowerCase();
    if ([".mid", ".midi"].includes(extension)) throw new Error("MIDI file import has no negotiated canonical operation in this version; no Session MIDI-file import is claimed (follow-up surface)");
    if (!McpHost.AUDIO_IMPORT_EXTENSIONS.has(extension)) throw new Error("filePath type is not an importable audio file");
    {
      const { open } = await import("node:fs/promises");
      const probe = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await probe.read(header, 0, 12, 0);
        if (!McpHost.audioImportHeaderMatches(extension, header.subarray(0, bytesRead))) throw new Error("file content does not match the declared audio format");
      } finally { await probe.close(); }
    }
    const sha256 = await new Promise<string>((resolvePromise, rejectPromise) => {
      const hash = createHash("sha256"); const stream = createReadStream(canonicalPath);
      stream.on("data", (chunk) => hash.update(chunk)); stream.on("end", () => resolvePromise(hash.digest("hex"))); stream.on("error", rejectPromise);
    });
    return { canonicalPath, size: stats.size, mtimeMs: stats.mtimeMs, sha256 };
  }

  private importStagingRoot(): string {
    // Persistent, owner-controlled managed media directory (never $TMPDIR):
    // Live references imported audio in place, so a staged copy becomes the
    // clip's or Simpler's media once an apply succeeds. Staged files are
    // released only on no-consumer paths (preview failure, transaction
    // expiry/eviction/finalization, pre-dispatch refusals, failed apply, and
    // undo after the clip is deleted) — never on apply success, host
    // shutdown, or wall-clock age. Canonicalize once; containment checks
    // compare canonical paths.
    if (this.importStagingDir === undefined) {
      const configured = this.importStagingDirOption ?? process.env.ABLETON_MCP_IMPORT_STAGING_DIR;
      if (configured !== undefined && !isAbsolute(configured)) throw new Error("import staging directory override must be an absolute path");
      const appData = process.env.APPDATA;
      const root = configured ?? (process.platform === "win32" ? joinPath(appData !== undefined && isAbsolute(appData) ? appData : joinPath(homedir(), "AppData", "Roaming"), "ableton-mcp", "import-staging") : joinPath(homedir(), ".config", "ableton-mcp", "import-staging"));
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const stats = lstatSync(root);
      if (!stats.isDirectory()) throw new Error("import staging root is not a directory");
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("import staging root is not owned by the current user");
      chmodSync(root, 0o700);
      this.importStagingDir = realpathSync(root);
    }
    return this.importStagingDir;
  }
  private importStagingDir: string | undefined;
  private readonly importStagingDirOption: string | undefined;

  /** Re-verify the authorized source through one no-follow descriptor (identity
      and size checked before and after a byte-bounded read), then copy the
      verified bytes through that same descriptor into a transaction-owned
      non-writable staging file. Live only ever receives the staged path, so a
      rename-swap in the allowed directory cannot substitute unauthorized bytes. */
  private async stageVerifiedImportFile(canonicalPath: string, expected: { size: number; sha256: string }): Promise<string> {
    const { open } = await import("node:fs/promises");
    const source = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await source.stat();
      if (!before.isFile() || before.size !== expected.size || before.size <= 0 || before.size > McpHost.AUDIO_IMPORT_MAX_BYTES) throw new Error("audio file changed since preview");
      // Re-validate the container signature through the same no-follow
      // descriptor used for hashing and copying, so a rename-swap after the
      // preview-time probe cannot substitute non-audio bytes.
      const extension = extname(canonicalPath).toLowerCase();
      const header = Buffer.alloc(12);
      const { bytesRead } = await source.read(header, 0, 12, 0);
      if (!McpHost.audioImportHeaderMatches(extension, header.subarray(0, bytesRead))) throw new Error("audio file content no longer matches the declared format");
      const hash = createHash("sha256");
      let read = 0;
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        read += (chunk as Buffer).length;
        if (read > McpHost.AUDIO_IMPORT_MAX_BYTES) throw new Error("audio file exceeds the import bound");
        hash.update(chunk as Buffer);
      }
      const after = await source.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new Error("audio file changed since preview");
      if (hash.digest("hex") !== expected.sha256) throw new Error("audio file changed since preview");
      const stagingPath = joinPath(this.importStagingRoot(), `${randomBytes(12).toString("base64url")}${extname(canonicalPath).toLowerCase()}`);
      const staging = await open(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o444);
      try {
        const copyHash = createHash("sha256");
        for await (const chunk of source.createReadStream({ autoClose: false, start: 0 })) {
          copyHash.update(chunk as Buffer);
          await staging.write(chunk as Buffer);
        }
        if (copyHash.digest("hex") !== expected.sha256) throw new Error("audio file changed since preview");
      } finally { await staging.close(); }
      chmodSync(stagingPath, 0o444);
      return stagingPath;
    } finally { await source.close(); }
  }

  /** Apply-time check of the immutable staged copy: containment, size, and
      hash must still match the preview authority. */
  private async verifyStagedImportFile(stagingPath: string, expected: { size: number; sha256: string }): Promise<void> {
    const canonical = realpathSync(stagingPath);
    if (!canonical.startsWith(this.importStagingRoot() + sep)) throw new Error("staged import path escapes the transaction staging root");
    const stats = statSync(canonical);
    if (!stats.isFile() || stats.size !== expected.size) throw new Error("staged audio file changed since preview");
    const hash = createHash("sha256");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const stream = createReadStream(canonical);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => { if (hash.digest("hex") !== expected.sha256) { rejectPromise(new Error("staged audio file changed since preview")); return; } resolvePromise(); });
      stream.on("error", rejectPromise);
    });
  }

  private releaseStagedImportFile(stagingPath: unknown): void {
    if (typeof stagingPath !== "string" || this.importStagingDir === undefined) return;
    try { if (stagingPath.startsWith(this.importStagingDir + sep)) { chmodSync(stagingPath, 0o600); unlinkSync(stagingPath); } } catch { /* best-effort staging cleanup */ }
  }

  private releaseStagedImportFor(transaction: ClipLifecycleTransaction | undefined): void {
    if (transaction && (transaction.kind === "session-audio-create" || transaction.kind === "simpler")) this.releaseStagedImportFile(transaction.payload?.filePath);
  }

  private clipAuthorityDigest(snapshot: LiveSnapshot, clipRef: LiveRef): string {
    const located = this.clipRow(snapshot, clipRef);
    if (located.takeLane) {
      const laneSiblings = ((located.takeLane.clips as unknown[]) ?? []).filter(isObject).map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity }));
      const takeLaneRevision = createHash("sha256").update(canonicalMutationIdentity(laneSiblings)).digest("hex");
      return createHash("sha256").update(canonicalMutationIdentity({ takeLaneRevision, laneIdentity: located.takeLane.objectIdentity })).digest("hex");
    }
    const authority = this.clipAuthority(snapshot, clipRef);
    if (located.arrangement) return authority.expectedAuthorityRevision as string;
    return createHash("sha256").update(canonicalMutationIdentity(authority)).digest("hex");
  }

  private warpMarkerCollectionRevision(markers: Array<{ beatTime: number; sampleTime: number }>): string {
    const sorted = [...markers].sort((a, b) => a.beatTime - b.beatTime).map((marker) => ({ beatTime: marker.beatTime, sampleTime: marker.sampleTime }));
    return createHash("sha256").update(canonicalMutationIdentity(sorted)).digest("hex");
  }

  private envelopePresenceRevision(snapshot: LiveSnapshot, clipRef: LiveRef): { revision: string; cleared: number } {
    const located = this.clipRow(snapshot, clipRef);
    if (!located.track) throw new Error("envelope clear requires a Session clip");
    const clip = located.clip;
    const walk = (devices: Array<Record<string, unknown>>): Array<Record<string, unknown>> => devices.flatMap((device) => [
      ...((device.parameters as Array<Record<string, unknown>> | undefined) ?? []),
      ...walk(((device.chains as Array<Record<string, unknown>> | undefined) ?? []).flatMap((chain) => (chain.devices as Array<Record<string, unknown>> | undefined) ?? [])),
      ...walk(((device.drumPads as Array<Record<string, unknown>> | undefined) ?? []).flatMap((pad) => ((pad.chains as Array<Record<string, unknown>> | undefined) ?? []).flatMap((chain) => (chain.devices as Array<Record<string, unknown>> | undefined) ?? []))),
    ]);
    const parameters = walk((located.track.devices as unknown as Array<Record<string, unknown>>) ?? []);
    const mixer = located.track.mixer as Record<string, unknown> | undefined;
    if (mixer) {
      for (const ref of [mixer.volumeRef, mixer.panRef, mixer.cueRef, ...((mixer.sendRefs as unknown[]) ?? [])]) if (typeof ref === "string") parameters.push({ ref });
    }
    const envelopes = (clip.envelopes as Record<string, unknown> | undefined) ?? {};
    const presence = parameters.map((parameter) => envelopes[parameter.ref as string] !== undefined);
    return { revision: createHash("sha256").update(canonicalMutationIdentity(presence)).digest("hex"), cleared: presence.filter(Boolean).length };
  }

  private async liveAudioImportPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["filePath", "allowedRoot", "trackRef", "sceneIndex", "takeLaneRef", "position", "name"])) return error(id, -32602, "filePath and allowedRoot plus a Session (trackRef, sceneIndex) or take-lane (takeLaneRef, position) destination are required");
    if (params.takeLaneRef !== undefined && (params.trackRef !== undefined || params.sceneIndex !== undefined)) return error(id, -32602, "takeLaneRef is mutually exclusive with trackRef/sceneIndex");
    if (params.takeLaneRef === undefined && (!Number.isInteger(params.sceneIndex) || (params.sceneIndex as number) < 0 || (params.sceneIndex as number) > 10000)) return error(id, -32602, "sceneIndex is invalid");
    if (params.takeLaneRef !== undefined && (!isNonEmptyString(params.takeLaneRef, 256) || typeof params.position !== "number" || !Number.isFinite(params.position) || params.position < 0)) return error(id, -32602, "takeLaneRef and position are required for a take-lane import");
    if (params.name !== undefined && !isNonEmptyString(params.name, 256)) return error(id, -32602, "name is invalid");
    try {
      const authority = await this.audioImportFileAuthority(params.filePath, params.allowedRoot);
      const stagingPath = await this.stageVerifiedImportFile(authority.canonicalPath, authority);
      // The staged copy is transaction-owned: every preview exit that does not
      // retain a transaction must release it, or the bytes leak in $TMPDIR.
      try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (params.takeLaneRef !== undefined) {
        if (!(status.operations ?? []).includes("take-lane.audio-clip.create")) throw new Error("take-lane audio import is unavailable");
        const snapshot = await this.asyncAdapter().snapshotAsync();
        const lane = this.takeLaneRow(snapshot, params.takeLaneRef as LiveRef);
        if (!isNonEmptyString(lane.lane.objectIdentity, 256)) throw new Error("take-lane identity is not authoritative");
        const laneSiblings = lane.lane.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity }));
        const payload: Record<string, unknown> = { takeLaneRef: params.takeLaneRef, filePath: stagingPath, position: params.position, ...(params.name !== undefined ? { name: params.name } : {}), expectedTakeLaneIdentity: lane.lane.objectIdentity, expectedCollectionRevision: createHash("sha256").update(canonicalMutationIdentity(laneSiblings)).digest("hex") };
        const fence = JSON.stringify({ takeLaneRef: params.takeLaneRef, laneIdentity: lane.lane.objectIdentity, siblings: laneSiblings });
        const transaction: ClipLifecycleTransaction = { id: `audioimport_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "session-audio-create", fence, payload, prior: { file: authority, destination: "take-lane" }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
        this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "audio import");
        return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, takeLaneRef: params.takeLaneRef, position: params.position, file: { path: authority.canonicalPath, size: authority.size, sha256: authority.sha256 }, impact: "creates-take-lane-audio-clip-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
      }
      if (!(status.operations ?? []).includes("session.audio-clip.create")) throw new Error("session audio import is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.trackRef);
      if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is not authoritative");
      const slot = (track.clipSlots as unknown[] ?? []).filter(isObject).find((candidate) => candidate.sceneIndex === params.sceneIndex);
      const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.index === params.sceneIndex);
      if (!slot || !isNonEmptyString(slot.ref, 256) || !isNonEmptyString(slot.objectIdentity, 256) || !scene || !isNonEmptyString(scene.ref, 256) || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("Session import target identity is incomplete");
      if (slot.clipRef) { this.releaseStagedImportFile(stagingPath); return this.transactionError(id, "Session slot is occupied"); }
      const payload: Record<string, unknown> = { trackRef: params.trackRef, sceneIndex: params.sceneIndex, filePath: stagingPath, ...(params.name !== undefined ? { name: params.name } : {}), expectedTrackIdentity: track.objectIdentity, expectedSlotRef: slot.ref, expectedSlotIdentity: slot.objectIdentity, expectedSceneRef: scene.ref, expectedSceneIdentity: scene.objectIdentity };
      const fence = JSON.stringify({ trackRef: params.trackRef, trackIdentity: track.objectIdentity, slotRef: slot.ref, slotIdentity: slot.objectIdentity, sceneRef: scene.ref, sceneIdentity: scene.objectIdentity });
      const transaction: ClipLifecycleTransaction = { id: `audioimport_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "session-audio-create", fence, clipRef: params.trackRef as LiveRef, payload, prior: { file: authority }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "audio import");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, trackRef: params.trackRef, sceneIndex: params.sceneIndex, file: { path: authority.canonicalPath, size: authority.size, sha256: authority.sha256 }, impact: "creates-session-audio-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
      } catch (stagingCause) { this.releaseStagedImportFile(stagingPath); throw stagingCause; }
    } catch (cause) { return this.adapterToolError(id, cause, "Audio-import preview requires fresh authoritative state and a readable file."); }
  }

  private async liveAudioImportApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "session-audio-create" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "Unknown or expired audio-import transaction"); }
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "Live connection epoch changed; preview again"); }
      const previewFile = (transaction.prior as { file?: { canonicalPath: string; size: number; mtimeMs: number; sha256: string } }).file;
      if (!previewFile) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "audio import file authority is missing; preview again"); }
      if (!existsSync(transaction.payload.filePath as string)) return this.transactionError(id, "staged import file is no longer available; preview again");
      // The bytes Live opens are the transaction-owned staged copy verified at
      // preview; the source path is never re-trusted after staging.
      await this.verifyStagedImportFile(transaction.payload.filePath as string, previewFile);
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation && transaction.payload.takeLaneRef !== undefined) {
        const snapshot = await adapter.snapshotAsync(context);
        const lane = this.takeLaneRow(snapshot, transaction.payload.takeLaneRef as LiveRef);
        const laneSiblings = lane.lane.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity }));
        if (JSON.stringify({ takeLaneRef: transaction.payload.takeLaneRef, laneIdentity: lane.lane.objectIdentity, siblings: laneSiblings }) !== transaction.fence) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "take lane or its clips changed since preview; preview again"); }
      }
      if (!reconciliation && transaction.payload.takeLaneRef === undefined) {
        const snapshot = await adapter.snapshotAsync(context);
        const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.trackRef);
        const slot = track && ((track.clipSlots as unknown[]) ?? []).filter(isObject).find((candidate) => candidate.sceneIndex === transaction.payload.sceneIndex);
        const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.index === transaction.payload.sceneIndex);
        if (!track || !slot || !scene || JSON.stringify({ trackRef: transaction.payload.trackRef, trackIdentity: track.objectIdentity, slotRef: slot.ref, slotIdentity: slot.objectIdentity, sceneRef: scene.ref, sceneIdentity: scene.objectIdentity }) !== transaction.fence) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "Session import target changed since preview; preview again"); }
        if (slot.clipRef) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "Session slot became occupied since preview; preview again"); }
      }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: (transaction.payload.takeLaneRef !== undefined ? "take-lane.audio-clip.create" : "session.audio-clip.create") as "session.audio-clip.create" | "take-lane.audio-clip.create", args: transaction.payload }, context) as Record<string, unknown>;
      if (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64) || !isNonEmptyString(result.filePath, 1024)) throw new Error("Session audio import did not return exact identity");
      // Verify the returned ref, destination, identity, and file in a fresh
      // snapshot (and that the ref resolves mapper-side) before marking the
      // transaction applied; the created fingerprint is fenced again at undo.
      const verifiedSnapshot = await adapter.snapshotAsync(context);
      const located = this.clipRow(verifiedSnapshot, result.ref as LiveRef);
      if (located.clip.objectIdentity !== result.objectIdentity) throw new Error("created clip identity was not confirmed by a fresh snapshot");
      if (!isNonEmptyString(located.clip.filePath, 1024)) throw new Error("created clip file was not confirmed by a fresh snapshot");
      if (transaction.payload.takeLaneRef !== undefined) {
        if (located.takeLane?.ref !== transaction.payload.takeLaneRef) throw new Error("created clip destination was not confirmed by a fresh snapshot");
      } else {
        const ownerTrack = located.track;
        if (!ownerTrack || ownerTrack.ref !== transaction.payload.trackRef) throw new Error("created clip destination was not confirmed by a fresh snapshot");
        const ownerSlot = ((ownerTrack.clipSlots as unknown[]) ?? []).filter(isObject).find((slot) => slot.clipRef === result.ref);
        if (!ownerSlot || ownerSlot.sceneIndex !== transaction.payload.sceneIndex) throw new Error("created clip destination was not confirmed by a fresh snapshot");
      }
      const mapperRow = await adapter.getAsync(result.ref as LiveRef, context) as Record<string, unknown> | undefined;
      if (!mapperRow || mapperRow.objectIdentity !== result.objectIdentity) throw new Error("created clip ref does not resolve against the authoritative mapper");
      transaction.created = result;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      // The staged copy is now the created clip's media: Live references the
      // path in place from the managed staging directory. It is released only
      // by undo (after the clip is deleted) — never on apply success.
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Audio-import state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveWarpMarkerPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "action", "beatTime", "distance"]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    if (params.action !== "add" && params.action !== "move" && params.action !== "delete") return error(id, -32602, "action must be add, move, or delete");
    if (typeof params.beatTime !== "number" || !Number.isFinite(params.beatTime)) return error(id, -32602, "beatTime is invalid");
    if (params.action === "move" && (typeof params.distance !== "number" || !Number.isFinite(params.distance))) return error(id, -32602, "distance is required for move");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.action === "add" ? "audio.warp-marker.add" : params.action === "move" ? "audio.warp-marker.move" : "audio.warp-marker.delete";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const adapter = this.asyncAdapter();
      const snapshot = await adapter.snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (row.clip.kind !== "audio" && row.clip.isAudio !== true) return this.transactionError(id, "warp markers require an audio clip");
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const read = await adapter.invokeAsync({ operation: "audio.warp-marker.read", args: { ref: params.clipRef } }, context) as { markers?: Array<{ beatTime: number; sampleTime: number }>; revision?: string };
      const markers = Array.isArray(read.markers) ? read.markers : [];
      const beats = new Set(markers.map((marker) => marker.beatTime));
      if (params.action === "add" && (params.beatTime < 0 || beats.has(params.beatTime))) return error(id, -32602, "a warp marker already exists at that beat time");
      if (params.action !== "add" && !beats.has(params.beatTime)) return error(id, -32602, "no warp marker exists at that beat time");
      if (params.action === "move") {
        const target = params.beatTime + (params.distance as number);
        if (target < 0 || (beats.has(target) && target !== params.beatTime)) return error(id, -32602, "warp-marker move target collides with an existing marker");
      }
      const collectionRevision = this.warpMarkerCollectionRevision(markers);
      if (read.revision && read.revision !== collectionRevision) throw new Error("warp-marker revision disagreement between adapter and host");
      const authorityDigest = this.clipAuthorityDigest(snapshot, params.clipRef as LiveRef);
      const fence = JSON.stringify({ ref: params.clipRef, markers, authorityDigest, collectionRevision });
      const payload: Record<string, unknown> = { ref: params.clipRef, beatTime: params.beatTime, expectedClipAuthorityDigest: authorityDigest, expectedMarkerCollectionRevision: collectionRevision };
      if (params.action === "move") payload.distance = params.distance;
      const transaction: ClipLifecycleTransaction = { id: `warp_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "warp-marker", fence, clipRef: params.clipRef as LiveRef, payload: { action: params.action, ...payload }, prior: { markers: structuredClone(markers) }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "warp marker");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, clipRef: params.clipRef, markers, impact: "edits-warp-markers", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Warp-marker preview requires fresh authoritative state."); }
  }

  private async liveWarpMarkerApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "warp-marker" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired warp-marker transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) {
        const before = await adapter.invokeAsync({ operation: "audio.warp-marker.read", args: { ref: transaction.clipRef } }, context) as { markers?: Array<{ beatTime: number; sampleTime: number }> };
        const snapshot = await adapter.snapshotAsync(context);
        if (JSON.stringify({ ref: transaction.clipRef, markers: before.markers ?? [], authorityDigest: this.clipAuthorityDigest(snapshot, transaction.clipRef!), collectionRevision: this.warpMarkerCollectionRevision(before.markers ?? []) }) !== transaction.fence) return this.transactionError(id, "warp markers or clip hierarchy changed since preview; preview again");
      }
      const action = transaction.payload.action as string;
      const operation = action === "add" ? "audio.warp-marker.add" : action === "move" ? "audio.warp-marker.move" : "audio.warp-marker.delete";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
      const result = await adapter.invokeAsync({ operation, args }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("warp-marker change was not confirmed");
      const after = await adapter.invokeAsync({ operation: "audio.warp-marker.read", args: { ref: transaction.clipRef } }, context) as { markers?: Array<{ beatTime: number; sampleTime: number }> };
      const priorBeats = new Set((transaction.prior as { markers: Array<{ beatTime: number }> }).markers.map((marker) => marker.beatTime));
      const expectedBeats = action === "add" ? new Set([...priorBeats, transaction.payload.beatTime as number]) : action === "delete" ? new Set([...priorBeats].filter((beat) => beat !== transaction.payload.beatTime)) : new Set([...priorBeats].filter((beat) => beat !== transaction.payload.beatTime).concat([(transaction.payload.beatTime as number) + (transaction.payload.distance as number)]));
      const afterBeats = new Set((after.markers ?? []).map((marker) => marker.beatTime));
      if (afterBeats.size !== expectedBeats.size || [...expectedBeats].some((beat) => !afterBeats.has(beat))) throw new Error("warp-marker postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, markers: after.markers, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Warp-marker state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveClipActionPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["crop", "duplicate-loop", "duplicate-region", "scrub-start", "scrub-stop", "move-playing-position"] as const;
    if (!isObject(params) || !hasOnly(params, ["clipRef", "action", "regionStart", "regionEnd", "destination", "offset"]) || !isNonEmptyString(params.clipRef, 256) || !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "clipRef and a valid action are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("clip.action")) throw new Error("clip actions are unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      const payload: Record<string, unknown> = { ref: params.clipRef, action: params.action };
      if (params.action === "duplicate-region") {
        if (typeof params.regionStart !== "number" || !Number.isFinite(params.regionStart) || params.regionStart < 0 || typeof params.regionEnd !== "number" || !Number.isFinite(params.regionEnd) || params.regionEnd <= params.regionStart || typeof params.destination !== "number" || !Number.isFinite(params.destination) || params.destination < 0) return error(id, -32602, "duplicate-region requires regionStart, regionEnd, and destination");
        payload.regionStart = params.regionStart; payload.regionEnd = params.regionEnd; payload.destination = params.destination;
      }
      if (params.action === "scrub-start" || params.action === "move-playing-position") {
        if (typeof params.offset !== "number" || !Number.isFinite(params.offset)) return error(id, -32602, "offset is required");
        payload.offset = params.offset;
      }
      const contentActions = ["crop", "duplicate-loop", "duplicate-region"];
      const authority = this.clipPropertiesMutationAuthority(snapshot, params.clipRef as LiveRef);
      payload.expectedObjectIdentity = authority.expectedObjectIdentity; payload.expectedAuthorityRevision = authority.expectedAuthorityRevision;
      const state = { isPlaying: row.clip.isPlaying ?? null, playingPosition: row.clip.playingPosition ?? null, length: row.clip.length ?? null, loopStart: row.clip.loopStart ?? null, loopEnd: row.clip.loopEnd ?? null };
      payload.expectedStateRevision = createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex");
      if (contentActions.includes(params.action as string)) payload.expectedContentFingerprint = this.captureObjectFingerprint(row.clip);
      const prior = { length: row.clip.length, playingPosition: row.clip.playingPosition ?? null, loopStart: row.clip.loopStart ?? null, loopEnd: row.clip.loopEnd ?? null };
      const fence = JSON.stringify({ ref: params.clipRef, objectIdentity: row.clip.objectIdentity, state, contentFingerprint: payload.expectedContentFingerprint ?? null });
      const transaction: ClipLifecycleTransaction = { id: `clipaction_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "clip-action", fence, clipRef: params.clipRef as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip action");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, clipRef: params.clipRef, prior, impact: contentActions.includes(params.action as string) ? "edits-clip-content-not-undoable" : "transient-clip-playback-state", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-action preview requires fresh authoritative state."); }
  }

  private async liveClipActionApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "clip-action" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-action transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, transaction.clipRef!);
        const state = { isPlaying: row.clip.isPlaying ?? null, playingPosition: row.clip.playingPosition ?? null, length: row.clip.length ?? null, loopStart: row.clip.loopStart ?? null, loopEnd: row.clip.loopEnd ?? null };
        const contentFingerprint = ["crop", "duplicate-loop", "duplicate-region"].includes(transaction.payload.action as string) ? this.captureObjectFingerprint(row.clip) : null;
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: row.clip.objectIdentity, state, contentFingerprint }) !== transaction.fence) return this.transactionError(id, "clip identity, state, or content changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "clip.action", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("clip action was not confirmed");
      const verified = this.clipRow(await adapter.snapshotAsync(context), transaction.clipRef!).clip;
      const action = transaction.payload.action as string; const verifiedLength = verified.length as number; const prior = transaction.prior as { length: number; playingPosition: number | null; loopStart: number | null; loopEnd: number | null };
      // Verify the documented outcome of each action instead of an assumed
      // length formula: cropping lands on the loop extent (a full-loop crop
      // preserves length), duplicate-loop appends the loop region, and
      // duplicate-region grows the clip only when the destination extends it.
      if (action === "crop") {
        if (typeof prior.loopStart !== "number" || typeof prior.loopEnd !== "number" || !(prior.loopEnd > prior.loopStart)) throw new Error("clip crop loop state is unavailable");
        if (Math.abs(verifiedLength - (prior.loopEnd - prior.loopStart)) > 1e-6) throw new Error("clip crop postcondition was not confirmed");
      }
      if (action === "duplicate-loop") {
        if (typeof prior.loopStart !== "number" || typeof prior.loopEnd !== "number") throw new Error("clip loop state is unavailable");
        if (Math.abs(verifiedLength - (prior.length + (prior.loopEnd - prior.loopStart))) > 1e-6) throw new Error("clip loop duplication postcondition was not confirmed");
      }
      if (action === "duplicate-region") {
        const span = (transaction.payload.regionEnd as number) - (transaction.payload.regionStart as number);
        const destination = (transaction.payload.destination as number | undefined) ?? prior.length;
        if (Math.abs(verifiedLength - Math.max(prior.length, destination + span)) > 1e-6) throw new Error("clip region duplication postcondition was not confirmed");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveNoteTargetPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["quantize", "quantize-pitch", "duplicate"] as const;
    if (!isObject(params) || !hasOnly(params, ["clipRef", "action", "noteIds", "grid", "amount", "pitch"]) || !isNonEmptyString(params.clipRef, 256) || !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "clipRef and a valid action are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.action === "duplicate" ? "note.duplicate" : "note.quantize";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const clip = this.noteClip(snapshot, params.clipRef as LiveRef);
      const present = new Set(clip.notes.map((note) => note.id).filter((value) => typeof value === "number"));
      const payload: Record<string, unknown> = { ref: params.clipRef, expectedClipAuthority: clip.authority, expectedNotesRevision: clip.notesRevision };
      if (params.action === "duplicate") {
        if (!Array.isArray(params.noteIds) || params.noteIds.length < 1 || params.noteIds.length > 512 || new Set(params.noteIds).size !== params.noteIds.length || !params.noteIds.every((value) => Number.isInteger(value) && (value as number) >= 0)) return error(id, -32602, "noteIds must be 1-512 unique non-negative integers");
        if ((params.noteIds as number[]).some((noteId) => !present.has(noteId))) return this.transactionError(id, "note id is not present in the clip");
        payload.noteIds = [...(params.noteIds as number[])];
      } else {
        if (typeof params.grid !== "number" || !Number.isFinite(params.grid) || params.grid <= 0 || typeof params.amount !== "number" || !Number.isFinite(params.amount) || params.amount < 0 || params.amount > 1) return error(id, -32602, "grid and amount are required for quantization");
        payload.grid = params.grid; payload.amount = params.amount;
        if (params.action === "quantize-pitch") {
          if (!Number.isInteger(params.pitch) || (params.pitch as number) < 0 || (params.pitch as number) > 127) return error(id, -32602, "pitch is required for quantize-pitch");
          payload.pitch = params.pitch;
        }
      }
      const prior = { notes: clip.notes.map((note) => structuredClone(note)) };
      const fence = JSON.stringify({ ref: params.clipRef, notes: clip.notes, notesRevision: clip.notesRevision, authority: clip.authority });
      const transaction: ClipLifecycleTransaction = { id: `noteedit_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "note-target", fence, clipRef: params.clipRef as LiveRef, payload: { action: params.action, ...payload }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "note edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, clipRef: params.clipRef, impact: params.action === "duplicate" ? "duplicates-midi-notes" : "quantizes-midi-notes", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Note-edit preview requires fresh authoritative clip state."); }
  }

  private async liveNoteTargetApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "note-target" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired note-edit transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const beforeCount = (transaction.prior as { notes: unknown[] }).notes.length;
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const current = this.noteClip(snapshot, transaction.clipRef!);
        if (JSON.stringify({ ref: transaction.clipRef, notes: current.notes, notesRevision: current.notesRevision, authority: current.authority }) !== transaction.fence) return this.transactionError(id, "clip identity or notes changed since preview; preview again"); }
      const action = transaction.payload.action as string;
      const operation = action === "duplicate" ? "note.duplicate" : "note.quantize";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      const verified = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef!);
      if (action === "duplicate") {
        if (result.duplicated !== (transaction.payload.noteIds as number[]).length || verified.notes.length !== beforeCount + (transaction.payload.noteIds as number[]).length) throw new Error("note duplication postcondition was not confirmed");
        transaction.created = { duplicatedIds: verified.notes.map((note) => note.id).filter((noteId) => typeof noteId === "number" && !(transaction.prior as { notes: Array<{ id?: unknown }> }).notes.some((prior) => prior.id === noteId)) };
      } else {
        if (result.changed !== true || verified.notes.length !== beforeCount) throw new Error("quantization postcondition was not confirmed");
        const priorIds = new Set((transaction.prior as { notes: Array<{ id?: unknown }> }).notes.map((note) => note.id));
        if (verified.notes.some((note) => !priorIds.has(note.id))) throw new Error("quantization changed the note identity set");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit state is uncertain; perform fresh discovery before retrying."); }
  }

  private midiTransformPatch(note: Record<string, unknown>): Record<string, unknown> {
    // note.update patches carry only schema fields the mapper can set; channel
    // is preserved by construction (no transform mutates it).
    const patch: Record<string, unknown> = { id: note.id, pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity };
    if (note.mute !== undefined) patch.mute = note.mute;
    if (note.probability !== undefined) patch.probability = note.probability;
    if (note.velocityDeviation !== undefined) patch.velocityDeviation = note.velocityDeviation;
    if (note.releaseVelocity !== undefined) patch.releaseVelocity = note.releaseVelocity;
    return patch;
  }

  private canonicalNoteContent(notes: Array<Record<string, unknown>>): string {
    return noteContentDigest(notes);
  }

  /** Content fingerprint over any snapshot row, using a clip-content bound
   * (4096-item arrays) instead of the tighter mutation-authority bound, so
   * note-dense clips remain fingerprintable up to the transform bound. The
   * adapter's own read bounds still govern whether such rows exist.
   * Byte-identical to captureObjectFingerprint within its limits. */
  private captureBoundedFingerprint(value: unknown): string {
    const canonical = (item: unknown, depth: number): string => {
      if (depth > 16) throw new Error("clip content is too deeply nested");
      if (item === null || typeof item === "boolean") return JSON.stringify(item);
      if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error("clip content contains a non-finite number"); return JSON.stringify(Object.is(item, -0) ? 0 : item); }
      if (typeof item === "string") { if (item.length > 16384) throw new Error("clip content string is too large"); return JSON.stringify(item); }
      if (Array.isArray(item)) { if (item.length > 4096) throw new Error("clip content array exceeds its authoritative bound"); return `[${item.map((entry) => canonical(entry, depth + 1)).join(",")}]`; }
      if (isObject(item)) { const keys = Object.keys(item); if (keys.length > 256) throw new Error("clip content object is too large"); return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`; }
      throw new Error("clip content contains an unsupported value");
    };
    return createHash("sha256").update(canonical(value, 0)).digest("hex");
  }

  /** Digest of the full clip content the snapshot exposes as mutable: name,
   * timing, note content revision, audio fields, fades, loop bounds, warp
   * markers, groove, signature, legato, and visual state. Uses a
   * clip-bounded canonicalizer so large bounded marker collections never fail
   * the read (the mutation-authority canonicalizer caps arrays lower). */
  private boundedClipContentDigest(clip: Record<string, unknown>): string {
    const canonical = (value: unknown, depth: number): string => {
      if (depth > 8) throw new Error("clip content is too deeply nested");
      if (value === null || typeof value === "boolean") return JSON.stringify(value);
      if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("clip content contains a non-finite number"); return JSON.stringify(Object.is(value, -0) ? 0 : value); }
      if (typeof value === "string") { if (value.length > 16384) throw new Error("clip content string is too large"); return JSON.stringify(value); }
      if (Array.isArray(value)) { if (value.length > 4096) throw new Error("clip content array exceeds its authoritative bound"); return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`; }
      if (typeof value === "object" && value !== null) { const record = value as Record<string, unknown>; const keys = Object.keys(record); if (keys.length > 64) throw new Error("clip content object is too large"); return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`; }
      throw new Error("clip content contains an unsupported value");
    };
    return createHash("sha256").update(canonical({
      name: clip.name ?? null, start: clip.start ?? null, length: clip.length ?? null,
      muted: clip.muted ?? null, looping: clip.looping ?? null, colorIndex: clip.colorIndex ?? null,
      isAudio: clip.isAudio ?? null, notesRevision: clip.notesRevision ?? null,
      gain: clip.gain ?? null, pitchCoarse: clip.pitchCoarse ?? null, pitchFine: clip.pitchFine ?? null,
      warpMode: clip.warpMode ?? null, warping: clip.warping ?? null,
      fadeInLength: clip.fadeInLength ?? null, fadeOutLength: clip.fadeOutLength ?? null,
      loopStart: clip.loopStart ?? null, loopEnd: clip.loopEnd ?? null,
      filePath: clip.filePath ?? null, groove: clip.groove ?? null,
      warpMarkers: clip.warpMarkers ?? null, launchMode: clip.launchMode ?? null,
      legato: clip.legato ?? null, velocityAmount: clip.velocityAmount ?? null,
      signatureNumerator: clip.signatureNumerator ?? null, signatureDenominator: clip.signatureDenominator ?? null,
      ramMode: clip.ramMode ?? null, clipView: clip.clipView ?? null,
    }, 0)).digest("hex");
  }

  /** Expected full-note-set digest after the first `completedCount` plan steps
   * have been applied to `initialNotes`, derived deterministically from the
   * stored plan (never from fresh adapter state). */
  private notePlanInterimDigest(initialNotes: Array<Record<string, unknown>>, steps: Array<{ operation: string; items: Array<Record<string, unknown>> | number[] }>, completedCount: number, idBound: boolean): string {
    const byId = new Map<number, Record<string, unknown>>();
    const anonymous: Array<Record<string, unknown>> = [];
    for (const note of initialNotes) {
      if (typeof note.id === "number") byId.set(note.id, { ...note });
      else anonymous.push({ ...note });
    }
    for (const step of steps.slice(0, completedCount)) {
      if (step.operation === "note.delete") for (const noteId of step.items as number[]) byId.delete(noteId);
      else if (step.operation === "note.update") for (const row of step.items as Array<Record<string, unknown>>) { const existing = byId.get(row.id as number); if (existing) byId.set(row.id as number, { ...existing, ...row }); }
      else for (const row of step.items as Array<Record<string, unknown>>) anonymous.push({ ...row });
    }
    const rows = [...byId.values(), ...anonymous];
    return idBound ? noteIdentityDigest(rows) : noteContentDigest(rows);
  }

  /** Ordered, registry-bounded note plan: deletes, then updates, then adds, in
   * 512-item chunks (256 for replay-plan restores, decided by the caller). */
  private buildNotePlanFromDiff(diff: { add: Array<Record<string, unknown>>; update: Array<Record<string, unknown>>; delete: number[] }): Array<{ operation: "note.update" | "note.add-batch" | "note.delete"; items: Array<Record<string, unknown>> | number[] }> {
    const steps: Array<{ operation: "note.update" | "note.add-batch" | "note.delete"; items: Array<Record<string, unknown>> | number[] }> = [];
    for (let offset = 0; offset < diff.delete.length; offset += 512) steps.push({ operation: "note.delete", items: diff.delete.slice(offset, offset + 512) });
    const patches = diff.update.map((note) => this.midiTransformPatch(note));
    for (let offset = 0; offset < patches.length; offset += 512) steps.push({ operation: "note.update", items: patches.slice(offset, offset + 512) });
    const adds = diff.add.map((note) => ({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, channel: note.channel ?? 1, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 }));
    for (let offset = 0; offset < adds.length; offset += 512) steps.push({ operation: "note.add-batch", items: adds.slice(offset, offset + 512) });
    return steps;
  }

  /** Execute a note plan with exact interim fencing: before every chunk the
   * current clip content must equal the expected intermediate state derived
   * from the stored plan, so a concurrent external edit fails closed instead
   * of being overwritten. Steps are matched by stable plan index (identical
   * chunks stay distinct), and a step whose effect is already present — a lost
   * acknowledgement that did dispatch — is adopted without re-dispatching, so
   * an exact-key retry after a post-dispatch failure converges. */
  private async executeNotePlan(record: object | null, adapter: AsyncLiveAdapter, context: LiveOperationContext, clipRef: LiveRef, steps: Array<{ operation: "note.update" | "note.add-batch" | "note.delete"; items: Array<Record<string, unknown>> | number[] }>, initialNotes: Array<Record<string, unknown>>, idBound: boolean): Promise<void> {
    let plan: Array<{ operation: string; args: Record<string, unknown>; completed: boolean; result?: unknown }> | undefined;
    if (record !== null) {
      const begun = this.beginUndoRecovery(record, context.idempotencyKey ?? "");
      plan = begun.steps;
    }
    const digestOf = (notes: Array<Record<string, unknown>>): string => idBound ? noteIdentityDigest(notes) : noteContentDigest(notes);
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      const field = step.operation === "note.delete" ? "noteIds" : "notes";
      const recorded = plan !== undefined && plan.length > index && plan[index]!.operation === step.operation && JSON.stringify(plan[index]!.args[field]) === JSON.stringify(step.items) ? plan[index] : undefined;
      if (recorded?.completed) continue;
      const fresh = this.noteClip(await adapter.snapshotAsync(context), clipRef);
      const currentDigest = digestOf(fresh.notes);
      if (currentDigest === this.notePlanInterimDigest(initialNotes, steps, index + 1, idBound)) {
        if (recorded) recorded.completed = true;
        continue;
      }
      if (currentDigest !== this.notePlanInterimDigest(initialNotes, steps, index, idBound)) throw new Error("notes changed during the note plan; refusing to overwrite external edits");
      const args: Record<string, unknown> = { ref: clipRef, [field]: step.items, expectedClipAuthority: fresh.authority, expectedNotesRevision: fresh.notesRevision };
      const result = await (async (): Promise<{ updated?: unknown; added?: unknown; deleted?: unknown }> => {
        if (recorded) { recorded.args = args; recorded.result = await adapter.invokeAsync({ operation: step.operation, args }, context); recorded.completed = true; return recorded.result as never; }
        if (plan) { const created = { operation: step.operation, args, completed: false, result: undefined as unknown }; plan.push(created); created.result = await adapter.invokeAsync({ operation: step.operation, args }, context); created.completed = true; return created.result as never; }
        return await adapter.invokeAsync({ operation: step.operation, args }, context) as never;
      })();
      const confirmed = step.operation === "note.delete" ? result.deleted : step.operation === "note.add-batch" ? result.added : result.updated;
      if (confirmed !== step.items.length) throw new Error(`${step.operation} did not confirm the exact chunk`);
    }
  }

  private validTransformParams(params: unknown): params is Record<string, unknown> {
    if (!isObject(params) || Object.keys(params).length > 12) return false;
    for (const value of Object.values(params)) {
      if (typeof value === "string" || typeof value === "number") continue;
      if (Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every((entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 32)) continue;
      if (isObject(value) && Object.keys(value).length <= 32 && Object.entries(value).every(([key, entry]) => key.length <= 32 && typeof entry === "number" && Number.isFinite(entry))) continue;
      return false;
    }
    return true;
  }

  private discoverDrumMapping(snapshot: LiveSnapshot): { mapping: Record<string, number>; assumptions: string[] } {
    const roleMatchers: ReadonlyArray<readonly [string, (name: string) => boolean]> = [
      ["kick", (name) => name.includes("kick")],
      ["snare", (name) => name.includes("snare")],
      ["openHat", (name) => name.includes("open") && name.includes("hat")],
      ["closedHat", (name) => name.includes("hat")],
      ["clap", (name) => name.includes("clap")],
      ["ride", (name) => name.includes("ride")],
      ["crash", (name) => name.includes("crash")],
      ["highTom", (name) => name.includes("high") && name.includes("tom")],
      ["lowTom", (name) => name.includes("low") && name.includes("tom")],
      ["midTom", (name) => name.includes("tom")],
    ];
    const mapping: Record<string, number> = {};
    const discovered: string[] = [];
    const visit = (devices: readonly unknown[]): void => {
      for (const device of devices.filter(isObject)) {
        for (const chain of ((device.chains as unknown[]) ?? []).filter(isObject)) {
          const name = String(chain.name ?? "").toLowerCase();
          const inNote = chain.inNote;
          if (Number.isInteger(inNote) && (inNote as number) >= 0 && (inNote as number) <= 127) {
            for (const [role, match] of roleMatchers) {
              if (mapping[role] === undefined && match(name)) { mapping[role] = inNote as number; discovered.push(`${role}=${inNote} (chain "${String(chain.name ?? "")}")`); break; }
            }
          }
          visit((chain.devices as unknown[]) ?? []);
        }
      }
    };
    for (const track of ((snapshot.tracks as unknown[]) ?? []).filter(isObject)) visit((track.devices as unknown[]) ?? []);
    return { mapping, assumptions: discovered.length > 0 ? [`drum mapping discovered from the Set's drum-chain notes: ${discovered.join(", ")}`] : [] };
  }

  private async resolveMidiTransformContext(transform: MidiTransformType, params: Record<string, unknown>, snapshot: LiveSnapshot, status: LiveStatus): Promise<{ params: Record<string, unknown>; assumptions: string[] }> {
    const resolved: Record<string, unknown> = { ...params };
    const assumptions: string[] = [];
    if ((transform === "chord-progression" || transform === "bassline") && resolved.root === undefined && resolved.scale === undefined) {
      const tokens = (transform === "chord-progression" ? resolved.numerals ?? resolved.symbols : resolved.chords) as unknown;
      const roman = Array.isArray(tokens) && tokens.length > 0 && tokens.every((token) => typeof token === "string" && /^(vii|vi|iv|v|iii|ii|i)(°|dim)?(7)?$/i.test(token.trim()));
      if (roman) {
        if (!(status.operations ?? []).includes("tuning.read")) throw new Error("roman-numeral input requires an explicit key/mode: tuning state is unavailable");
        const tuning = await this.asyncAdapter().invokeAsync({ operation: "tuning.read", args: { setRef: snapshot.set.ref } }) as JsonObject;
        const scale = tuning.scale as JsonObject | undefined;
        const rootNote = scale?.rootNote;
        const scaleNameRaw = scale?.scaleName;
        const scaleName = typeof scaleNameRaw === "string" ? scaleNameRaw.trim().toLowerCase().replace(/\s+/g, "-") : null;
        if (!Number.isInteger(rootNote) || (rootNote as number) < 0 || (rootNote as number) > 11 || scaleName === null || scaleName === "") throw new Error("roman-numeral input requires an explicit key/mode: the Set does not name a song scale");
        resolved.root = rootNote;
        resolved.scale = scaleName;
        assumptions.push(`key/mode discovered from the Set's song scale: root ${rootNote}, ${scaleName}`);
      }
    }
    if (transform === "drum-pattern" && resolved.mapping === undefined) {
      const discovered = this.discoverDrumMapping(snapshot);
      if (Object.keys(discovered.mapping).length === 0) throw new Error("drum-pattern requires an explicit mapping: no drum-chain notes were discovered in the Set");
      resolved.mapping = discovered.mapping;
      assumptions.push(...discovered.assumptions);
    }
    return { params: resolved, assumptions };
  }

  private async liveMidiTransformPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "transform", "params", "scope", "target"]) || !isNonEmptyString(params.clipRef, 256) || typeof params.transform !== "string" || !(MIDI_TRANSFORM_TYPES as readonly string[]).includes(params.transform) || !this.validTransformParams(params.params) || (params.scope !== undefined && !["in-place", "duplicate"].includes(String(params.scope)))) return error(id, -32602, "clipRef, a known transform, and bounded params (strings, numbers, string arrays, or flat pitch maps) are required");
    const transform = params.transform as MidiTransformType;
    const generative = GENERATIVE_TRANSFORMS.includes(transform);
    const probe = midiExpressionProbe();
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.midi_note.write") || !(status.capabilities ?? []).includes("session.midi_note.read")) throw new Error("midi note read/write capability is unavailable");
      for (const operation of ["snapshot", "note.update", "note.delete", "note.add-batch"]) if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const scope = params.scope === undefined ? undefined : params.scope as "in-place" | "duplicate";
      if (scope === "in-place" && generative && !probe.deleteRecreatePreservesExpression) return this.transactionError(id, "Generative transforms delete and recreate notes, which cannot preserve per-note expression the canonical schema does not expose; use duplicate scope so the source clip is preserved");
      if (scope === "duplicate" && !isObject(params.target)) return error(id, -32602, "duplicate scope requires an exact target {trackRef, sceneIndex} naming an empty Session slot");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const clip = this.noteClip(snapshot, params.clipRef as LiveRef);
      if (clip.notes.some((note) => typeof note.id !== "number")) throw new Error("stable note identity is unavailable for this clip");
      let resolvedParams = params.params as Record<string, unknown>;
      let contextAssumptions: string[] = [];
      if (transform === "chord-progression" || transform === "bassline" || transform === "drum-pattern") {
        const resolved = await this.resolveMidiTransformContext(transform, resolvedParams, snapshot, status);
        resolvedParams = resolved.params;
        contextAssumptions = resolved.assumptions;
      }
      let outcome;
      try { outcome = applyMidiTransform(structuredClone(clip.notes) as never, { type: transform, params: resolvedParams }, clip.length); }
      catch (cause) { return error(id, -32602, cause instanceof Error ? cause.message : "invalid transform parameters"); }
      const diff = diffNotes(clip.notes as never, outcome.notes as never);
      if (diff.add.length + diff.update.length + diff.delete.length === 0) return this.transactionError(id, "transform produced no changes");
      if (diff.add.length + clip.notes.length - diff.delete.length > 2048) return this.transactionError(id, "transform result exceeds the bounded 2048-note limit");
      const largeEdit = diff.update.length > MIDI_TRANSFORM_LARGE_UPDATE_THRESHOLD;
      const effectiveScope = scope ?? (generative || largeEdit ? "duplicate" : "in-place");
      if (effectiveScope === "in-place" && generative) return this.transactionError(id, "Generative transforms default to duplicate scope; request an exact duplicate target");
      if (effectiveScope === "in-place" && largeEdit && params.scope === undefined) return this.transactionError(id, "Large transforms default to duplicate scope; pass scope=in-place explicitly to edit the source clip");
      if (effectiveScope === "duplicate" && !isObject(params.target)) return error(id, -32602, "duplicate scope requires an exact target {trackRef, sceneIndex} naming an empty Session slot");
      const authority = clip.authority;
      let targetAuthority: Record<string, unknown> | undefined;
      let fenceTarget: Record<string, unknown> = {};
      if (effectiveScope === "duplicate") {
        for (const operation of ["clip.duplicate", "clip.delete"]) if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable for duplicate-scope transforms`);
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === (params.target as JsonObject).trackRef);
        const sceneIndex = (params.target as JsonObject).sceneIndex;
        if (!targetTrack || !isNonEmptyString(targetTrack.objectIdentity, 256)) throw new Error("target track identity is not authoritative");
        const slot = ((targetTrack.clipSlots as unknown[]) ?? []).filter(isObject).find((candidate) => candidate.sceneIndex === sceneIndex);
        const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.index === sceneIndex);
        if (!slot || !scene || !isNonEmptyString(slot.ref, 256) || !isNonEmptyString(slot.objectIdentity, 256) || !isNonEmptyString(scene.ref, 256) || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("target slot or scene identity is invalid");
        if (slot.clipRef) throw new Error("target Session slot is occupied");
        targetAuthority = { trackRef: slot.parentRef ?? (params.target as JsonObject).trackRef, sceneIndex, slotRef: slot.ref, slotIdentity: slot.objectIdentity, trackIdentity: targetTrack.objectIdentity, sceneRef: scene.ref, sceneIdentity: scene.objectIdentity };
        fenceTarget = { target: slot.ref, targetIdentity: slot.objectIdentity, targetTrackIdentity: targetTrack.objectIdentity, targetSceneIdentity: scene.objectIdentity, empty: slot.empty };
      }
      const fence = JSON.stringify({ ref: params.clipRef, notes: clip.notes, notesRevision: clip.notesRevision, authority, ...fenceTarget });
      const transaction: ClipLifecycleTransaction = { id: `miditransform_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "midi-transform", fence, clipRef: params.clipRef as LiveRef, payload: { transform, params: structuredClone(resolvedParams), scope: effectiveScope, generative, seed: outcome.seed ?? null, target: targetAuthority ?? null, diff: structuredClone(diff), sourceRevision: clip.notesRevision, authority, expectedResultContent: this.canonicalNoteContent(outcome.notes as unknown as Array<Record<string, unknown>>), expectedResultIdentity: noteIdentityDigest(outcome.notes as unknown as Array<Record<string, unknown>>), clipLength: clip.length }, prior: { notes: clip.notes.map((note) => structuredClone(note)) }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "MIDI transform");
      return this.successText(id, {
        transactionId: transaction.id, epoch: transaction.epoch, transform, scope: effectiveScope, clipRef: params.clipRef,
        sourceRevision: clip.notesRevision,
        diff: { add: diff.add.length, update: diff.update.length, delete: diff.delete.length, notes: diff },
        constraints: { sourceNotes: clip.notes.length, resultNotes: diff.add.length + clip.notes.length - diff.delete.length, generative, largeEdit, duplicateFirstDefault: generative || largeEdit },
        assumptions: [...contextAssumptions, ...outcome.assumptions],
        params: resolvedParams,
        seed: outcome.seed ?? null,
        mpe: { ...probe, refusedInPlace: generative && !probe.deleteRecreatePreservesExpression, note: "Per-note Pitch/Slide/Pressure are not in the canonical note schema and are never authored or silently erased by transforms; update-only transforms patch exposed fields through note.update, which preserves unexposed per-note data." },
        undo: effectiveScope === "duplicate" ? "live_undo deletes the exact transaction-created duplicate clip" : "live_undo restores the exact prior note fields through note.update",
        impact: effectiveScope === "duplicate" ? "creates-one-transformed-duplicate-clip" : "transforms-midi-notes-in-place",
        confirmation: "apply", expiresAt: transaction.expiresAt,
      });
    } catch (cause) { return this.adapterToolError(id, cause, "MIDI transform preview requires fresh authoritative clip state."); }
  }

  private async liveMidiTransformApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "midi-transform" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired MIDI-transform transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.midi_note.write");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const scope = transaction.payload.scope as string;
      const diff = transaction.payload.diff as { add: Array<Record<string, unknown>>; update: Array<Record<string, unknown>>; delete: number[] };
      if (scope === "in-place") {
        if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const current = this.noteClip(snapshot, transaction.clipRef!);
          if (JSON.stringify({ ref: transaction.clipRef, notes: current.notes, notesRevision: current.notesRevision, authority: current.authority }) !== JSON.stringify({ ref: transaction.clipRef, notes: (transaction.prior as { notes: unknown[] }).notes, notesRevision: transaction.payload.sourceRevision, authority: transaction.payload.authority })) return this.transactionError(id, "clip identity or notes changed since preview; preview again"); }
        transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
        const initialNotes = (transaction.prior as { notes: Array<Record<string, unknown>> }).notes;
        const steps = this.buildNotePlanFromDiff(diff);
        await this.executeNotePlan(transaction, adapter, context, transaction.clipRef!, steps, initialNotes, true);
        const verified = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef!);
        if (noteIdentityDigest(verified.notes) !== transaction.payload.expectedResultIdentity) throw new Error("MIDI transform postcondition was not confirmed");
        this.undoRecoveryPlans.delete(transaction);
        transaction.state = "applied";
        return this.successText(id, { transactionId: transaction.id, state: "applied", scope, updated: diff.update.length, idempotent: false });
      }
      const target = transaction.payload.target as Record<string, unknown> | null;
      if (!target) return this.transactionError(id, "Duplicate-scope transform lacks exact target authority");
      const snapshot = await adapter.snapshotAsync(context);
      if (!reconciliation) {
        const current = this.noteClip(snapshot, transaction.clipRef!);
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === target.trackRef);
        const slot = ((targetTrack?.clipSlots as unknown[]) ?? []).filter(isObject).find((candidate) => candidate.ref === target.slotRef);
        if (JSON.stringify({ ref: transaction.clipRef, notes: current.notes, notesRevision: current.notesRevision, authority: current.authority, target: target.slotRef, targetIdentity: slot?.objectIdentity, targetTrackIdentity: targetTrack?.objectIdentity, targetSceneIdentity: target.sceneIdentity, empty: slot?.empty }) !== transaction.fence) return this.transactionError(id, "clip identity, notes, or target slot changed since preview; preview again");
      }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      let duplicateRef = transaction.created?.ref as string | undefined;
      let duplicateIdentity = transaction.created?.objectIdentity as string | undefined;
      if (duplicateRef === undefined || duplicateIdentity === undefined) {
        const duplicate = await adapter.invokeAsync({ operation: "clip.duplicate", args: { ref: transaction.clipRef, targetTrackRef: target.trackRef, targetSceneIndex: target.sceneIndex, arrangementPosition: null, ...(transaction.payload.authority as Record<string, unknown>), expectedContentFingerprint: this.captureBoundedFingerprint(this.clipRow(snapshot, transaction.clipRef!).clip), expectedTargetTrackIdentity: target.trackIdentity, expectedTargetSlotRef: target.slotRef, expectedTargetSlotIdentity: target.slotIdentity, expectedTargetSceneRef: target.sceneRef, expectedTargetSceneIdentity: target.sceneIdentity, expectedTargetCollectionRevision: null } }, context) as { ref?: unknown; objectIdentity?: unknown; createdFingerprint?: unknown };
        if (!isNonEmptyString(duplicate.ref, 256) || !isNonEmptyString(duplicate.objectIdentity, 256)) throw new Error("clip duplication did not return exact identity");
        duplicateRef = duplicate.ref; duplicateIdentity = duplicate.objectIdentity;
        transaction.created = { ref: duplicateRef, objectIdentity: duplicateIdentity, fingerprint: typeof duplicate.createdFingerprint === "string" ? duplicate.createdFingerprint : undefined };
      }
      const duplicateRow = this.clipRow(await adapter.snapshotAsync(context), duplicateRef as LiveRef);
      if (duplicateRow.clip.objectIdentity !== duplicateIdentity) throw new Error("transform duplicate identity changed since creation");
      const duplicateClip = this.noteClip(await adapter.snapshotAsync(context), duplicateRef as LiveRef);
      // Persist the duplicate's initial note set exactly once: reconciliation
      // resumes the ORIGINAL plan against it instead of re-transforming partial
      // output.
      transaction.payload.duplicateInitial ??= structuredClone(duplicateClip.notes);
      const initial = transaction.payload.duplicateInitial as Array<Record<string, unknown>>;
      const transformed = applyMidiTransform(structuredClone(initial) as never, { type: transaction.payload.transform as MidiTransformType, params: transaction.payload.params as Record<string, unknown> }, transaction.payload.clipLength as number);
      const plan = this.buildNotePlanFromDiff(diffNotes(initial as never, transformed.notes as never) as never);
      try {
        await this.executeNotePlan(transaction, adapter, context, duplicateRef as LiveRef, plan, initial, false);
        const verifiedSnapshot = await adapter.snapshotAsync(context);
        const verified = this.noteClip(verifiedSnapshot, duplicateRef as LiveRef);
        if (this.canonicalNoteContent(verified.notes) !== transaction.payload.expectedResultContent) throw new Error("duplicate transform postcondition was not confirmed");
        // Cleanup authority fingerprints the verified post-transform content: the
        // transform intentionally rewrote the duplicate after creation.
        transaction.created = { ref: duplicateRef, objectIdentity: duplicateIdentity, fingerprint: this.captureBoundedFingerprint(this.clipRow(verifiedSnapshot, duplicateRef as LiveRef).clip) };
        this.undoRecoveryPlans.delete(transaction);
      } catch (cause) {
        // No cleanup on failure: the transaction-owned duplicate remains for the
        // exact-key resume (re-creating under the same idempotency key would hit
        // the bridge ledger's replay of the original creation). Completed steps
        // are recorded, so the retry converges; undo after success deletes the
        // duplicate with the post-verify fingerprint.
        throw cause;
      }
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", scope, created: transaction.created, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "MIDI-transform state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveNoteReadAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "noteIds", "selected"]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    if (params.noteIds !== undefined && params.selected === true) return error(id, -32602, "noteIds and selected are mutually exclusive");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      if (params.selected === true) {
        if (!(status.operations ?? []).includes("note.read-selected")) throw new Error("selected note reads are unavailable");
        return this.successText(id, await adapter.invokeAsync({ operation: "note.read-selected", args: { ref: params.clipRef } }, context));
      }
      if (!Array.isArray(params.noteIds) || params.noteIds.length < 1 || params.noteIds.length > 1024 || !params.noteIds.every((value) => Number.isInteger(value) && (value as number) >= 0)) return error(id, -32602, "noteIds must be 1-1024 non-negative integers (or selected=true)");
      if (!(status.operations ?? []).includes("note.read-by-id")) throw new Error("targeted note reads are unavailable");
      return this.successText(id, await adapter.invokeAsync({ operation: "note.read-by-id", args: { ref: params.clipRef, noteIds: params.noteIds } }, context));
    } catch (cause) { return this.adapterToolError(id, cause, "Note read requires fresh authoritative state."); }
  }

  private async liveTuningPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["name", "lowestNote", "highestNote", "referencePitch", "noteTunings", "rootNote", "scaleName", "scaleMode"] as const;
    if (!isObject(params) || !hasOnly(params, [...fields])) return error(id, -32602, "only bounded tuning and scale fields are accepted");
    if (fields.every((field) => params[field] === undefined)) return error(id, -32602, "at least one tuning field is required");
    if (params.noteTunings !== undefined && (!Array.isArray(params.noteTunings) || params.noteTunings.length !== 128 || !params.noteTunings.every((row) => isObject(row) && hasOnly(row, ["note", "deviation"]) && Number.isInteger(row.note) && (row.note as number) >= 0 && (row.note as number) <= 127 && typeof row.deviation === "number" && Number.isFinite(row.deviation) && Math.abs(row.deviation) <= 1200))) return error(id, -32602, "noteTunings must contain exactly 128 valid entries");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("tuning.read") || !(status.operations ?? []).includes("tuning.set")) throw new Error("tuning editing is unavailable");
      const adapter = this.asyncAdapter();
      const snapshot = await adapter.snapshotAsync();
      if (!isNonEmptyString(snapshot.set.objectIdentity, 256)) throw new Error("Set identity is not authoritative");
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const read = await adapter.invokeAsync({ operation: "tuning.read", args: { setRef: snapshot.set.ref } }, context) as { tuningSystem?: unknown; scale?: unknown; revision?: unknown };
      if (!isNonEmptyString(read.revision, 64)) throw new Error("tuning revision is unavailable");
      const proposed: Record<string, unknown> = {};
      for (const field of fields) if (params[field] !== undefined) proposed[field] = structuredClone(params[field]);
      const payload: Record<string, unknown> = { setRef: snapshot.set.ref, ...proposed, expectedObjectIdentity: snapshot.set.objectIdentity, expectedRevision: read.revision };
      const fence = JSON.stringify({ setRef: snapshot.set.ref, identity: snapshot.set.objectIdentity, revision: read.revision });
      const transaction: ClipLifecycleTransaction = { id: `tuning_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "tuning", fence, payload, prior: { tuningSystem: structuredClone(read.tuningSystem), scale: structuredClone(read.scale), revision: read.revision }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "tuning");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, prior: transaction.prior, proposed, impact: "edits-global-tuning-audible", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Tuning preview requires fresh authoritative state."); }
  }

  private async liveTuningApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "tuning" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired tuning transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) {
        const snapshot = await adapter.snapshotAsync(context);
        const before = await adapter.invokeAsync({ operation: "tuning.read", args: { setRef: transaction.payload.setRef } }, context) as { revision?: unknown };
        if (JSON.stringify({ setRef: transaction.payload.setRef, identity: snapshot.set.objectIdentity, revision: before.revision }) !== transaction.fence) return this.transactionError(id, "tuning or scale state changed since preview; preview again");
      }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "tuning.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("tuning change was not confirmed");
      const verified = await adapter.invokeAsync({ operation: "tuning.read", args: { setRef: transaction.payload.setRef } }, context) as { tuningSystem?: unknown; scale?: unknown; revision?: unknown };
      for (const [field, value] of Object.entries(transaction.payload)) {
        if (["setRef", "expectedObjectIdentity", "expectedRevision"].includes(field)) continue;
        const observed = ["name", "lowestNote", "highestNote", "referencePitch", "noteTunings"].includes(field) ? (verified.tuningSystem as Record<string, unknown>)?.[field] : (verified.scale as Record<string, unknown>)?.[field];
        if (JSON.stringify(observed) !== JSON.stringify(value)) throw new Error("tuning postcondition was not confirmed");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: verified.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Tuning state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveGroovePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["action", "grooveAmount", "grooveRef", "name", "base", "quantizationAmount", "randomAmount", "timingAmount", "velocityAmount"])) return error(id, -32602, "action is required");
    if (params.action !== "set-amount" && params.action !== "edit") return error(id, -32602, "action must be set-amount or edit");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.action === "set-amount" ? "groove.set" : "groove.edit";
      if (!(status.operations ?? []).includes(operation) || !(status.operations ?? []).includes("groove.read")) throw new Error(`${operation} is unavailable`);
      const adapter = this.asyncAdapter();
      const snapshot = await adapter.snapshotAsync();
      if (!isNonEmptyString(snapshot.set.objectIdentity, 256)) throw new Error("Set identity is not authoritative");
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const read = await adapter.invokeAsync({ operation: "groove.read", args: { setRef: snapshot.set.ref } }, context) as { grooveAmount?: unknown; grooves?: Array<Record<string, unknown>>; revision?: unknown };
      if (!isNonEmptyString(read.revision, 64)) throw new Error("groove revision is unavailable");
      let payload: Record<string, unknown>;
      let prior: Record<string, unknown>;
      if (params.action === "set-amount") {
        if (typeof params.grooveAmount !== "number" || !Number.isFinite(params.grooveAmount) || params.grooveAmount < 0 || params.grooveAmount > 1.3) return error(id, -32602, "grooveAmount must be 0-1.3");
        payload = { action: params.action, setRef: snapshot.set.ref, grooveAmount: params.grooveAmount, expectedObjectIdentity: snapshot.set.objectIdentity, expectedRevision: read.revision };
        prior = { grooveAmount: read.grooveAmount ?? null };
      } else {
        if (!isNonEmptyString(params.grooveRef, 256)) return error(id, -32602, "grooveRef is required for edit");
        const groove = (read.grooves ?? []).find((candidate) => candidate.ref === params.grooveRef);
        if (!groove || !isNonEmptyString(groove.objectIdentity, 256)) return this.transactionError(id, "groove reference is unknown");
        const fields = ["name", "base", "quantizationAmount", "randomAmount", "timingAmount", "velocityAmount"] as const;
        if (fields.every((field) => params[field] === undefined)) return error(id, -32602, "at least one groove field is required");
        const proposed: Record<string, unknown> = {};
        for (const field of fields) {
          const value = params[field];
          if (value === undefined) continue;
          if (field === "name" && !isNonEmptyString(value, 256)) return error(id, -32602, "name is invalid");
          if (field === "base" && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 16)) return error(id, -32602, "base is invalid");
          if (field !== "name" && field !== "base" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return error(id, -32602, `${field} must be 0-1`);
          proposed[field] = value;
        }
        payload = { action: params.action, ref: params.grooveRef, ...proposed, expectedObjectIdentity: groove.objectIdentity, expectedRevision: read.revision };
        prior = Object.fromEntries(fields.map((field) => [field, groove[field] ?? null]));
      }
      const fence = JSON.stringify({ action: params.action, payload, revision: read.revision });
      const transaction: ClipLifecycleTransaction = { id: `groove_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "groove", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "groove");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, prior, impact: params.action === "set-amount" ? "edits-global-groove-amount-audible" : "edits-groove-pool-entry", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Groove preview requires fresh authoritative state."); }
  }

  private async liveGrooveApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "groove" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired groove transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) {
        const snapshot = await adapter.snapshotAsync(context);
        const before = await adapter.invokeAsync({ operation: "groove.read", args: { setRef: snapshot.set.ref } }, context) as { revision?: unknown };
        if (JSON.stringify({ action: transaction.payload.action, payload: transaction.payload, revision: before.revision }) !== transaction.fence) return this.transactionError(id, "groove state changed since preview; preview again");
      }
      const action = transaction.payload.action as string;
      const operation = action === "set-amount" ? "groove.set" : "groove.edit";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
      const result = await adapter.invokeAsync({ operation, args }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("groove change was not confirmed");
      const snapshot = await adapter.snapshotAsync(context);
      const verified = await adapter.invokeAsync({ operation: "groove.read", args: { setRef: snapshot.set.ref } }, context) as { grooveAmount?: unknown; grooves?: Array<Record<string, unknown>>; revision?: unknown };
      if (action === "set-amount") {
        if (verified.grooveAmount !== transaction.payload.grooveAmount) throw new Error("groove amount postcondition was not confirmed");
      } else {
        const groove = (verified.grooves ?? []).find((candidate) => candidate.ref === transaction.payload.ref);
        if (!groove) throw new Error("edited groove disappeared after apply");
        for (const field of ["name", "base", "quantizationAmount", "randomAmount", "timingAmount", "velocityAmount"]) if (transaction.payload[field] !== undefined && JSON.stringify(groove[field]) !== JSON.stringify(transaction.payload[field])) throw new Error("groove postcondition was not confirmed");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: verified.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Groove state is uncertain; perform fresh discovery before retrying."); }
  }

  private sceneCollectionRevision(snapshot: LiveSnapshot): string {
    const siblings = (snapshot.scenes as unknown as JsonObject[]).map((scene) => ({ ref: scene.ref, objectIdentity: scene.objectIdentity, name: scene.name, colorIndex: scene.colorIndex ?? null, tempo: scene.tempo ?? null, tempoEnabled: scene.tempoEnabled ?? null, signatureNumerator: scene.signatureNumerator ?? null, signatureDenominator: scene.signatureDenominator ?? null, timeSignatureEnabled: scene.timeSignatureEnabled ?? null }));
    if (siblings.some((scene) => !isNonEmptyString(scene.ref as string, 256) || !isNonEmptyString(scene.objectIdentity as string, 256))) throw new Error("scene collection authority is incomplete");
    return createHash("sha256").update(canonicalMutationIdentity(siblings)).digest("hex");
  }

  private sceneStateRevision(scene: JsonObject): string {
    return createHash("sha256").update(canonicalMutationIdentity({ colorIndex: scene.colorIndex ?? null, tempo: scene.tempo ?? null, tempoEnabled: scene.tempoEnabled ?? null, signatureNumerator: scene.signatureNumerator ?? null, signatureDenominator: scene.signatureDenominator ?? null, timeSignatureEnabled: scene.timeSignatureEnabled ?? null })).digest("hex");
  }

  private async liveScenePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["colorIndex", "tempo", "tempoEnabled", "signatureNumerator", "signatureDenominator", "timeSignatureEnabled"] as const;
    if (!isObject(params) || !hasOnly(params, ["ref", ...fields]) || !isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "tempoEnabled" || field === "timeSignatureEnabled") { if (typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`); }
      else if (field === "colorIndex" && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 69)) return error(id, -32602, "colorIndex is out of bounds");
      else if (field === "tempo" && (typeof value !== "number" || !Number.isFinite(value) || value < 20 || value > 999)) return error(id, -32602, "tempo is out of bounds");
      else if ((field === "signatureNumerator" || field === "signatureDenominator") && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 99)) return error(id, -32602, `${field} is out of bounds`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one scene field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("scene.set")) throw new Error("scene editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref);
      if (!scene || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("scene identity is not authoritative");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = scene[field] ?? null;
      const payload: Record<string, unknown> = { ref: params.ref, ...proposed, expectedObjectIdentity: scene.objectIdentity, expectedAuthorityRevision: this.sceneCollectionRevision(snapshot), expectedStateRevision: this.sceneStateRevision(scene) };
      const fence = JSON.stringify({ ref: params.ref, objectIdentity: scene.objectIdentity, state: fields.map((field) => scene[field] ?? null) });
      const transaction: ClipLifecycleTransaction = { id: `sceneset_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "scene-set", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "scene edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, prior, proposed, impact: "edits-scene", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Scene preview requires fresh authoritative state."); }
  }

  private async liveSceneApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "scene-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired scene transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const fields = ["colorIndex", "tempo", "tempoEnabled", "signatureNumerator", "signatureDenominator", "timeSignatureEnabled"];
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        if (!scene || JSON.stringify({ ref: transaction.payload.ref, objectIdentity: scene.objectIdentity, state: fields.map((field) => scene[field] ?? null) }) !== transaction.fence) return this.transactionError(id, "scene identity or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "scene.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("scene change was not confirmed");
      const verified = (await adapter.snapshotAsync(context)).scenes.find((candidate) => candidate.ref === transaction.payload.ref);
      if (!verified) throw new Error("edited scene disappeared after apply");
      for (const field of fields) if (transaction.payload[field] !== undefined && (verified as unknown as JsonObject)[field] !== transaction.payload[field]) throw new Error("scene postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Scene state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveSceneFirePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["ref"]) || !isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("scene.fire-selected")) throw new Error("scene fire-as-selected is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref);
      if (!scene || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("scene identity is not authoritative");
      const fireState = { isTriggered: scene.isTriggered ?? null, playing: snapshot.playback.transport.playing };
      const payload: Record<string, unknown> = { ref: params.ref, expectedObjectIdentity: scene.objectIdentity, expectedAuthorityRevision: this.sceneCollectionRevision(snapshot), expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(fireState)).digest("hex") };
      const fence = JSON.stringify({ ref: params.ref, objectIdentity: scene.objectIdentity, fireState });
      const transaction: ClipLifecycleTransaction = { id: `scenefire_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "scene-fire", fence, payload, prior: { isTriggered: scene.isTriggered ?? null }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "scene fire");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, fireState, impact: "fires-scene-audible-direct-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Scene-fire preview requires fresh authoritative state."); }
  }

  private async liveSceneFireApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "scene-fire" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired scene-fire transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        const fireState = { isTriggered: scene?.isTriggered ?? null, playing: snapshot.playback.transport.playing };
        if (!scene || JSON.stringify({ ref: transaction.payload.ref, objectIdentity: scene.objectIdentity, fireState }) !== transaction.fence) return this.transactionError(id, "scene identity or fire state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "scene.fire-selected", args: transaction.payload }, context) as { fired?: unknown };
      if (result.fired !== true) throw new Error("scene fire was not confirmed");
      // Scene.is_triggered is transient (queued for launch); with immediate
      // quantization it can already be false after a successful audible fire.
      // Accept the queued flag or durable playing evidence over a bounded
      // window before declaring the outcome uncertain.
      let confirmed = false;
      for (let attempt = 0; attempt < 4 && !confirmed; attempt += 1) {
        if (attempt > 0) await this.waitFor(200);
        const verified = await adapter.snapshotAsync(context);
        const scene = (verified.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        const targets = [...(verified.playback.firedTargets ?? []), ...(verified.playback.playingTargets ?? [])] as unknown as JsonObject[];
        confirmed = scene?.isTriggered === true || verified.playback.transport.playing === true || targets.some((target) => target.sceneRef === transaction.payload.ref);
      }
      if (!confirmed) throw new Error("scene fire postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Scene-fire state is uncertain; inspect Live before retrying."); }
  }

  private async liveSongStateAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const conversions = ["beats-loop", "current-smpte"] as const;
    const smpteFormats = ["smpte-24", "smpte-25", "smpte-29", "smpte-30", "smpte-30-drop"] as const;
    if (!isObject(params) || !hasOnly(params, ["conversion", "smpteFormat"])) return error(id, -32602, "only conversion and smpteFormat are accepted");
    if (params.conversion !== undefined && !conversions.includes(params.conversion as typeof conversions[number])) return error(id, -32602, "conversion is invalid");
    if (params.smpteFormat !== undefined && !smpteFormats.includes(params.smpteFormat as typeof smpteFormats[number])) return error(id, -32602, "smpteFormat is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("song.read")) throw new Error("song state reads are unavailable");
      const adapter = this.asyncAdapter();
      const snapshot = await adapter.snapshotAsync();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const state = await adapter.invokeAsync({ operation: "song.read", args: { setRef: snapshot.set.ref } }, context) as Record<string, unknown>;
      if (params.conversion !== undefined && (status.operations ?? []).includes("song.time-convert")) {
        const args: Record<string, unknown> = { setRef: snapshot.set.ref, query: params.conversion };
        if (params.smpteFormat !== undefined) args.smpteFormat = params.smpteFormat;
        state.conversions = await adapter.invokeAsync({ operation: "song.time-convert", args }, context);
      }
      return this.successText(id, state);
    } catch (cause) { return this.adapterToolError(id, cause, "Song state requires a fresh connection."); }
  }

  private async livePerformanceReadAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (params !== undefined && (!isObject(params) || Object.keys(params).length > 0)) return error(id, -32602, "no arguments are accepted");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("performance.read")) throw new Error("performance reads are unavailable");
      const adapter = this.asyncAdapter();
      const snapshot = await adapter.snapshotAsync();
      return this.successText(id, await adapter.invokeAsync({ operation: "performance.read", args: { setRef: snapshot.set.ref } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }));
    } catch (cause) { return this.adapterToolError(id, cause, "Performance read requires a fresh connection."); }
  }

  private async liveTransportActionPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["start", "continue", "stop", "play-selection", "scrub", "tap-tempo", "nudge-up", "nudge-down", "re-enable-automation", "trigger-session-record", "force-link-beat-time", "stop-all-clips"] as const;
    const audible = ["start", "continue", "play-selection", "scrub", "trigger-session-record", "force-link-beat-time"];
    if (!isObject(params) || !hasOnly(params, ["action", "beatTime"]) || !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "a valid action is required");
    if ((params.action === "force-link-beat-time" || params.action === "scrub") && (typeof params.beatTime !== "number" || !Number.isFinite(params.beatTime))) return error(id, -32602, `beatTime is required for ${params.action === "scrub" ? "the scrub distance" : "force-link-beat-time"}`);
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("transport.action")) throw new Error("transport actions are unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      if (!isNonEmptyString(snapshot.set.objectIdentity, 256) || !isNonEmptyString(snapshot.playback.revision, 128)) throw new Error("transport identity is not authoritative");
      const payload: Record<string, unknown> = { setRef: snapshot.set.ref, action: params.action, ...(params.beatTime !== undefined ? { beatTime: params.beatTime } : {}), expectedObjectIdentity: snapshot.set.objectIdentity, expectedRevision: snapshot.playback.revision };
      const fence = JSON.stringify({ setRef: snapshot.set.ref, identity: snapshot.set.objectIdentity, playbackRevision: snapshot.playback.revision });
      const transaction: ClipLifecycleTransaction = { id: `transportaction_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "transport-action", fence, payload, prior: { playing: snapshot.playback.transport.playing, position: snapshot.playback.transport.position ?? 0 }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "transport action");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, impact: audible.includes(params.action as string) ? "audible-transport-action-no-undo" : "momentary-transport-action-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Transport-action preview requires fresh authoritative state."); }
  }

  private async liveTransportActionApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "transport-action" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired transport-action transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context);
        if (JSON.stringify({ setRef: transaction.payload.setRef, identity: snapshot.set.objectIdentity, playbackRevision: snapshot.playback.revision }) !== transaction.fence) return this.transactionError(id, "transport state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "transport.action", args: transaction.payload }, context) as { done?: unknown; revision?: unknown };
      if (result.done !== true) throw new Error("transport action was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Transport state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveTrackStructurePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["action", "name", "ref"])) return error(id, -32602, "action is required");
    const actions = ["create-return", "delete-return", "duplicate-track", "duplicate-scene"] as const;
    if (!actions.includes(params.action as typeof actions[number])) return error(id, -32602, "action is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.action === "create-return" ? "track.create-return" : params.action === "delete-return" ? "track.delete-return" : params.action === "duplicate-track" ? "track.duplicate" : "scene.duplicate";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const structureRevision = this.structureRevision(snapshot);
      let payload: Record<string, unknown>;
      if (params.action === "create-return") {
        if (params.name !== undefined && !isNonEmptyString(params.name, 256)) return error(id, -32602, "name is invalid");
        payload = { action: params.action, ...(params.name !== undefined ? { name: params.name } : {}), expectedStructureRevision: structureRevision };
      } else {
        if (!isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
        if (params.action === "delete-return") {
          const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref && candidate.kind === "return");
          if (!track || !isNonEmptyString(track.objectIdentity, 256)) return this.transactionError(id, "return-track reference is unknown");
          payload = { action: params.action, ref: params.ref, expectedObjectIdentity: track.objectIdentity, expectedStructureRevision: structureRevision };
        } else if (params.action === "duplicate-track") {
          const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref && !["return", "main", "master"].includes(candidate.kind as string));
          if (!track || !isNonEmptyString(track.objectIdentity, 256)) return this.transactionError(id, "track reference is unknown or not a regular track");
          payload = { action: params.action, ref: params.ref, expectedObjectIdentity: track.objectIdentity, expectedStructureRevision: structureRevision };
        } else {
          const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref);
          if (!scene || !isNonEmptyString(scene.objectIdentity, 256)) return this.transactionError(id, "scene reference is unknown");
          payload = { action: params.action, ref: params.ref, expectedObjectIdentity: scene.objectIdentity, expectedStructureRevision: structureRevision };
        }
      }
      const fence = JSON.stringify({ action: params.action, payload, structureRevision });
      const transaction: ClipLifecycleTransaction = { id: `trackstruct_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "track-structure", fence, payload, prior: {}, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "track structure");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, impact: params.action === "delete-return" ? "deletes-return-track-no-undo" : "creates-track-structure", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Track-structure preview requires fresh authoritative state."); }
  }

  private async liveTrackStructureApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "track-structure" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired track-structure transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const structureRevision = this.structureRevision(await adapter.snapshotAsync(context));
        if (JSON.stringify({ action: transaction.payload.action, payload: transaction.payload, structureRevision }) !== transaction.fence) return this.transactionError(id, "structure changed since preview; preview again"); }
      const action = transaction.payload.action as string;
      const operation = action === "create-return" ? "track.create-return" : action === "delete-return" ? "track.delete-return" : action === "duplicate-track" ? "track.duplicate" : "scene.duplicate";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      if (action === "delete-return") {
        if (result.deleted !== transaction.payload.ref) throw new Error("return-track deletion was not confirmed");
      } else {
        if (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64)) throw new Error("track-structure creation did not return exact identity");
        // Bind the complete applied content (devices, clips, mixer, routing)
        // so cleanup cannot delete a creation after nested content changed.
        const appliedSnapshot = await adapter.snapshotAsync(context);
        const appliedKind = action === "duplicate-scene" ? "scene" : "track";
        const contentFingerprint = this.sessionStructureCreatedFingerprint(appliedSnapshot, appliedKind, result.ref as LiveRef);
        transaction.created = { ...result, contentFingerprint };
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Track-structure state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveDeviceDeletePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["ref"]) || !isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("device.delete")) throw new Error("device deletion is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.ref as LiveRef);
      const payload: Record<string, unknown> = { ref: params.ref, expectedObjectIdentity: row.device.objectIdentity, expectedOwnerRef: row.ownerRef, expectedOwnerIdentity: row.ownerIdentity, expectedSiblings: row.siblings, expectedTrackRef: row.track.ref, expectedTrackIdentity: row.track.objectIdentity };
      const fence = JSON.stringify({ ref: params.ref, objectIdentity: row.device.objectIdentity, ownerRef: row.ownerRef, ownerIdentity: row.ownerIdentity, siblings: row.siblings, trackRef: row.track.ref, trackIdentity: row.track.objectIdentity });
      const transaction: ClipLifecycleTransaction = { id: `devdel_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device-delete", fence, payload, prior: { name: row.device.name }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device delete");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, device: { name: row.device.name, kind: row.device.kind }, impact: "deletes-device-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device-delete preview requires fresh authoritative state."); }
  }

  private async liveDeviceDeleteApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device-delete" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired device-delete transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        if (JSON.stringify({ ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, ownerRef: row.ownerRef, ownerIdentity: row.ownerIdentity, siblings: row.siblings, trackRef: row.track.ref, trackIdentity: row.track.objectIdentity }) !== transaction.fence) return this.transactionError(id, "device or sibling hierarchy changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "device.delete", args: transaction.payload }, context) as { deleted?: unknown };
      if (result.deleted !== transaction.payload.ref) throw new Error("device deletion was not confirmed");
      const after = await adapter.snapshotAsync(context);
      try { this.deviceRow(after, transaction.payload.ref as LiveRef); throw new Error("deleted device remains discoverable after apply"); } catch (cause) { if (cause instanceof Error && cause.message === "deleted device remains discoverable after apply") throw cause; }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Device state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveTrackViewPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["ref", "collapsed", "deviceInsertMode", "selectInstrument"]) || !isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
    if (params.collapsed === undefined && params.deviceInsertMode === undefined && params.selectInstrument !== true) return error(id, -32602, "at least one view field or selectInstrument is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref);
      if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is not authoritative");
      const viewState = { collapsed: (track.view as JsonObject | undefined)?.isCollapsed ?? null, deviceInsertMode: (track.view as JsonObject | undefined)?.deviceInsertMode ?? null };
      const stateRevision = createHash("sha256").update(canonicalMutationIdentity(viewState)).digest("hex");
      const proposed: Record<string, unknown> = {};
      if (params.collapsed !== undefined) { if (typeof params.collapsed !== "boolean") return error(id, -32602, "collapsed must be boolean"); proposed.collapsed = params.collapsed; }
      if (params.deviceInsertMode !== undefined) { if (!Number.isInteger(params.deviceInsertMode) || (params.deviceInsertMode as number) < 0 || (params.deviceInsertMode as number) > 8) return error(id, -32602, "deviceInsertMode is invalid"); proposed.deviceInsertMode = params.deviceInsertMode; }
      if (Object.keys(proposed).length > 0 && !(status.operations ?? []).includes("track.view.set")) throw new Error("track view editing is unavailable");
      if (params.selectInstrument === true && !(status.operations ?? []).includes("track.select-instrument")) throw new Error("instrument selection is unavailable");
      const payload: Record<string, unknown> = { ref: params.ref, ...proposed, selectInstrument: params.selectInstrument === true, expectedObjectIdentity: track.objectIdentity, expectedStateRevision: stateRevision };
      const prior = { collapsed: viewState.collapsed, deviceInsertMode: viewState.deviceInsertMode };
      const fence = JSON.stringify({ ref: params.ref, objectIdentity: track.objectIdentity, viewState });
      const transaction: ClipLifecycleTransaction = { id: `trackview_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "track-view", fence, clipRef: params.ref as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "track view");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, prior, proposed, selectInstrument: params.selectInstrument === true, impact: "edits-track-view", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Track-view preview requires fresh authoritative state."); }
  }

  private async liveTrackViewApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "track-view" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired track-view transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        const viewState = { collapsed: (track?.view as JsonObject | undefined)?.isCollapsed ?? null, deviceInsertMode: (track?.view as JsonObject | undefined)?.deviceInsertMode ?? null };
        if (!track || JSON.stringify({ ref: transaction.payload.ref, objectIdentity: track.objectIdentity, viewState }) !== transaction.fence) return this.transactionError(id, "track identity or view state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const hasViewEdits = transaction.payload.collapsed !== undefined || transaction.payload.deviceInsertMode !== undefined;
      if (hasViewEdits) {
        const args = { ref: transaction.payload.ref, ...(transaction.payload.collapsed !== undefined ? { collapsed: transaction.payload.collapsed } : {}), ...(transaction.payload.deviceInsertMode !== undefined ? { deviceInsertMode: transaction.payload.deviceInsertMode } : {}), expectedObjectIdentity: transaction.payload.expectedObjectIdentity, expectedStateRevision: transaction.payload.expectedStateRevision };
        const result = await adapter.invokeAsync({ operation: "track.view.set", args }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("track view change was not confirmed");
      }
      if (transaction.payload.selectInstrument === true) {
        const freshSnapshot = await adapter.snapshotAsync(context);
        const freshTrack = (freshSnapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        const freshState = { collapsed: (freshTrack?.view as JsonObject | undefined)?.isCollapsed ?? null, deviceInsertMode: (freshTrack?.view as JsonObject | undefined)?.deviceInsertMode ?? null };
        const freshRevision = createHash("sha256").update(canonicalMutationIdentity(freshState)).digest("hex");
        const result = await adapter.invokeAsync({ operation: "track.select-instrument", args: { ref: transaction.payload.ref, expectedObjectIdentity: freshTrack?.objectIdentity, expectedStateRevision: freshRevision } }, context) as { done?: unknown };
        if (result.done !== true) throw new Error("instrument selection was not confirmed");
      }
      if (hasViewEdits) { const verified = ((await adapter.snapshotAsync(context)).tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        const view = verified?.view as JsonObject | undefined;
        if (transaction.payload.collapsed !== undefined && view?.isCollapsed !== transaction.payload.collapsed) throw new Error("track view postcondition was not confirmed");
        if (transaction.payload.deviceInsertMode !== undefined && view?.deviceInsertMode !== transaction.payload.deviceInsertMode) throw new Error("track view postcondition was not confirmed"); }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Track-view state is uncertain; perform fresh discovery before retrying."); }
  }

  private trackPropertiesStateRevision(track: JsonObject): string {
    return createHash("sha256").update(canonicalMutationIdentity({ colorIndex: track.colorIndex ?? null })).digest("hex");
  }

  private async liveTrackPropertiesPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["ref", "colorIndex"]) || !isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
    if (params.colorIndex === undefined) return error(id, -32602, "at least one track property is required");
    if (!Number.isInteger(params.colorIndex) || (params.colorIndex as number) < 0 || (params.colorIndex as number) > 69) return error(id, -32602, "colorIndex is out of bounds");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("track.set")) throw new Error("track property editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.ref);
      if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is not authoritative");
      const prior = { colorIndex: track.colorIndex ?? null };
      const payload: Record<string, unknown> = { ref: params.ref, colorIndex: params.colorIndex, expectedObjectIdentity: track.objectIdentity, expectedStateRevision: this.trackPropertiesStateRevision(track) };
      const fence = JSON.stringify({ ref: params.ref, objectIdentity: track.objectIdentity, state: [track.colorIndex ?? null] });
      const transaction: ClipLifecycleTransaction = { id: `trackset_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "track-set", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "track properties edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, prior, proposed: { colorIndex: params.colorIndex }, impact: "edits-track-properties", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Track-properties preview requires fresh authoritative state."); }
  }

  private async liveTrackPropertiesApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "track-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired track-properties transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
        if (!track || JSON.stringify({ ref: transaction.payload.ref, objectIdentity: track.objectIdentity, state: [track.colorIndex ?? null] }) !== transaction.fence) return this.transactionError(id, "track identity or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "track.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("track properties change was not confirmed");
      const verified = ((await adapter.snapshotAsync(context)).tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.payload.ref);
      if (!verified) throw new Error("edited track disappeared after apply");
      if ((verified as unknown as JsonObject).colorIndex !== transaction.payload.colorIndex) throw new Error("track properties postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Track properties state is uncertain; perform fresh discovery before retrying."); }
  }

  private songSettingsFields(song: JsonObject): Record<string, unknown> {
    const quantizationValue = (entry: unknown): unknown => (entry as { value?: unknown } | null | undefined)?.value ?? null;
    return { signatureNumerator: song.signatureNumerator ?? null, signatureDenominator: song.signatureDenominator ?? null, swingAmount: song.swingAmount ?? null, clipTriggerQuantization: quantizationValue(song.clipTriggerQuantization), midiRecordingQuantization: quantizationValue(song.midiRecordingQuantization) };
  }

  private songSettingsRevision(song: JsonObject): string {
    return createHash("sha256").update(canonicalMutationIdentity(this.songSettingsFields(song))).digest("hex");
  }

  private async liveSongSettingsPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["signatureNumerator", "signatureDenominator", "swingAmount", "clipTriggerQuantization", "midiRecordingQuantization"] as const;
    if (!isObject(params) || !hasOnly(params, [...fields])) return error(id, -32602, "song settings arguments are invalid");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "signatureNumerator" || field === "signatureDenominator") { if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 99) return error(id, -32602, `${field} is out of bounds`); }
      else if (field === "swingAmount") { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return error(id, -32602, "swingAmount is out of bounds"); }
      else if (field === "clipTriggerQuantization") { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 13) return error(id, -32602, "clipTriggerQuantization is out of bounds"); }
      else if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 8) return error(id, -32602, "midiRecordingQuantization is out of bounds");
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one song settings field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("song.set")) throw new Error("song settings editing is unavailable");
      const adapter = this.asyncAdapter();
      const snapshot = await adapter.snapshotAsync();
      const song = await adapter.invokeAsync({ operation: "song.read", args: { setRef: snapshot.set.ref } }) as JsonObject;
      const settings = this.songSettingsFields(song);
      if (Object.keys(proposed).some((field) => settings[field] === null)) return this.transactionError(id, "one or more requested song settings are unavailable on this shape");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = settings[field];
      const payload: Record<string, unknown> = { ...proposed, expectedStateRevision: this.songSettingsRevision(song) };
      const fence = JSON.stringify({ state: fields.map((field) => settings[field]) });
      const transaction: ClipLifecycleTransaction = { id: `songset_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "song-set", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "song settings edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, prior, proposed, impact: "edits-song-settings-playback-feel", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Song-settings preview requires fresh authoritative state."); }
  }

  private async liveSongSettingsApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "song-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired song-settings transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const fields = ["signatureNumerator", "signatureDenominator", "swingAmount", "clipTriggerQuantization", "midiRecordingQuantization"];
      if (!reconciliation) { const song = await adapter.invokeAsync({ operation: "song.read", args: { setRef: snapshot.set.ref } }, context) as JsonObject;
        const settings = this.songSettingsFields(song);
        if (JSON.stringify({ state: fields.map((field) => settings[field]) }) !== transaction.fence) return this.transactionError(id, "song settings changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "song.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("song settings change was not confirmed");
      const verified = this.songSettingsFields(await adapter.invokeAsync({ operation: "song.read", args: { setRef: snapshot.set.ref } }, context) as JsonObject);
      for (const field of fields) if (transaction.payload[field] !== undefined && verified[field] !== transaction.payload[field]) throw new Error("song settings postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Song settings state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveKeyEstimateAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "notes", "expectedNotesRevision"])) return error(id, -32602, "key estimate arguments are invalid");
    if (params.notes !== undefined) {
      if (params.clipRef !== undefined || params.expectedNotesRevision !== undefined) return error(id, -32602, "notes is mutually exclusive with clipRef and expectedNotesRevision");
      if (!Array.isArray(params.notes) || params.notes.length > 4096) return error(id, -32602, "notes must be an array of at most 4096 note objects");
      const notes: Array<{ pitch: number; start: number; duration: number; velocity?: number }> = [];
      for (const entry of params.notes) {
        if (!isObject(entry) || !hasOnly(entry, ["pitch", "start", "duration", "velocity"])) return error(id, -32602, "note objects may only carry pitch, start, duration, and velocity");
        if (!Number.isInteger(entry.pitch) || (entry.pitch as number) < 0 || (entry.pitch as number) > 127) return error(id, -32602, "note pitch must be an integer in 0..127");
        if (typeof entry.start !== "number" || !Number.isFinite(entry.start) || entry.start < 0) return error(id, -32602, "note start must be a finite non-negative number");
        if (typeof entry.duration !== "number" || !Number.isFinite(entry.duration) || entry.duration <= 0) return error(id, -32602, "note duration must be a finite positive number");
        if (entry.velocity !== undefined && (!Number.isInteger(entry.velocity) || (entry.velocity as number) < 0 || (entry.velocity as number) > 127)) return error(id, -32602, "note velocity must be an integer in 0..127");
        notes.push({ pitch: entry.pitch as number, start: entry.start, duration: entry.duration, ...(entry.velocity !== undefined ? { velocity: entry.velocity as number } : {}) });
      }
      return this.successText(id, estimateKey(notes) as unknown as JsonObject);
    }
    if (!isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef or notes are required");
    if (params.expectedNotesRevision !== undefined && (typeof params.expectedNotesRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedNotesRevision))) return error(id, -32602, "expectedNotesRevision must be a 64-character hex digest");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (row.clip.isAudio === true || row.clip.kind === "audio") return this.transactionError(id, "key estimation requires a MIDI clip");
      const notes = ((row.clip.notes as unknown as Array<{ pitch: number; start: number; duration: number; velocity?: number }>) ?? []).filter((note) => Number.isInteger(note.pitch) && typeof note.duration === "number" && note.duration > 0);
      const notesRevision = typeof row.clip.notesRevision === "string" ? row.clip.notesRevision : createHash("sha256").update(canonicalMutationIdentity(notes)).digest("hex");
      if (params.expectedNotesRevision !== undefined && params.expectedNotesRevision !== notesRevision) return this.transactionError(id, "clip notes changed since the fenced revision");
      const estimate = estimateKey(notes);
      return this.successText(id, { ...estimate, evidence: { ...estimate.evidence, clipRef: params.clipRef, notesRevision } } as unknown as JsonObject);
    } catch (cause) { return this.adapterToolError(id, cause, "Key estimation requires fresh authoritative state."); }
  }

  private selectionRevision(snapshot: LiveSnapshot): string {
    const selection = snapshot.selection ?? {};
    return createHash("sha256").update(canonicalMutationIdentity({ trackRef: selection.trackRef ?? null, sceneRef: selection.sceneRef ?? null, slotRef: selection.slotRef ?? null, detailClipRef: selection.detailClipRef ?? null, deviceRef: selection.deviceRef ?? null, parameterRef: selection.parameterRef ?? null, chainRef: selection.chainRef ?? null })).digest("hex");
  }

  private async liveSelectionPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["trackRef", "sceneRef", "slotRef", "detailClipRef", "deviceRef", "parameterRef", "chainRef"] as const;
    if (!isObject(params) || !hasOnly(params, [...fields, "drawMode"])) return error(id, -32602, "only selection fields and drawMode are accepted");
    if (fields.every((field) => params[field] === undefined) && params.drawMode === undefined) return error(id, -32602, "at least one selection field or drawMode is required");
    if (params.drawMode !== undefined && typeof params.drawMode !== "boolean") return error(id, -32602, "drawMode must be boolean");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const proposed: Record<string, unknown> = {};
      for (const field of fields) {
        const value = params[field];
        if (value === undefined) continue;
        if (value !== null && !isNonEmptyString(value, 256)) return error(id, -32602, `${field} is invalid`);
        if (value !== null && !(status.operations ?? []).includes("selection.set")) throw new Error("selection editing is unavailable");
        proposed[field] = value;
      }
      if (params.drawMode !== undefined && !(status.operations ?? []).includes("song.view.set")) throw new Error("draw-mode editing is unavailable");
      const selectionRevision = this.selectionRevision(snapshot);
      const payload: Record<string, unknown> = { ...proposed, expectedStateRevision: selectionRevision };
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = (snapshot.selection as Record<string, unknown> | undefined)?.[field] ?? null;
      if (params.drawMode !== undefined) prior.drawMode = snapshot.view?.drawMode ?? null;
      const fence = JSON.stringify({ proposed, selectionRevision, drawMode: snapshot.view?.drawMode ?? null });
      const transaction: ClipLifecycleTransaction = { id: `selection_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "selection", fence, payload: { ...payload, drawMode: params.drawMode }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "selection");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, prior, proposed: { ...proposed, drawMode: params.drawMode }, impact: "edits-live-selection", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Selection preview requires fresh authoritative state."); }
  }

  private async liveSelectionApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "selection" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired selection transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context);
        const proposed = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => !["expectedStateRevision", "drawMode"].includes(key)));
        if (JSON.stringify({ proposed, selectionRevision: this.selectionRevision(snapshot), drawMode: snapshot.view?.drawMode ?? null }) !== transaction.fence) return this.transactionError(id, "selection state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const selectionFields = Object.entries(transaction.payload).filter(([key]) => !["expectedStateRevision", "drawMode"].includes(key));
      let selectionApplied = false;
      if (selectionFields.length > 0) {
        const selectionArgs = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "drawMode"));
        const result = await adapter.invokeAsync({ operation: "selection.set", args: selectionArgs }, context) as { changed?: unknown; revision?: unknown };
        if (result.changed !== true) throw new Error("selection change was not confirmed");
        selectionApplied = true;
      }
      if (transaction.payload.drawMode !== undefined) {
        // Fence on the captured prior draw state, then compensate the selection
        // dispatch if the draw change fails so the combined operation does not
        // strand a half-applied edit behind an uncertain transaction.
        const priorDraw = (transaction.prior as { drawMode?: unknown }).drawMode ?? null;
        const drawRevision = createHash("sha256").update(canonicalMutationIdentity({ drawMode: priorDraw })).digest("hex");
        try {
          const drawResult = await adapter.invokeAsync({ operation: "song.view.set", args: { drawMode: transaction.payload.drawMode, expectedStateRevision: drawRevision } }, context) as { changed?: unknown };
          if (drawResult.changed !== true) throw new Error("draw-mode change was not confirmed");
        } catch (cause) {
          if (selectionApplied && transaction.prior) {
            // The mapper's selection.set rejects drawMode; compensation must carry only exact prior selection fields.
            const compensation = Object.fromEntries(Object.entries(transaction.prior as Record<string, unknown>).filter(([key]) => key !== "drawMode"));
            try { await adapter.invokeAsync({ operation: "selection.set", args: { ...compensation, expectedStateRevision: this.selectionRevision(await adapter.snapshotAsync(context)) } }, context); } catch { throw new Error("draw-mode change failed and selection compensation failed"); }
          }
          throw cause;
        }
      }
      const verified = await adapter.snapshotAsync(context);
      for (const [field, value] of Object.entries(transaction.payload)) {
        if (["expectedStateRevision", "drawMode"].includes(field)) continue;
        if (field.endsWith("Ref") && ((verified.selection as Record<string, unknown> | undefined)?.[field] ?? null) !== value) throw new Error("selection postcondition was not confirmed");
      }
      if (transaction.payload.drawMode !== undefined && verified.view?.drawMode !== transaction.payload.drawMode) throw new Error("draw-mode postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Selection state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveClipViewPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["gridQuantization", "gridIsTriplet", "showEnvelope"] as const;
    if (!isObject(params) || !hasOnly(params, ["clipRef", "showLoop", ...fields]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    if (fields.every((field) => params[field] === undefined) && params.showLoop !== true) return error(id, -32602, "at least one clip view field or showLoop is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("clip.view.set")) throw new Error("clip view editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      const viewState = { gridQuantization: (row.clip.clipView as JsonObject | undefined)?.gridQuantization ?? null, gridIsTriplet: (row.clip.clipView as JsonObject | undefined)?.gridIsTriplet ?? null };
      const proposed: Record<string, unknown> = {};
      for (const field of fields) {
        const value = params[field];
        if (value === undefined) continue;
        if (field === "gridQuantization" && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 16)) return error(id, -32602, "gridQuantization is invalid");
        if ((field === "gridIsTriplet" || field === "showEnvelope") && typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`);
        proposed[field] = value;
      }
      const prior = { ...viewState };
      const payload: Record<string, unknown> = { ref: params.clipRef, ...proposed, showLoop: params.showLoop === true, expectedObjectIdentity: row.clip.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(viewState)).digest("hex") };
      const fence = JSON.stringify({ ref: params.clipRef, objectIdentity: row.clip.objectIdentity, viewState });
      const transaction: ClipLifecycleTransaction = { id: `clipview_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "clip-view", fence, clipRef: params.clipRef as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip view");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, prior, proposed, showLoop: params.showLoop === true, impact: "edits-clip-view", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-view preview requires fresh authoritative state."); }
  }

  private async liveClipViewApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "clip-view" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-view transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, transaction.clipRef!);
        const viewState = { gridQuantization: (row.clip.clipView as JsonObject | undefined)?.gridQuantization ?? null, gridIsTriplet: (row.clip.clipView as JsonObject | undefined)?.gridIsTriplet ?? null };
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: row.clip.objectIdentity, viewState }) !== transaction.fence) return this.transactionError(id, "clip identity or view state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "clip.view.set", args: transaction.payload }, context) as { changed?: unknown };
      if (result.changed !== true) throw new Error("clip view change was not confirmed");
      const verified = this.clipRow(await adapter.snapshotAsync(context), transaction.clipRef!).clip;
      const view = verified.clipView as JsonObject | undefined;
      for (const field of ["gridQuantization", "gridIsTriplet"]) if (transaction.payload[field] !== undefined && view?.[field] !== transaction.payload[field]) throw new Error("clip view postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip-view state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveDeviceViewPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["ref", "collapsed"]) || !isNonEmptyString(params.ref, 256) || typeof params.collapsed !== "boolean") return error(id, -32602, "ref and collapsed are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("device.view.set")) throw new Error("device view editing is unavailable on this Live shape");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.ref as LiveRef);
      const current = (row.device.view as JsonObject | undefined)?.isCollapsed ?? null;
      if (current === null) return this.transactionError(id, "device collapsed state is unavailable on this exact device");
      const payload: Record<string, unknown> = { ref: params.ref, collapsed: params.collapsed, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ collapsed: current })).digest("hex") };
      const fence = JSON.stringify({ ref: params.ref, objectIdentity: row.device.objectIdentity, collapsed: current });
      const transaction: ClipLifecycleTransaction = { id: `devview_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device-view", fence, payload, prior: { collapsed: current }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device view");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ref: params.ref, prior: { collapsed: current }, proposed: { collapsed: params.collapsed }, impact: "edits-device-view", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device-view preview requires fresh authoritative state."); }
  }

  private async liveDeviceViewApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device-view" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired device-view transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        const current = (row.device.view as JsonObject | undefined)?.isCollapsed ?? null;
        if (JSON.stringify({ ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, collapsed: current }) !== transaction.fence) return this.transactionError(id, "device identity or view state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "device.view.set", args: transaction.payload }, context) as { changed?: unknown };
      if (result.changed !== true) throw new Error("device view change was not confirmed");
      const verified = this.deviceRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef).device;
      if ((verified.view as JsonObject | undefined)?.isCollapsed !== transaction.payload.collapsed) throw new Error("device view postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Device-view state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveApplicationDialogPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["button"])) return error(id, -32602, "button is optional; omit for a read-only dialog state check");
    if (params.button !== undefined && (!Number.isInteger(params.button) || (params.button as number) < 0 || (params.button as number) > 16)) return error(id, -32602, "button is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("application.dialog")) throw new Error("application dialog surface is unavailable");
      const adapter = this.asyncAdapter();
      const read = await adapter.invokeAsync({ operation: "application.dialog", args: { action: "read" } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { buttonCount?: unknown; message?: unknown; openDialogCount?: unknown; done?: unknown };
      const dialogState = { buttonCount: read.buttonCount ?? null, message: read.message ?? null, openDialogCount: read.openDialogCount ?? null };
      if (params.button === undefined) return this.successText(id, { ...dialogState, done: true });
      if (typeof dialogState.buttonCount !== "number" || typeof dialogState.openDialogCount !== "number") throw new Error("the current dialog shape is not observable; guarded presses are refused");
      if ((params.button as number) >= dialogState.buttonCount) return error(id, -32602, "button is not present in the current dialog");
      const payload: Record<string, unknown> = { action: "press", button: params.button, expectedMessage: dialogState.message, expectedButtonCount: dialogState.buttonCount, expectedOpenDialogCount: dialogState.openDialogCount };
      const fence = JSON.stringify({ button: params.button, ...dialogState });
      const transaction: ClipLifecycleTransaction = { id: `dialog_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "dialog", fence, payload, prior: dialogState, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "dialog");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, ...dialogState, button: params.button, impact: "presses-dialog-button-potentially-destructive", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Dialog preview requires a fresh connection."); }
  }

  private async liveApplicationDialogApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "dialog" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired dialog transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const read = await adapter.invokeAsync({ operation: "application.dialog", args: { action: "read" } }, context) as { buttonCount?: unknown; message?: unknown; openDialogCount?: unknown };
      if (JSON.stringify({ button: transaction.payload.button, buttonCount: read.buttonCount ?? null, message: read.message ?? null, openDialogCount: read.openDialogCount ?? null }) !== transaction.fence) return this.transactionError(id, "dialog state changed since preview; the press was refused");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "application.dialog", args: transaction.payload }, context) as { done?: unknown; buttonCount?: unknown; message?: unknown; openDialogCount?: unknown };
      if (result.done !== true) throw new Error("dialog press was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", stateAfter: { buttonCount: result.buttonCount ?? null, message: result.message ?? null, openDialogCount: result.openDialogCount ?? null }, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Dialog state is uncertain; inspect Live before retrying."); }
  }

  private async liveMixerExtendedPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["trackActivator", "crossfader", "crossfadeAssign", "panningMode", "panningLeft", "panningRight"] as const;
    if (!isObject(params) || !hasOnly(params, ["trackRef", ...fields]) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "trackRef is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "trackActivator" && typeof value !== "boolean") return error(id, -32602, "trackActivator must be boolean");
      if ((field === "crossfader" || field === "panningLeft" || field === "panningRight") && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1)) return error(id, -32602, `${field} must be -1 to 1`);
      if (field === "crossfadeAssign" && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2)) return error(id, -32602, "crossfadeAssign must be 0-2");
      if (field === "panningMode" && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 8)) return error(id, -32602, "panningMode must be 0-8");
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one extended mixer field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("mixer.extended.set")) throw new Error("extended mixer editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.trackRef);
      if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is not authoritative");
      const mixer = track.mixer as JsonObject | undefined;
      if (!mixer || !isNonEmptyString(mixer.mixerIdentity as string, 256)) throw new Error("mixer identity is not authoritative");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = mixer[field] ?? null;
      const state = { crossfadeAssign: mixer.crossfadeAssign ?? null, panningMode: mixer.panningMode ?? null };
      const payload: Record<string, unknown> = { ref: params.trackRef, ...proposed, expectedObjectIdentity: track.objectIdentity, expectedMixerIdentity: mixer.mixerIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
      const fence = JSON.stringify({ ref: params.trackRef, objectIdentity: track.objectIdentity, mixerIdentity: mixer.mixerIdentity, state });
      const transaction: ClipLifecycleTransaction = { id: `mixerext_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "mixer-extended", fence, clipRef: params.trackRef as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "extended mixer");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, trackRef: params.trackRef, prior, proposed, impact: "edits-extended-mixer", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Extended-mixer preview requires fresh authoritative state."); }
  }

  private async liveMixerExtendedApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "mixer-extended" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired extended-mixer transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.clipRef);
        const mixer = track?.mixer as JsonObject | undefined;
        const state = { crossfadeAssign: mixer?.crossfadeAssign ?? null, panningMode: mixer?.panningMode ?? null };
        if (!track || !mixer || JSON.stringify({ ref: transaction.clipRef, objectIdentity: track.objectIdentity, mixerIdentity: mixer.mixerIdentity, state }) !== transaction.fence) return this.transactionError(id, "track, mixer, or extended state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "mixer.extended.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("extended mixer change was not confirmed");
      const verified = ((await adapter.snapshotAsync(context)).tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === transaction.clipRef)?.mixer as JsonObject | undefined;
      for (const field of ["trackActivator", "crossfader", "crossfadeAssign", "panningMode", "panningLeft", "panningRight"]) if (transaction.payload[field] !== undefined && verified?.[field] !== transaction.payload[field]) throw new Error("extended mixer postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Extended-mixer state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveChainMixerPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["volume", "pan", "sends", "chainActivator"] as const;
    if (!isObject(params) || !hasOnly(params, ["chainRef", ...fields]) || !isNonEmptyString(params.chainRef, 256)) return error(id, -32602, "chainRef is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "chainActivator" && typeof value !== "boolean") return error(id, -32602, "chainActivator must be boolean");
      if (field === "volume" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return error(id, -32602, "volume must be 0-1");
      if (field === "pan" && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1)) return error(id, -32602, "pan must be -1 to 1");
      if (field === "sends" && (!Array.isArray(value) || value.length > 64 || !value.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1))) return error(id, -32602, "sends must be 0-1 values");
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one chain mixer field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("chain-mixer.set")) throw new Error("chain mixer editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const found = this.chainRow(snapshot, params.chainRef as LiveRef);
      const mixer = found.chain.mixer as JsonObject | undefined;
      if (!mixer || !isNonEmptyString(mixer.mixerIdentity as string, 256)) throw new Error("chain mixer identity is not authoritative");
      if (Array.isArray(proposed.sends) && (proposed.sends as unknown[]).length > ((mixer.sends as unknown[]) ?? []).length) return error(id, -32602, "chain has fewer sends than proposed");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = structuredClone(mixer[field] ?? null);
      const payload: Record<string, unknown> = { ref: params.chainRef, ...proposed, expectedObjectIdentity: found.chain.objectIdentity, expectedMixerIdentity: mixer.mixerIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ sends: mixer.sends ?? [] })).digest("hex") };
      const fence = JSON.stringify({ ref: params.chainRef, objectIdentity: found.chain.objectIdentity, mixerIdentity: mixer.mixerIdentity, sends: mixer.sends ?? [] });
      const transaction: ClipLifecycleTransaction = { id: `chainmix_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "chain-mixer", fence, clipRef: params.chainRef as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "chain mixer");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, chainRef: params.chainRef, prior, proposed, impact: "edits-chain-mixer", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Chain-mixer preview requires fresh authoritative state."); }
  }

  private async liveChainMixerApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "chain-mixer" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired chain-mixer transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const found = this.chainRow(snapshot, transaction.clipRef!);
        const mixer = found.chain.mixer as JsonObject | undefined;
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: found.chain.objectIdentity, mixerIdentity: mixer?.mixerIdentity, sends: mixer?.sends ?? [] }) !== transaction.fence) return this.transactionError(id, "chain or mixer state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "chain-mixer.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("chain mixer change was not confirmed");
      const verified = this.chainRow(await adapter.snapshotAsync(context), transaction.clipRef!).chain.mixer as JsonObject | undefined;
      for (const field of ["volume", "pan", "sends", "chainActivator"]) if (transaction.payload[field] !== undefined && JSON.stringify(verified?.[field]) !== JSON.stringify(transaction.payload[field])) throw new Error("chain mixer postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Chain-mixer state is uncertain; perform fresh discovery before retrying."); }
  }

  private chainRow(snapshot: LiveSnapshot, chainRef: LiveRef): { device: JsonObject; chain: JsonObject } {
    const walk = (devices: JsonObject[]): JsonObject | undefined => {
      for (const device of devices) {
        const chains = ((device.chains as unknown[]) ?? []).filter(isObject);
        const found = chains.find((chain) => chain.ref === chainRef);
        if (found) return found;
        for (const chain of chains) { const nested = walk(((chain.devices as unknown[]) ?? []).filter(isObject)); if (nested) return nested; }
        for (const pad of ((device.drumPads as unknown[]) ?? []).filter(isObject)) { for (const chain of ((pad.chains as unknown[]) ?? []).filter(isObject)) { const nested = walk(((chain.devices as unknown[]) ?? []).filter(isObject)); if (nested) return nested; } }
      }
      return undefined;
    };
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      const devices = ((track.devices as unknown[]) ?? []).filter(isObject);
      const found = walk(devices);
      if (found) return { device: devices[0]!, chain: found };
    }
    throw new Error("chain reference is not authoritative");
  }

  private async liveDeviceIoPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["action", "deviceRef", "routingType", "routingChannel"]) || !isNonEmptyString(params.deviceRef, 256) || !isNonEmptyString(params.routingType, 128)) return error(id, -32602, "action, deviceRef, and routingType are required");
    if (params.action !== "routing" && params.action !== "sidechain") return error(id, -32602, "action must be routing or sidechain");
    if (params.action === "routing" && params.routingChannel !== undefined && !isNonEmptyString(params.routingChannel, 128)) return error(id, -32602, "routingChannel is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.action === "routing" ? "device-io.set" : "compressor.sidechain.set";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable on this Live shape`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.deviceRef as LiveRef);
      let state: Record<string, unknown>;
      if (params.action === "routing") {
        const io = (row.device as unknown as { deviceIo?: { routingType?: unknown; routingChannel?: unknown } }).deviceIo;
        if (!io) return this.transactionError(id, "device IO is unavailable on this exact device");
        state = { routingType: io.routingType ?? null, routingChannel: io.routingChannel ?? null };
      } else {
        const sidechain = (row.device as unknown as { sidechainRoutingType?: unknown }).sidechainRoutingType;
        if (sidechain === undefined) return this.transactionError(id, "sidechain routing is unavailable on this exact device");
        state = { routingType: sidechain };
      }
      const payload: Record<string, unknown> = { action: params.action, ref: params.deviceRef, routingType: params.routingType, ...(params.routingChannel !== undefined ? { routingChannel: params.routingChannel } : {}), expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
      const prior = { ...state };
      const fence = JSON.stringify({ ref: params.deviceRef, objectIdentity: row.device.objectIdentity, state });
      const transaction: ClipLifecycleTransaction = { id: `devio_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device-io", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device IO");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, deviceRef: params.deviceRef, prior, impact: "edits-device-routing", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device-IO preview requires fresh authoritative state."); }
  }

  private async liveDeviceIoApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device-io" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired device-IO transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        const device = row.device as unknown as { deviceIo?: { routingType?: unknown; routingChannel?: unknown }; sidechainRoutingType?: unknown };
        const state = transaction.payload.action === "routing" ? { routingType: device.deviceIo?.routingType ?? null, routingChannel: device.deviceIo?.routingChannel ?? null } : { routingType: device.sidechainRoutingType };
        if (JSON.stringify({ ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, state }) !== transaction.fence) return this.transactionError(id, "device or routing state changed since preview; preview again"); }
      const operation = transaction.payload.action === "routing" ? "device-io.set" : "compressor.sidechain.set";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
      const result = await adapter.invokeAsync({ operation, args }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("device routing change was not confirmed");
      const verified = this.deviceRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef).device as unknown as { deviceIo?: { routingType?: unknown; routingChannel?: unknown }; sidechainRoutingType?: unknown };
      if (transaction.payload.action === "routing") {
        if (verified.deviceIo?.routingType !== transaction.payload.routingType) throw new Error("device routing postcondition was not confirmed");
        if (transaction.payload.routingChannel !== undefined && verified.deviceIo?.routingChannel !== transaction.payload.routingChannel) throw new Error("device channel postcondition was not confirmed");
      } else if (verified.sidechainRoutingType !== transaction.payload.routingType) throw new Error("sidechain postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Device-IO state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveDeviceAdvancedPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["set-bank", "re-enable-automation", "save-comparison", "insert-chain", "move-cross"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "ref", "bank", "slot", "trackRef", "chainRef", "deviceName", "index", "targetTrackRef", "targetChainRef"]) || !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "a valid action is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      let payload: Record<string, unknown>;
      let prior: Record<string, unknown> = {};
      let impact = "edits-device";
      if (params.action === "set-bank") {
        if (!(status.operations ?? []).includes("device.bank.set")) throw new Error("parameter banks are unavailable");
        if (!isNonEmptyString(params.ref, 256) || !Number.isInteger(params.bank) || (params.bank as number) < 0 || (params.bank as number) > 32) return error(id, -32602, "ref and bank (0-32) are required");
        const row = this.deviceRow(snapshot, params.ref as LiveRef);
        const bankCount = row.device.parameterBank ?? null;
        if (bankCount === null) return this.transactionError(id, "parameter banks are unavailable on this exact device");
        if ((params.bank as number) >= (bankCount as number)) return error(id, -32602, "bank exceeds the device's parameter bank count");
        payload = { action: params.action, ref: params.ref, bank: params.bank, ...(Number.isInteger(params.scriptIndex) ? { scriptIndex: params.scriptIndex } : {}), expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ bankCount })).digest("hex") };
        prior = { bankCount };
        impact = "momentary-control-surface-bank-selection-no-undo";
      } else if (params.action === "re-enable-automation") {
        if (!(status.operations ?? []).includes("parameter.re-enable-automation")) throw new Error("automation re-enable is unavailable");
        if (!isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
        const located = this.parameterRow(snapshot, params.ref as LiveRef);
        payload = { action: params.action, ref: params.ref, expectedObjectIdentity: located.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ automationState: "none" })).digest("hex") };
        impact = "momentary-no-undo";
      } else if (params.action === "save-comparison") {
        if (!(status.operations ?? []).includes("device.comparison.save-to-slot")) throw new Error("comparison save is unavailable");
        if (!isNonEmptyString(params.ref, 256)) return error(id, -32602, "ref is required");
        const row = this.deviceRow(snapshot, params.ref as LiveRef);
        const comparison = row.device.comparison as JsonObject | undefined;
        if (comparison?.capability !== true) return this.transactionError(id, "A/B comparison is unavailable on this exact device");
        payload = { action: params.action, ref: params.ref, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ canCompareAb: comparison.capability, isUsingComparePresetB: comparison.activeSide === 1 })).digest("hex") };
        impact = "momentary-no-undo";
      } else if (params.action === "insert-chain") {
        if (!(status.operations ?? []).includes("device.insert")) throw new Error("device insertion is unavailable");
        if (!isNonEmptyString(params.trackRef, 256) || !isNonEmptyString(params.chainRef, 256) || !isNonEmptyString(params.deviceName, 256)) return error(id, -32602, "trackRef, chainRef, and deviceName are required");
        const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.trackRef);
        if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is not authoritative");
        const found = this.chainRow(snapshot, params.chainRef as LiveRef);
        const siblings = ((found.chain.devices as unknown[]) ?? []).filter(isObject).map((device) => ({ ref: device.ref, objectIdentity: device.objectIdentity }));
        if (siblings.length > 0) return this.transactionError(id, "chain insertion requires an empty chain so cleanup cannot affect siblings");
        payload = { action: params.action, trackRef: params.trackRef, chainRef: params.chainRef, deviceName: params.deviceName, ...(params.index !== undefined ? { index: params.index } : {}), expectedTrackIdentity: track.objectIdentity, expectedSiblings: siblings };
        prior = { siblings };
        impact = "creates-chain-device-cleanup-guarded";
      } else {
        if (!(status.operations ?? []).includes("device.move")) throw new Error("device move is unavailable");
        if (!isNonEmptyString(params.ref, 256) || !Number.isInteger(params.index) || (params.index as number) < 0) return error(id, -32602, "ref and index are required");
        if ((params.targetTrackRef === undefined) === (params.targetChainRef === undefined)) return error(id, -32602, "exactly one of targetTrackRef or targetChainRef is required");
        const row = this.deviceRow(snapshot, params.ref as LiveRef);
        let target: JsonObject | undefined;
        if (params.targetTrackRef !== undefined) {
          if (!isNonEmptyString(params.targetTrackRef, 256)) return error(id, -32602, "targetTrackRef is invalid");
          target = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.targetTrackRef);
        } else {
          if (!isNonEmptyString(params.targetChainRef, 256)) return error(id, -32602, "targetChainRef is invalid");
          target = this.chainRow(snapshot, params.targetChainRef as LiveRef).chain;
        }
        if (!target || !isNonEmptyString(target.objectIdentity, 256)) throw new Error("move target identity is not authoritative");
        const targetDevices = ((target.devices as unknown[]) ?? []);
        if ((params.index as number) > targetDevices.length) return error(id, -32602, "index exceeds the exact target sibling collection");
        payload = { action: params.action, ref: params.ref, index: params.index, ...(params.targetTrackRef !== undefined ? { targetTrackRef: params.targetTrackRef } : { targetChainRef: params.targetChainRef }), expectedObjectIdentity: row.device.objectIdentity, expectedOwnerRef: row.ownerRef, expectedOwnerIdentity: row.ownerIdentity, expectedSiblings: row.siblings, expectedTrackRef: row.track.ref, expectedTrackIdentity: row.track.objectIdentity, expectedTargetIdentity: target.objectIdentity, priorOwnerRef: row.ownerRef, priorIndex: Math.max(0, row.siblings.findIndex((sibling) => sibling.ref === params.ref)) };
        prior = { ownerRef: row.ownerRef, index: Math.max(0, row.siblings.findIndex((sibling) => sibling.ref === params.ref)) };
        impact = "moves-device-cross-target";
      }
      const fence = JSON.stringify({ action: params.action, payload });
      const transaction: ClipLifecycleTransaction = { id: `devadv_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device-advanced", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device advanced");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, prior, impact, confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device-advanced preview requires fresh authoritative state."); }
  }

  private async liveDeviceAdvancedApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device-advanced" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired device-advanced transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const action = transaction.payload.action as string;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => !["action", "priorOwnerRef", "priorIndex"].includes(key)));
      if (action === "set-bank") {
        const result = await adapter.invokeAsync({ operation: "device.bank.set", args }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("device bank selection was not confirmed");
      } else if (action === "re-enable-automation") {
        const result = await adapter.invokeAsync({ operation: "parameter.re-enable-automation", args }, context) as { done?: unknown };
        if (result.done !== true) throw new Error("automation re-enable was not confirmed");
      } else if (action === "save-comparison") {
        const result = await adapter.invokeAsync({ operation: "device.comparison.save-to-slot", args }, context) as { done?: unknown };
        if (result.done !== true) throw new Error("comparison save was not confirmed");
      } else if (action === "insert-chain") {
        const result = await adapter.invokeAsync({ operation: "device.insert", args }, context) as Record<string, unknown>;
        if (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256)) throw new Error("chain insertion did not return exact identity");
        transaction.created = result;
      } else {
        const result = await adapter.invokeAsync({ operation: "device.move", args }, context) as Record<string, unknown>;
        if (result.index !== transaction.payload.index || !isNonEmptyString(result.objectIdentity, 256)) throw new Error("cross-target device move was not confirmed");
        transaction.created = result;
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result: transaction.created ?? { done: true }, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Device-advanced state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveChainPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["colorIndex", "autoColor", "mute", "solo"] as const;
    if (!isObject(params) || !hasOnly(params, ["chainRef", ...fields]) || !isNonEmptyString(params.chainRef, 256)) return error(id, -32602, "chainRef is required");
    const proposed: Record<string, unknown> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "colorIndex" && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 69)) return error(id, -32602, "colorIndex is invalid");
      if ((field === "autoColor" || field === "mute" || field === "solo") && typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one chain field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("chain.set")) throw new Error("chain editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const found = this.chainRow(snapshot, params.chainRef as LiveRef);
      const state = { colorIndex: found.chain.colorIndex ?? null, autoColor: found.chain.autoColor ?? null, mute: found.chain.mute ?? null, solo: found.chain.solo ?? null };
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = (state as Record<string, unknown>)[field];
      const payload: Record<string, unknown> = { ref: params.chainRef, ...proposed, expectedObjectIdentity: found.chain.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
      const fence = JSON.stringify({ ref: params.chainRef, objectIdentity: found.chain.objectIdentity, state });
      const transaction: ClipLifecycleTransaction = { id: `chainset_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "chain-set", fence, clipRef: params.chainRef as LiveRef, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "chain edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, chainRef: params.chainRef, prior, proposed, impact: "edits-chain", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Chain preview requires fresh authoritative state."); }
  }

  private async liveChainApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "chain-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired chain transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const found = this.chainRow(snapshot, transaction.clipRef!);
        const state = { colorIndex: found.chain.colorIndex ?? null, autoColor: found.chain.autoColor ?? null, mute: found.chain.mute ?? null, solo: found.chain.solo ?? null };
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: found.chain.objectIdentity, state }) !== transaction.fence) return this.transactionError(id, "chain identity or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "chain.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("chain change was not confirmed");
      const verified = this.chainRow(await adapter.snapshotAsync(context), transaction.clipRef!).chain;
      for (const field of ["colorIndex", "autoColor", "mute", "solo"]) if (transaction.payload[field] !== undefined && verified[field] !== transaction.payload[field]) throw new Error("chain postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Chain state is uncertain; perform fresh discovery before retrying."); }
  }

  private drumPadRow(snapshot: LiveSnapshot, padRef: LiveRef): JsonObject {
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      for (const device of ((track.devices as unknown[]) ?? []).filter(isObject)) {
        const pad = ((device.drumPads as unknown[]) ?? []).filter(isObject).find((candidate) => candidate.ref === padRef);
        if (pad) {
          if (!isNonEmptyString(pad.objectIdentity, 256)) throw new Error("drum pad identity is unavailable");
          return pad;
        }
      }
    }
    throw new Error("drum pad reference is not authoritative");
  }

  private rackStateRevision(device: JsonObject): string {
    return createHash("sha256").update(canonicalMutationIdentity({ visibleMacroCount: device.visibleMacroCount ?? null, selectedVariationIndex: device.selectedVariationIndex ?? null, variationCount: device.variationCount ?? null, macros: ((device.macros as unknown[]) ?? []).filter(isObject).map((macro) => macro.objectIdentity), chains: ((device.chains as unknown[]) ?? []).filter(isObject).map((chain) => chain.objectIdentity), drumPads: ((device.drumPads as unknown[]) ?? []).filter(isObject).map((pad) => pad.objectIdentity) })).digest("hex");
  }

  private async liveDrumPadPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["action", "padRef", "note", "solo"]) || !isNonEmptyString(params.padRef, 256)) return error(id, -32602, "action and padRef are required");
    if (params.action !== "set" && params.action !== "delete-all-chains") return error(id, -32602, "action must be set or delete-all-chains");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const pad = this.drumPadRow(snapshot, params.padRef as LiveRef);
      let payload: Record<string, unknown>;
      let prior: Record<string, unknown> = {};
      if (params.action === "set") {
        if (!(status.operations ?? []).includes("drum-pad.set")) throw new Error("drum pad editing is unavailable");
        const proposed: Record<string, unknown> = {};
        if (params.note !== undefined) return error(id, -32602, "DrumPad.note is read-only in the public LOM and cannot be assigned");
        if (params.solo !== undefined) { if (typeof params.solo !== "boolean") return error(id, -32602, "solo must be boolean"); proposed.solo = params.solo; }
        if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one pad field is required");
        const state = { note: pad.note ?? null, solo: pad.solo ?? null };
        prior = { ...state };
        payload = { action: params.action, ref: params.padRef, ...proposed, expectedObjectIdentity: pad.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
      } else {
        if (!(status.operations ?? []).includes("drum-pad.delete-all-chains")) throw new Error("delete-all-chains is unavailable");
        const chains = ((pad.chains as unknown[]) ?? []).filter(isObject).map((chain) => chain.objectIdentity);
        prior = { chainCount: chains.length };
        payload = { action: params.action, ref: params.padRef, expectedObjectIdentity: pad.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(chains)).digest("hex") };
      }
      const fence = JSON.stringify({ action: params.action, ref: params.padRef, objectIdentity: pad.objectIdentity, payload });
      const transaction: ClipLifecycleTransaction = { id: `drumpad_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "drum-pad", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "drum pad");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, padRef: params.padRef, prior, impact: params.action === "set" ? "edits-drum-pad" : "deletes-all-pad-chains-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Drum-pad preview requires fresh authoritative state."); }
  }

  private async liveDrumPadApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "drum-pad" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired drum-pad transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const action = transaction.payload.action as string;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
      if (action === "set") {
        const result = await adapter.invokeAsync({ operation: "drum-pad.set", args }, context) as { changed?: unknown; revision?: unknown };
        if (result.changed !== true) throw new Error("drum pad change was not confirmed");
        const verified = this.drumPadRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef);
        if (transaction.payload.solo !== undefined && verified.solo !== transaction.payload.solo) throw new Error("drum pad postcondition was not confirmed");
      } else {
        const result = await adapter.invokeAsync({ operation: "drum-pad.delete-all-chains", args }, context) as { deleted?: unknown };
        if (result.deleted !== (transaction.prior as { chainCount: number }).chainCount) throw new Error("delete-all-chains count was not confirmed");
        const verified = this.drumPadRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef);
        if (((verified.chains as unknown[]) ?? []).length !== 0) throw new Error("delete-all-chains postcondition was not confirmed");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Drum-pad state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveRackPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["set", "add-macro", "remove-macro", "randomize-macros", "insert-chain", "copy-pad", "store-variation", "recall-variation", "delete-variation"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "rackRef", "selectedVariationIndex", "index", "sourceIndex", "targetIndex"]) || !actions.includes(params.action as typeof actions[number]) || !isNonEmptyString(params.rackRef, 256)) return error(id, -32602, "action and rackRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.rackRef as LiveRef);
      if (row.device.canHaveChains !== true) return this.transactionError(id, "rack operations require a rack device");
      const stateRevision = this.rackStateRevision(row.device);
      let payload: Record<string, unknown>;
      let prior: Record<string, unknown> = {};
      if (params.action === "set") {
        if (!(status.operations ?? []).includes("rack.set")) throw new Error("rack editing is unavailable");
        const proposed: Record<string, unknown> = {};
        if (params.visibleMacroCount !== undefined) return error(id, -32602, "visibleMacroCount is read-only in the public LOM; use add-macro/remove-macro actions to change it");
        if (params.selectedVariationIndex !== undefined) { if (!Number.isInteger(params.selectedVariationIndex) || (params.selectedVariationIndex as number) < -1 || (params.selectedVariationIndex as number) > 256) return error(id, -32602, "selectedVariationIndex is invalid"); proposed.selectedVariationIndex = params.selectedVariationIndex; }
        if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one rack field is required");
        prior = { selectedVariationIndex: row.device.selectedVariationIndex ?? null };
        payload = { action: params.action, ref: params.rackRef, ...proposed, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: stateRevision };
      } else {
        if (!(status.operations ?? []).includes("rack.action")) throw new Error("rack actions are unavailable");
        if (["remove-macro", "recall-variation", "delete-variation"].includes(params.action as string) && params.index !== undefined) return error(id, -32602, "remove-macro, recall-variation, and delete-variation take no index in the public LOM");
        if (params.action === "copy-pad" && (!Number.isInteger(params.sourceIndex) || !Number.isInteger(params.targetIndex) || (params.sourceIndex as number) < 0 || (params.targetIndex as number) < 0)) return error(id, -32602, "sourceIndex and targetIndex are required");
        payload = { action: params.action, ref: params.rackRef, ...(params.index !== undefined ? { index: params.index } : {}), ...(params.sourceIndex !== undefined ? { sourceIndex: params.sourceIndex } : {}), ...(params.targetIndex !== undefined ? { targetIndex: params.targetIndex } : {}), expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: stateRevision };
      }
      const fence = JSON.stringify({ action: params.action, ref: params.rackRef, objectIdentity: row.device.objectIdentity, stateRevision });
      const transaction: ClipLifecycleTransaction = { id: `rack_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "rack", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "rack");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, rackRef: params.rackRef, prior, impact: params.action === "set" ? "edits-rack" : "momentary-rack-action-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Rack preview requires fresh authoritative state."); }
  }

  private async liveRackApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "rack" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired rack transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        if (JSON.stringify({ action: transaction.payload.action, ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, stateRevision: this.rackStateRevision(row.device) }) !== transaction.fence) return this.transactionError(id, "rack identity or state changed since preview; preview again"); }
      const action = transaction.payload.action as string;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = action === "set" ? Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action")) : Object.fromEntries(Object.entries(transaction.payload));
      let result: { changed?: unknown; done?: unknown; revision?: unknown };
      if (action === "set") {
        result = await adapter.invokeAsync({ operation: "rack.set", args }, context) as { changed?: unknown; revision?: unknown };
        if (result.changed !== true) throw new Error("rack change was not confirmed");
        const verified = this.deviceRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef).device;
        if (transaction.payload.selectedVariationIndex !== undefined && verified.selectedVariationIndex !== transaction.payload.selectedVariationIndex) throw new Error("rack postcondition was not confirmed");
      } else {
        result = await adapter.invokeAsync({ operation: "rack.action", args }, context) as { done?: unknown; revision?: unknown };
        if (result.done !== true) throw new Error("rack action was not confirmed");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Rack state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveRackViewPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["selectedChainRef", "selectedPadIndex", "padScrollPosition", "showChainDevices"] as const;
    if (!isObject(params) || !hasOnly(params, ["rackRef", ...fields]) || !isNonEmptyString(params.rackRef, 256)) return error(id, -32602, "rackRef is required");
    if (fields.every((field) => params[field] === undefined)) return error(id, -32602, "at least one rack view field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("rack.view.set")) throw new Error("rack view editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.rackRef as LiveRef);
      if (row.device.canHaveChains !== true) return this.transactionError(id, "rack view requires a rack device");
      const view = row.device.rackView as JsonObject | undefined;
      const state = { padScrollPosition: view?.padScrollPosition ?? null, showChainDevices: view?.showChainDevices ?? null };
      const proposed: Record<string, unknown> = {};
      if (params.selectedChainRef !== undefined) { if (params.selectedChainRef !== null && !isNonEmptyString(params.selectedChainRef, 256)) return error(id, -32602, "selectedChainRef is invalid"); if (params.selectedChainRef !== null) this.chainRow(snapshot, params.selectedChainRef as LiveRef); proposed.selectedChainRef = params.selectedChainRef; }
      if (params.selectedPadIndex !== undefined) { if (!Number.isInteger(params.selectedPadIndex) || (params.selectedPadIndex as number) < -1 || (params.selectedPadIndex as number) > 127) return error(id, -32602, "selectedPadIndex is invalid"); proposed.selectedPadIndex = params.selectedPadIndex; }
      if (params.padScrollPosition !== undefined) { if (!Number.isInteger(params.padScrollPosition) || (params.padScrollPosition as number) < 0 || (params.padScrollPosition as number) > 127) return error(id, -32602, "padScrollPosition is invalid"); proposed.padScrollPosition = params.padScrollPosition; }
      if (params.showChainDevices !== undefined) { if (typeof params.showChainDevices !== "boolean") return error(id, -32602, "showChainDevices must be boolean"); proposed.showChainDevices = params.showChainDevices; }
      const prior: Record<string, unknown> = { selectedChainRef: view?.selectedChainRef ?? null, selectedPadIndex: view?.selectedPadIndex ?? null, padScrollPosition: state.padScrollPosition, showChainDevices: state.showChainDevices };
      const payload: Record<string, unknown> = { ref: params.rackRef, ...proposed, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
      const fence = JSON.stringify({ ref: params.rackRef, objectIdentity: row.device.objectIdentity, state });
      const transaction: ClipLifecycleTransaction = { id: `rackview_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "rack-view", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "rack view");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, rackRef: params.rackRef, prior, proposed, impact: "edits-rack-view", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Rack-view preview requires fresh authoritative state."); }
  }

  private async liveRackViewApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "rack-view" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired rack-view transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        const view = row.device.rackView as JsonObject | undefined;
        const state = { padScrollPosition: view?.padScrollPosition ?? null, showChainDevices: view?.showChainDevices ?? null };
        if (JSON.stringify({ ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, state }) !== transaction.fence) return this.transactionError(id, "rack identity or view state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "rack.view.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("rack view change was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Rack-view state is uncertain; perform fresh discovery before retrying."); }
  }

  private static readonly SPECIALIZED_FAMILY_FIELDS: Record<string, string[]> = {
    drift: ["pitchBendRange", "voiceCount", "voiceMode"],
    "drum-cell": ["gain"],
    eq8: ["editMode", "globalMode", "oversample", "selectedBand"],
    "hybrid-reverb": ["irCategory", "irFile", "attack", "decay", "size"],
    meld: ["engine", "unison", "monoPoly", "polyphony"],
    plugin: ["presetIndex", "isEditorOpen"],
  };

  private static readonly SPECIALIZED_FIELD_BOUNDS: Record<string, [number, number, boolean]> = {
    pitchBendRange: [1, 96, true], voiceCount: [1, 64, true], voiceMode: [0, 8, true],
    gain: [-70, 24, false],
    editMode: [0, 4, true], globalMode: [0, 4, true], selectedBand: [0, 8, true],
    attack: [0, 10000, false], decay: [0, 100000, false], size: [0, 10000, false], time: [0, 100000, false],
    engine: [0, 4, true], unison: [1, 16, true], polyphony: [1, 64, true], presetIndex: [0, 1024, true],
  };

  private static specializedRowKey(family: string): string {
    return { drift: "drift", "drum-cell": "drumCell", eq8: "eq8", "hybrid-reverb": "hybridReverb", meld: "meld", plugin: "plugin", max: "maxDevice", looper: "looper" }[family] ?? family;
  }

  private async liveDeviceSpecializedPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const families = Object.keys(McpHost.SPECIALIZED_FAMILY_FIELDS);
    if (!isObject(params) || !families.includes(params.family as string) || !isNonEmptyString(params.deviceRef, 256)) return error(id, -32602, "family and deviceRef are required");
    const fields = McpHost.SPECIALIZED_FAMILY_FIELDS[params.family as string]!;
    if (!hasOnly(params, ["family", "deviceRef", ...fields])) return error(id, -32602, `only ${params.family} fields are accepted`);
    if (fields.every((field) => params[field] === undefined)) return error(id, -32602, "at least one field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = `${params.family}.set`;
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable on this Live shape`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.deviceRef as LiveRef);
      const proposed: Record<string, unknown> = {};
      for (const field of fields) {
        const value = params[field];
        if (value === undefined) continue;
        if (["oversample", "monoPoly", "isEditorOpen"].includes(field) && typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`);
        if (["irCategory", "irFile"].includes(field) && !isNonEmptyString(value, 256)) return error(id, -32602, `${field} is invalid`);
        if (!["oversample", "monoPoly", "isEditorOpen", "irCategory", "irFile"].includes(field) && typeof value !== "number") return error(id, -32602, `${field} must be a number`);
        const bounds = McpHost.SPECIALIZED_FIELD_BOUNDS[field];
        if (bounds && typeof value === "number" && (value < bounds[0] || value > bounds[1] || (bounds[2] && !Number.isInteger(value)))) return error(id, -32602, `${field} is out of bounds`);
        proposed[field] = value;
      }
      const familyRow = ((row.device as unknown as Record<string, unknown>)[McpHost.specializedRowKey(params.family as string)] ?? {}) as Record<string, unknown>;
      const state = Object.fromEntries(fields.map((field) => [field, familyRow[field] ?? null]));
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = familyRow[field] ?? null;
      const payload: Record<string, unknown> = { family: params.family, ref: params.deviceRef, ...proposed, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
      const fence = JSON.stringify({ family: params.family, ref: params.deviceRef, objectIdentity: row.device.objectIdentity, state });
      const transaction: ClipLifecycleTransaction = { id: `devspec_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device-specialized", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "specialized device");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, family: params.family, deviceRef: params.deviceRef, prior, proposed, impact: `edits-${params.family}`, confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Specialized-device preview requires fresh authoritative state."); }
  }

  private async liveDeviceSpecializedApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device-specialized" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired specialized-device transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const family = transaction.payload.family as string;
      const fields = McpHost.SPECIALIZED_FAMILY_FIELDS[family]!;
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        const familyRow = ((row.device as unknown as Record<string, unknown>)[McpHost.specializedRowKey(family)] ?? {}) as Record<string, unknown>;
        const state = Object.fromEntries(fields.map((field) => [field, familyRow[field] ?? null]));
        if (JSON.stringify({ family, ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, state }) !== transaction.fence) return this.transactionError(id, "device identity or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "family"));
      const result = await adapter.invokeAsync({ operation: `${family}.set` as "drift.set" | "drum-cell.set" | "eq8.set" | "hybrid-reverb.set" | "meld.set" | "plugin.set", args }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("specialized device change was not confirmed");
      const verifiedDevice = this.deviceRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef).device as unknown as Record<string, unknown>;
      const verified = ((verifiedDevice[McpHost.specializedRowKey(family)] ?? {}) as Record<string, unknown>);
      for (const field of fields) if (transaction.payload[field] !== undefined && JSON.stringify(verified[field]) !== JSON.stringify(transaction.payload[field])) throw new Error("specialized device postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Specialized-device state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveLooperPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["set", "record", "overdub", "play", "stop", "clear", "undo", "double-speed", "half-speed", "export"] as const;
    const fields = ["overdubAfterRecord", "recordLengthIndex"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "deviceRef", "slotRef", ...fields]) || !actions.includes(params.action as typeof actions[number]) || !isNonEmptyString(params.deviceRef, 256)) return error(id, -32602, "action and deviceRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.deviceRef as LiveRef);
      const looperRow = (((row.device as unknown as Record<string, unknown>).looper) ?? {}) as Record<string, unknown>;
      let payload: Record<string, unknown>;
      let prior: Record<string, unknown> = {};
      const writableState = () => ({ overdubAfterRecord: looperRow.overdubAfterRecord ?? null, recordLengthIndex: looperRow.recordLengthIndex ?? null });
      const fullState = () => ({ ...writableState(), loopLength: looperRow.loopLength ?? null, tempo: looperRow.tempo ?? null, state: looperRow.state ?? null });
      if (params.action === "set") {
        if (!(status.operations ?? []).includes("looper.set")) throw new Error("looper properties are unavailable");
        const proposed: Record<string, unknown> = {};
        if (params.overdubAfterRecord !== undefined) { if (typeof params.overdubAfterRecord !== "boolean") return error(id, -32602, "overdubAfterRecord must be boolean"); proposed.overdubAfterRecord = params.overdubAfterRecord; }
        if (params.recordLengthIndex !== undefined) { if (!Number.isInteger(params.recordLengthIndex) || (params.recordLengthIndex as number) < 0 || (params.recordLengthIndex as number) > 8) return error(id, -32602, "recordLengthIndex is out of bounds"); proposed.recordLengthIndex = params.recordLengthIndex; }
        if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one looper field is required (loopLength and tempo are read-only; speed changes are double-speed/half-speed actions)");
        for (const field of Object.keys(proposed)) prior[field] = looperRow[field] ?? null;
        payload = { action: params.action, ref: params.deviceRef, ...proposed, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(writableState())).digest("hex") };
      } else {
        if (!(status.operations ?? []).includes("looper.action")) throw new Error("looper actions are unavailable");
        if (params.action === "export") {
          if (!isNonEmptyString(params.slotRef, 256)) return error(id, -32602, "export requires an exact empty target clip slot (slotRef)");
          const slot = snapshot.tracks.flatMap((track) => track.clipSlots ?? []).find((candidate) => candidate.ref === params.slotRef);
          if (!slot) throw new Error("export target clip slot is not authoritative");
          if (slot.clipRef !== null && slot.clipRef !== undefined) return error(id, -32602, "export target clip slot is not empty");
        } else if (params.slotRef !== undefined) return error(id, -32602, "slotRef is only valid for the export action");
        payload = { action: params.action, ref: params.deviceRef, ...(params.slotRef !== undefined ? { slotRef: params.slotRef } : {}), expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(fullState())).digest("hex") };
      }
      const fence = JSON.stringify({ action: params.action, ref: params.deviceRef, objectIdentity: row.device.objectIdentity, payload });
      const transaction: ClipLifecycleTransaction = { id: `looper_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "looper", fence, payload, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "looper");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, deviceRef: params.deviceRef, prior, impact: params.action === "set" ? "edits-looper" : params.action === "export" ? "exports-audio-to-exact-clip-slot-no-undo" : "momentary-looper-action-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Looper preview requires fresh authoritative state."); }
  }

  private async liveLooperApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "looper" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired looper transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const action = transaction.payload.action as string;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      if (action === "set") {
        const args = Object.fromEntries(Object.entries(transaction.payload).filter(([key]) => key !== "action"));
        const result = await adapter.invokeAsync({ operation: "looper.set", args }, context) as { changed?: unknown; revision?: unknown };
        if (result.changed !== true) throw new Error("looper change was not confirmed");
        const verifiedDevice = this.deviceRow(await adapter.snapshotAsync(context), transaction.payload.ref as LiveRef).device as unknown as Record<string, unknown>;
        const verified = ((verifiedDevice.looper ?? {}) as Record<string, unknown>);
        for (const field of ["overdubAfterRecord", "recordLengthIndex"]) if (transaction.payload[field] !== undefined && verified[field] !== transaction.payload[field]) throw new Error("looper postcondition was not confirmed");
      } else {
        const result = await adapter.invokeAsync({ operation: "looper.action", args: transaction.payload }, context) as { done?: unknown; revision?: unknown };
        if (result.done !== true) throw new Error("looper action was not confirmed");
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Looper state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveSimplerPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["deviceRef", "filePath", "allowedRoot"]) || !isNonEmptyString(params.deviceRef, 256)) return error(id, -32602, "deviceRef, filePath, and allowedRoot are required");
    try {
      const authority = await this.audioImportFileAuthority(params.filePath, params.allowedRoot);
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("simpler.replace-sample")) throw new Error("sample replacement is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.deviceRow(snapshot, params.deviceRef as LiveRef);
      const currentPath = ((row.device as unknown as { samplePath?: string }).samplePath) ?? "";
      const stagingPath = await this.stageVerifiedImportFile(authority.canonicalPath, authority);
      try {
      const payload: Record<string, unknown> = { ref: params.deviceRef, filePath: stagingPath, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ filePath: currentPath })).digest("hex") };
      const fence = JSON.stringify({ ref: params.deviceRef, objectIdentity: row.device.objectIdentity, filePath: currentPath });
      const transaction: ClipLifecycleTransaction = { id: `simpler_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "simpler", fence, payload, prior: { file: authority, samplePath: currentPath }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "simpler");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, deviceRef: params.deviceRef, currentSample: currentPath, file: { path: authority.canonicalPath, size: authority.size, sha256: authority.sha256 }, impact: "replaces-simpler-sample", confirmation: "apply", expiresAt: transaction.expiresAt });
      } catch (stagingCause) { this.releaseStagedImportFile(stagingPath); throw stagingCause; }
    } catch (cause) { return this.adapterToolError(id, cause, "Simpler preview requires fresh authoritative state and a readable file."); }
  }

  private async liveSimplerApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "simpler" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "Unknown or expired simpler transaction"); }
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "Live connection epoch changed; preview again"); }
      const prior = transaction.prior as { file?: { canonicalPath: string; size: number; mtimeMs: number; sha256: string }; samplePath: string };
      if (!prior.file) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "simpler file authority is missing; preview again"); }
      if (!existsSync(transaction.payload.filePath as string)) return this.transactionError(id, "staged import file is no longer available; preview again");
      // The bytes Live opens are the transaction-owned staged copy verified at
      // preview; the source path is never re-trusted after staging.
      await this.verifyStagedImportFile(transaction.payload.filePath as string, prior.file);
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        const currentPath = ((row.device as unknown as { samplePath?: string }).samplePath) ?? "";
        if (JSON.stringify({ ref: transaction.payload.ref, objectIdentity: row.device.objectIdentity, filePath: currentPath }) !== transaction.fence) { this.releaseStagedImportFor(transaction); return this.transactionError(id, "device identity or sample state changed since preview; preview again"); } }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "simpler.replace-sample", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown; filePath?: unknown };
      if (result.changed !== true) throw new Error("sample replacement was not confirmed");
      transaction.created = { samplePath: result.filePath ?? transaction.payload.filePath };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      // The staged copy is now the Simpler's sample media: Live references the
      // path in place from the managed staging directory. It is released only
      // by undo (which restores the original sample) — never on apply success.
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Simpler state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveObserveSubscribeAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const kinds = ["transport", "selection", "track", "clip", "device", "parameter", "groove", "tuning", "scene", "meters", "rack"];
    if (!isObject(params) || !hasOnly(params, ["topics", "minIntervalMs"])) return error(id, -32602, "topics is required");
    if (!Array.isArray(params.topics) || params.topics.length < 1 || params.topics.length > 64) return error(id, -32602, "topics must be 1-64 entries");
    for (const topic of params.topics) {
      if (!isObject(topic) || !hasOnly(topic, ["kind", "ref"]) || !kinds.includes(topic.kind as string)) return error(id, -32602, "observe topic is invalid");
      if (topic.ref !== undefined && !isNonEmptyString(topic.ref, 256)) return error(id, -32602, "observe topic ref is invalid");
    }
    if (params.minIntervalMs !== undefined && (!Number.isInteger(params.minIntervalMs) || (params.minIntervalMs as number) < 100 || (params.minIntervalMs as number) > 60000)) return error(id, -32602, "minIntervalMs is invalid");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("observe.subscribe")) throw new Error("observer subscriptions are unavailable");
      const adapter = this.asyncAdapter();
      const args: Record<string, unknown> = { topics: params.topics };
      if (params.minIntervalMs !== undefined) args.minIntervalMs = params.minIntervalMs;
      return this.successText(id, await adapter.invokeAsync({ operation: "observe.subscribe", args }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }));
    } catch (cause) { return this.adapterToolError(id, cause, "Observer subscription requires a fresh connection."); }
  }

  private async liveObservePollAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["subscriptionId"]) || !isNonEmptyString(params.subscriptionId, 128)) return error(id, -32602, "subscriptionId is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("observe.poll")) throw new Error("observer polling is unavailable");
      return this.successText(id, await this.asyncAdapter().invokeAsync({ operation: "observe.poll", args: { subscriptionId: params.subscriptionId } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }));
    } catch (cause) { return this.adapterToolError(id, cause, "Observer poll requires a fresh connection."); }
  }

  private async liveObserveUnsubscribeAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["subscriptionId"]) || !isNonEmptyString(params.subscriptionId, 128)) return error(id, -32602, "subscriptionId is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("observe.unsubscribe")) throw new Error("observer unsubscribe is unavailable");
      return this.successText(id, await this.asyncAdapter().invokeAsync({ operation: "observe.unsubscribe", args: { subscriptionId: params.subscriptionId } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }));
    } catch (cause) { return this.adapterToolError(id, cause, "Observer unsubscribe requires a fresh connection."); }
  }

  private async liveBrowserRootsAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (params !== undefined && (!isObject(params) || Object.keys(params).length > 0)) return error(id, -32602, "no arguments are accepted");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("browser.roots")) throw new Error("browser roots are unavailable");
      return this.successText(id, await this.asyncAdapter().invokeAsync({ operation: "browser.roots", args: {} }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }));
    } catch (cause) { return this.adapterToolError(id, cause, "Browser roots requires a fresh connection."); }
  }

  private parameterRow(snapshot: LiveSnapshot, parameterRef: LiveRef): JsonObject {
    const walk = (devices: JsonObject[]): JsonObject | undefined => {
      for (const device of devices) {
        // Rack macros are first-class addressable parameters (kind "rack-macro"), mirroring the realtime target resolver.
        const rows = [...((device.parameters as unknown[]) ?? []), ...((device.macros as unknown[]) ?? [])].filter(isObject);
        const found = rows.find((parameter) => parameter.ref === parameterRef);
        if (found) return found;
        for (const chain of ((device.chains as unknown[]) ?? []).filter(isObject)) { const nested = walk(((chain.devices as unknown[]) ?? []).filter(isObject)); if (nested) return nested; }
        for (const pad of ((device.drumPads as unknown[]) ?? []).filter(isObject)) { for (const chain of ((pad.chains as unknown[]) ?? []).filter(isObject)) { const nested = walk(((chain.devices as unknown[]) ?? []).filter(isObject)); if (nested) return nested; } }
      }
      return undefined;
    };
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      const found = walk(((track.devices as unknown[]) ?? []).filter(isObject));
      if (found) return found;
    }
    throw new Error("parameter reference is not authoritative");
  }

  private automationAuthorityDigest(snapshot: LiveSnapshot, clipRef: LiveRef, parameterRef: LiveRef): string {
    return createHash("sha256").update(canonicalMutationIdentity({ clip: this.clipAuthority(snapshot, clipRef), parameter: this.parameterAuthority(snapshot, parameterRef) })).digest("hex");
  }

  private async liveAutomationPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["create-envelope", "delete-envelope", "insert", "delete-range", "clear-envelopes"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "clipRef", "parameterRef", "points", "from", "to"]) || !actions.includes(params.action as typeof actions[number]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "action and clipRef are required");
    if (params.action === "clear-envelopes" ? params.parameterRef !== undefined : !isNonEmptyString(params.parameterRef, 256)) return error(id, -32602, params.action === "clear-envelopes" ? "clear-envelopes takes no parameterRef" : "parameterRef is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const adapter = this.asyncAdapter();
      if (params.action === "clear-envelopes") {
        if (!(status.operations ?? []).includes("automation.envelope.clear")) throw new Error("automation.envelope.clear is unavailable");
        const snapshot = await adapter.snapshotAsync();
        const authorityDigest = this.clipAuthorityDigest(snapshot, params.clipRef as LiveRef);
        const presence = this.envelopePresenceRevision(snapshot, params.clipRef as LiveRef);
        const fence = JSON.stringify({ clipRef: params.clipRef, presence: presence.revision, authorityDigest });
        const payload: Record<string, unknown> = { action: params.action, clipRef: params.clipRef, expectedAuthorityDigest: authorityDigest, expectedEnvelopesRevision: presence.revision };
        const transaction: ClipLifecycleTransaction = { id: `automation_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "automation", fence, clipRef: params.clipRef as LiveRef, payload, prior: { cleared: presence.cleared, reversible: false }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
        this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "automation");
        return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, clipRef: params.clipRef, envelopes: presence.cleared, impact: "clears-all-clip-envelopes-not-undoable", confirmation: "apply", expiresAt: transaction.expiresAt });
      }
      const operation = params.action === "insert" ? "automation.point.insert" : params.action === "delete-range" ? "automation.point.delete" : params.action === "create-envelope" ? "automation.envelope.create" : "automation.envelope.delete";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const before = await adapter.snapshotAsync(context); const authorityDigest = this.automationAuthorityDigest(before, params.clipRef as LiveRef, params.parameterRef as LiveRef);
      const read = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: params.clipRef, parameterRef: params.parameterRef } }, context) as { available?: unknown; exists?: unknown; points?: unknown; revision?: unknown };
      if (read.available !== true || !isNonEmptyString(read.revision, 64)) throw new Error("clip envelope revision is unavailable");
      if (this.automationAuthorityDigest(await adapter.snapshotAsync(context), params.clipRef as LiveRef, params.parameterRef as LiveRef) !== authorityDigest) throw new Error("automation target identity changed during preview");
      const points = Array.isArray(read.points) ? read.points : [];
      const fence = JSON.stringify({ clipRef: params.clipRef, parameterRef: params.parameterRef, exists: read.exists, points, revision: read.revision, authorityDigest });
      const payload: Record<string, unknown> = { clipRef: params.clipRef, parameterRef: params.parameterRef, expectedAuthorityDigest: authorityDigest, expectedEnvelopeRevision: read.revision };
      if (params.action === "insert") {
        if (!Array.isArray(params.points) || params.points.length < 1 || params.points.length > 512) return error(id, -32602, "points must be 1-512 point objects");
        for (const point of params.points) if (!isObject(point) || !hasOnly(point, ["time", "value"]) || typeof point.time !== "number" || !Number.isFinite(point.time) || point.time < 0 || typeof point.value !== "number" || !Number.isFinite(point.value)) return error(id, -32602, "points are invalid");
        payload.points = structuredClone(params.points);
      }
      if (params.action === "delete-range") {
        if (typeof params.from !== "number" || !Number.isFinite(params.from) || params.from < 0 || typeof params.to !== "number" || !Number.isFinite(params.to) || params.to <= params.from) return error(id, -32602, "from/to are invalid");
        payload.from = params.from; payload.to = params.to;
      }
      if (params.action === "delete-envelope" && read.exists !== true) return this.transactionError(id, "envelope does not exist");
      const transaction: ClipLifecycleTransaction = { id: `automation_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "automation", fence, clipRef: params.clipRef as LiveRef, payload: { action: params.action, ...payload }, prior: { exists: read.exists, points: structuredClone(points) }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "automation");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, clipRef: params.clipRef, parameterRef: params.parameterRef, current: { exists: read.exists, points }, impact: "edits-clip-automation", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Automation preview requires fresh authoritative state."); }
  }

  private async liveAutomationApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "automation" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired automation transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const action = transaction.payload.action as string;
      if (action === "clear-envelopes") {
        if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const authorityDigest = this.clipAuthorityDigest(snapshot, transaction.payload.clipRef as LiveRef); const presence = this.envelopePresenceRevision(snapshot, transaction.payload.clipRef as LiveRef);
          if (JSON.stringify({ clipRef: transaction.payload.clipRef, presence: presence.revision, authorityDigest }) !== transaction.fence) return this.transactionError(id, "envelope collection or clip hierarchy changed since preview; preview again"); }
        transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
        const cleared = await adapter.invokeAsync({ operation: "automation.envelope.clear", args: { clipRef: transaction.payload.clipRef, expectedAuthorityDigest: transaction.payload.expectedAuthorityDigest, expectedEnvelopesRevision: transaction.payload.expectedEnvelopesRevision } }, context) as { cleared?: unknown; envelopesRevision?: unknown };
        const after = this.envelopePresenceRevision(await adapter.snapshotAsync(context), transaction.payload.clipRef as LiveRef);
        if (cleared.cleared !== (transaction.prior as { cleared: number }).cleared || after.cleared !== 0 || cleared.envelopesRevision !== after.revision) throw new Error("envelope clear postcondition was not confirmed");
        transaction.applyKey = params.idempotencyKey as string;
        transaction.state = "applied";
        return this.successText(id, { transactionId: transaction.id, state: "applied", cleared: cleared.cleared, idempotent: false });
      }
      let read: { exists?: unknown; points?: unknown; revision?: unknown } = { revision: transaction.payload.expectedEnvelopeRevision }; let authorityDigest = transaction.payload.expectedAuthorityDigest as string;
      if (!reconciliation) { read = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef } }, context) as typeof read;
        authorityDigest = this.automationAuthorityDigest(await adapter.snapshotAsync(context), transaction.payload.clipRef as LiveRef, transaction.payload.parameterRef as LiveRef);
        if (JSON.stringify({ clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef, exists: read.exists, points: read.points ?? [], revision: read.revision, authorityDigest }) !== transaction.fence) return this.transactionError(id, "envelope or target identity changed since preview; preview again"); }
      const operation = action === "insert" ? "automation.point.insert" : action === "delete-range" ? "automation.point.delete" : action === "create-envelope" ? "automation.envelope.create" : "automation.envelope.delete";
      const args: Record<string, unknown> = { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef, expectedAuthorityDigest: transaction.payload.expectedAuthorityDigest, expectedEnvelopeRevision: transaction.payload.expectedEnvelopeRevision };
      if (action === "insert") args.points = transaction.payload.points;
      if (action === "delete-range") { args.from = transaction.payload.from; args.to = transaction.payload.to; }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      const after = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef } }, context) as { exists?: unknown; points?: unknown; revision?: unknown };
      if (!isNonEmptyString(after.revision, 64) || after.revision === read.revision) throw new Error("automation mutation did not change the exact envelope revision");
      transaction.created = { exists: after.exists, points: structuredClone(after.points), revision: after.revision, authorityDigest };
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Automation state is uncertain; perform fresh discovery before retrying."); }
  }

  private clipRow(snapshot: LiveSnapshot, clipRef: LiveRef): { track?: JsonObject; clip: JsonObject; arrangement: boolean; takeLane?: JsonObject } {
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      const clip = (track.clips as unknown[]).filter(isObject).find((item) => item.ref === clipRef);
      if (clip) return { track, clip, arrangement: false };
      for (const lane of ((track.takeLanes as unknown[]) ?? []).filter(isObject)) {
        const laneClip = ((lane.clips as unknown[]) ?? []).filter(isObject).find((item) => item.ref === clipRef);
        if (laneClip) return { track, clip: laneClip, arrangement: true, takeLane: lane };
      }
    }
    const arrangementClips = (snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? [];
    const arrangement = arrangementClips.filter(isObject).find((item) => item.ref === clipRef);
    if (arrangement) { const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === arrangement.trackRef); return { ...(track ? { track } : {}), clip: arrangement, arrangement: true }; }
    throw new Error("clip reference is not authoritative");
  }

  private arrangementCollectionRevision(snapshot: LiveSnapshot, trackRef: LiveRef): string {
    const clips = ((snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? []).filter(isObject).filter((item) => item.trackRef === trackRef).map((item) => ({ ref: item.ref, objectIdentity: item.objectIdentity }));
    if (clips.some((item) => !isNonEmptyString(item.ref, 256) || !isNonEmptyString(item.objectIdentity, 256)) || clips.length > 256) throw new Error("Arrangement clip collection authority is incomplete");
    return createHash("sha256").update(canonicalMutationIdentity(clips)).digest("hex");
  }

  private arrangementClipAuthority(snapshot: LiveSnapshot, clipRef: LiveRef): JsonObject {
    const located = this.clipRow(snapshot, clipRef); if (!located.arrangement || !located.track || !isNonEmptyString(located.clip.objectIdentity, 256) || !isNonEmptyString(located.track.ref, 256) || !isNonEmptyString(located.track.objectIdentity, 256)) throw new Error("Arrangement clip hierarchy authority is incomplete");
    const siblings = ((snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? []).filter(isObject).filter((item) => item.trackRef === located.track!.ref).map((item) => ({ ref: item.ref, objectIdentity: item.objectIdentity }));
    const authority = { clip: { ref: clipRef, objectIdentity: located.clip.objectIdentity }, owner: { ref: located.track.ref, objectIdentity: located.track.objectIdentity }, siblings };
    return { expectedObjectIdentity: located.clip.objectIdentity, expectedAuthorityRevision: createHash("sha256").update(canonicalMutationIdentity(authority)).digest("hex") };
  }

  private clipAuthority(snapshot: LiveSnapshot, clipRef: LiveRef): JsonObject {
    const located = this.clipRow(snapshot, clipRef);
    if (!isNonEmptyString(located.clip.objectIdentity, 256)) throw new Error("clip lacks exact object identity");
    if (located.arrangement) return this.arrangementClipAuthority(snapshot, clipRef);
    const track = located.track!;
    if (!isNonEmptyString(track.ref, 256) || !isNonEmptyString(track.objectIdentity, 256) || !Array.isArray(track.clipSlots)) throw new Error("clip track authority is incomplete");
    const slot = (track.clipSlots as unknown[]).filter(isObject).find((candidate) => candidate.clipRef === clipRef);
    const scene = slot && (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.index === slot.sceneIndex);
    if (!slot || !scene || !isNonEmptyString(slot.ref, 256) || !isNonEmptyString(slot.objectIdentity, 256) || !isNonEmptyString(scene.ref, 256) || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("clip slot or scene authority is incomplete");
    return { expectedObjectIdentity: located.clip.objectIdentity, expectedTrackRef: track.ref, expectedTrackIdentity: track.objectIdentity, expectedSlotRef: slot.ref, expectedSlotIdentity: slot.objectIdentity, expectedSceneRef: scene.ref, expectedSceneIdentity: scene.objectIdentity };
  }

  private audioClipMutationAuthority(snapshot: LiveSnapshot, clipRef: LiveRef): JsonObject {
    const located = this.clipRow(snapshot, clipRef); const authority = this.clipAuthority(snapshot, clipRef); const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"];
    const state = Object.fromEntries(fields.map((field) => [field, located.clip[field] ?? null]));
    const expectedAuthorityRevision = located.arrangement ? authority.expectedAuthorityRevision : createHash("sha256").update(canonicalMutationIdentity(authority)).digest("hex");
    return { expectedObjectIdentity: located.clip.objectIdentity, expectedAuthorityRevision, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
  }

  private async deleteOwnedClipAsync(adapter: AsyncLiveAdapter, reference: LiveRef, objectIdentity: string, context: LiveOperationContext, expectedFingerprint?: string, recoveryRecord?: object, allowAbsent = false): Promise<void> {
    const snapshot = await adapter.snapshotAsync(context); let located: ReturnType<McpHost["clipRow"]>;
    try { located = this.clipRow(snapshot, reference); } catch (cause) { if (allowAbsent) return; throw cause; }
    if (located.clip.objectIdentity !== objectIdentity) throw new Error("owned clip identity changed before cleanup");
    if (expectedFingerprint && this.captureBoundedFingerprint(located.clip) !== expectedFingerprint) throw new Error("transaction-owned clip was modified after creation; cleanup refused");
    const operation = located.arrangement ? "arrangement.clip.delete" : "clip.delete"; const args = located.arrangement ? { ref: reference, ...this.arrangementClipAuthority(snapshot, reference) } : { ref: reference, ...this.clipAuthority(snapshot, reference) };
    if (recoveryRecord) await this.invokeUndoRecovery(recoveryRecord, adapter, operation, args, context); else await adapter.invokeAsync({ operation, args }, context);
    try { this.clipRow(await adapter.snapshotAsync(context), reference); } catch { return; }
    throw new Error("owned clip cleanup was not confirmed");
  }

  private arrangementFence(snapshot: LiveSnapshot): string {
    const clips = ((snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? []).filter(isObject).map((clip) => `${clip.ref}:${String(clip.objectIdentity)}:${String(clip.trackRef)}:${String(clip.name)}:${String(clip.start)}:${String(clip.length)}`);
    return JSON.stringify(clips);
  }

  private async liveClipDuplicatePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "targetTrackRef", "targetSceneIndex", "arrangementPosition"]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    const toArrangement = params.arrangementPosition !== undefined;
    if (toArrangement && (typeof params.arrangementPosition !== "number" || !Number.isFinite(params.arrangementPosition) || params.arrangementPosition < 0)) return error(id, -32602, "arrangementPosition is out of bounds");
    if (!toArrangement && (!isNonEmptyString(params.targetTrackRef, 256) || !Number.isInteger(params.targetSceneIndex) || (params.targetSceneIndex as number) < 0 || (params.targetSceneIndex as number) > 10000)) return error(id, -32602, "targetTrackRef and targetSceneIndex are required for Session duplication");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("clip.duplicate")) throw new Error("clip duplication is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const source = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (source.arrangement && toArrangement) throw new Error("arrangement clips cannot duplicate to the Arrangement");
      let fence: string;
      const sourceAuthority = this.clipAuthority(snapshot, params.clipRef as LiveRef);
      const sourceFingerprint = this.captureObjectFingerprint(source.clip);
      if (source.arrangement) throw new Error("clip duplication requires an authoritative Session source clip");
      const payload: Record<string, unknown> = { ref: params.clipRef, targetTrackRef: null, targetSceneIndex: null, arrangementPosition: null, ...sourceAuthority, expectedContentFingerprint: sourceFingerprint, expectedTargetTrackIdentity: null, expectedTargetSlotRef: null, expectedTargetSlotIdentity: null, expectedTargetSceneRef: null, expectedTargetSceneIdentity: null, expectedTargetCollectionRevision: null };
      if (toArrangement) {
        payload.arrangementPosition = params.arrangementPosition;
        payload.expectedTargetCollectionRevision = this.arrangementCollectionRevision(snapshot, source.track!.ref as LiveRef);
        fence = JSON.stringify({ arrangement: this.arrangementFence(snapshot), sourceAuthority, sourceFingerprint });
      } else {
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === params.targetTrackRef);
        if (!targetTrack || !isNonEmptyString(targetTrack.objectIdentity, 256)) throw new Error("target track identity is not authoritative");
        const slots = (targetTrack.clipSlots as unknown[]).filter(isObject);
        const target = slots.find((slot) => slot.sceneIndex === params.targetSceneIndex);
        const targetScene = (snapshot.scenes as unknown as JsonObject[]).find((scene) => scene.index === params.targetSceneIndex);
        if (!target || !targetScene || !isNonEmptyString(target.ref, 256) || !isNonEmptyString(target.objectIdentity, 256) || !isNonEmptyString(targetScene.ref, 256) || !isNonEmptyString(targetScene.objectIdentity, 256)) throw new Error("target slot or scene identity is invalid");
        if (target.clipRef) throw new Error("target Session slot is occupied");
        payload.targetTrackRef = params.targetTrackRef;
        payload.targetSceneIndex = params.targetSceneIndex;
        payload.expectedTargetTrackIdentity = targetTrack.objectIdentity;
        payload.expectedTargetSlotRef = target.ref;
        payload.expectedTargetSlotIdentity = target.objectIdentity;
        payload.expectedTargetSceneRef = targetScene.ref;
        payload.expectedTargetSceneIdentity = targetScene.objectIdentity;
        fence = JSON.stringify({ sourceAuthority, sourceFingerprint, target: target.ref, targetIdentity: target.objectIdentity, targetTrackIdentity: targetTrack.objectIdentity, targetSceneIdentity: targetScene.objectIdentity, empty: target.empty });
      }
      const transaction: ClipLifecycleTransaction = { id: `clipdup_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "duplicate", fence, clipRef: params.clipRef as LiveRef, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip duplicate");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, source: params.clipRef, destination: toArrangement ? { arrangementPosition: payload.arrangementPosition } : { trackRef: payload.targetTrackRef, sceneIndex: payload.targetSceneIndex }, impact: "duplicates-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-duplicate preview requires fresh authoritative state."); }
  }

  private async liveClipDuplicateApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "duplicate" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-duplicate transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      if (!reconciliation && transaction.payload.arrangementPosition !== null) {
        const source = this.clipRow(snapshot, transaction.clipRef!);
        if (JSON.stringify({ arrangement: this.arrangementFence(snapshot), sourceAuthority: this.clipAuthority(snapshot, transaction.clipRef!), sourceFingerprint: this.captureObjectFingerprint(source.clip) }) !== transaction.fence) return this.transactionError(id, "Arrangement or source clip identity or content changed since preview; preview again");
      } else if (!reconciliation) {
        const sourceAuthority = this.clipAuthority(snapshot, transaction.clipRef!);
        const source = this.clipRow(snapshot, transaction.clipRef!);
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === transaction.payload.targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === transaction.payload.targetSceneIndex);
        const targetScene = (snapshot.scenes as unknown as JsonObject[]).find((scene) => scene.index === transaction.payload.targetSceneIndex);
        if (!targetTrack || !target || !targetScene || target.clipRef || JSON.stringify({ sourceAuthority, sourceFingerprint: this.captureObjectFingerprint(source.clip), target: target.ref, targetIdentity: target.objectIdentity, targetTrackIdentity: targetTrack.objectIdentity, targetSceneIdentity: targetScene.objectIdentity, empty: target.empty }) !== transaction.fence) return this.transactionError(id, "source clip content or target Session identity changed since preview; preview again");
      }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const created = await adapter.invokeAsync({ operation: "clip.duplicate", args: transaction.payload }, context) as { ref?: unknown; objectIdentity?: unknown; name?: unknown; createdFingerprint?: unknown };
      if (typeof created?.ref !== "string" || !isNonEmptyString(created.objectIdentity, 256) || !isNonEmptyString(created.createdFingerprint, 64)) throw new Error("clip duplication did not return exact created identity");
      const createdClip = this.clipRow(await adapter.snapshotAsync(context), created.ref as LiveRef); if (createdClip.clip.objectIdentity !== created.objectIdentity || this.captureObjectFingerprint(createdClip.clip) !== created.createdFingerprint) throw new Error("duplicated clip identity or creation fingerprint was not confirmed");
      transaction.created = { ...(created as Record<string, unknown>), fingerprint: created.createdFingerprint };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip duplication is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveArrangementClipPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (isObject(params) && params.action === "delete") return this.transactionError(id, "Arbitrary Arrangement clip deletion is unavailable; use live_undo only for an exact transaction-created clip");
    if (!isObject(params) || !hasOnly(params, ["action", "kind", "trackRef", "position", "length", "name", "filePath", "clipRef", "takeLaneRef"]) || params.action !== "create") return error(id, -32602, "action=create is required; arbitrary Arrangement deletion is unavailable");
    const createKind = params.kind ?? "midi";
    if (createKind !== "midi" && createKind !== "audio") return error(id, -32602, "kind must be midi or audio");
    if (params.takeLaneRef !== undefined && (createKind !== "midi" || !isNonEmptyString(params.takeLaneRef, 256))) return error(id, -32602, "takeLaneRef requires kind=midi");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.takeLaneRef !== undefined ? "take-lane.clip.create" : createKind === "audio" ? "arrangement.audio-clip.create" : "arrangement.clip.create";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync(); const fence = this.arrangementFence(snapshot);
      if (params.takeLaneRef !== undefined) {
        if (typeof params.position !== "number" || !Number.isFinite(params.position) || params.position < 0 || typeof params.length !== "number" || !Number.isFinite(params.length) || params.length <= 0 || !isNonEmptyString(params.name, 256)) return error(id, -32602, "position, length, and name are required for a take-lane clip create");
        const lane = this.takeLaneRow(snapshot, params.takeLaneRef as LiveRef);
        if (!isNonEmptyString(lane.lane.objectIdentity, 256)) throw new Error("take-lane identity is not authoritative");
        const laneSiblings = lane.lane.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity }));
        const payload: Record<string, unknown> = { takeLaneRef: params.takeLaneRef, position: params.position, length: params.length, name: params.name, expectedTakeLaneIdentity: lane.lane.objectIdentity, expectedCollectionRevision: createHash("sha256").update(canonicalMutationIdentity(laneSiblings)).digest("hex") };
        const takeLaneFence = JSON.stringify({ takeLaneRef: params.takeLaneRef, laneIdentity: lane.lane.objectIdentity, siblings: laneSiblings });
        const transaction: ClipLifecycleTransaction = { id: `arrclip_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "arrangement-take-lane-create", fence: takeLaneFence, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
        this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "arrangement clip");
        return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: "create", kind: "take-lane", payload, impact: "creates-take-lane-clip-no-undo", confirmation: "apply", expiresAt: transaction.expiresAt });
      }
      if (!isNonEmptyString(params.trackRef, 256) || typeof params.position !== "number" || !Number.isFinite(params.position) || params.position < 0) return error(id, -32602, "trackRef and position are required for create");
      if (createKind === "midi" && (typeof params.length !== "number" || !Number.isFinite(params.length) || params.length <= 0 || !isNonEmptyString(params.name, 256))) return error(id, -32602, "length and name are required for a MIDI clip create");
      if (createKind === "audio" && !isNonEmptyString(params.filePath, 1024)) return error(id, -32602, "filePath is required for an Arrangement audio import");
      if (params.name !== undefined && !isNonEmptyString(params.name, 256)) return error(id, -32602, "name is invalid");
      const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === params.trackRef); if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is not authoritative");
      const payload: Record<string, unknown> = createKind === "audio"
        ? { trackRef: params.trackRef, filePath: params.filePath, position: params.position, ...(params.name !== undefined ? { name: params.name } : {}), expectedTrackIdentity: track.objectIdentity, expectedCollectionRevision: this.arrangementCollectionRevision(snapshot, params.trackRef as LiveRef) }
        : { trackRef: params.trackRef, position: params.position, length: params.length, name: params.name, expectedTrackIdentity: track.objectIdentity, expectedCollectionRevision: this.arrangementCollectionRevision(snapshot, params.trackRef as LiveRef) };
      const transaction: ClipLifecycleTransaction = { id: `arrclip_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: createKind === "audio" ? "arrangement-audio-create" : "arrangement-create", fence, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "arrangement clip");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: "create", kind: createKind, payload, impact: createKind === "audio" ? "creates-arrangement-audio-clip" : "creates-arrangement-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement-clip preview requires fresh authoritative state."); }
  }

  private async liveArrangementClipApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || !["arrangement-create", "arrangement-delete", "arrangement-audio-create", "arrangement-take-lane-create"].includes(transaction.kind) || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired arrangement-clip transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation && transaction.kind !== "arrangement-take-lane-create" && this.arrangementFence(await adapter.snapshotAsync(context)) !== transaction.fence) return this.transactionError(id, "Arrangement changed since preview; preview again");
      if (!reconciliation && transaction.kind === "arrangement-take-lane-create") { const snapshot = await adapter.snapshotAsync(context); const lane = this.takeLaneRow(snapshot, transaction.payload.takeLaneRef as LiveRef); const laneSiblings = lane.lane.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity })); if (JSON.stringify({ takeLaneRef: transaction.payload.takeLaneRef, laneIdentity: lane.lane.objectIdentity, siblings: laneSiblings }) !== transaction.fence) return this.transactionError(id, "take lane or its clips changed since preview; preview again"); }
      const operation = transaction.kind === "arrangement-create" ? "arrangement.clip.create" : transaction.kind === "arrangement-audio-create" ? "arrangement.audio-clip.create" : transaction.kind === "arrangement-take-lane-create" ? "take-lane.clip.create" : "arrangement.clip.delete";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args: transaction.payload }, context) as Record<string, unknown>;
      const createsClip = transaction.kind === "arrangement-create" || transaction.kind === "arrangement-audio-create" || transaction.kind === "arrangement-take-lane-create";
      if (createsClip && (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64))) throw new Error("Arrangement clip creation did not return exact identity");
      transaction.created = result;
      if (createsClip) { const createdClip = this.clipRow(await adapter.snapshotAsync(context), result.ref as LiveRef); if (createdClip.clip.objectIdentity !== result.objectIdentity || this.captureObjectFingerprint(createdClip.clip) !== result.createdFingerprint) throw new Error("created Arrangement clip identity or creation fingerprint was not confirmed"); transaction.created.fingerprint = result.createdFingerprint; }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Arrangement-clip state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveClipMovePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["clipRef", "position", "targetTrackRef", "targetSceneIndex"]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      let fence: string;
      const payload: Record<string, unknown> = {};
      let kind: ClipLifecycleTransaction["kind"] = "move";
      if (row.arrangement) {
        if (!(status.operations ?? []).includes("arrangement.clip.move")) throw new Error("arrangement clip move is unavailable");
        if (typeof params.position !== "number" || !Number.isFinite(params.position) || params.position < 0) return error(id, -32602, "position is required for an Arrangement clip move");
        payload.ref = params.clipRef; payload.position = params.position; Object.assign(payload, this.arrangementClipAuthority(snapshot, params.clipRef as LiveRef));
        payload.expectedContentFingerprint = this.captureObjectFingerprint(row.clip);
        payload.priorPosition = row.clip.start;
        fence = JSON.stringify({ ref: params.clipRef, objectIdentity: row.clip.objectIdentity, start: row.clip.start, contentFingerprint: payload.expectedContentFingerprint });
      } else {
        if (!(status.operations ?? []).includes("clip.move")) throw new Error("atomic Session clip move is unavailable");
        if (!isNonEmptyString(params.targetTrackRef, 256) || !Number.isInteger(params.targetSceneIndex) || (params.targetSceneIndex as number) < 0 || (params.targetSceneIndex as number) > 10000) return error(id, -32602, "targetTrackRef and targetSceneIndex are required for a Session slot move");
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === params.targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === params.targetSceneIndex);
        if (!target) throw new Error("target scene index is invalid");
        if (target.clipRef) throw new Error("target Session slot is occupied");
        const sourceAuthority = this.clipAuthority(snapshot, params.clipRef as LiveRef);
        const sourceFingerprint = this.captureObjectFingerprint(row.clip);
        const targetScene = (snapshot.scenes as unknown as JsonObject[]).find((scene) => scene.index === params.targetSceneIndex);
        if (!isNonEmptyString(targetTrack.objectIdentity, 256) || !isNonEmptyString(target.objectIdentity, 256) || !targetScene || !isNonEmptyString(targetScene.ref, 256) || !isNonEmptyString(targetScene.objectIdentity, 256)) throw new Error("Session move target identity is incomplete");
        payload.duplicate = { ref: params.clipRef, targetTrackRef: params.targetTrackRef, targetSceneIndex: params.targetSceneIndex, arrangementPosition: null, ...sourceAuthority, expectedContentFingerprint: sourceFingerprint, expectedTargetTrackIdentity: targetTrack.objectIdentity, expectedTargetSlotRef: target.ref, expectedTargetSlotIdentity: target.objectIdentity, expectedTargetSceneRef: targetScene.ref, expectedTargetSceneIdentity: targetScene.objectIdentity, expectedTargetCollectionRevision: null };
        payload.deleteRef = params.clipRef;
        payload.deleteAuthority = sourceAuthority;
        payload.sourceSceneIndex = (row.track?.clipSlots as unknown[]).filter(isObject).find((slot) => slot.clipRef === params.clipRef)?.sceneIndex;
        if (!isIntegerInRange(payload.sourceSceneIndex, 0, 10000)) throw new Error("Session move source scene identity is incomplete");
        fence = JSON.stringify({ sourceAuthority, sourceFingerprint, target: target.ref, targetIdentity: target.objectIdentity, targetTrackIdentity: targetTrack.objectIdentity, targetSceneIdentity: targetScene.objectIdentity, empty: target.empty });
      }
      const transaction: ClipLifecycleTransaction = { id: `clipmove_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind, fence, clipRef: params.clipRef as LiveRef, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip move");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, payload, impact: "moves-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-move preview requires fresh authoritative state."); }
  }

  private async liveClipMoveApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "move" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-move transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = reconciliation ? undefined : await adapter.snapshotAsync(context);
      if (transaction.payload.position !== undefined) {
        const row = reconciliation ? undefined : this.clipRow(snapshot!, transaction.clipRef!);
        if (!reconciliation && (!row?.arrangement || JSON.stringify({ ref: transaction.clipRef, objectIdentity: row.clip.objectIdentity, start: row.clip.start, contentFingerprint: this.captureObjectFingerprint(row.clip) }) !== transaction.fence)) return this.transactionError(id, "Arrangement clip identity, position, or content changed since preview; preview again");
        transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
        const result = await adapter.invokeAsync({ operation: "arrangement.clip.move", args: { ref: transaction.clipRef, position: transaction.payload.position, expectedObjectIdentity: transaction.payload.expectedObjectIdentity, expectedAuthorityRevision: transaction.payload.expectedAuthorityRevision, expectedContentFingerprint: transaction.payload.expectedContentFingerprint } }, context) as Record<string, unknown>;
        if (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64)) throw new Error("Arrangement clip move did not return exact created identity");
        const after = await adapter.snapshotAsync(context); const moved = this.clipRow(after, result.ref as LiveRef); if (!moved.arrangement || moved.clip.objectIdentity !== result.objectIdentity || moved.clip.start !== transaction.payload.position || this.captureObjectFingerprint(moved.clip) !== result.createdFingerprint) throw new Error("Arrangement clip move result identity was not confirmed");
        transaction.created = { ...result, fingerprint: result.createdFingerprint };
      } else {
        const sourceAuthority = reconciliation ? undefined : this.clipAuthority(snapshot!, transaction.clipRef!);
        const source = reconciliation ? undefined : this.clipRow(snapshot!, transaction.clipRef!);
        const duplicateArgs = transaction.payload.duplicate as JsonObject;
        const targetTrack = reconciliation ? undefined : (snapshot!.tracks as unknown as JsonObject[]).find((track) => track.ref === duplicateArgs.targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === duplicateArgs.targetSceneIndex);
        const targetScene = reconciliation ? undefined : (snapshot!.scenes as unknown as JsonObject[]).find((scene) => scene.index === duplicateArgs.targetSceneIndex);
        if (!reconciliation && (!targetTrack || !target || !targetScene || !source || target.clipRef || JSON.stringify({ sourceAuthority, sourceFingerprint: this.captureObjectFingerprint(source.clip), target: target.ref, targetIdentity: target.objectIdentity, targetTrackIdentity: targetTrack.objectIdentity, targetSceneIdentity: targetScene.objectIdentity, empty: target.empty }) !== transaction.fence)) return this.transactionError(id, "source clip content or target Session identity changed since preview; preview again");
        transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
        const moved = await adapter.invokeAsync({ operation: "clip.move", args: duplicateArgs }, context) as { ref?: unknown; objectIdentity?: unknown; createdFingerprint?: unknown };
        if (typeof moved?.ref !== "string" || !isNonEmptyString(moved.objectIdentity, 256) || !isNonEmptyString(moved.createdFingerprint, 64)) throw new Error("Session clip move did not return exact destination identity");
        const after = await adapter.snapshotAsync(context);
        try { this.clipRow(after, transaction.clipRef!); throw new Error("Session clip move source still exists"); } catch (cause) { if (cause instanceof Error && cause.message === "Session clip move source still exists") throw cause; }
        const destination = this.clipRow(after, moved.ref as LiveRef); if (destination.clip.objectIdentity !== moved.objectIdentity || this.captureObjectFingerprint(destination.clip) !== moved.createdFingerprint) throw new Error("Session clip move destination identity or creation fingerprint changed");
        transaction.created = { ref: moved.ref, objectIdentity: moved.objectIdentity, fingerprint: moved.createdFingerprint, deleted: transaction.clipRef };
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip move is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveAudioClipPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"] as const;
    if (!isObject(params) || !hasOnly(params, ["clipRef", ...fields]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    const proposed: Record<string, number | boolean> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (field === "warping") { if (typeof value !== "boolean") return error(id, -32602, "warping must be boolean"); proposed[field] = value; continue; }
      if (typeof value !== "number" || !Number.isFinite(value) || (field === "gain" && value < 0) || (field === "pitchCoarse" && Math.abs(value) > 48) || (field === "pitchFine" && Math.abs(value) > 50) || (["loopStart", "loopEnd", "fadeInLength", "fadeOutLength"].includes(field) && value < 0) || (field === "warpMode" && (!Number.isInteger(value) || value < 0 || value > 16))) return error(id, -32602, `${field} is out of bounds`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one audio clip field is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("audio.clip.set")) throw new Error("audio clip editing is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const row = this.clipRow(snapshot, params.clipRef as LiveRef);
      if (row.clip.isAudio !== true) return this.transactionError(id, "audio properties require an audio clip");
      const available = Array.isArray(row.clip.availableAudioFields) ? row.clip.availableAudioFields : fields.filter((field) => row.clip[field] !== null && row.clip[field] !== undefined);
      if (Object.keys(proposed).some((field) => !available.includes(field))) return this.transactionError(id, "one or more requested audio fields are unavailable on this exact clip");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = row.clip[field] ?? null;
      const authority = this.audioClipMutationAuthority(snapshot, params.clipRef as LiveRef);
      const fence = JSON.stringify({ ref: params.clipRef, objectIdentity: authority.expectedObjectIdentity, fields: fields.map((field) => row.clip[field] ?? null) });
      const transaction: ClipLifecycleTransaction = { id: `audioclip_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "audio-set", fence, clipRef: params.clipRef as LiveRef, payload: { ref: params.clipRef, ...proposed, ...authority }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "audio clip");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, prior, proposed, impact: "edits-audio-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Audio-clip preview requires fresh authoritative state."); }
  }

  private async liveAudioClipApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "audio-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired audio-clip transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"] as const;
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, transaction.clipRef!);
        if (JSON.stringify({ ref: transaction.clipRef, objectIdentity: row.clip.objectIdentity, fields: fields.map((field) => row.clip[field] ?? null) }) !== transaction.fence) return this.transactionError(id, "audio clip identity or state changed since preview; preview again"); }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation: "audio.clip.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("audio clip change was not confirmed");
      const verified = this.clipRow(await adapter.snapshotAsync(context), transaction.clipRef!).clip; for (const field of fields) if (Object.prototype.hasOwnProperty.call(transaction.payload, field) && verified[field] !== transaction.payload[field]) throw new Error("audio clip postcondition was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Audio-clip state is uncertain; perform fresh discovery before retrying."); }
  }

  private noteClip(snapshot: LiveSnapshot, clipRef: LiveRef): { notes: Array<Record<string, unknown>>; notesRevision: string; authority: JsonObject; length: number } {
    for (const track of snapshot.tracks) {
      const clip = (track.clips as unknown as Array<Record<string, unknown>>).find((item) => item.ref === clipRef);
      if (clip && clip.kind === "midi" && Array.isArray(clip.notes) && isNonEmptyString(clip.notesRevision, 64) && typeof clip.length === "number" && Number.isFinite(clip.length)) return { notes: clip.notes as Array<Record<string, unknown>>, notesRevision: clip.notesRevision, authority: this.clipAuthority(snapshot, clipRef), length: clip.length };
    }
    throw new Error("MIDI clip reference lacks exact identity or notes revision");
  }

  private noteFence(notes: Array<Record<string, unknown>>): string {
    return JSON.stringify(notes.map((note) => ({ id: note.id ?? null, pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, channel: note.channel ?? 1, mute: note.mute ?? null, probability: note.probability ?? null, velocityDeviation: note.velocityDeviation ?? null, releaseVelocity: note.releaseVelocity ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }

  private noteContentFence(notes: Array<Record<string, unknown>>): string {
    return JSON.stringify(notes.map((note) => ({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, channel: note.channel ?? 1, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }

  private async liveNoteEditPreviewAsync(id: RequestId, params: unknown, kind: "update" | "delete"): Promise<JsonObject> {
    const requiredKeys = kind === "update" ? ["clipRef", "notes"] : ["clipRef", "noteIds"];
    if (!isObject(params) || !hasOnly(params, requiredKeys) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, `${requiredKeys.join(" and ")} are required`);
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = kind === "update" ? "note.update" : "note.delete";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const clip = this.noteClip(snapshot, params.clipRef as LiveRef);
      const fence = this.noteFence(clip.notes);
      const present = new Set(clip.notes.map((note) => note.id).filter((value) => typeof value === "number"));
      let patches: Array<Record<string, unknown>> | undefined;
      let noteIds: number[] | undefined;
      if (kind === "update") {
        if (!Array.isArray(params.notes) || params.notes.length < 1 || params.notes.length > 512) return error(id, -32602, "notes must be 1-512 patch objects");
        const seen = new Set<number>();
        for (const patch of params.notes) {
          if (!isObject(patch) || Object.keys(patch).length < 2 || !Number.isInteger(patch.id) || (patch.id as number) < 0 || !hasOnly(patch, ["id", "pitch", "start", "duration", "velocity", "mute", "probability", "velocityDeviation", "releaseVelocity"])) return error(id, -32602, "note patches require an id, at least one edit, and only supported fields");
          if (seen.has(patch.id as number)) return error(id, -32602, "duplicate note patch id");
          seen.add(patch.id as number);
          if (patch.pitch !== undefined && (!Number.isInteger(patch.pitch) || (patch.pitch as number) < 0 || (patch.pitch as number) > 127)) return error(id, -32602, "pitch is out of bounds");
          if (patch.start !== undefined && (!Number.isFinite(patch.start) || (patch.start as number) < 0)) return error(id, -32602, "start is out of bounds");
          if (patch.duration !== undefined && (!Number.isFinite(patch.duration) || (patch.duration as number) <= 0)) return error(id, -32602, "duration is out of bounds");
          if (patch.velocity !== undefined && (!Number.isFinite(patch.velocity) || (patch.velocity as number) < 0 || (patch.velocity as number) > 127)) return error(id, -32602, "velocity is out of bounds");
          if (patch.mute !== undefined && typeof patch.mute !== "boolean") return error(id, -32602, "mute must be boolean");
          if (patch.probability !== undefined && (!Number.isFinite(patch.probability) || (patch.probability as number) < 0 || (patch.probability as number) > 1)) return error(id, -32602, "probability is out of bounds");
          if (patch.velocityDeviation !== undefined && (!Number.isFinite(patch.velocityDeviation) || Math.abs(patch.velocityDeviation as number) > 127)) return error(id, -32602, "velocityDeviation is out of bounds");
          if (patch.releaseVelocity !== undefined && (!Number.isFinite(patch.releaseVelocity) || (patch.releaseVelocity as number) < 0 || (patch.releaseVelocity as number) > 127)) return error(id, -32602, "releaseVelocity is out of bounds");
        }
        if ([...seen].some((noteId) => !present.has(noteId))) return this.transactionError(id, "note id is not present in the clip");
        patches = structuredClone(params.notes) as Array<Record<string, unknown>>;
        noteIds = [...seen];
      } else {
        if (!Array.isArray(params.noteIds) || params.noteIds.length < 1 || params.noteIds.length > 512 || !params.noteIds.every((value) => Number.isInteger(value) && (value as number) >= 0)) return error(id, -32602, "noteIds must be 1-512 non-negative integers");
        if (new Set(params.noteIds).size !== params.noteIds.length) return error(id, -32602, "duplicate note id");
        if ((params.noteIds as number[]).some((noteId) => !present.has(noteId))) return this.transactionError(id, "note id is not present in the clip");
        noteIds = [...(params.noteIds as number[])];
      }
      const priorNotes = clip.notes.filter((note) => noteIds!.includes(note.id as number)).map((note) => structuredClone(note)); const expectedNotes = clip.notes.map((note) => structuredClone(note));
      if (kind === "update") for (const patch of patches ?? []) { const note = expectedNotes.find((candidate) => candidate.id === patch.id); if (!note) throw new Error("note patch target disappeared"); Object.assign(note, patch); if (typeof note.start !== "number" || typeof note.duration !== "number" || note.start < 0 || note.duration <= 0 || note.start + note.duration > clip.length) return error(id, -32602, "note patch exceeds the exact clip length"); }
      else for (let index = expectedNotes.length - 1; index >= 0; index -= 1) if (noteIds!.includes(expectedNotes[index]!.id as number)) expectedNotes.splice(index, 1);
      const expectedAppliedFence = this.noteFence(expectedNotes);
      const transaction: NoteEditTransaction = { id: `note${kind}_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind, clipRef: params.clipRef as LiveRef, authority: clip.authority, notesRevision: clip.notesRevision, fence, expectedAppliedFence, patches, noteIds, priorNotes, priorAllNotes: clip.notes.map((note) => structuredClone(note)), expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.noteEditTransactions, transaction, "note edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: transaction.clipRef, [kind === "update" ? "patches" : "noteIds"]: kind === "update" ? patches : noteIds, priorNotes: transaction.priorNotes, impact: kind === "update" ? "edits-midi-notes" : "deletes-midi-notes", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Note-edit preview requires fresh authoritative clip state."); }
  }

  private async liveNoteEditApplyAsync(id: RequestId, params: unknown, kind: "update" | "delete", signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.noteEditTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== kind || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired note-edit transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const snapshot = await adapter.snapshotAsync(context); const current = this.noteClip(snapshot, transaction.clipRef);
        if (this.noteFence(current.notes) !== transaction.fence || current.notesRevision !== transaction.notesRevision || JSON.stringify(current.authority) !== JSON.stringify(transaction.authority)) return this.transactionError(id, "clip identity or notes changed since preview; preview again"); }
      const operation = kind === "update" ? "note.update" : "note.delete";
      const args = kind === "update" ? { ref: transaction.clipRef, notes: transaction.patches, expectedClipAuthority: transaction.authority, expectedNotesRevision: transaction.notesRevision } : { ref: transaction.clipRef, noteIds: transaction.noteIds, expectedClipAuthority: transaction.authority, expectedNotesRevision: transaction.notesRevision };
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args }, context) as { updated?: unknown; deleted?: unknown };
      const expectedCount = kind === "update" ? transaction.patches?.length : transaction.noteIds?.length;
      if ((kind === "update" ? result.updated : result.deleted) !== expectedCount) throw new Error("Live did not confirm the complete note edit");
      const applied = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef); transaction.appliedFence = this.noteFence(applied.notes); if (transaction.appliedFence !== transaction.expectedAppliedFence) throw new Error("Live note edit changed, clamped, or omitted unexpected note state");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", ...(kind === "update" ? { updated: result.updated } : { deleted: result.deleted }), idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveNoteEditUndoAsync(id: RequestId, transaction: NoteEditTransaction, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonObject> {
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.undoKey === params.idempotencyKey; const applyRecovery = transaction.state === "uncertain" && transaction.undoKey === undefined && transaction.kind === "delete";
    if (transaction.state !== "applied" && !reconciliation && !applyRecovery) return this.transactionError(id, "Only an applied, recoverable uncertain delete, or exact-key uncertain note-edit transaction can be undone");
    try {
      this.beginUndoRecovery(transaction, params.idempotencyKey as string);
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (reconciliation) await this.replayUndoRecovery(transaction, adapter, context);
      const current = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef);
      if (applyRecovery) {
        if (JSON.stringify(current.authority) !== JSON.stringify(transaction.authority)) throw new Error("uncertain note deletion clip hierarchy changed");
        const original = new Map(transaction.priorAllNotes.map((note) => [note.id, note])); const currentById = new Map(current.notes.map((note) => [note.id, note]));
        for (const [noteId, note] of currentById) { const prior = original.get(noteId); if (!prior || this.noteFence([note]) !== this.noteFence([prior])) throw new Error("uncertain note deletion conflicts with external note changes"); }
        const missing = transaction.priorAllNotes.filter((note) => !currentById.has(note.id)); transaction.undoExpectedFence = this.noteContentFence(transaction.priorAllNotes); transaction.undoKey = params.idempotencyKey as string;
        if (missing.length > 0) { const notes = missing.map((note) => ({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, channel: note.channel ?? 1, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 })); await this.invokeUndoRecovery(transaction, adapter, "note.add-batch", { ref: transaction.clipRef, notes, expectedClipAuthority: current.authority, expectedNotesRevision: current.notesRevision }, context); }
        const verified = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef); if (this.noteContentFence(verified.notes) !== transaction.undoExpectedFence) throw new Error("uncertain note deletion recovery did not restore exact prior content"); transaction.state = "undone"; return this.successText(id, { transactionId: transaction.id, state: "undone", restored: missing.length, recoveredFromUncertainApply: true, idempotent: false });
      }
      if (reconciliation) {
        const restoredFence = transaction.kind === "update" ? this.noteFence(current.notes) : this.noteContentFence(current.notes);
        if (!transaction.undoExpectedFence || restoredFence !== transaction.undoExpectedFence) throw new Error("note-edit undo replay did not restore the exact prior content");
        transaction.state = "undone"; return this.successText(id, { transactionId: transaction.id, state: "undone", restored: transaction.priorNotes.length, idempotent: false });
      }
      if (!transaction.appliedFence || this.noteFence(current.notes) !== transaction.appliedFence || JSON.stringify(current.authority) !== JSON.stringify(transaction.authority)) return this.transactionError(id, "clip identity or notes changed after apply; undo refused");
      transaction.state = "undoing"; transaction.undoKey = params.idempotencyKey as string;
      if (transaction.kind === "update") {
        const restore = transaction.priorNotes.map((note) => ({ id: note.id, pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 }));
        transaction.undoExpectedFence = transaction.fence;
        await this.invokeUndoRecovery(transaction, adapter, "note.update", { ref: transaction.clipRef, notes: restore, expectedClipAuthority: current.authority, expectedNotesRevision: current.notesRevision }, context);
        const verified = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef); if (this.noteFence(verified.notes) !== transaction.undoExpectedFence) throw new Error("note update undo did not restore exact prior notes");
        transaction.state = "undone";
        transaction.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: transaction.id, state: "undone", restored: restore.length, idempotent: false });
      }
      const notes = transaction.priorNotes.map((note) => ({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, channel: note.channel ?? 1, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 }));
      transaction.undoExpectedFence = this.noteContentFence([...current.notes, ...transaction.priorNotes]);
      const result = await this.invokeUndoRecovery(transaction, adapter, "note.add-batch", { ref: transaction.clipRef, notes, expectedClipAuthority: current.authority, expectedNotesRevision: current.notesRevision }, context) as { added?: unknown; noteIds?: unknown };
      if (result.added !== notes.length || !Array.isArray(result.noteIds) || result.noteIds.length !== notes.length) throw new Error("note delete undo did not re-add the complete batch");
      const verified = this.noteClip(await adapter.snapshotAsync(context), transaction.clipRef);
      if (this.noteContentFence(verified.notes) !== transaction.undoExpectedFence) throw new Error("note delete undo content verification failed");
      transaction.state = "undone";
      transaction.undoKey = params.idempotencyKey as string;
      return this.successText(id, { transactionId: transaction.id, state: "undone", restored: notes.length, reAdded: result.noteIds.map((noteId, index) => ({ priorId: transaction.priorNotes[index]?.id, noteId })), note: "re-added notes receive new note ids", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit undo is uncertain; perform fresh discovery."); }
  }

  private captureObjectFingerprint(value: unknown): string { return createHash("sha256").update(canonicalMutationIdentity(value)).digest("hex"); }

  private captureAuthorityRevision(snapshot: LiveSnapshot): string {
    const authority = { tracks: snapshot.tracks.map((track) => ({ ref: track.ref, objectIdentity: track.objectIdentity, clips: track.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity, notesRevision: clip.notesRevision })) })), scenes: snapshot.scenes.map((scene) => ({ ref: scene.ref, objectIdentity: scene.objectIdentity, index: scene.index })), playbackRevision: snapshot.playback.revision };
    return createHash("sha256").update(canonicalMutationIdentity(authority)).digest("hex");
  }

  private captureFence(snapshot: LiveSnapshot): string {
    return JSON.stringify({
      structure: this.structureRevision(snapshot),
      tracks: snapshot.tracks.map((track) => ({ ref: track.ref, kind: track.kind, clips: track.clips.map((clip) => ({ ref: clip.ref, name: clip.name, length: clip.length, notes: clip.notes })) })),
      scenes: snapshot.scenes.map((scene) => ({ ref: scene.ref, name: scene.name, index: scene.index })),
      playback: { revision: snapshot.playback.revision, firedTargets: snapshot.playback.firedTargets, playingTargets: snapshot.playback.playingTargets, transport: snapshot.playback.transport },
    });
  }

  private async liveCapturePreviewAsync(id: RequestId, params: unknown, kind: "capture-midi" | "scene-capture"): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, [])) return error(id, -32602, "capture preview accepts no arguments");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const operation = kind === "capture-midi" ? "session.capture-midi" : "scene.capture";
      const recoveryOperation = kind === "capture-midi" ? "clip.delete" : "scene.delete";
      if (!status.connected || !(status.capabilities ?? []).includes("session.read") || !(status.operations ?? []).includes(operation) || !(status.operations ?? []).includes(recoveryOperation)) throw new Error(`${kind} is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const transaction: ClipLifecycleTransaction = { id: `${kind === "capture-midi" ? "capturemidi" : "scenecapture"}_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind, fence: this.captureFence(snapshot), payload: { expectedStateRevision: this.captureAuthorityRevision(snapshot) }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, kind);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, impact: kind === "capture-midi" ? "creates-session-midi-clips" : "creates-one-session-scene", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Capture preview failed without mutation; rediscover Session state."); }
  }

  private async liveCaptureApplyAsync(id: RequestId, params: unknown, kind: "capture-midi" | "scene-capture", signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== kind || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired capture transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Capture transaction is no longer applicable");
    if (signal?.aborted) return null;
    transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string; let dispatched = reconciliation;
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) { transaction.state = "previewed"; delete transaction.applyKey; return this.transactionError(id, "Live connection epoch changed; preview again"); }
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (!reconciliation) { const before = await adapter.snapshotAsync(context);
        if (this.captureFence(before) !== transaction.fence) { transaction.state = "previewed"; delete transaction.applyKey; return this.transactionError(id, "Session state changed since capture preview; preview again"); } }
      dispatched = true;
      if (kind === "capture-midi") {
        const result = await adapter.invokeAsync({ operation: "session.capture-midi", args: transaction.payload }, context) as { captured?: unknown; clips?: unknown; clipIdentities?: unknown };
        const clips = Array.isArray(result.clips) ? result.clips.filter((ref): ref is string => typeof ref === "string") : [];
        const identities = Array.isArray(result.clipIdentities) ? result.clipIdentities.filter(isObject) : [];
        const after = await adapter.snapshotAsync(context); const authoritative = new Map(after.tracks.flatMap((track) => track.clips.map((clip) => [clip.ref, clip] as const)));
        if (result.captured !== (clips.length > 0) || identities.length !== clips.length || clips.some((ref) => !authoritative.has(ref as LiveRef))) throw new Error("MIDI capture postcondition was not confirmed");
        const owned = clips.map((ref) => { const identity = identities.find((row) => row.ref === ref); const clip = authoritative.get(ref as LiveRef); if (!identity || !isNonEmptyString(identity.objectIdentity, 256) || !isNonEmptyString(identity.createdFingerprint, 64) || !clip || this.captureObjectFingerprint(clip) !== identity.createdFingerprint) throw new Error("captured MIDI object identity or creation fingerprint is unavailable"); return { ref, objectIdentity: identity.objectIdentity, fingerprint: identity.createdFingerprint }; });
        transaction.created = { clips: owned };
      } else {
        const result = await adapter.invokeAsync({ operation: "scene.capture", args: transaction.payload }, context) as { captured?: unknown; ref?: unknown; objectIdentity?: unknown; createdFingerprint?: unknown };
        const after = await adapter.snapshotAsync(context); const scene = after.scenes.find((row) => row.ref === result.ref);
        if (result.captured !== true || typeof result.ref !== "string" || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64) || !scene || this.sessionStructureCreatedFingerprint(after, "scene", result.ref as LiveRef) !== result.createdFingerprint) throw new Error("scene capture postcondition was not confirmed");
        transaction.created = { sceneRef: result.ref, objectIdentity: result.objectIdentity, fingerprint: result.createdFingerprint };
      }
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: false });
    } catch (cause) { transaction.state = dispatched ? "uncertain" : "previewed"; if (!dispatched) delete transaction.applyKey; return this.adapterToolError(id, cause, dispatched ? "Capture state is uncertain; perform fresh discovery before recovery." : "Capture apply failed before dispatch; preview remains available until expiry."); }
  }

  private parameterTarget(snapshot: LiveSnapshot, deviceRef: string, parameterRef: string): { device: LiveSnapshot["tracks"][number]["devices"][number]; parameter: LiveSnapshot["tracks"][number]["devices"][number]["parameters"][number]; trackRef: LiveRef } {
    for (const track of snapshot.tracks) {
      const device = this.flattenDeviceRows((track as unknown as JsonObject).devices).find((item) => item.ref === deviceRef) as unknown as LiveSnapshot["tracks"][number]["devices"][number] | undefined;
      const parameter = device?.parameters.find((item) => item.ref === parameterRef);
      if (device && parameter) return { device, parameter, trackRef: track.ref };
    }
    throw new Error("device and parameter references are not authoritative children");
  }

  private parameterRevision(parameter: { ref: LiveRef; value: number; revision?: number }): number { return parameter.revision ?? 1; }

  private parameterAuthority(snapshot: LiveSnapshot, parameterRef: LiveRef): JsonObject {
    const target = this.realtimeParameterTargets(snapshot, [parameterRef])[0];
    if (!target || !isObject(target.authority) || target.authority.ref !== parameterRef || !isNonEmptyString(target.authority.parameterIdentity, 256) || !isNonEmptyString(target.authority.ownerRef, 256) || !isNonEmptyString(target.authority.ownerIdentity, 256) || !isNonEmptyString(target.authority.trackRef, 256) || !isNonEmptyString(target.authority.trackIdentity, 256) || !Array.isArray(target.authority.siblings)) throw new Error("parameter lacks complete exact hierarchy authority");
    return structuredClone(target.authority);
  }

  private parameterMutationArgs(transaction: DeviceParameterTransaction, value: number, expectedRevision: number): JsonObject {
    return { ref: transaction.parameterRef, value, expectedRevision, expectedObjectIdentity: transaction.authority.parameterIdentity, expectedOwnerRef: transaction.authority.ownerRef, expectedOwnerIdentity: transaction.authority.ownerIdentity, expectedTrackRef: transaction.authority.trackRef, expectedTrackIdentity: transaction.authority.trackIdentity, expectedSiblings: structuredClone(transaction.authority.siblings) };
  }

  private validateDeviceParameterPreview(params: unknown): params is { deviceRef: string; parameterRef: string; value: number } {
    return isObject(params) && hasOnly(params, ["deviceRef", "parameterRef", "value"]) && isNonEmptyString(params.deviceRef, 256) && isNonEmptyString(params.parameterRef, 256) && typeof params.value === "number" && Number.isFinite(params.value);
  }

  private validDeviceParameterApply(params: unknown): params is JsonObject {
    return isObject(params) && hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) && isNonEmptyString(params.transactionId, 128) && isNonEmptyString(params.confirmation, 128) && isIdempotencyKey(params.idempotencyKey);
  }

  private async liveDeviceParameterPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validateDeviceParameterPreview(params)) return error(id, -32602, "deviceRef, parameterRef, and finite value are required");
    try {
      const status = this.requireConnected("device.parameter.write");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const target = this.parameterTarget(snapshot, params.deviceRef, params.parameterRef);
      const authority = this.parameterAuthority(snapshot, target.parameter.ref);
      const revision = this.parameterRevision(target.parameter);
      if ((target.device.enabled as boolean | undefined) === false || (target.parameter.enabled as boolean | undefined) === false || !target.parameter.automatable) throw new Error("parameter is disabled or not supported for guarded adjustment");
      const quantization = target.parameter.quantization ?? 0;
      if (params.value < target.parameter.min || params.value > target.parameter.max) throw new Error("parameter value is outside authoritative bounds");
      if (quantization > 0 && Math.abs((params.value - target.parameter.min) / quantization - Math.round((params.value - target.parameter.min) / quantization)) > 1e-9) throw new Error("parameter value does not match authoritative quantization");
      const transaction: DeviceParameterTransaction = { id: `parameter_${randomBytes(18).toString("base64url")}`, confirmation: randomBytes(24).toString("base64url"), epoch: status.epoch as number, deviceRef: target.device.ref, parameterRef: target.parameter.ref, authority, priorValue: target.parameter.value, proposedValue: params.value, priorRevision: revision, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.deviceParameterTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, device: { ref: target.device.ref, name: target.device.name, kind: target.device.kind, trackRef: target.trackRef, enabled: target.device.enabled !== false }, parameter: { ref: target.parameter.ref, name: target.parameter.name, currentValue: target.parameter.value, proposedValue: params.value, min: target.parameter.min, max: target.parameter.max, quantization, enabled: target.parameter.enabled !== false, automatable: target.parameter.automatable, displayValue: target.parameter.displayValue ?? String(target.parameter.value), revision }, impact: "changes-one-published-device-parameter", confirmation: transaction.confirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Parameter preview failed without mutation; discover an enabled published numeric parameter and retry."); }
  }

  private async liveDeviceParameterApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validDeviceParameterApply(params)) return error(id, -32602, "transactionId, confirmation token, and idempotencyKey are required");
    const transaction = this.deviceParameterTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired device-parameter transaction");
    if (params.confirmation !== transaction.confirmation) return this.transactionError(id, "Device-parameter confirmation token is invalid");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", value: transaction.proposedValue, revision: transaction.appliedRevision, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state === "uncertain" && !reconciliation) return this.transactionError(id, "Device-parameter state is uncertain; reconcile with the exact original idempotency key");
    if ((transaction.state !== "previewed" && !reconciliation) || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Device-parameter preview expired or is no longer applicable");
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("device.parameter.write");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const currentSnapshot = await adapter.snapshotAsync(context);
      const target = this.parameterTarget(currentSnapshot, transaction.deviceRef, transaction.parameterRef);
      const currentRevision = reconciliation ? transaction.priorRevision : this.parameterRevision(target.parameter);
      if (!reconciliation && (currentRevision !== transaction.priorRevision || target.parameter.value !== transaction.priorValue || JSON.stringify(this.parameterAuthority(currentSnapshot, transaction.parameterRef)) !== JSON.stringify(transaction.authority))) return this.transactionError(id, "Device parameter identity or value changed since preview");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      await adapter.invokeAsync({ operation: "device.parameter.set", args: this.parameterMutationArgs(transaction, transaction.proposedValue, currentRevision) }, context);
      const verifiedSnapshot = await adapter.snapshotAsync(context);
      const verified = this.parameterTarget(verifiedSnapshot, transaction.deviceRef, transaction.parameterRef).parameter;
      if (verified.value !== transaction.proposedValue || this.parameterRevision(verified) <= currentRevision || JSON.stringify(this.parameterAuthority(verifiedSnapshot, transaction.parameterRef)) !== JSON.stringify(transaction.authority)) { transaction.state = "uncertain"; throw new Error("Live did not confirm the requested exact device parameter"); }
      transaction.appliedRevision = this.parameterRevision(verified); transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", value: verified.value, revision: transaction.appliedRevision, epoch: transaction.epoch, idempotent: false });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (transaction.state === "applying") { transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain"; if (transaction.state === "previewed") delete transaction.applyKey; }
      return this.adapterToolError(id, cause, "Device-parameter apply may be uncertain; perform fresh authoritative discovery and do not retry blindly.");
    }
  }

  private async liveMidiPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["trackRef", "sceneIndex", "name", "length", "notes"]) || typeof params.trackRef !== "string" || !isIntegerInRange(params.sceneIndex, 0, 1023) || typeof params.name !== "string" || typeof params.length !== "number" || !Number.isFinite(params.length) || params.length <= 0 || params.length > 1024 || !Array.isArray(params.notes)) return error(id, -32602, "Invalid MIDI clip preview");
    return this.successText(id, await this.midiTransactions.previewAsync(params));
  }

  private async liveMidiApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    return this.successText(id, await this.midiTransactions.applyAsync(params.transactionId as string, params.confirmation, params.idempotencyKey as string, { signal, deadlineMs: Date.now() + SESSION_MIDI_TRANSACTION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }));
  }

  private locatorRevision(snapshot: LiveSnapshot): string {
    const revision = snapshot.arrangement.locatorRevision;
    if (!isNonEmptyString(revision, 64) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("locator collection revision is unavailable");
    return revision;
  }

  private locatorDeleteArgs(snapshot: LiveSnapshot, reference: LiveRef, expectedIdentity?: string): JsonObject {
    const locator = snapshot.arrangement.locators.find((candidate) => candidate.ref === reference);
    const identity = expectedIdentity ?? locator?.objectIdentity;
    if (!locator || !isNonEmptyString(identity, 256) || locator.objectIdentity !== identity) throw new Error("locator identity changed before deletion");
    return { ref: reference, expectedObjectIdentity: identity, expectedCollectionRevision: this.locatorRevision(snapshot) };
  }

  private async liveArrangementPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["start", "end", "startName", "endName"]) || typeof params.start !== "number" || !Number.isFinite(params.start) || params.start < 0 || params.start > 100_000 || typeof params.end !== "number" || !Number.isFinite(params.end) || params.end <= params.start || params.end > 100_000 || !isNonEmptyString(params.startName, 128) || !isNonEmptyString(params.endName, 128) || params.startName === params.endName) return error(id, -32602, "Arrangement section range and distinct names are required");
    try {
      const status = this.requireConnected("arrangement.read");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const prior = snapshot.arrangement.locators.map((locator) => ({ ...locator }));
      if (prior.some((locator) => !isNonEmptyString(locator.objectIdentity, 256))) throw new Error("locator object identity is unavailable");
      if (prior.some((locator) => locator.name === params.startName || locator.name === params.endName || locator.position === params.start || locator.position === params.end)) throw new Error("Arrangement locator target collides with existing state");
      const transaction: ArrangementTransaction = { id: `arrangement_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: this.locatorRevision(snapshot), start: params.start, end: params.end, startName: params.startName, endName: params.endName, prior: prior as ArrangementTransaction["prior"], expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.arrangementTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior, proposed: [{ name: transaction.startName, position: transaction.start }, { name: transaction.endName, position: transaction.end }], impact: "creates-arrangement-locators", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement preview failed without mutation; discover locators and choose a collision-free range."); }
  }

  private async compensateArrangementAsync(transaction: ArrangementTransaction, adapter: AsyncLiveAdapter, context: LiveOperationContext): Promise<void> {
    const created = transaction.created ?? []; transaction.compensationSteps ??= []; transaction.recoveryMode = "compensate"; const reversed = [...created].reverse();
    for (let index = 0; index < reversed.length; index += 1) { const locator = reversed[index]!; let step = transaction.compensationSteps[index];
      if (!step) { const snapshot = await adapter.snapshotAsync(context); const row = snapshot.arrangement.locators.find((candidate) => candidate.ref === locator.ref); if (!row) continue; if (row.objectIdentity !== locator.objectIdentity || !locator.fingerprint || this.captureObjectFingerprint(row) !== locator.fingerprint) throw new Error("transaction-owned locator changed before compensation"); step = { args: this.locatorDeleteArgs(snapshot, locator.ref, locator.objectIdentity), completed: false }; transaction.compensationSteps[index] = step; }
      if (!step.completed) { await adapter.invokeAsync({ operation: "locator.delete", args: step.args }, context); step.completed = true; }
    }
    const after = (await adapter.snapshotAsync(context)).arrangement.locators; if (created.some((locator) => after.some((row) => row.ref === locator.ref))) throw new Error("Arrangement compensation left transaction-owned locators");
  }

  private async liveArrangementApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.arrangementTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Arrangement transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", locators: transaction.created, idempotent: true });
    if (transaction.state === "applied") return this.transactionError(id, "Arrangement idempotency key conflicts with the applied transaction");
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state === "uncertain" && !reconciliation) return this.transactionError(id, "Arrangement apply is uncertain; reconcile with the exact original idempotency key");
    if ((transaction.state !== "previewed" && !reconciliation) || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Arrangement preview expired or is no longer applicable");
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("arrangement.write");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (reconciliation && transaction.recoveryMode === "compensate") { try { await this.compensateArrangementAsync(transaction, adapter, context); transaction.state = "undone"; return this.successText(id, { transactionId: transaction.id, state: "compensated", residuals: [], idempotent: false }); } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Arrangement compensation remains uncertain; inspect authoritative locators."); } }
      let currentSnapshot = await adapter.snapshotAsync(context);
      if (!reconciliation && this.locatorRevision(currentSnapshot) !== transaction.revision) return this.transactionError(id, "Arrangement locators changed since preview");
      const created: NonNullable<ArrangementTransaction["created"]> = transaction.created ? [...transaction.created] : []; let dispatchAmbiguous = false;
      transaction.recoverySteps ??= []; transaction.recoveryMode = "apply"; transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      try {
        const proposedItems = [{ name: transaction.startName, position: transaction.start }, { name: transaction.endName, position: transaction.end }];
        for (let stepIndex = 0; stepIndex < proposedItems.length; stepIndex += 1) { const proposed = proposedItems[stepIndex]!; let step = transaction.recoverySteps[stepIndex];
          if (!step) { step = { args: { ...proposed, expectedCollectionRevision: this.locatorRevision(currentSnapshot) } }; transaction.recoverySteps[stepIndex] = step; }
          let result = step.result; if (!result) { dispatchAmbiguous = true; result = await adapter.invokeAsync({ operation: "locator.add", args: step.args }, context) as typeof step.result; dispatchAmbiguous = false; }
          if (!result?.ref || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64)) throw new Error("Live did not return atomic created locator ownership evidence");
          step.result = result; if (!created.some((item) => item.ref === result!.ref)) created.push({ ...result, fingerprint: result.createdFingerprint }); transaction.created = created; currentSnapshot = await adapter.snapshotAsync(context); const owned = created.find((item) => item.ref === result!.ref)!; const row = currentSnapshot.arrangement.locators.find((item) => item.ref === owned.ref); if (!row || row.objectIdentity !== owned.objectIdentity || this.captureObjectFingerprint(row) !== owned.fingerprint) throw new Error("created locator changed after atomic creation"); if (result.name !== proposed.name || result.position !== proposed.position) throw new Error("Live did not confirm exact created locator state");
        }
      } catch (cause) {
        if (dispatchAmbiguous) { transaction.created = created; transaction.recoveryMode = "apply"; transaction.state = "uncertain"; throw cause; }
        transaction.created = created;
        try { await this.compensateArrangementAsync(transaction, adapter, context); transaction.state = "undone"; }
        catch { transaction.state = "uncertain"; transaction.recoveryMode = "compensate"; throw new Error("Arrangement apply compensation failed; retry the exact key to reconcile cleanup"); }
        throw cause;
      }
      const authoritative = (await adapter.snapshotAsync(context)).arrangement.locators;
      if (!created.every((locator) => authoritative.some((item) => item.ref === locator.ref && item.objectIdentity === locator.objectIdentity && item.name === locator.name && item.position === locator.position && this.captureObjectFingerprint(item) === locator.fingerprint))) { transaction.state = "uncertain"; transaction.created = created; throw new Error("Live did not confirm unchanged atomically owned Arrangement locators; read authoritative state before retrying"); }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", locators: created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) {
      if (transaction.state === "applying") transaction.state = "uncertain";
      return this.adapterToolError(id, cause, "Arrangement apply uncertain; read authoritative locators before retrying.");
    }
  }

  private async liveTempoPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["tempo"]) || typeof params.tempo !== "number" || !Number.isFinite(params.tempo) || params.tempo < 20 || params.tempo > 999) return error(id, -32602, "tempo must be a finite number from 20 to 999");
    const status = this.requireConnected("transport"); const snapshot = await this.asyncAdapter().snapshotAsync();
    if (typeof snapshot.set.tempo !== "number" || !Number.isFinite(snapshot.set.tempo) || !isNonEmptyString(snapshot.set.objectIdentity, 256)) return this.adapterToolError(id, new Error("authoritative Set tempo identity is unavailable"), "Tempo preview requires fresh authoritative tempo evidence.");
    const transactionId = this.newTransactionId();
    const transaction: TempoTransaction = { id: transactionId, setRef: snapshot.set.ref, setIdentity: snapshot.set.objectIdentity, priorTempo: snapshot.set.tempo, proposedTempo: params.tempo, epoch: status.epoch as number, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
    this.transactions.set(transactionId, transaction); this.evictTransactions();
    return this.successText(id, { transactionId, epoch: transaction.epoch, target: transaction.setRef, priorTempo: transaction.priorTempo, proposedTempo: transaction.proposedTempo, impact: "audible-transport", confirmation: "apply", expiresAt: transaction.expiresAt });
  }

  private async liveTempoApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.transactions.get(params.transactionId as string); if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: transaction.appliedTempo, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.applyKey === params.idempotencyKey;
    if (transaction.state === "uncertain" && !reconciliation) return this.transactionError(id, "Tempo state is uncertain; reconcile with the exact original idempotency key");
    if (transaction.state !== "previewed" && !reconciliation) return this.transactionError(id, "Transaction is no longer applicable");
    if ((transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Tempo preview expired; preview again");
    try {
      if (reconciliation) await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      const status = this.requireConnected("transport"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const current = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!reconciliation && (!current || current.objectIdentity !== transaction.setIdentity || current.tempo !== transaction.priorTempo)) return this.transactionError(id, "Set identity or tempo changed since preview; preview again");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      await adapter.invokeAsync({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.proposedTempo, expectedTempo: transaction.priorTempo, expectedObjectIdentity: transaction.setIdentity } }, context);
      const applied = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!applied || applied.objectIdentity !== transaction.setIdentity || applied.tempo !== transaction.proposedTempo) throw new Error("Live did not confirm the requested exact Set tempo");
      transaction.appliedTempo = applied.tempo; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: applied.tempo, epoch: transaction.epoch, idempotent: false });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (transaction.state === "applying") { transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain"; if (transaction.state === "previewed") delete transaction.applyKey; }
      return this.adapterToolError(id, cause, "Tempo apply may be uncertain; perform fresh authoritative discovery and do not retry blindly.");
    }
  }

  private beginUndoRecovery(record: object, idempotencyKey: string): { reconciliation: boolean; steps: Array<{ operation: LiveInvocation["operation"]; args: Record<string, unknown>; completed: boolean; result?: unknown }> } {
    const state = (record as { state?: string }).state; const reconciliation = state === "uncertain";
    let plan = this.undoRecoveryPlans.get(record);
    if (plan && plan.idempotencyKey !== idempotencyKey) throw new Error("uncertain undo requires the exact original idempotency key");
    if (!plan) { plan = { idempotencyKey, steps: [] }; this.undoRecoveryPlans.set(record, plan); }
    return { reconciliation, steps: plan.steps };
  }

  private async replayUndoRecovery(record: object, adapter: AsyncLiveAdapter, context: LiveOperationContext): Promise<void> {
    const plan = this.undoRecoveryPlans.get(record); if (!plan) return;
    for (const step of plan.steps) if (!step.completed) { step.result = await adapter.invokeAsync({ operation: step.operation, args: step.args }, context); step.completed = true; }
  }

  private async invokeUndoRecovery(record: object, adapter: AsyncLiveAdapter, operation: LiveInvocation["operation"], args: Record<string, unknown>, context: LiveOperationContext): Promise<unknown> {
    const plan = this.undoRecoveryPlans.get(record); if (!plan) throw new Error("undo recovery plan was not initialized");
    const existing = plan.steps.find((step) => step.operation === operation && canonicalMutationIdentity(step.args) === canonicalMutationIdentity(args));
    if (existing) { if (!existing.completed) { existing.result = await adapter.invokeAsync({ operation: existing.operation, args: existing.args }, context); existing.completed = true; } return existing.result; }
    const step = { operation, args: structuredClone(args), completed: false, result: undefined as unknown }; plan.steps.push(step);
    step.result = await adapter.invokeAsync({ operation, args: step.args }, context); step.completed = true; return step.result;
  }

  private async liveRecoveryFinalizeAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "resolution", "confirmation", "evidence"]) || !isNonEmptyString(params.transactionId, 128) || !["manually-restored", "accepted-current-state"].includes(String(params.resolution)) || params.confirmation !== "finalize-recovery-record" || !isObject(params.evidence) || !hasOnly(params.evidence, ["provenance", "observedAt", "scope"]) || !isNonEmptyString(params.evidence.provenance, 512) || !isNonEmptyString(params.evidence.scope, 256) || (params.evidence.observedAt !== undefined && !isNonEmptyString(params.evidence.observedAt, 64))) return this.recoveryFinalizeError(id, "Invalid recovery-finalization arguments.");
    const transactionId = params.transactionId;
    if (this.recoveryFinalizationInFlight) return this.recoveryFinalizeError(id, "Another recovery finalization safety barrier is in progress.");
    if (this.activeAsyncOperations > 0 || IN_FLIGHT_TRANSACTION_IDS.size > 0) return this.recoveryFinalizeError(id, "Another asynchronous operation, mutation, or reconciliation is in flight; global safety finalization refused.");
    this.recoveryFinalizationInFlight = true; IN_FLIGHT_TRANSACTION_IDS.add(transactionId);
    try {
      const maps = [this.transactions, this.arrangementTransactions, this.sessionStructureTransactions, this.deviceParameterTransactions, this.auditionTransactions, this.transportTransactions, this.clipLaunchTransactions, this.noteEditTransactions, this.clipLifecycleTransactions, this.audioCaptureTransactions] as unknown as Array<Map<string, { state: string; kind?: string; epoch: number }>>;
      const owner = maps.find((candidate) => candidate.has(transactionId)); const midiFinalizable = !owner && this.midiTransactions.isFinalizable(transactionId);
      if (!owner && !midiFinalizable) return this.recoveryFinalizeError(id, "Recovery transaction was not found or is not finalizable.");
      const retireRemote = async (): Promise<boolean> => { const retire = (this.adapter as Partial<{ retireTransactionAsync(transactionId: string, context?: LiveOperationContext, terminal?: boolean): Promise<unknown> }>).retireTransactionAsync; if (typeof retire !== "function") return true; try { await retire.call(this.adapter, transactionId, { deadlineMs: Date.now() + 5_000 }, true); return true; } catch { return false; } };
      const adapter = this.asyncAdapter(); const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }); const safetySnapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }); const transport = safetySnapshot.playback?.transport;
      if (!transport || transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || safetySnapshot.playback.playingTargets.length > 0 || safetySnapshot.playback.firedTargets.length > 0) return this.recoveryFinalizeError(id, "Recovery finalization requires authoritative stopped playback and recording with no active Session targets.");
      if (status.operations?.includes("realtime.stats")) { const realtime = await adapter.invokeAsync({ operation: "realtime.stats", args: {} }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { armed?: unknown; pending?: unknown }; if (realtime.armed !== false || realtime.pending !== 0) return this.recoveryFinalizeError(id, "Recovery finalization requires realtime authority to be disarmed with no pending writes."); }
      if (midiFinalizable) {
        if (!await retireRemote()) return this.recoveryFinalizeError(id, "Remote replay authority could not be retired; finalization refused.");
        const finalized = this.midiTransactions.finalize(transactionId); return this.successText(id, { ...finalized, resolution: params.resolution, evidence: params.evidence, liveMutated: false, recoveryAuthorityRetired: true });
      }
      const record = owner!.get(transactionId)!; const audioOwner = owner === (this.audioCaptureTransactions as unknown as Map<string, { state: string; epoch: number }>);
      if (audioOwner ? record.state !== "uncertain" : (!["uncertain", "applied", "undone"].includes(record.state) || ACTIVE_TRANSACTION_STATES.has(record.state))) return this.recoveryFinalizeError(id, "Active or unresolved transaction work cannot be finalized.");
      if (audioOwner) { const captureRecord = record as unknown as AudioCaptureTransaction; const observed = await this.captureMapperStatus(adapter); if (observed.captureId !== captureRecord.captureId || observed.sourceSlotRef !== captureRecord.sourceSlotRef || observed.destinationSlotRef !== captureRecord.destinationSlotRef || observed.state !== "cleaned" || observed.active !== false || observed.playbackStopped !== true || isObject(observed.clip) || (Array.isArray(observed.residual) && observed.residual.length > 0)) return this.recoveryFinalizeError(id, "Audio-capture finalization requires exact mapper-cleaned identity and no residual clip."); }
      if (record.kind === "realtime-arm" && record.state !== "undone" && status.epoch === record.epoch) return this.recoveryFinalizeError(id, "Realtime recovery must be reconciled or disarmed while the original Live epoch remains active.");
      if (!await retireRemote()) return this.recoveryFinalizeError(id, "Remote replay authority could not be retired; finalization refused.");
      owner!.delete(transactionId);
      return this.successText(id, { transactionId, finalized: true, priorState: record.state, resolution: params.resolution, evidence: params.evidence, liveMutated: false, recoveryAuthorityRetired: true });
    } finally { IN_FLIGHT_TRANSACTION_IDS.delete(transactionId); this.recoveryFinalizationInFlight = false; }
  }

  private async liveUndoAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "undo")) return error(id, -32602, "transactionId, confirmation=undo, and idempotencyKey are required");
    const undoOwnerTool = this.transactionOwnerTool(String(params.transactionId));
    if (undoOwnerTool !== undefined && !this.policyAllowsTool(undoOwnerTool)) return this.transactionError(id, "The current deployment policy no longer allows this transaction's tool domain; reconcile manually or restore the policy before undo.");
    const transaction = this.transactions.get(params.transactionId as string);
    if (!transaction && String(params.transactionId).startsWith("midi_")) return this.successText(id, await this.midiTransactions.undoAsync(params.transactionId as string, params.confirmation, params.idempotencyKey as string, { signal, deadlineMs: Date.now() + SESSION_MIDI_TRANSACTION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }));
    if (!transaction && String(params.transactionId).startsWith("transport_")) {
      const transport = this.transportTransactions.get(params.transactionId as string);
      if (!transport) return this.transactionError(id, "Unknown or expired transport transaction");
      return this.liveTransportUndoAsync(id, transport, params as Record<string, unknown>, signal);
    }
    if (!transaction && (String(params.transactionId).startsWith("noteupdate_") || String(params.transactionId).startsWith("notedelete_"))) {
      const noteEdit = this.noteEditTransactions.get(params.transactionId as string);
      if (!noteEdit) return this.transactionError(id, "Unknown or expired note-edit transaction");
      return this.liveNoteEditUndoAsync(id, noteEdit, params as Record<string, unknown>, signal);
    }
    if (!transaction && (String(params.transactionId).startsWith("capturemidi_") || String(params.transactionId).startsWith("scenecapture_"))) {
      const capture = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!capture || !["capture-midi", "scene-capture"].includes(capture.kind)) return this.transactionError(id, "Unknown capture transaction");
      if (capture.state === "undone" && capture.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: capture.id, state: "undone", idempotent: true });
      const reconciliation = capture.state === "uncertain" && capture.undoKey === params.idempotencyKey;
      if (capture.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain capture transaction can be undone");
      try {
        this.beginUndoRecovery(capture, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== capture.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; capture.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(capture, adapter, context); let snapshot = await adapter.snapshotAsync(context);
        capture.state = "undoing";
        if (capture.kind === "capture-midi") {
          const clips = Array.isArray(capture.created?.clips) ? capture.created.clips.filter(isObject) : []; const current = new Map(snapshot.tracks.flatMap((track) => track.clips.map((clip) => [clip.ref, clip] as const)));
          for (const owned of clips) { const clip = typeof owned.ref === "string" ? current.get(owned.ref as LiveRef) : undefined; if (clip && (!isNonEmptyString(owned.objectIdentity, 256) || owned.fingerprint !== this.captureObjectFingerprint(clip))) throw new Error("captured MIDI clip identity or content changed before undo"); }
          for (const owned of clips) if (typeof owned.ref === "string" && isNonEmptyString(owned.objectIdentity, 256)) await this.deleteOwnedClipAsync(adapter, owned.ref as LiveRef, owned.objectIdentity, context, owned.fingerprint as string, capture, true);
          const after = await adapter.snapshotAsync(context); const remaining = new Set(after.tracks.flatMap((track) => track.clips.map((clip) => clip.ref))); if (clips.some((owned) => typeof owned.ref === "string" && remaining.has(owned.ref as LiveRef))) throw new Error("captured MIDI clip deletion was not confirmed");
        } else {
          const sceneRef = capture.created?.sceneRef; const scene = typeof sceneRef === "string" ? snapshot.scenes.find((row) => row.ref === sceneRef) : undefined;
          if (scene) { if (!isNonEmptyString(capture.created?.objectIdentity, 256) || capture.created?.fingerprint !== this.sessionStructureCreatedFingerprint(snapshot, "scene", sceneRef as LiveRef)) throw new Error("captured scene identity or content changed before undo"); await this.invokeUndoRecovery(capture, adapter, "scene.delete", { ref: sceneRef, expectedStructureRevision: this.structureRevision(snapshot), expectedObjectIdentity: capture.created.objectIdentity }, context); }
          if (typeof sceneRef === "string" && (await adapter.snapshotAsync(context)).scenes.some((candidate) => candidate.ref === sceneRef)) throw new Error("captured scene deletion was not confirmed");
        }
        capture.state = "undone";
        return this.successText(id, { transactionId: capture.id, state: "undone", idempotent: false });
      } catch (cause) { capture.state = "uncertain"; return this.adapterToolError(id, cause, "Capture undo is uncertain; perform fresh Session discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("clipdup_")) {
      const duplicate = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!duplicate || duplicate.kind !== "duplicate") return this.transactionError(id, "Unknown clip-duplicate transaction");
      if (duplicate.state === "undone" && duplicate.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: duplicate.id, state: "undone", idempotent: true });
      const reconciliation = duplicate.state === "uncertain" && duplicate.undoKey === params.idempotencyKey;
      if ((duplicate.state !== "applied" && !reconciliation) || !isNonEmptyString(duplicate.created?.ref, 256) || !isNonEmptyString(duplicate.created?.objectIdentity, 256)) return this.transactionError(id, "Only an applied or exact-key uncertain identity-bound clip duplicate can be undone");
      try {
        this.beginUndoRecovery(duplicate, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== duplicate.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; duplicate.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(duplicate, adapter, context); duplicate.state = "undoing";
        await this.deleteOwnedClipAsync(adapter, duplicate.created.ref as LiveRef, duplicate.created.objectIdentity as string, context, duplicate.created.fingerprint as string, duplicate, reconciliation);
        duplicate.state = "undone"; return this.successText(id, { transactionId: duplicate.id, state: "undone", deleted: duplicate.created.ref, idempotent: false });
      } catch (cause) { duplicate.state = "uncertain"; return this.adapterToolError(id, cause, "Clip-duplicate undo is uncertain; inspect the exact destination."); }
    }
    if (!transaction && String(params.transactionId).startsWith("arrclip_")) {
      const arrangementClip = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (arrangementClip && arrangementClip.kind === "arrangement-take-lane-create") return this.transactionError(id, "The public LOM exposes no take-lane clip deletion; undo is unavailable for this transaction");
      if (!arrangementClip || !["arrangement-create", "arrangement-audio-create"].includes(arrangementClip.kind)) return this.transactionError(id, "Only an applied Arrangement clip creation has automatic undo authority");
      if (arrangementClip.state === "undone" && arrangementClip.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: arrangementClip.id, state: "undone", idempotent: true });
      const reconciliation = arrangementClip.state === "uncertain" && arrangementClip.undoKey === params.idempotencyKey;
      if ((arrangementClip.state !== "applied" && !reconciliation) || !isNonEmptyString(arrangementClip.created?.ref, 256) || !isNonEmptyString(arrangementClip.created?.objectIdentity, 256)) return this.transactionError(id, "Arrangement clip creation lacks exact undo identity");
      try {
        this.beginUndoRecovery(arrangementClip, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== arrangementClip.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; arrangementClip.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(arrangementClip, adapter, context); arrangementClip.state = "undoing";
        await this.deleteOwnedClipAsync(adapter, arrangementClip.created.ref as LiveRef, arrangementClip.created.objectIdentity as string, context, arrangementClip.created.fingerprint as string, arrangementClip, reconciliation);
        arrangementClip.state = "undone"; return this.successText(id, { transactionId: arrangementClip.id, state: "undone", idempotent: false });
      } catch (cause) { arrangementClip.state = "uncertain"; return this.adapterToolError(id, cause, "Arrangement clip undo is uncertain; inspect the exact created clip."); }
    }
    if (!transaction && String(params.transactionId).startsWith("clipmove_")) {
      const move = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!move || move.kind !== "move") return this.transactionError(id, "Unknown clip-move transaction");
      if (move.state === "undone" && move.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: move.id, state: "undone", idempotent: true });
      const reconciliation = move.state === "uncertain" && move.undoKey === params.idempotencyKey;
      if ((move.state !== "applied" && !reconciliation) || !isNonEmptyString(move.created?.ref, 256) || !isNonEmptyString(move.created?.objectIdentity, 256) || !isNonEmptyString(move.created?.fingerprint, 64)) return this.transactionError(id, "Clip move lacks exact applied identity and content fingerprint");
      try {
        const plan = this.beginUndoRecovery(move, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== move.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; move.undoKey = params.idempotencyKey as string; move.payload.appliedRef ??= move.created.ref; if (reconciliation) await this.replayUndoRecovery(move, adapter, context); move.state = "undoing";
        if (move.payload.position !== undefined) {
          let result: JsonObject;
          if (reconciliation) { const replayed = plan.steps.at(-1)?.result; if (!isObject(replayed)) throw new Error("Arrangement clip move replay result is unavailable"); result = replayed; }
          else { const currentSnapshot = await adapter.snapshotAsync(context); const current = this.clipRow(currentSnapshot, move.created.ref as LiveRef); if (!current.arrangement || current.clip.objectIdentity !== move.created.objectIdentity || current.clip.start !== move.payload.position || this.captureObjectFingerprint(current.clip) !== move.created.fingerprint) throw new Error("Arrangement clip identity, position, or content changed after apply; undo refused"); result = await this.invokeUndoRecovery(move, adapter, "arrangement.clip.move", { ref: move.created.ref, position: move.payload.priorPosition, ...this.arrangementClipAuthority(currentSnapshot, move.created.ref as LiveRef), expectedContentFingerprint: move.created.fingerprint }, context) as JsonObject; }
          if (!isNonEmptyString(result.ref, 256) || !isNonEmptyString(result.objectIdentity, 256) || result.start !== move.payload.priorPosition) throw new Error("Arrangement clip move restoration was not confirmed"); const restoredRow = this.clipRow(await adapter.snapshotAsync(context), result.ref as LiveRef); if (restoredRow.clip.objectIdentity !== result.objectIdentity || restoredRow.clip.start !== move.payload.priorPosition) throw new Error("Arrangement clip move prior location was not verified"); move.created = result;
        } else {
          let restored: JsonObject;
          if (reconciliation) { const replayed = plan.steps.at(-1)?.result; if (!isObject(replayed)) throw new Error("Session clip move replay result is unavailable"); restored = replayed; }
          else { const currentSnapshot = await adapter.snapshotAsync(context); const currentRow = this.clipRow(currentSnapshot, move.created.ref as LiveRef); if (currentRow.clip.objectIdentity !== move.created.objectIdentity || this.captureObjectFingerprint(currentRow.clip) !== move.created.fingerprint) throw new Error("Session clip identity or content changed after apply; undo refused"); const currentAuthority = this.clipAuthority(currentSnapshot, move.created.ref as LiveRef); const original = move.payload.deleteAuthority as JsonObject; restored = await this.invokeUndoRecovery(move, adapter, "clip.move", { ref: move.created.ref, targetTrackRef: original.expectedTrackRef, targetSceneIndex: move.payload.sourceSceneIndex, arrangementPosition: null, ...currentAuthority, expectedContentFingerprint: move.created.fingerprint, expectedTargetTrackIdentity: original.expectedTrackIdentity, expectedTargetSlotRef: original.expectedSlotRef, expectedTargetSlotIdentity: original.expectedSlotIdentity, expectedTargetSceneRef: original.expectedSceneRef, expectedTargetSceneIdentity: original.expectedSceneIdentity, expectedTargetCollectionRevision: null }, context) as JsonObject; }
          if (!isNonEmptyString(restored.ref, 256) || !isNonEmptyString(restored.objectIdentity, 256)) throw new Error("Session clip move restoration did not return exact identity"); const restoredSnapshot = await adapter.snapshotAsync(context); const restoredRow = this.clipRow(restoredSnapshot, restored.ref as LiveRef); if (restoredRow.clip.objectIdentity !== restored.objectIdentity) throw new Error("Session clip restoration identity changed"); try { this.clipRow(restoredSnapshot, move.payload.appliedRef as LiveRef); throw new Error("moved destination remains after restoration"); } catch (cause) { if (cause instanceof Error && cause.message === "moved destination remains after restoration") throw cause; } move.created = restored;
        }
        move.state = "undone"; return this.successText(id, { transactionId: move.id, state: "undone", restored: move.created, idempotent: false });
      } catch (cause) { move.state = "uncertain"; return this.adapterToolError(id, cause, "Clip-move undo is uncertain; inspect both source and destination slots."); }
    }
    if (!transaction && String(params.transactionId).startsWith("audioimport_")) {
      const audioImport = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (audioImport && audioImport.kind === "session-audio-create" && audioImport.payload.takeLaneRef !== undefined) return this.transactionError(id, "The public LOM exposes no take-lane clip deletion; undo is unavailable for this transaction");
      if (!audioImport || audioImport.kind !== "session-audio-create") return this.transactionError(id, "Only an applied Session audio import has automatic undo authority");
      if (audioImport.state === "undone" && audioImport.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: audioImport.id, state: "undone", idempotent: true });
      const reconciliation = audioImport.state === "uncertain" && audioImport.undoKey === params.idempotencyKey;
      if ((audioImport.state !== "applied" && !reconciliation) || !isNonEmptyString(audioImport.created?.ref, 256) || !isNonEmptyString(audioImport.created?.objectIdentity, 256)) return this.transactionError(id, "Session audio import lacks exact undo identity");
      try {
        this.beginUndoRecovery(audioImport, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== audioImport.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; audioImport.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(audioImport, adapter, context); audioImport.state = "undoing";
        await this.deleteOwnedClipAsync(adapter, audioImport.created.ref as LiveRef, audioImport.created.objectIdentity as string, context, audioImport.created.createdFingerprint as string, audioImport, reconciliation);
        this.releaseStagedImportFile(audioImport.payload.filePath);
        audioImport.state = "undone"; return this.successText(id, { transactionId: audioImport.id, state: "undone", deleted: audioImport.created.ref, idempotent: false });
      } catch (cause) { audioImport.state = "uncertain"; return this.adapterToolError(id, cause, "Audio-import undo is uncertain; inspect the exact created clip."); }
    }
    if (!transaction && String(params.transactionId).startsWith("warp_")) {
      const warp = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!warp || warp.kind !== "warp-marker") return this.transactionError(id, "Unknown or expired warp-marker transaction");
      if (warp.state === "undone" && warp.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: warp.id, state: "undone", idempotent: true });
      const reconciliation = warp.state === "uncertain" && warp.undoKey === params.idempotencyKey;
      if ((warp.state !== "applied" && !reconciliation) || !warp.clipRef) return this.transactionError(id, "Only an applied or exact-key uncertain warp-marker transaction can be undone");
      try {
        this.beginUndoRecovery(warp, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== warp.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; warp.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(warp, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const read = await adapter.invokeAsync({ operation: "audio.warp-marker.read", args: { ref: warp.clipRef } }, context) as { markers?: Array<{ beatTime: number; sampleTime: number }> };
        const action = warp.payload.action as string;
        const inverse = action === "add" ? { operation: "audio.warp-marker.delete", args: { ref: warp.clipRef, beatTime: warp.payload.beatTime } } : action === "delete" ? { operation: "audio.warp-marker.add", args: { ref: warp.clipRef, beatTime: warp.payload.beatTime } } : { operation: "audio.warp-marker.move", args: { ref: warp.clipRef, beatTime: (warp.payload.beatTime as number) + (warp.payload.distance as number), distance: -(warp.payload.distance as number) } };
        const priorMarkers = (warp.prior as { markers: Array<{ beatTime: number }> }).markers;
        if (!reconciliation) {
          const actionBeats = action === "add" ? new Set([...priorMarkers.map((marker) => marker.beatTime), warp.payload.beatTime as number]) : action === "delete" ? new Set(priorMarkers.map((marker) => marker.beatTime).filter((beat) => beat !== warp.payload.beatTime)) : new Set(priorMarkers.map((marker) => marker.beatTime).filter((beat) => beat !== warp.payload.beatTime).concat([(warp.payload.beatTime as number) + (warp.payload.distance as number)]));
          const currentBeats = new Set((read.markers ?? []).map((marker) => marker.beatTime));
          if (currentBeats.size !== actionBeats.size || [...actionBeats].some((beat) => !currentBeats.has(beat))) return this.transactionError(id, "warp markers changed after apply; undo refused");
        }
        warp.state = "undoing";
        const inverseArgs = { ...inverse.args, expectedClipAuthorityDigest: this.clipAuthorityDigest(snapshot, warp.clipRef), expectedMarkerCollectionRevision: this.warpMarkerCollectionRevision(read.markers ?? []) };
        const result = await this.invokeUndoRecovery(warp, adapter, inverse.operation as "audio.warp-marker.add" | "audio.warp-marker.move" | "audio.warp-marker.delete", inverseArgs, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("warp-marker undo was not confirmed");
        const restored = await adapter.invokeAsync({ operation: "audio.warp-marker.read", args: { ref: warp.clipRef } }, context) as { markers?: Array<{ beatTime: number; sampleTime: number }> };
        const priorBeats = new Set(priorMarkers.map((marker) => marker.beatTime)); const restoredBeats = new Set((restored.markers ?? []).map((marker) => marker.beatTime));
        if (restoredBeats.size !== priorBeats.size || [...priorBeats].some((beat) => !restoredBeats.has(beat))) throw new Error("warp-marker undo did not restore the exact prior collection");
        warp.state = "undone"; return this.successText(id, { transactionId: warp.id, state: "undone", idempotent: false });
      } catch (cause) { warp.state = "uncertain"; return this.adapterToolError(id, cause, "Warp-marker undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("noteedit_")) {
      const noteTarget = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!noteTarget || noteTarget.kind !== "note-target") return this.transactionError(id, "Unknown or expired note-edit transaction");
      if (noteTarget.state === "undone" && noteTarget.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: noteTarget.id, state: "undone", idempotent: true });
      const reconciliation = noteTarget.state === "uncertain" && noteTarget.undoKey === params.idempotencyKey;
      if ((noteTarget.state !== "applied" && !reconciliation) || !noteTarget.clipRef) return this.transactionError(id, "Only an applied or exact-key uncertain note-edit transaction can be undone");
      try {
        this.beginUndoRecovery(noteTarget, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== noteTarget.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; noteTarget.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(noteTarget, adapter, context);
        const current = this.noteClip(await adapter.snapshotAsync(context), noteTarget.clipRef);
        const prior = (noteTarget.prior as { notes: Array<Record<string, unknown>> }).notes;
        const action = noteTarget.payload.action as string;
        if (action === "duplicate") {
          const createdIds = (noteTarget.created?.duplicatedIds as number[] | undefined) ?? [];
          if (createdIds.length < 1) return this.transactionError(id, "note duplication lacks exact created identity");
          const priorIds = new Set(prior.map((note) => note.id));
          if (current.notes.some((note) => !priorIds.has(note.id) && !createdIds.includes(note.id as number))) return this.transactionError(id, "notes changed after apply; undo refused");
          noteTarget.state = "undoing";
          const result = await this.invokeUndoRecovery(noteTarget, adapter, "note.delete", { ref: noteTarget.clipRef, noteIds: createdIds, expectedClipAuthority: current.authority, expectedNotesRevision: current.notesRevision }, context) as { deleted?: unknown };
          if (result.deleted !== createdIds.length) throw new Error("note duplication undo did not delete the exact created batch");
          const verified = this.noteClip(await adapter.snapshotAsync(context), noteTarget.clipRef);
          if (this.noteContentFence(verified.notes) !== this.noteContentFence(prior)) throw new Error("note duplication undo did not restore exact prior content");
        } else {
          const currentIds = new Set(current.notes.map((note) => note.id));
          if (currentIds.size !== prior.length || prior.some((note) => !currentIds.has(note.id))) return this.transactionError(id, "notes changed after apply; undo refused");
          noteTarget.state = "undoing";
          const restore = prior.map((note) => ({ id: note.id, pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 }));
          await this.invokeUndoRecovery(noteTarget, adapter, "note.update", { ref: noteTarget.clipRef, notes: restore, expectedClipAuthority: current.authority, expectedNotesRevision: current.notesRevision }, context);
          const verified = this.noteClip(await adapter.snapshotAsync(context), noteTarget.clipRef);
          if (this.noteFence(verified.notes) !== this.noteFence(prior)) throw new Error("quantization undo did not restore exact prior notes");
        }
        noteTarget.state = "undone"; return this.successText(id, { transactionId: noteTarget.id, state: "undone", idempotent: false });
      } catch (cause) { noteTarget.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("miditransform_")) {
      const transform = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!transform || transform.kind !== "midi-transform") return this.transactionError(id, "Unknown or expired MIDI-transform transaction");
      if (transform.state === "undone" && transform.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transform.id, state: "undone", idempotent: true });
      const reconciliation = transform.state === "uncertain" && transform.undoKey === params.idempotencyKey;
      if ((transform.state !== "applied" && !reconciliation) || !transform.clipRef) return this.transactionError(id, "Only an applied or exact-key uncertain MIDI-transform transaction can be undone");
      try {
        const status = this.requireConnected("session.read"); if (status.epoch !== transform.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
        // Refusal-only checks run before any state change: a refused undo keeps
        // the record applied so the operator can retry after restoring the
        // transformed state (never wedged in an active state).
        const prior = (transform.prior as { notes: Array<Record<string, unknown>> }).notes;
        if (transform.payload.scope === "duplicate") {
          if (!isNonEmptyString(transform.created?.ref, 256) || !isNonEmptyString(transform.created?.objectIdentity, 256)) return this.transactionError(id, "Duplicate-scope transform lacks exact created identity");
          this.beginUndoRecovery(transform, params.idempotencyKey as string); transform.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(transform, adapter, context);
          transform.state = "undoing";
          await this.deleteOwnedClipAsync(adapter, transform.created.ref as LiveRef, transform.created.objectIdentity as string, context, typeof transform.created.fingerprint === "string" ? transform.created.fingerprint : undefined, transform, reconciliation);
        } else {
          if (!reconciliation) {
            const current = this.noteClip(await adapter.snapshotAsync(context), transform.clipRef);
            const currentIds = new Set(current.notes.map((note) => note.id));
            if (currentIds.size !== prior.length || prior.some((note) => !currentIds.has(note.id))) return this.transactionError(id, "notes changed after apply; undo refused");
            // The exact verified post-transform state (identity-bound) must
            // still hold: an external edit must never be overwritten by
            // preview-time values, including a content swap between notes.
            if (noteIdentityDigest(current.notes) !== transform.payload.expectedResultIdentity) return this.transactionError(id, "notes changed after apply; undo refused");
          }
          this.beginUndoRecovery(transform, params.idempotencyKey as string); transform.undoKey = params.idempotencyKey as string;
          transform.state = "undoing";
          const priorById = new Map(prior.map((note) => [note.id, note]));
          const updatedRows = ((transform.payload.diff as { update?: Array<Record<string, unknown>> }).update ?? []);
          const appliedNotes = prior.map((note) => { const row = updatedRows.find((candidate) => candidate.id === note.id); return row !== undefined ? { ...note, ...row } : note; });
          const restoreRows = updatedRows.map((row) => priorById.get(row.id)).filter((note): note is Record<string, unknown> => note !== undefined).map((note) => this.midiTransformPatch(note));
          const steps: Array<{ operation: "note.update"; items: Array<Record<string, unknown>> }> = [];
          for (let offset = 0; offset < restoreRows.length; offset += 256) steps.push({ operation: "note.update", items: restoreRows.slice(offset, offset + 256) });
          await this.executeNotePlan(transform, adapter, context, transform.clipRef!, steps, appliedNotes, true);
          const verified = this.noteClip(await adapter.snapshotAsync(context), transform.clipRef);
          if (noteIdentityDigest(verified.notes) !== noteIdentityDigest(prior)) throw new Error("MIDI-transform undo did not restore exact prior notes");
        }
        transform.state = "undone"; return this.successText(id, { transactionId: transform.id, state: "undone", idempotent: false });
      } catch (cause) { transform.state = "uncertain"; return this.adapterToolError(id, cause, "MIDI-transform undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("sceneset_")) {
      const sceneset = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!sceneset || sceneset.kind !== "scene-set") return this.transactionError(id, "Unknown or expired scene transaction");
      if (sceneset.state === "undone" && sceneset.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: sceneset.id, state: "undone", idempotent: true });
      const reconciliation = sceneset.state === "uncertain" && sceneset.undoKey === params.idempotencyKey;
      if ((sceneset.state !== "applied" && !reconciliation) || !sceneset.prior) return this.transactionError(id, "Only an applied or exact-key uncertain scene transaction can be undone");
      try {
        this.beginUndoRecovery(sceneset, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== sceneset.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; sceneset.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(sceneset, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const scene = (snapshot.scenes as unknown as JsonObject[]).find((candidate) => candidate.ref === sceneset.payload.ref);
        if (!scene || !isNonEmptyString(scene.objectIdentity, 256)) throw new Error("scene identity is unavailable");
        if (!reconciliation) { for (const [field, value] of Object.entries(sceneset.payload)) { if (["ref", "expectedObjectIdentity", "expectedAuthorityRevision", "expectedStateRevision"].includes(field)) continue; if (scene[field] !== value) return this.transactionError(id, "scene changed after apply; undo refused"); } }
        sceneset.state = "undoing";
        const result = await this.invokeUndoRecovery(sceneset, adapter, "scene.set", { ref: sceneset.payload.ref, ...(sceneset.prior as Record<string, unknown>), expectedObjectIdentity: scene.objectIdentity, expectedAuthorityRevision: this.sceneCollectionRevision(snapshot), expectedStateRevision: this.sceneStateRevision(scene) }, context) as JsonObject;
        if (result.changed !== true) throw new Error("scene restoration was not confirmed");
        const restored = (await adapter.snapshotAsync(context)).scenes.find((candidate) => candidate.ref === sceneset.payload.ref);
        if (!restored) throw new Error("scene disappeared after undo");
        for (const [field, value] of Object.entries(sceneset.prior)) if ((restored as unknown as JsonObject)[field] !== value) throw new Error("scene exact prior state was not restored");
        sceneset.state = "undone"; return this.successText(id, { transactionId: sceneset.id, state: "undone", idempotent: false });
      } catch (cause) { sceneset.state = "uncertain"; return this.adapterToolError(id, cause, "Scene undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("trackset_")) {
      const trackset = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!trackset || trackset.kind !== "track-set") return this.transactionError(id, "Unknown or expired track-properties transaction");
      if (trackset.state === "undone" && trackset.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: trackset.id, state: "undone", idempotent: true });
      const reconciliation = trackset.state === "uncertain" && trackset.undoKey === params.idempotencyKey;
      if ((trackset.state !== "applied" && !reconciliation) || !trackset.prior) return this.transactionError(id, "Only an applied or exact-key uncertain track-properties transaction can be undone");
      try {
        this.beginUndoRecovery(trackset, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== trackset.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; trackset.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(trackset, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === trackset.payload.ref);
        if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is unavailable");
        if (!reconciliation && (track.colorIndex ?? null) !== trackset.payload.colorIndex) return this.transactionError(id, "track changed after apply; undo refused");
        trackset.state = "undoing";
        const result = await this.invokeUndoRecovery(trackset, adapter, "track.set", { ref: trackset.payload.ref, ...(trackset.prior as Record<string, unknown>), expectedObjectIdentity: track.objectIdentity, expectedStateRevision: this.trackPropertiesStateRevision(track) }, context) as JsonObject;
        if (result.changed !== true) throw new Error("track restoration was not confirmed");
        const restored = ((await adapter.snapshotAsync(context)).tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === trackset.payload.ref);
        if (!restored) throw new Error("track disappeared after undo");
        for (const [field, value] of Object.entries(trackset.prior)) if ((restored as unknown as JsonObject)[field] !== value) throw new Error("track exact prior state was not restored");
        trackset.state = "undone"; return this.successText(id, { transactionId: trackset.id, state: "undone", idempotent: false });
      } catch (cause) { trackset.state = "uncertain"; return this.adapterToolError(id, cause, "Track-properties undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("songset_")) {
      const songset = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!songset || songset.kind !== "song-set") return this.transactionError(id, "Unknown or expired song-settings transaction");
      if (songset.state === "undone" && songset.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: songset.id, state: "undone", idempotent: true });
      const reconciliation = songset.state === "uncertain" && songset.undoKey === params.idempotencyKey;
      if ((songset.state !== "applied" && !reconciliation) || !songset.prior) return this.transactionError(id, "Only an applied or exact-key uncertain song-settings transaction can be undone");
      try {
        this.beginUndoRecovery(songset, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== songset.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; songset.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(songset, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const rawSong = await adapter.invokeAsync({ operation: "song.read", args: { setRef: snapshot.set.ref } }, context) as JsonObject; const song = this.songSettingsFields(rawSong);
        if (!reconciliation) { for (const [field, value] of Object.entries(songset.payload)) { if (field === "expectedStateRevision") continue; if (song[field] !== value) return this.transactionError(id, "song settings changed after apply; undo refused"); } }
        songset.state = "undoing";
        const result = await this.invokeUndoRecovery(songset, adapter, "song.set", { ...(songset.prior as Record<string, unknown>), expectedStateRevision: this.songSettingsRevision(rawSong) }, context) as JsonObject;
        if (result.changed !== true) throw new Error("song settings restoration was not confirmed");
        const restored = this.songSettingsFields(await adapter.invokeAsync({ operation: "song.read", args: { setRef: snapshot.set.ref } }, context) as JsonObject);
        for (const [field, value] of Object.entries(songset.prior)) if (restored[field] !== value) throw new Error("song settings exact prior state was not restored");
        songset.state = "undone"; return this.successText(id, { transactionId: songset.id, state: "undone", idempotent: false });
      } catch (cause) { songset.state = "uncertain"; return this.adapterToolError(id, cause, "Song-settings undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("trackstruct_")) {
      const trackstruct = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!trackstruct || trackstruct.kind !== "track-structure") return this.transactionError(id, "Unknown or expired track-structure transaction");
      if (trackstruct.payload.action === "delete-return") return this.transactionError(id, "Deleted return tracks cannot be reconstructed; undo is unavailable for this transaction");
      if (trackstruct.state === "undone" && trackstruct.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: trackstruct.id, state: "undone", idempotent: true });
      const reconciliation = trackstruct.state === "uncertain" && trackstruct.undoKey === params.idempotencyKey;
      if ((trackstruct.state !== "applied" && !reconciliation) || !isNonEmptyString(trackstruct.created?.ref, 256) || !isNonEmptyString(trackstruct.created?.objectIdentity, 256)) return this.transactionError(id, "Only an applied track-structure creation has automatic undo authority");
      try {
        this.beginUndoRecovery(trackstruct, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== trackstruct.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; trackstruct.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(trackstruct, adapter, context); trackstruct.state = "undoing";
        const action = trackstruct.payload.action as string;
        const snapshot = await adapter.snapshotAsync(context);
        const structureRevision = this.structureRevision(snapshot);
        const currentFingerprint = this.sessionStructureCreatedFingerprint(snapshot, action === "duplicate-scene" ? "scene" : "track", trackstruct.created.ref as LiveRef);
        if (!reconciliation && currentFingerprint !== (trackstruct.created as unknown as { contentFingerprint?: unknown }).contentFingerprint) return this.transactionError(id, "created structure content changed after apply; cleanup refused");
        if (action === "create-return") {
          const result = await this.invokeUndoRecovery(trackstruct, adapter, "track.delete-return", { ref: trackstruct.created.ref, expectedObjectIdentity: trackstruct.created.objectIdentity, expectedStructureRevision: structureRevision }, context) as { deleted?: unknown };
          if (result.deleted !== trackstruct.created.ref) throw new Error("return-track cleanup was not confirmed");
        } else {
          const operation = action === "duplicate-track" ? "track.delete" : "scene.delete";
          const result = await this.invokeUndoRecovery(trackstruct, adapter, operation, { ref: trackstruct.created.ref, expectedObjectIdentity: trackstruct.created.objectIdentity, expectedStructureRevision: structureRevision }, context) as { deleted?: unknown };
          if (result.deleted !== trackstruct.created.ref) throw new Error("duplicated structure cleanup was not confirmed");
        }
        trackstruct.state = "undone"; return this.successText(id, { transactionId: trackstruct.id, state: "undone", idempotent: false });
      } catch (cause) { trackstruct.state = "uncertain"; return this.adapterToolError(id, cause, "Track-structure undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("trackview_")) {
      const trackview = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!trackview || trackview.kind !== "track-view") return this.transactionError(id, "Unknown or expired track-view transaction");
      if (trackview.state === "undone" && trackview.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: trackview.id, state: "undone", idempotent: true });
      const reconciliation = trackview.state === "uncertain" && trackview.undoKey === params.idempotencyKey;
      if ((trackview.state !== "applied" && !reconciliation) || !trackview.prior) return this.transactionError(id, "Only an applied or exact-key uncertain track-view transaction can be undone");
      if (trackview.payload.collapsed === undefined && trackview.payload.deviceInsertMode === undefined) return this.transactionError(id, "Instrument selection is momentary and not undoable");
      try {
        this.beginUndoRecovery(trackview, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== trackview.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; trackview.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(trackview, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === trackview.payload.ref);
        if (!track || !isNonEmptyString(track.objectIdentity, 256)) throw new Error("track identity is unavailable");
        if (!reconciliation) { const view = track.view as JsonObject | undefined;
          if (trackview.payload.collapsed !== undefined && view?.isCollapsed !== trackview.payload.collapsed) return this.transactionError(id, "track view changed after apply; undo refused");
          if (trackview.payload.deviceInsertMode !== undefined && view?.deviceInsertMode !== trackview.payload.deviceInsertMode) return this.transactionError(id, "track view changed after apply; undo refused"); }
        const prior = trackview.prior as { collapsed: boolean | null; deviceInsertMode: number | null };
        const stateRevision = createHash("sha256").update(canonicalMutationIdentity({ collapsed: (track.view as JsonObject | undefined)?.isCollapsed ?? null, deviceInsertMode: (track.view as JsonObject | undefined)?.deviceInsertMode ?? null })).digest("hex");
        trackview.state = "undoing";
        const args: Record<string, unknown> = { ref: trackview.payload.ref, expectedObjectIdentity: track.objectIdentity, expectedStateRevision: stateRevision };
        if (trackview.payload.collapsed !== undefined && typeof prior.collapsed === "boolean") args.collapsed = prior.collapsed;
        if (trackview.payload.deviceInsertMode !== undefined && typeof prior.deviceInsertMode === "number") args.deviceInsertMode = prior.deviceInsertMode;
        const result = await this.invokeUndoRecovery(trackview, adapter, "track.view.set", args, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("track view restoration was not confirmed");
        trackview.state = "undone"; return this.successText(id, { transactionId: trackview.id, state: "undone", idempotent: false });
      } catch (cause) { trackview.state = "uncertain"; return this.adapterToolError(id, cause, "Track-view undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("selection_")) {
      const selection = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!selection || selection.kind !== "selection") return this.transactionError(id, "Unknown or expired selection transaction");
      if (selection.state === "undone" && selection.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: selection.id, state: "undone", idempotent: true });
      const reconciliation = selection.state === "uncertain" && selection.undoKey === params.idempotencyKey;
      if ((selection.state !== "applied" && !reconciliation) || !selection.prior) return this.transactionError(id, "Only an applied or exact-key uncertain selection transaction can be undone");
      try {
        this.beginUndoRecovery(selection, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== selection.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; selection.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(selection, adapter, context);
        const snapshot = await adapter.snapshotAsync(context);
        if (!reconciliation) { for (const [field, value] of Object.entries(selection.payload)) { if (["expectedStateRevision", "drawMode"].includes(field)) continue; if (((snapshot.selection as Record<string, unknown> | undefined)?.[field] ?? null) !== value) return this.transactionError(id, "selection changed after apply; undo refused"); }
          if (selection.payload.drawMode !== undefined && snapshot.view?.drawMode !== selection.payload.drawMode) return this.transactionError(id, "draw mode changed after apply; undo refused"); }
        selection.state = "undoing";
        const priorFields = Object.fromEntries(Object.entries(selection.prior as Record<string, unknown>).filter(([key]) => key !== "drawMode"));
        const result = await this.invokeUndoRecovery(selection, adapter, "selection.set", { ...priorFields, expectedStateRevision: this.selectionRevision(snapshot) }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("selection restoration was not confirmed");
        if (selection.payload.drawMode !== undefined) {
          const currentMode = (await adapter.snapshotAsync(context)).view?.drawMode ?? null;
          const priorMode = (selection.prior as { drawMode?: unknown }).drawMode;
          const drawResult = await this.invokeUndoRecovery(selection, adapter, "song.view.set", { drawMode: priorMode, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ drawMode: currentMode })).digest("hex") }, context) as { changed?: unknown };
          if (drawResult.changed !== true) throw new Error("draw-mode restoration was not confirmed");
        }
        selection.state = "undone"; return this.successText(id, { transactionId: selection.id, state: "undone", idempotent: false });
      } catch (cause) { selection.state = "uncertain"; return this.adapterToolError(id, cause, "Selection undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("clipview_")) {
      const clipview = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!clipview || clipview.kind !== "clip-view") return this.transactionError(id, "Unknown or expired clip-view transaction");
      if (clipview.state === "undone" && clipview.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: clipview.id, state: "undone", idempotent: true });
      const reconciliation = clipview.state === "uncertain" && clipview.undoKey === params.idempotencyKey;
      if ((clipview.state !== "applied" && !reconciliation) || !clipview.clipRef || !clipview.prior) return this.transactionError(id, "Only an applied or exact-key uncertain clip-view transaction can be undone");
      if (clipview.payload.gridQuantization === undefined && clipview.payload.gridIsTriplet === undefined) return this.transactionError(id, "show-loop and envelope visibility are momentary and not undoable");
      try {
        this.beginUndoRecovery(clipview, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== clipview.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; clipview.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(clipview, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, clipview.clipRef);
        if (!reconciliation) { const view = row.clip.clipView as JsonObject | undefined;
          for (const field of ["gridQuantization", "gridIsTriplet"]) if (clipview.payload[field] !== undefined && view?.[field] !== clipview.payload[field]) return this.transactionError(id, "clip view changed after apply; undo refused"); }
        const viewState = { gridQuantization: (row.clip.clipView as JsonObject | undefined)?.gridQuantization ?? null, gridIsTriplet: (row.clip.clipView as JsonObject | undefined)?.gridIsTriplet ?? null };
        clipview.state = "undoing";
        const prior = clipview.prior as Record<string, unknown>;
        const args: Record<string, unknown> = { ref: clipview.clipRef, expectedObjectIdentity: row.clip.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(viewState)).digest("hex") };
        for (const field of ["gridQuantization", "gridIsTriplet"]) if (clipview.payload[field] !== undefined && prior[field] !== null && prior[field] !== undefined) args[field] = prior[field];
        const result = await this.invokeUndoRecovery(clipview, adapter, "clip.view.set", args, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("clip view restoration was not confirmed");
        clipview.state = "undone"; return this.successText(id, { transactionId: clipview.id, state: "undone", idempotent: false });
      } catch (cause) { clipview.state = "uncertain"; return this.adapterToolError(id, cause, "Clip-view undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("devview_")) {
      const devview = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!devview || devview.kind !== "device-view") return this.transactionError(id, "Unknown or expired device-view transaction");
      if (devview.state === "undone" && devview.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: devview.id, state: "undone", idempotent: true });
      const reconciliation = devview.state === "uncertain" && devview.undoKey === params.idempotencyKey;
      if ((devview.state !== "applied" && !reconciliation) || !devview.prior) return this.transactionError(id, "Only an applied or exact-key uncertain device-view transaction can be undone");
      try {
        this.beginUndoRecovery(devview, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== devview.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; devview.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(devview, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, devview.payload.ref as LiveRef);
        const current = (row.device.view as JsonObject | undefined)?.isCollapsed ?? null;
        if (!reconciliation && current !== devview.payload.collapsed) return this.transactionError(id, "device view changed after apply; undo refused");
        const prior = (devview.prior as { collapsed: boolean | null }).collapsed;
        if (typeof prior !== "boolean") return this.transactionError(id, "prior device view state is unavailable");
        devview.state = "undoing";
        const result = await this.invokeUndoRecovery(devview, adapter, "device.view.set", { ref: devview.payload.ref, collapsed: prior, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ collapsed: current })).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("device view restoration was not confirmed");
        devview.state = "undone"; return this.successText(id, { transactionId: devview.id, state: "undone", idempotent: false });
      } catch (cause) { devview.state = "uncertain"; return this.adapterToolError(id, cause, "Device-view undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("mixerext_")) {
      const mixerext = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!mixerext || mixerext.kind !== "mixer-extended") return this.transactionError(id, "Unknown or expired extended-mixer transaction");
      if (mixerext.state === "undone" && mixerext.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: mixerext.id, state: "undone", idempotent: true });
      const reconciliation = mixerext.state === "uncertain" && mixerext.undoKey === params.idempotencyKey;
      if ((mixerext.state !== "applied" && !reconciliation) || !mixerext.prior) return this.transactionError(id, "Only an applied or exact-key uncertain extended-mixer transaction can be undone");
      try {
        this.beginUndoRecovery(mixerext, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== mixerext.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; mixerext.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(mixerext, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === mixerext.clipRef); const mixer = track?.mixer as JsonObject | undefined;
        if (!track || !mixer || !isNonEmptyString(mixer.mixerIdentity as string, 256)) throw new Error("extended mixer authority is unavailable");
        if (!reconciliation) { for (const [field, value] of Object.entries(mixerext.payload)) { if (["ref", "expectedObjectIdentity", "expectedMixerIdentity", "expectedStateRevision"].includes(field)) continue; if (mixer[field] !== value) return this.transactionError(id, "extended mixer changed after apply; undo refused"); } }
        const state = { crossfadeAssign: mixer.crossfadeAssign ?? null, panningMode: mixer.panningMode ?? null };
        mixerext.state = "undoing";
        const priorFields = Object.fromEntries(Object.entries(mixerext.prior as Record<string, unknown>).filter(([, value]) => value !== null));
        const result = await this.invokeUndoRecovery(mixerext, adapter, "mixer.extended.set", { ref: mixerext.clipRef, ...priorFields, expectedObjectIdentity: track.objectIdentity, expectedMixerIdentity: mixer.mixerIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("extended mixer restoration was not confirmed");
        mixerext.state = "undone"; return this.successText(id, { transactionId: mixerext.id, state: "undone", idempotent: false });
      } catch (cause) { mixerext.state = "uncertain"; return this.adapterToolError(id, cause, "Extended-mixer undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("chainmix_")) {
      const chainmix = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!chainmix || chainmix.kind !== "chain-mixer") return this.transactionError(id, "Unknown or expired chain-mixer transaction");
      if (chainmix.state === "undone" && chainmix.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: chainmix.id, state: "undone", idempotent: true });
      const reconciliation = chainmix.state === "uncertain" && chainmix.undoKey === params.idempotencyKey;
      if ((chainmix.state !== "applied" && !reconciliation) || !chainmix.clipRef || !chainmix.prior) return this.transactionError(id, "Only an applied or exact-key uncertain chain-mixer transaction can be undone");
      try {
        this.beginUndoRecovery(chainmix, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== chainmix.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; chainmix.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(chainmix, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const found = this.chainRow(snapshot, chainmix.clipRef); const mixer = found.chain.mixer as JsonObject | undefined;
        if (!mixer || !isNonEmptyString(mixer.mixerIdentity as string, 256)) throw new Error("chain mixer authority is unavailable");
        if (!reconciliation) { for (const [field, value] of Object.entries(chainmix.payload)) { if (["ref", "expectedObjectIdentity", "expectedMixerIdentity", "expectedStateRevision"].includes(field)) continue; if (JSON.stringify(mixer[field]) !== JSON.stringify(value)) return this.transactionError(id, "chain mixer changed after apply; undo refused"); } }
        chainmix.state = "undoing";
        const chainPriorFields = Object.fromEntries(Object.entries(chainmix.prior as Record<string, unknown>).filter(([, value]) => value !== null));
        const result = await this.invokeUndoRecovery(chainmix, adapter, "chain-mixer.set", { ref: chainmix.clipRef, ...chainPriorFields, expectedObjectIdentity: found.chain.objectIdentity, expectedMixerIdentity: mixer.mixerIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ sends: mixer.sends ?? [] })).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("chain mixer restoration was not confirmed");
        chainmix.state = "undone"; return this.successText(id, { transactionId: chainmix.id, state: "undone", idempotent: false });
      } catch (cause) { chainmix.state = "uncertain"; return this.adapterToolError(id, cause, "Chain-mixer undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("devio_")) {
      const devio = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!devio || devio.kind !== "device-io") return this.transactionError(id, "Unknown or expired device-IO transaction");
      if (devio.state === "undone" && devio.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: devio.id, state: "undone", idempotent: true });
      const reconciliation = devio.state === "uncertain" && devio.undoKey === params.idempotencyKey;
      if ((devio.state !== "applied" && !reconciliation) || !devio.prior) return this.transactionError(id, "Only an applied or exact-key uncertain device-IO transaction can be undone");
      try {
        this.beginUndoRecovery(devio, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== devio.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; devio.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(devio, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, devio.payload.ref as LiveRef);
        const device = row.device as unknown as { deviceIo?: { routingType?: unknown; routingChannel?: unknown }; sidechainRoutingType?: unknown };
        const operation = devio.payload.action === "routing" ? "device-io.set" : "compressor.sidechain.set";
        const current = devio.payload.action === "routing" ? { routingType: device.deviceIo?.routingType ?? null, routingChannel: device.deviceIo?.routingChannel ?? null } : { routingType: device.sidechainRoutingType };
        if (!reconciliation) { for (const [field, value] of Object.entries(current)) { if (value !== undefined && value !== devio.payload[field]) return this.transactionError(id, "device routing changed after apply; undo refused"); } }
        devio.state = "undoing";
        const args: Record<string, unknown> = { ref: devio.payload.ref, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(current)).digest("hex") };
        const prior = devio.prior as Record<string, unknown>;
        if (prior.routingType !== undefined && prior.routingType !== null) args.routingType = prior.routingType;
        if (devio.payload.action === "routing" && prior.routingChannel !== undefined && prior.routingChannel !== null) args.routingChannel = prior.routingChannel;
        const result = await this.invokeUndoRecovery(devio, adapter, operation, args, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("device routing restoration was not confirmed");
        devio.state = "undone"; return this.successText(id, { transactionId: devio.id, state: "undone", idempotent: false });
      } catch (cause) { devio.state = "uncertain"; return this.adapterToolError(id, cause, "Device-IO undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("devadv_")) {
      const devadv = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!devadv || devadv.kind !== "device-advanced") return this.transactionError(id, "Unknown or expired device-advanced transaction");
      if (["re-enable-automation", "save-comparison", "set-bank"].includes(devadv.payload.action as string)) return this.transactionError(id, "Momentary device actions and control-surface bank selection are not undoable");
      if (devadv.payload.action === "insert-chain") return this.transactionError(id, "Chain device deletion is not exposed by the public LOM; undo is unavailable for this transaction");
      if (devadv.state === "undone" && devadv.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: devadv.id, state: "undone", idempotent: true });
      const reconciliation = devadv.state === "uncertain" && devadv.undoKey === params.idempotencyKey;
      if ((devadv.state !== "applied" && !reconciliation) || !devadv.prior) return this.transactionError(id, "Only an applied or exact-key uncertain device-advanced transaction can be undone");
      try {
        this.beginUndoRecovery(devadv, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== devadv.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; devadv.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(devadv, adapter, context);
        const snapshot = await adapter.snapshotAsync(context);
        const created = devadv.created as Record<string, unknown> | undefined;
        if (!created || !isNonEmptyString(created.ref as string, 256) || !isNonEmptyString(created.objectIdentity as string, 256)) return this.transactionError(id, "device move lacks exact applied identity");
        const row = this.deviceRow(snapshot, created.ref as LiveRef);
          const prior = devadv.prior as { ownerRef: LiveRef; index: number };
          const targetRef = devadv.payload.targetTrackRef !== undefined ? devadv.payload.targetTrackRef : devadv.payload.targetChainRef;
          const target = devadv.payload.targetTrackRef !== undefined ? (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === prior.ownerRef) : this.chainRow(snapshot, prior.ownerRef).chain;
          if (!target || !isNonEmptyString(target.objectIdentity, 256)) throw new Error("move-back target identity is unavailable");
          devadv.state = "undoing";
          const result = await this.invokeUndoRecovery(devadv, adapter, "device.move", { ref: created.ref, index: prior.index, targetTrackRef: devadv.payload.targetTrackRef !== undefined ? prior.ownerRef : undefined, targetChainRef: devadv.payload.targetTrackRef === undefined ? prior.ownerRef : undefined, expectedObjectIdentity: row.device.objectIdentity, expectedOwnerRef: row.ownerRef, expectedOwnerIdentity: row.ownerIdentity, expectedSiblings: row.siblings, expectedTrackRef: row.track.ref, expectedTrackIdentity: row.track.objectIdentity, expectedTargetIdentity: target.objectIdentity }, context) as Record<string, unknown>;
          if (result.index !== prior.index) throw new Error("device move-back was not confirmed");
        devadv.state = "undone"; return this.successText(id, { transactionId: devadv.id, state: "undone", idempotent: false });
      } catch (cause) { devadv.state = "uncertain"; return this.adapterToolError(id, cause, "Device-advanced undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("chainset_")) {
      const chainset = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!chainset || chainset.kind !== "chain-set") return this.transactionError(id, "Unknown or expired chain transaction");
      if (chainset.state === "undone" && chainset.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: chainset.id, state: "undone", idempotent: true });
      const reconciliation = chainset.state === "uncertain" && chainset.undoKey === params.idempotencyKey;
      if ((chainset.state !== "applied" && !reconciliation) || !chainset.clipRef || !chainset.prior) return this.transactionError(id, "Only an applied or exact-key uncertain chain transaction can be undone");
      try {
        this.beginUndoRecovery(chainset, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== chainset.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; chainset.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(chainset, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const found = this.chainRow(snapshot, chainset.clipRef);
        if (!reconciliation) { for (const [field, value] of Object.entries(chainset.payload)) { if (["ref", "expectedObjectIdentity", "expectedStateRevision"].includes(field)) continue; if (found.chain[field] !== value) return this.transactionError(id, "chain changed after apply; undo refused"); } }
        const state = { colorIndex: found.chain.colorIndex ?? null, autoColor: found.chain.autoColor ?? null, mute: found.chain.mute ?? null, solo: found.chain.solo ?? null };
        chainset.state = "undoing";
        const result = await this.invokeUndoRecovery(chainset, adapter, "chain.set", { ref: chainset.clipRef, ...(chainset.prior as Record<string, unknown>), expectedObjectIdentity: found.chain.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("chain restoration was not confirmed");
        chainset.state = "undone"; return this.successText(id, { transactionId: chainset.id, state: "undone", idempotent: false });
      } catch (cause) { chainset.state = "uncertain"; return this.adapterToolError(id, cause, "Chain undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("drumpad_")) {
      const drumpad = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!drumpad || drumpad.kind !== "drum-pad") return this.transactionError(id, "Unknown or expired drum-pad transaction");
      if (drumpad.payload.action === "delete-all-chains") return this.transactionError(id, "Deleted pad chains cannot be reconstructed; undo is unavailable for this transaction");
      if (drumpad.state === "undone" && drumpad.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: drumpad.id, state: "undone", idempotent: true });
      const reconciliation = drumpad.state === "uncertain" && drumpad.undoKey === params.idempotencyKey;
      if ((drumpad.state !== "applied" && !reconciliation) || !drumpad.prior) return this.transactionError(id, "Only an applied or exact-key uncertain drum-pad transaction can be undone");
      try {
        this.beginUndoRecovery(drumpad, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== drumpad.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; drumpad.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(drumpad, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const pad = this.drumPadRow(snapshot, drumpad.payload.ref as LiveRef);
        if (!reconciliation) { if (drumpad.payload.solo !== undefined && pad.solo !== drumpad.payload.solo) return this.transactionError(id, "drum pad changed after apply; undo refused"); }
        const state = { note: pad.note ?? null, solo: pad.solo ?? null };
        drumpad.state = "undoing";
        const restore: Record<string, unknown> = { ref: drumpad.payload.ref, expectedObjectIdentity: pad.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
        if ((drumpad.prior as Record<string, unknown>).solo !== undefined && (drumpad.prior as Record<string, unknown>).solo !== null) restore.solo = (drumpad.prior as Record<string, unknown>).solo;
        const result = await this.invokeUndoRecovery(drumpad, adapter, "drum-pad.set", restore, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("drum pad restoration was not confirmed");
        drumpad.state = "undone"; return this.successText(id, { transactionId: drumpad.id, state: "undone", idempotent: false });
      } catch (cause) { drumpad.state = "uncertain"; return this.adapterToolError(id, cause, "Drum-pad undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("rackview_")) {
      const rackview = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!rackview || rackview.kind !== "rack-view") return this.transactionError(id, "Unknown or expired rack-view transaction");
      if (rackview.state === "undone" && rackview.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: rackview.id, state: "undone", idempotent: true });
      const reconciliation = rackview.state === "uncertain" && rackview.undoKey === params.idempotencyKey;
      if ((rackview.state !== "applied" && !reconciliation) || !rackview.prior) return this.transactionError(id, "Only an applied or exact-key uncertain rack-view transaction can be undone");
      try {
        this.beginUndoRecovery(rackview, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== rackview.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; rackview.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(rackview, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, rackview.payload.ref as LiveRef);
        const view = row.device.rackView as JsonObject | undefined;
        if (!reconciliation) { for (const field of ["padScrollPosition", "showChainDevices"]) if (rackview.payload[field] !== undefined && view?.[field] !== rackview.payload[field]) return this.transactionError(id, "rack view changed after apply; undo refused"); }
        const state = { padScrollPosition: view?.padScrollPosition ?? null, showChainDevices: view?.showChainDevices ?? null };
        rackview.state = "undoing";
        const prior = rackview.prior as Record<string, unknown>;
        const args: Record<string, unknown> = { ref: rackview.payload.ref, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") };
        for (const field of ["selectedChainRef", "selectedPadIndex", "padScrollPosition", "showChainDevices"]) if (rackview.payload[field] !== undefined) args[field] = prior[field];
        const result = await this.invokeUndoRecovery(rackview, adapter, "rack.view.set", args, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("rack view restoration was not confirmed");
        rackview.state = "undone"; return this.successText(id, { transactionId: rackview.id, state: "undone", idempotent: false });
      } catch (cause) { rackview.state = "uncertain"; return this.adapterToolError(id, cause, "Rack-view undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("rack_")) {
      const rack = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!rack || rack.kind !== "rack") return this.transactionError(id, "Unknown or expired rack transaction");
      if (rack.payload.action !== "set") return this.transactionError(id, "Rack actions are momentary or structural and not undoable");
      if (rack.state === "undone" && rack.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: rack.id, state: "undone", idempotent: true });
      const reconciliation = rack.state === "uncertain" && rack.undoKey === params.idempotencyKey;
      if ((rack.state !== "applied" && !reconciliation) || !rack.prior) return this.transactionError(id, "Only an applied or exact-key uncertain rack transaction can be undone");
      try {
        this.beginUndoRecovery(rack, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== rack.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; rack.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(rack, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, rack.payload.ref as LiveRef);
        if (!reconciliation) { if (rack.payload.selectedVariationIndex !== undefined && row.device.selectedVariationIndex !== rack.payload.selectedVariationIndex) return this.transactionError(id, "rack changed after apply; undo refused"); }
        rack.state = "undoing";
        const result = await this.invokeUndoRecovery(rack, adapter, "rack.set", { ref: rack.payload.ref, ...(rack.prior as Record<string, unknown>), expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: this.rackStateRevision(row.device) }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("rack restoration was not confirmed");
        rack.state = "undone"; return this.successText(id, { transactionId: rack.id, state: "undone", idempotent: false });
      } catch (cause) { rack.state = "uncertain"; return this.adapterToolError(id, cause, "Rack undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("devspec_")) {
      const devspec = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!devspec || devspec.kind !== "device-specialized") return this.transactionError(id, "Unknown or expired specialized-device transaction");
      if (devspec.state === "undone" && devspec.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: devspec.id, state: "undone", idempotent: true });
      const reconciliation = devspec.state === "uncertain" && devspec.undoKey === params.idempotencyKey;
      if ((devspec.state !== "applied" && !reconciliation) || !devspec.prior) return this.transactionError(id, "Only an applied or exact-key uncertain specialized-device transaction can be undone");
      try {
        this.beginUndoRecovery(devspec, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== devspec.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; devspec.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(devspec, adapter, context);
        const family = devspec.payload.family as string;
        const fields = McpHost.SPECIALIZED_FAMILY_FIELDS[family]!;
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, devspec.payload.ref as LiveRef);
        const undoFamilyRow = ((row.device as unknown as Record<string, unknown>)[McpHost.specializedRowKey(family)] ?? {}) as Record<string, unknown>;
        if (!reconciliation) { for (const field of fields) if (devspec.payload[field] !== undefined && JSON.stringify(undoFamilyRow[field]) !== JSON.stringify(devspec.payload[field])) return this.transactionError(id, "device state changed after apply; undo refused"); }
        const state = Object.fromEntries(fields.map((field) => [field, undoFamilyRow[field] ?? null]));
        devspec.state = "undoing";
        const result = await this.invokeUndoRecovery(devspec, adapter, `${family}.set` as "drift.set" | "drum-cell.set" | "eq8.set" | "hybrid-reverb.set" | "meld.set" | "plugin.set", { ref: devspec.payload.ref, ...(devspec.prior as Record<string, unknown>), expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("specialized device restoration was not confirmed");
        devspec.state = "undone"; return this.successText(id, { transactionId: devspec.id, state: "undone", idempotent: false });
      } catch (cause) { devspec.state = "uncertain"; return this.adapterToolError(id, cause, "Specialized-device undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("simpler_")) {
      const simpler = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!simpler || simpler.kind !== "simpler") return this.transactionError(id, "Unknown or expired simpler transaction");
      if (simpler.state === "undone" && simpler.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: simpler.id, state: "undone", idempotent: true });
      const reconciliation = simpler.state === "uncertain" && simpler.undoKey === params.idempotencyKey;
      if ((simpler.state !== "applied" && !reconciliation) || !simpler.prior) return this.transactionError(id, "Only an applied or exact-key uncertain simpler transaction can be undone");
      try {
        this.beginUndoRecovery(simpler, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== simpler.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; simpler.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(simpler, adapter, context);
        const prior = simpler.prior as { samplePath: string };
        if (typeof prior.samplePath !== "string" || prior.samplePath.length < 1) return this.transactionError(id, "prior sample path is unavailable");
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, simpler.payload.ref as LiveRef);
        const currentPath = ((row.device as unknown as { samplePath?: string }).samplePath) ?? "";
        if (!reconciliation && currentPath !== (simpler.created?.samplePath ?? simpler.payload.filePath)) return this.transactionError(id, "simpler sample changed after apply; undo refused");
        simpler.state = "undoing";
        const result = await this.invokeUndoRecovery(simpler, adapter, "simpler.replace-sample", { ref: simpler.payload.ref, filePath: prior.samplePath, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity({ filePath: currentPath })).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("simpler sample restoration was not confirmed");
        this.releaseStagedImportFor(simpler);
        simpler.state = "undone"; return this.successText(id, { transactionId: simpler.id, state: "undone", idempotent: false });
      } catch (cause) { simpler.state = "uncertain"; return this.adapterToolError(id, cause, "Simpler undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("looper_")) {
      const looper = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!looper || looper.kind !== "looper") return this.transactionError(id, "Unknown or expired looper transaction");
      if (looper.payload.action !== "set") return this.transactionError(id, "Looper actions are momentary and not undoable");
      if (looper.state === "undone" && looper.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: looper.id, state: "undone", idempotent: true });
      const reconciliation = looper.state === "uncertain" && looper.undoKey === params.idempotencyKey;
      if ((looper.state !== "applied" && !reconciliation) || !looper.prior) return this.transactionError(id, "Only an applied or exact-key uncertain looper transaction can be undone");
      try {
        this.beginUndoRecovery(looper, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== looper.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; looper.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(looper, adapter, context);
        const snapshot = await adapter.snapshotAsync(context); const row = this.deviceRow(snapshot, looper.payload.ref as LiveRef);
        const looperRow = (((row.device as unknown as Record<string, unknown>).looper) ?? {}) as Record<string, unknown>;
        if (!reconciliation) { for (const field of ["overdubAfterRecord", "recordLengthIndex"]) if (looper.payload[field] !== undefined && looperRow[field] !== looper.payload[field]) return this.transactionError(id, "looper changed after apply; undo refused"); }
        const state = { overdubAfterRecord: looperRow.overdubAfterRecord ?? null, recordLengthIndex: looperRow.recordLengthIndex ?? null };
        looper.state = "undoing";
        const priorFields = Object.fromEntries(Object.entries(looper.prior as Record<string, unknown>).filter(([, value]) => value !== null));
        const result = await this.invokeUndoRecovery(looper, adapter, "looper.set", { ref: looper.payload.ref, ...priorFields, expectedObjectIdentity: row.device.objectIdentity, expectedStateRevision: createHash("sha256").update(canonicalMutationIdentity(state)).digest("hex") }, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("looper restoration was not confirmed");
        looper.state = "undone"; return this.successText(id, { transactionId: looper.id, state: "undone", idempotent: false });
      } catch (cause) { looper.state = "uncertain"; return this.adapterToolError(id, cause, "Looper undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("groove_")) {
      const groove = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!groove || groove.kind !== "groove") return this.transactionError(id, "Unknown or expired groove transaction");
      if (groove.state === "undone" && groove.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: groove.id, state: "undone", idempotent: true });
      const reconciliation = groove.state === "uncertain" && groove.undoKey === params.idempotencyKey;
      if ((groove.state !== "applied" && !reconciliation) || !groove.prior) return this.transactionError(id, "Only an applied or exact-key uncertain groove transaction can be undone");
      try {
        this.beginUndoRecovery(groove, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== groove.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; groove.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(groove, adapter, context);
        const snapshot = await adapter.snapshotAsync(context);
        if (!isNonEmptyString(snapshot.set.objectIdentity, 256)) throw new Error("Set identity is not authoritative");
        const action = groove.payload.action as string;
        if (!reconciliation) {
          const current = await adapter.invokeAsync({ operation: "groove.read", args: { setRef: snapshot.set.ref } }, context) as { grooveAmount?: unknown; grooves?: Array<Record<string, unknown>> };
          if (action === "set-amount") { if (current.grooveAmount !== groove.payload.grooveAmount) return this.transactionError(id, "groove amount changed after apply; undo refused"); }
          else {
            const row = (current.grooves ?? []).find((candidate) => candidate.ref === groove.payload.ref);
            if (!row) return this.transactionError(id, "edited groove disappeared after apply");
            for (const field of ["name", "base", "quantizationAmount", "randomAmount", "timingAmount", "velocityAmount"]) if (groove.payload[field] !== undefined && JSON.stringify(row[field]) !== JSON.stringify(groove.payload[field])) return this.transactionError(id, "groove changed after apply; undo refused");
          }
        }
        const before = await adapter.invokeAsync({ operation: "groove.read", args: { setRef: snapshot.set.ref } }, context) as { revision?: unknown };
        if (!isNonEmptyString(before.revision, 64)) throw new Error("groove undo authority is unavailable");
        groove.state = "undoing";
        if (action === "set-amount") {
          const priorAmount = (groove.prior as { grooveAmount: number | null }).grooveAmount;
          if (typeof priorAmount !== "number") return this.transactionError(id, "prior groove amount is unavailable");
          const result = await this.invokeUndoRecovery(groove, adapter, "groove.set", { setRef: snapshot.set.ref, grooveAmount: priorAmount, expectedObjectIdentity: snapshot.set.objectIdentity, expectedRevision: before.revision }, context) as { changed?: unknown };
          if (result.changed !== true) throw new Error("groove amount restoration was not confirmed");
        } else {
          const row = ((before as { grooves?: Array<Record<string, unknown>> }).grooves ?? []).find((candidate) => candidate.ref === groove.payload.ref);
          if (!row || !isNonEmptyString(row.objectIdentity, 256)) throw new Error("edited groove identity is unavailable");
          const result = await this.invokeUndoRecovery(groove, adapter, "groove.edit", { ref: groove.payload.ref, ...(groove.prior as Record<string, unknown>), expectedObjectIdentity: row.objectIdentity, expectedRevision: before.revision }, context) as { changed?: unknown };
          if (result.changed !== true) throw new Error("groove restoration was not confirmed");
        }
        const verified = await adapter.invokeAsync({ operation: "groove.read", args: { setRef: snapshot.set.ref } }, context) as { grooveAmount?: unknown; grooves?: Array<Record<string, unknown>> };
        if (action === "set-amount") { if (verified.grooveAmount !== (groove.prior as { grooveAmount: number | null }).grooveAmount) throw new Error("groove amount undo did not restore the exact prior value"); }
        else { const row = (verified.grooves ?? []).find((candidate) => candidate.ref === groove.payload.ref); if (!row) throw new Error("edited groove disappeared after undo"); for (const field of ["name", "base", "quantizationAmount", "randomAmount", "timingAmount", "velocityAmount"]) if (JSON.stringify(row[field]) !== JSON.stringify((groove.prior as Record<string, unknown>)[field])) throw new Error("groove undo did not restore the exact prior fields"); }
        groove.state = "undone"; return this.successText(id, { transactionId: groove.id, state: "undone", idempotent: false });
      } catch (cause) { groove.state = "uncertain"; return this.adapterToolError(id, cause, "Groove undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("tuning_")) {
      const tuning = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!tuning || tuning.kind !== "tuning") return this.transactionError(id, "Unknown or expired tuning transaction");
      if (tuning.state === "undone" && tuning.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: tuning.id, state: "undone", idempotent: true });
      const reconciliation = tuning.state === "uncertain" && tuning.undoKey === params.idempotencyKey;
      if ((tuning.state !== "applied" && !reconciliation) || !tuning.prior) return this.transactionError(id, "Only an applied or exact-key uncertain tuning transaction can be undone");
      try {
        this.beginUndoRecovery(tuning, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== tuning.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; tuning.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(tuning, adapter, context);
        const prior = tuning.prior as { tuningSystem: Record<string, unknown>; scale: Record<string, unknown> };
        const snapshot = await adapter.snapshotAsync(context);
        if (!reconciliation) {
          const proposed = Object.fromEntries(Object.entries(tuning.payload).filter(([key]) => !["setRef", "expectedObjectIdentity", "expectedRevision"].includes(key)));
          const current = await adapter.invokeAsync({ operation: "tuning.read", args: { setRef: tuning.payload.setRef } }, context) as { tuningSystem?: unknown; scale?: unknown };
          for (const [field, value] of Object.entries(proposed)) { const observed = ["name", "lowestNote", "highestNote", "referencePitch", "noteTunings"].includes(field) ? (current.tuningSystem as Record<string, unknown>)?.[field] : (current.scale as Record<string, unknown>)?.[field]; if (JSON.stringify(observed) !== JSON.stringify(value)) return this.transactionError(id, "tuning state changed after apply; undo refused"); }
        }
        const before = await adapter.invokeAsync({ operation: "tuning.read", args: { setRef: tuning.payload.setRef } }, context) as { revision?: unknown };
        if (!isNonEmptyString(before.revision, 64) || !isNonEmptyString(snapshot.set.objectIdentity, 256)) throw new Error("tuning undo authority is unavailable");
        const restore: Record<string, unknown> = { setRef: tuning.payload.setRef, expectedObjectIdentity: snapshot.set.objectIdentity, expectedRevision: before.revision };
        for (const field of ["name", "lowestNote", "highestNote", "referencePitch", "noteTunings"]) if (prior.tuningSystem[field] !== undefined && prior.tuningSystem[field] !== null) restore[field] = structuredClone(prior.tuningSystem[field]);
        for (const field of ["rootNote", "scaleName", "scaleMode"]) if (prior.scale[field] !== undefined && prior.scale[field] !== null) restore[field] = structuredClone(prior.scale[field]);
        tuning.state = "undoing";
        const result = await this.invokeUndoRecovery(tuning, adapter, "tuning.set", restore, context) as { changed?: unknown };
        if (result.changed !== true) throw new Error("tuning restoration was not confirmed");
        const verified = await adapter.invokeAsync({ operation: "tuning.read", args: { setRef: tuning.payload.setRef } }, context) as { tuningSystem?: unknown; scale?: unknown };
        if (JSON.stringify(verified.tuningSystem) !== JSON.stringify(prior.tuningSystem) || JSON.stringify(verified.scale) !== JSON.stringify(prior.scale)) throw new Error("tuning undo did not restore the exact prior state");
        tuning.state = "undone"; return this.successText(id, { transactionId: tuning.id, state: "undone", idempotent: false });
      } catch (cause) { tuning.state = "uncertain"; return this.adapterToolError(id, cause, "Tuning undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("clipset_")) {
      const clipset = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!clipset || clipset.kind !== "clip-set") return this.transactionError(id, "Unknown clip-properties transaction");
      if (clipset.state === "undone" && clipset.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: clipset.id, state: "undone", idempotent: true });
      const reconciliation = clipset.state === "uncertain" && clipset.undoKey === params.idempotencyKey;
      if ((clipset.state !== "applied" && !reconciliation) || !clipset.clipRef || !clipset.prior) return this.transactionError(id, "Only an applied or exact-key uncertain clip-properties edit can be undone");
      try {
        this.beginUndoRecovery(clipset, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== clipset.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; clipset.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(clipset, adapter, context); const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, clipset.clipRef);
        const expected = reconciliation ? clipset.prior : clipset.payload; for (const [field, value] of Object.entries(expected)) { if (field === "ref" || field.startsWith("expected")) continue; if (field === "grooveRef") { const observedRef = (row.clip.groove as { ref?: unknown } | null | undefined)?.ref ?? null; if (observedRef !== value) return this.transactionError(id, reconciliation ? "Clip-properties undo replay did not restore exact prior state" : "Clip changed after apply; undo refused"); continue; } if (field === "groove") { if (JSON.stringify(row.clip.groove ?? null) !== JSON.stringify(value)) return this.transactionError(id, reconciliation ? "Clip-properties undo replay did not restore exact prior state" : "Clip changed after apply; undo refused"); continue; } if (row.clip[field] !== value) return this.transactionError(id, reconciliation ? "Clip-properties undo replay did not restore exact prior state" : "Clip changed after apply; undo refused"); }
        if (!reconciliation) { clipset.state = "undoing"; const priorFields = { ...(clipset.prior as Record<string, unknown>) }; if (Object.prototype.hasOwnProperty.call(priorFields, "groove")) { const priorGroove = priorFields.groove as { ref?: unknown } | null; delete priorFields.groove; priorFields.grooveRef = priorGroove?.ref ?? null; } const result = await this.invokeUndoRecovery(clipset, adapter, "clip.set", { ref: clipset.clipRef, ...priorFields, ...this.clipPropertiesMutationAuthority(snapshot, clipset.clipRef) }, context) as JsonObject; if (result.changed !== true) throw new Error("Clip-properties restoration was not confirmed"); }
        const restoredRow = this.clipRow(await adapter.snapshotAsync(context), clipset.clipRef); for (const [field, value] of Object.entries(clipset.prior)) { if (field === "groove") { if (JSON.stringify(restoredRow.clip.groove ?? null) !== JSON.stringify(value)) throw new Error("Clip exact prior state was not restored"); } else if (restoredRow.clip[field] !== value) throw new Error("Clip exact prior state was not restored"); }
        clipset.state = "undone"; return this.successText(id, { transactionId: clipset.id, state: "undone", restored: clipset.prior, idempotent: false });
      } catch (cause) { clipset.state = "uncertain"; return this.adapterToolError(id, cause, "Clip-properties undo is uncertain; inspect the exact clip."); }
    }
    if (!transaction && String(params.transactionId).startsWith("audioclip_")) {
      const audio = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!audio || audio.kind !== "audio-set") return this.transactionError(id, "Unknown audio-clip transaction");
      if (audio.state === "undone" && audio.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: audio.id, state: "undone", idempotent: true });
      const reconciliation = audio.state === "uncertain" && audio.undoKey === params.idempotencyKey;
      if ((audio.state !== "applied" && !reconciliation) || !audio.clipRef || !audio.prior) return this.transactionError(id, "Only an applied or exact-key uncertain audio-clip edit can be undone");
      try {
        this.beginUndoRecovery(audio, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== audio.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; audio.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(audio, adapter, context); const snapshot = await adapter.snapshotAsync(context); const row = this.clipRow(snapshot, audio.clipRef);
        const expected = reconciliation ? audio.prior : audio.payload; for (const [field, value] of Object.entries(expected)) if (field !== "ref" && !field.startsWith("expected") && row.clip[field] !== value) return this.transactionError(id, reconciliation ? "Audio clip undo replay did not restore exact prior state" : "Audio clip changed after apply; undo refused");
        if (!reconciliation) { audio.state = "undoing"; const result = await this.invokeUndoRecovery(audio, adapter, "audio.clip.set", { ref: audio.clipRef, ...audio.prior, ...this.audioClipMutationAuthority(snapshot, audio.clipRef) }, context) as JsonObject; if (result.changed !== true) throw new Error("Audio clip restoration was not confirmed"); }
        const restoredRow = this.clipRow(await adapter.snapshotAsync(context), audio.clipRef); for (const [field, value] of Object.entries(audio.prior)) if (restoredRow.clip[field] !== value) throw new Error("Audio clip exact prior state was not restored");
        audio.state = "undone"; return this.successText(id, { transactionId: audio.id, state: "undone", restored: audio.prior, idempotent: false });
      } catch (cause) { audio.state = "uncertain"; return this.adapterToolError(id, cause, "Audio-clip undo is uncertain; inspect the exact clip."); }
    }
    if (!transaction && String(params.transactionId).startsWith("browserload_")) {
      const browser = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!browser || browser.kind !== "browser-load") return this.transactionError(id, "Unknown Browser-load transaction");
      if (browser.state === "undone" && browser.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: browser.id, state: "undone", idempotent: true });
      const reconciliation = browser.state === "uncertain" && browser.undoKey === params.idempotencyKey;
      if ((browser.state !== "applied" && !reconciliation) || !isNonEmptyString(browser.created?.deviceRef, 256) || !isNonEmptyString(browser.created?.objectIdentity, 256)) return this.transactionError(id, "Browser load lacks exact created device identity");
      try {
        this.beginUndoRecovery(browser, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== browser.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; browser.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(browser, adapter, context); browser.state = "undoing";
        await this.deleteOwnedDeviceAsync(adapter, browser.created.deviceRef as LiveRef, browser.created.objectIdentity as string, context, browser.created.fingerprint as string, browser, reconciliation); browser.state = "undone";
        return this.successText(id, { transactionId: browser.id, state: "undone", idempotent: false });
      } catch (cause) { browser.state = "uncertain"; return this.adapterToolError(id, cause, "Browser-load undo is uncertain; inspect the exact created device."); }
    }
    if (!transaction && String(params.transactionId).startsWith("device_")) {
      const device = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!device || device.kind !== "device") return this.transactionError(id, "Unknown device transaction");
      if (device.state === "undone" && device.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: device.id, state: "undone", idempotent: true });
      const reconciliation = device.state === "uncertain" && device.undoKey === params.idempotencyKey;
      if (device.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain device transaction can be undone");
      try {
        const plan = this.beginUndoRecovery(device, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== device.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; const action = device.payload.action; device.undoKey = params.idempotencyKey as string; if (reconciliation) { await this.replayUndoRecovery(device, adapter, context); const replayed = plan.steps.at(-1)?.result; if (action === "move" && isObject(replayed) && isNonEmptyString(replayed.ref, 256)) device.created = replayed; }
        device.state = "undoing";
        if (action === "insert") {
          if (!isNonEmptyString(device.created?.ref, 256) || !isNonEmptyString(device.created?.objectIdentity, 256)) throw new Error("inserted device identity is unavailable");
          await this.deleteOwnedDeviceAsync(adapter, device.created.ref as LiveRef, device.created.objectIdentity as string, context, device.created.fingerprint as string, device, reconciliation);
        } else {
          const reference = (action === "move" ? device.created?.ref : device.payload.ref) as LiveRef; const located = this.deviceRow(await adapter.snapshotAsync(context), reference);
          if (reconciliation) { if (action === "enable" && located.device.enabled !== device.prior?.enabled) throw new Error("device-enable undo replay did not restore prior state"); if (action === "move" && located.siblings.findIndex((sibling) => sibling.ref === reference) !== device.prior?.index) throw new Error("device-move undo replay did not restore prior location"); }
          else { const args: JsonObject = { ref: reference, expectedObjectIdentity: located.device.objectIdentity, expectedOwnerRef: located.ownerRef, expectedOwnerIdentity: located.ownerIdentity, expectedSiblings: located.siblings, expectedTrackRef: located.track.ref, expectedTrackIdentity: located.track.objectIdentity };
            if (action === "enable") { if (located.device.enabled !== device.payload.enabled || typeof device.prior?.enabled !== "boolean") throw new Error("device enable state changed after apply"); args.enabled = device.prior.enabled; args.expectedStateRevision = createHash("sha256").update(canonicalMutationIdentity({ enabled: located.device.enabled })).digest("hex"); }
            else if (action === "move") { const currentIndex = located.siblings.findIndex((sibling) => sibling.ref === reference); if (located.device.objectIdentity !== device.payload.expectedObjectIdentity || currentIndex !== device.created?.index || !isIntegerInRange(device.prior?.index, 0, 256)) throw new Error("moved device identity or location changed after apply"); args.index = device.prior.index; }
            else throw new Error("arbitrary device deletion has no automatic undo authority");
            const result = await this.invokeUndoRecovery(device, adapter, action === "enable" ? "device.enable" : "device.move", args, context) as JsonObject; if (result.changed !== true && !isNonEmptyString(result.ref, 256)) throw new Error("device restoration was not confirmed"); if (action === "move") device.created = result;
          }
        }
        device.state = "undone"; return this.successText(id, { transactionId: device.id, state: "undone", idempotent: false });
      } catch (cause) { device.state = "uncertain"; return this.adapterToolError(id, cause, "Device undo is uncertain; inspect the exact device hierarchy."); }
    }
    if (!transaction && String(params.transactionId).startsWith("routing_")) {
      const routing = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!routing || routing.kind !== "routing-set") return this.transactionError(id, "Unknown routing transaction");
      if (routing.state === "undone" && routing.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: routing.id, state: "undone", idempotent: true });
      const reconciliation = routing.state === "uncertain" && routing.undoKey === params.idempotencyKey;
      if ((routing.state !== "applied" && !reconciliation) || !routing.clipRef || !routing.prior) return this.transactionError(id, "Only an applied or exact-key uncertain routing transaction can be undone");
      try {
        this.beginUndoRecovery(routing, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== routing.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; routing.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(routing, adapter, context); const snapshot = await adapter.snapshotAsync(context); const track = (snapshot.tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === routing.clipRef);
        if (!track || track.objectIdentity !== routing.payload.expectedObjectIdentity) return this.transactionError(id, "routing track identity changed after apply; undo refused");
        const current = { inputType: (track.routing as JsonObject).inputType, inputSubRouting: (track.routing as JsonObject).inputSubRouting, outputType: (track.routing as JsonObject).outputType, outputSubRouting: (track.routing as JsonObject).outputSubRouting, arm: track.armed, monitoring: track.monitoringState };
        const expected = reconciliation ? routing.prior : routing.created; for (const key of Object.keys(routing.prior)) if (current[key as keyof typeof current] !== expected?.[key]) return this.transactionError(id, reconciliation ? "routing undo replay did not restore prior state" : "routing changed after apply; undo refused");
        if (!reconciliation) { const restore: JsonObject = { ref: routing.clipRef, ...routing.prior, expectedObjectIdentity: routing.payload.expectedObjectIdentity, expectedStateRevision: this.routingStateRevision(track) }; if (this.routingWouldCreateCycle(snapshot, routing.clipRef, restore)) return this.transactionError(id, "routing restoration would create a feedback loop"); routing.state = "undoing"; const result = await this.invokeUndoRecovery(routing, adapter, "routing.set", restore, context) as JsonObject; if (result.changed !== true) throw new Error("routing restoration was not confirmed"); }
        const afterTrack = ((await adapter.snapshotAsync(context)).tracks as unknown as JsonObject[]).find((candidate) => candidate.ref === routing.clipRef); if (!afterTrack) throw new Error("routing track disappeared after undo"); const afterRouting = afterTrack.routing as JsonObject; for (const [key, value] of Object.entries(routing.prior)) { const observed = key === "arm" ? afterTrack.armed : key === "monitoring" ? afterTrack.monitoringState : afterRouting[key]; if (observed !== value) throw new Error("routing exact prior state was not restored"); } routing.state = "undone";
        return this.successText(id, { transactionId: routing.id, state: "undone", restored: routing.prior, idempotent: false });
      } catch (cause) { routing.state = "uncertain"; return this.adapterToolError(id, cause, "Routing undo is uncertain; inspect routing and feedback state."); }
    }
    if (!transaction && String(params.transactionId).startsWith("recording_")) {
      const recording = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!recording || recording.kind !== "recording") return this.transactionError(id, "Unknown recording transaction");
      return this.transactionError(id, "Recording start cannot be ownership-proven across later manual stop/start cycles; use a fresh live_recording_preview action=stop or emergency-stop workflow");
    }
    if (!transaction && String(params.transactionId).startsWith("rename_")) {
      const rename = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!rename || rename.kind !== "rename" || !rename.clipRef) return this.transactionError(id, "Unknown or expired rename transaction");
      if (rename.state === "undone" && rename.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: rename.id, state: "undone", idempotent: true });
      const reconciliation = rename.state === "uncertain" && rename.undoKey === params.idempotencyKey;
      if (rename.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain rename transaction can be undone");
      try {
        this.beginUndoRecovery(rename, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== rename.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; rename.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(rename, adapter, context);
        const current = await adapter.getAsync(rename.clipRef, context) as { objectIdentity?: unknown; name?: unknown } | undefined;
        if (!current || current.objectIdentity !== rename.prior?.objectIdentity || current.name !== (reconciliation ? rename.prior?.name : rename.payload.name)) return this.transactionError(id, reconciliation ? "Rename undo replay did not restore prior name" : "Renamed object identity or name changed after apply; undo refused");
        const operation = (rename.payload.kind === "takeLane" ? "take-lane.rename" : `${rename.payload.kind}.rename`) as LiveInvocation["operation"];
        if (!reconciliation) { rename.state = "undoing"; await this.invokeUndoRecovery(rename, adapter, operation, { ref: rename.clipRef, name: rename.prior?.name, expectedName: rename.payload.name, expectedObjectIdentity: rename.prior?.objectIdentity, expectedAuthorityRevision: this.renameAuthorityRevision(await adapter.snapshotAsync(context), rename.payload.kind as string, rename.clipRef) }, context); }
        const restored = await adapter.getAsync(rename.clipRef, context) as { objectIdentity?: unknown; name?: unknown } | undefined;
        if (!restored || restored.objectIdentity !== rename.prior?.objectIdentity || restored.name !== rename.prior?.name) throw new Error("rename undo was not confirmed for the exact target");
        rename.state = "undone";
        return this.successText(id, { transactionId: rename.id, state: "undone", ref: rename.clipRef, name: restored.name, idempotent: false });
      } catch (cause) { if (rename.state === "undoing") rename.state = "uncertain"; return this.adapterToolError(id, cause, "Rename undo is uncertain; rediscover the target."); }
    }
    if (!transaction && String(params.transactionId).startsWith("mixer_")) {
      const mixer = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!mixer || mixer.kind !== "mixer-set") return this.transactionError(id, "Unknown or expired mixer transaction");
      if (mixer.state === "undone" && mixer.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: mixer.id, state: "undone", idempotent: true });
      const reconciliation = mixer.state === "uncertain" && mixer.undoKey === params.idempotencyKey;
      if (mixer.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain mixer transaction can be undone");
      try {
        this.beginUndoRecovery(mixer, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== mixer.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; mixer.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(mixer, adapter, context);
        const mutableFields = ["volume", "pan", "mute", "solo", "cueVolume", "sends"];
        let currentTarget = this.mixerTarget(await adapter.snapshotAsync(context), mixer.clipRef!); const expected = reconciliation ? mixer.prior : mixer.payload;
        for (const field of mutableFields) if (Object.prototype.hasOwnProperty.call(mixer.payload, field) && JSON.stringify(currentTarget.mixer[field] ?? null) !== JSON.stringify(expected?.[field] ?? null)) return this.transactionError(id, reconciliation ? "mixer undo replay did not restore prior state" : "mixer changed after apply; undo refused");
        if (!reconciliation) { const restore: Record<string, unknown> = { ref: mixer.clipRef, ...this.mixerAuthority(currentTarget) }; for (const field of mutableFields) if (Object.prototype.hasOwnProperty.call(mixer.payload, field)) restore[field] = mixer.prior?.[field] ?? null; mixer.state = "undoing"; const result = await this.invokeUndoRecovery(mixer, adapter, "mixer.set", restore, context) as { changed?: unknown }; if (result.changed !== true) throw new Error("mixer undo was not confirmed"); }
        currentTarget = this.mixerTarget(await adapter.snapshotAsync(context), mixer.clipRef!); for (const field of mutableFields) if (Object.prototype.hasOwnProperty.call(mixer.payload, field) && JSON.stringify(currentTarget.mixer[field] ?? null) !== JSON.stringify(mixer.prior?.[field] ?? null)) throw new Error("mixer exact prior state was not restored");
        mixer.state = "undone";
        return this.successText(id, { transactionId: mixer.id, state: "undone", restored: mixer.prior, idempotent: false });
      } catch (cause) { mixer.state = "uncertain"; return this.adapterToolError(id, cause, "Mixer undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("automation_")) {
      const automation = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!automation || automation.kind !== "automation") return this.transactionError(id, "Unknown or expired automation transaction");
      if (automation.payload.action === "clear-envelopes") return this.transactionError(id, "Cleared envelopes cannot be reconstructed; undo is unavailable for this transaction");
      if (automation.state === "undone" && automation.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: automation.id, state: "undone", idempotent: true });
      const reconciliation = automation.state === "uncertain" && automation.undoKey === params.idempotencyKey;
      if (automation.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain automation transaction can be undone");
      try {
        const plan = this.beginUndoRecovery(automation, params.idempotencyKey as string); const status = this.requireConnected("session.read"); if (status.epoch !== automation.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; automation.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(automation, adapter, context);
        const action = automation.payload.action as string;
        const prior = automation.prior as { exists?: unknown; points?: unknown };
        const guarded = async (extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
          const clipRef = automation.payload.clipRef as LiveRef; const parameterRef = automation.payload.parameterRef as LiveRef;
          const read = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef, parameterRef } }, context) as { revision?: unknown };
          const authorityDigest = this.automationAuthorityDigest(await adapter.snapshotAsync(context), clipRef, parameterRef);
          if (!isNonEmptyString(read.revision, 64)) throw new Error("automation undo revision is unavailable");
          return { clipRef, parameterRef, expectedAuthorityDigest: authorityDigest, expectedEnvelopeRevision: read.revision, ...extra };
        };
        const current = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: automation.payload.clipRef, parameterRef: automation.payload.parameterRef } }, context) as { exists?: unknown; points?: unknown; revision?: unknown };
        if (reconciliation && current.exists === prior.exists && canonicalMutationIdentity(current.points ?? []) === canonicalMutationIdentity(prior.points ?? [])) { automation.state = "undone"; return this.successText(id, { transactionId: automation.id, state: "undone", idempotent: false }); }
        const currentAuthority = this.automationAuthorityDigest(await adapter.snapshotAsync(context), automation.payload.clipRef as LiveRef, automation.payload.parameterRef as LiveRef);
        if (!reconciliation && (!automation.created || current.revision !== automation.created.revision || currentAuthority !== automation.created.authorityDigest)) return this.transactionError(id, "automation target changed after apply; undo refused");
        if (reconciliation && plan.steps.length > 0) { const priorPoints = Array.isArray(prior.points) ? prior.points : []; if (action === "insert") { const inserted = automation.payload.points as Array<{ time: number }>; const times = inserted.map((point) => point.time); const from = Math.max(0, Math.min(...times) - 0.001); const to = Math.max(...times) + 0.001; const intermediate = priorPoints.filter((point) => !isObject(point) || typeof point.time !== "number" || point.time < from || point.time > to); if (current.exists !== prior.exists || canonicalMutationIdentity(current.points ?? []) !== canonicalMutationIdentity(intermediate)) throw new Error("automation undo partial state conflicts with exact prior content"); } else if (action === "delete-envelope") { if (current.exists !== true || canonicalMutationIdentity(current.points ?? []) !== "[]") throw new Error("automation envelope recreation has conflicting content"); } else throw new Error("automation undo replay did not restore exact prior content"); }
        if (action === "insert") {
          const inserted = automation.payload.points as Array<{ time: number }>;
          const times = inserted.map((point) => point.time); const from = Math.max(0, Math.min(...times) - 0.001); const to = Math.max(...times) + 0.001;
          if (!plan.steps.some((step) => step.operation === "automation.point.delete")) await this.invokeUndoRecovery(automation, adapter, "automation.point.delete", await guarded({ from, to }), context);
          const restorePoints = (Array.isArray(prior.points) ? prior.points : []).filter((point) => isObject(point) && typeof point.time === "number" && point.time >= from && point.time <= to);
          if (restorePoints.length > 0 && !plan.steps.some((step) => step.operation === "automation.point.insert")) await this.invokeUndoRecovery(automation, adapter, "automation.point.insert", await guarded({ points: restorePoints }), context);
        } else if (action === "delete-range" || action === "delete-envelope") {
          const points = Array.isArray(prior.points) ? prior.points : [];
          if (action === "delete-envelope" && prior.exists === true && !plan.steps.some((step) => step.operation === "automation.envelope.create")) await this.invokeUndoRecovery(automation, adapter, "automation.envelope.create", await guarded({}), context);
          const restorePoints = action === "delete-range" ? points.filter((point) => point.time >= (automation.payload.from as number) && point.time <= (automation.payload.to as number)) : points;
          if (restorePoints.length > 0 && !plan.steps.some((step) => step.operation === "automation.point.insert")) await this.invokeUndoRecovery(automation, adapter, "automation.point.insert", await guarded({ points: restorePoints }), context);
        } else if (action === "create-envelope") {
          if (!plan.steps.some((step) => step.operation === "automation.envelope.delete")) await this.invokeUndoRecovery(automation, adapter, "automation.envelope.delete", await guarded({}), context);
        }
        const restored = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: automation.payload.clipRef, parameterRef: automation.payload.parameterRef } }, context) as { exists?: unknown; points?: unknown };
        if (restored.exists !== prior.exists || canonicalMutationIdentity(restored.points ?? []) !== canonicalMutationIdentity(prior.points ?? [])) throw new Error("automation undo did not restore the exact prior envelope");
        automation.state = "undone"; automation.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: automation.id, state: "undone", idempotent: false });
      } catch (cause) { automation.state = "uncertain"; return this.adapterToolError(id, cause, "Automation undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("structure_")) {
      const structure = this.sessionStructureTransactions.get(params.transactionId as string);
      const reconciliation = structure?.state === "uncertain" && structure.undoKey === params.idempotencyKey;
      if (structure?.state === "undone" && structure.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: structure.id, state: "undone", idempotent: true });
      if (!structure || (structure.state !== "applied" && !reconciliation) || !structure.created) return this.transactionError(id, "Only an applied or exact-key uncertain Session-structure transaction can be undone");
      const status = this.requireConnected("session.structure"); if (status.epoch !== structure.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter(); const context = (): LiveOperationContext => ({ signal, deadlineMs: Date.now() + STRUCTURE_STEP_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }); this.beginUndoRecovery(structure, params.idempotencyKey as string); structure.undoKey = params.idempotencyKey as string;
      try { if (reconciliation) await this.replayUndoRecovery(structure, adapter, context()); let current = await adapter.snapshotAsync(context());
        for (const item of structure.created) { const row = this.sessionStructureOwnedRow(current, item); if (row && (row.name !== item.name || this.sessionStructureCreatedFingerprint(current, item.kind, item.ref) !== item.fingerprint)) throw new Error("created Session structure was modified after apply; undo refused"); }
        structure.state = "undoing"; for (const item of [...structure.created].reverse()) { current = await adapter.snapshotAsync(context()); const row = this.sessionStructureOwnedRow(current, item); if (!row) continue; if (this.sessionStructureCreatedFingerprint(current, item.kind, item.ref) !== item.fingerprint) throw new Error("transaction-owned Session structure changed before deletion"); await this.invokeUndoRecovery(structure, adapter, item.kind === "track" ? "track.delete" : "scene.delete", { ref: item.ref, expectedStructureRevision: this.structureRevision(current), expectedObjectIdentity: item.objectIdentity }, context()); }
        const after = await adapter.snapshotAsync(context()); if (structure.created.some((item) => this.sessionStructureOwnedRow(after, item) !== undefined)) throw new Error("Session-structure undo left transaction-owned objects"); }
      catch (cause) { structure.state = "uncertain"; return this.adapterToolError(id, cause, "Session-structure undo is uncertain; inspect authoritative tracks and scenes."); }
      structure.state = "undone";
      return this.successText(id, { transactionId: structure.id, state: "undone", restored: { tracks: structure.priorTracks, scenes: structure.priorScenes }, idempotent: false });
    }
    if (!transaction && String(params.transactionId).startsWith("arrangement_")) {
      const arrangement = this.arrangementTransactions.get(params.transactionId as string);
      const reconciliation = arrangement?.state === "uncertain" && arrangement.undoKey === params.idempotencyKey;
      if (arrangement?.state === "undone" && arrangement.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: arrangement.id, state: "undone", idempotent: true });
      if (!arrangement || (arrangement.state !== "applied" && !reconciliation) || !arrangement.created) return this.transactionError(id, "Only an applied or exact-key uncertain Arrangement transaction can be undone");
      try {
        const status = this.requireConnected("arrangement.write"); if (status.epoch !== arrangement.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; this.beginUndoRecovery(arrangement, params.idempotencyKey as string); arrangement.undoKey = params.idempotencyKey as string;
        if (reconciliation) await this.replayUndoRecovery(arrangement, adapter, context);
        let current = (await adapter.snapshotAsync(context)).arrangement.locators;
        for (const locator of arrangement.created) { const found = current.find((item) => item.ref === locator.ref); if (found && (found.objectIdentity !== locator.objectIdentity || found.name !== locator.name || found.position !== locator.position)) return this.transactionError(id, "Arrangement locator identity or content changed after apply; undo refused"); }
        try { arrangement.state = "undoing"; for (const locator of [...arrangement.created].reverse()) { const snapshot = await adapter.snapshotAsync(context); if (!snapshot.arrangement.locators.some((item) => item.ref === locator.ref)) continue; await this.invokeUndoRecovery(arrangement, adapter, "locator.delete", this.locatorDeleteArgs(snapshot, locator.ref, locator.objectIdentity), context); } current = (await adapter.snapshotAsync(context)).arrangement.locators; if (arrangement.created.some((locator) => current.some((item) => item.ref === locator.ref))) throw new Error("Arrangement undo left transaction-owned locators"); }
        catch (cause) { arrangement.state = "uncertain"; throw cause; }
        arrangement.state = "undone";
        return this.successText(id, { transactionId: arrangement.id, state: "undone", restored: arrangement.prior, idempotent: false });
      } catch (cause) { return this.adapterToolError(id, cause, "Arrangement undo refused; inspect authoritative locators."); }
    }
    if (!transaction && String(params.transactionId).startsWith("parameter_")) {
      const parameter = this.deviceParameterTransactions.get(params.transactionId as string);
      const reconciliation = parameter?.state === "uncertain" && parameter.undoKey === params.idempotencyKey;
      if (parameter?.state === "undone" && parameter.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: parameter.id, state: "undone", idempotent: true });
      if (!parameter || (parameter.state !== "applied" && !reconciliation) || parameter.appliedRevision === undefined) return this.transactionError(id, "Only an applied or exact-key uncertain device-parameter transaction can be undone");
      try {
        this.beginUndoRecovery(parameter, params.idempotencyKey as string); const status = this.requireConnected("device.parameter.write"); if (status.epoch !== parameter.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; parameter.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(parameter, adapter, context); const currentSnapshot = await adapter.snapshotAsync(context); const current = this.parameterTarget(currentSnapshot, parameter.deviceRef, parameter.parameterRef).parameter;
        if (reconciliation) { if (current.value !== parameter.priorValue || JSON.stringify(this.parameterAuthority(currentSnapshot, parameter.parameterRef)) !== JSON.stringify(parameter.authority)) throw new Error("device-parameter undo replay did not restore exact prior state"); }
        else { if (current.value !== parameter.proposedValue || this.parameterRevision(current) !== parameter.appliedRevision || JSON.stringify(this.parameterAuthority(currentSnapshot, parameter.parameterRef)) !== JSON.stringify(parameter.authority)) return this.transactionError(id, "Device parameter identity or value changed after apply; undo refused"); parameter.state = "undoing"; await this.invokeUndoRecovery(parameter, adapter, "device.parameter.set", this.parameterMutationArgs(parameter, parameter.priorValue, parameter.appliedRevision), context); }
        const restoredSnapshot = await adapter.snapshotAsync(context); const restored = this.parameterTarget(restoredSnapshot, parameter.deviceRef, parameter.parameterRef).parameter;
        if (restored.value !== parameter.priorValue || JSON.stringify(this.parameterAuthority(restoredSnapshot, parameter.parameterRef)) !== JSON.stringify(parameter.authority)) { parameter.state = "uncertain"; throw new Error("Live did not confirm exact device-parameter restoration"); }
        parameter.state = "undone";
        return this.successText(id, { transactionId: parameter.id, state: "undone", value: restored.value, revision: this.parameterRevision(restored), idempotent: false });
      } catch (cause) { if (parameter.state === "undoing" || parameter.state === "uncertain") parameter.state = "uncertain"; return this.adapterToolError(id, cause, "Device-parameter undo is uncertain; inspect authoritative parameter state."); }
    }
    if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: transaction.priorTempo, idempotent: true });
    const reconciliation = transaction.state === "uncertain" && transaction.undoKey === params.idempotencyKey;
    if (transaction.state !== "applied" && !reconciliation) return this.transactionError(id, "Only an applied or exact-key uncertain tempo transaction can be undone");
    try {
      this.beginUndoRecovery(transaction, params.idempotencyKey as string); const status = this.requireConnected("transport"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; transaction.undoKey = params.idempotencyKey as string; if (reconciliation) await this.replayUndoRecovery(transaction, adapter, context); const current = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!current || current.objectIdentity !== transaction.setIdentity || current.tempo !== (reconciliation ? transaction.priorTempo : transaction.appliedTempo)) return this.transactionError(id, reconciliation ? "Tempo undo replay did not restore exact prior state" : "Set identity or tempo changed after apply; undo refused");
      if (!reconciliation) { transaction.state = "undoing"; await this.invokeUndoRecovery(transaction, adapter, "tempo.set", { ref: transaction.setRef, value: transaction.priorTempo, expectedTempo: transaction.appliedTempo, expectedObjectIdentity: transaction.setIdentity }, context); }
      const restored = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!restored || restored.objectIdentity !== transaction.setIdentity || restored.tempo !== transaction.priorTempo) throw new Error("Live did not confirm exact Set tempo restoration");
      transaction.state = "undone";
      return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: restored.tempo, epoch: transaction.epoch, idempotent: false });
    } catch (cause) {
      if (transaction.state === "undoing") transaction.state = "uncertain";
      return this.adapterToolError(id, cause, "Tempo undo is uncertain; perform fresh authoritative discovery.");
    }
  }

  public handle(input: unknown): JsonObject | null {
    if (!isObject(input) || input.jsonrpc !== "2.0" || !hasOnly(input, ["jsonrpc", "id", "method", "params", "_meta"])) {
      return error(null, -32600, "Invalid Request");
    }
    if (typeof input.method !== "string" || !hasOnly(input, ["jsonrpc", "id", "method", "params", "_meta"])) {
      return error(this.requestId(input.id), -32600, "Invalid Request");
    }
    const id = input.id;
    if (id === undefined) {
      if (input.method === "notifications/initialized" && this.initialized && !this.initializedNotification && input.params === undefined) {
        this.initializedNotification = true;
        return null;
      }
      if (input.method === "notifications/cancelled") return null;
      if (input.method === "exit") { this.shuttingDown = true; return null; }
      return null;
    }
    if (!this.isId(id)) return error(null, -32600, "Invalid Request");
    const key = `${typeof id}:${String(id)}`;
    if (this.seenIds.has(key)) return error(id, -32600, "Duplicate request identifier");
    this.seenIds.add(key);
    this.idOrder.push(key);
    if (this.idOrder.length > MAX_TRACKED_REQUEST_IDS) {
      const expired = this.idOrder.shift();
      if (expired !== undefined) this.seenIds.delete(expired);
    }
    if (this.shuttingDown && input.method !== "exit") return error(id, -32600, "Server is shutting down");

    if (input.method === "notifications/initialized") {
      if (this.initializedNotification || !this.initialized || input.params !== undefined) return null;
      this.initializedNotification = true;
      return null;
    }
    if (input.method === "notifications/cancelled") {
      if (input.params !== undefined && (!isObject(input.params) || !hasOnly(input.params, ["requestId"]) || !this.isId(input.params.requestId))) return null;
      return null;
    }
    // Lifecycle, not a tool: an id-bearing exit is acknowledged and the
    // transport terminates after the response flushes; new work is refused by
    // the shutdown guard above from then on.
    if (input.method === "exit") { this.shuttingDown = true; return response(id, {}); }
    if (!this.initialized && input.method !== "initialize") {
      return error(id, -32002, "Server has not been initialized");
    }
    if (!this.initializedNotification && input.method !== "initialize" && input.method !== "ping") {
      return error(id, -32002, "Server has not received initialized notification");
    }
    switch (input.method) {
      case "initialize": return this.initialize(id, input.params);
      case "ping": return this.utilityParams(input.params) ? response(id, {}) : error(id, -32602, "Invalid ping parameters");
      case "tools/list": return this.utilityParams(input.params) ? (this.noteToolListChanged(), response(id, { tools: visibleToolDescriptors(this.safeAdapterStatus(), this.toolPolicy) })) : error(id, -32602, "Invalid tools/list parameters");
      case "tools/call": return this.callTool(id, input.params);
      case "resources/list": return this.listResources(id, input.params);
      case "resources/read": return this.readResource(id, input.params);
      case "prompts/list": return this.listPrompts(id, input.params);
      case "prompts/get": return this.getPrompt(id, input.params);
      default: return error(id, -32601, "Method not found");
    }
  }

  /** True once a peer asked the server to exit; new request work is refused. */
  public isShuttingDown(): boolean { return this.shuttingDown; }

  private initialize(id: RequestId, params: unknown): JsonObject {
    if (this.initialized) return error(id, -32600, "Already initialized");
    if (
      !isObject(params) ||
      !hasOnly(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
      params.protocolVersion !== PROTOCOL_VERSION ||
      !isObject(params.capabilities) ||
      !isObject(params.clientInfo) ||
      !isNonEmptyString(params.clientInfo.name, 256) ||
      !isNonEmptyString(params.clientInfo.version, 64) ||
      !hasOnly(params.clientInfo, ["name", "version", "title", "description", "websiteUrl", "icons"])
    ) {
      return error(id, -32602, "Invalid initialize parameters");
    }
    this.initialized = true;
    return response(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      serverInfo: { name: "ableton-mcp-host", version: SERVER_VERSION },
    });
  }

  private cancel(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["requestId"]) || !this.isId(params.requestId)) {
      return error(id, -32602, "Invalid cancellation parameters");
    }
    return response(id, { cancelled: false, requestId: params.requestId, reason: "no-cancellable-operation" });
  }

  private callTool(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["name", "arguments", "_meta"]) || typeof params.name !== "string") {
      return error(id, -32602, "Invalid tools/call parameters");
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) return error(id, -32602, "Tool arguments must be an object");
    this.noteToolListChanged();
    if (!this.toolCallable(params.name)) return this.toolGateError(id, params.name);
    if (this.recoveryFinalizationInFlight && !["server_status", "capabilities", "plan_user_journey", "live_status", "live_snapshot", "live_discover", "live_project_snapshot_export", "live_project_snapshot_diff"].includes(params.name)) return this.adapterToolError(id, new Error("recovery finalization safety barrier is in progress"), "Wait for terminal recovery finalization before any synchronous mutation.");
    const argumentTools = new Set(["plan_user_journey", "audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop", "live_discover", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi_preview", "live_capture_midi_apply", "live_scene_capture_preview", "live_scene_capture_apply", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_snapshot_export", "live_project_snapshot_diff", "als_read", "als_lint", "als_diff", "live_project_backup_preview", "live_project_backup_apply", "live_device_parameter_preview", "live_device_parameter_apply", "live_session_structure_preview", "live_session_structure_apply", "live_object_rename_preview", "live_object_rename_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_midi_transform_preview", "live_midi_transform_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo", "live_recovery_finalize", "live_view_preview", "live_view_apply", "live_locator_jump_preview", "live_locator_jump_apply", "live_clip_properties_preview", "live_clip_properties_apply", "live_audio_import_preview", "live_audio_import_apply", "live_warp_marker_preview", "live_warp_marker_apply", "live_clip_action_preview", "live_clip_action_apply", "live_note_edit_preview", "live_note_edit_apply", "live_note_read", "live_key_estimate", "live_tuning_preview", "live_tuning_apply", "live_groove_preview", "live_groove_apply", "live_scene_preview", "live_scene_apply", "live_scene_fire_preview", "live_scene_fire_apply", "live_song_state", "live_song_settings_preview", "live_song_settings_apply", "live_transport_action_preview", "live_transport_action_apply", "live_track_structure_preview", "live_track_structure_apply", "live_device_delete_preview", "live_device_delete_apply", "live_track_view_preview", "live_track_view_apply", "live_track_properties_preview", "live_track_properties_apply", "live_selection_preview", "live_selection_apply", "live_clip_view_preview", "live_clip_view_apply", "live_device_view_preview", "live_device_view_apply", "live_performance_read", "live_mixer_extended_preview", "live_mixer_extended_apply", "live_chain_mixer_preview", "live_chain_mixer_apply", "live_device_io_preview", "live_device_io_apply", "live_device_advanced_preview", "live_device_advanced_apply", "live_chain_preview", "live_chain_apply", "live_drum_pad_preview", "live_drum_pad_apply", "live_rack_preview", "live_rack_apply", "live_rack_view_preview", "live_rack_view_apply", "live_device_specialized_preview", "live_device_specialized_apply", "live_looper_preview", "live_looper_apply", "live_simpler_preview", "live_simpler_apply", "live_observe_subscribe", "live_observe_poll", "live_observe_unsubscribe", "live_browser_roots", "live_browser_inspect", "live_arrangement_automation_read", "live_take_lane_read", "live_comp_read", "live_warp_marker_read", "live_application_dialog_preview", "live_application_dialog_apply"]);
    if (!argumentTools.has(params.name) && params.arguments !== undefined && Object.keys(params.arguments as JsonObject).length !== 0) {
      return error(id, -32602, "Tool arguments must be an empty object");
    }
    if (params.name === "server_status") {
      return response(id, { content: [{ type: "text", text: JSON.stringify({ host: "ready", live: this.safeAdapterStatus() }) }], isError: false });
    }
    if (params.name === "capabilities") {
      return response(id, { content: [{ type: "text", text: JSON.stringify(this.capabilityCatalog()) }], isError: false });
    }
    if (params.name === "plan_user_journey") {
      const args = params.arguments;
      if (!isObject(args) || !hasOnly(args, ["journey", "traits", "experienceLevel", "bars"]) || typeof args.journey !== "string" || !JOURNEY_IDS.includes(args.journey as JourneyId) || typeof args.traits !== "string" || (args.experienceLevel !== undefined && args.experienceLevel !== "beginner" && args.experienceLevel !== "advanced") || (args.bars !== undefined && !isIntegerInRange(args.bars, 1, 16))) {
        return error(id, -32602, "Invalid plan_user_journey arguments");
      }
      try {
        const plan = planUserJourney({ journey: args.journey as JourneyId, traits: args.traits, experienceLevel: args.experienceLevel as ExperienceLevel | undefined, bars: args.bars as number | undefined }, this.safeAdapterStatus());
        return response(id, { content: [{ type: "text", text: JSON.stringify(plan) }], isError: false });
      } catch (cause) {
        return error(id, -32602, cause instanceof Error ? cause.message : "Invalid journey plan arguments");
      }
    }
    if (params.name === "live_status") return this.liveStatus(id);
    if (params.name === "live_snapshot") return this.liveSnapshot(id);
    if (params.name === "live_discover") return this.liveDiscover(id, params.arguments);
    if (["audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi_preview", "live_capture_midi_apply", "live_scene_capture_preview", "live_scene_capture_apply", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_snapshot_export", "live_project_snapshot_diff", "als_read", "als_lint", "als_diff", "live_project_backup_preview", "live_project_backup_apply", "live_view_preview", "live_view_apply", "live_locator_jump_preview", "live_locator_jump_apply", "live_clip_properties_preview", "live_clip_properties_apply", "live_audio_import_preview", "live_audio_import_apply", "live_warp_marker_preview", "live_warp_marker_apply", "live_clip_action_preview", "live_clip_action_apply", "live_note_edit_preview", "live_note_edit_apply", "live_note_read", "live_key_estimate", "live_tuning_preview", "live_tuning_apply", "live_groove_preview", "live_groove_apply", "live_scene_preview", "live_scene_apply", "live_scene_fire_preview", "live_scene_fire_apply", "live_song_state", "live_song_settings_preview", "live_song_settings_apply", "live_transport_action_preview", "live_transport_action_apply", "live_track_structure_preview", "live_track_structure_apply", "live_device_delete_preview", "live_device_delete_apply", "live_track_view_preview", "live_track_view_apply", "live_track_properties_preview", "live_track_properties_apply", "live_selection_preview", "live_selection_apply", "live_clip_view_preview", "live_clip_view_apply", "live_device_view_preview", "live_device_view_apply", "live_performance_read", "live_mixer_extended_preview", "live_mixer_extended_apply", "live_chain_mixer_preview", "live_chain_mixer_apply", "live_device_io_preview", "live_device_io_apply", "live_device_advanced_preview", "live_device_advanced_apply", "live_chain_preview", "live_chain_apply", "live_drum_pad_preview", "live_drum_pad_apply", "live_rack_preview", "live_rack_apply", "live_rack_view_preview", "live_rack_view_apply", "live_device_specialized_preview", "live_device_specialized_apply", "live_looper_preview", "live_looper_apply", "live_simpler_preview", "live_simpler_apply", "live_observe_subscribe", "live_observe_poll", "live_observe_unsubscribe", "live_browser_roots", "live_browser_inspect", "live_arrangement_automation_read", "live_take_lane_read", "live_comp_read", "live_warp_marker_read", "live_application_dialog_preview", "live_application_dialog_apply"].includes(params.name)) return error(id, -32001, "This operation requires the asynchronous host request path");
    if (params.name === "live_device_parameter_preview") return this.liveDeviceParameterPreview(id, params.arguments);
    if (params.name === "live_device_parameter_apply") return this.liveDeviceParameterApply(id, params.arguments);
    if (params.name === "live_session_structure_preview") return this.liveSessionStructurePreview(id, params.arguments);
    if (params.name === "live_session_structure_apply") return this.liveSessionStructureApply(id, params.arguments);
    if (params.name === "live_object_rename_preview" || params.name === "live_object_rename_apply") return this.adapterToolError(id, new Error("rename requires the asynchronous production adapter boundary"), "Use McpHost.handleAsync for guarded rename operations.");
    if (params.name === "live_midi_clip_preview") return this.liveMidiPreview(id, params.arguments);
    if (params.name === "live_midi_clip_apply") return this.liveMidiApply(id, params.arguments);
    if (params.name === "live_arrangement_section_preview") return this.liveArrangementPreview(id, params.arguments);
    if (params.name === "live_arrangement_section_apply") return this.liveArrangementApply(id, params.arguments);
    if (params.name === "live_tempo_preview") return this.liveTempoPreview(id, params.arguments);
    if (params.name === "live_tempo_apply") return this.liveTempoApply(id, params.arguments);
    if (params.name === "live_undo") return this.liveUndo(id, params.arguments);
    return error(id, -32601, "Tool not found");
  }

  private listResources(id: RequestId, params: unknown): JsonObject {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid resources/list parameters");
    return response(id, { resources: [...resources, liveResource] });
  }

  private capabilityCatalog(): JsonObject {
    const live = this.safeAdapterStatus();
    const capabilities = new Set<string>(live.capabilities);
    const hasAny = (...required: string[]): boolean => required.some((capability) => capabilities.has(capability));
    const mutationAvailable = liveMutationAvailable(live);
    const rows = this.toolVisibilityRows();
    const liveRows = rows.filter((row) => !row.entry.local);
    const availableTools = liveRows.filter((row) => row.executable).map((row) => row.entry.name);
    const unavailableTools = liveRows.filter((row) => !row.executable).map((row) => row.entry.name);
    const visibleTools = rows.filter((row) => row.visible).map((row) => row.entry.name);
    const policyDeniedTools = rows.filter((row) => row.executable && !row.policyAllowed).map((row) => row.entry.name);
    const broadUnavailable = [
      ...(mutationAvailable ? [] : ["live.mutations"]),
      ...(capabilities.has("transport") ? [] : ["live.transport"]),
      ...(capabilities.has("recording") ? [] : ["live.recording"]),
      ...(capabilities.has("routing") ? [] : ["live.routing"]),
      ...(hasAny("audio", "audio.capture.resampling") ? [] : ["live.audio"]),
      ...(hasAny("notes", "session.midi_note.read", "session.midi_note.write", "session.midi_clip.create") ? [] : ["live.midi"]),
      ...(capabilities.has("realtime.events") ? [] : ["realtime"]),
    ];
    const liveUnavailable = live.connected
      ? [...hostUnavailableCapabilities, ...broadUnavailable, ...LIVE_UNAVAILABLE_CAPABILITIES.filter((capability) => !capabilities.has(capability))]
      : [...unavailableCapabilities, "audio.diagnose.live-context", ...LIVE_CAPABILITIES];
    const implemented = ["server.status", "capabilities", "journeys.plan", "audio.analyze", "audio.analysis.standards", "audio.reference.compare", ...availableTools.map((name) => name.replaceAll("_", "."))];
    return {
      implemented: [...new Set(implemented)],
      unavailable: [...new Set(liveUnavailable)],
      tools: {
        available: availableTools,
        unavailable: unavailableTools,
        visible: visibleTools,
        policyDenied: policyDeniedTools,
        classes: Object.fromEntries(rows.map((row) => [row.entry.name, row.entry.policyClass])),
      },
      policy: {
        profile: this.toolPolicy.profile,
        profileClasses: TOOL_POLICY_PROFILES[this.toolPolicy.profile].classes,
        allowOverrides: [...this.toolPolicy.allow],
        denyOverrides: [...this.toolPolicy.deny],
      },
      limitations: [projectLimitation("save"), projectLimitation("open/new/export/collect/bounce")],
      live: { connected: live.connected, adapter: live.adapter, epoch: live.epoch, protocol: live.protocol, capabilities: live.capabilities },
      operations: {
        executable: live.connected && Array.isArray(live.operations) ? [...live.operations] : [],
        reserved: live.connected && Array.isArray(live.operations) ? LIVE_REGISTRY_OPERATIONS.filter((operation) => !live.operations!.includes(operation)) : [...LIVE_REGISTRY_OPERATIONS],
      },
    };
  }

  private liveStatus(id: RequestId): JsonObject {
    return response(id, { content: [{ type: "text", text: JSON.stringify(this.safeAdapterStatus()) }], isError: false });
  }

  /** Always-visible status read that first attempts a bounded refresh/reconnect
   * through the adapter: after a dropped connection the cached status would
   * otherwise hide every adapter-backed tool with no visible handler left to
   * refresh it. The response always reports the truthful current status. */
  private async liveStatusAsync(id: RequestId): Promise<JsonObject> {
    try { await this.freshStatus({ deadlineMs: Date.now() + 5_000 }); } catch { /* report the cached truthful status below */ }
    return this.liveStatus(id);
  }

  private liveSnapshot(id: RequestId): JsonObject {
    try {
      const status = this.requireConnected("session.read");
      return response(id, { content: [{ type: "text", text: JSON.stringify({ epoch: status.epoch, snapshot: this.adapter.snapshot() }) }], isError: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Snapshot unavailable. Verify the Live adapter connection and retry."); }
  }

  private liveDiscover(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["kind", "limit", "cursor"]) || !["track", "scene", "clip", "note"].includes(String(params.kind)) || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 100)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 256))) return error(id, -32602, "kind, limit, and cursor are invalid");
    try { return this.successText(id, discoverSession(this.adapter, params.kind as "track" | "scene" | "clip" | "note", (params.limit as number | undefined) ?? 50, params.cursor as string | undefined)); }
    catch (cause) { return this.adapterToolError(id, cause, "Discovery is unavailable; verify the Live adapter and request a fresh page."); }
  }

  private liveDeviceParameterPreview(id: RequestId, params: unknown): JsonObject {
    if (!this.validateDeviceParameterPreview(params)) return error(id, -32602, "deviceRef, parameterRef, and finite value are required");
    try {
      const status = this.requireConnected("device.parameter.write");
      const snapshot = this.adapter.snapshot(); const target = this.parameterTarget(snapshot, params.deviceRef, params.parameterRef);
      const authority = this.parameterAuthority(snapshot, target.parameter.ref);
      const revision = this.parameterRevision(target.parameter); const quantization = target.parameter.quantization ?? 0;
      if ((target.device.enabled as boolean | undefined) === false || (target.parameter.enabled as boolean | undefined) === false || !target.parameter.automatable) throw new Error("parameter is disabled or not supported for guarded adjustment");
      if (params.value < target.parameter.min || params.value > target.parameter.max) throw new Error("parameter value is outside authoritative bounds");
      if (quantization > 0 && Math.abs((params.value - target.parameter.min) / quantization - Math.round((params.value - target.parameter.min) / quantization)) > 1e-9) throw new Error("parameter value does not match authoritative quantization");
      const transaction: DeviceParameterTransaction = { id: `parameter_${randomBytes(18).toString("base64url")}`, confirmation: randomBytes(24).toString("base64url"), epoch: status.epoch as number, deviceRef: target.device.ref, parameterRef: target.parameter.ref, authority, priorValue: target.parameter.value, proposedValue: params.value, priorRevision: revision, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.deviceParameterTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, device: { ref: target.device.ref, name: target.device.name, kind: target.device.kind, trackRef: target.trackRef, enabled: target.device.enabled !== false }, parameter: { ref: target.parameter.ref, name: target.parameter.name, currentValue: target.parameter.value, proposedValue: params.value, min: target.parameter.min, max: target.parameter.max, quantization, enabled: target.parameter.enabled !== false, automatable: target.parameter.automatable, displayValue: target.parameter.displayValue ?? String(target.parameter.value), revision }, impact: "changes-one-published-device-parameter", confirmation: transaction.confirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Parameter preview failed without mutation; discover an enabled published numeric parameter and retry."); }
  }

  private liveDeviceParameterApply(id: RequestId, params: unknown): JsonObject {
    if (!this.validDeviceParameterApply(params)) return error(id, -32602, "transactionId, confirmation token, and idempotencyKey are required");
    const transaction = this.deviceParameterTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired device-parameter transaction");
    if (params.confirmation !== transaction.confirmation) return this.transactionError(id, "Device-parameter confirmation token is invalid");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", value: transaction.proposedValue, revision: transaction.appliedRevision, idempotent: true });
    if (transaction.state === "uncertain") return this.transactionError(id, "Device-parameter state is uncertain; perform fresh discovery before retrying");
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Device-parameter preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("device.parameter.write"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const currentSnapshot = this.adapter.snapshot(); const target = this.parameterTarget(currentSnapshot, transaction.deviceRef, transaction.parameterRef);
      if (this.parameterRevision(target.parameter) !== transaction.priorRevision || target.parameter.value !== transaction.priorValue || JSON.stringify(this.parameterAuthority(currentSnapshot, transaction.parameterRef)) !== JSON.stringify(transaction.authority)) return this.transactionError(id, "Device parameter identity or value changed since preview");
      this.adapter.invoke({ operation: "device.parameter.set", args: this.parameterMutationArgs(transaction, transaction.proposedValue, transaction.priorRevision) });
      const verifiedSnapshot = this.adapter.snapshot(); const verified = this.parameterTarget(verifiedSnapshot, transaction.deviceRef, transaction.parameterRef).parameter;
      if (verified.value !== transaction.proposedValue || this.parameterRevision(verified) <= transaction.priorRevision || JSON.stringify(this.parameterAuthority(verifiedSnapshot, transaction.parameterRef)) !== JSON.stringify(transaction.authority)) { transaction.state = "uncertain"; throw new Error("Live did not confirm the requested exact device parameter"); }
      transaction.appliedRevision = this.parameterRevision(verified); transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", value: verified.value, revision: transaction.appliedRevision, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Device-parameter apply may be uncertain; perform fresh authoritative discovery and do not retry blindly."); }
  }

  private liveSessionStructurePreview(id: RequestId, params: unknown): JsonObject {
    const proposed = this.validateStructureItems(params);
    if (!proposed) return error(id, -32602, "tracks and scenes must contain bounded, unique, valid entries");
    try {
      const status = this.requireConnected("session.structure"); const snapshot = this.adapter.snapshot();
      const existingNames = new Set([...snapshot.tracks.map((item) => item.name), ...snapshot.scenes.map((item) => item.name)]);
      if ([...proposed.tracks, ...proposed.scenes].some((item) => existingNames.has(item.name))) throw new Error("track or scene name already exists");
      const regularTracks = snapshot.tracks.filter((item) => !["return", "main", "master"].includes(item.kind));
      let availableTrackIndex = regularTracks.length;
      for (const item of proposed.tracks) { if (item.index > availableTrackIndex) return error(id, -32602, "track index exceeds the current regular-track collection"); availableTrackIndex += 1; }
      let availableSceneIndex = snapshot.scenes.length;
      for (const item of proposed.scenes) { if (item.index > availableSceneIndex) return error(id, -32602, "scene index exceeds the current scene collection"); availableSceneIndex += 1; }
      const transaction: SessionStructureTransaction = { id: `structure_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: this.structureRevision(snapshot), proposed: [...proposed.tracks, ...proposed.scenes], priorTracks: regularTracks.map((item, index) => ({ ref: item.ref, name: item.name, kind: item.kind, index })), priorScenes: snapshot.scenes.map((item, index) => ({ ref: item.ref, name: item.name, index })), expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.sessionStructureTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior: { tracks: transaction.priorTracks, scenes: transaction.priorScenes }, proposed: transaction.proposed, impact: "creates-session-structure", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Session structure preview failed without mutation; discover current names and ordering."); }
  }

  private liveSessionStructureApply(id: RequestId, params: unknown): JsonObject {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.sessionStructureTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Session-structure transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Session-structure preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("session.structure"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.snapshot(); if (this.structureRevision(current) !== transaction.revision) return this.transactionError(id, "Session structure changed since preview");
      const created: NonNullable<SessionStructureTransaction["created"]> = [];
      try {
        for (const item of transaction.proposed) {
          const operation = item.kind === "track" ? "track.create" : "scene.create";
          const expectedStructureRevision = this.structureRevision(this.adapter.snapshot());
          const result = this.adapter.invoke({ operation, args: { name: item.name, ...(item.kind === "track" ? { kind: item.trackKind } : {}), index: item.index, expectedStructureRevision } }) as { ref?: LiveRef; objectIdentity?: string; name?: string; index?: number; createdFingerprint?: string };
          if (!result?.ref || typeof result.objectIdentity !== "string" || result.name !== item.name || typeof result.createdFingerprint !== "string") throw new Error(`Live did not confirm atomically owned ${item.kind}`);
          created.push({ ref: result.ref, objectIdentity: result.objectIdentity, kind: item.kind, name: result.name, index: result.index ?? item.index, fingerprint: result.createdFingerprint });
        }
        const verified = this.adapter.snapshot(); if (!created.every((item) => (item.kind === "track" ? verified.tracks.some((track) => track.ref === item.ref && track.objectIdentity === item.objectIdentity && track.name === item.name) : verified.scenes.some((scene) => scene.ref === item.ref && scene.objectIdentity === item.objectIdentity && scene.name === item.name)) && this.sessionStructureCreatedFingerprint(verified, item.kind, item.ref) === item.fingerprint)) throw new Error("Live did not confirm unchanged atomically owned Session structure");
      } catch (cause) { for (const item of [...created].reverse()) { try { const expectedStructureRevision = this.structureRevision(this.adapter.snapshot()); this.adapter.invoke({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision, expectedObjectIdentity: item.objectIdentity } }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Session-structure apply compensation failed; read authoritative structure before retrying"); } } throw cause; }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Session-structure apply is uncertain; read authoritative tracks and scenes before retrying."); }
  }

  private liveMidiPreview(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["trackRef", "sceneIndex", "name", "length", "notes"]) || typeof params.trackRef !== "string" || !isIntegerInRange(params.sceneIndex, 0, 1023) || typeof params.name !== "string" || typeof params.length !== "number" || !Number.isFinite(params.length) || params.length <= 0 || params.length > 1024 || !Array.isArray(params.notes)) return error(id, -32602, "Invalid MIDI clip preview");
    try { return this.successText(id, this.midiTransactions.preview(params)); }
    catch (cause) { return this.adapterToolError(id, cause, "MIDI preview failed without mutation; verify the track, empty slot, and bounded notes."); }
  }

  private liveMidiApply(id: RequestId, params: unknown): JsonObject {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    try { return this.successText(id, this.midiTransactions.apply(params.transactionId as string, params.confirmation, params.idempotencyKey as string)); }
    catch (cause) { return this.adapterToolError(id, cause, "MIDI apply did not complete; read the target slot before retrying."); }
  }

  private liveArrangementPreview(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["start", "end", "startName", "endName"]) || typeof params.start !== "number" || !Number.isFinite(params.start) || params.start < 0 || params.start > 100_000 || typeof params.end !== "number" || !Number.isFinite(params.end) || params.end <= params.start || params.end > 100_000 || !isNonEmptyString(params.startName, 128) || !isNonEmptyString(params.endName, 128) || params.startName === params.endName) return error(id, -32602, "Arrangement section range and distinct names are required");
    try {
      const status = this.requireConnected("arrangement.read"); const snapshot = this.adapter.snapshot();
      const prior = snapshot.arrangement.locators.map((locator) => ({ ...locator }));
      if (prior.some((locator) => !isNonEmptyString(locator.objectIdentity, 256))) throw new Error("locator object identity is unavailable");
      if (prior.some((locator) => locator.name === params.startName || locator.name === params.endName || locator.position === params.start || locator.position === params.end)) throw new Error("Arrangement locator target collides with existing state");
      const transaction: ArrangementTransaction = { id: `arrangement_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: this.locatorRevision(snapshot), start: params.start, end: params.end, startName: params.startName, endName: params.endName, prior: prior as ArrangementTransaction["prior"], expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.arrangementTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior, proposed: [{ name: transaction.startName, position: transaction.start }, { name: transaction.endName, position: transaction.end }], impact: "creates-arrangement-locators", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement preview failed without mutation; discover locators and choose a collision-free range."); }
  }

  private liveArrangementApply(id: RequestId, params: unknown): JsonObject {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.arrangementTransactions.get(params.transactionId as string); if (!transaction) return this.transactionError(id, "Unknown or expired Arrangement transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", locators: transaction.created, idempotent: true });
    if (transaction.state === "applied") return this.transactionError(id, "Arrangement idempotency key conflicts with the applied transaction");
    if (transaction.state === "uncertain") return this.transactionError(id, "Arrangement apply is uncertain; read authoritative locators before retrying");
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Arrangement preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("arrangement.write"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      let currentSnapshot = this.adapter.snapshot();
      if (this.locatorRevision(currentSnapshot) !== transaction.revision) return this.transactionError(id, "Arrangement locators changed since preview");
      const created: NonNullable<ArrangementTransaction["created"]> = [];
      try {
        for (const proposed of [{ name: transaction.startName, position: transaction.start }, { name: transaction.endName, position: transaction.end }]) {
          const result = this.adapter.invoke({ operation: "locator.add", args: { ...proposed, expectedCollectionRevision: this.locatorRevision(currentSnapshot) } }) as { ref?: LiveRef; objectIdentity?: string; name?: string; position?: number; createdFingerprint?: string };
          if (!result.ref || !isNonEmptyString(result.objectIdentity, 256) || !isNonEmptyString(result.createdFingerprint, 64) || result.name !== proposed.name || result.position !== proposed.position) throw new Error("Live did not return exact atomically owned locator identity");
          created.push({ ref: result.ref, objectIdentity: result.objectIdentity, name: result.name, position: result.position, fingerprint: result.createdFingerprint }); currentSnapshot = this.adapter.snapshot();
        }
      } catch (cause) { for (const locator of [...created].reverse()) { try { const recoverySnapshot = this.adapter.snapshot(); this.adapter.invoke({ operation: "locator.delete", args: this.locatorDeleteArgs(recoverySnapshot, locator.ref, locator.objectIdentity) }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Arrangement apply compensation failed; read locators before retrying"); } } throw cause; }
      const authoritative = this.adapter.snapshot().arrangement.locators; if (!created.every((locator) => authoritative.some((item) => item.ref === locator.ref && item.objectIdentity === locator.objectIdentity && item.name === locator.name && item.position === locator.position && this.captureObjectFingerprint(item) === locator.fingerprint))) { transaction.state = "uncertain"; transaction.created = created; throw new Error("Live did not confirm unchanged atomically owned Arrangement locators; read authoritative state before retrying"); }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", locators: created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement apply uncertain; read authoritative locators before retrying."); }
  }

  private liveTempoPreview(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["tempo"]) || typeof params.tempo !== "number" || !Number.isFinite(params.tempo) || params.tempo < 20 || params.tempo > 999) return error(id, -32602, "tempo must be a finite number from 20 to 999");
    try {
      const status = this.requireConnected("transport");
      const snapshot = this.adapter.snapshot();
      if (typeof snapshot.set.tempo !== "number" || !Number.isFinite(snapshot.set.tempo) || !isNonEmptyString(snapshot.set.objectIdentity, 256)) throw new Error("authoritative Set tempo identity is unavailable");
      const transactionId = this.newTransactionId();
      const transaction: TempoTransaction = { id: transactionId, setRef: snapshot.set.ref, setIdentity: snapshot.set.objectIdentity, priorTempo: snapshot.set.tempo, proposedTempo: params.tempo, epoch: status.epoch as number, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.transactions.set(transactionId, transaction);
      this.evictTransactions();
      return response(id, { content: [{ type: "text", text: JSON.stringify({ transactionId, epoch: transaction.epoch, target: transaction.setRef, priorTempo: transaction.priorTempo, proposedTempo: transaction.proposedTempo, impact: "audible-transport", confirmation: "apply", expiresAt: transaction.expiresAt }) }], isError: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Tempo preview unavailable. Verify the Live adapter connection and retry."); }
  }

  private liveTempoApply(id: RequestId, params: unknown): JsonObject {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.transactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: transaction.appliedTempo, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    try {
      if ((transaction.state === "previewed" && transaction.expiresAt <= Date.now())) { this.transactions.delete(transaction.id); return this.transactionError(id, "Tempo preview expired; preview again"); }
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!current || current.objectIdentity !== transaction.setIdentity || current.tempo !== transaction.priorTempo) return this.transactionError(id, "Set identity or tempo changed since preview; preview again");
      this.adapter.invoke({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.proposedTempo, expectedTempo: transaction.priorTempo, expectedObjectIdentity: transaction.setIdentity } });
      const applied = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!applied || applied.objectIdentity !== transaction.setIdentity || applied.tempo !== transaction.proposedTempo) return this.transactionError(id, "Live did not confirm the requested exact Set tempo");
      transaction.appliedTempo = applied.tempo;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: applied.tempo, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Tempo apply failed; inspect Live state before retrying."); }
  }

  private liveUndo(id: RequestId, params: unknown): JsonObject {
    if (!this.validTransactionParams(params, "undo")) return error(id, -32602, "transactionId, confirmation=undo, and idempotencyKey are required");
    const transaction = this.transactions.get(params.transactionId as string);
    if (!transaction && String(params.transactionId).startsWith("parameter_")) {
      const parameter = this.deviceParameterTransactions.get(params.transactionId as string);
      if (!parameter || parameter.state === "uncertain") return this.transactionError(id, "Device-parameter state is uncertain; read authoritative parameter state before undo");
      if (parameter.state !== "applied" || parameter.appliedRevision === undefined) return this.transactionError(id, "Only an applied device-parameter transaction can be undone");
      if (parameter.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: parameter.id, state: "undone", idempotent: true });
      try {
        const status = this.requireConnected("device.parameter.write"); if (status.epoch !== parameter.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const currentSnapshot = this.adapter.snapshot(); const current = this.parameterTarget(currentSnapshot, parameter.deviceRef, parameter.parameterRef).parameter;
        if (current.value !== parameter.proposedValue || this.parameterRevision(current) !== parameter.appliedRevision || JSON.stringify(this.parameterAuthority(currentSnapshot, parameter.parameterRef)) !== JSON.stringify(parameter.authority)) return this.transactionError(id, "Device parameter identity or value changed after apply; undo refused");
        this.adapter.invoke({ operation: "device.parameter.set", args: this.parameterMutationArgs(parameter, parameter.priorValue, parameter.appliedRevision) });
        const restoredSnapshot = this.adapter.snapshot(); const restored = this.parameterTarget(restoredSnapshot, parameter.deviceRef, parameter.parameterRef).parameter;
        if (restored.value !== parameter.priorValue || this.parameterRevision(restored) <= parameter.appliedRevision || JSON.stringify(this.parameterAuthority(restoredSnapshot, parameter.parameterRef)) !== JSON.stringify(parameter.authority)) { parameter.state = "uncertain"; throw new Error("Live did not confirm exact device-parameter restoration"); }
        parameter.undoKey = params.idempotencyKey as string; parameter.state = "undone";
        return this.successText(id, { transactionId: parameter.id, state: "undone", value: restored.value, revision: this.parameterRevision(restored), idempotent: false });
      } catch (cause) { return this.adapterToolError(id, cause, "Device-parameter undo is uncertain; inspect authoritative parameter state."); }
    }
    if (!transaction && String(params.transactionId).startsWith("midi_")) {
      try { return this.successText(id, this.midiTransactions.undo(params.transactionId as string, params.confirmation, params.idempotencyKey as string)); }
      catch (cause) { return this.adapterToolError(id, cause, "MIDI undo refused; inspect the target clip and connection epoch."); }
    }
    if (!transaction && String(params.transactionId).startsWith("structure_")) {
      const structure = this.sessionStructureTransactions.get(params.transactionId as string);
      if (!structure || structure.state === "uncertain") return this.transactionError(id, "Session-structure state is uncertain; read authoritative tracks and scenes before undo");
      if (structure.state !== "applied" || !structure.created) return this.transactionError(id, "Only an applied Session-structure transaction can be undone");
      if (structure.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: structure.id, state: "undone", idempotent: true });
      try {
        const status = this.requireConnected("session.structure"); if (status.epoch !== structure.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const current = this.adapter.snapshot(); if (!structure.created.every((item) => item.kind === "track" ? current.tracks.some((track) => track.ref === item.ref && track.objectIdentity === item.objectIdentity && track.name === item.name) : current.scenes.some((scene) => scene.ref === item.ref && scene.objectIdentity === item.objectIdentity && scene.name === item.name))) return this.transactionError(id, "Session structure changed after apply; undo refused");
        for (const item of [...structure.created].reverse()) { const expectedStructureRevision = this.structureRevision(this.adapter.snapshot()); this.adapter.invoke({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision, expectedObjectIdentity: item.objectIdentity } }); }
        structure.state = "undone"; structure.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: structure.id, state: "undone", restored: { tracks: structure.priorTracks, scenes: structure.priorScenes }, idempotent: false });
      } catch (cause) { structure.state = "uncertain"; return this.adapterToolError(id, cause, "Session-structure undo is uncertain; inspect authoritative tracks and scenes."); }
    }
    if (!transaction && String(params.transactionId).startsWith("arrangement_")) {
      const arrangement = this.arrangementTransactions.get(params.transactionId as string);
      if (!arrangement || arrangement.state === "uncertain") return this.transactionError(id, "Arrangement state is uncertain; read authoritative locators before undo");
      if (arrangement.state !== "applied" || !arrangement.created) return this.transactionError(id, "Only an applied Arrangement transaction can be undone");
      if (arrangement.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: arrangement.id, state: "undone", idempotent: true });
      try {
        const status = this.requireConnected("arrangement.write"); if (status.epoch !== arrangement.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const current = this.adapter.snapshot().arrangement.locators;
        if (!arrangement.created.every((locator) => current.some((item) => item.ref === locator.ref && item.objectIdentity === locator.objectIdentity && item.name === locator.name && item.position === locator.position))) return this.transactionError(id, "Arrangement locator identity or content changed after apply; undo refused");
        try { for (const locator of [...arrangement.created].reverse()) { const snapshot = this.adapter.snapshot(); this.adapter.invoke({ operation: "locator.delete", args: this.locatorDeleteArgs(snapshot, locator.ref, locator.objectIdentity) }); } }
        catch (cause) { arrangement.state = "uncertain"; throw cause; }
        arrangement.state = "undone"; arrangement.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: arrangement.id, state: "undone", restored: arrangement.prior, idempotent: false });
      } catch (cause) { return this.adapterToolError(id, cause, "Arrangement undo refused; inspect authoritative locators."); }
    }
    if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: transaction.priorTempo, idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied tempo transaction can be undone");
    try {
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const current = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!current || current.objectIdentity !== transaction.setIdentity || current.tempo !== transaction.appliedTempo) return this.transactionError(id, "Set identity or tempo changed after apply; undo refused");
      this.adapter.invoke({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.priorTempo, expectedTempo: transaction.appliedTempo, expectedObjectIdentity: transaction.setIdentity } });
      const restored = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!restored || restored.objectIdentity !== transaction.setIdentity || restored.tempo !== transaction.priorTempo) return this.transactionError(id, "Live did not confirm exact Set tempo restoration");
      transaction.undoKey = params.idempotencyKey as string;
      transaction.state = "undone";
      return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: restored.tempo, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Tempo undo failed; inspect Live state before retrying."); }
  }

  private requireConnected(capability?: LiveCapability): LiveStatus {
    const status = this.safeAdapterStatus();
    if (!status.connected || status.epoch === null) throw new Error("live-adapter-unavailable");
    if (capability !== undefined && !status.capabilities.includes(capability)) throw new Error(`live-capability-unavailable:${capability}`);
    return status;
  }

  private safeAdapterStatus(): LiveStatus {
    try {
      const status = this.adapter.status();
      if (!isObject(status) || typeof status.connected !== "boolean" || !["simulator", "remote-script", "extension", "unavailable"].includes(String(status.adapter)) || status.protocol !== LIVE_PROTOCOL_VERSION || (status.epoch !== null && (!Number.isSafeInteger(status.epoch) || status.epoch < 1)) || !Array.isArray(status.capabilities) || new Set(status.capabilities).size !== status.capabilities.length || status.capabilities.some((capability) => !LIVE_CAPABILITIES.includes(capability as typeof LIVE_CAPABILITIES[number])) || (status.operations !== undefined && (!Array.isArray(status.operations) || new Set(status.operations).size !== status.operations.length || status.operations.some((operation) => typeof operation !== "string" || !LIVE_REGISTRY_OPERATIONS.includes(operation)))) || (status.provenance !== undefined && !["real-live", "fake-live", "simulator", "unknown"].includes(String(status.provenance))) || (status.registryHash !== undefined && (typeof status.registryHash !== "string" || !/^[a-f0-9]{64}$/.test(status.registryHash)))) throw new Error("invalid live adapter status");
      if (status.connected && status.epoch === null) throw new Error("connected adapter has no epoch");
      return status;
    } catch {
      return {
        connected: false,
        adapter: "unavailable",
        epoch: null,
        protocol: LIVE_PROTOCOL_VERSION,
        capabilities: [],
        reason: "live-adapter-status-unavailable",
      };
    }
  }

  private validTransactionParams(params: unknown, confirmation: "apply" | "undo"): params is JsonObject {
    return isObject(params) && hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) && isNonEmptyString(params.transactionId, 128) && params.confirmation === confirmation && isIdempotencyKey(params.idempotencyKey);
  }

  private newTransactionId(): string { return `tempo_${randomBytes(18).toString("base64url")}`; }
  private evictTransactions(): void {
    const now = Date.now();
    for (const [id, transaction] of this.transactions) if ((transaction.state === "previewed" && transaction.expiresAt <= now) || (transaction.state === "previewed" && this.transactions.size > MAX_TRANSACTIONS)) this.transactions.delete(id);
  }
  private transactionError(id: RequestId, message: string): JsonObject { return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: message, remediation: "Request a fresh tempo preview and confirm the exact transaction." }) }], isError: true }); }
  private recoveryFinalizeError(id: RequestId, reason: string): JsonObject { return response(id, { content: [{ type: "text", text: JSON.stringify({ reason, remediation: "Reconcile or manually recover the exact transaction, prove all audible work stopped, then submit the explicit finalization evidence." }) }], isError: true }); }
  private successText(id: RequestId, value: unknown): JsonObject { return response(id, { content: [{ type: "text", text: JSON.stringify(value) }], isError: false }); }
  private adapterToolError(id: RequestId, cause: unknown, remediation: string): JsonObject {
    const raw = cause instanceof Error ? cause.message : "adapter request failed";
    const reason = /^(live-|MIDI |Session |Tempo |note-|note |automation |clip-|device-|routing |mixer |rename |Arrangement |Only an applied|confirmation=|transaction|observe |file |filePath |staged |browser |probe |warp |notes |roman-numeral |drum-pattern |adapter request)/i.test(raw) && raw.length <= 160 ? raw : "adapter request failed";
    return response(id, { content: [{ type: "text", text: JSON.stringify({ reason, remediation }) }], isError: true });
  }

  private readResource(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["uri"]) || typeof params.uri !== "string") {
      return error(id, -32602, "Invalid resources/read parameters");
    }
    if (params.uri === "ableton://safety") {
      return response(id, { contents: [{ uri: params.uri, mimeType: "text/markdown", text: safetyResource }] });
    }
    if (params.uri === "ableton://capabilities") {
      return response(id, { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(this.capabilityCatalog()) }] });
    }
    if (params.uri === "ableton://max-extension") {
      return response(id, { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify({ version: "max-packet-extension/v1", available: false, bundledDevice: false, advertisedCapability: false, channelLabel: "max", transport: "authenticated-loopback-udp", operations: ["parameter.set", "xy.set", "emergency-stop"], authority: ["realtime.arm token", "ttl", "source port", "exact parameter refs"], limits: { packetBytes: 512, sustainedPerSecond: 64, burst: 16 }, compatibility: "An operator-authored Max patch may emit this packet contract; device distribution and handshake require a separately versioned adapter." }) }] });
    }
    if (params.uri === "ableton://journeys") {
      return response(id, { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(journeyResource(this.safeAdapterStatus())) }] });
    }
    if (params.uri === liveResource.uri) return response(id, { contents: [{ uri: params.uri, mimeType: liveResource.mimeType, text: liveWorkflowResource }] });
    return error(id, -32002, "Resource not found", { uri: params.uri });
  }

  private listPrompts(id: RequestId, params: unknown): JsonObject {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid prompts/list parameters");
    return response(id, { prompts });
  }

  private getPrompt(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["name", "arguments"]) || typeof params.name !== "string" || (params.arguments !== undefined && !isObject(params.arguments))) {
      return error(id, -32602, "Invalid prompts/get parameters");
    }
    const argumentsObject = params.arguments as JsonObject | undefined;
    if (params.name === "change_tempo_safely") {
      if (argumentsObject !== undefined && !hasOnly(argumentsObject, [])) return error(id, -32602, "Invalid prompt arguments");
      return response(id, { description: "Discover, preview, confirm, verify, and undo a tempo change", messages: [{ role: "user", content: textContent("Use live_status and live_snapshot, then live_tempo_preview, live_tempo_apply with explicit confirmation, live_snapshot for verification, and live_undo when restoration is requested.") }] });
    }
    const journeyPrompt = JOURNEY_PROMPTS.find((candidate) => candidate.name === params.name);
    if (journeyPrompt !== undefined) {
      if (argumentsObject === undefined || !hasOnly(argumentsObject, ["traits", "experienceLevel", "bars"]) || typeof argumentsObject.traits !== "string" || (argumentsObject.experienceLevel !== undefined && argumentsObject.experienceLevel !== "beginner" && argumentsObject.experienceLevel !== "advanced") || (argumentsObject.bars !== undefined && (typeof argumentsObject.bars !== "string" || !/^(?:[1-9]|1[0-6])$/.test(argumentsObject.bars)))) {
        return error(id, -32602, "Invalid journey prompt arguments");
      }
      const journey = params.name.replaceAll("_", "-") as JourneyId;
      try {
        const text = renderJourneyPrompt({ journey, traits: argumentsObject.traits, experienceLevel: argumentsObject.experienceLevel as ExperienceLevel | undefined, bars: argumentsObject.bars === undefined ? undefined : Number(argumentsObject.bars) }, this.safeAdapterStatus());
        return response(id, { description: journeyPrompt.description, messages: [{ role: "user", content: textContent(text) }] });
      } catch (cause) {
        return error(id, -32602, cause instanceof Error ? cause.message : "Invalid journey prompt arguments");
      }
    }
    if (params.name !== "analyze_audio") return error(id, -32002, "Prompt not found", { name: params.name });
    if (argumentsObject !== undefined && !hasOnly(argumentsObject, ["sampleRate", "channels"])) return error(id, -32602, "Invalid prompt arguments");
    const sampleRate = argumentsObject?.sampleRate;
    const channels = argumentsObject?.channels;
    const details = [
      "Use tools/call with name audio_analyze and caller-supplied little-endian float32 PCM.",
      sampleRate === undefined ? "Provide sampleRate in Hz." : `Use sampleRate=${String(sampleRate)} Hz.`,
      channels === undefined ? "Optionally provide channels." : `Use channels=${String(channels)}.`,
    ].join(" ");
    return response(id, { description: "Safe local audio analysis", messages: [{ role: "user", content: textContent(details) }] });
  }

  private isId(value: unknown): value is RequestId {
    return isNonEmptyString(value) || (typeof value === "number" && Number.isSafeInteger(value));
  }

  private utilityParams(value: unknown): boolean {
    return value === undefined || (isObject(value) && Object.keys(value).length === 0);
  }

  private requestId(value: unknown): RequestId | null {
    return this.isId(value) ? value : null;
  }
}

export async function serve(input: Readable, output: Writable, diagnostics: Writable = process.stderr, adapter: LiveAdapter = new UnavailableLiveAdapter(), options: { toolPolicy?: ToolPolicySpec | unknown } = {}): Promise<void> {
  const host = new McpHost(adapter, { toolPolicy: options.toolPolicy === undefined ? toolPolicyFromEnv() : options.toolPolicy });
  try { await serveStdio(input, output, async (line, context?: RecordContext) => {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; }
    catch { diagnostics.write("mcp-host: malformed input\n"); return JSON.stringify(error(null, -32700, "Parse error")); }
    try {
      const result = await host.handleAsync(value, context?.signal);
      return result === null ? null : JSON.stringify(result);
    } catch {
      diagnostics.write("mcp-host: internal fault\n");
      return JSON.stringify(error(null, -32603, "Internal error"));
    }
  }, { notifier: (emit) => host.setEventEmitter((value) => emit(value)), shouldStop: () => host.isShuttingDown() }); } finally {
    const close = (adapter as Partial<{ close: () => Promise<void> }>).close;
    if (typeof close === "function") await close.call(adapter);
  }
}
