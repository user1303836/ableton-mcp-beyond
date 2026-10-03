/**
 * `npm run kumi -- report`: one file to send when something goes wrong. It holds Kumi's and the
 * bridge's versions, the doctor's checks, what Kumi did in the last conversation (its tool calls
 * and what they answered), what it couldn't do (the gap log) and the bridge's lines from Live's
 * own log. Keys and tokens are taken out, the home folder reads as ~ and the account name as
 * <user>. It changes nothing else.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, release, userInfo } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { KUMI_VERSION, openCredentialStore } from "@kumi/runtime";
import { loadAuthFile, loadGapsFile, loadProjectsDir, loadSettingsFile } from "./config.js";
import { doctorChecks, formatDoctor, type DoctorIo } from "./doctor.js";
import { step } from "./spinner.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface ReportIo extends DoctorIo {
  /** Where the report goes; the home folder by default. */
  folder?: string;
  home?: string;
  user?: string;
  now?: () => Date;
  /** Live's log files to look in; found in Live's usual places when left out. */
  liveLogs?: () => Promise<string[]>;
}

/** Text with secrets taken out, the home folder as ~ and the account name as <user>. */
export function redactor(secrets: readonly string[], home: string, user: string): (text: string) => string {
  const known = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort((a, b) => b.length - a.length);
  const homes = [...new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])].filter((path) => path.length > 1);
  const name = user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi") : undefined;
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join("[secret]");
    for (const path of homes) out = out.split(path).join("~");
    out = out
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [secret]")
      .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[secret]")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[secret]")
      .replace(/("?(?:api[_-]?key|token|secret|password|access|refresh)"?\s*[:=]\s*)"[^"]{8,}"/gi, "$1\"[secret]\"")
      // A token's long run of letters and digits; a path's slashes end a run, so folders stay readable.
      .replace(/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{48,}={0,2}(?![A-Za-z0-9+_-])/g, "[long value]");
    return name ? out.replace(name, "<user>") : out;
  };
}

/** Every string in a value: a credential's tokens and keys, to take out of the report. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}… (${text.length - most} more characters)` : text);

/** The most recently saved conversation Kumi kept, and which Set's folder it's in. */
async function lastConversation(projects: string): Promise<{ file: string; savedAt: number; value: Record<string, unknown> } | undefined> {
  let best: { file: string; at: number } | undefined;
  for (const place of await readdir(projects).catch(() => [] as string[])) {
    const folder = join(projects, place, "conversations");
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const at = (await stat(join(folder, name)).catch(() => undefined))?.mtimeMs;
      if (at !== undefined && (!best || at > best.at)) best = { file: join(folder, name), at };
    }
  }
  if (!best) return undefined;
  try { return { file: best.file, savedAt: best.at, value: JSON.parse(await readFile(best.file, "utf8")) as Record<string, unknown> }; } catch { return undefined; }
}

/** The conversation as what was asked and what Kumi did: each request, tool call and answer, bounded. */
function describeConversation(value: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const checkpoint = value.checkpoint as { messages?: unknown } | undefined;
  const messages = Array.isArray(checkpoint?.messages) ? checkpoint.messages as { role?: unknown; content?: unknown }[] : [];
  for (const message of messages.slice(-200)) {
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) lines.push(`${message.role === "user" ? "producer" : String(message.role)}: ${clip(part.text.trim().replace(/\s+/g, " "), 400)}`);
      if (part.type === "tool-call") lines.push(`  → ${String(part.toolName)} ${clip(JSON.stringify(part.input ?? part.args ?? {}), 800)}`);
      if (part.type === "tool-result") lines.push(`  ← ${clip(JSON.stringify(part.output ?? part.result ?? {}), 600)}`);
    }
  }
  const changes = Array.isArray(value.changes) ? value.changes as { title?: unknown; state?: unknown; note?: unknown }[] : [];
  if (changes.length) {
    lines.push("", "HISTORY:");
    for (const change of changes.slice(-100)) lines.push(`  ${String(change.state)} · ${String(change.title)}${typeof change.note === "string" ? ` (${change.note})` : ""}`);
  }
  return lines;
}

/** Live's log files, newest first: in Preferences on macOS, in AppData on Windows. */
async function findLiveLogs(env: Env, home: string): Promise<string[]> {
  const roots = process.platform === "win32" ? [join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Ableton")] : [join(home, "Library", "Preferences", "Ableton")];
  const found: { file: string; at: number }[] = [];
  for (const root of roots) {
    for (const version of await readdir(root).catch(() => [] as string[])) {
      for (const file of [join(root, version, "Log.txt"), join(root, version, "Preferences", "Log.txt")]) {
        const at = (await stat(file).catch(() => undefined))?.mtimeMs;
        if (at !== undefined) found.push({ file, at });
      }
    }
  }
  return found.sort((a, b) => b.at - a.at).map((item) => item.file);
}

/** The bridge's lines from Live's log, and Python errors with the lines after them: the last ones only. */
async function liveLogLines(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text.slice(-4 * 1024 * 1024).split(/\r?\n/);
  const picked: string[] = [];
  let trailing = 0;
  for (const line of lines) {
    if (/AbletonMcp|Traceback|RemoteScriptError|Python:.*\b\w*(Error|Exception)\b/.test(line)) { picked.push(line); trailing = /Traceback/.test(line) ? 12 : 0; }
    // A traceback goes on in indented lines and Python's own; another kind of line ends it.
    else if (trailing > 0 && /^\s|Python:|^\w*(Error|Exception)\b/.test(line)) { picked.push(line); trailing--; }
    else trailing = 0;
  }
  return picked.slice(-150).map((line) => clip(line, 400));
}

/** Write the report and say where it is. */
export async function writeReport(io: ReportIo): Promise<number> {
  const env = io.env;
  const home = io.home ?? homedir();
  const user = io.user ?? (() => { try { return userInfo().username; } catch { return ""; } })();
  const now = io.now?.() ?? new Date();
  let credentials: unknown = {};
  try { credentials = await openCredentialStore(loadAuthFile(env)).list(); } catch { /* none to take out */ }
  const secrets = [...strings(credentials), ...["AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY"].map((name) => env[name] ?? "")];
  const redact = redactor(secrets, home, user);
  // The doctor's checks start the bridge and ask Live, which can take half a minute: a spinner meanwhile.
  const file = await step(io.out, env, "Writing Kumi's report…", () => compose(io, redact, home, now), { keep: false });
  io.out.write(`Kumi's report is in ${redact(file)}\nIt has Kumi's versions, the doctor's checks, what Kumi did in your last conversation, and the bridge's lines from Live's log. Keys and tokens are taken out. Send it with a few words about what happened.\n`);
  return 0;
}

/** The report, written; where it is. */
async function compose(io: ReportIo, redact: (text: string) => string, home: string, now: Date): Promise<string> {
  const env = io.env;
  const sections: string[] = [];
  const section = (title: string, body: string[] | string) => sections.push(`## ${title}\n\n${Array.isArray(body) ? body.join("\n") : body}`);
  const terminal = [env.TERM_PROGRAM && `${env.TERM_PROGRAM} ${env.TERM_PROGRAM_VERSION ?? ""}`.trim(), env.WT_SESSION ? "Windows Terminal" : "", env.TERM ? `TERM=${env.TERM}` : "", env.COLORTERM ? `COLORTERM=${env.COLORTERM}` : ""].filter(Boolean).join(", ");
  section("Versions", [`Kumi ${KUMI_VERSION}`, `Node.js ${process.version}`, `${process.platform} ${release()} ${process.arch}`, `Terminal: ${terminal || "unknown"}`, `Made ${now.toISOString()}`]);
  section("Doctor", formatDoctor(await doctorChecks(io).catch((error: unknown) => [{ status: "fix" as const, text: `The doctor stopped: ${String((error as Error)?.message ?? error).slice(0, 200)}` }])).trimEnd());
  try {
    const settings = JSON.parse(await readFile(loadSettingsFile(env), "utf8")) as Record<string, unknown>;
    section("Settings", Object.entries(settings).filter(([, value]) => typeof value !== "object").map(([key, value]) => `${key}: ${String(value).slice(0, 120)}`));
  } catch { section("Settings", "none saved"); }
  const conversation = await lastConversation(loadProjectsDir(env)).catch(() => undefined);
  section("Last conversation", conversation ? [`Saved ${new Date(conversation.savedAt).toISOString()}`, "", ...describeConversation(conversation.value)] : "none kept yet");
  const gaps = (await readFile(loadGapsFile(env), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).slice(-50);
  section("What Kumi couldn't do (gap log)", gaps.length ? gaps.map((line) => clip(line, 500)) : "nothing logged");
  const logs = await (io.liveLogs ?? (() => findLiveLogs(env, home)))().catch(() => [] as string[]);
  const log = logs[0];
  section("Live's log (the bridge's lines and errors)", log ? [`From ${log}`, "", ...await liveLogLines(log)] : "Live's log wasn't found");

  const text = redact(`# Kumi report\n\nSend this file with a few words about what happened. Keys and tokens are taken out; your home folder shows as ~.\n\n${sections.join("\n\n")}\n`);
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(io.folder ?? home, `kumi-report-${stamp}.txt`);
  await writeFile(file, text, { mode: 0o600 });
  return file;
}
