import type { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { analyzePcm, decodeFloat32Le } from "./analysis.js";
import { LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_UNAVAILABLE_CAPABILITIES, UnavailableLiveAdapter, type LiveAdapter, type LiveCapability, type LiveRef, type LiveSnapshot, type LiveStatus } from "./live.js";
import { serveStdio, type RecordContext } from "./stdio.js";
import { SessionMidiTransactionManager, discoverSession } from "./transactions/session-midi.js";
import type { AsyncLiveAdapter } from "./live.js";

export const PROTOCOL_VERSION = "2025-11-25";
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_REQUEST_IDS = 4096;
const MAX_TOOL_CALLS_PER_MINUTE = 120;

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type TempoTransactionState = "previewed" | "applied" | "undone";
interface TempoTransaction {
  id: string;
  setRef: LiveRef;
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
  prior: Array<{ ref: LiveRef; name: string; position: number }>; created?: Array<{ ref: LiveRef; name: string; position: number }>;
  expiresAt: number; state: "previewed" | "applied" | "uncertain" | "undone"; applyKey?: string; undoKey?: string;
}
interface SessionStructureItem { kind: "track" | "scene"; name: string; trackKind?: "audio" | "midi"; index: number; }
interface SessionStructureTransaction {
  id: string; epoch: number; revision: string; proposed: SessionStructureItem[];
  priorTracks: Array<{ ref: LiveRef; name: string; kind: string; index: number }>;
  priorScenes: Array<{ ref: LiveRef; name: string; index: number }>;
  created?: Array<{ ref: LiveRef; kind: "track" | "scene"; name: string; index: number }>;
  expiresAt: number; state: "previewed" | "applied" | "uncertain" | "undone"; applyKey?: string; undoKey?: string;
}
interface DeviceParameterTransaction {
  id: string;
  epoch: number;
  deviceRef: LiveRef;
  parameterRef: LiveRef;
  priorValue: number;
  proposedValue: number;
  confirmation: string;
  priorRevision: number;
  appliedRevision?: number;
  applyKey?: string;
  undoKey?: string;
  expiresAt: number;
  state: "previewed" | "applied" | "uncertain" | "undone";
}
interface SessionAuditionTransaction {
  id: string;
  epoch: number;
  sceneRef: LiveRef;
  sceneRevision: string;
  playbackRevision: string;
  eligibleTargetKeys: string[];
  setName: string;
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

const REQUEST_ID_MAX_LENGTH = 128;
const SERVER_VERSION = "0.1.0";
const TRANSACTION_TTL_MS = 30_000;
const MAX_TRANSACTIONS = 256;
const AUDITION_TTL_MS = 30_000;
const MAX_AUDITION_TRANSACTIONS = 64;
const MONITORABLE_TRACK_KINDS = new Set(["regular", "audio", "midi"]);

const resources = [
  { uri: "ableton://capabilities", name: "Capability catalog", description: "Implemented and unavailable host capabilities.", mimeType: "application/json" },
  { uri: "ableton://safety", name: "Live safety contract", description: "The host's read-only and unavailable-capability guarantees.", mimeType: "text/markdown" },
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
] as const;

const safetyResource = [
  "# Live safety contract",
  "",
  "This host does not connect to Ableton Live unless an explicit adapter is installed.",
  "With the default adapter, Live is unavailable and no Live operations occur. If a configured adapter reports the exact protocol and negotiated operation capability, tempo apply and guarded undo are explicit project mutations and are never implied by read-only tools.",
  "The implemented audio workflow analyzes caller-supplied PCM locally and returns aggregates only.",
  "No read-only tool starts playback, records, writes files, or mutates a project. Mutation tools disclose their impact and require an expiring confirmation.",
].join("\n");

export { UnavailableLiveAdapter } from "./live.js";
export type { AsyncLiveAdapter, LiveAdapter, LiveRef, LiveSnapshot, LiveStatus } from "./live.js";

const implementedTools = [
  {
    name: "server_status",
    description: "Return host and Live-adapter availability without changing Live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "capabilities",
    description: "Return the negotiated read-only capability catalog.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_analyze",
    description: "Analyze caller-supplied normalized float32 PCM locally; returns aggregates only and never starts playback or mutates Live.",
    inputSchema: {
      type: "object",
      properties: {
        pcmBase64: { type: "string", description: "Little-endian float32 PCM, normalized to [-1, 1]." },
        sampleRate: { type: "integer", minimum: 8000, maximum: 384000 },
        channels: { type: "integer", minimum: 1, maximum: 32 },
        frameSize: { type: "integer", minimum: 256, maximum: 4096 },
      },
      required: ["pcmBase64", "sampleRate"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_status",
    description: "Return truthful Live-adapter status and negotiated capabilities without changing Live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_snapshot",
    description: "Read a bounded snapshot of the current Live Set through the configured adapter.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_discover",
    description: "Read bounded, deterministic parent-scoped Live objects without changing Live state.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["set", "track", "return-track", "main-track", "scene", "clip-slot", "session-clip", "arrangement-clip", "note", "locator", "device", "parameter", "selection", "routing-choice", "session-playback"] }, parent: { type: "string", minLength: 1, maxLength: 256 }, filter: { type: "object", additionalProperties: false, maxProperties: 8 }, fields: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, maxItems: 32 }, budget: { type: "integer", minimum: 1, maximum: 10000 }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 1024 } }, required: ["kind"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_session_audition_preview",
    description: "Read-only preflight for one potentially audible Session scene launch. Requires explicit output-safety evidence.",
    inputSchema: { type: "object", properties: { sceneRef: { type: "string", minLength: 1, maxLength: 256 }, setName: { type: "string", minLength: 1, maxLength: 256 }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["sceneRef", "setName", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_session_audition_apply",
    description: "Launch exactly one preflighted Session scene after exact confirmation; playback is potentially audible and is verified fresh.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_session_audition_stop",
    description: "Stop only the mapper-owned audition once and verify fresh stopped state.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128, description: "The exact unpredictable stopConfirmation token returned by preview/apply." }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_session_emergency_stop",
    description: "Independently authorized emergency stop of exactly the Session playback targets observed in fresh discovery. Requires no transaction and survives host restart.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", const: "emergency-stop" }, expectedTargets: { type: "array", items: { type: "string", minLength: 1, maxLength: 1024 }, maxItems: 256, description: "Exact active playback target keys (trackRef|clipSlotRef|sceneRef) observed in a fresh live_discover/live_snapshot read; the stop is refused if Live has anything else playing." }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["confirmation", "expectedTargets"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_device_parameter_preview",
    description: "Discover an authoritative device parameter and preview a bounded numeric change without mutation.",
    inputSchema: { type: "object", properties: { deviceRef: { type: "string", minLength: 1, maxLength: 256 }, parameterRef: { type: "string", minLength: 1, maxLength: 256 }, value: { type: "number" } }, required: ["deviceRef", "parameterRef", "value"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_device_parameter_apply",
    description: "Apply an exact confirmed device-parameter preview once, verify fresh authoritative state, and support guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", minLength: 32, maxLength: 128, description: "The exact unpredictable token returned by the matching preview." }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_session_structure_preview",
    description: "Preview bounded MIDI/audio track and named scene creation without mutation.",
    inputSchema: { type: "object", properties: { tracks: { type: "array", maxItems: 16 }, scenes: { type: "array", maxItems: 32 } }, required: ["tracks", "scenes"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_session_structure_apply",
    description: "Apply a confirmed Session-structure preview once, verify authoritative ordering, and support guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_midi_clip_preview",
    description: "Preview creation of a bounded MIDI clip in an empty Session slot.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string" }, sceneIndex: { type: "integer", minimum: 0, maximum: 1023 }, name: { type: "string", minLength: 1, maxLength: 256 }, length: { type: "number", exclusiveMinimum: 0, maximum: 1024 }, notes: { type: "array", maxItems: 512 } }, required: ["trackRef", "sceneIndex", "name", "length", "notes"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_midi_clip_apply",
    description: "Apply an exact, unexpired MIDI preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_arrangement_section_preview",
    description: "Preview two named Arrangement locators for a bounded section without mutation.",
    inputSchema: { type: "object", properties: { start: { type: "number", minimum: 0, maximum: 100000 }, end: { type: "number", minimum: 0, maximum: 100000 }, startName: { type: "string", minLength: 1, maxLength: 128 }, endName: { type: "string", minLength: 1, maxLength: 128 } }, required: ["start", "end", "startName", "endName"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_arrangement_section_apply",
    description: "Create the confirmed Arrangement section locators once and verify them authoritatively.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_tempo_preview",
    description: "Preview a reversible tempo change without mutating Live.",
    inputSchema: {
      type: "object",
      properties: { tempo: { type: "number", minimum: 20, maximum: 999 } },
      required: ["tempo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_tempo_apply",
    description: "Apply an unexpired tempo preview after explicit confirmation and verify the authoritative result.",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["transactionId", "confirmation", "idempotencyKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "live_undo",
    description: "Undo a verified tempo change only when the current state still matches its postcondition.",
    inputSchema: {
      type: "object",
      properties: { transactionId: { type: "string" }, confirmation: { type: "string", enum: ["undo"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["transactionId", "confirmation", "idempotencyKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
] as const;

const hostUnavailableCapabilities = [
  "live.mutations",
  "live.transport",
  "live.recording",
  "live.routing",
  "live.audio",
  "live.midi",
  "resources.subscribe",
  "filesystem",
  "network",
  "realtime",
  "delivery",
  "live.audio.analysis",
] as const;

const unavailableCapabilities = [...hostUnavailableCapabilities, ...LIVE_UNAVAILABLE_CAPABILITIES] as const;
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

function response(id: RequestId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function error(id: RequestId | null, code: number, message: string, data?: unknown): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textContent(text: string): JsonObject {
  return { type: "text", text };
}

export class McpHost {
  private initialized = false;
  private initializedNotification = false;
  private shuttingDown = false;
  private readonly seenIds = new Set<string>();
  private readonly idOrder: string[] = [];
  private readonly toolCallTimes: number[] = [];
  private readonly transactions = new Map<string, TempoTransaction>();
  private readonly arrangementTransactions = new Map<string, ArrangementTransaction>();
  private readonly sessionStructureTransactions = new Map<string, SessionStructureTransaction>();
  private readonly deviceParameterTransactions = new Map<string, DeviceParameterTransaction>();
  private readonly midiTransactions: SessionMidiTransactionManager;
  private readonly auditionTransactions = new Map<string, SessionAuditionTransaction>();

  public constructor(private readonly adapter: LiveAdapter = new UnavailableLiveAdapter()) { this.midiTransactions = new SessionMidiTransactionManager(adapter); }

  /** Promise-based request entrypoint for process-backed adapters. The legacy
   * handle() remains for deterministic in-process callers. */
  public async handleAsync(input: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (signal?.aborted) return null;
    if (!isObject(input) || input.method !== "tools/call" || !isObject(input.params) || typeof input.params.name !== "string") return this.handle(input);
    const name = input.params.name;
    if (![ "live_session_structure_preview", "live_session_structure_apply", "live_snapshot", "live_discover", "live_device_parameter_preview", "live_device_parameter_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop"].includes(name)) return this.handle(input);
    // Reuse the synchronous validator and request bookkeeping, then execute the
    // adapter operation asynchronously. Invalid requests never reach Live.
    const id = this.requestId(input.id);
    if (id === null || input.jsonrpc !== "2.0" || !hasOnly(input, ["jsonrpc", "id", "method", "params", "_meta"])) return error(null, -32600, "Invalid Request");
    const key = `${typeof id}:${String(id)}`;
    if (this.seenIds.has(key)) return error(id, -32600, "Duplicate request identifier");
    this.seenIds.add(key); this.idOrder.push(key);
    if (this.idOrder.length > MAX_TRACKED_REQUEST_IDS) { const expired = this.idOrder.shift(); if (expired !== undefined) this.seenIds.delete(expired); }
    if (!this.initialized) return error(id, -32002, "Server has not been initialized");
    if (!this.initializedNotification && name !== "live_status") return error(id, -32002, "Server has not received initialized notification");
    try {
      if (signal?.aborted) return null;
      if (name === "live_session_structure_preview") return await this.liveSessionStructurePreviewAsync(id, input.params.arguments);
      if (name === "live_session_structure_apply") return await this.liveSessionStructureApplyAsync(id, input.params.arguments);
      if (name === "live_snapshot") return await this.liveSnapshotAsync(id, input.params.arguments);
      if (name === "live_discover") return await this.liveDiscoverAsync(id, input.params.arguments);
      if (name === "live_session_audition_preview") return await this.liveSessionAuditionPreviewAsync(id, input.params.arguments);
      if (name === "live_session_audition_apply") return await this.liveSessionAuditionApplyAsync(id, input.params.arguments, signal);
      if (name === "live_session_audition_stop") return await this.liveSessionAuditionStopAsync(id, input.params.arguments, signal);
      if (name === "live_session_emergency_stop") return await this.liveSessionEmergencyStopAsync(id, input.params.arguments, signal);
      if (name === "live_device_parameter_preview") return await this.liveDeviceParameterPreviewAsync(id, input.params.arguments);
      if (name === "live_device_parameter_apply") return await this.liveDeviceParameterApplyAsync(id, input.params.arguments);
      if (name === "live_midi_clip_preview") return await this.liveMidiPreviewAsync(id, input.params.arguments);
      if (name === "live_midi_clip_apply") return await this.liveMidiApplyAsync(id, input.params.arguments);
      if (name === "live_arrangement_section_preview") return await this.liveArrangementPreviewAsync(id, input.params.arguments);
      if (name === "live_arrangement_section_apply") return await this.liveArrangementApplyAsync(id, input.params.arguments);
      if (name === "live_tempo_preview") return await this.liveTempoPreviewAsync(id, input.params.arguments);
      if (name === "live_tempo_apply") return await this.liveTempoApplyAsync(id, input.params.arguments);
      const result = await this.liveUndoAsync(id, input.params.arguments);
      return signal?.aborted ? null : result;
    } catch (cause) { return this.adapterToolError(id, cause, "The asynchronous Live operation failed; inspect authoritative state before retrying."); }
  }

  private asyncAdapter(): AsyncLiveAdapter {
    const value = this.adapter as Partial<AsyncLiveAdapter>;
    if (typeof value.snapshotAsync !== "function" || typeof value.discoverAsync !== "function" || typeof value.getAsync !== "function" || typeof value.setAsync !== "function" || typeof value.invokeAsync !== "function") throw new Error("live adapter does not support asynchronous operations");
    return this.adapter as AsyncLiveAdapter;
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
    return `${snapshot.tracks.map((item, index) => `${item.ref}:${item.name}:${item.kind}:${index}`).join("|")}#${snapshot.scenes.map((item, index) => `${item.ref}:${item.name}:${index}`).join("|")}`;
  }

  private async liveSessionStructurePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const proposed = this.validateStructureItems(params);
    if (!proposed) return error(id, -32602, "tracks and scenes must contain bounded, unique, valid entries");
    try {
      const status = this.requireConnected("session.structure"); const snapshot = await this.asyncAdapter().snapshotAsync();
      const existingNames = new Set([...snapshot.tracks.map((item) => item.name), ...snapshot.scenes.map((item) => item.name)]);
      if ([...proposed.tracks, ...proposed.scenes].some((item) => existingNames.has(item.name))) throw new Error("track or scene name already exists");
      const transaction: SessionStructureTransaction = {
        id: `structure_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: this.structureRevision(snapshot),
        proposed: [...proposed.tracks, ...proposed.scenes], priorTracks: snapshot.tracks.map((item, index) => ({ ref: item.ref, name: item.name, kind: item.kind, index })),
        priorScenes: snapshot.scenes.map((item, index) => ({ ref: item.ref, name: item.name, index })), expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed",
      };
      this.sessionStructureTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior: { tracks: transaction.priorTracks, scenes: transaction.priorScenes }, proposed: transaction.proposed, impact: "creates-session-structure", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Session structure preview failed without mutation; discover current names and ordering."); }
  }

  private async liveSessionStructureApplyAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.sessionStructureTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Session-structure transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Session-structure preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("session.structure"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const current = await adapter.snapshotAsync();
      if (this.structureRevision(current) !== transaction.revision) return this.transactionError(id, "Session structure changed since preview");
      const created: NonNullable<SessionStructureTransaction["created"]> = [];
      try {
        for (const item of transaction.proposed) {
          const operation = item.kind === "track" ? "track.create" : "scene.create";
          const result = await adapter.invokeAsync({ operation, args: { name: item.name, ...(item.kind === "track" ? { kind: item.trackKind } : {}), index: item.index } }) as { ref?: LiveRef; name?: string; index?: number };
          if (!result?.ref || result.name !== item.name) throw new Error(`Live did not confirm created ${item.kind}`);
          created.push({ ref: result.ref, kind: item.kind, name: result.name, index: result.index ?? item.index });
        }
        const verified = await adapter.snapshotAsync();
        if (!created.every((item) => item.kind === "track" ? verified.tracks.some((track) => track.ref === item.ref && track.name === item.name) : verified.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) throw new Error("Live did not confirm Session structure");
      } catch (cause) {
        for (const item of [...created].reverse()) { try { await adapter.invokeAsync({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref } }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Session-structure apply compensation failed; read authoritative structure before retrying"); } }
        throw cause;
      }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Session-structure apply is uncertain; read authoritative tracks and scenes before retrying."); }
  }

  private async liveSnapshotAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid live_snapshot parameters");
    const status = this.requireConnected("session.read");
    return this.successText(id, { epoch: status.epoch, snapshot: await this.asyncAdapter().snapshotAsync() });
  }

  private async liveDiscoverAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const kinds = ["set", "track", "return-track", "main-track", "scene", "clip-slot", "session-clip", "arrangement-clip", "note", "locator", "device", "parameter", "selection", "routing-choice", "session-playback"] as const;
    if (!isObject(params) || !hasOnly(params, ["kind", "parent", "filter", "fields", "budget", "limit", "cursor"]) || !kinds.includes(params.kind as typeof kinds[number]) || (["clip-slot", "session-clip", "arrangement-clip", "note", "device", "parameter", "routing-choice"].includes(String(params.kind)) && !isNonEmptyString(params.parent, 256)) || (params.parent !== undefined && !isNonEmptyString(params.parent, 256)) || (params.filter !== undefined && (!isObject(params.filter) || Object.keys(params.filter).length > 8)) || (params.fields !== undefined && (!Array.isArray(params.fields) || params.fields.length > 32 || params.fields.some((field) => !isNonEmptyString(field, 64)))) || (params.budget !== undefined && !isIntegerInRange(params.budget, 1, 10_000)) || (params.limit !== undefined && !isIntegerInRange(params.limit, 1, 100)) || (params.cursor !== undefined && !isNonEmptyString(params.cursor, 1024))) return error(id, -32602, "kind, parent, filters, fields, budget, limit, and cursor are invalid");
    return this.successText(id, await this.asyncAdapter().discoverAsync({ kind: params.kind as import("./live.js").LiveDiscoveryKind, parent: params.parent as string | undefined, filter: params.filter as Record<string, unknown> | undefined, fields: params.fields as string[] | undefined, budget: (params.budget as number | undefined) ?? 1000, limit: (params.limit as number | undefined) ?? 50, cursor: params.cursor as string | undefined }));
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
    if (tracks.some((track) => MONITORABLE_TRACK_KINDS.has(String(track.kind)) ? (track.armed !== false || track.monitoringState !== "off") : (track.armed === true || track.monitoringState === "in"))) throw new Error("armed, input-monitored, or unknown-monitoring target prevents audition");
    if (playback.firedTargets.length > 0 || playback.playingTargets.length > 0) throw new Error("existing Session playback prevents audition");
    const operations = status.operations ?? [];
    if (!(operations.includes("session.audition-launch") && operations.includes("session.audition-stop") && operations.includes("session.emergency-stop") && operations.includes("session.playback"))) throw new Error("required guarded audition, emergency stop, and playback inspection operations are unavailable");
  }

  private async liveSessionAuditionPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["sceneRef", "setName", "outputSafety"]) || !isNonEmptyString(params.sceneRef, 256) || !isNonEmptyString(params.setName, 256) || !isObject(params.outputSafety)) return error(id, -32602, "sceneRef, setName, and outputSafety are required");
    try {
      const status = this.requireConnected("session.read");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const state = this.auditionSnapshot(snapshot, params.sceneRef as LiveRef);
      this.validateAuditionSafety(status, state.set, state.tracks, state.playback, params.outputSafety, params.setName);
      if (state.eligibleTargetKeys.length === 0) throw new Error("audition scene has no authoritative playable clip slots");
      const transaction: SessionAuditionTransaction = { id: `audition_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, sceneRef: params.sceneRef as LiveRef, sceneRevision: JSON.stringify(state.scene), playbackRevision: state.playbackRevision, eligibleTargetKeys: state.eligibleTargetKeys, setName: params.setName, outputSafety: structuredClone(params.outputSafety as JsonObject), confirmation: randomBytes(32).toString("base64url"), stopConfirmation: randomBytes(32).toString("base64url"), expiresAt: Date.now() + AUDITION_TTL_MS, state: "previewed" };
      this.retainAuditionTransaction(transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, scene: state.scene, sceneRevision: transaction.sceneRevision, playbackRevision: transaction.playbackRevision, eligibleTargets: transaction.eligibleTargetKeys, disposableSet: { expected: transaction.setName, observed: state.set.name, matches: true }, baseline: { stopped: true, arrangementRecord: false, sessionRecord: false }, launchQuantization: state.playback.transport.launchQuantization, outputSafety: transaction.outputSafety, audibleImpact: "potentially-audible-session-scene-launch", confirmation: transaction.confirmation, stopConfirmation: transaction.stopConfirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Audition preview refused; obtain fresh authoritative discovery and explicit output-safety evidence."); }
  }

  private retainAuditionTransaction(transaction: SessionAuditionTransaction): void {
    const now = Date.now();
    for (const [key, candidate] of this.auditionTransactions) if (candidate.expiresAt <= now && candidate.state !== "applying" && candidate.state !== "stopping") this.auditionTransactions.delete(key);
    while (this.auditionTransactions.size >= MAX_AUDITION_TRANSACTIONS) {
      const oldest = [...this.auditionTransactions].find(([, candidate]) => candidate.state !== "applying" && candidate.state !== "stopping");
      if (!oldest) throw new Error("audition transaction capacity is exhausted by in-flight auditions");
      this.auditionTransactions.delete(oldest[0]);
    }
    this.auditionTransactions.set(transaction.id, transaction);
  }

  private async liveSessionAuditionApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isNonEmptyString(params.idempotencyKey, 128)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
    const transaction = this.auditionTransactions.get(params.transactionId as string);
    if (!transaction || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired audition transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation) return this.successText(id, { transactionId: transaction.id, state: "applied", launched: transaction.launched, stopConfirmation: transaction.stopConfirmation, idempotent: true });
    if (transaction.state === "applying") {
      if (transaction.applyKey !== params.idempotencyKey || transaction.confirmation !== params.confirmation || !transaction.inflight) return this.transactionError(id, "Audition apply is already in progress with a different request");
      try {
        const outcome = await transaction.inflight;
        return this.successText(id, { ...outcome, idempotent: true });
      } catch (cause) {
        return this.adapterToolError(id, cause, "Audition state is uncertain; do not retry. Perform fresh playback discovery before stopping or recovering.");
      }
    }
    if (transaction.state !== "previewed" || transaction.confirmation !== params.confirmation) return this.transactionError(id, "Exact audition confirmation is required");
    if (signal?.aborted) return null;
    // Reserve the transaction synchronously before any await so a concurrent
    // duplicate cannot observe "previewed" and dispatch a second launch.
    transaction.state = "applying";
    transaction.applyKey = params.idempotencyKey as string;
    const inflight = this.dispatchAuditionApply(transaction, signal);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Audition state is uncertain; do not retry. Perform fresh playback discovery before stopping or recovering.");
    }
  }

  private async dispatchAuditionApply(transaction: SessionAuditionTransaction, signal?: AbortSignal): Promise<JsonObject> {
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + 5_000 };
      const before = await adapter.snapshotAsync(context);
      const state = this.auditionSnapshot(before, transaction.sceneRef);
      if (JSON.stringify(state.scene) !== transaction.sceneRevision || state.playbackRevision !== transaction.playbackRevision) throw new Error("audition state changed since preview");
      // Safety evidence and all dynamic preconditions are rechecked immediately
      // before the single potentially audible dispatch; the mapper then rechecks
      // the same conditions atomically on Live's main thread before firing.
      this.validateAuditionSafety(status, state.set, state.tracks, state.playback, transaction.outputSafety, transaction.setName);
      if (signal?.aborted) throw new Error("audition apply cancelled before dispatch");
      const scene = state.scene as { name?: unknown; index?: unknown };
      const result = await adapter.invokeAsync({ operation: "session.audition-launch", args: { ref: transaction.sceneRef, setName: transaction.setName, sceneName: scene.name, sceneIndex: scene.index, playbackRevision: state.playback.revision, eligibleTargets: transaction.eligibleTargetKeys } }, context) as { launched?: unknown; targets?: unknown };
      const targets = Array.isArray(result?.targets) ? result.targets : [];
      if (result?.launched !== transaction.sceneRef || targets.length === 0 || targets.some((target) => !isObject(target) || target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("guarded launch result does not match the audition target");
      transaction.launched = { launched: result.launched, targets };
      const after = await adapter.snapshotAsync(context);
      const activeTargets = [...after.playback.firedTargets, ...after.playback.playingTargets];
      if (activeTargets.length === 0 || activeTargets.some((target) => target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("scene launch acknowledged without exact fresh fired or playing target verification");
      transaction.state = "applied";
      return { transactionId: transaction.id, state: "applied", launched: transaction.launched, verified: { sceneRef: transaction.sceneRef, firedOrPlaying: true }, stopConfirmation: transaction.stopConfirmation };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A failure proven to be pre-dispatch restores the preview; anything else
      // is an explicitly uncertain audible state.
      transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain";
      throw cause;
    }
  }

  private async liveSessionAuditionStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isNonEmptyString(params.idempotencyKey, 128)) return error(id, -32602, "transactionId, exact stop confirmation, and idempotencyKey are required");
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
    if (signal?.aborted) return null;
    transaction.state = "stopping";
    transaction.stopKey = params.idempotencyKey as string;
    const inflight = this.dispatchAuditionStop(transaction, signal);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Stop is uncertain; do not retry. Perform fresh authoritative playback discovery.");
    }
  }

  private async dispatchAuditionStop(transaction: SessionAuditionTransaction, signal?: AbortSignal): Promise<JsonObject> {
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; stop refused");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + 5_000 };
      const before = this.auditionSnapshot(await adapter.snapshotAsync(context), transaction.sceneRef);
      if (JSON.stringify(before.scene) !== transaction.sceneRevision || before.set.name !== transaction.setName || before.playback.transport.arrangementRecord !== false || before.playback.transport.sessionRecord !== false || before.tracks.some((track) => MONITORABLE_TRACK_KINDS.has(String(track.kind)) ? (track.armed !== false || track.monitoringState !== "off") : (track.armed === true || track.monitoringState === "in"))) throw new Error("audition ownership or safety state changed; stop refused");
      const activeTargets = [...before.playback.firedTargets, ...before.playback.playingTargets];
      if (activeTargets.length > 0) {
        if (activeTargets.some((target) => target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("owned playback is unknown or external playback is active; global stop refused");
        if (signal?.aborted) throw new Error("audition stop cancelled before dispatch");
        await adapter.invokeAsync({ operation: "session.audition-stop", args: { ref: transaction.sceneRef, setName: transaction.setName, eligibleTargets: transaction.eligibleTargetKeys } }, context);
      }
      const state = await adapter.snapshotAsync(context);
      if (state.playback.transport.playing !== false || state.playback.firedTargets.length > 0 || state.playback.playingTargets.length > 0) throw new Error("stop acknowledged without fresh stopped verification");
      transaction.state = "stopped";
      return { transactionId: transaction.id, state: "stopped", restoredBaseline: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      transaction.state = /cancelled before dispatch/.test(message) ? "applied" : "uncertain";
      throw cause;
    }
  }

  private async liveSessionEmergencyStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["confirmation", "expectedTargets", "idempotencyKey"]) || params.confirmation !== "emergency-stop" || !Array.isArray(params.expectedTargets) || params.expectedTargets.length > 256 || new Set(params.expectedTargets).size !== params.expectedTargets.length || !params.expectedTargets.every((item) => isNonEmptyString(item, 1024)) || (params.idempotencyKey !== undefined && !isNonEmptyString(params.idempotencyKey, 128))) return error(id, -32602, "confirmation=emergency-stop and the exact freshly observed active playback targets are required");
    try {
      const status = this.requireConnected("session.read");
      if (!(status.operations ?? []).includes("session.emergency-stop")) throw new Error("emergency stop operation is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + 5_000 };
      const snapshot = await adapter.snapshotAsync(context);
      const playback = snapshot.playback;
      if (!playback || !Array.isArray(playback.firedTargets) || !Array.isArray(playback.playingTargets)) throw new Error("authoritative Session playback is unavailable");
      const activeKeys = [...new Set([...playback.firedTargets, ...playback.playingTargets].map((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))].sort();
      const expectedKeys = [...(params.expectedTargets as string[])].sort();
      if (activeKeys.length !== expectedKeys.length || activeKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("expected targets do not match fresh authoritative playback; perform fresh discovery");
      if (signal?.aborted) return null;
      const result = await adapter.invokeAsync({ operation: "session.emergency-stop", args: { expectedTargets: activeKeys } }, context) as { stopped?: unknown; stoppedTargets?: unknown };
      const after = await adapter.snapshotAsync(context);
      if (after.playback.transport.playing !== false || after.playback.firedTargets.length > 0 || after.playback.playingTargets.length > 0) throw new Error("emergency stop was not confirmed by fresh authoritative state");
      return this.successText(id, { stopped: true, stoppedTargets: result.stoppedTargets ?? activeKeys });
    } catch (cause) { return this.adapterToolError(id, cause, "Emergency stop is uncertain; perform fresh authoritative playback discovery before any further action."); }
  }

  private parameterTarget(snapshot: LiveSnapshot, deviceRef: string, parameterRef: string): { device: LiveSnapshot["tracks"][number]["devices"][number]; parameter: LiveSnapshot["tracks"][number]["devices"][number]["parameters"][number]; trackRef: LiveRef } {
    for (const track of snapshot.tracks) {
      const device = track.devices.find((item) => item.ref === deviceRef);
      const parameter = device?.parameters.find((item) => item.ref === parameterRef);
      if (device && parameter) return { device, parameter, trackRef: track.ref };
    }
    throw new Error("device and parameter references are not authoritative children");
  }

  private parameterRevision(parameter: { ref: LiveRef; value: number; revision?: number }): number { return parameter.revision ?? 1; }

  private validateDeviceParameterPreview(params: unknown): params is { deviceRef: string; parameterRef: string; value: number } {
    return isObject(params) && hasOnly(params, ["deviceRef", "parameterRef", "value"]) && isNonEmptyString(params.deviceRef, 256) && isNonEmptyString(params.parameterRef, 256) && typeof params.value === "number" && Number.isFinite(params.value);
  }

  private validDeviceParameterApply(params: unknown): params is JsonObject {
    return isObject(params) && hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) && isNonEmptyString(params.transactionId, 128) && isNonEmptyString(params.confirmation, 128) && isNonEmptyString(params.idempotencyKey, 128);
  }

  private async liveDeviceParameterPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validateDeviceParameterPreview(params)) return error(id, -32602, "deviceRef, parameterRef, and finite value are required");
    try {
      const status = this.requireConnected("parameters");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const target = this.parameterTarget(snapshot, params.deviceRef, params.parameterRef);
      const revision = this.parameterRevision(target.parameter);
      if ((target.device.enabled as boolean | undefined) === false || (target.parameter.enabled as boolean | undefined) === false || !target.parameter.automatable) throw new Error("parameter is disabled or not supported for guarded adjustment");
      const quantization = target.parameter.quantization ?? 0;
      if (params.value < target.parameter.min || params.value > target.parameter.max) throw new Error("parameter value is outside authoritative bounds");
      if (quantization > 0 && Math.abs((params.value - target.parameter.min) / quantization - Math.round((params.value - target.parameter.min) / quantization)) > 1e-9) throw new Error("parameter value does not match authoritative quantization");
      const transaction: DeviceParameterTransaction = { id: `parameter_${randomBytes(18).toString("base64url")}`, confirmation: randomBytes(24).toString("base64url"), epoch: status.epoch as number, deviceRef: target.device.ref, parameterRef: target.parameter.ref, priorValue: target.parameter.value, proposedValue: params.value, priorRevision: revision, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.deviceParameterTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, device: { ref: target.device.ref, name: target.device.name, kind: target.device.kind, trackRef: target.trackRef, enabled: target.device.enabled !== false }, parameter: { ref: target.parameter.ref, name: target.parameter.name, currentValue: target.parameter.value, proposedValue: params.value, min: target.parameter.min, max: target.parameter.max, quantization, enabled: target.parameter.enabled !== false, automatable: target.parameter.automatable, displayValue: target.parameter.displayValue ?? String(target.parameter.value), revision }, impact: "changes-one-published-device-parameter", confirmation: transaction.confirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Parameter preview failed without mutation; discover an enabled published numeric parameter and retry."); }
  }

  private async liveDeviceParameterApplyAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validDeviceParameterApply(params)) return error(id, -32602, "transactionId, confirmation token, and idempotencyKey are required");
    const transaction = this.deviceParameterTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired device-parameter transaction");
    if (params.confirmation !== transaction.confirmation) return this.transactionError(id, "Device-parameter confirmation token is invalid");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", value: transaction.proposedValue, revision: transaction.appliedRevision, idempotent: true });
    if (transaction.state === "uncertain") return this.transactionError(id, "Device-parameter state is uncertain; perform fresh discovery before retrying");
    if (transaction.state !== "previewed" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Device-parameter preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("parameters");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const target = this.parameterTarget(await adapter.snapshotAsync(), transaction.deviceRef, transaction.parameterRef);
      const currentRevision = this.parameterRevision(target.parameter);
      if (currentRevision !== transaction.priorRevision || target.parameter.value !== transaction.priorValue) return this.transactionError(id, "Device parameter changed since preview");
      await adapter.setAsync(transaction.parameterRef, "value", transaction.proposedValue);
      const verifiedSnapshot = await adapter.snapshotAsync();
      const verified = this.parameterTarget(verifiedSnapshot, transaction.deviceRef, transaction.parameterRef).parameter;
      if (verified.value !== transaction.proposedValue || this.parameterRevision(verified) <= currentRevision) { transaction.state = "uncertain"; throw new Error("Live did not confirm the requested device parameter"); }
      transaction.appliedRevision = this.parameterRevision(verified); transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", value: verified.value, revision: transaction.appliedRevision, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Device-parameter apply may be uncertain; perform fresh authoritative discovery and do not retry blindly."); }
  }

  private async liveMidiPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["trackRef", "sceneIndex", "name", "length", "notes"]) || typeof params.trackRef !== "string" || !isIntegerInRange(params.sceneIndex, 0, 1023) || typeof params.name !== "string" || typeof params.length !== "number" || !Number.isFinite(params.length) || params.length <= 0 || params.length > 1024 || !Array.isArray(params.notes)) return error(id, -32602, "Invalid MIDI clip preview");
    return this.successText(id, await this.midiTransactions.previewAsync(params));
  }

  private async liveMidiApplyAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    return this.successText(id, await this.midiTransactions.applyAsync(params.transactionId as string, params.confirmation, params.idempotencyKey as string));
  }

  private async liveArrangementPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["start", "end", "startName", "endName"]) || typeof params.start !== "number" || !Number.isFinite(params.start) || params.start < 0 || params.start > 100_000 || typeof params.end !== "number" || !Number.isFinite(params.end) || params.end <= params.start || params.end > 100_000 || !isNonEmptyString(params.startName, 128) || !isNonEmptyString(params.endName, 128) || params.startName === params.endName) return error(id, -32602, "Arrangement section range and distinct names are required");
    try {
      const status = this.requireConnected("arrangement.read");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const prior = snapshot.arrangement.locators.map((locator) => ({ ...locator }));
      if (prior.some((locator) => locator.name === params.startName || locator.name === params.endName || locator.position === params.start || locator.position === params.end)) throw new Error("Arrangement locator target collides with existing state");
      const transaction: ArrangementTransaction = { id: `arrangement_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: `${status.epoch}:${prior.map((locator) => `${locator.ref}:${locator.name}:${locator.position}`).join("|")}`, start: params.start, end: params.end, startName: params.startName, endName: params.endName, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.arrangementTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior, proposed: [{ name: transaction.startName, position: transaction.start }, { name: transaction.endName, position: transaction.end }], impact: "creates-arrangement-locators", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement preview failed without mutation; discover locators and choose a collision-free range."); }
  }

  private async liveArrangementApplyAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.arrangementTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Arrangement transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", locators: transaction.created, idempotent: true });
    if (transaction.state === "applied") return this.transactionError(id, "Arrangement idempotency key conflicts with the applied transaction");
    if (transaction.state === "uncertain") return this.transactionError(id, "Arrangement apply is uncertain; read authoritative locators before retrying");
    if (transaction.state !== "previewed" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Arrangement preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("arrangement.write");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const current = (await adapter.snapshotAsync()).arrangement.locators;
      const revision = `${status.epoch}:${current.map((locator) => `${locator.ref}:${locator.name}:${locator.position}`).join("|")}`;
      if (revision !== transaction.revision) return this.transactionError(id, "Arrangement locators changed since preview");
      const created: Array<{ ref: LiveRef; name: string; position: number }> = [];
      try {
        created.push(await adapter.invokeAsync({ operation: "locator.add", args: { name: transaction.startName, position: transaction.start } }) as { ref: LiveRef; name: string; position: number });
        created.push(await adapter.invokeAsync({ operation: "locator.add", args: { name: transaction.endName, position: transaction.end } }) as { ref: LiveRef; name: string; position: number });
      } catch (cause) {
        for (const locator of created) { try { await adapter.invokeAsync({ operation: "locator.delete", args: { ref: locator.ref } }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Arrangement apply compensation failed; read locators before retrying"); } }
        throw cause;
      }
      const authoritative = (await adapter.snapshotAsync()).arrangement.locators;
      if (!created.every((locator) => authoritative.some((item) => item.ref === locator.ref && item.name === locator.name && item.position === locator.position))) { transaction.state = "uncertain"; transaction.created = created; throw new Error("Live did not confirm Arrangement locators; read authoritative state before retrying"); }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", locators: created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement apply uncertain; read authoritative locators before retrying."); }
  }

  private async liveTempoPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["tempo"]) || typeof params.tempo !== "number" || !Number.isFinite(params.tempo) || params.tempo < 20 || params.tempo > 999) return error(id, -32602, "tempo must be a finite number from 20 to 999");
    const status = this.requireConnected("transport"); const snapshot = await this.asyncAdapter().snapshotAsync();
    if (typeof snapshot.set.tempo !== "number" || !Number.isFinite(snapshot.set.tempo)) return this.adapterToolError(id, new Error("authoritative tempo is unavailable"), "Tempo preview requires fresh authoritative tempo evidence.");
    const transactionId = this.newTransactionId();
    const transaction: TempoTransaction = { id: transactionId, setRef: snapshot.set.ref, priorTempo: snapshot.set.tempo, proposedTempo: params.tempo, epoch: status.epoch as number, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
    this.transactions.set(transactionId, transaction); this.evictTransactions();
    return this.successText(id, { transactionId, epoch: transaction.epoch, target: transaction.setRef, priorTempo: transaction.priorTempo, proposedTempo: transaction.proposedTempo, impact: "audible-transport", confirmation: "apply", expiresAt: transaction.expiresAt });
  }

  private async liveTempoApplyAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.transactions.get(params.transactionId as string); if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: transaction.appliedTempo, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (transaction.expiresAt <= Date.now()) return this.transactionError(id, "Tempo preview expired; preview again");
    const status = this.requireConnected("transport"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
    const adapter = this.asyncAdapter(); const current = await adapter.getAsync(transaction.setRef) as LiveSnapshot["set"] | undefined;
    if (!current || current.tempo !== transaction.priorTempo) return this.transactionError(id, "Tempo changed since preview; preview again");
    await adapter.setAsync(transaction.setRef, "tempo", transaction.proposedTempo); const applied = await adapter.getAsync(transaction.setRef) as LiveSnapshot["set"] | undefined;
    if (!applied || applied.tempo !== transaction.proposedTempo) return this.transactionError(id, "Live did not confirm the requested tempo");
    transaction.appliedTempo = applied.tempo; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
    return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: applied.tempo, epoch: transaction.epoch, idempotent: false });
  }

  private async liveUndoAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "undo")) return error(id, -32602, "transactionId, confirmation=undo, and idempotencyKey are required");
    const transaction = this.transactions.get(params.transactionId as string);
    if (!transaction && String(params.transactionId).startsWith("midi_")) return this.successText(id, await this.midiTransactions.undoAsync(params.transactionId as string, params.confirmation, params.idempotencyKey as string));
    if (!transaction && String(params.transactionId).startsWith("structure_")) {
      const structure = this.sessionStructureTransactions.get(params.transactionId as string);
      if (!structure || structure.state === "uncertain") return this.transactionError(id, "Session-structure state is uncertain; read authoritative tracks and scenes before undo");
      if (structure.state !== "applied" || !structure.created) return this.transactionError(id, "Only an applied Session-structure transaction can be undone");
      if (structure.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: structure.id, state: "undone", idempotent: true });
      const status = this.requireConnected("session.structure"); if (status.epoch !== structure.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter(); const current = await adapter.snapshotAsync();
      if (!structure.created.every((item) => item.kind === "track" ? current.tracks.some((track) => track.ref === item.ref && track.name === item.name) : current.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) return this.transactionError(id, "Session structure changed after apply; undo refused");
      try { for (const item of [...structure.created].reverse()) await adapter.invokeAsync({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref } }); }
      catch (cause) { structure.state = "uncertain"; return this.adapterToolError(id, cause, "Session-structure undo is uncertain; inspect authoritative tracks and scenes."); }
      structure.state = "undone"; structure.undoKey = params.idempotencyKey as string;
      return this.successText(id, { transactionId: structure.id, state: "undone", restored: { tracks: structure.priorTracks, scenes: structure.priorScenes }, idempotent: false });
    }
    if (!transaction && String(params.transactionId).startsWith("arrangement_")) {
      const arrangement = this.arrangementTransactions.get(params.transactionId as string);
      if (!arrangement || arrangement.state === "uncertain") return this.transactionError(id, "Arrangement state is uncertain; read authoritative locators before undo");
      if (arrangement.state !== "applied" || !arrangement.created) return this.transactionError(id, "Only an applied Arrangement transaction can be undone");
      if (arrangement.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: arrangement.id, state: "undone", idempotent: true });
      try {
        const status = this.requireConnected("arrangement.write");
        if (status.epoch !== arrangement.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter();
        const current = (await adapter.snapshotAsync()).arrangement.locators;
        if (!arrangement.created.every((locator) => current.some((item) => item.ref === locator.ref && item.name === locator.name && item.position === locator.position))) return this.transactionError(id, "Arrangement locators changed after apply; undo refused");
        try { for (const locator of arrangement.created) await adapter.invokeAsync({ operation: "locator.delete", args: { ref: locator.ref } }); }
        catch (cause) { arrangement.state = "uncertain"; throw cause; }
        arrangement.state = "undone"; arrangement.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: arrangement.id, state: "undone", restored: arrangement.prior, idempotent: false });
      } catch (cause) { return this.adapterToolError(id, cause, "Arrangement undo refused; inspect authoritative locators."); }
    }
    if (!transaction && String(params.transactionId).startsWith("parameter_")) {
      const parameter = this.deviceParameterTransactions.get(params.transactionId as string);
      if (!parameter || parameter.state === "uncertain") return this.transactionError(id, "Device-parameter state is uncertain; read authoritative parameter state before undo");
      if (parameter.state !== "applied" || parameter.appliedRevision === undefined) return this.transactionError(id, "Only an applied device-parameter transaction can be undone");
      if (parameter.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: parameter.id, state: "undone", idempotent: true });
      try {
        const status = this.requireConnected("parameters"); if (status.epoch !== parameter.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const current = this.parameterTarget(await adapter.snapshotAsync(), parameter.deviceRef, parameter.parameterRef).parameter;
        if (current.value !== parameter.proposedValue || this.parameterRevision(current) !== parameter.appliedRevision) return this.transactionError(id, "Device parameter changed after apply; undo refused");
        await adapter.setAsync(parameter.parameterRef, "value", parameter.priorValue);
        const restored = this.parameterTarget(await adapter.snapshotAsync(), parameter.deviceRef, parameter.parameterRef).parameter;
        if (restored.value !== parameter.priorValue || this.parameterRevision(restored) <= parameter.appliedRevision) { parameter.state = "uncertain"; throw new Error("Live did not confirm device-parameter restoration"); }
        parameter.undoKey = params.idempotencyKey as string; parameter.state = "undone";
        return this.successText(id, { transactionId: parameter.id, state: "undone", value: restored.value, revision: this.parameterRevision(restored), idempotent: false });
      } catch (cause) { return this.adapterToolError(id, cause, "Device-parameter undo is uncertain; inspect authoritative parameter state."); }
    }
    if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: transaction.priorTempo, idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied tempo transaction can be undone");
    const status = this.requireConnected("transport"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
    const adapter = this.asyncAdapter(); const current = await adapter.getAsync(transaction.setRef) as LiveSnapshot["set"] | undefined;
    if (!current || current.tempo !== transaction.appliedTempo) return this.transactionError(id, "Tempo changed after apply; undo refused");
    await adapter.setAsync(transaction.setRef, "tempo", transaction.priorTempo); const restored = await adapter.getAsync(transaction.setRef) as LiveSnapshot["set"] | undefined;
    if (!restored || restored.tempo !== transaction.priorTempo) return this.transactionError(id, "Live did not confirm tempo restoration");
    transaction.undoKey = params.idempotencyKey as string; transaction.state = "undone";
    return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: restored.tempo, epoch: transaction.epoch, idempotent: false });
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
    if (!this.initialized && input.method !== "initialize") {
      return error(id, -32002, "Server has not been initialized");
    }
    if (!this.initializedNotification && input.method !== "initialize" && input.method !== "ping") {
      return error(id, -32002, "Server has not received initialized notification");
    }
    switch (input.method) {
      case "initialize": return this.initialize(id, input.params);
      case "ping": return this.utilityParams(input.params) ? response(id, {}) : error(id, -32602, "Invalid ping parameters");
      case "tools/list": return this.utilityParams(input.params) ? response(id, { tools: implementedTools }) : error(id, -32602, "Invalid tools/list parameters");
      case "tools/call": return this.callTool(id, input.params);
      case "resources/list": return this.listResources(id, input.params);
      case "resources/read": return this.readResource(id, input.params);
      case "prompts/list": return this.listPrompts(id, input.params);
      case "prompts/get": return this.getPrompt(id, input.params);
      default: return error(id, -32601, "Method not found");
    }
  }

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
      capabilities: { tools: {}, resources: {}, prompts: {} },
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
    const argumentTools = new Set(["audio_analyze", "live_discover", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_device_parameter_preview", "live_device_parameter_apply", "live_session_structure_preview", "live_session_structure_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo"]);
    if (!argumentTools.has(params.name) && params.arguments !== undefined && Object.keys(params.arguments as JsonObject).length !== 0) {
      return error(id, -32602, "Tool arguments must be an empty object");
    }
    if (params.name === "server_status") {
      return response(id, { content: [{ type: "text", text: JSON.stringify({ host: "ready", live: this.safeAdapterStatus() }) }], isError: false });
    }
    if (params.name === "capabilities") {
      return response(id, { content: [{ type: "text", text: JSON.stringify(this.capabilityCatalog()) }], isError: false });
    }
    if (params.name === "live_status") return this.liveStatus(id);
    if (params.name === "live_snapshot") return this.liveSnapshot(id);
    if (params.name === "live_discover") return this.liveDiscover(id, params.arguments);
    if (["live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop"].includes(params.name)) return error(id, -32001, "Session audition requires the asynchronous host request path");
    if (params.name === "live_device_parameter_preview") return this.liveDeviceParameterPreview(id, params.arguments);
    if (params.name === "live_device_parameter_apply") return this.liveDeviceParameterApply(id, params.arguments);
    if (params.name === "live_session_structure_preview") return this.liveSessionStructurePreview(id, params.arguments);
    if (params.name === "live_session_structure_apply") return this.liveSessionStructureApply(id, params.arguments);
    if (params.name === "live_midi_clip_preview") return this.liveMidiPreview(id, params.arguments);
    if (params.name === "live_midi_clip_apply") return this.liveMidiApply(id, params.arguments);
    if (params.name === "live_arrangement_section_preview") return this.liveArrangementPreview(id, params.arguments);
    if (params.name === "live_arrangement_section_apply") return this.liveArrangementApply(id, params.arguments);
    if (params.name === "live_tempo_preview") return this.liveTempoPreview(id, params.arguments);
    if (params.name === "live_tempo_apply") return this.liveTempoApply(id, params.arguments);
    if (params.name === "live_undo") return this.liveUndo(id, params.arguments);
    if (params.name === "audio_analyze") {
      const args = params.arguments;
      if (
        !isObject(args) ||
        !hasOnly(args, ["pcmBase64", "sampleRate", "channels", "frameSize"]) ||
        typeof args.pcmBase64 !== "string" ||
        !isIntegerInRange(args.sampleRate, 8_000, 384_000) ||
        (args.channels !== undefined && !isIntegerInRange(args.channels, 1, 32)) ||
        (args.frameSize !== undefined && !isIntegerInRange(args.frameSize, 256, 4_096))
      ) {
        return error(id, -32602, "audio_analyze requires pcmBase64 and sampleRate");
      }
      const now = Date.now();
      while (this.toolCallTimes.length > 0 && now - (this.toolCallTimes[0] ?? now) >= 60_000) this.toolCallTimes.shift();
      if (this.toolCallTimes.length >= MAX_TOOL_CALLS_PER_MINUTE) return error(id, -32029, "Tool invocation rate limit exceeded");
      this.toolCallTimes.push(now);
      try {
        const result = analyzePcm({
          samples: decodeFloat32Le(args.pcmBase64),
          sampleRate: args.sampleRate,
          channels: args.channels as number | undefined,
          frameSize: args.frameSize as number | undefined,
        });
        return response(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "invalid audio input";
        return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: message, remediation: "Provide bounded little-endian float32 PCM normalized to [-1, 1]." }) }], isError: true });
      }
    }
    return error(id, -32601, "Tool not found");
  }

  private listResources(id: RequestId, params: unknown): JsonObject {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid resources/list parameters");
    return response(id, { resources: [...resources, liveResource] });
  }

  private capabilityCatalog(): JsonObject {
    const live = this.safeAdapterStatus();
    const liveImplemented = live.connected ? [
      "live.status",
      ...(live.capabilities.includes("session.read") ? ["live.snapshot"] : []),
      ...(live.capabilities.includes("session.discovery") ? ["live.discover"] : []),
      ...(live.capabilities.includes("devices") && live.capabilities.includes("parameters") ? ["live.device.parameter.preview", "live.device.parameter.apply", "live.device.parameter.undo"] : []),
      ...(live.capabilities.includes("session.structure") ? ["live.session.structure.preview", "live.session.structure.apply", "live.session.structure.undo"] : []),
      ...(live.capabilities.includes("session.midi_clip.create") && live.capabilities.includes("session.midi_note.write") ? ["live.midi_clip.preview", "live.midi_clip.apply", "live.midi_clip.undo"] : []),
      ...(live.capabilities.includes("transport") ? ["live.tempo.preview", "live.tempo.apply", "live.undo"] : []),
      ...(live.capabilities.includes("arrangement.read") ? ["live.arrangement.section.preview"] : []),
      ...(live.capabilities.includes("arrangement.write") ? ["live.arrangement.section.apply", "live.arrangement.section.undo"] : []),
    ] : [];
    const liveUnavailable = live.connected ? [
      ...hostUnavailableCapabilities,
      ...LIVE_UNAVAILABLE_CAPABILITIES.filter((capability) => !live.capabilities.includes(capability)),
      ...(live.capabilities.includes("session.read") ? [] : ["live.snapshot"]),
      ...(live.capabilities.includes("session.discovery") ? [] : ["live.discover"]),
      ...(live.capabilities.includes("devices") && live.capabilities.includes("parameters") ? [] : ["live.device.parameter.preview", "live.device.parameter.apply", "live.device.parameter.undo"]),
      ...(live.capabilities.includes("session.structure") ? [] : ["live.session.structure.preview", "live.session.structure.apply", "live.session.structure.undo"]),
      ...(live.capabilities.includes("session.midi_clip.create") && live.capabilities.includes("session.midi_note.write") ? [] : ["live.midi_clip.preview", "live.midi_clip.apply", "live.midi_clip.undo"]),
      ...(live.capabilities.includes("transport") ? [] : ["live.tempo.preview", "live.tempo.apply", "live.undo"]),
    ] : [...unavailableCapabilities, ...LIVE_CAPABILITIES];
    return {
      implemented: ["server.status", "capabilities", "audio.analyze", ...liveImplemented],
      unavailable: [...new Set(liveUnavailable)],
      live: { connected: live.connected, adapter: live.adapter, epoch: live.epoch, protocol: live.protocol, capabilities: live.capabilities },
    };
  }

  private liveStatus(id: RequestId): JsonObject {
    return response(id, { content: [{ type: "text", text: JSON.stringify(this.safeAdapterStatus()) }], isError: false });
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
      const status = this.requireConnected("parameters");
      const target = this.parameterTarget(this.adapter.snapshot(), params.deviceRef, params.parameterRef);
      const revision = this.parameterRevision(target.parameter); const quantization = target.parameter.quantization ?? 0;
      if ((target.device.enabled as boolean | undefined) === false || (target.parameter.enabled as boolean | undefined) === false || !target.parameter.automatable) throw new Error("parameter is disabled or not supported for guarded adjustment");
      if (params.value < target.parameter.min || params.value > target.parameter.max) throw new Error("parameter value is outside authoritative bounds");
      if (quantization > 0 && Math.abs((params.value - target.parameter.min) / quantization - Math.round((params.value - target.parameter.min) / quantization)) > 1e-9) throw new Error("parameter value does not match authoritative quantization");
      const transaction: DeviceParameterTransaction = { id: `parameter_${randomBytes(18).toString("base64url")}`, confirmation: randomBytes(24).toString("base64url"), epoch: status.epoch as number, deviceRef: target.device.ref, parameterRef: target.parameter.ref, priorValue: target.parameter.value, proposedValue: params.value, priorRevision: revision, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
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
    if (transaction.state !== "previewed" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Device-parameter preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("parameters"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const target = this.parameterTarget(this.adapter.snapshot(), transaction.deviceRef, transaction.parameterRef);
      if (this.parameterRevision(target.parameter) !== transaction.priorRevision || target.parameter.value !== transaction.priorValue) return this.transactionError(id, "Device parameter changed since preview");
      this.adapter.set(transaction.parameterRef, "value", transaction.proposedValue);
      const verified = this.parameterTarget(this.adapter.snapshot(), transaction.deviceRef, transaction.parameterRef).parameter;
      if (verified.value !== transaction.proposedValue || this.parameterRevision(verified) <= transaction.priorRevision) { transaction.state = "uncertain"; throw new Error("Live did not confirm the requested device parameter"); }
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
      const transaction: SessionStructureTransaction = { id: `structure_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: this.structureRevision(snapshot), proposed: [...proposed.tracks, ...proposed.scenes], priorTracks: snapshot.tracks.map((item, index) => ({ ref: item.ref, name: item.name, kind: item.kind, index })), priorScenes: snapshot.scenes.map((item, index) => ({ ref: item.ref, name: item.name, index })), expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.sessionStructureTransactions.set(transaction.id, transaction);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, revision: transaction.revision, prior: { tracks: transaction.priorTracks, scenes: transaction.priorScenes }, proposed: transaction.proposed, impact: "creates-session-structure", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Session structure preview failed without mutation; discover current names and ordering."); }
  }

  private liveSessionStructureApply(id: RequestId, params: unknown): JsonObject {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.sessionStructureTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Session-structure transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Session-structure preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("session.structure"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.snapshot(); if (this.structureRevision(current) !== transaction.revision) return this.transactionError(id, "Session structure changed since preview");
      const created: NonNullable<SessionStructureTransaction["created"]> = [];
      try {
        for (const item of transaction.proposed) {
          const operation = item.kind === "track" ? "track.create" : "scene.create";
          const result = this.adapter.invoke({ operation, args: { name: item.name, ...(item.kind === "track" ? { kind: item.trackKind } : {}), index: item.index } }) as { ref?: LiveRef; name?: string; index?: number };
          if (!result?.ref || result.name !== item.name) throw new Error(`Live did not confirm created ${item.kind}`);
          created.push({ ref: result.ref, kind: item.kind, name: result.name, index: result.index ?? item.index });
        }
        const verified = this.adapter.snapshot(); if (!created.every((item) => item.kind === "track" ? verified.tracks.some((track) => track.ref === item.ref && track.name === item.name) : verified.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) throw new Error("Live did not confirm Session structure");
      } catch (cause) { for (const item of [...created].reverse()) { try { this.adapter.invoke({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref } }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Session-structure apply compensation failed; read authoritative structure before retrying"); } } throw cause; }
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
      if (prior.some((locator) => locator.name === params.startName || locator.name === params.endName || locator.position === params.start || locator.position === params.end)) throw new Error("Arrangement locator target collides with existing state");
      const transaction: ArrangementTransaction = { id: `arrangement_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, revision: `${status.epoch}:${prior.map((locator) => `${locator.ref}:${locator.name}:${locator.position}`).join("|")}`, start: params.start, end: params.end, startName: params.startName, endName: params.endName, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
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
    if (transaction.state !== "previewed" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Arrangement preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("arrangement.write"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.snapshot().arrangement.locators; const revision = `${status.epoch}:${current.map((locator) => `${locator.ref}:${locator.name}:${locator.position}`).join("|")}`;
      if (revision !== transaction.revision) return this.transactionError(id, "Arrangement locators changed since preview");
      const created: Array<{ ref: LiveRef; name: string; position: number }> = [];
      try {
        created.push(this.adapter.invoke({ operation: "locator.add", args: { name: transaction.startName, position: transaction.start } }) as { ref: LiveRef; name: string; position: number });
        created.push(this.adapter.invoke({ operation: "locator.add", args: { name: transaction.endName, position: transaction.end } }) as { ref: LiveRef; name: string; position: number });
      } catch (cause) { for (const locator of created) { try { this.adapter.invoke({ operation: "locator.delete", args: { ref: locator.ref } }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Arrangement apply compensation failed; read locators before retrying"); } } throw cause; }
      const authoritative = this.adapter.snapshot().arrangement.locators; if (!created.every((locator) => authoritative.some((item) => item.ref === locator.ref && item.name === locator.name && item.position === locator.position))) { transaction.state = "uncertain"; transaction.created = created; throw new Error("Live did not confirm Arrangement locators; read authoritative state before retrying"); }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", locators: created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement apply uncertain; read authoritative locators before retrying."); }
  }

  private liveTempoPreview(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["tempo"]) || typeof params.tempo !== "number" || !Number.isFinite(params.tempo) || params.tempo < 20 || params.tempo > 999) return error(id, -32602, "tempo must be a finite number from 20 to 999");
    try {
      const status = this.requireConnected("transport");
      const snapshot = this.adapter.snapshot();
      if (typeof snapshot.set.tempo !== "number" || !Number.isFinite(snapshot.set.tempo)) throw new Error("authoritative tempo is unavailable");
      const transactionId = this.newTransactionId();
      const transaction: TempoTransaction = { id: transactionId, setRef: snapshot.set.ref, priorTempo: snapshot.set.tempo, proposedTempo: params.tempo, epoch: status.epoch as number, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
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
      if (transaction.expiresAt <= Date.now()) { this.transactions.delete(transaction.id); return this.transactionError(id, "Tempo preview expired; preview again"); }
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!current || current.tempo !== transaction.priorTempo) return this.transactionError(id, "Tempo changed since preview; preview again");
      this.adapter.set(transaction.setRef, "tempo", transaction.proposedTempo);
      const applied = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!applied || applied.tempo !== transaction.proposedTempo) return this.transactionError(id, "Live did not confirm the requested tempo");
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
        const status = this.requireConnected("parameters"); if (status.epoch !== parameter.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const current = this.parameterTarget(this.adapter.snapshot(), parameter.deviceRef, parameter.parameterRef).parameter;
        if (current.value !== parameter.proposedValue || this.parameterRevision(current) !== parameter.appliedRevision) return this.transactionError(id, "Device parameter changed after apply; undo refused");
        this.adapter.set(parameter.parameterRef, "value", parameter.priorValue);
        const restored = this.parameterTarget(this.adapter.snapshot(), parameter.deviceRef, parameter.parameterRef).parameter;
        if (restored.value !== parameter.priorValue || this.parameterRevision(restored) <= parameter.appliedRevision) { parameter.state = "uncertain"; throw new Error("Live did not confirm device-parameter restoration"); }
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
        const current = this.adapter.snapshot(); if (!structure.created.every((item) => item.kind === "track" ? current.tracks.some((track) => track.ref === item.ref && track.name === item.name) : current.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) return this.transactionError(id, "Session structure changed after apply; undo refused");
        for (const item of [...structure.created].reverse()) this.adapter.invoke({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref } });
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
        if (!arrangement.created.every((locator) => current.some((item) => item.ref === locator.ref && item.name === locator.name && item.position === locator.position))) return this.transactionError(id, "Arrangement locators changed after apply; undo refused");
        try { for (const locator of arrangement.created) this.adapter.invoke({ operation: "locator.delete", args: { ref: locator.ref } }); }
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
      if (!current || current.tempo !== transaction.appliedTempo) return this.transactionError(id, "Tempo changed after apply; undo refused");
      this.adapter.set(transaction.setRef, "tempo", transaction.priorTempo);
      const restored = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!restored || restored.tempo !== transaction.priorTempo) return this.transactionError(id, "Live did not confirm tempo restoration");
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
      if (!isObject(status) || typeof status.connected !== "boolean" || !["simulator", "remote-script", "extension", "unavailable"].includes(String(status.adapter)) || status.protocol !== LIVE_PROTOCOL_VERSION || (status.epoch !== null && (!Number.isSafeInteger(status.epoch) || status.epoch < 1)) || !Array.isArray(status.capabilities) || new Set(status.capabilities).size !== status.capabilities.length || status.capabilities.some((capability) => !LIVE_CAPABILITIES.includes(capability as typeof LIVE_CAPABILITIES[number]))) throw new Error("invalid live adapter status");
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
    return isObject(params) && hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) && isNonEmptyString(params.transactionId, 128) && params.confirmation === confirmation && isNonEmptyString(params.idempotencyKey, 128);
  }

  private newTransactionId(): string { return `tempo_${randomBytes(18).toString("base64url")}`; }
  private evictTransactions(): void {
    const now = Date.now();
    for (const [id, transaction] of this.transactions) if ((transaction.state === "previewed" && transaction.expiresAt <= now) || (transaction.state === "previewed" && this.transactions.size > MAX_TRANSACTIONS)) this.transactions.delete(id);
  }
  private transactionError(id: RequestId, message: string): JsonObject { return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: message, remediation: "Request a fresh tempo preview and confirm the exact transaction." }) }], isError: true }); }
  private successText(id: RequestId, value: unknown): JsonObject { return response(id, { content: [{ type: "text", text: JSON.stringify(value) }], isError: false }); }
  private adapterToolError(id: RequestId, cause: unknown, remediation: string): JsonObject {
    const raw = cause instanceof Error ? cause.message : "adapter request failed";
    const reason = /^(live-|MIDI |Session |Tempo |Only an applied|confirmation=|transaction|adapter request)/.test(raw) && raw.length <= 160 ? raw : "adapter request failed";
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
    if (params.uri === liveResource.uri) return response(id, { contents: [{ uri: params.uri, mimeType: liveResource.mimeType, text: liveWorkflowResource }] });
    return error(id, -32002, "Resource not found", { uri: params.uri });
  }

  private listPrompts(id: RequestId, params: unknown): JsonObject {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid prompts/list parameters");
    return response(id, { prompts });
  }

  private getPrompt(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["name", "arguments"]) || typeof params.name !== "string") {
      return error(id, -32602, "Invalid prompts/get parameters");
    }
    if (params.arguments !== undefined && (!isObject(params.arguments) || !hasOnly(params.arguments, ["sampleRate", "channels"]))) {
      return error(id, -32602, "Invalid prompt arguments");
    }
    if (params.name === "change_tempo_safely") {
      if (params.arguments !== undefined && (!isObject(params.arguments) || !hasOnly(params.arguments, []))) return error(id, -32602, "Invalid prompt arguments");
      return response(id, { description: "Discover, preview, confirm, verify, and undo a tempo change", messages: [{ role: "user", content: textContent("Use live_status and live_snapshot, then live_tempo_preview, live_tempo_apply with explicit confirmation, live_snapshot for verification, and live_undo when restoration is requested.") }] });
    }
    if (params.name !== "analyze_audio") return error(id, -32002, "Prompt not found", { name: params.name });
    const argumentsObject = params.arguments as JsonObject | undefined;
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

export async function serve(input: Readable, output: Writable, diagnostics: Writable = process.stderr, adapter: LiveAdapter = new UnavailableLiveAdapter()): Promise<void> {
  const host = new McpHost(adapter);
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
  }); } finally {
    const close = (adapter as Partial<{ close: () => Promise<void> }>).close;
    if (typeof close === "function") await close.call(adapter);
  }
}
