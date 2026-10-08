import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectBillingPreference } from "../economic-preferences.ts";
import {
  emptyEconomicSnapshot,
  publishEconomicObservation,
  type DispatchScope,
  type EconomicSignal,
  type ReservePolicy,
} from "../economic-signals.ts";

const now = 1_000;

function policy(overrides: Partial<ReservePolicy> = {}): ReservePolicy {
  return {
    mode: "policy",
    scopes: { selected: { kind: "provider", provider: "same-provider" } },
    sources: [{ id: "live", scopeRef: "selected", authority: "authoritative" }],
    admission: [{ id: "existing-reserve", scopeRef: "selected", windowId: "monthly", reserveRatio: 0.1, unknown: "block" }],
    ...overrides,
  };
}

function signal(overrides: Partial<EconomicSignal> = {}): EconomicSignal {
  return {
    sourceId: "live",
    scopeRef: "selected",
    billing: "subscription",
    observedAt: 900,
    expiresAt: 2_000,
    revision: 1,
    windows: [],
    ...overrides,
  };
}

function snapshot(p: ReservePolicy, ...observations: EconomicSignal[]) {
  let value = emptyEconomicSnapshot();
  for (const observation of observations) {
    const result = publishEconomicObservation(value, p, observation);
    assert.equal(result.accepted, true);
    value = result.snapshot;
  }
  return value;
}

function candidate(model: string, provider = "same-provider"): DispatchScope {
  return { model, provider };
}

describe("economic billing preference projection", () => {
  it("preserves exact order and membership when preference is absent", () => {
    const p = policy();
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b")];
    const result = projectBillingPreference({ candidates, snapshot: snapshot(p), policy: p, now });
    assert.deepEqual(result.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.deepEqual(result.eligibleModelKeys, candidates.map((entry) => entry.model));
    assert.equal(result.preferredCount, 0);
  });

  it("reports wouldPrefer in observe mode without changing the candidate sequence", () => {
    const p = policy({ mode: "observe" });
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b")];
    const facts = snapshot(p, signal());
    const result = projectBillingPreference({ candidates, preferredClass: "subscription", snapshot: facts, policy: p, now });
    assert.deepEqual(result.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.deepEqual(result.preferredModelKeys, candidates.map((entry) => entry.model));
    assert.equal(result.traces[0]?.effect, "would_prefer");
  });

  it("prefers only fresh preferred-class candidates and keeps their input order for downstream strategy", () => {
    const p = policy({
      scopes: {
        candidateA: { kind: "model", model: "same-provider/a" },
        candidateB: { kind: "model", model: "same-provider/b" },
        candidateC: { kind: "model", model: "same-provider/c" },
      },
      admission: [{ id: "existing-reserve", scopeRef: "candidateA", windowId: "monthly", reserveRatio: 0.1, unknown: "block" }],
      sources: [
        { id: "source-a", scopeRef: "candidateA", authority: "declared" },
        { id: "source-b", scopeRef: "candidateB", authority: "declared" },
        { id: "source-c", scopeRef: "candidateC", authority: "declared" },
      ],
      sourceOrder: { candidateA: ["source-a"], candidateB: ["source-b"], candidateC: ["source-c"] },
    });
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b"), candidate("same-provider/c")];
    const facts = snapshot(p,
      signal({ sourceId: "source-a", scopeRef: "candidateA", billing: "metered" }),
      signal({ sourceId: "source-b", scopeRef: "candidateB", billing: "subscription" }),
      signal({ sourceId: "source-c", scopeRef: "candidateC", billing: "subscription" }),
    );
    const result = projectBillingPreference({ candidates, preferredClass: "subscription", snapshot: facts, policy: p, now });
    assert.deepEqual(result.selectionModelKeys, ["same-provider/b", "same-provider/c"]);
    assert.deepEqual(result.preferredModelKeys, result.selectionModelKeys);
    assert.deepEqual(result.traces[0]?.sourceAliases, ["source-a"]);
    assert.deepEqual(result.traces[0]?.authorities, ["declared"]);
  });

  it("uses configured sourceOrder even when it deliberately selects lower-authority evidence", () => {
    const p = policy({
      sources: [
        { id: "declared", scopeRef: "selected", authority: "declared" },
        { id: "verified", scopeRef: "selected", authority: "authoritative" },
      ],
      sourceOrder: { selected: ["declared", "verified"] },
    });
    const facts = snapshot(p,
      signal({ sourceId: "declared", billing: "subscription" }),
      signal({ sourceId: "verified", billing: "metered" }),
    );
    const result = projectBillingPreference({
      candidates: [candidate("same-provider/a")], preferredClass: "subscription", snapshot: facts, policy: p, now,
    });
    assert.deepEqual(result.selectionModelKeys, ["same-provider/a"]);
    assert.deepEqual(result.traces[0]?.sourceAliases, ["declared"]);
    assert.deepEqual(result.traces[0]?.authorities, ["declared"]);
  });

  it("treats equal-authority conflict as neutral and keeps baseline strategy input", () => {
    const p = policy({ sources: [
      { id: "first", scopeRef: "selected", authority: "authoritative" },
      { id: "second", scopeRef: "selected", authority: "authoritative" },
    ] });
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b")];
    const facts = snapshot(p,
      signal({ sourceId: "first", billing: "subscription" }),
      signal({ sourceId: "second", billing: "metered" }),
    );
    const result = projectBillingPreference({ candidates, preferredClass: "subscription", snapshot: facts, policy: p, now });
    assert.deepEqual(result.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(result.traces[0]?.freshness, "conflict");
    assert.equal(result.traces[0]?.billingClass, "unknown");
  });

  it("keeps higher-authority unknown and source-order omissions neutral", () => {
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b")];
    const authorityPolicy = policy({ sources: [
      { id: "verified", scopeRef: "selected", authority: "authoritative" },
      { id: "declared", scopeRef: "selected", authority: "declared" },
    ] });
    const authorityFacts = snapshot(authorityPolicy,
      signal({ sourceId: "verified", billing: "unknown" }),
      signal({ sourceId: "declared", billing: "subscription" }),
    );
    const authorityResult = projectBillingPreference({
      candidates, preferredClass: "subscription", snapshot: authorityFacts, policy: authorityPolicy, now,
    });
    assert.deepEqual(authorityResult.selectionModelKeys, candidates.map((entry) => entry.model));

    const orderedPolicy = policy({
      sources: [
        { id: "configured", scopeRef: "selected", authority: "authoritative" },
        { id: "unlisted", scopeRef: "selected", authority: "authoritative" },
      ],
      sourceOrder: { selected: ["configured"] },
    });
    const orderedFacts = snapshot(orderedPolicy, signal({ sourceId: "unlisted", billing: "subscription" }));
    const orderedResult = projectBillingPreference({
      candidates, preferredClass: "subscription", snapshot: orderedFacts, policy: orderedPolicy, now,
    });
    assert.deepEqual(orderedResult.selectionModelKeys, candidates.map((entry) => entry.model));
  });

  it("does not choose an implicit model-over-provider winner when matching scopes disagree or are unresolved", () => {
    const p = policy({
      scopes: {
        selected: { kind: "provider", provider: "same-provider" },
        oneModel: { kind: "model", model: "same-provider/a" },
      },
      sources: [
        { id: "provider-fact", scopeRef: "selected", authority: "authoritative" },
        { id: "model-fact", scopeRef: "oneModel", authority: "authoritative" },
      ],
    });
    const candidates = [candidate("same-provider/a")];
    const facts = snapshot(p,
      signal({ sourceId: "provider-fact", scopeRef: "selected", billing: "metered" }),
      signal({ sourceId: "model-fact", scopeRef: "oneModel", billing: "subscription" }),
    );
    const disagreement = projectBillingPreference({ candidates, preferredClass: "subscription", snapshot: facts, policy: p, now });
    assert.deepEqual(disagreement.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(disagreement.traces[0]?.freshness, "conflict");

    const unresolved = projectBillingPreference({
      candidates,
      preferredClass: "subscription",
      snapshot: snapshot(p, signal({ sourceId: "provider-fact", scopeRef: "selected", billing: "subscription" })),
      policy: p,
      now,
    });
    assert.deepEqual(unresolved.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(unresolved.traces[0]?.freshness, "missing");
  });

  it("keeps billing class freshness independent from allowance reset time", () => {
    const p = policy();
    const facts = snapshot(p, signal({
      expiresAt: 2_000,
      windows: [{
        id: "monthly",
        period: { id: "period-1", sequence: 1 },
        unit: "requests",
        remaining: 0,
        limit: 100,
        resetsAt: 950,
      }],
    }));
    const result = projectBillingPreference({
      candidates: [candidate("same-provider/a")], preferredClass: "subscription", snapshot: facts, policy: p, now,
    });
    assert.deepEqual(result.selectionModelKeys, ["same-provider/a"]);
    assert.equal(result.traces[0]?.freshness, "fresh");
    assert.equal(result.traces[0]?.billingClass, "subscription");
  });

  it("treats an expired billing class as neutral even if the pool still has candidates", () => {
    const p = policy();
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b")];
    const result = projectBillingPreference({
      candidates,
      preferredClass: "subscription",
      snapshot: snapshot(p, signal({ expiresAt: now })),
      policy: p,
      now,
    });
    assert.deepEqual(result.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(result.traces[0]?.freshness, "stale");
    assert.deepEqual(result.traces[0]?.sourceAliases, ["live"]);
  });

  it("does not use account-scoped billing without an explicit host binding capability", () => {
    const p = policy({
      scopes: { selected: { kind: "account", provider: "same-provider", accountRef: "local-account", epoch: "credential-v1" } },
      sources: [{ id: "live", scopeRef: "selected", authority: "authoritative" }],
    });
    const result = projectBillingPreference({
      candidates: [candidate("same-provider/a")],
      preferredClass: "subscription",
      snapshot: snapshot(p, signal()),
      policy: p,
      now,
      hostCapabilities: { accountDispatch: false },
    });
    assert.deepEqual(result.selectionModelKeys, ["same-provider/a"]);
    assert.equal(result.traces[0]?.freshness, "unsupported_scope");
    assert.equal(JSON.stringify(result).includes("local-account"), false);
  });

  it("uses billing facts rather than provider naming or zero catalog prices", () => {
    const p = policy();
    const candidates = [candidate("same-provider/free-priced"), candidate("same-provider/subscription")];
    const result = projectBillingPreference({
      candidates,
      preferredClass: "subscription",
      snapshot: snapshot(p, signal({ billing: "metered" })),
      policy: p,
      now,
    });
    assert.deepEqual(result.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(result.traces.every((trace) => trace.billingClass === "metered"), true);
  });

  it("ranks only the supplied final eligible pool and preserves seeded selection over that ordered subset", () => {
    const p = policy({
      scopes: {
        eligibleA: { kind: "model", model: "same-provider/eligible-a" },
        eligibleB: { kind: "model", model: "same-provider/eligible-b" },
        eligibleC: { kind: "model", model: "same-provider/eligible-c" },
      },
      sources: [
        { id: "source-a", scopeRef: "eligibleA", authority: "authoritative" },
        { id: "source-b", scopeRef: "eligibleB", authority: "authoritative" },
        { id: "source-c", scopeRef: "eligibleC", authority: "authoritative" },
      ],
      sourceOrder: { eligibleA: ["source-a"], eligibleB: ["source-b"], eligibleC: ["source-c"] },
      admission: [{ id: "existing-reserve", scopeRef: "eligibleA", windowId: "monthly", reserveRatio: 0.1, unknown: "block" }],
    });
    const candidates = [
      candidate("same-provider/eligible-a"),
      candidate("same-provider/eligible-b"),
      candidate("same-provider/eligible-c"),
    ];
    const facts = snapshot(p,
      signal({ sourceId: "source-a", scopeRef: "eligibleA", billing: "subscription" }),
      signal({ sourceId: "source-b", scopeRef: "eligibleB", billing: "subscription" }),
      signal({ sourceId: "source-c", scopeRef: "eligibleC", billing: "metered" }),
    );
    const result = projectBillingPreference({ candidates, preferredClass: "subscription", snapshot: facts, policy: p, now });
    assert.deepEqual(result.selectionModelKeys, ["same-provider/eligible-a", "same-provider/eligible-b"]);
    let seed = 0x12345678;
    const nextRandom = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const selected = result.selectionModelKeys[Math.floor(nextRandom() * result.selectionModelKeys.length)];
    assert.equal(selected, "same-provider/eligible-a");

    // A reserve- or circuit-excluded candidate is absent before this projection and cannot be restored.
    assert.equal(result.eligibleModelKeys.includes("same-provider/excluded-metered"), false);
  });

  it("preserves source and selection outputs as frozen DTOs without balances or account references", () => {
    const p = policy();
    const result = projectBillingPreference({
      candidates: [candidate("same-provider/a")],
      preferredClass: "subscription",
      snapshot: snapshot(p, signal()),
      policy: p,
      now,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.selectionModelKeys), true);
    assert.equal(Object.isFrozen(result.traces[0]), true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("remaining"), false);
    assert.equal(serialized.includes("accountRef"), false);
  });

  it("does not echo malformed preference values or malformed model/provider identifiers", () => {
    const p = policy();
    const sentinel = "private-sentinel-value";
    const malformedPreference = projectBillingPreference({
      candidates: [candidate("same-provider/a")],
      preferredClass: sentinel as never,
      snapshot: snapshot(p),
      policy: p,
      now,
    });
    assert.equal(JSON.stringify(malformedPreference).includes(sentinel), false);
    assert.equal("preferredClass" in malformedPreference, false);

    const malformedModel = projectBillingPreference({
      candidates: [candidate(`same-provider/${sentinel} value`)],
      preferredClass: "subscription",
      snapshot: snapshot(p),
      policy: p,
      now,
    });
    assert.equal(JSON.stringify(malformedModel).includes(sentinel), false);
    assert.deepEqual(malformedModel.eligibleModelKeys, []);

    const malformedProvider = projectBillingPreference({
      candidates: [{ model: `${sentinel}/model`, provider: `${sentinel}/provider` }],
      preferredClass: "subscription",
      snapshot: snapshot(p),
      policy: p,
      now,
    });
    assert.equal(JSON.stringify(malformedProvider).includes(sentinel), false);
    assert.deepEqual(malformedProvider.eligibleModelKeys, []);
  });

  it("bounds the clock and leaves valid caller-owned inputs unfrozen", () => {
    const p = policy();
    const candidates = [candidate("same-provider/a"), candidate("same-provider/b")];
    const facts = snapshot(p, signal());
    const valid = projectBillingPreference({ candidates, snapshot: facts, policy: p, now });
    assert.deepEqual(valid.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(Object.isFrozen(candidates), false);
    assert.equal(Object.isFrozen(candidates[0]), false);
    assert.equal(Object.isFrozen(p), false);
    assert.equal(Object.isFrozen(facts), true);

    const invalidClock = projectBillingPreference({
      candidates,
      preferredClass: "subscription",
      snapshot: facts,
      policy: p,
      now: 8.64e15 + 1,
    });
    assert.deepEqual(invalidClock.selectionModelKeys, candidates.map((entry) => entry.model));
    assert.equal(invalidClock.traces[0]?.freshness, "invalid_context");
  });
});
