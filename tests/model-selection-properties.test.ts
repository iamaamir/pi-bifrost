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
  modelContextSize,
  modelCost,
  modelKey,
  resolveHealthyModel,
  resolveModel,
  selectModel,
  type RoutingStrategy,
} from "../routing.ts";
import { DEFAULT_RELIABILITY, type ReliabilityRecord, type ReliabilityState } from "../reliability.ts";
import { makeCtx, makeModel, withoutCost } from "./helpers.ts";

const ALL_STRATEGIES: readonly RoutingStrategy[] = [
  "first",
  "fastest",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
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
const TIED_COST_LIST = fc.array(TIED_COST_SPEC, { minLength: 1, maxLength: 8 });
/** Narrow context windows so exact ties are reachable. */
const TIED_CONTEXT_LIST = fc.array(fc.integer({ min: 1_000, max: 1_010 }), { minLength: 1, maxLength: 8 });
const CONTEXT_LIST = fc.array(fc.integer({ min: 1_000, max: 2_000_000 }), { minLength: 1, maxLength: 12 });

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

/** A priced pool entry for the list-order strategies; price and context must not steer. */
const ORDERED_ENTRY = fc.record({
  input: fc.double({ min: 0, max: 100, noNaN: true }),
  output: fc.double({ min: 0, max: 100, noNaN: true }),
  contextWindow: fc.integer({ min: 1_000, max: 2_000_000 }),
});

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

/** First index attaining the maximum, mirroring the documented stable tie-break. */
function firstIndexOfMax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
  return best;
}

const totalCost = (spec: CostSpec): number => spec.input + spec.output;

function buildModels(specs: readonly CostSpec[]): Model<Api>[] {
  return specs.map((spec, index) => makeModel("fixture", `pool-${index}`, spec.input, spec.output));
}

/** Context-only pools; no cost strategy reads these models' prices. */
function buildContextModels(contexts: readonly number[]): Model<Api>[] {
  return contexts.map((context, index) => makeModel("fixture", `context-${index}`, 0, 0, context));
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
  describe("documented cost formulas", () => {
    it("selects the documented minimum combined input and output cost", () => {
      fc.assert(
        fc.property(COST_LIST, (specs) => {
          const models = buildModels(specs);
          const totals = specs.map(totalCost);
          const selected = selectModel([...models], "cheapest", RNG);
          assert.equal(modelKey(selected as Model<Api>), modelKey(models[firstIndexOfMin(totals)]));
          assert.equal(modelCost(selected as Model<Api>), Math.min(...totals));
        }),
        { numRuns: 250 },
      );
    });

    it("selects the documented minimum input cost", () => {
      fc.assert(
        fc.property(COST_LIST, (specs) => {
          const models = buildModels(specs);
          const selected = selectModel([...models], "cheapest_input", RNG);
          assert.equal(
            modelKey(selected as Model<Api>),
            modelKey(models[firstIndexOfMin(specs.map((spec) => spec.input))]),
          );
        }),
        { numRuns: 250 },
      );
    });

    it("selects the documented minimum output cost", () => {
      fc.assert(
        fc.property(COST_LIST, (specs) => {
          const models = buildModels(specs);
          const selected = selectModel([...models], "cheapest_output", RNG);
          assert.equal(
            modelKey(selected as Model<Api>),
            modelKey(models[firstIndexOfMin(specs.map((spec) => spec.output))]),
          );
        }),
        { numRuns: 250 },
      );
    });
  });

  describe("largest context", () => {
    it("selects the documented largest context window", () => {
      fc.assert(
        fc.property(CONTEXT_LIST, (contexts) => {
          const models = buildContextModels(contexts);
          const selected = selectModel([...models], "largest_context", RNG);
          assert.equal(modelKey(selected as Model<Api>), modelKey(models[firstIndexOfMax(contexts)]));
          assert.equal(modelContextSize(selected as Model<Api>), Math.max(...contexts));
        }),
        { numRuns: 250 },
      );
    });
  });

  describe("stable ties", () => {
    it("keeps the earliest candidate among equal combined costs", () => {
      fc.assert(
        fc.property(
          TIED_COST_LIST,
          // Force a duplicated minimum so the tie is always exercised: the cheapest pool
          // entry is repeated immediately after itself, and the last entry is priced so
          // the unique minimum cannot have landed there by chance.
          (specs) => {
            const minimum = firstIndexOfMin(specs.map(totalCost));
            const priced: CostSpec[] = [
              ...specs.slice(0, minimum + 1),
              specs[minimum],
              ...specs.slice(minimum + 1),
              { input: 1_000_000, output: 1_000_000 },
            ];
            const models = buildModels(priced);
            const totals = priced.map(totalCost);
            const atMinimum = totals.filter((total) => total === Math.min(...totals)).length;
            assert.ok(atMinimum >= 2, "fixture must place at least one duplicate at the minimum");
            assert.ok(
              firstIndexOfMin(totals) < totals.length - 1,
              "the cheapest candidate must not be last, or first-wins and last-wins agree",
            );

            const winner = firstIndexOfMin(totals);
            assert.equal(modelKey(selectModel([...models], "cheapest", RNG) as Model<Api>), modelKey(models[winner]));
            assert.equal(modelCost(selectModel([...models], "cheapest", RNG) as Model<Api>), Math.min(...totals));
          },
        ),
        { numRuns: 250 },
      );
    });

    it("keeps the earliest candidate among equal context windows", () => {
      fc.assert(
        fc.property(TIED_CONTEXT_LIST, (contexts) => {
          const models = buildContextModels(contexts);
          assert.equal(
            modelKey(selectModel([...models], "largest_context", RNG) as Model<Api>),
            modelKey(models[firstIndexOfMax(contexts)]),
          );
        }),
        { numRuns: 250 },
      );
    });

    it("resolves an all-tied pool to whichever candidate is listed first", () => {
      const TIED_ENTRY = fc.record({
        input: fc.integer({ min: 0, max: 3 }),
        output: fc.integer({ min: 0, max: 3 }),
        contextWindow: fc.integer({ min: 1_000, max: 1_003 }),
      });
      fc.assert(
        fc.property(fc.array(TIED_ENTRY, { minLength: 1, maxLength: 8 }), (entries) => {
          const specs: CostSpec[] = entries.map(({ input, output }) => ({ input, output }));
          const models = buildModels(specs);
          const cheapest = keysOf(models.filter((model) => modelCost(model) === Math.min(...specs.map(totalCost))));
          assert.equal(modelKey(selectModel([...models], "cheapest", RNG) as Model<Api>), cheapest[0]);

          const contexts = entries.map((entry) => entry.contextWindow);
          const largest = keysOf(
            buildContextModels(contexts).filter((_, index) => contexts[index] === Math.max(...contexts)),
          );
          const contextModels = buildContextModels(contexts);
          assert.equal(
            modelKey(selectModel([...contextModels], "largest_context", RNG) as Model<Api>),
            largest[0],
          );
        }),
        { numRuns: 200 },
      );
    });
  });

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

    it("returns undefined for every strategy when nothing is eligible", () => {
      for (const strategy of ALL_STRATEGIES) {
        assert.equal(selectModel([], strategy, RNG), undefined, strategy);
      }
      const ctx = makeCtx([makeModel("a", "a")]);
      for (const strategy of ALL_STRATEGIES) {
        assert.equal(resolveModel(ctx, "unmatched-token", strategy), undefined, strategy);
      }
    });

    it("returns a lone candidate without scoring or drawing for every strategy", () => {
      fc.assert(
        fc.property(STRATEGY, COST_SPEC, (strategy, spec) => {
          const model = makeModel("fixture", "only", spec.input, spec.output, Math.round(spec.input + spec.output) + 1_000);
          const costless = withoutCost(model);
          let draws = 0;
          const counting = (): number => { draws += 1; return DRAW; };
          assert.equal(selectModel([model], strategy, counting), model);
          assert.equal(selectModel([costless], strategy, counting), costless);
          assert.equal(draws, 0, "a singleton pool must not be scored or drawn from");
        }),
        { numRuns: 100 },
      );
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

  describe("list-order strategies", () => {
    // `docs/guide/configuration.md`: `first` is the first healthy candidate in list
    // order, and `fastest` is an alias for `first` over the current list order — init
    // may reorder the list from one-time probe results, but selection never re-sorts
    // and never consults cost, context, or latency metadata.

    it("selects pool[0] for first and fastest whatever the metadata", () => {
      fc.assert(
        fc.property(
          fc.array(ORDERED_ENTRY, { minLength: 1, maxLength: 12 }),
          (entries) => {
            const models = entries.map((entry, index) =>
              makeModel("fixture", `order-${index}`, entry.input, entry.output, entry.contextWindow));
            assert.equal(selectModel([...models], "first", RNG), models[0]);
            assert.equal(selectModel([...models], "fastest", RNG), models[0]);
          },
        ),
        { numRuns: 250 },
      );
    });

    it("ignores cost and context when first and fastest pick a candidate", () => {
      fc.assert(
        fc.property(
          fc.array(ORDERED_ENTRY, { minLength: 2, maxLength: 12 }),
          (entries) => {
            // Same pool order, prices and windows inverted. A metadata-driven selector
            // moves; a list-order selector does not.
            const asListed = entries.map((entry, index) =>
              makeModel("fixture", `pool-${index}`, entry.input, entry.output, entry.contextWindow));
            const inverted = entries
              .map((entry) => ({ ...entry }))
              .reverse()
              .map((entry, index) =>
                makeModel("fixture", `pool-${index}`, 100 - entry.input, 100 - entry.output, 2_000_000 - entry.contextWindow));
            // Inverting metadata can preserve each model's total cost. Candidate
            // identity/order assertions below verify the selector contract.
            for (const strategy of ["first", "fastest"] as const) {
              assert.equal(selectModel([...asListed], strategy, RNG), asListed[0]);
              assert.equal(selectModel([...inverted], strategy, RNG), inverted[0]);
            }
          },
        ),
        { numRuns: 250 },
      );
    });

    it("keeps first and fastest on first listed model when total costs tie", () => {
      const listed = [
        makeModel("fixture", "listed-first", 0, 100, 1_000),
        makeModel("fixture", "listed-last", 100, 0, 2_000),
      ];
      const invertedMetadata = [
        makeModel("fixture", "inverted-first", 100, 0, 2_000),
        makeModel("fixture", "inverted-last", 0, 100, 1_000),
      ];
      assert.deepEqual(listed.map(modelCost), [100, 100]);
      assert.deepEqual(invertedMetadata.map(modelCost), [100, 100]);
      for (const strategy of ["first", "fastest"] as const) {
        assert.equal(selectModel(listed, strategy, RNG), listed[0]);
        assert.equal(selectModel(invertedMetadata, strategy, RNG), invertedMetadata[0]);
      }
      assert.notEqual(listed[0], listed[1], "fixture must distinguish first from last");
    });

    it("never draws from the RNG for first or fastest", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 16 }), (count) => {
          const models = Array.from({ length: count }, (_, index) =>
            makeModel("fixture", `order-${index}`, count - index, index));
          for (const strategy of ["first", "fastest"] as const) {
            let draws = 0;
            assert.equal(selectModel(models, strategy, () => { draws += 1; return DRAW; }), models[0]);
            assert.equal(draws, 0, `${strategy} must not consume a draw`);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("random", () => {
    it("selects the mid-bucket candidate for any pool length and draw index", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 32 }), fc.integer({ min: 0, max: 10_000 }), (count, drawIndex) => {
          const models = Array.from({ length: count }, (_, index) => makeModel("fixture", `draw-${index}`));
          const bucket = drawIndex % count;
          const draw = (bucket + 0.5) / count;
          let draws = 0;
          assert.equal(selectModel(models, "random", () => { draws += 1; return draw; }), models[bucket]);
          // A singleton pool short-circuits before the strategy runs, so it never draws.
          assert.equal(draws, count === 1 ? 0 : 1);
        }),
        { numRuns: 250 },
      );
    });

    it("indexes the configured pool order, not a price ordering", () => {
      // Costs vary across the pool on purpose: any implementation that re-sorts the
      // pool before indexing still passes when every candidate is priced alike.
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 24 }),
          fc.integer({ min: 0, max: 10_000 }),
          (count, drawIndex) => {
            const models = Array.from({ length: count }, (_, index) =>
              makeModel("fixture", `ordered-${index}`, index + 1, 100 - index));
            const bucket = drawIndex % count;
            const draw = (bucket + 0.5) / count;
            assert.equal(selectModel(models, "random", () => draw), models[bucket]);
          },
        ),
        { numRuns: 250 },
      );
    });

    it("indexes the configured pool order for a fixed draw over a price-graded pool", () => {
      fc.assert(
        fc.property(fc.array(COST_SPEC, { minLength: 2, maxLength: 24 }), (specs) => {
          const models = buildModels(specs);
          const totals = specs.map(totalCost);
          // Equal prices are the only inputs a price-sort cannot reorder, so this
          // property only claims something when every candidate is uniquely priced.
          if (new Set(totals).size !== totals.length) return;
          const cheapest = firstIndexOfMin(totals);
          const draws = [0.25, 0.5, 0.75];
          // The draws must land somewhere a price sort would have chosen differently.
          if (draws.every((draw) => Math.floor(draw * models.length) === cheapest)) return;
          for (const draw of draws) {
            assert.equal(selectModel(models, "random", () => draw), models[Math.floor(draw * models.length)]);
          }
        }),
        { numRuns: 200 },
      );
    });

    it("selects the first candidate at zero and the last candidate just below one", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 32 }), (count) => {
          const models = Array.from({ length: count }, (_, index) => makeModel("fixture", `edge-${index}`));
          assert.equal(selectModel(models, "random", () => 0), models[0]);
          assert.equal(selectModel(models, "random", () => 1 - 2 ** -53), models[count - 1]);
        }),
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