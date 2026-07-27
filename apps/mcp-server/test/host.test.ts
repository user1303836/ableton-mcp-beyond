import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION, serve } from "../src/host.js";
import { DeterministicLiveSimulator, type LiveAdapter, type LiveRef } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }

test("requires initialization and exposes only read-only tools", () => {
  const host = new McpHost();
  assert.equal((host.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as any).error.code, -32002);
  assert.equal((host.handle({ ...initialize, id: 2 }) as any).result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(host.handle(initialized), null);
  const tools = (host.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["server_status", "capabilities", "audio_analyze", "live_status", "live_snapshot", "live_discover", "live_session_audition_preview", "live_session_audition_apply", "live_session_audition_stop", "live_session_emergency_stop", "live_transport_preview", "live_transport_apply", "live_clip_launch_preview", "live_clip_launch_apply", "live_clip_launch_stop", "live_capture_midi", "live_scene_capture", "live_note_update_preview", "live_note_update_apply", "live_note_delete_preview", "live_note_delete_apply", "live_clip_duplicate_preview", "live_clip_duplicate_apply", "live_arrangement_clip_preview", "live_arrangement_clip_apply", "live_clip_move_preview", "live_clip_move_apply", "live_audio_clip_preview", "live_audio_clip_apply", "live_mixer_preview", "live_mixer_apply", "live_automation_preview", "live_automation_apply", "live_browser_search", "live_browser_load_preview", "live_browser_load_apply", "live_device_preview", "live_device_apply", "live_routing_preview", "live_routing_apply", "live_recording_preview", "live_recording_apply", "live_subscribe", "live_unsubscribe", "live_project_info", "live_project_backup_preview", "live_project_backup_apply", "live_project_save", "live_project_open", "live_realtime_arm_preview", "live_realtime_arm_apply", "live_realtime_disarm", "live_realtime_stats", "live_device_parameter_preview", "live_device_parameter_apply", "live_session_structure_preview", "live_session_structure_apply", "live_midi_clip_preview", "live_midi_clip_apply", "live_arrangement_section_preview", "live_arrangement_section_apply", "live_tempo_preview", "live_tempo_apply", "live_undo"]);
  const auditionPreview = tools.find((tool: { name: string }) => tool.name === "live_session_audition_preview");
  assert.deepEqual(auditionPreview.inputSchema.properties.outputSafety.required, ["safe", "provenance"]);
  const auditionStop = tools.find((tool: { name: string }) => tool.name === "live_session_audition_stop");
  assert.equal(auditionStop.inputSchema.properties.confirmation.minLength, 32);
  assert.equal(auditionStop.inputSchema.properties.confirmation.enum, undefined);
});

function auditionFixture() {
  const base = new DeterministicLiveSimulator();
  const state = base.snapshot() as any;
  state.set = { ...state.set, name: "Disposable Set" };
  state.tracks = state.tracks.map((track: any) => ({ ...track, armed: false, monitoringState: "off", playingSlotIndex: null, firedSlotIndex: null, clipSlots: [{ ref: "clip-slot:track-1:0", parentRef: track.ref, sceneIndex: 0, clipRef: track.clips[0].ref, empty: false }] }));
  state.playback = { ref: "session-playback:one", epoch: 1, revision: "baseline", transport: { playing: false, arrangementRecord: false, sessionRecord: false, position: 0, launchQuantization: { raw: "1-bar", normalized: "1-bar" }, loop: { enabled: false, start: 0, length: 4 }, punchIn: false, punchOut: false, metronome: false, countIn: 1 }, firedTargets: [], playingTargets: [] };
  const counts = { launches: 0, stops: 0, emergencies: 0 };
  const target = () => ({ trackRef: state.tracks[0].ref, clipSlotRef: state.tracks[0].clipSlots[0].ref, sceneRef: "scene:scene-1", sceneIndex: 0, clipRef: state.tracks[0].clips[0].ref });
  const adapter = {
    status: () => ({ ...base.status(), operations: ["status", "snapshot", "discover", "get", "set", "reconnect", "session.playback", "session.audition-launch", "session.audition-stop", "session.emergency-stop"] }),
    snapshot: () => structuredClone(state), get: (ref) => base.get(ref), set: (ref, property, value) => base.set(ref, property, value),
    invoke: () => { throw new Error("synchronous invoke is unavailable"); },
    subscribe: () => () => undefined, reconnect: () => base.status(),
    getAsync: async (ref: LiveRef) => base.get(ref), setAsync: async (ref: LiveRef, property: string, value: unknown) => base.set(ref, property, value), reconnectAsync: async () => base.status(),
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
        if (activeKeys.some((key) => !(invocation.args.expectedTargets as string[]).includes(key))) throw new Error("mapper emergency observation recheck failed");
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
        if (typeof args.countIn === "number") transport.countIn = args.countIn;
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
    call(4, "live_session_audition_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "audition-apply-1" }),
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
  const wrongLiteral = await call(4, "live_session_emergency_stop", { confirmation: "stop", expectedTargets: [] });
  assert.equal((wrongLiteral as any).error !== undefined || (wrongLiteral as any).result?.isError === true, true);
  assert.equal(counts.emergencies, 0);
  const blind = await call(5, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [] });
  assert.equal((blind as any).result.isError, true);
  assert.equal(counts.emergencies, 0);
  // Simulate host restart: a new host has no transaction state but retains the independent stop authority.
  const restarted = new McpHost(adapter);
  ready(restarted);
  const restartedCall = (id: number, name: string, args: unknown) => restarted.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const activeKey = `${state.tracks[0].ref}|${state.tracks[0].clipSlots[0].ref}|scene:scene-1`;
  const stopped = await restartedCall(6, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [activeKey] });
  assert.equal((stopped as any).result.isError, false);
  assert.equal(counts.emergencies, 1);
  assert.equal(state.playback.transport.playing, false);
  assert.equal(state.playback.playingTargets.length, 0);
  const alreadyStopped = await restartedCall(7, "live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets: [] });
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
  simulator.set("parameter:gain-1", "value", 0.4);
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

test("refuses Session-structure mutation when the precondition revision changes", () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = host.handle({ jsonrpc: "2.0", id: 84, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Lead", kind: "midi" }], scenes: [] } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  simulator.set("track:track-1", "name", "Externally renamed");
  const applied = host.handle({ jsonrpc: "2.0", id: 85, method: "tools/call", params: { name: "live_session_structure_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "structure-conflict" } } });
  assert.equal((applied as any).result.isError, true);
  assert.match((applied as any).result.content[0].text, /changed since preview/);
});

test("routes Session-structure preview and apply through the asynchronous adapter contract", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 86, method: "tools/call", params: { name: "live_session_structure_preview", arguments: { tracks: [{ name: "Async Bass", kind: "midi" }], scenes: [{ name: "Async Verse" }] } } });
  const transactionId = JSON.parse((preview as any).result.content[0].text).transactionId as string;
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 87, method: "tools/call", params: { name: "live_session_structure_apply", arguments: { transactionId, confirmation: "apply", idempotencyKey: "async-structure-1" } } });
  assert.equal((applied as any).result.isError, false);
  assert.equal(JSON.parse((applied as any).result.content[0].text).created.length, 2);
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
  assert.equal((host.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.length, 64);
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

test("delegates expanded discovery through the mandatory asynchronous adapter seam", async () => {
  const simulator = new DeterministicLiveSimulator();
  let request: unknown;
  simulator.discoverAsync = async (value) => { request = value; return { epoch: 1, items: [], truncated: false, revision: "1:return-track:0", kind: "return-track" }; };
  const host = new McpHost(simulator); ready(host);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 771, method: "tools/call", params: { name: "live_discover", arguments: { kind: "return-track", filter: {}, fields: ["name"], budget: 20, limit: 4 } } });
  assert.equal((result as any).result.isError, false);
  assert.deepEqual(request, { kind: "return-track", parent: undefined, filter: {}, fields: ["name"], budget: 20, limit: 4, cursor: undefined });
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

test("transport preview applies with a revision fence and guardedly undoes", async () => {
  const { adapter } = auditionFixture();
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
});

test("clip launch previews, applies with one dispatch, verifies, and stops through the owning track", async () => {
  const { state, adapter } = auditionFixture();
  let launches = 0;
  let trackStops = 0;
  const innerInvoke = adapter.invokeAsync;
  adapter.status = () => ({ ...(new DeterministicLiveSimulator()).status(), operations: ["status", "snapshot", "discover", "get", "set", "reconnect", "session.playback", "clip.launch", "track.stop"] });
  adapter.invokeAsync = async (invocation: any) => {
    if (invocation.operation === "clip.launch") {
      launches += 1;
      const slotRef = invocation.args.ref;
      const track = state.tracks[0];
      const scene = state.scenes[0];
      const target = { trackRef: track.ref, clipSlotRef: slotRef, sceneRef: scene.ref, sceneIndex: 0, clipRef: track.clips[0].ref };
      state.playback.transport.playing = true;
      state.playback.firedTargets = [target]; state.playback.playingTargets = [target]; state.playback.revision = "launched";
      return { launched: slotRef, targets: [target] };
    }
    if (invocation.operation === "track.stop") {
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
  const unsafe = await call(3, "live_clip_launch_preview", { slotRef: "clip-slot:track-1:0", outputSafety: { safe: true, provenance: "unknown" } });
  assert.equal((unsafe as any).result.isError, true);
  const [one, two] = await Promise.all([
    call(4, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "clip-apply-1" }),
    call(5, "live_clip_launch_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: "clip-apply-1" }),
  ]);
  assert.equal(launches, 1);
  assert.deepEqual([one, two].map((r) => JSON.parse((r as any).result.content[0].text).idempotent).sort(), [false, true]);
  const stopped = JSON.parse(((await call(6, "live_clip_launch_stop", { transactionId: preview.transactionId, confirmation: preview.stopConfirmation, idempotencyKey: "clip-stop-1" })) as any).result.content[0].text);
  assert.equal(stopped.state, "stopped");
  assert.equal(trackStops, 1);
  assert.equal(state.playback.playingTargets.length, 0);
});

test("capture MIDI and scene capture return verified new references", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const midi = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_capture_midi", arguments: { confirmation: "capture" } } });
  const midiResult = JSON.parse((midi as any).result.content[0].text);
  assert.equal(midiResult.captured, true);
  assert.equal(midiResult.clips.length, 1);
  const scene = await host.handleAsync({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "live_scene_capture", arguments: { confirmation: "capture" } } });
  const sceneResult = JSON.parse((scene as any).result.content[0].text);
  assert.equal(sceneResult.captured, true);
  assert.ok(sceneResult.sceneRef.startsWith("scene:"));
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

test("clip duplicate, arrangement lifecycle, move, and audio clip edits verify and fence", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  // Duplicate to a Session slot (slot 1 of track 1 is empty after creating a slot via structure)
  (simulator as any).state.tracks[0].clipSlots!.push({ ref: "clip-slot:track-1:1" as any, parentRef: "track:track-1" as any, sceneIndex: 1, empty: true });
  const dupPreview = JSON.parse(((await call(2, "live_clip_duplicate_preview", { clipRef: "clip:clip-1", targetTrackRef: "track:track-1", targetSceneIndex: 1 })) as any).result.content[0].text);
  const dup = JSON.parse(((await call(3, "live_clip_duplicate_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "dup-1" })) as any).result.content[0].text);
  assert.equal(dup.state, "applied");
  const dupReplay = JSON.parse(((await call(4, "live_clip_duplicate_apply", { transactionId: dupPreview.transactionId, confirmation: "apply", idempotencyKey: "dup-1" })) as any).result.content[0].text);
  assert.equal(dupReplay.idempotent, true);

  // Duplicate into the Arrangement
  const arrDupPreview = JSON.parse(((await call(5, "live_clip_duplicate_preview", { clipRef: "clip:clip-1", arrangementPosition: 8 })) as any).result.content[0].text);
  const arrDup = JSON.parse(((await call(6, "live_clip_duplicate_apply", { transactionId: arrDupPreview.transactionId, confirmation: "apply", idempotencyKey: "dup-arr" })) as any).result.content[0].text);
  assert.equal(arrDup.state, "applied");
  assert.equal(((simulator as any).state.arrangementClips ?? []).length, 1);

  // Arrangement create + move + delete with fencing
  const createPreview = JSON.parse(((await call(7, "live_arrangement_clip_preview", { action: "create", trackRef: "track:track-1", position: 16, length: 4, name: "Arranged" })) as any).result.content[0].text);
  const created = JSON.parse(((await call(8, "live_arrangement_clip_apply", { transactionId: createPreview.transactionId, confirmation: "apply", idempotencyKey: "arr-1" })) as any).result.content[0].text);
  assert.equal(created.state, "applied");
  const createdRef = (created.result as any).ref;
  const movePreview = JSON.parse(((await call(9, "live_clip_move_preview", { clipRef: createdRef, position: 24 })) as any).result.content[0].text);
  const moved = JSON.parse(((await call(10, "live_clip_move_apply", { transactionId: movePreview.transactionId, confirmation: "apply", idempotencyKey: "move-1" })) as any).result.content[0].text);
  assert.equal(moved.state, "applied");
  assert.equal(((simulator as any).state.arrangementClips ?? []).find((c: any) => c.clip.ref === createdRef)?.clip.start, 24);
  const deletePreview = JSON.parse(((await call(11, "live_arrangement_clip_preview", { action: "delete", clipRef: createdRef })) as any).result.content[0].text);
  const deleted = JSON.parse(((await call(12, "live_arrangement_clip_apply", { transactionId: deletePreview.transactionId, confirmation: "apply", idempotencyKey: "arr-del" })) as any).result.content[0].text);
  assert.equal(deleted.state, "applied");

  // Session slot move (duplicate + delete source)
  (simulator as any).state.tracks[0].clipSlots!.push({ ref: "clip-slot:track-1:2" as any, parentRef: "track:track-1" as any, sceneIndex: 2, empty: true });
  const slotMovePreview = JSON.parse(((await call(13, "live_clip_move_preview", { clipRef: "clip:clip-1", targetTrackRef: "track:track-1", targetSceneIndex: 2 })) as any).result.content[0].text);
  const slotMoved = JSON.parse(((await call(14, "live_clip_move_apply", { transactionId: slotMovePreview.transactionId, confirmation: "apply", idempotencyKey: "move-slot" })) as any).result.content[0].text);
  assert.equal(slotMoved.state, "applied");
  assert.equal(((simulator as any).state.tracks[0].clipSlots ?? [])[2]!.clipRef !== undefined, true);

  // Audio clip edits with prior capture and undo
  const audioClip = simulator.invoke({ operation: "clip.create", args: { trackRef: "track:track-1", kind: "audio", name: "Audio", start: 40, length: 8 } }) as any;
  const audioPreview = JSON.parse(((await call(15, "live_audio_clip_preview", { clipRef: audioClip.ref, gain: 0.5, pitchCoarse: -3, pitchFine: 12, loopStart: 1, loopEnd: 7, warpMode: 2 })) as any).result.content[0].text);
  const audioApplied = JSON.parse(((await call(16, "live_audio_clip_apply", { transactionId: audioPreview.transactionId, confirmation: "apply", idempotencyKey: "audio-1" })) as any).result.content[0].text);
  assert.equal(audioApplied.state, "applied");
  const audioRow = (simulator as any).state.tracks[0].clips.find((c: any) => c.ref === audioClip.ref)!;
  assert.equal((audioRow as any).gain, 0.5);
  assert.equal((audioRow as any).pitchCoarse, -3);
  assert.equal((audioRow as any).warpMode, 2);
});

test("mixer edits fence on the mixer row and guardedly undo", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const preview = JSON.parse(((await call(2, "live_mixer_preview", { trackRef: "track:track-1", volume: 0.5, pan: -0.25, cueVolume: 0.75, sends: [0.75, 0.5], solo: true })) as any).result.content[0].text);
  assert.equal(preview.prior.volume, 0.85);
  const applied = JSON.parse(((await call(3, "live_mixer_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "mixer-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.mixer.volume, 0.5);
  assert.equal(track.mixer.pan, -0.25);
  assert.equal(track.mixer.cueVolume, 0.75);
  assert.deepEqual(track.mixer.sends, [0.75, 0.5]);
  assert.equal(track.mixer.solo, true);
  const replay = JSON.parse(((await call(4, "live_mixer_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "mixer-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
  const undone = JSON.parse(((await call(5, "live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "mixer-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal(track.mixer.volume, 0.85);
  assert.equal(track.mixer.solo, false);
});

test("automation envelope lifecycle inserts, reads, deletes, and restores points", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const volumeRef = "parameter:mixer:0:volume";
  const create = JSON.parse(((await call(2, "live_automation_preview", { action: "create-envelope", clipRef: "clip:clip-1", parameterRef: volumeRef })) as any).result.content[0].text);
  const created = JSON.parse(((await call(3, "live_automation_apply", { transactionId: create.transactionId, confirmation: "apply", idempotencyKey: "env-1" })) as any).result.content[0].text);
  assert.equal(created.state, "applied");
  const insert = JSON.parse(((await call(4, "live_automation_preview", { action: "insert", clipRef: "clip:clip-1", parameterRef: volumeRef, points: [{ time: 0, value: 0.9 }, { time: 2, value: 0.4 }, { time: 3.5, value: 0.7 }] })) as any).result.content[0].text);
  const inserted = JSON.parse(((await call(5, "live_automation_apply", { transactionId: insert.transactionId, confirmation: "apply", idempotencyKey: "env-ins" })) as any).result.content[0].text);
  assert.equal(inserted.state, "applied");
  const clip = (simulator as any).state.tracks[0].clips[0];
  assert.equal(clip.envelopes[volumeRef].length, 3);
  const conflict = JSON.parse(((await call(6, "live_automation_preview", { action: "insert", clipRef: "clip:clip-1", parameterRef: volumeRef, points: [{ time: 1, value: 0.2 }] })) as any).result.content[0].text);
  assert.equal(conflict.current.points.length, 3);
  const delRange = JSON.parse(((await call(7, "live_automation_preview", { action: "delete-range", clipRef: "clip:clip-1", parameterRef: volumeRef, from: 1, to: 4 })) as any).result.content[0].text);
  const deleted = JSON.parse(((await call(8, "live_automation_apply", { transactionId: delRange.transactionId, confirmation: "apply", idempotencyKey: "env-del" })) as any).result.content[0].text);
  assert.equal(deleted.state, "applied");
  assert.equal(clip.envelopes[volumeRef].length, 1);
  const undone = JSON.parse(((await call(9, "live_undo", { transactionId: delRange.transactionId, confirmation: "undo", idempotencyKey: "env-undo" })) as any).result.content[0].text);
  assert.equal(undone.state, "undone");
  assert.equal(clip.envelopes[volumeRef].length, 3);
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
  const preview = JSON.parse(((await call(4, "live_browser_load_preview", { itemId: "instruments/Drum Rack", trackRef: "track:track-1" })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(5, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "load-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  assert.ok(applied.deviceRef.startsWith("device:"));
  const rack = (simulator as any).state.tracks[0].devices.at(-1);
  assert.equal(rack.name, "Drum Rack");
  assert.equal(rack.canHaveDrumPads, true);
  assert.equal(rack.drumPads.length, 16);
  const replay = JSON.parse(((await call(6, "live_browser_load_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "load-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
});

test("device insert, enable, move, and delete with exact fencing", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const insert = JSON.parse(((await call(2, "live_device_preview", { action: "insert", trackRef: "track:track-1", deviceName: "Echo" })) as any).result.content[0].text);
  const inserted = JSON.parse(((await call(3, "live_device_apply", { transactionId: insert.transactionId, confirmation: "apply", idempotencyKey: "dev-ins" })) as any).result.content[0].text);
  assert.equal(inserted.state, "applied");
  const deviceRef = (inserted.result as any).ref;
  const enable = JSON.parse(((await call(4, "live_device_preview", { action: "enable", deviceRef, enabled: false })) as any).result.content[0].text);
  const disabled = JSON.parse(((await call(5, "live_device_apply", { transactionId: enable.transactionId, confirmation: "apply", idempotencyKey: "dev-dis" })) as any).result.content[0].text);
  assert.equal(disabled.state, "applied");
  assert.equal((simulator as any).state.tracks[0].devices.at(-1).enabled, false);
  const move = JSON.parse(((await call(6, "live_device_preview", { action: "move", deviceRef, index: 0 })) as any).result.content[0].text);
  const moved = JSON.parse(((await call(7, "live_device_apply", { transactionId: move.transactionId, confirmation: "apply", idempotencyKey: "dev-move" })) as any).result.content[0].text);
  assert.equal(moved.state, "applied");
  assert.equal((simulator as any).state.tracks[0].devices[0].name, "Echo");
  const del = JSON.parse(((await call(8, "live_device_preview", { action: "delete", deviceRef })) as any).result.content[0].text);
  const deleted = JSON.parse(((await call(9, "live_device_apply", { transactionId: del.transactionId, confirmation: "apply", idempotencyKey: "dev-del" })) as any).result.content[0].text);
  assert.equal(deleted.state, "applied");
  assert.equal((simulator as any).state.tracks[0].devices.some((d: any) => d.name === "Echo"), false);
});

test("routing edits guard feedback and fence on routing state", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const feedback = await call(2, "live_routing_preview", { trackRef: "track:track-1", outputType: "Drums" });
  assert.equal((feedback as any).result.isError, true);
  const preview = JSON.parse(((await call(3, "live_routing_preview", { trackRef: "track:track-1", outputType: "Main", arm: true, monitoring: "in" })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(4, "live_routing_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "route-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.armed, true);
  assert.equal(track.monitoringState, "in");
  const replay = JSON.parse(((await call(5, "live_routing_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "route-1" })) as any).result.content[0].text);
  assert.equal(replay.idempotent, true);
});

test("realtime control requires real provenance and arms exact bounded channels idempotently", async () => {
  const simulator = new DeterministicLiveSimulator();
  let provenance: "fake-live" | "real-live" = "fake-live";
  let armed = false;
  let armCalls = 0;
  const operations = ["status", "snapshot", "discover", "get", "set", "reconnect", "session.playback", "realtime.arm", "realtime.disarm", "realtime.stats"];
  const adapter = {
    status: () => ({ ...simulator.status(), adapter: "remote-script", epoch: 7, provenance, registryHash: "registry-v1", operations }),
    snapshot: () => simulator.snapshot(), get: (ref: LiveRef) => simulator.get(ref), set: (ref: LiveRef, property: string, value: unknown) => simulator.set(ref, property, value), invoke: () => { throw new Error("synchronous invoke is unavailable"); }, subscribe: () => () => undefined, reconnect: () => simulator.status(),
    snapshotAsync: async () => simulator.snapshot(), discoverAsync: async () => ({ epoch: 7, items: [], truncated: false, revision: "7:empty", kind: "track" }), getAsync: async (ref: LiveRef) => simulator.get(ref), setAsync: async (ref: LiveRef, property: string, value: unknown) => simulator.set(ref, property, value), reconnectAsync: async () => simulator.status(), close: async () => undefined,
    invokeAsync: async (invocation: any) => {
      if (invocation.operation === "realtime.arm") {
        armCalls += 1; armed = true;
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
});

test("recording preview gates intent, destination, and recording state", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const unsafe = await call(2, "live_recording_preview", { action: "start", lane: "session", intent: "capture a take", outputSafety: { safe: true, provenance: "unknown" } });
  assert.equal((unsafe as any).result.isError, true);
  const unarmed = await call(3, "live_recording_preview", { action: "start", lane: "arrangement", intent: "record arrangement pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } });
  assert.equal((unarmed as any).result.isError, true);
  (simulator as any).state.tracks[0].armed = true;
  const preview = JSON.parse(((await call(4, "live_recording_preview", { action: "start", lane: "arrangement", intent: "record arrangement pass", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } })) as any).result.content[0].text);
  const applied = JSON.parse(((await call(5, "live_recording_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "rec-1" })) as any).result.content[0].text);
  assert.equal(applied.state, "applied");
  assert.equal((simulator as any).state.playback.transport.arrangementRecord, true);
  const alreadyActive = await call(6, "live_recording_preview", { action: "start", lane: "arrangement", intent: "again", destinationTrackRef: "track:track-1", outputSafety: { safe: true, provenance: "operator-confirmed" } });
  assert.equal((alreadyActive as any).result.isError, true);
  const stopPreview = JSON.parse(((await call(7, "live_recording_preview", { action: "stop", lane: "arrangement", intent: "stop the pass", outputSafety: { safe: true, provenance: "operator-confirmed" } })) as any).result.content[0].text);
  const stopped = JSON.parse(((await call(8, "live_recording_apply", { transactionId: stopPreview.transactionId, confirmation: "apply", idempotencyKey: "rec-stop" })) as any).result.content[0].text);
  assert.equal(stopped.recording, false);
});
