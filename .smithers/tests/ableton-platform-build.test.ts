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
    expect(assessed.tasks.find((task) => task.nodeId === "research-repository")?.prompt).toContain("CURRENT PERSISTED WORKFLOW CONTEXT");
  });

  test("checkpoints stage eligible changes without addressing the ignored SDK", () => {
    const source = readFileSync(join(root, "workflows/ableton-platform-build.tsx"), "utf8");
    expect(source).toContain('runCommand("git", ["add", "-A", "--", "."], root)');
    expect(source).toContain("Protected SDK paths were staged");
    expect(source).not.toContain(":(exclude)");
  });

  test("independent read-only audits and final reviews run concurrently", () => {
    const source = readFileSync(join(root, "workflows/ableton-platform-build.tsx"), "utf8");
    expect(source).toContain("<Parallel maxConcurrency={4}>");
    expect(source).toContain("<Parallel maxConcurrency={3}>");
    expect(source).toContain('currentSlice: ctx.latest(outputs.planArtifact, "slice-select")');
    expect(source).toContain("context truncated at 80,000 characters");
    expect(source).toContain("if={architectureApproval?.approved !== true}");
    expect(source.indexOf('id="audit-requirements"')).toBeLessThan(source.indexOf('id="audit-moderation"'));
    expect(source.indexOf('id="final-release-review"')).toBeLessThan(source.indexOf('id="final-review-verdict"'));
  });

  test("implementation prompts cannot indefinitely defer missing Live integration", () => {
    const promptDir = join(root, "prompts/ableton-platform-build");
    const selector = readFileSync(join(promptDir, "slice-select.mdx"), "utf8");
    const planner = readFileSync(join(promptDir, "implementation-plan.mdx"), "utf8");
    const ableton = readFileSync(join(promptDir, "implement-ableton.mdx"), "utf8");
    expect(selector).toContain("implementation work to select—not a reason to defer");
    expect(selector).toContain("every iteration must materially expand");
    expect(planner).toContain("at least one unsupported core Live-control capability");
    expect(ableton).toContain("implement the adapter boundary");
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
