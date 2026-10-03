/**
 * make_device: the model describes a Max for Live device (its name, controls, code and tests) and
 * Kumi builds it, runs its tests and Kumi's own checks, writes it where Live's Browser sees it
 * (User Library › Kumi), and waits for the Browser to list it, so load_device can put it on a track
 * with HISTORY and undo like any other device. The guide is read on demand, not with every request.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KernelTool } from "../core/contracts.js";
import { encodeAmxd } from "./amxd.js";
import { lowDisk, MB } from "../core/disk.js";
import { checkMidiDeviceIsolated } from "./harness.js";
import { audioEffectPatcher, instrumentPatcher, MAX_VOICES, MIX, OUTPUT } from "./gen.js";
import { midiDevicePatcher } from "./midi.js";
import { checkSpec, DEVICE_KINDS, MAX_CODE, MAX_CONTROLS, MAX_TESTS, UNITS, type Control } from "./spec.js";

export const MAKE_DEVICE_TOOL = "make_device";

const DESCRIPTION = [
  "Make a Max for Live device the producer asks for: a MIDI effect, an audio effect or an instrument. Kumi writes it to their User Library for load_device.",
  "Read the guide for the kind first (guide: true, type): what the device's code can use, the rules Kumi checks, and what makes a device good.",
  "Then give its type, name, what it does, its controls (knobs, menus and switches, which become ordinary Live parameters) and its code:",
  "JavaScript for a MIDI effect (with tests Kumi runs), GenExpr (Max's gen~) for an audio effect or one voice of an instrument.",
  "Kumi builds the device around the code, checks it, and refuses a device that breaks a rule, saying why so you can fix it.",
  "Build what the producer asks for, as fully as they ask: as many controls as it needs, and the original's behaviour when recreating one. Kumi's rules keep a device safe and loadable; they don't limit its scope, and its ceilings are generous.",
  "Then load it with load_device and the itemId it returns, and hear an audio effect or instrument with audition.",
].join(" ");

const GUIDE_MIDI = `Making a MIDI effect

Your code runs inside Kumi's frame in Live's Max (JavaScript, v8, strict mode). You write functions and the frame calls them:
- function midi(event): required. Called for every MIDI message that arrives. What you don't send on is dropped, so pass(event) whatever the device doesn't change.
- function changed(name, value): optional. A control moved (a number; the option's text for a choice; true or false for a switch).
- function reset(): optional. Forget anything pending. Called on all-notes-off, after which the frame turns off every note the device still holds.

Events: { type, channel (1–16), time (ms) } and
- noteon, noteoff: pitch (0–127), velocity (0–127)
- cc: controller, value; pitchbend: value (0–16383, 8192 is the centre); aftertouch: value; polytouch: pitch, value; program: value

What your code can use:
- send(event) sends an event of that shape (channel defaults to 1, velocity to 100); pass(event) sends one on as it came.
- after(ms, fn) runs fn later and returns a timer; cancel(timer) stops it.
- params["Name"] is a control's value now; now() is the time in milliseconds.
- Plain JavaScript: Math, arrays, objects, Map, Set, classes. Not files, the network, or Max's and Live's objects: the frame hides them, and Kumi refuses code that reaches for them.

Rules Kumi checks, refusing the device and saying which it broke:
- Every note-on the device sends gets a note-off. When you delay, transpose or replace notes, send the note-off for the pitch you sent, not the one that arrived, and forget a pending note whose note-off comes first.
- Once every note is released, nothing is left running: cancel timers, or let them end. A device that runs free (an LFO, a clock, a generator that keeps sending on its own) gives runs_free: true instead: start its timer in the code and again in reset(), since an all-notes-off stops every timer.
- It runs without an error on a chord, a single note, a controller, a bend and aftertouch, and doesn't send without end.
- As many controls as the device needs (up to ${MAX_CONTROLS}), each named in up to 32 characters (the producer's own words: letters, digits, spaces and . _ ( ) & ' + / # % -), with a range, a unit (${UNITS.filter(Boolean).join(", ")}, or none) and a default that works on load. Past eight, the face shows them in up to three rows.

Craft:
- JavaScript in Max runs on its low-priority thread, so its timing can wander by a few milliseconds: right for grouping chords or delays of tens of milliseconds, not for sample-accurate work.
- Keep midi() quick.
- For anything grouped in time (chords, strums), hold the note-ons for the window and close it early when a note-off arrives. The delay is the price of clean output; say so when it matters.
- Pass controllers, bend, aftertouch and program changes through unless changing them is the device's job.
- Choose sensible defaults and say what they are. Ask the producer at most one question, and only when a choice changes the result (such as delaying note-ons or retriggering); otherwise decide.

Tests: write 2 to 6 of what the device must do. Each has input events (with at, in ms), the events expected out in order (the fields you name are compared, and at to within 3 ms), and set for any control values. Kumi runs them and its own checks before it makes the device; when one fails it says what came out instead, so fix the code or the test and call make_device again.

Then load_device with the itemId it returns, on the producer's MIDI track: Live puts a MIDI effect before the instrument. Tell the producer in a sentence or two what it does and what its controls are.`;

/** What an audio effect's and an instrument's code share: GenExpr, as gen~ runs it. */
const GENEXPR = `GenExpr is the language of Max's gen~: C-like, run once per sample. Variables need no declaring; every statement ends with a semicolon.
- Its order is fixed: your function definitions first (name(a, b) { ... return x; }), then declarations (History, Delay, Data), then statements. Kumi puts the Params for your controls after your functions.
- Each control is a Param, named like it: a control "Decay Time" is decay_time in the code (Kumi declares it: read it, and don't declare it again). A number control is its value; a choice is its option's index (0, 1, …); a switch is 0 or 1. Don't name functions or variables like a control's Param.
- History x(0); keeps x from one sample to the next (filters, envelopes, feedback). Delay d(samplerate); is a delay line up to one second long (d.write(v); y = d.read(mstosamps(ms)); interp="linear" in the declaration or the read makes it smooth). Data t(512); is a table (peek, poke).
- Operators you'll use: mix(a, b, t), clamp(x, lo, hi), tanh, abs, sqrt, pow, exp, sin, cos, dbtoa, atodb, mtof, ftom, mstosamps, phasor(hz), cycle(hz), triangle(phase, duty), noise(), slide(x, up, down), dcblock, latch, sah, change(x), delta, scale, fold, wrap, interp, and the constants samplerate, pi, twopi.
- Use samplerate, never 44100: Live runs at whatever rate the producer set.
- Kumi's output stage follows your code: your output has NaN, denormals and DC taken out and is held under +6 dBFS (hard: a safety net against a runaway patch at the device's output, not a limiter to lean on); on an effect, Mix blends it with the dry signal, which passes untouched; Output sets the level. Inside your code nothing is capped: feedback, gain and self-oscillation are yours.
- Give the device as many controls as it needs (up to ${MAX_CONTROLS}): when recreating a device, all of the original's. Past eight, the face shows them in up to three rows.`;

const GUIDE_AUDIO = `Making an audio effect

${GENEXPR}

An audio effect: in1 and in2 are the left and right input; assign out1 and out2 (left, right) every sample. Kumi adds Mix (dry against your output) and Output knobs, so don't make your own.

Craft:
- Feedback: under 1 it dies away; at 1 or more it holds or self-oscillates, which some devices are made for (an infinite reverb, a delay that runs away, a resonator). Damp it (a one-pole lowpass in the loop), and at 1 or more put a saturator (tanh) in the loop too, so it settles at a level instead of growing without end.
- Smooth any control that changes delay times or gains quickly (slide, or a one-pole: y = mix(y, target, 0.001)), or it clicks.
- Reverbs: a few allpass diffusers into a feedback delay network, damped in the loop (Schroeder, Moorer, or a Dattorro plate). Delays: a Delay with feedback and a filter in the loop; ping-pong swaps channels. Saturation: tanh or a polynomial, with gain before and makeup after. Filters: one-poles and biquads from History.
- Choose sensible defaults, so it sounds right when it loads.

Max compiles the code when Live loads the device. If it doesn't compile, the device lets no sound through: after loading it (load_device with the itemId, onto the track), hear it with audition, playing audio through that track, and against the reference if the producer gave one. A silent render means fix the code.`;

const GUIDE_INSTRUMENT = `Making an instrument

${GENEXPR}

An instrument: you write one voice, and Kumi plays copies of it (voices: 8 when left out, up to ${MAX_VOICES}, 1 for a mono synth), sharing out the notes and taking the oldest voice when all are busy. Each voice gets, besides your controls:
- note: the MIDI note it plays (mtof(note + bend) is its frequency)
- velocity: 0–127, and 0 once the key is released (start the release then)
- strike: a new number for every note played: change(strike) != 0 is the moment a note starts, even when a busy voice is taken for one at the same velocity (start the attack then)
- bend: pitch bend in semitones (±2); mod_wheel: 0–1
Assign out1 and out2 (left, right). There's no audio input. Kumi adds an Output knob.

Craft:
- Envelopes from History: on a strike, restart the attack; while velocity > 0, rise to the sustain; once it's 0, fall (exp(-1 / (seconds * samplerate)) per sample makes an exponential decay).
- Voices add up: keep one voice around 0.2 at full velocity, so a chord stays well under 0 dBFS.
- Oscillators: phasor(freq) is a rising ramp 0–1 (a saw once scaled to -1..1; it aliases, so filter it or use a polyBLEP), cycle(freq) a sine, triangle(phasor(freq), 0.5) a triangle, noise() white noise. Detune by adding cents: mtof(note + bend + cents / 100).
- A filter with its cutoff following an envelope does most of the work in subtractive sounds; FM is cycle(freq + cycle(freq * ratio) * index * freq).
- Choose sensible defaults, so it plays well when it loads.

Max compiles the code when Live loads the device. If it doesn't compile, the instrument is silent: after loading it (load_device with the itemId onto a MIDI track), write a short clip and hear it with audition. A silent render means fix the code.`;

const guideFor = (type: unknown) => type === "audio_effect" ? GUIDE_AUDIO : type === "instrument" ? GUIDE_INSTRUMENT : type === "midi_effect" ? GUIDE_MIDI
  : `${GUIDE_MIDI}\n\n${GUIDE_AUDIO}\n\n${GUIDE_INSTRUMENT}`;

const EVENT = { type: "object", description: "{ type: noteon|noteoff|cc|pitchbend|aftertouch|polytouch|program, pitch, velocity, controller, value, channel, at (ms) }" };

/** A file name for the device that isn't taken yet: "Lowest Note", then "Lowest Note 2" and on. */
function freeName(folder: string, name: string): string {
  for (let index = 1; index < 1_000; index++) {
    const candidate = index === 1 ? name : `${name} ${index}`;
    if (!existsSync(join(folder, `${candidate}.amxd`))) return candidate;
  }
  return `${name} ${randomUUID().slice(0, 8)}`;
}

const describeControl = (control: Control) => control.type === "choice" ? `${control.name} (${control.options.join(" / ")}; ${control.default})`
  : control.type === "switch" ? `${control.name} (on/off; ${control.default ? "on" : "off"})`
  : `${control.name} (${control.min}–${control.max}${control.unit ? ` ${control.unit}` : ""}; ${control.default})`;

export interface DeviceToolOptions {
  /** Live's User Library: devices go in its Kumi folder. */
  userLibrary: string;
  /** Whether Live's Browser lists `itemId` yet. */
  browserSees(itemId: string, signal: AbortSignal): Promise<boolean>;
  /** How long to wait for the Browser (it indexes new files on its own time). */
  waitMs?: number;
}

const KIND_NAMES = { midi_effect: "MIDI effect", audio_effect: "audio effect", instrument: "instrument" } as const;
const NEXT = {
  midi_effect: "load_device with this itemId on the MIDI track; Live puts a MIDI effect before the instrument.",
  audio_effect: "load_device with this itemId on the track, then hear it with audition while audio plays through that track (a silent render means the code didn't compile: fix it and make it again).",
  instrument: "load_device with this itemId on a MIDI track, write a short clip, and hear it with audition (a silent render means the code didn't compile: fix it and make it again).",
} as const;

export function deviceTool(options: DeviceToolOptions): KernelTool {
  return {
    name: MAKE_DEVICE_TOOL, description: DESCRIPTION,
    inputSchema: { type: "object", additionalProperties: false, properties: {
      guide: { type: "boolean", description: "true: read how to make a device of this type (first)" },
      type: { type: "string", enum: [...DEVICE_KINDS], description: "midi_effect (JavaScript), audio_effect or instrument (GenExpr); midi_effect when left out" },
      name: { type: "string", minLength: 1, maxLength: 32, description: "The device's name, as the producer would say it" },
      about: { type: "string", minLength: 1, maxLength: 400, description: "What it does, in a sentence or two" },
      controls: { type: "array", maxItems: MAX_CONTROLS, items: { type: "object", properties: {
        name: { type: "string" }, type: { type: "string", enum: ["number", "integer", "choice", "switch"] }, min: { type: "number" }, max: { type: "number" },
        default: { description: "A number, one of the options, or true/false" }, unit: { type: "string", enum: [...UNITS] }, options: { type: "array", items: { type: "string" } } } } },
      code: { type: "string", maxLength: MAX_CODE, description: "A MIDI effect's JavaScript (function midi(event) and helpers), or an audio effect's or one instrument voice's GenExpr (see the guide)" },
      voices: { type: "integer", minimum: 1, maximum: MAX_VOICES, description: "An instrument's voices: how many notes play at once, 1 for mono (8 when left out)" },
      runs_free: { type: "boolean", description: "A MIDI effect that keeps sending on its own once every note is released (an LFO, a clock, a generator)" },
      tests: { type: "array", maxItems: MAX_TESTS, description: "A MIDI effect's tests", items: { type: "object", properties: { name: { type: "string" }, set: { type: "object" }, input: { type: "array", items: EVENT }, expect: { type: "array", items: EVENT } } } } } },
    async execute(input, signal) {
      if (input.guide === true) return { text: guideFor(input.type) };
      const checked = checkSpec(input);
      if ("problems" in checked) return { text: JSON.stringify({ problems: checked.problems, next: "Fix these and call make_device again." }), isError: true };
      const spec = checked.spec;
      let tested: string;
      if (spec.type === "midi_effect") {
        // In a process of its own: the code is the model's, and may be steered by text Kumi read (a video, a name).
        const verified = await checkMidiDeviceIsolated(spec);
        if (verified.problems.length) return { text: JSON.stringify({ problems: verified.problems, passed: `${verified.passed} of ${verified.of} of its tests`, next: "Fix the code (or a test that's wrong) and call make_device again." }), isError: true };
        tested = `${verified.passed} of ${verified.of} of its tests passed, and Kumi's checks (${spec.runsFree ? "no errors; it runs free" : "no errors, no hanging notes"})`;
      } else tested = "Kumi's checks passed (its outputs, its inputs, its controls); Max compiles the code when Live loads it";
      signal.throwIfAborted();
      // Where Live's Browser looks: a folder that stays, so new files are noticed quickly.
      const folder = join(options.userLibrary, "Kumi");
      // A device file cut short by a full disk would load as a broken device.
      const full = await lowDisk(options.userLibrary, 100 * MB, "Live's User Library is on");
      if (full) return { text: `${full} No device was made.`, isError: true };
      await mkdir(folder, { recursive: true, mode: 0o755 });
      const name = freeName(folder, spec.name);
      const file = join(folder, `${name}.amxd`);
      const temporary = join(folder, `.${randomUUID()}.amxd`);
      const patcher = spec.type === "midi_effect" ? midiDevicePatcher({ ...spec, name }) : spec.type === "audio_effect" ? audioEffectPatcher({ ...spec, name }) : instrumentPatcher({ ...spec, name });
      try { await writeFile(temporary, encodeAmxd(spec.type, patcher), { mode: 0o644 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      // Live's Browser lists a device by its name, without the extension.
      const itemId = `user_library/Kumi/${name}`;
      const deadline = Date.now() + (options.waitMs ?? 20_000);
      let seen = false;
      while (!seen && Date.now() < deadline) {
        seen = await options.browserSees(itemId, signal).catch(() => false);
        if (!seen) await new Promise((resolve) => setTimeout(resolve, 400));
        signal.throwIfAborted();
      }
      const kumiControls = spec.type === "audio_effect" ? [MIX, OUTPUT] : spec.type === "instrument" ? [OUTPUT] : [];
      // The file too, so a later look at it (or a change to it) doesn't start by searching for it.
      return { text: JSON.stringify({ made: name, type: KIND_NAMES[spec.type], itemId, file, controls: [...spec.controls, ...kumiControls].map(describeControl),
        ...(spec.type === "instrument" ? { voices: spec.voices } : {}), checks: tested,
        ...(seen ? {} : { note: "Live's Browser hasn't listed it yet; load it in a moment." }),
        next: NEXT[spec.type] }) };
    },
  };
}
