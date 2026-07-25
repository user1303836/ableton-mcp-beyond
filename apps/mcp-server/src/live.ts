/**
 * Live-domain contract and deterministic simulator.
 *
 * The simulator is deliberately an adapter test double: it models stable
 * references and state transitions without claiming that Ableton Live is
 * installed or connected. A Remote Script/Extension can implement the same
 * contract at the protocol boundary.
 */

export const LIVE_PROTOCOL_VERSION = "ableton-live/v1";

export const LIVE_CAPABILITIES = [
  "session.read", "session.write", "tracks", "scenes", "clips", "notes",
  "arrangement.read", "arrangement.write", "audio", "warp", "takes",
  "automation", "devices", "racks", "chains", "parameters", "browser",
  "routing", "recording", "projects", "mixing", "transport", "max", "osc",
  "realtime.events", "plugins", "subscriptions", "reconnect",
] as const;

export const LIVE_UNAVAILABLE_CAPABILITIES = [
  "arrangement.read", "arrangement.write", "audio", "warp", "takes",
  "automation", "devices", "racks", "chains", "parameters", "browser",
  "routing", "recording", "projects", "max", "osc", "realtime.events",
  "plugins",
] as const;

export type LiveCapability = typeof LIVE_CAPABILITIES[number];
export type LiveObjectKind = "set" | "track" | "scene" | "clip" | "device" | "parameter" | "note" | "automation";
export type LiveRef = `${LiveObjectKind}:${string}`;

export interface LiveStatus {
  connected: boolean;
  adapter: "simulator" | "remote-script" | "extension" | "unavailable";
  epoch: number | null;
  protocol: string;
  capabilities: readonly LiveCapability[];
  reason?: string;
}

export interface Note { pitch: number; start: number; duration: number; velocity: number; channel: number; }
export interface AutomationPoint { time: number; value: number; curve?: number; }
export interface Parameter { ref: LiveRef; name: string; value: number; min: number; max: number; automatable: boolean; }
export interface Device { ref: LiveRef; name: string; kind: "instrument" | "audio-effect" | "midi-effect" | "plugin" | "rack"; parameters: Parameter[]; }
export interface Clip { ref: LiveRef; name: string; kind: "midi" | "audio"; start: number; length: number; notes: Note[]; warp: boolean; takes: string[]; automation: AutomationPoint[]; }
export interface Track { ref: LiveRef; name: string; kind: "audio" | "midi" | "return" | "master"; volume: number; pan: number; mute: boolean; solo: boolean; armed: boolean; clips: Clip[]; devices: Device[]; sends: number[]; input?: string; output?: string; }
export interface Scene { ref: LiveRef; name: string; index: number; }
export interface LiveSnapshot {
  set: { ref: LiveRef; name: string; tempo: number; playing: boolean; position: number; loop: { enabled: boolean; start: number; length: number }; };
  tracks: Track[];
  scenes: Scene[];
  arrangement: { length: number; locators: { ref: LiveRef; name: string; position: number }[] };
  browser: { ref: LiveRef; name: string; kind: "device" | "sample" | "preset" }[];
  selected?: LiveRef;
}
export interface LiveEvent { sequence: number; type: "state" | "transport" | "object" | "meter" | "max" | "osc"; ref?: LiveRef; payload: unknown; }

export interface LiveAdapter {
  status(): LiveStatus;
  snapshot(): LiveSnapshot;
  get(ref: LiveRef): unknown;
  set(ref: LiveRef, property: string, value: unknown): void;
  subscribe(listener: (event: LiveEvent) => void): () => void;
  reconnect(): LiveStatus;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const ref = (kind: LiveObjectKind, id: string): LiveRef => `${kind}:${id}`;

function createSimulatorState(): LiveSnapshot {
  const kick: Clip = { ref: ref("clip", "clip-1"), name: "Kick Pattern", kind: "midi", start: 0, length: 4, notes: [{ pitch: 36, start: 0, duration: 0.25, velocity: 110, channel: 1 }], warp: false, takes: ["take-1"], automation: [] };
  const track: Track = { ref: ref("track", "track-1"), name: "Drums", kind: "midi", volume: 0.85, pan: 0, mute: false, solo: false, armed: false, clips: [kick], devices: [], sends: [0, 0] };
  const gain: Parameter = { ref: ref("parameter", "gain-1"), name: "Gain", value: 0.5, min: 0, max: 1, automatable: true };
  const device: Device = { ref: ref("device", "utility-1"), name: "Utility", kind: "audio-effect", parameters: [gain] };
  track.devices.push(device);
  return {
    set: { ref: ref("set", "set-1"), name: "Simulator Set", tempo: 120, playing: false, position: 0, loop: { enabled: false, start: 0, length: 4 } },
    tracks: [track],
    scenes: [{ ref: ref("scene", "scene-1"), name: "Scene 1", index: 0 }],
    arrangement: { length: 16, locators: [{ ref: ref("automation", "locator-1"), name: "Intro", position: 0 }] },
    browser: [{ ref: ref("device", "utility-1"), name: "Utility", kind: "device" }, { ref: ref("clip", "sample-1"), name: "Kick Sample", kind: "sample" }],
    selected: track.ref,
  };
}

export class DeterministicLiveSimulator implements LiveAdapter {
  private state = createSimulatorState();
  private sequence = 0;
  private epoch = 1;
  private listeners = new Set<(event: LiveEvent) => void>();

  status(): LiveStatus { return { connected: true, adapter: "simulator", epoch: this.epoch, protocol: LIVE_PROTOCOL_VERSION, capabilities: LIVE_CAPABILITIES }; }
  snapshot(): LiveSnapshot { return structuredClone(this.state); }
  get(objectRef: LiveRef): unknown {
    if (objectRef === this.state.set.ref) return structuredClone(this.state.set);
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
  set(objectRef: LiveRef, property: string, value: unknown): void {
    const target = objectRef === this.state.set.ref ? this.state.set : this.find(objectRef);
    if (!target || !(property in target)) throw new Error(`unknown Live property: ${objectRef}.${property}`);
    if (property === "tempo") { if (target !== this.state.set || typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("tempo must be finite"); this.state.set.tempo = clamp(value, 20, 999); }
    else if (property === "volume" || property === "pan") { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${property} must be finite`); (target as Track)[property] = clamp(value, property === "pan" ? -1 : 0, 1); }
    else if (property === "playing" || property === "mute" || property === "solo" || property === "armed") { if (typeof value !== "boolean") throw new TypeError(`${property} must be boolean`); (target as Record<string, unknown>)[property] = value; }
    else if (property === "name") { if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new TypeError("name must be 1-256 characters"); (target as Record<string, unknown>)[property] = value; }
    else if (property === "value" && "min" in target && "max" in target) { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("parameter value must be finite"); (target as Parameter).value = clamp(value, (target as Parameter).min, (target as Parameter).max); }
    else throw new Error(`property is not writable: ${property}`);
    this.emit({ type: property === "playing" || property === "tempo" ? "transport" : "object", ref: objectRef, payload: { property, value } });
  }
  subscribe(listener: (event: LiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  reconnect(): LiveStatus { this.epoch += 1; this.emit({ type: "state", payload: { epoch: this.epoch, snapshot: this.snapshot() } }); return this.status(); }
  addNote(clipRef: LiveRef, note: Note): void { const clip = this.findClip(clipRef); if (clip.kind !== "midi") throw new Error("notes require a MIDI clip"); if (note.pitch < 0 || note.pitch > 127 || note.duration <= 0 || note.velocity < 1 || note.velocity > 127) throw new RangeError("invalid MIDI note"); clip.notes.push(structuredClone(note)); this.emit({ type: "object", ref: clipRef, payload: { operation: "note.add", note } }); }
  setAutomation(clipRef: LiveRef, point: AutomationPoint): void { const clip = this.findClip(clipRef); if (point.time < 0 || point.time > clip.length || !Number.isFinite(point.value)) throw new RangeError("automation point is outside the clip"); clip.automation.push(structuredClone(point)); this.emit({ type: "object", ref: clipRef, payload: { operation: "automation.add", point } }); }
  setWarp(clipRef: LiveRef, enabled: boolean): void { const clip = this.findClip(clipRef); if (clip.kind !== "audio") throw new Error("warp requires an audio clip"); clip.warp = enabled; this.emit({ type: "object", ref: clipRef, payload: { operation: "warp.set", enabled } }); }
  addTake(clipRef: LiveRef, take: string): void { const clip = this.findClip(clipRef); if (!take || take.length > 256 || clip.takes.includes(take)) throw new Error("invalid or duplicate take"); clip.takes.push(take); this.emit({ type: "object", ref: clipRef, payload: { operation: "take.add", take } }); }
  private find(objectRef: LiveRef): Track | Clip | Device | Parameter | undefined { for (const track of this.state.tracks) { if (track.ref === objectRef) return track; const clip = track.clips.find((item) => item.ref === objectRef); if (clip) return clip; for (const device of track.devices) { if (device.ref === objectRef) return device; const parameter = device.parameters.find((item) => item.ref === objectRef); if (parameter) return parameter; } } return undefined; }
  private findClip(objectRef: LiveRef): Clip { const value = this.find(objectRef); if (!value || !("notes" in value)) throw new Error(`unknown clip reference: ${objectRef}`); return value; }
  private emit(event: Omit<LiveEvent, "sequence">): void { const complete = { ...event, sequence: ++this.sequence }; for (const listener of this.listeners) listener(structuredClone(complete)); }
}

export class UnavailableLiveAdapter implements LiveAdapter {
  status(): LiveStatus { return { connected: false, adapter: "unavailable", epoch: null, protocol: LIVE_PROTOCOL_VERSION, capabilities: [], reason: "live-adapter-not-installed" }; }
  snapshot(): never { throw new Error("Live adapter unavailable"); }
  get(): never { throw new Error("Live adapter unavailable"); }
  set(): never { throw new Error("Live adapter unavailable"); }
  subscribe(): () => void { return () => undefined; }
  reconnect(): LiveStatus { return this.status(); }
}
