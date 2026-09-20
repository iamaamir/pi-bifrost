import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPipeline, type PipelineDeps } from "../classification-pipeline.ts";
import { makeClassifierModel } from "./helpers.ts";

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    cacheLookup: () => undefined,
    classifierModels: [],
    classifyWithLLM: async () => undefined,
    regexRules: [],
    defaultTier: undefined,
    tiers: ["frontier", "economical"],
    ...overrides,
  };
}

describe("classification-pipeline", () => {
  describe("unclassified", () => {
    it("returns unclassified when no tiers configured", async () => {
      const p = createPipeline(deps({ tiers: [] }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "unclassified");
    });

    it("returns unclassified when nothing matches and no default", async () => {
      const p = createPipeline(deps({ defaultTier: undefined }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "unclassified");
    });
  });

  describe("cache", () => {
    it("returns classified from cache hit", async () => {
      const p = createPipeline(
        deps({ cacheLookup: () => "economical" }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "economical");
        assert.equal(r.source, "cache");
      }
    });

    it("skips cache when result is not a known tier", async () => {
      const p = createPipeline(
        deps({ cacheLookup: () => "unknown" }),
      );
      const r = await p.classify("hello");
      // Falls through to default
      assert.notEqual(r.kind, "classified");
    });
  });

  describe("classifier", () => {
    it("tries TypeSafe before existing prompt classifier", async () => {
      const calls: string[] = [];
      const p = createPipeline(deps({
        classifyWithTypeSafe: async () => {
          calls.push("typesafe");
          return { tier: "frontier", backend: "typesafe", model: "jev-1.13.0", confidence: 0.93 };
        },
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => { calls.push("prompt"); return "economical"; },
      }));
      const r = await p.classify("debug this");
      assert.deepEqual(calls, ["typesafe"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.deepEqual(r.judgment, { tier: "frontier", backend: "typesafe", model: "jev-1.13.0", confidence: 0.93 });
      }
    });

    it("does not continue fallback work after TypeSafe cancellation", async () => {
      const controller = new AbortController();
      controller.abort();
      let promptCalled = false;
      const p = createPipeline(deps({
        classifyWithTypeSafe: async () => undefined,
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => { promptCalled = true; return "frontier"; },
      }));
      const result = await p.classify("hello", controller.signal);
      assert.equal(result.kind, "unclassified");
      assert.equal(promptCalled, false);
    });

    it("falls from TypeSafe to prompt, then regex/default", async () => {
      const calls: string[] = [];
      const p = createPipeline(deps({
        classifyWithTypeSafe: async () => { calls.push("typesafe"); return undefined; },
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => { calls.push("prompt"); return undefined; },
        regexRules: [{ pattern: "hello", model: "frontier" }],
        defaultTier: "economical",
      }));
      const r = await p.classify("hello");
      assert.deepEqual(calls, ["typesafe", "prompt"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") assert.equal(r.source, "regex");
    });

    it("uses TypeSafe miss with prompt fallback and default", async () => {
      const p = createPipeline(deps({
        classifyWithTypeSafe: async () => undefined,
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => undefined,
        defaultTier: "economical",
      }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
    });

    it("retains prompt backend and model metadata", async () => {
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("fixture", "prompt-model")],
        classifyWithLLM: async () => ({ tier: "frontier", backend: "prompt", confidence: 0.81 }),
      }));
      const r = await p.classify("debug this");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.judgment?.backend, "prompt");
        assert.equal(r.judgment?.model, "prompt-model");
        assert.equal(r.judgment?.confidence, 0.81);
      }
    });

    it("uses first successful classifier model", async () => {
      let calls = 0;
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
          classifyWithLLM: async (model) => {
            calls++;
            if (model.kind === "registry" && model.model.id === "m1") return "frontier";
            return undefined;
          },
        }),
      );
      const r = await p.classify("debug this");
      assert.equal(calls, 1); // second model never tried
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.equal(r.source, "classifier");
      }
    });

    it("tries second model when first fails", async () => {
      let calls: string[] = [];
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
          classifyWithLLM: async (model) => {
            calls.push(model.kind === "registry" ? model.model.id : model.id);
            if (model.kind === "registry" && model.model.id === "m2") return "economical";
            return undefined;
          },
        }),
      );
      const r = await p.classify("hello");
      assert.deepEqual(calls, ["m1", "m2"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "classifier");
      }
    });

    it("validates classifier result against known tiers", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => "unknown",
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello");
      // Unknown tier → falls through to default
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });

    it("skips classifier when classifierModels is empty", async () => {
      let called = false;
      const p = createPipeline(
        deps({
          classifierModels: [],
          classifyWithLLM: async () => { called = true; return "frontier"; },
          regexRules: [{ pattern: "hello", model: "frontier" }],
        }),
      );
      await p.classify("hello");
      assert.equal(called, false);
    });
  });

  describe("regex", () => {
    it("matches regex rule", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bdebug\\b", model: "frontier" }],
        }),
      );
      const r = await p.classify("debug the thing");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.equal(r.source, "regex");
      }
    });

    it("matches regex rule with direct model reference", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bcommit\\b", model: "opencode-go/glm-5.1" }],
        }),
      );
      const r = await p.classify("commit the changes");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "opencode-go/glm-5.1");
        assert.equal(r.source, "regex");
      }
    });

    it("direct model reference bypasses tier lookup", async () => {
      // Model reference "unknown/model" is not in tiers, should still match.
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: ".*", model: "custom/model" }],
          tiers: ["frontier"],
        }),
      );
      const r = await p.classify("anything");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "custom/model");
      }
    });

    it("falls through to default when no rule matches", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bdebug\\b", model: "frontier" }],
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello world");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });

  describe("priority order", () => {
    it("cache beats classifier", async () => {
      let classifierCalled = false;
      const p = createPipeline(
        deps({
          cacheLookup: () => "frontier",
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { classifierCalled = true; return "economical"; },
        }),
      );
      const r = await p.classify("test");
      assert.equal(classifierCalled, false);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "cache");
      }
    });

    it("classifier beats regex", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => "economical",
          regexRules: [{ pattern: ".*", model: "frontier" }],
        }),
      );
      const r = await p.classify("test");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "classifier");
        assert.equal(r.tier, "economical");
      }
    });

    it("regex beats default", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: ".*", model: "frontier" }],
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("test");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "regex");
      }
    });
  });

  describe("fallback", () => {
    it("returns fallback when only default matches", async () => {
      const p = createPipeline(
        deps({ defaultTier: "economical" }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });

  describe("classifier error resilience", () => {
    it("catches classifier throw and falls through to regex", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { throw new Error("boom"); },
          regexRules: [{ pattern: ".*", model: "frontier" }],
        }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "regex");
      }
    });

    it("catches classifier throw and falls through to default", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { throw new Error("boom"); },
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });
});
