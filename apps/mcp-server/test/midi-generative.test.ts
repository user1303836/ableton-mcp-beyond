import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "../src/live.js";
import { DRUM_ROLES, GENERATIVE_TRANSFORMS, UPDATE_ONLY_TRANSFORMS, applyMidiTransform, bjorklund, parseChordList, parseChordSymbol, parseRomanNumeral } from "../src/midi-transforms.js";

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

test("bjorklund distributes pulses maximally even across the grid", () => {
  assert.deepEqual(bjorklund(0, 8), new Array(8).fill(false));
  assert.deepEqual(bjorklund(8, 8), new Array(8).fill(true));
  assert.deepEqual(bjorklund(3, 8), [true, false, false, true, false, false, true, false]);
  for (let steps = 1; steps <= 18; steps += 1) {
    for (let pulses = 0; pulses <= steps; pulses += 1) {
      const pattern = bjorklund(pulses, steps);
      assert.equal(pattern.length, steps);
      assert.equal(pattern.filter(Boolean).length, pulses);
      if (pulses > 0 && pulses < steps) {
        const positions = pattern.map((hit, index) => (hit ? index : -1)).filter((index) => index >= 0);
        const gaps = positions.map((position, index) => {
          const next = positions[(index + 1) % positions.length]!;
          return ((next - position - 1 + steps) % steps) + 1;
        });
        assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `${pulses}-in-${steps}: gaps ${gaps} are not maximally even`);
      }
    }
  }
  assert.throws(() => bjorklund(5, 4), /invalid/);
});

test("euclidean generates the exact rotated pattern deterministically and replaces input", () => {
  const params = { pulses: 5, steps: 16, rotation: 0, pitch: 36, velocity: 110, noteLength: 0.2, stepLength: 0.25, bars: 2 };
  const first = applyMidiTransform([], { type: "euclidean", params });
  const second = applyMidiTransform([], { type: "euclidean", params });
  assert.deepEqual(first, second);
  assert.equal(first.generative, true);
  assert.equal(first.notes.length, 10);
  assert.deepEqual(first.notes.slice(0, 5).map((note) => note.start), [0, 0.75, 1.5, 2.25, 3]);
  assert.ok(first.notes.every((note) => note.pitch === 36 && note.velocity === 110 && Math.abs(note.duration - 0.2) < 1e-9));
  // Generators ignore the input note set: the same spec replaces existing content.
  const onContent = applyMidiTransform([note(60, 0, 1, 100, 1), note(64, 1, 1, 100, 2)], { type: "euclidean", params });
  assert.deepEqual(onContent.notes, first.notes);
  const rotated = applyMidiTransform([], { type: "euclidean", params: { ...params, rotation: 1, bars: 1 } });
  assert.deepEqual(rotated.notes.map((note) => note.start / 0.25), [2, 5, 8, 11, 15]);
  assert.throws(() => applyMidiTransform([], { type: "euclidean", params: { pulses: 9, steps: 8, pitch: 36 } }), /must not exceed/);
});

test("chord symbols and roman numerals parse into realized chord specs", () => {
  assert.deepEqual(parseChordSymbol("Cmaj7"), { rootPc: 0, intervals: [0, 4, 7, 11], name: "Cmaj7" });
  assert.deepEqual(parseChordSymbol("Dm7"), { rootPc: 2, intervals: [0, 3, 7, 10], name: "Dm7" });
  assert.deepEqual(parseChordSymbol("Bb7"), { rootPc: 10, intervals: [0, 4, 7, 10], name: "A#7" });
  assert.deepEqual(parseChordSymbol("F#dim"), { rootPc: 6, intervals: [0, 3, 6], name: "F#dim" });
  assert.throws(() => parseChordSymbol("H7"), /unsupported chord symbol/);
  // Realized from the scale, never assumed: ii in F minor is diminished, V is minor.
  assert.equal(parseRomanNumeral("ii", 5, "minor").name, "Gdim");
  assert.equal(parseRomanNumeral("V", 5, "minor").name, "Cm");
  assert.equal(parseRomanNumeral("V", 0, "major").name, "G");
  assert.equal(parseRomanNumeral("vii°", 0, "major").name, "Bdim");
  assert.equal(parseRomanNumeral("IV7", 0, "major").name, "Fmaj7");
  assert.throws(() => parseRomanNumeral("viii", 0, "major"), /unsupported roman numeral/);
  const parsed = parseChordList(["ii", "V", "I"], 5, "minor");
  assert.deepEqual(parsed.chords.map((chord) => chord.name), ["Gdim", "Cm", "Fm"]);
  assert.throws(() => parseChordList(["ii", "V", "I"], undefined, undefined), /require/);
  assert.throws(() => parseChordList(["ii", "G7"], 0, "major"), /must not mix/);
});

function progressionMovement(notes: readonly Note[], chords: number): number {
  let movement = 0;
  const perChord: Note[][] = [];
  for (let index = 0; index < chords; index += 1) {
    perChord.push(notes.filter((note) => Math.round(note.start) === index * 4).sort((a, b) => a.pitch - b.pitch));
  }
  for (let index = 1; index < chords; index += 1) {
    const before = perChord[index - 1]!;
    const after = perChord[index]!;
    for (let voice = 0; voice < Math.min(before.length, after.length); voice += 1) movement += Math.abs(before[voice]!.pitch - after[voice]!.pitch);
  }
  return movement;
}

test("chord progressions voice-lead with minimal movement and stay deterministic", () => {
  const params = { numerals: ["I", "IV", "V", "I"], root: 0, scale: "major", chordDuration: 4, octave: 4, velocity: 80 };
  const led = applyMidiTransform([], { type: "chord-progression", params: { ...params, voiceLeading: 1 } });
  const unled = applyMidiTransform([], { type: "chord-progression", params: { ...params, voiceLeading: 0 } });
  assert.equal(led.notes.length, 12);
  assert.deepEqual(led.notes.map((note) => note.start), [0, 0, 0, 4, 4, 4, 8, 8, 8, 12, 12, 12]);
  assert.match(led.assumptions.join(" "), /C - F - G - C/);
  assert.match(led.assumptions.join(" "), /minimal voice movement/);
  assert.deepEqual(applyMidiTransform([], { type: "chord-progression", params: { ...params, voiceLeading: 1 } }), led);
  assert.ok(progressionMovement(led.notes, 4) <= progressionMovement(unled.notes, 4), "voice-led movement must not exceed unled movement");
  // Monotone movement property across roots and progressions: leading never moves more.
  const next = random(0x1ead);
  const numeralsPool = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const root = Math.floor(next() * 12);
    const scale = next() < 0.5 ? "major" : "minor";
    const numerals = Array.from({ length: 4 }, () => numeralsPool[Math.floor(next() * numeralsPool.length)]!);
    const ledRun = applyMidiTransform([], { type: "chord-progression", params: { numerals, root, scale, chordDuration: 4, voiceLeading: 1 } });
    const unledRun = applyMidiTransform([], { type: "chord-progression", params: { numerals, root, scale, chordDuration: 4, voiceLeading: 0 } });
    assert.ok(progressionMovement(ledRun.notes, 4) <= progressionMovement(unledRun.notes, 4));
    assert.ok(ledRun.notes.every((note) => note.pitch >= 0 && note.pitch <= 127));
  }
  assert.throws(() => applyMidiTransform([], { type: "chord-progression", params: { numerals: ["I"], symbols: ["C"], root: 0, scale: "major" } }), /exactly one/);
  assert.throws(() => applyMidiTransform([], { type: "chord-progression", params: { numerals: ["I", "V"] } }), /require/);
});

test("chord voicings stay in range and symbols build explicit progressions", () => {
  const close = applyMidiTransform([], { type: "chord-progression", params: { symbols: ["C", "F", "G", "C"], voicing: "close", octave: 4 } });
  const drop2 = applyMidiTransform([], { type: "chord-progression", params: { symbols: ["C", "F", "G", "C"], voicing: "drop2", octave: 4 } });
  const spread = applyMidiTransform([], { type: "chord-progression", params: { symbols: ["C", "F", "G", "C"], voicing: "spread", octave: 4 } });
  for (const outcome of [close, drop2, spread]) {
    assert.equal(outcome.notes.length, 12);
    assert.ok(outcome.notes.every((note) => note.pitch >= 0 && note.pitch <= 127));
  }
  assert.notDeepEqual(drop2.notes.map((note) => note.pitch), close.notes.map((note) => note.pitch));
  assert.notDeepEqual(spread.notes.map((note) => note.pitch), close.notes.map((note) => note.pitch));
  assert.match(close.assumptions.join(" "), /explicit chord symbols/);
});

test("drum patterns honor the exact mapping, never invent pitches, and repeat byte-for-byte under seed", () => {
  const mapping = { kick: 36, snare: 38, closedHat: 42 };
  const params = { style: "four-on-the-floor", bars: 2, gridResolution: 16, mapping };
  const result = applyMidiTransform([], { type: "drum-pattern", params });
  assert.ok(result.notes.every((note) => [36, 38, 42].includes(note.pitch)));
  assert.equal(result.notes.filter((note) => note.pitch === 36 && note.start < 4).length, 4);
  assert.equal(result.notes.filter((note) => note.pitch === 38 && note.start < 4).length, 2);
  assert.match(result.assumptions.join(" "), /no pitch mapping for role\(s\) crash, openHat/);
  const coarse = applyMidiTransform([], { type: "drum-pattern", params: { ...params, gridResolution: 8 } });
  assert.match(coarse.assumptions.join(" "), /dropped because they fall between/);
  const dense = applyMidiTransform([], { type: "drum-pattern", params: { ...params, density: 0.5, seed: "kit-a" } });
  assert.equal(dense.seed, "kit-a");
  assert.deepEqual(applyMidiTransform([], { type: "drum-pattern", params: { ...params, density: 0.5, seed: "kit-a" } }).notes, dense.notes);
  assert.throws(() => applyMidiTransform([], { type: "drum-pattern", params: { ...params, density: 0.5 } }), /requires an explicit seed/);
  assert.throws(() => applyMidiTransform([], { type: "drum-pattern", params: { ...params, mapping: { tom: 50 } } }), /role/);
  assert.throws(() => applyMidiTransform([], { type: "drum-pattern", params: { ...params, mapping: { kick: 200 } } }), /0\.\.127/);
  const next = random(0xd04d);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const seed = `seed-${Math.floor(next() * 10000)}`;
    const a = applyMidiTransform([], { type: "drum-pattern", params: { style: "trap-hats", bars: 2, density: 0.7, seed, mapping: { kick: 36, snare: 38, closedHat: 42, openHat: 46 } } });
    const b = applyMidiTransform([], { type: "drum-pattern", params: { style: "trap-hats", bars: 2, density: 0.7, seed, mapping: { kick: 36, snare: 38, closedHat: 42, openHat: 46 } } });
    assert.deepEqual(a, b);
  }
  assert.ok(DRUM_ROLES.includes("kick"));
});

test("bassline templates follow chord roots deterministically", () => {
  const chords = ["C", "F", "G", "C"];
  const octave = applyMidiTransform([], { type: "bassline", params: { pattern: "octave", chords, octave: 2, stepBeats: 1, chordDuration: 4 } });
  assert.equal(octave.notes.length, 16);
  assert.equal(octave.notes[0]!.pitch, 36); // C2
  assert.equal(octave.notes[1]!.pitch, 48); // C3
  assert.equal(octave.notes[4]!.pitch, 41); // F2
  const walking = applyMidiTransform([], { type: "bassline", params: { pattern: "walking", chords, octave: 2, stepBeats: 1, chordDuration: 4 } });
  assert.equal(walking.notes[0]!.pitch, 36);
  assert.equal(walking.notes[3]!.pitch, 40); // chromatic approach from below into F2 (41)
  assert.equal(walking.notes[4]!.pitch, 41);
  const arpeggiated = applyMidiTransform([], { type: "bassline", params: { pattern: "arpeggiated", chords, octave: 2, stepBeats: 1, chordDuration: 4 } });
  assert.deepEqual(arpeggiated.notes.slice(0, 3).map((note) => note.pitch), [36, 40, 43]); // C E G
  assert.deepEqual(applyMidiTransform([], { type: "bassline", params: { pattern: "walking", chords, octave: 2 } }), walking);
  assert.throws(() => applyMidiTransform([], { type: "bassline", params: { pattern: "walking", chords: [] } }), /1-32/);
});

test("motif transforms invert, reverse, and scale rhythm exactly", () => {
  const source = [note(62, 0, 1, 100, 1), note(64, 1, 1, 110, 2), note(60, 2, 2, 90, 3)];
  const inverted = applyMidiTransform(source, { type: "motif-invert", params: { axis: 60 } }, 4);
  assert.deepEqual(inverted.notes.map((note) => note.pitch), [58, 56, 60]);
  assert.deepEqual(inverted.notes.map((note) => note.start), [0, 1, 2]);
  assert.equal(inverted.generative, false);
  const clamped = applyMidiTransform([note(100, 0, 1, 100, 1)], { type: "motif-invert", params: { axis: 10 } }, 4);
  assert.equal(clamped.notes[0]!.pitch, 0);
  assert.match(clamped.assumptions.join(" "), /clamped/);
  assert.throws(() => applyMidiTransform(source, { type: "motif-invert", params: {} }, 4), /explicit axis/);
  const retrograde = applyMidiTransform(source, { type: "motif-retrograde", params: {} }, 4);
  assert.deepEqual(retrograde.notes.map((note) => note.start), [3, 2, 0]);
  assert.deepEqual(retrograde.notes.map((note) => note.pitch), [62, 64, 60]);
  assert.throws(() => applyMidiTransform(source, { type: "motif-retrograde", params: {} }), /clip length/);
  const augmented = applyMidiTransform(source, { type: "motif-augment", params: { numerator: 2, denominator: 1 } }, 4);
  assert.deepEqual(augmented.notes.map((note) => [note.start, note.duration]), [[0, 2], [2, 2], [4, 4]]);
  const diminished = applyMidiTransform(source, { type: "motif-diminish", params: { numerator: 1, denominator: 2 } }, 4);
  assert.deepEqual(diminished.notes.map((note) => [note.start, note.duration]), [[0, 0.5], [0.5, 0.5], [1, 1]]);
  assert.throws(() => applyMidiTransform(source, { type: "motif-augment", params: { numerator: 1, denominator: 2 } }, 4), /above 1/);
  assert.throws(() => applyMidiTransform(source, { type: "motif-diminish", params: { numerator: 2, denominator: 1 } }, 4), /below 1/);
});

test("the generative/update-only partition covers the new transform types", () => {
  for (const type of ["euclidean", "chord-progression", "drum-pattern", "bassline"]) assert.ok(GENERATIVE_TRANSFORMS.includes(type as never));
  for (const type of ["motif-invert", "motif-retrograde", "motif-augment", "motif-diminish"]) assert.ok(UPDATE_ONLY_TRANSFORMS.includes(type as never));
});
