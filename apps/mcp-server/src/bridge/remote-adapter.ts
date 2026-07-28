import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  LIVE_CAPABILITIES, LIVE_REGISTRY_HASH, LIVE_REGISTRY_OPERATIONS,
  type AsyncLiveAdapter, type LiveDiscoveryKind, type LiveDiscoveryRequest, type LiveDiscoveryResult,
  type LiveCapability, type LiveEvent, type LiveInvocation, type LiveOperationContext, type LiveRef, type LiveSnapshot, type LiveStatus,
} from "../live.js";
import { LOOPBACK_PROTOCOL_VERSION, type RemoteBridgeRequest, type LoopbackResponse } from "../loopback.js";
import { validateLiveOperationRequest, validateLiveOperationResult } from "../registry.js";

const MAX_FRAME_BYTES = 1_048_576;
const MAX_PENDING = 64;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const LIVE_PROTOCOL = "ableton-live/v1";
const ADAPTERS = new Set(["remote-script", "simulator", "extension", "unavailable"]);
const EVENT_TYPES = new Set(["state", "transport", "object", "meter", "max", "osc", "reset"]);
const READ_ONLY_INVOKES = new Set(["session.playback", "automation.envelope.read", "browser.search", "browser.inspect", "audio.capture.inspect", "audio.capture.status", "realtime.stats", "session.reconnect"]);
function mutationAuthorityRequired(operation: string): boolean { return !READ_ONLY_INVOKES.has(operation); }
const KIND_TO_WIRE: Readonly<Record<LiveDiscoveryKind, string>> = {
  set: "set", track: "track", "return-track": "return_track", "main-track": "main_track", scene: "scene",
  "clip-slot": "clip_slot", "session-clip": "session_clip", "arrangement-clip": "arrangement_clip", note: "note",
  locator: "locator", device: "device", parameter: "parameter", selection: "selection", "routing-choice": "routing_choice",
  "session-playback": "session_playback",
};
const WIRE_TO_KIND = new Map(Object.entries(KIND_TO_WIRE).map(([key, value]) => [value, key as LiveDiscoveryKind]));

type Endpoint = { host: string; port: number; secret: string; timeoutMs?: number };
type Pending = {
  operationId: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
};
type Hello = LoopbackResponse & { id: "hello"; result: { protocol: string; registryHash: string; maxDeadlineMs: number } };

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
  if (!(ipv4Loopback || endpoint.host === "::1") || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 || endpoint.secret.length < 32) throw new Error("remote script endpoint must be loopback with a strong secret");
}
function validStatus(value: unknown): value is LiveStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<LiveStatus>;
  const capabilities = status.capabilities;
  const operations = status.operations;
  if (typeof status.connected !== "boolean" || typeof status.adapter !== "string" || !ADAPTERS.has(status.adapter) ||
      !(status.epoch === null || (typeof status.epoch === "number" && Number.isSafeInteger(status.epoch) && status.epoch >= 1)) ||
      status.protocol !== LIVE_PROTOCOL || !Array.isArray(capabilities) || capabilities.length > 256 ||
      !capabilities.every((capability) => typeof capability === "string" && capability.length > 0 && capability.length <= 128) ||
      status.registryHash !== LIVE_REGISTRY_HASH || !Array.isArray(operations) || operations.length > 256) return false;
  if (new Set(capabilities).size !== capabilities.length || !capabilities.every((capability) => (LIVE_CAPABILITIES as readonly string[]).includes(capability))) return false;
  if (!operations.every((operation) => typeof operation === "string" && operation.length > 0 && operation.length <= 128) ||
      new Set(operations).size !== operations.length ||
      !operations.every((operation) => (LIVE_REGISTRY_OPERATIONS as readonly string[]).includes(operation)) ||
      !["status", "snapshot", "discover", "get", "reconnect", "session.playback"].every((operation) => operations.includes(operation))) return false;
  const all = (...required: string[]): boolean => required.every((operation) => operations.includes(operation));
  const any = (...required: string[]): boolean => required.some((operation) => operations.includes(operation));
  const readableHierarchy = all("snapshot", "discover", "get");
  const requirements: Record<(typeof LIVE_CAPABILITIES)[number], boolean> = {
    "session.read": readableHierarchy && all("session.playback"), "tracks": readableHierarchy, "scenes": readableHierarchy, "clips": readableHierarchy,
    "notes": readableHierarchy, "session.discovery": all("discover"),
    "session.structure": any("track.create", "track.delete", "scene.create", "scene.delete"),
    "session.midi_clip.create": all("clip.create"), "session.midi_clip.delete": all("clip.delete"),
    "session.midi_note.read": readableHierarchy, "session.midi_note.write": all("note.add"),
    "arrangement.read": any("locator.add", "arrangement.clip.delete"),
    "arrangement.write": any("locator.add", "locator.delete", "arrangement.clip.create", "arrangement.clip.delete"),
    "audio": all("audio.clip.set"), "audio.capture.resampling": all("audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.cleanup"),
    "warp": false, "takes": false, "automation": all("automation.envelope.read"),
    "devices": readableHierarchy, "racks": readableHierarchy, "chains": readableHierarchy, "parameters": readableHierarchy,
    "browser": all("browser.search"), "device.parameter.write": all("device.parameter.set"), "routing": all("routing.set"),
    "recording": any("recording.session", "recording.arrangement"), "projects": all("snapshot"), "mixing": all("mixer.set"),
    "transport": all("transport.set", "tempo.set"), "max": false,
    "osc": all("realtime.arm", "realtime.disarm", "realtime.stats"), "realtime.events": all("realtime.arm", "realtime.disarm", "realtime.stats"),
    "plugins": readableHierarchy, "subscriptions": all("subscribe"), "reconnect": all("reconnect"),
  };
  return capabilities.every((capability) => requirements[capability as LiveCapability] === true);
}
function verifySigned(secret: string, response: LoopbackResponse): void {
  const unsigned = { ...response } as Partial<LoopbackResponse>;
  delete unsigned.mac;
  const expected = Buffer.from(mac(secret, unsigned));
  const received = Buffer.from(response.mac);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("remote response authentication failed");
}
function registryRequest(operationId: string, fields: Omit<RemoteBridgeRequest, "version" | "id" | "nonce" | "sequence" | "bridgeEpoch" | "connectionChallenge" | "deadlineMs" | "mac">): unknown {
  if (operationId === "status" || operationId === "snapshot" || operationId === "reconnect" || operationId === "session.playback") return {};
  if (operationId === "discover") return fields.args ?? {};
  if (operationId === "get") return { ref: fields.ref };
  if (operationId === "authority.preflight") return { operation: fields.operation, argsDigest: createHash("sha256").update(canonical(fields.args ?? {})).digest("hex") };
  if (operationId === "authority.prepare") return { operation: fields.operation, argsDigest: createHash("sha256").update(canonical(fields.args ?? {})).digest("hex"), preflightToken: fields.preflightToken, confirmation: fields.confirmation, idempotencyKey: fields.idempotencyKey };
  return fields.args ?? {};
}

/** Async authenticated TCP adapter with registry validation and channel binding. */
export class RemoteScriptLiveAdapter implements AsyncLiveAdapter {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private epoch: number | null = null;
  private bridgeEpoch?: string;
  private connectionChallenge?: string;
  private helloResolve?: () => void;
  private helloReject?: (reason?: unknown) => void;
  private cached: LiveStatus = { connected: false, adapter: "unavailable", epoch: null, protocol: LIVE_PROTOCOL, capabilities: [], reason: "not-connected" };
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private lastEventEpoch: number | null = null;
  private lastEventSequence = 0;
  private constructor(private readonly endpoint: Endpoint) { validEndpoint(endpoint); }

  static async connect(endpoint: Endpoint): Promise<RemoteScriptLiveAdapter> {
    const adapter = new RemoteScriptLiveAdapter(endpoint);
    await adapter.open();
    const result = await adapter.requestAsync({ method: "status" }, "status");
    if (!validStatus(result) || !result.connected || result.adapter !== "remote-script" || result.epoch === null) { await adapter.close(); throw new Error("remote script handshake or negotiation failed"); }
    adapter.epoch = result.epoch; adapter.cached = result; return adapter;
  }

  status(): LiveStatus { return this.cached; }
  snapshot(): never { throw new Error("remote adapter is asynchronous; use snapshotAsync"); }
  get(): never { throw new Error("remote adapter is asynchronous; use getAsync"); }
  invoke(): never { throw new Error("remote adapter is asynchronous; use invokeAsync"); }
  subscribe(listener: (event: LiveEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  reconnect(): LiveStatus { throw new Error("remote adapter is asynchronous; use reconnectAsync"); }
  snapshotAsync(context?: LiveOperationContext): Promise<LiveSnapshot> { return this.requestAsync({ method: "snapshot" }, "snapshot", context) as Promise<LiveSnapshot>; }
  async discoverAsync(request: LiveDiscoveryRequest, context?: LiveOperationContext): Promise<LiveDiscoveryResult> {
    const wireKind = KIND_TO_WIRE[request.kind];
    if (!wireKind) throw new Error(`unsupported discovery kind: ${String(request.kind)}`);
    const args: Record<string, unknown> = { kind: wireKind };
    if (request.parent !== undefined) args.parent = request.parent;
    if (request.filter !== undefined) args.filters = request.filter;
    if (request.fields !== undefined) args.requestedFields = request.fields;
    if (request.budget !== undefined) args.traversalBudget = request.budget;
    if (request.limit !== undefined) args.limit = request.limit;
    if (request.cursor !== undefined) args.cursor = request.cursor;
    const operationId = request.kind === "session-playback" ? "session.playback" : "discover";
    const result = await this.requestAsync({ method: "discover", args }, operationId, context) as Record<string, unknown>;
    if (request.kind === "session-playback") return { epoch: result.epoch as number, items: [result], truncated: false, revision: result.revision as string, kind: request.kind };
    const translated = WIRE_TO_KIND.get(String(result.kind));
    if (!translated || translated !== request.kind) throw new Error("remote discovery returned an unexpected kind");
    return { ...(result as unknown as LiveDiscoveryResult), kind: translated };
  }
  getAsync(ref: LiveRef, context?: LiveOperationContext): Promise<unknown> { return this.requestAsync({ method: "get", ref }, "get", context); }
  async invokeAsync(invocation: LiveInvocation, context?: LiveOperationContext): Promise<unknown> {
    if (!this.cached.operations?.includes(invocation.operation)) throw new Error(`remote operation is not negotiated: ${invocation.operation}`);
    if (invocation.operation === "subscribe") return this.requestAsync({ method: "subscribe", args: invocation.args }, "subscribe", context);
    if (!mutationAuthorityRequired(invocation.operation)) return this.requestAsync({ method: "invoke", operation: invocation.operation, args: invocation.args }, invocation.operation, context);
    const argsDigest = createHash("sha256").update(canonical(invocation.args)).digest("hex");
    const baseIdempotencyKey = context?.idempotencyKey ?? randomBytes(18).toString("base64url");
    const transactionScope = context?.transactionId ?? randomBytes(18).toString("base64url");
    if (baseIdempotencyKey.length < 8 || baseIdempotencyKey.length > 128 || transactionScope.length < 8 || transactionScope.length > 128) throw new Error("remote mutation idempotency authority is invalid");
    const bridgeIdempotencyKey = createHash("sha256").update(`${transactionScope}\0${baseIdempotencyKey}\0${invocation.operation}\0${argsDigest}`).digest("base64url");
    const preflight = await this.requestAsync({ method: "preflight", operation: invocation.operation, args: invocation.args }, "authority.preflight", context) as { preflightToken?: unknown; confirmation?: unknown; operation?: unknown; argsDigest?: unknown; expiresAt?: unknown };
    if (typeof preflight.preflightToken !== "string" || typeof preflight.confirmation !== "string" || preflight.operation !== invocation.operation || typeof preflight.argsDigest !== "string" || typeof preflight.expiresAt !== "number" || preflight.expiresAt <= Date.now()) throw new Error("remote mutation authority preflight failed");
    const prepared = await this.requestAsync({ method: "prepare", operation: invocation.operation, args: invocation.args, preflightToken: preflight.preflightToken, confirmation: preflight.confirmation, idempotencyKey: bridgeIdempotencyKey }, "authority.prepare", context) as { authorityToken?: unknown; operation?: unknown; argsDigest?: unknown; expiresAt?: unknown };
    if (typeof prepared.authorityToken !== "string" || prepared.operation !== invocation.operation || prepared.argsDigest !== preflight.argsDigest || typeof prepared.expiresAt !== "number" || prepared.expiresAt <= Date.now()) throw new Error("remote mutation authority preparation failed");
    return this.requestAsync({ method: "invoke", operation: invocation.operation, args: invocation.args, authorityToken: prepared.authorityToken }, invocation.operation, context);
  }
  reconnectAsync(context?: LiveOperationContext): Promise<LiveStatus> { return this.requestAsync({ method: "reconnect" }, "reconnect", context).then((value) => { const status = value as LiveStatus; if (!validStatus(status)) throw new Error("invalid reconnect status"); this.epoch = status.epoch; this.cached = status; return status; }); }
  /** Re-request the mapper's current status without a reconnect; operations and
   * capabilities reflect the shape at call time (no epoch change). */
  refreshStatusAsync(context?: LiveOperationContext): Promise<LiveStatus> { return this.requestAsync({ method: "status" }, "status", context).then((value) => { const status = value as LiveStatus; if (!validStatus(status)) throw new Error("invalid refreshed status"); this.cached = status; return status; }); }
  async close(): Promise<void> { this.failPending(new Error("remote adapter disconnected")); this.helloReject?.(new Error("remote adapter disconnected")); this.helloResolve = undefined; this.helloReject = undefined; this.socket?.destroy(); this.socket = undefined; this.cached = { ...this.cached, connected: false, reason: "closed" }; }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.endpoint.host, port: this.endpoint.port });
      this.socket = socket; socket.setNoDelay(true); this.helloResolve = resolve; this.helloReject = reject;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("remote adapter connection timed out")); }, this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("error", (error) => { clearTimeout(timer); if (!this.bridgeEpoch) reject(error); this.failPending(error); });
      socket.on("close", () => { clearTimeout(timer); if (!this.bridgeEpoch) reject(new Error("remote adapter disconnected")); this.failPending(new Error("remote adapter disconnected")); });
      const originalResolve = this.helloResolve;
      this.helloResolve = () => { clearTimeout(timer); originalResolve?.(); };
    });
  }

  private requestAsync(fields: Omit<RemoteBridgeRequest, "version" | "id" | "nonce" | "sequence" | "bridgeEpoch" | "connectionChallenge" | "deadlineMs" | "mac">, operationId: string, context?: LiveOperationContext): Promise<unknown> {
    if (!this.socket || this.socket.destroyed || !this.bridgeEpoch || !this.connectionChallenge) return Promise.reject(new Error("remote adapter is disconnected"));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("remote adapter queue is full"));
    if (this.sequence >= MAX_SEQUENCE) return Promise.reject(new Error("remote adapter sequence exhausted"));
    if (context?.signal?.aborted) return Promise.reject(new Error("remote adapter request cancelled before dispatch"));
    const timeoutMs = this.endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadlineMs = context?.deadlineMs ?? Date.now() + timeoutMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || deadlineMs > Date.now() + 60_000) return Promise.reject(new Error("remote adapter deadline is invalid or expired"));
    validateLiveOperationRequest(operationId, registryRequest(operationId, fields));
    const id = `async-${++this.sequence}`;
    const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id, ...fields, nonce: randomBytes(18).toString("base64url"), sequence: this.sequence, bridgeEpoch: this.bridgeEpoch, connectionChallenge: this.connectionChallenge, deadlineMs };
    const request = { ...unsigned, mac: mac(this.endpoint.secret, unsigned) };
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()));
      const timer = setTimeout(() => { this.socket?.destroy(); this.failPending(new Error("remote adapter request state uncertain after dispatch timeout")); }, remaining);
      const pending: Pending = { operationId, resolve, reject, timer };
      if (context?.signal) {
        const abort = () => { this.socket?.destroy(); this.failPending(new Error("remote adapter request state uncertain after dispatch cancellation")); };
        context.signal.addEventListener("abort", abort, { once: true });
        pending.abortCleanup = () => context.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      try { this.socket?.write(`${JSON.stringify(request)}\n`); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); pending.abortCleanup?.(); reject(error); this.socket?.destroy(); }
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) { this.failPending(new Error("remote frame exceeds limit")); this.socket?.destroy(); return; }
    while (true) {
      const index = this.buffer.indexOf(10); if (index < 0) return;
      const frame = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1); if (frame.length === 0) continue;
      if (frame.length > MAX_FRAME_BYTES) { this.failPending(new Error("remote frame exceeds limit")); this.socket?.destroy(); return; }
      try { this.onResponse(JSON.parse(frame.toString("utf8")) as LoopbackResponse); }
      catch (error) { this.failPending(error instanceof Error ? error : new Error("malformed remote response")); this.helloReject?.(error); this.socket?.destroy(); return; }
    }
  }

  private onResponse(response: LoopbackResponse): void {
    if (!response || response.version !== LOOPBACK_PROTOCOL_VERSION || typeof response.id !== "string" || typeof response.mac !== "string" || typeof response.bridgeEpoch !== "string" || typeof response.connectionChallenge !== "string") throw new Error("invalid remote response");
    verifySigned(this.endpoint.secret, response);
    if (response.id === "hello") {
      if (this.bridgeEpoch || !response.ok || !response.result || typeof response.result !== "object") throw new Error("invalid or duplicate remote hello");
      const hello = response as Hello;
      if (hello.result.protocol !== LIVE_PROTOCOL || hello.result.registryHash !== LIVE_REGISTRY_HASH || !Number.isSafeInteger(hello.result.maxDeadlineMs) || hello.result.maxDeadlineMs < 100 || hello.bridgeEpoch.length < 16 || hello.connectionChallenge.length < 16) throw new Error("remote hello negotiation failed");
      this.bridgeEpoch = hello.bridgeEpoch; this.connectionChallenge = hello.connectionChallenge; this.helloResolve?.(); this.helloResolve = undefined; this.helloReject = undefined; return;
    }
    if (response.bridgeEpoch !== this.bridgeEpoch || response.connectionChallenge !== this.connectionChallenge) throw new Error("remote response channel binding failed");
    if (response.result && typeof response.result === "object" && "event" in (response.result as Record<string, unknown>)) {
      const event = (response.result as { event?: unknown }).event;
      if (!event || typeof event !== "object" || !Number.isSafeInteger((event as { epoch?: unknown }).epoch) || (event as { epoch: number }).epoch <= 0 || !Number.isSafeInteger((event as { sequence?: unknown }).sequence) || (event as { sequence: number }).sequence <= 0 || typeof (event as { type?: unknown }).type !== "string" || !EVENT_TYPES.has((event as { type: string }).type)) throw new Error("invalid remote event");
      const liveEvent = event as LiveEvent;
      if (liveEvent.epoch !== this.epoch) throw new Error("remote event epoch does not match the current connection");
      if (this.lastEventEpoch !== liveEvent.epoch) { this.lastEventEpoch = liveEvent.epoch; this.lastEventSequence = 0; }
      if (liveEvent.sequence <= this.lastEventSequence || (liveEvent.type !== "reset" && liveEvent.sequence !== this.lastEventSequence + 1)) throw new Error("remote event sequence gap or replay requires reset");
      this.lastEventSequence = liveEvent.sequence;
      for (const listener of this.listeners) listener(event as LiveEvent); return;
    }
    const pending = this.pending.get(response.id); if (!pending) throw new Error("unknown or duplicate remote response");
    this.pending.delete(response.id); clearTimeout(pending.timer); pending.abortCleanup?.();
    if (response.ok) { try { validateLiveOperationResult(pending.operationId, response.result); if (pending.operationId === "reconnect" && validStatus(response.result)) { this.epoch = response.result.epoch; this.lastEventEpoch = this.epoch; this.lastEventSequence = 0; } pending.resolve(response.result); } catch (error) { this.cached = { ...this.cached, connected: false, reason: "registry-result-validation-failed" }; pending.reject(error); this.socket?.destroy(); } }
    else pending.reject(new Error(response.error ?? "remote request failed"));
  }

  private failPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.abortCleanup?.(); pending.reject(error); } this.pending.clear(); }
}

export type { Endpoint as RemoteScriptEndpoint };
