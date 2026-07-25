import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, versions } from "node:process";

export const CONFIG_VERSION = 1;
export const MIN_NODE_MAJOR = 20;

export interface ServerConfig {
  version: 1;
  server: { command: string; args: string[] };
}

export interface DiagnosticReport {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  nodeSupported: boolean;
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
  if (candidate.version !== CONFIG_VERSION || typeof server !== "object" || server === null || Array.isArray(server)) throw new Error("unsupported configuration version");
  const serverObject = server as Record<string, unknown>;
  if (typeof serverObject.command !== "string" || serverObject.command.length === 0 || !Array.isArray(serverObject.args) || !serverObject.args.every((arg) => typeof arg === "string")) throw new Error("invalid server configuration");
  return { version: 1, server: { command: serverObject.command, args: [...serverObject.args] } };
}

export function configForEntrypoint(entrypoint: string, nodeCommand = process.execPath): ServerConfig {
  if (!isAbsolute(entrypoint)) throw new Error("entrypoint must be an absolute path");
  return { version: 1, server: { command: nodeCommand, args: [entrypoint] } };
}

export function readConfig(path: string): ServerConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeConfig(path: string, config: ServerConfig, force = false): void {
  if (existsSync(path) && !force) throw new Error(`refusing to overwrite existing file: ${path}`);
  const parent = dirname(path);
  if (!existsSync(parent)) throw new Error(`configuration directory does not exist: ${parent}`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  if (platform !== "win32") chmodSync(path, 0o600);
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
    if (typeof command !== "string" || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("legacy configuration must contain command and string args");
    config = { version: 1, server: { command, args: [...args] } };
  } else {
    throw new Error("configuration must be an object");
  }
  writeConfig(outputPath, config, force);
  return config;
}

export function diagnostics(packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), configPath?: string): DiagnosticReport {
  const entrypoint = join(packageRoot, "dist", "src", "index.js");
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
    packageRoot,
    entrypoint: { path: entrypoint, present: entrypointPresent },
    config: { path: configPath ?? null, present: configPath ? existsSync(configPath) : false, valid: configValid },
    external: { abletonLive: "unavailable", signing: "unavailable", notarization: "unavailable" },
    ready: nodeMajor >= MIN_NODE_MAJOR && entrypointPresent,
  };
}
