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
  const framer = new NdjsonFramer();
  const controllers = new Map<string, AbortController>();
  const pending = new Map<number, Promise<string | null>>();
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
  const write = async (value: string): Promise<void> => {
    if (output.destroyed) throw new Error("output unavailable");
    if (!output.write(`${value}\n`)) await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve(); };
      const onError = (cause: Error): void => { cleanup(); reject(cause); };
      const onClose = (): void => { cleanup(); reject(new Error("output closed")); };
      const cleanup = (): void => { output.off("drain", onDrain); output.off("error", onError); output.off("close", onClose); };
      output.once("drain", onDrain); output.once("error", onError); output.once("close", onClose);
    });
  };
  const process = async (event: FrameEvent): Promise<void> => {
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
    const key = requestKey(id)!;
    const controller = new AbortController();
    controllers.set(key, controller);
    const sequence = nextSequence++;
    const task = (async (): Promise<string | null> => {
      await acquire();
      try {
        if (controller.signal.aborted) return null;
        const result = await (handler.length >= 2 ? (handler as (record: string, context: RecordContext) => string | null | Promise<string | null>)(event.value, { requestId: id, signal: controller.signal }) : handler(event.value));
        return controller.signal.aborted ? null : result;
      } finally {
        release();
        controllers.delete(key);
      }
    })();
    pending.set(sequence, task);
    const flush = async (): Promise<void> => {
      while (pending.has(nextWrite)) {
        const current = pending.get(nextWrite)!;
        let result: string | null;
        try { result = await current; }
        catch { result = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } }); }
        pending.delete(nextWrite++);
        if (!closed && result !== null) await write(result);
      }
    };
    if (!flushPromise) flushPromise = flush().finally(() => { flushPromise = undefined; });
    void flushPromise;
  };
  try {
    for await (const chunk of input) {
      for (const event of framer.push(Buffer.from(chunk as Uint8Array))) await process(event);
    }
    for (const event of framer.end()) await process(event);
    await Promise.all(pending.values());
    if (flushPromise) await flushPromise;
  } finally {
    closed = true;
    for (const controller of controllers.values()) controller.abort(new Error("stdio shutting down"));
    controllers.clear();
    pending.clear();
    waiters.splice(0).forEach((resolve) => resolve());
  }
}
