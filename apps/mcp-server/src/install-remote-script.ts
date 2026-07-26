#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installRemoteScript } from "./delivery.js";

const source = resolve(fileURLToPath(new URL("../../remote-script/ableton_mcp_remote_script.py", import.meta.url)));
const destinationIndex = process.argv.indexOf("--destination");
const destination = destinationIndex >= 0 ? process.argv[destinationIndex + 1] : undefined;
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

if (!destination) {
  console.error("usage: ableton-mcp-install-remote-script --destination <explicit-directory> [--dry-run] [--force]");
  process.exitCode = 2;
} else {
  try {
    const result = installRemoteScript(source, resolve(destination), { dryRun, force });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Remote Script installation failed");
    process.exitCode = 1;
  }
}
