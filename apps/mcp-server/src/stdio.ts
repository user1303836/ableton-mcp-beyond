import type { Readable, Writable } from "node:stream";
import { NdjsonFramer, type FrameEvent } from "./framing.js";

export type RecordHandler = (record: string, context?: RecordContext) => string | null | Promise<string | null>;

export interface RecordContext {
  readonly requestId: string | number;
  readonly signal: AbortSignal;
}

export interface StdioOptions {
  /** Maximum number of handler calls that may be active at once. */
  readonly maxInFlight?: number;
  /** Register a server-initiated emitter (used for event notifications). */
  readonly notifier?: (emit: (value: string) => Promise<void>) => void;
}

type JsonRecord = { method?: unknown; id?: unknown; params?: unknown };

function requestKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return `string:${value}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `number:${value}`;
  return undefined;
}

function cancellationTarget(record: string): string | undefined {
  try {
    const value = JSON.parse(record) as JsonRecord;
    if (value.method !== "notifications/cancelled" || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) return undefined;
    return requestKey((value.params as Record<string, unknown>).requestId);
  } catch {
    return undefined;
  }
}

function requestId(record: string): string | number | undefined {
  try {
    const value = JSON.parse(record) as JsonRecord;
    return requestKey(value.id) === undefined ? undefined : value.id as string | number;
  } catch {
    return undefined;
  }
}

/** Connects a bounded framer to streams and observes Writable backpressure. */
export async function serveStdio(input: Readable, output: Writable, handler: RecordHandler, options: StdioOptions = {}): Promise<void> {
  const maxInFlight = options.maxInFlight ?? 16;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) throw new RangeError("maxInFlight must be an integer from 1 to 64");
  const maxPending = maxInFlight * 4;
  const maxQueuedWrites = maxPending * 4;
  const framer = new NdjsonFramer();
  const controllers = new Map<string, AbortController>();
  const pending = new Map<number, { id: string | number; task: Promise<string | null> }>();
  let nextSequence = 0;
  let nextWrite = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  let closed = false;
  let flushPromise: Promise<void> | undefined;

  const acquire = async (): Promise<void> => {
    if (active < maxInFlight) { active += 1; return; }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };
  const writeRaw = async (value: string): Promise<void> => {
    if (output.destroyed) throw new Error("output unavailable");
    await new Promise<void>((resolve, reject) => {
      let callbackComplete = false;
      let drainComplete = false;
      let writeReturned = false;
      let settled = false;
      const cleanup = (): void => { output.off("drain", onDrain); output.off("error", onError); output.off("close", onClose); };
      const fail = (cause: Error): void => { if (settled) return; settled = true; cleanup(); reject(cause); };
      const finish = (): void => { if (!settled && writeReturned && callbackComplete && drainComplete) { settled = true; cleanup(); resolve(); } };
      const onDrain = (): void => { drainComplete = true; finish(); };
      const onError = (cause: Error): void => fail(cause);
      const onClose = (): void => fail(new Error("output closed"));
      output.once("error", onError); output.once("close", onClose);
      try {
        const accepted = output.write(`${value}\n`, (cause?: Error | null) => { if (cause) return; callbackComplete = true; finish(); });
        writeReturned = true;
        drainComplete = accepted;
        if (!accepted) output.once("drain", onDrain);
        finish();
      } catch (cause) { fail(cause instanceof Error ? cause : new Error("output write failed")); }
    });
  };
  let queuedWrites = 0;
  let writeTail: Promise<void> = Promise.resolve();
  const write = (value: string): Promise<void> => {
    if (queuedWrites >= maxQueuedWrites) throw new Error("bounded output queue is saturated");
    queuedWrites += 1;
    const result = writeTail.then(() => writeRaw(value)).finally(() => { queuedWrites -= 1; });
    writeTail = result.catch(() => undefined);
    return result;
  };
  const failOutput = (cause: unknown): void => {
    if (closed) return;
    closed = true;
    const reason = cause instanceof Error ? cause : new Error("output unavailable");
    for (const controller of controllers.values()) controller.abort(reason);
    if (!input.destroyed) input.destroy();
    if (!output.destroyed) output.destroy();
  };
  const notify = async (value: string): Promise<void> => {
    try { await write(value); }
    catch (cause) { failOutput(cause); throw cause; }
  };
  options.notifier?.(notify);
  const process = async (event: FrameEvent): Promise<void> => {
    if (closed) return;
    if (event.type === "error") {
      const oversized = event.message === "oversized";
      await write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: oversized ? -32600 : -32700, message: oversized ? "Message exceeds size limit" : "Parse error" } }));
      return;
    }
    const target = cancellationTarget(event.value);
    if (target !== undefined) {
      controllers.get(target)?.abort(new Error("request cancelled"));
      return;
    }
    const id = requestId(event.value);
    if (id === undefined) {
      try { const result = await handler(event.value); if (result !== null) await write(result); }
      catch { await write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } })); }
      return;
    }
    if (pending.size >= maxPending) {
      // Never stop reading the control stream behind saturated work: doing so
      // would strand cancellation notifications behind the request they must
      // abort. Refuse excess work immediately and keep the bounded control
      // plane responsive.
      // Queue the bounded busy response without blocking input consumption, so
      // a following cancellation can still abort its matching in-flight work
      // even while stdout is backpressured.
      try {
        void write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Server is busy; retry after in-flight work completes" } })).catch(failOutput);
      } catch (cause) {
        // A peer that supplies more response-producing requests than the
        // bounded output queue can hold loses the connection's work
        // authority immediately; no mutation may remain stranded behind it.
        failOutput(cause);
      }
      return;
    }
    const key = requestKey(id)!;
    const sequence = nextSequence++;
    if (controllers.has(key)) {
      pending.set(sequence, { id, task: Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "Duplicate in-flight request identifier" } })) });
    } else {
      const controller = new AbortController();
      controllers.set(key, controller);
      const task = (async (): Promise<string | null> => {
        await acquire();
        try {
          if (controller.signal.aborted) return null;
          const result = await (handler.length >= 2 ? (handler as (record: string, context: RecordContext) => string | null | Promise<string | null>)(event.value, { requestId: id, signal: controller.signal }) : handler(event.value));
          return controller.signal.aborted ? null : result;
        } catch {
          return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
        } finally {
          release();
          if (controllers.get(key) === controller) controllers.delete(key);
        }
      })();
      pending.set(sequence, { id, task });
    }
    const flush = async (): Promise<void> => {
      while (pending.has(nextWrite)) {
        const current = pending.get(nextWrite)!;
        const result = await current.task;
        pending.delete(nextWrite++);
        if (!closed && result !== null) await write(result);
      }
    };
    const scheduleFlush = (): void => {
      if (flushPromise) return;
      flushPromise = flush().finally(() => {
        flushPromise = undefined;
        if (!closed && pending.has(nextWrite)) scheduleFlush();
      });
      void flushPromise.catch(failOutput);
    };
    scheduleFlush();
  };
  try {
    for await (const chunk of input) {
      for (const event of framer.push(Buffer.from(chunk as Uint8Array))) await process(event);
    }
    for (const event of framer.end()) await process(event);
    await Promise.all([...pending.values()].map((entry) => entry.task));
    if (flushPromise) await flushPromise;
    await writeTail;
  } finally {
    closed = true;
    for (const controller of controllers.values()) controller.abort(new Error("stdio shutting down"));
    controllers.clear();
    pending.clear();
    waiters.splice(0).forEach((resolve) => resolve());
  }
}
