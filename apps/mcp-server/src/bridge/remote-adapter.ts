import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { LiveAdapter, LiveEvent, LiveInvocation, LiveRef, LiveSnapshot, LiveStatus } from "../live.js";
import { LOOPBACK_PROTOCOL_VERSION, type LoopbackRequest, type LoopbackResponse } from "../loopback.js";

const MAX_FRAME_BYTES = 1_048_576;
const MAX_PENDING = 64;
const DEFAULT_TIMEOUT_MS = 5_000;
type Endpoint = { host: string; port: number; secret: string; timeoutMs?: number };
type Pending = { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; timer: NodeJS.Timeout };

function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error("wire payload is too deeply nested");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") { if (value.length > 16_384) throw new Error("wire string is too large"); return JSON.stringify(value); }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("wire number is not finite"); return JSON.stringify(Object.is(value, -0) ? 0 : value); }
  if (Array.isArray(value)) { if (value.length > 256) throw new Error("wire array is too large"); return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`; }
  if (typeof value === "object") { const object = value as Record<string, unknown>; const keys = Object.keys(object); if (keys.length > 256) throw new Error("wire object is too large"); return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(",")}}`; }
  throw new Error("unsupported wire value");
}
function mac(secret: string, value: unknown): string { const encoded = canonical(value); if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new Error("wire payload is too large"); return createHmac("sha256", secret).update(encoded).digest("base64url"); }
function validEndpoint(endpoint: Endpoint): void {
  const ipv4Loopback = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(endpoint.host) && endpoint.host.split(".").slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
  if (!(ipv4Loopback || endpoint.host === "localhost" || endpoint.host === "::1") || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 || endpoint.secret.length < 32) throw new Error("remote script endpoint must be loopback with a strong secret");
}

/** Async, authenticated TCP adapter. Live methods are intentionally exposed through requestAsync. */
export class RemoteScriptLiveAdapter implements LiveAdapter {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private epoch: number | null = null;
  private cached: LiveStatus = { connected: false, adapter: "unavailable", epoch: null, protocol: "ableton-live/v1", capabilities: [], reason: "not-connected" };
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private constructor(private readonly endpoint: Endpoint) { validEndpoint(endpoint); }

  static async connect(endpoint: Endpoint): Promise<RemoteScriptLiveAdapter> {
    const adapter = new RemoteScriptLiveAdapter(endpoint);
    await adapter.open();
    const result = await adapter.requestAsync({ method: "status" }) as LiveStatus;
    if (result.protocol !== "ableton-live/v1" || !result.connected || result.adapter !== "remote-script" || result.epoch === null || !Array.isArray(result.capabilities)) { await adapter.close(); throw new Error("remote script handshake or negotiation failed"); }
    adapter.epoch = result.epoch; adapter.cached = result; return adapter;
  }

  status(): LiveStatus { return this.cached; }
  snapshot(): never { throw new Error("remote adapter is asynchronous; use snapshotAsync"); }
  get(): never { throw new Error("remote adapter is asynchronous; use getAsync"); }
  set(): never { throw new Error("remote adapter is asynchronous; use setAsync"); }
  invoke(): never { throw new Error("remote adapter is asynchronous; use invokeAsync"); }
  subscribe(listener: (event: LiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  reconnect(): LiveStatus { throw new Error("remote adapter is asynchronous; use reconnectAsync"); }
  snapshotAsync(): Promise<LiveSnapshot> { return this.requestAsync({ method: "snapshot" }) as Promise<LiveSnapshot>; }
  getAsync(ref: LiveRef): Promise<unknown> { return this.requestAsync({ method: "get", ref }); }
  setAsync(ref: LiveRef, property: string, value: unknown): Promise<void> { return this.requestAsync({ method: "set", ref, property, value }).then(() => undefined); }
  invokeAsync(invocation: LiveInvocation): Promise<unknown> { return this.requestAsync({ method: "invoke", operation: invocation.operation, args: invocation.args }); }
  reconnectAsync(): Promise<LiveStatus> { return this.requestAsync({ method: "reconnect" }).then((value) => { const status = value as LiveStatus; if (status.epoch !== this.epoch) this.epoch = status.epoch; this.cached = status; return status; }); }
  async close(): Promise<void> { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("remote adapter disconnected")); } this.pending.clear(); this.socket?.destroy(); this.socket = undefined; this.cached = { ...this.cached, connected: false, reason: "closed" }; }

  private open(): Promise<void> { return new Promise((resolve, reject) => { const socket = createConnection({ host: this.endpoint.host, port: this.endpoint.port }); this.socket = socket; socket.setNoDelay(true); const timer = setTimeout(() => { socket.destroy(); reject(new Error("remote adapter connection timed out")); }, this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS); socket.on("connect", () => { clearTimeout(timer); resolve(); }); socket.on("data", (chunk) => this.onData(chunk)); socket.on("error", (error) => { clearTimeout(timer); if (!this.cached.connected) reject(error); this.failPending(error); }); socket.on("close", () => { clearTimeout(timer); this.failPending(new Error("remote adapter disconnected")); }); }); }
  private requestAsync(fields: Omit<LoopbackRequest, "version" | "id" | "nonce" | "sequence" | "mac">): Promise<unknown> { if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("remote adapter is disconnected")); if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("remote adapter queue is full")); const id = `async-${++this.sequence}`; const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id, ...fields, nonce: randomBytes(18).toString("base64url"), sequence: this.sequence }; const request = { ...unsigned, mac: mac(this.endpoint.secret, unsigned) }; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("remote adapter request timed out")); }, this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS); this.pending.set(id, { resolve, reject, timer }); this.socket?.write(`${JSON.stringify(request)}\n`); }); }
  private onData(chunk: Buffer): void { this.buffer = Buffer.concat([this.buffer, chunk]); if (this.buffer.length > MAX_FRAME_BYTES) { this.failPending(new Error("remote frame exceeds limit")); this.socket?.destroy(); return; } while (true) { const index = this.buffer.indexOf(10); if (index < 0) return; const frame = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1); if (frame.length === 0) continue; if (frame.length > MAX_FRAME_BYTES) { this.failPending(new Error("remote frame exceeds limit")); this.socket?.destroy(); return; } try { const response = JSON.parse(frame.toString("utf8")) as LoopbackResponse; this.onResponse(response); } catch { this.failPending(new Error("malformed remote response")); } } }
  private onResponse(response: LoopbackResponse): void { if (!response || typeof response.id !== "string" || typeof response.mac !== "string") throw new Error("invalid remote response"); const unsigned = { ...response } as Partial<LoopbackResponse>; delete unsigned.mac; const expected = Buffer.from(mac(this.endpoint.secret, unsigned)); const received = Buffer.from(response.mac); if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("remote response authentication failed"); if (response.result && typeof response.result === "object" && "event" in (response.result as Record<string, unknown>)) { const event = (response.result as { event: LiveEvent }).event; for (const listener of this.listeners) listener(event); return; } const pending = this.pending.get(response.id); if (!pending) return; this.pending.delete(response.id); clearTimeout(pending.timer); if (response.ok) pending.resolve(response.result); else pending.reject(new Error(response.error ?? "remote request failed")); }
  private failPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
}

export type { Endpoint as RemoteScriptEndpoint };
