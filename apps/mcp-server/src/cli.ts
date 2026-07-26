#!/usr/bin/env node

import { readAnyConfig, readSecretFile } from "./delivery.js";
import { RemoteScriptLiveAdapter } from "./bridge/remote-adapter.js";
import { serve } from "./host.js";

const configIndex = process.argv.indexOf("--config");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
if (configIndex >= 0 && (!configPath || configPath.startsWith("-"))) {
  process.stderr.write("mcp-host: --config requires a path\n");
  process.exitCode = 2;
} else {
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
