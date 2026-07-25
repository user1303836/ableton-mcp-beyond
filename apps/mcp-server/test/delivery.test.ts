import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configForEntrypoint, diagnostics, migrateConfig, readConfig, writeConfig } from "../src/delivery.js";

test("writes a versioned config without overwriting user files", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-"));
  const path = join(directory, "config.json");
  const config = configForEntrypoint("/opt/ableton-mcp/dist/src/index.js", "/usr/bin/node");
  writeConfig(path, config);
  assert.deepEqual(readConfig(path), config);
  assert.throws(() => writeConfig(path, config), /refusing to overwrite/);
  assert.throws(() => writeConfig(join(directory, "invalid.json"), { version: 1, server: { command: "", args: [] } } as any), /invalid server configuration/);
  assert.throws(() => configForEntrypoint("/opt/ableton-mcp/dist/src/index.js", ""), /node command/);
});

test("migrates the legacy command-and-args shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-"));
  const input = join(directory, "legacy.json");
  const output = join(directory, "v1.json");
  writeFileSync(input, JSON.stringify({ command: "/usr/bin/node", args: ["server.js"] }));
  assert.deepEqual(migrateConfig(input, output), { version: 1, server: { command: "/usr/bin/node", args: ["server.js"] } });
  assert.match(readFileSync(output, "utf8"), /"version": 1/);
  const invalid = join(directory, "invalid-legacy.json");
  writeFileSync(invalid, JSON.stringify({ command: "", args: [] }));
  assert.throws(() => migrateConfig(invalid, join(directory, "invalid-output.json")), /legacy configuration/);
});

test("diagnostics report local readiness separately from unavailable external evidence", () => {
  const report = diagnostics(mkdtempSync(join(tmpdir(), "ableton-mcp-")));
  assert.equal(report.external.abletonLive, "unavailable");
  assert.equal(report.external.signing, "unavailable");
  assert.equal(report.ready, false);
});
