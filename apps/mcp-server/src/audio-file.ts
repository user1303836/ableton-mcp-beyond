import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const MAX_CAPTURE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_CAPTURE_SECONDS = 12;
export const MAX_CAPTURE_CHANNELS = 2;

interface FileIdentity {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

interface OwnedFile {
  realPath: string;
  sha256: string;
  stat: FileIdentity;
}

export interface DecodedCaptureFile {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  format: "wav-pcm" | "wav-float";
  bitsPerSample: number;
  sha256: string;
  byteLength: number;
  basename: string;
  realPath: string;
  stat: FileIdentity;
  companions: OwnedFile[];
}

interface OpenCandidate {
  originalPath: string;
  handle: FileHandle;
  stat: FileIdentity;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function allowedRoots(projectFilePath: string): Promise<string[]> {
  const projectDirectory = await realpath(dirname(projectFilePath));
  const roots = [projectDirectory];
  // Live Sets directly under User Library/Projects conventionally place new
  // recordings under the narrow Samples/Recorded subtree. Never authorize the
  // entire User Library namespace.
  if (basename(projectDirectory).toLocaleLowerCase("en-US") === "projects") {
    try { roots.push(await realpath(join(dirname(projectDirectory), "Samples", "Recorded"))); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  return roots;
}

function identity(stat: { size: number; mtimeMs: number; birthtimeMs: number; dev: number; ino: number; nlink: number }): FileIdentity {
  return { size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

function sameIdentity(left: FileIdentity, right: FileIdentity, includeTimes = true): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size && (!includeTimes || left.mtimeMs === right.mtimeMs);
}

async function openVerifiedCandidate(filePath: string, maximumBytes: number, captureStartedAtMs: number, label: string, writable = false): Promise<OpenCandidate> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < (label === "media" ? 44 : 0) || before.size > maximumBytes) throw new Error(`capture ${label} must be one fresh bounded regular file`);
  // mtime is the cross-platform write freshness signal. Birth time cannot be
  // rewritten by utimes on Windows and would let an old untouched file appear
  // fresh merely because it was copied/created recently.
  if (before.mtimeMs < captureStartedAtMs - 5_000) throw new Error(`capture ${label} predates the authorized capture lifecycle`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow);
  try {
    const opened = await handle.stat();
    const pathStat = await lstat(filePath);
    const openedIdentity = identity(opened);
    if (!opened.isFile() || opened.isSymbolicLink() || !sameIdentity(openedIdentity, identity(pathStat))) throw new Error(`capture ${label} identity changed while it was opened`);
    return { originalPath: filePath, handle, stat: openedIdentity };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

function uint24le(buffer: Buffer, offset: number): number {
  const unsigned = buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
  return unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
}

export async function decodeOwnedWaveFile(filePath: string, projectFilePath: string, captureStartedAtMs: number): Promise<DecodedCaptureFile> {
  if (typeof filePath !== "string" || !isAbsolute(filePath) || filePath.length > 4_096 || extname(filePath).toLocaleLowerCase("en-US") !== ".wav") throw new Error("capture provider currently accepts only one absolute bounded WAV media file");
  const requested = await lstat(filePath);
  if (!requested.isFile() || requested.isSymbolicLink()) throw new Error("capture media must be one fresh bounded regular file");
  const actualPath = await realpath(filePath);
  const roots = await allowedRoots(projectFilePath);
  if (!roots.some((root) => within(root, actualPath))) throw new Error("capture media path is outside the saved Live project boundary");

  const media = await openVerifiedCandidate(actualPath, MAX_CAPTURE_FILE_BYTES, captureStartedAtMs, "media");
  let companion: OpenCandidate | undefined;
  try {
    try { companion = await openVerifiedCandidate(`${actualPath}.asd`, 4 * 1024 * 1024, captureStartedAtMs, "companion"); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    const bytes = await media.handle.readFile();
    const after = identity(await media.handle.stat());
    if (!sameIdentity(media.stat, after)) throw new Error("capture media changed while it was acquired");
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("capture media is not a supported RIFF/WAVE file");

    let format: number | undefined;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let blockAlign: number | undefined;
    let bitsPerSample: number | undefined;
    let dataOffset: number | undefined;
    let dataLength: number | undefined;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const id = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      const end = start + length;
      if (end > bytes.length) throw new Error("capture WAV contains a truncated chunk");
      if (id === "fmt ") {
        if (length < 16) throw new Error("capture WAV format chunk is too short");
        format = bytes.readUInt16LE(start);
        channels = bytes.readUInt16LE(start + 2);
        sampleRate = bytes.readUInt32LE(start + 4);
        blockAlign = bytes.readUInt16LE(start + 12);
        bitsPerSample = bytes.readUInt16LE(start + 14);
        if (format === 0xfffe && length >= 40) format = bytes.readUInt16LE(start + 24);
      } else if (id === "data" && dataOffset === undefined) {
        dataOffset = start;
        dataLength = length;
      }
      offset = end + (length % 2);
    }
    if ((format !== 1 && format !== 3) || channels === undefined || sampleRate === undefined || blockAlign === undefined || bitsPerSample === undefined || dataOffset === undefined || dataLength === undefined) throw new Error("capture WAV format or data is unsupported");
    if (!Number.isInteger(channels) || channels < 1 || channels > MAX_CAPTURE_CHANNELS || !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) throw new Error("capture WAV channel count or sample rate is outside bounds");
    const expectedBytes = bitsPerSample / 8;
    if (!Number.isInteger(expectedBytes) || ![2, 3, 4].includes(expectedBytes) || blockAlign !== channels * expectedBytes || dataLength % blockAlign !== 0) throw new Error("capture WAV sample packing is unsupported");
    if (format === 3 && bitsPerSample !== 32) throw new Error("capture WAV float format must be 32-bit");
    if (format === 1 && ![16, 24, 32].includes(bitsPerSample)) throw new Error("capture WAV PCM width is unsupported");
    const frameCount = dataLength / blockAlign;
    const durationSeconds = frameCount / sampleRate;
    if (!(durationSeconds > 0) || durationSeconds > MAX_CAPTURE_SECONDS || frameCount * channels > 10_000_000) throw new Error("capture WAV duration exceeds the ephemeral analysis bound");
    const samples = new Float32Array(frameCount * channels);
    for (let index = 0; index < samples.length; index += 1) {
      const offset = dataOffset + index * expectedBytes;
      const value = format === 3 ? bytes.readFloatLE(offset)
        : bitsPerSample === 16 ? bytes.readInt16LE(offset) / 0x8000
        : bitsPerSample === 24 ? uint24le(bytes, offset) / 0x800000
        : bytes.readInt32LE(offset) / 0x80000000;
      if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error("capture WAV contains non-finite or non-normalized samples");
      samples[index] = value;
    }
    const companions: OwnedFile[] = [];
    if (companion) {
      const companionBytes = await companion.handle.readFile();
      const companionAfter = identity(await companion.handle.stat());
      if (!sameIdentity(companion.stat, companionAfter)) throw new Error("capture companion changed while it was acquired");
      companions.push({ realPath: companion.originalPath, sha256: createHash("sha256").update(companionBytes).digest("hex"), stat: companionAfter });
    }
    return {
      samples,
      sampleRate,
      channels,
      durationSeconds,
      format: format === 3 ? "wav-float" : "wav-pcm",
      bitsPerSample,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      basename: basename(actualPath),
      realPath: actualPath,
      stat: after,
      companions,
    };
  } finally {
    await media.handle.close();
    if (companion) await companion.handle.close();
  }
}

export async function captureMediaIsAbsent(filePath: string, projectFilePath: string): Promise<boolean> {
  if (typeof filePath !== "string" || !isAbsolute(filePath) || filePath.length > 4_096 || extname(filePath).toLocaleLowerCase("en-US") !== ".wav") throw new Error("capture absence check requires one absolute WAV path");
  const parent = await realpath(dirname(filePath));
  const candidate = join(parent, basename(filePath));
  const roots = await allowedRoots(projectFilePath);
  if (!roots.some((root) => within(root, candidate))) throw new Error("capture absence path is outside the saved Live project boundary");
  for (const path of [candidate, `${candidate}.asd`]) {
    try { await lstat(path); return false; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  // A process killed between quarantine rename and unlink leaves this private
  // marker directory. Treat it as residual, never as proof that raw media is
  // gone merely because the original pathname is absent.
  const entries = await readdir(parent, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(".ableton-mcp-capture-"))) return false;
  return true;
}

async function quarantineAndUnlinkTargets(targets: OwnedFile[], anchorPath: string): Promise<void> {
  if (targets.length === 0 || !targets.every((target) => dirname(target.realPath) === dirname(anchorPath))) throw new Error("capture companion directory identity is invalid");
  const opened: Array<{ target: OwnedFile; handle: FileHandle; quarantinePath?: string }> = [];
  let quarantineDirectory: string | undefined;
  try {
    for (const target of targets) {
      const companion = extname(target.realPath).toLocaleLowerCase("en-US") === ".asd";
      const candidate = await openVerifiedCandidate(target.realPath, companion ? 4 * 1024 * 1024 : MAX_CAPTURE_FILE_BYTES, Math.max(0, target.stat.birthtimeMs - 1), companion ? "companion" : "media", true);
      opened.push({ target, handle: candidate.handle });
      if (!sameIdentity(identity(await candidate.handle.stat()), target.stat)) throw new Error("capture media identity changed before unlink");
      const bytes = await candidate.handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== target.sha256) throw new Error("capture media digest changed before unlink");
    }
    quarantineDirectory = await mkdtemp(join(dirname(anchorPath), ".ableton-mcp-capture-"));
    await chmod(quarantineDirectory, 0o700);
    for (const [index, entry] of opened.entries()) {
      const quarantinePath = join(quarantineDirectory, `capture-${index}${extname(entry.target.realPath).toLocaleLowerCase("en-US") === ".asd" ? ".asd" : ".wav"}`);
      await rename(entry.target.realPath, quarantinePath);
      entry.quarantinePath = quarantinePath;
      if (!sameIdentity(identity(await entry.handle.stat()), identity(await lstat(quarantinePath)))) throw new Error("capture media identity changed during private quarantine");
    }
    for (const entry of opened) await entry.handle.truncate(0);
    for (const entry of opened) {
      if (!entry.quarantinePath) throw new Error("capture quarantine is incomplete");
      const descriptor = identity(await entry.handle.stat());
      const pathStat = identity(await lstat(entry.quarantinePath));
      if (descriptor.dev !== pathStat.dev || descriptor.ino !== pathStat.ino || pathStat.nlink !== 1) throw new Error("capture media path changed before unlink");
      await unlink(entry.quarantinePath);
    }
  } catch (cause) {
    for (const entry of [...opened].reverse()) {
      if (!entry.quarantinePath) continue;
      try {
        const moved = identity(await lstat(entry.quarantinePath));
        const descriptor = identity(await entry.handle.stat());
        try { await lstat(entry.target.realPath); continue; }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") continue; }
        if (moved.dev === descriptor.dev && moved.ino === descriptor.ino && descriptor.size > 0) await rename(entry.quarantinePath, entry.target.realPath);
      } catch { /* Preserve uncertain objects rather than deleting them. */ }
    }
    throw cause;
  } finally {
    await Promise.allSettled(opened.map(({ handle }) => handle.close()));
    if (quarantineDirectory) { try { await rmdir(quarantineDirectory); } catch { /* Preserve non-empty uncertain quarantine. */ } }
  }
}

export async function unlinkOwnedCaptureFile(file: Pick<DecodedCaptureFile, "realPath" | "sha256" | "stat" | "companions">): Promise<void> {
  const targets: OwnedFile[] = [{ realPath: file.realPath, sha256: file.sha256, stat: file.stat }, ...file.companions];
  if (!file.companions.some((companion) => companion.realPath === `${file.realPath}.asd`)) {
    // Live may finish its analysis sidecar while the isolated DSP worker runs.
    // Discover it again immediately before the all-target identity fence.
    try {
      const late = await openVerifiedCandidate(`${file.realPath}.asd`, 4 * 1024 * 1024, Math.max(0, file.stat.birthtimeMs - 5_000), "companion");
      try {
        const bytes = await late.handle.readFile();
        const lateStat = identity(await late.handle.stat());
        if (!sameIdentity(late.stat, lateStat)) throw new Error("capture companion changed during late acquisition");
        targets.push({ realPath: late.originalPath, sha256: createHash("sha256").update(bytes).digest("hex"), stat: lateStat });
      } finally { await late.handle.close(); }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  await quarantineAndUnlinkTargets(targets, file.realPath);
}

export async function unlinkLateCaptureCompanions(file: Pick<DecodedCaptureFile, "realPath" | "stat">): Promise<number> {
  const companionPath = `${file.realPath}.asd`;
  let removed = 0;
  const deadline = Date.now() + 2_000;
  // Observe the complete declared window. Three early ENOENT checks are not a
  // stable absence proof because Live can publish an ASD hundreds of
  // milliseconds after clip deletion.
  while (Date.now() < deadline) {
    try {
      const candidate = await openVerifiedCandidate(companionPath, 4 * 1024 * 1024, Math.max(0, file.stat.birthtimeMs - 5_000), "companion");
      let target: OwnedFile;
      try {
        const bytes = await candidate.handle.readFile();
        const current = identity(await candidate.handle.stat());
        if (!sameIdentity(candidate.stat, current)) throw new Error("late capture companion changed while acquired");
        target = { realPath: companionPath, sha256: createHash("sha256").update(bytes).digest("hex"), stat: current };
      } finally { await candidate.handle.close(); }
      await quarantineAndUnlinkTargets([target], file.realPath);
      removed += 1;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  try { await lstat(companionPath); throw new Error("capture companion appeared at the stable-absence deadline"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  return removed;
}
