import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, link, lstat, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOwnedWaveFile, unlinkLateCaptureCompanions, unlinkOwnedCaptureFile } from "../src/audio-file.js";

function wave(samples: readonly number[], sampleRate = 48_000, channels = 1, bits = 24): Buffer {
  const sampleBytes = bits / 8;
  const dataLength = samples.length * sampleBytes;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataLength, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * sampleBytes, 28); buffer.writeUInt16LE(channels * sampleBytes, 32); buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataLength, 40);
  samples.forEach((sample, index) => {
    const integer = Math.max(-Math.pow(2, bits - 1), Math.min(Math.pow(2, bits - 1) - 1, Math.round(sample * Math.pow(2, bits - 1))));
    const offset = 44 + index * sampleBytes;
    if (bits === 16) buffer.writeInt16LE(integer, offset);
    else if (bits === 24) { const value = integer < 0 ? integer + 0x1000000 : integer; buffer[offset] = value & 0xff; buffer[offset + 1] = value >>> 8 & 0xff; buffer[offset + 2] = value >>> 16 & 0xff; }
    else buffer.writeInt32LE(integer, offset);
  });
  return buffer;
}

test("decodes and digest-fences one fresh transaction-owned WAV before unlink", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-capture-file-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const project = join(root, "Set.als"); const media = join(root, "Capture.wav");
  await writeFile(project, "set"); await writeFile(media, wave([0, 0.5, -0.5, 0.25])); await writeFile(`${media}.asd`, "analysis-sidecar"); await chmod(media, 0o600);
  const decoded = await decodeOwnedWaveFile(media, project, Date.now() - 1_000);
  assert.equal(decoded.sampleRate, 48_000); assert.equal(decoded.channels, 1); assert.equal(decoded.bitsPerSample, 24);
  assert.deepEqual([...decoded.samples].map((value) => Math.round(value * 100) / 100), [0, 0.5, -0.5, 0.25]);
  assert.match(decoded.sha256, /^[a-f0-9]{64}$/); assert.equal(decoded.basename, "Capture.wav"); assert.equal(decoded.companions.length, 1);
  assert.equal((await lstat(media)).isFile(), true); assert.equal((await lstat(`${media}.asd`)).isFile(), true);
  await unlinkOwnedCaptureFile(decoded);
  await assert.rejects(lstat(media)); await assert.rejects(lstat(`${media}.asd`));
});

test("rejects symlinks, paths outside the project boundary, stale files, and unsupported formats", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-capture-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "ableton-capture-outside-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  const project = join(root, "Set.als"); await writeFile(project, "set");
  const external = join(outside, "External.wav"); await writeFile(external, wave([0, 0]));
  await assert.rejects(decodeOwnedWaveFile(external, project, Date.now() - 1_000), /outside/);
  const linkPath = join(root, "Link.wav"); await symlink(external, linkPath);
  await assert.rejects(decodeOwnedWaveFile(linkPath, project, Date.now() - 1_000), /regular file/);
  const stale = join(root, "Stale.wav"); await writeFile(stale, wave([0, 0])); await utimes(stale, new Date(0), new Date(0));
  await assert.rejects(decodeOwnedWaveFile(stale, project, Date.now()), /predates/);
  const hardlinkSource = join(root, "Hardlink.wav"); const hardlinkAlias = join(root, "Hardlink-alias.wav");
  await writeFile(hardlinkSource, wave([0, 0])); await link(hardlinkSource, hardlinkAlias);
  await assert.rejects(decodeOwnedWaveFile(hardlinkSource, project, Date.now() - 1_000), /regular file/);
  const aiff = join(root, "Capture.aiff"); await writeFile(aiff, "FORM");
  await assert.rejects(decodeOwnedWaveFile(aiff, project, Date.now() - 1_000), /only.*WAV/);
});

test("discovers and removes a fresh ASD created after WAV acquisition", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-capture-late-asd-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const project = join(root, "Set.als"); const media = join(root, "Capture.wav");
  await writeFile(project, "set"); await writeFile(media, wave([0, 0.25]));
  const decoded = await decodeOwnedWaveFile(media, project, Date.now() - 1_000);
  assert.equal(decoded.companions.length, 0);
  await writeFile(`${media}.asd`, "late-analysis-sidecar");
  await unlinkOwnedCaptureFile(decoded);
  await assert.rejects(lstat(media)); await assert.rejects(lstat(`${media}.asd`));
});

test("removes an ASD that appears after primary WAV unlink and verifies stable absence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-capture-post-unlink-asd-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const project = join(root, "Set.als"); const media = join(root, "Capture.wav");
  await writeFile(project, "set"); await writeFile(media, wave([0, 0.25]));
  const decoded = await decodeOwnedWaveFile(media, project, Date.now() - 1_000);
  await unlinkOwnedCaptureFile(decoded);
  const delayedCreation = new Promise<void>((resolve, reject) => setTimeout(() => { void writeFile(`${media}.asd`, Buffer.alloc(128, 7)).then(() => resolve(), reject); }, 500));
  const removed = await unlinkLateCaptureCompanions(decoded);
  await delayedCreation;
  assert.equal(removed, 1);
  await assert.rejects(lstat(`${media}.asd`));
});

test("refuses unlink after media identity changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ableton-capture-change-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const project = join(root, "Set.als"); const media = join(root, "Capture.wav");
  await writeFile(project, "set"); await writeFile(media, wave([0, 0.25]));
  const decoded = await decodeOwnedWaveFile(media, project, Date.now() - 1_000);
  const changed = await readFile(decoded.realPath); const last = changed.length - 1; changed[last] = (changed[last] ?? 0) ^ 1; await writeFile(decoded.realPath, changed);
  await assert.rejects(unlinkOwnedCaptureFile(decoded), /identity changed|digest changed/);
});
