import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, validateConfig, type BifrostConfig } from "../config.ts";
import type { RoutingStrategy } from "../routing.ts";

const baseConfig: BifrostConfig = {
  enabled: true,
  default: "economical",
  strategy: "first",
  models: {
    frontier: ["model-a"],
    economical: ["model-b"],
  },
};

describe("validateConfig", () => {
  it("returns no issues for a valid config", () => {
    const issues = validateConfig(baseConfig);
    assert.equal(issues.length, 0);
  });

  it("errors when models is empty (two errors: no tiers + default missing)", () => {
    const issues = validateConfig({ ...baseConfig, models: {} });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 2);
    assert.ok(errors[0].message.includes('No tiers configured'));
    assert.ok(errors[1].message.includes('not found in models'));
  });

  it("errors when default tier is missing from models", () => {
    const issues = validateConfig({
      ...baseConfig,
      models: { frontier: ["model-a"] },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('not found in models'));
  });

  it("errors when category strategy references missing tier", () => {
    const issues = validateConfig({
      ...baseConfig,
      categoryStrategies: { nonexistent: "cheapest" },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('not found in models'));
  });

  it("warns on unknown strategy", () => {
    const issues = validateConfig({
      ...baseConfig,
      strategy: "unknown_strategy" as RoutingStrategy,
    });
    const warnings = issues.filter((i) => i.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('Unknown strategy'));
  });

  it("errors on invalid cache threshold", () => {
    const issues = validateConfig({
      ...baseConfig,
      cache: { threshold: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('between 0 and 1'));
  });

  it("errors on invalid cache retention", () => {
    const issues = validateConfig({ ...baseConfig, cache: { ttlHours: 0 } });
    assert.ok(issues.some((issue) => issue.severity === "error" && issue.message.includes("ttlHours")));
  });

  it("warns when cache maxEntries is 0", () => {
    const issues = validateConfig({
      ...baseConfig,
      cache: { maxEntries: 0 },
    });
    const warnings = issues.filter((i) => i.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('should be > 0'));
  });

  it("errors on invalid regex in rules", () => {
    const issues = validateConfig({
      ...baseConfig,
      rules: [{ pattern: "[invalid", model: "frontier" }],
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('Invalid regex'));
  });

  it("errors on invalid reliability window", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { windowMinutes: 0 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("windowMinutes"));
  });

  it("errors on non-integer reliability window", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { windowMinutes: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on non-integer reliability threshold", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { failureThreshold: NaN },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on non-integer reliability cooldown", () => {
    const issues = validateConfig({
      ...baseConfig,
      reliability: { cooldownMinutes: 1.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on invalid probe concurrency", () => {
    const issues = validateConfig({
      ...baseConfig,
      probe: { concurrency: 0 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("Probe"));
    assert.ok(errors[0].message.includes("integer"));
  });

  it("errors on non-integer probe timeout", () => {
    const issues = validateConfig({
      ...baseConfig,
      probe: { timeoutMs: 10.5 },
    });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes("Probe"));
  });

  it("accepts opt-in TypeSafe config with nested pinned transport", () => {
    const issues = validateConfig({
      ...baseConfig,
      classifier: {
        backend: "typesafe",
        typesafe: { model: "jev-1.13.0" },
        criteria: { frontier: "complex", economical: "normal" },
        minConfidence: 0.8,
      },
    });
    assert.equal(issues.length, 0);
  });

  it("preserves explicitly supplied TypeSafe prompt-only fields for validation", () => {
    const inherited = mergeConfig(
      { classifier: { model: "prompt/model", method: "auto" } },
      { classifier: { backend: "typesafe" } },
    );
    assert.equal(inherited.classifier?.method, undefined);

    const explicit = mergeConfig(
      { classifier: { model: "prompt/model" } },
      { classifier: { backend: "typesafe", method: "direct" } },
    );
    assert.ok(validateConfig({ ...baseConfig, ...explicit }).some((issue) => issue.message.includes("does not support")));
  });

  it("rejects TypeSafe custom endpoint, model, and prompt-only fields", () => {
    const issues = validateConfig({
      ...baseConfig,
      classifier: {
        backend: "typesafe",
        model: "prompt/model",
        typesafe: { model: "other", endpoint: "http://localhost" },
        method: "direct",
        criteria: { frontier: "complex", economical: "normal" },
      },
    });
    assert.ok(issues.some((issue) => issue.message.includes("must be exactly")));
    assert.ok(issues.some((issue) => issue.message.includes("endpoint")));
    assert.ok(issues.some((issue) => issue.message.includes("does not support")));
  });

  it("allows valid probe settings", () => {
    const issues = validateConfig({
      ...baseConfig,
      probe: { concurrency: 8, timeoutMs: 5000 },
    });
    assert.equal(issues.length, 0);
  });

  it("allows multiple issues", () => {
    const issues = validateConfig({
      models: {},
      default: "frontier",
      rules: [{ pattern: "[invalid", model: "frontier" }],
    });
    assert.equal(issues.length, 3);
  });
});
