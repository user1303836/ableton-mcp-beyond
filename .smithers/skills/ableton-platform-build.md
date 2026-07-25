---
name: ableton-platform-build
description: Run the manual-only durable Ableton platform build workflow when an evidence-backed build and readiness cycle is needed.
workflow: ableton-platform-build
---

Use this workflow to research, plan, implement, validate, checkpoint, review PR #1, audit, and report readiness for the Ableton platform. Reach for it when the serialized build should run on `feat/comprehensive-ableton-mcp`; it does not launch the build during workflow repair.

Inputs: `prompt` is a required non-empty string. `iterationBudget` is an integer from 1 to 50 and defaults to 8. `liveTest` is a boolean and defaults to `false`; when enabled, Live actions require a durable approval gate.

Start it with:

```sh
bunx smithers-orchestrator workflow run ableton-platform-build --prompt "Research and build the Ableton platform"
```

For structured inputs, use `--input '{"prompt":"...","iterationBudget":8,"liveTest":false}'`, or run `smithers up .smithers/workflows/ableton-platform-build.tsx`.

Run detached by adding `-d`, then watch it with `smithers ps`, `smithers logs <runId> -f`, and `smithers inspect <runId>`.

Visualize it with `bunx smithers-orchestrator graph .smithers/workflows/ableton-platform-build.tsx`; add `--interactive` for the TUI. The custom UI exists, so open a run with `smithers ui <runId>`.

For blocked states, use `smithers approve <runId>` for approval gates, `smithers why <runId>` for signal waits, and `smithers cancel <runId>` to stop.

Suggest next: run it, watch it in the custom UI, and iterate by re-running `create-workflow` with a follow-up prompt.
