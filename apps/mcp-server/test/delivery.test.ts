import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configForEntrypoint, diagnostics, isSupportedPlatform, migrateConfig, readConfig, writeConfig } from "../src/delivery.js";
import { npmExecutable } from "../src/platform.js";

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
  assert.equal(report.entrypoint.path.replaceAll("\\", "/").endsWith("dist/src/cli.js"), true);
  assert.equal(report.platformSupported, true);
});

test("compatibility is explicit for the portable Node runtime", () => {
  assert.equal(isSupportedPlatform("darwin"), true);
  assert.equal(isSupportedPlatform("win32"), true);
  assert.equal(isSupportedPlatform("linux"), true);
  assert.equal(isSupportedPlatform("aix"), false);
});

test("delivery supports the three CI platforms without native packaging", () => {
  assert.deepEqual(["darwin", "linux", "win32"].map((value) => isSupportedPlatform(value as NodeJS.Platform)), [true, true, true]);
  assert.equal(isSupportedPlatform("freebsd"), false);
});

test("package verification selects the Windows npm shim", () => {
  assert.equal(npmExecutable("win32"), "npm.cmd");
  assert.equal(npmExecutable("darwin"), "npm");
  assert.equal(npmExecutable("linux"), "npm");
});

test("npm start launches the stdio server entrypoint", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: { start?: string } };
  assert.equal(packageJson.scripts?.start, "node dist/src/cli.js");
});
