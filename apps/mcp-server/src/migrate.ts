#!/usr/bin/env node
import { resolve } from "node:path";
import { migrateConfig, type BridgeMigrationOptions } from "./delivery.js";

const args = process.argv.slice(2);
const valueOptions = new Set(["--input", "--output", "--bridge-host", "--bridge-port", "--secret-file", "--timeout-ms", "--realtime-port"]);
const values = new Map<string, string>();
let force = false;
let invalid = false;
for (let index = 0; index < args.length; index += 1) {
  const option = args[index] ?? "";
  if (option === "--force") {
    if (force) { console.error("migration: repeated --force"); invalid = true; }
    force = true; continue;
  }
  if (!valueOptions.has(option)) { console.error(`migration: unknown option ${option}`); invalid = true; continue; }
  if (values.has(option)) { console.error(`migration: repeated ${option}`); invalid = true; }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) { console.error(`migration: ${option} requires a value`); invalid = true; continue; }
  values.set(option, value); index += 1;
}
const input = values.get("--input");
const output = values.get("--output");
const bridgeRequested = [...values.keys()].some((key) => key.startsWith("--bridge-") || key === "--secret-file" || key === "--timeout-ms" || key === "--realtime-port");
if (!input || !output || (bridgeRequested && (!values.get("--bridge-host") || !values.get("--bridge-port") || !values.get("--secret-file")))) invalid = true;
if (invalid) {
  console.error("usage: ableton-mcp-migrate --input PATH --output PATH [--force] [--bridge-host 127.0.0.1 --bridge-port N --secret-file ABSOLUTE_PATH [--timeout-ms N] [--realtime-port N]]");
  process.exitCode = 2;
} else {
  try {
    let bridge: BridgeMigrationOptions | undefined;
    if (bridgeRequested) {
      const port = Number(values.get("--bridge-port"));
      const timeoutMs = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : 5_000;
      const realtimePort = values.has("--realtime-port") ? Number(values.get("--realtime-port")) : undefined;
      bridge = { host: values.get("--bridge-host")!, port, secretFile: resolve(values.get("--secret-file")!), timeoutMs, ...(realtimePort === undefined ? {} : { realtimePort }) };
    }
    const migrated = migrateConfig(resolve(input!), resolve(output!), force, bridge);
    console.log(JSON.stringify({ migrated: resolve(output!), version: migrated.version }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  }
}
