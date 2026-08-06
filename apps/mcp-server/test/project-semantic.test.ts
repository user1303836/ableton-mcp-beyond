import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { DeterministicLiveSimulator, type LiveSnapshot } from "../src/live.js";
import { projectSourceEvidence } from "../src/project.js";
import {
  SEMANTIC_PROJECT_MAX_BUNDLE_BYTES,
  SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES,
  SEMANTIC_PROJECT_MAX_PAGE_BYTES,
  assembleSemanticProjectPages,
  canonicalSemanticJson,
  compareSemanticStrings,
  createSemanticProjectSnapshot,
  pageSemanticProjectSnapshot,
  validateSemanticProjectArtifact,
  type SemanticProjectPage,
  type SemanticPrivacyProfile,
} from "../src/project-semantic.js";

function options(profile: SemanticPrivacyProfile = "collaboration") {
  return { profile, exporterVersion: "test", live: { protocol: "ableton-live/v1", adapter: "simulator" as const, provenance: "simulator" as const, registryHash: "a".repeat(64) } };
}

function pagesFor(snapshot: ReturnType<typeof createSemanticProjectSnapshot>, limit: number): SemanticProjectPage[] {
  const pages: SemanticProjectPage[] = []; let cursor: string | undefined;
  do { const page = pageSemanticProjectSnapshot(snapshot, { limit, ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.page.nextCursor; } while (cursor);
  return pages;
}

function rehashArtifact(artifact: any): void {
  const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalSemanticJson(value)).digest("hex")}`;
  for (const record of artifact.records) {
    record.contentFingerprint = hash({ kind: record.kind, name: record.name ?? null, data: record.data }); record.semanticFingerprint = hash(record.matching); record.nameFingerprint = hash([record.kind, record.name ?? null]);
  }
  for (const section of Object.keys(artifact.manifest)) artifact.manifest[section].digest = hash(artifact.records.filter((record: any) => record.section === section));
  artifact.artifact.semanticHash = hash({ schema: artifact.schema, policy: artifact.policy, set: artifact.set, manifest: artifact.manifest, safety: artifact.safety, records: artifact.records });
  artifact.artifact.id = hash({ schema: artifact.schema, exporterVersion: artifact.artifact.exporterVersion, semanticHash: artifact.artifact.semanticHash, policy: artifact.policy, provenance: artifact.provenance, set: artifact.set, manifest: artifact.manifest, safety: artifact.safety, records: artifact.records });
}

test("exports deterministic semantic state while ignoring refs, identities, epochs, revisions, and note ids", () => {
  const simulator = new DeterministicLiveSimulator(); const first = simulator.snapshot(); const second = structuredClone(first) as LiveSnapshot;
  second.set.ref = "99:set:changed"; second.set.objectIdentity = "changed"; second.playback.epoch = 999; second.playback.revision = "changed";
  second.tracks[0]!.ref = "99:track:changed"; second.tracks[0]!.objectIdentity = "changed"; second.tracks[0]!.clips[0]!.ref = "99:clip:changed"; second.tracks[0]!.clips[0]!.objectIdentity = "changed"; second.tracks[0]!.clips[0]!.notes[0]!.id = 999;
  second.tracks[0]!.clipSlots![0]!.parentRef = second.tracks[0]!.ref; second.tracks[0]!.clipSlots![0]!.clipRef = second.tracks[0]!.clips[0]!.ref;
  (second.set as any).confirmation = "REUSABLE-CONFIRMATION"; (second.tracks[0] as any).authorityToken = "REUSABLE-AUTHORITY"; (second.tracks[0]!.devices[0] as any).secret = "REUSABLE-SECRET";
  const a = createSemanticProjectSnapshot(first, options()); const b = createSemanticProjectSnapshot(second, options());
  assert.equal(a.artifact.id, b.artifact.id); assert.equal(canonicalSemanticJson(a), canonicalSemanticJson(b));
  const output = canonicalSemanticJson(b); for (const sentinel of ["99:set:changed", "99:track:changed", "99:clip:changed", "objectIdentity", "\"epoch\"", "\"revision\"", "REUSABLE-CONFIRMATION", "REUSABLE-AUTHORITY", "REUSABLE-SECRET"]) assert.equal(output.includes(sentinel), false, sentinel);
  validateSemanticProjectArtifact(a);
});

test("bundle and combined diff-input bounds reserve space below the transport frame", () => {
  assert.equal(SEMANTIC_PROJECT_MAX_BUNDLE_BYTES, 24 * 1024 * 1024); assert.equal(SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES, 50 * 1024 * 1024);
  assert.ok(SEMANTIC_PROJECT_MAX_BUNDLE_BYTES * 2 < SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES); assert.ok(SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES < 64 * 1024 * 1024);
});

test("pages losslessly within byte/record bounds and rejects cursor and page tampering", () => {
  const artifact = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), options());
  const pages = pagesFor(artifact, 2); assert.ok(pages.length > 2);
  for (const page of pages) { assert.ok(page.records.length <= 2); assert.ok(Buffer.byteLength(canonicalSemanticJson(page)) <= SEMANTIC_PROJECT_MAX_PAGE_BYTES); assert.equal(page.safety.containsMutationAuthority, false); }
  assert.deepEqual(assembleSemanticProjectPages(pages), artifact);
  assert.throws(() => assembleSemanticProjectPages([...pages].reverse()), /reordered|non-contiguous/);
  const badCursor = pages[0]!.page.nextCursor!.slice(0, -1) + "A";
  assert.throws(() => pageSemanticProjectSnapshot(artifact, { cursor: badCursor }), /cursor/);
  const missing = pages.filter((_, index) => index !== 1); assert.throws(() => assembleSemanticProjectPages(missing), /inconsistent|incomplete|non-contiguous/);
  const cursorTampered = structuredClone(pages); cursorTampered[0]!.page.nextCursor = "tampered"; assert.throws(() => assembleSemanticProjectPages(cursorTampered), /tampered/);
  const openSchema = structuredClone(pages) as any[]; openSchema[0].unexpected = true; assert.throws(() => assembleSemanticProjectPages(openSchema), /unknown or malformed/);
  const tampered = structuredClone(pages); tampered[0]!.records[0]!.data.kind = "tampered";
  assert.throws(() => assembleSemanticProjectPages(tampered), /digest|manifest|unknown or malformed/);
});

test("large snapshots are independently paged and explicitly truncated", () => {
  const snapshot = new DeterministicLiveSimulator().snapshot(); const base = snapshot.tracks[0]!;
  snapshot.tracks = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(base), ref: `track:large-${index}` as any, objectIdentity: `identity-${index}`, name: `Track ${index}`, clips: [], clipSlots: [], devices: [] }));
  const artifact = createSemanticProjectSnapshot(snapshot, { ...options(), maxRecords: 120 });
  assert.equal(artifact.manifest.tracks.observed, 500); assert.equal(artifact.manifest.tracks.included, 119); assert.equal(artifact.manifest.tracks.complete, false); assert.equal(artifact.manifest.tracks.omitted, 381);
  const pages = pagesFor(artifact, 17); assert.ok(pages.length > 5); assert.equal(assembleSemanticProjectPages(pages).artifact.id, artifact.artifact.id);
});

test("privacy profiles never export absolute paths and strict aliases names", () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-private-"));
  try {
    const media = join(root, "User Library", "secret-user", "Kick.wav");
    const set = join(root, "Secret Set.als");
    writeFileSync(set, gzipSync(Buffer.from(`<Ableton Creator="Ableton Live 12" MajorVersion="5" MinorVersion="12.1"><AudioTrack/><FileRef><Path Value="${media}"/></FileRef></Ableton>`)));
    const source = projectSourceEvidence(set); const snapshot = new DeterministicLiveSimulator().snapshot(); snapshot.set.name = "Secret Set"; snapshot.set.filePath = set;
    for (const profile of ["strict", "collaboration", "local"] as const) {
      const artifact = createSemanticProjectSnapshot(snapshot, { ...options(profile), projectPath: set, sourceEvidence: source }); const output = canonicalSemanticJson(artifact);
      assert.equal(output.includes(root), false, profile);
      assert.equal(artifact.policy.profile, profile);
      assert.equal(artifact.provenance.ableton?.minorVersion, "12.1");
      assert.equal(artifact.provenance.live.version, undefined, "saved Set version is not active Live provenance");
      assert.ok(artifact.records.some((record) => record.kind === "unavailable" && record.data.field === "live-version"));
      if (profile === "strict") assert.equal(output.includes("Secret Set"), false);
      if (profile === "collaboration") assert.equal(output.includes("Secret Set"), true);
    }
    assert.deepEqual(readFileSync(set), gzipSync(Buffer.from(`<Ableton Creator="Ableton Live 12" MajorVersion="5" MinorVersion="12.1"><AudioTrack/><FileRef><Path Value="${media}"/></FileRef></Ableton>`)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("network URI media locators are typed digests under every privacy profile", () => {
  for (const profile of ["strict", "collaboration", "local"] as const) for (const uri of ["https://private.example", "smb://corp", "nfs://studio/export/"]) {
    const snapshot = new DeterministicLiveSimulator().snapshot(); snapshot.tracks[0]!.clips[0]!.filePath = uri;
    const artifact = createSemanticProjectSnapshot(snapshot, options(profile)); const output = canonicalSemanticJson(artifact);
    assert.equal(output.includes(uri), false, `${profile}: ${uri}`);
    for (const authority of ["private.example", "corp", "studio"]) assert.equal(output.includes(authority), false, `${profile}: ${authority}`);
    const dependency = artifact.records.find((record) => record.kind === "dependency" && record.data.evidence === "live-clip");
    assert.match(String(dependency?.data.locator), /^network-[a-f0-9]{20}$/); assert.equal(dependency?.data.classificationEvidence, "network-reference-blocked"); assert.equal(dependency?.data.stateVisibility, "opaque");
  }
});

test("dependency manifest distinguishes missing, external, Pack, User Library, plug-in, Max, and opaque state", () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-deps-")); const project = join(root, "project");
  try {
    const external = join(root, "outside", "present.wav"); const missingPack = join(root, "Packs", "Demo", "missing.wav"); const user = join(root, "User Library", "Samples", "missing.wav");
    const set = join(project, "Set.als");
    mkdirSync(project);
    writeFileSync(set, gzipSync(Buffer.from(`<Ableton><FileRef><Path Value="${external}"/></FileRef><FileRef><Path Value="${missingPack}"/></FileRef><FileRef><Path Value="${user}"/></FileRef><FileRef><Path Value="opaque:reference"/></FileRef></Ableton>`)));
    const snapshot = new DeterministicLiveSimulator().snapshot(); snapshot.set.filePath = set;
    snapshot.tracks[0]!.devices.push({ ref: "device:plugin" as any, name: "Test Plug-in", kind: "plugin", className: "VstPluginDevice", parameters: [], plugin: { presets: ["A"], selectedPresetIndex: 0 } }, { ref: "device:max" as any, name: "Test Max", kind: "device", className: "MxDeviceAudioEffect", parameters: [], maxDevice: { audioIns: ["in"], audioOuts: ["out"] } });
    const artifact = createSemanticProjectSnapshot(snapshot, { ...options(), projectPath: set }); const deps = artifact.records.filter((record) => record.section === "dependencies").map((record) => record.data);
    assert.ok(deps.some((row) => row.origin === "external")); assert.ok(deps.some((row) => row.origin === "pack" && row.availability === "missing")); assert.ok(deps.some((row) => row.origin === "user-library"));
    assert.ok(deps.some((row) => row.category === "plug-in" && row.stateVisibility === "opaque")); assert.ok(deps.some((row) => row.category === "max-device" && row.stateVisibility === "opaque")); assert.ok(deps.some((row) => row.origin === "unknown" && row.stateVisibility === "opaque"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsaved snapshots expose live-only provenance and explicit unavailable evidence", () => {
  const artifact = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), options("strict"));
  assert.equal(artifact.provenance.source, "live-only"); assert.equal(artifact.provenance.live.version, undefined);
  const unavailable = artifact.records.filter((record) => record.section === "unavailable").map((record) => record.data.field);
  assert.ok(unavailable.includes("set-file-provenance")); assert.ok(unavailable.includes("live-version")); assert.ok(unavailable.includes("dependency-manifest")); assert.ok(unavailable.includes("audio-content-hash"));

  const reported = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), { ...options(), live: { ...options().live, version: "12.2" } });
  assert.equal(reported.provenance.live.version, "12.2"); assert.equal(reported.records.some((record) => record.kind === "unavailable" && record.data.field === "live-version"), false);
});

test("canonical serializer uses fixed Unicode ordering and enforces pre-allocation container bounds", () => {
  assert.equal(canonicalSemanticJson({ b: -0, a: 1 }), '{"a":1,"b":0}');
  assert.ok(compareSemanticStrings("z", "ä") < 0); assert.ok(compareSemanticStrings("ä", "z") > 0);
  const snapshot = new DeterministicLiveSimulator().snapshot(); const device = snapshot.tracks[0]!.devices[0]!;
  device.parameters = [{ ref: "p:z" as any, name: "z", value: 1, min: 0, max: 1, automatable: true }, { ref: "p:umlaut" as any, name: "ä", value: 1, min: 0, max: 1, automatable: true }];
  const first = createSemanticProjectSnapshot(snapshot, options()); device.parameters.reverse(); const second = createSemanticProjectSnapshot(snapshot, options()); assert.equal(first.artifact.id, second.artifact.id);
  assert.throws(() => canonicalSemanticJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalSemanticJson({ value: undefined }), /unsupported/);
  assert.throws(() => canonicalSemanticJson(Array.from({ length: 24_001 }, () => null)), /array/);
  assert.throws(() => canonicalSemanticJson(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, null]))), /field/);
  assert.throws(() => canonicalSemanticJson({ ["k".repeat(129)]: null }), /key/);
  let deep: any = {}; let cursor = deep; for (let index = 0; index < 30; index += 1) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => canonicalSemanticJson(deep), /depth/);
});

test("deep device truncation counts every skipped descendant and marks the section incomplete", () => {
  const snapshot = new DeterministicLiveSimulator().snapshot();
  const make = (depth: number): any => ({ ref: `device:${depth}`, name: `Device ${depth}`, kind: "rack", className: "InstrumentGroupDevice", parameters: [], chains: depth < 10 ? [{ ref: `chain:${depth}`, parentRef: `device:${depth}`, index: 0, name: "Chain", mute: false, solo: false, devices: [make(depth + 1)] }] : [] });
  snapshot.tracks[0]!.devices = [make(0)];
  const before = createSemanticProjectSnapshot(snapshot, options()); assert.equal(before.manifest.devices.observed, 11); assert.equal(before.manifest.devices.included, 9); assert.equal(before.manifest.devices.omitted, 2); assert.equal(before.manifest.devices.complete, false);
  let depthEight = snapshot.tracks[0]!.devices[0]!; for (let depth = 0; depth < 8; depth += 1) depthEight = depthEight.chains![0]!.devices[0]!; depthEight.chains = [];
  const after = createSemanticProjectSnapshot(snapshot, options()); assert.notEqual(before.artifact.id, after.artifact.id); assert.equal(after.manifest.devices.observed, 9); assert.equal(after.manifest.devices.complete, true);
});

test("pagination rejects an unassemblable small-limit plan and validates every repeated header", () => {
  const snapshot = new DeterministicLiveSimulator().snapshot(); const base = snapshot.tracks[0]!;
  snapshot.tracks = Array.from({ length: 520 }, (_, index) => ({ ...structuredClone(base), ref: `track:page-${index}` as any, name: `Track ${index}`, clips: [], clipSlots: [], devices: [] }));
  const artifact = createSemanticProjectSnapshot(snapshot, options()); assert.throws(() => pageSemanticProjectSnapshot(artifact, { limit: 1 }), /too small/);
  const first = pageSemanticProjectSnapshot(artifact, { limit: 2 }); const second = pageSemanticProjectSnapshot(artifact, { limit: 2, cursor: first.page.nextCursor }); const changed = structuredClone([first, second]); changed[1]!.safety = { ...changed[1]!.safety, readOnly: false as true };
  assert.throws(() => assembleSemanticProjectPages(changed), /inconsistent|tampered/);
  for (const page of [first, second]) assert.ok(Buffer.byteLength(canonicalSemanticJson(page)) <= SEMANTIC_PROJECT_MAX_PAGE_BYTES);
});

test("closed runtime schema rejects publicly rehashed malformed headers, records, IDs, refs, and completeness", () => {
  const mutateCases: Array<[string, (artifact: any) => void]> = [
    ["source enum", (value) => { value.provenance.source = "attacker"; }],
    ["adapter type", (value) => { value.provenance.live.adapter = 7; }],
    ["limitations type", (value) => { value.provenance.limitations = { attacker: true }; }],
    ["Set name type", (value) => { value.set.name = 7; }],
    ["privacy tuple", (value) => { value.policy = { profile: "strict", names: "retained", paths: "basenames" }; }],
    ["duplicate snapshot ID", (value) => { value.records[1].snapshotId = value.records[0].snapshotId; }],
    ["record name type", (value) => { value.records.find((record: any) => record.kind === "track").name = { attacker: true }; }],
    ["negative clip count", (value) => { value.records.find((record: any) => record.kind === "track").data.clipCount = -1; }],
    ["armed object", (value) => { value.records.find((record: any) => record.kind === "track").data.armed = { attacker: true }; }],
    ["Live reference value", (value) => { value.records.find((record: any) => record.kind === "unavailable").data.reason = "99:track:LIVE-REF"; }],
    ["false completeness", (value) => { const manifest = Object.values(value.manifest).find((row: any) => row.omitted === 0) as any; manifest.complete = false; }],
  ];
  for (const [label, mutate] of mutateCases) {
    const value = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), options()) as any; mutate(value); rehashArtifact(value);
    assert.throws(() => validateSemanticProjectArtifact(value), { name: "Error" }, label);
  }
});

test("privacy sanitizes every dynamic string and rejects a publicly rehashed malicious nested bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-adversarial-"));
  try {
    const set = join(root, "Set.als"); writeFileSync(set, gzipSync(Buffer.from('<Ableton Creator="/Users/alice C:\\\\Secret \\\\\\\\corp\\\\share file:///private/x" MajorVersion="REUSABLE-MUTATION-TOKEN"><AudioTrack/></Ableton>')));
    const snapshot = new DeterministicLiveSimulator().snapshot(); snapshot.set.name = "/Users/alice/Secret.als"; snapshot.tracks[0]!.name = "https://private.example/track"; snapshot.scenes[0]!.name = "C:\\Users\\alice\\Scene"; snapshot.tracks[0]!.clips[0]!.name = "smb://corp/share/clip"; snapshot.tracks[0]!.devices[0]!.name = "nfs://studio/device"; snapshot.tracks[0]!.routing = { inputType: "42:clip_slot:0:0", inputSubRouting: "REUSABLE-MUTATION-TOKEN", outputType: "\\\\corp\\share", outputSubRouting: "file:///private/out", availableInputTypes: 0, availableInputChannels: 0, availableOutputTypes: 0, availableOutputChannels: 0 };
    for (const profile of ["strict", "collaboration", "local"] as const) {
      const exported = createSemanticProjectSnapshot(snapshot, { ...options(profile), projectPath: set, sourceEvidence: projectSourceEvidence(set) }); const output = canonicalSemanticJson(exported);
      for (const sentinel of ["/Users/alice", "C:\\\\Users", "\\\\corp", "file:///", "https://private.example", "smb://corp", "nfs://studio", "REUSABLE-MUTATION-TOKEN", "42:clip_slot:0:0"]) assert.equal(output.includes(sentinel), false, `${profile}: ${sentinel}`);
      validateSemanticProjectArtifact(exported);
    }
    const malicious = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), options()) as any; const track = malicious.records.find((record: any) => record.kind === "track");
    track.data.routing.sessionRef = "99:track:LIVE-REF"; track.data.routing.accessToken = "REUSABLE-MUTATION-TOKEN"; track.data.routing.inputType = "/Users/alice/Secret.wav";
    const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalSemanticJson(value)).digest("hex")}`;
    track.contentFingerprint = hash({ kind: track.kind, name: track.name ?? null, data: track.data }); malicious.manifest.tracks.digest = hash(malicious.records.filter((record: any) => record.section === "tracks"));
    malicious.artifact.semanticHash = hash({ schema: malicious.schema, policy: malicious.policy, set: malicious.set, manifest: malicious.manifest, safety: malicious.safety, records: malicious.records });
    malicious.artifact.id = hash({ schema: malicious.schema, exporterVersion: malicious.artifact.exporterVersion, semanticHash: malicious.artifact.semanticHash, policy: malicious.policy, provenance: malicious.provenance, set: malicious.set, manifest: malicious.manifest, safety: malicious.safety, records: malicious.records });
    assert.throws(() => validateSemanticProjectArtifact(malicious), /unknown|forbidden|absolute|authority/);

    const compositeRef = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), options()) as any; const compositeTrack = compositeRef.records.find((record: any) => record.kind === "track");
    compositeTrack.data.routing.inputType = "42:clip_slot:0:0"; rehashArtifact(compositeRef);
    assert.throws(() => validateSemanticProjectArtifact(compositeRef), /session reference-like/);

    for (const uri of ["https://private.example/media.wav", "smb://corp/share/media.wav", "nfs://studio/export/media.wav"]) {
      const networkUri = createSemanticProjectSnapshot(new DeterministicLiveSimulator().snapshot(), options()) as any; const networkTrack = networkUri.records.find((record: any) => record.kind === "track");
      networkTrack.data.routing.inputType = uri; rehashArtifact(networkUri);
      assert.throws(() => validateSemanticProjectArtifact(networkUri), /absolute, network, device, or file-URI path/, uri);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
