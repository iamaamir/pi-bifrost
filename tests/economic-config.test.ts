import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateEconomicConfig, type BifrostConfig } from "../config.ts";
import { normalizeEconomicPolicy, reconcileEconomicSnapshot } from "../economic-config.ts";
import type { EconomicConfig } from "../config.ts";
import type { EconomicSignal } from "../economic-signals.ts";
import { hasHardEconomicAdmission } from "../economic-signals.ts";

function observation(overrides: Partial<EconomicSignal> = {}): EconomicSignal {
  return {
    sourceId: "manual", scopeRef: "selected", billing: "metered", observedAt: 100, expiresAt: 2_000, revision: 1,
    windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.4 }],
    ...overrides,
  };
}

function config(overrides: Partial<EconomicConfig> = {}): EconomicConfig {
  return {
    mode: "observe",
    scopes: { selected: { kind: "model", model: "fixture/a" } },
    sources: [{ id: "manual", scopeRef: "selected", authority: "declared" }],
    admission: [{ id: "daily", scopeRef: "selected", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
    observations: [observation()],
    ...overrides,
  };
}

describe("economic config integration", () => {
  it("requires schema version 2 and rejects account, authoritative, adapter, and unknown namespace fields", () => {
    const missingVersion = validateEconomicConfig({ economics: config() });
    assert.ok(missingVersion.some((issue) => issue.code === "config.economics_requires_v2"));
    const invalid = validateEconomicConfig({
      schemaVersion: 2,
      economics: {
        ...config(),
        unsupported: true,
        scopes: { selected: { kind: "account", provider: "fixture", accountRef: "acct", epoch: "one" } },
        sources: [{ id: "manual", scopeRef: "selected", authority: "authoritative", kind: "live" }],
      },
    } as unknown as BifrostConfig);
    assert.ok(invalid.some((issue) => issue.code === "config.economics_account_scope_unsupported"));
    assert.ok(invalid.some((issue) => issue.code === "config.economics_authority_forbidden"));
    assert.ok(invalid.some((issue) => issue.code === "config.economics_unknown_field"));
  });

  it("accepts static declared or estimated sources and immutable observations", () => {
    const configured = config({ sources: [{ id: "manual", scopeRef: "selected", authority: "estimated" }] });
    const configuredScope = configured.scopes.selected;
    const valid = { schemaVersion: 2, economics: configured };
    assert.deepEqual(validateEconomicConfig(valid), []);
    const reconciled = reconcileEconomicSnapshot(undefined, undefined, valid.economics);
    assert.equal(reconciled.snapshot.signals.length, 1);
    assert.equal(Object.isFrozen(reconciled.snapshot), true);
    assert.equal(Object.isFrozen(configuredScope), false, "normalization must not freeze caller-owned scope records");
    assert.equal(Object.isFrozen(configured), false, "normalization must not freeze caller-owned config records");
    assert.equal(Object.isFrozen(configured.observations?.[0]), false, "publication must not freeze caller-owned facts");
  });

  it("accepts preference-only policy with empty-window billing facts but keeps empty policy invalid without preference", () => {
    const preferenceOnly = config({
      mode: "policy",
      admission: [],
      preference: { billingClass: "subscription" },
      observations: [observation({ windows: [] })],
    });
    assert.deepEqual(validateEconomicConfig({ schemaVersion: 2, economics: preferenceOnly }), []);
    assert.equal(hasHardEconomicAdmission(normalizeEconomicPolicy(preferenceOnly)), false);
    assert.equal(normalizeEconomicPolicy(preferenceOnly)?.preference?.billingClass, "subscription");

    const emptyPolicy = validateEconomicConfig({
      schemaVersion: 2,
      economics: config({ mode: "policy", admission: [], observations: [] }),
    });
    assert.ok(emptyPolicy.some((issue) => issue.code === "config.economics_policy_empty_admission"));
    assert.equal(hasHardEconomicAdmission(normalizeEconomicPolicy(config({ mode: "policy", admission: [] }))), false);
  });

  it("reports malformed preference with a safe field path", () => {
    const issues = validateEconomicConfig({
      schemaVersion: 2,
      economics: config({ preference: { billingClass: "private-secret", extra: "never echo" } as never }),
    });
    assert.ok(issues.some((issue) => issue.code === "config.economics_preference_invalid"
      && issue.path === "economics.preference.billingClass"));
    assert.equal(issues.some((issue) => issue.message.includes("private-secret") || issue.message.includes("never echo")), false);
  });

  it("keeps the preference-only example valid against the config contract", () => {
    const example = JSON.parse(readFileSync(new URL("../examples/economic-billing-preference.json", import.meta.url), "utf8")) as BifrostConfig;
    assert.deepEqual(validateEconomicConfig(example), []);
  });

  it("copies mutable prior facts and watermarks and drops the policy when economics is removed", () => {
    const policy = config({ observations: [] });
    const signal = observation();
    const watermark = { sourceId: "manual", scopeRef: "selected", windowId: "day", periodId: "p1", periodSequence: 1, revision: 1 };
    const prior = { revision: 1, signals: [signal], watermarks: [watermark] };
    const installed = reconcileEconomicSnapshot(prior, normalizeEconomicPolicy(policy), policy);
    assert.equal(Object.isFrozen(signal), false);
    assert.equal(Object.isFrozen(watermark), false);
    assert.equal(installed.snapshot.signals[0] === signal, false);
    assert.equal(installed.snapshot.watermarks[0] === watermark, false);

    const disabled = reconcileEconomicSnapshot(installed.snapshot, installed.policy, undefined, installed.quarantinedSourceRevisions);
    assert.equal(disabled.policy, undefined);
    assert.equal(disabled.historyPolicy?.mode, policy.mode);
    assert.equal(disabled.snapshot, installed.snapshot);

    const reenabled = reconcileEconomicSnapshot(disabled.snapshot, disabled.historyPolicy, policy, disabled.quarantinedSourceRevisions);
    assert.equal(reenabled.snapshot.signals[0]?.revision, signal.revision);
    assert.equal(reenabled.policy?.mode, policy.mode);
  });

  it("invalidates observations when a source scope binding changes and reports no retained signal", () => {
    const initial = reconcileEconomicSnapshot(undefined, undefined, config());
    const changed = config({ scopes: { selected: { kind: "model", model: "fixture/b" } } });
    const next = reconcileEconomicSnapshot(initial.snapshot, initial.policy, changed);
    assert.equal(next.snapshot.signals.length, 0);
    assert.ok(next.diagnostics.some((item) => item.code === "observation.binding_invalidated"));
    const repeated = reconcileEconomicSnapshot(next.snapshot, next.policy, changed, next.quarantinedSourceRevisions);
    assert.equal(repeated.snapshot.signals.length, 0);
    const refreshed = config({
      scopes: { selected: { kind: "model", model: "fixture/b" } },
      observations: [observation({ revision: 2, observedAt: 101, expiresAt: 2_001, windows: [{ id: "day", period: { id: "p2", sequence: 2 }, unit: "ratio", remaining: 0.4 }] })],
    });
    const accepted = reconcileEconomicSnapshot(repeated.snapshot, repeated.policy, refreshed, repeated.quarantinedSourceRevisions);
    assert.equal(accepted.snapshot.signals.length, 1);
    assert.deepEqual(accepted.quarantinedSourceRevisions, new Map());
  });

  it("quarantines changed bindings for prototype-collision source IDs until a higher revision", () => {
    for (const sourceId of ["__proto__", "constructor"]) {
      const sourceConfig = (model: string, revision = 1) => config({
        scopes: { selected: { kind: "model", model } },
        sources: [{ id: sourceId, scopeRef: "selected", authority: "declared" }],
        observations: [observation({ sourceId, revision, observedAt: 100 + revision, expiresAt: 2_000 + revision,
          windows: [{ id: "day", period: { id: `p${revision}`, sequence: revision }, unit: "ratio", remaining: 0.4 }] })],
      });
      const initial = reconcileEconomicSnapshot(undefined, undefined, sourceConfig("fixture/a"));
      assert.equal(initial.snapshot.signals.length, 1);
      const disabled = reconcileEconomicSnapshot(initial.snapshot, initial.historyPolicy, undefined, initial.quarantinedSourceRevisions);
      assert.equal(disabled.policy, undefined);

      const changed = sourceConfig("fixture/b");
      const invalidated = reconcileEconomicSnapshot(disabled.snapshot, disabled.historyPolicy, changed, disabled.quarantinedSourceRevisions);
      assert.equal(invalidated.snapshot.signals.length, 0);
      assert.equal(invalidated.quarantinedSourceRevisions.get(sourceId), 1);
      const stale = reconcileEconomicSnapshot(invalidated.snapshot, invalidated.historyPolicy, changed, invalidated.quarantinedSourceRevisions);
      assert.equal(stale.snapshot.signals.length, 0, `${sourceId} cannot relabel its old fact to the new scope`);

      const fresh = reconcileEconomicSnapshot(stale.snapshot, stale.historyPolicy, sourceConfig("fixture/b", 2), stale.quarantinedSourceRevisions);
      assert.equal(fresh.snapshot.signals.length, 1);
      assert.equal(fresh.snapshot.signals[0]?.revision, 2);
      assert.equal(fresh.quarantinedSourceRevisions.has(sourceId), false);
    }
  });
});
