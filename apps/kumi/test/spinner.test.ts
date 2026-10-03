import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spin, spins, step } from "../src/spinner.js";

/** An output that's a terminal (or not), `columns` wide, and everything written to it. */
function output(isTTY: boolean, columns = 80) {
  let text = "";
  const out = Object.assign(new PassThrough(), { isTTY, columns });
  out.on("data", (chunk) => { text += String(chunk); });
  return { out, get text() { return text; } };
}
const terminal = { TERM_PROGRAM: "WezTerm", COLORTERM: "truecolor" };
const plainText = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

test("piped, a step is just its line, a quiet one says nothing, and nothing moves", async () => {
  const piped = output(false);
  assert.equal(await step(piped.out, terminal, "Copying the bridge…", async () => 42), 42);
  assert.equal(await step(piped.out, terminal, "Checking what changes…", async () => "planned", { keep: false }), "planned");
  assert.equal(piped.text, "Copying the bridge…\n");
  assert.equal(spins(piped.out, terminal), false);
});

test("in a terminal, a spinner turns after the line while the work runs, and the line stays without it", async () => {
  const tty = output(true);
  const result = await step(tty.out, terminal, "Updating Live's Remote Script and the bridge…", async () => { await delay(350); return "applied"; });
  assert.equal(result, "applied");
  const frames = tty.text.split("\r\u001b[2K").filter(Boolean);
  assert.ok(frames.length >= 3, `it turned (${frames.length} frames)`);
  for (const frame of frames.slice(0, -1)) assert.match(plainText(frame), /^Updating Live's Remote Script and the bridge… [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/);
  assert.ok(new Set(frames.slice(0, -1).map(plainText)).size > 1, "the glyph changes");
  assert.match(frames[0]!, /\u001b\[0;38;2;134;227;181m/, "in Kumi's accent colour");
  assert.equal(frames.at(-1), "Updating Live's Remote Script and the bridge…\n", "the line stays, without the spinner");
});

test("a quiet step shows only while it runs, and leaves its row empty", async () => {
  const tty = output(true);
  await step(tty.out, terminal, "Checking whether Live is open…", async () => false, { keep: false });
  assert.match(plainText(tty.text), /^\rChecking whether Live is open… ⠋\r$/);
  assert.ok(tty.text.endsWith("\r\u001b[2K"));
});

test("work that fails stops the spinner, keeps the line and passes the failure on", async () => {
  const tty = output(true);
  await assert.rejects(step(tty.out, terminal, "Downloading Kumi 9.9.9…", async () => { throw new Error("the download failed (503)"); }), /503/);
  assert.ok(tty.text.endsWith("\r\u001b[2KDownloading Kumi 9.9.9…\n"));
});

test("plain lines (KUMI_UI=plain, TERM=dumb) never spin, even in a terminal", async () => {
  for (const env of [{ ...terminal, KUMI_UI: "plain" }, { TERM: "dumb" }]) {
    const tty = output(true);
    await step(tty.out, env, "Packing the bridge…", async () => { await delay(150); });
    assert.equal(tty.text, "Packing the bridge…\n", JSON.stringify(env));
  }
});

test("where Kumi's icons are badges the spinner is plain characters, and NO_COLOR leaves it uncoloured", async () => {
  const tty = output(true);
  await step(tty.out, { KUMI_ICONS: "badges", NO_COLOR: "1" }, "Installing its package…", async () => { await delay(250); });
  const frames = tty.text.split("\r\u001b[2K").filter(Boolean).slice(0, -1);
  assert.ok(frames.length >= 2);
  for (const frame of frames) assert.match(frame, /^Installing its package… [|/\\-]$/);
});

test("a line wider than the window is shortened while it spins, and kept whole", () => {
  const tty = output(true, 31);
  const line = "Waiting for Live… (Enter or Ctrl-C stops waiting; nothing else depends on it)";
  const spinning = spin(tty.out, terminal, line);
  const frame = plainText(tty.text).replace(/^\r/, "");
  assert.equal([...frame].length, 30, "within the window, so each frame replaces the last");
  assert.match(frame, /^Waiting for Live… \(Enter or… ⠋$/);
  spinning.stop(); spinning.stop();
  assert.ok(tty.text.endsWith(`\r\u001b[2K${line}\n`));
  assert.equal(tty.text.split(line).length, 2, "stopping twice says it once");
});
