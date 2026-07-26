#!/usr/bin/env node
import { diagnosticsAsync } from "./delivery.js";

const configIndex = process.argv.indexOf("--config");
const config = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
try {
  console.log(JSON.stringify(await diagnosticsAsync(undefined, config), null, 2));
} catch {
  process.exitCode = 1;
}
