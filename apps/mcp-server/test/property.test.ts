import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm, decodeFloat32Le, MAX_ANALYSIS_CHANNELS, MAX_TIME_FREQUENCY_BANDS, MAX_TIME_FREQUENCY_FRAMES, MAX_WAVEFORM_BINS } from "../src/analysis.js";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("analysis preserves safety and boundedness invariants across generated PCM", () => {
  const next = random(0xaB1e70);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const length = 1 + Math.floor(next() * 2048);
    const samples = new Float32Array(length);
    for (let index = 0; index < length; index += 1) samples[index] = next() * 2 - 1;
    const result = analyzePcm({ samples, sampleRate: 8_000 + Math.floor(next() * 376_001) });
    assert.equal(result.performance.bounded, true);
    assert.equal(result.privacy.rawAudioRetained, false);
    assert.equal(result.privacy.rawAudioReturned, false);
    assert.equal(result.safety.playbackStarted, false);
    assert.equal(result.safety.projectMutated, false);
    assert.ok(result.peak >= 0 && result.peak <= 1);
    assert.ok(result.rms >= 0 && result.rms <= 1);
    assert.ok(result.clipping.ratio >= 0 && result.clipping.ratio <= 1);
    assert.equal(result.clipping.ratio, result.clipping.count / result.sampleCount);
    assert.equal(result.reconstructedOvers.applicable, false);
    assert.deepEqual({ count: result.reconstructedOvers.count, ratio: result.reconstructedOvers.ratio }, { count: 0, ratio: 0 });
  }
});

test("float32 decoding round-trips bounded generated values", () => {
  const next = random(0xdecafbad);
  const bytes = Buffer.alloc(4 * 128);
  for (let index = 0; index < 128; index += 1) bytes.writeFloatLE(next() * 2 - 1, index * 4);
  const decoded = decodeFloat32Le(bytes.toString("base64"));
  assert.equal(decoded.length, 128);
  for (const value of decoded) assert.ok(value >= -1 && value <= 1);
});

test("channel aggregation and stereo correlation remain finite and bounded", () => {
  const next = random(0x51e0);
  for (const channels of [1, 2, 3, MAX_ANALYSIS_CHANNELS]) {
    const frames = channels === MAX_ANALYSIS_CHANNELS ? 64 : 257;
    const samples = new Float32Array(frames * channels);
    for (let index = 0; index < samples.length; index += 1) samples[index] = next() * 2 - 1;
    const result = analyzePcm({ samples, sampleRate: 48_000, channels });
    assert.equal(result.channelsDetail.length, channels);
    for (const detail of result.channelsDetail) {
      assert.ok(Number.isFinite(detail.peak) && detail.peak >= 0 && detail.peak <= 1);
      assert.ok(Number.isFinite(detail.rms) && detail.rms >= 0 && detail.rms <= 1);
      assert.ok(Number.isFinite(detail.dcOffset) && detail.dcOffset >= -1 && detail.dcOffset <= 1);
      assert.ok(detail.clipping.ratio >= 0 && detail.clipping.ratio <= 1);
      assert.equal(detail.reconstructedOvers.applicable, false);
      assert.equal(detail.reconstructedOvers.count, 0);
    }
    const correlation = result.stereo.phaseCorrelation;
    assert.ok(correlation === null || (Number.isFinite(correlation) && correlation >= -1 && correlation <= 1));
    assert.deepEqual(result, analyzePcm({ samples, sampleRate: 48_000, channels }));
  }
});

test("lossy summaries remain finite, bounded, and do not expose PCM", () => {
  const next = random(0x7f31);
  for (const channels of [1, 2, 4, MAX_ANALYSIS_CHANNELS]) {
    const frames = channels === MAX_ANALYSIS_CHANNELS ? 257 : 4096;
    const samples = new Float32Array(frames * channels);
    for (let index = 0; index < samples.length; index += 1) samples[index] = next() * 2 - 1;
    const result = analyzePcm({ samples, sampleRate: 48_000, channels, frameSize: 1024 });
    assert.ok(result.waveform.bins.length <= MAX_WAVEFORM_BINS);
    assert.ok(result.timeFrequency.frames.length <= MAX_TIME_FREQUENCY_FRAMES);
    assert.equal(result.timeFrequency.bandCount, MAX_TIME_FREQUENCY_BANDS);
    assert.equal(result.waveform.lossy, true);
    assert.equal(result.timeFrequency.lossy, true);
    for (const bin of result.waveform.bins) for (const detail of bin.channels) {
      assert.ok(Number.isFinite(detail.min) && Number.isFinite(detail.max) && Number.isFinite(detail.rms));
      assert.ok(detail.min >= -1 && detail.max <= 1 && detail.min <= detail.max);
    }
    for (const frame of result.timeFrequency.frames) for (const band of frame.bands) {
      assert.ok(Number.isFinite(band.energy) && band.energy >= 0 && Number.isFinite(band.energyDb));
      assert.equal(band.channels.length, channels);
      assert.ok(band.channels.every((value) => Number.isFinite(value) && value >= 0));
    }
    assert.ok(result.transients.peakCount >= 0 && Number.isFinite(result.transients.densityPerSecond));
    assert.equal(result.privacy.rawAudioReturned, false);
  }
});
