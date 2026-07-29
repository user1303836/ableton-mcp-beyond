import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalysisRunner, MAX_ANALYSIS_JOB_REQUEST_BYTES, MAX_CONCURRENT_ANALYSIS_JOBS, MAX_QUEUED_ANALYSIS_JOBS } from "../src/analysis-runner.js";
import { MAX_ANALYSIS_SAMPLES } from "../src/analysis.js";

function encodedTone(frames = 48_000): string {
  const bytes = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame += 1) bytes.writeFloatLE(0.1 * Math.sin(2 * Math.PI * 440 * frame / 48_000), frame * 4);
  return bytes.toString("base64");
}

test("worker request bound contains the advertised maximum PCM payload", () => {
  const maximumBase64Bytes = Math.ceil((MAX_ANALYSIS_SAMPLES * 4) / 3) * 4;
  assert.ok(maximumBase64Bytes + 1_024 < MAX_ANALYSIS_JOB_REQUEST_BYTES);
});

test("runs standards analysis in a disposable bounded child process", async () => {
  const runner = new AnalysisRunner();
  const result = await runner.run({ mode: "analyze", source: { pcmBase64: encodedTone(), sampleRate: 48_000, channels: 1 } }) as Record<string, unknown>;
  assert.equal(result.version, "pcm-analysis/v2");
  assert.equal((result.privacy as Record<string, unknown>).rawAudioReturned, false);
  assert.deepEqual(runner.status(), { active: 0, queued: 0, maxConcurrent: MAX_CONCURRENT_ANALYSIS_JOBS, maxQueued: MAX_QUEUED_ANALYSIS_JOBS });
});

test("kills an isolated worker on cancellation and releases its slot", async () => {
  const runner = new AnalysisRunner();
  const controller = new AbortController();
  const pending = runner.run({ mode: "analyze", source: { pcmBase64: encodedTone(500_000), sampleRate: 48_000, channels: 1 } }, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, /cancelled/);
  assert.equal(runner.status().active, 0);
  assert.equal(runner.status().queued, 0);
});

test("enforces timeout, concurrency, and queue bounds", async () => {
  const timeoutRunner = new AnalysisRunner();
  await assert.rejects(timeoutRunner.run({ mode: "analyze", source: { pcmBase64: encodedTone(100_000), sampleRate: 48_000, channels: 1 } }, undefined, 1), /exceeded/);

  const runner = new AnalysisRunner();
  const pcmBase64 = encodedTone(300_000);
  const controllers = Array.from({ length: MAX_CONCURRENT_ANALYSIS_JOBS + MAX_QUEUED_ANALYSIS_JOBS + 1 }, () => new AbortController());
  const calls = controllers.map((controller) => runner.run({ mode: "analyze", source: { pcmBase64, sampleRate: 48_000, channels: 1 } }, controller.signal).then(() => "ok", (cause: Error) => cause.message));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runner.status(), { active: MAX_CONCURRENT_ANALYSIS_JOBS, queued: MAX_QUEUED_ANALYSIS_JOBS, maxConcurrent: MAX_CONCURRENT_ANALYSIS_JOBS, maxQueued: MAX_QUEUED_ANALYSIS_JOBS });
  const queueFull = await calls.at(-1);
  assert.match(queueFull ?? "", /queue is full/);
  for (const controller of controllers) controller.abort();
  await Promise.all(calls);
  assert.equal(runner.status().active, 0);
  assert.equal(runner.status().queued, 0);
});

test("contains malformed worker input as a redacted job error", async () => {
  const runner = new AnalysisRunner();
  await assert.rejects(runner.run({ mode: "analyze", source: { pcmBase64: "AAAA", sampleRate: 48_000, channels: 1 } }), /float32|normalized|bounded/);
  assert.equal(runner.status().active, 0);
});
