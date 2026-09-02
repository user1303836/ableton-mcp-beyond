import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateKey, type KeyEstimateNote } from "../src/key-estimation.js";

function melody(pitches: readonly number[], options?: { velocity?: number; beatsPerNote?: number }): KeyEstimateNote[] {
  const beats = options?.beatsPerNote ?? 0.5;
  return pitches.map((pitch, index) => ({ pitch, start: index * beats, duration: beats, ...(options?.velocity !== undefined ? { velocity: options.velocity } : {}) }));
}

// Deterministic pseudo-random helper for generated material.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const C_MAJOR_MELODY = [60, 62, 64, 65, 67, 67, 64, 62, 60, 60, 67, 64, 62, 60, 64, 67, 65, 64, 62, 60];
const A_MINOR_MELODY = [57, 60, 64, 62, 60, 59, 57, 57, 64, 60, 59, 57, 60, 64, 65, 64, 62, 60, 59, 57];

test("known-key synthetic melodies rank the expected key first", () => {
  const cMajor = estimateKey(melody(C_MAJOR_MELODY));
  assert.equal(cMajor.candidates[0]!.key, "C major");
  assert.equal(cMajor.confidence === "high" || cMajor.confidence === "medium", true);

  const transposed = estimateKey(melody(C_MAJOR_MELODY.map((pitch) => pitch + 7)));
  assert.equal(transposed.candidates[0]!.key, "G major");

  const aMinor = estimateKey(melody(A_MINOR_MELODY));
  const topKeys = aMinor.candidates.slice(0, 3).map((candidate) => candidate.key);
  assert.ok(topKeys.includes("A minor"), `expected A minor in top candidates, got ${topKeys.join(", ")}`);
  // The relative major/minor pair must be reported as alternatives, never suppressed.
  assert.ok(aMinor.candidates.some((candidate) => candidate.key === "C major"));
});

test("estimates are deterministic and order-independent", () => {
  const next = random(0x5eed);
  const notes = melody(Array.from({ length: 32 }, () => 48 + Math.floor(next() * 24)));
  const baseline = estimateKey(notes);
  for (let iteration = 0; iteration < 25; iteration += 1) assert.deepEqual(estimateKey(notes), baseline);
  const shuffled = [...notes].reverse();
  assert.deepEqual(estimateKey(shuffled), baseline);
});

test("velocity is a documented secondary weight and omission equals full velocity", () => {
  const pitches = C_MAJOR_MELODY;
  const withoutVelocity = estimateKey(melody(pitches));
  const fullVelocity = estimateKey(melody(pitches, { velocity: 127 }));
  assert.deepEqual(fullVelocity, withoutVelocity);
  // Uniform velocity is a uniform weight scaling and cannot change correlations;
  // differentiating velocity between notes changes the profile deterministically.
  const uniformSoft = estimateKey(melody(pitches, { velocity: 40 }));
  assert.deepEqual(uniformSoft, withoutVelocity);
  const accented = estimateKey(pitches.map((pitch, index) => ({ pitch, start: index * 0.5, duration: 0.5, velocity: index % 2 === 0 ? 127 : 30 })));
  assert.notDeepEqual(accented, withoutVelocity);
});

test("insufficient-evidence cases never produce a forced answer", () => {
  for (const notes of [[], melody([60]), melody([60, 64]), melody([60, 60, 60, 60, 60]), melody([60, 61, 60, 61, 60])]) {
    const estimate = estimateKey(notes);
    assert.equal(estimate.confidence, "insufficient-evidence");
    assert.equal(estimate.ambiguous, false);
    assert.ok(estimate.evidence.noteCount === notes.length);
  }
  const chromatic = estimateKey(melody([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 60, 61, 62, 63]));
  assert.equal(chromatic.confidence, "insufficient-evidence");
  assert.equal(chromatic.evidence.chromatic, true);
});

test("ambiguous material reports alternatives instead of a forced key", () => {
  // Whole-tone-ish material: equidistant between two key centers.
  const wholeTone = melody([60, 62, 64, 66, 68, 70, 60, 62, 64, 66, 68, 70, 61, 63, 65, 67, 69, 71, 61, 63, 65, 67, 69, 71]);
  const estimate = estimateKey(wholeTone);
  assert.equal(estimate.confidence === "high", false);
  if (estimate.ambiguous) assert.ok(estimate.alternatives.length >= 2);
});

test("out-of-shape notes are skipped honestly", () => {
  const estimate = estimateKey([
    { pitch: 200, start: 0, duration: 1 },
    { pitch: 60, start: 0, duration: -4 },
    { pitch: 60, start: 0, duration: 1 },
    { pitch: 64, start: 1, duration: 1 },
    { pitch: 67, start: 2, duration: 1 },
  ]);
  assert.equal(estimate.evidence.noteCount, 3);
  assert.equal(estimate.evidence.pitchClassCount, 3);
});
