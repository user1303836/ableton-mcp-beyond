import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { projectSourceEvidence, type ProjectSourceEvidence } from "./project.js";
import type { Clip, Device, LiveSnapshot, LiveStatus, Note, Track } from "./live.js";

export const SEMANTIC_PROJECT_SNAPSHOT_SCHEMA = "ableton-mcp-semantic-set-snapshot/v1" as const;
export const SEMANTIC_PROJECT_MAX_RECORDS = 12_000;
export const SEMANTIC_PROJECT_MAX_PAGE_RECORDS = 200;
export const SEMANTIC_PROJECT_MAX_PAGE_BYTES = 512 * 1024;
export const SEMANTIC_PROJECT_MAX_BUNDLE_BYTES = 24 * 1024 * 1024;
export const SEMANTIC_PROJECT_MAX_DIFF_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 512;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_NODES = 2_000_000;
const MAX_CANONICAL_ARRAY = 24_000;
const MAX_CANONICAL_FIELDS = 64;
const MAX_CANONICAL_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 4096;
const SECTION_ORDER = ["set", "tracks", "scenes", "locators", "clips", "devices", "dependencies", "unavailable"] as const;
export type SemanticProjectSection = typeof SECTION_ORDER[number];
export type SemanticPrivacyProfile = "strict" | "collaboration" | "local";
export type SemanticJson = null | boolean | number | string | SemanticJson[] | { [key: string]: SemanticJson };

export interface SemanticProjectRecord {
  section: SemanticProjectSection;
  kind: string;
  snapshotId: string;
  order: number;
  name?: string;
  contentFingerprint: string;
  semanticFingerprint: string;
  nameFingerprint: string;
  /** Policy-safe normative input for semantic matching. Validators recompute
   * every fingerprint; this is evidence, never cross-run object identity. */
  matching: Record<string, SemanticJson>;
  data: Record<string, SemanticJson>;
}

export interface SemanticSectionManifest {
  observed: number;
  included: number;
  omitted: number;
  complete: boolean;
  digest: string;
}

export interface SemanticProjectArtifact {
  schema: typeof SEMANTIC_PROJECT_SNAPSHOT_SCHEMA;
  artifact: { id: string; semanticHash: string; exporterVersion: string };
  policy: { profile: SemanticPrivacyProfile; names: "typed-aliases" | "retained"; paths: "typed-digests" | "basenames" | "project-relative-or-basename" };
  provenance: {
    source: "live-only" | "live+als";
    live: { protocol: string; adapter: string; provenance: string; registryHash?: string; version?: string };
    setFileSha256?: string;
    ableton?: { creator?: string; majorVersion?: string; minorVersion?: string; schemaChangeCount?: string };
    limitations: string[];
  };
  set: Record<string, SemanticJson>;
  manifest: Record<SemanticProjectSection, SemanticSectionManifest>;
  safety: { readOnly: true; containsSessionReferences: false; containsMutationAuthority: false; crossRunIdentityClaimed: false; mergeProposed: false };
  records: SemanticProjectRecord[];
}

export interface SemanticProjectPage extends Omit<SemanticProjectArtifact, "records"> {
  page: { offset: number; returned: number; total: number; complete: boolean; nextCursor?: string };
  records: SemanticProjectRecord[];
}

export interface CreateSemanticProjectOptions {
  profile?: SemanticPrivacyProfile;
  exporterVersion: string;
  live: Pick<LiveStatus, "protocol" | "adapter" | "provenance" | "registryHash"> & { version?: string };
  projectPath?: string;
  sourceEvidence?: ProjectSourceEvidence;
  maxRecords?: number;
}

function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("semantic artifact contains a non-finite number");
  return Object.is(value, -0) ? 0 : value;
}

export function compareSemanticStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalSemanticJson(value: unknown): string {
  let nodes = 0;
  const visit = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) throw new Error("semantic artifact exceeds the canonical node bound");
    if (depth > MAX_CANONICAL_DEPTH) throw new Error("semantic artifact exceeds the canonical depth bound");
    if (current === null || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") return JSON.stringify(normalizeNumber(current));
    if (typeof current === "string") {
      if (current.length > MAX_STRING_LENGTH) throw new Error("semantic artifact string exceeds the bound");
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_CANONICAL_ARRAY) throw new Error("semantic artifact array exceeds the bound");
      return `[${current.map((item) => visit(item, depth + 1)).join(",")}]`;
    }
    if (typeof current === "object") {
      const object = current as Record<string, unknown>; const keys = Object.keys(object);
      if (keys.length > MAX_CANONICAL_FIELDS || keys.some((key) => key.length > MAX_CANONICAL_KEY_LENGTH)) throw new Error("semantic artifact object exceeds field or key bounds");
      return `{${keys.sort(compareSemanticStrings).map((key) => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`).join(",")}}`;
    }
    throw new Error("semantic artifact contains an unsupported value");
  };
  return visit(value, 0);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSemanticJson(value)).digest("hex")}`;
}

function shortDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSemanticJson(value)).digest("hex").slice(0, 20);
}

function boundedString(value: unknown, fallback = "unavailable"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.normalize("NFC").slice(0, 512);
}

function looksLikeAbsolutePath(value: string): boolean {
  return /(?:^|[\s"'(=])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|file:\/\/)/i.test(value);
}

function looksLikeAuthority(value: string): boolean {
  return /(?:reusable[-_ ]?(?:(?:mutation|access|authority|confirmation|recovery)[-_ ]?)?(?:token|secret|confirmation)|bearer\s+[A-Za-z0-9._-]{8,}|(?:access|authority|idempotency|recovery|preflight)[-_ ]?(?:token|secret|key)\s*[:=]?)/i.test(value);
}

const LIVE_REFERENCE_KIND = "set|track|return[_-]track|main[_-]track|scene|clip[_-]slot|clip|session[_-]playback|arrangement[_-]clip|take[_-]lane(?:[_-]clip)?|groove|note|automation|locator|device|parameter|chain|drum[_-]pad|routing[_-]choice|browser[_-]item|selection";
function looksLikeLiveReference(value: string): boolean {
  return new RegExp(`^(?:[0-9]+:)?(?:${LIVE_REFERENCE_KIND}):[^\\s]+$`, "i").test(value);
}

function dynamicString(profile: SemanticPrivacyProfile, kind: string, value: unknown, strictAlias = false): string {
  const normalized = boundedString(value);
  if (looksLikeAbsolutePath(normalized) || looksLikeAuthority(normalized) || looksLikeLiveReference(normalized) || (profile === "strict" && strictAlias)) return `${kind}-${shortDigest([kind, normalized])}`;
  return normalized;
}

function safeScalar(value: unknown): SemanticJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return normalizeNumber(value);
  return null;
}

function dynamicScalar(profile: SemanticPrivacyProfile, kind: string, value: unknown, strictAlias = false): SemanticJson {
  return typeof value === "string" ? dynamicString(profile, kind, value, strictAlias) : safeScalar(value);
}

function nameFor(profile: SemanticPrivacyProfile, kind: string, value: unknown): string {
  return dynamicString(profile, kind, value, true);
}

function pathLocator(profile: SemanticPrivacyProfile, raw: string, resolvedPath: string | undefined, projectPath: string | undefined): string {
  const pathBase = basename(raw.replaceAll("\\", "/")) || "unnamed";
  if (profile === "strict") return `path-${shortDigest([raw, resolvedPath ?? null])}`;
  if (profile === "local" && resolvedPath && projectPath) {
    const projectDirectory = dirname(resolve(projectPath));
    const candidate = relative(projectDirectory, resolvedPath).replaceAll("\\", "/");
    if (candidate && !candidate.startsWith("../") && candidate !== ".." && !isAbsolute(candidate)) return candidate;
  }
  return pathBase;
}

function assertOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value as Record<string, unknown>).some((key) => !allowed.includes(key))) throw new Error(`semantic snapshot ${label} has unknown or malformed fields`);
}

const SAFE_AUTHORITY_METADATA_KEYS = new Set(["containsSessionReferences", "containsMutationAuthority", "crossRunIdentityClaimed"]);
function authorityAudit(value: unknown, depth = 0): void {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error("semantic output exceeds the audit depth bound");
  if (typeof value === "string") {
    if (looksLikeAbsolutePath(value)) throw new Error("semantic output contains an absolute, network, device, or file-URI path");
    if (looksLikeAuthority(value)) throw new Error("semantic output contains reusable authority-like content");
    if (looksLikeLiveReference(value)) throw new Error("semantic output contains a Live session reference-like value");
    return;
  }
  if (Array.isArray(value)) { for (const item of value) authorityAudit(item, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_AUTHORITY_METADATA_KEYS.has(key) && /(?:^|_)(?:ref|objectIdentity|epoch|revision|transactionId|confirmation|token|secret|idempotencyKey|mac|authority|recoveryToken|preflightToken|accessToken|sessionRef)$/i.test(key.replace(/([a-z])([A-Z])/g, "$1_$2"))) throw new Error(`semantic output contains forbidden session or authority field: ${key}`);
    authorityAudit(child, depth + 1);
  }
}

function noteContent(notes: Note[]): { count: number; pitchMin: number | null; pitchMax: number | null; end: number | null; hash: string } {
  const normalized = notes.map((note) => ({
    pitch: normalizeNumber(note.pitch), start: normalizeNumber(note.start), duration: normalizeNumber(note.duration), velocity: normalizeNumber(note.velocity), channel: normalizeNumber(note.channel),
    mute: note.mute ?? null, probability: note.probability ?? null, velocityDeviation: note.velocityDeviation ?? null, releaseVelocity: note.releaseVelocity ?? null,
  })).sort((a, b) => compareSemanticStrings(canonicalSemanticJson(a), canonicalSemanticJson(b)));
  const pitches = normalized.map((note) => note.pitch);
  const ends = normalized.map((note) => note.start + note.duration);
  return { count: normalized.length, pitchMin: pitches.length ? Math.min(...pitches) : null, pitchMax: pitches.length ? Math.max(...pitches) : null, end: ends.length ? Math.max(...ends) : null, hash: digest(normalized) };
}

function automationSummary(clip: Clip): Record<string, SemanticJson> {
  const direct = (clip.automation ?? []).map((point) => ({ time: normalizeNumber(point.time), value: normalizeNumber(point.value), curve: point.curve === undefined ? null : normalizeNumber(point.curve) })).sort((a, b) => compareSemanticStrings(canonicalSemanticJson(a), canonicalSemanticJson(b)));
  const envelopePointLists = Object.values(clip.envelopes ?? {}).map((points) => points.map((point) => ({ time: normalizeNumber(point.time), value: normalizeNumber(point.value), curve: point.curve === undefined ? null : normalizeNumber(point.curve) })).sort((a, b) => compareSemanticStrings(canonicalSemanticJson(a), canonicalSemanticJson(b)))).map((points) => ({ points: points.length, hash: digest(points) })).sort((a, b) => compareSemanticStrings(a.hash, b.hash));
  return { envelopeCount: envelopePointLists.length, pointCount: direct.length + envelopePointLists.reduce((sum, row) => sum + row.points, 0), contentHash: digest({ direct, envelopePointLists }) };
}

function deviceSemanticState(device: Device): { schemaHash: string; stateHash: string; visible: Record<string, SemanticJson> } {
  const parameters = (device.parameters ?? []).map((parameter) => ({
    name: boundedString(parameter.originalName ?? parameter.name), value: normalizeNumber(parameter.value), min: normalizeNumber(parameter.min), max: normalizeNumber(parameter.max), automatable: parameter.automatable,
    enabled: parameter.enabled ?? null, defaultValue: parameter.defaultValue === undefined ? null : parameter.defaultValue, state: parameter.state === undefined ? null : parameter.state,
    valueItems: (parameter.valueItems ?? []).slice(0, 256).map((item) => boundedString(item)),
  })).sort((a, b) => compareSemanticStrings(a.name, b.name) || compareSemanticStrings(canonicalSemanticJson(a), canonicalSemanticJson(b)));
  const parameterSchema = parameters.map(({ name, min, max, automatable, valueItems }) => ({ name, min, max, automatable, valueItems }));
  const specialized = {
    drift: device.drift ? { pitchBendRange: device.drift.pitchBendRange ?? null, voiceCount: device.drift.voiceCount ?? null, voiceMode: device.drift.voiceMode ?? null, modSourceCount: device.drift.modSources?.length ?? null, modTargetCount: device.drift.modTargets?.length ?? null } : null,
    eq8: device.eq8 ? { editMode: device.eq8.editMode ?? null, globalMode: device.eq8.globalMode ?? null, oversample: device.eq8.oversample ?? null, selectedBand: device.eq8.selectedBand ?? null } : null,
    hybridReverb: device.hybridReverb ? { irCategory: device.hybridReverb.irCategory ?? null, irFile: device.hybridReverb.irFile ?? null, attack: device.hybridReverb.attack ?? null, decay: device.hybridReverb.decay ?? null, size: device.hybridReverb.size ?? null } : null,
    meld: device.meld ? { engine: device.meld.engine ?? null, unison: device.meld.unison ?? null, monoPoly: device.meld.monoPoly ?? null, polyphony: device.meld.polyphony ?? null } : null,
    drumCell: device.drumCell ? { gain: device.drumCell.gain ?? null } : null,
    looper: device.looper ? { overdubAfterRecord: device.looper.overdubAfterRecord ?? null, recordLengthIndex: device.looper.recordLengthIndex ?? null, loopLength: device.looper.loopLength ?? null, tempo: device.looper.tempo ?? null, state: device.looper.state ?? null } : null,
    maxDevice: device.maxDevice ? { audioIns: device.maxDevice.audioIns?.length ?? null, audioOuts: device.maxDevice.audioOuts?.length ?? null, midiIns: device.maxDevice.midiIns?.length ?? null, midiOuts: device.maxDevice.midiOuts?.length ?? null } : null,
  };
  const visible: Record<string, SemanticJson> = {
    enabled: device.enabled ?? null,
    latencySamples: device.latencySamples ?? null,
    parameterCount: parameters.length,
    pluginPresetIndex: device.plugin?.selectedPresetIndex ?? null,
    pluginPresetCount: device.plugin?.presets?.length ?? null,
    rackVariationCount: device.variationCount ?? null,
    selectedVariationIndex: device.selectedVariationIndex ?? null,
    specializedHash: digest(specialized),
  };
  return { schemaHash: digest(parameterSchema), stateHash: digest({ parameters, visible }), visible };
}

function trackStructure(track: Track): Record<string, SemanticJson> {
  return {
    kind: track.kind,
    clipKinds: (track.clips ?? []).map((clip) => clip.kind).sort(),
    deviceClasses: (track.devices ?? []).map((device) => boundedString(device.className ?? device.kind)).sort(),
  };
}

function sectionForRecord(kind: string): SemanticProjectSection {
  if (kind === "set") return "set";
  if (kind === "track") return "tracks";
  if (kind === "scene") return "scenes";
  if (kind === "locator") return "locators";
  if (kind === "clip") return "clips";
  if (kind === "device") return "devices";
  if (kind === "dependency") return "dependencies";
  return "unavailable";
}

function createRecord(kind: string, order: number, name: string | undefined, data: Record<string, SemanticJson>, matching: Record<string, SemanticJson>): Omit<SemanticProjectRecord, "snapshotId"> {
  return {
    section: sectionForRecord(kind), kind, order, ...(name !== undefined ? { name } : {}), matching, data,
    contentFingerprint: digest({ kind, name: name ?? null, data }), semanticFingerprint: digest(matching), nameFingerprint: digest([kind, name ?? null]),
  };
}

function dependencyOrigin(raw: string, reference: { projectLocal?: boolean; resolution: ProjectSourceEvidence["references"][number]["resolution"] }): "project-local" | "external" | "pack" | "user-library" | "unknown" {
  const normalized = raw.replaceAll("\\", "/").toLowerCase();
  if (reference.resolution === "network" || reference.resolution === "oversized" || reference.resolution === "unresolved") return "unknown";
  if (reference.projectLocal === true) return "project-local";
  if (normalized.includes("/packs/") || normalized.includes("/factory packs/")) return "pack";
  if (normalized.includes("/user library/")) return "user-library";
  return reference.resolution === "absolute" ? "external" : "unknown";
}

function assignSnapshotIds(records: Array<Omit<SemanticProjectRecord, "snapshotId">>): SemanticProjectRecord[] {
  const counts = new Map<string, number>();
  return records.map((record) => {
    const base = `semantic-${record.kind}-${record.semanticFingerprint.slice("sha256:".length, "sha256:".length + 20)}`;
    const occurrence = (counts.get(base) ?? 0) + 1; counts.set(base, occurrence);
    return { ...record, snapshotId: `${base}-${occurrence}` };
  });
}

export function createSemanticProjectSnapshot(snapshot: LiveSnapshot, options: CreateSemanticProjectOptions): SemanticProjectArtifact {
  const profile = options.profile ?? "collaboration";
  if (!["strict", "collaboration", "local"].includes(profile)) throw new Error("unknown semantic snapshot privacy profile");
  const maxRecords = Math.min(Math.max(options.maxRecords ?? SEMANTIC_PROJECT_MAX_RECORDS, 1), SEMANTIC_PROJECT_MAX_RECORDS);
  const source = options.sourceEvidence ?? (options.projectPath ? projectSourceEvidence(options.projectPath) : undefined);
  const rawRecords: Array<Omit<SemanticProjectRecord, "snapshotId">> = [];
  const observed = Object.fromEntries(SECTION_ORDER.map((section) => [section, 0])) as Record<SemanticProjectSection, number>;
  const included = Object.fromEntries(SECTION_ORDER.map((section) => [section, 0])) as Record<SemanticProjectSection, number>;
  const push = (record: Omit<SemanticProjectRecord, "snapshotId">): void => {
    observed[record.section] += 1;
    if (rawRecords.length >= maxRecords) return;
    rawRecords.push(record); included[record.section] += 1;
  };
  const addUnavailable = (field: string, reason: string, sourceName: string, order = observed.unavailable): void => {
    const data: Record<string, SemanticJson> = { field, reason, source: sourceName, state: "unavailable" };
    push(createRecord("unavailable", order, undefined, data, { field, source: sourceName }));
  };
  const setName = nameFor(profile, "set", snapshot.set.name);
  const setData: Record<string, SemanticJson> = { tempo: safeScalar(snapshot.set.tempo), arrangementLength: safeScalar(snapshot.arrangement.length), trackCount: snapshot.tracks.length, sceneCount: snapshot.scenes.length };
  const set: Record<string, SemanticJson> = { name: setName, ...setData };
  push(createRecord("set", 0, setName, setData, { kind: "set" }));

  const trackCoordinates = new Map<string, string>(); const trackCoordinateCounts = new Map<string, number>();
  for (let index = 0; index < snapshot.tracks.length; index += 1) {
    const track = snapshot.tracks[index]!; const name = nameFor(profile, "track", track.name);
    const structureHash = digest(trackStructure(track)); const coordinateBase = `track-snapshot:${shortDigest({ kind: track.kind, name, structureHash })}`;
    const occurrence = (trackCoordinateCounts.get(coordinateBase) ?? 0) + 1; trackCoordinateCounts.set(coordinateBase, occurrence); trackCoordinates.set(track.ref, `${coordinateBase}-${occurrence}`);
  }
  for (let index = 0; index < snapshot.tracks.length; index += 1) {
    const track = snapshot.tracks[index]!; const name = nameFor(profile, "track", track.name); const structureHash = digest(trackStructure(track));
    const mixer: Record<string, SemanticJson> = track.mixer ? { volume: safeScalar(track.mixer.volume), pan: safeScalar(track.mixer.pan), cueVolume: safeScalar(track.mixer.cueVolume), mute: safeScalar(track.mixer.mute), solo: safeScalar(track.mixer.solo), sends: track.mixer.sends.slice(0, 128).map(safeScalar), trackActivator: safeScalar(track.mixer.trackActivator), crossfader: safeScalar(track.mixer.crossfader), crossfadeAssign: safeScalar(track.mixer.crossfadeAssign), panningMode: safeScalar(track.mixer.panningMode), panningLeft: safeScalar(track.mixer.panningLeft), panningRight: safeScalar(track.mixer.panningRight) } : { volume: safeScalar(track.volume), pan: safeScalar(track.pan), mute: safeScalar(track.mute), solo: safeScalar(track.solo), sends: track.sends.slice(0, 128).map(safeScalar) };
    const routing: Record<string, SemanticJson> = track.routing ? { inputType: dynamicScalar(profile, "routing", track.routing.inputType, true), inputSubRouting: dynamicScalar(profile, "routing", track.routing.inputSubRouting, true), outputType: dynamicScalar(profile, "routing", track.routing.outputType, true), outputSubRouting: dynamicScalar(profile, "routing", track.routing.outputSubRouting, true) } : { inputType: dynamicScalar(profile, "routing", track.input, true), outputType: dynamicScalar(profile, "routing", track.output, true) };
    const data: Record<string, SemanticJson> = { kind: track.kind, mixer, routing, armed: safeScalar(track.armed), monitoring: safeScalar(track.monitoringState), clipCount: track.clips.length, deviceCount: track.devices.length, structureHash, groupSnapshotId: track.groupTrackRef ? trackCoordinates.get(track.groupTrackRef) ?? null : null };
    push(createRecord("track", index, name, data, { trackKind: track.kind, structureHash }));
  }

  for (let index = 0; index < snapshot.scenes.length; index += 1) {
    const scene = snapshot.scenes[index]!; const name = nameFor(profile, "scene", scene.name);
    const slotContents = snapshot.tracks.map((track) => {
      const slot = track.clipSlots?.find((candidate) => candidate.sceneIndex === scene.index); const clip = slot?.clipRef ? track.clips.find((candidate) => candidate.ref === slot.clipRef) : undefined;
      return clip ? { kind: clip.kind, content: noteContent(clip.notes).hash, length: clip.length } : null;
    }).filter((value) => value !== null).sort((a, b) => compareSemanticStrings(canonicalSemanticJson(a), canonicalSemanticJson(b)));
    const structureHash = digest(slotContents);
    const data: Record<string, SemanticJson> = { colorIndex: scene.colorIndex ?? null, tempo: scene.tempo ?? null, tempoEnabled: scene.tempoEnabled ?? null, signatureNumerator: scene.signatureNumerator ?? null, signatureDenominator: scene.signatureDenominator ?? null, isEmpty: scene.isEmpty ?? null, structureHash };
    push(createRecord("scene", index, name, data, { structureHash }));
  }

  for (let index = 0; index < snapshot.arrangement.locators.length; index += 1) {
    const locator = snapshot.arrangement.locators[index]!; const name = nameFor(profile, "locator", locator.name); const position = normalizeNumber(locator.position); const data: Record<string, SemanticJson> = { position };
    push(createRecord("locator", index, name, data, { position }));
  }

  const clipDependencyRows: Array<{ raw: string; resolvedPath?: string; exists?: boolean; projectLocal?: boolean; resolution: ProjectSourceEvidence["references"][number]["resolution"]; evidence: string }> = [];
  const addClip = (clip: Clip, order: number, location: Record<string, SemanticJson>, parentSnapshotId: string | null): void => {
    const name = nameFor(profile, "clip", clip.name); const notes = noteContent(clip.notes ?? []); const automation = automationSummary(clip);
    const audioMetadata = { gain: clip.gain ?? null, pitchCoarse: clip.pitchCoarse ?? null, pitchFine: clip.pitchFine ?? null, warpMode: clip.warpMode ?? null, warping: clip.warping ?? clip.warp ?? null, sampleLength: clip.sampleLength ?? null };
    const length = normalizeNumber(clip.length); const audioMetadataHash = digest(audioMetadata);
    const data: Record<string, SemanticJson> = { clipKind: clip.kind, parentSnapshotId, location, start: normalizeNumber(clip.start), length, loopStart: clip.loopStart ?? null, loopEnd: clip.loopEnd ?? null, looping: clip.looping ?? null, muted: clip.muted ?? null, notes, automation, audioMetadataHash, rawAudioContent: "unavailable-not-read" };
    push(createRecord("clip", order, name, data, { clipKind: clip.kind, noteHash: notes.hash, length, audioMetadataHash }));
    if (typeof clip.filePath === "string" && clip.filePath.length > 0 && clip.filePath.length <= MAX_STRING_LENGTH) clipDependencyRows.push({ raw: clip.filePath, resolvedPath: isAbsolute(clip.filePath) ? resolve(clip.filePath) : undefined, resolution: isAbsolute(clip.filePath) ? "absolute" : "unresolved", evidence: "live-clip" });
  };
  let clipOrder = 0;
  for (const track of snapshot.tracks) {
    const parent = trackCoordinates.get(track.ref) ?? null; const slotByClip = new Map((track.clipSlots ?? []).filter((slot) => slot.clipRef).map((slot) => [slot.clipRef!, slot.sceneIndex]));
    for (const clip of track.clips) addClip(clip, clipOrder++, { lane: "session", sceneOrder: slotByClip.get(clip.ref) ?? null }, parent);
    for (const lane of track.takeLanes ?? []) for (const clip of lane.clips) addClip(clip, clipOrder++, { lane: "take-lane", laneOrder: lane.index }, parent);
  }
  for (const entry of snapshot.arrangementClips ?? []) addClip(entry.clip, clipOrder++, { lane: "arrangement" }, trackCoordinates.get(entry.trackRef) ?? null);

  const countDeviceTree = (root: Device): number => { let count = 0; const pending = [root]; while (pending.length > 0) { const current = pending.pop()!; count += 1; for (const chain of current.chains ?? []) pending.push(...chain.devices); for (const pad of current.drumPads ?? []) for (const chain of pad.chains) pending.push(...chain.devices); } return count; };
  let deviceOrder = 0;
  for (const track of snapshot.tracks) {
    const stack: Array<{ device: Device; depth: number; parentSnapshotId: string | null; siblingOrder: number }> = track.devices.map((device, siblingOrder) => ({ device, depth: 0, parentSnapshotId: trackCoordinates.get(track.ref) ?? null, siblingOrder })).reverse();
    while (stack.length > 0) {
      const row = stack.pop()!; const device = row.device;
      if (row.depth > 8) { observed.devices += countDeviceTree(device); addUnavailable("device-hierarchy", "device hierarchy exceeded the exporter depth bound", "live-snapshot"); continue; }
      const name = nameFor(profile, "device", device.name); const className = nameFor(profile, "device-class", device.className ?? device.kind); const state = deviceSemanticState(device);
      const plugin = device.kind === "plugin" || device.plugin !== undefined || /(?:plugin|vst|audio unit|auplugin)/i.test(device.className ?? "");
      const maxDevice = device.maxDevice !== undefined || /max/i.test(device.className ?? ""); const opaqueState = plugin || maxDevice;
      const matching: Record<string, SemanticJson> = { deviceKind: device.kind, className, parameterSchemaHash: state.schemaHash, opaqueState };
      const deviceCoordinate = `device-snapshot:${shortDigest({ parentSnapshotId: row.parentSnapshotId, name, className, siblingOrder: row.siblingOrder })}`;
      const data: Record<string, SemanticJson> = { deviceKind: device.kind, className, parentSnapshotId: row.parentSnapshotId, depth: row.depth, siblingOrder: row.siblingOrder, parameterSchemaHash: state.schemaHash, parameterStateHash: state.stateHash, opaqueState, state: state.visible };
      push(createRecord("device", deviceOrder++, name, data, matching));
      if (opaqueState) {
        const category = plugin ? "plug-in" : "max-device"; const dependencyName = nameFor(profile, category, device.name);
        const dependencyData: Record<string, SemanticJson> = { category, origin: plugin ? "plug-in" : "max", availability: "discovered", stateVisibility: "opaque", locator: dependencyName, evidence: "live-device", classificationEvidence: "live-generic-class", portability: "unknown" };
        push(createRecord("dependency", observed.dependencies, dependencyName, dependencyData, { category, className, opaqueState: true }));
        addUnavailable(`${category}-portability`, `${category} binary/blob portability is opaque and is not exported`, "live-device");
      }
      const childRows: Array<{ device: Device; parentSnapshotId: string; siblingOrder: number }> = [];
      for (const chain of device.chains ?? []) {
        const containerCoordinate = `chain-snapshot:${shortDigest({ parentSnapshotId: deviceCoordinate, chainIndex: chain.index, chainName: nameFor(profile, "chain", chain.name) })}`;
        chain.devices.forEach((child, siblingOrder) => childRows.push({ device: child, parentSnapshotId: containerCoordinate, siblingOrder }));
      }
      for (const pad of device.drumPads ?? []) for (const chain of pad.chains) {
        const containerCoordinate = `drum-pad-snapshot:${shortDigest({ parentSnapshotId: deviceCoordinate, padIndex: pad.index, padNote: pad.note ?? null, padName: nameFor(profile, "drum-pad", pad.name), chainIndex: chain.index, chainName: nameFor(profile, "chain", chain.name) })}`;
        chain.devices.forEach((child, siblingOrder) => childRows.push({ device: child, parentSnapshotId: containerCoordinate, siblingOrder }));
      }
      for (let index = childRows.length - 1; index >= 0; index -= 1) stack.push({ ...childRows[index]!, depth: row.depth + 1 });
    }
  }

  const referenceRows = [...(source?.references ?? []).map((reference) => ({ ...reference, raw: reference.value, evidence: "als-file-ref" })), ...clipDependencyRows];
  const dependencySeen = new Set<string>();
  for (const reference of referenceRows.sort((a, b) => compareSemanticStrings(a.raw, b.raw))) {
    const key = digest([reference.raw.replaceAll("\\", "/"), reference.resolvedPath ?? null]); if (dependencySeen.has(key)) continue; dependencySeen.add(key);
    const origin = dependencyOrigin(reference.raw, reference);
    const availability = reference.exists === false ? "missing" : reference.exists === true ? "discovered" : "unknown";
    const locator = pathLocator(profile, reference.raw, reference.resolvedPath, options.projectPath);
    const classificationEvidence = origin === "project-local" ? reference.exists === true ? "verified-realpath" : "missing-lexical-project-path" : origin === "pack" || origin === "user-library" ? "path-segment-heuristic" : reference.resolution === "network" ? "network-reference-blocked" : reference.resolution === "oversized" ? "oversized-reference-blocked" : "path-evidence";
    const locatorDigest = digest(reference.raw);
    const data: Record<string, SemanticJson> = { category: "media", origin, availability, stateVisibility: reference.resolution === "unresolved" || reference.resolution === "network" || reference.resolution === "oversized" ? "opaque" : "semantic", locator, locatorDigest, evidence: reference.evidence, classificationEvidence, portability: "unknown" };
    push(createRecord("dependency", observed.dependencies, locator, data, { category: "media", origin, locatorDigest }));
  }
  if (source && !source.referenceBounds.complete) {
    observed.dependencies += source.referenceBounds.omitted;
    addUnavailable("dependency-manifest", `at least ${source.referenceBounds.omitted} FileRef entry exceeded the bounded evidence collection; observed counts are lower bounds`, "als-file-ref-bound");
  }

  if (!source) addUnavailable("set-file-provenance", "the Live Set is unsaved or host file evidence is unavailable", "live-snapshot");
  if (!options.live.version && !source?.ableton.minorVersion && !source?.ableton.creator) addUnavailable("live-version", "Live version was not exposed by the adapter or saved Set", "provenance");
  if (!source) addUnavailable("dependency-manifest", "saved Set FileRef evidence is unavailable; only observed Live clip/device dependencies are included", "live-snapshot");
  addUnavailable("audio-content-hash", "referenced media bytes are never read by semantic export", "policy");
  if (source && source.manifest.tracks > snapshot.tracks.length) addUnavailable("tracks", `saved Set reports ${source.manifest.tracks} tracks while the bounded adapter snapshot supplied ${snapshot.tracks.length}`, "adapter-bound");
  if (source && source.manifest.scenes > snapshot.scenes.length) addUnavailable("scenes", `saved Set reports ${source.manifest.scenes} scenes while the bounded adapter snapshot supplied ${snapshot.scenes.length}`, "adapter-bound");
  // Saved-Set counts are bounded provenance evidence. Missing adapter rows are
  // observed-but-omitted so section completeness is derived from counts.
  if (source) {
    observed.tracks = Math.max(observed.tracks, source.manifest.tracks);
    observed.scenes = Math.max(observed.scenes, source.manifest.scenes);
  }

  const records = assignSnapshotIds(rawRecords);
  const recordsBySection = Object.fromEntries(SECTION_ORDER.map((section) => [section, records.filter((record) => record.section === section)])) as Record<SemanticProjectSection, SemanticProjectRecord[]>;
  const manifest = Object.fromEntries(SECTION_ORDER.map((section) => {
    const omitted = observed[section] - included[section];
    return [section, { observed: observed[section], included: included[section], omitted, complete: omitted === 0, digest: digest(recordsBySection[section]) }];
  })) as Record<SemanticProjectSection, SemanticSectionManifest>;
  const policy = { profile, names: profile === "strict" ? "typed-aliases" as const : "retained" as const, paths: profile === "strict" ? "typed-digests" as const : profile === "collaboration" ? "basenames" as const : "project-relative-or-basename" as const };
  const provenanceValue = (kind: string, value: unknown): string | undefined => {
    if (typeof value !== "string" || value.length === 0) return undefined;
    const normalized = value.normalize("NFC").slice(0, 128);
    if (looksLikeAbsolutePath(normalized) || looksLikeAuthority(normalized) || !/^[A-Za-z0-9 ._+()-]+$/.test(normalized)) return `${kind}-${shortDigest([kind, normalized])}`;
    return normalized;
  };
  const ableton = source ? {
    ...(provenanceValue("creator", source.ableton.creator) ? { creator: provenanceValue("creator", source.ableton.creator) } : {}),
    ...(provenanceValue("major-version", source.ableton.majorVersion) ? { majorVersion: provenanceValue("major-version", source.ableton.majorVersion) } : {}),
    ...(provenanceValue("minor-version", source.ableton.minorVersion) ? { minorVersion: provenanceValue("minor-version", source.ableton.minorVersion) } : {}),
    ...(provenanceValue("schema-change", source.ableton.schemaChangeCount) ? { schemaChangeCount: provenanceValue("schema-change", source.ableton.schemaChangeCount) } : {}),
  } : undefined;
  const liveVersion = provenanceValue("live-version", options.live.version ?? ableton?.minorVersion ?? ableton?.creator);
  const provenance: SemanticProjectArtifact["provenance"] = {
    source: source ? "live+als" : "live-only",
    live: { protocol: dynamicString(profile, "protocol", options.live.protocol), adapter: dynamicString(profile, "adapter", options.live.adapter), provenance: dynamicString(profile, "provenance", options.live.provenance ?? "unknown"), ...(options.live.registryHash ? { registryHash: dynamicString(profile, "registry-hash", options.live.registryHash) } : {}), ...(liveVersion ? { version: liveVersion } : {}) },
    ...(source ? { setFileSha256: source.manifest.sha256, ableton } : {}),
    limitations: ["host paging does not remove the existing bridge snapshot traversal/frame bounds", "Pack and User Library origins are path-segment heuristics, not installed ownership or portability claims", "opaque plug-in and Max state is not decoded"],
  };
  const safety = { readOnly: true as const, containsSessionReferences: false as const, containsMutationAuthority: false as const, crossRunIdentityClaimed: false as const, mergeProposed: false as const };
  const semanticHash = digest({ schema: SEMANTIC_PROJECT_SNAPSHOT_SCHEMA, policy, set, manifest, safety, records });
  const artifactWithoutId = { schema: SEMANTIC_PROJECT_SNAPSHOT_SCHEMA, exporterVersion: boundedString(options.exporterVersion), semanticHash, policy, provenance, set, manifest, safety, records };
  const artifact: SemanticProjectArtifact = { schema: SEMANTIC_PROJECT_SNAPSHOT_SCHEMA, artifact: { id: digest(artifactWithoutId), semanticHash, exporterVersion: boundedString(options.exporterVersion) }, policy, provenance, set, manifest, safety, records };
  authorityAudit(artifact);
  validateSemanticProjectArtifact(artifact);
  return artifact;
}

function encodeCursor(artifactId: string, profile: SemanticPrivacyProfile, offset: number): string {
  const payload = { artifactId, profile, offset, plan: "assemblable-v1", schema: SEMANTIC_PROJECT_SNAPSHOT_SCHEMA };
  const checksum = shortDigest(payload);
  return Buffer.from(canonicalSemanticJson({ ...payload, checksum }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, artifact: SemanticProjectArtifact): number {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("semantic snapshot cursor is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic snapshot cursor is malformed");
  const row = value as Record<string, unknown>; const payload = { artifactId: row.artifactId, profile: row.profile, offset: row.offset, plan: row.plan, schema: row.schema };
  if (row.checksum !== shortDigest(payload) || row.artifactId !== artifact.artifact.id || row.profile !== artifact.policy.profile || row.plan !== "assemblable-v1" || row.schema !== SEMANTIC_PROJECT_SNAPSHOT_SCHEMA || !Number.isInteger(row.offset) || (row.offset as number) < 0) throw new Error("semantic snapshot cursor does not match the artifact");
  return row.offset as number;
}

export function pageSemanticProjectSnapshot(artifact: SemanticProjectArtifact, options: { limit?: number; cursor?: string } = {}): SemanticProjectPage {
  validateSemanticProjectArtifact(artifact);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEMANTIC_PROJECT_MAX_PAGE_RECORDS) throw new Error("semantic snapshot page limit is invalid");
  const offset = options.cursor ? decodeCursor(options.cursor, artifact) : 0;
  if (offset > artifact.records.length) throw new Error("semantic snapshot cursor offset is outside the artifact");
  const header = { schema: artifact.schema, artifact: artifact.artifact, policy: artifact.policy, provenance: artifact.provenance, set: artifact.set, manifest: artifact.manifest, safety: artifact.safety };
  const boundedCount = (pageOffset: number): number => {
    let candidate = Math.min(limit, artifact.records.length - pageOffset);
    while (candidate > 0) {
      const complete = pageOffset + candidate === artifact.records.length;
      const trial = { ...header, page: { offset: pageOffset, returned: candidate, total: artifact.records.length, complete, ...(!complete ? { nextCursor: encodeCursor(artifact.artifact.id, artifact.policy.profile, pageOffset + candidate) } : {}) }, records: artifact.records.slice(pageOffset, pageOffset + candidate) };
      if (Buffer.byteLength(canonicalSemanticJson(trial)) <= SEMANTIC_PROJECT_MAX_PAGE_BYTES) return candidate;
      candidate -= 1;
    }
    return 0;
  };
  // The first page proves that this limit yields a complete bounded bundle.
  // Continuation cursors bind that non-authoritative fact to the artifact, so
  // later page calls avoid replanning from offset zero. Assembly still checks
  // every page and the aggregate limits independently.
  if (!options.cursor) {
    let plannedOffset = 0; let plannedPages = 0; let plannedBytes = 2;
    while (plannedOffset < artifact.records.length && plannedPages <= MAX_PAGES && plannedBytes <= SEMANTIC_PROJECT_MAX_BUNDLE_BYTES) {
      const plannedCount = boundedCount(plannedOffset); if (plannedCount === 0) break;
      const plannedComplete = plannedOffset + plannedCount === artifact.records.length;
      const plannedPage = { ...header, page: { offset: plannedOffset, returned: plannedCount, total: artifact.records.length, complete: plannedComplete, ...(!plannedComplete ? { nextCursor: encodeCursor(artifact.artifact.id, artifact.policy.profile, plannedOffset + plannedCount) } : {}) }, records: artifact.records.slice(plannedOffset, plannedOffset + plannedCount) };
      plannedBytes += Buffer.byteLength(canonicalSemanticJson(plannedPage)) + (plannedPages > 0 ? 1 : 0); plannedOffset += plannedCount; plannedPages += 1;
    }
    if (plannedOffset !== artifact.records.length || plannedPages > MAX_PAGES || plannedBytes > SEMANTIC_PROJECT_MAX_BUNDLE_BYTES) throw new Error("semantic snapshot page limit is too small for an assemblable bounded plan");
  }
  const count = boundedCount(offset);
  if (artifact.records.length > offset && count === 0) throw new Error("one semantic record exceeds the page byte bound");
  const complete = offset + count === artifact.records.length;
  const page: SemanticProjectPage = { ...header, page: { offset, returned: count, total: artifact.records.length, complete, ...(!complete ? { nextCursor: encodeCursor(artifact.artifact.id, artifact.policy.profile, offset + count) } : {}) }, records: artifact.records.slice(offset, offset + count) };
  authorityAudit(page);
  return page;
}

function artifactDigestInput(artifact: SemanticProjectArtifact): unknown {
  const { id: _id, ...artifactIdentity } = artifact.artifact;
  return { schema: artifact.schema, exporterVersion: artifactIdentity.exporterVersion, semanticHash: artifactIdentity.semanticHash, policy: artifact.policy, provenance: artifact.provenance, set: artifact.set, manifest: artifact.manifest, safety: artifact.safety, records: artifact.records };
}

function assertRequiredKeys(value: unknown, required: readonly string[], label: string): asserts value is Record<string, unknown> {
  assertOnlyKeys(value, required, label);
  const object = value as Record<string, unknown>;
  if (required.some((key) => !(key in object))) throw new Error(`semantic snapshot ${label} is missing required fields`);
}

function assertString(value: unknown, label: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_STRING_LENGTH || (pattern && !pattern.test(value))) throw new Error(`semantic snapshot ${label} is invalid`);
}

function assertJsonShape(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error(`semantic snapshot ${label} exceeds depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { normalizeNumber(value); return; }
  if (typeof value === "string") { if (value.length > MAX_STRING_LENGTH) throw new Error(`semantic snapshot ${label} string exceeds bound`); return; }
  if (Array.isArray(value)) { if (value.length > 256) throw new Error(`semantic snapshot ${label} array exceeds bound`); for (const item of value) assertJsonShape(item, label, depth + 1); return; }
  if (!value || typeof value !== "object") throw new Error(`semantic snapshot ${label} contains a non-JSON value`);
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > MAX_CANONICAL_FIELDS || keys.some((key) => key.length > MAX_CANONICAL_KEY_LENGTH)) throw new Error(`semantic snapshot ${label} object exceeds bound`);
  for (const child of Object.values(value as Record<string, unknown>)) assertJsonShape(child, label, depth + 1);
}

function isNullableNumber(value: unknown): boolean { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function isNullableBoolean(value: unknown): boolean { return value === null || typeof value === "boolean"; }
function isNullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function isNonnegativeInteger(value: unknown): boolean { return Number.isInteger(value) && (value as number) >= 0; }
function assertValues(object: Record<string, unknown>, keys: readonly string[], predicate: (value: unknown) => boolean, label: string): void {
  if (keys.some((key) => !predicate(object[key]))) throw new Error(`semantic snapshot ${label} has invalid field types`);
}

function assertNestedRecordSchema(record: SemanticProjectRecord): void {
  const data = record.data; const matching = record.matching; const hashPattern = /^sha256:[a-f0-9]{64}$/; const coordinatePattern = /^(?:track|device|chain|drum-pad)-snapshot:[a-f0-9]{20}(?:-[1-9][0-9]*)?$/;
  const exactMatching: Record<string, readonly string[]> = {
    set: ["kind"], track: ["trackKind", "structureHash"], scene: ["structureHash"], locator: ["position"], clip: ["clipKind", "noteHash", "length", "audioMetadataHash"], device: ["deviceKind", "className", "parameterSchemaHash", "opaqueState"], dependency: record.data.category === "media" ? ["category", "origin", "locatorDigest"] : ["category", "className", "opaqueState"], unavailable: ["field", "source"],
  };
  assertRequiredKeys(matching, exactMatching[record.kind] ?? [], `${record.kind} matching data`);
  if (record.kind === "set") {
    assertRequiredKeys(data, ["tempo", "arrangementLength", "trackCount", "sceneCount"], "Set record data"); assertValues(data, ["tempo", "arrangementLength"], isNullableNumber, "Set record data");
    if (![data.trackCount, data.sceneCount].every((value) => Number.isInteger(value) && (value as number) >= 0) || matching.kind !== "set") throw new Error("semantic snapshot Set record values are invalid");
  } else if (record.kind === "track") {
    assertRequiredKeys(data, ["kind", "mixer", "routing", "armed", "monitoring", "clipCount", "deviceCount", "structureHash", "groupSnapshotId"], "track record data");
    assertOnlyKeys(data.mixer, ["volume", "pan", "cueVolume", "mute", "solo", "sends", "trackActivator", "crossfader", "crossfadeAssign", "panningMode", "panningLeft", "panningRight"], "track mixer");
    assertOnlyKeys(data.routing, ["inputType", "inputSubRouting", "outputType", "outputSubRouting"], "track routing");
    const mixer = data.mixer as Record<string, unknown>; assertValues(mixer, ["volume", "pan", "cueVolume", "crossfader", "crossfadeAssign", "panningMode", "panningLeft", "panningRight"].filter((key) => key in mixer), isNullableNumber, "track mixer"); assertValues(mixer, ["mute", "solo", "trackActivator"].filter((key) => key in mixer), isNullableBoolean, "track mixer");
    if (!Array.isArray(mixer.sends) || mixer.sends.length > 128 || !mixer.sends.every(isNullableNumber)) throw new Error("semantic snapshot track sends are invalid");
    const routing = data.routing as Record<string, unknown>; assertValues(routing, Object.keys(routing), isNullableString, "track routing");
    if (!["audio", "midi", "group", "return", "main", "master", "regular"].includes(String(data.kind)) || !isNullableBoolean(data.armed) || !(data.monitoring === null || ["in", "auto", "off"].includes(String(data.monitoring))) || !isNonnegativeInteger(data.clipCount) || !isNonnegativeInteger(data.deviceCount) || typeof data.structureHash !== "string" || !hashPattern.test(data.structureHash) || !(data.groupSnapshotId === null || typeof data.groupSnapshotId === "string" && coordinatePattern.test(data.groupSnapshotId)) || matching.trackKind !== data.kind || matching.structureHash !== data.structureHash) throw new Error("semantic snapshot track values are invalid");
  } else if (record.kind === "scene") {
    assertRequiredKeys(data, ["colorIndex", "tempo", "tempoEnabled", "signatureNumerator", "signatureDenominator", "isEmpty", "structureHash"], "scene record data"); assertValues(data, ["colorIndex", "tempo", "signatureNumerator", "signatureDenominator"], isNullableNumber, "scene data"); assertValues(data, ["tempoEnabled", "isEmpty"], isNullableBoolean, "scene data"); if (typeof data.structureHash !== "string" || !hashPattern.test(data.structureHash) || matching.structureHash !== data.structureHash || (data.colorIndex !== null && !isNonnegativeInteger(data.colorIndex)) || (data.signatureNumerator !== null && !isNonnegativeInteger(data.signatureNumerator)) || (data.signatureDenominator !== null && !isNonnegativeInteger(data.signatureDenominator))) throw new Error("semantic snapshot scene values are invalid");
  } else if (record.kind === "locator") { assertRequiredKeys(data, ["position"], "locator record data"); if (typeof data.position !== "number" || matching.position !== data.position) throw new Error("semantic snapshot locator values are invalid"); }
  else if (record.kind === "clip") {
    assertRequiredKeys(data, ["clipKind", "parentSnapshotId", "location", "start", "length", "loopStart", "loopEnd", "looping", "muted", "notes", "automation", "audioMetadataHash", "rawAudioContent"], "clip record data");
    assertOnlyKeys(data.location, ["lane", "sceneOrder", "laneOrder"], "clip location");
    assertRequiredKeys(data.notes, ["count", "pitchMin", "pitchMax", "end", "hash"], "clip note summary");
    assertRequiredKeys(data.automation, ["envelopeCount", "pointCount", "contentHash"], "clip automation summary");
    const location = data.location as Record<string, unknown>; const notes = data.notes as Record<string, unknown>; const automation = data.automation as Record<string, unknown>;
    if (!["midi", "audio"].includes(String(data.clipKind)) || !(data.parentSnapshotId === null || typeof data.parentSnapshotId === "string" && coordinatePattern.test(data.parentSnapshotId)) || !["session", "take-lane", "arrangement"].includes(String(location.lane)) || ("sceneOrder" in location && location.sceneOrder !== null && !isNonnegativeInteger(location.sceneOrder)) || ("laneOrder" in location && !isNonnegativeInteger(location.laneOrder)) || ![data.start, data.length].every((value) => typeof value === "number" && Number.isFinite(value)) || (data.length as number) < 0 || ![data.loopStart, data.loopEnd].every(isNullableNumber) || ![data.looping, data.muted].every(isNullableBoolean) || !isNonnegativeInteger(notes.count) || ![notes.pitchMin, notes.pitchMax, notes.end].every(isNullableNumber) || !hashPattern.test(String(notes.hash)) || !isNonnegativeInteger(automation.envelopeCount) || !isNonnegativeInteger(automation.pointCount) || !hashPattern.test(String(automation.contentHash)) || !hashPattern.test(String(data.audioMetadataHash)) || data.rawAudioContent !== "unavailable-not-read" || matching.clipKind !== data.clipKind || matching.noteHash !== notes.hash || matching.length !== data.length || matching.audioMetadataHash !== data.audioMetadataHash) throw new Error("semantic snapshot clip values are invalid");
  } else if (record.kind === "device") {
    assertRequiredKeys(data, ["deviceKind", "className", "parentSnapshotId", "depth", "siblingOrder", "parameterSchemaHash", "parameterStateHash", "opaqueState", "state"], "device record data");
    assertRequiredKeys(data.state, ["enabled", "latencySamples", "parameterCount", "pluginPresetIndex", "pluginPresetCount", "rackVariationCount", "selectedVariationIndex", "specializedHash"], "device visible state"); const state = data.state as Record<string, unknown>;
    if (!["instrument", "audio-effect", "midi-effect", "plugin", "rack", "device"].includes(String(data.deviceKind)) || typeof data.className !== "string" || !(data.parentSnapshotId === null || typeof data.parentSnapshotId === "string" && coordinatePattern.test(data.parentSnapshotId)) || !isNonnegativeInteger(data.depth) || (data.depth as number) > 8 || !isNonnegativeInteger(data.siblingOrder) || !hashPattern.test(String(data.parameterSchemaHash)) || !hashPattern.test(String(data.parameterStateHash)) || typeof data.opaqueState !== "boolean" || !isNullableBoolean(state.enabled) || !["latencySamples", "parameterCount", "pluginPresetIndex", "pluginPresetCount", "rackVariationCount", "selectedVariationIndex"].every((key) => isNullableNumber(state[key])) || !["parameterCount", "pluginPresetIndex", "pluginPresetCount", "rackVariationCount", "selectedVariationIndex"].every((key) => state[key] === null || isNonnegativeInteger(state[key])) || !hashPattern.test(String(state.specializedHash)) || matching.deviceKind !== data.deviceKind || matching.className !== data.className || matching.parameterSchemaHash !== data.parameterSchemaHash || matching.opaqueState !== data.opaqueState) throw new Error("semantic snapshot device values are invalid");
  } else if (record.kind === "dependency") {
    const required = ["category", "origin", "availability", "stateVisibility", "locator", "evidence", "classificationEvidence", "portability"];
    assertOnlyKeys(data, [...required, "locatorDigest"], "dependency record data");
    const media = data.category === "media";
    if (required.some((key) => !(key in data)) || !["media", "plug-in", "max-device"].includes(String(data.category)) || !["project-local", "external", "pack", "user-library", "unknown", "plug-in", "max"].includes(String(data.origin)) || !["missing", "discovered", "unknown"].includes(String(data.availability)) || !["opaque", "semantic"].includes(String(data.stateVisibility)) || !["locator", "evidence", "classificationEvidence", "portability"].every((key) => typeof data[key] === "string") || data.portability !== "unknown" || !["live-device", "als-file-ref", "live-clip"].includes(String(data.evidence)) || !["live-generic-class", "verified-realpath", "missing-lexical-project-path", "path-segment-heuristic", "network-reference-blocked", "oversized-reference-blocked", "path-evidence"].includes(String(data.classificationEvidence)) || (media && (typeof data.locatorDigest !== "string" || !hashPattern.test(data.locatorDigest) || matching.category !== "media" || matching.origin !== data.origin || matching.locatorDigest !== data.locatorDigest)) || (!media && ("locatorDigest" in data || !["plug-in", "max-device"].includes(String(matching.category)) || typeof matching.className !== "string" || matching.opaqueState !== true || data.availability !== "discovered" || data.stateVisibility !== "opaque")) || (data.category === "plug-in" && data.origin !== "plug-in") || (data.category === "max-device" && data.origin !== "max")) throw new Error("semantic snapshot dependency record data is invalid");
  } else if (record.kind === "unavailable") { assertRequiredKeys(data, ["field", "reason", "source", "state"], "unavailable record data"); if (!["field", "reason", "source"].every((key) => typeof data[key] === "string") || data.state !== "unavailable" || matching.field !== data.field || matching.source !== data.source) throw new Error("semantic snapshot unavailable values are invalid"); }
  else throw new Error("semantic snapshot record kind is invalid");
  assertJsonShape(data, `${record.kind} data`); assertJsonShape(matching, `${record.kind} matching data`);
}

export function validateSemanticProjectArtifact(artifact: SemanticProjectArtifact): void {
  if (!artifact || artifact.schema !== SEMANTIC_PROJECT_SNAPSHOT_SCHEMA || !Array.isArray(artifact.records) || artifact.records.length > SEMANTIC_PROJECT_MAX_RECORDS) throw new Error("semantic snapshot artifact schema or record bound is invalid");
  assertRequiredKeys(artifact, ["schema", "artifact", "policy", "provenance", "set", "manifest", "safety", "records"], "artifact");
  assertRequiredKeys(artifact.artifact, ["id", "semanticHash", "exporterVersion"], "identity");
  assertRequiredKeys(artifact.policy, ["profile", "names", "paths"], "policy");
  assertOnlyKeys(artifact.provenance, ["source", "live", "setFileSha256", "ableton", "limitations"], "provenance");
  if (!("source" in artifact.provenance) || !("live" in artifact.provenance) || !("limitations" in artifact.provenance)) throw new Error("semantic snapshot provenance is incomplete");
  assertRequiredKeys(artifact.provenance.live, ["protocol", "adapter", "provenance", ...("registryHash" in artifact.provenance.live ? ["registryHash"] : []), ...("version" in artifact.provenance.live ? ["version"] : [])], "Live provenance");
  if (artifact.provenance.ableton !== undefined) {
    assertOnlyKeys(artifact.provenance.ableton, ["creator", "majorVersion", "minorVersion", "schemaChangeCount"], "Ableton provenance");
    for (const value of Object.values(artifact.provenance.ableton)) assertString(value, "Ableton provenance value", /^[A-Za-z0-9 ._+()-]+$/);
  }
  assertRequiredKeys(artifact.set, ["name", "tempo", "arrangementLength", "trackCount", "sceneCount"], "Set summary");
  assertRequiredKeys(artifact.safety, ["readOnly", "containsSessionReferences", "containsMutationAuthority", "crossRunIdentityClaimed", "mergeProposed"], "safety contract");
  const hashPattern = /^sha256:[a-f0-9]{64}$/; const rawHashPattern = /^[a-f0-9]{64}$/;
  assertString(artifact.artifact.id, "artifact id", hashPattern); assertString(artifact.artifact.semanticHash, "semantic hash", hashPattern); assertString(artifact.artifact.exporterVersion, "exporter version");
  const policyTuples = { strict: ["typed-aliases", "typed-digests"], collaboration: ["retained", "basenames"], local: ["retained", "project-relative-or-basename"] } as const;
  const tuple = policyTuples[artifact.policy.profile];
  if (!tuple || artifact.policy.names !== tuple[0] || artifact.policy.paths !== tuple[1]) throw new Error("semantic snapshot privacy policy tuple is invalid");
  const live = artifact.provenance.live;
  if (!["live-only", "live+als"].includes(artifact.provenance.source) || typeof live.protocol !== "string" || !/^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/.test(live.protocol) || !["simulator", "remote-script", "extension", "unavailable"].includes(live.adapter) || !["real-live", "fake-live", "simulator", "unknown"].includes(live.provenance)) throw new Error("semantic snapshot Live provenance values are invalid");
  if (live.registryHash !== undefined && (typeof live.registryHash !== "string" || !rawHashPattern.test(live.registryHash))) throw new Error("semantic snapshot registry hash is invalid");
  if (live.version !== undefined) assertString(live.version, "Live version", /^[A-Za-z0-9 ._+()-]+$/);
  if (!Array.isArray(artifact.provenance.limitations) || artifact.provenance.limitations.length < 1 || artifact.provenance.limitations.length > 16) throw new Error("semantic snapshot provenance limitations are invalid");
  for (const limitation of artifact.provenance.limitations) assertString(limitation, "provenance limitation");
  if ((artifact.provenance.source === "live+als") !== (typeof artifact.provenance.setFileSha256 === "string")) throw new Error("semantic snapshot Set-file provenance relationship is invalid");
  if (artifact.provenance.setFileSha256 !== undefined && !rawHashPattern.test(artifact.provenance.setFileSha256)) throw new Error("semantic snapshot Set SHA is invalid");
  assertString(artifact.set.name, "Set name");
  if (![artifact.set.tempo, artifact.set.arrangementLength].every(isNullableNumber) || !isNonnegativeInteger(artifact.set.trackCount) || !isNonnegativeInteger(artifact.set.sceneCount)) throw new Error("semantic snapshot Set summary values are invalid");
  if (artifact.safety.readOnly !== true || artifact.safety.containsMutationAuthority !== false || artifact.safety.containsSessionReferences !== false || artifact.safety.crossRunIdentityClaimed !== false || artifact.safety.mergeProposed !== false) throw new Error("semantic snapshot safety contract is invalid");
  authorityAudit(artifact); canonicalSemanticJson(artifact);
  assertRequiredKeys(artifact.manifest, SECTION_ORDER, "manifest");
  const snapshotIds = new Set<string>(); const occurrenceCounts = new Map<string, number>();
  for (const record of artifact.records) {
    const required = ["section", "kind", "snapshotId", "order", "contentFingerprint", "semanticFingerprint", "nameFingerprint", "matching", "data"];
    assertOnlyKeys(record, [...required, "name"], "record");
    if (required.some((key) => !(key in record)) || !SECTION_ORDER.includes(record.section) || sectionForRecord(record.kind) !== record.section || !isNonnegativeInteger(record.order) || !Number.isSafeInteger(record.order)) throw new Error("semantic snapshot record identity is invalid");
    if (record.name !== undefined) {
      assertString(record.name, "record name"); if (record.name.length > 512) throw new Error("semantic snapshot record name exceeds the bound");
      if (artifact.policy.profile === "strict" && !/^[a-z-]+-[a-f0-9]{20}$/.test(record.name)) throw new Error("strict semantic snapshot record name is not a typed alias");
    }
    assertString(record.snapshotId, "snapshot-local id", /^semantic-[a-z-]+-[a-f0-9]{20}-[1-9][0-9]*$/);
    if (snapshotIds.has(record.snapshotId)) throw new Error("semantic snapshot IDs must be unique"); snapshotIds.add(record.snapshotId);
    assertNestedRecordSchema(record);
    if (record.contentFingerprint !== digest({ kind: record.kind, name: record.name ?? null, data: record.data }) || record.semanticFingerprint !== digest(record.matching) || record.nameFingerprint !== digest([record.kind, record.name ?? null])) throw new Error("semantic snapshot record fingerprint is invalid");
    const base = `semantic-${record.kind}-${record.semanticFingerprint.slice("sha256:".length, "sha256:".length + 20)}`; const occurrence = (occurrenceCounts.get(base) ?? 0) + 1; occurrenceCounts.set(base, occurrence);
    if (record.snapshotId !== `${base}-${occurrence}`) throw new Error("semantic snapshot ID occurrence derivation is invalid");
  }
  for (const section of SECTION_ORDER) {
    const rows = artifact.records.filter((record) => record.section === section); const manifest = artifact.manifest[section];
    assertRequiredKeys(manifest, ["observed", "included", "omitted", "complete", "digest"], `${section} manifest`);
    if (![manifest.observed, manifest.included, manifest.omitted].every(isNonnegativeInteger) || typeof manifest.complete !== "boolean" || !hashPattern.test(manifest.digest) || manifest.included !== rows.length || manifest.digest !== digest(rows) || manifest.observed !== manifest.included + manifest.omitted || manifest.complete !== (manifest.omitted === 0)) throw new Error(`semantic snapshot ${section} manifest is invalid`);
  }
  const setRecord = artifact.records.find((record) => record.kind === "set");
  if (!setRecord || artifact.manifest.set.included !== 1 || canonicalSemanticJson(artifact.set) !== canonicalSemanticJson({ name: setRecord.name, ...setRecord.data })) throw new Error("semantic snapshot Set summary does not match its record");
  const semanticHash = digest({ schema: artifact.schema, policy: artifact.policy, set: artifact.set, manifest: artifact.manifest, safety: artifact.safety, records: artifact.records });
  if (semanticHash !== artifact.artifact.semanticHash || digest(artifactDigestInput(artifact)) !== artifact.artifact.id) throw new Error("semantic snapshot artifact digest is invalid");
}

export function assembleSemanticProjectPages(pages: SemanticProjectPage[]): SemanticProjectArtifact {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_PAGES || Buffer.byteLength(canonicalSemanticJson(pages)) > SEMANTIC_PROJECT_MAX_BUNDLE_BYTES) throw new Error("semantic snapshot page bundle is empty or exceeds bounds");
  const ordered = [...pages];
  const first = ordered[0]!; let expectedOffset = 0; const records: SemanticProjectRecord[] = [];
  const header = (page: SemanticProjectPage): unknown => ({ schema: page.schema, artifact: page.artifact, policy: page.policy, provenance: page.provenance, set: page.set, manifest: page.manifest, safety: page.safety });
  const expectedHeader = canonicalSemanticJson(header(first));
  for (const page of ordered) {
    assertOnlyKeys(page, ["schema", "artifact", "policy", "provenance", "set", "manifest", "safety", "page", "records"], "page");
    assertOnlyKeys(page.page, ["offset", "returned", "total", "complete", "nextCursor"], "page coordinates");
    if (!Array.isArray(page.records) || !Number.isInteger(page.page.offset) || !Number.isInteger(page.page.returned) || !Number.isInteger(page.page.total)) throw new Error("semantic snapshot page coordinates are malformed");
    const pageComplete = page.page.offset + page.records.length === page.page.total;
    const expectedCursor = pageComplete ? undefined : encodeCursor(first.artifact.id, first.policy.profile, page.page.offset + page.records.length);
    if (Buffer.byteLength(canonicalSemanticJson(page)) > SEMANTIC_PROJECT_MAX_PAGE_BYTES || canonicalSemanticJson(header(page)) !== expectedHeader || page.page.offset !== expectedOffset || page.page.returned !== page.records.length || page.page.total !== first.page.total || page.page.complete !== pageComplete || page.page.nextCursor !== expectedCursor) throw new Error("semantic snapshot pages are inconsistent, overlapping, reordered, tampered, or non-contiguous");
    records.push(...page.records); expectedOffset += page.records.length;
  }
  if (!ordered.at(-1)!.page.complete || expectedOffset !== first.page.total || records.length > SEMANTIC_PROJECT_MAX_RECORDS) throw new Error("semantic snapshot page bundle is incomplete");
  const artifact: SemanticProjectArtifact = { schema: first.schema, artifact: first.artifact, policy: first.policy, provenance: first.provenance, set: first.set, manifest: first.manifest, safety: first.safety, records };
  validateSemanticProjectArtifact(artifact);
  return artifact;
}
