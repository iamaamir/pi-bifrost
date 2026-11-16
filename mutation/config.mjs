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
 *   reliability.ts          352 mutants    14s  -> 0.040 s/mutant
 *   reliability-v2.ts      2447 mutants  1m35s  -> 0.039 s/mutant
 *   routing.ts             1000 mutants  7m29s  -> 0.449 s/mutant (TAP: production engine)
 */
export const TARGETS = {
  "cache.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.013 },
  "classifier-semantics.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.019 },
  "reliability.ts": { timeoutFactor: 4, timeoutMS: 30_000, secondsPerMutant: 0.04 },
  "reliability-v2.ts": { timeoutFactor: 2, timeoutMS: 30_000, secondsPerMutant: 0.039 },
  "routing.ts": { timeoutFactor: 4, timeoutMS: 30_000, secondsPerMutant: 0.449 },
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
   * Standard GitHub-hosted runners have 4 cores, and each mutant spawns one
   * `node --test` process per covering file, so the runner is closer to a 2x
   * machine on this workload than a 2.5x one. Planning at 1.0 would produce a
   * budget that is comfortably met locally and quietly overrun in CI, which is
   * the failure this cap exists to prevent. Locally this is 1.
   */
  ciSlowdownFactor: 1.8,
  /**
   * What a single leg is planned to take, as opposed to what it is allowed to
   * take. Shards are sized to this, so a module lands well inside the cap rather
   * than exactly on it: a plan that projects 58 of 60 minutes has no room for a
   * slow runner, a cold npm cache, or one module running over its estimate.
   */
  targetLegMinutes: 30,
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
  "reliability.ts": 352,
  "reliability-v2.ts": 2447,
  "routing.ts": 1000,
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
  const factor = planned ? TIME_BUDGET.ciSlowdownFactor : 1;
  return Math.max(1, (MUTANT_ESTIMATE[target] * spec.secondsPerMutant * factor) / 60);
}

/**
 * Which Stryker test runner a target uses. This is the single most consequential
 * setting here, because it decides everything downstream.
 *
 * `bun` (default, measured fastest)
 *   `@hughescr/stryker-bun-runner` runs `bun test`, which executes this
 *   repository's `node:test` files unchanged (verified: 29 of 30 bound test
 *   files pass under Bun 1.4.0). It reports coverage **per test**, not per file,
 *   so each mutant runs only the individual tests that reach it.
 *
 * `tap`
 *   `@stryker-mutator/tap-runner` drives `node --test --test-reporter=tap` and
 *   reports coverage **per test file**. Slower, but it is the only option for a
 *   module whose bound tests Bun cannot run.
 *
 * Measured, same mutants, same kill counts unless noted:
 *
 *   module            TAP            Bun          agreement
 *   cache.ts          27s            4s           identical (172/48/9)
 *   reliability-v2    5m30s/227      10s/227      226 of 227 mutants
 *   routing.ts        5m31s          1m16s        680 killed either way
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
 * `incremental` must never be enabled as a speed lever. With
 * `coverageAnalysis: "off"` there is no per-test coverage, and Stryker's
 * `IncrementalDiffer` then reuses every stored result unconditionally
 * (`if (!testCoverage.hasCoverage) return true`). Measured: after editing a
 * bound test file, 228 of 229 results were reused and the old score was
 * republished. A stale measurement is worse than a slow one.
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

/**
 * How many `RuntimeError` mutants make a run unusable.
 *
 * Stryker **excludes** `RuntimeError` and `CompileError` from the score
 * denominator. That is defensible for a mutant that genuinely fails to compile,
 * and dangerous for a runner integration problem: measured here, a bound test
 * calling `process.chdir()` made the TAP runner lose its handshake file and
 * report 320 of 388 mutants as `RuntimeError`. The tool then happily printed a
 * score computed over the surviving 68 — a smaller population than the one it
 * claimed to measure, with nothing in the output saying so.
 *
 * A zero tolerance would fail on the occasional genuine equivalence-style crash,
 * so this allows a small share and treats anything above it as a broken run. The
 * `chdir` cause is fixed by `preload-restore-cwd.mjs`; this gate is what catches
 * the next one.
 */
export const RUNTIME_ERROR_TOLERANCE = {
  share: 0.02,
  minimum: 5,
};

/** The number of errored mutants above which a run is treated as broken. */
export function runtimeErrorTolerance(totalMutants) {
  return Math.max(RUNTIME_ERROR_TOLERANCE.minimum, Math.ceil(totalMutants * RUNTIME_ERROR_TOLERANCE.share));
}

/** The pass/fail rules for a completed run, evaluated by ./workflow.mjs. */
export function unusableReasons(data) {
  const reasons = [];
  if (!Array.isArray(data?.modules) || data.modules.length === 0) {
    reasons.push("no module reports were produced");
  }
  if (Array.isArray(data?.missingTargets) && data.missingTargets.length > 0) {
    reasons.push(`missing module reports: ${data.missingTargets.join(", ")}`);
  }
  const timeouts = data?.aggregate?.Timeout ?? 0;
  // A dispatch may override the calibrated tolerance; blank keeps the default.
  const tolerance = data?.timeoutToleranceOverride ?? timeoutTolerance(data?.aggregate?.total ?? 0);
  if (timeouts > tolerance) {
    reasons.push(
      `${timeouts} timed-out mutants exceed the tolerance of ${tolerance}; the per-mutant budget is too small for the bound suite, so the Stryker score is not trustworthy`,
    );
  }
  const conflicts = data?.aggregate?.shardConflicts ?? 0;
  if (conflicts > 0) {
    reasons.push(
      `${conflicts} mutant(s) got different results in overlapping shards; the sharded run is not reproducible, so rerun that module without sharding`,
    );
  }
  // Stryker drops errored mutants from the score denominator, so a run with many
  // of them reports a confident-looking score over a population it never
  // measured. That is the one failure mode most likely to be believed.
  const errors = (data?.aggregate?.RuntimeError ?? 0) + (data?.aggregate?.CompileError ?? 0);
  const errorTolerance = runtimeErrorTolerance(data?.aggregate?.total ?? 0);
  if (errors > errorTolerance) {
    reasons.push(
      `${errors} mutant(s) errored and are excluded from the score, above the tolerance of ${errorTolerance}; the reported score is computed over a smaller population than the run claims, so it is not usable`,
    );
  }
  return reasons;
}
