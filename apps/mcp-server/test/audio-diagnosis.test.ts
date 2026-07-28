import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm } from "../src/analysis.js";
import { diagnoseAudioWithLiveContext } from "../src/audio-diagnosis.js";
import { DeterministicLiveSimulator } from "../src/live.js";

function source(kind: "caller-supplied-pcm" | "verified-live-resampling-capture") {
  return { kind, observedAt: "2026-01-01T00:00:00.000Z", description: "bounded test source", ...(kind === "verified-live-resampling-capture" ? { captureId: "capture-test-00000001" } : {}) } as const;
}

test("links measurements to exact Live refs without asserting device causality", () => {
  const simulator = new DeterministicLiveSimulator();
  const snapshot = simulator.snapshot();
  const track = snapshot.tracks[0]!;
  const samples = Float32Array.from({ length: 48_000 }, (_, frame) => frame % 2 === 0 ? 1 : -1);
  const analysis = analyzePcm({ samples, sampleRate: 48_000 });
  const diagnosis = diagnoseAudioWithLiveContext(analysis, snapshot, simulator.status().epoch!, track.ref, source("caller-supplied-pcm"), "2026-01-01T00:00:01.000Z");
  assert.equal(diagnosis.source.relationshipToLive, "declared-by-caller-not-verified");
  assert.equal(diagnosis.context.track.ref, track.ref);
  assert.match(diagnosis.context.contextRevision, /^[a-f0-9]{64}$/);
  assert.equal(diagnosis.causality.claimed, false);
  const clipping = diagnosis.findings.find((finding) => finding.findingId === "sample-full-scale-boundary");
  assert.ok(clipping);
  assert.ok(clipping!.projectRefs.includes(track.ref));
  if (track.mixer?.volume !== null && track.mixer?.volume !== undefined) {
    assert.equal(clipping!.suggestedPreview?.tool, "live_mixer_preview");
    assert.equal(clipping!.suggestedPreview?.arguments.trackRef, track.ref);
  }
  assert.ok(diagnosis.findings.every((finding) => !/caused by/i.test(finding.hypothesis)));
  assert.equal(diagnosis.privacy.rawAudioReturned, false);
});

test("marks mapper-owned capture provenance as verified and reports unavailable latency", () => {
  const simulator = new DeterministicLiveSimulator();
  const snapshot = simulator.snapshot();
  const samples = Float32Array.from({ length: 48_000 }, (_, frame) => 0.1 * Math.sin(2 * Math.PI * 440 * frame / 48_000));
  const diagnosis = diagnoseAudioWithLiveContext(analyzePcm({ samples, sampleRate: 48_000 }), snapshot, simulator.status().epoch!, snapshot.tracks[0]!.ref, source("verified-live-resampling-capture"));
  assert.equal(diagnosis.source.relationshipToLive, "verified-by-capture-lifecycle");
  assert.equal(diagnosis.context.captureTap, "session-resampling");
  assert.equal(diagnosis.context.latencyAvailable, false);
  assert.ok(diagnosis.findings.length > 0);
});

test("refuses a stale or fabricated track ref", () => {
  const simulator = new DeterministicLiveSimulator();
  const samples = new Float32Array(48_000);
  assert.throws(() => diagnoseAudioWithLiveContext(analyzePcm({ samples, sampleRate: 48_000 }), simulator.snapshot(), simulator.status().epoch!, "track:missing", source("caller-supplied-pcm")), /not present/);
});
