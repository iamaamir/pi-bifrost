import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyEconomicSnapshot,
  evaluateReserves,
  publishEconomicObservation,
  validateEconomicPolicy,
  validateEconomicSnapshot,
  type AllowanceWindow,
  type EconomicSignal,
  type ReservePolicy,
} from "../economic-signals.ts";

function policy(overrides: Partial<ReservePolicy> = {}): ReservePolicy {
  return {
    mode: "policy",
    scopes: { selected: { kind: "provider", provider: "fixture" } },
    sources: [{ id: "api", scopeRef: "selected", authority: "authoritative" }],
    admission: [{ id: "daily-reserve", scopeRef: "selected", windowId: "daily", reserveRatio: 0.2, unknown: "block" }],
    ...overrides,
  };
}

function window(overrides: Partial<AllowanceWindow> = {}): AllowanceWindow {
  return {
    id: "daily",
    period: { id: "2026-10-07", sequence: 7 },
    unit: "requests",
    remaining: 60,
    limit: 100,
    resetsAt: 10_000,
    ...overrides,
  };
}

function signal(overrides: Partial<EconomicSignal> = {}): EconomicSignal {
  return {
    sourceId: "api",
    scopeRef: "selected",
    billing: "subscription",
    observedAt: 100,
    expiresAt: 5_000,
    revision: 1,
    windows: [window()],
    ...overrides,
  };
}

function publish(snapshot: ReturnType<typeof emptyEconomicSnapshot>, p: ReservePolicy, observation: EconomicSignal) {
  return publishEconomicObservation(snapshot, p, observation);
}

function evaluate(p: ReservePolicy, snapshot: ReturnType<typeof emptyEconomicSnapshot>, now = 200) {
  return evaluateReserves({
    snapshot,
    policy: p,
    candidate: { model: "fixture/model", provider: "fixture" },
    requestedTier: "restricted",
    evaluatedTier: "restricted",
    hostCapabilities: { accountDispatch: false },
    now,
  });
}

describe("economic signal snapshots", () => {
  it("validates explicit source authority and alias-keyed source ordering", () => {
    const valid = policy({ sourceOrder: { selected: ["api"] } });
    assert.equal(validateEconomicPolicy(valid).valid, true);
    assert.equal(validateEconomicPolicy(policy({ sourceOrder: { selected: ["unknown"] } })).valid, false);
    assert.equal(validateEconomicPolicy(policy({ sources: [{ id: "api", scopeRef: "missing", authority: "authoritative" }] })).valid, false);

    const unsupportedAccount = policy({
      scopes: { selected: { kind: "account", provider: "fixture", accountRef: "acct", epoch: "one" } },
    });
    assert.ok(validateEconomicPolicy(unsupportedAccount).diagnostics.some((entry) => entry.code === "policy.unsupported_account_scope"));
    assert.equal(validateEconomicPolicy(unsupportedAccount, { accountDispatch: true }).valid, true);
  });

  it("rejects malformed observations without changing the prior snapshot", () => {
    const initial = emptyEconomicSnapshot();
    const bad = publish(initial, policy(), signal({ windows: [window({ unit: "currency", currency: "usd" })] }));
    assert.equal(bad.accepted, false);
    assert.equal(bad.code, "observation_invalid");
    assert.equal(bad.snapshot, initial);
    assert.ok(bad.diagnostics.some((entry) => entry.code === "observation.invalid_currency"));

    const unknown = publish(initial, policy(), signal({ sourceId: "unknown" }));
    assert.equal(unknown.accepted, false);
    assert.equal(unknown.snapshot, initial);
    assert.ok(unknown.diagnostics.some((entry) => entry.code === "observation.unknown_source"));
  });

  it("publishes immutable snapshots and treats equality with the reserve as rejection", () => {
    const result = publish(emptyEconomicSnapshot(), policy(), signal({ windows: [window({ remaining: 20 })] }));
    assert.equal(result.accepted, true);
    assert.equal(Object.isFrozen(result.snapshot), true);
    assert.equal(Object.isFrozen(result.snapshot.signals[0]?.windows[0]), true);
    const decision = evaluate(policy(), result.snapshot);
    assert.equal(decision.disposition, "rejected");
    assert.equal(decision.results[0]?.reason, "reserve_reached");
    assert.equal(decision.results[0]?.remainingRatio, 0.2);
  });

  it("rejects an observation atomically when any window regresses", () => {
    const p = policy({
      admission: [
        { id: "daily-rule", scopeRef: "selected", windowId: "daily", reserveRatio: 0.2, unknown: "block" },
        { id: "weekly-rule", scopeRef: "selected", windowId: "weekly", reserveRatio: 0.2, unknown: "block" },
      ],
    });
    const initial = publish(emptyEconomicSnapshot(), p, signal({ windows: [
      window(),
      window({ id: "weekly", period: { id: "week-1", sequence: 1 }, remaining: 80 }),
    ] }));
    assert.equal(initial.accepted, true);
    const candidate = signal({ revision: 2, observedAt: 101, expiresAt: 5_100, windows: [
      window({ period: { id: "2026-10-08", sequence: 8 }, remaining: 55 }),
      window({ id: "weekly", period: { id: "week-1", sequence: 0 }, remaining: 75 }),
    ] });
    const rejected = publish(initial.snapshot, p, candidate);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.code, "observation_stale");
    assert.equal(rejected.snapshot, initial.snapshot);
    assert.equal(rejected.snapshot.signals[0]?.windows[0]?.period.id, "2026-10-07");
  });

  it("rejects delayed periods and same-period stale or conflicting revisions", () => {
    const first = publish(emptyEconomicSnapshot(), policy(), signal());
    const delayed = publish(first.snapshot, policy(), signal({ revision: 2, windows: [window({ period: { id: "old", sequence: 6 } })] }));
    assert.equal(delayed.code, "observation_stale");
    assert.equal(delayed.snapshot, first.snapshot);

    const lowerRevision = publish(first.snapshot, policy(), signal({ revision: 0, windows: [window({ remaining: 50 })] }));
    assert.equal(lowerRevision.code, "observation_stale");
    const duplicate = publish(first.snapshot, policy(), signal());
    assert.equal(duplicate.code, "observation_duplicate");
    const conflict = publish(first.snapshot, policy(), signal({ windows: [window({ remaining: 99 })] }));
    assert.equal(conflict.code, "observation_revision_conflict");
    for (const rejected of [lowerRevision, duplicate, conflict]) assert.equal(rejected.snapshot, first.snapshot);
  });

  it("accepts a newer period while reset expiry makes the old fact unknown", () => {
    const first = publish(emptyEconomicSnapshot(), policy(), signal());
    assert.equal(evaluate(policy(), first.snapshot, 10_000).results[0]?.reason, "stale_fact");
    const next = publish(first.snapshot, policy(), signal({
      revision: 2,
      observedAt: 10_001,
      expiresAt: 20_000,
      windows: [window({ period: { id: "2026-10-08", sequence: 8 }, remaining: 100, resetsAt: 20_000 })],
    }));
    assert.equal(next.accepted, true);
    assert.equal(next.snapshot.signals[0]?.windows[0]?.remaining, 100);
  });

  it("expires each window independently when another window in its signal resets", () => {
    const p = policy({ admission: [{ id: "weekly-rule", scopeRef: "selected", windowId: "weekly", reserveRatio: 0.2, unknown: "block" }] });
    const observed = signal({ expiresAt: 20_000, windows: [
      window({ resetsAt: 500 }),
      window({ id: "weekly", period: { id: "week-1", sequence: 1 }, remaining: 80, resetsAt: 15_000 }),
    ] });
    const snapshot = publish(emptyEconomicSnapshot(), p, observed).snapshot;
    const result = evaluate(p, snapshot, 1_000);
    assert.equal(result.results[0]?.status, "pass");
    assert.equal(result.results[0]?.sourceId, "api");
  });

  it("requires all configured windows to pass and treats absolute values without a limit as unknown", () => {
    const p = policy({ admission: [
      { id: "daily-rule", scopeRef: "selected", windowId: "daily", reserveRatio: 0.2, unknown: "block" },
      { id: "weekly-rule", scopeRef: "selected", windowId: "weekly", reserveRatio: 0.2, unknown: "block" },
    ] });
    const snapshot = publish(emptyEconomicSnapshot(), p, signal({ windows: [
      window({ remaining: 90 }),
      window({ id: "weekly", period: { id: "week-1", sequence: 1 }, unit: "tokens", remaining: 50, limit: undefined }),
    ] })).snapshot;
    const decision = evaluate(p, snapshot);
    assert.equal(decision.disposition, "rejected");
    assert.equal(decision.results.find((result) => result.ruleId === "weekly-rule")?.reason, "invalid_fact");
  });

  it("distinguishes ignored unknowns, blocked unknowns, and observation-only would-reject results", () => {
    const ignored = policy({ admission: [{ id: "daily-reserve", scopeRef: "selected", windowId: "daily", reserveRatio: 0.2, unknown: "ignore" }] });
    const ignoredResult = evaluate(ignored, emptyEconomicSnapshot());
    assert.equal(ignoredResult.disposition, "unknown_ignored");
    assert.equal(ignoredResult.wouldReject, false);

    const blockedResult = evaluate(policy(), emptyEconomicSnapshot());
    assert.equal(blockedResult.disposition, "rejected");
    assert.equal(blockedResult.wouldReject, true);

    const observe = policy({ mode: "observe" });
    const observation = evaluate(observe, emptyEconomicSnapshot());
    assert.equal(observation.disposition, "observed");
    assert.equal(observation.wouldReject, true);
  });

  it("uses explicit source order or registered authority and reports equal-rank conflicts as unknown", () => {
    const twoSources = policy({
      sources: [
        { id: "api", scopeRef: "selected", authority: "authoritative" },
        { id: "local", scopeRef: "selected", authority: "declared" },
        { id: "other-api", scopeRef: "selected", authority: "authoritative" },
      ],
    });
    let snapshot = publish(emptyEconomicSnapshot(), twoSources, signal({ windows: [window({ remaining: 10 })] })).snapshot;
    snapshot = publish(snapshot, twoSources, signal({ sourceId: "local", windows: [window({ remaining: 80 })] })).snapshot;
    assert.equal(evaluate(twoSources, snapshot).results[0]?.sourceId, "api");

    snapshot = publish(snapshot, twoSources, signal({ sourceId: "other-api", windows: [window({ remaining: 70 })] })).snapshot;
    assert.equal(evaluate(twoSources, snapshot).results[0]?.reason, "source_conflict");
    const ordered = policy({ ...twoSources, sourceOrder: { selected: ["local", "api"] } });
    assert.equal(evaluate(ordered, snapshot).results[0]?.sourceId, "local");
  });

  it("combines requested and evaluated tier overrides without weakening the request", () => {
    const p = policy({
      tierOverrides: {
        restricted: { "daily-reserve": { reserveRatio: 0.5 } },
        cheap: { "daily-reserve": { reserveRatio: 0.1 } },
      },
    });
    const snapshot = publish(emptyEconomicSnapshot(), p, signal({ windows: [window({ remaining: 30 })] })).snapshot;
    const result = evaluateReserves({
      snapshot,
      policy: p,
      candidate: { model: "fixture/model", provider: "fixture" },
      requestedTier: "restricted",
      evaluatedTier: "cheap",
      hostCapabilities: { accountDispatch: false },
      now: 200,
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.results[0]?.remainingRatio, 0.3);
  });

  it("keeps account scope matching gated by explicit host capability and exact binding", () => {
    const p = policy({
      scopes: { selected: { kind: "account", provider: "fixture", accountRef: "workspace-a", epoch: "login-1" } },
    });
    const snapshot = publish(emptyEconomicSnapshot(), p, signal()).snapshot;
    const base = {
      snapshot, policy: p, requestedTier: "restricted", evaluatedTier: "restricted", now: 200,
    };
    const unsupported = evaluateReserves({ ...base, candidate: { model: "fixture/model", provider: "fixture" }, hostCapabilities: { accountDispatch: false } });
    assert.equal(unsupported.results[0]?.reason, "unsupported_scope");
    const mismatched = evaluateReserves({
      ...base,
      candidate: { model: "fixture/model", provider: "fixture", accountBinding: { accountRef: "workspace-b", epoch: "login-1" } },
      hostCapabilities: { accountDispatch: true },
    });
    assert.equal(mismatched.results.length, 0);
    const matched = evaluateReserves({
      ...base,
      candidate: { model: "fixture/model", provider: "fixture", accountBinding: { accountRef: "workspace-a", epoch: "login-1" } },
      hostCapabilities: { accountDispatch: true },
    });
    assert.equal(matched.results[0]?.status, "pass");
  });

  it("does not freeze or mutate caller-owned observations or existing snapshot facts", () => {
    const firstInput = signal();
    const first = publish(emptyEconomicSnapshot(), policy(), firstInput);
    assert.equal(Object.isFrozen(firstInput), false);
    assert.equal(Object.isFrozen(firstInput.windows), false);
    assert.equal(Object.isFrozen(firstInput.windows[0]), false);
    const secondInput = signal({ revision: 2, observedAt: 101, windows: [window({ remaining: 50 })] });
    const second = publish(first.snapshot, policy(), secondInput);
    assert.equal(second.accepted, true);
    assert.equal(Object.isFrozen(secondInput), false);
    assert.equal(Object.isFrozen(first.snapshot.signals[0]), true);
    assert.equal(Object.isFrozen(second.snapshot.signals[0]), true);
    assert.equal(first.snapshot.signals[0]?.windows[0]?.remaining, 60);
    assert.equal(second.snapshot.signals[0]?.windows[0]?.remaining, 50);

    const mutableSnapshot = JSON.parse(JSON.stringify(first.snapshot)) as ReturnType<typeof emptyEconomicSnapshot>;
    const updated = publish(mutableSnapshot, policy(), signal({ revision: 2, observedAt: 102, windows: [window({ remaining: 40 })] }));
    assert.equal(updated.accepted, true);
    assert.equal(Object.isFrozen(mutableSnapshot), false);
    assert.equal(Object.isFrozen(mutableSnapshot.signals[0]), false);
    assert.equal(Object.isFrozen(mutableSnapshot.watermarks[0]), false);
  });

  it("enforces signal revision and observation time even when a new snapshot omits all windows", () => {
    const first = publish(emptyEconomicSnapshot(), policy(), signal());
    const stale = publish(first.snapshot, policy(), signal({ revision: 0, observedAt: 99, windows: [] }));
    assert.equal(stale.accepted, false);
    assert.equal(stale.code, "observation_stale");
    assert.equal(stale.snapshot, first.snapshot);
    const emptyNewer = publish(first.snapshot, policy(), signal({ revision: 2, observedAt: 101, expiresAt: 6_000, windows: [] }));
    assert.equal(emptyNewer.accepted, true);
    const delayed = publish(emptyNewer.snapshot, policy(), signal({ revision: 1, observedAt: 100, windows: [] }));
    assert.equal(delayed.accepted, false);
    assert.equal(delayed.code, "observation_stale");
  });

  it("returns diagnostics instead of throwing for malformed policy, snapshot, and observation containers", () => {
    const malformedPolicies = [
      { ...policy(), sources: {} },
      { ...policy(), admission: {} },
      { ...policy(), tierOverrides: { restricted: null } },
      { ...policy(), sources: [null] },
    ] as unknown as ReservePolicy[];
    for (const malformed of malformedPolicies) {
      assert.doesNotThrow(() => validateEconomicPolicy(malformed));
      assert.equal(validateEconomicPolicy(malformed).valid, false);
      assert.doesNotThrow(() => publish(emptyEconomicSnapshot(), malformed, signal()));
      assert.equal(evaluate(malformed, emptyEconomicSnapshot()).wouldReject, true);
    }
    const malformedObservation = signal({ windows: [null] } as unknown as Partial<EconomicSignal>);
    assert.doesNotThrow(() => publish(emptyEconomicSnapshot(), policy(), malformedObservation));
    assert.equal(publish(emptyEconomicSnapshot(), policy(), malformedObservation).accepted, false);

    const malformedSnapshot = {
      revision: 1,
      signals: [null],
      watermarks: [null],
    } as unknown as ReturnType<typeof emptyEconomicSnapshot>;
    assert.doesNotThrow(() => validateEconomicSnapshot(malformedSnapshot, policy(), 100));
    assert.equal(validateEconomicSnapshot(malformedSnapshot, policy(), 100).valid, false);
    assert.equal(evaluate(policy(), malformedSnapshot).wouldReject, true);
  });

  it("returns controlled failures for malformed watermark and window details", () => {
    const validSignal = signal();
    const malformedSnapshots = [
      {
        revision: 1,
        signals: [signal({ windows: [{ id: "daily" } as unknown as AllowanceWindow] })],
        watermarks: [{ sourceId: "api", scopeRef: "selected", windowId: "daily", periodId: "2026-10-07", periodSequence: 7, revision: 1 }],
      },
      { revision: 1, signals: [validSignal], watermarks: {} },
      { revision: 1, signals: [validSignal], watermarks: [null] },
    ] as unknown as ReturnType<typeof emptyEconomicSnapshot>[];

    for (const malformed of malformedSnapshots) {
      assert.doesNotThrow(() => validateEconomicSnapshot(malformed, policy(), 200));
      assert.equal(validateEconomicSnapshot(malformed, policy(), 200).valid, false);
      assert.doesNotThrow(() => evaluate(policy(), malformed));
      assert.equal(evaluate(policy(), malformed).wouldReject, true);
      assert.doesNotThrow(() => publish(malformed, policy(), signal()));
      assert.equal(publish(malformed, policy(), signal()).accepted, false);
    }
  });

  it("drops malformed diagnostic identifiers instead of serializing private objects", () => {
    const secret = { apiKey: "PRIVATE_SENTINEL_DO_NOT_EMIT" };
    const malformedPolicy = policy({ sources: [{ id: secret, scopeRef: "selected", authority: "authoritative" } as unknown as ReservePolicy["sources"][number]] });
    const report = validateEconomicPolicy(malformedPolicy);
    assert.equal(report.valid, false);
    assert.equal(JSON.stringify(report).includes("PRIVATE_SENTINEL_DO_NOT_EMIT"), false);

    const malformed = publish(emptyEconomicSnapshot(), policy(), signal({ sourceId: secret as unknown as string }));
    assert.equal(malformed.accepted, false);
    assert.equal(JSON.stringify(malformed.diagnostics).includes("PRIVATE_SENTINEL_DO_NOT_EMIT"), false);
  });

  it("uses own-property lookups while allowing legal prototype-collision aliases", () => {
    const scopes = Object.fromEntries([
      ["constructor", { kind: "provider", provider: "fixture" }],
      ["__proto__", { kind: "provider", provider: "fixture" }],
    ]) as ReservePolicy["scopes"];
    const inheritedSourceOrder = Object.create({ constructor: ["local"] }) as ReservePolicy["sourceOrder"];
    const inheritedTierOverrides = Object.create({ restricted: { "daily-reserve": { reserveRatio: 0.9 } } }) as ReservePolicy["tierOverrides"];
    const p = policy({
      scopes,
      sources: [
        { id: "api", scopeRef: "constructor", authority: "authoritative" },
        { id: "local", scopeRef: "constructor", authority: "declared" },
      ],
      admission: [{ id: "daily-reserve", scopeRef: "constructor", windowId: "daily", reserveRatio: 0.2, unknown: "block" }],
      sourceOrder: inheritedSourceOrder,
      tierOverrides: inheritedTierOverrides,
    });
    assert.equal(validateEconomicPolicy(p).valid, true);
    let snapshot = publish(emptyEconomicSnapshot(), p, signal({ scopeRef: "constructor", windows: [window({ remaining: 30 })] })).snapshot;
    snapshot = publish(snapshot, p, signal({ sourceId: "local", scopeRef: "constructor", windows: [window({ remaining: 80 })] })).snapshot;
    const result = evaluate(p, snapshot);
    assert.equal(result.results[0]?.sourceId, "api", "inherited source order must not override authority");
    assert.equal(result.results[0]?.status, "pass", "inherited tier override must not raise the configured reserve");

    const protoAliasPolicy = policy({
      scopes: Object.fromEntries([["__proto__", { kind: "provider", provider: "fixture" }]]) as ReservePolicy["scopes"],
      sources: [{ id: "proto", scopeRef: "__proto__", authority: "authoritative" }],
      admission: [{ id: "proto-rule", scopeRef: "__proto__", windowId: "daily", reserveRatio: 0.2, unknown: "block" }],
    });
    assert.equal(validateEconomicPolicy(protoAliasPolicy).valid, true);
    const protoSnapshot = publish(emptyEconomicSnapshot(), protoAliasPolicy, signal({ sourceId: "proto", scopeRef: "__proto__" })).snapshot;
    assert.equal(evaluate(protoAliasPolicy, protoSnapshot).results[0]?.status, "pass");
  });

  it("ignores an account rule for another provider while evaluating matching model rules", () => {
    const p = policy({
      scopes: {
        otherAccount: { kind: "account", provider: "other-provider", accountRef: "workspace", epoch: "login" },
        selectedModel: { kind: "model", model: "fixture/model" },
      },
      sources: [{ id: "api", scopeRef: "selectedModel", authority: "authoritative" }],
      admission: [
        { id: "other-account-rule", scopeRef: "otherAccount", windowId: "daily", reserveRatio: 0.2, unknown: "block" },
        { id: "model-rule", scopeRef: "selectedModel", windowId: "daily", reserveRatio: 0.2, unknown: "block" },
      ],
    });
    const snapshot = publish(emptyEconomicSnapshot(), p, signal({ scopeRef: "selectedModel", windows: [window({ remaining: 80 })] })).snapshot;
    const result = evaluate(p, snapshot);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.ruleId, "model-rule");
    assert.equal(result.results[0]?.status, "pass");
  });

  it("sanitizes invalid-rule result identifiers and rejects malformed dispatch context safely", () => {
    const secret = { privateValue: "PRIVATE_RESULT_SENTINEL" };
    const malformedPolicy = policy({
      admission: [{ id: secret, scopeRef: secret, windowId: secret, reserveRatio: 4, unknown: "block" } as unknown as ReservePolicy["admission"][number]],
    });
    const invalid = evaluate(malformedPolicy, emptyEconomicSnapshot());
    assert.equal(invalid.disposition, "rejected");
    assert.equal(invalid.results[0]?.ruleId, "invalid");
    assert.equal(invalid.results[0]?.scopeRef, "invalid");
    assert.equal(invalid.results[0]?.windowId, "invalid");
    assert.equal(JSON.stringify(invalid).includes("PRIVATE_RESULT_SENTINEL"), false);

    const p = policy();
    const goodInput = {
      snapshot: emptyEconomicSnapshot(),
      policy: p,
      candidate: { model: "fixture/model", provider: "fixture" },
      requestedTier: "restricted",
      evaluatedTier: "restricted",
      hostCapabilities: { accountDispatch: false },
      now: 200,
    };
    for (const malformed of [
      { ...goodInput, candidate: null },
      { ...goodInput, hostCapabilities: null },
      { ...goodInput, candidate: { model: secret, provider: "fixture" } },
    ] as unknown as Parameters<typeof evaluateReserves>[0][]) {
      assert.doesNotThrow(() => evaluateReserves(malformed));
      const result = evaluateReserves(malformed);
      assert.equal(result.disposition, "rejected");
      assert.equal(result.wouldReject, true);
      assert.equal(JSON.stringify(result).includes("PRIVATE_RESULT_SENTINEL"), false);
    }
  });

  it("requires canonical model scopes and provider-consistent dispatch identities", () => {
    const malformedScope = policy({ scopes: { selected: { kind: "model", model: "unqualified-model" } } });
    const validation = validateEconomicPolicy(malformedScope);
    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.some((entry) => entry.code === "scope.invalid"));
    const scopeResult = evaluate(malformedScope, emptyEconomicSnapshot());
    assert.equal(scopeResult.disposition, "rejected");
    assert.equal(scopeResult.results[0]?.reason, "scope.invalid");

    const good = {
      snapshot: emptyEconomicSnapshot(),
      policy: policy(),
      requestedTier: "restricted",
      evaluatedTier: "restricted",
      hostCapabilities: { accountDispatch: false },
      now: 200,
    };
    const mismatchedProvider = evaluateReserves({ ...good, candidate: { model: "other-provider/model", provider: "fixture" } });
    assert.equal(mismatchedProvider.disposition, "rejected");
    assert.equal(mismatchedProvider.results[0]?.reason, "context.invalid");
    const unqualifiedCandidate = evaluateReserves({ ...good, candidate: { model: "model-without-provider", provider: "fixture" } });
    assert.equal(unqualifiedCandidate.results[0]?.reason, "context.invalid");

    const unrealisticTime = publish(emptyEconomicSnapshot(), policy(), signal({
      observedAt: Number.MAX_SAFE_INTEGER - 10,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }));
    assert.equal(unrealisticTime.accepted, false);
    assert.ok(unrealisticTime.diagnostics.some((entry) => entry.code === "observation.invalid_freshness"));
  });
});
