import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION, serve } from "../src/host.js";
import { DeterministicLiveSimulator, LIVE_CAPABILITIES, LIVE_REGISTRY_OPERATIONS, type LiveAdapter, type LiveInvocation, type LiveRef } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }

test("requires initialization and exposes only executable, policy-allowed tools", () => {
  const host = new McpHost();
  assert.equal((host.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as any).error.code, -32002);
  const initializedResponse = (host.handle({ ...initialize, id: 2 }) as any).result;
  assert.equal(initializedResponse.protocolVersion, PROTOCOL_VERSION);
  assert.equal(initializedResponse.capabilities.tools.listChanged, true);
  const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(initializedResponse.serverInfo.version, packageMetadata.version);
  assert.equal(host.handle(initialized), null);
  // Disconnected (fail-closed default): only local and always-on read tools are listed.
  const tools = (host.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["server_status", "capabilities", "plan_user_journey", "audio_analyze", "audio_compare_reference", "live_status", "live_project_snapshot_diff"]);
  // Negotiation placeholders are never callable discovery.
  for (const placeholder of ["live_project_save", "live_project_open"]) {
    assert.equal(tools.some((tool: { name: string }) => tool.name === placeholder), false);
    const call = host.handle({ jsonrpc: "2.0", id: `placeholder-${placeholder}`, method: "tools/call", params: { name: placeholder, arguments: {} } });
    assert.equal((call as any).error.code, -32601);
  }
  const capabilitiesResource = (host.handle({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ableton://capabilities" } }) as any).result.contents[0].text;
  const catalog = JSON.parse(capabilitiesResource);
  assert.deepEqual(catalog.limitations.map((limitation: { operation: string }) => limitation.operation).sort(), ["open/new/export/collect/bounce", "save"]);
  assert.equal(catalog.policy.profile, "full");

  const simulatorHost = new McpHost(new DeterministicLiveSimulator());
  simulatorHost.handle(initialize); simulatorHost.handle(initialized);
  const simulatorTools = (simulatorHost.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools;
  const simulatorToolNames = simulatorTools.map((tool: { name: string }) => tool.name);
  assert.ok(simulatorToolNames.includes("live_tempo_preview") && simulatorToolNames.includes("live_browser_search") && simulatorToolNames.includes("live_undo"));
  assert.equal(simulatorToolNames.includes("live_realtime_arm_preview"), false);
  assert.equal(simulatorToolNames.includes("live_audio_capture_preview"), false);
  const auditionPreview = simulatorTools.find((tool: { name: string }) => tool.name === "live_session_audition_preview");
  assert.deepEqual(auditionPreview.inputSchema.properties.outputSafety.required, ["safe", "provenance"]);
  const auditionStop = simulatorTools.find((tool: { name: string }) => tool.name === "live_session_audition_stop");
  assert.equal(auditionStop.inputSchema.properties.confirmation.minLength, 32);
  assert.equal(auditionStop.inputSchema.properties.confirmation.enum, undefined);
  const discovery = simulatorTools.find((tool: { name: string }) => tool.name === "live_discover");
  assert.deepEqual(discovery.inputSchema.properties.filter.additionalProperties.type, ["string", "number", "boolean", "null"]);
  assert.equal(discovery.inputSchema.properties.filter.additionalProperties.maxLength, 256);
  const structure = simulatorTools.find((tool: { name: string }) => tool.name === "live_session_structure_preview");
  assert.deepEqual(structure.inputSchema.properties.tracks.items.required, ["name", "kind"]);
  assert.deepEqual(structure.inputSchema.properties.scenes.items.required, ["name"]);
  const midi = simulatorTools.find((tool: { name: string }) => tool.name === "live_midi_clip_preview");
  assert.deepEqual(midi.inputSchema.properties.notes.items.required, ["pitch", "start", "duration", "velocity", "channel"]);
  const semanticExport = simulatorTools.find((tool: { name: string }) => tool.name === "live_project_snapshot_export");
  assert.deepEqual(Object.keys(semanticExport.inputSchema.properties), ["profile", "limit", "cursor"]);
  const semanticDiff = simulatorTools.find((tool: { name: string }) => tool.name === "live_project_snapshot_diff");
  assert.deepEqual(semanticDiff.inputSchema.required, ["beforePages", "afterPages"]);
  assert.equal(/confirmation|token|authority|transaction|idempotency/i.test(JSON.stringify([semanticExport.inputSchema, semanticDiff.inputSchema])), false);
});

function auditionFixture() {
  const base = new DeterministicLiveSimulator();
  const state = base.snapshot() as any;
  state.set = { ...state.set, name: "Disposable Set" };
  state.tracks = state.tracks.map((track: any) => ({ ...track, armed: false, monitoringState: "off", playingSlotIndex: null, firedSlotIndex: null, clipSlots: [{ ref: "clip-slot:track-1:0", parentRef: track.ref, objectIdentity: track.clipSlots[0].objectIdentity, sceneIndex: 0, clipRef: track.clips[0].ref, empty: false }] }));
  state.playback = { ref: "session-playback:one", epoch: 1, revision: "baseline", transport: { playing: false, arrangementRecord: false, sessionRecord: false, position: 0, launchQuantization: { raw: "1-bar", normalized: "1-bar" }, loop: { enabled: false, start: 0, length: 4 }, punchIn: false, punchOut: false, metronome: false, countIn: 1 }, firedTargets: [], playingTargets: [] };
  const counts = { launches: 0, stops: 0, emergencies: 0 };
  const target = () => ({ trackRef: state.tracks[0].ref, clipSlotRef: state.tracks[0].clipSlots[0].ref, sceneRef: "scene:scene-1", sceneIndex: 0, clipRef: state.tracks[0].clips[0].ref });
  const adapter = {
    status: () => ({ ...base.status(), operations: ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "transport.set", "session.audition-launch", "session.audition-stop", "session.emergency-stop"] }),
    snapshot: () => structuredClone(state), get: (ref) => base.get(ref),
    invoke: () => { throw new Error("synchronous invoke is unavailable"); },
    subscribe: () => () => undefined, reconnect: () => base.status(),
    getAsync: async (ref: LiveRef) => base.get(ref), reconnectAsync: async () => base.status(),
    snapshotAsync: async () => structuredClone(state),
    discoverAsync: async () => ({ epoch: 1, items: [], truncated: false, revision: "1:empty", kind: "track" }),
    invokeAsync: async (invocation) => {
      if (invocation.operation === "session.audition-launch") {
        counts.launches += 1;
        const args = invocation.args;
        if (args.ref !== "scene:scene-1" || args.setName !== "Disposable Set" || args.sceneName !== "Scene 1" || args.sceneIndex !== 0) throw new Error("mapper identity recheck failed");
        if (args.playbackRevision !== state.playback.revision) throw new Error("mapper playback revision recheck failed");
        if (!Array.isArray(args.eligibleTargets) || args.eligibleTargets.length !== 1 || args.eligibleTargets[0] !== `${state.tracks[0].ref}|${state.tracks[0].clipSlots[0].ref}|scene:scene-1`) throw new Error("mapper eligibility recheck failed");
        if (state.playback.transport.playing !== false || state.playback.firedTargets.length > 0 || state.playback.playingTargets.length > 0) throw new Error("mapper safety recheck failed");
        const active = target();
        state.playback.transport.playing = true; state.playback.firedTargets = [active]; state.playback.playingTargets = [active]; state.playback.revision = "launched";
        return { launched: args.ref, targets: [active] };
      }
      if (invocation.operation === "session.audition-stop") {
        counts.stops += 1;
        const active = [...state.playback.firedTargets, ...state.playback.playingTargets];
        if (active.some((item) => item.sceneRef !== invocation.args.ref)) throw new Error("mapper ownership recheck failed");
        state.playback.transport.playing = false; state.playback.firedTargets = []; state.playback.playingTargets = []; state.playback.revision = "stopped";
        return { stopped: true };
      }
      if (invocation.operation === "session.emergency-stop") {
        counts.emergencies += 1;
        const activeKeys = [...new Set([...state.playback.firedTargets, ...state.playback.playingTargets].map((item) => `${item.trackRef}|${item.clipSlotRef}|${item.sceneRef}`))];
        if (invocation.args.expectedRecording !== "stopped" || activeKeys.some((key) => !(invocation.args.expectedTargets as string[]).includes(key))) throw new Error("mapper emergency observation recheck failed");
        state.playback.transport.playing = false; state.playback.firedTargets = []; state.playback.playingTargets = []; state.playback.revision = "stopped";
        return { stopped: true, stoppedTargets: activeKeys };
      }
      if (invocation.operation === "transport.set") {
        const args = invocation.args;
        if (args.expectedRevision !== state.playback.revision) throw new Error("transport state changed since preview");
        const transport = state.playback.transport;
        if (typeof args.position === "number") transport.position = args.position;
        if (typeof args.loopEnabled === "boolean") transport.loop.enabled = args.loopEnabled;
        if (typeof args.loopStart === "number") transport.loop.start = args.loopStart;
        if (typeof args.loopLength === "number") transport.loop.length = args.loopLength;
        if (typeof args.metronome === "boolean") transport.metronome = args.metronome;
        if (typeof args.punchIn === "boolean") transport.punchIn = args.punchIn;
        if (typeof args.punchOut === "boolean") transport.punchOut = args.punchOut;
        state.playback.revision = `transport:${counts.launches}:${Math.random().toString(36).slice(2, 10)}`;
        return { changed: true, revision: state.playback.revision };
      }
      throw new Error("unexpected operation");
    },
  } as LiveAdapter & { snapshotAsync(): Promise<any>; invokeAsync(invocation: any): Promise<any> };
  return { base, state, counts, adapter };
}

test("guards Session audition with exact confirmation, one dispatch, replay, and one verified stop", async () => {
  const { state, counts, adapter } = auditionFixture();
  const host = new McpHost(adapter);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const previewResponse = await call(2, "live_session_audition_preview", { sceneRef: "scene:scene-1", setName: "Disposable Set", outputSafety: { safe: true, provenance: "operator-confirmed-headphones", scope: "master" } });
  const preview = JSON.parse((previewResponse as any).result.content[0].text);
  assert.equal((previewResponse as any).result.isError, false);
  assert.equal(state.set.playing, false);
  const appliedResponse = await call(3, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "audition-apply-1" });
  assert.equal((appliedResponse as any).result.isError, false);
  assert.equal(counts.launches, 1);
  const replay = await call(4, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "audition-apply-1" });
  assert.equal(JSON.parse((replay as any).result.content[0].text).idempotent, true);
  assert.equal(counts.launches, 1);
  const wrongStop = await call(5, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: "stop", idempotencyKey: "audition-stop-wrong" });
  assert.equal((wrongStop as any).result.isError, true);
  assert.equal(counts.stops, 0);
  state.playback.playingTargets = [...state.playback.playingTargets, { ...state.playback.playingTargets[0], sceneRef: "scene:external" }];
  const externalStop = await call(6, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "audition-stop-external" });
  assert.equal((externalStop as any).result.isError, true);
  assert.equal(counts.stops, 0);
  state.playback.playingTargets = [state.playback.playingTargets[0]];
  const stopped = await call(7, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "audition-stop-1" });
  assert.equal((stopped as any).result.isError, false);
  assert.equal(counts.stops, 1);
  assert.equal(state.set.playing, false);
});

test("concurrent duplicate audition applies dispatch exactly one launch and one replay result", async () => {
  const { counts, adapter } = auditionFixture();
  const host = new McpHost(adapter);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_session_audition_preview", { sceneRef: "scene:scene-1", setName: "Disposable Set", outputSafety: { safe: true, provenance: "operator-confirmed-headphones", scope: "master" } })) as any).result.content[0].text);
  const [first, second] = await Promise.all([
    call(3, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "audition-apply-1" }),
    call(4, "live_session_audition_apply", { idempotencyKey: "audition-apply-1", confirmation: preview.confirmation, transactionId: preview.transactionId }),
  ]);
  assert.equal(counts.launches, 1);
  const outcomes = [first, second].map((response) => JSON.parse((response as any).result.content[0].text));
  assert.deepEqual(outcomes.map((outcome) => outcome.idempotent).sort(), [false, true]);
  const conflicting = await call(5, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "audition-apply-other" });
  assert.equal((conflicting as any).result.isError, true);
  assert.equal(counts.launches, 1);
  const [stopOne, stopTwo] = await Promise.all([
    call(6, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "audition-stop-1" }),
    call(7, "live_session_audition_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "audition-stop-1" }),
  ]);
  assert.equal(counts.stops, 1);
  const stopOutcomes = [stopOne, stopTwo].map((response) => JSON.parse((response as any).result.content[0].text));
  assert.deepEqual(stopOutcomes.map((outcome) => outcome.idempotent).sort(), [false, true]);
});

test("emergency stop requires exact fresh observation and survives host restart", async () => {
  const { state, counts, adapter } = auditionFixture();
  const host = new McpHost(adapter);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_session_audition_preview", { sceneRef: "scene:scene-1", setName: "Disposable Set", outputSafety: { safe: true, provenance: "operator-confirmed-headphones", scope: "master" } })) as any).result.content[0].text);
  await call(3, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "audition-apply-1" });
  assert.equal(counts.launches, 1);
  const wrongLiteral = await call(4, "live_session_emergency_stop", { confirmation: "stop", expectedTargets: [], expectedRecording: "stopped" });
  assert.equal((wrongLiteral as any).error !== undefined || (wrongLiteral as any).result?.isError === true, true);
  assert.equal(counts.emergencies, 0);
  const blind = await call(5, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [], expectedRecording: "stopped" });
  assert.equal((blind as any).result.isError, true);
  assert.equal(counts.emergencies, 0);
  // Simulate host restart: a new host has no transaction state but retains the independent stop authority.
  const restarted = new McpHost(adapter);
  ready(restarted);
  const restartedCall = (id: number, name: string, args: unknown) => restarted.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const activeKey = `${state.tracks[0].ref}|${state.tracks[0].clipSlots[0].ref}|scene:scene-1`;
  const stopped = await restartedCall(6, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [activeKey], expectedRecording: "stopped" });
  assert.equal((stopped as any).result.isError, false);
  assert.equal(counts.emergencies, 1);
  assert.equal(state.playback.transport.playing, false);
  assert.equal(state.playback.playingTargets.length, 0);
  const alreadyStopped = await restartedCall(7, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [], expectedRecording: "stopped" });
  assert.equal((alreadyStopped as any).result.isError, false);
});

test("previews, applies idempotently, verifies, and guardedly undoes a device parameter change", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const before = simulator.snapshot().tracks[0]!.devices[0]!.parameters[0]!;
  const preview = host.handle({ jsonrpc: "2.0", id: 200, method: "tools/call", params: { name: "live_device_parameter_preview", arguments: { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.75 } } });
  const proposed = JSON.parse((preview as any).result.content[0].text) as { transactionId: string; confirmation: string; parameter: { currentValue: number; revision: number; proposedValue: number } };
  assert.equal((preview as any).result.isError, false);
  assert.equal(proposed.parameter.currentValue, before.value);
  assert.equal(simulator.snapshot().tracks[0]!.devices[0]!.parameters[0]!.value, before.value);
  const applied = host.handle({ jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "live_device_parameter_apply", arguments: { transactionId: proposed.transactionId, confirmation: proposed.confirmation, idempotencyKey: "parameter-apply-1" } } });
  const appliedValue = JSON.parse((applied as any).result.content[0].text) as { value: number; revision: number; idempotent: boolean };
  assert.equal((applied as any).result.isError, false);
  assert.equal(appliedValue.value, 0.75);
  assert.equal(appliedValue.idempotent, false);
  assert.ok(appliedValue.revision > proposed.parameter.revision);
  const repeated = host.handle({ jsonrpc: "2.0", id: 202, method: "tools/call", params: { name: "live_device_parameter_apply", arguments: { transactionId: proposed.transactionId, confirmation: proposed.confirmation, idempotencyKey: "parameter-apply-1" } } });
  assert.equal(JSON.parse((repeated as any).result.content[0].text).idempotent, true);
  const undone = host.handle({ jsonrpc: "2.0", id: 203, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: proposed.transactionId, confirmation: "undo", idempotencyKey: "parameter-undo-1" } } });
  assert.equal((undone as any).result.isError, false);
  assert.equal(JSON.parse((undone as any).result.content[0].text).value, before.value);
});

test("refuses device parameter changes for invalid token, stale revision, epoch changes, and bounds", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const outOfBounds = host.handle({ jsonrpc: "2.0", id: 204, method: "tools/call", params: { name: "live_device_parameter_preview", arguments: { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 2 } } });
  assert.equal((outOfBounds as any).result.isError, true);
  const preview = host.handle({ jsonrpc: "2.0", id: 205, method: "tools/call", params: { name: "live_device_parameter_preview", arguments: { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.25 } } });
  const value = JSON.parse((preview as any).result.content[0].text) as { transactionId: string; confirmation: string };
  const wrongToken = host.handle({ jsonrpc: "2.0", id: 206, method: "tools/call", params: { name: "live_device_parameter_apply", arguments: { transactionId: value.transactionId, confirmation: "wrong", idempotencyKey: "parameter-bad-token" } } });
  assert.equal((wrongToken as any).result.isError, true);
  simulator.simulateExternalEdit("parameter:gain-1", "value", 0.4);
  const stale = host.handle({ jsonrpc: "2.0", id: 207, method: "tools/call", params: { name: "live_device_parameter_apply", arguments: { transactionId: value.transactionId, confirmation: value.confirmation, idempotencyKey: "parameter-stale" } } });
  assert.equal((stale as any).result.isError, true);
  assert.match((stale as any).result.content[0].text, /changed since preview/);
  const second = host.handle({ jsonrpc: "2.0", id: 208, method: "tools/call", params: { name: "live_device_parameter_preview", arguments: { deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", value: 0.6 } } });
  const secondValue = JSON.parse((second as any).result.content[0].text) as { transactionId: string; confirmation: string };
  simulator.reconnect();
  const epoch = host.handle({ jsonrpc: "2.0", id: 209, method: "tools/call", params: { name: "live_device_parameter_apply", arguments: { transactionId: secondValue.transactionId, confirmation: secondValue.confirmation, idempotencyKey: "parameter-epoch" } } });
  assert.equal((epoch as any).result.isError, true);
  assert.match((epoch as any).result.content[0].text, /epoch changed/);
});

test("previews, applies idempotently, verifies, and guardedly undoes Session structure", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = host.handle({ jsonrpc: "2.0", id: 80, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Bass", kind: "midi", index: 1 }, { name: "Vocal", kind: "audio", index: 2 }], scenes: [{ name: "Verse", index: 1 }, { name: "Chorus", index: 2 }] } } });
  const value = JSON.parse((preview as any).result.content[0].text) as { transactionId: string; proposed: unknown[]; confirmation: string };
  assert.equal((preview as any).result.isError, false);
  assert.equal(value.proposed.length, 4);
  assert.equal(value.confirmation, "apply");
  assert.deepEqual(simulator.snapshot().tracks.map((track) => track.name), ["Drums"]);
  const applied = host.handle({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "live_session_structure_apply", arguments: { transactionId: value.transactionId, confirmation: "apply", idempotencyKey: "structure-1" } } });
  const appliedValue = JSON.parse((applied as any).result.content[0].text) as { created: Array<{ ref: string }>; idempotent: boolean };
  assert.equal(appliedValue.created.length, 4);
  assert.equal(appliedValue.idempotent, false);
  const repeated = host.handle({ jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "live_session_structure_apply", arguments: { transactionId: value.transactionId, confirmation: "apply", idempotencyKey: "structure-1" } } });
  assert.equal(JSON.parse((repeated as any).result.content[0].text).idempotent, true);
  assert.deepEqual(simulator.snapshot().tracks.map((track) => track.name), ["Drums", "Bass", "Vocal"]);
  assert.deepEqual(simulator.snapshot().scenes.map((scene) => scene.name), ["Scene 1", "Verse", "Chorus"]);
  const undone = host.handle({ jsonrpc: "2.0", id: 83, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: value.transactionId, confirmation: "undo", idempotencyKey: "structure-undo-1" } } });
  assert.equal((undone as any).result.isError, false);
  assert.deepEqual(simulator.snapshot().tracks.map((track) => track.name), ["Drums"]);
  assert.deepEqual(simulator.snapshot().scenes.map((scene) => scene.name), ["Scene 1"]);
});

test("Session structure indexes only the mutable regular-track collection", async () => {
  const simulator = new DeterministicLiveSimulator();
  const originalSnapshot = simulator.snapshot.bind(simulator);
  simulator.snapshot = () => {
    const snapshot = originalSnapshot(); const template = snapshot.tracks[0]!;
    snapshot.tracks.push(
      { ...structuredClone(template), ref: "track:return-a", objectIdentity: "simulator:track:return-a", name: "Return A", kind: "return", clips: [], clipSlots: [], devices: [] },
      { ...structuredClone(template), ref: "track:main", objectIdentity: "simulator:track:main", name: "Main", kind: "main", clips: [], clipSlots: [], devices: [] },
    );
    return snapshot;
  };
  const host = new McpHost(simulator); ready(host);
  const syncInvalid = host.handle({ jsonrpc: "2.0", id: 809, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Sync Out of Range", kind: "midi", index: 3 }], scenes: [] } } });
  assert.equal((syncInvalid as any).error.code, -32602); assert.match((syncInvalid as any).error.message, /regular-track collection/);
  const syncValid = host.handle({ jsonrpc: "2.0", id: 810, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Sync At End", kind: "midi", index: 1 }], scenes: [] } } });
  assert.deepEqual(JSON.parse((syncValid as any).result.content[0].text).prior.tracks.map((track: { name: string }) => track.name), ["Drums"]);
  const invalid = await host.handleAsync({ jsonrpc: "2.0", id: 811, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Out of Range", kind: "midi", index: 3 }], scenes: [] } } });
  assert.equal((invalid as any).error.code, -32602); assert.match((invalid as any).error.message, /regular-track collection/);
  const invalidScene = await host.handleAsync({ jsonrpc: "2.0", id: 812, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [], scenes: [{ name: "Out of Range Scene", index: 2 }] } } });
  assert.equal((invalidScene as any).error.code, -32602); assert.match((invalidScene as any).error.message, /scene collection/);
  const valid = await host.handleAsync({ jsonrpc: "2.0", id: 813, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "At End", kind: "midi", index: 1 }], scenes: [] } } });
  const value = JSON.parse((valid as any).result.content[0].text); assert.equal((valid as any).result.isError, false); assert.deepEqual(value.prior.tracks.map((track: { name: string }) => track.name), ["Drums"]);
});

test("previews, applies, verifies, and undoes a purpose-specific rename", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "Renamed Track" })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(3, "live_object_rename_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rename-apply" })) as any).result.content[0].text);
  assert.equal(applied.name, "Renamed Track"); assert.equal((simulator.get("track:track-1") as any).name, "Renamed Track");
  const undone = JSON.parse(((await call(4, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "rename-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone"); assert.equal((simulator.get("track:track-1") as any).name, "Drums");
});

test("rename apply reconciles a lost acknowledgement only with the exact key", async () => {
  const simulator = new DeterministicLiveSimulator(); const original = simulator.invokeAsync.bind(simulator); let dispatches = 0; let cached: unknown;
  simulator.invokeAsync = async (invocation) => { if (invocation.operation !== "track.rename") return original(invocation); if (cached !== undefined) return cached; dispatches += 1; cached = await original(invocation); throw new Error("remote adapter request state uncertain after dispatch timeout"); };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(401, "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "Acknowledged Later" })) as any).result.content[0].text);
  const uncertain = await call(402, "live_object_rename_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rename-lost-ack" }); assert.equal((uncertain as any).result.isError, true); assert.equal((simulator.get("track:track-1") as any).name, "Acknowledged Later");
  const wrong = await call(403, "live_object_rename_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rename-other-key" }); assert.equal((wrong as any).result.isError, true);
  const reconciled = JSON.parse(((await call(404, "live_object_rename_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rename-lost-ack" })) as any).result.content[0].text); assert.equal(reconciled.state, "applied"); assert.equal(reconciled.reconciled, true); assert.equal(dispatches, 1);
});

test("rename reconciliation never claims an external same-name edit", async () => {
  const simulator = new DeterministicLiveSimulator(); const original = simulator.invokeAsync.bind(simulator); let rejected = false;
  simulator.invokeAsync = async (invocation) => { if (invocation.operation === "track.rename" && !rejected) { rejected = true; throw new Error("remote adapter request state uncertain before mapper dispatch"); } return original(invocation); };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const preview = JSON.parse(((await call(405, "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "External Same Name" })) as any).result.content[0].text);
  assert.equal((await call(406, "live_object_rename_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rename-no-ledger" }) as any).result.isError, true); simulator.simulateExternalEdit("track:track-1", "name", "External Same Name");
  const refused = await call(407, "live_object_rename_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rename-no-ledger" }); assert.equal((refused as any).result.isError, true); assert.equal((simulator.get("track:track-1") as any).name, "External Same Name");
});

test("refuses Session-structure mutation when the precondition revision changes", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = host.handle({ jsonrpc: "2.0", id: 84, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Lead", kind: "midi" }], scenes: [] } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  simulator.simulateExternalEdit("track:track-1", "name", "Externally renamed");
  const applied = host.handle({ jsonrpc: "2.0", id: 85, method: "tools/call", params: { name: "live_session_structure_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "structure-conflict" } } });
  assert.equal((applied as any).result.isError, true);
  assert.match((applied as any).result.content[0].text, /changed since preview/);
});

test("routes Session-structure steps through renewable asynchronous deadlines", async () => {
  const simulator = new DeterministicLiveSimulator();
  const originalSnapshot = simulator.snapshotAsync.bind(simulator); const originalInvoke = simulator.invokeAsync.bind(simulator); const deadlines: number[] = []; let deletedTrackRef: LiveRef | undefined;
  const delayed = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
  simulator.snapshotAsync = async (context?: { deadlineMs?: number }) => { if (context?.deadlineMs) deadlines.push(context.deadlineMs); await delayed(); const snapshot = await originalSnapshot(); if (deletedTrackRef) { const template = snapshot.tracks[0]!; snapshot.tracks.push({ ...structuredClone(template), ref: deletedTrackRef, objectIdentity: "simulator:return:shifted", name: "Shifted Return", kind: "return", clips: [], clipSlots: [], devices: [] }); } return snapshot; };
  simulator.invokeAsync = async (invocation, context?: { deadlineMs?: number }) => { if (context?.deadlineMs) deadlines.push(context.deadlineMs); await delayed(); const result = await originalInvoke(invocation); if (invocation.operation === "track.delete") deletedTrackRef = invocation.args.ref as LiveRef; return result; };
  const host = new McpHost(simulator);
  ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 86, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Async Bass", kind: "midi" }], scenes: [{ name: "Async Verse" }] } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string; deadlines.length = 0;
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 87, method: "tools/call", params: { name: "live_session_structure_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "async-structure-1" } } });
  assert.equal((applied as any).result.isError, false);
  assert.equal(JSON.parse((applied as any).result.content[0].text).created.length, 2);
  assert.ok(new Set(deadlines).size >= 4, "each bounded apply step must receive a fresh deadline");
  deadlines.length = 0;
  const undone = await host.handleAsync({ jsonrpc: "2.0", id: 88, method: "tools/call", params: { name: "live_undo", arguments: { transactionId, confirmation: "undo", idempotencyKey: "async-structure-undo" } } });
  assert.equal((undone as any).result.isError, false);
  assert.ok(new Set(deadlines).size >= 4, "each bounded undo step must receive a fresh deadline");
});

test("advertises and serves static safety resources and a complete audio workflow prompt", () => {
  const host = new McpHost();
  ready(host);
  const init = host.handle({ ...initialize, id: 99 });
  assert.equal((init as any).error.code, -32600);
  const resources = host.handle({ jsonrpc: "2.0", id: 30, method: "resources/list", params: {} });
  assert.deepEqual((resources as any).result.resources.map((resource: { uri: string }) => resource.uri), ["ableton://capabilities", "ableton://safety", "ableton://max-extension", "ableton://journeys", "ableton://live-workflow"]);
  const safety = host.handle({ jsonrpc: "2.0", id: 31, method: "resources/read", params: { uri: "ableton://safety" } });
  assert.match((safety as any).result.contents[0].text, /does not connect to Ableton Live/);
  assert.match((safety as any).result.contents[0].text, /explicit project mutations/);
  const maxExtension = JSON.parse((host.handle({ jsonrpc: "2.0", id: 41, method: "resources/read", params: { uri: "ableton://max-extension" } }) as any).result.contents[0].text);
  assert.equal(maxExtension.available, false); assert.equal(maxExtension.bundledDevice, false); assert.deepEqual(maxExtension.operations, ["parameter.set", "xy.set", "emergency-stop"]);
  const journeys = host.handle({ jsonrpc: "2.0", id: 38, method: "resources/read", params: { uri: "ableton://journeys" } });
  const journeyCatalog = JSON.parse((journeys as any).result.contents[0].text);
  assert.equal(journeyCatalog.journeys.length, 5);
  assert.equal(journeyCatalog.journeys.find((entry: any) => entry.id === "compare-reference-mix").mode, "local-analysis");
  assert.ok(journeyCatalog.journeys.filter((entry: any) => entry.id !== "compare-reference-mix").every((entry: any) => entry.mode === "capability-limited"));
  const prompts = host.handle({ jsonrpc: "2.0", id: 32, method: "prompts/list" });
  assert.equal((prompts as any).result.prompts[0].name, "analyze_audio");
  assert.equal((prompts as any).result.prompts.length, 7);
  const prompt = host.handle({ jsonrpc: "2.0", id: 33, method: "prompts/get", params: { name: "analyze_audio", arguments: { sampleRate: "44100" } } });
  assert.match((prompt as any).result.messages[0].content.text, /sampleRate=44100/);
  const workflowPrompt = host.handle({ jsonrpc: "2.0", id: 37, method: "prompts/get", params: { name: "change_tempo_safely" } });
  assert.match((workflowPrompt as any).result.messages[0].content.text, /live_tempo_preview/);
  const userPrompt = host.handle({ jsonrpc: "2.0", id: 39, method: "prompts/get", params: { name: "create_beat_or_song", arguments: { traits: "sparse and syncopated", bars: "8", experienceLevel: "beginner" } } });
  assert.match((userPrompt as any).result.messages[0].content.text, /capability-limited/);
  assert.match((userPrompt as any).result.messages[0].content.text, /Do not promise exact replication/);
  const planned = host.handle({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "plan_user_journey", arguments: { journey: "compare-reference-mix", traits: "balanced and clear", bars: 4 } } });
  const plan = JSON.parse((planned as any).result.content[0].text);
  assert.equal(plan.mode, "local-analysis");
  assert.equal(plan.stages.filter((stage: any) => stage.requiredForCore).every((stage: any) => stage.status === "planned"), true);
  assert.equal(plan.stages.filter((stage: any) => !stage.requiredForCore).every((stage: any) => stage.status === "unavailable"), true);
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

test("analyzes supplied PCM through the cancellable MCP worker without Live side effects", async () => {
  const bytes = Buffer.alloc(4 * 4);
  for (const [index, value] of [0, 0.5, -0.5, 0].entries()) bytes.writeFloatLE(value, index * 4);
  const host = new McpHost();
  ready(host);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "audio_analyze", arguments: { pcmBase64: bytes.toString("base64"), sampleRate: 44100 } } });
  const text = (result as any).result.content[0].text;
  const analysis = JSON.parse(text) as { version: string; sampleCount: number; privacy: { rawAudioReturned: boolean }; safety: { projectMutated: boolean } };
  assert.equal(analysis.version, "pcm-analysis/v2");
  assert.equal(analysis.sampleCount, 4);
  assert.equal(analysis.privacy.rawAudioReturned, false);
  assert.equal(analysis.safety.projectMutated, false);
  const synchronous = host.handle({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "audio_analyze", arguments: { pcmBase64: bytes.toString("base64"), sampleRate: 44_100 } } });
  assert.equal((synchronous as any).error.code, -32001);
});

test("compares caller-supplied references without exposing raw PCM", async () => {
  const samples = Float32Array.from({ length: 48_000 }, (_, frame) => 0.1 * Math.sin(2 * Math.PI * 997 * frame / 48_000));
  const bytes = Buffer.alloc(samples.length * 4);
  samples.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  const source = { pcmBase64: bytes.toString("base64"), sampleRate: 48_000, channels: 1, channelLayout: ["M"] };
  const host = new McpHost(); ready(host);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "audio_compare_reference", arguments: { project: source, reference: source, alignment: { mode: "disabled" } } } });
  assert.equal((result as any).result.isError, false);
  const comparison = JSON.parse((result as any).result.content[0].text);
  assert.equal(comparison.version, "reference-analysis/v1");
  assert.equal(comparison.privacy.rawAudioReturned, false);
  assert.ok(Math.abs(comparison.deltas.projectMinusReference.integratedLoudnessLu) < 1e-9);
});

test("cancels an in-flight audio worker without a response", async () => {
  const bytes = Buffer.alloc(500_000 * 4);
  const host = new McpHost(); ready(host);
  const controller = new AbortController();
  const pending = host.handleAsync({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "audio_analyze", arguments: { pcmBase64: bytes.toString("base64"), sampleRate: 48_000 } } }, controller.signal);
  controller.abort();
  assert.equal(await pending, null);
});

test("rejects duplicates, unsupported methods, and unknown fields", () => {
  const host = new McpHost();
  ready(host);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.length, 7);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).error.message, "Duplicate request identifier");
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set", arguments: {} } }) as any).error.code, -32601);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 4, method: "tools/list", debug: true }) as any).error.code, -32600);
});

test("subscription validation rejects event types without a producer", async () => {
  const simulator = new DeterministicLiveSimulator();
  const adapter = { status: () => ({ ...simulator.status(), capabilities: [...simulator.status().capabilities, "subscriptions"], operations: [...simulator.status().operations ?? [], "subscribe"] }) } as unknown as LiveAdapter;
  const host = new McpHost(adapter); ready(host);
  for (const type of ["state", "meter", "max", "osc"]) {
    const result = await host.handleAsync({ jsonrpc: "2.0", id: `unsupported-${type}`, method: "tools/call", params: { name: "live_subscribe", arguments: { types: [type] } } });
    assert.equal((result as any).error.code, -32602);
  }
});

test("bounds server event flushing across slow output and contains emitter failure", async () => {
  const host = new McpHost(new DeterministicLiveSimulator());
  let calls = 0; let rejectFirst: ((cause: Error) => void) | undefined;
  host.setEventEmitter(async () => {
    calls += 1;
    if (calls === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  });
  for (let index = 0; index < 2_000; index += 1) (host as any).onLiveEvent({ epoch: 1, sequence: index + 1, type: "object", payload: { index } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.ok((host as any).eventQueue.length <= 256);
  assert.ok((host as any).eventOverflow > 0);
  rejectFirst?.(new Error("output failed"));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((host as any).eventOutputFailed, true);
  assert.equal((host as any).eventQueue.length, 0);
  assert.equal((host as any).eventOverflow, 0);
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
  const missingConfirmation = host.handle({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: previewValue.transactionId, confirmation: "no", idempotencyKey: "apply-1-key" } } });
  assert.equal((missingConfirmation as any).error.code, -32602);
  const applied = host.handle({ jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: previewValue.transactionId, confirmation: "apply", idempotencyKey: "apply-1-key" } } });
  assert.equal(JSON.parse((applied as any).result.content[0].text).tempo, 128);
  const repeated = host.handle({ jsonrpc: "2.0", id: 45, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: previewValue.transactionId, confirmation: "apply", idempotencyKey: "apply-1-key" } } });
  assert.equal(JSON.parse((repeated as any).result.content[0].text).idempotent, true);
  simulator.simulateExternalEdit("set:set-1", "tempo", 130);
  const conflictedUndo = host.handle({ jsonrpc: "2.0", id: 46, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: previewValue.transactionId, confirmation: "undo", idempotencyKey: "undo-1-key" } } });
  assert.equal((conflictedUndo as any).result.isError, true);
  assert.equal(simulator.snapshot().set.tempo, 130);
});

test("expired applied host transactions retain replay and undo authority under preview pressure", () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host);
  const parse = (value: unknown) => JSON.parse((value as any).result.content[0].text);
  const preview = parse(host.handle({ jsonrpc: "2.0", id: 6000, method: "tools/call", params: { name: "live_tempo_preview", arguments: { tempo: 125 } } }));
  host.handle({ jsonrpc: "2.0", id: 6001, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "retained-apply" } } });
  (host as any).transactions.get(preview.transactionId).expiresAt = 0;
  for (let index = 0; index < 140; index += 1) host.handle({ jsonrpc: "2.0", id: 6100 + index, method: "tools/call", params: { name: "live_tempo_preview", arguments: { tempo: 126 + (index % 2) } } });
  const replay = parse(host.handle({ jsonrpc: "2.0", id: 6300, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "retained-apply" } } }));
  assert.equal(replay.idempotent, true);
  const undone = parse(host.handle({ jsonrpc: "2.0", id: 6301, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "retained-undo" } } }));
  assert.equal(undone.state, "undone"); assert.equal(simulator.snapshot().set.tempo, 120);
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

test("exports paged semantic snapshots and diffs complete bundles offline without authority", async () => {
  const liveHost = new McpHost(new DeterministicLiveSimulator()); ready(liveHost);
  const pages: any[] = []; let cursor: string | undefined; let id = 900;
  do {
    const frame = await liveHost.handleAsync({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "live_project_snapshot_export", arguments: { profile: "strict", limit: 3, ...(cursor ? { cursor } : {}) } } }) as any;
    assert.equal(frame.result.isError, false); const page = JSON.parse(frame.result.content[0].text); pages.push(page); cursor = page.page.nextCursor;
    assert.equal(page.safety.containsMutationAuthority, false); assert.equal(page.safety.containsSessionReferences, false);
  } while (cursor);
  assert.ok(pages.length > 1); assert.equal(pages.at(-1).page.complete, true);

  const offline = new McpHost(); ready(offline);
  const diffFrame = await offline.handleAsync({ jsonrpc: "2.0", id: 950, method: "tools/call", params: { name: "live_project_snapshot_diff", arguments: { beforePages: pages, afterPages: pages, limit: 2 } } }) as any;
  const diff = JSON.parse(diffFrame.result.content[0].text); assert.equal(diff.summary.changed, false); assert.equal(diff.safety.mergeProposed, false); assert.equal(diff.page.complete, true);
  const catalog = JSON.parse((offline.handle({ jsonrpc: "2.0", id: 951, method: "tools/call", params: { name: "capabilities", arguments: {} } }) as any).result.content[0].text);
  assert.ok(catalog.tools.available.includes("live_project_snapshot_diff")); assert.ok(catalog.tools.unavailable.includes("live_project_snapshot_export"));
  const invalid = await offline.handleAsync({ jsonrpc: "2.0", id: 952, method: "tools/call", params: { name: "live_project_snapshot_diff", arguments: { beforePages: [pages[0]], afterPages: pages } } }) as any;
  assert.equal(invalid.result.isError, true); assert.match(JSON.parse(invalid.result.content[0].text).remediation, /complete untampered page bundles/);
});

test("delegates expanded discovery through the mandatory asynchronous adapter seam", async () => {
  const simulator = new DeterministicLiveSimulator();
  let request: unknown;
  simulator.discoverAsync = async (value) => { request = value; return { epoch: 1, items: [], truncated: false, revision: "1:return-track:0", kind: "return-track" }; };
  const host = new McpHost(simulator); ready(host);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 771, method: "tools/call", params: { name: "live_discover", arguments: { kind: "return-track", filter: { name: "Return" }, fields: ["name"], budget: 20, limit: 4 } } });
  assert.equal((result as any).result.isError, false);
  assert.deepEqual(request, { kind: "return-track", parent: undefined, filter: { name: "Return" }, fields: ["name"], budget: 20, limit: 4, cursor: undefined });
  const invalid = await host.handleAsync({ jsonrpc: "2.0", id: 772, method: "tools/call", params: { name: "live_discover", arguments: { kind: "return-track", filter: { nested: {} } } } });
  assert.equal((invalid as any).error.code, -32602);
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
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
  (simulator as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
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

test("asynchronous MIDI apply and undo retain a bounded transaction-wide bridge deadline", async () => {
  const base = new DeterministicLiveSimulator(); const remaining: number[] = [];
  const record = (context?: { deadlineMs?: number }): void => { if (context?.deadlineMs) remaining.push(context.deadlineMs - Date.now()); };
  const adapter = {
    status: () => base.status(), snapshot: () => base.snapshot(), get: (ref: LiveRef) => base.get(ref), invoke: (invocation: LiveInvocation) => base.invoke(invocation), subscribe: (listener: Parameters<LiveAdapter["subscribe"]>[0]) => base.subscribe(listener), reconnect: () => base.reconnect(),
    snapshotAsync: async (context?: { deadlineMs?: number }) => { record(context); return base.snapshot(); }, getAsync: async (ref: LiveRef, context?: { deadlineMs?: number }) => { record(context); const value = base.get(ref); if (value === undefined) throw new Error("request failed"); return value; }, invokeAsync: async (invocation: LiveInvocation, context?: { deadlineMs?: number }) => { record(context); return base.invoke(invocation); }, reconnectAsync: async () => base.reconnect(),
  } as unknown as LiveAdapter;
  (base as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
  (base as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const host = new McpHost(adapter); ready(host); const track = base.snapshot().tracks[0]!;
  const previewFrame = await host.handleAsync({ jsonrpc: "2.0", id: 641, method: "tools/call", params: { name: "live_midi_clip_preview", arguments: { trackRef: track.ref, sceneIndex: 1, name: "Deadline MIDI", length: 4, notes: [{ pitch: 60, start: 0, duration: 0.25, velocity: 100, channel: 1 }] } } }) as any;
  const preview = JSON.parse(previewFrame.result.content[0].text); remaining.length = 0;
  const appliedFrame = await host.handleAsync({ jsonrpc: "2.0", id: 642, method: "tools/call", params: { name: "live_midi_clip_apply", arguments: { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "deadline-midi-apply" } } }) as any;
  const applied = JSON.parse(appliedFrame.result.content[0].text); assert.equal(applied.state, "applied");
  assert.ok(remaining.length >= 4); assert.ok(remaining.every((value) => value > 25_000), `short MIDI apply deadline: ${remaining}`);
  remaining.length = 0;
  const undoneFrame = await host.handleAsync({ jsonrpc: "2.0", id: 643, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "deadline-midi-undo" } } }) as any;
  const undone = JSON.parse(undoneFrame.result.content[0].text); assert.equal(undone.state, "undone");
  assert.ok(remaining.length >= 2); assert.ok(remaining.every((value) => value > 25_000), `short MIDI undo deadline: ${remaining}`);
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

test("derives a truthful exhaustive tool catalog from fully negotiated Live capabilities", () => {
  const simulator = new DeterministicLiveSimulator();
  const adapter = { status: () => ({ ...simulator.status(), adapter: "remote-script", provenance: "real-live", capabilities: [...LIVE_CAPABILITIES], operations: [...LIVE_REGISTRY_OPERATIONS] }) } as unknown as LiveAdapter;
  const host = new McpHost(adapter); ready(host);
  const listed = (host.handle({ jsonrpc: "2.0", id: 70, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith("live_"));
  const catalog = JSON.parse((host.handle({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "capabilities", arguments: {} } }) as any).result.content[0].text);
  assert.deepEqual([...catalog.tools.available, ...catalog.tools.unavailable].sort(), [...listed].sort());
  assert.equal(new Set([...catalog.tools.available, ...catalog.tools.unavailable]).size, listed.length);
  assert.deepEqual(catalog.tools.unavailable.sort(), []);
  assert.deepEqual(catalog.tools.policyDenied, []);
  assert.deepEqual([...catalog.tools.visible].sort(), [...listed, "audio_analyze", "audio_compare_reference", "audio_diagnose_live_context", "capabilities", "plan_user_journey", "server_status"].sort());
  assert.equal(catalog.policy.profile, "full");
  assert.equal(catalog.tools.classes.live_tempo_apply, "edit");
  assert.equal(catalog.tools.classes.live_browser_search, "read");
  for (const contradiction of ["live.mutations", "live.transport", "live.recording", "live.routing", "live.audio", "live.midi", "realtime"]) assert.equal(catalog.unavailable.includes(contradiction), false, contradiction);
  for (const available of ["live_transport_apply", "live_recording_apply", "live_realtime_arm_apply", "live_browser_load_apply"]) assert.equal(catalog.tools.available.includes(available), true, available);
});

test("capability catalog requires each tool's negotiated operations", () => {
  const simulator = new DeterministicLiveSimulator();
  const status = simulator.status();
  const adapter = { status: () => ({ ...status, capabilities: ["session.read", "session.discovery", "transport"], operations: ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "transport.set", "tempo.set"] }) } as unknown as LiveAdapter;
  const host = new McpHost(adapter); ready(host);
  const catalog = JSON.parse((host.handle({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "capabilities", arguments: {} } }) as any).result.content[0].text);
  for (const available of ["live_snapshot", "live_discover", "live_transport_apply", "live_tempo_apply"]) assert.ok(catalog.tools.available.includes(available), available);
  for (const unavailable of ["live_session_audition_apply", "live_session_emergency_stop", "live_clip_launch_apply", "live_note_update_apply"]) assert.ok(catalog.tools.unavailable.includes(unavailable), unavailable);
  assert.equal(catalog.tools.available.some((name: string) => catalog.tools.unavailable.includes(name)), false);
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
    const result = host.handle({ jsonrpc: "2.0", id: 57, method: "tools/call", params: { name: "live_tempo_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "expired-key" } } });
    assert.equal((result as any).result.isError, true);
    assert.equal(simulator.snapshot().set.tempo, 120);
  } finally { Date.now = originalNow; }
  const invalid = new McpHost({ ...simulator, status: () => ({ connected: true, adapter: "simulator", epoch: 1, protocol: "wrong", capabilities: [] }) } as any);
  ready(invalid);
  const status = invalid.handle({ jsonrpc: "2.0", id: 58, method: "tools/call", params: { name: "live_status", arguments: {} } });
  assert.equal(JSON.parse((status as any).result.content[0].text).connected, false);
  for (const malformed of [
    { operations: ["discover", "discover"] },
    { operations: ["fabricated.operation"] },
    { provenance: "claimed-live" },
    { registryHash: "not-a-canonical-hash" },
  ]) {
    const malformedHost = new McpHost({ ...simulator, status: () => ({ ...simulator.status(), ...malformed }) } as any);
    ready(malformedHost);
    const malformedStatus = malformedHost.handle({ jsonrpc: "2.0", id: 59, method: "tools/call", params: { name: "live_status", arguments: {} } });
    assert.equal(JSON.parse((malformedStatus as any).result.content[0].text).connected, false);
  }
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

test("CLI refuses invalid arguments before starting the stdio server", () => {
  const entry = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const child = spawnSync(process.execPath, [entry, "--bogus"], { input: "", encoding: "utf8", timeout: 1_000 });
  assert.equal(child.status, 2, child.stderr);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /unknown option/);
});

test("CLI rejects a permissive bridge secret before opening the adapter", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-secret-gate-"));
  const entry = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const secretPath = join(directory, "bridge.secret"); const configPath = join(directory, "bridge.json");
  writeFileSync(secretPath, "0123456789abcdef0123456789abcdef01234567\n"); chmodSync(secretPath, 0o644);
  writeFileSync(configPath, JSON.stringify({ version: 2, server: { command: process.execPath, args: [entry, "--config", configPath] }, bridge: { host: "127.0.0.1", port: 43210, secretFile: secretPath, timeoutMs: 500 } }));
  const child = spawnSync(process.execPath, [entry, "--config", configPath], { input: "", encoding: "utf8", timeout: 1_000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /permissions.*owner-only/); assert.equal(child.stdout, "");
});

test("accepts MCP metadata and reports value errors as tool errors", async () => {
  const host = new McpHost();
  const init = host.handle({ ...initialize, _meta: { trace: "test" }, params: { ...initialize.params, _meta: {} } });
  assert.equal((init as any).result.protocolVersion, PROTOCOL_VERSION);
  host.handle(initialized);
  const invalidValue = Buffer.alloc(4); invalidValue.writeFloatLE(1.1);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", _meta: {}, params: { name: "audio_analyze", _meta: {}, arguments: { pcmBase64: invalidValue.toString("base64"), sampleRate: 44100 } } });
  assert.equal((result as any).result.isError, true);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "ping" }) as any).result instanceof Object, true);
});

test("does not let invalid audio requests consume the rate limit", async () => {
  const host = new McpHost();
  ready(host);
  for (let id = 2; id <= 121; id += 1) {
    const result = await host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "audio_analyze", arguments: {} } });
    assert.equal((result as any).error.code, -32602);
  }
  const bytes = Buffer.alloc(4);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 122, method: "tools/call", params: { name: "audio_analyze", arguments: { pcmBase64: bytes.toString("base64"), sampleRate: 44100 } } });
  assert.equal((result as any).result.isError, false);
});

test("rejects audio schema values before decoding or consuming the rate limit", async () => {
  const host = new McpHost();
  ready(host);
  const base = { pcmBase64: Buffer.alloc(4).toString("base64"), sampleRate: 44100 };
  for (const [id, args] of [
    [2, { ...base, sampleRate: 44100.5 }],
    [3, { ...base, sampleRate: 7999 }],
    [4, { ...base, channels: 0 }],
    [5, { ...base, frameSize: 4097 }],
  ] as const) {
    const result = await host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "audio_analyze", arguments: args } });
    assert.equal((result as any).error.code, -32602);
  }
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "audio_analyze", arguments: base } });
  assert.equal((result as any).result.isError, false);
});

test("rejects legacy shutdown and cancellation requests", () => {
  const host = new McpHost();
  ready(host);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" }) as any).error.code, -32601);
  assert.equal((host.handle({ jsonrpc: "2.0", id: 3, method: "$/cancelRequest", params: { requestId: 1 } }) as any).error.code, -32601);
  assert.equal(host.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
});

test("transport preview applies with a revision fence and guardedly undoes", async () => {
  const { adapter, state: fixtureState } = auditionFixture();
  const host = new McpHost(adapter);
  ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_transport_preview", arguments: { position: 8, loopEnabled: true, loopStart: 4, loopLength: 8, metronome: true } } });
  assert.equal((preview as any).result.isError, false);
  const p = JSON.parse((preview as any).result.content[0].text);
  assert.equal(p.prior.position, 0);
  const empty = await host.handleAsync({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "live_transport_preview", arguments: {} } });
  assert.equal((empty as any).error !== undefined || (empty as any).result?.isError === true, true);
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "live_transport_apply", arguments: { transactionId: p.transactionId, confirmation: "apply", idempotencyKey: "transport-apply-1" } } });
  assert.equal((applied as any).result.isError, false);
  const state = JSON.parse((applied as any).result.content[0].text);
  assert.equal(state.state, "applied");
  const playback = (await adapter.snapshotAsync()).playback.transport;
  assert.equal(playback.position, 8);
  assert.equal(playback.loop.enabled, true);
  assert.equal(playback.loop.start, 4);
  assert.equal(playback.loop.length, 8);
  assert.equal(playback.metronome, true);
  const replay = await host.handleAsync({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "live_transport_apply", arguments: { transactionId: p.transactionId, confirmation: "apply", idempotencyKey: "transport-apply-1" } } });
  assert.equal(JSON.parse((replay as any).result.content[0].text).idempotent, true);
  const undone = await host.handleAsync({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: p.transactionId, confirmation: "undo", idempotencyKey: "transport-undo-1" } } });
  assert.equal((undone as any).result.isError, false);
  const restored = (await adapter.snapshotAsync()).playback.transport;
  assert.equal(restored.position, 0);
  assert.equal(restored.loop.enabled, false);
  assert.equal(restored.metronome, false);

  const conflictPreview = JSON.parse(((await host.handleAsync({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "live_transport_preview", arguments: { metronome: true } } })) as any).result.content[0].text);
  await host.handleAsync({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "live_transport_apply", arguments: { transactionId: conflictPreview.transactionId, confirmation: "apply", idempotencyKey: "transport-conflict-apply" } } });
  // Even an ABA edit that returns the touched field to the proposed value has
  // a new authoritative revision and must not be mistaken for our post-state.
  fixtureState.playback.transport.metronome = false;
  fixtureState.playback.transport.metronome = true;
  fixtureState.playback.revision = "external-transport-aba-edit";
  const refused = await host.handleAsync({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "live_undo", arguments: { transactionId: conflictPreview.transactionId, confirmation: "undo", idempotencyKey: "transport-conflict-undo" } } });
  assert.equal((refused as any).result.isError, true);
  assert.equal(fixtureState.playback.transport.metronome, true);
});

test("clip launch previews, applies with one dispatch, verifies, and stops through the owning track", async () => {
  const { state, adapter } = auditionFixture();
  let launches = 0;
  let trackStops = 0;
  let launchArgs: any;
  const innerInvoke = adapter.invokeAsync;
  adapter.status = () => ({ ...(new DeterministicLiveSimulator()).status(), operations: ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "session.clip-launch", "session.clip-stop"] });
  adapter.invokeAsync = async (invocation: any) => {
    if (invocation.operation === "session.clip-launch") {
      launches += 1; launchArgs = structuredClone(invocation.args);
      const slotRef = invocation.args.slotRef;
      const track = state.tracks[0];
      const scene = state.scenes[0];
      const target = { trackRef: track.ref, clipSlotRef: slotRef, sceneRef: scene.ref, sceneIndex: 0, clipRef: track.clips[0].ref };
      state.playback.transport.playing = true;
      state.playback.firedTargets = [target]; state.playback.playingTargets = [target]; state.playback.revision = "launched";
      return { launched: slotRef, targets: [target] };
    }
    if (invocation.operation === "session.clip-stop") {
      trackStops += 1;
      state.playback.firedTargets = []; state.playback.playingTargets = [];
      return { stopped: true };
    }
    return innerInvoke(invocation);
  };
  const host = new McpHost(adapter);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_clip_launch_preview", { slotRef: "clip-slot:track-1:0", outputSafety: { safe: true, provenance: "operator-confirmed-headphones" } })) as any).result.content[0].text);
  assert.equal(preview.target.slotRef, "clip-slot:track-1:0");
  assert.deepEqual([preview.target.trackIdentity, preview.target.sceneIdentity, preview.target.slotIdentity, preview.target.clipIdentity], ["simulator:track:track-1", "simulator:scene:scene-1", "simulator:clip-slot:track-1:0", "simulator:clip:clip-1"]);
  const unsafe = await call(3, "live_clip_launch_preview", { slotRef: "clip-slot:track-1:0", outputSafety: { safe: true, provenance: "unknown" } });
  assert.equal((unsafe as any).result.isError, true);
  const replacementPreview = JSON.parse(((await call(7, "live_clip_launch_preview", { slotRef: "clip-slot:track-1:0", outputSafety: { safe: true, provenance: "operator-confirmed-headphones" } })) as any).result.content[0].text);
  state.tracks[0]!.clips[0]!.objectIdentity = "simulator:clip:replacement";
  const replacementApply = await call(8, "live_clip_launch_apply", { transactionId: replacementPreview.transactionId, confirmation: replacementPreview.confirmation, idempotencyKey: "clip-replacement" });
  assert.equal((replacementApply as any).result.isError, true); assert.equal(launches, 0);
  state.tracks[0]!.clips[0]!.objectIdentity = "simulator:clip:clip-1";
  const [one, two] = await Promise.all([
    call(4, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "clip-apply-1" }),
    call(5, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "clip-apply-1" }),
  ]);
  assert.equal(launches, 1);
  assert.deepEqual([launchArgs.trackIdentity, launchArgs.sceneIdentity, launchArgs.slotIdentity, launchArgs.clipIdentity], ["simulator:track:track-1", "simulator:scene:scene-1", "simulator:clip-slot:track-1:0", "simulator:clip:clip-1"]);
  assert.deepEqual([one, two].map((r) => JSON.parse((r as any).result.content[0].text).idempotent).sort(), [false, true]);
  const stopped = JSON.parse(((await call(6, "live_clip_launch_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "clip-stop-1" })) as any).result.content[0].text);
  assert.equal(stopped.state, "stopped");
  assert.equal(trackStops, 1);
  assert.equal(state.playback.playingTargets.length, 0);
});

test("clip-launch lost acknowledgement reconciles or stops with exact retained authority", async () => {
  const { state, adapter } = auditionFixture(); const innerInvoke = adapter.invokeAsync; let launches = 0; let stops = 0;
  adapter.status = () => ({ ...(new DeterministicLiveSimulator()).status(), operations: ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "session.clip-launch", "session.clip-stop"] });
  adapter.invokeAsync = async (invocation: any) => {
    if (invocation.operation === "session.clip-launch") { launches += 1; const track = state.tracks[0]; const scene = state.scenes[0]; const target = { trackRef: track.ref, clipSlotRef: invocation.args.slotRef, sceneRef: scene.ref, sceneIndex: 0, clipRef: track.clips[0].ref }; state.playback.transport.playing = true; state.playback.firedTargets = [target]; state.playback.playingTargets = [target]; state.playback.revision = `lost-${launches}`; throw new Error("remote adapter request state uncertain after dispatch timeout"); }
    if (invocation.operation === "session.clip-stop") { stops += 1; state.playback.transport.playing = false; state.playback.firedTargets = []; state.playback.playingTargets = []; state.playback.revision = `stopped-${stops}`; return { stopped: true }; }
    return innerInvoke(invocation);
  };
  const host = new McpHost(adapter); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const outputSafety = { safe: true, provenance: "operator-confirmed-headphones" };
  const first = JSON.parse(((await call(501, "live_clip_launch_preview", { slotRef: "clip-slot:track-1:0", outputSafety })) as any).result.content[0].text); const firstArgs = { transactionId: first.transactionId, confirmation: first.confirmation, idempotencyKey: "clip-lost-first" };
  assert.equal((await call(502, "live_clip_launch_apply", firstArgs) as any).result.isError, true); assert.equal((await call(503, "live_clip_launch_apply", { ...firstArgs, idempotencyKey: "clip-lost-wrong" }) as any).result.isError, true);
  const reconciled = JSON.parse(((await call(504, "live_clip_launch_apply", firstArgs)) as any).result.content[0].text); assert.equal(reconciled.state, "applied"); assert.equal(reconciled.reconciled, true); assert.equal(launches, 1);
  assert.equal(JSON.parse(((await call(505, "live_clip_launch_stop", { transactionId: first.transactionId, confirmation: first.stopConfirmation, idempotencyKey: "clip-stop-first" })) as any).result.content[0].text).state, "stopped");
  const second = JSON.parse(((await call(506, "live_clip_launch_preview", { slotRef: "clip-slot:track-1:0", outputSafety })) as any).result.content[0].text); const secondArgs = { transactionId: second.transactionId, confirmation: second.confirmation, idempotencyKey: "clip-lost-second" };
  assert.equal((await call(507, "live_clip_launch_apply", secondArgs) as any).result.isError, true);
  const safelyStopped = JSON.parse(((await call(508, "live_clip_launch_stop", { transactionId: second.transactionId, confirmation: second.stopConfirmation, idempotencyKey: "clip-stop-after-uncertain-apply" })) as any).result.content[0].text); assert.equal(safelyStopped.state, "stopped"); assert.equal(stops, 2); assert.equal(state.playback.playingTargets.length, 0);
  const replay = JSON.parse(((await call(509, "live_clip_launch_apply", secondArgs)) as any).result.content[0].text); assert.equal(replay.state, "stopped"); assert.equal(replay.idempotent, true); assert.equal(launches, 2);
});

test("capture MIDI and scene capture use fenced idempotent transactions with guarded undo", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const midiPreview = JSON.parse(((await call(2, "live_capture_midi_preview", {})) as any).result.content[0].text);
  const midiResult = JSON.parse(((await call(3, "live_capture_midi_apply", { transactionId: midiPreview.transactionId, confirmation: "apply", idempotencyKey: "capture-midi-apply" })) as any).result.content[0].text);
  assert.equal(midiResult.state, "applied"); assert.equal(midiResult.created.clips.length, 1);
  const midiReplay = JSON.parse(((await call(4, "live_capture_midi_apply", { transactionId: midiPreview.transactionId, confirmation: "apply", idempotencyKey: "capture-midi-apply" })) as any).result.content[0].text);
  assert.equal(midiReplay.idempotent, true);
  assert.equal(JSON.parse(((await call(5, "live_undo", { transactionId: midiPreview.transactionId, confirmation: "undo", idempotencyKey: "capture-midi-undo" })) as any).result.content[0].text).state, "undone");
  const replacementPreview = JSON.parse(((await call(6, "live_capture_midi_preview", {})) as any).result.content[0].text);
  const replacementApplied = JSON.parse(((await call(7, "live_capture_midi_apply", { transactionId: replacementPreview.transactionId, confirmation: "apply", idempotencyKey: "capture-midi-apply" })) as any).result.content[0].text);
  const replacementRef = replacementApplied.created.clips[0].ref; const clips = (simulator as any).state.tracks[0].clips; const position = clips.findIndex((clip: any) => clip.ref === replacementRef);
  clips[position] = { ...structuredClone(clips[position]), name: "Foreign Replacement", objectIdentity: "foreign-object" };
  const refusedUndo = await call(8, "live_undo", { transactionId: replacementPreview.transactionId, confirmation: "undo", idempotencyKey: "capture-replacement-undo" });
  assert.equal((refusedUndo as any).result.isError, true); assert.equal(clips[position].name, "Foreign Replacement");
  const scenePreview = JSON.parse(((await call(9, "live_scene_capture_preview", {})) as any).result.content[0].text);
  const sceneResult = JSON.parse(((await call(10, "live_scene_capture_apply", { transactionId: scenePreview.transactionId, confirmation: "apply", idempotencyKey: "scene-capture-apply" })) as any).result.content[0].text);
  assert.equal(sceneResult.state, "applied"); assert.ok(sceneResult.created.sceneRef.startsWith("scene:"));
  assert.equal(JSON.parse(((await call(11, "live_undo", { transactionId: scenePreview.transactionId, confirmation: "undo", idempotencyKey: "scene-capture-undo" })) as any).result.content[0].text).state, "undone");
});

test("note update edits velocity and probability by id with a note-list fence and undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const missing = await call(2, "live_note_update_preview", { clipRef: "clip:clip-1", notes: [{ id: 99, velocity: 80 }] });
  assert.equal((missing as any).result.isError, true);
  const preview = JSON.parse(((await call(3, "live_note_update_preview", { clipRef: "clip:clip-1", notes: [{ id: 1, velocity: 80, probability: 0.5, velocityDeviation: 12, releaseVelocity: 40, mute: true }] })) as any).result.content[0].text);
  assert.equal(preview.priorNotes[0].velocity, 110);
  const applied = JSON.parse(((await call(4, "live_note_update_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "note-update-1" })) as any).result.content[0].text);
  assert.equal(applied.updated, 1);
  const clip = simulator.get("clip:clip-1") as any;
  assert.equal(clip.notes[0].velocity, 80);
  assert.equal(clip.notes[0].probability, 0.5);
  assert.equal(clip.notes[0].velocityDeviation, 12);
  assert.equal(clip.notes[0].releaseVelocity, 40);
  assert.equal(clip.notes[0].mute, true);
  (simulator.get("clip:clip-1") as any).notes[0].velocity = 55;
  const stale = await call(5, "live_note_update_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "note-update-2" });
  assert.equal((stale as any).result.isError, true);
  (simulator.get("clip:clip-1") as any).notes[0].velocity = 80;
  const undone = JSON.parse(((await call(6, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "note-update-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal((simulator.get("clip:clip-1") as any).notes[0].velocity, 110);
});

test("note delete removes exact ids and undo re-adds content with new ids", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_note_delete_preview", { clipRef: "clip:clip-1", noteIds: [1] })) as any).result.content[0].text);
  assert.equal(preview.priorNotes.length, 1);
  const applied = JSON.parse(((await call(3, "live_note_delete_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "note-delete-1" })) as any).result.content[0].text);
  assert.equal(applied.deleted, 1);
  assert.equal((simulator.get("clip:clip-1") as any).notes.length, 0);
  const replay = JSON.parse(((await call(4, "live_note_delete_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "note-delete-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "note-delete-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  const notes = (simulator.get("clip:clip-1") as any).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].pitch, 36);
  assert.notEqual(notes[0].id, 1);
});

test("uncertain partial note deletion restores all missing original content", async () => {
  const simulator = new DeterministicLiveSimulator(); const stateClip = (simulator as any).state.tracks[0].clips[0]; stateClip.notes.push({ ...structuredClone(stateClip.notes[0]), id: 2, pitch: 38, start: 1 }); stateClip.notesRevision = "partial-delete-before"; const original = simulator.invokeAsync.bind(simulator); let injected = false;
  simulator.invokeAsync = async (invocation) => { if (invocation.operation === "note.delete" && !injected) { injected = true; stateClip.notes.splice(0, stateClip.notes.length); stateClip.notesRevision = "partial-delete-after"; throw new Error("injected partial note deletion"); } return original(invocation); };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const preview = JSON.parse(((await call(201, "live_note_delete_preview", { clipRef: "clip:clip-1", noteIds: [1] })) as any).result.content[0].text); const uncertain = await call(202, "live_note_delete_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "partial-note-delete" }); assert.equal((uncertain as any).result.isError, true);
  const recovered = JSON.parse(((await call(203, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "partial-note-delete-undo" })) as any).result.content[0].text); assert.equal(recovered.state, "undone"); assert.equal(recovered.recoveredFromUncertainApply, true); assert.deepEqual(stateClip.notes.map((note: any) => note.pitch).sort(), [36, 38]);
});

test("uncertain note-delete recovery refuses an external channel conflict before re-adding", async () => {
  const simulator = new DeterministicLiveSimulator(); const stateClip = (simulator as any).state.tracks[0].clips[0]; stateClip.notes.push({ ...structuredClone(stateClip.notes[0]), id: 2, pitch: 38, start: 1 }); stateClip.notesRevision = "channel-conflict-before"; const original = simulator.invokeAsync.bind(simulator); let injected = false;
  simulator.invokeAsync = async (invocation) => { if (invocation.operation === "note.delete" && !injected) { injected = true; stateClip.notes.splice(0, 1); stateClip.notes[0].channel = 2; stateClip.notesRevision = "channel-conflict-after"; throw new Error("injected channel conflict"); } return original(invocation); };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const preview = JSON.parse(((await call(211, "live_note_delete_preview", { clipRef: "clip:clip-1", noteIds: [1] })) as any).result.content[0].text); assert.equal((await call(212, "live_note_delete_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "channel-conflict-delete" }) as any).result.isError, true); const refused = await call(213, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "channel-conflict-undo" }); assert.equal((refused as any).result.isError, true); assert.equal(stateClip.notes.length, 1); assert.equal(stateClip.notes[0].channel, 2);
});

test("clip duplicate, arrangement lifecycle, move, and audio clip edits verify and fence", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  // Duplicate to an exact empty Session slot.
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
  (simulator as any).state.tracks[0].clipSlots!.push({ ref: "clip-slot:track-1:1" as any, parentRef: "track:track-1" as any, objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const stalePreview = JSON.parse(((await call(200, "live_clip_duplicate_preview", { clipRef: "clip:clip-1", targetTrackRef: "track:track-1", targetSceneIndex: 1 })) as any).result.content[0].text);
  const sourceClip = (simulator as any).state.tracks[0].clips[0]; const sourceName = sourceClip.name; sourceClip.name = "External edit after preview";
  const staleApply = await call(201, "live_clip_duplicate_apply", { transactionId: stalePreview.transactionId, confirmation: "apply", idempotencyKey: "stale-duplicate" });
  assert.equal((staleApply as any).result.isError, true); assert.equal((simulator as any).state.tracks[0].clipSlots[1].clipRef, null); sourceClip.name = sourceName;
  const dupPreview = JSON.parse(((await call(2, "live_clip_duplicate_preview", { clipRef: "clip:clip-1", targetTrackRef: "track:track-1", targetSceneIndex: 1 })) as any).result.content[0].text);
  const dup = JSON.parse(((await call(3, "live_clip_duplicate_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "dup-1-key" })) as any).result.content[0].text);
  assert.equal(dup.state, "applied");
  const dupReplay = JSON.parse(((await call(4, "live_clip_duplicate_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "dup-1-key" })) as any).result.content[0].text);
  assert.equal(dupReplay.idempotent, true);
  const dupUndone = JSON.parse(((await call(40, "live_undo", { transactionId: dupPreview.transactionId, confirmation: "undo", idempotencyKey: "dup-undo" })) as any).result.content[0].text);
  assert.equal(dupUndone.state, "undone");

  // Duplicate into the Arrangement
  const arrDupPreview = JSON.parse(((await call(5, "live_clip_duplicate_preview", { clipRef: "clip:clip-1", arrangementPosition: 8 })) as any).result.content[0].text);
  const arrDup = JSON.parse(((await call(6, "live_clip_duplicate_apply", { transactionId: arrDupPreview.transactionId, confirmation: "apply", idempotencyKey: "dup-arr-key" })) as any).result.content[0].text);
  assert.equal(arrDup.state, "applied");
  assert.equal(((simulator as any).state.arrangementClips ?? []).length, 1);

  // Move the retained Arrangement duplicate, then create and transaction-owned-clean a temporary clip.
  const retainedArrangementRef = (arrDup.created as any).ref;
  const movePreview = JSON.parse(((await call(9, "live_clip_move_preview", { clipRef: retainedArrangementRef, position: 16 })) as any).result.content[0].text);
  const moved = JSON.parse(((await call(10, "live_clip_move_apply", { transactionId: movePreview.transactionId, confirmation: "apply", idempotencyKey: "move-1-key" })) as any).result.content[0].text);
  assert.equal(moved.state, "applied");
  const moveUndone = JSON.parse(((await call(101, "live_undo", { transactionId: movePreview.transactionId, confirmation: "undo", idempotencyKey: "move-undo" })) as any).result.content[0].text);
  assert.equal(moveUndone.state, "undone");
  const createPreview = JSON.parse(((await call(7, "live_arrangement_clip_preview", { action: "create", trackRef: "track:track-1", position: 16, length: 4, name: "Arranged" })) as any).result.content[0].text);
  const created = JSON.parse(((await call(8, "live_arrangement_clip_apply", { transactionId: createPreview.transactionId, confirmation: "apply", idempotencyKey: "arr-1-key" })) as any).result.content[0].text);
  assert.equal(created.state, "applied");
  const createdRef = (created.result as any).ref;
  const arbitraryDelete = await call(11, "live_arrangement_clip_preview", { action: "delete", clipRef: createdRef });
  assert.equal((arbitraryDelete as any).result.isError, true);
  const deleted = JSON.parse(((await call(12, "live_undo", { transactionId: createPreview.transactionId, confirmation: "undo", idempotencyKey: "arr-create-undo" })) as any).result.content[0].text);
  assert.equal(deleted.state, "undone");

  // Session slot move (duplicate + delete source)
  (simulator as any).state.scenes.push({ ref: "scene:scene-3", objectIdentity: "simulator:scene:scene-3", name: "Scene 3", index: 2 });
  (simulator as any).state.tracks[0].clipSlots!.push({ ref: "clip-slot:track-1:2" as any, parentRef: "track:track-1" as any, objectIdentity: "simulator:clip-slot:track-1:2", sceneIndex: 2, clipRef: null, empty: true });
  const slotMovePreview = JSON.parse(((await call(13, "live_clip_move_preview", { clipRef: "clip:clip-1", targetTrackRef: "track:track-1", targetSceneIndex: 2 })) as any).result.content[0].text);
  const slotMoved = JSON.parse(((await call(14, "live_clip_move_apply", { transactionId: slotMovePreview.transactionId, confirmation: "apply", idempotencyKey: "move-slot" })) as any).result.content[0].text);
  assert.equal(slotMoved.state, "applied");
  assert.equal(((simulator as any).state.tracks[0].clipSlots ?? [])[2]!.clipRef !== undefined, true);
  const slotMoveUndone = JSON.parse(((await call(141, "live_undo", { transactionId: slotMovePreview.transactionId, confirmation: "undo", idempotencyKey: "move-slot-undo" })) as any).result.content[0].text);
  assert.equal(slotMoveUndone.state, "undone");

  // Audio clip edits against the now-empty identity-bound destination slot.
  const beforeAudio = simulator.snapshot(); const audioTrack = beforeAudio.tracks[0]!; const audioSlot = audioTrack.clipSlots![2]!; const audioScene = beforeAudio.scenes[2]!;
  const audioClip = simulator.invoke({ operation: "clip.create", args: { trackRef: audioTrack.ref, kind: "audio", name: "Audio", sceneIndex: 2, length: 8, expectedTrackIdentity: audioTrack.objectIdentity, expectedSlotRef: audioSlot.ref, expectedSlotIdentity: audioSlot.objectIdentity, expectedSceneRef: audioScene.ref, expectedSceneIdentity: audioScene.objectIdentity } }) as any;
  const audioPreview = JSON.parse(((await call(15, "live_audio_clip_preview", { clipRef: audioClip.ref, gain: 0.5, pitchCoarse: -3, pitchFine: 12, loopStart: 1, loopEnd: 7, warpMode: 2, warping: false, fadeInLength: 0.25, fadeOutLength: 0.5 })) as any).result.content[0].text);
  const audioApplied = JSON.parse(((await call(16, "live_audio_clip_apply", { transactionId: audioPreview.transactionId, confirmation: "apply", idempotencyKey: "audio-1-key" })) as any).result.content[0].text);
  assert.equal(audioApplied.state, "applied");
  const audioRow = (simulator as any).state.tracks[0].clips.find((c: any) => c.ref === audioClip.ref)!;
  assert.equal((audioRow as any).gain, 0.5); assert.equal((audioRow as any).warping, false); assert.equal((audioRow as any).fadeOutLength, 0.5);
  assert.equal((audioRow as any).pitchCoarse, -3);
  assert.equal((audioRow as any).warpMode, 2);
  const audioUndone = JSON.parse(((await call(17, "live_undo", { transactionId: audioPreview.transactionId, confirmation: "undo", idempotencyKey: "audio-undo" })) as any).result.content[0].text);
  assert.equal(audioUndone.state, "undone"); assert.equal((audioRow as any).gain, 1);
});

test("mixer edits fence on the mixer row and guardedly undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_mixer_preview", { trackRef: "track:track-1", volume: 0.5, pan: -0.25, cueVolume: 0.75, sends: [0.75, 0.5], solo: true })) as any).result.content[0].text);
  assert.equal(preview.prior.volume, 0.85);
  const applied = JSON.parse(((await call(3, "live_mixer_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "mixer-1-key" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.mixer.volume, 0.5);
  assert.equal(track.mixer.pan, -0.25);
  assert.equal(track.mixer.cueVolume, 0.75);
  assert.deepEqual(track.mixer.sends, [0.75, 0.5]);
  assert.equal(track.mixer.solo, true);
  const replay = JSON.parse(((await call(4, "live_mixer_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "mixer-1-key" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "mixer-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal(track.mixer.volume, 0.85);
  assert.equal(track.mixer.solo, false);
});

test("view switching and arrangement view control apply with confirmation and idempotency", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_view_preview", { view: "Arranger" })) as any).result.content[0].text);
  assert.equal(preview.operation, "view.set"); assert.equal(preview.prior.view.visibleView, "Session");
  const applied = JSON.parse(((await call(3, "live_view_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "view-key-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied"); assert.equal((simulator as any).state.view.visibleView, "Arranger");
  const replay = JSON.parse(((await call(4, "live_view_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "view-key-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const followPreview = JSON.parse(((await call(5, "live_view_preview", { action: "follow-on" })) as any).result.content[0].text);
  assert.equal(followPreview.operation, "view.control");
  await call(6, "live_view_apply", { transactionId: followPreview.transactionId, confirmation: "apply", idempotencyKey: "view-key-2" });
  assert.equal((simulator as any).state.view.follow, true);
  const zoom = JSON.parse(((await call(7, "live_view_preview", { action: "zoom-in" })) as any).result.content[0].text);
  const zoomed = JSON.parse(((await call(8, "live_view_apply", { transactionId: zoom.transactionId, confirmation: "apply", idempotencyKey: "view-key-3" })) as any).result.content[0].text);
  assert.equal(zoomed.result.done, true);
  const collapse = JSON.parse(((await call(9, "live_view_preview", { action: "collapse-track", trackRef: "track:track-1" })) as any).result.content[0].text);
  const collapsed = JSON.parse(((await call(10, "live_view_apply", { transactionId: collapse.transactionId, confirmation: "apply", idempotencyKey: "view-key-4" })) as any).result.content[0].text);
  assert.equal(collapsed.state, "applied");
  assert.equal(((await call(11, "live_view_preview", {})) as any).error.code, -32602);
  assert.equal(((await call(12, "live_view_preview", { view: "Session", action: "zoom-in" })) as any).error.code, -32602);
  assert.equal(((await call(13, "live_view_preview", { action: "detonate" })) as any).error.code, -32602);
  assert.equal(((await call(14, "live_view_preview", { action: "collapse-track" })) as any).error.code, -32602);
  assert.equal(((await call(15, "live_view_preview", { action: "collapse-track", trackRef: "track:bogus" })) as any).result.isError, true);
});

test("locator jump preview fences the playhead and applies with exact position verification", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  (simulator as any).state.arrangement.locators.push({ ref: "locator:locator-2", objectIdentity: "simulator:locator:locator-2", name: "B", position: 8 });
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_locator_jump_preview", { direction: "next" })) as any).result.content[0].text);
  assert.equal(preview.target, 8); assert.equal(preview.current, 0);
  const applied = JSON.parse(((await call(3, "live_locator_jump_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "jump-key-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied"); assert.equal(applied.result.position, 8);
  assert.equal((simulator as any).state.playback.transport.position, 8);
  const replay = JSON.parse(((await call(4, "live_locator_jump_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "jump-key-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const backPreview = JSON.parse(((await call(5, "live_locator_jump_preview", { direction: "previous" })) as any).result.content[0].text);
  const backApplied = JSON.parse(((await call(6, "live_locator_jump_apply", { transactionId: backPreview.transactionId, confirmation: "apply", idempotencyKey: "jump-key-2" })) as any).result.content[0].text);
  assert.equal(backApplied.result.position, 0);
  const stale = JSON.parse(((await call(7, "live_locator_jump_preview", { direction: "next" })) as any).result.content[0].text);
  (simulator as any).state.playback.transport.position = 4;
  assert.equal(((await call(8, "live_locator_jump_apply", { transactionId: stale.transactionId, confirmation: "apply", idempotencyKey: "jump-key-3" })) as any).result.isError, true);
  (simulator as any).state.playback.transport.position = 0;
  assert.equal(((await call(9, "live_locator_jump_preview", { direction: "sideways" })) as any).error.code, -32602);
});

test("clip properties edit mutes, colors, and MIDI loops with fenced apply and guarded undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const clipRef = "clip:clip-1";
  const preview = JSON.parse(((await call(2, "live_clip_properties_preview", { clipRef, muted: true, colorIndex: 42, looping: true, loopStart: 1, loopEnd: 3 })) as any).result.content[0].text);
  assert.equal(preview.prior.muted, false); assert.equal(preview.prior.colorIndex, 0);
  const applied = JSON.parse(((await call(3, "live_clip_properties_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "clipset-key-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const clip = (simulator as any).state.tracks[0].clips[0];
  assert.equal(clip.muted, true); assert.equal(clip.colorIndex, 42); assert.equal(clip.looping, true);
  assert.equal(clip.loopStart, 1); assert.equal(clip.loopEnd, 3);
  const replay = JSON.parse(((await call(4, "live_clip_properties_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "clipset-key-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "clipset-undo-key" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal(clip.muted, false); assert.equal(clip.colorIndex, 0); assert.equal(clip.loopStart, 0); assert.equal(clip.loopEnd, 4);
  const audioRef = "clip:audio-1";
  (simulator as any).state.tracks[0].clips.push({ ref: audioRef, objectIdentity: "simulator:clip:audio-1", name: "Audio", kind: "audio", isAudio: true, start: 0, length: 4, notes: [], warp: true, takes: [], automation: [], muted: false, colorIndex: 1 });
  const audioLoopRefusal = JSON.parse(((await call(6, "live_clip_properties_preview", { clipRef: audioRef, looping: false })) as any).result.content[0].text);
  assert.match(audioLoopRefusal.reason, /audio clip loop editing/i);
  assert.equal(((await call(9, "live_clip_properties_preview", { clipRef, loopStart: 3.5, loopEnd: 2 })) as any).error.code, -32602);
  assert.equal(((await call(10, "live_clip_properties_preview", { clipRef })) as any).error.code, -32602);
  assert.equal(((await call(11, "live_clip_properties_preview", { clipRef, colorIndex: 70 })) as any).error.code, -32602);
});

test("arrangement audio import creates a file-backed clip with exact fencing and guarded cleanup", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_arrangement_clip_preview", { action: "create", kind: "audio", trackRef: "track:track-1", position: 4, filePath: "/tmp/demo.wav", name: "Imported" })) as any).result.content[0].text);
  assert.equal(preview.kind, "audio"); assert.equal(preview.impact, "creates-arrangement-audio-clip");
  const applied = JSON.parse(((await call(3, "live_arrangement_clip_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "arr-audio-key-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied"); assert.equal(applied.result.filePath, "/tmp/demo.wav");
  const row = (simulator as any).state.arrangementClips.find((item: any) => item.clip.filePath === "/tmp/demo.wav");
  assert.ok(row); assert.equal(row.clip.kind, "audio"); assert.equal(row.clip.start, 4); assert.equal(row.clip.name, "Imported");
  const undone = JSON.parse(((await call(4, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "arr-audio-undo-key" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal((simulator as any).state.arrangementClips.some((item: any) => item.clip.filePath === "/tmp/demo.wav"), false);
  assert.equal(((await call(5, "live_arrangement_clip_preview", { action: "create", kind: "audio", trackRef: "track:track-1", position: 0 })) as any).error.code, -32602);
  const midiPreview = JSON.parse(((await call(6, "live_arrangement_clip_preview", { action: "create", trackRef: "track:track-1", position: 12, length: 4, name: "Midi Clip" })) as any).result.content[0].text);
  const midiApplied = JSON.parse(((await call(7, "live_arrangement_clip_apply", { transactionId: midiPreview.transactionId, confirmation: "apply", idempotencyKey: "arr-midi-key-1" })) as any).result.content[0].text);
  assert.equal(midiApplied.state, "applied");
});

test("automation envelope lifecycle inserts, reads, deletes, and restores points", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const volumeRef = "parameter:mixer:0:volume";
  const create = JSON.parse(((await call(2, "live_automation_preview", { action: "create-envelope", clipRef: "clip:clip-1", parameterRef: volumeRef })) as any).result.content[0].text);
  const created = JSON.parse(((await call(3, "live_automation_apply", { transactionId: create.transactionId, confirmation: "apply", idempotencyKey: "env-1-key" })) as any).result.content[0].text);
  assert.equal(created.state, "applied");
  const insert = JSON.parse(((await call(4, "live_automation_preview", { action: "insert", clipRef: "clip:clip-1", parameterRef: volumeRef, points: [{ time: 0, value: 0.9 }, { time: 2, value: 0.4 }, { time: 3.5, value: 0.7 }] })) as any).result.content[0].text);
  const inserted = JSON.parse(((await call(5, "live_automation_apply", { transactionId: insert.transactionId, confirmation: "apply", idempotencyKey: "env-ins-key" })) as any).result.content[0].text);
  assert.equal(inserted.state, "applied");
  const clip = (simulator as any).state.tracks[0].clips[0];
  assert.equal(clip.envelopes[volumeRef].length, 3);
  const conflict = JSON.parse(((await call(6, "live_automation_preview", { action: "insert", clipRef: "clip:clip-1", parameterRef: volumeRef, points: [{ time: 1, value: 0.2 }] })) as any).result.content[0].text);
  assert.equal(conflict.current.points.length, 3);
  const delRange = JSON.parse(((await call(7, "live_automation_preview", { action: "delete-range", clipRef: "clip:clip-1", parameterRef: volumeRef, from: 1, to: 4 })) as any).result.content[0].text);
  const deleted = JSON.parse(((await call(8, "live_automation_apply", { transactionId: delRange.transactionId, confirmation: "apply", idempotencyKey: "env-del-key" })) as any).result.content[0].text);
  assert.equal(deleted.state, "applied");
  assert.equal(clip.envelopes[volumeRef].length, 1);
  const undone = JSON.parse(((await call(9, "live_undo", { transactionId: delRange.transactionId, confirmation: "undo", idempotencyKey: "env-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal(clip.envelopes[volumeRef].length, 3);
  const exactPrior = structuredClone(clip.envelopes[volumeRef]);
  const spanInsert = JSON.parse(((await call(10, "live_automation_preview", { action: "insert", clipRef: "clip:clip-1", parameterRef: volumeRef, points: [{ time: 1, value: 0.2 }, { time: 3, value: 0.6 }] })) as any).result.content[0].text);
  await call(11, "live_automation_apply", { transactionId: spanInsert.transactionId, confirmation: "apply", idempotencyKey: "env-span-insert" });
  const spanUndone = JSON.parse(((await call(12, "live_undo", { transactionId: spanInsert.transactionId, confirmation: "undo", idempotencyKey: "env-span-undo" })) as any).result.content[0].text);
  assert.equal(spanUndone.state, "undone");
  assert.deepEqual(clip.envelopes[volumeRef], exactPrior);
});

test("browser search returns stable identities and browser load verifies onto the target track", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const search = JSON.parse(((await call(2, "live_browser_search", { category: "instruments", query: "rack" })) as any).result.content[0].text);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].id, "instruments/Drum Rack");
  const empty = JSON.parse(((await call(3, "live_browser_search", { query: "nonexistent-xyz" })) as any).result.content[0].text);
  assert.equal(empty.items.length, 0);
  const unsafeNonDevice = await call(20, "live_browser_load_preview", { itemId: "drums/Kick Core", trackRef: "track:track-1" });
  assert.equal((unsafeNonDevice as any).result.isError, true); assert.equal((simulator as any).state.tracks[0].devices.length, 1);
  const preview = JSON.parse(((await call(4, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text);
  const [firstApply, concurrentReplay] = await Promise.all([
    call(5, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "load-1-key" }),
    call(6, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "load-1-key" }),
  ]);
  const applied = JSON.parse((firstApply as any).result.content[0].text); const concurrent = JSON.parse((concurrentReplay as any).result.content[0].text);
  assert.equal(applied.state, "applied"); assert.equal(concurrent.idempotent, true);
  assert.ok(applied.deviceRef.startsWith("device:"));
  const rack = (simulator as any).state.tracks[0].devices.at(-1);
  assert.equal(rack.name, "Drum Rack");
  assert.equal(rack.canHaveDrumPads, true);
  assert.equal(rack.drumPads.length, 16);
  assert.equal((simulator as any).state.tracks[0].devices.filter((item: any) => item.name === "Drum Rack").length, 1);
  const replay = JSON.parse(((await call(7, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "load-1-key" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(8, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "load-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone"); assert.equal((simulator as any).state.tracks[0].devices.filter((item: any) => item.name === "Drum Rack").length, 0);
});

test("a lost Browser-load acknowledgement reconciles with the exact key and retains safe undo", async () => {
  const simulator = new DeterministicLiveSimulator(); const original = simulator.invokeAsync.bind(simulator); let cached: unknown; let first = true; let dispatches = 0;
  simulator.invokeAsync = async (invocation) => { if (invocation.operation !== "browser.load") return original(invocation); if (first) { first = false; dispatches += 1; cached = await original(invocation); throw new Error("remote adapter request state uncertain after dispatch timeout"); } return cached; };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(7300, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text);
  const uncertain = await call(7301, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "browser-lost-ack" }); assert.equal((uncertain as any).result.isError, true);
  const reconciled = JSON.parse(((await call(7302, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "browser-lost-ack" })) as any).result.content[0].text); assert.equal(reconciled.state, "applied"); assert.equal(dispatches, 1);
  const undone = JSON.parse(((await call(7303, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "browser-lost-undo" })) as any).result.content[0].text); assert.equal(undone.state, "undone");
});

test("lost cleanup acknowledgement replays exact undo authority and rejects a new key", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(7320, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text); await call(7321, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "cleanup-apply" });
  const original = simulator.invokeAsync.bind(simulator); let cached: unknown; let deleteDispatches = 0; simulator.invokeAsync = async (invocation) => { if (invocation.operation !== "device.delete") return original(invocation); if (deleteDispatches === 0) { deleteDispatches += 1; cached = await original(invocation); throw new Error("remote adapter request state uncertain after dispatch timeout"); } return cached; };
  const uncertain = await call(7322, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "cleanup-undo" }); assert.equal((uncertain as any).result.isError, true);
  const wrong = await call(7323, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "cleanup-wrong" }); assert.equal((wrong as any).result.isError, true);
  const reconciled = JSON.parse(((await call(7324, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "cleanup-undo" })) as any).result.content[0].text); assert.equal(reconciled.state, "undone"); assert.equal(deleteDispatches, 1);
});

test("partial multi-step structure undo resumes exact replay and remaining cleanup", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(7330, "live_session_structure_preview", { tracks: [{ name: "Recovery Track", kind: "midi", index: 1 }], scenes: [{ name: "Recovery Scene", index: 1 }] })) as any).result.content[0].text); await call(7331, "live_session_structure_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "structure-recovery-apply" });
  const original = simulator.invokeAsync.bind(simulator); const cache = new Map<string, unknown>(); let dropped = false; let destructiveDispatches = 0; simulator.invokeAsync = async (invocation) => { if (!["track.delete", "scene.delete"].includes(invocation.operation)) return original(invocation); const key = JSON.stringify(invocation); if (cache.has(key)) return cache.get(key); destructiveDispatches += 1; const result = await original(invocation); cache.set(key, result); if (!dropped) { dropped = true; throw new Error("remote adapter request state uncertain after dispatch timeout"); } return result; };
  const uncertain = await call(7332, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "structure-recovery-undo" }); assert.equal((uncertain as any).result.isError, true);
  const reconciled = JSON.parse(((await call(7333, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "structure-recovery-undo" })) as any).result.content[0].text); assert.equal(reconciled.state, "undone"); assert.equal(destructiveDispatches, 2); const snapshot = simulator.snapshot(); assert.equal(snapshot.tracks.some((track) => track.name === "Recovery Track"), false); assert.equal(snapshot.scenes.some((scene) => scene.name === "Recovery Scene"), false);
});

test("failed structure apply reconciles acknowledgement-lost compensation without residuals", async () => {
  const simulator = new DeterministicLiveSimulator(); const original = simulator.invokeAsync.bind(simulator); let cachedDelete: unknown; let deleteDispatches = 0; simulator.invokeAsync = async (invocation) => { if (invocation.operation === "track.create") { const result = await original(invocation) as any; return { ...result, name: "semantic-mismatch" }; } if (invocation.operation === "track.delete") { if (deleteDispatches === 0) { deleteDispatches += 1; cachedDelete = await original(invocation); throw new Error("remote adapter request state uncertain after dispatch timeout"); } return cachedDelete; } return original(invocation); };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const preview = JSON.parse(((await call(7340, "live_session_structure_preview", { tracks: [{ name: "Compensate Me", kind: "midi", index: 1 }], scenes: [] })) as any).result.content[0].text);
  const failed = await call(7341, "live_session_structure_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "structure-compensate" }); assert.equal((failed as any).result.isError, true);
  const reconciled = JSON.parse(((await call(7342, "live_session_structure_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "structure-compensate" })) as any).result.content[0].text); assert.equal(reconciled.state, "compensated"); assert.deepEqual(reconciled.residuals, []); assert.equal(deleteDispatches, 1); assert.equal(simulator.snapshot().tracks.some((track) => track.name === "semantic-mismatch"), false);
});

test("recovery finalization cannot race an in-flight undo", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const evidence = { provenance: "operator fresh authoritative inspection", scope: "transaction-owned browser device" };
  const preview = JSON.parse(((await call(7350, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text); await call(7351, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "race-finalize-apply" });
  const original = simulator.invokeAsync.bind(simulator); let started!: () => void; const dispatched = new Promise<void>((resolve) => { started = resolve; }); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); simulator.invokeAsync = async (invocation) => { if (invocation.operation === "device.delete") { started(); await gate; } return original(invocation); };
  const undoing = call(7352, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "race-finalize-undo" }); await dispatched; const refused = await call(7353, "live_recovery_finalize", { transactionId: preview.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence }); assert.equal((refused as any).result.isError, true); release(); const undone = JSON.parse(((await undoing) as any).result.content[0].text); assert.equal(undone.state, "undone");
});

test("audio-capture recovery records finalize only after exact mapper-cleaned stopped evidence", async () => {
  const simulator = new DeterministicLiveSimulator(); const snapshot = simulator.snapshot(); const captureId = "capture-finalize-1234"; const transactionId = "audio_capture_finalize_1234";
  const adapter: any = { ...simulator, status: () => ({ ...simulator.status(), adapter: "remote-script", provenance: "real-live", capabilities: [...(simulator.status().capabilities ?? []), "audio.capture.resampling"], operations: [...(simulator.status().operations ?? []), "audio.capture.status"] }), snapshot: () => simulator.snapshot(), snapshotAsync: async () => simulator.snapshot(), getAsync: async (ref: LiveRef) => simulator.get(ref), discoverAsync: simulator.discoverAsync.bind(simulator), invokeAsync: async (invocation: LiveInvocation) => invocation.operation === "audio.capture.status" ? { captureId, sourceSlotRef: "clip-slot:track-1:0", destinationSlotRef: "clip-slot:track-1:1", state: "cleaned", active: false, playbackStopped: true, residual: [] } : simulator.invoke(invocation), reconnectAsync: async () => simulator.status(), subscribe: simulator.subscribe.bind(simulator), reconnect: simulator.reconnect.bind(simulator), get: simulator.get.bind(simulator), invoke: simulator.invoke.bind(simulator) };
  const host = new McpHost(adapter); ready(host); (host as any).audioCaptureTransactions.set(transactionId, { id: transactionId, captureId, epoch: 1, setName: snapshot.set.name, sourceSlotRef: "clip-slot:track-1:0", destinationSlotRef: "clip-slot:track-1:1", destinationTrackRef: "track:track-1", fence: "f", prior: {}, durationMs: 1000, outputSafety: {}, confirmation: "c", expiresAt: Date.now() + 1000, state: "uncertain" });
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 7354, method: "tools/call", params: { name: "live_recovery_finalize", arguments: { transactionId, resolution: "manually-restored", confirmation: "finalize-recovery-record", evidence: { provenance: "mapper emergency cleanup", scope: "exact capture identity and stopped state" } } } }) as any; assert.equal(JSON.parse(result.result.content[0].text).recoveryAuthorityRetired, true);
});

test("recovery finalization globally refuses playback, recording, and realtime authority including MIDI", async () => {
  const simulator = new DeterministicLiveSimulator(); const originalStatus = simulator.status.bind(simulator); const originalInvoke = simulator.invokeAsync.bind(simulator); let realtimeArmed = true;
  simulator.status = () => ({ ...originalStatus(), operations: [...new Set([...(originalStatus().operations ?? []), "realtime.stats"])] });
  simulator.invokeAsync = async (invocation) => invocation.operation === "realtime.stats" ? { armed: realtimeArmed, pending: 0 } : originalInvoke(invocation);
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 }); (simulator as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const evidence = { provenance: "operator fresh authoritative inspection", scope: "exact MIDI transaction accepted in current state" };
  const preview = JSON.parse(((await call(7360, "live_midi_clip_preview", { trackRef: "track:track-1", sceneIndex: 1, name: "Finalize MIDI", length: 4, notes: [{ pitch: 60, start: 0, duration: 0.25, velocity: 100, channel: 1 }] })) as any).result.content[0].text); await call(7361, "live_midi_clip_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "midi-finalize-apply" }); const finalizeArgs = { transactionId: preview.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence };
  assert.equal((await call(7362, "live_recovery_finalize", finalizeArgs) as any).result.isError, true);
  realtimeArmed = false; (simulator as any).state.playback.transport.playing = true; assert.equal((await call(7363, "live_recovery_finalize", finalizeArgs) as any).result.isError, true);
  (simulator as any).state.playback.transport.playing = false; (simulator as any).state.playback.transport.arrangementRecord = true; assert.equal((await call(7364, "live_recovery_finalize", finalizeArgs) as any).result.isError, true);
  (simulator as any).state.playback.transport.arrangementRecord = false; const finalFrame = await call(7365, "live_recovery_finalize", finalizeArgs) as any; assert.equal(finalFrame.result.isError, false, finalFrame.result.content[0].text); const finalized = JSON.parse(finalFrame.result.content[0].text); assert.equal(finalized.finalized, true); assert.equal(finalized.recoveryAuthorityRetired, true);
});

test("recovery finalization refuses every already in-flight transaction mutation", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const evidence = { provenance: "operator fresh authoritative inspection", scope: "global in-flight safety" };
  const browser = JSON.parse(((await call(7380, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text); await call(7381, "live_browser_load_apply", { transactionId: browser.transactionId, confirmation: "apply", idempotencyKey: "global-browser-apply" }); const rename = JSON.parse(((await call(7382, "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "In Flight Rename" })) as any).result.content[0].text);
  const original = simulator.invokeAsync.bind(simulator); let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; }); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); simulator.invokeAsync = async (invocation) => { if (invocation.operation === "track.rename") { signalStarted(); await gate; } return original(invocation); };
  const applying = call(7383, "live_object_rename_apply", { transactionId: rename.transactionId, confirmation: "apply", idempotencyKey: "global-rename-apply" }); await started;
  const refused = await call(7384, "live_recovery_finalize", { transactionId: browser.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence }); assert.equal((refused as any).result.isError, true); assert.match((refused as any).result.content[0].text, /in flight/);
  release(); assert.equal((await applying as any).result.isError, false);
});

test("recovery finalization refuses an already in-flight unscoped emergency mutation", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const evidence = { provenance: "operator fresh authoritative inspection", scope: "unscoped emergency operation" };
  const browser = JSON.parse(((await call(7390, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text); await call(7391, "live_browser_load_apply", { transactionId: browser.transactionId, confirmation: "apply", idempotencyKey: "unscoped-browser-apply" });
  const original = simulator.invokeAsync.bind(simulator); let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; }); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); simulator.invokeAsync = async (invocation) => { if (invocation.operation === "session.emergency-stop") { signalStarted(); await gate; } return original(invocation); };
  const stopping = call(7392, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [], expectedRecording: "stopped", idempotencyKey: "unscoped-emergency-stop" }); await started;
  const refused = await call(7393, "live_recovery_finalize", { transactionId: browser.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence }); assert.equal((refused as any).result.isError, true); assert.match((refused as any).result.content[0].text, /in flight/);
  release(); assert.equal((await stopping as any).result.isError, false);
});

test("terminal recovery retirement serializes every other Host mutation", async () => {
  const simulator = new DeterministicLiveSimulator(); const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const evidence = { provenance: "operator fresh authoritative inspection", scope: "serialized terminal recovery" };
  const browser = JSON.parse(((await call(7370, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text); await call(7371, "live_browser_load_apply", { transactionId: browser.transactionId, confirmation: "apply", idempotencyKey: "barrier-browser-apply" });
  const parameter = simulator.snapshot().tracks[0]!.devices[0]!.parameters[0]!; const syncPreview = JSON.parse(((host.handle({ jsonrpc: "2.0", id: 7375, method: "tools/call", params: { name: "live_device_parameter_preview", arguments: { deviceRef: "device:utility-1", parameterRef: parameter.ref, value: 0.75 } } }) as any).result.content[0].text));
  const rename = JSON.parse(((await call(7372, "live_object_rename_preview", { kind: "track", ref: "track:track-1", name: "Must Not Race" })) as any).result.content[0].text);
  let signalRetire!: () => void; const retiring = new Promise<void>((resolve) => { signalRetire = resolve; }); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  (simulator as any).retireTransactionAsync = async (_transactionId: string, _context: unknown, terminal: boolean) => { assert.equal(terminal, true); signalRetire(); await gate; return { retired: 1 }; };
  const finalizing = call(7373, "live_recovery_finalize", { transactionId: browser.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence }); await retiring;
  const raced = await call(7374, "live_object_rename_apply", { transactionId: rename.transactionId, confirmation: "apply", idempotencyKey: "barrier-rename-apply" }); assert.equal((raced as any).result.isError, true); assert.equal((simulator.get("track:track-1") as any).name, "Drums");
  const syncRaced = host.handle({ jsonrpc: "2.0", id: 7376, method: "tools/call", params: { name: "live_device_parameter_apply", arguments: { transactionId: syncPreview.transactionId, confirmation: "apply", idempotencyKey: "barrier-sync-parameter" } } }) as any; assert.equal(syncRaced.result.isError, true); assert.equal((simulator.get(parameter.ref) as any).value, parameter.value);
  release(); const finalized = JSON.parse(((await finalizing) as any).result.content[0].text); assert.equal(finalized.finalized, true);
});

test("explicit recovery finalization retires uncertain authority but refuses active audition playback", async () => {
  const simulator = new DeterministicLiveSimulator(); const original = simulator.invokeAsync.bind(simulator); simulator.invokeAsync = async (invocation) => { if (invocation.operation === "browser.load") { await original(invocation); throw new Error("remote adapter request state uncertain after dispatch timeout"); } return original(invocation); };
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const evidence = { provenance: "operator fresh authoritative inspection", scope: "transaction-owned browser device accepted in current state" };
  const preview = JSON.parse(((await call(7310, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text); const uncertain = await call(7311, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "finalize-browser" }); assert.equal((uncertain as any).result.isError, true);
  const finalized = JSON.parse(((await call(7312, "live_recovery_finalize", { transactionId: preview.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence })) as any).result.content[0].text); assert.equal(finalized.recoveryAuthorityRetired, true); assert.equal(finalized.liveMutated, false);
  const fixture = auditionFixture(); const song = new McpHost(fixture.adapter); ready(song); const songCall = (id: number, name: string, args: unknown) => song.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const audition = JSON.parse(((await songCall(7313, "live_session_audition_preview", { sceneRef: "scene:scene-1", setName: "Disposable Set", outputSafety: { safe: true, provenance: "operator-confirmed-headphones", scope: "master" } })) as any).result.content[0].text); await songCall(7314, "live_session_audition_apply", { transactionId: audition.transactionId, confirmation: "launch", idempotencyKey: "launch-finalize" }); const refused = await songCall(7315, "live_recovery_finalize", { transactionId: audition.transactionId, resolution: "accepted-current-state", confirmation: "finalize-recovery-record", evidence }); assert.equal((refused as any).result.isError, true);
});

test("an in-flight Browser mutation cannot be evicted by preview pressure", async () => {
  const simulator = new DeterministicLiveSimulator(); const originalInvoke = simulator.invokeAsync.bind(simulator);
  let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  simulator.invokeAsync = async (invocation: LiveInvocation) => { if (invocation.operation === "browser.load") { signalStarted(); await gate; } return originalInvoke(invocation); };
  const host = new McpHost(simulator); ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(7000, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text);
  const applying = call(7001, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "pressure-apply" }); await started;
  for (let index = 0; index < 80; index += 1) await call(7100 + index, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" });
  release(); const applied = JSON.parse(((await applying) as any).result.content[0].text); assert.equal(applied.state, "applied");
  const replay = JSON.parse(((await call(7200, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "pressure-apply" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
});

test("device insert, enable, move, and transaction-owned cleanup use exact fencing", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const insert = JSON.parse(((await call(2, "live_device_preview", { action: "insert", trackRef: "track:track-1", deviceName: "Echo" })) as any).result.content[0].text);
  const inserted = JSON.parse(((await call(3, "live_device_apply", { transactionId: insert.transactionId, confirmation: "apply", idempotencyKey: "dev-ins-key" })) as any).result.content[0].text);
  assert.equal(inserted.state, "applied");
  const deviceRef = (inserted.result as any).ref;
  const enable = JSON.parse(((await call(4, "live_device_preview", { action: "enable", deviceRef, enabled: false })) as any).result.content[0].text);
  const disabled = JSON.parse(((await call(5, "live_device_apply", { transactionId: enable.transactionId, confirmation: "apply", idempotencyKey: "dev-dis-key" })) as any).result.content[0].text);
  assert.equal(disabled.state, "applied");
  assert.equal((simulator as any).state.tracks[0].devices.at(-1).enabled, false);
  const move = JSON.parse(((await call(6, "live_device_preview", { action: "move", deviceRef, index: 0 })) as any).result.content[0].text);
  const moved = JSON.parse(((await call(7, "live_device_apply", { transactionId: move.transactionId, confirmation: "apply", idempotencyKey: "dev-move" })) as any).result.content[0].text);
  assert.equal(moved.state, "applied");
  assert.equal((simulator as any).state.tracks[0].devices[0].name, "Echo");
  const arbitraryDelete = await call(80, "live_device_preview", { action: "delete", deviceRef });
  assert.equal((arbitraryDelete as any).result.isError, true);
  const moveUndone = JSON.parse(((await call(81, "live_undo", { transactionId: move.transactionId, confirmation: "undo", idempotencyKey: "dev-move-undo" })) as any).result.content[0].text); assert.equal(moveUndone.state, "undone");
  const enableUndone = JSON.parse(((await call(82, "live_undo", { transactionId: enable.transactionId, confirmation: "undo", idempotencyKey: "dev-enable-undo" })) as any).result.content[0].text); assert.equal(enableUndone.state, "undone");
  const insertUndone = JSON.parse(((await call(83, "live_undo", { transactionId: insert.transactionId, confirmation: "undo", idempotencyKey: "dev-insert-undo" })) as any).result.content[0].text); assert.equal(insertUndone.state, "undone");
  assert.equal((simulator as any).state.tracks[0].devices.some((d: any) => d.name === "Echo"), false);
});

test("nested device mutations refuse reparenting after preview", async () => {
  const simulator = new DeterministicLiveSimulator(); const state = (simulator as any).state; const track = state.tracks[0]; const nested = track.devices[0];
  const sibling = { ref: "device:sibling", parentRef: "chain:rack:0", objectIdentity: "simulator:device:sibling", name: "Sibling", kind: "device", parameters: [] };
  const chainA = { ref: "chain:rack:0", parentRef: "device:rack", objectIdentity: "simulator:chain:a", index: 0, name: "A", mute: false, solo: false, devices: [nested, sibling] };
  const chainB = { ref: "chain:rack:1", parentRef: "device:rack", objectIdentity: "simulator:chain:b", index: 1, name: "B", mute: false, solo: false, devices: [] as any[] };
  const rack = { ref: "device:rack", parentRef: track.ref, objectIdentity: "simulator:rack", name: "Rack", kind: "rack", parameters: [], chains: [chainA, chainB] }; nested.parentRef = chainA.ref; track.devices = [rack];
  const host = new McpHost(simulator); ready(host); const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const siblingPreview = JSON.parse(((await call(88, "live_device_preview", { action: "move", deviceRef: nested.ref, index: 1 })) as any).result.content[0].text);
  chainA.devices[1] = { ...sibling, objectIdentity: "simulator:device:sibling-replacement" };
  const siblingRefused = await call(89, "live_device_apply", { transactionId: siblingPreview.transactionId, confirmation: "apply", idempotencyKey: "nested-sibling-replacement" });
  assert.equal((siblingRefused as any).result.isError, true); chainA.devices[1] = sibling;
  const replacementPreview = JSON.parse(((await call(90, "live_device_preview", { action: "enable", deviceRef: nested.ref, enabled: false })) as any).result.content[0].text);
  const replacement = { ...chainA, objectIdentity: "simulator:chain:replacement", devices: [nested] }; rack.chains[0] = replacement;
  const replacementRefused = await call(91, "live_device_apply", { transactionId: replacementPreview.transactionId, confirmation: "apply", idempotencyKey: "nested-owner-replacement" });
  assert.equal((replacementRefused as any).result.isError, true); assert.equal(replacement.devices[0], nested);
  const reparentPreview = JSON.parse(((await call(92, "live_device_preview", { action: "enable", deviceRef: nested.ref, enabled: false })) as any).result.content[0].text);
  replacement.devices = []; chainB.devices = [nested]; nested.parentRef = chainB.ref;
  const reparentRefused = await call(93, "live_device_apply", { transactionId: reparentPreview.transactionId, confirmation: "apply", idempotencyKey: "nested-reparent" });
  assert.equal((reparentRefused as any).result.isError, true); assert.equal(chainB.devices[0], nested);
});

test("routing edits guard feedback and fence on routing state", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const feedback = await call(2, "live_routing_preview", { trackRef: "track:track-1", outputType: "Drums" });
  assert.equal((feedback as any).result.isError, true);
  const preview = JSON.parse(((await call(3, "live_routing_preview", { trackRef: "track:track-1", outputType: "Main", arm: true, monitoring: "in" })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(4, "live_routing_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "route-1-key" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.armed, true);
  assert.equal(track.monitoringState, "in");
  const replay = JSON.parse(((await call(5, "live_routing_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "route-1-key" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(6, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "route-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone"); assert.equal(track.armed, false); assert.equal(track.monitoringState, "off");
});

test("realtime control requires real provenance and arms exact bounded channels idempotently", async () => {
  const simulator = new DeterministicLiveSimulator();
  let provenance: "fake-live" | "real-live" = "fake-live";
  let armed = false;
  let armCalls = 0;
  let lastArmArgs: any;
  const operations = ["status", "snapshot", "discover", "get", "reconnect", "session.playback", "realtime.arm", "realtime.disarm", "realtime.stats"];
  const adapter = {
    status: () => ({ ...simulator.status(), adapter: "remote-script", epoch: 7, provenance, registryHash: "a".repeat(64), capabilities: [...simulator.status().capabilities, "realtime.events"], operations }),
    snapshot: () => simulator.snapshot(), get: (ref: LiveRef) => simulator.get(ref), invoke: () => { throw new Error("synchronous invoke is unavailable"); }, subscribe: () => () => undefined, reconnect: () => simulator.status(),
    snapshotAsync: async () => simulator.snapshot(), discoverAsync: async () => ({ epoch: 7, items: [], truncated: false, revision: "7:empty", kind: "track" }), getAsync: async (ref: LiveRef) => simulator.get(ref), reconnectAsync: async () => simulator.status(), close: async () => undefined,
    invokeAsync: async (invocation: any) => {
      if (invocation.operation === "realtime.arm") {
        armCalls += 1; armed = true; lastArmArgs = structuredClone(invocation.args);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { host: "127.0.0.1", port: 9766, token: String(armCalls).padEnd(32, "t"), expiresAt: Date.now() + invocation.args.ttlMs, channels: invocation.args.channels, parameterRefs: invocation.args.parameterRefs, packetLimitBytes: 512, ratePerSecond: 64, burst: 16 };
      }
      if (invocation.operation === "realtime.disarm") { armed = false; return { armed: false }; }
      if (invocation.operation === "realtime.stats") return { armed, accepted: 2, applied: 2, applyFailures: 0, pending: 0, droppedUnarmed: 0, droppedEndpoint: 0, droppedTarget: 0, droppedInvalid: 0, droppedReplay: 0, droppedRateLimited: 0, droppedQueueFull: 0, droppedBeforeDispatch: 0, revokedBeforeApply: 0, sequenceGaps: 0, lastSequence: 2, jitterMs: 0.2, maxJitterMs: 0.4 };
      throw new Error("unexpected operation");
    },
  } as any;
  const host = new McpHost(adapter);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const evidence = { safe: true, provenance: "operator-confirmed-loopback", scope: "published device parameters" };
  const fake = await call(2, "live_realtime_arm_preview", { ttlMs: 5000, channels: ["udp-json"], parameterRefs: [], outputSafety: evidence });
  assert.equal((fake as any).result.isError, true);
  provenance = "real-live";
  const duplicate = await call(3, "live_realtime_arm_preview", { channels: ["xy", "xy"], parameterRefs: [], outputSafety: evidence });
  assert.equal((duplicate as any).error.code, -32602);
  const preview = JSON.parse(((await call(4, "live_realtime_arm_preview", { ttlMs: 5000, channels: ["udp-json", "osc", "xy", "max"], parameterRefs: ["parameter:mixer:0:volume"], sourcePorts: [41000], outputSafety: evidence })) as any).result.content[0].text);
  assert.deepEqual(preview.channels, ["udp-json", "osc", "xy", "max"]);
  assert.deepEqual(preview.parameterTargets.map((target: any) => target.ref), ["parameter:mixer:0:volume"]);
  assert.equal(preview.packetLimitBytes, 512);
  const [firstApply, secondApply] = await Promise.all([
    call(5, "live_realtime_arm_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rt-arm-1" }),
    call(6, "live_realtime_arm_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rt-arm-1" }),
  ]);
  const concurrent = [firstApply, secondApply].map((response) => JSON.parse((response as any).result.content[0].text));
  assert.deepEqual(concurrent.map((result) => result.idempotent).sort(), [false, true]);
  assert.ok(concurrent.every((result) => result.endpoint.token === concurrent[0].endpoint.token));
  assert.equal(concurrent[0].state, "applied");
  assert.equal(concurrent[0].endpoint.port, 9766);
  assert.equal(armCalls, 1);
  assert.deepEqual(lastArmArgs.targetAuthorities, [preview.parameterTargets[0].authority]);
  assert.equal(lastArmArgs.targetAuthorities[0].parameterIdentity, "simulator:parameter:mixer:0:volume");
  assert.deepEqual(lastArmArgs.targetAuthorities[0].siblings.map((row: any) => row.ref), ["parameter:mixer:0:volume", "parameter:mixer:0:panning", "parameter:mixer:0:cue_volume", "parameter:mixer:0:sends:0", "parameter:mixer:0:sends:1"]);
  const replay = JSON.parse(((await call(7, "live_realtime_arm_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rt-arm-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  assert.equal(armCalls, 1);
  const stats = JSON.parse(((await call(8, "live_realtime_stats", {})) as any).result.content[0].text);
  assert.equal(stats.armed, true);
  assert.equal(stats.applied, 2);
  const disarmed = JSON.parse(((await call(9, "live_realtime_disarm", { confirmation: "disarm" })) as any).result.content[0].text);
  assert.equal(disarmed.armed, false);
  const unknown = await call(10, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:missing"], outputSafety: evidence });
  assert.equal((unknown as any).result.isError, true);
  const competing = JSON.parse(((await call(11, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:mixer:0:volume"], outputSafety: evidence })) as any).result.content[0].text);
  const [winner, refused] = await Promise.all([
    call(12, "live_realtime_arm_apply", { transactionId: competing.transactionId, confirmation: "apply", idempotencyKey: "rt-winner" }),
    call(13, "live_realtime_arm_apply", { transactionId: competing.transactionId, confirmation: "apply", idempotencyKey: "rt-other" }),
  ]);
  assert.equal((winner as any).result.isError, false);
  assert.equal((refused as any).result.isError, true);
  assert.equal(armCalls, 2);
  await call(14, "live_realtime_disarm", { confirmation: "disarm" });
  const stale = JSON.parse(((await call(15, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:mixer:0:volume"], outputSafety: evidence })) as any).result.content[0].text);
  (simulator as any).state.tracks[0].mixer.volume = 0.75;
  const staleApply = await call(16, "live_realtime_arm_apply", { transactionId: stale.transactionId, confirmation: "apply", idempotencyKey: "rt-stale" });
  assert.equal((staleApply as any).result.isError, true);
  assert.equal(armCalls, 2);
  (simulator as any).state.tracks[0].mixer.volume = 0.85;
  const topology = JSON.parse(((await call(17, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:mixer:0:volume"], outputSafety: evidence })) as any).result.content[0].text);
  (simulator as any).state.tracks[0].objectIdentity = "simulator:track:replacement";
  const topologyApply = await call(18, "live_realtime_arm_apply", { transactionId: topology.transactionId, confirmation: "apply", idempotencyKey: "rt-topology" });
  assert.equal((topologyApply as any).result.isError, true); assert.equal(armCalls, 2);
  (simulator as any).state.tracks[0].objectIdentity = "simulator:track:track-1";
  const mixer = (simulator as any).state.tracks[0].mixer;
  mixer.sendRefs = Array.from({ length: 254 }, (_, index) => `parameter:mixer:0:sends:${index}`);
  mixer.sendIdentities = Array.from({ length: 254 }, (_, index) => `simulator:parameter:mixer:0:sends:${index}`);
  mixer.sends = Array.from({ length: 254 }, () => 0);
  const oversizedAuthority = await call(19, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:mixer:0:volume"], outputSafety: evidence });
  assert.equal((oversizedAuthority as any).result.isError, true);
  mixer.sendRefs = ["parameter:mixer:0:sends:0", "parameter:mixer:0:sends:1"];
  mixer.sendIdentities = ["simulator:parameter:mixer:0:sends:0", "simulator:parameter:mixer:0:sends:1"];
  mixer.sends = [0.5, 0.25];
  (simulator as any).state.tracks[0].devices = Array.from({ length: 5 }, (_, deviceIndex) => ({
    ref: `device:budget:${deviceIndex}`, objectIdentity: `simulator:device:budget:${deviceIndex}`, macros: [], chains: [], drumPads: [],
    parameters: Array.from({ length: 256 }, (_, parameterIndex) => ({ ref: `parameter:budget:${deviceIndex}:${parameterIndex}`, objectIdentity: `simulator:parameter:budget:${deviceIndex}:${parameterIndex}`, value: 0.5 })),
  }));
  const withinCumulativeBudget = await call(20, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:budget:2:0"], outputSafety: evidence });
  assert.equal((withinCumulativeBudget as any).result.isError, false);
  const cumulativeOversize = await call(21, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:budget:4:0"], outputSafety: evidence });
  assert.equal((cumulativeOversize as any).result.isError, true);
  const aliasedIdentity = "simulator:parameter:rack:macro-0";
  (simulator as any).state.tracks[0].devices = [{ ref: "device:rack", objectIdentity: "simulator:device:rack", chains: [], drumPads: [], parameters: [{ ref: "parameter:rack:0", objectIdentity: aliasedIdentity, value: 0.5 }], macros: [{ ref: "parameter:rack:macro:0", objectIdentity: aliasedIdentity, value: 0.5 }] }];
  const aliasPreview = JSON.parse(((await call(22, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:rack:macro:0"], outputSafety: evidence })) as any).result.content[0].text);
  assert.equal(aliasPreview.parameterTargets[0].authority.ref, "parameter:rack:macro:0");
  assert.deepEqual(aliasPreview.parameterTargets[0].authority.siblings.map((row: any) => row.ref), ["parameter:rack:0", "parameter:rack:macro:0"]);
  (simulator as any).state.tracks[0].devices = [
    { ref: "device:oversized-rack", objectIdentity: "simulator:device:oversized-rack", parameters: [], macros: [], drumPads: [], chains: Array.from({ length: 257 }, () => ({ devices: [] })) },
    { ref: "device:after-oversized-rack", objectIdentity: "simulator:device:after-oversized-rack", parameters: [{ ref: "parameter:after-oversized-rack:0", objectIdentity: "simulator:parameter:after-oversized-rack:0", value: 0.5 }], macros: [], drumPads: [], chains: [] },
  ];
  const structuralOversize = await call(23, "live_realtime_arm_preview", { channels: ["udp-json"], parameterRefs: ["parameter:after-oversized-rack:0"], outputSafety: evidence });
  assert.equal((structuralOversize as any).result.isError, true);
  assert.equal(armCalls, 2);
});

test("recording preview gates intent, destination, and recording state", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const unsafe = await call(2, "live_recording_preview", { action: "start", lane: "session", intent: "capture a take", outputSafety: { safe: true, provenance: "unknown" } });
  assert.equal((unsafe as any).result.isError, true);
  const missingDestination = await call(20, "live_recording_preview", { action: "start", lane: "session", intent: "capture a take", outputSafety: { safe: true, provenance: "operator-confirmed" } });
  assert.equal((missingDestination as any).result.isError, true);
  const unarmed = await call(3, "live_recording_preview", { action: "start", lane: "arrangement", intent: "record arrangement pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } });
  assert.equal((unarmed as any).result.isError, true);
  (simulator as any).state.tracks[0].armed = true;
  const structure = simulator.snapshot(); const expectedStructureRevision = createHash("sha256").update(JSON.stringify({ tracks: structure.tracks.map((item, index) => [item.ref, item.objectIdentity, item.name, item.kind, index]), scenes: structure.scenes.map((item, index) => [item.ref, item.objectIdentity, item.name, index]) })).digest("hex");
  simulator.invoke({ operation: "track.create", args: { name: "Other Armed", kind: "audio", index: 1, expectedStructureRevision } }); (simulator as any).state.tracks[1].armed = true;
  const multipleArmed = await call(21, "live_recording_preview", { action: "start", lane: "arrangement", intent: "record arrangement pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } });
  assert.equal((multipleArmed as any).result.isError, true); (simulator as any).state.tracks[1].armed = false;
  let preview = JSON.parse(((await call(4, "live_recording_preview", { action: "start", lane: "arrangement", intent: "record arrangement pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } })) as any).result.content[0].text);
  (simulator as any).state.tracks[1].armed = true;
  const racedArm = await call(22, "live_recording_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rec-raced-arm" });
  assert.equal((racedArm as any).result.isError, true); assert.equal((simulator as any).state.playback.transport.arrangementRecord, false);
  (simulator as any).state.tracks[1].armed = false;
  preview = JSON.parse(((await call(23, "live_recording_preview", { action: "start", lane: "arrangement", intent: "record arrangement pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(5, "live_recording_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rec-1-key" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  assert.equal((simulator as any).state.playback.transport.arrangementRecord, true);
  const alreadyActive = await call(6, "live_recording_preview", { action: "start", lane: "arrangement", intent: "again", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } });
  assert.equal((alreadyActive as any).result.isError, true);
  const stopPreview = JSON.parse(((await call(7, "live_recording_preview", { action: "stop", lane: "arrangement", intent: "stop the pass", outputSafety: { safe: true, provenance: "operator-confirmed" } })) as any).result.content[0].text);
  const stopped = JSON.parse(((await call(8, "live_recording_apply", { transactionId: stopPreview.transactionId, confirmation: "apply", idempotencyKey: "rec-stop" })) as any).result.content[0].text);
  assert.equal(stopped.recording, false);

  let recordingDispatches = 0; const originalInvokeAsync = simulator.invokeAsync.bind(simulator);
  simulator.invokeAsync = async (invocation) => { if (invocation.operation === "recording.arrangement") { recordingDispatches += 1; await new Promise((resolve) => setTimeout(resolve, 10)); } return originalInvokeAsync(invocation); };
  const concurrentPreview = JSON.parse(((await call(9, "live_recording_preview", { action: "start", lane: "arrangement", intent: "one exact pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } })) as any).result.content[0].text);
  const [first, replay, conflictingAuthority, differentOperation] = await Promise.all([
    call(10, "live_recording_apply", { transactionId: concurrentPreview.transactionId, confirmation: "apply", idempotencyKey: "rec-concurrent" }),
    call(11, "live_recording_apply", { transactionId: concurrentPreview.transactionId, confirmation: "apply", idempotencyKey: "rec-concurrent" }),
    call(13, "live_recording_apply", { transactionId: concurrentPreview.transactionId, confirmation: "wrong", idempotencyKey: "rec-concurrent" }),
    call(14, "live_undo", { transactionId: concurrentPreview.transactionId, confirmation: "undo", idempotencyKey: "rec-concurrent" }),
  ]);
  assert.equal(recordingDispatches, 1); assert.equal((first as any).id, 10); assert.equal((replay as any).id, 11);
  assert.equal((conflictingAuthority as any).result.isError, true); assert.equal((differentOperation as any).result.isError, true);
  const staleRecordingAuthority = await call(15, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [], expectedRecording: "stopped", idempotencyKey: "recording-emergency-stale" });
  assert.equal((staleRecordingAuthority as any).result.isError, true); assert.equal((simulator as any).state.playback.transport.arrangementRecord, true);
  const emergency = await call(12, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [], expectedRecording: "arrangement", idempotencyKey: "recording-emergency" });
  assert.equal((emergency as any).result.isError, false); assert.equal((simulator as any).state.playback.transport.arrangementRecord, false);
});

test("session audio import enforces file authority, TOCTOU re-verification, and guarded cleanup", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const dir = mkdtempSync(join(tmpdir(), "audio-import-"));
  const audioPath = join(dir, "demo.wav");
  writeFileSync(audioPath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("fake-audio-bytes")]));
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
  (simulator as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_audio_import_preview", { filePath: audioPath, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1, name: "Imported" })) as any).result.content[0].text);
  assert.equal(preview.impact, "creates-session-audio-clip"); assert.equal(preview.file.size > 0, true);
  assert.equal(((await call(3, "live_audio_import_preview", { filePath: audioPath, allowedRoot: "/etc", trackRef: "track:track-1", sceneIndex: 1 })) as any).result.isError, true);
  assert.equal(((await call(4, "live_audio_import_preview", { filePath: "/etc/hosts", allowedRoot: "/etc", trackRef: "track:track-1", sceneIndex: 1 })) as any).result.isError, true);
  // Mutating the source after preview cannot substitute unauthorized bytes:
  // Live opens the transaction-owned staged copy, so the apply still succeeds
  // with exactly the verified content.
  writeFileSync(audioPath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([17, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("fake-audio-CHANGED")]));
  const stagedApply = JSON.parse(((await call(5, "live_audio_import_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "import-toctou" })) as any).result.content[0].text);
  assert.equal(stagedApply.state, "applied");
  const stagedUndone = JSON.parse(((await call(50, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "import-staged-undo" })) as any).result.content[0].text);
  assert.equal(stagedUndone.state, "undone");
  writeFileSync(audioPath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("fake-audio-bytes")]));
  const preview2 = JSON.parse(((await call(6, "live_audio_import_preview", { filePath: audioPath, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1, name: "Imported" })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(7, "live_audio_import_apply", { transactionId: preview2.transactionId, confirmation: "apply", idempotencyKey: "import-key-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied"); assert.match(applied.result.filePath, /ableton-mcp-import-/);
  const slot = (simulator as any).state.tracks[0].clipSlots[1];
  assert.equal(slot.clipRef.startsWith("clip:"), true);
  const undone = JSON.parse(((await call(8, "live_undo", { transactionId: preview2.transactionId, confirmation: "undo", idempotencyKey: "import-undo-1" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone"); assert.equal(slot.clipRef, null);
});

test("warp marker add, move, delete round-trip with collection fencing and guarded undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const track = (simulator as any).state.tracks[0];
  track.clips.push({ ref: "clip:audio-1", objectIdentity: "simulator:clip:audio-1", name: "Audio", kind: "audio", isAudio: true, start: 0, length: 4, notes: [], warp: true, takes: [], automation: [], muted: false, warpMarkers: [{ beatTime: 1, sampleTime: 44100 }, { beatTime: 3, sampleTime: 132300 }] });
  const clipSlot = { ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: "clip:audio-1", empty: false };
  track.clipSlots.push(clipSlot);
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const addPreview = JSON.parse(((await call(2, "live_warp_marker_preview", { clipRef: "clip:audio-1", action: "add", beatTime: 2 })) as any).result.content[0].text);
  const addApplied = JSON.parse(((await call(3, "live_warp_marker_apply", { transactionId: addPreview.transactionId, confirmation: "apply", idempotencyKey: "warp-add-1" })) as any).result.content[0].text);
  assert.equal(addApplied.state, "applied");
  assert.deepEqual((simulator as any).state.tracks[0].clips[1].warpMarkers.map((m: any) => m.beatTime), [1, 2, 3]);
  const undone = JSON.parse(((await call(4, "live_undo", { transactionId: addPreview.transactionId, confirmation: "undo", idempotencyKey: "warp-add-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.deepEqual((simulator as any).state.tracks[0].clips[1].warpMarkers.map((m: any) => m.beatTime), [1, 3]);
  const movePreview = JSON.parse(((await call(5, "live_warp_marker_preview", { clipRef: "clip:audio-1", action: "move", beatTime: 1, distance: 0.5 })) as any).result.content[0].text);
  const moveApplied = JSON.parse(((await call(6, "live_warp_marker_apply", { transactionId: movePreview.transactionId, confirmation: "apply", idempotencyKey: "warp-move-1" })) as any).result.content[0].text);
  assert.equal(moveApplied.state, "applied");
  assert.deepEqual((simulator as any).state.tracks[0].clips[1].warpMarkers.map((m: any) => m.beatTime), [1.5, 3]);
  assert.equal(((await call(7, "live_warp_marker_preview", { clipRef: "clip:audio-1", action: "add", beatTime: 1.5 })) as any).error.code, -32602);
  assert.equal(((await call(8, "live_warp_marker_preview", { clipRef: "clip:audio-1", action: "move", beatTime: 9, distance: 1 })) as any).error.code, -32602);
  const deletePreview = JSON.parse(((await call(9, "live_warp_marker_preview", { clipRef: "clip:audio-1", action: "delete", beatTime: 3 })) as any).result.content[0].text);
  const deleteApplied = JSON.parse(((await call(10, "live_warp_marker_apply", { transactionId: deletePreview.transactionId, confirmation: "apply", idempotencyKey: "warp-del-1" })) as any).result.content[0].text);
  assert.equal(deleteApplied.state, "applied");
  assert.deepEqual((simulator as any).state.tracks[0].clips[1].warpMarkers.map((m: any) => m.beatTime), [1.5]);
});

test("clip actions crop, duplicate, scrub, and move playing position with state fencing", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const clip = (simulator as any).state.tracks[0].clips[0];
  clip.loopStart = 1; clip.loopEnd = 3;
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const cropPreview = JSON.parse(((await call(2, "live_clip_action_preview", { clipRef: "clip:clip-1", action: "crop" })) as any).result.content[0].text);
  assert.equal(cropPreview.impact, "edits-clip-content-not-undoable");
  const cropApplied = JSON.parse(((await call(3, "live_clip_action_apply", { transactionId: cropPreview.transactionId, confirmation: "apply", idempotencyKey: "action-crop-1" })) as any).result.content[0].text);
  assert.equal(cropApplied.state, "applied"); assert.equal(clip.length, 2);
  const dupPreview = JSON.parse(((await call(4, "live_clip_action_preview", { clipRef: "clip:clip-1", action: "duplicate-loop" })) as any).result.content[0].text);
  await call(5, "live_clip_action_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "action-dup-1" });
  assert.equal(clip.length, 4);
  const regionPreview = JSON.parse(((await call(6, "live_clip_action_preview", { clipRef: "clip:clip-1", action: "duplicate-region", regionStart: 0, regionEnd: 2, destination: 4 })) as any).result.content[0].text);
  await call(7, "live_clip_action_apply", { transactionId: regionPreview.transactionId, confirmation: "apply", idempotencyKey: "action-region-1" });
  assert.equal(clip.length, 6);
  const scrubPreview = JSON.parse(((await call(8, "live_clip_action_preview", { clipRef: "clip:clip-1", action: "scrub-start", offset: 2.5 })) as any).result.content[0].text);
  await call(9, "live_clip_action_apply", { transactionId: scrubPreview.transactionId, confirmation: "apply", idempotencyKey: "action-scrub-1" });
  assert.equal(clip.playingPosition, 2.5);
  const movePreview = JSON.parse(((await call(10, "live_clip_action_preview", { clipRef: "clip:clip-1", action: "move-playing-position", offset: 1 })) as any).result.content[0].text);
  await call(11, "live_clip_action_apply", { transactionId: movePreview.transactionId, confirmation: "apply", idempotencyKey: "action-move-1" });
  assert.equal(clip.playingPosition, 3.5);
  assert.equal(((await call(12, "live_undo", { transactionId: cropPreview.transactionId, confirmation: "undo", idempotencyKey: "action-undo-x" })) as any).result.isError, true);
});

test("note edit quantizes, duplicates, reads by id, and guardedly undoes", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const clip = (simulator as any).state.tracks[0].clips[0];
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const read = JSON.parse(((await call(2, "live_note_read", { clipRef: "clip:clip-1", noteIds: [1] })) as any).result.content[0].text);
  assert.equal(read.notes.length, 1); assert.equal(read.notes[0].pitch, 36);
  const selected = JSON.parse(((await call(3, "live_note_read", { clipRef: "clip:clip-1", selected: true })) as any).result.content[0].text);
  assert.equal(selected.available, true);
  const dupPreview = JSON.parse(((await call(4, "live_note_edit_preview", { clipRef: "clip:clip-1", action: "duplicate", noteIds: [1] })) as any).result.content[0].text);
  const dupApplied = JSON.parse(((await call(5, "live_note_edit_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "note-dup-1" })) as any).result.content[0].text);
  assert.equal(dupApplied.state, "applied"); assert.equal(clip.notes.length, 2);
  const dupUndone = JSON.parse(((await call(6, "live_undo", { transactionId: dupPreview.transactionId, confirmation: "undo", idempotencyKey: "note-dup-undo" })) as any).result.content[0].text);
  assert.equal(dupUndone.state, "undone"); assert.equal(clip.notes.length, 1);
  const quantPreview = JSON.parse(((await call(7, "live_note_edit_preview", { clipRef: "clip:clip-1", action: "quantize-pitch", grid: 0.25, amount: 1, pitch: 40 })) as any).result.content[0].text);
  const quantApplied = JSON.parse(((await call(8, "live_note_edit_apply", { transactionId: quantPreview.transactionId, confirmation: "apply", idempotencyKey: "note-quant-1" })) as any).result.content[0].text);
  assert.equal(quantApplied.state, "applied"); assert.equal(clip.notes[0].pitch, 40);
  const quantUndone = JSON.parse(((await call(9, "live_undo", { transactionId: quantPreview.transactionId, confirmation: "undo", idempotencyKey: "note-quant-undo" })) as any).result.content[0].text);
  assert.equal(quantUndone.state, "undone"); assert.equal(clip.notes[0].pitch, 36);
  assert.equal(((await call(10, "live_note_edit_preview", { clipRef: "clip:clip-1", action: "duplicate", noteIds: [99] })) as any).result.isError, true);
});

test("automation clear-envelopes clears with presence fencing and refuses undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const clip = (simulator as any).state.tracks[0].clips[0];
  const volumeRef = "parameter:mixer:0:volume";
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const createPreview = JSON.parse(((await call(2, "live_automation_preview", { action: "create-envelope", clipRef: "clip:clip-1", parameterRef: volumeRef })) as any).result.content[0].text);
  await call(3, "live_automation_apply", { transactionId: createPreview.transactionId, confirmation: "apply", idempotencyKey: "env-create-1" });
  assert.ok(clip.envelopes[volumeRef]);
  const clearPreview = JSON.parse(((await call(4, "live_automation_preview", { action: "clear-envelopes", clipRef: "clip:clip-1" })) as any).result.content[0].text);
  assert.equal(clearPreview.envelopes, 1);
  const clearApplied = JSON.parse(((await call(5, "live_automation_apply", { transactionId: clearPreview.transactionId, confirmation: "apply", idempotencyKey: "env-clear-1" })) as any).result.content[0].text);
  assert.equal(clearApplied.state, "applied"); assert.deepEqual(clip.envelopes, {});
  assert.equal(((await call(6, "live_undo", { transactionId: clearPreview.transactionId, confirmation: "undo", idempotencyKey: "env-clear-undo" })) as any).result.isError, true);
  assert.equal(((await call(7, "live_automation_preview", { action: "clear-envelopes", clipRef: "clip:clip-1", parameterRef: volumeRef })) as any).error.code, -32602);
});

test("take lanes are discoverable, renamable, and accept MIDI and audio clips with exact fencing", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const laneRef = "take-lane:track-1:0";
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const snapshot = JSON.parse(((await call(2, "live_snapshot", {})) as any).result.content[0].text);
  const lanes = snapshot.snapshot.tracks[0].takeLanes;
  assert.equal(lanes.length, 1); assert.equal(lanes[0].name, "Take 1"); assert.equal(lanes[0].ref, laneRef);
  const renamePreview = JSON.parse(((await call(3, "live_object_rename_preview", { kind: "takeLane", ref: laneRef, name: "Verse Take" })) as any).result.content[0].text);
  const renamed = JSON.parse(((await call(4, "live_object_rename_apply", { transactionId: renamePreview.transactionId, confirmation: "apply", idempotencyKey: "lane-rename-1" })) as any).result.content[0].text);
  assert.equal(renamed.state, "applied");
  assert.equal((simulator as any).state.tracks[0].takeLanes[0].name, "Verse Take");
  const midiPreview = JSON.parse(((await call(5, "live_arrangement_clip_preview", { action: "create", takeLaneRef: laneRef, position: 8, length: 4, name: "New Take" })) as any).result.content[0].text);
  assert.equal(midiPreview.kind, "take-lane"); assert.equal(midiPreview.impact, "creates-take-lane-clip-no-undo");
  const midiApplied = JSON.parse(((await call(6, "live_arrangement_clip_apply", { transactionId: midiPreview.transactionId, confirmation: "apply", idempotencyKey: "lane-midi-1" })) as any).result.content[0].text);
  assert.equal(midiApplied.state, "applied");
  const lane = (simulator as any).state.tracks[0].takeLanes[0];
  assert.equal(lane.clips.length, 1); assert.equal(lane.clips[0].name, "New Take"); assert.equal(lane.clips[0].isTakeLaneClip, true);
  assert.equal(((await call(7, "live_undo", { transactionId: midiPreview.transactionId, confirmation: "undo", idempotencyKey: "lane-midi-undo" })) as any).result.isError, true);
  const dir = mkdtempSync(join(tmpdir(), "lane-import-"));
  const audioPath = join(dir, "take.wav");
  writeFileSync(audioPath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([10, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("take-bytes")]));
  const audioPreview = JSON.parse(((await call(8, "live_audio_import_preview", { filePath: audioPath, allowedRoot: dir, takeLaneRef: laneRef, position: 16, name: "Audio Take" })) as any).result.content[0].text);
  assert.equal(audioPreview.impact, "creates-take-lane-audio-clip-no-undo");
  const audioApplied = JSON.parse(((await call(9, "live_audio_import_apply", { transactionId: audioPreview.transactionId, confirmation: "apply", idempotencyKey: "lane-audio-1" })) as any).result.content[0].text);
  assert.equal(audioApplied.state, "applied");
  assert.equal(lane.clips.length, 2); assert.equal(lane.clips[1].kind, "audio"); assert.match(lane.clips[1].filePath, /ableton-mcp-import-/);
  assert.equal(((await call(10, "live_undo", { transactionId: audioPreview.transactionId, confirmation: "undo", idempotencyKey: "lane-audio-undo" })) as any).result.isError, true);
  assert.equal(((await call(11, "live_audio_import_preview", { filePath: audioPath, allowedRoot: dir, takeLaneRef: laneRef, position: 0, trackRef: "track:track-1" })) as any).error.code, -32602);
  const mutePreview = JSON.parse(((await call(12, "live_clip_properties_preview", { clipRef: lane.clips[0].ref, muted: true })) as any).result.content[0].text);
  const muted = JSON.parse(((await call(13, "live_clip_properties_apply", { transactionId: mutePreview.transactionId, confirmation: "apply", idempotencyKey: "lane-mute-1" })) as any).result.content[0].text);
  assert.equal(muted.state, "applied"); assert.equal(lane.clips[0].muted, true);
});

test("tuning and scale edits verify full state and guardedly undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_tuning_preview", { referencePitch: { note: 69, frequency: 432 }, rootNote: 9, scaleName: "Minor", scaleMode: false })) as any).result.content[0].text);
  assert.equal(preview.impact, "edits-global-tuning-audible"); assert.deepEqual(preview.prior.tuningSystem.referencePitch, { note: 69, frequency: 440 });
  const applied = JSON.parse(((await call(3, "live_tuning_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "tuning-key-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const tuning = (simulator as any).state.tuning;
  assert.deepEqual(tuning.system.referencePitch, { note: 69, frequency: 432 }); assert.equal(tuning.scale.rootNote, 9); assert.equal(tuning.scale.scaleName, "Minor"); assert.equal(tuning.scale.scaleMode, false);
  const replay = JSON.parse(((await call(4, "live_tuning_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "tuning-key-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "tuning-undo-1" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.deepEqual(tuning.system.referencePitch, { note: 69, frequency: 440 }); assert.equal(tuning.scale.rootNote, 0); assert.equal(tuning.scale.scaleName, "Major"); assert.equal(tuning.scale.scaleMode, true);
  const rows = Array.from({ length: 128 }, (_, note) => ({ note, deviation: note === 69 ? 5 : 0 }));
  const rowsPreview = JSON.parse(((await call(6, "live_tuning_preview", { noteTunings: rows })) as any).result.content[0].text);
  const rowsApplied = JSON.parse(((await call(7, "live_tuning_apply", { transactionId: rowsPreview.transactionId, confirmation: "apply", idempotencyKey: "tuning-key-2" })) as any).result.content[0].text);
  assert.equal(rowsApplied.state, "applied"); assert.equal(tuning.system.noteTunings[69].deviation, 5);
  assert.equal(((await call(8, "live_tuning_preview", { noteTunings: rows.slice(0, 4) })) as any).error.code, -32602);
  assert.equal(((await call(9, "live_tuning_preview", {})) as any).error.code, -32602);
});

test("groove amount and groove edits verify state and guardedly undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const amountPreview = JSON.parse(((await call(2, "live_groove_preview", { action: "set-amount", grooveAmount: 0.75 })) as any).result.content[0].text);
  assert.equal(amountPreview.impact, "edits-global-groove-amount-audible"); assert.equal(amountPreview.prior.grooveAmount, 0);
  const amountApplied = JSON.parse(((await call(3, "live_groove_apply", { transactionId: amountPreview.transactionId, confirmation: "apply", idempotencyKey: "groove-amt-1" })) as any).result.content[0].text);
  assert.equal(amountApplied.state, "applied"); assert.equal((simulator as any).state.groovePool.amount, 0.75);
  const amountUndone = JSON.parse(((await call(4, "live_undo", { transactionId: amountPreview.transactionId, confirmation: "undo", idempotencyKey: "groove-amt-undo" })) as any).result.content[0].text);
  assert.equal(amountUndone.state, "undone"); assert.equal((simulator as any).state.groovePool.amount, 0);
  const editPreview = JSON.parse(((await call(5, "live_groove_preview", { action: "edit", grooveRef: "groove:groove-1", name: "MPC 57", timingAmount: 0.57 })) as any).result.content[0].text);
  const editApplied = JSON.parse(((await call(6, "live_groove_apply", { transactionId: editPreview.transactionId, confirmation: "apply", idempotencyKey: "groove-edit-1" })) as any).result.content[0].text);
  assert.equal(editApplied.state, "applied");
  const groove = (simulator as any).state.groovePool.grooves[0];
  assert.equal(groove.name, "MPC 57"); assert.equal(groove.timingAmount, 0.57);
  const editUndone = JSON.parse(((await call(7, "live_undo", { transactionId: editPreview.transactionId, confirmation: "undo", idempotencyKey: "groove-edit-undo" })) as any).result.content[0].text);
  assert.equal(editUndone.state, "undone"); assert.equal(groove.name, "Swing 16"); assert.equal(groove.timingAmount, 0.6);
  assert.equal(((await call(8, "live_groove_preview", { action: "set-amount", grooveAmount: 2 })) as any).error.code, -32602);
  assert.equal(((await call(9, "live_groove_preview", { action: "edit", grooveRef: "groove:bogus", name: "X" })) as any).result.isError, true);
  const clipPreview = JSON.parse(((await call(10, "live_clip_properties_preview", { clipRef: "clip:clip-1", grooveRef: "groove:groove-1" })) as any).result.content[0].text);
  const clipApplied = JSON.parse(((await call(11, "live_clip_properties_apply", { transactionId: clipPreview.transactionId, confirmation: "apply", idempotencyKey: "clip-groove-1" })) as any).result.content[0].text);
  assert.equal(clipApplied.state, "applied");
  const clip = (simulator as any).state.tracks[0].clips[0];
  assert.equal(clip.groove.ref, "groove:groove-1"); assert.equal(clip.hasGroove, true);
  const clipUndone = JSON.parse(((await call(12, "live_undo", { transactionId: clipPreview.transactionId, confirmation: "undo", idempotencyKey: "clip-groove-undo" })) as any).result.content[0].text);
  assert.equal(clipUndone.state, "undone"); assert.equal(clip.groove, null); assert.equal(clip.hasGroove, false);
});

test("scene property edits verify state and guardedly undo; direct scene fire is fenced and not undoable", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const snapshot = JSON.parse(((await call(2, "live_snapshot", {})) as any).result.content[0].text);
  const sceneRow = snapshot.snapshot.scenes[0];
  assert.equal((sceneRow.colorIndex), 1); assert.equal(sceneRow.tempo, 120); assert.equal(sceneRow.timeSignatureEnabled, false);
  const slotRow = snapshot.snapshot.tracks[0].clipSlots[0];
  assert.equal(slotRow.colorIndex, 2); assert.equal(slotRow.hasStopButton, true); assert.equal(slotRow.playingStatus, 0);
  const preview = JSON.parse(((await call(3, "live_scene_preview", { ref: "scene:scene-1", colorIndex: 5, tempo: 90, tempoEnabled: true, signatureNumerator: 6, signatureDenominator: 8, timeSignatureEnabled: true })) as any).result.content[0].text);
  assert.equal(preview.prior.colorIndex, 1); assert.equal(preview.prior.tempo, 120);
  const applied = JSON.parse(((await call(4, "live_scene_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "scene-set-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const scene = (simulator as any).state.scenes[0];
  assert.equal(scene.colorIndex, 5); assert.equal(scene.tempo, 90); assert.equal(scene.signatureNumerator, 6); assert.equal(scene.timeSignatureEnabled, true);
  const undone = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "scene-set-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal(scene.colorIndex, 1); assert.equal(scene.tempo, 120); assert.equal(scene.timeSignatureEnabled, false);
  assert.equal(((await call(6, "live_scene_preview", { ref: "scene:scene-1", tempo: 10000 })) as any).error.code, -32602);
  const firePreview = JSON.parse(((await call(7, "live_scene_fire_preview", { ref: "scene:scene-1" })) as any).result.content[0].text);
  assert.equal(firePreview.impact, "fires-scene-audible-direct-no-undo");
  const fired = JSON.parse(((await call(8, "live_scene_fire_apply", { transactionId: firePreview.transactionId, confirmation: "apply", idempotencyKey: "scene-fire-1" })) as any).result.content[0].text);
  assert.equal(fired.state, "applied"); assert.equal(scene.isTriggered, true); assert.equal((simulator as any).state.playback.transport.playing, true);
  assert.equal(((await call(9, "live_undo", { transactionId: firePreview.transactionId, confirmation: "undo", idempotencyKey: "scene-fire-undo" })) as any).result.isError, true);
  (simulator as any).state.playback.transport.playing = false; scene.isTriggered = false;
});

test("song state reads, time conversion, transport actions, and exact cue jumps", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const state = JSON.parse(((await call(2, "live_song_state", {})) as any).result.content[0].text);
  assert.equal(state.signatureNumerator, 4); assert.equal(state.canUndo, true); assert.equal(state.canRedo, false);
  assert.equal(state.isAbletonLinkEnabled, true); assert.equal(state.exclusiveArm, true);
  const converted = JSON.parse(((await call(30, "live_song_state", { conversion: "beats-loop" })) as any).result.content[0].text);
  assert.equal(converted.conversions.available, true); assert.equal(converted.conversions.loopLength, 4);
  const smpte = JSON.parse(((await call(31, "live_song_state", { conversion: "current-smpte", smpteFormat: "smpte-30" })) as any).result.content[0].text);
  assert.equal(smpte.conversions.available, true); assert.equal(typeof smpte.conversions.smpte.frames, "number");
  assert.equal(((await call(32, "live_song_state", { beatTime: 4 })) as any).error.code, -32602);
  const startPreview = JSON.parse(((await call(4, "live_transport_action_preview", { action: "start" })) as any).result.content[0].text);
  assert.equal(startPreview.impact, "audible-transport-action-no-undo");
  const started = JSON.parse(((await call(5, "live_transport_action_apply", { transactionId: startPreview.transactionId, confirmation: "apply", idempotencyKey: "action-start-1" })) as any).result.content[0].text);
  assert.equal(started.state, "applied"); assert.equal((simulator as any).state.playback.transport.playing, true);
  const stopPreview = JSON.parse(((await call(6, "live_transport_action_preview", { action: "stop" })) as any).result.content[0].text);
  await call(7, "live_transport_action_apply", { transactionId: stopPreview.transactionId, confirmation: "apply", idempotencyKey: "action-stop-1" });
  assert.equal((simulator as any).state.playback.transport.playing, false);
  const linkPreview = JSON.parse(((await call(8, "live_transport_action_preview", { action: "force-link-beat-time", beatTime: 8 })) as any).result.content[0].text);
  await call(9, "live_transport_action_apply", { transactionId: linkPreview.transactionId, confirmation: "apply", idempotencyKey: "action-link-1" });
  assert.equal((simulator as any).state.playback.transport.position, 8);
  assert.equal(((await call(10, "live_transport_action_preview", { action: "force-link-beat-time" })) as any).error.code, -32602);
  (simulator as any).state.playback.transport.position = 0; (simulator as any).state.set.position = 0;
  (simulator as any).state.arrangement.locators.push({ ref: "locator:locator-2", objectIdentity: "simulator:locator:locator-2", name: "B", position: 16 });
  const jumpPreview = JSON.parse(((await call(11, "live_locator_jump_preview", { ref: "locator:locator-2" })) as any).result.content[0].text);
  assert.equal(jumpPreview.target, 16);
  const jumped = JSON.parse(((await call(12, "live_locator_jump_apply", { transactionId: jumpPreview.transactionId, confirmation: "apply", idempotencyKey: "jump-to-1" })) as any).result.content[0].text);
  assert.equal(jumped.state, "applied"); assert.equal((simulator as any).state.playback.transport.position, 16);
  assert.equal(((await call(13, "live_locator_jump_preview", {})) as any).error.code, -32602);
  (simulator as any).state.playback.transport.position = 0; (simulator as any).state.set.position = 0;
});

test("track structure (return tracks, duplication), device deletion, and track view", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const snapshot = JSON.parse(((await call(2, "live_snapshot", {})) as any).result.content[0].text);
  const trackRow = snapshot.snapshot.tracks[0];
  assert.equal(trackRow.isVisible, true); assert.equal(trackRow.outputMeterLevel, 0.58); assert.equal(trackRow.performanceImpact, 1);
  assert.equal(trackRow.view.isCollapsed, false); assert.equal(trackRow.view.deviceInsertMode, 1);
  const createPreview = JSON.parse(((await call(3, "live_track_structure_preview", { action: "create-return", name: "Verb" })) as any).result.content[0].text);
  const created = JSON.parse(((await call(4, "live_track_structure_apply", { transactionId: createPreview.transactionId, confirmation: "apply", idempotencyKey: "return-create-1" })) as any).result.content[0].text);
  assert.equal(created.state, "applied"); assert.equal(created.result.name, "Verb");
  const returnTrack = (simulator as any).state.tracks.find((t: any) => t.kind === "return");
  assert.ok(returnTrack);
  const createUndone = JSON.parse(((await call(5, "live_undo", { transactionId: createPreview.transactionId, confirmation: "undo", idempotencyKey: "return-create-undo" })) as any).result.content[0].text);
  assert.equal(createUndone.state, "undone");
  assert.equal((simulator as any).state.tracks.some((t: any) => t.kind === "return"), false);
  const dupPreview = JSON.parse(((await call(6, "live_track_structure_preview", { action: "duplicate-track", ref: "track:track-1" })) as any).result.content[0].text);
  const duped = JSON.parse(((await call(7, "live_track_structure_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "track-dup-1" })) as any).result.content[0].text);
  assert.equal(duped.state, "applied"); assert.equal((simulator as any).state.tracks.length, 2);
  const dupUndone = JSON.parse(((await call(8, "live_undo", { transactionId: dupPreview.transactionId, confirmation: "undo", idempotencyKey: "track-dup-undo" })) as any).result.content[0].text);
  assert.equal(dupUndone.state, "undone"); assert.equal((simulator as any).state.tracks.length, 1);
  const sceneDupPreview = JSON.parse(((await call(9, "live_track_structure_preview", { action: "duplicate-scene", ref: "scene:scene-1" })) as any).result.content[0].text);
  await call(10, "live_track_structure_apply", { transactionId: sceneDupPreview.transactionId, confirmation: "apply", idempotencyKey: "scene-dup-1" });
  assert.equal((simulator as any).state.scenes.length, 2);
  await call(11, "live_undo", { transactionId: sceneDupPreview.transactionId, confirmation: "undo", idempotencyKey: "scene-dup-undo" });
  assert.equal((simulator as any).state.scenes.length, 1);
  const viewPreview = JSON.parse(((await call(12, "live_track_view_preview", { ref: "track:track-1", collapsed: true, deviceInsertMode: 2 })) as any).result.content[0].text);
  const viewApplied = JSON.parse(((await call(13, "live_track_view_apply", { transactionId: viewPreview.transactionId, confirmation: "apply", idempotencyKey: "trackview-1" })) as any).result.content[0].text);
  assert.equal(viewApplied.state, "applied");
  assert.equal((simulator as any).state.tracks[0].view.isCollapsed, true); assert.equal((simulator as any).state.tracks[0].view.deviceInsertMode, 2);
  const viewUndone = JSON.parse(((await call(14, "live_undo", { transactionId: viewPreview.transactionId, confirmation: "undo", idempotencyKey: "trackview-undo" })) as any).result.content[0].text);
  assert.equal(viewUndone.state, "undone");
  assert.equal((simulator as any).state.tracks[0].view.isCollapsed, false); assert.equal((simulator as any).state.tracks[0].view.deviceInsertMode, 1);
  const instrumentPreview = JSON.parse(((await call(15, "live_track_view_preview", { ref: "track:track-1", selectInstrument: true })) as any).result.content[0].text);
  const instrumentApplied = JSON.parse(((await call(16, "live_track_view_apply", { transactionId: instrumentPreview.transactionId, confirmation: "apply", idempotencyKey: "trackview-2" })) as any).result.content[0].text);
  assert.equal(instrumentApplied.state, "applied");
  assert.equal(((await call(17, "live_undo", { transactionId: instrumentPreview.transactionId, confirmation: "undo", idempotencyKey: "trackview-inst-undo" })) as any).result.isError, true);
  const deletePreview = JSON.parse(((await call(18, "live_device_delete_preview", { ref: "device:utility-1" })) as any).result.content[0].text);
  assert.equal(deletePreview.impact, "deletes-device-no-undo");
  const deleted = JSON.parse(((await call(19, "live_device_delete_apply", { transactionId: deletePreview.transactionId, confirmation: "apply", idempotencyKey: "devdel-1" })) as any).result.content[0].text);
  assert.equal(deleted.state, "applied"); assert.equal((simulator as any).state.tracks[0].devices.length, 0);
  assert.equal(((await call(20, "live_undo", { transactionId: deletePreview.transactionId, confirmation: "undo", idempotencyKey: "devdel-undo" })) as any).result.isError, true);
});

test("selection, draw mode, clip view, device view, and guarded dialog surface", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const selectPreview = JSON.parse(((await call(2, "live_selection_preview", { trackRef: "track:track-1", sceneRef: "scene:scene-1", detailClipRef: "clip:clip-1", deviceRef: "device:utility-1", parameterRef: "parameter:gain-1", drawMode: true })) as any).result.content[0].text);
  const selected = JSON.parse(((await call(3, "live_selection_apply", { transactionId: selectPreview.transactionId, confirmation: "apply", idempotencyKey: "select-1" })) as any).result.content[0].text);
  assert.equal(selected.state, "applied");
  const selection = (simulator as any).state.selection;
  assert.equal(selection.detailClipRef, "clip:clip-1"); assert.equal(selection.deviceRef, "device:utility-1"); assert.equal(selection.parameterRef, "parameter:gain-1");
  assert.equal((simulator as any).state.view.drawMode, true);
  const selectUndone = JSON.parse(((await call(4, "live_undo", { transactionId: selectPreview.transactionId, confirmation: "undo", idempotencyKey: "select-undo" })) as any).result.content[0].text);
  assert.equal(selectUndone.state, "undone");
  const clipViewPreview = JSON.parse(((await call(5, "live_clip_view_preview", { clipRef: "clip:clip-1", gridQuantization: 4, gridIsTriplet: true, showEnvelope: true })) as any).result.content[0].text);
  const clipViewApplied = JSON.parse(((await call(6, "live_clip_view_apply", { transactionId: clipViewPreview.transactionId, confirmation: "apply", idempotencyKey: "clipview-1" })) as any).result.content[0].text);
  assert.equal(clipViewApplied.state, "applied");
  const clipView = (simulator as any).state.tracks[0].clips[0].clipView;
  assert.equal(clipView.gridQuantization, 4); assert.equal(clipView.gridIsTriplet, true);
  const clipViewUndone = JSON.parse(((await call(7, "live_undo", { transactionId: clipViewPreview.transactionId, confirmation: "undo", idempotencyKey: "clipview-undo" })) as any).result.content[0].text);
  assert.equal(clipViewUndone.state, "undone");
  assert.equal(clipView.gridQuantization, 1); assert.equal(clipView.gridIsTriplet, false);
  const devViewPreview = JSON.parse(((await call(8, "live_device_view_preview", { ref: "device:utility-1", collapsed: true })) as any).result.content[0].text);
  const devViewApplied = JSON.parse(((await call(9, "live_device_view_apply", { transactionId: devViewPreview.transactionId, confirmation: "apply", idempotencyKey: "devview-1" })) as any).result.content[0].text);
  assert.equal(devViewApplied.state, "applied"); assert.equal((simulator as any).state.tracks[0].devices[0].view.isCollapsed, true);
  const devViewUndone = JSON.parse(((await call(10, "live_undo", { transactionId: devViewPreview.transactionId, confirmation: "undo", idempotencyKey: "devview-undo" })) as any).result.content[0].text);
  assert.equal(devViewUndone.state, "undone"); assert.equal((simulator as any).state.tracks[0].devices[0].view.isCollapsed, false);
  const dialogState = JSON.parse(((await call(11, "live_application_dialog_preview", {})) as any).result.content[0].text);
  assert.equal(dialogState.done, true);
  const dialogPreview = JSON.parse(((await call(12, "live_application_dialog_preview", { button: 1 })) as any).result.content[0].text);
  assert.equal(dialogPreview.impact, "presses-dialog-button-potentially-destructive");
  const dialogApplied = JSON.parse(((await call(13, "live_application_dialog_apply", { transactionId: dialogPreview.transactionId, confirmation: "apply", idempotencyKey: "dialog-1" })) as any).result.content[0].text);
  assert.equal(dialogApplied.state, "applied");
  assert.equal(((await call(14, "live_undo", { transactionId: dialogPreview.transactionId, confirmation: "undo", idempotencyKey: "dialog-undo" })) as any).result.isError, true);
  const browserPreview = JSON.parse(((await call(15, "live_view_preview", { action: "browser-toggle" })) as any).result.content[0].text);
  const browserApplied = JSON.parse(((await call(16, "live_view_apply", { transactionId: browserPreview.transactionId, confirmation: "apply", idempotencyKey: "view-browse-1" })) as any).result.content[0].text);
  assert.equal(browserApplied.state, "applied");
  const hidePreview = JSON.parse(((await call(17, "live_view_preview", { action: "hide-view", view: "Browser" })) as any).result.content[0].text);
  const hideApplied = JSON.parse(((await call(18, "live_view_apply", { transactionId: hidePreview.transactionId, confirmation: "apply", idempotencyKey: "view-hide-1" })) as any).result.content[0].text);
  assert.equal(hideApplied.state, "applied");
});

test("performance read exposes usage, meters, and device latency as bounded evidence", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const read = JSON.parse(((await call(2, "live_performance_read", {})) as any).result.content[0].text);
  assert.equal(read.averageProcessUsage, 0.42); assert.equal(read.peakProcessUsage, 0.87);
  assert.equal(typeof read.sampledAt, "number"); assert.equal(read.revision.length, 64);
  assert.equal(read.tracks[0].performanceImpact, 1); assert.equal(read.tracks[0].outputMeterLevel, 0.58);
  assert.equal(read.tracks[0].devices[0].latencySamples, 256); assert.equal(read.tracks[0].devices[0].latencyMs, 5.8);
});

test("extended mixer, chain mixer, and device IO/sidechain surfaces with guarded undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  (simulator as any).state.tracks[0].devices[0].chains = [{ ref: "chain:rack-1:0", parentRef: "device:utility-1", objectIdentity: "simulator:chain:rack-1:0", index: 0, name: "Chain 1", mute: false, solo: false, devices: [], mixer: { volume: 1, pan: 0, sends: [0.5], volumeRef: "parameter:chain:0:volume", panningRef: "parameter:chain:0:panning", sendRefs: ["parameter:chain:0:sends:0"], chainActivatorRef: "parameter:chain:0:activator", mixerIdentity: "simulator:chain-mixer:0" } }];
  (simulator as any).state.tracks[0].devices[0].kind = "rack"; (simulator as any).state.tracks[0].devices[0].canHaveChains = true;
  const device = (simulator as any).state.tracks[0].devices[0];
  device.deviceIo = { routingType: "Ext. In", routingChannel: "1" };
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const extPreview = JSON.parse(((await call(2, "live_mixer_extended_preview", { trackRef: "track:track-1", trackActivator: false, crossfader: -0.5, crossfadeAssign: 0, panningMode: 1, panningLeft: -0.25, panningRight: 0.25 })) as any).result.content[0].text);
  const extApplied = JSON.parse(((await call(3, "live_mixer_extended_apply", { transactionId: extPreview.transactionId, confirmation: "apply", idempotencyKey: "mixerext-1" })) as any).result.content[0].text);
  assert.equal(extApplied.state, "applied");
  const mixer = (simulator as any).state.tracks[0].mixer;
  assert.equal(mixer.trackActivator, false); assert.equal(mixer.crossfader, -0.5); assert.equal(mixer.crossfadeAssign, 0); assert.equal(mixer.panningMode, 1);
  assert.equal(mixer.panningLeft, -0.25); assert.equal(mixer.panningRight, 0.25);
  const extUndone = JSON.parse(((await call(4, "live_undo", { transactionId: extPreview.transactionId, confirmation: "undo", idempotencyKey: "mixerext-undo" })) as any).result.content[0].text);
  assert.equal(extUndone.state, "undone"); assert.equal(mixer.crossfadeAssign, 1); assert.equal(mixer.panningMode, 0);
  const chainPreview = JSON.parse(((await call(5, "live_chain_mixer_preview", { chainRef: "chain:rack-1:0", volume: 0.5, pan: -0.5, sends: [0.25], chainActivator: false })) as any).result.content[0].text);
  const chainApplied = JSON.parse(((await call(6, "live_chain_mixer_apply", { transactionId: chainPreview.transactionId, confirmation: "apply", idempotencyKey: "chainmix-1" })) as any).result.content[0].text);
  assert.equal(chainApplied.state, "applied");
  const chainMixer = device.chains[0].mixer;
  assert.equal(chainMixer.volume, 0.5); assert.equal(chainMixer.pan, -0.5); assert.equal(chainMixer.sends[0], 0.25); assert.equal(chainMixer.chainActivator, false);
  const chainUndone = JSON.parse(((await call(7, "live_undo", { transactionId: chainPreview.transactionId, confirmation: "undo", idempotencyKey: "chainmix-undo" })) as any).result.content[0].text);
  assert.equal(chainUndone.state, "undone"); assert.equal(chainMixer.volume, 1); assert.equal(chainMixer.pan, 0); assert.equal(chainMixer.sends[0], 0.5);
  const ioPreview = JSON.parse(((await call(8, "live_device_io_preview", { action: "routing", deviceRef: "device:utility-1", routingType: "Main", routingChannel: "1/2" })) as any).result.content[0].text);
  const ioApplied = JSON.parse(((await call(9, "live_device_io_apply", { transactionId: ioPreview.transactionId, confirmation: "apply", idempotencyKey: "devio-key-1" })) as any).result.content[0].text);
  assert.equal(ioApplied.state, "applied"); assert.equal(device.deviceIo.routingType, "Main"); assert.equal(device.deviceIo.routingChannel, "1/2");
  const ioUndone = JSON.parse(((await call(10, "live_undo", { transactionId: ioPreview.transactionId, confirmation: "undo", idempotencyKey: "devio-undo-key" })) as any).result.content[0].text);
  assert.equal(ioUndone.state, "undone"); assert.equal(device.deviceIo.routingType, "Ext. In"); assert.equal(device.deviceIo.routingChannel, "1");
  device.sidechainRoutingType = "None";
  const scPreview = JSON.parse(((await call(11, "live_device_io_preview", { action: "sidechain", deviceRef: "device:utility-1", routingType: "Ext. In" })) as any).result.content[0].text);
  const scApplied = JSON.parse(((await call(12, "live_device_io_apply", { transactionId: scPreview.transactionId, confirmation: "apply", idempotencyKey: "devsc-key-1" })) as any).result.content[0].text);
  assert.equal(scApplied.state, "applied"); assert.equal(device.sidechainRoutingType, "Ext. In");
  assert.equal(((await call(13, "live_mixer_extended_preview", { trackRef: "track:track-1", crossfader: 2 })) as any).error.code, -32602);
});

test("device banks, automation re-enable, comparison save, chain insert, and cross-target moves", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  (simulator as any).state.tracks.push({ ref: "track:track-2", objectIdentity: "simulator:track:track-2", name: "Target", kind: "midi", volume: 0.85, pan: 0, mute: false, solo: false, armed: false, clips: [], clipSlots: [], devices: [], sends: [] });
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const snapshot = JSON.parse(((await call(2, "live_snapshot", {})) as any).result.content[0].text);
  const parameterRow = snapshot.snapshot.tracks[0].devices[0].parameters[0];
  assert.equal(parameterRow.defaultValue, 0.75); assert.equal(parameterRow.originalName, "Gain (dB)"); assert.equal(parameterRow.valueItems[0], "Off");
  const deviceRow = snapshot.snapshot.tracks[0].devices[0];
  assert.equal(deviceRow.parameterBank, 1); assert.equal(deviceRow.comparison.capability, true);
  const bankPreview = JSON.parse(((await call(3, "live_device_advanced_preview", { action: "set-bank", ref: "device:utility-1", bank: 0 })) as any).result.content[0].text);
  assert.equal(bankPreview.impact, "momentary-control-surface-bank-selection-no-undo");
  const bankApplied = JSON.parse(((await call(4, "live_device_advanced_apply", { transactionId: bankPreview.transactionId, confirmation: "apply", idempotencyKey: "bank-key-1" })) as any).result.content[0].text);
  assert.equal(bankApplied.state, "applied"); assert.equal((simulator as any).state.tracks[0].devices[0].chosenBank, 0);
  assert.equal(((await call(5, "live_undo", { transactionId: bankPreview.transactionId, confirmation: "undo", idempotencyKey: "bank-undo-1" })) as any).result.isError, true);
  const reenablePreview = JSON.parse(((await call(6, "live_device_advanced_preview", { action: "re-enable-automation", ref: "parameter:gain-1" })) as any).result.content[0].text);
  const reenabled = JSON.parse(((await call(7, "live_device_advanced_apply", { transactionId: reenablePreview.transactionId, confirmation: "apply", idempotencyKey: "reenable-1" })) as any).result.content[0].text);
  assert.equal(reenabled.state, "applied");
  assert.equal(((await call(8, "live_undo", { transactionId: reenablePreview.transactionId, confirmation: "undo", idempotencyKey: "reenable-undo" })) as any).result.isError, true);
  const comparePreview = JSON.parse(((await call(9, "live_device_advanced_preview", { action: "save-comparison", ref: "device:utility-1" })) as any).result.content[0].text);
  const compared = JSON.parse(((await call(10, "live_device_advanced_apply", { transactionId: comparePreview.transactionId, confirmation: "apply", idempotencyKey: "compare-1" })) as any).result.content[0].text);
  assert.equal(compared.state, "applied");
  const movePreview = JSON.parse(((await call(11, "live_device_advanced_preview", { action: "move-cross", ref: "device:utility-1", index: 0, targetTrackRef: "track:track-2" })) as any).result.content[0].text);
  const moved = JSON.parse(((await call(12, "live_device_advanced_apply", { transactionId: movePreview.transactionId, confirmation: "apply", idempotencyKey: "move-key-1" })) as any).result.content[0].text);
  assert.equal(moved.state, "applied");
  assert.equal((simulator as any).state.tracks[0].devices.length, 0); assert.equal((simulator as any).state.tracks[1].devices.length, 1);
  const moveUndone = JSON.parse(((await call(13, "live_undo", { transactionId: movePreview.transactionId, confirmation: "undo", idempotencyKey: "move-undo-1" })) as any).result.content[0].text);
  assert.equal(moveUndone.state, "undone");
  assert.equal((simulator as any).state.tracks[0].devices.length, 1); assert.equal((simulator as any).state.tracks[1].devices.length, 0);
  (simulator as any).state.tracks[0].devices[0].chains = [{ ref: "chain:rack-1:0", parentRef: "device:utility-1", objectIdentity: "simulator:chain:rack-1:0", index: 0, name: "Chain 1", mute: false, solo: false, devices: [] }];
  const insertPreview = JSON.parse(((await call(14, "live_device_advanced_preview", { action: "insert-chain", trackRef: "track:track-1", chainRef: "chain:rack-1:0", deviceName: "Utility" })) as any).result.content[0].text);
  const inserted = JSON.parse(((await call(15, "live_device_advanced_apply", { transactionId: insertPreview.transactionId, confirmation: "apply", idempotencyKey: "insert-key-1" })) as any).result.content[0].text);
  assert.equal(inserted.state, "applied"); assert.equal((simulator as any).state.tracks[0].devices[0].chains[0].devices.length, 1);
  assert.equal(((await call(16, "live_undo", { transactionId: insertPreview.transactionId, confirmation: "undo", idempotencyKey: "insert-undo-1" })) as any).result.isError, true);
  assert.equal(((await call(17, "live_device_advanced_preview", { action: "set-bank", ref: "device:utility-1", bank: 99 })) as any).error.code, -32602);
  assert.equal(((await call(18, "live_device_advanced_preview", { action: "set-bank", ref: "device:utility-1", bank: 1 })) as any).error.code, -32602);
});

test("chain color and flags, drum pads, rack properties/actions, and rack view", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const device = (simulator as any).state.tracks[0].devices[0];
  device.kind = "rack"; device.canHaveChains = true; device.canHaveDrumPads = true;
  device.chains = [{ ref: "chain:rack-1:0", parentRef: "device:utility-1", objectIdentity: "simulator:chain:rack-1:0", index: 0, name: "Chain 1", mute: false, solo: false, devices: [], colorIndex: 5, autoColor: false, hasAudioInput: true, hasMidiOutput: false, mutedViaSolo: false, inNote: 36, outNote: 51, chokeGroup: 1 }];
  device.drumPads = [{ ref: "drum-pad:rack-1:0", parentRef: "device:utility-1", index: 0, name: "Pad 1", mute: false, chains: [], note: 36, solo: false, objectIdentity: "simulator:drum-pad:rack-1:0" }];
  device.macros = [{ ref: "parameter:macro-1", objectIdentity: "simulator:parameter:macro-1", name: "Macro 1", value: 0 }];
  device.macroMapped = [true]; device.visibleMacroCount = 8; device.variationCount = 1; device.selectedVariationIndex = 0;
  device.rackView = { padScrollPosition: 0, showChainDevices: true, selectedChainRef: null, selectedPadIndex: null };
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const snapshot = JSON.parse(((await call(2, "live_snapshot", {})) as any).result.content[0].text);
  const chainRow = snapshot.snapshot.tracks[0].devices[0].chains[0];
  assert.equal(chainRow.colorIndex, 5); assert.equal(chainRow.hasAudioInput, true); assert.equal(chainRow.inNote, 36); assert.equal(chainRow.chokeGroup, 1);
  const padRow = snapshot.snapshot.tracks[0].devices[0].drumPads[0];
  assert.equal(padRow.note, 36); assert.equal(padRow.solo, false);
  const chainPreview = JSON.parse(((await call(3, "live_chain_preview", { chainRef: "chain:rack-1:0", colorIndex: 9, autoColor: true, mute: true, solo: true })) as any).result.content[0].text);
  const chainApplied = JSON.parse(((await call(4, "live_chain_apply", { transactionId: chainPreview.transactionId, confirmation: "apply", idempotencyKey: "chain-key-1" })) as any).result.content[0].text);
  assert.equal(chainApplied.state, "applied");
  const chain = device.chains[0];
  assert.equal(chain.colorIndex, 9); assert.equal(chain.autoColor, true); assert.equal(chain.mute, true); assert.equal(chain.solo, true);
  const chainUndone = JSON.parse(((await call(5, "live_undo", { transactionId: chainPreview.transactionId, confirmation: "undo", idempotencyKey: "chain-undo-1" })) as any).result.content[0].text);
  assert.equal(chainUndone.state, "undone");
  assert.equal(chain.colorIndex, 5); assert.equal(chain.mute, false); assert.equal(chain.solo, false);
  const padPreview = JSON.parse(((await call(6, "live_drum_pad_preview", { action: "set", padRef: "drum-pad:rack-1:0", solo: true })) as any).result.content[0].text);
  const padApplied = JSON.parse(((await call(7, "live_drum_pad_apply", { transactionId: padPreview.transactionId, confirmation: "apply", idempotencyKey: "pad-key-1" })) as any).result.content[0].text);
  assert.equal(padApplied.state, "applied");
  assert.equal(device.drumPads[0].note, 36); assert.equal(device.drumPads[0].solo, true);
  assert.equal(((await call(60, "live_drum_pad_preview", { action: "set", padRef: "drum-pad:rack-1:0", note: 40 })) as any).error.code, -32602);
  const padUndone = JSON.parse(((await call(8, "live_undo", { transactionId: padPreview.transactionId, confirmation: "undo", idempotencyKey: "pad-undo-1" })) as any).result.content[0].text);
  assert.equal(padUndone.state, "undone"); assert.equal(device.drumPads[0].solo, false);
  device.drumPads[0].chains = [{ ref: "chain:pad-1:0", parentRef: "drum-pad:rack-1:0", objectIdentity: "simulator:chain:pad-1:0", index: 0, name: "Pad Chain", mute: false, solo: false, devices: [] }];
  const deletePreview = JSON.parse(((await call(9, "live_drum_pad_preview", { action: "delete-all-chains", padRef: "drum-pad:rack-1:0" })) as any).result.content[0].text);
  assert.equal(deletePreview.impact, "deletes-all-pad-chains-no-undo");
  const deleted = JSON.parse(((await call(10, "live_drum_pad_apply", { transactionId: deletePreview.transactionId, confirmation: "apply", idempotencyKey: "pad-del-1" })) as any).result.content[0].text);
  assert.equal(deleted.state, "applied"); assert.equal(device.drumPads[0].chains.length, 0);
  assert.equal(((await call(11, "live_undo", { transactionId: deletePreview.transactionId, confirmation: "undo", idempotencyKey: "pad-del-undo" })) as any).result.isError, true);
  const rackPreview = JSON.parse(((await call(12, "live_rack_preview", { action: "set", rackRef: "device:utility-1", selectedVariationIndex: 0 })) as any).result.content[0].text);
  const rackApplied = JSON.parse(((await call(13, "live_rack_apply", { transactionId: rackPreview.transactionId, confirmation: "apply", idempotencyKey: "rack-key-1" })) as any).result.content[0].text);
  assert.equal(rackApplied.state, "applied"); assert.equal(device.selectedVariationIndex, 0);
  assert.equal(((await call(61, "live_rack_preview", { action: "set", rackRef: "device:utility-1", visibleMacroCount: 16 })) as any).error.code, -32602);
  const rackUndone = JSON.parse(((await call(14, "live_undo", { transactionId: rackPreview.transactionId, confirmation: "undo", idempotencyKey: "rack-undo-1" })) as any).result.content[0].text);
  assert.equal(rackUndone.state, "undone"); assert.equal(device.selectedVariationIndex, 0);
  const addPreview = JSON.parse(((await call(15, "live_rack_preview", { action: "add-macro", rackRef: "device:utility-1" })) as any).result.content[0].text);
  const added = JSON.parse(((await call(16, "live_rack_apply", { transactionId: addPreview.transactionId, confirmation: "apply", idempotencyKey: "rack-add-1" })) as any).result.content[0].text);
  assert.equal(added.state, "applied"); assert.equal(device.macros.length, 2); assert.equal(device.visibleMacroCount, 9);
  const insertPreview = JSON.parse(((await call(17, "live_rack_preview", { action: "insert-chain", rackRef: "device:utility-1" })) as any).result.content[0].text);
  const inserted = JSON.parse(((await call(18, "live_rack_apply", { transactionId: insertPreview.transactionId, confirmation: "apply", idempotencyKey: "rack-ins-1" })) as any).result.content[0].text);
  assert.equal(inserted.state, "applied"); assert.equal(device.chains.length, 2);
  assert.equal(((await call(19, "live_undo", { transactionId: addPreview.transactionId, confirmation: "undo", idempotencyKey: "rack-add-undo" })) as any).result.isError, true);
  const viewPreview = JSON.parse(((await call(20, "live_rack_view_preview", { rackRef: "device:utility-1", padScrollPosition: 4, showChainDevices: false })) as any).result.content[0].text);
  const viewApplied = JSON.parse(((await call(21, "live_rack_view_apply", { transactionId: viewPreview.transactionId, confirmation: "apply", idempotencyKey: "rackview-1" })) as any).result.content[0].text);
  assert.equal(viewApplied.state, "applied");
  assert.equal(device.rackView.padScrollPosition, 4); assert.equal(device.rackView.showChainDevices, false);
  const viewUndone = JSON.parse(((await call(22, "live_undo", { transactionId: viewPreview.transactionId, confirmation: "undo", idempotencyKey: "rackview-undo" })) as any).result.content[0].text);
  assert.equal(viewUndone.state, "undone"); assert.equal(device.rackView.padScrollPosition, 0); assert.equal(device.rackView.showChainDevices, true);
});

test("specialized device families, looper, and simpler sample replacement", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const drift = { ref: "device:drift-1", parentRef: "track:track-1", name: "Drift", kind: "instrument", className: "DriftDevice", parameters: [], objectIdentity: "simulator:device:drift-1", enabled: true, drift: { pitchBendRange: 12, voiceCount: 2, voiceMode: 0, voiceCountList: ["1", "4", "8", "16"], voiceModeList: ["Poly", "Mono"] } };
  (simulator as any).state.tracks[0].devices.push(drift);
  const looper = { ref: "device:looper-1", parentRef: "track:track-1", name: "Looper", kind: "audio-effect", className: "LooperDevice", parameters: [], objectIdentity: "simulator:device:looper-1", enabled: true, looper: { overdubAfterRecord: false, recordLengthIndex: 0, loopLength: 4, tempo: 120, state: 0 } };
  (simulator as any).state.tracks[0].devices.push(looper);
  const simpler = { ref: "device:simpler-1", parentRef: "track:track-1", name: "Simpler", kind: "instrument", className: "SimplerDevice", parameters: [], objectIdentity: "simulator:device:simpler-1", enabled: true, samplePath: "/old/a.wav" };
  (simulator as any).state.tracks[0].devices.push(simpler);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const driftPreview = JSON.parse(((await call(2, "live_device_specialized_preview", { family: "drift", deviceRef: "device:drift-1", pitchBendRange: 24, voiceCount: 3, voiceMode: 1 })) as any).result.content[0].text);
  const driftApplied = JSON.parse(((await call(3, "live_device_specialized_apply", { transactionId: driftPreview.transactionId, confirmation: "apply", idempotencyKey: "drift-key-1" })) as any).result.content[0].text);
  assert.equal(driftApplied.state, "applied");
  assert.equal(drift.drift.pitchBendRange, 24); assert.equal(drift.drift.voiceCount, 3); assert.equal(drift.drift.voiceMode, 1);
  const driftUndone = JSON.parse(((await call(4, "live_undo", { transactionId: driftPreview.transactionId, confirmation: "undo", idempotencyKey: "drift-undo-1" })) as any).result.content[0].text);
  assert.equal(driftUndone.state, "undone");
  assert.equal(drift.drift.pitchBendRange, 12); assert.equal(drift.drift.voiceCount, 2); assert.equal(drift.drift.voiceMode, 0);
  const looperPreview = JSON.parse(((await call(5, "live_looper_preview", { action: "set", deviceRef: "device:looper-1", overdubAfterRecord: true, recordLengthIndex: 1 })) as any).result.content[0].text);
  const looperApplied = JSON.parse(((await call(6, "live_looper_apply", { transactionId: looperPreview.transactionId, confirmation: "apply", idempotencyKey: "looper-key-1" })) as any).result.content[0].text);
  assert.equal(looperApplied.state, "applied");
  assert.equal(looper.looper.overdubAfterRecord, true); assert.equal(looper.looper.recordLengthIndex, 1);
  const looperUndone = JSON.parse(((await call(7, "live_undo", { transactionId: looperPreview.transactionId, confirmation: "undo", idempotencyKey: "looper-undo-1" })) as any).result.content[0].text);
  assert.equal(looperUndone.state, "undone");
  assert.equal(looper.looper.overdubAfterRecord, false); assert.equal(looper.looper.recordLengthIndex, 0);
  assert.equal(((await call(50, "live_looper_preview", { action: "set", deviceRef: "device:looper-1", loopLength: 8 })) as any).error.code, -32602);
  const recordPreview = JSON.parse(((await call(8, "live_looper_preview", { action: "record", deviceRef: "device:looper-1" })) as any).result.content[0].text);
  assert.equal(recordPreview.impact, "momentary-looper-action-no-undo");
  const recorded = JSON.parse(((await call(9, "live_looper_apply", { transactionId: recordPreview.transactionId, confirmation: "apply", idempotencyKey: "looper-rec-1" })) as any).result.content[0].text);
  assert.equal(recorded.state, "applied");
  assert.equal(((await call(10, "live_undo", { transactionId: recordPreview.transactionId, confirmation: "undo", idempotencyKey: "looper-rec-undo" })) as any).result.isError, true);
  const dir = mkdtempSync(join(tmpdir(), "simpler-import-"));
  const audioPath = join(dir, "sample.wav");
  writeFileSync(audioPath, Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from("simpler-bytes")]));
  const simplerPreview = JSON.parse(((await call(11, "live_simpler_preview", { deviceRef: "device:simpler-1", filePath: audioPath, allowedRoot: dir })) as any).result.content[0].text);
  assert.equal(simplerPreview.currentSample, "/old/a.wav");
  const simplerApplied = JSON.parse(((await call(12, "live_simpler_apply", { transactionId: simplerPreview.transactionId, confirmation: "apply", idempotencyKey: "simpler-key-1" })) as any).result.content[0].text);
  assert.equal(simplerApplied.state, "applied"); assert.match(simpler.samplePath, /ableton-mcp-import-/);
  const simplerUndone = JSON.parse(((await call(13, "live_undo", { transactionId: simplerPreview.transactionId, confirmation: "undo", idempotencyKey: "simpler-undo-1" })) as any).result.content[0].text);
  assert.equal(simplerUndone.state, "undone"); assert.equal(simpler.samplePath, "/old/a.wav");
  assert.equal(((await call(14, "live_device_specialized_preview", { family: "drift", deviceRef: "device:drift-1", pitchBendRange: 200 })) as any).error.code, -32602);
});

test("observer subscriptions dedupe, carry revision context, and honor quotas", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const sub = JSON.parse(((await call(2, "live_observe_subscribe", { topics: [{ kind: "transport" }, { kind: "track", ref: "track:track-1" }, { kind: "clip", ref: "clip:clip-1" }, { kind: "groove" }], minIntervalMs: 100 })) as any).result.content[0].text);
  assert.ok(sub.subscriptionId.startsWith("obs_")); assert.equal(sub.topics.length, 4); assert.equal(Object.keys(sub.revisions).length, 4);
  await new Promise((resolve) => setTimeout(resolve, 110));
  const quiet = JSON.parse(((await call(3, "live_observe_poll", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  assert.deepEqual(quiet.events, []); assert.equal(quiet.overflow, false); assert.equal(quiet.sequence, 1);
  (simulator as any).state.playback.transport.playing = true;
  (simulator as any).state.tracks[0].clips[0].loopStart = 1;
  (simulator as any).state.groovePool.amount = 0.5;
  await new Promise((resolve) => setTimeout(resolve, 110));
  const changed = JSON.parse(((await call(4, "live_observe_poll", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  const kinds = changed.events.map((event: any) => event.kind).sort();
  assert.deepEqual(kinds, ["clip", "groove", "transport"]);
  for (const event of changed.events) { assert.equal(event.revision.length, 64); assert.ok(Array.isArray(event.changedFields)); }
  await new Promise((resolve) => setTimeout(resolve, 110));
  const quietAgain = JSON.parse(((await call(5, "live_observe_poll", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  assert.deepEqual(quietAgain.events, []);
  (simulator as any).state.playback.transport.playing = false;
  const fast = JSON.parse(((await call(6, "live_observe_poll", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  assert.match(fast.reason, /minimum interval/);
  const unsubscribed = JSON.parse(((await call(7, "live_observe_unsubscribe", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  assert.equal(unsubscribed.unsubscribed, true);
  assert.equal(((await call(8, "live_observe_poll", { subscriptionId: sub.subscriptionId })) as any).result.isError, true);
  assert.equal(((await call(9, "live_observe_subscribe", { topics: [{ kind: "bogus" }] })) as any).error.code, -32602);
  assert.equal(((await call(10, "live_observe_subscribe", { topics: [{ kind: "meters", ref: "track:track-1" }, { kind: "meters", ref: "track:track-1" }] })) as any).result.isError, true);
});

test("browser roots reports binding tiers and preview declination", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const roots = JSON.parse(((await call(2, "live_browser_roots", {})) as any).result.content[0].text);
  const byName = Object.fromEntries(roots.roots.map((root: any) => [root.name, root]));
  assert.equal(byName.instruments.binding, "unofficial-internal");
  assert.equal(byName.instruments.searchable, true);
  assert.equal(byName.sounds.binding, "unofficial-internal");
  assert.equal(byName.legacy_libraries.searchable, false);
  assert.equal(roots.previewAvailable, false);
  assert.match(roots.bindingEvidence, /undocumented Remote Script internals/);
  assert.equal(roots.revision.length, 64);
});
