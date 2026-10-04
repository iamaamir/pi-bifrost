import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasClassifierConfigErrors, classifierConfigErrors, type BifrostConfig } from "../config.ts";
import { directStagePlan } from "../classifier-semantics.ts";

describe("direct classifier stage plan", () => {
  it("degrades an auto-detected direct backend to prompt when direct config is invalid", () => {
    const plan = directStagePlan({ backend: "pi-native", auto: true, classifierEnabled: true, tierCount: 3, directConfigOk: false, fallback: "prompt" });
    assert.deepEqual(plan, { useDirect: false, usePromptFallback: true, directDegraded: true });
  });

  it("fails closed for an explicit direct backend with invalid config", () => {
    const plan = directStagePlan({ backend: "pi-native", auto: false, classifierEnabled: true, tierCount: 3, directConfigOk: false, fallback: "prompt" });
    assert.deepEqual(plan, { useDirect: false, usePromptFallback: false, directDegraded: false });
  });

  it("runs direct plus prompt fallback when direct config is valid", () => {
    const plan = directStagePlan({ backend: "typesafe", auto: true, classifierEnabled: true, tierCount: 3, directConfigOk: true, fallback: "prompt" });
    assert.deepEqual(plan, { useDirect: true, usePromptFallback: true, directDegraded: false });
  });

  it("honors regex fallback, classifier-off, and empty tiers", () => {
    assert.equal(directStagePlan({ backend: "pi-native", auto: true, classifierEnabled: true, tierCount: 3, directConfigOk: false, fallback: "regex" }).usePromptFallback, false);
    assert.equal(directStagePlan({ backend: "pi-native", auto: true, classifierEnabled: false, tierCount: 3, directConfigOk: false, fallback: "prompt" }).usePromptFallback, false);
    assert.equal(directStagePlan({ backend: "pi-native", auto: true, classifierEnabled: true, tierCount: 0, directConfigOk: true, fallback: "prompt" }).usePromptFallback, false);
    assert.equal(directStagePlan({ backend: "prompt", auto: false, classifierEnabled: true, tierCount: 3, directConfigOk: true, fallback: "regex" }).usePromptFallback, true);
  });
});

describe("classifierConfigErrors", () => {
  it("exposes synthesized direct errors for an auto-detected backend", () => {
    const config: BifrostConfig = {
      default: "mega", models: { mega: ["chat/a"] },
      classifier: { method: "auto", maxTokens: 20, fallbackToRegex: true },
    };
    const errors = classifierConfigErrors(config, "pi-native");
    assert.ok(errors.some((message) => message.includes("criteria missing for tier")));
  });
});

describe("effective direct-backend validation", () => {
  const inheritedPrompt: BifrostConfig = {
    default: "general", models: { general: ["chat/a"] },
    classifier: { method: "auto", maxTokens: 20, fallbackToRegex: true },
  };

  it("accepts prompt-only fallback settings inherited before auto-detection", () => {
    assert.equal(hasClassifierConfigErrors(inheritedPrompt, "pi-native"), false);
    assert.equal(hasClassifierConfigErrors(inheritedPrompt, "typesafe"), false);
  });

  it("blocks invalid criteria and confidence for the effective backend", () => {
    const invalid: BifrostConfig = {
      ...inheritedPrompt,
      classifier: { ...inheritedPrompt.classifier, minConfidence: 2, criteria: { general: "" } },
    };
    assert.equal(hasClassifierConfigErrors(invalid), false);
    assert.equal(hasClassifierConfigErrors(invalid, "typesafe"), true);
    assert.equal(hasClassifierConfigErrors(invalid, "pi-native"), true);
  });

  it("rejects prompt-only fields when a direct backend was explicitly configured", () => {
    const explicit: BifrostConfig = {
      ...inheritedPrompt, classifier: { ...inheritedPrompt.classifier, backend: "pi-native" },
    };
    assert.equal(hasClassifierConfigErrors(explicit, "pi-native"), true);
  });
});
