import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDispatchOwnership, type DispatchOwnershipDeps } from "../runtime-reliability.ts";

/** Fake half-open trial store with per-model trialActive bookkeeping. */
function fakeStore(): DispatchOwnershipDeps & { active: Set<string>; released: string[]; abandoned: string[] } {
  const active = new Set<string>();
  const released: string[] = [];
  const abandoned: string[] = [];
  return {
    active,
    released,
    abandoned,
    claimTrial: (key) => {
      if (active.has(key)) return { allowed: false, claimed: false };
      active.add(key);
      return { allowed: true, claimed: true };
    },
    abandonTrial: (key) => {
      active.delete(key);
      abandoned.push(key);
    },
    begin: () => {},
    release: (key) => released.push(key),
  };
}

describe("dispatch ownership", () => {
  it("releases only the bookkeeping this dispatch owns (P1 shape: overlapping dispatches on one model)", () => {
    const store = fakeStore();
    const a = createDispatchOwnership(store);
    const b = createDispatchOwnership(store);
    a.claim("m", "select");
    // B contends the same model's trial: select is fail-closed.
    assert.throws(() => b.claim("m", "select"), /half-open trial unavailable for m/);
    b.fail("m");
    // B owned nothing — A's claim and bookkeeping must survive.
    assert.deepEqual(store.released, []);
    assert.deepEqual(store.abandoned, []);
    assert.ok(store.active.has("m"));
    a.fail("m");
    assert.deepEqual(store.released, ["m"]);
    assert.deepEqual(store.abandoned, ["m"]);
  });

  it("lets sticky and degrade proceed under trial contention (continuity exemption)", () => {
    const store = fakeStore();
    const owner = createDispatchOwnership(store);
    owner.claim("m", "select");
    const sticky = createDispatchOwnership(store);
    assert.deepEqual(sticky.claim("m", "sticky"), { allowed: false, claimed: false });
    const degrade = createDispatchOwnership(store);
    assert.deepEqual(degrade.claim("m", "degrade"), { allowed: false, claimed: false });
    // Continuity dispatches claimed nothing and fail() must not steal A's claim.
    sticky.fail("m");
    degrade.fail("m");
    assert.deepEqual(store.abandoned, []);
    assert.ok(store.active.has("m"));
  });

  it("records owned claims and releases them on failure", () => {
    const store = fakeStore();
    const ownership = createDispatchOwnership(store);
    const seen: boolean[] = [];
    ownership.claim("m", "select", (trial) => seen.push(trial.claimed));
    assert.deepEqual(seen, [true]);
    ownership.fail("m");
    assert.deepEqual(store.abandoned, ["m"]);
    // Double-fail is a no-op.
    ownership.fail("m");
    assert.deepEqual(store.abandoned, ["m"]);
    assert.deepEqual(store.released, ["m"]);
  });
});
