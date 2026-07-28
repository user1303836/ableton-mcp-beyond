import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LiveRegistryOperation {
  id: string;
  method: "status" | "snapshot" | "discover" | "get" | "preflight" | "prepare" | "invoke" | "subscribe" | "reconnect";
  request: Record<string, unknown>;
  result: Record<string, unknown>;
}
export interface LiveRegistry { version: number; protocol: string; operations: LiveRegistryOperation[]; }

const SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "maxProperties", "pattern"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("registry is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("registry contains an unsupported value");
}

function registryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "../../../protocol/ableton-live-v1.operations.json"), join(process.cwd(), "../../protocol/ableton-live-v1.operations.json"), join(process.cwd(), "protocol/ableton-live-v1.operations.json"), join(here, "../../remote-script/AbletonMcpBridge/ableton-live-v1.operations.json")].find((candidate) => {
    try { readFileSync(candidate); return true; } catch { return false; }
  }) ?? join(here, "../../../protocol/ableton-live-v1.operations.json");
}

export function loadLiveRegistry(): LiveRegistry {
  const parsed = JSON.parse(readFileSync(registryPath(), "utf8")) as LiveRegistry;
  if (!parsed || parsed.version !== 1 || parsed.protocol !== "ableton-live/v1" || !Array.isArray(parsed.operations) || parsed.operations.length === 0 || parsed.operations.length > 128) throw new Error("invalid Live operation registry");
  const ids = parsed.operations.map((operation) => operation.id);
  if (ids.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128) || new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) throw new Error("registry operation identifiers must be unique and sorted");
  const validateSchema = (schema: unknown, depth = 0): void => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) throw new Error("invalid registry schema");
    const value = schema as Record<string, unknown>;
    if (Object.keys(value).some((key) => !SCHEMA_KEYS.has(key))) throw new Error("unknown registry schema keyword");
    const types = value.type === undefined ? [] : (Array.isArray(value.type) ? value.type : [value.type]);
    if (types.length === 0 || types.length > 4 || types.some((type) => typeof type !== "string" || !SCHEMA_TYPES.has(type))) throw new Error("registry schema type is invalid");
    for (const key of ["minLength", "maxLength", "minItems", "maxItems", "maxProperties"] as const) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > Number.MAX_SAFE_INTEGER)) throw new Error("registry schema bound is invalid");
    for (const key of ["minimum", "maximum"] as const) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < -Number.MAX_SAFE_INTEGER || value[key] > Number.MAX_SAFE_INTEGER)) throw new Error("registry schema bound is invalid");
    if ((value.minItems !== undefined || value.maxItems !== undefined || value.uniqueItems !== undefined) && !types.includes("array")) throw new Error("array constraint on non-array schema");
    if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean") throw new Error("uniqueItems is invalid");
    if (typeof value.minItems === "number" && typeof value.maxItems === "number" && value.minItems > value.maxItems) throw new Error("array bounds are invalid");
    if (value.maxProperties !== undefined && !types.includes("object")) throw new Error("object bound on non-object schema");
    if (types.includes("object")) {
      if (value.additionalProperties === undefined || typeof value.additionalProperties !== "boolean") throw new Error("object schema must bound additional properties");
      if (value.additionalProperties === true && value.maxProperties === undefined) throw new Error("additional properties must be bounded");
      if (value.properties !== undefined && (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties) || Object.keys(value.properties as object).length > 64)) throw new Error("object properties are invalid");
      if (value.required !== undefined && (!Array.isArray(value.required) || value.required.length > 64 || value.required.some((item) => typeof item !== "string"))) throw new Error("required fields are invalid");
      for (const child of Object.values((value.properties ?? {}) as Record<string, unknown>)) validateSchema(child, depth + 1);
    }
    if (types.includes("array")) {
      if (!value.items || typeof value.items !== "object") throw new Error("array items are required");
      validateSchema(value.items, depth + 1);
    }
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 32)) throw new Error("enum is invalid");
    if (value.const !== undefined && (typeof value.const === "object" || typeof value.const === "function")) throw new Error("const is invalid");
  };
  for (const operation of parsed.operations) {
    if (!operation || !["status", "snapshot", "discover", "get", "preflight", "prepare", "invoke", "subscribe", "reconnect"].includes(operation.method) || !operation.request || !operation.result) throw new Error(`invalid registry operation: ${operation?.id ?? "unknown"}`);
    validateSchema(operation.request);
    validateSchema(operation.result);
  }
  return parsed;
}

export function liveRegistryHash(registry = loadLiveRegistry()): string {
  return createHash("sha256").update(canonical(registry)).digest("hex");
}

export function liveRegistryOperations(registry = loadLiveRegistry()): readonly string[] {
  return registry.operations.map((operation) => operation.id);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

/** Validate production wire values against the exact canonical registry subset. */
export function validateRegistryValue(schema: Record<string, unknown>, value: unknown, path = "$"): void {
  const declared = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
  if (!declared.some((type) => matchesType(value, type))) throw new Error(`${path} does not match registry type`);
  if (schema.const !== undefined && value !== schema.const) throw new Error(`${path} does not match registry constant`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) throw new Error(`${path} is outside registry enum`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) throw new Error(`${path} is shorter than registry minimum`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) throw new Error(`${path} exceeds registry maximum`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} does not match registry pattern`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (typeof schema.minimum === "number" && value < schema.minimum) || (typeof schema.maximum === "number" && value > schema.maximum)) throw new Error(`${path} is outside registry numeric bounds`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} is below registry item bound`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} exceeds registry item bound`);
    if (schema.uniqueItems === true && new Set(value.map((item) => canonical(item))).size !== value.length) throw new Error(`${path} contains duplicate registry items`);
    const itemSchema = schema.items as Record<string, unknown>;
    value.forEach((item, index) => validateRegistryValue(itemSchema, item, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (typeof schema.maxProperties === "number" && Object.keys(object).length > schema.maxProperties) throw new Error(`${path} exceeds registry property bound`);
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const required of (schema.required ?? []) as string[]) if (!(required in object)) throw new Error(`${path}.${required} is required by registry`);
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed by registry`);
    for (const [key, child] of Object.entries(properties)) if (key in object) validateRegistryValue(child, object[key], `${path}.${key}`);
  }
}

export function validateLiveOperationRequest(operationId: string, value: unknown, registry = loadLiveRegistry()): void {
  const operation = registry.operations.find((item) => item.id === operationId);
  if (!operation) throw new Error(`operation is not in canonical registry: ${operationId}`);
  validateRegistryValue(operation.request, value, `${operationId}.request`);
}

export function validateLiveOperationResult(operationId: string, value: unknown, registry = loadLiveRegistry()): void {
  const operation = registry.operations.find((item) => item.id === operationId);
  if (!operation) throw new Error(`operation is not in canonical registry: ${operationId}`);
  validateRegistryValue(operation.result, value, `${operationId}.result`);
}
