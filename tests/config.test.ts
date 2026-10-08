import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, validateConfig, validateTierPolicyConfig, configHasNoPools, hasClassifierConfigErrors, type BifrostConfig } from "../config.ts";
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

describe("configHasNoPools", () => {
  it("detects missing and empty pools, and accepts any configured model", () => {
    assert.equal(configHasNoPools({}), true);
    assert.equal(configHasNoPools({ models: {} }), true);
    assert.equal(configHasNoPools({ models: { quick: [], general: [] } }), true);
    assert.equal(configHasNoPools({ models: { quick: "   " } }), true);
    assert.equal(configHasNoPools({ models: { quick: [" "] } }), true);
    assert.equal(configHasNoPools({ models: { quick: [" ", "provider/m"] } }), false);
    assert.equal(configHasNoPools({ models: { quick: "provider/m" } }), false);
    assert.equal(configHasNoPools({ models: { quick: [], general: ["provider/m"] } }), false);
  });
});

describe("validateConfig", () => {
  it("returns no issues for a valid config", () => {
    const issues = validateConfig(baseConfig);
    assert.equal(issues.length, 0);
  });

  it("defaults allowance recovery on and validates its explicit opt-out", () => {
    assert.deepEqual(validateConfig({ ...baseConfig, reliability: { retryOnAllowanceExhausted: false } }), []);
    assert.ok(validateConfig({ ...baseConfig, reliability: { retryOnAllowanceExhausted: "yes" } as never })
      .some((issue) => issue.code === "config.reliability_allowance_retry_invalid"));
  });

  it("keeps version 2 legacy when no explicit tier policy exists", () => {
    assert.equal(validateConfig({ ...baseConfig, schemaVersion: 2 }).length, 0);
    assert.equal(validateConfig({ ...baseConfig, legacyUnknown: true } as BifrostConfig).length, 0);
  });

  it("requires version 2 for tierPolicies and rejects unsupported versions", () => {
    const legacyPolicy = validateConfig({
      ...baseConfig,
      tierPolicies: { frontier: { fallbackTiers: [] } },
    });
    assert.ok(legacyPolicy.some((issue) => issue.message.includes("schemaVersion 2")));
    const unsupported = validateConfig({ ...baseConfig, schemaVersion: 3 });
    assert.ok(unsupported.some((issue) => issue.message.includes("Unsupported schemaVersion")));
  });

  it("gates affinity observation behind schema version 2 and validates only advisory fields", () => {
    assert.deepEqual(validateConfig({ ...baseConfig, schemaVersion: 2, affinity: { mode: "observe", providerAdvisory: true } }), []);
    assert.deepEqual(validateConfig({ ...baseConfig, schemaVersion: 2, affinity: { mode: "retain-within-tier" } }), []);
    assert.ok(validateConfig({ ...baseConfig, affinity: { mode: "observe" } }).some((issue) => issue.code === "config.affinity_requires_schema_v2"));
    assert.ok(validateConfig({ ...baseConfig, schemaVersion: 2, affinity: { mode: "policy" } as never }).some((issue) => issue.code === "config.affinity_invalid"));
  });

  it("returns stable content-free metadata for strict tier-policy validation issues", () => {
    const issues = validateTierPolicyConfig({
      ...baseConfig,
      schemaVersion: 2,
      tierPolicies: {
        frontier: { fallbackTiers: ["economical", "economical", "frontier", "PRIVATE_FALLBACK"], PRIVATE_FIELD: true },
        economical: { fallbackTiers: ["frontier"] },
        PRIVATE_TIER: { fallbackTiers: [] },
      },
    } as BifrostConfig);
    const metadata = issues.map(({ code, path }) => ({ code, path }));
    for (const expected of [
      { code: "config.tier_policy_unknown_field", path: "tierPolicies.*" },
      { code: "config.tier_policy_unknown_tier", path: "tierPolicies.*" },
      { code: "config.tier_policy_unknown_fallback", path: "tierPolicies.*.fallbackTiers" },
      { code: "config.tier_policy_self_fallback", path: "tierPolicies.*.fallbackTiers" },
      { code: "config.tier_policy_duplicate_fallback", path: "tierPolicies.*.fallbackTiers" },
      { code: "config.tier_policy_cycle", path: "tierPolicies.*.fallbackTiers" },
    ]) {
      assert.ok(metadata.some((item) => item.code === expected.code && item.path === expected.path), expected.code);
    }
    const serialized = JSON.stringify(metadata);
    assert.doesNotMatch(serialized, /PRIVATE_(?:FALLBACK|FIELD|TIER)/);

    const unsupported = validateTierPolicyConfig({ ...baseConfig, schemaVersion: 9 });
    assert.ok(unsupported.some((issue) => issue.code === "config.schema_version_unsupported" && issue.path === "schemaVersion"));
    const malformedNamespace = validateTierPolicyConfig({ ...baseConfig, schemaVersion: 2, tierPolicies: null } as unknown as BifrostConfig);
    assert.ok(malformedNamespace.some((issue) => issue.code === "config.tier_policies_invalid" && issue.path === "tierPolicies"));
    const missingVersion = validateTierPolicyConfig({ ...baseConfig, tierPolicies: { frontier: { fallbackTiers: [] } } });
    assert.ok(missingVersion.some((issue) => issue.code === "config.tier_policies_requires_v2" && issue.path === "tierPolicies"));
    const invalidPolicy = validateTierPolicyConfig({ ...baseConfig, schemaVersion: 2, tierPolicies: { frontier: null } } as unknown as BifrostConfig);
    assert.ok(invalidPolicy.some((issue) => issue.code === "config.tier_policy_invalid" && issue.path === "tierPolicies.*"));
    const invalidFallbacks = validateTierPolicyConfig({ ...baseConfig, schemaVersion: 2, tierPolicies: { frontier: { fallbackTiers: "PRIVATE_FALLBACK" } } } as unknown as BifrostConfig);
    assert.ok(invalidFallbacks.some((issue) => issue.code === "config.tier_policy_fallback_invalid" && issue.path === "tierPolicies.*.fallbackTiers"));
  });

  it("validates fallback tier references, duplicates, self-links, cycles, and namespace fields", () => {
    const issues = validateConfig({
      ...baseConfig,
      schemaVersion: 2,
      tierPolicies: {
        frontier: { fallbackTiers: ["economical", "economical", "frontier", "missing"], extra: true },
        economical: { fallbackTiers: ["frontier"] },
        unknownTier: { fallbackTiers: [] },
      },
    } as BifrostConfig);
    const messages = issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);
    assert.ok(messages.some((message) => message.includes("Unknown field") && message.includes("tierPolicies.frontier")));
    assert.ok(messages.some((message) => message.includes("not found in models") && message.includes("missing")));
    assert.ok(messages.some((message) => message.includes("Duplicate fallback tier") && message.includes("economical")));
    assert.ok(messages.some((message) => message.includes("cannot fall back to itself")));
    assert.ok(messages.some((message) => message.includes("cycle")));
    assert.ok(messages.some((message) => message.includes("tierPolicies.unknownTier")));
  });

  it("allows an empty strict fallback list and merges per-tier policies with list replacement", () => {
    const valid = { ...baseConfig, schemaVersion: 2, tierPolicies: { frontier: { fallbackTiers: [] } } };
    assert.equal(validateConfig(valid).length, 0);
    const merged = mergeConfig(
      { ...baseConfig, schemaVersion: 2, tierPolicies: { frontier: { fallbackTiers: ["economical"] } } },
      { tierPolicies: { frontier: { fallbackTiers: [] } } },
    );
    assert.deepEqual(merged.tierPolicies?.frontier?.fallbackTiers, []);
  });

  it("preserves malformed tierPolicies namespaces through layer merge for rejection", () => {
    for (const tierPolicies of [null, "invalid", []]) {
      const merged = mergeConfig(
        { ...baseConfig, schemaVersion: 2 },
        { tierPolicies } as unknown as BifrostConfig,
      );
      assert.ok(validateConfig(merged).some((issue) => issue.message.includes("tierPolicies must be an object")));
    }
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

  it("accepts the default-on model-only allowance cooldown and rejects non-boolean overrides", () => {
    assert.equal(validateConfig({ ...baseConfig, reliability: {} }).some((issue) => issue.code === "config.reliability_allowance_cooldown_invalid"), false);
    assert.equal(validateConfig({ ...baseConfig, reliability: { cooldownOnAllowanceExhausted: false } }).some((issue) => issue.code === "config.reliability_allowance_cooldown_invalid"), false);
    assert.ok(validateConfig({
      ...baseConfig,
      reliability: { cooldownOnAllowanceExhausted: "yes" } as never,
    }).some((issue) => issue.code === "config.reliability_allowance_cooldown_invalid"));
  });

  it("accepts an explicitly disabled v2 policy and rejects unsupported state versions", () => {
    assert.equal(validateConfig({ ...baseConfig, reliability: { stateVersion: 1 } }).some((issue) => issue.code?.startsWith("config.reliability_")), false);
    assert.equal(validateConfig({
      ...baseConfig,
      schemaVersion: 2,
      reliability: { stateVersion: 2, enabled: false },
    }).some((issue) => issue.code?.startsWith("config.reliability_")), false);
    assert.ok(validateConfig({
      ...baseConfig,
      schemaVersion: 2,
      reliability: { stateVersion: 3 } as never,
    }).some((issue) => issue.code === "config.reliability_state_version_unsupported"));
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

  it("accepts the pi-native backend and rejects unknown backend values", () => {
    const ok = validateConfig({ ...baseConfig, classifier: { backend: "pi-native" } });
    assert.equal(ok.filter((issue) => issue.message.includes("backend")).length, 0);
    // A runtime-bad value on purpose: the cast sits at the fixture seam.
    const bad = validateConfig({ ...baseConfig, classifier: { backend: "bogus" } as unknown as BifrostConfig["classifier"] });
    assert.ok(bad.some((issue) => issue.message.includes("Unknown classifier backend")));
  });

  it("validates the piNative transport block like typesafe", () => {
    const ok = validateConfig({
      ...baseConfig,
      classifier: {
        backend: "pi-native",
        piNative: { model: "typesafe/jev-latest", timeoutMs: 2000, maxAttempts: 2, metrics: { enabled: true } },
        criteria: { frontier: "complex", economical: "normal" },
      },
    });
    assert.equal(ok.length, 0);

    const bounds = validateConfig({
      ...baseConfig,
      classifier: { backend: "pi-native", piNative: { timeoutMs: 50, maxAttempts: 9 }, criteria: { frontier: "complex", economical: "normal" } },
    });
    assert.ok(bounds.some((issue) => issue.message.includes("PiNative classifier timeoutMs")));
    assert.ok(bounds.some((issue) => issue.message.includes("PiNative classifier maxAttempts")));

    const promptFields = validateConfig({
      ...baseConfig,
      classifier: { backend: "pi-native", method: "direct", criteria: { frontier: "complex", economical: "normal" } },
    });
    assert.ok(promptFields.some((issue) => issue.message.includes("PiNative classifier does not support")));
  });

  it("accepts an optional total classifier timeout and rejects unsafe bounds", () => {
    assert.equal(validateConfig({ ...baseConfig, classifier: { backend: "prompt", totalTimeoutMs: 1 } }).length, 0);
    assert.equal(validateConfig({ ...baseConfig, classifier: {
      backend: "pi-native", totalTimeoutMs: 60_000,
      criteria: { frontier: "complex", economical: "normal" },
    } }).length, 0);
    for (const totalTimeoutMs of [0, -1, 1.5, 60_001, Number.MAX_SAFE_INTEGER + 1]) {
      const issues = validateConfig({ ...baseConfig, classifier: { backend: "prompt", totalTimeoutMs } });
      assert.ok(issues.some((issue) => issue.message.includes("Classifier totalTimeoutMs")), String(totalTimeoutMs));
    }
    const secretIssue = validateConfig({
      ...baseConfig,
      classifier: { backend: "prompt", totalTimeoutMs: "PRIVATE_TIMEOUT_VALUE" as never },
    }).find((issue) => issue.code === "config.classifier_total_timeout_invalid");
    assert.equal(secretIssue?.path, "classifier.totalTimeoutMs");
    assert.doesNotMatch(secretIssue?.message ?? "", /PRIVATE_TIMEOUT_VALUE/);
  });

  it("runs the shared direct-backend gate with the backend prefix", () => {
    const issues = validateConfig({
      ...baseConfig,
      // A runtime-bad fallback on purpose: the cast sits at the fixture seam.
      classifier: {
        backend: "pi-native",
        minConfidence: 2,
        fallback: "sometimes",
        criteria: { frontier: "complex", economical: "normal" },
      } as unknown as BifrostConfig["classifier"],
    });
    assert.ok(issues.some((issue) => issue.message.includes("PiNative classifier minConfidence")));
    assert.ok(issues.some((issue) => issue.message.includes("PiNative classifier fallback")));

    const missing = validateConfig({
      ...baseConfig,
      models: { mega: ["provider/model"] },
      default: "mega",
      classifier: { backend: "pi-native" },
    });
    assert.ok(missing.some((issue) => issue.message.includes('PiNative classifier criteria missing for tier "mega"')));
  });

  it("reaches criterion errors through hasClassifierConfigErrors", () => {
    // The empty criterion fires the singular "Classifier criterion" message,
    // which the old includes("Classifier criteria") match missed.
    const emptyCriterion: BifrostConfig = {
      ...baseConfig,
      classifier: { backend: "typesafe", criteria: { frontier: "", economical: "normal" } },
    };
    assert.equal(hasClassifierConfigErrors(emptyCriterion), true);
    const missingCriteria: BifrostConfig = {
      ...baseConfig,
      models: { mega: ["provider/model"] },
      default: "mega",
      classifier: { backend: "pi-native" },
    };
    assert.equal(hasClassifierConfigErrors(missingCriteria), true);
    assert.equal(hasClassifierConfigErrors({ ...baseConfig, classifier: { backend: "prompt" } }), false);
    assert.equal(hasClassifierConfigErrors({ ...baseConfig, models: {} }), false);
  });

  it("merges the piNative nested block across overrides", () => {
    const merged = mergeConfig(
      { classifier: { backend: "pi-native", piNative: { model: "typesafe/jev-latest" } } },
      { classifier: { piNative: { timeoutMs: 2000 } } },
    );
    assert.equal(merged.classifier?.piNative?.model, "typesafe/jev-latest");
    assert.equal(merged.classifier?.piNative?.timeoutMs, 2000);
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
