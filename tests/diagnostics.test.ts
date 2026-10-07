import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { inspectDiagnostics, validateDiagnostics, type DiagnosticRegistry } from "../diagnostics.ts";
import { emptyReliabilityState, recordModelFailure, type ReliabilityConfig } from "../reliability.ts";
import { makeModel } from "./helpers.ts";

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    models: { restricted: ["fixture/allowed", "missing-fragment"] },
    default: "restricted",
    strategy: "random",
    tierPolicies: { restricted: { fallbackTiers: [] } },
    rules: [],
    ...overrides,
  } as Parameters<typeof validateDiagnostics>[0]["config"];
}

function registry(options: {
  all?: Model<Api>[];
  available?: Model<Api>[];
  auth?: (provider: string) => { configured: boolean; source?: string; label?: string };
  throwAuth?: boolean;
  counters?: { reads: number; forbidden: number };
} = {}): DiagnosticRegistry & Record<string, unknown> {
  const all = options.all ?? [];
  const available = options.available ?? all;
  const counters = options.counters;
  return {
    getAll: () => { if (counters) counters.reads += 1; return all; },
    getAvailable: () => { if (counters) counters.reads += 1; return available; },
    find: (provider: string, id: string) => all.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: (provider: string) => {
      if (options.throwAuth) throw new Error("PRIVATE_AUTH_FAILURE");
      return options.auth?.(provider) ?? { configured: true, source: "runtime", label: "PRIVATE_ACCOUNT_LABEL" };
    },
    refresh: () => { if (counters) counters.forbidden += 1; throw new Error("refresh forbidden"); },
    classify: () => { if (counters) counters.forbidden += 1; throw new Error("classify forbidden"); },
    stream: () => { if (counters) counters.forbidden += 1; throw new Error("stream forbidden"); },
    streamSimple: () => { if (counters) counters.forbidden += 1; throw new Error("streamSimple forbidden"); },
    getApiKeyAndHeaders: () => { if (counters) counters.forbidden += 1; throw new Error("credential access forbidden"); },
  };
}

describe("offline diagnostics", () => {
  it("validates active config and registry references without exposing config prose", () => {
    const allowed = makeModel("fixture", "allowed");
    const bad = config({
      models: { restricted: ["fixture/missing-secret-pattern", "no-match-secret-pattern"] },
      tierPolicies: { restricted: { fallbackTiers: ["unknown-secret-tier"] } },
      rules: [{ pattern: "PRIVATE_REGEX_BODY", model: "missing-rule-target-secret" }],
    });
    const report = validateDiagnostics({ config: bad, registry: registry({ all: [allowed] }) });
    const serialized = JSON.stringify(report);

    assert.equal(report.version, 1);
    assert.equal(report.configSource, "loaded-effective-config");
    assert.ok(report.diagnostics.some((issue) => issue.code === "config.tier_policy_unknown_fallback" && issue.severity === "error"));
    assert.ok(report.diagnostics.some((issue) => issue.code === "model.reference_unresolved" && issue.entryIndex === 0));
    assert.ok(report.diagnostics.some((issue) => issue.code === "pool.pattern_unresolved" && issue.entryIndex === 1));
    assert.ok(report.diagnostics.some((issue) => issue.code === "rule.target_unresolved" && issue.ruleIndex === 0));
    for (const sentinel of ["PRIVATE_REGEX_BODY", "missing-secret-pattern", "no-match-secret-pattern", "unknown-secret-tier", "missing-rule-target-secret"]) {
      assert.equal(serialized.includes(sentinel), false);
    }
  });

  it("inspects pool expansions and circuits without route selection, RNG, mutation, or private auth output", () => {
    const candidate = makeModel("fixture", "allowed");
    const counters = { reads: 0, forbidden: 0 };
    const state = recordModelFailure(
      emptyReliabilityState(),
      "fixture/allowed",
      { failureThreshold: 1, cooldownMinutes: 5 },
      100,
      "agent_settled",
      "PRIVATE_PROVIDER_ERROR",
    );
    const before = JSON.stringify(state);
    const providerRegistry = registry({ all: [candidate], available: [], counters });
    const originalRandom = Math.random;
    Math.random = () => { throw new Error("inspect consumed RNG"); };
    try {
      const report = inspectDiagnostics({
        config: config(),
        registry: providerRegistry,
        reliabilityState: state,
        reliabilityConfig: { failureThreshold: 1, cooldownMinutes: 5 },
        now: 200,
        lastRegistryRefreshAt: 150,
      });
      const serialized = JSON.stringify(report);
      assert.equal(report.registry.knownModelCount, 1);
      assert.equal(report.registry.availableModelCount, 0);
      assert.equal(report.registry.bifrostLastRefreshAgeMs, 50);
      assert.equal(report.tiers[0]?.candidates[0]?.model, "fixture/allowed");
      assert.equal(report.tiers[0]?.candidates[0]?.available, false);
      assert.equal(report.tiers[0]?.candidates[0]?.auth, "configured");
      assert.equal(report.tiers[0]?.candidates[0]?.circuit, "open");
      assert.equal(counters.reads, 2, "registry lists are frozen once for the inspection");
      assert.equal(counters.forbidden, 0);
      assert.equal(JSON.stringify(state), before);
      assert.equal(serialized.includes("PRIVATE_ACCOUNT_LABEL"), false);
      assert.equal(serialized.includes("PRIVATE_PROVIDER_ERROR"), false);
      assert.equal(serialized.includes("PRIVATE_AUTH_FAILURE"), false);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("reports auth observability as unknown when the host status read throws", () => {
    const candidate = makeModel("fixture", "allowed");
    const report = inspectDiagnostics({
      config: config({ models: { restricted: ["fixture/allowed"] } }),
      registry: registry({ all: [candidate], throwAuth: true }),
      reliabilityState: emptyReliabilityState(),
      now: 500,
    });
    assert.equal(report.tiers[0]?.candidates[0]?.auth, "unknown");
  });

  it("reports an observable absent auth configuration without labeling it invalid", () => {
    const candidate = makeModel("fixture", "allowed");
    const report = inspectDiagnostics({
      config: config({ models: { restricted: ["fixture/allowed"] } }),
      registry: registry({ all: [candidate], auth: () => ({ configured: false, label: "PRIVATE_ACCOUNT_LABEL" }) }),
      reliabilityState: emptyReliabilityState(),
      now: 500,
    });
    assert.equal(report.tiers[0]?.candidates[0]?.auth, "not_configured");
    assert.equal(JSON.stringify(report).includes("invalid"), false);
    assert.equal(JSON.stringify(report).includes("PRIVATE_ACCOUNT_LABEL"), false);
  });

  it("expands fuzzy matches from known models even when they are currently unavailable", () => {
    const candidate = makeModel("fixture", "restricted-model");
    const report = inspectDiagnostics({
      config: config({ models: { restricted: ["restricted-model"] } }),
      registry: registry({ all: [candidate], available: [] }),
      reliabilityState: emptyReliabilityState(),
      now: 500,
    });
    assert.equal(report.tiers[0]?.candidates[0]?.model, "fixture/restricted-model");
    assert.equal(report.tiers[0]?.candidates[0]?.available, false);
  });

  it("treats malformed auth status as unknown", () => {
    const candidate = makeModel("fixture", "allowed");
    const malformedAuth = () => ({ source: "runtime", label: "PRIVATE_ACCOUNT_LABEL" }) as unknown as { configured: boolean };
    const report = inspectDiagnostics({
      config: config({ models: { restricted: ["fixture/allowed"] } }),
      registry: registry({ all: [candidate], auth: malformedAuth }),
      reliabilityState: emptyReliabilityState(),
      now: 500,
    });
    assert.equal(report.tiers[0]?.candidates[0]?.auth, "unknown");
    assert.equal(JSON.stringify(report).includes("PRIVATE_ACCOUNT_LABEL"), false);
  });

  it("does not fabricate auth, freshness, or circuit results when snapshots are unavailable", () => {
    const report = inspectDiagnostics({
      config: config(),
      registry: registry({ all: [], available: [] }),
      reliabilityState: emptyReliabilityState(),
      reliabilityConfig: { enabled: false } satisfies ReliabilityConfig,
      now: 500,
    });
    assert.deepEqual(report.tiers[0]?.candidates, []);
    assert.equal("bifrostLastRefreshAgeMs" in report.registry, false);
    assert.deepEqual(report.diagnostics, []);
  });

  it("reports missing registry without touching provider operations", () => {
    const report = validateDiagnostics({ config: config() });
    assert.ok(report.diagnostics.some((issue) => issue.code === "registry.unavailable"));
    assert.equal(JSON.stringify(report).includes("PRIVATE"), false);
  });

  it("returns a bounded diagnostic instead of throwing on malformed loaded config", () => {
    const malformed = config({ rules: [null] });
    const report = validateDiagnostics({ config: malformed, registry: registry() });
    assert.ok(report.diagnostics.some((issue) => issue.code === "config.validation_unavailable"));
    assert.equal(JSON.stringify(report).includes("null"), false);
  });

  it("maps static config issue codes and safe field paths without forwarding issue prose", () => {
    const invalidFallbacks = config({
      schemaVersion: 2,
      models: { quick: [], general: [] },
      tierPolicies: { quick: { fallbackTiers: ["PRIVATE_FALLBACK_VALUE", "general", "general"] } },
    });
    const fallbackReport = validateDiagnostics({ config: invalidFallbacks });
    const fallbackJson = JSON.stringify(fallbackReport);
    const missing = fallbackReport.diagnostics.find((issue) => issue.code === "config.tier_policy_unknown_fallback");
    const duplicate = fallbackReport.diagnostics.find((issue) => issue.code === "config.tier_policy_duplicate_fallback");
    assert.equal(missing?.path, "tierPolicies.*.fallbackTiers");
    assert.equal(duplicate?.path, "tierPolicies.*.fallbackTiers");
    assert.notEqual(missing?.code, duplicate?.code);
    assert.equal(fallbackJson.includes("PRIVATE_FALLBACK_VALUE"), false);

    const unsupportedVersion = validateDiagnostics({ config: config({ schemaVersion: 99 }) });
    const unsupported = unsupportedVersion.diagnostics.find((issue) => issue.code === "config.schema_version_unsupported");
    assert.equal(unsupported?.path, "schemaVersion");
    assert.notEqual(unsupported?.code, missing?.code);
    assert.equal(JSON.stringify(unsupportedVersion).includes("99"), false);
  });

  it("retains the generic legacy diagnostic when a validator issue has no structured metadata", () => {
    const report = validateDiagnostics({ config: config({ classifier: { backend: "PRIVATE_BACKEND_VALUE" } }) });
    assert.ok(report.diagnostics.some((issue) => issue.code === "config.invalid" && issue.severity === "error"));
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("PRIVATE_BACKEND_VALUE"), false);
    assert.equal(report.diagnostics.some((issue) => issue.path), false);
  });

});
