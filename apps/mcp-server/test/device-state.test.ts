import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function connectedHost() {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator);
  host.handle(initialize); host.handle(initialized);
  let requestId = 2100;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  const parseError = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) return { protocolError: frame.error };
    return { toolError: frame.result.isError === true ? JSON.parse(frame.result.content[0].text) : undefined, result: frame.result.isError === true ? undefined : JSON.parse(frame.result.content[0].text) };
  };
  const directory = mkdtempSync(join(tmpdir(), "device-state-"));
  return { simulator, host, call, parse, parseError, directory };
}

const firstDevice = (simulator: DeterministicLiveSimulator) => (simulator as any).state.tracks[0].devices[0];

test("save writes a verified schema-versioned snapshot; recall restores values; undo restores pre-recall state", async (t) => {
  const { simulator, call, parse, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const device = firstDevice(simulator);
  const parameter = device.parameters[0];
  const saved = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "utility-base", directory }));
  assert.equal(saved.saved, true);
  assert.equal(saved.device.parameterCount, 1);
  assert.match(saved.digest, /^[a-f0-9]{64}$/);
  const onDisk = JSON.parse(readFileSync(saved.file, "utf8"));
  assert.equal(onDisk.schema, "ableton-mcp-device-state/v1");
  assert.deepEqual(onDisk.parameters.map((row: any) => row.path), ["Utility/Gain"]);
  assert.equal(onDisk.privacy.profile, "device-state/v1");
  assert.equal(JSON.stringify(onDisk).includes("track:track-1"), false, "no session refs are persisted");
  // a duplicate save refuses without overwrite
  const overwriteFrame = (await call("live_device_state_save", { deviceRef: device.ref, name: "utility-base", directory })) as any;
  assert.equal(overwriteFrame.result.isError, true, "re-saving without overwrite is refused");
  const replaced = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "utility-base", directory, overwrite: true }));
  assert.equal(replaced.overwritten, true, "overwrite atomically replaces an existing regular snapshot");
  // modify the parameter, then recall the snapshot
  (simulator as any).simulateExternalEdit(parameter.ref, "value", 0.9);
  const preview = await parse(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: device.ref }));
  assert.equal(preview.mode, "recall");
  assert.equal(preview.applicable, 1);
  assert.equal(preview.dispositions[0].disposition, "applicable");
  assert.equal(preview.dispositions[0].proposedValue, 0.5);
  assert.equal(preview.dispositions[0].targetValue, 0.9);
  const applied = await parse(call("live_device_state_recall_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "recall-1" }));
  assert.equal(applied.state, "applied");
  assert.equal(parameter.value, 0.5);
  const replay = await parse(call("live_device_state_recall_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "recall-1" }));
  assert.equal(replay.idempotent, true);
  const undone = await parse(call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "recall-undo-1" }));
  assert.equal(undone.state, "undone");
  assert.equal(parameter.value, 0.9, "undo restores the exact pre-recall value");
});

test("cross-track recall onto an equivalent device writes through exact per-parameter authority", async (t) => {
  const { simulator, call, parse, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = (simulator as any).state;
  const sourceDevice = state.tracks[0].devices[0];
  const saved = await parse(call("live_device_state_save", { deviceRef: sourceDevice.ref, name: "cross", directory }));
  // a second track with an equivalent (same class/layout, distinct refs) device
  const secondTrack = structuredClone(state.tracks[0]);
  secondTrack.ref = "track:track-2"; secondTrack.objectIdentity = "simulator:track:track-2"; secondTrack.name = "Bass";
  const secondDevice = secondTrack.devices[0];
  secondDevice.ref = "device:utility-2"; secondDevice.objectIdentity = "simulator:device:utility-2";
  secondDevice.parameters[0].ref = "parameter:gain-2"; secondDevice.parameters[0].objectIdentity = "simulator:parameter:gain-2";
  secondDevice.parameters[0].value = 0.1;
  state.tracks.push(secondTrack);
  const preview = await parse(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: secondDevice.ref }));
  assert.equal(preview.applicable, 1);
  const applied = await parse(call("live_device_state_recall_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "recall-cross" }));
  assert.equal(applied.state, "applied");
  assert.equal(secondDevice.parameters[0].value, 0.5, "the equivalent device on the second track received the snapshot value");
  assert.equal(state.tracks[0].devices[0].parameters[0].value, 0.5, "the source device kept its own value");
});

test("rack subtree recall walks chains with stable named paths", async (t) => {
  const { simulator, call, parse, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = (simulator as any).state;
  const inner = { ref: "device:inner-1", objectIdentity: "simulator:device:inner-1", name: "Saturator", kind: "audio-effect", enabled: true, parameters: [
    { ref: "parameter:drive-1", objectIdentity: "simulator:parameter:drive-1", name: "Drive", value: 0.2, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, revision: 1 },
  ] };
  const rack = { ref: "device:rack-1", objectIdentity: "simulator:device:rack-1", name: "FX Rack", kind: "rack", enabled: true, parameters: [], chains: [
    { ref: "chain:chain-1", objectIdentity: "simulator:chain:chain-1", parentRef: "device:rack-1", index: 0, name: "Wet", mute: false, solo: false, devices: [inner] },
  ] };
  state.tracks[0].devices.push(rack);
  // the flat simulator cannot fence nested rack parameters, so emulate the
  // bridge's nested-parameter write path while keeping authority-shape checks
  const original = simulator.invokeAsync.bind(simulator);
  const writes: Array<Record<string, unknown>> = [];
  simulator.invokeAsync = async (invocation: any) => {
    if (invocation.operation !== "device.parameter.set") return original(invocation);
    writes.push(invocation.args);
    const parameter = inner.parameters.find((candidate) => candidate.ref === invocation.args.ref);
    assert.ok(parameter, "nested parameter ref is resolved");
    assert.equal(invocation.args.expectedObjectIdentity, parameter.objectIdentity);
    assert.equal(invocation.args.expectedOwnerRef, inner.ref);
    assert.equal(invocation.args.expectedTrackRef, "track:track-1");
    assert.equal(invocation.args.expectedRevision, parameter.revision);
    parameter.value = invocation.args.value as number;
    parameter.revision += 1;
    return { changed: true, ref: parameter.ref, value: parameter.value, revision: parameter.revision };
  };
  const saved = await parse(call("live_device_state_save", { deviceRef: rack.ref, name: "rack-state", directory }));
  const onDisk = JSON.parse(readFileSync(saved.file, "utf8"));
  assert.deepEqual(onDisk.parameters.map((row: any) => row.path), ["FX Rack/Wet[0]/Saturator[0]/Drive"]);
  inner.parameters[0]!.value = 0.8;
  const preview = await parse(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: rack.ref }));
  assert.equal(preview.applicable, 1);
  assert.equal(preview.dispositions[0].path, "FX Rack/Wet[0]/Saturator[0]/Drive");
  const applied = await parse(call("live_device_state_recall_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "recall-rack" }));
  assert.equal(applied.state, "applied");
  assert.equal(inner.parameters[0]!.value, 0.2, "the nested chain parameter was restored");
  assert.equal(writes.length, 1);
});

test("duplicate sibling device names use indexed paths and round-trip independently", async (t) => {
  const { simulator, call, parse, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = (simulator as any).state;
  const siblings = [
    { ref: "device:eq-1", objectIdentity: "simulator:device:eq-1", name: "EQ Eight", kind: "audio-effect", enabled: true, parameters: [
      { ref: "parameter:eq-gain-1", objectIdentity: "simulator:parameter:eq-gain-1", name: "Gain", value: 0.2, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, revision: 1 },
    ] },
    { ref: "device:eq-2", objectIdentity: "simulator:device:eq-2", name: "EQ Eight", kind: "audio-effect", enabled: true, parameters: [
      { ref: "parameter:eq-gain-2", objectIdentity: "simulator:parameter:eq-gain-2", name: "Gain", value: 0.7, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, revision: 1 },
    ] },
  ];
  const rack = { ref: "device:duplicate-rack", objectIdentity: "simulator:device:duplicate-rack", name: "FX Rack", kind: "rack", enabled: true, parameters: [], chains: [
    { ref: "chain:duplicate-chain", objectIdentity: "simulator:chain:duplicate-chain", parentRef: "device:duplicate-rack", index: 0, name: "Wet", mute: false, solo: false, devices: siblings },
  ] };
  state.tracks[0].devices.push(rack);
  const original = simulator.invokeAsync.bind(simulator);
  const writes: string[] = [];
  simulator.invokeAsync = async (invocation: any) => {
    if (invocation.operation !== "device.parameter.set") return original(invocation);
    const parameter = siblings.flatMap((device) => device.parameters).find((candidate) => candidate.ref === invocation.args.ref);
    assert.ok(parameter, "the indexed path resolves to the intended duplicate sibling");
    writes.push(parameter.ref);
    parameter.value = invocation.args.value as number;
    parameter.revision += 1;
    return { changed: true, ref: parameter.ref, value: parameter.value, revision: parameter.revision };
  };

  const saved = await parse(call("live_device_state_save", { deviceRef: rack.ref, name: "duplicate-devices", directory }));
  const onDisk = JSON.parse(readFileSync(saved.file, "utf8"));
  assert.deepEqual(onDisk.parameters.map((row: any) => row.path), [
    "FX Rack/Wet[0]/EQ Eight[0]/Gain",
    "FX Rack/Wet[0]/EQ Eight[1]/Gain",
  ]);
  siblings[0]!.parameters[0]!.value = 0.8;
  siblings[1]!.parameters[0]!.value = 0.9;
  const preview = await parse(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: rack.ref }));
  assert.equal(preview.applicable, 2);
  assert.deepEqual(preview.dispositions.map((row: any) => row.proposedValue), [0.2, 0.7]);
  const applied = await parse(call("live_device_state_recall_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "recall-duplicates" }));
  assert.equal(applied.state, "applied");
  assert.equal(siblings[0]!.parameters[0]!.value, 0.2);
  assert.equal(siblings[1]!.parameters[0]!.value, 0.7);
  assert.deepEqual(writes, ["parameter:eq-gain-1", "parameter:eq-gain-2"]);
});

test("device-class and layout mismatches refuse with per-parameter reports; partial layout is opt-in", async (t) => {
  const { simulator, call, parse, parseError, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = (simulator as any).state;
  const device = state.tracks[0].devices[0];
  const saved = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "guarded", directory }));
  // class mismatch: a device with a different name/class evidence
  const alien = structuredClone(device);
  alien.ref = "device:echo-1"; alien.objectIdentity = "simulator:device:echo-1"; alien.name = "Echo";
  alien.parameters[0].ref = "parameter:echo-gain"; alien.parameters[0].objectIdentity = "simulator:parameter:echo-gain";
  state.tracks[0].devices.push(alien);
  const classRefusal = await parseError(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: alien.ref }));
  assert.equal(classRefusal.toolError.refused, true);
  assert.match(classRefusal.toolError.reason, /device class/);
  assert.equal(classRefusal.toolError.dispositions.length, 1);
  // layout mismatch: an extra parameter on the target changes the fingerprint
  device.parameters.push({ ref: "parameter:extra-1", objectIdentity: "simulator:parameter:extra-1", name: "Extra", value: 0.3, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, revision: 1 });
  const layoutRefusal = await parseError(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: device.ref }));
  assert.equal(layoutRefusal.toolError.refused, true);
  assert.match(layoutRefusal.toolError.reason, /layout fingerprint/);
  // opt-in partial recall applies the matching subset
  const partial = await parse(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: device.ref, allowPartialLayout: true }));
  assert.equal(partial.applicable, 1);
  const appliedPartial = await parse(call("live_device_state_recall_apply", { transactionId: partial.transactionId, confirmation: "apply", idempotencyKey: "recall-partial" }));
  assert.equal(appliedPartial.state, "applied");
  // a file parameter with no target path reports skipped-missing under partial layout
  const enriched = JSON.parse(readFileSync(saved.file, "utf8"));
  enriched.parameters.push({ path: "Utility/Missing", name: "Missing", value: 0.4, min: 0, max: 1, quantization: 0 });
  enriched.device.parameterCount = 2;
  const { createHash } = await import("node:crypto");
  const canonical = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; };
  enriched.digest = createHash("sha256").update(canonical({ schema: enriched.schema, device: enriched.device, parameters: enriched.parameters })).digest("hex");
  const partialFile = join(directory, "partial.ableton-device-state.json");
  writeFileSync(partialFile, JSON.stringify(enriched));
  const missingPreview = await parse(call("live_device_state_recall_preview", { file: partialFile, targetDeviceRef: device.ref, allowPartialLayout: true }));
  const missing = missingPreview.dispositions.find((row: any) => row.path === "Utility/Missing");
  assert.equal(missing.disposition, "skipped-missing");
});

test("morph interpolates deterministically with documented quantization rounding", async (t) => {
  const { simulator, call, parse, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const device = firstDevice(simulator);
  const parameter = device.parameters[0];
  parameter.quantization = 0.2;
  (simulator as any).simulateExternalEdit(parameter.ref, "value", 0);
  const fileA = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "morph-a", directory }));
  (simulator as any).simulateExternalEdit(parameter.ref, "value", 1);
  const fileB = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "morph-b", directory }));
  const preview = await parse(call("live_device_state_recall_preview", { file: fileB.file, targetDeviceRef: device.ref, morphFromFile: fileA.file, amount: 0.5 }));
  assert.equal(preview.mode, "morph");
  // raw float64 lerp 0.5 with quantization 0.2: 0.5/0.2 === 2.5 exactly,
  // half-up rounding takes step 3, so the documented deterministic result is 3 * 0.2
  assert.equal(preview.dispositions[0].proposedValue, 3 * 0.2);
  const again = await parse(call("live_device_state_recall_preview", { file: fileB.file, targetDeviceRef: device.ref, morphFromFile: fileA.file, amount: 0.5 }));
  assert.equal(again.dispositions[0].proposedValue, preview.dispositions[0].proposedValue, "same inputs and amount give identical values");
  // amount endpoints reproduce the sources exactly
  const atZero = await parse(call("live_device_state_recall_preview", { file: fileB.file, targetDeviceRef: device.ref, morphFromFile: fileA.file, amount: 0 }));
  assert.equal(atZero.dispositions[0].proposedValue, 0);
  const atOne = await parse(call("live_device_state_recall_preview", { file: fileB.file, targetDeviceRef: device.ref, morphFromFile: fileA.file, amount: 1 }));
  assert.equal(atOne.dispositions[0].proposedValue, 1);
  // morph from live state
  (simulator as any).simulateExternalEdit(parameter.ref, "value", 0.4);
  const liveMorph = await parse(call("live_device_state_recall_preview", { file: fileA.file, targetDeviceRef: device.ref, morphFromLive: true, amount: 0.5 }));
  assert.equal(liveMorph.dispositions[0].proposedValue, 0.2, "lerp(0.4, 0, 0.5) = 0.2 quantized to one step of 0.2");
  const applied = await parse(call("live_device_state_recall_apply", { transactionId: liveMorph.transactionId, confirmation: "apply", idempotencyKey: "morph-live" }));
  assert.equal(applied.state, "applied");
  assert.equal(parameter.value, 0.2);
  const undone = await parse(call("live_undo", { transactionId: liveMorph.transactionId, confirmation: "undo", idempotencyKey: "morph-live-undo" }));
  assert.equal(undone.state, "undone");
  assert.equal(parameter.value, 0.4);
});

test("snapshot file validation is fail-closed: digest tampering, schema, overwrite, and path rules", async (t) => {
  const { simulator, call, parse, parseError, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const device = firstDevice(simulator);
  const saved = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "tamper", directory }));
  const tampered = JSON.parse(readFileSync(saved.file, "utf8"));
  tampered.parameters[0].value = 0.99;
  writeFileSync(saved.file, JSON.stringify(tampered));
  const digestRefusal = await parseError(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: device.ref }));
  assert.equal(digestRefusal.toolError !== undefined, true);
  const wrongSchema = join(directory, "wrong.ableton-device-state.json");
  writeFileSync(wrongSchema, JSON.stringify({ schema: "ableton-mcp-device-state/v0" }));
  const schemaRefusal = await parseError(call("live_device_state_recall_preview", { file: wrongSchema, targetDeviceRef: device.ref }));
  assert.equal(schemaRefusal.toolError !== undefined, true);
  const missing = await parseError(call("live_device_state_recall_preview", { file: join(directory, "absent.ableton-device-state.json"), targetDeviceRef: device.ref }));
  assert.equal(missing.toolError !== undefined, true);
  const badName = (await call("live_device_state_save", { deviceRef: device.ref, name: "../escape", directory })) as any;
  assert.equal(badName.error?.code, -32602);
  const relativeDir = await parseError(call("live_device_state_save", { deviceRef: device.ref, name: "relative", directory: "relative/path" }));
  assert.equal(relativeDir.toolError !== undefined, true);
  const badMorph = (await call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: device.ref, morphFromLive: true })) as any;
  assert.equal(badMorph.error?.code, -32602, "morph without an explicit amount is invalid");
});

test("snapshot save refuses an output symlink without modifying its target", async (t) => {
  const { simulator, call, parseError, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (process.platform === "win32") { t.skip("file symlink creation requires optional Windows privilege"); return; }
  const unrelated = join(directory, "unrelated.txt");
  const output = join(directory, "linked.ableton-device-state.json");
  writeFileSync(unrelated, "do not replace\n");
  symlinkSync(unrelated, output);

  const refusal = await parseError(call("live_device_state_save", { deviceRef: firstDevice(simulator).ref, name: "linked", directory, overwrite: true }));
  assert.ok(refusal.toolError, "the save is refused before following the output symlink");
  assert.equal(readFileSync(unrelated, "utf8"), "do not replace\n");
  assert.equal(lstatSync(output).isSymbolicLink(), true, "the refused save leaves the symlink entry untouched");
});

test("a mid-recall refusal rolls written parameters back to their exact prior values", async (t) => {
  const { simulator, call, parse, directory } = connectedHost();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const device = firstDevice(simulator);
  device.parameters.push({ ref: "parameter:second-1", objectIdentity: "simulator:parameter:second-1", name: "Second", value: 0.7, min: 0, max: 1, automatable: true, quantization: 0, enabled: true, revision: 1 });
  const saved = await parse(call("live_device_state_save", { deviceRef: device.ref, name: "two-params", directory }));
  assert.equal(saved.device.parameterCount, 2);
  device.parameters[0].value = 0.1;
  device.parameters[1].value = 0.2;
  const preview = await parse(call("live_device_state_recall_preview", { file: saved.file, targetDeviceRef: device.ref }));
  assert.equal(preview.applicable, 2);
  // an external edit on the second parameter between preview and apply
  (simulator as any).simulateExternalEdit("parameter:second-1", "value", 0.95);
  const response = await parse(call("live_device_state_recall_apply", { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "recall-rollback" }));
  assert.equal(response.state, "compensated");
  assert.equal(response.failedIndex, 1);
  assert.equal(response.rolledBack, 1);
  assert.equal(device.parameters[0].value, 0.1, "the written parameter was rolled back to its exact prior value");
  assert.equal(device.parameters[1].value, 0.95, "the fenced parameter never dispatched");
});
