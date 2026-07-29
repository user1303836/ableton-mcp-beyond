#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configForBridge, configForEntrypoint, readSecretFile, writeConfig } from "./delivery.js";

const args = process.argv.slice(2);
const allowed = new Set(["--output", "--force", "--bridge-host", "--bridge-port", "--secret-file", "--bridge-timeout", "--realtime-port"]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (!allowed.has(arg)) { console.error(`setup: unknown option ${arg}`); process.exitCode = 2; continue; }
  const value = args[index + 1] ?? "";
  if (arg !== "--force" && (!value || value.startsWith("-"))) { console.error(`setup: ${arg} requires a value`); process.exitCode = 2; }
  if (arg !== "--force") index += 1;
}
for (const option of ["--output", "--bridge-host", "--bridge-port", "--secret-file", "--bridge-timeout", "--realtime-port"]) if (args.filter((arg) => arg === option).length > 1) { console.error(`setup: repeated ${option}`); process.exitCode = 2; }
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const force = process.argv.includes("--force");
const bridgeHost = process.argv.includes("--bridge-host") ? process.argv[process.argv.indexOf("--bridge-host") + 1] : undefined;
const bridgePortValue = process.argv.includes("--bridge-port") ? process.argv[process.argv.indexOf("--bridge-port") + 1] : undefined;
const secretFile = process.argv.includes("--secret-file") ? process.argv[process.argv.indexOf("--secret-file") + 1] : undefined;
const timeoutValue = process.argv.includes("--bridge-timeout") ? process.argv[process.argv.indexOf("--bridge-timeout") + 1] : undefined;
const realtimePortValue = process.argv.includes("--realtime-port") ? process.argv[process.argv.indexOf("--realtime-port") + 1] : undefined;
if (process.exitCode !== undefined) {
  // validation above already reported the command-line error
} else if (!output) {
  console.error("usage: ableton-mcp-setup --output <path> [--bridge-host <loopback> --bridge-port <port> --secret-file <path> --bridge-timeout <ms> --realtime-port <port>] [--force]");
  process.exitCode = 2;
} else {
  try {
    const entrypoint = resolve(fileURLToPath(new URL("./cli.js", import.meta.url)));
    const config = bridgeHost !== undefined || bridgePortValue !== undefined || secretFile !== undefined || timeoutValue !== undefined || realtimePortValue !== undefined
      ? configForBridge(entrypoint, { host: bridgeHost ?? "127.0.0.1", port: Number(bridgePortValue), secretFile: resolve(secretFile ?? ""), timeoutMs: Number(timeoutValue ?? 5000), ...(realtimePortValue === undefined ? {} : { realtimePort: Number(realtimePortValue) }) }, process.execPath, resolve(output))
      : configForEntrypoint(entrypoint);
    if ("bridge" in config) readSecretFile(config.bridge.secretFile);
    writeConfig(resolve(output), config, force);
    console.log(JSON.stringify({ created: resolve(output), version: config.version }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "setup failed");
    process.exitCode = 1;
  }
}
