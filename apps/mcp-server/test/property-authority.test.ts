import assert from "node:assert/strict";
import { test } from "node:test";
import { McpHost, PROTOCOL_VERSION } from "../src/host.js";
import { estimateKey } from "../src/key-estimation.js";
import { DeterministicLiveSimulator, type LiveInvocation } from "../src/live.js";

class PropertyProbe extends DeterministicLiveSimulator {
  mutations: LiveInvocation[] = [];
  afterMutation?: () => void;
  override async invokeAsync(invocation: LiveInvocation): Promise<unknown> {
    const result = await super.invokeAsync(invocation);
    if (["track.set", "song.set"].includes(invocation.operation)) {
      this.mutations.push(structuredClone(invocation));
      this.afterMutation?.();
    }
    return result;
  }
}

function harness() {
  const simulator = new PropertyProbe();
  const host = new McpHost(simulator);
  host.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "property-authority", version: "1" } } });
  host.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 1;
  const call = (name: string, args: unknown): Promise<any> => host.handleAsync({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
  return { simulator, call };
}

for (const domain of ["track_properties", "song_settings"] as const) {
  const args = domain === "track_properties" ? { ref: "track:track-1", colorIndex: 12 } : { swingAmount: 0.5 };
  const replaceIdentity = (simulator: PropertyProbe) => {
    const state = (simulator as any).state;
    const row = domain === "track_properties" ? state.tracks[0] : state.set;
    row.objectIdentity = "replacement-object-with-the-same-ref-and-values";
  };
  const currentValue = (simulator: PropertyProbe) => domain === "track_properties" ? (simulator as any).state.tracks[0].colorIndex : (simulator as any).state.song.swingAmount;
  const priorValue = domain === "track_properties" ? 4 : 0;
  const appliedValue = domain === "track_properties" ? 12 : 0.5;

  for (const phase of ["before-apply", "after-apply", "before-undo", "after-undo"] as const) {
    test(`${domain} refuses a same-reference replacement ${phase}`, async () => {
      const { simulator, call } = harness();
      const preview = JSON.parse((await call(`live_${domain}_preview`, args)).result.content[0].text);
      const applyArgs = { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "property-apply-key" };
      if (phase === "before-apply") replaceIdentity(simulator);
      if (phase === "after-apply") simulator.afterMutation = () => replaceIdentity(simulator);
      const applied = await call(`live_${domain}_apply`, applyArgs);
      if (phase === "before-apply" || phase === "after-apply") {
        assert.equal(applied.result.isError, true);
        assert.equal(simulator.mutations.length, phase === "before-apply" ? 0 : 1);
        assert.equal(currentValue(simulator), phase === "before-apply" ? priorValue : appliedValue);
        return;
      }
      assert.equal(JSON.parse(applied.result.content[0].text).state, "applied");
      if (phase === "before-undo") replaceIdentity(simulator);
      else simulator.afterMutation = () => replaceIdentity(simulator);
      const undone = await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "property-undo-key" });
      assert.equal(undone.result.isError, true);
      assert.equal(simulator.mutations.length, phase === "before-undo" ? 1 : 2);
      assert.equal(currentValue(simulator), phase === "before-undo" ? appliedValue : priorValue);
    });
  }

  test(`${domain} cannot reconcile an uncertain undo through forward apply`, async () => {
    const { simulator, call } = harness();
    const preview = JSON.parse((await call(`live_${domain}_preview`, args)).result.content[0].text);
    const applyArgs = { transactionId: preview.transactionId, confirmation: "apply", idempotencyKey: "property-apply-key" };
    assert.equal(JSON.parse((await call(`live_${domain}_apply`, applyArgs)).result.content[0].text).state, "applied");
    simulator.afterMutation = () => { throw new Error("disconnect after inverse dispatch"); };
    const uncertain = await call("live_undo", { transactionId: preview.transactionId, confirmation: "undo", idempotencyKey: "property-undo-key" });
    assert.equal(uncertain.result.isError, true);
    simulator.afterMutation = undefined;
    const refused = await call(`live_${domain}_apply`, applyArgs);
    assert.equal(refused.result.isError, true);
    assert.equal(simulator.mutations.length, 2);
    assert.equal(currentValue(simulator), priorValue);
  });
}

test("key estimation rejects beat magnitudes that would overflow aggregate evidence", async () => {
  const { call } = harness();
  for (const entry of [{ pitch: 60, start: 0, duration: 1e308 }, { pitch: 60, start: 1e308, duration: 1 }]) {
    assert.equal((await call("live_key_estimate", { notes: [entry] })).error.code, -32602);
    const estimate = estimateKey([entry]);
    assert.equal(estimate.evidence.noteCount, 0);
    assert.equal(estimate.evidence.totalDurationBeats, 0);
    assert.equal(estimate.confidence, "insufficient-evidence");
  }
});
