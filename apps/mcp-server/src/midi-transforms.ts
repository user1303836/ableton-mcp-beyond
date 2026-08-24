import { createHash } from "node:crypto";
import type { Note } from "./live.js";

/**
 * Deterministic, seeded MIDI transformation primitives. Every transform is a
 * pure function over the canonical note schema: identical input notes,
 * parameters, and seed always produce byte-for-byte identical output. No
 * transform performs taste judgment or artist imitation, and none authors
 * per-note Pitch/Slide/Pressure — those fields are not in the canonical note
 * schema and are never fabricated here.
 */

export const MIDI_TRANSFORM_TYPES = ["transpose", "scale-constrain", "quantize", "swing", "velocity-curve", "humanize-velocity", "humanize-timing", "legato", "staccato", "rotate", "repeat", "ratchet", "chord-voicing", "arpeggiate", "seeded-variation"] as const;
export type MidiTransformType = typeof MIDI_TRANSFORM_TYPES[number];

/** Transforms that only patch fields of existing notes via note.update (which
 * preserves unexposed per-note data server-side). */
export const UPDATE_ONLY_TRANSFORMS: readonly MidiTransformType[] = ["transpose", "scale-constrain", "quantize", "swing", "velocity-curve", "humanize-velocity", "humanize-timing", "legato", "staccato", "rotate", "chord-voicing", "seeded-variation"];
/** Transforms that create or delete notes (delete/recreate would drop any
 * per-note expression the canonical schema cannot represent). */
export const GENERATIVE_TRANSFORMS: readonly MidiTransformType[] = ["repeat", "ratchet", "arpeggiate"];

export const MIDI_TRANSFORM_MAX_NOTES = 2048;
export const MIDI_TRANSFORM_LARGE_UPDATE_THRESHOLD = 128;

export const SCALE_INTERVALS: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic-minor": [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "major-pentatonic": [0, 2, 4, 7, 9],
  "minor-pentatonic": [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export interface MidiTransformSpec {
  readonly type: MidiTransformType;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface MidiTransformOutcome {
  readonly notes: Note[];
  readonly assumptions: string[];
  readonly generative: boolean;
  /** Seeded transforms must echo the exact seed; undefined for fully deterministic specs. */
  readonly seed?: string;
}

/** Deterministic PRNG (mulberry32) seeded from a string or integer. */
export function seededRandom(seed: string | number): () => number {
  let state: number;
  if (typeof seed === "number") {
    state = seed >>> 0;
  } else {
    const digest = createHash("sha256").update(seed).digest();
    state = digest.readUInt32LE(0);
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function cloneNotes(notes: readonly Note[]): Note[] {
  return notes.map((note) => ({ ...note }));
}

/** Stable processing order: identical for any equal-content input regardless of input ordering. */
export function stableNoteOrder(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch) || ((a.id ?? -1) - (b.id ?? -1)) || (a.channel - b.channel));
}

function validateNoteSet(notes: readonly Note[]): void {
  if (notes.length > MIDI_TRANSFORM_MAX_NOTES) throw new RangeError(`note collection exceeds the bounded ${MIDI_TRANSFORM_MAX_NOTES}-note limit`);
  for (const note of notes) {
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new RangeError("note pitch is invalid");
    if (typeof note.start !== "number" || !Number.isFinite(note.start) || note.start < 0) throw new RangeError("note start is invalid");
    if (typeof note.duration !== "number" || !Number.isFinite(note.duration) || note.duration <= 0) throw new RangeError("note duration is invalid");
    if (typeof note.velocity !== "number" || !Number.isFinite(note.velocity) || note.velocity < 1 || note.velocity > 127) throw new RangeError("note velocity is invalid");
  }
}

function finiteParam(params: Readonly<Record<string, unknown>>, name: string, min: number, max: number, fallback?: number): number {
  const value = params[name] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be a finite number in [${min}, ${max}]`);
  return value;
}

function integerParam(params: Readonly<Record<string, unknown>>, name: string, min: number, max: number, fallback?: number): number {
  const value = params[name] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  return value as number;
}

function stringParam(params: Readonly<Record<string, unknown>>, name: string, allowed: readonly string[], fallback?: string): string {
  const value = params[name] ?? fallback;
  if (typeof value !== "string" || !allowed.includes(value)) throw new RangeError(`${name} must be one of ${allowed.join(", ")}`);
  return value;
}

function seedParam(params: Readonly<Record<string, unknown>>): string {
  const value = params.seed;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new RangeError("an explicit seed string (1-128 chars) is required for stochastic transforms");
  return value;
}

function transpose(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const semitones = integerParam(params, "semitones", -48, 48);
  let clamped = 0;
  const result = cloneNotes(notes);
  for (const note of result) {
    const target = note.pitch + semitones;
    const next = Math.min(127, Math.max(0, target));
    if (next !== target) clamped += 1;
    note.pitch = next;
  }
  return { notes: result, generative: false, assumptions: clamped > 0 ? [`${clamped} note(s) clamped to the MIDI pitch range`] : [] };
}

function nearestScalePitch(pitch: number, root: number, intervals: readonly number[]): number {
  let best = pitch;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let candidate = Math.max(0, pitch - 12); candidate <= Math.min(127, pitch + 12); candidate += 1) {
    const degree = (((candidate - root) % 12) + 12) % 12;
    if (!intervals.includes(degree)) continue;
    const distance = Math.abs(candidate - pitch);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

function scaleConstrain(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const root = integerParam(params, "root", 0, 11);
  const scale = stringParam(params, "scale", Object.keys(SCALE_INTERVALS));
  const intervals = SCALE_INTERVALS[scale]!;
  let snapped = 0;
  const result = cloneNotes(notes);
  for (const note of result) {
    const target = nearestScalePitch(note.pitch, root, intervals);
    if (target !== note.pitch) snapped += 1;
    note.pitch = target;
  }
  return { notes: result, generative: false, assumptions: [`scale ${scale} at root ${root}; ${snapped} note(s) snapped to the nearest scale tone (ties resolve downward)`] };
}

function quantize(notes: readonly Note[], params: Readonly<Record<string, unknown>>, clipLength?: number): MidiTransformOutcome {
  const grid = finiteParam(params, "grid", 1 / 1024, 64);
  const amount = finiteParam(params, "amount", 0, 1, 1);
  const target = stringParam(params, "target", ["start", "end", "both"], "start");
  const result = cloneNotes(notes);
  for (const note of result) {
    if (target !== "end") {
      const quantized = Math.round(note.start / grid) * grid;
      const shifted = note.start + (quantized - note.start) * amount;
      note.start = Math.max(0, shifted);
    }
    if (target !== "start") {
      const end = note.start + note.duration;
      const quantizedEnd = Math.round(end / grid) * grid;
      const shiftedEnd = end + (quantizedEnd - end) * amount;
      note.duration = Math.max(1 / 1024, shiftedEnd - note.start);
    }
    if (clipLength !== undefined) {
      if (note.start > clipLength - 1 / 1024) note.start = Math.max(0, clipLength - Math.max(note.duration, 1 / 1024));
      if (note.start + note.duration > clipLength) note.duration = Math.max(1 / 1024, clipLength - note.start);
    }
  }
  return { notes: result, generative: false, assumptions: [`grid ${grid} beats at ${Math.round(amount * 100)}% strength toward ${target}`] };
}

function swing(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const grid = finiteParam(params, "grid", 1 / 1024, 8);
  const amount = finiteParam(params, "amount", 0, 1);
  const epsilon = 1e-6;
  let shifted = 0;
  let skippedOffGrid = 0;
  const result = cloneNotes(notes);
  for (const note of result) {
    const index = Math.round(note.start / grid);
    if (Math.abs(note.start - index * grid) > epsilon) { skippedOffGrid += 1; continue; }
    if (index % 2 === 1) { note.start = note.start + amount * (grid / 2); shifted += 1; }
  }
  const assumptions = [`swing shifts notes exactly on odd ${grid}-beat divisions by ${Math.round(amount * 100)}% of a half division`];
  if (skippedOffGrid > 0) assumptions.push(`${skippedOffGrid} off-grid note(s) left untouched`);
  return { notes: result, generative: false, assumptions };
}

function velocityCurve(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const curve = stringParam(params, "curve", ["linear-up", "linear-down", "arch", "exp-up", "exp-down"]);
  const amount = finiteParam(params, "amount", 0, 1);
  const ordered = stableNoteOrder(notes);
  const minStart = ordered[0]?.start ?? 0;
  const maxStart = ordered[ordered.length - 1]?.start ?? minStart;
  const span = maxStart - minStart;
  const result = cloneNotes(notes);
  for (const note of result) {
    const t = span > 0 ? (note.start - minStart) / span : 0;
    const shaped = curve === "linear-up" ? t : curve === "linear-down" ? 1 - t : curve === "arch" ? Math.sin(Math.PI * t) : curve === "exp-up" ? t * t : 1 - (1 - t) * (1 - t);
    const multiplier = 1 + (shaped - 0.5) * 2 * amount * 0.5;
    note.velocity = Math.min(127, Math.max(1, Math.round(note.velocity * multiplier)));
  }
  return { notes: result, generative: false, assumptions: [`velocity curve ${curve} at ${Math.round(amount * 100)}% depth across the clip time span`] };
}

function humanizeVelocity(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const seed = seedParam(params);
  const maxDelta = finiteParam(params, "maxDelta", 0, 64);
  const random = seededRandom(seed);
  const result = cloneNotes(notes);
  for (const note of stableNoteOrder(result)) {
    const delta = Math.round((random() * 2 - 1) * maxDelta);
    note.velocity = Math.min(127, Math.max(1, Math.round(note.velocity + delta)));
  }
  return { notes: result, generative: false, seed, assumptions: [`seeded velocity jitter within ±${maxDelta}`] };
}

function humanizeTiming(notes: readonly Note[], params: Readonly<Record<string, unknown>>, clipLength?: number): MidiTransformOutcome {
  const seed = seedParam(params);
  const maxOffset = finiteParam(params, "maxOffset", 0, 0.5);
  const random = seededRandom(seed);
  const result = cloneNotes(notes);
  for (const note of stableNoteOrder(result)) {
    const offset = (random() * 2 - 1) * maxOffset;
    note.start = Math.max(0, note.start + offset);
    if (clipLength !== undefined && note.start + note.duration > clipLength) note.start = Math.max(0, clipLength - note.duration);
  }
  return { notes: result, generative: false, seed, assumptions: [`seeded timing jitter within ±${maxOffset} beats, clamped to the clip`] };
}

function legato(notes: readonly Note[], params: Readonly<Record<string, unknown>>, clipLength?: number): MidiTransformOutcome {
  const gap = finiteParam(params, "gap", 0, 1, 0);
  const ordered = stableNoteOrder(notes);
  const onsets = [...new Set(ordered.map((note) => note.start))].sort((a, b) => a - b);
  const result = cloneNotes(notes);
  for (const note of result) {
    const nextOnset = onsets.find((onset) => onset > note.start + 1e-9);
    const reach = (nextOnset ?? clipLength ?? note.start + note.duration) - gap;
    note.duration = Math.max(1 / 1024, reach - note.start);
  }
  return { notes: result, generative: false, assumptions: ["each note extends to the next onset minus the gap; the final onset reaches the clip end or keeps its extent"] };
}

function staccato(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const factor = finiteParam(params, "factor", 0.05, 1);
  const result = cloneNotes(notes);
  for (const note of result) note.duration = Math.max(1 / 1024, note.duration * factor);
  return { notes: result, generative: false, assumptions: [`durations scaled by ${factor}`] };
}

function rotate(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const steps = integerParam(params, "steps", -512, 512);
  const ordered = stableNoteOrder(notes);
  if (ordered.length === 0) return { notes: cloneNotes(notes), generative: false, assumptions: ["empty clip"] };
  const pitches = ordered.map((note) => note.pitch);
  const shift = ((steps % ordered.length) + ordered.length) % ordered.length;
  const rotated = pitches.map((_, index) => pitches[(((index - shift) % ordered.length) + ordered.length) % ordered.length]!);
  const byKey = new Map(ordered.map((note, index) => [`${note.start}|${note.pitch}|${note.id ?? -1}|${note.channel}`, rotated[index]!] as const));
  const result = cloneNotes(notes);
  for (const note of result) note.pitch = byKey.get(`${note.start}|${note.pitch}|${note.id ?? -1}|${note.channel}`) ?? note.pitch;
  return { notes: result, generative: false, assumptions: [`pitches rotated by ${shift} positions in stable note order; rhythm unchanged`] };
}

function repeat(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const times = integerParam(params, "times", 2, 8);
  const decay = finiteParam(params, "decay", 0, 1, 0);
  const result: Note[] = [];
  for (const note of stableNoteOrder(notes)) {
    const slice = note.duration / times;
    for (let index = 0; index < times; index += 1) {
      const velocity = Math.min(127, Math.max(1, Math.round(note.velocity * Math.pow(1 - decay, index))));
      const copy: Note = { ...note, start: note.start + index * slice, duration: slice, velocity };
      delete copy.id;
      result.push(copy);
    }
  }
  return { notes: result, generative: true, assumptions: [`each note is subdivided into ${times} equal parts${decay > 0 ? ` with ${Math.round(decay * 100)}% velocity decay per step` : ""}; original notes are replaced`] };
}

function ratchet(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const seed = seedParam(params);
  const subdivisions = integerParam(params, "subdivisions", 2, 16);
  const probability = finiteParam(params, "probability", 0, 1, 1);
  const random = seededRandom(seed);
  const result: Note[] = [];
  for (const note of stableNoteOrder(notes)) {
    const slice = note.duration / subdivisions;
    for (let index = 0; index < subdivisions; index += 1) {
      if (random() > probability) continue;
      const copy: Note = { ...note, start: note.start + index * slice, duration: slice };
      delete copy.id;
      result.push(copy);
    }
  }
  return { notes: result, generative: true, seed, assumptions: [`each note is subdivided into ${subdivisions} ratchets kept at probability ${probability} under the explicit seed; original notes are replaced`] };
}

function chordVoicing(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const strategy = stringParam(params, "strategy", ["close", "open", "drop2"]);
  const epsilon = 1e-6;
  const groups = new Map<number, Note[]>();
  const result = cloneNotes(notes);
  for (const note of result) {
    const key = Math.round(note.start / epsilon);
    const group = groups.get(key) ?? [];
    group.push(note);
    groups.set(key, group);
  }
  let voiced = 0;
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const byPitch = [...group].sort((a, b) => a.pitch - b.pitch);
    if (strategy === "close") {
      const lowest = byPitch[0]!.pitch;
      for (const note of byPitch.slice(1)) {
        while (note.pitch - lowest > 12 && note.pitch - 12 >= 0) { note.pitch -= 12; voiced += 1; }
      }
    } else if (strategy === "open") {
      for (let index = byPitch.length - 2; index >= 0; index -= 2) {
        const note = byPitch[index]!;
        if (note.pitch + 12 <= 127) { note.pitch += 12; voiced += 1; }
      }
    } else {
      const secondHighest = byPitch[byPitch.length - 2]!;
      if (secondHighest.pitch - 12 >= 0) { secondHighest.pitch -= 12; voiced += 1; }
    }
  }
  return { notes: result, generative: false, assumptions: [`${strategy} voicing applied to onset groups of 3+ notes within the MIDI pitch range; ${voiced} voice(s) moved by an octave`] };
}

function arpeggiate(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const pattern = stringParam(params, "pattern", ["up", "down", "updown", "downup", "random"]);
  const seed = pattern === "random" ? seedParam(params) : (typeof params.seed === "string" && params.seed.length >= 1 && params.seed.length <= 128 ? params.seed : undefined);
  const rate = finiteParam(params, "rate", 1 / 1024, 4, 0.25);
  const random = seed !== undefined ? seededRandom(seed) : undefined;
  const epsilon = 1e-6;
  const groups = new Map<number, Note[]>();
  for (const note of notes) {
    const key = Math.round(note.start / epsilon);
    const group = groups.get(key) ?? [];
    group.push(note);
    groups.set(key, group);
  }
  const result: Note[] = [];
  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < 2) { result.push(...group.map((note) => ({ ...note }))); continue; }
    const start = key * epsilon;
    const duration = Math.max(...group.map((note) => note.start + note.duration)) - start;
    const pitches = [...new Set(group.map((note) => note.pitch))].sort((a, b) => a - b);
    let order: number[];
    if (pattern === "up") order = [...pitches];
    else if (pattern === "down") order = [...pitches].reverse();
    else if (pattern === "updown") order = [...pitches, ...[...pitches].reverse().slice(1, -1)];
    else if (pattern === "downup") order = [...[...pitches].reverse(), ...[...pitches].slice(1, -1)];
    else {
      order = [...pitches];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random!() * (index + 1));
        [order[index], order[swap]] = [order[swap]!, order[index]!];
      }
    }
    const count = Math.max(1, Math.floor(duration / rate));
    const template = group[0]!;
    for (let index = 0; index < count; index += 1) {
      const copy: Note = { ...template, pitch: order[index % order.length]!, start: start + index * rate, duration: Math.min(rate, start + duration - (start + index * rate)) };
      delete copy.id;
      result.push(copy);
    }
  }
  return { notes: result, generative: true, ...(seed !== undefined ? { seed } : {}), assumptions: [`onset groups of 2+ notes become ${pattern} arpeggios at ${rate}-beat steps within the original group span; original chord notes are replaced`] };
}

function seededVariation(notes: readonly Note[], params: Readonly<Record<string, unknown>>, clipLength?: number): MidiTransformOutcome {
  const seed = seedParam(params);
  const velocityMax = finiteParam(params, "velocityMax", 0, 32, 8);
  const timingMax = finiteParam(params, "timingMax", 0, 0.25, 0);
  const probabilityDepth = finiteParam(params, "probabilityDepth", 0, 1, 0);
  const random = seededRandom(seed);
  const result = cloneNotes(notes);
  for (const note of stableNoteOrder(result)) {
    const velocityDelta = Math.round((random() * 2 - 1) * velocityMax);
    note.velocity = Math.min(127, Math.max(1, Math.round(note.velocity + velocityDelta)));
    if (timingMax > 0) {
      note.start = Math.max(0, note.start + (random() * 2 - 1) * timingMax);
      if (clipLength !== undefined && note.start + note.duration > clipLength) note.start = Math.max(0, clipLength - note.duration);
    }
    if (probabilityDepth > 0) note.probability = Math.round((1 - random() * probabilityDepth) * 1000) / 1000;
  }
  return { notes: result, generative: false, seed, assumptions: [`seeded variation: velocity ±${velocityMax}${timingMax > 0 ? `, timing ±${timingMax} beats` : ""}${probabilityDepth > 0 ? `, probability reduced up to ${Math.round(probabilityDepth * 100)}%` : ""}`] };
}

/** Apply a pure deterministic transform. Throws RangeError on invalid parameters. */
export function applyMidiTransform(notes: readonly Note[], spec: MidiTransformSpec, clipLength?: number): MidiTransformOutcome {
  validateNoteSet(notes);
  switch (spec.type) {
    case "transpose": return transpose(notes, spec.params);
    case "scale-constrain": return scaleConstrain(notes, spec.params);
    case "quantize": return quantize(notes, spec.params, clipLength);
    case "swing": return swing(notes, spec.params);
    case "velocity-curve": return velocityCurve(notes, spec.params);
    case "humanize-velocity": return humanizeVelocity(notes, spec.params);
    case "humanize-timing": return humanizeTiming(notes, spec.params, clipLength);
    case "legato": return legato(notes, spec.params, clipLength);
    case "staccato": return staccato(notes, spec.params);
    case "rotate": return rotate(notes, spec.params);
    case "repeat": return repeat(notes, spec.params);
    case "ratchet": return ratchet(notes, spec.params);
    case "chord-voicing": return chordVoicing(notes, spec.params);
    case "arpeggiate": return arpeggiate(notes, spec.params);
    case "seeded-variation": return seededVariation(notes, spec.params, clipLength);
    default: throw new RangeError(`unknown MIDI transform: ${String((spec as { type?: unknown }).type)}`);
  }
}

export interface NoteDiff {
  /** New notes without ids, in stable order. */
  readonly add: Note[];
  /** Existing notes with their full resulting field set (id required). */
  readonly update: Note[];
  /** Ids of source notes absent from the result. */
  readonly delete: number[];
}

/** Exact add/update/delete diff between a source note set and a transform result. */
export function diffNotes(before: readonly Note[], after: readonly Note[]): NoteDiff {
  const beforeById = new Map<number, Note>();
  for (const note of before) if (typeof note.id === "number") beforeById.set(note.id, note);
  const add: Note[] = [];
  const update: Note[] = [];
  const afterIds = new Set<number>();
  for (const note of after) {
    if (typeof note.id !== "number") { add.push(note); continue; }
    afterIds.add(note.id);
    const prior = beforeById.get(note.id);
    if (!prior) { add.push(note); continue; }
    if (JSON.stringify(prior) !== JSON.stringify(note)) update.push(note);
  }
  const remove = [...beforeById.keys()].filter((id) => !afterIds.has(id));
  return { add, update, delete: remove };
}

/** Per-note expression probe: the canonical note schema fields the adapter
 * round-trips. Per-note Pitch/Slide/Pressure are not in the schema today, so
 * delete/recreate transforms must never claim to preserve them. */
export function midiExpressionProbe(): { noteSchemaFields: string[]; exposesPerNoteExpression: boolean; deleteRecreatePreservesExpression: boolean } {
  return {
    noteSchemaFields: ["pitch", "start", "duration", "velocity", "channel", "mute", "probability", "velocityDeviation", "releaseVelocity"],
    exposesPerNoteExpression: false,
    deleteRecreatePreservesExpression: false,
  };
}
