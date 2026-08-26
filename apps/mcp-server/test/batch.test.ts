import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function connectedHost(policy?: unknown) {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator, policy === undefined ? undefined : { toolPolicy: policy });
  host.handle(initialize); host.handle(initialized);
  let requestId = 1100;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  const parseError = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) return { protocolError: frame.error };
    return { toolError: frame.result.isError === true ? JSON.parse(frame.result.content[0].text) : undefined, result: frame.result.isError === true ? undefined : JSON.parse(frame.result.content[0].text) };
  };
  return { simulator, host, call, parse, parseError };
}

const firstParameter = (simulator: DeterministicLiveSimulator) => {
  const device = (simulator as any).state.tracks[0].devices[0];
  return { device, parameter: device.parameters[0] };
};

test("batch preview/apply executes an ordered multi-kind batch in one transaction with exact verification", async () => {
  const { simulator, call, parse } = connectedHost();
  const { device, parameter } = firstParameter(simulator);
  const preview = await parse(call("live_batch_preview", { operations: [
    { kind: "mixer.set", trackRef: "track:track-1", volume: 0.5, mute: true },
    { kind: "device.parameter.set", deviceRef: device.ref, parameterRef: parameter.ref, value: parameter.min },
    { kind: "track.rename", trackRef: "track:track-1", name: "Drum Bus" },
  ] }));
  assert.equal(preview.operations.length, 3);
  assert.equal(preview.impact, "applies-atomic-batch");
  assert.equal(preview.operations[0].prior.volume, 0.85);
  assert.equal(preview.operations[1].prior.value, parameter.value);
  assert.equal(preview.operations[2].prior.name, "Drums");
  assert.equal(preview.operations[1].proposed.value, parameter.min);
  const applied = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-key-1" }));
  assert.equal(applied.state, "applied");
  assert.equal(applied.operations.length, 3);
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.mixer.volume, 0.5);
  assert.equal(track.mixer.mute, true);
  assert.equal(track.name, "Drum Bus");
  assert.equal(parameter.value, parameter.min);
  // exact-key replay reconciles without re-executing
  const replay = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-key-1" }));
  assert.equal(replay.idempotent, true);
  // one undo record covers the whole batch, restoring prior state in reverse order
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "batch-undo-1" }));
  assert.equal(undone.state, "undone");
  assert.equal(undone.restored, 3);
  assert.equal(track.mixer.volume, 0.85);
  assert.equal(track.mixer.mute, false);
  assert.equal(track.name, "Drums");
  assert.equal(parameter.value, preview.operations[1].prior.value);
  const undoReplay = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "batch-undo-1" }));
  assert.equal(undoReplay.idempotent, true);
});

test("batch track.create + mixer.set builds named tracks with initial mixer state; undo deletes only owned creations", async () => {
  const { simulator, call, parse } = connectedHost();
  const tracksBefore = (simulator as any).state.tracks.length;
  const preview = await parse(call("live_batch_preview", { operations: [
    { kind: "track.create", name: "Drum Bus", trackKind: "midi" },
    { kind: "track.create", name: "Bass", trackKind: "audio" },
    { kind: "mixer.set", trackRef: "track:track-1", solo: true },
  ] }));
  assert.deepEqual(preview.summary.kinds.sort(), ["mixer.set", "track.create"]);
  const applied = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-key-create" }));
  assert.equal(applied.state, "applied");
  const state = (simulator as any).state;
  assert.equal(state.tracks.length, tracksBefore + 2);
  assert.equal(state.tracks[tracksBefore].name, "Drum Bus");
  assert.equal(state.tracks[tracksBefore + 1].name, "Bass");
  assert.equal(state.tracks[0].mixer.solo, true);
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "batch-undo-create" }));
  assert.equal(undone.state, "undone");
  assert.equal(state.tracks.length, tracksBefore, "created tracks are deleted");
  assert.equal(state.tracks[0].mixer.solo, false, "solo restored");
  assert.equal(state.tracks.some((track: any) => track.name === "Drum Bus" || track.name === "Bass"), false);
});

test("a clean mid-batch refusal rolls completed steps back to their exact prior state", async () => {
  const { simulator, call, parse } = connectedHost();
  const { device, parameter } = firstParameter(simulator);
  const preview = await parse(call("live_batch_preview", { operations: [
    { kind: "mixer.set", trackRef: "track:track-1", volume: 0.25 },
    { kind: "device.parameter.set", deviceRef: device.ref, parameterRef: parameter.ref, value: parameter.min },
  ] }));
  // an external edit between preview and apply fences the second step
  (simulator as any).simulateExternalEdit(parameter.ref, "value", parameter.max);
  const response = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-key-rollback" }));
  assert.equal(response.state, "compensated");
  assert.equal(response.failedIndex, 1);
  assert.equal(response.rolledBack, 1);
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.mixer.volume, 0.85, "the completed mixer step was rolled back to its exact prior value");
  assert.equal(parameter.value, parameter.max, "the fenced step never dispatched");
});

test("a lost acknowledgement reconciles against recorded per-step checkpoints", async () => {
  const { simulator, call, parse, parseError } = connectedHost();
  let dispatches = 0;
  const original = simulator.invokeAsync.bind(simulator);
  simulator.invokeAsync = async (invocation: any) => {
    if (invocation.operation !== "mixer.set") return original(invocation);
    dispatches += 1;
    const result = await original(invocation);
    if (dispatches === 1) throw new Error("remote adapter request state uncertain after dispatch timeout");
    return result;
  };
  const preview = await parse(call("live_batch_preview", { operations: [
    { kind: "mixer.set", trackRef: "track:track-1", volume: 0.4 },
    { kind: "track.rename", trackRef: "track:track-1", name: "Reconciled" },
  ] }));
  const uncertain = await parseError(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-lost-ack" }));
  assert.equal(uncertain.toolError !== undefined, true, "lost acknowledgement surfaces as an uncertain tool error");
  const track = (simulator as any).state.tracks[0];
  assert.equal(track.mixer.volume, 0.4, "the dispatched mixer write landed");
  assert.equal(track.name, "Drums", "the rename never dispatched");
  const reconciled = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-lost-ack" }));
  assert.equal(reconciled.state, "applied");
  assert.equal(dispatches, 1, "the completed mixer step was not re-dispatched");
  assert.equal(track.name, "Reconciled", "the remaining step completed during reconciliation");
  assert.equal(reconciled.operations[0].replayed, true, "the checkpointed step reports replay provenance");
  assert.equal(reconciled.operations[1].name, "Reconciled");
});

test("batch policy denial at preview refuses the whole batch before any write", async () => {
  const { simulator, call, parseError } = connectedHost({ profile: "read-only" });
  const before = (simulator as any).state.tracks[0].mixer.volume;
  const denied = await parseError(call("live_batch_preview", { operations: [{ kind: "mixer.set", trackRef: "track:track-1", volume: 0.1 }] }));
  assert.equal(denied.toolError !== undefined, true);
  assert.equal((simulator as any).state.tracks[0].mixer.volume, before);
  // a single denied operation fails a mixed batch at preview time as well
  const second = connectedHost({ profile: "performance" });
  const mixed = await second.parseError(second.call("live_batch_preview", { operations: [
    { kind: "mixer.set", trackRef: "track:track-1", volume: 0.3 },
    { kind: "device.parameter.set", deviceRef: "device:any", parameterRef: "parameter:any", value: 1 },
  ] }));
  assert.equal(mixed.toolError !== undefined, true, "device.parameter.set is outside the performance profile, so the batch preview must fail");
});

test("batch validation: cap, allowlist, duplicate targets, and unknown operation kinds", async () => {
  const { call, parseError } = connectedHost();
  const oversized = await parseError(call("live_batch_preview", { operations: Array.from({ length: 33 }, (_, index) => ({ kind: "track.create", name: `T${index}`, trackKind: "midi" })) }));
  assert.equal(oversized.toolError !== undefined, true);
  const unknownKind = await parseError(call("live_batch_preview", { operations: [{ kind: "note.add-batch", clipRef: "clip:x" }] }));
  assert.equal(unknownKind.toolError !== undefined, true);
  const duplicates = await parseError(call("live_batch_preview", { operations: [
    { kind: "mixer.set", trackRef: "track:track-1", volume: 0.2 },
    { kind: "mixer.set", trackRef: "track:track-1", mute: true },
  ] }));
  assert.equal(duplicates.toolError !== undefined, true);
  const missingFields = await parseError(call("live_batch_preview", { operations: [{ kind: "device.parameter.set", deviceRef: "device:x" }] }));
  assert.equal(missingFields.toolError !== undefined, true);
  const empty = await parseError(call("live_batch_preview", { operations: [] }));
  assert.equal(empty.toolError !== undefined, true);
});

test("bulk mixer presets are expressible as one batch (unmute-all, solo-exclusive)", async () => {
  const { simulator, call, parse } = connectedHost();
  const state = (simulator as any).state;
  const second = structuredClone(state.tracks[0]);
  second.ref = "track:track-2"; second.objectIdentity = "simulator:track:track-2"; second.name = "Bass";
  state.tracks.push(second);
  state.tracks[0].mixer.mute = true;
  state.tracks[1].mixer.mute = true;
  const preview = await parse(call("live_batch_preview", { operations: state.tracks.map((track: any) => ({ kind: "mixer.set", trackRef: track.ref, mute: false, solo: track.ref === "track:track-1" })) }));
  const applied = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-preset" }));
  assert.equal(applied.state, "applied");
  assert.equal(state.tracks.every((track: any) => track.mixer.mute === false), true, "unmute-all applied");
  assert.equal(state.tracks[0].mixer.solo, true);
  assert.equal(state.tracks.slice(1).every((track: any) => track.mixer.solo === false), true, "solo-exclusive applied");
});

test("batch undo refuses when a target changed after apply", async () => {
  const { simulator, call, parse, parseError } = connectedHost();
  const preview = await parse(call("live_batch_preview", { operations: [{ kind: "mixer.set", trackRef: "track:track-1", volume: 0.33 }] }));
  await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-key-fence" }));
  (simulator as any).state.tracks[0].mixer.volume = 0.99;
  const refused = await parseError(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "batch-undo-fence" }));
  assert.equal(refused.toolError !== undefined, true, "undo refuses after an external edit");
  assert.equal((simulator as any).state.tracks[0].mixer.volume, 0.99, "the external edit is never clobbered");
});

test("routing.arm expresses unarm-all as one batch with exact undo", async () => {
  const { simulator, call, parse } = connectedHost();
  const state = (simulator as any).state;
  const second = structuredClone(state.tracks[0]);
  second.ref = "track:track-2"; second.objectIdentity = "simulator:track:track-2"; second.name = "Bass";
  state.tracks.push(second);
  state.tracks[0].armed = true;
  state.tracks[1].armed = true;
  const preview = await parse(call("live_batch_preview", { operations: state.tracks.map((track: any) => ({ kind: "routing.arm", trackRef: track.ref, armed: false })) }));
  const applied = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-unarm" }));
  assert.equal(applied.state, "applied");
  assert.equal(state.tracks.every((track: any) => track.armed === false), true, "unarm-all applied");
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "batch-unarm-undo" }));
  assert.equal(undone.state, "undone");
  assert.equal(state.tracks.every((track: any) => track.armed === true), true, "exact prior arm state restored");
});

test("batch clip.set edits clip properties with exact prior-state undo", async () => {
  const { simulator, call, parse } = connectedHost();
  const clip = (simulator as any).state.tracks[0].clips[0];
  const preview = await parse(call("live_batch_preview", { operations: [{ kind: "clip.set", clipRef: clip.ref, muted: true, colorIndex: 5 }] }));
  assert.equal(preview.operations[0].prior.muted, clip.muted ?? false);
  const applied = await parse(call("live_batch_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "batch-clip" }));
  assert.equal(applied.state, "applied");
  assert.equal(clip.muted, true);
  assert.equal(clip.colorIndex, 5);
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "batch-clip-undo" }));
  assert.equal(undone.state, "undone");
  assert.equal(clip.muted, false);
  assert.equal(clip.colorIndex, 0, "the exact prior colorIndex is restored");
});
