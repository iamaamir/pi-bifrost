// Generated-boundary properties for the model-selection contract in
// `docs/guide/configuration.md#selection-strategies`.
//
// Each property restates the documented formula independently of the
// production implementation and compares the selected candidate against
// that reference. Generators stay small so fast-check shrinks a failure to
// a minimal boundary case, and every reported run carries a seed and a
// counterexample path that replays exactly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  findCandidates,
  modelKey,
  resolveHealthyModel,
  resolveModel,
  selectModel,
  type RoutingStrategy,
} from "../routing.ts";
import { DEFAULT_RELIABILITY, type ReliabilityRecord, type ReliabilityState } from "../reliability.ts";
import { makeCtx, makeModel } from "./helpers.ts";

const ALL_STRATEGIES: readonly RoutingStrategy[] = [
  "first",
  "fastest",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
  "best_value",
];

const STRATEGY = fc.constantFrom<RoutingStrategy>(...ALL_STRATEGIES);

const NOW = 1_700_000_000_000;
const FIXED_RELIABILITY = { ...DEFAULT_RELIABILITY, failureThreshold: 1, cooldownMinutes: 10 };
/** Fixed draw: a cost or context metric must never be able to move a `random` pool. */
const DRAW = 0.5;
const RNG = (): number => DRAW;

// ── Arbitraries ──────────────────────────────────────────────────

interface CostSpec {
  readonly input: number;
  readonly output: number;
}

interface CatalogEntry extends CostSpec {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}

/** Fractional $/1M-token costs — the shape real registries publish. */
const COST_SPEC = fc.record({
  input: fc.double({ min: 0, max: 100, noNaN: true }),
  output: fc.double({ min: 0, max: 100, noNaN: true }),
});

/** Small integer costs so exact ties are reachable and shrink to `[a, b]`. */
const TIED_COST_SPEC = fc.record({
  input: fc.integer({ min: 0, max: 5 }),
  output: fc.integer({ min: 0, max: 5 }),
});

const COST_LIST = fc.array(COST_SPEC, { minLength: 1, maxLength: 12 });
/** Lowercase id characters only; `/` stays a pattern-side marker for exact matches. */
const ID_CHARS = ["a", "b", "c", "d", "-", "0", "1", "2"] as const;
/** Uppercase providers exercise the lowercased comparison path. */
const PROVIDER_CHARS = ["A", "b", "C", "-", "0"] as const;

function characters(charset: readonly string[], maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...charset), { minLength: 1, maxLength }).map((c) => c.join(""));
}

const PROVIDER = characters(PROVIDER_CHARS, 3);
const MODEL_ID = characters(ID_CHARS, 4);
const PATTERN = characters(ID_CHARS, 5);
const EXACT_PATTERN = fc.tuple(PROVIDER, MODEL_ID).map(([provider, id]) => `${provider}/${id}`);

const CATALOG = fc.array(
  fc.record({
    provider: PROVIDER,
    id: MODEL_ID,
    input: fc.double({ min: 0, max: 100, noNaN: true }),
    output: fc.double({ min: 0, max: 100, noNaN: true }),
    contextWindow: fc.integer({ min: 1_000, max: 2_000_000 }),
  }),
  { maxLength: 12 },
);

const PATTERN_INPUT = fc.oneof(
  fc.constant<string | string[] | undefined>(undefined),
  fc.constant<string | string[] | undefined>([]),
  fc.array(PATTERN, { minLength: 1, maxLength: 3 }),
  fc.array(EXACT_PATTERN, { minLength: 1, maxLength: 3 }),
);

const RELIABILITY_MARKER = fc.constantFrom<"open_circuit" | "trial_active">("open_circuit", "trial_active");

// ── Reference implementations ────────────────────────────────────

/** First index attaining the minimum, mirroring the documented stable tie-break. */
function firstIndexOfMin(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] < values[best]) best = i;
  return best;
}

/** First index attaining the maximum, used by the controlled cost-inversion fault. */
function firstIndexOfMax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
  return best;
}

const totalCost = (spec: CostSpec): number => spec.input + spec.output;

function buildModels(specs: readonly CostSpec[]): Model<Api>[] {
  return specs.map((spec, index) => makeModel("fixture", `pool-${index}`, spec.input, spec.output));
}

function buildCatalog(entries: readonly CatalogEntry[]): Model<Api>[] {
  return entries.map((entry) =>
    makeModel(entry.provider, entry.id, entry.input, entry.output, entry.contextWindow));
}

function keysOf(models: readonly Model<Api>[]): string[] {
  return models.map(modelKey);
}

/** True when every value of `actual` appears in `expected` in the same relative order. */
function isSubsequence(actual: readonly string[], expected: readonly string[]): boolean {
  let cursor = 0;
  for (const value of expected) {
    if (cursor < actual.length && actual[cursor] === value) cursor += 1;
  }
  return cursor === actual.length;
}

function markerRecord(marker: "open_circuit" | "trial_active"): ReliabilityRecord {
  return marker === "open_circuit"
    ? { failures: [NOW], openUntil: NOW + 60_000, trialActive: false }
    : { failures: [NOW], openUntil: NOW - 1, trialActive: true };
}

// ── Properties ───────────────────────────────────────────────────

describe("model selection properties", () => {




  describe("empty and singleton eligible sets", () => {
    it("never selects a candidate the registry did not supply", () => {
      fc.assert(
        fc.property(CATALOG, PATTERN_INPUT, STRATEGY, (catalog, pattern, strategy) => {
          const models = buildCatalog(catalog);
          const pool = findCandidates(makeCtx(models), pattern);
          assert.equal(new Set(keysOf(pool)).size, pool.length, "candidate pool must stay deduplicated");
          for (const candidate of pool) assert.ok(models.includes(candidate));
          const selected = selectModel([...pool], strategy, RNG);
          if (pool.length === 0) assert.equal(selected, undefined);
          else assert.ok(selected !== undefined && pool.includes(selected));
        }),
        { numRuns: 200 },
      );
    });

    it("resolves nothing for every strategy when no candidate matches", () => {
      const ctx = makeCtx([makeModel("a", "a")]);
      for (const strategy of ALL_STRATEGIES) {
        assert.equal(resolveModel(ctx, "unmatched-token", strategy), undefined, strategy);
      }
    });


    it("keeps healthy, skipped, and selected pools a partition of the configured candidates", () => {
      fc.assert(
        fc.property(
          CATALOG,
          PATTERN_INPUT,
          fc.array(RELIABILITY_MARKER, { maxLength: 12 }),
          STRATEGY,
          (catalog, pattern, markers, strategy) => {
            const models = buildCatalog(catalog);
            const records: Record<string, ReliabilityRecord> = {};
            const expectedReasons = new Map<string, "open_circuit" | "trial_active">();
            for (const [index, marker] of markers.entries()) {
              const model = models[index % Math.max(models.length, 1)];
              if (model) {
                records[modelKey(model)] = markerRecord(marker);
                expectedReasons.set(modelKey(model), marker);
              }
            }
            const state: ReliabilityState = { version: 1, models: records };
            const resolution = resolveHealthyModel(
              makeCtx(models), pattern, strategy, state, FIXED_RELIABILITY, NOW, undefined, RNG,
            );
            const configured = keysOf(resolution.candidates);
            const healthy = keysOf(resolution.healthyCandidates);
            const skipped = resolution.skipped.map(({ key }) => key);

            assert.equal(new Set(configured).size, configured.length, "candidate pool must stay deduplicated");
            assert.ok(isSubsequence(healthy, configured), "healthy pool must preserve configured order");
            assert.deepEqual([...healthy, ...skipped].sort(), [...configured].sort());
            assert.equal(new Set([...healthy, ...skipped]).size, healthy.length + skipped.length);
            for (const entry of resolution.skipped) {
              assert.equal(entry.reason, expectedReasons.get(entry.key), entry.key);
            }
            if (resolution.selected) {
              assert.ok(healthy.includes(modelKey(resolution.selected)));
              assert.equal(skipped.includes(modelKey(resolution.selected)), false);
            } else {
              assert.equal(healthy.length, 0);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });



  describe("registry refresh and dedup", () => {
    it("deduplicates candidates across overlapping and repeated patterns", () => {
      fc.assert(
        fc.property(CATALOG, fc.array(PATTERN, { minLength: 1, maxLength: 4 }), (catalog, patterns) => {
          const keys = keysOf(findCandidates(makeCtx(buildCatalog(catalog)), patterns));
          assert.equal(new Set(keys).size, keys.length);
        }),
        { numRuns: 250 },
      );
    });

    it("reflects a registry refresh that replaces every model object", () => {
      fc.assert(
        fc.property(CATALOG, CATALOG, PATTERN_INPUT, (before, after, pattern) => {
          const models = buildCatalog(before);
          const ctx = makeCtx(models);
          keysOf(findCandidates(ctx, pattern));

          models.length = 0;
          models.push(...buildCatalog(after));
          const refreshed = keysOf(findCandidates(ctx, pattern));

          assert.deepEqual(refreshed, keysOf(findCandidates(makeCtx(buildCatalog(after)), pattern)));
          assert.deepEqual(refreshed, keysOf(findCandidates(makeCtx(models.map((model) => ({ ...model }))), pattern)));
          assert.equal(refreshed.length, new Set(refreshed).size);
        }),
        { numRuns: 200 },
      );
    });

    it("returns identical candidates on repeated calls", () => {
      fc.assert(
        fc.property(CATALOG, PATTERN_INPUT, (catalog, pattern) => {
          const ctx = makeCtx(buildCatalog(catalog));
          assert.deepEqual(keysOf(findCandidates(ctx, pattern)), keysOf(findCandidates(ctx, pattern)));
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("controlled fault sensitivity", () => {
    const costProperty = (oracle: (specs: readonly CostSpec[]) => number): fc.IProperty<[readonly CostSpec[]]> =>
      fc.property(COST_LIST, (specs) => {
        const models = buildModels(specs);
        const selected = selectModel([...models], "cheapest", RNG);
        return selected === models[oracle(specs)];
      });

    const documentedCostOracle = (specs: readonly CostSpec[]): number =>
      firstIndexOfMin(specs.map(totalCost));

    /** Controlled fault: expects the most expensive model instead of the cheapest. */
    const faultyCostOracle = (specs: readonly CostSpec[]): number =>
      firstIndexOfMax(specs.map(totalCost));

    it("accepts the production cost strategy and rejects the faulty one", () => {
      const accepted = fc.check(costProperty(documentedCostOracle), { numRuns: 300 });
      assert.equal(accepted.failed, false);

      const rejected = fc.check(costProperty(faultyCostOracle), { numRuns: 300 });
      assert.equal(rejected.failed, true);
      assert.equal(typeof rejected.seed, "number");
      assert.ok(rejected.counterexamplePath !== null && typeof rejected.counterexamplePath === "string");
      assert.ok((rejected.counterexamplePath ?? "").length > 0);
      // fast-check reports the counterexample tuple, so the pool is its single entry.
      assert.equal(
        rejected.counterexample[0].length,
        2,
        "a cost inversion must shrink to the smallest pool that separates cheapest from most expensive",
      );
    });

    it("replays a reported seed and counterexample path to the same failure", () => {
      const rejected = fc.check(costProperty(faultyCostOracle), { numRuns: 300 });
      assert.equal(rejected.failed, true);
      const replay = fc.check(costProperty(faultyCostOracle), {
        seed: rejected.seed,
        path: rejected.counterexamplePath ?? undefined,
        numRuns: 300,
      });
      assert.equal(replay.failed, true);
      assert.deepEqual(replay.counterexample, rejected.counterexample);
    });

    it("catches a faulty tie-break that prefers the last tied candidate", () => {
      const tied = fc.array(TIED_COST_SPEC, { minLength: 2, maxLength: 8 });
      const production = fc.property(tied, (specs) => {
        const models = buildModels(specs);
        return selectModel([...models], "cheapest", RNG) === models[firstIndexOfMin(specs.map(totalCost))];
      });
      /** Controlled fault: non-strict comparison keeps the last of several tied candidates. */
      const lastTie = fc.property(tied, (specs) => {
        const models = buildModels(specs);
        const totals = specs.map(totalCost);
        let best = 0;
        for (let i = 1; i < models.length; i += 1) if (totals[i] <= totals[best]) best = i;
        return selectModel([...models], "cheapest", RNG) === models[best];
      });

      assert.equal(fc.check(production, { numRuns: 300 }).failed, false);

      const rejected = fc.check(lastTie, { numRuns: 300 });
      assert.equal(rejected.failed, true);
      const replay = fc.check(lastTie, { seed: rejected.seed, path: rejected.counterexamplePath ?? undefined, numRuns: 300 });
      assert.equal(replay.failed, true);
      assert.deepEqual(replay.counterexample, rejected.counterexample);
    });
  });
});