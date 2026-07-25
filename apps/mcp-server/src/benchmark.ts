import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { analyzePcm } from "./analysis.js";
import { McpHost, PROTOCOL_VERSION, serve } from "./host.js";

export interface BenchmarkMeasurement {
  name: string;
  value: number;
  unit: string;
  budget: number;
  passed: boolean;
}

export interface BenchmarkReport {
  measurements: BenchmarkMeasurement[];
  passed: boolean;
}

const PING_SAMPLES = 256;
const BATCH_SIZE = 128;
const ANALYSIS_SAMPLES = 96_000;

/**
 * The gates are deliberately loose enough for a loaded local development
 * machine, while still detecting accidental synchronous I/O or quadratic
 * behavior in the request path. They are validated by the accompanying test.
 */
export const BENCHMARK_BUDGETS = {
  pingP95Milliseconds: 5,
  pingRequestsPerSecond: 5_000,
  batchP95Milliseconds: 100,
  responseLossPercent: 0,
  cancellationP95Milliseconds: 5,
  recoveryMilliseconds: 100,
  analysisP95Milliseconds: 250,
  resumeMilliseconds: 100,
} as const;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "benchmark", version: "1" },
  },
} as const;

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("cannot calculate a percentile from no measurements");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function measure(name: string, value: number, unit: string, budget: number, direction: "maximum" | "minimum" = "maximum"): BenchmarkMeasurement {
  return { name, value, unit, budget, passed: direction === "maximum" ? value <= budget : value >= budget };
}

function pingRequest(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "ping" };
}

function audioFixture(): Float32Array {
  const result = new Float32Array(ANALYSIS_SAMPLES);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = 0.5 * Math.sin((2 * Math.PI * 440 * index) / 48_000);
  }
  return result;
}

async function runWirePayload(payload: string): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const responseChunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => responseChunks.push(chunk));
  const done = serve(input, output, new PassThrough());
  input.end(payload);
  await done;
  const text = Buffer.concat(responseChunks).toString("utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runWire(records: readonly Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return runWirePayload(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function responseIds(records: readonly Record<string, unknown>[]): Set<number> {
  return new Set(records.map((record) => record.id).filter((id): id is number => typeof id === "number"));
}

export async function runBenchmarks(): Promise<BenchmarkReport> {
  const measurements: BenchmarkMeasurement[] = [];
  const host = new McpHost();
  host.handle(INITIALIZE);
  for (let id = 2; id < 34; id += 1) host.handle(pingRequest(id));

  const pingTimes: number[] = [];
  for (let id = 34; id < 34 + PING_SAMPLES; id += 1) {
    const started = performance.now();
    const result = host.handle(pingRequest(id));
    pingTimes.push(performance.now() - started);
    if (result === null || (result as { result?: unknown }).result === undefined) throw new Error("ping did not produce a result");
  }
  measurements.push(measure("rpc_ping_p95_latency", percentile(pingTimes, 0.95), "ms", BENCHMARK_BUDGETS.pingP95Milliseconds));
  const throughputStarted = performance.now();
  for (let id = 1_000; id < 1_000 + PING_SAMPLES; id += 1) host.handle(pingRequest(id));
  const throughputElapsed = performance.now() - throughputStarted;
  measurements.push(measure("rpc_ping_throughput", (PING_SAMPLES * 1_000) / Math.max(throughputElapsed, Number.EPSILON), "requests/s", BENCHMARK_BUDGETS.pingRequestsPerSecond, "minimum"));

  const batchRequests = Array.from({ length: BATCH_SIZE }, (_, index) => pingRequest(index + 10_000));
  const batchTimes: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const started = performance.now();
    const records = await runWire([INITIALIZE, ...batchRequests.map((request, index) => ({ ...request, id: (request.id as number) + sample * BATCH_SIZE + 1 }))]);
    batchTimes.push(performance.now() - started);
    const expected = new Set<number>([1, ...batchRequests.map((request, index) => (request.id as number) + sample * BATCH_SIZE + 1)]);
    const received = responseIds(records);
    if (received.size !== expected.size || [...expected].some((id) => !received.has(id))) throw new Error("batch response loss");
  }
  measurements.push(measure("ndjson_batch_p95_latency", percentile(batchTimes, 0.95), "ms", BENCHMARK_BUDGETS.batchP95Milliseconds));
  measurements.push(measure("ndjson_response_loss", 0, "percent", BENCHMARK_BUDGETS.responseLossPercent));

  const cancellationHost = new McpHost();
  cancellationHost.handle(INITIALIZE);
  const cancellationTimes: number[] = [];
  for (let index = 0; index < PING_SAMPLES; index += 1) {
    const started = performance.now();
    const result = cancellationHost.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: index + 1 } });
    cancellationTimes.push(performance.now() - started);
    if (result !== null) throw new Error("cancellation notification produced a response");
  }
  measurements.push(measure("cancellation_p95_latency", percentile(cancellationTimes, 0.95), "ms", BENCHMARK_BUDGETS.cancellationP95Milliseconds));

  const recoveryStarted = performance.now();
  const recovered = await runWirePayload(`not-json\n${JSON.stringify(INITIALIZE)}\n${JSON.stringify(pingRequest(2))}\n`);
  const recoveryElapsed = performance.now() - recoveryStarted;
  if (recovered.length !== 3 || (recovered[0] as { error?: { code?: number } }).error?.code !== -32700 || !responseIds(recovered).has(2)) {
    throw new Error("malformed-stream recovery did not preserve the following request");
  }
  measurements.push(measure("malformed_stream_recovery_latency", recoveryElapsed, "ms", BENCHMARK_BUDGETS.recoveryMilliseconds));

  const samples = audioFixture();
  analyzePcm({ samples, sampleRate: 48_000 });
  const analysisTimes: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const result = analyzePcm({ samples, sampleRate: 48_000 });
    analysisTimes.push(performance.now() - started);
    if (result.sampleCount !== ANALYSIS_SAMPLES || result.safety.projectMutated) throw new Error("analysis result was incomplete or unsafe");
  }
  measurements.push(measure("pcm_analysis_p95_latency", percentile(analysisTimes, 0.95), "ms", BENCHMARK_BUDGETS.analysisP95Milliseconds));

  const resumeStarted = performance.now();
  const resumed = await runWire([INITIALIZE, pingRequest(2)]);
  const resumeElapsed = performance.now() - resumeStarted;
  if (resumed.length !== 2 || !responseIds(resumed).has(1) || !responseIds(resumed).has(2)) throw new Error("restart-and-resume handshake failed");
  measurements.push(measure("restart_resume_latency", resumeElapsed, "ms", BENCHMARK_BUDGETS.resumeMilliseconds));

  return { measurements, passed: measurements.every((item) => item.passed) };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const report = await runBenchmarks();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}
