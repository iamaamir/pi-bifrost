# Mutation testing

Mutation measurement for the core policy modules and for the structural gate.
This is a scheduled measurement, not a release gate. It never runs automatically
on a pull request and never blocks a merge. A `ci:mutation` label can request a
diagnostic run through the PR-label router; that check is not required. The
workflow run page publishes the results, and the results are also artifacts.

Run: [`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml),
nightly at 04:47 UTC from the default branch. The workflow is reusable
(`workflow_call`) with the same dispatch knobs, so the router and a manual
dispatch measure the same thing.

## Why it is not a merge gate

A full run is too slow to use as a gate. A subset for each pull request measures
a different mutant population each time. As a result, the number is not
comparable across runs, and comparability is the only property that makes the
number useful. One nightly run over the whole target set keeps the score
comparable over time.

## The one-hour planning budget

The measurement targets a 60-minute wall clock. That number is a planning
objective, not a hard deadline. GitHub Actions offers no workflow-wide
wall-clock limit, so nothing can enforce one. A plan can only refuse to start an
infeasible matrix and set a bound for each job. The plan does both, and this
document states both.

The GitHub limits are 6 hours per job and 35 days per run
([Actions limits](https://docs.github.com/en/actions/reference/limits)). Nobody
can raise these limits. Staying far inside them is voluntary. A measurement that
takes an hour is a measurement that nobody runs again. A measurement that hits
the platform limit fails after it burns the entire window.

The plan meets the budget by sharding, never by measuring fewer mutants.
Sharding buys wall clock with machines. Sharding does not touch the mutant
population, the binding, or the thresholds. `TIME_BUDGET` and `MATRIX` in
[`mutation/config.mjs`](../mutation/config.mjs) hold the parameters:

```
cap 60m | reserve 12m | CI factor 3.0x | hard/leg 48m | target/leg 30m | lanes 8

cache.ts                1.0m  shards 1 ->  1.0m/leg
classifier-semantics.ts 1.0m  shards 1 ->  1.0m/leg
inline-override.ts      1.0m  shards 1 ->  1.0m/leg
reliability.ts          1.0m  shards 1 ->  1.0m/leg
reliability-v2.ts       4.8m  shards 1 ->  4.8m/leg
routing.ts             13.6m  shards 1 -> 13.6m/leg   (TAP: production engine)
scripts/toolbox.mjs      2.1m  shards 1 ->  2.1m/leg   (in place: reads git ls-files)
modules/rules/rules.ts           1.0m  shards 1 ->  1.0m/leg   (TAP: production engine)
modules/rules/safety.ts         10.6m  shards 1 -> 10.6m/leg   (TAP: production engine)
modules/strategies/selection.ts   1.0m  shards 1 ->  1.0m/leg
```

Real `node mutation/workflow.mjs plan` output:

```
targets: cache.ts, classifier-semantics.ts, inline-override.ts, reliability.ts, reliability-v2.ts, routing.ts, scripts/toolbox.mjs, modules/rules/rules.ts, modules/rules/safety.ts, modules/strategies/selection.ts
matrix legs: 10 (concurrency 4)
projected wall clock: 25.6m of the 60m planning budget, 2 wave(s) of 10 leg(s) across 8 lanes (per-leg hard bound 48m)
the projection is a planning objective, not a deadline: GitHub enforces no workflow-wide wall clock
  cache.ts: mutate cache.ts
  classifier-semantics.ts: mutate classifier-semantics.ts
  inline-override.ts: mutate inline-override.ts
  reliability.ts: mutate reliability.ts
  reliability-v2.ts: mutate reliability-v2.ts
  routing.ts: mutate routing.ts
  scripts/toolbox.mjs: mutate scripts/toolbox.mjs
  modules/rules/rules.ts: mutate modules/rules/rules.ts
  modules/rules/safety.ts: mutate modules/rules/safety.ts
  modules/strategies/selection.ts: mutate modules/strategies/selection.ts
```

Sharding is currently unused. Ten legs fit in two waves across eight lanes, so
the plan projects 25.6 minutes. The machinery stays because a future module can
outgrow the budget. The plan switches to shards automatically when a module
outgrows it.

### The gate script target

`scripts/toolbox.mjs` is a target, and it is not a product module. Its bound
tests cover the structural rule scope, the duplication threshold, and the parsers
that turn tool output into findings. A mutant that survives there means a gate
accepts a tree that it must fail. That is a hole in the safety net. It is not a
routing risk.

The target runs in place, not in a Stryker sandbox. The sandbox always excludes
`.git`, and the gate calls `git ls-files` to learn which files it guards. From a
sandbox path, that command finds no tracked file, so every bound test fails in
the dry run. `IN_PLACE_TARGETS` in [`mutation/config.mjs`](../mutation/config.mjs)
marks the target. Stryker writes the mutated bytes to the checkout and restores
the originals when the run ends. The measured value on a 10-core host was 855
mutants in 43 seconds.

The complexity script is not a target. Its own suite measures the repository,
and Stryker's instrumented copy inflates the numbers that the suite asserts, so
the dry run cannot start.

### How the projection is computed

```
wall clock ~= reserveMinutes + longest lane
lanes       = MATRIX.maxParallel (must equal the workflow's max-parallel)
```

`projectWallClock()` in [`mutation/workflow.mjs`](../mutation/workflow.mjs) packs
legs through those lanes in one possible dispatch order. That order is the
matrix order, and it starts the next leg when a lane frees. GitHub does not
guarantee the matrix execution order
([docs](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs)).
GitHub only guarantees that at most `max-parallel` jobs run at once. As a
result, this calculation is a projection assumption, not a dispatch guarantee. A
different order can take longer than the projection. The previous formula was
`max(leg) + reserve`. That formula assumed that every leg started at the same
time. It is exact only while the leg count is at or below the lane count. With
four shards per target the plan produces 40 legs. The plan lists the legs of the
large modules last, so under the modeled order they start after the earlier
waves drain:

```
node mutation/workflow.mjs plan            # SHARDS=4
targets: cache.ts, classifier-semantics.ts, inline-override.ts, reliability.ts, reliability-v2.ts, routing.ts, scripts/toolbox.mjs, modules/rules/rules.ts, modules/rules/safety.ts, modules/strategies/selection.ts
matrix legs: 40 (concurrency 4)
projected wall clock: 17.1m of the 60m planning budget, 5 wave(s) of 40 leg(s) across 8 lanes (per-leg hard bound 48m)
```

`max(leg) + reserve` gives 15.4m. The difference is the wait before the plan
dispatches the long legs. A test asserts that `MATRIX.maxParallel` matches
`strategy.max-parallel` in the workflow. As a result, the two values cannot
drift apart.

### Why it is still only an estimate

- GitHub scheduling, image pulls and `npm ci` add delay that the planner cannot
  see.
- Shards overlap by `SHARDING.overlapLines`, so each leg covers slightly more
  than an even share of its module. The projection divides evenly and
  understates that share.
- A leg that overruns its estimate has no workflow-wide deadline to stop it.

### What is actually enforced

- The plan refuses an infeasible matrix before any job starts. A module that
  cannot fit even at `SHARDING.maxShards` fails in seconds and names the module.
  It does not run long and fail later. The plan never meets the cap by measuring
  fewer mutants.
- Each leg gets its own job timeout from the plan, 48 minutes as the per-leg hard
  allowance. A single global ceiling cuts a slow shard short, or it lets one
  stuck leg burn the window.
- The summarise job has its own 15-minute timeout. It never runs longer than the
  merge and the render that it does.
- The usability gate fails a run whose measurement is not complete, whatever the
  clock says. See [the usability gate](#the-usability-gate).

If a module cannot fit even at `maxShards`, the plan fails in seconds. The
message names the module and the arithmetic. The plan never drops mutants
without a message.

## The runner choice is the whole design

Stryker's `testRunner` decides everything downstream. A measurement covered
three runners on the same mutants. Both viable runners produce the same kills.

| Runner | Coverage | `cache.ts` (229) | `routing.ts` (989) | `reliability-v2.ts` (2447) | Incremental |
| --- | --- | --- | --- | --- | --- |
| `command` | `off` (unmeasured) | 4m38s | 19m20s | ~92m (projected) | reuses blindly |
| `tap` | per file | 27s | 5m31s | ~23m/shard × 4 | correct |
| `bun` | per test | 3s | 1m16s (not used, see below) | 1m35s | correct |

Bun is the default. `@hughescr/stryker-bun-runner` runs `bun test`, and
`bun test` executes this repository's `node:test` files without a change. The
measurement covered the 27 files bound to Bun-run modules. These files ran 679
tests with 0 failures under Bun 1.4.0. Coverage is attributed per individual
test, so a mutant runs only the tests that reach it (~8 per mutant) and not
whole files. As a result, a
module bound to one heavy file does not pay that file's runtime for each mutant.
This is the entire speed difference.

`routing.ts` stays on TAP as a deferred budget/CI decision: its rule-engine
tests moved to `modules/rules/` in #273, and removing the override is a separate
cost decision. The two moved targets stay on TAP because their bound tests still
exercise the structural scan and verdict decode in the host process. The engines
disagree. `^(a+)+$` against a 25-character canary took 475 ms under V8 and 66 ms
under JavaScriptCore. A measured A/B left 4 of 1,000 mutants with different
verdicts, and all 4 are in that region. Only the production engine answers the
question that production asks, so those modules run on Node. The two potentially
blocking match cases run in bounded children.

The probe was also pinned. It spawned `process.execPath`, which is `bun` under
Bun, so the probe ran a different regex engine than production. It now spawns
`node`, and `BIFROST_PROBE_NODE` can override this. It falls back to the hosting
runtime when `node` is absent. This change made the probe deterministic. It did
not remove the divergence above, because the mutated path runs the regex in the
host process, not in the probe.

Every other module uses Bun. One bound test blocked it before the fix.
`tests/reliability-migration.test.ts` asserted the `fsync`-on-lock-file failure
of Node by a patch of `node:fs`. Bun cannot do that. `syncBuiltinESMExports()`
is a no-op there, and a `node:fs` mock cannot be undone. As a result, the test
injected no fault at all, and its "tolerated" assertions passed for the wrong
reason. The test now injects the fault by an edit of a private source copy, and
this works on both runtimes.

`RUNNER_OVERRIDES` in `mutation/config.mjs` carries the reason that a central
module deviates from the default runner. At this time one central entry uses
`tap`: `routing.ts` keeps the production-engine verdict. The two `modules/rules/`
targets run their in-process scan and decode controls on `tap` too, and their
reasons live beside them in `modules/rules/mutation.json`. The other modules use
Bun. A test asserts that any present or future override names a reason.

Three properties hold for both runners, and a measurement covered all three:

1. Per-test selection. A mutant runs only the tests (Bun) or the files (TAP)
   that reach it, not the whole binding.
2. Incremental is safe. With the command runner, an edit of
   `tests/cache.test.ts` reused 228 of 229 stored results and republished the
   stale score. The Stryker documentation lists that runner as reporting
   "Nothing", and its differ then reuses without a condition
   (`if (!testCoverage.hasCoverage) return true`). With TAP, the same edit shows
   as "Tests: 1 files changed" and correctly invalidates 157 of 229.
3. `NoCoverage` is real. The command runner reported 0 uncovered mutants because
   it never measured coverage. Measured coverage reports 9 for `cache.ts` and 95
   for `routing.ts`, which are genuine gaps.

### Agreement between the runners

The measurement used the current HEAD. Each engine ran twice from a clean
`.stryker-tmp`.

`cache.ts`, 229 mutants, full population:

| Run | Killed | Survived | NoCoverage | Errors |
|---|---|---|---|---|
| bun, run 1 | 172 | 48 | 9 | 0 |
| bun, run 2 | 172 | 48 | 9 | 0 |
| tap, run 1 | 172 | 48 | 9 | 0 |
| tap, run 3 | 172 | 48 | 9 | 0 |

All 229 mutants agree between the engines, and Bun is deterministic across
repeats.

`inline-override.ts`, 21 mutants: 21 of 21 identical on both engines, in both
repeats. The plan chooses Bun for speed.

`reliability-v2.ts`, a 291-mutant slice (`495-575`):

| Comparison | Identical | Differ |
|---|---|---|
| Bun run 1 vs Bun run 2 | 287 / 291 | 4 |
| Bun run 1 vs TAP run 1 | 287 / 291 | 4 |

Three of the four cross-engine differences are also differences between two
identical Bun runs. That slice reads `now` and expiry values, so those mutants
are truly non-deterministic. A verdict comparison there cannot attribute a
difference to the engine. The A/B method gives information only on mutants that
are stable within one engine. This measurement is the reason that the document
removed the earlier claim of "226 of 227 identical, one `ObjectLiteral` at line
221 that Bun killed and TAP missed". On the current HEAD, both engines kill that
mutant, and the specific figure is not reproducible.

The engine-decides-verdict cases are the two `modules/rules/` targets, not
`routing.ts` alone. `^(a+)+$` against a 25-character canary takes 475 ms under V8
and 66 ms under JavaScriptCore. Their bound tests still let that regex run in
the host process when a scan mutant bypasses the textual check. Only the
production engine answers the question that production asks. `routing.ts` keeps
its TAP override pending the deferred budget decision.

Remaining limitation. A measurement establishes equivalence, not a proof. A
module trusts Bun because its verdicts match the production engine on that
module within the noise floor of the module. This method does not catch a module
whose tests depend on engine-specific behavior that no sampled mutant exercises.
The mitigation is the override mechanism and this measurement. If a module
starts to depend on engine semantics, it moves to TAP and records the reason.

### Incremental is a local convenience, never the nightly

The nightly must measure every mutant, so `incremental` is off by default. Only
`node mutation/run.mjs --incremental` enables it, with one state file per target
under `reports/mutation/.incremental-<module>.json`. Reuse of results across
nights publishes a score for code paths that the run never touched. Incremental
mode cannot see dependency updates, environment changes, or fixtures.

A measurement covered only the invalidation of the TAP runner, so
`--incremental` is restricted to targets on TAP (`routing.ts`). You cannot
combine it with `--shards`. The state file is per module, so two shards share one
record.

## How it works

Each target is its own matrix job, so each module gets a timeout budget that
matches its own bound suite. This is a correctness requirement, not a speed
optimization. A single shared budget for the fastest module reports the mutants
of every slower module as `Timeout`. Stryker counts a timeout as detected, and
that count inflates the score instead of failing the run. A measured eight-file
reliability binding produced 208 of 352 mutants as timeouts and a reported
99.43%.

Everything is in one directory, [`mutation/`](../mutation), with one shared policy
file and one optional data-only descriptor per capability:

| Piece | Location |
| --- | --- |
| Shared policy: runner, Stryker options, thresholds, tolerance, sharding, summary limits | [`mutation/config.mjs`](../mutation/config.mjs) |
| Capability-owned measured facts and runner reasons | `modules/<capability>/mutation.json` |
| Enrollment discovery and normalization | [`mutation/enrollment.mjs`](../mutation/enrollment.mjs) |
| Target/binding derivation (reusable, no config) | [`mutation/targets.mjs`](../mutation/targets.mjs) |
| Summary, scores, survivor extract | [`mutation/report.mjs`](../mutation/report.mjs) |
| Workflow helpers | [`mutation/workflow.mjs`](../mutation/workflow.mjs) |
| Local runner | [`mutation/run.mjs`](../mutation/run.mjs) |
| Stryker entry point (thin shim, no options) | [`stryker.config.mjs`](../stryker.config.mjs) |

`mutation/config.mjs` owns shared policy:

- `TARGETS`: the seven non-capability targets, the `timeoutFactor` and
  `timeoutMS` of each one, and its measured `secondsPerMutant`. Capability
  targets are composed into the same map from their descriptor, so every
  consumer sees one inventory.
- `TEST_RUNNER`: the default runner (`bun`). See the section above. This is the
  setting that decides everything else.
- `RUNNER_OVERRIDES`: central per-target runner overrides with a stated reason.
  At this time, `routing.ts` uses `tap`; the capability descriptors carry the
  `modules/rules/` reasons. Each override's reason is recorded next to the
  target that needs it.
- `TAP_NODE_ARGS`: how the TAP runner invokes `node:test`.
- `STRYKER_OPTIONS`: `checkers`, `thresholds`, reporters, `disableTypeChecks`.
- `SHARDING`: overlap width, max shards, and the cost threshold that starts
  sharding.
- `SANDBOX_IGNORES`: what the run does not copy into the Stryker sandbox.
- `TIMEOUT_TOLERANCE`: when a run has too many timeouts to trust.
- `SUMMARY`: how many survivors to show per module.

### Capability-owned enrollment

A capability that owns a measured source file declares it in
`modules/<capability>/mutation.json`. The descriptor is data only:

```json
{
  "targets": [
    {
      "file": "selection.ts",
      "mutants": 52,
      "secondsPerMutant": 0.034,
      "timeoutFactor": 2,
      "timeoutMS": 20000
    }
  ]
}
```

- `file` is capability-relative. It must be a real `.ts` or `.mjs` runtime
  source under the capability, not a test, glob, absolute path, traversal path
  or symlink.
- `mutants` is a positive integer, `secondsPerMutant` a finite positive number,
  `timeoutFactor` a finite positive number and `timeoutMS` a positive integer.
  Preserve the measured values.
- `runner` is optional and must be `bun` or `tap`. A runner needs a non-empty
  `reason`; a reason without a runner is invalid.
- Unknown fields are rejected. The descriptor cannot hold executable code,
  Stryker options, thresholds, shards or workflow policy.

Discovery reads only `modules/<capability>/mutation.json`. A capability without
a descriptor is not enrolled. Descriptors are normalized once by
`mutation/enrollment.mjs`; the runner, planner, Stryker shim and reporter all use
that same inventory. Order is the central non-capability declaration order,
followed by discovered capability targets sorted by a stable code-unit
comparison.

To add a capability-owned target, add one record to its descriptor. To add a
non-capability target, edit `TARGETS` and `MUTANT_ESTIMATE` in
`mutation/config.mjs`. A missing planning estimate fails the plan and does not
drop the module. The derivation helpers in `targets.mjs` are plain functions
over the file tree, so you can reuse them without the config. For example, they
answer "which tests import this module?".

Removing a record or deleting a whole descriptor is an explicit reviewed change,
not a silent opt-out. A missing descriptor looks identical to a capability that
never enrolled, so a review must compare the base and candidate inventory and
check whole-descriptor deletion or rename. The tooling does not keep a second
permanent registry to prove intent.

## Binding is derived, not hand-written

The binding for a module is every test file that imports it directly. The run
resolves the binding from the test sources at run time. The issue #62
configuration had five files for four modules written by hand, and that list was
too small. `reliability.ts` has 15 direct consumers and `routing.ts` has 10. Most
of its survivors measured absent tests, not weak tests. The measured effect of
the derived binding on the same mutant population:

| Module | Hand-written binding | Derived binding |
| --- | --- | --- |
| `cache.ts` | 64.19% | 75.11% |
| `classifier-semantics.ts` | 26.75% | 54.14% |

Tests that reach a module only through a caller are still not bound, so every
score here is a lower bound.

## Three scores, each with an explicit denominator

One number cannot answer three different questions. As a result, the summary
reports three scores, and the output states the formula for each score:

| Score | Formula | Question it answers |
|---|---|---|
| Population | `Killed / (total - Ignored)` | Of every mutant the tool evaluated, how many did the tests kill? |
| Conclusive | `Killed / (Killed + Survived + NoCoverage)` | Of the mutants that reached a conclusion, how many did the tests catch? |
| Stryker | `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)` | Stryker's own native score |

Read population first. It is the only one of the three that you cannot read as
"the tests caught it". A timeout, a runtime error and a compile error all stay in
its denominator and never reach its numerator. As a result, an unresolved mutant
cannot look like a kill that a test confirmed.

The earlier pair was the Stryker score and a score called the honest score,
`Killed / (Killed + Survived + NoCoverage)`. That name was wrong. A run with one
kill and nine timeouts reported 100%, because the timeouts were in neither the
numerator nor the denominator. The value is mathematically valid as a rate over
conclusive outcomes. It is misleading as a rate over the population. The summary
now calls it conclusive and presents it alongside population, not instead of
population.

`NoCoverage` stays in the conclusive and population denominators. A mutant that
no bound test reaches is a mutant that no test asserts. The population
denominator excludes `Ignored` mutants, because Stryker never evaluated them. A
count of them penalizes a run for mutants that it was told to skip. Every
raw count is preserved in `summary.json`: `Killed`, `Survived`, `NoCoverage`,
`Timeout`, `RuntimeError`, `CompileError`, `Ignored`, `total`, `evaluated`,
`unresolved`. As a result, you can recompute any score from the payload.

The workflow enforces none of the three as a merge gate. A low score is a
measurement, not a failure.

## The usability gate

A score over a population that is smaller without a signal is worse than no
score. As a result, the workflow of the run fails when the measurement is not
usable. It never fails on a low score.

| Condition | Allowance | Why |
|---|---|---|
| No module reports | None | Nothing was measured |
| A module report is missing | None | A matrix leg did not run |
| A planned shard is missing | None | The module reports, but only part of it measured |
| A module reports zero mutants | None | It parsed and carries nothing. 0/0 is not a perfect score |
| `Timeout` mutants | `max(10, 2%)` aggregate and per module | A budget collapse is indistinguishable from genuine timeouts |
| `RuntimeError` + `CompileError` | `max(5, 2%)` aggregate and per module | Stryker excludes these from its denominator |
| A report for a module outside the selected set | 0 | It is excluded from the score. Its presence still means the artifact set is not the planned one |
| A report whose measurement identity differs | 0 | It measured different bytes (revision, binding or config), so it must not be merged |
| Two files claiming one shard | 0 | `<module>.json` is shard 0, so it collides with `<module>.shard0.json`. One of them is stale |
| An unstamped report | 0 | Provenance is unknown, so nothing establishes what it measured |
| A module whose mutants are all `Ignored` | 0 | `total` is non-zero but nothing was evaluated |
| A shard outside the plan | 0 | A stale or misrouted artifact was merged. Missing-shard detection cannot see it |
| Shard conflicts | 0 | Overlapping shards disagreed, so the run is not reproducible |

The gate judges both the aggregate and each module, with the same calibrated
rule applied to each population. Aggregate-only checks can hide a broken module
inside a healthy run. 80 errored mutants out of 229 is 35% of that module. That
count is under the aggregate error allowance of 85 for a 4,200-mutant run. As a
result, the gate accepted the run and published a confident score, but one
module measured almost nothing. The failure now names the module and prints
its observed and allowed counts.

A dispatch can raise the timeout allowance with `timeout_tolerance`. The value is
an absolute count, and it limits each module and the aggregate. Without this
limit, the override passes the aggregate check and still fails the module that
needs it.

A few timeouts are permitted and expected. A mutant that inverts a loop bound or
decrements a counter instead of incrementing it truly does not terminate.
`routing.ts` produces 7 of 989 (0.7%) in this way. The tolerance separates those
timeouts from a budget collapse, which is an order of magnitude higher. The
measured eight-file case was 208 of 352 (59%).

A run that fails this gate still publishes its summary, report and survivors. A
failed measurement is not the same as discarded evidence.

## Report provenance and ownership

A Stryker report carries no revision and no measurement identity. As a result, a
directory of reports is not by itself evidence of one coherent measurement. Two
mechanisms close that gap:

- A stamped content identity. The runner writes `bifrost.measurement` into every
  report. This value is a SHA-256 of the bytes of the mutated module and of the
  local modules that it and its bound tests import. The value also covers
  `mutation/config.mjs`, the binding rules, the Stryker shim and
  `package-lock.json`. The identity is per module, because one measurement
  covered that population. The summariser recomputes the identity and rejects a
  report that does not match. A different revision, a different binding and a
  different config each cause a rejection that names the file and both
  identities. A scalar for each run cannot express this. Modules have different
  populations, so one value accepts everything or rejects everything. Provenance
  travels inside the artifact, so the download pattern does not need to encode
  it. A download pattern of `mutation-report-*` keeps a partial re-run working.
  A scope of `run_attempt` hides the legs that were not retried.
- One file per shard. An unsharded `<module>.json` parses as shard 0, so it
  collides with `<module>.shard0.json`. Two files that claim one shard are two
  measurements of it. A merge of them publishes a composite that no run
  produced. The run rejects the module and names both files.

A report records what it measured. An unsharded `<module>.json` stands for the
whole module. As a result, a partial `--mutate` run must name its artifact
explicitly. The run rejects the artifact if an unsharded report carries a
line-range scope. Without this rule, a one-shard plan publishes a score over part
of a module as if it were all of it. Sharded reports can carry ranges, because a
range is what a shard is.

A payload records what it measured, and the gate examines it again when the gate
reads it. The reporter writes `measuredIdentity` per module. `require-usable`
derives the identity again from the checkout. It rejects a payload that no
longer matches, and a payload that records none. Without this rule, a summary
from an earlier commit passes the gate as usable forever. The identity includes
the bound test files, so a test edit invalidates a stored result in the same way
as a module edit.

A corrupt artifact claims its slot. The run does not drop unreadable reports. A
truncated upload in a newer attempt must not let the previous attempt publish as
current. As a result, the run rejects the module and names the file and the
attempt. A readable newer attempt supersedes a corrupt older attempt.

The declared range of a shard must equal the range of the plan for its index.
The plan comes from the module and the requested shard count, never from the
files that are present. As a result, the gate rejects a truncated, extended,
swapped or out-of-range shard and does not merge it. The merge keeps the overlap
between adjacent planned ranges and removes duplicates by mutant identity.
Conflicting verdicts for one mutant block the measurement.

Artifacts stay separate until selection. The summarise job downloads with
`merge-multiple: false`, so each artifact keeps a directory with its own name.
That name carries the attempt. The reporter takes the newest attempt for each
`(module, shard)` and rejects two reports for one shard within an attempt. This
supports "re-run failed jobs" and does not let the extraction order decide a
result.

The reporting root must resolve inside the checkout. A symlinked `reports/`
redirects writes and deletions. As a result, the run validates the default
boundary before it creates anything.

The run confines report output to `reports/` on resolved paths. Lexical
containment is not a boundary. `writeFileSync` and `unlinkSync` follow a path that is spelled
inside `reports/` when its parent is a symlink elsewhere. The run resolves each
component that exists before the boundary test, so it refuses such a path.
Deletion uses the spelled path, because the removal of a symlink removes the
link and not its target. The run refuses a symlinked report *file* outright, so
"remove our own output" is unambiguous. Components that do not exist yet are
permitted, because their creation creates exactly what they name. Cleanup fails
closed.

A dry run measures nothing, writes nothing, and clears nothing. Deletion of the
previous measurement destroys a real result to make room for a report that
never appears. The run also refuses `--dry-run` together with `--report`,
because the combination names that nonexistent file.

## Reading the results

The run page shows the per-module table, health flags, a survivor breakdown by
mutator, and the first survivors with their source lines. Artifacts:

- `mutation-report-<module>-…`: raw Stryker JSON per module, plus `stryker.log`.
  The name carries the target's flat stem, so `scripts/toolbox.mjs` becomes
  `scripts__toolbox.mjs`, because an artifact name may not contain `/`.
- `mutation-summary-…`: `summary.md`, `summary.json`, and `survivors.jsonl`.

`survivors.jsonl` carries one row per survivor with module, mutant id, mutator,
replacement, and exact range, so an agent can consume it directly. The run
generates it from the report each time. The hand-maintained extracts in
`docs/mutation-evidence-62/*.jsonl` failed at this task. All 148 routing survivor
rows drifted to the wrong source lines.

## Running it by hand

`Actions → Mutation measurement → Run workflow`. You can set every parameter,
and the defaults reproduce the nightly run exactly:

| Input | Default | Meaning |
| --- | --- | --- |
| `target` | `all` | One module, or the whole matrix |
| `shards` | `0` | Shards per module. `0` derives from measured cost, `1` disables |
| `concurrency` | `4` | Stryker workers per leg, bounded 1–16 |
| `timeout_tolerance` | blank | Max timed-out mutants before the run is unusable. Blank uses `max(10, 2%)` |
| `fail_on_unusable` | `true` | Fail the job on missing reports, excess timeouts, or shard conflicts |

The run always uploads the leg reports and the merged summary and survivor
extract as artifacts. The summariser downloads the per-leg reports, so the
artifact upload is the transport and not an optional retention setting.

The `plan` job validates the inputs, so a typo fails in seconds and not after an
hour.

## Running it in CI before merging

`workflow_dispatch` refuses to run a workflow that does not exist on the default
branch. It reports
`HTTP 404: workflow mutation.yml not found on the default branch`. To exercise
the pipeline from a feature branch, add a temporary trigger:

```yaml
on:
  push:
    branches: [your-branch]
```

Push the branch and monitor the run. Then remove the trigger. Branch-specific
triggers do not belong in the merged workflow. The workflow is a nightly
measurement, not a job for each push, and `tests/mutation-workflow.test.mjs`
asserts that there is no `push:` trigger.

A first dispatch is useful in all cases, because it calibrates
`ciSlowdownFactor` against the real runner.

## Local runs

Prerequisites: Node (24 in CI) and Bun 1.4.0. Six of the seven targets run
under `bun test`, which is the default runner, so `bun` must be on `PATH`. The
workflow installs it with `oven-sh/setup-bun`. `routing.ts` uses the TAP runner
(Node) and does not need Bun. There is no flag to pick a runner for one invocation. The
choice is in `RUNNER_OVERRIDES` in `mutation/config.mjs`.

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

`--report` writes exactly the path that it is given under `reports/` and clears
only that file. As a result, two manual shard runs cannot delete the output of
each other. The reporting directory is in `.gitignore`, and the boundary matters
because the runner removes its own previous output before it measures. A path
elsewhere can delete a source file or a tracked file. The flag requires exactly
one target. You cannot combine it with `--shards`, and both cases fail
immediately instead of ignoring the flag.

Use `--incremental` while you iterate on one module. The first run is full, and
later runs test again only what changed. The measurement was 1m44s → 2s when
nothing changed, and a test-file edit correctly ran again the affected 157
mutants. The nightly does not use it, because the nightly must measure every
mutant.

Reports go to `reports/mutation/` (gitignored) and the run merges them per
module, so a sharded run summarizes like an unsharded run. A target in a
subdirectory still writes a top-level file, because the workflow's collection step
reads `reports/mutation/*.json`.
`npm run test:mutation` is the same runner. CI calls the runner too, so the two
paths cannot drift apart.

## Sharding

Sharding splits one module across machines so that it fits a job bound. A
measurement found only one axis safe.

Line-range shards must overlap. Adjacent ranges without an overlap lose mutants
that straddle a boundary, and no message appears. `1-100` + `100-244` recovered 176 of
229 `cache.ts` mutants. With `overlapLines: 40` the same pair recovered all 229,
and the 23 mutants with two measurements agreed on status in every case. The
merge removes duplicates by mutant identity and reports a disagreement as a
conflict. A conflict makes the run unusable, because the score is then not
reproducible.

Mutator-based sharding is not usable. `excludedMutations` still instruments
excluded mutants as `Ignored`, so the reports are not clean partitions. The
evaluated sets were not complementary, and 4 phantom mutants appeared.

Incremental mode is not a shard. With the command runner it reused every stored
result without a condition (228 of 229 after a test edit). With the TAP runner it
is correct, but it is still not an authoritative measurement. As a result, the
nightly never enables it.

| Module | Mutants | Measured (Bun, concurrency 6) | Shards |
| --- | --- | --- | --- |
| `cache.ts` | 229 | 3s | 1 |
| `classifier-semantics.ts` | 157 | 3s | 1 |
| `reliability.ts` | 352 | 14s | 1 |
| `reliability-v2.ts` | 2447 | 1m35s | 1 |
| `routing.ts` | 989 | 1m16s | 1 |

The runner change removed the reason to shard. At that measurement the plan set
the slowest leg at 22.5 minutes (`routing.ts` on TAP, with the CI factor). As a
result, every module was one leg, and the whole matrix projected to 34.5 minutes
wall clock. Sharding stays configured for a module that outgrows the budget. The
plan shards the module automatically when it outgrows the budget.

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
| All | | 4206 | 2640 | 1090 | 468 | 8 | 62.77% | 62.89% | 8m48s total |

A measurement on GitHub-hosted 4-core runners from a feature branch took 19
minutes end to end, with all jobs green. This measurement was before the addition
of `inline-override.ts`. The totals were the same for the five modules of that
time: 4,185 mutants and 62.75% population. Three modules matched the local result
mutant for mutant. `reliability-v2.ts` moved by 5 mutants and `routing.ts` by 5.
This is the documented stochastic behavior, not a machine-dependent result.

The two score columns differ only where timeouts exist. As a result, only
`routing.ts` moves (68.10% population against 68.58% conclusive). Population
keeps its 7 timeouts in the denominator as unresolved. Conclusive removes them
from both sides. Read population first.

Observe the column that the old command runner never produced. `NoCoverage`
was always 0 there because the runner never measured coverage, so the score
counted unreached mutants as if they did not exist. Those gaps are visible now,
and they are large. 307 of 2,447 mutants in `reliability-v2.ts` (12.5%) sit on
lines that no bound test reaches.

For comparison, the same mutant populations under the old hand-written binding
scored 64.19% and 26.75% for the first two rows.

## Sandbox notes

Stryker copies the tree into `.stryker-tmp/`. Four items matter:

- `docs` must stay. `tests/bifrost-commands.test.ts` reads
  `docs/guide/commands.md`, and an exclusion of it fails the dry run.
- `.pi` must be excluded. Bound tests create their own `.pi` under a temp cwd,
  and a copy of the `.pi` of a developer breaks on symlinked skill directories
  (`ENOTSUP: operation not supported on copyfile`). That failure blocked local
  runs entirely before the exclusion.
- `disableTypeChecks: false` must stay. The Stryker default injects
  `// @ts-nocheck` into every `.ts` file in the sandbox (165 files here). That
  change alters the bytes of files that the bound tests read and hash. The
  affinity acceptance test asserts a committed `index.ts` baseline. As a result,
  the dry run fails before a single mutant runs. The change also shifts every
  line number by one, and that shift misattributes every survivor. Node strips
  types at run time without a type check, so the directive gives no gain.
- The binding for a target excludes a consumer test that asserts on the source
  text of the target, because instrumentation rewrites exactly that text.
  `tests/integration/affinity-policy-acceptance.test.mjs` is the one such case,
  and the summary lists all exclusions under "Deliberately unbound".

## Limitations

- Coverage granularity depends on the runner. Bun attributes coverage per test,
  and the TAP fallback attributes it per test file. Six of the seven targets use
  Bun. `routing.ts` uses TAP because its verdict depends on the regex engine.
- Concurrency has almost no gain. Under TAP, throughput measured 1.61 s/mutant at
  6 workers and 1.67 at 4 (ratio 0.97). The cost was process startup for each
  mutant, not CPU. Sharding across machines is the main lever, and this is the
  reason that the budget is in shards.
- Never run two mutation runs in the same working directory. The TAP runner
  writes its handshake to `stryker-output-<pid>.json` relative to cwd, so
  concurrent runs collide. A deletion of `.stryker-tmp` during a run collides in
  the same way. The measurement produced 320 of 388 mutants as `RuntimeError`.
  The clean rerun gave 10.
- An upgrade of Bun can change coverage attribution. The Bun runner warns when
  its inspector records and its coverage records disagree. Two runs of the same
  module agreed exactly (165/55/7 twice). Before you trust the numbers after a
  major Bun upgrade, make sure that the numbers agree with the TAP runner.
- A bound test that calls `process.chdir()` needs
  [`mutation/preload-restore-cwd.mjs`](../mutation/preload-restore-cwd.mjs).
  Without it, a mutant that makes such a test throw before its cleanup leaves the
  working directory changed. The handshake file then goes elsewhere, and the run
  scores the mutant as `RuntimeError` and not as killed. Four bound files across
  the target set do this.
- Stryker excludes `RuntimeError` and `CompileError` mutants from the score
  denominator. As a result, a runner problem can produce a confident score over a
  smaller population. `RUNTIME_ERROR_TOLERANCE` makes that a hard failure.
- `checkers` is empty on purpose. The measured `RuntimeError` + `CompileError`
  count was 0 of 1,727 mutants before the chdir fix. As a result,
  `@stryker-mutator/typescript-checker` adds a dependency and a type-check pass
  for each mutant with no measurable gain.
- Outcomes can be stochastic. One `routing.ts` mutant had a measurement of 12
  kills and 4 survivals across 16 identical trials. Read score deltas as a band,
  not as a regression proof. For this reason, the workflow enforces no automatic
  regression threshold.
- Survivor counts include equivalent-mutant candidates, and no exhaustive audit
  covers them.

## Historical evidence (issue #62)

The committed extracts in [`docs/mutation-evidence-62/`](mutation-evidence-62/)
and the provenance in
[`run-manifest.json`](mutation-evidence-62/run-manifest.json) record the original
experiment at revision `bee4b0e`. The repository keeps them as a historical
record, and the nightly run does not regenerate them. Use the `survivors.jsonl`
artifact for current data. Later changes replace the configuration that the
extracts describe, as above.
