// Strategy contract properties, moved from the system-owned model-selection
// suite. Fixtures are host-independent structural candidates: no host types, no
// registry, no resolver, so the capability is exercised at its own boundary.
//
// Each property restates the documented formula independently of the
// production implementation and compares the selected candidate against that
// reference. Generators stay small so fast-check shrinks a failure to a minimal
// boundary case.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  modelContextSize,
  modelCost,
  selectModel,
  type RoutingStrategy,
} from "../selection.ts";

interface CostSpec {
  readonly input: number;
  readonly output: number;
}

interface Fixture {
  readonly provider: string;
  readonly id: string;
  readonly cost: CostSpec;
  readonly contextWindow: number;
}

/** Independent oracle: the documented names, not the production export. */
const EXPECTED_STRATEGIES: readonly RoutingStrategy[] = [
  "first",
  "fastest",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
  "best_value",
];

const STRATEGY = fc.constantFrom<RoutingStrategy>(...EXPECTED_STRATEGIES);

/** Fixed draw: a cost or context metric must never be able to move a `random` pool. */
const RNG = (): number => 0.5;

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
const CONTEXT_LIST = fc.array(fc.integer({ min: 1_000, max: 2_000_000 }), { minLength: 1, maxLength: 12 });
/** Narrow context windows so exact ties are reachable. */
const TIED_CONTEXT_LIST = fc.array(fc.integer({ min: 1_000, max: 1_010 }), { minLength: 1, maxLength: 8 });

const ENTRY = fc.record({
  input: fc.double({ min: 0, max: 100, noNaN: true }),
  output: fc.double({ min: 0, max: 100, noNaN: true }),
  contextWindow: fc.integer({ min: 1_000, max: 2_000_000 }),
});
const ENTRIES = fc.array(ENTRY, { maxLength: 12 });

/** A priced pool entry for the list-order strategies; price and context must not steer. */
const ORDERED_ENTRY = fc.record({
  input: fc.double({ min: 0, max: 100, noNaN: true }),
  output: fc.double({ min: 0, max: 100, noNaN: true }),
  contextWindow: fc.integer({ min: 1_000, max: 2_000_000 }),
});

function fixture(spec: CostSpec, index: number, contextWindow = 1_000): Fixture {
  return { provider: "fixture", id: `pool-${index}`, cost: spec, contextWindow };
}

function buildModels(specs: readonly CostSpec[]): Fixture[] {
  return specs.map((spec, index) => fixture(spec, index));
}

/** Context-only pools; no cost strategy reads these models' prices. */
function buildContextModels(contexts: readonly number[]): Fixture[] {
  return contexts.map((context, index) => fixture({ input: 0, output: 0 }, index, context));
}

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

describe("strategy selection properties", () => {
  describe("documented cost formulas", () => {
    it("selects the documented minimum combined input and output cost", () => {
      fc.assert(
        fc.property(COST_LIST, (specs) => {
          const models = buildModels(specs);
          const totals = specs.map(totalCost);
          const selected = selectModel([...models], "cheapest", RNG);
          assert.equal((selected as Fixture).id, models[firstIndexOfMin(totals)].id);
          assert.equal(modelCost(selected as Fixture), Math.min(...totals));
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
            (selected as Fixture).id,
            models[firstIndexOfMin(specs.map((spec) => spec.input))].id,
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
            (selected as Fixture).id,
            models[firstIndexOfMin(specs.map((spec) => spec.output))].id,
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
          assert.equal((selected as Fixture).id, models[firstIndexOfMax(contexts)].id);
          assert.equal(modelContextSize(selected as Fixture), Math.max(...contexts));
        }),
        { numRuns: 250 },
      );
    });
  });

  describe("best value", () => {
    it("selects the documented minimum combined cost per context token", () => {
      fc.assert(
        fc.property(ENTRIES, (entries) => {
          const models = entries.map((entry, index) => fixture(entry, index, entry.contextWindow));
          const selected = selectModel([...models], "best_value", RNG);
          if (entries.length === 0) {
            assert.equal(selected, undefined);
            return;
          }
          const ratios = entries.map((entry) => totalCost(entry) / entry.contextWindow);
          assert.equal((selected as Fixture).id, models[firstIndexOfMin(ratios)].id);
          assert.equal(
            modelCost(selected as Fixture) / modelContextSize(selected as Fixture),
            Math.min(...ratios),
          );
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
            assert.equal((selectModel([...models], "cheapest", RNG) as Fixture).id, models[winner].id);
            assert.equal(modelCost(selectModel([...models], "cheapest", RNG) as Fixture), Math.min(...totals));
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
            (selectModel([...models], "largest_context", RNG) as Fixture).id,
            models[firstIndexOfMax(contexts)].id,
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
          const models = entries.map((entry, index) =>
            fixture({ input: entry.input, output: entry.output }, index, entry.contextWindow));
          const cheapest = models.find((model) => modelCost(model) === Math.min(...models.map(modelCost)));
          assert.equal(selectModel([...models], "cheapest", RNG), cheapest);

          const contexts = entries.map((entry) => entry.contextWindow);
          const largest = contexts.indexOf(Math.max(...contexts));
          assert.equal(selectModel([...models], "largest_context", RNG), models[largest]);
        }),
        { numRuns: 200 },
      );
    });

    it("keeps the earliest candidate among equal best-value ratios", () => {
      fc.assert(
        fc.property(TIED_COST_LIST, fc.integer({ min: 1_000, max: 1_010 }), (specs, baseContext) => {
          const minimum = firstIndexOfMin(specs.map(totalCost));
          const priced: CostSpec[] = [
            ...specs.slice(0, minimum + 1),
            specs[minimum],
            ...specs.slice(minimum + 1),
            { input: 1_000_000, output: 1_000_000 },
          ];
          const models = priced.map((spec, index) => fixture(spec, index, baseContext));
          const ratios = priced.map((spec) => totalCost(spec) / baseContext);
          const atMinimum = ratios.filter((ratio) => ratio === Math.min(...ratios)).length;
          assert.ok(atMinimum >= 2, "fixture must place at least one duplicate at the minimum");
          assert.ok(
            firstIndexOfMin(ratios) < ratios.length - 1,
            "the best-value candidate must not be last, or first-wins and last-wins agree",
          );
          const winner = firstIndexOfMin(ratios);
          assert.equal((selectModel([...models], "best_value", RNG) as Fixture).id, models[winner].id);
        }),
        { numRuns: 250 },
      );
    });
  });

  describe("empty and singleton eligible sets", () => {
    it("returns undefined for every strategy when nothing is eligible", () => {
      for (const strategy of EXPECTED_STRATEGIES) {
        assert.equal(selectModel([], strategy, RNG), undefined, strategy);
      }
    });

    it("returns a lone candidate without scoring or drawing for every strategy", () => {
      fc.assert(
        fc.property(STRATEGY, COST_SPEC, (strategy, spec) => {
          const model = fixture(spec, 0, Math.round(spec.input + spec.output) + 1_000);
          const costless = { provider: "fixture", id: "only", contextWindow: 1_000 } as unknown as Fixture;
          let draws = 0;
          const counting = (): number => { draws += 1; return 0.5; };
          assert.equal(selectModel([model], strategy, counting), model);
          assert.equal(selectModel([costless], strategy, counting), costless);
          assert.equal(draws, 0, "a singleton pool must not be scored or drawn from");
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("list-order strategies", () => {
    // `docs/guide/configuration.md`: `first` is the first healthy candidate in list
    // order, and `fastest` is an alias for `first` over the current list order. Init
    // may reorder the list from one-time probe results, but selection never re-sorts
    // and never consults cost, context, or latency metadata.

    it("selects pool[0] for first and fastest whatever the metadata", () => {
      fc.assert(
        fc.property(fc.array(ORDERED_ENTRY, { minLength: 1, maxLength: 12 }), (entries) => {
          const models = entries.map((entry, index) => fixture(entry, index, entry.contextWindow));
          assert.equal(selectModel([...models], "first", RNG), models[0]);
          assert.equal(selectModel([...models], "fastest", RNG), models[0]);
        }),
        { numRuns: 250 },
      );
    });

    it("ignores cost and context when first and fastest pick a candidate", () => {
      fc.assert(
        fc.property(fc.array(ORDERED_ENTRY, { minLength: 2, maxLength: 12 }), (entries) => {
          // Same pool order, prices and windows inverted. A metadata-driven selector
          // moves; a list-order selector does not.
          const asListed = entries.map((entry, index) => fixture(entry, index, entry.contextWindow));
          const inverted = entries
            .map((entry) => ({ ...entry }))
            .reverse()
            .map((entry, index) =>
              fixture({ input: 100 - entry.input, output: 100 - entry.output }, index, 2_000_000 - entry.contextWindow));
          for (const strategy of ["first", "fastest"] as const) {
            assert.equal(selectModel([...asListed], strategy, RNG), asListed[0]);
            assert.equal(selectModel([...inverted], strategy, RNG), inverted[0]);
          }
        }),
        { numRuns: 250 },
      );
    });

    it("keeps first and fastest on first listed model when total costs tie", () => {
      const listed = [
        fixture({ input: 0, output: 100 }, 0, 1_000),
        fixture({ input: 100, output: 0 }, 1, 2_000),
      ];
      const invertedMetadata = [
        fixture({ input: 100, output: 0 }, 0, 2_000),
        fixture({ input: 0, output: 100 }, 1, 1_000),
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
            fixture({ input: count - index, output: index }, index));
          for (const strategy of ["first", "fastest"] as const) {
            let draws = 0;
            assert.equal(selectModel(models, strategy, () => { draws += 1; return 0.5; }), models[0]);
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
          const models = Array.from({ length: count }, (_, index) => fixture({ input: 0, output: 0 }, index));
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
              fixture({ input: index + 1, output: 100 - index }, index));
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
          const models = Array.from({ length: count }, (_, index) => fixture({ input: 0, output: 0 }, index));
          assert.equal(selectModel(models, "random", () => 0), models[0]);
          assert.equal(selectModel(models, "random", () => 1 - 2 ** -53), models[count - 1]);
        }),
        { numRuns: 200 },
      );
    });
  });
});
