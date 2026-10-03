/**
 * `npm run kumi -- doctor`: checks what Kumi needs, one line each, and says exactly what to run
 * when something is off. It changes nothing and prints no secrets.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import {
  apiKeyFor, canBuildHands, ffmpegHint, findFfmpeg, findWhisper, listLocalModels, localInstalled, localServers, OPENAI_CODEX, openCredentialStore, openHands, parseLocalModelId, parseModelId, probeLocal, PROVIDER_INFO,
  readLibraryState, since, startHint, terminalApp, voiceReadiness, whisperHint, type LocalServer, type ModelInfo, type ProviderId, type VoiceReadiness,
} from "@kumi/runtime";
import { findBridgeConfig, loadAuthFile, loadLibraryDir, loadProjectsDir, loadSettingsFile, loadToolsDir, readSettings, SUPPORTED_NODE_MAJORS } from "./config.js";
import { OFFER_ORDER } from "./models.js";
import { detectColorDepth } from "./tui/style.js";
import { INSTALLED, KUMI, KUMI_REPAIR } from "@kumi/runtime";
import { extensionAnswers, extensionDataDir, extensionSource, installedExtension, liveExtensionsDir, readExtension, runningExtension } from "./live-extension.js";
import { step } from "./spinner.js";
import { systemLanguage } from "./voice.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface Check {
  status: "ok" | "note" | "fix";
  text: string;
  /** What to run or do, for "note" and "fix". */
  next?: string;
}

/** What Live looks like through the bridge, from a short connection. */
export interface LiveProbe {
  started: boolean;
  connected?: boolean;
  liveVersion?: string;
  set?: string;
  realLive?: boolean;
}

export interface DoctorIo {
  out: Writable;
  env: Env;
  nodeVersion?: string;
  terminal?: { isTTY: boolean; columns?: number; rows?: number };
  /** Start the bridge briefly and ask Live how it is. */
  probeLive?: (bridgeConfig: string) => Promise<LiveProbe>;
  /** `node --version` of the bridge's own Node. */
  nodeVersionOf?: (command: string) => Promise<string | undefined>;
  /** This repository's bridge version, to compare with the installed one. */
  bundledBridgeVersion?: string;
  /** Where ffmpeg and whisper.cpp are, for watching videos; looked up (nothing fetched) when left out. */
  videoPrograms?: () => Promise<{ ffmpeg?: string | undefined; whisper?: string | undefined }>;
  /** Whether Kumi can use Live's own menus here; asked of the helper (nothing built) when left out. */
  hands?: () => Promise<Check | undefined>;
  /** The model servers worth a line (running, installed, or named in settings.json) and their models; each asked when left out. */
  modelServers?: () => Promise<ServerFinding[]>;
  /** What talking to Kumi needs and has; looked up (nothing fetched, nothing asked) when left out. */
  voice?: () => Promise<VoiceReadiness>;
}

/** A model server the doctor looked for: running (with its models, when it listed them), or the producer's but not running. */
export interface ServerFinding { server: LocalServer; running: boolean; models?: ModelInfo[] }

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const major = (version: string) => Number(version.replace(/^v/, "").split(".")[0]);
const newer = (left: string, right: string) => {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
};

function nodeCheck(version: string): Check {
  if (major(version) > Math.max(...SUPPORTED_NODE_MAJORS)) return { status: "ok", text: `Node.js ${version.replace(/^v/, "")} (Kumi is tested on 22 and 24)` };
  return SUPPORTED_NODE_MAJORS.includes(major(version))
    ? { status: "ok", text: `Node.js ${version.replace(/^v/, "")}` }
    : { status: "fix", text: `Node.js ${version.replace(/^v/, "")} isn't supported (Kumi needs 22 or newer)`,
      // An installed Kumi brings its own Node: running the installer again is the whole fix.
      next: INSTALLED ? `Run ${KUMI_REPAIR}, which brings Kumi's own Node back` : `Install Node 24 LTS from https://nodejs.org, then run: ${KUMI_REPAIR}` };
}

async function signInCheck(env: Env, servers: readonly ServerFinding[]): Promise<Check> {
  const store = openCredentialStore(loadAuthFile(env));
  const signedIn = async (provider: ProviderId) => PROVIDER_INFO[provider].signIn === "chatgpt"
    ? (await store.get(OPENAI_CODEX).catch(() => undefined))?.type === "oauth"
    : Boolean(await apiKeyFor(provider, store, env).catch(() => undefined));
  const settings = readSettings(loadSettingsFile(env));
  const model = env.KUMI_MODEL ?? settings.model;
  if (!model) {
    for (const provider of OFFER_ORDER) {
      if (await signedIn(provider)) return { status: "ok", text: `Signed in to ${PROVIDER_INFO[provider].name} · Kumi starts with its first model (/model changes it)` };
    }
    const serving = servers.find((found) => found.running && found.models?.length);
    if (serving) return { status: "ok", text: `Kumi starts with a model in ${serving.server.name}, ${serving.server.where}; no sign-in needed (/model changes it)` };
    return { status: "fix", text: "Not signed in to a provider", next: `${KUMI} login openai-codex (a ChatGPT plan), or login anthropic, openai or opencode with an API key; or open Ollama or LM Studio` };
  }
  const parsed = parseModelId(model);
  const onServer = parsed ? undefined : parseLocalModelId(model, localServers(settings.modelServers, env));
  if (onServer) {
    const { server } = onServer;
    const found = servers.find((item) => item.server.id === server.id);
    if (!found?.running) return { status: "fix", text: `${server.name} isn't running (model ${model})`, next: startHint(server) };
    // A server named in settings.json may serve any name it's given; Ollama and LM Studio list all they have.
    if (found.models && server.kind !== "openai-compatible" && !found.models.some((item) => item.model === onServer.model)) {
      return { status: "fix", text: `${server.name} doesn't have ${onServer.model} (model ${model})`, next: server.kind === "ollama" ? `Run: ollama pull ${onServer.model}` : "Download it in LM Studio, or choose another model with /model in Kumi" };
    }
    return { status: "ok", text: `${server.name} ${server.where} · model ${model}` };
  }
  if (!parsed) return { status: "fix", text: `The model "${model.slice(0, 80)}" isn't one Kumi knows`, next: "Choose one with /model in Kumi" };
  const info = PROVIDER_INFO[parsed.provider];
  if (!(await signedIn(parsed.provider))) return { status: "fix", text: `Not signed in to ${info.name} (model ${model})`, next: `${KUMI} login ${parsed.provider}` };
  if (info.signIn === "chatgpt") return { status: "ok", text: `Signed in to ChatGPT · model ${model}` };
  const key = await apiKeyFor(parsed.provider, store, env).catch(() => undefined);
  return { status: "ok", text: `${parsed.provider} API key ${key?.source === "env" ? `from ${info.keyEnv}` : "saved in Kumi"} · model ${model}` };
}

export interface BridgeServer { command?: string; entry?: string; version?: string }
/** The installed bridge's server: its Node, its entry, and the package's version. */
export function readBridgeServer(configPath: string): BridgeServer {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { server?: { command?: unknown; args?: unknown } };
  const command = typeof config.server?.command === "string" ? config.server.command : undefined;
  const entry = Array.isArray(config.server?.args) && typeof config.server.args[0] === "string" ? config.server.args[0] : undefined;
  let version: string | undefined;
  // The entry is <package>/dist/src/cli.js; the package's own version sits two folders up.
  try { if (entry) version = (JSON.parse(readFileSync(join(dirname(entry), "..", "..", "package.json"), "utf8")) as { version?: string }).version; } catch { version = undefined; }
  return { ...(command ? { command } : {}), ...(entry ? { entry } : {}), ...(version ? { version } : {}) };
}

/**
 * Kumi's Live extension: in Live's Extensions folder, the same as the bridge's copy, running (in Live,
 * or started by the bridge while Live's Developer Mode is on), and answering. Nothing where there's no
 * Live, or when the installed bridge carries no extension (the bridge's own line says to update it).
 */
async function extensionCheck(env: Env, configPath: string, server: BridgeServer, live: LiveProbe): Promise<Check | undefined> {
  const folder = liveExtensionsDir(env);
  if (!folder) return undefined;
  const [major = 0, minor = 0] = (live.liveVersion ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (live.liveVersion && (major < 12 || (major === 12 && minor < 4))) return { status: "note", text: `Live ${live.liveVersion} runs no extensions (12.4 and later do), so Kumi can't render tracks without playing them` };
  const source = server.entry ? extensionSource(dirname(dirname(dirname(server.entry)))) : undefined;
  const carried = source ? readExtension(source) : undefined;
  const installed = installedExtension(folder);
  const again = `Run: ${KUMI} bridge, then restart Live`;
  if (!installed) return carried ? { status: "fix", text: "Kumi's extension isn't in Live (it renders tracks without playing them and writes MIDI clips in the Arrangement)", next: again } : undefined;
  if (carried && carried.digest !== installed.digest) return { status: "fix", text: "Kumi's extension in Live is from another bridge", next: again };
  const inLive = extensionDataDir(folder);
  const running = runningExtension(inLive) ?? runningExtension(join(dirname(configPath), "live-extension"));
  if (running) {
    if (!(await extensionAnswers(running.port))) return { status: "fix", text: "Kumi's extension is running but doesn't answer", next: "Restart Live" };
    return { status: "ok", text: running.folder === inLive ? "Kumi's extension is running in Live" : "Kumi's extension is running (Kumi started it: Live's Developer Mode is on)" };
  }
  if (live.connected) return { status: "note", text: "Live hasn't started Kumi's extension", next: "Restart Live: it starts extensions when it opens. With Developer Mode on (Settings → Extensions), Kumi starts it itself while Kumi runs" };
  return { status: "ok", text: `Kumi's extension ${installed.version} is in Live; it starts with Live` };
}

/** Whether Kumi can use Live's own menus here: the helper, and (on a Mac) Accessibility for the terminal Kumi runs in. */
async function handsCheck(): Promise<Check | undefined> {
  if (process.platform === "win32") return { status: "ok", text: "Uses Live's own menus for what Live's scripting can't do (grouping, freezing, bouncing, saving)" };
  if (process.platform !== "darwin") return undefined;
  const hands = await openHands({ build: false, timeoutMs: 3_000 }).catch(() => undefined);
  if (!hands) return canBuildHands() ? { status: "ok", text: "Uses Live's own menus (Kumi builds its helper the first time it needs it)" }
    : { status: "note", text: "Kumi can't use Live's own menus here yet (grouping, freezing, bouncing, saving)", next: "Install Xcode's command line tools (xcode-select --install), or update Kumi" };
  try {
    return await hands.trusted() ? { status: "ok", text: "Uses Live's own menus (Accessibility is on for this terminal)" }
      : { status: "fix", text: "Kumi can't use Live's own menus until Accessibility is on for this terminal", next: "System Settings › Privacy & Security › Accessibility: turn on the app Kumi runs in" };
  } catch { return undefined; } finally { hands.close(); }
}

/** What Kumi knows of the producer's library, and whether it's still learning it. */
async function libraryCheck(env: Env, now = Date.now()): Promise<Check | undefined> {
  let dir: string;
  try { dir = loadLibraryDir(env); } catch { return undefined; }
  const state = await readLibraryState(dir).catch(() => undefined);
  const counted = (sounds: number, presets: number, sets: number) => `${sounds.toLocaleString("en-US")} sounds, ${presets.toLocaleString("en-US")} presets, ${sets.toLocaleString("en-US")} Sets`;
  if (state?.learning) {
    const { learning } = state;
    return { status: "ok", text: `Learning your library in the background${learning.phase === "sounds" && learning.sounds.todo ? `: ${learning.sounds.done.toLocaleString("en-US")} of ${learning.sounds.todo.toLocaleString("en-US")} new sounds` : ""}${state.last ? ` (knows ${counted(state.last.sounds, state.last.presets, state.last.sets)})` : ""}` };
  }
  if (state?.last) return { status: "ok", text: `Knows your library: ${counted(state.last.sounds, state.last.presets, state.last.sets)} (learned ${since(state.last.finishedAt, now)})` };
  return { status: "note", text: "Kumi hasn't learned your library yet", next: `It learns by itself while Kumi runs; ${KUMI} library shows where it's at` };
}

/** The model servers worth a line, each asked whether it's running and what it has. */
async function findServers(env: Env): Promise<ServerFinding[]> {
  const servers = localServers(readSettings(loadSettingsFile(env)).modelServers, env);
  const found = await Promise.all(servers.map(async (server): Promise<ServerFinding | undefined> => {
    const running = await probeLocal(server);
    const theirs = server.kind === "openai-compatible" || (server.kind === "ollama" && Boolean(env.OLLAMA_HOST)) || localInstalled(server.kind, env);
    if (!running) return theirs ? { server, running } : undefined;
    const models = await listLocalModels(server).catch(() => undefined);
    return { server, running, ...(models ? { models } : {}) };
  }));
  return found.filter((item): item is ServerFinding => Boolean(item));
}

/**
 * Which model servers are running, with what (and which can change the Set); one that's the
 * producer's but closed, with how to start it (unless the model check already said so).
 */
function serverChecks(servers: readonly ServerFinding[], env: Env, said?: string): Check[] {
  const checks: Check[] = [];
  const running = servers.filter((found) => found.running);
  if (running.length) {
    const named = running.map(({ server, models }) => {
      const able = models?.filter((model) => model.tools !== false).length;
      const what = !models ? "its models unread" : `${models.length} ${models.length === 1 ? "model" : "models"}${able !== models.length ? `, ${able} can change the Set` : ""}`;
      return `${server.name} ${server.where} (${what})`;
    });
    checks.push({ status: "ok", text: `Model servers: ${named.join("; ")}` });
  }
  for (const { server, running: up } of servers) {
    if (up || server.id === said) continue;
    const text = server.kind === "openai-compatible" ? `${server.name}, from settings.json, isn't answering at ${server.baseURL}`
      : server.kind === "ollama" && env.OLLAMA_HOST ? `Ollama isn't answering at ${server.baseURL} (OLLAMA_HOST)` : `${server.name} is installed but not running`;
    checks.push({ status: "note", text, next: startHint(server) });
  }
  return checks;
}

/**
 * Talking to Kumi (ctrl+t): what's missing, or that it's ready. Never a fix: Kumi works without it, and
 * off a Mac it fetches what it needs the first time the producer talks.
 */
export function voiceCheck(voice: VoiceReadiness, env: Env, platform: string = process.platform): Check {
  if (!voice.fetches && (!voice.ffmpeg || !voice.whisper)) {
    const both = !voice.ffmpeg && !voice.whisper;
    const install = platform === "darwin" ? `brew install ${[!voice.ffmpeg ? "ffmpeg" : "", !voice.whisper ? "whisper-cpp" : ""].filter(Boolean).join(" ")}`
      : [!voice.ffmpeg ? ffmpegHint() : "", !voice.whisper ? whisperHint() : ""].filter(Boolean).join("; ");
    return { status: "note", text: `Talking to Kumi (ctrl+t) needs ${both ? "ffmpeg and whisper.cpp" : !voice.ffmpeg ? "ffmpeg" : "whisper.cpp"}`, next: `Install ${both ? "them" : "it"}: ${install}` };
  }
  if (voice.allowed === false) return { status: "note", text: `Talking to Kumi (ctrl+t): macOS isn't letting ${terminalApp(env)} use the microphone`, next: "Allow it in System Settings › Privacy & Security › Microphone" };
  const later = [!voice.ffmpeg ? "ffmpeg" : "", !voice.whisper ? "whisper.cpp" : "", !voice.model.path ? "its speech model (about 190 MB)" : ""].filter(Boolean);
  if (later.length) return { status: "ok", text: `Talking to Kumi (ctrl+t): Kumi fetches ${later.join(" and ").replace(/ and (?=.* and )/, ", ")} the first time you talk` };
  return { status: "ok", text: "Talking to Kumi (ctrl+t): ffmpeg hears the microphone, whisper.cpp writes down what you say, on this computer" };
}

export async function doctorChecks(io: DoctorIo): Promise<Check[]> {
  const { env } = io;
  const node = nodeCheck(io.nodeVersion ?? process.version);
  const servers = await (io.modelServers ?? (() => findServers(env)))().catch((): ServerFinding[] => []);
  const signIn = await signInCheck(env, servers);
  // The model's server, when the model check is about it already.
  const said = servers.find(({ server }) => signIn.text.startsWith(`${server.name} isn't running`))?.server.id;
  const checks: Check[] = [node, signIn, ...serverChecks(servers, env, said)];
  const configPath = findBridgeConfig(env);
  if (!configPath) {
    checks.push({ status: "fix", text: "The Ableton bridge isn't installed, so Kumi can't see Live", next: `Quit Live, then run: ${KUMI} bridge` });
  } else {
    let server: BridgeServer = {};
    try { server = readBridgeServer(configPath); } catch { /* reported below */ }
    const version = server.version ? ` ${server.version}` : "";
    checks.push({ status: "ok", text: `Ableton bridge${version} (${tilde(configPath)})` });
    if (server.version && io.bundledBridgeVersion && newer(io.bundledBridgeVersion, server.version)) {
      checks.push({ status: "fix", text: `The installed bridge (${server.version}) is older than this Kumi's (${io.bundledBridgeVersion})`, next: `Quit Live, then run: ${KUMI} bridge` });
    }
    // Kumi starts this repository's bridge with its own Node; the configuration's command is how
    // other MCP apps start it, so problems there are notes. Only an install or an upgrade to a
    // newer bridge rewrites it (repair and activation keep it), hence "the next upgrade".
    const later = INSTALLED ? `Kumi isn't affected. The next ${KUMI} bridge records Kumi's own Node` : `Kumi isn't affected. Install Node 24 LTS (nodejs.org); the next ${KUMI} bridge records it`;
    if (!server.command) checks.push({ status: "note", text: "The bridge configuration names no Node for other MCP apps", next: later });
    else {
      let runnable = true;
      try { statSync(server.command); accessSync(server.command, constants.X_OK); } catch { runnable = false; }
      if (!runnable) checks.push({ status: "note", text: `Other MCP apps would start the bridge with a Node that's missing (${tilde(server.command)})`, next: later });
      else {
        const bridgeNode = await (io.nodeVersionOf ?? nodeVersion)(server.command);
        if (bridgeNode && !SUPPORTED_NODE_MAJORS.includes(major(bridgeNode))) {
          checks.push({ status: "note", text: `Other MCP apps would start the bridge with Node.js ${bridgeNode.replace(/^v/, "")}, which it doesn't support`, next: later });
        }
        if (/[\\/](_npx|\.npm[\\/]_npx|tmp|Temp)[\\/]/i.test(server.command)) {
          checks.push({ status: "note", text: "Other MCP apps would start the bridge with a Node from a temporary folder, which can disappear", next: later });
        }
      }
    }
    const live: LiveProbe = await (io.probeLive ?? (async () => ({ started: false })))(configPath).catch(() => ({ started: false }));
    if (!live.started) {
      // Kumi's bridge stops at its handshake when Live's Remote Script doesn't answer: an older one
      // (said above), or Live not open, not using it, or held by a dialog.
      const current = Boolean(server.version && io.bundledBridgeVersion && !newer(io.bundledBridgeVersion, server.version));
      checks.push(node.status === "fix" ? { status: "note", text: "The bridge didn't start; it needs Node 22 or 24 too" }
        : current ? { status: "fix", text: "Kumi's bridge couldn't reach Live", next: `Open Live and choose AbletonMcpBridge as a Control Surface (Settings → Link, Tempo & MIDI); if Live is showing a dialog, answer it first. Then: ${KUMI} doctor` }
        : { status: "fix", text: "The bridge didn't start", next: `${INSTALLED ? `Run ${KUMI_REPAIR} to repair Kumi` : `Build it (${KUMI_REPAIR})`}, and bring Live's part up to date: quit Live, then run ${KUMI} bridge. Then: ${KUMI} doctor` });
    }
    else if (!live.connected) checks.push({ status: "fix", text: "Live isn't connected", next: "Open Live and choose AbletonMcpBridge as a Control Surface (Settings → Link, Tempo & MIDI)" });
    else {
      const where = [live.liveVersion ? `Live ${live.liveVersion}` : "Live", "connected", live.set ? `· ${live.set}` : ""].filter(Boolean).join(" ");
      checks.push(live.realLive === false ? { status: "note", text: `${where} (a simulator, not real Live)` } : { status: "ok", text: where });
    }
    const extension = live.realLive === false ? undefined : await extensionCheck(env, configPath, server, live);
    if (extension) checks.push(extension);
  }
  try {
    const projects = loadProjectsDir(env);
    let writable = true;
    try { accessSync(projects, constants.W_OK); } catch { try { accessSync(dirname(projects), constants.W_OK); } catch { writable = false; } }
    checks.push(writable ? { status: "ok", text: `Remembers Sets in ${tilde(projects)}` } : { status: "note", text: `Can't write ${tilde(projects)}, so Kumi won't catch you up on Sets`, next: "Check that folder's permissions, or set KUMI_PROJECTS_DIR" });
  } catch { /* an invalid KUMI_PROJECTS_DIR is reported when Kumi starts */ }
  const library = await libraryCheck(env);
  if (library) checks.push(library);
  // Watching videos: yt-dlp comes by itself when first needed; ffmpeg and whisper.cpp are the producer's.
  const programs = await (io.videoPrograms ?? (async () => ({ ffmpeg: await findFfmpeg({ env, toolsDir: loadToolsDir(env), installedOnly: true }), whisper: await findWhisper({ env, toolsDir: loadToolsDir(env), installedOnly: true }) })))().catch(() => ({ ffmpeg: undefined, whisper: undefined }));
  if (!programs.ffmpeg) checks.push({ status: "note", text: "Kumi reads a video's words but can't see its frames without ffmpeg", next: `Install it: ${ffmpegHint()}` });
  else if (!programs.whisper) checks.push({ status: "note", text: "Watches videos; one without captions needs whisper.cpp for its words", next: `Install it: ${whisperHint()}` });
  else checks.push({ status: "ok", text: "Watches videos: frames with ffmpeg, speech with whisper.cpp" });
  // Live's own menus (grouping, freezing, bouncing, saving…): the helper, and on a Mac, Accessibility for this terminal.
  const hands = await (io.hands ?? handsCheck)();
  if (hands) checks.push(hands);
  const voice = await (io.voice ?? (() => voiceReadiness({ env, toolsDir: loadToolsDir(env), language: readSettings(loadSettingsFile(env)).voice?.language ?? systemLanguage(env) })))().catch(() => undefined);
  if (voice) checks.push(voiceCheck(voice, env));
  const terminal = io.terminal ?? { isTTY: Boolean(process.stdout.isTTY), ...(process.stdout.columns ? { columns: process.stdout.columns } : {}), ...(process.stdout.rows ? { rows: process.stdout.rows } : {}) };
  if (!terminal.isTTY) checks.push({ status: "note", text: "Not a terminal window here, so Kumi uses plain lines" });
  else {
    const depth = detectColorDepth(env);
    const colour = depth === "truecolor" ? "24-bit colour" : depth === "256" ? "256 colours" : depth === "16" ? "16 colours" : "no colour";
    const size = `${terminal.columns ?? 80}×${terminal.rows ?? 24}`;
    const small = (terminal.columns ?? 80) < 60 || (terminal.rows ?? 24) < 16;
    checks.push(small ? { status: "note", text: `Terminal ${size} is small for Kumi's full screen`, next: "Make the window bigger" } : { status: "ok", text: `Terminal ${size}, ${colour}${env.KUMI_UI === "plain" ? ", plain lines (KUMI_UI=plain)" : ""}` });
  }
  return checks;
}

function nodeVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 5_000, env: { PATH: dirname(command) } }, (error, stdout) => resolve(error ? undefined : String(stdout).trim().slice(0, 32) || undefined));
  });
}

export async function runDoctor(io: DoctorIo): Promise<number> {
  // Starting the bridge and asking Live can take half a minute: a spinner until the checks are in.
  const checks = await step(io.out, io.env, "Checking…", () => doctorChecks(io), { keep: false });
  io.out.write(formatDoctor(checks));
  return checks.some((check) => check.status === "fix") ? 1 : 0;
}

/** The doctor's lines, as it prints them. */
export function formatDoctor(checks: readonly Check[]): string {
  const lines = ["Kumi doctor", ""];
  for (const check of checks) {
    lines.push(`  ${check.status.padEnd(5)} ${check.text}`);
    if (check.next) lines.push(`        → ${check.next}`);
  }
  const fixes = checks.filter((check) => check.status === "fix").length;
  lines.push("", fixes ? `${fixes} ${fixes === 1 ? "thing" : "things"} to fix (see →).` : "Everything Kumi needs is in place.");
  return `${lines.join("\n")}\n`;
}
