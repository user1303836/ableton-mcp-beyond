import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, versions } from "node:process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LiveStatus } from "./live.js";

export const CONFIG_VERSION = 1;
export const BRIDGE_CONFIG_VERSION = 2;
export const MIN_NODE_MAJOR = 22;
export const SUPPORTED_NODE_MAJORS = [22, 24, 25] as const;
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const REMOTE_SCRIPT_ASSET = "ableton_mcp_remote_script.py";
export const REMOTE_SCRIPT_PACKAGE = "AbletonMcpBridge";
export const OPERATION_REGISTRY_ASSET = "ableton-live-v1.operations.json";

export interface ServerConfig {
  version: 1;
  server: { command: string; args: string[] };
}

export interface BridgeConfig {
  version: 2;
  server: { command: string; args: string[] };
  bridge: { host: string; port: number; secretFile: string; timeoutMs: number; realtimePort?: number };
}

type LiveStatusWithRegistry = { registryHash?: unknown; provenance?: unknown };

export interface DiagnosticReport {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  nodeSupported: boolean;
  platformSupported: boolean;
  packageRoot: string;
  entrypoint: { path: string; present: boolean };
  config: { path: string | null; present: boolean; valid: boolean };
  hostReady: boolean;
  remoteScriptInstalled: boolean;
  bridgeConfigured: boolean;
  packageAssetsValid: boolean;
  secretPermissions: "owner-only" | "unavailable" | "invalid";
  authenticatedReachable: boolean;
  roundTripLatency: number | null;
  adapterProtocol: string | null;
  adapterEpoch: number | null;
  adapterOperations: string[];
  registryHash: string | null;
  discoveryKinds: string[];
  provenance: "real-live" | "fake-live" | "simulator" | "unknown";
  discoveryReachable: boolean;
  liveConnected: boolean;
  simulator: boolean;
  evidence: "local-contract" | "authenticated-bridge" | "unavailable";
  external: {
    abletonLive: "unavailable" | "verified";
    signing: "unavailable";
    notarization: "unavailable";
  };
  readiness: { package: boolean; configured: boolean; authenticatedBridge: boolean; realLiveOperational: boolean; releaseCertified: false };
  diagnosticErrors: string[];
  /** Compatibility summary: true only for authenticated real-Live operation. */
  ready: boolean;
}

function validateLoopback(host: string): void {
  const ipv4Loopback = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host) && host.split(".").slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
  if (!(ipv4Loopback || host === "::1" || host === "localhost")) throw new Error("bridge host must be loopback");
}

function validateSecretPath(path: string): void {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("secret file must be an absolute safe path");
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("secret file must not be a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const WINDOWS_ACL_REASONS: Readonly<Record<number, string>> = {
  2: "file owner is not the current process token",
  3: "DACL inheritance protection is disabled",
  4: "DACL does not contain exactly one access rule",
  5: "an access rule references a non-owner SID",
  6: "an access rule is inherited",
  7: "an access rule is not an allow rule",
  8: "an access rule does not grant full control",
};

function windowsAclVerifyCommand(): string {
  return "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));" +
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;" +
    "$c=[System.IO.File]::GetAccessControl($p);" +
    "if ($c.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }" +
    "if (-not $c.AreAccessRulesProtected) { exit 3 }" +
    "$rules=@($c.Access); if ($rules.Count -ne 1) { exit 4 }" +
    "$rule=$rules[0];" +
    "if ($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 5 }" +
    "if ($rule.IsInherited) { exit 6 }" +
    "if ($rule.AccessControlType.ToString() -ne 'Allow') { exit 7 }" +
    "if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 8 }" +
    "exit 0";
}

/** Verify an owner-only Windows DACL through the security API without parsing localized or serialized output. */
function windowsOwnerOnlyAcl(path: string): { ok: true } | { ok: false; reason: string } {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsAclVerifyCommand()], {
    encoding: "utf8", env: { ...process.env, ABLETON_MCP_ACL_PATH: encodedPath }, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000,
  });
  if (result.error) return { ok: false, reason: "verification command could not run" };
  if (result.status === 0) return { ok: true };
  const known = result.status !== null ? WINDOWS_ACL_REASONS[result.status] : undefined;
  return { ok: false, reason: known ?? "verification command failed" };
}

export function secretPermissions(path: string): DiagnosticReport["secretPermissions"] {
  if (platform === "win32") {
    const verdict = windowsOwnerOnlyAcl(path);
    return verdict.ok ? "owner-only" : "invalid";
  }
  try {
    const entry = statSync(path);
    const mode = entry.mode & 0o777;
    if ((mode & 0o077) !== 0) return "invalid";
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) return "invalid";
    return "owner-only";
  } catch {
    return "invalid";
  }
}

export function secureWindowsFile(path: string): void {
  if (platform !== "win32") return;
  try {
    const encodedPath = Buffer.from(path, "utf8").toString("base64");
    // Build a fresh protected DACL from the process-token SID. This avoids
    // localized account names and cannot retain inherited or explicit broad ACEs.
    const script = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));" +
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;" +
      "$a=New-Object System.Security.AccessControl.FileSecurity;" +
      "$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);" +
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow);" +
      "[void]$a.AddAccessRule($rule);[System.IO.File]::SetAccessControl($p,$a)";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8", env: { ...process.env, ABLETON_MCP_ACL_PATH: encodedPath }, stdio: ["ignore", "pipe", "pipe"],
    });
    const verdict = windowsOwnerOnlyAcl(path);
    if (!verdict.ok) throw new Error(`Windows ACL verification rejected the applied descriptor: ${verdict.reason}`);
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.replaceAll(path, "<redacted-path>").replace(/\s+/g, " ").trim().slice(0, 512)
      : "";
    throw new Error(`could not establish an owner-only Windows ACL${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}

export function secureWindowsDirectory(path: string): void {
  if (platform !== "win32") return;
  try {
    const encodedPath = Buffer.from(path, "utf8").toString("base64");
    const script = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));" +
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;" +
      "$a=New-Object System.Security.AccessControl.DirectorySecurity;" +
      "$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);" +
      "$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';" +
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);" +
      "[void]$a.AddAccessRule($rule);[System.IO.Directory]::SetAccessControl($p,$a)";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", env: { ...process.env, ABLETON_MCP_ACL_PATH: encodedPath }, stdio: ["ignore", "pipe", "pipe"] });
    const verdict = windowsOwnerOnlyAcl(path);
    if (!verdict.ok) throw new Error(`Windows directory ACL verification rejected the applied descriptor: ${verdict.reason}`);
  } catch (error) {
    throw new Error("could not establish an owner-only Windows directory ACL", { cause: error });
  }
}

export function configForBridge(entrypoint: string, bridge: BridgeConfig["bridge"], nodeCommand = process.execPath, configPath?: string): BridgeConfig {
  if (Object.keys(bridge).some((key) => !["host", "port", "secretFile", "timeoutMs", "realtimePort"].includes(key))) throw new Error("unsupported bridge configuration fields");
  if (!isAbsolute(entrypoint)) throw new Error("entrypoint must be an absolute path");
  if (!Number.isInteger(bridge.port) || bridge.port < 1 || bridge.port > 65_535) throw new Error("bridge port must be between 1 and 65535");
  validateLoopback(bridge.host);
  validateSecretPath(bridge.secretFile);
  if (configPath !== undefined && (!isAbsolute(configPath) || configPath.includes("\0"))) throw new Error("configuration path must be absolute");
  if (!Number.isInteger(bridge.timeoutMs) || bridge.timeoutMs < 100 || bridge.timeoutMs > 60_000) throw new Error("bridge timeout must be between 100 and 60000 ms");
  if (bridge.realtimePort !== undefined && (!Number.isInteger(bridge.realtimePort) || bridge.realtimePort < 1 || bridge.realtimePort > 65_535 || bridge.realtimePort === bridge.port)) throw new Error("realtime port must be distinct and between 1 and 65535");
  if (typeof nodeCommand !== "string" || nodeCommand.length === 0) throw new Error("node command must be a non-empty string");
  return { version: 2, server: { command: nodeCommand, args: configPath ? [entrypoint, "--config", configPath] : [entrypoint] }, bridge: { ...bridge } };
}

export function generateSecret(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 32 || bytes > 128) throw new Error("secret size must be between 32 and 128 bytes");
  return randomBytes(bytes).toString("base64url");
}

export function writeSecretFile(path: string, secret = generateSecret()): void {
  validateSecretPath(path);
  if (secret.length < 32 || secret.includes("\n") || secret.includes("\r")) throw new Error("secret is invalid");
  const parent = dirname(path);
  if (!existsSync(parent)) throw new Error(`secret directory does not exist: ${parent}`);
  writeFileSync(path, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (platform !== "win32") chmodSync(path, 0o600);
  secureWindowsFile(path);
}

export function readSecretFile(path: string): string {
  validateSecretPath(path);
  const raw = readFileSync(path, "utf8");
  const secret = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw;
  if (secret.length === 0 || /\s/.test(secret) || secret.length < 32) throw new Error("secret file is invalid");
  if (secretPermissions(path) !== "owner-only") throw new Error("secret file permissions must be conclusively owner-only");
  return secret;
}

function parseConfig(value: unknown): ServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("configuration must be an object");
  const candidate = value as Record<string, unknown>;
  const server = candidate.server;
  if (Object.keys(candidate).some((key) => !["version", "server"].includes(key)) || candidate.version !== CONFIG_VERSION || typeof server !== "object" || server === null || Array.isArray(server)) throw new Error("unsupported configuration version");
  const serverObject = server as Record<string, unknown>;
  if (Object.keys(serverObject).some((key) => !["command", "args"].includes(key)) || typeof serverObject.command !== "string" || serverObject.command.length === 0 || !Array.isArray(serverObject.args) || !serverObject.args.every((arg) => typeof arg === "string")) throw new Error("invalid server configuration");
  return { version: 1, server: { command: serverObject.command, args: [...serverObject.args] } };
}

function parseBridgeConfig(value: unknown): BridgeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("configuration must be an object");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["version", "server", "bridge"].includes(key))) throw new Error("unsupported configuration fields");
  if (candidate.version !== BRIDGE_CONFIG_VERSION || typeof candidate.server !== "object" || candidate.server === null || typeof candidate.bridge !== "object" || candidate.bridge === null) throw new Error("unsupported configuration version");
  const server = candidate.server as Record<string, unknown>;
  const bridge = candidate.bridge as Record<string, unknown>;
  if (Object.keys(server).some((key) => !["command", "args"].includes(key)) || Object.keys(bridge).some((key) => !["host", "port", "secretFile", "timeoutMs", "realtimePort"].includes(key))) throw new Error("unsupported configuration fields");
  if (typeof server.command !== "string" || !server.command || !Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) throw new Error("invalid server configuration");
  if (typeof bridge.host !== "string" || typeof bridge.port !== "number" || typeof bridge.secretFile !== "string" || typeof bridge.timeoutMs !== "number" || (bridge.realtimePort !== undefined && typeof bridge.realtimePort !== "number")) throw new Error("invalid bridge configuration");
  if (server.args.length !== 3 || server.args[1] !== "--config" || !isAbsolute(server.args[2] ?? "")) throw new Error("version-2 server configuration must include --config PATH");
  const config = configForBridge(server.args[0] ?? "", { host: bridge.host, port: bridge.port, secretFile: bridge.secretFile, timeoutMs: bridge.timeoutMs, ...(bridge.realtimePort === undefined ? {} : { realtimePort: bridge.realtimePort }) }, server.command, server.args[2]);
  readSecretFile(config.bridge.secretFile);
  return config;
}

export function configForEntrypoint(entrypoint: string, nodeCommand = process.execPath): ServerConfig {
  if (!isAbsolute(entrypoint)) throw new Error("entrypoint must be an absolute path");
  if (typeof nodeCommand !== "string" || nodeCommand.length === 0) throw new Error("node command must be a non-empty string");
  return { version: 1, server: { command: nodeCommand, args: [entrypoint] } };
}

export function isSupportedPlatform(value: NodeJS.Platform = platform): boolean {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

export function supportedNodeMajor(value = versions.node): boolean {
  const major = Number.parseInt(value.split(".")[0] ?? "0", 10);
  return Number.isSafeInteger(major) && (SUPPORTED_NODE_MAJORS as readonly number[]).includes(major);
}

export function readConfig(path: string): ServerConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function readAnyConfig(path: string): ServerConfig | BridgeConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return value.version === BRIDGE_CONFIG_VERSION ? parseBridgeConfig(value) : parseConfig(value);
}

export function writeConfig(path: string, config: ServerConfig | BridgeConfig, force = false): void {
  config = config.version === BRIDGE_CONFIG_VERSION ? parseBridgeConfig(config) : parseConfig(config);
  let destinationExists = false;
  try {
    const destination = lstatSync(path);
    if (destination.isDirectory()) throw new Error(`refusing to replace configuration directory: ${path}`);
    destinationExists = destination.isFile() || destination.isSymbolicLink();
    if (destination.isSymbolicLink()) throw new Error(`refusing to write through symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (destinationExists) {
    if (!force) throw new Error(`refusing to overwrite existing file: ${path}`);
  }
  const parent = dirname(path);
  if (!existsSync(parent)) throw new Error(`configuration directory does not exist: ${parent}`);
  const temporaryDirectory = mkdtempSync(join(parent, `.ableton-mcp-${randomUUID()}-`));
  const temporaryPath = join(temporaryDirectory, "config.json");
  const backupPath = join(temporaryDirectory, "previous.json");
  let backedUp = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (platform !== "win32") chmodSync(temporaryPath, 0o600);
    secureWindowsFile(temporaryPath);
    if (destinationExists && force) {
      // Windows does not let renameSync replace an existing file. Moving the
      // old file beside the staged file keeps replacement explicit and lets us
      // restore it if the second rename fails.
      renameSync(path, backupPath);
      backedUp = true;
    }
    renameSync(temporaryPath, path);
    if (backedUp) unlinkSync(backupPath);
  } finally {
    if (backedUp && !existsSync(path)) {
      try { renameSync(backupPath, path); } catch { /* preserve the original error */ }
    }
    try { unlinkSync(temporaryPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { unlinkSync(backupPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { rmdirSync(temporaryDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export interface BridgeMigrationOptions { host: string; port: number; secretFile: string; timeoutMs: number; realtimePort?: number }

export function migrateConfig(inputPath: string, outputPath: string, force = false, bridge?: BridgeMigrationOptions): ServerConfig | BridgeConfig {
  const source = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  let config: ServerConfig | BridgeConfig;
  if (typeof source === "object" && source !== null && !Array.isArray(source) && (source as Record<string, unknown>).version === BRIDGE_CONFIG_VERSION) config = parseBridgeConfig(source);
  else if (typeof source === "object" && source !== null && !Array.isArray(source) && (source as Record<string, unknown>).version === CONFIG_VERSION) config = parseConfig(source);
  else if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const legacy = source as Record<string, unknown>; const command = legacy.command; const args = legacy.args;
    if (typeof command !== "string" || command.length === 0 || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("legacy configuration must contain command and string args");
    config = { version: 1, server: { command, args: [...args] } };
  } else throw new Error("configuration must be an object");
  if (bridge) {
    const entrypoint = config.server.args[0];
    if (!entrypoint || !isAbsolute(entrypoint)) throw new Error("version-2 migration requires an absolute server entrypoint as the first argument");
    readSecretFile(bridge.secretFile);
    config = configForBridge(entrypoint, bridge, config.server.command, outputPath);
  }
  writeConfig(outputPath, config, force);
  return config;
}

export interface InstallResult { installed: string; backup: string | null; reference: string | null; dryRun: boolean; }

export function writeBridgeReference(path: string, configPath: string, force = false): void {
  if (!isAbsolute(path) || !isAbsolute(configPath) || path.includes("\0") || configPath.includes("\0")) throw new Error("bridge reference paths must be absolute");
  if (lstatSync(configPath).isSymbolicLink() || !statSync(configPath).isFile()) throw new Error("bridge configuration must be a regular file");
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !force) throw new Error(`refusing to overwrite existing bridge reference: ${path}`);
  }
  const parent = dirname(path);
  if (!existsSync(parent)) throw new Error(`configuration directory does not exist: ${parent}`);
  writeFileSync(path, `${JSON.stringify({ config: configPath })}\n`, { encoding: "utf8", mode: 0o600, flag: force ? "w" : "wx" });
  if (platform !== "win32") chmodSync(path, 0o600);
  secureWindowsFile(path);
}

function operationRegistrySource(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(base, "../../../protocol", OPERATION_REGISTRY_ASSET), resolve(base, "../../../../protocol", OPERATION_REGISTRY_ASSET), resolve(base, "../..", "remote-script", REMOTE_SCRIPT_PACKAGE, OPERATION_REGISTRY_ASSET)];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) throw new Error("operation registry is unavailable");
  return candidate;
}

function copyOperationRegistry(destination: string): void {
  const source = operationRegistrySource();
  if (!lstatSync(source).isFile()) throw new Error("operation registry is unavailable");
  copyFileSync(source, destination);
}

export function registryDigest(): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
    }
    throw new Error("operation registry contains an unsupported value");
  };
  return createHash("sha256").update(canonical(JSON.parse(readFileSync(operationRegistrySource(), "utf8")))).digest("hex");
}

export function rejectSymlinkTree(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`refusing symbolic-link destination: ${path}`);
  if (entry.isDirectory()) for (const child of readdirSync(path)) rejectSymlinkTree(join(path, child));
}

export function installRemoteScript(sourceFile: string, destinationDirectory: string, options: { dryRun?: boolean; force?: boolean; configPath?: string } = {}): InstallResult {
  if (!isAbsolute(sourceFile) || !isAbsolute(destinationDirectory)) throw new Error("installer paths must be absolute");
  const source = lstatSync(sourceFile);
  if (!source.isFile() || source.isSymbolicLink()) throw new Error("Remote Script source must be a regular file");
  if (existsSync(destinationDirectory)) {
    rejectSymlinkTree(destinationDirectory);
    if (!options.force) throw new Error(`refusing to overwrite existing Remote Script: ${destinationDirectory}`);
  }
  const parent = dirname(destinationDirectory);
  if (!existsSync(parent)) throw new Error(`destination parent does not exist: ${parent}`);
  if (options.configPath !== undefined && !isAbsolute(options.configPath)) throw new Error("bridge configuration path must be absolute");
  const referencePath = options.configPath ? join(destinationDirectory, "bridge-reference.json") : null;
  if (options.dryRun) return { installed: destinationDirectory, backup: existsSync(destinationDirectory) ? `${destinationDirectory}.backup` : null, reference: referencePath, dryRun: true };
  const staging = mkdtempSync(join(parent, `.ableton-mcp-install-${randomUUID()}-`));
  const stagedPackage = join(staging, REMOTE_SCRIPT_PACKAGE);
  const backup = existsSync(destinationDirectory) ? `${destinationDirectory}.backup-${Date.now()}` : null;
  try {
    mkdirSync(stagedPackage);
    const stagedAsset = join(stagedPackage, REMOTE_SCRIPT_ASSET);
    copyFileSync(sourceFile, stagedAsset);
    if (platform !== "win32") chmodSync(stagedAsset, 0o600);
    const packageSource = basename(dirname(sourceFile)) === REMOTE_SCRIPT_PACKAGE ? dirname(sourceFile) : join(dirname(sourceFile), REMOTE_SCRIPT_PACKAGE);
    const init = join(packageSource, "__init__.py");
    if (!existsSync(init)) throw new Error("Remote Script package is missing __init__.py");
    copyFileSync(init, join(stagedPackage, "__init__.py"));
    const moduleSource = join(packageSource, REMOTE_SCRIPT_ASSET);
    if (existsSync(moduleSource)) copyFileSync(moduleSource, join(stagedPackage, REMOTE_SCRIPT_ASSET));
    else copyFileSync(sourceFile, join(stagedPackage, REMOTE_SCRIPT_ASSET));
    copyOperationRegistry(join(stagedPackage, OPERATION_REGISTRY_ASSET));
    const files = ["__init__.py", REMOTE_SCRIPT_ASSET, OPERATION_REGISTRY_ASSET] as const;
    const hashes = Object.fromEntries(files.map((name) => [name, createHash("sha256").update(readFileSync(join(stagedPackage, name))).digest("hex")]));
    writeFileSync(join(stagedPackage, "manifest.json"), `${JSON.stringify({ package: REMOTE_SCRIPT_PACKAGE, algorithm: "sha256", registryHash: registryDigest(), files: hashes })}\n`, { mode: 0o600, flag: "wx" });
    // Python writes bytecode only beneath a directory named __pycache__. A
    // receipt-bound regular file at that exact path blocks unverified runtime
    // code generation on every platform without relying on process-wide env.
    writeFileSync(join(stagedPackage, "__pycache__"), "", { mode: 0o400, flag: "wx" });
    if (referencePath && options.configPath) writeBridgeReference(join(stagedPackage, "bridge-reference.json"), options.configPath);
    if (backup) renameSync(destinationDirectory, backup);
    renameSync(stagedPackage, destinationDirectory);
    return { installed: destinationDirectory, backup, reference: referencePath, dryRun: false };
  } catch (error) {
    if (backup && !existsSync(destinationDirectory) && existsSync(backup)) renameSync(backup, destinationDirectory);
    throw error;
  } finally {
    // Cleanup must never override the authoritative replacement/rollback result.
    // A denied removal can leave only this uniquely named staging directory;
    // callers verify the destination and report filesystem residue separately.
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* preserve the primary transaction outcome */ }
  }
}

export function diagnostics(packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), configPath?: string): DiagnosticReport {
  const entrypoint = join(packageRoot, "dist", "src", "cli.js");
  let configValid = false;
  if (configPath && existsSync(configPath)) {
    try { readAnyConfig(configPath); configValid = true; } catch { configValid = false; }
  }
  const entrypointPresent = existsSync(entrypoint) && statSync(entrypoint).isFile();
  const hostReady = supportedNodeMajor() && isSupportedPlatform() && entrypointPresent;
  const remoteScriptInstalled = existsSync(join(packageRoot, "remote-script", REMOTE_SCRIPT_PACKAGE, "__init__.py")) && existsSync(join(packageRoot, "remote-script", REMOTE_SCRIPT_PACKAGE, REMOTE_SCRIPT_ASSET));
  const packageDirectory = join(packageRoot, "remote-script", REMOTE_SCRIPT_PACKAGE);
  let packageAssetsValid = false;
  try {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "manifest.json"), "utf8")) as { algorithm?: string; registryHash?: string; files?: Record<string, string> };
    packageAssetsValid = manifest.algorithm === "sha256" && manifest.registryHash === registryDigest() && ["__init__.py", REMOTE_SCRIPT_ASSET, OPERATION_REGISTRY_ASSET].every((name) => manifest.files?.[name] === createHash("sha256").update(readFileSync(join(packageDirectory, name))).digest("hex"));
  } catch { packageAssetsValid = false; }
  let bridgeConfigured = false;
  let permissions: DiagnosticReport["secretPermissions"] = "unavailable";
  if (configValid && configPath) {
    try { const config = readAnyConfig(configPath); bridgeConfigured = "bridge" in config && readSecretFile((config as BridgeConfig).bridge.secretFile).length >= 32; permissions = "bridge" in config ? secretPermissions((config as BridgeConfig).bridge.secretFile) : "unavailable"; } catch { bridgeConfigured = false; permissions = "invalid"; }
  }
  return {
    platform,
    arch: process.arch,
    node: versions.node,
    nodeSupported: supportedNodeMajor(),
    platformSupported: isSupportedPlatform(),
    packageRoot,
    entrypoint: { path: entrypoint, present: entrypointPresent },
    config: { path: configPath ?? null, present: configPath ? existsSync(configPath) : false, valid: configValid },
    hostReady,
    remoteScriptInstalled,
    bridgeConfigured,
    packageAssetsValid,
    secretPermissions: permissions,
    authenticatedReachable: false,
    roundTripLatency: null,
    adapterProtocol: null,
    adapterEpoch: null,
    adapterOperations: [],
    registryHash: null,
    discoveryKinds: [],
    provenance: "unknown",
    discoveryReachable: false,
    liveConnected: false,
    simulator: false,
    evidence: hostReady ? "local-contract" : "unavailable",
    external: { abletonLive: "unavailable", signing: "unavailable", notarization: "unavailable" },
    readiness: { package: hostReady && packageAssetsValid, configured: bridgeConfigured, authenticatedBridge: false, realLiveOperational: false, releaseCertified: false },
    diagnosticErrors: [],
    ready: false,
  };
}

/**
 * Performs the only active delivery probe: an authenticated, read-only status
 * handshake. A failed or unavailable endpoint remains negative evidence.
 */
export async function diagnosticsAsync(packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), configPath?: string): Promise<DiagnosticReport> {
  const report = diagnostics(packageRoot, configPath);
  if (!report.bridgeConfigured || !configPath) return report;
  try {
    const { RemoteScriptLiveAdapter } = await import("./bridge/remote-adapter.js");
    const config = readAnyConfig(configPath);
    if (!("bridge" in config)) return report;
    const started = performance.now();
    const adapter = await RemoteScriptLiveAdapter.connect({ ...config.bridge, secret: readSecretFile(config.bridge.secretFile) });
    try {
      const status = adapter.status();
      const operations = [...(status.operations ?? [])];
      if (!operations.includes("discover") || !operations.includes("session.playback")) throw new Error("required read-only discovery operations are unavailable");
      const discoveredKinds: string[] = [];
      const discover = async (kind: import("./live.js").LiveDiscoveryKind, parent?: string) => {
        const result = await adapter.discoverAsync({ kind, parent, limit: 16, budget: 256 });
        if (!Array.isArray(result.items)) throw new Error(`bounded ${kind} discovery returned no result`);
        discoveredKinds.push(kind);
        return result.items;
      };
      await discover("set");
      const scenes = await discover("scene");
      const tracks = await discover("track");
      await discover("session-playback");
      const firstTrack = tracks.find((item) => typeof item.ref === "string");
      if (firstTrack) await discover("clip-slot", firstTrack.ref as string);
      if (scenes.length === 0) throw new Error("scene discovery returned no authoritative scenes");
      const statusWithEvidence = status as LiveStatus & LiveStatusWithRegistry;
      const provenance = statusWithEvidence.provenance === "real-live" ? "real-live" : statusWithEvidence.adapter === "simulator" ? "simulator" : statusWithEvidence.adapter === "remote-script" ? "fake-live" : "unknown";
      return {
        ...report,
        authenticatedReachable: true,
        roundTripLatency: Number((performance.now() - started).toFixed(3)),
        adapterProtocol: status.protocol,
        adapterEpoch: status.epoch,
        adapterOperations: operations,
        registryHash: typeof (status as LiveStatusWithRegistry).registryHash === "string" ? (status as LiveStatusWithRegistry).registryHash as string : null,
        discoveryReachable: true,
        discoveryKinds: discoveredKinds,
        provenance,
        liveConnected: status.connected && status.adapter === "remote-script" && provenance === "real-live",
        simulator: status.adapter === "simulator",
        evidence: "authenticated-bridge",
        external: { ...report.external, abletonLive: provenance === "real-live" ? "verified" : "unavailable" },
        readiness: { package: report.readiness.package, configured: true, authenticatedBridge: true, realLiveOperational: status.connected && status.adapter === "remote-script" && provenance === "real-live", releaseCertified: false },
        diagnosticErrors: [],
        ready: report.readiness.package && status.connected && status.adapter === "remote-script" && provenance === "real-live",
      };
    } finally {
      await adapter.close();
    }
  } catch {
    return { ...report, diagnosticErrors: ["authenticated-bridge-probe-failed"] };
  }
}
