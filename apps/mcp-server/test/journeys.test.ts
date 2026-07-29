import test from "node:test";
import assert from "node:assert/strict";
import { JOURNEY_CATALOG, JOURNEY_IDS, JOURNEY_PLAN_VERSION, journeyResource, planUserJourney, renderJourneyPrompt } from "../src/journeys.js";
import { LIVE_CAPABILITIES, LIVE_REGISTRY_OPERATIONS, type LiveStatus } from "../src/live.js";

const completeStatus: LiveStatus = {
  connected: true,
  adapter: "remote-script",
  epoch: 9,
  protocol: "ableton-live-v1",
  provenance: "real-live",
  registryHash: "a".repeat(64),
  capabilities: LIVE_CAPABILITIES,
  operations: LIVE_REGISTRY_OPERATIONS,
};

const unavailableStatus: LiveStatus = {
  connected: false,
  adapter: "unavailable",
  epoch: null,
  protocol: "ableton-live-v1",
  provenance: "unknown",
  capabilities: [],
  operations: [],
  reason: "not configured",
};

test("catalog exposes exactly five ordered, semantically labelled journeys", () => {
  assert.deepEqual(JOURNEY_CATALOG.map((entry) => entry.id), [...JOURNEY_IDS]);
  assert.equal(new Set(JOURNEY_IDS).size, 5);
  for (const entry of JOURNEY_CATALOG) {
    assert.ok(entry.title.length > 8);
    assert.ok(entry.summary.length > 40);
    assert.ok(entry.fallback.length > 80);
    assert.ok(entry.stages.length >= 5);
    for (const stage of entry.stages) {
      assert.ok(stage.announcement.endsWith("."));
      assert.ok(stage.authorities.length > 0);
      assert.ok(stage.authorities.every((authority) => ["none", "fixed-phrase", "unpredictable-preview-token"].includes(authority.mechanism)));
      assert.ok(stage.verification.length > 20 && stage.recovery.length > 10 && stage.unavailableFallback.length > 10);
    }
  }
});

test("complete plans remain non-authoritative and disclose progress, rights, impacts, and recovery", () => {
  for (const journey of JOURNEY_IDS) {
    const plan = planUserJourney({ journey, traits: "syncopated, spacious, warm, controlled", experienceLevel: "advanced", bars: 8 }, completeStatus);
    assert.equal(plan.version, JOURNEY_PLAN_VERSION);
    assert.equal(plan.executable, true);
    assert.equal(plan.mode, "capability-complete");
    assert.deepEqual(plan.stages.map((stage) => stage.order), plan.stages.map((_, index) => index + 1));
    assert.ok(plan.stages.every((stage) => stage.status === "planned" && stage.available === true));
    assert.ok(plan.stages.some((stage) => stage.authorities.some((authority) => authority.mechanism !== "none")));
    assert.equal(plan.rights.exactReplicationDelivered, false);
    assert.equal(plan.rights.legalClearanceClaimed, false);
    assert.equal(plan.accessibility.nonColorStatusLabels, true);
    assert.equal(plan.accessibility.mouseOnlyInstructions, false);
    assert.equal(plan.progress.terminalResultRequiresResidualState, true);
    assert.deepEqual(plan.residualStateTemplate, { status: "not-started", requiredAtTerminal: true, items: [] });
    assert.doesNotMatch(JSON.stringify(plan), /transactionId|confirmationToken|idempotencyKey/);
  }
});

test("unavailable Live yields truthful per-journey fallbacks while local reference analysis remains available", () => {
  for (const journey of JOURNEY_IDS) {
    const plan = planUserJourney({ journey, traits: "clear and controlled" }, unavailableStatus);
    if (journey === "compare-reference-mix") {
      assert.equal(plan.executable, true);
      assert.equal(plan.mode, "local-analysis");
      assert.deepEqual(plan.advanced.missingCapabilities, []);
      assert.deepEqual(plan.advanced.missingOperations, []);
    } else {
      assert.equal(plan.executable, false);
      assert.equal(plan.mode, "capability-limited");
      assert.ok(plan.advanced.missingCapabilities.length > 0);
      assert.ok(plan.beginner.summary.includes("cannot complete"));
    }
  }
  const resource = journeyResource(unavailableStatus);
  assert.equal(resource.journeys.length, 5);
  assert.ok(resource.journeys.every((entry) => typeof entry.fallback === "string" && entry.fallback.length > 40));
  assert.match(resource.authority, /grants no mutation authority|requires its purpose-specific preview/i);
});

test("optional stages negotiate independently and never make unavailable tools look executable", () => {
  const browserOnly: LiveStatus = {
    ...completeStatus,
    capabilities: ["session.read", "session.discovery", "browser"] as any,
    operations: ["discover", "browser.search", "browser.load", "device.delete"] as any,
  };
  const sound = planUserJourney({ journey: "design-owned-sound", traits: "warm spacious controlled" }, browserOnly);
  assert.equal(sound.executable, true);
  assert.equal(sound.mode, "core-capability-complete");
  assert.equal(sound.stages.find((stage) => stage.id === "apply-load")?.status, "planned");
  assert.equal(sound.stages.find((stage) => stage.id === "shape-published-controls")?.status, "unavailable");
  assert.equal(sound.stages.find((stage) => stage.id === "audition")?.status, "unavailable");
  assert.deepEqual(sound.advanced.unavailableOptionalStages.map((stage) => stage.id), ["shape-published-controls", "audition"]);

  const reference = planUserJourney({ journey: "compare-reference-mix", traits: "balanced clear" }, unavailableStatus);
  assert.equal(reference.mode, "local-analysis");
  assert.ok(reference.stages.filter((stage) => stage.requiredForCore).every((stage) => stage.status === "planned"));
  assert.ok(reference.stages.filter((stage) => !stage.requiredForCore).every((stage) => stage.status === "unavailable"));
  const capture = reference.stages.find((stage) => stage.id === "guarded-capture");
  assert.ok(capture?.tools.includes("live_audio_capture_status") && capture.tools.includes("live_audio_capture_emergency_stop"));
  assert.ok(capture?.authorities.some((authority) => authority.phrase === "emergency-stop-and-clean"));

  const performance = planUserJourney({ journey: "diagnose-performance-setup", traits: "controlled clear" }, {
    ...completeStatus,
    capabilities: ["session.read", "session.discovery", "routing", "mixing", "transport"] as any,
    operations: ["discover", "session.playback", "routing.set", "mixer.set"] as any,
  });
  assert.equal(performance.executable, true);
  assert.equal(performance.mode, "core-capability-complete");
  assert.equal(performance.stages.find((stage) => stage.id === "bounded-recording")?.status, "unavailable");
  assert.equal(performance.stages.find((stage) => stage.id === "bounded-realtime")?.status, "unavailable");
  const arrangementWithoutRead = planUserJourney({ journey: "create-beat-or-song", traits: "syncopated warm" }, {
    ...completeStatus,
    capabilities: completeStatus.capabilities.filter((capability) => capability !== "session.read") as any,
  });
  assert.equal(arrangementWithoutRead.stages.find((stage) => stage.id === "arrange")?.status, "unavailable");
});

test("authority metadata matches fixed phrases, unpredictable tokens, disarm, and core tool availability", () => {
  const byJourney = Object.fromEntries(JOURNEY_IDS.map((journey) => [journey, planUserJourney({ journey, traits: "syncopated warm controlled clear" }, completeStatus)]));
  const authority = (journey: string, stage: string, tool: string) => (byJourney[journey] as any).stages.find((entry: any) => entry.id === stage).authorities.find((entry: any) => entry.tools.includes(tool));
  assert.deepEqual({ mechanism: authority("create-beat-or-song", "revise", "live_note_update_apply").mechanism, phrase: authority("create-beat-or-song", "revise", "live_note_update_apply").phrase }, { mechanism: "fixed-phrase", phrase: "apply" });
  assert.deepEqual({ mechanism: authority("compare-reference-mix", "reversible-hypothesis", "live_mixer_apply").mechanism, phrase: authority("compare-reference-mix", "reversible-hypothesis", "live_mixer_apply").phrase }, { mechanism: "fixed-phrase", phrase: "apply" });
  assert.deepEqual({ mechanism: authority("diagnose-performance-setup", "apply-fixes", "live_routing_apply").mechanism, phrase: authority("diagnose-performance-setup", "apply-fixes", "live_routing_apply").phrase }, { mechanism: "fixed-phrase", phrase: "apply" });
  assert.deepEqual({ mechanism: authority("diagnose-performance-setup", "bounded-recording", "live_recording_apply").mechanism, phrase: authority("diagnose-performance-setup", "bounded-recording", "live_recording_apply").phrase }, { mechanism: "fixed-phrase", phrase: "apply" });
  assert.equal(authority("compare-reference-mix", "guarded-capture", "live_audio_capture_apply").mechanism, "unpredictable-preview-token");
  assert.equal(authority("compare-reference-mix", "guarded-capture", "live_audio_capture_emergency_stop").phrase, "emergency-stop-and-clean");
  assert.equal(authority("diagnose-performance-setup", "bounded-realtime", "live_realtime_arm_apply").phrase, "apply");
  assert.equal(authority("diagnose-performance-setup", "bounded-realtime", "live_realtime_disarm").phrase, "disarm");
  assert.equal(authority("create-beat-or-song", "apply-create", "live_undo").phrase, "undo");
  const finalPerformance = byJourney["diagnose-performance-setup"]!.stages.find((stage) => stage.id === "final-readback");
  assert.deepEqual(finalPerformance?.tools, ["live_discover"]);
});

test("planning is deterministic, bounded, and rejects malformed natural-language inputs", () => {
  const input = { journey: "create-beat-or-song" as const, traits: "broken beat, sparse bass", experienceLevel: "beginner" as const, bars: 4 };
  assert.equal(planUserJourney(input, completeStatus).planId, planUserJourney(input, completeStatus).planId);
  assert.notEqual(planUserJourney(input, completeStatus).planId, planUserJourney({ ...input, bars: 8 }, completeStatus).planId);
  assert.throws(() => planUserJourney({ ...input, traits: "" }, completeStatus), /traits/);
  assert.throws(() => planUserJourney({ ...input, traits: "x".repeat(1001) }, completeStatus), /traits/);
  assert.throws(() => planUserJourney({ ...input, bars: 17 }, completeStatus), /bars/);
  assert.throws(() => planUserJourney({ ...input, experienceLevel: "expert" as any }, completeStatus), /experienceLevel/);
  const realPlan = planUserJourney(input, completeStatus);
  const fakePlan = planUserJourney(input, { ...completeStatus, provenance: "fake-live" });
  const disconnectedPlan = planUserJourney(input, { ...completeStatus, connected: false, adapter: "unavailable", epoch: null });
  assert.notEqual(realPlan.planId, fakePlan.planId);
  assert.notEqual(realPlan.planId, disconnectedPlan.planId);
  assert.equal(realPlan.stages.find((stage) => stage.id === "audition")?.requiredProvenance ?? null, null);
  const syncopated = planUserJourney(input, completeStatus);
  assert.equal(syncopated.intent.highLevelTraits.some((entry) => entry.value === "broken"), true);
  assert.equal((syncopated.guidance as any).drumRoleEvents.some((entry: any) => entry.startBeat % 1 === 0.75), true);
  assert.equal((syncopated.guidance as any).drumRoleEvents.every((entry: any) => entry.pitch === null), true);
});

test("rendered prompts exclude identity/copy text from guidance and require clarification when no safe traits remain", () => {
  const plan = planUserJourney({ journey: "design-owned-sound", traits: "copy Artist X's exact signature patch" }, completeStatus);
  assert.equal(plan.mode, "intent-clarification-required");
  assert.equal(plan.executable, false);
  assert.equal(plan.intent.exactCopyIntentDetected, true);
  assert.equal(plan.intent.identityReferenceMayBePresent, true);
  assert.deepEqual(plan.intent.highLevelTraits, []);
  assert.ok(plan.stages.every((stage) => stage.status === "blocked-by-intent" && stage.available === false));
  assert.doesNotMatch(JSON.stringify(plan.guidance), /Artist X|signature patch/i);
  for (const collision of ["in the style of Bright Eyes", "sound like Major Lazer", "copy Dark Star exactly"]) {
    const refused = planUserJourney({ journey: "design-owned-sound", traits: collision }, completeStatus);
    assert.equal(refused.mode, "intent-clarification-required");
    assert.deepEqual(refused.intent.highLevelTraits, []);
    assert.doesNotMatch(JSON.stringify(refused.guidance), /bright|major|dark/i);
    assert.ok(refused.stages.every((stage) => stage.status === "blocked-by-intent"));
  }
  for (const substring of ["majority business", "brightness and softness"]) {
    const noSubstringMatch = planUserJourney({ journey: "design-owned-sound", traits: substring }, completeStatus);
    assert.deepEqual(noSubstringMatch.intent.highLevelTraits, []);
    assert.equal(noSubstringMatch.mode, "intent-clarification-required");
  }
  const legitimateTitleCase = planUserJourney({ journey: "design-owned-sound", traits: "Warm Spacious" }, completeStatus);
  assert.equal(legitimateTitleCase.intent.identityReferenceMayBePresent, false);
  assert.deepEqual(legitimateTitleCase.intent.highLevelTraits.map((entry) => entry.value), ["warm", "spacious"]);
  const text = renderJourneyPrompt({ journey: "design-owned-sound", traits: "copy Artist X's exact signature patch" }, unavailableStatus);
  assert.match(text, /intent-clarification-required/);
  assert.match(text, /Never forward untrustedOriginalRequest names or exact-copy wording/);
  assert.match(text, /Do not promise exact replication or legal clearance/);
  assert.match(text, /status by color alone/);
  assert.match(text, /report uncertain state/);
});
