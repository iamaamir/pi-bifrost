# Strategies

Built-in model-selection strategies for the routing policy.

## Ownership

This capability owns:

- the closed set of built-in strategy names and their single canonical order (`ALL_STRATEGIES`)
- the documented cost and context metrics (`modelCost`, `modelInputCost`,
  `modelOutputCost`, `modelContextSize`)
- the final pick from an ordered candidate pool (`selectModel`)

It owns nothing else. Candidate discovery, tiers, provider eligibility, sign-in,
reserves, billing preference, reliability and circuits, affinity, fallback,
routing rules and dispatch stay with `routing.ts` and its existing owners.
`routing.ts` and `config.ts` re-export this contract so existing root subpath
imports keep working.

## Inputs and outputs

`selectModel(candidates, strategy, random)` is synchronous and pure with respect
to its inputs:

- `candidates` is the final permitted pool in the host's order. Selection never
  re-sorts, mutates or allocates replacements.
- Each candidate exposes `cost.input`, `cost.output` and `contextWindow`; host
  objects may carry more fields, and generic inference preserves their identity.
- `strategy` is one of the eight names in `ALL_STRATEGIES`.
- `random` is an injectable draw used once by `random` and never by the others.

The result is always a member of the supplied pool, or `undefined` for an empty
pool. A single candidate is returned without scoring or drawing.

## Behavior

| Strategy | Chooses |
| --- | --- |
| `first`, `fastest` | the first candidate in list order |
| `cheapest` | lowest `input + output` cost |
| `cheapest_input` | lowest input cost |
| `cheapest_output` | lowest output cost |
| `largest_context` | largest context window |
| `best_value` | lowest combined cost per context token |
| `random` | `floor(draw * length)`, one draw |

Ties keep the earliest candidate. An unknown strategy name keeps the legacy
first-candidate fallback; callers validate names elsewhere. `random` is total for
draws outside `[0, 1)` and for `NaN`, selecting the last candidate.

Numeric edge characterization: metrics are assumed finite. The scan seeds its
minimum with `+Infinity` and only lets a score win when it is strictly lower, so
on malformed input the observable rules are:

- a finite score wins over `NaN` and `+Infinity`, wherever each appears;
- `NaN` scores never win;
- `+Infinity` scores, including an overflowing `input + output` sum, never win;
- `-Infinity` always wins, keeping the earliest such candidate;
- when every score is `NaN` or `+Infinity` (including `0 / 0` for `best_value`)
  there is no comparable minimum and the result is `undefined` rather than a
  fabricated candidate.

A missing `cost` object is a caller error and throws for multi-candidate metric
strategies. Valid-domain callers cannot reach these states; changing them is a
separate decision.

## Dependencies and effects

No imports outside this directory, no I/O, no host runtime, no network, no
filesystem, no clock, no dispatch, no credentials and no persisted state.

## Compatibility

The exported names, signatures and behavior are the public contract of the
strategies capability. They are also re-exported from `routing.ts` (selection,
metrics and the strategy type) and `config.ts` (`ALL_STRATEGIES`), which existing
consumers import. Configuration names and defaults are unchanged.

## Verification

```
node --test --experimental-strip-types modules/strategies/tests/selection.test.ts
node --test --experimental-strip-types modules/strategies/tests/selection-properties.test.ts
```

The full and quick tiers discover both files through the module test globs.
Mutation binding is declared in `mutation/config.mjs`; the module tests bind
directly because they import this capability.

## Extending or replacing

Add a strategy by extending the union and the canonical list in `selection.ts`,
then updating the schema enums and the drift guard in one change. Keep every
consumer override-free: this capability chooses from the supplied pool and does
not gain eligibility, fallback or dispatch authority. Replacement must preserve
the documented behavior above, including tie-breaking and edge cases.
