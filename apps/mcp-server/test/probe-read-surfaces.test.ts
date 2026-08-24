import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { DeterministicLiveSimulator } from "../src/live.js";

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function connectedHost(policy?: unknown) {
  const simulator = new DeterministicLiveSimulator();
  const host = new McpHost(simulator, policy === undefined ? undefined : { toolPolicy: policy });
  host.handle(initialize); host.handle(initialized);
  let requestId = 500;
  const call = (name: string, args: unknown) => host.handleAsync({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } });
  const parse = async (promise: Promise<unknown>) => {
    const frame = (await promise) as any;
    if (frame.error) throw new Error(`unexpected protocol error: ${JSON.stringify(frame.error)}`);
    return JSON.parse(frame.result.content[0].text);
  };
  return { simulator, host, call, parse };
}

function addArrangementClip(simulator: DeterministicLiveSimulator) {
  const state = (simulator as any).state;
  state.arrangementClips = state.arrangementClips ?? [];
  state.arrangementClips.push({
    trackRef: "track:track-1",
    clip: {
      ref: "arrangement-clip:track-1:0", objectIdentity: "simulator:arrangement-clip:1", name: "Arranged", kind: "midi",
      start: 8, length: 4, notes: [], notesRevision: createHash("sha256").update("[]").digest("hex"), warp: false, takes: [], automation: [],
      envelopes: { "parameter:gain-1": [{ time: 0, value: 0.5 }, { time: 1, value: 0.75 }, { time: 2, value: 0.25 }, { time: 3, value: 1 }] },
    },
  });
}

function addAudioClipWithMarkers(simulator: DeterministicLiveSimulator, markerCount = 3) {
  const state = (simulator as any).state;
  const markers = Array.from({ length: markerCount }, (_, index) => ({ beatTime: index + 1, sampleTime: (index + 1) * 44100 }));
  state.tracks[0].clips.push({
    ref: "clip:audio-1", objectIdentity: "simulator:clip:audio-1", name: "Audio", kind: "audio", start: 0, length: 8,
    notes: [], notesRevision: createHash("sha256").update("[]").digest("hex"), warp: true, takes: [], automation: [], isAudio: true,
    filePath: "/tmp/audio.wav", muted: false, warpMarkers: markers,
  });
  if (!state.scenes.some((scene: { index: number }) => scene.index === 1)) {
    state.scenes.push({ ref: "scene:scene-audio", objectIdentity: "simulator:scene:scene-audio", name: "Audio Scene", index: 1 });
    state.tracks[0].clipSlots.push({ ref: "clip-slot:track-1:1", parentRef: "track:track-1", objectIdentity: "simulator:clip-slot:track-1:1", sceneIndex: 1, clipRef: "clip:audio-1", empty: false });
  }
  return { markers };
}

test("arrangement automation read returns owner identity, range, complete paged points, and explicit unavailability", async () => {
  const { simulator, parse, call } = connectedHost();
  addArrangementClip(simulator);
  const first = await parse(call("live_arrangement_automation_read", { clipRef: "arrangement-clip:track-1:0", parameterRef: "parameter:gain-1", limit: 3 }));
  assert.equal(first.envelope.exists, true);
  assert.deepEqual(first.range, { from: 0, to: 3 });
  assert.equal(first.points.length, 3);
  assert.equal(first.paging.complete, false);
  assert.equal(first.paging.total, 4);
  assert.equal(first.parameter.ref, "parameter:gain-1");
  assert.equal(first.clip.arrangement, true);
  assert.equal(first.curve.available, false);
  assert.match(first.curve.reason, /not exposed/);
  assert.equal(first.mutation.advertised, false);
  assert.equal(first.probe.adapter, "simulator");
  assert.equal(typeof first.revision, "string");
  assert.equal(typeof first.sessionState, "object");
  assert.equal(first.sessionState.arrangementOverdub, false);
  assert.match(first.sessionState.note, /authoritative/);
  const second = await parse(call("live_arrangement_automation_read", { clipRef: "arrangement-clip:track-1:0", parameterRef: "parameter:gain-1", limit: 3, cursor: first.paging.nextCursor }));
  assert.equal(second.points.length, 1);
  assert.equal(second.paging.complete, true);
  assert.equal(second.revision, first.revision);
  // Session clips are refused: this surface is Arrangement-only.
  const sessionClip = await call("live_arrangement_automation_read", { clipRef: "clip:clip-1", parameterRef: "parameter:gain-1" });
  assert.equal((sessionClip as any).result.isError, true);
  // No envelope for an unknown parameter.
  const empty = await parse(call("live_arrangement_automation_read", { clipRef: "arrangement-clip:track-1:0", parameterRef: "parameter:gain-1" }));
  assert.equal(empty.points.length, 4);
});

test("arrangement automation read invalidates stale cursors instead of shifting pages", async () => {
  const { simulator, parse, call } = connectedHost();
  addArrangementClip(simulator);
  const first = await parse(call("live_arrangement_automation_read", { clipRef: "arrangement-clip:track-1:0", parameterRef: "parameter:gain-1", limit: 2 }));
  const state = (simulator as any).state;
  state.arrangementClips[0].clip.envelopes["parameter:gain-1"].push({ time: 4, value: 0.1 });
  const stale = await call("live_arrangement_automation_read", { clipRef: "arrangement-clip:track-1:0", parameterRef: "parameter:gain-1", limit: 2, cursor: first.paging.nextCursor });
  assert.equal((stale as any).result.isError, true);
  assert.match(JSON.parse((stale as any).result.content[0].text).reason, /stale/);
});

test("take-lane read returns ordered lanes with clip fingerprints, main-lane summary, and revision-bound paging", async () => {
  const { simulator, parse, call } = connectedHost();
  const state = (simulator as any).state;
  state.tracks[0].takeLanes[0].clips.push({ ref: "take-lane-clip:1", objectIdentity: "simulator:take-lane-clip:1", name: "Take 1a", kind: "audio", start: 0, length: 8, notes: [], warp: true, takes: [], automation: [], isTakeLaneClip: true });
  addArrangementClip(simulator);
  const result = await parse(call("live_take_lane_read", { trackRef: "track:track-1" }));
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0].ref, "take-lane:track-1:0");
  assert.equal(result.lanes[0].name, "Take 1");
  assert.equal(result.lanes[0].index, 0);
  assert.equal(result.lanes[0].clips.length, 1);
  assert.equal(result.lanes[0].clips[0].fingerprint.length, 64);
  assert.equal(result.mainLane.clipCount, 1);
  assert.equal(result.paging.complete, true);
  assert.match(result.relationships.compSourceSegments, /not enumerable/);
  assert.match(result.relationships.mutation, /no lane creation/i);
  assert.equal(result.probe.adapter, "simulator");
});

test("comp read reports adapter-negotiated segments with lane identity and never ranks takes", async () => {
  const { simulator, parse, call } = connectedHost();
  const state = (simulator as any).state;
  state.tracks[0].takeLanes[0].clips.push({ ref: "take-lane-clip:1", objectIdentity: "simulator:take-lane-clip:1", name: "Take 1a", kind: "audio", start: 2, length: 4, notes: [], warp: true, takes: [], automation: [], isTakeLaneClip: true });
  addAudioClipWithMarkers(simulator);
  const result = await parse(call("live_comp_read", { clipRef: "clip:audio-1" }));
  assert.equal(result.segments.length, 1);
  assert.deepEqual([result.segments[0].from, result.segments[0].to], [2, 6]);
  assert.equal(result.segments[0].laneRef, "take-lane:track-1:0");
  assert.equal(result.segments[0].laneName, "Take 1");
  assert.equal(result.paging.complete, true);
  assert.match(result.relationships.sourceHighlightFidelity, /not inferred/);
  assert.match(result.relationships.note, /no best-take ranking/);
});

test("warp-marker probe returns bounded markers, monotonicity, revisions, identity limits, and read-only feasibility", async () => {
  const { simulator, parse, call } = connectedHost();
  addAudioClipWithMarkers(simulator);
  const result = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1" }));
  assert.equal(result.markers.length, 3);
  assert.deepEqual(result.markers[0], { beatTime: 1, sampleTime: 44100 });
  assert.deepEqual(result.monotonic, { beatTime: true, sampleTime: true });
  assert.equal(result.revisions.adapter.length, 64);
  assert.equal(result.revisions.collection.length, 64);
  assert.equal(result.revisions.clipAuthority.length, 64);
  assert.equal(result.identity.stableMarkerIdsExposed, false);
  assert.equal(result.mutationFeasibility.advertisedByThisTool, false);
  assert.equal(result.mutationFeasibility.add, true);
  assert.equal(result.paging.complete, true);
  const paged = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1", limit: 2 }));
  assert.equal(paged.markers.length, 2);
  const rest = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1", limit: 2, cursor: paged.paging.nextCursor }));
  assert.equal(rest.markers.length, 1);
  assert.equal(rest.paging.complete, true);
  // MIDI clips are refused.
  const midi = await call("live_warp_marker_read", { clipRef: "clip:clip-1" });
  assert.equal((midi as any).result.isError, true);
  assert.match(JSON.parse((midi as any).result.content[0].text).reason, /audio clip/);
});

test("warp-marker revisions are stable across repeated reads and invalidated by external edits", async () => {
  const { simulator, parse, call } = connectedHost();
  addAudioClipWithMarkers(simulator);
  const first = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1" }));
  const second = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1" }));
  assert.deepEqual(second.revisions, first.revisions);
  const clip = (simulator as any).state.tracks[0].clips.find((candidate: any) => candidate.ref === "clip:audio-1");
  clip.warpMarkers.push({ beatTime: 4, sampleTime: 176400 });
  const afterEdit = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1" }));
  assert.notEqual(afterEdit.revisions.collection, first.revisions.collection);
  assert.equal(afterEdit.paging.total, 4);
});

test("warp-marker probe detects non-monotonic collections and bounds large sets honestly", async () => {
  const { simulator, parse, call } = connectedHost();
  const state = (simulator as any).state;
  addAudioClipWithMarkers(simulator);
  const clip = state.tracks[0].clips.find((candidate: any) => candidate.ref === "clip:audio-1");
  clip.warpMarkers = [{ beatTime: 2, sampleTime: 88200 }, { beatTime: 1, sampleTime: 22050 }, { beatTime: 3, sampleTime: 40000 }];
  const result = await parse(call("live_warp_marker_read", { clipRef: "clip:audio-1" }));
  assert.equal(result.monotonic.sampleTime, false);
  const large = connectedHost();
  addAudioClipWithMarkers(large.simulator, 256);
  const bounded = await large.parse(large.call("live_warp_marker_read", { clipRef: "clip:audio-1", limit: 256 }));
  assert.equal(bounded.paging.total, 256);
  assert.equal(bounded.paging.complete, true);
});

test("read-only probes are visible in the read-only profile and fail closed when disconnected", async () => {
  const { simulator, host } = connectedHost({ profile: "read-only" });
  addArrangementClip(simulator);
  const listed = (host.handle({ jsonrpc: "2.0", id: 900, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  for (const tool of ["live_arrangement_automation_read", "live_take_lane_read", "live_comp_read", "live_warp_marker_read"]) assert.ok(listed.includes(tool), tool);

  const disconnected = new McpHost();
  disconnected.handle(initialize); disconnected.handle(initialized);
  const result = await disconnected.handleAsync({ jsonrpc: "2.0", id: 901, method: "tools/call", params: { name: "live_warp_marker_read", arguments: { clipRef: "clip:audio-1" } } });
  assert.equal((result as any).result.isError, true);
  assert.match(JSON.parse((result as any).result.content[0].text).reason, /tool-unavailable/);
});

test("comp read is hidden when the adapter does not negotiate audio.comp.read", async () => {
  const simulator = new DeterministicLiveSimulator();
  const operations = (simulator.status().operations ?? []).filter((operation) => operation !== "audio.comp.read");
  const adapter = { ...simulator, status: () => ({ ...simulator.status(), operations }) } as any;
  const host = new McpHost(adapter);
  host.handle(initialize); host.handle(initialized);
  const listed = (host.handle({ jsonrpc: "2.0", id: 950, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(listed.includes("live_comp_read"), false);
  assert.ok(listed.includes("live_take_lane_read"));
  const refused = await host.handleAsync({ jsonrpc: "2.0", id: 951, method: "tools/call", params: { name: "live_comp_read", arguments: { clipRef: "clip:audio-1" } } });
  assert.equal((refused as any).result.isError, true);
  assert.match(JSON.parse((refused as any).result.content[0].text).reason, /tool-unavailable/);
});
