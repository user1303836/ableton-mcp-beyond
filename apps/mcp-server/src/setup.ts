#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configForEntrypoint, writeConfig } from "./delivery.js";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const force = process.argv.includes("--force");
if (!output) {
  console.error("usage: ableton-mcp-setup --output <path> [--force]");
  process.exitCode = 2;
} else {
  try {
    const entrypoint = resolve(fileURLToPath(new URL("./index.js", import.meta.url)));
    writeConfig(resolve(output), configForEntrypoint(entrypoint), force);
    console.log(JSON.stringify({ created: resolve(output), version: 1 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "setup failed");
    process.exitCode = 1;
  }
}
