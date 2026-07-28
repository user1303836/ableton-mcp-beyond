import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ConventionalChannelLabel } from "./audio-standards.js";

export const MAX_CONCURRENT_ANALYSIS_JOBS = 2;
export const MAX_QUEUED_ANALYSIS_JOBS = 4;
export const MAX_ANALYSIS_JOB_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ANALYSIS_JOB_STDERR_BYTES = 16 * 1024;
export const MAX_ANALYSIS_JOB_REQUEST_BYTES = 64 * 1024 * 1024;
export const ANALYSIS_JOB_TIMEOUT_MS = 30_000;

export interface EncodedAnalysisSource {
  pcmBase64: string;
  sampleRate: number;
  channels?: number;
  channelLayout?: ConventionalChannelLabel[];
  frameSize?: number;
}

export type AnalysisJob =
  | { mode: "analyze"; source: EncodedAnalysisSource }
  | { mode: "compare"; project: EncodedAnalysisSource; reference: EncodedAnalysisSource; alignment?: { mode?: "auto" | "manual" | "disabled"; maxLagSeconds?: number; manualOffsetSeconds?: number } };

interface QueueItem {
  resolve: () => void;
  reject: (cause: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class AnalysisRunner {
  private active = 0;
  private readonly queue: QueueItem[] = [];

  public status(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
    return { active: this.active, queued: this.queue.length, maxConcurrent: MAX_CONCURRENT_ANALYSIS_JOBS, maxQueued: MAX_QUEUED_ANALYSIS_JOBS };
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("analysis job cancelled before queueing"));
    if (this.active < MAX_CONCURRENT_ANALYSIS_JOBS) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= MAX_QUEUED_ANALYSIS_JOBS) return Promise.reject(new Error("analysis job queue is full"));
    return new Promise<void>((resolve, reject) => {
      const item: QueueItem = { resolve: () => { this.active += 1; resolve(); }, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        item.abort = () => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error("analysis job cancelled while queued"));
        };
        signal.addEventListener("abort", item.abort, { once: true });
      }
      this.queue.push(item);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        next.reject(new Error("analysis job cancelled while queued"));
        continue;
      }
      if (next.signal && next.abort) next.signal.removeEventListener("abort", next.abort);
      next.resolve();
      break;
    }
  }

  public async run(job: AnalysisJob, signal?: AbortSignal, timeoutMs = ANALYSIS_JOB_TIMEOUT_MS): Promise<unknown> {
    await this.acquire(signal);
    try {
      return await this.spawn(job, signal, timeoutMs);
    } finally {
      this.release();
    }
  }

  private spawn(job: AnalysisJob, signal?: AbortSignal, timeoutMs = ANALYSIS_JOB_TIMEOUT_MS): Promise<unknown> {
    const worker = fileURLToPath(new URL("./analysis-job-worker.js", import.meta.url));
    const payload = JSON.stringify(job);
    if (Buffer.byteLength(payload) > MAX_ANALYSIS_JOB_REQUEST_BYTES) return Promise.reject(new Error("analysis job request exceeds the worker input limit"));
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let closed = false;
      let requested: { cause?: Error; value?: unknown } | undefined;
      let outputBytes = 0;
      let stderrBytes = 0;
      const output: Buffer[] = [];
      let child: ChildProcessWithoutNullStreams;
      try {
        const environment: NodeJS.ProcessEnv = { ABLETON_MCP_ANALYSIS_WORKER: "1" };
        // Windows process creation and temporary-directory resolution can need
        // these platform variables; application secrets are deliberately not
        // inherited by the disposable DSP worker.
        for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"] as const) if (process.env[name] !== undefined) environment[name] = process.env[name];
        child = spawn(process.execPath, ["--max-old-space-size=512", worker], { stdio: ["pipe", "pipe", "pipe"], env: environment });
      } catch (cause) {
        reject(cause);
        return;
      }
      const settle = (outcome: { cause?: Error; value?: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abort);
        outcome.cause ? reject(outcome.cause) : resolve(outcome.value);
      };
      const finishAfterClose = (cause?: Error, value?: unknown): void => {
        if (settled || requested) return;
        requested = { ...(cause ? { cause } : {}), ...(value !== undefined ? { value } : {}) };
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abort);
        if (!closed && child.exitCode === null && !child.killed) child.kill("SIGKILL");
        // Keep the concurrency slot occupied until the process is confirmed
        // closed. A spawn failure has no resident process to account for.
        if (closed || child.exitCode !== null || child.pid === undefined) settle(requested);
      };
      const abort = (): void => finishAfterClose(new Error("analysis job cancelled"));
      const timer = setTimeout(() => finishAfterClose(new Error(`analysis job exceeded ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_ANALYSIS_JOB_OUTPUT_BYTES) {
          finishAfterClose(new Error("analysis worker output exceeded its bound"));
          return;
        }
        output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_ANALYSIS_JOB_STDERR_BYTES) finishAfterClose(new Error("analysis worker diagnostics exceeded its bound"));
      });
      child.on("error", (cause) => finishAfterClose(cause));
      child.on("close", () => {
        closed = true;
        if (requested) {
          settle(requested);
          return;
        }
        try {
          const envelope = JSON.parse(Buffer.concat(output).toString("utf8")) as { ok?: unknown; result?: unknown; error?: unknown };
          if (envelope.ok !== true) settle({ cause: new Error(typeof envelope.error === "string" ? envelope.error : "analysis worker failed") });
          else settle({ value: envelope.result });
        } catch {
          settle({ cause: new Error("analysis worker returned invalid bounded JSON") });
        }
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.on("error", (cause) => finishAfterClose(cause));
      child.stdin.end(payload);
    });
  }
}
