import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provesNativeRetryLineage, type RetryLineageFact } from "../failover.ts";
import { resolveConfiguredTier } from "../routing.ts";
import { makeCtx, makeModel } from "./helpers.ts";

const failure = (id: string, model: string, matchesLatest: boolean): RetryLineageFact => ({ kind: "failure", id, model, matchesLatest });
const omission = (target: string): RetryLineageFact => ({ kind: "omission", target });

describe("native failover decision", () => {
  it("proves one exact omission per attempted model in order", () => {
    assert.equal(provesNativeRetryLineage([failure("a", "p/a", true), omission("a")], ["p/a"]), true);
    assert.equal(provesNativeRetryLineage([failure("a", "p/a", false), omission("a"), failure("b", "p/b", true), omission("b")], ["p/a", "p/b"]), true);
  });
  it("rejects missing, duplicate, unrelated, out-of-order and nonempty/compaction facts", () => {
    const a = failure("a", "p/a", true);
    const invalid: RetryLineageFact[][] = [[], [a], [a, omission("other")], [omission("a"), a], [a, { kind: "other" }], [failure("a", "p/b", true), omission("a")], [failure("a", "p/a", false), omission("a")], [a, omission("a"), { kind: "other" }]];
    for (const facts of invalid) assert.equal(provesNativeRetryLineage(facts, ["p/a"]), false);
    assert.equal(provesNativeRetryLineage([a, omission("a"), a, omission("a")], ["p/a", "p/a"]), false);
  });
  it("excludes attempted candidates through strict fallback and affinity without circuit mutation", () => {
    const ctx = makeCtx([makeModel("p", "a"), makeModel("p", "b"), makeModel("p", "c")]);
    const config = { schemaVersion: 2, default: "general", strategy: "first" as const,
      models: { quick: ["p/a"], general: ["p/a", "p/b", "p/c"] },
      tierPolicies: { quick: { fallbackTiers: ["general"] } }, affinity: { mode: "retain-within-tier" as const } };
    const affinity = { targetOrigin: "automatic", anchor: { modelKey: "p/a", provider: "p", lastSuccessfulDispatchAt: 1 } };
    const select = (excluded: string[]) => resolveConfiguredTier(ctx, "quick", config, undefined, undefined, 100, undefined, undefined, affinity, undefined, new Set(excluded)).resolution;
    assert.equal(select([]).selected?.id, "a");
    assert.equal(select(["p/a"]).selected?.id, "b");
    assert.equal(select(["p/a", "p/b"]).selected?.id, "c");
    const exhausted = select(["p/a", "p/b", "p/c"]);
    assert.equal(exhausted.selected, undefined);
    assert.equal(exhausted.fallbackReason, "request_candidates_exhausted");
    assert.ok(exhausted.skipped.every(e => e.reason === "request_attempted"));
  });
});
