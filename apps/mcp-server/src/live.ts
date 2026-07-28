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
  "routing", "recording", "projects", "mixing", "transport", "max", "osc",
  "realtime.events", "plugins", "subscriptions", "reconnect",
] as const;

export const LIVE_UNAVAILABLE_CAPABILITIES = [
  "arrangement.read", "arrangement.write", "audio", "audio.capture.resampling", "warp", "takes",
  "automation", "devices", "racks", "chains", "parameters", "browser",
  "routing", "recording", "projects", "mixing", "max", "osc", "realtime.events",
  "plugins",
] as const;

export const SIMULATOR_CAPABILITIES = [
  "session.read", "tracks", "scenes", "clips", "notes", "session.discovery", "session.structure", "session.midi_clip.create", "session.midi_clip.delete", "session.midi_note.read", "session.midi_note.write", "arrangement.read", "arrangement.write", "transport", "devices", "parameters", "device.parameter.write", "subscriptions", "reconnect",
] as const satisfies readonly LiveCapability[];

export type LiveCapability = typeof LIVE_CAPABILITIES[number];
export type LiveObjectKind = "set" | "track" | "scene" | "clip" | "clip-slot" | "session-playback" | "arrangement-clip" | "device" | "parameter" | "note" | "automation" | "locator" | "chain" | "drum_pad";
export type LiveWireObjectKind = LiveObjectKind | "clip_slot" | "arrangement_clip" | "routing_choice" | "return_track" | "main_track" | "browser_item";
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
export interface DeviceChain { ref: LiveRef; parentRef: LiveRef; objectIdentity?: string; index: number; name: string; mute: boolean | null; solo: boolean | null; devices: Device[]; }
export interface DrumPad { ref: LiveRef; parentRef: LiveRef; index: number; name: string; mute: boolean | null; chains: DeviceChain[]; }
export interface Device { ref: LiveRef; parentRef?: LiveRef; name: string; kind: "instrument" | "audio-effect" | "midi-effect" | "plugin" | "rack" | "device"; parameters: Parameter[]; objectIdentity?: string; enabled?: boolean; className?: string; canHaveChains?: boolean | null; canHaveDrumPads?: boolean | null; chains?: DeviceChain[]; drumPads?: DrumPad[]; macros?: { ref: LiveRef; objectIdentity?: string; name: string; value: unknown }[]; variationCount?: number; chainSelector?: unknown; }
export interface Clip { ref: LiveRef; objectIdentity?: string; name: string; kind: "midi" | "audio"; start: number; length: number; notes: Note[]; warp: boolean; takes: string[]; automation: AutomationPoint[]; envelopes?: Record<string, AutomationPoint[]>; isAudio?: boolean | null; gain?: number | null; pitchCoarse?: number | null; pitchFine?: number | null; warpMode?: number | null; warping?: boolean | null; fadeInLength?: number | null; fadeOutLength?: number | null; availableAudioFields?: string[]; loopStart?: number | null; loopEnd?: number | null; filePath?: string | null; }
export interface RoutingState { inputType: string | null; inputSubRouting: string | null; outputType: string | null; outputSubRouting: string | null; availableInputTypes: number; availableInputChannels: number; availableOutputTypes: number; availableOutputChannels: number; }
export interface MixerState { volume: number | null; pan: number | null; cueVolume: number | null; mute: boolean | null; solo: boolean | null; sends: (number | null)[]; volumeRef: LiveRef | null; volumeIdentity?: string | null; panRef: LiveRef | null; panIdentity?: string | null; cueRef: LiveRef | null; cueIdentity?: string | null; sendRefs: LiveRef[]; sendIdentities?: string[]; }
export interface ClipSlot { ref: LiveRef; parentRef: LiveRef; objectIdentity?: string; sceneIndex: number; clipRef?: LiveRef | null; empty: boolean; }
export interface Track { ref: LiveRef; objectIdentity?: string; name: string; kind: "audio" | "midi" | "group" | "return" | "main" | "master" | "regular"; volume: number; pan: number; mute: boolean; solo: boolean; armed: boolean | null; monitoringState?: LiveMonitoringState; playingSlotIndex?: number | null; firedSlotIndex?: number | null; clips: Clip[]; clipSlots?: ClipSlot[]; mixer?: MixerState; routing?: RoutingState; devices: Device[]; sends: number[]; input?: string; output?: string; }
export interface Scene { ref: LiveRef; objectIdentity?: string; name: string; index: number; }
export interface LiveSnapshot {
  set: { ref: LiveRef; name: string; tempo?: number; playing?: boolean; position?: number; loop?: { enabled: boolean; start?: number; length?: number }; [key: string]: unknown };
  tracks: Track[];
  scenes: Scene[];
  arrangement: { length: number; locators: { ref: LiveRef; name: string; position: number }[]; clips?: Array<Record<string, unknown>> };
  arrangementClips?: Array<{ clip: Clip; trackRef: LiveRef }>;
  browser?: { ref: LiveRef; name: string; kind: "device" | "sample" | "preset" }[];
  playback: SessionPlaybackState;
  selected?: LiveRef;
}
export interface LiveEvent { epoch: number; sequence: number; type: "state" | "transport" | "object" | "meter" | "max" | "osc" | "reset"; ref?: LiveRef; payload: unknown; }

export type LiveOperation =
  | "arrangement.clip.create" | "arrangement.clip.delete" | "arrangement.clip.move" | "arrangement.automation.read" | "arrangement.automation.create" | "arrangement.automation.delete" | "arrangement.automation.point.insert" | "arrangement.automation.point.delete"
  | "audio.capture.cleanup" | "audio.capture.emergency-stop" | "audio.capture.inspect" | "audio.capture.start" | "audio.capture.status" | "audio.capture.stop" | "audio.clip.set" | "audio.warp-marker.read" | "audio.warp-marker.add" | "audio.warp-marker.move" | "audio.warp-marker.delete" | "audio.take-lane.read" | "audio.comp.read"
  | "automation.envelope.create" | "automation.envelope.delete" | "automation.envelope.read" | "automation.point.delete" | "automation.point.insert"
  | "browser.inspect" | "browser.load" | "browser.search" | "browser.preview.start" | "browser.preview.stop" | "clip.create" | "clip.delete" | "clip.duplicate" | "clip.rename"
  | "device.delete" | "device.enable" | "device.insert" | "device.move" | "device.parameter.set" | "device.rename"
  | "locator.add" | "locator.delete" | "locator.rename" | "mixer.set" | "note.add" | "note.add-batch" | "note.delete" | "note.update"
  | "project.bounce" | "project.collect" | "project.export" | "project.new" | "project.open" | "project.save" | "project.save-as"
  | "realtime.arm" | "realtime.disarm" | "realtime.stats" | "recording.arrangement" | "recording.session" | "routing.set"
  | "scene.capture" | "scene.create" | "scene.delete" | "scene.rename" | "session.audition-launch" | "session.audition-stop" | "session.capture-midi" | "session.clip-launch" | "session.clip-stop" | "session.discover" | "session.emergency-stop"
  | "tempo.set" | "track.create" | "track.delete" | "track.rename" | "transport.set" | "subscribe";

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

function createSimulatorState(): LiveSnapshot {
  const kick: Clip = { ref: ref("clip", "clip-1"), objectIdentity: "simulator:clip:clip-1", name: "Kick Pattern", kind: "midi", start: 0, length: 4, notes: [{ pitch: 36, start: 0, duration: 0.25, velocity: 110, channel: 1, id: 1, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 }], warp: false, takes: ["take-1"], automation: [] };
  const track: Track = { ref: ref("track", "track-1"), objectIdentity: "simulator:track:track-1", name: "Drums", kind: "midi", volume: 0.85, pan: 0, mute: false, solo: false, armed: false, monitoringState: "off", playingSlotIndex: null, firedSlotIndex: null, clips: [kick], clipSlots: [{ ref: ref("clip-slot", "track-1:0"), parentRef: ref("track", "track-1"), objectIdentity: "simulator:clip-slot:track-1:0", sceneIndex: 0, clipRef: kick.ref, empty: false }], mixer: { volume: 0.85, pan: 0, cueVolume: 1, mute: false, solo: false, sends: [0.5, 0.25], volumeRef: ref("parameter", "mixer:0:volume"), volumeIdentity: "simulator:parameter:mixer:0:volume", panRef: ref("parameter", "mixer:0:panning"), panIdentity: "simulator:parameter:mixer:0:panning", cueRef: ref("parameter", "mixer:0:cue_volume"), cueIdentity: "simulator:parameter:mixer:0:cue_volume", sendRefs: [ref("parameter", "mixer:0:sends:0"), ref("parameter", "mixer:0:sends:1")], sendIdentities: ["simulator:parameter:mixer:0:sends:0", "simulator:parameter:mixer:0:sends:1"] }, routing: { inputType: "Ext. In", inputSubRouting: "1", outputType: "Main", outputSubRouting: "1/2", availableInputTypes: 2, availableInputChannels: 16, availableOutputTypes: 3, availableOutputChannels: 4 }, devices: [], sends: [0, 0] };
  const gain: Parameter = { ref: ref("parameter", "gain-1"), objectIdentity: "simulator:parameter:gain-1", name: "Gain", value: 0.5, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, displayValue: "0.5", revision: 1 };
  const device: Device = { ref: ref("device", "utility-1"), parentRef: track.ref, name: "Utility", kind: "audio-effect", parameters: [gain], objectIdentity: "simulator:device:utility-1", enabled: true };
  track.devices.push(device);
  return {
    set: { ref: ref("set", "set-1"), name: "Simulator Set", tempo: 120, playing: false, position: 0, loop: { enabled: false, start: 0, length: 4 } },
    tracks: [track],
    scenes: [{ ref: ref("scene", "scene-1"), objectIdentity: "simulator:scene:scene-1", name: "Scene 1", index: 0 }],
    arrangement: { length: 16, locators: [{ ref: ref("locator", "locator-1"), name: "Intro", position: 0 }], clips: [] },
    arrangementClips: [],
    browser: [{ ref: ref("device", "utility-1"), name: "Utility", kind: "device" }, { ref: ref("clip", "sample-1"), name: "Kick Sample", kind: "sample" }],
    playback: { ref: ref("session-playback", "playback-1"), epoch: 1, revision: "1:stopped", transport: { playing: false, arrangementRecord: false, sessionRecord: false, position: 0, launchQuantization: { raw: "1-bar", normalized: "1-bar" }, loop: { enabled: false, start: 0, length: 4 }, punchIn: false, punchOut: false, metronome: false, countIn: 1 }, firedTargets: [], playingTargets: [] },
    selected: track.ref,
  };
}

export const SIMULATOR_OPERATIONS = ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "transport.set", "tempo.set", "session.audition-launch", "session.audition-stop", "session.emergency-stop", "session.clip-launch", "session.clip-stop", "clip.create", "clip.delete", "track.create", "track.delete", "track.rename", "scene.create", "scene.delete", "scene.rename", "clip.rename", "device.rename", "locator.rename", "scene.capture", "note.add", "note.add-batch", "note.update", "note.delete", "locator.add", "locator.delete", "session.capture-midi", "device.parameter.set", "clip.duplicate", "arrangement.clip.create", "arrangement.clip.delete", "arrangement.clip.move", "audio.clip.set", "mixer.set", "automation.envelope.read", "automation.envelope.create", "automation.envelope.delete", "automation.point.insert", "automation.point.delete", "device.insert", "device.delete", "device.enable", "device.move", "browser.search", "browser.inspect", "browser.load", "routing.set", "recording.session", "recording.arrangement"] as const;

export class DeterministicLiveSimulator implements LiveAdapter {
  private state = createSimulatorState();
  private sequence = 0;
  private epoch = 1;
  private listeners = new Set<(event: LiveEvent) => void>();

  status(): LiveStatus { return { connected: true, adapter: "simulator", epoch: this.epoch, protocol: LIVE_PROTOCOL_VERSION, capabilities: SIMULATOR_CAPABILITIES, operations: [...SIMULATOR_OPERATIONS] }; }
  snapshot(): LiveSnapshot { const value = structuredClone(this.state) as LiveSnapshot; value.arrangement.clips = (this.state.arrangementClips ?? []).map((item) => ({ ref: item.clip.ref, parentRef: item.trackRef, trackRef: item.trackRef, name: item.clip.name, kind: item.clip.kind, start: item.clip.start, length: item.clip.length })); return value; }
  get(objectRef: LiveRef): unknown {
    if (objectRef === this.state.set.ref) return structuredClone(this.state.set);
    const scene = this.state.scenes.find((item) => item.ref === objectRef);
    if (scene) return structuredClone(scene);
    for (const track of this.state.tracks) {
      if (track.ref === objectRef) return structuredClone(track);
      const clip = track.clips.find((item) => item.ref === objectRef);
      if (clip) return structuredClone(clip);
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
    const structureRevision = (): string => createHash("sha256").update(JSON.stringify({ tracks: this.state.tracks.map((item, index) => [item.ref, item.name, item.kind, index]), scenes: this.state.scenes.map((item, index) => [item.ref, item.name, index]) })).digest("hex");
    const requireStructureRevision = (): void => { if (args.expectedStructureRevision !== structureRevision()) throw new Error("Session structure changed since preview"); };
    const requireDeviceSiblings = (devices: Device[]): void => {
      const expected = args.expectedSiblings;
      if (!Array.isArray(expected) || expected.length > 256 || !expected.every((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as { ref?: unknown }).ref === "string" && typeof (item as { objectIdentity?: unknown }).objectIdentity === "string")) throw new TypeError("expected device siblings are invalid");
      const current = devices.map((device) => ({ ref: device.ref, objectIdentity: device.objectIdentity }));
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("device siblings changed since preview");
    };
    const recordingAuthority = (): void => {
      if (typeof args.expectedSessionRecord !== "boolean" || typeof args.expectedArrangementRecord !== "boolean" || args.expectedSessionRecord !== this.state.playback.transport.sessionRecord || args.expectedArrangementRecord !== this.state.playback.transport.arrangementRecord) throw new Error("recording state changed since preview");
      if (!args.outputSafety || typeof args.outputSafety !== "object" || (args.outputSafety as { safe?: unknown }).safe !== true || !["string"].includes(typeof (args.outputSafety as { provenance?: unknown }).provenance) || ["", "unknown", "simulator"].includes(String((args.outputSafety as { provenance?: unknown }).provenance))) throw new Error("authoritative output safety is required");
      if (args.action === "start") { const destination = this.findTrack(objectRef("destinationTrackRef")); const armed = this.state.tracks.filter((track) => track.armed === true); if (!destination || destination.armed !== true || armed.length !== 1 || armed[0] !== destination) throw new Error("recording destination must be the only armed track"); }
      else if (args.destinationTrackRef !== null) objectRef("destinationTrackRef");
    };
    switch (operation) {
      case "transport.set": {
        if (typeof args.expectedRevision !== "string" || args.expectedRevision !== this.state.playback.revision) throw new Error("transport state changed since preview");
        const transport = this.state.playback.transport;
        const finite = (name: string): number | undefined => { const value = args[name]; if (value === null || value === undefined) return undefined; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} is invalid`); return value; };
        const bool = (name: string): boolean | undefined => { const value = args[name]; if (value === null || value === undefined) return undefined; if (typeof value !== "boolean") throw new TypeError(`${name} is invalid`); return value; };
        const position = finite("position"); const loopStart = finite("loopStart"); const loopLength = finite("loopLength"); const countIn = finite("countIn");
        const loopEnabled = bool("loopEnabled"); const metronome = bool("metronome"); const punchIn = bool("punchIn"); const punchOut = bool("punchOut");
        if (loopLength !== undefined && loopLength <= 0) throw new RangeError("loopLength is invalid");
        if (position !== undefined) { transport.position = position; this.state.set.position = position; }
        if (loopEnabled !== undefined) transport.loop.enabled = loopEnabled;
        if (loopStart !== undefined) transport.loop.start = loopStart;
        if (loopLength !== undefined) transport.loop.length = loopLength;
        if (metronome !== undefined) transport.metronome = metronome;
        if (punchIn !== undefined) transport.punchIn = punchIn;
        if (punchOut !== undefined) transport.punchOut = punchOut;
        if (countIn !== undefined) transport.countIn = countIn;
        this.state.playback.revision = `${this.epoch}:transport:${++this.sequence}`;
        this.emit({ type: "transport", payload: { operation } });
        return { changed: true, revision: this.state.playback.revision };
      }
      case "tempo.set": {
        const setRef = objectRef("ref"); const value = args.value; const expectedTempo = args.expectedTempo;
        if (setRef !== this.state.set.ref || typeof value !== "number" || typeof expectedTempo !== "number" || this.state.set.tempo !== expectedTempo) throw new Error("tempo state changed since preview");
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
        const track = this.state.tracks[0];
        if (!track) throw new Error("MIDI capture is unavailable");
        const sceneIndex = this.state.scenes.length;
        const clip: Clip = { ref: ref("clip", `captured-${++this.sequence}`), objectIdentity: `sim-object:clip:${this.sequence}`, name: "Captured", kind: "midi", start: 0, length: 4, notes: [], warp: false, takes: [], automation: [] };
        track.clips.push(clip);
        const slot = { ref: ref("clip-slot", `${track.ref}:${sceneIndex}`), parentRef: track.ref, objectIdentity: `sim-object:clip-slot:${this.sequence}`, sceneIndex, clipRef: clip.ref, empty: false };
        track.clipSlots = [...(track.clipSlots ?? []), slot];
        this.emit({ type: "object", ref: track.ref, payload: { operation, clip: structuredClone(clip) } });
        return { captured: true, clips: [clip.ref], clipIdentities: [{ ref: clip.ref, objectIdentity: clip.objectIdentity }] };
      }
      case "scene.capture": {
        const scene: Scene = { ref: ref("scene", `captured-${++this.sequence}`), objectIdentity: `sim-object:scene:${this.sequence}`, name: "Captured", index: this.state.scenes.length };
        this.state.scenes.push(scene);
        this.emit({ type: "object", payload: { operation, scene } });
        return { captured: true, ref: scene.ref, objectIdentity: scene.objectIdentity };
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
        if (this.state.set.name !== setName) throw new Error("disposable Set identity does not match");
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
        if (this.state.set.name !== setName) throw new Error("disposable Set identity does not match");
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
        const clip: Clip = { ref: ref("clip", `clip-${track.clips.length + 1}-${this.sequence + 1}`), name: typeof args.name === "string" && args.name.length > 0 ? args.name : "New Clip", kind, start, length, notes: [], warp: false, takes: [], automation: [], isAudio: kind === "audio", gain: kind === "audio" ? 1 : null, pitchCoarse: kind === "audio" ? 0 : null, pitchFine: kind === "audio" ? 0 : null, warpMode: kind === "audio" ? 0 : null, loopStart: kind === "audio" ? start : null, loopEnd: kind === "audio" ? start + length : null, warping: kind === "audio" ? true : null, fadeInLength: kind === "audio" ? 0 : null, fadeOutLength: kind === "audio" ? 0 : null, availableAudioFields: kind === "audio" ? ["gain", "pitchCoarse", "pitchFine", "warpMode", "warping", "fadeInLength", "fadeOutLength", "loopStart", "loopEnd"] : [] };
        track.clips.push(clip); this.emit({ type: "object", ref: track.ref, payload: { operation, clip: structuredClone(clip) } }); return structuredClone(clip);
      }
      case "clip.delete": {
        const clipRef = objectRef("ref");
        for (const track of this.state.tracks) { const index = track.clips.findIndex((clip) => clip.ref === clipRef); if (index >= 0) { const clip = track.clips[index]!; if (args.expectedObjectIdentity !== undefined && args.expectedObjectIdentity !== clip.objectIdentity) throw new Error("clip object identity changed; deletion refused"); track.clips.splice(index, 1); this.emit({ type: "object", ref: track.ref, payload: { operation, ref: clipRef } }); return { deleted: clipRef }; } }
        throw new Error(`unknown clip reference: ${clipRef}`);
      }
      case "track.create": {
        requireStructureRevision(); const kind = args.kind === "audio" || args.kind === "midi" ? args.kind : undefined;
        if (!kind) throw new TypeError("track kind must be audio or midi");
        const name = stringArg("name");
        const index = args.index === undefined ? this.state.tracks.length : args.index;
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > this.state.tracks.length) throw new RangeError("track index is invalid");
        if (this.state.tracks.some((track) => track.name === name)) throw new Error("track name already exists");
        const track: Track = { ref: ref("track", `track-${this.state.tracks.length + this.sequence + 1}`), objectIdentity: `simulator:track:${this.state.tracks.length + this.sequence + 1}`, name, kind, volume: 0.85, pan: 0, mute: false, solo: false, armed: false, clips: [], devices: [], sends: [0, 0] };
        this.state.tracks.splice(index as number, 0, track);
        this.emit({ type: "object", ref: track.ref, payload: { operation, track } });
        return structuredClone(track);
      }
      case "track.delete": {
        requireStructureRevision(); const trackRef = objectRef("ref");
        const index = this.state.tracks.findIndex((track) => track.ref === trackRef);
        if (index < 0) throw new Error(`unknown track reference: ${trackRef}`);
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
        this.emit({ type: "object", ref: scene.ref, payload: { operation, scene } });
        return structuredClone(this.state.scenes.find((item) => item.ref === scene.ref) as Scene);
      }
      case "scene.delete": {
        requireStructureRevision(); const sceneRef = objectRef("ref");
        const index = this.state.scenes.findIndex((scene) => scene.ref === sceneRef);
        if (index < 0) throw new Error(`unknown scene reference: ${sceneRef}`);
        if (args.expectedObjectIdentity !== undefined && args.expectedObjectIdentity !== this.state.scenes[index]!.objectIdentity) throw new Error("scene object identity changed; deletion refused");
        this.state.scenes.splice(index, 1);
        this.state.scenes.forEach((item, itemIndex) => { item.index = itemIndex; });
        this.emit({ type: "object", ref: sceneRef, payload: { operation, ref: sceneRef } });
        return { deleted: sceneRef };
      }
      case "track.rename": case "scene.rename": case "clip.rename": case "device.rename": case "locator.rename": {
        const reference = objectRef("ref"); const name = stringArg("name"); const expectedName = args.expectedName;
        let target: { ref: LiveRef; name: string } | undefined;
        if (operation === "track.rename") target = this.state.tracks.find((item) => item.ref === reference);
        else if (operation === "scene.rename") target = this.state.scenes.find((item) => item.ref === reference);
        else if (operation === "clip.rename") target = this.state.tracks.flatMap((item) => item.clips).find((item) => item.ref === reference) ?? this.state.arrangementClips?.map((item) => item.clip).find((item) => item.ref === reference);
        else if (operation === "device.rename") target = this.state.tracks.flatMap((item) => item.devices).find((item) => item.ref === reference);
        else target = this.state.arrangement.locators.find((item) => item.ref === reference);
        if (!target || target.name !== expectedName) throw new Error("rename target changed since preview");
        target.name = name; this.emit({ type: "object", ref: reference, payload: { operation, name } }); return { renamed: reference, name };
      }
      case "device.insert": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track) throw new Error("unknown track reference");
        const name = stringArg("deviceName");
        const index = args.index === undefined || args.index === null ? -1 : args.index;
        if (!Number.isInteger(index) || (index as number) < -1 || (index as number) > 256) throw new RangeError("device index is invalid");
        const device: Device = { ref: ref("device", `${track.ref}:${track.devices.length}`), parentRef: track.ref, name, kind: name.toLowerCase().includes("rack") ? "rack" : "device", className: name, parameters: [], objectIdentity: `simulator:device:${this.sequence + 1}:${track.ref}:${track.devices.length}`, enabled: true, canHaveChains: name.toLowerCase().includes("rack"), canHaveDrumPads: name.toLowerCase().includes("drum rack") };
        if (device.canHaveDrumPads) device.drumPads = Array.from({ length: 16 }, (_, padIndex) => ({ ref: ref("drum_pad", `${device.ref}:${padIndex}`), parentRef: device.ref, index: padIndex, name: `Pad ${padIndex + 1}`, mute: false, chains: [] }));
        const position = (index as number) < 0 || (index as number) > track.devices.length ? track.devices.length : index as number;
        device.ref = ref("device", `${track.ref}:${position}`);
        track.devices.splice(position, 0, device);
        this.emit({ type: "object", ref: track.ref, payload: { operation, device } });
        return { ref: device.ref, name: device.name, index: position };
      }
      case "device.delete": {
        const deviceRef = objectRef("ref"); const expectedIdentity = stringArg("expectedObjectIdentity"); const expectedOwnerRef = objectRef("expectedOwnerRef"); const expectedOwnerIdentity = stringArg("expectedOwnerIdentity");
        for (const track of this.state.tracks) {
          const index = track.devices.findIndex((device) => device.ref === deviceRef && device.objectIdentity === expectedIdentity && device.parentRef === expectedOwnerRef && track.objectIdentity === expectedOwnerIdentity);
          if (index >= 0) { requireDeviceSiblings(track.devices); track.devices.splice(index, 1); this.emit({ type: "object", ref: track.ref, payload: { operation, ref: deviceRef } }); return { deleted: deviceRef }; }
        }
        throw new Error("unknown device reference");
      }
      case "device.enable": {
        const deviceRef = objectRef("ref"); const device = this.find(deviceRef) as Device | undefined;
        const owner = this.state.tracks.find((track) => track.devices.some((candidate) => candidate.ref === deviceRef));
        if (!device || !owner || !("parameters" in device) || device.objectIdentity !== stringArg("expectedObjectIdentity") || device.parentRef !== objectRef("expectedOwnerRef") || owner.objectIdentity !== stringArg("expectedOwnerIdentity")) throw new Error("unknown, replaced, or reparented device reference");
        requireDeviceSiblings(owner.devices);
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
          const current = track.devices.findIndex((device) => device.ref === deviceRef && device.objectIdentity === expectedIdentity && device.parentRef === expectedOwnerRef && track.objectIdentity === expectedOwnerIdentity);
          if (current >= 0) {
            requireDeviceSiblings(track.devices);
            if ((index as number) >= track.devices.length) throw new RangeError("device index is invalid");
            const [device] = track.devices.splice(current, 1);
            track.devices.splice(index as number, 0, device!);
            this.emit({ type: "object", ref: track.ref, payload: { operation } });
            return { ref: deviceRef, index };
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
        if (!item || !item.isDevice || item.name !== args.expectedName) throw new Error("browser item is not an exact loadable device");
        const name = item.name;
        const trackRef = args.trackRef;
        if (trackRef === undefined) return { loaded: true, deviceRef: null };
        const track = this.findTrack(objectRef("trackRef"));
        if (!track) throw new Error("unknown track reference");
        const inserted = this.invoke({ operation: "device.insert", args: { trackRef: track.ref, deviceName: name } }) as { ref: LiveRef };
        return { loaded: true, deviceRef: inserted.ref };
      }
      case "routing.set": {
        const track = this.findTrack(objectRef("ref"));
        if (!track) throw new Error("unknown track reference");
        if (args.inputType !== undefined) track.routing = { ...(track.routing ?? {}), inputType: args.inputType as string | null } as RoutingState;
        if (args.outputType !== undefined) track.routing = { ...(track.routing ?? {}), outputType: args.outputType as string | null } as RoutingState;
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
        const points = (clip.envelopes?.[parameterRef] ?? null);
        return { available: true, exists: points !== null, points: structuredClone(points ?? []) };
      }
      case "automation.envelope.create": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        clip.envelopes = clip.envelopes ?? {};
        clip.envelopes[parameterRef] = clip.envelopes[parameterRef] ?? [];
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { created: true };
      }
      case "automation.envelope.delete": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
        if (!clip.envelopes || !(parameterRef in clip.envelopes)) throw new Error("envelope does not exist");
        delete clip.envelopes[parameterRef];
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { deleted: true };
      }
      case "automation.point.insert": {
        const clip = this.findClip(objectRef("clipRef"));
        const parameterRef = objectRef("parameterRef");
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
        const envelope = clip.envelopes?.[parameterRef];
        if (!envelope) throw new Error("envelope does not exist");
        const from = args.from; const to = args.to;
        if (typeof from !== "number" || !Number.isFinite(from) || from < 0 || typeof to !== "number" || !Number.isFinite(to) || to <= from) throw new RangeError("from/to are invalid");
        const before = envelope.length;
        clip.envelopes![parameterRef] = envelope.filter((point) => point.time < from || point.time > to);
        this.emit({ type: "object", ref: clip.ref, payload: { operation } });
        return { deleted: before - clip.envelopes![parameterRef]!.length };
      }
      case "clip.duplicate": {
        const clipRef = objectRef("ref");
        const found = this.findClipWithTrack(clipRef);
        if (!found) throw new Error("unknown clip reference");
        if (args.arrangementPosition !== undefined) {
          if (typeof args.arrangementPosition !== "number" || !Number.isFinite(args.arrangementPosition) || args.arrangementPosition < 0) throw new RangeError("arrangement position is invalid");
          const clip: Clip = { ...structuredClone(found.clip), ref: ref("arrangement-clip", `${found.track.ref}:${args.arrangementPosition}`), start: args.arrangementPosition };
          this.state.arrangementClips = [...(this.state.arrangementClips ?? []), { clip, trackRef: found.track.ref }];
          this.emit({ type: "object", ref: found.track.ref, payload: { operation, clip } });
          return { ref: clip.ref, name: clip.name };
        }
        const targetTrack = this.findTrack(objectRef("targetTrackRef"));
        const sceneIndex = args.targetSceneIndex;
        if (!targetTrack || !Number.isInteger(sceneIndex) || (sceneIndex as number) < 0) throw new Error("target track or scene index is invalid");
        const target = (targetTrack.clipSlots ?? []).find((slot) => slot.sceneIndex === sceneIndex);
        if (!target) throw new Error("target scene index is invalid");
        if (target.clipRef) throw new Error("target Session slot is occupied");
        const clip: Clip = { ...structuredClone(found.clip), ref: ref("clip", `${targetTrack.ref}:${sceneIndex}`) };
        targetTrack.clips.push(clip);
        target.clipRef = clip.ref; target.empty = false;
        this.emit({ type: "object", ref: targetTrack.ref, payload: { operation, clip } });
        return { ref: clip.ref, name: clip.name };
      }
      case "arrangement.clip.create": {
        const track = this.findTrack(objectRef("trackRef"));
        if (!track) throw new Error("unknown track reference");
        const position = args.position; const length = args.length; const name = args.name;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || typeof length !== "number" || !Number.isFinite(length) || length <= 0 || typeof name !== "string" || name.length < 1 || name.length > 256) throw new RangeError("arrangement clip bounds are invalid");
        const clip: Clip = { ref: ref("arrangement-clip", `${track.ref}:${position}`), name, kind: "midi", start: position, length, notes: [], warp: false, takes: [], automation: [] };
        this.state.arrangementClips = [...(this.state.arrangementClips ?? []), { clip, trackRef: track.ref }];
        this.emit({ type: "object", ref: track.ref, payload: { operation, clip } });
        return { ref: clip.ref, name, start: position, length };
      }
      case "arrangement.clip.delete": {
        const clipRef = objectRef("ref");
        const before = (this.state.arrangementClips ?? []).length;
        this.state.arrangementClips = (this.state.arrangementClips ?? []).filter((item) => item.clip.ref !== clipRef);
        if ((this.state.arrangementClips ?? []).length === before) throw new Error("unknown arrangement clip reference");
        this.emit({ type: "object", payload: { operation, ref: clipRef } });
        return { deleted: clipRef };
      }
      case "arrangement.clip.move": {
        const clipRef = objectRef("ref");
        const item = (this.state.arrangementClips ?? []).find((entry) => entry.clip.ref === clipRef);
        if (!item) throw new Error("unknown arrangement clip reference");
        const position = args.position;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) throw new RangeError("position is invalid");
        item.clip.start = position;
        this.emit({ type: "object", ref: clipRef, payload: { operation } });
        return { ref: clipRef, start: position };
      }
      case "audio.clip.set": {
        const clip = this.findClip(objectRef("ref"));
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
      case "note.add": return this.addNote(objectRef("ref"), args.note as Note);
      case "note.add-batch": {
        const clipRef = objectRef("ref");
        const notes = args.notes;
        if (!Array.isArray(notes) || notes.length < 1 || notes.length > 512) throw new RangeError("note batch is invalid");
        const clip = this.findClip(clipRef); const typed = notes as Note[];
        typed.forEach((note) => this.validateNoteForClip(clip, note));
        const before = structuredClone(clip.notes); const firstNextId = this.nextNoteId;
        try {
          const results = typed.map((note) => this.addNote(clipRef, note));
          return { added: results.length, noteIds: results.map((result) => result.noteId) };
        } catch (error) { clip.notes = before; this.nextNoteId = firstNextId; throw error; }
      }
      case "note.update": {
        const clip = this.findClip(objectRef("ref"));
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
        this.emit({ type: "object", ref: objectRef("ref"), payload: { operation } });
        return { updated: seen.size };
      }
      case "note.delete": {
        const clip = this.findClip(objectRef("ref"));
        const ids = args.noteIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 512 || new Set(ids).size !== ids.length || !ids.every((id) => Number.isInteger(id) && (id as number) >= 0)) throw new RangeError("note ids are invalid");
        for (const id of ids) if (!clip.notes.some((note) => note.id === id)) throw new Error("note id is not present in the clip");
        clip.notes = clip.notes.filter((note) => !ids.includes(note.id as number));
        this.emit({ type: "object", ref: objectRef("ref"), payload: { operation } });
        return { deleted: ids.length };
      }
      case "device.parameter.set": {
        const target = this.find(objectRef("ref")) as Parameter; const requested = args.value;
        if (!target || typeof requested !== "number" || !Number.isFinite(requested) || requested < target.min || requested > target.max) throw new RangeError("parameter value is outside numeric bounds");
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
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) throw new RangeError("locator position is invalid");
        const locator = { ref: ref("locator", `locator-${this.state.arrangement.locators.length + 1}`), name, position };
        this.state.arrangement.locators.push(locator); this.emit({ type: "object", ref: locator.ref, payload: { operation, locator } }); return structuredClone(locator);
      }
      case "locator.delete": {
        const locatorRef = objectRef("ref");
        const index = this.state.arrangement.locators.findIndex((item) => item.ref === locatorRef);
        if (index < 0) throw new Error(`unknown locator reference: ${locatorRef}`);
        const [deleted] = this.state.arrangement.locators.splice(index, 1);
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
    clip.notes.push(structuredClone({ ...note, id, mute: note.mute ?? false, probability: note.probability ?? 1, velocityDeviation: note.velocityDeviation ?? 0, releaseVelocity: note.releaseVelocity ?? 64 }));
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
  private browserCatalog(): Array<{ id: string; name: string; category: string; path: string; isDevice: boolean }> { return [
    { id: "instruments/Drum Rack", name: "Drum Rack", category: "instruments", path: "instruments/Drum Rack", isDevice: true },
    { id: "instruments/Analog", name: "Analog", category: "instruments", path: "instruments/Analog", isDevice: true },
    { id: "instruments/Collision", name: "Collision", category: "instruments", path: "instruments/Collision", isDevice: true },
    { id: "audio_effects/Utility", name: "Utility", category: "audio_effects", path: "audio_effects/Utility", isDevice: true },
    { id: "audio_effects/Echo", name: "Echo", category: "audio_effects", path: "audio_effects/Echo", isDevice: true },
    { id: "midi_effects/Arpeggiator", name: "Arpeggiator", category: "midi_effects", path: "midi_effects/Arpeggiator", isDevice: true },
    { id: "drums/Kick Core", name: "Kick Core", category: "drums", path: "drums/Kick Core", isDevice: false },
  ]; }
  private findClipWithTrack(objectRef: LiveRef): { track: Track; clip: Clip } | undefined { for (const track of this.state.tracks) { const clip = track.clips.find((item) => item.ref === objectRef); if (clip) return { track, clip }; } return undefined; }
  private find(objectRef: LiveRef): Track | Clip | Device | Parameter | undefined { for (const track of this.state.tracks) { if (track.ref === objectRef) return track; const clip = track.clips.find((item) => item.ref === objectRef); if (clip) return clip; for (const device of track.devices) { if (device.ref === objectRef) return device; const parameter = device.parameters.find((item) => item.ref === objectRef); if (parameter) return parameter; } } return undefined; }
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
