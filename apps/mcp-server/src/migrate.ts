#!/usr/bin/env node
import { resolve } from "node:path";
import { migrateConfig } from "./delivery.js";

const inputIndex = process.argv.indexOf("--input");
const outputIndex = process.argv.indexOf("--output");
const input = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const force = process.argv.includes("--force");
if (!input || !output) {
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
