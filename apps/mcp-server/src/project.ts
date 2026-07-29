import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  try { xml = gunzipSync(raw, { maxOutputLength: MAX_SET_BYTES }); }
  catch (cause) {
    if (cause instanceof Error && /output length|buffer too large|larger than/i.test(cause.message)) throw new Error("decompressed set exceeds the bounded size");
    throw new Error("set file is not a valid gzip-compressed Live set");
  }
  return xml.toString("utf8");
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" };
    if (named[entity] !== undefined) return named[entity];
    const hexadecimal = entity.startsWith("&#x");
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw new Error("Live Set contains an invalid XML path entity");
    return String.fromCodePoint(codePoint);
  });
}

function referencedMediaValues(xml: string): string[] {
  const values: string[] = [];
  for (const fileRef of xml.matchAll(/<FileRef\b[^>]*>([\s\S]*?)<\/FileRef\s*>/g)) {
    const path = /<Path\b[^>]*\bValue="([^"]*)"/.exec(fileRef[1]!);
    if (path?.[1]) values.push(decodeXmlAttribute(path[1]));
  }
  return values;
}

function parseManifest(path: string): ProjectManifest {
  const stats = statSync(path);
  const xml = readSetXml(path);
  const tracks = (xml.match(/<(?:AudioTrack|MidiTrack|GroupTrack|ReturnTrack|MasterTrack|MainTrack)\b/g) ?? []).length;
  const scenes = (xml.match(/<Scene\b/g) ?? []).length;
  const mediaRefs = new Set(referencedMediaValues(xml));
  return { path, size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256File(path), tracks, scenes, mediaRefs: mediaRefs.size };
}

function referencedMediaPaths(path: string): string[] {
  const paths = new Set<string>();
  for (const value of referencedMediaValues(readSetXml(path))) {
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

export function projectBackup(path: string, options: { allowedRoot?: string; expectedSha256?: string; expectedSize?: number; expectedMtimeMs?: number } = {}): { backup: string; manifest: ProjectManifest; verified: boolean } {
  const resolved = assertSafeSetPath(path);
  if (options.allowedRoot !== undefined) {
    if (!isAbsolute(options.allowedRoot) || options.allowedRoot.includes("\0")) throw new Error("backup allowlist root must be an absolute safe directory");
    const root = resolve(options.allowedRoot); const rootStats = lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("backup allowlist root must be a real directory");
    const realRoot = realpathSync(root); const realSet = realpathSync(resolved);
    if (realSet !== realRoot && !realSet.startsWith(`${realRoot}${sep}`)) throw new Error("set path is outside the explicit backup allowlist root");
  }
  const sourceManifest = parseManifest(resolved);
  if (options.expectedSha256 !== undefined && (sourceManifest.sha256 !== options.expectedSha256 || sourceManifest.size !== options.expectedSize || sourceManifest.mtimeMs !== options.expectedMtimeMs)) throw new Error("set content changed since backup preview");
  const directory = dirname(resolved);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${basename(resolved, ".als")}.backup-${stamp}.als`;
  const target = join(directory, backupName);
  const temporary = join(directory, `.ableton-mcp-backup-${process.pid}-${Date.now()}.tmp`);
  if (existsSync(target)) throw new Error("backup target already exists");
  try {
    copyFileSync(resolved, temporary);
    const sourceSha = sha256File(resolved); const copySha = sha256File(temporary);
    if (sourceSha !== sourceManifest.sha256 || sourceSha !== copySha) throw new Error("set changed during backup or copy verification failed");
    renameSync(temporary, target);
    const verified = sha256File(target) === sourceSha;
    const manifest = parseManifest(target);
    return { backup: target, manifest, verified };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Save/save-as/open/new/export/collect/bounce are not exposed by the Live
 * 12.4.5b8 Remote Script API. Report the precise negotiated limitation. */
export function projectLimitation(operation: string): { available: false; operation: string; reason: string; extensionPoint: string } {
  return { available: false, operation, reason: `${operation} is not exposed by the Live Remote Script API in this Live version and is not fabricated`, extensionPoint: "canonical project.new/open/save/save-as/collect/export/bounce operations are reserved for a future adapter and remain unadvertised until executable; project.info and project.backup are available now" };
}
