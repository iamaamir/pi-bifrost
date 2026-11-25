// Direct contract tests for the built-in selection strategies. Fixtures are
// host-independent structural candidates, so this file runs without any host
// runtime, registry or resolver initialization.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_STRATEGIES,
  modelContextSize,
  modelCost,
  modelInputCost,
  modelOutputCost,
  selectModel,
  type RoutingStrategy,
} from "../selection.ts";

interface Fixture {
  readonly provider: string;
  readonly id: string;
  readonly cost: { input: number; output: number };
  readonly contextWindow: number;
}

const model = (id: string, input: number, output: number, contextWindow = 1_000): Fixture =>
  ({ provider: "fixture", id, cost: { input, output }, contextWindow });

const NO_DRAW = (): number => { throw new Error("selection must not draw"); };

describe("built-in strategy selection", () => {
  it("declares exactly the eight documented strategies, in one order", () => {
    // Independent expectation: a removed or added name fails here, and the
    // schema drift guard compares the JSON enums against this same capability.
    const documented: readonly RoutingStrategy[] = [
      "first", "fastest", "cheapest", "cheapest_input",
      "cheapest_output", "largest_context", "random", "best_value",
    ];
    assert.deepEqual([...ALL_STRATEGIES].sort(), [...documented].sort());
  });

  it("returns the first candidate for first and fastest regardless of metadata", () => {
    const pool = [model("a", 9, 9, 4_000), model("b", 1, 1, 128_000), model("c", 5, 0, 1_000)];
    assert.equal(selectModel([...pool], "first", NO_DRAW), pool[0]);
    assert.equal(selectModel([...pool], "fastest", NO_DRAW), pool[0]);
  });

  it("selects the documented minimum for each metric strategy", () => {
    const pool = [
      model("combined", 3, 2),           // total 5, the lowest
      model("input", 1, 9),              // lowest input cost
      model("output", 8, 0),             // lowest output cost
      model("context", 60, 60, 200_000), // largest window
      model("value", 6, 6, 100_000),     // 12 / 100_000, the lowest ratio
    ];
    assert.equal(selectModel([...pool], "cheapest"), pool[0]);
    assert.equal(selectModel([...pool], "cheapest_input"), pool[1]);
    assert.equal(selectModel([...pool], "cheapest_output"), pool[2]);
    assert.equal(selectModel([...pool], "largest_context"), pool[3]);
    assert.equal(selectModel([...pool], "best_value"), pool[4]);
    assert.equal(modelCost(pool[0]), 5);
    assert.equal(modelInputCost(pool[1]), 1);
    assert.equal(modelOutputCost(pool[2]), 0);
    assert.equal(modelContextSize(pool[3]), 200_000);
  });

  it("keeps the earliest candidate on metric ties", () => {
    const priced = [model("first", 2, 2), model("second", 2, 2)];
    assert.equal(selectModel(priced, "cheapest"), priced[0]);
    const contexts = [model("first", 0, 0, 8_000), model("second", 0, 0, 8_000)];
    assert.equal(selectModel(contexts, "largest_context"), contexts[0]);
    const ratios = [model("first", 1, 1, 4_000), model("second", 1, 1, 4_000)];
    assert.equal(selectModel(ratios, "best_value"), ratios[0]);
  });

  it("returns undefined for an empty pool for every strategy", () => {
    for (const strategy of ALL_STRATEGIES) {
      assert.equal(selectModel([], strategy), undefined, strategy);
    }
  });

  it("never draws randomness for an empty pool", () => {
    // The explicit empty guard is the contract: no scoring and no random call,
    // not an accident of indexing past the array.
    for (const strategy of ALL_STRATEGIES) {
      assert.equal(selectModel([], strategy, NO_DRAW), undefined, strategy);
    }
  });

  it("returns a singleton without reading metrics or drawing randomness", () => {
    // A cost-less candidate would throw if any metric were read.
    const costless = { provider: "fixture", id: "only", contextWindow: 0 } as unknown as Fixture;
    for (const strategy of ALL_STRATEGIES) {
      assert.equal(selectModel([costless], strategy, NO_DRAW), costless, strategy);
    }
  });

  it("never mutates or reorders the supplied pool", () => {
    const pool = [model("a", 3, 1), model("b", 1, 3), model("c", 2, 2)];
    const order = pool.map((candidate) => candidate.id);
    const before = pool.map((candidate) => ({ ...candidate }));
    for (const strategy of ALL_STRATEGIES) {
      selectModel(pool, strategy, () => 0.5);
      assert.deepEqual(pool.map((candidate) => candidate.id), order, strategy);
      assert.deepEqual(pool, before, strategy);
    }
  });

  it("returns a supplied candidate and never invents one", () => {
    const pool = [model("a", 3, 1), model("b", 1, 3), model("c", 2, 2)];
    for (const strategy of ALL_STRATEGIES) {
      for (const draw of [0, 0.34, 0.5, 0.99]) {
        const selected = selectModel(pool, strategy, () => draw);
        assert.ok(selected !== undefined && pool.includes(selected), `${strategy} at ${draw}`);
      }
    }
  });

  it("uses one draw for random and indexes the supplied order", () => {
    const pool = [model("a", 9, 9), model("b", 1, 1), model("c", 5, 5)];
    let draws = 0;
    const selected = selectModel(pool, "random", () => { draws += 1; return 0.75; });
    assert.equal(selected, pool[2]);
    assert.equal(draws, 1);
    const first = selectModel(pool, "random", () => 0);
    assert.equal(first, pool[0]);
  });

  it("is total for draws outside [0, 1) and for NaN", () => {
    const pool = [model("a", 0, 0), model("b", 0, 0), model("c", 0, 0)];
    for (const draw of [1, -1, NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(selectModel(pool, "random", () => draw), pool[2], String(draw));
    }
    assert.equal(selectModel(pool, "random", () => 1 - 2 ** -53), pool[2]);
  });

  it("yields no candidate when every metric score is non-finite", () => {
    // Characterization, not policy: callers supply validated finite metrics.
    // A pool with no comparable minimum must not produce an invented candidate.
    const nanCost = [model("a", NaN, 0), model("b", NaN, 0)];
    const infiniteCost = [model("a", Infinity, 0), model("b", Infinity, 0)];
    const overflowing = [
      model("a", Number.MAX_VALUE, Number.MAX_VALUE),
      model("b", Number.MAX_VALUE, Number.MAX_VALUE),
    ];
    const zeroOverZero = [model("a", 0, 0, 0), model("b", 0, 0, 0)];
    assert.equal(selectModel(nanCost, "cheapest"), undefined);
    assert.equal(selectModel(infiniteCost, "cheapest"), undefined);
    assert.equal(selectModel(overflowing, "cheapest"), undefined);
    assert.equal(selectModel(zeroOverZero, "best_value"), undefined);
  });

  it("propagates a missing cost as a caller error on multi-candidate pools", () => {
    const missing = { provider: "fixture", id: "x", contextWindow: 1_000 } as unknown as Fixture;
    assert.throws(() => selectModel([model("a", 1, 1), missing], "cheapest"), TypeError);
  });

  it("keeps the legacy first-candidate fallback for an unknown strategy name", () => {
    const pool = [model("a", 9, 9), model("b", 1, 1)];
    const unknown = "legacy-name" as unknown as RoutingStrategy;
    assert.equal(selectModel([...pool], unknown), pool[0]);
  });
});
