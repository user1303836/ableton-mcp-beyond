#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const majors = packageJson.abletonMcpSupport?.nodeMajors;
if (!Array.isArray(majors) || majors.length === 0 || majors.some((major) => !Number.isSafeInteger(major) || major < 1) || new Set(majors).size !== majors.length || !majors.every((major, index) => index === 0 || major > majors[index - 1])) throw new Error("abletonMcpSupport.nodeMajors must be a nonempty ascending unique integer list");
const expectedMajors = [22, 24, 25];
if (JSON.stringify(majors) !== JSON.stringify(expectedMajors)) throw new Error(`canonical Node policy must remain ${expectedMajors.join(", ")} until the complete matrix changes`);
const expectedEngine = majors.map((major) => `>=${major} <${major + 1}`).join(" || ");
if (packageJson.engines?.node !== expectedEngine) throw new Error(`package engines.node must be the canonical disjoint range: ${expectedEngine}`);
for (let major = 21; major <= 27; major += 1) {
  const admitted = semver.satisfies(`${major}.0.0`, packageJson.engines.node, { includePrerelease: false });
  if (admitted !== majors.includes(major)) throw new Error(`Node ${major} engine admission disagrees with canonical policy`);
}
for (const version of ["22.0.0-rc.1", "24.0.0-nightly.1", "not-a-version"]) if (semver.satisfies(version, packageJson.engines.node, { includePrerelease: false })) throw new Error(`unstable or malformed Node version was admitted: ${version}`);

const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const nodeJob = workflow.match(/^  node:\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n)/m)?.[1];
if (!nodeJob) throw new Error("CI Node job is missing");
const matrixMatch = nodeJob.match(/^\s*node:\s*\[([^\]]+)\]\s*$/m);
if (!matrixMatch) throw new Error("CI Node matrix is missing or dynamic");
const matrix = matrixMatch[1].split(",").map((value) => Number(value.trim()));
if (JSON.stringify(matrix) !== JSON.stringify(majors) || !/^\s*fail-fast:\s*false\s*$/m.test(nodeJob)) throw new Error("CI Node matrix semantics disagree with canonical package policy");
const pythonJob = workflow.match(/^  remote-script:\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n)/m)?.[1];
if (!pythonJob || !/^\s*fail-fast:\s*false\s*$/m.test(pythonJob)) throw new Error("CI Python matrix must remain complete after a failure");
const requiredJob = workflow.match(/^  required:\n([\s\S]*)$/m)?.[1];
const requiredFragments = [
  "name: Required CI",
  "if: always()",
  "needs: [candidate, node, remote-script]",
  'test "${{ needs.candidate.result }}" = "success"',
  'test "${{ needs.node.result }}" = "success"',
  'test "${{ needs.remote-script.result }}" = "success"',
];
if (!requiredJob || requiredFragments.some((fragment) => !requiredJob.includes(fragment)) || !workflow.includes("- run: npm run package:verify")) throw new Error("CI lacks the complete fixed Required CI aggregate gate");

const badgePath = `node-${majors.join("%20%7C%20")}-339933`;
const badgeAlt = `Node ${majors.join(" | ")}`;
for (const name of ["README.md", "README.ja.md", "README.zh-CN.md"]) {
  const value = readFileSync(resolve(repositoryRoot, name), "utf8");
  if (!value.includes(badgePath) || !value.includes(badgeAlt)) throw new Error(`${name} Node badge disagrees with canonical package policy`);
}
const documentChecks = new Map([
  ["docs/en/SUPPORT_MATRIX.md", "22.x, 24.x, 25.x"],
  ["docs/en/DELIVERY.md", "Node 22, 24, and 25"],
  ["docs/en/USER_GUIDE.md", "Node.js 22, 24, and 25"],
  ["docs/en/TESTING.md", "Node 22/24/25"],
  ["docs/en/IMPLEMENTATION_STATUS.md", "Node 22/24/25"],
  ["docs/en/CAPABILITY_MATRIX.md", "Node 22/24/25"],
  ["docs/zh-CN/SUPPORT_MATRIX.md", "22.x、24.x、25.x"],
  ["docs/ja/SUPPORT_MATRIX.md", "22.x、24.x、25.x"],
  ["DEVELOPMENT.md", "Node.js 22, 24, or 25"],
]);
for (const [name, marker] of documentChecks) if (!readFileSync(resolve(repositoryRoot, name), "utf8").includes(marker)) throw new Error(`${name} lacks canonical Node policy marker: ${marker}`);
console.error(JSON.stringify({ schema: "ableton-mcp-node-policy/v1", supportedNodeMajors: majors, engine: expectedEngine, fixtures: "21-27", ciMatrixVerified: true, documentationVerified: true }));
