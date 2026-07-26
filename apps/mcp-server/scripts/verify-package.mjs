import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmExecutable } from "../dist/src/platform.js";

const packageDirectory = new URL("..", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "ableton-mcp-package-"));
const npm = npmExecutable();
const npmOptions = { shell: process.platform === "win32" };
try {
  const packOutput = execFileSync(npm, ["pack", "--json", "--pack-destination", temporaryDirectory], {
    ...npmOptions,
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packed = JSON.parse(packOutput);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error("npm pack did not return exactly one artifact");
  }
  const artifact = join(temporaryDirectory, packed[0].filename);
  const listing = execFileSync(npm, ["pack", "--dry-run", "--json"], {
    ...npmOptions,
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const dryRun = JSON.parse(listing);
  const files = dryRun?.[0]?.files;
  if (!Array.isArray(files)) throw new Error("npm pack dry-run did not report files");
  const names = files.map((entry) => entry.path);
  for (const required of ["dist/src/cli.js", "dist/src/setup.js", "dist/src/migrate.js", "dist/src/diagnostics.js", "dist/src/install-remote-script.js", "remote-script/AbletonMcpBridge/__init__.py", "remote-script/AbletonMcpBridge/ableton_mcp_remote_script.py", "remote-script/AbletonMcpBridge/ableton-live-v1.operations.json", "remote-script/AbletonMcpBridge/manifest.json", "package.json"]) {
    if (!names.includes(required)) throw new Error(`package is missing ${required}`);
  }
  if (names.some((name) => name.includes("extensions-sdk-1.0.0-beta.0") || name.includes("node_modules"))) {
    throw new Error("package contains a protected SDK or dependency tree");
  }

  const installDirectory = join(temporaryDirectory, "install");
  execFileSync(npm, ["install", "--prefix", installDirectory, artifact, "--ignore-scripts", "--no-audit", "--no-fund"], {
    ...npmOptions,
    cwd: packageDirectory,
    stdio: "pipe",
  });
  const installedPackageDirectory = join(installDirectory, "node_modules", "@ableton-mcp", "mcp-server");
  const installedManifest = JSON.parse(readFileSync(join(installedPackageDirectory, "package.json"), "utf8"));
  if (installedManifest.bin?.["ableton-mcp-server"] !== "./dist/src/cli.js") throw new Error("installed server binary does not target the executable");
  const remotePackageDirectory = join(installedPackageDirectory, "remote-script", "AbletonMcpBridge");
  if (!readFileSync(join(remotePackageDirectory, "__init__.py"), "utf8").includes("def create_instance")) throw new Error("installed Remote Script package has no loadable create_instance");
  if (!readFileSync(join(remotePackageDirectory, "ableton_mcp_remote_script.py"), "utf8").includes("class AbletonMcpBridge")) throw new Error("installed Remote Script package has no production bridge");
  const manifest = JSON.parse(readFileSync(join(remotePackageDirectory, "manifest.json"), "utf8"));
  for (const name of ["__init__.py", "ableton_mcp_remote_script.py", "ableton-live-v1.operations.json"]) {
    const digest = createHash("sha256").update(readFileSync(join(remotePackageDirectory, name))).digest("hex");
    if (manifest.algorithm !== "sha256" || manifest.files?.[name] !== digest) throw new Error(`Remote Script manifest hash mismatch for ${name}`);
  }
  const executable = join(installedPackageDirectory, "dist", "src", "cli.js");
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } } });
  const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  const output = execFileSync(process.execPath, [executable], { input: `${initialize}\n${initialized}\n${ping}\n`, encoding: "utf8" });
  const responses = output.trim().split("\n").map((line) => JSON.parse(line));
  if (responses.length !== 2 || responses[0]?.id !== 1 || responses[1]?.id !== 2) throw new Error("installed executable failed the protocol smoke test");
  const configPath = join(temporaryDirectory, "client-config.json");
  execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "setup.js"), "--output", configPath], { encoding: "utf8" });
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (realpathSync(config.server?.args?.[0] ?? "") !== realpathSync(executable)) throw new Error(`installed setup helper emitted the wrong executable path: expected ${executable}, received ${config.server?.args?.[0]}`);
  const legacyPath = join(temporaryDirectory, "legacy-config.json");
  const migratedPath = join(temporaryDirectory, "migrated-config.json");
  writeFileSync(legacyPath, JSON.stringify({ command: process.execPath, args: [executable] }));
  execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "migrate.js"), "--input", legacyPath, "--output", migratedPath], { encoding: "utf8" });
  const migrated = JSON.parse(readFileSync(migratedPath, "utf8"));
  if (migrated.version !== 1 || migrated.server?.command !== process.execPath) throw new Error("installed migration helper emitted an invalid version 1 configuration");
  const diagnosticsOutput = execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "diagnostics.js"), "--config", migratedPath], { encoding: "utf8" });
  const diagnostics = JSON.parse(diagnosticsOutput);
  if (diagnostics.config?.valid !== true || diagnostics.entrypoint?.present !== true || diagnostics.external?.abletonLive !== "unavailable") throw new Error("installed diagnostics helper reported an invalid readiness result");
  console.log(JSON.stringify({ artifact: packed[0].filename, files: names.length, installed: true, protocolSmoke: true, setupSmoke: true, migrationSmoke: true, diagnosticsSmoke: true, platform: process.platform, arch: process.arch }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
