import assert from "node:assert/strict";
import { test } from "node:test";
import { DeterministicLiveSimulator } from "../src/live.js";
import { BatchTransactionManager } from "../src/transactions/batch.js";
import { buildDeviceStateFile, DeviceStateTransactionManager, planDeviceStateRecall } from "../src/transactions/device-state.js";
import { installExecutionLedger } from "./helpers/execution-ledger.js";

function compound(kind: "batch" | "device-state") {
  const simulator = new DeterministicLiveSimulator();
  const device = (simulator as any).state.tracks[0].devices[0];
  device.parameters.push({ ...structuredClone(device.parameters[0]), ref: "parameter:second", objectIdentity: "simulator:second", name: "Second", value: 0.7 });
  const file = buildDeviceStateFile(simulator.snapshot(), device.ref, "recovery");
  device.parameters[0].value = 0.1; device.parameters[1].value = 0.2;
  const manager = kind === "batch" ? new BatchTransactionManager(simulator) : new DeviceStateTransactionManager(simulator);
  const preview = () => manager instanceof BatchTransactionManager
    ? manager.previewAsync({ operations: device.parameters.map((row: any, index: number) => ({ kind: "device.parameter.set", deviceRef: device.ref, parameterRef: row.ref, value: file.parameters[index]!.value })) })
    : manager.previewAsync(planDeviceStateRecall(simulator.snapshot(), file, device.ref), "recall");
  return { simulator, manager, device, preview: async () => await preview() as { transactionId: string } };
}

for (const kind of ["batch", "device-state"] as const) {
  test(`${kind}: lost apply and undo replies reconcile exact invocations, not matching values`, async () => {
    const { simulator, manager, device, preview } = compound(kind);
    const ledger = installExecutionLedger(simulator, (_invocation, execution) => {
      if (execution === 1 || execution === 3) throw new Error("remote adapter request state uncertain after dispatch timeout");
    });
    const { transactionId } = await preview();
    await assert.rejects(manager.applyAsync(transactionId, "apply", "apply-original"), /uncertain/);
    await assert.rejects(manager.applyAsync(transactionId, "apply", "apply-different"), /exact original/);
    const applied = await manager.applyAsync(transactionId, "apply", "apply-original") as any;
    assert.equal(applied.state, "applied");
    assert.equal(ledger.executions, 2); assert.equal(ledger.replays, 1);
    assert.deepEqual(ledger.calls[0]!.invocation, ledger.calls[1]!.invocation);
    await assert.rejects(manager.undoAsync(transactionId, "undo", "undo-original"), /uncertain/);
    await assert.rejects(manager.undoAsync(transactionId, "undo", "undo-different"), /Only an applied/);
    const undone = await manager.undoAsync(transactionId, "undo", "undo-original") as any;
    assert.equal(undone.state, "undone");
    assert.deepEqual(device.parameters.map((row: any) => row.value), [0.1, 0.2]);
    assert.equal(ledger.executions, 4); assert.equal(ledger.replays, 2);
    assert.deepEqual(ledger.calls[3]!.invocation, ledger.calls[4]!.invocation);
  });

  test(`${kind}: lost compensation reply resumes compensation and its terminal result is idempotent`, async () => {
    const { simulator, manager, device, preview } = compound(kind);
    const ledger = installExecutionLedger(simulator, (_invocation, execution) => {
      if (execution === 2) throw new Error("remote adapter request state uncertain after dispatch timeout");
    });
    const { transactionId } = await preview();
    simulator.simulateExternalEdit(device.parameters[1].ref, "value", 0.95);
    await assert.rejects(manager.applyAsync(transactionId, "apply", "compensate-original"), /rollback failed/);
    const result = await manager.applyAsync(transactionId, "apply", "compensate-original") as any;
    assert.equal(result.state, "compensated"); assert.equal(result.failedIndex, 1); assert.equal(result.rolledBack, 1);
    assert.deepEqual(device.parameters.map((row: any) => row.value), [0.1, 0.95]);
    assert.equal(ledger.executions, 2); assert.equal(ledger.replays, 1);
    assert.deepEqual(ledger.calls[1]!.invocation, ledger.calls[2]!.invocation);
    const again = await manager.applyAsync(transactionId, "apply", "compensate-original") as any;
    assert.equal(again.state, "compensated"); assert.equal(again.idempotent, true);
    assert.equal(ledger.calls.length, 3);
  });

  test(`${kind}: external matching values cannot impersonate a lost execution`, async () => {
    const { simulator, manager, device, preview } = compound(kind);
    const original = simulator.invokeAsync.bind(simulator);
    const invocations: unknown[] = [];
    simulator.invokeAsync = async (invocation) => {
      invocations.push(structuredClone(invocation));
      if (invocations.length === 1) {
        simulator.simulateExternalEdit(device.parameters[0].ref, "value", 0.5);
        throw new Error("remote adapter request state uncertain after dispatch timeout");
      }
      return original(invocation);
    };
    const { transactionId } = await preview();
    await assert.rejects(manager.applyAsync(transactionId, "apply", "not-executed"), /uncertain/);
    await assert.rejects(manager.applyAsync(transactionId, "apply", "not-executed"));
    assert.deepEqual(invocations[0], invocations[1], "retained revision is not refreshed to authorize a new write");
    assert.equal(device.parameters[1].value, 0.2, "later steps never execute after a false acknowledgement");
    await assert.rejects(manager.undoAsync(transactionId, "undo", "not-owned-undo"), /Only an applied/);
    assert.equal(device.parameters[0].value, 0.5, "the external edit never becomes owned undo state");
  });

  test(`${kind}: successful reply followed by failed verification remains uncertain and does not write twice`, async () => {
    const { simulator, manager, preview } = compound(kind);
    let failVerification = false;
    const snapshot = simulator.snapshotAsync.bind(simulator);
    simulator.snapshotAsync = async () => {
      if (failVerification) { failVerification = false; throw new Error("snapshot unavailable"); }
      return snapshot();
    };
    const ledger = installExecutionLedger(simulator, (_invocation, execution) => { if (execution === 1) failVerification = true; });
    const { transactionId } = await preview();
    await assert.rejects(manager.applyAsync(transactionId, "apply", "verification-original"), /snapshot unavailable/);
    const result = await manager.applyAsync(transactionId, "apply", "verification-original") as any;
    assert.equal(result.state, "applied");
    assert.equal(ledger.executions, 2); assert.equal(ledger.replays, 0, "acknowledged result is retained locally");
  });

  test(`${kind}: a substituted parameter with the proposed value is not a verified postcondition`, async () => {
    const { simulator, manager, device, preview } = compound(kind);
    const ledger = installExecutionLedger(simulator, (_invocation, execution) => {
      if (execution === 1) device.parameters[0].objectIdentity = "external:replacement";
    });
    const { transactionId } = await preview();
    await assert.rejects(manager.applyAsync(transactionId, "apply", "identity-original"), /identity or postcondition/);
    await assert.rejects(manager.applyAsync(transactionId, "apply", "identity-original"), /identity or postcondition/);
    assert.equal(ledger.executions, 1);
    assert.equal(device.parameters[1].value, 0.2);
    assert.equal(manager.isFinalizable(transactionId), true, "uncertain ownership remains available for explicit recovery finalization");
  });
}

test("batch: a lost created-track reply and lost deletion reply preserve exact ownership", async () => {
  const simulator = new DeterministicLiveSimulator();
  const manager = new BatchTransactionManager(simulator);
  const before = simulator.snapshot().tracks.length;
  const ledger = installExecutionLedger(simulator, (_invocation, execution) => { if (execution <= 2) throw new Error("uncertain after dispatch timeout"); });
  const { transactionId } = await manager.previewAsync({ operations: [{ kind: "track.create", name: "Owned", trackKind: "midi" }] }) as any;
  await assert.rejects(manager.applyAsync(transactionId, "apply", "create-original"), /uncertain/);
  assert.equal((await manager.applyAsync(transactionId, "apply", "create-original") as any).state, "applied");
  assert.equal(simulator.snapshot().tracks.length, before + 1);
  await assert.rejects(manager.undoAsync(transactionId, "undo", "delete-original"), /uncertain/);
  assert.equal((await manager.undoAsync(transactionId, "undo", "delete-original") as any).state, "undone");
  assert.equal(simulator.snapshot().tracks.length, before);
  assert.equal(ledger.executions, 2); assert.equal(ledger.replays, 2);
});

test("batch: track creation refuses external structure drift but accepts its own earlier steps", async () => {
  const simulator = new DeterministicLiveSimulator();
  const manager = new BatchTransactionManager(simulator);
  const first = await manager.previewAsync({ operations: [{ kind: "track.create", name: "New", trackKind: "midi", index: 0 }] }) as any;
  (simulator as any).state.tracks[0].name = "External rename";
  const refused = await manager.applyAsync(first.transactionId, "apply", "structure-drift") as any;
  assert.equal(refused.state, "compensated"); assert.equal(refused.rolledBack, 0);
  assert.match(refused.reason, /structure changed since preview/);
  assert.equal(simulator.snapshot().tracks.length, 1);
  const second = await manager.previewAsync({ operations: [
    { kind: "track.rename", trackRef: "track:track-1", name: "Owned rename" },
    { kind: "track.create", name: "First", trackKind: "midi", index: 0 },
    { kind: "track.create", name: "Second", trackKind: "midi", index: 0 },
  ] }) as any;
  assert.equal((await manager.applyAsync(second.transactionId, "apply", "structure-owned") as any).state, "applied");
  assert.equal(simulator.snapshot().tracks.length, 3);
  assert.equal((await manager.undoAsync(second.transactionId, "undo", "structure-undo") as any).state, "undone");
  assert.equal(simulator.snapshot().tracks[0]!.name, "External rename");
});

test("batch: edits made before creation verification never become an owned deletion fingerprint", async () => {
  const simulator = new DeterministicLiveSimulator();
  const manager = new BatchTransactionManager(simulator);
  installExecutionLedger(simulator, () => { (simulator as any).state.tracks.at(-1).volume = 0.2; });
  const { transactionId } = await manager.previewAsync({ operations: [{ kind: "track.create", name: "Edited", trackKind: "midi" }] }) as any;
  await assert.rejects(manager.applyAsync(transactionId, "apply", "create-edited"), /changed after atomic creation/);
  await assert.rejects(manager.undoAsync(transactionId, "undo", "delete-edited"), /Only an applied/);
  assert.equal(simulator.snapshot().tracks.at(-1)!.name, "Edited");
});
