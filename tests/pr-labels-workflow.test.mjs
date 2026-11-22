// PR-label router regression tests.
//
// The router must run exactly one check when its label is applied, rerun every
// still-labeled check on a new commit, ignore unrelated labels, and never run
// PR code with a privileged trigger. The reusable workflows must measure the PR
// head and keep the commands that used to live in verification.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const workflowDir = new URL("../.github/workflows/", import.meta.url);
const read = (name) => readFileSync(new URL(name, workflowDir), "utf8");
const router = read("pr-labels.yml");
const verification = read("verification.yml");
const campaign = read("campaign.yml");
const compatibility = read("pi-compatibility.yml");
const mutation = read("mutation.yml");

const ROUTES = [
  { job: "campaign", label: "ci:campaign", reusable: "campaign.yml", timeout: 30 },
  { job: "pi-compatibility", label: "ci:pi-compatibility", reusable: "pi-compatibility.yml", timeout: 20 },
  { job: "mutation", label: "ci:mutation", reusable: "mutation.yml", timeout: null },
];

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

const jobs = jobBlocks(router);

/** The router's folded `if: >-` block becomes one expression after YAML folding. */
function conditionFor(job) {
  const match = jobs[job].match(/^ {4}if: >-\n((?: {6}.*\n)+)/mu);
  assert.ok(match, `${job} must carry a folded if: condition`);
  return match[1].trim().replace(/\s+/gu, " ");
}

/**
 * Parse the two supported condition arms into data. Any other shape fails the
 * test, so a workflow edit cannot silently change routing semantics.
 */
function routeArms(job) {
  const arms = conditionFor(job).split(" || ").map((arm) => arm.trim().replace(/^\((.*)\)$/u, "$1"));
  assert.equal(arms.length, 2, `${job} must have a labeled arm and a synchronize arm`);
  return arms.map((arm) => {
    const parts = arm.split(" && ").map((part) => part.trim());
    assert.equal(parts.length, 2, `${job}: each arm must guard an action and a label`);
    const action = parts[0].match(/^github\.event\.action == '([a-z_]+)'$/u)?.[1];
    assert.ok(action, `${job}: unsupported action guard ${parts[0]}`);
    const labeled = parts[1].match(/^github\.event\.label\.name == '([^']+)'$/u);
    const attached = parts[1].match(/^contains\(github\.event\.pull_request\.labels\.\*\.name, '([^']+)'\)$/u);
    assert.ok(labeled || attached, `${job}: unsupported label check ${parts[1]}`);
    return { action, label: (labeled ?? attached)[1], match: labeled ? "new-label" : "attached-label" };
  });
}

function runsFor(job, { action, label, labels = [] }) {
  return routeArms(job).some((arm) =>
    action === arm.action && (arm.match === "new-label" ? label === arm.label : labels.includes(arm.label)));
}

test("the router uses only a read-only pull_request trigger", () => {
  assert.match(router, /^on:\n {2}pull_request:\n {4}types: \[labeled, synchronize\]$/mu);
  assert.doesNotMatch(router, /pull_request_target/u);
  assert.match(router, /^permissions:\n {2}contents: read$/mu);
  assert.doesNotMatch(router, /^concurrency:/mu, "no workflow-wide group may cancel a sibling check");
});

test("each check owns a per-PR concurrency group", () => {
  const groups = ROUTES.map((route) => {
    const block = jobs[route.job];
    const expected = "    group: pr-labels-" + route.job + "-${{ github.event.pull_request.number }}";
    assert.ok(block.includes(expected), `${route.job} must own a per-PR group`);
    assert.match(block, /^ {6}cancel-in-progress: true$/mu);
    return block.match(/^ {6}group: (.+)$/mu)[1];
  });
  assert.equal(new Set(groups).size, groups.length, "no two checks may share a group");
});

test("each route declares a labeled and a synchronize arm for its own label", () => {
  for (const route of ROUTES) {
    const arms = routeArms(route.job);
    assert.deepEqual(arms.map((arm) => arm.action), ["labeled", "synchronize"]);
    assert.deepEqual(arms.map((arm) => arm.match), ["new-label", "attached-label"]);
    assert.deepEqual(arms.map((arm) => arm.label), [route.label, route.label]);
  }
});

test("applying a label runs only its own job", () => {
  for (const route of ROUTES) {
    for (const candidate of ROUTES) {
      const runs = runsFor(candidate.job, { action: "labeled", label: route.label, labels: [route.label] });
      assert.equal(runs, candidate.job === route.job,
        `${route.label} must run ${candidate.job} only when it matches`);
    }
  }
});

test("an unrelated label never reruns an attached check", () => {
  const attached = ROUTES.map((route) => route.label);
  for (const route of ROUTES) {
    assert.equal(runsFor(route.job, { action: "labeled", label: "documentation", labels: attached }), false,
      `${route.job} must not rerun when an unrelated label is added`);
  }
});

test("a new commit reruns every still-labeled check", () => {
  const all = ROUTES.map((route) => route.label);
  for (const route of ROUTES) {
    assert.equal(runsFor(route.job, { action: "synchronize", labels: all }), true,
      `${route.job} must rerun when its label is still attached`);
    assert.equal(runsFor(route.job, { action: "synchronize", labels: [] }), false,
      `${route.job} must not run after its label was removed`);
  }
  assert.equal(runsFor("campaign", { action: "synchronize", labels: ["ci:mutation"] }), false);
});

test("every routed check measures the PR head through a reusable workflow", () => {
  for (const route of ROUTES) {
    assert.match(jobs[route.job], new RegExp(`uses: \\./\\.github/workflows/${route.reusable.replace(".", "\\.")}`));
    const source = read(route.reusable);
    assert.match(source, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
      `${route.reusable} must check out the head, not the merge ref`);
  }
  assert.doesNotMatch(router, /pull_request_target/u);
});

test("campaign and compatibility are call-only; mutation keeps its schedule and dispatch", () => {
  assert.match(campaign, /^on:\n {2}workflow_call:/mu);
  assert.doesNotMatch(campaign, /^ {2}(push|pull_request|schedule|workflow_dispatch):/mu);
  assert.match(compatibility, /^on:\n {2}workflow_call:/mu);
  assert.doesNotMatch(compatibility, /^ {2}(push|pull_request|schedule|workflow_dispatch):/mu);
  assert.match(mutation, /^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "\d+ \d+ \* \* \*"$/mu);
  assert.match(mutation, /^ {2}workflow_call:/mu);
  assert.match(mutation, /^ {2}workflow_dispatch:/mu);
  assert.doesNotMatch(mutation, /^ {2}(pull_request|push):/mu);
});

test("verification keeps its gates and delegates the extracted jobs", () => {
  assert.match(verification, /uses: \.\/\.github\/workflows\/campaign\.yml/u);
  assert.match(verification, /uses: \.\/\.github\/workflows\/pi-compatibility\.yml/u);
  const verificationJobs = jobBlocks(verification);
  for (const job of ["campaign", "pi-compatibility"]) {
    assert.match(verificationJobs[job],
      /if: github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.campaign == 'expanded'\)/u,
      `${job} must keep its opt-in condition`);
    assert.doesNotMatch(verificationJobs[job], /\b(uses: actions\/checkout|run: npm ci)/u,
      "caller jobs must not duplicate the extracted steps");
  }
  assert.match(verificationJobs["release-gates"],
    /^ {4}needs: \[head-acceptance, acceptance-merge, crap-trend, finalize-report\]$/mu);
});

test("extracted commands exist once and keep their bounds", () => {
  const campaignCommands = ["--validate-only", "--name properties", "--name reliability", "--name integration"];
  for (const command of campaignCommands) {
    assert.ok(campaign.includes(command), `${command} must stay in campaign.yml`);
    assert.equal(verification.includes(command), false, `${command} must not be duplicated in verification.yml`);
  }
  assert.match(compatibility, /npm install --no-save --package-lock=false/u);
  assert.doesNotMatch(verification, /npm install --no-save --package-lock=false/u);
  assert.match(campaign, /^ {4}timeout-minutes: 30$/mu);
  assert.match(compatibility, /^ {4}timeout-minutes: 20$/mu);
  assert.match(mutation, /node mutation\/run\.mjs "\$TARGET"/u);
});

test("the temporary PoC workflow is gone", () => {
  assert.equal(existsSync(new URL("pr-campaign.yml", workflowDir)), false);
});
