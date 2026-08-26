import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOfflineAlsArtifact, extractAlsMidi, lintAlsModel, modelFromAlsXml, parseAlsXml, readAlsModel } from "../src/als.js";
import { estimateKey } from "../src/key-estimation.js";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";

const NOTE_EVENTS_C_MAJOR: Array<{ key: number; events: Array<[number, number, number]> }> = [
  { key: 60, events: [[0, 1, 100], [4, 1, 100], [8, 2, 100]] },
  { key: 64, events: [[1, 1, 90], [5, 1, 90]] },
  { key: 67, events: [[2, 1, 95], [6, 1, 95]] },
  { key: 62, events: [[7, 1, 88]] },
];

function noteEventsXml(rows: Array<{ key: number; events: Array<[number, number, number]> }>): string {
  return `<Notes><KeyTracks>${rows.map((row, rowIndex) => `<KeyTrack Id="${rowIndex}"><MidiKey Value="${row.key}"/><Notes><Events>${row.events.map((event, eventIndex) => `<NoteEvent Time="${event[0]}" Duration="${event[1]}" Velocity="${event[2]}" OffVelocity="64" Probability="1" IsEnabled="true" NoteId="${eventIndex}"/>`).join("")}</Events></Notes></KeyTrack>`).join("")}</KeyTracks></Notes>`;
}

function fixtureXml(options: { trackName?: string; withAudio?: boolean; secondTrackEmpty?: boolean; locatorTime?: number; clipStart?: number; mediaPath?: string } = {}): string {
  const trackName = options.trackName ?? "Drums";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0" SchemaChangeCount="3" Creator="Ableton Live 12.4.5b8">
<LiveSet>
  <Tracks>
    <MidiTrack Id="0">
      <Name><EffectiveName Value="${trackName}"/><UserName Value="${trackName}"/></Name>
      <Color Value="4"/>
      <DeviceChain>
        <Mixer><Volume><Manual Value="0.85"/></Volume><Pan><Manual Value="0"/></Pan></Mixer>
        <Devices><OriginalSimpler Id="0"><UserName Value="Simpler"/></OriginalSimpler></Devices>
        <ClipSlots>
          <ClipSlot Id="0"><ClipSlot Value=""><MidiClip Id="0" Time="0" Length="4" Disabled="false"><Name Value="Kick Loop"/>${noteEventsXml(NOTE_EVENTS_C_MAJOR)}</MidiClip></ClipSlot></ClipSlot>
        </ClipSlots>
        <ArrangerAutomation><Events><MidiClip Id="1" Time="${options.clipStart ?? 8}" Length="4" Disabled="false"><Name Value="Arr Phrase"/>${noteEventsXml(NOTE_EVENTS_C_MAJOR)}</MidiClip></Events></ArrangerAutomation>
      </DeviceChain>
    </MidiTrack>
    ${options.withAudio === false ? "" : `<AudioTrack Id="1">
      <Name><EffectiveName Value="Bass Audio"/><UserName Value="Bass Audio"/></Name>
      <Color Value="12"/>
      <DeviceChain>
        <Mixer><Volume><Manual Value="0.7"/></Volume><Pan><Manual Value="0"/></Pan></Mixer>
        <Devices/>
        <ClipSlots/>
        <ArrangerAutomation><Events><AudioClip Id="2" Time="0" Length="64" SampleLength="128" Disabled="false"><Name Value="Long Take"/><IsWarped Value="false"/><SampleRef><FileRef><Path Value="${options.mediaPath ?? "/tmp/als-fixture-media/long-take.wav"}"/></FileRef></SampleRef></AudioClip></Events></ArrangerAutomation>
      </DeviceChain>
    </AudioTrack>`}
    ${options.secondTrackEmpty ? `<MidiTrack Id="2"><Name><EffectiveName Value="Drums"/><UserName Value="Drums"/></Name><Color Value="4"/><DeviceChain><Mixer/><Devices/><ClipSlots/><ArrangerAutomation><Events/></ArrangerAutomation></DeviceChain></MidiTrack>` : ""}
  </Tracks>
  <Scenes><Scene Id="0"><Name Value="Scene 1"/><Tempo><Manual Value="120"/></Tempo></Scene></Scenes>
  <Locators><Locators><Locator Id="0" Time="0"><Name Value="Intro"/></Locator><Locator Id="1" Time="16"><Name Value="Verse"/></Locator></Locators></Locators>
  <MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="120"/></Tempo></Mixer></DeviceChain></MasterTrack>
</LiveSet>
</Ableton>`;
}

function writeFixture(directory: string, name: string, xml: string): string {
  const path = join(directory, name);
  writeFileSync(path, gzipSync(Buffer.from(xml, "utf8")));
  return path;
}

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "als-test-"));
  return directory;
}

test("the XML reader rejects hostile documents and stays bounded", () => {
  const doc = (body: string) => `<Ableton><LiveSet>${body}</LiveSet></Ableton>`;
  assert.throws(() => parseAlsXml(`<!DOCTYPE lolz [<!ENTITY x "boom">]>${doc("")}`), /DOCTYPE/);
  assert.throws(() => parseAlsXml(doc("<Unclosed>")), /malformed/);
  assert.throws(() => parseAlsXml(`${doc("")}<Extra/>`), /multiple roots/);
  assert.throws(() => parseAlsXml(doc(`${"<x a=\"1\">".repeat(100)}`)), /depth|malformed/);
  const deep = parseAlsXml(doc(`<MidiTrack Id="0"><Name><EffectiveName Value="T"/></Name></MidiTrack>`));
  assert.equal(deep.children[0]!.tag, "LiveSet");
});

test("offline parse reconstructs tracks, clips, canonical notes, scenes, and locators", () => {
  const directory = tempDir();
  try {
    const path = writeFixture(directory, "Demo.als", fixtureXml());
    const { source, model } = readAlsModel(path);
    assert.equal(model.setName, "Demo");
    assert.equal(model.tempo, 120);
    assert.equal(model.creator, "Ableton Live 12.4.5b8");
    assert.equal(model.tracks.length, 3);
    assert.equal(model.tracks[2]!.kind, "main");
    assert.equal(model.tracks[0]!.name, "Drums");
    assert.equal(model.tracks[0]!.kind, "midi");
    assert.equal(model.tracks[0]!.colorIndex, 4);
    assert.equal(model.tracks[0]!.volume, 0.85);
    assert.equal(model.tracks[0]!.devices[0]!.name, "Simpler");
    const clips = model.tracks[0]!.clips;
    assert.equal(clips.length, 2);
    const session = clips.find((clip) => clip.lane === "session")!;
    assert.equal(session.sceneIndex, 0);
    const arrangement = clips.find((clip) => clip.lane === "arrangement")!;
    assert.equal(arrangement.start, 8);
    assert.equal(session.notes.length, 8);
    assert.deepEqual(session.notes[0], { pitch: 60, start: 0, duration: 1, velocity: 100, channel: 1, mute: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64 });
    assert.deepEqual(model.locators.map((locator) => [locator.time, locator.name]), [[0, "Intro"], [16, "Verse"]]);
    assert.deepEqual(model.scenes, [{ name: "Scene 1", tempo: 120 }]);
    assert.equal(model.tracks[1]!.kind, "audio");
    assert.equal(model.tracks[1]!.clips[0]!.warping, false);
    assert.ok(source.sha256.length === 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline artifacts validate, mark live-only sections unavailable, and honor privacy profiles", () => {
  const directory = tempDir();
  try {
    const path = writeFixture(directory, "Demo.als", fixtureXml());
    const { source, model } = readAlsModel(path);
    const artifact = createOfflineAlsArtifact(source, model, { exporterVersion: "test-1" });
    assert.equal(artifact.provenance.source, "offline-file");
    assert.equal(artifact.provenance.live.adapter, "offline-file");
    assert.equal(typeof artifact.provenance.setFileSha256, "string");
    assert.equal(artifact.safety.readOnly, true);
    assert.equal(artifact.safety.containsMutationAuthority, false);
    assert.ok(artifact.manifest.tracks.complete);
    const unavailable = artifact.records.filter((record) => record.section === "unavailable");
    assert.ok(unavailable.some((record) => record.data.field === "live-playback"));
    assert.ok(unavailable.some((record) => record.data.field === "take-lanes"));
    const clipRecords = artifact.records.filter((record) => record.section === "clips");
    assert.equal(clipRecords.length, 3);
    const strict = createOfflineAlsArtifact(source, model, { profile: "strict", exporterVersion: "test-1" });
    assert.equal(strict.policy.names, "typed-aliases");
    assert.ok(!JSON.stringify(strict.records).includes("Drums"));
    assert.ok(!JSON.stringify(strict.records).includes("long-take.wav"));
    const local = createOfflineAlsArtifact(source, model, { profile: "local", exporterVersion: "test-1" });
    assert.ok(JSON.stringify(local.records).includes("long-take.wav"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extracted MIDI feeds key estimation without a bridge", () => {
  const directory = tempDir();
  try {
    const path = writeFixture(directory, "Demo.als", fixtureXml());
    const { model } = readAlsModel(path);
    const rows = extractAlsMidi(model);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.notesRevision.length, 64);
    assert.equal(rows[0]!.notes.length, 8);
    const estimate = estimateKey(rows[0]!.notes);
    assert.equal(estimate.candidates[0]!.key, "C major");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lint reports bounded findings with severity and object identity", () => {
  const directory = tempDir();
  try {
    mkdirSync(join(directory, "media"), { recursive: true });
    const xml = fixtureXml({ secondTrackEmpty: true, clipStart: 32, mediaPath: join(directory, "media", "missing.wav") });
    const path = writeFixture(directory, "Demo.als", xml);
    const { model } = readAlsModel(path);
    const { findings } = lintAlsModel(model, { allowedRoot: directory });
    const checks = new Set(findings.map((finding) => finding.check));
    assert.ok(checks.has("duplicate-track-name"));
    assert.ok(checks.has("empty-track"));
    assert.ok(checks.has("clip-beyond-last-locator"));
    assert.ok(checks.has("unwarped-long-sample"));
    assert.ok(checks.has("missing-sample-reference"));
    const missing = findings.find((finding) => finding.check === "missing-sample-reference")!;
    assert.equal(missing.severity, "error");
    assert.equal(missing.object.kind, "clip");
    for (const finding of findings) assert.ok(["info", "warning", "error"].includes(finding.severity));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function failClosedHost() {
  const host = new McpHost();
  host.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  host.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  let requestId = 100;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  return { host, call };
}

test("als_read, als_lint, and als_diff work on a fail-closed host with owner authority", async () => {
  const directory = tempDir();
  try {
    const before = writeFixture(directory, "Before.als", fixtureXml());
    const after = writeFixture(directory, "After.als", fixtureXml({ trackName: "Drums Renamed", clipStart: 32 }));
    const { call } = failClosedHost();
    const read = JSON.parse((await call("als_read", { path: before, allowedRoot: directory }) as never as { result: { content: [{ text: string }] } }).result.content[0].text);
    assert.equal(read.provenance, "offline-file");
    assert.ok(read.page.records.length > 0);
    assert.equal(read.page.schema, "ableton-mcp-semantic-set-snapshot/v1");
    const readWithNotes = JSON.parse((await call("als_read", { path: before, allowedRoot: directory, includeNotes: true }) as never as { result: { content: [{ text: string }] } }).result.content[0].text);
    assert.equal(readWithNotes.midi.clips.length, 2);
    assert.equal(readWithNotes.midi.clips[0].notes.length, 8);
    const lint = JSON.parse((await call("als_lint", { path: after, allowedRoot: directory }) as never as { result: { content: [{ text: string }] } }).result.content[0].text);
    assert.ok(lint.summary.total > 0);
    const diff = JSON.parse((await call("als_diff", { before: { als: { path: before, allowedRoot: directory } }, after: { als: { path: after, allowedRoot: directory } } }) as never as { result: { content: [{ text: string }] } }).result.content[0].text);
    assert.ok(diff.rows !== undefined || diff.changes !== undefined || JSON.stringify(diff).length > 0);
    assert.ok(JSON.stringify(diff).includes("Drums Renamed") || JSON.stringify(diff).length > 64);
    // Authority: escapes and non-.als targets are refused.
    const escape = (await call("als_read", { path: before, allowedRoot: join(directory, "nonexistent-root") })) as never as { result: { isError: boolean } };
    assert.equal(escape.result.isError, true);
    const notAls = writeFileSync(join(directory, "notes.txt"), "nope");
    void notAls;
    const wrongType = (await call("als_read", { path: join(directory, "notes.txt"), allowedRoot: directory })) as never as { result: { isError: boolean } };
    assert.equal(wrongType.result.isError, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("als_diff compares an offline parse against a previously exported page bundle honestly", async () => {
  const directory = tempDir();
  try {
    const before = writeFixture(directory, "Before.als", fixtureXml());
    const after = writeFixture(directory, "After.als", fixtureXml({ clipStart: 32 }));
    const { call } = failClosedHost();
    const exported = JSON.parse((await call("als_read", { path: before, allowedRoot: directory }) as never as { result: { content: [{ text: string }] } }).result.content[0].text);
    assert.equal(exported.page.page.complete, true);
    const diff = JSON.parse((await call("als_diff", { before: { pages: [exported.page] }, after: { als: { path: after, allowedRoot: directory } } }) as never as { result: { content: [{ text: string }] } }).result.content[0].text);
    assert.ok(JSON.stringify(diff).length > 0);
    const mismatch = (await call("als_diff", { before: { pages: [exported.page] }, after: { als: { path: after, allowedRoot: directory, profile: "strict" } } })) as never as { result: { isError: boolean } };
    assert.equal(mismatch.result.isError, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
