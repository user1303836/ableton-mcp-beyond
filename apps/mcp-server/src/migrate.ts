#!/usr/bin/env node
import { resolve } from "node:path";
import { migrateConfig } from "./delivery.js";

const args = process.argv.slice(2);
const allowed = new Set(["--input", "--output", "--force"]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (!allowed.has(arg)) { console.error(`migration: unknown option ${arg}`); process.exitCode = 2; continue; }
  const value = args[index + 1] ?? "";
  if (arg !== "--force" && (!value || value.startsWith("-"))) { console.error(`migration: ${arg} requires a value`); process.exitCode = 2; }
  if (arg !== "--force") index += 1;
}
for (const option of ["--input", "--output"]) if (args.filter((arg) => arg === option).length > 1) { console.error(`migration: repeated ${option}`); process.exitCode = 2; }
const inputIndex = process.argv.indexOf("--input");
const outputIndex = process.argv.indexOf("--output");
const input = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const force = process.argv.includes("--force");
if (process.exitCode !== undefined) {
  // validation above already reported the command-line error
} else if (!input || !output) {
  console.error("usage: ableton-mcp-migrate --input <path> --output <path> [--force]");
  process.exitCode = 2;
} else {
  try {
    migrateConfig(resolve(input), resolve(output), force);
    console.log(JSON.stringify({ migrated: resolve(output), version: 1 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  }
}
