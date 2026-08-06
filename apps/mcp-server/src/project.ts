import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Internal read-only evidence used by semantic Set exports. Paths remain
 * host-local here and must be policy-redacted before they cross the MCP
 * boundary. Referenced files are never opened. */
export interface ProjectSourceEvidence {
  manifest: ProjectManifest;
  ableton: { creator?: string; majorVersion?: string; minorVersion?: string; schemaChangeCount?: string };
  references: Array<{ value: string; resolvedPath?: string; exists?: boolean; projectLocal?: boolean; resolution: "absolute" | "set-relative" | "unresolved" | "network" | "oversized" }>;
  referenceBounds: { observed: number; observedKind: "exact" | "lower-bound"; included: number; omitted: number; complete: boolean };
}

const MAX_SET_BYTES = 64 * 1024 * 1024;
const MAX_FILE_REFERENCES = 4096;
const MAX_FILE_REFERENCE_LENGTH = 4096;

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

interface SetSourceRead { path: string; raw: Buffer; xml: string; size: number; mtimeMs: number; sha256: string }

/** Read once, then verify that the regular-file identity did not change while
 * it was open. XML, size, and hash therefore describe the same bounded bytes. */
function readSetSource(path: string): SetSourceRead {
  const resolved = assertSafeSetPath(path);
  const before = lstatSync(resolved);
  const raw = readFileSync(resolved);
  const after = lstatSync(resolved);
  if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || raw.length !== after.size) throw new Error("set file identity changed during the bounded read");
  let xmlBytes: Buffer;
  try { xmlBytes = gunzipSync(raw, { maxOutputLength: MAX_SET_BYTES }); }
  catch (cause) {
    if (cause instanceof Error && /output length|buffer too large|larger than/i.test(cause.message)) throw new Error("decompressed set exceeds the bounded size");
    throw new Error("set file is not a valid gzip-compressed Live set");
  }
  return { path: resolved, raw, xml: xmlBytes.toString("utf8"), size: after.size, mtimeMs: after.mtimeMs, sha256: createHash("sha256").update(raw).digest("hex") };
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

interface ReferencedMediaCollection { values: string[]; observed: number; omitted: number; complete: boolean }

function referencedMediaValues(xml: string): ReferencedMediaCollection {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const fileRef of xml.matchAll(/<FileRef\b[^>]*>([\s\S]*?)<\/FileRef\s*>/g)) {
    const path = /<Path\b[^>]*\bValue="([^"]*)"/.exec(fileRef[1]!);
    if (!path?.[1]) continue;
    const value = decodeXmlAttribute(path[1]);
    const identity = createHash("sha256").update(value).digest("hex");
    if (seen.has(identity)) continue;
    // Stop after the first distinct overflow reference. This keeps both the
    // retained strings and the deduplication set bounded; observed/omitted are
    // then explicit lower bounds rather than pretending to be exact counts.
    if (values.length >= MAX_FILE_REFERENCES) return { values, observed: values.length + 1, omitted: 1, complete: false };
    seen.add(identity); values.push(value);
  }
  return { values, observed: values.length, omitted: 0, complete: true };
}

function parseManifest(source: SetSourceRead, references = referencedMediaValues(source.xml)): ProjectManifest {
  const tracks = (source.xml.match(/<(?:AudioTrack|MidiTrack|GroupTrack|ReturnTrack|MasterTrack|MainTrack)\b/g) ?? []).length;
  const scenes = (source.xml.match(/<Scene\b/g) ?? []).length;
  return { path: source.path, size: source.size, mtimeMs: source.mtimeMs, sha256: source.sha256, tracks, scenes, mediaRefs: references.observed };
}

function abletonRootAttributes(xml: string): ProjectSourceEvidence["ableton"] {
  const root = /<Ableton\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const attributes = new Map<string, string>();
  for (const match of root.matchAll(/\b([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) attributes.set(match[1]!, decodeXmlAttribute(match[2]!));
  return {
    ...(attributes.has("Creator") ? { creator: attributes.get("Creator") } : {}),
    ...(attributes.has("MajorVersion") ? { majorVersion: attributes.get("MajorVersion") } : {}),
    ...(attributes.has("MinorVersion") ? { minorVersion: attributes.get("MinorVersion") } : {}),
    ...(attributes.has("SchemaChangeCount") ? { schemaChangeCount: attributes.get("SchemaChangeCount") } : {}),
  };
}

function isNetworkOrDevicePath(value: string): boolean {
  const normalized = value.replaceAll("/", "\\");
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  return normalized.startsWith("\\\\") || /^\\\\[?.]\\/.test(normalized) || (!windowsDrive && /^[A-Za-z][A-Za-z0-9+.-]*:[\\/]{1,2}/i.test(value));
}

export function projectSourceEvidence(path: string): ProjectSourceEvidence {
  const source = readSetSource(path);
  const collected = referencedMediaValues(source.xml);
  const references = collected.values.sort().map((rawValue) => {
    if (rawValue.length > MAX_FILE_REFERENCE_LENGTH) return { value: `oversized-${createHash("sha256").update(rawValue).digest("hex")}`, resolution: "oversized" as const };
    const value = rawValue;
    if (value.includes("\0")) return { value: `unsafe-${createHash("sha256").update(value).digest("hex")}`, resolution: "unresolved" as const };
    if (isNetworkOrDevicePath(value)) return { value: `network-${createHash("sha256").update(value).digest("hex")}`, resolution: "network" as const };
    const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value);
    if (isAbsolute(value) || windowsAbsolute) {
      const resolvedPath = windowsAbsolute && !isAbsolute(value) ? value : resolve(value);
      const exists = existsSync(resolvedPath);
      let projectLocal = false;
      if (!windowsAbsolute) {
        if (exists) {
          try {
            const realProject = realpathSync(dirname(source.path)); const realReference = realpathSync(resolvedPath);
            projectLocal = realReference === realProject || realReference.startsWith(`${realProject}${sep}`);
          } catch { projectLocal = false; }
        } else {
          const lexical = resolve(resolvedPath); const projectDirectory = dirname(source.path);
          projectLocal = lexical !== projectDirectory && lexical.startsWith(`${projectDirectory}${sep}`);
        }
      }
      return { value, resolvedPath, exists, projectLocal, resolution: "absolute" as const };
    }
    return { value, resolution: "unresolved" as const };
  });
  return { manifest: parseManifest(source, collected), ableton: abletonRootAttributes(source.xml), references, referenceBounds: { observed: collected.observed, observedKind: collected.complete ? "exact" : "lower-bound", included: references.length, omitted: collected.omitted, complete: collected.complete } };
}

export function projectInfo(path: string): ProjectInfo {
  const evidence = projectSourceEvidence(path);
  const missing = evidence.references.filter((reference) => reference.resolution === "absolute" && reference.exists === false && reference.resolvedPath).map((reference) => reference.resolvedPath!);
  return { ...evidence.manifest, missingMedia: missing, exists: true };
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
  const sourceManifest = parseManifest(readSetSource(resolved));
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
    const manifest = parseManifest(readSetSource(target));
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
