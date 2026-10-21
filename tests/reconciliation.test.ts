import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proposeReconciliation, type ReconciliationInput, type ReconciliationOwnershipSnapshot } from "../reconciliation.ts";

function base(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    configDigest: "cfg-digest-01",
    ownershipRevision: null,
    configuredModels: {},
    inventory: {
      sourceId: "catalog-main",
      revision: "registry-rev-01",
      status: "complete",
      enabled: true,
      modelsByTier: { general: ["openai/gpt-5.4", "anthropic/sonnet"] },
    },
    ...overrides,
  };
}

function ownership(generated: Record<string, string[]>, tombstones: Record<string, string[]> = {}): ReconciliationOwnershipSnapshot {
  return {
    version: 1,
    sources: {
      "catalog-main": { generated, tombstones },
    },
  };
}

describe("pure generated-membership reconciliation", () => {
  it("proposes exact additions and claims only values it would create", () => {
    const result = proposeReconciliation(base());
    assert.equal(result.status, "ready");
    assert.deepEqual(result.changes, [
      { kind: "add", disposition: "apply", tier: "general", modelKey: "openai/gpt-5.4" },
      { kind: "add", disposition: "apply", tier: "general", modelKey: "anthropic/sonnet" },
    ]);
    assert.deepEqual(result.ownershipChanges, [
      { kind: "claim", tier: "general", modelKey: "openai/gpt-5.4" },
      { kind: "claim", tier: "general", modelKey: "anthropic/sonnet" },
    ]);
    assert.equal(result.expectedConfigDigest, "cfg-digest-01");
    assert.equal(result.expectedOwnershipRevision, null);
    assert.equal(JSON.stringify(result).includes("configuredModels"), false);
  });

  it("preserves existing manual entries and never claims an unowned exact match", () => {
    const result = proposeReconciliation(base({
      configuredModels: { general: ["manual/model", "openai/gpt-5.4"] },
    }));
    assert.deepEqual(result.changes, [
      { kind: "add", disposition: "apply", tier: "general", modelKey: "anthropic/sonnet" },
    ]);
    assert.deepEqual(result.ownershipChanges, [
      { kind: "claim", tier: "general", modelKey: "anthropic/sonnet" },
    ]);
    assert.ok(result.warnings.includes("manual_entry_collision"));
  });

  it("does not alias broad handwritten patterns into generated exact membership", () => {
    const result = proposeReconciliation(base({ configuredModels: { general: ["openai/*"] } }));
    assert.deepEqual(result.changes.map(({ modelKey }) => modelKey), ["openai/gpt-5.4", "anthropic/sonnet"]);
    assert.equal(result.changes.some(({ modelKey }) => modelKey === "openai/*"), false);
  });

  it("makes incomplete, stale, and auth-failed additions advisory and suppresses removals", () => {
    const owner = ownership({ general: ["openai/gpt-5.4", "openai/retired"] });
    for (const status of ["partial", "stale", "auth_failed"] as const) {
      const result = proposeReconciliation(base({
        ownership: owner,
        ownershipRevision: "owner-rev-02",
        configuredModels: { general: ["openai/gpt-5.4", "openai/retired"] },
        inventory: {
          sourceId: "catalog-main",
          revision: "registry-rev-02",
          status,
          enabled: true,
          modelsByTier: { general: ["openai/gpt-5.4", "anthropic/new"] },
        },
      }));
      assert.equal(result.status, "advisory");
      assert.deepEqual(result.changes, [
        { kind: "add", disposition: "advisory", tier: "general", modelKey: "anthropic/new" },
      ]);
      assert.deepEqual(result.ownershipChanges, []);
      assert.ok(result.warnings.includes("removal_suppressed"));
    }
  });

  it("tombstones a user-removed owned model so it is not re-added", () => {
    const result = proposeReconciliation(base({
      ownership: ownership({ general: ["openai/gpt-5.4"] }),
      ownershipRevision: "owner-rev-03",
      configuredModels: { general: [] },
      inventory: {
        sourceId: "catalog-main",
        revision: "registry-rev-04",
        status: "complete",
        enabled: true,
        modelsByTier: { general: ["openai/gpt-5.4"] },
      },
    }));
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.ownershipChanges, [
      { kind: "unclaim", tier: "general", modelKey: "openai/gpt-5.4" },
      { kind: "tombstone", tier: "general", modelKey: "openai/gpt-5.4" },
    ]);
    assert.ok(result.warnings.includes("user_removal_tombstoned"));
  });

  it("tombstones missing owned values even when absent from inventory, disabled, or incomplete", () => {
    const cases: Array<{ status: "complete" | "partial"; enabled: boolean; modelsByTier: Record<string, string[]> }> = [
      { status: "complete", enabled: true, modelsByTier: {} },
      { status: "complete" as const, enabled: false, modelsByTier: {} },
      { status: "partial", enabled: true, modelsByTier: {} },
    ];
    for (const inventory of cases) {
      const result = proposeReconciliation(base({
        ownership: ownership({ general: ["openai/removed"] }),
        ownershipRevision: "owner-rev-05",
        configuredModels: {},
        inventory: {
          sourceId: "catalog-main",
          revision: "registry-rev-missing",
          ...inventory,
        },
      }));
      assert.deepEqual(result.changes, []);
      assert.deepEqual(result.ownershipChanges, [
        { kind: "unclaim", tier: "general", modelKey: "openai/removed" },
        { kind: "tombstone", tier: "general", modelKey: "openai/removed" },
      ]);
      assert.ok(result.warnings.includes("user_removal_tombstoned"));
    }
  });

  it("does not claim a source collision with a handwritten value", () => {
    const result = proposeReconciliation(base({
      configuredModels: { general: ["openai/gpt-5.4"] },
      inventory: {
        sourceId: "new-catalog",
        revision: "rev-new",
        status: "complete",
        enabled: true,
        modelsByTier: { general: ["openai/gpt-5.4"] },
      },
    }));
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.ownershipChanges, []);
    assert.ok(result.warnings.includes("manual_entry_collision"));
    assert.ok(result.warnings.includes("ownership_uninitialized"));
  });

  it("disabling a generated source removes only its exact owned values when inventory is complete", () => {
    const result = proposeReconciliation(base({
      ownership: ownership({ general: ["openai/gpt-5.4", "openai/retired"] }),
      ownershipRevision: "owner-rev-04",
      configuredModels: { general: ["manual/model", "openai/gpt-5.4", "openai/retired"] },
      inventory: {
        sourceId: "catalog-main",
        revision: "registry-rev-05",
        status: "complete",
        enabled: false,
        modelsByTier: {},
      },
    }));
    assert.deepEqual(result.changes, [
      { kind: "remove", disposition: "apply", tier: "general", modelKey: "openai/gpt-5.4" },
      { kind: "remove", disposition: "apply", tier: "general", modelKey: "openai/retired" },
    ]);
    assert.deepEqual(result.ownershipChanges, [
      { kind: "unclaim", tier: "general", modelKey: "openai/gpt-5.4" },
      { kind: "unclaim", tier: "general", modelKey: "openai/retired" },
    ]);
  });

  it("does not delete memberships when a disabled source has incomplete inventory", () => {
    const result = proposeReconciliation(base({
      ownership: ownership({ general: ["openai/gpt-5.4"] }),
      configuredModels: { general: ["openai/gpt-5.4"] },
      inventory: {
        sourceId: "catalog-main",
        revision: "rev-partial-disable",
        status: "partial",
        enabled: false,
        modelsByTier: {},
      },
    }));
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.ownershipChanges, []);
    assert.ok(result.warnings.includes("removal_suppressed"));
  });

  it("rejects malformed inventory without echoing private values and leaves inputs untouched", () => {
    const privateSentinel = { sourceId: "PRIVATE_CONFIG_SECRET_SENTINEL" };
    const input = base({
      configuredModels: { general: ["handwritten/pattern"] },
      inventory: {
        sourceId: "catalog-main",
        revision: "rev-invalid",
        status: "complete",
        enabled: true,
        modelsByTier: { general: ["invalid model"] },
      },
    });
    const result = proposeReconciliation(input);
    assert.equal(result.status, "invalid");
    assert.equal(JSON.stringify(result).includes("invalid model"), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_CONFIG_SECRET_SENTINEL"), false);
    assert.equal(Object.isFrozen(input.configuredModels), false);
    assert.deepEqual(privateSentinel, { sourceId: "PRIVATE_CONFIG_SECRET_SENTINEL" });
  });

  it("rejects duplicate exact ownership claims across sources before proposing removal", () => {
    const conflictingOwnership: ReconciliationOwnershipSnapshot = {
      version: 1,
      sources: {
        "catalog-main": { generated: { general: ["openai/gpt-5.4"] }, tombstones: {} },
        "catalog-other": { generated: { general: ["openai/gpt-5.4"] }, tombstones: {} },
      },
    };
    const result = proposeReconciliation(base({
      ownership: conflictingOwnership,
      ownershipRevision: "owner-corrupt",
      configuredModels: { general: ["openai/gpt-5.4"] },
      inventory: {
        sourceId: "catalog-main",
        revision: "complete-rev",
        status: "complete",
        enabled: false,
        modelsByTier: {},
      },
    }));
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.ownershipChanges, []);
  });
});
