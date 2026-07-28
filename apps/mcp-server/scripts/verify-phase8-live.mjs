#!/usr/bin/env node
/**
 * Operator-run packaged real-Live Phase 8 verifier.
 *
 * Required environment:
 *   PHASE8_CLI                       installed dist/src/cli.js
 *   PHASE8_TARBALL_SHA               SHA-256 of the installed npm pack artifact
 *   PHASE8_OUTPUT_SAFETY_PROVENANCE  fresh operator observation (never inferred)
 *
 * Optional: PHASE8_CONFIG, PHASE8_SET_NAME, PHASE8_LIVE_VERSION,
 * PHASE8_SOURCE_TRACK_INDEX, PHASE8_DESTINATION_TRACK_INDEX,
 * PHASE8_RECORDED_DIRECTORY.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readdirSync } from "node:fs";

const cli = process.env.PHASE8_CLI;
const tarballSha256 = process.env.PHASE8_TARBALL_SHA;
const outputSafetyProvenance = process.env.PHASE8_OUTPUT_SAFETY_PROVENANCE;
if (!cli) throw new Error("PHASE8_CLI is required");
if (!/^[a-f0-9]{64}$/.test(tarballSha256 ?? "")) throw new Error("PHASE8_TARBALL_SHA must be the installed artifact SHA-256");
if (!outputSafetyProvenance || outputSafetyProvenance.length > 512) throw new Error("PHASE8_OUTPUT_SAFETY_PROVENANCE is required and must be bounded");

const config = process.env.PHASE8_CONFIG ?? `${process.env.HOME}/.config/ableton-mcp/bridge-config.json`;
const setName = process.env.PHASE8_SET_NAME ?? "MCP-Audition-Disposable";
const liveVersion = process.env.PHASE8_LIVE_VERSION ?? "operator-observed";
const sourceTrackIndex = Number(process.env.PHASE8_SOURCE_TRACK_INDEX ?? 0);
const destinationTrackIndex = Number(process.env.PHASE8_DESTINATION_TRACK_INDEX ?? 2);
const recordedDirectory = process.env.PHASE8_RECORDED_DIRECTORY ?? `${process.env.HOME}/Music/Ableton/User Library/Samples/Recorded`;
if (![sourceTrackIndex, destinationTrackIndex].every((value) => Number.isInteger(value) && value >= 0 && value <= 255) || sourceTrackIndex === destinationTrackIndex) throw new Error("source/destination track indexes must be distinct bounded integers");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const rawEntries = () => {
  const entries = readdirSync(recordedDirectory, { withFileTypes: true });
  const observed = [];
  for (const entry of entries) {
    if (/\.(wav|aif|aiff|asd)$/i.test(entry.name)) observed.push(entry.name);
    if (entry.isDirectory() && entry.name.startsWith(".ableton-mcp-capture-")) {
      observed.push(`${entry.name}/`);
      for (const child of readdirSync(`${recordedDirectory}/${entry.name}`)) observed.push(`${entry.name}/${child}`);
    }
  }
  return observed.sort();
};
const rawUnchanged = (baseline) => JSON.stringify(rawEntries()) === JSON.stringify(baseline);

class Client {
  constructor(label) {
    this.next = 1;
    this.pending = new Map();
    this.child = spawn(process.execPath, [cli, "--config", config], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk).slice(0, 16_384 - this.stderr.length); });
    const failPending = (cause) => {
      for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(cause); this.pending.delete(id); }
    };
    this.child.on("error", (cause) => failPending(cause));
    this.child.on("close", (code, signal) => failPending(new Error(`packaged MCP host closed before responding (code=${code}, signal=${signal})`)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        const pending = this.pending.get(frame.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(frame.id); pending.resolve(frame); }
      } catch (cause) {
        failPending(cause instanceof Error ? cause : new Error("packaged MCP host emitted malformed stdout"));
        this.child.kill("SIGKILL");
      }
    });
    this.label = label;
  }
  send(method, params) {
    const id = this.next++;
    let resolve; let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`packaged MCP request ${id} timed out`)); }, 90_000);
    timer.unref();
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    return { id, promise };
  }
  async init() {
    const { promise } = this.send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: `phase8-${this.label}`, version: "1" } });
    const frame = await promise;
    if (frame.error) throw new Error(JSON.stringify(frame.error));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  begin(name, args = {}) {
    const request = this.send("tools/call", { name, arguments: args });
    return {
      id: request.id,
      promise: request.promise.then((frame) => {
        if (frame.error) throw new Error(JSON.stringify(frame.error));
        const value = JSON.parse(frame.result.content[0].text);
        if (frame.result.isError) throw new Error(JSON.stringify(value));
        return value;
      }),
    };
  }
  async call(name, args = {}) { return this.begin(name, args).promise; }
  cancel(id) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`); }
  forget(id) { const pending = this.pending.get(id); if (pending) { clearTimeout(pending.timer); this.pending.delete(id); } }
  kill() { this.child.kill("SIGKILL"); }
  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([new Promise((resolve) => this.child.once("close", resolve)), sleep(1_000)]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

const safety = { safe: true, provenance: outputSafetyProvenance, observedAt: new Date().toISOString(), scope: setName };
const capturePreview = (client, tracks, durationSeconds = 2) => client.call("live_audio_capture_preview", {
  setName,
  sourceSlotRef: tracks[sourceTrackIndex].clipSlots[0].ref,
  destinationSlotRef: tracks[destinationTrackIndex].clipSlots[0].ref,
  durationSeconds,
  consent: "ephemeral-analysis-and-delete",
  outputSafety: safety,
});
const captureApply = (client, preview, key) => client.call("live_audio_capture_apply", { transactionId: preview.transactionId, confirmation: preview.confirmation, idempotencyKey: key });
const captureSummary = (result) => ({
  captureId: result.captureId,
  media: result.media,
  integratedLufs: result.analysis.standardsAudio.loudness.integratedLufs,
  lraLu: result.analysis.standardsAudio.loudness.loudnessRange.lraLu,
  truePeakDbtp: result.analysis.standardsAudio.truePeak.aggregateDbtp,
  truePeakMethod: result.analysis.standardsAudio.truePeak.method,
  standardsCompliant: result.analysis.standardsAudio.loudness.standardsCompliant && result.analysis.standardsAudio.truePeak.standardsCompliant,
  diagnosisId: result.diagnosis.diagnosisId,
  findings: result.diagnosis.findings.map((finding) => ({ findingId: finding.findingId, severity: finding.severity, projectRefs: finding.projectRefs, confidence: finding.confidence, hasSuggestedPreview: finding.suggestedPreview !== null })),
  causalityClaimed: result.diagnosis.causality.claimed,
  cleanup: result.cleanup,
  rawPathReturned: result.media.rawPathReturned,
});

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  live: { version: liveVersion, application: "Ableton Live", platform: process.platform },
  package: { name: "@ableton-mcp/mcp-server", version: "0.1.0", installMode: "npm install from npm pack artifact", tarballSha256 },
  checks: {},
};

let client = new Client("main");
let failure;
let baselineVolume;
let mixerNeedsRestore = false;
let temporaryDeviceInserted = false;
let temporaryDeviceRef;
let noteTransaction = null;
let originalNotePatches = [];
let rawBaseline;
try {
  await client.init();
  let playback = (await client.call("live_discover", { kind: "session-playback" })).items[0];
  if (playback.transport.playing || playback.transport.arrangementRecord || playback.transport.sessionRecord || playback.firedTargets.length || playback.playingTargets.length) {
    const expectedTargets = [...playback.firedTargets, ...playback.playingTargets].map((target) => `${target.trackRef}|${target.clipSlotRef}|${target.sceneRef}`);
    const expectedRecording = playback.transport.sessionRecord && playback.transport.arrangementRecord ? "both" : playback.transport.sessionRecord ? "session" : playback.transport.arrangementRecord ? "arrangement" : "stopped";
    await client.call("live_session_emergency_stop", { confirmation: "emergency-stop", expectedTargets, expectedRecording, idempotencyKey: `phase8-initial-stop-${Date.now()}` });
  }

  let tracks = (await client.call("live_discover", { kind: "track" })).items;
  const source = tracks[sourceTrackIndex];
  const destination = tracks[destinationTrackIndex];
  if (!source?.clips?.[0] || source.clipSlots?.[0]?.empty !== false) throw new Error("Phase 8 requires one pre-existing disposable source Session clip");
  if (!destination || destination.clipSlots?.[0]?.empty !== true || destination.routing?.inputType !== "No Input" || destination.armed !== false || destination.monitoringState !== "off") throw new Error("Operator must visibly prepare an empty, unarmed, monitoring-off audio destination with No Input; the verifier will not risk changing a stale route");
  if (source.devices.length !== 0) throw new Error("Phase 8 verifier requires a device-free source baseline");
  rawBaseline = rawEntries();
  baselineVolume = source.mixer.volume;
  evidence.checks.initial = { sourceVolume: source.mixer.volume, sourceDevices: [], sourceSlotEmpty: false, destination: { route: destination.routing.inputType, armed: destination.armed, monitoring: destination.monitoringState, slotEmpty: true }, rawFileCount: rawBaseline.length };

  const search = await client.call("live_browser_search", { category: "instruments", query: "Operator", limit: 5 });
  const loadPreview = await client.call("live_browser_load_preview", { itemId: search.items[0].id, trackRef: source.ref });
  temporaryDeviceInserted = true;
  const loadedDevice = await client.call("live_browser_load_apply", { transactionId: loadPreview.transactionId, confirmation: "apply", idempotencyKey: `phase8-device-${Date.now()}` });
  temporaryDeviceRef = loadedDevice.deviceRef;
  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const server = await client.call("server_status");
  evidence.live.status = { adapter: server.live.adapter, provenance: server.live.provenance, epoch: server.live.epoch, registryHash: server.live.registryHash, captureCapability: server.live.capabilities.includes("audio.capture.resampling"), captureOperations: server.live.operations.filter((operation) => operation.startsWith("audio.capture.")) };
  evidence.checks.preparation = { sourceClip: "pre-existing-disposable", temporaryDevice: "Operator", destinationRoute: "operator-prepared-No Input" };

  const clip = tracks[sourceTrackIndex].clips[0];
  originalNotePatches = clip.notes.map((note) => ({ id: note.id, probability: note.probability, velocityDeviation: note.velocityDeviation }));
  const deterministicNotes = clip.notes.map((note) => ({ id: note.id, probability: 1, velocityDeviation: 0 }));
  if (deterministicNotes.length) {
    noteTransaction = await client.call("live_note_update_preview", { clipRef: clip.ref, notes: deterministicNotes });
    await client.call("live_note_update_apply", { transactionId: noteTransaction.transactionId, confirmation: "apply", idempotencyKey: `phase8-notes-${Date.now()}` });
  }

  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const firstPreview = await capturePreview(client, tracks);
  const first = await captureApply(client, firstPreview, `phase8-capture-one-${Date.now()}`);
  if (!first.cleanup.rawFileUnlinked || !rawUnchanged(rawBaseline)) throw new Error("first capture raw cleanup failed");
  evidence.checks.captureBefore = captureSummary(first);

  const sampleRate = 48_000;
  const seconds = 3;
  const encode = (amplitude) => {
    const bytes = Buffer.alloc(sampleRate * seconds * 4);
    for (let frame = 0; frame < sampleRate * seconds; frame += 1) bytes.writeFloatLE(amplitude * Math.sin(2 * Math.PI * 997 * frame / sampleRate), frame * 4);
    return bytes.toString("base64");
  };
  const comparison = await client.call("audio_compare_reference", { project: { pcmBase64: encode(0.1), sampleRate, channels: 1, channelLayout: ["M"] }, reference: { pcmBase64: encode(0.2), sampleRate, channels: 1, channelLayout: ["M"] }, alignment: { mode: "disabled" } });
  evidence.checks.referenceComparison = { version: comparison.version, resampling: comparison.resampling, alignment: comparison.alignment, levelMatch: comparison.levelMatch, deltas: comparison.deltas, privacy: comparison.privacy };

  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const originalVolume = tracks[sourceTrackIndex].mixer.volume;
  const experimentalVolume = Math.round(originalVolume * 0.9 * 1e6) / 1e6;
  const lowerPreview = await client.call("live_mixer_preview", { trackRef: tracks[sourceTrackIndex].ref, volume: experimentalVolume });
  mixerNeedsRestore = true;
  await client.call("live_mixer_apply", { transactionId: lowerPreview.transactionId, confirmation: "apply", idempotencyKey: `phase8-mixer-down-${Date.now()}` });
  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const secondPreview = await capturePreview(client, tracks);
  const second = await captureApply(client, secondPreview, `phase8-capture-two-${Date.now()}`);
  const restorePreview = await client.call("live_mixer_preview", { trackRef: tracks[sourceTrackIndex].ref, volume: originalVolume });
  await client.call("live_mixer_apply", { transactionId: restorePreview.transactionId, confirmation: "apply", idempotencyKey: `phase8-mixer-restore-${Date.now()}` });
  mixerNeedsRestore = false;
  evidence.checks.controlledAdjustment = { previewTool: "live_mixer_preview", normalizedVolume: { before: originalVolume, experimental: experimentalVolume, restored: originalVolume }, measurementBefore: captureSummary(first), measurementAfter: captureSummary(second), integratedDeltaLu: second.analysis.standardsAudio.loudness.integratedLufs - first.analysis.standardsAudio.loudness.integratedLufs, claim: "controlled reversible intervention; normalized volume is not represented as a promised dB change" };

  if (noteTransaction) {
    await client.call("live_undo", { transactionId: noteTransaction.transactionId, confirmation: "undo", idempotencyKey: `phase8-notes-undo-${Date.now()}` });
    noteTransaction = null;
  }

  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const cancellationPreview = await capturePreview(client, tracks, 3);
  const cancellationObserver = new Client("cancellation-observer");
  await cancellationObserver.init();
  const pending = client.begin("live_audio_capture_apply", { transactionId: cancellationPreview.transactionId, confirmation: cancellationPreview.confirmation, idempotencyKey: `phase8-cancel-${Date.now()}` });
  let cancellationResponseObserved = false;
  void pending.promise.then(() => { cancellationResponseObserved = true; }, () => { cancellationResponseObserved = true; });
  let cancellationStarted = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const observed = await cancellationObserver.call("live_audio_capture_status");
    if (observed.captureId === cancellationPreview.captureId && observed.active === true) { cancellationStarted = true; break; }
    await sleep(100);
  }
  await cancellationObserver.close();
  if (!cancellationStarted) throw new Error("cancellation lifecycle did not become active before the bounded cancellation observation deadline");
  client.cancel(pending.id);
  await sleep(10_000);
  if (cancellationResponseObserved || client.child.exitCode !== null || client.child.killed) throw new Error("cancelled MCP request was not suppressed while the original packaged host remained alive");
  client.forget(pending.id);
  await client.close();

  client = new Client("post-cancel");
  await client.init();
  let captureStatus = await client.call("live_audio_capture_status");
  playback = (await client.call("live_discover", { kind: "session-playback" })).items[0];
  evidence.checks.cancellation = { activeLifecycleObservedBeforeCancel: cancellationStarted, responseSuppressed: !cancellationResponseObserved, status: captureStatus, playback: { playing: playback.transport.playing, arrangementRecord: playback.transport.arrangementRecord, sessionRecord: playback.transport.sessionRecord }, rawFileCount: rawEntries().length, rawBaselineUnchanged: rawUnchanged(rawBaseline) };
  if (captureStatus.captureId !== cancellationPreview.captureId || captureStatus.state !== "cleaned" || captureStatus.active !== false || !captureStatus.playbackStopped || (Array.isArray(captureStatus.residual) && captureStatus.residual.length > 0) || !rawUnchanged(rawBaseline)) throw new Error("cancellation cleanup failed or described a stale lifecycle");

  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const restartPreview = await capturePreview(client, tracks);
  const restartClient = client;
  const observer = new Client("restart-observer");
  await observer.init();
  const restartPending = restartClient.begin("live_audio_capture_apply", { transactionId: restartPreview.transactionId, confirmation: restartPreview.confirmation, idempotencyKey: `phase8-restart-${Date.now()}` });
  void restartPending.promise.catch(() => undefined);
  let observedStart = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await observer.call("live_audio_capture_status");
    if (value.captureId === restartPreview.captureId && value.active === true) { observedStart = value; break; }
    await sleep(100);
  }
  await observer.close();
  if (!observedStart) throw new Error("restart capture did not start before host kill");
  restartClient.kill();
  await sleep(7_000);

  client = new Client("recovery");
  await client.init();
  const orphan = await client.call("live_audio_capture_status");
  if (orphan.captureId !== restartPreview.captureId || orphan.watchdogStopped !== true || orphan.active !== false || orphan.playbackStopped !== true || orphan.state !== "captured" || orphan.clip?.fileAvailable !== true || (Array.isArray(orphan.residual) && orphan.residual.length > 0)) throw new Error("host-death watchdog did not independently stop and finalize the exact capture");
  const recovered = await client.call("live_audio_capture_emergency_stop", { confirmation: "emergency-stop-and-clean", captureId: restartPreview.captureId, sourceSlotRef: restartPreview.sourceSlotRef, destinationSlotRef: restartPreview.destinationSlotRef });
  captureStatus = await client.call("live_audio_capture_status");
  playback = (await client.call("live_discover", { kind: "session-playback" })).items[0];
  evidence.checks.hostRestartWatchdog = { observed: { state: orphan.state, active: orphan.active, playbackStopped: orphan.playbackStopped, watchdogStopped: orphan.watchdogStopped, clipFileAvailable: orphan.clip?.fileAvailable === true }, recovery: recovered, finalStatus: captureStatus, playback: { playing: playback.transport.playing, arrangementRecord: playback.transport.arrangementRecord, sessionRecord: playback.transport.sessionRecord }, rawFileCount: rawEntries().length, rawBaselineUnchanged: rawUnchanged(rawBaseline) };
  if (recovered.state !== "cleaned" || recovered.cleanup?.safe !== true || (Array.isArray(recovered.cleanup?.residual) && recovered.cleanup.residual.length > 0) || captureStatus.state !== "cleaned" || captureStatus.active !== false || captureStatus.playbackStopped !== true || (Array.isArray(captureStatus.residual) && captureStatus.residual.length > 0) || !rawUnchanged(rawBaseline)) throw new Error("restart recovery failed");

  tracks = (await client.call("live_discover", { kind: "track" })).items;
  const operator = tracks[sourceTrackIndex].devices.find((device) => device.name === "Operator");
  if (!operator) throw new Error("temporary Operator device disappeared before exact cleanup");
  const deletePreview = await client.call("live_device_preview", { action: "delete", deviceRef: operator.ref });
  await client.call("live_device_apply", { transactionId: deletePreview.transactionId, confirmation: "apply", idempotencyKey: `phase8-device-delete-${Date.now()}` });
  temporaryDeviceInserted = false;
  temporaryDeviceRef = undefined;

  const finalTracks = (await client.call("live_discover", { kind: "track" })).items;
  const finalPlayback = (await client.call("live_discover", { kind: "session-playback" })).items[0];
  const finalCapture = await client.call("live_audio_capture_status");
  evidence.checks.final = {
    sourceVolume: finalTracks[sourceTrackIndex].mixer.volume,
    sourceDevices: finalTracks[sourceTrackIndex].devices.map((device) => device.name),
    sourceSlotEmpty: finalTracks[sourceTrackIndex].clipSlots[0].empty,
    destination: { route: finalTracks[destinationTrackIndex].routing.inputType, armed: finalTracks[destinationTrackIndex].armed, monitoring: finalTracks[destinationTrackIndex].monitoringState, slotEmpty: finalTracks[destinationTrackIndex].clipSlots[0].empty },
    playback: { playing: finalPlayback.transport.playing, arrangementRecord: finalPlayback.transport.arrangementRecord, sessionRecord: finalPlayback.transport.sessionRecord },
    capture: finalCapture,
    rawFileCount: rawEntries().length,
    rawBaselineUnchanged: rawUnchanged(rawBaseline),
    authenticatedTcpBridgeReachable: true,
  };
  if (evidence.live.status.provenance !== "real-live" || !evidence.live.status.captureCapability || evidence.live.status.captureOperations.length !== 6 || finalTracks[sourceTrackIndex].mixer.volume !== evidence.checks.initial.sourceVolume || finalTracks[sourceTrackIndex].devices.length !== 0 || finalTracks[destinationTrackIndex].clipSlots[0].empty !== true || finalCapture.state !== "cleaned" || finalCapture.playbackStopped !== true || !rawUnchanged(rawBaseline)) throw new Error("final exact baseline verification failed");
  evidence.passed = true;
} catch (cause) {
  failure = cause;
} finally {
  if (failure) {
    const cleanupFailures = [];
    try {
      try { await client.call("server_status"); }
      catch {
        await client.close().catch(() => undefined);
        client = new Client("failure-recovery");
        await client.init();
      }
      try {
        const observed = await client.call("live_audio_capture_status");
        if (observed.state !== "idle" && observed.state !== "cleaned" && observed.captureId && observed.sourceSlotRef && observed.destinationSlotRef) {
          await client.call("live_audio_capture_emergency_stop", { confirmation: "emergency-stop-and-clean", captureId: observed.captureId, sourceSlotRef: observed.sourceSlotRef, destinationSlotRef: observed.destinationSlotRef });
        }
      } catch (cause) { cleanupFailures.push(`capture:${cause instanceof Error ? cause.message : "failed"}`); }

      let cleanupTracks = (await client.call("live_discover", { kind: "track" })).items;
      if (mixerNeedsRestore && Number.isFinite(baselineVolume)) {
        if (cleanupTracks[sourceTrackIndex]?.mixer?.volume === baselineVolume) mixerNeedsRestore = false;
        else {
          try {
            const preview = await client.call("live_mixer_preview", { trackRef: cleanupTracks[sourceTrackIndex].ref, volume: baselineVolume });
            await client.call("live_mixer_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: `phase8-failure-volume-${Date.now()}` });
            mixerNeedsRestore = false;
          } catch (cause) { cleanupFailures.push(`mixer:${cause instanceof Error ? cause.message : "failed"}`); }
        }
      }
      if (noteTransaction && originalNotePatches.length && cleanupTracks[sourceTrackIndex]?.clips?.[0]) {
        try {
          const preview = await client.call("live_note_update_preview", { clipRef: cleanupTracks[sourceTrackIndex].clips[0].ref, notes: originalNotePatches });
          await client.call("live_note_update_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: `phase8-failure-notes-${Date.now()}` });
          noteTransaction = null;
        } catch (cause) { cleanupFailures.push(`notes:${cause instanceof Error ? cause.message : "failed"}`); }
      }
      cleanupTracks = (await client.call("live_discover", { kind: "track" })).items;
      if (temporaryDeviceInserted) {
        const devices = cleanupTracks[sourceTrackIndex]?.devices ?? [];
        const temporary = temporaryDeviceRef
          ? devices.find((device) => device.ref === temporaryDeviceRef)
          : devices.length === 1 && devices[0]?.name === "Operator" ? devices[0] : undefined;
        if (!temporary) {
          if (devices.length === 0) { temporaryDeviceInserted = false; temporaryDeviceRef = undefined; }
          else cleanupFailures.push("device:unidentified-device-remains-after-lost-acknowledgement");
        } else {
          try {
            const preview = await client.call("live_device_preview", { action: "delete", deviceRef: temporary.ref });
            await client.call("live_device_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: `phase8-failure-device-${Date.now()}` });
            temporaryDeviceInserted = false;
            temporaryDeviceRef = undefined;
          } catch (cause) { cleanupFailures.push(`device:${cause instanceof Error ? cause.message : "failed"}`); }
        }
      }
      cleanupTracks = (await client.call("live_discover", { kind: "track" })).items;
      if (Number.isFinite(baselineVolume) && cleanupTracks[sourceTrackIndex]?.mixer?.volume !== baselineVolume) cleanupFailures.push("mixer:baseline-not-restored");
      if ((cleanupTracks[sourceTrackIndex]?.devices?.length ?? 0) !== 0) cleanupFailures.push("device:device-free-baseline-not-restored");
      if (rawBaseline && !rawUnchanged(rawBaseline)) cleanupFailures.push("raw-media:baseline-changed");
    } catch (cause) { cleanupFailures.push(`recovery:${cause instanceof Error ? cause.message : "failed"}`); }
    if (cleanupFailures.length) failure = new AggregateError([failure], `Phase 8 verifier failed and cleanup was incomplete: ${cleanupFailures.join(", ")}`);
  }
  await client.close().catch(() => undefined);
}
if (failure) throw failure;

// Evidence must contain no confirmation, mapper/recovery authority, raw PCM,
// config/CLI/media path, or recorded filename.
const text = JSON.stringify(evidence);
for (const forbidden of ["confirmation", "mapperToken", "recoveryToken", "pcmBase64", "Samples/Recorded", config, cli]) if (forbidden && text.includes(forbidden)) throw new Error(`evidence contains forbidden field or path`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
