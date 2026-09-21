import assert from "node:assert/strict";
import type { DeterministicLiveSimulator, LiveInvocation, LiveOperationContext } from "../../src/live.js";

/** Simulator-only execution ledger. Replays require identical scope, key,
 * operation, and args; it does not infer execution from matching Live values. */
export function installExecutionLedger(simulator: DeterministicLiveSimulator, afterExecute?: (invocation: LiveInvocation, execution: number) => void) {
  const original = simulator.invokeAsync.bind(simulator);
  const ledger = new Map<string, unknown>();
  const calls: Array<{ invocation: LiveInvocation; context: LiveOperationContext }> = [];
  let executions = 0;
  let replays = 0;
  simulator.invokeAsync = async (invocation: LiveInvocation, context?: LiveOperationContext) => {
    assert.ok(context?.transactionId, "mutation has a retained transaction scope");
    assert.ok(context.idempotencyKey, "mutation has a retained idempotency key");
    calls.push({ invocation: structuredClone(invocation), context: { ...context } });
    const identity = JSON.stringify([context.transactionId, context.idempotencyKey, invocation]);
    if (ledger.has(identity)) { replays += 1; return structuredClone(ledger.get(identity)); }
    const result = await original(invocation);
    ledger.set(identity, structuredClone(result));
    executions += 1;
    afterExecute?.(invocation, executions);
    return result;
  };
  return { calls, get executions() { return executions; }, get replays() { return replays; } };
}
