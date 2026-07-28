import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { npmExecutable } from "../dist/src/platform.js";

const [artifact, metadataPath] = process.argv.slice(2);
if (!artifact || !metadataPath) throw new Error("usage: verify-candidate.mjs ARTIFACT METADATA");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const bytes = readFileSync(artifact);
const digest = createHash("sha256").update(bytes).digest("hex");
if (metadata.schema !== "ableton-mcp-candidate/v1" || metadata.sha256 !== digest || metadata.filename !== artifact.split(/[\\/]/).at(-1) || !/^[a-f0-9]{40}$/.test(metadata.gitSha)) throw new Error("candidate metadata or digest is invalid");
const checkoutSha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (metadata.gitSha !== checkoutSha) throw new Error("candidate Git SHA does not match this exact checkout");

const npm = npmExecutable();
const npmOptions = { shell: process.platform === "win32" };
const temporaryDirectory = mkdtempSync(join(tmpdir(), "ableton-candidate-"));
const installDirectory = join(temporaryDirectory, "install");

const freePort = async () => await new Promise((resolve, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); });
});
const walk = (root) => {
  const names = [];
  const visit = (directory) => { for (const name of readdirSync(directory).sort()) { const path = join(directory, name); const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`installed candidate contains a link: ${path}`); if (stat.isDirectory()) visit(path); else if (stat.isFile()) names.push(relative(root, path).split(sep).join("/")); else throw new Error("installed candidate contains a special file"); } };
  visit(root); return names;
};

try {
  execFileSync(npm, ["install", "--prefix", installDirectory, artifact, "--ignore-scripts", "--no-audit", "--no-fund"], { ...npmOptions, stdio: "pipe" });
  const packageRoot = join(installDirectory, "node_modules", "@ableton-mcp", "mcp-server");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "release-manifest.json"), "utf8"));
  if (manifest.schema !== "ableton-mcp-private-release/v1" || manifest.source?.commit !== metadata.gitSha || manifest.source?.dirty !== false || manifest.distribution?.published !== false || manifest.distribution?.signed !== false || manifest.distribution?.notarized !== false || !/^[a-f0-9]{64}$/.test(manifest.build?.builder?.packageLockSha256 ?? "") || !/^[a-f0-9]{64}$/.test(manifest.build?.builder?.workflowSha256 ?? "")) throw new Error("candidate does not identify the exact clean Git SHA and private channel");
  const inventory = walk(packageRoot).filter((name) => name !== "package.json").sort();
  const expected = ["release-manifest.json", ...Object.keys(manifest.files)].sort();
  if (JSON.stringify(inventory) !== JSON.stringify(expected)) throw new Error("installed candidate inventory differs from the strict release manifest");
  for (const [name, expectedDigest] of Object.entries(manifest.files)) {
    const path = join(packageRoot, ...name.split("/"));
    if (!statSync(path).isFile() || createHash("sha256").update(readFileSync(path)).digest("hex") !== expectedDigest) throw new Error(`candidate payload hash mismatch: ${name}`);
  }

  const lifecycleRoot = join(temporaryDirectory, "Candidate Lifecycle ü space");
  const remoteScripts = join(lifecycleRoot, "Live Remote Scripts ü");
  const state = join(lifecycleRoot, "State ü");
  mkdirSync(remoteScripts, { recursive: true });
  const lifecycle = join(packageRoot, "dist", "src", "lifecycle-cli.js");
  const controlPort = await freePort(); let realtimePort = await freePort(); while (realtimePort === controlPort) realtimePort = await freePort();
  const base = ["--remote-scripts-dir", remoteScripts, "--state-dir", state, "--package-root", packageRoot];
  const call = (action, extra = []) => JSON.parse(execFileSync(process.execPath, [lifecycle, action, ...base, ...extra], { encoding: "utf8" }));
  const plan = call("install", ["--artifact", artifact, "--artifact-sha256", digest, "--port", String(controlPort), "--realtime-port", String(realtimePort)]);
  if (plan.applied || plan.state !== "planned" || existsSync(state)) throw new Error("candidate lifecycle plan mutated state");
  const installed = call("install", ["--artifact", artifact, "--artifact-sha256", digest, "--port", String(controlPort), "--realtime-port", String(realtimePort), "--apply", "--confirm-live-stopped"]);
  if (installed.state !== "completed" || installed.verification?.artifactSha256 !== digest || installed.verification?.secretPermissions !== "owner-only") throw new Error("candidate lifecycle install failed identity or permission checks");
  let junctionRejected = "not-applicable";
  if (process.platform === "win32") {
    const junction = join(lifecycleRoot, "Remote Scripts Junction");
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", junction, remoteScripts], { stdio: "ignore" });
    const linkedStatus = spawnSync(process.execPath, [lifecycle, "status", "--remote-scripts-dir", junction, "--state-dir", state, "--package-root", packageRoot], { encoding: "utf8" });
    try { execFileSync("cmd.exe", ["/d", "/c", "rmdir", junction], { stdio: "ignore" }); } catch {}
    if (linkedStatus.status === 0 || !linkedStatus.stderr.includes("junction ancestor")) throw new Error("candidate lifecycle accepted a Windows junction path");
    junctionRejected = "verified";
  }
  let quarantineJunctionRejected = "not-applicable";
  if (process.platform === "win32") {
    const outside = join(lifecycleRoot, "Outside Quarantine"); mkdirSync(outside);
    const quarantine = join(state, "quarantine");
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", quarantine, outside], { stdio: "ignore" });
    const driftPath = join(remoteScripts, "AbletonMcpBridge", "junction-drift.txt"); writeFileSync(driftPath, "must not escape owner state");
    const escapedRepair = spawnSync(process.execPath, [lifecycle, "repair", ...base, "--apply"], { encoding: "utf8" });
    rmSync(driftPath, { force: true }); try { execFileSync("cmd.exe", ["/d", "/c", "rmdir", quarantine], { stdio: "ignore" }); } catch {}
    if (escapedRepair.status === 0 || !escapedRepair.stderr.includes("junction ancestor")) throw new Error("candidate lifecycle accepted a quarantine junction");
    quarantineJunctionRejected = "verified";
  }
  const activated = call("activate");
  if (activated.state !== "activation-required" || activated.verification?.liveConnected !== false) throw new Error("candidate lifecycle promoted unavailable Live activation");
  let aclRepair = "not-applicable";
  if (process.platform === "win32") {
    const secret = join(state, "bridge.secret");
    execFileSync("icacls.exe", [secret, "/inheritance:e"], { stdio: "ignore" });
    const insecure = call("status");
    if (insecure.verification?.secretPermissions !== "invalid") throw new Error("candidate lifecycle did not detect broadened Windows secret ACL");
    const repairedAcl = call("repair", ["--apply"]);
    if (repairedAcl.state !== "completed" || repairedAcl.verification?.secretPermissions !== "owner-only") throw new Error("candidate lifecycle did not repair and verify the Windows secret ACL");
    aclRepair = "verified";
  }
  let heldFileOutcome = "not-applicable";
  if (process.platform === "win32") {
    const remote = join(remoteScripts, "AbletonMcpBridge");
    const held = join(remote, "ableton_mcp_remote_script.py");
    const marker = join(temporaryDirectory, "held-ready.txt");
    writeFileSync(join(remote, "held-drift.txt"), "must be preserved or repaired");
    const script = "$f=[IO.File]::Open($env:HELD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[IO.File]::WriteAllText($env:HELD_MARKER,'ready');Start-Sleep -Seconds 30;$f.Dispose()";
    const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, HELD_FILE: held, HELD_MARKER: marker }, stdio: "ignore" });
    const wait = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 25);
    if (!existsSync(marker)) throw new Error("Windows held-file fixture did not become ready");
    const blockedRepair = spawnSync(process.execPath, [lifecycle, "repair", ...base, "--apply"], { encoding: "utf8" });
    try { holder.kill(); } catch {}
    try { execFileSync("taskkill.exe", ["/PID", String(holder.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    if (blockedRepair.status === 0) {
      const safe = JSON.parse(blockedRepair.stdout);
      if (safe.verification?.changed !== true || !safe.recovery?.quarantine) throw new Error("held-file repair succeeded without safe quarantine semantics");
      heldFileOutcome = "atomic-quarantine-succeeded";
    } else {
      const recovered = call("repair", ["--apply"]);
      if (recovered.state !== "completed" || recovered.verification?.changed !== true) throw new Error("held-file failure was not recoverable after handle release");
      heldFileOutcome = "blocked-then-recovered";
    }
  }
  const cleanRepair = call("repair", ["--apply"]);
  if (cleanRepair.state !== "completed" || cleanRepair.verification?.changed !== false) throw new Error("candidate lifecycle repair is not idempotent");
  const status = call("status");
  if (status.verification?.receipt?.artifactSha256 !== digest || status.verification?.remoteScript?.valid !== true) throw new Error("candidate lifecycle status lost artifact identity");
  const rollback = spawnSync(process.execPath, [lifecycle, "rollback", ...base, "--apply", "--confirm-live-stopped"], { encoding: "utf8" });
  if (rollback.status === 0 || !rollback.stderr.includes("no verified previous generation")) throw new Error("candidate lifecycle accepted an unowned rollback");
  const removed = call("uninstall", ["--apply", "--confirm-live-stopped", "--purge-secret"]);
  if (removed.state !== "completed" || removed.verification?.remoteRemoved !== true || removed.verification?.secretPurged !== true) throw new Error("candidate lifecycle uninstall failed");

  console.log(JSON.stringify({ schema: "ableton-mcp-candidate-verification/v1", gitSha: metadata.gitSha, artifactSha256: digest, platform: process.platform, arch: process.arch, node: process.versions.node, strictInventory: true, manifestHashes: Object.keys(manifest.files).length, lifecycle: { plan: true, install: true, activationUnavailable: true, repair: true, aclRepair, heldFileOutcome, junctionRejected, quarantineJunctionRejected, rollbackRefusal: true, uninstall: true }, provenance: "package-contract-no-live" }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
