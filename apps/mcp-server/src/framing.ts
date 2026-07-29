import { TextDecoder } from "node:util";

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type FrameEvent =
  | { type: "record"; value: string }
  | { type: "error"; message: "invalid-utf8" | "oversized" };

/** Incremental JSON-lines framing. Retains at most one bounded record. */
export class NdjsonFramer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private chunks: Uint8Array[] = [];
  private retained = 0;
  private discarding = false;

  public push(chunk: Uint8Array): FrameEvent[] {
    const events: FrameEvent[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      start = index + 1;
      if (this.discarding) {
        this.discarding = false;
        this.clear();
        events.push({ type: "error", message: "oversized" });
        continue;
      }
      const recordPart = part.length > 0 && part[part.length - 1] === 13 ? part.subarray(0, part.length - 1) : part;
      if (!this.append(recordPart)) {
        this.discarding = false;
        this.clear();
        events.push({ type: "error", message: "oversized" });
      } else {
        events.push(this.emitRecord());
      }
    }
    if (start < chunk.length && !this.discarding) this.append(chunk.subarray(start));
    return events;
  }

  public end(): FrameEvent[] {
    if (this.discarding) { this.discarding = false; this.clear(); return [{ type: "error", message: "oversized" }]; }
    if (this.retained === 0) return [];
    return [this.emitRecord()];
  }

  public get retainedBytes(): number { return this.retained; }

  private append(part: Uint8Array): boolean {
    if (part.length === 0) return true;
    if (this.retained + part.length > MAX_FRAME_BYTES) {
      this.clear();
      this.discarding = true;
      return false;
    }
    this.chunks.push(part.slice());
    this.retained += part.length;
    return true;
  }

  private emitRecord(): FrameEvent {
    const bytes = new Uint8Array(this.retained);
    let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    this.clear();
    try { return { type: "record", value: this.decoder.decode(bytes) }; }
    catch { return { type: "error", message: "invalid-utf8" }; }
  }

  private clear(): void { this.chunks = []; this.retained = 0; }
}
