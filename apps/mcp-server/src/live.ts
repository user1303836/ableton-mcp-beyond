import { createHash } from "node:crypto";
import { liveRegistryHash, liveRegistryOperations } from "./registry.js";

/**
 * Live-domain contract and deterministic simulator.
 *
 * The simulator is deliberately an adapter test double: it models stable
 * references and state transitions without claiming that Ableton Live is
 * installed or connected. A Remote Script/Extension can implement the same
 * contract at the protocol boundary.
 */

export const LIVE_PROTOCOL_VERSION = "ableton-live/v1";
// SHA-256 of canonical sorted-key JSON, so negotiation is invariant to the
// checkout's LF/CRLF policy on macOS and Windows.
export const LIVE_REGISTRY_HASH = liveRegistryHash();
export const LIVE_REGISTRY_OPERATIONS = liveRegistryOperations();

export const LIVE_CAPABILITIES = [
  "session.read", "tracks", "scenes", "clips", "notes",
  "session.discovery", "session.structure", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.read", "session.midi_note.write",
  "arrangement.read", "arrangement.write", "audio", "audio.capture.resampling", "warp", "takes",
  "automation", "devices", "racks", "chains", "parameters", "browser",
  "device.parameter.write",
  "routing", "recording", "projects", "mixing", "transport", "max", "osc", "view", "tuning", "groove",
  "realtime.events", "plugins", "subscriptions", "reconnect",
] as const;

export const LIVE_UNAVAILABLE_CAPABILITIES = [
  "arrangement.read", "arrangement.write", "audio", "audio.capture.resampling", "warp", "takes",
  "automation", "devices", "racks", "chains", "parameters", "browser",
  "routing", "recording", "projects", "mixing", "max", "osc", "realtime.events",
  "plugins",
] as const;

export const SIMULATOR_CAPABILITIES = [
  "session.read", "tracks", "scenes", "clips", "notes", "session.discovery", "session.structure", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.read", "session.midi_note.write", "arrangement.read", "arrangement.write", "transport", "devices", "parameters", "device.parameter.write", "subscriptions", "reconnect", "view", "warp", "takes", "tuning", "groove",
] as const satisfies readonly LiveCapability[];

export type LiveCapability = typeof LIVE_CAPABILITIES[number];
export type LiveObjectKind = "set" | "track" | "scene" | "clip" | "clip-slot" | "session-playback" | "arrangement-clip" | "take-lane" | "take-lane-clip" | "groove" | "device" | "parameter" | "note" | "automation" | "locator" | "chain" | "drum_pad";
export type LiveWireObjectKind = LiveObjectKind | "clip_slot" | "arrangement_clip" | "take_lane" | "take_lane_clip" | "groove" | "routing_choice" | "return_track" | "main_track" | "browser_item";
/** Opaque references are simulator-local (`kind:key`) or production mapper
 * references (`epoch:wire_kind:key`). Callers must never parse authority from
 * either form; the adapter performs epoch and object-identity checks. */
export type LiveRef = `${LiveObjectKind}:${string}` | `${number}:${LiveWireObjectKind}:${string}`;
export type LiveMonitoringState = "in" | "auto" | "off" | null;
export type LiveDiscoveryKind = "set" | "track" | "return-track" | "main-track" | "scene" | "clip-slot" | "session-clip" | "arrangement-clip" | "note" | "locator" | "device" | "parameter" | "selection" | "routing-choice" | "session-playback";

export interface LiveOperationContext { signal?: AbortSignal; deadlineMs: number; /** Stable host transaction authority; the remote adapter derives per-operation replay keys from it. */ idempotencyKey?: string; transactionId?: string; }
export interface LiveDiscoveryRequest { kind: LiveDiscoveryKind; parent?: string; filter?: Record<string, unknown>; fields?: string[]; budget?: number; limit?: number; cursor?: string; }
export interface LiveDiscoveryResult { epoch: number; items: Array<Record<string, unknown>>; truncated: boolean; revision: string; kind: LiveDiscoveryKind; nextCursor?: string; }
export interface SessionPlaybackTarget { trackRef: LiveRef; clipSlotRef: LiveRef; sceneRef: LiveRef; sceneIndex: number; clipRef: LiveRef | null; }
export interface SessionPlaybackState {
  ref: LiveRef;
  epoch: number;
  revision: string;
  transport: {
    playing: boolean | null;
    arrangementRecord: boolean | null;
    sessionRecord: boolean | null;
    position: number | null;
    launchQuantization: { raw: string | number | null; normalized: string | null };
    loop: { enabled: boolean | null; start: number | null; length: number | null };
    punchIn: boolean | null;
    punchOut: boolean | null;
    metronome: boolean | null;
    countIn: number | null;
  };
  firedTargets: SessionPlaybackTarget[];
  playingTargets: SessionPlaybackTarget[];
}

export interface LiveStatus {
  connected: boolean;
  adapter: "simulator" | "remote-script" | "extension" | "unavailable";
  epoch: number | null;
  protocol: string;
  capabilities: readonly LiveCapability[];
  reason?: string;
  registryHash?: string;
  operations?: readonly string[];
  provenance?: "real-live" | "fake-live" | "simulator" | "unknown";
}

export interface Note { pitch: number; start: number; duration: number; velocity: number; channel: number; id?: number | null; mute?: boolean | null; probability?: number | null; velocityDeviation?: number | null; releaseVelocity?: number | null; }
export interface AutomationPoint { time: number; value: number; curve?: number; }
export interface Parameter { ref: LiveRef; objectIdentity?: string; name: string; value: number; min: number; max: number; automatable: boolean; quantization?: number; enabled?: boolean; displayValue?: string; revision?: number; }
export interface DeviceChain { ref: LiveRef; parentRef: LiveRef; objectIdentity?: string; index: number; name: string; mute: boolean | null; solo: boolean | null; devices: Device[]; mixer?: { volume: number | null; pan: number | null; sends: (number | null)[]; volumeRef?: LiveRef | null; panningRef?: LiveRef | null; sendRefs?: LiveRef[]; chainActivatorRef?: LiveRef | null; mixerIdentity?: string }; }
export interface DrumPad { ref: LiveRef; parentRef: LiveRef; index: number; name: string; mute: boolean | null; chains: DeviceChain[]; }
export interface Device { ref: LiveRef; parentRef?: LiveRef; name: string; kind: "instrument" | "audio-effect" | "midi-effect" | "plugin" | "rack" | "device"; parameters: Parameter[]; objectIdentity?: string; enabled?: boolean; className?: string; canHaveChains?: boolean | null; canHaveDrumPads?: boolean | null; chains?: DeviceChain[]; drumPads?: DrumPad[]; macros?: { ref: LiveRef; objectIdentity?: string; name: string; value: unknown }[]; variationCount?: number; chainSelector?: unknown; view?: { isCollapsed?: boolean | null }; latencySamples?: number | null; latencyMs?: number | null; }
export interface Clip { ref: LiveRef; objectIdentity?: string; name: string; kind: "midi" | "audio"; start: number; length: number; notes: Note[]; notesRevision?: string; warp: boolean; takes: string[]; automation: AutomationPoint[]; envelopes?: Record<string, AutomationPoint[]>; isAudio?: boolean | null; gain?: number | null; pitchCoarse?: number | null; pitchFine?: number | null; warpMode?: number | null; warping?: boolean | null; fadeInLength?: number | null; fadeOutLength?: number | null; availableAudioFields?: string[]; loopStart?: number | null; loopEnd?: number | null; filePath?: string | null; muted?: boolean | null; colorIndex?: number | null; looping?: boolean | null; isTakeLaneClip?: boolean | null; groove?: { ref: LiveRef; name: string } | null; hasGroove?: boolean | null; launchMode?: number | null; legato?: boolean | null; playingPosition?: number | null; isPlaying?: boolean | null; isTriggered?: boolean | null; isRecording?: boolean | null; ramMode?: boolean | null; signatureNumerator?: number | null; signatureDenominator?: number | null; velocityAmount?: number | null; willRecordOnStart?: boolean | null; fireButtonState?: boolean | null; endTime?: number | null; availableWarpModes?: number[] | null; sampleLength?: number | null; warpMarkers?: Array<{ beatTime: number; sampleTime: number }> | null; clipView?: { gridQuantization?: number | null; tripletGrid?: boolean | null; showEnvelope?: boolean | null }; }
export interface RoutingState { inputType: string | null; inputSubRouting: string | null; outputType: string | null; outputSubRouting: string | null; availableInputTypes: number; availableInputChannels: number; availableOutputTypes: number; availableOutputChannels: number; }
export interface MixerState { volume: number | null; pan: number | null; cueVolume: number | null; mute: boolean | null; solo: boolean | null; sends: (number | null)[]; volumeRef: LiveRef | null; volumeIdentity?: string | null; panRef: LiveRef | null; panIdentity?: string | null; cueRef: LiveRef | null; cueIdentity?: string | null; sendRefs: LiveRef[]; sendIdentities?: string[]; mixerIdentity?: string; trackActivator?: boolean; crossfader?: number; panningLeft?: number; panningRight?: number; trackActivatorRef?: LiveRef | null; crossfaderRef?: LiveRef | null; crossfadeAssign?: number | null; panningMode?: number | null; panningLeftRef?: LiveRef | null; panningRightRef?: LiveRef | null; songTempoRef?: LiveRef | null; }
export interface ClipSlot { ref: LiveRef; parentRef: LiveRef; objectIdentity?: string; sceneIndex: number; clipRef?: LiveRef | null; empty: boolean; colorIndex?: number | null; controlsOtherClips?: boolean | null; hasStopButton?: boolean | null; isGroupSlot?: boolean | null; playingStatus?: number | null; willRecordOnStart?: boolean | null; fireButtonState?: boolean | null; }
export interface Track { ref: LiveRef; objectIdentity?: string; name: string; kind: "audio" | "midi" | "group" | "return" | "main" | "master" | "regular"; volume: number; pan: number; mute: boolean; solo: boolean; armed: boolean | null; monitoringState?: LiveMonitoringState; playingSlotIndex?: number | null; firedSlotIndex?: number | null; clips: Clip[]; clipSlots?: ClipSlot[]; mixer?: MixerState; routing?: RoutingState; devices: Device[]; sends: number[]; input?: string; output?: string; takeLanes?: TakeLane[]; groupTrackRef?: LiveRef | null; isVisible?: boolean | null; isSelected?: boolean | null; isFrozen?: boolean | null; foldState?: boolean | null; implicitArm?: boolean | null; backToArranger?: boolean | null; mutedViaSolo?: boolean | null; inputMeterLeft?: number | null; inputMeterRight?: number | null; inputMeterLevel?: number | null; outputMeterLeft?: number | null; outputMeterRight?: number | null; outputMeterLevel?: number | null; performanceImpact?: number | null; view?: { selectedDeviceRef?: LiveRef | null; deviceInsertMode?: number | null; isCollapsed?: boolean | null }; }
export interface TakeLane { ref: LiveRef; objectIdentity?: string; parentRef?: LiveRef; trackRef?: LiveRef; name: string; index: number; clips: Clip[]; }
export interface Scene { ref: LiveRef; objectIdentity?: string; name: string; index: number; colorIndex?: number | null; isEmpty?: boolean | null; isTriggered?: boolean | null; tempo?: number | null; tempoEnabled?: boolean | null; signatureNumerator?: number | null; signatureDenominator?: number | null; timeSignatureEnabled?: boolean | null; fireButtonState?: boolean | null; triggerable?: boolean; }
export interface LiveSnapshot {
  set: { ref: LiveRef; objectIdentity?: string; name: string; tempo?: number; playing?: boolean; position?: number; loop?: { enabled: boolean; start?: number; length?: number }; [key: string]: unknown };
  tracks: Track[];
  scenes: Scene[];
  arrangement: { length: number; locatorRevision?: string; locators: { ref: LiveRef; objectIdentity?: string; name: string; position: number }[]; clips?: Array<Record<string, unknown>> };
  arrangementClips?: Array<{ clip: Clip; trackRef: LiveRef }>;
  browser?: { ref: LiveRef; name: string; kind: "device" | "sample" | "preset" }[];
  playback: SessionPlaybackState;
  selected?: LiveRef;
  view?: { visibleView: string | null; follow: boolean | null; drawMode?: boolean | null };
  selection?: { trackRef?: LiveRef | null; sceneRef?: LiveRef | null; slotRef?: LiveRef | null; detailClipRef?: LiveRef | null; deviceRef?: LiveRef | null; parameterRef?: LiveRef | null; chainRef?: LiveRef | null };
  song?: LiveSongState;
  tuning?: { system: { name: string; lowestNote: number | null; highestNote: number | null; referencePitch: number | null; pseudoOctaveInCents: number | null; noteTunings: Array<{ note: number; deviation: number }> }; scale: { rootNote: number | null; scaleName: string | null; scaleMode: string | null; scaleIntervals: number[] } };
  groovePool?: { amount: number | null; grooves: Array<{ ref: LiveRef; objectIdentity?: string; name: string; base: number | null; quantizationAmount: number | null; randomAmount: number | null; timingAmount: number | null; velocityAmount: number | null }> };
}
export interface LiveSongState { visibleTracks: LiveRef[]; appointedDevice: LiveRef | null; songLength: number | null; startTime: number | null; signatureNumerator: number | null; signatureDenominator: number | null; swingAmount: number | null; overdub: boolean | null; arrangementOverdub: boolean | null; backToArranger: boolean | null; canCaptureMidi: boolean | null; canUndo: boolean | null; canRedo: boolean | null; exclusiveArm: boolean | null; exclusiveSolo: boolean | null; isCountingIn: boolean | null; tempoFollowerEnabled: boolean | null; reEnableAutomationEnabled: boolean | null; sessionRecord: boolean | null; sessionAutomationRecord: boolean | null; clipTriggerQuantization: string | null; isAbletonLinkEnabled: boolean | null; isAbletonLinkStartStopSyncEnabled: boolean | null; tempoFollower: boolean | null; }
export interface LiveEvent { epoch: number; sequence: number; type: "state" | "transport" | "object" | "meter" | "max" | "osc" | "reset"; ref?: LiveRef; payload: unknown; }

export type LiveOperation =
  | "arrangement.clip.create" | "arrangement.clip.delete" | "arrangement.clip.move" | "arrangement.audio-clip.create" | "arrangement.automation.read" | "arrangement.automation.create" | "arrangement.automation.delete" | "arrangement.automation.point.insert" | "arrangement.automation.point.delete"
  | "audio.capture.cleanup" | "audio.capture.emergency-stop" | "audio.capture.inspect" | "audio.capture.start" | "audio.capture.status" | "audio.capture.stop" | "audio.clip.set" | "audio.warp-marker.read" | "audio.warp-marker.add" | "audio.warp-marker.move" | "audio.warp-marker.delete" | "audio.take-lane.read" | "audio.comp.read"
  | "automation.envelope.clear" | "automation.envelope.create" | "automation.envelope.delete" | "automation.envelope.read" | "automation.point.delete" | "automation.point.insert"
  | "browser.inspect" | "browser.load" | "browser.search" | "browser.preview.start" | "browser.preview.stop" | "clip.action" | "clip.create" | "clip.delete" | "clip.duplicate" | "clip.move" | "clip.rename" | "clip.set"
  | "application.dialog" | "clip.view.set" | "device.delete" | "device.enable" | "device.insert" | "device.move" | "device.parameter.set" | "device.rename" | "device.view.set" | "selection.set" | "song.view.set"
  | "chain-mixer.set" | "compressor.sidechain.set" | "device-io.set" | "locator.add" | "locator.delete" | "locator.jump" | "locator.jump-to" | "locator.rename" | "mixer.extended.set" | "mixer.set" | "note.add" | "note.add-batch" | "note.delete" | "note.duplicate" | "note.quantize" | "note.read-by-id" | "note.read-selected" | "note.update"
  | "project.bounce" | "project.collect" | "project.export" | "project.new" | "project.open" | "project.save" | "project.save-as"
  | "performance.read" | "realtime.arm" | "realtime.disarm" | "realtime.stats" | "recording.arrangement" | "recording.session" | "routing.set"
  | "scene.capture" | "scene.create" | "scene.delete" | "scene.fire-selected" | "scene.rename" | "scene.set" | "session.audio-clip.create" | "session.audition-launch" | "session.audition-stop" | "session.capture-midi" | "session.clip-launch" | "session.clip-stop" | "session.discover" | "session.emergency-stop"
  | "song.read" | "song.time-convert" | "scene.duplicate" | "tempo.set" | "track.create" | "track.create-return" | "track.delete" | "track.delete-return" | "track.duplicate" | "track.rename" | "track.select-instrument" | "track.view.set" | "transport.action" | "transport.set" | "groove.edit" | "groove.read" | "groove.set" | "take-lane.create" | "take-lane.rename" | "take-lane.clip.create" | "take-lane.audio-clip.create" | "tuning.read" | "tuning.set" | "view.control" | "view.set" | "subscribe";

export interface LiveInvocation { operation: LiveOperation; args: Record<string, unknown>; }

export interface LiveAdapter {
  status(): LiveStatus;
  snapshot(): LiveSnapshot;
  get(ref: LiveRef): unknown;
  invoke(invocation: LiveInvocation): unknown;
  subscribe(listener: (event: LiveEvent) => void): () => void;
  reconnect(): LiveStatus;
}

/** Promise-based boundary used by process-backed adapters. Synchronous methods
 * remain available for deterministic in-process compatibility tests. */
export interface AsyncLiveAdapter extends LiveAdapter {
  snapshotAsync(context?: LiveOperationContext): Promise<LiveSnapshot>;
  discoverAsync(request: LiveDiscoveryRequest, context?: LiveOperationContext): Promise<LiveDiscoveryResult>;
  getAsync(ref: LiveRef, context?: LiveOperationContext): Promise<unknown>;
  invokeAsync(invocation: LiveInvocation, context?: LiveOperationContext): Promise<unknown>;
  reconnectAsync(context?: LiveOperationContext): Promise<LiveStatus>;
  close(): Promise<void>;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const ref = (kind: LiveObjectKind, id: string): LiveRef => `${kind}:${id}`;
const simulatorCanonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(simulatorCanonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${simulatorCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("unsupported simulator authority value");
};
const simulatorRevision = (value: unknown): string => createHash("sha256").update(simulatorCanonical(value)).digest("hex");

function createSimulatorState(): LiveSnapshot {
  const initialNotes: Note[] = [{ pitch: 36, start: 0, duration: 0.25, velocity: 110, channel: 1, id: 1, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 }];
  const kick: Clip = { ref: ref("clip", "clip-1"), objectIdentity: "simulator:clip:clip-1", name: "Kick Pattern", kind: "midi", start: 0, length: 4, notes: initialNotes, notesRevision: simulatorRevision(initialNotes), warp: false, takes: ["take-1"], automation: [], muted: false, colorIndex: 0, looping: true, loopStart: 0, loopEnd: 4, clipView: { gridQuantization: 1, tripletGrid: false, showEnvelope: false } };
  const track: Track = { ref: ref("track", "track-1"), objectIdentity: "simulator:track:track-1", name: "Drums", kind: "midi", volume: 0.85, pan: 0, mute: false, solo: false, armed: false, monitoringState: "off", playingSlotIndex: null, firedSlotIndex: null, clips: [kick], clipSlots: [{ ref: ref("clip-slot", "track-1:0"), parentRef: ref("track", "track-1"), objectIdentity: "simulator:clip-slot:track-1:0", sceneIndex: 0, clipRef: kick.ref, empty: false, colorIndex: 2, controlsOtherClips: false, hasStopButton: true, isGroupSlot: false, playingStatus: 0, willRecordOnStart: false, fireButtonState: false }], mixer: { volume: 0.85, pan: 0, cueVolume: 1, mute: false, solo: false, sends: [0.5, 0.25], volumeRef: ref("parameter", "mixer:0:volume"), volumeIdentity: "simulator:parameter:mixer:0:volume", panRef: ref("parameter", "mixer:0:panning"), panIdentity: "simulator:parameter:mixer:0:panning", cueRef: ref("parameter", "mixer:0:cue_volume"), cueIdentity: "simulator:parameter:mixer:0:cue_volume", sendRefs: [ref("parameter", "mixer:0:sends:0"), ref("parameter", "mixer:0:sends:1")], sendIdentities: ["simulator:parameter:mixer:0:sends:0", "simulator:parameter:mixer:0:sends:1"], mixerIdentity: "simulator:mixer:track-1", trackActivatorRef: ref("parameter", "mixer:0:activator"), crossfaderRef: ref("parameter", "mixer:0:crossfader"), crossfadeAssign: 1, panningMode: 0, panningLeftRef: ref("parameter", "mixer:0:panning_left"), panningRightRef: ref("parameter", "mixer:0:panning_right"), trackActivator: true, crossfader: 0, panningLeft: 0, panningRight: 0 }, routing: { inputType: "Ext. In", inputSubRouting: "1", outputType: "Main", outputSubRouting: "1/2", availableInputTypes: 2, availableInputChannels: 16, availableOutputTypes: 3, availableOutputChannels: 4 }, devices: [], sends: [0, 0], groupTrackRef: null, isVisible: true, isSelected: true, isFrozen: false, foldState: null, implicitArm: false, backToArranger: false, mutedViaSolo: false, inputMeterLeft: 0.5, inputMeterRight: 0.4, inputMeterLevel: 0.45, outputMeterLeft: 0.6, outputMeterRight: 0.55, outputMeterLevel: 0.58, performanceImpact: 1, view: { selectedDeviceRef: ref("device", "utility-1"), deviceInsertMode: 1, isCollapsed: false }, takeLanes: [{ ref: ref("take-lane", "track-1:0"), objectIdentity: "simulator:take-lane:track-1:0", parentRef: ref("track", "track-1"), trackRef: ref("track", "track-1"), name: "Take 1", index: 0, clips: [] }] };
  const gain: Parameter = { ref: ref("parameter", "gain-1"), objectIdentity: "simulator:parameter:gain-1", name: "Gain", value: 0.5, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, displayValue: "0.5", revision: 1 };
  const device: Device = { ref: ref("device", "utility-1"), parentRef: track.ref, name: "Utility", kind: "audio-effect", parameters: [gain], objectIdentity: "simulator:device:utility-1", enabled: true, view: { isCollapsed: false }, latencySamples: 256, latencyMs: 5.8 };
  track.devices.push(device);
  return {
    set: { ref: ref("set", "set-1"), objectIdentity: "simulator:set:set-1", name: "Simulator Set", tempo: 120, playing: false, position: 0, loop: { enabled: false, start: 0, length: 4 } },
    tracks: [track],
    scenes: [{ ref: ref("scene", "scene-1"), objectIdentity: "simulator:scene:scene-1", name: "Scene 1", index: 0, colorIndex: 1, isEmpty: false, isTriggered: false, tempo: 120, tempoEnabled: false, signatureNumerator: 4, signatureDenominator: 4, timeSignatureEnabled: false, fireButtonState: false, triggerable: true }],
    arrangement: { length: 16, locatorRevision: simulatorRevision([{ ref: ref("locator", "locator-1"), objectIdentity: "simulator:locator:locator-1", name: "Intro", position: 0 }]), locators: [{ ref: ref("locator", "locator-1"), objectIdentity: "simulator:locator:locator-1", name: "Intro", position: 0 }], clips: [] },
    arrangementClips: [],
    browser: [{ ref: ref("device", "utility-1"), name: "Utility", kind: "device" }, { ref: ref("clip", "sample-1"), name: "Kick Sample", kind: "sample" }],
    playback: { ref: ref("session-playback", "playback-1"), epoch: 1, revision: "1:stopped", transport: { playing: false, arrangementRecord: false, sessionRecord: false, position: 0, launchQuantization: { raw: "1-bar", normalized: "1-bar" }, loop: { enabled: false, start: 0, length: 4 }, punchIn: false, punchOut: false, metronome: false, countIn: 1 }, firedTargets: [], playingTargets: [] },
    selected: track.ref,
    view: { visibleView: "Session", follow: false, drawMode: false },
    selection: { trackRef: ref("track", "track-1"), sceneRef: ref("scene", "scene-1"), slotRef: ref("clip-slot", "track-1:0"), detailClipRef: ref("clip", "clip-1"), deviceRef: ref("device", "utility-1"), parameterRef: ref("parameter", "gain-1"), chainRef: null },
    song: { visibleTracks: [ref("track", "track-1")], appointedDevice: ref("device", "utility-1"), songLength: 64, startTime: 0, signatureNumerator: 4, signatureDenominator: 4, swingAmount: 0, overdub: false, arrangementOverdub: false, backToArranger: false, canCaptureMidi: true, canUndo: true, canRedo: false, exclusiveArm: true, exclusiveSolo: true, isCountingIn: false, tempoFollowerEnabled: false, reEnableAutomationEnabled: false, sessionRecord: false, sessionAutomationRecord: false, clipTriggerQuantization: "1_bar", isAbletonLinkEnabled: true, isAbletonLinkStartStopSyncEnabled: false, tempoFollower: false },
    tuning: { system: { name: "Equal", lowestNote: 0, highestNote: 127, referencePitch: 440, pseudoOctaveInCents: 1200, noteTunings: Array.from({ length: 128 }, (_, note) => ({ note, deviation: 0 })) }, scale: { rootNote: 0, scaleName: "Major", scaleMode: "Ionian", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] } },
    groovePool: { amount: 0, grooves: [{ ref: ref("groove", "groove-1"), objectIdentity: "simulator:groove:groove-1", name: "Swing 16", base: 3, quantizationAmount: 0.5, randomAmount: 0.1, timingAmount: 0.6, velocityAmount: 0.2 }] },
  };
}

export const SIMULATOR_OPERATIONS = ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "transport.set", "tempo.set", "session.audition-launch", "session.audition-stop", "session.emergency-stop", "session.clip-launch", "session.clip-stop", "clip.create", "clip.delete", "track.create", "track.delete", "track.rename", "track.create-return", "track.delete-return", "track.duplicate", "scene.duplicate", "track.view.set", "track.select-instrument", "scene.create", "scene.delete", "scene.rename", "scene.set", "scene.fire-selected", "clip.rename", "device.rename", "locator.rename", "scene.capture", "note.add", "note.add-batch", "note.update", "note.delete", "note.duplicate", "note.quantize", "note.read-by-id", "note.read-selected", "locator.add", "locator.delete", "locator.jump", "locator.jump-to", "song.read", "song.time-convert", "transport.action", "session.capture-midi", "device.parameter.set", "clip.duplicate", "clip.move", "clip.set", "clip.action", "arrangement.clip.create", "arrangement.clip.delete", "arrangement.clip.move", "arrangement.audio-clip.create", "session.audio-clip.create", "take-lane.create", "take-lane.rename", "take-lane.clip.create", "take-lane.audio-clip.create", "audio.take-lane.read", "tuning.read", "tuning.set", "groove.read", "groove.set", "groove.edit", "audio.clip.set", "audio.warp-marker.read", "audio.warp-marker.add", "audio.warp-marker.move", "audio.warp-marker.delete", "mixer.set", "mixer.extended.set", "chain-mixer.set", "device-io.set", "compressor.sidechain.set", "automation.envelope.read", "automation.envelope.create", "automation.envelope.delete", "automation.envelope.clear", "automation.point.insert", "automation.point.delete", "device.insert", "device.delete", "device.enable", "device.move", "selection.set", "song.view.set", "clip.view.set", "device.view.set", "application.dialog", "browser.search", "browser.inspect", "browser.load", "routing.set", "recording.session", "recording.arrangement", "performance.read", "view.set", "view.control"] as const;

export class DeterministicLiveSimulator implements LiveAdapter {
  private state = createSimulatorState();
  private sequence = 0;
  private epoch = 1;
  private listeners = new Set<(event: LiveEvent) => void>();

  private structureCreatedFingerprint(kind: "track" | "scene", reference: LiveRef): string {
    const snapshot = this.snapshot();
    if (kind === "track") { const track = snapshot.tracks.find((row) => row.ref === reference); if (!track) throw new Error("created track fingerprint is unavailable"); const ownedTrack = { ...track, clipSlots: (track.clipSlots ?? []).filter((slot) => slot.empty !== true || slot.clipRef != null) }; const arrangementClips = (snapshot.arrangement.clips ?? []).filter((clip) => clip.trackRef === reference || clip.parentRef === reference); return simulatorRevision({ track: ownedTrack, arrangementClips }); }
    const scene = snapshot.scenes.find((row) => row.ref === reference); if (!scene) throw new Error("created scene fingerprint is unavailable"); const sceneRow = scene as unknown as Record<string, unknown>; const sceneIdentity = { ref: scene.ref, parentRef: sceneRow.parentRef ?? null, objectIdentity: scene.objectIdentity ?? null, name: scene.name, triggerable: sceneRow.triggerable ?? null };
    const contents = snapshot.tracks.map((track) => { const slot = track.clipSlots?.find((row) => row.sceneIndex === scene.index); const clip = slot?.clipRef ? track.clips.find((row) => row.ref === slot.clipRef) : undefined; const slotRow = slot as unknown as Record<string, unknown> | undefined; const ownedSlot = slot ? { ref: slot.ref, parentRef: slot.parentRef ?? null, trackRef: slotRow?.trackRef ?? null, objectIdentity: slot.objectIdentity ?? null, clipRef: slot.clipRef ?? null, empty: slot.empty } : null; return { trackRef: track.ref, trackIdentity: track.objectIdentity ?? null, slot: ownedSlot, clip: clip ?? null }; });
    return simulatorRevision({ scene: sceneIdentity, contents });
  }

  status(): LiveStatus { return { connected: true, adapter: "simulator", epoch: this.epoch, protocol: LIVE_PROTOCOL_VERSION, capabilities: SIMULATOR_CAPABILITIES, operations: [...SIMULATOR_OPERATIONS] }; }
  snapshot(): LiveSnapshot { const value = structuredClone(this.state) as LiveSnapshot; value.arrangement.clips = (this.state.arrangementClips ?? []).map((item) => ({ ref: item.clip.ref, objectIdentity: item.clip.objectIdentity, parentRef: item.trackRef, trackRef: item.trackRef, name: item.clip.name, kind: item.clip.kind, start: item.clip.start, length: item.clip.length, muted: item.clip.muted ?? null, colorIndex: item.clip.colorIndex ?? null, looping: item.clip.looping ?? null, loopStart: item.clip.loopStart ?? null, loopEnd: item.clip.loopEnd ?? null, filePath: item.clip.filePath ?? null, isAudio: item.clip.isAudio ?? (item.clip.kind === "audio") })); return value; }
  get(objectRef: LiveRef): unknown {
    if (objectRef === this.state.set.ref) return structuredClone(this.state.set);
    const scene = this.state.scenes.find((item) => item.ref === objectRef);
    if (scene) return structuredClone(scene);
    for (const track of this.state.tracks) {
      if (track.ref === objectRef) return structuredClone(track);
      const clip = track.clips.find((item) => item.ref === objectRef);
      if (clip) return structuredClone(clip);
      for (const lane of track.takeLanes ?? []) {
        if (lane.ref === objectRef) return structuredClone(lane);
        const laneClip = lane.clips.find((item) => item.ref === objectRef);
        if (laneClip) return structuredClone(laneClip);
      }
      for (const device of track.devices) {
        if (device.ref === objectRef) return structuredClone(device);
        const parameter = device.parameters.find((item) => item.ref === objectRef);
        if (parameter) return structuredClone(parameter);
      }
    }
    const locator = this.state.arrangement.locators.find((item) => item.ref === objectRef);
    if (locator) return structuredClone(locator);
    return undefined;
  }
  /** Simulator-only test hook for authoritative external-edit conflict cases. */
  simulateExternalEdit(objectRef: LiveRef, property: string, value: unknown): void { this.set(objectRef, property, value); }
  private set(objectRef: LiveRef, property: string, value: unknown): void {
    const target = objectRef === this.state.set.ref ? this.state.set : this.find(objectRef);
    if (!target || !(property in target)) throw new Error(`unknown Live property: ${objectRef}.${property}`);
    if (property === "tempo") { if (target !== this.state.set || typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("tempo must be finite"); this.state.set.tempo = clamp(value, 20, 999); }
    else if (property === "volume" || property === "pan") { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${property} must be finite`); (target as Track)[property] = clamp(value, property === "pan" ? -1 : 0, 1); }
    else if (property === "playing" || property === "mute" || property === "solo" || property === "armed") { if (typeof value !== "boolean") throw new TypeError(`${property} must be boolean`); (target as Record<string, unknown>)[property] = value; }
    else if (property === "position" && target === this.state.set) { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("position must be a non-negative finite number"); this.state.set.position = value; }
    else if (property === "name") { if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new TypeError("name must be 1-256 characters"); (target as Record<string, unknown>)[property] = value; }
    else if (property === "value" && "min" in target && "max" in target) { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("parameter value must be finite"); const parameter = target as Parameter; if (parameter.enabled === false) throw new Error("parameter is disabled"); const quantization = parameter.quantization ?? 0; const clamped = clamp(value, parameter.min, parameter.max); parameter.value = quantization > 0 ? Math.round((clamped - parameter.min) / quantization) * quantization + parameter.min : clamped; parameter.revision = (parameter.revision ?? 0) + 1; parameter.displayValue = String(parameter.value); }
    else throw new Error(`property is not writable: ${property}`);
    const appliedValue = (target as Record<string, unknown>)[property];
    this.emit({ type: property === "playing" || property === "tempo" ? "transport" : "object", ref: objectRef, payload: { property, value: appliedValue } });
  }
  private stopPlayback(operation: string): void {
    this.state.set.playing = false;
    this.state.playback.transport.playing = false;
    this.state.playback.firedTargets = []; this.state.playback.playingTargets = []; this.state.playback.revision = `${this.epoch}:stopped`;
    for (const track of this.state.tracks) { track.firedSlotIndex = null; track.playingSlotIndex = null; }
    this.emit({ type: "transport", payload: { operation } });
  }
  invoke({ operation, args }: LiveInvocation): unknown {
    const stringArg = (name: string): string => { const value = args[name]; if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new TypeError(`${name} must be a non-empty string`); return value; };
    const objectRef = (name: string): LiveRef => stringArg(name) as LiveRef;
    const structureRevision = (): string => createHash("sha256").update(JSON.stringify({ tracks: this.state.tracks.map((item, index) => [item.ref, item.objectIdentity, item.name, item.kind, index]), scenes: this.state.scenes.map((item, index) => [item.ref, item.objectIdentity, item.name, index]) })).digest("hex");
    const requireStructureRevision = (): void => { if (args.expectedStructureRevision !== structureRevision()) throw new Error("Session structure changed since preview"); };
    const arrangementRows = (trackRef: LiveRef) => (this.state.arrangementClips ?? []).filter((item) => item.trackRef === trackRef).map((item) => ({ ref: item.clip.ref, objectIdentity: item.clip.objectIdentity }));
    const arrangementCollectionRevision = (trackRef: LiveRef): string => simulatorRevision(arrangementRows(trackRef));
    const arrangementAuthorityRevision = (clipRef: LiveRef): string => { const item = (this.state.arrangementClips ?? []).find((entry) => entry.clip.ref === clipRef); const track = item && this.findTrack(item.trackRef); if (!item || !track) throw new Error("Arrangement clip hierarchy is unavailable"); return simulatorRevision({ clip: { ref: clipRef, objectIdentity: item.clip.objectIdentity }, owner: { ref: track.ref, objectIdentity: track.objectIdentity }, siblings: arrangementRows(track.ref) }); };
    const mixerStateRevision = (track: Track): string => simulatorRevision(Object.fromEntries(["volume", "pan", "mute", "solo", "cueVolume", "sends"].map((field) => [field, (track.mixer as unknown as Record<string, unknown>)?.[field] ?? null])));
    const routingStateRevision = (track: Track): string => simulatorRevision({ inputType: track.routing?.inputType ?? null, inputSubRouting: track.routing?.inputSubRouting ?? null, outputType: track.routing?.outputType ?? null, outputSubRouting: track.routing?.outputSubRouting ?? null, arm: track.armed ?? null, monitoring: track.monitoringState ?? null });
    const captureAuthorityRevision = (): string => simulatorRevision({ tracks: this.state.tracks.map((track) => ({ ref: track.ref, objectIdentity: track.objectIdentity, clips: track.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity, notesRevision: clip.notesRevision })) })), scenes: this.state.scenes.map((scene) => ({ ref: scene.ref, objectIdentity: scene.objectIdentity, index: scene.index })), playbackRevision: this.state.playback.revision });
    const auditionAuthorityRevision = (sceneRef: LiveRef, eligible: string[]): string => { const scene = this.state.scenes.find((item) => item.ref === sceneRef); if (!scene) throw new Error("audition scene is unavailable"); const targets = [...eligible].sort().map((key) => { const [trackRef, slotRef, expectedSceneRef] = key.split("|"); const track = this.state.tracks.find((item) => item.ref === trackRef); const slot = track?.clipSlots?.find((item) => item.ref === slotRef); const clip = slot?.clipRef ? track?.clips.find((item) => item.ref === slot.clipRef) : undefined; if (!track || !slot || !clip || expectedSceneRef !== sceneRef) throw new Error("audition hierarchy is incomplete"); return { trackRef: track.ref, trackIdentity: track.objectIdentity, slotRef: slot.ref, slotIdentity: slot.objectIdentity, sceneRef: scene.ref, sceneIdentity: scene.objectIdentity, clipRef: clip.ref, clipIdentity: clip.objectIdentity }; }); return simulatorRevision({ set: { ref: this.state.set.ref, objectIdentity: this.state.set.objectIdentity }, scene: { ref: scene.ref, objectIdentity: scene.objectIdentity, index: scene.index }, targets }); };
    const requireDeviceSiblings = (devices: Device[]): void => {
      const expected = args.expectedSiblings;
      if (!Array.isArray(expected) || expected.length > 256 || !expected.every((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as { ref?: unknown }).ref === "string" && typeof (item as { objectIdentity?: unknown }).objectIdentity === "string")) throw new TypeError("expected device siblings are invalid");
      const current = devices.map((device) => ({ ref: device.ref, objectIdentity: device.objectIdentity }));
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("device siblings changed since preview");
    };
    const requireAutomationAuthority = (clip: Clip, parameterRef: LiveRef): void => {
      if (args.expectedAuthorityDigest !== this.automationAuthorityDigest(clip.ref, parameterRef) || args.expectedEnvelopeRevision !== this.envelopeRevision(clip, parameterRef)) throw new Error("automation target identity or envelope changed since preview");
    };
    const recordingAuthority = (): void => {
      if (typeof args.expectedSessionRecord !== "boolean" || typeof args.expectedArrangementRecord !== "boolean" || args.expectedSessionRecord !== this.state.playback.transport.sessionRecord || args.expectedArrangementRecord !== this.state.playback.transport.arrangementRecord) throw new Error("recording state changed since preview");
      if (!args.outputSafety || typeof args.outputSafety !== "object" || (args.outputSafety as { safe?: unknown }).safe !== true || !["string"].includes(typeof (args.outputSafety as { provenance?: unknown }).provenance) || ["", "unknown", "simulator"].includes(String((args.outputSafety as { provenance?: unknown }).provenance))) throw new Error("authoritative output safety is required");
      if (args.action === "start") { const destination = this.findTrack(objectRef("destinationTrackRef")); const armed = this.state.tracks.filter((track) => track.armed === true); if (!destination || destination.objectIdentity !== args.destinationTrackIdentity || destination.armed !== true || armed.length !== 1 || armed[0] !== destination) throw new Error("recording destination identity must be the only armed track"); }
      else if (args.destinationTrackRef !== null || args.destinationTrackIdentity !== null) throw new Error("recording stop destination authority must be null");
    };
    switch (operation) {
      case "transport.set": {
        if (args.setRef !== this.state.set.ref || args.expectedObjectIdentity !== this.state.set.objectIdentity || typeof args.expectedRevision !== "string" || args.expectedRevision !== this.state.playback.revision) throw new Error("transport Set identity or state changed since preview");
        const transport = this.state.playback.transport;
        const finite = (name: string): number | undefined => { const value = args[name]; if (value === null || value === undefined) return undefined; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} is invalid`); return value; };
        const bool = (name: string): boolean | undefined => { const value = args[name]; if (value === null || value === undefined) return undefined; if (typeof value !== "boolean") throw new TypeError(`${name} is invalid`); return value; };
        const position = finite("position"); const loopStart = finite("loopStart"); const loopLength = finite("loopLength");
        const loopEnabled = bool("loopEnabled"); const metronome = bool("metronome"); const punchIn = bool("punchIn"); const punchOut = bool("punchOut");
        if (loopLength !== undefined && loopLength <= 0) throw new RangeError("loopLength is invalid");
        if (position !== undefined) { transport.position = position; this.state.set.position = position; }
        if (loopEnabled !== undefined) transport.loop.enabled = loopEnabled;
        if (loopStart !== undefined) transport.loop.start = loopStart;
        if (loopLength !== undefined) transport.loop.length = loopLength;
        if (metronome !== undefined) transport.metronome = metronome;
        if (punchIn !== undefined) transport.punchIn = punchIn;
        if (punchOut !== undefined) transport.punchOut = punchOut;
        this.state.playback.revision = `${this.epoch}:transport:${++this.sequence}`;
        this.emit({ type: "transport", payload: { operation } });
        return { changed: true, revision: this.state.playback.revision };
      }
      case "tempo.set": {
        const setRef = objectRef("ref"); const value = args.value; const expectedTempo = args.expectedTempo;
        if (setRef !== this.state.set.ref || args.expectedObjectIdentity !== this.state.set.objectIdentity || typeof value !== "number" || typeof expectedTempo !== "number" || this.state.set.tempo !== expectedTempo) throw new Error("Set identity or tempo state changed since preview");
        this.state.set.tempo = clamp(value, 20, 999); const revision = ++this.sequence; this.emit({ type: "transport", ref: setRef, payload: { property: "tempo", value: this.state.set.tempo } }); return { changed: true, tempo: this.state.set.tempo, revision };
      }
      case "session.clip-launch": {
        const slotRef = objectRef("slotRef");
        if (args.playbackRevision !== this.state.playback.revision) throw new Error("playback state changed since preview");
        for (const track of this.state.tracks) for (const slot of track.clipSlots ?? []) {
          if (slot.ref === slotRef && slot.clipRef && track.ref === args.trackRef && slot.clipRef === args.clipRef) {
            const scene = this.state.scenes.find((item) => item.index === slot.sceneIndex);
            const clip = track.clips.find((item) => item.ref === slot.clipRef);
            if (!scene || !clip || scene.ref !== args.sceneRef || scene.index !== args.sceneIndex || track.objectIdentity !== args.trackIdentity || scene.objectIdentity !== args.sceneIdentity || slot.objectIdentity !== args.slotIdentity || clip.objectIdentity !== args.clipIdentity) throw new Error("clip-launch object identity changed");
            const target: SessionPlaybackTarget = { trackRef: track.ref, clipSlotRef: slot.ref, sceneRef: scene.ref, sceneIndex: slot.sceneIndex, clipRef: slot.clipRef };
            this.state.set.playing = true;
            this.state.playback.transport.playing = true;
            this.state.playback.firedTargets = [...this.state.playback.firedTargets.filter((item) => item.clipSlotRef !== slot.ref), target];
            this.state.playback.playingTargets = [...this.state.playback.playingTargets.filter((item) => item.clipSlotRef !== slot.ref), target];
            track.firedSlotIndex = slot.sceneIndex; track.playingSlotIndex = slot.sceneIndex;
            this.state.playback.revision = `${this.epoch}:clip:${scene.ref}`;
            this.emit({ type: "transport", ref: slotRef, payload: { operation, slot: slotRef } });
            return { launched: slotRef, targets: [target] };
          }
        }
        throw new Error("clip slot with a clip is required");
      }
      case "session.clip-stop": {
        const trackRef = objectRef("trackRef");
        const targetKey = `${trackRef}|${String(args.slotRef)}|${String(args.sceneRef)}`;
        const active = [...this.state.playback.firedTargets, ...this.state.playback.playingTargets].filter((item) => item.trackRef === trackRef);
        if (active.some((item) => `${item.trackRef}|${item.clipSlotRef}|${item.sceneRef}` !== targetKey || item.clipRef !== args.clipRef || item.sceneIndex !== args.sceneIndex)) throw new Error("track has foreign playback targets");
        const track = this.state.tracks.find((item) => item.ref === trackRef);
        const scene = this.state.scenes.find((item) => item.ref === args.sceneRef && item.index === args.sceneIndex);
        const slot = track?.clipSlots?.find((item) => item.ref === args.slotRef && item.sceneIndex === args.sceneIndex && item.clipRef === args.clipRef);
        const clip = track?.clips.find((item) => item.ref === args.clipRef);
        if (!track || !scene || !slot || !clip || track.objectIdentity !== args.trackIdentity || scene.objectIdentity !== args.sceneIdentity || slot.objectIdentity !== args.slotIdentity || clip.objectIdentity !== args.clipIdentity) throw new Error("clip-stop object identity changed");
        this.state.playback.firedTargets = this.state.playback.firedTargets.filter((item) => item.trackRef !== trackRef);
        this.state.playback.playingTargets = this.state.playback.playingTargets.filter((item) => item.trackRef !== trackRef);
        track.firedSlotIndex = null; track.playingSlotIndex = null;
        if (this.state.playback.firedTargets.length === 0 && this.state.playback.playingTargets.length === 0) { this.state.set.playing = false; this.state.playback.transport.playing = false; }
        this.state.playback.revision = `${this.epoch}:track-stop:${trackRef}`;
        this.emit({ type: "transport", ref: trackRef, payload: { operation } });
        return { stopped: true };
      }
      case "session.capture-midi": {
        if (args.expectedStateRevision !== captureAuthorityRevision()) throw new Error("Session state changed since capture preview");
        const track = this.state.tracks[0];
        if (!track) throw new Error("MIDI capture is unavailable");
        const sceneIndex = this.state.scenes.length;
        const scene: Scene = { ref: ref("scene", `capture-target-${this.sequence + 1}`), objectIdentity: `sim-object:scene:capture-target-${this.sequence + 1}`, name: "Capture Target", index: sceneIndex }; this.state.scenes.push(scene);
        const clip: Clip = { ref: ref("clip", `captured-${++this.sequence}`), objectIdentity: `sim-object:clip:${this.sequence}`, name: "Captured", kind: "midi", start: sceneIndex * 4, length: 4, notes: [], notesRevision: simulatorRevision([]), warp: false, takes: [], automation: [] };
        track.clips.push(clip);
        const slot = { ref: ref("clip-slot", `${track.ref}:${sceneIndex}`), parentRef: track.ref, objectIdentity: `sim-object:clip-slot:${this.sequence}`, sceneIndex, clipRef: clip.ref, empty: false };
        track.clipSlots = [...(track.clipSlots ?? []), slot];
        this.emit({ type: "object", ref: track.ref, payload: { operation, clip: structuredClone(clip) } });
        return { captured: true, clips: [clip.ref], clipIdentities: [{ ref: clip.ref, objectIdentity: clip.objectIdentity, createdFingerprint: simulatorRevision(clip) }] };
      }
      case "scene.capture": {
        if (args.expectedStateRevision !== captureAuthorityRevision()) throw new Error("Session state changed since capture preview");
        const scene: Scene = { ref: ref("scene", `captured-${++this.sequence}`), objectIdentity: `sim-object:scene:${this.sequence}`, name: "Captured", index: this.state.scenes.length };
        this.state.scenes.push(scene); for (const track of this.state.tracks) { const slot = { ref: ref("clip-slot", `${track.ref}:${scene.ref}`), parentRef: track.ref, objectIdentity: `simulator:clip-slot:${track.ref}:${scene.ref}`, sceneIndex: scene.index, clipRef: null, empty: true }; track.clipSlots = [...(track.clipSlots ?? []), slot]; }
        this.emit({ type: "object", payload: { operation, scene } });
        return { captured: true, ref: scene.ref, objectIdentity: scene.objectIdentity, createdFingerprint: this.structureCreatedFingerprint("scene", scene.ref) };
      }
      case "session.audition-launch": {
        const sceneRef = objectRef("ref");
        const setName = stringArg("setName");
        if (typeof args.sceneName !== "string" || args.sceneName.length > 256) throw new TypeError("sceneName must be a string of at most 256 characters");
        if (!Number.isInteger(args.sceneIndex) || (args.sceneIndex as number) < 0 || (args.sceneIndex as number) > 10_000) throw new RangeError("sceneIndex is invalid");
        const playbackRevision = stringArg("playbackRevision");
        const eligible = args.eligibleTargets;
        if (!Array.isArray(eligible) || eligible.length < 1 || eligible.length > 256 || new Set(eligible).size !== eligible.length || !eligible.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 1024)) throw new TypeError("eligibleTargets are invalid");
        const scene = this.state.scenes.find((item) => item.ref === sceneRef);
        if (this.state.set.name !== setName || args.expectedSetIdentity !== this.state.set.objectIdentity || args.expectedAuthorityRevision !== auditionAuthorityRevision(sceneRef, eligible as string[])) throw new Error("disposable Set identity or audition hierarchy does not match");
        if (!scene || scene.index !== args.sceneIndex || scene.name !== args.sceneName) throw new Error("scene identity changed since preview");
        const transport = this.state.playback.transport;
        if (transport.playing !== false || transport.arrangementRecord !== false || transport.sessionRecord !== false) throw new Error("audition requires a stopped, non-recording authoritative state");
        if (!transport.launchQuantization.normalized || ["none", "unknown", "free"].includes(transport.launchQuantization.normalized)) throw new Error("launch quantization is unsafe or unknown");
        if (this.state.playback.firedTargets.length > 0 || this.state.playback.playingTargets.length > 0) throw new Error("existing Session playback prevents audition");
        if (this.state.playback.revision !== playbackRevision) throw new Error("playback state changed since preview");
        for (const track of this.state.tracks) {
          const monitorable = ["regular", "audio", "midi"].includes(track.kind);
          if (monitorable ? (track.armed !== false || !["off", "auto"].includes(String(track.monitoringState))) : (track.armed === true || track.monitoringState === "in")) throw new Error("armed, input-monitored, or unknown-state track prevents audition");
        }
        const eligibleKeys = new Set(eligible as string[]);
        for (const key of eligibleKeys) {
          const [trackRef, slotRef, keySceneRef] = key.split("|");
          if (keySceneRef !== sceneRef) throw new Error("eligible target references a different scene");
          const track = this.state.tracks.find((item) => item.ref === trackRef);
          const slot = track?.clipSlots?.find((item) => item.ref === slotRef);
          if (!slot || slot.sceneIndex !== scene.index || !slot.clipRef) throw new Error("eligible target is not an authoritative clip slot with a clip");
        }
        const targets: SessionPlaybackTarget[] = [];
        for (const track of this.state.tracks) for (const slot of track.clipSlots ?? []) {
          if (slot.sceneIndex === scene.index && slot.clipRef && eligibleKeys.has(`${track.ref}|${slot.ref}|${scene.ref}`)) targets.push({ trackRef: track.ref, clipSlotRef: slot.ref, sceneRef: scene.ref, sceneIndex: scene.index, clipRef: slot.clipRef });
        }
        if (targets.length === 0) throw new Error("launch verification failed; stop was attempted");
        this.state.set.playing = true;
        this.state.playback.transport.playing = true;
        for (const target of targets) { const track = this.state.tracks.find((item) => item.ref === target.trackRef); if (track) { track.firedSlotIndex = target.sceneIndex; track.playingSlotIndex = target.sceneIndex; } }
        this.state.playback.firedTargets = targets; this.state.playback.playingTargets = targets; this.state.playback.revision = `${this.epoch}:playing:${scene.ref}`;
        this.emit({ type: "transport", ref: scene.ref, payload: { operation, scene: scene.ref } });
        return { launched: scene.ref, targets };
      }
      case "session.audition-stop": {
        const sceneRef = objectRef("ref");
        const setName = stringArg("setName");
        const eligible = args.eligibleTargets;
        if (!Array.isArray(eligible) || eligible.length > 256 || new Set(eligible).size !== eligible.length || !eligible.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 1024)) throw new TypeError("eligibleTargets are invalid");
        if (this.state.set.name !== setName || args.expectedSetIdentity !== this.state.set.objectIdentity || args.expectedAuthorityRevision !== auditionAuthorityRevision(sceneRef, eligible as string[])) throw new Error("disposable Set identity or audition hierarchy does not match");
        const eligibleKeys = new Set(eligible as string[]);
        const active = [...this.state.playback.firedTargets, ...this.state.playback.playingTargets];
        if (active.some((target) => !eligibleKeys.has(`${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`) || target.sceneRef !== sceneRef)) throw new Error("external or unknown playback is active; owned stop refused");
        this.stopPlayback(operation);
        return { stopped: true };
      }
      case "session.emergency-stop": {
        const expected = args.expectedTargets;
        if (!Array.isArray(expected) || expected.length > 256 || new Set(expected).size !== expected.length || !expected.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 1024)) throw new TypeError("expectedTargets are invalid");
        const expectedKeys = new Set(expected as string[]);
        const activeKeys = [...new Set([...this.state.playback.firedTargets, ...this.state.playback.playingTargets].map((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`))].sort();
        const sessionRecord = this.state.playback.transport.sessionRecord; const arrangementRecord = this.state.playback.transport.arrangementRecord;
        const recording = sessionRecord && arrangementRecord ? "both" : sessionRecord ? "session" : arrangementRecord ? "arrangement" : "stopped";
        if (recording !== args.expectedRecording || activeKeys.length !== expectedKeys.size || activeKeys.some((key) => !expectedKeys.has(key))) throw new Error("playback or recording exceeds the separately authorized observation; perform fresh discovery");
        this.stopPlayback(operation); this.state.playback.transport.sessionRecord = false; this.state.playback.transport.arrangementRecord = false;
        return { stopped: true, stoppedTargets: activeKeys, recordingStopped: true };
      }
      case "clip.create": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track || !track.ref.startsWith("track:")) throw new Error("unknown track reference");
        const kind = args.kind === "audio" ? "audio" : args.kind === "midi" ? "midi" : undefined;
        if (!kind) throw new TypeError("kind must be midi or audio");
        const start = args.start ?? (typeof args.sceneIndex === "number" ? args.sceneIndex * 4 : undefined); const length = args.length;
        if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof length !== "number" || !Number.isFinite(length) || length <= 0) throw new RangeError("clip bounds are invalid");
        const sceneIndex = typeof args.sceneIndex === "number" ? args.sceneIndex : undefined; const slot = sceneIndex === undefined ? undefined : track.clipSlots?.find((candidate) => candidate.sceneIndex === sceneIndex); const scene = sceneIndex === undefined ? undefined : this.state.scenes.find((candidate) => candidate.index === sceneIndex);
        if (!slot || !scene || args.expectedTrackIdentity !== track.objectIdentity || args.expectedSlotRef !== slot.ref || args.expectedSlotIdentity !== slot.objectIdentity || args.expectedSceneRef !== scene.ref || args.expectedSceneIdentity !== scene.objectIdentity || slot.clipRef) throw new Error("clip creation target identity changed since preview");
        const clipIdentity = `simulator:clip:clip-${track.clips.length + 1}-${this.sequence + 1}`;
        const clip: Clip = { ref: ref("clip", `clip-${track.clips.length + 1}-${this.sequence + 1}`), objectIdentity: clipIdentity, name: typeof args.name === "string" && args.name.length > 0 ? args.name : "New Clip", kind, start, length, notes: [], notesRevision: simulatorRevision([]), warp: false, takes: [], automation: [], isAudio: kind === "audio", gain: kind === "audio" ? 1 : null, pitchCoarse: kind === "audio" ? 0 : null, pitchFine: kind === "audio" ? 0 : null, warpMode: kind === "audio" ? 0 : null, loopStart: kind === "audio" ? start : null, loopEnd: kind === "audio" ? start + length : null, warping: kind === "audio" ? true : null, fadeInLength: kind === "audio" ? 0 : null, fadeOutLength: kind === "audio" ? 0 : null, availableAudioFields: kind === "audio" ? ["gain", "pitchCoarse", "pitchFine", "warpMode", "warping", "fadeInLength", "fadeOutLength", "loopStart", "loopEnd"] : [] };
        track.clips.push(clip); slot.clipRef = clip.ref; slot.empty = false; this.emit({ type: "object", ref: track.ref, payload: { operation, clip: structuredClone(clip) } }); return { ref: clip.ref, objectIdentity: clip.objectIdentity, name: clip.name, length: clip.length, createdFingerprint: simulatorRevision(clip) };
      }
      case "clip.delete": {
        const clipRef = objectRef("ref");
        for (const track of this.state.tracks) { const index = track.clips.findIndex((clip) => clip.ref === clipRef); if (index >= 0) { const clip = track.clips[index]!; const slot = track.clipSlots?.find((candidate) => candidate.clipRef === clipRef); const scene = slot && this.state.scenes.find((candidate) => candidate.index === slot.sceneIndex); if (!slot || !scene || args.expectedObjectIdentity !== clip.objectIdentity || args.expectedTrackRef !== track.ref || args.expectedTrackIdentity !== track.objectIdentity || args.expectedSlotRef !== slot.ref || args.expectedSlotIdentity !== slot.objectIdentity || args.expectedSceneRef !== scene.ref || args.expectedSceneIdentity !== scene.objectIdentity) throw new Error("clip hierarchy identity changed; deletion refused"); track.clips.splice(index, 1); slot.clipRef = null; slot.empty = true;
          if (clip.ref.startsWith("clip:captured-") && scene.name === "Capture Target") { track.clipSlots = track.clipSlots?.filter((candidate) => candidate !== slot); this.state.scenes = this.state.scenes.filter((candidate) => candidate !== scene); this.state.scenes.forEach((candidate, sceneIndex) => { candidate.index = sceneIndex; }); }
          this.emit({ type: "object", ref: track.ref, payload: { operation, ref: clipRef } }); return { deleted: clipRef }; } }
        throw new Error(`unknown clip reference: ${clipRef}`);
      }
      case "track.create": {
        requireStructureRevision(); const kind = args.kind === "audio" || args.kind === "midi" ? args.kind : undefined;
        if (!kind) throw new TypeError("track kind must be audio or midi");
        const name = stringArg("name");
        const index = args.index === undefined ? this.state.tracks.length : args.index;
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > this.state.tracks.length) throw new RangeError("track index is invalid");
        if (this.state.tracks.some((track) => track.name === name)) throw new Error("track name already exists");
        const track: Track = { ref: ref("track", `track-${this.state.tracks.length + this.sequence + 1}`), objectIdentity: `simulator:track:${this.state.tracks.length + this.sequence + 1}`, name, kind, volume: 0.85, pan: 0, mute: false, solo: false, armed: false, clips: [], clipSlots: this.state.scenes.map((scene) => ({ ref: ref("clip-slot", `${this.state.tracks.length + this.sequence + 1}:${scene.index}`), parentRef: ref("track", `track-${this.state.tracks.length + this.sequence + 1}`), objectIdentity: `simulator:clip-slot:${this.state.tracks.length + this.sequence + 1}:${scene.index}`, sceneIndex: scene.index, clipRef: null, empty: true })), devices: [], sends: [0, 0] };
        this.state.tracks.splice(index as number, 0, track);
        this.emit({ type: "object", ref: track.ref, payload: { operation, track } });
        return { ...structuredClone(track), createdFingerprint: this.structureCreatedFingerprint("track", track.ref) };
      }
      case "track.delete": {
        requireStructureRevision(); const trackRef = objectRef("ref");
        const index = this.state.tracks.findIndex((track) => track.ref === trackRef);
        if (index < 0) throw new Error(`unknown track reference: ${trackRef}`);
        if (args.expectedObjectIdentity !== this.state.tracks[index]!.objectIdentity) throw new Error("track object identity changed; deletion refused");
        const [deleted] = this.state.tracks.splice(index, 1);
        this.emit({ type: "object", ref: trackRef, payload: { operation, track: deleted } });
        return { deleted: trackRef };
      }
      case "scene.create": {
        requireStructureRevision(); const name = stringArg("name");
        const index = args.index === undefined ? this.state.scenes.length : args.index;
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > this.state.scenes.length) throw new RangeError("scene index is invalid");
        if (this.state.scenes.some((scene) => scene.name === name)) throw new Error("scene name already exists");
        const scene: Scene = { ref: ref("scene", `scene-${this.state.scenes.length + this.sequence + 1}`), objectIdentity: `sim-object:scene:${this.state.scenes.length + this.sequence + 1}`, name, index: index as number };
        this.state.scenes.splice(index as number, 0, scene);
        this.state.scenes.forEach((item, itemIndex) => { item.index = itemIndex; });
        for (const track of this.state.tracks) { for (const slot of track.clipSlots ?? []) if (slot.sceneIndex >= (index as number)) slot.sceneIndex += 1; const slot = { ref: ref("clip-slot", `${track.ref}:${scene.ref}`), parentRef: track.ref, objectIdentity: `simulator:clip-slot:${track.ref}:${scene.ref}`, sceneIndex: index as number, clipRef: null, empty: true }; track.clipSlots = [...(track.clipSlots ?? []), slot].sort((left, right) => left.sceneIndex - right.sceneIndex); }
        this.emit({ type: "object", ref: scene.ref, payload: { operation, scene } });
        const created = this.state.scenes.find((item) => item.ref === scene.ref) as Scene; return { ...structuredClone(created), createdFingerprint: this.structureCreatedFingerprint("scene", scene.ref) };
      }
      case "scene.delete": {
        requireStructureRevision(); const sceneRef = objectRef("ref");
        const index = this.state.scenes.findIndex((scene) => scene.ref === sceneRef);
        if (index < 0) throw new Error(`unknown scene reference: ${sceneRef}`);
        if (args.expectedObjectIdentity !== this.state.scenes[index]!.objectIdentity) throw new Error("scene object identity changed; deletion refused");
        this.state.scenes.splice(index, 1);
        this.state.scenes.forEach((item, itemIndex) => { item.index = itemIndex; });
        for (const track of this.state.tracks) { track.clipSlots = (track.clipSlots ?? []).filter((slot) => slot.sceneIndex !== index); for (const slot of track.clipSlots) if (slot.sceneIndex > index) slot.sceneIndex -= 1; }
        this.emit({ type: "object", ref: sceneRef, payload: { operation, ref: sceneRef } });
        return { deleted: sceneRef };
      }
      case "track.rename": case "scene.rename": case "clip.rename": case "device.rename": case "locator.rename": {
        const reference = objectRef("ref"); const name = stringArg("name"); const expectedName = args.expectedName;
        let target: { ref: LiveRef; objectIdentity?: string; name: string } | undefined;
        if (operation === "track.rename") target = this.state.tracks.find((item) => item.ref === reference);
        else if (operation === "scene.rename") target = this.state.scenes.find((item) => item.ref === reference);
        else if (operation === "clip.rename") target = this.state.tracks.flatMap((item) => item.clips).find((item) => item.ref === reference) ?? this.state.arrangementClips?.map((item) => item.clip).find((item) => item.ref === reference);
        else if (operation === "device.rename") target = this.state.tracks.flatMap((item) => item.devices).find((item) => item.ref === reference);
        else target = this.state.arrangement.locators.find((item) => item.ref === reference);
        let authorityRevision: string | undefined;
        if (operation === "track.rename" || operation === "scene.rename") authorityRevision = structureRevision();
        else if (operation === "locator.rename") authorityRevision = this.state.arrangement.locatorRevision;
        else if (operation === "clip.rename") authorityRevision = reference.startsWith("arrangement-clip:") ? simulatorRevision({ expectedObjectIdentity: target?.objectIdentity, expectedAuthorityRevision: arrangementAuthorityRevision(reference) }) : simulatorRevision(this.sessionClipAuthority(reference));
        else { const track = this.state.tracks.find((item) => item.devices.some((device) => device.ref === reference)); const device = track?.devices.find((item) => item.ref === reference); if (track && device) authorityRevision = simulatorRevision({ ref: device.ref, objectIdentity: device.objectIdentity, trackRef: track.ref, trackIdentity: track.objectIdentity, ownerRef: track.ref, ownerIdentity: track.objectIdentity, siblings: track.devices.map((item) => ({ ref: item.ref, objectIdentity: item.objectIdentity })) }); }
        if (!target || target.objectIdentity !== args.expectedObjectIdentity || target.name !== expectedName || authorityRevision !== args.expectedAuthorityRevision) throw new Error("rename target identity, hierarchy, or name changed since preview");
        target.name = name; this.emit({ type: "object", ref: reference, payload: { operation, name } }); return { renamed: reference, name };
      }
      case "device.insert": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track || args.expectedTrackIdentity !== track.objectIdentity || simulatorCanonical(args.expectedSiblings) !== simulatorCanonical(track.devices.map((device) => ({ ref: device.ref, objectIdentity: device.objectIdentity })))) throw new Error("device insertion target changed since preview");
        const name = stringArg("deviceName");
        const index = args.index === undefined || args.index === null ? -1 : args.index;
        if (!Number.isInteger(index) || (index as number) < -1 || (index as number) > 256) throw new RangeError("device index is invalid");
        const device: Device = { ref: ref("device", `${track.ref}:${track.devices.length}`), parentRef: track.ref, name, kind: name.toLowerCase().includes("rack") ? "rack" : "device", className: name, parameters: [], objectIdentity: `simulator:device:${this.sequence + 1}:${track.ref}:${track.devices.length}`, enabled: true, canHaveChains: name.toLowerCase().includes("rack"), canHaveDrumPads: name.toLowerCase().includes("drum rack") };
        if (device.canHaveDrumPads) device.drumPads = Array.from({ length: 16 }, (_, padIndex) => ({ ref: ref("drum_pad", `${device.ref}:${padIndex}`), parentRef: device.ref, index: padIndex, name: `Pad ${padIndex + 1}`, mute: false, chains: [] }));
        const position = (index as number) < 0 || (index as number) > track.devices.length ? track.devices.length : index as number;
        device.ref = ref("device", `${track.ref}:${position}`);
        track.devices.splice(position, 0, device);
        this.emit({ type: "object", ref: track.ref, payload: { operation, device } });
        return { ref: device.ref, objectIdentity: device.objectIdentity, name: device.name, index: position, createdFingerprint: simulatorRevision(device) };
      }
      case "device.delete": {
        const deviceRef = objectRef("ref"); const expectedIdentity = stringArg("expectedObjectIdentity"); const expectedOwnerRef = objectRef("expectedOwnerRef"); const expectedOwnerIdentity = stringArg("expectedOwnerIdentity");
        for (const track of this.state.tracks) {
          const index = track.devices.findIndex((device) => device.ref === deviceRef && device.objectIdentity === expectedIdentity && device.parentRef === expectedOwnerRef && track.objectIdentity === expectedOwnerIdentity && args.expectedTrackRef === track.ref && args.expectedTrackIdentity === track.objectIdentity);
          if (index >= 0) { requireDeviceSiblings(track.devices); track.devices.splice(index, 1); this.emit({ type: "object", ref: track.ref, payload: { operation, ref: deviceRef } }); return { deleted: deviceRef }; }
        }
        throw new Error("unknown device reference");
      }
      case "device.enable": {
        const deviceRef = objectRef("ref"); const device = this.find(deviceRef) as Device | undefined;
        const owner = this.state.tracks.find((track) => track.devices.some((candidate) => candidate.ref === deviceRef));
        if (!device || !owner || !("parameters" in device) || device.objectIdentity !== stringArg("expectedObjectIdentity") || device.parentRef !== objectRef("expectedOwnerRef") || owner.objectIdentity !== stringArg("expectedOwnerIdentity") || args.expectedTrackRef !== owner.ref || args.expectedTrackIdentity !== owner.objectIdentity) throw new Error("unknown, replaced, or reparented device reference");
        requireDeviceSiblings(owner.devices);
        if (args.expectedStateRevision !== simulatorRevision({ enabled: device.enabled ?? null })) throw new Error("device enable state changed since preview");
        if (typeof args.enabled !== "boolean") throw new TypeError("enabled must be boolean");
        device.enabled = args.enabled;
        this.emit({ type: "object", ref: device.ref, payload: { operation } });
        return { changed: true, enabled: args.enabled, revision: ++this.sequence };
      }
      case "device.move": {
        const deviceRef = objectRef("ref"); const expectedIdentity = stringArg("expectedObjectIdentity"); const expectedOwnerRef = objectRef("expectedOwnerRef"); const expectedOwnerIdentity = stringArg("expectedOwnerIdentity");
        const index = args.index;
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 256) throw new RangeError("device index is invalid");
        for (const track of this.state.tracks) {
          const current = track.devices.findIndex((device) => device.ref === deviceRef && device.objectIdentity === expectedIdentity && device.parentRef === expectedOwnerRef && track.objectIdentity === expectedOwnerIdentity && args.expectedTrackRef === track.ref && args.expectedTrackIdentity === track.objectIdentity);
          if (current >= 0) {
            requireDeviceSiblings(track.devices);
            if ((index as number) >= track.devices.length) throw new RangeError("device index is invalid");
            const [device] = track.devices.splice(current, 1);
            track.devices.splice(index as number, 0, device!);
            this.emit({ type: "object", ref: track.ref, payload: { operation } });
            return { ref: deviceRef, objectIdentity: device!.objectIdentity, index };
          }
        }
        throw new Error("unknown device reference");
      }
      case "browser.search": {
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        const category = typeof args.category === "string" ? args.category : undefined;
        const limit = Number.isInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 100 ? args.limit as number : 50;
        const catalog = this.browserCatalog();
        return { items: structuredClone(catalog.filter((item) => (!category || item.category === category) && (!query || item.name.toLowerCase().includes(query) || item.path.includes(query))).slice(0, limit)) };
      }
      case "browser.inspect": {
        const itemId = stringArg("itemId"); const item = this.browserCatalog().find((candidate) => candidate.id === itemId);
        if (!item) throw new Error("browser item is not present"); return structuredClone(item);
      }
      case "browser.load": {
        const itemId = stringArg("itemId"); const item = this.browserCatalog().find((candidate) => candidate.id === itemId);
        if (!item || !item.isDevice || item.name !== args.expectedName || item.objectIdentity !== args.expectedItemIdentity) throw new Error("browser item identity is not an exact loadable device");
        const name = item.name; const track = this.findTrack(objectRef("trackRef"));
        if (!track || args.expectedTrackIdentity !== track.objectIdentity || simulatorCanonical(args.expectedSiblings) !== simulatorCanonical(track.devices.map((device) => ({ ref: device.ref, objectIdentity: device.objectIdentity })))) throw new Error("browser target track or devices changed since preview");
        const inserted = this.invoke({ operation: "device.insert", args: { trackRef: track.ref, deviceName: name, expectedTrackIdentity: track.objectIdentity, expectedSiblings: args.expectedSiblings } }) as { ref: LiveRef; objectIdentity: string };
        return { loaded: true, deviceRef: inserted.ref, deviceObjectIdentity: inserted.objectIdentity, createdFingerprint: (inserted as { createdFingerprint?: string }).createdFingerprint };
      }
      case "routing.set": {
        const track = this.findTrack(objectRef("ref"));
        if (!track || args.expectedObjectIdentity !== track.objectIdentity) throw new Error("routing track identity changed since preview");
        if (args.expectedStateRevision !== routingStateRevision(track)) throw new Error("routing state changed since preview");
        if (args.inputType !== undefined) track.routing = { ...(track.routing ?? {}), inputType: args.inputType as string | null } as RoutingState;
        if (args.inputSubRouting !== undefined) track.routing = { ...(track.routing ?? {}), inputSubRouting: args.inputSubRouting as string | null } as RoutingState;
        if (args.outputType !== undefined) track.routing = { ...(track.routing ?? {}), outputType: args.outputType as string | null } as RoutingState;
        if (args.outputSubRouting !== undefined) track.routing = { ...(track.routing ?? {}), outputSubRouting: args.outputSubRouting as string | null } as RoutingState;
        if (args.arm !== undefined) { if (typeof args.arm !== "boolean") throw new TypeError("arm is invalid"); track.armed = args.arm; }
        if (args.monitoring !== undefined) { if (!["in", "auto", "off"].includes(String(args.monitoring))) throw new RangeError("monitoring is invalid"); track.monitoringState = args.monitoring as LiveMonitoringState; }
        this.emit({ type: "object", ref: track.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "recording.session": {
        if (args.action !== "start" && args.action !== "stop") throw new RangeError("action is invalid"); recordingAuthority();
        this.state.playback.transport.sessionRecord = args.action === "start";
        this.emit({ type: "transport", payload: { operation } });
        return { recording: this.state.playback.transport.sessionRecord };
      }
      case "recording.arrangement": {
        if (args.action !== "start" && args.action !== "stop") throw new RangeError("action is invalid"); recordingAuthority();
        this.state.playback.transport.arrangementRecord = args.action === "start";
        if (args.action === "start") this.state.playback.transport.playing = true;
        this.emit({ type: "transport", payload: { operation } });
        return { recording: this.state.playback.transport.arrangementRecord };
      }
      case "mixer.set": {
        const track = this.findTrack(objectRef("ref"));
        if (!track?.mixer) throw new Error("mixer is unavailable");
        const mixer = track.mixer;
        if (args.expectedObjectIdentity !== track.objectIdentity || args.expectedVolumeIdentity !== mixer.volumeIdentity || args.expectedPanIdentity !== mixer.panIdentity || args.expectedCueIdentity !== mixer.cueIdentity || simulatorCanonical(args.expectedSendIdentities) !== simulatorCanonical(mixer.sendIdentities) || args.expectedStateRevision !== mixerStateRevision(track)) throw new Error("mixer track or parameter identity changed since preview");
        if (args.volume !== undefined) { if (typeof args.volume !== "number" || !Number.isFinite(args.volume) || args.volume < 0 || args.volume > 1) throw new RangeError("volume is invalid"); mixer.volume = args.volume; track.volume = args.volume; }
        if (args.pan !== undefined) { if (typeof args.pan !== "number" || !Number.isFinite(args.pan) || args.pan < -1 || args.pan > 1) throw new RangeError("pan is invalid"); mixer.pan = args.pan; track.pan = args.pan; }
        if (args.mute !== undefined) { if (typeof args.mute !== "boolean") throw new TypeError("mute is invalid"); mixer.mute = args.mute; track.mute = args.mute; }
        if (args.solo !== undefined) { if (typeof args.solo !== "boolean") throw new TypeError("solo is invalid"); mixer.solo = args.solo; track.solo = args.solo; }
        if (args.cueVolume !== undefined) { if (typeof args.cueVolume !== "number" || !Number.isFinite(args.cueVolume) || args.cueVolume < 0 || args.cueVolume > 1) throw new RangeError("cueVolume is invalid"); mixer.cueVolume = args.cueVolume; }
        if (args.sends !== undefined) {
          if (!Array.isArray(args.sends) || args.sends.length > mixer.sends.length || !args.sends.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError("sends are invalid");
          (args.sends as number[]).forEach((value, index) => { mixer.sends[index] = value; });
        }
        this.emit({ type: "object", ref: track.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "automation.envelope.read": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        const points = clip.envelopes?.[parameterRef];
        return { available: true, exists: points !== undefined, points: structuredClone(points ?? []), revision: this.envelopeRevision(clip, parameterRef) };
      }
      case "automation.envelope.create": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        requireAutomationAuthority(clip, parameterRef);
        clip.envelopes = clip.envelopes ?? {};
        clip.envelopes[parameterRef] = clip.envelopes[parameterRef] ?? [];
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { created: true };
      }
      case "automation.envelope.delete": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        requireAutomationAuthority(clip, parameterRef);
        if (!clip.envelopes || !(parameterRef in clip.envelopes)) throw new Error("envelope does not exist");
        delete clip.envelopes[parameterRef];
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { deleted: true };
      }
      case "automation.point.insert": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        requireAutomationAuthority(clip, parameterRef);
        const points = args.points;
        if (!Array.isArray(points) || points.length < 1 || points.length > 512) throw new RangeError("points are invalid");
        for (const point of points) if (!point || typeof point !== "object" || typeof (point as AutomationPoint).time !== "number" || !Number.isFinite((point as AutomationPoint).time) || (point as AutomationPoint).time < 0 || typeof (point as AutomationPoint).value !== "number" || !Number.isFinite((point as AutomationPoint).value)) throw new RangeError("points are invalid");
        clip.envelopes = clip.envelopes ?? {};
        const envelope = clip.envelopes[parameterRef] ?? (clip.envelopes[parameterRef] = []);
        envelope.push(...structuredClone(points as AutomationPoint[]));
        envelope.sort((a, b) => a.time - b.time);
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { inserted: points.length };
      }
      case "automation.point.delete": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        requireAutomationAuthority(clip, parameterRef);
        const envelope = clip.envelopes?.[parameterRef];
        if (!envelope) throw new Error("envelope does not exist");
        const from = args.from; const to = args.to;
        if (typeof from !== "number" || !Number.isFinite(from) || from < 0 || typeof to !== "number" || !Number.isFinite(to) || to <= from) throw new RangeError("from/to are invalid");
        const before = envelope.length;
        clip.envelopes![parameterRef] = envelope.filter((point) => point.time < from || point.time > to);
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { deleted: before - clip.envelopes![parameterRef]!.length };
      }
      case "clip.duplicate":
      case "clip.move": {
        const clipRef = objectRef("ref");
        const found = this.findClipWithTrack(clipRef);
        if (!found || simulatorCanonical(this.sessionClipAuthority(clipRef)) !== simulatorCanonical({ expectedObjectIdentity: args.expectedObjectIdentity, expectedTrackRef: args.expectedTrackRef, expectedTrackIdentity: args.expectedTrackIdentity, expectedSlotRef: args.expectedSlotRef, expectedSlotIdentity: args.expectedSlotIdentity, expectedSceneRef: args.expectedSceneRef, expectedSceneIdentity: args.expectedSceneIdentity })) throw new Error("clip duplication source identity changed since preview");
        if (operation === "clip.move" && args.arrangementPosition !== null) throw new Error("Session clip move cannot target the Arrangement");
        if (args.arrangementPosition !== null) {
          if (args.expectedTargetCollectionRevision !== arrangementCollectionRevision(found.track.ref)) throw new Error("Arrangement target collection changed since preview");
          if (typeof args.arrangementPosition !== "number" || !Number.isFinite(args.arrangementPosition) || args.arrangementPosition < 0) throw new RangeError("arrangement position is invalid");
          const clip: Clip = { ...structuredClone(found.clip), ref: ref("arrangement-clip", `${found.track.ref}:${args.arrangementPosition}`), objectIdentity: `simulator:arrangement-clip:${this.sequence + 1}`, start: args.arrangementPosition };
          this.state.arrangementClips = [...(this.state.arrangementClips ?? []), { clip, trackRef: found.track.ref }];
          this.emit({ type: "object", ref: found.track.ref, payload: { operation, clip } });
          return { ref: clip.ref, objectIdentity: clip.objectIdentity, name: clip.name, createdFingerprint: simulatorRevision((this.snapshot().arrangement.clips ?? []).find((row) => row.ref === clip.ref)) };
        }
        if (args.expectedTargetCollectionRevision !== null) throw new Error("Session duplication cannot carry Arrangement collection authority");
        const targetTrack = this.findTrack(objectRef("targetTrackRef"));
        const sceneIndex = args.targetSceneIndex;
        if (!targetTrack || !Number.isInteger(sceneIndex) || (sceneIndex as number) < 0) throw new Error("target track or scene index is invalid");
        const target = (targetTrack.clipSlots ?? []).find((slot) => slot.sceneIndex === sceneIndex);
        const scene = this.state.scenes.find((candidate) => candidate.index === sceneIndex);
        if (!target || !scene || args.expectedTargetTrackIdentity !== targetTrack.objectIdentity || args.expectedTargetSlotRef !== target.ref || args.expectedTargetSlotIdentity !== target.objectIdentity || args.expectedTargetSceneRef !== scene.ref || args.expectedTargetSceneIdentity !== scene.objectIdentity) throw new Error("target clip hierarchy identity changed");
        if (target.clipRef) throw new Error("target Session slot is occupied");
        const clip: Clip = { ...structuredClone(found.clip), ref: ref("clip", `${targetTrack.ref}:${sceneIndex}`), objectIdentity: `simulator:clip:${this.sequence + 1}` };
        targetTrack.clips.push(clip);
        target.clipRef = clip.ref; target.empty = false;
        if (operation === "clip.move") {
          const sourceSlot = found.track.clipSlots?.find((slot) => slot.clipRef === found.clip.ref);
          if (!sourceSlot) { targetTrack.clips = targetTrack.clips.filter((candidate) => candidate !== clip); target.clipRef = null; target.empty = true; throw new Error("source Session slot changed during move"); }
          found.track.clips = found.track.clips.filter((candidate) => candidate !== found.clip); sourceSlot.clipRef = null; sourceSlot.empty = true;
        }
        this.emit({ type: "object", ref: targetTrack.ref, payload: { operation, clip } });
        return { ref: clip.ref, objectIdentity: clip.objectIdentity, name: clip.name, createdFingerprint: simulatorRevision(clip) };
      }
      case "arrangement.clip.create": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track || args.expectedTrackIdentity !== track.objectIdentity || args.expectedCollectionRevision !== arrangementCollectionRevision(track.ref)) throw new Error("arrangement clip target track or collection identity changed");
        const position = args.position; const length = args.length; const name = args.name;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || typeof length !== "number" || !Number.isFinite(length) || length <= 0 || typeof name !== "string" || name.length < 1 || name.length > 256) throw new RangeError("arrangement clip bounds are invalid");
        const clip: Clip = { ref: ref("arrangement-clip", `${track.ref}:${position}`), objectIdentity: `simulator:arrangement-clip:${this.sequence + 1}`, name, kind: "midi", start: position, length, notes: [], notesRevision: simulatorRevision([]), warp: false, takes: [], automation: [] };
        this.state.arrangementClips = [...(this.state.arrangementClips ?? []), { clip, trackRef: track.ref }];
        this.emit({ type: "object", ref: track.ref, payload: { operation, clip } });
        return { ref: clip.ref, objectIdentity: clip.objectIdentity, name, start: position, length, createdFingerprint: simulatorRevision((this.snapshot().arrangement.clips ?? []).find((row) => row.ref === clip.ref)) };
      }
      case "arrangement.clip.delete": {
        const clipRef = objectRef("ref");
        const before = (this.state.arrangementClips ?? []).length; const target = (this.state.arrangementClips ?? []).find((item) => item.clip.ref === clipRef);
        if (!target || target.clip.objectIdentity !== args.expectedObjectIdentity || args.expectedAuthorityRevision !== arrangementAuthorityRevision(clipRef)) throw new Error("arrangement clip identity or hierarchy changed; deletion refused");
        this.state.arrangementClips = (this.state.arrangementClips ?? []).filter((item) => item.clip.ref !== clipRef);
        if ((this.state.arrangementClips ?? []).length === before) throw new Error("unknown arrangement clip reference");
        this.emit({ type: "object", payload: { operation, ref: clipRef } });
        return { deleted: clipRef };
      }
      case "arrangement.clip.move": {
        const clipRef = objectRef("ref");
        const item = (this.state.arrangementClips ?? []).find((entry) => entry.clip.ref === clipRef);
        if (!item || item.clip.objectIdentity !== args.expectedObjectIdentity || args.expectedAuthorityRevision !== arrangementAuthorityRevision(clipRef)) throw new Error("arrangement clip identity or hierarchy changed; move refused");
        const position = args.position;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) throw new RangeError("position is invalid");
        item.clip.start = position;
        this.emit({ type: "object", ref: clipRef, payload: { operation } });
        return { ref: clipRef, objectIdentity: item.clip.objectIdentity, start: position, createdFingerprint: simulatorRevision((this.snapshot().arrangement.clips ?? []).find((row) => row.ref === clipRef)) };
      }
      case "arrangement.audio-clip.create": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track || args.expectedTrackIdentity !== track.objectIdentity || args.expectedCollectionRevision !== arrangementCollectionRevision(track.ref)) throw new Error("arrangement audio clip target track or collection identity changed");
        const position = args.position; const filePath = args.filePath; const name = args.name;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) throw new RangeError("position is invalid");
        if (typeof filePath !== "string" || filePath.length < 1 || filePath.length > 1024) throw new RangeError("filePath is invalid");
        if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 256)) throw new RangeError("name is invalid");
        const clipName = (name as string | undefined) ?? filePath.split("/").pop() ?? "Audio Clip";
        const clip: Clip = { ref: ref("arrangement-clip", `${track.ref}:${position}`), objectIdentity: `simulator:arrangement-clip:${this.sequence + 1}`, name: clipName, kind: "audio", start: position, length: 4, notes: [], notesRevision: simulatorRevision([]), warp: true, takes: [], automation: [], filePath, isAudio: true, muted: false };
        this.state.arrangementClips = [...(this.state.arrangementClips ?? []), { clip, trackRef: track.ref }];
        this.emit({ type: "object", ref: track.ref, payload: { operation, clip } });
        return { ref: clip.ref, objectIdentity: clip.objectIdentity, name: clip.name, start: position, length: clip.length, filePath, createdFingerprint: simulatorRevision((this.snapshot().arrangement.clips ?? []).find((row) => row.ref === clip.ref)) };
      }
      case "clip.set": {
        const clip = this.findClip(objectRef("ref"));
        if (clip.objectIdentity !== args.expectedObjectIdentity) throw new Error("clip identity changed since preview");
        let clipAuthorityRevision: string;
        if (clip.ref.startsWith("take-lane-clip:")) {
          const foundLane = this.state.tracks.flatMap((track) => track.takeLanes ?? []).find((lane) => lane.clips.some((candidate) => candidate.ref === clip.ref));
          if (!foundLane) throw new Error("take-lane clip hierarchy is unavailable");
          clipAuthorityRevision = simulatorRevision({ takeLaneRevision: simulatorRevision(foundLane.clips.map((candidate) => ({ ref: candidate.ref, objectIdentity: candidate.objectIdentity }))), laneIdentity: foundLane.objectIdentity });
        } else {
          clipAuthorityRevision = clip.ref.startsWith("arrangement-clip:") ? arrangementAuthorityRevision(clip.ref) : simulatorRevision(this.sessionClipAuthority(clip.ref));
        }
        const clipFields = ["muted", "colorIndex", "looping", "loopStart", "loopEnd", "groove"];
        const clipStateRevision = simulatorRevision(Object.fromEntries(clipFields.map((field) => [field, (clip as unknown as Record<string, unknown>)[field] ?? null])));
        if (args.expectedAuthorityRevision !== clipAuthorityRevision || args.expectedStateRevision !== clipStateRevision) throw new Error("clip hierarchy or state changed since preview");
        if (args.muted !== undefined) { if (typeof args.muted !== "boolean") throw new TypeError("muted is invalid"); clip.muted = args.muted; }
        if (args.colorIndex !== undefined) { if (!Number.isInteger(args.colorIndex) || (args.colorIndex as number) < 0 || (args.colorIndex as number) > 69) throw new RangeError("colorIndex is invalid"); clip.colorIndex = args.colorIndex as number; }
        if (args.looping !== undefined) { if (typeof args.looping !== "boolean") throw new TypeError("looping is invalid"); if (clip.kind === "audio") throw new Error("audio clip loop editing uses audio.clip.set"); clip.looping = args.looping; }
        if (args.loopStart !== undefined || args.loopEnd !== undefined) {
          if (clip.kind === "audio") throw new Error("audio clip loop editing uses audio.clip.set");
          const start = (args.loopStart ?? clip.loopStart ?? 0) as number; const end = (args.loopEnd ?? clip.loopEnd ?? clip.length) as number;
          if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start) throw new RangeError("clip loop bounds are invalid");
          clip.loopStart = start; clip.loopEnd = end;
        }
        if (args.grooveRef !== undefined) {
          if (args.grooveRef === null) { clip.groove = null; clip.hasGroove = false; }
          else {
            const groove = this.state.groovePool!.grooves.find((candidate) => candidate.ref === args.grooveRef);
            if (!groove) throw new Error("groove reference is stale or invalid");
            clip.groove = { ref: groove.ref, name: groove.name }; clip.hasGroove = true;
          }
        }
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "audio.warp-marker.read": {
        const clip = this.findClip(objectRef("ref"));
        const markers = [...(clip.warpMarkers ?? [])].sort((a, b) => a.beatTime - b.beatTime);
        return { revision: simulatorRevision(markers), markers };
      }
      case "audio.warp-marker.add":
      case "audio.warp-marker.move":
      case "audio.warp-marker.delete": {
        const clip = this.findClip(objectRef("ref"));
        if (clip.kind !== "audio") throw new Error("warp markers require an audio clip");
        const clipAuthorityRevision = clip.ref.startsWith("arrangement-clip:") ? arrangementAuthorityRevision(clip.ref) : simulatorRevision(this.sessionClipAuthority(clip.ref));
        if (clip.objectIdentity !== args.expectedObjectIdentity && args.expectedObjectIdentity !== undefined) throw new Error("clip identity changed since preview");
        if (args.expectedClipAuthorityDigest !== clipAuthorityRevision) throw new Error("clip hierarchy changed since preview");
        const markers = [...(clip.warpMarkers ?? [])].sort((a, b) => a.beatTime - b.beatTime);
        if (args.expectedMarkerCollectionRevision !== simulatorRevision(markers)) throw new Error("warp-marker collection changed since preview");
        const beatTime = args.beatTime;
        if (typeof beatTime !== "number" || !Number.isFinite(beatTime)) throw new RangeError("beatTime is invalid");
        clip.warpMarkers = markers;
        if (operation === "audio.warp-marker.add") {
          if (beatTime < 0 || markers.some((marker) => marker.beatTime === beatTime)) throw new RangeError("a warp marker already exists at that beat time");
          clip.warpMarkers = [...markers, { beatTime, sampleTime: beatTime * 44100 }].sort((a, b) => a.beatTime - b.beatTime);
        } else if (operation === "audio.warp-marker.move") {
          const distance = args.distance;
          if (typeof distance !== "number" || !Number.isFinite(distance)) throw new RangeError("distance is invalid");
          const marker = markers.find((candidate) => candidate.beatTime === beatTime);
          if (!marker) throw new Error("no warp marker exists at that beat time");
          const target = beatTime + distance;
          if (target < 0 || markers.some((candidate) => candidate !== marker && candidate.beatTime === target)) throw new RangeError("warp-marker move target collides with an existing marker");
          marker.beatTime = target; marker.sampleTime = target * 44100;
          clip.warpMarkers = [...markers].sort((a, b) => a.beatTime - b.beatTime);
        } else {
          if (!markers.some((candidate) => candidate.beatTime === beatTime)) throw new Error("no warp marker exists at that beat time");
          clip.warpMarkers = markers.filter((candidate) => candidate.beatTime !== beatTime);
        }
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "session.audio-clip.create": {
        const track = this.findTrack(objectRef("trackRef"));
        const sceneIndex = args.sceneIndex;
        if (!track || !Number.isInteger(sceneIndex) || (sceneIndex as number) < 0) throw new Error("audio import target is invalid");
        const slot = (track.clipSlots ?? []).find((candidate) => candidate.sceneIndex === sceneIndex);
        const scene = this.state.scenes.find((candidate) => candidate.index === sceneIndex);
        if (!slot || !scene || args.expectedTrackIdentity !== track.objectIdentity || args.expectedSlotRef !== slot.ref || args.expectedSlotIdentity !== slot.objectIdentity || args.expectedSceneRef !== scene.ref || args.expectedSceneIdentity !== scene.objectIdentity) throw new Error("audio import target identity changed since preview");
        if (slot.clipRef) throw new Error("session slot is occupied");
        const filePath = args.filePath;
        if (typeof filePath !== "string" || filePath.length < 1 || filePath.length > 1024 || !(filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath))) throw new RangeError("filePath must be an absolute path");
        const name = args.name;
        if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 256)) throw new RangeError("name is invalid");
        const clip: Clip = { ref: ref("clip", `${track.ref}:${sceneIndex}`), objectIdentity: `simulator:clip:${this.sequence + 1}`, name: (name as string | undefined) ?? filePath.split("/").pop() ?? "Audio Clip", kind: "audio", start: (sceneIndex as number) * 4, length: 4, notes: [], notesRevision: simulatorRevision([]), warp: true, takes: [], automation: [], isAudio: true, filePath, muted: false, warpMarkers: [{ beatTime: 1, sampleTime: 44100 }] };
        track.clips.push(clip); slot.clipRef = clip.ref; slot.empty = false;
        this.emit({ type: "object", ref: track.ref, payload: { operation, clip } });
        return { ref: clip.ref, objectIdentity: clip.objectIdentity, name: clip.name, length: clip.length, filePath, createdFingerprint: simulatorRevision(clip) };
      }
      case "clip.action": {
        const clip = this.findClip(objectRef("ref"));
        if (clip.objectIdentity !== args.expectedObjectIdentity) throw new Error("clip identity changed since preview");
        const clipAuthorityRevision = clip.ref.startsWith("arrangement-clip:") ? arrangementAuthorityRevision(clip.ref) : simulatorRevision(this.sessionClipAuthority(clip.ref));
        if (args.expectedAuthorityRevision !== clipAuthorityRevision) throw new Error("clip hierarchy changed since preview");
        const clipStateRevision = simulatorRevision({ isPlaying: clip.isPlaying ?? null, playingPosition: clip.playingPosition ?? null, length: clip.length ?? null, loopStart: clip.loopStart ?? null, loopEnd: clip.loopEnd ?? null });
        if (args.expectedStateRevision !== clipStateRevision) throw new Error("clip state changed since preview");
        const action = args.action;
        if (["crop", "duplicate-loop", "duplicate-region"].includes(action as string) && args.expectedContentFingerprint !== simulatorRevision(clip)) throw new Error("clip content changed since preview");
        if (action === "crop") { clip.length = (clip.loopEnd ?? clip.length) - (clip.loopStart ?? 0); }
        else if (action === "duplicate-loop") { clip.length = clip.length * 2; }
        else if (action === "duplicate-region") {
          const start = args.regionStart; const end = args.regionEnd;
          if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof end !== "number" || !Number.isFinite(end) || end <= start) throw new RangeError("duplicate-region bounds are invalid");
          clip.length = clip.length + (end - start);
        } else if (action === "scrub-start") { const offset = args.offset; if (typeof offset !== "number" || !Number.isFinite(offset)) throw new RangeError("scrub position is invalid"); clip.playingPosition = offset; }
        else if (action === "scrub-stop") { clip.playingPosition = 0; }
        else if (action === "move-playing-position") { const offset = args.offset; if (typeof offset !== "number" || !Number.isFinite(offset)) throw new RangeError("playing-position offset is invalid"); clip.playingPosition = (clip.playingPosition ?? 0) + offset; }
        else throw new RangeError("clip action is invalid");
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "automation.envelope.clear": {
        const clip = this.findClip(objectRef("clipRef"));
        const clipAuthorityRevision = clip.ref.startsWith("arrangement-clip:") ? arrangementAuthorityRevision(clip.ref) : simulatorRevision(this.sessionClipAuthority(clip.ref));
        if (args.expectedAuthorityDigest !== clipAuthorityRevision) throw new Error("clip hierarchy changed since preview");
        const track = this.state.tracks.find((candidate) => candidate.clips.some((row) => row.ref === clip.ref));
        if (!track) throw new Error("envelope clear requires a Session clip");
        const walk = (devices: Device[]): Parameter[] => devices.flatMap((device) => [...(device.parameters ?? []), ...walk(device.chains?.flatMap((chain) => chain.devices ?? []) ?? []), ...walk(device.drumPads?.flatMap((pad) => pad.chains?.flatMap((chain) => chain.devices ?? []) ?? []) ?? [])]);
        const parameters: Array<{ ref: string }> = walk(track.devices ?? []);
        if (track.mixer) for (const ref of [track.mixer.volumeRef, track.mixer.panRef, track.mixer.cueRef, ...track.mixer.sendRefs]) if (ref) parameters.push({ ref });
        const presence = parameters.map((parameter) => (clip.envelopes ?? {})[parameter.ref] !== undefined);
        if (args.expectedEnvelopesRevision !== simulatorRevision(presence)) throw new Error("clip envelope collection changed since preview");
        const cleared = presence.filter(Boolean).length;
        clip.envelopes = {};
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { cleared, envelopesRevision: simulatorRevision(parameters.map(() => false)) };
      }
      case "note.read-by-id": {
        const clip = this.findClip(objectRef("ref"));
        const noteIds = args.noteIds;
        if (!Array.isArray(noteIds) || noteIds.length < 1 || noteIds.length > 1024 || !noteIds.every((value) => Number.isInteger(value) && (value as number) >= 0)) throw new RangeError("note ids are invalid");
        const wanted = new Set(noteIds as number[]);
        return { notes: clip.notes.filter((note) => wanted.has(note.id as number)), notesRevision: clip.notesRevision ?? simulatorRevision(clip.notes) };
      }
      case "note.read-selected": {
        const clip = this.findClip(objectRef("ref"));
        return { available: true, notes: clip.notes.slice(0, 0), notesRevision: clip.notesRevision ?? simulatorRevision(clip.notes) };
      }
      case "note.duplicate": {
        const clip = this.findClip(objectRef("ref"));
        const noteIds = args.noteIds;
        if (simulatorCanonical(this.sessionClipAuthority(clip.ref)) !== simulatorCanonical(args.expectedClipAuthority)) throw new Error("note clip hierarchy identity changed since preview");
        if (args.expectedNotesRevision !== (clip.notesRevision ?? simulatorRevision(clip.notes))) throw new Error("clip notes changed since preview");
        if (!Array.isArray(noteIds) || noteIds.length < 1 || noteIds.length > 512 || new Set(noteIds).size !== noteIds.length || !noteIds.every((value) => Number.isInteger(value) && (value as number) >= 0)) throw new RangeError("note ids are invalid");
        const wanted = new Set(noteIds as number[]);
        const sources = clip.notes.filter((note) => wanted.has(note.id as number));
        if (sources.length !== wanted.size) throw new Error("complete stable note identity is required for duplication");
        let nextId = Math.max(0, ...clip.notes.map((note) => (note.id as number) ?? 0)) + 1;
        for (const source of sources) clip.notes.push({ ...structuredClone(source), id: nextId++ });
        clip.notesRevision = simulatorRevision(clip.notes);
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { duplicated: sources.length, notesRevision: clip.notesRevision };
      }
      case "note.quantize": {
        const clip = this.findClip(objectRef("ref"));
        if (simulatorCanonical(this.sessionClipAuthority(clip.ref)) !== simulatorCanonical(args.expectedClipAuthority)) throw new Error("note clip hierarchy identity changed since preview");
        if (args.expectedNotesRevision !== (clip.notesRevision ?? simulatorRevision(clip.notes))) throw new Error("clip notes changed since preview");
        const grid = args.grid; const amount = args.amount;
        if (typeof grid !== "number" || !Number.isFinite(grid) || grid <= 0 || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1) throw new RangeError("quantize arguments are invalid");
        const pitch = args.pitch;
        if (pitch !== undefined && (!Number.isInteger(pitch) || (pitch as number) < 0 || (pitch as number) > 127)) throw new RangeError("pitch is invalid");
        for (const note of clip.notes) {
          note.start = Math.round(note.start / grid) * grid * amount + note.start * (1 - amount);
          if (pitch !== undefined) note.pitch = pitch as number;
        }
        clip.notesRevision = simulatorRevision(clip.notes);
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { changed: true, notesRevision: clip.notesRevision };
      }
      case "audio.take-lane.read": {
        const track = this.findTrack(objectRef("trackRef"));
        return { lanes: (track?.takeLanes ?? []).map((lane) => ({ ref: lane.ref, name: lane.name })) };
      }
      case "take-lane.create": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track || args.expectedTrackIdentity !== track.objectIdentity) throw new Error("take-lane target track identity changed since preview");
        const lanes = track.takeLanes ?? [];
        const siblings = lanes.map((lane) => ({ ref: lane.ref, objectIdentity: lane.objectIdentity, name: lane.name }));
        if (args.expectedTakeLaneCollectionRevision !== simulatorRevision(siblings)) throw new Error("take-lane collection changed since preview");
        const name = args.name;
        if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 256)) throw new RangeError("name is invalid");
        const lane: TakeLane = { ref: ref("take-lane", `${track.ref}:${lanes.length}`), objectIdentity: `simulator:take-lane:${this.sequence + 1}`, parentRef: track.ref, trackRef: track.ref, name: (name as string | undefined) ?? `Take ${lanes.length + 1}`, index: lanes.length, clips: [] };
        track.takeLanes = [...lanes, lane];
        this.emit({ type: "object", ref: track.ref, payload: { operation, lane } });
        return { ref: lane.ref, objectIdentity: lane.objectIdentity, name: lane.name, index: lane.index, createdFingerprint: simulatorRevision({ ref: lane.ref, objectIdentity: lane.objectIdentity, name: lane.name, index: lane.index }) };
      }
      case "take-lane.rename": {
        const found = this.findTakeLane(objectRef("ref"));
        if (!found) throw new Error("take-lane reference is stale or invalid");
        const name = args.name;
        if (typeof name !== "string" || name.length < 1 || name.length > 256) throw new RangeError("name is invalid");
        if (found.lane.objectIdentity !== args.expectedObjectIdentity || found.lane.name !== args.expectedName) throw new Error("take-lane rename target changed since preview");
        const siblings = (found.track.takeLanes ?? []).map((lane) => ({ ref: lane.ref, objectIdentity: lane.objectIdentity, name: lane.name }));
        if (args.expectedAuthorityRevision !== simulatorRevision(siblings)) throw new Error("take-lane hierarchy changed since preview");
        found.lane.name = name;
        this.emit({ type: "object", ref: found.lane.ref, payload: { operation } });
        return { renamed: found.lane.ref, name };
      }
      case "take-lane.clip.create":
      case "take-lane.audio-clip.create": {
        const found = this.findTakeLane(objectRef("takeLaneRef"));
        if (!found) throw new Error("take-lane reference is stale or invalid");
        if (found.lane.objectIdentity !== args.expectedTakeLaneIdentity) throw new Error("take-lane identity changed since preview");
        const siblings = found.lane.clips.map((clip) => ({ ref: clip.ref, objectIdentity: clip.objectIdentity }));
        if (args.expectedCollectionRevision !== simulatorRevision(siblings)) throw new Error("take-lane clip collection changed since preview");
        const audio = operation === "take-lane.audio-clip.create";
        const position = args.position;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) throw new RangeError("position is invalid");
        const name = args.name;
        let filePath: string | undefined;
        let length = 4;
        if (audio) {
          filePath = args.filePath as string;
          if (typeof filePath !== "string" || filePath.length < 1 || filePath.length > 1024 || !(filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath))) throw new RangeError("filePath must be an absolute path");
          if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 256)) throw new RangeError("name is invalid");
        } else {
          length = args.length as number;
          if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) throw new RangeError("length is invalid");
          if (typeof name !== "string" || name.length < 1 || name.length > 256) throw new RangeError("name is invalid");
        }
        const clipName = audio ? ((name as string | undefined) ?? filePath!.split("/").pop() ?? "Audio Clip") : (name as string);
        const clip: Clip = { ref: ref("take-lane-clip", `${found.lane.ref}:${position}`), objectIdentity: `simulator:take-lane-clip:${this.sequence + 1}`, name: clipName, kind: audio ? "audio" : "midi", start: position, length, notes: [], notesRevision: simulatorRevision([]), warp: audio, takes: [], automation: [], isAudio: audio, ...(audio ? { filePath } : {}), muted: false, isTakeLaneClip: true };
        found.lane.clips.push(clip);
        this.emit({ type: "object", ref: found.lane.ref, payload: { operation, clip } });
        const result: Record<string, unknown> = { ref: clip.ref, objectIdentity: clip.objectIdentity, name: clip.name, start: position, length, createdFingerprint: simulatorRevision(clip) };
        if (audio) result.filePath = filePath;
        return result;
      }
      case "tuning.read": {
        const state = this.state.tuning!;
        return { tuningSystem: structuredClone(state.system), scale: structuredClone(state.scale), revision: simulatorRevision(state) };
      }
      case "tuning.set": {
        if (args.setRef !== this.state.set.ref || args.expectedObjectIdentity !== this.state.set.objectIdentity) throw new Error("Set identity changed since preview");
        if (args.expectedRevision !== simulatorRevision(this.state.tuning)) throw new Error("tuning or scale state changed since preview");
        const tuning = this.state.tuning!;
        if (args.name !== undefined) { if (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 256) throw new RangeError("name is invalid"); tuning.system.name = args.name; }
        if (args.lowestNote !== undefined || args.highestNote !== undefined) {
          const low = (args.lowestNote ?? tuning.system.lowestNote) as number; const high = (args.highestNote ?? tuning.system.highestNote) as number;
          if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high > 127 || low > high) throw new RangeError("tuning note range is invalid");
          tuning.system.lowestNote = low; tuning.system.highestNote = high;
        }
        if (args.referencePitch !== undefined) { const value = args.referencePitch; if (typeof value !== "number" || !Number.isFinite(value) || value < 20 || value > 20000) throw new RangeError("referencePitch is invalid"); tuning.system.referencePitch = value; }
        if (args.noteTunings !== undefined) {
          const rows = args.noteTunings;
          if (!Array.isArray(rows) || rows.length !== 128 || !rows.every((row) => Number.isInteger((row as { note?: unknown }).note) && ((row as { note: number }).note >= 0) && ((row as { note: number }).note <= 127) && typeof (row as { deviation?: unknown }).deviation === "number" && Number.isFinite((row as { deviation: number }).deviation) && Math.abs((row as { deviation: number }).deviation) <= 1200)) throw new RangeError("noteTunings must contain exactly 128 valid entries");
          if (new Set(rows.map((row) => (row as { note: number }).note)).size !== 128) throw new RangeError("noteTunings notes are invalid");
          tuning.system.noteTunings = structuredClone(rows) as Array<{ note: number; deviation: number }>;
        }
        if (args.rootNote !== undefined) { if (!Number.isInteger(args.rootNote) || (args.rootNote as number) < 0 || (args.rootNote as number) > 11) throw new RangeError("rootNote is invalid"); tuning.scale.rootNote = args.rootNote as number; }
        if (args.scaleName !== undefined) { if (typeof args.scaleName !== "string" || args.scaleName.length < 1 || args.scaleName.length > 256) throw new RangeError("scaleName is invalid"); tuning.scale.scaleName = args.scaleName; }
        if (args.scaleMode !== undefined) { if (typeof args.scaleMode !== "string" || args.scaleMode.length < 1 || args.scaleMode.length > 256) throw new RangeError("scaleMode is invalid"); tuning.scale.scaleMode = args.scaleMode; }
        if (args.scaleIntervals !== undefined) { const rows = args.scaleIntervals; if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32 || !rows.every((value) => Number.isInteger(value) && (value as number) >= -24 && (value as number) <= 24)) throw new RangeError("scaleIntervals are invalid"); tuning.scale.scaleIntervals = [...(rows as number[])]; }
        this.emit({ type: "state", payload: { operation } });
        return { changed: true, revision: simulatorRevision(this.state.tuning) };
      }
      case "groove.read": {
        const pool = this.state.groovePool!;
        return { grooveAmount: pool.amount, grooves: structuredClone(pool.grooves), revision: simulatorRevision(pool) };
      }
      case "groove.set": {
        if (args.setRef !== this.state.set.ref || args.expectedObjectIdentity !== this.state.set.objectIdentity) throw new Error("Set identity changed since preview");
        if (args.expectedRevision !== simulatorRevision(this.state.groovePool)) throw new Error("groove state changed since preview");
        const value = args.grooveAmount;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1.3) throw new RangeError("grooveAmount is invalid");
        this.state.groovePool!.amount = value;
        this.emit({ type: "state", payload: { operation } });
        return { changed: true, revision: simulatorRevision(this.state.groovePool) };
      }
      case "groove.edit": {
        const groove = this.state.groovePool!.grooves.find((candidate) => candidate.ref === objectRef("ref"));
        if (!groove) throw new Error("groove reference is stale or invalid");
        if (groove.objectIdentity !== args.expectedObjectIdentity) throw new Error("groove identity changed since preview");
        if (args.expectedRevision !== simulatorRevision(this.state.groovePool)) throw new Error("groove state changed since preview");
        if (args.name !== undefined) { if (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 256) throw new RangeError("name is invalid"); groove.name = args.name; }
        if (args.base !== undefined) { if (!Number.isInteger(args.base) || (args.base as number) < 0 || (args.base as number) > 16) throw new RangeError("base is invalid"); groove.base = args.base as number; }
        for (const field of ["quantizationAmount", "randomAmount", "timingAmount", "velocityAmount"] as const) {
          if (args[field] !== undefined) { const value = args[field]; if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${field} is invalid`); (groove as unknown as Record<string, unknown>)[field] = value; }
        }
        this.emit({ type: "object", ref: groove.ref, payload: { operation } });
        return { changed: true, revision: simulatorRevision(this.state.groovePool) };
      }
      case "scene.set": {
        const scene = this.state.scenes.find((candidate) => candidate.ref === objectRef("ref"));
        if (!scene) throw new Error("scene reference is stale or invalid");
        if (scene.objectIdentity !== args.expectedObjectIdentity) throw new Error("scene identity changed since preview");
        const siblings = this.state.scenes.map((candidate) => ({ ref: candidate.ref, objectIdentity: candidate.objectIdentity, name: candidate.name, colorIndex: candidate.colorIndex ?? null, tempo: candidate.tempo ?? null, tempoEnabled: candidate.tempoEnabled ?? null, signatureNumerator: candidate.signatureNumerator ?? null, signatureDenominator: candidate.signatureDenominator ?? null, timeSignatureEnabled: candidate.timeSignatureEnabled ?? null }));
        if (args.expectedAuthorityRevision !== simulatorRevision(siblings)) throw new Error("scene collection changed since preview");
        const state = { colorIndex: scene.colorIndex ?? null, tempo: scene.tempo ?? null, tempoEnabled: scene.tempoEnabled ?? null, signatureNumerator: scene.signatureNumerator ?? null, signatureDenominator: scene.signatureDenominator ?? null, timeSignatureEnabled: scene.timeSignatureEnabled ?? null };
        if (args.expectedStateRevision !== simulatorRevision(state)) throw new Error("scene state changed since preview");
        if (args.colorIndex !== undefined) { if (!Number.isInteger(args.colorIndex) || (args.colorIndex as number) < 0 || (args.colorIndex as number) > 69) throw new RangeError("colorIndex is invalid"); scene.colorIndex = args.colorIndex as number; }
        if (args.tempo !== undefined) { const value = args.tempo; if (typeof value !== "number" || !Number.isFinite(value) || value < 20 || value > 999) throw new RangeError("tempo is invalid"); scene.tempo = value; }
        if (args.tempoEnabled !== undefined) { if (typeof args.tempoEnabled !== "boolean") throw new TypeError("tempoEnabled is invalid"); scene.tempoEnabled = args.tempoEnabled; }
        if (args.signatureNumerator !== undefined) { if (!Number.isInteger(args.signatureNumerator) || (args.signatureNumerator as number) < 1 || (args.signatureNumerator as number) > 99) throw new RangeError("signatureNumerator is invalid"); scene.signatureNumerator = args.signatureNumerator as number; }
        if (args.signatureDenominator !== undefined) { if (!Number.isInteger(args.signatureDenominator) || (args.signatureDenominator as number) < 1 || (args.signatureDenominator as number) > 99) throw new RangeError("signatureDenominator is invalid"); scene.signatureDenominator = args.signatureDenominator as number; }
        if (args.timeSignatureEnabled !== undefined) { if (typeof args.timeSignatureEnabled !== "boolean") throw new TypeError("timeSignatureEnabled is invalid"); scene.timeSignatureEnabled = args.timeSignatureEnabled; }
        this.emit({ type: "object", ref: scene.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "scene.fire-selected": {
        const scene = this.state.scenes.find((candidate) => candidate.ref === objectRef("ref"));
        if (!scene) throw new Error("scene reference is stale or invalid");
        if (scene.objectIdentity !== args.expectedObjectIdentity) throw new Error("scene identity changed since preview");
        const siblings = this.state.scenes.map((candidate) => ({ ref: candidate.ref, objectIdentity: candidate.objectIdentity, name: candidate.name, colorIndex: candidate.colorIndex ?? null, tempo: candidate.tempo ?? null, tempoEnabled: candidate.tempoEnabled ?? null, signatureNumerator: candidate.signatureNumerator ?? null, signatureDenominator: candidate.signatureDenominator ?? null, timeSignatureEnabled: candidate.timeSignatureEnabled ?? null }));
        if (args.expectedAuthorityRevision !== simulatorRevision(siblings)) throw new Error("scene collection changed since preview");
        const state = { isTriggered: scene.isTriggered ?? null, playing: this.state.playback.transport.playing };
        if (args.expectedStateRevision !== simulatorRevision(state)) throw new Error("scene fire state changed since preview");
        scene.isTriggered = true; this.state.playback.transport.playing = true; this.state.set.playing = true;
        this.emit({ type: "transport", payload: { operation } });
        return { fired: true };
      }
      case "song.read": {
        const state = structuredClone(this.state.song!);
        return { ...state, revision: simulatorRevision(state) };
      }
      case "song.time-convert": {
        if (args.setRef !== this.state.set.ref) throw new Error("set reference is stale or invalid");
        const tempo = this.state.set.tempo;
        if (typeof tempo !== "number" || !Number.isFinite(tempo) || tempo < 20 || tempo > 999) throw new Error("tempo is unavailable for time conversion");
        const beats = args.smpteSeconds !== undefined ? (args.smpteSeconds as number) * tempo / 60 : null;
        const smpteSeconds = args.beatTime !== undefined ? (args.beatTime as number) * 60 / tempo : null;
        const loopLength = this.state.playback.transport.loop?.length ?? null;
        return { available: true, beats, smpteSeconds, loopBeats: loopLength, loopSmpteSeconds: loopLength !== null ? loopLength * 60 / tempo : null };
      }
      case "transport.action": {
        if (args.setRef !== this.state.set.ref || args.expectedObjectIdentity !== this.state.set.objectIdentity) throw new Error("Set identity changed since preview");
        if (args.expectedRevision !== this.state.playback.revision) throw new Error("transport state changed since preview");
        const action = args.action;
        const transport = this.state.playback.transport;
        if (action === "start" || action === "continue" || action === "play-selection") { transport.playing = true; this.state.set.playing = true; }
        else if (action === "stop") { transport.playing = false; this.state.set.playing = false; }
        else if (action === "force-link-beat-time") { if (typeof args.beatTime !== "number" || !Number.isFinite(args.beatTime)) throw new RangeError("beatTime is required for force-link-beat-time"); transport.position = args.beatTime; this.state.set.position = args.beatTime; }
        else if (action === "stop-all-clips") { for (const track of this.state.tracks) { track.playingSlotIndex = null; track.firedSlotIndex = null; } transport.playing = false; this.state.set.playing = false; }
        else if (!["scrub", "tap-tempo", "nudge-up", "nudge-down", "re-enable-automation", "trigger-session-record"].includes(action as string)) throw new RangeError("transport action is invalid");
        this.state.playback.revision = `${this.epoch}:transport:${++this.sequence}`;
        this.emit({ type: "transport", payload: { operation } });
        return { done: true, revision: this.state.playback.revision };
      }
      case "locator.jump-to": {
        const locator = this.state.arrangement.locators.find((candidate) => candidate.ref === objectRef("ref"));
        if (!locator) throw new Error("locator reference is stale or invalid");
        if (locator.objectIdentity !== args.expectedObjectIdentity) throw new Error("locator identity changed since preview");
        if (args.expectedCollectionRevision !== simulatorRevision(this.state.arrangement.locators)) throw new Error("locator collection changed since preview");
        this.state.playback.transport.position = locator.position; this.state.set.position = locator.position;
        this.emit({ type: "transport", payload: { operation } });
        return { position: locator.position };
      }
      case "track.create-return": {
        if (args.expectedStructureRevision !== structureRevision()) throw new Error("structure changed since preview");
        const name = args.name;
        if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 256)) throw new RangeError("name is invalid");
        const index = this.state.tracks.filter((track) => track.kind === "return").length;
        const track: Track = { ref: ref("track", `return-${this.sequence + 1}`), objectIdentity: `simulator:track:${this.sequence + 1}`, name: (name as string | undefined) ?? `Return ${String.fromCharCode(65 + index)}`, kind: "return", volume: 0.85, pan: 0, mute: false, solo: false, armed: null, clips: [], devices: [], sends: [] };
        this.state.tracks.push(track);
        this.emit({ type: "state", payload: { operation } });
        return { ref: track.ref, objectIdentity: track.objectIdentity, name: track.name, index, createdFingerprint: simulatorRevision({ ref: track.ref, objectIdentity: track.objectIdentity, name: track.name, index }) };
      }
      case "track.delete-return": {
        const track = this.state.tracks.find((candidate) => candidate.ref === objectRef("ref") && candidate.kind === "return");
        if (!track) throw new Error("return-track reference is stale or invalid");
        if (args.expectedStructureRevision !== structureRevision()) throw new Error("structure changed since preview");
        if (track.objectIdentity !== args.expectedObjectIdentity) throw new Error("return-track identity changed since preview");
        this.state.tracks = this.state.tracks.filter((candidate) => candidate !== track);
        this.emit({ type: "state", payload: { operation } });
        return { deleted: objectRef("ref") };
      }
      case "track.duplicate": {
        const index = this.state.tracks.findIndex((candidate) => candidate.ref === objectRef("ref"));
        const track = this.state.tracks[index];
        if (!track) throw new Error("track reference is stale or invalid");
        if (args.expectedStructureRevision !== structureRevision()) throw new Error("structure changed since preview");
        if (track.objectIdentity !== args.expectedObjectIdentity) throw new Error("track identity changed since preview");
        const copy: Track = { ...structuredClone(track), ref: ref("track", `track-${this.sequence + 1}`), objectIdentity: `simulator:track:${this.sequence + 1}`, name: `${track.name} copy` };
        this.state.tracks.splice(index + 1, 0, copy);
        this.emit({ type: "state", payload: { operation } });
        return { ref: copy.ref, objectIdentity: copy.objectIdentity, name: copy.name, index: index + 1, createdFingerprint: simulatorRevision({ ref: copy.ref, objectIdentity: copy.objectIdentity, name: copy.name, index: index + 1 }) };
      }
      case "scene.duplicate": {
        const index = this.state.scenes.findIndex((candidate) => candidate.ref === objectRef("ref"));
        const scene = this.state.scenes[index];
        if (!scene) throw new Error("scene reference is stale or invalid");
        if (args.expectedStructureRevision !== structureRevision()) throw new Error("structure changed since preview");
        if (scene.objectIdentity !== args.expectedObjectIdentity) throw new Error("scene identity changed since preview");
        const copy: Scene = { ...structuredClone(scene), ref: ref("scene", `scene-${this.sequence + 1}`), objectIdentity: `simulator:scene:${this.sequence + 1}`, name: `${scene.name} copy`, index: index + 1 };
        this.state.scenes.splice(index + 1, 0, copy);
        this.state.scenes.forEach((candidate, position) => { candidate.index = position; });
        this.emit({ type: "state", payload: { operation } });
        return { ref: copy.ref, objectIdentity: copy.objectIdentity, name: copy.name, index: index + 1, createdFingerprint: simulatorRevision({ ref: copy.ref, objectIdentity: copy.objectIdentity, name: copy.name, index: index + 1 }) };
      }
      case "track.view.set": {
        const track = this.findTrack(objectRef("ref"));
        if (!track) throw new Error("track reference is stale or invalid");
        if (track.objectIdentity !== args.expectedObjectIdentity) throw new Error("track identity changed since preview");
        const state = { collapsed: track.view?.isCollapsed ?? null, deviceInsertMode: track.view?.deviceInsertMode ?? null };
        if (args.expectedStateRevision !== simulatorRevision(state)) throw new Error("track view state changed since preview");
        track.view = track.view ?? {};
        if (args.collapsed !== undefined) { if (typeof args.collapsed !== "boolean") throw new TypeError("collapsed is invalid"); track.view.isCollapsed = args.collapsed; }
        if (args.deviceInsertMode !== undefined) { if (!Number.isInteger(args.deviceInsertMode) || (args.deviceInsertMode as number) < 0 || (args.deviceInsertMode as number) > 8) throw new RangeError("deviceInsertMode is invalid"); track.view.deviceInsertMode = args.deviceInsertMode as number; }
        this.emit({ type: "object", ref: track.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "track.select-instrument": {
        const track = this.findTrack(objectRef("ref"));
        if (!track) throw new Error("track reference is stale or invalid");
        if (track.objectIdentity !== args.expectedObjectIdentity) throw new Error("track identity changed since preview");
        const state = { collapsed: track.view?.isCollapsed ?? null, deviceInsertMode: track.view?.deviceInsertMode ?? null };
        if (args.expectedStateRevision !== simulatorRevision(state)) throw new Error("track view state changed since preview");
        const firstInstrument = (track.devices ?? [])[0];
        track.view = track.view ?? {};
        track.view.selectedDeviceRef = firstInstrument?.ref ?? null;
        this.emit({ type: "object", ref: track.ref, payload: { operation } });
        return { done: true };
      }
      case "selection.set": {
        const selection = this.state.selection!;
        if (args.expectedStateRevision !== simulatorRevision(selection)) throw new Error("selection state changed since preview");
        if (args.trackRef !== undefined) { if (args.trackRef !== null && !this.state.tracks.some((track) => track.ref === args.trackRef)) throw new Error("track reference is stale or invalid"); selection.trackRef = args.trackRef as LiveRef | null; }
        if (args.sceneRef !== undefined) { if (args.sceneRef !== null && !this.state.scenes.some((scene) => scene.ref === args.sceneRef)) throw new Error("scene reference is stale or invalid"); selection.sceneRef = args.sceneRef as LiveRef | null; }
        if (args.slotRef !== undefined) { if (args.slotRef !== null && !this.state.tracks.some((track) => (track.clipSlots ?? []).some((slot) => slot.ref === args.slotRef))) throw new Error("clip-slot reference is stale or invalid"); selection.slotRef = args.slotRef as LiveRef | null; }
        if (args.detailClipRef !== undefined) { if (args.detailClipRef !== null && !this.state.tracks.some((track) => track.clips.some((clip) => clip.ref === args.detailClipRef))) throw new Error("clip reference is stale or invalid"); selection.detailClipRef = args.detailClipRef as LiveRef | null; }
        if (args.deviceRef !== undefined) { if (args.deviceRef !== null && !this.state.tracks.some((track) => track.devices.some((device) => device.ref === args.deviceRef))) throw new Error("device reference is stale or invalid"); selection.deviceRef = args.deviceRef as LiveRef | null; }
        if (args.parameterRef !== undefined) { if (args.parameterRef !== null && !this.state.tracks.some((track) => track.devices.some((device) => device.parameters.some((parameter) => parameter.ref === args.parameterRef)))) throw new Error("parameter reference is stale or invalid"); selection.parameterRef = args.parameterRef as LiveRef | null; }
        if (args.chainRef !== undefined) { if (args.chainRef !== null) throw new Error("chain reference is stale or invalid"); selection.chainRef = null; }
        this.emit({ type: "state", payload: { operation } });
        return { changed: true, revision: simulatorRevision(selection) };
      }
      case "song.view.set": {
        if (args.expectedStateRevision !== simulatorRevision({ drawMode: this.state.view?.drawMode ?? null })) throw new Error("song view state changed since preview");
        if (typeof args.drawMode !== "boolean") throw new TypeError("drawMode is invalid");
        this.state.view = { ...(this.state.view ?? { visibleView: "Session", follow: false }), drawMode: args.drawMode };
        this.emit({ type: "state", payload: { operation } });
        return { changed: true, revision: simulatorRevision({ drawMode: this.state.view.drawMode }) };
      }
      case "clip.view.set": {
        const clip = this.findClip(objectRef("ref"));
        if (clip.objectIdentity !== args.expectedObjectIdentity) throw new Error("clip identity changed since preview");
        const state = { gridQuantization: clip.clipView?.gridQuantization ?? null, tripletGrid: clip.clipView?.tripletGrid ?? null, showEnvelope: clip.clipView?.showEnvelope ?? null };
        if (args.expectedStateRevision !== simulatorRevision(state)) throw new Error("clip view state changed since preview");
        clip.clipView = clip.clipView ?? {};
        if (args.gridQuantization !== undefined) { if (!Number.isInteger(args.gridQuantization) || (args.gridQuantization as number) < 0 || (args.gridQuantization as number) > 16) throw new RangeError("gridQuantization is invalid"); clip.clipView.gridQuantization = args.gridQuantization as number; }
        if (args.tripletGrid !== undefined) { if (typeof args.tripletGrid !== "boolean") throw new TypeError("tripletGrid is invalid"); clip.clipView.tripletGrid = args.tripletGrid; }
        if (args.showEnvelope !== undefined) { if (typeof args.showEnvelope !== "boolean") throw new TypeError("showEnvelope is invalid"); clip.clipView.showEnvelope = args.showEnvelope; }
        this.emit({ type: "object", ref: clip.ref, payload: { operation, showLoop: args.showLoop === true } });
        return { changed: true, revision: ++this.sequence };
      }
      case "device.view.set": {
        const device = this.state.tracks.flatMap((track) => track.devices).find((candidate) => candidate.ref === objectRef("ref"));
        if (!device) throw new Error("device reference is stale or invalid");
        if (device.objectIdentity !== args.expectedObjectIdentity) throw new Error("device identity changed since preview");
        if (args.expectedStateRevision !== simulatorRevision({ collapsed: device.view?.isCollapsed ?? null })) throw new Error("device view state changed since preview");
        if (typeof args.collapsed !== "boolean") throw new TypeError("collapsed is invalid");
        device.view = { ...(device.view ?? {}), isCollapsed: args.collapsed };
        this.emit({ type: "object", ref: device.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "application.dialog": {
        if (args.action === "read") return { state: 0, done: true };
        if (args.action !== "press") throw new RangeError("dialog action is invalid");
        if (!Number.isInteger(args.button) || (args.button as number) < 0 || (args.button as number) > 16) throw new RangeError("dialog button is invalid");
        if (args.expectedState !== 0) throw new Error("dialog state changed since preview");
        return { state: 0, done: true };
      }
      case "performance.read": {
        const tracks = this.state.tracks.map((track) => ({
          ref: track.ref,
          performanceImpact: track.performanceImpact ?? null,
          inputMeterLeft: track.inputMeterLeft ?? null, inputMeterRight: track.inputMeterRight ?? null, inputMeterLevel: track.inputMeterLevel ?? null,
          outputMeterLeft: track.outputMeterLeft ?? null, outputMeterRight: track.outputMeterRight ?? null, outputMeterLevel: track.outputMeterLevel ?? null,
          devices: track.devices.map((device) => ({ ref: device.ref, latencySamples: device.latencySamples ?? null, latencyMs: device.latencyMs ?? null })),
        }));
        const state = { averageProcessUsage: 0.42, peakProcessUsage: 0.87, tracks };
        return { ...state, sampledAt: Date.now(), revision: simulatorRevision(state) };
      }
      case "mixer.extended.set": {
        const track = this.findTrack(objectRef("ref"));
        if (!track?.mixer) throw new Error("mixer is unavailable");
        const mixer = track.mixer;
        if (track.objectIdentity !== args.expectedObjectIdentity) throw new Error("track identity changed since preview");
        if (args.expectedMixerIdentity !== (mixer as unknown as { mixerIdentity?: string }).mixerIdentity && args.expectedMixerIdentity !== "simulator") throw new Error("mixer identity changed since preview");
        const state = { crossfadeAssign: mixer.crossfadeAssign ?? null, panningMode: mixer.panningMode ?? null };
        if (args.expectedStateRevision !== simulatorRevision(state)) throw new Error("extended mixer state changed since preview");
        if (args.trackActivator !== undefined) { if (typeof args.trackActivator !== "boolean") throw new TypeError("trackActivator is invalid"); (mixer as unknown as Record<string, unknown>).trackActivator = args.trackActivator; }
        if (args.crossfader !== undefined) { const value = args.crossfader; if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) throw new RangeError("crossfader is invalid"); (mixer as unknown as Record<string, unknown>).crossfader = value; }
        if (args.crossfadeAssign !== undefined) { if (!Number.isInteger(args.crossfadeAssign) || (args.crossfadeAssign as number) < 0 || (args.crossfadeAssign as number) > 2) throw new RangeError("crossfadeAssign is invalid"); mixer.crossfadeAssign = args.crossfadeAssign as number; }
        if (args.panningMode !== undefined) { if (!Number.isInteger(args.panningMode) || (args.panningMode as number) < 0 || (args.panningMode as number) > 8) throw new RangeError("panningMode is invalid"); mixer.panningMode = args.panningMode as number; }
        if (args.panningLeft !== undefined) { const value = args.panningLeft; if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) throw new RangeError("panningLeft is invalid"); (mixer as unknown as Record<string, unknown>).panningLeft = value; }
        if (args.panningRight !== undefined) { const value = args.panningRight; if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) throw new RangeError("panningRight is invalid"); (mixer as unknown as Record<string, unknown>).panningRight = value; }
        this.emit({ type: "object", ref: track.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "chain-mixer.set": {
        const found = this.findChain(objectRef("ref"));
        if (!found) throw new Error("chain reference is stale or invalid");
        const mixer = found.chain.mixer;
        if (!mixer) throw new Error("chain mixer is unavailable");
        if (found.chain.objectIdentity !== args.expectedObjectIdentity) throw new Error("chain identity changed since preview");
        if (args.expectedMixerIdentity !== mixer.mixerIdentity) throw new Error("chain mixer identity changed since preview");
        if (args.expectedStateRevision !== simulatorRevision({ sends: mixer.sends })) throw new Error("chain mixer state changed since preview");
        if (args.volume !== undefined) { const value = args.volume; if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("volume is invalid"); mixer.volume = value; }
        if (args.pan !== undefined) { const value = args.pan; if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) throw new RangeError("pan is invalid"); mixer.pan = value; }
        if (args.sends !== undefined) { const values = args.sends; if (!Array.isArray(values) || values.length > mixer.sends.length || !values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError("sends are invalid"); (values as number[]).forEach((value, index) => { mixer.sends[index] = value; }); }
        if (args.chainActivator !== undefined) { if (typeof args.chainActivator !== "boolean") throw new TypeError("chainActivator is invalid"); (mixer as unknown as Record<string, unknown>).chainActivator = args.chainActivator; }
        this.emit({ type: "object", ref: found.chain.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "device-io.set": {
        const device = this.state.tracks.flatMap((track) => track.devices).find((candidate) => candidate.ref === objectRef("ref"));
        if (!device) throw new Error("device reference is stale or invalid");
        if (device.objectIdentity !== args.expectedObjectIdentity) throw new Error("device identity changed since preview");
        const io = (device as unknown as { deviceIo?: { routingType: string; routingChannel: string } }).deviceIo;
        if (!io) throw new Error("device IO is unavailable on this shape");
        if (args.expectedStateRevision !== simulatorRevision({ routingType: io.routingType, routingChannel: io.routingChannel })) throw new Error("device IO state changed since preview");
        if (args.routingType !== undefined) { if (typeof args.routingType !== "string" || args.routingType.length < 1) throw new RangeError("routingType is invalid"); io.routingType = args.routingType; }
        if (args.routingChannel !== undefined) { if (typeof args.routingChannel !== "string" || args.routingChannel.length < 1) throw new RangeError("routingChannel is invalid"); io.routingChannel = args.routingChannel; }
        this.emit({ type: "object", ref: device.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "compressor.sidechain.set": {
        const device = this.state.tracks.flatMap((track) => track.devices).find((candidate) => candidate.ref === objectRef("ref"));
        if (!device) throw new Error("device reference is stale or invalid");
        if (device.objectIdentity !== args.expectedObjectIdentity) throw new Error("device identity changed since preview");
        const sidechain = (device as unknown as { sidechainRoutingType?: string }).sidechainRoutingType;
        if (sidechain === undefined) throw new Error("sidechain routing is unavailable on this device shape");
        if (args.expectedStateRevision !== simulatorRevision({ routingType: sidechain })) throw new Error("sidechain state changed since preview");
        if (typeof args.routingType !== "string" || args.routingType.length < 1) throw new RangeError("routingType is invalid");
        (device as unknown as { sidechainRoutingType?: string }).sidechainRoutingType = args.routingType;
        this.emit({ type: "object", ref: device.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "locator.jump": {
        const direction = args.direction;
        if (direction !== "next" && direction !== "previous") throw new RangeError("locator jump direction is invalid");
        const before = this.state.playback.transport.position ?? 0;
        const times = this.state.arrangement.locators.map((locator) => locator.position).sort((a, b) => a - b);
        const target = direction === "next" ? times.find((time) => time > before + 1e-9) : [...times].reverse().find((time) => time < before - 1e-9);
        this.state.playback.transport.position = target ?? before;
        this.state.set.position = this.state.playback.transport.position;
        this.emit({ type: "transport", payload: { operation } });
        return { direction, before, position: this.state.playback.transport.position };
      }
      case "view.set": {
        const view = args.view;
        if (typeof view !== "string" || view.length < 1 || view.length > 64) throw new RangeError("view is invalid");
        this.state.view = { visibleView: view, follow: this.state.view?.follow ?? false };
        this.emit({ type: "state", payload: { operation } });
        return { view, visible: true };
      }
      case "view.control": {
        const action = args.action;
        const actions = ["zoom-in", "zoom-out", "scroll-left", "scroll-right", "follow-on", "follow-off", "collapse-track", "expand-track", "hide-view", "focus-view", "browser-toggle"];
        if (typeof action !== "string" || !actions.includes(action)) throw new RangeError("view control action is invalid");
        if ((action === "hide-view" || action === "focus-view") && (typeof args.view !== "string" || args.view.length < 1 || args.view.length > 64)) throw new RangeError("view name is required");
        if (action === "follow-on" || action === "follow-off") this.state.view = { visibleView: this.state.view?.visibleView ?? "Session", follow: action === "follow-on" };
        if (action === "collapse-track" || action === "expand-track") { const track = this.findTrack(objectRef("trackRef")); if (!track) throw new Error("track reference is stale or invalid"); }
        this.emit({ type: "state", payload: { operation } });
        return { action, done: true };
      }
      case "audio.clip.set": {
        const clip = this.findClip(objectRef("ref"));
        if (clip.objectIdentity !== args.expectedObjectIdentity) throw new Error("audio clip identity changed since preview");
        const clipAuthorityRevision = clip.ref.startsWith("arrangement-clip:") ? arrangementAuthorityRevision(clip.ref) : simulatorRevision(this.sessionClipAuthority(clip.ref));
        const audioFields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "warping", "fadeInLength", "fadeOutLength"];
        const audioStateRevision = simulatorRevision(Object.fromEntries(audioFields.map((field) => [field, (clip as unknown as Record<string, unknown>)[field] ?? null])));
        if (args.expectedAuthorityRevision !== clipAuthorityRevision || args.expectedStateRevision !== audioStateRevision) throw new Error("audio clip hierarchy or state changed since preview");
        if (clip.kind !== "audio") throw new Error("audio properties require an audio clip");
        const fields = ["gain", "pitchCoarse", "pitchFine", "loopStart", "loopEnd", "warpMode", "fadeInLength", "fadeOutLength"] as const;
        for (const field of fields) if (args[field] !== undefined) {
          const value = args[field];
          if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} is invalid`);
          (clip as unknown as Record<string, unknown>)[field] = value;
        }
        if (args.warping !== undefined) { if (typeof args.warping !== "boolean") throw new TypeError("warping is invalid"); clip.warping = args.warping; }
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { changed: true, revision: ++this.sequence };
      }
      case "note.add": { const clip = this.findClip(objectRef("ref")); this.assertNoteAuthority(args, clip); return this.addNote(clip.ref, args.note as Note); }
      case "note.add-batch": {
        const clipRef = objectRef("ref");
        const notes = args.notes;
        if (!Array.isArray(notes) || notes.length < 1 || notes.length > 512) throw new RangeError("note batch is invalid");
        const clip = this.findClip(clipRef); const typed = notes as Note[]; this.assertNoteAuthority(args, clip);
        typed.forEach((note) => this.validateNoteForClip(clip, note));
        const before = structuredClone(clip.notes); const firstNextId = this.nextNoteId;
        try {
          const results = typed.map((note) => this.addNote(clipRef, note));
          return { added: results.length, noteIds: results.map((result) => result.noteId), notesRevision: clip.notesRevision };
        } catch (error) { clip.notes = before; clip.notesRevision = simulatorRevision(clip.notes); this.nextNoteId = firstNextId; throw error; }
      }
      case "note.update": {
        const clip = this.findClip(objectRef("ref")); this.assertNoteAuthority(args, clip);
        const patches = args.notes;
        if (!Array.isArray(patches) || patches.length < 1 || patches.length > 512) throw new RangeError("note patches are invalid");
        const seen = new Set<number>();
        for (const patch of patches) {
          if (!patch || typeof patch !== "object" || !Number.isInteger((patch as { id?: unknown }).id) || ((patch as { id: number }).id as number) < 0) throw new RangeError("note patch id is invalid");
          const id = (patch as { id: number }).id;
          if (seen.has(id)) throw new RangeError("duplicate note patch id");
          seen.add(id);
        }
        for (const id of seen) if (!clip.notes.some((note) => note.id === id)) throw new Error("note id is not present in the clip");
        for (const patch of patches as Array<Record<string, unknown>>) {
          const note = clip.notes.find((item) => item.id === (patch.id as number))!;
          if (patch.pitch !== undefined) note.pitch = patch.pitch as number;
          if (patch.start !== undefined) note.start = patch.start as number;
          if (patch.duration !== undefined) note.duration = patch.duration as number;
          if (patch.velocity !== undefined) note.velocity = patch.velocity as number;
          if (patch.mute !== undefined) note.mute = patch.mute as boolean;
          if (patch.probability !== undefined) note.probability = patch.probability as number;
          if (patch.velocityDeviation !== undefined) note.velocityDeviation = patch.velocityDeviation as number;
          if (patch.releaseVelocity !== undefined) note.releaseVelocity = patch.releaseVelocity as number;
        }
        clip.notesRevision = simulatorRevision(clip.notes); this.emit({ type: "object", ref: objectRef("ref"), payload: { operation } });
        return { updated: seen.size };
      }
      case "note.delete": {
        const clip = this.findClip(objectRef("ref")); this.assertNoteAuthority(args, clip);
        const ids = args.noteIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 512 || new Set(ids).size !== ids.length || !ids.every((id) => Number.isInteger(id) && (id as number) >= 0)) throw new RangeError("note ids are invalid");
        for (const id of ids) if (!clip.notes.some((note) => note.id === id)) throw new Error("note id is not present in the clip");
        clip.notes = clip.notes.filter((note) => !ids.includes(note.id as number)); clip.notesRevision = simulatorRevision(clip.notes);
        this.emit({ type: "object", ref: objectRef("ref"), payload: { operation } });
        return { deleted: ids.length };
      }
      case "device.parameter.set": {
        const target = this.find(objectRef("ref")) as Parameter; const requested = args.value;
        if (!target || typeof requested !== "number" || !Number.isFinite(requested) || requested < target.min || requested > target.max) throw new RangeError("parameter value is outside numeric bounds");
        const currentAuthority = this.parameterAuthority(target.ref); const expectedAuthority = { ref: target.ref, parameterIdentity: args.expectedObjectIdentity, ownerRef: args.expectedOwnerRef, ownerIdentity: args.expectedOwnerIdentity, trackRef: args.expectedTrackRef, trackIdentity: args.expectedTrackIdentity, siblings: args.expectedSiblings };
        if (simulatorCanonical(currentAuthority) !== simulatorCanonical(expectedAuthority)) throw new Error("parameter identity or hierarchy changed since preview");
        if (target.enabled === false || target.automatable === false) throw new Error("parameter is disabled or not automatable");
        const quantization = target.quantization ?? 0;
        if (quantization > 0 && Math.abs((requested - target.min) / quantization - Math.round((requested - target.min) / quantization)) > 1e-9) throw new RangeError("parameter value violates quantization");
        if ((target.revision ?? 1) !== args.expectedRevision) throw new Error("parameter revision changed since preview");
        this.set(target.ref, "value", requested); return { changed: true, ref: target.ref, property: "value", value: target.value, revision: target.revision ?? 1 };
      }
      case "routing.set": {
        const track = this.findTrack(objectRef("ref"));
        if (!track || !track.ref.startsWith("track:")) throw new Error("unknown track reference");
        if (args.input !== undefined) track.input = stringArg("input");
        if (args.output !== undefined) track.output = stringArg("output");
        this.emit({ type: "object", ref: track.ref, payload: { operation, input: track.input, output: track.output } }); return structuredClone(track);
      }
      case "browser.search": {
        const query = stringArg("query").toLowerCase();
        return (this.state.browser ?? []).filter((item) => item.name.toLowerCase().includes(query)).map((item) => structuredClone(item));
      }
      case "locator.add": {
        const name = stringArg("name"); const position = args.position;
        if (args.expectedCollectionRevision !== this.state.arrangement.locatorRevision) throw new Error("locator collection changed since preview");
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) throw new RangeError("locator position is invalid");
        const locator = { ref: ref("locator", `locator-${this.state.arrangement.locators.length + 1}`), objectIdentity: `simulator:locator:${this.state.arrangement.locators.length + 1}`, name, position };
        this.state.arrangement.locators.push(locator); this.state.arrangement.locatorRevision = simulatorRevision(this.state.arrangement.locators); this.emit({ type: "object", ref: locator.ref, payload: { operation, locator } }); return { ...structuredClone(locator), createdFingerprint: simulatorRevision(locator) };
      }
      case "locator.delete": {
        const locatorRef = objectRef("ref");
        const index = this.state.arrangement.locators.findIndex((item) => item.ref === locatorRef);
        if (index < 0 || args.expectedCollectionRevision !== this.state.arrangement.locatorRevision || args.expectedObjectIdentity !== this.state.arrangement.locators[index]?.objectIdentity) throw new Error("locator identity or collection changed since preview");
        const [deleted] = this.state.arrangement.locators.splice(index, 1); this.state.arrangement.locatorRevision = simulatorRevision(this.state.arrangement.locators);
        this.emit({ type: "object", ref: locatorRef, payload: { operation, locator: deleted } });
        return { deleted: locatorRef };
      }
    }
    throw new Error(`unknown operation: ${operation}`);
  }
  subscribe(listener: (event: LiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  reconnect(): LiveStatus { this.epoch += 1; this.state.playback.epoch = this.epoch; this.state.playback.revision = `${this.epoch}:reconnected`; this.emit({ type: "state", payload: { epoch: this.epoch, snapshot: this.snapshot() } }); return this.status(); }
  async snapshotAsync(): Promise<LiveSnapshot> { return this.snapshot(); }
  async discoverAsync(request: LiveDiscoveryRequest): Promise<LiveDiscoveryResult> {
    const rows = (request.kind === "set" ? [this.state.set] : request.kind === "track" ? this.state.tracks : request.kind === "scene" ? this.state.scenes : request.kind === "session-clip" ? this.state.tracks.flatMap((track) => track.clips) : request.kind === "arrangement-clip" ? (this.state.arrangementClips ?? []).map((item) => ({ ref: item.clip.ref, parentRef: item.trackRef, trackRef: item.trackRef, name: item.clip.name, kind: item.clip.kind, start: item.clip.start, length: item.clip.length })) : request.kind === "locator" ? this.state.arrangement.locators : request.kind === "device" ? this.state.tracks.flatMap((track) => track.devices) : request.kind === "parameter" ? this.state.tracks.flatMap((track) => track.devices.flatMap((device) => device.parameters)) : request.kind === "session-playback" ? [this.state.playback] : []) as unknown as Record<string, unknown>[];
    return { epoch: this.epoch, items: structuredClone(rows.slice(0, request.limit ?? 50)), truncated: false, revision: `${this.epoch}:${request.kind}:${rows.length}`, kind: request.kind };
  }
  async getAsync(objectRef: LiveRef): Promise<unknown> { return this.get(objectRef); }
  async invokeAsync(invocation: LiveInvocation): Promise<unknown> { return this.invoke(invocation); }
  async reconnectAsync(): Promise<LiveStatus> { return this.reconnect(); }
  async close(): Promise<void> { this.listeners.clear(); }
  private nextNoteId = 2;
  private validateNoteForClip(clip: Clip, note: Note): void {
    if (clip.kind !== "midi") throw new Error("notes require a MIDI clip");
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || !Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0 || typeof note.velocity !== "number" || !Number.isFinite(note.velocity) || note.velocity < 1 || note.velocity > 127 || !Number.isInteger(note.channel) || note.channel < 1 || note.channel > 16) throw new RangeError("invalid MIDI note");
    if (note.probability !== undefined && note.probability !== null && (typeof note.probability !== "number" || !Number.isFinite(note.probability) || note.probability < 0 || note.probability > 1)) throw new RangeError("note probability is invalid");
    if (note.velocityDeviation !== undefined && note.velocityDeviation !== null && (typeof note.velocityDeviation !== "number" || !Number.isFinite(note.velocityDeviation) || note.velocityDeviation < -127 || note.velocityDeviation > 127)) throw new RangeError("note velocity deviation is invalid");
    if (note.releaseVelocity !== undefined && note.releaseVelocity !== null && (typeof note.releaseVelocity !== "number" || !Number.isFinite(note.releaseVelocity) || note.releaseVelocity < 0 || note.releaseVelocity > 127)) throw new RangeError("note release velocity is invalid");
    if (note.mute !== undefined && note.mute !== null && typeof note.mute !== "boolean") throw new RangeError("note mute is invalid");
  }
  addNote(clipRef: LiveRef, note: Note): { added: boolean; noteId: number } {
    const clip = this.findClip(clipRef);
    this.validateNoteForClip(clip, note);
    const id = this.nextNoteId++;
    clip.notes.push(structuredClone({ ...note, id, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 })); clip.notesRevision = simulatorRevision(clip.notes);
    this.emit({ type: "object", ref: clipRef, payload: { operation: "note.add", note } });
    return { added: true, noteId: id };
  }
  setAutomation(clipRef: LiveRef, point: AutomationPoint): void {
    const clip = this.findClip(clipRef);
    if (!Number.isFinite(point.time) || point.time < 0 || point.time > clip.length || !Number.isFinite(point.value) || (point.curve !== undefined && !Number.isFinite(point.curve))) throw new RangeError("automation point is outside the clip");
    clip.automation.push(structuredClone(point));
    this.emit({ type: "object", ref: clipRef, payload: { operation: "automation.add", point } });
  }
  setWarp(clipRef: LiveRef, enabled: boolean): void { if (typeof enabled !== "boolean") throw new TypeError("warp must be boolean"); const clip = this.findClip(clipRef); if (clip.kind !== "audio") throw new Error("warp requires an audio clip"); clip.warp = enabled; this.emit({ type: "object", ref: clipRef, payload: { operation: "warp.set", enabled } }); }
  addTake(clipRef: LiveRef, take: string): void { const clip = this.findClip(clipRef); if (typeof take !== "string" || take.length === 0 || take.length > 256 || clip.takes.includes(take)) throw new Error("invalid or duplicate take"); clip.takes.push(take); this.emit({ type: "object", ref: clipRef, payload: { operation: "take.add", take } }); }
  private sessionClipAuthority(clipRef: LiveRef): Record<string, unknown> {
    const found = this.findClipWithTrack(clipRef); const slot = found?.track.clipSlots?.find((candidate) => candidate.clipRef === clipRef); const scene = slot && this.state.scenes.find((candidate) => candidate.index === slot.sceneIndex);
    if (!found || !slot || !scene || typeof found.clip.objectIdentity !== "string" || typeof found.track.objectIdentity !== "string" || typeof slot.objectIdentity !== "string" || typeof scene.objectIdentity !== "string") throw new Error("clip hierarchy identity is unavailable");
    return { expectedObjectIdentity: found.clip.objectIdentity, expectedTrackRef: found.track.ref, expectedTrackIdentity: found.track.objectIdentity, expectedSlotRef: slot.ref, expectedSlotIdentity: slot.objectIdentity, expectedSceneRef: scene.ref, expectedSceneIdentity: scene.objectIdentity };
  }
  private assertNoteAuthority(args: Record<string, unknown>, clip: Clip): void {
    if (simulatorCanonical(args.expectedClipAuthority) !== simulatorCanonical(this.sessionClipAuthority(clip.ref)) || args.expectedNotesRevision !== clip.notesRevision) throw new Error("clip identity or notes changed since preview");
  }
  private parameterAuthority(parameterRef: LiveRef): Record<string, unknown> {
    for (const track of this.state.tracks) {
      const mixer = track.mixer;
      if (mixer && track.objectIdentity) {
        const rows = [{ ref: mixer.volumeRef, objectIdentity: mixer.volumeIdentity }, { ref: mixer.panRef, objectIdentity: mixer.panIdentity }, { ref: mixer.cueRef, objectIdentity: mixer.cueIdentity }, ...mixer.sendRefs.map((ref, index) => ({ ref, objectIdentity: mixer.sendIdentities?.[index] }))].filter((row): row is { ref: LiveRef; objectIdentity: string } => typeof row.ref === "string" && typeof row.objectIdentity === "string");
        const target = rows.find((row) => row.ref === parameterRef);
        if (target) return { ref: target.ref, parameterIdentity: target.objectIdentity, ownerRef: track.ref, ownerIdentity: track.objectIdentity, trackRef: track.ref, trackIdentity: track.objectIdentity, siblings: rows };
      }
      for (const device of track.devices) {
        const parameter = device.parameters.find((candidate) => candidate.ref === parameterRef);
        if (parameter && parameter.objectIdentity && device.objectIdentity && track.objectIdentity) return { ref: parameter.ref, parameterIdentity: parameter.objectIdentity, ownerRef: device.ref, ownerIdentity: device.objectIdentity, trackRef: track.ref, trackIdentity: track.objectIdentity, siblings: device.parameters.map((candidate) => ({ ref: candidate.ref, objectIdentity: candidate.objectIdentity })) };
      }
    }
    throw new Error("parameter authority is unavailable");
  }
  private automationAuthorityDigest(clipRef: LiveRef, parameterRef: LiveRef): string { return simulatorRevision({ clip: this.sessionClipAuthority(clipRef), parameter: this.parameterAuthority(parameterRef) }); }
  private envelopeRevision(clip: Clip, parameterRef: LiveRef): string { const points = clip.envelopes?.[parameterRef]; return simulatorRevision({ exists: points !== undefined, points: points ?? [] }); }
  private browserCatalog(): Array<{ id: string; objectIdentity: string; name: string; category: string; path: string; isDevice: boolean }> { return [
    { id: "instruments/Drum Rack", objectIdentity: "simulator:browser:instruments/Drum Rack", name: "Drum Rack", category: "instruments", path: "instruments/Drum Rack", isDevice: true },
    { id: "instruments/Analog", objectIdentity: "simulator:browser:instruments/Analog", name: "Analog", category: "instruments", path: "instruments/Analog", isDevice: true },
    { id: "instruments/Collision", objectIdentity: "simulator:browser:instruments/Collision", name: "Collision", category: "instruments", path: "instruments/Collision", isDevice: true },
    { id: "audio_effects/Utility", objectIdentity: "simulator:browser:audio_effects/Utility", name: "Utility", category: "audio_effects", path: "audio_effects/Utility", isDevice: true },
    { id: "audio_effects/Echo", objectIdentity: "simulator:browser:audio_effects/Echo", name: "Echo", category: "audio_effects", path: "audio_effects/Echo", isDevice: true },
    { id: "midi_effects/Arpeggiator", objectIdentity: "simulator:browser:midi_effects/Arpeggiator", name: "Arpeggiator", category: "midi_effects", path: "midi_effects/Arpeggiator", isDevice: true },
    { id: "drums/Kick Core", objectIdentity: "simulator:browser:drums/Kick Core", name: "Kick Core", category: "drums", path: "drums/Kick Core", isDevice: false },
  ]; }
  private findClipWithTrack(objectRef: LiveRef): { track: Track; clip: Clip } | undefined { for (const track of this.state.tracks) { const clip = track.clips.find((item) => item.ref === objectRef); if (clip) return { track, clip }; } return undefined; }
  private find(objectRef: LiveRef): Track | Clip | Device | Parameter | undefined { for (const track of this.state.tracks) { if (track.ref === objectRef) return track; const clip = track.clips.find((item) => item.ref === objectRef); if (clip) return clip; for (const lane of track.takeLanes ?? []) { const laneClip = lane.clips.find((item) => item.ref === objectRef); if (laneClip) return laneClip; } for (const device of track.devices) { if (device.ref === objectRef) return device; const parameter = device.parameters.find((item) => item.ref === objectRef); if (parameter) return parameter; } } return undefined; }
  private findTakeLane(reference: LiveRef): { track: Track; lane: TakeLane } | undefined {
    for (const track of this.state.tracks) {
      const lane = (track.takeLanes ?? []).find((candidate) => candidate.ref === reference);
      if (lane) return { track, lane };
    }
    return undefined;
  }

  private findChain(reference: LiveRef): { device: Device; chain: DeviceChain } | undefined {
    for (const track of this.state.tracks) {
      for (const device of track.devices) {
        const chain = (device.chains ?? []).find((candidate) => candidate.ref === reference);
        if (chain) return { device, chain };
      }
    }
    return undefined;
  }

  private findTrack(objectRef: LiveRef): Track | undefined { return this.state.tracks.find((track) => track.ref === objectRef); }
  private findClip(objectRef: LiveRef): Clip { const value = this.find(objectRef); if (!value || !("notes" in value)) throw new Error(`unknown clip reference: ${objectRef}`); return value; }
  private emit(event: Omit<LiveEvent, "epoch" | "sequence">): void { const complete = { ...event, epoch: this.epoch, sequence: ++this.sequence }; for (const listener of this.listeners) listener(structuredClone(complete)); }
}

export class UnavailableLiveAdapter implements LiveAdapter {
  status(): LiveStatus { return { connected: false, adapter: "unavailable", epoch: null, protocol: LIVE_PROTOCOL_VERSION, capabilities: [], reason: "live-adapter-not-installed" }; }
  snapshot(): never { throw new Error("Live adapter unavailable"); }
  get(): never { throw new Error("Live adapter unavailable"); }
  invoke(): never { throw new Error("Live adapter unavailable"); }
  subscribe(): () => void { return () => undefined; }
  reconnect(): LiveStatus { return this.status(); }
  async snapshotAsync(): Promise<never> { return this.snapshot(); }
  async discoverAsync(): Promise<never> { return this.snapshot(); }
  async getAsync(): Promise<never> { return this.get(); }
  async invokeAsync(): Promise<never> { return this.invoke(); }
  async reconnectAsync(): Promise<LiveStatus> { return this.reconnect(); }
  async close(): Promise<void> { return undefined; }
}
