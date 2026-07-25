import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticatedLoopback, LOOPBACK_PROTOCOL_VERSION } from "../src/loopback.js";
import { DeterministicLiveSimulator, LIVE_CAPABILITIES, LIVE_PROTOCOL_VERSION, LIVE_UNAVAILABLE_CAPABILITIES } from "../src/live.js";

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
  live.set(track.ref, "volume", 2);
  assert.equal((live.get(track.ref) as typeof track).volume, 1);
  live.addNote(track.clips[0]!.ref, { pitch: 40, start: 1, duration: 0.25, velocity: 90, channel: 1 });
  const epoch = live.reconnect().epoch;
  assert.equal(epoch, 2);
  assert.equal(events.length, 3);
  unsubscribe();
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
