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
import { DEFAULT_RULES } from "../config.ts";
import { buildInitProposal } from "../commands.ts";
import { makeCtx, makeModel, withoutCost } from "./helpers.ts";

describe("commands helpers", () => {
  describe("guessTier", () => {
    it("classifies expensive models as frontier", () => {
      const m = makeModel("any", "any-model", 10, 5);
      assert.equal(guessTier(m), "frontier");
    });

    it("classifies cheap models as quick", () => {
      const m = makeModel("any", "any-model", 0.5, 0.2);
      assert.equal(guessTier(m), "quick");
    });

    it("classifies free models (cost 0) as quick", () => {
      const m = makeModel("ollama", "local-model", 0, 0);
      assert.equal(guessTier(m), "quick");
    });

    it("classifies middling cost models as general", () => {
      const m = makeModel("any", "mid-model", 3, 0);
      assert.equal(guessTier(m), "general");
    });

    it("handles missing cost fields gracefully", () => {
      const m = withoutCost(makeModel("any", "no-cost", 0, 0));
      assert.equal(guessTier(m), "quick");
    });

    it("classifies high-cost models (>5) as frontier", () => {
      const m = makeModel("any", "expensive", 10, 0);
      assert.equal(guessTier(m), "frontier");
    });

    it("only returns known tier names", () => {
      const known = new Set(["quick", "general", "frontier"]);
      const cases = [
        makeModel("free", "free", 0, 0),
        makeModel("cheap", "cheap", 0.5, 0.2),
        makeModel("mid", "mid", 3, 0),
        makeModel("expensive", "expensive", 10, 0),
        withoutCost(makeModel("no-cost", "no-cost", 0, 0)),
      ];
      for (const m of cases) {
        const tier = guessTier(m);
        assert(tier === undefined || known.has(tier), `unexpected tier ${tier}`);
      }
    });
  });

  describe("DEFAULT_RULES", () => {
    it("routes only to known tiers", () => {
      const known = new Set(["quick", "general", "frontier"]);
      for (const rule of DEFAULT_RULES) {
        assert(known.has(rule.model), `rule routes to unknown tier ${rule.model}`);
      }
    });
  });

  describe("buildInitProposal", () => {
    it("category strategy keys match model tier keys", () => {
      const proposal = buildInitProposal(
        { quick: [], general: [], frontier: [] },
        "provider/classifier",
        ".",
      ) as { categoryStrategies: Record<string, string>; models: Record<string, string[]> };
      assert.deepEqual(
        Object.keys(proposal.categoryStrategies).sort(),
        Object.keys(proposal.models).sort(),
      );
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
