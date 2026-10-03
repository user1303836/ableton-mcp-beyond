/**
 * Keeping Kumi and its bridge up to date. Kumi runs from a git checkout, so a newer Kumi is a higher
 * version in package.json on the checkout's upstream branch, found with git itself (no web address
 * to keep current). The check runs at most once a day, in the background, and says nothing when
 * this isn't a checkout or there's no network. `npm run kumi -- update` brings the checkout up to
 * date, rebuilds, and updates the bridge in Live when it's older than Kumi's.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { KUMI_VERSION } from "@kumi/runtime";
import { isLiveRunning, runProgram, type Ran } from "./bridge-setup.js";
import { findBridgeConfig } from "./config.js";
import { readBridgeServer } from "./doctor.js";
import { step } from "./spinner.js";
import { KUMI, KUMI_REPAIR } from "@kumi/runtime";

type Env = Readonly<Record<string, string | undefined>>;
type Run = (command: string, args: readonly string[], cwd?: string) => Promise<Ran>;

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DAY = 24 * 60 * 60_000;

/** Whether version `left` ("1.0.2") is newer than `right`. */
export function newer(left: string, right: string): boolean {
  const a = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0); const b = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
}

/** Kumi's updates, as the terminals offer them: /update, and word of a newer Kumi when it starts. */
export interface UpdateControl {
  /** This Kumi's version. */
  current: string;
  /** A newer version, asked now; undefined when this is the newest. Throws, saying why, when it can't be asked. */
  check(): Promise<string | undefined>;
  /** Kumi updates once the terminal has closed, then opens again; the terminal finishes right after. */
  request(): void;
}

export interface CheckIo {
  /** Where the last check's answer is kept, so it runs at most once a day. */
  cacheFile: string;
  run?: Run;
  repoDir?: string;
  now?: () => number;
  version?: string;
}

/** The checkout's upstream branch ("origin/main"), or undefined when this isn't a checkout that follows one. */
async function upstream(run: Run, repo: string): Promise<string | undefined> {
  if (!existsSync(join(repo, ".git"))) return undefined;
  const ran = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo);
  const name = ran.stdout.trim();
  return ran.code === 0 && /^[\w./-]+\/[\w./-]+$/.test(name) ? name : undefined;
}

/** The version on the upstream branch, after fetching it; undefined when git or the network can't say. */
async function upstreamVersion(run: Run, repo: string, branch: string): Promise<string | undefined> {
  const [remote, ...rest] = branch.split("/");
  if ((await run("git", ["fetch", "--quiet", remote!, rest.join("/")], repo)).code !== 0) return undefined;
  const shown = await run("git", ["show", `${branch}:package.json`], repo);
  try { const version = (JSON.parse(shown.stdout) as { version?: unknown }).version; return shown.code === 0 && typeof version === "string" ? version : undefined; } catch { return undefined; }
}

/** The upstream branch's version when it's newer than this Kumi, asked now (for /update and `update --check`). Throws when git can't say. */
export async function checkCheckout(io: Omit<CheckIo, "cacheFile" | "now"> = {}): Promise<string | undefined> {
  const run = io.run ?? runProgram; const repo = io.repoDir ?? REPO;
  const branch = await upstream(run, repo).catch(() => undefined);
  if (!branch) throw new Error("this Kumi isn't a git checkout that follows a branch");
  const latest = await upstreamVersion(run, repo, branch).catch(() => undefined);
  if (!latest) throw new Error("Kumi couldn't reach the repository to ask; check your internet connection");
  return newer(latest, io.version ?? KUMI_VERSION) ? latest : undefined;
}

/** A newer Kumi's version, if there is one: asked of git at most once a day, else from the last answer. */
export async function newerKumi(io: CheckIo): Promise<string | undefined> {
  const now = io.now?.() ?? Date.now(); const current = io.version ?? KUMI_VERSION;
  try {
    const cached = JSON.parse(await readFile(io.cacheFile, "utf8")) as { checkedAt?: unknown; latest?: unknown };
    if (typeof cached.checkedAt === "number" && now - cached.checkedAt < DAY && now >= cached.checkedAt) {
      return typeof cached.latest === "string" && newer(cached.latest, current) ? cached.latest : undefined;
    }
  } catch { /* not checked yet */ }
  const run = io.run ?? runProgram; const repo = io.repoDir ?? REPO;
  const branch = await upstream(run, repo).catch(() => undefined);
  if (!branch) return undefined;
  const latest = await upstreamVersion(run, repo, branch).catch(() => undefined);
  if (!latest) return undefined;
  await mkdir(dirname(io.cacheFile), { recursive: true, mode: 0o700 }).catch(() => {});
  await writeFile(io.cacheFile, JSON.stringify({ checkedAt: now, latest }), { mode: 0o600 }).catch(() => {});
  return newer(latest, current) ? latest : undefined;
}

/** The bridge Kumi ships with, and the one Live uses, when Live's is older. */
export function olderBridge(env: Env, bundled: string | undefined): { installed: string; bundled: string } | undefined {
  const config = findBridgeConfig(env);
  if (!config || !bundled) return undefined;
  let installed: string | undefined;
  try { installed = readBridgeServer(config).version; } catch { return undefined; }
  return installed && newer(bundled, installed) ? { installed, bundled } : undefined;
}

export interface UpdateIo {
  out: Writable;
  env: Env;
  run?: Run;
  repoDir?: string;
  liveRunning?: () => Promise<boolean>;
  /** Runs `npm run kumi -- bridge` from the updated checkout, talking to the producer directly. */
  updateBridge?: (repo: string) => Promise<number>;
}

const last = (ran: Ran) => (ran.stderr || ran.stdout).trim().split("\n").at(-1)?.slice(0, 300) ?? "";

/** The updated checkout's own `kumi bridge`, which asks about Live and waits for it itself. */
function kumiBridge(repo: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, "apps", "kumi", "bin", "kumi.mjs"), "bridge"], { cwd: repo, stdio: "inherit" });
    child.on("error", () => resolve(1)); child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** `npm run kumi -- update`: the checkout, the build, then the bridge in Live when it's older. */
export async function runUpdate(io: UpdateIo): Promise<number> {
  const say = (line = "") => io.out.write(`${line}\n`);
  const run = io.run ?? runProgram; const repo = io.repoDir ?? REPO;
  const branch = await upstream(run, repo).catch(() => undefined);
  if (!branch) { say("This Kumi isn't a git checkout that follows a branch, so update it the way you installed it."); return 1; }
  const status = await run("git", ["status", "--porcelain", "--untracked-files=no"], repo);
  if (status.code !== 0) { say(`git couldn't read this checkout: ${last(status)}`); return 1; }
  if (status.stdout.trim()) { say(`This checkout has changes of its own, so Kumi leaves it as it is. Commit or stash them, then run: ${KUMI} update`); return 1; }
  const fetched = await step(io.out, io.env, `Looking for a newer Kumi on ${branch}…`, () => run("git", ["fetch", "--quiet", ...branch.split(/\/(.*)/s).slice(0, 2)], repo));
  if (fetched.code !== 0) { say("Couldn't reach the repository; check the network, then run update again."); return 1; }
  const behind = Number((await run("git", ["rev-list", "--count", `HEAD..${branch}`], repo)).stdout.trim()) || 0;
  if (behind > 0) {
    const pulled = await run("git", ["merge", "--ff-only", branch], repo);
    if (pulled.code !== 0) { say(`This checkout has moved away from ${branch}, so it can't simply move forward: ${last(pulled)}`); return 1; }
    const built = await step(io.out, io.env, "Installing and building (a few minutes)…", () => run("npm", ["run", "setup"], repo));
    if (built.code !== 0) { say(`Building failed: ${last(built)}. Run ${KUMI_REPAIR} to see why.`); return 1; }
  }
  let version = KUMI_VERSION; let bundled: string | undefined;
  try { version = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version; } catch { /* as before */ }
  try { bundled = (JSON.parse(readFileSync(join(repo, "apps", "mcp-server", "package.json"), "utf8")) as { version: string }).version; } catch { bundled = undefined; }
  say(behind > 0 ? `Kumi is now ${version}.` : `Kumi is up to date (${version}).`);
  const bridge = olderBridge(io.env, bundled);
  if (!findBridgeConfig(io.env)) { say(`To connect Live, quit Live, then run: ${KUMI} bridge`); return 0; }
  if (!bridge) { say("The bridge in Live is up to date."); return 0; }
  say(`The bridge in Live is ${bridge.installed}; this Kumi's is ${bridge.bundled}.`);
  if (await step(io.out, io.env, "Checking whether Live is open…", io.liveRunning ?? (() => isLiveRunning(run)), { keep: false }).catch(() => false)) { say(`Quit Live (save your work first), then run: ${KUMI} bridge`); return 0; }
  return (io.updateBridge ?? kumiBridge)(repo);
}
