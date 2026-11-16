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

## The one-hour cap

The whole measurement is capped at **60 minutes**, enforced at plan time. GitHub's
own limits are 6 hours per job and 35 days per run
([Actions limits](https://docs.github.com/en/actions/reference/limits)) and
neither can be raised, so we stay far inside them voluntarily: a measurement that
takes an hour is one nobody reruns, and one that hits the platform limit fails
after burning the entire window.

The cap is met by **sharding, never by measuring fewer mutants**. Sharding buys
wall clock with machines; it does not touch the mutant population, the binding, or
the thresholds. `TIME_BUDGET` in [`mutation/config.mjs`](../mutation/config.mjs)
holds the knobs, and the plan refuses to start when the arithmetic does not fit:

```
cap 60m | reserve 12m | CI factor 1.8x | hard/leg 48m | target/leg 30m

cache.ts                1.0m  shards 1 ->  1.0m/leg
classifier-semantics.ts 1.0m  shards 1 ->  1.0m/leg
reliability.ts          1.0m  shards 1 ->  1.0m/leg
reliability-v2.ts       4.8m  shards 1 ->  4.8m/leg
routing.ts             22.4m  shards 1 -> 22.4m/leg   (TAP: production engine)

projected wall clock: 34.5m of 60m cap
```

Sharding is currently **unused**: at 14.9 minutes the whole matrix fits with room
to spare, so every module is a single leg. The machinery stays because a future
module may outgrow the budget, and the plan switches to shards automatically when
it does.

Three details that make it a real cap rather than a wish:

- **Legs run in parallel**, so wall clock is the slowest leg plus fixed overhead,
  not the sum. Nine legs across five modules.
- **`ciSlowdownFactor` (3×)** accounts for GitHub's 4 cores versus the 10-core
  host the numbers were measured on. Measured on the first real dispatch, after
  subtracting per-job setup: `routing.ts` 17.4 min against 6.6 locally (2.7×) and
  `reliability-v2.ts` 6.9 against 1.8 (3.9×).
- **Each leg gets its own job timeout** from the plan. A single global ceiling
  either cuts a slow shard short or lets one stuck leg burn the window.

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
executes this repository's `node:test` files unchanged — verified: all 30 bound test
files pass under Bun 1.4.0. Because coverage is attributed per individual
test, a mutant runs only the tests that reach it (~8 per mutant) instead of whole
files, so a module bound to one heavy file no longer pays that file's runtime
per mutant. That is the entire speed difference.

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

The `tap` runner and the `RUNNER_OVERRIDES` / `BUN_INCOMPATIBLE_TESTS` mechanism
remain, unused, because the next runner incompatibility will need them. A test
asserts that any future override names a listed blocker, and that no blocker is
listed without a target using it.

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

Same mutants, compared kill-for-kill on a 227-mutant `reliability-v2.ts` slice:

- **226 of 227 identical.** The one difference is an `ObjectLiteral` mutant at
  line 221 that Bun killed and TAP missed — in the direction of the faster runner
  catching more, not fewer.
- `routing.ts`: 680 killed under both; TAP reported 7 timeouts where Bun reported
  5.
- `cache.ts`: identical 172 killed / 48 survived / 9 uncovered.

So the two are interchangeable for scoring purposes, and Bun is chosen for speed.

### Incremental is a local convenience, never the nightly

The nightly must measure every mutant, so `incremental` is **off by default** and
only enabled by `node mutation/run.mjs --incremental`, with one state file per
target under `reports/mutation/.incremental-<module>.json`. Reusing results
across nights would publish a score for code paths the run never touched —
incremental cannot see dependency updates, environment changes, or fixtures.

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
| Summary, honest score, survivor extract | [`mutation/report.mjs`](../mutation/report.mjs) |
| Workflow helpers | [`mutation/workflow.mjs`](../mutation/workflow.mjs) |
| Local runner | [`mutation/run.mjs`](../mutation/run.mjs) |
| Stryker entry point (thin shim, no options) | [`stryker.config.mjs`](../stryker.config.mjs) |

`mutation/config.mjs` is the only file to edit for a normal change:

- `TARGETS` — which modules are measured, each one's `timeoutFactor` /
  `timeoutMS`, and its measured `expectedMinutes` (which drives shard planning).
- `TEST_RUNNER` — `tap` (default) or `command`. See the section above; this is
  the setting that decides everything else.
- `TEST_RUNNER` / `RUNNER_OVERRIDES` / `BUN_INCOMPATIBLE_TESTS` — the runner
  choice, and the reason a module deviates from it.
- `TAP_NODE_ARGS` — how `node:test` is invoked for the TAP runner.
- `STRYKER_OPTIONS` — `checkers`, `thresholds`, reporters, `disableTypeChecks`.
- `SHARDING` — overlap width, max shards, and the cost threshold that triggers it.
- `SANDBOX_IGNORES` — what is not copied into the Stryker sandbox.
- `TIMEOUT_TOLERANCE` — when a run is too full of timeouts to trust.
- `SUMMARY` — how many survivors to show per module.

Adding a module to `TARGETS` is the only edit needed: the workflow matrix, local
runner, binding derivation and summary all read from it. The derivation helpers
in `targets.mjs` are plain functions over the file tree, so they are reusable
without the config (for example to answer "which tests import this module?").

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

## Two scores, deliberately

Stryker's score is `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`.
Counting a timeout as detected means a mutant that hangs the suite raises the
score. The summary therefore reports both:

- **Honest score** = `Killed / (Killed + Survived)`.
- **Stryker score** = Stryker's own definition, shown for comparison.

The nightly job fails when a run is **unusable**, never when the score is low:

- any module report is missing (a missing matrix leg is not a pass);
- no reports were produced at all;
- timed-out mutants exceed the tolerance (`max(10, 2% of mutants)`).

A few timeouts are legitimate and expected: a mutant that inverts a loop bound
or decrements a counter instead of incrementing it genuinely does not terminate.
`routing.ts` produces 7 of 989 (0.7%) this way. The tolerance separates those
from a budget collapse, which lands an order of magnitude higher — the measured
eight-file case was 208 of 352 (59%).

A low score is the measurement, not a failure.

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
| `upload_reports` | `true` | Upload the raw JSON and `survivors.jsonl` |

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

```bash
npm ci
node mutation/run.mjs --list                     # targets, budgets, shards, bindings
node mutation/run.mjs cache.ts                  # one module, full run
node mutation/run.mjs routing.ts --concurrency 8
node mutation/run.mjs                           # every target, sequentially
node mutation/run.mjs cache.ts --shards 2       # split one module
node mutation/run.mjs cache.ts --mutate cache.ts:1-140   # one region
node mutation/run.mjs cache.ts --incremental    # local loop: reuse unchanged results
node mutation/run.mjs cache.ts --dry-run        # check the binding, no mutants

# Summarise whatever ran
node mutation/report.mjs --dir reports/mutation --out /tmp/mutation.md
```

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

The runner change removed the reason to shard: the slowest module is 1m35s, so
every module is one leg and the whole matrix projects to 14.9 minutes. Sharding
stays configured for a module that outgrows the budget; the plan shards it
automatically when one does.

## Measured results

Derived binding, TAP runner, 10-core macOS host, Node v24.14.0, Stryker 10.0.0:

| Module | Runner | Mutants | Killed | Survived | NoCoverage | Timeout | Honest score | Wall clock |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cache.ts` | bun | 229 | 172 | 48 | 9 | 0 | 75.11% | 4s |
| `classifier-semantics.ts` | bun | 157 | 85 | 26 | 46 | 0 | 54.14% | 5s |
| `reliability.ts` | bun | 352 | 251 | 93 | 8 | 0 | 71.31% | 15s |
| `reliability-v2.ts` | bun | 2447 | 1432 | 707 | 307 | 1 | 58.54% | 1m46s |
| `routing.ts` | tap | 1000 | 681 | 214 | 98 | 7 | 68.58% | 6m33s |
| **All** | | **4185** | **2621** | **1088** | **468** | **8** | **62.75%** | **8m48s total** |

Verified on GitHub-hosted 4-core runners from a feature branch: **19 minutes
end to end**, all jobs green, and the same totals — 4,185 mutants and 62.75%
honest. Three modules matched local mutant for mutant; `reliability-v2.ts` moved
by 5 mutants and `routing.ts` by 5, which is the documented stochastic behaviour
rather than a machine-dependent result.

Honest score is `killed / (killed + survived + no-coverage)`. Note the column the
command runner could not produce: `NoCoverage` was always 0 there because coverage
was never measured, so its score silently counted unreached mutants as if they did
not exist. Those gaps are now visible, and they are large: 307 of 2,447 mutants in
`reliability-v2.ts` (12.5%) sit on lines no bound test reaches.

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
  TAP fallback per **test file**. Four of five modules use Bun; `routing.ts` uses
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
