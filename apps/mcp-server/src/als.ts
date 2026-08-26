import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { decodeXmlAttribute, projectSourceEvidence, readSetSource, type SetSourceRead } from "./project.js";
import { createSemanticProjectSnapshot, type SemanticPrivacyProfile, type SemanticProjectArtifact } from "./project-semantic.js";
import type { Clip, Device, Note, Track } from "./live.js";
import type { LiveSnapshot } from "./live.js";

/**
 * Offline .als (Live Set) inspection: bounded gunzip + a deliberately small,
 * hardened XML reader, structural model extraction, semantic snapshot
 * assembly, canonical MIDI extraction, and findings-only lint.
 *
 * Everything here works with no bridge and no running Live. The XML reader is
 * not a general parser: DOCTYPE/ENTITY declarations are rejected outright (no
 * entity expansion is possible), element depth/attribute/text bounds are
 * enforced, and only the five predefined entities plus numeric character
 * references are decoded. Structure is extracted by tag name with documented
 * tolerance for Live version variation; anything not recognized is reported
 * as unavailable rather than fabricated.
 */

/* ------------------------------ XML reader -------------------------------- */

export interface AlsXmlNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: AlsXmlNode[];
  readonly text: string;
}

const MAX_XML_DEPTH = 64;
const MAX_XML_NODES = 400_000;
const MAX_XML_ATTRIBUTES = 64;
const MAX_XML_TEXT = 1024 * 1024;

function decodeXmlText(value: string): string {
  return decodeXmlAttribute(value);
}

/** Parse .als XML into a bounded tree. Throws on anything outside the tight
 * subset Live writes: no DOCTYPE, no ENTITY declarations, no namespaces that
 * escape the bound, no mixed content of consequence. */
export function parseAlsXml(xml: string): AlsXmlNode {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error("Live Set XML must not contain DOCTYPE or ENTITY declarations");
  if (xml.length > 64 * 1024 * 1024) throw new Error("Live Set XML exceeds the bounded size");
  let nodes = 0;
  type Draft = { tag: string; attrs: Record<string, string>; children: AlsXmlNode[]; text: string };
  const stack: Draft[] = [];
  let root: AlsXmlNode | null = null;
  let cursor = 0;
  const pushText = (raw: string): void => {
    if (raw.trim().length === 0) return;
    if (raw.length > MAX_XML_TEXT) throw new Error("Live Set XML text node exceeds the bounded size");
    const parent = stack[stack.length - 1];
    if (!parent) return;
    parent.text = `${parent.text}${decodeXmlText(raw)}`;
  };
  const tagPattern = /<(\/?)([A-Za-z_][A-Za-z0-9_.-]*)((?:\s+[A-Za-z_][A-Za-z0-9_.-]*="[^"]*")*)\s*(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(xml)) !== null) {
    if (match.index > cursor) pushText(xml.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;
    const [, closing, tag, rawAttrs, selfClosing] = match as unknown as [string, string, string, string, string];
    if (closing === "/") {
      const node = stack.pop();
      if (!node || node.tag !== tag) throw new Error(`Live Set XML is malformed (unexpected </${tag}>)`);
      const finished = node as AlsXmlNode;
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(finished);
      else if (root === null) root = finished;
      else throw new Error("Live Set XML has multiple roots");
      continue;
    }
    if (nodes >= MAX_XML_NODES) throw new Error("Live Set XML exceeds the bounded node count");
    nodes += 1;
    if (stack.length >= MAX_XML_DEPTH && selfClosing !== "/") throw new Error("Live Set XML exceeds the bounded depth");
    const attrs: Record<string, string> = {};
    const attrPairs = rawAttrs.match(/[A-Za-z_][A-Za-z0-9_.-]*="[^"]*"/g) ?? [];
    if (attrPairs.length > MAX_XML_ATTRIBUTES) throw new Error("Live Set XML element exceeds the bounded attribute count");
    for (const pair of attrPairs) {
      const separator = pair.indexOf("=");
      attrs[pair.slice(0, separator)] = decodeXmlAttribute(pair.slice(separator + 2, -1));
    }
    const node: AlsXmlNode = { tag, attrs, children: [], text: "" };
    if (selfClosing === "/") {
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root === null) root = node;
      else throw new Error("Live Set XML has multiple roots");
    } else {
      stack.push(node);
    }
  }
  if (xml.slice(cursor).trim().length > 0) pushText(xml.slice(cursor));
  if (stack.length > 0) throw new Error("Live Set XML is malformed (unclosed elements)");
  if (root === null) throw new Error("Live Set XML has no root element");
  return root;
}

/* --------------------------- structural model ----------------------------- */

export interface AlsNote extends Note {}

export interface AlsClipModel {
  readonly name: string;
  readonly kind: "midi" | "audio";
  readonly start: number;
  readonly length: number;
  readonly loopStart: number | null;
  readonly loopEnd: number | null;
  readonly looping: boolean | null;
  readonly muted: boolean | null;
  readonly warping: boolean | null;
  readonly samplePath: string | null;
  readonly sampleLengthBeats: number | null;
  readonly warpMarkerCount: number;
  readonly notes: Note[];
  readonly lane: "session" | "arrangement";
  readonly sceneIndex: number | null;
}

export interface AlsTrackModel {
  readonly name: string;
  readonly kind: "midi" | "audio" | "group" | "return" | "main";
  readonly colorIndex: number | null;
  readonly volume: number | null;
  readonly pan: number | null;
  readonly devices: Array<{ name: string; className: string }>;
  readonly clips: AlsClipModel[];
}

export interface AlsModel {
  readonly setName: string;
  readonly tempo: number | null;
  readonly creator: string | undefined;
  readonly majorVersion: string | undefined;
  readonly minorVersion: string | undefined;
  readonly tracks: AlsTrackModel[];
  readonly scenes: Array<{ name: string; tempo: number | null }>;
  readonly locators: Array<{ time: number; name: string }>;
  readonly parseNotes: string[];
}

function attrNumber(node: AlsXmlNode, name: string): number | null {
  const raw = node.attrs[name];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function childValue(node: AlsXmlNode, tag: string): string | null {
  const child = node.children.find((candidate) => candidate.tag === tag);
  const value = child?.attrs.Value ?? child?.text;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function descendants(node: AlsXmlNode, tag: string, into: AlsXmlNode[] = []): AlsXmlNode[] {
  for (const child of node.children) {
    if (child.tag === tag) into.push(child);
    descendants(child, tag, into);
  }
  return into;
}

function nearestAncestorTags(node: AlsXmlNode, parentMap: Map<AlsXmlNode, AlsXmlNode>): Set<string> {
  const tags = new Set<string>();
  let current = parentMap.get(node);
  while (current) {
    tags.add(current.tag);
    current = parentMap.get(current);
  }
  return tags;
}

const TRACK_TAGS: Record<string, AlsTrackModel["kind"]> = {
  MidiTrack: "midi", AudioTrack: "audio", GroupTrack: "group", ReturnTrack: "return", MasterTrack: "main", MainTrack: "main",
};

function parseNoteEvent(event: AlsXmlNode, keyTrack: AlsXmlNode): Note | null {
  const pitch = attrNumber(keyTrack, "MidiKey") ?? (() => { const key = keyTrack.children.find((child) => child.tag === "MidiKey"); return key ? attrNumber(key, "Value") : null; })();
  const time = attrNumber(event, "Time");
  const duration = attrNumber(event, "Duration");
  const velocity = attrNumber(event, "Velocity");
  if (pitch === null || time === null || duration === null || velocity === null) return null;
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) return null;
  if (time < 0 || duration <= 0) return null;
  const offVelocity = attrNumber(event, "OffVelocity");
  const probability = attrNumber(event, "Probability");
  const velocityDeviation = attrNumber(event, "VelocityDeviation");
  return {
    pitch, start: time, duration,
    velocity: Math.min(127, Math.max(1, Math.round(velocity))),
    channel: 1,
    mute: event.attrs.IsEnabled === "false",
    probability: probability !== null && probability >= 0 && probability <= 1 ? probability : 1,
    velocityDeviation: velocityDeviation !== null ? velocityDeviation : 0,
    releaseVelocity: offVelocity !== null ? Math.min(127, Math.max(0, Math.round(offVelocity))) : 64,
  };
}

function parseClip(clip: AlsXmlNode, lane: "session" | "arrangement", sceneIndex: number | null, parseNotes: string[]): AlsClipModel {
  const isMidi = clip.tag === "MidiClip";
  const name = childValue(clip, "Name") ?? "";
  const start = attrNumber(clip, "Time") ?? 0;
  const length = attrNumber(clip, "Length") ?? attrNumber(clip, "CurrentEnd") ?? 0;
  const notes: Note[] = [];
  if (isMidi) {
    let dropped = 0;
    for (const keyTrack of descendants(clip, "KeyTrack")) {
      const noteEvents = descendants(keyTrack, "NoteEvent");
      if (noteEvents.length > 10_000) { dropped += noteEvents.length - 10_000; noteEvents.length = 10_000; }
      for (const event of noteEvents) {
        const note = parseNoteEvent(event, keyTrack);
        if (note === null) dropped += 1;
        else notes.push(note);
      }
    }
    if (dropped > 0) parseNotes.push(`clip "${name}": ${dropped} malformed or overflow note event(s) dropped`);
  }
  const sampleRef = descendants(clip, "FileRef")[0];
  const samplePath = sampleRef ? childValue(sampleRef, "Path") ?? childValue(sampleRef, "RelativePath") : null;
  const loopNode = clip.children.find((child) => child.tag === "Loop");
  const loopOn = loopNode ? childValue(loopNode, "LoopOn") : null;
  const warpMarkers = descendants(clip, "WarpMarker");
  const warpingRaw = childValue(clip, "IsWarped") ?? childValue(clip, "Warping");
  return {
    name, kind: isMidi ? "midi" : "audio", start, length,
    loopStart: loopNode ? attrNumber(loopNode, "LoopStart") : null,
    loopEnd: loopNode ? attrNumber(loopNode, "LoopEnd") : null,
    looping: loopOn === null ? null : loopOn === "true" || loopOn === "1",
    muted: clip.attrs.Disabled === undefined ? null : clip.attrs.Disabled === "true",
    warping: warpingRaw === null ? null : warpingRaw === "true" || warpingRaw === "1",
    samplePath,
    sampleLengthBeats: attrNumber(clip, "SampleLength") ?? null,
    warpMarkerCount: warpMarkers.length,
    notes,
    lane, sceneIndex,
  };
}

/** Extract the honest structural model. Unknown regions are skipped, never
 * fabricated; dropped content is disclosed in parseNotes. */
export function modelFromAlsXml(root: AlsXmlNode, fallbackName: string): AlsModel {
  const parseNotes: string[] = [];
  if (root.tag !== "Ableton") throw new Error("Live Set XML root is not <Ableton>");
  const liveSet = root.children.find((child) => child.tag === "LiveSet") ?? root;
  const parentMap = new Map<AlsXmlNode, AlsXmlNode>();
  const indexParents = (node: AlsXmlNode): void => { for (const child of node.children) { parentMap.set(child, node); indexParents(child); } };
  indexParents(liveSet);

  const tracks: AlsTrackModel[] = [];
  const tracksContainer = descendants(liveSet, "Tracks")[0];
  const trackElements = [...(tracksContainer?.children ?? []), ...liveSet.children.filter((child) => child.tag === "MasterTrack" || child.tag === "MainTrack")];
  for (const element of trackElements) {
    const kind = TRACK_TAGS[element.tag];
    if (kind === undefined) continue;
    const nameNode = element.children.find((child) => child.tag === "Name") ?? element;
    const name = childValue(nameNode, "EffectiveName") ?? childValue(nameNode, "UserName") ?? "";
    const colorIndex = attrNumber(element.children.find((child) => child.tag === "Color") ?? element, "Value");
    const mixerNode = descendants(element, "Mixer")[0];
    const volume = mixerNode ? (() => { const v = descendants(mixerNode, "Volume")[0]; return v ? attrNumber(v.children.find((child) => child.tag === "Manual") ?? v, "Value") : null; })() : null;
    const pan = mixerNode ? (() => { const p = descendants(mixerNode, "Pan")[0]; return p ? attrNumber(p.children.find((child) => child.tag === "Manual") ?? p, "Value") : null; })() : null;
    const devicesNode = descendants(element, "Devices")[0];
    const devices = (devicesNode?.children ?? []).slice(0, 256).map((device) => ({
      className: device.tag,
      name: childValue(device, "UserName") ?? childValue(device, "EffectiveName") ?? device.tag,
    }));
    const clips: AlsClipModel[] = [];
    // Live nests an inner ClipSlot element inside the outer one; only the
    // outermost slots index the Session grid.
    const clipSlots = descendants(element, "ClipSlot").filter((slot) => parentMap.get(slot)?.tag !== "ClipSlot");
    let sessionOrder = 0;
    for (const slot of clipSlots) {
      const clip = slot.children.find((child) => child.tag === "MidiClip" || child.tag === "AudioClip") ?? descendants(slot, "MidiClip")[0] ?? descendants(slot, "AudioClip")[0];
      if (clip) clips.push(parseClip(clip, "session", sessionOrder, parseNotes));
      sessionOrder += 1;
    }
    for (const clip of [...descendants(element, "MidiClip"), ...descendants(element, "AudioClip")]) {
      const ancestors = nearestAncestorTags(clip, parentMap);
      if (ancestors.has("ClipSlot")) continue;
      if (ancestors.has("ArrangerAutomation") || ancestors.has("Events") || ancestors.has("Arrangement")) clips.push(parseClip(clip, "arrangement", null, parseNotes));
    }
    if (tracks.length >= 512) { parseNotes.push("track collection truncated at the 512-track bound"); break; }
    tracks.push({ name, kind, colorIndex: colorIndex !== null && colorIndex >= 0 && colorIndex <= 69 ? colorIndex : null, volume, pan, devices, clips });
  }

  const scenes: AlsModel["scenes"] = [];
  for (const scene of descendants(liveSet, "Scene").slice(0, 1024)) {
    scenes.push({ name: childValue(scene, "Name") ?? "", tempo: (() => { const tempo = descendants(scene, "Tempo")[0]; return tempo ? attrNumber(tempo.children.find((child) => child.tag === "Manual") ?? tempo, "Value") : null; })() });
  }

  const locators: AlsModel["locators"] = [];
  for (const locator of descendants(liveSet, "Locator").slice(0, 1024)) {
    const time = attrNumber(locator, "Time");
    if (time === null || time < 0) continue;
    locators.push({ time, name: childValue(locator, "Name") ?? "" });
  }
  locators.sort((a, b) => a.time - b.time);

  const tempoNode = descendants(liveSet, "Tempo")[0];
  const tempoManual = tempoNode ? attrNumber(tempoNode.children.find((child) => child.tag === "Manual") ?? tempoNode, "Value") : null;
  return {
    setName: fallbackName,
    tempo: tempoManual !== null && tempoManual >= 20 && tempoManual <= 999 ? tempoManual : null,
    creator: root.attrs.Creator, majorVersion: root.attrs.MajorVersion, minorVersion: root.attrs.MinorVersion,
    tracks, scenes, locators, parseNotes,
  };
}

/* ------------------------- semantic artifact ------------------------------ */

/** Build the versioned semantic snapshot artifact from one parsed .als file.
 * Live-only surfaces are recorded as explicitly unavailable; nothing is
 * fabricated. */
export function createOfflineAlsArtifact(source: SetSourceRead, model: AlsModel, options: { profile?: SemanticPrivacyProfile; exporterVersion: string; maxRecords?: number }): SemanticProjectArtifact {
  const tracks: Track[] = model.tracks.map((track, trackIndex) => ({
    ref: `offline:track:${trackIndex}` as Track["ref"],
    name: track.name,
    kind: track.kind,
    volume: track.volume ?? 0, pan: track.pan ?? 0,
    mute: null, solo: null, armed: null,
    clips: track.clips.filter((clip) => clip.lane === "session").map((clip, clipIndex) => alsClipToSnapshotClip(trackIndex, clipIndex, clip)),
    clipSlots: [],
    devices: track.devices.map((device, deviceIndex) => ({
      ref: `offline:device:${trackIndex}:${deviceIndex}`,
      name: device.name, className: device.className, kind: "device", enabled: null, parameters: [],
    })) as unknown as Device[],
    sends: [],
  })) as unknown as Track[];
  const arrangementClips = model.tracks.flatMap((track, trackIndex) =>
    track.clips.filter((clip) => clip.lane === "arrangement").map((clip) => ({ trackRef: `offline:track:${trackIndex}`, clip: alsClipToSnapshotClip(trackIndex, 0, clip) })));
  const snapshot = {
    set: { ref: "offline:set", name: model.setName, tempo: model.tempo ?? undefined },
    tracks,
    scenes: model.scenes.map((scene, index) => ({ ref: `offline:scene:${index}`, name: scene.name, index, colorIndex: null, tempo: scene.tempo })),
    arrangement: { length: model.locators.length > 0 ? model.locators[model.locators.length - 1]!.time : 0, locators: model.locators.map((locator, index) => ({ ref: `offline:locator:${index}`, name: locator.name, position: locator.time })) },
    arrangementClips,
  } as unknown as LiveSnapshot;
  const artifact = createSemanticProjectSnapshot(snapshot, {
    profile: options.profile ?? "collaboration",
    exporterVersion: options.exporterVersion,
    maxRecords: options.maxRecords,
    live: { protocol: "als-file/v1", adapter: "offline-file", provenance: "unknown" },
    sourceKind: "offline-file",
    sourceEvidence: projectSourceEvidence(source.path),
    extraUnavailable: [
      { field: "live-playback", reason: "playback, armed/monitoring, meters, and performance state exist only in a running Live and are absent from the file", sourceName: "offline-parse" },
      { field: "take-lanes", reason: "take-lane and comp structure is not reconstructed by the offline parser", sourceName: "offline-parse" },
      { field: "groove-pool", reason: "groove pool contents are not reconstructed by the offline parser", sourceName: "offline-parse" },
      { field: "tuning", reason: "tuning system and song scale are not reconstructed by the offline parser", sourceName: "offline-parse" },
      ...model.parseNotes.map((note) => ({ field: "parse-truncation", reason: note, sourceName: "offline-parse" })),
    ],
  });
  return artifact;
}

function alsClipToSnapshotClip(trackIndex: number, clipIndex: number, clip: AlsClipModel): Clip {
  return {
    ref: `offline:clip:${trackIndex}:${clip.lane}:${clip.sceneIndex ?? clipIndex}:${clip.start}` as Clip["ref"],
    name: clip.name, kind: clip.kind, start: clip.start, length: clip.length,
    notes: clip.notes, warp: clip.warping ?? false, takes: [], automation: [],
    loopStart: clip.loopStart, loopEnd: clip.loopEnd, looping: clip.looping, muted: clip.muted,
    filePath: clip.samplePath, sampleLength: clip.sampleLengthBeats,
  } as unknown as Clip;
}

/* ------------------------------ lint -------------------------------------- */

export interface AlsLintFinding {
  readonly severity: "info" | "warning" | "error";
  readonly check: string;
  readonly message: string;
  readonly object: { kind: string; name: string; index: number | null };
}

/** Bounded structural lint over the parsed model. Findings only — lint never
 * fixes. Media existence is checked (metadata only, bytes never read) and only
 * for references inside the operator-authorized root. */
export function lintAlsModel(model: AlsModel, options: { allowedRoot?: string; maxFindings?: number } = {}): { findings: AlsLintFinding[]; truncated: boolean } {
  const findings: AlsLintFinding[] = [];
  const truncated = { value: false };
  const push = (finding: AlsLintFinding): void => {
    if (findings.length >= (options.maxFindings ?? 512)) { truncated.value = true; return; }
    findings.push(finding);
  };
  const lastLocatorTime = model.locators.length > 0 ? model.locators[model.locators.length - 1]!.time : null;
  const mediaRoot = options.allowedRoot === undefined ? undefined : resolve(options.allowedRoot);
  const mediaRootPrefix = mediaRoot === undefined ? undefined : mediaRoot.endsWith(sep) ? mediaRoot : `${mediaRoot}${sep}`;
  const trackNameCounts = new Map<string, number>();
  for (const track of model.tracks) if (track.name) trackNameCounts.set(track.name, (trackNameCounts.get(track.name) ?? 0) + 1);
  const arrangementClipCount = model.tracks.reduce((sum, track) => sum + track.clips.filter((clip) => clip.lane === "arrangement").length, 0);
  if (arrangementClipCount > 500) push({ severity: "warning", check: "oversized-arrangement", message: `${arrangementClipCount} arrangement clips exceed the 500-clip review bound`, object: { kind: "set", name: model.setName, index: null } });
  model.tracks.forEach((track, trackIndex) => {
    if (track.name && (trackNameCounts.get(track.name) ?? 0) > 1) push({ severity: "info", check: "duplicate-track-name", message: `track name "${track.name}" appears ${trackNameCounts.get(track.name)} times`, object: { kind: "track", name: track.name, index: trackIndex } });
    if (track.clips.length === 0 && track.devices.length === 0) push({ severity: "info", check: "empty-track", message: `track "${track.name}" has no clips and no devices`, object: { kind: "track", name: track.name, index: trackIndex } });
    track.clips.forEach((clip, clipIndex) => {
      if (lastLocatorTime !== null && clip.lane === "arrangement" && clip.start > lastLocatorTime) push({ severity: "info", check: "clip-beyond-last-locator", message: `clip "${clip.name}" starts at ${clip.start} beats, beyond the last locator at ${lastLocatorTime}`, object: { kind: "clip", name: clip.name, index: clipIndex } });
      if (clip.kind === "audio" && clip.warping === false && clip.sampleLengthBeats !== null && clip.sampleLengthBeats > 60) push({ severity: "warning", check: "unwarped-long-sample", message: `audio clip "${clip.name}" is not warped over a ${clip.sampleLengthBeats}-beat sample`, object: { kind: "clip", name: clip.name, index: clipIndex } });
      if (clip.samplePath && mediaRoot !== undefined && mediaRootPrefix !== undefined) {
        const candidate = resolve(clip.samplePath);
        const within = candidate === mediaRoot || candidate.startsWith(mediaRootPrefix);
        if (within && !existsSync(candidate)) push({ severity: "error", check: "missing-sample-reference", message: `referenced sample is missing: ${basename(candidate)}`, object: { kind: "clip", name: clip.name, index: clipIndex } });
      }
    });
  });
  return { findings, truncated: truncated.value };
}

/** MIDI note sets per clip in the canonical note schema, keyed by a stable
 * offline coordinate. Feeds key estimation and diff without a bridge. */
export function extractAlsMidi(model: AlsModel): Array<{ track: string; trackIndex: number; clip: string; lane: string; sceneIndex: number | null; start: number; notes: Note[]; notesRevision: string }> {
  const rows: Array<{ track: string; trackIndex: number; clip: string; lane: string; sceneIndex: number | null; start: number; notes: Note[]; notesRevision: string }> = [];
  model.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (clip.kind !== "midi") continue;
      rows.push({
        track: track.name, trackIndex, clip: clip.name, lane: clip.lane, sceneIndex: clip.sceneIndex, start: clip.start,
        notes: clip.notes,
        notesRevision: createHash("sha256").update(JSON.stringify(clip.notes.map((note) => [note.pitch, note.start, note.duration, note.velocity]))).digest("hex"),
      });
    }
  });
  return rows;
}

/** Read, gunzip, parse, and model one owner-authorized .als file. */
export function readAlsModel(path: string): { source: SetSourceRead; model: AlsModel } {
  const source = readSetSource(path);
  const model = modelFromAlsXml(parseAlsXml(source.xml), basename(source.path, ".als"));
  return { source, model };
}
