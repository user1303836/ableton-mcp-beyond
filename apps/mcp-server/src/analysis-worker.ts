import { analyzePcm, MAX_ANALYSIS_SAMPLES } from "./analysis.js";
import { performance } from "node:perf_hooks";

const samples = new Float32Array(MAX_ANALYSIS_SAMPLES);
for (let index = 0; index < samples.length; index += 1) {
  samples[index] = 0.5 * Math.sin((2 * Math.PI * 440 * index) / 48_000);
}

const before = process.memoryUsage();
analyzePcm({ samples, sampleRate: 48_000 });
const latencyMeasurements: number[] = [];
let result = analyzePcm({ samples, sampleRate: 48_000 });
for (let iteration = 0; iteration < 3; iteration += 1) {
  const started = performance.now();
  result = analyzePcm({ samples, sampleRate: 48_000 });
  latencyMeasurements.push(performance.now() - started);
}
const after = process.memoryUsage();
const peak = (name: keyof NodeJS.MemoryUsage): number => Math.max(before[name], after[name]);
process.stdout.write(JSON.stringify({
  peakRssBytes: peak("rss"),
  peakHeapUsedBytes: peak("heapUsed"),
  peakExternalBytes: peak("external"),
  peakArrayBuffersBytes: peak("arrayBuffers"),
  latencyMeasurements,
  outputBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
}) + "\n");
