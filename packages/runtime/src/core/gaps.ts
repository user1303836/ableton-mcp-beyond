/**
 * Gaps: what a producer asked for that Kumi couldn't do because a tool or Live's API lacks it
 * ("Operator's Voices isn't exposed", "a recording can't be loaded into Sampler"), logged on this
 * computer for Kumi's developers, to show which missing tools producers keep running into. Not a
 * memory: the model never reads it back, and the producer's notes don't hold it.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KernelTool } from "./contracts.js";
import { suspectNote } from "./memory.js";
import { KUMI_VERSION } from "../version.js";

export const GAP_TOOL = "note_gap";
/** When the model notes a gap, for the instructions whenever the tool is offered. */
export const GAP_GUIDANCE = "When a request needs something Kumi's tools or Live's scripting don't offer, take the way round first (another tool, a plan of several, a recording, a device you make) and do it; then note the gap with note_gap, in the same reply as your last plan, and say in a sentence what you did instead.";
/** The log's size before it's cut to its latest entries. */
const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 500;

const DESCRIPTION = [
  "When the producer asks for something you can't do because Kumi's tools or Live's API lack it (a device setting scripts can't reach, an operation no tool offers), note it here for Kumi's developers, then tell the producer and offer the way round.",
  "Not for things you chose not to do, or that failed for another reason. The producer doesn't see this, and it isn't a memory.",
].join(" ");

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The note_gap tool, logging to `file` (JSON lines, readable only by this user). Quiet: no model reply follows. */
export function gapTools(options: { file: string }): KernelTool[] {
  return [{
    name: GAP_TOOL, description: DESCRIPTION,
    inputSchema: { type: "object", additionalProperties: false, required: ["missing"], properties: {
      missing: { type: "string", minLength: 1, maxLength: 300, description: "What's missing, as a capability (\"setting Operator's voice count\")" },
      asked: { type: "string", maxLength: 300, description: "What the producer asked for that needed it" },
      workaround: { type: "string", maxLength: 300, description: "What you did or suggested instead" } } },
    async execute(input) {
      const missing = clean(input.missing, 300);
      if (!missing) return { text: "Say what's missing.", isError: true };
      const entry = { at: new Date().toISOString(), kumi: KUMI_VERSION, missing, ...(clean(input.asked, 300) ? { asked: clean(input.asked, 300) } : {}), ...(clean(input.workaround, 300) ? { workaround: clean(input.workaround, 300) } : {}) };
      // A secret has no place in a log meant for someone else.
      if (Object.values(entry).some((value) => suspectNote(String(value)))) return { text: "That holds something that reads as a secret, so it wasn't logged.", isError: true };
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      await appendFile(options.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      // Bounded: past its size, the latest entries stay.
      try {
        if ((await stat(options.file)).size > MAX_BYTES) {
          const lines = (await readFile(options.file, "utf8")).split("\n").filter(Boolean);
          await writeFile(options.file, `${lines.slice(-KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
        }
      } catch { /* the entry is logged either way */ }
      return { text: JSON.stringify({ noted: missing }), reply: "" };
    },
  }];
}
