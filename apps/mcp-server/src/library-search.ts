import { createHash } from "node:crypto";
import type { SqliteReader, SqliteRow } from "./sqlite-reader.js";

/**
 * Opt-in read-only query surface over Live's own library database
 * (Live-files-*.db and Live-plugins-*.db), issue #54.
 *
 * Schema evidence is enumerated explicitly and fail-closed:
 * - Files database version 12300 (platform 2) was shape-probed first-hand on
 *   Live 12.4.5 (macOS): tables files, keywords, ancestors, places, metadata,
 *   metadata_values, vfolders, devices, file_devices, fe_values, version.
 *   Tags are file rows under the `<keywords>` root; keywords(file_id, keyw_id,
 *   is_auto) links content to them. file_type is a big-endian fourcc.
 * - Plugins database version 1: plugins, plugin_modules, plugin_domains with
 *   dev_identifier-driven format classification (device:vst3:, device:vst:,
 *   device:au:), shape-probed against the same install.
 * Any other version reports `unsupported` with the observed version rather
 * than guessing. The schema is undocumented and unofficial; results are
 * labeled discovery evidence, and loadability still flows through
 * live_browser_inspect identity fencing.
 */

export const LIBRARY_SEARCH_SCHEMA = "ableton-mcp-library-search/v1";
export const SUPPORTED_FILES_SCHEMA_VERSIONS = [12300] as const;
export const SUPPORTED_PLUGINS_SCHEMA_VERSIONS = [1] as const;
export const MAX_LIBRARY_ROWS_SCANNED = 100_000;
export const MAX_LIBRARY_MATCHES = 1_000;
export const MAX_LIBRARY_ITEMS = 100;
export const MAX_TAG_VOCABULARY = 512;

export const LIBRARY_KINDS = ["audio", "midi", "set", "preset", "device-group", "device", "clip", "max-device", "pack", "scale", "other"] as const;
export type LibraryKind = typeof LIBRARY_KINDS[number];

export interface LibraryItem {
  name: string;
  kind: LibraryKind;
  kindEvidence: string;
  tags: Array<{ name: string; path: string; isAuto: boolean }>;
  sources: string[];
  useCount: number;
  modDate: number | null;
  deviceClass: string | null;
  browserCandidate: { itemId: string; resolution: string } | null;
  discoveryOnly: boolean;
}

export interface LibraryPluginItem {
  name: string;
  vendor: string | null;
  version: string | null;
  sdkVersion: string | null;
  format: "vst3" | "vst2" | "au" | "clap" | "unknown";
  formatEvidence: string;
  enabled: boolean;
  scanned: boolean;
  moduleBasename: string | null;
  subcategories: string | null;
}

export interface LibraryTagEntry { path: string; name: string; usageCount: number }

export interface LibraryQuery {
  mode: "files" | "plugins" | "tags";
  query?: string;
  tags?: string[];
  kinds?: LibraryKind[];
  sources?: string[];
  vendors?: string[];
  formats?: Array<"vst3" | "vst2" | "au" | "clap" | "unknown">;
  sort?: "useCount" | "modified" | "name";
  limit: number;
  cursor?: string;
}

export interface LibraryPage {
  items: unknown[];
  paging: { limit: number; returned: number; total: number; complete: boolean; scannedRows: number; truncated: boolean; nextCursor?: string };
  tagVocabularyNote?: string;
}

export class LibraryUnavailable extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) { super(message); this.name = "LibraryUnavailable"; }
}

const textDecoder = new TextDecoder();

function fourcc(value: unknown): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return "????";
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return textDecoder.decode(bytes).replace(/[-\0]/g, "").trim() || "????";
}

function classifyFileType(fileType: unknown, name: string): { kind: LibraryKind; evidence: string } {
  const code = fourcc(fileType);
  switch (code) {
    case "wav": case "aiff": case "aif": case "flac": case "mp3": case "ogg": case "m4a": return { kind: "audio", evidence: `file_type '${code}'` };
    case "als": return { kind: "set", evidence: "file_type 'als'" };
    case "adg": return { kind: "device-group", evidence: "file_type 'adg' (Ableton Device Group)" };
    case "adv": return { kind: "preset", evidence: "file_type 'adv' (Ableton device preset)" };
    case "alc": return { kind: "clip", evidence: "file_type 'alc' (Ableton Live clip)" };
    case "amp": return { kind: "max-device", evidence: "file_type 'amp' (Max for Live device)" };
    case "dfld": return { kind: "device", evidence: "file_type 'dfld' (browser device entry)" };
    case "alp": case "apck": return { kind: "pack", evidence: `file_type '${code}'` };
    case "scl": return { kind: "scale", evidence: "file_type 'scl'" };
    default:
      if (/\.(wav|aiff?|flac|mp3|ogg|m4a)$/i.test(name)) return { kind: "audio", evidence: `name extension (file_type '${code}' unclassified)` };
      if (/\.mid(i)?$/i.test(name)) return { kind: "midi", evidence: `name extension (file_type '${code}' unclassified)` };
      return { kind: "other", evidence: `file_type '${code}' is not classified in this build` };
  }
}

function deviceCategory(deviceId: string): "instruments" | "audio_effects" | "midi_effects" | null {
  if (/^device:[^:]*:instr:/.test(deviceId)) return "instruments";
  if (/^device:[^:]*:audiofx:/.test(deviceId)) return "audio_effects";
  if (/^device:[^:]*:midifx:/.test(deviceId)) return "midi_effects";
  return null;
}

function pluginFormat(devIdentifier: unknown): { format: "vst3" | "vst2" | "au" | "clap" | "unknown"; evidence: string } {
  if (typeof devIdentifier !== "string") return { format: "unknown", evidence: "no dev_identifier" };
  if (devIdentifier.startsWith("device:vst3:")) return { format: "vst3", evidence: "dev_identifier prefix device:vst3:" };
  if (devIdentifier.startsWith("device:vst:")) return { format: "vst2", evidence: "dev_identifier prefix device:vst:" };
  if (devIdentifier.startsWith("device:au:")) return { format: "au", evidence: "dev_identifier prefix device:au:" };
  if (devIdentifier.startsWith("device:clap:")) return { format: "clap", evidence: "dev_identifier prefix device:clap:" };
  return { format: "unknown", evidence: `dev_identifier prefix is not classified (${devIdentifier.slice(0, 32)})` };
}

function requireColumns(reader: SqliteReader, table: string, columns: string[]): void {
  const present = reader.tableColumns(table);
  if (present === undefined) throw new LibraryUnavailable(`the library database is missing the ${table} table`, { table });
  const missing = columns.filter((column) => !present.includes(column));
  if (missing.length > 0) throw new LibraryUnavailable(`the library database ${table} table lacks expected columns`, { table, missing, present });
}

function rowNumber(row: SqliteRow, index: number): number | null {
  const value = row[index];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function rowText(row: SqliteRow, index: number): string | null {
  const value = row[index];
  return typeof value === "string" ? value : null;
}

interface FileRow {
  fileId: number;
  parentId: number | null;
  fileType: number | null;
  modDate: number | null;
  name: string;
  useCount: number;
  placeId: number | null;
  deviceId: string | null;
}

const FILES_COLUMNS = { fileId: 0, parentId: 1, fileType: 2, modDate: 5, name: 8, useCount: 12, placeId: 13, deviceId: 17 } as const;

function readLibraryFiles(reader: SqliteReader): FileRow[] {
  requireColumns(reader, "files", ["file_id", "parent_id", "file_type", "mod_date", "name", "use_count", "place_id", "device_id"]);
  const rows: FileRow[] = [];
  for (const { row, rowId } of reader.scanTable("files", MAX_LIBRARY_ROWS_SCANNED)) {
    // file_id is an INTEGER PRIMARY KEY alias: the record stores NULL and the
    // authoritative value is the cell rowid.
    const fileId = rowNumber(row, FILES_COLUMNS.fileId) ?? rowId;
    const name = rowText(row, FILES_COLUMNS.name);
    if (fileId === null || name === null) throw new LibraryUnavailable("the files table contains malformed identity rows", {});
    rows.push({ fileId, parentId: rowNumber(row, FILES_COLUMNS.parentId), fileType: rowNumber(row, FILES_COLUMNS.fileType), modDate: rowNumber(row, FILES_COLUMNS.modDate), name, useCount: rowNumber(row, FILES_COLUMNS.useCount) ?? 0, placeId: rowNumber(row, FILES_COLUMNS.placeId), deviceId: rowText(row, FILES_COLUMNS.deviceId) });
  }
  return rows;
}

function schemaVersion(reader: SqliteReader): number {
  requireColumns(reader, "version", ["version", "platform"]);
  const rows = reader.scanTable("version", 4);
  if (rows.length !== 1) throw new LibraryUnavailable("the library database version row is missing or ambiguous", {});
  const version = rowNumber(rows[0]!.row, 0);
  if (version === null) throw new LibraryUnavailable("the library database version is unreadable", {});
  return version;
}

export function assertSupportedFilesSchema(reader: SqliteReader): number {
  const version = schemaVersion(reader);
  if (!(SUPPORTED_FILES_SCHEMA_VERSIONS as readonly number[]).includes(version)) {
    throw new LibraryUnavailable("the library database schema version is not enumerated in this build", { observedVersion: version, supportedVersions: [...SUPPORTED_FILES_SCHEMA_VERSIONS] });
  }
  requireColumns(reader, "keywords", ["file_id", "keyw_id", "is_auto"]);
  requireColumns(reader, "ancestors", ["file_id", "ancestor_id"]);
  requireColumns(reader, "places", ["file_id", "folder_kind", "level", "name"]);
  return version;
}

export function assertSupportedPluginsSchema(reader: SqliteReader): number {
  const version = schemaVersion(reader);
  if (!(SUPPORTED_PLUGINS_SCHEMA_VERSIONS as readonly number[]).includes(version)) {
    throw new LibraryUnavailable("the plug-in database schema version is not enumerated in this build", { observedVersion: version, supportedVersions: [...SUPPORTED_PLUGINS_SCHEMA_VERSIONS] });
  }
  requireColumns(reader, "plugins", ["plugin_id", "module_id", "dev_identifier", "name", "vendor", "version", "sdk_version", "scanstate", "enabled"]);
  return version;
}

interface TagInfo { name: string; path: string; isAuto: boolean }

function buildTagIndex(reader: SqliteReader, files: FileRow[]): { tagsByFile: Map<number, TagInfo[]>; vocabulary: LibraryTagEntry[] } {
  const byId = new Map(files.map((row) => [row.fileId, row] as const));
  const parentOf = new Map(files.map((row) => [row.fileId, row.parentId] as const));
  const keywordRoot = files.find((row) => row.name === "<keywords>" && (row.parentId === null || row.parentId === 0));
  const tagPath = (fileId: number, seen = new Set<number>()): string | undefined => {
    if (seen.has(fileId)) return undefined;
    seen.add(fileId);
    const row = byId.get(fileId);
    if (!row) return undefined;
    if (keywordRoot && row.fileId === keywordRoot.fileId) return "";
    if (row.parentId === null || row.parentId === 0) return undefined;
    const parentPath = tagPath(row.parentId, seen);
    if (parentPath === undefined) return undefined;
    return parentPath === "" ? row.name : `${parentPath}|${row.name}`;
  };
  const tagFiles = new Map<number, string>();
  for (const row of files) {
    if (fourcc(row.fileType) !== "keyw") continue;
    const path = tagPath(row.fileId);
    if (path !== undefined && path.length > 0 && path.length <= 512) tagFiles.set(row.fileId, path);
  }
  const tagsByFile = new Map<number, TagInfo[]>();
  const usage = new Map<number, number>();
  for (const { row } of reader.scanTable("keywords", MAX_LIBRARY_ROWS_SCANNED)) {
    const fileId = rowNumber(row, 0); const keywId = rowNumber(row, 1); const isAuto = rowNumber(row, 2) === 1;
    if (fileId === null || keywId === null) continue;
    const path = tagFiles.get(keywId);
    if (path === undefined) continue;
    const name = path.split("|").pop()!;
    tagsByFile.set(fileId, [...(tagsByFile.get(fileId) ?? []), { name, path, isAuto }]);
    usage.set(keywId, (usage.get(keywId) ?? 0) + 1);
  }
  const vocabulary = [...tagFiles.entries()].map(([keywId, path]) => ({ path, name: path.split("|").pop()!, usageCount: usage.get(keywId) ?? 0 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (vocabulary.length > MAX_TAG_VOCABULARY) throw new LibraryUnavailable("the tag vocabulary exceeds its bound", { bound: MAX_TAG_VOCABULARY });
  return { tagsByFile, vocabulary };
}

function placeMap(reader: SqliteReader): Map<number, string> {
  const map = new Map<number, string>();
  for (const { row } of reader.scanTable("places", MAX_LIBRARY_ROWS_SCANNED)) {
    const fileId = rowNumber(row, 0); const name = rowText(row, 3);
    if (fileId !== null && name !== null) map.set(fileId, name);
  }
  return map;
}

function wildcardToRegExp(query: string): RegExp {
  const escaped = query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function pageIds<T>(items: T[], idOf: (item: T) => string, query: LibraryQuery, revisionSeed: string, scannedRows: number): LibraryPage {
  const limit = query.limit;
  let offset = 0;
  const revision = createHash("sha256").update(JSON.stringify({ seed: revisionSeed, ids: idOf(items[0] ?? ({} as T)), count: items.length, sort: query.sort ?? "useCount", mode: query.mode })).digest("hex");
  if (query.cursor !== undefined) {
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { throw new LibraryUnavailable("the paging cursor is invalid", {}); }
    if (typeof decoded !== "object" || decoded === null || (decoded as Record<string, unknown>).revision !== revision || !Number.isSafeInteger((decoded as Record<string, unknown>).offset)) throw new LibraryUnavailable("the paging cursor is stale; request a fresh first page", {});
    offset = Math.min((decoded as Record<string, unknown>).offset as number, items.length);
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const complete = nextOffset >= items.length;
  return { items: page, paging: { limit, returned: page.length, total: items.length, complete, scannedRows, truncated: items.length >= MAX_LIBRARY_MATCHES, ...(complete ? {} : { nextCursor: Buffer.from(JSON.stringify({ revision, offset: nextOffset })).toString("base64url") }) } };
}

export function queryLibraryFiles(reader: SqliteReader, query: LibraryQuery): LibraryPage & { tagVocabularyNote: string } {
  const files = readLibraryFiles(reader);
  const { tagsByFile } = buildTagIndex(reader, files);
  const places = placeMap(reader);
  const excludedFourccs = new Set(["keyw", "fldr", "pref"]);
  const nameMatcher = query.query === undefined || query.query.length === 0 ? undefined : (query.query.includes("*") || query.query.includes("?") ? wildcardToRegExp(query.query) : undefined);
  const requestedTags = (query.tags ?? []).map((tag) => tag.toLowerCase());
  const requestedKinds = query.kinds !== undefined && query.kinds.length > 0 ? new Set<LibraryKind>(query.kinds) : undefined;
  const requestedSources = query.sources !== undefined && query.sources.length > 0 ? new Set(query.sources) : undefined;
  const matched: LibraryItem[] = [];
  let scannedRows = 0;
  for (const row of files) {
    scannedRows += 1;
    if (matched.length >= MAX_LIBRARY_MATCHES) break;
    const code = fourcc(row.fileType);
    if (excludedFourccs.has(code)) continue;
    const classification = classifyFileType(row.fileType, row.name);
    if (requestedKinds && !requestedKinds.has(classification.kind)) continue;
    if (nameMatcher ? !nameMatcher.test(row.name) : (query.query !== undefined && query.query.length > 0 && !row.name.toLowerCase().includes(query.query.toLowerCase()))) continue;
    const tags = tagsByFile.get(row.fileId) ?? [];
    if (requestedTags.length > 0) {
      const owned = new Set(tags.flatMap((tag) => [tag.name.toLowerCase(), tag.path.toLowerCase()]));
      if (!requestedTags.every((tag) => owned.has(tag))) continue;
    }
    const sourceName = row.placeId !== null ? places.get(row.placeId) : undefined;
    if (requestedSources && (sourceName === undefined || !requestedSources.has(sourceName))) continue;
    const category = row.deviceId !== null ? deviceCategory(row.deviceId) : null;
    const browserCandidate = category !== null && (classification.kind === "device" || classification.kind === "device-group" || classification.kind === "preset")
      ? { itemId: `${category}/${row.name}`, resolution: "candidate from the library row's name and device class; loadability still requires a fresh live_browser_inspect result" }
      : null;
    matched.push({ name: row.name, kind: classification.kind, kindEvidence: classification.evidence, tags, sources: sourceName !== undefined ? [sourceName] : [], useCount: row.useCount, modDate: row.modDate, deviceClass: row.deviceId, browserCandidate, discoveryOnly: browserCandidate === null });
  }
  const sort = query.sort ?? "useCount";
  matched.sort((a, b) => {
    if (sort === "useCount" && a.useCount !== b.useCount) return b.useCount - a.useCount;
    if (sort === "modified" && (a.modDate ?? 0) !== (b.modDate ?? 0)) return (b.modDate ?? 0) - (a.modDate ?? 0);
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const revisionSeed = `files|${query.query ?? ""}|${requestedTags.join(",")}|${[...requestedKinds ?? []].sort().join(",")}|${[...requestedSources ?? []].sort().join(",")}`;
  return { ...pageIds(matched, (item) => item.name, query, revisionSeed, scannedRows), tagVocabularyNote: "tag filters accept a leaf name (\"Delay\") or a full path (\"Devices|Synthesizer|FM\") from the tag vocabulary; use mode=tags to list it" };
}

export function queryLibraryPlugins(reader: SqliteReader, query: LibraryQuery): LibraryPage {
  requireColumns(reader, "plugin_modules", ["module_id", "path"]);
  const rows = reader.scanTable("plugins", MAX_LIBRARY_ROWS_SCANNED);
  const modules = new Map<number, string>();
  for (const { row, rowId } of reader.scanTable("plugin_modules", MAX_LIBRARY_ROWS_SCANNED)) {
    const moduleId = rowNumber(row, 0) ?? rowId; const path = rowText(row, 1);
    if (moduleId !== null && path !== null) modules.set(moduleId, path.split(/[\\/]/).pop() ?? path);
  }
  const requestedVendors = query.vendors !== undefined && query.vendors.length > 0 ? new Set(query.vendors.map((vendor) => vendor.toLowerCase())) : undefined;
  const requestedFormats = query.formats !== undefined && query.formats.length > 0 ? new Set(query.formats) : undefined;
  const items: LibraryPluginItem[] = [];
  let scannedRows = 0;
  for (const { row } of rows) {
    scannedRows += 1;
    if (items.length >= MAX_LIBRARY_MATCHES) break;
    const name = rowText(row, 3);
    if (name === null) continue;
    if (query.query !== undefined && query.query.length > 0 && !name.toLowerCase().includes(query.query.toLowerCase())) continue;
    const vendor = rowText(row, 4);
    if (requestedVendors && (vendor === null || !requestedVendors.has(vendor.toLowerCase()))) continue;
    const format = pluginFormat(row[2]);
    if (requestedFormats && !requestedFormats.has(format.format)) continue;
    const moduleId = rowNumber(row, 1);
    items.push({ name, vendor, version: rowText(row, 5), sdkVersion: rowText(row, 6), format: format.format, formatEvidence: format.evidence, enabled: rowNumber(row, 9) === 1, scanned: rowNumber(row, 7) === 1, moduleBasename: moduleId !== null ? modules.get(moduleId) ?? null : null, subcategories: rowText(row, 10) });
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const revisionSeed = `plugins|${query.query ?? ""}|${[...requestedVendors ?? []].sort().join(",")}|${[...requestedFormats ?? []].sort().join(",")}`;
  return pageIds(items, (item) => item.name, query, revisionSeed, scannedRows);
}

export function queryLibraryTagVocabulary(reader: SqliteReader, query: LibraryQuery): LibraryPage {
  const files = readLibraryFiles(reader);
  const { vocabulary } = buildTagIndex(reader, files);
  const filtered = query.query === undefined || query.query.length === 0 ? vocabulary : vocabulary.filter((entry) => entry.path.toLowerCase().includes((query.query as string).toLowerCase()));
  return pageIds(filtered, (entry) => entry.path, { ...query, sort: "name" }, `tags|${query.query ?? ""}`, filtered.length);
}
