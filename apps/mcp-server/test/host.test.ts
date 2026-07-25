import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION, serve } from "../src/host.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }

test("requires initialization and exposes only read-only tools", () => {
  const host = new McpHost();
  assert.equal((host.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as any).error.code, -32002);
  assert.equal((host.handle({ ...initialize, id: 2 }) as any).result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(host.handle(initialized), null);
  const tools = (host.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["server_status", "capabilities", "audio_analyze"]);
});

test("validates client identity and rejects unsupported protocol versions", () => {
  const host = new McpHost();
  assert.equal((host.handle({ ...initialize, id: 1, params: { ...initialize.params, clientInfo: { name: "", version: "1" } } }) as any).error.code, -32602);
  assert.equal((host.handle({ ...initialize, id: 2, params: { ...initialize.params, protocolVersion: "unsupported" } }) as any).error.code, -32602);
  assert.equal((host.handle({ ...initialize, id: 3 }) as any).result.protocolVersion, PROTOCOL_VERSION);
  const second = new McpHost();
  assert.equal((second.handle({ ...initialize, id: 4 }) as any).result.protocolVersion, PROTOCOL_VERSION);
});

test("reports Live unavailable and ignores caller authority", () => {
  const host = new McpHost();
  ready(host);
  const status = host.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "server_status", arguments: { grant: "admin" } } });
  assert.equal((status as any).error.code, -32602);
  const capabilities = host.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "capabilities", arguments: {} } });
  const text = (capabilities as any).result.content[0].text;
  assert.match(text, /live\.mutations/);
  assert.doesNotMatch(text, /admin/);
});

test("analyzes supplied PCM through the MCP tool without Live side effects", () => {
  const bytes = Buffer.alloc(4 * 4);
  for (const [index, value] of [0, 0.5, -0.5, 0].entries()) bytes.writeFloatLE(value, index * 4);
  const host = new McpHost();
  ready(host);
  const result = host.handle({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "audio_analyze", arguments: { pcmBase64: bytes.toString("base64"), sampleRate: 44100 } } });
  const text = (result as any).result.content[0].text;
  const analysis = JSON.parse(text) as { sampleCount: number; privacy: { rawAudioReturned: boolean }; safety: { projectMutated: boolean } };
  assert.equal(analysis.sampleCount, 4);
  assert.equal(analysis.privacy.rawAudioReturned, false);
  assert.equal(analysis.safety.projectMutated, false);
});

test("rejects duplicates, unsupported methods, and unknown fields", () => {
  const host = new McpHost();
  ready(host);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.length, 3);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).error.message, "Duplicate request identifier");
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set", arguments: {} } }) as any).error.code, -32601);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 4, method: "tools/list", debug: true }) as any).error.code, -32600);
});

test("accepts cancellation notifications without manufacturing a response", () => {
  const host = new McpHost();
  ready(host);
  assert.equal(host.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }), null);
});

test("keeps stdout protocol-only and emits redacted parse diagnostics on stderr", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const outputChunks: Buffer[] = [];
  const diagnosticChunks: Buffer[] = [];
  output.on("data", (chunk) => outputChunks.push(chunk));
  diagnostics.on("data", (chunk) => diagnosticChunks.push(chunk));
  const done = serve(input, output, diagnostics);
  input.end("not-json\n");
  await done;
  assert.equal(JSON.parse(Buffer.concat(outputChunks).toString()).error.code, -32700);
  assert.equal(Buffer.concat(diagnosticChunks).toString(), "mcp-host: malformed input\n");
});

test("built process performs a read-only handshake and exits without non-protocol stdout", () => {
  const entry = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const child = spawnSync(process.execPath, [entry], {
    input: [
      initialize,
      initialized,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "server_status", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "capabilities", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.id), [1, 2, 3, 4]);
  assert.equal(records[1].result.content[0].text.includes("live-adapter-not-installed"), true);
  assert.equal(records[2].result.content[0].text.includes("live.mutations"), true);
  assert.deepEqual(records[3].result, {});
  assert.equal(child.stderr, "");
});

test("accepts MCP metadata and reports value errors as tool errors", () => {
  const host = new McpHost();
  const init = host.handle({ ...initialize, _meta: { trace: "test" }, params: { ...initialize.params, _meta: {} } });
  assert.equal((init as any).result.protocolVersion, PROTOCOL_VERSION);
  host.handle(initialized);
  const result = host.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", _meta: {}, params: { name: "audio_analyze", _meta: {}, arguments: { pcmBase64: "AAAA", sampleRate: 44100 } } });
  assert.equal((result as any).result.isError, true);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "ping" }) as any).result instanceof Object, true);
});

test("does not let invalid audio requests consume the rate limit", () => {
  const host = new McpHost();
  ready(host);
  for (let id = 2; id <= 121; id += 1) {
    const result = host.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "audio_analyze", arguments: {} } });
    assert.equal((result as any).error.code, -32602);
  }
  const bytes = Buffer.alloc(4);
  const result = host.handle({ jsonrpc: "2.0", id: 122, method: "tools/call", params: { name: "audio_analyze", arguments: { pcmBase64: bytes.toString("base64"), sampleRate: 44100 } } });
  assert.equal((result as any).result.isError, false);
});

test("rejects legacy shutdown and cancellation requests", () => {
  const host = new McpHost();
  ready(host);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" }) as any).error.code, -32601);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "$/cancelRequest", params: { requestId: 1 } }) as any).error.code, -32601);
  assert.equal(host.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
});
