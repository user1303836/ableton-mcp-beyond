// Recreate with: node reference.mjs /path/to/apps/kumi/dist > reference.json
import { pathToFileURL } from "node:url";
import { PassThrough, Writable } from "node:stream";
const root = process.argv[2];
const { createTerminal } = await import(pathToFileURL(`${root}/src/terminal.js`));
const { fakeModels } = await import(pathToFileURL(`${root}/test/fake-models.js`));
let output = "";
const input = new PassThrough();
const terminal = createTerminal({ input, output: new Writable({ write(chunk, _, done) { output += chunk; done(); } }),
  mode: "inference-only", secrets: ["private-token"], models: fakeModels({ model: "openai-codex/fixture" }).control,
  controller: { start: async () => {}, close: async () => {}, status: () => ({ state: "idle", connection: "disconnected", turns: 0 }) } });
terminal.run();
await new Promise(resolve => setImmediate(resolve));
const events = [
  ...["connecting", "connected", "disconnected"].map(state => ({ type: "connection", state })),
  { type: "observation", label: "Set private-token\ntrack" },
  ...["applied", "unsure", "kept", "expired", "heard", "undone"].flatMap(state => [
    { type: "change", change: { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state, at: 1 } },
    { type: "change", change: { id: "c2", family: "tempo", title: "Tempo 120 → 124 BPM", state, at: 2, note: "Check private-token", score: 0 } },
  ]),
  { type: "notice", message: "A notice\nnext line" },
  { type: "tool-start", id: "t", name: "live_status" },
  ...[false, true].map(isError => ({ type: "tool-end", id: "t", name: "live_status", isError, elapsedMs: 23 })),
  ...["producer", "set"].flatMap(scope => [
    { type: "remembered", scope, note: { id: "p1", text: "Short reverbs", at: 1 } },
    { type: "remembered", scope, note: { id: "p2", text: "Long reverbs", at: 2 }, replaced: { id: "p1", text: "Short reverbs", at: 1 }, pending: true },
    { type: "forgot", scope, note: { id: "p1", text: "Short reverbs", at: 1 } },
  ]),
  { type: "action", title: "Stopped", playing: false },
  ...[true, false].map(on => ({ type: "watching", on })),
  ...["saved", "updated", "running", "forgotten"].map(action => ({ type: "recipe", action, name: "My drums", steps: 3 })),
  ...["kept", "updated", "used", "forgot"].map(action => ({ type: "technique", action, technique: { id: "t1", name: "Soft pads", fits: "quiet arrangements" } })),
  ...["learned", "updated", "forgot"].map(action => ({ type: "lesson", action, id: "l1", line: "Small changes first" })),
  { type: "heard", file: "sound.wav", summary: "Bright", bands: [1, 2] },
  { type: "heard", file: "sound.wav", summary: "Bright", bands: [1, 2], compared: { reference: "ref.wav", summary: "Close", differences: [0], headlines: [] } },
  { type: "heard", file: "sound.wav", summary: "Bright", bands: [1, 2], compared: { reference: "ref.wav", summary: "Close", differences: [1], headlines: ["Bright top", "Soft low end"] } },
  ...["captions", "automatic", "transcribed", "none"].map(words => ({ type: "watched", title: "A video", url: "https://example.com/video", from: 1, to: 62, duration: 90, chapters: [], words, lines: 2, frames: [], notes: ["first", "second", "third", "fourth"] })),
  ...["completed", "cancelled"].flatMap(stopReason => [
    { type: "turn-complete", elapsedMs: 42, result: { stopReason } },
    { type: "turn-complete", elapsedMs: 42, result: { stopReason, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } },
  ]),
];
const header = output;
output = "";
const cases = events.map(event => { terminal.handleEvent(event); const expected = output; output = ""; return { event, expected }; });
await terminal.close();
console.log(JSON.stringify({ header, cases, closed: output }, null, 2));
