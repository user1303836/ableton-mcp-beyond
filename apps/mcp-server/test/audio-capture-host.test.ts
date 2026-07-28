import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator, LIVE_PROTOCOL_VERSION, type LiveAdapter, type LiveInvocation, type LiveOperationContext, type LiveSnapshot } from "../src/live.js";

function wav(samples: Float32Array, sampleRate = 48_000): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), 44 + index * 2));
  return buffer;
}

async function fixture(root: string) {
  const simulator = new DeterministicLiveSimulator();
  const projectPath = join(root, "Disposable.als"); const mediaPath = join(root, "Capture.wav");
  await writeFile(projectPath, "set");
  const state = simulator.snapshot() as LiveSnapshot;
  state.set.name = "Disposable"; state.set.filePath = projectPath;
  const source = state.tracks[0]!;
  source.clipSlots = [{ ref: "clip-slot:source:0", parentRef: source.ref, sceneIndex: 0, clipRef: source.clips[0]!.ref, empty: false }];
  const destination = structuredClone(source);
  destination.ref = "track:capture"; destination.name = "Capture"; destination.kind = "regular"; destination.clips = []; destination.clipSlots = [{ ref: "clip-slot:capture:0", parentRef: destination.ref, sceneIndex: 0, clipRef: null, empty: true }]; destination.armed = false; destination.monitoringState = "auto"; destination.routing = { inputType: "Ext. In", inputSubRouting: "1/2", outputType: "Master", outputSubRouting: null, availableInputTypes: 2, availableInputChannels: 2, availableOutputTypes: 1, availableOutputChannels: 1 };
  state.tracks.push(destination);
  state.playback.transport.playing = false; state.playback.transport.arrangementRecord = false; state.playback.transport.sessionRecord = false; state.playback.firedTargets = []; state.playback.playingTargets = [];
  let capture: Record<string, any> | null = null;
  const operations = ["audio.capture.inspect", "audio.capture.start", "audio.capture.stop", "audio.capture.status", "audio.capture.emergency-stop", "audio.capture.cleanup"];
  const stop = async () => {
    if (!capture) throw new Error("no capture");
    state.playback.transport.playing = false; state.playback.transport.arrangementRecord = false; state.playback.transport.sessionRecord = false;
    destination.armed = false; destination.monitoringState = "auto"; destination.routing!.inputType = "Ext. In";
    const samples = Float32Array.from({ length: 4_800 }, (_, frame) => 0.1 * Math.sin(2 * Math.PI * 440 * frame / 48_000));
    await writeFile(mediaPath, wav(samples));
    capture.state = "captured"; capture.active = false; capture.playbackStopped = true; capture.clip = { ref: "clip:captured", name: "Capture", length: 0.1, isAudio: true, filePath: mediaPath };
    destination.clipSlots![0] = { ...destination.clipSlots![0]!, clipRef: "clip:captured", empty: false };
    return { stopped: true, ...capture };
  };
  const adapter = {
    status: () => ({ connected: true, adapter: "remote-script", epoch: 1, protocol: LIVE_PROTOCOL_VERSION, capabilities: ["session.read", "audio.capture.resampling"], operations, provenance: "real-live" }),
    snapshot: () => structuredClone(state),
    get: (ref: any) => simulator.get(ref), set: (ref: any, property: string, value: unknown) => simulator.set(ref, property, value), invoke: () => { throw new Error("async only"); }, subscribe: () => () => undefined, reconnect: () => adapter.status(),
    snapshotAsync: async () => structuredClone(state), discoverAsync: async () => ({ epoch: 1, items: [], truncated: false, revision: "capture", kind: "track" as const }), getAsync: async (ref: any) => simulator.get(ref), setAsync: async (ref: any, property: string, value: unknown) => simulator.set(ref, property, value), reconnectAsync: async () => adapter.status(), close: async () => undefined,
    invokeAsync: async (invocation: LiveInvocation, _context?: LiveOperationContext) => {
      const args = invocation.args;
      if (invocation.operation === "audio.capture.inspect") return { supported: true, fence: "a".repeat(64), sourceSlotRef: args.sourceSlotRef, destinationSlotRef: args.destinationSlotRef, destinationTrackRef: destination.ref, captureMode: "session-slot-resampling", prior: { route: "Ext. In", arm: false, monitoring: "auto", position: 0 } };
      if (invocation.operation === "audio.capture.start") { capture = { active: true, state: "active", captureId: args.captureId, sourceSlotRef: args.sourceSlotRef, destinationSlotRef: args.destinationSlotRef, destinationTrackRef: destination.ref, startedAt: Date.now(), expiresAt: Date.now() + Number(args.maxDurationMs), recoveryToken: "mapper-token-0000000000000000", residual: [] }; state.playback.transport.playing = true; destination.armed = true; destination.monitoringState = "off"; destination.routing!.inputType = "Resampling"; return { captureId: args.captureId, token: capture.recoveryToken, expiresAt: capture.expiresAt, state: "active" }; }
      if (invocation.operation === "audio.capture.stop" || invocation.operation === "audio.capture.emergency-stop") return await stop();
      if (invocation.operation === "audio.capture.status") return capture ?? { active: false, state: "idle" };
      if (invocation.operation === "audio.capture.cleanup") { if (!capture || args.expectedClipRef !== capture.clip?.ref) throw new Error("wrong clip"); capture.state = "cleaned"; capture.active = false; capture.recoveryToken = null; delete capture.clip; destination.clipSlots![0] = { ...destination.clipSlots![0]!, clipRef: null, empty: true }; return { cleaned: true, filePath: mediaPath }; }
      throw new Error(`unexpected ${invocation.operation}`);
    },
  } as unknown as LiveAdapter & { snapshotAsync(context?: LiveOperationContext): Promise<LiveSnapshot>; discoverAsync(): Promise<any>; getAsync(ref: any): Promise<any>; setAsync(ref: any, property: string, value: unknown): Promise<void>; invokeAsync(invocation: LiveInvocation, context?: LiveOperationContext): Promise<any>; reconnectAsync(): Promise<any>; close(): Promise<void> };
  return { adapter, state, mediaPath, sourceSlotRef: source.clipSlots[0]!.ref, destinationSlotRef: destination.clipSlots[0]!.ref, capture: () => capture };
}

function ready(host: McpHost): void {
  host.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "capture-test", version: "1" } } });
  host.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
}

const safety = { safe: true, provenance: "hardware-output-observed", observedAt: "2026-01-01T00:00:00Z", scope: "Disposable" };

test("runs one confirmed capture through analysis, diagnosis, and zero-residual cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef } = await fixture(root);
  const host = new McpHost(adapter); ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_audio_capture_preview", arguments: { setName: "Disposable", sourceSlotRef, destinationSlotRef, durationSeconds: 1, consent: "ephemeral-analysis-and-delete", outputSafety: safety } } });
  const plan = JSON.parse((preview as any).result.content[0].text);
  assert.match(plan.confirmation, /^.{32,}$/); assert.equal(plan.rawRetention, "ephemeral-until-analysis-then-unlink");
  (host as any).audioCaptureTransactions.get(plan.transactionId).durationMs = 10;
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-apply-1" } } });
  assert.equal((applied as any).result.isError, false);
  const result = JSON.parse((applied as any).result.content[0].text);
  assert.equal(result.provenance, "real-live"); assert.equal(result.analysis.version, "pcm-analysis/v2"); assert.equal(result.diagnosis.source.relationshipToLive, "verified-by-capture-lifecycle");
  assert.deepEqual(result.cleanup, { captureStopped: true, transportStopped: true, routingRestored: true, armRestored: true, monitoringRestored: true, liveClipDeleted: true, rawFileUnlinked: true, rawAudioRetained: false });
  assert.equal(result.media.rawPathReturned, false); assert.doesNotMatch(JSON.stringify(result), new RegExp(mediaPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await assert.rejects(access(mediaPath));
  const replay = await host.handleAsync({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-apply-1" } } });
  assert.equal(JSON.parse((replay as any).result.content[0].text).idempotent, true);
});

test("removes an ASD created during Live clip cleanup before reporting success", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-late-asd-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef } = await fixture(root);
  const originalInvoke = (adapter as any).invokeAsync.bind(adapter);
  (adapter as any).invokeAsync = async (invocation: LiveInvocation, liveContext?: LiveOperationContext) => {
    const result = await originalInvoke(invocation, liveContext);
    if (invocation.operation === "audio.capture.cleanup") await writeFile(`${mediaPath}.asd`, Buffer.alloc(128, 3));
    return result;
  };
  const host = new McpHost(adapter); ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "live_audio_capture_preview", arguments: { setName: "Disposable", sourceSlotRef, destinationSlotRef, durationSeconds: 1, consent: "ephemeral-analysis-and-delete", outputSafety: safety } } });
  const plan = JSON.parse((preview as any).result.content[0].text); (host as any).audioCaptureTransactions.get(plan.transactionId).durationMs = 10;
  const applied = await host.handleAsync({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-late-asd-1" } } });
  assert.equal((applied as any).result.isError, false);
  await assert.rejects(access(mediaPath)); await assert.rejects(access(`${mediaPath}.asd`));
});

test("concurrent idempotent capture callers keep their own response IDs and one cancellation does not cancel the other", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-concurrent-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, sourceSlotRef, destinationSlotRef, capture } = await fixture(root);
  const originalInvoke = (adapter as any).invokeAsync.bind(adapter); let starts = 0;
  (adapter as any).invokeAsync = async (invocation: LiveInvocation, liveContext?: LiveOperationContext) => { if (invocation.operation === "audio.capture.start") starts += 1; return originalInvoke(invocation, liveContext); };
  const host = new McpHost(adapter); ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "live_audio_capture_preview", arguments: { setName: "Disposable", sourceSlotRef, destinationSlotRef, durationSeconds: 1, consent: "ephemeral-analysis-and-delete", outputSafety: safety } } });
  const plan = JSON.parse((preview as any).result.content[0].text); (host as any).audioCaptureTransactions.get(plan.transactionId).durationMs = 50;
  const firstController = new AbortController();
  const args = { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-shared-1" };
  const first = host.handleAsync({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: args } }, firstController.signal);
  const second = host.handleAsync({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: args } });
  setTimeout(() => firstController.abort(), 10);
  assert.equal(await first, null);
  const secondResult = await second;
  assert.equal((secondResult as any).id, 22);
  assert.equal((secondResult as any).result.isError, false);
  assert.equal(starts, 1);
  assert.equal(capture()?.state, "cleaned");
});

test("cancellation during fresh status prevents audible capture dispatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-predispatch-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, sourceSlotRef, destinationSlotRef, capture } = await fixture(root);
  const originalStatus = adapter.status.bind(adapter); let starts = 0;
  (adapter as any).refreshStatusAsync = async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return originalStatus(); };
  const originalInvoke = (adapter as any).invokeAsync.bind(adapter);
  (adapter as any).invokeAsync = async (invocation: LiveInvocation, liveContext?: LiveOperationContext) => { if (invocation.operation === "audio.capture.start") starts += 1; return originalInvoke(invocation, liveContext); };
  const host = new McpHost(adapter); ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "live_audio_capture_preview", arguments: { setName: "Disposable", sourceSlotRef, destinationSlotRef, durationSeconds: 1, consent: "ephemeral-analysis-and-delete", outputSafety: safety } } });
  const plan = JSON.parse((preview as any).result.content[0].text);
  const controller = new AbortController();
  const pending = host.handleAsync({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-predispatch-1" } } }, controller.signal);
  setTimeout(() => controller.abort(), 5);
  assert.equal(await pending, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(starts, 0); assert.equal(capture(), null);
});

test("recovery refuses foreign mapper state and never unlinks its media", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-foreign-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef, capture } = await fixture(root);
  const started = await (adapter as any).invokeAsync({ operation: "audio.capture.start", args: { captureId: "capture-foreign-0000001", sourceSlotRef, destinationSlotRef, maxDurationMs: 1000 } });
  await (adapter as any).invokeAsync({ operation: "audio.capture.stop", args: { captureId: started.captureId, token: started.token } });
  const host = new McpHost(adapter); ready(host);
  const stale = { id: "stale", captureId: "capture-stale-00000001", epoch: 1, setName: "Disposable", sourceSlotRef, destinationSlotRef, destinationTrackRef: "track:capture", fence: "", prior: {}, durationMs: 0, outputSafety: {}, confirmation: "", expiresAt: Date.now() + 1000, state: "uncertain", startDispatched: true };
  const recovery = await (host as any).recoverAudioCapture(stale);
  assert.equal(recovery.safe, false); assert.deepEqual(recovery.residual, ["foreign-capture-lifecycle-observed"]);
  await access(mediaPath); assert.equal(capture()?.state, "captured");
});

test("recovery propagates mapper residuals instead of reporting a false safe cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-residual-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef, capture } = await fixture(root);
  const started = await (adapter as any).invokeAsync({ operation: "audio.capture.start", args: { captureId: "capture-residual-000001", sourceSlotRef, destinationSlotRef, maxDurationMs: 1000 } });
  await (adapter as any).invokeAsync({ operation: "audio.capture.stop", args: { captureId: started.captureId, token: started.token } });
  capture()!.residual = ["destination-route-changed-externally"];
  const host = new McpHost(adapter); ready(host);
  const transaction = { id: "residual", captureId: started.captureId, epoch: 1, setName: "Disposable", sourceSlotRef, destinationSlotRef, destinationTrackRef: "track:capture", fence: "", prior: { route: "Ext. In", arm: false, monitoring: "auto" }, durationMs: 0, outputSafety: {}, confirmation: "", expiresAt: Date.now() + 1000, state: "uncertain", startDispatched: true, mapperToken: started.token, startedAt: Date.now() - 1000 };
  const recovery = await (host as any).recoverAudioCapture(transaction);
  assert.equal(recovery.safe, false); assert.ok(recovery.residual.some((item: string) => item.includes("destination-route-changed-externally")));
  await assert.rejects(access(mediaPath)); assert.equal(capture()?.state, "cleaned");
});

test("recovery completes Live clip cleanup after raw unlink and host death", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-post-unlink-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef, capture } = await fixture(root);
  const started = await (adapter as any).invokeAsync({ operation: "audio.capture.start", args: { captureId: "capture-post-unlink-001", sourceSlotRef, destinationSlotRef, maxDurationMs: 1000 } });
  const stopped = await (adapter as any).invokeAsync({ operation: "audio.capture.stop", args: { captureId: started.captureId, token: started.token } });
  const decoded = await (await import("../src/audio-file.js")).decodeOwnedWaveFile(mediaPath, join(root, "Disposable.als"), Date.now() - 1000);
  await (await import("../src/audio-file.js")).unlinkOwnedCaptureFile(decoded);
  const host = new McpHost(adapter); ready(host);
  const transaction = { id: "post-unlink", captureId: started.captureId, epoch: 1, setName: "Disposable", sourceSlotRef, destinationSlotRef, destinationTrackRef: "track:capture", fence: "", prior: { route: "Ext. In", arm: false, monitoring: "auto" }, durationMs: 0, outputSafety: {}, confirmation: "", expiresAt: Date.now() + 1000, state: "uncertain", startDispatched: true, mapperToken: started.token, startedAt: Date.now() - 1000 };
  const recovery = await (host as any).recoverAudioCapture(transaction);
  assert.equal(recovery.safe, true); assert.equal(capture()?.state, "cleaned"); assert.equal(stopped.clip.ref, "clip:captured");
});

test("capture failure responses never disclose an absolute media path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-redaction-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef } = await fixture(root);
  const originalInvoke = (adapter as any).invokeAsync.bind(adapter);
  (adapter as any).invokeAsync = async (invocation: LiveInvocation, liveContext?: LiveOperationContext) => {
    const result = await originalInvoke(invocation, liveContext);
    if (invocation.operation === "audio.capture.stop") await writeFile(mediaPath, "not-a-wave");
    return result;
  };
  const host = new McpHost(adapter); ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "live_audio_capture_preview", arguments: { setName: "Disposable", sourceSlotRef, destinationSlotRef, durationSeconds: 1, consent: "ephemeral-analysis-and-delete", outputSafety: safety } } });
  const plan = JSON.parse((preview as any).result.content[0].text); (host as any).audioCaptureTransactions.get(plan.transactionId).durationMs = 10;
  const failed = await host.handleAsync({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-redaction-1" } } });
  const serialized = JSON.stringify(failed);
  assert.equal((failed as any).result.isError, true); assert.equal(serialized.includes(root), false); assert.doesNotMatch(serialized, /Capture\.wav/);
});

test("cancellation invokes independent stop, clip cleanup, and raw unlink", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-host-capture-cancel-")); context.after(() => rm(root, { recursive: true, force: true }));
  const { adapter, mediaPath, sourceSlotRef, destinationSlotRef, capture } = await fixture(root);
  const host = new McpHost(adapter); ready(host);
  const preview = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_audio_capture_preview", arguments: { setName: "Disposable", sourceSlotRef, destinationSlotRef, durationSeconds: 1, consent: "ephemeral-analysis-and-delete", outputSafety: safety } } });
  const plan = JSON.parse((preview as any).result.content[0].text); (host as any).audioCaptureTransactions.get(plan.transactionId).durationMs = 100;
  const controller = new AbortController();
  const pending = host.handleAsync({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "live_audio_capture_apply", arguments: { transactionId: plan.transactionId, confirmation: plan.confirmation, idempotencyKey: "capture-cancel-1" } } }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  assert.equal(await pending, null);
  const deadline = Date.now() + 5_000;
  while (capture()?.state !== "cleaned" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(capture()?.state, "cleaned");
  await assert.rejects(access(mediaPath));
});
