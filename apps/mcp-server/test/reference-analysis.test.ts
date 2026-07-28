import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReferenceAudio, MAX_COMPARISON_TOTAL_SAMPLES, resamplePcm } from "../src/reference-analysis.js";

function deterministicProgramme(sampleRate: number, seconds: number): Float32Array {
  const frames = Math.round(sampleRate * seconds);
  let seed = 0x5eed1234;
  let smooth = 0;
  return Float32Array.from({ length: frames }, (_, frame) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = seed / 0x1_0000_0000 * 2 - 1;
    smooth = 0.98 * smooth + 0.02 * noise;
    const envelope = 0.15 + 0.75 * Math.pow(Math.sin(Math.PI * frame / frames), 2);
    return 0.5 * smooth * envelope;
  });
}

test("band-limited resampling preserves bounded tone frequency, level, and duration", () => {
  const sourceRate = 44_100;
  const samples = Float32Array.from({ length: sourceRate * 2 }, (_, frame) => 0.5 * Math.sin(2 * Math.PI * 1_000 * frame / sourceRate));
  const result = resamplePcm({ samples, sampleRate: sourceRate, channels: 1 });
  assert.equal(result.length, 96_000);
  let sumSquares = 0;
  let peak = 0;
  for (const value of result.subarray(100, result.length - 100)) { sumSquares += value * value; peak = Math.max(peak, Math.abs(value)); }
  assert.ok(Math.abs(Math.sqrt(sumSquares / (result.length - 200)) - Math.SQRT1_2 * 0.5) < 0.001);
  assert.ok(Math.abs(peak - 0.5) < 0.002);
  assert.deepEqual(result, resamplePcm({ samples, sampleRate: sourceRate, channels: 1 }));
});

test("resampling short alternating material remains bounded at both edges", () => {
  const samples = Float32Array.from({ length: 188 }, (_, index) => index % 2 === 0 ? 1 : -1);
  const resampled = resamplePcm({ samples, sampleRate: 32_000, channels: 1 });
  assert.ok([...resampled].every(Number.isFinite));
  assert.ok([...resampled].every((value) => Math.abs(value) <= 2), `unexpected reconstructed peak ${Math.max(...resampled.map(Math.abs))}`);
  const comparison = compareReferenceAudio({ project: { samples, sampleRate: 32_000, channels: 1 }, reference: { samples, sampleRate: 32_000, channels: 1 }, alignment: { mode: "disabled" } });
  assert.equal(comparison.alignment.available, true);
});

test("snapshots observable source length and values once", () => {
  let lengthReads = 0; let sampleReads = 0;
  const source = new Proxy({ length: 320 } as unknown as ArrayLike<number>, { get(target, property, receiver) { if (property === "length") { lengthReads += 1; return lengthReads === 1 ? 320 : 4_000_001; } if (typeof property === "string" && /^\d+$/.test(property)) { sampleReads += 1; return 0.1; } return Reflect.get(target, property, receiver); } });
  const output = resamplePcm({ samples: source, sampleRate: 32_000, channels: 1 });
  assert.equal(lengthReads, 1); assert.equal(sampleReads, 320); assert.equal(output.length, 480);
});

test("aligns a known offset and compares only equal overlap", () => {
  const project = deterministicProgramme(48_000, 4);
  const delayFrames = Math.round(0.237 * 48_000);
  const reference = new Float32Array(project.length + delayFrames);
  reference.set(project, delayFrames);
  const result = compareReferenceAudio({ project: { samples: project, sampleRate: 48_000, channels: 1 }, reference: { samples: reference, sampleRate: 48_000, channels: 1 }, alignment: { mode: "auto", maxLagSeconds: 1 } });
  assert.equal(result.alignment.available, true);
  assert.equal(result.alignment.ambiguous, false);
  assert.ok(Math.abs((result.alignment.referenceOffsetSeconds ?? 0) - 0.237) <= 0.001);
  assert.ok((result.alignment.correlation ?? 0) > 0.999);
  assert.equal(result.alignment.overlapSeconds, 4);
  assert.ok(Math.abs(result.deltas.projectMinusReference.integratedLoudnessLu ?? 1) < 0.001);
  assert.ok(Math.abs(result.levelMatch.projectGainToReferenceDb ?? 1) < 0.001);
  assert.equal(result.privacy.rawAudioReturned, false);
});

test("normalizes mismatched rates and reports a standards loudness level-match suggestion", () => {
  const projectRate = 44_100;
  const referenceRate = 48_000;
  const seconds = 3;
  const project = Float32Array.from({ length: projectRate * seconds }, (_, frame) => 0.1 * Math.sin(2 * Math.PI * 997 * frame / projectRate));
  const reference = Float32Array.from({ length: referenceRate * seconds }, (_, frame) => 0.2 * Math.sin(2 * Math.PI * 997 * frame / referenceRate));
  const result = compareReferenceAudio({ project: { samples: project, sampleRate: projectRate, channels: 1 }, reference: { samples: reference, sampleRate: referenceRate, channels: 1 }, alignment: { mode: "disabled" } });
  assert.equal(result.resampling.project.resampled, true);
  assert.equal(result.resampling.reference.resampled, false);
  assert.equal(result.levelMatch.available, true);
  assert.ok(Math.abs((result.levelMatch.projectGainToReferenceDb ?? 0) - 6.0206) < 0.1);
  assert.ok(Math.abs((result.deltas.projectMinusReference.integratedLoudnessLu ?? 0) + 6.0206) < 0.1);
  assert.equal(result.levelMatch.changesAudio, false);
});

test("fails auto alignment closed for an ambiguous steady envelope and supports explicit manual alignment", () => {
  const samples = Float32Array.from({ length: 48_000 * 2 }, (_, frame) => 0.1 * Math.sin(2 * Math.PI * 1_000 * frame / 48_000));
  const ambiguous = compareReferenceAudio({ project: { samples, sampleRate: 48_000, channels: 1 }, reference: { samples, sampleRate: 48_000, channels: 1 }, alignment: { mode: "auto", maxLagSeconds: 0.5 } });
  assert.equal(ambiguous.alignment.available, false);
  assert.equal(ambiguous.alignment.ambiguous, true);
  assert.match(ambiguous.alignment.reason ?? "", /variation|weak|competing/);
  const manual = compareReferenceAudio({ project: { samples, sampleRate: 48_000, channels: 1 }, reference: { samples, sampleRate: 48_000, channels: 1 }, alignment: { mode: "manual", maxLagSeconds: 0.5, manualOffsetSeconds: 0 } });
  assert.equal(manual.alignment.available, true);
  assert.equal(manual.alignment.referenceOffsetSeconds, 0);
});

test("enforces pair, channel, duration, and lag bounds before unbounded work", () => {
  const overPair = { length: MAX_COMPARISON_TOTAL_SAMPLES } as ArrayLike<number>;
  const one = Float32Array.of(0);
  assert.throws(() => compareReferenceAudio({ project: { samples: overPair, sampleRate: 48_000, channels: 1 }, reference: { samples: one, sampleRate: 48_000, channels: 1 } }), /pair limit/);
  assert.throws(() => compareReferenceAudio({ project: { samples: one, sampleRate: 48_000, channels: 3 }, reference: { samples: one, sampleRate: 48_000, channels: 1 } }), /channels/);
  const tooLong = new Float32Array(32_000 * 31);
  assert.throws(() => compareReferenceAudio({ project: { samples: tooLong, sampleRate: 32_000, channels: 1 }, reference: { samples: one, sampleRate: 48_000, channels: 1 } }), /duration/);
  assert.throws(() => resamplePcm({ samples: Float32Array.of(Number.NaN), sampleRate: 48_000, channels: 1 }), /finite normalized/);
  assert.throws(() => resamplePcm({ samples: one, sampleRate: 384_000, channels: 1 }), /32000 to 96000/);
  assert.throws(() => resamplePcm({ samples: one, sampleRate: 48_000, channels: 1 }, 384_000), /fixed 48000/);
  assert.throws(() => compareReferenceAudio({ project: { samples: one, sampleRate: 48_000, channels: 1 }, reference: { samples: one, sampleRate: 48_000, channels: 1 }, alignment: { maxLagSeconds: 11 } }), /maxLagSeconds/);
});
