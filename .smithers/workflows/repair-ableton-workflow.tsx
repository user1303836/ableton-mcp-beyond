// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Repair Ableton Build Workflow
// smithers-description: Repair and validate the long-horizon Ableton platform workflow before execution.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  goal: z.string().min(1),
});

const repairSchema = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  verificationCommands: z.array(z.string()).default([]),
  passed: z.boolean(),
  remainingIssues: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  repair: repairSchema,
});

export default smithers((ctx) => (
  <Workflow name="repair-ableton-workflow">
    <Task id="repair" output={outputs.repair} agent={agents.implement} retries={2}>
      {ctx.input.goal}
    </Task>
  </Workflow>
));
