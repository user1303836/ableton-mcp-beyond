import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { renderWorkflow } from "smithers-orchestrator/testing";
import workflow from "../workflows/ableton-platform-build";

const root = join(import.meta.dir, "..");

describe("ableton-platform-build workflow shape", () => {
  test("renders the production workflow through Smithers", async () => {
    const frame = await renderWorkflow(workflow, {
      workflowPath: join(root, "workflows/ableton-platform-build.tsx"),
      baseRootDir: join(root, ".."),
      input: { prompt: "shape test", iterationBudget: 2, liveTest: false },
    });
    const ids = frame.tasks.map((task) => task.nodeId);
    expect(ids).toContain("preflight-inspect");
    expect(ids).toContain("preflight-assess");
    expect(ids).toContain("final-report");
    expect(new Set(ids).size).toBe(ids.length);
    expect(frame.toXml()).toContain("ableton-platform-build");

    const assessed = await renderWorkflow(workflow, {
      workflowPath: join(root, "workflows/ableton-platform-build.tsx"),
      baseRootDir: join(root, ".."),
      input: { prompt: "branch shape test", iterationBudget: 2, liveTest: false },
      outputs: {
        preflightAssess: [{ nodeId: "preflight-assess", ready: true, recoveryRequired: false }],
      },
    });
    expect(assessed.tasks.map((task) => task.nodeId)).toContain("research-repository");
  });

  test("UI uses the shipped runtime components and safe actions", () => {
    const source = readFileSync(join(root, "ui/ableton-platform-build.tsx"), "utf8");
    expect(source).toContain("<RunTree");
    expect(source).toContain("<RunEventLog");
    expect(source).toContain("<ApprovalPanel");
    expect(source).toContain("<Button");
    expect(source).toContain("cancelRun");
    expect(source).toContain("<KpiStat");
    expect(source).not.toMatch(/<button\b/);
  });
});
