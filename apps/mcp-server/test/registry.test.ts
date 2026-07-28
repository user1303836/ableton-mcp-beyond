import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLiveRegistry, validateLiveOperationRequest, validateLiveOperationResult } from "../src/registry.js";

const playback = {
  ref: "1:session_playback:playback",
  epoch: 1,
  revision: "1:playback:abc",
  transport: {
    playing: false,
    arrangementRecord: null,
    sessionRecord: false,
    position: 0,
    launchQuantization: { raw: "1_bar", normalized: "1-bar" },
    loop: { enabled: false, start: 0, length: 4 },
    punchIn: false,
    punchOut: false,
    metronome: null,
    countIn: 1,
  },
  firedTargets: [],
  playingTargets: [{ trackRef: "1:track:0", clipSlotRef: "1:clip_slot:0:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0" }],
};

test("canonical registry includes strict snapshot and playback contracts", () => {
  const registry = loadLiveRegistry();
  assert.equal(registry.operations.find((item) => item.id === "snapshot")?.method, "snapshot");
  assert.equal(registry.operations.find((item) => item.id === "session.playback")?.method, "discover");
  validateLiveOperationRequest("session.playback", {});
  validateLiveOperationResult("session.playback", playback);
});

test("runtime registry validation rejects missing, unknown, and weak playback fields", () => {
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, revision: undefined }), /type/);
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, extra: true }), /not allowed/);
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, transport: { ...playback.transport, playing: "false" } }), /type/);
  assert.throws(() => validateLiveOperationResult("session.playback", { ...playback, playingTargets: [{ ...playback.playingTargets[0], clipSlotRef: "" }] }), /shorter/);
});

test("runtime registry validation rejects noncanonical discovery requests and results", () => {
  validateLiveOperationRequest("discover", { kind: "return_track", parent: "1:set:song", filters: { name: "Return" }, requestedFields: ["name"], traversalBudget: 10, limit: 4 });
  validateLiveOperationResult("discover", { epoch: 1, items: [], truncated: false, revision: "1:return_track:0", kind: "return_track" });
  assert.throws(() => validateLiveOperationRequest("discover", { kind: "track", unknown: true }), /not allowed/);
  assert.throws(() => validateLiveOperationResult("discover", { epoch: 1, items: [], truncated: false, revision: "", kind: "track" }), /shorter/);
});

test("realtime registry enforces explicit unique channels and measured bounded results", () => {
  validateLiveOperationRequest("realtime.arm", { ttlMs: 5000, channels: ["udp-json", "osc", "xy", "max"], parameterRefs: ["1:parameter:device:0"], sourcePorts: [41000] });
  assert.throws(() => validateLiveOperationRequest("realtime.arm", { channels: [], parameterRefs: [] }), /below registry item bound/);
  assert.throws(() => validateLiveOperationRequest("realtime.arm", { channels: ["xy", "xy"], parameterRefs: [] }), /duplicate registry items/);
  validateLiveOperationResult("realtime.arm", { host: "127.0.0.1", port: 9766, token: "t".repeat(32), expiresAt: Date.now() + 5000, channels: ["xy"], parameterRefs: ["1:parameter:device:0"], packetLimitBytes: 512, ratePerSecond: 64, burst: 16 });
  validateLiveOperationResult("realtime.stats", { armed: true, accepted: 2, applied: 2, applyFailures: 0, pending: 0, droppedUnarmed: 0, droppedEndpoint: 0, droppedTarget: 0, droppedInvalid: 0, droppedReplay: 0, droppedRateLimited: 0, droppedQueueFull: 0, droppedBeforeDispatch: 0, revokedBeforeApply: 0, sequenceGaps: 0, lastSequence: 2, jitterMs: 0.2, maxJitterMs: 0.4 });
});

test("capture registry requires exact bounded authority and cleanup identity", () => {
  const base = { captureId: "capture_1234567890", setName: "Disposable", sourceSlotRef: "1:clip_slot:0:0", destinationSlotRef: "1:clip_slot:1:0", fence: "a".repeat(64), maxDurationMs: 5000 };
  validateLiveOperationRequest("audio.capture.start", base);
  assert.throws(() => validateLiveOperationRequest("audio.capture.start", { ...base, maxDurationMs: 10001 }), /outside registry numeric bounds/);
  assert.throws(() => validateLiveOperationRequest("audio.capture.start", { ...base, extra: true }), /not allowed/);
  validateLiveOperationResult("audio.capture.start", { captureId: base.captureId, token: "t".repeat(32), expiresAt: Date.now() + 5000, state: "active", sourceSlotRef: base.sourceSlotRef });
  validateLiveOperationRequest("audio.capture.cleanup", { captureId: base.captureId, token: "t".repeat(32), expectedClipRef: "1:clip:1:0" });
  assert.throws(() => validateLiveOperationRequest("audio.capture.cleanup", { captureId: base.captureId, token: "t".repeat(32) }), /required/);
  validateLiveOperationResult("audio.capture.cleanup", { cleaned: true, filePath: "/project/Samples/Recorded/capture.wav", residual: [] });
  validateLiveOperationResult("audio.capture.status", { active: false, state: "captured", captureId: base.captureId, clip: { ref: "1:clip:1:0", filePath: "/project/capture.wav" } });
});

test("guarded audition and emergency operations replace generic audible invocation", () => {
  const registry = loadLiveRegistry();
  const ids = registry.operations.map((item) => item.id);
  assert.ok(!ids.includes("scene.launch") && !ids.includes("stop-all-clips") && !ids.includes("transport.stop"));
  const launch = { ref: "1:scene:0", setName: "Disposable Set", sceneName: "Scene 1", sceneIndex: 0, playbackRevision: "1:playback:abc", eligibleTargets: ["1:track:0|1:clip_slot:0:0|1:scene:0"] };
  validateLiveOperationRequest("session.audition-launch", launch);
  validateLiveOperationResult("session.audition-launch", { launched: "1:scene:0", targets: [{ trackRef: "1:track:0", clipSlotRef: "1:clip_slot:0:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0" }] });
  assert.throws(() => validateLiveOperationRequest("session.audition-launch", { ...launch, eligibleTargets: [42] }), /type/);
  validateLiveOperationRequest("session.audition-stop", { ref: "1:scene:0", setName: "Disposable Set", eligibleTargets: [] });
  validateLiveOperationResult("session.audition-stop", { stopped: true });
  assert.throws(() => validateLiveOperationResult("session.audition-stop", { stopped: false }), /constant/);
  validateLiveOperationRequest("session.emergency-stop", { expectedTargets: [] });
  validateLiveOperationResult("session.emergency-stop", { stopped: true, stoppedTargets: ["1:track:0|1:clip_slot:0:0|1:scene:0"] });
  assert.throws(() => validateLiveOperationRequest("session.emergency-stop", {}), /required/);
});
