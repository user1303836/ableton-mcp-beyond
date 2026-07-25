import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm, decodeFloat32Le, MAX_ANALYSIS_SAMPLES, MAX_ANALYSIS_SECONDS, MAX_FFT_SIZE, MAX_SPECTRAL_FRAMES } from "../src/analysis.js";
import { impulseFixture, sineFixture } from "./fixtures.js";

test("deterministically analyzes a fixture without exposing audio", () => {
  const fixture = sineFixture(4096, 440, 48000);
  const first = analyzePcm({ samples: fixture, sampleRate: 48000 });
  const second = analyzePcm({ samples: fixture, sampleRate: 48000 });
  assert.deepEqual(first, second);
  assert.ok(Math.abs(first.peak - 0.5) < 0.001);
  assert.ok(Math.abs(first.spectral.dominantFrequencyHz - 440.625) < 50);
  assert.equal(first.privacy.rawAudioRetained, false);
  assert.equal(first.privacy.rawAudioReturned, false);
  assert.equal(first.safety.playbackStarted, false);
  assert.equal(first.safety.projectMutated, false);
  assert.deepEqual(first.performance, { bounded: true, maxSamples: MAX_ANALYSIS_SAMPLES, maxSeconds: 600, maxSpectralFrames: MAX_SPECTRAL_FRAMES, maxFftSize: MAX_FFT_SIZE });
});

test("reports clipping and bounded reversible remediation", () => {
  const result = analyzePcm({ samples: Float32Array.from([0, 1, -1, 0.5]), sampleRate: 44100 });
  assert.equal(result.clipping.count, 2);
  assert.ok(result.remediation.some((item) => item.id === "reduce-clipping"));
  assert.ok(result.remediation.every((item) => item.reversible && !item.changesAudio));
  assert.equal(result.performance.maxSamples, MAX_ANALYSIS_SAMPLES);
});

test("rejects unsafe and malformed input", () => {
  assert.throws(() => analyzePcm({ samples: [1.1], sampleRate: 44100 }), /normalized/);
  assert.throws(() => analyzePcm({ samples: [0], sampleRate: 1000 }), /sampleRate/);
  assert.throws(() => analyzePcm({ samples: [], sampleRate: 44100 }), /samples/);
  assert.throws(() => decodeFloat32Le("not base64"), /float32|invalid/);
  assert.throws(() => decodeFloat32Le("AA=A"), /invalid/);
  assert.throws(() => decodeFloat32Le("Zh=="), /invalid/);
  assert.throws(() => analyzePcm({ samples: [0, 0, 0], sampleRate: 44100, channels: 2 }), /complete channel frames/);
  assert.throws(() => analyzePcm({ samples: [Number.NaN], sampleRate: 44100 }), /finite/);
  assert.throws(() => analyzePcm({ samples: [Number.POSITIVE_INFINITY], sampleRate: 44100 }), /finite/);
});

test("enforces sample and duration limits before reading untrusted sample storage", () => {
  const tooManySamples = { length: MAX_ANALYSIS_SAMPLES + 1 } as ArrayLike<number>;
  const tooLong = { length: 8_000 * MAX_ANALYSIS_SECONDS + 1 } as ArrayLike<number>;
  assert.throws(() => analyzePcm({ samples: tooManySamples, sampleRate: 8_000 }), /samples must contain/);
  assert.throws(() => analyzePcm({ samples: tooLong, sampleRate: 8_000 }), /duration exceeds/);
});

test("keeps spectral work bounded and remediation advisory at each threshold", () => {
  const result = analyzePcm({ samples: sineFixture(4096 * 33, 440, 48_000, 0.5), sampleRate: 48_000, frameSize: 4096 });
  assert.equal(result.spectral.analyzedFrames, MAX_SPECTRAL_FRAMES);
  assert.equal(result.spectral.fftSize, MAX_FFT_SIZE);
  assert.equal(result.remediation.length, 0);
  const loud = analyzePcm({ samples: Float32Array.from([0.99, -0.99, 0.5]), sampleRate: 44_100 });
  assert.ok(loud.remediation.some((item) => item.id === "leave-headroom"));
  assert.ok(loud.remediation.some((item) => item.id === "check-loudness"));
});

test("does not dilute spectral measurements with silent sampled frames", () => {
  const fixture = new Float32Array(4096 * 2);
  fixture.set(sineFixture(2048, 440, 48000), 0);
  const result = analyzePcm({ samples: fixture, sampleRate: 48000, frameSize: 2048 });
  assert.ok(result.spectral.centroidHz > 300);
  assert.ok(result.spectral.centroidHz < 2_000);
});

test("keeps impulse remediation advisory and bounded", () => {
  const result = analyzePcm({ samples: impulseFixture(4096), sampleRate: 44100 });
  assert.ok(result.remediation.some((item) => item.id === "reduce-clipping"));
  assert.ok(result.remediation.every((item) => item.reversible && !item.changesAudio));
  assert.deepEqual(result.privacy, { rawAudioRetained: false, rawAudioReturned: false, sourcePathAccepted: false });
  assert.deepEqual(result.safety, { playbackStarted: false, projectMutated: false, destructiveActionRequired: false });
});

test("accepts the exact maximum PCM payload size", () => {
  const bytes = Buffer.alloc(MAX_ANALYSIS_SAMPLES * 4);
  const decoded = decodeFloat32Le(bytes.toString("base64"));
  assert.equal(decoded.length, MAX_ANALYSIS_SAMPLES);
});

test("deinterleaves channels for spectral analysis and handles silence", () => {
  const stereo = new Float32Array(4096 * 2);
  for (let frame = 0; frame < 4096; frame += 1) stereo[frame * 2] = 0.5 * Math.sin((2 * Math.PI * 440 * frame) / 48000);
  const result = analyzePcm({ samples: stereo, sampleRate: 48000, channels: 2 });
  assert.ok(Math.abs(result.spectral.dominantFrequencyHz - 440.625) < 50);
  const silence = analyzePcm({ samples: new Float32Array(4096), sampleRate: 48000 });
  assert.equal(silence.spectral.dominantFrequencyHz, 0);
  assert.equal(silence.spectral.centroidHz, 0);
});
