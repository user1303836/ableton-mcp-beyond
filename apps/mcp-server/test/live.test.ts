import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticatedLoopback, LoopbackLiveAdapter, LOOPBACK_PROTOCOL_VERSION, type LoopbackResponse } from "../src/loopback.js";
import { DeterministicLiveSimulator, LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_UNAVAILABLE_CAPABILITIES, SIMULATOR_CAPABILITIES, type LiveRef } from "../src/live.js";

const secret = "0123456789abcdef0123456789abcdef";

test("simulator covers stable references, bounded edits, subscriptions, and reconnect epochs", () => {
  const live = new DeterministicLiveSimulator();
  const snapshot = live.snapshot();
  const track = snapshot.tracks[0];
  assert.ok(track);
  assert.equal(live.status().protocol, LIVE_PROTOCOL_VERSION);
  assert.ok(LIVE_CAPABILITIES.includes("transport"));
  assert.ok(LIVE_UNAVAILABLE_CAPABILITIES.includes("plugins"));
  const events: unknown[] = [];
  const unsubscribe = live.subscribe((event) => events.push(event));
  assert.throws(() => live.invoke({ operation: "mixer.set", args: { ref: track.ref, volume: 2 } }), /volume is invalid/);
  live.invoke({ operation: "mixer.set", args: { ref: track.ref, volume: 1 } });
  assert.equal((live.get(track.ref) as typeof track).volume, 1);
  assert.deepEqual(events[0], { epoch: 1, sequence: 1, type: "object", ref: track.ref, payload: { operation: "mixer.set" } });
  live.addNote(track.clips[0]!.ref, { pitch: 40, start: 1, duration: 0.25, velocity: 90, channel: 1 });
  const epoch = live.reconnect().epoch;
  assert.equal(epoch, 2);
  assert.equal(events.length, 3);
  unsubscribe();
});

test("simulator clip launch and stop require exact hierarchy identities", () => {
  const argsFor = (snapshot: ReturnType<DeterministicLiveSimulator["snapshot"]>) => {
    const track = snapshot.tracks[0]!; const slot = track.clipSlots![0]!; const clip = track.clips.find((item) => item.ref === slot.clipRef)!; const scene = snapshot.scenes[0]!;
    return { slotRef: slot.ref, trackRef: track.ref, sceneRef: scene.ref, sceneIndex: scene.index, clipRef: clip.ref, trackIdentity: track.objectIdentity!, sceneIdentity: scene.objectIdentity!, slotIdentity: slot.objectIdentity!, clipIdentity: clip.objectIdentity!, playbackRevision: snapshot.playback.revision, outputSafety: { safe: true, provenance: "unit-test" } };
  };
  const stopArgsFor = (authority: ReturnType<typeof argsFor>) => ({ slotRef: authority.slotRef, trackRef: authority.trackRef, sceneRef: authority.sceneRef, sceneIndex: authority.sceneIndex, clipRef: authority.clipRef, trackIdentity: authority.trackIdentity, sceneIdentity: authority.sceneIdentity, slotIdentity: authority.slotIdentity, clipIdentity: authority.clipIdentity });
  const live = new DeterministicLiveSimulator(); const authority = argsFor(live.snapshot());
  assert.equal((live.invoke({ operation: "session.clip-launch", args: authority }) as { launched: string }).launched, authority.slotRef);
  assert.equal((live.invoke({ operation: "session.clip-stop", args: stopArgsFor(authority) }) as { stopped: boolean }).stopped, true);

  const replacedBeforeLaunch = new DeterministicLiveSimulator(); const staleLaunch = argsFor(replacedBeforeLaunch.snapshot());
  (replacedBeforeLaunch as any).state.tracks[0].clips[0].objectIdentity = "simulator:clip:replacement";
  assert.throws(() => replacedBeforeLaunch.invoke({ operation: "session.clip-launch", args: staleLaunch }), /object identity changed/);

  const replacedBeforeStop = new DeterministicLiveSimulator(); const staleStop = argsFor(replacedBeforeStop.snapshot());
  replacedBeforeStop.invoke({ operation: "session.clip-launch", args: staleStop });
  (replacedBeforeStop as any).state.tracks[0].clips[0].objectIdentity = "simulator:clip:replacement";
  assert.throws(() => replacedBeforeStop.invoke({ operation: "session.clip-stop", args: stopArgsFor(staleStop) }), /object identity changed/);
  assert.equal(replacedBeforeStop.snapshot().playback.playingTargets.length, 1);
});

test("simulator exposes domain objects and bounded editing operations", () => {
  const live = new DeterministicLiveSimulator();
  const snapshot = live.snapshot();
  const clip = snapshot.tracks[0]!.clips[0]!;
  const device = snapshot.tracks[0]!.devices[0]!;
  const parameter = device.parameters[0]!;

  assert.ok(LIVE_UNAVAILABLE_CAPABILITIES.includes("arrangement.read"));
  assert.ok(LIVE_CAPABILITIES.includes("parameters"));
  assert.equal(snapshot.arrangement.locators[0]!.name, "Intro");
  assert.equal((live.get(snapshot.scenes[0]!.ref) as typeof snapshot.scenes[0]).name, "Scene 1");
  assert.equal((live.get(parameter.ref) as typeof parameter).value, 0.5);
  assert.throws(() => live.invoke({ operation: "device.parameter.set", args: { ref: parameter.ref, value: 9, expectedRevision: 1 } }), /outside numeric bounds/);
  live.invoke({ operation: "device.parameter.set", args: { ref: parameter.ref, value: 1, expectedRevision: 1 } });
  assert.equal((live.get(parameter.ref) as typeof parameter).value, 1);
  live.setAutomation(clip.ref, { time: 1, value: 0.75, curve: 0 });
  live.addTake(clip.ref, "take-2");
  const updated = live.get(clip.ref) as typeof clip;
  assert.equal(updated.automation.length, 1);
  assert.deepEqual(updated.takes, ["take-1", "take-2"]);
  assert.throws(() => live.setAutomation(clip.ref, { time: 99, value: 0.5 }), /outside the clip/);
  assert.throws(() => live.setAutomation(clip.ref, { time: Number.NaN, value: 0.5 }), /outside the clip/);
  assert.throws(() => live.addNote(clip.ref, { pitch: 40, start: Number.NaN, duration: 0.25, velocity: 90, channel: 1 }), /invalid MIDI note/);
  assert.throws(() => live.addNote(clip.ref, { pitch: 40, start: 1, duration: 0.25, velocity: 90, channel: 17 }), /invalid MIDI note/);
  const batched = live.invoke({ operation: "note.add-batch", args: { ref: clip.ref, notes: [
    { pitch: 41, start: 1, duration: 0.25, velocity: 90, channel: 1 },
    { pitch: 42, start: 2, duration: 0.25, velocity: 80, channel: 1 },
  ] } }) as { added: number; noteIds: number[] };
  assert.equal(batched.added, 2); assert.equal(batched.noteIds.length, 2);
  const afterBatch = (live.get(clip.ref) as typeof clip).notes.length;
  assert.throws(() => live.invoke({ operation: "note.add-batch", args: { ref: clip.ref, notes: [
    { pitch: 43, start: 3, duration: 0.25, velocity: 70, channel: 1 },
    { pitch: 44, start: Number.NaN, duration: 0.25, velocity: 70, channel: 1 },
  ] } }), /invalid MIDI note/);
  assert.equal((live.get(clip.ref) as typeof clip).notes.length, afterBatch);
  assert.throws(() => live.addTake(clip.ref, 42 as unknown as string), /invalid or duplicate take/);
  assert.throws(() => live.setWarp(clip.ref, "yes" as unknown as boolean), /warp must be boolean/);
});

test("simulator executes session, media, routing, browser, and realtime operations", () => {
  const live = new DeterministicLiveSimulator();
  const initial = live.snapshot();
  const track = initial.tracks[0]!;
  const created = live.invoke({ operation: "clip.create", args: { trackRef: track.ref, kind: "audio", name: "Vocal", start: 4, length: 8 } }) as { ref: `${string}:${string}` };
  // These remain explicit simulator-domain helpers, not advertised canonical
  // operations or production capability evidence.
  live.setWarp(created.ref as LiveRef, true);
  live.addTake(created.ref as LiveRef, "comp-1");
  live.invoke({ operation: "routing.set", args: { ref: track.ref, input: "Ext. In 1", output: "Master" } });
  const locator = live.invoke({ operation: "locator.add", args: { name: "Verse", position: 4 } }) as { name: string };
  assert.equal(locator.name, "Verse");
  assert.equal((live.invoke({ operation: "browser.search", args: { query: "util" } }) as { items: unknown[] }).items.length, 1);
  live.invoke({ operation: "transport.set", args: { position: 4, expectedRevision: live.snapshot().playback.revision } });
  assert.equal(live.snapshot().playback.transport.position, 4);
  assert.throws(() => live.invoke({ operation: "transport.set", args: { position: 8, expectedRevision: "stale" } }), /changed since preview/);
  assert.throws(() => live.invoke({ operation: "max.message", args: { address: "", values: [] } } as any), /unknown operation/);
});

test("loopback authenticates, rejects replay/tampering, and forwards subscriptions", () => {
  const live = new DeterministicLiveSimulator();
  const events: unknown[] = [];
  const transport = new AuthenticatedLoopback(live, secret, (response) => events.push(response));
  const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "one", method: "status", nonce: "0000000000000001" });
  assert.equal(transport.handle(request).ok, true);
  assert.equal(transport.handle(request).ok, false);
  const tampered = { ...transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "two", method: "status", nonce: "0000000000000002" }), id: "changed" };
  assert.equal(transport.handle(tampered).ok, false);
  const subscription = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "sub", method: "subscribe", nonce: "0000000000000003" });
  assert.equal(transport.handle(subscription).ok, true);
  live.reconnect();
  assert.equal(events.length, 1);
  transport.close();
});

test("loopback accepts valid nonces out of order and rejects unknown fields", () => {
  const live = new DeterministicLiveSimulator();
  const transport = new AuthenticatedLoopback(live, secret);
  const first = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "first", method: "status", nonce: "zzzzzzzzzzzzzzzz1" });
  const second = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "second", method: "status", nonce: "aaaaaaaaaaaaaaaa2" });
  assert.equal(transport.handle(first).ok, true);
  assert.equal(transport.handle(second).ok, true);
  const extra = { ...transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "third", method: "status", nonce: "bbbbbbbbbbbbbbbb3" }), unexpected: true };
  assert.equal(transport.handle(extra).ok, false);
});

test("loopback authenticates bounded domain invocations", () => {
  const live = new DeterministicLiveSimulator();
  const transport = new AuthenticatedLoopback(live, secret);
  const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "invoke", method: "invoke", operation: "browser.search", args: { query: "kick" }, nonce: "invoke-nonce-0001" });
  const result = transport.handle(request);
  assert.equal(result.ok, true);
  assert.equal((result.result as { items: unknown[] }).items.length, 1);
});

test("loopback rejects oversized nonces before retaining them", () => {
  const transport = new AuthenticatedLoopback(new DeterministicLiveSimulator(), secret);
  const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "large", method: "status", nonce: "x".repeat(257) });
  assert.equal(transport.handle(request).ok, false);
});

test("loopback signing rejects oversized, deeply nested, and non-finite wire values", () => {
  const transport = new AuthenticatedLoopback(new DeterministicLiveSimulator(), secret);
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "large", method: "invoke", operation: "browser.search", args: { query: "x".repeat(16_385) }, nonce: "large-wire-value-0001" }), /wire string is too large/);
  let nested: unknown = "value";
  for (let index = 0; index < 17; index += 1) nested = { value: nested };
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "deep", method: "invoke", operation: "browser.search", args: nested as Record<string, unknown>, nonce: "deep-wire-value-0001" }), /too deeply nested/);
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "nan", method: "invoke", operation: "browser.search", args: { value: Number.NaN }, nonce: "nan-wire-value-0001" }), /not finite/);
  const notes = Array.from({ length: 512 }, (_, index) => ({ pitch: index % 128, start: index, duration: 0.25, velocity: 100, channel: 1 }));
  assert.doesNotThrow(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "bounded-note-batch", method: "invoke", operation: "note.add-batch", args: { ref: "1:clip:0:0", notes }, nonce: "bounded-note-batch-0001" }));
  assert.throws(() => transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "oversized-note-batch", method: "invoke", operation: "note.add-batch", args: { ref: "1:clip:0:0", notes: [...notes, notes[0]] }, nonce: "oversized-note-batch-0001" }), /wire array is too large/);
});

test("loopback retains replay protection beyond the old eviction threshold", () => {
  const transport = new AuthenticatedLoopback(new DeterministicLiveSimulator(), secret);
  const first = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: "first", method: "status", nonce: "persistent-nonce-0001" });
  assert.equal(transport.handle(first).ok, true);
  for (let index = 0; index < 4_096; index += 1) {
    const request = transport.authenticate({ version: LOOPBACK_PROTOCOL_VERSION, id: `request-${index}`, method: "status", nonce: `nonce-${index.toString().padStart(16, "0")}` });
    assert.equal(transport.handle(request).ok, true);
  }
  assert.equal(transport.handle(first).ok, false);
});

test("loopback adapter negotiates the domain contract and receives authenticated events", () => {
  const live = new DeterministicLiveSimulator();
  const events: LoopbackResponse[] = [];
  const server = new AuthenticatedLoopback(live, secret, (event) => events.push(event));
  const adapter = new LoopbackLiveAdapter(secret, (request) => server.handle(request));
  const initial = adapter.snapshot();
  assert.equal(initial.set.tempo, 120);
  assert.equal(adapter.status().adapter, "simulator");
  const seen: unknown[] = [];
  const unsubscribe = adapter.subscribe((event) => seen.push(event));
  assert.equal(typeof (adapter as unknown as { set?: unknown }).set, "undefined");
  adapter.invoke({ operation: "tempo.set", args: { ref: initial.set.ref, value: 123, expectedTempo: 120 } });
  assert.equal((adapter.get(initial.set.ref) as typeof initial.set).tempo, 123);
  assert.equal(events.length, 1);
  adapter.receive(events[0]!);
  assert.equal((seen[0] as { payload: { value: number } }).payload.value, 123);
  unsubscribe();
  assert.throws(() => adapter.receive({ ...events[0]!, mac: "tampered" }), /authentication/);
});

test("loopback adapter binds responses to request ids and rejects stale events", () => {
  const live = new DeterministicLiveSimulator();
  const server = new AuthenticatedLoopback(live, secret);
  const adapter = new LoopbackLiveAdapter(secret, (request) => server.handle(request));
  const first = adapter.snapshot();
  assert.equal(first.set.tempo, 120);
  assert.throws(() => adapter.receive({ version: LOOPBACK_PROTOCOL_VERSION, id: "client-999", ok: true, bridgeEpoch: "in-process", connectionChallenge: "in-process", result: { event: { sequence: 1, type: "state", payload: {} } }, mac: "bad" }), /authentication/);
  assert.equal(SIMULATOR_CAPABILITIES.includes("transport"), true);
});
