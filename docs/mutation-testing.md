# Mutation testing

Mutation measurement for the core policy modules. This is a **scheduled
measurement**, not a release gate: it never runs on a pull request and never
blocks a merge. Results are published on the workflow run page and as artifacts.

Run: [`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml),
nightly at 04:47 UTC from the default branch.

## Why it is not a merge gate

A full run is far too slow to gate on. A per-pull-request subset would measure a
different mutant population each time, so the number would not be comparable
across runs — which is the only thing that makes it useful. One nightly run over
the whole target set keeps the score comparable over time.

## The one-hour planning budget

The measurement targets a **60-minute** wall clock. That number is a **planning
objective, not a hard deadline.** GitHub Actions offers no workflow-wide
wall-clock limit, so nothing can enforce one; a plan can only refuse to start an
infeasible matrix and bound each job individually. Both of those are done, and
both are stated below rather than implied.

GitHub's own limits are 6 hours per job and 35 days per run
([Actions limits](https://docs.github.com/en/actions/reference/limits)) and
neither can be raised. Staying far inside them is voluntary: a measurement that
takes an hour is one nobody reruns, and one that hits the platform limit fails
after burning the entire window.

The budget is met by **sharding, never by measuring fewer mutants**. Sharding buys
wall clock with machines; it does not touch the mutant population, the binding, or
the thresholds. `TIME_BUDGET` and `MATRIX` in
[`mutation/config.mjs`](../mutation/config.mjs) hold the knobs:

```
cap 60m | reserve 12m | CI factor 3.0x | hard/leg 48m | target/leg 30m | lanes 8

cache.ts                1.0m  shards 1 ->  1.0m/leg
classifier-semantics.ts 1.0m  shards 1 ->  1.0m/leg
inline-override.ts      1.0m  shards 1 ->  1.0m/leg
reliability.ts          1.0m  shards 1 ->  1.0m/leg
reliability-v2.ts       4.8m  shards 1 ->  4.8m/leg
routing.ts             22.4m  shards 1 -> 22.4m/leg   (TAP: production engine)
```

Real `node mutation/workflow.mjs plan` output:

```
targets: cache.ts, classifier-semantics.ts, inline-override.ts, reliability.ts, reliability-v2.ts, routing.ts
matrix legs: 6 (concurrency 4)
projected wall clock: 34.5m of the 60m planning budget, 1 wave(s) of 6 leg(s) across 8 lanes (per-leg hard bound 48m)
the projection is a planning objective, not a deadline: GitHub enforces no workflow-wide wall clock
```

Sharding is currently **unused**: six legs fit in one wave, so the plan projects
34.5 minutes. The machinery stays because a future module may outgrow the budget,
and the plan switches to shards automatically when it does.

### How the projection is computed

```
wall clock ~= reserveMinutes + longest lane
lanes       = MATRIX.maxParallel (must equal the workflow's max-parallel)
```

`projectWallClock()` in [`mutation/workflow.mjs`](../mutation/workflow.mjs) packs
legs through those lanes in one possible dispatch order — the matrix order,
starting the next leg when a lane frees. **GitHub does not guarantee matrix
execution order** ([docs](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs));
it only guarantees that at most `max-parallel` jobs run at once. So this is a
projection assumption, not a dispatch guarantee, and a different order can take
longer than projected. The previous formula was `max(leg) + reserve`, which
assumed every leg started simultaneously. That is exact only while the leg count
is at or below the lane count. Six modules sharded four ways is 24 legs, and the
large modules' legs are listed last, so under the modelled order they start after
the earlier waves drain:

```
node mutation/workflow.mjs plan            # SHARDS=4
matrix legs: 24 (concurrency 4)
projected wall clock: 18.1m of the 60m planning budget, 3 wave(s) of 24 leg(s) across 8 lanes
```

`max(leg)` would have said 17.6m — the difference is the wait before the long legs
are dispatched. A test asserts `MATRIX.maxParallel` matches `strategy.max-parallel`
in the workflow, so the two cannot drift.

### Why it is still only an estimate

- GitHub scheduling, image pulls and `npm ci` add delay the planner cannot see.
- Shards overlap by `SHARDING.overlapLines`, so each leg covers slightly more than
  an even share of its module; the projection divides evenly and understates it.
- A leg that overruns its estimate has no workflow-wide deadline to stop it.

### What is actually enforced

- **The plan refuses an infeasible matrix before any job starts.** A module that
  cannot fit even at `SHARDING.maxShards` fails in seconds with a named module,
  rather than running long and failing later. The cap is never met by measuring
  fewer mutants.
- **Each leg gets its own job timeout** from the plan (48 minutes, the per-leg hard
  allowance). A single global ceiling would either cut a slow shard short or let
  one stuck leg burn the window.
- **The summarise job has its own 15-minute timeout**, and never runs longer than
  the merge and render it does.
- **The usability gate** fails a run whose measurement is incomplete, whatever the
  clock says; see [the usability gate](#the-usability-gate).

If a module cannot fit even at `maxShards`, the plan fails in seconds with a
message naming the module and the arithmetic. It never silently drops mutants.

## The runner choice is the whole design

Stryker's `testRunner` decides everything downstream. Three were measured on the
same mutants, and both viable ones produce the same kills.

| Runner | Coverage | `cache.ts` (229) | `routing.ts` (989) | `reliability-v2.ts` (2447) | Incremental |
| --- | --- | --- | --- | --- | --- |
| `command` | `off` (unmeasured) | 4m38s | 19m20s | ~92m (projected) | reuses blindly |
| `tap` | per **file** | 27s | 5m31s | ~23m/shard × 4 | correct |
| `bun` | per **test** | **3s** | 1m16s (not used — see below) | **1m35s** | correct |

**Bun is the default.** `@hughescr/stryker-bun-runner` runs `bun test`, which
executes this repository's `node:test` files unchanged — verified: the 27 files
bound to Bun-run modules ran 679 tests with 0 failures under Bun 1.4.0. Because
coverage is attributed per individual test, a mutant runs only the tests that
reach it (~8 per mutant) instead of whole files, so a module bound to one heavy
file no longer pays that file's runtime per mutant. That is the entire speed
difference.

**`routing.ts` stays on TAP, for a different reason.** Its rule tests
deliberately let a catastrophic regex run in-process when a mutant bypasses the
backtracking probe, and the engines disagree: `^(a+)+$` against a 25-character
canary took **475 ms under V8 and 66 ms under JavaScriptCore**. A measured A/B
left 4 of 1,000 mutants with different verdicts, all in that region. Only the
production engine answers the question production would ask, so this module runs
on Node. Cost: 13.5 planned minutes instead of 2.3.

The probe itself was also pinned: it spawned `process.execPath`, which is `bun`
under Bun, so the probe ran a different regex engine than production. It now
spawns `node` (overridable with `BIFROST_PROBE_NODE`, falling back to the hosting
runtime when `node` is absent). That made the probe deterministic but did not
remove the divergence above, because the mutated path runs the regex in the host
process, not the probe.

**Every other module uses Bun.** One bound test used to block it:
`tests/reliability-migration.test.ts` asserted Node's `fsync`-on-lock-file
failure by patching `node:fs`. Bun cannot do that — `syncBuiltinESMExports()` is
a no-op there, and a `node:fs` mock cannot be undone — so the test injected no
fault at all and its "tolerated" assertions passed for the wrong reason. It now
injects the fault by editing a private source copy, which works on both runtimes.

`RUNNER_OVERRIDES` in `mutation/config.mjs` carries the reason a module deviates
from the default runner; today it has exactly one entry: `routing.ts` uses `tap`
because its verdict depends on the production regex engine. Five modules use
Bun. A test asserts that any future override names a reason.

Three properties hold for both runners, and all three were measured:

1. **Per-test selection.** A mutant runs only the tests (Bun) or files (TAP) that
   reach it, not the whole binding.
2. **Incremental is safe.** With the command runner, editing
   `tests/cache.test.ts` reused 228 of 229 stored results and republished the
   stale score: Stryker's docs list that runner as reporting "Nothing", and its
   differ then reuses unconditionally (`if (!testCoverage.hasCoverage) return
   true`). With TAP the same edit is seen as "Tests: 1 files changed" and
   correctly invalidates 157 of 229.
3. **`NoCoverage` is real.** The command runner reported 0 uncovered mutants
   because coverage was never measured. Measured coverage reports 9 for
   `cache.ts` and 95 for `routing.ts` — genuine gaps.

### Agreement between the runners

Measured on current HEAD, each engine run twice from a clean `.stryker-tmp`.

`cache.ts`, 229 mutants, full population:

| Run | Killed | Survived | NoCoverage | Errors |
|---|---|---|---|---|
| bun, run 1 | 172 | 48 | 9 | 0 |
| bun, run 2 | 172 | 48 | 9 | 0 |
| tap, run 1 | 172 | 48 | 9 | 0 |
| tap, run 3 | 172 | 48 | 9 | 0 |

All 229 mutants agree between engines, and Bun is deterministic across repeats.

`inline-override.ts`, 21 mutants: **21 of 21 identical** on both engines, both
repeats. Bun is chosen for speed.

`reliability-v2.ts`, a 291-mutant slice (`495-575`):

| Comparison | Identical | Differ |
|---|---|---|
| Bun run 1 vs Bun run 2 | 287 / 291 | 4 |
| Bun run 1 vs TAP run 1 | 287 / 291 | 4 |

**Three of the four cross-engine differences are also differences between two
identical Bun runs.** That slice reads `now` and expiry values, so those mutants
are genuinely non-deterministic; a verdict comparison there cannot attribute a
difference to the engine at all. The A/B method is only informative on mutants
that are stable within one engine, and this measurement is the reason the
earlier "226 of 227 identical, one `ObjectLiteral` at line 221 that Bun killed
and TAP missed" claim has been removed: on current HEAD that mutant is killed by
**both** engines, and the specific figure is not reproducible.

`routing.ts` is the case where the engine demonstrably decides the verdict, and it
is the only override: `^(a+)+$` against a 25-character canary takes **475 ms under
V8 and 66 ms under JavaScriptCore**, and the rule tests deliberately let that
regex run in the host process when a mutant bypasses the backtracking probe. Only
the production engine answers the question production would ask.

**Remaining limitation.** Equivalence is established by measurement, not by proof.
Bun is trusted for a module because its verdicts match the production engine on
that module within the module's own noise floor. A module whose tests depend on an
engine-specific behaviour that no sampled mutant exercises would not be caught by
this. The mitigation is the override mechanism plus this measurement: if a module
starts depending on engine semantics, it moves to TAP and records the reason.

### Incremental is a local convenience, never the nightly

The nightly must measure every mutant, so `incremental` is **off by default** and
only enabled by `node mutation/run.mjs --incremental`, with one state file per
target under `reports/mutation/.incremental-<module>.json`. Reusing results
across nights would publish a score for code paths the run never touched —
incremental cannot see dependency updates, environment changes, or fixtures.

Only the TAP runner's invalidation was measured, so `--incremental` is restricted
to targets on it (`routing.ts`), and it cannot be combined with `--shards`: the
state file is per module, so two shards would share one record.

## How it works

Each target is its own matrix job, so each module gets a timeout budget sized to
its own bound suite. This is a correctness requirement, not a speed
optimisation: a single shared budget sized for the fastest module reports every
slower module's mutants as `Timeout`, and Stryker counts a timeout as
**detected**, which inflates the score instead of failing the run. A measured
eight-file reliability binding produced 208 of 352 mutants as timeouts and a
reported 99.43%.

Everything lives in one directory, [`mutation/`](../mutation), with a single
config file to tune:

| Piece | Location |
| --- | --- |
| **All tunable parameters** — targets, per-module budgets, Stryker options, thresholds, tolerance, summary limits | [`mutation/config.mjs`](../mutation/config.mjs) |
| Target/binding derivation (reusable, no config) | [`mutation/targets.mjs`](../mutation/targets.mjs) |
| Summary, scores, survivor extract | [`mutation/report.mjs`](../mutation/report.mjs) |
| Workflow helpers | [`mutation/workflow.mjs`](../mutation/workflow.mjs) |
| Local runner | [`mutation/run.mjs`](../mutation/run.mjs) |
| Stryker entry point (thin shim, no options) | [`stryker.config.mjs`](../stryker.config.mjs) |

`mutation/config.mjs` is the only file to edit for a normal change:

- `TARGETS` — which modules are measured, each one's `timeoutFactor` /
  `timeoutMS`, and its measured `secondsPerMutant` (with `MUTANT_ESTIMATE`, this
  drives the cost/shard planning).
- `TEST_RUNNER` — the default runner (`bun`). See the section above; this is the
  setting that decides everything else.
- `RUNNER_OVERRIDES` — per-target runner overrides with a stated reason (today:
  `routing.ts` -> `tap`, because its verdict depends on the production regex
  engine). Five modules use Bun.
- `TAP_NODE_ARGS` — how `node:test` is invoked for the TAP runner.
- `STRYKER_OPTIONS` — `checkers`, `thresholds`, reporters, `disableTypeChecks`.
- `SHARDING` — overlap width, max shards, and the cost threshold that triggers it.
- `SANDBOX_IGNORES` — what is not copied into the Stryker sandbox.
- `TIMEOUT_TOLERANCE` — when a run is too full of timeouts to trust.
- `SUMMARY` — how many survivors to show per module.

Adding a module to `TARGETS` and `MUTANT_ESTIMATE` is the only edit needed: the
workflow matrix, local runner, binding derivation and summary all read from them.
A missing planning estimate fails the plan instead of dropping the module. The
derivation helpers in `targets.mjs` are plain functions over the file tree, so
they are reusable without the config (for example to answer "which tests import
this module?").

## Binding is derived, not hand-written

The binding for a module is every test file that imports it directly, resolved
from the test sources at run time. The issue #62 configuration hand-wrote five
files for four modules, and that list undercounted: `reliability.ts` has 15
direct consumers and `routing.ts` has 10. Most of its survivors measured absent
tests rather than weak tests. Measured effect of the derived binding on the same
mutant population:

| Module | Hand-written binding | Derived binding |
| --- | --- | --- |
| `cache.ts` | 64.19% | 75.11% |
| `classifier-semantics.ts` | 26.75% | 54.14% |

Tests that reach a module only through a caller are still not bound, so every
score here is a **lower bound**.

## Three scores, each with an explicit denominator

One number cannot answer three different questions. The summary therefore reports
three, with the formula for each stated in the output rather than implied:

| Score | Formula | Question it answers |
|---|---|---|
| **Population** | `Killed / (total - Ignored)` | Of every mutant the tool evaluated, how many did the tests kill? |
| **Conclusive** | `Killed / (Killed + Survived + NoCoverage)` | Of the mutants that reached a conclusion, how many did the tests catch? |
| **Stryker** | `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)` | Stryker's own native score |

**Read population first.** It is the only one of the three that cannot be read as
"the tests caught it". A timeout, a runtime error and a compile error all stay in
its denominator and never reach its numerator, so an unresolved mutant can never
be mistaken for a verified kill.

The earlier pair was Stryker's score and one called the **honest score**,
`Killed / (Killed + Survived + NoCoverage)`. That name was wrong: a run with one
kill and nine timeouts reported 100%, because timeouts sat in neither the
numerator nor the denominator. It is mathematically valid as a rate over
conclusive outcomes and misleading as a rate over the population. It is now
called **conclusive** and is presented alongside population instead of instead of
it.

`NoCoverage` stays in the conclusive and population denominators: a mutant no
bound test reaches is a mutant no test asserts. `Ignored` mutants are excluded
from the population denominator, because Stryker never evaluated them and counting
them would penalise a run for mutants it was told to skip. Every raw count —
`Killed`, `Survived`, `NoCoverage`, `Timeout`, `RuntimeError`, `CompileError`,
`Ignored`, `total`, `evaluated`, `unresolved` — is preserved in `summary.json`, so
any score can be recomputed from the payload.

None of the three is enforced as a merge gate. A low score is the measurement, not
a failure.

## The usability gate

A score computed over a silently smaller population is worse than no score, so
the run's own workflow fails when the measurement is unusable. It never fails on a
low score.

| Condition | Allowance | Why |
|---|---|---|
| No module reports | — | Nothing was measured |
| A module report is missing | — | A matrix leg did not run |
| A planned **shard** is missing | — | The module reports, but only part of it measured |
| A module reports **zero mutants** | — | It parsed and carries nothing; 0/0 is not a perfect score |
| `Timeout` mutants | `max(10, 2%)` aggregate **and** per module | A budget collapse is indistinguishable from genuine timeouts |
| `RuntimeError` + `CompileError` | `max(5, 2%)` aggregate **and** per module | Stryker **excludes** these from its denominator |
| A report for a module **outside the selected set** | 0 | It is excluded from the score; its presence still means the artifact set is not the planned one |
| A report whose **measurement identity** differs | 0 | It measured different bytes (revision, binding or config), so it must not be merged |
| **Two files claiming one shard** | 0 | `<module>.json` is shard 0, so it collides with `<module>.shard0.json` |
| An **unstamped** report | 0 | Provenance is unknown, so nothing establishes what it measured |
| A module whose mutants are **all `Ignored`** | 0 | `total` is non-zero but nothing was evaluated |
| A shard **outside** the plan | 0 | A stale or misrouted artifact was merged; missing-shard detection cannot see it |
| Shard conflicts | 0 | Overlapping shards disagreed, so the run is not reproducible |

**Both the aggregate and each module are judged**, against the same calibrated
rule applied to each population. Aggregate-only checks could hide a broken module
inside a healthy run: 80 errored mutants out of 229 is 35% of that module, but it
sits under the aggregate error allowance of 85 for a 4,200-mutant run, so the gate
accepted the run and published a confident score while one module had measured
almost nothing. The failure now names the module and prints its observed and
allowed counts.

A dispatch may raise the timeout allowance with `timeout_tolerance`. It is an
absolute count and it bounds **each module as well as the aggregate**; otherwise
the override would pass the aggregate check and still fail the module that needed
it.

A few timeouts are legitimate and expected: a mutant that inverts a loop bound or
decrements a counter instead of incrementing it genuinely does not terminate.
`routing.ts` produces 7 of 989 (0.7%) this way. The tolerance separates those from
a budget collapse, which lands an order of magnitude higher — the measured
eight-file case was 208 of 352 (59%).

A run that fails this gate **still publishes its summary**, report and survivors.
Failing the measurement is not the same as discarding the evidence.

## Report provenance and ownership

A Stryker report carries no revision or measurement identity, so a directory of
reports is not by itself evidence of one coherent measurement. Two mechanisms
close that:

- **A stamped content identity.** The runner writes
  `bifrost.measurement` into every report: a SHA-256 of the mutated module's
  bytes, the local modules it and its bound tests import, and
  `mutation/config.mjs`, the binding rules, the Stryker shim and
  `package-lock.json`. The identity is **per
  module**, because that is the population one measurement covered. The
  summariser recomputes it and rejects a report that does not match — a different
  revision, a different binding, a different config — naming the file and both
  identities. A per-run scalar could not express this: modules have different
  populations, so one value would accept everything or reject everything.
  Because provenance travels inside the artifact, the download pattern does not
  need to encode it, and staying `mutation-report-*` keeps a partial re-run
  working: scoping it to `run_attempt` would hide the legs that were not retried.
- **One file per shard.** An unsharded `<module>.json` parses as shard 0, so it
  collides with `<module>.shard0.json`. Two files claiming one shard are two
  measurements of it, and merging them would publish a composite that no run
  produced. The module is rejected with both file names.

**A report records what it measured.** An unsharded `<module>.json` stands for the
whole module, so a partial `--mutate` run must name its artifact explicitly and is
rejected if an unsharded report carries a line-range scope: a one-shard plan would
otherwise publish a score over part of a module as though it were all of it.
Sharded reports may carry ranges, because that is what a shard is.

**A payload records what it measured, and is checked again when read.** The
reporter writes `measuredIdentity` per module; `require-usable` re-derives the
identity from the checkout and rejects a payload that no longer matches, or one
that records none. Without this a summary from an earlier commit re-gated as
usable forever. The identity includes the bound test files, so a test edit
invalidates a stored result the same way a module edit does.

**A corrupt artifact claims its slot.** Unreadable reports are not dropped: a
truncated upload in a newer attempt must not let the previous attempt publish as
current, so the module is rejected with the file and attempt named. A corrupt
older attempt is superseded by a readable newer one.

**A shard's declared range must equal the plan's range for its index.** The
plan is derived from the module and the requested shard count, never from the
files present, so a truncated, extended, swapped or out-of-range shard is
rejected rather than merged. Overlap between adjacent planned ranges is
preserved and deduplicated by mutant identity; conflicting verdicts for one
mutant block the measurement.

**Artifacts stay separate until selection.** The summarise job downloads with
`merge-multiple: false`, so each artifact keeps a directory named after itself —
which carries the attempt. The reporter takes the newest attempt per
`(module, shard)` and rejects two reports for one shard within an attempt. That
supports "re-run failed jobs" without letting extraction order decide a result.

**The reporting root must resolve inside the checkout.** A symlinked `reports/`
redirects writes and deletions, so the default boundary is validated before
anything is created.

**Report output is confined to `reports/` on resolved paths.** Lexical
containment is not a boundary: a path spelled inside `reports/` whose parent is a
symlink elsewhere is followed by `writeFileSync` and `unlinkSync`. Each component
that exists is resolved before the boundary test, so such a path is refused.
Deletion uses the spelled path, since removing a symlink removes the link rather
than its target, and a symlinked report *file* is refused outright so "remove our
own output" is unambiguous. Components that do not exist yet are allowed: creating
them creates exactly what they name. Cleanup fails closed.

**A dry run measures nothing, writes nothing, and clears nothing.** Deleting the
previous measurement would destroy a real result to make room for a report that is
never produced. `--dry-run` is also refused together with `--report`, which would
name that nonexistent file.

## Reading the results

The run page shows the per-module table, health flags, a survivor breakdown by
mutator, and the first survivors with their source lines. Artifacts:

- `mutation-report-<module>-…` — raw Stryker JSON per module, plus `stryker.log`.
- `mutation-summary-…` — `summary.md`, `summary.json`, and `survivors.jsonl`.

`survivors.jsonl` carries one row per survivor with module, mutant id, mutator,
replacement, and exact range, so an agent can consume it directly. It is
generated from the report every run, which is what the hand-maintained
`docs/mutation-evidence-62/*.jsonl` extracts failed at: all 148 routing survivor
rows had drifted to the wrong source lines.

## Running it by hand

`Actions → Mutation measurement → Run workflow`. Every knob is settable, and the
defaults reproduce the nightly run exactly:

| Input | Default | Meaning |
| --- | --- | --- |
| `target` | `all` | One module, or the whole matrix |
| `shards` | `0` | Shards per module; `0` derives from measured cost, `1` disables |
| `concurrency` | `4` | Stryker workers per leg, bounded 1–16 |
| `timeout_tolerance` | blank | Max timed-out mutants before the run is unusable; blank uses `max(10, 2%)` |
| `fail_on_unusable` | `true` | Fail the job on missing reports, excess timeouts, or shard conflicts |

Leg reports and the merged summary/survivor extract are always uploaded as
artifacts: the summariser downloads the per-leg reports, so artifact upload is
the transport, not an optional retention knob.

Inputs are validated in the `plan` job, so a typo fails in seconds instead of
after an hour.

## Running it in CI before merging

`workflow_dispatch` refuses to run a workflow that does not exist on the default
branch (`HTTP 404: workflow mutation.yml not found on the default branch`). To
exercise the pipeline from a feature branch, add a throwaway trigger:

```yaml
on:
  push:
    branches: [your-branch]
```

Push, watch the run, then remove the trigger. Branch-specific triggers do not
belong in the merged workflow: it is a nightly measurement, not a per-push job,
and `tests/mutation-workflow.test.mjs` asserts there is no `push:` trigger.

A first dispatch is worth doing anyway, because it calibrates
`ciSlowdownFactor` against the real runner.

## Local runs

Prerequisites: Node (24 in CI) and **Bun 1.4.0**. Five of six modules run under
`bun test`, which is the default runner, so `bun` must be on `PATH`; the workflow
installs it with `oven-sh/setup-bun`. `routing.ts` uses the TAP runner (Node) and
does not need Bun, but there is no per-invocation flag to pick a runner — the
choice lives in `RUNNER_OVERRIDES` in `mutation/config.mjs`.

```bash
npm ci
node mutation/run.mjs --list                     # targets, budgets, shards, bindings
node mutation/run.mjs cache.ts                  # one module, full run
node mutation/run.mjs routing.ts --concurrency 8
node mutation/run.mjs                           # every target, sequentially
node mutation/run.mjs cache.ts --shards 2       # split one module
node mutation/run.mjs cache.ts --mutate cache.ts:1-140   # one region
node mutation/run.mjs cache.ts --report reports/archive/cache.ts.json   # one named output file
node mutation/run.mjs routing.ts --incremental  # local loop: reuse unchanged results
node mutation/run.mjs cache.ts --dry-run        # check the binding, no mutants

# Summarise whatever ran
node mutation/report.mjs --dir reports/mutation --out /tmp/mutation.md
```

`--report` writes exactly the path it is given **under `reports/`** and clears
only that file, so two manual shard runs cannot delete each other's output. The
reporting directory is gitignored, and the boundary matters because the runner
removes its own previous output before measuring: a path elsewhere could delete a
source or tracked file. It requires exactly one target and cannot be combined
with `--shards`; both fail immediately rather than silently ignoring the flag.

Use `--incremental` while iterating on one module: the first run is full, later
runs only re-test what changed (measured: 1m44s → 2s when nothing changed, and a
test-file edit correctly re-ran the affected 157 mutants). It is deliberately
**not** used by the nightly, which must measure every mutant.

Reports land in `reports/mutation/` (gitignored) and are merged per module, so a
sharded run summarises like an unsharded one. `npm run test:mutation` is the same
runner. CI calls the runner too, so the two paths cannot drift.

## Sharding

Sharding splits one module across machines so it fits a job bound. Only one axis
was measured safe.

**Line-range shards must overlap.** Adjacent non-overlapping ranges silently lose
mutants that straddle a boundary — `1-100` + `100-244` recovered 176 of 229
`cache.ts` mutants. With `overlapLines: 40` the same pair recovered all 229, and
the 23 mutants measured twice agreed on status in every case. The merge
deduplicates by mutant identity and reports any disagreement as a conflict, which
makes the run unusable because the score would not be reproducible.

**Mutator-based sharding is not usable.** `excludedMutations` still instruments
excluded mutants as `Ignored`, so the reports are not clean partitions; the
evaluated sets were not complementary and 4 phantom mutants appeared.

**Incremental mode is not a shard.** With the command runner it reused every
stored result blindly (228 of 229 after a test edit). With the TAP runner it is
correct, but it is still not an authoritative measurement, so the nightly never
enables it.

| Module | Mutants | Measured (Bun, concurrency 6) | Shards |
| --- | --- | --- | --- |
| `cache.ts` | 229 | 3s | 1 |
| `classifier-semantics.ts` | 157 | 3s | 1 |
| `reliability.ts` | 352 | 14s | 1 |
| `reliability-v2.ts` | 2447 | 1m35s | 1 |
| `routing.ts` | 989 | 1m16s | 1 |

The runner change removed the reason to shard: the slowest leg is planned at
22.5 minutes (`routing.ts` on TAP, CI factor applied), so every module is one leg
and the whole matrix projects to 34.5 minutes wall clock (`node mutation/workflow.mjs plan`).
Sharding stays configured for a module that outgrows the budget; the plan shards
it automatically when one does.

## Measured results

Derived binding, TAP runner, 10-core macOS host, Node v24.14.0, Stryker 10.0.0:

| Module | Runner | Mutants | Killed | Survived | NoCoverage | Timeout | Population | Conclusive | Wall clock |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cache.ts` | bun | 229 | 172 | 48 | 9 | 0 | 75.11% | 75.11% | 4s |
| `classifier-semantics.ts` | bun | 157 | 85 | 26 | 46 | 0 | 54.14% | 54.14% | 5s |
| `inline-override.ts` | bun | 21 | 19 | 2 | 0 | 0 | 90.48% | 90.48% | 1s |
| `reliability.ts` | bun | 352 | 251 | 93 | 8 | 0 | 71.31% | 71.31% | 15s |
| `reliability-v2.ts` | bun | 2447 | 1432 | 707 | 307 | 1 | 58.52% | 58.54% | 1m46s |
| `routing.ts` | tap | 1000 | 681 | 214 | 98 | 7 | 68.10% | 68.58% | 6m33s |
| **All** | | **4206** | **2640** | **1090** | **468** | **8** | **62.77%** | **62.89%** | **8m48s total** |

Verified on GitHub-hosted 4-core runners from a feature branch — before
`inline-override.ts` was added — at **19 minutes end to end**, all jobs green, and
the same totals for the then-current five modules: 4,185 mutants and 62.75%
population. Three modules matched local mutant for mutant; `reliability-v2.ts`
moved by 5 mutants and `routing.ts` by 5, which is the documented stochastic
behaviour rather than a machine-dependent result.

The two score columns differ only where there are timeouts, which is why only
`routing.ts` moves (68.10% population against 68.58% conclusive): population keeps
its 7 timeouts in the denominator as unresolved, conclusive drops them from both
sides. Read population first.

Note the column the old command runner could not produce: `NoCoverage` was always
0 there because coverage was never measured, so the score silently counted
unreached mutants as if they did not exist. Those gaps are now visible, and they
are large: 307 of 2,447 mutants in `reliability-v2.ts` (12.5%) sit on lines no
bound test reaches.

For comparison, the same mutant populations under the old hand-written binding
scored 64.19% and 26.75% for the first two rows.

## Sandbox notes

Stryker copies the tree into `.stryker-tmp/`. Four things matter:

- `docs` must stay: `tests/bifrost-commands.test.ts` reads
  `docs/guide/commands.md`, and excluding it fails the dry run.
- `.pi` must be excluded: bound tests create their own `.pi` under a temp cwd,
  and copying a developer's `.pi` breaks on symlinked skill directories
  (`ENOTSUP: operation not supported on copyfile`). That failure blocked local
  runs entirely before the exclusion was added.
- `disableTypeChecks: false` must stay. Stryker's default injects
  `// @ts-nocheck` into every sandbox `.ts` file (165 of them here). That changes
  the bytes of files the bound tests read and hash — the affinity acceptance test
  asserts a committed `index.ts` baseline — so the dry run fails before a single
  mutant runs. It also shifts every line number by one, which would misattribute
  every survivor. Node strips types at runtime without type checking, so the
  directive buys nothing.
- A consumer test that asserts on the target's own source text is excluded from
  the binding for that target, because instrumentation rewrites exactly that
  text. `tests/integration/affinity-policy-acceptance.test.mjs` is the one such
  case, and the summary lists any exclusions under "Deliberately unbound".

## Limitations

- Coverage granularity depends on the runner: Bun attributes per **test**, the
  TAP fallback per **test file**. Five of six modules use Bun; `routing.ts` uses
  TAP because its verdict depends on the regex engine.
- **Concurrency barely helps.** Under TAP, throughput measured 1.61 s/mutant at 6
  workers and 1.67 at 4 (ratio 0.97), because the cost was per-mutant process
  startup rather than CPU. Sharding across machines is the underlying lever,
  which is why the budget is expressed in shards.
- **Never run two mutation runs in the same working directory.** The TAP runner
  writes its handshake to `stryker-output-<pid>.json` relative to cwd, so
  concurrent runs (or deleting `.stryker-tmp` mid-run) collide. Measured: this
  produced 320 of 388 mutants as `RuntimeError`; the clean rerun gave 10.
- **Upgrading Bun can change coverage attribution.** The Bun runner warns when
  its inspector and coverage records disagree; two runs of the same module agreed
  exactly (165/55/7 twice), but a major Bun upgrade should be re-checked against
  the TAP runner before its numbers are trusted.
- **Bound tests that call `process.chdir()`** need
  [`mutation/preload-restore-cwd.mjs`](../mutation/preload-restore-cwd.mjs).
  Without it a mutant that makes such a test throw before its cleanup leaves the
  working directory changed, the handshake file lands elsewhere, and the mutant
  is scored `RuntimeError` rather than killed. Four bound files across the target
  set do this.
- `RuntimeError`/`CompileError` mutants are **excluded from the score
  denominator** by Stryker, so a runner problem can produce a confident score over
  a smaller population. `RUNTIME_ERROR_TOLERANCE` makes that a hard failure.
- `checkers` is empty, deliberately. Measured `RuntimeError` + `CompileError` was
  0 of 1,727 mutants before the chdir fix, so `@stryker-mutator/typescript-checker`
  would add a dependency and a per-mutant type-check pass for no measurable gain.
- Outcomes can be stochastic. One `routing.ts` mutant was measured at 12 kills
  and 4 survivals across 16 identical trials. Read score deltas as a band, not a
  regression proof. No automatic regression threshold is enforced for this reason.
- Equivalent-mutant candidates are included in survivor counts and are not
  audited exhaustively.

## Historical evidence (issue #62)

The committed extracts in [`docs/mutation-evidence-62/`](mutation-evidence-62/)
and the provenance in
[`run-manifest.json`](mutation-evidence-62/run-manifest.json) record the original
experiment at revision `bee4b0e`. They are retained as a historical record and
are **not** regenerated by the nightly run; use the `survivors.jsonl` artifact
for current data. The configuration they describe has since been replaced as
above.
