import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../routing.ts";
import { emptyReliabilityState, recordModelFailure, DEFAULT_RELIABILITY } from "../reliability.ts";
import { makeCtx, makeModel } from "./helpers.ts";

describe("routing", () => {
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
      assert.equal(candidates.length, 1);
    });

    it("matches substring and exact together", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-opus", 15),
        makeModel("lmstudio", "qwen/qwen3-vl-8b", 0),
      ]);
      const candidates = findCandidates(ctx, ["anthropic/claude-opus", "lmstudio"]);
      assert.equal(candidates.length, 2);
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
      const results = new Set();
      for (let i = 0; i < 20; i++) results.add(selectModel([a, b], "random")!.id);
      assert.ok(results.has("a"));
      assert.ok(results.has("b"));
    });

    it("returns undefined for empty candidates", () => {
      assert.equal(selectModel([], "first"), undefined);
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
  });
});
