import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

async function hostWithMidiClip() {
  const simulator = new DeterministicLiveSimulator();
  const state = (simulator as any).state;
  // A deterministic four-note pattern in clip:clip-1 (length 4 beats).
  const clip = state.tracks[0].clips[0];
  clip.notes.push(
    { pitch: 64, start: 1, duration: 0.5, velocity: 100, channel: 1, id: 2, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 },
    { pitch: 67, start: 2, duration: 0.5, velocity: 90, channel: 1, id: 3, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 },
    { pitch: 71, start: 3, duration: 1, velocity: 80, channel: 1, id: 4, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 },
  );
  clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
  // An empty second scene slot as the duplicate target.
  state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Target", index: 1 });
  state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const host = new McpHost(simulator);
  host.handle(initialize); host.handle(initialized);
  let requestId = 100;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  return { simulator, host, call, parse };
}

test("midi transform previews an exact deterministic diff with revision, constraints, assumptions, and MPE probe", async () => {
  const { call, parse } = await hostWithMidiClip();
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: -4 } }));
  assert.equal(preview.scope, "in-place");
  assert.equal(preview.diff.update, 4);
  assert.equal(preview.diff.add, 0);
  assert.equal(preview.diff.delete, 0);
  assert.equal(typeof preview.sourceRevision, "string");
  assert.equal(preview.constraints.generative, false);
  assert.equal(preview.mpe.exposesPerNoteExpression, false);
  assert.equal(preview.mpe.refusedInPlace, false);
  assert.match(preview.undo, /note\.update/);
  assert.equal(preview.confirmation, "apply");
});

test("in-place transpose applies through revision fencing, verifies, replays idempotently, and undoes exactly", async () => {
  const { simulator, call, parse } = await hostWithMidiClip();
  const before = simulator.snapshot().tracks[0]!.clips[0]!;
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 12 } }));
  const applied = await parse(call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "transform-apply-1" }));
  assert.equal(applied.state, "applied");
  const after = simulator.snapshot().tracks[0]!.clips[0]!;
  assert.deepEqual(after.notes.map((note) => note.pitch).sort((a, b) => a - b), before.notes.map((note) => note.pitch + 12).sort((a, b) => a - b));
  assert.deepEqual(after.notes.map((note) => note.id).sort(), before.notes.map((note) => note.id).sort());
  const replay = await parse(call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "transform-apply-1" }));
  assert.equal(replay.idempotent, true);
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "transform-undo-1" }));
  assert.equal(undone.state, "undone");
  const restored = simulator.snapshot().tracks[0]!.clips[0]!;
  assert.deepEqual(restored.notes.map((note) => [note.id, note.pitch, note.start, note.duration, note.velocity]), before.notes.map((note) => [note.id, note.pitch, note.start, note.duration, note.velocity]));
});

test("seeded humanize is byte-for-byte repeatable across hosts and honors the fence", async () => {
  const first = await hostWithMidiClip();
  const second = await hostWithMidiClip();
  const args = { clipRef: "clip:clip-1", transform: "humanize-velocity", params: { seed: "unit-seed", maxDelta: 24 } };
  const firstPreview = await first.parse(first.call("live_midi_transform_preview", args));
  const secondPreview = await second.parse(second.call("live_midi_transform_preview", args));
  assert.deepEqual(secondPreview.diff.notes.update, firstPreview.diff.notes.update);
  const applied = await first.parse(first.call("live_midi_transform_apply", { transactionId: firstPreview.transactionId, confirmation: "apply", idempotencyKey: "humanize-1" }));
  assert.equal(applied.state, "applied");
  const other = await second.parse(second.call("live_midi_transform_apply", { transactionId: secondPreview.transactionId, confirmation: "apply", idempotencyKey: "humanize-1" }));
  assert.equal(other.state, "applied");
  assert.deepEqual(
    second.simulator.snapshot().tracks[0]!.clips[0]!.notes.map((note) => [note.id, note.velocity]),
    first.simulator.snapshot().tracks[0]!.clips[0]!.notes.map((note) => [note.id, note.velocity]),
  );
});

test("generative transforms refuse in-place scope (MPE probe) and require an exact duplicate target", async () => {
  const { call, parse } = await hostWithMidiClip();
  const inPlace = await call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "ratchet", params: { seed: "r1", subdivisions: 4 }, scope: "in-place" });
  assert.equal((inPlace as any).result.isError, true);
  assert.match(JSON.parse((inPlace as any).result.content[0].text).reason, /expression/);
  const noTarget = await call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "ratchet", params: { seed: "r1", subdivisions: 4 } });
  assert.equal((noTarget as any).error.code, -32602);
});

test("duplicate-scope ratchet creates one transformed copy, preserves the source, and undo deletes only the copy", async () => {
  const { simulator, call, parse } = await hostWithMidiClip();
  const sourceBefore = structuredClone(simulator.snapshot().tracks[0]!.clips[0]!.notes);
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "ratchet", params: { seed: "dup-seed", subdivisions: 2, probability: 1 }, scope: "duplicate", target: { trackRef: "track:track-1", sceneIndex: 1 } }));
  assert.equal(preview.scope, "duplicate");
  assert.match(preview.undo, /duplicate clip/);
  const applied = await parse(call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "ratchet-dup-1" }));
  assert.equal(applied.state, "applied");
  assert.equal(typeof applied.created.ref, "string");
  const sourceAfter = simulator.snapshot().tracks[0]!.clips[0]!;
  assert.deepEqual(sourceAfter.notes.map((note) => [note.id, note.pitch, note.start]), sourceBefore.map((note) => [note.id, note.pitch, note.start]));
  const duplicateClip = simulator.snapshot().tracks[0]!.clips.find((clip) => clip.ref === applied.created.ref)!;
  assert.equal(duplicateClip.notes.length, sourceBefore.length * 2);
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "ratchet-dup-undo" }));
  assert.equal(undone.state, "undone");
  assert.equal(simulator.snapshot().tracks[0]!.clips.some((clip) => clip.ref === applied.created.ref), false);
});

test("apply refuses when the clip changes after preview (revision fence)", async () => {
  const { simulator, call, parse } = await hostWithMidiClip();
  const preview = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "staccato", params: { factor: 0.5 } }));
  const clip = (simulator as any).state.tracks[0].clips[0];
  clip.notes[0]!.velocity = 1;
  clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
  const refused = await call("live_midi_transform_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "staccato-fence" });
  assert.equal((refused as any).result.isError, true);
  assert.match(JSON.parse((refused as any).result.content[0].text).reason, /changed since preview/);
});

test("large in-place updates require an explicit scope and unknown transforms fail closed", async () => {
  const { simulator, call, parse } = await hostWithMidiClip();
  const state = (simulator as any).state;
  const clip = state.tracks[0].clips[0];
  for (let index = 0; index < 150; index += 1) clip.notes.push({ pitch: 40 + (index % 40), start: (index % 150) / 64, duration: 0.25, velocity: 90, channel: 1, id: 100 + index, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 });
  clip.notesRevision = createHash("sha256").update(JSON.stringify(clip.notes)).digest("hex");
  const large = await call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 1 } });
  assert.equal((large as any).error.code, -32602);
  assert.match((large as any).error.message, /duplicate scope/);
  const explicit = await parse(call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 1 }, scope: "in-place" }));
  assert.equal(explicit.constraints.largeEdit, true);
  const unknown = await call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "auto-tune", params: {} });
  assert.equal((unknown as any).error.code, -32602);
  const badParams = await call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 100 } });
  assert.equal((badParams as any).error.code, -32602);
  const noChange = await call("live_midi_transform_preview", { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 0 } });
  assert.equal((noChange as any).result.isError, true);
  assert.match(JSON.parse((noChange as any).result.content[0].text).reason, /no changes/);
});

test("transform tools are policy-gated like every edit tool", async () => {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator, { toolPolicy: { profile: "read-only" } });
  host.handle(initialize); host.handle(initialized);
  const result = await host.handleAsync({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "live_midi_transform_preview", arguments: { clipRef: "clip:clip-1", transform: "transpose", params: { semitones: 1 } } } });
  assert.equal((result as any).result.isError, true);
  assert.match(JSON.parse((result as any).result.content[0].text).reason, /deployment-policy/);
});
