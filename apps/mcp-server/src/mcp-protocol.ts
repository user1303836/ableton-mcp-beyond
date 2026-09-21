/** MCP wire semantics only: never creates Live authority or transaction state. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION] as const;
export type ProtocolEra = "legacy" | "modern";
type JsonObject = Record<string, unknown>;
const prefix = "io.modelcontextprotocol/";
const versionKey = `${prefix}protocolVersion`;
const capabilitiesKey = `${prefix}clientCapabilities`;
const identityKey = `${prefix}clientInfo`;
const logLevelKey = `${prefix}logLevel`;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const label = "[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const metaKey = new RegExp(`^(?:(?:${label}\\.)*${label}/)?(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)?$`);
const cacheable = new Set(["server/discover", "tools/list", "prompts/list", "resources/list", "resources/templates/list", "resources/read"]);
/** Legacy push notifications have no modern subscriptions/listen binding yet.
 * Explicit observe/poll tools and authoritative snapshots remain available. */
export const MODERN_UNAVAILABLE_TOOLS = new Set(["live_subscribe", "live_unsubscribe"]);

function failure(input: JsonObject, code: number, message: string, data?: JsonObject): JsonObject {
  const id = typeof input.id === "string" && input.id.length > 0 && input.id.length <= 128 || typeof input.id === "number" && Number.isSafeInteger(input.id) ? input.id : null;
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

export function prepareMcpRequest(input: unknown, era?: ProtocolEra): { input: unknown; modern: boolean; error?: JsonObject } {
  // The core retains envelope validation and notification handling. Metadata
  // must not turn malformed envelopes or notifications into method dispatches.
  if (!object(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string" || input.id === undefined) return { input, modern: false };
  const params = object(input.params) ? input.params : undefined;
  const meta = params && object(params._meta) ? params._meta : undefined;
  const modern = era === "modern" || input.method === "server/discover" || (meta !== undefined && [versionKey, capabilitiesKey, identityKey, logLevelKey].some((key) => Object.hasOwn(meta, key)));
  if (!modern) return { input, modern: false };
  const invalid = (message: string) => ({ input, modern: true, error: failure(input, -32602, message) });
  if (Object.keys(input).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) return { input, modern, error: failure(input, -32600, "Invalid modern request envelope") };
  if (!meta || typeof meta[versionKey] !== "string" || !object(meta[capabilitiesKey])) return invalid("Modern requests require protocolVersion and clientCapabilities in params._meta");
  const version = meta[versionKey];
  if (version.length < 1 || version.length > 64) return invalid("Invalid protocol version metadata");
  if (version !== MODERN_PROTOCOL_VERSION) {
    if (version === LEGACY_PROTOCOL_VERSION) return invalid("Legacy 2025-11-25 requires initialize on a legacy stdio process");
    return { input, modern, error: failure(input, -32022, "Unsupported protocol version", { requested: version, supported: [...SUPPORTED_PROTOCOL_VERSIONS] }) };
  }
  if (Object.keys(meta).length > 128 || Object.keys(meta).some((key) => key.length > 256 || !metaKey.test(key))) return invalid("Invalid or oversized request metadata");
  if (meta[identityKey] !== undefined) {
    const identity = meta[identityKey];
    if (!object(identity) || typeof identity.name !== "string" || identity.name.length < 1 || identity.name.length > 256 || typeof identity.version !== "string" || identity.version.length < 1 || identity.version.length > 64) return invalid("Invalid clientInfo metadata");
  }
  const capabilities = meta[capabilitiesKey] as JsonObject;
  if (Object.keys(capabilities).length > 128 || ["experimental", "roots", "sampling", "elicitation", "extensions"].some((key) => capabilities[key] !== undefined && !object(capabilities[key]))) return invalid("Invalid clientCapabilities metadata");
  if (object(capabilities.experimental) && Object.values(capabilities.experimental).some((value) => !object(value))) return invalid("Invalid experimental capabilities");
  for (const [name, fields] of [["sampling", ["context", "tools"]], ["elicitation", ["form", "url"]]] as const) {
    const capability = capabilities[name];
    if (object(capability) && fields.some((field) => capability[field] !== undefined && !object(capability[field]))) return invalid("Invalid client capability settings");
  }
  if (object(capabilities.extensions) && Object.entries(capabilities.extensions).some(([key, value]) => !key.includes("/") || !metaKey.test(key) || !object(value))) return invalid("Invalid extension capabilities");
  if (meta.progressToken !== undefined && !(typeof meta.progressToken === "string" || typeof meta.progressToken === "number" && Number.isFinite(meta.progressToken))) return invalid("Invalid progress token");
  if (meta[logLevelKey] !== undefined && !["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"].includes(meta[logLevelKey] as string)) return invalid("Invalid log level");
  if (input.method === "initialize") return invalid("Modern requests do not use initialize");
  if (era === "legacy" && input.method !== "server/discover") return invalid("Do not mix protocol eras after legacy initialization; start a new stdio process");
  if (input.method === "tools/call" && (typeof params?.name !== "string" || Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key)) || params.arguments !== undefined && !object(params.arguments))) return invalid("Invalid tools/call parameters");
  if (input.method === "tools/call" && MODERN_UNAVAILABLE_TOOLS.has(params!.name as string)) return invalid("Legacy push subscriptions are unavailable in modern mode; use snapshot or observe/poll");
  const { _meta: _ignored, ...argumentsObject } = params!;
  // No client metadata is stored or treated as consent, policy, or capabilities
  // of Live itself. Each request has to supply its own protocol metadata.
  return { input: { ...input, params: argumentsObject }, modern };
}

export function formatMcpResponse(frame: JsonObject | null, input: unknown, modern: boolean, serverInfo: JsonObject): JsonObject | null {
  if (!frame || !modern) return frame;
  const method = object(input) ? input.method : undefined;
  if (object(frame.error)) {
    const obsolete = frame.error.code === -32002 || frame.error.code === -32042;
    const unknownTool = method === "tools/call" && frame.error.code === -32601;
    return obsolete || unknownTool ? { ...frame, error: { ...frame.error, code: -32602 } } : frame;
  }
  if (!object(frame.result)) return frame;
  const result: JsonObject = { ...frame.result, resultType: "complete", _meta: { ...(object(frame.result._meta) ? frame.result._meta : {}), [`${prefix}serverInfo`]: serverInfo } };
  if (cacheable.has(method as string)) Object.assign(result, { ttlMs: 0, cacheScope: "private" });
  if (method === "tools/list" && Array.isArray(result.tools)) result.tools = result.tools.filter((tool) => object(tool) && !MODERN_UNAVAILABLE_TOOLS.has(tool.name as string));
  // Promote the existing redacted JSON text, after coalesced replay formatting,
  // so programmatic clients never need to scrape text or receive stale flags.
  if (method === "tools/call" && Array.isArray(result.content) && result.content.length === 1 && object(result.content[0]) && result.content[0].type === "text" && typeof result.content[0].text === "string") {
    try { result.structuredContent = JSON.parse(result.content[0].text) as unknown; } catch { /* Non-JSON prose remains text. */ }
  }
  return { ...frame, result };
}
