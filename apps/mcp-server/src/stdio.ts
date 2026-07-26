import type { Readable, Writable } from "node:stream";
import { NdjsonFramer, type FrameEvent } from "./framing.js";

export type RecordHandler = (record: string) => string | null | Promise<string | null>;

/** Connects a bounded framer to streams and observes Writable backpressure. */
export async function serveStdio(input: Readable, output: Writable, handler: RecordHandler): Promise<void> {
  const framer = new NdjsonFramer();
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
    try { const result = await handler(event.value); if (result !== null) await write(result); }
    catch { await write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } })); }
  };
  for await (const chunk of input) {
    for (const event of framer.push(Buffer.from(chunk as Uint8Array))) await process(event);
  }
  for (const event of framer.end()) await process(event);
}
