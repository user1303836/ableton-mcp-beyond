import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, type LiveAdapter, type LiveInvocation } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function ready(host: McpHost): void { host.handle(initialize); host.handle(initialized); }

interface Rig {
  simulator: DeterministicLiveSimulator;
  host: McpHost;
  call: (name: string, args: unknown) => Promise<unknown>;
  parse: (promise: Promise<unknown>) => Promise<any>;
  failures: { updateCalls: number; addBatchCalls: number; failOnUpdateCall: number | null; failOnAddBatchCall: number | null };
}

function midiRig(noteCount: number): Rig {
  const simulator = new DeterministicLiveSimulator();
  const state = (simulator as any).state;
  const clip = state.tracks[0].clips[0];
  clip.notes = Array.from({ length: noteCount }, (_, index) => ({
    pitch: 40 + (index % 40), start: (index % 64) / 16, duration: 0.25, velocity: 90, channel: 1, id: 1000 + index,
    mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64,
  }));
  clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
  state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Target", index: 1 });
  state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const failures = { updateCalls: 0, addBatchCalls: 0, failOnUpdateCall: null as number | null, failOnAddBatchCall: null as number | null };
  const inner = simulator.invokeAsync.bind(simulator);
  (simulator as any).invokeAsync = async (invocation: LiveInvocation, _context?: unknown) => {
    if (invocation.operation === "note.update") {
      failures.updateCalls += 1;
      if (failures.failOnUpdateCall === failures.updateCalls) throw new Error("injected note update failure");
    }
    if (invocation.operation === "note.add-batch") {
      failures.addBatchCalls += 1;
      if (failures.failOnAddBatchCall === failures.addBatchCalls) throw new Error("injected note add failure");
    }
    return inner(invocation);
  };
  const host = new McpHost(simulator as unknown as LiveAdapter);
  ready(host);
  let requestId = 7000;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  return { simulator, host, call, parse, failures };
}

test("identity-bound fence: a content swap between same-onset notes refuses undo", async () => {
  const { simulator, call, parse } = midiRig(2);
  const clip = (simulator as any).state.tracks[0].clips[0];
  clip.notes[0] = { ...clip.notes[0], pitch: 60, start: 1, id: 1 };
  clip.notes[1] = { ...clip.notes[1], pitch: 64, start: 1, id: 2 };
  clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 1 } }));
  const applied = await parse(call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "swap-apply" }));
  assert.equal(applied.state, "applied");
  // External edit: swap ALL canonical content between the two same-onset notes;
  // the ID-agnostic digest is unchanged, the identity-bound digest is not.
  const [a, b] = clip.notes;
  const swapped = { ...a, id: b.id };
  clip.notes[0] = { ...b, id: a.id };
  clip.notes[1] = swapped;
  clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
  const refused = await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "swap-undo" });
  assert.equal((refused as any).result.isError, true);
  assert.match(JSON.parse((refused as any).result.content[0].text).reason, /changed after apply/);
  // The record stays applied and retryable (never wedged in an active state).
  const again = await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "swap-undo-2" });
  assert.equal((again as any).result.isError, true);
  assert.match(JSON.parse((again as any).result.content[0].text).reason, /changed after apply/);
  assert.equal(clip.notes[0].pitch, 65);
  assert.equal(clip.notes[1].pitch, 61);
});

test("chunked apply fails closed when an external edit lands between chunks", async () => {
  const { simulator, call, parse } = midiRig(600);
  const clip = (simulator as any).state.tracks[0].clips[0];
  const inner = (simulator as any).invokeAsync;
  let updated = false;
  (simulator as any).invokeAsync = async (invocation: LiveInvocation, _context?: unknown) => {
    const result = await inner(invocation);
    if (!updated && invocation.operation === "note.update") {
      // External edit between chunk 1 and chunk 2: same identity set.
      clip.notes[550]!.velocity = 17;
      clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
      updated = true;
    }
    return result;
  };
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 2 }, scope: "in-place" }));
  const applied = await call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "interim-apply" });
  assert.equal((applied as any).result.isError, true);
  assert.match(JSON.parse((applied as any).result.content[0].text).reason, /refusing to overwrite external edits|uncertain/);
  assert.equal(clip.notes[550].velocity, 17, "the external edit is never overwritten by preview-time values");
});

test("chunked undo resumes after a mid-plan failure and converges on exact-key retry", async () => {
  const { simulator, call, parse, failures } = midiRig(600);
  const clip = (simulator as any).state.tracks[0].clips[0];
  const priorVelocities = clip.notes.map((note: { velocity: number }) => note.velocity);
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 5 }, scope: "in-place" }));
  const applied = await parse(call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "resume-apply" }));
  assert.equal(applied.state, "applied");
  failures.updateCalls = 0;
  failures.failOnUpdateCall = 2;
  const first = await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "resume-undo" });
  assert.equal((first as any).result.isError, true);
  assert.equal(failures.updateCalls, 2, "the first chunk restored before the injected failure");
  failures.failOnUpdateCall = null;
  const retried = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "resume-undo" }));
  assert.equal(retried.state, "undone");
  assert.deepEqual(clip.notes.map((note: { velocity: number }) => note.velocity), priorVelocities);
  assert.ok(clip.notes.every((note: { pitch: number }, index: number) => note.pitch === 40 + (index % 40)));
});

test("duplicate-scope retry resumes the original plan instead of re-transforming partial output", async () => {
  const { simulator, call, parse, failures } = midiRig(4);
  failures.failOnAddBatchCall = 1;
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "repeat", params: { times: 2 }, scope: "duplicate", target: { trackRef: "track:track-1", sceneIndex: 1 } }));
  const first = await call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "dup-resume" });
  assert.equal((first as any).result.isError, true);
  const createdRef = JSON.parse((first as any).result.content[0].text).created?.ref;
  failures.failOnAddBatchCall = null;
  const retried = await parse(call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "dup-resume" }));
  assert.equal(retried.state, "applied");
  const duplicate = simulator.snapshot().tracks[0]!.clips.find((clip) => clip.ref === retried.created.ref)!;
  assert.equal(duplicate.notes.length, 8, "the transform ran exactly once against the original plan");
  if (createdRef !== undefined) assert.equal(retried.created.ref, createdRef);
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "dup-resume-undo" }));
  assert.equal(undone.state, "undone");
});

test("take-lane cursor rejects a page continuation after an audio-clip content edit", async () => {
  const simulator = new DeterministicLiveSimulator();
  const state = (simulator as any).state;
  state.tracks[0].takeLanes.push({ ref: "take-lane:track-1:1", objectIdentity: "simulator:take-lane:1", parentRef: "track:track-1", trackRef: "track:track-1", name: "Take 2", index: 1, clips: [
    { ref: "take-lane-clip:audio", objectIdentity: "simulator:take-lane-clip:audio", name: "Audio Take", kind: "audio", start: 0, length: 8, notes: [], warp: true, takes: [], automation: [], isTakeLaneClip: true, gain: 1, pitchCoarse: 0, pitchFine: 0, warping: true, fadeInLength: 0.01, fadeOutLength: 0.01, loopStart: 0, loopEnd: 8, warpMarkers: [{ beatTime: 1, sampleTime: 44100 }], legato: false, velocityAmount: 1, signatureNumerator: 4, signatureDenominator: 4, ramMode: false, clipView: { gridQuantization: 4, gridIsTriplet: false } },
  ] });
  const host = new McpHost(simulator);
  ready(host);
  const call = (id: number, name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  for (const mutate of [
    () => { state.tracks[0].takeLanes[1].clips[0].gain = 0.5; },
    () => { state.tracks[0].takeLanes[1].clips[0].legato = true; },
    () => { state.tracks[0].takeLanes[1].clips[0].velocityAmount = 0.5; },
    () => { state.tracks[0].takeLanes[1].clips[0].signatureDenominator = 8; },
    () => { state.tracks[0].takeLanes[1].clips[0].ramMode = true; },
    () => { state.tracks[0].takeLanes[1].clips[0].clipView.gridIsTriplet = true; },
  ]) {
    const firstPage = JSON.parse(((await call(Math.floor(Math.random() * 1e6) + 100, "live_take_lane_read", { trackRef: "track:track-1", limit: 1 })) as any).result.content[0].text);
    assert.equal(firstPage.paging.complete, false);
    mutate();
    const continued = await call(Math.floor(Math.random() * 1e6) + 100, "live_take_lane_read", { trackRef: "track:track-1", limit: 1, cursor: firstPage.paging.nextCursor });
    assert.equal((continued as any).result.isError, true);
    assert.match(JSON.parse((continued as any).result.content[0].text).reason, /stale/);
  }
});

test("take-lane fingerprints digest large bounded marker collections without failing the read", async () => {
  const simulator = new DeterministicLiveSimulator();
  const state = (simulator as any).state;
  state.tracks[0].takeLanes[0].clips.push({
    ref: "take-lane-clip:markers", objectIdentity: "simulator:take-lane-clip:markers", name: "Dense", kind: "audio", start: 0, length: 8,
    notes: [], warp: true, takes: [], automation: [], isTakeLaneClip: true,
    warpMarkers: Array.from({ length: 512 }, (_, index) => ({ beatTime: index + 1, sampleTime: (index + 1) * 44100 })),
  });
  const host = new McpHost(simulator);
  ready(host);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "live_take_lane_read", arguments: { trackRef: "track:track-1" } } });
  const value = JSON.parse((result as any).result.content[0].text);
  assert.equal((result as any).result.isError, false);
  assert.equal(value.lanes[0].clips[0].fingerprint.length, 64);
});

test("live_status reconnects a dropped same-epoch bridge and restores the visible tool list", async () => {
  const simulator = new DeterministicLiveSimulator();
  let dropped = false;
  const adapter = {
    status: () => dropped
      ? { connected: false, adapter: "remote-script", epoch: null, protocol: "ableton-live/v1", capabilities: [], operations: [], reason: "remote-adapter-disconnected" }
      : { ...simulator.status() },
    refreshStatusAsync: async () => {
      if (dropped) dropped = false;
      return simulator.status();
    },
    snapshot: () => simulator.snapshot(), get: (ref: never) => simulator.get(ref), invoke: (invocation: never) => simulator.invoke(invocation),
    subscribe: () => () => undefined, reconnect: () => simulator.reconnect(),
    snapshotAsync: async () => simulator.snapshot(), discoverAsync: simulator.discoverAsync.bind(simulator),
    getAsync: async (ref: never) => simulator.get(ref), invokeAsync: async (invocation: never) => simulator.invoke(invocation),
    reconnectAsync: async () => simulator.reconnect(),
  } as unknown as LiveAdapter;
  const host = new McpHost(adapter);
  const emitted: string[] = [];
  host.setEventEmitter(async (value: string) => { emitted.push(value); });
  ready(host);
  const listed = (host.handle({ jsonrpc: "2.0", id: 10, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(listed.includes("live_tempo_preview"), true);
  dropped = true;
  const hidden = (host.handle({ jsonrpc: "2.0", id: 11, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(hidden.includes("live_tempo_preview"), false, "the cached disconnect hides adapter-backed tools");
  const status = await host.handleAsync({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "live_status", arguments: {} } });
  assert.equal(JSON.parse((status as any).result.content[0].text).connected, true, "the always-visible status path initiated the reconnect");
  const restored = (host.handle({ jsonrpc: "2.0", id: 13, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(restored.includes("live_tempo_preview"), true, "the visible tool list recovers after the reconnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(emitted.filter((line) => line.includes("notifications/tools/list_changed")).length >= 1);
});
