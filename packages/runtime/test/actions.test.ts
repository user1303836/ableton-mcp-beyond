import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { atLeast, FIXED_BRIDGE } from "../src/integrations/ableton/bridge-version.js";
import { ACTIONS } from "../src/integrations/ableton/actions.js";
import { CHANGES } from "../src/integrations/ableton/changes.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

test("bridge versions compare by their numbers, and an unknown one isn't held against the bridge", () => {
  assert.equal(atLeast("1.0.34", "1.0.34"), true);
  assert.equal(atLeast("1.0.35", "1.0.34"), true);
  assert.equal(atLeast("1.1.0", "1.0.34"), true);
  assert.equal(atLeast("1.0.33", "1.0.34"), false);
  assert.equal(atLeast("1.0.9", "1.0.34"), false, "numbers, not text");
  assert.equal(atLeast("1.0.34-beta.1", "1.0.34"), true);
  assert.equal(atLeast(undefined, "1.0.34"), true);
});

test("tools that need a newer bridge aren't offered by an older one, and a plan that names one says what to do", async () => {
  const old = await opened({ transport: true, version: "1.0.33" });
  try {
    const names = old.tools.map((item) => item.name);
    for (const name of ["play", "record"]) assert(!names.includes(name), `${name} needs ${FIXED_BRIDGE}`);
    const plan = await tool(old.tools, "make_changes").execute({ steps: [{ tool: "play", input: { action: "start" } }] }, signal());
    assert.equal(plan.isError, true);
    assert.match(plan.text, /1\.0\.34 or later; this one is 1\.0\.33/);
    assert(!old.requests.some((request) => request.name === "live_transport_action_preview"), "nothing reached Live");
  } finally { await old.integration.close(); }
  const fixed = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const names = fixed.tools.map((item) => item.name);
    for (const name of ["play", "record"]) assert(names.includes(name), `${name} is offered by ${FIXED_BRIDGE}`);
    const schema = tool(fixed.tools, "make_changes").inputSchema as { properties: { steps: { items: { properties: { tool: { enum: string[] } } } } } };
    assert(schema.properties.steps.items.properties.tool.enum.includes("play"), "and a plan may use it");
  } finally { await fixed.integration.close(); }
  // Every gated tool names a release the gate understands.
  for (const kind of [...CHANGES, ...ACTIONS]) if (kind.since) assert.match(kind.since, /^\d+\.\d+\.\d+$/, kind.tool);
});

test("playing and stopping are actions: no HISTORY entry, and NOW hears of them", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const started = await tool(b.tools, "play").execute({ action: "start" }, signal());
    assert.equal(started.isError, false, started.text);
    assert.equal(JSON.parse(started.text).done, "Playing from the start marker");
    assert.equal(b.transport.playing, true);
    const stopped = await tool(b.tools, "play").execute({ action: "stop" }, signal());
    assert.equal(JSON.parse(stopped.text).done, "Stopped");
    assert.equal(b.transport.playing, false);
    assert.equal(b.records.length, 0, "nothing to undo, so nothing in HISTORY");
    assert.equal(b.transport.emergencyStops, 0, "the ordinary stop did it");
  } finally { await b.integration.close(); }
});

test("stopping always works: when Live refuses the ordinary stop, Kumi stops clips, the transport and recording together", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    await tool(b.tools, "play").execute({ action: "start" }, signal());
    b.transport.refuseStop = true;
    const stopped = await tool(b.tools, "play").execute({ action: "stop" }, signal());
    assert.equal(stopped.isError, false, stopped.text);
    const reply = JSON.parse(stopped.text) as JsonObject;
    assert.equal(reply.done, "Stopped");
    assert.match(String(reply.note), /stopped clips, the transport and recording/);
    assert.equal(b.transport.playing, false);
    const emergency = b.requests.find((request) => request.name === "live_session_emergency_stop")!;
    assert.equal(emergency.args.confirmation, "emergency-stop");
    assert.equal(emergency.args.expectedRecording, "stopped");
    assert.deepEqual(emergency.args.expectedTargets, ["7:track:0|7:clip_slot:0:0|7:scene:0"], "the bridge is told exactly what's playing");
  } finally { await b.integration.close(); }
});

test("a plan that recorded and then failed doesn't leave Live recording or playing", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const plan = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "record", input: { action: "start", lane: "arrangement" } },
      { tool: "play", input: { action: "continue" } },
      { tool: "wait", input: { seconds: 0.01 } },
      { tool: "set_mixer", input: { trackRef: "3:track:9", volume: 0.5 } },
      { tool: "play", input: { action: "stop" } },
    ] }, signal());
    assert.equal(plan.isError, true);
    const reply = JSON.parse(plan.text) as { done: JsonObject[]; stopped: JsonObject; skipped: number };
    assert.equal(reply.done.length, 3, "recording, playing and the wait happened");
    assert.equal(reply.stopped.step, 4);
    assert.match(String(reply.stopped.error), /Kumi stopped the recording and playback, since the plan didn't finish/);
    assert.equal(reply.skipped, 1);
    assert.deepEqual([b.transport.playing, b.transport.arrangementRecord], [false, false]);
    assert.equal(b.transport.emergencyStops, 1);
    assert.equal(b.requests.find((request) => request.name === "live_session_emergency_stop")!.args.expectedRecording, "arrangement");
    assert.deepEqual(b.actions.at(-1), { title: "Recording stopped", playing: false, recording: false }, "NOW shows the stop");
  } finally { await b.integration.close(); }
});

test("a plan that finishes with Live playing leaves it playing, and one that never started anything stops nothing", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const plan = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 128 } }, { tool: "play", input: { action: "start" } }] }, signal());
    assert.equal(plan.isError, false, plan.text);
    assert.equal(b.transport.playing, true, "the producer asked to hear it");
    await tool(b.tools, "play").execute({ action: "stop" }, signal());
    const failing = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 126 } }, { tool: "set_mixer", input: { trackRef: "3:track:9", volume: 0.5 } }] }, signal());
    assert.equal(failing.isError, true);
    assert.doesNotMatch(failing.text, /Kumi stopped/);
    assert.equal(b.transport.emergencyStops, 0);
  } finally { await b.integration.close(); }
});

test("listen can name an audio clip in the Set by its clipRef: Kumi finds the file it plays", async () => {
  const b = await opened({ audioClip: "/Music/Bounces/Reese 0001.aif" });
  try {
    const slots = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "clip-slot", parent: "track:1" }, signal())).text) as { live?: { items: JsonObject[] }; items?: JsonObject[] };
    const clipRef = String((slots.live?.items ?? slots.items ?? []).find((slot) => slot.clipRef)?.clipRef);
    assert.match(clipRef, /^clip:\d+$/, "the model sees a short ref");
    assert.equal(await b.integration.audioFile!(clipRef, signal()), "/Music/Bounces/Reese 0001.aif");
    const read = b.requests.filter((request) => request.name === "live_discover").at(-1)!;
    assert.deepEqual([read.args.kind, read.args.parent], ["session-clip", "7:clip_slot:0:0"], "a Session clip is found under its slot");
    assert.equal(await b.integration.audioFile!("~/Music/reference.wav", signal()), undefined, "a path is left to the listen tool");
    await assert.rejects(b.integration.audioFile!("clip:99", signal()), /this turn's discovery/);
    const wrongParent = await tool(b.tools, "live_discover").execute({ kind: "session-clip", parent: "track:1" }, signal());
    assert.equal(wrongParent.isError, true);
    assert.match(wrongParent.text, /session-clip takes a clip-slot as its parent, not a track: discover the track's clip-slots/, "a current parent of the wrong kind says which kind, not that it's stale");
    const arrangement = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "arrangement-clip", parent: "track:2" }, signal())).text) as { live?: { items: JsonObject[] }; items?: JsonObject[] };
    const midi = String((arrangement.live?.items ?? arrangement.items ?? [])[0]?.ref);
    await assert.rejects(b.integration.audioFile!(midi, signal()), /MIDI clip, which has no sound of its own/);
  } finally { await b.integration.close(); }
});

test("cancelling a plan while the model is still writing it stops the recording and playback it started", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const turn = new AbortController();
    const call = tool(b.tools, "make_changes").stream!(turn.signal, () => {});
    const text = JSON.stringify({ steps: [{ tool: "record", input: { action: "start", lane: "arrangement" } }, { tool: "play", input: { action: "continue" } }, { tool: "wait", input: { seconds: 30 } }] });
    call.push(text.slice(0, text.indexOf("{\"tool\":\"wait\"")));
    for (let waited = 0; !(b.transport.playing && b.transport.arrangementRecord) && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual([b.transport.playing, b.transport.arrangementRecord], [true, true], "recording and playing while the model writes on");
    turn.abort();
    for (let waited = 0; b.transport.emergencyStops === 0 && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(b.transport.emergencyStops, 1, "the cancelled plan stopped what it started");
    assert.deepEqual([b.transport.playing, b.transport.arrangementRecord], [false, false]);
    assert.deepEqual(b.actions.at(-1), { title: "Recording stopped", playing: false, recording: false });
  } finally { await b.integration.close(); }
});

test("a recording Live didn't confirm may have started: the producer is told so, and the plan's cleanup stops it", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    b.transport.recordUnsure = true;
    const plan = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "record", input: { action: "start", lane: "arrangement" } }, { tool: "play", input: { action: "continue" } }] }, signal());
    assert.equal(plan.isError, true);
    const reply = JSON.parse(plan.text) as { stopped: JsonObject };
    assert.match(String(reply.stopped.error), /may have happened: check Live/);
    assert.match(String(reply.stopped.error), /Kumi stopped the recording and playback/);
    assert.equal(b.transport.arrangementRecord, false);
    assert.equal(b.transport.emergencyStops, 1);
  } finally { await b.integration.close(); }
});

test("a wait in beats counts at the tempo an earlier step of the plan set", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const plan = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: { tempo: 240 } }, { tool: "wait", input: { beats: 1 } }] }, signal());
    assert.equal(plan.isError, false, plan.text);
    assert.equal((JSON.parse(plan.text) as { done: JsonObject[] }).done[1]!.changed, "waited 0.3 s", "a beat at 240 BPM, not at the 120 the turn began with");
  } finally { await b.integration.close(); }
});

test("a track put first retires the short names after it: a plan's later step can't reach the new track by an old name", async () => {
  const b = await opened();
  try {
    const plan = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Intro", kind: "midi", index: 0 }], scenes: [] } },
      { tool: "set_mixer", input: { trackRef: "track:1", volume: 0.5 } },
    ] }, signal());
    assert.equal(plan.isError, true, "track:1 was Fixture Bass, which moved; it isn't Intro now");
    const reply = JSON.parse(plan.text) as { done: JsonObject[]; stopped: JsonObject };
    assert.match(String(reply.stopped.error), /discovery in this turn/);
    assert.notEqual(reply.done[0]!.ref, "track:1", "the new track gets a name of its own");
    assert(!b.requests.some((request) => request.name === "live_mixer_preview"), "nothing reached Live for the stale name");
  } finally { await b.integration.close(); }
});

test("moving a device retires its track's device references, so a later step can't hit the wrong device", async () => {
  const b = await opened({ racks: true, version: FIXED_BRIDGE });
  try {
    const devices = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "device", parent: "track:1" }, signal())).text) as { live?: { items: JsonObject[] }; items?: JsonObject[] };
    const rows = devices.live?.items ?? devices.items ?? [];
    const reverb = String(rows.find((row) => row.name === "Reverb")!.ref); const rack = String(rows.find((row) => row.name === "Instrument Rack")!.ref);
    const plan = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "move_device", input: { deviceRef: reverb, index: 0 } },
      { tool: "switch_device", input: { deviceRef: rack, enabled: false } },
    ] }, signal());
    assert.equal(plan.isError, true, "the rack's old position now holds the Reverb");
    const reply = JSON.parse(plan.text) as { done: JsonObject[]; stopped: JsonObject };
    assert.equal(reply.done.length, 1);
    assert.match(String(reply.stopped.error), /discovery in this turn/);
    assert.equal(b.requests.filter((request) => request.name === "live_device_preview").length, 1, "only the move reached Live");
  } finally { await b.integration.close(); }
});

test("moving a device says where its track's devices are now, with references the model can use at once", async () => {
  const b = await opened({ racks: true, version: FIXED_BRIDGE });
  try {
    const devices = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "device", parent: "track:1" }, signal())).text) as { live: { items: JsonObject[] } };
    const reverb = String(devices.live.items.find((row) => row.name === "Reverb")!.ref);
    const moved = JSON.parse((await tool(b.tools, "move_device").execute({ deviceRef: reverb, index: 0 }, signal())).text) as { devicesNow?: Record<string, { track?: string; devices: JsonObject[] }>; note: string };
    assert.match(moved.note, /devicesNow has each track's devices as they are now/);
    const now = Object.values(moved.devicesNow ?? {});
    assert.equal(now.length, 1);
    assert.equal(now[0]!.track, "Fixture Bass");
    // A reference from it works at once, with no discovery in between.
    const rack = String(now[0]!.devices.find((row) => row.name === "Instrument Rack")!.ref);
    const switched = await tool(b.tools, "switch_device").execute({ deviceRef: rack, enabled: false }, signal());
    assert.equal(switched.isError, false, switched.text);
  } finally { await b.integration.close(); }
});

test("each turn's look at the Set has every track's level and pan, and leaves them out on a big Set", async () => {
  const b = await opened();
  try {
    const context = JSON.parse(b.observation.context) as { tracks: JsonObject[] };
    assert.deepEqual(context.tracks.slice(0, 2).map((track) => [track.volume, track.pan]), [["0.0 dB", "C"], ["0.0 dB", "25L"]]);
  } finally { await b.integration.close(); }
  const big = await opened({ bigSet: 80 });
  try {
    const fields = () => big.requests.filter((request) => request.name === "live_discover" && request.args.kind === "track" && request.args.parent === undefined).map((request) => request.args.fields as string[]);
    assert.ok(fields()[0]!.includes("mixer"), "the first look doesn't know the Set's size yet");
    await big.integration.observe(signal());
    assert.ok(!fields().at(-1)!.includes("mixer"), "past 64 tracks, the next look leaves the mixers out");
  } finally { await big.integration.close(); }
});

test("recording starts after Kumi disarms any other armed track, each a change with its undo, and says which", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    b.arm(1);
    // The bridge records onto one armed track only; the destination is armed in the same plan.
    const tracks = await tool(b.tools, "live_discover").execute({ kind: "track", fields: ["ref", "name", "armed"] }, signal());
    const destination = (JSON.parse(tracks.text) as { live: { items: { ref: string }[] } }).live.items[0]!.ref;
    const plan = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "set_routing", input: { trackRef: destination, arm: true } },
      { tool: "record", input: { action: "start", lane: "arrangement", destinationTrackRef: destination } },
      { tool: "record", input: { action: "stop", lane: "arrangement" } },
    ] }, signal());
    assert.equal(plan.isError, false, plan.text);
    assert.deepEqual(b.armed(), [0], "only the destination stays armed");
    assert.match(plan.text, /Recording in the Arrangement on Fixture Bass, after disarming Fixture Drums/);
    const disarm = b.records.find((record) => record.title === "Fixture Drums: disarmed");
    assert.ok(disarm && disarm.state === "applied", "the disarm is in HISTORY, undoable");
    // Nothing else armed: nothing is disarmed.
    const again = await tool(b.tools, "record").execute({ action: "start", lane: "arrangement", destinationTrackRef: destination }, signal());
    assert.equal(again.isError, false, again.text);
    assert.doesNotMatch(again.text, /disarmedFirst/);
  } finally { await b.integration.close(); }
});

test("Back to Arrangement is pressed through play, and an older bridge says it needs updating", async () => {
  const current = await opened({ transport: true, version: "1.0.35" });
  try {
    const pressed = await tool(current.tools, "play").execute({ action: "back-to-arrangement" }, signal());
    assert.equal(pressed.isError, false, pressed.text);
    assert.equal(JSON.parse(pressed.text).done, "Back to the Arrangement");
  } finally { await current.integration.close(); }
  const older = await opened({ transport: true, version: FIXED_BRIDGE });
  try {
    const refused = await tool(older.tools, "play").execute({ action: "back-to-arrangement" }, signal());
    assert.equal(refused.isError, true);
    assert.match(refused.text, /needs the Ableton bridge 1\.0\.35 or later/);
    assert.ok(!older.requests.some((request) => request.name === "live_transport_action_preview"), "nothing reached Live");
  } finally { await older.integration.close(); }
});

test("recording on a nearly full disk is refused, in plain words, before anything starts", async () => {
  const b = await opened({ transport: true, version: FIXED_BRIDGE, freeDisk: 60_000_000 });
  try {
    const refused = await tool(b.tools, "record").execute({ action: "start", lane: "arrangement" }, signal());
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^Only 60 MB is free on the disk Live records to, so it would likely fail partway\. Free some space .* Nothing was recorded\.$/);
    assert.equal(b.requests.some((request) => request.name === "live_recording_preview"), false, "Live wasn't asked");
    const stop = await tool(b.tools, "record").execute({ action: "stop", lane: "arrangement" }, signal());
    assert.doesNotMatch(stop.text, /free on the disk/, "stopping is never held up");
  } finally { await b.integration.close(); }
});
