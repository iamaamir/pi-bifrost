// Mutation measurement configuration — the single place to tune Stryker.
//
// Everything a person would want to change lives in this file: which modules are
// measured, each module's timeout budget, the Stryker options, the score
// thresholds, the summary limits, and the "is this run trustworthy" tolerance.
// The derivation logic is in ./targets.mjs and rendering is in ./report.mjs, so
// editing this file cannot break either.
//
// This is a scheduled measurement, not a release gate. See
// ../docs/mutation-testing.md.

/**
 * Measured modules, their per-module timeout budgets, and measured cost.
 *
 * Stryker's per-mutant timeout is `dryRunDuration * timeoutFactor + timeoutMS`,
 * so the budget must be sized to the module's own bound suite. A shared budget
 * sized for the fastest module reports every slower module's mutants as
 * `Timeout`, and Stryker counts a timeout as detected, which inflates the score
 * instead of failing. Sized for the slowest module it does the same in reverse.
 *
 * `secondsPerMutant` is measured wall-clock throughput per runner, and it is
 * what the time budget is computed from. Concurrency barely moves it — measured
 * 1.61 s/mutant at 6 workers and 1.67 at 4 under TAP (ratio 0.97) — because the
 * cost is per-mutant process startup, not CPU. That is why the budget is met by
 * **sharding across machines**, not by adding workers locally.
 *
 * Measured with the Bun runner on a 10-core host, full unsharded runs:
 *   cache.ts                229 mutants     3s  -> 0.013 s/mutant
 *   classifier-semantics.ts 157 mutants     3s  -> 0.019 s/mutant
 *   inline-override.ts       21 mutants   1.3s  -> 0.062 s/mutant
 *   reliability.ts          352 mutants    14s  -> 0.040 s/mutant
 *   reliability-v2.ts      2447 mutants  1m35s  -> 0.039 s/mutant
 *   routing.ts             1000 mutants  7m29s  -> 0.449 s/mutant (TAP: production engine)
 */
export const TARGETS = {
  "cache.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.013 },
  "classifier-semantics.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.019 },
  "inline-override.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.062 },
  "reliability.ts": { timeoutFactor: 4, timeoutMS: 30_000, secondsPerMutant: 0.04 },
  "reliability-v2.ts": { timeoutFactor: 2, timeoutMS: 30_000, secondsPerMutant: 0.039 },
  "routing.ts": { timeoutFactor: 4, timeoutMS: 30_000, secondsPerMutant: 0.449 },
  // A gate script, not a product module. Its bound tests cover the structural
  // rule scope, the duplication threshold, and the parsers that turn tool
  // output into findings. A mutant survives when a gate stops failing a tree it
  // must fail, which is a silent regression in the safety net itself. The
  // complexity script is not a target: its own suite analyzes the repository,
  // and Stryker's instrumented copy inflates the numbers that suite asserts.
  "scripts/toolbox.mjs": { timeoutFactor: 2, timeoutMS: 30_000, secondsPerMutant: 0.05 },
};

/**
 * Self-imposed wall-clock cap for the whole measurement, in minutes.
 *
 * GitHub's hard limits are 6 hours per job and 35 days per workflow run
 * (https://docs.github.com/en/actions/reference/limits), and neither can be
 * raised. We voluntarily stay well inside them: a measurement that takes an hour
 * is a nightly job nobody reruns, and a job that silently hits the platform
 * limit fails after burning the whole window.
 *
 * The cap is met by **sharding**, never by measuring fewer mutants. Sharding
 * multiplies machines, so it buys wall clock without touching the mutant
 * population, the binding, or the thresholds. If a module cannot fit even at
 * `SHARDING.maxShards`, the plan fails in seconds with a clear message instead
 * of running long and failing later.
 *
 * Arithmetic (one module per leg, legs run in parallel):
 *   wall clock = setup + plan + max(leg) + summarise
 * A leg is one shard of one module, so the pipeline fits when every module's
 * shard cost fits `minutes - reserveMinutes`.
 */
export const TIME_BUDGET = {
  /** Hard ceiling for the whole measurement. The plan refuses to exceed it. */
  minutes: 60,
  /** Checkout, `npm ci`, plan and summarise do not mutate anything; reserve them. */
  reserveMinutes: 12,
  /**
   * Slowdown to apply to measured cost when planning a GitHub-hosted run.
   *
   * The `secondsPerMutant` figures above were measured on a 10-core host.
   * Standard GitHub-hosted runners have 4 cores. Measured on the first real
   * dispatch, subtracting per-job setup: `routing.ts` took 17.4 minutes against
   * 6.6 locally (2.7x) and `reliability-v2.ts` 6.9 against 1.8 (3.9x). Planning
   * at 1.0 would produce a budget comfortably met locally and quietly overrun in
   * CI, which is the failure this cap exists to prevent.
   *
   * 3.0 covers the observed range with margin on the leg that sets the wall
   * clock. Locally this is 1.
   */
  ciSlowdownFactor: 3,
  /**
   * What a single leg is planned to take, as opposed to what it is allowed to
   * take. Shards are sized to this, so a module lands well inside the cap rather
   * than exactly on it: a plan that projects 58 of 60 minutes has no room for a
   * slow runner, a cold npm cache, or one module running over its estimate.
   */
  targetLegMinutes: 30,
};

/**
 * Runner-side concurrency limits for the matrix.
 *
 * `maxParallel` is how many matrix legs GitHub will run at once. It must match
 * `strategy.max-parallel` in `.github/workflows/mutation.yml` — a test asserts
 * the two agree — because the planner models waves with it. Without it the
 * projection assumed every leg started simultaneously, which is only true while
 * the leg count is at or below this number. Sharding six modules four ways is 24
 * legs: three waves, not one.
 */
export const MATRIX = {
  maxParallel: 8,
};

/**
 * The per-leg hard allowance: the cap minus the fixed overhead. A leg that
 * exceeds this would put the pipeline over budget.
 */
export function legMinutes() {
  return TIME_BUDGET.minutes - TIME_BUDGET.reserveMinutes;
}

/**
 * Mutant counts used for planning, measured or projected. Kept next to the
 * per-mutant cost because the product is what the budget cares about. These are
 * planning inputs, not results: the report always carries the real counts.
 */
export const MUTANT_ESTIMATE = {
  "cache.ts": 229,
  "classifier-semantics.ts": 157,
  "inline-override.ts": 21,
  "reliability.ts": 352,
  "reliability-v2.ts": 2447,
  "routing.ts": 1000,
  "scripts/toolbox.mjs": 855,
};

/**
 * Estimated unsharded minutes for one module, from measured throughput.
 *
 * `planned` applies the CI slowdown and is what the budget check uses; `local`
 * is the raw measurement, for a developer reading `--list` on their own machine.
 * A floor of one minute keeps a tiny module from looking free: the dry run and
 * sandbox setup are real even when the mutant count is small.
 */
export function estimatedMinutes(target, { planned = true } = {}) {
  const spec = TARGETS[target];
  if (!spec?.secondsPerMutant) throw new Error(`mutation target ${target} has no measured cost`);
  // A missing estimate used to produce NaN, which made `suggestedShards` build
  // zero legs: the plan dropped the module and still reported success.
  const mutants = MUTANT_ESTIMATE[target];
  if (!Number.isFinite(mutants) || mutants <= 0) {
    throw new Error(`mutation target ${target} has no mutant estimate; add it to MUTANT_ESTIMATE`);
  }
  const factor = planned ? TIME_BUDGET.ciSlowdownFactor : 1;
  return Math.max(1, (mutants * spec.secondsPerMutant * factor) / 60);
}

/**
 * Which Stryker test runner a target uses. This is the single most consequential
 * setting here, because it decides everything downstream.
 *
 * `bun` (default, measured fastest)
 *   `@hughescr/stryker-bun-runner` runs `bun test`, which executes this
 *   repository's `node:test` files unchanged (verified: the 27 files bound to
 *   Bun-run modules ran 679 tests with 0 failures under Bun 1.4.0). It reports
 *   coverage **per test**, not per file, so each mutant runs only the individual
 *   tests that reach it.
 *
 * `tap`
 *   `@stryker-mutator/tap-runner` drives `node --test --test-reporter=tap` and
 *   reports coverage **per test file**. Slower, but it is the only option for a
 *   module whose bound tests Bun cannot run.
 *
 * The measured runner comparison, including the cross-engine results that are
 * stable enough to quote, lives in ../docs/mutation-testing.md. It is not
 * duplicated here: the earlier copy in this file drifted from the measurement.
 *
 * The per-test granularity is what buys the speed: Bun runs ~8 tests per mutant
 * where TAP runs whole files, so a module bound to one heavy file no longer pays
 * that file's full runtime per mutant.
 *
 * **Bun is not usable for every module.** `tests/reliability-migration.test.ts`
 * asserts Node's `fsync`-on-lock-file failure semantics, which Bun does not
 * reproduce — one test fails, so the dry run aborts. Excluding the file would
 * silently stop measuring the mutants it kills, so those modules stay on TAP.
 * The runner's own dry run is the guard: a bound test that Bun cannot run fails
 * the run immediately with a clear message rather than scoring a smaller
 * population.
 */
export const TEST_RUNNER = "bun";

/**
 * Stryker only auto-loads plugins named `@stryker-mutator/*`, so a third-party
 * test runner must be registered explicitly.
 */
export const BUN_RUNNER_PLUGIN = "@hughescr/stryker-bun-runner";

/**
 * Per-target runner override. Absent means `TEST_RUNNER`.
 *
 * An entry carries the reason it exists, and a test requires one, so an override
 * cannot become unexplained folklore. Two kinds of reason are legitimate:
 *
 * - a bound test that Bun cannot run at all, which aborts Bun's dry run;
 * - a bound test whose *verdict* differs between engines, where only the
 *   production engine gives the answer production would give.
 *
 * `tests/reliability-migration.test.ts` used to be the first kind: it injected a
 * fault by patching `node:fs`, which Bun cannot do (`syncBuiltinESMExports()` is
 * a no-op there, and a `node:fs` mock cannot be undone). It now injects the fault
 * by editing a private source copy, so it runs on both runtimes.
 */
/**
 * Targets that Stryker measures in place instead of in a sandbox.
 *
 * The sandbox always excludes `.git`, so a bound test that runs `git ls-files`
 * sees an empty index and fails before any mutant is measured. The gate scripts
 * read the tracked-file list, so they need the real checkout. In-place mutation
 * writes the mutated bytes into the checkout and puts the originals back when
 * the run ends. Use it only for the scheduled measurement and a deliberate
 * local run.
 */
export const IN_PLACE_TARGETS = new Set(["scripts/toolbox.mjs"]);

export const RUNNER_OVERRIDES = {
  "routing.ts": {
    runner: "tap",
    reason:
      "its rule tests deliberately let a catastrophic regex run in-process when a mutant bypasses the backtracking probe, and V8 and JavaScriptCore backtrack at different speeds (measured 475ms vs 66ms for ^(a+)+$). A verdict on that code is only faithful under the production engine, so this module runs on Node.",
  },
};

/**
 * Node arguments for the TAP runner. `{{hookFile}}` injects Stryker's coverage
 * hook and `{{testFile}}` selects the file, both supplied by the runner.
 *
 * The cwd guard is resolved to an **absolute path by `targetConfig`**, because
 * the TAP runner spawns the child from the sandbox and a relative `-r` path is
 * not reliably resolvable there (measured: the dry run fails outright). The
 * guard is a standalone module with no repository imports, so pointing at the
 * original checkout from inside the sandbox is harmless.
 *
 * Order matters: `preload-restore-cwd.mjs` must come **before** `{{hookFile}}`.
 * The TAP runner writes its handshake file relative to the working directory,
 * and a bound test that calls `process.chdir()` without restoring — which is
 * what happens when a mutant makes it throw before its cleanup runs — sends that
 * file elsewhere. Those mutants surface as `RuntimeError`, which Stryker
 * excludes from the score, so the module reports a score over a silently smaller
 * population. Measured on a 227-mutant slice: 4 errors before the guard, 0
 * after, and the run got 26% faster because failing mutants stopped paying the
 * error path. Node runs `exit` listeners in registration order, so requiring the
 * guard first is what makes it win.
 */
export const TAP_NODE_ARGS = [
  "--experimental-strip-types",
  "--test-reporter=tap",
  "-r",
  "{{cwdGuard}}",
  "-r",
  "{{hookFile}}",
  "{{testFile}}",
];

/**
 * Stryker options applied to every target.
 *
 * `thresholds` is the Stryker mutation-score gate. `break: null` is deliberate:
 * this measurement must never fail a run on a low score, because the score is
 * the measurement. Raise `high`/`low` to move the colour band shown by Stryker's
 * own clear-text reporter. Setting `break` would make the nightly job red on a
 * low score, which is not what this workflow is for.
 */
export const STRYKER_OPTIONS = {
  checkers: [],
  thresholds: { high: 0, low: 0, break: null },
  tempDirName: ".stryker-tmp",
  reporters: ["clear-text", "progress", "json"],
  // The leg uploads `stryker.log`; Stryker's default level is "off", so without
  // this the documented log never exists.
  fileLogLevel: "info",
  reportFile: "reports/mutation/mutation.json",
  /**
   * Stryker's default inserts `// @ts-nocheck` at the top of every sandbox
   * TypeScript file. That changes the bytes of files the bound tests read and
   * hash, so acceptance tests asserting a committed-file baseline fail the dry
   * run before a single mutant is measured. It also shifts every line number by
   * one, which would misattribute survivors. Node strips types at runtime
   * without type checking, so the directive buys nothing here. Do not re-enable.
   */
  disableTypeChecks: false,
};

/**
 * Sandbox directories that are not needed to run the bound tests.
 *
 * `docs` is deliberately absent: `tests/bifrost-commands.test.ts` reads
 * `docs/guide/commands.md`, and excluding it fails the dry run. `.pi` is
 * excluded because tests create their own `.pi` under a temp cwd, and copying a
 * developer's local `.pi` breaks on symlinked skill directories
 * (`ENOTSUP: operation not supported on socket`).
 */
export const SANDBOX_IGNORES = [".worktrees", "coverage", "evidence", "screenshots", ".agents", ".pi"];

/**
 * A `Timeout` counts as detected in Stryker's score. That is legitimate for a
 * mutant that introduces an infinite loop, and this target set has real
 * examples (a loop bound inverted, a counter decremented instead of
 * incremented). It is not legitimate when the bound command is merely slower
 * than the per-mutant budget: a measured eight-file reliability binding
 * reported 208 of 352 mutants as timeouts and a 99.43% score.
 *
 * The two are indistinguishable from the report, so this uses a calibrated
 * tolerance rather than either extreme. Observed genuine timeouts: 7 of 989
 * routing mutants (0.7%). A budget collapse lands an order of magnitude higher
 * (59% in the measured case).
 */
export const TIMEOUT_TOLERANCE = {
  share: 0.02,
  minimum: 10,
};

/**
 * How many survivors to show per module on the run page. The full list is in the
 * `survivors.jsonl` artifact, so this only controls the readable summary.
 */
export const SUMMARY = {
  survivorsPerModule: 3,
  mutatorsPerModule: 4,
};

/**
 * Sharding splits one module's mutants across several machine-hours so a large
 * module finishes inside a job bound and a local run can be scoped.
 *
 * Two axes were measured and only one is safe:
 *
 * - **Line ranges must overlap.** Adjacent ranges silently lose mutants that
 *   straddle a boundary: `1-100` + `100-244` recovered 176 of 229 mutants for
 *   `cache.ts`. Overlapping ranges (`1-140` + `120-244`) recovered all 229, and
 *   the 23 mutants measured twice agreed on status in every case. So adjacent
 *   shards overlap by `overlapLines`, and merging deduplicates by mutant
 *   identity.
 * - **Mutator exclusion is not usable.** `excludedMutations` still instruments
 *   excluded mutants as `Ignored`, so a shard's report is not a clean partition,
 *   and the evaluated sets were not exactly complementary (4 phantom
 *   `CallExpression` mutants appeared).
 *
 * `incremental` is a local loop only, never the nightly. Stored results cannot
 * see changes outside the mutated module and its bound tests (dependency
 * updates, environment, fixtures). With the retired `command` runner there was
 * no per-test coverage at all, so Stryker's `IncrementalDiffer` reused every
 * stored result unconditionally (`if (!testCoverage.hasCoverage) return true`):
 * measured, after editing a bound test file, 228 of 229 results were reused and
 * the old score was republished. `mutation/run.mjs --incremental` is opt-in,
 * and CI never sets it.
 */
export const SHARDING = {
  /** Lines of overlap between adjacent shards. Must exceed the longest mutation span. */
  overlapLines: 40,
  /** Shards a single module may split into. One means no sharding. */
  maxShards: 4,
};

/** The number of timeouts above which a run is treated as a broken measurement. */
export function timeoutTolerance(totalMutants) {
  return Math.max(TIMEOUT_TOLERANCE.minimum, Math.ceil(totalMutants * TIMEOUT_TOLERANCE.share));
}

/** Severity of a measurement diagnostic. Only `blocking` fails the gate. */
export const BLOCKING = "blocking";
export const ADVISORY = "advisory";

function note(code, severity, message, remedy = null) {
  return remedy === null ? { code, severity, message } : { code, severity, message, remedy };
}

/**
 * Per-module adjudication.
 *
 * The aggregate tolerances are calibrated against the whole run, which is the
 * right granularity for "is this measurement trustworthy overall" and the wrong
 * granularity for "is any one module broken". A module with 80 errored mutants
 * out of 229 is 35% unusable, but inside a 4,200-mutant run it sits under the
 * aggregate error allowance of 85 and the gate would accept the run while one
 * module measured almost nothing.
 *
 * So each module is judged against the same calibrated rule applied to its own
 * population, and the aggregate is judged as before. A dispatch override is an
 * absolute count of tolerated timeouts, so it bounds each module as well as the
 * aggregate -- otherwise it would clear the aggregate check and still fail the
 * module it was meant to rescue.
 */
export function moduleDiagnostics(module, timeoutOverride = null) {
  const diagnostics = [];
  const name = module?.module ?? "(unnamed module)";
  const total = Number(module?.total ?? 0);
  if (total === 0) {
    // A report exists but carries no mutants: instrumentation ran and produced
    // nothing, which is a failed measurement, not a perfect score.
    return [note("zero-mutants", BLOCKING, `${name}: reported zero mutants, so nothing in it was measured`)];
  }
  // A report can carry mutants and still evaluate none of them: every one
  // `Ignored` means Stryker skipped the whole module, so the population the run
  // claims is empty. A non-zero `total` must not hide that.
  const evaluated = Number(module?.evaluated ?? total);
  if (evaluated === 0) {
    return [note("no-evaluated-mutants", BLOCKING, `${name}: every one of its ${total} mutants is Ignored, so nothing in it was evaluated`)];
  }
  const timeouts = Number(module?.Timeout ?? 0);
  const timeoutsAllowed = timeoutOverride ?? timeoutTolerance(total);
  if (timeouts > timeoutsAllowed) {
    diagnostics.push(
      note(
        "module-timeout-burst",
        BLOCKING,
        `${name}: ${timeouts} of ${total} mutants timed out, above this module's tolerance of ${timeoutsAllowed}; its per-mutant budget is too small for its bound suite, so its Stryker score is inflated by timeouts`,
      ),
    );
  }
  const errors = Number(module?.RuntimeError ?? 0) + Number(module?.CompileError ?? 0);
  const errorsAllowed = runtimeErrorTolerance(total);
  if (errors > errorsAllowed) {
    diagnostics.push(
      note(
        "module-error-burst",
        BLOCKING,
        `${name}: ${errors} of ${total} mutants errored and are excluded from its score, above this module's tolerance of ${errorsAllowed}; the module reports a score over a population it never measured`,
      ),
    );
  }
  return diagnostics;
}

/**
 * How many `RuntimeError` mutants make a run unusable.
 *
 * Stryker **excludes** `RuntimeError` and `CompileError` from the score
 * denominator. That is defensible for a mutant that genuinely fails to compile,
 * and dangerous for a runner integration problem: measured here, a bound test
 * calling `process.chdir()` made the TAP runner lose its handshake file and
 * report 320 of 388 mutants as `RuntimeError`. The tool then happily printed a
 * score computed over the surviving 68 -- a smaller population than the one it
 * claimed to measure, with nothing in the output saying so.
 *
 * A zero tolerance would fail on the occasional genuine equivalence-style crash,
 * so this allows a small share and treats anything above it as a broken run.
 */
export const RUNTIME_ERROR_TOLERANCE = {
  share: 0.02,
  minimum: 5,
};

/** The number of errored mutants above which a run is treated as broken. */
export function runtimeErrorTolerance(totalMutants) {
  return Math.max(RUNTIME_ERROR_TOLERANCE.minimum, Math.ceil(totalMutants * RUNTIME_ERROR_TOLERANCE.share));
}

/**
 * Every judgement this measurement makes about itself, in one place.
 *
 * The gate and the published summary are two renderings of one policy: the gate
 * prints the blocking messages, the summary prints blocking and advisory ones
 * with their remedies. They used to be separate implementations of the same
 * rules, which is why a dispatch override could pass the gate while the summary
 * still reported the module as failing against the default. With one function
 * they cannot disagree.
 *
 * `blocking` means the measurement is unusable; `advisory` means the number is
 * usable but the reader should know. Nothing here is a score threshold: a low
 * score is the measurement, never a failure.
 */
export function measurementDiagnostics(data, options = {}) {
  const diagnostics = [];
  const aggregate = data?.aggregate ?? {};
  const modules = Array.isArray(data?.modules) ? data.modules : [];
  const total = Number(aggregate.total ?? 0);
  const override = data?.timeoutToleranceOverride ?? null;
  const timeoutsAllowed = override ?? timeoutTolerance(total);
  const errorsAllowed = runtimeErrorTolerance(total);
  const timeouts = Number(aggregate.Timeout ?? 0);
  const errors = Number(aggregate.RuntimeError ?? 0) + Number(aggregate.CompileError ?? 0);

  if (modules.length === 0) {
    diagnostics.push(note("no-modules", BLOCKING, "no module reports were produced"));
  }
  // A payload outlives the run that produced it. Re-checking one later used to
  // pass unconditionally, so a summary from an older tree reported a score for
  // code that no longer exists. The identity is recorded at build time and
  // checked here against the checkout, when the reader supplies one.
  if (options.identityFor) {
    const recorded = data?.measuredIdentity;
    for (const entry of modules) {
      let expected;
      try {
        expected = options.identityFor(entry.module);
      } catch (error) {
        // Skipping made a summary for a module that no longer exists — or whose
        // bound tests are now empty — pass the very check meant to catch it.
        // Being unverifiable is not the same as being current.
        diagnostics.push(
          note(
            "unverifiable-payload",
            BLOCKING,
            `${entry.module}: this payload cannot be checked against this checkout (${error.message}), so there is no evidence it is current`,
          ),
        );
        continue;
      }
      const claimed = recorded?.[entry.module];
      if (typeof claimed !== "string") {
        diagnostics.push(
          note("unstamped-payload", BLOCKING, `${entry.module}: this payload records no measurement identity, so there is no evidence of which bytes produced its score`),
        );
      } else if (claimed !== expected) {
        diagnostics.push(
          note("stale-payload", BLOCKING, `${entry.module}: measured against different bytes (${claimed.slice(0, 12)} in the payload, ${expected.slice(0, 12)} here); rerun the measurement`),
        );
      }
    }
  }
  if (Array.isArray(data?.missingTargets) && data.missingTargets.length > 0) {
    diagnostics.push(
      note("missing-module", BLOCKING, `missing module reports: ${data.missingTargets.join(", ")}`, "A missing matrix leg is not a pass."),
    );
  }
  // A module that reports at all can still be missing a shard. Without this the
  // merged score covers a subset of the planned mutants while looking complete.
  if (Array.isArray(data?.missingShards) && data.missingShards.length > 0) {
    const detail = data.missingShards.map(({ module, shard }) => `${module} shard ${shard}`).join(", ");
    diagnostics.push(
      note("missing-shard", BLOCKING, `missing module shards: ${detail}; the score would cover only part of the planned mutants`),
    );
  }
  // A report whose stamped identity does not match this checkout measured
  // different bytes. It is excluded from the score, and the module it belonged to
  // is then incomplete -- a failed measurement, not a stale number that happens
  // to look plausible.
  if (Array.isArray(data?.rejectedModules) && data.rejectedModules.length > 0) {
    const detail = (Array.isArray(data?.rejectedReports) ? data.rejectedReports : [])
      .slice(0, 5)
      .map((entry) => `${entry.module} (${entry.name}): ${entry.reason}`)
      .join("; ");
    diagnostics.push(note("rejected-report", BLOCKING, `rejected reports for ${data.rejectedModules.join(", ")}: ${detail}`));
  }
  // A report for a module this run did not plan is excluded from the score, so
  // the published number is clean. Its presence still means the report set is not
  // the one the plan described.
  if (Array.isArray(data?.unexpectedTargets) && data.unexpectedTargets.length > 0) {
    diagnostics.push(
      note(
        "unexpected-module",
        BLOCKING,
        `unexpected module reports: ${data.unexpectedTargets.join(", ")}; they were excluded from the score, but a report outside the selected set means the artifact set is not the planned one`,
        "Update `mutation/config.mjs` if the target set changed.",
      ),
    );
  }
  // A shard the plan did not ask for means a stale or misrouted artifact was
  // merged: the population then differs from the planned one, and missing-shard
  // detection cannot see it.
  if (Array.isArray(data?.unexpectedShards) && data.unexpectedShards.length > 0) {
    const detail = data.unexpectedShards.map(({ module, shard, planned }) => `${module} shard ${shard} (plan has ${planned})`).join(", ");
    diagnostics.push(
      note(
        "unexpected-shard",
        BLOCKING,
        `unexpected module shards: ${detail}; a shard outside the plan is stale or misrouted, so the merged population is not the planned one`,
      ),
    );
  }

  if (timeouts > timeoutsAllowed) {
    diagnostics.push(
      note(
        "timeout-burst",
        BLOCKING,
        `${timeouts} timed-out mutants exceed the tolerance of ${timeoutsAllowed}; the per-mutant budget is too small for the bound suite, so the Stryker score is not trustworthy`,
        "Stryker counts a timeout as detected, so the Stryker score is inflated. Raise the module's `timeoutFactor`/`timeoutMS` in `mutation/config.mjs` before trusting this run.",
      ),
    );
  } else if (timeouts > 0) {
    diagnostics.push(
      note(
        "timeouts-observed",
        ADVISORY,
        `${timeouts} mutant(s) timed out (tolerance ${timeoutsAllowed}). A timeout counts as detected in the Stryker score and is unresolved in the population score, so population is the one to read. A few are expected: a mutant that inverts a loop bound or decrements a counter instead of incrementing it genuinely does not terminate.`,
      ),
    );
  }

  const conflicts = Number(aggregate.shardConflicts ?? 0);
  if (conflicts > 0) {
    const sample = Array.isArray(data?.shardConflictSample) && data.shardConflictSample.length > 0 ? `: ${data.shardConflictSample.join(", ")}` : "";
    diagnostics.push(
      note(
        "shard-conflict",
        BLOCKING,
        `${conflicts} shard conflict(s)${sample}; overlapping shards disagreed on the same mutant, so the sharded run is not reproducible`,
        "Rerun that module without sharding.",
      ),
    );
  }

  if (errors > errorsAllowed) {
    diagnostics.push(
      note(
        "error-burst",
        BLOCKING,
        `${errors} mutant(s) errored and are excluded from the score, above the tolerance of ${errorsAllowed}; the reported score is computed over a smaller population than the run claims, so it is not usable`,
        "With no type checker configured these are excluded from the denominator; `@stryker-mutator/typescript-checker` would classify them as compile errors instead.",
      ),
    );
  } else if (errors > 0) {
    diagnostics.push(
      note(
        "errors-observed",
        ADVISORY,
        `${errors} mutant(s) errored at runtime or compile time (tolerance ${errorsAllowed}). With no type checker configured these are excluded from the denominator; \`@stryker-mutator/typescript-checker\` would classify them as compile errors instead.`,
      ),
    );
  }

  if (Number(aggregate.NoCoverage ?? 0) > 0) {
    // Measured coverage means these are real: no bound test reaches the mutated
    // line at all. That is a coverage gap (or dead code), not a weak assertion,
    // so it belongs on a different backlog from the survivors.
    diagnostics.push(
      note(
        "no-coverage",
        ADVISORY,
        `${aggregate.NoCoverage} mutant(s) have no coverage: no bound test reaches those lines. That is a coverage or dead-code gap rather than a weak assertion. They count against both scores.`,
      ),
    );
  }

  for (const module of modules) diagnostics.push(...moduleDiagnostics(module, override));
  return diagnostics;
}

/**
 * The gate: the blocking diagnostics, as plain messages.
 *
 * A low score is the measurement, not a failure. Only unusable measurements
 * reach this list.
 */
export function unusableReasons(data, options = {}) {
  return measurementDiagnostics(data, options)
    .filter((diagnostic) => diagnostic.severity === BLOCKING)
    .map((diagnostic) => diagnostic.message);
}
