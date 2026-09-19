import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifierCacheKey } from "../classifier-semantics.ts";
import type { BifrostConfig } from "../config.ts";

function config(systemPrompt: string): BifrostConfig {
  return {
    models: { quick: "provider/quick", general: "provider/general" },
    default: "general",
    classifier: { backend: "prompt", model: "provider/classifier", systemPrompt },
  };
}

describe("classifier cache semantic key", () => {
  it("changes when prompt-classifier instructions change without persisting them", () => {
    const first = classifierCacheKey(config("private instruction alpha"), ["quick", "general"]);
    const second = classifierCacheKey(config("private instruction beta"), ["quick", "general"]);
    assert.notEqual(first, second);
    assert.doesNotMatch(first, /private instruction/);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  it("changes when TypeSafe credentials become available", () => {
    const typesafe: BifrostConfig = {
      ...config("same"),
      classifier: { ...config("same").classifier, backend: "typesafe" },
    };
    const fallbackOnly = classifierCacheKey(typesafe, ["quick", "general"], {
      typesafeCredentialAvailable: false,
    });
    const active = classifierCacheKey(typesafe, ["quick", "general"], {
      typesafeCredentialAvailable: true,
    });
    assert.notEqual(fallbackOnly, active);
  });

  it("is stable for criteria with different property insertion order", () => {
    const first: BifrostConfig = {
      ...config("same"),
      classifier: { ...config("same").classifier, criteria: { quick: "bounded", general: "normal" } },
    };
    const second: BifrostConfig = {
      ...config("same"),
      classifier: { ...config("same").classifier, criteria: { general: "normal", quick: "bounded" } },
    };
    assert.equal(classifierCacheKey(first, ["quick", "general"]), classifierCacheKey(second, ["quick", "general"]));
  });
});
