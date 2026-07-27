import type { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { analyzePcm, decodeFloat32Le } from "./analysis.js";
import { LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_UNAVAILABLE_CAPABILITIES, UnavailableLiveAdapter, type LiveAdapter, type LiveCapability, type LiveEvent, type LiveRef, type LiveSnapshot, type LiveStatus } from "./live.js";
import { serveStdio, type RecordContext } from "./stdio.js";
import { projectBackup, projectInfo, projectLimitation } from "./project.js";
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
interface TransportTransaction {
  id: string;
  epoch: number;
  prior: { position: number | null; loop: { enabled: boolean | null; start: number | null; length: number | null }; punchIn: boolean | null; punchOut: boolean | null; metronome: boolean | null; countIn: number | null };
  proposed: Record<string, number | boolean>;
  playbackRevision: string;
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
  targetKey: string;
  playbackRevision: string;
  outputSafety: JsonObject;
  confirmation: string;
  stopConfirmation: string;
  expiresAt: number;
  applyKey?: string;
  stopKey?: string;
  state: "previewed" | "applying" | "applied" | "stopping" | "stopped" | "uncertain";
  inflight?: Promise<JsonObject>;
}
interface NoteEditTransaction {
  id: string;
  epoch: number;
  kind: "update" | "delete";
  clipRef: LiveRef;
  fence: string;
  patches?: Array<Record<string, unknown>>;
  noteIds?: number[];
  priorNotes: Array<Record<string, unknown>>;
  expiresAt: number;
  applyKey?: string;
  undoKey?: string;
  state: "previewed" | "applied" | "undone" | "uncertain";
}
interface ClipLifecycleTransaction {
  id: string;
  epoch: number;
  kind: "duplicate" | "arrangement-create" | "arrangement-delete" | "move" | "audio-set" | "mixer-set" | "automation" | "browser-load" | "device" | "routing-set" | "recording" | "backup";
  fence: string;
  clipRef?: LiveRef;
  payload: Record<string, unknown>;
  prior?: Record<string, unknown>;
  expiresAt: number;
  applyKey?: string;
  undoKey?: string;
  state: "previewed" | "applied" | "undone" | "uncertain";
  created?: Record<string, unknown>;
}

const REQUEST_ID_MAX_LENGTH = 128;
const SERVER_VERSION = "0.1.0";
const TRANSACTION_TTL_MS = 30_000;
const MAX_TRANSACTIONS = 256;
const AUDITION_TTL_MS = 30_000;
// Real-Live snapshot reads take seconds on populated sets, and launch/stop
// state propagates asynchronously at quantization boundaries; the deadline
// must cover snapshot + dispatch + polled verification.
const AUDITION_DEADLINE_MS = 15_000;
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
    name: "live_transport_preview",
    description: "Read-only preflight for one bounded transport change (position, loop, punch, metronome, count-in) with a playback-revision fence.",
    inputSchema: { type: "object", properties: { position: { type: "number", minimum: 0 }, loopEnabled: { type: "boolean" }, loopStart: { type: "number", minimum: 0 }, loopLength: { type: "number", exclusiveMinimum: 0 }, metronome: { type: "boolean" }, punchIn: { type: "boolean" }, punchOut: { type: "boolean" }, countIn: { type: "number", minimum: 0, maximum: 1000 } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_transport_apply",
    description: "Apply an exact, unexpired transport preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_launch_preview",
    description: "Read-only preflight for launching one exact clip slot, with explicit output-safety evidence and a playback-revision fence. Recording-active states refuse.",
    inputSchema: { type: "object", properties: { slotRef: { type: "string", minLength: 1, maxLength: 256 }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["slotRef", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_launch_apply",
    description: "Launch the exact previewed clip slot once and verify fresh fired/playing evidence.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_clip_launch_stop",
    description: "Stop only the preview-owned launched clip through its track and verify it is no longer active; other playback continues.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_capture_midi",
    description: "Capture recently played MIDI into new Session clips and return the verified new clip references.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["capture"] } }, required: ["confirmation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_capture",
    description: "Capture the currently playing Session content into a new scene and return the verified new scene reference.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["capture"] } }, required: ["confirmation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_update_preview",
    description: "Read-only preflight for bounded MIDI note edits by note id, including velocity, mute, probability, velocity deviation, and release velocity.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, notes: { type: "array", maxItems: 512, items: { type: "object", properties: { id: { type: "integer", minimum: 0 }, pitch: { type: "integer", minimum: 0, maximum: 127 }, start: { type: "number", minimum: 0 }, duration: { type: "number", exclusiveMinimum: 0 }, velocity: { type: "number", minimum: 0, maximum: 127 }, mute: { type: "boolean" }, probability: { type: "number", minimum: 0, maximum: 1 }, velocityDeviation: { type: "number", minimum: -127, maximum: 127 }, releaseVelocity: { type: "number", minimum: 0, maximum: 127 } }, required: ["id"], additionalProperties: false } } }, required: ["clipRef", "notes"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_update_apply",
    description: "Apply an exact, unexpired note-update preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_delete_preview",
    description: "Read-only preflight for deleting exact MIDI notes by id, capturing the prior notes for guarded undo.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, noteIds: { type: "array", maxItems: 512, items: { type: "integer", minimum: 0 } } }, required: ["clipRef", "noteIds"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_note_delete_apply",
    description: "Apply an exact, unexpired note-delete preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_clip_duplicate_preview",
    description: "Read-only preflight for duplicating a Session clip to another Session slot or into the Arrangement.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, targetTrackRef: { type: "string", minLength: 1, maxLength: 256 }, targetSceneIndex: { type: "integer", minimum: 0, maximum: 10000 }, arrangementPosition: { type: "number", minimum: 0 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_duplicate_apply",
    description: "Apply an exact, unexpired clip-duplicate preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_arrangement_clip_preview",
    description: "Read-only preflight for creating or deleting one Arrangement MIDI clip with exact fencing.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create", "delete"] }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, position: { type: "number", minimum: 0 }, length: { type: "number", exclusiveMinimum: 0 }, name: { type: "string", minLength: 1, maxLength: 256 }, clipRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_arrangement_clip_apply",
    description: "Apply an exact, unexpired arrangement-clip preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_clip_move_preview",
    description: "Read-only preflight for repositioning an Arrangement clip or moving a Session clip to another slot.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, position: { type: "number", minimum: 0 }, targetTrackRef: { type: "string", minLength: 1, maxLength: 256 }, targetSceneIndex: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_clip_move_apply",
    description: "Apply an exact, unexpired clip-move preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_audio_clip_preview",
    description: "Read-only preflight for bounded audio clip edits (gain, pitch, loop region, warp mode) with prior-value capture.",
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, gain: { type: "number", minimum: 0 }, pitchCoarse: { type: "number", minimum: -48, maximum: 48 }, pitchFine: { type: "number", minimum: -50, maximum: 50 }, loopStart: { type: "number", minimum: 0 }, loopEnd: { type: "number", minimum: 0 }, warpMode: { type: "integer", minimum: 0, maximum: 16 } }, required: ["clipRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_audio_clip_apply",
    description: "Apply an exact, unexpired audio-clip preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_mixer_preview",
    description: "Read-only preflight for bounded mixer edits (volume, pan, mute, solo, cue, sends) with prior-value capture.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, volume: { type: "number", minimum: 0, maximum: 1 }, pan: { type: "number", minimum: -1, maximum: 1 }, mute: { type: "boolean" }, solo: { type: "boolean" }, cueVolume: { type: "number", minimum: 0, maximum: 1 }, sends: { type: "array", maxItems: 64, items: { type: "number", minimum: 0, maximum: 1 } } }, required: ["trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_mixer_apply",
    description: "Apply an exact, unexpired mixer preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_automation_preview",
    description: "Read-only preflight for bounded Session clip envelope edits (create/delete envelope, insert/delete points) with conflict-aware fencing.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create-envelope", "delete-envelope", "insert", "delete-range"] }, clipRef: { type: "string", minLength: 1, maxLength: 256 }, parameterRef: { type: "string", minLength: 1, maxLength: 256 }, points: { type: "array", maxItems: 512, items: { type: "object", properties: { time: { type: "number", minimum: 0 }, value: { type: "number" } }, required: ["time", "value"], additionalProperties: false } }, from: { type: "number", minimum: 0 }, to: { type: "number", minimum: 0 } }, required: ["action", "clipRef", "parameterRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_automation_apply",
    description: "Apply an exact, unexpired automation preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_browser_search",
    description: "Search the Live Browser catalog by category and query with stable result identities.",
    inputSchema: { type: "object", properties: { category: { type: "string", enum: ["instruments", "audio_effects", "midi_effects", "drums", "plugins", "packs", "max_for_live", "clips"] }, query: { type: "string", maxLength: 256 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_browser_load_preview",
    description: "Read-only preflight for loading one exact browser item onto a target track with postcondition verification.",
    inputSchema: { type: "object", properties: { itemId: { type: "string", minLength: 1, maxLength: 512 }, trackRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["itemId", "trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_browser_load_apply",
    description: "Apply an exact, unexpired browser-load preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_preview",
    description: "Read-only preflight for guarded device insert, delete, enable, or move with exact fencing.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["insert", "delete", "enable", "move"] }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, deviceName: { type: "string", minLength: 1, maxLength: 256 }, deviceRef: { type: "string", minLength: 1, maxLength: 256 }, index: { type: "integer", minimum: -1, maximum: 256 }, enabled: { type: "boolean" } }, required: ["action"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_device_apply",
    description: "Apply an exact, unexpired device preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_routing_preview",
    description: "Read-only preflight for bounded routing, arm, and monitoring edits with feedback-loop guards and prior-value capture.",
    inputSchema: { type: "object", properties: { trackRef: { type: "string", minLength: 1, maxLength: 256 }, inputType: { type: "string", maxLength: 256 }, inputSubRouting: { type: "string", maxLength: 256 }, outputType: { type: "string", maxLength: 256 }, outputSubRouting: { type: "string", maxLength: 256 }, arm: { type: "boolean" }, monitoring: { type: "string", enum: ["in", "auto", "off"] } }, required: ["trackRef"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_routing_apply",
    description: "Apply an exact, unexpired routing preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_recording_preview",
    description: "Read-only preflight for one bounded Session or Arrangement recording start/stop with explicit intent, destination identity, and output-safety evidence.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop"] }, lane: { type: "string", enum: ["session", "arrangement"] }, intent: { type: "string", minLength: 1, maxLength: 256 }, destinationTrackRef: { type: "string", minLength: 1, maxLength: 256 }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["action", "lane", "intent", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_recording_apply",
    description: "Apply an exact, unexpired recording preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_subscribe",
    description: "Subscribe to authenticated, epoch- and sequence-bound Live events (transport, object, state) with coalescing, bounded queues, overflow notification, and resnapshot recovery.",
    inputSchema: { type: "object", properties: { types: { type: "array", maxItems: 16, items: { type: "string", enum: ["state", "transport", "object", "meter", "max", "osc"] } } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_unsubscribe",
    description: "End the active Live event subscription.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_info",
    description: "Read the current set's file identity, gzip/XML manifest, referenced media, and missing-media report (metadata only).",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_backup_preview",
    description: "Read-only preflight for one verified atomic backup of the current set inside its own directory.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["backup"] } }, required: ["confirmation"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_backup_apply",
    description: "Apply an exact, unexpired project backup preview with confirmation and idempotency.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_save",
    description: "Reported negotiated limitation: save/save-as are not exposed by the Live Remote Script API in this Live version.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_project_open",
    description: "Reported negotiated limitation: open/new/export/collect/bounce are not exposed by the Live Remote Script API in this Live version.",
    inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 1024 } }, required: [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
  private readonly transportTransactions = new Map<string, TransportTransaction>();
  private readonly clipLaunchTransactions = new Map<string, ClipLaunchTransaction>();
  private readonly noteEditTransactions = new Map<string, NoteEditTransaction>();
  private readonly clipLifecycleTransactions = new Map<string, ClipLifecycleTransaction>();

  public constructor(private readonly adapter: LiveAdapter = new UnavailableLiveAdapter()) { this.midiTransactions = new SessionMidiTransactionManager(adapter); }

  /** Promise-based request entrypoint for process-backed adapters. The legacy
   * handle() remains for deterministic in-process callers. */
  public async handleAsync(input: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (signal?.aborted) return null;
    if (!isObject(input) || input.method !== "tools/call" || !isObject(input.params) || typeof input.params.name !== "string") return this.handle(input);
    const name = input.params.name;
    if (![ "live_session_structure_preview", "live_session_structure_apply", "live_snapshot", "live_discover", "live_device_parameter_preview", "live_device_parameter_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi", "live_scene_capture", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_backup_preview", "live_project_backup_apply", "live_project_save", "live_project_open"].includes(name)) return this.handle(input);
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
      if (name === "live_transport_preview") return await this.liveTransportPreviewAsync(id, input.params.arguments);
      if (name === "live_transport_apply") return await this.liveTransportApplyAsync(id, input.params.arguments, signal);
      if (name === "live_clip_launch_preview") return await this.liveClipLaunchPreviewAsync(id, input.params.arguments);
      if (name === "live_clip_launch_apply") return await this.liveClipLaunchApplyAsync(id, input.params.arguments, signal);
      if (name === "live_clip_launch_stop") return await this.liveClipLaunchStopAsync(id, input.params.arguments, signal);
      if (name === "live_capture_midi") return await this.liveCaptureMidiAsync(id, input.params.arguments, signal);
      if (name === "live_scene_capture") return await this.liveSceneCaptureAsync(id, input.params.arguments, signal);
      if (name === "live_note_update_preview") return await this.liveNoteEditPreviewAsync(id, input.params.arguments, "update");
      if (name === "live_note_update_apply") return await this.liveNoteEditApplyAsync(id, input.params.arguments, "update", signal);
      if (name === "live_note_delete_preview") return await this.liveNoteEditPreviewAsync(id, input.params.arguments, "delete");
      if (name === "live_note_delete_apply") return await this.liveNoteEditApplyAsync(id, input.params.arguments, "delete", signal);
      if (name === "live_clip_duplicate_preview") return await this.liveClipDuplicatePreviewAsync(id, input.params.arguments);
      if (name === "live_clip_duplicate_apply") return await this.liveClipDuplicateApplyAsync(id, input.params.arguments, signal);
      if (name === "live_arrangement_clip_preview") return await this.liveArrangementClipPreviewAsync(id, input.params.arguments);
      if (name === "live_arrangement_clip_apply") return await this.liveArrangementClipApplyAsync(id, input.params.arguments, signal);
      if (name === "live_clip_move_preview") return await this.liveClipMovePreviewAsync(id, input.params.arguments);
      if (name === "live_clip_move_apply") return await this.liveClipMoveApplyAsync(id, input.params.arguments, signal);
      if (name === "live_audio_clip_preview") return await this.liveAudioClipPreviewAsync(id, input.params.arguments);
      if (name === "live_audio_clip_apply") return await this.liveAudioClipApplyAsync(id, input.params.arguments, signal);
      if (name === "live_mixer_preview") return await this.liveMixerPreviewAsync(id, input.params.arguments);
      if (name === "live_mixer_apply") return await this.liveMixerApplyAsync(id, input.params.arguments, signal);
      if (name === "live_automation_preview") return await this.liveAutomationPreviewAsync(id, input.params.arguments);
      if (name === "live_automation_apply") return await this.liveAutomationApplyAsync(id, input.params.arguments, signal);
      if (name === "live_browser_search") return await this.liveBrowserSearchAsync(id, input.params.arguments);
      if (name === "live_browser_load_preview") return await this.liveBrowserLoadPreviewAsync(id, input.params.arguments);
      if (name === "live_browser_load_apply") return await this.liveBrowserLoadApplyAsync(id, input.params.arguments, signal);
      if (name === "live_device_preview") return await this.liveDevicePreviewAsync(id, input.params.arguments);
      if (name === "live_device_apply") return await this.liveDeviceApplyAsync(id, input.params.arguments, signal);
      if (name === "live_routing_preview") return await this.liveRoutingPreviewAsync(id, input.params.arguments);
      if (name === "live_routing_apply") return await this.liveRoutingApplyAsync(id, input.params.arguments, signal);
      if (name === "live_recording_preview") return await this.liveRecordingPreviewAsync(id, input.params.arguments);
      if (name === "live_recording_apply") return await this.liveRecordingApplyAsync(id, input.params.arguments, signal);
      if (name === "live_subscribe") return await this.liveSubscribeAsync(id, input.params.arguments);
      if (name === "live_unsubscribe") return await this.liveUnsubscribeAsync(id, input.params.arguments);
      if (name === "live_project_info") return await this.liveProjectInfoAsync(id, input.params.arguments);
      if (name === "live_project_backup_preview") return await this.liveProjectBackupPreviewAsync(id, input.params.arguments);
      if (name === "live_project_backup_apply") return await this.liveProjectBackupApplyAsync(id, input.params.arguments, signal);
      if (name === "live_project_save") return this.successText(id, projectLimitation("save"));
      if (name === "live_project_open") return this.successText(id, projectLimitation("open/new/export/collect/bounce"));
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

  /** Status fresh at call time; operation/capability gates must not rely on a
   * connect-time advertisement after the Live shape may have changed. */
  private async freshStatus(context?: { deadlineMs?: number }): Promise<LiveStatus> {
    const adapter = this.adapter as Partial<AsyncLiveAdapter & { refreshStatusAsync?: (context?: { deadlineMs?: number }) => Promise<LiveStatus> }>;
    if (typeof adapter.refreshStatusAsync === "function") return adapter.refreshStatusAsync(context);
    return this.adapter.status();
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
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
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
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const before = this.auditionSnapshot(await adapter.snapshotAsync(context), transaction.sceneRef);
      if (JSON.stringify(before.scene) !== transaction.sceneRevision || before.set.name !== transaction.setName || before.playback.transport.arrangementRecord !== false || before.playback.transport.sessionRecord !== false || before.tracks.some((track) => MONITORABLE_TRACK_KINDS.has(String(track.kind)) ? (track.armed !== false || !["off", "auto"].includes(String(track.monitoringState))) : (track.armed === true || track.monitoringState === "in"))) throw new Error("audition ownership or safety state changed; stop refused");
      const activeTargets = [...before.playback.firedTargets, ...before.playback.playingTargets];
      if (activeTargets.length > 0) {
        if (activeTargets.some((target) => target.sceneRef !== transaction.sceneRef || !transaction.eligibleTargetKeys.includes(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))) throw new Error("owned playback is unknown or external playback is active; global stop refused");
        if (signal?.aborted) throw new Error("audition stop cancelled before dispatch");
        await adapter.invokeAsync({ operation: "session.audition-stop", args: { ref: transaction.sceneRef, setName: transaction.setName, eligibleTargets: transaction.eligibleTargetKeys } }, context);
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
      const message = cause instanceof Error ? cause.message : String(cause);
      transaction.state = /cancelled before dispatch/.test(message) ? "applied" : "uncertain";
      throw cause;
    }
  }

  private async liveSessionEmergencyStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["confirmation", "expectedTargets", "idempotencyKey"]) || params.confirmation !== "emergency-stop" || !Array.isArray(params.expectedTargets) || params.expectedTargets.length > 256 || new Set(params.expectedTargets).size !== params.expectedTargets.length || !params.expectedTargets.every((item) => isNonEmptyString(item, 1024)) || (params.idempotencyKey !== undefined && !isNonEmptyString(params.idempotencyKey, 128))) return error(id, -32602, "confirmation=emergency-stop and the exact freshly observed active playback targets are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("session.emergency-stop")) throw new Error("emergency stop operation is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const playback = snapshot.playback;
      if (!playback || !Array.isArray(playback.firedTargets) || !Array.isArray(playback.playingTargets)) throw new Error("authoritative Session playback is unavailable");
      const activeKeys = [...new Set([...playback.firedTargets, ...playback.playingTargets].map((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))].sort();
      const expectedKeys = [...(params.expectedTargets as string[])].sort();
      if (activeKeys.length !== expectedKeys.length || activeKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("expected targets do not match fresh authoritative playback; perform fresh discovery");
      if (signal?.aborted) return null;
      const result = await adapter.invokeAsync({ operation: "session.emergency-stop", args: { expectedTargets: activeKeys } }, context) as { stopped?: unknown; stoppedTargets?: unknown };
      let confirmed = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        if (after.playback.transport.playing === false && after.playback.firedTargets.length === 0 && after.playback.playingTargets.length === 0) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error("emergency stop was not confirmed by fresh authoritative state");
      return this.successText(id, { stopped: true, stoppedTargets: result.stoppedTargets ?? activeKeys });
    } catch (cause) { return this.adapterToolError(id, cause, "Emergency stop is uncertain; perform fresh authoritative playback discovery before any further action."); }
  }

  private static readonly TRANSPORT_FIELDS = ["position", "loopEnabled", "loopStart", "loopLength", "metronome", "punchIn", "punchOut", "countIn"] as const;

  private async liveTransportPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, [...McpHost.TRANSPORT_FIELDS])) return error(id, -32602, "only bounded transport fields are accepted");
    const proposed: Record<string, number | boolean> = {};
    for (const field of McpHost.TRANSPORT_FIELDS) {
      const value = params[field];
      if (value === undefined) continue;
      if (["loopEnabled", "metronome", "punchIn", "punchOut"].includes(field)) { if (typeof value !== "boolean") return error(id, -32602, `${field} must be boolean`); }
      else if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field === "countIn" && value > 1000) || (field === "loopLength" && value <= 0)) return error(id, -32602, `${field} is out of bounds`);
      proposed[field] = value;
    }
    if (Object.keys(proposed).length === 0) return error(id, -32602, "at least one transport field is required");
    try {
      const status = this.requireConnected("transport");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const transport = snapshot.playback?.transport;
      if (!transport || !transport.loop) return this.transactionError(id, "authoritative transport state is unavailable");
      const transaction: TransportTransaction = { id: `transport_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, prior: structuredClone({ position: transport.position, loop: transport.loop, punchIn: transport.punchIn, punchOut: transport.punchOut, metronome: transport.metronome, countIn: transport.countIn }), proposed, playbackRevision: snapshot.playback.revision, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
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
    if (!transaction || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired transport transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const result = await adapter.invokeAsync({ operation: "transport.set", args: { ...transaction.proposed, expectedRevision: transaction.playbackRevision } }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true || typeof result.revision !== "string") throw new Error("transport change was not confirmed");
      if (typeof transaction.proposed.position === "number") await this.confirmTransportPosition(adapter, context, transaction.proposed.position);
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Transport state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveTransportUndoAsync(id: RequestId, transaction: TransportTransaction, params: Record<string, unknown>): Promise<JsonObject> {
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied transport transaction can be undone");
    try {
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
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
        if (field === "countIn" && typeof prior.countIn === "number") restore.countIn = prior.countIn;
      }
      const result = await adapter.invokeAsync({ operation: "transport.set", args: { ...restore, expectedRevision: snapshot.playback.revision } }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("transport undo was not confirmed");
      if (typeof restore.position === "number") await this.confirmTransportPosition(adapter, context, restore.position);
      transaction.undoKey = params.idempotencyKey as string;
      transaction.state = "undone";
      return this.successText(id, { transactionId: transaction.id, state: "undone", restored: restore, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Transport undo is uncertain; perform fresh discovery."); }
  }

  private retainBoundedTransaction<T extends { id: string; expiresAt: number; state: string }>(map: Map<string, T>, transaction: T, kind: string): void {
    const now = Date.now();
    for (const [key, candidate] of map) if (candidate.expiresAt <= now && candidate.state !== "applying" && candidate.state !== "stopping") map.delete(key);
    while (map.size >= MAX_AUDITION_TRANSACTIONS) {
      const oldest = [...map].find(([, candidate]) => candidate.state !== "applying" && candidate.state !== "stopping");
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
      if (!(status.operations ?? []).includes("clip.launch")) throw new Error("clip launch operation is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const transport = snapshot.playback?.transport;
      if (!transport) throw new Error("authoritative playback state is unavailable");
      if (transport.arrangementRecord === true || transport.sessionRecord === true) throw new Error("clip launch while recording is active is refused");
      const target = (snapshot.tracks as unknown as JsonObject[]).flatMap((track) => Array.isArray(track.clipSlots) ? (track.clipSlots as unknown[]).filter(isObject).filter((slot) => slot.ref === params.slotRef).map((slot) => ({ track, slot })) : [])[0];
      if (!target || typeof target.slot.clipRef !== "string" || typeof target.slot.sceneIndex !== "number" || typeof target.track.ref !== "string") throw new Error("clip slot with an authoritative clip is required");
      const scene = snapshot.scenes.find((item) => item.index === target.slot.sceneIndex);
      if (!scene) throw new Error("clip slot scene is not authoritative");
      const targetKey = `${target.track.ref}|${target.slot.ref}|${scene.ref}`;
      if (targetKey.split("|").length !== 3) throw new Error("clip references are not encodable as a target key");
      const transaction: ClipLaunchTransaction = { id: `cliplaunch_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, slotRef: params.slotRef as LiveRef, trackRef: target.track.ref as LiveRef, sceneRef: scene.ref, sceneIndex: scene.index, clipRef: target.slot.clipRef as LiveRef, targetKey, playbackRevision: snapshot.playback.revision, outputSafety: structuredClone(params.outputSafety as JsonObject), confirmation: randomBytes(32).toString("base64url"), stopConfirmation: randomBytes(32).toString("base64url"), expiresAt: Date.now() + AUDITION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLaunchTransactions, transaction, "clip launch");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, target: { slotRef: transaction.slotRef, trackRef: transaction.trackRef, sceneRef: transaction.sceneRef, sceneIndex: transaction.sceneIndex, clipRef: transaction.clipRef, targetKey }, playbackRevision: transaction.playbackRevision, audibleImpact: "potentially-audible-clip-launch", confirmation: transaction.confirmation, stopConfirmation: transaction.stopConfirmation, expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-launch preview refused; obtain fresh authoritative discovery and explicit output-safety evidence."); }
  }

  private async liveClipLaunchApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isNonEmptyString(params.idempotencyKey, 128)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
    const transaction = this.clipLaunchTransactions.get(params.transactionId as string);
    if (!transaction || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired clip-launch transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey && transaction.confirmation === params.confirmation) return this.successText(id, { transactionId: transaction.id, state: "applied", stopConfirmation: transaction.stopConfirmation, idempotent: true });
    if (transaction.state === "applying") {
      if (transaction.applyKey !== params.idempotencyKey || transaction.confirmation !== params.confirmation || !transaction.inflight) return this.transactionError(id, "Clip-launch apply is already in progress with a different request");
      try {
        const outcome = await transaction.inflight;
        return this.successText(id, { ...outcome, idempotent: true });
      } catch (cause) {
        return this.adapterToolError(id, cause, "Clip-launch state is uncertain; do not retry. Perform fresh playback discovery.");
      }
    }
    if (transaction.state !== "previewed" || transaction.confirmation !== params.confirmation) return this.transactionError(id, "Exact clip-launch confirmation is required");
    if (signal?.aborted) return null;
    transaction.state = "applying";
    transaction.applyKey = params.idempotencyKey as string;
    const inflight = this.dispatchClipLaunchApply(transaction, signal);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Clip-launch state is uncertain; do not retry. Perform fresh playback discovery.");
    }
  }

  private async dispatchClipLaunchApply(transaction: ClipLaunchTransaction, signal?: AbortSignal): Promise<JsonObject> {
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const transport = snapshot.playback?.transport;
      if (!transport) throw new Error("authoritative playback state is unavailable");
      if (snapshot.playback.revision !== transaction.playbackRevision) throw new Error("playback state changed since preview");
      if (transport.arrangementRecord === true || transport.sessionRecord === true) throw new Error("clip launch while recording is active is refused");
      const stillThere = (snapshot.tracks as unknown as JsonObject[]).some((track) => track.ref === transaction.trackRef && Array.isArray(track.clipSlots) && (track.clipSlots as unknown[]).filter(isObject).some((slot) => slot.ref === transaction.slotRef && slot.clipRef === transaction.clipRef && slot.sceneIndex === transaction.sceneIndex));
      if (!stillThere) throw new Error("clip slot content changed since preview");
      this.validateOutputSafety(transaction.outputSafety);
      if (signal?.aborted) throw new Error("clip launch cancelled before dispatch");
      const result = await adapter.invokeAsync({ operation: "clip.launch", args: { ref: transaction.slotRef } }, context) as { launched?: unknown; targets?: unknown };
      if (result.launched !== transaction.slotRef) throw new Error("clip launch result does not match the previewed slot");
      let verified = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        const activeTargets = [...after.playback.firedTargets, ...after.playback.playingTargets];
        if (activeTargets.some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey)) { verified = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!verified) throw new Error("clip launch was not confirmed by fresh fired or playing target evidence");
      transaction.state = "applied";
      return { transactionId: transaction.id, state: "applied", verified: { targetKey: transaction.targetKey, firedOrPlaying: true }, stopConfirmation: transaction.stopConfirmation };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain";
      throw cause;
    }
  }

  private async liveClipLaunchStopAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isNonEmptyString(params.idempotencyKey, 128)) return error(id, -32602, "transactionId, exact stop confirmation, and idempotencyKey are required");
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
    if (signal?.aborted) return null;
    transaction.state = "stopping";
    transaction.stopKey = params.idempotencyKey as string;
    const inflight = this.dispatchClipLaunchStop(transaction, signal);
    transaction.inflight = inflight;
    inflight.catch(() => undefined);
    try {
      const outcome = await inflight;
      return this.successText(id, { ...outcome, idempotent: false });
    } catch (cause) {
      return this.adapterToolError(id, cause, "Clip-launch stop is uncertain; perform fresh playback discovery.");
    }
  }

  private async dispatchClipLaunchStop(transaction: ClipLaunchTransaction, signal?: AbortSignal): Promise<JsonObject> {
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) throw new Error("Live connection epoch changed; stop refused");
      if (!(status.operations ?? []).includes("track.stop")) throw new Error("track stop operation is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const before = await adapter.snapshotAsync(context);
      const ours = [...before.playback.firedTargets, ...before.playback.playingTargets].some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey);
      if (ours) {
        if (signal?.aborted) throw new Error("clip-launch stop cancelled before dispatch");
        await adapter.invokeAsync({ operation: "track.stop", args: { ref: transaction.trackRef } }, context);
      }
      let confirmed = false;
      while (Date.now() < context.deadlineMs - 250) {
        const after = await adapter.snapshotAsync(context);
        const still = [...after.playback.firedTargets, ...after.playback.playingTargets].some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey);
        if (!still) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error("clip stop was not confirmed by fresh authoritative state");
      transaction.state = "stopped";
      return { transactionId: transaction.id, state: "stopped", targetCleared: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      transaction.state = /cancelled before dispatch/.test(message) ? "applied" : "uncertain";
      throw cause;
    }
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
      if (!track || !isObject(track.routing)) throw new Error("track with authoritative routing is required");
      if (typeof proposed.outputType === "string" && proposed.outputType && (proposed.outputType === track.name || proposed.outputType === (track.routing as JsonObject).inputType)) throw new Error("routing would create a feedback loop");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = structuredClone((track.routing as JsonObject)[field] ?? (field === "arm" ? track.armed : field === "monitoring" ? track.monitoringState : null));
      const fence = JSON.stringify({ ref: params.trackRef, routing: track.routing, armed: track.armed, monitoringState: track.monitoringState });
      const transaction: ClipLifecycleTransaction = { id: `routing_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "routing-set", fence, clipRef: params.trackRef as LiveRef, payload: { ref: params.trackRef, ...proposed }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "routing");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, trackRef: params.trackRef, prior, proposed, impact: "edits-routing", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Routing preview requires fresh authoritative state."); }
  }

  private async liveRoutingApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "routing-set" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired routing transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.clipRef);
      if (!track || JSON.stringify({ ref: transaction.clipRef, routing: track.routing, armed: track.armed, monitoringState: track.monitoringState }) !== transaction.fence) return this.transactionError(id, "routing state changed since preview; preview again");
      const result = await adapter.invokeAsync({ operation: "routing.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("routing change was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Routing state is uncertain; perform fresh discovery before retrying."); }
  }

  private eventEmitter: ((value: string) => Promise<void>) | undefined;
  private readonly eventQueue: string[] = [];
  private eventOverflow = 0;
  private eventFlushScheduled = false;

  setEventEmitter(emitter: (value: string) => Promise<void>): void {
    this.eventEmitter = emitter;
    const adapter = this.adapter as Partial<LiveAdapter>;
    if (typeof adapter.subscribe === "function") {
      adapter.subscribe((event) => this.onLiveEvent(event));
    }
  }

  private onLiveEvent(event: LiveEvent): void {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "notifications/live_event", params: event });
    if (this.eventQueue.length >= 256) {
      this.eventOverflow += 1;
      if (this.eventOverflow === 1) this.eventQueue.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/live_event_overflow", params: { dropped: "some", resnapshot: true } }));
      return;
    }
    this.eventQueue.push(line);
    if (!this.eventFlushScheduled) {
      this.eventFlushScheduled = true;
      setImmediate(() => {
        this.eventFlushScheduled = false;
        const lines = this.eventQueue.splice(0, this.eventQueue.length);
        void (async () => {
          for (const queued of lines) await this.eventEmitter?.(queued);
        })();
      });
    }
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
    if (!isObject(params) || !hasOnly(params, ["confirmation"]) || params.confirmation !== "backup") return error(id, -32602, "confirmation=backup is required");
    try {
      this.requireConnected("session.read");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const filePath = snapshot.set.filePath;
      if (typeof filePath !== "string" || filePath.length === 0) return this.transactionError(id, "the current set has never been saved to disk; save it through Live's UI first (save is a negotiated API limitation)");
      const transaction: ClipLifecycleTransaction = { id: `backup_${randomBytes(18).toString("base64url")}`, epoch: (this.safeAdapterStatus().epoch ?? 0) as number, kind: "backup", fence: filePath, payload: { path: filePath }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "project backup");
      return this.successText(id, { transactionId: transaction.id, path: filePath, impact: "creates-verified-backup", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Project backup preview requires the current set path."); }
  }

  private async liveProjectBackupApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "backup" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired backup transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", backup: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const snapshot = await this.asyncAdapter().snapshotAsync();
      if (snapshot.set.filePath !== transaction.fence) return this.transactionError(id, "the current set path changed since preview; preview again");
      const result = projectBackup(transaction.fence);
      if (!result.verified) throw new Error("backup verification failed");
      transaction.created = result as unknown as Record<string, unknown>;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", backup: result.backup, manifest: result.manifest, verified: result.verified, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Project backup is uncertain; verify the backup file before relying on it."); }
  }

  private async liveSubscribeAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const types = ["state", "transport", "object", "meter", "max", "osc"];
    const validTypes = !isObject(params) || params.types === undefined || (Array.isArray(params.types) && params.types.length <= 16 && params.types.every((item: unknown) => typeof item === "string" && types.includes(item)));
    if (!isObject(params) || !hasOnly(params, ["types"]) || !validTypes) return error(id, -32602, "types must be a bounded subset of state, transport, object, meter, max, osc");
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
      if (params.action === "start") {
        const alreadyRecording = params.lane === "session" ? transport.sessionRecord === true : transport.arrangementRecord === true;
        if (alreadyRecording) throw new Error(`${params.lane} recording is already active`);
        if (params.lane === "arrangement") {
          if (!isNonEmptyString(params.destinationTrackRef, 256)) throw new Error("Arrangement recording requires an explicit destination track");
          const destination = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.destinationTrackRef);
          if (!destination) throw new Error("destination track is not authoritative");
          if (destination.armed !== true) throw new Error("destination track is not armed for recording; arm it through live_routing_preview first");
        }
      }
      const fence = JSON.stringify({ sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord, playing: transport.playing });
      const transaction: ClipLifecycleTransaction = { id: `recording_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "recording", fence, payload: { action: params.action, lane: params.lane, intent: params.intent, outputSafety: structuredClone(params.outputSafety as JsonObject), destinationTrackRef: params.destinationTrackRef }, prior: { sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "recording");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, lane: params.lane, intent: params.intent, prior: transaction.prior, impact: params.action === "start" ? "starts-recording" : "stops-recording", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Recording preview refused; obtain fresh authoritative state and explicit output-safety evidence."); }
  }

  private async liveRecordingApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "recording" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired recording transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const transport = snapshot.playback?.transport;
      if (!transport || JSON.stringify({ sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord, playing: transport.playing }) !== transaction.fence) return this.transactionError(id, "recording state changed since preview; preview again");
      const operation = transaction.payload.lane === "session" ? "recording.session" : "recording.arrangement";
      const result = await adapter.invokeAsync({ operation, args: { action: transaction.payload.action } }, context) as { recording?: unknown };
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
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Recording state is uncertain; perform fresh discovery and use the emergency stop path if needed."); }
  }

  private deviceRow(snapshot: LiveSnapshot, deviceRef: LiveRef): { track: JsonObject; device: JsonObject } {
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      const device = (track.devices as unknown[]).filter(isObject).find((item) => item.ref === deviceRef);
      if (device) return { track, device };
    }
    throw new Error("device reference is not authoritative");
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

  private async liveBrowserLoadPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["itemId", "trackRef"]) || !isNonEmptyString(params.itemId, 512) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "itemId and trackRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("browser.load")) throw new Error("browser loading is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.trackRef);
      if (!track) throw new Error("track is not authoritative");
      const fence = JSON.stringify({ track: params.trackRef, deviceCount: (track.devices as unknown[]).length, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) });
      const transaction: ClipLifecycleTransaction = { id: `browserload_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "browser-load", fence, clipRef: params.trackRef as LiveRef, payload: { itemId: params.itemId, trackRef: params.trackRef }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "browser load");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, itemId: params.itemId, trackRef: params.trackRef, impact: "loads-browser-item", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Browser-load preview requires fresh authoritative state."); }
  }

  private async liveBrowserLoadApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "browser-load" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired browser-load transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.payload.trackRef);
      if (!track || JSON.stringify({ track: transaction.payload.trackRef, deviceCount: (track.devices as unknown[]).length, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) }) !== transaction.fence) return this.transactionError(id, "track devices changed since preview; preview again");
      const result = await adapter.invokeAsync({ operation: "browser.load", args: transaction.payload }, context) as { loaded?: unknown; deviceRef?: unknown };
      if (result.loaded !== true) throw new Error("browser load was not confirmed");
      transaction.created = { deviceRef: result.deviceRef ?? null };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", deviceRef: transaction.created.deviceRef, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Browser load is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveDevicePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["insert", "delete", "enable", "move"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "trackRef", "deviceName", "deviceRef", "index", "enabled"]) || !actions.includes(params.action as typeof actions[number])) return error(id, -32602, "action insert/delete/enable/move is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const payload: Record<string, unknown> = { action: params.action };
      let fence = "";
      if (params.action === "insert") {
        if (!(status.operations ?? []).includes("device.insert")) throw new Error("device insertion is unavailable");
        if (!isNonEmptyString(params.trackRef, 256) || !isNonEmptyString(params.deviceName, 256)) return error(id, -32602, "trackRef and deviceName are required for insert");
        if (params.index !== undefined && (!Number.isInteger(params.index) || (params.index as number) < -1 || (params.index as number) > 256)) return error(id, -32602, "index is invalid");
        const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.trackRef);
        if (!track) throw new Error("track is not authoritative");
        payload.trackRef = params.trackRef; payload.deviceName = params.deviceName;
        if (params.index !== undefined) payload.index = params.index;
        fence = JSON.stringify({ track: params.trackRef, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) });
      } else {
        if (!isNonEmptyString(params.deviceRef, 256)) return error(id, -32602, "deviceRef is required");
        const operation = params.action === "delete" ? "device.delete" : params.action === "enable" ? "device.enable" : "device.move";
        if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
        const { track, device } = this.deviceRow(snapshot, params.deviceRef as LiveRef);
        if (params.action === "enable" && typeof params.enabled !== "boolean") return error(id, -32602, "enabled must be boolean");
        if (params.action === "move" && (!Number.isInteger(params.index) || (params.index as number) < 0 || (params.index as number) > 256)) return error(id, -32602, "index is invalid");
        payload.ref = params.deviceRef;
        if (params.action === "enable") payload.enabled = params.enabled;
        if (params.action === "move") payload.index = params.index;
        fence = JSON.stringify({ ref: params.deviceRef, track: track.ref, devices: (track.devices as unknown[]).filter(isObject).map((item) => item.ref), enabled: device.enabled ?? null });
      }
      const transaction: ClipLifecycleTransaction = { id: `device_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device", fence, clipRef: (params.deviceRef ?? params.trackRef) as LiveRef, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, payload, impact: `device-${params.action}`, confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device preview requires fresh authoritative state."); }
  }

  private async liveDeviceApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired device transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const action = transaction.payload.action as string;
      if (action === "insert") {
        const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.payload.trackRef);
        if (!track || JSON.stringify({ track: transaction.payload.trackRef, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) }) !== transaction.fence) return this.transactionError(id, "track devices changed since preview; preview again");
      } else {
        const { track, device } = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        if (JSON.stringify({ ref: transaction.payload.ref, track: track.ref, devices: (track.devices as unknown[]).filter(isObject).map((item) => item.ref), enabled: device.enabled ?? null }) !== transaction.fence) return this.transactionError(id, "device state changed since preview; preview again");
      }
      const operation = action === "insert" ? "device.insert" : action === "delete" ? "device.delete" : action === "enable" ? "device.enable" : "device.move";
      const args: Record<string, unknown> = { ...transaction.payload };
      delete args.action;
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      transaction.created = result;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Device state is uncertain; perform fresh discovery before retrying."); }
  }

  private mixerRow(snapshot: LiveSnapshot, trackRef: LiveRef): JsonObject {
    const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === trackRef);
    if (!track || !isObject(track.mixer)) throw new Error("track with an authoritative mixer is required");
    return track.mixer as JsonObject;
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
      const mixer = this.mixerRow(snapshot, params.trackRef as LiveRef);
      if (Array.isArray(proposed.sends) && (proposed.sends as unknown[]).length > (mixer.sends as unknown[]).length) throw new Error("track has fewer sends than proposed");
      if (proposed.cueVolume !== undefined && mixer.cueRef === null) throw new Error("cue volume is unavailable on this track");
      if (proposed.volume !== undefined && mixer.volumeRef === null) throw new Error("volume is unavailable on this track");
      if (proposed.pan !== undefined && mixer.panRef === null) throw new Error("pan is unavailable on this track");
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = structuredClone(mixer[field] ?? null);
      const fence = JSON.stringify({ ref: params.trackRef, mixer });
      const transaction: ClipLifecycleTransaction = { id: `mixer_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "mixer-set", fence, clipRef: params.trackRef as LiveRef, payload: { ref: params.trackRef, ...proposed }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "mixer");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, trackRef: params.trackRef, prior, proposed, impact: "edits-mixer", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Mixer preview requires fresh authoritative state."); }
  }

  private async liveMixerApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "mixer-set" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired mixer transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const mixer = this.mixerRow(await adapter.snapshotAsync(context), transaction.clipRef!);
      if (JSON.stringify({ ref: transaction.clipRef, mixer }) !== transaction.fence) return this.transactionError(id, "mixer state changed since preview; preview again");
      const result = await adapter.invokeAsync({ operation: "mixer.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("mixer change was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Mixer state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveAutomationPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const actions = ["create-envelope", "delete-envelope", "insert", "delete-range"] as const;
    if (!isObject(params) || !hasOnly(params, ["action", "clipRef", "parameterRef", "points", "from", "to"]) || !actions.includes(params.action as typeof actions[number]) || !isNonEmptyString(params.clipRef, 256) || !isNonEmptyString(params.parameterRef, 256)) return error(id, -32602, "action, clipRef, and parameterRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const adapter = this.asyncAdapter();
      const operation = params.action === "insert" ? "automation.point.insert" : params.action === "delete-range" ? "automation.point.delete" : params.action === "create-envelope" ? "automation.envelope.create" : "automation.envelope.delete";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const read = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: params.clipRef, parameterRef: params.parameterRef } }, context) as { available?: unknown; exists?: unknown; points?: unknown };
      if (read.available !== true) throw new Error("clip envelopes are unavailable");
      const points = Array.isArray(read.points) ? read.points : [];
      const fence = JSON.stringify({ clipRef: params.clipRef, parameterRef: params.parameterRef, exists: read.exists, points });
      const payload: Record<string, unknown> = { clipRef: params.clipRef, parameterRef: params.parameterRef };
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
    if (!transaction || transaction.kind !== "automation" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired automation transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const read = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef } }, context) as { exists?: unknown; points?: unknown };
      if (JSON.stringify({ clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef, exists: read.exists, points: read.points ?? [] }) !== transaction.fence) return this.transactionError(id, "envelope changed since preview; preview again");
      const action = transaction.payload.action as string;
      const operation = action === "insert" ? "automation.point.insert" : action === "delete-range" ? "automation.point.delete" : action === "create-envelope" ? "automation.envelope.create" : "automation.envelope.delete";
      const args: Record<string, unknown> = { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef };
      if (action === "insert") args.points = transaction.payload.points;
      if (action === "delete-range") { args.from = transaction.payload.from; args.to = transaction.payload.to; }
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", result, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Automation state is uncertain; perform fresh discovery before retrying."); }
  }

  private clipRow(snapshot: LiveSnapshot, clipRef: LiveRef): { track?: JsonObject; clip: JsonObject; arrangement: boolean } {
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      const clip = (track.clips as unknown[]).filter(isObject).find((item) => item.ref === clipRef);
      if (clip) return { track, clip, arrangement: false };
    }
    const arrangementClips = (snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? [];
    const arrangement = arrangementClips.filter(isObject).find((item) => item.ref === clipRef);
    if (arrangement) return { clip: arrangement, arrangement: true };
    throw new Error("clip reference is not authoritative");
  }

  private arrangementFence(snapshot: LiveSnapshot): string {
    const clips = ((snapshot.arrangement as unknown as { clips?: unknown[] }).clips ?? []).filter(isObject).map((clip) => `${clip.ref}:${String(clip.name)}:${String(clip.start)}:${String(clip.length)}`).sort();
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
      const payload: Record<string, unknown> = { ref: params.clipRef };
      if (toArrangement) {
        payload.arrangementPosition = params.arrangementPosition;
        fence = this.arrangementFence(snapshot);
      } else {
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === params.targetTrackRef);
        if (!targetTrack) throw new Error("target track is not authoritative");
        const slots = (targetTrack.clipSlots as unknown[]).filter(isObject);
        const target = slots.find((slot) => slot.sceneIndex === params.targetSceneIndex);
        if (!target) throw new Error("target scene index is invalid");
        if (target.clipRef) throw new Error("target Session slot is occupied");
        payload.targetTrackRef = params.targetTrackRef;
        payload.targetSceneIndex = params.targetSceneIndex;
        fence = JSON.stringify({ source: params.clipRef, target: target.ref, empty: target.empty });
      }
      const transaction: ClipLifecycleTransaction = { id: `clipdup_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "duplicate", fence, clipRef: params.clipRef as LiveRef, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip duplicate");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, source: params.clipRef, destination: toArrangement ? { arrangementPosition: payload.arrangementPosition } : { trackRef: payload.targetTrackRef, sceneIndex: payload.targetSceneIndex }, impact: "duplicates-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-duplicate preview requires fresh authoritative state."); }
  }

  private async liveClipDuplicateApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "duplicate" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired clip-duplicate transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      if (transaction.payload.arrangementPosition !== undefined) {
        if (this.arrangementFence(snapshot) !== transaction.fence) return this.transactionError(id, "Arrangement changed since preview; preview again");
      } else {
        this.clipRow(snapshot, transaction.clipRef!);
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === transaction.payload.targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === transaction.payload.targetSceneIndex);
        if (!target || target.clipRef) return this.transactionError(id, "target Session slot changed since preview; preview again");
      }
      const created = await adapter.invokeAsync({ operation: "clip.duplicate", args: transaction.payload }, context) as { ref?: unknown; name?: unknown };
      if (typeof created?.ref !== "string") throw new Error("clip duplication was not confirmed");
      transaction.created = created as Record<string, unknown>;
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip duplication is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveArrangementClipPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!isObject(params) || !hasOnly(params, ["action", "trackRef", "position", "length", "name", "clipRef"]) || (params.action !== "create" && params.action !== "delete")) return error(id, -32602, "action create or delete is required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      const operation = params.action === "create" ? "arrangement.clip.create" : "arrangement.clip.delete";
      if (!(status.operations ?? []).includes(operation)) throw new Error(`${operation} is unavailable`);
      const snapshot = await this.asyncAdapter().snapshotAsync();
      const fence = this.arrangementFence(snapshot);
      const payload: Record<string, unknown> = {};
      if (params.action === "create") {
        if (!isNonEmptyString(params.trackRef, 256) || typeof params.position !== "number" || !Number.isFinite(params.position) || params.position < 0 || typeof params.length !== "number" || !Number.isFinite(params.length) || params.length <= 0 || !isNonEmptyString(params.name, 256)) return error(id, -32602, "trackRef, position, length, and name are required for create");
        if (!(snapshot.tracks as unknown as JsonObject[]).some((track) => track.ref === params.trackRef)) throw new Error("track is not authoritative");
        payload.trackRef = params.trackRef; payload.position = params.position; payload.length = params.length; payload.name = params.name;
      } else {
        if (!isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required for delete");
        const row = this.clipRow(snapshot, params.clipRef as LiveRef);
        if (!row.arrangement) return error(id, -32602, "clipRef must reference an Arrangement clip");
        payload.ref = params.clipRef;
      }
      const transaction: ClipLifecycleTransaction = { id: `arrclip_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: params.action === "create" ? "arrangement-create" : "arrangement-delete", fence, clipRef: params.clipRef as LiveRef | undefined, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "arrangement clip");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, payload, impact: params.action === "create" ? "creates-arrangement-clip" : "deletes-arrangement-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Arrangement-clip preview requires fresh authoritative state."); }
  }

  private async liveArrangementClipApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || !["arrangement-create", "arrangement-delete"].includes(transaction.kind) || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired arrangement-clip transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      if (this.arrangementFence(await adapter.snapshotAsync(context)) !== transaction.fence) return this.transactionError(id, "Arrangement changed since preview; preview again");
      const operation = transaction.kind === "arrangement-create" ? "arrangement.clip.create" : "arrangement.clip.delete";
      const result = await adapter.invokeAsync({ operation, args: transaction.payload }, context) as Record<string, unknown>;
      transaction.created = result;
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
        payload.ref = params.clipRef; payload.position = params.position;
        fence = JSON.stringify({ ref: params.clipRef, start: row.clip.start });
      } else {
        if (!(status.operations ?? []).includes("clip.duplicate") || !(status.operations ?? []).includes("clip.delete")) throw new Error("Session clip move is unavailable");
        if (!isNonEmptyString(params.targetTrackRef, 256) || !Number.isInteger(params.targetSceneIndex) || (params.targetSceneIndex as number) < 0 || (params.targetSceneIndex as number) > 10000) return error(id, -32602, "targetTrackRef and targetSceneIndex are required for a Session slot move");
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === params.targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === params.targetSceneIndex);
        if (!target) throw new Error("target scene index is invalid");
        if (target.clipRef) throw new Error("target Session slot is occupied");
        payload.duplicate = { ref: params.clipRef, targetTrackRef: params.targetTrackRef, targetSceneIndex: params.targetSceneIndex };
        payload.deleteRef = params.clipRef;
        fence = JSON.stringify({ source: params.clipRef, target: target.ref, empty: target.empty });
      }
      const transaction: ClipLifecycleTransaction = { id: `clipmove_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind, fence, clipRef: params.clipRef as LiveRef, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "clip move");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, payload, impact: "moves-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Clip-move preview requires fresh authoritative state."); }
  }

  private async liveClipMoveApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "move" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired clip-move transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      if (transaction.payload.position !== undefined) {
        const row = this.clipRow(snapshot, transaction.clipRef!);
        if (!row.arrangement || JSON.stringify({ ref: transaction.clipRef, start: row.clip.start }) !== transaction.fence) return this.transactionError(id, "Arrangement clip changed since preview; preview again");
        const result = await adapter.invokeAsync({ operation: "arrangement.clip.move", args: { ref: transaction.clipRef, position: transaction.payload.position } }, context) as Record<string, unknown>;
        transaction.created = result;
      } else {
        this.clipRow(snapshot, transaction.clipRef!);
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === (transaction.payload.duplicate as JsonObject).targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === (transaction.payload.duplicate as JsonObject).targetSceneIndex);
        if (!target || target.clipRef) return this.transactionError(id, "target Session slot changed since preview; preview again");
        const duplicated = await adapter.invokeAsync({ operation: "clip.duplicate", args: transaction.payload.duplicate as Record<string, unknown> }, context) as { ref?: unknown };
        if (typeof duplicated?.ref !== "string") throw new Error("Session clip move duplication was not confirmed");
        try {
          await adapter.invokeAsync({ operation: "clip.delete", args: { ref: transaction.clipRef } }, context);
        } catch (cause) {
          transaction.created = { ref: duplicated.ref, sourceDeleteFailed: true };
          transaction.state = "uncertain";
          throw new Error("Session clip move duplicated but the source delete failed; the move is duplicated, not moved");
        }
        transaction.created = { ref: duplicated.ref, deleted: transaction.clipRef };
      }
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Clip move is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveAudioClipPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode"] as const;
    if (!isObject(params) || !hasOnly(params, ["clipRef", ...fields]) || !isNonEmptyString(params.clipRef, 256)) return error(id, -32602, "clipRef is required");
    const proposed: Record<string, number> = {};
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || (field === "gain" && value < 0) || (field === "pitchCoarse" && Math.abs(value) > 48) || (field === "pitchFine" && Math.abs(value) > 50) || (["loopStart", "loopEnd"].includes(field) && value < 0) || (field === "warpMode" && (!Number.isInteger(value) || value < 0 || value > 16))) return error(id, -32602, `${field} is out of bounds`);
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
      const prior: Record<string, unknown> = {};
      for (const field of Object.keys(proposed)) prior[field] = row.clip[field] ?? null;
      const fence = JSON.stringify({ ref: params.clipRef, fields: fields.map((field) => row.clip[field] ?? null) });
      const transaction: ClipLifecycleTransaction = { id: `audioclip_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "audio-set", fence, clipRef: params.clipRef as LiveRef, payload: { ref: params.clipRef, ...proposed }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "audio clip");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, prior, proposed, impact: "edits-audio-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Audio-clip preview requires fresh authoritative state."); }
  }

  private async liveAudioClipApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "audio-set" || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired audio-clip transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      const row = this.clipRow(snapshot, transaction.clipRef!);
      const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode"] as const;
      if (JSON.stringify({ ref: transaction.clipRef, fields: fields.map((field) => row.clip[field] ?? null) }) !== transaction.fence) return this.transactionError(id, "audio clip changed since preview; preview again");
      const result = await adapter.invokeAsync({ operation: "audio.clip.set", args: transaction.payload }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true) throw new Error("audio clip change was not confirmed");
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Audio-clip state is uncertain; perform fresh discovery before retrying."); }
  }

  private noteClip(snapshot: LiveSnapshot, clipRef: LiveRef): { notes: Array<Record<string, unknown>> } {
    for (const track of snapshot.tracks) {
      const clip = (track.clips as unknown as Array<Record<string, unknown>>).find((item) => item.ref === clipRef);
      if (clip && clip.kind === "midi" && Array.isArray(clip.notes)) return { notes: clip.notes as Array<Record<string, unknown>> };
    }
    throw new Error("MIDI clip reference is not authoritative");
  }

  private noteFence(notes: Array<Record<string, unknown>>): string {
    return JSON.stringify(notes.map((note) => ({ id: note.id ?? null, pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, mute: note.mute ?? null, probability: note.probability ?? null, velocityDeviation: note.velocityDeviation ?? null, releaseVelocity: note.releaseVelocity ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
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
          if (!isObject(patch) || !Number.isInteger(patch.id) || (patch.id as number) < 0 || !hasOnly(patch, ["id", "pitch", "start", "duration", "velocity", "mute", "probability", "velocityDeviation", "releaseVelocity"])) return error(id, -32602, "note patches require an id and only supported fields");
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
      const priorNotes = clip.notes.filter((note) => noteIds!.includes(note.id as number)).map((note) => structuredClone(note));
      const transaction: NoteEditTransaction = { id: `note${kind}_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind, clipRef: params.clipRef as LiveRef, fence, patches, noteIds, priorNotes, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.noteEditTransactions, transaction, "note edit");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: transaction.clipRef, [kind === "update" ? "patches" : "noteIds"]: kind === "update" ? patches : noteIds, priorNotes: transaction.priorNotes, impact: kind === "update" ? "edits-midi-notes" : "deletes-midi-notes", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Note-edit preview requires fresh authoritative clip state."); }
  }

  private async liveNoteEditApplyAsync(id: RequestId, params: unknown, kind: "update" | "delete", signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.noteEditTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== kind || transaction.expiresAt <= Date.now()) return this.transactionError(id, "Unknown or expired note-edit transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const snapshot = await adapter.snapshotAsync(context);
      if (this.noteFence(this.noteClip(snapshot, transaction.clipRef).notes) !== transaction.fence) return this.transactionError(id, "clip notes changed since preview; preview again");
      const operation = kind === "update" ? "note.update" : "note.delete";
      const args = kind === "update" ? { ref: transaction.clipRef, notes: transaction.patches } : { ref: transaction.clipRef, noteIds: transaction.noteIds };
      const result = await adapter.invokeAsync({ operation, args }, context) as { updated?: unknown; deleted?: unknown };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", ...(kind === "update" ? { updated: result.updated } : { deleted: result.deleted }), idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveNoteEditUndoAsync(id: RequestId, transaction: NoteEditTransaction, params: Record<string, unknown>): Promise<JsonObject> {
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied note-edit transaction can be undone");
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter();
      const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      if (transaction.kind === "update") {
        const restore = transaction.priorNotes.map((note) => ({ id: note.id, pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 }));
        await adapter.invokeAsync({ operation: "note.update", args: { ref: transaction.clipRef, notes: restore } }, context);
        transaction.state = "undone";
        transaction.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: transaction.id, state: "undone", restored: restore.length, idempotent: false });
      }
      const reAdded: Array<Record<string, unknown>> = [];
      for (const note of transaction.priorNotes) {
        const result = await adapter.invokeAsync({ operation: "note.add", args: { ref: transaction.clipRef, note: { pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity, channel: note.channel ?? 1, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 } } }, context) as { noteId?: unknown };
        reAdded.push({ priorId: note.id, noteId: result.noteId ?? null });
      }
      transaction.state = "undone";
      transaction.undoKey = params.idempotencyKey as string;
      return this.successText(id, { transactionId: transaction.id, state: "undone", restored: reAdded.length, reAdded, note: "re-added notes receive new note ids", idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit undo is uncertain; perform fresh discovery."); }
  }

  private async liveCaptureMidiAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["confirmation"]) || params.confirmation !== "capture") return error(id, -32602, "confirmation=capture is required");
    try {
      const status = this.requireConnected("session.read");
      if (!(status.operations ?? []).includes("session.capture-midi")) throw new Error("MIDI capture is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const result = await adapter.invokeAsync({ operation: "session.capture-midi", args: {} }, context) as { captured?: unknown; clips?: unknown };
      const clips = Array.isArray(result.clips) ? result.clips : [];
      if (result.captured !== true || clips.length === 0) return this.successText(id, { captured: false, clips: [], note: "Live reported nothing captured; nothing was playing or no new MIDI was available" });
      return this.successText(id, { captured: true, clips });
    } catch (cause) { return this.adapterToolError(id, cause, "MIDI capture is uncertain; perform fresh discovery."); }
  }

  private async liveSceneCaptureAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["confirmation"]) || params.confirmation !== "capture") return error(id, -32602, "confirmation=capture is required");
    try {
      const status = this.requireConnected("session.read");
      if (!(status.operations ?? []).includes("scene.capture")) throw new Error("scene capture is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
      const result = await adapter.invokeAsync({ operation: "scene.capture", args: {} }, context) as { captured?: unknown; ref?: unknown };
      if (result.captured !== true || typeof result.ref !== "string") throw new Error("scene capture was not confirmed");
      return this.successText(id, { captured: true, sceneRef: result.ref });
    } catch (cause) { return this.adapterToolError(id, cause, "Scene capture is uncertain; perform fresh discovery."); }
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
    if (!transaction && String(params.transactionId).startsWith("transport_")) {
      const transport = this.transportTransactions.get(params.transactionId as string);
      if (!transport) return this.transactionError(id, "Unknown or expired transport transaction");
      return this.liveTransportUndoAsync(id, transport, params as Record<string, unknown>);
    }
    if (!transaction && (String(params.transactionId).startsWith("noteupdate_") || String(params.transactionId).startsWith("notedelete_"))) {
      const noteEdit = this.noteEditTransactions.get(params.transactionId as string);
      if (!noteEdit) return this.transactionError(id, "Unknown or expired note-edit transaction");
      return this.liveNoteEditUndoAsync(id, noteEdit, params as Record<string, unknown>);
    }
    if (!transaction && String(params.transactionId).startsWith("mixer_")) {
      const mixer = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!mixer || mixer.kind !== "mixer-set") return this.transactionError(id, "Unknown or expired mixer transaction");
      if (mixer.state === "undone" && mixer.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: mixer.id, state: "undone", idempotent: true });
      if (mixer.state !== "applied") return this.transactionError(id, "Only an applied mixer transaction can be undone");
      try {
        const status = this.requireConnected("session.read");
        if (status.epoch !== mixer.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter();
        const restore: Record<string, unknown> = { ref: mixer.clipRef };
        for (const field of Object.keys(mixer.payload)) if (field !== "ref") restore[field] = mixer.prior?.[field] ?? null;
        const result = await adapter.invokeAsync({ operation: "mixer.set", args: restore }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { changed?: unknown };
        if (result.changed !== true) throw new Error("mixer undo was not confirmed");
        mixer.state = "undone"; mixer.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: mixer.id, state: "undone", restored: restore, idempotent: false });
      } catch (cause) { mixer.state = "uncertain"; return this.adapterToolError(id, cause, "Mixer undo is uncertain; perform fresh discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("automation_")) {
      const automation = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!automation || automation.kind !== "automation") return this.transactionError(id, "Unknown or expired automation transaction");
      if (automation.state === "undone" && automation.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: automation.id, state: "undone", idempotent: true });
      if (automation.state !== "applied") return this.transactionError(id, "Only an applied automation transaction can be undone");
      try {
        const status = this.requireConnected("session.read");
        if (status.epoch !== automation.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter();
        const context = { deadlineMs: Date.now() + AUDITION_DEADLINE_MS };
        const action = automation.payload.action as string;
        const prior = automation.prior as { exists?: unknown; points?: unknown };
        if (action === "insert") {
          const inserted = automation.payload.points as Array<{ time: number }>;
          const times = inserted.map((point) => point.time);
          await adapter.invokeAsync({ operation: "automation.point.delete", args: { clipRef: automation.payload.clipRef, parameterRef: automation.payload.parameterRef, from: Math.min(...times) - 0.001, to: Math.max(...times) + 0.001 } }, context);
        } else if (action === "delete-range" || action === "delete-envelope") {
          const points = Array.isArray(prior.points) ? prior.points : [];
          if (prior.exists === true) await adapter.invokeAsync({ operation: "automation.envelope.create", args: { clipRef: automation.payload.clipRef, parameterRef: automation.payload.parameterRef } }, context);
          const restorePoints = action === "delete-range" ? points.filter((point) => point.time >= (automation.payload.from as number) && point.time <= (automation.payload.to as number)) : points;
          if (restorePoints.length > 0) await adapter.invokeAsync({ operation: "automation.point.insert", args: { clipRef: automation.payload.clipRef, parameterRef: automation.payload.parameterRef, points: restorePoints } }, context);
        } else if (action === "create-envelope") {
          await adapter.invokeAsync({ operation: "automation.envelope.delete", args: { clipRef: automation.payload.clipRef, parameterRef: automation.payload.parameterRef } }, context);
        }
        automation.state = "undone"; automation.undoKey = params.idempotencyKey as string;
        return this.successText(id, { transactionId: automation.id, state: "undone", idempotent: false });
      } catch (cause) { automation.state = "uncertain"; return this.adapterToolError(id, cause, "Automation undo is uncertain; perform fresh discovery."); }
    }
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
    const argumentTools = new Set(["audio_analyze", "live_discover", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi", "live_scene_capture", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_backup_preview", "live_project_backup_apply", "live_project_save", "live_project_open", "live_device_parameter_preview", "live_device_parameter_apply", "live_session_structure_preview", "live_session_structure_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo"]);
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
    if (["live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi", "live_scene_capture", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_backup_preview", "live_project_backup_apply"].includes(params.name)) return error(id, -32001, "Project operations require the asynchronous host request path");
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
  }, { notifier: (emit) => host.setEventEmitter((value) => emit(value)) }); } finally {
    const close = (adapter as Partial<{ close: () => Promise<void> }>).close;
    if (typeof close === "function") await close.call(adapter);
  }
}
