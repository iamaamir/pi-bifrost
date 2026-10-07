import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeFailureObservation } from "../failure-observations.ts";
import {
  abandonReliabilityV2Dispatch,
  admitReliabilityV2Dispatch,
  emptyReliabilityV2State,
  modelScopeKey,
  renewReliabilityV2Leases,
  settleReliabilityV2Dispatch,
  validateReliabilityV2State,
  type ReliabilityV2Config,
  type ReliabilityV2State,
} from "../reliability-v2.ts";

const config: ReliabilityV2Config = {
  failureThreshold: 1,
  windowMs: 60_000,
  cooldownMs: 10,
  leaseTtlMs: 10,
  maxDispatchLifetimeMs: 100,
  dedupRetentionMs: 100,
  maxDedupEntries: 16,
  maxDispatchReceipts: 16,
};

const modelA = "openai/gpt-a";
const modelB = "openai/org/gpt-b";

function halfOpenState(...models: string[]): ReliabilityV2State {
  const state = emptyReliabilityV2State();
  for (const model of models) {
    state.scopes[modelScopeKey(model)] = { generation: 1, failures: [1], openUntil: 10 };
  }
  return state;
}

function admit(
  state: ReliabilityV2State,
  dispatchId: string,
  outcomeId: string,
  ownerToken: string,
  modelKeys: string[],
  now: number,
  useConfig = config,
) {
  const result = admitReliabilityV2Dispatch(state, { dispatchId, outcomeId, ownerToken, modelKeys, now }, useConfig);
  assertResultState(result, useConfig);
  return result;
}

function settle(
  state: ReliabilityV2State,
  dispatchId: string,
  outcomeId: string,
  ownerToken: string,
  kind: "success" | "failure" | "cancelled",
  now: number,
  useConfig = config,
) {
  const result = settleReliabilityV2Dispatch(state, {
    dispatchId,
    outcomeId,
    ownerToken,
    settlement: { kind },
    now,
  }, useConfig);
  assertResultState(result, useConfig);
  return result;
}

function scope(state: ReliabilityV2State, model = modelA) {
  return state.scopes[modelScopeKey(model)]!;
}

function assertResultState(result: ReturnType<typeof admitReliabilityV2Dispatch>, useConfig = config): void {
  if (result.status === "invalid") return;
  assert.equal(validateReliabilityV2State(result.state, useConfig), true, `invalid output state for ${result.status}`);
  assert.equal(validateReliabilityV2State(JSON.parse(JSON.stringify(result.state)), useConfig), true, `invalid JSON state for ${result.status}`);
}

describe("experimental reliability v2 transitions", () => {
  it("creates model-only admission receipts and generation-bearing lease references", () => {
    const result = admit(halfOpenState(modelA), "dispatch-a", "outcome-a", "owner-a", [modelA], 10);
    assert.equal(result.status, "admitted");
    assert.deepEqual(result.leases?.[0], {
      scopeKey: modelScopeKey(modelA),
      generation: 1,
      leaseId: "dispatch-a",
      expiresAt: 20,
      maxExpiresAt: 110,
    });
    assert.equal(scope(result.state).lease?.ownerToken, "owner-a");
    assert.equal(validateReliabilityV2State(result.state, config), true);
  });

  it("checks every scope before mutating any lease", () => {
    const first = admit(halfOpenState(modelA, modelB), "dispatch-b", "outcome-b", "owner-b", [modelB], 10);
    assert.equal(first.status, "admitted");
    const blocked = admit(first.state, "dispatch-c", "outcome-c", "owner-c", [modelA, modelB], 10);
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.state, first.state);
    assert.equal(scope(blocked.state, modelA).lease, undefined);
    assert.equal(scope(blocked.state, modelB).lease?.ownerToken, "owner-b");
  });

  it("lets only one owner claim a half-open generation", () => {
    const initial = halfOpenState(modelA);
    const winner = admit(initial, "dispatch-a", "outcome-a", "owner-a", [modelA], 10);
    const contender = admit(winner.state, "dispatch-b", "outcome-b", "owner-b", [modelA], 10);
    assert.equal(winner.status, "admitted");
    assert.equal(contender.status, "blocked");
    assert.deepEqual(contender.state, winner.state);
  });

  it("fences an older success after a newer failure advances the generation", () => {
    const oldSuccess = admit(emptyReliabilityV2State(), "dispatch-old-success", "outcome-old-success", "owner-a", [modelA], 0);
    const newerFailure = admit(oldSuccess.state, "dispatch-newer-failure", "outcome-newer-failure", "owner-b", [modelA], 0);
    const opened = settle(newerFailure.state, "dispatch-newer-failure", "outcome-newer-failure", "owner-b", "failure", 1);
    assert.equal(scope(opened.state).generation, 1);
    assert.equal(scope(opened.state).openUntil, 11);

    const trial = admit(opened.state, "dispatch-trial", "outcome-trial", "owner-c", [modelA], 11);
    assert.equal(trial.status, "admitted");
    const lateFailure = settle(trial.state, "dispatch-old-success", "outcome-old-success", "owner-a", "failure", 12);
    assert.equal(scope(lateFailure.state).generation, 2);
    assert.equal(scope(lateFailure.state).lease, undefined);

    const staleSuccess = settle(lateFailure.state, "dispatch-trial", "outcome-trial", "owner-c", "success", 13);
    assert.equal(staleSuccess.status, "stale");
    assert.equal(scope(staleSuccess.state).generation, 2);
    assert.equal(scope(staleSuccess.state).openUntil, 22);
  });

  it("rejects a reclaimed lease owner and allows the new owner to close the circuit", () => {
    const first = admit(halfOpenState(modelA), "dispatch-first", "outcome-first", "owner-first", [modelA], 10);
    const reclaimed = admit(first.state, "dispatch-next", "outcome-next", "owner-next", [modelA], 21);
    assert.equal(reclaimed.status, "admitted");

    const staleRenew = renewReliabilityV2Leases(first.state, {
      dispatchId: "dispatch-first", outcomeId: "outcome-first", ownerToken: "owner-first",
      leaseReferences: first.leases, now: 21,
    }, config);
    assertResultState(staleRenew);
    assert.equal(staleRenew.status, "stale");

    const staleSuccess = settle(reclaimed.state, "dispatch-first", "outcome-first", "owner-first", "success", 22);
    assert.equal(staleSuccess.status, "stale");
    assert.equal(scope(staleSuccess.state).lease?.ownerToken, "owner-next");
    assert.equal(validateReliabilityV2State(staleSuccess.state, config), true);
    assert.equal(validateReliabilityV2State(JSON.parse(JSON.stringify(staleSuccess.state)), config), true);

    const closed = settle(staleSuccess.state, "dispatch-next", "outcome-next", "owner-next", "success", 22);
    assert.equal(closed.status, "settled");
    assert.equal(scope(closed.state).openUntil, undefined);
    assert.equal(scope(closed.state).lease, undefined);
    assert.equal(scope(closed.state).generation, 2);
  });

  it("requires the exact owner, dispatch, outcome and receipt scopes", () => {
    const admitted = admit(halfOpenState(modelA), "dispatch-a", "outcome-a", "owner-a", [modelA], 10);
    const wrongOwner = settle(admitted.state, "dispatch-a", "outcome-a", "owner-other", "success", 11);
    const wrongOutcome = settle(admitted.state, "dispatch-a", "outcome-other", "owner-a", "success", 11);
    const injectedScope = settleReliabilityV2Dispatch(admitted.state, {
      dispatchId: "dispatch-a", outcomeId: "outcome-a", ownerToken: "owner-a",
      settlement: { kind: "success" }, now: 11, modelKeys: [modelB],
    }, config);
    assertResultState(injectedScope);
    assert.equal(wrongOwner.status, "stale");
    assert.equal(wrongOutcome.status, "stale");
    assert.equal(injectedScope.status, "invalid");
    assert.deepEqual(wrongOwner.state, admitted.state);
    assert.deepEqual(wrongOutcome.state, admitted.state);
  });

  it("rejects expired dispatch settlements and never counts them after dedup expiry", () => {
    const admitted = admit(emptyReliabilityV2State(), "dispatch-late", "outcome-late", "owner-late", [modelA], 0);
    const late = settle(admitted.state, "dispatch-late", "outcome-late", "owner-late", "failure", 106);
    assert.equal(late.status, "expired");
    assert.deepEqual(late.state, admitted.state);
    assert.equal(scope(late.state).generation, 0);
  });

  it("releases only an expired receipt lease when pruning it during unrelated admission", () => {
    const trial = admit(halfOpenState(modelA), "dispatch-expiring", "outcome-expiring", "owner-expiring", [modelA], 10);
    const unrelated = admit(trial.state, "dispatch-unrelated", "outcome-unrelated", "owner-unrelated", [modelB], 111);
    assert.equal(unrelated.status, "admitted");
    assert.equal(scope(unrelated.state).lease, undefined);
    assert.equal(unrelated.state.dispatches["dispatch-expiring"], undefined);
    assert.equal(validateReliabilityV2State(unrelated.state, config), true);
    const jsonRoundtrip = JSON.parse(JSON.stringify(unrelated.state)) as ReliabilityV2State;
    assert.equal(validateReliabilityV2State(jsonRoundtrip, config), true);
  });

  it("records an expired success as stale and releases only its exact expired lease", () => {
    const admitted = admit(halfOpenState(modelA), "dispatch-expired-success", "outcome-expired-success", "owner-expired-success", [modelA], 10);
    const result = settle(admitted.state, "dispatch-expired-success", "outcome-expired-success", "owner-expired-success", "success", 21);
    assert.equal(result.status, "stale");
    assert.equal(scope(result.state).lease, undefined);
    assert.equal(scope(result.state).generation, 1);
    assert.equal(validateReliabilityV2State(result.state, config), true);
    assert.equal(validateReliabilityV2State(JSON.parse(JSON.stringify(result.state)), config), true);
  });

  it("fails closed when dedup capacity is full and distinguishes it from duplicate settle", () => {
    const small = { ...config, maxDedupEntries: 1 };
    const first = admit(emptyReliabilityV2State(), "dispatch-a", "outcome-a", "owner-a", [modelA], 0, small);
    const settled = settle(first.state, "dispatch-a", "outcome-a", "owner-a", "success", 1, small);
    assert.equal(settled.status, "settled");
    const duplicate = settle(settled.state, "dispatch-a", "outcome-a", "owner-a", "success", 2, small);
    assert.equal(duplicate.status, "duplicate");

    const second = admit(settled.state, "dispatch-b", "outcome-b", "owner-b", [modelB], 2, small);
    assert.equal(second.status, "admitted");
    const full = settle(second.state, "dispatch-b", "outcome-b", "owner-b", "failure", 3, small);
    assert.equal(full.status, "capacity");
    assert.deepEqual(full.state, second.state);
    assert.equal(scope(full.state, modelB).generation, 0);
  });

  it("does not let clean success on a previously closed dispatch clear a newer failure", () => {
    const clean = admit(emptyReliabilityV2State(), "dispatch-clean", "outcome-clean", "owner-clean", [modelA], 0);
    const failing = admit(clean.state, "dispatch-failing", "outcome-failing", "owner-failing", [modelA], 0);
    const opened = settle(failing.state, "dispatch-failing", "outcome-failing", "owner-failing", "failure", 1);
    const lateClean = settle(opened.state, "dispatch-clean", "outcome-clean", "owner-clean", "success", 2);
    assert.equal(lateClean.status, "settled");
    assert.equal(scope(lateClean.state).openUntil, 11);
    assert.equal(scope(lateClean.state).generation, 1);
  });

  it("cancellation abandons only the owner's leases without adding a failure", () => {
    const admitted = admit(halfOpenState(modelA), "dispatch-cancel", "outcome-cancel", "owner-cancel", [modelA], 10);
    const cancelled = abandonReliabilityV2Dispatch(admitted.state, {
      dispatchId: "dispatch-cancel", outcomeId: "outcome-cancel", ownerToken: "owner-cancel",
      leaseReferences: admitted.leases, now: 11,
    }, config);
    assertResultState(cancelled);
    assert.equal(cancelled.status, "abandoned");
    assert.equal(scope(cancelled.state).lease, undefined);
    assert.deepEqual(scope(cancelled.state).failures, [1]);
    const repeat = settle(cancelled.state, "dispatch-cancel", "outcome-cancel", "owner-cancel", "failure", 12);
    assert.equal(repeat.status, "duplicate");
    assert.deepEqual(scope(repeat.state).failures, [1]);
  });

  it("renews every owned lease only within its fixed dispatch horizon", () => {
    const admitted = admit(halfOpenState(modelA), "dispatch-renew", "outcome-renew", "owner-renew", [modelA], 10);
    const renewed = renewReliabilityV2Leases(admitted.state, {
      dispatchId: "dispatch-renew", outcomeId: "outcome-renew", ownerToken: "owner-renew",
      leaseReferences: admitted.leases, now: 15, ttlMs: 10,
    }, config);
    assertResultState(renewed);
    assert.equal(renewed.status, "renewed");
    assert.equal(renewed.leases?.[0]?.expiresAt, 25);
    assert.equal(renewed.leases?.[0]?.maxExpiresAt, 110);
    const beyondHorizon = renewReliabilityV2Leases(renewed.state, {
      dispatchId: "dispatch-renew", outcomeId: "outcome-renew", ownerToken: "owner-renew",
      leaseReferences: renewed.leases, now: 111,
    }, config);
    assertResultState(beyondHorizon);
    assert.equal(beyondHorizon.status, "expired");
  });

  it("validates config, counters, maps, prototypes, and time arithmetic before transitions", () => {
    const invalidConfig = { ...config, dedupRetentionMs: 99 };
    assert.equal(admit(emptyReliabilityV2State(), "dispatch-a", "outcome-a", "owner-a", [modelA], 0, invalidConfig).status, "invalid");

    const badRevision = emptyReliabilityV2State();
    badRevision.revision = Number.MAX_SAFE_INTEGER;
    assert.equal(admit(badRevision, "dispatch-a", "outcome-a", "owner-a", [modelA], 0).status, "overflow");
    assert.equal(admit(emptyReliabilityV2State(), "dispatch-a", "outcome-a", "owner-a", [modelA], Number.MAX_VALUE).status, "invalid");

    const inherited = Object.assign(Object.create({ polluted: true }), emptyReliabilityV2State());
    assert.equal(validateReliabilityV2State(inherited, config), false);
    assert.equal(validateReliabilityV2State({ ...emptyReliabilityV2State(), revision: Number.POSITIVE_INFINITY }, config), false);
  });

  it("does not partially settle multiple scopes when any generation overflows", () => {
    const admitted = admit(emptyReliabilityV2State(), "dispatch-multi", "outcome-multi", "owner-multi", [modelA, modelB], 0);
    const nearOverflow = JSON.parse(JSON.stringify(admitted.state)) as ReliabilityV2State;
    nearOverflow.scopes[modelScopeKey(modelB)]!.generation = Number.MAX_SAFE_INTEGER;
    assert.equal(validateReliabilityV2State(nearOverflow, config), true);

    const result = settle(nearOverflow, "dispatch-multi", "outcome-multi", "owner-multi", "failure", 1);
    assert.equal(result.status, "overflow");
    assert.deepEqual(result.state, nearOverflow);
    assert.equal(scope(result.state, modelA).generation, 0);
  });

  it("fails closed when a trial generation cannot advance on success", () => {
    const initial = halfOpenState(modelA);
    initial.scopes[modelScopeKey(modelA)]!.generation = Number.MAX_SAFE_INTEGER;
    const admitted = admit(initial, "dispatch-overflow", "outcome-overflow", "owner-overflow", [modelA], 10);
    assert.equal(admitted.status, "admitted");
    const result = settle(admitted.state, "dispatch-overflow", "outcome-overflow", "owner-overflow", "success", 11);
    assert.equal(result.status, "overflow");
    assert.deepEqual(result.state, admitted.state);
    assert.equal(scope(result.state).lease?.ownerToken, "owner-overflow");
  });

  it("persists only a model-bound content-free summary with the failure dedup outcome", () => {
    const admitted = admit(emptyReliabilityV2State(), "dispatch-observe", "outcome-observe", "owner-observe", [modelA], 1);
    const observation = normalizeFailureObservation({
      outcomeId: "outcome-observe", modelKey: modelA, source: "runtime", observedAt: 2,
      structured: { category: "allowance_exhausted" },
      errorText: "secret prompt and /private/path must not persist",
    }, { now: 2 })!;
    const settled = settleReliabilityV2Dispatch(admitted.state, {
      ownerToken: "owner-observe", dispatchId: "dispatch-observe", outcomeId: "outcome-observe",
      settlement: { kind: "failure", observation }, now: 3,
    }, config);
    assertResultState(settled);
    assert.equal(settled.status, "settled");
    assert.deepEqual(settled.state.settledOutcomes["outcome-observe"]?.observation, {
      modelKey: modelA, category: "allowance_exhausted", categoryEvidence: "structured", observedAt: 2, source: "runtime",
    });
    assert.equal(JSON.stringify(settled.state).includes("secret prompt"), false);
    assert.equal(JSON.stringify(settled.state).includes("/private/path"), false);
    assert.equal(Object.hasOwn(settled.state.settledOutcomes["outcome-observe"]!.observation!, "outcomeId"), false);
  });

  it("accepts actual normalized unknown and text evidence with retry timing", () => {
    const cases = [
      {
        dispatchId: "dispatch-unknown-retry", outcomeId: "outcome-unknown-retry",
        input: { structured: { retryAt: 12 }, errorText: "unusual response" },
        category: "unknown", evidence: "unknown",
      },
      {
        dispatchId: "dispatch-text-retry", outcomeId: "outcome-text-retry",
        input: { structured: { retryAt: 12 }, errorText: "connection reset" },
        category: "transport", evidence: "text_heuristic",
      },
    ] as const;
    for (const item of cases) {
      const admitted = admit(emptyReliabilityV2State(), item.dispatchId, item.outcomeId, `owner-${item.dispatchId}`, [modelA], 10);
      const observation = normalizeFailureObservation({
        ...item.input, outcomeId: item.outcomeId, modelKey: modelA, source: "runtime", observedAt: 11,
      }, { now: 11 })!;
      assert.equal(observation.category, item.category);
      assert.equal(observation.categoryEvidence, item.evidence);
      assert.equal(observation.retryAt, 12);
      const settled = settleReliabilityV2Dispatch(admitted.state, {
        ownerToken: `owner-${item.dispatchId}`, dispatchId: item.dispatchId, outcomeId: item.outcomeId,
        settlement: { kind: "failure", observation }, now: 12,
      }, config);
      assert.equal(settled.status, "settled");
      assert.equal(settled.state.settledOutcomes[item.outcomeId]?.observation?.category, item.category);
      assert.equal(settled.state.settledOutcomes[item.outcomeId]?.observation?.retryAt, 12);
    }
  });

  it("rejects mismatched, multi-model, raw-metadata, and out-of-window observations atomically", () => {
    const admitted = admit(emptyReliabilityV2State(), "dispatch-observe-bad", "outcome-observe-bad", "owner-observe-bad", [modelA], 10);
    const good = normalizeFailureObservation({
      outcomeId: "outcome-observe-bad", modelKey: modelA, source: "runtime", observedAt: 11,
      structured: { category: "transport" },
    }, { now: 11 })!;
    const variants = [
      { ...good, outcomeId: "outcome-other" },
      { ...good, modelKey: modelB, scope: { kind: "model" as const, modelKey: modelB } },
      { ...good, observedAt: 9 },
      { ...good, errorText: "private caller metadata" },
    ];
    for (const observation of variants) {
      const result = settleReliabilityV2Dispatch(admitted.state, {
        ownerToken: "owner-observe-bad", dispatchId: "dispatch-observe-bad", outcomeId: "outcome-observe-bad",
        settlement: { kind: "failure", observation }, now: 12,
      }, config);
      assert.equal(result.status, "invalid");
      assert.deepEqual(result.state, admitted.state);
    }
    const multi = admit(emptyReliabilityV2State(), "dispatch-observe-multi", "outcome-observe-multi", "owner-observe-multi", [modelA, modelB], 10);
    const multiObservation = normalizeFailureObservation({
      outcomeId: "outcome-observe-multi", modelKey: modelA, source: "runtime", observedAt: 11,
      structured: { category: "transport" },
    }, { now: 11 })!;
    const rejected = settleReliabilityV2Dispatch(multi.state, {
      ownerToken: "owner-observe-multi", dispatchId: "dispatch-observe-multi", outcomeId: "outcome-observe-multi",
      settlement: { kind: "failure", observation: multiObservation }, now: 12,
    }, config);
    assert.equal(rejected.status, "invalid");
    assert.deepEqual(rejected.state, multi.state);
    const ordinaryFailure = settle(multi.state, "dispatch-observe-multi", "outcome-observe-multi", "owner-observe-multi", "failure", 12);
    assert.equal(ordinaryFailure.status, "settled");
    assert.equal(scope(ordinaryFailure.state, modelA).generation, 1);
    assert.equal(scope(ordinaryFailure.state, modelB).generation, 1);
  });

  it("keeps duplicate observations idempotent and accepts legacy dedup entries without summaries", () => {
    const admitted = admit(emptyReliabilityV2State(), "dispatch-observe-dup", "outcome-observe-dup", "owner-observe-dup", [modelA], 10);
    const observation = normalizeFailureObservation({
      outcomeId: "outcome-observe-dup", modelKey: modelA, source: "runtime", observedAt: 11,
      structured: { httpStatus: 429 },
    }, { now: 11 })!;
    const request = {
      ownerToken: "owner-observe-dup", dispatchId: "dispatch-observe-dup", outcomeId: "outcome-observe-dup",
      settlement: { kind: "failure" as const, observation }, now: 12,
    };
    const settled = settleReliabilityV2Dispatch(admitted.state, request, config);
    assert.equal(settled.status, "settled");
    assert.equal(settled.state.settledOutcomes["outcome-observe-dup"]?.observation?.category, "rate_limit");
    assert.equal(settled.state.settledOutcomes["outcome-observe-dup"]?.observation?.categoryEvidence, "http_status");
    const duplicate = settleReliabilityV2Dispatch(settled.state, request, config);
    assert.equal(duplicate.status, "duplicate");
    const changed = settleReliabilityV2Dispatch(settled.state, {
      ...request,
      settlement: { kind: "failure", observation: { ...observation, category: "overload", categoryEvidence: "http_status" } },
    }, config);
    assert.equal(changed.status, "invalid");
    assert.deepEqual(changed.state, settled.state);
    const legacy = JSON.parse(JSON.stringify(settled.state)) as ReliabilityV2State;
    delete legacy.settledOutcomes["outcome-observe-dup"]!.observation;
    assert.equal(validateReliabilityV2State(legacy, config), true);
  });

  it("preserves the fence across serialization and deterministic admission sequences", () => {
    let state = halfOpenState(modelA);
    const original = admit(state, "dispatch-owner", "outcome-owner", "owner-one", [modelA], 10);
    assert.equal(original.status, "admitted");
    state = JSON.parse(JSON.stringify(original.state)) as ReliabilityV2State;
    assert.equal(validateReliabilityV2State(state, config), true);

    for (let index = 0; index < 9; index += 1) {
      const contender = admit(state, `dispatch-${index}`, `outcome-${index}`, `owner-${index}`, [modelA], 11 + index);
      assert.equal(contender.status, "blocked");
      assert.deepEqual(contender.state, state);
    }
    const wrongOwner = settle(state, "dispatch-owner", "outcome-owner", "owner-two", "success", 12);
    assert.equal(wrongOwner.status, "stale");
    assert.equal(scope(wrongOwner.state).lease?.ownerToken, "owner-one");
  });

  it("uses own map properties for prototype-named dispatch and outcome IDs after JSON reload", () => {
    const initial = admit(emptyReliabilityV2State(), "constructor", "toString", "owner-prototype", [modelA], 0);
    assert.equal(initial.status, "admitted");
    const snapshot = JSON.parse(JSON.stringify(initial.state)) as ReliabilityV2State;
    assert.equal(validateReliabilityV2State(snapshot, config), true);

    const settled = settle(snapshot, "constructor", "toString", "owner-prototype", "success", 1);
    assert.equal(settled.status, "settled");
    const settledSnapshot = JSON.parse(JSON.stringify(settled.state)) as ReliabilityV2State;
    assert.equal(validateReliabilityV2State(settledSnapshot, config), true);
    assert.equal(settle(settledSnapshot, "constructor", "toString", "owner-prototype", "failure", 2).status, "duplicate");

    const reversedNames = admit(settledSnapshot, "toString", "constructor", "owner-other", [modelB], 2);
    assert.equal(reversedNames.status, "admitted");
    assert.equal(validateReliabilityV2State(reversedNames.state, config), true);
  });
});
