import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configForBridge, configForEntrypoint, diagnostics, generateSecret, installRemoteScript, isSupportedPlatform, migrateConfig, readConfig, readSecretFile, supportedNodeMajor, writeBridgeReference, writeConfig, writeSecretFile } from "../src/delivery.js";
import { npmExecutable } from "../src/platform.js";

test("writes a versioned config and replaces it only with explicit force", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-"));
  const path = join(directory, "config.json");
  const config = configForEntrypoint("/opt/ableton-mcp/dist/src/index.js", "/usr/bin/node");
  writeConfig(path, config);
  assert.deepEqual(readConfig(path), config);
  assert.throws(() => writeConfig(path, config), /refusing to overwrite/);
  const replacement = configForEntrypoint("/Program Files/Ableton MCP/cli.js", "node.exe");
  writeConfig(path, replacement, true);
  assert.deepEqual(readConfig(path), replacement);
  assert.throws(() => writeConfig(join(directory, "invalid.json"), { version: 1, server: { command: "", args: [] } } as any), /invalid server configuration/);
  assert.throws(() => writeConfig(join(directory, "unknown.json"), { version: 1, server: { command: "/usr/bin/node", args: [], extra: true } } as any), /invalid server configuration/);
  assert.throws(() => configForEntrypoint("/opt/ableton-mcp/dist/src/index.js", ""), /node command/);
});

test("refuses to replace a configuration directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-"));
  const destination = join(directory, "config.json");
  mkdirSync(destination);
  assert.throws(() => writeConfig(destination, configForEntrypoint("/opt/server.js"), true), /refusing to replace configuration directory/);
  assert.equal(existsSync(destination), true);
});

test("does not follow configuration symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-"));
  const target = join(directory, "target.json");
  const link = join(directory, "config.json");
  writeFileSync(target, "sentinel");
  symlinkSync(target, link);
  assert.throws(() => writeConfig(link, configForEntrypoint("/opt/server.js"), true), /symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "sentinel");

  const danglingTarget = join(directory, "missing.json");
  const danglingLink = join(directory, "dangling.json");
  symlinkSync(danglingTarget, danglingLink);
  assert.throws(() => writeConfig(danglingLink, configForEntrypoint("/opt/server.js"), true), /symbolic link/);
  assert.equal(existsSync(danglingTarget), false);
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

test("requires a maintained Node runtime", () => {
  assert.equal(supportedNodeMajor("22.0.0"), true);
  assert.equal(supportedNodeMajor("24.1.0"), true);
  assert.equal(supportedNodeMajor("20.19.0"), false);
  assert.equal(supportedNodeMajor("not-a-version"), false);
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

test("bridge configuration and secrets are explicit and fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-"));
  const secretPath = join(directory, "secret");
  writeSecretFile(secretPath);
  const secret = readSecretFile(secretPath);
  assert.equal(secret.length >= 32, true);
  const config = configForBridge("/opt/ableton-mcp/dist/src/cli.js", { host: "127.0.0.1", port: 43210, secretFile: secretPath, timeoutMs: 5000 });
  assert.equal(config.version, 2);
  const generated = configForBridge("/opt/ableton-mcp/dist/src/cli.js", { host: "127.0.0.1", port: 43210, secretFile: secretPath, timeoutMs: 5000 }, "/usr/bin/node", join(directory, "bridge-config.json"));
  assert.deepEqual(generated.server.args, ["/opt/ableton-mcp/dist/src/cli.js", "--config", join(directory, "bridge-config.json")]);
  assert.throws(() => configForBridge("/opt/cli.js", { host: "0.0.0.0", port: 43210, secretFile: secretPath, timeoutMs: 5000 }), /loopback/);
  assert.throws(() => generateSecret(8), /between 32/);
  writeFileSync(join(directory, "bad-secret"), ` ${secret}\n`);
  assert.throws(() => readSecretFile(join(directory, "bad-secret")), /secret file is invalid/);
  assert.throws(() => configForBridge("/opt/cli.js", { host: "127.999.0.1", port: 43210, secretFile: secretPath, timeoutMs: 5000 }), /loopback/);
  if (process.platform !== "win32") {
    chmodSync(secretPath, 0o644);
    assert.throws(() => readSecretFile(secretPath), /permissions.*owner-only/);
  }
});

test("package bridge smoke does not pass its secret on the command line", () => {
  const script = readFileSync(new URL("../../scripts/verify-package.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /spawn\(python, \[bridgeScript, bridgeSecret/);
  assert.match(script, /ABLETON_MCP_SMOKE_SECRET_FILE/);
});

test("writes only an absolute non-secret bridge reference", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-reference-"));
  const config = join(directory, "bridge.json");
  const reference = join(directory, "AbletonMcpBridge", "bridge-reference.json");
  mkdirSync(join(directory, "AbletonMcpBridge"));
  writeFileSync(config, "{}", { mode: 0o600 });
  writeBridgeReference(reference, config);
  assert.deepEqual(JSON.parse(readFileSync(reference, "utf8")), { config });
  assert.doesNotMatch(readFileSync(reference, "utf8"), /secret|password/i);
  assert.throws(() => writeBridgeReference(reference, config), /overwrite/);
});

test("Remote Script installer is explicit, atomic, and preserves a recoverable backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "ableton-mcp-install-"));
  const sourceDirectory = join(directory, "source");
  mkdirSync(sourceDirectory);
  const source = join(sourceDirectory, "source.py");
  const destination = join(directory, "AbletonMcpBridge");
  writeFileSync(source, "production-remote-script");
  mkdirSync(join(sourceDirectory, "AbletonMcpBridge"));
  writeFileSync(join(sourceDirectory, "AbletonMcpBridge", "__init__.py"), "# production package");
  assert.deepEqual(installRemoteScript(source, destination, { dryRun: true }), { installed: destination, backup: null, reference: null, dryRun: true });
  const first = installRemoteScript(source, destination);
  assert.equal(readFileSync(join(destination, "ableton_mcp_remote_script.py"), "utf8"), "production-remote-script");
  writeFileSync(source, "replacement");
  assert.throws(() => installRemoteScript(source, destination), /refusing to overwrite/);
  const second = installRemoteScript(source, destination, { force: true });
  assert.equal(second.backup !== null, true);
  assert.equal(readFileSync(join(destination, "ableton_mcp_remote_script.py"), "utf8"), "replacement");
  assert.equal(first.backup, null);
  assert.equal(existsSync(join(destination, "ableton-live-v1.operations.json")), true);
  const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")) as { registryHash?: string; files?: Record<string, string> };
  assert.equal(typeof manifest.files?.["ableton-live-v1.operations.json"], "string");
  assert.match(manifest.registryHash ?? "", /^[a-f0-9]{64}$/);
});

test("diagnostic evidence cannot promote an authenticated fake bridge to real Live", () => {
  const source = readFileSync(new URL("../../src/delivery.ts", import.meta.url), "utf8");
  assert.match(source, /provenance === \"real-live\"/);
  assert.match(source, /adapterOperations: operations/);
  assert.match(source, /session-playback/);
});
