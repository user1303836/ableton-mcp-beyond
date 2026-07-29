#!/usr/bin/env node

import { assertSupportedNodeRuntime, readAnyConfig, readSecretFile } from "./delivery.js";
import { RemoteScriptLiveAdapter } from "./bridge/remote-adapter.js";
import { serve } from "./host.js";

try { assertSupportedNodeRuntime(); } catch (error) {
  process.stderr.write(`mcp-host: ${error instanceof Error ? error.message : "unsupported Node.js runtime"}\n`);
  process.exitCode = 1;
}

const userArgs = process.argv.slice(2);
const repeatedConfig = userArgs.filter((arg) => arg === "--config").length > 1;
const validShape = userArgs.length === 0 || (userArgs.length === 2 && userArgs[0] === "--config" && !userArgs[1]?.startsWith("-"));
if (repeatedConfig) {
  process.stderr.write("mcp-host: repeated --config\n"); process.exitCode = 2;
} else if (!validShape) {
  process.stderr.write("mcp-host: unknown option\n"); process.exitCode = 2;
}
const configIndex = process.argv.indexOf("--config");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
if (process.exitCode === undefined && configIndex >= 0 && (!configPath || configPath.startsWith("-"))) {
  process.stderr.write("mcp-host: --config requires a path\n");
  process.exitCode = 2;
}
if (process.exitCode === undefined) {
  let adapter;
  try {
    if (configPath) {
      const config = readAnyConfig(configPath);
      if (config.version !== 2) throw new Error("version-1 configuration does not enable a Live adapter");
      const secret = readSecretFile(config.bridge.secretFile);
      adapter = await RemoteScriptLiveAdapter.connect({ ...config.bridge, secret });
    }
    await serve(process.stdin, process.stdout, process.stderr, adapter);
  } catch (error) {
    process.stderr.write(`mcp-host: ${error instanceof Error ? error.message : "configuration or adapter initialization failed"}\n`);
    process.exitCode = 1;
  }
}
