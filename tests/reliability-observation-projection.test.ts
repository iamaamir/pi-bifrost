import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeFailureObservation } from "../failure-observations.ts";
import { admitReliabilityV2Dispatch, emptyReliabilityV2State, modelScopeKey, settleReliabilityV2Dispatch, validateReliabilityV2State, type ReliabilityV2Config } from "../reliability-v2.ts";
import { projectReliabilityV2Observations } from "../reliability-observation-projection.ts";

const config: ReliabilityV2Config = {
  failureThreshold: 2,
  windowMs: 60_000,
  cooldownMs: 10,
  leaseTtlMs: 10,
  maxDispatchLifetimeMs: 100,
  dedupRetentionMs: 100,
  maxDedupEntries: 16,
  maxDispatchReceipts: 16,
};

function recordFailure(modelKey: string, dispatchId: string, outcomeId: string, admittedAt: number, observedAt: number, settledAt: number, state = emptyReliabilityV2State()) {
  const admitted = admitReliabilityV2Dispatch(state, {
    ownerToken: `owner-${dispatchId}`, dispatchId, outcomeId, modelKeys: [modelKey], now: admittedAt,
  }, config);
  assert.equal(admitted.status, "admitted");
  const observation = normalizeFailureObservation({
    outcomeId, modelKey, source: "runtime", observedAt,
    structured: { category: "transport", retryAt: observedAt + 50 },
    errorText: "private error text /users/example/secret",
  }, { now: observedAt })!;
  return settleReliabilityV2Dispatch(admitted.state, {
    ownerToken: `owner-${dispatchId}`, dispatchId, outcomeId,
    settlement: { kind: "failure", observation }, now: settledAt,
  }, config);
}

describe("reliability v2 observation projection", () => {
  it("returns only the latest retained content-free category per model", () => {
    const first = recordFailure("openai/gpt-a", "dispatch-one", "outcome-one", 1, 2, 3);
    const second = recordFailure("openai/gpt-a", "dispatch-two", "outcome-two", 4, 5, 6, first.state);
    const output = projectReliabilityV2Observations(second.state, config, 7)!;
    assert.equal(output.length, 1);
    assert.deepEqual(output[0], {
      modelKey: "openai/gpt-a", category: "transport", categoryEvidence: "structured",
      observedAt: 5, retryAt: 55, source: "runtime",
    });
    assert.equal(JSON.stringify(output).includes("outcome-one"), false);
    assert.equal(JSON.stringify(output).includes("private error text"), false);
    assert.equal(Object.isFrozen(output), true);
    assert.equal(Object.isFrozen(output[0]), true);
  });

  it("hides summaries after dedup expiry and reads old entries without summaries", () => {
    const settled = recordFailure("openai/gpt-a", "dispatch-expiry", "outcome-expiry", 1, 2, 3);
    assert.equal(projectReliabilityV2Observations(settled.state, config, 104)?.length, 0);
    const legacy = JSON.parse(JSON.stringify(settled.state));
    delete legacy.settledOutcomes["outcome-expiry"].observation;
    assert.deepEqual(projectReliabilityV2Observations(legacy, config, 3), []);
  });

  it("excludes future observations after clock rollback and validates retained summary links", () => {
    const settled = recordFailure("openai/gpt-a", "dispatch-prune", "outcome-prune", 1, 2, 3);
    assert.deepEqual(projectReliabilityV2Observations(settled.state, config, 1), []);
    const afterReceiptPrune = admitReliabilityV2Dispatch(settled.state, {
      ownerToken: "owner-other", dispatchId: "dispatch-other", outcomeId: "outcome-other",
      modelKeys: ["openai/gpt-b"], now: 102,
    }, config);
    assert.equal(afterReceiptPrune.status, "admitted");
    assert.equal(afterReceiptPrune.state.dispatches["dispatch-prune"], undefined);
    assert.ok(afterReceiptPrune.state.settledOutcomes["outcome-prune"]?.observation);

    const noModelScope = JSON.parse(JSON.stringify(afterReceiptPrune.state));
    delete noModelScope.scopes[modelScopeKey("openai/gpt-a")];
    assert.equal(validateReliabilityV2State(noModelScope, config), false);
    assert.equal(projectReliabilityV2Observations(noModelScope, config, 102), undefined);

    const expiredBeforeFact = JSON.parse(JSON.stringify(afterReceiptPrune.state));
    expiredBeforeFact.settledOutcomes["outcome-prune"].expiresAt = 1;
    assert.equal(validateReliabilityV2State(expiredBeforeFact, config), false);
  });

  it("fails closed for invalid state or clock input", () => {
    const settled = recordFailure("openai/gpt-a", "dispatch-invalid", "outcome-invalid", 1, 2, 3);
    assert.equal(projectReliabilityV2Observations(settled.state, config, Number.NaN), undefined);
    const corrupt = JSON.parse(JSON.stringify(settled.state));
    corrupt.settledOutcomes["outcome-invalid"].observation.category = "private provider label";
    assert.equal(projectReliabilityV2Observations(corrupt, config, 4), undefined);
  });
});
