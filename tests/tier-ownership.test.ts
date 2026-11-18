import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveOwnershipSnapshot, tierOwnership, type ReconciliationOwnershipSnapshot } from "../reconciliation.ts";
import { buildInitMembershipPlan, buildInitOwnershipReceipt } from "../reconciliation-command.ts";

const generated = ["p/a", "q/b"];
const ownership = buildInitOwnershipReceipt("project", { quick: generated, empty: [] })!;

describe("ordered whole-tier ownership", () => {
  it("distinguishes presence, empty placeholders, and every manual edit", () => {
    assert.equal(tierOwnership(ownership, "quick", generated), "managed");
    assert.equal(tierOwnership(ownership, "empty", []), "managed");
    for (const pool of [["p/a"], ["q/b", "p/a"], [...generated, "p/c"], [...generated, "p/a"], [], "p/a"]) {
      assert.equal(tierOwnership(ownership, "quick", pool), "user", JSON.stringify(pool));
    }
    assert.equal(tierOwnership(undefined, "quick", []), "user");
    assert.equal(tierOwnership(undefined, "quick", undefined), "absent");
    assert.equal(tierOwnership(ownership, "quick", undefined), "deleted");
    assert.equal(tierOwnership(ownership, "empty", undefined), "deleted");
  });

  it("retains human ownership across later deletion and permits explicit reset", () => {
    const edited = { quick: ["q/b", "p/a"], empty: [] };
    const user = deriveOwnershipSnapshot({ scope: "project", previous: ownership, before: edited, after: edited, managedTiers: new Set() });
    assert.deepEqual(user.tiers.quick, { state: "user" });
    const deleted = deriveOwnershipSnapshot({ scope: "project", previous: user, before: { empty: [] }, after: { empty: [] }, managedTiers: new Set() });
    assert.deepEqual(deleted.tiers.quick, { state: "deleted" });
    const restored = deriveOwnershipSnapshot({ scope: "project", previous: deleted, before: { empty: [] }, after: { quick: generated, empty: [] }, managedTiers: new Set(["quick"]) });
    assert.deepEqual(restored, ownership);
  });

  it("never trusts missing, legacy, corrupt, or wrong-scope ownership", () => {
    const configBytes = Buffer.from(JSON.stringify({ models: { quick: generated } }));
    const legacy = { version: 1, sources: { catalog: { generated: { quick: generated }, tombstones: {} } } };
    for (const [name, stored, blocked] of [
      ["missing", null, false],
      ["legacy", JSON.stringify(legacy), false],
      ["corrupt", "{broken", true],
      ["scope", JSON.stringify({ ...ownership, scope: "user" }), true],
      ["pattern", JSON.stringify({ ...ownership, tiers: { quick: { state: "generated", models: ["p/*"] } } }), true],
    ] as const) {
      const result = buildInitMembershipPlan({
        source: "project", configPath: "/fixture/config", ownershipPath: "/fixture/ownership", journalPath: "/fixture/journal",
        configBytes, ownershipBytes: stored === null ? null : Buffer.from(stored),
      }, [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new"] } }], () => true);
      assert.deepEqual(result.changes, [], name);
      if (blocked) {
        assert.equal(result.reason, "source_invalid", name);
        assert.equal(result.transaction, undefined, name);
      } else {
        assert.deepEqual(result.transaction?.nextConfigBytes, configBytes, name);
        assert.deepEqual(JSON.parse(Buffer.from(result.transaction!.nextOwnershipBytes).toString()).tiers.quick,
          { state: "user" }, name);
      }
    }
  });

  for (const [name, models, receipt] of [
    ["empty", { quick: [] }, undefined],
    ["deleted", {}, ownership],
    ["reordered", { quick: ["q/b", "p/a"] }, ownership],
    ["scalar", { quick: "p/a" }, ownership],
  ] as const) {
    it(`Keep preserves ${name} tier exactly and records intent`, () => {
      const configBytes = Buffer.from(JSON.stringify({ models, unrelated: true }, null, 4) + "\n\n");
      const plan = buildInitMembershipPlan({
        source: "project", configPath: "/fixture/config", ownershipPath: "/fixture/ownership", journalPath: "/fixture/journal",
        configBytes, ownershipBytes: receipt ? Buffer.from(JSON.stringify(receipt)) : null,
      }, [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new"] } }], () => true);
      assert.deepEqual(plan.changes, []);
      assert.ok(plan.transaction, "intent must survive restart");
      assert.deepEqual(plan.transaction.nextConfigBytes, configBytes);
      const saved = JSON.parse(Buffer.from(plan.transaction.nextOwnershipBytes).toString()) as ReconciliationOwnershipSnapshot;
      assert.equal(saved.tiers.quick?.state, name === "deleted" ? "deleted" : "user");
      const repeated = buildInitMembershipPlan({
        source: "project", configPath: "/fixture/config", ownershipPath: "/fixture/ownership", journalPath: "/fixture/journal",
        configBytes, ownershipBytes: plan.transaction.nextOwnershipBytes,
      }, [{ provider: "p", status: "complete", modelsByTier: { quick: ["p/new"] } }], () => true);
      assert.deepEqual(repeated.changes, []);
      assert.equal(repeated.transaction, undefined);
    });
  }
});
