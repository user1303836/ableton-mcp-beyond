import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION, serve } from "../src/host.js";
import { DeterministicLiveSimulator, type LiveAdapter } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }

test("requires initialization and exposes only read-only tools", () => {
  const host = new McpHost();
  assert.equal((host.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as any).error.code, -32002);
  assert.equal((host.handle({ ...initialize, id: 2 }) as any).result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(host.handle(initialized), null);
  const tools = (host.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["server_status", "capabilities", "audio_analyze", "live_status", "live_snapshot", "live_discover", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo"]);
});

test("advertises and serves static safety resources and a complete audio workflow prompt", () => {
  const host = new McpHost();
  ready(host);
  const init = host.handle({ ...initialize, id: 99 });
  assert.equal((init as any).error.code, -32600);
  const resources = host.handle({ jsonrpc: "2.0", id: 30, method: "resources/list", params: {} });
  assert.deepEqual((resources as any).result.resources.map((resource: { uri: string }) => resource.uri), ["ableton://capabilities", "ableton://safety", "ableton://live-workflow"]);
  const safety = host.handle({ jsonrpc: "2.0", id: 31, method: "resources/read", params: { uri: "ableton://safety" } });
  assert.match((safety as any).result.contents[0].text, /does not connect to Ableton Live/);
  assert.match((safety as any).result.contents[0].text, /explicit project mutations/);
  const prompts = host.handle({ jsonrpc: "2.0", id: 32, method: "prompts/list" });
  assert.equal((prompts as any).result.prompts[0].name, "analyze_audio");
  const prompt = host.handle({ jsonrpc: "2.0", id: 33, method: "prompts/get", params: { name: "analyze_audio", arguments: { sampleRate: "44100" } } });
  assert.match((prompt as any).result.messages[0].content.text, /sampleRate=44100/);
  const workflowPrompt = host.handle({ jsonrpc: "2.0", id: 37, method: "prompts/get", params: { name: "change_tempo_safely" } });
  assert.match((workflowPrompt as any).result.messages[0].content.text, /live_tempo_preview/);
});

test("rejects unknown resources, prompts, and extension fields", () => {
  const host = new McpHost();
  ready(host);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 34, method: "resources/read", params: { uri: "ableton://secret" } }) as any).error.code, -32002);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 35, method: "prompts/get", params: { name: "analyze_audio", extra: true } }) as any).error.code, -32602);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 36, method: "resources/list", params: { cursor: "x" } }) as any).error.code, -32602);
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
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.length, 13);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).error.message, "Duplicate request identifier");
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set", arguments: {} } }) as any).error.code, -32601);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 4, method: "tools/list", debug: true }) as any).error.code, -32600);
});

test("accepts cancellation notifications without manufacturing a response", () => {
  const host = new McpHost();
  ready(host);
  assert.equal(host.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }), null);
});

test("completes a simulator tempo preview, confirmed apply, verification, and conflict-aware undo", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const status = host.handle({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "live_status", arguments: {} } });
  assert.equal(JSON.parse((status as any).result.content[0].text).adapter, "simulator");
  const initial = host.handle({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "live_snapshot", arguments: {} } });
  assert.equal(JSON.parse((initial as any).result.content[0].text).snapshot.set.tempo, 120);
  const preview = host.handle({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "live_tempo_preview", arguments: { tempo: 128 } } });
  const previewValue = JSON.parse((preview as any).result.content[0].text) as { transactionId: string; priorTempo: number; proposedTempo: number };
  assert.equal(previewValue.priorTempo, 120);
  assert.equal(previewValue.proposedTempo, 128);
  assert.equal(simulator.snapshot().set.tempo, 120);
  const missingConfirmation = host.handle({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: previewValue.transactionId, confirmation: "no", idempotencyKey: "apply-1" } } });
  assert.equal((missingConfirmation as any).error.code, -32602);
  const applied = host.handle({ jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: previewValue.transactionId, confirmation: "apply", idempotencyKey: "apply-1" } } });
  assert.equal(JSON.parse((applied as any).result.content[0].text).tempo, 128);
  const repeated = host.handle({ jsonrpc: "2.0", id: 45, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: previewValue.transactionId, confirmation: "apply", idempotencyKey: "apply-1" } } });
  assert.equal(JSON.parse((repeated as any).result.content[0].text).idempotent, true);
  simulator.set("set:set-1", "tempo", 130);
  const conflictedUndo = host.handle({ jsonrpc: "2.0", id: 46, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: previewValue.transactionId, confirmation: "undo", idempotencyKey: "undo-1" } } });
  assert.equal((conflictedUndo as any).result.isError, true);
  assert.equal(simulator.snapshot().set.tempo, 130);
});

test("routes configured adapter calls through the asynchronous host boundary", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const snapshot = await host.handleAsync({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "live_snapshot", arguments: {} } });
  assert.equal((snapshot as any).result.isError, false);
  assert.equal(JSON.parse((snapshot as any).result.content[0].text).snapshot.set.name, "Simulator Set");
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "live_tempo_preview", arguments: { tempo: 126 } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "async-apply" } } });
  assert.equal(JSON.parse((applied as any).result.content[0].text).tempo, 126);
  assert.equal(simulator.snapshot().set.tempo, 126);
});

test("routes Arrangement locator transactions through the asynchronous host boundary", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "live_arrangement_section_preview", arguments: { start: 4, end: 8, startName: "Async Verse", endName: "Async Chorus" } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 78, method: "tools/call", params: { name: "live_arrangement_section_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "async-arrangement-apply" } } });
  assert.equal(JSON.parse((applied as any).result.content[0].text).locators.length, 2);
  const undone = await host.handleAsync({ jsonrpc: "2.0", id: 79, method: "tools/call", params: { name: "live_undo", arguments: { transactionId, confirmation: "undo", idempotencyKey: "async-arrangement-undo" } } });
  assert.equal(JSON.parse((undone as any).result.content[0].text).state, "undone");
  assert.deepEqual(simulator.snapshot().arrangement.locators.map(({ name, position }) => ({ name, position })), [{ name: "Intro", position: 0 }]);
});

test("creates and guardedly removes Arrangement section locators", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = host.handle({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: "live_arrangement_section_preview", arguments: { start: 4, end: 8, startName: "Verse", endName: "Chorus" } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  const applied = host.handle({ jsonrpc: "2.0", id: 74, method: "tools/call", params: { name: "live_arrangement_section_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "arrangement-apply" } } });
  assert.equal(JSON.parse((applied as any).result.content[0].text).locators.length, 2);
  const repeated = host.handle({ jsonrpc: "2.0", id: 75, method: "tools/call", params: { name: "live_arrangement_section_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "arrangement-apply" } } });
  assert.equal(JSON.parse((repeated as any).result.content[0].text).idempotent, true);
  const conflicting = host.handle({ jsonrpc: "2.0", id: 751, method: "tools/call", params: { name: "live_arrangement_section_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "different-key" } } });
  assert.equal((conflicting as any).result.isError, true);
  assert.match(JSON.parse((conflicting as any).result.content[0].text).reason, /idempotency key conflicts/);
  const undone = host.handle({ jsonrpc: "2.0", id: 76, method: "tools/call", params: { name: "live_undo", arguments: { transactionId, confirmation: "undo", idempotencyKey: "arrangement-undo" } } });
  assert.equal(JSON.parse((undone as any).result.content[0].text).state, "undone");
  assert.deepEqual(simulator.snapshot().arrangement.locators.map(({ name, position }) => ({ name, position })), [{ name: "Intro", position: 0 }]);
});

test("completes bounded Session MIDI discovery, preview, idempotent apply, verification, and guarded undo", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const track = simulator.snapshot().tracks[0]!;
  const discovered = host.handle({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "live_discover", arguments: { kind: "track", limit: 10 } } });
  assert.equal(JSON.parse((discovered as any).result.content[0].text).items[0].ref, track.ref);
  const preview = host.handle({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "live_midi_clip_preview", arguments: { trackRef: track.ref, sceneIndex: 1, name: "Four Bar Drums", length: 4, notes: [
    { pitch: 36, start: 0, duration: 0.25, velocity: 110, channel: 1 },
    { pitch: 38, start: 2, duration: 0.25, velocity: 100, channel: 1 },
    { pitch: 42, start: 0.5, duration: 0.1, velocity: 80, channel: 1 },
  ] } } });
  const transaction = JSON.parse((preview as any).result.content[0].text) as { transactionId: string };
  assert.equal(simulator.snapshot().tracks[0]!.clips.length, 1);
  const applied = host.handle({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "live_midi_clip_apply", arguments: { transactionId: transaction.transactionId, confirmation: "apply", idempotencyKey: "midi-apply-1" } } });
  const appliedValue = JSON.parse((applied as any).result.content[0].text) as { clipRef: string; notes: unknown[] };
  assert.equal(appliedValue.notes.length, 3);
  const repeated = host.handle({ jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "live_midi_clip_apply", arguments: { transactionId: transaction.transactionId, confirmation: "apply", idempotencyKey: "midi-apply-1" } } });
  assert.equal(JSON.parse((repeated as any).result.content[0].text).idempotent, true);
  const clip = simulator.get(appliedValue.clipRef as any) as { notes: unknown[] };
  assert.equal(clip.notes.length, 3);
  const undone = host.handle({ jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: transaction.transactionId, confirmation: "undo", idempotencyKey: "midi-undo-1" } } });
  assert.equal(JSON.parse((undone as any).result.content[0].text).state, "undone");
  assert.equal(simulator.snapshot().tracks[0]!.clips.length, 1);
});

test("keeps new Live tools fail-closed with the default unavailable adapter", () => {
  const host = new McpHost();
  ready(host);
  for (const [id, name] of [[50, "live_snapshot"], [51, "live_tempo_preview"]] as const) {
    const result = host.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: name === "live_tempo_preview" ? { tempo: 128 } : {} } });
    assert.equal((result as any).result.isError, true);
  }
  const catalog = JSON.parse((host.handle({ jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "capabilities", arguments: {} } }) as any).result.content[0].text);
  assert.equal(catalog.live.connected, false);
  assert.equal(catalog.implemented.includes("live.tempo.apply"), false);
});

test("fails closed when an adapter cannot report status", () => {
  const brokenAdapter = {
    status(): never { throw new Error("adapter process unavailable"); },
  } as unknown as LiveAdapter;
  const host = new McpHost(brokenAdapter);
  ready(host);
  const status = host.handle({ jsonrpc: "2.0", id: 53, method: "tools/call", params: { name: "server_status", arguments: {} } });
  const statusValue = JSON.parse((status as any).result.content[0].text) as { live: { connected: boolean; reason: string } };
  assert.equal(statusValue.live.connected, false);
  assert.equal(statusValue.live.reason, "live-adapter-status-unavailable");
  const capabilities = host.handle({ jsonrpc: "2.0", id: 54, method: "tools/call", params: { name: "capabilities", arguments: {} } });
  assert.equal(JSON.parse((capabilities as any).result.content[0].text).live.connected, false);
  const snapshot = host.handle({ jsonrpc: "2.0", id: 55, method: "tools/call", params: { name: "live_snapshot", arguments: {} } });
  assert.equal((snapshot as any).result.isError, true);
});

test("rejects expired tempo confirmation and validates negotiated adapter status", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = host.handle({ jsonrpc: "2.0", id: 56, method: "tools/call", params: { name: "live_tempo_preview", arguments: { tempo: 130 } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  const originalNow = Date.now;
  const expiry = JSON.parse((preview as any).result.content[0].text).expiresAt as number;
  Date.now = () => expiry + 1;
  try {
    const result = host.handle({ jsonrpc: "2.0", id: 57, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "expired" } } });
    assert.equal((result as any).result.isError, true);
    assert.equal(simulator.snapshot().set.tempo, 120);
  } finally { Date.now = originalNow; }
  const invalid = new McpHost({ ...simulator, status: () => ({ connected: true, adapter: "simulator", epoch: 1, protocol: "wrong", capabilities: [] }) } as any);
  ready(invalid);
  const status = invalid.handle({ jsonrpc: "2.0", id: 58, method: "tools/call", params: { name: "live_status", arguments: {} } });
  assert.equal(JSON.parse((status as any).result.content[0].text).connected, false);
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

test("rejects audio schema values before decoding or consuming the rate limit", () => {
  const host = new McpHost();
  ready(host);
  const base = { pcmBase64: Buffer.alloc(4).toString("base64"), sampleRate: 44100 };
  for (const [id, args] of [
    [2, { ...base, sampleRate: 44100.5 }],
    [3, { ...base, sampleRate: 7999 }],
    [4, { ...base, channels: 0 }],
    [5, { ...base, frameSize: 4097 }],
  ] as const) {
    const result = host.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "audio_analyze", arguments: args } });
    assert.equal((result as any).error.code, -32602);
  }
  const result = host.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "audio_analyze", arguments: base } });
  assert.equal((result as any).result.isError, false);
});

test("rejects legacy shutdown and cancellation requests", () => {
  const host = new McpHost();
  ready(host);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" }) as any).error.code, -32601);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "$/cancelRequest", params: { requestId: 1 } }) as any).error.code, -32601);
  assert.equal(host.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
});
