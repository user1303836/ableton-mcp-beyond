import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { projectBackup, projectInfo, projectLimitation, projectSourceEvidence } from "../src/project.js";

function liveSet(path: string, media: string[]): void {
  const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const refs = media.map((value) => `<FileRef><Path Value="${escaped(value)}" /></FileRef>`).join("");
  writeFileSync(path, gzipSync(Buffer.from(`<Ableton><AudioTrack Id="1"></AudioTrack><MidiTrack Id="2"/><Scene /><Scene></Scene>${refs}</Ableton>`)));
}

test("reads bounded Live Set metadata and writes a verified colocated backup without reading media", () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-"));
  try {
    const existing = join(root, "audio & source.wav"); writeFileSync(existing, "not read by project metadata");
    const missing = join(root, "missing & source.wav");
    const set = join(root, "Song ü.als"); liveSet(set, [existing, missing, missing, "relative.wav"]);
    const info = projectInfo(set);
    assert.equal(info.exists, true); assert.equal(info.tracks, 2); assert.equal(info.scenes, 2); assert.equal(info.mediaRefs, 3);
    assert.deepEqual(info.missingMedia, [missing]); assert.match(info.sha256 ?? "", /^[a-f0-9]{64}$/);
    const backup = projectBackup(set, { allowedRoot: root, expectedSha256: info.sha256, expectedSize: info.size, expectedMtimeMs: info.mtimeMs });
    assert.equal(backup.verified, true); assert.equal(existsSync(backup.backup), true);
    assert.deepEqual(readFileSync(backup.backup), readFileSync(set)); assert.equal(backup.manifest.sha256, info.sha256);
    liveSet(set, []);
    assert.throws(() => projectBackup(set, { allowedRoot: root, expectedSha256: info.sha256, expectedSize: info.size, expectedMtimeMs: info.mtimeMs }), /changed since backup preview/);
    const otherRoot = mkdtempSync(join(tmpdir(), "ableton-project-other-"));
    try { assert.throws(() => projectBackup(set, { allowedRoot: otherRoot }), /outside the explicit backup allowlist/); } finally { rmSync(otherRoot, { recursive: true, force: true }); }
    assert.deepEqual(projectLimitation("save-as"), { available: false, operation: "save-as", reason: "save-as is not exposed by the Live Remote Script API in this Live version and is not fabricated", extensionPoint: "canonical project.new/open/save/save-as/collect/export/bounce operations are reserved for a future adapter and remain unadvertised until executable; project.info and project.backup are available now" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsafe, linked, wrong-extension, and malformed Live Set paths", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-invalid-"));
  try {
    const text = join(root, "set.txt"); writeFileSync(text, "plain");
    assert.throws(() => projectInfo("relative.als"), /absolute and safe/);
    assert.throws(() => projectInfo(`${root}\0unsafe.als`), /absolute and safe/);
    assert.throws(() => projectInfo(text), /\.als file/);
    const directorySet = join(root, "directory.als"); mkdirSync(directorySet);
    assert.throws(() => projectInfo(directorySet), /not a regular file/);
    const oversized = join(root, "oversized.als"); writeFileSync(oversized, ""); truncateSync(oversized, 64 * 1024 * 1024 + 1);
    assert.throws(() => projectInfo(oversized), /bounded size/);
    const malformed = join(root, "bad.als"); writeFileSync(malformed, "not gzip");
    assert.throws(() => projectInfo(malformed), /valid gzip-compressed Live set/);
    const bomb = join(root, "bounded.als"); writeFileSync(bomb, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
    assert.throws(() => projectInfo(bomb), /decompressed set exceeds the bounded size/);
    if (process.platform !== "win32") {
      const linked = join(root, "linked.als"); symlinkSync(malformed, linked);
      assert.throws(() => projectInfo(linked), /symbolic link/);
    } else context.diagnostic("symbolic-link fixture requires optional Windows privilege");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reads bounded semantic source evidence without guessing relative FileRefs", () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-evidence-"));
  try {
    const set = join(root, "evidence.als"); const absolute = join(root, "missing.wav");
    writeFileSync(set, gzipSync(Buffer.from(`<Ableton Creator="Ableton Live 12" MajorVersion="5" MinorVersion="12.1" SchemaChangeCount="3"><FileRef><Path Value="relative.wav"/></FileRef><FileRef><Path Value="${absolute}"/></FileRef></Ableton>`)));
    const before = readFileSync(set); const evidence = projectSourceEvidence(set);
    assert.deepEqual(evidence.ableton, { creator: "Ableton Live 12", majorVersion: "5", minorVersion: "12.1", schemaChangeCount: "3" });
    assert.deepEqual(evidence.references.find((row) => row.value === "relative.wav"), { value: "relative.wav", resolution: "unresolved" });
    assert.equal(evidence.references.find((row) => row.value === absolute)?.exists, false); assert.deepEqual(readFileSync(set), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounds FileRef probes, blocks network/device references, and identifies project symlinks conservatively", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-ref-bounds-"));
  try {
    const project = join(root, "Project"); mkdirSync(project); const outside = join(root, "outside.wav"); writeFileSync(outside, "not read");
    const linked = join(project, "linked.wav"); if (process.platform !== "win32") symlinkSync(outside, linked); else context.diagnostic("symlink classification fixture skipped on Windows");
    const refs = Array.from({ length: 4_100 }, (_, index) => `/definitely-missing/ref-${index}.wav`); refs.unshift("\\\\attacker\\share\\sample.wav", "\\\\?\\C:\\device\\sample.wav"); if (process.platform !== "win32") refs.unshift(linked);
    const set = join(project, "bounded.als"); liveSet(set, refs); const evidence = projectSourceEvidence(set);
    assert.equal(evidence.referenceBounds.observed, 4097); assert.equal(evidence.referenceBounds.observedKind, "lower-bound"); assert.equal(evidence.referenceBounds.included, 4096); assert.equal(evidence.referenceBounds.complete, false); assert.equal(evidence.referenceBounds.omitted, 1);
    assert.ok(evidence.references.some((reference) => reference.resolution === "network" && reference.value.startsWith("network-")));
    if (process.platform !== "win32") assert.equal(evidence.references.find((reference) => reference.resolvedPath === linked)?.projectLocal, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stops FileRef observation after the first overflow without retaining the remaining unique paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-many-refs-"));
  try {
    const set = join(root, "many.als"); const refs = Array.from({ length: 20_000 }, (_, index) => `<FileRef><Path Value="/missing/${index}.wav" /></FileRef>`).join("");
    writeFileSync(set, gzipSync(Buffer.from(`<Ableton>${refs}</Ableton>`)));
    const started = Date.now(); const evidence = projectSourceEvidence(set);
    assert.equal(evidence.references.length, 4096); assert.deepEqual(evidence.referenceBounds, { observed: 4097, observedKind: "lower-bound", included: 4096, omitted: 1, complete: false }); assert.equal(evidence.manifest.mediaRefs, 4097); assert.ok(Date.now() - started < 5_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decodes numeric XML path entities and validates backup allowlist roots", () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-entities-"));
  try {
    const set = join(root, "entities.als");
    const missing = join(root, "missing'A.wav");
    const encoded = missing.replace("/", "&#47;").replaceAll("/", "&#x2f;").replace("'", "&apos;").replace("A", "&#65;");
    writeFileSync(set, gzipSync(Buffer.from(`<Ableton><FileRef><Path Value="${encoded}" /></FileRef></Ableton>`)));
    assert.deepEqual(projectInfo(set).missingMedia, [missing]);

    assert.throws(() => projectBackup(set, { allowedRoot: "relative" }), /absolute safe directory/);
    const rootFile = join(root, "not-directory"); writeFileSync(rootFile, "x");
    assert.throws(() => projectBackup(set, { allowedRoot: rootFile }), /real directory/);

    const invalidEntity = join(root, "invalid-entity.als");
    writeFileSync(invalidEntity, gzipSync(Buffer.from('<Ableton><FileRef><Path Value="/tmp/&#xD800;.wav" /></FileRef></Ableton>')));
    assert.throws(() => projectInfo(invalidEntity), /invalid XML path entity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
