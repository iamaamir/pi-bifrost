import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  findOneModel,
  findCandidates,
  selectModel,
  resolveModel,
  modelKey,
  modelCost,
  getStrategy,
  classify,
} from "../routing.ts";

function makeModel(
  provider: string,
  id: string,
  inputCost = 0,
  outputCost = 0,
  contextWindow = 128000,
): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions" as Api,
    baseUrl: "http://localhost:1234/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
  } as unknown as Model<Api>;
}

function makeRegistry(models: Model<Api>[]) {
  return {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => models,
  };
}

function makeCtx(models: Model<Api>[]): ExtensionContext {
  return {
    modelRegistry: makeRegistry(models),
  } as unknown as ExtensionContext;
}

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
