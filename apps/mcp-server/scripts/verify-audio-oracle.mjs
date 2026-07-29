#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeStandardsAudio } from "../dist/src/audio-standards.js";

const SAMPLE_RATE = 48_000;
const TOLERANCE = { loudnessLu: 0.1, truePeakDb: 0.1 };

function programme(seconds, channels, callback) {
  const frames = Math.round(seconds * SAMPLE_RATE);
  return Float32Array.from({ length: frames * channels }, (_, index) => callback(Math.floor(index / channels), index % channels, frames));
}

function fadedTone(seconds, channels, amplitude, frequency = 1_000, phase = 0, fadeSeconds = 0.05) {
  return programme(seconds, channels, (frame, _channel, frames) => {
    const fadeFrames = SAMPLE_RATE * fadeSeconds;
    const fade = Math.min(1, frame / fadeFrames, (frames - 1 - frame) / fadeFrames);
    return amplitude * fade * Math.sin(2 * Math.PI * frequency * frame / SAMPLE_RATE + phase);
  });
}

function steppedTone(levels, segmentSeconds) {
  return programme(levels.length * segmentSeconds, 2, (frame) => {
    const segmentFrames = SAMPLE_RATE * segmentSeconds;
    const segment = Math.min(levels.length - 1, Math.floor(frame / segmentFrames));
    const local = frame - segment * segmentFrames;
    const fadeFrames = SAMPLE_RATE * 0.05;
    const fade = Math.min(1, local / fadeFrames, (segmentFrames - 1 - local) / fadeFrames);
    return levels[segment] * fade * Math.sin(2 * Math.PI * 1_000 * frame / SAMPLE_RATE);
  });
}

const fixtures = [
  { id: "stereo-1khz-faded", channels: 2, samples: fadedTone(10, 2, 0.1), checks: ["integratedLufs", "relativeGateLufs", "lraLu", "lraLowLufs", "lraHighLufs", "truePeakDbtp"] },
  { id: "absolute-relative-gates", channels: 2, samples: steppedTone([0.01, 0.1, 0, 0.03162277660168379], 4), checks: ["integratedLufs", "relativeGateLufs", "lraLu", "lraLowLufs", "lraHighLufs", "truePeakDbtp"] },
  { id: "lra-plateaus", channels: 2, samples: steppedTone([0.01, 0.1, 0.03162277660168379, 0.0031622776601683794, 0.05623413251903491], 5), checks: ["integratedLufs", "relativeGateLufs", "lraLu", "lraLowLufs", "lraHighLufs", "truePeakDbtp"] },
  { id: "12khz-inter-sample-peak", channels: 1, samples: fadedTone(5, 1, 0.9, 12_000, Math.PI / 4, 0.1), checks: ["integratedLufs", "relativeGateLufs", "lraLu", "truePeakDbtp"] },
  { id: "44k1-inter-sample-peak", sampleRate: 44_100, channels: 1, samples: Float32Array.from({ length: 44_100 * 5 }, (_, frame) => 0.9 * Math.min(1, frame / 4_410, (44_100 * 5 - 1 - frame) / 4_410) * Math.sin(2 * Math.PI * 11_025 * frame / 44_100 + Math.PI / 4)), checks: ["integratedLufs", "relativeGateLufs", "lraLu", "truePeakDbtp"] },
];

function pcmBuffer(samples) {
  const output = Buffer.alloc(samples.length * 4);
  samples.forEach((value, index) => output.writeFloatLE(value, index * 4));
  return output;
}

function capture(text, expression, label) {
  const match = text.match(expression);
  if (!match) throw new Error(`could not parse FFmpeg ${label}`);
  return Number(match[1]);
}

function ffmpegVersion() {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error("ffmpeg is required for the independent audio oracle gate");
  return result.stdout.split("\n")[0].trim();
}

const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-audio-oracle-"));
chmodSync(directory, 0o700);
const records = [];
try {
  for (const fixture of fixtures) {
    const path = join(directory, `${fixture.id}.f32`);
    const bytes = pcmBuffer(fixture.samples);
    writeFileSync(path, bytes, { mode: 0o600 });
    const sampleRate = fixture.sampleRate ?? SAMPLE_RATE;
    const command = ["-hide_banner", "-nostats", "-f", "f32le", "-ar", String(sampleRate), "-ac", String(fixture.channels), "-i", path, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"];
    const oracleRun = spawnSync("ffmpeg", command, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    if (oracleRun.status !== 0) {
      const detail = oracleRun.error?.message ?? `status=${oracleRun.status ?? "none"} signal=${oracleRun.signal ?? "none"}; ${String(oracleRun.stderr ?? "").slice(-4_096)}`;
      throw new Error(`FFmpeg oracle failed for ${fixture.id}: ${detail}`);
    }
    const log = oracleRun.stderr;
    const oracle = {
      integratedLufs: capture(log, /Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?) LUFS/s, "integrated loudness"),
      relativeGateLufs: capture(log, /Integrated loudness:.*?Threshold:\s+(-?\d+(?:\.\d+)?) LUFS/s, "integrated threshold"),
      lraLu: capture(log, /Loudness range:\s+LRA:\s+(-?\d+(?:\.\d+)?) LU/s, "loudness range"),
      lraLowLufs: capture(log, /LRA low:\s+(-?\d+(?:\.\d+)?) LUFS/s, "LRA low"),
      lraHighLufs: capture(log, /LRA high:\s+(-?\d+(?:\.\d+)?) LUFS/s, "LRA high"),
      truePeakDbtp: capture(log, /True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?) dBFS/s, "true peak"),
    };
    const actual = analyzeStandardsAudio({ samples: fixture.samples, sampleRate, channels: fixture.channels });
    const implementation = {
      integratedLufs: actual.loudness.integratedLufs,
      relativeGateLufs: actual.loudness.relativeGateLufs,
      lraLu: actual.loudness.loudnessRange.lraLu,
      lraLowLufs: actual.loudness.loudnessRange.lowLufs,
      lraHighLufs: actual.loudness.loudnessRange.highLufs,
      truePeakDbtp: actual.truePeak.aggregateDbtp,
    };
    for (const key of fixture.checks) {
      if (!Number.isFinite(implementation[key]) || !Number.isFinite(oracle[key])) throw new Error(`${fixture.id} ${key} must be a finite implementation and oracle measurement`);
    }
    const differences = Object.fromEntries(fixture.checks.map((key) => [key, Math.abs(implementation[key] - oracle[key])]));
    for (const [key, difference] of Object.entries(differences)) {
      const tolerance = key === "truePeakDbtp" ? (sampleRate === 44_100 ? 0.15 : TOLERANCE.truePeakDb) : TOLERANCE.loudnessLu;
      if (!(difference <= tolerance + 1e-9)) throw new Error(`${fixture.id} ${key} differs by ${difference}, exceeding ${tolerance}`);
    }
    records.push({ id: fixture.id, sampleRate, generatedPcmSha256: createHash("sha256").update(bytes).digest("hex"), frames: fixture.samples.length / fixture.channels, channels: fixture.channels, oracle, implementation, absoluteDifferences: differences, passed: true });
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  implementation: "bs1770-5-ebu-r128-2023/v1",
  normativeSources: [
    "https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf",
    "https://tech.ebu.ch/docs/r/r128.pdf",
    "https://tech.ebu.ch/docs/tech/tech3341.pdf",
    "https://tech.ebu.ch/docs/tech/tech3342.pdf"
  ],
  independentOracle: { implementation: ffmpegVersion(), filter: "ebur128=peak=true", input: "generated 44.1/48 kHz float32 PCM", redistribution: "no third-party audio stored" },
  tolerance: { ...TOLERANCE, truePeakDbAt44100: 0.15 },
  fixtures: records,
  privacy: { rawPcmCommitted: false, temporaryDirectoryOwnerOnly: true, temporaryFilesOwnerOnly: true, temporaryFilesRemoved: true },
  passed: records.every((record) => record.passed),
};

const writeIndex = process.argv.indexOf("--write-evidence");
if (writeIndex >= 0) {
  const destination = process.argv[writeIndex + 1];
  if (!destination) throw new Error("--write-evidence requires a path");
  writeFileSync(resolve(destination), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
