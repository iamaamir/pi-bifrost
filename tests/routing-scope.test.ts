// ── Provider routing scope unit tests ────────────────────────────
// The scope module is pure: it compiles configured allowlists,
// answers exact provider eligibility, and composes layers by
// intersection. These tests pin the fail-closed edge cases.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkProviderScope,
  compileRoutingScope,
  mergeRoutingScope,
  mergeRoutingScopeConflicts,
  routingScopeConflicts,
  type RoutingScope,
} from "../routing-scope.ts";

describe("routing scope", () => {
  describe("compileRoutingScope", () => {
    it("returns undefined so absent restrictions keep the fast path", () => {
      assert.equal(compileRoutingScope(undefined), undefined);
      assert.equal(compileRoutingScope({}), undefined);
      assert.equal(compileRoutingScope({ tiers: {} }), undefined);
    });

    it("compiles global and tier allowlists into sets", () => {
      const compiled = compileRoutingScope({
        providers: ["anthropic", "openai-codex"],
        tiers: { quick: { providers: ["openai-codex"] } },
      });
      assert.ok(compiled);
      assert.equal(compiled?.global?.has("anthropic"), true);
      assert.equal(compiled?.global?.has("openai"), false);
      assert.equal(compiled?.tiers.get("quick")?.has("openai-codex"), true);
      assert.equal(compiled?.tiers.get("quick")?.has("anthropic"), false);
    });

    it("treats a present but empty allowlist as deny-all", () => {
      const compiled = compileRoutingScope({ providers: [] });
      assert.ok(compiled);
      assert.equal(compiled?.global?.size, 0);
      assert.equal(checkProviderScope(compiled, "anthropic").allowed, false);
    });

    it("fails closed when an allowlist is malformed at compile time", () => {
      const compiled = compileRoutingScope({ providers: "anthropic" as unknown as string[] });
      assert.ok(compiled);
      assert.equal(checkProviderScope(compiled, "anthropic").allowed, false);
    });

    it("fails closed when only part of an allowlist is malformed", () => {
      const providers = ["anthropic", 7] as unknown as string[];
      const compiled = compileRoutingScope({ providers, tiers: { quick: { providers } } });
      assert.ok(compiled);
      // One bad entry denies the whole list; it does not keep "anthropic".
      assert.equal(checkProviderScope(compiled, "anthropic").allowed, false);
      assert.equal(checkProviderScope(compiled, "anthropic", { tier: "quick" }).allowed, false);
    });
  });

  describe("checkProviderScope", () => {
    it("allows everything when no scope is compiled", () => {
      assert.deepEqual(checkProviderScope(undefined, "anthropic"), { allowed: true });
    });

    it("rejects a provider outside the global allowlist", () => {
      const scope = compileRoutingScope({ providers: ["anthropic"] });
      assert.deepEqual(checkProviderScope(scope, "openai"), { allowed: false, origin: "global" });
      assert.deepEqual(checkProviderScope(scope, "anthropic"), { allowed: true });
    });

    it("rejects a provider outside the evaluated tier allowlist", () => {
      const scope = compileRoutingScope({
        tiers: { quick: { providers: ["anthropic"] }, slow: { providers: ["openai"] } },
      });
      assert.deepEqual(
        checkProviderScope(scope, "openai", { tier: "quick" }),
        { allowed: false, origin: "tier" },
      );
      assert.deepEqual(checkProviderScope(scope, "anthropic", { tier: "quick" }), { allowed: true });
    });

    it("applies only the evaluated tier's allowlist, never another tier's", () => {
      const scope = compileRoutingScope({
        tiers: { quick: { providers: ["anthropic"] }, slow: { providers: ["anthropic"] } },
      });
      // The evaluated pool always uses its own tier scope.
      assert.deepEqual(checkProviderScope(scope, "openai", { tier: "slow" }), { allowed: false, origin: "tier" });
      // A tier without a scope entry adds no restriction beyond the global scope.
      assert.deepEqual(checkProviderScope(scope, "openai", { tier: "unknown" }), { allowed: true });
    });

    it("matches provider ids exactly without case folding or substring hits", () => {
      const scope = compileRoutingScope({ providers: ["Anthropic"] });
      assert.equal(checkProviderScope(scope, "Anthropic").allowed, true);
      assert.equal(checkProviderScope(scope, "anthropic").allowed, false);
      assert.equal(checkProviderScope(scope, "AnthropicExtra").allowed, false);
      assert.equal(checkProviderScope(scope, "Anthro").allowed, false);
    });

    it("requires both global and tier allowlists", () => {
      const scope = compileRoutingScope({
        providers: ["anthropic", "openai"],
        tiers: { quick: { providers: ["openai"] } },
      });
      assert.deepEqual(
        checkProviderScope(scope, "anthropic", { tier: "quick" }),
        { allowed: false, origin: "tier" },
      );
      assert.equal(checkProviderScope(scope, "openai", { tier: "quick" }).allowed, true);
    });
  });

  describe("mergeRoutingScope", () => {
    it("returns the other layer untouched when one side is absent", () => {
      const scope: RoutingScope = { providers: ["anthropic"] };
      assert.deepEqual(mergeRoutingScope(undefined, scope), scope);
      assert.deepEqual(mergeRoutingScope(scope, undefined), scope);
      assert.equal(mergeRoutingScope(undefined, undefined), undefined);
    });

    it("intersects global allowlists so a later layer can only narrow", () => {
      assert.deepEqual(
        mergeRoutingScope({ providers: ["anthropic", "openai"] }, { providers: ["openai", "google"] }),
        { providers: ["openai"] },
      );
    });

    it("treats an explicit empty allowlist as deny-all during merge", () => {
      assert.deepEqual(mergeRoutingScope({ providers: ["anthropic"] }, { providers: [] }), { providers: [] });
      assert.deepEqual(mergeRoutingScope({ providers: [] }, { providers: ["anthropic"] }), { providers: [] });
    });

    it("intersects matching tiers and keeps tiers introduced by either layer", () => {
      assert.deepEqual(
        mergeRoutingScope(
          { tiers: { quick: { providers: ["anthropic", "openai"] }, slow: { providers: ["anthropic"] } } },
          { tiers: { quick: { providers: ["openai"] }, deep: { providers: ["google"] } } },
        ),
        {
          tiers: {
            quick: { providers: ["openai"] },
            slow: { providers: ["anthropic"] },
            deep: { providers: ["google"] },
          },
        },
      );
    });

    it("merges global and tier restrictions independently", () => {
      assert.deepEqual(
        mergeRoutingScope(
          { providers: ["anthropic", "openai"], tiers: { quick: { providers: ["openai"] } } },
          { providers: ["openai"], tiers: { quick: { providers: ["anthropic", "openai"] } } },
        ),
        { providers: ["openai"], tiers: { quick: { providers: ["openai"] } } },
      );
    });
  });

  describe("mergeRoutingScopeConflicts", () => {
    it("reports disjoint nonempty allowlists as a composition conflict", () => {
      assert.deepEqual(
        mergeRoutingScopeConflicts({ providers: ["anthropic"] }, { providers: ["openai"] }),
        ["routingScope.providers conflicts with a lower configuration layer; the provider allowlists do not intersect."],
      );
    });

    it("reports a disjoint tier allowlist but ignores intentional deny-all", () => {
      assert.deepEqual(
        mergeRoutingScopeConflicts(
          { tiers: { quick: { providers: ["anthropic"] } } },
          { tiers: { quick: { providers: ["openai"] } } },
        ),
        ["routingScope.tiers.quick.providers conflicts with a lower configuration layer; the provider allowlists do not intersect."],
      );
      assert.deepEqual(mergeRoutingScopeConflicts({ providers: ["anthropic"] }, { providers: [] }), []);
      assert.deepEqual(mergeRoutingScopeConflicts({ providers: [] }, { providers: ["anthropic"] }), []);
    });

    it("reports nothing for overlapping or absent layers", () => {
      assert.deepEqual(mergeRoutingScopeConflicts({ providers: ["anthropic", "openai"] }, { providers: ["openai"] }), []);
      assert.deepEqual(mergeRoutingScopeConflicts(undefined, { providers: ["openai"] }), []);
      assert.deepEqual(mergeRoutingScopeConflicts({ providers: ["openai"] }, undefined), []);
    });
  });

  describe("routingScopeConflicts", () => {
    it("reports a tier allowlist disjoint from the global allowlist", () => {
      assert.deepEqual(
        routingScopeConflicts({ providers: ["anthropic"], tiers: { quick: { providers: ["openai"] } } }),
        ['routingScope.providers and routingScope.tiers.quick.providers do not intersect; no provider is allowed for tier "quick".'],
      );
    });

    it("accepts a tier that narrows the global allowlist", () => {
      assert.deepEqual(routingScopeConflicts({ providers: ["anthropic", "openai"], tiers: { quick: { providers: ["openai"] } } }), []);
    });

    it("ignores empty or absent global and tier allowlists", () => {
      assert.deepEqual(routingScopeConflicts({ tiers: { quick: { providers: ["openai"] } } }), []);
      assert.deepEqual(routingScopeConflicts({ providers: [] }), []);
      assert.deepEqual(routingScopeConflicts({ providers: ["anthropic"], tiers: { quick: { providers: [] } } }), []);
      assert.deepEqual(routingScopeConflicts(undefined), []);
    });
  });
});
