#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIFECYCLE_ACTIONS, runLifecycle, type LifecycleAction, type LifecycleOptions } from "./lifecycle.js";

function usage(): never {
  throw new Error("usage: ableton-mcp-lifecycle <install|activate|upgrade|repair|rollback|uninstall|status> --remote-scripts-dir ABSOLUTE_PATH [--state-dir ABSOLUTE_PATH] [--package-root ABSOLUTE_PATH] --artifact ABSOLUTE_TARBALL --artifact-sha256 HEX [--config PATH] [--secret PATH] [--host 127.0.0.1|::1] [--port N] [--realtime-port N] [--timeout-ms N] [--apply] [--confirm-live-stopped] [--purge-secret] [--allow-dirty-private-build]");
}

function defaultStateDirectory(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData || !isAbsolute(appData)) throw new Error("APPDATA is unavailable; provide --state-dir");
    return resolve(appData, "ableton-mcp");
  }
  return resolve(homedir(), ".config", "ableton-mcp");
}

function integer(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${name} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
}

function parse(argv: string[]): LifecycleOptions {
  const action = argv.shift() as LifecycleAction | undefined;
  if (!action || !LIFECYCLE_ACTIONS.includes(action)) usage();
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["--remote-scripts-dir", "--state-dir", "--package-root", "--artifact", "--artifact-sha256", "--config", "--secret", "--host", "--port", "--realtime-port", "--timeout-ms"]);
  const flagOptions = new Set(["--apply", "--confirm-live-stopped", "--purge-secret", "--allow-dirty-private-build"]);
  while (argv.length > 0) {
    const key = argv.shift()!;
    if (values.has(key) || flags.has(key)) throw new Error(`duplicate option: ${key}`);
    if (valueOptions.has(key)) {
      const value = argv.shift();
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      values.set(key, value);
    } else if (flagOptions.has(key)) flags.add(key);
    else throw new Error(`unknown option: ${key}`);
  }
  const remoteScriptsDirectory = values.get("--remote-scripts-dir");
  if (!remoteScriptsDirectory) usage();
  const packageRoot = values.get("--package-root") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const stateDirectory = values.get("--state-dir") ?? defaultStateDirectory();
  return {
    action,
    packageRoot,
    stateDirectory,
    remoteScriptsDirectory,
    ...(values.has("--artifact") ? { artifactPath: values.get("--artifact") } : {}),
    ...(values.has("--artifact-sha256") ? { artifactSha256: values.get("--artifact-sha256") } : {}),
    ...(values.has("--config") ? { configPath: values.get("--config") } : {}),
    ...(values.has("--secret") ? { secretPath: values.get("--secret") } : {}),
    ...(values.has("--host") ? { host: values.get("--host") } : {}),
    ...(values.has("--port") ? { port: integer(values.get("--port"), "--port") } : {}),
    ...(values.has("--realtime-port") ? { realtimePort: integer(values.get("--realtime-port"), "--realtime-port") } : {}),
    ...(values.has("--timeout-ms") ? { timeoutMs: integer(values.get("--timeout-ms"), "--timeout-ms") } : {}),
    apply: flags.has("--apply"),
    confirmLiveStopped: flags.has("--confirm-live-stopped"),
    purgeSecret: flags.has("--purge-secret"),
    allowDirtyPrivateBuild: flags.has("--allow-dirty-private-build"),
  };
}

try {
  const result = await runLifecycle(parse(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state === "blocked" || result.state === "failed") process.exitCode = 2;
} catch (error) {
  const reason = error instanceof Error ? error.message.replace(/(?:[A-Za-z]:\\|\/)[^\s"']+/g, "<redacted-path>").slice(0, 512) : "lifecycle failed";
  process.stderr.write(`${JSON.stringify({ version: "ableton-mcp-lifecycle-error/v1", reason })}\n`);
  process.exitCode = 2;
}
