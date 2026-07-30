#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { versions, platform, arch } from "node:process";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const supportedNodeMajors = packageJson.abletonMcpSupport?.nodeMajors;
if (!Array.isArray(supportedNodeMajors)) throw new Error("canonical Node support policy is unavailable");
const supportedPlatforms = ["darwin", "linux", "win32"];
const stableVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(versions.node);
const nodeMajor = stableVersion ? Number(stableVersion[1]) : 0;
const nodeSupported = stableVersion !== null && supportedNodeMajors.includes(nodeMajor);
const platformSupported = supportedPlatforms.includes(platform);
const remediation = nodeSupported ? null : `Unsupported Node.js ${versions.node}. Supported major versions: ${supportedNodeMajors.join(", ")}. Install one of those versions and retry.`;
const report = {
  schema: "ableton-mcp-compatibility/v1",
  platform,
  arch,
  node: versions.node,
  supportedPlatforms,
  supportedNodeMajors,
  nodeSupported,
  platformSupported,
  remediation,
};

console.log(JSON.stringify(report));
if (!nodeSupported || !platformSupported) process.exitCode = 1;
