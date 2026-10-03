import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import {
  apiKeyFor, localServers, loginCodexBrowser, loginCodexDevice, OPENAI_CODEX, openCredentialStore, probeLocal, PROVIDER_INFO, readPiCodexLogin, validApiKey, type OAuthCredential,
} from "@kumi/runtime";
import { readSettings, type AppConfig } from "./config.js";
import { createModelControl, OFFER_ORDER } from "./models.js";
import { spin, step, type Spinning } from "./spinner.js";
import { KUMI, KUMI_START } from "@kumi/runtime";

/** Where a key is typed or piped from. */
export interface KeyInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}
interface Io { out: Writable; env: Readonly<Record<string, string | undefined>>; signal: AbortSignal; openBrowser?: (url: string) => void; input?: KeyInput }

export async function login(config: Extract<AppConfig, { mode: "login" }>, io: Io): Promise<void> {
  const store = openCredentialStore(config.authFile);
  const info = PROVIDER_INFO[config.provider];
  if (config.method === "key") {
    if (!io.input) throw new Error("Kumi needs a terminal to ask for the key.");
    const key = (await readHidden(io.input, io.out, `Paste your ${info.name} API key (make one at ${info.keyPage}). It won't show as you paste: `, io.signal)).trim();
    if (!validApiKey(key)) throw new Error("That doesn't look like an API key (one word of 8 or more characters); nothing was saved.");
    const models = createModelControl({ store, settingsFile: config.settingsFile, env: io.env, changed: async () => {} });
    const verdict = await step(io.out, io.env, `Checking it with ${info.name}…`, () => models.saveKey(config.provider, key, AbortSignal.any([io.signal, AbortSignal.timeout(20_000)])));
    if (verdict === "refused") throw new Error(`${info.name} didn't accept that key; nothing was saved.`);
    io.out.write(verdict === "ok" ? `Signed in to ${info.name}. The key is in ${store.path} (owner-only).\n`
      : `Saved the key in ${store.path} (owner-only). ${info.name} didn't answer just now, so it isn't checked yet.\n`);
  } else {
    let credential: OAuthCredential;
    if (config.method === "import-pi") credential = await readPiCodexLogin(config.piAuthFile);
    else {
      // Once the address is out, a spinner while the producer signs in.
      let waiting: Spinning = { stop() {} };
      try {
        credential = config.method === "device"
          ? await loginCodexDevice({ signal: io.signal, onCode: ({ url, code }) => { io.out.write(`Open ${url} and enter the code ${code}\n`); waiting = spin(io.out, io.env, "Waiting for approval..."); } })
          : await loginCodexBrowser({ signal: io.signal, onUrl: (url) => {
            io.out.write(`Sign in to ChatGPT in your browser. If it did not open, visit:\n${url}\n`);
            io.openBrowser?.(url);
            waiting = spin(io.out, io.env, "Waiting for the browser... (Ctrl-C cancels; use --device on a remote machine)");
          } });
      } finally { waiting.stop(); }
    }
    await store.update(OPENAI_CODEX, async () => credential);
    io.out.write(`Signed in to ChatGPT (openai-codex). Saved to ${store.path} (owner-only).\n`);
    if (config.method === "import-pi") {
      io.out.write("Imported from Pi: Kumi and Pi now share this session, so when either refreshes it the other may need to sign in again. Run login without --from-pi for a separate session.\n");
    }
  }
  const model = io.env.KUMI_MODEL ?? readSettings(config.settingsFile).model;
  if (!model) io.out.write(`Next: ${KUMI_START}. It starts with ${info.name}'s first model; /model changes it.\n`);
  else if (!model.startsWith(`${config.provider}/`)) io.out.write(`Kumi still talks to ${model}; choose one of ${info.name}'s models with /model in Kumi.\n`);
}

export async function logout(config: Extract<AppConfig, { mode: "logout" }>, io: Pick<Io, "out" | "env">): Promise<void> {
  const store = openCredentialStore(config.authFile);
  const info = PROVIDER_INFO[config.provider];
  const existed = Boolean(await store.get(info.credential));
  if (existed) await store.update(info.credential, async () => undefined);
  const shared = info.credential === "opencode" ? " (OpenCode Zen and Go share it)" : "";
  io.out.write(existed ? `Removed Kumi's ${info.name} sign-in${shared} from ${store.path}.\n` : `Kumi has no ${info.name} sign-in to remove.\n`);
  if (info.keyEnv && io.env[info.keyEnv]) io.out.write(`${info.keyEnv} is still set in your environment, and Kumi uses it; unset it to sign out fully.\n`);
}

/** Which providers are usable, without printing any credential. */
export async function authStatus(config: Extract<AppConfig, { mode: "auth" }>, io: Pick<Io, "out" | "env">): Promise<void> {
  const store = openCredentialStore(config.authFile);
  const lines: string[] = [];
  for (const provider of OFFER_ORDER) {
    const info = PROVIDER_INFO[provider];
    let status: string;
    if (info.signIn === "chatgpt") {
      const held = await store.get(OPENAI_CODEX);
      const codex = held?.type === "oauth" ? held : undefined;
      const hours = codex ? Math.floor((codex.expires - Date.now()) / 3_600_000) : 0;
      status = !codex ? `not signed in (${KUMI} login openai-codex)` : hours >= 1 ? `signed in (token valid ~${hours} h; refreshes automatically)` : "signed in (token refreshes on next use)";
    } else {
      const key = await apiKeyFor(provider, store, io.env);
      status = key?.source === "env" ? `API key from ${info.keyEnv}` : key ? "API key saved in Kumi" : `not signed in (${KUMI} login ${provider})`;
    }
    lines.push(`${provider.padEnd(13)} ${status}`);
  }
  const settings = readSettings(config.settingsFile);
  // Model servers need no sign-in: the ones running are usable now.
  for (const server of localServers(settings.modelServers, io.env)) {
    if (await probeLocal(server)) lines.push(`${server.id.padEnd(13)} running ${server.where}; no sign-in needed`);
  }
  const model = io.env.KUMI_MODEL ? `${io.env.KUMI_MODEL} (from KUMI_MODEL)` : settings.model ?? "not chosen yet (Kumi starts with a signed-in provider's first model)";
  io.out.write(`${lines.join("\n")}\nModel: ${model}${settings.effort ? `, effort ${settings.effort}` : ""}\nCredential file: ${config.authFile}\n`);
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* URL is printed */ }
}

/**
 * A line read without showing it: typed or pasted into a terminal (nothing is echoed), or the first
 * line piped in. Ctrl-C cancels.
 */
export function readHidden(input: KeyInput, out: Writable, prompt: string, signal: AbortSignal): Promise<string> {
  out.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    let escape = false;
    const raw = Boolean(input.isTTY && input.setRawMode);
    const finish = (error?: Error) => {
      input.removeListener("data", onData); input.removeListener("end", onEnd); signal.removeEventListener("abort", onAbort);
      if (raw) input.setRawMode!(false);
      input.pause();
      if (raw) out.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new Error("Cancelled; nothing was saved."));
    const onEnd = () => finish();
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        // Arrow keys and the like arrive as escape sequences: none of them is part of a key.
        if (escape) { if (/[A-Za-z~]/.test(char)) escape = false; continue; }
        if (char === "\u001b") { escape = true; continue; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003") { finish(new Error("Cancelled; nothing was saved.")); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char >= " ") value += char;
        if (value.length > 8192) { finish(new Error("That's too long to be an API key; nothing was saved.")); return; }
      }
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    if (raw) input.setRawMode!(true);
    input.on("data", onData); input.once("end", onEnd);
    input.resume();
  });
}
