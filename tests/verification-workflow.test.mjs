// Verification workflow campaign regression tests (issue #85).
//
// The expanded campaign, Pi compatibility matrix, and opt-in mutation
// experiment ride the existing Verification workflow. These tests lock the
// invariants issue #85 requires: all seven release gates and the report
// publishers stay intact and unconditional, campaign jobs stay opt-in for
// normal PR/push/default manual runs, the compatibility matrix uses explicit
// version pins, and every added job keeps a hard bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/verification.yml", import.meta.url), "utf8");
const ciReportSource = readFileSync(new URL("../scripts/ci-report.mjs", import.meta.url), "utf8");
const verifyReleaseSource = readFileSync(new URL("../scripts/verify-release.mjs", import.meta.url), "utf8");
const mergeEligibilitySource = readFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url), "utf8");

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

function jobCondition(block) {
  const match = block.match(/^ {4}if: (.+)$/mu);
  return match ? match[1].trim() : null;
}

/** Evaluate a job-level `if:` expression the way GitHub evaluates it. */
function runsFor(condition, eventName, inputs = {}) {
  if (condition === null) return true;
  const expression = condition.replaceAll("github.event_name", "eventName");
  // The expression is repository-authored workflow YAML, never prompt or
  // configuration input. Evaluating it is the point of this test.
  // nosemgrep: bifrost-no-eval
  return Boolean(new Function("eventName", "inputs", `return (${expression});`)(eventName, inputs));
}

function requiredGatesFrom(source) {
  const match = source.match(/const REQUIRED_GATES = \[([\s\S]*?)\];/u);
  assert.ok(match, "REQUIRED_GATES declaration must exist");
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

function releaseGateScriptsFrom(source) {
  const match = source.match(/const REQUIRED_GATES = \[([\s\S]*?)\];/u);
  assert.ok(match, "REQUIRED_GATES declaration must exist");
  return [...match[1].matchAll(/\["([^"]+)", "([^"]+)"\]/gu)].map((entry) => ({ id: entry[1], script: entry[2] }));
}

const jobs = jobBlocks(workflow);
const CAMPAIGN_JOBS = ["campaign", "pi-compatibility", "mutation-experiment"];

/**
 * The hard job-level budget of the release-gates job. GitHub enforces the
 * ceiling, and a green run must fit the head acceptance (seven gates plus
 * journeys) inside the budget on the slowest hosted runners observed; a
 * 45-minute budget killed a fully green run mid-stage. The proposed-merge
 * acceptance and the CRAP trend refresh run in parallel jobs with their own
 * bounds, and finalize-report joins them.
 */
function releaseGateBudget(source) {
  const block = jobBlocks(source)["release-gates"];
  assert.ok(block, "release-gates job must exist");
  const bound = block.match(/^ {4}timeout-minutes: (\d+)$/mu);
  assert.ok(bound, "release-gates must set timeout-minutes");
  const minutes = Number(bound[1]);
  assert.ok(minutes >= 60 && minutes <= 360,
    `release-gates budget must stay hard-bound between 60 and 360 minutes, got ${minutes}`);
  return minutes;
}

test("release-gates requires every PR stage and allows only non-applicable skips", () => {
  const block = jobs["release-gates"];
  assert.ok(block, "release-gates job must exist");
  assert.equal(jobCondition(block), "${{ !cancelled() }}");
  assert.match(block, /^ {4}needs: \[head-acceptance, acceptance-merge, crap-trend, finalize-report\]$/mu);
  assert.doesNotMatch(workflow, /evidence-preflight|evidence-rebind|change-evidence\.json|release-evidence\.json/u);
  releaseGateBudget(workflow);

  const runBlock = block.match(/      - name: Require release stages for this event to succeed\n[\s\S]*?        run: \|\n((?:          .*\n)+)/u)?.[1];
  assert.ok(runBlock, "release-gates must keep its event-aware stage check");
  const script = runBlock.split("\n").filter(Boolean).map((line) => line.slice(10)).join("\n") + "\n";
  const run = (eventName, merge, report) => spawnSync("bash", ["-e"], { input: script, encoding: "utf8", env: {
    ...process.env, GITHUB_EVENT_NAME: eventName, HEAD_RESULT: "success", CRAP_RESULT: "success",
    MERGE_RESULT: merge, REPORT_RESULT: report,
  } });
  assert.equal(run("pull_request", "success", "success").status, 0);
  assert.notEqual(run("pull_request", "skipped", "success").status, 0, "a skipped proposed-merge check must fail PR release-gates");
  assert.equal(run("push", "skipped", "skipped").status, 0, "merge/report skips are non-applicable on pushes");
  assert.notEqual(run("push", "failure", "skipped").status, 0, "a failed non-applicable stage must still fail");

  // Seven release gates, checked against both declaring modules.
  assert.deepEqual(requiredGatesFrom(ciReportSource), [
    "preflight", "unit", "typecheck", "router-build",
    "pinned-pi-integration", "pinned-pi-ui", "pinned-pi-reliability-ui",
  ]);
  assert.deepEqual(releaseGateScriptsFrom(verifyReleaseSource), [
    { id: "unit", script: "test" },
    { id: "typecheck", script: "typecheck" },
    { id: "router-build", script: "build:router" },
    { id: "pinned-pi-integration", script: "test:integration" },
    { id: "pinned-pi-ui", script: "test:ui" },
    { id: "pinned-pi-reliability-ui", script: "test:ui:reliability" },
  ]);
  assert.match(mergeEligibilitySource, /const REQUIRED_JOB = "release-gates";/u);

  // Ordinary PR/push/manual-default execution path stays intact. The head
  // acceptance publishes the acceptance evidence uploads; the required
  // release-gates check waits for every required stage.
  const head = jobs["head-acceptance"];
  assert.ok(head, "head-acceptance job must exist");
  assert.match(head, /id: acceptance\n/u);
  assert.match(head, /run: npm run acceptance\n/u);
  assert.match(head, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u, "push acceptance must check out the event SHA");
  assert.match(workflow, /branches: \[main\]/u, "push verification runs only on main");
  assert.match(head, /name: ci-report-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(head, /name: head-report-data-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
});

test("a failed release stage turns the required release-gates check red", () => {
  const block = jobs["release-gates"];
  assert.ok(block, "release-gates job must exist");
  const weakened = block.replace("echo \"$name: $result (failing the required release-gates check)\"; fail=1", "echo \"$name: $result\"");
  assert.notEqual(weakened, block, "the fault must remove the stage-gate failure");
  assert.throws(() => assert.match(weakened, /failing the required release-gates check/u),
    "every failed release stage must fail the required check");
});

test("exactly one release-gates job exists per run", () => {
  assert.equal([...workflow.matchAll(/^ {2}release-gates:$/gmu)].length, 1,
    "merge-controller binds exactly one release-gates job per run and attempt");
});

test("the proposed-merge acceptance runs beside release-gates", () => {
  const block = jobs["acceptance-merge"];
  assert.ok(block, "acceptance-merge job must exist");
  assert.equal(jobCondition(block), "${{ !cancelled() && github.event_name == 'pull_request' }}");
  assert.match(block, /ref: \$\{\{ github\.ref \}\}/u, "the merge job must check out the proposed merge ref");
  assert.match(block, /id: merge-acceptance\n/u);
  assert.match(block, /run: npm run acceptance:deterministic\n/u);
  assert.match(block, /name: merge-result-evidence-\$\{\{ github\.sha \}\}/u);
  // The merge controller binds the artifact to exactly one successful upload
  // step by name across the run; the names must stay unique workflow-wide.
  assert.equal([...workflow.matchAll(/^ {6}- name: Upload acceptance evidence$/gmu)].length, 1);
  assert.equal([...workflow.matchAll(/^ {6}- name: Upload merge-result evidence$/gmu)].length, 1);

  const weakened = block.replace("run: npm run acceptance:deterministic", "run: npm run acceptance");
  assert.notEqual(weakened, block, "the fault must rewrite the merge acceptance command");
  assert.throws(() => assert.match(weakened, /run: npm run acceptance:deterministic\n/u),
    "the merge acceptance must stay on the deterministic profile");
});

test("the CRAP trend refresh runs beside the gates", () => {
  const block = jobs["crap-trend"];
  assert.ok(block, "crap-trend job must exist");
  assert.match(block, /npm run test:coverage/u);
  assert.match(block, /node scripts\/crap-report\.mjs --record --history/u);
  assert.match(block, /name: crap-history-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
});

test("finalize-report joins the parallel evidence into the candidate report", () => {
  const block = jobs["finalize-report"];
  assert.ok(block, "finalize-report job must exist");
  assert.equal(jobCondition(block), "${{ !cancelled() && github.event_name == 'pull_request' }}");
  assert.match(block, /^ {4}needs: \[head-acceptance, acceptance-merge, crap-trend\]$/mu);
  assert.match(block, /RELEASE_RESULT: \$\{\{ needs\.head-acceptance\.result == 'success' && needs\.acceptance-merge\.result == 'success' && needs\.crap-trend\.result == 'success' && 'success' \|\| 'failure' \}\}/u);
  assert.match(block, /name: head-report-data-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(block, /name: crap-history-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(block, /name: acceptance-report-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(block, /name: final-ci-report-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-run-\$\{\{ github\.run_id \}\}-attempt-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(block, /renderCiReport\(data, \{/u);
  assert.match(block, /appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY, markdown\);/u);

  // A failed acceptance job must still render a failure report, never skip it.
  const skipping = block.replaceAll("        continue-on-error: true\n", "");
  assert.notEqual(skipping, block, "the fault must remove the tolerant artifact downloads");
  assert.throws(() => assert.match(skipping, /continue-on-error: true/u),
    "artifact downloads must stay tolerant so a failed acceptance still renders");
});

test("campaign jobs never run on ordinary PR, push, or default manual dispatch", () => {
  assert.deepEqual(Object.keys(jobs), ["head-acceptance", "acceptance-merge", "crap-trend", "finalize-report", "release-gates", "campaign", "pi-compatibility", "mutation-experiment"]);
  const cases = [
    ["pull_request", {}],
    ["push", {}],
    ["workflow_dispatch", { campaign: "default", mutation: false, campaign_repeats: "3", campaign_seed: "1729" }],
    ["workflow_dispatch", {}],
  ];
  for (const job of CAMPAIGN_JOBS) {
    const condition = jobCondition(jobs[job]);
    assert.ok(condition, `${job} must carry an explicit if: condition`);
    for (const [eventName, inputs] of cases) {
      assert.equal(runsFor(condition, eventName, inputs), false, `${job} must not run for ${eventName} ${JSON.stringify(inputs)}`);
    }
    assert.doesNotMatch(condition, /pull_request/u, `${job} must not opt itself into pull_request runs`);
  }
});

test("expanded mode is opt-in: campaign and compatibility run only when dispatched as expanded or scheduled", () => {
  const expandedInputs = { campaign: "expanded", mutation: false, campaign_repeats: "3", campaign_seed: "1729" };
  for (const job of ["campaign", "pi-compatibility"]) {
    const condition = jobCondition(jobs[job]);
    assert.equal(runsFor(condition, "workflow_dispatch", expandedInputs), true, `${job} must run for expanded dispatch`);
    assert.equal(runsFor(condition, "schedule", {}), true, `${job} must run for the bounded schedule`);
    assert.equal(runsFor(condition, "workflow_dispatch", { ...expandedInputs, campaign: "default" }), false);
  }
  const mutation = jobCondition(jobs["mutation-experiment"]);
  assert.equal(runsFor(mutation, "workflow_dispatch", { mutation: true }), true, "mutation stays a separate manual opt-in");
  assert.equal(runsFor(mutation, "workflow_dispatch", { mutation: false, campaign: "expanded" }), false, "expanded mode must not silently enable mutation");
  assert.equal(runsFor(mutation, "schedule", {}), false, "the schedule must not pay for mutation");
});

test("dispatch inputs default to the ordinary path with bounded campaign values", () => {
  assert.match(workflow, /^ {2}workflow_dispatch:\n/mu);
  assert.match(workflow, /^ {6}campaign:\n(?:.*\n)*?^ {8}default: default$/mu);
  assert.match(workflow, /^ {6}mutation:\n(?:.*\n)*?^ {8}default: false$/mu);
  assert.match(workflow, /^ {6}campaign_repeats:\n(?:.*\n)*?^ {8}default: "3"$/mu);
  assert.match(workflow, /^ {6}campaign_seed:\n(?:.*\n)*?^ {8}default: "1729"$/mu);
  assert.match(workflow, /^ {8}options:\n(?:.*\n)*?^ {10}- default\n(?:.*\n)*?^ {10}- expanded$/mu);

  // The workflow hands its inputs to the bounded runner through the job env
  // (no user input interpolated into shell text) and validates them first.
  const campaign = jobs["campaign"];
  assert.match(campaign, /^ {4}env:\n {6}CAMPAIGN_REPEATS: \$\{\{ inputs\.campaign_repeats \|\| '3' \}\}\n {6}CAMPAIGN_SEED: \$\{\{ inputs\.campaign_seed \|\| '1729' \}\}$/mu);
  assert.match(campaign, /--validate-only/u, "campaign bounds must be validated before any run");
  assert.match(campaign, /--repeat "\$CAMPAIGN_REPEATS"/u);
  assert.match(campaign, /--seed-base "\$CAMPAIGN_SEED"/u);
  assert.match(campaign, /--out "\$RUNNER_TEMP\//u);
});

test("Pi compatibility uses explicit matrix pins with an isolated install", () => {
  const block = jobs["pi-compatibility"];
  const matrix = block.match(/strategy:\n[\t ]*fail-fast[^\n]*\n[\t ]*matrix:\n[\t ]*pi:\n((?:[\t ]+- .+\n)+)/u);
  assert.ok(matrix, "compatibility matrix must declare pi pins");
  assert.deepEqual([...matrix[1].matchAll(/^[\t ]+- "([^"]+)"$/gmu)].map((entry) => entry[1]), ["1.3.0", "1.4.0"]);
  assert.match(block, /npm install --no-save --package-lock=false/u, "install must not edit tracked dependency files");
  assert.match(block, /if \[ "\$PI_VERSION" != "1\.4\.0" \]; then\n[\s\S]*?npm install[\s\S]*?\n          fi/u, "baseline must retain npm ci locked transitive dependencies");
  assert.match(block, /@earendil-works\/pi-ai@\$PI_VERSION/u);
  assert.match(block, /@earendil-works\/pi-coding-agent@\$PI_VERSION/u);
  assert.doesNotMatch(block, /@(latest|\*|next|beta)/u, "compatibility installs must not float");
  assert.match(block, /git status --porcelain/u, "the job must prove tracked files stayed untouched");
  assert.match(block, /npm run typecheck\n/u);
  assert.match(block, /tests\/router-package\.test\.mjs/u, "installed-package consumer test must run");
  assert.match(block, /tests\/integration\/native-classifier\.test\.mjs/u, "native SDK/process tests must run");
  assert.doesNotMatch(block, /verify:release/u, "the pinned verify-release preflight is not an alternate-version oracle");
});

test("release-gates keeps a hard budget that fits every release stage", () => {
  assert.ok(releaseGateBudget(workflow) >= 60,
    "release-gates must budget at least 60 minutes for the four release stages");
});

test("every parallel release job keeps a hard job-level bound", () => {
  const bounds = { "acceptance-merge": 60, "crap-trend": 30, "finalize-report": 10 };
  for (const [job, ceiling] of Object.entries(bounds)) {
    const bound = jobs[job].match(/^ {4}timeout-minutes: (\d+)$/mu);
    assert.ok(bound, `${job} must set timeout-minutes`);
    const minutes = Number(bound[1]);
    assert.ok(minutes >= 1 && minutes <= ceiling, `${job} bound must stay within ${ceiling} minutes, got ${minutes}`);
  }
});

test("fault control: a 45-minute release-gates budget turns the named budget assertion red", () => {
  const shrunk = workflow.replace(/(^ {2}release-gates:$[\s\S]*?^ {4}timeout-minutes: )60/mu, "$145");
  assert.notEqual(shrunk, workflow, "the fault must rewrite the release-gates budget");
  assert.throws(() => releaseGateBudget(shrunk),
    /release-gates budget must stay hard-bound between 60 and 360 minutes/u);
});

test("every campaign job keeps a hard job-level bound", () => {
  for (const job of CAMPAIGN_JOBS) {
    const bound = jobs[job].match(/^ {4}timeout-minutes: (\d+)$/mu);
    assert.ok(bound, `${job} must set timeout-minutes`);
    assert.ok(Number(bound[1]) >= 1 && Number(bound[1]) <= 60, `${job} bound must stay within 60 minutes, got ${bound[1]}`);
  }
});

test("the schedule is bounded to one daily run and needs no secrets", () => {
  const schedule = workflow.match(/^ {2}schedule:\n((?: {4}.*\n)+)/mu);
  assert.ok(schedule, "workflow must declare a schedule");
  const crons = [...schedule[1].matchAll(/^\s+- cron: "(.+)"$/gmu)].map((entry) => entry[1]);
  assert.equal(crons.length, 1, "exactly one bounded nightly entry");
  assert.match(crons[0], /^\d+ \d+ \* \* \*$/u, "a single daily cron");
  const [minute, hour] = crons[0].split(" ").map(Number);
  assert.ok(hour >= 0 && hour <= 23, "cron hour must be valid");
  assert.notEqual(minute, 0, "avoid the documented top-of-hour load window");
  assert.doesNotMatch(workflow, /secrets\./u, "campaign jobs must not consume repository secrets");
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu, "permissions stay read-only");
});

test("verification campaign docs state the default-branch schedule boundary", () => {
  const doc = readFileSync(new URL("../docs/verification-campaign.md", import.meta.url), "utf8");
  assert.match(doc, /default branch/u, "docs must explain where scheduled runs execute");
  assert.match(doc, /Scheduled workflows will only run\s+on the default branch/u, "docs must quote the only-default-branch rule");
  assert.match(doc, /`v2` is not the default branch/u, "docs must state that v2 is not the default branch");
  assert.match(doc, /pending/u, "docs must state pending activation");
  assert.match(doc, /no\s+active\s+cron/u, "docs must not claim a live nightly run");
});

test("reliability campaign includes the receipt state machine", () => {
  const command = jobs.campaign.split("- name: Reliability replay-control campaign")[1]?.split("- name:")[0];
  assert.ok(command, "reliability campaign command must exist");
  assert.match(command, /node scripts\/campaign-run\.mjs/u, "reliability campaign must use the bounded runner");
  assert.match(command, /^ {10}tests\/reliability-v2-state-machine\.test\.ts$/mu,
    "reliability campaign must execute the receipt state machine");
});
