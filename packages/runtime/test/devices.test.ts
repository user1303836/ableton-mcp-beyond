import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { decodeAmxd, encodeAmxd } from "../src/devices/amxd.js";
import { checkMidiDevice, checkMidiDeviceIsolated } from "../src/devices/harness.js";
import { midiDeviceCode, midiDevicePatcher } from "../src/devices/midi.js";
import { checkSpec, type MidiSpec } from "../src/devices/spec.js";
import { afterFunctions, audioEffectPatcher, effectCode, inputsRead, instrumentPatcher, paramName, voiceCode } from "../src/devices/gen.js";
import { deviceTool } from "../src/devices/tool.js";

const folder = mkdtempSync(join(tmpdir(), "kumi-devices-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

/** A device a producer might ask for: each chord's lowest note, everything else untouched. */
const LOWEST = {
  type: "midi_effect", name: "Lowest Note", about: "Keeps the lowest note of each chord (notes within the window); everything else passes through untouched.",
  controls: [{ name: "Window", type: "number", min: 1, max: 50, default: 15, unit: "ms" }],
  code: `let pending = [];
let timer = null;
const sounding = new Map();
const key = (event) => event.channel + ":" + event.pitch;
function flush() {
  timer = null;
  if (!pending.length) return;
  const lowest = pending.reduce((a, b) => (b.pitch < a.pitch ? b : a));
  pending = [];
  send({ type: "noteon", pitch: lowest.pitch, velocity: lowest.velocity, channel: lowest.channel });
  sounding.set(key(lowest), lowest);
}
function midi(event) {
  if (event.type === "noteon") { pending.push(event); if (!timer) timer = after(params.Window, flush); return; }
  if (event.type === "noteoff") {
    if (pending.some((note) => key(note) === key(event))) { cancel(timer); flush(); }
    const note = sounding.get(key(event));
    if (note) { send({ type: "noteoff", pitch: note.pitch, channel: note.channel }); sounding.delete(key(event)); }
    return;
  }
  pass(event);
}
function reset() { pending = []; timer = null; sounding.clear(); }`,
  tests: [
    { name: "a chord keeps its lowest note", input: [{ type: "noteon", pitch: 64, velocity: 90, at: 0 }, { type: "noteon", pitch: 60, velocity: 100, at: 5 }, { type: "noteon", pitch: 67, at: 10 },
      { type: "noteoff", pitch: 60, at: 500 }, { type: "noteoff", pitch: 64, at: 500 }, { type: "noteoff", pitch: 67, at: 500 }],
      expect: [{ type: "noteon", pitch: 60, velocity: 100, at: 15 }, { type: "noteoff", pitch: 60, at: 500 }] },
    { name: "notes apart both play", input: [{ type: "noteon", pitch: 60, at: 0 }, { type: "noteon", pitch: 64, at: 20 }, { type: "noteoff", pitch: 60, at: 300 }, { type: "noteoff", pitch: 64, at: 320 }],
      expect: [{ type: "noteon", pitch: 60, at: 15 }, { type: "noteon", pitch: 64, at: 35 }, { type: "noteoff", pitch: 60, at: 300 }, { type: "noteoff", pitch: 64, at: 320 }] },
    { name: "the rest passes", input: [{ type: "cc", controller: 1, value: 64, at: 0 }, { type: "pitchbend", value: 9000, at: 5 }], expect: [{ type: "cc", controller: 1, value: 64 }, { type: "pitchbend", value: 9000 }] },
    { name: "a wider window", set: { Window: 30 }, input: [{ type: "noteon", pitch: 62, at: 0 }, { type: "noteon", pitch: 55, at: 25 }, { type: "noteoff", pitch: 62, at: 200 }, { type: "noteoff", pitch: 55, at: 200 }],
      expect: [{ type: "noteon", pitch: 55, at: 30 }, { type: "noteoff", pitch: 55, at: 200 }] },
  ],
};
const spec = (overrides: Record<string, unknown> = {}): MidiSpec => {
  const checked = checkSpec({ ...LOWEST, ...overrides });
  assert.ok("spec" in checked && checked.spec.type === "midi_effect", JSON.stringify(checked));
  return checked.spec as MidiSpec;
};

test("a device file is Live's container: ampf, the type's letters, meta, and the patcher as JSON", () => {
  const bytes = encodeAmxd("midi_effect", { patcher: { title: "x" } });
  assert.equal(bytes.toString("latin1", 0, 12), "ampf\u0004\u0000\u0000\u0000mmmm");
  assert.equal(bytes.toString("latin1", 12, 16), "meta");
  assert.equal(bytes.at(-1), 0, "the patcher ends in a NUL");
  assert.deepEqual(decodeAmxd(bytes), { type: "midi_effect", patcher: { patcher: { title: "x" } } });
  assert.equal(decodeAmxd(Buffer.from("not a device")), undefined);
  assert.equal(encodeAmxd("audio_effect", {}).toString("latin1", 8, 12), "aaaa");
});

test("a MIDI effect's patch: midiin, the code, midiout, and each control a Live parameter feeding it", () => {
  const patcher = midiDevicePatcher(spec({ controls: [{ name: "Window", type: "number", min: 1, max: 50, default: 15, unit: "ms" }, { name: "Mode", type: "choice", options: ["Lowest", "Highest"], default: "Lowest" }, { name: "Bypass Drums", type: "switch", default: false }] })) as { patcher: Record<string, unknown> };
  const boxes = (patcher.patcher.boxes as { box: Record<string, unknown> }[]).map((item) => item.box);
  assert.deepEqual(boxes.filter((box) => box.maxclass === "newobj").map((box) => box.text), ["midiin", "midiout", "prepend c1", "prepend c2", "prepend c3"]);
  const code = boxes.find((box) => box.maxclass === "v8.codebox")!;
  assert.match(String(code.code), /function midi\(event\)/);
  assert.match(String(code.code), /const CONTROLS = \[\{"id":"c1","name":"Window"\}/);
  const dial = boxes.find((box) => box.maxclass === "live.dial")!;
  assert.deepEqual((dial.saved_attribute_attributes as { valueof: Record<string, unknown> }).valueof, { parameter_longname: "Window", parameter_shortname: "Window", parameter_initial_enable: 1,
    parameter_type: 0, parameter_mmin: 1, parameter_mmax: 50, parameter_initial: [15], parameter_unitstyle: 2, parameter_exponent: 3 }, "a time over decades turns on a curve");
  assert.equal(boxes.find((box) => box.maxclass === "live.menu")!.varname, "Mode");
  assert.equal(boxes.find((box) => box.maxclass === "live.toggle")!.varname, "Bypass Drums");
  assert.equal(patcher.patcher.openinpresentation, 1);
  assert.equal((patcher.patcher.project as { amxdtype: number }).amxdtype, 0x6d6d6d6d);
  assert.equal(patcher.patcher.description, LOWEST.about);
});

test("the device's code can't reach files, the network or Max and Live: the frame hides them, and the check refuses them", () => {
  // Hidden at run time: Max's objects are undefined inside the device's own code.
  const code = midiDeviceCode({ controls: [], code: "function midi(event) { send({ type: 'cc', controller: 1, value: [typeof File, typeof Dict, typeof LiveAPI, typeof outlet, typeof max].every((kind) => kind === 'undefined') ? 1 : 0 }); }" });
  const sent: number[] = [];
  const context = vm.createContext({ outlet: (_index: number, byte: number) => sent.push(byte), post: () => {}, Task: class {}, File: class {}, Dict: class {}, LiveAPI: class {}, max: {}, inlet: 0 });
  vm.runInContext(code, context);
  for (const byte of [0xB0, 7, 100]) (context.msg_int as (value: number) => void)(byte);
  assert.deepEqual(sent, [0xB0, 1, 1]);
  // Refused up front, saying why.
  const refused = checkSpec({ ...LOWEST, code: "function midi(e) { const f = new File('/tmp/x'); XMLHttpRequest; outlet(0, 1); new Task(() => {}); eval('1'); }" });
  assert.ok("problems" in refused);
  assert.equal(refused.problems.length, 3, "one line for each kind of reach");
  assert.match(refused.problems.join(" "), /files, the network/);
  assert.match(refused.problems.join(" "), /can't make code/);
  // Ordinary names are fine: Math.max, a helper called parse, a class.
  assert.ok("spec" in checkSpec({ ...LOWEST, code: "class Voice { constructor(p) { this.p = p; } }\nconst parse = (x) => Math.max(0, x);\nfunction midi(event) { pass(event); }" }));
});

test("a spec says what's wrong with it, each so it can be fixed", () => {
  assert.match((checkSpec({ ...LOWEST, type: "reverb" }) as { problems: string[] }).problems.join(" "), /midi_effect, audio_effect or instrument/);
  const checked = checkSpec({ type: "midi_effect", name: "", about: "", controls: [
    { name: "Window", type: "number", min: 5, max: 1, default: 3 }, { name: "Window", type: "switch", default: true }, { name: "Mode", type: "choice", options: ["A"], default: "A" },
    { name: "Level", type: "integer", min: 0, max: 10, default: 2.5 }, { name: "Rate", type: "number", min: 0, max: 1, default: 0.5, unit: "furlongs" }], code: "send(1)", tests: [{ name: "x", input: "no" }] });
  assert.ok("problems" in checked);
  const text = checked.problems.join("\n");
  for (const expected of [/^name:/m, /^about:/m, /min is below max/, /used twice/, /2–128 options/, /whole-number/, /unit is one of/, /define function midi/, /^tests\[0\]/m]) assert.match(text, expected);
});

test("Kumi runs the device's tests and its own checks: a working device passes, a broken one is told what went wrong", () => {
  assert.deepEqual(checkMidiDevice(spec()), { passed: 4, of: 4, problems: [] });
  const wrongTest = checkMidiDevice(spec({ tests: [{ name: "wrong", input: [{ type: "noteon", pitch: 60, at: 0 }, { type: "noteoff", pitch: 60, at: 100 }], expect: [{ type: "noteon", pitch: 61 }] }] }));
  assert.match(wrongTest.problems[0]!, /^test "wrong": expected noteon pitch 61; got noteon pitch 60 velocity 100 at 15 ms, noteoff pitch 60 at 100 ms\.$/);
  const hanging = checkMidiDevice(spec({ code: "function midi(event) { if (event.type !== 'noteoff') send(event); }", tests: [] }));
  assert.match(hanging.problems.join(" "), /leaves notes hanging \(pitch 60, 64, 67, 72\)/);
  const throwing = checkMidiDevice(spec({ code: "function midi(event) { if (event.type === 'cc') missing(); pass(event); }", tests: [] }));
  assert.match(throwing.problems.join(" "), /it threw: missing is not defined/);
  const running = checkMidiDevice(spec({ code: "function tick() { after(100, tick); }\ntick();\nfunction midi(event) { pass(event); }", tests: [] }));
  assert.match(running.problems.join(" "), /timers keep running/);
  // A note-on of velocity 0 in a test goes to the device as one, which the frame hands on as a note-off.
  const zero = checkMidiDevice(spec({ tests: [{ name: "velocity 0 releases", input: [{ type: "noteon", pitch: 60, velocity: 100, at: 0 }, { type: "noteon", pitch: 60, velocity: 0, at: 90 }],
    expect: [{ type: "noteon", pitch: 60, at: 15 }, { type: "noteoff", pitch: 60, at: 90 }] }] }));
  assert.deepEqual(zero.problems, []);
  const broken = checkMidiDevice(spec({ code: "function midi(event) { pass(event) ", tests: [] }));
  assert.match(broken.problems.join(" "), /the code doesn't run/);
});

test("make_device reads its guide on demand, makes a device where Live's Browser sees it, and waits for the Browser", async () => {
  const seen: string[] = [];
  let calls = 0;
  const tool = deviceTool({ userLibrary: folder, waitMs: 5_000, browserSees: async (itemId) => { seen.push(itemId); return ++calls > 1; } });
  const guide = await tool.execute({ guide: true }, new AbortController().signal);
  assert.match(guide.text, /^Making a MIDI effect/);
  assert.match(guide.text, /Every note-on the device sends gets a note-off/);
  const made = await tool.execute(LOWEST, new AbortController().signal);
  assert.equal(made.isError, undefined, made.text);
  const result = JSON.parse(made.text) as Record<string, unknown>;
  assert.equal(result.itemId, "user_library/Kumi/Lowest Note");
  // Where it is too, so looking at it again needs no search.
  assert.equal(result.file, join(folder, "Kumi", "Lowest Note.amxd"));
  assert.deepEqual(result.controls, ["Window (1–50 ms; 15)"]);
  assert.match(String(result.checks), /4 of 4/);
  assert.equal(result.note, undefined, "the Browser listed it");
  assert.deepEqual(seen, ["user_library/Kumi/Lowest Note", "user_library/Kumi/Lowest Note"]);
  const decoded = decodeAmxd(readFileSync(join(folder, "Kumi", "Lowest Note.amxd")));
  assert.equal(decoded?.type, "midi_effect");
  assert.equal(decoded?.patcher.patcher.title, "Lowest Note");
  // A second one doesn't overwrite the first, which a Set may use.
  const again = JSON.parse((await tool.execute(LOWEST, new AbortController().signal)).text) as Record<string, unknown>;
  assert.equal(again.itemId, "user_library/Kumi/Lowest Note 2");
  // A broken one isn't made: the model is told what to fix.
  const refused = await tool.execute({ ...LOWEST, name: "Broken", code: "function midi(event) { if (event.type !== 'noteoff') send(event); }", tests: [] }, new AbortController().signal);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /leaves notes hanging/);
  assert.throws(() => readFileSync(join(folder, "Kumi", "Broken.amxd")));
});

test("a device's code is checked in a process of its own: it can't reach Kumi, can't make code from strings, and can't hang Kumi", async () => {
  // The same verdicts as in-process.
  assert.deepEqual(await checkMidiDeviceIsolated(spec()), { passed: 4, of: 4, problems: [] });
  // An escape through a host function's constructor can't compile anything.
  const escape = await checkMidiDeviceIsolated(spec({ code: "function midi(event) { const F = post['constr' + 'uctor']; F('return process')().exit(3); pass(event); }", tests: [] }));
  assert.match(escape.problems.join(" "), /it threw: .*[Cc]ode generation from strings disallowed/);
  // A loop that never ends is stopped at the deadline, and said.
  const started = Date.now();
  const endless = await checkMidiDeviceIsolated(spec({ code: "function midi(event) { while (true) {} }", tests: [] }), { timeoutMs: 1_500 });
  assert.match(endless.problems.join(" "), /didn't finish within 2 s; something loops forever/);
  assert.ok(Date.now() - started < 5_000);
});

/** An audio effect a producer might ask for: a saturator with a tone control, its own function first. */
const GRIT = {
  type: "audio_effect", name: "Grit", about: "Warm saturation with a tone control.",
  controls: [{ name: "Drive", type: "number", min: 0, max: 24, default: 6, unit: "dB" }, { name: "Tone", type: "number", min: 0, max: 1, default: 0.5 }, { name: "Hard", type: "switch", default: false }],
  code: `// Soft or hard clipping.
shaper(x, hard_clip) {
  return hard_clip > 0.5 ? clamp(x, -1, 1) : tanh(x);
}
History lp_l(0), lp_r(0);
g = dbtoa(drive);
lp_l = mix(lp_l, shaper(in1 * g, hard), 0.05 + tone * 0.9);
lp_r = mix(lp_r, shaper(in2 * g, hard), 0.05 + tone * 0.9);
out1 = lp_l / g;
out2 = lp_r / g;`,
};

/** A plucked voice for an instrument. */
const PLUCK = {
  type: "instrument", name: "Pluck", about: "A plucked saw.", voices: 6,
  controls: [{ name: "Decay", type: "number", min: 0.05, max: 4, default: 0.6, unit: "s" }],
  code: `History env(0);
env = change(strike) != 0 ? velocity / 127 : env * exp(-1 / (decay * samplerate));
osc = phasor(mtof(note + bend)) * 2 - 1;
out1 = osc * env * 0.2;
out2 = out1;`,
};

const inner = (patcher: object, id: string) => {
  const box = (patcher as { patcher: { boxes: { box: Record<string, unknown> }[] } }).patcher.boxes.find((item) => item.box.id === id)!.box;
  return box as { text: string; numinlets: number; patcher: { classnamespace: string; boxes: { box: Record<string, unknown> }[]; lines: { patchline: { source: [string, number]; destination: [string, number] } }[] } };
};
const codeOf = (patcher: object, id: string) => String(inner(patcher, id).patcher.boxes.find((item) => item.box.maxclass === "codebox")!.box.code);
const wires = (patcher: object) => (patcher as { patcher: { lines: { patchline: { source: [string, number]; destination: [string, number] } }[] } }).patcher.lines.map((line) => `${line.patchline.source.join(":")}>${line.patchline.destination.join(":")}`);

test("GenExpr's order holds: the model's functions first, then Kumi's Params for the controls, then the rest; inputs as the code reads them", () => {
  assert.equal(paramName("Decay Time"), "decay_time"); assert.equal(paramName(" Hi-Cut 2 "), "hi_cut_2");
  const code = effectCode({ ...GRIT, controls: GRIT.controls as never });
  const shaper = code.indexOf("shaper(x, hard_clip)"); const params = code.indexOf("Param drive(6, min=0, max=24);"); const history = code.indexOf("History lp_l");
  assert.ok(shaper >= 0 && params > shaper && history > params, code);
  assert.match(code, /Param tone\(0\.5, min=0, max=1\);\nParam hard\(0, min=0, max=1\);/);
  assert.equal(afterFunctions("out1 = in1; out2 = in2;"), 0, "no functions: Params go first");
  assert.equal(afterFunctions("foo(1);\nout1 = in1;"), 0, "a call isn't a definition");
  assert.equal(inputsRead(GRIT.code), 2); assert.equal(inputsRead("out1 = in1; out2 = in1; // in2 in a comment"), 1); assert.equal(inputsRead(PLUCK.code), 0);
  const voice = voiceCode({ ...PLUCK, controls: PLUCK.controls as never });
  assert.match(voice, /Param note\(60, min=0, max=127\);[\s\S]*Param strike\(0\);[\s\S]*Param decay\(0\.6, min=0\.05, max=4\);\n\nHistory env\(0\);/);
});

test("an audio effect: plugin~ into the model's gen~, Kumi's fixed output stage with Mix and Output, plugout~; each control a Live parameter", () => {
  const checked = checkSpec(GRIT);
  assert.ok("spec" in checked && checked.spec.type === "audio_effect", JSON.stringify(checked));
  const patcher = audioEffectPatcher(checked.spec as never);
  const effect = inner(patcher, "obj-effect");
  assert.equal(effect.text, "gen~"); assert.equal(effect.patcher.classnamespace, "dsp.gen"); assert.equal(effect.numinlets, 2);
  assert.match(codeOf(patcher, "obj-effect"), /\r\n/, "Max's line endings");
  const stage = codeOf(patcher, "obj-output");
  for (const line of ["Param kumi_mix(100", "Param kumi_output(0", "clamp(dcblock(fixnan(fixdenorm(in1))), -2, 2)"]) assert.ok(stage.includes(line), line);
  // The dry signal passes untouched: a hot track isn't clipped by a Kumi effect at Mix 0.
  assert.match(stage, /out1 = mix\(in3, clamp\(dcblock\(fixnan\(fixdenorm\(in1\)\)\), -2, 2\), wet\) \* gain;/);
  const lines = wires(patcher);
  for (const expected of ["obj-plugin:0>obj-effect:0", "obj-plugin:1>obj-effect:1", "obj-effect:0>obj-output:0", "obj-plugin:0>obj-output:2", "obj-plugin:1>obj-output:3", "obj-output:1>obj-plugout:1"]) assert.ok(lines.includes(expected), expected);
  const faces = (patcher as { patcher: { boxes: { box: Record<string, unknown> }[] } }).patcher.boxes.filter((item) => item.box.parameter_enable === 1).map((item) => item.box);
  assert.deepEqual(faces.map((box) => (box.saved_attribute_attributes as { valueof: { parameter_longname: string } }).valueof.parameter_longname), ["Drive", "Tone", "Hard", "Mix", "Output"]);
  assert.ok(lines.includes("obj-control-1:0>obj-prepend-1:0"));
  assert.equal(inner(patcher, "obj-prepend-1").text, "prepend drive");
  assert.equal(inner(patcher, "obj-prepend-4").text, "prepend kumi_mix");
  const mono = audioEffectPatcher({ ...(checked.spec as never as { name: string; about: string; controls: [] }), controls: [], code: "out1 = tanh(in1); out2 = out1;" });
  assert.equal(inner(mono, "obj-effect").numinlets, 1);
  assert.ok(!wires(mono).includes("obj-plugin:1>obj-effect:1"), "a code that reads only in1 gets only in1");
  assert.equal(decodeAmxd(encodeAmxd("audio_effect", patcher))?.type, "audio_effect");
});

test("an instrument: notes shared out by poly to one gen~ per voice (bend exactly 0 at rest, a strike per note), every voice into Kumi's output stage", () => {
  const checked = checkSpec(PLUCK);
  assert.ok("spec" in checked && checked.spec.type === "instrument" && checked.spec.voices === 6, JSON.stringify(checked));
  const patcher = instrumentPatcher(checked.spec as never);
  assert.equal(inner(patcher, "obj-poly").text, "poly 6 1");
  assert.equal(inner(patcher, "obj-route").text, "route 1 2 3 4 5 6");
  assert.equal(inner(patcher, "obj-bendcentre").text, "- 64"); assert.equal(inner(patcher, "obj-bendscale").text, "/ 32.");
  const voices = (patcher as { patcher: { boxes: { box: Record<string, unknown> }[] } }).patcher.boxes.filter((item) => String(item.box.id).startsWith("obj-voice-"));
  assert.equal(voices.length, 6);
  assert.equal(inner(patcher, "obj-voice-1").numinlets, 1, "no audio input, one inlet for its Params");
  const lines = wires(patcher);
  for (let voice = 1; voice <= 6; voice++) {
    for (const expected of [`obj-route:${voice - 1}>obj-order-${voice}:0`, `obj-order-${voice}:1>obj-unpack-${voice}:0`, `obj-order-${voice}:0>obj-heard-${voice}:0`, `obj-note-${voice}:0>obj-voice-${voice}:0`, `obj-strike-${voice}:0>obj-voice-${voice}:0`, `obj-voice-${voice}:0>obj-output:0`, `obj-voice-${voice}:1>obj-output:1`, `obj-prepend-1:0>obj-voice-${voice}:0`]) {
      assert.ok(lines.includes(expected), expected);
    }
  }
  assert.ok(lines.includes("obj-heard-1:1>obj-played-1:0") && lines.includes("obj-played-1:1>obj-bang-1:0"), "a strike counts only notes played (velocity above 0)");
  // On real Live, a bare counter (first count 0) left strike at 0, so no voice played its first note.
  assert.equal(inner(patcher, "obj-count-1").text, "counter 1 1000000", "a voice's first note changes strike too");
  assert.match(codeOf(patcher, "obj-output"), /Param kumi_output/);
  assert.doesNotMatch(codeOf(patcher, "obj-output"), /kumi_mix/, "an instrument has no dry signal to mix");
  assert.equal(decodeAmxd(encodeAmxd("instrument", patcher))?.type, "instrument");
});

test("Kumi's checks for an audio effect or an instrument say what's wrong, each so it can be fixed", () => {
  const problems = (input: Record<string, unknown>) => { const checked = checkSpec(input); return "problems" in checked ? checked.problems.join("\n") : ""; };
  assert.match(problems({ ...GRIT, controls: [{ name: "Mix", type: "number", min: 0, max: 1, default: 1 }] }), /Kumi adds Mix/);
  assert.match(problems({ ...GRIT, controls: [{ name: "Delay", type: "number", min: 0, max: 1, default: 1 }] }), /Param delay, a name gen~ or Kumi already uses; call it something else/);
  assert.match(problems({ ...GRIT, controls: Array.from({ length: 129 }, (_, index) => ({ name: `Knob ${index + 1}`, type: "number", min: 0, max: 1, default: 0 })) }), /controls: at most 128\./);
  assert.match(problems({ ...GRIT, controls: [{ name: "Pre-Delay", type: "number", min: 0, max: 1, default: 0 }, { name: "Pre Delay", type: "number", min: 0, max: 1, default: 0 }] }), /"Pre Delay" and "Pre-Delay" would both be the Param pre_delay/);
  assert.match(problems({ ...GRIT, code: "out1 = in1;" }), /assign out1 \(left\) and out2 \(right\)/);
  assert.match(problems({ ...GRIT, code: "out1 = in3; out2 = in1;" }), /two inputs/);
  assert.match(problems({ ...GRIT, code: "out1 = cycle(440); out2 = out1;" }), /reads its input/);
  assert.match(problems({ ...GRIT, code: "out1 = in1 * (velocity / 127); out2 = in2;" }), /gets no notes/);
  assert.match(problems({ ...GRIT, code: "out1 = tanh(in1; out2 = in2;" }), /don't pair up/);
  assert.match(problems({ ...PLUCK, code: "out1 = in1; out2 = in2;" }), /no audio input/);
  assert.match(problems({ ...PLUCK, code: "out1 = cycle(440); out2 = out1;" }), /plays the note it's given/);
  assert.match(problems({ ...PLUCK, voices: 33 }), /1 \(mono\) to 32/);
  assert.match(problems({ ...PLUCK, code: "Param note(60);\nout1 = cycle(mtof(note)); out2 = out1;" }), /Kumi's; use them without declaring/);
  // A control's Param declared by the model too (as gen~ code usually is) would be declared twice.
  assert.match(problems({ ...GRIT, code: "Param drive(1, min=1, max=20);\nout1 = tanh(in1 * drive); out2 = tanh(in2 * drive);" }), /drive is the Drive control's Param, which Kumi declares/);
  assert.equal(problems({ ...GRIT, tests: [{ name: "ignored", input: [], expect: [] }] }), "", "an audio effect isn't tested with MIDI; its tests are left out");
});

test("a device gets what it needs: many controls in rows on the face, names with punctuation, long menus, more voices", () => {
  const knobs = Array.from({ length: 20 }, (_, index) => ({ name: `Size/Decay-${index + 1}`, type: "number", min: 0, max: 1, default: 0.5 }));
  const checked = checkSpec({ ...GRIT, controls: knobs });
  assert.ok("spec" in checked && checked.spec.controls.length === 20, JSON.stringify(checked));
  const patcher = audioEffectPatcher(checked.spec as never) as { patcher: { devicewidth: number; boxes: { box: Record<string, unknown> }[] } };
  const faces = patcher.patcher.boxes.filter((item) => item.box.parameter_enable === 1).map((item) => item.box.presentation_rect as number[]);
  assert.equal(faces.length, 22, "20 of the model's, Mix and Output");
  // 22 controls: three rows of 8, all inside Live's 169-pixel device view, and the face as wide as its rows.
  assert.deepEqual([...new Set(faces.map((rect) => rect[1]))], [8, 60, 112]);
  assert.ok(faces.every((rect) => rect[1]! + rect[3]! <= 169));
  assert.equal(patcher.patcher.devicewidth, 16 + 8 * 52);
  // Up to eight stay in one row, as before.
  const midi = midiDevicePatcher(spec()) as { patcher: { devicewidth: number } };
  assert.equal(midi.patcher.devicewidth, 120);
  const menu = checkSpec({ ...LOWEST, controls: [{ name: "Scale", type: "choice", options: Array.from({ length: 40 }, (_, index) => `Mode ${index + 1}`), default: "Mode 1" }] });
  assert.ok("spec" in menu, JSON.stringify(menu));
  const wide = checkSpec({ ...PLUCK, voices: 16 });
  assert.ok("spec" in wide && wide.spec.type === "instrument" && wide.spec.voices === 16);
  assert.equal(inner(instrumentPatcher(wide.spec as never), "obj-poly").text, "poly 16 1");
});

test("a MIDI effect that runs free (an LFO, a clock) passes with runs_free; without it, Kumi asks for it or for its timers to stop", async () => {
  const lfo = { ...LOWEST, name: "CC LFO", controls: [{ name: "Rate", type: "number", min: 10, max: 1000, default: 50, unit: "ms" }], tests: [],
    code: "let phase = 0;\nfunction tick() { phase = (phase + 1) % 32; send({ type: 'cc', controller: 74, value: Math.abs(16 - phase) * 8 }); after(params.Rate, tick); }\ntick();\nfunction midi(event) { pass(event); }\nfunction reset() { tick(); }" };
  assert.match(checkMidiDevice(spec(lfo)).problems.join(" "), /timers keep running[\s\S]*runs_free: true/);
  const free = checkSpec({ ...lfo, runs_free: true });
  assert.ok("spec" in free && free.spec.type === "midi_effect" && free.spec.runsFree === true, JSON.stringify(free));
  assert.deepEqual(await checkMidiDeviceIsolated(free.spec as MidiSpec), { passed: 0, of: 0, problems: [] });
  // Running free isn't sending without end.
  const flood = checkMidiDevice({ ...(free.spec as MidiSpec), code: "function tick() { for (let i = 0; i < 50; i++) send({ type: 'cc', controller: 1, value: i }); after(1, tick); }\ntick();\nfunction midi(event) { pass(event); }" });
  assert.match(flood.problems.join(" "), /something sends without end/);
  assert.match((checkSpec({ ...lfo, runs_free: "yes" }) as { problems: string[] }).problems.join(" "), /runs_free: true for a MIDI effect/);
});

test("make_device makes an audio effect and an instrument, with Kumi's own knobs, and says to hear them", async () => {
  const tool = deviceTool({ userLibrary: folder, waitMs: 1_000, browserSees: async () => true });
  assert.match((await tool.execute({ guide: true, type: "audio_effect" }, new AbortController().signal)).text, /^Making an audio effect[\s\S]*Max compiles the code when Live loads/);
  assert.match((await tool.execute({ guide: true, type: "instrument" }, new AbortController().signal)).text, /^Making an instrument[\s\S]*change\(strike\) != 0/);
  const effect = JSON.parse((await tool.execute(GRIT, new AbortController().signal)).text) as Record<string, unknown>;
  assert.equal(effect.type, "audio effect"); assert.equal(effect.itemId, "user_library/Kumi/Grit");
  assert.deepEqual(effect.controls, ["Drive (0–24 dB; 6)", "Tone (0–1; 0.5)", "Hard (on/off; off)", "Mix (0–100 %; 100)", "Output (-36–12 dB; 0)"]);
  assert.match(String(effect.next), /audition/);
  assert.equal(decodeAmxd(readFileSync(join(folder, "Kumi", "Grit.amxd")))?.type, "audio_effect");
  const instrument = JSON.parse((await tool.execute(PLUCK, new AbortController().signal)).text) as Record<string, unknown>;
  assert.equal(instrument.type, "instrument"); assert.equal(instrument.voices, 6);
  assert.equal(decodeAmxd(readFileSync(join(folder, "Kumi", "Pluck.amxd")))?.type, "instrument");
});
