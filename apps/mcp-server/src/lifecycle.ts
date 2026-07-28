import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { platform } from "node:process";
import {
  configForBridge,
  diagnosticsAsync,
  generateSecret,
  installRemoteScript,
  readAnyConfig,
  readSecretFile,
  registryDigest,
  rejectSymlinkTree,
  secretPermissions,
  secureWindowsDirectory,
  secureWindowsFile,
  writeConfig,
  writeSecretFile,
  type BridgeConfig,
} from "./delivery.js";

export const LIFECYCLE_RECEIPT_VERSION = 1 as const;
export const LIFECYCLE_ACTIONS = ["install", "activate", "upgrade", "repair", "rollback", "uninstall", "status"] as const;
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number];

type ManagedStatus = "installed-restart-required" | "activated" | "uninstalled";

interface PreviousGeneration {
  packageRoot: string;
  packageVersion: string;
  artifactSha256: string;
  releaseManifestSha256: string;
  registryHash: string;
  remoteBackup: string;
  remoteFiles: Record<string, string>;
  config: BridgeConfig;
  configSha256: string;
}

export interface LifecycleReceipt {
  version: typeof LIFECYCLE_RECEIPT_VERSION;
  status: ManagedStatus;
  generation: number;
  platform: NodeJS.Platform;
  packageRoot: string;
  packageVersion: string;
  artifactSha256: string;
  releaseManifestSha256: string;
  registryHash: string;
  stateDirectory: string;
  remoteScriptsDirectory: string;
  remoteScriptDirectory: string;
  remoteFiles: Record<string, string>;
  configPath: string;
  config: BridgeConfig;
  configSha256: string;
  secretPath: string;
  secretCreatedByLifecycle: boolean;
  previous: PreviousGeneration | null;
  activation: { required: boolean; realLiveVerified: boolean; provenance: "real-live" | "unavailable"; remediation: string };
  lastAction: LifecycleAction;
  retained?: { pendingCleanup: string[]; preserved: string[] };
}

export interface LifecycleOptions {
  action: LifecycleAction;
  packageRoot: string;
  stateDirectory: string;
  remoteScriptsDirectory: string;
  artifactPath?: string;
  artifactSha256?: string;
  configPath?: string;
  secretPath?: string;
  host?: string;
  port?: number;
  realtimePort?: number;
  timeoutMs?: number;
  apply?: boolean;
  confirmLiveStopped?: boolean;
  purgeSecret?: boolean;
  allowDirtyPrivateBuild?: boolean;
  /** Test-only deterministic failure point; not exposed by the CLI. */
  faultAt?: "after-secret" | "after-config" | "before-remote" | "after-remote" | "after-repair-install" | "retired-cleanup-blocked" | "before-receipt";
}

export interface LifecycleResult {
  version: "ableton-mcp-lifecycle/v1";
  action: LifecycleAction;
  applied: boolean;
  state: "planned" | "completed" | "activation-required" | "blocked" | "failed";
  receiptPath: string;
  restartRequired: boolean;
  steps: Array<{ id: string; impact: string; status: "planned" | "completed" | "skipped" }>;
  verification: Record<string, unknown>;
  recovery: { journalPath: string; rollbackAvailable: boolean; quarantine?: string };
  instructions: string[];
}

interface ReleaseManifest {
  schema: "ableton-mcp-private-release/v1";
  package: { name: string; version: string; license: string; private: boolean };
  source: { commit: string; dirty: boolean };
  build: { runtime: string; nodeRange: string; recipe: string; builder: { node: string; npm: string; typescript: string; platform: string; architecture: string; runnerImage: string; runnerImageVersion: string; packageLockSha256: string; workflowSha256: string } };
  protocol: { registryHash: string };
  distribution: { channel: string; published: boolean; signed: boolean; notarized: boolean };
  algorithm: "sha256";
  files: Record<string, string>;
}

const RECEIPT_NAME = "install-receipt.json";
const JOURNAL_NAME = "lifecycle-journal.json";
const REMOTE_PACKAGE = "AbletonMcpBridge";
const REMOTE_MODULE = "ableton_mcp_remote_script.py";
const ARTIFACT_SHA_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_TAR_BYTES = 64 * 1024 * 1024;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileDigest(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`managed file is not a regular file: ${path}`);
  return sha256(readFileSync(path));
}

function validateAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error(`${label} must be an absolute safe path`);
  const root = parse(path).root;
  if (resolve(path) === resolve(root)) throw new Error(`${label} must not be a filesystem root`);
}

/** Reject every existing symlink/junction ancestor, not only the leaf. */
export function assertNoLinkedAncestors(path: string): void {
  validateAbsolutePath(path, "lifecycle path");
  const root = parse(path).root;
  const parts = relative(root, resolve(path)).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      // macOS exposes /var and /tmp as stable system compatibility links into
      // /private. Resolve those roots, but reject every caller-controlled link
      // below them (and every Windows junction/reparse ancestor).
      if (!(platform === "darwin" && (cursor === "/var" || cursor === "/tmp"))) throw new Error(`refusing symbolic-link or junction ancestor: ${cursor}`);
    }
  }
}

function ensureOwnerDirectory(path: string): void {
  assertNoLinkedAncestors(dirname(path));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (platform !== "win32") chmodSync(path, 0o700);
  else secureWindowsDirectory(path);
}

async function withLifecycleLock<T>(stateDirectory: string, task: () => Promise<T>): Promise<T> {
  const lockPath = join(stateDirectory, "lifecycle.lock");
  assertNoLinkedAncestors(lockPath);
  try {
    writeFileSync(lockPath, `${JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    throw new Error("another lifecycle operation owns the state lock; inspect the owner before removing a stale lock", { cause: error });
  }
  try {
    if (platform !== "win32") chmodSync(lockPath, 0o600);
    secureWindowsFile(lockPath);
    return await task();
  } finally { if (existsSync(lockPath)) rmSync(lockPath, { force: true }); }
}

function writeOwnerJson(path: string, value: unknown): void {
  validateAbsolutePath(path, "managed JSON path");
  assertNoLinkedAncestors(path);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (platform !== "win32") chmodSync(temporary, 0o600);
  secureWindowsFile(temporary);
  try {
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isFile() || secretPermissions(path) !== "owner-only") throw new Error(`refusing to replace unowned or non-regular managed JSON: ${path}`);
      if (platform === "win32") {
        const backup = `${path}.${process.pid}.replace-backup`;
        if (existsSync(backup)) rmSync(backup, { force: true });
        const script = "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MCP_TEMP));$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MCP_PATH));$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MCP_BACKUP));[IO.File]::Replace($t,$p,$b,$true);[IO.File]::Delete($b)";
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { env: { ...process.env, MCP_TEMP: Buffer.from(temporary).toString("base64"), MCP_PATH: Buffer.from(path).toString("base64"), MCP_BACKUP: Buffer.from(backup).toString("base64") }, stdio: "ignore" });
      } else renameSync(temporary, path);
    } else renameSync(temporary, path);
    secureWindowsFile(path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function tryWriteOwnerJson(path: string, value: unknown): boolean {
  try { writeOwnerJson(path, value); return true; } catch { return false; }
}

function finalizeFailedJournal(path: string, action: LifecycleAction, generation: number | null, error: unknown): void {
  try {
    if (existsSync(path)) { const current = JSON.parse(readFileSync(path, "utf8")) as { state?: unknown }; if (current.state !== "applying") return; }
  } catch { /* replace malformed or unreadable journal without masking the action error */ }
  tryWriteOwnerJson(path, { version: 1, action, state: "failed", receiptGeneration: generation, reason: error instanceof Error ? error.message : "unknown" });
}

function tryRemove(path: string, recursive = false): boolean {
  try { rmSync(path, { recursive, force: true }); return true; } catch { return false; }
}

function parseReceipt(path: string): LifecycleReceipt {
  assertNoLinkedAncestors(path);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || secretPermissions(path) !== "owner-only") throw new Error("installation receipt is not an owner-only regular file");
  const value = JSON.parse(readFileSync(path, "utf8")) as LifecycleReceipt;
  const absoluteFields = [value?.packageRoot, value?.stateDirectory, value?.remoteScriptsDirectory, value?.remoteScriptDirectory, value?.configPath, value?.secretPath];
  const hashes = [value?.artifactSha256, value?.releaseManifestSha256, value?.registryHash, value?.configSha256, ...Object.values(value?.remoteFiles ?? {})];
  const config = value?.config;
  const previous = value?.previous;
  const retainedValid = value?.retained === undefined || (typeof value.stateDirectory === "string" && [value.retained.pendingCleanup, value.retained.preserved].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string" && isAbsolute(item) && !relative(value.stateDirectory, item).startsWith(".."))));
  const previousValid = previous === null || (typeof previous === "object" && [previous.artifactSha256, previous.releaseManifestSha256, previous.registryHash, previous.configSha256, ...Object.values(previous.remoteFiles ?? {})].every((hash) => typeof hash === "string" && ARTIFACT_SHA_PATTERN.test(hash)) && [previous.packageRoot, previous.remoteBackup].every((item) => typeof item === "string" && isAbsolute(item)) && previous.config?.version === 2);
  if (value?.version !== LIFECYCLE_RECEIPT_VERSION || !["installed-restart-required", "activated", "uninstalled"].includes(value.status) || !Number.isSafeInteger(value.generation) || value.generation < 1 || absoluteFields.some((item) => typeof item !== "string" || !isAbsolute(item)) || hashes.some((hash) => typeof hash !== "string" || !ARTIFACT_SHA_PATTERN.test(hash)) || !previousValid || !retainedValid || config?.version !== 2 || typeof config.bridge?.host !== "string" || !Number.isSafeInteger(config.bridge.port) || typeof value.secretCreatedByLifecycle !== "boolean" || typeof value.activation?.required !== "boolean" || typeof value.activation?.realLiveVerified !== "boolean") throw new Error("installation receipt is invalid or unsupported");
  return value;
}

function hashRegularTree(root: string): Record<string, string> {
  rejectSymlinkTree(root);
  const output: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && !stat.isSymbolicLink()) output[relative(root, path).split(sep).join("/")] = fileDigest(path);
      else throw new Error(`managed tree contains an unsupported entry: ${path}`);
    }
  };
  walk(root);
  return output;
}

function verifyFiles(root: string, expected: Record<string, string>): { valid: boolean; missing: string[]; changed: string[]; unknown: string[] } {
  const current = existsSync(root) ? hashRegularTree(root) : {};
  const missing = Object.keys(expected).filter((name) => !(name in current));
  const changed = Object.keys(expected).filter((name) => name in current && current[name] !== expected[name]);
  const unknown = Object.keys(current).filter((name) => !(name in expected));
  return { valid: missing.length === 0 && changed.length === 0 && unknown.length === 0, missing, changed, unknown };
}

function verifyReleasePackage(packageRoot: string, allowDirty: boolean): { manifest: ReleaseManifest; manifestSha256: string } {
  validateAbsolutePath(packageRoot, "package root");
  assertNoLinkedAncestors(packageRoot);
  const manifestPath = join(packageRoot, "release-manifest.json");
  const manifestEntry = lstatSync(manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw new Error("release manifest must be a regular file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  if (manifest.schema !== "ableton-mcp-private-release/v1" || manifest.package.name !== "@ableton-mcp/mcp-server" || manifest.package.private !== true || manifest.package.license !== "UNLICENSED" || manifest.algorithm !== "sha256" || manifest.distribution.channel !== "private-local-npm-tarball" || manifest.distribution.published || manifest.distribution.signed || manifest.distribution.notarized || !ARTIFACT_SHA_PATTERN.test(manifest.protocol.registryHash) || !manifest.build?.recipe || !manifest.build?.builder?.node || !manifest.build?.builder?.npm || !manifest.build?.builder?.typescript || !ARTIFACT_SHA_PATTERN.test(manifest.build?.builder?.packageLockSha256 ?? "") || !ARTIFACT_SHA_PATTERN.test(manifest.build?.builder?.workflowSha256 ?? "") || !manifest.files || Object.keys(manifest.files).length < 10) throw new Error("release manifest policy is invalid");
  if (manifest.source.dirty && !allowDirty) throw new Error("release manifest identifies a dirty source tree; only explicit private development testing may override this");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (name.includes("..") || name.startsWith("/") || !ARTIFACT_SHA_PATTERN.test(digest)) throw new Error("release manifest contains an unsafe file entry");
    const path = join(packageRoot, ...name.split("/"));
    if (fileDigest(path) !== digest) throw new Error(`release payload hash mismatch: ${name}`);
  }
  if (manifest.protocol.registryHash !== registryDigest()) throw new Error("release and runtime registry hashes disagree");
  return { manifest, manifestSha256: fileDigest(manifestPath) };
}

function verifyArtifactBinding(artifactPath: string | undefined, expectedSha256: string | undefined, packageRoot: string, releaseManifestSha256: string): string {
  if (!artifactPath) throw new Error("the exact local npm tarball path is required");
  validateAbsolutePath(artifactPath, "artifact path");
  assertNoLinkedAncestors(artifactPath);
  const entry = lstatSync(artifactPath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("artifact must be a regular local file");
  if (entry.size < 1 || entry.size > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the bounded compressed size");
  const compressed = readFileSync(artifactPath);
  const artifactSha256 = sha256(compressed);
  if (!expectedSha256 || !ARTIFACT_SHA_PATTERN.test(expectedSha256) || expectedSha256 !== artifactSha256) throw new Error("artifact SHA-256 does not match the exact tarball bytes");
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: MAX_ARTIFACT_TAR_BYTES }); } catch (cause) {
    if (cause instanceof Error && /output length|buffer too large|larger than/i.test(cause.message)) throw new Error("artifact exceeds the bounded decompressed size");
    throw new Error("artifact is not a valid gzip-compressed npm tarball");
  }
  const tarFiles = new Map<string, Buffer>();
  let terminated = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) { if (tar.subarray(offset).some((value) => value !== 0)) throw new Error("artifact tarball has non-zero trailing content"); terminated = true; break; }
    const text = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const storedChecksum = Number.parseInt(text(148, 8).trim(), 8); const checksumHeader = Buffer.from(header); checksumHeader.fill(0x20, 148, 156); const computedChecksum = [...checksumHeader].reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(storedChecksum) || storedChecksum !== computedChecksum) throw new Error("artifact tar header checksum is invalid");
    const name = text(0, 100); const prefix = text(345, 155); const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = text(124, 12).trim(); const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || !path.startsWith("package/") || path.includes("..") || path.includes("\\")) throw new Error("artifact tar header or path is malformed");
    const type = String.fromCharCode(header[156] || 48);
    if (type !== "0" && type !== "\0") throw new Error(`artifact contains a non-regular entry: ${path}`);
    if (tarFiles.has(path)) throw new Error(`artifact contains a duplicate entry: ${path}`);
    tarFiles.set(path, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!terminated) throw new Error("artifact tarball has no valid end marker");
  const manifestBytes = tarFiles.get("package/release-manifest.json");
  if (!manifestBytes || sha256(manifestBytes) !== releaseManifestSha256) throw new Error("artifact tarball and extracted package root have different release manifests");
  const embedded = JSON.parse(manifestBytes.toString("utf8")) as ReleaseManifest;
  const expected = ["package/package.json", "package/release-manifest.json", ...Object.keys(embedded.files).map((name) => `package/${name}`)].sort();
  if (JSON.stringify([...tarFiles.keys()].sort()) !== JSON.stringify(expected)) throw new Error("artifact inventory differs from the strict embedded release manifest");
  for (const [name, digest] of Object.entries(embedded.files)) if (sha256(tarFiles.get(`package/${name}`) ?? Buffer.alloc(0)) !== digest) throw new Error(`artifact payload hash mismatch: ${name}`);
  const embeddedPackage = tarFiles.get("package/package.json");
  if (!embeddedPackage || sha256(embeddedPackage) !== fileDigest(join(packageRoot, "package.json"))) throw new Error("artifact package metadata differs from the extracted package root");
  return artifactSha256;
}

function assertPackageStillBound(packageRoot: string, expected: { manifestSha256: string }, allowDirty: boolean): void {
  const current = verifyReleasePackage(packageRoot, allowDirty);
  if (current.manifestSha256 !== expected.manifestSha256) throw new Error("package root changed during lifecycle operation");
}

async function portAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    let settled = false;
    const settle = (value: boolean) => { if (!settled) { settled = true; resolvePromise(value); } };
    server.once("error", () => settle(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => settle(true)));
  });
}

async function verifyPorts(host: string, control: number, realtime: number): Promise<void> {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("lifecycle bridge host must be an exact loopback address");
  if (!Number.isInteger(control) || !Number.isInteger(realtime) || control < 1 || control > 65_535 || realtime < 1 || realtime > 65_535 || control === realtime) throw new Error("control and realtime ports must be distinct values from 1 to 65535");
  if (!(await portAvailable(host, control))) throw new Error(`control port ${control} is occupied`);
  if (!(await portAvailable(host, realtime))) throw new Error(`realtime port ${realtime} is occupied`);
}

function expectedPaths(options: LifecycleOptions) {
  validateAbsolutePath(options.packageRoot, "package root");
  validateAbsolutePath(options.stateDirectory, "state directory");
  validateAbsolutePath(options.remoteScriptsDirectory, "Remote Scripts directory");
  const configPath = options.configPath ?? join(options.stateDirectory, "bridge-config.json");
  const secretPath = options.secretPath ?? join(options.stateDirectory, "bridge.secret");
  validateAbsolutePath(configPath, "configuration path");
  validateAbsolutePath(secretPath, "secret path");
  return {
    receiptPath: join(options.stateDirectory, RECEIPT_NAME),
    journalPath: join(options.stateDirectory, JOURNAL_NAME),
    remoteScriptDirectory: join(options.remoteScriptsDirectory, REMOTE_PACKAGE),
    configPath,
    secretPath,
  };
}

function plannedSteps(action: LifecycleAction): LifecycleResult["steps"] {
  const values: Record<LifecycleAction, Array<[string, string]>> = {
    install: [["preflight", "read-only validation"], ["secret", "creates owner-only secret"], ["config", "creates owner-only bridge config"], ["remote-script", "installs managed Live Remote Script"], ["receipt", "writes owner-only lifecycle receipt"]],
    activate: [["diagnostics", "authenticated read-only Live discovery"], ["receipt", "records activation evidence only for real-live provenance"]],
    upgrade: [["preflight", "verifies current and candidate manifests"], ["backup", "retains current generation"], ["config", "switches exact host entrypoint"], ["remote-script", "atomically replaces managed bridge"], ["receipt", "records rollback generation"]],
    repair: [["inspect", "compares receipt hashes and permissions"], ["quarantine", "preserves drift before replacement"], ["restore", "restores managed payload only"], ["verify", "rehashes repaired state"]],
    rollback: [["preflight", "verifies retained previous generation"], ["swap", "restores prior Remote Script and configuration"], ["verify", "rehashes restored generation"]],
    uninstall: [["preflight", "verifies receipt ownership"], ["remote-script", "removes exact managed files or quarantines drift"], ["config", "removes only digest-matching managed config"], ["secret", "preserves secret unless purge is explicit"], ["receipt", "records uninstalled state"]],
    status: [["inspect", "read-only lifecycle and drift report"]],
  };
  return values[action].map(([id, impact]) => ({ id, impact, status: "planned" }));
}

function baseResult(options: LifecycleOptions, paths: ReturnType<typeof expectedPaths>): LifecycleResult {
  return { version: "ableton-mcp-lifecycle/v1", action: options.action, applied: false, state: "planned", receiptPath: paths.receiptPath, restartRequired: ["install", "upgrade", "rollback", "uninstall"].includes(options.action), steps: plannedSteps(options.action), verification: {}, recovery: { journalPath: paths.journalPath, rollbackAvailable: false }, instructions: [] };
}

function completeSteps(result: LifecycleResult): void {
  result.steps = result.steps.map((step) => ({ ...step, status: "completed" }));
}

function requireStoppedConfirmation(options: LifecycleOptions): void {
  if (options.apply === true && ["install", "upgrade", "rollback", "uninstall"].includes(options.action) && options.confirmLiveStopped !== true) throw new Error("explicit --confirm-live-stopped is required; the lifecycle never kills Ableton Live");
}

function fault(options: LifecycleOptions, point: LifecycleOptions["faultAt"]): void {
  if (options.faultAt === point) throw new Error(`injected lifecycle failure at ${point}`);
}

function compareVersions(candidate: string, current: string): number {
  const parseVersion = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    if (!match) throw new Error(`package version is not semantic: ${value}`);
    return match.slice(1, 4).map(Number);
  };
  const next = parseVersion(candidate); const prior = parseVersion(current);
  for (let index = 0; index < 3; index += 1) if (next[index] !== prior[index]) return (next[index] ?? 0) > (prior[index] ?? 0) ? 1 : -1;
  return 0;
}

function quarantinePath(stateDirectory: string, label: string): string {
  const root = join(stateDirectory, "quarantine");
  assertNoLinkedAncestors(root);
  ensureOwnerDirectory(root);
  return join(root, `${label}-${Date.now()}-${process.pid}-${process.hrtime.bigint()}`);
}

function restoreBackup(destination: string, backup: string | null): void {
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  if (backup && existsSync(backup)) renameSync(backup, destination);
}

export async function runLifecycle(options: LifecycleOptions): Promise<LifecycleResult> {
  if (!LIFECYCLE_ACTIONS.includes(options.action)) throw new Error("unsupported lifecycle action");
  const paths = expectedPaths(options);
  const result = baseResult(options, paths);
  for (const path of [options.packageRoot, options.stateDirectory, options.remoteScriptsDirectory, paths.configPath, paths.secretPath, paths.remoteScriptDirectory, paths.receiptPath, paths.journalPath, ...(options.artifactPath ? [options.artifactPath] : [])]) assertNoLinkedAncestors(path);
  if (!existsSync(options.remoteScriptsDirectory) || !statSync(options.remoteScriptsDirectory).isDirectory()) throw new Error("Remote Scripts directory must already exist and be explicitly selected");
  const receipt = existsSync(paths.receiptPath) ? parseReceipt(paths.receiptPath) : null;
  const packageRequired = ["install", "upgrade", "repair"].includes(options.action);
  const packageEvidence = packageRequired ? verifyReleasePackage(options.packageRoot, options.allowDirtyPrivateBuild === true) : null;
  const artifactSha256 = options.action === "install" || options.action === "upgrade" ? verifyArtifactBinding(options.artifactPath, options.artifactSha256, options.packageRoot, packageEvidence!.manifestSha256) : (options.artifactSha256 ?? "");
  requireStoppedConfirmation(options);
  if (receipt?.previous) { const priorRelative = relative(receipt.stateDirectory, receipt.previous.remoteBackup); if (priorRelative.startsWith("..") || isAbsolute(priorRelative)) throw new Error("receipt rollback path escapes owner state"); }
  if (receipt && (receipt.remoteScriptsDirectory !== options.remoteScriptsDirectory || receipt.stateDirectory !== options.stateDirectory || receipt.remoteScriptDirectory !== paths.remoteScriptDirectory || receipt.configPath !== paths.configPath || receipt.secretPath !== paths.secretPath)) throw new Error("lifecycle paths do not match the owner receipt");
  if (receipt && options.action === "repair" && (resolve(options.packageRoot) !== resolve(receipt.packageRoot) || packageEvidence!.manifestSha256 !== receipt.releaseManifestSha256 || packageEvidence!.manifest.package.version !== receipt.packageVersion || packageEvidence!.manifest.protocol.registryHash !== receipt.registryHash)) throw new Error("repair package root is not the exact receipt-bound generation; use upgrade for a different artifact");

  if (!options.apply && options.action !== "activate" && options.action !== "status") {
    result.verification = { packageVersion: packageEvidence?.manifest.package.version ?? receipt?.packageVersion ?? null, sourceCommit: packageEvidence?.manifest.source.commit ?? null, sourceDirty: packageEvidence?.manifest.source.dirty ?? null, packageRootVerified: packageEvidence !== null, receiptPresent: receipt !== null, portsRequireApplyTimeProbe: options.action === "install" };
    result.instructions = ["Review the plan, stop Ableton Live, then repeat with --apply and --confirm-live-stopped."];
    return result;
  }

  if (options.action === "status") {
    const drift = receipt && receipt.status !== "uninstalled" ? verifyFiles(paths.remoteScriptDirectory, receipt.remoteFiles) : null;
    const configValid = Boolean(receipt && receipt.status !== "uninstalled" && existsSync(receipt.configPath) && fileDigest(receipt.configPath) === receipt.configSha256 && secretPermissions(receipt.configPath) === "owner-only");
    let packageValid = false;
    if (receipt && receipt.status !== "uninstalled") { try { const evidence = verifyReleasePackage(receipt.packageRoot, options.allowDirtyPrivateBuild === true); packageValid = evidence.manifestSha256 === receipt.releaseManifestSha256 && evidence.manifest.protocol.registryHash === receipt.registryHash; } catch { packageValid = false; } }
    const secretValid = Boolean(receipt && receipt.status !== "uninstalled" && existsSync(receipt.secretPath) && secretPermissions(receipt.secretPath) === "owner-only");
    const installationIntegrityValid = Boolean(drift?.valid && configValid && packageValid && secretValid);
    result.state = "completed";
    result.verification = { receipt: receipt ? { status: receipt.status, effectiveStatus: receipt.status === "activated" && !installationIntegrityValid ? "installed-restart-required" : receipt.status, generation: receipt.generation, packageVersion: receipt.packageVersion, artifactSha256: receipt.artifactSha256, recordedActivation: receipt.activation, activationEvidenceScope: "historical-receipt-not-current-connectivity", retained: receipt.retained ?? { pendingCleanup: [], preserved: [] } } : null, installationIntegrityValid, packageValid, configValid, remoteScript: drift, configPermissions: receipt && existsSync(receipt.configPath) ? secretPermissions(receipt.configPath) : "unavailable", secretPermissions: receipt && existsSync(receipt.secretPath) ? secretPermissions(receipt.secretPath) : "unavailable", lifecycleLockPresent: existsSync(join(options.stateDirectory, "lifecycle.lock")) };
    result.recovery.rollbackAvailable = Boolean(receipt?.previous && existsSync(receipt.previous.remoteBackup));
    if (receipt?.retained?.preserved[0] || receipt?.retained?.pendingCleanup[0]) result.recovery.quarantine = receipt.retained.preserved[0] ?? receipt.retained.pendingCleanup[0];
    completeSteps(result);
    return result;
  }

  if (options.action === "activate") {
    if (!receipt || receipt.status === "uninstalled") throw new Error("an installed lifecycle receipt is required for activation");
    ensureOwnerDirectory(options.stateDirectory);
    return withLifecycleLock(options.stateDirectory, async () => {
      const current = parseReceipt(paths.receiptPath);
      if (current.generation !== receipt.generation) throw new Error("receipt generation changed before activation; retry from fresh status");
      const remote = verifyFiles(paths.remoteScriptDirectory, current.remoteFiles);
      let packageValid = false;
      try { const evidence = verifyReleasePackage(current.packageRoot, options.allowDirtyPrivateBuild === true); packageValid = evidence.manifestSha256 === current.releaseManifestSha256 && evidence.manifest.protocol.registryHash === current.registryHash; } catch { packageValid = false; }
      const installationValid = remote.valid && existsSync(current.configPath) && fileDigest(current.configPath) === current.configSha256 && secretPermissions(current.configPath) === "owner-only" && secretPermissions(current.secretPath) === "owner-only" && packageValid;
      const report = installationValid ? await diagnosticsAsync(current.packageRoot, current.configPath) : null;
      const activated = installationValid && report !== null && report.liveConnected && report.provenance === "real-live" && report.registryHash === current.registryHash;
      const next: LifecycleReceipt = { ...current, status: activated ? "activated" : "installed-restart-required", activation: { required: !activated, realLiveVerified: activated, provenance: activated ? "real-live" : "unavailable", remediation: activated ? "none" : installationValid ? "Restart Live, select AbletonMcpBridge as a Control Surface, then rerun activate." : "Run lifecycle repair and verify receipt-bound hashes before activation." }, lastAction: "activate" };
      writeOwnerJson(paths.receiptPath, next);
      result.applied = true; result.state = activated ? "completed" : "activation-required"; result.restartRequired = !activated;
      result.verification = { installationValid, remoteScript: remote, authenticatedReachable: report?.authenticatedReachable ?? false, liveConnected: report?.liveConnected ?? false, provenance: report?.provenance ?? "unavailable", registryHash: report?.registryHash ?? null, expectedRegistryHash: current.registryHash };
      result.instructions = activated ? ["Real-Live activation, receipt-bound installation, and registry identity verified."] : [next.activation.remediation];
      completeSteps(result); return result;
    });
  }

  if (options.apply === true && !["install", "activate", "status", "uninstall"].includes(options.action) && (!receipt || receipt.status === "uninstalled")) throw new Error("an active installation receipt is required");
  if (options.apply === true && options.action === "rollback" && (!receipt?.previous || !existsSync(receipt.previous.remoteBackup))) throw new Error("no verified previous generation is available");
  if (options.action === "install") await verifyPorts(options.host ?? "127.0.0.1", options.port ?? 9_765, options.realtimePort ?? 9_766);
  ensureOwnerDirectory(options.stateDirectory);
  return withLifecycleLock(options.stateDirectory, async () => {
  const lockedReceipt = existsSync(paths.receiptPath) ? parseReceipt(paths.receiptPath) : null;
  if ((lockedReceipt?.generation ?? null) !== (receipt?.generation ?? null) || (lockedReceipt?.status ?? null) !== (receipt?.status ?? null)) throw new Error("receipt changed before lifecycle lock acquisition; retry from fresh status");
  writeOwnerJson(paths.journalPath, { version: 1, action: options.action, state: "applying", receiptGeneration: receipt?.generation ?? null, recovery: "receipt is authoritative; inspect quarantine before retrying" });
  try {

  if (options.action === "install") {
    if (receipt && receipt.status !== "uninstalled") throw new Error("installation already exists; use upgrade or repair");
    if (existsSync(paths.remoteScriptDirectory) || existsSync(paths.configPath)) throw new Error("unowned destination content exists; adopt it manually or choose an empty lifecycle root");
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 9_765;
    const realtimePort = options.realtimePort ?? 9_766;
    let remoteBackup: string | null = null;
    let secretCreated = false;
    let configCreated = false;
    try {
      if (!existsSync(paths.secretPath)) { writeSecretFile(paths.secretPath, generateSecret()); secretCreated = true; }
      else readSecretFile(paths.secretPath);
      fault(options, "after-secret");
      const entrypoint = join(options.packageRoot, "dist", "src", "cli.js");
      const config = configForBridge(entrypoint, { host, port, realtimePort, secretFile: paths.secretPath, timeoutMs: options.timeoutMs ?? 5_000 }, process.execPath, paths.configPath);
      writeConfig(paths.configPath, config, false); configCreated = true;
      fault(options, "after-config");
      const source = join(options.packageRoot, "remote-script", REMOTE_PACKAGE, REMOTE_MODULE);
      const installed = installRemoteScript(source, paths.remoteScriptDirectory, { configPath: paths.configPath });
      remoteBackup = installed.backup;
      fault(options, "after-remote");
      const remoteFiles = hashRegularTree(paths.remoteScriptDirectory);
      assertPackageStillBound(options.packageRoot, packageEvidence!, options.allowDirtyPrivateBuild === true);
      const next: LifecycleReceipt = {
        version: 1, status: "installed-restart-required", generation: (receipt?.generation ?? 0) + 1, platform,
        packageRoot: options.packageRoot, packageVersion: packageEvidence!.manifest.package.version, artifactSha256: artifactSha256!, releaseManifestSha256: packageEvidence!.manifestSha256,
        registryHash: packageEvidence!.manifest.protocol.registryHash, stateDirectory: options.stateDirectory, remoteScriptsDirectory: options.remoteScriptsDirectory, remoteScriptDirectory: paths.remoteScriptDirectory, remoteFiles,
        configPath: paths.configPath, config, configSha256: fileDigest(paths.configPath), secretPath: paths.secretPath, secretCreatedByLifecycle: secretCreated || receipt?.secretCreatedByLifecycle === true,
        previous: null, activation: { required: true, realLiveVerified: false, provenance: "unavailable", remediation: "Restart Live, select AbletonMcpBridge as a Control Surface, then run activate." }, lastAction: "install",
      };
      fault(options, "before-receipt");
      writeOwnerJson(paths.receiptPath, next);
      const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "install", state: "completed", generation: next.generation });
      result.applied = true; result.state = "completed"; result.restartRequired = true; result.verification = { packageVersion: next.packageVersion, artifactSha256: next.artifactSha256, releaseManifestSha256: next.releaseManifestSha256, registryHash: next.registryHash, remoteFiles: Object.keys(remoteFiles).length, configSha256: next.configSha256, configPermissions: secretPermissions(paths.configPath), secretPermissions: secretPermissions(paths.secretPath), portsAvailableAtPreflight: true, journalFinalized }; result.instructions = [next.activation.remediation]; completeSteps(result); return result;
    } catch (error) {
      restoreBackup(paths.remoteScriptDirectory, remoteBackup);
      if (configCreated && existsSync(paths.configPath)) rmSync(paths.configPath, { force: true });
      if (secretCreated && existsSync(paths.secretPath)) rmSync(paths.secretPath, { force: true });
      tryWriteOwnerJson(paths.journalPath, { version: 1, action: "install", state: "failed-rolled-back", reason: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  }

  if (!receipt || (receipt.status === "uninstalled" && options.action !== "uninstall")) throw new Error("an active installation receipt is required");
  if (options.action === "upgrade") {
    if (compareVersions(packageEvidence!.manifest.package.version, receipt.packageVersion) <= 0) throw new Error("upgrade requires a strictly newer semantic package version; use rollback for a prior retained generation");
    if (artifactSha256 === receipt.artifactSha256 && packageEvidence!.manifestSha256 === receipt.releaseManifestSha256) throw new Error("candidate is already installed; use repair");
    const currentDrift = verifyFiles(paths.remoteScriptDirectory, receipt.remoteFiles);
    if (!currentDrift.valid || fileDigest(paths.configPath) !== receipt.configSha256 || secretPermissions(paths.configPath) !== "owner-only" || secretPermissions(paths.secretPath) !== "owner-only") throw new Error("current generation is drifted; repair or resolve it before upgrade");
    if (receipt.previous) {
      const priorRelative = relative(options.stateDirectory, receipt.previous.remoteBackup);
      if (priorRelative.startsWith("..") || isAbsolute(priorRelative) || !verifyFiles(receipt.previous.remoteBackup, receipt.previous.remoteFiles).valid) throw new Error("retained rollback generation is outside owner state or drifted");
    }
    const currentConfig = readAnyConfig(paths.configPath);
    if (!("bridge" in currentConfig)) throw new Error("managed bridge config is invalid");
    let backup: string | null = null;
    try {
      const nextConfig = configForBridge(join(options.packageRoot, "dist", "src", "cli.js"), currentConfig.bridge, process.execPath, paths.configPath);
      writeConfig(paths.configPath, nextConfig, true);
      fault(options, "before-remote");
      const installed = installRemoteScript(join(options.packageRoot, "remote-script", REMOTE_PACKAGE, REMOTE_MODULE), paths.remoteScriptDirectory, { force: true, configPath: paths.configPath });
      backup = installed.backup;
      if (backup) { const ownerBackup = quarantinePath(options.stateDirectory, "rollback-generation"); renameSync(backup, ownerBackup); backup = ownerBackup; }
      fault(options, "after-remote");
      if (!backup) throw new Error("upgrade did not retain a previous Remote Script generation");
      assertPackageStillBound(options.packageRoot, packageEvidence!, options.allowDirtyPrivateBuild === true);
      const previous: PreviousGeneration = { packageRoot: receipt.packageRoot, packageVersion: receipt.packageVersion, artifactSha256: receipt.artifactSha256, releaseManifestSha256: receipt.releaseManifestSha256, registryHash: receipt.registryHash, remoteBackup: backup, remoteFiles: receipt.remoteFiles, config: receipt.config, configSha256: receipt.configSha256 };
      const retiredPreviousBackup = receipt.previous?.remoteBackup && receipt.previous.remoteBackup !== backup ? receipt.previous.remoteBackup : null;
      const priorPending = receipt.retained?.pendingCleanup ?? []; const preserved = receipt.retained?.preserved ?? [];
      const pendingBeforeCleanup = [...new Set([...priorPending, ...(retiredPreviousBackup ? [retiredPreviousBackup] : [])])];
      const next: LifecycleReceipt = { ...receipt, status: "installed-restart-required", generation: receipt.generation + 1, packageRoot: options.packageRoot, packageVersion: packageEvidence!.manifest.package.version, artifactSha256: artifactSha256!, releaseManifestSha256: packageEvidence!.manifestSha256, registryHash: packageEvidence!.manifest.protocol.registryHash, remoteFiles: hashRegularTree(paths.remoteScriptDirectory), config: nextConfig, configSha256: fileDigest(paths.configPath), previous, retained: { pendingCleanup: pendingBeforeCleanup, preserved }, activation: { required: true, realLiveVerified: false, provenance: "unavailable", remediation: "Restart Live and run activate; rollback remains available." }, lastAction: "upgrade" };
      fault(options, "before-receipt");
      writeOwnerJson(paths.receiptPath, next);
      const retiredPreviousBackupRemoved = retiredPreviousBackup ? options.faultAt === "retired-cleanup-blocked" ? false : tryRemove(retiredPreviousBackup, true) : true;
      const pendingCleanup = retiredPreviousBackupRemoved && retiredPreviousBackup ? pendingBeforeCleanup.filter((path) => path !== retiredPreviousBackup) : pendingBeforeCleanup;
      const retentionFinalized = tryWriteOwnerJson(paths.receiptPath, { ...next, retained: { pendingCleanup, preserved } });
      const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "upgrade", state: "completed", generation: next.generation, pendingCleanup, preserved });
      result.applied = true; result.state = "completed"; result.recovery.rollbackAvailable = true; result.recovery.quarantine = preserved[0] ?? pendingCleanup[0]; result.verification = { artifactSha256: next.artifactSha256, previousArtifactSha256: previous.artifactSha256, remoteFiles: Object.keys(next.remoteFiles).length, retiredPreviousBackupRemoved, pendingCleanup, retentionFinalized, journalFinalized }; result.instructions = [next.activation.remediation]; completeSteps(result); return result;
    } catch (error) {
      if (backup) restoreBackup(paths.remoteScriptDirectory, backup);
      writeConfig(paths.configPath, receipt.config, true);
      tryWriteOwnerJson(paths.journalPath, { version: 1, action: "upgrade", state: "failed-rolled-back", reason: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  }

  if (options.action === "repair") {
    const drift = verifyFiles(paths.remoteScriptDirectory, receipt.remoteFiles);
    const configValid = existsSync(paths.configPath) && fileDigest(paths.configPath) === receipt.configSha256 && secretPermissions(paths.configPath) === "owner-only";
    const permissionsValid = existsSync(paths.secretPath) && secretPermissions(paths.secretPath) === "owner-only";
    if (drift.valid && configValid && permissionsValid) {
      const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "repair", state: "completed", generation: receipt.generation, changed: false });
      result.applied = true; result.state = "completed"; result.verification = { changed: false, remoteScript: drift, configValid, permissionsValid, journalFinalized }; result.steps = result.steps.map((step) => ({ ...step, status: step.id === "inspect" || step.id === "verify" ? "completed" : "skipped" })); return result;
    }
    if (!existsSync(paths.secretPath)) throw new Error("managed secret is missing; repair refuses to manufacture new bridge authority");
    let remoteQuarantine: string | undefined;
    let configQuarantine: string | undefined;
    try {
      if (existsSync(paths.remoteScriptDirectory)) { remoteQuarantine = quarantinePath(options.stateDirectory, "repair-remote"); renameSync(paths.remoteScriptDirectory, remoteQuarantine); }
      if (existsSync(paths.configPath) && !configValid) { configQuarantine = quarantinePath(options.stateDirectory, "repair-config"); renameSync(paths.configPath, configQuarantine); }
      if (!permissionsValid) {
        if (platform !== "win32") chmodSync(paths.secretPath, 0o600);
        secureWindowsFile(paths.secretPath);
        if (secretPermissions(paths.secretPath) !== "owner-only") throw new Error("repair could not restore owner-only secret permissions");
      }
      writeConfig(paths.configPath, receipt.config, existsSync(paths.configPath));
      installRemoteScript(join(options.packageRoot, "remote-script", REMOTE_PACKAGE, REMOTE_MODULE), paths.remoteScriptDirectory, { configPath: paths.configPath });
      fault(options, "after-repair-install");
      assertPackageStillBound(options.packageRoot, packageEvidence!, options.allowDirtyPrivateBuild === true);
      const next: LifecycleReceipt = { ...receipt, generation: receipt.generation + 1, remoteFiles: hashRegularTree(paths.remoteScriptDirectory), configSha256: fileDigest(paths.configPath), status: "installed-restart-required", activation: { required: true, realLiveVerified: false, provenance: "unavailable", remediation: "Restart Live and rerun activate after repair." }, lastAction: "repair" };
      writeOwnerJson(paths.receiptPath, next); const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "repair", state: "completed", generation: next.generation, quarantine: { remote: remoteQuarantine ?? null, config: configQuarantine ?? null } });
      result.applied = true; result.state = "completed"; result.restartRequired = true; result.recovery.quarantine = remoteQuarantine ?? configQuarantine; result.verification = { changed: true, priorDrift: drift, configRepaired: !configValid, secretPermissions: secretPermissions(paths.secretPath), repairedRemoteFiles: Object.keys(next.remoteFiles).length, configQuarantine: configQuarantine ?? null, journalFinalized }; result.instructions = [next.activation.remediation]; completeSteps(result); return result;
    } catch (error) {
      if (existsSync(paths.remoteScriptDirectory)) rmSync(paths.remoteScriptDirectory, { recursive: true, force: true });
      if (remoteQuarantine && existsSync(remoteQuarantine)) renameSync(remoteQuarantine, paths.remoteScriptDirectory);
      if (configQuarantine && existsSync(configQuarantine)) { if (existsSync(paths.configPath)) rmSync(paths.configPath, { force: true }); renameSync(configQuarantine, paths.configPath); }
      else if (!configValid && existsSync(paths.configPath)) rmSync(paths.configPath, { force: true });
      tryWriteOwnerJson(paths.journalPath, { version: 1, action: "repair", state: "failed-rolled-back", reason: error instanceof Error ? error.message : "unknown", quarantine: { remote: remoteQuarantine ?? null, config: configQuarantine ?? null } });
      throw error;
    }
  }

  if (options.action === "rollback") {
    if (!receipt.previous || !existsSync(receipt.previous.remoteBackup)) throw new Error("no verified previous generation is available");
    const current = verifyFiles(paths.remoteScriptDirectory, receipt.remoteFiles);
    if (!current.valid || !existsSync(paths.configPath) || fileDigest(paths.configPath) !== receipt.configSha256 || secretPermissions(paths.configPath) !== "owner-only" || secretPermissions(paths.secretPath) !== "owner-only") throw new Error("current generation is drifted; repair or preserve it before rollback");
    assertNoLinkedAncestors(receipt.previous.remoteBackup);
    const previousPackage = verifyReleasePackage(receipt.previous.packageRoot, options.allowDirtyPrivateBuild === true);
    if (previousPackage.manifestSha256 !== receipt.previous.releaseManifestSha256 || previousPackage.manifest.protocol.registryHash !== receipt.previous.registryHash) throw new Error("previous package root is unavailable or differs from the retained generation");
    const failedGeneration = quarantinePath(options.stateDirectory, "rolled-back-generation");
    renameSync(paths.remoteScriptDirectory, failedGeneration);
    try {
      renameSync(receipt.previous.remoteBackup, paths.remoteScriptDirectory);
      const verified = verifyFiles(paths.remoteScriptDirectory, receipt.previous.remoteFiles);
      if (!verified.valid) throw new Error("previous Remote Script generation failed hash verification");
      writeConfig(paths.configPath, receipt.previous.config, true);
      const next: LifecycleReceipt = { ...receipt, status: "installed-restart-required", generation: receipt.generation + 1, packageRoot: receipt.previous.packageRoot, packageVersion: receipt.previous.packageVersion, artifactSha256: receipt.previous.artifactSha256, releaseManifestSha256: receipt.previous.releaseManifestSha256, registryHash: receipt.previous.registryHash, remoteFiles: receipt.previous.remoteFiles, config: receipt.previous.config, configSha256: fileDigest(paths.configPath), previous: { packageRoot: receipt.packageRoot, packageVersion: receipt.packageVersion, artifactSha256: receipt.artifactSha256, releaseManifestSha256: receipt.releaseManifestSha256, registryHash: receipt.registryHash, remoteBackup: failedGeneration, remoteFiles: receipt.remoteFiles, config: receipt.config, configSha256: receipt.configSha256 }, activation: { required: true, realLiveVerified: false, provenance: "unavailable", remediation: "Restart Live and run activate after rollback." }, lastAction: "rollback" };
      writeOwnerJson(paths.receiptPath, next); const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "rollback", state: "completed", generation: next.generation });
      result.applied = true; result.state = "completed"; result.recovery.rollbackAvailable = true; result.recovery.quarantine = failedGeneration; result.verification = { artifactSha256: next.artifactSha256, remoteScript: verified, journalFinalized }; result.instructions = [next.activation.remediation]; completeSteps(result); return result;
    } catch (error) {
      if (existsSync(paths.remoteScriptDirectory)) renameSync(paths.remoteScriptDirectory, receipt.previous.remoteBackup);
      if (existsSync(failedGeneration)) renameSync(failedGeneration, paths.remoteScriptDirectory);
      throw error;
    }
  }

  if (options.action === "uninstall") {
    if (options.purgeSecret && !receipt.secretCreatedByLifecycle) throw new Error("refusing to purge a secret not created by this lifecycle");
    const removeRetained = (items: string[]) => items.filter((path) => {
      const relativePath = relative(options.stateDirectory, path);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) return true;
      assertNoLinkedAncestors(path);
      if (!existsSync(path)) return false;
      return !tryRemove(path, lstatSync(path).isDirectory());
    });
    if (receipt.status === "uninstalled") {
      const preserved = [...(receipt.retained?.preserved ?? [])];
      const pending = [...(receipt.retained?.pendingCleanup ?? [])];
      if (options.purgeSecret && existsSync(paths.secretPath)) { readSecretFile(paths.secretPath); const staged = quarantinePath(options.stateDirectory, "uninstall-delete-secret"); renameSync(paths.secretPath, staged); pending.push(staged); }
      const pendingCleanup = removeRetained(pending);
      const next: LifecycleReceipt = { ...receipt, generation: receipt.generation + 1, secretCreatedByLifecycle: options.purgeSecret ? false : receipt.secretCreatedByLifecycle, retained: { pendingCleanup, preserved }, lastAction: "uninstall" };
      writeOwnerJson(paths.receiptPath, next);
      const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "uninstall", state: "completed", generation: next.generation, pendingCleanup, preserved });
      result.applied = true; result.state = "completed"; result.recovery.quarantine = preserved[0] ?? pendingCleanup[0]; result.verification = { alreadyUninstalled: true, pendingCleanup, preserved, secretPurged: options.purgeSecret === true, journalFinalized }; result.instructions = ["Inspect preserved quarantine content; remove the npm package only after clients are updated."]; completeSteps(result); return result;
    }
    const drift = verifyFiles(paths.remoteScriptDirectory, receipt.remoteFiles);
    const configMatches = existsSync(paths.configPath) && fileDigest(paths.configPath) === receipt.configSha256 && secretPermissions(paths.configPath) === "owner-only";
    const remoteStaged = existsSync(paths.remoteScriptDirectory) ? quarantinePath(options.stateDirectory, drift.valid ? "uninstall-delete-remote" : "uninstall-preserved") : undefined;
    const configStaged = configMatches ? quarantinePath(options.stateDirectory, "uninstall-delete-config") : undefined;
    const secretStaged = options.purgeSecret && existsSync(paths.secretPath) ? quarantinePath(options.stateDirectory, "uninstall-delete-secret") : undefined;
    const previousDrift = receipt.previous && existsSync(receipt.previous.remoteBackup) ? verifyFiles(receipt.previous.remoteBackup, receipt.previous.remoteFiles) : null;
    let receiptCommitted = false;
    try {
      if (secretStaged) readSecretFile(paths.secretPath);
      if (remoteStaged) renameSync(paths.remoteScriptDirectory, remoteStaged);
      if (configStaged) renameSync(paths.configPath, configStaged);
      if (secretStaged) renameSync(paths.secretPath, secretStaged);
      const preserved = [...new Set([...(receipt.retained?.preserved ?? []), !drift.valid ? remoteStaged : undefined, previousDrift && !previousDrift.valid ? receipt.previous?.remoteBackup : undefined].filter((path): path is string => Boolean(path)))];
      const pending = [...new Set([...(receipt.retained?.pendingCleanup ?? []), drift.valid ? remoteStaged : undefined, configStaged, secretStaged, previousDrift?.valid ? receipt.previous?.remoteBackup : undefined].filter((path): path is string => Boolean(path)))];
      const initial: LifecycleReceipt = { ...receipt, status: "uninstalled", generation: receipt.generation + 1, secretCreatedByLifecycle: options.purgeSecret ? false : receipt.secretCreatedByLifecycle, previous: null, retained: { pendingCleanup: pending, preserved }, activation: { required: false, realLiveVerified: false, provenance: "unavailable", remediation: "Remove the npm package separately after clients stop using it." }, lastAction: "uninstall" };
      writeOwnerJson(paths.receiptPath, initial); receiptCommitted = true;
      const pendingCleanup = removeRetained(pending);
      const next: LifecycleReceipt = { ...initial, retained: { pendingCleanup, preserved } };
      writeOwnerJson(paths.receiptPath, next);
      const quarantine = preserved[0] ?? pendingCleanup[0];
      const journalFinalized = tryWriteOwnerJson(paths.journalPath, { version: 1, action: "uninstall", state: "completed", generation: next.generation, quarantine: quarantine ?? null, pendingCleanup, preserved });
      result.applied = true; result.state = "completed"; result.recovery.quarantine = quarantine; result.verification = { priorDrift: drift, priorGenerationDrift: previousDrift, remoteRemoved: !existsSync(paths.remoteScriptDirectory), configRemoved: configMatches, configPreservedBecauseModified: existsSync(paths.configPath), secretPurged: options.purgeSecret === true, secretPreserved: options.purgeSecret !== true, pendingCleanup, preserved, journalFinalized }; result.instructions = ["Restart Live to unload the removed Control Surface.", "Inspect preserved quarantine content, then remove the npm package only after every client configuration is updated."]; completeSteps(result); return result;
    } catch (error) {
      if (!receiptCommitted) {
        if (secretStaged && existsSync(secretStaged) && !existsSync(paths.secretPath)) renameSync(secretStaged, paths.secretPath);
        if (configStaged && existsSync(configStaged) && !existsSync(paths.configPath)) renameSync(configStaged, paths.configPath);
        if (remoteStaged && existsSync(remoteStaged) && !existsSync(paths.remoteScriptDirectory)) renameSync(remoteStaged, paths.remoteScriptDirectory);
      }
      throw error;
    }
  }

  throw new Error("lifecycle action was not handled");
  } catch (error) {
    finalizeFailedJournal(paths.journalPath, options.action, receipt?.generation ?? null, error);
    throw error;
  }
  });
}
