#!/usr/bin/env node
import { diagnostics } from "./delivery.js";

const configIndex = process.argv.indexOf("--config");
const config = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
console.log(JSON.stringify(diagnostics(undefined, config), null, 2));
