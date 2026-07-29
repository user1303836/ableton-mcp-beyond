import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicLiveSimulator, type AsyncLiveAdapter } from "../src/live.js";
import { discoverSession, discoverSessionAsync, SessionMidiTransactionManager } from "../src/transactions/session-midi.js";

const request = { trackRef: "track:track-1" as const, sceneIndex: 1, name: "Bounded Beat", length: 4, notes: [
  { pitch: 36, start: 0, duration: 0.25, velocity: 100, channel: 1 },
  { pitch: 38, start: 1, duration: 0.25, velocity: 90, channel: 1 },
] };

function midiSimulator(): DeterministicLiveSimulator {
  const simulator = new DeterministicLiveSimulator(); const state = (simulator as any).state;
  for (let index = 1; index <= 3; index += 1) { state.scenes.push({ ref: `scene:scene-${index + 1}`, objectIdentity: `simulator:scene:scene-${index + 1}`, name: `Scene ${index + 1}`, index }); state.tracks[0].clipSlots.push({ ref: `clip-slot:track-1:${index}`, parentRef: state.tracks[0].ref, objectIdentity: `simulator:clip-slot:track-1:${index}`, sceneIndex: index, clipRef: null, empty: true }); }
  return simulator;
}

function asynchronous(simulator: DeterministicLiveSimulator, operations: string[] = []): AsyncLiveAdapter {
  return {
    status: () => simulator.status(), snapshot: () => simulator.snapshot(), get: (ref) => simulator.get(ref), invoke: (value) => simulator.invoke(value), subscribe: (listener) => simulator.subscribe(listener), reconnect: () => simulator.reconnect(),
    snapshotAsync: async () => simulator.snapshot(), discoverAsync: async () => { throw new Error("not used by this test adapter"); }, getAsync: async (ref) => simulator.get(ref), invokeAsync: async (value) => { operations.push(value.operation); return simulator.invoke(value); }, reconnectAsync: async () => simulator.reconnect(), close: async () => undefined,
  };
}

test("creates, verifies, idempotently replays, discovers, and exactly undoes a Session MIDI clip", () => {
  const simulator = midiSimulator();
  const manager = new SessionMidiTransactionManager(simulator);
  assert.throws(() => manager.preview({ ...request, notes: [{ ...request.notes[0], pitch: 128 }] }), /invalid MIDI note/);
  const preview = manager.preview(request);
  assert.equal(preview.prior.occupied, false); assert.equal(preview.confirmation, "apply");
  assert.throws(() => manager.apply(preview.transactionId, "wrong", "apply-1"), /confirmation=apply/);
  const applied = manager.apply(preview.transactionId, "apply", "apply-1") as any;
  assert.equal(applied.state, "applied"); assert.equal(applied.notes.length, 2);
  assert.equal((manager.apply(preview.transactionId, "apply", "apply-1") as any).idempotent, true);
  assert.throws(() => manager.apply("midi_other", "apply", "apply-1"), /idempotency key conflicts/);
  for (const kind of ["track", "scene", "clip", "note"] as const) assert.equal(discoverSession(simulator, kind, 100).epoch, 1);
  const paged = discoverSession(simulator, "note", 1); assert.equal(paged.truncated, true); assert.ok(paged.nextCursor);
  assert.equal(discoverSession(simulator, "note", 10, paged.nextCursor).items.length, 2);
  assert.throws(() => discoverSession(simulator, "track", 0), /limit/);
  const undone = manager.undo(preview.transactionId, "undo", "undo-1") as any;
  assert.equal(undone.state, "undone"); assert.equal((manager.undo(preview.transactionId, "undo", "undo-1") as any).idempotent, true);
});

test("asynchronous MIDI undo reconciles a lost deletion acknowledgement with the exact key", async () => {
  const simulator = midiSimulator(); const adapter = asynchronous(simulator); const original = adapter.invokeAsync.bind(adapter); let cached: unknown; let deletes = 0;
  adapter.invokeAsync = async (invocation, context) => { if (invocation.operation !== "clip.delete") return original(invocation, context); if (deletes === 0) { deletes += 1; cached = await original(invocation, context); throw new Error("remote adapter request state uncertain after dispatch timeout"); } return cached; };
  const manager = new SessionMidiTransactionManager(adapter); const preview = await manager.previewAsync(request); await manager.applyAsync(preview.transactionId, "apply", "midi-recovery-apply", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-recovery-apply", transactionId: preview.transactionId });
  await assert.rejects(manager.undoAsync(preview.transactionId, "undo", "midi-recovery-undo", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-recovery-undo", transactionId: preview.transactionId }), /uncertain/);
  await assert.rejects(manager.undoAsync(preview.transactionId, "undo", "midi-wrong-key", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-wrong-key", transactionId: preview.transactionId }), /exact-key|applied/);
  const reconciled = await manager.undoAsync(preview.transactionId, "undo", "midi-recovery-undo", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-recovery-undo", transactionId: preview.transactionId }) as any; assert.equal(reconciled.state, "undone"); assert.equal(deletes, 1);
});

test("MIDI apply compensation with a lost acknowledgement reconciles without a residual clip", async () => {
  const simulator = midiSimulator(); const adapter = asynchronous(simulator); const original = adapter.invokeAsync.bind(adapter); let cachedDelete: unknown; let deletes = 0;
  adapter.invokeAsync = async (invocation, context) => { if (invocation.operation === "note.add-batch") { const result = await original(invocation, context) as any; return { ...result, added: 0 }; } if (invocation.operation === "clip.delete") { if (deletes === 0) { deletes += 1; cachedDelete = await original(invocation, context); throw new Error("remote adapter request state uncertain after dispatch timeout"); } return cachedDelete; } return original(invocation, context); };
  const manager = new SessionMidiTransactionManager(adapter); const preview = await manager.previewAsync(request); await assert.rejects(manager.applyAsync(preview.transactionId, "apply", "midi-compensate-key", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-compensate-key", transactionId: preview.transactionId }), /compensation failed/);
  const reconciled = await manager.applyAsync(preview.transactionId, "apply", "midi-compensate-key", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-compensate-key", transactionId: preview.transactionId }) as any; assert.equal(reconciled.state, "compensated"); assert.equal(deletes, 1); assert.equal(simulator.snapshot().tracks[0]?.clipSlots?.[1]?.empty, true);
});

test("MIDI compensation refuses a transaction clip modified after lost note acknowledgement", async () => {
  const simulator = midiSimulator(); const adapter = asynchronous(simulator); const original = adapter.invokeAsync.bind(adapter); let cached: unknown; let cachedCreate: unknown; let noteCalls = 0; let deletes = 0;
  adapter.invokeAsync = async (invocation, context) => { if (invocation.operation === "clip.delete") deletes += 1; if (invocation.operation === "clip.create") { if (cachedCreate !== undefined) return cachedCreate; cachedCreate = await original(invocation, context); return cachedCreate; } if (invocation.operation !== "note.add-batch") return original(invocation, context); noteCalls += 1; if (cached !== undefined) return cached; cached = await original(invocation, context); throw new Error("remote adapter request state uncertain after dispatch timeout"); };
  const manager = new SessionMidiTransactionManager(adapter); const preview = await manager.previewAsync(request); await assert.rejects(manager.applyAsync(preview.transactionId, "apply", "midi-note-lost-ack", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-note-lost-ack", transactionId: preview.transactionId }), /uncertain/);
  const owned = (simulator as any).state.tracks[0].clips.find((clip: any) => clip.start === request.sceneIndex * 4); owned.notes[0].probability = 0.25; owned.notesRevision = "f".repeat(64);
  await assert.rejects(manager.applyAsync(preview.transactionId, "apply", "midi-note-lost-ack", { deadlineMs: Date.now() + 5000, idempotencyKey: "midi-note-lost-ack", transactionId: preview.transactionId }), /compensation failed/);
  assert.equal(noteCalls, 2); assert.equal(deletes, 0); assert.equal((simulator as any).state.tracks[0].clips.includes(owned), true); assert.equal(owned.notes[0].probability, 0.25);
});

test("asynchronous MIDI creation supports an intentionally empty note list", async () => {
  const simulator = midiSimulator(); const manager = new SessionMidiTransactionManager(asynchronous(simulator)); const preview = await manager.previewAsync({ ...request, name: "Empty MIDI", notes: [] }); const applied = await manager.applyAsync(preview.transactionId, "apply", "empty-midi-apply") as any;
  assert.equal(applied.state, "applied"); assert.deepEqual(applied.notes, []); assert.equal((simulator.get(applied.clipRef) as any).notes.length, 0); assert.equal((await manager.undoAsync(preview.transactionId, "undo", "empty-midi-undo") as any).state, "undone");
});

test("bounded MIDI retention never evicts an applied transaction needed for recovery", () => {
  const simulator = midiSimulator(); const manager = new SessionMidiTransactionManager(simulator);
  const protectedPreview = manager.preview(request);
  manager.apply(protectedPreview.transactionId, "apply", "protected-apply");
  const spare = { ...request, sceneIndex: 2, name: "Spare" };
  for (let index = 0; index < 80; index += 1) manager.preview(spare);
  const undone = manager.undo(protectedPreview.transactionId, "undo", "protected-undo") as { state: string };
  assert.equal(undone.state, "undone");
});

test("expired applied MIDI records retain recovery authority until safely undone", () => {
  const simulator = midiSimulator(); const manager = new SessionMidiTransactionManager(simulator);
  const preview = manager.preview(request); manager.apply(preview.transactionId, "apply", "terminal-apply");
  ((manager as any).records.get(preview.transactionId) as { expiresAt: number }).expiresAt = 0;
  manager.preview({ ...request, sceneIndex: 2, name: "Replacement" });
  assert.equal((manager as any).records.has(preview.transactionId), true);
  manager.undo(preview.transactionId, "undo", "terminal-undo");
  manager.preview({ ...request, sceneIndex: 3, name: "After Undo" });
  assert.equal((manager as any).records.has(preview.transactionId), false);
});

test("expressive batch verification compensates when an adapter drops requested fields", async () => {
  const simulator = midiSimulator();
  const base = asynchronous(simulator);
  const adapter: AsyncLiveAdapter = {
    ...base,
    invokeAsync: async (invocation) => invocation.operation === "note.add-batch"
      ? simulator.invoke({ ...invocation, args: { ...invocation.args, notes: (invocation.args.notes as Array<Record<string, unknown>>).map(({ probability: _probability, velocityDeviation: _deviation, releaseVelocity: _release, mute: _mute, ...note }) => note) } })
      : simulator.invoke(invocation),
  };
  const manager = new SessionMidiTransactionManager(adapter);
  const preview = await manager.previewAsync({ ...request, notes: [{ ...request.notes[0], probability: 0.5, velocityDeviation: 8, releaseVelocity: 32, mute: true }] });
  await assert.rejects(manager.applyAsync(preview.transactionId, "apply", "lossy-batch"), /confirm exact MIDI clip contents/);
  assert.equal(simulator.snapshot().tracks[0]!.clips.some((clip) => clip.start === request.sceneIndex * 4), false);
});

test("supports the asynchronous guarded Session MIDI lifecycle and async pagination", async () => {
  const operations: string[] = [];
  const adapter = asynchronous(midiSimulator(), operations);
  const manager = new SessionMidiTransactionManager(adapter);
  const preview = await manager.previewAsync(request);
  const applied = await manager.applyAsync(preview.transactionId, "apply", "async-apply") as any;
  assert.equal(applied.state, "applied"); assert.equal((await manager.applyAsync(preview.transactionId, "apply", "async-apply") as any).idempotent, true);
  assert.equal(operations.filter((operation) => operation === "note.add-batch").length, 1);
  assert.equal(operations.filter((operation) => operation === "note.add").length, 0);
  const notes = await discoverSessionAsync(adapter, "note", 1); assert.equal(notes.truncated, true);
  assert.equal((await discoverSessionAsync(adapter, "note", 10, notes.nextCursor)).items.length, 2);
  const undone = await manager.undoAsync(preview.transactionId, "undo", "async-undo") as any;
  assert.equal(undone.state, "undone"); assert.equal((await manager.undoAsync(preview.transactionId, "undo", "async-undo") as any).idempotent, true);
});
