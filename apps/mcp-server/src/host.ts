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

const resources = [
  { uri: "ableton://capabilities", name: "Capability catalog", description: "Implemented and unavailable host capabilities.", mimeType: "application/json" },
  { uri: "ableton://safety", name: "Live safety contract", description: "The host's read-only and unavailable-capability guarantees.", mimeType: "text/markdown" },
] as const;

const prompts = [
  {
    name: "analyze_audio",
    description: "Prepare a bounded, local PCM analysis request without changing Live state.",
    arguments: [
      { name: "sampleRate", description: "PCM sample rate in Hz.", required: true },
      { name: "channels", description: "Optional interleaved channel count.", required: false },
    ],
  },
] as const;

const safetyResource = [
  "# Live safety contract",
  "",
  "This host does not connect to Ableton Live unless an explicit adapter is installed.",
  "The shipped adapter reports unavailable and performs no Live operations.",
  "The implemented audio workflow analyzes caller-supplied PCM locally and returns aggregates only.",
  "No tool starts playback, records, writes files, or mutates a project.",
].join("\n");

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

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function response(id: RequestId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function error(id: RequestId | null, code: number, message: string, data?: unknown): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textContent(text: string): JsonObject {
  return { type: "text", text };
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
      case "resources/list": return this.listResources(id, input.params);
      case "resources/read": return this.readResource(id, input.params);
      case "prompts/list": return this.listPrompts(id, input.params);
      case "prompts/get": return this.getPrompt(id, input.params);
      default: return error(id, -32601, "Method not found");
    }
  }

  private initialize(id: RequestId, params: unknown): JsonObject {
    if (this.initialized) return error(id, -32600, "Already initialized");
    if (
      !isObject(params) ||
      !hasOnly(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
      params.protocolVersion !== PROTOCOL_VERSION ||
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
      capabilities: { tools: {}, resources: {}, prompts: {} },
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
      if (
        !isObject(args) ||
        !hasOnly(args, ["pcmBase64", "sampleRate", "channels", "frameSize"]) ||
        typeof args.pcmBase64 !== "string" ||
        !isIntegerInRange(args.sampleRate, 8_000, 384_000) ||
        (args.channels !== undefined && !isIntegerInRange(args.channels, 1, 32)) ||
        (args.frameSize !== undefined && !isIntegerInRange(args.frameSize, 256, 4_096))
      ) {
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

  private listResources(id: RequestId, params: unknown): JsonObject {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid resources/list parameters");
    return response(id, { resources });
  }

  private readResource(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["uri"]) || typeof params.uri !== "string") {
      return error(id, -32602, "Invalid resources/read parameters");
    }
    if (params.uri === "ableton://safety") {
      return response(id, { contents: [{ uri: params.uri, mimeType: "text/markdown", text: safetyResource }] });
    }
    if (params.uri === "ableton://capabilities") {
      return response(id, { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify({ implemented: ["server.status", "capabilities", "audio.analyze"], unavailable: unavailableCapabilities }) }] });
    }
    return error(id, -32002, "Resource not found", { uri: params.uri });
  }

  private listPrompts(id: RequestId, params: unknown): JsonObject {
    if (!this.utilityParams(params)) return error(id, -32602, "Invalid prompts/list parameters");
    return response(id, { prompts });
  }

  private getPrompt(id: RequestId, params: unknown): JsonObject {
    if (!isObject(params) || !hasOnly(params, ["name", "arguments"]) || typeof params.name !== "string") {
      return error(id, -32602, "Invalid prompts/get parameters");
    }
    if (params.arguments !== undefined && (!isObject(params.arguments) || !hasOnly(params.arguments, ["sampleRate", "channels"]))) {
      return error(id, -32602, "Invalid prompt arguments");
    }
    if (params.name !== "analyze_audio") return error(id, -32002, "Prompt not found", { name: params.name });
    const argumentsObject = params.arguments as JsonObject | undefined;
    const sampleRate = argumentsObject?.sampleRate;
    const channels = argumentsObject?.channels;
    const details = [
      "Use tools/call with name audio_analyze and caller-supplied little-endian float32 PCM.",
      sampleRate === undefined ? "Provide sampleRate in Hz." : `Use sampleRate=${String(sampleRate)} Hz.`,
      channels === undefined ? "Optionally provide channels." : `Use channels=${String(channels)}.`,
    ].join(" ");
    return response(id, { description: "Safe local audio analysis", messages: [{ role: "user", content: textContent(details) }] });
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
