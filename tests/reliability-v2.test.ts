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
  it("keeps persisted failure history valid when the configured threshold is lowered", () => {
    const historyConfig = { ...config, failureThreshold: 3 };
    const history = emptyReliabilityV2State();
    history.scopes[modelScopeKey(modelA)] = { generation: 3, failures: [1, 2, 3] };
    assert.equal(validateReliabilityV2State(history, historyConfig), true);
    assert.equal(validateReliabilityV2State(JSON.parse(JSON.stringify(history)), config), true);
    assert.equal(validateReliabilityV2State(history, { ...config, failureThreshold: 10_000 }), true);
    assert.equal(validateReliabilityV2State(history, { ...config, failureThreshold: 10_001 }), false);
  });

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

  it("preserves trial backoff and reopens after an aged-out half-open failure", () => {
    const oldClosed = admit(emptyReliabilityV2State(), "dispatch-old-closed", "outcome-old-closed", "owner-old", [modelA], 0);
    const trigger = admit(oldClosed.state, "dispatch-trigger", "outcome-trigger", "owner-trigger", [modelA], 0);
    const initialBlock = settle(trigger.state, "dispatch-trigger", "outcome-trigger", "owner-trigger", "failure", 1);
    assert.equal(scope(initialBlock.state).openUntil, 11);
    const trial = admit(initialBlock.state, "dispatch-trial-backoff", "outcome-trial-backoff", "owner-trial", [modelA], 11);
    const backedOff = settle(trial.state, "dispatch-trial-backoff", "outcome-trial-backoff", "owner-trial", "failure", 12);
    assert.equal(scope(backedOff.state).openUntil, 32);
    assert.equal(scope(backedOff.state).cooldownMultiplier, 2);

    const lateWhileBlocked = settle(backedOff.state, "dispatch-old-closed", "outcome-old-closed", "owner-old", "failure", 13);
    assert.equal(scope(lateWhileBlocked.state).openUntil, 32);
    assert.equal(scope(lateWhileBlocked.state).cooldownMultiplier, 2);

    const twoFailures = { ...config, failureThreshold: 2, windowMs: 5 };
    const first = admit(emptyReliabilityV2State(), "dispatch-aged-one", "outcome-aged-one", "owner-aged-one", [modelA], 0, twoFailures);
    const second = admit(first.state, "dispatch-aged-two", "outcome-aged-two", "owner-aged-two", [modelA], 0, twoFailures);
    const lateReceipt = admit(second.state, "dispatch-aged-late", "outcome-aged-late", "owner-aged-late", [modelA], 0, twoFailures);
    const oneFailure = settle(lateReceipt.state, "dispatch-aged-one", "outcome-aged-one", "owner-aged-one", "failure", 1, twoFailures);
    const opened = settle(oneFailure.state, "dispatch-aged-two", "outcome-aged-two", "owner-aged-two", "failure", 2, twoFailures);
    assert.equal(scope(opened.state).openUntil, 12);
    const recoveryTrial = admit(opened.state, "dispatch-aged-trial", "outcome-aged-trial", "owner-aged-trial", [modelA], 12, twoFailures);
    const trialFailure = settle(recoveryTrial.state, "dispatch-aged-trial", "outcome-aged-trial", "owner-aged-trial", "failure", 13, twoFailures);
    assert.equal(scope(trialFailure.state).openUntil, 33);
    assert.equal(scope(trialFailure.state).cooldownMultiplier, 2);
    const lateFailure = settle(trialFailure.state, "dispatch-aged-late", "outcome-aged-late", "owner-aged-late", "failure", 34, twoFailures);
    assert.equal(lateFailure.status, "settled");
    assert.equal(scope(lateFailure.state).openUntil, 44);
    assert.equal(scope(lateFailure.state).cooldownMultiplier, 2);
    assert.equal(scope(lateFailure.state).generation, scope(trialFailure.state).generation + 1);
    assert.equal(validateReliabilityV2State(lateFailure.state, twoFailures), true);
    assert.equal(validateReliabilityV2State(JSON.parse(JSON.stringify(lateFailure.state)), twoFailures), true);
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

  it("opens immediately for runtime allowance exhaustion, keeps generic 429 at threshold, and honors opt-out", () => {
    const policy = { ...config, failureThreshold: 3, cooldownMs: 60_000 };
    const admitted = admit(emptyReliabilityV2State(), "dispatch-allowance", "outcome-allowance", "owner-allowance", [modelA], 1, policy);
    const allowance = normalizeFailureObservation({
      outcomeId: "outcome-allowance", modelKey: modelA, source: "runtime", observedAt: 2,
      structured: { category: "allowance_exhausted", retryAt: 3 },
      errorText: "private usage-limit response",
    }, { now: 2 })!;
    const settled = settleReliabilityV2Dispatch(admitted.state, {
      ownerToken: "owner-allowance", dispatchId: "dispatch-allowance", outcomeId: "outcome-allowance",
      settlement: { kind: "failure", observation: allowance }, now: 3,
    }, policy);
    assert.equal(settled.status, "settled");
    assert.equal(scope(settled.state).openUntil, 60_003,
      "a short retry hint cannot shorten the configured minimum cooldown");
    assert.equal(settled.state.settledOutcomes["outcome-allowance"]?.observation?.category, "allowance_exhausted");
    assert.equal(JSON.stringify(settled.state).includes("private usage-limit response"), false);

    const rateLimitConfig = { ...policy, failureThreshold: 2 };
    const rateAdmitted = admit(emptyReliabilityV2State(), "dispatch-429", "outcome-429", "owner-429", [modelA], 1, rateLimitConfig);
    const rateLimit = normalizeFailureObservation({
      outcomeId: "outcome-429", modelKey: modelA, source: "runtime", observedAt: 2,
      structured: { httpStatus: 429 },
    }, { now: 2 })!;
    assert.equal(rateLimit.category, "rate_limit");
    const rateSettled = settleReliabilityV2Dispatch(rateAdmitted.state, {
      ownerToken: "owner-429", dispatchId: "dispatch-429", outcomeId: "outcome-429",
      settlement: { kind: "failure", observation: rateLimit }, now: 3,
    }, rateLimitConfig);
    assert.equal(scope(rateSettled.state).openUntil, undefined,
      "generic HTTP 429 remains subject to failureThreshold");

    const optOutConfig = { ...policy, cooldownOnAllowanceExhausted: false };
    const optedAdmitted = admit(emptyReliabilityV2State(), "dispatch-opt-out", "outcome-opt-out", "owner-opt-out", [modelA], 1, optOutConfig);
    const optedObservation = normalizeFailureObservation({
      outcomeId: "outcome-opt-out", modelKey: modelA, source: "runtime", observedAt: 2,
      structured: { category: "allowance_exhausted" },
    }, { now: 2 })!;
    const optedSettled = settleReliabilityV2Dispatch(optedAdmitted.state, {
      ownerToken: "owner-opt-out", dispatchId: "dispatch-opt-out", outcomeId: "outcome-opt-out",
      settlement: { kind: "failure", observation: optedObservation }, now: 3,
    }, optOutConfig);
    assert.equal(scope(optedSettled.state).openUntil, undefined);

    const probeConfig = { ...policy, failureThreshold: 2 };
    const probeAdmitted = admit(emptyReliabilityV2State(), "dispatch-probe", "outcome-probe", "owner-probe", [modelA], 1, probeConfig);
    const probeObservation = normalizeFailureObservation({
      outcomeId: "outcome-probe", modelKey: modelA, source: "probe", observedAt: 2,
      structured: { category: "allowance_exhausted" },
    }, { now: 2 })!;
    const probeSettled = settleReliabilityV2Dispatch(probeAdmitted.state, {
      ownerToken: "owner-probe", dispatchId: "dispatch-probe", outcomeId: "outcome-probe",
      settlement: { kind: "failure", observation: probeObservation }, now: 3,
    }, probeConfig);
    assert.equal(scope(probeSettled.state).openUntil, undefined,
      "non-runtime observations cannot promote quota-like probe errors into hard cooldowns");
  });

  it("consumes default-on allowance evidence without persisting optional observation summaries", () => {
    const policy = { ...config, failureThreshold: 3, cooldownMs: 60_000 };
    const admitted = admit(emptyReliabilityV2State(), "dispatch-enforce-only", "outcome-enforce-only", "owner-enforce-only", [modelA], 1, policy);
    const evidence = normalizeFailureObservation({
      outcomeId: "outcome-enforce-only", modelKey: modelA, source: "runtime", observedAt: 2,
      errorText: "The usage limit has been reached.",
    }, { now: 2 })!;
    assert.equal(evidence.category, "allowance_exhausted");
    const settled = settleReliabilityV2Dispatch(admitted.state, {
      ownerToken: "owner-enforce-only", dispatchId: "dispatch-enforce-only", outcomeId: "outcome-enforce-only",
      settlement: { kind: "failure", allowanceExhaustion: evidence }, now: 3,
    }, policy);
    assert.equal(settled.status, "settled");
    assert.equal(scope(settled.state).openUntil, 60_003);
    assert.equal(settled.state.settledOutcomes["outcome-enforce-only"]?.observation, undefined,
      "policy evidence is used for enforcement but is not stored when observation recording is off");
    assert.equal(JSON.stringify(settled.state).includes("usage limit"), false);

    const probeAdmitted = admit(emptyReliabilityV2State(), "dispatch-untrusted", "outcome-untrusted", "owner-untrusted", [modelA], 1, policy);
    const probeEvidence = normalizeFailureObservation({
      outcomeId: "outcome-untrusted", modelKey: modelA, source: "probe", observedAt: 2,
      structured: { category: "allowance_exhausted" },
    }, { now: 2 })!;
    const rejected = settleReliabilityV2Dispatch(probeAdmitted.state, {
      ownerToken: "owner-untrusted", dispatchId: "dispatch-untrusted", outcomeId: "outcome-untrusted",
      settlement: { kind: "failure", allowanceExhaustion: probeEvidence }, now: 3,
    }, policy);
    assert.equal(rejected.status, "invalid", "only a runtime-bound provider outcome may request hard allowance handling");
    assert.deepEqual(rejected.state, probeAdmitted.state);
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
