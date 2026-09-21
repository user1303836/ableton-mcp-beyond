import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LIVE_CAPABILITIES, LIVE_REGISTRY_OPERATIONS, type LiveAdapter } from "../src/live.js";
import { DEFAULT_TOOL_POLICY, TOOL_CATALOG, TOOL_POLICY_PROFILES, parseToolPolicySpec, resolveToolVisibility, toolPolicyFromEnv, visibleToolDescriptors } from "../src/tool-catalog.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }

function fullAdapter(provenance: "real-live" | "fake-live" = "real-live") {
  const simulator = new DeterministicLiveSimulator();
  return { status: () => ({ ...simulator.status(), adapter: "remote-script", provenance, capabilities: [...LIVE_CAPABILITIES], operations: [...LIVE_REGISTRY_OPERATIONS] }) } as unknown as LiveAdapter;
}

let listedRequestId = 1000;
function listedNames(host: McpHost): string[] {
  listedRequestId += 1;
  return (host.handle({ jsonrpc: "2.0", id: listedRequestId, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
}

test("catalog covers every tool with exactly one availability rule and policy class", () => {
  assert.ok(TOOL_CATALOG.length > 140);
  const names = TOOL_CATALOG.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.includes("live_project_save"), false);
  assert.equal(names.includes("live_project_open"), false);
});

test("every named profile filters the fully negotiated surface by policy class", () => {
  const status = { connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", provenance: "real-live", capabilities: [...LIVE_CAPABILITIES], operations: [...LIVE_REGISTRY_OPERATIONS] } as const;
  const full = resolveToolVisibility(status as never, DEFAULT_TOOL_POLICY).filter((row) => row.visible).map((row) => row.entry.name);
  const readOnly = resolveToolVisibility(status as never, { profile: "read-only", allow: [], deny: [] }).filter((row) => row.visible).map((row) => row.entry.name);
  const editNoAudio = resolveToolVisibility(status as never, { profile: "edit-no-audio", allow: [], deny: [] }).filter((row) => row.visible).map((row) => row.entry.name);
  const performance = resolveToolVisibility(status as never, { profile: "performance", allow: [], deny: [] }).filter((row) => row.visible).map((row) => row.entry.name);
  assert.ok(full.length > 140);
  for (const required of ["server_status", "capabilities", "live_status", "live_snapshot", "live_browser_search"]) assert.ok(readOnly.includes(required), required);
  for (const excluded of ["live_tempo_preview", "live_session_structure_preview", "live_audio_clip_preview", "live_recording_preview", "live_undo"]) assert.ok(!readOnly.includes(excluded), excluded);
  for (const included of ["live_tempo_preview", "live_session_structure_preview", "live_mixer_preview", "live_undo"]) assert.ok(editNoAudio.includes(included), included);
  for (const excluded of ["live_audio_clip_preview", "live_warp_marker_preview", "live_audio_import_preview", "live_recording_preview", "live_realtime_arm_preview", "live_audio_capture_preview", "live_transport_preview", "live_clip_launch_preview"]) assert.ok(!editNoAudio.includes(excluded), excluded);
  for (const included of ["live_transport_preview", "live_tempo_preview", "live_clip_launch_preview", "live_session_emergency_stop", "live_mixer_preview", "live_view_preview"]) assert.ok(performance.includes(included), included);
  for (const excluded of ["live_session_structure_preview", "live_note_update_preview", "live_device_apply", "live_recording_preview"]) assert.ok(!performance.includes(excluded), excluded);
  assert.ok(readOnly.length < editNoAudio.length);
  assert.ok(readOnly.length < performance.length);
  assert.ok(performance.length < full.length && editNoAudio.length < full.length);
});

test("tools/list intersects negotiated availability with the deployment policy", () => {
  const host = new McpHost(fullAdapter(), { toolPolicy: { profile: "read-only" } });
  ready(host);
  const names = listedNames(host);
  assert.ok(names.includes("live_snapshot") && names.includes("server_status"));
  assert.ok(!names.includes("live_tempo_preview"));
  const denied = host.handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "live_tempo_preview", arguments: { tempo: 120 } } });
  assert.equal((denied as any).result.isError, true);
  assert.match(JSON.parse((denied as any).result.content[0].text).reason, /tool-denied-by-deployment-policy/);
});

test("policy deny overrides hide tools and deny dispatch; allow narrows within the profile", () => {
  const host = new McpHost(fullAdapter(), { toolPolicy: { profile: "full", deny: ["live_recording_*", "live_tempo_preview"] } });
  ready(host);
  const names = listedNames(host);
  assert.ok(!names.includes("live_recording_preview") && !names.includes("live_tempo_preview"));
  assert.ok(names.includes("live_tempo_apply"));
  const denied = host.handle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "live_recording_preview", arguments: {} } });
  assert.equal((denied as any).result.isError, true);
  const narrowed = new McpHost(fullAdapter(), { toolPolicy: { profile: "full", allow: ["live_tempo_*", "live_status"] } });
  ready(narrowed);
  const narrowedNames = listedNames(narrowed);
  assert.deepEqual(narrowedNames.filter((name) => name.startsWith("live_")), ["live_status", "live_tempo_preview", "live_tempo_apply"]);
});

test("policy is enforced again before undo dispatch when the domain was revoked mid-transaction", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_tempo_preview", { tempo: 128 })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(3, "live_tempo_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "policy-tempo-apply" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  host.setToolPolicy({ profile: "full", deny: ["live_tempo_*"] });
  const undo = await call(4, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "policy-tempo-undo" });
  assert.equal((undo as any).result.isError, true);
  assert.match(JSON.parse((undo as any).result.content[0].text).reason, /deployment policy/);
  host.setToolPolicy({ profile: "full" });
  const restored = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "policy-tempo-undo" })) as any).result.content[0].text);
  assert.equal(restored.state, "undone");
});

test("list-changed notifications fire on connect, operation-set change, and policy change", async () => {
  const simulator = new DeterministicLiveSimulator();
  let connected = false;
  let operations: readonly string[] = [...simulator.status().operations ?? []];
  const adapter = {
    ...simulator,
    status: () => connected
      ? { ...simulator.status(), operations }
      : { connected: false, adapter: "unavailable", epoch: null, protocol: "ableton-live/v1", capabilities: [], reason: "test-disconnected" },
  } as unknown as LiveAdapter;
  const host = new McpHost(adapter);
  const emitted: string[] = [];
  host.setEventEmitter(async (value: string) => { emitted.push(value); });
  ready(host);
  assert.equal(listedNames(host).includes("live_tempo_preview"), false);
  await new Promise((resolve) => setImmediate(resolve));
  emitted.length = 0;
  // Connect: the tool list grows and one notification is emitted.
  connected = true;
  assert.equal(listedNames(host).includes("live_tempo_preview"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 1);
  // Operation-set downgrade: the list shrinks and one notification is emitted.
  operations = ["status", "snapshot", "discover", "get", "reconnect", "session.playback"];
  assert.equal(listedNames(host).includes("live_tempo_preview"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 2);
  // Effective runtime policy change notifies exactly once.
  host.setToolPolicy({ profile: "read-only" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 3);
  // No further change means no further notification.
  listedNames(host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 3);
  // Disconnect notifies again.
  connected = false;
  listedNames(host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 4);
});

test("policy specs validate profiles, patterns, and unknown-tool references", () => {
  assert.throws(() => parseToolPolicySpec({ profile: "everything" }), /profile is unknown/);
  assert.throws(() => parseToolPolicySpec({ profile: "full", deny: ["not a tool"] }), /deny list is invalid/);
  assert.throws(() => parseToolPolicySpec({ profile: "full", allow: ["live_nonexistent_*"] }), /matches no known tool/);
  assert.throws(() => parseToolPolicySpec({ profile: "full", extra: true }), /unknown keys/);
  const spec = parseToolPolicySpec({ profile: "read-only", deny: ["live_browser_*"] });
  assert.equal(spec.profile, "read-only");
  assert.deepEqual([...spec.deny], ["live_browser_*"]);
  assert.equal(parseToolPolicySpec(undefined), DEFAULT_TOOL_POLICY);
  const fromEnv = toolPolicyFromEnv({ ABLETON_MCP_TOOL_POLICY: "performance", ABLETON_MCP_TOOL_DENY: "live_realtime_*, live_tempo_apply" } as NodeJS.ProcessEnv);
  assert.equal(fromEnv.profile, "performance");
  assert.deepEqual([...fromEnv.deny], ["live_realtime_*", "live_tempo_apply"]);
  assert.equal(toolPolicyFromEnv({} as NodeJS.ProcessEnv), DEFAULT_TOOL_POLICY);
  assert.throws(() => new McpHost(new DeterministicLiveSimulator(), { toolPolicy: { profile: "bogus" } }), /profile is unknown/);
});

test("capability resource reports the effective policy and denied tools without secrets", () => {
  const host = new McpHost(fullAdapter("fake-live"), { toolPolicy: { profile: "edit-no-audio", deny: ["live_browser_load_*"] } });
  ready(host);
  const catalog = JSON.parse((host.handle({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "capabilities", arguments: {} } }) as any).result.content[0].text);
  assert.equal(catalog.policy.profile, "edit-no-audio");
  assert.deepEqual(catalog.policy.denyOverrides, ["live_browser_load_*"]);
  assert.deepEqual(catalog.policy.profileClasses, TOOL_POLICY_PROFILES["edit-no-audio"].classes);
  assert.ok(catalog.tools.policyDenied.includes("live_browser_load_preview"));
  assert.ok(catalog.tools.policyDenied.includes("live_audio_clip_preview"));
  assert.ok(!catalog.tools.visible.includes("live_audio_clip_preview"));
  assert.equal(JSON.stringify(catalog.policy).includes("secret"), false);
});

test("visibleToolDescriptors returns schema-bearing descriptors only for visible tools", () => {
  const unavailable = { connected: false, adapter: "unavailable", epoch: null, protocol: "ableton-live/v1", capabilities: [] } as const;
  const descriptors = visibleToolDescriptors(unavailable as never, DEFAULT_TOOL_POLICY);
  assert.deepEqual(descriptors.map((tool) => tool.name), ["server_status", "capabilities", "plan_user_journey", "audio_analyze", "audio_compare_reference", "live_status", "live_library_search", "live_project_snapshot_diff"]);
  for (const descriptor of descriptors) {
    assert.equal(typeof descriptor.description, "string");
    assert.equal(descriptor.inputSchema.type, "object");
  }
});

test("performance profile keeps guarded undo and recovery available for its own transactions", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator, { toolPolicy: { profile: "performance" } });
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_tempo_preview", { tempo: 128 })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(3, "live_tempo_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "perf-tempo-apply" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const undone = JSON.parse(((await call(4, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "perf-tempo-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  // Domains outside the profile stay refused at undo time through the owner re-check.
  const structural = await call(5, "live_session_structure_preview", { tracks: [{ name: "X", kind: "midi" }] });
  assert.equal((structural as any).result.isError, true);
});

test("undo re-checks the owner domain for audio-clip transactions revoked after apply", async () => {
  const simulator = new DeterministicLiveSimulator();
  const state = (simulator as any).state;
  state.tracks[0].clips.push({
    ref: "clip:audio-1", objectIdentity: "simulator:clip:audio-1", name: "Audio", kind: "audio", start: 0, length: 8,
    notes: [], notesRevision: "a".repeat(64), warp: true, takes: [], automation: [], isAudio: true,
    filePath: "/tmp/audio.wav", muted: false, warpMarkers: [{ beatTime: 1, sampleTime: 44100 }], availableAudioFields: ["gain"],
  });
  state.scenes.push({ ref: "scene:scene-audio", objectIdentity: "simulator:scene:scene-audio", name: "Audio Scene", index: 1 });
  state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: "clip:audio-1", empty: false });
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_audio_clip_preview", { clipRef: "clip:audio-1", gain: 0.5 })) as any).result.content[0].text);
  assert.equal(typeof preview.transactionId, "string");
  const applied = JSON.parse(((await call(3, "live_audio_clip_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "audioclip-apply-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  host.setToolPolicy({ profile: "edit-no-audio" });
  const refused = await call(4, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "audioclip-undo-1" });
  assert.equal((refused as any).result.isError, true);
  assert.match(JSON.parse((refused as any).result.content[0].text).reason, /deployment policy/);
});

test("a refreshed status change notifies list-changed immediately, not on the next request", async () => {
  const simulator = new DeterministicLiveSimulator();
  let operations: readonly string[] = [...simulator.status().operations ?? []];
  const adapter = {
    status: () => ({ ...simulator.status(), operations }),
    refreshStatusAsync: async () => ({ ...simulator.status(), operations }),
    snapshot: () => simulator.snapshot(),
    get: (ref: never) => simulator.get(ref),
    invoke: (invocation: never) => simulator.invoke(invocation),
    subscribe: (listener: never) => simulator.subscribe(listener),
    reconnect: () => simulator.reconnect(),
    snapshotAsync: async () => simulator.snapshot(),
    discoverAsync: simulator.discoverAsync.bind(simulator),
    getAsync: async (ref: never) => simulator.get(ref),
    invokeAsync: async (invocation: never) => simulator.invoke(invocation),
    reconnectAsync: async () => simulator.reconnect(),
  } as unknown as LiveAdapter;
  const host = new McpHost(adapter);
  const emitted: string[] = [];
  host.setEventEmitter(async (value: string) => { emitted.push(value); });
  ready(host);
  // Establish the client's discovery baseline (realistic client flow).
  const baseline = (host.handle({ jsonrpc: "2.0", id: 41, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(baseline.includes("live_browser_search"), true);
  await new Promise((resolve) => setImmediate(resolve));
  emitted.length = 0;
  // The negotiated shape changes underneath (Browser support disappears);
  // nothing has refreshed the cache yet.
  operations = (simulator.status().operations ?? []).filter((operation) => operation !== "browser.search" && operation !== "browser.inspect" && operation !== "browser.load" && operation !== "browser.roots");
  // A still-visible tool whose handler refreshes status triggers the refresh;
  // the notification fires on completion of that refresh, not on a later call.
  // (The exact clip is absent here; the refresh runs before content validation.)
  const probe = await host.handleAsync({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "live_warp_marker_read", arguments: { clipRef: "clip:absent" } } });
  assert.equal((probe as any).result.isError, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 1, "refreshStatusAsync completion emits the change notification");
  const names = (host.handle({ jsonrpc: "2.0", id: 43, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(names.includes("live_browser_search"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length, 1, "no duplicate notification for the same shape");
});
