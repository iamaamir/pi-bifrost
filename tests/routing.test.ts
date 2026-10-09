import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteDecisionSummary,
  type ClassificationResult,
} from "../classification-pipeline.ts";
import {
  buildTierResolutionOptions,
  resolveConfiguredTier,
  findOneModel,
  findCandidates,
  selectModel,
  resolveModel,
  resolveHealthyModel,
  resolveModelWithFallback,
  modelKey,
  modelCost,
  getStrategy,
  classify,
  classifyCompiled,
  compileRules,
} from "../routing.ts";
import { emptyReliabilityState, recordModelFailure, DEFAULT_RELIABILITY } from "../reliability.ts";
import { makeCtx, makeModel, withoutCost } from "./helpers.ts";
import { emptyEconomicSnapshot, hasHardEconomicAdmission, publishEconomicObservation, type EconomicSignal, type ReservePolicy } from "../economic-signals.ts";

describe("routing", () => {
  describe("affinity observation", () => {
    it("keeps the configured winner when the final eligible pool exceeds the advisory limit", () => {
      const models = Array.from({ length: 514 }, (_, index) => makeModel("fixture", `model-${index}`));
      const ctx = makeCtx(models);
      const now = 1_000;
      const reliabilityConfig = { ...DEFAULT_RELIABILITY, failureThreshold: 1, cooldownMinutes: 10 };
      const reliability = recordModelFailure(
        emptyReliabilityState(), "fixture/model-513", reliabilityConfig, now, "dispatch", "transport",
      );
      const patterns = models.map(modelKey);
      let randomCalls = 0;

      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: patterns },
        strategy: "random",
        affinity: { mode: "retain-within-tier" },
      }, reliability, reliabilityConfig, now, undefined, () => { randomCalls += 1; return 0.75; }, {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/model-513", provider: "fixture", lastSuccessfulDispatchAt: now - 100 },
      }).resolution;

      assert.equal(modelKey(result.selected), "fixture/model-384");
      assert.equal(randomCalls, 1);
      assert.equal(result.primary.selectionCandidates?.length, 513);
      assert.equal(result.primary.skipped.some((candidate) => candidate.key === "fixture/model-513" && candidate.reason === "open_circuit"), true);
      assert.equal(result.affinityObservation?.status, "not_applicable");
      assert.equal(result.affinityObservation?.selection, "not_applicable");
    });

    it("keeps the configured winner when an affinity anchor is newer than the route snapshot", () => {
      const ctx = makeCtx([makeModel("fixture", "strategy"), makeModel("fixture", "anchor")]);
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/strategy", "fixture/anchor"] },
        strategy: "first",
        affinity: { mode: "retain-within-tier" },
      }, undefined, undefined, 1_000, undefined, undefined, {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/anchor", provider: "fixture", lastSuccessfulDispatchAt: 1_001 },
      }).resolution;

      assert.equal(modelKey(result.selected), "fixture/strategy");
      assert.equal(result.affinityObservation?.status, "not_applicable");
      assert.equal(result.affinityObservation?.selection, "not_applicable");
    });

    it("compares the unchanged random winner against the final eligible pool without another RNG call", () => {
      const ctx = makeCtx([makeModel("fixture", "anchor"), makeModel("fixture", "other")]);
      let randomCalls = 0;
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/anchor", "fixture/other"] },
        strategy: "random",
        affinity: { mode: "observe", providerAdvisory: true },
      }, undefined, undefined, 250, undefined, () => { randomCalls += 1; return 0.75; }, {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/anchor", provider: "fixture", lastSuccessfulDispatchAt: 100 },
      }).resolution;
      assert.equal(modelKey(result.selected), "fixture/other");
      assert.deepEqual(result.primary.healthyCandidates.map(modelKey), ["fixture/anchor", "fixture/other"]);
      assert.equal(randomCalls, 1);
      assert.deepEqual(result.affinityObservation, {
        version: 1,
        status: "current_eligible",
        snapshotAsOf: 250,
        anchor: { modelKey: "fixture/anchor", provider: "fixture", lastSuccessfulDispatchAt: 100, ageMs: 150 },
        baseStrategyWinner: "fixture/other",
        baseStrategyComparison: "selected_other",
        sameProviderCandidateAvailable: true,
        mode: "observe",
        selection: "strategy",
        strategyWinner: "fixture/other",
        selectedModel: "fixture/other",
        selectedTier: "general",
      });
    });

    it("retains an automatic anchor only inside the selected tier's final strategy pool", () => {
      const ctx = makeCtx([makeModel("fixture", "anchor"), makeModel("fixture", "strategy")]);
      let randomCalls = 0;
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/anchor", "fixture/strategy"] },
        strategy: "random",
        affinity: { mode: "retain-within-tier" as never },
      }, undefined, undefined, 250, undefined, () => { randomCalls += 1; return 0.75; }, {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/anchor", provider: "fixture", lastSuccessfulDispatchAt: 100 },
      }).resolution;
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture/anchor", "fixture/strategy"]);
      assert.equal(modelKey(result.selected), "fixture/anchor");
      assert.equal(randomCalls, 1);
      assert.deepEqual(result.affinityObservation, {
        version: 1,
        status: "current_eligible",
        snapshotAsOf: 250,
        anchor: { modelKey: "fixture/anchor", provider: "fixture", lastSuccessfulDispatchAt: 100, ageMs: 150 },
        baseStrategyWinner: "fixture/strategy",
        baseStrategyComparison: "selected_other",
        mode: "retain-within-tier",
        selection: "retained_anchor",
        strategyWinner: "fixture/strategy",
        selectedModel: "fixture/anchor",
        selectedTier: "general",
      });
    });

    it("reports locality unknown without manufacturing an anchor and honors intrinsic explicit origins", () => {
      const ctx = makeCtx([makeModel("fixture", "anchor")]);
      const options = {
        models: { general: ["fixture/anchor"] },
        strategy: "first" as const,
        affinity: { mode: "observe" as const },
      };
      const unknown = resolveConfiguredTier(ctx, "general", options, undefined, undefined, 250, undefined, undefined, {
        targetOrigin: "automatic",
      }).resolution;
      assert.deepEqual(unknown.affinityObservation, {
        version: 1, status: "locality_unknown", snapshotAsOf: 250, baseStrategyComparison: "no_anchor",
        mode: "observe", selection: "no_anchor", strategyWinner: "fixture/anchor", selectedModel: "fixture/anchor", selectedTier: "general",
      });
      const explicit = resolveConfiguredTier(ctx, "general", options, undefined, undefined, 250, undefined, undefined, {
        targetOrigin: "automatic",
        intrinsicOrigin: "explicit_tier",
      }).resolution;
      assert.deepEqual(explicit.affinityObservation, {
        version: 1, status: "not_applicable", snapshotAsOf: 250, mode: "observe", selection: "not_applicable",
        strategyWinner: "fixture/anchor", selectedModel: "fixture/anchor", selectedTier: "general",
      });
    });

    it("does not restore an anchor excluded by preferred-class selection or explicit intent", () => {
      const now = 250;
      const ctx = makeCtx([makeModel("fixture", "metered"), makeModel("fixture", "subscription")]);
      const policy: ReservePolicy = {
        mode: "policy",
        scopes: {
          metered: { kind: "model", model: "fixture/metered" },
          subscription: { kind: "model", model: "fixture/subscription" },
        },
        sources: [
          { id: "metered-fact", scopeRef: "metered", authority: "declared" },
          { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
        ],
        sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"] },
        admission: [],
        preference: { billingClass: "subscription" },
      };
      let facts = emptyEconomicSnapshot();
      for (const fact of [
        { sourceId: "metered-fact", scopeRef: "metered", billing: "metered" },
        { sourceId: "subscription-fact", scopeRef: "subscription", billing: "subscription" },
      ]) {
        const published = publishEconomicObservation(facts, policy, {
          ...fact, observedAt: 100, expiresAt: 2_000, revision: 1, windows: [],
        } as EconomicSignal);
        assert.equal(published.accepted, true);
        facts = published.snapshot;
      }
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/metered", "fixture/subscription"] },
        strategy: "first",
        affinity: { mode: "retain-within-tier" },
      }, undefined, undefined, now, { policy, snapshot: facts }, undefined, {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/metered", provider: "fixture", lastSuccessfulDispatchAt: 100 },
      }).resolution;
      assert.equal(modelKey(result.selected), "fixture/subscription");
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture/subscription"]);
      assert.equal(result.affinityObservation?.selection, "anchor_not_eligible");

      const explicit = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/metered", "fixture/subscription"] },
        strategy: "first",
        affinity: { mode: "retain-within-tier" },
      }, undefined, undefined, now, undefined, undefined, {
        targetOrigin: "automatic",
        intrinsicOrigin: "direct",
        anchor: { modelKey: "fixture/subscription", provider: "fixture", lastSuccessfulDispatchAt: 100 },
      }).resolution;
      assert.equal(modelKey(explicit.selected), "fixture/metered");
      assert.equal(explicit.affinityObservation?.selection, "not_applicable");
    });

    it("omits affinity observation when mode is off or absent", () => {
      const ctx = makeCtx([makeModel("fixture", "anchor")]);
      for (const affinity of [undefined, { mode: "off" as const }, { mode: "observe" as const }]) {
        const result = resolveConfiguredTier(ctx, "general", {
          models: { general: ["fixture/anchor"] }, strategy: "first", ...(affinity ? { affinity } : {}),
        }, undefined, undefined, 250, undefined, undefined, affinity?.mode === "observe" ? undefined : { targetOrigin: "automatic" }).resolution;
        assert.equal(result.affinityObservation, undefined);
      }
    });
  });

  describe("economic reserve filtering", () => {
    const now = 1_000;
    const policy = (mode: ReservePolicy["mode"]): ReservePolicy => ({
      mode,
      scopes: { reserved: { kind: "model", model: "fixture/a" } },
      sources: [{ id: "manual", scopeRef: "reserved", authority: "declared" }],
      admission: [{ id: "daily", scopeRef: "reserved", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
    });
    const observation: EconomicSignal = {
      sourceId: "manual", scopeRef: "reserved", billing: "metered", observedAt: 100, expiresAt: 2_000, revision: 1,
      windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.1 }],
    };

    it("filters reserved models before selection in requested and legacy default pools", () => {
      const ctx = makeCtx([makeModel("fixture", "a"), makeModel("fixture", "b")]);
      const reservePolicy = policy("policy");
      const snapshot = publishEconomicObservation(emptyEconomicSnapshot(), reservePolicy, observation).snapshot;
      const result = resolveConfiguredTier(ctx, "restricted", {
        default: "general", models: { restricted: ["fixture/a"], general: ["fixture/a", "fixture/b"] }, strategy: "first",
      }, undefined, undefined, now, { policy: reservePolicy, snapshot }).resolution;
      assert.equal(result.selected && modelKey(result.selected), "fixture/b");
      assert.equal(result.selectedTier, "general");
      assert.equal(result.primary.economic?.[0]?.evaluation.disposition, "rejected");
      assert.equal(result.fallback?.healthyCandidates.map(modelKey).join(","), "fixture/b");
    });

    it("filters every tier in an explicit ordered fallback chain before strategy", () => {
      const ctx = makeCtx([makeModel("fixture", "a"), makeModel("fixture", "b")]);
      const reservePolicy = policy("policy");
      const snapshot = publishEconomicObservation(emptyEconomicSnapshot(), reservePolicy, observation).snapshot;
      const result = resolveConfiguredTier(ctx, "restricted", {
        schemaVersion: 2,
        default: "unvisited",
        models: { restricted: ["fixture/a"], backup: ["fixture/a", "fixture/b"], unvisited: ["fixture/a"] },
        tierPolicies: { restricted: { fallbackTiers: ["backup"] } },
        strategy: "first",
      }, undefined, undefined, now, { policy: reservePolicy, snapshot }).resolution;
      assert.equal(result.selected && modelKey(result.selected), "fixture/b");
      assert.deepEqual(result.attemptedTiers?.map(({ tier }) => tier), ["restricted", "backup"]);
      assert.equal(result.explicitBoundary, true);
    });

    it("reports a reserve-excluded legacy default pool as excluded, not unavailable", () => {
      const ctx = makeCtx([makeModel("fixture", "a")]);
      const reservePolicy = policy("policy");
      const snapshot = publishEconomicObservation(emptyEconomicSnapshot(), reservePolicy, observation).snapshot;
      const result = resolveConfiguredTier(ctx, "restricted", {
        default: "general",
        models: { restricted: [], general: ["fixture/a"] },
        strategy: "first",
      }, undefined, undefined, now, { policy: reservePolicy, snapshot }).resolution;
      assert.equal(result.selected, undefined);
      assert.equal(result.fallback?.economic?.[0]?.evaluation.disposition, "rejected");
      assert.equal(result.fallbackReason, "requested_tier_excluded");
    });

    it("does not report all-excluded explicit pools as unavailable", () => {
      const ctx = makeCtx([makeModel("fixture", "a")]);
      const reservePolicy = policy("policy");
      const snapshot = publishEconomicObservation(emptyEconomicSnapshot(), reservePolicy, observation).snapshot;
      const result = resolveConfiguredTier(ctx, "restricted", {
        schemaVersion: 2,
        models: { restricted: ["fixture/a"], backup: ["fixture/a"] },
        tierPolicies: { restricted: { fallbackTiers: ["backup"] } },
        strategy: "first",
      }, undefined, undefined, now, { policy: reservePolicy, snapshot }).resolution;
      assert.equal(result.selected, undefined);
      assert.equal(result.fallbackReason, "requested_tier_excluded");
    });

    it("reports reliability blockers when reserve rejection also removed a candidate", () => {
      const ctx = makeCtx([makeModel("fixture", "a"), makeModel("fixture", "b")]);
      const reservePolicy = policy("policy");
      const snapshot = publishEconomicObservation(emptyEconomicSnapshot(), reservePolicy, observation).snapshot;
      const reliabilityConfig = { ...DEFAULT_RELIABILITY, failureThreshold: 1, cooldownMinutes: 10 };
      const reliability = recordModelFailure(
        emptyReliabilityState(), "fixture/b", reliabilityConfig, now, "dispatch", "timeout",
      );
      const result = resolveConfiguredTier(ctx, "restricted", {
        models: { restricted: ["fixture/a", "fixture/b"] }, strategy: "first",
      }, reliability, reliabilityConfig, now, { policy: reservePolicy, snapshot }).resolution;

      assert.equal(result.selected, undefined);
      assert.equal(result.primary.economic?.[0]?.evaluation.disposition, "rejected");
      assert.deepEqual(result.primary.skipped.map(({ key, reason }) => ({ key, reason })), [
        { key: "fixture/b", reason: "open_circuit" },
      ]);
      assert.equal(result.fallbackReason, "requested_tier_unhealthy");
    });

    it("observe mode records would-reject evidence without changing candidates or random calls", () => {
      const ctx = makeCtx([makeModel("fixture", "a"), makeModel("fixture", "b")]);
      const reservePolicy = policy("observe");
      const snapshot = publishEconomicObservation(emptyEconomicSnapshot(), reservePolicy, observation).snapshot;
      let randomCalls = 0;
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/a", "fixture/b"] }, strategy: "random",
      }, undefined, undefined, now, { policy: reservePolicy, snapshot }, () => { randomCalls += 1; return 0; }).resolution;
      assert.equal(result.selected && modelKey(result.selected), "fixture/a");
      assert.equal(result.primary.economic?.[0]?.evaluation.wouldReject, true);
      assert.equal(result.primary.healthyCandidates.length, 2);
      assert.equal(randomCalls, 1);
      const summary = buildRouteDecisionSummary({ kind: "classified", tier: "general", source: "regex" }, {
        resolution: result,
        options: buildTierResolutionOptions("general", { models: { general: ["fixture/a", "fixture/b"] }, strategy: "random" }),
      });
      assert.deepEqual(summary.requested?.candidates[0]?.reserve, {
        disposition: "observed", wouldReject: true, reasons: ["reserve_reached"],
      });
    });
  });

  describe("billing preference routing", () => {
    const now = 1_000;
    const basePolicy = (mode: ReservePolicy["mode"], admission: ReservePolicy["admission"] = []): ReservePolicy => ({
      mode,
      scopes: {
        metered: { kind: "model", model: "fixture/metered" },
        subscription: { kind: "model", model: "fixture/subscription" },
      },
      sources: [
        { id: "metered-fact", scopeRef: "metered", authority: "declared" },
        { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
      ],
      admission,
      preference: { billingClass: "subscription" },
      sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"] },
    });
    const publish = (policy: ReservePolicy, billing: { metered?: string; subscription?: string } = {}) => {
      let snapshot = emptyEconomicSnapshot();
      for (const observation of [
        { sourceId: "metered-fact", scopeRef: "metered", billing: billing.metered ?? "metered" },
        { sourceId: "subscription-fact", scopeRef: "subscription", billing: billing.subscription ?? "subscription" },
      ]) {
        const result = publishEconomicObservation(snapshot, policy, {
          ...observation,
          observedAt: 100,
          expiresAt: 2_000,
          revision: 1,
          windows: [],
        } as EconomicSignal);
        assert.equal(result.accepted, true);
        snapshot = result.snapshot;
      }
      return snapshot;
    };
    const routingConfig = (overrides: Partial<Parameters<typeof resolveConfiguredTier>[2]> = {}) => ({
      models: { general: ["fixture/metered", "fixture/subscription"] },
      strategy: "cheapest" as const,
      ...overrides,
    });

    it("prefers a declared class within the chosen tier, then applies the existing strategy to that pool", () => {
      const ctx = makeCtx([
        makeModel("fixture", "metered", 0.01, 0.01),
        makeModel("fixture", "subscription", 0.9, 0.9),
      ]);
      const policy = basePolicy("policy");
      const result = resolveConfiguredTier(ctx, "general", routingConfig(), undefined, undefined, now, {
        policy,
        snapshot: publish(policy),
      }).resolution;
      assert.equal(modelKey(result.selected), "fixture/subscription");
      assert.deepEqual(result.primary.healthyCandidates.map(modelKey), ["fixture/metered", "fixture/subscription"]);
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture/subscription"]);
      assert.equal(result.primary.billingPreference?.preferredCount, 1);
      assert.equal(result.primary.billingPreference?.eligibleCount, 2);
      assert.equal(result.primary.economic, undefined);
      assert.equal(hasHardEconomicAdmission(policy), false);
      const summary = buildRouteDecisionSummary({ kind: "classified", tier: "general", source: "regex" }, {
        resolution: result,
        options: buildTierResolutionOptions("general", routingConfig()),
      });
      assert.deepEqual(summary.requested?.billingPreference, {
        mode: "policy",
        preferredClass: "subscription",
        eligibleCount: 2,
        preferredCount: 1,
        selectionCount: 1,
        candidates: [
          { model: "fixture/metered", billingClass: "metered", sourceAliases: ["metered-fact"], authorities: ["declared"], freshness: "fresh", effect: "baseline" },
          { model: "fixture/subscription", billingClass: "subscription", sourceAliases: ["subscription-fact"], authorities: ["declared"], freshness: "fresh", effect: "preferred" },
        ],
      });
      assert.equal(JSON.stringify(summary).includes("remaining"), false);
    });

    it("keeps observe mode order and random calls unchanged while reporting wouldPrefer", () => {
      const ctx = makeCtx([
        makeModel("fixture", "metered", 0.01, 0.01),
        makeModel("fixture", "subscription", 0.9, 0.9),
      ]);
      const policy = basePolicy("observe");
      let randomCalls = 0;
      const result = resolveConfiguredTier(ctx, "general", { ...routingConfig(), strategy: "random" }, undefined, undefined, now, {
        policy,
        snapshot: publish(policy),
      }, () => { randomCalls += 1; return 0; }).resolution;
      assert.equal(modelKey(result.selected), "fixture/metered");
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture/metered", "fixture/subscription"]);
      assert.equal(result.primary.billingPreference?.mode, "observe");
      assert.equal(result.primary.billingPreference?.preferredCount, 1);
      assert.equal(result.primary.billingPreference?.selectionCount, 2);
      assert.equal(randomCalls, 1);
    });

    it("runs the seeded random strategy only inside the preferred eligible subset", () => {
      const ctx = makeCtx([
        makeModel("fixture", "metered", 0.01, 0.01),
        makeModel("fixture", "subscription", 0.9, 0.9),
        makeModel("fixture", "subscription-2", 0.8, 0.8),
      ]);
      const policy: ReservePolicy = {
        mode: "policy",
        scopes: {
          metered: { kind: "model", model: "fixture/metered" },
          subscription: { kind: "model", model: "fixture/subscription" },
          subscription2: { kind: "model", model: "fixture/subscription-2" },
        },
        sources: [
          { id: "metered-fact", scopeRef: "metered", authority: "declared" },
          { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
          { id: "subscription2-fact", scopeRef: "subscription2", authority: "declared" },
        ],
        admission: [],
        preference: { billingClass: "subscription" },
        sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"], subscription2: ["subscription2-fact"] },
      };
      let snapshot = emptyEconomicSnapshot();
      for (const fact of [
        { sourceId: "metered-fact", scopeRef: "metered", billing: "metered" },
        { sourceId: "subscription-fact", scopeRef: "subscription", billing: "subscription" },
        { sourceId: "subscription2-fact", scopeRef: "subscription2", billing: "subscription" },
      ]) {
        const result = publishEconomicObservation(snapshot, policy, { ...fact, observedAt: 100, expiresAt: 2_000, revision: 1, windows: [] } as EconomicSignal);
        assert.equal(result.accepted, true);
        snapshot = result.snapshot;
      }
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/metered", "fixture/subscription", "fixture/subscription-2"] },
        strategy: "random",
      }, undefined, undefined, now, { policy, snapshot }, () => 0.75).resolution;
      assert.equal(modelKey(result.selected), "fixture/subscription-2");
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture/subscription", "fixture/subscription-2"]);
    });

    it("uses the full baseline pool when no preferred class is fresh and does not turn an empty tier into a route", () => {
      const ctx = makeCtx([makeModel("fixture", "metered", 0.01, 0.01), makeModel("fixture", "subscription", 0.9, 0.9)]);
      const policy = basePolicy("policy");
      const result = resolveConfiguredTier(ctx, "general", routingConfig(), undefined, undefined, now, {
        policy,
        snapshot: emptyEconomicSnapshot(),
      }).resolution;
      assert.equal(modelKey(result.selected), "fixture/metered");
      assert.equal(result.primary.billingPreference?.preferredCount, 0);
      assert.equal(result.primary.selectionCandidates?.length, 2);
      assert.equal(result.fallbackReason, undefined);

      const noRoute = resolveConfiguredTier(ctx, "missing", {
        default: undefined,
        models: { missing: ["fixture/not-available"] },
        strategy: "first",
      }, undefined, undefined, now, { policy, snapshot: emptyEconomicSnapshot() }).resolution;
      assert.equal(noRoute.selected, undefined);
      assert.equal(noRoute.fallbackReason, "requested_tier_unavailable");
    });

    it("keeps malformed registry identities eligible when preference evidence is invalid", () => {
      const invalidKey = makeModel("fixture provider", "subscription");
      const baseline = makeModel("fixture", "metered");
      const ctx = makeCtx([invalidKey, baseline]);
      const policy = basePolicy("policy");
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture provider/subscription", "fixture/metered"] }, strategy: "first",
      }, undefined, undefined, now, { policy, snapshot: publish(policy) }).resolution;
      assert.equal(modelKey(result.selected), "fixture provider/subscription");
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture provider/subscription", "fixture/metered"]);
      assert.equal(result.primary.billingPreference?.preferredCount, 0);
    });

    it("explicitly bypasses soft preference for direct model and utility dispatch contexts", () => {
      const ctx = makeCtx([
        makeModel("fixture", "metered", 0.01, 0.01),
        makeModel("fixture", "subscription", 0.9, 0.9),
      ]);
      const policy = basePolicy("policy");
      const result = resolveConfiguredTier(ctx, "general", routingConfig(), undefined, undefined, now, {
        policy,
        snapshot: publish(policy),
        preferenceBypassed: true,
      }).resolution;
      assert.equal(modelKey(result.selected), "fixture/metered");
      assert.equal(result.primary.billingPreference, undefined);
    });

    it("does not cross a strict tier boundary to find a preferred class", () => {
      const ctx = makeCtx([
        makeModel("fixture", "metered", 0.01, 0.01),
        makeModel("fixture", "subscription", 0.9, 0.9),
      ]);
      const policy = basePolicy("policy");
      const result = resolveConfiguredTier(ctx, "quick", {
        schemaVersion: 2,
        models: { quick: ["fixture/metered"], general: ["fixture/subscription"] },
        tierPolicies: { quick: { fallbackTiers: [] } },
        default: "general",
        strategy: "first",
      }, undefined, undefined, now, { policy, snapshot: publish(policy) }).resolution;
      assert.equal(modelKey(result.selected), "fixture/metered");
      assert.equal(result.selectedTier, "quick");
      assert.equal(result.primary.billingPreference?.preferredCount, 0);
      assert.equal(result.fallback, undefined);
    });

    it("does not restore reserve- or circuit-excluded preferred models", () => {
      const ctx = makeCtx([
        makeModel("fixture", "metered", 0.2, 0.2),
        makeModel("fixture", "subscription-reserved", 0.3, 0.3),
        makeModel("fixture", "subscription-open", 0.4, 0.4),
      ]);
      const policy: ReservePolicy = {
        mode: "policy",
        scopes: {
          reserved: { kind: "model", model: "fixture/subscription-reserved" },
          open: { kind: "model", model: "fixture/subscription-open" },
          metered: { kind: "model", model: "fixture/metered" },
        },
        sources: [
          { id: "reserved-fact", scopeRef: "reserved", authority: "declared" },
          { id: "open-fact", scopeRef: "open", authority: "declared" },
          { id: "metered-fact", scopeRef: "metered", authority: "declared" },
        ],
        admission: [{ id: "reserve", scopeRef: "reserved", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
        preference: { billingClass: "subscription" },
        sourceOrder: { reserved: ["reserved-fact"], open: ["open-fact"], metered: ["metered-fact"] },
      };
      let snapshot = emptyEconomicSnapshot();
      for (const fact of [
        { model: "fixture/subscription-reserved", sourceId: "reserved-fact", scopeRef: "reserved", billing: "subscription", windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.1 }] },
        { model: "fixture/subscription-open", sourceId: "open-fact", scopeRef: "open", billing: "subscription", windows: [] },
        { model: "fixture/metered", sourceId: "metered-fact", scopeRef: "metered", billing: "metered", windows: [] },
      ]) {
        const result = publishEconomicObservation(snapshot, policy, { ...fact, observedAt: 100, expiresAt: 2_000, revision: 1 } as EconomicSignal);
        assert.equal(result.accepted, true);
        snapshot = result.snapshot;
      }
      let reliability = emptyReliabilityState();
      const config = { ...DEFAULT_RELIABILITY, failureThreshold: 1, cooldownMinutes: 10 };
      reliability = recordModelFailure(reliability, "fixture/subscription-open", config, now, "dispatch", "transport");
      const result = resolveConfiguredTier(ctx, "general", {
        models: { general: ["fixture/metered", "fixture/subscription-reserved", "fixture/subscription-open"] },
        strategy: "first",
      }, reliability, config, now, { policy, snapshot }).resolution;
      assert.equal(modelKey(result.selected), "fixture/metered");
      assert.deepEqual(result.primary.healthyCandidates.map(modelKey), ["fixture/metered"]);
      assert.deepEqual(result.primary.selectionCandidates?.map(modelKey), ["fixture/metered"]);
      assert.equal(result.primary.billingPreference?.preferredCount, 0);
      assert.equal(result.primary.skipped.some((entry) => entry.key === "fixture/subscription-open"), true);
    });
  });
  describe("modelKey", () => {
    it("returns provider/id", () => {
      const m = makeModel("anthropic", "claude-opus", 15);
      assert.equal(modelKey(m), "anthropic/claude-opus");
    });

    it("returns none for undefined", () => {
      assert.equal(modelKey(undefined), "none");
    });
  });

  describe("modelCost", () => {
    it("sums input and output cost", () => {
      const m = makeModel("x", "y", 3);
      m.cost.output = 7;
      assert.equal(modelCost(m), 10);
    });
  });

  describe("findOneModel", () => {
    it("finds exact provider/id", () => {
      const ctx = makeCtx([makeModel("anthropic", "claude-opus", 15)]);
      const m = findOneModel(ctx, "anthropic/claude-opus");
      assert.ok(m);
      assert.equal(modelKey(m), "anthropic/claude-opus");
    });

    it("finds ids containing slashes", () => {
      const ctx = makeCtx([makeModel("lmstudio", "qwen/qwen3-vl-8b", 0)]);
      const m = findOneModel(ctx, "lmstudio/qwen/qwen3-vl-8b");
      assert.ok(m);
      assert.equal(modelKey(m), "lmstudio/qwen/qwen3-vl-8b");
    });

    it("finds by substring", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-sonnet", 3),
        makeModel("anthropic", "claude-opus", 15),
      ]);
      const m = findOneModel(ctx, "opus");
      assert.ok(m);
      assert.equal(modelKey(m), "anthropic/claude-opus");
    });

    it("returns undefined when not found", () => {
      const ctx = makeCtx([]);
      assert.equal(findOneModel(ctx, "anthropic/missing"), undefined);
    });
  });

  describe("findCandidates", () => {
    it("excludes virtual entries from exact and fuzzy candidate pools", () => {
      const virtual = { ...makeModel("bifrost", "auto"), api: "pi-virtual" } as ReturnType<typeof makeModel>;
      const physical = makeModel("fixture", "auto-fast");
      const ctx = makeCtx([virtual, physical]);
      assert.deepEqual(findCandidates(ctx, "bifrost/auto"), []);
      assert.deepEqual(findCandidates(ctx, "auto"), [physical]);
    });

    it("returns multiple models for an array", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-opus", 15),
        makeModel("anthropic", "claude-sonnet", 3),
      ]);
      const candidates = findCandidates(ctx, [
        "anthropic/claude-opus",
        "anthropic/claude-sonnet",
      ]);
      assert.equal(candidates.length, 2);
    });

    it("deduplicates models", () => {
      const ctx = makeCtx([makeModel("anthropic", "claude-opus", 15)]);
      const candidates = findCandidates(ctx, [
        "anthropic/claude-opus",
        "anthropic/claude-opus",
      ]);
      assert.deepEqual(candidates.map(modelKey), ["anthropic/claude-opus"]);
    });

    it("matches substring and exact together", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-opus", 15),
        makeModel("lmstudio", "qwen/qwen3-vl-8b", 0),
      ]);
      const candidates = findCandidates(ctx, ["anthropic/claude-opus", "lmstudio"]);
      assert.deepEqual(candidates.map(modelKey), [
        "anthropic/claude-opus",
        "lmstudio/qwen/qwen3-vl-8b",
      ]);
    });
  });

  describe("findCandidates parity", () => {
    // Naive reference implementation: per-call lowercasing, dedup by key,
    // rule-order iteration. The optimized path must return identical
    // candidates in identical order for any input.
    function naiveFindCandidates(
      ctx: ReturnType<typeof makeCtx>,
      pattern: string | string[] | undefined,
    ): string[] {
      if (!pattern) return [];
      const out: string[] = [];
      const seen = new Set<string>();
      const patterns = Array.isArray(pattern) ? pattern : [pattern];
      const available = ctx.modelRegistry.getAvailable();
      const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
      for (const p of patterns) {
        if (p.includes("/")) {
          const [provider, ...rest] = p.split("/");
          const id = rest.join("/");
          const found = available.find(
            (m) => m.provider === provider && m.id === id,
          );
          if (found) {
            const k = keyOf(found);
            if (!seen.has(k)) {
              seen.add(k);
              out.push(k);
            }
          }
        } else {
          const lower = p.toLowerCase();
          for (const m of available) {
            if (
              !seen.has(keyOf(m)) &&
              (m.id.toLowerCase().includes(lower) ||
                m.provider.toLowerCase().includes(lower))
            ) {
              seen.add(keyOf(m));
              out.push(keyOf(m));
            }
          }
        }
      }
      return out;
    }

    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it("memoized path matches naive reference across randomized trials", () => {
      const rand = mulberry32(20260824);
      const providers = ["opencode", "anthropic", "OpenAI", "google-x"];
      for (let trial = 0; trial < 200; trial++) {
        const n = 1 + Math.floor(rand() * 40);
        const models = Array.from({ length: n }, () => {
          const provider = providers[Math.floor(rand() * providers.length)];
          const id = [
            rand() > 0.7 ? "GLM" : "glm",
            "-",
            Math.floor(rand() * 100),
            rand() > 0.5 ? "-Turbo" : "-mini",
          ].join("");
          return makeModel(provider, id);
        });
        const ctx = makeCtx(models);
        const patterns: string[] = [];
        const patternCount = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < patternCount; i++) {
          const roll = rand();
          if (roll < 0.3 && models.length > 0) {
            const m = models[Math.floor(rand() * models.length)];
            patterns.push(`${m.provider}/${m.id}`);
          } else if (roll < 0.45) {
            const m = models[Math.floor(rand() * models.length)];
            patterns.push(`${m.provider}/missing-${Math.floor(rand() * 10)}`);
          } else if (roll < 0.75) {
            const m = models[Math.floor(rand() * models.length)];
            patterns.push(m.id.slice(0, 3 + Math.floor(rand() * 4)));
          } else {
            patterns.push(["glm", "turbo", "nope", "OPEN"][Math.floor(rand() * 4)]);
          }
        }
        const pattern: string | string[] =
          patternCount === 1 && rand() < 0.5 ? patterns[0] : patterns;

        const expected = naiveFindCandidates(ctx, pattern);
        const actual = findCandidates(ctx, pattern).map(modelKey);
        assert.deepEqual(actual, expected, `trial ${trial}: ${JSON.stringify(pattern)}`);

        // Repeat call must be identical (memoization must not corrupt state).
        const repeat = findCandidates(ctx, pattern).map(modelKey);
        assert.deepEqual(repeat, expected, `trial ${trial} repeat`);
      }
    });

    it("registry refresh (new model objects) sees updated ids", () => {
      const models = [makeModel("anthropic", "claude-opus", 15)];
      const ctx = makeCtx(models);
      assert.equal(findCandidates(ctx, "opus").length, 1);

      models[0] = makeModel("anthropic", "claude-sonnet", 15);
      assert.deepEqual(findCandidates(ctx, "opus"), []);
      assert.equal(findCandidates(ctx, "sonnet").length, 1);
    });
  });

  describe("selectModel", () => {
    it("returns first candidate for first strategy", () => {
      const a = makeModel("a", "a", 5, 10, 32000);
      const b = makeModel("b", "b", 1, 2, 128000);
      const m = selectModel([a, b], "first");
      assert.equal(modelKey(m), "a/a");
    });

    it("returns cheapest (input+output)", () => {
      const a = makeModel("a", "a", 5, 0);
      const b = makeModel("b", "b", 1, 0);
      const c = makeModel("c", "c", 3, 2);
      const m = selectModel([a, b, c], "cheapest");
      assert.equal(modelKey(m), "b/b");
    });

    it("returns cheapest input cost", () => {
      const a = makeModel("a", "a", 5, 0);
      const b = makeModel("b", "b", 1, 10);
      const m = selectModel([a, b], "cheapest_input");
      assert.equal(modelKey(m), "b/b");
    });

    it("returns cheapest output cost", () => {
      const a = makeModel("a", "a", 0, 5);
      const b = makeModel("b", "b", 5, 1);
      const m = selectModel([a, b], "cheapest_output");
      assert.equal(modelKey(m), "b/b");
    });

    it("returns largest context window", () => {
      const a = makeModel("a", "a", 0, 0, 32000);
      const b = makeModel("b", "b", 0, 0, 256000);
      const m = selectModel([a, b], "largest_context");
      assert.equal(modelKey(m), "b/b");
    });

    it("returns a random candidate", () => {
      const a = makeModel("a", "a", 0, 0);
      const b = makeModel("b", "b", 0, 0);
      const originalRandom = Math.random;
      try {
        Math.random = () => 0.75;
        assert.equal(modelKey(selectModel([a, b], "random")), "b/b");
        Math.random = () => 0;
        assert.equal(modelKey(selectModel([a, b], "random")), "a/a");
      } finally {
        Math.random = originalRandom;
      }
    });

    it("keeps candidate order for fastest and metric ties", () => {
      const first = makeModel("a", "first", 2, 3, 128_000);
      const second = makeModel("b", "second", 2, 3, 128_000);
      const tied = [first, second];

      assert.equal(modelKey(selectModel(tied, "fastest")), "a/first");
      assert.equal(modelKey(selectModel(tied, "cheapest")), "a/first");
      assert.equal(modelKey(selectModel(tied, "cheapest_input")), "a/first");
      assert.equal(modelKey(selectModel(tied, "cheapest_output")), "a/first");
      assert.equal(modelKey(selectModel(tied, "largest_context")), "a/first");
    });

    it("returns undefined for empty candidates", () => {
      assert.equal(selectModel([], "first"), undefined);
    });

    it("returns a single candidate without invoking scoring, even with missing cost", () => {
      // Regression: the old sort never invoked the comparator for one
      // candidate, so cost-less models were returned as-is. minBy must
      // preserve that — no score call, no throw.
      const noCost = withoutCost(makeModel("a", "a", 5, 5));
      const m = selectModel([noCost], "cheapest");
      assert.equal(modelKey(m), "a/a");
      assert.equal(modelKey(selectModel([noCost], "largest_context")), "a/a");
    });
  });

  describe("resolveModel", () => {
    it("resolves a single pattern", () => {
      const ctx = makeCtx([makeModel("anthropic", "claude-opus", 15)]);
      const m = resolveModel(ctx, "anthropic/claude-opus", "first");
      assert.equal(modelKey(m), "anthropic/claude-opus");
    });

    it("resolves array to first available", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-opus", 15),
        makeModel("anthropic", "claude-sonnet", 3),
      ]);
      const m = resolveModel(ctx, ["anthropic/missing", "anthropic/claude-sonnet"], "first");
      assert.equal(modelKey(m), "anthropic/claude-sonnet");
    });
  });

  describe("resolveHealthyModel", () => {
    it("skips open-circuit candidates and picks next healthy model", () => {
      const a = makeModel("anthropic", "claude-opus", 15);
      const b = makeModel("anthropic", "claude-sonnet", 3);
      const ctx = makeCtx([a, b]);
      const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      let state = emptyReliabilityState();
      state = recordModelFailure(state, modelKey(a), cfg, now, "probe", "timeout");
      state = recordModelFailure(state, modelKey(a), cfg, now + 60_000, "probe", "timeout");
      state = recordModelFailure(state, modelKey(a), cfg, now + 120_000, "probe", "timeout");

      const result = resolveHealthyModel(ctx, ["anthropic/claude-opus", "anthropic/claude-sonnet"], "first", state, cfg, now + 120_000);
      assert.equal(modelKey(result.selected), "anthropic/claude-sonnet");
      assert.equal(result.skipped[0]?.key, "anthropic/claude-opus");
      assert.equal(result.skipped[0]?.reason, "open_circuit");
    });

    it("skips a candidate while its half-open trial is active", () => {
      const a = makeModel("anthropic", "claude-opus", 15);
      const b = makeModel("anthropic", "claude-sonnet", 3);
      const ctx = makeCtx([a, b]);
      const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      const state = {
        version: 1 as const,
        models: { [modelKey(a)]: { failures: [now - 60_000], openUntil: now - 1, trialActive: true } },
      };

      const result = resolveHealthyModel(ctx, [modelKey(a), modelKey(b)], "first", state, cfg, now);
      assert.equal(modelKey(result.selected), modelKey(b));
      assert.equal(result.skipped[0]?.reason, "trial_active");
    });
  });

  describe("resolveModelWithFallback", () => {
    it("falls back to default tier when requested tier is fully open-circuit", () => {
      const broken = makeModel("anthropic", "claude-opus", 15);
      const fallback = makeModel("openai", "gpt-4.1-mini", 1);
      const ctx = makeCtx([broken, fallback]);
      const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      let state = emptyReliabilityState();
      state = recordModelFailure(state, modelKey(broken), cfg, now, "probe", "timeout");
      state = recordModelFailure(state, modelKey(broken), cfg, now + 60_000, "probe", "timeout");
      state = recordModelFailure(state, modelKey(broken), cfg, now + 120_000, "probe", "timeout");

      const result = resolveModelWithFallback(ctx, {
        requestedTier: "frontier",
        requestedPattern: ["anthropic/claude-opus"],
        requestedStrategy: "first",
        defaultTier: "economical",
        defaultPattern: ["openai/gpt-4.1-mini"],
        defaultStrategy: "first",
        reliabilityState: state,
        reliabilityConfig: cfg,
        now: now + 120_000,
      });

      assert.equal(modelKey(result.selected), "openai/gpt-4.1-mini");
      assert.equal(result.selectedTier, "economical");
      assert.equal(result.fallbackReason, "requested_tier_unhealthy");
      assert.equal(result.skipped[0]?.key, "anthropic/claude-opus");
    });

    it("returns all_tiers_exhausted when both tiers have no healthy candidates", () => {
      const broken = makeModel("anthropic", "claude-opus", 15);
      const alsoBroken = makeModel("openai", "gpt-4.1-mini", 1);
      const ctx = makeCtx([broken, alsoBroken]);
      const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      let state = emptyReliabilityState();
      state = recordModelFailure(state, modelKey(broken), cfg, now, "probe", "timeout");
      state = recordModelFailure(state, modelKey(alsoBroken), cfg, now, "probe", "timeout");

      const result = resolveModelWithFallback(ctx, {
        requestedTier: "frontier",
        requestedPattern: ["anthropic/claude-opus"],
        requestedStrategy: "first",
        defaultTier: "economical",
        defaultPattern: ["openai/gpt-4.1-mini"],
        defaultStrategy: "first",
        reliabilityState: state,
        reliabilityConfig: cfg,
        now,
      });
      assert.equal(result.selected, undefined);
      assert.equal(result.fallbackReason, "all_tiers_exhausted");
    });
  });

  describe("route decision summary", () => {
    it("preserves structured exclusions, fallback strategy, and selection without prompt text", () => {
      const blocked = makeModel("fixture", "blocked", 1, 1, 64_000);
      const fallback = makeModel("fixture", "fallback", 2, 1, 128_000);
      const ctx = makeCtx([blocked, fallback]);
      const now = Date.UTC(2026, 0, 1);
      const reliabilityState = {
        version: 1 as const,
        models: {
          [modelKey(blocked)]: { failures: [now - 1_000], openUntil: now + 60_000, trialActive: false },
        },
      };
      const config = {
        models: { frontier: [modelKey(blocked)], quick: [modelKey(fallback)] },
        categoryStrategies: { frontier: "largest_context" as const, quick: "cheapest_output" as const },
        default: "quick",
      };
      const options = buildTierResolutionOptions("frontier", config);
      const resolution = resolveModelWithFallback(ctx, {
        ...options,
        reliabilityState,
        reliabilityConfig: DEFAULT_RELIABILITY,
        now,
      });
      const classification: ClassificationResult = {
        kind: "classified",
        tier: "frontier",
        source: "classifier",
        judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier", confidence: 0.91 },
      };

      const summary = buildRouteDecisionSummary(classification, { resolution, options });

      assert.equal(summary.outcome, "selected");
      assert.deepEqual(summary.requested?.candidates, [
        { model: "fixture/blocked", status: "excluded", exclusion: "open_circuit" },
      ]);
      assert.equal(summary.requested?.strategy, "largest_context");
      assert.equal(summary.fallback?.tier, "quick");
      assert.equal(summary.fallback?.strategy, "cheapest_output");
      assert.equal(summary.selected, "fixture/fallback");
      assert.equal(summary.selectedStrategy, "cheapest_output");
      assert.equal(JSON.stringify(summary).includes("private prompt words"), false);
    });

    it("keeps an unresolved configured pool visible without inventing a selection", () => {
      const ctx = makeCtx([]);
      const config = { models: { frontier: ["fixture/missing"] } };
      const options = buildTierResolutionOptions("frontier", config);
      const resolution = resolveModelWithFallback(ctx, { ...options });
      const summary = buildRouteDecisionSummary(
        { kind: "classified", tier: "frontier", source: "regex" },
        { resolution, options },
      );

      assert.equal(summary.outcome, "unresolved");
      assert.deepEqual(summary.requested?.patterns, ["fixture/missing"]);
      assert.deepEqual(summary.requested?.candidates, []);
      assert.equal("selected" in summary, false);
    });
  });

  describe("tier resolution options across registry refresh", () => {
    it("rebuilds the configured pool after an awaited refresh and config reload", async () => {
      const available = [makeModel("fixture", "old")];
      const ctx = makeCtx(available);
      const config = { models: { quick: ["fixture/missing"] }, default: "quick" };
      const beforeRefresh = resolveConfiguredTier(ctx, "quick", config);
      assert.equal(beforeRefresh.resolution.selected, undefined);
      assert.deepEqual(beforeRefresh.options.requestedPattern, ["fixture/missing"]);

      await Promise.resolve().then(() => {
        config.models.quick = ["fixture/new"];
        available.splice(0, available.length, makeModel("fixture", "new"));
      });
      const afterRefresh = resolveConfiguredTier(ctx, "quick", config);

      assert.equal(modelKey(afterRefresh.resolution.selected), "fixture/new");
      assert.deepEqual(afterRefresh.options.requestedPattern, ["fixture/new"]);
    });
  });

  describe("explicit tier fallback boundaries", () => {
    it("tries only explicit fallback tiers in order and records every attempted pool", () => {
      const preferred = makeModel("fixture", "preferred");
      const legacyDefault = makeModel("fixture", "legacy-default");
      const ctx = makeCtx([preferred, legacyDefault]);
      const config = {
        schemaVersion: 2,
        default: "economical",
        strategy: "first" as const,
        models: { quick: ["fixture/missing"], frontier: ["fixture/preferred"], economical: ["fixture/legacy-default"] },
        tierPolicies: { quick: { fallbackTiers: ["frontier", "economical"] } },
      };

      const result = resolveConfiguredTier(ctx, "quick", config);

      assert.equal(modelKey(result.resolution.selected), "fixture/preferred");
      assert.equal(result.resolution.selectedTier, "frontier");
      assert.equal(result.resolution.explicitBoundary, true);
      assert.deepEqual(result.resolution.attemptedTiers?.map((attempt) => attempt.tier), ["quick", "frontier"]);
    });

    it("treats an explicit empty list as a singleton and v2 without policy as legacy", () => {
      const fallback = makeModel("fixture", "fallback");
      const ctx = makeCtx([fallback]);
      const emptyBoundary = resolveConfiguredTier(ctx, "quick", {
        schemaVersion: 2,
        default: "general",
        models: { quick: ["fixture/missing"], general: ["fixture/fallback"] },
        tierPolicies: { quick: { fallbackTiers: [] } },
      });
      assert.equal(emptyBoundary.resolution.selected, undefined);
      assert.equal(emptyBoundary.resolution.explicitBoundary, true);
      assert.deepEqual(emptyBoundary.resolution.attemptedTiers?.map((attempt) => attempt.tier), ["quick"]);

      const legacy = resolveConfiguredTier(ctx, "quick", {
        schemaVersion: 2,
        default: "general",
        models: { quick: ["fixture/missing"], general: ["fixture/fallback"] },
      });
      assert.equal(modelKey(legacy.resolution.selected), "fixture/fallback");
      assert.equal(legacy.resolution.explicitBoundary, undefined);
    });
  });

  describe("getStrategy", () => {
    it("returns category strategy if set", () => {
      const categoryStrategies = { economical: "cheapest" as const };
      assert.equal(getStrategy(categoryStrategies, "first", "economical"), "cheapest");
      assert.equal(getStrategy(categoryStrategies, "first", "frontier"), "first");
    });

    it("returns global strategy as fallback", () => {
      assert.equal(getStrategy(undefined, "first", "economical"), "first");
    });

    it("defaults to first", () => {
      assert.equal(getStrategy(undefined, undefined, "economical"), "first");
    });
  });

  describe("classify (regex)", () => {
    it("returns undefined for invalid regex pattern", () => {
      const result = classify("hello", [{ pattern: "***invalid[", model: "frontier" }]);
      assert.equal(result, undefined);
    });

    it("precompiled matching preserves rule-order precedence across positions", () => {
      // Rule 1 matches later in the text but must still win — guards against
      // leftmost-first alternatives (e.g. a combined regex) changing precedence.
      const rules = [
        { pattern: "foo", model: "first" },
        { pattern: "bar", model: "second" },
      ];
      assert.equal(classify("bar foo", rules), "first");
      assert.equal(classifyCompiled("bar foo", compileRules(rules)), "first");
    });
  });
});
