import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observeAffinity } from "../affinity.ts";

describe("affinity observation", () => {
  it("reports eligible-current evidence and compares the unchanged strategy winner", () => {
    const result = observeAffinity({
      targetOrigin: "automatic",
      eligibleModelKeys: ["openai/gpt-5.4", "openai/gpt-5.4-mini", "anthropic/sonnet"],
      baseStrategyWinner: "anthropic/sonnet",
      anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 },
      snapshotAsOf: 250,
      includeSameProviderAdvisory: true,
    });

    assert.deepEqual(result, {
      version: 1,
      status: "current_eligible",
      snapshotAsOf: 250,
      anchor: {
        modelKey: "openai/gpt-5.4",
        provider: "openai",
        lastSuccessfulDispatchAt: 100,
        ageMs: 150,
      },
      baseStrategyWinner: "anthropic/sonnet",
      baseStrategyComparison: "selected_other",
      sameProviderCandidateAvailable: true,
    });
    assert.equal("selected" in result, false, "observation does not choose or retain a model");
  });

  it("marks the anchor switch-required when it is absent from the final eligible pool", () => {
    const result = observeAffinity({
      targetOrigin: "automatic",
      // This is the pool after hard eligibility filters; reserve-rejected candidates are absent.
      eligibleModelKeys: ["openai/gpt-5.4-mini", "anthropic/sonnet"],
      baseStrategyWinner: "openai/gpt-5.4-mini",
      anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 },
      snapshotAsOf: 250,
      includeSameProviderAdvisory: true,
    });

    assert.equal(result.status, "switch_required");
    if ("baseStrategyComparison" in result) {
      assert.equal(result.baseStrategyComparison, "selected_other");
      assert.equal(result.sameProviderCandidateAvailable, true);
    }
  });

  it("does not recommend a switch when there is no route winner", () => {
    const noEligibleModels = observeAffinity({
      targetOrigin: "automatic",
      eligibleModelKeys: [],
      anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 },
      snapshotAsOf: 250,
    });
    const noStrategyWinner = observeAffinity({
      targetOrigin: "automatic",
      eligibleModelKeys: ["openai/gpt-5.4"],
      anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 },
      snapshotAsOf: 250,
    });

    assert.equal(noEligibleModels.status, "no_route");
    assert.equal(noStrategyWinner.status, "no_route");
    assert.notEqual(noEligibleModels.status, "switch_required");
    assert.notEqual(noStrategyWinner.status, "switch_required");
  });

  it("reports unknown locality without a successful-dispatch anchor", () => {
    assert.deepEqual(observeAffinity({
      targetOrigin: "automatic",
      eligibleModelKeys: ["openai/gpt-5.4"],
      baseStrategyWinner: "openai/gpt-5.4",
      snapshotAsOf: 250,
    }), {
      version: 1,
      status: "locality_unknown",
      snapshotAsOf: 250,
      baseStrategyComparison: "no_anchor",
    });
  });

  it("does not advise on explicit, pinned, disabled, or non-user targets", () => {
    const origins = ["explicit_tier", "explicit_model", "pinned", "off", "direct", "continuation", "retry"];
    for (const targetOrigin of origins) {
      assert.deepEqual(observeAffinity({
        targetOrigin,
        eligibleModelKeys: ["openai/gpt-5.4"],
        anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 },
        snapshotAsOf: 250,
      }), { version: 1, status: "not_applicable", snapshotAsOf: 250 });
    }
  });

  it("fails closed on unknown origins without echoing caller labels", () => {
    const sentinel = "PRIVATE_TARGET_ORIGIN_SENTINEL";
    const result = observeAffinity({
      targetOrigin: sentinel,
      eligibleModelKeys: [sentinel],
      baseStrategyWinner: "PRIVATE_WINNER_SENTINEL",
      snapshotAsOf: 250,
    });
    assert.deepEqual(result, { version: 1, status: "not_applicable", snapshotAsOf: 250 });
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  });

  it("rejects malformed pools, impossible winners, mismatched providers, and invalid clocks", () => {
    const base = {
      targetOrigin: "automatic",
      eligibleModelKeys: ["openai/gpt-5.4"],
      baseStrategyWinner: "openai/gpt-5.4",
      anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 },
      snapshotAsOf: 250,
    };
    const invalidInputs = [
      { ...base, eligibleModelKeys: ["openai/gpt-5.4", "openai/gpt-5.4"] },
      { ...base, eligibleModelKeys: ["PRIVATE_POOL_OBJECT_SENTINEL"] },
      { ...base, eligibleModelKeys: ["openai/model with spaces"] },
      { ...base, baseStrategyWinner: "anthropic/sonnet" },
      { ...base, anchor: { modelKey: "openai/gpt-5.4", provider: "PRIVATE_PROVIDER_SENTINEL", lastSuccessfulDispatchAt: 100 } },
      { ...base, snapshotAsOf: 250.5 },
      { ...base, snapshotAsOf: 8.64e15 + 1 },
      { ...base, anchor: { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 251 } },
    ];

    for (const input of invalidInputs) {
      assert.throws(() => observeAffinity(input), {
        message: "Invalid affinity observation input.",
      });
    }
    assert.throws(() => observeAffinity({
      ...base,
      eligibleModelKeys: Array.from({ length: 513 }, (_, index) => `fixture/model-${index}`),
    }), { message: "Invalid affinity observation input." });
  });

  it("copies input evidence and freezes its content-free output", () => {
    const eligibleModelKeys = ["openai/gpt-5.4"];
    const anchor = { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 };
    const input = {
      targetOrigin: "automatic",
      eligibleModelKeys,
      anchor,
      snapshotAsOf: 250,
      prompt: "PRIVATE_PROMPT_SENTINEL",
    };
    const result = observeAffinity(input);

    assert.equal(Object.isFrozen(eligibleModelKeys), false);
    assert.equal(Object.isFrozen(anchor), false);
    assert.equal(Object.isFrozen(result), true);
    if (result.status !== "not_applicable" && result.anchor) {
      assert.equal(Object.isFrozen(result.anchor), true);
    }
    assert.equal(JSON.stringify(result).includes("PRIVATE_PROMPT_SENTINEL"), false);
    assert.deepEqual(eligibleModelKeys, ["openai/gpt-5.4"]);
    assert.deepEqual(anchor, { modelKey: "openai/gpt-5.4", provider: "openai", lastSuccessfulDispatchAt: 100 });
  });
});
