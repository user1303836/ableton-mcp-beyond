import { createHash } from "node:crypto";
import {
  SEMANTIC_PROJECT_MAX_PAGE_BYTES,
  SEMANTIC_PROJECT_MAX_PAGE_RECORDS,
  SEMANTIC_PROJECT_SNAPSHOT_SCHEMA,
  canonicalSemanticJson,
  compareSemanticStrings,
  validateSemanticProjectArtifact,
  type SemanticJson,
  type SemanticProjectArtifact,
  type SemanticProjectRecord,
  type SemanticProjectSection,
} from "./project-semantic.js";

export const SEMANTIC_PROJECT_DIFF_SCHEMA = "ableton-mcp-semantic-set-diff/v1" as const;

export interface SemanticProjectChange {
  type: "change";
  section: SemanticProjectSection;
  kind: string;
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
  facets: Array<"added" | "removed" | "renamed" | "reordered" | "content-changed" | "state-changed" | "dependency-changed" | "availability-changed">;
  confidence: "exact-content" | "unique-semantic" | "unique-name" | "absence";
  evidence: string[];
  details: Array<{ path: string; before: SemanticJson | "absent"; after: SemanticJson | "absent" }>;
  detailsTruncated: boolean;
}

export interface SemanticProjectAmbiguity {
  type: "ambiguity";
  section: SemanticProjectSection;
  kind: string;
  reason: "indistinguishable-candidates" | "incomplete-section";
  beforeCandidateCount: number;
  afterCandidateCount: number;
  candidateSetDigest: string;
  beforeSnapshotIds: string[];
  afterSnapshotIds: string[];
  candidatesTruncated: boolean;
  evidence: string[];
}

export type SemanticProjectDiffItem = SemanticProjectChange | SemanticProjectAmbiguity;

export interface SemanticProjectDiff {
  schema: typeof SEMANTIC_PROJECT_DIFF_SCHEMA;
  diff: { id: string; beforeArtifactId: string; afterArtifactId: string };
  policy: { profile: SemanticProjectArtifact["policy"]["profile"] };
  summary: { changed: boolean; changes: number; ambiguities: number; incompleteSections: SemanticProjectSection[] };
  safety: { comparisonOnly: true; mergeProposed: false; crossRunSessionIdentityUsed: false; mutationAuthorityGranted: false };
  limitations: string[];
  items: SemanticProjectDiffItem[];
}

export interface SemanticProjectDiffPage extends Omit<SemanticProjectDiff, "items"> {
  page: { offset: number; returned: number; total: number; complete: boolean; nextCursor?: string };
  items: SemanticProjectDiffItem[];
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSemanticJson(value)).digest("hex")}`;
}

function shortDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSemanticJson(value)).digest("hex").slice(0, 20);
}

function groupUnique(records: SemanticProjectRecord[], key: (record: SemanticProjectRecord) => string): Map<string, SemanticProjectRecord[]> {
  const groups = new Map<string, SemanticProjectRecord[]>();
  for (const record of records) { const value = key(record); const rows = groups.get(value) ?? []; rows.push(record); groups.set(value, rows); }
  return groups;
}

function nameCompatible(before: SemanticProjectRecord, after: SemanticProjectRecord): boolean {
  if (before.kind !== after.kind) return false;
  if (before.kind === "track") return before.data.kind === after.data.kind;
  if (before.kind === "clip") return before.data.clipKind === after.data.clipKind;
  if (before.kind === "device") return before.data.deviceKind === after.data.deviceKind && before.data.className === after.data.className;
  if (before.kind === "dependency") return before.data.category === after.data.category && before.data.origin === after.data.origin && (before.matching.className ?? null) === (after.matching.className ?? null);
  return true;
}

function semanticCompatible(before: SemanticProjectRecord, after: SemanticProjectRecord): boolean {
  if (!nameCompatible(before, after)) return false;
  const opaque = (before.kind === "device" || before.kind === "dependency") && before.matching.opaqueState === true && after.matching.opaqueState === true;
  // A generic opaque class/schema cannot distinguish rename from replacement.
  return !(opaque && before.name !== after.name);
}

function compatibilityKey(record: SemanticProjectRecord): string {
  if (record.kind === "track") return `${record.kind}:${String(record.data.kind)}`;
  if (record.kind === "clip") return `${record.kind}:${String(record.data.clipKind)}`;
  if (record.kind === "device") return `${record.kind}:${String(record.data.deviceKind)}:${String(record.data.className)}`;
  if (record.kind === "dependency") return `${record.kind}:${String(record.data.category)}:${String(record.data.origin)}:${String(record.matching.className ?? "")}`;
  return record.kind;
}

function matchUnique(
  before: SemanticProjectRecord[],
  after: SemanticProjectRecord[],
  key: (record: SemanticProjectRecord) => string,
  confidence: SemanticProjectChange["confidence"],
  compatible: (before: SemanticProjectRecord, after: SemanticProjectRecord) => boolean,
): Array<{ before: SemanticProjectRecord; after: SemanticProjectRecord; confidence: SemanticProjectChange["confidence"] }> {
  const beforeGroups = groupUnique(before, key); const afterGroups = groupUnique(after, key); const matches: Array<{ before: SemanticProjectRecord; after: SemanticProjectRecord; confidence: SemanticProjectChange["confidence"] }> = [];
  for (const [value, beforeRows] of beforeGroups) {
    const afterRows = afterGroups.get(value);
    if (beforeRows.length === 1 && afterRows?.length === 1 && compatible(beforeRows[0]!, afterRows[0]!)) matches.push({ before: beforeRows[0]!, after: afterRows[0]!, confidence });
  }
  return matches;
}

function jsonValue(value: unknown): SemanticJson {
  return value as SemanticJson;
}

function changedDetails(before: SemanticProjectRecord, after: SemanticProjectRecord): { details: SemanticProjectChange["details"]; truncated: boolean } {
  const details: SemanticProjectChange["details"] = [];
  const visit = (beforeValue: unknown, afterValue: unknown, path: string, depth: number): void => {
    if (details.length >= 64) return;
    if (canonicalSemanticJson(beforeValue) === canonicalSemanticJson(afterValue)) return;
    if (depth < 4 && beforeValue && afterValue && typeof beforeValue === "object" && typeof afterValue === "object" && !Array.isArray(beforeValue) && !Array.isArray(afterValue)) {
      const keys = [...new Set([...Object.keys(beforeValue as Record<string, unknown>), ...Object.keys(afterValue as Record<string, unknown>)])].sort();
      for (const key of keys) {
        const beforeObject = beforeValue as Record<string, unknown>; const afterObject = afterValue as Record<string, unknown>;
        if (!(key in beforeObject)) details.push({ path: `${path}/${key}`, before: "absent", after: jsonValue(afterObject[key]) });
        else if (!(key in afterObject)) details.push({ path: `${path}/${key}`, before: jsonValue(beforeObject[key]), after: "absent" });
        else visit(beforeObject[key], afterObject[key], `${path}/${key}`, depth + 1);
        if (details.length >= 64) break;
      }
      return;
    }
    details.push({ path, before: jsonValue(beforeValue), after: jsonValue(afterValue) });
  };
  visit({ name: before.name ?? null, order: before.order, data: before.data }, { name: after.name ?? null, order: after.order, data: after.data }, "", 0);
  return { details, truncated: details.length >= 64 };
}

function changeFor(before: SemanticProjectRecord, after: SemanticProjectRecord, confidence: SemanticProjectChange["confidence"]): SemanticProjectChange | null {
  const facets: SemanticProjectChange["facets"] = [];
  if (before.name !== after.name) facets.push("renamed");
  if (before.order !== after.order) facets.push("reordered");
  if (canonicalSemanticJson(before.data) !== canonicalSemanticJson(after.data)) {
    if (before.kind === "device") facets.push("state-changed");
    else if (before.kind === "dependency") {
      facets.push("dependency-changed");
      if (before.data.availability !== after.data.availability) facets.push("availability-changed");
    } else facets.push("content-changed");
  }
  if (facets.length === 0) return null;
  const changed = changedDetails(before, after);
  return { type: "change", section: before.section, kind: before.kind, beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId, facets, confidence, evidence: ["snapshot-local IDs are coordinates only", confidence === "exact-content" ? "unique equal content fingerprint" : confidence === "unique-semantic" ? "unique equal semantic structure fingerprint" : "unique compatible name fingerprint"], details: changed.details, detailsTruncated: changed.truncated };
}

function absenceChange(record: SemanticProjectRecord, facet: "added" | "removed"): SemanticProjectChange {
  return { type: "change", section: record.section, kind: record.kind, ...(facet === "removed" ? { beforeSnapshotId: record.snapshotId } : { afterSnapshotId: record.snapshotId }), facets: [facet], confidence: "absence", evidence: ["no compatible remaining candidate in a complete section", "snapshot-local IDs were not used for matching"], details: [], detailsTruncated: false };
}

const MAX_AMBIGUITY_ID_SAMPLE = 128;
function boundedAmbiguity(section: SemanticProjectSection, kind: string, reason: SemanticProjectAmbiguity["reason"], beforeIds: string[], afterIds: string[], evidence: string[]): SemanticProjectAmbiguity {
  const before = [...beforeIds].sort(compareSemanticStrings); const after = [...afterIds].sort(compareSemanticStrings);
  return {
    type: "ambiguity", section, kind, reason,
    beforeCandidateCount: before.length, afterCandidateCount: after.length,
    candidateSetDigest: digest({ before, after }),
    beforeSnapshotIds: before.slice(0, MAX_AMBIGUITY_ID_SAMPLE), afterSnapshotIds: after.slice(0, MAX_AMBIGUITY_ID_SAMPLE),
    candidatesTruncated: before.length > MAX_AMBIGUITY_ID_SAMPLE || after.length > MAX_AMBIGUITY_ID_SAMPLE,
    evidence,
  };
}

function ambiguityComponents(before: SemanticProjectRecord[], after: SemanticProjectRecord[]): Array<{ before: SemanticProjectRecord[]; after: SemanticProjectRecord[] }> {
  const total = before.length + after.length; const parent = Array.from({ length: total }, (_, index) => index);
  const find = (value: number): number => { let cursor = value; while (parent[cursor] !== cursor) { parent[cursor] = parent[parent[cursor]!]!; cursor = parent[cursor]!; } return cursor; };
  const union = (left: number, right: number): void => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  const buckets = new Map<string, { before: number[]; after: number[] }>();
  const add = (side: "before" | "after", index: number, record: SemanticProjectRecord): void => {
    const compatible = compatibilityKey(record);
    for (const token of [`content:${compatible}:${record.contentFingerprint}`, `semantic:${compatible}:${record.semanticFingerprint}`, `name:${compatible}:${record.nameFingerprint}`]) {
      const bucket = buckets.get(token) ?? { before: [], after: [] }; bucket[side].push(index); buckets.set(token, bucket);
    }
  };
  before.forEach((record, index) => add("before", index, record)); after.forEach((record, index) => add("after", before.length + index, record));
  const participating = new Set<number>();
  for (const bucket of buckets.values()) {
    if (bucket.before.length === 0 || bucket.after.length === 0) continue;
    const first = bucket.before[0]!; for (const index of bucket.before) { participating.add(index); union(first, index); } for (const index of bucket.after) { participating.add(index); union(first, index); }
  }
  const grouped = new Map<number, { before: SemanticProjectRecord[]; after: SemanticProjectRecord[] }>();
  for (const index of participating) {
    const root = find(index); const group = grouped.get(root) ?? { before: [], after: [] };
    if (index < before.length) group.before.push(before[index]!); else group.after.push(after[index - before.length]!); grouped.set(root, group);
  }
  return [...grouped.values()].filter((group) => group.before.length > 0 && group.after.length > 0);
}

function auditDiffOutput(diff: SemanticProjectDiff): void {
  const hashPattern = /^sha256:[a-f0-9]{64}$/; const snapshotIdPattern = /^semantic-[a-z-]+-[a-f0-9]{20}-[1-9][0-9]*$/;
  const exactKeys = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  if (!exactKeys(diff, ["schema", "diff", "policy", "summary", "safety", "limitations", "items"]) || diff.schema !== SEMANTIC_PROJECT_DIFF_SCHEMA || !Array.isArray(diff.items) || diff.items.length > 24_000) throw new Error("semantic diff schema or bounds are invalid");
  if (!exactKeys(diff.diff, ["id", "beforeArtifactId", "afterArtifactId"]) || ![diff.diff.id, diff.diff.beforeArtifactId, diff.diff.afterArtifactId].every((value) => typeof value === "string" && hashPattern.test(value))) throw new Error("semantic diff identity is invalid");
  if (!exactKeys(diff.policy, ["profile"]) || !["strict", "collaboration", "local"].includes(diff.policy.profile)) throw new Error("semantic diff policy is invalid");
  if (!exactKeys(diff.summary, ["changed", "changes", "ambiguities", "incompleteSections"]) || typeof diff.summary.changed !== "boolean" || !Number.isInteger(diff.summary.changes) || diff.summary.changes < 0 || !Number.isInteger(diff.summary.ambiguities) || diff.summary.ambiguities < 0 || !Array.isArray(diff.summary.incompleteSections) || diff.summary.incompleteSections.some((section) => !["set", "tracks", "scenes", "locators", "clips", "devices", "dependencies", "unavailable"].includes(section))) throw new Error("semantic diff summary is invalid");
  if (!exactKeys(diff.safety, ["comparisonOnly", "mergeProposed", "crossRunSessionIdentityUsed", "mutationAuthorityGranted"]) || diff.safety.comparisonOnly !== true || diff.safety.mergeProposed !== false || diff.safety.crossRunSessionIdentityUsed !== false || diff.safety.mutationAuthorityGranted !== false) throw new Error("semantic diff safety is invalid");
  if (!Array.isArray(diff.limitations) || diff.limitations.length < 1 || diff.limitations.length > 16 || diff.limitations.some((value) => typeof value !== "string" || value.length < 1 || value.length > 4096)) throw new Error("semantic diff limitations are invalid");
  for (const item of diff.items) {
    if (item.type === "change") {
      if (!exactKeys(item, ["type", "section", "kind", "facets", "confidence", "evidence", "details", "detailsTruncated"], ["beforeSnapshotId", "afterSnapshotId"]) || !["exact-content", "unique-semantic", "unique-name", "absence"].includes(item.confidence) || !Array.isArray(item.facets) || item.facets.length < 1 || item.facets.some((facet) => !["added", "removed", "renamed", "reordered", "content-changed", "state-changed", "dependency-changed", "availability-changed"].includes(facet)) || typeof item.detailsTruncated !== "boolean") throw new Error("semantic diff change item is invalid");
      if ([item.beforeSnapshotId, item.afterSnapshotId].some((value) => value !== undefined && !snapshotIdPattern.test(value))) throw new Error("semantic diff change coordinate is invalid");
      if (!Array.isArray(item.details) || item.details.length > 64 || item.details.some((detail) => !exactKeys(detail, ["path", "before", "after"]) || typeof detail.path !== "string" || (detail.path !== "" && !detail.path.startsWith("/")))) throw new Error("semantic diff change details are invalid");
    } else if (item.type === "ambiguity") {
      if (!exactKeys(item, ["type", "section", "kind", "reason", "beforeCandidateCount", "afterCandidateCount", "candidateSetDigest", "beforeSnapshotIds", "afterSnapshotIds", "candidatesTruncated", "evidence"]) || !["indistinguishable-candidates", "incomplete-section"].includes(item.reason) || !Number.isInteger(item.beforeCandidateCount) || item.beforeCandidateCount < 0 || !Number.isInteger(item.afterCandidateCount) || item.afterCandidateCount < 0 || !hashPattern.test(item.candidateSetDigest) || !Array.isArray(item.beforeSnapshotIds) || !Array.isArray(item.afterSnapshotIds) || item.beforeSnapshotIds.length > MAX_AMBIGUITY_ID_SAMPLE || item.afterSnapshotIds.length > MAX_AMBIGUITY_ID_SAMPLE || item.beforeSnapshotIds.some((value) => typeof value !== "string" || !snapshotIdPattern.test(value)) || item.afterSnapshotIds.some((value) => typeof value !== "string" || !snapshotIdPattern.test(value)) || item.beforeCandidateCount < item.beforeSnapshotIds.length || item.afterCandidateCount < item.afterSnapshotIds.length || item.candidatesTruncated !== (item.beforeCandidateCount > item.beforeSnapshotIds.length || item.afterCandidateCount > item.afterSnapshotIds.length)) throw new Error("semantic diff ambiguity item is invalid");
      if (canonicalSemanticJson(item.beforeSnapshotIds) !== canonicalSemanticJson([...item.beforeSnapshotIds].sort(compareSemanticStrings)) || canonicalSemanticJson(item.afterSnapshotIds) !== canonicalSemanticJson([...item.afterSnapshotIds].sort(compareSemanticStrings))) throw new Error("semantic diff ambiguity samples are not deterministic");
    } else throw new Error("semantic diff item kind is invalid");
    if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 16 || item.evidence.some((value) => typeof value !== "string" || value.length < 1 || value.length > 4096)) throw new Error("semantic diff evidence is invalid");
  }
  const changes = diff.items.filter((item) => item.type === "change").length; const ambiguities = diff.items.length - changes;
  if (diff.summary.changed !== (diff.items.length > 0) || diff.summary.changes !== changes || diff.summary.ambiguities !== ambiguities || new Set(diff.summary.incompleteSections).size !== diff.summary.incompleteSections.length) throw new Error("semantic diff summary does not match its items");
  const visit = (value: unknown, key = "", depth = 0): void => {
    if (depth > 24) throw new Error("semantic diff exceeds audit depth");
    if (typeof value === "string") {
      if (key !== "path" && /(?:^|[\s"'(=])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|file:\/\/)/i.test(value)) throw new Error("semantic diff contains an absolute or network path");
      if (/(?:reusable[-_ ]?(?:token|secret|confirmation)|bearer\s+[A-Za-z0-9._-]{8,})/i.test(value)) throw new Error("semantic diff contains authority-like content");
      return;
    }
    if (Array.isArray(value)) { if (value.length > 24_000) throw new Error("semantic diff array exceeds bound"); for (const child of value) visit(child, key, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    const entries = Object.entries(value as Record<string, unknown>); if (entries.length > 64 || entries.some(([name]) => name.length > 128)) throw new Error("semantic diff object exceeds bound");
    for (const [name, child] of entries) {
      if (/(?:^|_)(?:session_ref|access_token|confirmation|secret|idempotency_key|mutation_authority)$/i.test(name.replace(/([a-z])([A-Z])/g, "$1_$2"))) throw new Error("semantic diff contains forbidden authority fields");
      visit(child, name, depth + 1);
    }
  };
  visit(diff); canonicalSemanticJson(diff);
  const { id: _id, ...identity } = diff.diff;
  if (diff.diff.id !== digest({ schema: SEMANTIC_PROJECT_DIFF_SCHEMA, identity, policy: diff.policy.profile, summary: diff.summary, safety: diff.safety, limitations: diff.limitations, items: diff.items })) throw new Error("semantic diff digest is invalid");
}

export function diffSemanticProjectSnapshots(before: SemanticProjectArtifact, after: SemanticProjectArtifact): SemanticProjectDiff {
  validateSemanticProjectArtifact(before); validateSemanticProjectArtifact(after);
  if (before.schema !== after.schema || before.schema !== SEMANTIC_PROJECT_SNAPSHOT_SCHEMA) throw new Error("semantic snapshots use incompatible schemas");
  if (before.policy.profile !== after.policy.profile) throw new Error("semantic snapshots use different privacy profiles");
  const items: SemanticProjectDiffItem[] = [];
  const sections = [...new Set([...Object.keys(before.manifest), ...Object.keys(after.manifest)])].sort() as SemanticProjectSection[];
  const incompleteSections = sections.filter((section) => !before.manifest[section].complete || !after.manifest[section].complete);
  for (const section of sections) {
    let remainingBefore = before.records.filter((record) => record.section === section);
    let remainingAfter = after.records.filter((record) => record.section === section);
    const matches: Array<{ before: SemanticProjectRecord; after: SemanticProjectRecord; confidence: SemanticProjectChange["confidence"] }> = [];
    for (const stage of [
      { key: (record: SemanticProjectRecord) => record.contentFingerprint, confidence: "exact-content" as const, compatible: (left: SemanticProjectRecord, right: SemanticProjectRecord) => left.kind === right.kind },
      { key: (record: SemanticProjectRecord) => record.semanticFingerprint, confidence: "unique-semantic" as const, compatible: semanticCompatible },
      { key: (record: SemanticProjectRecord) => record.nameFingerprint, confidence: "unique-name" as const, compatible: nameCompatible },
    ]) {
      const stageMatches = matchUnique(remainingBefore, remainingAfter, stage.key, stage.confidence, stage.compatible); matches.push(...stageMatches);
      const beforeMatched = new Set(stageMatches.map((match) => match.before)); const afterMatched = new Set(stageMatches.map((match) => match.after));
      remainingBefore = remainingBefore.filter((record) => !beforeMatched.has(record)); remainingAfter = remainingAfter.filter((record) => !afterMatched.has(record));
    }
    for (const match of matches) { const change = changeFor(match.before, match.after, match.confidence); if (change) items.push(change); }
    const components = ambiguityComponents(remainingBefore, remainingAfter);
    const ambiguousBefore = new Set(components.flatMap((component) => component.before)); const ambiguousAfter = new Set(components.flatMap((component) => component.after));
    for (const component of components) items.push(boundedAmbiguity(section, component.before[0]?.kind ?? component.after[0]?.kind ?? "record", "indistinguishable-candidates", component.before.map((record) => record.snapshotId), component.after.map((record) => record.snapshotId), ["multiple candidates share content, structure, or name evidence", "candidate counts and full-set digest cover any IDs omitted from the bounded sample", "incidental order and snapshot-local IDs were not used to choose a match"]));
    remainingBefore = remainingBefore.filter((record) => !ambiguousBefore.has(record)); remainingAfter = remainingAfter.filter((record) => !ambiguousAfter.has(record));
    const uncertainBefore = after.manifest[section]!.complete ? [] : remainingBefore;
    const uncertainAfter = before.manifest[section]!.complete ? [] : remainingAfter;
    if (!before.manifest[section]!.complete || !after.manifest[section]!.complete) items.push(boundedAmbiguity(section, "section-scope", "incomplete-section", uncertainBefore.map((record) => record.snapshotId), uncertainAfter.map((record) => record.snapshotId), ["at least one artifact truncated or omitted this section", "candidate counts and full-set digest cover any IDs omitted from the bounded sample", "definitive absence claims are suppressed"]));
    if (after.manifest[section]!.complete) for (const record of remainingBefore) items.push(absenceChange(record, "removed"));
    if (before.manifest[section]!.complete) for (const record of remainingAfter) items.push(absenceChange(record, "added"));
  }
  items.sort((left, right) => compareSemanticStrings(left.section, right.section) || compareSemanticStrings(left.kind, right.kind) || compareSemanticStrings(canonicalSemanticJson(left), canonicalSemanticJson(right)));
  const summary = { changed: items.length > 0, changes: items.filter((item) => item.type === "change").length, ambiguities: items.filter((item) => item.type === "ambiguity").length, incompleteSections };
  const safety = { comparisonOnly: true as const, mergeProposed: false as const, crossRunSessionIdentityUsed: false as const, mutationAuthorityGranted: false as const };
  const limitations = ["observational comparison only", "no .als edit or merge is proposed", "opaque plug-in and Max state is not decoded", "ambiguous candidates remain unresolved"];
  const identity = { beforeArtifactId: before.artifact.id, afterArtifactId: after.artifact.id };
  const result: SemanticProjectDiff = { schema: SEMANTIC_PROJECT_DIFF_SCHEMA, diff: { id: digest({ schema: SEMANTIC_PROJECT_DIFF_SCHEMA, identity, policy: before.policy.profile, summary, safety, limitations, items }), ...identity }, policy: { profile: before.policy.profile }, summary, safety, limitations, items };
  auditDiffOutput(result); return result;
}

function encodeCursor(diff: SemanticProjectDiff, offset: number): string {
  const payload = { diffId: diff.diff.id, offset, schema: SEMANTIC_PROJECT_DIFF_SCHEMA }; return Buffer.from(canonicalSemanticJson({ ...payload, checksum: shortDigest(payload) }), "utf8").toString("base64url");
}

function decodeCursor(diff: SemanticProjectDiff, cursor: string): number {
  let value: unknown; try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("semantic diff cursor is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic diff cursor is malformed");
  const row = value as Record<string, unknown>; const payload = { diffId: row.diffId, offset: row.offset, schema: row.schema };
  if (row.checksum !== shortDigest(payload) || row.diffId !== diff.diff.id || row.schema !== SEMANTIC_PROJECT_DIFF_SCHEMA || !Number.isInteger(row.offset) || (row.offset as number) < 0) throw new Error("semantic diff cursor does not match the diff");
  return row.offset as number;
}

export function pageSemanticProjectDiff(diff: SemanticProjectDiff, options: { limit?: number; cursor?: string } = {}): SemanticProjectDiffPage {
  auditDiffOutput(diff);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEMANTIC_PROJECT_MAX_PAGE_RECORDS) throw new Error("semantic diff or page limit is invalid");
  const offset = options.cursor ? decodeCursor(diff, options.cursor) : 0;
  if (offset > diff.items.length) throw new Error("semantic diff cursor offset is outside the diff");
  let count = Math.min(limit, diff.items.length - offset); const { items: _items, ...header } = diff;
  while (count > 0) {
    const complete = offset + count === diff.items.length;
    const trial = { ...header, page: { offset, returned: count, total: diff.items.length, complete, ...(!complete ? { nextCursor: encodeCursor(diff, offset + count) } : {}) }, items: diff.items.slice(offset, offset + count) };
    if (Buffer.byteLength(canonicalSemanticJson(trial)) <= SEMANTIC_PROJECT_MAX_PAGE_BYTES) break;
    count -= 1;
  }
  if (diff.items.length > offset && count === 0) throw new Error("one semantic diff item exceeds the page byte bound");
  const complete = offset + count === diff.items.length;
  return { ...header, page: { offset, returned: count, total: diff.items.length, complete, ...(!complete ? { nextCursor: encodeCursor(diff, offset + count) } : {}) }, items: diff.items.slice(offset, offset + count) };
}
