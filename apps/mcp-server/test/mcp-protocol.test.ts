import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { McpHost, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION, serve } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";
import { prepareMcpRequest } from "../src/mcp-protocol.js";
import { serveStdio } from "../src/stdio.js";
import { installExecutionLedger } from "./helpers/execution-ledger.js";

const versionKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const modern = (id: string | number, method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { [versionKey]: MODERN_PROTOCOL_VERSION, [capabilitiesKey]: {}, ...meta } } });
const initialize = { jsonrpc: "2.0", id: "legacy-init", method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "legacy-test", version: "1" } } };
const invoke = (host: McpHost, id: string | number, name: string, args: unknown): Promise<any> => host.handleAsync(modern(id, "tools/call", { name, arguments: args }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("modern discovery is handshake-free, privately uncacheable and preserves a legacy fallback", () => {
  const host = new McpHost();
  const discovery = host.handle(modern(1, "server/discover")) as any;
  assert.deepEqual(discovery.result.supportedVersions, [MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION]);
  assert.deepEqual(discovery.result.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.equal(discovery.result.resultType, "complete");
  assert.equal(discovery.result.ttlMs, 0); assert.equal(discovery.result.cacheScope, "private");
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].name, "ableton-mcp-host");
  assert.equal((host.handle(initialize) as any).result.protocolVersion, PROTOCOL_VERSION);
  host.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.ok((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.length);
  assert.equal((host.handle(modern(3, "tools/list")) as any).error.code, -32602, "selected eras are not silently mixed");
});

test("modern calls work without discovery and every request independently supplies metadata", async () => {
  const host = new McpHost();
  const first = await host.handleAsync(modern("reusable", "tools/list")) as any;
  const second = await host.handleAsync(modern("reusable", "tools/list", {}, { [capabilitiesKey]: { futureCapability: true } })) as any;
  assert.deepEqual(first.result.tools, second.result.tools);
  assert.equal(first.result.resultType, "complete"); assert.equal(first.result.ttlMs, 0);
  assert.equal((await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).error.code, -32602);
  assert.equal((host.handle(initialize) as any).error.code, -32602);
  for (const method of ["prompts/list", "resources/list", "resources/read"]) {
    const result = await host.handleAsync(modern(method, method, method === "resources/read" ? { uri: "ableton://safety" } : {})) as any;
    assert.equal(result.result.resultType, "complete"); assert.equal(result.result.ttlMs, 0); assert.equal(result.result.cacheScope, "private");
  }
});

test("unsupported versions and malformed metadata fail before adapter use and do not select an era", () => {
  const host = new McpHost();
  const unknown = host.handle(modern(1, "tools/list", {}, { [versionKey]: "2099-01-01" })) as any;
  assert.equal(unknown.error.code, -32022);
  assert.deepEqual(unknown.error.data, { requested: "2099-01-01", supported: [MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION] });
  for (const meta of [{ [capabilitiesKey]: undefined }, { [capabilitiesKey]: [] }, { [capabilitiesKey]: { sampling: true } }, { "bad key": true }, { "io.modelcontextprotocol/clientInfo": { name: "missing-version" } }, { progressToken: false }, { "io.modelcontextprotocol/logLevel": "all" }]) {
    assert.equal((host.handle(modern(2, "server/discover", {}, meta)) as any).error.code, -32602);
  }
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "server/discover" }) as any).error.code, -32602);
  assert.equal((host.handle(initialize) as any).result.protocolVersion, PROTOCOL_VERSION);
  const input = modern(4, "tools/list", {}, { "com.example/trace": { private: true } });
  const before = structuredClone(input);
  prepareMcpRequest(input);
  assert.deepEqual(input, before, "wire parsing does not mutate caller input");
});

test("modern wire results preserve structured data, application idempotency, confirmation and undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  const preview = (await invoke(host, 1, "live_tempo_preview", { tempo: 132 })).result.structuredContent;
  assert.ok(preview.transactionId);
  const args = { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "modern-apply-key" };
  const denied = await invoke(host, 2, "live_tempo_apply", { transactionId: preview.transactionId, idempotencyKey: "modern-apply-key" });
  assert.ok(denied.error || denied.result.isError, "protocol metadata is not confirmation");
  const ledger = installExecutionLedger(simulator, (_invocation, execution) => { if (execution === 1) throw new Error("remote adapter request state uncertain after dispatch timeout"); });
  assert.equal((await invoke(host, 3, "live_tempo_apply", args)).result.isError, true);
  const applied = (await invoke(host, 4, "live_tempo_apply", args)).result;
  assert.equal(applied.structuredContent.state, "applied");
  assert.deepEqual(applied.structuredContent, JSON.parse(applied.content[0].text));
  assert.equal(ledger.executions, 1); assert.equal(ledger.replays, 1);
  assert.deepEqual(ledger.calls[0]!.invocation, ledger.calls[1]!.invocation);
  const replay = (await invoke(host, 4, "live_tempo_apply", args)).result;
  assert.equal(replay.structuredContent.idempotent, true);
  assert.deepEqual(replay.structuredContent, JSON.parse(replay.content[0].text));
  const undone = await invoke(host, 5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "modern-undo-key" });
  assert.equal(undone.result.structuredContent.state, "undone");
  assert.equal(simulator.snapshot().set.tempo, preview.priorTempo ?? 120);
});

test("modern coalesced mutation responses keep structured replay flags consistent", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  const preview = (await invoke(host, 1, "live_tempo_preview", { tempo: 132 })).result.structuredContent;
  const ledger = installExecutionLedger(simulator);
  const args = { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "modern-coalesced-key" };
  const frames = await Promise.all([invoke(host, 2, "live_tempo_apply", args), invoke(host, 3, "live_tempo_apply", args)]);
  assert.equal(ledger.executions, 1);
  assert.deepEqual(frames.map((frame) => frame.result.structuredContent.idempotent).sort(), [false, true]);
  for (const frame of frames) assert.deepEqual(frame.result.structuredContent, JSON.parse(frame.result.content[0].text));
  const before = host.handle(modern(4, "tools/list")) as any;
  host.setToolPolicy({ profile: "read-only" });
  const after = host.handle(modern(5, "tools/list")) as any;
  assert.ok(before.result.tools.some((tool: any) => tool.name === "live_tempo_apply"));
  assert.equal(after.result.tools.some((tool: any) => tool.name === "live_tempo_apply"), false);
  assert.equal(after.result.ttlMs, 0);
});

test("modern duplicate in-flight IDs are rejected, then reusable after completion", async () => {
  const simulator = new DeterministicLiveSimulator();
  const original = simulator.snapshotAsync.bind(simulator);
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { started = resolve; });
  simulator.snapshotAsync = async () => { started(); await gate; return original(); };
  const host = new McpHost(simulator);
  const first = invoke(host, "same-id", "live_snapshot", {});
  await entry;
  assert.equal((await invoke(host, "same-id", "live_snapshot", {})).error.code, -32600);
  release(); assert.equal((await first).result.isError, false);
  assert.equal((await invoke(host, "same-id", "live_snapshot", {})).result.isError, false);
});

test("modern discovery and capabilities exclude unbound push, never weaken policy or emit unsolicited Live events", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator, { toolPolicy: { profile: "read-only" } });
  const emitted: string[] = []; host.setEventEmitter(async (message) => { emitted.push(message); });
  const listed = host.handle(modern(1, "tools/list")) as any;
  assert.equal(listed.result.tools.some((tool: any) => tool.name === "live_subscribe"), false);
  const capabilities = (await invoke(host, 2, "capabilities", {})).result.structuredContent;
  assert.equal(capabilities.tools.visible.includes("live_subscribe"), false);
  assert.equal((await invoke(host, 3, "live_subscribe", { types: ["state"] })).error.code, -32602);
  const denied = await host.handleAsync(modern(4, "tools/call", { name: "live_tempo_apply", arguments: { transactionId: "no-authority", confirmation: "apply", idempotencyKey: "no-authority-key" } }, { [capabilitiesKey]: { experimental: { consent: { approved: true, confidence: 1 } } } })) as any;
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.reason, "tool-denied-by-deployment-policy");
  simulator.simulateExternalEdit(simulator.snapshot().set.ref, "tempo", 125);
  await tick(); assert.deepEqual(emitted, []);
  assert.equal((await host.handleAsync(modern(5, "resources/read", { uri: "absent://resource" })) as any).error.code, -32602);
  assert.equal((await host.handleAsync(modern(6, "subscriptions/listen")) as any).error.code, -32601);
});

test("modern stdio emits valid results without an initialize handshake", async () => {
  const input = new PassThrough(); const output = new PassThrough(); const diagnostics = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += String(chunk); });
  const run = serve(input, output, diagnostics);
  input.end(`${JSON.stringify(modern(1, "server/discover"))}\n${JSON.stringify(modern(2, "tools/call", { name: "server_status", arguments: {} }))}\n`);
  await run;
  const frames = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames.length, 2); assert.equal(frames[0].result.resultType, "complete");
  assert.equal(frames[1].result.structuredContent.host, "ready");
});

test("stdio cancellation suppresses a completed response queued behind an earlier request", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = "";
  output.on("data", (chunk) => { text += String(chunk); });
  let release!: () => void; let completed!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const second = new Promise<void>((resolve) => { completed = resolve; });
  const run = serveStdio(input, output, async (line) => {
    const frame = JSON.parse(line); if (frame.id === 1) await gate;
    if (frame.id === 2) completed();
    return JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} });
  });
  input.write(`${JSON.stringify(modern(1, "ping"))}\n${JSON.stringify(modern(2, "ping"))}\n`);
  await second; await tick();
  input.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "no longer needed", _meta: {} } })}\n`);
  await tick(); release(); await run;
  assert.deepEqual(text.trim().split("\n").map((line) => JSON.parse(line).id), [1]);
});

test("stdio ignores malformed cancellation and suppresses post-cancel rejection replies", async () => {
  for (const malformed of [false, true]) {
    const input = new PassThrough(); const output = new PassThrough(); let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    let started!: () => void; let release!: () => void; let observed: AbortSignal | undefined;
    const entry = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = serveStdio(input, output, async (line, context) => {
      if (JSON.parse(line).id === undefined) return null;
      observed = context?.signal; started(); await gate;
      if (context?.signal.aborted) throw new Error("cancelled worker rejection");
      return JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    });
    input.write(`${JSON.stringify(modern(1, "ping"))}\n`); await entry;
    input.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: malformed ? 42 : "cancel" } })}\n`);
    await tick(); assert.equal(observed!.aborted, !malformed); release(); await run;
    assert.equal(text.length === 0, !malformed);
  }
});
