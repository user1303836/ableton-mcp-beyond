#!/usr/bin/env node
import { versions, platform, arch } from "node:process";

const minimumNodeMajor = 22;
const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const nodeMajor = Number.parseInt(versions.node.split(".")[0] ?? "0", 10);
const report = {
  platform,
  arch,
  node: versions.node,
  supportedPlatforms: [...supportedPlatforms],
  nodeSupported: nodeMajor >= minimumNodeMajor,
  platformSupported: supportedPlatforms.has(platform),
};

console.log(JSON.stringify(report));
if (!report.nodeSupported || !report.platformSupported) process.exitCode = 1;
