import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const docsRoot = join(packageRoot, "release-docs");
const licenseDestination = join(packageRoot, "LICENSE.md");
const releaseManifestPath = join(packageRoot, "release-manifest.json");

const documentation = [
  ["README.md", "README.md"],
  ["docs/USER_GUIDE.md", "USER_GUIDE.md"],
  ["docs/USER_JOURNEYS.md", "USER_JOURNEYS.md"],
  ["docs/OPERATIONS.md", "OPERATIONS.md"],
  ["docs/RECOVERY.md", "RECOVERY.md"],
  ["docs/LIVE_SAFETY.md", "LIVE_SAFETY.md"],
  ["docs/AUDIO_INTELLIGENCE.md", "AUDIO_INTELLIGENCE.md"],
  ["docs/REALTIME_CONTROL.md", "REALTIME_CONTROL.md"],
  ["docs/DELIVERY.md", "DELIVERY.md"],
  ["docs/DEVELOPER_GUIDE.md", "DEVELOPER_GUIDE.md"],
  ["docs/TESTING.md", "TESTING.md"],
  ["docs/IMPLEMENTATION_STATUS.md", "IMPLEMENTATION_STATUS.md"],
  ["docs/DISTRIBUTION_POLICY.md", "DISTRIBUTION_POLICY.md"],
  ["docs/SUPPORT_MATRIX.md", "SUPPORT_MATRIX.md"],
  ["docs/CAPABILITY_MATRIX.md", "CAPABILITY_MATRIX.md"],
];

rmSync(docsRoot, { recursive: true, force: true });
mkdirSync(docsRoot, { recursive: true });
for (const [sourceRelative, destinationName] of documentation) {
  const source = join(repositoryRoot, sourceRelative);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`release documentation is missing: ${sourceRelative}`);
  let packaged = readFileSync(source, "utf8").replace(/\[([^\]]+)\]\(evidence\/[^)]+\)/g, "$1 (repository-only evidence; excluded from the private tarball)");
  if (sourceRelative === "README.md") packaged = packaged
    .replaceAll("(docs/", "(")
    .replaceAll("(protocol/ableton-live-v1.operations.json)", "(../remote-script/AbletonMcpBridge/ableton-live-v1.operations.json)");
  writeFileSync(join(docsRoot, destinationName), packaged, "utf8");
}
cpSync(join(repositoryRoot, "LICENSE.md"), licenseDestination);

const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const typescriptPackage = JSON.parse(readFileSync(join(packageRoot, "node_modules", "typescript", "package.json"), "utf8"));
const packageLockSha256 = createHash("sha256").update(readFileSync(join(packageRoot, "package-lock.json"))).digest("hex");
const workflowSha256 = createHash("sha256").update(readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"))).digest("hex");
const npmVersion = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const remoteManifest = JSON.parse(readFileSync(join(packageRoot, "remote-script", "AbletonMcpBridge", "manifest.json"), "utf8"));
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const files = {};
const roles = {};
const include = (absolute, role) => {
  const path = relative(packageRoot, absolute).split(sep).join("/");
  files[path] = digest(absolute);
  roles[path] = role;
};
const runtimeModules = ["analysis-job-worker", "analysis-runner", "analysis", "audio-diagnosis", "audio-file", "audio-standards", "bridge/remote-adapter", "cli", "delivery", "diagnostics", "framing", "host", "index", "install-remote-script", "journeys", "lifecycle-cli", "lifecycle", "live", "loopback", "migrate", "platform", "project", "reference-analysis", "registry", "setup", "stdio", "transactions/session-midi"];
for (const module of runtimeModules) for (const extension of ["js", "d.ts"]) {
  const path = join(packageRoot, "dist", "src", `${module}.${extension}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`allowlisted runtime artifact is missing: ${module}.${extension}`);
  include(path, "compiled-runtime");
}
const remoteFiles = ["README.md", "AbletonMcpBridge/__init__.py", "AbletonMcpBridge/ableton_mcp_remote_script.py", "AbletonMcpBridge/ableton-live-v1.operations.json", "AbletonMcpBridge/manifest.json"];
for (const name of remoteFiles) include(join(packageRoot, "remote-script", ...name.split("/")), "ableton-remote-script");
for (const [, name] of documentation) include(join(docsRoot, name), "documentation");
include(licenseDestination, "private-license");

let sourceCommit = "unavailable";
let sourceCommitTimestamp = "unavailable";
let sourceTreeDirty = true;
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  sourceCommitTimestamp = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  sourceTreeDirty = status.trim().length > 0;
} catch {}

const manifest = {
  schema: "ableton-mcp-private-release/v1",
  package: { name: packageJson.name, version: packageJson.version, license: packageJson.license, private: packageJson.private === true },
  source: { commit: sourceCommit, commitTimestamp: sourceCommitTimestamp, dirty: sourceTreeDirty },
  build: { runtime: "TypeScript compiled JavaScript", nodeRange: packageJson.engines?.node, builder: { node: process.versions.node, npm: npmVersion, typescript: typescriptPackage.version, platform: process.platform, architecture: process.arch, runnerImage: process.env.ImageOS ?? "local", runnerImageVersion: process.env.ImageVersion ?? "local", packageLockSha256, workflowSha256 }, recipe: "npm ci && npm run typecheck && npm test && npm run property-test && npm run coverage && npm run benchmark && npm run audio:oracle && npm run compatibility && npm pack" },
  protocol: { host: "2025-11-25", bridge: "ableton-live/v1", registryHash: remoteManifest.registryHash },
  distribution: { channel: "private-local-npm-tarball", published: false, signed: false, notarized: false, integrityIsIdentityProof: false },
  exclusions: ["tests", "verification-scripts", "source-maps", "credentials", "configuration", "local-state", "logs", "backups", "captured-media", "generated-evidence", "dependency-trees", "protected-local-material"],
  algorithm: "sha256",
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  roles: Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(releaseManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.error(`staged ${Object.keys(files).length} release payload files for ${basename(packageRoot)}`);
