import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }
type Call = (id: number, name: string, args: unknown) => Promise<any>;
function hostCall(host: McpHost): Call {
  return (id, name, args) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as Promise<any>;
}

const previewArgs: Array<[string, unknown]> = [
  ["live_warp_marker_preview", { clipRef: "clip:audio-1", action: "add", beatTime: 2 }],
  ["live_clip_action_preview", { clipRef: "clip:clip-1", action: "crop" }],
  ["live_note_edit_preview", { clipRef: "clip:clip-1", action: "duplicate", noteIds: [1] }],
  ["live_note_read", { clipRef: "clip:clip-1", noteIds: [1] }],
  ["live_tuning_preview", { referencePitch: 432 }],
  ["live_groove_preview", { action: "set-amount", grooveAmount: 0.5 }],
  ["live_scene_preview", { ref: "scene:scene-1", colorIndex: 5 }],
  ["live_scene_fire_preview", { ref: "scene:scene-1" }],
  ["live_song_state", {}],
  ["live_performance_read", {}],
  ["live_transport_action_preview", { action: "start" }],
  ["live_track_structure_preview", { action: "create-return", name: "Verb" }],
  ["live_device_delete_preview", { ref: "device:utility-1" }],
  ["live_track_view_preview", { ref: "track:track-1", collapsed: true }],
  ["live_selection_preview", { trackRef: "track:track-1", drawMode: true }],
  ["live_clip_view_preview", { clipRef: "clip:clip-1", gridQuantization: 4 }],
  ["live_device_view_preview", { ref: "device:utility-1", collapsed: true }],
  ["live_application_dialog_preview", {}],
  ["live_mixer_extended_preview", { trackRef: "track:track-1", trackActivator: false }],
  ["live_chain_mixer_preview", { chainRef: "chain:rack-1:0", volume: 0.5 }],
  ["live_device_io_preview", { action: "routing", deviceRef: "device:utility-1", routingType: "Main" }],
  ["live_device_advanced_preview", { action: "set-bank", ref: "device:utility-1", bank: 2 }],
  ["live_chain_preview", { chainRef: "chain:rack-1:0", colorIndex: 9 }],
  ["live_drum_pad_preview", { action: "set", padRef: "drum-pad:rack-1:0", note: 40 }],
  ["live_rack_preview", { action: "set", rackRef: "device:utility-1", visibleMacroCount: 16 }],
  ["live_rack_view_preview", { rackRef: "device:utility-1", padScrollPosition: 4 }],
  ["live_device_specialized_preview", { family: "drift", deviceRef: "device:drift-1", pitchBendRange: 24 }],
  ["live_looper_preview", { action: "set", deviceRef: "device:looper-1", speed: 2 }],
  ["live_simpler_preview", { deviceRef: "device:simpler-1", filePath: "/nonexistent/sample.wav", allowedRoot: "/nonexistent" }],
  ["live_observe_unsubscribe", { subscriptionId: "obs_missing" }],
  ["live_browser_roots", {}],
];

test("new-surface previews and reads fail closed with bounded guidance when the adapter is unavailable", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  (simulator as any).status = () => { throw new Error("adapter process unavailable"); };
  (simulator as any).snapshot = () => { throw new Error("adapter process unavailable"); };
  (simulator as any).snapshotAsync = async () => { throw new Error("adapter process unavailable"); };
  const call = hostCall(host);
  let nextId = 2;
  for (const [name, args] of previewArgs) {
    const result = await call(nextId, name, args);
    nextId += 1;
    assert.equal(result.error, undefined, `${name} must reach the adapter, got ${JSON.stringify(result).slice(0, 160)}`);
    assert.equal(result.result?.isError, true, `${name} must fail closed, got ${JSON.stringify(result).slice(0, 160)}`);
    const payload = JSON.parse(result.result.content[0].text);
    assert.equal(typeof payload.remediation, "string", `${name} must carry operator guidance`);
    assert.ok(payload.remediation.length > 0, `${name} guidance must not be empty`);
  }
});

function rackChainFixture(simulator: DeterministicLiveSimulator): void {
  const device = (simulator as any).state.tracks[0].devices[0];
  device.kind = "rack"; device.canHaveChains = true; device.canHaveDrumPads = true;
  device.chains = [{ ref: "chain:rack-1:0", parentRef: "device:utility-1", objectIdentity: "simulator:chain:rack-1:0", index: 0, name: "Chain 1", mute: false, solo: false, devices: [], colorIndex: 5, autoColor: false, hasAudioInput: true, hasMidiOutput: false, mutedViaSolo: false, inNote: 36, outNote: 51, chokeGroup: 1, mixer: { volume: 1, pan: 0, sends: [0.5], volumeRef: "parameter:chain:0:volume", panningRef: "parameter:chain:0:panning", sendRefs: ["parameter:chain:0:sends:0"], chainActivatorRef: "parameter:chain:0:activator", mixerIdentity: "simulator:chain-mixer:0" } }];
  device.drumPads = [{ ref: "drum-pad:rack-1:0", parentRef: "device:utility-1", index: 0, name: "Pad 1", mute: false, chains: [], note: 36, solo: false, objectIdentity: "simulator:drum-pad:rack-1:0" }];
  device.deviceIo = { routingType: "Ext. In", routingChannel: "1" };
  device.macros = [{ ref: "parameter:macro-1", objectIdentity: "simulator:parameter:macro-1", name: "Macro 1", value: 0 }];
  device.macroMapped = [true]; device.visibleMacroCount = 8; device.variationCount = 1; device.selectedVariationIndex = 0;
  device.rackView = { padScrollPosition: 0, showChainDevices: true, selectedChainRef: null, selectedPadIndex: null };
}

function specializedFixture(simulator: DeterministicLiveSimulator): void {
  (simulator as any).state.tracks[0].devices.push(
    { ref: "device:drift-1", parentRef: "track:track-1", name: "Drift", kind: "instrument", className: "DriftDevice", parameters: [], objectIdentity: "simulator:device:drift-1", enabled: true, pitchBendRange: 12, voiceCount: 8, voiceMode: 0 },
    { ref: "device:looper-1", parentRef: "track:track-1", name: "Looper", kind: "audio-effect", className: "LooperDevice", parameters: [], objectIdentity: "simulator:device:looper-1", enabled: true, speed: 1, loopLength: 4, tempo: 120, fixedRecordLength: 0, state: 0 },
    { ref: "device:simpler-1", parentRef: "track:track-1", name: "Simpler", kind: "instrument", className: "SimplerDevice", parameters: [], objectIdentity: "simulator:device:simpler-1", enabled: true, samplePath: "/old/a.wav" },
  );
}

function warpFixture(simulator: DeterministicLiveSimulator): void {
  const track = (simulator as any).state.tracks[0];
  track.clips.push({ ref: "clip:audio-1", objectIdentity: "simulator:clip:audio-1", name: "Audio", kind: "audio", isAudio: true, start: 0, length: 4, notes: [], warp: true, takes: [], automation: [], muted: false, warpMarkers: [{ beatTime: 1, sampleTime: 44100 }, { beatTime: 3, sampleTime: 132300 }] });
  track.clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: "clip:audio-1", empty: false });
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Scene 2", index: 1 });
}

const applyCases: Array<{ preview: string; apply: string; args: unknown; setup?: (simulator: DeterministicLiveSimulator) => void }> = [
  { preview: "live_warp_marker_preview", apply: "live_warp_marker_apply", args: { clipRef: "clip:audio-1", action: "add", beatTime: 2 }, setup: warpFixture },
  { preview: "live_clip_action_preview", apply: "live_clip_action_apply", args: { clipRef: "clip:clip-1", action: "crop" } },
  { preview: "live_note_edit_preview", apply: "live_note_edit_apply", args: { clipRef: "clip:clip-1", action: "duplicate", noteIds: [1] } },
  { preview: "live_tuning_preview", apply: "live_tuning_apply", args: { referencePitch: 432 } },
  { preview: "live_groove_preview", apply: "live_groove_apply", args: { action: "set-amount", grooveAmount: 0.5 } },
  { preview: "live_scene_preview", apply: "live_scene_apply", args: { ref: "scene:scene-1", colorIndex: 5 } },
  { preview: "live_scene_fire_preview", apply: "live_scene_fire_apply", args: { ref: "scene:scene-1" } },
  { preview: "live_transport_action_preview", apply: "live_transport_action_apply", args: { action: "continue" } },
  { preview: "live_track_structure_preview", apply: "live_track_structure_apply", args: { action: "create-return", name: "Verb" } },
  { preview: "live_device_delete_preview", apply: "live_device_delete_apply", args: { ref: "device:utility-1" } },
  { preview: "live_track_view_preview", apply: "live_track_view_apply", args: { ref: "track:track-1", collapsed: true } },
  { preview: "live_selection_preview", apply: "live_selection_apply", args: { trackRef: "track:track-1", drawMode: true } },
  { preview: "live_clip_view_preview", apply: "live_clip_view_apply", args: { clipRef: "clip:clip-1", gridQuantization: 4 } },
  { preview: "live_device_view_preview", apply: "live_device_view_apply", args: { ref: "device:utility-1", collapsed: true } },
  { preview: "live_application_dialog_preview", apply: "live_application_dialog_apply", args: { button: 1 } },
  { preview: "live_mixer_extended_preview", apply: "live_mixer_extended_apply", args: { trackRef: "track:track-1", trackActivator: false } },
  { preview: "live_chain_mixer_preview", apply: "live_chain_mixer_apply", args: { chainRef: "chain:rack-1:0", volume: 0.5 }, setup: rackChainFixture },
  { preview: "live_device_io_preview", apply: "live_device_io_apply", args: { action: "routing", deviceRef: "device:utility-1", routingType: "Main", routingChannel: "1/2" }, setup: rackChainFixture },
  { preview: "live_device_advanced_preview", apply: "live_device_advanced_apply", args: { action: "set-bank", ref: "device:utility-1", bank: 2 } },
  { preview: "live_chain_preview", apply: "live_chain_apply", args: { chainRef: "chain:rack-1:0", colorIndex: 9 }, setup: rackChainFixture },
  { preview: "live_drum_pad_preview", apply: "live_drum_pad_apply", args: { action: "set", padRef: "drum-pad:rack-1:0", note: 40 }, setup: rackChainFixture },
  { preview: "live_rack_preview", apply: "live_rack_apply", args: { action: "set", rackRef: "device:utility-1", visibleMacroCount: 16 }, setup: rackChainFixture },
  { preview: "live_rack_view_preview", apply: "live_rack_view_apply", args: { rackRef: "device:utility-1", padScrollPosition: 4 }, setup: rackChainFixture },
  { preview: "live_device_specialized_preview", apply: "live_device_specialized_apply", args: { family: "drift", deviceRef: "device:drift-1", pitchBendRange: 24 }, setup: specializedFixture },
  { preview: "live_looper_preview", apply: "live_looper_apply", args: { action: "set", deviceRef: "device:looper-1", speed: 2 }, setup: specializedFixture },
];

test("new-surface applies report uncertainty with bounded guidance when dispatch fails", async () => {
  for (const [index, entry] of applyCases.entries()) {
    const simulator = new DeterministicLiveSimulator();
    const host = new McpHost(simulator);
    ready(host);
    entry.setup?.(simulator);
    const call = hostCall(host);
    const previewResult = await call(2, entry.preview, entry.args);
    assert.equal(previewResult.error, undefined, `${entry.preview} args must validate, got ${JSON.stringify(previewResult).slice(0, 160)}`);
    const preview = JSON.parse(previewResult.result.content[0].text);
    assert.ok(typeof preview.transactionId === "string", `${entry.preview} must mint a transaction, got ${JSON.stringify(previewResult).slice(0, 160)}`);
    (simulator as any).invokeAsync = async () => { throw new Error("remote adapter request state uncertain after dispatch timeout"); };
    const applied = await call(3, entry.apply, { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: `dispatch-fail-${index}` });
    assert.equal(applied.error, undefined, `${entry.apply} must surface a tool error, got ${JSON.stringify(applied).slice(0, 160)}`);
    assert.equal(applied.result?.isError, true, `${entry.apply} must fail closed, got ${JSON.stringify(applied).slice(0, 160)}`);
    const payload = JSON.parse(applied.result.content[0].text);
    assert.equal(typeof payload.remediation, "string", `${entry.apply} must carry operator guidance`);
  }
});

test("simpler sample replacement reports uncertainty when the import dispatch fails", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  specializedFixture(simulator);
  const dir = mkdtempSync(join(tmpdir(), "simpler-fail-"));
  const audioPath = join(dir, "sample.wav");
  writeFileSync(audioPath, Buffer.from("RIFF-failure-bytes"));
  const call = hostCall(host);
  const preview = JSON.parse(((await call(2, "live_simpler_preview", { deviceRef: "device:simpler-1", filePath: audioPath, allowedRoot: dir })) as any).result.content[0].text);
  (simulator as any).invokeAsync = async () => { throw new Error("remote adapter request state uncertain after dispatch timeout"); };
  const applied = await call(3, "live_simpler_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "simpler-dispatch-fail" });
  assert.equal((applied as any).result?.isError, true);
  const payload = JSON.parse((applied as any).result.content[0].text);
  assert.match(payload.remediation, /Simpler state is uncertain/);
});

test("simulator validation refuses malformed new-surface operations", () => {
  const simulator = new DeterministicLiveSimulator();
  const invoke = (operation: string, args: Record<string, unknown>) => simulator.invoke({ operation: operation as never, args: args as never });
  assert.throws(() => invoke("session.audition-launch", { ref: "scene:scene-1", setName: "Disposable Set", sceneName: 5 }), TypeError);
  assert.throws(() => invoke("session.audition-launch", { ref: "scene:scene-1", setName: "Disposable Set", sceneName: "Scene 1", sceneIndex: -1 }), RangeError);
  assert.throws(() => invoke("session.audition-launch", { ref: "scene:scene-1", setName: "Disposable Set", sceneName: "Scene 1", sceneIndex: 0, playbackRevision: "rev", eligibleTargets: [] }), TypeError);
  assert.throws(() => invoke("recording.session", { action: "pause" }), RangeError);
  assert.throws(() => invoke("recording.arrangement", { action: "pause" }), RangeError);
  assert.throws(() => invoke("take-lane.create", { trackRef: "track:track-1", expectedTrackIdentity: "stale-identity" }), /identity changed/);
});

test("simulator envelope deletion verifies authority and reports missing envelopes", () => {
  const simulator = new DeterministicLiveSimulator();
  const invoke = (args: Record<string, unknown>) => simulator.invoke({ operation: "automation.envelope.delete" as never, args: args as never });
  const clip = (simulator as any).state.tracks[0].clips[0];
  clip.envelopes = { "parameter:gain-1": [{ time: 0, value: 0.5 }] };
  const authority = () => ({ clipRef: "clip:clip-1", parameterRef: "parameter:gain-1", expectedAuthorityDigest: (simulator as any).automationAuthorityDigest("clip:clip-1", "parameter:gain-1"), expectedEnvelopeRevision: (simulator as any).envelopeRevision(clip, "parameter:gain-1") });
  assert.throws(() => invoke({ clipRef: "clip:clip-1", parameterRef: "parameter:gain-1", expectedAuthorityDigest: "stale", expectedEnvelopeRevision: "stale" }), /changed since preview/);
  const deleted = invoke(authority()) as { deleted?: unknown };
  assert.equal(deleted.deleted, true);
  assert.equal(clip.envelopes["parameter:gain-1"], undefined);
  assert.throws(() => invoke(authority()), /envelope does not exist/);
});

test("observer digests cover device, parameter, meters, rack, tuning, scene, and selection topics", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = hostCall(host);
  const sub = JSON.parse(((await call(2, "live_observe_subscribe", {
    topics: [
      { kind: "device", ref: "device:utility-1" },
      { kind: "parameter", ref: "parameter:gain-1" },
      { kind: "meters", ref: "track:track-1" },
      { kind: "rack", ref: "device:utility-1" },
      { kind: "tuning" },
      { kind: "scene", ref: "scene:scene-1" },
      { kind: "selection" },
    ],
    minIntervalMs: 100,
  })) as any).result.content[0].text);
  assert.equal(sub.topics.length, 7);
  (simulator as any).state.tracks[0].devices[0].enabled = false;
  (simulator as any).state.tracks[0].devices[0].parameters[0].value = 0.25;
  (simulator as any).state.tuning.system.referencePitch = 432;
  (simulator as any).state.scenes[0].colorIndex = 7;
  (simulator as any).state.selection = { ...(simulator as any).state.selection, trackRef: "track:track-2" };
  await new Promise((resolve) => setTimeout(resolve, 110));
  const changed = JSON.parse(((await call(3, "live_observe_poll", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  const kinds = changed.events.map((event: any) => event.kind).sort();
  assert.ok(kinds.includes("device") && kinds.includes("parameter") && kinds.includes("tuning") && kinds.includes("scene") && kinds.includes("selection"), `expected digest changes, got ${kinds.join(",")}`);
  const unsubscribed = JSON.parse(((await call(4, "live_observe_unsubscribe", { subscriptionId: sub.subscriptionId })) as any).result.content[0].text);
  assert.equal(unsubscribed.unsubscribed, true);
});

test("observer subscriptions reject unknown refs and enforce the subscription quota", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  ready(host);
  const call = hostCall(host);
  assert.equal(((await call(2, "live_observe_subscribe", { topics: [{ kind: "device", ref: "device:missing" }] })) as any).result.isError, true);
  assert.equal(((await call(3, "live_observe_subscribe", { topics: [{ kind: "parameter", ref: "parameter:missing" }] })) as any).result.isError, true);
  const oversized = await call(4, "live_observe_subscribe", { topics: Array.from({ length: 65 }, (_, index) => ({ kind: "track", ref: `track:t-${index}` })) });
  assert.ok((oversized as any).error?.code === -32602 || (oversized as any).result?.isError === true, "over-64 topics must be refused");
  const ids: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const sub = JSON.parse(((await call(10 + index, "live_observe_subscribe", { topics: [{ kind: "transport" }] })) as any).result.content[0].text);
    ids.push(sub.subscriptionId);
  }
  const ninth = await call(20, "live_observe_subscribe", { topics: [{ kind: "transport" }] });
  assert.ok((ninth as any).result?.isError === true || (ninth as any).error?.code === -32602, "the ninth subscription must be refused by quota");
  for (const [index, subscriptionId] of ids.entries()) await call(30 + index, "live_observe_unsubscribe", { subscriptionId });
});
