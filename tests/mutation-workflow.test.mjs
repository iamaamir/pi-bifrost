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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOT,
  bindingExclusions,
  bindingFor,
  commandFor,
  directConsumers,
  exceedsBudget,
  legEstimateMinutes,
  lineCount,
  runnerFor,
  shardsFor,
  suggestedShards,
  targetConfig,
  targetInventory,
  targetNames,
} from "../mutation/targets.mjs";
import {
  BUN_RUNNER_PLUGIN,
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
  estimatedMinutes,
  legMinutes,
  runtimeErrorTolerance,
  timeoutTolerance,
  unusableReasons,
} from "../mutation/config.mjs";
import {
  planMatrix,
  resolveConcurrency,
  resolveShardCount,
  resolveTargets,
  resolveTimeoutTolerance,
  summaryLines,
} from "../mutation/workflow.mjs";
import { annotationLines, readReports, renderSummary, summarise, survivorRows } from "../mutation/report.mjs";

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
  // selection and the per-shard report name. Matrix values reach the shell as
  // quoted arguments, not as interpolated script text.
  assert.match(block, /node mutation\/run\.mjs "\$\{\{ matrix\.target \}\}"/u);
  assert.match(block, /--mutate "\$\{\{ matrix\.mutate \}\}"/u, "the leg must narrow the scope to its shard");
  assert.match(block, /--report "\$\{\{ matrix\.target \}\}\.shard\$\{\{ matrix\.shard \}\}\.json"/u);
  assert.match(block, /--concurrency "\$\{\{ needs\.plan\.outputs\.concurrency \}\}"/u);

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
  for (const input of ["target", "shards", "concurrency", "timeout_tolerance", "fail_on_unusable", "upload_reports"]) {
    assert.match(dispatch, new RegExp(`^ {6}${input}:$`, "mu"), `${input} must be a dispatch input`);
  }
  // Defaults reproduce the nightly run exactly.
  assert.match(dispatch, /^ {6}shards:\n(?:.*\n)*?^ {8}default: "0"$/mu);
  assert.match(dispatch, /^ {6}concurrency:\n(?:.*\n)*?^ {8}default: "4"$/mu);
  assert.match(dispatch, /^ {6}timeout_tolerance:\n(?:.*\n)*?^ {8}default: ""$/mu);
  assert.match(dispatch, /^ {6}fail_on_unusable:\n(?:.*\n)*?^ {8}default: true$/mu);
  assert.match(dispatch, /^ {6}upload_reports:\n(?:.*\n)*?^ {8}default: true$/mu);
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
  assert.match(block, /if: \$\{\{ !cancelled\(\) \}\}/u, "a failed leg must still summarise");
  assert.match(block, /continue-on-error: true/u, "a missing artifact must be reported, not crash the job");
  assert.match(block, /name: mutation-summary-\$\{\{ github\.sha \}\}/u);
  assert.match(block, /path: mutation-out\//u);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u, "the summary must land on the run page");
});

test("the measurement fails only when it is unusable, never on a low score", () => {
  const block = jobs.summarise;
  assert.match(block, /run: node mutation\/workflow.mjs require-usable mutation-out\/summary\.json/u);

  // A low score is the measurement, not a failure.
  assert.deepEqual(unusableReasons({ modules: [{ module: "cache.ts", honestScore: 1 }], aggregate: { total: 10, Timeout: 0 }, missingTargets: [] }), []);

  // A few timeouts are legitimate: the mutant genuinely does not terminate.
  assert.deepEqual(
    unusableReasons({ modules: [{ module: "routing.ts" }], aggregate: { total: 989, Timeout: 7 }, missingTargets: [] }),
    [],
    "7 of 989 timeouts (real infinite loops) must not fail the run",
  );

  // A budget collapse produces timeouts an order of magnitude above the tolerance.
  const collapse = unusableReasons({ modules: [{ module: "reliability.ts" }], aggregate: { total: 352, Timeout: 208 }, missingTargets: [] });
  assert.equal(collapse.length, 1);
  assert.match(collapse[0], /exceed the tolerance/u);

  // A missing matrix leg is not a pass.
  const missing = unusableReasons({ modules: [{ module: "cache.ts" }], aggregate: { total: 10, Timeout: 0 }, missingTargets: ["routing.ts"] });
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

test("the bound command names the target's derived test files", () => {
  for (const target of targetNames()) {
    const command = commandFor(target);
    assert.match(command, /^node --test --experimental-strip-types /u);
    for (const file of bindingFor(target)) {
      assert.ok(command.includes(file), `${target} command must include ${file}`);
    }
  }
});

test("no-coverage mutants count against the honest score", () => {
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
  assert.equal(Number(summary.honestScore.toFixed(2)), 33.33);
  assert.equal(summary.NoCoverage, 2);

  const allUncovered = summarise([{ status: "NoCoverage" }]);
  assert.equal(allUncovered.honestScore, 0, "a mutant nothing reaches is not a pass");
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

test("incremental reuse is opt-in and stays out of the authoritative run", () => {
  // The nightly is the measurement, so a default config must measure every
  // mutant. Reuse is a local convenience, keyed per target so matrix legs do not
  // read each other's stored results.
  for (const target of targetNames()) {
    assert.equal("incremental" in targetConfig(target), false, `${target} must default to a full run`);
  }
  const local = targetConfig("cache.ts", { incremental: true });
  assert.equal(local.incremental, true);
  assert.match(local.incrementalFile, /^reports\/mutation\/\.incremental-cache\.json$/u);
  assert.notEqual(
    targetConfig("routing.ts", { incremental: true }).incrementalFile,
    local.incrementalFile,
    "each target needs its own incremental file",
  );
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

test("survivor counts, honest score and Stryker score are derived, not assumed", () => {
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
  // Honest score excludes it: 2/(2+2).
  assert.equal(summary.honestScore, 50);
  // The two scores differ, which is the whole reason both are reported.
  assert.notEqual(summary.honestScore, summary.strykerScore);
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

    const reports = readReports(directory);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].module, "cache.ts");
    assert.equal(reports[0].summary.total, 2);

    const rows = survivorRows(reports);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "endColumn", "endLine", "module", "mutantId", "mutator", "replacement", "startColumn", "startLine",
    ].sort());

    const markdown = renderSummary({ reports, expectedTargets: ["cache.ts"] });
    // Module | Mutants | Killed | Survived | NoCoverage | Timeout | Errors | ...
    assert.match(markdown, /\| `cache\.ts` \| 2 \| 1 \| 1 \| 0 \| 0 \| 0 \|/u);
    assert.match(markdown, /Honest score/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing module report is flagged rather than rendering as a pass", () => {
  const markdown = renderSummary({ reports: [], expectedTargets: ["cache.ts", "routing.ts"] });
  assert.match(markdown, /Missing reports/u);
  assert.match(markdown, /`cache\.ts`/u);
  assert.match(markdown, /`routing\.ts`/u);
});

test("summary lines name the score and the timeout count", () => {
  const lines = summaryLines({
    modules: [{ module: "cache.ts", honestScore: 75.5, Killed: 3, Survived: 1, Timeout: 0 }],
    aggregate: { total: 4, honestScore: 75.5, Timeout: 0 },
    missingTargets: [],
  });
  assert.match(lines.join("\n"), /honest=75\.50/u);
  assert.match(lines.join("\n"), /`cache\.ts`: 75\.50% honest/u);
});

test("verification keeps no mutation job, so the two cannot drift apart", () => {
  assert.doesNotMatch(verificationWorkflow, /stryker/u, "verification must not run Stryker");
  assert.doesNotMatch(verificationWorkflow, /mutation-experiment/u, "the old job must be gone");
  assert.match(verificationWorkflow, /^ {2}schedule:$/mu, "verification keeps its own nightly campaign");
});

test("the tooling resolves the repository root and finds the test directory", () => {
  assert.ok(ROOT.includes("pi-bifrost"), "root must resolve inside the repository, worktree or not");
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

    const reports = readReports(directory);
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

    const reports = readReports(directory);
    assert.equal(reports[0].mutants.length, 1);
    assert.equal(reports[0].conflicts.length, 1, "the disagreement must be recorded");
    assert.deepEqual(reports[0].conflicts[0].statuses, ["Killed", "Survived"]);

    // A conflict makes the run unusable: the score is not reproducible.
    const markdown = renderSummary({ reports, expectedTargets: ["cache.ts"] });
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
    modules: [{ module: "cache.ts" }],
    aggregate: { total: 1000, Timeout: 0, RuntimeError: 0, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.deepEqual(healthy, [], "a clean run is usable");

  const broken = unusableReasons({
    modules: [{ module: "cache.ts" }],
    aggregate: { total: 388, Timeout: 0, RuntimeError: 320, CompileError: 0, shardConflicts: 0 },
    missingTargets: [],
  });
  assert.equal(broken.length, 1);
  assert.match(broken[0], /errored and are excluded from the score/u);
  assert.match(broken[0], /smaller population/u);

  const tolerable = unusableReasons({
    modules: [{ module: "cache.ts" }],
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
