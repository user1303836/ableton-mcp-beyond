import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeStandardsAudio, STANDARDS_AUDIO_VERSION } from "../src/audio-standards.js";
import { analyzePcm } from "../src/analysis.js";

const SAMPLE_RATE = 48_000;

function programme(seconds: number, channels: number, sample: (frame: number, channel: number, frames: number) => number): Float32Array {
  const frames = Math.round(seconds * SAMPLE_RATE);
  return Float32Array.from({ length: frames * channels }, (_, index) => sample(Math.floor(index / channels), index % channels, frames));
}

function fadedTone(seconds: number, amplitude: number, frequency = 1_000): Float32Array {
  return programme(seconds, 2, (frame, _channel, frames) => {
    const fadeFrames = SAMPLE_RATE * 0.05;
    const fade = Math.min(1, frame / fadeFrames, (frames - 1 - frame) / fadeFrames);
    return amplitude * fade * Math.sin(2 * Math.PI * frequency * frame / SAMPLE_RATE);
  });
}

function steppedTone(levels: readonly number[], segmentSeconds: number): Float32Array {
  const totalSeconds = levels.length * segmentSeconds;
  return programme(totalSeconds, 2, (frame) => {
    const segmentFrames = SAMPLE_RATE * segmentSeconds;
    const segment = Math.min(levels.length - 1, Math.floor(frame / segmentFrames));
    const local = frame - segment * segmentFrames;
    const fadeFrames = SAMPLE_RATE * 0.05;
    const fade = Math.min(1, local / fadeFrames, (segmentFrames - 1 - local) / fadeFrames);
    return (levels[segment] ?? 0) * fade * Math.sin(2 * Math.PI * 1_000 * frame / SAMPLE_RATE);
  });
}

function close(actual: number | null, expected: number, tolerance: number, label: string): void {
  assert.notEqual(actual, null, `${label} should be available`);
  assert.ok(Math.abs(actual! - expected) <= tolerance, `${label}: expected ${expected}±${tolerance}, got ${actual}`);
}

// Expected values are independent FFmpeg 8.1 ebur128/libavfilter results for
// these generated programmes. See docs/evidence/phase-8-audio-oracle.json.
test("matches an independent BS.1770/EBU oracle for a steady stereo programme", () => {
  const result = analyzeStandardsAudio({ samples: fadedTone(10, 0.1), sampleRate: SAMPLE_RATE, channels: 2 });
  assert.equal(result.version, STANDARDS_AUDIO_VERSION);
  assert.equal(result.loudness.standardsCompliant, true);
  close(result.loudness.integratedLufs, -20.0, 0.1, "integrated loudness");
  close(result.loudness.relativeGateLufs, -30.0, 0.1, "relative gate");
  close(result.loudness.loudnessRange.lraLu, 0.0, 0.1, "loudness range");
  close(result.truePeak.aggregateDbtp, -20.0, 0.1, "true peak");
  assert.deepEqual(result.channelLayout, { labels: ["L", "R"], weights: [1, 1], explicit: false, lfeExcluded: false });
  assert.ok(result.loudness.momentary.series.length <= 128);
  assert.ok(result.loudness.shortTerm.series.length <= 128);
});

test("matches independent absolute/relative gating and LRA plateaus", () => {
  const gated = analyzeStandardsAudio({ samples: steppedTone([0.01, 0.1, 0, 0.03162277660168379], 4), sampleRate: SAMPLE_RATE, channels: 2 });
  close(gated.loudness.integratedLufs, -22.8, 0.1, "gated integrated loudness");
  close(gated.loudness.relativeGateLufs, -34.4, 0.1, "gated relative threshold");
  close(gated.loudness.loudnessRange.lraLu, 20.0, 0.1, "gated loudness range");
  close(gated.loudness.loudnessRange.lowLufs, -40.0, 0.1, "LRA low");
  close(gated.loudness.loudnessRange.highLufs, -20.0, 0.1, "LRA high");
  assert.ok(gated.loudness.blocks.aboveRelativeGate < gated.loudness.blocks.aboveAbsoluteGate);

  const lra = analyzeStandardsAudio({ samples: steppedTone([0.01, 0.1, 0.03162277660168379, 0.0031622776601683794, 0.05623413251903491], 5), sampleRate: SAMPLE_RATE, channels: 2 });
  close(lra.loudness.integratedLufs, -23.4, 0.1, "LRA programme integrated loudness");
  close(lra.loudness.loudnessRange.lraLu, 20.0, 0.1, "LRA programme range");
});

test("uses the published Annex 2 FIR and detects an inter-sample peak", () => {
  const samples = programme(5, 1, (frame, _channel, frames) => {
    const fade = Math.min(1, frame / (SAMPLE_RATE * 0.1), (frames - 1 - frame) / (SAMPLE_RATE * 0.1));
    return 0.9 * fade * Math.sin(2 * Math.PI * 12_000 * frame / SAMPLE_RATE + Math.PI / 4);
  });
  const samplePeak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const result = analyzeStandardsAudio({ samples, sampleRate: SAMPLE_RATE, channels: 1 });
  close(result.truePeak.aggregateDbtp, -0.9, 0.1, "Annex 2 true peak");
  assert.ok(20 * Math.log10(samplePeak) < -3.8);
  assert.ok((result.truePeak.aggregateDbtp ?? -100) - 20 * Math.log10(samplePeak) > 2.9);
  close(result.loudness.integratedLufs, -0.6, 0.1, "high-frequency integrated loudness");
});

test("does not manufacture true-peak overshoot at programme boundaries", () => {
  const constant = new Float32Array(SAMPLE_RATE).fill(1);
  const result = analyzeStandardsAudio({ samples: constant, sampleRate: SAMPLE_RATE, channels: 1 });
  close(result.truePeak.aggregateDbtp, 0, 0.02, "constant full-scale true peak");
  const short = analyzeStandardsAudio({ samples: Float32Array.of(1, 1, 1), sampleRate: SAMPLE_RATE, channels: 1 });
  close(short.truePeak.aggregateDbtp, 0, 0.01, "short full-scale true peak");
});

test("rejects non-finite, unbounded, empty, or oversized direct standards input", () => {
  assert.throws(() => analyzeStandardsAudio({ samples: Float32Array.of(Number.POSITIVE_INFINITY), sampleRate: SAMPLE_RATE, channels: 1 }), /finite/);
  assert.throws(() => analyzeStandardsAudio({ samples: Float32Array.of(5), sampleRate: SAMPLE_RATE, channels: 1 }), /bounded/);
  assert.throws(() => analyzeStandardsAudio({ samples: new Float32Array(0), sampleRate: SAMPLE_RATE, channels: 1 }), /1-10000000/);
  assert.throws(() => analyzeStandardsAudio({ samples: { length: 10_000_001 } as ArrayLike<number>, sampleRate: SAMPLE_RATE, channels: 1 }), /1-10000000/);
});

test("requires semantic multichannel layout, excludes LFE, and weights surround", () => {
  const frames = SAMPLE_RATE;
  const layout = ["L", "R", "C", "LFE", "Ls", "Rs"] as const;
  const lfeOnly = new Float32Array(frames * layout.length);
  for (let frame = 0; frame < frames; frame += 1) lfeOnly[frame * layout.length + 3] = 0.5 * Math.sin(2 * Math.PI * 100 * frame / SAMPLE_RATE);
  const excluded = analyzeStandardsAudio({ samples: lfeOnly, sampleRate: SAMPLE_RATE, channels: layout.length, channelLayout: layout });
  assert.equal(excluded.loudness.integratedLufs, null);
  assert.equal(excluded.channelLayout.lfeExcluded, true);

  const noLayout = analyzeStandardsAudio({ samples: lfeOnly, sampleRate: SAMPLE_RATE, channels: layout.length });
  assert.equal(noLayout.loudness.available, false);
  assert.match(noLayout.loudness.reason ?? "", /channelLayout is required/);

  const left = new Float32Array(frames * layout.length);
  const surround = new Float32Array(frames * layout.length);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = 0.1 * Math.sin(2 * Math.PI * 1_000 * frame / SAMPLE_RATE);
    left[frame * layout.length] = value;
    surround[frame * layout.length + 4] = value;
  }
  const leftResult = analyzeStandardsAudio({ samples: left, sampleRate: SAMPLE_RATE, channels: layout.length, channelLayout: layout });
  const surroundResult = analyzeStandardsAudio({ samples: surround, sampleRate: SAMPLE_RATE, channels: layout.length, channelLayout: layout });
  close((surroundResult.loudness.integratedLufs ?? 0) - (leftResult.loudness.integratedLufs ?? 0), 10 * Math.log10(1.41), 0.01, "surround weighting");
});

test("returns explicit unavailable states for short material and unvalidated true-peak rates", () => {
  const short = analyzeStandardsAudio({ samples: new Float32Array(1_000), sampleRate: SAMPLE_RATE, channels: 1 });
  assert.equal(short.loudness.available, false);
  assert.equal(short.loudness.integratedLufs, null);
  const silence = analyzeStandardsAudio({ samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE, channels: 1 });
  assert.equal(silence.loudness.available, false); assert.equal(silence.loudness.integratedLufs, null); assert.match(silence.loudness.reason ?? "", /absolute loudness gate/);
  assert.equal(short.loudness.loudnessRange.available, false);
  const rate44100 = analyzeStandardsAudio({ samples: Float32Array.from({ length: 44_100 }, (_, frame) => 0.1 * Math.sin(2 * Math.PI * 1_000 * frame / 44_100)), sampleRate: 44_100, channels: 1 });
  assert.equal(rate44100.truePeak.available, true);
  close(rate44100.truePeak.aggregateDbtp, -20, 0.15, "44.1 kHz true peak");
  assert.equal(rate44100.loudness.standardsCompliant, true);
  assert.ok(Number.isFinite(rate44100.loudness.integratedLufs));
  const otherRate = analyzeStandardsAudio({ samples: new Float32Array(96_000), sampleRate: 96_000, channels: 1 });
  assert.equal(otherRate.truePeak.available, false);
  assert.match(otherRate.truePeak.reason ?? "", /44\.1 and 48 kHz/);
});

test("snapshots mutable direct ArrayLike input once", () => {
  let reads = 0; let lengthReads = 0;
  const source = { length: SAMPLE_RATE, get [0]() { return 0; } } as unknown as ArrayLike<number>;
  const observable = new Proxy(source, { get(target, property, receiver) { if (property === "length") { lengthReads += 1; return lengthReads === 1 ? SAMPLE_RATE : 10_000_000; } if (typeof property === "string" && /^\d+$/.test(property)) { reads += 1; return reads <= SAMPLE_RATE ? 0.1 : Number.POSITIVE_INFINITY; } return Reflect.get(target, property, receiver); } });
  const result = analyzeStandardsAudio({ samples: observable, sampleRate: SAMPLE_RATE, channels: 1 });
  assert.equal(lengthReads, 1); assert.equal(reads, SAMPLE_RATE);
  assert.ok(Number.isFinite(result.loudness.integratedLufs));
});

test("pcm-analysis/v3 retains the named compatibility proxy but exposes standards separately", () => {
  const result = analyzePcm({ samples: fadedTone(1, 0.1), sampleRate: SAMPLE_RATE, channels: 2 });
  assert.equal(result.version, "pcm-analysis/v3");
  assert.equal(result.loudness.method, "rms-derived-proxy");
  assert.equal(result.loudness.standardsCompliant, false);
  assert.equal(result.standardsAudio.loudness.standardsCompliant, true);
  assert.notEqual(result.standardsAudio.loudness.integratedLufs, null);
});
