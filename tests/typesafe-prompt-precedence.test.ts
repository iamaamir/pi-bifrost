import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPipeline } from "../classification-pipeline.ts";
import { TYPESAFE_MODEL, createTypeSafeClassifier } from "../typesafe-classifier.ts";

const tiers = ["quick", "general"];
const criteria = { quick: "brief", general: "normal" };
const promptModel = { id: "prompt-fallback" };

function typeSafeResponse() {
  return {
    model: TYPESAFE_MODEL,
    answers: {
      tier: {
        type: "choice",
        choice: "general",
        confidence: 0.9,
        probabilities: { quick: 0.1, general: 0.9 },
      },
    },
  };
}

describe("TypeSafe prompt fallback precedence", () => {
  it("does not invoke prompt fallback after a successful TypeSafe judgment", async () => {
    let promptCalls = 0;
    const direct = createTypeSafeClassifier({
      apiKey: "test-key",
      maxAttempts: 1,
      fetchImpl: async () => new Response(JSON.stringify(typeSafeResponse()), { status: 200 }),
    });
    const pipeline = createPipeline({
      cacheLookup: () => undefined,
      classifyDirect: (text, availableTiers, signal) => direct({ prompt: text, tiers: availableTiers, criteria }, signal),
      classifierModels: [{ kind: "registry" as const, model: promptModel }],
      classifyWithLLM: async () => { promptCalls += 1; return "quick"; },
      regexRules: [],
      defaultTier: "quick",
      tiers,
    });

    const result = await pipeline.classify("prompt-sentinel");

    assert.equal(result.kind, "classified");
    assert.equal(result.tier, "general");
    assert.equal(result.source, "classifier");
    assert.equal(result.judgment?.backend, "typesafe");
    assert.equal(result.judgment?.model, TYPESAFE_MODEL);
    assert.equal(promptCalls, 0);
  });

  it("invokes prompt fallback once after a TypeSafe miss", async () => {
    let promptCalls = 0;
    const direct = createTypeSafeClassifier({
      apiKey: "test-key",
      maxAttempts: 1,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    const pipeline = createPipeline({
      cacheLookup: () => undefined,
      classifyDirect: (text, availableTiers, signal) => direct({ prompt: text, tiers: availableTiers, criteria }, signal),
      classifierModels: [{ kind: "registry" as const, model: promptModel }],
      classifyWithLLM: async () => { promptCalls += 1; return "quick"; },
      regexRules: [],
      defaultTier: "general",
      tiers,
    });

    const result = await pipeline.classify("prompt-sentinel");

    assert.equal(result.kind, "classified");
    assert.equal(result.tier, "quick");
    assert.equal(result.source, "classifier");
    assert.equal(promptCalls, 1);
  });
});
