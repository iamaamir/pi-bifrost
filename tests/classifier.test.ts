import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categoryLabel,
  classificationPrompt,
  classifyWithLLM,
  extractCategory,
} from "../classifier.ts";

describe("classifier", () => {
  describe("categoryLabel", () => {
    it("returns category name unchanged", () => {
      assert.equal(categoryLabel("frontier"), "frontier");
      assert.equal(categoryLabel("economical"), "economical");
      assert.equal(categoryLabel("local"), "local");
    });
  });

  describe("classificationPrompt", () => {
    it("lists categories by name", () => {
      const prompt = classificationPrompt(["frontier", "economical"], "hello");
      assert.ok(prompt.includes("frontier, economical"));
      assert.ok(prompt.includes("Request: hello"));
    });
  });

  it("routes registry classification through modelRegistry.streamSimple", async () => {
    let observedContext: { systemPrompt?: string; messages?: unknown[] } | undefined;
    let observedOptions: { maxTokens?: number; cacheRetention?: string } | undefined;
    const model = {
      provider: "fixture",
      id: "classifier",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      cost: { input: 0, output: 0 },
    };
    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      modelRegistry: {
        streamSimple: (_model: unknown, context: typeof observedContext, options: typeof observedOptions) => {
          observedContext = context;
          observedOptions = options;
          return {
            result: async () => ({
              role: "assistant",
              api: "openai-completions",
              provider: "fixture",
              model: "classifier",
              content: [{ type: "text", text: "frontier" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            }),
          };
        },
      },
    };

    const result = await classifyWithLLM(
      ctx as never,
      { kind: "registry", model } as never,
      ["quick", "frontier"],
      "design the architecture",
      { method: "direct" },
    );

    assert.equal(result, "frontier");
    assert.match(observedContext?.systemPrompt ?? "", /routing classifier/);
    assert.equal(observedContext?.messages?.length, 1);
    assert.equal(observedOptions?.maxTokens, 20);
    assert.equal(observedOptions?.cacheRetention, "none");
  });

  describe("extractCategory", () => {
    it("extracts exact category name", () => {
      assert.equal(extractCategory("frontier", ["frontier", "economical"]), "frontier");
    });

    it("is case-insensitive", () => {
      assert.equal(extractCategory("Frontier", ["frontier", "economical"]), "frontier");
    });

    it("handles surrounding whitespace", () => {
      assert.equal(extractCategory("  economical  ", ["frontier", "economical"]), "economical");
    });

    it("returns undefined for non-matching text", () => {
      assert.equal(extractCategory("unknown", ["frontier", "economical"]), undefined);
    });

    it("does not substring match", () => {
      // "not economical" should not match "economical"
      assert.equal(extractCategory("not economical", ["frontier", "economical"]), undefined);
    });
  });
});
