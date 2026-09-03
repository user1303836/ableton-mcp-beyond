import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm, analyzeReconstructedPcm, decodeFloat32Le, MAX_ANALYSIS_CHANNELS, MAX_ANALYSIS_SAMPLES, MAX_ANALYSIS_SECONDS, MAX_FFT_SIZE, MAX_SPECTRAL_FRAMES, MAX_TIME_FREQUENCY_BANDS, MAX_TIME_FREQUENCY_FRAMES, MAX_WAVEFORM_BINS } from "../src/analysis.js";
import { dcFixture, impulseFixture, silenceFixture, sineFixture, stereoFixture, sweepFixture } from "./fixtures.js";

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
  assert.deepEqual(result.clipping, { count: 2, ratio: 0.5 });
  assert.equal(result.reconstructedOvers.applicable, false);
  assert.equal(result.reconstructedOvers.count, 0);
  assert.equal(result.channelsDetail[0]!.reconstructedOvers.applicable, false);
  assert.ok(result.remediation.some((item) => item.id === "reduce-clipping"));
  assert.ok(!result.remediation.some((item) => item.id === "inspect-reconstructed-overs"));
  assert.ok(result.remediation.every((item) => item.reversible && !item.changesAudio));
  assert.equal(result.performance.maxSamples, MAX_ANALYSIS_SAMPLES);
});

test("separates reconstructed overs and preserves their dynamics histogram", () => {
  const samples = Float64Array.from({ length: 100 }, (_, index) => index < 90 ? 0.5 : (index % 2 === 0 ? 1.25 : -1.25));
  const result = analyzeReconstructedPcm({ samples, sampleRate: 48_000 });
  assert.deepEqual(result.clipping, { count: 0, ratio: 0 });
  assert.deepEqual(result.reconstructedOvers, { count: 10, ratio: 0.1, threshold: 1, applicable: true });
  assert.equal(result.channelsDetail[0]!.clipping.count, 0);
  assert.equal(result.channelsDetail[0]!.reconstructedOvers.count, 10);
  assert.ok(!result.remediation.some((item) => item.id === "reduce-clipping"));
  assert.ok(result.remediation.some((item) => item.id === "inspect-reconstructed-overs"));
  const expectedDynamicRangeDb = 20 * Math.log10(1.25 / 0.5);
  assert.ok(Math.abs(result.dynamics.dynamicRangeDb - expectedDynamicRangeDb) < 0.01, `unexpected reconstructed dynamic range ${result.dynamics.dynamicRangeDb}`);
});

test("rejects unsafe and malformed input", () => {
  assert.throws(() => analyzePcm({ samples: [1.1], sampleRate: 44100 }), /normalized/);
  assert.throws(() => analyzePcm({ samples: [0], sampleRate: 1000 }), /sampleRate/);
  assert.throws(() => analyzePcm({ samples: [], sampleRate: 44100 }), /samples/);
  assert.throws(() => decodeFloat32Le("not base64"), /float32|invalid/);
  assert.throws(() => decodeFloat32Le("AA=A"), /invalid/);
  assert.throws(() => decodeFloat32Le("Zh=="), /invalid/);
  const nonFinite = Buffer.alloc(4);
  nonFinite.writeUInt32LE(0x7fc00000);
  assert.throws(() => decodeFloat32Le(nonFinite.toString("base64")), /finite normalized/);
  const outOfRange = Buffer.alloc(4);
  outOfRange.writeFloatLE(1.01);
  assert.throws(() => decodeFloat32Le(outOfRange.toString("base64")), /finite normalized/);
  assert.throws(() => analyzePcm({ samples: [0, 0, 0], sampleRate: 44100, channels: 2 }), /complete channel frames/);
  assert.throws(() => analyzePcm({ samples: [Number.NaN], sampleRate: 44100 }), /finite/);
  assert.throws(() => analyzePcm({ samples: [Number.POSITIVE_INFINITY], sampleRate: 44100 }), /finite/);
});

test("enforces sample and duration limits before reading untrusted sample storage", () => {
  const tooManySamples = { length: MAX_ANALYSIS_SAMPLES + 1 } as ArrayLike<number>;
  const tooLong = { length: 8_000 * MAX_ANALYSIS_SECONDS + 1 } as ArrayLike<number>;
  const negativeLength = { length: -1 } as ArrayLike<number>;
  assert.throws(() => analyzePcm({ samples: tooManySamples, sampleRate: 8_000 }), /samples must contain/);
  assert.throws(() => analyzePcm({ samples: tooLong, sampleRate: 8_000 }), /duration exceeds/);
  assert.throws(() => analyzePcm({ samples: negativeLength, sampleRate: 8_000 }), /samples must contain/);
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

test("preserves spectral evidence for antiphase stereo", () => {
  const stereo = new Float32Array(4096 * 2);
  for (let frame = 0; frame < 4096; frame += 1) {
    const sample = 0.5 * Math.sin((2 * Math.PI * 440 * frame) / 48000);
    stereo[frame * 2] = sample;
    stereo[frame * 2 + 1] = -sample;
  }
  const result = analyzePcm({ samples: stereo, sampleRate: 48000, channels: 2 });
  assert.ok(result.spectral.dominantFrequencyHz > 300);
});

test("reports bounded channel metrics and stereo phase correlation", () => {
  const result = analyzePcm({ samples: new Float32Array([1, 1, -1, -1, 0.5, -0.5, 0, 0]), sampleRate: 48_000, channels: 2 });
  assert.equal(result.channelsDetail.length, 2);
  assert.equal(result.channelsDetail[0]?.clipping.count, 2);
  assert.equal(result.channelsDetail[1]?.dcOffset, -0.125);
  assert.ok(Math.abs((result.stereo.phaseCorrelation ?? 0) - 7 / 9) < 1e-12);
  assert.equal(result.loudness.standardsCompliant, false);
  assert.equal(result.loudness.deprecatedIntegratedLufsEstimate, true);
});

test("covers deterministic mono, DC, unequal-level, independent, and antiphase fixtures", () => {
  const mono = analyzePcm({ samples: sineFixture(2048, 440, 48_000), sampleRate: 48_000 });
  assert.ok(Math.abs(mono.channelsDetail[0]?.rms! - 0.3535) < 0.01);
  const dc = analyzePcm({ samples: dcFixture(2048, 0.25), sampleRate: 48_000 });
  assert.equal(dc.channelsDetail[0]?.dcOffset, 0.25);
  const unequal = analyzePcm({ samples: stereoFixture(2048, () => 0.5, () => 0.125), sampleRate: 48_000, channels: 2 });
  assert.equal(unequal.channelsDetail[0]?.peak, 0.5);
  assert.equal(unequal.channelsDetail[1]?.peak, 0.125);
  assert.equal(unequal.stereo.phaseCorrelation, 1);
  const independent = analyzePcm({ samples: stereoFixture(2048, (frame) => Math.sin((2 * Math.PI * 220 * frame) / 48_000), (frame) => Math.sin((2 * Math.PI * 880 * frame) / 48_000)), sampleRate: 48_000, channels: 2 });
  assert.ok((independent.stereo.phaseCorrelation ?? 0) < 0.9);
  const antiphase = analyzePcm({ samples: stereoFixture(2048, (frame) => Math.sin((2 * Math.PI * 220 * frame) / 48_000), (frame) => -Math.sin((2 * Math.PI * 220 * frame) / 48_000)), sampleRate: 48_000, channels: 2 });
  assert.ok(Math.abs((antiphase.stereo.phaseCorrelation ?? 0) + 1) < 1e-12);
});

test("reports explicit not-applicable correlation and supports the maximum channel count", () => {
  const samples = new Float32Array(MAX_ANALYSIS_CHANNELS * 256);
  const result = analyzePcm({ samples, sampleRate: 48_000, channels: MAX_ANALYSIS_CHANNELS });
  assert.equal(result.channelsDetail.length, MAX_ANALYSIS_CHANNELS);
  assert.equal(result.stereo.phaseCorrelation, null);
  assert.match(result.stereo.reason ?? "", /only to stereo/);
  assert.ok(result.channelsDetail.every((detail) => Number.isFinite(detail.rms) && detail.clipping.ratio >= 0 && detail.clipping.ratio <= 1));
});

test("validates mutable array-like storage once and keeps the result deterministic", () => {
  let reads = 0;
  const samples = {
    length: 2048,
    get 0() { reads += 1; return reads === 1 ? 0.5 : Number.NaN; },
  } as unknown as ArrayLike<number>;
  for (let index = 1; index < samples.length; index += 1) {
    Object.defineProperty(samples, index, { value: 0, enumerable: false });
  }
  const result = analyzePcm({ samples, sampleRate: 48_000, frameSize: 1024 });
  assert.equal(reads, 1);
  assert.equal(result.peak, 0.5);
  assert.equal(result.safety.projectMutated, false);
});

test("returns bounded lossy waveform, logarithmic time-frequency, and transient summaries", () => {
  const result = analyzePcm({ samples: sineFixture(48_000, 440, 48_000), sampleRate: 48_000, frameSize: 1024 });
  assert.ok(result.waveform.binCount <= MAX_WAVEFORM_BINS);
  assert.ok(result.waveform.bins.length <= MAX_WAVEFORM_BINS);
  assert.equal(result.waveform.channelAggregation, "per-channel");
  assert.equal(result.waveform.lossy, true);
  assert.ok(result.waveform.bins.every((bin) => bin.channels.every((channel) => channel.min <= channel.max && Number.isFinite(channel.rms))));
  assert.ok(result.timeFrequency.frameCount <= MAX_TIME_FREQUENCY_FRAMES);
  assert.equal(result.timeFrequency.bandCount, MAX_TIME_FREQUENCY_BANDS);
  assert.equal(result.timeFrequency.channelAggregation, "per-channel-and-aggregate");
  assert.equal(result.timeFrequency.normalization, "mean-square-per-frame");
  assert.equal(result.timeFrequency.window, "hann");
  assert.equal(result.timeFrequency.hopSamples, 1024);
  assert.equal(result.timeFrequency.lossy, true);
  assert.ok(result.timeFrequency.frames.every((frame) => frame.bands.length === MAX_TIME_FREQUENCY_BANDS && frame.bands.every((band) => band.lowHz < band.highHz && band.highHz <= result.sampleRate / 2 && Number.isFinite(band.energy) && band.channels.length === 1)));
  assert.ok(result.timeFrequency.frames.some((frame) => frame.bands.some((band) => band.energy > 0)));
  const toneFrame = result.timeFrequency.frames[Math.floor(result.timeFrequency.frames.length / 2)];
  const strongestBand = toneFrame?.bands.reduce((strongest, band) => band.energy > strongest.energy ? band : strongest, toneFrame.bands[0]!);
  assert.ok(strongestBand && strongestBand.lowHz <= 440 && strongestBand.highHz >= 440);
  assert.ok(Number.isFinite(result.transients.peakCount) && result.transients.peakCount >= 0);
  const sweep = analyzePcm({ samples: sweepFixture(48_000, 220, 1_760, 48_000), sampleRate: 48_000, frameSize: 1024 });
  assert.ok(sweep.timeFrequency.frames.some((frame) => frame.bands.some((band) => band.energy > 0)));
});

test("never emits one waveform bin per source frame, including shortest inputs", () => {
  for (const frameCount of [1, 2, 3, 257, 1024]) {
    const result = analyzePcm({ samples: new Float32Array(frameCount), sampleRate: 48_000 });
    assert.ok(result.waveform.bins.length < frameCount);
    assert.equal(result.waveform.binCount, result.waveform.bins.length);
  }
});

test("independent golden checks keep logarithmic energy finite and tone-localized", () => {
  const sampleRate = 48_000;
  const frequency = 1_000;
  const amplitude = 0.5;
  const samples = sineFixture(16_384, frequency, sampleRate, amplitude);
  const result = analyzePcm({ samples, sampleRate, frameSize: 1024 });
  const frame = result.timeFrequency.frames[Math.floor(result.timeFrequency.frames.length / 2)];
  assert.ok(frame);
  const containing = frame.bands.find((band) => band.lowHz <= frequency && frequency < band.highHz);
  assert.ok(containing);
  // Independently calculated RMS power for a full-scale sine is A²/2. The
  // Hann window and logarithmic band aggregation retain a bounded fraction
  // of that energy, while silence remains exactly zero.
  assert.ok((containing?.energy ?? 0) > (amplitude * amplitude) / 100);
  assert.ok(frame.bands.every((band) => Number.isFinite(band.energy) && Number.isFinite(band.energyDb)));
  const silence = analyzePcm({ samples: new Float32Array(16_384), sampleRate, frameSize: 1024 });
  assert.ok(silence.timeFrequency.frames.every((item) => item.bands.every((band) => band.energy === 0)));
});

test("keeps waveform and time-frequency channel separation deterministic", () => {
  const stereo = stereoFixture(8192, (frame) => 0.5 * Math.sin((2 * Math.PI * 220 * frame) / 48_000), (frame) => 0.5 * Math.sin((2 * Math.PI * 1760 * frame) / 48_000));
  const result = analyzePcm({ samples: stereo, sampleRate: 48_000, channels: 2, frameSize: 1024 });
  const firstBin = result.waveform.bins[0];
  assert.ok(firstBin);
  assert.notDeepEqual(firstBin?.channels[0], firstBin?.channels[1]);
  const bandWithSeparation = result.timeFrequency.frames[0]?.bands.find((band) => Math.abs((band.channels[0] ?? 0) - (band.channels[1] ?? 0)) > 0.001);
  assert.ok(bandWithSeparation);
  assert.deepEqual(result, analyzePcm({ samples: stereo, sampleRate: 48_000, channels: 2, frameSize: 1024 }));
});

test("summarizes transients without making event or mastering claims", () => {
  const result = analyzePcm({ samples: impulseFixture(48_000, 0.8), sampleRate: 48_000 });
  assert.equal(result.transients.peakCount, 1);
  assert.equal(result.transients.strongest?.sampleIndex, 0);
  assert.ok(Math.abs((result.transients.strongest?.amplitude ?? 0) - 0.8) < 1e-6);
  assert.equal(result.timeFrequency.method, "hann-windowed-fft");
  assert.equal(result.loudness.standardsCompliant, false);
  const silence = analyzePcm({ samples: silenceFixture(2048), sampleRate: 48_000 });
  assert.ok(silence.timeFrequency.frames.every((frame) => frame.bands.every((band) => band.energy === 0 && band.energyDb <= -200)));
});
