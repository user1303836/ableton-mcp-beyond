/**
 * An installed Kumi (the installer's launcher sets KUMI_INSTALLED and KUMI_HOME): updating it from
 * the latest GitHub release, going back to the one before, and removing it. The installer lays it out
 * as KUMI_HOME/app (Kumi), app.previous (the one before the last update), node (Kumi's own Node) and
 * bin (the `kumi` launcher). The producer's own files (settings, sign-ins, conversations, notes) sit
 * beside them in KUMI_HOME and stay unless they ask for everything to go.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { EARS_NAME, KUMI, KUMI_VERSION, systemProgram } from "@kumi/runtime";
import { isLiveRunning, runProgram, type Ran } from "./bridge-setup.js";
import { findBridgeConfig, kumiDir, remoteScriptsDir } from "./config.js";
import { readBridgeServer } from "./doctor.js";
import { extensionDataDir, KUMI_EXTENSION_ID, liveExtensionsDir, removeExtension, removeFormerExtension } from "./live-extension.js";
import { step } from "./spinner.js";

type Env = Readonly<Record<string, string | undefined>>;
type Run = (command: string, args: readonly string[], cwd?: string) => Promise<Ran>;

/** Where the installer put Kumi, and where Kumi keeps the producer's files. */
export const kumiHome = kumiDir;

/** Where releases are downloaded from: the latest GitHub release, unless KUMI_RELEASES says otherwise (tests, mirrors). */
export const releaseBase = (env: Env = process.env) => (env.KUMI_RELEASES || "https://github.com/user1303836/kumi/releases/latest/download").replace(/\/+$/, "");

/** What a release says about itself (kumi-release.json, next to the bundle). */
export interface ReleaseManifest { kumi: string; bundle: string; sha256: string; node: string; bridge?: string }

/** Whether version `left` ("1.0.2") is newer than `right`. */
export function newerVersion(left: string, right: string): boolean {
  const a = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0); const b = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
}

/**
 * What asking for the latest release came to: its description; "none" when there's no release with Kumi
 * in it to get (GitHub answered, but not with one); "offline" when there was no answer; "invalid" when
 * the description didn't make sense.
 */
export async function askRelease(env: Env = process.env, fetcher: typeof fetch = fetch): Promise<ReleaseManifest | "none" | "offline" | "invalid"> {
  let response: Response;
  try { response = await fetcher(`${releaseBase(env)}/kumi-release.json`, { signal: AbortSignal.timeout(20_000), redirect: "follow" }); }
  catch { return "offline"; }
  if (response.status === 404) return "none";
  if (!response.ok) return "offline";
  try {
    const value = await response.json() as Partial<ReleaseManifest>;
    const ok = (text: unknown, pattern: RegExp) => typeof text === "string" && pattern.test(text);
    if (!ok(value.kumi, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/) || !ok(value.bundle, /^[\w.-]+\.tar\.gz$/) || !ok(value.sha256, /^[0-9a-f]{64}$/) || !ok(value.node, /^\d+\.\d+\.\d+$/)) return "invalid";
    return value as ReleaseManifest;
  } catch { return "invalid"; }
}

/** The latest release's description; undefined when there's none, no answer, or it doesn't make sense. */
export async function fetchManifest(env: Env = process.env, fetcher: typeof fetch = fetch): Promise<ReleaseManifest | undefined> {
  const asked = await askRelease(env, fetcher);
  return typeof asked === "string" ? undefined : asked;
}

/** Why the latest release couldn't be had, said for the producer. */
const unasked = (asked: "none" | "offline" | "invalid", env: Env) => ({
  none: `There's no Kumi release to get at ${releaseBase(env).replace(/^https:\/\//, "")} yet; try again later`,
  offline: "Kumi couldn't reach GitHub to ask; check your internet connection",
  invalid: "The latest release's description didn't make sense; try again later",
})[asked];

async function download(url: string, file: string, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10 * 60_000), redirect: "follow" });
  if (!response.ok) throw new Error(`the download failed (${response.status})`);
  // Read whole (a bundle is a few MB), not streamed to the file: a body read slower than it arrives pauses
  // Node's HTTP parser, and a server that closes the connection then trips an assertion inside Node that
  // ends the process, past any catch (seen with a plain HTTP/1.0 server).
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export interface InstalledIo {
  out: Writable;
  env: Env;
  input?: Readable & { isTTY?: boolean };
  run?: Run;
  fetcher?: typeof fetch;
  liveRunning?: () => Promise<boolean>;
  confirm?: (question: string) => Promise<boolean>;
  /** Runs the new Kumi's `kumi bridge`, talking to the producer directly. */
  updateBridge?: (app: string) => Promise<number>;
}

function kumiBridge(home: string, app: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(app, "apps", "kumi", "bin", "kumi.mjs"), "bridge"], { cwd: home, stdio: "inherit", env: { ...process.env, KUMI_INSTALLED: "1", KUMI_HOME: home } });
    child.on("error", () => resolve(1)); child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function ask(io: InstalledIo, question: string): Promise<boolean> {
  if (io.confirm) return io.confirm(question);
  if (!io.input?.isTTY) return false;
  const reader = createInterface({ input: io.input, output: io.out });
  try { return /^y(es)?$/i.test((await reader.question(`${question} [y/N] `)).trim()); } finally { reader.close(); }
}

const bridgeVersion = (app: string) => { try { return (JSON.parse(readFileSync(join(app, "apps", "mcp-server", "package.json"), "utf8")) as { version?: string }).version; } catch { return undefined; } };

/** Whether Live is running (no when that can't be told), with a spinner while it's asked. */
const liveOpen = (io: InstalledIo, run: Run) => step(io.out, io.env, "Checking whether Live is open…", io.liveRunning ?? (() => isLiveRunning(run)), { keep: false }).catch(() => false);

/** After Kumi changes, the bridge in Live when it's older than the Kumi now installed. */
async function bridgeAfter(io: InstalledIo, home: string, app: string): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const config = findBridgeConfig(io.env);
  if (!config) { say(`To connect Live, quit Live, then run: ${KUMI} bridge`); return 0; }
  let installed: string | undefined;
  try { installed = readBridgeServer(config).version; } catch { installed = undefined; }
  const bundled = bridgeVersion(app);
  if (!installed || !bundled || !newerVersion(bundled, installed)) { say("The bridge in Live is up to date."); return 0; }
  say(`The bridge in Live is ${installed}; this Kumi's is ${bundled}.`);
  if (await liveOpen(io, io.run ?? runProgram)) { say(`Quit Live (save your work first), then run: ${KUMI} bridge`); return 0; }
  return (io.updateBridge ?? ((path) => kumiBridge(home, path)))(app);
}

/**
 * A folder renamed. Windows refuses for a moment while antivirus scans files just unpacked, so a
 * refusal is tried again for about five seconds (graceful-fs does the same).
 */
async function rename(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await delay(250);
    }
  }
}

/**
 * The fresh folder in as `app`, the old one kept as `previous`. The Kumi before that is set aside
 * until the swap is done, so a swap that fails partway puts everything back, rollback copy included.
 */
export async function swapIn(fresh: string, app: string, previous: string): Promise<void> {
  const older = `${previous}.old`;
  rmSync(older, { recursive: true, force: true });
  if (existsSync(previous)) await rename(previous, older);
  try {
    if (existsSync(app)) await rename(app, previous);
    try { await rename(fresh, app); }
    catch (error) { if (existsSync(previous) && !existsSync(app)) await rename(previous, app); throw error; }
  } catch (error) { if (existsSync(older) && !existsSync(previous)) await rename(older, previous); throw error; }
  rmSync(older, { recursive: true, force: true });
}

/** `kumi update` for an installed Kumi: the latest release, checked, unpacked beside this one, then swapped in. */
export async function updateInstalled(io: InstalledIo): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const home = kumiHome(io.env); const app = join(home, "app"); const fetcher = io.fetcher ?? fetch; const run = io.run ?? runProgram;
  const manifest = await step(io.out, io.env, "Looking for a newer Kumi…", () => askRelease(io.env, fetcher));
  if (typeof manifest === "string") { say(`${unasked(manifest, io.env)}.`); return 1; }
  if (!newerVersion(manifest.kumi, KUMI_VERSION)) { say(`Kumi is up to date (${KUMI_VERSION}).`); return bridgeAfter(io, home, app); }
  // A release that needs a newer Node than the one Kumi brought: the installer brings both.
  if (Number(manifest.node.split(".")[0]) !== Number(process.versions.node.split(".")[0])) {
    say(`Kumi ${manifest.kumi} needs Node ${manifest.node.split(".")[0]}. Run the installer again, which brings it (github.com/user1303836/kumi).`);
    return 1;
  }
  const downloads = join(home, "downloads"); await mkdir(downloads, { recursive: true });
  const bundle = join(downloads, manifest.bundle); const fresh = join(home, "app.new");
  try {
    await step(io.out, io.env, `Downloading Kumi ${manifest.kumi}…`, () => download(`${releaseBase(io.env)}/${manifest.bundle}`, bundle, fetcher));
    if (sha256(bundle) !== manifest.sha256) { say("The download didn't match its checksum, so nothing was changed. Try again in a moment."); return 1; }
    // Unpacked, tried and swapped in under one spinner; what went wrong is said once it has stopped.
    const failed = await step(io.out, io.env, `Putting Kumi ${manifest.kumi} in place…`, async () => {
      rmSync(fresh, { recursive: true, force: true }); await mkdir(fresh, { recursive: true });
      // Windows' own tar, as the installer uses: a PATH from Git Bash puts GNU tar first, which reads "C:\…" as a remote host.
      const unpacked = await run(systemProgram("tar"), ["-xzf", bundle, "-C", fresh]);
      if (unpacked.code !== 0) return `Unpacking it failed: ${(unpacked.stderr || unpacked.stdout).trim().split("\n").at(-1) ?? "tar failed"}`;
      // The new Kumi has to start before it replaces this one.
      const probe = await run(process.execPath, [join(fresh, "apps", "kumi", "bin", "kumi.mjs"), "--version"]);
      if (probe.code !== 0 || !probe.stdout.includes(manifest.kumi)) return "The new Kumi didn't start, so this one stays. Try again, or run the installer again.";
      try { await swapIn(fresh, app, join(home, "app.previous")); }
      catch { return process.platform === "win32" ? "Windows kept Kumi's folder busy; close every Kumi window, then run update again." : "Couldn't put the new Kumi in place, so this one stays."; }
      return undefined;
    }, { keep: false });
    if (failed) { say(failed); return 1; }
  } finally {
    rmSync(fresh, { recursive: true, force: true }); rmSync(bundle, { force: true });
  }
  say(`Kumi is now ${manifest.kumi} (${KUMI} update --rollback goes back to ${KUMI_VERSION}).`);
  return bridgeAfter(io, home, app);
}

/** `kumi update --rollback`: back to the Kumi before the last update. */
export async function rollbackInstalled(io: InstalledIo): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const home = kumiHome(io.env); const app = join(home, "app"); const previous = join(home, "app.previous"); const hold = join(home, "app.rollback");
  if (!existsSync(join(previous, "apps", "kumi", "bin", "kumi.mjs"))) { say("There's no earlier Kumi to go back to."); return 1; }
  let version = "the one before";
  try { version = (JSON.parse(readFileSync(join(previous, "package.json"), "utf8")) as { version: string }).version; } catch { /* as said */ }
  try { rmSync(hold, { recursive: true, force: true }); await rename(app, hold); await rename(previous, app); await rename(hold, previous); }
  catch { if (!existsSync(app) && existsSync(hold)) renameSync(hold, app); say("Couldn't switch back; close every Kumi window and try again."); return 1; }
  say(`Kumi is back to ${version}. ${KUMI} update --rollback again returns to ${KUMI_VERSION}.`);
  return bridgeAfter(io, home, app);
}

/** The lines the installer added to shell startup files, marked so they can be found again. */
export const PATH_MARKER = "# Added by the Kumi installer";

/** The shell startup files the installer may have written to (zsh's in ZDOTDIR when that's set). */
export function startupFiles(env: Env = process.env): string[] {
  const home = env.HOME || homedir(); const zsh = env.ZDOTDIR || home;
  return [...new Set([join(zsh, ".zshrc"), join(zsh, ".zprofile"), ...[".zshrc", ".bashrc", ".bash_profile", ".bash_login", ".profile"].map((name) => join(home, name)),
    join(home, ".config", "fish", "conf.d", "kumi.fish")])];
}

/** Kumi's PATH lines out of the shell startup files: each marker, and the line under it when that one names Kumi's folder. */
export function removePathLines(io: InstalledIo, home: string): void {
  if (process.platform === "win32") return;
  const bin = join(home, "bin");
  for (const file of startupFiles(io.env)) {
    try {
      const text = readFileSync(file, "utf8");
      if (!text.includes(PATH_MARKER)) continue;
      if (file.endsWith("kumi.fish")) { rmSync(file, { force: true }); continue; }
      const lines = text.split("\n"); const kept: string[] = [];
      for (let index = 0; index < lines.length; index++) {
        // The marker, and the PATH line under it, unless someone has since put something else there.
        if (lines[index] === PATH_MARKER) { if (lines[index + 1]?.includes(bin)) index++; continue; }
        kept.push(lines[index]!);
      }
      writeFileSync(file, kept.join("\n"));
      io.out.write(`Took Kumi out of ${file.replace(io.env.HOME || homedir(), "~")}.\n`);
    } catch { /* not there */ }
  }
}

/**
 * Windows keeps the user's PATH in the registry: take Kumi's folder out of it. The value is read as
 * stored (a %VAR% entry stays one) and written back as the kind it was, and Windows is told, as the
 * installer does.
 */
async function removeWindowsPath(run: Run, home: string): Promise<void> {
  if (process.platform !== "win32") return;
  const bin = join(home, "bin").replace(/'/g, "''");
  const script = [
    "$key = (Get-Item -LiteralPath 'HKCU:\\').OpenSubKey('Environment', $true)",
    "$path = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "if ($path) {",
    `  $kept = ($path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne '${bin}') }) -join ';'`,
    "  if ($kept -ne $path) {",
    "    $key.SetValue('Path', $kept, $key.GetValueKind('Path'))",
    "    Add-Type -Namespace Kumi -Name Env -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'",
    "    $result = [UIntPtr]::Zero; [void][Kumi.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
    "  }",
    "}",
  ].join("\n");
  await run(systemProgram("powershell"), ["-NoProfile", "-NonInteractive", "-Command", script]).catch(() => undefined);
}

/** The bridge's own uninstall, from the package Live uses, when Live is closed: whether it left Live ("none" when there's no bridge there). */
async function removeBridge(io: InstalledIo, run: Run): Promise<"removed" | "kept" | "none"> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const config = findBridgeConfig(io.env);
  if (!config) return "none";
  // What to take out by hand when the bridge stays: its Remote Script, and Kumi's extension beside it.
  const extensions = liveExtensionsDir(io.env);
  const byHand = `AbletonMcpBridge from Live's Remote Scripts folder${extensions ? `, and ${KUMI_EXTENSION_ID} from ${extensions} and from ${extensionDataDir(extensions).replace(/[\\/]kumi\.kumi$/, "")}` : ""}`;
  if (!await ask(io, "Remove the Ableton bridge from Live too?")) { say(`The bridge stays in Live, and so do its files. To take it out later, remove ${byHand}.`); return "kept"; }
  if (await liveOpen(io, run)) { say(`Live is open, so the bridge stays, and so do its files. Quit Live, then remove ${byHand}.`); return "kept"; }
  let entry: string | undefined;
  try { entry = readBridgeServer(config).entry; } catch { entry = undefined; }
  const root = entry ? join(entry, "..", "..", "..") : undefined;
  const lifecycle = root ? join(root, "dist", "src", "lifecycle-cli.js") : undefined;
  if (!lifecycle || !existsSync(lifecycle)) { say(`Kumi couldn't find the bridge's own uninstaller; remove ${byHand} by hand.`); return "kept"; }
  const state = join(config, "..");
  const ran = await step(io.out, io.env, "Taking the bridge out of Live…", () => run(process.execPath, [lifecycle, "uninstall", "--remote-scripts-dir", remoteScriptsDir(io.env), "--state-dir", state, "--package-root", root!, "--apply", "--confirm-live-stopped"]), { keep: false });
  if (ran.code !== 0) { say(`The bridge's uninstaller refused; remove ${byHand} by hand.`); return "kept"; }
  // Kumi's extension goes with the bridge: Live would otherwise go on starting it. So does the copy Kumi
  // 1.6.0 and before put where Live on Windows doesn't read, and Kumi's listening device.
  const removedExtension = extensions ? removeExtension(extensions) : false;
  const removedFormer = removeFormerExtension(io.env);
  say(removedExtension || removedFormer ? "The bridge and Kumi's extension are out of Live." : "The bridge is out of Live.");
  const scripts = remoteScriptsDir(io.env);
  if (basename(scripts) === "Remote Scripts") rmSync(join(dirname(scripts), "Kumi", `${EARS_NAME}.amxd`), { force: true });
  return "removed";
}

/** Whether the bridge Live loads keeps its configuration or its package inside this folder. */
function bridgeUses(folder: string, env: Env): boolean {
  const config = findBridgeConfig(env);
  if (!config) return false;
  const inside = (path: string | undefined) => { if (!path) return false; const rel = relative(folder, path); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };
  let entry: string | undefined;
  try { entry = readBridgeServer(config).entry; } catch { entry = undefined; }
  return inside(config) || inside(entry);
}

/** `kumi uninstall [--all] [--yes]`: Kumi, its Node and its launcher go; the producer's own files stay unless --all. */
export async function uninstallInstalled(io: InstalledIo, options: { all: boolean; yes: boolean }): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const home = kumiHome(io.env); const run = io.run ?? runProgram;
  const keeps = options.all ? "Everything in it goes too: your conversations, notes, recipes and sign-ins." : "Your conversations, notes, recipes and sign-ins stay (add --all to remove them too).";
  if (!options.yes && !await ask(io, `Remove Kumi from ${home.replace(homedir(), "~")}? ${keeps}`)) { say("Nothing was removed."); return 1; }
  const bridge = await removeBridge(io, run);
  removePathLines(io, home);
  if (process.platform === "win32") await step(io.out, io.env, "Taking Kumi out of your PATH…", () => removeWindowsPath(run, home), { keep: false });
  // The bridge's configuration and package stay while Live still loads it from here: without them the
  // Remote Script fails every time Live starts.
  const bridgeStays = bridge !== "removed" && bridgeUses(join(home, "bridge"), io.env);
  const parts = options.all
    ? (bridgeStays ? readdirSync(home).filter((name) => name !== "bridge") : ["."]).map((name) => join(home, name))
    : ["app", "app.previous", "app.new", "node", "bin", "downloads", ...(bridgeStays ? [] : ["bridge"])].map((name) => join(home, name));
  if (process.platform === "win32") {
    // Windows won't delete the Node this is running on: a moment after Kumi exits, cmd does it. With /s,
    // cmd takes off only the outer quotes, so the quoted paths inside get through as written (Node would
    // otherwise escape their quotes in a way cmd doesn't read).
    const list = parts.map((path) => `rmdir /s /q "${path}" 2>nul & del /f /q "${path}" 2>nul`).join(" & ");
    // `timeout` quits at once without a console window, so ping is the pause.
    spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"ping -n 4 127.0.0.1 >nul & ${list}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
  } else for (const path of parts) rmSync(path, { recursive: true, force: true });
  if (bridgeStays) say(`The bridge's files stay in ${join(home, "bridge").replace(homedir(), "~")} while Live uses it.`);
  say(options.all ? `Kumi is removed, with everything it kept${bridgeStays ? " but the bridge's files" : ""}.` : `Kumi is removed. Your files are still in ${home.replace(homedir(), "~")}; delete that folder to remove them too.`);
  say("Open a new terminal window so the `kumi` command is gone there too.");
  return 0;
}

/** A newer release's version, asked now (for /update and `kumi update --check`); undefined when this is the newest. Throws when GitHub can't be asked. */
export async function checkRelease(env: Env = process.env, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const manifest = await askRelease(env, fetcher);
  if (typeof manifest === "string") throw new Error(unasked(manifest, env));
  return newerVersion(manifest.kumi, KUMI_VERSION) ? manifest.kumi : undefined;
}

/** A newer release's version, asked of GitHub at most once a day. */
export async function newerRelease(cacheFile: string, env: Env = process.env, now = Date.now()): Promise<string | undefined> {
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { checkedAt?: unknown; latest?: unknown };
    if (typeof cached.checkedAt === "number" && now - cached.checkedAt < 24 * 60 * 60_000 && now >= cached.checkedAt) {
      return typeof cached.latest === "string" && newerVersion(cached.latest, KUMI_VERSION) ? cached.latest : undefined;
    }
  } catch { /* not checked yet */ }
  const manifest = await fetchManifest(env);
  if (!manifest) return undefined;
  try { writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, latest: manifest.kumi }), { mode: 0o600 }); } catch { /* next time */ }
  return newerVersion(manifest.kumi, KUMI_VERSION) ? manifest.kumi : undefined;
}
