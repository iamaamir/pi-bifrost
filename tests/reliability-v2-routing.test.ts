import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCircuitState, type ReliabilityState } from "../reliability.ts";
import {
  admitReliabilityV2Dispatch,
  emptyReliabilityV2State,
  modelScopeKey,
  type ReliabilityV2Config,
  type ReliabilityV2State,
} from "../reliability-v2.ts";
import { projectReliabilityV2ForRouting } from "../reliability-v2-routing.ts";

const config: ReliabilityV2Config = {
  failureThreshold: 2,
  windowMs: 300_000,
  cooldownMs: 600_000,
  leaseTtlMs: 120,
  maxDispatchLifetimeMs: 600,
  dedupRetentionMs: 600,
  maxDedupEntries: 16,
  maxDispatchReceipts: 16,
};

function halfOpenState(): ReliabilityV2State {
  const state = emptyReliabilityV2State();
  state.scopes[modelScopeKey("provider/model")] = { generation: 1, failures: [20, 30], openUntil: 100 };
  return state;
}

function projection(state: ReliabilityV2State, now: number): Readonly<ReliabilityState> {
  return projectReliabilityV2ForRouting(state, config, now);
}

describe("reliability v2 routing projection", () => {
  it("projects only model circuit facts and exposes trialActive only for a live generation lease", () => {
    const admitted = admitReliabilityV2Dispatch(halfOpenState(), {
      ownerToken: "secret-owner-id",
      dispatchId: "secret-dispatch-id",
      outcomeId: "secret-outcome-id",
      modelKeys: ["provider/model"],
      now: 100,
    }, config);
    assert.equal(admitted.status, "admitted");

    const active = projection(admitted.state, 100);
    assert.deepEqual(active.models["provider/model"], {
      failures: [20, 30],
      openUntil: 100,
      trialActive: true,
    });
    assert.equal(getCircuitState(active, "provider/model", 100, config).trialActive, true);
    assert.equal(JSON.stringify(active).includes("secret-owner-id"), false);
    assert.equal(JSON.stringify(active).includes("secret-dispatch-id"), false);
    assert.equal(JSON.stringify(active).includes("secret-outcome-id"), false);

    const expired = projection(admitted.state, 221);
    assert.equal(expired.models["provider/model"]?.trialActive, false);
    assert.equal(expired.models["provider/model"]?.openUntil, 100);
    assert.equal(getCircuitState(expired, "provider/model", 221, config).halfOpen, true);
  });

  it("preserves a future openUntil even when there is no trial lease", () => {
    const state = emptyReliabilityV2State();
    state.scopes[modelScopeKey("provider/model")] = {
      generation: 2,
      failures: [30],
      openUntil: 500,
      cooldownMultiplier: 2,
    };
    const projected = projection(state, 100);
    assert.equal(projected.models["provider/model"]?.openUntil, 500);
    assert.equal(projected.models["provider/model"]?.trialActive, false);
    assert.equal(getCircuitState(projected, "provider/model", 100, config).open, true);
  });

  it("returns a detached, recursively frozen projection", () => {
    const state = emptyReliabilityV2State();
    state.scopes[modelScopeKey("provider/model")] = { generation: 0, failures: [30] };
    const projected = projection(state, 100);
    state.scopes[modelScopeKey("provider/model")]!.failures[0] = 90;

    assert.equal(projected.models["provider/model"]?.failures[0], 30);
    assert.equal(Object.isFrozen(projected), true);
    assert.equal(Object.isFrozen(projected.models), true);
    assert.equal(Object.isFrozen(projected.models["provider/model"]), true);
    assert.equal(Object.isFrozen(projected.models["provider/model"]?.failures), true);
    assert.throws(() => { (projected.models["provider/model"]!.failures as number[]).push(100); }, TypeError);
  });

  it("rejects invalid state and unsafe clocks", () => {
    const state = emptyReliabilityV2State();
    assert.throws(() => projectReliabilityV2ForRouting(state, config, Number.NaN));
    assert.throws(() => projectReliabilityV2ForRouting(state, config, Number.POSITIVE_INFINITY));
    assert.throws(() => projectReliabilityV2ForRouting({ ...state, revision: Number.POSITIVE_INFINITY }, config, 100));
  });
});
