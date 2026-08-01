// Drift check: regenerate the capability manifest into a TEMPORARY path and
// byte-compare it against the untouched tracked artifact, verify the canonical
// registry hash independently, and verify coverage of every registry operation
// exactly once with an explicit executable/reserved status. The test never
// mutates the checkout, so a stale or corrupt checked-in artifact fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function canonical(value, depth = 0) {
  if (depth > 32) throw new Error("registry is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("registry contains an unsupported value");
}

const EXPECTED_RESERVED = new Set([
  "arrangement.automation.create", "arrangement.automation.delete", "arrangement.automation.point.delete", "arrangement.automation.point.insert", "arrangement.automation.read",
  "audio.comp.read",
  "browser.preview.start", "browser.preview.stop",
  "project.bounce", "project.collect", "project.export", "project.new", "project.open", "project.save", "project.save-as",
  "session.discover",
]);

test("capability manifest matches a fresh regeneration, the canonical hash, and the exact reserved set", () => {
  const registry = JSON.parse(readFileSync(join(root, "..", "..", "protocol", "ableton-live-v1.operations.json"), "utf8"));
  const canonicalHash = createHash("sha256").update(canonical(registry)).digest("hex");
  const outDir = mkdtempSync(join(tmpdir(), "capability-manifest-"));
  const regeneratedPath = join(outDir, "capability-manifest.json");
  execFileSync(process.execPath, [join(root, "scripts", "generate-capability-manifest.mjs"), regeneratedPath], { cwd: root, stdio: "pipe" });
  const trackedPath = join(root, "..", "..", "docs", "evidence", "capability-manifest.json");
  const tracked = readFileSync(trackedPath, "utf8");
  const regenerated = readFileSync(regeneratedPath, "utf8");
  assert.equal(tracked, regenerated, "the checked-in capability manifest is stale; regenerate it with npm run capability:manifest");
  const manifest = JSON.parse(tracked);
  assert.equal(manifest.schema, "ableton-mcp-capability-manifest/v1");
  assert.equal(manifest.registryHash, canonicalHash, "the manifest must carry the canonical recursively sorted registry hash used by the bridge");
  const ids = registry.operations.map((operation) => operation.id).sort();
  assert.equal(manifest.operationCount, ids.length);
  const seen = new Set();
  const reserved = new Set();
  for (const family of manifest.families) {
    assert.ok(family.surface.length > 0 && family.firstTested.length > 0, `family ${family.family} lacks surface or first-tested evidence notes`);
    for (const operation of family.operations) {
      assert.ok(ids.includes(operation.id), `manifest references unknown operation ${operation.id}`);
      assert.ok(!seen.has(operation.id), `manifest assigns ${operation.id} twice`);
      seen.add(operation.id);
      assert.ok(["executable-negotiated", "reserved-fail-closed"].includes(operation.status), `operation ${operation.id} has an invalid status`);
      assert.ok(Array.isArray(operation.access) && operation.access.length > 0 && operation.access.every((mode) => ["read", "write", "call", "observe"].includes(mode)), `operation ${operation.id} lacks explicit read/write/call/observe access modes`);
      if (operation.status === "reserved-fail-closed") reserved.add(operation.id);
    }
  }
  assert.equal(seen.size, ids.length, "manifest must cover every registry operation exactly once");
  assert.deepEqual([...reserved].sort(), [...EXPECTED_RESERVED].sort(), "the reserved set must be exact: negotiated operations are executable, genuine LOM gaps stay reserved");
});
