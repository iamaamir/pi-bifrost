# Mutation measurement

Scheduled mutation testing for the Bifrost router. This is a measurement, not a
release gate. It never runs on a pull request and never blocks a merge. A low
score never fails the job. The score is the output.

Start here if you want to know what is measured, why the numbers are
trustworthy, or how to add a module.

| File | Owns |
|---|---|
| `config.mjs` | Every tunable. The only file you edit for a normal change. |
| `targets.mjs` | Derives the binding from real test imports. Do not hand-list tests. |
| `report.mjs` | Merges shard reports, computes both scores, renders the summary. |
| `workflow.mjs` | `plan` / `plan-cli` / `summarise` / `require-usable` for CI. |
| `run.mjs` | The local runner. |
| `preload-restore-cwd.mjs` | Guards the TAP runner's handshake file. See [Why this exists](#why-preload-restore-cwdmjs-exists). |

The workflow lives at `.github/workflows/mutation.yml`. The narrative guide is
[`docs/mutation-testing.md`](../docs/mutation-testing.md).

## Adding a module

You make two edits in one file.

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

- `timeoutFactor` / `timeoutMS`: Stryker's per-mutant timeout is
  `dryRunDuration * timeoutFactor + timeoutMS`. Size it to the bound test suite
  of this module. A value that is too small reports genuine mutants as `Timeout`.
  Stryker counts those as detected, so the score inflates. A value that is too
  large makes a real infinite loop take longer to detect. Start at `2 / 20_000`.
  If the dry run fails, raise the value.
- `secondsPerMutant`: the measured wall-clock throughput. Start with a placeholder
  (`0.02` is a reasonable guess). Replace it in step 2.
- `MUTANT_ESTIMATE`: a planning input for budget and shard arithmetic only. The
  report always carries the real counts. Set it to the reported total in step 2 so
  that planning reflects reality.

You do not touch anything else. The matrix, the artifact names, the shard
planning, the summary, and the gate all derive from `TARGETS`.

### 2. Get the real numbers

Run every command from the checkout root (the worktree root, not a subdirectory).
The scripts resolve paths relative to the checkout root.

```bash
node mutation/run.mjs inline-override.ts --dry-run   # binding + sandbox, no mutants
time node mutation/run.mjs inline-override.ts        # full run, measure the cost
```

`--list` shows every target with its estimate, its shard count, and its bound
files.

You edit `mutation/config.mjs` a second time here. That is expected. Set
`secondsPerMutant` to `elapsed_seconds / mutant_count` from the run above. Set
`MUTANT_ESTIMATE` to the mutant total that the run reported. Both values are
planning inputs. As a result, a placeholder affects the projection only. It never
affects a reported score.

Use the process wall clock (`time`), not `Done in N seconds` from Stryker. For a
small module, the per-process startup dominates. The figure from Stryker then
rounds to zero, which records a cost that is wrong in the optimistic direction.

### 3. Watch the budget

```bash
node mutation/workflow.mjs plan     # refuses if the matrix cannot fit 60 minutes
```

If the projection is over budget, the plan fails in seconds and names the module.
Shard it. Never trim the mutant population to fit. Sharding multiplies the
machines. It does not change what is measured.

Sharding is automatic. `suggestedShards()` splits a module into as many legs as
necessary, so that each leg lands under `targetLegMinutes` (30). The maximum is
`SHARDING.maxShards` (4). Each shard is its own parallel job.

### 4. Nothing else to register

`workflow_dispatch.inputs.target` is free text on purpose. The plan job makes sure
that the value is valid against `TARGETS` before any leg starts. It lists the
valid names when the value is wrong. A new module is dispatchable as soon as it is
in `TARGETS`.

Finally, run the suite:

```bash
node --test --experimental-strip-types tests/mutation-workflow.test.mjs
```

A normal target addition needs no test edit. The existing assertions iterate
`TARGETS`, so they cover a new entry automatically. Extend the suite only if you
add a new invariant that is specific to this module. If you also add a
`RUNNER_OVERRIDES` entry, the test requires a reason with it.

## Choosing a module

Prefer modules that are routing, state, reliability, or config precedence. A
silent wrong answer in these modules is expensive. Leave out anything where a
surviving mutant is expected rather than informative:

- Formatting and output strings. A mutant that changes a log line survives
  because no test asserts it. That is not a test gap that is worth acting on.
- Modules that the tests reach only through a heavy integration path. A 1-mutant
  module bound to a 30-second suite costs more wall clock than it returns.
- `index.ts`, `tests/helpers.ts`, `config.ts`. These modules appear bindable (16, 32,
  and 18 consumers). But a mutant in a helper invalidates the suite that depends on
  it. The binding is broad and the signal is diffuse.

As of writing, the config targets 5 of the 55 bindable root modules. These sizes are
worth a start, smallest first: `inline-override.ts` (41 lines, 1 bound test),
`virtual-override.ts` (52), `reliability-v2-routing.ts` (53),
`reliability-observation-projection.ts` (70).

## The binding is derived, never listed

`bindingFor(target)` = every test file under `tests/` that imports the module
directly, minus tests that read the module's own source text.

This derivation replaced a hand-written list that had drifted badly:
`reliability.ts` has 15 direct consumers and `routing.ts` has 10, but the old
config bound five files across four modules. Most reported survivors measured
absent tests, not weak tests. Never hand-list test files. The derivation is the
whole point.

If a module has no bindable consumers, `bindingFor` throws an error. It does not
measure an empty population.

### The self-referential exclusion

A test that reads the source bytes of the target cannot be bound to it. Stryker
rewrites that source to insert each mutant. As a result, an assertion against the
original text fails, and the dry run stops before it measures a mutant. The
derivation excludes both of these shapes automatically:

```js
readFileSync(join(ROOT, "routing.ts"), "utf8")          // inline read
const SOURCE = new URL("../x.ts", import.meta.url)      // then readFileSync(SOURCE)
```

A normal `from "../target.ts"` import is a legitimate binding. The exclusion does
not cover it.

## Reading the three scores

The summary always publishes all three scores, and the output states the formula
for each. One number cannot answer three different questions.

| Score | Formula | Question |
|---|---|---|
| Population | `Killed / (total - Ignored)` | Of every mutant evaluated, how many did the tests kill? |
| Conclusive | `Killed / (Killed + Survived + NoCoverage)` | Of the mutants that reached a verdict, how many were caught? |
| Stryker | `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)` | Stryker's native score |

Read the population score first. It is the only score that you cannot read as
"the tests caught it". A timeout, a runtime error, and a compile error all stay in
its denominator and never reach its numerator.

The score that this document used to call honest was
`Killed / (Killed + Survived + NoCoverage)`. That name was wrong. A run with one
kill and nine timeouts reported 100%, because timeouts sat in neither the
numerator nor the denominator. That value was valid as a rate over conclusive
outcomes. It was misleading as a rate over the population. The score is
conclusive. The summary shows it beside the population score, not instead of it.

A `Timeout` can be a genuine infinite-loop detection. It can also mean that the
budget was too small for the suite. The report cannot tell the two apart. If you
credit timeouts silently, a broken budget becomes a 99.43% score. A measured case
had eight bound files, and 208 of 352 mutants reported as timeouts.

`NoCoverage` counts against both scores because a mutant that no test reaches is a
mutant that no test asserts. `Ignored` mutants leave the population denominator
entirely because Stryker never evaluated them. As a result, `reliability-v2.ts`
sits at 58.5%. 307 of its mutants are unreached, largely because one test file
(`tests/reliability-v2-state-machine.test.ts`) holds 77% of the assertions of the
module. Splitting that file is the follow-up with the highest value.

## The usability gate

A score over a silently smaller population is worse than no score.
`require-usable` fails the run (not the merge) when these conditions occur:

| Condition | Allowance | Why |
|---|---|---|
| No module reports | None | Nothing was measured |
| Missing module report | None | A matrix leg did not run |
| Missing shard | None | The module reports, but only part of it measured |
| A module reports zero mutants | None | It parsed and carries nothing. 0/0 is not a perfect score |
| `Timeout` mutants | `max(10, 2%)` aggregate and per module | Budget collapse is indistinguishable from real timeouts |
| `RuntimeError` + `CompileError` | `max(5, 2%)` aggregate and per module | Stryker excludes these from the denominator |
| A report for a module outside the selected set | 0 | It is excluded from the score, but its presence means the artifact set is not the planned one |
| A report whose measurement identity differs | 0 | It measured different bytes (revision, binding or config). A merge would publish a composite |
| Two files claiming one shard | 0 | `<module>.json` is shard 0, so it collides with `<module>.shard0.json`. One of them is stale |
| An unstamped report | 0 | Its provenance is unknown, so nothing can establish what it measured |
| A shard outside the plan | 0 | A stale or misrouted artifact was merged. Missing-shard detection cannot see it |
| Shard conflicts | 0 | Overlapping shards disagreed. The run is not reproducible |

The error row is the important one. Stryker removes errored mutants from the
score. As a result, 320 errors out of 388 prints a confident score over the 68
survivors, and the output does not say so. The measured case was a test that calls
`process.chdir()`.

The gate judges every module and also judges the aggregate, against the same rule
applied to the population of that module. An aggregate-only check hides a broken
module inside a healthy run. 80 errors in a 229-mutant module is 35% of that
module. But that count sits under the aggregate allowance of 85 for a 4,200-mutant
run, so the gate used to accept it. The failure names the module and prints the
observed and allowed counts.

A run that fails the gate still publishes its summary, its report, and its
survivors. A failed measurement is not the same as discarded evidence.

Override the timeout allowance from a dispatch with `timeout_tolerance`. Leave it
blank for the calibrated default. The value is an absolute count, and it bounds
each module and also the aggregate. That bound is necessary. Without it, the
override clears the aggregate check and still fails the module that needs it. The
runner stores the value at the top level of `summary.json`. The gate reads it
there.

## Time budget

The planning objective is 60 minutes, which is well inside the 6-hour job limit of
GitHub. It is not a hard deadline. GitHub Actions has no workflow-wide wall-clock
limit, so nothing can enforce one. See
[What is actually enforced](#what-is-actually-enforced).

```
wall clock ~= reserveMinutes (12) + longest lane
lanes       = MATRIX.maxParallel (8), matching the workflow's max-parallel
```

```bash
node mutation/workflow.mjs plan
# matrix legs: 6 (concurrency 4)
# projected wall clock: 34.5m of the 60m planning budget, 1 wave(s) of 6 leg(s) across 8 lanes (per-leg hard bound 48m)
```

`projectWallClock()` packs legs through those lanes in one possible dispatch
order. That order is the order in which the matrix lists the legs, and it starts
the next leg when a lane frees. GitHub does not guarantee matrix execution order. It
guarantees only that at most `max-parallel` jobs run at once. As a result, this
value is a projection assumption, not a dispatch guarantee. A different order can
produce a longer wall clock than the projection. This is why the number is a
planning objective. The old formula was `max(leg) + reserve`. It assumed that
every leg started at once, so it was exact only while the leg count is at or below
the lane count. Sharding six modules four ways is 24 legs:

```
SHARDS=4 node mutation/workflow.mjs plan
# matrix legs: 24 (concurrency 4)
# projected wall clock: 18.1m of the 60m planning budget, 3 wave(s) of 24 leg(s) across 8 lanes
```

The old `max(leg)` formula gives 17.6m for this case. The difference is the wait
before the dispatch of the legs of the large modules, which the matrix lists last.
A test asserts that `MATRIX.maxParallel` matches the workflow, so the two cannot
drift.

`ciSlowdownFactor: 3` converts a 10-core local measurement into an estimate for a
4-core runner. Measured ratios were `routing.ts` 2.7× and `reliability-v2.ts` 3.9×.
If you plan at 1.0, the local run passes and CI overruns without a signal.

The value is still an estimate, for these reasons. GitHub scheduling and image
pulls add delay that the planner cannot see. Shards overlap, so each shard covers
slightly more than an even share. A leg that overruns has no workflow-wide
deadline to stop it.

### What is actually enforced

- The plan refuses an infeasible matrix before any job starts and names the
  module. It never meets the cap by measuring fewer mutants.
- Each leg has `timeout-minutes` = `legMinutes()` (48m), so one stuck leg cannot
  burn the window.
- The summarise job has its own 15-minute timeout.
- The usability gate fails an incomplete measurement, whatever the clock says.

## Runner choice: Bun by default, TAP when the verdict depends on the engine

`bun` is the default because it reports coverage for each test. As a result, each
mutant runs only the tests that reach it. TAP reports coverage for each file, so
each mutant pays for the whole file. Measured on identical mutants:

| Module | TAP | Bun |
|---|---|---|
| `cache.ts` | 27s | 4s |
| `reliability-v2.ts` | 5m30s | 10s |
| `routing.ts` | 5m31s | 1m16s |

The engines agree in these measurements on current HEAD. Each engine ran twice
from a clean `.stryker-tmp`:

- `cache.ts` (229 mutants): all four runs (bun ×2, TAP ×2) report the same
  172 killed / 48 survived / 9 uncovered. All 229 verdicts agree across the
  engines. Bun is deterministic on repeated runs.
- `inline-override.ts` (21 mutants): 21 of 21 verdicts are identical on both
  engines, on both repeats.
- `reliability-v2.ts` (291-mutant slice `495-575`): Bun and TAP differ on 4 of 291.
  But 3 of those 4 also differ between two identical Bun runs, because the slice
  reads `now` and expiry values. On that slice, the A/B comparison cannot
  attribute a difference to the engine. This is why the document no longer makes
  the older "226 of 227, one `ObjectLiteral` at line 221" claim. On current HEAD,
  both engines kill that mutant, and the figure is not reproducible.

`routing.ts` is the module where the engine decides the verdict, and it is the
only override. `^(a+)+$` on a 25-character canary takes 475ms on V8 and 66ms on
JavaScriptCore. When a mutant bypasses the backtracking probe, the regex runs in
the host process. As a result, only the production engine answers the question
that production asks. Subprocess pinning did not fix it.

Measurement establishes equivalence, not proof. The project trusts Bun for a
module because its verdicts match TAP within the noise floor of that module. This
method does not catch a module that depends on engine behavior that no sampled
mutant exercises. The mitigation is the override plus a record of the reason.

To add an override, edit `RUNNER_OVERRIDES` and give a reason. A test requires the
reason. Two reasons are legitimate: Bun cannot run a bound test at all, or the
verdict differs between the engines.

## Edge cases worth knowing

`disableTypeChecks: false` is mandatory. The default of Stryker injects
`// @ts-nocheck` at the top of every sandbox `.ts` file. That directive breaks
tests that hash committed files. It also shifts every line number by one, so the
report attributes every survivor to the wrong line. Node strips types at runtime,
so the directive has no effect.

Never run two mutation runs in the same directory. The TAP runner writes its
handshake file relative to the current working directory. A deletion of
`.stryker-tmp` during a run produced 320 of 388 `RuntimeError`.

`--incremental` is a local loop, never authoritative. It applies to the TAP runner
only. We measured its invalidation (an edit of a bound test re-ran the affected
mutants). It cannot be combined with `--shards`, because its state file is per
module. The retired `command` runner had no per-test coverage. As a result, its
differ reused every stored result unconditionally and republished a stale score
after a bound-test edit (228 of 229 reused).

Line-range shards must overlap. Adjacent ranges drop mutants that straddle a
boundary. `1-100` + `100-244` recovered 176 of 229 mutants for `cache.ts`.
Overlapping `1-140` + `120-244` recovers all 229. The 23 mutants measured twice
agreed on status every time.

Mutator-based sharding is not usable. `excludedMutations` still instruments
excluded mutants as `Ignored`. The evaluated sets were not complementary (4
phantom `CallExpression` mutants).

Every report carries the measurement that it belongs to. The runner stamps each
report with a content identity. The identity includes the bytes of the module. It
also includes the local modules that the module and its bound tests import, and
`mutation/config.mjs`. It includes the binding rules (`mutation/targets.mjs`), the
Stryker shim, and the resolved dependency set (`package-lock.json`). The
summariser accepts a report only if that identity matches the current checkout.
The identity is per module, because one measurement of a module covers its
population. A single per-run value accepts everything or rejects everything. The
summariser rejects a report from a different revision, binding, or config, and
names it. It never merges that report. The identity also means that the artifact
file name does not have to encode provenance. That is why the download pattern
stays `mutation-report-*`. A pattern scoped to the current `run_attempt` hides the
legs that a partial re-run did not retry.

A report records the scope that it measured. An unsharded `<module>.json` stands
for the whole module. As a result, a run that mutates only a line range must name
its artifact with `--report`. The summariser rejects an unsharded report whose
scope is a range. Without that rule, a one-shard plan scores part of a module as
all of it. Sharded reports can carry ranges. That is what a shard is.

A dry run never clears reports. `--dry-run` measures nothing and writes nothing. A
deletion of the previous measurement destroys a real result to make room for a
report that never exists. The runner refuses `--dry-run` with `--report`, which
names that nonexistent file.

A shard's scope must be the scope that the plan assigned to it. Sharding is line
ranges. As a result, the only evidence of what a shard mutated is the range in its
provenance. A leg that mutates ten lines of a 163-line shard still calls itself
shard 0. Without this check, it merges as shard 0, and the skipped mutants are
invisible, because `total` counts what was measured, not what was planned. The
reporter derives the plan from the module (`shardsFor`) and from the requested
shard count. It rejects any shard whose range differs: truncated, extended,
swapped, or out of range. Filenames never establish completeness.

Artifacts are not merged on download. Each leg uploads its own artifact. The
summarise job downloads them with `merge-multiple: false`, so every artifact keeps
its own directory. A flattened layout puts two attempts of one shard on the same
filename and leaves the survivor to the extraction order. The reporter reads the
attempt from the artifact path and takes the newest attempt for each
`(module, shard)`. It rejects two reports for one shard within an attempt as
ambiguous and does not resolve them by order. As a result, "re-run failed jobs"
continues to work. Untouched legs stay on attempt 1, and retried legs move to
attempt 2.

A summary carries its own identity, and a re-gate makes sure that it is correct.
The reports path always made sure that the measurement identity was correct. But
the summariser accepted a `summary.json` read back later unconditionally. As a
result, a payload built against an older tree reported a usable score for code
that no longer exists. Its survivor rows carried no identity. The payload records
`measuredIdentity` per module. `require-usable` derives it again from the checkout
and refuses a stale or unstamped payload. The identity also covers the bound
tests, so a test edit invalidates the result in the same way as a module edit.

An unreadable artifact blocks its slot. It never falls back. The runner used to
drop a truncated upload, and that made the previous attempt look current. The run
was a re-run because something failed, so the absence of the upload is not
evidence of success. A corrupt report occupies its `(module, shard)` slot. If the
corrupt report is the newest attempt for that slot, the gate rejects the module.
If a readable newer attempt exists, it replaces the corrupt older one.

The reporting root cannot leave the repository. The default `reports/` must
resolve inside the checkout. The runner refuses a symlinked root that points
elsewhere before it creates, writes, or deletes anything. A caller that passes its
own root uses that root as its trust anchor.

The runner confines report output to `reports/`, on resolved paths. It makes sure
that the boundary holds after it resolves symlinks in every component that
exists. As a result, it refuses a path that is spelled inside `reports/` but
that a symlinked directory redirects elsewhere. It does not write or delete
through that path. A deletion uses the spelled path (the removal of a symlink
removes the link, not its target). The runner refuses a symlinked report file,
because "remove our own output" then has two meanings. The runner permits a
component that does not exist yet: its creation makes exactly what it names.
Cleanup fails closed. If the runner cannot establish the boundary, it deletes
nothing.

The runner clears stale reports per target. The summariser merges every `*.json`
in `reports/mutation/`, so it counts a file from a previous run. Clearing matches
exact names only. `cache.ts` must never delete `cache-classifier.ts.json`. An
explicit `--report` owns exactly the resolved path that it names. An
`reports/archive/x.json` target never deletes `reports/mutation/x.json`, which can
be the output of a different shard. As a result, two manual per-shard runs do not
delete each other.

`--shards` applies to one target. A shard is a slice of one module. If you apply
it across several modules, the report names become ambiguous.

Do not run tests that call `process.chdir()` without a restore.
`preload-restore-cwd.mjs` guards against that case, below.

### Why `preload-restore-cwd.mjs` exists

The TAP runner writes its handshake file relative to the working directory. A
bound test that calls `process.chdir()` and then throws leaves the file elsewhere.
A mutant can cause exactly that failure. The runner then reports the mutant as
`RuntimeError`, and Stryker excludes it from the score. One measurement on a
227-mutant slice had 4 errors before the guard and 0 after. The run was 26%
faster, because failing mutants stopped the error path.

It must load before the coverage hook of Stryker (Node runs `exit` listeners in
registration order). That is why `TAP_NODE_ARGS` lists it first. `targetConfig`
resolves the path as an absolute path, because the runner spawns from the sandbox
and a relative `-r` fails the dry run there.

## Running locally

```bash
npm ci
node mutation/run.mjs --list                     # targets, budgets, shards, bindings
node mutation/run.mjs cache.ts                   # one module, full run
node mutation/run.mjs                            # every target, sequentially
node mutation/run.mjs cache.ts --shards 2        # split one module
node mutation/run.mjs cache.ts --mutate cache.ts:1-140   # one region
node mutation/run.mjs routing.ts --incremental # local loop, reuse unchanged
node mutation/run.mjs cache.ts --dry-run         # check binding, no mutants

node mutation/report.mjs --dir reports/mutation --out /tmp/mutation.md
```

The prerequisites are Node 24 and Bun 1.4.0. Five of six modules run under
`bun test`, so `bun` must be on `PATH`. `routing.ts` uses TAP and does not need
Bun. There is no per-invocation runner flag. The choice is `RUNNER_OVERRIDES`.

`--report` names one output file. The runner writes it exactly where you point it,
under `reports/`, and clears only that file. The runner enforces the boundary.
`reports/` is gitignored, and the runner deletes its own previous output before it
measures. As a result, a path elsewhere can delete a source file or a tracked
file. The flag requires exactly one target and cannot be combined with `--shards`.
Both cases fail immediately and do not ignore the flag silently. A normal run
clears the whole report set of the target first. Otherwise, a stale file merges
into the score.

## In CI

The workflow runs nightly at 04:47 UTC, and it also supports `workflow_dispatch`.
Every dispatch input defaults to the behavior of the nightly. As a result, a
manual run with no inputs measures the same thing.

| Input | Default | Meaning |
|---|---|---|
| `target` | `all` | Module name, or `all` |
| `shards` | `0` | 0 = auto from measured cost. 1 = no sharding |
| `concurrency` | `4` | Stryker workers, 1–16 |
| `timeout_tolerance` | blank | Blank = `max(10, 2%)` |
| `fail_on_unusable` | `true` | Fail the job on an unusable measurement |

There is no `upload_reports` switch. The leg upload is the only transport for a
report to the summariser, so it is unconditional. A retention knob that skips the
upload turns a good run into "every module missing".

There is no dispatch list to keep in sync. `target` is free text. The plan job
makes sure that it is valid against `TARGETS`. As a result, a new module is
dispatchable without a workflow edit.

The `plan` job makes sure that the inputs are valid before any work starts. It
emits the matrix, the selected targets, and the shard counts for each target. The
summariser judges completeness against that plan, not against every configured
target. As a result, a single-module dispatch is not four missing modules, and the
summary names a lost shard.

`workflow_dispatch` cannot run a workflow that is not yet on the default branch
(`HTTP 404`). That limit applies only to a new workflow file. For `mutation.yml`,
which already exists on the default branch, use
`gh workflow run mutation.yml --ref <branch>` and select the branch in the UI. The
`push:` trigger workaround is for the first landing of a new workflow file. Add it
temporarily, watch the run, and then remove it. The test suite asserts that the
merged workflow has no `push:` trigger.

## Extending this module

The project evaluated one addition and did not implement it. That addition is not
necessary while the nightly fits in 34.5 minutes:

The idea is to snap shard boundaries to mutant-free lines. 87 of the 244 lines of
`cache.ts` produce no mutants. As a result, you can place a boundary where no mutant
straddles it, and the overlap is no longer necessary. This approach is strictly
better than overlap, but it matters only when the project uses sharding.

The project also skipped `typescript-checker` deliberately. A measurement found 0
`RuntimeError`/`CompileError` across 1,727 mutants. As a result, per-mutant type
checking gives nothing for its cost.

## Measured baseline

A full local run took 8m48s and had 0 errors:

| Module | Runner | Mutants | Killed | Survived | NoCoverage | Timeout | Population | Conclusive |
|---|---|---|---|---|---|---|---|---|
| `cache.ts` | bun | 229 | 172 | 48 | 9 | 0 | 75.11% | 75.11% |
| `classifier-semantics.ts` | bun | 157 | 85 | 26 | 46 | 0 | 54.14% | 54.14% |
| `inline-override.ts` | bun | 21 | 19 | 2 | 0 | 0 | 90.48% | 90.48% |
| `reliability.ts` | bun | 352 | 251 | 93 | 8 | 0 | 71.31% | 71.31% |
| `reliability-v2.ts` | bun | 2447 | 1432 | 707 | 307 | 1 | 58.52% | 58.54% |
| `routing.ts` | tap | 1000 | 681 | 214 | 98 | 7 | 68.10% | 68.58% |
| All | | 4206 | 2640 | 1090 | 468 | 8 | 62.77% | 62.89% |

The two columns differ only where timeouts occur. The population score keeps
timeouts in the denominator as unresolved. The conclusive score removes them from
both the numerator and the denominator. Only `routing.ts` changes.

CI (4-core, before the addition of `inline-override.ts`) took 19 minutes for five
modules. `inline-override.ts` adds 21 mutants and 1.3 seconds. The projection
holds it at the one-minute floor (`estimatedMinutes` never returns less than 1),
so the plan stays at 34.5m.

Its two survivors are genuine test gaps. Both are in the `firstWord` regex at
`inline-override.ts:28`:

- `/^([a-zA-Z]+)\s+/` → `/([a-zA-Z]+)\s+/` (dropped the `^` anchor). Nothing
  asserts that the regex does not match a tier name that appears later in the
  prompt.
- `/^([a-zA-Z]+)\s+/` → `/^([a-zA-Z]+)\s/` (`\s+` → `\s`). Nothing asserts that
  multiple spaces or a tab after the first word still parse as an override.
