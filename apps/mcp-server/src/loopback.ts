import { createHmac, timingSafeEqual } from "node:crypto";
import type { LiveAdapter, LiveEvent, LiveInvocation, LiveRef, LiveStatus } from "./live.js";

export const LOOPBACK_PROTOCOL_VERSION = "ableton-loopback/v1";
const MAX_NONCE_LENGTH = 256;
export type LoopbackRequest = { version: string; id: string; method: "status" | "snapshot" | "get" | "set" | "invoke" | "subscribe" | "reconnect"; ref?: LiveRef; property?: string; value?: unknown; operation?: LiveInvocation["operation"]; args?: Record<string, unknown>; nonce: string; mac: string };
export type LoopbackResponse = { version: string; id: string; ok: boolean; result?: unknown; error?: string; mac: string };

function body(request: Omit<LoopbackRequest, "mac">): string { return JSON.stringify(request); }
function sign(secret: string, value: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

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

export function statusFromAdapter(adapter: LiveAdapter): LiveStatus { return adapter.status(); }
