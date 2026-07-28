import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { projectBackup, projectInfo, projectLimitation } from "../src/project.js";

function liveSet(path: string, media: string[]): void {
  const refs = media.map((value) => `<FileRef><Path Value="${value}" /></FileRef>`).join("");
  writeFileSync(path, gzipSync(Buffer.from(`<Ableton><Track /><Track></Track><Scene /><Scene></Scene>${refs}</Ableton>`)));
}

test("reads bounded Live Set metadata and writes a verified colocated backup without reading media", () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-project-"));
  try {
    const existing = join(root, "audio.wav"); writeFileSync(existing, "not read by project metadata");
    const missing = join(root, "missing.wav");
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
    assert.throws(() => projectInfo(text), /\.als file/);
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
