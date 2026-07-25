import type { Readable, Writable } from "node:stream";
import { analyzePcm, decodeFloat32Le } from "./analysis.js";
import { serveStdio } from "./stdio.js";

export const PROTOCOL_VERSION = "2025-11-25";
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_REQUEST_IDS = 4096;
const MAX_TOOL_CALLS_PER_MINUTE = 120;

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

const REQUEST_ID_MAX_LENGTH = 128;
const SERVER_VERSION = "0.1.0";

export interface LiveStatus {
  connected: false;
  adapter: "unavailable";
  epoch: null;
  reason: "live-adapter-not-installed";
}

export interface LiveAdapter {
  status(): LiveStatus;
}

export class UnavailableLiveAdapter implements LiveAdapter {
  status(): LiveStatus {
    return {
      connected: false,
      adapter: "unavailable",
      epoch: null,
      reason: "live-adapter-not-installed",
    };
  }
}

const implementedTools = [
  {
    name: "server_status",
    description: "Return host and Live-adapter availability without changing Live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "capabilities",
    description: "Return the negotiated read-only capability catalog.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audio_analyze",
    description: "Analyze caller-supplied normalized float32 PCM locally; returns aggregates only and never starts playback or mutates Live.",
    inputSchema: {
      type: "object",
      properties: {
        pcmBase64: { type: "string", description: "Little-endian float32 PCM, normalized to [-1, 1]." },
        sampleRate: { type: "integer", minimum: 8000, maximum: 384000 },
        channels: { type: "integer", minimum: 1, maximum: 32 },
        frameSize: { type: "integer", minimum: 256, maximum: 4096 },
      },
      required: ["pcmBase64", "sampleRate"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] as const;

const unavailableCapabilities = [
  "live.mutations",
  "live.transport",
  "live.recording",
  "live.routing",
  "live.audio",
  "live.midi",
  "resources.subscribe",
  "filesystem",
  "network",
  "realtime",
  "delivery",
  "live.audio.analysis",
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown, maxLength = REQUEST_ID_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function response(id: RequestId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function error(id: RequestId | null, code: number, message: string, data?: unknown): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export class McpHost {
  private initialized = false;
  private initializedNotification = false;
  private shuttingDown = false;
  private readonly seenIds = new Set<string>();
  private readonly idOrder: string[] = [];
  private readonly toolCallTimes: number[] = [];

  public constructor(private readonly adapter: LiveAdapter = new UnavailableLiveAdapter()) {}

  public handle(input: unknown): JsonObject | null {
    if (!isObject(input) || input.jsonrpc !== "2.0" || !hasOnly(input, ["jsonrpc", "id", "method", "params", "_meta"])) {
      return error(null, -32600, "Invalid Request");
    }
    if (typeof input.method !== "string" || !hasOnly(input, ["jsonrpc", "id", "method", "params", "_meta"])) {
      return error(this.requestId(input.id), -32600, "Invalid Request");
    }
    const id = input.id;
    if (id === undefined) {
      if (input.method === "notifications/initialized" && this.initialized && !this.initializedNotification && input.params === undefined) {
        this.initializedNotification = true;
        return null;
      }
      if (input.method === "notifications/cancelled") return null;
      return null;
    }
    if (!this.isId(id)) return error(null, -32600, "Invalid Request");
    const key = `${typeof id}:${String(id)}`;
    if (this.seenIds.has(key)) return error(id, -32600, "Duplicate request identifier");
    this.seenIds.add(key);
    this.idOrder.push(key);
    if (this.idOrder.length > MAX_TRACKED_REQUEST_IDS) {
      const expired = this.idOrder.shift();
      if (expired !== undefined) this.seenIds.delete(expired);
    }
    if (this.shuttingDown && input.method !== "exit") return error(id, -32600, "Server is shutting down");

    if (input.method === "notifications/initialized") {
      if (this.initializedNotification || !this.initialized || input.params !== undefined) return null;
      this.initializedNotification = true;
      return null;
    }
    if (input.method === "notifications/cancelled") {
      if (input.params !== undefined && (!isObject(input.params) || !hasOnly(input.params, ["requestId"]) || !this.isId(input.params.requestId))) return null;
      return null;
    }
    if (!this.initialized && input.method !== "initialize") {
      return error(id, -32002, "Server has not been initialized");
    }
    if (!this.initializedNotification && input.method !== "initialize" && input.method !== "ping") {
      return error(id, -32002, "Server has not received initialized notification");
    }
    switch (input.method) {
      case "initialize": return this.initialize(id, input.params);
      case "ping": return this.utilityParams(input.params) ? response(id, {}) : error(id, -32602, "Invalid ping parameters");
      case "tools/list": return this.utilityParams(input.params) ? response(id, { tools: implementedTools }) : error(id, -32602, "Invalid tools/list parameters");
      case "tools/call": return this.callTool(id, input.params);
      default: return error(id, -32601, "Method not found");
    }
  }

  private initialize(id: RequestId, params: unknown): JsonObject {
    if (this.initialized) return error(id, -32600, "Already initialized");
    if (
      !isObject(params) ||
      !hasOnly(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
      !isNonEmptyString(params.protocolVersion) ||
      !isObject(params.capabilities) ||
      !isObject(params.clientInfo) ||
      !isNonEmptyString(params.clientInfo.name, 256) ||
      !isNonEmptyString(params.clientInfo.version, 64) ||
      !hasOnly(params.clientInfo, ["name", "version", "title", "description", "websiteUrl", "icons"])
    ) {
      return error(id, -32602, "Invalid initialize parameters");
    }
    this.initialized = true;
    return response(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ableton-mcp-host", version: SERVER_VERSION },
    });
  }

  private cancel(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["requestId"]) || !this.isId(params.requestId)) {
      return error(id, -32602, "Invalid cancellation parameters");
    }
    return response(id, { cancelled: false, requestId: params.requestId, reason: "no-cancellable-operation" });
  }

  private callTool(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["name", "arguments", "_meta"]) || typeof params.name !== "string") {
      return error(id, -32602, "Invalid tools/call parameters");
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) return error(id, -32602, "Tool arguments must be an object");
    if (params.name !== "audio_analyze" && params.arguments !== undefined && Object.keys(params.arguments as JsonObject).length !== 0) {
      return error(id, -32602, "Tool arguments must be an empty object");
    }
    if (params.name === "server_status") {
      return response(id, { content: [{ type: "text", text: JSON.stringify({ host: "ready", live: this.adapter.status() }) }], isError: false });
    }
    if (params.name === "capabilities") {
      return response(id, { content: [{ type: "text", text: JSON.stringify({ implemented: ["server.status", "capabilities", "audio.analyze"], unavailable: unavailableCapabilities }) }], isError: false });
    }
    if (params.name === "audio_analyze") {
      const args = params.arguments;
      if (!isObject(args) || !hasOnly(args, ["pcmBase64", "sampleRate", "channels", "frameSize"]) || typeof args.pcmBase64 !== "string" || typeof args.sampleRate !== "number") {
        return error(id, -32602, "audio_analyze requires pcmBase64 and sampleRate");
      }
      const now = Date.now();
      while (this.toolCallTimes.length > 0 && now - (this.toolCallTimes[0] ?? now) >= 60_000) this.toolCallTimes.shift();
      if (this.toolCallTimes.length >= MAX_TOOL_CALLS_PER_MINUTE) return error(id, -32029, "Tool invocation rate limit exceeded");
      this.toolCallTimes.push(now);
      try {
        const result = analyzePcm({
          samples: decodeFloat32Le(args.pcmBase64),
          sampleRate: args.sampleRate,
          channels: args.channels as number | undefined,
          frameSize: args.frameSize as number | undefined,
        });
        return response(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "invalid audio input";
        return response(id, { content: [{ type: "text", text: JSON.stringify({ reason: message, remediation: "Provide bounded little-endian float32 PCM normalized to [-1, 1]." }) }], isError: true });
      }
    }
    return error(id, -32601, "Tool not found");
  }

  private isId(value: unknown): value is RequestId {
    return isNonEmptyString(value) || (typeof value === "number" && Number.isSafeInteger(value));
  }

  private utilityParams(value: unknown): boolean {
    return value === undefined || (isObject(value) && Object.keys(value).length === 0);
  }

  private requestId(value: unknown): RequestId | null {
    return this.isId(value) ? value : null;
  }
}

export function serve(input: Readable, output: Writable, diagnostics: Writable = process.stderr): Promise<void> {
  const host = new McpHost();
  return serveStdio(input, output, async (line) => {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; }
    catch { diagnostics.write("mcp-host: malformed input\n"); return JSON.stringify(error(null, -32700, "Parse error")); }
    try {
      const result = host.handle(value);
      return result === null ? null : JSON.stringify(result);
    } catch {
      diagnostics.write("mcp-host: internal fault\n");
      return JSON.stringify(error(null, -32603, "Internal error"));
    }
  });
}
