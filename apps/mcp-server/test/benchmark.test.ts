import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm } from "../src/analysis.js";
import { ANALYSIS_MEASUREMENTS, BENCHMARK_BUDGETS, measureIsolatedMaximumInputAnalysis, measureMaximumInputAnalysis, runBenchmarks } from "../src/benchmark.js";

test("benchmark gates measure bounded protocol and analysis behavior", async () => {
  const report = await runBenchmarks();
  assert.deepEqual(report.measurements.map((measurement) => measurement.name), [
    "rpc_ping_p95_latency",
    "rpc_ping_throughput",
    "ndjson_batch_p95_latency",
    "ndjson_response_loss",
    "cancellation_p95_latency",
    "malformed_stream_recovery_latency",
    "restart_resume_latency",
    "pcm_analysis_p95_latency",
    "pcm_analysis_array_buffer_delta",
    "pcm_analysis_output_bytes",
    "pcm_isolated_latency_p95",
    "pcm_isolated_peak_rss",
    "pcm_isolated_peak_heap_used",
    "pcm_isolated_peak_external",
    "pcm_isolated_peak_array_buffers",
    "pcm_isolated_output_bytes",
    "pcm_max_channel_analysis_p95_latency",
    "pcm_waveform_time_frequency_p95_latency",
    "pcm_waveform_time_frequency_output_bytes",
  ]);
  assert.equal(report.measurements.find((measurement) => measurement.name === "ndjson_response_loss")?.budget, BENCHMARK_BUDGETS.responseLossPercent);
  assert.equal(report.measurements.find((measurement) => measurement.name === "restart_resume_latency")?.budget, BENCHMARK_BUDGETS.resumeMilliseconds);
  assert.ok(ANALYSIS_MEASUREMENTS >= 3);
  assert.equal(report.passed, true, JSON.stringify(report));
});

test("isolated maximum-input analysis reports separate peak resource gates", async () => {
  const measurements = await measureIsolatedMaximumInputAnalysis();
  assert.equal(measurements.length, 6);
  assert.equal(measurements.find((measurement) => measurement.name === "pcm_isolated_latency_p95")?.unit, "ms");
  assert.ok(measurements.every((measurement) => measurement.value >= 0));
  assert.ok(measurements.every((measurement) => measurement.passed), JSON.stringify(measurements));
});

test("an injected slow analyzer fails the latency gate", () => {
  const measurements = measureMaximumInputAnalysis((input) => {
    const started = Date.now();
    while (Date.now() - started < BENCHMARK_BUDGETS.analysisP95Milliseconds + 50) { /* intentional regression */ }
    return analyzePcm(input);
  });
  assert.equal(measurements.find((item) => item.name === "pcm_analysis_p95_latency")?.passed, false);
});

test("the analysis gate fails an injected allocation regression", () => {
  const retained: Float64Array[] = [];
  const measurements = measureMaximumInputAnalysis((input) => {
    const result = analyzePcm(input);
    // This models a regression that retains an unnecessary full-size working
    // buffer. The gate must measure the actual allocation rather than pass on
    // a static or latency-only result.
    const waste = new Float64Array(input.samples.length);
    const secondWaste = new Float64Array(input.samples.length);
    waste[0] = result.peak;
    retained.push(waste, secondWaste);
    return result;
  });
  assert.equal(measurements.find((item) => item.name === "pcm_analysis_array_buffer_delta")?.passed, false);
});
