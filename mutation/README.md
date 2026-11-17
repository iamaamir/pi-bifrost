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

### 4. Add it to the dispatch list

`.github/workflows/mutation.yml` lists targets under `workflow_dispatch.inputs.target`
as `type: choice`. A module missing from that list cannot be dispatched on its own
at all, so add it there too. A test asserts the list matches `TARGETS`, so
forgetting this fails the suite rather than surfacing months later.

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

## Reading the three scores

The summary publishes all three, always, each with its formula stated in the
output. One number cannot answer three different questions.

| Score | Formula | Question |
|---|---|---|
| **Population** | `Killed / (total - Ignored)` | Of every mutant evaluated, how many did the tests kill? |
| Conclusive | `Killed / (Killed + Survived + NoCoverage)` | Of the mutants that reached a verdict, how many were caught? |
| Stryker | `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)` | Stryker's native score |

**Read population first.** It is the only one that cannot be read as "the tests
caught it": a timeout, a runtime error and a compile error all stay in its
denominator and never reach its numerator.

The score this used to call **honest** was `Killed / (Killed + Survived +
NoCoverage)`. That name was wrong. A run with one kill and nine timeouts reported
100%, because timeouts sat in neither the numerator nor the denominator — valid as
a rate over conclusive outcomes, misleading as a rate over the population. It is
now **conclusive**, shown beside population rather than instead of it.

A `Timeout` can be a genuine infinite-loop detection, or it can mean the budget
was too small for the suite — indistinguishable in the report. Crediting them
silently is how a broken budget turns into a 99.43% score. Measured case: eight
bound files, 208 of 352 mutants reported as timeouts.

`NoCoverage` counts against both scores because a mutant no test reaches is a
mutant no test asserts. `Ignored` mutants leave the population denominator
entirely, since Stryker never evaluated them. This is why `reliability-v2.ts` sits
at 58.5%: 307 of its mutants are unreached, largely because one test file
(`tests/reliability-v2-state-machine.test.ts`) holds 77% of the module's
assertions. Splitting that file is the single highest-value follow-up.

## The usability gate

A score over a silently smaller population is worse than no score. `require-usable`
fails the run (not the merge) when:

| Condition | Allowance | Why |
|---|---|---|
| No module reports | — | Nothing was measured |
| Missing module report | — | A matrix leg did not run |
| Missing **shard** | — | The module reports, but only part of it measured |
| A module reports **zero mutants** | — | It parsed and carries nothing; 0/0 is not a perfect score |
| `Timeout` mutants | `max(10, 2%)` aggregate **and** per module | Budget collapse is indistinguishable from real timeouts |
| `RuntimeError` + `CompileError` | `max(5, 2%)` aggregate **and** per module | **Stryker excludes these from the denominator** |
| A report for a module **outside the selected set** | 0 | It is excluded from the score, but its presence means the artifact set is not the planned one |
| A report whose **measurement identity** differs | 0 | It measured different bytes (revision, binding or config); merging it would publish a composite |
| **Two files claiming one shard** | 0 | `<module>.json` is shard 0, so it collides with `<module>.shard0.json`; one of them is stale |
| An **unstamped** report | 0 | Its provenance is unknown, so nothing can establish what it measured |
| A shard **outside** the plan | 0 | A stale or misrouted artifact was merged — missing-shard detection cannot see it |
| Shard conflicts | 0 | Overlapping shards disagreed — not reproducible |

The error row is the important one. Stryker drops errored mutants from the score,
so 320 errors out of 388 prints a confident score over the surviving 68 with
nothing in the output saying so. Measured, from a test calling `process.chdir()`.

**Every module is judged as well as the aggregate**, against the same rule applied
to its own population. Aggregate-only checks hide a broken module inside a healthy
run: 80 errors in a 229-mutant module is 35% of that module, but it sits under the
aggregate allowance of 85 for a 4,200-mutant run, so the gate used to accept it.
The failure now names the module and prints observed and allowed counts.

A run that fails the gate still publishes its summary, report and survivors.
Failing the measurement is not the same as discarding the evidence.

Override the timeout allowance from a dispatch with `timeout_tolerance`; leave it
blank for the calibrated default. It is an absolute count and bounds **each module
as well as the aggregate**, otherwise the override would clear the aggregate check
and still fail the module that needed it. It is stored at the top level of
`summary.json`, which is where the gate reads it.

## Time budget

A **60-minute planning objective**, well inside GitHub's 6-hour job limit. It is
**not a hard deadline**: GitHub Actions has no workflow-wide wall-clock limit, so
nothing can enforce one. See [What is actually enforced](#what-is-actually-enforced).

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
order — the order the matrix lists them, starting the next leg when a lane frees.
**GitHub does not guarantee matrix execution order**, only that at most
`max-parallel` jobs run at once, so this is a projection assumption rather than a
dispatch guarantee: a different order can produce a longer wall clock than the
projection, which is why the number is a planning objective. The old formula was
`max(leg) + reserve`, which assumed every leg started at once — exact only while
the leg count is at or below the lane count. Sharding six modules four ways is 24
legs:

```
SHARDS=4 node mutation/workflow.mjs plan
# matrix legs: 24 (concurrency 4)
# projected wall clock: 18.1m of the 60m planning budget, 3 wave(s) of 24 leg(s) across 8 lanes
```

`max(leg)` would have said 17.6m. The difference is the wait before the large
modules' legs — listed last — are dispatched. A test asserts `MATRIX.maxParallel`
matches the workflow, so the two cannot drift.

`ciSlowdownFactor: 3` converts a 10-core local measurement into a 4-core runner
estimate. Measured ratios were `routing.ts` 2.7× and `reliability-v2.ts` 3.9×.
Plan at 1.0 and the local run passes while CI quietly overruns.

Still an estimate, because: GitHub scheduling and image pulls add delay the
planner cannot see; shards overlap, so each covers slightly more than an even
share; and a leg that overruns has no workflow-wide deadline to stop it.

### What is actually enforced

- the plan refuses an infeasible matrix before any job starts, naming the module —
  and it never meets the cap by measuring fewer mutants;
- each leg's `timeout-minutes` = `legMinutes()` (48m), so one stuck leg cannot burn
  the window;
- the summarise job's own 15-minute timeout;
- the usability gate, which fails an incomplete measurement whatever the clock says.

## Runner choice: Bun by default, TAP when the verdict depends on the engine

`bun` is the default because it reports coverage **per test**, so each mutant runs
only the tests that reach it. TAP reports per file, so each mutant pays the whole
file. Measured on identical mutants:

| Module | TAP | Bun |
|---|---|---|
| `cache.ts` | 27s | 4s |
| `reliability-v2.ts` | 5m30s | 10s |
| `routing.ts` | 5m31s | 1m16s |

**Agreement, measured on current HEAD** with each engine run twice from a clean
`.stryker-tmp`:

- `cache.ts` (229 mutants): all four runs — bun ×2, TAP ×2 — report the same
  172 killed / 48 survived / 9 uncovered, and all 229 verdicts agree across
  engines. Bun is deterministic repeated.
- `inline-override.ts` (21 mutants): 21 of 21 identical on both engines, both
  repeats.
- `reliability-v2.ts` (291-mutant slice `495-575`): Bun vs TAP differ on 4 of 291
  — but **3 of those 4 also differ between two identical Bun runs**, because the
  slice reads `now` and expiry values. On that slice the A/B cannot attribute a
  difference to the engine at all. This is why the older "226 of 227, one
  `ObjectLiteral` at line 221" claim was removed: on current HEAD that mutant is
  killed by both engines and the figure is not reproducible.

`routing.ts` is where the engine demonstrably decides the verdict, and it is the
only override: `^(a+)+$` on a 25-character canary takes **V8 475ms vs
JavaScriptCore 66ms**. When a mutant bypasses the backtracking probe the regex
runs in the host process, so only the production engine answers what production
would ask. Subprocess pinning did not fix it.

Equivalence is established by measurement, not proof: Bun is trusted for a module
because its verdicts match TAP within that module's own noise floor. A module
depending on engine behaviour no sampled mutant exercises would not be caught;
the mitigation is the override plus recording why.

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

**Every report carries the measurement it belongs to.** The runner stamps each
report it writes with a content identity — the module's bytes, the local modules
it and its bound tests import, `mutation/config.mjs`, the binding rules
(`mutation/targets.mjs`), the Stryker shim and the resolved dependency set
(`package-lock.json`) — and the summariser accepts a report only if
that identity matches the current checkout. The identity is per module, because
a module's population is what one measurement of it covered; a single per-run
value would either accept everything or reject everything. A report from a
different revision, binding or config is rejected and named, never merged. It
also means the artifact file name does not have to encode provenance, which is
why the download pattern stays `mutation-report-*`: scoping it to the current
`run_attempt` would hide the legs a partial re-run did not retry.

**A report records the scope it measured.** An unsharded `<module>.json` stands
for the whole module, so a run that mutated only a line range must name its
artifact with `--report`; the summariser rejects an unsharded report whose scope
is a range, because a one-shard plan would otherwise score part of a module as
all of it. Sharded reports may carry ranges — that is what a shard is.

**A dry run never clears reports.** `--dry-run` measures nothing and writes
nothing, so deleting the previous measurement would destroy a real result to make
room for a report that never exists. It is refused with `--report`, which would
name that nonexistent file.

**A shard's scope must be the scope the plan assigned it.** Sharding is line
ranges, so the only evidence of what a shard actually mutated is the range in its
provenance. A leg that mutated ten lines of a 163-line shard still calls itself
shard 0; without this check it merges as shard 0 and the skipped mutants are
invisible, because `total` counts what was measured, not what was planned. The
reporter derives the plan from the module (`shardsFor`) and the requested shard
count, and rejects any shard whose range differs — truncated, extended, swapped,
or out of range. Filenames never establish completeness.

**Artifacts are not merged on download.** Each leg uploads its own artifact, and
the summarise job downloads them with `merge-multiple: false` so every artifact
keeps its own directory. Flattening would put two attempts of one shard on the
same filename and leave the survivor to extraction order. The reporter reads the
attempt from the artifact path and takes the newest attempt per `(module, shard)`;
two reports for one shard *within* an attempt are rejected as ambiguous rather
than resolved by order. That keeps "re-run failed jobs" working: untouched legs
stay on attempt 1 while retried legs move to attempt 2.

**An unreadable artifact blocks its slot; it never falls back.** A truncated
upload used to be dropped, which made the previous attempt look current — the
run was re-run because something failed, so its absence is not evidence of
success. A corrupt report now occupies its `(module, shard)` slot: if it is the
newest attempt for that slot the module is rejected, and if a readable newer
attempt exists the corrupt older one is superseded.

**The reporting root cannot leave the repository.** The default `reports/` must
resolve inside the checkout; a symlinked root pointing elsewhere is refused
before anything is created, written or deleted. A caller that passes its own root
is using that root as its trust anchor.

**Report output is confined to `reports/`, on resolved paths.** The boundary is
checked after resolving symlinks in every component that exists, so a path spelled
inside `reports/` that a symlinked directory redirects elsewhere is refused
rather than written or deleted through. Deleting uses the spelled path (removing
a symlink removes the link, not its target), and a symlinked report *file* is
refused because "remove our own output" would then mean two different things.
Components that do not exist yet are allowed: creating them creates exactly what
they name. Cleanup fails closed — if the boundary cannot be established it
deletes nothing.

**Stale reports are cleared per target.** The summariser merges every `*.json` in
`reports/mutation/`, so a previous run's file would be counted. Clearing matches
exact names only — `cache.ts` must never delete `cache-classifier.ts.json`. An
explicit `--report` owns exactly the resolved path it names — an
`reports/archive/x.json` target never deletes `reports/mutation/x.json`, which
may be a different shard's output — so two manual per-shard runs do not delete each other.

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

**Prerequisites:** Node 24 and **Bun 1.4.0**. Five of six modules run under
`bun test`, so `bun` must be on `PATH`. `routing.ts` uses TAP and does not need
it. There is no per-invocation runner flag; the choice is `RUNNER_OVERRIDES`.

`--report` names one output file, is written exactly where you point it **under
`reports/`**, and clears only that file. The boundary is enforced: `reports/` is
gitignored, and the runner deletes its own previous output before measuring, so
a path elsewhere could delete a source or tracked file. It requires exactly one target and
cannot be combined with `--shards`; both cases fail immediately rather than
silently ignoring the flag. Normal runs clear the target's whole report set first,
because a stale file would be merged into the score.

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

`target` is a `type: choice` list, so a new module must be added to it as well as
to `TARGETS`; a test asserts the two agree, because a module missing from the list
cannot be dispatched on its own at all.

The `plan` job validates inputs before any work starts and emits the matrix,
the selected targets and the per-target shard counts. The summariser judges
completeness against **that plan**, not against every configured target — so a
single-module dispatch is not four missing modules, and a lost shard is named.

`workflow_dispatch` cannot run a workflow that **is not yet on the default
branch** (`HTTP 404`). That only affects a brand-new workflow coming into
existence: for `mutation.yml`, which already exists on the default branch, use
`gh workflow run mutation.yml --ref <branch>` and pick the branch in the UI. The
`push:` trigger workaround is for the first landing of a new workflow file — add
it temporarily, watch the run, then remove it. The test suite asserts there is no
`push:` trigger in the merged workflow.

## Extending this module

One addition has been evaluated and is not implemented, because it is not needed
while the nightly fits in 34.5 minutes:

**Snapping shard boundaries to mutant-free lines.** 87 of `cache.ts`'s 244
   lines produce no mutants, so a boundary can be placed where no mutant straddles
   it, removing the need for overlap entirely. Strictly better than overlapping,
but only matters once sharding is actually used.

Also deliberately skipped: `typescript-checker`. Measured **0**
`RuntimeError`/`CompileError` across 1,727 mutants, so per-mutant type checking
buys nothing for its cost.

## Measured baseline

Full local run, 8m48s, 0 errors:

| Module | Runner | Mutants | Killed | Survived | NoCoverage | Timeout | Population | Conclusive |
|---|---|---|---|---|---|---|---|---|
| `cache.ts` | bun | 229 | 172 | 48 | 9 | 0 | 75.11% | 75.11% |
| `classifier-semantics.ts` | bun | 157 | 85 | 26 | 46 | 0 | 54.14% | 54.14% |
| `inline-override.ts` | bun | 21 | 19 | 2 | 0 | 0 | 90.48% | 90.48% |
| `reliability.ts` | bun | 352 | 251 | 93 | 8 | 0 | 71.31% | 71.31% |
| `reliability-v2.ts` | bun | 2447 | 1432 | 707 | 307 | 1 | 58.52% | 58.54% |
| `routing.ts` | tap | 1000 | 681 | 214 | 98 | 7 | 68.10% | 68.58% |
| **All** | | **4206** | **2640** | **1090** | **468** | **8** | **62.77%** | **62.89%** |

The two columns separate only where there are timeouts: population keeps them in
the denominator as unresolved, conclusive drops them from both sides. Only
`routing.ts` moves.

CI (4-core, before `inline-override.ts` was added): 19 minutes for five modules. `inline-override.ts` adds 21
mutants and 1.3 seconds, and is held at the one-minute floor in the projection
(`estimatedMinutes` never returns less than 1), so the plan stays at 34.5m.

Its two survivors are genuine test gaps, both on the `firstWord` regex at
`inline-override.ts:28`:

- `/^([a-zA-Z]+)\s+/` → `/([a-zA-Z]+)\s+/` (dropped the `^` anchor) — nothing
  asserts that a tier name appearing later in the prompt is not matched.
- `/^([a-zA-Z]+)\s+/` → `/^([a-zA-Z]+)\s/` (`\s+` → `\s`) — nothing asserts that
  multiple spaces or a tab after the first word still parse as an override.
