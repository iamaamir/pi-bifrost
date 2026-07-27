import { describe, it } from "node:test";
import assert from "node:assert/strict";

// resolveTierDisplay is not exported from commands.ts — it's internal.
// The handlers (handleInit, handleBenchmark, handlePreview) are also internal.
// These are tested via integration tests.
// This file verifies the routing helpers that commands.ts depends on.

import {
  getStrategy,
  selectModel,
  findCandidates,
  modelKey,
  guessTier,
} from "../routing.ts";
import { makeCtx, makeModel, withoutCost } from "./helpers.ts";

describe("commands helpers", () => {
  describe("guessTier", () => {
    it("classifies expensive models as frontier", () => {
      const m = makeModel("any", "any-model", 10, 5);
      assert.equal(guessTier(m), "frontier");
    });

    it("classifies cheap models as economical", () => {
      const m = makeModel("any", "any-model", 0.5, 0.2);
      assert.equal(guessTier(m), "economical");
    });

    it("classifies free models (cost 0) as economical", () => {
      const m = makeModel("ollama", "local-model", 0, 0);
      assert.equal(guessTier(m), "economical");
    });

    it("returns undefined for middling cost", () => {
      const m = makeModel("any", "mid-model", 3, 0);
      assert.equal(guessTier(m), undefined);
    });

    it("handles missing cost fields gracefully", () => {
      const m = withoutCost(makeModel("any", "no-cost", 0, 0));
      assert.equal(guessTier(m), "economical");
    });

    it("classifies high-cost models (>5) as frontier", () => {
      const m = makeModel("any", "expensive", 10, 0);
      assert.equal(guessTier(m), "frontier");
    });
  });

  describe("selectModel with cheapest strategy", () => {
    it("picks lowest input+output cost", () => {
      const a = makeModel("a", "a", 5, 0);
      const b = makeModel("b", "b", 1, 0);
      const c = makeModel("c", "c", 3, 2);
      const selected = selectModel([a, b, c], "cheapest");
      assert.equal(modelKey(selected), "b/b");
    });
  });

  describe("findCandidates with multiple patterns", () => {
    it("deduplicates across exact and substring matches", () => {
      const ctx = makeCtx([
        makeModel("anthropic", "claude-opus"),
        makeModel("anthropic", "claude-sonnet"),
      ]);
      const result = findCandidates(ctx, ["anthropic/claude-opus", "anthropic"]);
      assert.equal(result.length, 2);
    });

    it("returns empty for empty patterns", () => {
      const ctx = makeCtx([]);
      assert.equal(findCandidates(ctx, []).length, 0);
    });
  });

  describe("getStrategy", () => {
    it("falls back through category → global → default", () => {
      assert.equal(getStrategy({ frontier: "cheapest" }, "first", "frontier"), "cheapest");
      assert.equal(getStrategy({}, "first", "economical"), "first");
      assert.equal(getStrategy(undefined, undefined, "economical"), "first");
    });
  });
});
