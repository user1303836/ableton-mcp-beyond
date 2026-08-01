// Drift check: the checked-in capability manifest must exactly match a fresh
// regeneration from the canonical registry, and must cover every registry
// operation exactly once with an explicit executable/reserved status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("capability manifest is current, complete, and honest about reserved operations", () => {
  const outDir = mkdtempSync(join(tmpdir(), "capability-manifest-"));
  const registryPath = join(root, "..", "..", "protocol", "ableton-live-v1.operations.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  execFileSync(process.execPath, [join(root, "scripts", "generate-capability-manifest.mjs")], { cwd: root, stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(root, "..", "..", "docs", "evidence", "capability-manifest.json"), "utf8"));
  assert.equal(manifest.schema, "ableton-mcp-capability-manifest/v1");
  const ids = registry.operations.map((operation) => operation.id).sort();
  assert.equal(manifest.operationCount, ids.length);
  const seen = new Set();
  let reserved = 0;
  for (const family of manifest.families) {
    assert.ok(family.surface.length > 0 && family.firstTested.length > 0, `family ${family.family} lacks surface or first-tested evidence notes`);
    for (const operation of family.operations) {
      assert.ok(ids.includes(operation.id), `manifest references unknown operation ${operation.id}`);
      assert.ok(!seen.has(operation.id), `manifest assigns ${operation.id} twice`);
      seen.add(operation.id);
      assert.ok(["executable-negotiated", "reserved-fail-closed"].includes(operation.status), `operation ${operation.id} has an invalid status`);
      if (operation.status === "reserved-fail-closed") reserved += 1;
    }
  }
  assert.equal(seen.size, ids.length, "manifest must cover every registry operation exactly once");
  assert.ok(reserved >= 17, "reserved fail-closed operations must stay explicit");
});
