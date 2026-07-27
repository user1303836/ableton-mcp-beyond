import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

/** Host-side project file operations. The current set file is read only after
 * its identity is proven through the authenticated bridge; backups are written
 * only into the set's own directory with atomic replacement and sha256
 * verification. Referenced media is checked for existence only (metadata),
 * never read. */

export interface ProjectManifest {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  tracks: number;
  scenes: number;
  mediaRefs: number;
}

export interface ProjectInfo {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
  tracks?: number;
  scenes?: number;
  mediaRefs?: number;
  missingMedia?: string[];
  recovered?: boolean;
}

const MAX_SET_BYTES = 64 * 1024 * 1024;

function assertSafeSetPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("set path must be absolute and safe");
  const resolved = resolve(path);
  if (extname(resolved).toLowerCase() !== ".als") throw new Error("set path must be an .als file");
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new Error("set file must not be a symbolic link");
  if (!stats.isFile()) throw new Error("set path is not a regular file");
  if (stats.size > MAX_SET_BYTES) throw new Error("set file exceeds the bounded size");
  return resolved;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readSetXml(path: string): string {
  const raw = readFileSync(path);
  let xml: Buffer;
  try { xml = gunzipSync(raw); }
  catch { throw new Error("set file is not a valid gzip-compressed Live set"); }
  if (xml.length > MAX_SET_BYTES) throw new Error("decompressed set exceeds the bounded size");
  return xml.toString("utf8");
}

function parseManifest(path: string): ProjectManifest {
  const stats = statSync(path);
  const xml = readSetXml(path);
  const tracks = (xml.match(/<Track[\s>]/g) ?? []).length;
  const scenes = (xml.match(/<Scene[\s>]/g) ?? []).length;
  const mediaRefs = new Set([...xml.matchAll(/<FileRef[^>]*>[\s\S]*?<Path[^>]*Value="([^"]+)"/g)].map((match) => match[1]!));
  return { path, size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256File(path), tracks, scenes, mediaRefs: mediaRefs.size };
}

function referencedMediaPaths(path: string): string[] {
  const xml = readSetXml(path);
  const paths = new Set<string>();
  for (const match of xml.matchAll(/<FileRef[^>]*>[\s\S]*?<Path[^>]*Value="([^"]+)"/g)) {
    const value = match[1]!;
    if (isAbsolute(value) && !value.includes("\0")) paths.add(resolve(value));
  }
  return [...paths].sort().slice(0, 4096);
}

function missingMedia(path: string): string[] {
  return referencedMediaPaths(path).filter((candidate) => !existsSync(candidate));
}

export function projectInfo(path: string): ProjectInfo {
  const resolved = assertSafeSetPath(path);
  const manifest = parseManifest(resolved);
  return { ...manifest, missingMedia: missingMedia(resolved), exists: true };
}

export function projectBackup(path: string): { backup: string; manifest: ProjectManifest; verified: boolean } {
  const resolved = assertSafeSetPath(path);
  const directory = dirname(resolved);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${basename(resolved, ".als")}.backup-${stamp}.als`;
  const target = join(directory, backupName);
  const temporary = join(directory, `.ableton-mcp-backup-${process.pid}-${Date.now()}.tmp`);
  copyFileSync(resolved, temporary);
  const sourceSha = sha256File(resolved);
  const copySha = sha256File(temporary);
  if (sourceSha !== copySha) throw new Error("backup copy verification failed");
  renameSync(temporary, target);
  const verified = sha256File(target) === sourceSha;
  const manifest = parseManifest(target);
  return { backup: target, manifest, verified };
}

/** Save/save-as/open/new/export/collect/bounce are not exposed by the Live
 * 12.4.5b8 Remote Script API. Report the precise negotiated limitation. */
export function projectLimitation(operation: string): { available: false; operation: string; reason: string; extensionPoint: string } {
  return { available: false, operation, reason: `${operation} is not exposed by the Live Remote Script API in this Live version and is not fabricated`, extensionPoint: "project.info and project.backup are the supported host-side project operations" };
}
