import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { FOLDED_NOTE, foldTracks, OBSERVATION_TRACK_BYTES, trackLine } from "../src/integrations/ableton/fold.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

const devices = (names: string[]) => names.map((name, index) => ({ ref: `device:${index}`, name }));
const track = (index: number, extra: JsonObject = {}): JsonObject => ({ ref: `track:${index}`, name: `Track ${index}`, type: "midi", devices: devices(["Operator", "EQ Eight", "Reverb"]), ...extra });
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("a Set that fits is shown whole; a bigger one keeps the focus tracks' devices and makes every other track one line", () => {
  const small = [track(1), track(2)];
  assert.deepEqual(foldTracks(small, () => false), { tracks: small });
  const tracks = Array.from({ length: 120 }, (_, index) => track(index + 1, index % 4 === 1 ? { group: "track:1" } : {}));
  const shown = foldTracks(tracks, (row) => row.ref === "track:7");
  assert.ok(size(shown.tracks) <= OBSERVATION_TRACK_BYTES);
  assert.equal(shown.folded, FOLDED_NOTE);
  assert.deepEqual(shown.tracks[6], tracks[6], "the track in focus keeps its devices");
  assert.equal(shown.tracks[1], "track:2 Track 2 (midi, in track:1) · Operator, EQ Eight +1", "the others: reference, name, type, group, first devices");
  assert.equal(shown.tracks.length, 120, "every track is listed");
});

test("a bigger Set drops the other tracks' device names, and a huge one stops the list (the focus stays) and says how many more", () => {
  const tracks = Array.from({ length: 250 }, (_, index) => track(index + 1));
  const lines = foldTracks(tracks, () => false);
  assert.equal(lines.tracks[0], "track:1 Track 1 (midi) · 3 devices");
  assert.equal(lines.tracks.length, 250); assert.equal(lines.moreTracks, undefined);
  const huge = Array.from({ length: 2000 }, (_, index) => track(index + 1));
  const cut = foldTracks(huge, (row) => row.ref === "track:1900");
  assert.ok(size(cut.tracks) <= OBSERVATION_TRACK_BYTES + 1024, "about the budget, the focus included");
  assert.ok(cut.tracks.some((row) => typeof row === "object" && row.ref === "track:1900"), "the track in focus is there, past the cut");
  assert.match(cut.moreTracks ?? "", /^\d+ more tracks aren't listed; discover kind track/);
  assert.equal(trackLine({ ref: "track:9", name: "Pad", type: "audio" }, true), "track:9 Pad (audio)", "a track without devices says none");
});

test("the observation of a 200-track Set stays small: the selected track keeps its devices, groups are named, the rest are lines", async () => {
  const b = await opened({ bigSet: 200 });
  try {
    const context = JSON.parse(b.observation.context) as { tracks: Array<JsonObject | string>; folded?: string; moreTracks?: string };
    assert.ok(Buffer.byteLength(b.observation.context) < 16 * 1024, `the observation is ${Buffer.byteLength(b.observation.context)} bytes`);
    assert.equal(context.folded, FOLDED_NOTE);
    assert.equal(context.tracks.length, 202, "all 202 tracks are listed");
    // The first look doesn't know the Set is big yet, so it has the mixers; the folded lines leave them out.
    assert.deepEqual(context.tracks[0], { ref: "track:1", name: "Fixture Bass", type: null, volume: "0.0 dB", pan: "C" }, "the selected track, in full");
    assert.equal(context.tracks[3], "track:4 Part 2 (in track:3) · Operator, EQ Eight +2");
    assert.match(String(context.tracks[2]), /^track:3 Bus 1 \(group\) · Operator/);
    // A track Kumi changes comes into focus next turn (one per name, however many share it).
    const changed = await tool(b.tools, "set_mixer").execute({ trackRef: "track:6", volume: 0.5 }, signal());
    assert.equal(changed.isError, false, changed.text);
    const next = await b.integration.observe(signal());
    const tracks = (JSON.parse(next.context) as { tracks: Array<JsonObject | string> }).tracks;
    assert.equal(tracks.length, 202);
    assert.equal((tracks[5] as JsonObject).name, "Part 4", "the changed track, in full");
    assert.equal((tracks[5] as JsonObject).volume, undefined, "past 64 tracks, later looks don't read the mixers");
    assert.equal(tracks.filter((row) => typeof row === "object").length, 2, "the selected track and the changed one");
  } finally { await b.integration.close(); }
});

test("pages that end early (Live's side keeping its UI responsive) still give Kumi the whole Set", async () => {
  const b = await opened({ bigSet: 200, pageSize: 7, version: "1.0.57" });
  try {
    const context = JSON.parse(b.observation.context) as { tracks: Array<JsonObject | string>; moreTracks?: string };
    assert.equal(context.tracks.length, 202, "every track, from 29 pages");
    assert.equal(context.moreTracks, undefined);
    assert.equal(context.tracks[3], "track:4 Part 2 (in track:3) · Operator, EQ Eight +2", "and every track's devices, from their pages");
    assert.ok(b.requests.filter((request) => request.name === "live_discover" && request.args.kind === "device").length > 100, "the device list came in many pages");
  } finally { await b.integration.close(); }
});
