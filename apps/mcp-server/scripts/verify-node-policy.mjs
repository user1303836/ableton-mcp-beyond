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
const expectedMajors = [22, 24];
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
// The matrix names its Node majors either as a list (node: [22, 24]) or across include entries ({ …, node: 24, … }):
// together they must be exactly the supported majors, and a failure must not cancel the rest.
const listed = nodeJob.match(/^\s*node:\s*\[([^\]]+)\]\s*$/m)?.[1].split(",").map((value) => Number(value.trim()));
const included = [...nodeJob.matchAll(/^\s*- \{[^}\n]*\bnode:\s*(\d+)[^}\n]*\}\s*$/gm)].map((match) => Number(match[1]));
if (!listed && !included.length) throw new Error("CI Node matrix is missing or dynamic");
const matrix = [...new Set([...(listed ?? []), ...included])].sort((a, b) => a - b);
if (JSON.stringify(matrix) !== JSON.stringify(majors) || !/^\s*fail-fast:\s*false\s*$/m.test(nodeJob)) throw new Error("CI Node matrix semantics disagree with canonical package policy");
const pythonJob = workflow.match(/^  remote-script:\n([\s\S]*?)(?=^  [a-z][a-z-]*:\n)/m)?.[1];
if (!pythonJob || !/^\s*fail-fast:\s*false\s*$/m.test(pythonJob)) throw new Error("CI Python matrix must remain complete after a failure");
const requiredJob = workflow.match(/^  required:\n([\s\S]*)$/m)?.[1];
const requiredFragments = [
  "name: Required CI",
  "if: always()",
  "needs: [candidate, quality, node, remote-script]",
  'test "${{ needs.candidate.result }}" = "success"',
  'test "${{ needs.quality.result }}" = "success"',
  'test "${{ needs.node.result }}" = "success"',
  'test "${{ needs.remote-script.result }}" = "success"',
];
if (!requiredJob || requiredFragments.some((fragment) => !requiredJob.includes(fragment)) || !workflow.includes("- run: npm run package:verify")) throw new Error("CI lacks the complete fixed Required CI aggregate gate");

// This policy governs the retained TypeScript bridge and its npm tooling. Kumi's
// native application documents its own runtime independently.
const nodeSourcePolicy = /Node(?:\.js)?\s+22(?:\/|\s+(?:and|or)\s+)24\b/;
const documentChecks = new Map([
  ["apps/mcp-server/README.md", nodeSourcePolicy],
  ["docs/en/SUPPORT_MATRIX.md", /22\.x,\s*24\.x/],
  ["docs/en/DELIVERY.md", nodeSourcePolicy],
  ["docs/en/USER_GUIDE.md", nodeSourcePolicy],
  ["docs/en/TESTING.md", nodeSourcePolicy],
  ["docs/en/IMPLEMENTATION_STATUS.md", nodeSourcePolicy],
  ["docs/en/CAPABILITY_MATRIX.md", nodeSourcePolicy],
  ["docs/zh-CN/SUPPORT_MATRIX.md", /22\.x、24\.x/],
  ["docs/ja/SUPPORT_MATRIX.md", /22\.x、24\.x/],
  ["DEVELOPMENT.md", nodeSourcePolicy],
]);
for (const [name, marker] of documentChecks) if (!marker.test(readFileSync(resolve(repositoryRoot, name), "utf8"))) throw new Error(`${name} lacks canonical Node source-tool policy: ${marker}`);
console.error(JSON.stringify({ schema: "ableton-mcp-node-policy/v1", supportedNodeMajors: majors, engine: expectedEngine, fixtures: "21-27", ciMatrixVerified: true, documentationVerified: true }));
