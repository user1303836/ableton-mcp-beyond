#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installRemoteScript } from "./delivery.js";

const source = resolve(fileURLToPath(new URL("../../remote-script/AbletonMcpBridge/ableton_mcp_remote_script.py", import.meta.url)));
const args = process.argv.slice(2);
const allowed = new Set(["--destination", "--config", "--dry-run", "--force"]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (!allowed.has(arg)) { console.error(`installer: unknown option ${arg}`); process.exitCode = 2; continue; }
  if (arg === "--destination" || arg === "--config") {
    const value = args[index + 1] ?? "";
    if (!value || value.startsWith("-")) { console.error(`installer: ${arg} requires a value`); process.exitCode = 2; }
    index += 1;
  }
}
for (const option of ["--destination", "--config"]) if (args.filter((arg) => arg === option).length > 1) { console.error(`installer: repeated ${option}`); process.exitCode = 2; }
const destinationIndex = process.argv.indexOf("--destination");
const destination = destinationIndex >= 0 ? process.argv[destinationIndex + 1] : undefined;
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const configIndex = process.argv.indexOf("--config");
const config = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;

if (process.exitCode !== undefined) {
  // validation above already reported the command-line error
} else if (!destination) {
  console.error("usage: ableton-mcp-install-remote-script --destination <explicit-directory> [--config <absolute-host-config>] [--dry-run] [--force]");
  process.exitCode = 2;
} else {
  try {
    if (configIndex >= 0 && (!config || config.startsWith("-"))) throw new Error("--config requires a path");
    const result = installRemoteScript(source, resolve(destination), { dryRun, force, configPath: config ? resolve(config) : undefined });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Remote Script installation failed");
    process.exitCode = 1;
  }
}
