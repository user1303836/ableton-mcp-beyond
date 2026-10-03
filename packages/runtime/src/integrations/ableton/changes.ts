/**
 * Kumi's changes in Live. Each change tool runs the bridge's preview and apply as one step, so
 * the model never handles confirmations or idempotency keys, and each applied change becomes a
 * HISTORY entry with its own undo (the bridge's guarded live_undo). Titles are plain words for
 * producers; names inside them are data.
 */
import type { ChangeFamily, ChangeRecord, DevicePlacement, JsonObject } from "../../core/contracts.js";
import { ACTIONS } from "./actions.js";
import { FIXED_BRIDGE } from "./bridge-version.js";
import { MORE_CHANGES, MORE_REFERENCE_FIELDS } from "./more-changes.js";

/** A track as Kumi last saw it in discovery, for HISTORY's colour chip. */
export interface KnownTrack { name: string; color?: string }

/** What a change can look up while preparing: a sample by its path (one find_sounds returned, or any audio file), with its folder. */
export interface ChangeContext {
  sample(path: string): { path: string; folder: string } | undefined;
  /** A device's parameters as Live has them now (for a parameter named rather than referenced). */
  parameters(deviceRef: string): Promise<{ ref: string; name: string }[]>;
  /** A device's parameters with their ranges and where they are now, as Live shows them. */
  ranges(deviceRef: string): Promise<{ ref: string; name: string; min?: number; max?: number; value?: number; display?: string }[]>;
  /** A sample Kumi finds itself (at random, or the best match for the words), not one already picked in this answer. */
  pick(selector: SampleSelector): Promise<{ path: string; folder: string } | undefined>;
  /** The value that makes a parameter show `text` ("800 Hz", "-6 dB", "Saw"), from Live's own text across its range; or why not. */
  valueFor?(parameterRef: string, text: string): Promise<number | string>;
}
export interface SampleSelector { words?: string[]; folders?: string[]; random?: boolean }

/** A `sample` input: the path of an audio file (one find_sounds returned, or any on this computer), or a selector Kumi resolves itself (no search step in between). */
export const SAMPLE_INPUT = {
  description: "The path of an audio file (one find_sounds returned, or any on this computer), or {\"random\": true, \"words\": [\"kick\"]} for Kumi to pick one itself (words and folders optional)",
  anyOf: [
    { type: "string", minLength: 1, maxLength: 1024 },
    { type: "object", additionalProperties: false, properties: {
      random: { type: "boolean" }, words: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } },
      folders: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 1024 } } } },
  ],
} as const;

/** A sample for a change: found earlier, or picked now. A string is a refusal. */
async function sampleFor(input: unknown, context: ChangeContext): Promise<{ path: string; folder: string } | string> {
  if (typeof input === "string") return context.sample(input) ?? "Give the path of an audio file on this computer (one find_sounds returned, a recording, the producer's own), or {\"random\": true, \"words\": [...]} for Kumi to pick one.";
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const selector = input as JsonObject;
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return await context.pick({ words: strings(selector.words), folders: strings(selector.folders), random: selector.random === true }) ?? "No sample matches that; try other words or folders.";
  }
  return "Give the sample as the path of an audio file (one find_sounds returned, or any on this computer), or {\"random\": true, \"words\": [...]}.";
}

export interface ChangeSummary {
  title: string;
  track?: KnownTrack;
  from?: number;
  to?: number;
  range?: [number, number];
  clip?: ChangeRecord["clip"];
  colors?: ChangeRecord["colors"];
  /** What each part of a change did, for the answer; HISTORY shows the title. */
  lines?: string[];
  devices?: DevicePlacement;
}

export interface ChangeKind {
  /** The tool the model calls. */
  tool: string;
  preview: string;
  apply: string;
  family: ChangeFamily;
  description: string;
  /** Moves tracks or scenes, so earlier references point elsewhere afterwards. */
  restructures?: boolean;
  /** Adjust the preview's input schema where Kumi's behaviour differs from the bridge's wording. */
  schema?(schema: JsonObject): JsonObject;
  /** The model's input, when Kumi's tool asks for something other than the bridge's preview does. */
  inputSchema?: JsonObject;
  /** Prefer the advertised preview schema, retaining inputSchema for unavailable tools. */
  fallbackSchema?: boolean;
  /** Turn the model's input into the preview's; a string refuses, in words for the model. */
  prepare?(input: JsonObject, context: ChangeContext): JsonObject | string | Promise<JsonObject | string>;
  /** More to say when Live refuses the change (what would have been accepted), so the model fixes it in one go. */
  explain?(error: string, input: JsonObject, context: ChangeContext): Promise<string | undefined>;
  /** What the change made that a later step can use directly (a new track, a loaded device), from the bridge's answer. */
  produces?(applied: JsonObject): { ref: string; kind: "track" | "device" | "chain" | "session-clip" | "arrangement-clip" } | undefined;
  /** A change Live gives no way to take back (a rack's new chain): why, for HISTORY, which keeps it without an undo. */
  permanent?(input: JsonObject): string | undefined;
  /**
   * Offered even while the bridge doesn't advertise it, for changes whose target an earlier step
   * of the same answer creates (a Drum Rack's pads). `unavailable` says what to do first.
   */
  always?: boolean;
  unavailable?: string;
  /** Never offered to the model: make_changes uses it for several of its steps at once. */
  internal?: boolean;
  /** The first bridge version this works with in real Live; older bridges don't get the tool. */
  since?: string;
  /** `applied` is the bridge's apply result, when there is one: it can carry Live's own text for the new values. */
  summarize(preview: JsonObject, input: JsonObject, track: (ref: unknown) => KnownTrack | undefined, applied?: JsonObject): ChangeSummary;
}

const record = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const label = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined);
const quoted = (value: unknown, fallback: string) => { const text = label(value); return text ? `“${text}”` : fallback; };
export const formatNumber = (value: number, digits = 2) => String(Number(value.toFixed(digits)));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** A MIDI note as Live names it: 36 is C1, 60 is C3. */
/** Several parameters of one device changed as one: HISTORY's title, and a line for each in the answer. */
function parametersSummary(preview: JsonObject, input: JsonObject, track: (ref: unknown) => KnownTrack | undefined, applied?: JsonObject): ChangeSummary {
  const device = record(preview.device); const known = track(device.trackRef); const deviceName = label(device.name);
  const all = Array.isArray(preview.parameters) ? preview.parameters.map(record) : [];
  // A parameter set to the value it had isn't news.
  const moved = all.filter((row) => number(row.currentValue) !== number(row.proposedValue));
  const rows = moved.length ? moved : all;
  const after = new Map((Array.isArray(applied?.parameters) ? applied.parameters.map(record) : []).map((row) => [row.ref, row]));
  const lines = rows.map((parameter) => {
    const from = number(parameter.currentValue); const to = number(parameter.proposedValue);
    // Live's own text ("2.50 kHz", "-6.0 dB") when the bridge read it before and after; plain numbers otherwise.
    const text = shown(label(parameter.displayValue), label(after.get(parameter.ref)?.displayValue));
    const values = text ? ` ${text}` : from !== undefined && to !== undefined ? ` ${formatNumber(from)} → ${formatNumber(to)}` : "";
    return `${deviceName ? `${deviceName} · ` : ""}${label(parameter.name) ?? "parameter"}${values}`;
  });
  const count = rows.length || (Array.isArray(input.values) ? input.values.length : 0);
  return { title: `${deviceName ?? "Device"} · ${count} parameter${count === 1 ? "" : "s"}`, lines, ...(known ? { track: known } : {}) };
}

/** Where a device landed, from the bridge's answer, for NOW's picture. */
function placement(value: unknown): DevicePlacement | undefined {
  const row = record(value);
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string").slice(0, 16).map((item) => item.slice(0, 64)) : undefined);
  const chains = Array.isArray(row.chains) ? row.chains.slice(0, 8).map(record).map((chain) => ({ name: label(chain.name) ?? "Chain", devices: names(chain.devices) ?? [] })) : undefined;
  const devices = names(row.devices);
  if (!chains?.length && !devices?.length) return undefined;
  const index = number(row.index); const chain = number(row.chain);
  return { ...(devices?.length ? { devices } : {}), ...(index !== undefined && index >= 0 ? { index } : {}), ...(label(row.rack) ? { rack: label(row.rack)! } : {}),
    ...(chains?.length ? { chains } : {}), ...(chain !== undefined && chain >= 0 ? { chain } : {}) };
}

/** Which instrument a pad's sample goes into: Simpler, or Live 12's Drum Sampler when asked. */
const PAD_INSTRUMENT: JsonObject = { type: "string", enum: ["Simpler", "Drum Sampler"], description: "Simpler unless the producer asks for Drum Sampler" };

/** A sample's name as Live shows it: the file's name without its extension. */
const fileName = (path: unknown) => (typeof path === "string" ? path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : undefined);
export const noteName = (note: number) => `${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][note % 12]}${Math.floor(note / 12) - 2}`;
/** Live's 0xRRGGBB colours as "#rrggbb". */
export const hexColor = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF ? `#${value.toString(16).padStart(6, "0")}` : undefined);

/** A value stays whole when a line wraps: its number and unit are joined by a no-break space. */
const whole = (text: string) => text.trim().replace(/ /g, "\u00a0");
/** "0.0 dB → -3.2 dB" from Live's own text, when both sides have it. */
const shown = (before: unknown, after: unknown) => (typeof before === "string" && typeof after === "string" && before && after ? `${whole(before)} → ${whole(after)}` : undefined);

function mixerParts(prior: JsonObject, proposed: JsonObject, was: JsonObject, now: JsonObject): string[] {
  const parts: string[] = [];
  const volume = number(proposed.volume); const before = number(prior.volume);
  const volumeText = shown(was.volume, now.volume);
  if (volume !== undefined) parts.push(volumeText ? `volume ${volumeText}` : before === undefined || volume === before ? "volume" : volume > before ? "volume up" : "volume down");
  const pan = number(proposed.pan);
  const panText = shown(was.pan, now.pan);
  if (pan !== undefined) parts.push(panText ? `pan ${panText}` : pan === 0 ? "pan centre" : pan < 0 ? "pan left" : "pan right");
  if (typeof proposed.mute === "boolean") parts.push(proposed.mute ? "muted" : "unmuted");
  if (typeof proposed.solo === "boolean") parts.push(proposed.solo ? "soloed" : "unsoloed");
  if (number(proposed.cueVolume) !== undefined) parts.push("cue volume");
  if (Array.isArray(proposed.sends) && proposed.sends.length) {
    const before = Array.isArray(was.sends) ? was.sends : []; const after = Array.isArray(now.sends) ? now.sends : [];
    const named = proposed.sends.map((_, index) => { const text = shown(before[index], after[index]); return text && text.split(" → ")[0] !== text.split(" → ")[1] ? `send ${String.fromCharCode(65 + index)} ${text}` : undefined; }).filter(Boolean) as string[];
    parts.push(...(named.length ? named : [proposed.sends.length === 1 ? "send A" : "sends"]));
  }
  return parts;
}

/**
 * The changes Kumi can make, one tool each. Every one was exercised on real Live with its
 * undo (see docs/evidence/kumi-poc.md); a change is only offered while the bridge advertises
 * both its preview and apply for the open Set.
 */
/** The parameter schema with a name allowed where a reference goes: `parameter` for one, and in each of `values`. */
function namedParameters(schema: JsonObject): JsonObject {
  const properties = { ...((schema.properties ?? {}) as JsonObject) };
  const NAME = { type: "string", minLength: 1, maxLength: 128, description: "The parameter's name on the device, as Live shows it; instead of parameterRef" };
  // A value as a number in the parameter's range, or as the device shows it: Kumi reads the device's own text to place it.
  const VALUE = { anyOf: [{ type: "number" }, { type: "string", minLength: 1, maxLength: 48 }], description: "A number in the parameter's range, or the value as the device shows it (\"800 Hz\", \"-6 dB\", \"35 %\", \"1.2 s\", \"Saw\")" };
  properties.parameter = NAME;
  if (properties.value !== undefined) properties.value = VALUE;
  const values = properties.values as JsonObject | undefined;
  if (values && typeof values.items === "object") {
    const items = values.items as JsonObject;
    const itemProperties: JsonObject = { ...((items.properties ?? {}) as JsonObject), parameter: NAME };
    if (itemProperties.value !== undefined) itemProperties.value = VALUE;
    properties.values = { ...values, items: { ...items, properties: itemProperties,
      required: ((items.required as string[] | undefined) ?? []).filter((field) => field !== "parameterRef") } };
  }
  return { ...schema, properties };
}

/** Parameters named rather than referenced, found on the device as it is now (exact name first, then a prefix). */
async function resolveParameters(given: JsonObject, context: ChangeContext): Promise<JsonObject | string> {
  // A number written as text ("0.55") is that number.
  const numeric = (value: unknown) => (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value);
  const input: JsonObject = { ...given, ...(given.value !== undefined ? { value: numeric(given.value) } : {}),
    ...(Array.isArray(given.values) ? { values: given.values.map((item) => (item && typeof item === "object" && !Array.isArray(item) && "value" in item ? { ...(item as JsonObject), value: numeric((item as JsonObject).value) } : item)) } : {}) };
  const named = typeof input.parameter === "string" || (Array.isArray(input.values) && input.values.some((item) => item && typeof item === "object" && typeof (item as JsonObject).parameter === "string"));
  if (!named) return displayed(input, context);
  if (typeof input.deviceRef !== "string") return "Name the device (deviceRef) whose parameter this is.";
  const list = await context.parameters(input.deviceRef);
  const find = (name: string) => { const wanted = name.trim().toLowerCase(); return list.find((row) => row.name.toLowerCase() === wanted) ?? list.find((row) => row.name.toLowerCase().startsWith(wanted)); };
  const missing = (name: string) => `The device has no parameter called ${JSON.stringify(name.slice(0, 64))}; its parameters include ${list.slice(0, 12).map((row) => row.name).join(", ")}.`;
  const { parameter, ...rest } = input;
  if (typeof parameter === "string") {
    const found = find(parameter);
    if (!found) return missing(parameter);
    return { ...rest, parameterRef: found.ref };
  }
  const values: JsonObject[] = [];
  for (const item of input.values as JsonObject[]) {
    if (typeof item?.parameter !== "string") { values.push(item); continue; }
    const found = find(item.parameter);
    if (!found) return missing(item.parameter);
    const { parameter: _name, ...value } = item;
    values.push({ ...value, parameterRef: found.ref });
  }
  return displayed({ ...rest, values }, context);
}

/**
 * Values written as the device shows them ("800 Hz", "-6 dB", "Saw") become the values that show them, read from
 * Live's own text across each parameter's range; numbers pass as they are. A text Kumi can't place says why.
 */
async function displayed(input: JsonObject, context: ChangeContext): Promise<JsonObject | string> {
  const text = (value: unknown) => typeof value === "string" && value.trim() !== "" && !Number.isFinite(Number(value));
  const convert = async (parameterRef: unknown, value: unknown): Promise<unknown> => {
    if (!text(value) || typeof parameterRef !== "string") return value;
    if (!context.valueFor) return `Give ${JSON.stringify(value)} as a number in the parameter's range: Kumi can't read this parameter's units here.`;
    const found = await context.valueFor(parameterRef, value as string);
    return found;
  };
  if (input.value !== undefined && typeof input.parameterRef === "string") {
    const value = await convert(input.parameterRef, input.value);
    if (typeof value === "string" && text(input.value)) return value;
    return { ...input, value };
  }
  if (Array.isArray(input.values)) {
    const values: unknown[] = [];
    for (const item of input.values) {
      if (!item || typeof item !== "object" || Array.isArray(item)) { values.push(item); continue; }
      const row = item as JsonObject;
      const value = await convert(row.parameterRef, row.value);
      if (typeof value === "string" && text(row.value)) return value;
      values.push({ ...row, value });
    }
    return { ...input, values };
  }
  return input;
}

/** Live refused a value: each parameter it was for, with the range it takes and where it is now. */
async function explainParameters(error: string, input: JsonObject, context: ChangeContext): Promise<string | undefined> {
  if (!/bounds|finite value|value .*required|range/i.test(error) || typeof input.deviceRef !== "string") return undefined;
  const list = await context.ranges(input.deviceRef);
  const refs = new Set([input.parameterRef, ...(Array.isArray(input.values) ? input.values.map((item) => (item && typeof item === "object" ? (item as JsonObject).parameterRef : undefined)) : [])].filter((ref): ref is string => typeof ref === "string"));
  const asked = list.filter((row) => refs.has(row.ref));
  const shown = (asked.length ? asked : list).slice(0, 16).flatMap((row) => row.min === undefined || row.max === undefined ? [] :
    [`${row.name} takes ${formatNumber(row.min)} to ${formatNumber(row.max)}${row.value !== undefined ? ` (now ${formatNumber(row.value)}${row.display ? `, shown as ${row.display}` : ""})` : ""}`]);
  return shown.length ? `Values are the parameter's own, between its min and max, not what Live shows: ${shown.join("; ")}.` : undefined;
}

const BASE_CHANGES: readonly ChangeKind[] = [
  {
    tool: "set_tempo", preview: "live_tempo_preview", apply: "live_tempo_apply", family: "tempo",
    description: "Change the Set's tempo in BPM (20–999).",
    summarize(preview) {
      const from = number(preview.priorTempo); const to = number(preview.proposedTempo);
      return { title: from !== undefined && to !== undefined ? `Tempo ${formatNumber(from)} → ${formatNumber(to)} BPM` : "Tempo changed", ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
    },
  },
  {
    tool: "set_mixer", preview: "live_mixer_preview", apply: "live_mixer_apply", family: "mixer",
    description: "Change one track's mixer. volume is the fader position from 0 to 1 (0.85 is 0 dB, 1 is +6 dB); pan goes from -1 (left) to 1 (right); mute and solo are on/off; sends are levels from 0 to 1 for return tracks A, B, … in order (a shorter list leaves the rest). trackRef comes from discovery in this turn; return tracks and the main track work too.",
    summarize(preview, _input, track, applied) {
      const prior = record(preview.prior); const proposed = record(preview.proposed);
      const known = track(preview.trackRef);
      const parts = mixerParts(prior, proposed, record(preview.priorDisplay), record(applied?.display));
      const from = number(prior.volume); const to = number(proposed.volume);
      return { title: `${known?.name ?? "Track"} ${parts.join(", ") || "mixer"}`, ...(known ? { track: known } : {}),
        ...(from !== undefined && to !== undefined ? { from, to, range: [0, 1] as [number, number] } : {}) };
    },
  },
  {
    tool: "rename", preview: "live_object_rename_preview", apply: "live_object_rename_apply", family: "rename",
    description: "Rename a track, scene, clip, device or locator. kind says which; ref comes from discovery in this turn.",
    summarize(preview, input, track) {
      const target = record(preview.target);
      const kind = label(target.kind) ?? label(input.kind) ?? "item";
      const known = kind === "track" ? track(target.ref ?? input.ref) : undefined;
      return { title: `Renamed ${kind} ${quoted(target.currentName, "(unnamed)")} → ${quoted(preview.proposedName ?? input.name, "(unnamed)")}`,
        ...(known ? { track: { ...known, name: label(preview.proposedName ?? input.name) ?? known.name } } : {}) };
    },
  },
  {
    tool: "add_tracks_and_scenes", preview: "live_session_structure_preview", apply: "live_session_structure_apply", family: "structure", restructures: true,
    produces(applied) {
      const created = Array.isArray(applied.created) ? applied.created.map(record).find((item) => item.kind === "track" && typeof item.ref === "string") : undefined;
      return created ? { ref: created.ref as string, kind: "track" } : undefined;
    },
    description: "Add new MIDI or audio tracks and named scenes. New ones go after the last track or scene unless you give an index (0 is first). Earlier track and scene references are out of date afterwards; discover again before using them.",
    schema(schema) {
      const copy = structuredClone(schema);
      for (const list of ["tracks", "scenes"]) {
        const index = record(record(record(record(copy.properties)[list]).items).properties).index;
        if (index && typeof index === "object") (index as JsonObject).description = "Position, 0 is first. Leave it out to add after the last one.";
      }
      return copy;
    },
    summarize(preview) {
      const proposed = Array.isArray(preview.proposed) ? preview.proposed.map(record) : [];
      const tracks = proposed.filter((item) => item.kind === "track");
      const scenes = proposed.filter((item) => item.kind === "scene");
      if (tracks.length === 1 && !scenes.length) {
        const kind = tracks[0]!.trackKind === "audio" ? "audio" : "MIDI";
        return { title: `Added ${kind} track ${quoted(tracks[0]!.name, "")}`.trim(), track: { name: label(tracks[0]!.name) ?? `New ${kind} track` } };
      }
      if (scenes.length === 1 && !tracks.length) return { title: `Added scene ${quoted(scenes[0]!.name, "")}`.trim() };
      return { title: `Added ${[tracks.length ? plural(tracks.length, "track") : "", scenes.length ? plural(scenes.length, "scene") : ""].filter(Boolean).join(" and ") || "tracks and scenes"}` };
    },
  },
  {
    tool: "write_midi_clip", preview: "live_midi_clip_preview", apply: "live_midi_clip_apply", family: "clip",
    produces(applied) { return typeof applied.clipRef === "string" ? { ref: applied.clipRef, kind: "session-clip" } : undefined; },
    description: "Write a new MIDI clip into an empty Session slot. trackRef is a MIDI track from discovery in this turn; sceneIndex 0 is the first scene; length and every note's start and duration are in beats from the clip start (a 4/4 bar is 4 beats); pitch 60 is middle C (C3 in Live); velocity is 1–127.",
    summarize(preview, input, track) {
      const proposed = record(preview.proposed);
      const source: unknown[] = Array.isArray(proposed.notes) ? proposed.notes : Array.isArray(input.notes) ? input.notes : [];
      const known = track(record(preview.target).trackRef ?? input.trackRef);
      const length = number(proposed.length ?? input.length);
      // The notes as written, for NOW's picture of the clip.
      const notes = source.slice(0, 512).flatMap((item) => {
        const note = record(item); const pitch = number(note.pitch); const start = number(note.start); const duration = number(note.duration);
        return pitch !== undefined && start !== undefined && duration !== undefined && duration > 0 ? [{ pitch, start, duration, velocity: number(note.velocity) ?? 100 }] : [];
      });
      return { title: `New MIDI clip ${quoted(proposed.name ?? input.name, "")} · ${plural(source.length, "note")}`.replace("  ", " "), ...(known ? { track: known } : {}),
        ...(length !== undefined && length > 0 && notes.length ? { clip: { length, notes } } : {}) };
    },
  },
  {
    tool: "load_sample", preview: "live_device_preview", apply: "live_device_apply", family: "device",
    description: "Load a sample into a new Simpler on an empty MIDI track (add the track first): one change, undone as one. sample is the path of an audio file (one find_sounds returned, or any on this computer); trackRef comes from discovery in this turn or the track just added.",
    inputSchema: { type: "object", additionalProperties: false, required: ["trackRef", "sample"], properties: {
      trackRef: { type: "string", minLength: 1, maxLength: 256 }, sample: SAMPLE_INPUT } },
    async prepare(input, context) {
      const found = await sampleFor(input.sample, context);
      if (typeof found === "string") return found;
      return { action: "insert", trackRef: input.trackRef ?? null, deviceName: "Simpler", filePath: found.path, allowedRoot: found.folder };
    },
    produces(applied) {
      const created = record(applied.result);
      return typeof created.ref === "string" ? { ref: created.ref, kind: "device" } : undefined;
    },
    summarize(_preview, input, track) {
      const file = fileName(input.filePath);
      const known = track(input.trackRef);
      return { title: `Loaded ${quoted(file, "a sample")} into a new Simpler${known ? ` on ${known.name}` : ""}`, ...(known ? { track: known } : {}) };
    },
  },
  {
    tool: "load_sample_to_pad", preview: "live_drum_pad_preview", apply: "live_drum_pad_apply", family: "device", always: true,
    unavailable: "There's no Drum Rack in the Set yet: load one with load_device first (search the Browser for \"Drum Rack\"), then its pads can take samples.",
    description: "Load a sample onto an empty pad of a Drum Rack, in a new Simpler on that pad, or in Live 12's Drum Sampler with instrument \"Drum Sampler\"; undo clears the pad. deviceRef is the Drum Rack from discovery in this turn; note is the pad's note: 36 (C1) is the first pad, then 37, 38 and so on up to 51 on a new rack. sample is the path of an audio file (one find_sounds returned, or any on this computer).",
    inputSchema: { type: "object", additionalProperties: false, required: ["deviceRef", "note", "sample"], properties: {
      deviceRef: { type: "string", minLength: 1, maxLength: 256 }, note: { type: "integer", minimum: 0, maximum: 127, description: "The pad: 36 is C1, the first pad" },
      sample: SAMPLE_INPUT, instrument: PAD_INSTRUMENT } },
    async prepare(input, context) {
      const found = await sampleFor(input.sample, context);
      if (typeof found === "string") return found;
      return { action: "load-sample", deviceRef: input.deviceRef ?? null, note: input.note ?? null, filePath: found.path, allowedRoot: found.folder, ...(input.instrument === "Drum Sampler" ? { instrument: "Drum Sampler" } : {}) };
    },
    summarize(preview, input) {
      const file = fileName(input.filePath);
      const note = number(preview.note ?? input.note);
      return { title: `Loaded ${quoted(file, "a sample")} onto Drum Rack pad ${note !== undefined ? noteName(note) : ""}`.trimEnd() + (input.instrument === "Drum Sampler" ? " in a Drum Sampler" : "") };
    },
  },
  {
    // make_changes turns a run of load_sample_to_pad steps on one rack into this: one Live request for all the pads.
    tool: "load_samples_to_pads", preview: "live_drum_pad_preview", apply: "live_drum_pad_apply", family: "device", internal: true,
    description: "Load samples onto empty pads of one Drum Rack as one change; undo clears them all.",
    async prepare(input, context) {
      const pads: JsonObject[] = [];
      for (const pad of Array.isArray(input.pads) ? input.pads.map(record) : []) {
        const found = await sampleFor(pad.sample, context);
        if (typeof found === "string") return `Pad ${number(pad.note) !== undefined ? noteName(pad.note as number) : "?"}: ${found}`;
        pads.push({ note: pad.note ?? null, filePath: found.path, allowedRoot: found.folder, ...(pad.instrument === "Drum Sampler" ? { instrument: "Drum Sampler" } : {}) });
      }
      return { action: "load-samples", deviceRef: input.deviceRef ?? null, pads };
    },
    summarize(_preview, input) {
      const pads = Array.isArray(input.pads) ? input.pads.map(record) : [];
      const notes = pads.map((pad) => number(pad.note)).filter((note): note is number => note !== undefined);
      const run = notes.length === pads.length && notes.length > 1 && notes.every((note, index) => index === 0 || note === notes[index - 1]! + 1);
      const where = run ? `${noteName(notes[0]!)}–${noteName(notes.at(-1)!)}` : notes.map(noteName).join(", ");
      const into = (pad: JsonObject) => (pad.instrument === "Drum Sampler" ? " in a Drum Sampler" : "");
      const every = pads.length > 0 && pads.every((pad) => pad.instrument === "Drum Sampler");
      return { title: `Loaded ${pads.length} samples onto Drum Rack pads ${where}`.trimEnd() + (every ? " in Drum Samplers" : ""),
        lines: pads.map((pad) => `Loaded ${quoted(fileName(pad.filePath), "a sample")} onto Drum Rack pad ${number(pad.note) !== undefined ? noteName(pad.note as number) : ""}`.trimEnd() + into(pad)) };
    },
  },
  {
    tool: "load_device", preview: "live_browser_load_preview", apply: "live_browser_load_apply", family: "device",
    produces(applied) {
      const reference = applied.deviceRef ?? record(applied.created).deviceRef;
      return typeof reference === "string" ? { ref: reference, kind: "device" } : undefined;
    },
    description: "Load an instrument, effect, Max for Live device or preset from Live's Browser onto a track (after its devices) or, with chainRef instead, into a rack's chain (after the chain's devices; a chain can hold a rack too). itemId is the Browser path, such as \"instruments/Drum Rack\", \"instruments/Operator\" or \"audio_effects/Reverb\"; live_browser_search finds others. A track or a chain takes one instrument: to layer instruments, load an Instrument Rack, add a chain for each with edit_rack, and load one into each. trackRef and chainRef come from discovery in this turn or an earlier step.",
    summarize(preview, input, track, applied) {
      const known = track(preview.trackRef ?? input.trackRef);
      const devices = placement(applied?.placement);
      // Live names a chain after what's in it, so it's the chain's number that says which one.
      const into = label(preview.chainName) ? ` into ${label(preview.rackName) ?? "the rack"} (chain ${devices?.chain !== undefined ? devices.chain + 1 : quoted(preview.chainName, "")})` : "";
      return { title: `Loaded ${label(record(preview.item).name) ?? "a device"}${into}${known ? ` on ${known.name}` : ""}`, ...(known ? { track: known } : {}), ...(devices ? { devices } : {}) };
    },
  },
  {
    tool: "set_device_parameter", preview: "live_device_parameter_preview", apply: "live_device_parameter_apply", family: "parameter",
    description: "Set one device parameter to a value between its min and max, or several of one device at once with values (one change, one undo) when offered. deviceRef and parameterRef come from discovery in this turn; instead of parameterRef, parameter names it (\"Drive\"), found on the device when the step runs: that's how a plan or a recipe sets a device an earlier step loaded (deviceRef \"@sat\").",
    schema: namedParameters,
    prepare: (input, context) => resolveParameters(input, context),
    explain: explainParameters,
    summarize(preview, input, track, applied) {
      if (Array.isArray(preview.parameters)) return parametersSummary(preview, input, track, applied);
      const parameter = record(preview.parameter); const device = record(preview.device);
      const name = label(parameter.name) ?? "parameter";
      const from = number(parameter.currentValue); const to = number(parameter.proposedValue ?? input.value);
      const known = track(device.trackRef);
      // Live's own text ("2.50 kHz", "-6.0 dB") when the bridge read it before and after; plain numbers otherwise.
      const text = shown(label(parameter.displayValue), label(applied?.displayValue));
      const values = text ? ` ${text}` : from !== undefined && to !== undefined ? ` ${formatNumber(from)} → ${formatNumber(to)}` : "";
      const min = number(parameter.min); const max = number(parameter.max);
      return { title: `${label(device.name) ? `${label(device.name)} · ` : ""}${name}${values}`, ...(known ? { track: known } : {}),
        ...(from !== undefined && to !== undefined ? { from, to, ...(min !== undefined && max !== undefined && max > min ? { range: [min, max] as [number, number] } : {}) } : {}) };
    },
  },
  {
    // make_changes turns a run of set_device_parameter steps on one device into this: one Live request for them all.
    tool: "set_device_parameters", preview: "live_device_parameter_preview", apply: "live_device_parameter_apply", family: "parameter", internal: true,
    description: "Set several parameters of one device as one change; undo restores them all.",
    prepare: (input, context) => resolveParameters(input, context),
    explain: explainParameters,
    summarize: (preview, input, track, applied) => parametersSummary(preview, input, track, applied),
  },
  {
    tool: "edit_rack", preview: "live_rack_preview", apply: "live_rack_apply", family: "device", always: true,
    unavailable: "There's no rack in the Set yet: load an Instrument Rack, Audio Effect Rack or MIDI Effect Rack with load_device first.",
    description: "Work on a rack (instrument, audio effect, MIDI effect or drum rack): add-chain (chains play side by side, in parallel; mark it with as and load devices into it with load_device's chainRef; index 0 is first), add-macro or remove-macro, randomize-macros (Live's Rand button), store-variation (the macros' current settings, as a new variation), recall-variation or delete-variation (index), select-variation (index), or copy-pad (a drum rack's pad sourceIndex to targetIndex, notes 0–127). rackRef is the rack from discovery in this turn or an earlier step. Macro values are the rack's \"Macro 1\", \"Macro 2\", … parameters: set them with set_device_parameter.",
    inputSchema: { type: "object", additionalProperties: false, required: ["rackRef", "action"], properties: {
      rackRef: { type: "string", minLength: 1, maxLength: 256 },
      action: { type: "string", enum: ["add-chain", "add-macro", "remove-macro", "randomize-macros", "store-variation", "recall-variation", "delete-variation", "select-variation", "copy-pad"] },
      index: { type: "integer", minimum: 0, maximum: 256, description: "add-chain: where the chain goes, 0 is first (left out, after the last); variations: which one, 0 is first" },
      sourceIndex: { type: "integer", minimum: 0, maximum: 127 }, targetIndex: { type: "integer", minimum: 0, maximum: 127 } } },
    prepare(input) {
      const action = input.action === "add-chain" ? "insert-chain" : input.action === "select-variation" ? "set" : input.action;
      const known = ["insert-chain", "add-macro", "remove-macro", "randomize-macros", "store-variation", "recall-variation", "delete-variation", "set", "copy-pad"];
      if (typeof action !== "string" || !known.includes(action)) return "action is add-chain, add-macro, remove-macro, randomize-macros, store-variation, recall-variation, delete-variation, select-variation or copy-pad.";
      const index = typeof input.index === "number" ? input.index : undefined;
      if ((action === "recall-variation" || action === "delete-variation" || action === "set") && index === undefined) return "Say which variation: index, 0 is the first.";
      if (action === "copy-pad" && (typeof input.sourceIndex !== "number" || typeof input.targetIndex !== "number")) return "copy-pad takes sourceIndex and targetIndex (pad notes).";
      return { action, rackRef: input.rackRef ?? null,
        ...(action === "insert-chain" && index !== undefined ? { index } : {}), ...(action === "recall-variation" || action === "delete-variation" ? { index } : {}),
        ...(action === "set" ? { selectedVariationIndex: index } : {}), ...(action === "copy-pad" ? { sourceIndex: input.sourceIndex, targetIndex: input.targetIndex } : {}) };
    },
    produces(applied) { return typeof applied.chainRef === "string" ? { ref: applied.chainRef, kind: "chain" } : undefined; },
    permanent: (input) => (input.action === "insert-chain" ? "Live gives Kumi no way to take a chain away again; delete it in Live if you don't want it."
      : input.action === "delete-variation" ? "Live gives Kumi no way to bring a deleted variation back." : undefined),
    summarize(preview, input, _track, applied) {
      const devices = placement(applied?.placement);
      const rack = devices?.rack ?? label(preview.rackName) ?? "the rack";
      if (input.action === "insert-chain") return { title: `Added chain ${devices?.chain !== undefined ? `${devices.chain + 1} ` : ""}to ${rack}`, ...(devices ? { devices } : {}) };
      const index = number(input.index ?? input.selectedVariationIndex);
      if (input.action === "randomize-macros") return { title: `Randomized ${rack}'s macros` };
      if (input.action === "store-variation") return { title: `Stored a variation of ${rack}'s macros` };
      if (input.action === "recall-variation") return { title: `Recalled variation ${(index ?? 0) + 1} of ${rack}` };
      if (input.action === "delete-variation") return { title: `Deleted variation ${(index ?? 0) + 1} of ${rack}` };
      if (input.action === "set") return { title: `Selected variation ${(index ?? 0) + 1} of ${rack}` };
      if (input.action === "copy-pad") return { title: `Copied pad ${noteName(number(input.sourceIndex) ?? 0)} to ${noteName(number(input.targetIndex) ?? 0)} in ${rack}` };
      const count = number(applied?.visibleMacroCount); const before = number(record(preview.prior).visibleMacroCount);
      return { title: input.action === "add-macro" ? `Added a macro to ${rack}` : `Removed a macro from ${rack}`, ...(count !== undefined ? { from: before ?? count, to: count, range: [1, 16] as [number, number] } : {}) };
    },
  },
  {
    tool: "set_chain_mixer", preview: "live_chain_mixer_preview", apply: "live_chain_mixer_apply", family: "mixer",
    description: "Balance a rack's chains: one chain's volume (0 to 1; 0.85 is 0 dB), pan (-1 left to 1 right), or chainActivator false to switch the chain off (true on). chainRef comes from discovery in this turn or an earlier step.",
    summarize(preview) {
      const prior = record(preview.prior); const proposed = record(preview.proposed);
      const parts = mixerParts(prior, proposed, {}, {});
      if (typeof proposed.chainActivator === "boolean") parts.push(proposed.chainActivator ? "on" : "off");
      const from = number(prior.volume); const to = number(proposed.volume);
      return { title: `${label(preview.rackName) ? `${label(preview.rackName)} · ` : ""}chain ${quoted(preview.chainName, "")} ${parts.join(", ") || "mixer"}`.replace("  ", " "),
        ...(from !== undefined && to !== undefined ? { from, to, range: [0, 1] as [number, number] } : {}) };
    },
  },
  {
    tool: "set_locators", preview: "live_arrangement_section_preview", apply: "live_arrangement_section_apply", family: "locators",
    description: "Mark a section in the Arrangement with two named locators. start and end are in beats from the start of the song (bar 1 is beat 0; a 4/4 bar is 4 beats).",
    summarize(_preview, input) {
      const start = number(input.start); const end = number(input.end);
      return { title: `Locators ${quoted(input.startName, "")} and ${quoted(input.endName, "")}${start !== undefined && end !== undefined ? ` (beats ${formatNumber(start)}–${formatNumber(end)})` : ""}`.replace("  ", " ") };
    },
  },
  {
    tool: "set_track_color", preview: "live_track_properties_preview", apply: "live_track_properties_apply", family: "color",
    description: "Change a track's colour to one of Live's 70 palette colours (colorIndex 0–69). ref comes from discovery in this turn.",
    summarize(preview, input, track, applied) {
      const known = track(preview.ref ?? input.ref);
      // The track as it looks now: the new colour, when the bridge reported it, for its chip and swatches.
      const to = hexColor(applied?.color);
      return { title: `${known?.name ?? "Track"} colour changed`, ...(known ? { track: { ...known, ...(to ? { color: to } : {}) } } : {}),
        ...(to ? { colors: { ...(known?.color ? { from: known.color } : {}), to } } : {}) };
    },
  },
];

/** Every change Kumi can make: the first ones, then the rest of what Live exposes. */
export const CHANGES: readonly ChangeKind[] = [...BASE_CHANGES, ...MORE_CHANGES, {
  tool: "set_sidechain", since: FIXED_BRIDGE, preview: "live_device_io_preview", apply: "live_device_io_apply", family: "device",
  description: "Feed a device from another track: a compressor's (or gate's, or auto filter's) sidechain, with action sidechain, deviceRef, and routingType and routingChannel exactly as Live names them (discover the device to see its choices); action routing for a device's own audio or MIDI input. The classic: the kick ducking the bass.",
  summarize(_preview, input, track) {
    const source = typeof input.routingType === "string" ? input.routingType.slice(0, 80) : "another track";
    const owner = typeof input.deviceRef === "string" ? /^(\d+):device:(\d+)/.exec(input.deviceRef) : null;
    const known = owner ? track(`${owner[1]}:track:${owner[2]}`) : undefined;
    return { title: `${input.action === "sidechain" ? "Sidechain" : "Device input"} from ${source}${known ? ` on ${known.name}` : ""}`, ...(known ? { track: known } : {}) };
  },
}];

export const UNDO_TOOL = "undo_change";
export const UNDO_DESCRIPTION = "Undo one of your changes from this session: pass its change id (such as c3), or \"last\" for the latest one. It only works while nobody changed the same thing in Live since; if so, say what happened. With final: true, when the undo is all that was asked, Kumi tells the producer and the answer ends there, with no reply from you.";

/** Bridge tools only Kumi calls, behind its change tools: previews, applies and undo. */
/** Stops clips, the transport and recording at once, whatever Live is doing: Kumi's stop when the ordinary one can't. */
export const EMERGENCY_STOP = "live_session_emergency_stop";
export const HOST_TOOLS: ReadonlySet<string> = new Set([...CHANGES.flatMap((kind) => [kind.preview, kind.apply]), ...ACTIONS.flatMap((kind) => [kind.preview, kind.apply]), "live_undo", "live_transaction_release", EMERGENCY_STOP,
  // A plan as one Live undo step, a change in one call, Live's events, and the extension's offline render.
  "live_undo_step_begin", "live_undo_step_end", "live_change", "live_subscribe", "live_render_offline", "live_song_undo", "live_song_redo"]);

/** The fields of a change tool's input that name Live objects; they must come from discovery in this turn. */
export const REFERENCE_FIELDS = ["trackRef", "ref", "clipRef", "deviceRef", "parameterRef", "chainRef", "rackRef", ...MORE_REFERENCE_FIELDS] as const;

/** A bridge refusal, in plain words for HISTORY. The model also gets the bridge's own message. */
export function undoNote(message: string): string {
  if (/created Session structure was modified|Session structure changed before deletion/i.test(message)) return "It changed after Kumi made it (something recorded, loaded or routed on it), so Kumi left it: deleting it would lose that. Delete it in Live if you don't need it.";
  if (/epoch|connection/i.test(message)) return "Live restarted or reconnected since, so Kumi can't undo this.";
  if (/doesn't offer/i.test(message)) return "Live doesn't offer what it was routed from before any more (an input with no audio device, or a track that no longer makes sound), so Kumi left it. Change it in Live if you need to.";
  if (/highest positional authority/i.test(message)) return "A track Kumi made after it is still there, so Kumi left this one. Delete it in Live if you don't need it.";
  if (/stop playback first/i.test(message)) return "Stop playback, then undo it: putting the playhead back while playing would be heard.";
  if (/unknown|expired|not found/i.test(message)) return "Kumi can't undo this anymore.";
  if (/changed|modified|refused|postcondition|no longer|fingerprint|revision|identity|mismatch/i.test(message)) return "It changed in Live since, so Kumi left it as it is.";
  if (/momentary|structural|not undoable/i.test(message)) return "Live gives Kumi no way to take this back; change it in Live if you need to.";
  return "Live didn't accept the undo, so Kumi left it as it is.";
}

let counter = 0;
/** Change ids are unique for the process, so HISTORY never mixes up two sessions' changes. */
export function nextChangeId(): string {
  counter++;
  return `c${counter}`;
}

export function newRecord(kind: ChangeKind, summary: ChangeSummary, state: ChangeRecord["state"], at: number): ChangeRecord {
  return { id: nextChangeId(), family: kind.family, title: summary.title, state, at,
    ...(summary.track ? { track: summary.track } : {}),
    ...(summary.from !== undefined ? { from: summary.from } : {}), ...(summary.to !== undefined ? { to: summary.to } : {}),
    ...(summary.range ? { range: summary.range } : {}), ...(summary.clip ? { clip: summary.clip } : {}), ...(summary.colors ? { colors: summary.colors } : {}),
    ...(summary.devices ? { devices: summary.devices } : {}) };
}
