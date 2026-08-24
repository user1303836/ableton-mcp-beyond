#!/usr/bin/env node
// Measure the advertised tool surface per deployment policy profile: tool
// count and approximate schema token cost (bytes/4) for each profile against a
// fully negotiated Live shape. This is a measurement artifact for model-eval
// comparisons — it asserts no improvement claim without external eval data.
import { DeterministicLiveSimulator, LIVE_CAPABILITIES, LIVE_REGISTRY_OPERATIONS } from "../dist/src/live.js";
import { TOOL_POLICY_PROFILES, resolveToolVisibility, visibleToolDescriptors } from "../dist/src/tool-catalog.js";

const fullStatus = { connected: true, adapter: "remote-script", epoch: 1, protocol: "ableton-live/v1", provenance: "real-live", capabilities: [...LIVE_CAPABILITIES], operations: [...LIVE_REGISTRY_OPERATIONS] };
const simulatorStatus = new DeterministicLiveSimulator().status();

function surface(status, profile) {
  const policy = { profile, allow: [], deny: [] };
  const descriptors = visibleToolDescriptors(status, policy);
  const schemaBytes = descriptors.reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool)), 0);
  const descriptionBytes = descriptors.reduce((total, tool) => total + Buffer.byteLength(tool.description), 0);
  return {
    profile,
    tools: descriptors.length,
    schemaBytes,
    descriptionBytes,
    approximateTokens: Math.ceil(schemaBytes / 4),
    policyDeniedExecutable: resolveToolVisibility(status, policy).filter((row) => row.executable && !row.policyAllowed).length,
  };
}

const report = {
  version: "tool-surface/v1",
  note: "Measurement only; model-selection accuracy changes require external eval runs and are not asserted here.",
  generatedAt: new Date().toISOString(),
  shapes: {
    "fully-negotiated": Object.keys(TOOL_POLICY_PROFILES).map((profile) => surface(fullStatus, profile)),
    "simulator": Object.keys(TOOL_POLICY_PROFILES).map((profile) => surface(simulatorStatus, profile)),
  },
};

console.log(JSON.stringify(report, null, 2));
