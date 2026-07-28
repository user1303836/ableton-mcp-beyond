import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicLiveSimulator, type AsyncLiveAdapter } from "../src/live.js";
import { discoverSession, discoverSessionAsync, SessionMidiTransactionManager } from "../src/transactions/session-midi.js";

const request = { trackRef: "track:track-1" as const, sceneIndex: 1, name: "Bounded Beat", length: 4, notes: [
  { pitch: 36, start: 0, duration: 0.25, velocity: 100, channel: 1 },
  { pitch: 38, start: 1, duration: 0.25, velocity: 90, channel: 1 },
] };

function asynchronous(simulator: DeterministicLiveSimulator): AsyncLiveAdapter {
  return {
    status: () => simulator.status(), snapshot: () => simulator.snapshot(), get: (ref) => simulator.get(ref), invoke: (value) => simulator.invoke(value), subscribe: (listener) => simulator.subscribe(listener), reconnect: () => simulator.reconnect(),
    snapshotAsync: async () => simulator.snapshot(), discoverAsync: async () => { throw new Error("not used by this test adapter"); }, getAsync: async (ref) => simulator.get(ref), invokeAsync: async (value) => simulator.invoke(value), reconnectAsync: async () => simulator.reconnect(), close: async () => undefined,
  };
}

test("creates, verifies, idempotently replays, discovers, and exactly undoes a Session MIDI clip", () => {
  const simulator = new DeterministicLiveSimulator();
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

test("bounded MIDI retention never evicts an applied transaction needed for recovery", () => {
  const simulator = new DeterministicLiveSimulator(); const manager = new SessionMidiTransactionManager(simulator);
  const protectedPreview = manager.preview(request);
  manager.apply(protectedPreview.transactionId, "apply", "protected-apply");
  const spare = { ...request, sceneIndex: 2, name: "Spare" };
  for (let index = 0; index < 80; index += 1) manager.preview(spare);
  const undone = manager.undo(protectedPreview.transactionId, "undo", "protected-undo") as { state: string };
  assert.equal(undone.state, "undone");
});

test("expired applied MIDI records retain recovery authority until safely undone", () => {
  const simulator = new DeterministicLiveSimulator(); const manager = new SessionMidiTransactionManager(simulator);
  const preview = manager.preview(request); manager.apply(preview.transactionId, "apply", "terminal-apply");
  ((manager as any).records.get(preview.transactionId) as { expiresAt: number }).expiresAt = 0;
  manager.preview({ ...request, sceneIndex: 2, name: "Replacement" });
  assert.equal((manager as any).records.has(preview.transactionId), true);
  manager.undo(preview.transactionId, "undo", "terminal-undo");
  manager.preview({ ...request, sceneIndex: 3, name: "After Undo" });
  assert.equal((manager as any).records.has(preview.transactionId), false);
});

test("supports the asynchronous guarded Session MIDI lifecycle and async pagination", async () => {
  const adapter = asynchronous(new DeterministicLiveSimulator());
  const manager = new SessionMidiTransactionManager(adapter);
  const preview = await manager.previewAsync(request);
  const applied = await manager.applyAsync(preview.transactionId, "apply", "async-apply") as any;
  assert.equal(applied.state, "applied"); assert.equal((await manager.applyAsync(preview.transactionId, "apply", "async-apply") as any).idempotent, true);
  const notes = await discoverSessionAsync(adapter, "note", 1); assert.equal(notes.truncated, true);
  assert.equal((await discoverSessionAsync(adapter, "note", 10, notes.nextCursor)).items.length, 2);
  const undone = await manager.undoAsync(preview.transactionId, "undo", "async-undo") as any;
  assert.equal(undone.state, "undone"); assert.equal((await manager.undoAsync(preview.transactionId, "undo", "async-undo") as any).idempotent, true);
});
