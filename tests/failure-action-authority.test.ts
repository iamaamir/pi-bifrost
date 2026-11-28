import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeFailureObservation } from "../failure-observations.ts";
import { emptyReliabilityState, recordModelFailure } from "../reliability.ts";
import {
  admitReliabilityV2Dispatch, emptyReliabilityV2State, modelScopeKey,
  settleReliabilityV2Dispatch, type ReliabilityV2Config,
} from "../reliability-v2.ts";

const modelKey = "fixture/model";
const outcomeId = "authority-outcome";
const now = 1_000;
const diagnostic = normalizeFailureObservation({
  outcomeId, modelKey, source: "runtime", observedAt: now,
  errorText: "The usage limit has been reached.",
}, { now })!;
const v2Config: ReliabilityV2Config = {
  failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000,
  leaseTtlMs: 10, maxDispatchLifetimeMs: 100, dedupRetentionMs: 100,
  maxDedupEntries: 16, maxDispatchReceipts: 16,
};

describe("failure action authority", () => {
  it("V1 records a diagnostic without treating it as immediate allowance authority", () => {
    const state = recordModelFailure(emptyReliabilityState(), modelKey,
      { failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 1 },
      now, "agent_settled", "provider request failed", diagnostic);
    assert.deepEqual(state.models[modelKey]?.failures, [now]);
    assert.equal(state.models[modelKey]?.openUntil, undefined);
  });

  it("V2 observation persistence does not authorize an allowance cooldown", () => {
    const admitted = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
      ownerToken: "owner", dispatchId: "dispatch", outcomeId, modelKeys: [modelKey], now: now - 1,
    }, v2Config);
    assert.equal(admitted.status, "admitted");
    const result = settleReliabilityV2Dispatch(admitted.state, {
      ownerToken: "owner", dispatchId: "dispatch", outcomeId, now,
      settlement: { kind: "failure", observation: diagnostic },
    }, v2Config);
    assert.equal(result.status, "settled");
    assert.equal(result.state.settledOutcomes[outcomeId]?.observation?.category, "allowance_exhausted");
    assert.deepEqual(result.state.scopes[modelScopeKey(modelKey)]?.failures, [now]);
    assert.equal(result.state.scopes[modelScopeKey(modelKey)]?.openUntil, undefined);
  });
});
