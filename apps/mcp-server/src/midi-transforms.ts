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

export const MIDI_TRANSFORM_TYPES = ["transpose", "scale-constrain", "quantize", "swing", "velocity-curve", "humanize-velocity", "humanize-timing", "legato", "staccato", "rotate", "repeat", "ratchet", "chord-voicing", "arpeggiate", "seeded-variation", "euclidean", "chord-progression", "drum-pattern", "bassline", "motif-invert", "motif-retrograde", "motif-augment", "motif-diminish"] as const;
export type MidiTransformType = typeof MIDI_TRANSFORM_TYPES[number];

/** Transforms that only patch fields of existing notes via note.update (which
 * preserves unexposed per-note data server-side). */
export const UPDATE_ONLY_TRANSFORMS: readonly MidiTransformType[] = ["transpose", "scale-constrain", "quantize", "swing", "velocity-curve", "humanize-velocity", "humanize-timing", "legato", "staccato", "rotate", "chord-voicing", "seeded-variation", "motif-invert", "motif-retrograde", "motif-augment", "motif-diminish"];
/** Transforms that create or delete notes (delete/recreate would drop any
 * per-note expression the canonical schema cannot represent). */
export const GENERATIVE_TRANSFORMS: readonly MidiTransformType[] = ["repeat", "ratchet", "arpeggiate", "euclidean", "chord-progression", "drum-pattern", "bassline"];

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
    // Start and end are quantized from the ORIGINAL boundaries independently;
    // "both" never derives the end from an already-quantized start.
    const originalStart = note.start;
    const originalEnd = note.start + note.duration;
    let nextStart = originalStart;
    let nextEnd = originalEnd;
    if (target !== "end") nextStart = Math.max(0, originalStart + (Math.round(originalStart / grid) * grid - originalStart) * amount);
    if (target !== "start") nextEnd = originalEnd + (Math.round(originalEnd / grid) * grid - originalEnd) * amount;
    note.start = nextStart;
    note.duration = Math.max(1 / 1024, nextEnd - nextStart);
    if (clipLength !== undefined) {
      if (note.start > clipLength - 1 / 1024) note.start = Math.max(0, clipLength - Math.max(note.duration, 1 / 1024));
      if (note.start + note.duration > clipLength) note.duration = Math.max(1 / 1024, clipLength - note.start);
    }
  }
  return { notes: result, generative: false, assumptions: [`grid ${grid} beats at ${Math.round(amount * 100)}% strength toward ${target}`] };
}

function swing(notes: readonly Note[], params: Readonly<Record<string, unknown>>, clipLength?: number): MidiTransformOutcome {
  const grid = finiteParam(params, "grid", 1 / 1024, 8);
  const amount = finiteParam(params, "amount", 0, 1);
  const epsilon = 1e-6;
  let shifted = 0;
  let skippedOffGrid = 0;
  let clamped = 0;
  const result = cloneNotes(notes);
  for (const note of result) {
    const index = Math.round(note.start / grid);
    if (Math.abs(note.start - index * grid) > epsilon) { skippedOffGrid += 1; continue; }
    if (index % 2 === 1) { note.start = note.start + amount * (grid / 2); shifted += 1; }
    // Swing never pushes a note past the clip end: the real mapper rejects
    // patches beyond the exact clip length.
    if (clipLength !== undefined && note.start + note.duration > clipLength) {
      note.start = Math.max(0, clipLength - note.duration);
      clamped += 1;
    }
  }
  const assumptions = [`swing shifts notes exactly on odd ${grid}-beat divisions by ${Math.round(amount * 100)}% of a half division`];
  if (skippedOffGrid > 0) assumptions.push(`${skippedOffGrid} off-grid note(s) left untouched`);
  if (clamped > 0) assumptions.push(`${clamped} note(s) clamped to the clip end`);
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
  // Bound the prospective output before generating anything: rate may be as
  // small as 1/1024 beats while note durations are unbounded, so
  // floor(span / rate) per onset group can otherwise attempt effectively
  // unbounded note generation and hang or OOM the host inside one tool call.
  let prospective = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) { prospective += group.length; continue; }
    const start = key * epsilon;
    const span = Math.max(...group.map((note) => note.start + note.duration)) - start;
    prospective += Math.max(1, Math.floor(span / rate));
    if (prospective > MIDI_TRANSFORM_MAX_NOTES) throw new RangeError(`arpeggiate would generate more than the bounded ${MIDI_TRANSFORM_MAX_NOTES}-note limit at rate ${rate}; increase the rate or shorten the onset-group span`);
  }
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

/* -------------------------------------------------------------------------
 * Deterministic generative primitives (issue #47). Every generator is a pure
 * function of its parameters (plus an explicit seed for any stochastic gate)
 * and ignores the input note set: generation replaces the scoped content, and
 * the preview diff discloses exactly what is added and deleted. No kit
 * mapping, scale, or chord quality is ever invented: musical context is
 * explicit in the parameters or resolved host-side from the Set and disclosed
 * in the preview assumptions.
 * ------------------------------------------------------------------------- */

const NOTE_NAMES_PC: readonly string[] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Generated notes carry Live's documented new-note defaults (channel 1, mute
 * off, probability 1, no velocity deviation, release velocity 64) so the
 * previewed diff matches the post-apply canonical read byte-for-byte. */
function newNote(pitch: number, start: number, duration: number, velocity: number): Note {
  return { pitch, start, duration, velocity, channel: 1, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 };
}

/** Bjorklund's algorithm: `pulses` distributed over `steps` as evenly as
 * possible. The raw bucket construction is normalized so the first pulse
 * lands on step 0 (the canonical representation of each rhythm). */
export function bjorklund(pulses: number, steps: number): boolean[] {
  if (!Number.isInteger(pulses) || !Number.isInteger(steps) || pulses < 0 || steps < 1 || pulses > steps) throw new RangeError("euclidean pulses/steps are invalid");
  if (pulses === 0) return new Array(steps).fill(false);
  if (pulses === steps) return new Array(steps).fill(true);
  const pattern: boolean[] = [];
  const counts: number[] = [];
  const remainders: number[] = [pulses];
  let divisor = steps - pulses;
  let level = 0;
  while (true) {
    counts.push(Math.floor(divisor / remainders[level]!));
    remainders.push(divisor % remainders[level]!);
    divisor = remainders[level]!;
    level += 1;
    if (remainders[level]! <= 1) break;
  }
  counts.push(divisor);
  const build = (l: number): void => {
    if (l === -1) { pattern.push(false); return; }
    if (l === -2) { pattern.push(true); return; }
    for (let index = 0; index < counts[l]!; index += 1) build(l - 1);
    if (remainders[l]! !== 0) build(l - 2);
  };
  build(level);
  const raw = pattern.slice(0, steps);
  const firstHit = raw.indexOf(true);
  return firstHit > 0 ? [...raw.slice(firstHit), ...raw.slice(0, firstHit)] : raw;
}

function euclideanRhythm(_notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const pulses = integerParam(params, "pulses", 1, 64);
  const steps = integerParam(params, "steps", 1, 64);
  if (pulses > steps) throw new RangeError("pulses must not exceed steps");
  const rotation = integerParam(params, "rotation", -64, 64, 0);
  const pitch = integerParam(params, "pitch", 0, 127);
  const velocity = integerParam(params, "velocity", 1, 127, 100);
  const stepLength = finiteParam(params, "stepLength", 1 / 1024, 16, 0.25);
  const noteLength = finiteParam(params, "noteLength", 1 / 1024, 64, Math.min(0.9 * stepLength, stepLength));
  const bars = integerParam(params, "bars", 1, 64, 1);
  const pattern = bjorklund(pulses, steps);
  const shift = ((rotation % steps) + steps) % steps;
  const result: Note[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    for (let step = 0; step < steps; step += 1) {
      if (!pattern[(step + shift) % steps]) continue;
      result.push(newNote(pitch, (bar * steps + step) * stepLength, noteLength, velocity));
    }
  }
  return { notes: result, generative: true, assumptions: [`Euclidean ${pulses}-in-${steps}${shift !== 0 ? ` rotated ${shift} step(s)` : ""} on pitch ${pitch} (${NOTE_NAMES_PC[pitch % 12]}${Math.floor(pitch / 12) - 1}), ${bars} bar(s) at ${stepLength}-beat steps; input notes are replaced`] };
}

/* ------------------------------- chords ---------------------------------- */

export interface ChordSpec {
  /** Root pitch class 0-11. */
  readonly rootPc: number;
  /** Pitch-class intervals above the root, ascending, starting at 0. */
  readonly intervals: readonly number[];
  /** Realized human-readable chord name (never invented: derived from intervals). */
  readonly name: string;
}

const SYMBOL_QUALITIES: Record<string, readonly number[]> = {
  "": [0, 4, 7], major: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], minor: [0, 3, 7],
  maj7: [0, 4, 7, 11], major7: [0, 4, 7, 11], "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], minor7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10], dim: [0, 3, 6], dim7: [0, 3, 6, 9], aug: [0, 4, 8], sus4: [0, 5, 7],
};

function qualityName(intervals: readonly number[]): string {
  const key = [...intervals].join(",");
  const names: Record<string, string> = { "0,4,7": "", "0,3,7": "m", "0,3,6": "dim", "0,4,8": "aug", "0,5,7": "sus4", "0,4,7,11": "maj7", "0,4,7,10": "7", "0,3,7,10": "m7", "0,3,6,10": "m7b5", "0,3,6,9": "dim7", "0,3,7,11": "m(maj7)" };
  return names[key] ?? `({${intervals.join("+")}})`;
}

/** Parse an explicit chord symbol like "Dm7", "F#", "Bb7", "Gaug". */
export function parseChordSymbol(symbol: string): ChordSpec {
  const match = /^(A|B|C|D|E|F|G)(#|b)?(maj7|major7|major|m7b5|min7|minor7|m7|min|minor|m|dim7|dim|aug|sus4|7)?$/i.exec(symbol.trim());
  if (!match) throw new RangeError(`unsupported chord symbol "${symbol}"; expected a root A-G with optional #/b and a documented quality (${["", "m", "maj7", "7", "m7", "m7b5", "dim", "dim7", "aug", "sus4"].join("/")})`);
  const letter = match[1]!.toUpperCase();
  const accidental = match[2] ?? "";
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter]!;
  const rootPc = (base + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0) + 12) % 12;
  const qualityKey = (match[3] ?? "").toLowerCase();
  const intervals = SYMBOL_QUALITIES[qualityKey] ?? SYMBOL_QUALITIES[""]!;
  return { rootPc, intervals, name: `${NOTE_NAMES_PC[rootPc]}${qualityName(intervals)}` };
}

const ROMAN_DEGREES: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

/** Parse a roman numeral (i-vii, optional "7", optional "°"/"dim") against a scale. */
export function parseRomanNumeral(numeral: string, root: number, scale: string): ChordSpec {
  const match = /^(vii|vi|iv|v|iii|ii|i)(°|dim)?(7)?$/i.exec(numeral.trim());
  if (!match) throw new RangeError(`unsupported roman numeral "${numeral}"; expected i-vii with optional "°" and "7"`);
  const degreeIndex = ROMAN_DEGREES[match[1]!.toLowerCase()]!;
  const intervalsOfScale = SCALE_INTERVALS[scale];
  if (!intervalsOfScale || intervalsOfScale.length !== 7) throw new RangeError(`roman numerals require a 7-tone scale, got "${scale}"`);
  const degreePc = (degree: number): number => intervalsOfScale[degree % 7]! + 12 * Math.floor(degree / 7);
  const diminished = match[2] !== undefined;
  const seventh = match[3] !== undefined;
  const rootPc = (root + degreePc(degreeIndex)) % 12;
  const third = degreePc(degreeIndex + 2) - degreePc(degreeIndex);
  const fifth = degreePc(degreeIndex + 4) - degreePc(degreeIndex);
  const intervals: number[] = [0, diminished ? 3 : third, diminished ? 6 : fifth];
  if (seventh) {
    const diatonicSeventh = degreePc(degreeIndex + 6) - degreePc(degreeIndex);
    intervals.push(diminished ? 10 : diatonicSeventh);
  }
  return { rootPc, intervals, name: `${NOTE_NAMES_PC[rootPc]}${qualityName(intervals)}` };
}

/** Parse a chord list: explicit symbols, or roman numerals against root/scale. */
export function parseChordList(chords: readonly string[], root: number | undefined, scale: string | undefined): { readonly chords: readonly ChordSpec[]; readonly source: string } {
  const looksRoman = (token: string) => /^(vii|vi|iv|v|iii|ii|i)(°|dim)?(7)?$/i.test(token.trim());
  if (chords.length === 0 || chords.length > 32) throw new RangeError("chords must name 1-32 entries");
  if (chords.every(looksRoman)) {
    if (root === undefined || scale === undefined) throw new RangeError("roman-numeral chords require an explicit or Set-discovered key (root) and mode (scale)");
    return { chords: chords.map((token) => parseRomanNumeral(token, root, scale)), source: `roman numerals in ${NOTE_NAMES_PC[root]} ${scale}` };
  }
  if (chords.some(looksRoman)) throw new RangeError("chords must not mix roman numerals with explicit chord symbols");
  return { chords: chords.map(parseChordSymbol), source: "explicit chord symbols" };
}

function stringArrayParam(params: Readonly<Record<string, unknown>>, name: string): string[] {
  const value = params[name];
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((entry) => typeof entry !== "string" || (entry as string).length < 1 || (entry as string).length > 32)) throw new RangeError(`${name} must be an array of 1-32 non-empty strings`);
  return value as string[];
}

function mappingParam(params: Readonly<Record<string, unknown>>, name: string, roles: readonly string[]): Record<string, number> {
  const value = params[name];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RangeError(`${name} must be a flat role-to-pitch object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new RangeError(`${name} must not exceed 32 roles`);
  const mapping: Record<string, number> = {};
  for (const [role, pitch] of entries) {
    if (!roles.includes(role)) throw new RangeError(`${name} role "${role}" is not one of ${roles.join(", ")}`);
    if (!Number.isInteger(pitch) || (pitch as number) < 0 || (pitch as number) > 127) throw new RangeError(`${name}.${role} must be an integer MIDI pitch in 0..127`);
    mapping[role] = pitch as number;
  }
  return mapping;
}

/** Voiced chord: one pitch per chord tone, ascending. */
type VoicedChord = readonly number[];

function styleVoicing(chord: ChordSpec, bassPitch: number, style: string): VoicedChord {
  const close = chord.intervals.map((interval) => bassPitch + interval);
  if (style === "close") return close;
  if (style === "drop2") {
    if (close.length < 3) return close;
    const voiced = [...close];
    const secondHighest = voiced[voiced.length - 2]!;
    if (secondHighest - 12 >= 0) voiced[voiced.length - 2] = secondHighest - 12;
    return [...voiced].sort((a, b) => a - b);
  }
  // spread: alternate chord tones (2nd, 4th, ...) rise an octave
  return close.map((pitch, index) => (index % 2 === 1 && pitch + 12 <= 127 ? pitch + 12 : pitch)).sort((a, b) => a - b);
}

/** Every inversion/octave placement of the chord near a register, for voice leading. */
function voicingCandidates(chord: ChordSpec, style: string): VoicedChord[] {
  const seen = new Set<string>();
  const candidates: VoicedChord[] = [];
  const tones = chord.intervals.length;
  for (let inversion = 0; inversion < tones; inversion += 1) {
    for (let octave = 1; octave <= 6; octave += 1) {
      const bassPc = chord.intervals[inversion]!;
      const bassPitch = 12 * octave + ((chord.rootPc + bassPc) % 12);
      const rotated = chord.intervals.slice(inversion).map((interval) => interval - bassPc).concat(chord.intervals.slice(0, inversion).map((interval) => interval + 12 - bassPc));
      const voiced = styleVoicing({ ...chord, intervals: rotated }, bassPitch, style);
      if (voiced.some((pitch) => pitch < 0 || pitch > 127)) continue;
      const key = voiced.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(voiced);
    }
  }
  return candidates;
}

function movementCost(from: VoicedChord, to: VoicedChord): number {
  let cost = 0;
  for (let index = 0; index < Math.min(from.length, to.length); index += 1) cost += Math.abs(from[index]! - to[index]!);
  return cost;
}

function chordProgression(_notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const hasNumerals = params.numerals !== undefined;
  const hasSymbols = params.symbols !== undefined;
  if (hasNumerals === hasSymbols) throw new RangeError("exactly one of numerals or symbols is required");
  const tokens = stringArrayParam(params, hasNumerals ? "numerals" : "symbols");
  const root = params.root === undefined ? undefined : integerParam(params, "root", 0, 11);
  const scale = params.scale === undefined ? undefined : stringParam(params, "scale", Object.keys(SCALE_INTERVALS));
  const { chords, source } = hasNumerals ? parseChordList(tokens, root, scale) : { chords: tokens.map(parseChordSymbol) as readonly ChordSpec[], source: "explicit chord symbols" };
  const voicingStyle = stringParam(params, "voicing", ["close", "drop2", "spread"], "close");
  const voiceLeading = integerParam(params, "voiceLeading", 0, 1, 1) === 1;
  const chordDuration = finiteParam(params, "chordDuration", 1 / 1024, 1024, 4);
  const startBeat = finiteParam(params, "startBeat", 0, 1000000, 0);
  const velocity = integerParam(params, "velocity", 1, 127, 80);
  const octave = integerParam(params, "octave", 0, 8, 4);
  const voiced: VoicedChord[] = [];
  let previous: VoicedChord | null = null;
  for (const chord of chords) {
    let placed: VoicedChord;
    if (!voiceLeading || previous === null) {
      placed = styleVoicing(chord, 12 * octave + chord.rootPc, voicingStyle);
      if (voiceLeading && previous === null) {
        // Voice-led sessions still anchor the first chord to the requested register.
        const candidates = voicingCandidates(chord, voicingStyle);
        const anchor = candidates.filter((candidate) => Math.abs(candidate[0]! - placed[0]!) <= 12);
        if (anchor.length > 0) placed = anchor.sort((a, b) => (a[0]! - placed[0]!) - (b[0]! - placed[0]!))[0]!;
      }
    } else {
      const candidates = voicingCandidates(chord, voicingStyle);
      if (candidates.length === 0) throw new RangeError(`no voicing of ${chord.name} fits the MIDI pitch range`);
      placed = candidates.reduce((best, candidate) => {
        const cost = movementCost(previous!, candidate);
        const bestCost = movementCost(previous!, best);
        if (cost !== bestCost) return cost < bestCost ? candidate : best;
        const mean = (voicedChord: VoicedChord) => voicedChord.reduce((sum, pitch) => sum + pitch, 0) / voicedChord.length;
        return Math.abs(mean(candidate) - mean(previous!)) < Math.abs(mean(best) - mean(previous!)) ? candidate : best;
      });
    }
    voiced.push(placed);
    previous = placed;
  }
  const result: Note[] = [];
  voiced.forEach((chord, index) => {
    for (const pitch of chord) result.push(newNote(pitch, startBeat + index * chordDuration, chordDuration, velocity));
  });
  const movement = voiced.slice(1).reduce((sum, chord, index) => sum + movementCost(voiced[index]!, chord), 0);
  return { notes: result, generative: true, assumptions: [`${chords.length} chord(s) from ${source}: ${chords.map((chord) => chord.name).join(" - ")}`, `${voicingStyle} voicing${voiceLeading ? ` with minimal voice movement (${movement} total semitone steps)` : " (voice leading off)"} at octave ${octave}, ${chordDuration} beat(s) per chord; input notes are replaced`] };
}

/* ------------------------------- drums ------------------------------------ */

export const DRUM_ROLES = ["kick", "snare", "closedHat", "openHat", "clap", "ride", "crash", "lowTom", "midTom", "highTom"] as const;
type DrumRole = typeof DRUM_ROLES[number];

interface DrumHit { readonly role: DrumRole; readonly step16: number; readonly velocity: number; readonly optional?: boolean }

const DRUM_STYLES: Record<string, readonly DrumHit[]> = {
  "four-on-the-floor": [
    { role: "kick", step16: 0, velocity: 105 }, { role: "kick", step16: 4, velocity: 105 }, { role: "kick", step16: 8, velocity: 105 }, { role: "kick", step16: 12, velocity: 105 },
    { role: "snare", step16: 4, velocity: 100 }, { role: "snare", step16: 12, velocity: 100 },
    { role: "closedHat", step16: 0, velocity: 80 }, { role: "closedHat", step16: 2, velocity: 80 }, { role: "closedHat", step16: 4, velocity: 80 }, { role: "closedHat", step16: 6, velocity: 80 }, { role: "closedHat", step16: 8, velocity: 80 }, { role: "closedHat", step16: 10, velocity: 80 }, { role: "closedHat", step16: 12, velocity: 80 }, { role: "closedHat", step16: 14, velocity: 80 },
    { role: "closedHat", step16: 1, velocity: 65, optional: true }, { role: "closedHat", step16: 3, velocity: 65, optional: true }, { role: "closedHat", step16: 5, velocity: 65, optional: true }, { role: "closedHat", step16: 7, velocity: 65, optional: true }, { role: "closedHat", step16: 9, velocity: 65, optional: true }, { role: "closedHat", step16: 11, velocity: 65, optional: true }, { role: "closedHat", step16: 13, velocity: 65, optional: true }, { role: "closedHat", step16: 15, velocity: 65, optional: true },
    { role: "openHat", step16: 14, velocity: 85, optional: true }, { role: "crash", step16: 0, velocity: 90, optional: true },
  ],
  backbeat: [
    { role: "kick", step16: 0, velocity: 105 }, { role: "kick", step16: 8, velocity: 105 }, { role: "kick", step16: 10, velocity: 95, optional: true },
    { role: "snare", step16: 4, velocity: 105 }, { role: "snare", step16: 12, velocity: 105 },
    { role: "closedHat", step16: 0, velocity: 78 }, { role: "closedHat", step16: 2, velocity: 78 }, { role: "closedHat", step16: 4, velocity: 78 }, { role: "closedHat", step16: 6, velocity: 78 }, { role: "closedHat", step16: 8, velocity: 78 }, { role: "closedHat", step16: 10, velocity: 78 }, { role: "closedHat", step16: 12, velocity: 78 }, { role: "closedHat", step16: 14, velocity: 78 },
    { role: "crash", step16: 0, velocity: 88, optional: true },
  ],
  breakbeat: [
    { role: "kick", step16: 0, velocity: 105 }, { role: "kick", step16: 7, velocity: 100 }, { role: "kick", step16: 10, velocity: 100 },
    { role: "snare", step16: 4, velocity: 105 }, { role: "snare", step16: 12, velocity: 105 }, { role: "snare", step16: 15, velocity: 90, optional: true },
    { role: "closedHat", step16: 0, velocity: 82 }, { role: "closedHat", step16: 2, velocity: 82 }, { role: "closedHat", step16: 4, velocity: 82 }, { role: "closedHat", step16: 6, velocity: 82 }, { role: "closedHat", step16: 8, velocity: 82 }, { role: "closedHat", step16: 10, velocity: 82 }, { role: "closedHat", step16: 12, velocity: 82 }, { role: "closedHat", step16: 14, velocity: 82 },
    { role: "closedHat", step16: 3, velocity: 70, optional: true }, { role: "closedHat", step16: 11, velocity: 70, optional: true },
    { role: "openHat", step16: 6, velocity: 80, optional: true },
  ],
  "trap-hats": [
    { role: "kick", step16: 0, velocity: 108 }, { role: "kick", step16: 10, velocity: 100 },
    { role: "snare", step16: 8, velocity: 105 },
    { role: "closedHat", step16: 0, velocity: 85 }, { role: "closedHat", step16: 1, velocity: 60 }, { role: "closedHat", step16: 2, velocity: 70 }, { role: "closedHat", step16: 3, velocity: 60 }, { role: "closedHat", step16: 4, velocity: 80 }, { role: "closedHat", step16: 5, velocity: 60 }, { role: "closedHat", step16: 6, velocity: 70 }, { role: "closedHat", step16: 7, velocity: 65 }, { role: "closedHat", step16: 8, velocity: 85 }, { role: "closedHat", step16: 9, velocity: 60 }, { role: "closedHat", step16: 10, velocity: 70 }, { role: "closedHat", step16: 11, velocity: 60 }, { role: "closedHat", step16: 12, velocity: 80 }, { role: "closedHat", step16: 13, velocity: 65 }, { role: "closedHat", step16: 14, velocity: 70 }, { role: "closedHat", step16: 15, velocity: 75 },
    { role: "closedHat", step16: 3, velocity: 95, optional: true }, { role: "closedHat", step16: 7, velocity: 95, optional: true }, { role: "closedHat", step16: 11, velocity: 95, optional: true }, { role: "closedHat", step16: 15, velocity: 95, optional: true },
    { role: "openHat", step16: 15, velocity: 80, optional: true },
  ],
};

function drumPattern(_notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const style = stringParam(params, "style", Object.keys(DRUM_STYLES));
  const bars = integerParam(params, "bars", 1, 8, 1);
  const gridResolution = integerParam(params, "gridResolution", 8, 32, 16);
  if (![8, 16, 32].includes(gridResolution)) throw new RangeError("gridResolution must be 8, 16, or 32 steps per bar");
  const density = finiteParam(params, "density", 0, 1, 1);
  const seed = params.seed === undefined ? undefined : seedParam(params);
  if (density < 1 && seed === undefined) throw new RangeError("density below 1 requires an explicit seed");
  const barLength = finiteParam(params, "barLength", 1, 64, 4);
  const mapping = mappingParam(params, "mapping", DRUM_ROLES);
  const random = seed !== undefined ? seededRandom(seed) : undefined;
  const template = DRUM_STYLES[style]!;
  const stepBeats = barLength / gridResolution;
  const missing = new Set<string>();
  let droppedCoarse = 0;
  let gatedOut = 0;
  const result: Note[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    for (const hit of template) {
      if (gridResolution === 8 && hit.step16 % 2 !== 0) { droppedCoarse += 1; continue; }
      const step = hit.step16 * (gridResolution / 16);
      if (hit.optional && density < 1 && random!() >= density) { gatedOut += 1; continue; }
      const pitch = mapping[hit.role];
      if (pitch === undefined) { missing.add(hit.role); continue; }
      result.push(newNote(pitch, bar * barLength + step * stepBeats, Math.min(stepBeats, barLength - step * stepBeats), hit.velocity));
    }
  }
  const assumptions = [`${style} template over ${bars} bar(s) at ${gridResolution} steps/bar (${stepBeats} beats/step); input notes are replaced`];
  if (droppedCoarse > 0) assumptions.push(`${droppedCoarse} hit(s) dropped because they fall between ${gridResolution}-step grid positions`);
  if (gatedOut > 0) assumptions.push(`${gatedOut} optional hit(s) gated out at density ${density} under the explicit seed`);
  if (missing.size > 0) assumptions.push(`no pitch mapping for role(s) ${[...missing].sort().join(", ")}; those hits were omitted (kit mapping is never invented)`);
  const outcome: MidiTransformOutcome = { notes: result, generative: true, assumptions };
  return seed !== undefined ? { ...outcome, seed } : outcome;
}

/* ------------------------------ bassline ---------------------------------- */

function bassline(_notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  const pattern = stringParam(params, "pattern", ["octave", "walking", "arpeggiated"]);
  const tokens = stringArrayParam(params, "chords");
  const { chords, source } = parseChordList(tokens, params.root === undefined ? undefined : integerParam(params, "root", 0, 11), params.scale === undefined ? undefined : stringParam(params, "scale", Object.keys(SCALE_INTERVALS)));
  const chordDuration = finiteParam(params, "chordDuration", 1 / 1024, 1024, 4);
  const stepBeats = finiteParam(params, "stepBeats", 1 / 1024, 16, 1);
  const velocity = integerParam(params, "velocity", 1, 127, 85);
  const octave = integerParam(params, "octave", 0, 6, 2);
  const startBeat = finiteParam(params, "startBeat", 0, 1000000, 0);
  const result: Note[] = [];
  chords.forEach((chord, chordIndex) => {
    const rootPitch = 12 * (octave + 1) + chord.rootPc;
    const steps = Math.max(1, Math.round(chordDuration / stepBeats));
    const nextRoot = chordIndex + 1 < chords.length ? 12 * (octave + 1) + chords[chordIndex + 1]!.rootPc : rootPitch + 12;
    for (let step = 0; step < steps; step += 1) {
      let pitch: number;
      if (pattern === "octave") pitch = step % 2 === 0 ? rootPitch : Math.min(127, rootPitch + 12);
      else if (pattern === "arpeggiated") pitch = rootPitch + chord.intervals[step % chord.intervals.length]!;
      else {
        // walking: root, chord tone, fifth (or third), chromatic approach to the next root
        const fifth = chord.intervals.find((interval) => interval === 7) ?? chord.intervals[chord.intervals.length - 1]!;
        if (step === 0) pitch = rootPitch;
        else if (step === steps - 1) pitch = Math.min(127, Math.max(0, nextRoot - 1));
        else if (step === steps - 2) pitch = rootPitch + fifth;
        else pitch = rootPitch + chord.intervals[step % chord.intervals.length]!;
      }
      if (pitch < 0 || pitch > 127) continue;
      result.push(newNote(pitch, startBeat + chordIndex * chordDuration + step * stepBeats, stepBeats, velocity));
    }
  });
  return { notes: result, generative: true, assumptions: [`${pattern} bassline over ${chords.length} chord(s) from ${source}: ${chords.map((chord) => chord.name).join(" - ")}`, `${stepBeats}-beat steps at octave ${octave}; walking lines approach each next root chromatically from below; input notes are replaced`] };
}

/* --------------------------- motif transforms ------------------------------ */

function motifInvert(notes: readonly Note[], params: Readonly<Record<string, unknown>>): MidiTransformOutcome {
  if (params.axis === undefined) throw new RangeError("an explicit axis pitch is required (no tonal center is assumed)");
  const axis = integerParam(params, "axis", 0, 127);
  let clamped = 0;
  const result = cloneNotes(notes);
  for (const note of result) {
    const inverted = 2 * axis - note.pitch;
    const next = Math.min(127, Math.max(0, inverted));
    if (next !== inverted) clamped += 1;
    note.pitch = next;
  }
  return { notes: result, generative: false, assumptions: [`melodic inversion around axis pitch ${axis} (${NOTE_NAMES_PC[axis % 12]}${Math.floor(axis / 12) - 1}); rhythm unchanged${clamped > 0 ? `; ${clamped} note(s) clamped to the MIDI pitch range` : ""}`] };
}

function motifRetrograde(notes: readonly Note[], params: Readonly<Record<string, unknown>>, clipLength?: number): MidiTransformOutcome {
  if (clipLength === undefined || typeof clipLength !== "number" || !Number.isFinite(clipLength) || clipLength <= 0) throw new RangeError("motif-retrograde requires the exact clip length as its reversal span");
  const result = cloneNotes(notes);
  for (const note of result) note.start = clipLength - (note.start + note.duration);
  return { notes: result, generative: false, assumptions: [`retrograde within the exact ${clipLength}-beat clip span; note order reversed in time, pitches and durations unchanged`] };
}

function motifRatios(notes: readonly Note[], params: Readonly<Record<string, unknown>>, augment: boolean): MidiTransformOutcome {
  const numerator = integerParam(params, "numerator", 1, 16);
  const denominator = integerParam(params, "denominator", 1, 16);
  if (augment && numerator <= denominator) throw new RangeError("motif-augment requires numerator > denominator (a ratio above 1)");
  if (!augment && numerator >= denominator) throw new RangeError("motif-diminish requires numerator < denominator (a ratio below 1)");
  const result = cloneNotes(notes);
  for (const note of result) {
    note.start = (note.start * numerator) / denominator;
    note.duration = Math.max(1 / 1024, (note.duration * numerator) / denominator);
  }
  return { notes: result, generative: false, assumptions: [`rhythmic ${augment ? "augmentation" : "diminution"} by the exact ratio ${numerator}:${denominator}; starts and durations scaled, pitches unchanged`] };
}

/** Apply a pure deterministic transform. Throws RangeError on invalid parameters. */
export function applyMidiTransform(notes: readonly Note[], spec: MidiTransformSpec, clipLength?: number): MidiTransformOutcome {
  validateNoteSet(notes);
  switch (spec.type) {
    case "transpose": return transpose(notes, spec.params);
    case "scale-constrain": return scaleConstrain(notes, spec.params);
    case "quantize": return quantize(notes, spec.params, clipLength);
    case "swing": return swing(notes, spec.params, clipLength);
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
    case "euclidean": return euclideanRhythm(notes, spec.params);
    case "chord-progression": return chordProgression(notes, spec.params);
    case "drum-pattern": return drumPattern(notes, spec.params);
    case "bassline": return bassline(notes, spec.params);
    case "motif-invert": return motifInvert(notes, spec.params);
    case "motif-retrograde": return motifRetrograde(notes, spec.params, clipLength);
    case "motif-augment": return motifRatios(notes, spec.params, true);
    case "motif-diminish": return motifRatios(notes, spec.params, false);
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

/** Content digest for note sets, with the transform bounds (2048 notes) rather
 * than the mutation-authority canonicalizer's tighter wire bounds. Ignores
 * server-assigned note ids so content comparisons survive re-creation. */
export function noteContentDigest(notes: readonly Record<string, unknown>[]): string {
  return noteSetDigest(notes, false);
}

/** Exact identity-bound digest for note sets with stable server ids: two
 * same-onset notes swapping canonical content changes this digest even though
 * the ID-agnostic content digest stays unchanged. Used for in-place
 * apply/undo fences where identity is authoritative. */
export function noteIdentityDigest(notes: readonly Record<string, unknown>[]): string {
  return noteSetDigest(notes, true);
}

function noteSetDigest(notes: readonly Record<string, unknown>[], includeIds: boolean): string {
  const canonical = (value: unknown, depth: number): string => {
    if (depth > 8) throw new Error("note content is too deeply nested");
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("note content contains a non-finite number"); return JSON.stringify(Object.is(value, -0) ? 0 : value); }
    if (typeof value === "string") { if (value.length > 16384) throw new Error("note content string is too large"); return JSON.stringify(value); }
    if (Array.isArray(value)) { if (value.length > MIDI_TRANSFORM_MAX_NOTES) throw new Error(`note content array exceeds the ${MIDI_TRANSFORM_MAX_NOTES}-note transform bound`); return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`; }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > 64) throw new Error("note content object is too large");
      return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
    }
    throw new Error("note content contains an unsupported value");
  };
  const rows = notes.map((note) => {
    if (includeIds) return note;
    const { id: _id, ...content } = note;
    return content;
  });
  rows.sort((a, b) => canonical(a, 0).localeCompare(canonical(b, 0)));
  return createHash("sha256").update(canonical(rows, 0)).digest("hex");
}
