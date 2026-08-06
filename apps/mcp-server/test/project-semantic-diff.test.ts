import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { DeterministicLiveSimulator, type Device, type LiveSnapshot, type Track } from "../src/live.js";
import { createSemanticProjectSnapshot, type SemanticPrivacyProfile } from "../src/project-semantic.js";
import { projectSourceEvidence } from "../src/project.js";
import { diffSemanticProjectSnapshots, pageSemanticProjectDiff } from "../src/project-semantic-diff.js";

function artifact(snapshot: LiveSnapshot, profile: SemanticPrivacyProfile = "collaboration", maxRecords?: number) {
  return createSemanticProjectSnapshot(snapshot, { profile, exporterVersion: "test", live: { protocol: "ableton-live/v1", adapter: "simulator", provenance: "simulator" }, ...(maxRecords ? { maxRecords } : {}) });
}

function clonedTrack(snapshot: LiveSnapshot, index: number, name: string): Track {
  const track = structuredClone(snapshot.tracks[0]!); track.ref = `track:${index}` as any; track.objectIdentity = `identity:${index}`; track.name = name; track.clips = []; track.clipSlots = []; track.devices = [];
  return track;
}

test("unchanged semantic artifacts produce an empty comparison-only no-merge diff", () => {
  const snapshot = new DeterministicLiveSimulator().snapshot(); const result = diffSemanticProjectSnapshots(artifact(snapshot), artifact(structuredClone(snapshot)));
  assert.equal(result.summary.changed, false); assert.equal(result.items.length, 0); assert.equal(result.safety.mergeProposed, false); assert.equal(result.safety.crossRunSessionIdentityUsed, false); assert.match(result.limitations.join(" "), /no \.als edit or merge/);
});

test("Set-level tempo and name changes are semantic changes", () => {
  const before = new DeterministicLiveSimulator().snapshot(); const after = structuredClone(before); after.set.tempo = 128; after.set.name = "Renamed Set";
  const result = diffSemanticProjectSnapshots(artifact(before), artifact(after));
  assert.ok(result.items.some((item) => item.type === "change" && item.section === "set" && item.facets.includes("renamed") && item.facets.includes("content-changed")));
});

test("unique reorder and rename do not churn into additions and removals", () => {
  const before = new DeterministicLiveSimulator().snapshot(); before.tracks = [clonedTrack(before, 1, "Drums"), clonedTrack(before, 2, "Bass")];
  before.tracks[0]!.kind = "midi"; before.tracks[1]!.kind = "audio";
  const after = structuredClone(before); after.tracks.reverse(); after.tracks[1]!.name = "Percussion";
  const result = diffSemanticProjectSnapshots(artifact(before), artifact(after)); const trackChanges = result.items.filter((item) => item.type === "change" && item.section === "tracks");
  assert.ok(trackChanges.some((item) => item.type === "change" && item.facets.includes("renamed") && !item.facets.includes("content-changed"))); assert.ok(trackChanges.some((item) => item.type === "change" && item.facets.includes("reordered")));
  assert.equal(trackChanges.some((item) => item.type === "change" && (item.facets.includes("added") || item.facets.includes("removed"))), false);
});

test("duplicate names with distinct content match, while indistinguishable duplicates stay ambiguous", () => {
  const before = new DeterministicLiveSimulator().snapshot(); before.tracks = [clonedTrack(before, 1, "Duplicate"), clonedTrack(before, 2, "Duplicate")]; before.tracks[0]!.kind = "midi"; before.tracks[1]!.kind = "audio";
  const after = structuredClone(before); after.tracks.reverse();
  const distinct = diffSemanticProjectSnapshots(artifact(before), artifact(after)); assert.equal(distinct.items.some((item) => item.type === "ambiguity" && item.section === "tracks"), false);

  before.tracks[1]!.kind = "midi"; after.tracks = structuredClone(before.tracks).reverse();
  const ambiguous = diffSemanticProjectSnapshots(artifact(before), artifact(after)); const ambiguity = ambiguous.items.find((item) => item.type === "ambiguity" && item.section === "tracks");
  assert.ok(ambiguity && ambiguity.type === "ambiguity");
  assert.equal(ambiguous.items.some((item) => item.type === "change" && item.section === "tracks" && (item.facets.includes("added") || item.facets.includes("removed"))), false);
});

test("changed plug-in state is a state change and replacement is add/remove while dependencies remain opaque", () => {
  const before = new DeterministicLiveSimulator().snapshot(); const plugin: Device = { ref: "device:plugin" as any, name: "Synth", kind: "plugin", className: "VstPluginDevice", parameters: [{ ref: "parameter:one" as any, name: "Cutoff", value: 0.5, min: 0, max: 1, automatable: true }], plugin: { presets: ["Init"], selectedPresetIndex: 0 } };
  before.tracks[0]!.devices = [plugin]; const changed = structuredClone(before); changed.tracks[0]!.devices[0]!.parameters[0]!.value = 0.75;
  const stateDiff = diffSemanticProjectSnapshots(artifact(before), artifact(changed));
  assert.ok(stateDiff.items.some((item) => item.type === "change" && item.section === "devices" && item.facets.includes("state-changed")));
  const opaque = artifact(changed).records.find((record) => record.section === "dependencies" && record.data.category === "plug-in"); assert.equal(opaque?.data.stateVisibility, "opaque");

  const replacement = structuredClone(before); replacement.tracks[0]!.devices[0]!.name = "Other Synth"; replacement.tracks[0]!.devices[0]!.className = "AuPluginDevice";
  const replacementDiff = diffSemanticProjectSnapshots(artifact(before), artifact(replacement)); const deviceChanges = replacementDiff.items.filter((item) => item.type === "change" && item.section === "devices");
  assert.ok(deviceChanges.some((item) => item.type === "change" && item.facets.includes("removed"))); assert.ok(deviceChanges.some((item) => item.type === "change" && item.facets.includes("added")));
});

test("missing media transitions are dependency and availability changes", () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-diff-media-"));
  try {
    const media = join(root, "sample.wav"); const set = join(root, "Set.als"); writeFileSync(media, "metadata-only sentinel"); writeFileSync(set, gzipSync(Buffer.from(`<Ableton><FileRef><Path Value="${media}"/></FileRef></Ableton>`)));
    const snapshot = new DeterministicLiveSimulator().snapshot(); snapshot.set.filePath = set;
    const make = () => createSemanticProjectSnapshot(snapshot, { profile: "collaboration", exporterVersion: "test", live: { protocol: "ableton-live/v1", adapter: "simulator", provenance: "simulator" }, projectPath: set, sourceEvidence: projectSourceEvidence(set) });
    const before = make(); unlinkSync(media); const after = make(); const result = diffSemanticProjectSnapshots(before, after);
    assert.ok(result.items.some((item) => item.type === "change" && item.section === "dependencies" && item.facets.includes("dependency-changed") && item.facets.includes("availability-changed")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("incomplete sections suppress definitive absence claims", () => {
  const before = new DeterministicLiveSimulator().snapshot(); before.tracks = [clonedTrack(before, 1, "One"), clonedTrack(before, 2, "Two")];
  const after = structuredClone(before); after.tracks.pop();
  const result = diffSemanticProjectSnapshots(artifact(before, "collaboration", 1), artifact(after, "collaboration", 1));
  assert.ok(result.items.some((item) => item.type === "ambiguity" && item.reason === "incomplete-section"));
  assert.equal(result.items.some((item) => item.type === "change" && item.section === "tracks" && item.facets.includes("removed")), false);
});

test("diff rejects privacy mismatch and tampered artifact digests", () => {
  const snapshot = new DeterministicLiveSimulator().snapshot();
  assert.throws(() => diffSemanticProjectSnapshots(artifact(snapshot, "strict"), artifact(snapshot, "local")), /privacy profiles/);
  const tampered = artifact(snapshot); tampered.records[0]!.data.kind = "tampered";
  assert.throws(() => diffSemanticProjectSnapshots(tampered, artifact(snapshot)), /digest|manifest|unknown or malformed/);
});

test("same-class opaque plug-in replacement remains explicit ambiguity while same-name state changes match", () => {
  const before = new DeterministicLiveSimulator().snapshot(); const plugin: Device = { ref: "device:opaque" as any, name: "Synth A", kind: "plugin", className: "VstPluginDevice", parameters: [{ ref: "parameter:opaque" as any, name: "Cutoff", value: 0.5, min: 0, max: 1, automatable: true }], plugin: { presets: [], selectedPresetIndex: 0 } };
  before.tracks[0]!.devices = [plugin]; const replacement = structuredClone(before); replacement.tracks[0]!.devices[0]!.name = "Synth B";
  const result = diffSemanticProjectSnapshots(artifact(before), artifact(replacement));
  assert.ok(result.items.some((item) => item.type === "ambiguity" && (item.section === "devices" || item.section === "dependencies")));
  assert.equal(result.items.some((item) => item.type === "change" && item.confidence === "unique-semantic" && item.facets.includes("renamed")), false);
});

test("snapshot-local parent coordinates expose cross-track clip and nested-device topology without matching by them", () => {
  const before = new DeterministicLiveSimulator().snapshot(); const clip = structuredClone(before.tracks[0]!.clips[0]!);
  before.tracks = [clonedTrack(before, 1, "Track A"), clonedTrack(before, 2, "Track B")]; before.arrangementClips = [{ trackRef: before.tracks[0]!.ref, clip }];
  const moved = structuredClone(before); moved.arrangementClips![0]!.trackRef = moved.tracks[1]!.ref;
  const clipDiff = diffSemanticProjectSnapshots(artifact(before), artifact(moved));
  assert.ok(clipDiff.items.some((item) => item.type === "change" && item.section === "clips" && item.facets.includes("content-changed") && item.details.some((detail) => detail.path.includes("parentSnapshotId"))));

  const child: Device = { ref: "device:child" as any, name: "Child", kind: "audio-effect", className: "Utility", parameters: [] };
  const rack = (ref: string, withChild: boolean): Device => ({ ref: ref as any, name: "Rack", kind: "rack", className: "AudioEffectGroupDevice", parameters: [], chains: [{ ref: `chain:${ref}` as any, parentRef: ref as any, index: 0, name: "Chain", mute: false, solo: false, devices: withChild ? [structuredClone(child)] : [] }] });
  before.arrangementClips = []; before.tracks[0]!.devices = [rack("rack:a", true)]; before.tracks[1]!.devices = [rack("rack:b", false)];
  const deviceMoved = structuredClone(before); deviceMoved.tracks[0]!.devices[0]!.chains![0]!.devices = []; deviceMoved.tracks[1]!.devices[0]!.chains![0]!.devices = [structuredClone(child)];
  const deviceDiff = diffSemanticProjectSnapshots(artifact(before), artifact(deviceMoved));
  assert.ok(deviceDiff.items.some((item) => item.type === "change" && item.section === "devices" && item.facets.includes("state-changed") && item.details.some((detail) => detail.path.includes("parentSnapshotId"))));

  const siblingRack = rack("rack:siblings", false); siblingRack.chains = [0, 1].map((index) => ({ ref: `chain:sibling-${index}` as any, parentRef: siblingRack.ref, index, name: `Chain ${index}`, mute: false, solo: false, devices: index === 0 ? [structuredClone(child)] : [] }));
  before.tracks[0]!.devices = [siblingRack]; before.tracks[1]!.devices = [];
  const chainMoved = structuredClone(before); chainMoved.tracks[0]!.devices[0]!.chains![0]!.devices = []; chainMoved.tracks[0]!.devices[0]!.chains![1]!.devices = [structuredClone(child)];
  const chainDiff = diffSemanticProjectSnapshots(artifact(before), artifact(chainMoved));
  assert.ok(chainDiff.items.some((item) => item.type === "change" && item.section === "devices" && item.details.some((detail) => detail.path.includes("parentSnapshotId"))));

  const drumRack: Device = { ref: "rack:drum" as any, name: "Drum Rack", kind: "rack", className: "DrumGroupDevice", parameters: [], drumPads: [0, 1].map((index) => ({ ref: `pad:${index}` as any, parentRef: "rack:drum" as any, index, note: 36 + index, name: `Pad ${index}`, mute: false, chains: [{ ref: `pad-chain:${index}` as any, parentRef: `pad:${index}` as any, index: 0, name: "Pad Chain", mute: false, solo: false, devices: index === 0 ? [structuredClone(child)] : [] }] })) };
  before.tracks[0]!.devices = [drumRack]; const padMoved = structuredClone(before); padMoved.tracks[0]!.devices[0]!.drumPads![0]!.chains[0]!.devices = []; padMoved.tracks[0]!.devices[0]!.drumPads![1]!.chains[0]!.devices = [structuredClone(child)];
  const padDiff = diffSemanticProjectSnapshots(artifact(before), artifact(padMoved));
  assert.ok(padDiff.items.some((item) => item.type === "change" && item.section === "devices" && item.details.some((detail) => detail.path.includes("parentSnapshotId"))));
});

test("maximum duplicate ambiguity is indexed, sampled, and pageable", () => {
  const snapshot = new DeterministicLiveSimulator().snapshot(); snapshot.tracks = Array.from({ length: 11_995 }, (_, index) => clonedTrack(snapshot, index, "Duplicate"));
  const value = artifact(snapshot); const started = Date.now(); const result = diffSemanticProjectSnapshots(value, value);
  const ambiguity = result.items.find((item) => item.type === "ambiguity" && item.section === "tracks");
  assert.ok(ambiguity?.type === "ambiguity"); assert.equal(ambiguity.beforeCandidateCount, 11_995); assert.equal(ambiguity.afterCandidateCount, 11_995); assert.equal(ambiguity.candidatesTruncated, true); assert.equal(ambiguity.beforeSnapshotIds.length, 128);
  const page = pageSemanticProjectDiff(result, { limit: 200 }); assert.ok(page.items.length > 0); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024); assert.ok(Date.now() - started < 10_000);
});

test("diff paging is bounded, deterministic, and rejects cursor reuse", () => {
  const before = new DeterministicLiveSimulator().snapshot(); before.tracks = Array.from({ length: 10 }, (_, index) => { const track = clonedTrack(before, index, `Before ${index}`); track.devices = [{ ref: `device:${index}` as any, name: `Device ${index}`, kind: "device", className: `UniqueClass${index}`, parameters: [] }]; return track; });
  const after = structuredClone(before); for (let index = 0; index < after.tracks.length; index += 1) after.tracks[index]!.name = `After ${index}`;
  const diff = diffSemanticProjectSnapshots(artifact(before), artifact(after)); const first = pageSemanticProjectDiff(diff, { limit: 3 }); assert.equal(first.items.length, 3); assert.ok(first.page.nextCursor);
  const second = pageSemanticProjectDiff(diff, { limit: 3, cursor: first.page.nextCursor }); assert.equal(second.page.offset, 3);
  const other = diffSemanticProjectSnapshots(artifact(after), artifact(before)); assert.throws(() => pageSemanticProjectDiff(other, { cursor: first.page.nextCursor }), /does not match/);
});
