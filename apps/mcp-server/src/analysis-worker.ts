import { analyzePcm, MAX_ANALYSIS_SAMPLES } from "./analysis.js";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

type MemorySnapshot = { rss: number; heapUsed: number; external: number; arrayBuffers: number };

function updatePeak(peak: MemorySnapshot, sample: MemorySnapshot): void {
  peak.rss = Math.max(peak.rss, sample.rss);
  peak.heapUsed = Math.max(peak.heapUsed, sample.heapUsed);
  peak.external = Math.max(peak.external, sample.external);
  peak.arrayBuffers = Math.max(peak.arrayBuffers, sample.arrayBuffers);
}

function currentMemory(): MemorySnapshot {
  const memory = process.memoryUsage();
  return { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external, arrayBuffers: memory.arrayBuffers };
}

async function sampleMemory(): Promise<{ stop: () => Promise<void>; peak: MemorySnapshot }> {
  const peak = currentMemory();
  const sampler = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const sample = () => {
      const m = process.memoryUsage();
      parentPort.postMessage({ rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers });
    };
    const timer = setInterval(sample, 1);
    sample();
    parentPort.on("message", (message) => {
      if (message === "stop") { clearInterval(timer); sample(); process.exit(0); }
    });
  `, { eval: true });
  sampler.on("message", (sample: MemorySnapshot) => updatePeak(peak, sample));
  const stopped = new Promise<void>((resolve) => sampler.once("exit", () => resolve()));
  return { peak, stop: async () => { sampler.postMessage("stop"); await stopped; } };
}

async function main(): Promise<void> {
  const slowMatch = process.argv.find((value) => value.startsWith("--slow="));
  const slowMilliseconds = slowMatch ? Number(slowMatch.slice("--slow=".length)) : 0;
  const allocationMode = process.argv.includes("--allocate");
  const samples = new Float32Array(MAX_ANALYSIS_SAMPLES);
  for (let index = 0; index < samples.length; index += 1) samples[index] = 0.5 * Math.sin((2 * Math.PI * 440 * index) / 48_000);
  const sampler = await sampleMemory();
  const retained: Float64Array[] = [];
  const latencyMeasurements: number[] = [];
  let result = analyzePcm({ samples, sampleRate: 48_000 });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const started = performance.now();
    if (slowMilliseconds > 0) {
      const until = performance.now() + slowMilliseconds;
      while (performance.now() < until) { /* controlled regression mode */ }
    }
    result = analyzePcm({ samples, sampleRate: 48_000 });
    if (allocationMode) retained.push(new Float64Array(samples.length), new Float64Array(samples.length));
    latencyMeasurements.push(performance.now() - started);
  }
  updatePeak(sampler.peak, currentMemory());
  await sampler.stop();
  process.stdout.write(JSON.stringify({
    peakRssBytes: sampler.peak.rss,
    peakHeapUsedBytes: sampler.peak.heapUsed,
    peakExternalBytes: sampler.peak.external,
    peakArrayBuffersBytes: sampler.peak.arrayBuffers,
    latencyMeasurements,
    outputBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
  }) + "\n");
}

await main();
