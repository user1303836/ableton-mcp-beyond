#!/usr/bin/env node
import { diagnosticsAsync } from "./delivery.js";

const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 2 && args[0] === "--config" && !args[1]?.startsWith("-")))) {
  process.stderr.write("diagnostics: expected at most one --config PATH\n"); process.exitCode = 2;
}
const configIndex = process.argv.indexOf("--config");
const config = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
if (process.exitCode === undefined && configIndex >= 0 && (!config || config.startsWith("-"))) {
  process.stderr.write("diagnostics: --config requires a path\n"); process.exitCode = 2;
} else if (process.exitCode === undefined) try {
  console.log(JSON.stringify(await diagnosticsAsync(undefined, config), null, 2));
} catch {
  process.exitCode = 1;
}
