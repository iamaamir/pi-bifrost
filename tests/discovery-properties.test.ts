import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { Api, Model } from "@earendil-works/pi-ai";
import { findCandidates, findOneModel } from "../routing.ts";
import { makeCtx, makeModel } from "./helpers.ts";

// Reference inputs deliberately include collisions, case variants and nested IDs.
// No production key, matching or model-kind helper participates in the oracle.
type Entry = { provider: string; id: string; kind: "chat" | "virtual" | "classifier" };
const entry = fc.record({
  provider: fc.constantFrom("North", "north", "south", "shared"),
  id: fc.constantFrom("alpha", "ALPHA", "shared", "family/alpha", "family/alpha/v2"),
  kind: fc.constantFrom<Entry["kind"]>("chat", "virtual", "classifier"),
});
const catalog = fc.uniqueArray(entry, {
  selector: (item) => JSON.stringify([item.provider, item.id]), maxLength: 18,
});
const pattern = fc.constantFrom("", "a", "ALPHA", "north", "shared", "missing", "North/alpha", "north/ALPHA", "south/family/alpha", "south/family/alpha/v2", "North/", "/alpha");
const patterns = fc.array(pattern, { maxLength: 12 });
const options = {
  numRuns: 500,
  ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
};

function modelsOf(entries: Entry[]): Model<Api>[] {
  return entries.map(({ provider, id, kind }) => {
    const model = makeModel(provider, id);
    if (kind === "virtual") model.api = "pi-virtual" as Api;
    if (kind === "classifier") Object.assign(model, { type: "classifier" });
    return model;
  });
}

// Compute independent buckets, then retain each identity's first occurrence.
function expectedIndices(entries: Entry[], requested: string[]): number[] {
  const expanded = requested.flatMap((query) => {
    const slash = query.indexOf("/");
    if (slash >= 0) {
      const index = entries.findIndex((item) => item.provider === query.slice(0, slash) && item.id === query.slice(slash + 1));
      return index >= 0 && entries[index].kind === "chat" ? [index] : [];
    }
    return entries.flatMap((item, index) => item.kind === "chat" &&
      [item.provider, item.id].some((value) => value.toLowerCase().indexOf(query.toLowerCase()) >= 0) ? [index] : []);
  });
  return expanded.filter((index, position) => expanded.indexOf(index) === position);
}

function assertPool(entries: Entry[], requested: string[]): void {
  const models = modelsOf(entries);
  const actual = findCandidates(makeCtx(models), requested);
  const expected = expectedIndices(entries, requested);
  assert.equal(actual.length, expected.length);
  expected.forEach((index, position) => assert.equal(actual[position], models[index]));
}

describe("independent catalog discovery properties", () => {
  it("matches independent ordered expansion, exact identities and kind exclusion", () => {
    fc.assert(fc.property(catalog, patterns, assertPool), options);
  });

  it("always exercises positive overlaps, same-ID providers and forbidden kinds", () => {
    fc.assert(fc.property(fc.shuffledSubarray(["North", "south", "shared"], { minLength: 3, maxLength: 3 }), (providers) => {
      const entries: Entry[] = providers.flatMap((provider) => [
        { provider, id: "alpha", kind: "chat" },
        { provider, id: "family/alpha", kind: "chat" },
        { provider, id: "virtual-alpha", kind: "virtual" },
        { provider, id: "classifier-alpha", kind: "classifier" },
      ]);
      // Exact selection precedes catalog-order substring expansion; repetitions
      // must neither duplicate identities nor collapse distinct providers.
      assertPool(entries, [`${providers[2]}/family/alpha`, "ALPHA", "", "alpha", `${providers[0]}/alpha`]);
    }), options);
  });

  it("single lookup treats qualified IDs exactly and substring lookup case-insensitively", () => {
    fc.assert(fc.property(catalog, pattern, (entries, query) => {
      const models = modelsOf(entries);
      const expected = query === "" ? undefined : expectedIndices(entries, [query])[0];
      assert.equal(findOneModel(makeCtx(models), query), expected === undefined ? undefined : models[expected]);
    }), options);
  });

  it("refresh uses replacement snapshot and returns its objects, not cached identities", () => {
    fc.assert(fc.property(catalog, catalog, patterns, (before, after, queries) => {
      const available = modelsOf(before);
      const ctx = makeCtx(available);
      ctx.modelRegistry.getAvailable = () => available.slice();
      findCandidates(ctx, queries);
      const replacement = modelsOf(after);
      available.splice(0, available.length, ...replacement);
      const actual = findCandidates(ctx, queries);
      const expected = expectedIndices(after, queries);
      assert.equal(actual.length, expected.length);
      expected.forEach((index, position) => assert.equal(actual[position], replacement[index]));
    }), options);
  });

  it("distinguishes absent input from an explicit match-all empty pattern", () => {
    fc.assert(fc.property(catalog, (entries) => {
      const ctx = makeCtx(modelsOf(entries));
      assert.deepEqual(findCandidates(ctx, undefined), []);
      assert.deepEqual(findCandidates(ctx, ""), []);
      assert.deepEqual(findCandidates(ctx, []), []);
      assertPool(entries, [""]);
    }), options);
  });
});
