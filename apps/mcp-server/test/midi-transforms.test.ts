import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "../src/live.js";
import { GENERATIVE_TRANSFORMS, MIDI_TRANSFORM_TYPES, UPDATE_ONLY_TRANSFORMS, applyMidiTransform, diffNotes, midiExpressionProbe, noteContentDigest, seededRandom, stableNoteOrder } from "../src/midi-transforms.js";

function note(pitch: number, start: number, duration: number, velocity = 100, id?: number): Note {
  return { pitch, start, duration, velocity, channel: 1, ...(id !== undefined ? { id } : {}) };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomNotes(next: () => number, count: number, spanBeats: number): Note[] {
  const notes: Note[] = [];
  for (let index = 0; index < count; index += 1) {
    const duration = Math.max(1 / 1024, Math.floor(next() * 2 * 1024) / 1024);
    notes.push({
      pitch: Math.floor(next() * 128),
      start: Math.floor(next() * Math.max(1 / 1024, spanBeats - duration) * 1024) / 1024,
      duration,
      velocity: 1 + Math.floor(next() * 127),
      channel: 1 + Math.floor(next() * 16),
      id: index,
      probability: Math.round(next() * 1000) / 1000,
      velocityDeviation: Math.floor(next() * 20) - 10,
      releaseVelocity: 1 + Math.floor(next() * 127),
      mute: next() > 0.9,
    });
  }
  return notes;
}

test("every stochastic transform is byte-for-byte repeatable under an explicit seed", () => {
  const next = random(0x5eed);
  const source = randomNotes(next, 64, 16);
  const chords = [note(60, 0, 1, 100, 1), note(64, 0, 1, 100, 2), note(67, 0, 1, 100, 3), note(72, 2, 1, 90, 4), note(76, 2, 1, 90, 5)];
  for (const [type, params, input] of [
    ["humanize-velocity", { seed: "alpha", maxDelta: 12 }, source],
    ["humanize-timing", { seed: "beta", maxOffset: 0.125 }, source],
    ["ratchet", { seed: "gamma", subdivisions: 4, probability: 0.6 }, source],
    ["arpeggiate", { seed: "delta", pattern: "random", rate: 0.25 }, chords],
    ["seeded-variation", { seed: "epsilon", velocityMax: 10, timingMax: 0.05, probabilityDepth: 0.4 }, source],
  ] as const) {
    const first = applyMidiTransform(input, { type, params }, 16);
    const second = applyMidiTransform(structuredClone(input), { type, params }, 16);
    assert.deepEqual(second.notes, first.notes, `${type} must be byte-for-byte repeatable`);
    assert.equal(first.seed, params.seed);
    const different = applyMidiTransform(structuredClone(input), { type, params: { ...params, seed: `${params.seed}-other` } }, 16);
    assert.notDeepEqual(different.notes, first.notes, `${type} must depend on the seed`);
  }
});

test("stochastic transforms refuse a missing or invalid seed", () => {
  const source = [note(60, 0, 1)];
  for (const type of ["humanize-velocity", "humanize-timing", "ratchet", "seeded-variation"] as const) {
    assert.throws(() => applyMidiTransform(source, { type, params: {} }), /seed/);
  }
});

test("transpose is bounded, exact, and reports clamps", () => {
  const source = [note(60, 0, 1, 100, 1), note(120, 1, 1, 100, 2)];
  const up = applyMidiTransform(source, { type: "transpose", params: { semitones: 12 } });
  assert.deepEqual(up.notes.map((item) => item.pitch), [72, 127]);
  assert.deepEqual(up.assumptions, ["1 note(s) clamped to the MIDI pitch range"]);
  const down = applyMidiTransform(source, { type: "transpose", params: { semitones: -48 } });
  assert.deepEqual(down.notes.map((item) => item.pitch), [12, 72]);
  assert.throws(() => applyMidiTransform(source, { type: "transpose", params: { semitones: 49 } }), /semitones/);
  assert.throws(() => applyMidiTransform(source, { type: "transpose", params: {} }), /semitones/);
});

test("scale-constrain snaps to the nearest scale tone deterministically", () => {
  const source = [note(61, 0, 1, 100, 1), note(63, 1, 1, 100, 2), note(66, 2, 1, 100, 3)];
  const result = applyMidiTransform(source, { type: "scale-constrain", params: { root: 0, scale: "major" } });
  assert.deepEqual(result.notes.map((item) => item.pitch), [60, 62, 65]);
  const tie = applyMidiTransform([note(61, 0, 1)], { type: "scale-constrain", params: { root: 0, scale: "chromatic" } });
  assert.deepEqual(tie.notes.map((item) => item.pitch), [61]);
  assert.throws(() => applyMidiTransform(source, { type: "scale-constrain", params: { root: 0, scale: "ionian" } }), /scale/);
});

test("quantize honors grid, strength, and start/end targets at loop edges", () => {
  const source = [note(60, 0.13, 0.5, 100, 1), note(64, 0.26, 0.25, 100, 2)];
  const full = applyMidiTransform(source, { type: "quantize", params: { grid: 0.25, amount: 1 } }, 4);
  assert.deepEqual(full.notes.map((item) => item.start), [0.25, 0.25]);
  const partial = applyMidiTransform(source, { type: "quantize", params: { grid: 0.25, amount: 0.5 } }, 4);
  assert.ok(Math.abs(partial.notes[0]!.start - 0.19) < 1e-9);
  const ends = applyMidiTransform([note(60, 3.75, 0.4, 100, 1)], { type: "quantize", params: { grid: 0.25, amount: 1, target: "end" } }, 4);
  assert.equal(ends.notes[0]!.start, 3.75);
  assert.ok(Math.abs(ends.notes[0]!.duration - 0.25) < 1e-9);
  const clamped = applyMidiTransform([note(60, 3.9, 0.2, 100, 1)], { type: "quantize", params: { grid: 1, amount: 1, target: "both" } }, 4);
  assert.ok(clamped.notes[0]!.start + clamped.notes[0]!.duration <= 4);
});

test("swing shifts only exact odd-grid onsets and discloses off-grid skips", () => {
  const source = [note(60, 0, 0.25, 100, 1), note(62, 0.25, 0.25, 100, 2), note(64, 0.5, 0.25, 100, 3), note(65, 0.3, 0.25, 100, 4)];
  const result = applyMidiTransform(source, { type: "swing", params: { grid: 0.25, amount: 1 } });
  assert.equal(result.notes[0]!.start, 0);
  assert.ok(Math.abs(result.notes[1]!.start - 0.375) < 1e-9);
  assert.equal(result.notes[2]!.start, 0.5);
  assert.equal(result.notes[3]!.start, 0.3);
  assert.match(result.assumptions.join(" "), /1 off-grid note\(s\) left untouched/);
});

test("legato extends to the next onset and the clip end; staccato scales durations", () => {
  const source = [note(60, 0, 0.25, 100, 1), note(64, 1, 0.25, 100, 2), note(67, 3, 0.25, 100, 3)];
  const legato = applyMidiTransform(source, { type: "legato", params: {} }, 4);
  assert.deepEqual(legato.notes.map((item) => item.duration), [1, 2, 1]);
  const gapped = applyMidiTransform(source, { type: "legato", params: { gap: 0.5 } }, 4);
  assert.deepEqual(gapped.notes.map((item) => item.duration), [0.5, 1.5, 0.5]);
  const staccato = applyMidiTransform(source, { type: "staccato", params: { factor: 0.5 } });
  assert.deepEqual(staccato.notes.map((item) => item.duration), [0.125, 0.125, 0.125]);
});

test("rotate permutes pitches in stable order and preserves rhythm and ids", () => {
  const source = [note(60, 0, 0.5, 100, 10), note(64, 0.5, 0.5, 100, 11), note(67, 1, 0.5, 100, 12)];
  const result = applyMidiTransform(source, { type: "rotate", params: { steps: 1 } });
  assert.deepEqual(result.notes.map((item) => [item.id, item.pitch]), [[10, 67], [11, 60], [12, 64]]);
  assert.deepEqual(result.notes.map((item) => item.start), [0, 0.5, 1]);
  assert.equal(result.generative, false);
});

test("repeat subdivides exactly with bounded decay and drops source ids", () => {
  const source = [note(60, 0, 1, 100, 7)];
  const result = applyMidiTransform(source, { type: "repeat", params: { times: 4, decay: 0.5 } });
  assert.equal(result.notes.length, 4);
  assert.deepEqual(result.notes.map((item) => item.start), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(result.notes.map((item) => item.duration), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(result.notes.map((item) => item.velocity), [100, 50, 25, 13]);
  assert.ok(result.notes.every((item) => item.id === undefined));
  assert.equal(result.generative, true);
});

test("ratchet and repeat stay inside each source note's duration at tuplet boundaries", () => {
  const next = random(0x7a91e7);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const count = 1 + Math.floor(next() * 24);
    const source = randomNotes(next, count, 8).map((item, index) => ({ ...item, pitch: index % 128 }));
    const subdivisions = 2 + Math.floor(next() * 15);
    const ratcheted = applyMidiTransform(source, { type: "ratchet", params: { subdivisions, seed: `ratchet-${iteration}`, probability: 0.75 } }, 8);
    for (const item of source) {
      const parts = ratcheted.notes.filter((candidate) => candidate.start >= item.start && candidate.start < item.start + item.duration && candidate.pitch === item.pitch);
      for (const part of parts) {
        assert.ok(part.start + part.duration <= item.start + item.duration + 1e-9, `part exceeds source duration at iteration ${iteration}`);
        assert.ok(Math.abs(part.duration - item.duration / subdivisions) < 1e-9);
      }
      assert.ok(parts.length <= subdivisions);
    }
    const repeated = applyMidiTransform(source, { type: "repeat", params: { times: subdivisions > 8 ? 8 : subdivisions } }, 8);
    assert.equal(repeated.notes.length, source.length * Math.min(subdivisions, 8));
  }
});

test("chord voicing only affects onset groups of three or more notes", () => {
  const chord = [note(48, 0, 1, 100, 1), note(60, 0, 1, 100, 2), note(67, 0, 1, 100, 3), note(76, 0, 1, 100, 4)];
  const close = applyMidiTransform(chord, { type: "chord-voicing", params: { strategy: "close" } });
  const pitches = [...close.notes.map((item) => item.pitch)].sort((a, b) => a - b);
  assert.ok(pitches[pitches.length - 1]! - pitches[0]! <= 12);
  const drop2 = applyMidiTransform(chord, { type: "chord-voicing", params: { strategy: "drop2" } });
  assert.equal(drop2.notes.find((item) => item.id === 3)!.pitch, 55);
  const notAChord = applyMidiTransform([note(60, 0, 1, 100, 1), note(64, 0, 1, 100, 2)], { type: "chord-voicing", params: { strategy: "open" } });
  assert.deepEqual(notAChord.notes.map((item) => item.pitch), [60, 64]);
});

test("arpeggiate spreads chord onsets within the original span with exact rates", () => {
  const chord = [note(60, 0, 1, 100, 1), note(64, 0, 1, 100, 2), note(67, 0, 1, 100, 3)];
  const up = applyMidiTransform(chord, { type: "arpeggiate", params: { pattern: "up", rate: 0.25 } });
  assert.deepEqual(up.notes.map((item) => [item.pitch, item.start]), [[60, 0], [64, 0.25], [67, 0.5], [60, 0.75]]);
  const down = applyMidiTransform(chord, { type: "arpeggiate", params: { pattern: "down", rate: 0.5 } });
  assert.deepEqual(down.notes.map((item) => [item.pitch, item.start]), [[67, 0], [64, 0.5]]);
  const updown = applyMidiTransform(chord, { type: "arpeggiate", params: { pattern: "updown", rate: 0.25 } });
  assert.deepEqual(updown.notes.map((item) => item.pitch), [60, 64, 67, 64]);
  const single = applyMidiTransform([note(60, 2, 1, 100, 9)], { type: "arpeggiate", params: { pattern: "up", rate: 0.25 } });
  assert.deepEqual(single.notes.map((item) => [item.id, item.pitch, item.start]), [[9, 60, 2]]);
});

test("arpeggiate refuses pathological spans before allocating and honors the exact note bound", () => {
  // Extreme durations and rates across the legal parameter range refuse without an allocation spike.
  const next = random(0xa2291);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const span = Math.pow(10, next() * 9);
    const rate = (1 / 1024) * Math.pow(4096, next());
    const chord = [note(60, 0, span, 100, 1), note(64, 0, span, 100, 2)];
    const expected = Math.max(1, Math.floor(span / rate));
    if (expected > 2048) assert.throws(() => applyMidiTransform(chord, { type: "arpeggiate", params: { pattern: "up", rate } }), /2048/);
    else assert.equal(applyMidiTransform(chord, { type: "arpeggiate", params: { pattern: "up", rate } }).notes.length, expected);
  }
  // Legitimate arpeggios at exactly the 2048-note boundary still succeed.
  const boundary = [note(60, 0, 512, 100, 1), note(64, 0, 512, 100, 2)];
  assert.equal(applyMidiTransform(boundary, { type: "arpeggiate", params: { pattern: "up", rate: 0.25 } }).notes.length, 2048);
  // One step past the boundary and pathological drone spans refuse with a clear parameter error.
  assert.throws(() => applyMidiTransform([note(60, 0, 512.25, 100, 1), note(64, 0, 512.25, 100, 2)], { type: "arpeggiate", params: { pattern: "up", rate: 0.25 } }), /2048/);
  assert.throws(() => applyMidiTransform([note(60, 0, 1_000_000, 100, 1), note(64, 0, 1_000_000, 100, 2)], { type: "arpeggiate", params: { pattern: "up", rate: 1 / 1024 } }), /rate/);
});

test("seeded variation stays within bounded velocity, timing, and probability ranges", () => {
  const next = random(0xbeef01);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const source = randomNotes(next, 1 + Math.floor(next() * 48), 8);
    const result = applyMidiTransform(source, { type: "seeded-variation", params: { seed: `vary-${iteration}`, velocityMax: 16, timingMax: 0.1, probabilityDepth: 0.5 } }, 8);
    assert.equal(result.notes.length, source.length);
    for (const [index, item] of result.notes.entries()) {
      assert.ok(Math.abs(item.velocity - source[index]!.velocity) <= 16);
      assert.ok(Math.abs(item.start - source[index]!.start) <= 0.1 + 1e-9);
      assert.ok(item.start >= 0 && item.start + item.duration <= 8 + 1e-9);
      assert.ok(item.probability == null || (item.probability >= 0.5 && item.probability <= 1));
      assert.equal(item.id, source[index]!.id);
    }
  }
});

test("velocity curves are bounded and monotonic in the declared direction", () => {
  const source = [note(60, 0, 0.5, 64, 1), note(62, 1, 0.5, 64, 2), note(64, 2, 0.5, 64, 3)];
  const up = applyMidiTransform(source, { type: "velocity-curve", params: { curve: "linear-up", amount: 1 } });
  assert.ok(up.notes[0]!.velocity <= up.notes[1]!.velocity && up.notes[1]!.velocity <= up.notes[2]!.velocity);
  const down = applyMidiTransform(source, { type: "velocity-curve", params: { curve: "linear-down", amount: 1 } });
  assert.ok(down.notes[0]!.velocity >= down.notes[1]!.velocity && down.notes[1]!.velocity >= down.notes[2]!.velocity);
  for (const item of [...up.notes, ...down.notes]) assert.ok(item.velocity >= 1 && item.velocity <= 127);
});

test("diffNotes produces an exact minimal add/update/delete partition", () => {
  const before = [note(60, 0, 1, 100, 1), note(64, 1, 1, 100, 2), note(67, 2, 1, 100, 3)];
  const after = [note(60, 0, 1, 100, 1), note(65, 1, 1, 100, 2), note(69, 3, 1, 90)];
  const diff = diffNotes(before, after);
  assert.deepEqual(diff.delete, [3]);
  assert.equal(diff.update.length, 1);
  assert.equal(diff.update[0]!.id, 2);
  assert.equal(diff.update[0]!.pitch, 65);
  assert.equal(diff.add.length, 1);
  assert.equal(diff.add[0]!.pitch, 69);
  const empty = diffNotes(before, structuredClone(before));
  assert.equal(empty.add.length + empty.update.length + empty.delete.length, 0);
});

test("transform classification and expression probe are stable contracts", () => {
  for (const type of UPDATE_ONLY_TRANSFORMS) assert.ok(!GENERATIVE_TRANSFORMS.includes(type));
  for (const type of GENERATIVE_TRANSFORMS) assert.ok(!UPDATE_ONLY_TRANSFORMS.includes(type));
  assert.equal(new Set([...UPDATE_ONLY_TRANSFORMS, ...GENERATIVE_TRANSFORMS]).size, MIDI_TRANSFORM_TYPES.length);
  const probe = midiExpressionProbe();
  assert.equal(probe.exposesPerNoteExpression, false);
  assert.equal(probe.deleteRecreatePreservesExpression, false);
  assert.ok(!probe.noteSchemaFields.includes("pitchSlide"));
});

test("invalid inputs and unbounded note sets fail closed", () => {
  assert.throws(() => applyMidiTransform([note(140, 0, 1)], { type: "transpose", params: { semitones: 1 } }), /pitch/);
  assert.throws(() => applyMidiTransform([note(60, -1, 1)], { type: "transpose", params: { semitones: 1 } }), /start/);
  assert.throws(() => applyMidiTransform([note(60, 0, 0)], { type: "transpose", params: { semitones: 1 } }), /duration/);
  assert.throws(() => applyMidiTransform(Array.from({ length: 2049 }, (_, index) => note(60, index, 1)), { type: "transpose", params: { semitones: 1 } }), /2048/);
  assert.throws(() => applyMidiTransform([note(60, 0, 1)], { type: "bogus" as never, params: {} }), /unknown MIDI transform/);
  assert.equal(stableNoteOrder([note(64, 1, 1, 100, 2), note(60, 0, 1, 100, 1)])[0]!.id, 1);
});

test("swing never pushes a note past the clip end", () => {
  const source = [note(60, 3.75, 0.25, 100, 1)];
  const result = applyMidiTransform(source, { type: "swing", params: { grid: 0.25, amount: 1 } }, 4);
  assert.ok(result.notes[0]!.start + result.notes[0]!.duration <= 4);
  assert.equal(result.notes[0]!.start, 3.75);
  assert.match(result.assumptions.join(" "), /clamped to the clip end/);
});

test("quantize target=both moves the original start and end independently", () => {
  const source = [note(60, 0.1, 0.3, 100, 1)];
  const result = applyMidiTransform(source, { type: "quantize", params: { grid: 0.25, amount: 1, target: "both" } }, 4);
  assert.equal(result.notes[0]!.start, 0);
  assert.ok(Math.abs(result.notes[0]!.duration - 0.5) < 1e-9, "end quantizes from the original end, not the moved start");
});

test("note content digests stay valid at the full 2048-note transform bound", () => {
  const next = random(0x2048);
  const source = randomNotes(next, 2048, 16);
  const result = applyMidiTransform(source, { type: "transpose", params: { semitones: 1 } }, 16);
  assert.equal(result.notes.length, 2048);
  const digest = noteContentDigest(result.notes as unknown as Record<string, unknown>[]);
  assert.equal(digest.length, 64);
  assert.equal(noteContentDigest(structuredClone(result.notes) as unknown as Record<string, unknown>[]), digest);
  const over = randomNotes(next, 2049, 16);
  assert.throws(() => noteContentDigest(over as unknown as Record<string, unknown>[]), /2048/);
});
