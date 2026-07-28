import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLiveRegistry, validateLiveOperationRequest, validateLiveOperationResult } from "../src/registry.js";

const outputSafety = { safe: true, provenance: "test-operator" };

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
  const note = { pitch: 36, start: 0, duration: 0.25, velocity: 100, channel: 1 };
  validateLiveOperationRequest("note.add-batch", { ref: "1:clip:0:0", notes: [note, { ...note, pitch: 38, start: 1 }] });
  validateLiveOperationResult("note.add-batch", { added: 2, noteIds: [1, null] });
  assert.throws(() => validateLiveOperationRequest("note.add-batch", { ref: "1:clip:0:0", notes: [] }), /below registry item bound/);
  assert.throws(() => validateLiveOperationRequest("browser.load", { itemId: "instruments/Synth", expectedName: "Synth" }), /required/);
  validateLiveOperationRequest("device.delete", { ref: "1:device:0:0", expectedObjectIdentity: "live:device-1", expectedOwnerRef: "1:track:0", expectedOwnerIdentity: "live:track-1", expectedSiblings: [{ ref: "1:device:0:0", objectIdentity: "live:device-1" }] });
  assert.throws(() => validateLiveOperationRequest("device.delete", { ref: "1:device:0:0" }), /required/);
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
  const targetAuthorities = [{ ref: "1:parameter:device:0", parameterIdentity: "live:parameter:0", ownerRef: "1:device:0", ownerIdentity: "live:device:0", trackRef: "1:track:0", trackIdentity: "live:track:0", siblings: [{ ref: "1:parameter:device:0", objectIdentity: "live:parameter:0" }] }];
  validateLiveOperationRequest("realtime.arm", { ttlMs: 5000, channels: ["udp-json", "osc", "xy", "max"], parameterRefs: ["1:parameter:device:0"], targetAuthorities, sourcePorts: [41000], outputSafety });
  assert.throws(() => validateLiveOperationRequest("realtime.arm", { channels: [], parameterRefs: [], targetAuthorities: [], outputSafety }), /below registry item bound/);
  assert.throws(() => validateLiveOperationRequest("realtime.arm", { channels: ["xy", "xy"], parameterRefs: [], targetAuthorities: [], outputSafety }), /duplicate registry items/);
  validateLiveOperationResult("realtime.arm", { host: "127.0.0.1", port: 9766, token: "t".repeat(32), expiresAt: Date.now() + 5000, channels: ["xy"], parameterRefs: ["1:parameter:device:0"], packetLimitBytes: 512, ratePerSecond: 64, burst: 16 });
  validateLiveOperationResult("realtime.stats", { armed: true, accepted: 2, applied: 2, applyFailures: 0, pending: 0, droppedUnarmed: 0, droppedEndpoint: 0, droppedTarget: 0, droppedInvalid: 0, droppedReplay: 0, droppedRateLimited: 0, droppedQueueFull: 0, droppedBeforeDispatch: 0, revokedBeforeApply: 0, sequenceGaps: 0, lastSequence: 2, jitterMs: 0.2, maxJitterMs: 0.4 });
});

test("capture registry requires exact bounded authority and cleanup identity", () => {
  const base = { captureId: "capture_1234567890", setName: "Disposable", sourceSlotRef: "1:clip_slot:0:0", destinationSlotRef: "1:clip_slot:1:0", fence: "a".repeat(64), maxDurationMs: 5000, outputSafety };
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
  for (const extension of ["project.new", "project.open", "project.save", "project.save-as", "project.collect", "project.export", "project.bounce", "arrangement.automation.read", "arrangement.automation.create", "audio.warp-marker.read", "audio.warp-marker.add", "audio.take-lane.read", "audio.comp.read", "browser.preview.start", "browser.preview.stop"]) assert.ok(ids.includes(extension));
  for (const forbidden of ["set", "clip.launch", "track.stop", "playback.stop-all-clips", "scene.launch", "stop-all-clips", "transport.stop"]) assert.equal(ids.includes(forbidden), false);
  const launch = { ref: "1:scene:0", setName: "Disposable Set", sceneName: "Scene 1", sceneIndex: 0, playbackRevision: "1:playback:abc", eligibleTargets: ["1:track:0|1:clip_slot:0:0|1:scene:0"], outputSafety };
  validateLiveOperationRequest("session.audition-launch", launch);
  validateLiveOperationResult("session.audition-launch", { launched: "1:scene:0", targets: [{ trackRef: "1:track:0", clipSlotRef: "1:clip_slot:0:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0" }] });
  assert.throws(() => validateLiveOperationRequest("session.audition-launch", { ...launch, eligibleTargets: [42] }), /type/);
  const clipAuthority = { slotRef: "1:clip_slot:0:0", trackRef: "1:track:0", sceneRef: "1:scene:0", sceneIndex: 0, clipRef: "1:clip:0:0", playbackRevision: "1:playback:abc", outputSafety };
  validateLiveOperationRequest("session.clip-launch", clipAuthority);
  validateLiveOperationRequest("session.clip-stop", { slotRef: clipAuthority.slotRef, trackRef: clipAuthority.trackRef, sceneRef: clipAuthority.sceneRef, sceneIndex: 0, clipRef: clipAuthority.clipRef });
  assert.throws(() => validateLiveOperationRequest("session.clip-launch", { ...clipAuthority, trackRef: undefined }), /type|required/);
  validateLiveOperationRequest("session.audition-stop", { ref: "1:scene:0", setName: "Disposable Set", eligibleTargets: [] });
  validateLiveOperationResult("session.audition-stop", { stopped: true });
  assert.throws(() => validateLiveOperationResult("session.audition-stop", { stopped: false }), /constant/);
  validateLiveOperationRequest("session.emergency-stop", { expectedTargets: [], expectedRecording: "stopped" });
  validateLiveOperationResult("session.emergency-stop", { stopped: true, stoppedTargets: ["1:track:0|1:clip_slot:0:0|1:scene:0"], recordingStopped: true });
  assert.throws(() => validateLiveOperationRequest("session.emergency-stop", {}), /required/);
  const recordingAuthority = { action: "start", expectedSessionRecord: false, expectedArrangementRecord: false, destinationTrackRef: "1:track:0", outputSafety: { safe: true, provenance: "operator-observed" } };
  validateLiveOperationRequest("recording.session", recordingAuthority);
  assert.throws(() => validateLiveOperationRequest("recording.session", { action: "start" }), /required/);
});
