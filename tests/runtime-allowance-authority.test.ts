import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeFailureObservation, runtimeAllowanceEvidence } from "../failure-observations.ts";
import { RuntimeReliabilityTracker } from "../runtime-reliability.ts";
import { emptyReliabilityState, recordModelFailure } from "../reliability.ts";
import { admitReliabilityV2Dispatch, emptyReliabilityV2State, settleReliabilityV2Dispatch, modelScopeKey, type ReliabilityV2Config } from "../reliability-v2.ts";

const now = 1_000;
const modelKey = "fixture/model";
const outcomeId = "authority-outcome";
const diagnostic = normalizeFailureObservation({
  outcomeId, modelKey, source: "runtime", errorText: "The usage limit has been reached.",
}, { now })!;
const structured = normalizeFailureObservation({
  outcomeId, modelKey, source: "runtime", structured: { category: "allowance_exhausted" },
}, { now })!;
const context = { modelKey, outcomeId, attribution: "legacy-terminal" as const, now };
const policy: ReliabilityV2Config = {
  failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000,
  leaseTtlMs: 10, maxDispatchLifetimeMs: 100, dedupRetentionMs: 100,
  maxDedupEntries: 16, maxDispatchReceipts: 16,
};

describe("runtime allowance action evidence", () => {
  it("preserves qualified legacy inference without asserting a transport receipt", () => {
    assert.equal(runtimeAllowanceEvidence(diagnostic, context), diagnostic);
    assert.equal(runtimeAllowanceEvidence(structured, context), undefined);
    assert.equal(runtimeAllowanceEvidence(structured, { ...context, attribution: "provider-response" }), structured);
  });
  for (const override of [
    { modelKey: "fixture/other" }, { outcomeId: "other-outcome" },
    { attribution: "unconfirmed" as const }, { now: now - 1 },
  ]) {
    it(`rejects unbound action evidence (${JSON.stringify(override)})`, () => {
      assert.equal(runtimeAllowanceEvidence(diagnostic, { ...context, ...override }), undefined);
    });
  }
  it("keeps diagnostic and qualified evidence separate in the legacy terminal ledger", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin(modelKey);
    tracker.observe([{ role: "assistant", provider: "fixture", model: "model", stopReason: "error" }], () => structured);
    const [outcome] = tracker.settle();
    assert.equal(outcome?.failureObservation, structured);
    assert.equal(outcome?.allowanceEvidence, undefined);
  });
  it("cannot use runtime allowance evidence to authorize an activation cooldown", () => {
    const state = recordModelFailure(emptyReliabilityState(), modelKey, { failureThreshold: 3 },
      now, "setModel", "setModel returned false", diagnostic, diagnostic);
    assert.deepEqual(state.models[modelKey]?.failures, [now]);
    assert.equal(state.models[modelKey]?.openUntil, undefined);
  });
  for (const observations of [false, true]) {
    for (const authorized of [false, true]) {
      it(`V2 observations=${observations}, allowance intent=${authorized}`, () => {
        const admission = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
          ownerToken: "owner", dispatchId: "dispatch", outcomeId, modelKeys: [modelKey], now: now - 1,
        }, policy);
        assert.equal(admission.status, "admitted");
        const result = settleReliabilityV2Dispatch(admission.state, {
          ownerToken: "owner", dispatchId: "dispatch", outcomeId, now,
          settlement: { kind: "failure",
            ...(observations ? { observation: diagnostic } : {}),
            ...(authorized ? { allowanceExhaustion: diagnostic } : {}),
          },
        }, policy);
        assert.equal(result.status, "settled");
        assert.equal(result.state.scopes[modelScopeKey(modelKey)]?.openUntil, authorized ? now + 60_000 : undefined);
        assert.equal(result.state.settledOutcomes[outcomeId]?.observation?.category, observations ? "allowance_exhausted" : undefined);
      });
    }
  }
  it("rejects contradictory diagnostic and allowance intent on the same receipt", () => {
    const admission = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
      ownerToken: "owner", dispatchId: "dispatch", outcomeId, modelKeys: [modelKey], now: now - 1,
    }, policy);
    const ordinary = normalizeFailureObservation({
      outcomeId, modelKey, source: "runtime", errorText: "network error",
    }, { now })!;
    const result = settleReliabilityV2Dispatch(admission.state, {
      ownerToken: "owner", dispatchId: "dispatch", outcomeId, now,
      settlement: { kind: "failure", observation: ordinary, allowanceExhaustion: diagnostic },
    }, policy);
    assert.equal(result.status, "invalid");
    assert.equal(result.state.scopes[modelScopeKey(modelKey)]?.openUntil, undefined);
  });
});

describe("store allowance intent binding", () => {
  const foreignModel = normalizeFailureObservation({
    outcomeId, modelKey: "fixture/other", source: "runtime", errorText: "The usage limit has been reached.",
  }, { now })!;
  const foreignOutcome = normalizeFailureObservation({
    outcomeId: "other-outcome", modelKey, source: "runtime", errorText: "The usage limit has been reached.",
  }, { now })!;
  const probe = normalizeFailureObservation({
    outcomeId, modelKey, source: "probe", errorText: "The usage limit has been reached.",
  }, { now })!;
  const beforeAdmission = normalizeFailureObservation({
    outcomeId, modelKey, source: "runtime", observedAt: now - 2, errorText: "The usage limit has been reached.",
  }, { now })!;

  for (const [label, evidence] of [
    ["foreign model", foreignModel], ["probe origin", probe],
  ] as const) {
    it(`V1 counts ordinary failure without escalating ${label} intent`, () => {
      const state = recordModelFailure(emptyReliabilityState(), modelKey,
        { failureThreshold: 3, cooldownMinutes: 1 }, now, "agent_settled", "provider failed",
        diagnostic, evidence);
      assert.deepEqual(state.models[modelKey]?.failures, [now]);
      assert.equal(state.models[modelKey]?.openUntil, undefined);
      assert.deepEqual(Object.keys(state.models), [modelKey]);
    });
  }

  for (const enabled of [false, true]) {
    it(`V1 respects allowance opt-in=${enabled} independently of diagnostics`, () => {
      const state = recordModelFailure(emptyReliabilityState(), modelKey,
        { failureThreshold: 3, cooldownMinutes: 1, cooldownOnAllowanceExhausted: enabled },
        now, "agent_settled", "provider failed", undefined, diagnostic);
      assert.deepEqual(state.models[modelKey]?.failures, [now]);
      assert.equal(state.models[modelKey]?.openUntil, enabled ? now + 60_000 : undefined);
    });
  }

  for (const [label, evidence] of [
    ["foreign model", foreignModel], ["foreign outcome", foreignOutcome],
    ["probe origin", probe], ["pre-admission timestamp", beforeAdmission],
  ] as const) {
    it(`V2 rejects ${label} allowance intent without settling the receipt`, () => {
      const admission = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
        ownerToken: "owner", dispatchId: "dispatch", outcomeId, modelKeys: [modelKey], now: now - 1,
      }, policy);
      assert.equal(admission.status, "admitted");
      const result = settleReliabilityV2Dispatch(admission.state, {
        ownerToken: "owner", dispatchId: "dispatch", outcomeId, now,
        settlement: { kind: "failure", allowanceExhaustion: evidence },
      }, policy);
      assert.equal(result.status, "invalid");
      assert.deepEqual(result.state, admission.state);
      assert.equal(result.state.settledOutcomes[outcomeId], undefined);
    });
  }

  for (const observations of [false, true]) {
    it(`V2 opt-out preserves ordinary accounting with observations=${observations}`, () => {
      const disabled = { ...policy, cooldownOnAllowanceExhausted: false };
      const admission = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
        ownerToken: "owner", dispatchId: "dispatch", outcomeId, modelKeys: [modelKey], now: now - 1,
      }, disabled);
      assert.equal(admission.status, "admitted");
      const result = settleReliabilityV2Dispatch(admission.state, {
        ownerToken: "owner", dispatchId: "dispatch", outcomeId, now,
        settlement: { kind: "failure", allowanceExhaustion: diagnostic,
          ...(observations ? { observation: diagnostic } : {}) },
      }, disabled);
      assert.equal(result.status, "settled");
      assert.deepEqual(result.state.scopes[modelScopeKey(modelKey)]?.failures, [now]);
      assert.equal(result.state.scopes[modelScopeKey(modelKey)]?.openUntil, undefined);
      assert.equal(result.state.settledOutcomes[outcomeId]?.observation?.category,
        observations ? "allowance_exhausted" : undefined);
    });
  }
});
