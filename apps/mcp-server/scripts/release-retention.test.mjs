import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("candidate bytes and matching verification reports request the same 90-day retention", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const uploads = workflow.split(/^      - uses: actions\/upload-artifact@/m).slice(1);
  for (const name of ["exact-local-candidate", "candidate-verification-${{ matrix.os }}-node-${{ matrix.node }}"]) {
    const step = uploads.find((chunk) => chunk.match(/^          name: (.+)$/m)?.[1] === name);
    assert.ok(step, `missing upload for ${name}`);
    assert.equal(step.match(/^          retention-days: (\d+)$/m)?.[1], "90", name);
    assert.match(step, /^          if-no-files-found: error$/m);
  }
});
