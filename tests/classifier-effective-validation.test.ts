import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasClassifierConfigErrors, type BifrostConfig } from "../config.ts";

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
