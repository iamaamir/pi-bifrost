// Mutation measurement workflow and tooling regression tests.
//
// The measurement runs on a schedule, never on pull requests, and never gates a
// merge. These tests lock the invariants that make its output trustworthy:
//   - the schedule is the only automatic trigger;
//   - one matrix leg per module, so a module gets its own timeout budget;
//   - binding is derived from real test imports rather than hand-written;
//   - a timeout inflates the Stryker score, so both scores are reported;
//   - a missing matrix leg is a failure, not a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRunArguments, isInsideReports, isReportFor, parseArgs, reportingRoot, reportsToClear, resolveReportPath, staleReportsFor, strykerArgs } from "../mutation/run.mjs";
import { ROOT, bindingExclusions, bindingFor, directConsumers, exceedsBudget, identityDigest, identityInputs, legEstimateMinutes, lineCount, measurementIdentity, runnerFor, shardsFor, suggestedShards, targetConfig, targetInventory, targetNames } from "../mutation/targets.mjs";
import {
  BUN_RUNNER_PLUGIN,
  MATRIX,
  MUTANT_ESTIMATE,
  RUNNER_OVERRIDES,
  RUNTIME_ERROR_TOLERANCE,
  SANDBOX_IGNORES,
  SHARDING,
  STRYKER_OPTIONS,
  SUMMARY,
  TAP_NODE_ARGS,
  TEST_RUNNER,
  TIME_BUDGET,
  TARGETS,
  TIMEOUT_TOLERANCE,
  measurementDiagnostics,
  estimatedMinutes,
  legMinutes,
  runtimeErrorTolerance,
  timeoutTolerance,
  unusableReasons,
} from "../mutation/config.mjs";
import {
  planMatrix,
  projectWallClock,
  resolveConcurrency,
  resolveShardCount,
  resolveTargets,
  resolveTimeoutTolerance,
  summaryLines,
} from "../mutation/workflow.mjs";
import { annotationLines, buildPayload, mergeShardReports, readReports, renderSummary, selectMeasurement, summarise, survivorRows } from "../mutation/report.mjs";

const workflow = readFileSync(new URL("../.github/workflows/mutation.yml", import.meta.url), "utf8");
const verificationWorkflow = readFileSync(new URL("../.github/workflows/verification.yml", import.meta.url), "utf8");

function jobBlocks(source) {
  const lines = source.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, "workflow must declare jobs");
  const blocks = {};
  let current;
  let buffer = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^ {2}([a-z][a-z0-9-]*):$/u);
    if (match) {
      if (current) blocks[current] = buffer.join("\n");
      current = match[1];
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) blocks[current] = buffer.join("\n");
  return blocks;
}

const jobs = jobBlocks(workflow);

test("the schedule is the only automatic trigger and pull requests never run it", () => {
  assert.deepEqual(Object.keys(jobs), ["plan", "targets", "summarise"]);
  assert.match(workflow, /^on:\n {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "\d+ \d+ \* \* \*"$/mu);
  assert.doesNotMatch(workflow, /^ {2}pull_request:/mu, "mutation must not run on pull requests");
  assert.doesNotMatch(workflow, /^ {2}push:/mu, "mutation must not run on push");
  assert.doesNotMatch(workflow, /secrets\./u, "the measurement must not need repository secrets");
});

test("the cron avoids the top-of-hour load window and fires once daily", () => {
  const crons = [...workflow.matchAll(/^ {4}- cron: "(.+)"$/gmu)].map((match) => match[1]);
  assert.equal(crons.length, 1, "exactly one daily entry");
  assert.match(crons[0], /^\d+ \d+ \* \* \*$/u, "a single daily cron");
  const minute = Number(crons[0].split(" ")[0]);
  assert.notEqual(minute, 0, "avoid the documented top-of-hour load window");
});

test("every target is a matrix leg, and each leg gets its own timeout budget", () => {
  const block = jobs.targets;
  assert.ok(block, "targets job must exist");
  assert.match(block, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/u);
  assert.match(block, /max-parallel: 8/u, "modules and shards run in parallel");
  assert.match(block, /fail-fast: false/u, "one failed module must not hide the others");
  assert.match(block, /timeout-minutes: \$\{\{ fromJSON\(needs\.plan\.outputs\.leg_timeout\) \}\}/u, "each leg is bounded from the plan");

  // Each leg measures exactly one shard through the runner, which owns target
  // selection and the per-shard report name. Matrix values reach the shell
  // through the environment, never by interpolation: interpolating them into a
  // `run:` block is the code-injection pattern zizmor rejects, and it makes a
  // value indistinguishable from script text.
  assert.match(block, /^ {10}TARGET: \$\{\{ matrix\.target \}\}$/mu);
  assert.match(block, /^ {10}MUTATE: \$\{\{ matrix\.mutate \}\}$/mu, "the leg must narrow the scope to its shard");
  assert.match(block, /^ {10}SHARD: \$\{\{ matrix\.shard \}\}$/mu);
  assert.match(block, /^ {10}CONCURRENCY: \$\{\{ needs\.plan\.outputs\.concurrency \}\}$/mu);
  assert.match(block, /node mutation\/run\.mjs "\$TARGET"/u);
  assert.match(block, /--mutate "\$MUTATE"/u);
  // The full path, not a bare name: it must land where the artifact step reads.
  assert.match(block, /--report "reports\/mutation\/\$TARGET\.shard\$SHARD\.json"/u);
  assert.match(block, /--concurrency "\$CONCURRENCY"/u);
  // And no `${{
  assert.doesNotMatch(
    block.split("\n").filter((line) => line.includes("run:") || line.trim().startsWith("node ") || line.trim().startsWith("--")).join("\n"),
    /\$\{\{/u,
    "a run: line must not interpolate workflow expressions",
  );

  const inventory = targetInventory();
  assert.deepEqual(inventory.map((entry) => entry.target), targetNames());
  for (const entry of inventory) {
    assert.ok(entry.timeoutFactor > 0, `${entry.target} needs a timeout factor`);
    assert.ok(entry.timeoutMS > 0, `${entry.target} needs a timeout budget`);
    assert.ok(entry.binding.length > 0, `${entry.target} needs a non-empty binding`);
    assert.ok(entry.shards >= 1, `${entry.target} needs at least one shard`);
  }
});

test("the plan job builds a shard matrix and validates every dispatch input", () => {
  const block = jobs.plan;
  assert.match(block, /outputs:\n {6}matrix: \$\{\{ steps\.resolve\.outputs\.matrix \}\}/u);
  assert.match(block, /concurrency: \$\{\{ steps\.resolve\.outputs\.concurrency \}\}/u);
  assert.match(block, /timeout_tolerance: \$\{\{ steps\.resolve\.outputs\.timeout_tolerance \}\}/u);
  // Every input reaches the script through the environment.
  for (const name of ["REQUESTED", "SHARDS", "CONCURRENCY", "TIMEOUT_TOLERANCE"]) {
    assert.match(block, new RegExp(`^ {10}${name}: \\$\\{\\{ inputs\\.`, "mu"), `${name} must come from a dispatch input`);
  }
  assert.match(block, /run: node mutation\/workflow\.mjs plan/u);

  assert.equal(resolveTargets("").length, targetNames().length, "an empty selection means all");
  assert.equal(resolveTargets(undefined).length, targetNames().length, "an absent selection means all");
  assert.deepEqual(resolveTargets("cache.ts"), ["cache.ts"]);
  assert.throws(() => resolveTargets("nope.ts"), /unknown mutation target/u);
});

test("the dispatch target is validated against TARGETS instead of duplicated", () => {
  // A `type: choice` list is a second copy of TARGETS that nothing keeps in
  // sync, which is how a new target became undispatched-able. The input is free
  // text and the plan job rejects anything it cannot resolve, naming the valid
  // targets.
  const section = workflow.slice(workflow.indexOf("workflow_dispatch:"), workflow.indexOf("permissions:"));
  const block = section.slice(section.indexOf("target:"), section.indexOf("shards:"));
  assert.doesNotMatch(block, /type: choice/u, "no static list to drift");
  assert.doesNotMatch(block, /^ {10}- /mu);
  assert.match(block, /type: string/u);
  assert.throws(() => resolveTargets("not-a-target.ts"), /unknown mutation target\(s\): not-a-target\.ts; known: cache\.ts/u);
});

test("dispatch inputs are bounded, so a typo cannot start an unreasonable run", () => {
  assert.equal(resolveConcurrency(""), 4, "blank uses the default");
  assert.equal(resolveConcurrency("8"), 8);
  assert.throws(() => resolveConcurrency("0"), /concurrency must be an integer 1-16/u);
  assert.throws(() => resolveConcurrency("900"), /concurrency must be an integer 1-16/u);
  assert.throws(() => resolveConcurrency("lots"), /concurrency must be an integer 1-16/u);

  assert.equal(resolveShardCount("1", "cache.ts"), 1);
  assert.equal(resolveShardCount("0", "cache.ts"), suggestedShards("cache.ts"), "0 means auto");
  assert.throws(() => resolveShardCount("99", "cache.ts"), /shards must be an integer/u);

  assert.equal(resolveTimeoutTolerance(""), null, "blank keeps the calibrated default");
  assert.equal(resolveTimeoutTolerance("25"), 25);
  assert.throws(() => resolveTimeoutTolerance("-1"), /non-negative integer/u);
});

test("the workflow exposes every knob as a manual dispatch input", () => {
  const dispatch = workflow.split("workflow_dispatch:")[1].split("permissions:")[0];
  for (const input of ["target", "shards", "concurrency", "timeout_tolerance", "fail_on_unusable"]) {
    assert.match(dispatch, new RegExp(`^ {6}${input}:$`, "mu"), `${input} must be a dispatch input`);
  }
  // Defaults reproduce the nightly run exactly.
  assert.match(dispatch, /^ {6}shards:\n(?:.*\n)*?^ {8}default: "0"$/mu);
  assert.match(dispatch, /^ {6}concurrency:\n(?:.*\n)*?^ {8}default: "4"$/mu);
  assert.match(dispatch, /^ {6}timeout_tolerance:\n(?:.*\n)*?^ {8}default: ""$/mu);
  assert.match(dispatch, /^ {6}fail_on_unusable:\n(?:.*\n)*?^ {8}default: true$/mu);
  // Artifact upload is transport, not a retention knob: the summariser downloads
  // the per-leg reports, so a switch that skips the upload loses the measurement.
  assert.doesNotMatch(dispatch, /^ {6}upload_reports:$/mu, "no knob may disable report transport");
});

test("adjacent shards overlap so no mutant straddles a boundary", () => {
  // Measured failure: adjacent non-overlapping ranges recovered 176 of 229
  // cache.ts mutants. Overlap is what makes the merge exact.
  for (const target of targetNames()) {
    const shards = shardsFor(target, 3);
    assert.equal(shards.length, 3);
    for (let index = 1; index < shards.length; index += 1) {
      const previous = shards[index - 1];
      const current = shards[index];
      assert.ok(
        current.startLine <= previous.endLine,
        `${target} shard ${index} must overlap shard ${index - 1} (got ${current.startLine} > ${previous.endLine})`,
      );
    }
    assert.equal(shards[0].startLine, 1, "the first shard starts at line 1");
    assert.equal(shards.at(-1).endLine, lineCount(target), "the last shard reaches the end of the file");
    for (const shard of shards) {
      assert.match(shard.mutate, new RegExp(`^${target.replace(".", "\\.")}:\\d+-\\d+$`, "u"));
    }
  }
});

test("summarise runs even when a module leg fails, and uploads its output", () => {
  const block = jobs.summarise;
  assert.ok(block, "summarise job must exist");
  assert.match(block, /^ {4}needs: \[plan, targets\]$/mu);
  assert.match(
    block,
    /if: \$\{\{ !cancelled\(\) && needs\.plan\.result == 'success' \}\}/u,
    "a failed leg must still summarise, but a failed plan has nothing to summarise",
  );
  assert.match(block, /continue-on-error: true/u, "a missing artifact must be reported, not crash the job");
  assert.match(block, /name: mutation-summary-\$\{\{ github\.sha \}\}/u);
  assert.match(block, /path: mutation-out\//u);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u, "the summary must land on the run page");
});

test("the measurement fails only when it is unusable, never on a low score", () => {
  const block = jobs.summarise;
  assert.match(block, /run: node mutation\/workflow.mjs require-usable mutation-out\/summary\.json/u);

  // A low score is the measurement, not a failure.
  assert.deepEqual(
    unusableReasons({
      modules: [{ module: "cache.ts", total: 10, Killed: 1, Survived: 9 }],
      aggregate: { total: 10, Timeout: 0 },
      missingTargets: [],
    }),
    [],
  );

  // A few timeouts are legitimate: the mutant genuinely does not terminate.
  assert.deepEqual(
    unusableReasons({
      modules: [{ module: "routing.ts", total: 989, Timeout: 7 }],
      aggregate: { total: 989, Timeout: 7 },
      missingTargets: [],
    }),
    [],
    "7 of 989 timeouts (real infinite loops) must not fail the run",
  );

  // A budget collapse produces timeouts an order of magnitude above the tolerance.
  // Both the aggregate and the module are over, so both say so.
  const collapse = unusableReasons({
    modules: [{ module: "reliability.ts", total: 352, Timeout: 208 }],
    aggregate: { total: 352, Timeout: 208 },
    missingTargets: [],
  });
  assert.ok(collapse.some((reason) => /exceed the tolerance/u.test(reason)), "the aggregate reason survives");
  assert.ok(collapse.some((reason) => /reliability\.ts: 208 of 352/u.test(reason)), "a module reason names it");

  // A missing matrix leg is not a pass.
  const missing = unusableReasons({
    modules: [{ module: "cache.ts", total: 10, Killed: 10 }],
    aggregate: { total: 10, Timeout: 0 },
    missingTargets: ["routing.ts"],
  });
  assert.match(missing[0], /missing module reports: routing\.ts/u);
  const empty = unusableReasons({ modules: [], aggregate: { total: 0, Timeout: 0 }, missingTargets: [] });
  assert.match(empty[0], /no module reports/u);
});

test("the timeout tolerance scales with the mutant count", () => {
  assert.equal(timeoutTolerance(0), TIMEOUT_TOLERANCE.minimum);
  assert.equal(timeoutTolerance(100), TIMEOUT_TOLERANCE.minimum, "small runs keep the floor");
  assert.equal(timeoutTolerance(989), Math.ceil(989 * TIMEOUT_TOLERANCE.share));
  // The measured budget collapse (208 of 352) is far above the tolerance.
  assert.ok(208 > timeoutTolerance(352));
  // The measured genuine count (7 of 989) is below it.
  assert.ok(7 <= timeoutTolerance(989));
});

test("binding is derived from real test imports, not hand-written", () => {
  const consumers = directConsumers();
  // Every target must be covered by at least one test file that imports it.
  for (const target of targetNames()) {
    const binding = bindingFor(target);
    assert.ok(binding.length > 0, `${target} must have consumers`);
    for (const file of binding) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const specifier = `/${target.replace(/\.ts$/u, "")}.ts`;
      assert.match(source, /from\s+["'][^"']*["']/u, `${file} must import modules`);
      assert.ok(
        source.includes(specifier) || source.includes(`"../${target}"`) || source.includes(`'../${target}'`),
        `${file} is bound to ${target} but does not import it`,
      );
    }
  }

  // The hand-written issue #62 binding undercounted: reliability.ts and
  // routing.ts have far more direct consumers than the five bound files.
  assert.ok(bindingFor("reliability.ts").length > 5, "reliability.ts must bind more than the old five-file set");
  assert.ok(bindingFor("routing.ts").length > 1, "routing.ts must bind more than routing.test.ts alone");
  assert.ok(consumers.size > 0);
});

test("no-coverage mutants count against both scores", () => {
  // With the TAP runner coverage is measured, so NoCoverage is real: no bound
  // test reaches that line. Excluding it from the denominator (as the old
  // command-runner definition effectively did, since NoCoverage was always 0)
  // would report a flattering score for unreached code.
  const summary = summarise([
    { status: "Killed" }, { status: "Killed" },
    { status: "Survived" }, { status: "Survived" },
    { status: "NoCoverage" }, { status: "NoCoverage" },
  ]);
  // 2 killed of (2 killed + 2 survived + 2 uncovered) = 33.3%. Excluding the
  // uncovered mutants would have reported 50%.
  assert.equal(Number(summary.conclusiveScore.toFixed(2)), 33.33);
  assert.equal(Number(summary.populationScore.toFixed(2)), 33.33);
  assert.equal(summary.NoCoverage, 2);

  const allUncovered = summarise([{ status: "NoCoverage" }]);
  assert.equal(allUncovered.conclusiveScore, 0, "a mutant nothing reaches is not a pass");
  assert.equal(allUncovered.populationScore, 0);
  assert.equal(allUncovered.strykerScore, 0);
});

test("survivors render as inline GitHub annotations, highest-signal first", () => {
  const survivors = [
    { module: "cache.ts", mutantId: "1", mutator: "StringLiteral", replacement: '""', startLine: 10, startColumn: 3 },
    { module: "cache.ts", mutantId: "2", mutator: "ConditionalExpression", replacement: "false", startLine: 40, startColumn: 7 },
    { module: "cache.ts", mutantId: "3", mutator: "EqualityOperator", replacement: "!==", startLine: 20, startColumn: 5 },
  ];
  const lines = annotationLines(survivors);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /^::warning file=cache\.ts,line=\d+,col=\d+,title=Mutation survived::/u);
  // Comparators and conditionals come before string noise.
  assert.match(lines[0], /line=40/u, "a conditional survivor is the most actionable");
  assert.match(lines[2], /line=10/u, "string-literal noise comes last");
  // A multi-line replacement must not break the workflow-command syntax.
  const wrapped = annotationLines([{ ...survivors[1], replacement: "a\nb" }]);
  assert.equal(wrapped[0].split("\n").length, 1, "the annotation must stay on one line");
  // GitHub requires `%` and CR escaped too; a raw `%` truncates the annotation
  // and the replacement/source text is not under our control.
  const escaped = annotationLines([{ ...survivors[1], replacement: "50% a\rb\rc" }])[0];
  assert.ok(!escaped.includes("\r"), "no raw carriage return");
  assert.match(escaped, /50%25 a%0Db%0Dc/u, "percent and CR are escaped in order");
  // The inline list is capped; the full set stays in survivors.jsonl.
  assert.equal(annotationLines(Array.from({ length: 50 }, (_, i) => ({ ...survivors[1], startLine: i + 1 }))).length, 20);
});

test("the workflow surfaces survivors inline rather than only as an artifact", () => {
  const block = jobs.summarise;
  assert.match(block, /--annotations mutation-out\/annotations\.txt/u);
  assert.match(block, /cat mutation-out\/annotations\.txt/u, "the annotations must reach stdout to render");
});

test("each target config mutates exactly one module with its own budget", () => {
  for (const target of targetNames()) {
    const config = targetConfig(target, { reportFile: "mutation.json" });
    assert.deepEqual(config.mutate, [target], "one module per run");
    assert.equal(config.timeoutFactor, TARGETS[target].timeoutFactor);
    assert.equal(config.timeoutMS, TARGETS[target].timeoutMS);
    assert.ok(config.jsonReporter.fileName, "the report path must be predictable");
    assert.throws(() => targetConfig("nope.ts"), /unknown mutation target/u);
  }
});

test("Bun is the default runner because it covers per test, not per file", () => {
  // Measured on cache.ts, same mutants and same kills:
  //   TAP 27s (per file) vs Bun 4s (per test). Per-test granularity is why:
  //   Bun runs ~8 individual tests per mutant where TAP runs whole files.
  assert.equal(TEST_RUNNER, "bun");
  const bunTargets = targetNames().filter((target) => runnerFor(target) === "bun");
  assert.ok(bunTargets.length > 0, "at least one target must use the fast default");
  for (const target of bunTargets) {
    const config = targetConfig(target);
    assert.equal(config.testRunner, "bun");
    assert.equal(config.coverageAnalysis, "perTest", "coverage analysis is what selects tests per mutant");
    assert.deepEqual(config.bun.testFiles, bindingFor(target), "the runner takes an explicit binding");
    // Stryker only auto-loads @stryker-mutator/* plugins, so a community runner
    // must be registered explicitly.
    assert.deepEqual(config.appendPlugins, [BUN_RUNNER_PLUGIN]);
    // Incremental is opt-in: an authoritative run measures every mutant.
    assert.equal("incremental" in config, false, "the nightly must not replay a stored score");
  }
});

test("the TAP fallback still works, and every override states why it exists", () => {
  // The fallback has to keep working even where unused, or the mechanism rots.
  for (const target of targetNames()) {
    const tap = targetConfig(target, { runner: "tap" });
    assert.equal(tap.testRunner, "tap");
    assert.equal(tap.coverageAnalysis, "perTest", "TAP also gives perTest, at file granularity");
    assert.deepEqual(tap.tap.testFiles, bindingFor(target));
    assert.ok(tap.tap.nodeArgs.includes("--test-reporter=tap"), "node:test must emit TAP for Stryker");
    assert.equal("appendPlugins" in tap, false, "the TAP runner is an official plugin, loaded by name");
  }

  // Every override must be a real target, name a real runner, and give a reason.
  // An override without a stated reason is how a temporary workaround becomes
  // permanent folklore.
  for (const [target, override] of Object.entries(RUNNER_OVERRIDES)) {
    assert.ok(targetNames().includes(target), `${target} must be a real target`);
    assert.ok(["bun", "tap"].includes(override.runner), `${target} must name a known runner`);
    assert.equal(typeof override.reason, "string", `${target} must state a reason`);
    assert.ok(override.reason.length > 30, `${target}'s reason must actually explain something`);
    assert.equal(runnerFor(target), override.runner);
    // An override must differ from the default, or it is dead config.
    assert.notEqual(override.runner, TEST_RUNNER, `${target} overrides the default to the default`);
  }
});

test("incremental reuse is opt-in, tap-only, and stays out of the authoritative run", () => {
  // The nightly is the measurement, so a default config must measure every
  // mutant. Reuse is a local convenience whose invalidation was only measured on
  // the TAP runner; the Bun runner's behaviour is unverified, so it is refused
  // there instead of publishing a possibly stale score.
  for (const target of targetNames()) {
    assert.equal("incremental" in targetConfig(target), false, `${target} must default to a full run`);
  }
  assert.throws(() => targetConfig("cache.ts", { incremental: true }), /only verified for the tap runner/u);

  const local = targetConfig("routing.ts", { incremental: true });
  assert.equal(local.incremental, true);
  assert.match(local.incrementalFile, /^reports\/mutation\/\.incremental-routing\.json$/u);
});

test("incremental cannot share one state file across shards", () => {
  const options = parseArgs(["routing.ts", "--shards", "2", "--incremental"]);
  assert.throws(
    () => assertRunArguments(options, ["routing.ts"]),
    /--incremental cannot be combined with --shards/u,
  );
});

test("a target without a planning estimate fails instead of silently vanishing", () => {
  // `NaN` cost used to produce zero legs and still exit 0: the module was
  // dropped from the matrix while the plan reported success.
  const saved = MUTANT_ESTIMATE["inline-override.ts"];
  try {
    delete MUTANT_ESTIMATE["inline-override.ts"];
    assert.throws(() => estimatedMinutes("inline-override.ts"), /has no mutant estimate/u);
    assert.throws(() => planMatrix({ requested: "inline-override.ts" }), /has no mutant estimate/u);
  } finally {
    MUTANT_ESTIMATE["inline-override.ts"] = saved;
  }
});

test("every selected module gets at least one matrix leg", () => {
  const plan = planMatrix({ requested: "all", shards: "0" });
  for (const target of plan.targets) {
    assert.ok(plan.include.some((leg) => leg.target === target), `${target} must be dispatched`);
  }
});

test("an unknown runner is rejected rather than silently defaulting", () => {
  assert.throws(() => targetConfig("cache.ts", { runner: "nope" }), /unknown mutation runner/u);
});

test("the sandbox keeps directories the bound tests read and drops the ones they do not", () => {
  // Excluding docs breaks the dry run: bifrost-commands.test.ts reads
  // docs/guide/commands.md.
  assert.equal(SANDBOX_IGNORES.includes("docs"), false, "docs must stay in the sandbox");
  // Excluding .pi fixes local runs: a developer's .pi/skills symlink makes
  // Stryker's copyFile fail with ENOTSUP. Tests create their own .pi under a
  // temp cwd.
  assert.equal(SANDBOX_IGNORES.includes(".pi"), true, "a developer's .pi must not be copied");
  assert.equal(SANDBOX_IGNORES.includes(".worktrees"), true, "worktrees are not needed");
});

test("type-check injection stays off so committed-file hashes and line numbers survive", () => {
  // Stryker's default inserts `// @ts-nocheck` into every sandbox .ts file. That
  // changes the bytes of files bound tests read and hash (the affinity
  // acceptance test asserts a committed index.ts baseline), failing the dry run
  // before any mutant runs. It also shifts line numbers by one, which would
  // misattribute every survivor.
  for (const target of targetNames()) {
    assert.equal(targetConfig(target).disableTypeChecks, false, `${target} must not inject @ts-nocheck`);
  }
});

test("a test that asserts on the target's own source text is excluded, not bound", () => {
  // Stryker rewrites the mutated file to insert each mutant, so a test that
  // reads and asserts on that file's source fails the dry run for every mutant.
  // Two shapes occur: an inline readFileSync and a resolved URL constant.
  const exclusions = bindingExclusions();
  assert.ok(
    (exclusions["routing.ts"] ?? []).includes("tests/integration/affinity-policy-acceptance.test.mjs"),
    "the self-referential affinity acceptance test must be excluded from routing.ts",
  );
  assert.ok(
    (exclusions["reliability-v2.ts"] ?? []).includes("tests/reliability-v2-state-machine.test.ts"),
    "the fault-anchor test that reads reliability-v2.ts source must be excluded",
  );
  for (const excluded of Object.values(exclusions).flat()) {
    for (const target of targetNames()) {
      assert.equal(bindingFor(target).includes(excluded) && exclusions[target]?.includes(excluded), false,
        `${excluded} must not be both bound and excluded for ${target}`);
    }
  }
  // Every other target keeps a non-empty binding without exclusions.
  for (const target of targetNames()) {
    assert.ok(bindingFor(target).length > 0, `${target} must still have a binding`);
  }
  // A normal importing test is bound: exclusion must not swallow ordinary bindings.
  assert.ok(bindingFor("cache.ts").includes("tests/cache.test.ts"), "a plain importing test must stay bound");
});

test("survivor counts and all three scores are derived from explicit denominators", () => {
  const mutants = [
    { status: "Killed" }, { status: "Killed" },
    { status: "Survived" }, { status: "Survived" },
    { status: "Timeout" },
  ];
  const summary = summarise(mutants);
  assert.equal(summary.Killed, 2);
  assert.equal(summary.Survived, 2);
  assert.equal(summary.Timeout, 1);
  // Stryker counts the timeout as detected: (2+1)/(2+1+2).
  assert.equal(Number(summary.strykerScore.toFixed(2)), 60);
  // Conclusive excludes the timeout from both sides: 2/(2+2).
  assert.equal(summary.conclusiveScore, 50);
  // Population keeps the timeout as an unresolved non-kill: 2/(2+2+1).
  assert.equal(Number(summary.populationScore.toFixed(2)), 40);
  // Three different numbers from one run is the point: each answers a different
  // question and only one of them is conservative.
  assert.equal(new Set([summary.strykerScore, summary.conclusiveScore, summary.populationScore]).size, 3);
  assert.equal(summary.unresolved, 1);
});

test("a report directory becomes a per-module summary with a survivor extract", () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-report-test-"));
  try {
    const report = {
      schemaVersion: "1.0",
      framework: { name: "StrykerJS", version: "10.0.0" },
      thresholds: { high: 0, low: 0, break: null },
      files: {
        "/repo/cache.ts": {
          mutants: [
            { id: "1", mutatorName: "ConditionalExpression", replacement: "false", status: "Survived", location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } },
            { id: "2", mutatorName: "EqualityOperator", replacement: "!==", status: "Killed", location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } } },
          ],
        },
      },
    };
    writeFileSync(join(directory, "cache.json"), JSON.stringify(report));
    // A non-Stryker json file must be ignored rather than counted.
    writeFileSync(join(directory, "summary.json"), JSON.stringify({ generatedAt: "x", modules: [] }));

    stamp(directory, "cache.json");
    const { reports } = readReports(directory);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].module, "cache.ts");
    assert.equal(reports[0].summary.total, 2);

    const rows = survivorRows(reports);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "coveredBy", "endColumn", "endLine", "module", "mutantId", "mutator", "replacement",
      "source", "startColumn", "startLine", "static", "testsCompleted",
    ].sort());

    const markdown = summary({ reports, expectedTargets: ["cache.ts"] });
    // Module | Mutants | Killed | Survived | NoCoverage | Timeout | Errors | Population | Conclusive | Stryker
    assert.match(markdown, /\| `cache\.ts` \| 2 \| 1 \| 1 \| 0 \| 0 \| 0 \|/u);
    // The headline columns are the two explicit denominators plus Stryker's.
    assert.match(markdown, /\| Population \| Conclusive \| Stryker \|/u);
    assert.doesNotMatch(markdown, /Honest score/u, "the ambiguous label is gone");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing module report is flagged rather than rendering as a pass", () => {
  const markdown = summary({ reports: [], expectedTargets: ["cache.ts", "routing.ts"] });
  assert.match(markdown, /missing module reports: cache\.ts, routing\.ts/u, "the summary names both missing modules");
});

test("summary lines name the score and the timeout count", () => {
  const lines = summaryLines({
    modules: [
      { module: "cache.ts", total: 4, Killed: 3, Survived: 1, Timeout: 0, RuntimeError: 0, CompileError: 0, populationScore: 75, conclusiveScore: 75 },
    ],
    aggregate: { total: 4, populationScore: 75, conclusiveScore: 75, strykerScore: 75, Timeout: 0 },
    missingTargets: [],
  });
  assert.match(lines.join("\n"), /population=75\.00/u);
  assert.match(lines.join("\n"), /conclusive=75\.00/u);
  assert.match(lines.join("\n"), /`cache\.ts`: 75\.00 population \/ 75\.00 conclusive/u);
});

test("verification keeps no mutation job, so the two cannot drift apart", () => {
  assert.doesNotMatch(verificationWorkflow, /stryker/u, "verification must not run Stryker");
  assert.doesNotMatch(verificationWorkflow, /mutation-experiment/u, "the old job must be gone");
  assert.match(verificationWorkflow, /^ {2}schedule:$/mu, "verification keeps its own nightly campaign");
});

test("the tooling resolves the repository root and finds the test directory", () => {
  // Check the checkout's contents, not its directory name: a clone at
  // `/home/user/repo` is a valid checkout, and asserting on the name would fail
  // the suite there for no reason.
  for (const entry of ["package.json", "mutation/config.mjs", "tests"]) {
    assert.ok(existsSync(join(ROOT, entry)), `ROOT must contain ${entry}`);
  }
  assert.ok(directConsumers().get("cache.ts").includes("tests/cache.test.ts"));
});

test("a module with no consumers fails loudly instead of measuring nothing", () => {
  assert.throws(() => targetConfig("typesafe-classifier.ts"), /unknown mutation target/u);
});

test("all tunable Stryker parameters live in one config file", () => {
  // The point of mutation/config.mjs is that a maintainer has one file to edit.
  // The Stryker entry point must be a shim that delegates, not a second place
  // holding options that could drift from it.
  const shim = readFileSync(join(ROOT, "stryker.config.mjs"), "utf8");
  assert.match(shim, /from "\.\/mutation\/targets\.mjs"/u, "the root config must delegate to mutation/");
  for (const option of ["timeoutFactor", "timeoutMS", "coverageAnalysis", "checkers", "thresholds", "disableTypeChecks"]) {
    assert.doesNotMatch(shim, new RegExp(`\\b${option}\\s*:`, "u"), `${option} must live in mutation/config.mjs, not the shim`);
  }
  assert.match(shim, /MUTATION_TARGET/u, "the shim only selects the target");
  assert.doesNotMatch(shim, /mutate:\s*\[/u, "the shim must not restate the target list");

  // The single config exports every knob a maintainer would want.
  assert.ok(TARGETS["cache.ts"], "targets are declared in config");
  assert.ok(["bun", "tap"].includes(TEST_RUNNER), "the runner choice lives in config");
  assert.ok(Array.isArray(TAP_NODE_ARGS) && TAP_NODE_ARGS.length > 0, "the TAP node args live in config");
  assert.ok(typeof BUN_RUNNER_PLUGIN === "string" && BUN_RUNNER_PLUGIN.length > 0, "the Bun plugin id lives in config");
  assert.equal(typeof RUNNER_OVERRIDES, "object", "the runner overrides live in config");
  assert.equal(STRYKER_OPTIONS.thresholds.break, null, "the measurement must never fail a run on a low score");
  assert.ok(Array.isArray(SANDBOX_IGNORES));
  assert.ok(SUMMARY.survivorsPerModule > 0);
  assert.ok(TIMEOUT_TOLERANCE.share > 0 && TIMEOUT_TOLERANCE.minimum > 0);
});

test("the local runner lists every target and its binding", () => {
  const runner = readFileSync(join(ROOT, "mutation", "run.mjs"), "utf8");
  assert.match(runner, /--list/u, "the runner must expose an inventory without running");
  assert.match(runner, /MUTATION_TARGET: run\.target/u, "the runner selects one target per Stryker invocation");
  assert.match(runner, /MUTATION_REPORT_FILE/u, "the runner writes one report per run");
  assert.match(runner, /MUTATION_MUTATE/u, "the runner forwards the shard's mutated scope");
  // Sharding and an explicit scope are mutually exclusive, and sharding applies
  // to a single target because a shard is a slice of one module.
  assert.match(runner, /--mutate and --shards are mutually exclusive/u);
  assert.match(runner, /--shards applies to exactly one target/u);
  for (const target of targetNames()) {
    assert.ok(TARGETS[target], `${target} must have a budget in config`);
  }
});

test("an overlapping shard merge reproduces the unsharded mutant set", () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-shard-merge-"));
  try {
    const mutant = (id, line, status) => ({
      id,
      mutatorName: "EqualityOperator",
      replacement: "!==",
      status,
      location: { start: { line, column: 1 }, end: { line, column: 9 } },
    });
    const report = (mutants) => ({ files: { "/repo/cache.ts": { mutants } } });
    // Two shards that overlap on line 50: shard B measures it twice and agrees.
    writeFileSync(join(directory, "cache.ts.shard0.json"), JSON.stringify(report([
      mutant("1", 10, "Killed"),
      mutant("2", 50, "Survived"),
    ])));
    writeFileSync(join(directory, "cache.ts.shard1.json"), JSON.stringify(report([
      mutant("2", 50, "Survived"),
      mutant("3", 90, "Killed"),
    ])));

    stamp(directory, "cache.ts.shard0.json", 2);
    stamp(directory, "cache.ts.shard1.json", 2);
    const { reports } = readReports(directory);
    assert.equal(reports.length, 1, "two shards of one module become one report");
    assert.equal(reports[0].module, "cache.ts");
    assert.equal(reports[0].mutants.length, 3, "the overlap must be deduplicated, not double-counted");
    assert.equal(reports[0].conflicts.length, 0, "agreeing duplicates are not a conflict");
    assert.equal(reports[0].summary.Killed, 2);
    assert.equal(reports[0].summary.Survived, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mutants that differ only by source span are never deduplicated", () => {
  // Three ConditionalExpression -> "true" mutants share a start position and
  // differ only by where they end. An identity key that used the start position
  // alone would collapse them to one, silently shrinking the population.
  const base = { mutatorName: "ConditionalExpression", replacement: "true", status: "Survived" };
  const span = (endColumn) => ({ ...base, location: { start: { line: 217, column: 10 }, end: { line: 217, column: endColumn } } });
  const merged = mergeShardReports([
    { module: "reliability-v2.ts", shard: 0, mutants: [span(35), span(58)] },
    { module: "reliability-v2.ts", shard: 1, mutants: [span(58), { ...base, location: { start: { line: 217, column: 39 }, end: { line: 217, column: 58 } } }] },
  ]);
  assert.equal(merged[0].mutants.length, 3, "distinct spans stay distinct, and the overlap is merged once");
  assert.equal(merged[0].conflicts.length, 0);
});

test("a shard disagreement is surfaced, not silently resolved", () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-shard-conflict-"));
  try {
    const mutant = (status) => ({
      id: "1",
      mutatorName: "EqualityOperator",
      replacement: "!==",
      status,
      location: { start: { line: 10, column: 1 }, end: { line: 10, column: 9 } },
    });
    const report = (status) => ({ files: { "/repo/cache.ts": { mutants: [mutant(status)] } } });
    writeFileSync(join(directory, "cache.ts.shard0.json"), JSON.stringify(report("Killed")));
    writeFileSync(join(directory, "cache.ts.shard1.json"), JSON.stringify(report("Survived")));

    stamp(directory, "cache.ts.shard0.json", 2);
    stamp(directory, "cache.ts.shard1.json", 2);
    const { reports } = readReports(directory);
    assert.equal(reports[0].mutants.length, 1);
    assert.equal(reports[0].conflicts.length, 1, "the disagreement must be recorded");
    assert.deepEqual(reports[0].conflicts[0].statuses, ["Killed", "Survived"]);

    // A conflict makes the run unusable: the score is not reproducible.
    const markdown = summary({ reports, expectedTargets: ["cache.ts"] });
    assert.match(markdown, /shard conflict/u);
    const reasons = unusableReasons({
      modules: [{ module: "cache.ts" }],
      aggregate: { total: 1, Timeout: 0, shardConflicts: 1 },
      missingTargets: [],
    });
    assert.match(reasons.join(" "), /not reproducible/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the root Stryker shim forwards the shard scope", () => {
  const shim = readFileSync(join(ROOT, "stryker.config.mjs"), "utf8");
  assert.match(shim, /MUTATION_MUTATE/u, "a shard narrows the scope through this variable");
  assert.match(shim, /mutate: process\.env\.MUTATION_MUTATE/u);
});

test("the plan projects inside the time budget and refuses when it cannot", () => {
  const plan = planMatrix({});
  // Every module must appear exactly once per shard. A module silently dropped
  // from the matrix is an unmeasured module reporting nothing, not a pass.
  assert.deepEqual([...new Set(plan.include.map((leg) => leg.target))].sort(), [...targetNames()].sort());
  for (const target of targetNames()) {
    assert.equal(plan.include.filter((leg) => leg.target === target).length, suggestedShards(target));
  }
  // Legs run in parallel, so wall clock is the slowest leg plus fixed overhead.
  assert.ok(
    plan.projectedMinutes <= TIME_BUDGET.minutes,
    `plan projects ${plan.projectedMinutes.toFixed(1)}m, over the ${TIME_BUDGET.minutes}m cap`,
  );
  // Headroom, not a knife-edge: a plan that exactly fills the cap has no room
  // for a slow runner or a cold npm cache.
  assert.ok(
    plan.projectedMinutes < TIME_BUDGET.minutes * 0.8,
    `plan should keep real headroom, got ${plan.projectedMinutes.toFixed(1)}m of ${TIME_BUDGET.minutes}m`,
  );

  for (const target of targetNames()) {
    assert.ok(
      legEstimateMinutes(target) <= legMinutes(),
      `${target} leg ${legEstimateMinutes(target).toFixed(1)}m exceeds the ${legMinutes()}m per-leg bound`,
    );
    assert.equal(exceedsBudget(target), false, `${target} must fit the budget at maxShards`);
  }

  // A cap that cannot be met must fail loudly rather than overrun or silently
  // measure fewer mutants.
  const original = TIME_BUDGET.minutes;
  try {
    TIME_BUDGET.minutes = 5;
    assert.throws(() => planMatrix({}), /time budget of 5m cannot be met|over the 5m budget/u);
  } finally {
    TIME_BUDGET.minutes = original;
  }
});

test("shard counts are derived from the budget, not a fixed threshold", () => {
  for (const target of targetNames()) {
    const cost = estimatedMinutes(target);
    const shards = suggestedShards(target);
    if (cost > TIME_BUDGET.targetLegMinutes) {
      assert.ok(shards > 1, `${target} costs ${cost.toFixed(1)}m, so it must be sharded`);
    } else {
      assert.equal(shards, 1, `${target} fits one leg, so it must not pay sharding overhead`);
    }
    assert.ok(shards <= SHARDING.maxShards);
  }
});

test("a run dominated by errors is unusable, because Stryker hides them from the score", () => {
  // Stryker excludes RuntimeError/CompileError from the denominator, so a runner
  // integration failure yields a confident score over a smaller population.
  // Measured at 320 of 388 mutants before the chdir fix.
  const healthy = unusableReasons({
    modules: [{ module: "cache.ts", total: 1000, Killed: 1000 }],
    aggregate: { total: 1000, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.deepEqual(healthy, [], "a clean run is usable");

  const broken = unusableReasons({
    modules: [{ module: "cache.ts", total: 388, RuntimeError: 320 }],
    aggregate: { total: 388, Timeout: 0, RuntimeError: 320, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.ok(broken.some((reason) => /errored and are excluded from the score/u.test(reason)));
  assert.ok(broken.some((reason) => /smaller population/u.test(reason)));
  assert.ok(broken.some((reason) => /cache\.ts: 320 of 388/u.test(reason)), "the module is named");

  const tolerable = unusableReasons({
    modules: [{ module: "cache.ts", total: 2447, RuntimeError: 3, CompileError: 1 }],
    aggregate: { total: 2447, Timeout: 0, RuntimeError: 3, CompileError: 1, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.deepEqual(tolerable, [], "a handful of errors is tolerated");
  assert.equal(runtimeErrorTolerance(2447), Math.ceil(2447 * RUNTIME_ERROR_TOLERANCE.share));
  assert.equal(runtimeErrorTolerance(10), RUNTIME_ERROR_TOLERANCE.minimum);
});

test("the workflow bounds each leg from the plan instead of one global ceiling", () => {
  const block = jobs.targets;
  assert.match(block, /timeout-minutes: \$\{\{ fromJSON\(needs\.plan\.outputs\.leg_timeout\) \}\}/u);
  assert.doesNotMatch(block, /timeout-minutes: 330/u, "a global ceiling either cuts a slow shard or lets a stuck leg run");
  assert.match(jobs.plan, /leg_timeout: \$\{\{ steps\.resolve\.outputs\.leg_timeout \}\}/u);
});

test("the cwd preload is loaded before the runner hook", () => {
  // The TAP runner writes its handshake relative to the working directory. A
  // bound test that chdir's and throws before restoring sends it elsewhere,
  // which surfaces as RuntimeError. Node runs exit listeners in registration
  // order, so the guard must be required first.
  const guardIndex = TAP_NODE_ARGS.indexOf("{{cwdGuard}}");
  const hookIndex = TAP_NODE_ARGS.indexOf("{{hookFile}}");
  assert.ok(guardIndex !== -1, "the cwd guard must be preloaded");
  assert.ok(hookIndex !== -1, "the runner hook must be present");
  assert.ok(guardIndex < hookIndex, "the guard must register before the runner hook");
  // Only the TAP runner needs it (and only TAP targets have a `tap` block).
  for (const target of targetNames().filter((name) => runnerFor(name) === "tap")) {
    const args = targetConfig(target).tap.nodeArgs;
    const guard = args.find((arg) => arg.endsWith("preload-restore-cwd.mjs"));
    assert.ok(guard, `${target} must preload the cwd guard`);
    assert.ok(guard.startsWith("/"), "the guard needs an absolute path inside the sandbox");
    assert.ok(args.indexOf(guard) < args.indexOf("{{hookFile}}"), "the guard must register first");
  }
});

test("a run that selects one module is not reported as four missing modules", () => {
  // A dispatch may narrow the target set. The reporter must judge completeness
  // against what was planned, or a successful single-module run fails the gate.
  const reports = [{ module: "cache.ts", mutants: [{ status: "Killed" }], summary: summarise([{ status: "Killed" }]) }];
  const narrowed = summary({ reports, expectedTargets: ["cache.ts"] });
  assert.doesNotMatch(narrowed, /missing module reports/u, "a selected module that reported is not missing");

  const everything = summary({ reports, expectedTargets: targetNames() });
  assert.match(everything, /missing module reports/u, "an unselected module is still missing when the whole set is expected");
});

test("a module that is missing a planned shard is not treated as complete", () => {
  // A two-shard module whose second artifact never arrived would otherwise merge
  // silently and score over a subset of the planned mutants.
  const reports = [
    { module: "cache.ts", shardsSeen: [0], mutants: [{ status: "Killed" }], summary: summarise([{ status: "Killed" }]) },
  ];
  const markdown = summary({ reports, expectedTargets: ["cache.ts"], shardsPerTarget: new Map([["cache.ts", 2]]) });
  assert.match(markdown, /missing module shards/u, "the summary must name the missing shard");
  assert.match(markdown, /shard 1/u);

  // The same reports with the planned count satisfied must not raise the flag.
  const complete = summary({
    reports: [{ ...reports[0], shardsSeen: [0, 1] }],
    expectedTargets: ["cache.ts"],
    shardsPerTarget: new Map([["cache.ts", 2]]),
  });
  assert.doesNotMatch(complete, /missing module shards/u);

  const reasons = unusableReasons({
    modules: [{ module: "cache.ts", total: 1, Killed: 1 }],
    aggregate: { total: 1, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
    missingShards: [{ module: "cache.ts", shard: 1 }],
  });
  assert.match(reasons.join(" "), /missing module shards: cache\.ts shard 1/u);
  assert.match(reasons.join(" "), /only part of the planned mutants/u);
});

test("a shard outside the plan is rejected instead of merged", () => {
  // A previous run with three shards leaves a stale shard 2. Missing-shard
  // detection sees nothing absent, so without this the stale population is
  // merged into a plan that only described two shards.
  const reports = [
    { module: "cache.ts", shardsSeen: [0, 1, 2], mutants: [{ status: "Killed" }], summary: summarise([{ status: "Killed" }]) },
  ];
  const markdown = summary({ reports, expectedTargets: ["cache.ts"], shardsPerTarget: new Map([["cache.ts", 2]]) });
  assert.match(markdown, /unexpected module shards/u);
  assert.match(markdown, /shard 2 \(plan has 2\)/u);
  assert.doesNotMatch(markdown, /missing module shards/u, "nothing is missing; something is extra");

  const reasons = unusableReasons({
    modules: [{ module: "cache.ts", total: 1, Killed: 1 }],
    aggregate: { total: 1, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
    missingShards: [],
    unexpectedShards: [{ module: "cache.ts", shard: 2, planned: 2 }],
  });
  assert.match(reasons.join(" "), /unexpected module shards: cache\.ts shard 2 \(plan has 2\)/u);
  assert.match(reasons.join(" "), /stale or misrouted/u);

  // The exact planned set stays usable.
  const exact = summary({ reports, expectedTargets: ["cache.ts"], shardsPerTarget: new Map([["cache.ts", 3]]) });
  assert.doesNotMatch(exact, /unexpected module shards/u);
});

test("a saved tolerance override is honoured when a summary is rechecked", () => {
  // The override must be stored where the gate reads it, or re-checking a saved
  // summary silently falls back to the default tolerance.
  const withOverride = unusableReasons({
    modules: [{ module: "cache.ts", total: 100, Timeout: 20 }],
    aggregate: { total: 100, Timeout: 20, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
    timeoutToleranceOverride: 25,
  });
  assert.deepEqual(withOverride, [], "20 timeouts inside an override of 25 is usable");

  const withoutOverride = unusableReasons({
    modules: [{ module: "cache.ts", total: 100, Timeout: 20 }],
    aggregate: { total: 100, Timeout: 20, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.match(withoutOverride.join(" "), /timed-out mutants exceed the tolerance/u, "the default tolerance rejects it");
});

test("the tolerance override reaches the gate through the written payload", () => {
  // Guards the write location, not just the read. A summary re-checked later has
  // no environment override, so a misplaced field silently changes the verdict.
  const directory = mkdtempSync(join(tmpdir(), "mutation-tolerance-test-"));
  try {
    const report = {
      schemaVersion: "1.0",
      framework: { name: "StrykerJS", version: "10.0.0" },
      thresholds: { high: 0, low: 0, break: null },
      bifrost: { measurement: measurementIdentity("cache.ts"), scope: "cache.ts" },
      files: {
        "/repo/cache.ts": {
          mutants: Array.from({ length: 100 }, (_, index) => ({
            id: String(index),
            mutatorName: "ConditionalExpression",
            replacement: "false",
            // 20 timeouts, which the default tolerance of 10 rejects.
            status: index < 20 ? "Timeout" : "Killed",
            // A distinct location per mutant: identity is (mutator, location,
            // replacement), so sharing one would make them look like a single
            // mutant with contradictory statuses.
            location: { start: { line: index + 1, column: 1 }, end: { line: index + 1, column: 5 } },
          })),
        },
      },
    };
    writeFileSync(join(directory, "cache.json"), JSON.stringify(report));
    const output = join(directory, "summary.json");
    execFileSync(process.execPath, [
      "mutation/report.mjs",
      "--dir", directory,
      "--json", output,
      "--targets", "cache.ts",
      "--timeout-tolerance", "25",
    ]);
    const payload = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(payload.timeoutToleranceOverride, 25, "the override must be at the top level");
    assert.equal(payload.aggregate.timeoutToleranceOverride, undefined, "not nested under aggregate");
    assert.deepEqual(unusableReasons(payload), [], "the recorded override must satisfy the gate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the projection follows the shard count that will actually run", () => {
  // An explicit count smaller than the automatic suggestion makes a leg slower.
  // Projecting from the suggestion would let an over-budget plan through.
  const narrow = planMatrix({ requested: "routing.ts", shards: "1" });
  const wide = planMatrix({ requested: "routing.ts", shards: "2" });
  assert.equal(narrow.include.length, 1);
  assert.equal(wide.include.length, 2);
  assert.ok(
    narrow.projectedMinutes > wide.projectedMinutes,
    `one shard must project slower than two (got ${narrow.projectedMinutes} vs ${wide.projectedMinutes})`,
  );
});

test("downloaded artifacts are isolated so attempts cannot overwrite each other", () => {
  // Flattening two artifacts that both contain `cache.ts.shard0.json` onto one
  // filename leaves the survivor to extraction order. The attempt is part of the
  // artifact name, and keeping the directories keeps that attribution readable.
  assert.match(jobs.summarise, /merge-multiple: false/u);
  assert.doesNotMatch(jobs.summarise, /merge-multiple: true/u);
  assert.match(jobs.summarise, /pattern: mutation-report-\*/u);
  assert.match(jobs.summarise, /path: mutation-reports/u);
});

test("the summary downloads every attempt, so a partial re-run still sees the legs that passed", () => {
  // Scoping the download to the current attempt would hide the legs that were
  // not re-run: "re-run failed jobs" increments the attempt while the successful
  // legs' artifacts stay on the earlier one, so the summary would see only the
  // retried legs and report every other module missing. What rejects a
  // measurement of different bytes is the stamped identity, not the file name.
  const block = jobs.summarise;
  assert.match(block, /pattern: mutation-report-\*/u);
  assert.doesNotMatch(block, /pattern:[^\n]*run_attempt/u);
  // The upload name still distinguishes attempts, so one cannot overwrite another
  // within a single run.
  assert.match(jobs.targets, /name: mutation-report-[^\n]*attempt-\$\{\{ github\.run_attempt \}\}/u);
});

test("transport cannot be disabled, because the summary depends on it", () => {
  // The leg upload is the only way a report reaches the summariser. A retention
  // switch is fine; one that can skip the upload turns a good run into "all
  // modules missing".
  const uploads = [...workflow.matchAll(/name: (Upload this leg's report|Upload the merged summary and survivor extract)[\s\S]*?^ {8}if: (.*)$/gmu)];
  assert.ok(uploads.length >= 2, "both upload steps must exist");
  for (const [, step, condition] of uploads) {
    assert.doesNotMatch(condition, /upload_reports/u, `${step} must not be gated by a transport switch`);
    assert.match(condition, /always\(\)/u, `${step} must upload even when a leg failed`);
  }
});

test("clearing stale reports never touches another module", () => {
  // A previous run's file is merged into the next score, so it must go; the
  // neighbour's file must stay, or its measured population silently shrinks.
  assert.ok(isReportFor("cache.ts.json", "cache.ts"));
  assert.ok(isReportFor("cache.ts.shard0.json", "cache.ts"));
  assert.ok(isReportFor("cache.ts.shard12.json", "cache.ts"));
  assert.ok(!isReportFor("cache-classifier.ts.json", "cache.ts"));
  assert.ok(!isReportFor("cache.ts.bak.json", "cache.ts"));
  assert.ok(!isReportFor("routing.ts.json", "cache.ts"));
  assert.ok(!isReportFor("cache.ts.shardx.json", "cache.ts"));
  // The regex metacharacter in the module name is literal, not a wildcard.
  assert.ok(!isReportFor("cacheXts.json", "cache.ts"));
});

test("an unsharded report satisfies a one-shard plan", () => {
  // `<target>.json` is the whole module, which is shard 0 of 1. Treating it as
  // "no shard seen" made every single-shard target look like it lost its only
  // artifact, so a perfectly good nightly run would fail its own gate.
  const reports = [{ module: "cache.ts", mutants: [{ status: "Killed" }], summary: summarise([{ status: "Killed" }]) }];
  const merged = mergeShardReports(reports);
  assert.deepEqual(merged[0].shardsSeen, [0]);

  const markdown = summary({ reports: merged, expectedTargets: ["cache.ts"], shardsPerTarget: new Map([["cache.ts", 1]]) });
  assert.doesNotMatch(markdown, /missing module shards/u);
});

test("clearing keeps sibling shards but drops this run's own stale output", () => {
  // Two local invocations run one shard each. Deleting the whole target would
  // lose the first shard; deleting nothing would let a failed rerun's previous
  // file be read as a completed shard.
  const run = { target: "cache.ts", reportPath: join(ROOT, "reports", "mutation", "cache.ts.shard1.json") };
  assert.deepEqual(staleReportsFor({}), { scope: "target" }, "a normal run owns the whole set");
  assert.deepEqual(staleReportsFor({ report: null }), { scope: "target" });

  // An explicit path owns that exact file and nothing else. Reducing it to a
  // basename deleted a same-named file in reports/mutation/, which is a
  // different file and may be another shard's output.
  const explicit = { report: "reports/mutation/cache.ts.shard1.json" };
  assert.deepEqual(staleReportsFor(explicit, run), {
    scope: "own",
    path: join(ROOT, "reports", "mutation", "cache.ts.shard1.json"),
  });

  // The decisive case from the review: a nested path must not touch the
  // top-level report of the same name.
  const archived = { report: "reports/archive/cache.ts.shard0.json" };
  const tmp = mkdtempSync(join(tmpdir(), "mutation-own-"));
  try {
    const resolved = resolveReportPath(archived.report);
    assert.ok(resolved.startsWith(ROOT), "--report resolves inside the checkout");
    assert.deepEqual(staleReportsFor(archived, { target: "cache.ts", reportPath: resolved }), {
      scope: "own",
      path: resolved,
    });
    assert.ok(
      !resolved.endsWith(join("reports", "mutation", "cache.ts.shard0.json")),
      "an archive path must never resolve to the top-level report it would have deleted",
    );

    // The planner is what the runner actually deletes from. Only the owned file
    // appears, and a sibling shard is never a candidate.
    const entries = ["cache.ts.shard0.json", "cache.ts.shard1.json", "notes.txt", "routing.ts.json"];
    // `tmp` is the trust anchor here: the fixture directory plays the role that
    // `reports/` plays in production, and the boundary is always the root.
    assert.deepEqual(
      reportsToClear(archived, { target: "cache.ts", reportPath: resolved }, tmp, entries),
      [resolved],
    );
    assert.deepEqual(
      reportsToClear({}, run, tmp, entries, tmp).sort(),
      [join(tmp, "cache.ts.shard0.json"), join(tmp, "cache.ts.shard1.json")].sort(),
      "a normal run owns both of that target's shards and nothing else",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // A path outside the reporting directory is refused rather than allowed to
  // delete: this run unlinks its own previous output before measuring.
  assert.throws(() => resolveReportPath("../../etc/somewhere.json"), /must name a file under reports\//u);
  assert.throws(() => resolveReportPath("package.json"), /must name a file under reports\//u);
});

test("the summary line prints the tolerance the gate used", () => {
  // A saved override of 25 accepted 20 timeouts. Printing the default of 10 would
  // make an accepted run look like it failed its own threshold.
  const line = summaryLines({
    modules: [
      { module: "cache.ts", total: 100, Killed: 80, Survived: 20, Timeout: 20, RuntimeError: 0, CompileError: 0, populationScore: 80, conclusiveScore: 80 },
    ],
    aggregate: { total: 100, Timeout: 20, populationScore: 80, conclusiveScore: 80, strykerScore: 100 },
    timeoutToleranceOverride: 25,
    missingTargets: [],
  })[0];
  assert.match(line, /tolerance=25/u);
  assert.doesNotMatch(line, /tolerance=10/u);
});

// --- The aggregate tolerances must not hide a single broken module ---

const BASELINE_MODULES = [
  { module: "cache.ts", total: 229, Killed: 172, Survived: 48, NoCoverage: 9, Timeout: 0, RuntimeError: 0, CompileError: 0 },
  { module: "classifier-semantics.ts", total: 157, Killed: 85, Survived: 26, NoCoverage: 46, Timeout: 0, RuntimeError: 0, CompileError: 0 },
  { module: "inline-override.ts", total: 21, Killed: 19, Survived: 2, NoCoverage: 0, Timeout: 0, RuntimeError: 0, CompileError: 0 },
  { module: "reliability.ts", total: 352, Killed: 251, Survived: 93, NoCoverage: 8, Timeout: 0, RuntimeError: 0, CompileError: 0 },
  { module: "reliability-v2.ts", total: 2447, Killed: 1432, Survived: 707, NoCoverage: 307, Timeout: 1, RuntimeError: 0, CompileError: 0 },
  { module: "routing.ts", total: 1000, Killed: 681, Survived: 214, NoCoverage: 98, Timeout: 7, RuntimeError: 0, CompileError: 0 },
];

test("a healthy measurement passes every module check", () => {
  // The real baseline, so the module check cannot be tuned to a synthetic case.
  const aggregate = { total: 4206, Timeout: 8, RuntimeError: 0, CompileError: 0, shardConflicts: 0 };
  assert.deepEqual(unusableReasons({ modules: BASELINE_MODULES, aggregate, missingTargets: [] }), []);
});

test("a module-local error burst the aggregate tolerance would hide still fails the gate", () => {
  // 80 errors in a 229-mutant module is 35% of that module. Inside a 4,206-mutant
  // run it sits under the aggregate allowance of 85, so the aggregate check alone
  // accepted it and the merged score looked confident while one module had
  // measured almost nothing.
  const total = 4206;
  assert.ok(80 <= runtimeErrorTolerance(total), "the aggregate tolerance really does accept 80");

  const broken = { ...BASELINE_MODULES[0], Killed: 149, Survived: 0, NoCoverage: 0, RuntimeError: 80 };
  const payload = {
    modules: [broken, ...BASELINE_MODULES.slice(1)],
    aggregate: { total, Killed: total - 80, Timeout: 8, RuntimeError: 80, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  };
  const reasons = unusableReasons(payload);
  assert.equal(reasons.length, 1, "only the module is unhealthy; the aggregate is inside its allowance");
  assert.match(reasons[0], /cache\.ts: 80 of 229/u, "the reason names the module and both counts");
  assert.match(reasons[0], /excluded from its score/u);
});

test("a module-local timeout burst is caught inside a large healthy run", () => {
  const total = 4206;
  assert.ok(60 <= timeoutTolerance(total), "the aggregate tolerance really does accept 60");

  const collapsed = { ...BASELINE_MODULES[3], Killed: 292, Survived: 0, NoCoverage: 0, Timeout: 60 };
  const modules = BASELINE_MODULES.map((module, index) => (index === 3 ? collapsed : module));
  const payload = {
    modules,
    aggregate: { total, Timeout: 67, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  };
  const reasons = unusableReasons(payload);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /reliability\.ts: 60 of 352/u);
  assert.match(reasons[0], /budget is too small/u);
});

test("a module that reports zero mutants is not a perfect score", () => {
  // A report can parse and still carry nothing. Scoring it as 0/0 would either be
  // null or, worse, look like a flawless module.
  const reasons = unusableReasons({
    modules: [{ module: "cache.ts", total: 0 }],
    aggregate: { total: 0, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.match(reasons.join(" "), /cache\.ts: reported zero mutants/u);
});

test("a dispatch timeout override bounds each module as well as the aggregate", () => {
  // Otherwise the override cannot rescue the run that needed it: the aggregate
  // passes against 25 while the module check still fails against the default 10.
  const payload = {
    modules: [{ module: "cache.ts", total: 100, Killed: 80, Survived: 0, Timeout: 20 }],
    aggregate: { total: 100, Timeout: 20, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  };
  assert.ok(unusableReasons(payload).length > 0, "the default tolerance rejects 20 timeouts in 100 mutants");
  assert.deepEqual(unusableReasons({ ...payload, timeoutToleranceOverride: 25 }), []);
});

// --- The score contract: unresolved outcomes are never verified kills ---

test("one kill and nine timeouts never reads as a verified kill", () => {
  const summary = summarise([
    { status: "Killed" },
    ...Array.from({ length: 9 }, () => ({ status: "Timeout" })),
  ]);
  assert.equal(summary.total, 10);
  assert.equal(summary.Killed, 1);
  assert.equal(summary.unresolved, 9);
  assert.equal(summary.strykerScore, 100, "Stryker counts a timeout as detected");
  assert.equal(summary.conclusiveScore, 100, "the conditional rate is real but conditional");
  // The conservative rate over the whole population is the only one of the three
  // that cannot be read as "the tests caught it".
  assert.equal(Number(summary.populationScore.toFixed(2)), 10);
});

test("ignored mutants leave the population denominator instead of counting as kills", () => {
  const summary = summarise([{ status: "Killed" }, { status: "Survived" }, { status: "Ignored" }, { status: "Ignored" }]);
  assert.equal(summary.total, 4, "the raw count is preserved");
  assert.equal(summary.ignored, 2);
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.populationScore, 50, "Stryker never evaluated the ignored ones");
  assert.equal(summary.conclusiveScore, 50);
});

test("an errored mutant lowers the population score rather than disappearing", () => {
  const summary = summarise([{ status: "Killed" }, { status: "RuntimeError" }, { status: "CompileError" }]);
  assert.equal(summary.evaluated, 3);
  assert.equal(Number(summary.populationScore.toFixed(2)), 33.33);
  // Stryker drops both errors from its denominator, so it reports 100% here.
  assert.equal(summary.strykerScore, 100);
});

// --- The time budget is a projection, and it models the matrix it will run ---

test("the projection models matrix waves instead of assuming every leg starts at once", () => {
  const plan = planMatrix({ requested: "all", shards: "4", concurrency: "4" });
  assert.equal(plan.include.length, 24, "six modules sharded four ways");
  assert.ok(plan.include.length > MATRIX.maxParallel, "this plan needs more legs than lanes");
  assert.equal(plan.waves, 3);

  const slowestLeg = Math.max(...plan.include.map((leg) => estimatedMinutes(leg.target) / leg.shardCount));
  assert.ok(
    plan.projectedMinutes > slowestLeg + TIME_BUDGET.reserveMinutes,
    "queued legs cost more than the slowest single leg, which is exactly what max(leg) got wrong",
  );
});

test("the wave model preserves matrix order, because GitHub does not reorder a matrix", () => {
  assert.equal(projectWallClock([]), 0);
  // Eight lanes, eight one-minute legs: one wave.
  assert.equal(projectWallClock([1, 1, 1, 1, 1, 1, 1, 1]), 1);
  // 24 one-minute legs through 8 lanes: three waves.
  assert.equal(projectWallClock(Array.from({ length: 24 }, () => 1)), 3);
  // A long leg listed last starts only after a lane frees, so it costs its own
  // duration plus that wait. Sorting longest-first would report 10.
  assert.equal(projectWallClock([1, 1, 1, 1, 1, 1, 1, 1, 10]), 11);
});

test("the planner's lane count matches the workflow's max-parallel", () => {
  // A drift here silently makes the projection optimistic again.
  assert.match(jobs.targets, new RegExp(`max-parallel: ${MATRIX.maxParallel}\\b`, "u"));
});

test("the workflow names the report path that its collection step reads", () => {
  // `--report` writes exactly where it is pointed. A bare filename would land in
  // the repository root while the artifact step globs reports/mutation/*.json, and
  // every uploaded artifact would be empty — a run that publishes "no modules".
  assert.match(jobs.targets, /--report "reports\/mutation\/\$TARGET\.shard\$SHARD\.json"/u);
  assert.match(jobs.targets, /for report in reports\/mutation\/\*\.json; do/u);
});

test("the gate rejects a module-local failure through the shipped CLI", () => {
  // Unit tests cover the decision; this covers the seam that actually runs in CI,
  // where the summary is read back from disk and the module counts come from the
  // written payload.
  const directory = mkdtempSync(join(tmpdir(), "mutation-gate-"));
  const gate = (payload) => {
    const path = join(directory, "summary.json");
    writeFileSync(path, JSON.stringify(payload));
    try {
      return { status: 0, stderr: "", stdout: execFileSync(process.execPath, ["mutation/workflow.mjs", "require-usable", path], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };
  try {
    // The shipped CLI re-checks identity against the checkout, so these
    // synthetic payloads must carry one or they are refused for the wrong reason.
    const identity = Object.fromEntries(BASELINE_MODULES.map((m) => [m.module, measurementIdentity(m.module)]));
    const broken = { ...BASELINE_MODULES[0], Killed: 149, Survived: 0, NoCoverage: 0, RuntimeError: 80 };
    const rejected = gate({
      measuredIdentity: identity,
      modules: [broken, ...BASELINE_MODULES.slice(1)],
      aggregate: { total: 4206, Killed: 4126, Timeout: 8, RuntimeError: 80, CompileError: 0, shardConflicts: 0 },
      missingTargets: [],
      missingShards: [],
      unexpectedShards: [],
    });
    assert.equal(rejected.status, 1, "the run must fail its own gate");
    assert.match(rejected.stderr, /cache\.ts: 80 of 229/u);

    const accepted = gate({
      measuredIdentity: identity,
      modules: BASELINE_MODULES,
      aggregate: { total: 4206, Killed: 2640, Timeout: 8, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
      missingTargets: [],
      missingShards: [],
      unexpectedShards: [],
    });
    assert.equal(accepted.status, 0);
    assert.match(accepted.stdout, /mutation measurement usable: 6 modules/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the shipped CLI refuses a summary that is stale for this checkout", () => {
  // A summary outlives the run that produced it: it is attached to the run,
  // quoted in review, and re-gated by hand. Re-gating used to pass
  // unconditionally, so a payload from an older tree reported a score for code
  // that no longer exists.
  const directory = mkdtempSync(join(tmpdir(), "mutation-stale-gate-"));
  const gate = (payload) => {
    const path = join(directory, "summary.json");
    writeFileSync(path, JSON.stringify(payload));
    try {
      return { status: 0, stderr: "", stdout: execFileSync(process.execPath, ["mutation/workflow.mjs", "require-usable", path], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };
  try {
    const base = { modules: BASELINE_MODULES, missingTargets: [], missingShards: [], unexpectedShards: [] };
    const current = Object.fromEntries(BASELINE_MODULES.map((m) => [m.module, measurementIdentity(m.module)]));

    assert.equal(gate({ ...base, measuredIdentity: current }).status, 0, "a current payload passes");

    const stale = gate({ ...base, measuredIdentity: { ...current, "cache.ts": "0".repeat(64) } });
    assert.equal(stale.status, 1, "a payload from another tree must not pass");
    assert.match(stale.stderr, /cache\.ts: measured against different bytes/u);

    const unstamped = gate(base);
    assert.equal(unstamped.status, 1, "an unstamped payload is unverifiable, not usable");
    assert.match(unstamped.stderr, /records no measurement identity/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit --report is refused when it cannot name exactly one measurement", () => {
  // The flag used to be silently ignored without --mutate, and ignored entirely
  // when sharding, so an operator could believe a report was captured at a path
  // that was never written. These fail before any Stryker work starts.
  const attempt = (args) => {
    try {
      execFileSync(process.execPath, ["mutation/run.mjs", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
      return { status: 0, stderr: "" };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };

  const manyTargets = attempt(["cache.ts", "routing.ts", "--report", "one.json"]);
  assert.notEqual(manyTargets.status, 0);
  assert.match(manyTargets.stderr, /--report applies to exactly one target/u);

  const sharded = attempt(["cache.ts", "--shards", "2", "--report", "one.json"]);
  assert.notEqual(sharded.status, 0);
  assert.match(sharded.stderr, /--report cannot be combined with --shards/u);
});

// --- A report for a module this run did not plan must not reach the score ---

/** Stamp a fixture report the way the runner does, for the module it describes. */
function stamp(directory, name, shardCount = 1) {
  // The scope must be the range the plan assigns this shard index, so the helper
  // derives it from the same function the reporter validates against.
  const path = join(directory, name);
  const report = JSON.parse(readFileSync(path, "utf8"));
  const module = Object.keys(report.files)[0].split("/").pop();
  const index = Number(/\.shard(\d+)\.json$/u.exec(name)?.[1] ?? 0);
  report.bifrost = { measurement: measurementIdentity(module), scope: shardsFor(module, shardCount)[index].mutate };
  writeFileSync(path, JSON.stringify(report));
}


// The summary is a rendering of the same payload the gate reads, so a test that
// asks "what would the page say?" is asking the same question as the gate.
function summary({ reports, tolerance = null, ...options }) {
  return renderSummary({ reports, payload: buildPayload({ reports, timeoutToleranceOverride: tolerance, ...options }) });
}

const strykerReport = (module, statuses) => ({
  schemaVersion: "1.0",
  framework: { name: "StrykerJS", version: "10.0.0" },
  thresholds: { high: 0, low: 0, break: null },
  bifrost: { measurement: measurementIdentity(module), scope: module },
  files: {
    [`/repo/${module}`]: {
      mutants: statuses.map((status, index) => ({
        id: String(index),
        mutatorName: "ConditionalExpression",
        replacement: "true",
        status,
        location: { start: { line: index + 1, column: 0 }, end: { line: index + 1, column: 1 } },
      })),
    },
  },
});

const invoke = (argv) => {
  try {
    const stdout = execFileSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
};

test("a report outside the selected target set cannot influence the score or pass the gate", () => {
  // A stale `routing.ts.json` left by an earlier wider run used to be merged into
  // `modules` and `aggregate`, so a cache-only dispatch published a score that
  // covered mutants it never measured.
  const directory = mkdtempSync(join(tmpdir(), "mutation-unselected-"));
  try {
    writeFileSync(join(directory, "cache.ts.json"), JSON.stringify(strykerReport("cache.ts", Array(10).fill("Killed"))));
    writeFileSync(join(directory, "routing.ts.json"), JSON.stringify(strykerReport("routing.ts", Array(10).fill("Survived"))));
    const out = join(directory, "summary.json");

    const selected = invoke(["mutation/report.mjs", "--dir", directory, "--targets", "cache.ts", "--json", out, "--out", join(directory, "summary.md")]);
    assert.equal(selected.status, 0, selected.stderr);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(payload.modules.map((module) => module.module), ["cache.ts"], "only the selected module is scored");
    assert.equal(payload.aggregate.total, 10, "the foreign report is not in the population");
    assert.equal(payload.aggregate.Killed, 10);
    assert.deepEqual(payload.unexpectedTargets, ["routing.ts"]);
    assert.deepEqual(payload.missingTargets, []);

    const markdown = readFileSync(join(directory, "summary.md"), "utf8");
    assert.doesNotMatch(markdown, /\| `routing\.ts` \|/u, "the foreign module is not in the table");
    assert.match(markdown, /unexpected module reports/u);

    // Its presence is still a failed measurement: the artifact set is not the
    // planned one, even though the published score is clean.
    const rejected = invoke(["mutation/workflow.mjs", "require-usable", out]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /unexpected module reports: routing\.ts/u);
    assert.match(rejected.stderr, /excluded from the score/u);

    // Control: selecting both scores both and passes.
    const both = invoke(["mutation/report.mjs", "--dir", directory, "--targets", "cache.ts,routing.ts", "--json", out, "--out", join(directory, "both.md")]);
    assert.equal(both.status, 0, both.stderr);
    const bothPayload = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(bothPayload.aggregate.total, 20);
    assert.deepEqual(bothPayload.unexpectedTargets, []);
    assert.equal(invoke(["mutation/workflow.mjs", "require-usable", out]).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unexpected reports are rejected by the gate on their own", () => {
  const reasons = unusableReasons({
    modules: [{ module: "cache.ts", total: 10, Killed: 10 }],
    aggregate: { total: 10, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
    unexpectedTargets: ["routing.ts"],
  });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /unexpected module reports: routing\.ts/u);
});

// --- A report path may only touch the reporting directory ---

test("a report path is confined to the reporting directory", () => {
  // The runner deletes its own previous output before measuring, so an
  // unrestricted path deleted a tracked file and then wrote a report over it.
  // A fresh checkout has no `reports/` (it is gitignored). The runner creates
  // it; so does this test, so the assertion can name the real path.
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const reportsReal = realpathSync(join(ROOT, "reports"));
  const accepted = resolveReportPath("reports/mutation/cache.ts.json");
  assert.equal(accepted, join(reportsReal, "mutation", "cache.ts.json"));
  assert.ok(isInsideReports(resolveReportPath("reports/archive/deep/nested/x.json")));

  for (const malicious of ["package.json", "src/Mutation.ts", "mutation/README.md", "../../outside.json", "/tmp/outside.json"]) {
    assert.throws(() => resolveReportPath(malicious), /must name a file under reports\//u, `${malicious} must be refused`);
  }
  // The prefix must include the separator: a sibling directory that merely
  // shares the string prefix is not the reporting directory.
  assert.throws(() => resolveReportPath("reports-archive/x.json"), /must name a file under reports\//u);
  // The directory itself is not a file target.
  assert.throws(() => resolveReportPath("reports"), /must name a file under reports\//u);
  assert.throws(() => resolveReportPath("reports/"), /must name a file under reports\//u);
  assert.throws(() => resolveReportPath(""), /needs a file path/u);

  // A directory that exists is refused rather than left to fail in unlink/write.
  const root = mkdtempSync(join(tmpdir(), "mutation-reports-root-"));
  try {
    const reportsRoot = join(root, "reports");
    writeFileSync(join(root, "placeholder"), "");
    execFileSync("mkdir", ["-p", join(reportsRoot, "existing")]);
    assert.throws(() => resolveReportPath(join(reportsRoot, "existing"), reportsRoot), /must name a file, not a directory/u);
    assert.equal(
      resolveReportPath(join(reportsRoot, "existing", "ok.json"), reportsRoot),
      join(realpathSync(reportsRoot), "existing", "ok.json"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // And the cleaner refuses an out-of-bounds owned path handed to it directly.
  assert.throws(
    () => reportsToClear({ report: "x.json" }, { target: "cache.ts", reportPath: join(ROOT, "package.json") }, join(ROOT, "reports"), []),
    /refusing to clear reports/u,
  );
});

// --- The published warnings and the gate must apply the same allowance ---

test("the summary applies the same timeout allowance as the gate", () => {
  const mutants = [...Array(80).fill("Killed"), ...Array(20).fill("Timeout")].map((status) => ({ status }));
  const report = { module: "cache.ts", mutants, summary: summarise(mutants), conflicts: [], shardsSeen: [0] };
  const reports = [report];

  // With the override, the gate accepts these 20 timeouts. The published summary
  // must not then contradict it by judging the module against the default of 10.
  const withOverride = summary({
    reports,
    expectedTargets: ["cache.ts"],
    shardsPerTarget: new Map([["cache.ts", 1]]),
    tolerance: 25,
  });
  assert.doesNotMatch(withOverride, /above this module's tolerance/u);
  assert.doesNotMatch(withOverride, /above the tolerance of 10/u);
  assert.match(withOverride, /tolerance 25/u);

  const payload = {
    modules: [{ module: "cache.ts", ...report.summary }],
    aggregate: { ...summarise(mutants), shardConflicts: 0 },
    missingTargets: [],
    timeoutToleranceOverride: 25,
  };
  assert.deepEqual(unusableReasons(payload), [], "the gate accepts the same run");

  // Control: without the override both reject against the calibrated default.
  const withoutOverride = summary({
    reports,
    expectedTargets: ["cache.ts"],
    shardsPerTarget: new Map([["cache.ts", 1]]),
  });
  assert.match(withoutOverride, /above this module's tolerance of 10/u);
  assert.ok(unusableReasons({ ...payload, timeoutToleranceOverride: undefined }).length > 0);
});

// --- Adversarial report paths: the boundary is the resolved filesystem ---

test("a symlinked directory cannot redirect a report outside the reporting directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-symlink-"));
  try {
    const reports = join(root, "reports");
    const outside = join(root, "outside");
    mkdirSync(reports, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, "victim.json");
    writeFileSync(victim, "do not touch");
    symlinkSync(outside, join(reports, "escape"));

    const target = join(reports, "escape", "victim.json");
    assert.throws(() => resolveReportPath(target, reports), /must name a file under/u);
    assert.equal(isInsideReports(target, reports), false);
    assert.equal(readFileSync(victim, "utf8"), "do not touch", "the outside file must not be written");

    // Cleanup applies the same boundary and fails closed rather than deleting it.
    assert.throws(
      () => reportsToClear({ report: target }, { target: "cache.ts", reportPath: target }, reports, [], reports),
      /refusing to clear reports/u,
    );
    assert.equal(readFileSync(victim, "utf8"), "do not touch", "the outside file must not be deleted");

    // A symlink to a file outside is caught by containment, which is the
    // stronger refusal: the write would land outside the boundary.
    symlinkSync(victim, join(reports, "linked-outside.json"));
    assert.throws(() => resolveReportPath(join(reports, "linked-outside.json"), reports), /must name a file under/u);

    // A symlink that stays inside is refused by the regular-file rule:
    // `unlinkSync` removes the link while `writeFileSync` follows it, so
    // "remove our own output" would not mean one thing.
    writeFileSync(join(reports, "real.json"), "{}");
    symlinkSync(join(reports, "real.json"), join(reports, "linked-inside.json"));
    assert.throws(() => resolveReportPath(join(reports, "linked-inside.json"), reports), /must name a regular file, not a symlink/u);

    // A dangling symlink is the same case as long as it points inside.
    symlinkSync(join(reports, "missing.json"), join(reports, "dangling.json"));
    assert.throws(() => resolveReportPath(join(reports, "dangling.json"), reports), /must name a regular file, not a symlink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a not-yet-created nested report path is allowed, and traversal out of it is not", () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-nested-"));
  try {
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    assert.equal(
      resolveReportPath(join(reports, "a", "b", "c.json"), reports),
      join(realpathSync(reports), "a", "b", "c.json"),
      "components that do not exist cannot redirect anything",
    );
    assert.throws(() => resolveReportPath(join(reports, "..", "outside.json"), reports), /must name a file under/u);

    // A reporting directory that does not exist yet is the fresh-checkout case:
    // resolution walks up to the nearest existing ancestor, so the path is
    // allowed and names exactly what it says.
    const freshRoot = join(root, "fresh", "reports");
    assert.equal(
      resolveReportPath(join(freshRoot, "mutation", "x.json"), freshRoot),
      join(realpathSync(root), "fresh", "reports", "mutation", "x.json"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Mixed or stale populations ---

test("an unsharded report cannot be merged with a shard of the same module", () => {
  // `<module>.json` parses as shard 0, so it collides with `<module>.shard0.json`.
  // Both present means two measurements of one shard; merging them would publish
  // a composite no run produced.
  const directory = mkdtempSync(join(tmpdir(), "mutation-duplicate-shard-"));
  try {
    const report = (status) => ({ files: { "/repo/cache.ts": { mutants: [{
      id: status, mutatorName: "EqualityOperator", replacement: "!==", status,
      location: { start: { line: 10, column: 1 }, end: { line: 10, column: 9 } },
    }] } } });
    writeFileSync(join(directory, "cache.ts.json"), JSON.stringify(report("Killed")));
    writeFileSync(join(directory, "cache.ts.shard0.json"), JSON.stringify(report("Survived")));
    stamp(directory, "cache.ts.json");
    stamp(directory, "cache.ts.shard0.json");

    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0, "no module may be merged from two files claiming one shard");
    assert.match(rejected[0].reason, /cache\.ts\.json and cache\.ts\.shard0\.json both claim cache\.ts shard 0 in attempt 0/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a report measured against different bytes is rejected, not merged", () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-stale-report-"));
  try {
    const report = {
      files: { "/repo/cache.ts": { mutants: [{
        id: "1", mutatorName: "EqualityOperator", replacement: "!==", status: "Killed",
        location: { start: { line: 10, column: 1 }, end: { line: 10, column: 9 } },
      }] } },
      bifrost: { measurement: "0".repeat(64), scope: "cache.ts" },
    };
    writeFileSync(join(directory, "cache.ts.json"), JSON.stringify(report));

    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0, "a stale measurement must not contribute mutants");
    assert.match(rejected[0].reason, /measured against different bytes/u);

    const reasons = unusableReasons({
      modules: [],
      aggregate: { total: 0, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
      missingTargets: ["cache.ts"],
      missingShards: [],
      rejectedModules: ["cache.ts"],
      rejectedReports: rejected,
    });
    assert.match(reasons.join(" "), /rejected reports for cache\.ts/u);
    assert.match(reasons.join(" "), /measured against different bytes/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unstamped report is rejected rather than trusted", () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-unstamped-"));
  try {
    writeFileSync(join(directory, "cache.ts.json"), JSON.stringify({
      files: { "/repo/cache.ts": { mutants: [{ id: "1", mutatorName: "EqualityOperator", replacement: "!==", status: "Killed", location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] } },
    }));
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0);
    assert.match(rejected[0].reason, /has no measurement provenance/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- A dry run must never destroy a completed measurement ---

test("a dry run clears nothing, while a real run still clears its own target", () => {
  const reportsDir = join(ROOT, "reports", "mutation");
  const run = { target: "cache.ts", reportPath: join(reportsDir, "cache.ts.json") };
  const entries = ["cache.ts.json", "cache.ts.shard0.json", "routing.ts.json"];

  assert.deepEqual(reportsToClear({ dryRun: true }, run, reportsDir, entries), [], "a dry run writes no report, so it clears none");

  const real = reportsToClear({}, run, reportsDir, entries);
  assert.deepEqual(real.sort(), [join(reportsDir, "cache.ts.json"), join(reportsDir, "cache.ts.shard0.json")].sort());
});

const hasBun = (() => {
  try {
    execFileSync("bun", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

test("a real dry run preserves a completed report on disk", { skip: !hasBun && "bun is required to dry-run the default runner" }, () => {
  const directory = join(ROOT, "reports", "mutation");
  const file = join(directory, "inline-override.ts.json");
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file) : null;
  const sentinel = JSON.stringify({ files: {}, sentinel: "a completed previous measurement" });
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, sentinel);
  try {
    execFileSync(process.execPath, ["mutation/run.mjs", "inline-override.ts", "--dry-run"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    assert.equal(readFileSync(file, "utf8"), sentinel, "a dry run must not clear a completed report");
  } finally {
    if (previous === null) rmSync(file, { force: true });
    else writeFileSync(file, previous);
  }
});

test("--dry-run refuses to name a report it will never produce", () => {
  const attempt = (args) => {
    try {
      execFileSync(process.execPath, ["mutation/run.mjs", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
      return { status: 0, stderr: "" };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };
  const result = attempt(["cache.ts", "--dry-run", "--report", "reports/mutation/x.json"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--dry-run writes no report/u);
});

// --- One policy: the gate and the summary are two renderings of one verdict ---

test("gate and summary agree on every measurement state", () => {
  // The input space here is finite, so it is enumerated rather than discovered
  // one review finding at a time. Each row states the diagnostics it must
  // produce; the loop then asserts that the gate prints exactly the blocking
  // ones and the summary page prints all of them. A rule added without a row
  // fails the completeness check at the bottom.
  const MODULE = "cache.ts";
  const reportFor = (counts, { module = MODULE, conflicts = [], shardsSeen = [0] } = {}) => {
    const mutants = Object.entries(counts).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));
    return { module, mutants, summary: summarise(mutants), conflicts, shardsSeen };
  };
  const healthy = (module, total = 100) => reportFor({ Killed: total }, { module });

  const cases = [
    ["a clean measurement", [reportFor({ Killed: 10 })], {}, [], []],
    ["no module reports", [], {}, ["no-modules", "missing-module"], []],
    ["a missing module", [healthy(MODULE)], { expectedTargets: [MODULE, "routing.ts"] }, ["missing-module"], []],
    ["a missing shard", [reportFor({ Killed: 10 })], { shardsPerTarget: new Map([[MODULE, 2]]) }, ["missing-shard"], []],
    ["an unexpected module", [healthy(MODULE), healthy("routing.ts")], { expectedTargets: [MODULE] }, ["unexpected-module"], []],
    ["an unexpected shard", [reportFor({ Killed: 10 }, { shardsSeen: [0, 1] })], { shardsPerTarget: new Map([[MODULE, 1]]) }, ["unexpected-shard"], []],
    [
      "a rejected report",
      [],
      { rejectedReports: [{ module: MODULE, name: "cache.ts.json", reason: "measured against different bytes" }] },
      ["no-modules", "missing-module", "rejected-report"],
      [],
    ],
    ["a module with zero mutants", [reportFor({})], {}, ["zero-mutants"], []],
    ["a module whose mutants are all ignored", [reportFor({ Ignored: 5 })], {}, ["no-evaluated-mutants"], []],
    ["a payload that records no identity", [reportFor({ Killed: 5 })], { identityFor: (m) => measurementIdentity(m) }, ["unstamped-payload"], []],
    ["a payload that cannot be checked here", [reportFor({ Killed: 5 })], { identityFor: () => { throw new Error("unknown mutation target cache.ts"); }, measuredIdentity: { [MODULE]: "0".repeat(64) } }, ["unverifiable-payload"], []],
    ["a payload measured against other bytes", [reportFor({ Killed: 5 })], { identityFor: () => "f".repeat(64), measuredIdentity: { [MODULE]: "0".repeat(64) } }, ["stale-payload"], []],
    ["a payload that matches this checkout", [reportFor({ Killed: 5 })], { identityFor: (m) => measurementIdentity(m), measuredIdentity: { [MODULE]: measurementIdentity(MODULE) } }, [], []],
    ["ignored mutants beside evaluated ones", [reportFor({ Killed: 4, Ignored: 6 })], {}, [], []],
    [
      "an aggregate timeout burst with every module inside its own allowance",
      Array.from({ length: 6 }, (_, index) => reportFor({ Killed: 92, Timeout: 8 }, { module: `m${index}.ts` })),
      { expectedTargets: ["m0.ts", "m1.ts", "m2.ts", "m3.ts", "m4.ts", "m5.ts"] },
      ["timeout-burst"],
      [],
    ],
    ["a module-local timeout burst inside a healthy run", [reportFor({ Killed: 85, Timeout: 15 }), healthy("routing.ts", 4100)], { expectedTargets: [MODULE, "routing.ts"] }, ["module-timeout-burst"], ["timeouts-observed"]],
    [
      "an aggregate error burst with every module inside its own allowance",
      Array.from({ length: 6 }, (_, index) => reportFor({ Killed: 95, RuntimeError: 5 }, { module: `m${index}.ts` })),
      { expectedTargets: ["m0.ts", "m1.ts", "m2.ts", "m3.ts", "m4.ts", "m5.ts"] },
      ["error-burst"],
      [],
    ],
    ["a module-local error burst inside a healthy run", [reportFor({ Killed: 85, RuntimeError: 15 }), healthy("routing.ts", 4100)], { expectedTargets: [MODULE, "routing.ts"] }, ["module-error-burst"], ["errors-observed"]],
    ["a shard conflict", [reportFor({ Killed: 10 }, { conflicts: [{ identity: "x", statuses: ["Killed", "Survived"], line: 3 }] })], {}, ["shard-conflict"], []],
    ["timeouts inside the allowance", [reportFor({ Killed: 100, Timeout: 1 })], {}, [], ["timeouts-observed"]],
    ["errors inside the allowance", [reportFor({ Killed: 100, RuntimeError: 2 })], {}, [], ["errors-observed"]],
    ["uncovered mutants", [reportFor({ Killed: 8, NoCoverage: 2 })], {}, [], ["no-coverage"]],
    [
      "an override that raises the timeout allowance",
      [reportFor({ Killed: 80, Timeout: 20 })],
      { timeoutToleranceOverride: 25 },
      [],
      ["timeouts-observed"],
    ],
  ];

  const seen = new Set();
  for (const [name, reports, options, blocking, advisory] of cases) {
    const { identityFor, ...payloadOptions } = options;
    const payload = buildPayload({ reports, expectedTargets: [MODULE], ...payloadOptions });
    const diagnostics = measurementDiagnostics(payload, identityFor ? { identityFor } : {});
    const reasons = unusableReasons(payload, identityFor ? { identityFor } : {});
    // Rendered from the same payload the gate reads, which is the invariant.
    const markdown = renderSummary({ reports, payload, ...(identityFor ? { identityFor } : {}) });

    const codes = diagnostics.map((entry) => entry.code).sort();
    assert.deepEqual(codes, [...blocking, ...advisory].sort(), `${name}: diagnostics`);
    for (const code of codes) seen.add(code);

    // The gate is exactly the blocking messages, in the same words.
    assert.deepEqual(
      reasons,
      diagnostics.filter((entry) => entry.severity === "blocking").map((entry) => entry.message),
      `${name}: the gate prints exactly the blocking messages`,
    );

    // Every diagnostic reaches the page, so the summary cannot contradict it.
    for (const entry of diagnostics) {
      assert.ok(markdown.includes(entry.message), `${name}: the summary must print "${entry.code}"`);
    }
    // And blocking ones are marked as such on the page.
    for (const message of reasons) {
      assert.ok(markdown.includes(`**${message}`), `${name}: blocking diagnostics are marked in the summary`);
    }
  }

  // Completeness: every diagnostic the policy can emit has a row above. Adding a
  // rule without a row fails here rather than in a later review.
  const emitted = new Set([
    ...cases.flatMap(([, reports, options]) => {
      const { identityFor, ...rest } = options;
      return measurementDiagnostics(buildPayload({ reports, expectedTargets: [MODULE], ...rest }), identityFor ? { identityFor } : {})
        .map((entry) => entry.code);
    }),
  ]);
  const source = readFileSync(new URL("../mutation/config.mjs", import.meta.url), "utf8");
  const declared = new Set([...source.matchAll(/note\(\s*"([a-z-]+)",\s*(?:BLOCKING|ADVISORY)/g)].map((match) => match[1]));
  assert.deepEqual([...declared].sort(), [...emitted].sort(), "every declared diagnostic has a truth-table row");
});

// --- The measured scope, and the identity that covers it ---

test("a partial --mutate scope cannot stand in for the whole module", () => {
  // `<module>.json` is shard 0 of 1, so a one-shard plan treats it as the whole
  // module. If the run behind it only mutated a line range, that score omits
  // most of the module while looking complete.
  const directory = mkdtempSync(join(tmpdir(), "mutation-partial-"));
  try {
    const report = {
      files: { "/repo/cache.ts": { mutants: [{
        id: "1", mutatorName: "EqualityOperator", replacement: "!==", status: "Killed",
        location: { start: { line: 10, column: 1 }, end: { line: 10, column: 9 } },
      }] } },
      bifrost: { measurement: measurementIdentity("cache.ts"), scope: "cache.ts:1-50" },
    };
    writeFileSync(join(directory, "cache.ts.json"), JSON.stringify(report));

    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0, "a partial measurement must not be scored as the whole module");
    assert.match(rejected[0].reason, /covers only cache\.ts:1-50/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identityOrFallback(module) {
  try {
    return measurementIdentity(module);
  } catch {
    return "0".repeat(64);
  }
}

function shardFixture(scopes, module = "cache.ts") {
  const directory = mkdtempSync(join(tmpdir(), "mutation-shard-plan-"));
  scopes.forEach((scope, index) => {
    const name = index === scopes.length - 1 && scopes.length === 1 ? `${module}.json` : `${module}.shard${index}.json`;
    writeFileSync(join(directory, name), JSON.stringify({
      files: { [`/repo/${module}`]: { mutants: [{
        id: `${index}`, mutatorName: "EqualityOperator", replacement: "!==", status: "Killed",
        location: { start: { line: 10, column: 1 }, end: { line: 10, column: 9 } },
      }] } },
      // A module outside TARGETS has no identity; the plan check must reject it
      // before provenance is ever consulted.
      bifrost: { measurement: identityOrFallback(module), scope },
    }));
  });
  return directory;
}

test("a shard that measures less than the plan assigned is rejected", () => {
  // The leg mutated ten lines but still calls itself shard 0. Nothing else in the
  // report says what was skipped, so the declared range is the only evidence, and
  // accepting it would publish a population that never ran.
  const planned = shardsFor("cache.ts", 2);
  const directory = shardFixture(["cache.ts:1-10", planned[1].mutate]);
  try {
    const { reports, rejected } = readReports(directory, { shardCounts: new Map([["cache.ts", 2]]) });
    assert.equal(reports.length, 0);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason.includes(planned[0].mutate), rejected[0].reason);
    assert.match(rejected[0].reason, /truncated shard is not the planned population/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shards swapped between indexes are rejected", () => {
  const planned = shardsFor("cache.ts", 2);
  const directory = shardFixture([planned[1].mutate, planned[0].mutate]);
  try {
    const { reports, rejected } = readReports(directory, { shardCounts: new Map([["cache.ts", 2]]) });
    assert.equal(reports.length, 0, "a swapped pair measures each range, but not as the plan asked");
    assert.equal(rejected.length, 2, "both files are named");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a shard that extends past the plan is rejected", () => {
  const planned = shardsFor("cache.ts", 2);
  const directory = shardFixture([`cache.ts:1-${lineCount("cache.ts") + 50}`, planned[1].mutate]);
  try {
    const { reports } = readReports(directory, { shardCounts: new Map([["cache.ts", 2]]) });
    assert.equal(reports.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a report for a module the plan cannot describe is rejected", () => {
  const directory = shardFixture(["widget.ts"], "widget.ts");
  try {
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0);
    assert.match(rejected[0].reason, /cannot be planned in this checkout/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a sharded report may carry a line-range scope", () => {
  // Sharding is line ranges by design; only an *unsharded* name has to mean the
  // whole module. The range still has to be the one the plan assigned.
  const directory = mkdtempSync(join(tmpdir(), "mutation-shard-scope-"));
  try {
    const planned = shardsFor("cache.ts", 2);
    const report = (index, line) => ({
      files: { "/repo/cache.ts": { mutants: [{
        id: String(index), mutatorName: "EqualityOperator", replacement: "!==", status: "Killed",
        location: { start: { line, column: 1 }, end: { line, column: 9 } },
      }] } },
      bifrost: { measurement: measurementIdentity("cache.ts"), scope: planned[index].mutate },
    });
    writeFileSync(join(directory, "cache.ts.shard0.json"), JSON.stringify(report(0, 10)));
    writeFileSync(join(directory, "cache.ts.shard1.json"), JSON.stringify(report(1, 90)));

    const { reports, rejected } = readReports(directory);
    assert.deepEqual(rejected, []);
    assert.equal(reports[0].mutants.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the identity covers the local modules the target imports", () => {
  // `cache.ts` imports `storage.ts`. The derivation says the helper is an input,
  // and the digest says different bytes give a different identity, so an old
  // report cannot survive a helper change. Both halves are asserted here; the
  // earlier version rewrote `storage.ts` on disk to show it, which made the suite
  // mutate tracked source.
  assert.ok(identityInputs("cache.ts").includes("storage.ts"), "a transitive helper is an input");

  const files = identityInputs("cache.ts");
  const digestWith = (content) =>
    identityDigest(files, (file) =>
      file === "storage.ts" ? Buffer.from(content) : readFileSync(join(ROOT, file)),
    );
  assert.notEqual(digestWith("export const a = 1;\n"), digestWith("export const a = 2;\n"));
  assert.equal(digestWith("same"), digestWith("same"), "the digest is reproducible");
});

test("a survivor row names the tests that ran against it", () => {
  // The score cannot distinguish "nothing asserts this" from "a test runs but
  // does not discriminate"; both look like a survivor. The covering test names
  // are the only evidence that separates them, and the first plan written from a
  // bundle without them proposed a test that the mutant already satisfied.
  const directory = mkdtempSync(join(tmpdir(), "mutation-coverage-"));
  try {
    writeFileSync(join(directory, "cache.json"), JSON.stringify({
      files: { "/repo/cache.ts": { mutants: [{
        id: "5", mutatorName: "Regex", replacement: "/x/", status: "Survived",
        testsCompleted: 2, coveredBy: ["0", "1"],
        location: { start: { line: 28, column: 32 }, end: { line: 28, column: 49 } },
      }] } },
      testFiles: {
        "tests/cache.test.ts": {
          tests: [
            { id: "0", name: "tests/cache.test.ts > reads > returns a value" },
            { id: "1", name: "tests/cache.test.ts > reads > ignores a missing key" },
          ],
        },
      },
    }));
    stamp(directory, "cache.json");

    const { reports } = readReports(directory);
    const [row] = survivorRows(reports);
    assert.equal(row.testsCompleted, 2);
    assert.deepEqual(row.coveredBy, [
      "tests/cache.test.ts > reads > returns a value",
      "tests/cache.test.ts > reads > ignores a missing key",
    ]);
    assert.equal(row.coveredBy.length, row.testsCompleted, "ids resolve to real names, not placeholders");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a survivor carries the source line it points at", () => {
  // Line numbers do not survive an edit above them, and nothing in a raw range
  // says so. The text is findable regardless, so the coordinate becomes a hint.
  const directory = mkdtempSync(join(tmpdir(), "mutation-source-anchor-"));
  try {
    const line = lineCount("cache.ts");
    writeFileSync(join(directory, "cache.json"), JSON.stringify({
      files: { "/repo/cache.ts": { mutants: [{
        id: "1", mutatorName: "Regex", replacement: "/x/", status: "Survived",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
      }] } },
    }));
    stamp(directory, "cache.json");
    const [row] = survivorRows(readReports(directory).reports);
    assert.equal(typeof row.source, "string");
    assert.ok(row.source.length > 0, `first line of cache.ts (${line} lines) is the anchor`);
    const [annotation] = annotationLines([row]);
    assert.ok(annotation.includes(row.source.trim()), "the annotation repeats the source");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a static survivor is marked so its empty coverage is not an anomaly", () => {
  // A static mutant runs while a file loads, so Stryker cannot attribute it to one
  // test: it reloads the environment and runs the whole suite. A reader who sees
  // "189 tests ran, none covered it" concludes the opposite of what happened —
  // and the first wording claimed they were unkillable, which is false.
  const directory = mkdtempSync(join(tmpdir(), "mutation-static-"));
  try {
    writeFileSync(join(directory, "cache.json"), JSON.stringify({
      files: { "/repo/cache.ts": { mutants: [{
        id: "0", mutatorName: "ArithmeticOperator", replacement: "24 / 30", status: "Survived",
        static: true, testsCompleted: 189, coveredBy: [],
        location: { start: { line: 23, column: 30 }, end: { line: 23, column: 36 } },
      }] } },
      testFiles: { "tests/cache.test.ts": { tests: [{ id: "0", name: "tests/cache.test.ts > cache > adds" }] } },
    }));
    stamp(directory, "cache.json");
    const { reports } = readReports(directory);
    const [row] = survivorRows(reports);
    assert.equal(row.static, true, "the row says why coverage is empty");

    const text = renderSummary({ reports, payload: buildPayload({ reports, expectedTargets: ["cache.ts"] }) });
    assert.match(text, /### Static survivors/u);
    assert.match(text, /runs the whole suite/u, "the wording must not claim these are unkillable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uncovered mutants are named, not just counted", () => {
  // The score says "9 have no coverage"; a reader cannot act on the count without
  // re-running Stryker to find out which nine.
  const directory = mkdtempSync(join(tmpdir(), "mutation-uncovered-"));
  try {
    writeFileSync(join(directory, "cache.json"), JSON.stringify({
      files: { "/repo/cache.ts": { mutants: [{
        id: "77", mutatorName: "ArithmeticOperator", replacement: "maxSeq - 1", status: "NoCoverage",
        location: { start: { line: 110, column: 28 }, end: { line: 110, column: 37 } },
      }] } },
    }));
    stamp(directory, "cache.json");
    const { reports } = readReports(directory);
    const text = renderSummary({ reports, payload: buildPayload({ reports, expectedTargets: ["cache.ts"] }) });
    assert.match(text, /### Uncovered mutants/u);
    assert.ok(text.includes("cache.ts:110"), "the line is named");
    assert.ok(text.includes("maxSeq - 1"), "and what it replaces");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage is absent, not invented, when the report carries none", () => {
  const directory = mkdtempSync(join(tmpdir(), "mutation-no-coverage-"));
  try {
    writeFileSync(join(directory, "cache.json"), JSON.stringify({
      files: { "/repo/cache.ts": { mutants: [{
        id: "1", mutatorName: "Regex", replacement: "/x/", status: "Survived",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
      }] } },
    }));
    stamp(directory, "cache.json");
    const [row] = survivorRows(readReports(directory).reports);
    assert.equal(row.coveredBy, null, "no coverage must not read as 'zero tests covered it'");
    assert.equal(row.testsCompleted, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the summary names the bound tests and the checkout that was measured", () => {
  // A test outside the bound set cannot kill a mutant however strong it is, and
  // an artifact names a module without saying which tree produced it.
  const directory = mkdtempSync(join(tmpdir(), "mutation-provenance-doc-"));
  try {
    writeFileSync(join(directory, "cache.json"), JSON.stringify({
      projectRoot: "/home/runner/work/pi-bifrost/pi-bifrost",
      files: { "/repo/cache.ts": { mutants: [{
        id: "1", mutatorName: "Regex", replacement: "/x/", status: "Survived",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
      }] } },
    }));
    stamp(directory, "cache.json");
    const { reports } = readReports(directory);
    const payload = buildPayload({ reports, expectedTargets: ["cache.ts"] });
    const text = renderSummary({ reports, payload });

    assert.match(text, /### Bound tests/u);
    assert.ok(text.includes("tests/cache.test.ts"), "the bound file is named");
    assert.deepEqual(payload.measuredIn, ["/home/runner/work/pi-bifrost/pi-bifrost"]);
    assert.match(text, /measurement usable|unusable|Bound tests/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("both Stryker branches share one argument builder", () => {
  // A dry run used to build its own argument list and silently drop the worker
  // limit, so `--dry-run --concurrency 1` used Stryker's default worker count.
  assert.deepEqual(strykerArgs({ concurrency: "1" }, { dryRun: true }), ["stryker", "run", "--dryRunOnly", "--concurrency", "1"]);
  assert.deepEqual(strykerArgs({ concurrency: "4" }), ["stryker", "run", "--concurrency", "4"]);
  assert.deepEqual(strykerArgs({}), ["stryker", "run"], "no concurrency means no flag");
});

test("a partial --mutate scope must name its artifact", () => {
  const attempt = (args) => {
    try {
      execFileSync(process.execPath, ["mutation/run.mjs", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
      return { status: 0, stderr: "" };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };
  const result = attempt(["cache.ts", "--mutate", "cache.ts:1-50"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /measures only part of cache\.ts; name the artifact with --report/u);
});

// --- The reporting boundary itself is not user-controlled ---

test("a symlinked reports/mutation cannot redirect the cleanup", () => {
  // The root check was not enough: `reports/` was fine, and `reports/mutation`
  // pointed elsewhere. `reportsToClear` then compared that directory against its
  // own canonical form, which is trivially true, and deleted a file outside the
  // checkout. This is the exact shape the review found.
  const outside = mkdtempSync(join(tmpdir(), "mutation-nested-escape-"));
  const reports = join(ROOT, "reports");
  const nested = join(reports, "mutation");
  const aside = `${nested}.test-aside-${process.pid}`;
  const hadNested = existsSync(nested);
  try {
    writeFileSync(join(outside, "cache.ts.shard0.json"), "do not delete");
    if (hadNested) renameSync(nested, aside);
    mkdirSync(reports, { recursive: true });
    symlinkSync(outside, nested);

    assert.throws(
      () => reportsToClear({}, { target: "cache.ts", reportPath: null }, nested, ["cache.ts.shard0.json"]),
      /outside .*reports/u,
      "the boundary is the reporting root, not the directory under it",
    );
    assert.equal(readFileSync(join(outside, "cache.ts.shard0.json"), "utf8"), "do not delete");
  } finally {
    rmSync(nested, { force: true });
    if (hadNested) renameSync(aside, nested);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a scoped dry run can start without naming a report", () => {
  // A dry run saves nothing, so it has no artifact that could be mistaken for the
  // whole module. Requiring --report made it impossible: --report is refused for
  // dry runs, so `--mutate <range> --dry-run` could not run at all.
  //
  // This asserts the *plan validation*, not a measurement: spawning the real
  // runner needs `bun` on PATH, which an arbitrary CI job does not have, and a
  // test that fails for a missing test runner proves nothing about arguments.
  const plan = (args) => {
    const options = parseArgs(args);
    const targets = options.targets.length > 0 ? options.targets : targetNames();
    try {
      assertRunArguments(options, targets);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  };

  assert.deepEqual(plan(["cache.ts", "--mutate", "cache.ts:1-50", "--dry-run"]), { ok: true });
  assert.deepEqual(plan(["cache.ts", "--mutate", "cache.ts:1-50", "--dry-run", "--concurrency", "1"]), { ok: true });

  // A real scoped run still has to name its artifact: that is what stops a partial
  // measurement being stored as the whole module.
  const real = plan(["cache.ts", "--mutate", "cache.ts:1-50"]);
  assert.equal(real.ok, false);
  assert.match(real.message, /name the artifact with --report/u);

  // And a dry run still refuses --report, which is why the requirement above
  // could never be satisfied.
  const conflicting = plan(["cache.ts", "--dry-run", "--report", "reports/mutation/cache.ts.shard0.json"]);
  assert.equal(conflicting.ok, false);
  assert.match(conflicting.message, /writes no report/u);
});

test("a symlinked reporting root is refused", () => {
  // `reports/` is gitignored, so it is not part of any commit -- but anything with
  // write access to the tree can create the link. Without this check, "the
  // reporting directory" means wherever the link points, and both writes and
  // cleanup follow it out of the repository.
  const reportsPath = join(ROOT, "reports");
  const aside = `${reportsPath}.test-aside-${process.pid}`;
  const hadReports = existsSync(reportsPath);
  if (hadReports) renameSync(reportsPath, aside);
  const outside = mkdtempSync(join(tmpdir(), "mutation-root-escape-"));
  try {
    writeFileSync(join(outside, "victim.json"), "do not touch");
    symlinkSync(outside, reportsPath);

    assert.throws(() => reportingRoot(), /outside the repository/u);
    assert.throws(() => resolveReportPath("reports/mutation/x.json"), /must name a file under reports\//u);
    assert.equal(isInsideReports("reports/mutation/x.json"), false);
    assert.equal(readFileSync(join(outside, "victim.json"), "utf8"), "do not touch");
  } finally {
    rmSync(reportsPath, { force: true });
    if (hadReports) renameSync(aside, reportsPath);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the identity covers the measurement's execution inputs", () => {
  // The population depends on more than the mutated bytes: how Stryker is
  // configured, how bindings are derived, and which dependency versions resolve.
  const inputs = identityInputs("cache.ts");
  for (const file of ["stryker.config.mjs", "mutation/targets.mjs", "package-lock.json", "mutation/config.mjs"]) {
    assert.ok(inputs.includes(file), `${file} must be an identity input`);
  }
  // An unreadable input must not collide with a readable one.
  assert.notEqual(identityDigest(["a.ts"], () => "unreadable"), identityDigest(["a.ts"], () => ""));
});

// --- A corrupt artifact must not resurrect an older attempt ---

const REAL_ARTIFACT = "mutation-report-inline-override.ts-shard0-69d885d57c1fc1a65797aaf86c5b7b3af0f47433-run-44123987165-attempt";

function attemptFixture(entries) {
  // entries: [{ attempt, body, file? }] written under artifact directory names
  // copied from a real run, so the parser is pinned to GitHub's actual layout.
  const directory = mkdtempSync(join(tmpdir(), "mutation-corrupt-attempt-"));
  for (const { attempt, body, file = "inline-override.ts.shard0.json" } of entries) {
    const artifact = `${REAL_ARTIFACT}-${attempt}`;
    mkdirSync(join(directory, artifact), { recursive: true });
    writeFileSync(join(directory, artifact, file), body);
  }
  return directory;
}

const goodInlineReport = () => JSON.stringify({
  files: { "/repo/inline-override.ts": { mutants: [{
    id: "1", mutatorName: "EqualityOperator", replacement: "!==", status: "Killed",
    location: { start: { line: 10, column: 1 }, end: { line: 10, column: 9 } },
  }] } },
  bifrost: { measurement: measurementIdentity("inline-override.ts"), scope: "inline-override.ts" },
});

test("a corrupted newer attempt does not publish the older one", () => {
  // A truncated upload is indistinguishable from "no artifact" once it is
  // dropped, and the earlier attempt then looks current. The run that produced
  // the newer attempt was a re-run precisely because something was wrong, so its
  // absence is not evidence of success.
  const directory = attemptFixture([
    { attempt: 1, body: goodInlineReport() },
    { attempt: 2, body: goodInlineReport().slice(0, 120) },
  ]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0, "no fallback to attempt 1");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /attempt 2\) could not be read/u);
    assert.match(rejected[0].reason, /not a reason to fall back/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupted older attempt is superseded by a readable newer one", () => {
  const directory = attemptFixture([
    { attempt: 1, body: "{ not json" },
    { attempt: 2, body: goodInlineReport() },
  ]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.deepEqual(rejected, []);
    assert.equal(reports.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable artifact is named even when nothing else exists", () => {
  // Without this it becomes "missing module", which sends the reader looking for
  // a leg that ran fine and uploaded something unreadable.
  const directory = attemptFixture([{ attempt: 1, body: "{" }]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].module, "inline-override.ts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupted newer attempt of a nonzero shard does not publish the older one", () => {
  // The failed parse has to keep the shard index. Otherwise the corrupt shard 1
  // claims shard 0, shard 1's older attempt looks current, and the summary
  // publishes half the module as complete.
  const directory = attemptFixture([
    { attempt: 1, body: goodInlineReport(), file: "inline-override.ts.shard1.json" },
    { attempt: 2, body: "{ not json", file: "inline-override.ts.shard1.json" },
    { attempt: 3, body: goodInlineReport() },
  ]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0, "shard 1 attempt 1 must not stand in for attempt 2");
    assert.ok(rejected.length > 0);
    assert.match(rejected[0].reason, /could not be read/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental state beside the reports is not read as a measurement", () => {
  // An interrupted local incremental run leaves a cache file in the same
  // directory. Reading it invented a module report for a module that no leg
  // measured, which then failed the summary's unexpected-module check.
  const directory = attemptFixture([{ attempt: 1, body: goodInlineReport() }]);
  try {
    mkdirSync(join(directory, "reports"));
    writeFileSync(join(directory, "reports", ".incremental-inline-override.json"), "{ not json");
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 1);
    assert.deepEqual(rejected, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the attempt is read from a real artifact directory name", () => {
  const directory = attemptFixture([
    { attempt: 1, body: goodInlineReport() },
    { attempt: 2, body: goodInlineReport() },
  ]);
  try {
    const { reports } = readReports(directory);
    // Two attempts of one shard: the later one is authoritative, not ambiguous.
    assert.equal(reports.length, 1);
    assert.equal(reports[0].attempt, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- Multi-attempt artifacts: one authoritative report per shard ---

const artifactReport = (shard, line, status = "Killed", count = 1) => ({
  files: { "/repo/cache.ts": { mutants: [{
    id: `${shard}-${line}`, mutatorName: "EqualityOperator", replacement: "!==", status,
    location: { start: { line, column: 1 }, end: { line, column: 9 } },
  }] } },
  bifrost: { measurement: measurementIdentity("cache.ts"), scope: shardsFor("cache.ts", count)[shard].mutate },
});

function artifactFixture(attempts) {
  // attempts: [{ artifact, name, report }]
  const directory = mkdtempSync(join(tmpdir(), "mutation-attempts-"));
  for (const { artifact, name, report } of attempts) {
    mkdirSync(join(directory, artifact), { recursive: true });
    writeFileSync(join(directory, artifact, name), JSON.stringify(report));
  }
  return directory;
}

test("a partial re-run reconstructs one measurement from several attempts", () => {
  // Only shard 1 failed, so "re-run failed jobs" produces attempt 2 for it while
  // shard 0 stays on attempt 1. Both belong to the same measurement.
  const directory = artifactFixture([
    { artifact: "mutation-report-cache.ts-shard0-sha-run-1-attempt-1", name: "cache.ts.shard0.json", report: artifactReport(0, 10, "Killed", 2) },
    { artifact: "mutation-report-cache.ts-shard1-sha-run-1-attempt-2", name: "cache.ts.shard1.json", report: artifactReport(1, 90, "Killed", 2) },
  ]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.deepEqual(rejected, []);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].mutants.length, 2, "both attempts contribute their own shard");
    assert.deepEqual(reports[0].shardsSeen, [0, 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the newest attempt of one shard wins, deterministically", () => {
  const directory = artifactFixture([
    { artifact: "mutation-report-cache.ts-shard0-sha-run-1-attempt-1", name: "cache.ts.shard0.json", report: artifactReport(0, 10, "Survived") },
    { artifact: "mutation-report-cache.ts-shard0-sha-run-1-attempt-2", name: "cache.ts.shard0.json", report: artifactReport(0, 10, "Killed") },
  ]);
  try {
    const { reports } = readReports(directory);
    assert.equal(reports[0].mutants.length, 1);
    assert.equal(reports[0].mutants[0].status, "Killed", "the later attempt is authoritative");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two reports for one shard in the same attempt are rejected", () => {
  // Choosing between them would depend on extraction order, which is not a
  // policy. Ambiguity is refused instead.
  const directory = artifactFixture([
    { artifact: "mutation-report-cache.ts-shard0-sha-run-1-attempt-2", name: "cache.ts.shard0.json", report: artifactReport(0, 10) },
    { artifact: "mutation-report-other-shard0-sha-run-1-attempt-2", name: "cache.ts.shard0.json", report: artifactReport(0, 10) },
  ]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].reason, /both claim cache\.ts shard 0 in attempt 2/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a newer attempt measured against different bytes is still rejected", () => {
  const stale = artifactReport(0, 10);
  stale.bifrost.measurement = "0".repeat(64);
  const directory = artifactFixture([
    { artifact: "mutation-report-cache.ts-shard0-sha-run-1-attempt-1", name: "cache.ts.shard0.json", report: artifactReport(0, 10) },
    { artifact: "mutation-report-cache.ts-shard0-sha-run-1-attempt-2", name: "cache.ts.shard0.json", report: stale },
  ]);
  try {
    const { reports, rejected } = readReports(directory);
    assert.equal(reports.length, 0, "recency does not override provenance");
    assert.match(rejected[0].reason, /measured against different bytes/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
