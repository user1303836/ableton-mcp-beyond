import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { LiveAdapter, LiveEvent, LiveInvocation, LiveRef, LiveSnapshot, LiveStatus } from "./live.js";

export const LOOPBACK_PROTOCOL_VERSION = "ableton-loopback/v1";
const MAX_NONCE_LENGTH = 256;
export type LoopbackRequest = { version: string; id: string; method: "status" | "snapshot" | "get" | "set" | "invoke" | "subscribe" | "reconnect"; ref?: LiveRef; property?: string; value?: unknown; operation?: LiveInvocation["operation"]; args?: Record<string, unknown>; nonce: string; mac: string };
export type LoopbackResponse = { version: string; id: string; ok: boolean; result?: unknown; error?: string; mac: string };
export type LoopbackExchange = (request: LoopbackRequest) => LoopbackResponse;

function body(request: Omit<LoopbackRequest, "mac">): string { return JSON.stringify(request); }
function sign(secret: string, value: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Authenticated, bounded loopback transport used by Remote Script/Extension adapters. */
export class AuthenticatedLoopback {
  private readonly seenNonces = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly adapter: LiveAdapter, private readonly secret: string, private readonly emit: (response: LoopbackResponse) => void = () => undefined) {
    if (secret.length < 32) throw new Error("loopback secret must contain at least 32 characters");
  }
  handle(request: unknown): LoopbackResponse {
    if (!this.isRequest(request)) return this.response("invalid", false, "invalid request");
    const unsigned = { ...request } as Omit<LoopbackRequest, "mac">;
    delete (unsigned as Partial<LoopbackRequest>).mac;
    if (request.version !== LOOPBACK_PROTOCOL_VERSION || !validId(request.id) || request.nonce.length < 16 || request.nonce.length > MAX_NONCE_LENGTH || this.seenNonces.has(request.nonce) || !this.verify(body(unsigned), request.mac)) return this.response(request.id, false, "authentication or replay check failed");
    this.seenNonces.add(request.nonce);
    try {
      let result: unknown;
      switch (request.method) {
        case "status": result = this.adapter.status(); break;
        case "snapshot": result = this.adapter.snapshot(); break;
        case "get": if (!request.ref) throw new Error("ref is required"); result = this.adapter.get(request.ref); break;
        case "set": if (!request.ref || !request.property) throw new Error("ref and property are required"); this.adapter.set(request.ref, request.property, request.value); result = { changed: true }; break;
        case "invoke": if (!request.operation || !request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new Error("operation and args are required"); result = this.adapter.invoke({ operation: request.operation, args: request.args }); break;
        case "reconnect": result = this.adapter.reconnect(); break;
        case "subscribe": this.unsubscribe?.(); this.unsubscribe = this.adapter.subscribe((event) => this.emit(this.eventResponse(request.id, event))); result = { subscribed: true }; break;
      }
      return this.response(request.id, true, undefined, result);
    } catch { return this.response(request.id, false, "request failed"); }
  }
  authenticate(request: Omit<LoopbackRequest, "mac">): LoopbackRequest { return { ...request, mac: sign(this.secret, body(request)) }; }
  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  private verify(value: string, mac: string): boolean { const expected = Buffer.from(sign(this.secret, value)); const supplied = Buffer.from(mac); return expected.length === supplied.length && timingSafeEqual(expected, supplied); }
  private response(id: string, ok: boolean, error?: string, result?: unknown): LoopbackResponse { const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id, ok, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }; return { ...unsigned, mac: sign(this.secret, JSON.stringify(unsigned)) }; }
  private eventResponse(id: string, event: LiveEvent): LoopbackResponse { return this.response(id, true, undefined, { event }); }
  private isRequest(value: unknown): value is LoopbackRequest { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const request = value as Partial<LoopbackRequest>; return Object.keys(value).every((key) => ["version", "id", "method", "ref", "property", "value", "operation", "args", "nonce", "mac"].includes(key)) && typeof request.version === "string" && typeof request.id === "string" && typeof request.method === "string" && typeof request.nonce === "string" && typeof request.mac === "string" && ["status", "snapshot", "get", "set", "invoke", "subscribe", "reconnect"].includes(request.method); }
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

  constructor(private readonly secret: string, private readonly exchange: LoopbackExchange) {
    if (secret.length < 32) throw new Error("loopback secret must contain at least 32 characters");
  }

  status(): LiveStatus { return this.request({ method: "status" }) as LiveStatus; }
  snapshot(): LiveSnapshot { return this.request({ method: "snapshot" }) as LiveSnapshot; }
  get(objectRef: LiveRef): unknown { return this.request({ method: "get", ref: objectRef }); }
  set(objectRef: LiveRef, property: string, value: unknown): void { this.request({ method: "set", ref: objectRef, property, value }); }
  invoke(invocation: LiveInvocation): unknown { return this.request({ method: "invoke", operation: invocation.operation, args: invocation.args }); }

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
    for (const listener of this.listeners) listener(result.event as unknown as LiveEvent);
  }

  private request(fields: Omit<LoopbackRequest, "version" | "id" | "nonce" | "mac">): unknown {
    const unsigned = { version: LOOPBACK_PROTOCOL_VERSION, id: `client-${++this.requestNumber}`, ...fields, nonce: randomBytes(18).toString("base64url") } as Omit<LoopbackRequest, "mac">;
    return this.verifyResponse(this.exchange({ ...unsigned, mac: sign(this.secret, body(unsigned)) }));
  }

  private verifyResponse(response: LoopbackResponse): unknown {
    if (!response || response.version !== LOOPBACK_PROTOCOL_VERSION || !validId(response.id) || typeof response.ok !== "boolean" || typeof response.mac !== "string") throw new Error("invalid loopback response");
    const unsigned = { ...response } as Partial<LoopbackResponse>;
    delete unsigned.mac;
    if (!this.verify(JSON.stringify(unsigned), response.mac)) throw new Error("loopback response authentication failed");
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
