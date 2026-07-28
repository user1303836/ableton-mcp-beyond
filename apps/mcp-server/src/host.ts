import type { Readable, Writable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { AnalysisRunner, type EncodedAnalysisSource } from "./analysis-runner.js";
import type { PcmAnalysis } from "./analysis.js";
import type { ConventionalChannelLabel } from "./audio-standards.js";
import { captureMediaIsAbsent, decodeOwnedWaveFile, unlinkLateCaptureCompanions, unlinkOwnedCaptureFile, type DecodedCaptureFile } from "./audio-file.js";
import { diagnoseAudioWithLiveContext, type AudioDiagnosis } from "./audio-diagnosis.js";
import { LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_REGISTRY_OPERATIONS, LIVE_UNAVAILABLE_CAPABILITIES, UnavailableLiveAdapter, type LiveAdapter, type LiveCapability, type LiveEvent, type LiveInvocation, type LiveRef, type LiveSnapshot, type LiveStatus } from "./live.js";
import { serveStdio, type RecordContext } from "./stdio.js";
import { projectBackup, projectInfo, projectLimitation } from "./project.js";
import { SessionMidiTransactionManager, discoverSession } from "./transactions/session-midi.js";
import { JOURNEY_IDS, JOURNEY_PROMPTS, journeyResource, planUserJourney, renderJourneyPrompt, type ExperienceLevel, type JourneyId } from "./journeys.js";
import type { AsyncLiveAdapter } from "./live.js";

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
  expiresAt: number; state: "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone"; applyKey?: string; undoKey?: string;
}
interface SessionStructureItem { kind: "track" | "scene"; name: string; trackKind?: "audio" | "midi"; index: number; }
interface SessionStructureTransaction {
  id: string; epoch: number; revision: string; proposed: SessionStructureItem[];
  priorTracks: Array<{ ref: LiveRef; name: string; kind: string; index: number }>;
  priorScenes: Array<{ ref: LiveRef; name: string; index: number }>;
  created?: Array<{ ref: LiveRef; kind: "track" | "scene"; name: string; index: number }>;
  expiresAt: number; state: "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone"; applyKey?: string; undoKey?: string;
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
  state: "previewed" | "applying" | "applied" | "undoing" | "uncertain" | "undone";
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
  state: "previewed" | "applying" | "applied" | "undoing" | "undone" | "uncertain";
}
interface ClipLifecycleTransaction {
  id: string;
  epoch: number;
  kind: "rename" | "duplicate" | "arrangement-create" | "arrangement-delete" | "move" | "audio-set" | "mixer-set" | "automation" | "browser-load" | "device" | "routing-set" | "recording" | "backup" | "realtime-arm" | "capture-midi" | "scene-capture";
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
const SERVER_VERSION = "0.1.0";
const TRANSACTION_TTL_MS = 30_000;
const MAX_TRANSACTIONS = 256;
const AUDITION_TTL_MS = 30_000;
// Real-Live snapshot reads take seconds on populated sets, and launch/stop
// state propagates asynchronously at quantization boundaries; the deadline
// must cover snapshot + dispatch + polled verification.
const AUDITION_DEADLINE_MS = 15_000;
// A complete MIDI transaction crosses snapshot plus two separately authorized
// mutations and authoritative readback. Each bridge frame remains capped by
// the adapter's 5 s timeout; this absolute bound prevents later frames from
// inheriting only the exhausted tail of the general audition deadline.
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
    name: "plan_user_journey",
    description: "Build a capability-aware, non-mutating plan for one of five bounded composition, sound-design, reference, recording, or performance journeys.",
    inputSchema: {
      type: "object",
      properties: {
        journey: { type: "string", enum: [...JOURNEY_IDS] },
        traits: { type: "string", minLength: 1, maxLength: 1000 },
        experienceLevel: { type: "string", enum: ["beginner", "advanced"] },
        bars: { type: "integer", minimum: 1, maximum: 16 },
      },
      required: ["journey", "traits"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_analyze",
    description: "Analyze caller-supplied normalized float32 PCM in a cancellable isolated worker; returns bounded aggregates including BS.1770-5/EBU R128 loudness and never starts playback or mutates Live.",
    inputSchema: {
      type: "object",
      properties: {
        pcmBase64: { type: "string", description: "Little-endian float32 PCM, normalized to [-1, 1]." },
        sampleRate: { type: "integer", minimum: 8000, maximum: 384000 },
        channels: { type: "integer", minimum: 1, maximum: 32 },
        channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 7, uniqueItems: true },
        frameSize: { type: "integer", minimum: 256, maximum: 4096 },
      },
      required: ["pcmBase64", "sampleRate"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_compare_reference",
    description: "Compare two caller-supplied PCM sources in an isolated worker with bounded band-limited resampling, optional alignment, standards loudness level matching, and aggregate deltas; never returns raw audio.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "object", properties: { pcmBase64: { type: "string" }, sampleRate: { type: "integer", minimum: 32000, maximum: 96000 }, channels: { type: "integer", minimum: 1, maximum: 2 }, channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 2, uniqueItems: true } }, required: ["pcmBase64", "sampleRate"], additionalProperties: false },
        reference: { type: "object", properties: { pcmBase64: { type: "string" }, sampleRate: { type: "integer", minimum: 32000, maximum: 96000 }, channels: { type: "integer", minimum: 1, maximum: 2 }, channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 2, uniqueItems: true } }, required: ["pcmBase64", "sampleRate"], additionalProperties: false },
        alignment: { type: "object", properties: { mode: { type: "string", enum: ["auto", "manual", "disabled"] }, maxLagSeconds: { type: "number", minimum: 0, maximum: 10 }, manualOffsetSeconds: { type: "number", minimum: -10, maximum: 10 } }, additionalProperties: false },
      },
      required: ["project", "reference"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_diagnose_live_context",
    description: "Analyze caller-supplied PCM in isolation and link measurements to one fresh authoritative Live track snapshot without claiming that Live supplied the audio or that observed devices caused a result.",
    inputSchema: { type: "object", properties: { pcmBase64: { type: "string" }, sampleRate: { type: "integer", minimum: 8000, maximum: 384000 }, channels: { type: "integer", minimum: 1, maximum: 2 }, channelLayout: { type: "array", items: { type: "string", enum: ["M", "L", "R", "C", "Ls", "Rs", "LFE"] }, minItems: 1, maxItems: 2, uniqueItems: true }, trackRef: { type: "string", minLength: 1, maxLength: 256 }, provenance: { type: "object", properties: { observedAt: { type: "string", minLength: 1, maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: 512 } }, required: ["observedAt", "description"], additionalProperties: false } }, required: ["pcmBase64", "sampleRate", "trackRef", "provenance"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_audio_capture_preview",
    description: "Read-only preflight for one consent-bound, bounded Session-slot Resampling capture in an exact disposable Set. Requires real-Live provenance, an empty audio destination slot, and output-safety evidence.",
    inputSchema: { type: "object", properties: { setName: { type: "string", minLength: 1, maxLength: 256 }, sourceSlotRef: { type: "string", minLength: 1, maxLength: 256 }, destinationSlotRef: { type: "string", minLength: 1, maxLength: 256 }, durationSeconds: { type: "number", minimum: 1, maximum: 9 }, consent: { type: "string", const: "ephemeral-analysis-and-delete" }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["setName", "sourceSlotRef", "destinationSlotRef", "durationSeconds", "consent", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_audio_capture_apply",
    description: "After exact confirmation, perform one bounded potentially audible Resampling capture, isolated standards analysis, evidence-linked diagnosis, and transaction-owned clip/raw-file cleanup. No raw audio or path is returned.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", minLength: 32, maxLength: 128 }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_audio_capture_status",
    description: "Read the authenticated mapper-owned capture lifecycle without exposing its token or raw media path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_audio_capture_emergency_stop",
    description: "Independently stop and clean the exact observed mapper-owned capture after cancellation or host restart. Requires fresh exact capture and slot identities.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", const: "emergency-stop-and-clean" }, captureId: { type: "string", minLength: 16, maxLength: 128 }, sourceSlotRef: { type: "string", minLength: 1, maxLength: 256 }, destinationSlotRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["confirmation", "captureId", "sourceSlotRef", "destinationSlotRef"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
    description: "Independently authorized emergency stop of exactly the Session playback targets and recording mode observed in fresh discovery. Requires no transaction and survives host restart.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", const: "emergency-stop" }, expectedTargets: { type: "array", items: { type: "string", minLength: 1, maxLength: 1024 }, maxItems: 256, description: "Exact active playback target keys (trackRef|clipSlotRef|sceneRef) observed in a fresh live_discover/live_snapshot read." }, expectedRecording: { type: "string", enum: ["stopped", "session", "arrangement", "both"], description: "Exact recording mode observed in the same fresh read." }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["confirmation", "expectedTargets", "expectedRecording"], additionalProperties: false },
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
    name: "live_capture_midi_preview",
    description: "Read-only preflight for capturing recently played MIDI, fenced to exact Session clips and scenes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_capture_midi_apply",
    description: "Apply one exact MIDI-capture preview with idempotency, verified new clip identities, and guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_capture_preview",
    description: "Read-only preflight for capturing current Session content into one new scene, fenced to structure and playback.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "live_scene_capture_apply",
    description: "Apply one exact scene-capture preview with idempotency, verified scene identity, and guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
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
    inputSchema: { type: "object", properties: { clipRef: { type: "string", minLength: 1, maxLength: 256 }, gain: { type: "number", minimum: 0 }, pitchCoarse: { type: "number", minimum: -48, maximum: 48 }, pitchFine: { type: "number", minimum: -50, maximum: 50 }, loopStart: { type: "number", minimum: 0 }, loopEnd: { type: "number", minimum: 0 }, warpMode: { type: "integer", minimum: 0, maximum: 16 }, warping: { type: "boolean" }, fadeInLength: { type: "number", minimum: 0 }, fadeOutLength: { type: "number", minimum: 0 } }, required: ["clipRef"], additionalProperties: false },
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
    inputSchema: { type: "object", properties: { itemId: { type: "string", minLength: 1, maxLength: 256 }, trackRef: { type: "string", minLength: 1, maxLength: 256 } }, required: ["itemId", "trackRef"], additionalProperties: false },
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
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["backup"] }, allowedRoot: { type: "string", minLength: 1, maxLength: 4096, description: "Explicit absolute directory allowlisting the current Set for this backup." } }, required: ["confirmation", "allowedRoot"], additionalProperties: false },
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
    name: "live_realtime_arm_preview",
    description: "Read-only preflight for one short-lived armed realtime UDP control window scoped to exact authoritative parameter refs and explicit output-safety evidence.",
    inputSchema: { type: "object", properties: { ttlMs: { type: "integer", minimum: 1000, maximum: 30000 }, channels: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["udp-json", "osc", "xy", "max"] } }, parameterRefs: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } }, sourcePorts: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 65535 } }, outputSafety: { type: "object", properties: { safe: { type: "boolean", const: true }, provenance: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", minLength: 1, maxLength: 128 }, scope: { type: "string", minLength: 1, maxLength: 256 } }, required: ["safe", "provenance"], additionalProperties: false } }, required: ["channels", "parameterRefs", "outputSafety"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_realtime_arm_apply",
    description: "Apply an exact, unexpired realtime arm preview and receive the single-use UDP control token.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", enum: ["apply"] }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_realtime_disarm",
    description: "Immediately end the active realtime control window.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", enum: ["disarm"] } }, required: ["confirmation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "live_realtime_stats",
    description: "Read realtime control-plane acceptance, drop, replay, rate-limit, and sequence-gap counters.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
    name: "live_object_rename_preview",
    description: "Preview a purpose-specific track, scene, clip, device, or locator rename against its exact current name.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["track", "scene", "clip", "device", "locator"] }, ref: { type: "string", minLength: 1, maxLength: 256 }, name: { type: "string", minLength: 1, maxLength: 256 } }, required: ["kind", "ref", "name"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "live_object_rename_apply",
    description: "Apply one exact revision-fenced rename and support guarded undo.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string", minLength: 1, maxLength: 128 }, confirmation: { type: "string", const: "apply" }, idempotencyKey: { type: "string", minLength: 1, maxLength: 128 } }, required: ["transactionId", "confirmation", "idempotencyKey"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    description: "Undo a verified guarded transaction only when fresh authoritative state still matches its exact postcondition.",
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
] as const;

const unavailableCapabilities = [...hostUnavailableCapabilities, "live.audio.analysis", "live.audio.capture.resampling", ...LIVE_UNAVAILABLE_CAPABILITIES] as const;
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
class BoundedTransactionMap<T extends { expiresAt: number; state: string }> extends Map<string, T> {
  public constructor(private readonly capacity = MAX_AUDITION_TRANSACTIONS) { super(); }
  public override set(key: string, value: T): this {
    const now = Date.now();
    for (const [candidateKey, candidate] of this) if (candidate.expiresAt <= now && !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(candidateKey)) this.delete(candidateKey);
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
  private readonly clipLifecycleTransactions = new BoundedTransactionMap<ClipLifecycleTransaction>();

  public constructor(private readonly adapter: LiveAdapter = new UnavailableLiveAdapter()) { this.midiTransactions = new SessionMidiTransactionManager(adapter); }

  private async singleFlightMutation(name: string, id: RequestId, args: unknown, execute: (signal?: AbortSignal) => Promise<JsonObject | null>, callerSignal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(args) || !isNonEmptyString(args.idempotencyKey, 128)) return await execute(callerSignal);
    const transactionId = isNonEmptyString(args.transactionId, 128) ? args.transactionId : isNonEmptyString(args.captureId, 128) ? args.captureId : null;
    const identity = transactionId ? `operation:${name}:transaction:${transactionId}` : `operation:${name}:key:${args.idempotencyKey}`;
    const argumentDigest = createHash("sha256").update(canonicalMutationIdentity(args)).digest("hex");
    let flight = this.inFlightMutations.get(identity);
    const joined = flight !== undefined;
    if (flight && (flight.idempotencyKey !== args.idempotencyKey || flight.argumentDigest !== argumentDigest)) throw new Error("operation is already applying with different idempotency or authority arguments");
    if (!flight) {
      const controller = new AbortController();
      flight = { idempotencyKey: args.idempotencyKey, argumentDigest, controller, waiters: 0, settled: false, promise: undefined as unknown as Promise<JsonObject | null> };
      const owned = flight;
      if (transactionId) IN_FLIGHT_TRANSACTION_IDS.add(transactionId);
      owned.promise = execute(controller.signal).finally(() => {
        owned.settled = true;
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
    if (!isObject(input) || input.method !== "tools/call" || !isObject(input.params) || typeof input.params.name !== "string") return this.handle(input);
    const name = input.params.name;
    const toolArguments = input.params.arguments;
    if (![ "audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop", "live_session_structure_preview", "live_session_structure_apply", "live_object_rename_preview", "live_object_rename_apply", "live_snapshot", "live_discover", "live_device_parameter_preview", "live_device_parameter_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi_preview", "live_capture_midi_apply", "live_scene_capture_preview", "live_scene_capture_apply", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_backup_preview", "live_project_backup_apply", "live_project_save", "live_project_open", "live_realtime_arm_preview", "live_realtime_arm_apply", "live_realtime_disarm", "live_realtime_stats"].includes(name)) return this.handle(input);
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
      const execute = async (operationSignal: AbortSignal | undefined = signal): Promise<JsonObject | null> => {
      const signal = operationSignal;
      if (signal?.aborted) return null;
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
      if (name === "live_project_backup_preview") return await this.liveProjectBackupPreviewAsync(id, toolArguments);
      if (name === "live_project_backup_apply") return await this.liveProjectBackupApplyAsync(id, toolArguments, signal);
      if (name === "live_project_save") return this.successText(id, projectLimitation("save"));
      if (name === "live_project_open") return this.successText(id, projectLimitation("open/new/export/collect/bounce"));
      if (name === "live_realtime_arm_preview") return await this.liveRealtimeArmPreviewAsync(id, toolArguments);
      if (name === "live_realtime_arm_apply") return await this.liveRealtimeArmApplyAsync(id, toolArguments, signal);
      if (name === "live_realtime_disarm") return await this.liveRealtimeDisarmAsync(id, toolArguments);
      if (name === "live_realtime_stats") return await this.liveRealtimeStatsAsync(id, toolArguments);
      if (name === "live_device_parameter_preview") return await this.liveDeviceParameterPreviewAsync(id, toolArguments);
      if (name === "live_device_parameter_apply") return await this.liveDeviceParameterApplyAsync(id, toolArguments, signal);
      if (name === "live_midi_clip_preview") return await this.liveMidiPreviewAsync(id, toolArguments);
      if (name === "live_midi_clip_apply") return await this.liveMidiApplyAsync(id, toolArguments, signal);
      if (name === "live_arrangement_section_preview") return await this.liveArrangementPreviewAsync(id, toolArguments);
      if (name === "live_arrangement_section_apply") return await this.liveArrangementApplyAsync(id, toolArguments, signal);
      if (name === "live_tempo_preview") return await this.liveTempoPreviewAsync(id, toolArguments);
      if (name === "live_tempo_apply") return await this.liveTempoApplyAsync(id, toolArguments, signal);
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
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isNonEmptyString(params.idempotencyKey, 128)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
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
    const identity = { tracks: snapshot.tracks.map((item, index) => [item.ref, item.name, item.kind, index]), scenes: snapshot.scenes.map((item, index) => [item.ref, item.name, index]) };
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
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

  private async liveSessionStructureApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.sessionStructureTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Session-structure transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Session-structure preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("session.structure"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; const current = await adapter.snapshotAsync(context);
      if (this.structureRevision(current) !== transaction.revision) return this.transactionError(id, "Session structure changed since preview");
      const created: NonNullable<SessionStructureTransaction["created"]> = [];
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      try {
        for (const item of transaction.proposed) {
          const operation = item.kind === "track" ? "track.create" : "scene.create";
          const expectedStructureRevision = this.structureRevision(await adapter.snapshotAsync(context));
          const result = await adapter.invokeAsync({ operation, args: { name: item.name, ...(item.kind === "track" ? { kind: item.trackKind } : {}), index: item.index, expectedStructureRevision } }, context) as { ref?: LiveRef; name?: string; index?: number };
          if (!result?.ref || result.name !== item.name) throw new Error(`Live did not confirm created ${item.kind}`);
          created.push({ ref: result.ref, kind: item.kind, name: result.name, index: result.index ?? item.index });
        }
        const verified = await adapter.snapshotAsync(context);
        if (!created.every((item) => item.kind === "track" ? verified.tracks.some((track) => track.ref === item.ref && track.name === item.name) : verified.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) throw new Error("Live did not confirm Session structure");
      } catch (cause) {
        for (const item of [...created].reverse()) { try { const recoveryContext = { deadlineMs: Date.now() + 5_000 }; const expectedStructureRevision = this.structureRevision(await adapter.snapshotAsync(recoveryContext)); await adapter.invokeAsync({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision } }, recoveryContext); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Session-structure apply compensation failed; read authoritative structure before retrying"); } }
        throw cause;
      }
      transaction.created = created; transaction.applyKey = params.idempotencyKey as string; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", created, epoch: transaction.epoch, idempotent: false });
    } catch (cause) { if (transaction.state === "applying") transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Session-structure apply is uncertain; read authoritative tracks and scenes before retrying."); }
  }

  private async liveObjectRenamePreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    const kinds = ["track", "scene", "clip", "device", "locator"] as const;
    if (!isObject(params) || !hasOnly(params, ["kind", "ref", "name"]) || !kinds.includes(params.kind as typeof kinds[number]) || !isNonEmptyString(params.ref, 256) || !isNonEmptyString(params.name, 256)) return error(id, -32602, "kind, ref, and a non-empty name are required");
    try {
      const status = this.requireConnected("session.read"); const operation = `${params.kind}.rename` as LiveInvocation["operation"];
      if (!status.operations?.includes(operation)) throw new Error(`${operation} is unavailable on this Live shape`);
      const adapter = this.asyncAdapter();
      if (params.kind === "track") { const snapshot = await adapter.snapshotAsync({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS }); if (!snapshot.tracks.some((track) => track.ref === params.ref)) throw new Error("track rename is limited to regular Set tracks"); }
      const current = await adapter.getAsync(params.ref as LiveRef, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { ref?: unknown; name?: unknown } | undefined;
      if (!current || current.ref !== params.ref || typeof current.name !== "string") throw new Error("rename target is not authoritative");
      if (current.name === params.name) throw new Error("rename would not change the target");
      const transaction: ClipLifecycleTransaction = { id: `rename_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "rename", fence: JSON.stringify({ ref: params.ref, name: current.name, kind: params.kind }), clipRef: params.ref as LiveRef, payload: { kind: params.kind, name: params.name }, prior: { name: current.name }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "rename");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, target: { kind: params.kind, ref: params.ref, currentName: current.name }, proposedName: params.name, impact: "renames-one-live-object", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Rename preview failed without mutation; rediscover the exact target."); }
  }

  private async liveObjectRenameApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "rename" || !transaction.clipRef || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired rename transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", name: transaction.payload.name, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Rename transaction is no longer applicable");
    try {
      const status = this.requireConnected("session.read"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const current = await adapter.getAsync(transaction.clipRef, context) as { ref?: unknown; name?: unknown } | undefined;
      if (!current || JSON.stringify({ ref: current.ref, name: current.name, kind: transaction.payload.kind }) !== transaction.fence) return this.transactionError(id, "Rename target changed since preview");
      const operation = `${transaction.payload.kind}.rename` as LiveInvocation["operation"];
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      await adapter.invokeAsync({ operation, args: { ref: transaction.clipRef, name: transaction.payload.name, expectedName: transaction.prior?.name } }, context);
      const verified = await adapter.getAsync(transaction.clipRef, context) as { name?: unknown } | undefined;
      if (!verified || verified.name !== transaction.payload.name) throw new Error("rename postcondition was not confirmed");
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", ref: transaction.clipRef, name: verified.name, idempotent: false });
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); if (transaction.state === "applying") { transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain"; if (transaction.state === "previewed") delete transaction.applyKey; } return this.adapterToolError(id, cause, "Rename state may be uncertain; rediscover the exact target before further edits."); }
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
    for (const [key, candidate] of this.auditionTransactions) if (candidate.expiresAt <= now && !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(key)) this.auditionTransactions.delete(key);
    while (this.auditionTransactions.size >= MAX_AUDITION_TRANSACTIONS) {
      const oldest = [...this.auditionTransactions].find(([candidateKey, candidate]) => !RECOVERY_PROTECTED_STATES.has(candidate.state) && !IN_FLIGHT_TRANSACTION_IDS.has(candidateKey));
      if (!oldest) throw new Error("audition transaction capacity is exhausted by in-flight auditions");
      this.auditionTransactions.delete(oldest[0]);
    }
    this.auditionTransactions.set(transaction.id, transaction);
  }

  private async liveSessionAuditionApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!isObject(params) || !hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) || !isNonEmptyString(params.transactionId, 128) || !isNonEmptyString(params.confirmation, 128) || !isNonEmptyString(params.idempotencyKey, 128)) return error(id, -32602, "transactionId, exact confirmation, and idempotencyKey are required");
    const transaction = this.auditionTransactions.get(params.transactionId as string);
    if (!transaction || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired audition transaction");
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
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id };
      const before = await adapter.snapshotAsync(context);
      const state = this.auditionSnapshot(before, transaction.sceneRef);
      if (JSON.stringify(state.scene) !== transaction.sceneRevision || state.playbackRevision !== transaction.playbackRevision) throw new Error("audition state changed since preview");
      // Safety evidence and all dynamic preconditions are rechecked immediately
      // before the single potentially audible dispatch; the mapper then rechecks
      // the same conditions atomically on Live's main thread before firing.
      this.validateAuditionSafety(status, state.set, state.tracks, state.playback, transaction.outputSafety, transaction.setName);
      if (signal?.aborted) throw new Error("audition apply cancelled before dispatch");
      const scene = state.scene as { name?: unknown; index?: unknown };
      const result = await adapter.invokeAsync({ operation: "session.audition-launch", args: { ref: transaction.sceneRef, setName: transaction.setName, sceneName: scene.name, sceneIndex: scene.index, playbackRevision: state.playback.revision, eligibleTargets: transaction.eligibleTargetKeys, outputSafety: transaction.outputSafety } }, context) as { launched?: unknown; targets?: unknown };
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
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.stopKey, transactionId: transaction.id };
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
    if (!isObject(params) || !hasOnly(params, ["confirmation", "expectedTargets", "expectedRecording", "idempotencyKey"]) || params.confirmation !== "emergency-stop" || !["stopped", "session", "arrangement", "both"].includes(String(params.expectedRecording)) || !Array.isArray(params.expectedTargets) || params.expectedTargets.length > 256 || new Set(params.expectedTargets).size !== params.expectedTargets.length || !params.expectedTargets.every((item) => isNonEmptyString(item, 1024)) || (params.idempotencyKey !== undefined && !isNonEmptyString(params.idempotencyKey, 128))) return error(id, -32602, "confirmation=emergency-stop plus exact freshly observed active playback targets and recording mode are required");
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
    if (!transaction || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired transport transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const result = await adapter.invokeAsync({ operation: "transport.set", args: { ...transaction.proposed, expectedRevision: transaction.playbackRevision } }, context) as { changed?: unknown; revision?: unknown };
      if (result.changed !== true || typeof result.revision !== "string") throw new Error("transport change was not confirmed");
      if (typeof transaction.proposed.position === "number") await this.confirmTransportPosition(adapter, context, transaction.proposed.position);
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", revision: result.revision, idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Transport state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveTransportUndoAsync(id: RequestId, transaction: TransportTransaction, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonObject> {
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied transport transaction can be undone");
    try {
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
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
    if (!transaction || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-launch transaction");
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
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.applyKey, transactionId: transaction.id };
      const snapshot = await adapter.snapshotAsync(context);
      const transport = snapshot.playback?.transport;
      if (!transport) throw new Error("authoritative playback state is unavailable");
      if (snapshot.playback.revision !== transaction.playbackRevision) throw new Error("playback state changed since preview");
      if (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false || snapshot.playback.firedTargets.length > 0 || snapshot.playback.playingTargets.length > 0) throw new Error("clip launch requires a stopped, non-recording baseline with no active Session targets");
      const stillThere = (snapshot.tracks as unknown as JsonObject[]).some((track) => track.ref === transaction.trackRef && Array.isArray(track.clipSlots) && (track.clipSlots as unknown[]).filter(isObject).some((slot) => slot.ref === transaction.slotRef && slot.clipRef === transaction.clipRef && slot.sceneIndex === transaction.sceneIndex));
      if (!stillThere) throw new Error("clip slot content changed since preview");
      this.validateOutputSafety(transaction.outputSafety);
      if (signal?.aborted) throw new Error("clip launch cancelled before dispatch");
      const result = await adapter.invokeAsync({ operation: "session.clip-launch", args: { slotRef: transaction.slotRef, trackRef: transaction.trackRef, sceneRef: transaction.sceneRef, sceneIndex: transaction.sceneIndex, clipRef: transaction.clipRef, playbackRevision: transaction.playbackRevision, outputSafety: transaction.outputSafety } }, context) as { launched?: unknown; targets?: unknown };
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
      if (!(status.operations ?? []).includes("session.clip-stop")) throw new Error("track stop operation is unavailable");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: transaction.stopKey, transactionId: transaction.id };
      const before = await adapter.snapshotAsync(context);
      const ours = [...before.playback.firedTargets, ...before.playback.playingTargets].some((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}` === transaction.targetKey);
      if (ours) {
        if (signal?.aborted) throw new Error("clip-launch stop cancelled before dispatch");
        await adapter.invokeAsync({ operation: "session.clip-stop", args: { slotRef: transaction.slotRef, trackRef: transaction.trackRef, sceneRef: transaction.sceneRef, sceneIndex: transaction.sceneIndex, clipRef: transaction.clipRef } }, context);
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
    if (!transaction || transaction.kind !== "routing-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired routing transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.clipRef);
      if (!track || JSON.stringify({ ref: transaction.clipRef, routing: track.routing, armed: track.armed, monitoringState: track.monitoringState }) !== transaction.fence) return this.transactionError(id, "routing state changed since preview; preview again");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
      if (this.eventOverflow === 1) this.eventQueue.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/live_event_overflow", params: { epoch: this.safeAdapterStatus().epoch, dropped: "some", resnapshot: true } }));
      return;
    }
    this.eventQueue.push(line);
    if (!this.eventFlushScheduled) {
      this.eventFlushScheduled = true;
      setImmediate(() => {
        this.eventFlushScheduled = false;
        const lines = this.eventQueue.splice(0, this.eventQueue.length); this.eventOverflow = 0;
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
        if (!isNonEmptyString(params.destinationTrackRef, 256)) throw new Error("recording start requires an explicit destination track");
        const destination = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.destinationTrackRef);
        if (!destination) throw new Error("destination track is not authoritative");
        if (destination.armed !== true) throw new Error("destination track is not armed for recording; arm it through live_routing_preview first");
        const additionallyArmed = (snapshot.tracks as unknown as JsonObject[]).filter((item) => item.ref !== params.destinationTrackRef && item.armed === true);
        if (additionallyArmed.length > 0) throw new Error("recording start requires the exact destination to be the only armed track");
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
    if (!transaction || transaction.kind !== "recording" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired recording transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const transport = snapshot.playback?.transport;
      if (!transport || JSON.stringify({ sessionRecord: transport.sessionRecord, arrangementRecord: transport.arrangementRecord, playing: transport.playing }) !== transaction.fence) { transaction.state = "uncertain"; return this.transactionError(id, "recording state changed since preview; preview again"); }
      if (transaction.payload.action === "start") {
        const destinationRef = transaction.payload.destinationTrackRef;
        const armed = (snapshot.tracks as unknown as JsonObject[]).filter((track) => track.armed === true);
        if (!isNonEmptyString(destinationRef, 256) || armed.length !== 1 || armed[0]?.ref !== destinationRef) { transaction.state = "uncertain"; return this.transactionError(id, "recording arm/destination state changed since preview; preview again"); }
      }
      const operation = transaction.payload.lane === "session" ? "recording.session" : "recording.arrangement";
      const prior = transaction.prior as Record<string, unknown>;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args: {
        action: transaction.payload.action,
        expectedSessionRecord: prior.sessionRecord,
        expectedArrangementRecord: prior.arrangementRecord,
        destinationTrackRef: transaction.payload.destinationTrackRef ?? null,
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
    const add = (reference: unknown, value: unknown, details: JsonObject): void => {
      if (typeof reference === "string") available.set(reference, { ref: reference, value: typeof value === "number" && Number.isFinite(value) ? value : null, ...details });
    };
    for (const track of snapshot.tracks as unknown as JsonObject[]) {
      const mixer = isObject(track.mixer) ? track.mixer : undefined;
      if (mixer) {
        add(mixer.volumeRef, mixer.volume, { kind: "mixer-volume", trackRef: track.ref });
        add(mixer.panRef, mixer.pan, { kind: "mixer-pan", trackRef: track.ref });
        add(mixer.cueRef, mixer.cueVolume, { kind: "mixer-cue", trackRef: track.ref });
        const sendRefs = Array.isArray(mixer.sendRefs) ? mixer.sendRefs : [];
        const sends = Array.isArray(mixer.sends) ? mixer.sends : [];
        sendRefs.slice(0, 128).forEach((reference, index) => add(reference, sends[index], { kind: "mixer-send", trackRef: track.ref, sendIndex: index }));
      }
      const queue: JsonObject[] = Array.isArray(track.devices) ? (track.devices as unknown[]).filter(isObject).slice(0, 512) : [];
      for (let cursor = 0; cursor < queue.length && cursor < 512; cursor += 1) {
        const device = queue[cursor]!;
        for (const parameter of (Array.isArray(device.parameters) ? device.parameters : []).filter(isObject).slice(0, 512)) add(parameter.ref, parameter.value, { kind: "device-parameter", deviceRef: device.ref, min: parameter.min ?? null, max: parameter.max ?? null, enabled: parameter.enabled ?? null, automatable: parameter.automatable ?? null, revision: parameter.revision ?? null });
        for (const macro of (Array.isArray(device.macros) ? device.macros : []).filter(isObject).slice(0, 128)) add(macro.ref, macro.value, { kind: "rack-macro", deviceRef: device.ref });
        const parents = [device, ...(Array.isArray(device.drumPads) ? (device.drumPads as unknown[]).filter(isObject) : [])];
        for (const parent of parents) for (const chain of (Array.isArray(parent.chains) ? parent.chains : []).filter(isObject).slice(0, 128)) for (const nested of (Array.isArray(chain.devices) ? chain.devices : []).filter(isObject).slice(0, 128)) if (queue.length < 512) queue.push(nested);
      }
    }
    return references.map((reference) => {
      const target = available.get(reference);
      if (!target) throw new Error(`realtime parameter ref is not an authoritative published target: ${reference}`);
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
      const payload: Record<string, unknown> = { ttlMs, channels: structuredClone(params.channels), parameterRefs, outputSafety: structuredClone(params.outputSafety as JsonObject) };
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
      const args: Record<string, unknown> = { ttlMs: transaction.payload.ttlMs, channels: transaction.payload.channels, parameterRefs, outputSafety: transaction.payload.outputSafety };
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
    if (!isObject(params) || !hasOnly(params, ["itemId", "trackRef"]) || !isNonEmptyString(params.itemId, 256) || !isNonEmptyString(params.trackRef, 256)) return error(id, -32602, "itemId and trackRef are required");
    try {
      const status = await this.freshStatus({ deadlineMs: Date.now() + AUDITION_DEADLINE_MS });
      if (!status.connected || !(status.capabilities ?? []).includes("session.read")) throw new Error("session read capability is unavailable");
      if (!(status.operations ?? []).includes("browser.load") || !(status.operations ?? []).includes("browser.inspect")) throw new Error("browser loading or item inspection is unavailable");
      const adapter = this.asyncAdapter();
      const item = await adapter.invokeAsync({ operation: "browser.inspect", args: { itemId: params.itemId } }, { deadlineMs: Date.now() + AUDITION_DEADLINE_MS }) as { id?: unknown; name?: unknown; isDevice?: unknown; path?: unknown; category?: unknown };
      if (item.id !== params.itemId || item.isDevice !== true || typeof item.name !== "string") throw new Error("browser item is not an exact track-loadable device");
      const snapshot = await adapter.snapshotAsync();
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === params.trackRef);
      if (!track || !["regular", "group", "audio", "midi"].includes(String(track.kind))) throw new Error("browser loading is limited to regular Set tracks");
      const fence = JSON.stringify({ track: params.trackRef, deviceCount: (track.devices as unknown[]).length, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) });
      const transaction: ClipLifecycleTransaction = { id: `browserload_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "browser-load", fence, clipRef: params.trackRef as LiveRef, payload: { itemId: params.itemId, trackRef: params.trackRef, expectedName: item.name }, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "browser load");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, item: { id: item.id, name: item.name, path: item.path, category: item.category, isDevice: true }, trackRef: params.trackRef, impact: "loads-browser-device", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Browser-load preview requires fresh authoritative state."); }
  }

  private async liveBrowserLoadApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "browser-load" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired browser-load transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.payload.trackRef);
      if (!track || !["regular", "group", "audio", "midi"].includes(String(track.kind)) || JSON.stringify({ track: transaction.payload.trackRef, deviceCount: (track.devices as unknown[]).length, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) }) !== transaction.fence) return this.transactionError(id, "track devices changed since preview; preview again");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
        const located = this.deviceRow(snapshot, params.deviceRef as LiveRef); const { device } = located;
        if (!isNonEmptyString(device.objectIdentity, 256)) throw new Error("device object identity is unavailable");
        if (params.action === "enable" && typeof params.enabled !== "boolean") return error(id, -32602, "enabled must be boolean");
        if (params.action === "move" && (!Number.isInteger(params.index) || (params.index as number) < 0 || (params.index as number) > 256)) return error(id, -32602, "index is invalid");
        payload.ref = params.deviceRef; payload.expectedObjectIdentity = device.objectIdentity; payload.expectedOwnerRef = located.ownerRef; payload.expectedOwnerIdentity = located.ownerIdentity; payload.expectedSiblings = located.siblings;
        if (params.action === "enable") payload.enabled = params.enabled;
        if (params.action === "move") payload.index = params.index;
        fence = this.deviceFence(located);
      }
      const transaction: ClipLifecycleTransaction = { id: `device_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "device", fence, clipRef: (params.deviceRef ?? params.trackRef) as LiveRef, payload, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "device");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, action: params.action, payload, impact: `device-${params.action}`, confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Device preview requires fresh authoritative state."); }
  }

  private async liveDeviceApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "device" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired device transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const action = transaction.payload.action as string;
      if (action === "insert") {
        const track = (snapshot.tracks as unknown as JsonObject[]).find((item) => item.ref === transaction.payload.trackRef);
        if (!track || JSON.stringify({ track: transaction.payload.trackRef, devices: (track.devices as unknown[]).filter(isObject).map((device) => device.ref) }) !== transaction.fence) return this.transactionError(id, "track devices changed since preview; preview again");
      } else {
        const located = this.deviceRow(snapshot, transaction.payload.ref as LiveRef);
        if (this.deviceFence(located) !== transaction.fence) return this.transactionError(id, "device state changed since preview; preview again");
      }
      const operation = action === "insert" ? "device.insert" : action === "delete" ? "device.delete" : action === "enable" ? "device.enable" : "device.move";
      const args: Record<string, unknown> = { ...transaction.payload };
      delete args.action;
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
    if (!transaction || transaction.kind !== "mixer-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired mixer transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const mixer = this.mixerRow(await adapter.snapshotAsync(context), transaction.clipRef!);
      if (JSON.stringify({ ref: transaction.clipRef, mixer }) !== transaction.fence) return this.transactionError(id, "mixer state changed since preview; preview again");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
    if (!transaction || transaction.kind !== "automation" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired automation transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const read = await adapter.invokeAsync({ operation: "automation.envelope.read", args: { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef } }, context) as { exists?: unknown; points?: unknown };
      if (JSON.stringify({ clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef, exists: read.exists, points: read.points ?? [] }) !== transaction.fence) return this.transactionError(id, "envelope changed since preview; preview again");
      const action = transaction.payload.action as string;
      const operation = action === "insert" ? "automation.point.insert" : action === "delete-range" ? "automation.point.delete" : action === "create-envelope" ? "automation.envelope.create" : "automation.envelope.delete";
      const args: Record<string, unknown> = { clipRef: transaction.payload.clipRef, parameterRef: transaction.payload.parameterRef };
      if (action === "insert") args.points = transaction.payload.points;
      if (action === "delete-range") { args.from = transaction.payload.from; args.to = transaction.payload.to; }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args }, context) as Record<string, unknown>;
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
    if (!transaction || transaction.kind !== "duplicate" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-duplicate transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      if (transaction.payload.arrangementPosition !== undefined) {
        if (this.arrangementFence(snapshot) !== transaction.fence) return this.transactionError(id, "Arrangement changed since preview; preview again");
      } else {
        this.clipRow(snapshot, transaction.clipRef!);
        const targetTrack = (snapshot.tracks as unknown as JsonObject[]).find((track) => track.ref === transaction.payload.targetTrackRef);
        const target = targetTrack && (targetTrack.clipSlots as unknown[]).filter(isObject).find((slot) => slot.sceneIndex === transaction.payload.targetSceneIndex);
        if (!target || target.clipRef) return this.transactionError(id, "target Session slot changed since preview; preview again");
      }
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
    if (!transaction || !["arrangement-create", "arrangement-delete"].includes(transaction.kind) || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired arrangement-clip transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      if (this.arrangementFence(await adapter.snapshotAsync(context)) !== transaction.fence) return this.transactionError(id, "Arrangement changed since preview; preview again");
      const operation = transaction.kind === "arrangement-create" ? "arrangement.clip.create" : "arrangement.clip.delete";
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
    if (!transaction || transaction.kind !== "move" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired clip-move transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
      const fence = JSON.stringify({ ref: params.clipRef, fields: fields.map((field) => row.clip[field] ?? null) });
      const transaction: ClipLifecycleTransaction = { id: `audioclip_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind: "audio-set", fence, clipRef: params.clipRef as LiveRef, payload: { ref: params.clipRef, ...proposed }, prior, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, "audio clip");
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, clipRef: params.clipRef, prior, proposed, impact: "edits-audio-clip", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Audio-clip preview requires fresh authoritative state."); }
  }

  private async liveAudioClipApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== "audio-set" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired audio-clip transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      const row = this.clipRow(snapshot, transaction.clipRef!);
      const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"] as const;
      if (JSON.stringify({ ref: transaction.clipRef, fields: fields.map((field) => row.clip[field] ?? null) }) !== transaction.fence) return this.transactionError(id, "audio clip changed since preview; preview again");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
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
    if (!transaction || transaction.kind !== kind || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired note-edit transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if (signal?.aborted) return null;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const snapshot = await adapter.snapshotAsync(context);
      if (this.noteFence(this.noteClip(snapshot, transaction.clipRef).notes) !== transaction.fence) return this.transactionError(id, "clip notes changed since preview; preview again");
      const operation = kind === "update" ? "note.update" : "note.delete";
      const args = kind === "update" ? { ref: transaction.clipRef, notes: transaction.patches } : { ref: transaction.clipRef, noteIds: transaction.noteIds };
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      const result = await adapter.invokeAsync({ operation, args }, context) as { updated?: unknown; deleted?: unknown };
      transaction.applyKey = params.idempotencyKey as string;
      transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", ...(kind === "update" ? { updated: result.updated } : { deleted: result.deleted }), idempotent: false });
    } catch (cause) { transaction.state = "uncertain"; return this.adapterToolError(id, cause, "Note-edit state is uncertain; perform fresh discovery before retrying."); }
  }

  private async liveNoteEditUndoAsync(id: RequestId, transaction: NoteEditTransaction, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonObject> {
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied note-edit transaction can be undone");
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter();
      const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      transaction.state = "undoing"; transaction.undoKey = params.idempotencyKey as string;
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

  private captureObjectFingerprint(value: unknown): string { return createHash("sha256").update(canonicalMutationIdentity(value)).digest("hex"); }

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
      const transaction: ClipLifecycleTransaction = { id: `${kind === "capture-midi" ? "capturemidi" : "scenecapture"}_${randomBytes(18).toString("base64url")}`, epoch: status.epoch as number, kind, fence: this.captureFence(snapshot), payload: {}, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
      this.retainBoundedTransaction(this.clipLifecycleTransactions, transaction, kind);
      return this.successText(id, { transactionId: transaction.id, epoch: transaction.epoch, impact: kind === "capture-midi" ? "creates-session-midi-clips" : "creates-one-session-scene", confirmation: "apply", expiresAt: transaction.expiresAt });
    } catch (cause) { return this.adapterToolError(id, cause, "Capture preview failed without mutation; rediscover Session state."); }
  }

  private async liveCaptureApplyAsync(id: RequestId, params: unknown, kind: "capture-midi" | "scene-capture", signal?: AbortSignal): Promise<JsonObject | null> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.clipLifecycleTransactions.get(params.transactionId as string);
    if (!transaction || transaction.kind !== kind || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Unknown or expired capture transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", created: transaction.created, idempotent: true });
    if (transaction.state !== "previewed") return this.transactionError(id, "Capture transaction is no longer applicable");
    if (signal?.aborted) return null;
    transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string; let dispatched = false;
    try {
      const status = this.requireConnected("session.read");
      if (status.epoch !== transaction.epoch) { transaction.state = "previewed"; delete transaction.applyKey; return this.transactionError(id, "Live connection epoch changed; preview again"); }
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const before = await adapter.snapshotAsync(context);
      if (this.captureFence(before) !== transaction.fence) { transaction.state = "previewed"; delete transaction.applyKey; return this.transactionError(id, "Session state changed since capture preview; preview again"); }
      dispatched = true;
      if (kind === "capture-midi") {
        const result = await adapter.invokeAsync({ operation: "session.capture-midi", args: {} }, context) as { captured?: unknown; clips?: unknown; clipIdentities?: unknown };
        const clips = Array.isArray(result.clips) ? result.clips.filter((ref): ref is string => typeof ref === "string") : [];
        const identities = Array.isArray(result.clipIdentities) ? result.clipIdentities.filter(isObject) : [];
        const after = await adapter.snapshotAsync(context); const authoritative = new Map(after.tracks.flatMap((track) => track.clips.map((clip) => [clip.ref, clip] as const)));
        if (result.captured !== (clips.length > 0) || identities.length !== clips.length || clips.some((ref) => !authoritative.has(ref as LiveRef))) throw new Error("MIDI capture postcondition was not confirmed");
        const owned = clips.map((ref) => { const identity = identities.find((row) => row.ref === ref); const clip = authoritative.get(ref as LiveRef); if (!identity || !isNonEmptyString(identity.objectIdentity, 256) || !clip) throw new Error("captured MIDI object identity is unavailable"); return { ref, objectIdentity: identity.objectIdentity, fingerprint: this.captureObjectFingerprint(clip) }; });
        transaction.created = { clips: owned };
      } else {
        const result = await adapter.invokeAsync({ operation: "scene.capture", args: {} }, context) as { captured?: unknown; ref?: unknown; objectIdentity?: unknown };
        const after = await adapter.snapshotAsync(context); const scene = after.scenes.find((row) => row.ref === result.ref);
        if (result.captured !== true || typeof result.ref !== "string" || !isNonEmptyString(result.objectIdentity, 256) || !scene) throw new Error("scene capture postcondition was not confirmed");
        transaction.created = { sceneRef: result.ref, objectIdentity: result.objectIdentity, fingerprint: this.captureObjectFingerprint(scene) };
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

  private validateDeviceParameterPreview(params: unknown): params is { deviceRef: string; parameterRef: string; value: number } {
    return isObject(params) && hasOnly(params, ["deviceRef", "parameterRef", "value"]) && isNonEmptyString(params.deviceRef, 256) && isNonEmptyString(params.parameterRef, 256) && typeof params.value === "number" && Number.isFinite(params.value);
  }

  private validDeviceParameterApply(params: unknown): params is JsonObject {
    return isObject(params) && hasOnly(params, ["transactionId", "confirmation", "idempotencyKey"]) && isNonEmptyString(params.transactionId, 128) && isNonEmptyString(params.confirmation, 128) && isNonEmptyString(params.idempotencyKey, 128);
  }

  private async liveDeviceParameterPreviewAsync(id: RequestId, params: unknown): Promise<JsonObject> {
    if (!this.validateDeviceParameterPreview(params)) return error(id, -32602, "deviceRef, parameterRef, and finite value are required");
    try {
      const status = this.requireConnected("device.parameter.write");
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

  private async liveDeviceParameterApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validDeviceParameterApply(params)) return error(id, -32602, "transactionId, confirmation token, and idempotencyKey are required");
    const transaction = this.deviceParameterTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired device-parameter transaction");
    if (params.confirmation !== transaction.confirmation) return this.transactionError(id, "Device-parameter confirmation token is invalid");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", value: transaction.proposedValue, revision: transaction.appliedRevision, idempotent: true });
    if (transaction.state === "uncertain") return this.transactionError(id, "Device-parameter state is uncertain; perform fresh discovery before retrying");
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Device-parameter preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("device.parameter.write");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const target = this.parameterTarget(await adapter.snapshotAsync(context), transaction.deviceRef, transaction.parameterRef);
      const currentRevision = this.parameterRevision(target.parameter);
      if (currentRevision !== transaction.priorRevision || target.parameter.value !== transaction.priorValue) return this.transactionError(id, "Device parameter changed since preview");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      await adapter.invokeAsync({ operation: "device.parameter.set", args: { ref: transaction.parameterRef, value: transaction.proposedValue, expectedRevision: currentRevision } }, context);
      const verifiedSnapshot = await adapter.snapshotAsync(context);
      const verified = this.parameterTarget(verifiedSnapshot, transaction.deviceRef, transaction.parameterRef).parameter;
      if (verified.value !== transaction.proposedValue || this.parameterRevision(verified) <= currentRevision) { transaction.state = "uncertain"; throw new Error("Live did not confirm the requested device parameter"); }
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

  private async liveArrangementApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.arrangementTransactions.get(params.transactionId as string);
    if (!transaction) return this.transactionError(id, "Unknown or expired Arrangement transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", locators: transaction.created, idempotent: true });
    if (transaction.state === "applied") return this.transactionError(id, "Arrangement idempotency key conflicts with the applied transaction");
    if (transaction.state === "uncertain") return this.transactionError(id, "Arrangement apply is uncertain; read authoritative locators before retrying");
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Arrangement preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("arrangement.write");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const current = (await adapter.snapshotAsync(context)).arrangement.locators;
      const revision = `${status.epoch}:${current.map((locator) => `${locator.ref}:${locator.name}:${locator.position}`).join("|")}`;
      if (revision !== transaction.revision) return this.transactionError(id, "Arrangement locators changed since preview");
      const created: Array<{ ref: LiveRef; name: string; position: number }> = [];
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      try {
        created.push(await adapter.invokeAsync({ operation: "locator.add", args: { name: transaction.startName, position: transaction.start } }, context) as { ref: LiveRef; name: string; position: number });
        created.push(await adapter.invokeAsync({ operation: "locator.add", args: { name: transaction.endName, position: transaction.end } }, context) as { ref: LiveRef; name: string; position: number });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        for (const locator of created) { try { await adapter.invokeAsync({ operation: "locator.delete", args: { ref: locator.ref } }, { deadlineMs: Date.now() + 5_000 }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Arrangement apply compensation failed; read locators before retrying"); } }
        transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain";
        if (transaction.state === "previewed") delete transaction.applyKey;
        throw cause;
      }
      const authoritative = (await adapter.snapshotAsync(context)).arrangement.locators;
      if (!created.every((locator) => authoritative.some((item) => item.ref === locator.ref && item.name === locator.name && item.position === locator.position))) { transaction.state = "uncertain"; transaction.created = created; throw new Error("Live did not confirm Arrangement locators; read authoritative state before retrying"); }
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
    if (typeof snapshot.set.tempo !== "number" || !Number.isFinite(snapshot.set.tempo)) return this.adapterToolError(id, new Error("authoritative tempo is unavailable"), "Tempo preview requires fresh authoritative tempo evidence.");
    const transactionId = this.newTransactionId();
    const transaction: TempoTransaction = { id: transactionId, setRef: snapshot.set.ref, priorTempo: snapshot.set.tempo, proposedTempo: params.tempo, epoch: status.epoch as number, expiresAt: Date.now() + TRANSACTION_TTL_MS, state: "previewed" };
    this.transactions.set(transactionId, transaction); this.evictTransactions();
    return this.successText(id, { transactionId, epoch: transaction.epoch, target: transaction.setRef, priorTempo: transaction.priorTempo, proposedTempo: transaction.proposedTempo, impact: "audible-transport", confirmation: "apply", expiresAt: transaction.expiresAt });
  }

  private async liveTempoApplyAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "apply")) return error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required");
    const transaction = this.transactions.get(params.transactionId as string); if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "applied" && transaction.applyKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: transaction.appliedTempo, idempotent: true });
    if (transaction.state === "uncertain") return this.transactionError(id, "Tempo state is uncertain; perform fresh discovery before retrying");
    if (transaction.state !== "previewed") return this.transactionError(id, "Transaction is no longer applicable");
    if ((transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Tempo preview expired; preview again");
    try {
      const status = this.requireConnected("transport"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
      const current = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!current || current.tempo !== transaction.priorTempo) return this.transactionError(id, "Tempo changed since preview; preview again");
      transaction.state = "applying"; transaction.applyKey = params.idempotencyKey as string;
      await adapter.invokeAsync({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.proposedTempo, expectedTempo: transaction.priorTempo } }, context);
      const applied = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!applied || applied.tempo !== transaction.proposedTempo) throw new Error("Live did not confirm the requested tempo");
      transaction.appliedTempo = applied.tempo; transaction.state = "applied";
      return this.successText(id, { transactionId: transaction.id, state: "applied", tempo: applied.tempo, epoch: transaction.epoch, idempotent: false });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (transaction.state === "applying") { transaction.state = /cancelled before dispatch/.test(message) ? "previewed" : "uncertain"; if (transaction.state === "previewed") delete transaction.applyKey; }
      return this.adapterToolError(id, cause, "Tempo apply may be uncertain; perform fresh authoritative discovery and do not retry blindly.");
    }
  }

  private async liveUndoAsync(id: RequestId, params: unknown, signal?: AbortSignal): Promise<JsonObject> {
    if (!this.validTransactionParams(params, "undo")) return error(id, -32602, "transactionId, confirmation=undo, and idempotencyKey are required");
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
      if (capture.state !== "applied") return this.transactionError(id, "Only an applied capture transaction can be undone");
      try {
        const status = this.requireConnected("session.read"); if (status.epoch !== capture.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; const snapshot = await adapter.snapshotAsync(context);
        capture.state = "undoing"; capture.undoKey = params.idempotencyKey as string;
        if (capture.kind === "capture-midi") {
          const clips = Array.isArray(capture.created?.clips) ? capture.created.clips.filter(isObject) : [];
          const current = new Map(snapshot.tracks.flatMap((track) => track.clips.map((clip) => [clip.ref, clip] as const)));
          for (const owned of clips) {
            const clip = typeof owned.ref === "string" ? current.get(owned.ref as LiveRef) : undefined;
            if (!clip || !isNonEmptyString(owned.objectIdentity, 256) || owned.fingerprint !== this.captureObjectFingerprint(clip)) throw new Error("captured MIDI clip identity or content changed before undo");
          }
          for (const owned of clips) await adapter.invokeAsync({ operation: "clip.delete", args: { ref: owned.ref, expectedObjectIdentity: owned.objectIdentity } }, context);
          const after = await adapter.snapshotAsync(context); const remaining = new Set(after.tracks.flatMap((track) => track.clips.map((clip) => clip.ref)));
          if (clips.some((owned) => typeof owned.ref === "string" && remaining.has(owned.ref as LiveRef))) throw new Error("captured MIDI clip deletion was not confirmed");
        } else {
          const sceneRef = capture.created?.sceneRef; const scene = typeof sceneRef === "string" ? snapshot.scenes.find((row) => row.ref === sceneRef) : undefined;
          if (!scene || !isNonEmptyString(capture.created?.objectIdentity, 256) || capture.created?.fingerprint !== this.captureObjectFingerprint(scene)) throw new Error("captured scene identity or content changed before undo");
          await adapter.invokeAsync({ operation: "scene.delete", args: { ref: sceneRef, expectedStructureRevision: this.structureRevision(snapshot), expectedObjectIdentity: capture.created.objectIdentity } }, context);
          if ((await adapter.snapshotAsync(context)).scenes.some((scene) => scene.ref === sceneRef)) throw new Error("captured scene deletion was not confirmed");
        }
        capture.state = "undone";
        return this.successText(id, { transactionId: capture.id, state: "undone", idempotent: false });
      } catch (cause) { capture.state = "uncertain"; return this.adapterToolError(id, cause, "Capture undo is uncertain; perform fresh Session discovery."); }
    }
    if (!transaction && String(params.transactionId).startsWith("rename_")) {
      const rename = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!rename || rename.kind !== "rename" || !rename.clipRef) return this.transactionError(id, "Unknown or expired rename transaction");
      if (rename.state === "undone" && rename.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: rename.id, state: "undone", idempotent: true });
      if (rename.state !== "applied") return this.transactionError(id, "Only an applied rename transaction can be undone");
      try {
        const status = this.requireConnected("session.read"); if (status.epoch !== rename.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
        const current = await adapter.getAsync(rename.clipRef, context) as { name?: unknown } | undefined;
        if (!current || current.name !== rename.payload.name) return this.transactionError(id, "Renamed object changed after apply; undo refused");
        const operation = `${rename.payload.kind}.rename` as LiveInvocation["operation"];
        rename.state = "undoing"; rename.undoKey = params.idempotencyKey as string;
        await adapter.invokeAsync({ operation, args: { ref: rename.clipRef, name: rename.prior?.name, expectedName: rename.payload.name } }, context);
        const restored = await adapter.getAsync(rename.clipRef, context) as { name?: unknown } | undefined;
        if (!restored || restored.name !== rename.prior?.name) throw new Error("rename undo was not confirmed");
        rename.state = "undone";
        return this.successText(id, { transactionId: rename.id, state: "undone", ref: rename.clipRef, name: restored.name, idempotent: false });
      } catch (cause) { if (rename.state === "undoing") rename.state = "uncertain"; return this.adapterToolError(id, cause, "Rename undo is uncertain; rediscover the target."); }
    }
    if (!transaction && String(params.transactionId).startsWith("mixer_")) {
      const mixer = this.clipLifecycleTransactions.get(params.transactionId as string);
      if (!mixer || mixer.kind !== "mixer-set") return this.transactionError(id, "Unknown or expired mixer transaction");
      if (mixer.state === "undone" && mixer.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: mixer.id, state: "undone", idempotent: true });
      if (mixer.state !== "applied") return this.transactionError(id, "Only an applied mixer transaction can be undone");
      try {
        const status = this.requireConnected("session.read");
        if (status.epoch !== mixer.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
        const restore: Record<string, unknown> = { ref: mixer.clipRef };
        for (const field of Object.keys(mixer.payload)) if (field !== "ref") restore[field] = mixer.prior?.[field] ?? null;
        const result = await adapter.invokeAsync({ operation: "mixer.set", args: restore }, context) as { changed?: unknown };
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
        const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
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
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; const current = await adapter.snapshotAsync(context);
      if (!structure.created.every((item) => item.kind === "track" ? current.tracks.some((track) => track.ref === item.ref && track.name === item.name) : current.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) return this.transactionError(id, "Session structure changed after apply; undo refused");
      try { structure.state = "undoing"; for (const item of [...structure.created].reverse()) { const expectedStructureRevision = this.structureRevision(await adapter.snapshotAsync(context)); await adapter.invokeAsync({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision } }, context); } }
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
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string };
        const current = (await adapter.snapshotAsync(context)).arrangement.locators;
        if (!arrangement.created.every((locator) => current.some((item) => item.ref === locator.ref && item.name === locator.name && item.position === locator.position))) return this.transactionError(id, "Arrangement locators changed after apply; undo refused");
        try { arrangement.state = "undoing"; for (const locator of arrangement.created) await adapter.invokeAsync({ operation: "locator.delete", args: { ref: locator.ref } }, context); }
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
        const status = this.requireConnected("device.parameter.write"); if (status.epoch !== parameter.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; const current = this.parameterTarget(await adapter.snapshotAsync(context), parameter.deviceRef, parameter.parameterRef).parameter;
        if (current.value !== parameter.proposedValue || this.parameterRevision(current) !== parameter.appliedRevision) return this.transactionError(id, "Device parameter changed after apply; undo refused");
        parameter.state = "undoing"; parameter.undoKey = params.idempotencyKey as string;
        await adapter.invokeAsync({ operation: "device.parameter.set", args: { ref: parameter.parameterRef, value: parameter.priorValue, expectedRevision: parameter.appliedRevision } }, context);
        const restored = this.parameterTarget(await adapter.snapshotAsync(context), parameter.deviceRef, parameter.parameterRef).parameter;
        if (restored.value !== parameter.priorValue || this.parameterRevision(restored) <= parameter.appliedRevision) { parameter.state = "uncertain"; throw new Error("Live did not confirm device-parameter restoration"); }
        parameter.undoKey = params.idempotencyKey as string; parameter.state = "undone";
        return this.successText(id, { transactionId: parameter.id, state: "undone", value: restored.value, revision: this.parameterRevision(restored), idempotent: false });
      } catch (cause) { if (parameter.state === "undoing") parameter.state = "uncertain"; return this.adapterToolError(id, cause, "Device-parameter undo is uncertain; inspect authoritative parameter state."); }
    }
    if (!transaction) return this.transactionError(id, "Unknown or expired transaction");
    if (transaction.state === "undone" && transaction.undoKey === params.idempotencyKey) return this.successText(id, { transactionId: transaction.id, state: "undone", tempo: transaction.priorTempo, idempotent: true });
    if (transaction.state !== "applied") return this.transactionError(id, "Only an applied tempo transaction can be undone");
    try {
      const status = this.requireConnected("transport"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
      const adapter = this.asyncAdapter(); const context = { signal, deadlineMs: Date.now() + AUDITION_DEADLINE_MS, idempotencyKey: params.idempotencyKey as string, transactionId: params.transactionId as string }; const current = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!current || current.tempo !== transaction.appliedTempo) return this.transactionError(id, "Tempo changed after apply; undo refused");
      transaction.state = "undoing"; transaction.undoKey = params.idempotencyKey as string;
      await adapter.invokeAsync({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.priorTempo, expectedTempo: transaction.appliedTempo } }, context);
      const restored = await adapter.getAsync(transaction.setRef, context) as LiveSnapshot["set"] | undefined;
      if (!restored || restored.tempo !== transaction.priorTempo) throw new Error("Live did not confirm tempo restoration");
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
    const argumentTools = new Set(["plan_user_journey", "audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop", "live_discover", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi_preview", "live_capture_midi_apply", "live_scene_capture_preview", "live_scene_capture_apply", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_backup_preview", "live_project_backup_apply", "live_project_save", "live_project_open", "live_device_parameter_preview", "live_device_parameter_apply", "live_session_structure_preview", "live_session_structure_apply", "live_object_rename_preview", "live_object_rename_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo"]);
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
    if (["audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "live_audio_capture_preview", "live_audio_capture_apply", "live_audio_capture_status", "live_audio_capture_emergency_stop", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi_preview", "live_capture_midi_apply", "live_scene_capture_preview", "live_scene_capture_apply", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_backup_preview", "live_project_backup_apply"].includes(params.name)) return error(id, -32001, "This operation requires the asynchronous host request path");
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
      ...(live.capabilities.includes("session.read") ? ["audio.diagnose.live-context"] : []),
      ...(live.capabilities.includes("audio.capture.resampling") ? ["live.audio.capture.preview", "live.audio.capture.apply", "live.audio.capture.status", "live.audio.capture.emergency-stop", "live.audio.analysis"] : []),
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
      ...(live.capabilities.includes("session.read") ? [] : ["audio.diagnose.live-context"]),
      ...(live.capabilities.includes("audio.capture.resampling") ? [] : ["live.audio.capture.preview", "live.audio.capture.apply", "live.audio.capture.status", "live.audio.capture.emergency-stop", "live.audio.analysis"]),
    ] : [...unavailableCapabilities, "audio.diagnose.live-context", "live.audio.capture.preview", "live.audio.capture.apply", "live.audio.capture.status", "live.audio.capture.emergency-stop", ...LIVE_CAPABILITIES];
    return {
      implemented: ["server.status", "capabilities", "journeys.plan", "audio.analyze", "audio.analysis.standards", "audio.reference.compare", ...liveImplemented],
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
      const status = this.requireConnected("device.parameter.write");
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
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Device-parameter preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("device.parameter.write"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const target = this.parameterTarget(this.adapter.snapshot(), transaction.deviceRef, transaction.parameterRef);
      if (this.parameterRevision(target.parameter) !== transaction.priorRevision || target.parameter.value !== transaction.priorValue) return this.transactionError(id, "Device parameter changed since preview");
      this.adapter.invoke({ operation: "device.parameter.set", args: { ref: transaction.parameterRef, value: transaction.proposedValue, expectedRevision: transaction.priorRevision } });
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
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Session-structure preview expired or is no longer applicable");
    try {
      const status = this.requireConnected("session.structure"); if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.snapshot(); if (this.structureRevision(current) !== transaction.revision) return this.transactionError(id, "Session structure changed since preview");
      const created: NonNullable<SessionStructureTransaction["created"]> = [];
      try {
        for (const item of transaction.proposed) {
          const operation = item.kind === "track" ? "track.create" : "scene.create";
          const expectedStructureRevision = this.structureRevision(this.adapter.snapshot());
          const result = this.adapter.invoke({ operation, args: { name: item.name, ...(item.kind === "track" ? { kind: item.trackKind } : {}), index: item.index, expectedStructureRevision } }) as { ref?: LiveRef; name?: string; index?: number };
          if (!result?.ref || result.name !== item.name) throw new Error(`Live did not confirm created ${item.kind}`);
          created.push({ ref: result.ref, kind: item.kind, name: result.name, index: result.index ?? item.index });
        }
        const verified = this.adapter.snapshot(); if (!created.every((item) => item.kind === "track" ? verified.tracks.some((track) => track.ref === item.ref && track.name === item.name) : verified.scenes.some((scene) => scene.ref === item.ref && scene.name === item.name))) throw new Error("Live did not confirm Session structure");
      } catch (cause) { for (const item of [...created].reverse()) { try { const expectedStructureRevision = this.structureRevision(this.adapter.snapshot()); this.adapter.invoke({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision } }); } catch { transaction.state = "uncertain"; transaction.created = created; throw new Error("Session-structure apply compensation failed; read authoritative structure before retrying"); } } throw cause; }
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
    if (transaction.state !== "previewed" || (transaction.state === "previewed" && transaction.expiresAt <= Date.now())) return this.transactionError(id, "Arrangement preview expired or is no longer applicable");
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
      if ((transaction.state === "previewed" && transaction.expiresAt <= Date.now())) { this.transactions.delete(transaction.id); return this.transactionError(id, "Tempo preview expired; preview again"); }
      const status = this.requireConnected("transport");
      if (status.epoch !== transaction.epoch) return this.transactionError(id, "Live connection epoch changed; preview again");
      const current = this.adapter.get(transaction.setRef) as LiveSnapshot["set"] | undefined;
      if (!current || current.tempo !== transaction.priorTempo) return this.transactionError(id, "Tempo changed since preview; preview again");
      this.adapter.invoke({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.proposedTempo, expectedTempo: transaction.priorTempo } });
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
        const status = this.requireConnected("device.parameter.write"); if (status.epoch !== parameter.epoch) return this.transactionError(id, "Live connection epoch changed; undo refused");
        const current = this.parameterTarget(this.adapter.snapshot(), parameter.deviceRef, parameter.parameterRef).parameter;
        if (current.value !== parameter.proposedValue || this.parameterRevision(current) !== parameter.appliedRevision) return this.transactionError(id, "Device parameter changed after apply; undo refused");
        this.adapter.invoke({ operation: "device.parameter.set", args: { ref: parameter.parameterRef, value: parameter.priorValue, expectedRevision: parameter.appliedRevision } });
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
        for (const item of [...structure.created].reverse()) { const expectedStructureRevision = this.structureRevision(this.adapter.snapshot()); this.adapter.invoke({ operation: item.kind === "track" ? "track.delete" : "scene.delete", args: { ref: item.ref, expectedStructureRevision } }); }
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
      this.adapter.invoke({ operation: "tempo.set", args: { ref: transaction.setRef, value: transaction.priorTempo, expectedTempo: transaction.appliedTempo } });
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
