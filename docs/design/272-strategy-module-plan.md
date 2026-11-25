# #272 strategy module — implementation plan

**Status: approved 2026-11-25 with owner corrections; implementation candidate.**
The owner approved this boundary and supplied four corrections, recorded in
"Owner corrections" below. This document is the approved delivery contract for the
stateless capability pilot authorized by issue #272. It does not authorize tooling
redesign, settings changes or a merge. The module design guide remains proposed guidance;
it is validated through this pilot rather than applied repository-wide.

- Delivery revision: `d4d7d1015cfb6bde36b46f5a8615a52c4295f2f9` (tree `a2b1377`), PR #352
  merged 2026-11-25T17:58:57Z.
- Research baseline: `f33bd0abbd8364cbccb5ff1f743c2614e0e6386f` (issue #272 research
  comment), guide proposal PR #350.
- Prerequisite: issue #351 / PR #352 (module-aware tooling and protected complexity
  migration), merged.
- Evidence date: 2026-11-25, local checkout at the delivery tree (identical to `main`).

## 1. Decision summary

Extract the eight built-in selection strategies from `routing.ts` into one adopted
capability, `modules/strategies/`, with a single behavior-owning entry file, no barrel, no
new dependency, no plugin or registry mechanism, and no configuration change. Routing keeps
discovery, eligibility, reliability, economics, affinity, fallback, scope and dispatch;
it delegates only the final pick from the supplied ordered pool.

Everything below reuses the owner-approved decisions from issue #272 and the CRUX-351
adjudication. No settled question is reopened.

### Owner corrections (2026-11-25) — adjudication

Reconciled against the CRUX-351 register and the #272 owner decisions; no research is
restarted and no settled question is reopened.

| Owner correction | Disposition and mapping |
| --- | --- |
| Approve `modules/strategies/` and this capability boundary | ACCEPT — matches the approved CRUX-351 path contract (`modules/<capability>/`, flexible internal layout, no barrel or package) and #272's directory option. Implemented as planned. |
| Preserve all selection behavior and public type contracts, including numeric edge cases | ACCEPT — behavior and edge characterization are moved, not changed; root re-exports keep the published names, signatures and declarations. Non-finite and missing-metric behavior is characterized in module tests and remains unrepaired, since a fix is a separate decision. |
| Move strategy-specific tests individually; registry/resolver/eligibility/reliability stay system-owned; host-independent fixtures | ACCEPT — the five strategy describes plus the selection-only halves of the mixed tests moved; registry refresh/dedup, resolver, eligibility partition, reliability and the controlled fault oracle stay in `tests/model-selection-properties.test.ts`. Moved fixtures are structural (no host types, no registry, no resolver). |
| Mutation target expansion approved; existing tooling; correct CLI syntax; measured budget | ACCEPT — CRUX-351-09 assigns the changed population to #272. One target added with measured inputs: 61 mutants, 1 s, `secondsPerMutant` 0.016, `MUTANT_ESTIMATE` 61. The CLI takes the target positionally (`node mutation/run.mjs modules/strategies/selection.ts [--dry-run]`); `--mutate` selects a line range and requires a target argument. |
| Restored protected judge verified through PR #353 | ACCEPT — owner evidence closes that prerequisite. This candidate changes no policy input, so the trusted gate compares equal digests. |

## 2. Reconciled research

Diff `f33bd0a..d4d7d10`: 28 files, +1439/−60, tooling/tests/docs only. Over the strategy
owner file set the diff returns only `.dependency-cruiser.cjs`, `knip.jsonc`,
`package.json` and `tsconfig.json`.

| Research claim | Current state |
| --- | --- |
| One selection switch, `minBy`, cost helpers and the strategy union live in `routing.ts` | Confirmed unchanged |
| `config.ts` owns `ALL_STRATEGIES`; `schema.json` duplicates enums | Confirmed unchanged (three enum sites) |
| Callers: `index.ts`, `commands.ts`, `config-agent.ts`, `router.ts` via `resolveConfiguredTier` | Confirmed |
| SDK stays resolve-only; no new SDK export | Confirmed |
| Root test globs would not pick up nested tests | Superseded by #351: full/coverage/quick/acceptance all include module globs |
| Complexity, Knip, dep-cruiser, AST, CRUX, mutation, packaging omit nested paths | Superseded by #351 for every listed tool |
| Installed router inspection is shallow | Superseded: inventory derives from the TypeScript program; installed inspection is recursive with a nested-host-reference control |
| Mutation bindings derive from tests that import the target | Confirmed, and module tests participate automatically |

Consequence: the tooling research is closed. This plan depends only on behavior and
compatibility facts, which still hold at the delivery revision.

## 3. Prerequisite verification

| Concern | Verified evidence |
| --- | --- |
| Full and coverage | `package.json` `test` and `test:coverage` include `modules/*/tests/*.test.ts` and `*.test.mjs` |
| Quick tier | `scripts/test-quick.mjs` selects `moduleTestFiles()` from the shared helper |
| Acceptance | `scripts/acceptance.mjs` `NODE_TEST_GATES` includes both module globs |
| Typecheck | `tsconfig.json` include covers `modules/**/*.ts` |
| Knip | module runtime in `project`; only spawned module tests are `entry` |
| Complexity | `scripts/check-complexity.mjs` `scopeOf` maps module tests to `tests`, module runtime to `source` |
| Architecture | `scripts/toolbox.mjs` roots use `moduleSourceFiles()`; dep-cruiser production and tooling scopes cover `modules/` |
| AST rules | test rules scope `modules/**/tests/*.ts|mjs`; production rules include module source |
| Mutation | `mutation/targets.mjs` `allTestFiles()` includes module tests; `directConsumers()` resolves relative imports, so module tests bind; undeclared targets are rejected |
| Packaging | `files` ships `modules/**/*.ts`, excluding `tests/` and `*.test.ts` |
| Docs | `tests/docs-links.test.mjs` covers module `README.md`/`AGENTS.md` and skips module `tests/` |
| Path contract | Executable unit tests are direct children of `modules/<capability>/tests/`; dot-prefixed capability directories and dot-prefixed test files are not discoverable and are now regression-tested |

A dot-prefixed directory is deliberately not a capability home: the reserved gate globs
cannot reach it, and the executable-test classification was corrected to agree with that.

## 4. Strategy contract (verified behavior)

Probe output against `routing.ts` on the delivery tree:

```
empty            undefined
singleton        identity preserved; cost not accessed
tie              earliest candidate kept
all NaN cost     undefined
all +Inf cost    undefined
overflow sum     undefined
best_value 0/0   undefined
missing cost     throws TypeError (multi-candidate cost strategies)
random 0.999     last candidate
random draws     exactly one call for multi-candidate pools
```

Contract to preserve exactly:

- `first` and `fastest` return the first candidate; list order is meaningful.
- `cheapest` minimizes `input + output`; `cheapest_input` and `cheapest_output` minimize
  their own component; `largest_context` maximizes the context window; `best_value`
  minimizes combined cost per context token.
- Ties keep the earliest candidate; scoring never mutates or reorders the pool.
- Empty pool yields `undefined`; a singleton returns the original object without reading
  metrics or invoking randomness.
- `random` uses the injected draw once, `floor(draw * length)`, and returns the last
  candidate for draws outside `[0, 1)` including `NaN`.
- Unknown strategy names keep the legacy first-candidate fallback.
- No I/O, no host runtime, no dispatch, no credential or settlement effect.

Characterization, not policy change: the lowest comparable score wins and equal
scores keep the earliest candidate. Callers pass validated finite metrics, but
arithmetic on finite inputs can still overflow to `+Infinity` (a cost sum or the
`best_value` ratio), so a pool whose scores are all `NaN` or `+Infinity`
(including overflowing sums and `0 / 0`) has no comparable minimum and yields
`undefined`; in mixed pools a finite score wins, `NaN` never wins, and `-Infinity`
always wins. A missing `cost` object throws for multi-candidate metric strategies.
Valid-domain callers cannot reach those states; the moved doc comments are
corrected to this contract without changing behavior. Any behavior fix is a
separate adjudication.

## 5. Module boundary

```
modules/strategies/
  README.md
  AGENTS.md
  selection.ts
  tests/
    selection.test.ts
    selection-properties.test.ts
```

`selection.ts` owns, and is the only owner of:

- `RoutingStrategy` — the union of the eight built-in names.
- `ALL_STRATEGIES` — the single ordered canonical list.
- `StrategyCandidate` — the minimal structural input `{ cost: { input, output },
  contextWindow }`; host fields and candidate identity stay generic.
- `modelCost`, `modelInputCost`, `modelOutputCost`, `modelContextSize`.
- `minBy` (private) and `selectModel`, moved verbatim in behavior.

```ts
selectModel<M extends StrategyCandidate>(
  candidates: M[],
  strategy: RoutingStrategy,
  random: () => number = Math.random,
): M | undefined
```

Non-responsibilities: discovery, tiers, provider scope, eligibility, sign-in, reserves,
billing preference, reliability and circuits, affinity, fallback, routing rules, host
dispatch, configuration loading and validation, previews, traces.

Direct import direction: `routing.ts` and `config.ts` import the module; the module imports
nothing from the repository. No barrel, no `index.ts`, no package, no registry.

## 6. Compatibility preservation

- `routing.ts` re-exports `selectModel`, `RoutingStrategy`, `modelCost`,
  `modelInputCost`, `modelOutputCost` and `modelContextSize`, so every existing root
  subpath import keeps working.
- `RoutingModelBase` extends `StrategyCandidate`, so host model objects keep passing
  through unchanged and generic identity is preserved.
- `config.ts` re-exports `ALL_STRATEGIES` from the canonical list; the unknown-strategy
  warning path and the per-category precedence stay as they are.
- `schema.json` keeps its static enums; a drift guard in the existing config/schema test
  file compares all three enum sites to the canonical list.
- `router.ts` and the resolve-only SDK are untouched; no new public API.
- Unknown strategy names still select the first candidate; no validation is strengthened.
- Configuration files, defaults, previews, traces and status output are unchanged.

## 7. Test ownership

Module-owned, colocated, directly invocable:

- `modules/strategies/tests/selection.test.ts` — per-strategy contract, deterministic
  fixtures and RNG, candidate identity, input-order and non-mutation, singleton without
  metric access, per-strategy draw counts, outside-pool impossibility, and the
  characterization cases above.
- `modules/strategies/tests/selection-properties.test.ts` — the strategy-specific property
  descriptions currently in `tests/model-selection-properties.test.ts` (documented cost
  formulas, largest context, best value, stable ties, empty and singleton sets, list-order
  strategies, random), including that file's independent expected-name oracle.

System-owned and unchanged:

- `tests/model-selection-properties.test.ts` retains registry refresh and dedup,
  reliability partition and controlled fault sensitivity.
- `tests/routing.test.ts` retains its `selectModel` block as compatibility coverage through
  the root export; `tests/commands.test.ts` keeps its consumer case.
- Routing, eligibility, economics, reliability, host, SDK, package and acceptance suites
  stay where they are.

A named inventory is captured before and after relocation. Totals may grow slightly; the
same behavior must be covered by name, and no required test may silently disappear.

## 8. Mutation

`mutation/config.mjs` gains one target, `"modules/strategies/selection.ts"`, with the
budget from its first dry run. `routing.ts` keeps its target. Module tests bind
automatically because they import the target directly.

Focused execution:

```
node mutation/run.mjs modules/strategies/selection.ts --dry-run
node mutation/run.mjs modules/strategies/selection.ts
```

Report the binding (module tests plus any root consumers), kills, survivors and
limitations. No new scheduled campaign, no budget change, no CI redesign.

## 9. Packaging and distribution

Expected: `modules/strategies/selection.ts` ships as runtime source; module tests,
`README.md` and `AGENTS.md` do not; the router build adds
`dist/router/modules/strategies/selection.js` and its declaration because `routing.ts`
imports it. The nested compiled pair is internal build output reachable through the
existing `./*` behavior, not a new documented API.

Verification uses the existing release and packaged-consumer suites, which derive the
expected router inventory from the TypeScript project graph and inspect the installed tree
recursively. No `files` entry is expected to change.

## 10. Documentation

`modules/strategies/README.md` documents purpose, non-responsibilities, input and output
guarantees, invariants, the exact isolated verification command, and compatibility
constraints. `modules/strategies/AGENTS.md` references repository and local rules and adds
only local boundaries. Root configuration and router API documentation already enumerate
the eight strategies and remain accurate.

## 11. Verification plan

Run at the exact clean head, capture actual output, and re-run after any edit:

```
node --test --experimental-strip-types modules/strategies/tests/selection.test.ts
npm run typecheck
npm test
npm run test:quick
npm run test:integration
npm run test:coverage
npm run check:arch
npm run check:dead-code
npm run check:ast
npm run check:duplication
npm run check:complexity
npm run acceptance
npm run verify:release
```

Plus the focused mutation run and a packaged-consumer check on the produced archive.

`check:complexity` is expected to stay clean: the module lives inside the already measured
`modules/` scope and no policy input changes. If it does not, affected work stops and the
owner is asked before anything else happens.

Fault controls, each applied then reverted:

1. Inverted score comparison re-reds the module strategy tests.
2. Tie replacement re-reds the stable-tie tests.
3. Random bound change re-reds the injected-draw tests.
4. Removing a name from the canonical list re-reds the schema drift guard and the
   completeness test.
5. Removing a compatibility re-export re-reds the root-export compatibility test.
6. Removing a module test file re-reds the inventory comparison and the mutation binding.
7. Excluding module source from the archive re-reds the packaged-source assertion.
8. Making module source import a test root or a dev-tooling path re-reds the architecture
   check.

## 12. Risks and rollback

- Declaration churn if the strategy input type tightens. Mitigation: `StrategyCandidate`
  is a supertype of the current model shape and a consumer compile check is part of
  verification.
- Complexity budget on the new file. The moved switch is small; existing per-file ceilings
  are far above it.
- Test relocation reducing effective coverage. Mitigation: named inventory comparison and
  a red control for an omitted module test.
- Mutation budget for the new target. Derived from the dry run rather than guessed.

Rollback is a revert: no persisted formats, stored state, configuration or migration is
involved.

## 13. Outstanding prerequisites and decisions

Owner action required before production changes:

1. Approve this contract, or request a role-played Crux challenge that is explicitly
   labeled non-independent. Governance still requires an independent challenge and an
   independent exact-head review for merge.
2. Resolve the review path. Classic branch protection requires one approving review,
   self-approval is blocked, and the repository currently has a single collaborator.
3. Confirm the mutation population addition and the test-relocation approach.
4. Confirm the 2 December 2026 Actions event policy condition before this PR rather than
   before the next release. The contract currently runs successfully.
5. Accept and close issue #351, whose tooling prerequisite is delivered.

Verified prerequisite state for reference: ruleset `24633245` is active with no bypass
actors and requires both `release-gates` and `complexity-trusted`; the authentic judge ran
on a benign PR after the migration with equal policy digests `60d818b4…` and empty findings
in both artifacts. The owner independently verified the restored judge through PR #353.

## 14. Approval checklist

- [ ] Boundary `modules/strategies/` with one behavior-owning entry file approved.
- [ ] Compatibility surface (root re-exports, `ALL_STRATEGIES`, SDK, config semantics)
      approved.
- [ ] Test ownership and relocation approved.
- [ ] Mutation target addition approved.
- [ ] Verification list and fault controls approved.
- [ ] Independent challenge and review path scheduled.
