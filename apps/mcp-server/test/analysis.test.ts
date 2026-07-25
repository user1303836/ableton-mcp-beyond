import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm, decodeFloat32Le, MAX_ANALYSIS_SAMPLES } from "../src/analysis.js";

function sine(length: number, frequency: number, sampleRate: number): Float32Array {
  const result = new Float32Array(length);
  for (let i = 0; i < length; i += 1) result[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return result;
}

test("deterministically analyzes a fixture without exposing audio", () => {
  const fixture = sine(4096, 440, 48000);
  const first = analyzePcm({ samples: fixture, sampleRate: 48000 });
  const second = analyzePcm({ samples: fixture, sampleRate: 48000 });
  assert.deepEqual(first, second);
  assert.ok(Math.abs(first.peak - 0.5) < 0.001);
  assert.ok(Math.abs(first.spectral.dominantFrequencyHz - 440.625) < 50);
  assert.equal(first.privacy.rawAudioRetained, false);
  assert.equal(first.privacy.rawAudioReturned, false);
  assert.equal(first.safety.playbackStarted, false);
  assert.equal(first.safety.projectMutated, false);
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
  assert.throws(() => analyzePcm({ samples: [0, 0, 0], sampleRate: 44100, channels: 2 }), /complete channel frames/);
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
