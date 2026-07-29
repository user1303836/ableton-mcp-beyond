import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { LiveAdapter, LiveEvent, LiveInvocation, LiveRef, LiveSnapshot, LiveStatus } from "./live.js";
import { validateLiveOperationRequest, validateLiveOperationResult } from "./registry.js";

export const LOOPBACK_PROTOCOL_VERSION = "ableton-loopback/v1";
const MAX_NONCE_LENGTH = 256;
const MAX_WIRE_BYTES = 1_048_576;
const MAX_WIRE_DEPTH = 16;
const MAX_WIRE_STRING_LENGTH = 16_384;
const MAX_WIRE_ARRAY_LENGTH = 512;
const MAX_WIRE_OBJECT_PROPERTIES = 256;
type WireRequestBase = { version: string; id: string; ref?: LiveRef; operation?: LiveInvocation["operation"]; args?: Record<string, unknown>; nonce: string; sequence: number; bridgeEpoch: string; connectionChallenge: string; deadlineMs: number; mac: string };
export type LoopbackRequest = WireRequestBase & { method: "status" | "snapshot" | "discover" | "get" | "invoke" | "subscribe" | "reconnect" };
export type RemoteBridgeRequest = WireRequestBase & { method: "status" | "snapshot" | "discover" | "get" | "preflight" | "prepare" | "invoke" | "subscribe" | "reconnect" | "retire"; preflightToken?: string; confirmation?: string; idempotencyKey?: string; authorityToken?: string; transactionId?: string; ownershipToken?: string; terminal?: boolean };
export type LoopbackResponse = { version: string; id: string; ok: boolean; bridgeEpoch: string; connectionChallenge: string; result?: unknown; error?: string; mac: string };
export type LoopbackExchange = (request: LoopbackRequest) => LoopbackResponse;

function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_WIRE_DEPTH) throw new TypeError("wire payload is too deeply nested");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (value.length > MAX_WIRE_STRING_LENGTH) throw new TypeError("wire string is too large");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("wire number is not finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_WIRE_ARRAY_LENGTH) throw new TypeError("wire array is too large");
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_WIRE_OBJECT_PROPERTIES) throw new TypeError("wire object is too large");
    return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new TypeError("unsupported wire value");
}
function boundedCanonical(value: unknown): string {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_WIRE_BYTES) throw new TypeError("wire payload is too large");
  return encoded;
}
function body(request: Omit<LoopbackRequest, "mac">): string { return boundedCanonical(request); }
function sign(secret: string, value: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Authenticated, bounded loopback transport used by Remote Script/Extension adapters. */
export class AuthenticatedLoopback {
  private lastSequence = 0;
  private readonly bridgeEpoch = "in-process";
  private readonly connectionChallenge = "in-process";
  private authSequence = 0;
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly adapter: LiveAdapter, private readonly secret: string, private readonly emit: (response: LoopbackResponse) => void = () => undefined) {
    if (secret.length < 32) throw new Error("loopback secret must contain at least 32 characters");
  }
  handle(request: unknown): LoopbackResponse {
    if (!this.isRequest(request)) return this.response("invalid", false, "invalid request");
    const unsigned = { ...request } as Omit<LoopbackRequest, "mac">;
    delete (unsigned as Partial<LoopbackRequest>).mac;
    let authenticated = false;
    try { authenticated = request.version === LOOPBACK_PROTOCOL_VERSION && request.bridgeEpoch === this.bridgeEpoch && request.connectionChallenge === this.connectionChallenge && Number.isSafeInteger(request.deadlineMs) && request.deadlineMs >= Date.now() && validId(request.id) && request.nonce.length >= 16 && request.nonce.length <= MAX_NONCE_LENGTH && Number.isSafeInteger(request.sequence) && request.sequence > this.lastSequence && this.verify(body(unsigned), request.mac); }
    catch { authenticated = false; }
    if (!authenticated) return this.response(request.id, false, "authentication or replay check failed");
    this.lastSequence = request.sequence;
    try {
      let result: unknown;
      switch (request.method) {
        case "status": result = this.adapter.status(); break;
        case "snapshot": result = this.adapter.snapshot(); break;
        case "discover": throw new Error("in-process discovery requires the asynchronous adapter contract");
        case "get": if (!request.ref) throw new Error("ref is required"); result = this.adapter.get(request.ref); break;
        case "invoke": if (!request.operation || !request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new Error("operation and args are required"); validateLiveOperationRequest(request.operation, request.args); result = this.adapter.invoke({ operation: request.operation, args: request.args }); validateLiveOperationResult(request.operation, result); break;
        case "reconnect": result = this.adapter.reconnect(); break;
        case "subscribe": this.unsubscribe?.(); this.unsubscribe = this.adapter.subscribe((event) => this.emit(this.eventResponse(request.id, event))); result = { subscribed: true }; break;
      }
      return this.response(request.id, true, undefined, result);
    } catch { return this.response(request.id, false, "request failed"); }
  }
  authenticate(request: Omit<LoopbackRequest, "mac" | "sequence" | "bridgeEpoch" | "connectionChallenge" | "deadlineMs"> & { sequence?: number; deadlineMs?: number }): LoopbackRequest { const unsigned = { ...request, sequence: request.sequence ?? ++this.authSequence, bridgeEpoch: this.bridgeEpoch, connectionChallenge: this.connectionChallenge, deadlineMs: request.deadlineMs ?? Date.now() + 5_000 } as Omit<LoopbackRequest, "mac">; return { ...unsigned, mac: sign(this.secret, body(unsigned)) }; }
  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  private verify(value: string, mac: string): boolean { const expected = Buffer.from(sign(this.secret, value)); const supplied = Buffer.from(mac); return expected.length === supplied.length && timingSafeEqual(expected, supplied); }
  private response(id: string, ok: boolean, error?: string, result?: unknown): LoopbackResponse {
    const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id: validId(id) ? id : "invalid", ok, bridgeEpoch: this.bridgeEpoch, connectionChallenge: this.connectionChallenge, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
    try { return { ...unsigned, mac: sign(this.secret, boundedCanonical(unsigned)) }; }
    catch { const fallback = { version: LOOPBACK_PROTOCOL_VERSION, id: unsigned.id, ok: false, bridgeEpoch: this.bridgeEpoch, connectionChallenge: this.connectionChallenge, error: "response exceeds wire limits" }; return { ...fallback, mac: sign(this.secret, boundedCanonical(fallback)) }; }
  }
  private eventResponse(id: string, event: LiveEvent): LoopbackResponse { return this.response(id, true, undefined, { event }); }
  private isRequest(value: unknown): value is LoopbackRequest { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const request = value as Partial<LoopbackRequest>; return Object.keys(value).every((key) => ["version", "id", "method", "ref", "operation", "args", "nonce", "sequence", "bridgeEpoch", "connectionChallenge", "deadlineMs", "mac"].includes(key)) && typeof request.version === "string" && typeof request.id === "string" && typeof request.method === "string" && typeof request.nonce === "string" && typeof request.sequence === "number" && typeof request.bridgeEpoch === "string" && typeof request.connectionChallenge === "string" && typeof request.deadlineMs === "number" && typeof request.mac === "string" && ["status", "snapshot", "discover", "get", "invoke", "subscribe", "reconnect"].includes(request.method); }
}

/**
 * Client-side LiveAdapter for a trusted localhost Control Surface/Extension.
 * The exchange is deliberately injected so socket ownership, framing, and
 * process lifecycle stay outside the domain contract and can be tested with
 * the deterministic server above.
 */
export class LoopbackLiveAdapter implements LiveAdapter {
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private requestNumber = 0;
  private eventSequence = 0;

  constructor(private readonly secret: string, private readonly exchange: LoopbackExchange) {
    if (secret.length < 32) throw new Error("loopback secret must contain at least 32 characters");
  }

  status(): LiveStatus { return this.request({ method: "status" }) as LiveStatus; }
  snapshot(): LiveSnapshot { return this.request({ method: "snapshot" }) as LiveSnapshot; }
  get(objectRef: LiveRef): unknown { return this.request({ method: "get", ref: objectRef }); }
  invoke(invocation: LiveInvocation): unknown {
    const status = this.status();
    if (!status.operations?.includes(invocation.operation)) throw new Error(`loopback operation is not negotiated: ${invocation.operation}`);
    return this.request({ method: "invoke", operation: invocation.operation, args: invocation.args });
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    try { this.request({ method: "subscribe" }); }
    catch (error) { this.listeners.delete(listener); throw error; }
    return () => this.listeners.delete(listener);
  }

  reconnect(): LiveStatus { return this.request({ method: "reconnect" }) as LiveStatus; }

  /** Feed an asynchronous subscription response received by the socket. */
  receive(response: LoopbackResponse): void {
    const result = this.verifyResponse(response);
    if (!isObject(result) || !isObject(result.event)) throw new Error("invalid loopback event");
    const event = result.event as { sequence?: unknown };
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= this.eventSequence) throw new Error("stale loopback event");
    this.eventSequence = event.sequence as number;
    for (const listener of this.listeners) listener(result.event as unknown as LiveEvent);
  }

  private request(fields: Omit<LoopbackRequest, "version" | "id" | "nonce" | "sequence" | "bridgeEpoch" | "connectionChallenge" | "deadlineMs" | "mac">): unknown {
    const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id: `client-${++this.requestNumber}`, ...fields, nonce: randomBytes(18).toString("base64url"), sequence: this.requestNumber, bridgeEpoch: "in-process", connectionChallenge: "in-process", deadlineMs: Date.now() + 5_000 } as Omit<LoopbackRequest, "mac">;
    return this.verifyResponse(this.exchange({ ...unsigned, mac: sign(this.secret, body(unsigned)) }), unsigned.id);
  }

  private verifyResponse(response: LoopbackResponse, expectedId?: string): unknown {
    if (!response || response.version !== LOOPBACK_PROTOCOL_VERSION || response.bridgeEpoch !== "in-process" || response.connectionChallenge !== "in-process" || !validId(response.id) || (expectedId !== undefined && response.id !== expectedId) || typeof response.ok !== "boolean" || typeof response.mac !== "string") throw new Error("invalid loopback response");
    const unsigned = { ...response } as Partial<LoopbackResponse>;
    delete unsigned.mac;
    if (!this.verify(boundedCanonical(unsigned), response.mac)) throw new Error("loopback response authentication failed");
    if (!response.ok) throw new Error(response.error ?? "loopback request failed");
    return response.result;
  }

  private verify(value: string, mac: string): boolean {
    const expected = Buffer.from(sign(this.secret, value));
    const supplied = Buffer.from(mac);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
}

export const AuthenticatedLoopbackClient = LoopbackLiveAdapter;

export function statusFromAdapter(adapter: LiveAdapter): LiveStatus { return adapter.status(); }
