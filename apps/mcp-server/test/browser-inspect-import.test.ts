import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function connectedHost(policy?: unknown) {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator, policy === undefined ? undefined : { toolPolicy: policy });
  host.handle(initialize); host.handle(initialized);
  let requestId = 100;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  return { simulator, host, call };
}

function waveBytes(label = "payload"): Buffer {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([label.length & 0xff, 0, 0, 0]), Buffer.from("WAVE"), Buffer.from(label)]);
}

test("browser inspect returns stable identity, type, provenance, and explicit loadability", async () => {
  const { call } = connectedHost();
  const inspected = await call("live_browser_inspect", { itemId: "instruments/Drum Rack" });
  const value = JSON.parse((inspected as any).result.content[0].text);
  assert.equal((inspected as any).result.isError, false);
  assert.equal(value.item.id, "instruments/Drum Rack");
  assert.equal(value.item.category, "instruments");
  assert.equal(value.item.isDevice, true);
  assert.equal(value.identity.objectIdentity, "simulator:browser:instruments/Drum Rack");
  assert.equal(typeof value.identity.revision, "string");
  assert.equal(value.identity.revision.length, 64);
  assert.equal(value.loadability.loadable, true);
  assert.match(value.loadability.reason, /live_browser_load_preview/);
  assert.equal(value.provenance.adapter, "simulator");
  assert.deepEqual(value.provenance.operations, ["browser.inspect"]);
  // No raw filesystem path is ever exposed.
  assert.equal(/^(?:\/|[A-Za-z]:[\\/])/.test(String(value.item.path)), false);

  const notDevice = JSON.parse(((await call("live_browser_inspect", { itemId: "drums/Kick Core" })) as any).result.content[0].text);
  assert.equal(notDevice.item.isDevice, false);
  assert.equal(notDevice.loadability.loadable, false);
  assert.match(notDevice.loadability.reason, /only device items are loadable/);

  const missing = await call("live_browser_inspect", { itemId: "instruments/Nonexistent" });
  assert.equal((missing as any).result.isError, true);
});

test("browser inspect is fail-closed when disconnected and read-only-policy visible", async () => {
  const host = new McpHost();
  host.handle(initialize); host.handle(initialized);
  const unavailable = await host.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_browser_inspect", arguments: { itemId: "instruments/Drum Rack" } } });
  assert.equal((unavailable as any).result.isError, true);
  assert.match(JSON.parse((unavailable as any).result.content[0].text).reason, /tool-unavailable/);

  const { host: readOnlyHost } = connectedHost({ profile: "read-only" });
  const listed = (readOnlyHost.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(listed.includes("live_browser_inspect"));
});

test("audio import refuses content/extension mismatch, MIDI files, and traversal, and previews format/size/hash", async () => {
  const { simulator, call } = connectedHost();
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Import Target", index: 1 });
  (simulator as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const dir = mkdtempSync(join(tmpdir(), "browser-import-"));

  const valid = join(dir, "valid.wav");
  writeFileSync(valid, waveBytes());
  const preview = JSON.parse(((await call("live_audio_import_preview", { filePath: valid, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1 })) as any).result.content[0].text);
  assert.equal(preview.file.size, waveBytes().length);
  assert.equal(typeof preview.file.sha256, "string");
  assert.equal(preview.file.path, realpathSync(valid));

  const mismatch = join(dir, "fake.wav");
  writeFileSync(mismatch, Buffer.from("PK\x03\x04 not actually wave"));
  const refused = await call("live_audio_import_preview", { filePath: mismatch, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1 });
  assert.equal((refused as any).result.isError, true);
  assert.match(JSON.parse((refused as any).result.content[0].text).reason, /declared audio format/);

  const midi = join(dir, "pattern.mid");
  writeFileSync(midi, Buffer.from("MThd\0\0\0\x06"));
  const midiRefused = await call("live_audio_import_preview", { filePath: midi, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1 });
  assert.equal((midiRefused as any).result.isError, true);
  assert.match(JSON.parse((midiRefused as any).result.content[0].text).reason, /MIDI file import/);

  const outside = mkdtempSync(join(tmpdir(), "browser-import-outside-"));
  const target = join(outside, "outside.wav");
  writeFileSync(target, waveBytes("outside"));
  const link = join(dir, "linked.wav");
  symlinkSync(target, link);
  const traversed = await call("live_audio_import_preview", { filePath: link, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1 });
  assert.equal((traversed as any).result.isError, true);
  assert.match(JSON.parse((traversed as any).result.content[0].text).reason, /escapes the allowed root/);

  const unknown = join(dir, "notes.txt");
  writeFileSync(unknown, "text");
  const unsupported = await call("live_audio_import_preview", { filePath: unknown, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1 });
  assert.equal((unsupported as any).result.isError, true);
  assert.match(JSON.parse((unsupported as any).result.content[0].text).reason, /not an importable audio file/);
});

test("valid container signatures are accepted per extension", async () => {
  const { simulator, call } = connectedHost();
  (simulator as any).state.scenes.push({ ref: "scene:scene-2", objectIdentity: "simulator:scene:scene-2", name: "Import Target", index: 1 });
  (simulator as any).state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: null, empty: true });
  const dir = mkdtempSync(join(tmpdir(), "browser-import-formats-"));
  const fixtures: Array<[string, Buffer]> = [
    ["a.wav", waveBytes()],
    ["b.aiff", Buffer.concat([Buffer.from("FORM"), Buffer.alloc(4), Buffer.from("AIFF"), Buffer.from("data")])],
    ["c.flac", Buffer.from("fLaC-stream")],
    ["d.ogg", Buffer.from("OggS-stream")],
    ["e.mp3", Buffer.from("ID3\x04\x00")],
    ["f.mp3", Buffer.from([0xff, 0xfb, 0x90, 0x00])],
    ["g.m4a", Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from("M4A ")])],
  ];
  for (const [name, bytes] of fixtures) {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    const preview = await call("live_audio_import_preview", { filePath: path, allowedRoot: dir, trackRef: "track:track-1", sceneIndex: 1 });
    assert.equal((preview as any).result.isError, false, name);
    assert.equal(JSON.parse((preview as any).result.content[0].text).file.size, bytes.length);
  }
});
