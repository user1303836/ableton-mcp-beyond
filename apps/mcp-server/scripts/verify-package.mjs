import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createServer } from "node:net";
import { npmExecutable } from "../dist/src/platform.js";

const packageDirectory = new URL("..", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "ableton-mcp-package-"));
const npm = npmExecutable();
const npmOptions = { shell: process.platform === "win32" };

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function terminateChildProcess(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch {}
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
}

function removeTemporaryDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // The smoke test intentionally creates an owner-only secret ACL. Restore
    // the temporary tree's inherited ACL after all child processes are gone so
    // Windows can remove the test directory deterministically.
    try { execFileSync("icacls.exe", [path, "/reset", "/t", "/c"], { stdio: "ignore" }); } catch {}
    rmSync(path, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

let bridgeProcess;
try {
  const requestedArtifact = process.env.ABLETON_MCP_ARTIFACT;
  let artifact;
  if (requestedArtifact) {
    artifact = resolve(requestedArtifact);
    if (!isAbsolute(requestedArtifact) || !existsSync(artifact)) throw new Error("ABLETON_MCP_ARTIFACT must name an existing absolute tarball");
  } else {
    const packOutput = execFileSync(npm, ["pack", "--json", "--pack-destination", temporaryDirectory], { ...npmOptions, cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const packed = JSON.parse(packOutput);
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") throw new Error("npm pack did not return exactly one artifact");
    artifact = join(temporaryDirectory, packed[0].filename);
  }
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
  for (const required of ["dist/src/cli.js", "dist/src/setup.js", "dist/src/migrate.js", "dist/src/diagnostics.js", "dist/src/install-remote-script.js", "dist/src/lifecycle-cli.js", "remote-script/AbletonMcpBridge/__init__.py", "remote-script/AbletonMcpBridge/ableton_mcp_remote_script.py", "remote-script/AbletonMcpBridge/ableton-live-v1.operations.json", "remote-script/AbletonMcpBridge/manifest.json", "release-docs/USER_GUIDE.md", "release-docs/OPERATIONS.md", "release-docs/RECOVERY.md", "release-docs/DISTRIBUTION_POLICY.md", "release-docs/SUPPORT_MATRIX.md", "release-manifest.json", "LICENSE.md", "package.json"]) {
    if (!names.includes(required)) throw new Error(`package is missing ${required}`);
  }
  const runtimeModules = ["analysis-job-worker", "analysis-runner", "analysis", "audio-diagnosis", "audio-file", "audio-standards", "bridge/remote-adapter", "cli", "delivery", "diagnostics", "framing", "host", "index", "install-remote-script", "journeys", "lifecycle-cli", "lifecycle", "live", "loopback", "migrate", "platform", "project", "reference-analysis", "registry", "setup", "stdio", "transactions/session-midi"];
  const expectedNames = ["package.json", "LICENSE.md", "release-manifest.json", ...runtimeModules.flatMap((module) => [`dist/src/${module}.js`, `dist/src/${module}.d.ts`]), ...["README.md", "USER_GUIDE.md", "USER_JOURNEYS.md", "OPERATIONS.md", "RECOVERY.md", "LIVE_SAFETY.md", "AUDIO_INTELLIGENCE.md", "REALTIME_CONTROL.md", "DELIVERY.md", "DEVELOPER_GUIDE.md", "TESTING.md", "IMPLEMENTATION_STATUS.md", "DISTRIBUTION_POLICY.md", "SUPPORT_MATRIX.md", "CAPABILITY_MATRIX.md"].map((name) => `release-docs/${name}`), "remote-script/README.md", "remote-script/AbletonMcpBridge/__init__.py", "remote-script/AbletonMcpBridge/ableton_mcp_remote_script.py", "remote-script/AbletonMcpBridge/ableton-live-v1.operations.json", "remote-script/AbletonMcpBridge/manifest.json"].sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expectedNames)) throw new Error("package inventory differs from the independent explicit allowlist");
  const allowed = (name) => expectedNames.includes(name);
  const forbidden = names.filter((name) => !allowed(name) || name.startsWith("scripts/") || name.includes("/test/") || name.endsWith(".map") || name.includes("node_modules") || name.includes("evidence/") || /(?:^|\/)(?:bridge\.secret|bridge-config\.json|install-receipt\.json|lifecycle-journal\.json)$/.test(name));
  if (forbidden.length > 0) throw new Error(`package contains non-allowlisted files: ${forbidden.join(", ")}`);

  const installDirectory = join(temporaryDirectory, "install");
  execFileSync(npm, ["install", "--prefix", installDirectory, artifact, "--ignore-scripts", "--no-audit", "--no-fund"], {
    ...npmOptions,
    cwd: packageDirectory,
    stdio: "pipe",
  });
  const installedPackageDirectory = join(installDirectory, "node_modules", "@ableton-mcp", "mcp-server");
  const installedManifest = JSON.parse(readFileSync(join(installedPackageDirectory, "package.json"), "utf8"));
  if (installedManifest.private !== true || installedManifest.license !== "UNLICENSED" || installedManifest.bin?.["ableton-mcp-server"] !== "./dist/src/cli.js" || installedManifest.bin?.["ableton-mcp-lifecycle"] !== "./dist/src/lifecycle-cli.js") throw new Error("installed package policy or executable map is invalid");
  const releaseManifest = JSON.parse(readFileSync(join(installedPackageDirectory, "release-manifest.json"), "utf8"));
  if (releaseManifest.schema !== "ableton-mcp-private-release/v1" || releaseManifest.distribution?.channel !== "private-local-npm-tarball" || releaseManifest.distribution?.published !== false || releaseManifest.distribution?.signed !== false || releaseManifest.distribution?.notarized !== false || releaseManifest.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(releaseManifest.build?.builder?.packageLockSha256 ?? "") || !/^[a-f0-9]{64}$/.test(releaseManifest.build?.builder?.workflowSha256 ?? "") || !releaseManifest.build?.builder?.node || !releaseManifest.build?.builder?.npm || !releaseManifest.build?.builder?.typescript) throw new Error("installed release manifest policy is invalid");
  const manifestNames = Object.keys(releaseManifest.files ?? {}).sort();
  const expectedManifestNames = names.filter((name) => !["package.json", "release-manifest.json"].includes(name)).sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(expectedManifestNames)) throw new Error("release manifest does not exactly cover the packaged payload allowlist");
  for (const [name, expected] of Object.entries(releaseManifest.files)) {
    const actual = createHash("sha256").update(readFileSync(join(installedPackageDirectory, ...name.split("/")))).digest("hex");
    if (actual !== expected) throw new Error(`release payload hash mismatch: ${name}`);
  }
  for (const name of manifestNames.filter((entry) => entry.startsWith("release-docs/") && entry.endsWith(".md"))) {
    const documentPath = join(installedPackageDirectory, ...name.split("/")); const markdown = readFileSync(documentPath, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0]; if (!target || /^[a-z]+:/i.test(target)) continue;
      const resolvedTarget = resolve(dirname(documentPath), target); const within = relative(installedPackageDirectory, resolvedTarget);
      if (within.startsWith("..") || isAbsolute(within) || !existsSync(resolvedTarget)) throw new Error(`packaged documentation has a broken internal link: ${name} -> ${match[1]}`);
    }
  }
  const remotePackageDirectory = join(installedPackageDirectory, "remote-script", "AbletonMcpBridge");
  if (!readFileSync(join(remotePackageDirectory, "__init__.py"), "utf8").includes("def create_instance")) throw new Error("installed Remote Script package has no loadable create_instance");
  if (!readFileSync(join(remotePackageDirectory, "ableton_mcp_remote_script.py"), "utf8").includes("class AbletonMcpBridge")) throw new Error("installed Remote Script package has no production bridge");
  const manifest = JSON.parse(readFileSync(join(remotePackageDirectory, "manifest.json"), "utf8"));
  const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const expectedRegistryHash = createHash("sha256").update(canonical(JSON.parse(readFileSync(join(remotePackageDirectory, "ableton-live-v1.operations.json"), "utf8")))).digest("hex");
  if (manifest.registryHash !== expectedRegistryHash) throw new Error("Remote Script manifest registry hash mismatch");
  for (const name of ["__init__.py", "ableton_mcp_remote_script.py", "ableton-live-v1.operations.json"]) {
    const digest = createHash("sha256").update(readFileSync(join(remotePackageDirectory, name))).digest("hex");
    if (manifest.algorithm !== "sha256" || manifest.files?.[name] !== digest) throw new Error(`Remote Script manifest hash mismatch for ${name}`);
  }
  const executable = join(installedPackageDirectory, "dist", "src", "cli.js");
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } } });
  const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  const output = execFileSync(process.execPath, [executable], { cwd: installDirectory, input: `${initialize}\n${initialized}\n${ping}\n`, encoding: "utf8" });
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

  // Exercise the installed receipt-driven lifecycle through OS-native paths
  // containing spaces and Unicode. This is host/package evidence, not Live.
  const lifecycleExecutable = join(installedPackageDirectory, "dist", "src", "lifecycle-cli.js");
  const lifecycleRoot = join(temporaryDirectory, "Lifecycle ü space");
  const lifecycleState = join(lifecycleRoot, "State ü");
  const lifecycleRemoteParent = join(lifecycleRoot, "Live Remote Scripts ü");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(lifecycleRemoteParent, { recursive: true });
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const controlPort = await freePort();
  let realtimePort = await freePort();
  while (realtimePort === controlPort) realtimePort = await freePort();
  const lifecycleBase = ["--remote-scripts-dir", lifecycleRemoteParent, "--state-dir", lifecycleState, "--package-root", installedPackageDirectory, "--allow-dirty-private-build"];
  const lifecycleCall = (action, extra = []) => JSON.parse(execFileSync(process.execPath, [lifecycleExecutable, action, ...lifecycleBase, ...extra], { encoding: "utf8" }));
  const installedLifecycle = lifecycleCall("install", ["--artifact", artifact, "--artifact-sha256", artifactSha256, "--port", String(controlPort), "--realtime-port", String(realtimePort), "--apply", "--confirm-live-stopped"]);
  if (installedLifecycle.state !== "completed" || installedLifecycle.verification?.artifactSha256 !== artifactSha256) throw new Error("installed lifecycle did not bind the exact tarball");
  const migratedV2Path = join(temporaryDirectory, "migrated-v2.json");
  execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "migrate.js"), "--input", configPath, "--output", migratedV2Path, "--bridge-host", "127.0.0.1", "--bridge-port", String(controlPort), "--realtime-port", String(realtimePort), "--secret-file", join(lifecycleState, "bridge.secret")], { encoding: "utf8" });
  const migratedV2 = JSON.parse(readFileSync(migratedV2Path, "utf8"));
  if (migratedV2.version !== 2 || migratedV2.bridge?.host !== "127.0.0.1" || migratedV2.server?.args?.[1] !== "--config") throw new Error("installed migration CLI did not emit an exact version-2 bridge config");
  const activationLifecycle = lifecycleCall("activate");
  if (activationLifecycle.state !== "activation-required" || activationLifecycle.verification?.provenance !== "unknown") throw new Error("installed lifecycle promoted unavailable activation evidence");
  const lifecycleRemote = join(lifecycleRemoteParent, "AbletonMcpBridge");
  writeFileSync(join(lifecycleRemote, "drift.txt"), "preserve and quarantine");
  const repairedLifecycle = lifecycleCall("repair", ["--apply"]);
  if (repairedLifecycle.state !== "completed" || repairedLifecycle.verification?.changed !== true || !repairedLifecycle.recovery?.quarantine) throw new Error("installed lifecycle repair did not quarantine drift");
  const rollbackUnavailable = spawnSync(process.execPath, [lifecycleExecutable, "rollback", ...lifecycleBase, "--apply", "--confirm-live-stopped"], { encoding: "utf8" });
  if (rollbackUnavailable.status === 0 || !rollbackUnavailable.stderr.includes("no verified previous generation")) throw new Error("installed lifecycle accepted rollback without a retained generation");
  const uninstalledLifecycle = lifecycleCall("uninstall", ["--apply", "--confirm-live-stopped"]);
  if (uninstalledLifecycle.state !== "completed" || existsSync(lifecycleRemote) || uninstalledLifecycle.verification?.secretPreserved !== true) throw new Error("installed lifecycle uninstall violated ownership or secret policy");

  const secretPath = join(temporaryDirectory, "bridge.secret");
  const bridgeConfigPath = join(temporaryDirectory, "bridge-config.json");
  const readyPath = join(temporaryDirectory, "bridge-ready.json");
  const bridgeSecret = "package-smoke-secret-0123456789abcdef0123456789";
  writeFileSync(secretPath, `${bridgeSecret}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(secretPath, 0o600);
  if (process.platform === "win32") {
    const encodedPath = Buffer.from(secretPath, "utf8").toString("base64");
    const aclScript = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ABLETON_MCP_ACL_PATH));" +
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.FileSecurity;" +
      "$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);" +
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow);" +
      "[void]$a.AddAccessRule($rule);[System.IO.File]::SetAccessControl($p,$a)";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", aclScript], { env: { ...process.env, ABLETON_MCP_ACL_PATH: encodedPath }, stdio: "pipe" });
  }
  const bridgeScript = join(temporaryDirectory, "bridge-smoke.py");
  writeFileSync(bridgeScript, `
import json, os, pathlib, socket, sys, time
from AbletonMcpBridge.ableton_mcp_remote_script import AbletonMcpBridge
class Scene:
    def __init__(self): self.name = "Package Smoke Scene"
class Track:
    def __init__(self): self.name = "Package Smoke Track"; self.clip_slots = []; self.devices = []
class Song:
    def __init__(self):
        self.tracks = [Track()]; self.return_tracks = []; self.scenes = [Scene()]; self.master_track = None
        self.is_playing = False; self.record_mode = False; self.session_record = False; self.tempo = 120.0
class Instance:
    def __init__(self): self.song = Song()
probe = socket.socket(); probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]; probe.close()
secret_path = os.environ.get("ABLETON_MCP_SMOKE_SECRET_FILE")
if not secret_path:
    raise RuntimeError("package smoke secret file was not provided through the environment")
bridge = AbletonMcpBridge(Instance(), {"host":"127.0.0.1", "port":port, "secret":pathlib.Path(secret_path).read_text(encoding="utf-8").strip()})
deadline = time.time() + 5.0
while time.time() < deadline:
    client = socket.socket(); client.settimeout(0.1)
    try:
        client.connect(("127.0.0.1", port)); client.close(); break
    except OSError:
        client.close(); bridge.update_display(); time.sleep(0.01)
else:
    bridge.disconnect(); raise RuntimeError("production bridge listener did not become reachable")
ready_path = pathlib.Path(sys.argv[1])
ready_temporary = ready_path.with_name(ready_path.name + ".tmp")
ready_temporary.write_text(json.dumps({"port":port}), encoding="utf-8")
os.replace(ready_temporary, ready_path)
try:
    while True: bridge.update_display(); time.sleep(0.01)
except KeyboardInterrupt: pass
finally: bridge.disconnect()
`, { encoding: "utf8", mode: 0o600 });
  const python = process.platform === "win32" ? "python.exe" : "python3";
  const bridgeErrorPath = join(temporaryDirectory, "bridge-smoke-stderr.log");
  bridgeProcess = spawn(python, [bridgeScript, readyPath], {
    cwd: temporaryDirectory,
    env: { ...process.env, PYTHONPATH: join(installedPackageDirectory, "remote-script"), ABLETON_MCP_SMOKE_SECRET_FILE: secretPath },
    stdio: ["ignore", "ignore", openSync(bridgeErrorPath, "w")],
  });
  try {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 20_000;
    while (!existsSync(readyPath) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 25);
    if (!existsSync(readyPath)) {
      const bridgeError = existsSync(bridgeErrorPath) ? readFileSync(bridgeErrorPath, "utf8").replaceAll(secretPath, "<redacted-secret-path>").slice(-1500) : "";
      throw new Error(`installed production bridge did not become ready${bridgeError ? `: ${bridgeError}` : ""}`);
    }
    const port = JSON.parse(readFileSync(readyPath, "utf8")).port;
    execFileSync(process.execPath, [join(installedPackageDirectory, "dist", "src", "setup.js"), "--output", bridgeConfigPath, "--bridge-host", "127.0.0.1", "--bridge-port", String(port), "--secret-file", secretPath], { encoding: "utf8" });
    const bridgeConfig = JSON.parse(readFileSync(bridgeConfigPath, "utf8"));
    const bridgeArgs = bridgeConfig.server?.args;
    if (bridgeConfig.version !== 2 || JSON.stringify(bridgeConfig).includes(bridgeSecret) || !Array.isArray(bridgeArgs) || bridgeArgs.length !== 3 || realpathSync(bridgeArgs[0]) !== realpathSync(executable) || bridgeArgs[1] !== "--config" || realpathSync(bridgeArgs[2]) !== realpathSync(bridgeConfigPath)) throw new Error("installed setup helper emitted an unsafe bridge configuration");
    const initializeBridge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "authenticated-package-smoke", version: "1" } } });
    const initializedBridge = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const liveStatus = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "live_status", arguments: {} } });
    const liveScenes = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "live_discover", arguments: { kind: "scene", limit: 4 } } });
    const authenticatedOutput = execFileSync(process.execPath, [executable, "--config", bridgeConfigPath], { cwd: installDirectory, input: `${initializeBridge}\n${initializedBridge}\n${liveStatus}\n${liveScenes}\n`, encoding: "utf8", timeout: 10_000 });
    const authenticatedResponses = authenticatedOutput.trim().split("\n").map((line) => JSON.parse(line));
    if (authenticatedResponses.length !== 3 || authenticatedResponses[0]?.id !== 1 || authenticatedResponses[1]?.id !== 2 || authenticatedResponses[2]?.id !== 3) throw new Error("authenticated package discovery did not return ordered MCP responses");
    const statusText = authenticatedResponses[1]?.result?.content?.[0]?.text ?? "";
    const sceneText = authenticatedResponses[2]?.result?.content?.[0]?.text ?? "";
    if (!statusText.includes("remote-script") || !statusText.includes("fake-live") || statusText.includes("real-live") || !sceneText.includes("Package Smoke Scene")) throw new Error("authenticated package smoke did not observe explicit fake bridge state");
  } finally {
    terminateChildProcess(bridgeProcess);
    try { bridgeProcess.unref(); } catch {}
  }
  console.log(JSON.stringify({ artifact: basename(artifact), files: names.length, installed: true, protocolSmoke: true, setupSmoke: true, migrationSmoke: true, diagnosticsSmoke: true, authenticatedBridgeSmoke: true, discoverySmoke: true, lifecycleSmoke: true, strictArtifactAllowlist: true, releaseManifestVerified: true, platform: process.platform, arch: process.arch }));
} finally {
  terminateChildProcess(bridgeProcess);
  removeTemporaryDirectory(temporaryDirectory);
}
