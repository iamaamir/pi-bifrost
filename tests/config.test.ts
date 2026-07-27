import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, type BifrostConfig } from "../config.ts";
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

  it("allows multiple issues", () => {
    const issues = validateConfig({
      models: {},
      default: "frontier",
      rules: [{ pattern: "[invalid", model: "frontier" }],
    });
    assert.equal(issues.length, 3);
  });
});
