import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, versions } from "node:process";
import { randomUUID } from "node:crypto";

export const CONFIG_VERSION = 1;
export const MIN_NODE_MAJOR = 20;
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

export interface ServerConfig {
  version: 1;
  server: { command: string; args: string[] };
}

export interface DiagnosticReport {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  nodeSupported: boolean;
  platformSupported: boolean;
  packageRoot: string;
  entrypoint: { path: string; present: boolean };
  config: { path: string | null; present: boolean; valid: boolean };
  external: {
    abletonLive: "unavailable";
    signing: "unavailable";
    notarization: "unavailable";
  };
  ready: boolean;
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

export function configForEntrypoint(entrypoint: string, nodeCommand = process.execPath): ServerConfig {
  if (!isAbsolute(entrypoint)) throw new Error("entrypoint must be an absolute path");
  if (typeof nodeCommand !== "string" || nodeCommand.length === 0) throw new Error("node command must be a non-empty string");
  return { version: 1, server: { command: nodeCommand, args: [entrypoint] } };
}

export function isSupportedPlatform(value: NodeJS.Platform = platform): boolean {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

export function readConfig(path: string): ServerConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeConfig(path: string, config: ServerConfig, force = false): void {
  config = parseConfig(config);
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

export function migrateConfig(inputPath: string, outputPath: string, force = false): ServerConfig {
  const source = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  let config: ServerConfig;
  if (typeof source === "object" && source !== null && !Array.isArray(source) && (source as Record<string, unknown>).version === CONFIG_VERSION) {
    config = parseConfig(source);
  } else if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const legacy = source as Record<string, unknown>;
    const command = legacy.command;
    const args = legacy.args;
    if (typeof command !== "string" || command.length === 0 || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("legacy configuration must contain command and string args");
    config = { version: 1, server: { command, args: [...args] } };
  } else {
    throw new Error("configuration must be an object");
  }
  writeConfig(outputPath, config, force);
  return config;
}

export function diagnostics(packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), configPath?: string): DiagnosticReport {
  const entrypoint = join(packageRoot, "dist", "src", "cli.js");
  let configValid = false;
  if (configPath && existsSync(configPath)) {
    try { readConfig(configPath); configValid = true; } catch { configValid = false; }
  }
  const nodeMajor = Number.parseInt(versions.node.split(".")[0] ?? "0", 10);
  const entrypointPresent = existsSync(entrypoint) && statSync(entrypoint).isFile();
  return {
    platform,
    arch: process.arch,
    node: versions.node,
    nodeSupported: nodeMajor >= MIN_NODE_MAJOR,
    platformSupported: isSupportedPlatform(),
    packageRoot,
    entrypoint: { path: entrypoint, present: entrypointPresent },
    config: { path: configPath ?? null, present: configPath ? existsSync(configPath) : false, valid: configValid },
    external: { abletonLive: "unavailable", signing: "unavailable", notarization: "unavailable" },
    ready: nodeMajor >= MIN_NODE_MAJOR && isSupportedPlatform() && entrypointPresent,
  };
}
