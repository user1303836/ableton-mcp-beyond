import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LIVE_REGISTRY_HASH } from "../src/live.js";
import { assertNoLinkedAncestors, runLifecycle, type LifecycleOptions, type LifecycleReceipt } from "../src/lifecycle.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const artifacts = new Map<string, { path: string; sha256: string }>();

function createArtifact(path: string, manifest: Buffer, packageRoot: string, extras: Record<string, string> = {}): void {
  const parsed = JSON.parse(manifest.toString("utf8"));
  const names = [...new Set(["package/package.json", "package/release-manifest.json", ...Object.keys(parsed.files).map((name) => `package/${name}`), ...Object.keys(extras)])].sort();
  const chunks: Buffer[] = [];
  for (const name of names) {
    const content = name in extras ? Buffer.from(extras[name]!) : name === "package/release-manifest.json" ? manifest : readFileSync(join(packageRoot, name.slice("package/".length)));
    const header = Buffer.alloc(512); const write = (value: string, offset: number, length: number) => header.write(value.slice(0, length), offset, "ascii");
    write(name, 0, 100); write("0000600\0", 100, 8); write("0000000\0", 108, 8); write("0000000\0", 116, 8);
    write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12); write("00000000000\0", 136, 12);
    header.fill(0x20, 148, 156); header[156] = "0".charCodeAt(0); write("ustar\0", 257, 6); write("00", 263, 2);
    const checksum = [...header].reduce((sum, value) => sum + value, 0); write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, content, Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length));
  }
  writeFileSync(path, gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])));
}

function fixturePackage(root: string, version: string, marker: string): string {
  const packageRoot = join(root, `candidate ${version} ü`);
  const packageMetadata = `${JSON.stringify({ name: "@ableton-mcp/mcp-server", version, private: true, license: "UNLICENSED", type: "module" })}\n`;
  const files = new Map<string, string>([
    ["package.json", packageMetadata],
    ["dist/src/cli.js", `#!/usr/bin/env node\n// ${marker}\n`],
    ["remote-script/AbletonMcpBridge/__init__.py", "def create_instance(c_instance):\n    return None\n"],
    ["remote-script/AbletonMcpBridge/ableton_mcp_remote_script.py", `class AbletonMcpBridge:\n    marker = ${JSON.stringify(marker)}\n`],
    ...Array.from({ length: 9 }, (_, index) => [`release-docs/doc-${index}.md`, `# ${marker} ${index}\n`] as [string, string]),
  ]);
  for (const [name, content] of files) {
    const path = join(packageRoot, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const manifest = {
    schema: "ableton-mcp-private-release/v1",
    package: { name: "@ableton-mcp/mcp-server", version, license: "UNLICENSED", private: true },
    source: { commit: marker.padEnd(40, "0").slice(0, 40), dirty: true },
    build: { runtime: "TypeScript compiled JavaScript", nodeRange: ">=22 <26", recipe: "test fixture", builder: { node: process.versions.node, npm: "fixture", typescript: "fixture", platform: process.platform, architecture: process.arch, runnerImage: "fixture", runnerImageVersion: "fixture", packageLockSha256: "a".repeat(64), workflowSha256: "b".repeat(64) } },
    protocol: { registryHash: LIVE_REGISTRY_HASH },
    distribution: { channel: "private-local-npm-tarball", published: false, signed: false, notarized: false },
    algorithm: "sha256",
    files: Object.fromEntries([...files].map(([name, content]) => [name, sha(content)])),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  writeFileSync(join(packageRoot, "release-manifest.json"), manifestBytes);
  const artifactPath = join(root, `candidate-${version}-${marker}.tgz`);
  createArtifact(artifactPath, manifestBytes, packageRoot);
  artifacts.set(packageRoot, { path: artifactPath, sha256: sha(readFileSync(artifactPath)) });
  return packageRoot;
}

function artifactOptions(packageRoot: string) { return { artifactPath: artifacts.get(packageRoot)!.path, artifactSha256: artifacts.get(packageRoot)!.sha256 }; }

function lifecycleOptions(root: string, packageRoot: string, action: LifecycleOptions["action"], overrides: Partial<LifecycleOptions> = {}): LifecycleOptions {
  const remoteScriptsDirectory = join(root, "Live Remote Scripts ü");
  mkdirSync(remoteScriptsDirectory, { recursive: true });
  return {
    action,
    packageRoot,
    stateDirectory: join(root, "State ü space"),
    remoteScriptsDirectory,
    artifactPath: artifacts.get(packageRoot)!.path,
    artifactSha256: artifacts.get(packageRoot)!.sha256,
    host: "127.0.0.1",
    port: 19_765,
    realtimePort: 19_766,
    apply: true,
    confirmLiveStopped: true,
    allowDirtyPrivateBuild: true,
    ...overrides,
  };
}

function receipt(options: LifecycleOptions): LifecycleReceipt {
  return JSON.parse(readFileSync(join(options.stateDirectory, "install-receipt.json"), "utf8")) as LifecycleReceipt;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function withPorts(options: LifecycleOptions): Promise<LifecycleOptions> {
  const port = await freePort();
  let realtimePort = await freePort();
  while (realtimePort === port) realtimePort = await freePort();
  return { ...options, port, realtimePort };
}

test("lifecycle plan is non-mutating and consequential actions require explicit stopped confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-plan-"));
  try {
    const packageRoot = fixturePackage(root, "1.0.0", "one");
    const options = await withPorts(lifecycleOptions(root, packageRoot, "install", { apply: false, confirmLiveStopped: false }));
    await assert.rejects(runLifecycle({ ...options, artifactSha256: "0".repeat(64) }), /does not match the exact tarball bytes/);
    const oversized = join(root, "oversized.tgz"); writeFileSync(oversized, "x"); truncateSync(oversized, 32 * 1024 * 1024 + 1);
    await assert.rejects(runLifecycle({ ...options, artifactPath: oversized, artifactSha256: "0".repeat(64) }), /bounded compressed size/);
    const decompressionBomb = join(root, "decompression-bomb.tgz"); writeFileSync(decompressionBomb, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
    await assert.rejects(runLifecycle({ ...options, artifactPath: decompressionBomb, artifactSha256: sha(readFileSync(decompressionBomb)) }), /bounded decompressed size/);
    const evilArtifact = join(root, "candidate-with-extra.tgz");
    createArtifact(evilArtifact, readFileSync(join(packageRoot, "release-manifest.json")), packageRoot, { "package/evil.js": "not allowlisted" });
    await assert.rejects(runLifecycle({ ...options, artifactPath: evilArtifact, artifactSha256: sha(readFileSync(evilArtifact)) }), /inventory differs/);
    const unknownPackageFile = join(packageRoot, "unknown.txt"); writeFileSync(unknownPackageFile, "drift"); await assert.rejects(runLifecycle(options), /root inventory differs/); rmSync(unknownPackageFile);
    const unknownPackageDirectory = join(packageRoot, "unknown-empty"); mkdirSync(unknownPackageDirectory); await assert.rejects(runLifecycle(options), /unknown directory/); rmSync(unknownPackageDirectory, { recursive: true });
    const plan = await runLifecycle(options);
    assert.equal(plan.state, "planned");
    assert.equal(existsSync(options.stateDirectory), false);
    await assert.rejects(runLifecycle({ ...options, apply: true }), /confirm-live-stopped/);
    assert.equal(existsSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installs into paths with spaces and Unicode, records exact artifact identity, and keeps activation truthful", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-install-"));
  try {
    const packageRoot = fixturePackage(root, "1.0.0", "one");
    const options = await withPorts(lifecycleOptions(root, packageRoot, "install"));
    const installed = await runLifecycle(options);
    assert.equal(installed.state, "completed");
    assert.equal(installed.restartRequired, true);
    const saved = receipt(options);
    assert.equal(saved.artifactSha256, options.artifactSha256);
    assert.equal(saved.packageVersion, "1.0.0");
    assert.equal(saved.status, "installed-restart-required");
    assert.equal(Object.keys(saved.remoteFiles).length, 6);
    assert.ok(existsSync(saved.configPath) && existsSync(saved.secretPath));
    if (process.platform !== "win32") {
      assert.equal(lstatSync(saved.secretPath).mode & 0o777, 0o600);
      assert.equal(lstatSync(join(options.stateDirectory, "install-receipt.json")).mode & 0o777, 0o600);
    }
    const activation = await runLifecycle({ ...options, action: "activate", apply: false, confirmLiveStopped: false });
    assert.equal(activation.state, "activation-required");
    assert.equal(receipt(options).activation.realLiveVerified, false);
    const status = await runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false });
    assert.equal((status.verification.receipt as any).artifactSha256, options.artifactSha256);
    assert.equal((status.verification.remoteScript as any).valid, true);

    // A receipt-bound regular file at Python's cache-directory path prevents
    // Live from creating or loading unverified generated bytecode.
    const remote = join(options.remoteScriptsDirectory, "AbletonMcpBridge");
    const cacheBlocker = join(remote, "__pycache__");
    assert.equal(lstatSync(cacheBlocker).isFile(), true);
    assert.equal(lstatSync(cacheBlocker).size, 0);
    assert.equal(saved.remoteFiles["__pycache__"], sha(""));
    rmSync(cacheBlocker); mkdirSync(cacheBlocker);
    writeFileSync(join(cacheBlocker, "__init__.cpython-311.pyc"), Buffer.alloc(32));
    const rogueStatus = await runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false });
    assert.equal((rogueStatus.verification.remoteScript as any).valid, false);
    assert.deepEqual((rogueStatus.verification.remoteScript as any).missing, ["__pycache__"]);
    assert.deepEqual((rogueStatus.verification.remoteScript as any).unknown, ["__pycache__/__init__.cpython-311.pyc"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy receipts cannot bypass the managed Python cache blocker and repair migrates them", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-cache-migration-"));
  try {
    const packageRoot = fixturePackage(root, "1.0.0", "one");
    const options = await withPorts(lifecycleOptions(root, packageRoot, "install"));
    await runLifecycle(options);
    const saved = receipt(options); delete saved.remoteFiles["__pycache__"];
    writeFileSync(join(options.stateDirectory, "install-receipt.json"), `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    rmSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "__pycache__"));
    const unsafe = await runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false });
    assert.equal((unsafe.verification.remoteScript as any).valid, false);
    assert.deepEqual((unsafe.verification.remoteScript as any).missing, ["__pycache__"]);
    const activation = await runLifecycle({ ...options, action: "activate", apply: false, confirmLiveStopped: false });
    assert.equal((activation.verification as any).installationValid, false);
    const repaired = await runLifecycle({ ...options, action: "repair" });
    assert.equal(repaired.state, "completed");
    const migrated = receipt(options);
    assert.equal(migrated.remoteFiles["__pycache__"], sha(""));
    assert.equal(lstatSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "__pycache__")).isFile(), true);
    const healthy = await runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false });
    assert.equal((healthy.verification.remoteScript as any).valid, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses occupied ports before creating lifecycle state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-port-"));
  const server = createServer();
  try {
    const packageRoot = fixturePackage(root, "1.0.0", "one");
    await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolvePromise()); });
    const address = server.address();
    const occupied = typeof address === "object" && address ? address.port : 0;
    const options = lifecycleOptions(root, packageRoot, "install", { port: occupied, realtimePort: await freePort() });
    await assert.rejects(runLifecycle(options), /port .* occupied/);
    assert.equal(existsSync(options.stateDirectory), false);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rolls back every injected install failure without leaving authority or Remote Script residue", async () => {
  for (const faultAt of ["after-secret", "after-config", "after-remote", "before-receipt"] as const) {
    const root = mkdtempSync(join(tmpdir(), `ableton-lifecycle-fault-${faultAt}-`));
    try {
      const packageRoot = fixturePackage(root, "1.0.0", "one");
      const options = await withPorts(lifecycleOptions(root, packageRoot, "install", { faultAt }));
      await assert.rejects(runLifecycle(options), /injected lifecycle failure/);
      assert.equal(existsSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge")), false);
      assert.equal(existsSync(options.configPath ?? join(options.stateDirectory, "bridge-config.json")), false);
      assert.equal(existsSync(options.secretPath ?? join(options.stateDirectory, "bridge.secret")), false);
      assert.equal(existsSync(join(options.stateDirectory, "install-receipt.json")), false);
      assert.match(readFileSync(join(options.stateDirectory, "lifecycle-journal.json"), "utf8"), /failed-rolled-back/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("detects drift, quarantines it, and repairs only managed payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-repair-"));
  try {
    const packageRoot = fixturePackage(root, "1.0.0", "one");
    const options = await withPorts(lifecycleOptions(root, packageRoot, "install"));
    await runLifecycle(options);
    const otherPackage = fixturePackage(root, "2.0.0", "other");
    await assert.rejects(runLifecycle({ ...options, action: "repair", packageRoot: otherPackage }), /exact receipt-bound generation/);
    const configPath = receipt(options).configPath; rmSync(configPath);
    await assert.rejects(runLifecycle({ ...options, action: "repair", faultAt: "after-repair-install" }), /injected lifecycle failure/);
    assert.equal(existsSync(configPath), false);
    const remote = join(options.remoteScriptsDirectory, "AbletonMcpBridge");
    writeFileSync(join(remote, "unknown.txt"), "operator content");
    writeFileSync(join(remote, "ableton_mcp_remote_script.py"), "corrupt");
    if (process.platform !== "win32") chmodSync(receipt(options).secretPath, 0o644);
    const repaired = await runLifecycle({ ...options, action: "repair" });
    assert.equal(repaired.state, "completed");
    assert.equal((repaired.verification.priorDrift as any).valid, false);
    assert.ok(repaired.recovery.quarantine && existsSync(join(repaired.recovery.quarantine, "unknown.txt")));
    assert.equal(readFileSync(join(remote, "ableton_mcp_remote_script.py"), "utf8").includes("marker = \"one\""), true);
    if (process.platform !== "win32") assert.equal(lstatSync(receipt(options).secretPath).mode & 0o777, 0o600);
    const status = await runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false });
    assert.equal((status.verification.remoteScript as any).valid, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrades, retains an exact generation, rolls back, and survives failed upgrade", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-upgrade-"));
  try {
    const packageOne = fixturePackage(root, "1.0.0", "one");
    const packageTwo = fixturePackage(root, "2.0.0", "two");
    const packageThree = fixturePackage(root, "3.0.0", "three");
    let options = await withPorts(lifecycleOptions(root, packageOne, "install"));
    await runLifecycle(options);
    const upgraded = await runLifecycle({ ...options, action: "upgrade", packageRoot: packageTwo, ...artifactOptions(packageTwo) });
    assert.equal(upgraded.recovery.rollbackAvailable, true);
    assert.equal(receipt(options).packageVersion, "2.0.0");
    assert.match(readFileSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "ableton_mcp_remote_script.py"), "utf8"), /two/);
    const beforeFailedRollback = receipt(options);
    await assert.rejects(runLifecycle({ ...options, action: "rollback", packageRoot: packageTwo, faultAt: "after-rollback-config" }), /injected lifecycle failure/);
    assert.equal(receipt(options).packageVersion, "2.0.0");
    assert.match(readFileSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "ableton_mcp_remote_script.py"), "utf8"), /two/);
    assert.deepEqual(JSON.parse(readFileSync(beforeFailedRollback.configPath, "utf8")), beforeFailedRollback.config);
    const rolledBack = await runLifecycle({ ...options, action: "rollback", packageRoot: packageTwo });
    assert.equal(rolledBack.state, "completed");
    assert.equal(receipt(options).packageVersion, "1.0.0");
    assert.match(readFileSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "ableton_mcp_remote_script.py"), "utf8"), /one/);

    // Roll forward again, then prove a failure after replacement restores the
    // active generation and leaves the owner receipt unchanged.
    await runLifecycle({ ...options, action: "upgrade", packageRoot: packageTwo, ...artifactOptions(packageTwo) });
    await assert.rejects(runLifecycle({ ...options, action: "upgrade", packageRoot: packageOne, ...artifactOptions(packageOne) }), /strictly newer semantic package version/);
    const before = receipt(options);
    await assert.rejects(runLifecycle({ ...options, action: "upgrade", packageRoot: packageThree, ...artifactOptions(packageThree), faultAt: "before-remote" }), /injected lifecycle failure/);
    assert.equal(receipt(options).generation, before.generation);
    assert.match(readFileSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "ableton_mcp_remote_script.py"), "utf8"), /two/);
    await assert.rejects(runLifecycle({ ...options, action: "upgrade", packageRoot: packageThree, ...artifactOptions(packageThree), faultAt: "after-remote" }), /injected lifecycle failure/);
    assert.equal(receipt(options).generation, before.generation);
    assert.match(readFileSync(join(options.remoteScriptsDirectory, "AbletonMcpBridge", "ableton_mcp_remote_script.py"), "utf8"), /two/);
    const retired = receipt(options).previous!.remoteBackup;
    const third = await runLifecycle({ ...options, action: "upgrade", packageRoot: packageThree, ...artifactOptions(packageThree), faultAt: "retired-cleanup-blocked" });
    assert.deepEqual(third.verification.pendingCleanup, [retired]); assert.deepEqual(receipt(options).retained?.pendingCleanup, [retired]);
    const status = await runLifecycle({ ...options, action: "status", packageRoot: join(root, "removed-package"), apply: false, confirmLiveStopped: false });
    assert.equal(status.recovery.quarantine, retired);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall retires an owned rollback generation and supports idempotent pending cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-uninstall-upgrade-"));
  try {
    const packageOne = fixturePackage(root, "1.0.0", "one"); const packageTwo = fixturePackage(root, "2.0.0", "two");
    const options = await withPorts(lifecycleOptions(root, packageOne, "install")); await runLifecycle(options);
    await runLifecycle({ ...options, action: "upgrade", packageRoot: packageTwo, ...artifactOptions(packageTwo) });
    const prior = receipt(options).previous!.remoteBackup; assert.equal(existsSync(prior), true);
    const activePending = join(options.stateDirectory, "quarantine", "active-pending"); mkdirSync(activePending, { recursive: true }); writeFileSync(join(activePending, "file"), "cleanup");
    const activeReceiptPath = join(options.stateDirectory, "install-receipt.json"); const activeReceipt = receipt(options); activeReceipt.retained = { pendingCleanup: [activePending], preserved: [] }; writeFileSync(activeReceiptPath, `${JSON.stringify(activeReceipt)}\n`, { mode: 0o600 }); if (process.platform !== "win32") chmodSync(activeReceiptPath, 0o600);
    await runLifecycle({ ...options, action: "uninstall", packageRoot: join(root, "removed-package"), purgeSecret: true });
    assert.equal(existsSync(prior), false); assert.equal(existsSync(activePending), false); assert.deepEqual(receipt(options).retained, { pendingCleanup: [], preserved: [] });
    const pending = join(options.stateDirectory, "quarantine", "pending-test"); mkdirSync(pending, { recursive: true }); writeFileSync(join(pending, "file"), "cleanup");
    const receiptPath = join(options.stateDirectory, "install-receipt.json"); const saved = receipt(options); saved.retained = { pendingCleanup: [pending], preserved: [] }; writeFileSync(receiptPath, `${JSON.stringify(saved)}\n`, { mode: 0o600 }); if (process.platform !== "win32") chmodSync(receiptPath, 0o600);
    const retried = await runLifecycle({ ...options, action: "uninstall", packageRoot: join(root, "removed-package") });
    assert.equal(retried.verification.alreadyUninstalled, true); assert.equal(existsSync(pending), false); assert.deepEqual(receipt(options).retained, { pendingCleanup: [], preserved: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall removes exact owned files, preserves secrets by default, purges explicitly, and quarantines drift", async () => {
  for (const drift of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), `ableton-lifecycle-uninstall-${drift}-`));
    try {
      const packageRoot = fixturePackage(root, "1.0.0", "one");
      const options = await withPorts(lifecycleOptions(root, packageRoot, "install"));
      await runLifecycle(options);
      const saved = receipt(options);
      if (drift) {
        writeFileSync(join(saved.remoteScriptDirectory, "operator.txt"), "preserve me");
        rmSync(packageRoot, { recursive: true, force: true });
        const recoverableStatus = await runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false });
        assert.equal(recoverableStatus.state, "completed");
      }
      const removed = await runLifecycle({ ...options, action: "uninstall", purgeSecret: !drift });
      assert.equal(existsSync(saved.remoteScriptDirectory), false);
      assert.equal(receipt(options).status, "uninstalled");
      if (drift) {
        assert.ok(removed.recovery.quarantine && existsSync(join(removed.recovery.quarantine, "operator.txt")));
        assert.equal(existsSync(saved.secretPath), true);
      } else {
        assert.equal(existsSync(saved.secretPath), false);
        assert.equal(removed.verification.configRemoved, true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("serializes lifecycle mutations and rejects a linked owner receipt", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-owner-state-"));
  try {
    const packageRoot = fixturePackage(root, "1.0.0", "one");
    const options = await withPorts(lifecycleOptions(root, packageRoot, "install"));
    await runLifecycle(options);
    const lock = join(options.stateDirectory, "lifecycle.lock");
    writeFileSync(lock, "owned elsewhere", { mode: 0o600 });
    await assert.rejects(runLifecycle({ ...options, action: "repair" }), /another lifecycle operation owns the state lock/);
    rmSync(lock);
    if (process.platform !== "win32") {
      const receiptPath = join(options.stateDirectory, "install-receipt.json");
      const moved = join(root, "moved-receipt.json"); renameSync(receiptPath, moved); symlinkSync(moved, receiptPath);
      await assert.rejects(runLifecycle({ ...options, action: "status", apply: false, confirmLiveStopped: false }), /symbolic-link or junction ancestor/);
    } else context.diagnostic("linked receipt coverage requires optional Windows symbolic-link privilege; hosted junction coverage uses lifecycle paths");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects symlink ancestors and malformed CLI options", async (context) => {
  if (process.platform !== "win32") {
    const root = mkdtempSync(join(tmpdir(), "ableton-lifecycle-link-"));
    try {
      const real = join(root, "real"); mkdirSync(real);
      const linked = join(root, "linked"); symlinkSync(real, linked, "dir");
      assert.throws(() => assertNoLinkedAncestors(join(linked, "child")), /symbolic-link or junction ancestor/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  } else context.diagnostic("symlink creation requires optional Windows privilege; junction coverage runs in hosted lifecycle smoke");
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lifecycle-cli.js");
  const invalid = spawnSync(process.execPath, [cli, "install", "--unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /lifecycle-error/);
});
