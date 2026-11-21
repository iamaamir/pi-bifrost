import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInitActionPlan, buildInitOwnershipReceipt } from "../reconciliation-command.ts";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const source = (models: Record<string, unknown>, receipt: unknown = null) => ({
  source: "project" as const, configPath: "/config", ownershipPath: "/ownership", journalPath: "/journal",
  configBytes: bytes({ models, custom: { keep: true } }), ownershipBytes: receipt ? bytes(receipt) : null,
});
const baseline = { quick: ["p/new", "p/old"], general: ["p/g"] };
const inventory = [{ provider: "p", status: "complete" as const, modelsByTier: baseline }];
const plan = (action: "keep" | "merge" | "defaults", input: ReturnType<typeof source>, inherited: string[] = [], inheritedPools = new Map<string, readonly string[]>()) =>
  buildInitActionPlan({ action, source: input, inventories: inventory, generated: baseline, inheritedTiers: new Set(inherited), inheritedPools, validateMergedConfig: () => true });
const config = (value: ReturnType<typeof plan>) => JSON.parse(Buffer.from(value.transaction!.nextConfigBytes).toString());
const receipt = (value: ReturnType<typeof plan>) => JSON.parse(Buffer.from(value.transaction!.nextOwnershipBytes).toString());

describe("init action planner", () => {
  it("accepts realistic model identifiers and rejects control characters", () => {
    const key = "openai/gpt-6.1-terra";
    const input = { action: "defaults" as const, source: source({}), inventories: [{ provider: "openai", status: "complete" as const, modelsByTier: { quick: [key] } }], generated: { quick: [key] }, inheritedTiers: new Set<string>(), validateMergedConfig: () => true };
    assert.equal(buildInitActionPlan(input).status, "ready");
    const invalid = "openai/gpt\n6";
    assert.equal(buildInitActionPlan({ ...input, inventories: [{ provider: "openai", status: "complete", modelsByTier: { quick: [invalid] } }], generated: { quick: [invalid] } }).status, "blocked");
  });
  it("keeps edited tiers, merges in order, and resets only generated targets", () => {
    const input = source({ quick: ["p/old", "manual/x"], custom: ["manual/y"] });
    assert.deepEqual(config(plan("keep", input)).models.quick, ["p/old", "manual/x"]);
    const merge = plan("merge", input);
    assert.deepEqual(config(merge).models.quick, ["p/old", "manual/x", "p/new"]);
    assert.deepEqual(receipt(merge).tiers.quick, { state: "user" });
    const reset = plan("defaults", input);
    assert.deepEqual(config(reset).models, { quick: baseline.quick, custom: ["manual/y"], general: baseline.general });
    assert.deepEqual(config(reset).custom, { keep: true });
    assert.deepEqual(receipt(reset).tiers.quick, { state: "generated", models: baseline.quick });
  });
  it("preserves empty and deleted intent in keep and merge but permits explicit reset", () => {
    const old = buildInitOwnershipReceipt("project", { quick: ["p/old"], general: ["p/g"] });
    const input = source({ quick: [] }, old);
    for (const action of ["keep", "merge"] as const) {
      const value = plan(action, input);
      assert.deepEqual(config(value).models, { quick: [] });
      assert.deepEqual(receipt(value).tiers.general, { state: "deleted" });
    }
    assert.deepEqual(config(plan("defaults", input)).models, baseline);
  });
  it("does not freeze inherited tiers except on explicit defaults", () => {
    const input = source({ custom: ["manual/x"] });
    for (const action of ["keep", "merge"] as const) {
      const value = plan(action, input, ["quick"]);
      assert.equal(Object.hasOwn(config(value).models, "quick"), false);
    }
    const defaults = plan("defaults", input, ["quick"]);
    assert.deepEqual(config(defaults).models.quick, baseline.quick);
    assert.deepEqual(receipt(defaults).tiers.quick, { state: "generated", models: baseline.quick });
  });
  it("keeps a refreshed generated tier under generated ownership", () => {
    const old = buildInitOwnershipReceipt("project", { quick: ["p/old"] });
    const value = plan("keep", source({ quick: ["p/old"] }, old));
    assert.deepEqual(config(value).models.quick, ["p/old", "p/new"]);
    assert.deepEqual(receipt(value).tiers.quick, { state: "generated", models: ["p/old", "p/new"] });
  });
  it("blocks incomplete inventories and zero successful probes", () => {
    const input = source({ quick: ["p/old"] });
    for (const inventories of [
      [{ provider: "p", status: "stale" as const, modelsByTier: baseline }],
      [{ provider: "p", status: "partial" as const, modelsByTier: baseline }],
      [{ provider: "p", status: "auth_failed" as const, modelsByTier: baseline }],
      [],
      [{ provider: "p", status: "complete" as const, modelsByTier: {} }],
    ]) {
      const value = buildInitActionPlan({ action: "defaults", source: input, inventories, generated: baseline, inheritedTiers: new Set(), validateMergedConfig: () => true });
      assert.equal(value.status, "blocked");
      assert.equal(value.transaction, undefined);
    }
    const unprobed = buildInitActionPlan({ action: "defaults", source: input, inventories: [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/old"] } }], generated: { quick: ["p/unprobed"] }, inheritedTiers: new Set(), validateMergedConfig: () => true });
    assert.equal(unprobed.status, "blocked");
  });

  it("keeps legacy tiers user-owned and preserves exact config bytes for ownership-only reset", () => {
    const exact = Buffer.from('{\n  "models": { "quick": ["p/new", "p/old"] },\n  "setting": true\n}\n\n');
    const legacy = buildInitActionPlan({ action: "keep", source: { ...source({}), configBytes: exact }, inventories: [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new", "p/old"] } }], generated: { quick: ["p/new", "p/old"] }, inheritedTiers: new Set(), validateMergedConfig: () => true });
    assert.equal(legacy.status, "ready");
    assert.deepEqual(legacy.transaction!.nextConfigBytes, exact);
    assert.deepEqual(receipt(legacy).tiers.quick, { state: "user" });

    const owned = buildInitActionPlan({ action: "defaults", source: { ...source({}), configBytes: exact }, inventories: [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new", "p/old"] } }], generated: { quick: ["p/new", "p/old"] }, inheritedTiers: new Set(), validateMergedConfig: () => true });
    assert.equal(owned.status, "ready");
    assert.deepEqual(owned.changes, []);
    assert.deepEqual(owned.transaction!.nextConfigBytes, exact);
    assert.deepEqual(receipt(owned).tiers.quick, { state: "generated", models: ["p/new", "p/old"] });
  });

  it("returns exact ordered per-tier preview and leaves protected inherited tiers alone", () => {
    const input = source({ quick: ["p/old", "manual/x"] });
    const value = buildInitActionPlan({
      action: "merge", source: input,
      inventories: [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new", "p/old"] } }],
      generated: { quick: ["p/new", "p/old", "p/new"] },
      inheritedTiers: new Set(["frontier"]), validateMergedConfig: () => true,
    });
    assert.equal(value.status, "ready", JSON.stringify(value));
    assert.deepEqual(config(value).models.quick, ["p/old", "manual/x", "p/new"]);
    assert.deepEqual(value.changes, [{ kind: "add", disposition: "apply", tier: "quick", modelKey: "p/new" }]);
    assert.deepEqual(value.tiers.find(({ tier }) => tier === "quick"), {
      tier: "quick", before: ["p/old", "manual/x"], after: ["p/old", "manual/x", "p/new"], ownershipBefore: "user", ownershipAfter: "user",
    });
    const defaults = buildInitActionPlan({
      action: "defaults", source: input,
      inventories: [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new", "p/old"] } }],
      generated: { quick: ["p/new", "p/old", "p/new"] }, inheritedTiers: new Set(), validateMergedConfig: () => true,
    });
    assert.deepEqual(config(defaults).models.quick, ["p/new", "p/old"]);
  });

  it("previews retained custom/deleted tiers and saves their ownership on Keep", () => {
    const ownership = {
      version: 2, scope: "project",
      tiers: { custom: { state: "user" }, deleted: { state: "deleted" } },
    };
    const value = plan("keep", source({ custom: ["manual/x"] }, ownership));
    assert.equal(value.status, "ready");
    assert.deepEqual(value.tiers.find(({ tier }) => tier === "custom"), {
      tier: "custom", before: ["manual/x"], after: ["manual/x"], ownershipBefore: "user", ownershipAfter: "user",
    });
    assert.deepEqual(value.tiers.find(({ tier }) => tier === "deleted"), {
      tier: "deleted", before: undefined, after: undefined, ownershipBefore: "deleted", ownershipAfter: "deleted",
    });
    assert.deepEqual(receipt(value).tiers.custom, { state: "user" });
    assert.deepEqual(receipt(value).tiers.deleted, { state: "deleted" });
    assert.deepEqual(config(value).models.custom, ["manual/x"]);
    assert.deepEqual(value.tiers.find(({ tier }) => tier === "deleted")?.after, undefined);
  });

  it("does not freeze identical inherited pools on Defaults, but restores deleted tiers explicitly", () => {
    const inheritedPools = new Map([["quick", baseline.quick]]);
    const input = source({ general: ["manual/local"] });
    const defaults = plan("defaults", input, ["quick"], inheritedPools);
    assert.deepEqual(config(defaults).models, { general: baseline.general });
    assert.equal(Object.hasOwn(config(defaults).models, "quick"), false);
    assert.deepEqual(receipt(defaults).tiers.quick, undefined);

    const ownership = { version: 2, scope: "project", tiers: { quick: { state: "deleted" } } };
    const restored = plan("defaults", source({ general: ["manual/local"] }, ownership), ["quick"], inheritedPools);
    assert.deepEqual(config(restored).models.quick, baseline.quick);
    assert.deepEqual(receipt(restored).tiers.quick, { state: "generated", models: baseline.quick });
  });

  it("preserves empty and deleted pools on Merge while Defaults restores ownership", () => {
    const old = buildInitOwnershipReceipt("project", { quick: ["p/old"], general: ["p/g"] });
    const input = source({ quick: [], general: ["p/g"] }, old);
    assert.deepEqual(config(plan("merge", input)).models, { quick: [], general: ["p/g"] });
    const reset = plan("defaults", input);
    assert.deepEqual(config(reset).models, baseline);
    assert.deepEqual(receipt(reset).tiers.quick, { state: "generated", models: baseline.quick });
  });
});
