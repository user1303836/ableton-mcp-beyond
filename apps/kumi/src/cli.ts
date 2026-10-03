#!/usr/bin/env node
import {
  createAbletonIntegration, createAgentKernel, createConversationStore, createInferenceOnlyIntegration, createLibrary, createMemoryStore, createProjectStore, createRecipeStore, createGoalStore, createPlaybookStore, createSession, createTechniqueStore, configurePrograms, KUMI_VERSION, KumiError, openCredentialStore, withFallback,
  type Kernel, type KernelCheckpoint,
} from "@kumi/runtime";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { liveUserLibrary, loadConfig, loadGapsFile, loadInputHistoryFile, loadGoalsDir, loadLibraryDir, loadMemoryFile, loadRestoreFile, loadPlaybookFile, loadTechniquesFile, loadProjectsDir, loadRecipesDir, loadSettingsFile, loadToolsDir, loadVideosDir, readSettings, safeError, SUPPORTED_NODE_MAJORS, writeSettings } from "./config.js";
import { openInputHistory } from "./history.js";
import { setupBridge } from "./bridge-setup.js";
import { readBridgeServer, runDoctor, type LiveProbe } from "./doctor.js";
import { writeReport } from "./report.js";
import { runLibrary } from "./library.js";
import { checkCheckout, newerKumi, olderBridge, runUpdate, type UpdateControl } from "./update.js";
import { checkRelease, newerRelease, rollbackInstalled, uninstallInstalled, updateInstalled } from "./install.js";
import { authStatus, login, logout, openBrowser } from "./login.js";
import { createModelControl } from "./models.js";
import { step } from "./spinner.js";
import { createTerminal, type Terminal } from "./terminal.js";
import { createTui } from "./tui/app.js";
import { createVoiceControl } from "./voice.js";
import { INSTALLED, KUMI, KUMI_START } from "@kumi/runtime";

/** One row of help: the command (as this Kumi is run) and what it does, lined up in two columns. */
const helpRows = (rows: readonly (readonly [string, string])[]) => {
  const width = Math.max(...rows.map(([command]) => command.length)) + 3;
  return rows.map(([command, about]) => `  ${command.padEnd(width)}${about.replaceAll("\n", `\n  ${" ".repeat(width)}`)}`).join("\n");
};
const sub = (rest: string) => `${KUMI} ${rest}`;
const HELP = `Kumi ${KUMI_VERSION} — producer assistant for Ableton Live

First run:
${helpRows([
  ...(INSTALLED ? [] : [["npm run setup", "Install and build Kumi and the Ableton bridge (Node.js 22 or 24)"] as const]),
  [sub("bridge"), "With Live closed: put the bridge into Live, or bring it up to date"],
  [KUMI_START, "Talk about the open Live Set; the installed bridge is found automatically.\nSign in there with /login, and choose a model with /model."],
])}

More:
${helpRows([
  [sub("--inference-only"), "Chat without Live"],
  [sub("--bridge-config <path>"), "Use this bridge configuration (an absolute path)"],
  [sub("login"), "Sign in: asks whether with ChatGPT or an API key"],
  [sub("login <provider>"), "Sign in to one provider: openai-codex with a ChatGPT plan (--device\nwithout a browser); anthropic, openai, opencode with an API key (asked for)"],
  [sub("logout <provider>"), "Remove Kumi's sign-in for that provider"],
  [sub("model [<provider>/<model>]"), "Show or choose the model; ollama/<model> or lmstudio/<model> for one on this computer"],
  [sub("auth"), "Show which providers are usable (no secrets)"],
  [sub("doctor"), "Check sign-in, the bridge, Live and the terminal"],
  [sub("library"), "What Kumi knows of your sounds, presets and Sets (it learns them in the\nbackground); --rebuild learns them all again"],
  [sub("update"), "Bring Kumi up to date, and the bridge in Live when it's older"],
  [sub("update --check"), "Say whether there's a newer Kumi, without installing it"],
  ...(INSTALLED ? [[sub("update --rollback"), "Go back to the Kumi you had before the last update"] as const, [sub("uninstall"), "Remove Kumi (your conversations and notes stay unless you say)"] as const] : []),
  [sub("report"), "Write a file to send when something goes wrong (no keys in it)"],
  [sub("--version"), "Show Kumi's version"],
])}

Providers: openai-codex (ChatGPT), anthropic, openai, opencode and opencode-go (OpenCode Zen and Go share
a key). An API key in ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENCODE_API_KEY is used when set.
Models on this computer need no sign-in: Ollama and LM Studio are found while they run, and other
OpenAI-compatible servers (llama.cpp, vLLM, Jan) can be named in ~/.kumi/settings.json as modelServers.
KUMI_MODEL overrides the chosen model.
Kumi reads the open Live Set and makes the changes you ask for; each change can be undone. It plays, records
and bounces when you ask, listens to audio (a reference, a sample, a recording) and compares it, keeps short notes
of what you tell it that Live can't show, and saves your ways of working as recipes to replay, including ones it
learns by watching you.
In a session: /help /status /model /effort /login /logout /memory /recipes /conversations /voice /undo /refresh /reconnect /new /update /quit. Ctrl-C cancels work, or exits if idle.
Ctrl-T talks instead of typing: what you say is written down on this computer (whisper.cpp) and lands in the input box.
KUMI_TRACE=1 prints MCP dispatch names only.
`;
const BRIDGE_MISSING = `The Ableton bridge isn't installed yet, so Kumi can't see Live; chatting without it. To connect Live, quit Live and run: ${KUMI} bridge`;
const secrets = [process.env.AI_GATEWAY_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENCODE_API_KEY, process.env.LM_API_TOKEN]
  .filter((value): value is string => Boolean(value));
// The keys of model servers named in settings.json are kept out of what Kumi shows, as any key is.
try { for (const server of readSettings(loadSettingsFile()).modelServers ?? []) if (server.apiKey) secrets.push(server.apiKey); } catch { /* an invalid settings path is reported below */ }

/**
 * A kernel for when the model can't be reached yet (none chosen, not signed in): Kumi still starts
 * and reads Live, and each answer says what's missing, so the app can offer the fix. It keeps the
 * conversation it was given for the kernel that replaces it.
 */
function unavailableKernel(error: KumiError, checkpoint: KernelCheckpoint | undefined): Kernel {
  return { async run() { throw error; }, async close() {}, ...(checkpoint ? { checkpoint: () => checkpoint } : {}) };
}

/** Start the bridge the way Kumi does, ask Live how it is, and stop again. */
async function probeLive(bridgeConfig: string): Promise<LiveProbe> {
  const integration = createAbletonIntegration({ bridgeConfig, onConnection: () => {} });
  try { await integration.start(AbortSignal.timeout(20_000)); }
  catch { await integration.close().catch(() => {}); return { started: false }; }
  try {
    const observation = await integration.observe(AbortSignal.timeout(20_000));
    const context = JSON.parse(observation.context) as { mode?: string; liveVersion?: unknown; provenance?: unknown; set?: { name?: unknown } };
    if (context.mode === "inference-only" || !observation.tools.length) return { started: true, connected: false };
    return { started: true, connected: true, ...(typeof context.liveVersion === "string" ? { liveVersion: context.liveVersion } : {}),
      ...(typeof context.set?.name === "string" ? { set: context.set.name } : {}), realLive: context.provenance === "real-live" };
  } catch { return { started: true, connected: false }; }
  finally { await integration.close().catch(() => {}); }
}
/** `kumi update --check`: whether there's a newer Kumi, without installing it. */
async function updateCheck(): Promise<number> {
  try {
    const latest = await step(process.stdout, process.env, "Looking for a newer Kumi…", () => INSTALLED ? checkRelease(process.env) : checkCheckout(), { keep: false });
    process.stdout.write(latest ? `Kumi ${latest} is out (this is ${KUMI_VERSION}). Update with: ${sub("update")}\n` : `Kumi is up to date (${KUMI_VERSION}).\n`);
    return 0;
  } catch (error) { process.stdout.write(`${safeError(error, secrets)}.\n`); return 1; }
}

/**
 * After /update: Kumi updated the way it was installed, then opened again as it was started, so the
 * Set's conversation continues. Node can't replace its own process, so the new Kumi runs as a child
 * with the terminal, and this one waits and passes its exit on.
 */
async function updateAndReopen(): Promise<number> {
  process.stdout.write("\n");
  const updated = INSTALLED ? await updateInstalled({ out: process.stdout, env: process.env, input: process.stdin }) : await runUpdate({ out: process.stdout, env: process.env });
  if (updated !== 0) { process.stdout.write(`\nKumi wasn't updated; this one still works: ${KUMI_START}\n`); return updated; }
  process.stdout.write("\nOpening Kumi again…\n");
  // Ctrl-C belongs to the new Kumi (it reads keys itself); a stray one mustn't end this process under it.
  process.on("SIGINT", () => {});
  const reopened = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  return reopened.status ?? 1;
}

const bundledBridgeVersion = (() => {
  try { return (JSON.parse(readFileSync(new URL("../../../mcp-server/package.json", import.meta.url), "utf8")) as { version?: string }).version; } catch { return undefined; }
})();

try {
  // The doctor and the report run on any Node, so they can say that along with everything else.
  const doctor = process.argv.length === 3 && (process.argv[2] === "doctor" || process.argv[2] === "report");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!doctor && nodeMajor < Math.min(...SUPPORTED_NODE_MAJORS)) {
    throw new Error(`Kumi needs Node.js 22 or newer (this is ${process.version}); install Node 24 LTS from https://nodejs.org.`);
  }
  // A newer Node than Kumi is tested on runs it anyway.
  if (!doctor && !SUPPORTED_NODE_MAJORS.includes(nodeMajor)) process.stderr.write(`Kumi is tested on Node.js 22 and 24; this is ${process.version}, which should work too.\n`);
  const config = loadConfig(process.argv.slice(2));
  if (config.mode === "doctor") process.exitCode = await runDoctor({ out: process.stdout, env: process.env, probeLive, ...(bundledBridgeVersion ? { bundledBridgeVersion } : {}) });
  else if (config.mode === "update" && config.rollback && !INSTALLED) {
    // A checkout goes back with git; runUpdate would pull and rebuild, the opposite of what was asked.
    process.stdout.write("This Kumi runs from a copy of its repository, so there's no earlier Kumi kept to go back to. Check out the commit you want with git, then run: npm run setup\n");
    process.exitCode = 1;
  }
  else if (config.mode === "update") process.exitCode = config.check ? await updateCheck() : !INSTALLED ? await runUpdate({ out: process.stdout, env: process.env })
    : config.rollback ? await rollbackInstalled({ out: process.stdout, env: process.env, input: process.stdin }) : await updateInstalled({ out: process.stdout, env: process.env, input: process.stdin });
  else if (config.mode === "uninstall") {
    if (INSTALLED) process.exitCode = await uninstallInstalled({ out: process.stdout, env: process.env, input: process.stdin }, config);
    else { process.stdout.write("This Kumi runs from a copy of its repository; delete that folder to remove it (your files are in ~/.kumi).\n"); process.exitCode = 1; }
  }
  else if (config.mode === "library") {
    const cancel = new AbortController(); const interrupt = () => cancel.abort(); process.once("SIGINT", interrupt);
    try { process.exitCode = await runLibrary({ out: process.stdout, env: process.env, rebuild: config.rebuild, signal: cancel.signal }); }
    finally { process.removeListener("SIGINT", interrupt); }
  }
  else if (config.mode === "report") process.exitCode = await writeReport({ out: process.stdout, env: process.env, probeLive, ...(bundledBridgeVersion ? { bundledBridgeVersion } : {}) });
  else if (config.mode === "help") process.stdout.write(HELP);
  else if (config.mode === "version") process.stdout.write(`Kumi ${KUMI_VERSION}\n`);
  else if (config.mode === "bridge") process.exitCode = await setupBridge({ out: process.stdout, env: process.env, input: process.stdin, yes: config.yes, allowDirty: config.allowDirty,
    // How long to wait for Live afterwards; KUMI_BRIDGE_WAIT_SECONDS=0 doesn't (the installer's own tests, where there's no Live).
    ...(/^\d+$/.test(process.env.KUMI_BRIDGE_WAIT_SECONDS ?? "") ? { waitMs: Number(process.env.KUMI_BRIDGE_WAIT_SECONDS) * 1000 } : {}) });
  else if (config.mode === "auth") await authStatus(config, { out: process.stdout, env: process.env });
  else if (config.mode === "logout") await logout(config, { out: process.stdout, env: process.env });
  else if (config.mode === "model") {
    const settings = readSettings(config.settingsFile);
    if (config.model) writeSettings(config.settingsFile, { ...settings, model: config.model });
    const chosen = config.model ?? settings.model;
    process.stdout.write(config.model ? `Model set to ${config.model}.\n` : `Model: ${chosen ?? "not chosen"}. Change it with: ${KUMI} model <provider>/<model>\n`);
    if (process.env.KUMI_MODEL) process.stdout.write(`KUMI_MODEL=${process.env.KUMI_MODEL} currently overrides it.\n`);
  } else if (config.mode === "login-choose") {
    const choices = [["openai-codex", "ChatGPT: sign in with your ChatGPT plan (opens your browser)"], ["anthropic", "Anthropic: paste an API key"], ["openai", "OpenAI: paste an API key"], ["opencode", "OpenCode: paste an API key"]] as const;
    if (!process.stdin.isTTY) throw new Error(`Use: ${KUMI} login <provider>, with provider one of ${choices.map(([id]) => id).join(", ")}.`);
    process.stdout.write(`How do you want to sign in?\n${choices.map(([, about], index) => `  ${index + 1}  ${about}`).join("\n")}\n`);
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await reader.question(`Choose 1–${choices.length}: `)).trim(); reader.close();
    const chosen = choices[Number(answer) - 1];
    if (!chosen) { process.stdout.write("Nothing chosen; nothing changed.\n"); process.exitCode = 1; }
    else {
      const cancel = new AbortController(); const interrupt = () => cancel.abort(); process.once("SIGINT", interrupt);
      try {
        await login({ mode: "login", provider: chosen[0], method: chosen[0] === "openai-codex" ? "browser" : "key", authFile: config.authFile, piAuthFile: config.piAuthFile, settingsFile: config.settingsFile },
          { out: process.stdout, env: process.env, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60_000)]), input: process.stdin, ...(process.stdout.isTTY ? { openBrowser } : {}) });
      } finally { process.removeListener("SIGINT", interrupt); }
    }
  } else if (config.mode === "login") {
    const cancel = new AbortController();
    const interrupt = () => cancel.abort();
    process.once("SIGINT", interrupt);
    try {
      await login(config, { out: process.stdout, env: process.env, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60_000)]), input: process.stdin,
        ...(process.stdout.isTTY ? { openBrowser } : {}) });
    } finally { process.removeListener("SIGINT", interrupt); }
  } else {
    const store = openCredentialStore(config.authFile);
    for (const credential of Object.values(await store.list().catch(() => ({})))) {
      if (credential.type === "oauth") secrets.push(credential.access, credential.refresh); else secrets.push(credential.key);
    }
    let terminal: Terminal | undefined;
    // The producer's sounds, presets and Sets, learned in the background (held while Live plays).
    const library = createLibrary({ dir: loadLibraryDir(), folders: readSettings(loadSettingsFile()).libraryFolders ?? [], projectsDir: loadProjectsDir() });
    // A missing sign-in or model isn't a reason not to start: the app offers /login and /model.
    const models = createModelControl({ store, settingsFile: loadSettingsFile(), env: process.env, changed: async () => { await controller.reconfigure?.(); },
      // What Kumi learns about a model as it's used (it can't change the Set) is said once, as a note.
      say: (message) => terminal?.handleEvent({ type: "notice", message }) });
    const controller = createSession({
      kernelFactory: async (options) => {
        try { return createAgentKernel({ ...options, binding: await models.binding() }); }
        catch (error) { if (error instanceof KumiError) return unavailableKernel(error, options.checkpoint); throw error; }
      },
      integrationFactory: (onConnection) => config.mode === "inference-only" ? createInferenceOnlyIntegration(onConnection)
        : withFallback(createAbletonIntegration({ onConnection, bridgeConfig: config.bridgeConfig,
          onFocus: (focus) => terminal?.handleEvent({ type: "focus", focus }),
          onPointed: (pin) => terminal?.handleEvent({ type: "pointed", pin }),
          onTransport: (transport) => { if (transport?.playing) library.pause(); else library.resume(); terminal?.handleEvent({ type: "transport", transport }); },
          // Kumi's changes are kept with the conversation too, for its HISTORY when it's resumed.
          onChange: (change) => { controller.watch?.({ type: "change", change }); terminal?.handleEvent({ type: "change", change }); },
          onAction: (action) => { controller.watch?.({ type: "action", ...action }); terminal?.handleEvent({ type: "action", ...action }); },
          onWatch: (on) => terminal?.handleEvent({ type: "watching", on }),
          onAudition: (event) => { controller.watch?.(event); terminal?.handleEvent(event); },
          restoreFile: loadRestoreFile(),
          projectStore: createProjectStore(loadProjectsDir()),
          ...(liveUserLibrary() ? { userLibrary: liveUserLibrary()! } : {}),
          onCatchUp: (catchUp) => terminal?.handleEvent({ type: "catch-up", catchUp }),
          ...(process.env.KUMI_TRACE === "1" ? { onDispatch: (name: string) => terminal?.handleEvent({ type: "notice", message: `[MCP dispatch] ${name}` }) } : {}),
        }),
        // A bridge that won't start: chat without Live, and say how to fix it. With Live's part as new as
        // Kumi's, it stopped because Live didn't answer (not open, not using the bridge, or held by a dialog).
        () => createInferenceOnlyIntegration(onConnection), (message) => {
          let installed: string | undefined;
          try { installed = config.mode === "live" ? readBridgeServer(config.bridgeConfig).version : undefined; } catch { installed = undefined; }
          const current = installed !== undefined && installed === bundledBridgeVersion;
          terminal?.handleEvent({ type: "notice", message: current
            ? "Kumi's bridge couldn't reach Live, so this is chat without Live. Open Live and choose AbletonMcpBridge as a Control Surface (Settings → Link, Tempo & MIDI); if Live is showing a dialog, answer it. Then /reconnect."
            : message });
        }),
      onEvent: (event) => terminal?.handleEvent(event),
      ...(config.mode === "live" ? { conversations: createConversationStore(loadProjectsDir()) } : {}),
      memory: createMemoryStore({ projectsDir: loadProjectsDir(), producerFile: loadMemoryFile() }),
      listen: true,
      recipes: createRecipeStore(loadRecipesDir()),
      techniques: createTechniqueStore(loadTechniquesFile()),
      playbook: createPlaybookStore(loadPlaybookFile()),
      goals: createGoalStore(loadGoalsDir()),
      gaps: loadGapsFile(),
      watch: { videosDir: loadVideosDir(), toolsDir: loadToolsDir() },
      web: true,
      library,
    });
    // The full-screen app needs a real terminal; pipes, and KUMI_UI=plain (e.g. for screen readers), get plain lines.
    const fullScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.KUMI_UI !== "plain";
    // Programs Kumi fetches when first needed (ffmpeg, off a Mac) go in its tools folder, and it says so.
    configurePrograms({ toolsDir: loadToolsDir(), onFetch: (message) => terminal?.handleEvent({ type: "notice", message }) });
    const stale = config.mode === "live" ? olderBridge(process.env, bundledBridgeVersion) : undefined;
    // /update: Kumi closes, then updates and opens again (below, once the terminal is done).
    let updateAfter = false;
    const updates: UpdateControl = { current: KUMI_VERSION, check: () => INSTALLED ? checkRelease(process.env) : checkCheckout(), request: () => { updateAfter = true; } };
    terminal = (fullScreen ? createTui : createTerminal)({ controller, input: process.stdin, output: process.stdout, models, mode: config.mode, secrets,
      history: openInputHistory(loadInputHistoryFile(), secrets), openBrowser, updates,
      // Talking instead of typing (ctrl+t): the microphone, written down on this computer.
      voice: createVoiceControl({ toolsDir: loadToolsDir(), settingsFile: loadSettingsFile(), open: openBrowser }),
      panelTab: { load: () => readSettings(loadSettingsFile()).panelTab, save: (id) => { try { writeSettings(loadSettingsFile(), { ...readSettings(loadSettingsFile()), panelTab: id }); } catch { /* next time, then */ } } },
      ...(config.mode === "inference-only" && config.bridgeMissing ? { startupNotice: BRIDGE_MISSING } : stale ? { startupNotice: `The bridge in Live is ${stale.installed}, older than this Kumi's (${stale.bundled}), so some changes aren't offered. Quit Kumi and Live, then run: ${KUMI} update` } : {}) });
    const interrupt = () => terminal?.interrupt();
    const terminate = () => { void terminal?.close(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const running = terminal.run();
    library.start();
    // A newer Kumi, asked at most once a day while Kumi starts (in the background: nothing waits for it, and
    // nothing is said without one). "updateCheck": false in settings.json, or KUMI_NO_UPDATE_CHECK, turns it off.
    if (readSettings(loadSettingsFile()).updateCheck !== false && !process.env.KUMI_NO_UPDATE_CHECK) {
      const cacheFile = join(dirname(loadSettingsFile()), "update-check.json");
      void (INSTALLED ? newerRelease(cacheFile) : newerKumi({ cacheFile })).then((latest) => { if (latest) terminal?.offerUpdate(latest); }, () => {});
    }
    try { process.exitCode = await running; }
    finally {
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
      // Learning stops between files; what it learned is kept for next time.
      await library.close().catch(() => {});
      // Normally exit naturally. A leaked dependency handle must not hang the TUI
      // indefinitely after bounded cleanup. Only this Kumi process is terminated.
      if (!updateAfter) {
        const watchdog = setTimeout(() => {
          process.stderr.write("Kumi shutdown left a live handle; terminating this Kumi process.\n"); process.exit(1);
        }, 2_000);
        watchdog.unref();
      }
    }
    if (updateAfter) process.exit(await updateAndReopen());
  }
} catch (error) {
  process.stderr.write(`Kumi: ${safeError(error, secrets)}\n`);
  process.exitCode = 1;
}
