import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { SessionController, SessionEvent, TurnState } from "@kumi/runtime";
import { createTerminal } from "../src/terminal.js";
import { KeyInput } from "../src/input.js";
import { StreamingText, sanitizeText } from "../src/text.js";
import { fakeModels, MODELS } from "./fake-models.js";
import type { UpdateControl } from "../src/update.js";

const inheritedTerm = process.env.TERM;
// These fake TTYs provide cursor editing, even when the test runner inherits TERM=dumb.
before(() => { process.env.TERM = "xterm-256color"; });
after(() => {
  if (inheritedTerm === undefined) delete process.env.TERM;
  else process.env.TERM = inheritedTerm;
});

function fixture(tty = false, hold = false, startupNotice?: string, updates?: UpdateControl) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = tty; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  let output = "";
  const sink = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }), { isTTY: tty, columns: 40 });
  const calls: string[] = [];
  let state: TurnState = "idle"; let releases: (() => void)[] = [];
  const controller: SessionController = {
    async start() { calls.push("start"); },
    async submit(text) {
      calls.push(`submit:${text}`); state = "running"; terminal.handleEvent({ type: "state", state });
      if (hold) await new Promise<void>((resolve) => { releases.push(resolve); });
      state = "idle"; terminal.handleEvent({ type: "state", state });
    },
    async refresh() { calls.push("refresh"); }, async newConversation() { calls.push("new"); },
    async cancel() { calls.push("cancel"); state = "idle"; for (const release of releases) release(); releases = []; },
    async close() { calls.push("close"); state = "closed"; for (const release of releases) release(); releases = []; },
    status() { return { state, connection: "disconnected", turns: 0, maxTurns: 30 }; },
    async undo() { calls.push("undo"); return { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state: "undone", at: 1 }; },
  };
  const terminal = createTerminal({ controller, input, output: sink, models: fakeModels({ model: "openai-codex/fixture", signedIn: ["openai-codex"] }).control, mode: "inference-only", secrets: ["private-token"], closeTimeoutMs: 25,
    ...(startupNotice ? { startupNotice } : {}), ...(updates ? { updates } : {}) });
  const done = terminal.run();
  return { input, sink, terminal, controller, done, calls, emit: (event: SessionEvent) => terminal.handleEvent(event), get output() { return output; } };
}

test("header, transcript, tool timing, usage and command dispatch are concise and safe", async () => {
  const f = fixture(); await delay(0);
  f.input.write("/help\n/status\n/refresh\n/new\n/unknown\nquestion\n"); await delay(0);
  f.emit({ type: "text", text: "hello " }); f.emit({ type: "text", text: "world" });
  f.emit({ type: "tool-start", id: "t", name: "live_status" });
  f.emit({ type: "tool-end", id: "t", name: "live_status", elapsedMs: 7, isError: false });
  f.emit({ type: "turn-complete", elapsedMs: 55, result: { stopReason: "completed", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
  f.emit({ type: "error", message: "token=private-token\u001b[31m bad" });
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.match(f.output, /Kumi/); assert.match(f.output, /continues next time/i);
  assert.match(f.output, /No Live access/); assert.match(f.output, /hello world/); assert.equal(f.output.split("hello world").length, 2);
  assert.match(f.output, /live_status.*7 ms/); assert.match(f.output, /3.*2/); assert(!f.output.includes("private-token"));
  assert.deepEqual(f.calls, ["start", "refresh", "new", "submit:question", "close"]);
});

test("plain mode prints each change, and /undo takes back the latest", async () => {
  const f = fixture(); await delay(0);
  f.emit({ type: "change", change: { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state: "applied", at: 1 } });
  f.input.write("/undo\n"); await delay(5);
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.match(f.output, /\[change\] Tempo 120 → 124 BPM \(\/undo takes it back\)/);
  assert.match(f.output, /\[undo\] Undid: Tempo 120 → 124 BPM/);
  assert(f.calls.includes("undo"));
});

test("plain mode keeps a line typed while Kumi connects and sends it when ready", async () => {
  const f = fixture(); await delay(0);
  (f.controller as unknown as { status(): { state: string } }).status = () => ({ state: "running", connection: "connecting", turns: 0, maxTurns: 30 } as never);
  f.input.write("early question\n"); await delay(5);
  assert(!f.calls.includes("submit:early question"), "held while connecting");
  assert.match(f.output, /\[waiting\] Kumi is getting ready/);
  (f.controller as unknown as { status(): { state: string } }).status = () => ({ state: "idle", connection: "connected", turns: 0, maxTurns: 30 } as never);
  f.emit({ type: "state", state: "idle" }); await delay(10);
  assert(f.calls.includes("submit:early question"));
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
});

test("an optional startup notice follows the header once", async () => {
  const f = fixture(false, false, "The Ableton bridge isn't installed yet");
  await delay(0); f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.equal(f.output.split("bridge isn't installed yet").length, 2);
  assert(f.output.indexOf("/help for commands") < f.output.indexOf("bridge isn't installed yet"));
});

test("partial input and cursor survive streaming, notices and tool lines, including wrapped Unicode", async () => {
  const f = fixture(true); await delay(0);
  const prefix = "猫🎹".repeat(15);
  f.input.write(`${prefix}abcd`); f.input.write("\u001b[D\u001b[D");
  f.emit({ type: "text", text: "A streamed response" });
  f.emit({ type: "notice", message: "still working" });
  f.emit({ type: "tool-start", id: "x", name: "live_discover" });
  f.input.write("XY\r"); await delay(0);
  assert(f.calls.includes(`submit:${prefix}abXYcd`));
  f.input.write("/quit\r"); await f.done; assert.equal(f.input.isRaw, false);
  assert(stripVTControlCharacters(f.output).endsWith("Kumi closed. Each Set's conversation continues next time.\n"), "do not leave a dead Kumi prompt at exit");
});

test("busy submit and refresh/new are rejected; Ctrl-C cancels work but preserves partly typed next input", async () => {
  const f = fixture(true, true); await delay(0);
  f.input.write("first\r"); await delay(0);
  f.input.write("second\r/refresh\r/new\r"); await delay(0);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("submit:")), ["submit:first"]); assert.match(f.output, /busy.*cancel first/i);
  f.input.write("follow"); f.input.write("\u0003"); await delay(0);
  assert(f.calls.includes("cancel")); assert(!f.calls.includes("close"));
  f.input.write("up\r"); await delay(0); assert(f.calls.includes("submit:followup"));
  f.input.write("\u0003"); await delay(0); f.input.write("\u0003");
  assert.equal(await f.done, 0); assert.equal(f.calls.filter((call) => call === "close").length, 1);
});

test("EOF during work and repeated shutdown close the controller exactly once and suppress late text", async () => {
  const f = fixture(false, true); await delay(0); f.input.write("pending\n"); await delay(0);
  f.input.end(); await f.done; await f.terminal.close();
  const before = f.output; f.emit({ type: "text", text: "late-secret" });
  assert.equal(f.output, before); assert.equal(f.calls.filter((call) => call === "close").length, 1);
});

test("shutdown has a hard bound even if an injected controller never resolves", async () => {
  const f = fixture(true); await delay(0);
  f.controller.close = () => new Promise(() => {});
  f.input.write("/quit\r");
  assert.equal(await f.done, 1); assert.equal(f.input.isRaw, false); assert.match(f.output, /Shutdown deadline/);
});

test("TTY input preserves split UTF-8 and separates pasted code points for readline row tracking", async () => {
  const source = new PassThrough(); const keys = new KeyInput(source);
  const chunks: string[] = []; keys.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const bytes = Buffer.from("a猫🎹b");
  source.write(bytes.subarray(0, 3)); source.write(bytes.subarray(3));
  await delay(0);
  assert.deepEqual(chunks, ["a", "猫", "🎹", "b"]);
  keys.destroy(); await delay(0); assert.equal(source.listenerCount("data"), 0);
});

test("streaming sanitizer rejects split CSI/OSC/DCS controls and split known credentials", () => {
  const text = new StreamingText(["private-token"]);
  const chunks = ["ok\u001b[3", "1m red\u001b[0m ", "\u001b]52;c;malicious", "clipboard\u0007", "key: private-", "token", "\u001bPdiscard", "\u001b\\ done\u202e"];
  const result = chunks.map((chunk) => text.push(chunk)).join("") + text.finish();
  assert.equal(result, "ok red key: [redacted] done");
  assert.equal(sanitizeText("bad\r\b\u0000\u009b31m text\u202e"), "bad text");
});

test("interrupted secret prefixes and unterminated escape sequences are discarded, not replayed next turn", () => {
  const text = new StreamingText(["private-token"]);
  assert.equal(text.push("private-"), ""); text.discard();
  assert.equal(text.push("next"), "next"); assert.equal(text.finish(), "");
  assert.equal(text.push("\u001b]0;hidden"), ""); text.discard();
  assert.equal(text.push("fresh"), "fresh");
});

test("plain mode names the model, lists a provider's, and sets the model and effort by name", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = false; input.isRaw = false; input.setRawMode = () => {};
  let output = "";
  const sink = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }), { isTTY: false, columns: 100 });
  const controller: SessionController = {
    async start() {}, async submit() {}, async refresh() {}, async newConversation() {}, async cancel() {}, async close() {},
    status() { return { state: "idle", connection: "disconnected", turns: 0 }; }, async undo() { return undefined; },
  };
  const fake = fakeModels({ model: "openai-codex/gpt-6-astra", signedIn: ["openai-codex"], lists: MODELS });
  const terminal = createTerminal({ controller, input, output: sink, models: fake.control, mode: "inference-only", closeTimeoutMs: 25 });
  const done = terminal.run();
  await delay(0);
  input.write("/model\n/model openai-codex\n/model openai-codex/gpt-6-luna\n/effort low\n/effort turbo\n/logout openai-codex\n"); await delay(20);
  terminal.handleEvent({ type: "error", message: "Not signed in to Anthropic: add its API key with /login (or set ANTHROPIC_API_KEY).", kind: "auth", provider: "anthropic" });
  input.end(); assert.equal(await done, 0);
  const text = stripVTControlCharacters(output);
  assert.match(text, /Kumi · openai-codex\/gpt-6-astra/);
  assert.match(text, /\[model\] openai-codex\/gpt-6-astra\. List a provider's with \/model <provider> \(openai-codex\)/);
  assert.match(text, /\[model\] openai-codex: gpt-6-astra, gpt-6-luna/);
  assert.match(text, /\[model\] openai-codex\/gpt-6-luna from the next answer on\./);
  assert.match(text, /\[effort\] low\./);
  assert.match(text, /\[effort\] Choose one of low, medium, high, xhigh, max or default\./);
  assert.match(text, /\[logout\] Signed out of openai-codex\./);
  assert.match(text, /\[login\] Sign in from a shell: npm run kumi -- login anthropic/, "a sign-in failure names the command that fixes it");
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith("list")), ["choose:openai-codex/gpt-6-luna", "effort:low", "signout:openai-codex"]);
});

test("plain mode lists what Kumi remembers and forgets a note by its id", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = false; input.isRaw = false; input.setRawMode = () => {};
  let output = "";
  const sink = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }), { isTTY: false, columns: 100 });
  const notes = { producer: [{ id: "p1", text: "Prefers short reverbs", at: 1 }], set: [{ id: "s1", text: "The Reese is the main bass", at: 2 }] };
  const controller: SessionController = {
    async start() {}, async submit() {}, async refresh() {}, async newConversation() {}, async cancel() {}, async close() {},
    status() { return { state: "idle", connection: "disconnected", turns: 0 }; }, async undo() { return undefined; },
    async memory() { return { ...notes, setName: "Night Drive", saved: true }; },
    // As the session does, a forgotten note is announced by its event.
    async forget(id) { const note = notes.set.find((item) => item.id === id); notes.set = notes.set.filter((item) => item.id !== id); if (note) terminal.handleEvent({ type: "forgot", scope: "set", note }); return note; },
  };
  const terminal = createTerminal({ controller, input, output: sink, models: fakeModels().control, mode: "inference-only", closeTimeoutMs: 25 });
  const done = terminal.run();
  await delay(0);
  input.write("/memory\n/forget s1\n/forget s9\n"); await delay(20);
  terminal.handleEvent({ type: "remembered", scope: "producer", note: { id: "p2", text: "Names buses BUS - <what>", at: 3 } });
  input.end(); assert.equal(await done, 0);
  const text = stripVTControlCharacters(output);
  assert.match(text, /\[memory\] About you: p1 Prefers short reverbs/);
  assert.match(text, /\[memory\] About Night Drive: s1 The Reese is the main bass/);
  assert.match(text, /\[memory\] Forgot: The Reese is the main bass/);
  assert.match(text, /\[memory\] Use: \/forget <id>/);
  assert.match(text, /\[memory\] Noted about you: Names buses BUS - <what>/);
});

test("a watched video is one line: what it is, where its words came from, the frames and the sound", async () => {
  const f = fixture(); await delay(0);
  f.emit({ type: "watched", title: "1 Minute Reese With Operator", url: "https://youtu.be/x", duration: 81, from: 0, to: 81, chapters: [], words: "automatic", lines: 6,
    frames: [{ at: 5, thumb: { width: 32, height: 18, rgb: new Uint8Array(32 * 18 * 3) } }, { at: 65, thumb: { width: 32, height: 18, rgb: new Uint8Array(32 * 18 * 3) } }],
    sound: { from: 20, to: 30 }, notes: ["Kumi couldn't take the frame at 1:10 (private-token)."] });
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.match(f.output, /\[watched\] “1 Minute Reese With Operator” \(1:21\): 0:00–1:21, its automatic captions, frames at 0:05, 1:05, the sound at 0:20–0:30/);
  assert.match(f.output, /\[watched\] Kumi couldn't take the frame at 1:10/);
  assert.ok(!f.output.includes("private-token"));
});

test("a search or a page Kumi read is one line: what it looked for or read, and where", async () => {
  const f = fixture(); await delay(0);
  f.emit({ type: "web", action: "searched", title: "erbe verb", where: "github", via: "GitHub", results: 1 });
  f.emit({ type: "web", action: "read", title: "https://example.com/manual", url: "https://example.com/manual", kind: "a page" });
  f.emit({ type: "web", action: "searched", title: "nothing like this private-token", where: "web", via: "Exa", results: 0 });
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.match(f.output, /\[web\] Searched GitHub for “erbe verb” · 1 repository/);
  assert.match(f.output, /\[web\] Read example\.com\/manual\n/);
  assert.match(f.output, /\[web\] Searched the web for “nothing like this .*” · nothing found/);
  assert.ok(!f.output.includes("private-token"));
});

test("plain lines say when a newer Kumi is out, and /update closes Kumi so it updates (or says it's up to date)", async () => {
  let requested = 0; let latest: string | undefined;
  const f = fixture(false, false, undefined, { current: "1.0.0", check: async () => latest, request: () => { requested++; } }); await delay(0);
  f.input.write("/update\n"); await delay(5);
  assert.match(f.output, /\[update\] Kumi is up to date \(1\.0\.0\)\./);
  latest = "1.1.0";
  f.terminal.offerUpdate("1.1.0");
  assert.match(f.output, /\[update\] Kumi 1\.1\.0 is out \(this is 1\.0\.0\)\. \/update gets it\./);
  f.input.write("/update\n");
  assert.equal(await f.done, 0);
  assert.match(f.output, /Updating to Kumi 1\.1\.0: Kumi closes, updates and opens again\./);
  assert.equal(requested, 1);
});

test("plain lines list a Set's conversations and go back to one; /reconnect and /new say what they do", async () => {
  const f = fixture(); await delay(0);
  const resumed: string[] = [];
  f.controller.conversations = async () => [{ id: "now001", savedAt: Date.now(), first: "add a hi-hat groove", turns: 2, current: true },
    { id: "old001", savedAt: Date.now() - 2 * 3600_000, first: "make the bass wider", turns: 5, current: false }];
  f.controller.resumeConversation = async (id) => { resumed.push(id); return true; };
  f.controller.reconnect = async () => { f.calls.push("reconnect"); };
  f.input.write("/conversations\n"); await delay(5);
  assert.match(f.output, /1\. add a hi-hat groove \(this one, 2 requests\) · 2\. make the bass wider \(2 hours ago, 5 requests\)/);
  f.input.write("/conversations 2\n"); await delay(5);
  assert.deepEqual(resumed, ["old001"]);
  f.emit({ type: "resumed", savedAt: Date.now() - 2 * 3600_000, chosen: true, lines: [{ role: "user", text: "make the bass wider" }] });
  assert.match(f.output, /Back to your conversation from 2 hours ago/);
  assert.match(f.output, /you> make the bass wider/);
  f.input.write("/reconnect\n/new\n"); await delay(5);
  assert.ok(f.calls.includes("reconnect") && f.calls.includes("new"));
  assert.match(f.output, /New conversation\. Kumi won't use what's above/);
  f.input.end(); await f.done;
});

test("plain mode says once that it's learning the library, puts it in /status, and lists and forgets what it learned from the producer's Sets", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = false; input.isRaw = false; input.setRawMode = () => {};
  let output = "";
  const sink = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }), { isTTY: false, columns: 200 });
  let lines = [{ id: "tempo", line: "Tempo: usually 124 BPM" }, { id: "chain-vocal", line: "Vocals: EQ Eight → Compressor" }];
  const controller: SessionController = {
    async start() {}, async submit() {}, async refresh() {}, async newConversation() {}, async cancel() {}, async close() {},
    status() { return { state: "idle", connection: "disconnected", turns: 0 }; }, async undo() { return undefined; },
    async memory() { return { producer: [], set: [], saved: true }; },
    library: () => ({ state: "learning", sounds: 10, presets: 2, sets: 1, todo: 50, done: 10 }),
    async taste() { return lines; },
    async forgetTaste(id) { const had = lines.some((line) => line.id === id); lines = lines.filter((line) => line.id !== id); return had; },
  };
  const terminal = createTerminal({ controller, input, output: sink, models: fakeModels().control, mode: "inference-only", closeTimeoutMs: 25 });
  const done = terminal.run();
  await delay(0);
  for (let index = 0; index < 3; index++) terminal.handleEvent({ type: "library", status: { state: "learning", sounds: index, presets: 0, sets: 0, todo: 50, done: index } });
  input.write("/status\n/memory\n/forget u2\n/forget u9\n"); await delay(20);
  input.end(); assert.equal(await done, 0);
  const text = stripVTControlCharacters(output);
  assert.equal(text.split("Learning your library in the background…").length - 1, 1, "said once");
  assert.match(text, /\[status\].*; Learning your library in the background · 10 of 50 sounds/);
  assert.match(text, /\[memory\] From your Sets: u1 Tempo: usually 124 BPM · u2 Vocals: EQ Eight → Compressor/);
  assert.match(text, /\[memory\] Forgot, from your Sets: Vocals: EQ Eight → Compressor/);
  assert.match(text, /\[memory\] Use: \/forget <id>/);
});
