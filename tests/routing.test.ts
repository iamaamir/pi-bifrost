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
import { emptyEconomicSnapshot, publishEconomicObservation, type EconomicSignal, type ReservePolicy } from "../economic-signals.ts";

describe("routing", () => {
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
