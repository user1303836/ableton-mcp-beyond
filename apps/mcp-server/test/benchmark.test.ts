import assert from "node:assert/strict";
import { test } from "node:test";
import { BENCHMARK_BUDGETS, runBenchmarks } from "../src/benchmark.js";

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
  ]);
  assert.equal(report.measurements.find((measurement) => measurement.name === "ndjson_response_loss")?.budget, BENCHMARK_BUDGETS.responseLossPercent);
  assert.equal(report.measurements.find((measurement) => measurement.name === "restart_resume_latency")?.budget, BENCHMARK_BUDGETS.resumeMilliseconds);
  assert.equal(report.passed, true, JSON.stringify(report));
});
