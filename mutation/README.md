# Mutation measurement

Scheduled mutation testing for the Bifrost router. **This is a measurement, not a
release gate.** It never runs on a pull request, never blocks a merge, and a low
score never fails the job — the score *is* the output.

Start here if you want to know what is measured, why the numbers are
trustworthy, or how to add a module.

| File | Owns |
|---|---|
| `config.mjs` | Every tunable. **The only file you edit for a normal change.** |
| `targets.mjs` | Derives the binding from real test imports. Do not hand-list tests. |
| `report.mjs` | Merges shard reports, computes both scores, renders the summary. |
| `workflow.mjs` | `plan` / `plan-cli` / `summarise` / `require-usable` for CI. |
| `run.mjs` | The local runner. |
| `preload-restore-cwd.mjs` | Guards the TAP runner's handshake file. See [Why this exists](#why-preload-restore-cwdmjs-exists). |

The workflow lives at `.github/workflows/mutation.yml`; the narrative guide is
[`docs/mutation-testing.md`](../docs/mutation-testing.md).

## Adding a module

Three edits, one file.

### 1. Declare the target

In `mutation/config.mjs`:

```js
export const TARGETS = {
  // ...
  "inline-override.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.02 },
};

export const MUTANT_ESTIMATE = {
  // ...
  "inline-override.ts": 40,
};
```

- `timeoutFactor` / `timeoutMS` — Stryker's per-mutant timeout is
  `dryRunDuration * timeoutFactor + timeoutMS`. Size it to **this module's** bound
  suite. Too small and genuine mutants report as `Timeout` (which Stryker counts
  as *detected*, inflating the score); too large and a real infinite loop takes
  longer to detect. Start at `2 / 20_000` and raise it if the dry run fails.
- `secondsPerMutant` — measured wall-clock throughput. Start with a placeholder
  (`0.02` is a reasonable guess) and replace it in step 2.
- `MUTANT_ESTIMATE` — a **planning input** for budget and shard arithmetic only.
  The report always carries the real counts. Set it to the reported total in
  step 2 so planning reflects reality.

Nothing else needs touching. The matrix, artifact names, shard planning, the
summary and the gate all derive from `TARGETS`.

### 2. Get the real numbers

Run every command from the **checkout root** (the worktree root, not a
subdirectory) — the scripts resolve paths relative to it.

```bash
node mutation/run.mjs inline-override.ts --dry-run   # binding + sandbox, no mutants
time node mutation/run.mjs inline-override.ts        # full run, measure the cost
```

`--list` shows every target with its estimate, shard count and bound files.

You will edit `mutation/config.mjs` a **second time** here, and that is expected.
Set `secondsPerMutant` to `elapsed_seconds / mutant_count` from the run above, and
`MUTANT_ESTIMATE` to the mutant total the run reported. Both are planning inputs,
so a placeholder only affects the projection, never a reported score.

Use the process wall clock (`time`), not Stryker's `Done in N seconds` — for a
small module the per-process startup dominates and Stryker's own figure rounds to
zero, which would record a cost that is wrong in the optimistic direction.

### 3. Watch the budget

```bash
node mutation/workflow.mjs plan     # refuses if the matrix cannot fit 60 minutes
```

If the projection is over budget, the plan fails in seconds naming the module.
**Shard it — never trim the mutant population to fit.** Sharding multiplies
machines; it does not change what is measured.

Sharding is automatic: `suggestedShards()` splits a module into as many legs as
needed to land each under `targetLegMinutes` (30), capped at `SHARDING.maxShards`
(4). Each shard is its own parallel job.

Finally, run the suite:

```bash
node --test --experimental-strip-types tests/mutation-workflow.test.mjs
```

A normal target addition needs **no test edit** — the existing assertions iterate
`TARGETS`, so they cover a new entry automatically. Extend the suite only if you
add a new invariant specific to this module. If you also added a `RUNNER_OVERRIDES`
entry, the test requires it to carry a reason.

## Choosing a module

Prefer modules that are **routing, state, reliability or config precedence** —
logic where a silent wrong answer is expensive. Leave out anything where a
surviving mutant is expected rather than informative:

- **Formatting and output strings.** A mutant that changes a log line survives
  because no test asserts it. That is not a test gap worth acting on.
- **Modules only exercised through a heavy integration path.** A 1-mutant module
  bound to a 30-second suite costs more wall clock than it returns.
- **`index.ts`, `tests/helpers.ts`, `config.ts`.** These appear bindable (16, 32
  and 18 consumers) but mutating a helper invalidates the suite that depends on
  it; the binding is broad and the signal is diffuse.

As of writing, 5 of the 55 bindable root modules are targeted. Sizes worth
starting with, smallest first: `inline-override.ts` (41 lines, 1 bound test),
`virtual-override.ts` (52), `reliability-v2-routing.ts` (53),
`reliability-observation-projection.ts` (70).

## The binding is derived, never listed

`bindingFor(target)` = every test file under `tests/` that imports the module
directly, minus tests that read the module's own source text.

This replaced a hand-written list that had drifted badly: `reliability.ts` has 15
direct consumers and `routing.ts` has 10, but the old config bound five files
across four modules. Most reported survivors were measuring absent tests, not
weak ones. **Never hand-list test files** — the derivation is the whole point.

If a module has no bindable consumers, `bindingFor` throws rather than measuring
an empty population.

### The self-referential exclusion

A test that reads the target's *source bytes* cannot be bound to it: Stryker
rewrites that source to insert each mutant, so an assertion against the original
text fails and the dry run dies before a mutant is measured. Both of these shapes
are excluded automatically:

```js
readFileSync(join(ROOT, "routing.ts"), "utf8")          // inline read
const SOURCE = new URL("../x.ts", import.meta.url)      // then readFileSync(SOURCE)
```

A normal `from "../target.ts"` import is a legitimate binding and is not excluded.

## Reading the two scores

The summary publishes both, always. They answer different questions.

| Score | Formula | Question |
|---|---|---|
| Stryker | `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)` | How much did the suite detect, counting timeouts as detected? |
| **Honest** | `Killed / (Killed + Survived + NoCoverage)` | How much did the suite actually assert? |

Timeouts are excluded from the honest numerator and reported as their own column.
A `Timeout` can be a genuine infinite-loop detection, or it can mean the budget
was too small for the suite — indistinguishable in the report. Crediting them
silently is how a broken budget turns into a 99.43% score. Measured case: eight
bound files, 208 of 352 mutants reported as timeouts.

`NoCoverage` counts against the honest score because a mutant no test reaches is
a mutant no test asserts. This is why `reliability-v2.ts` sits at 58.5%: 307 of
its mutants are unreached, largely because one test file
(`tests/reliability-v2-state-machine.test.ts`) holds 77% of the module's
assertions. Splitting that file is the single highest-value follow-up.

## The usability gate

A score over a silently smaller population is worse than no score. `require-usable`
fails the run (not the merge) when:

| Condition | Tolerance | Why |
|---|---|---|
| No module reports | — | Nothing was measured |
| Missing module report | — | A matrix leg did not run |
| Missing **shard** | — | The module reports, but only part of it measured |
| `Timeout` mutants | `max(10, 2%)` | Budget collapse is indistinguishable from real timeouts |
| `RuntimeError` + `CompileError` | `max(5, 2%)` | **Stryker excludes these from the denominator** |
| Shard conflicts | 0 | Overlapping shards disagreed — not reproducible |

The error row is the important one. Stryker drops errored mutants from the score,
so 320 errors out of 388 prints a confident score over the surviving 68 with
nothing in the output saying so. Measured, from a test calling `process.chdir()`.

Override the timeout tolerance from a dispatch with `timeout_tolerance`; leave it
blank for the calibrated default. The override is stored at the top level of
`summary.json`, which is where the gate reads it.

## Time budget

Self-imposed **60 minutes**, well inside GitHub's 6-hour job limit. Measured
full run on a 4-core runner: **19 minutes, 4,185 mutants, 62.75% honest**.

```
wall clock = setup + plan + max(leg) + summarise
             └────── reserveMinutes: 12 ──────┘   └─ slowest leg ─┘
```

Today: 5 legs, one per module, projecting **34.5 minutes**.

`ciSlowdownFactor: 3` converts a 10-core local measurement into a 4-core runner
estimate. Measured ratios were `routing.ts` 2.7× and `reliability-v2.ts` 3.9×.
Plan at 1.0 and the local run passes while CI quietly overruns.

**Known gap — the projection ignores queueing.** It computes `max(leg) + reserve`,
assuming every leg starts at once. With 5 targets at `concurrency: 4` this happens
to be exact. It stops being exact once several *large* modules are added:

| Added | Projected | Actual |
|---|---|---|
| 5 small (~1m) | 34m | 34m |
| 10 medium (~5m) | 34m | 34m |
| 5 large (~20m) | 34m | **52m** |

The plan would pass at 34m and the run would take 52m. Not a correctness break —
the per-leg 48m job timeout still bounds each leg and the gate still rejects a
wrong score — but the one-hour promise would be missed silently.

Headroom before this bites is large. At today's mix, room remains for roughly 31
more modules at ~5 minutes each, or ~160 at ~1 minute. **Fix this the day you add
a sixth target above ~10 minutes**, by replacing `max(leg)` with greedy packing
across `concurrency` slots (~10 lines in `planMatrix`, no config change).

## Runner choice: Bun by default, TAP when the verdict depends on the engine

`bun` is the default because it reports coverage **per test**, so each mutant runs
only the tests that reach it. TAP reports per file, so each mutant pays the whole
file. Measured on identical mutants:

| Module | TAP | Bun |
|---|---|---|
| `cache.ts` | 27s | 4s |
| `reliability-v2.ts` | 5m30s | 10s |
| `routing.ts` | 5m31s | 1m16s |

A/B agreement: **1,727 of 1,731 mutants identical**. `routing.ts` is the only
module on TAP, and the divergence is real: `^(a+)+$` on a 25-character canary
takes **V8 475ms vs JavaScriptCore 66ms**. When a mutant bypasses the backtracking
probe the regex runs in the host process, so only the production engine gives the
answer production gives. Subprocess pinning did not fix it.

To add an override, edit `RUNNER_OVERRIDES` — with a **reason**, which a test
requires. Two reasons are legitimate: Bun cannot run a bound test at all, or the
verdict differs between engines.

## Edge cases worth knowing

**`disableTypeChecks: false` is mandatory.** Stryker's default injects
`// @ts-nocheck` at the top of every sandbox `.ts` file, which breaks tests hashing
committed files *and* shifts every line number by one, misattributing every
survivor. Node strips types at runtime anyway, so the directive buys nothing.

**Never run two mutation runs in the same directory.** The TAP runner writes its
handshake file relative to cwd. Deleting `.stryker-tmp` mid-run produced 320 of
388 `RuntimeError`.

**`--incremental` is banned for authoritative runs.** With
`coverageAnalysis: "off"` Stryker's differ returns `true` unconditionally
(`if (!testCoverage.hasCoverage) return true`). Measured: after editing a bound
test file, **228 of 229** results were reused and the stale score republished.
It is opt-in for local loops only, with one state file per target.

**Line-range shards must overlap.** Adjacent ranges drop mutants that straddle a
boundary: `1-100` + `100-244` recovered 176 of 229 mutants for `cache.ts`.
Overlapping `1-140` + `120-244` recovers all 229; the 23 measured twice agreed on
status every time.

**Mutator-based sharding is not usable.** `excludedMutations` still instruments
excluded mutants as `Ignored`, and the evaluated sets were not complementary (4
phantom `CallExpression` mutants).

**Stale reports are cleared per target.** The summariser merges every `*.json` in
`reports/mutation/`, so a previous run's file would be counted. Clearing matches
exact names only — `cache.ts` must never delete `cache-classifier.ts.json`. An
explicit `--report` clears only its own file, so two manual per-shard runs do not
delete each other.

**`--shards` applies to one target.** A shard is a slice of one module; applying
it across several would make report names ambiguous.

**Do not run tests that call `process.chdir()` without restoring.** That is what
`preload-restore-cwd.mjs` guards, below.

### Why `preload-restore-cwd.mjs` exists

The TAP runner writes its handshake file relative to the working directory. A
bound test that calls `process.chdir()` and then throws — which is exactly what a
mutant can cause — leaves the file elsewhere, and the runner reports the mutant as
`RuntimeError`. Stryker then excludes it from the score. Measured on a 227-mutant
slice: **4 errors before the guard, 0 after**, and the run got **26% faster**
because failing mutants stopped paying the error path.

It must load **before** Stryker's coverage hook (Node runs `exit` listeners in
registration order), which is why `TAP_NODE_ARGS` lists it first. The path is
resolved absolute by `targetConfig` because the runner spawns from the sandbox and
a relative `-r` fails the dry run there.

## Running locally

```bash
npm ci
node mutation/run.mjs --list                     # targets, budgets, shards, bindings
node mutation/run.mjs cache.ts                   # one module, full run
node mutation/run.mjs                            # every target, sequentially
node mutation/run.mjs cache.ts --shards 2        # split one module
node mutation/run.mjs cache.ts --mutate cache.ts:1-140   # one region
node mutation/run.mjs cache.ts --incremental     # local loop, reuse unchanged
node mutation/run.mjs cache.ts --dry-run         # check binding, no mutants

node mutation/report.mjs --dir reports/mutation --out /tmp/mutation.md
```

**Prerequisites:** Node 24 and **Bun 1.4.0**. Four of five modules run under
`bun test`, so `bun` must be on `PATH`. `routing.ts` uses TAP and does not need
it. There is no per-invocation runner flag; the choice is `RUNNER_OVERRIDES`.

`--report` names one output file and clears only that file. Normal runs clear the
target's whole report set first, because a stale file would be merged into the
score.

## In CI

Nightly at 04:47 UTC, plus `workflow_dispatch`. Every dispatch input defaults to
the nightly's behaviour, so a bare manual run measures the same thing.

| Input | Default | Meaning |
|---|---|---|
| `target` | `all` | Module name, or `all` |
| `shards` | `0` | 0 = auto from measured cost; 1 = no sharding |
| `concurrency` | `4` | Stryker workers, 1–16 |
| `timeout_tolerance` | blank | Blank = `max(10, 2%)` |
| `fail_on_unusable` | `true` | Fail the job on an unusable measurement |

There is **no `upload_reports` switch**. The leg upload is the only transport a
report takes to the summariser, so it is unconditional; a retention knob that
could skip it would turn a good run into "every module missing".

The `plan` job validates inputs before any work starts and emits the matrix,
the selected targets and the per-target shard counts. The summariser judges
completeness against **that plan**, not against every configured target — so a
single-module dispatch is not four missing modules, and a lost shard is named.

`workflow_dispatch` cannot run a workflow that is not on the default branch
(`HTTP 404`). To exercise changes from a feature branch, add a temporary
`push:` trigger, watch the run, then remove it — the test suite asserts there is
no `push:` trigger in the merged workflow.

## Extending this module

Two additions have been evaluated and are not implemented, because neither is
needed while the nightly fits in 34.5 minutes:

1. **Greedy packing in the projection.** See [Time budget](#time-budget). ~10
   lines, needed only when `max(leg)` stops reflecting real concurrent execution.
2. **Snapping shard boundaries to mutant-free lines.** 87 of `cache.ts`'s 244
   lines produce no mutants, so a boundary can be placed where no mutant straddles
   it, removing the need for overlap entirely. Strictly better than overlapping,
   but only matters once sharding is actually used.

Also deliberately skipped: `typescript-checker`. Measured **0**
`RuntimeError`/`CompileError` across 1,727 mutants, so per-mutant type checking
buys nothing for its cost.

## Measured baseline

Full local run, 8m48s, 0 errors:

| Module | Runner | Mutants | Killed | Survived | NoCoverage | Timeout | Honest |
|---|---|---|---|---|---|---|---|
| `cache.ts` | bun | 229 | 172 | 48 | 9 | 0 | 75.11% |
| `classifier-semantics.ts` | bun | 157 | 85 | 26 | 46 | 0 | 54.14% |
| `reliability.ts` | bun | 352 | 251 | 93 | 8 | 0 | 71.31% |
| `reliability-v2.ts` | bun | 2447 | 1432 | 707 | 307 | 1 | 58.54% |
| `routing.ts` | tap | 1000 | 681 | 214 | 98 | 7 | 68.58% |
| `inline-override.ts` | bun | 21 | 19 | 2 | 0 | 0 | 90.48% |
| **All** | | **4206** | **2640** | **1090** | **468** | **8** | **62.89%** |

CI (4-core): 19 minutes for the original five. `inline-override.ts` adds 21
mutants and 1.3 seconds, and is held at the one-minute floor in the projection
(`estimatedMinutes` never returns less than 1), so the plan stays at 34.5m.

Its two survivors are genuine test gaps, both on the `firstWord` regex at
`inline-override.ts:28`:

- `/^([a-zA-Z]+)\s+/` → `/([a-zA-Z]+)\s+/` (dropped the `^` anchor) — nothing
  asserts that a tier name appearing later in the prompt is not matched.
- `/^([a-zA-Z]+)\s+/` → `/^([a-zA-Z]+)\s/` (`\s+` → `\s`) — nothing asserts that
  multiple spaces or a tab after the first word still parse as an override.
