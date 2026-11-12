import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateEligibility, fetchProposedMergeIdentity, getReviewThreads, parseDependencies, revalidateEligibilityBinding, runEvidence, workflowHashesMatch } from "../scripts/merge-eligibility.mjs";

const SCRIPT = new URL("../scripts/merge-eligibility.mjs", import.meta.url).pathname;
const E40_HEAD = "a".repeat(40);
const E40_BASE = "b".repeat(40);
const E40_TREE = "c".repeat(40);
const E40_PROPOSED = "d".repeat(40);

// Deterministic injected `gh`: every GitHub interaction of the eligibility CLI
// is served from a JSON world file so controls are exact and offline.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const world = JSON.parse(fs.readFileSync(process.env.FAKE_GH_WORLD, "utf8"));
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
function save() { fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world)); }
function out(v) { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); }
function die(code) { process.stderr.write(code + "\\n"); process.exit(1); }
const joined = args.join(" ");
if (args[0] === "repo" && args[1] === "view") out({ nameWithOwner: world.repo });
if (args[0] === "pr" && args[1] === "view") {
  let pr = world.pr;
  if (world.headSequence && world.headSequence.length) {
    pr = { ...pr, headRefOid: world.headSequence.shift() ?? pr.headRefOid };
    save();
  }
  if (world.baseSequence && world.baseSequence.length) {
    pr = { ...pr, baseRefOid: world.baseSequence.shift() ?? pr.baseRefOid };
    save();
  }
  out(pr);
}
if (args[0] === "api") {
  if (joined.includes("actions/workflows/verification.yml")) {
    if (world.workflowRaw !== undefined) { process.stdout.write(world.workflowRaw); process.exit(0); }
    out({ id: world.workflowId ?? 123 });
  }
  if (joined.includes("contents/")) out({ sha: world.workflowSha ?? "1".repeat(40) });
  if (joined.includes("/runs?head_sha=")) {
    const runs = world.ciRuns ?? [];
    out({ total_count: world.ciRunsTotal ?? runs.length, workflow_runs: runs });
  }
  if (joined.includes("/jobs?")) {
    const jobs = world.jobs ?? [];
    out({ total_count: world.jobsTotal ?? jobs.length, jobs });
  }
  if (joined.includes("/reviews")) out((world.reviews ?? []).map((r) => JSON.stringify({ state: r.state, user: { login: r.author }, commit_id: r.commit_id, submitted_at: r.submitted_at })).join("\\n"));
  if (args.includes("graphql")) {
    if (world.endlessThreads) {
      world.threadCalls = (world.threadCalls ?? 0) + 1; save();
      if (world.threadCalls > 30) die("thread pagination cap reached without an implemented bound");
      out({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ isResolved: true }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-" + world.threadCalls },
      } } } } });
    } else {
      out({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: world.threads ?? [], pageInfo: { hasNextPage: false, endCursor: null },
      } } } } });
    }
  }
  if (joined.match(/\\/pulls\\/\\d+$/)) out(world.pull ?? { merge_commit_sha: "d".repeat(40) });
  if (joined.match(/\\/commits\\/[0-9a-f]+$/)) {
    world.commitCalls = (world.commitCalls ?? 0) + 1; save();
    const sha = joined.match(/\\/commits\\/([0-9a-f]+)$/)[1];
    const commit = (world.commits ?? {})[sha];
    if (!commit) die("unknown commit");
    if (world.treeSequence && world.commitCalls >= 2) out({ parents: commit.parents, commit: { tree: { sha: world.treeSequence } } });
    out(commit);
  }
  if (joined.match(/\\/issues\\/\\d+$/)) {
    const n = Number(joined.match(/\\/issues\\/(\\d+)$/)[1]);
    out(world.issues?.[n] ?? { number: n, state: "CLOSED" });
  }
  die("unhandled api: " + joined);
}
die("unhandled: " + joined);
`;

function eligibilityWorld(overrides = {}) {
  return {
    repo: "org/repo",
    pr: { headRefOid: E40_HEAD, baseRefName: "v2", baseRefOid: E40_BASE, isDraft: false, body: "Refs #41", author: { login: "author-bot" } },
    workflowId: 123,
    ciRuns: [{ id: 10, run_attempt: 1, head_sha: E40_HEAD, event: "pull_request", workflow_id: 123,
      path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-01T00:00:00Z" }],
    jobs: [{ name: "release-gates", conclusion: "success" }],
    reviews: [{ state: "APPROVED", author: "reviewer", commit_id: E40_HEAD, submitted_at: "2026-01-01T00:00:00Z" }],
    threads: [],
    pull: { merge_commit_sha: E40_PROPOSED },
    commits: { [E40_PROPOSED]: { parents: [{ sha: E40_BASE }, { sha: E40_HEAD }], commit: { tree: { sha: E40_TREE } } } },
    ...overrides,
  };
}

const eligibilityCleanups = [];
test.after(() => eligibilityCleanups.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scaffoldEligibility(world = eligibilityWorld()) {
  const dir = mkdtempSync(join(tmpdir(), "me-fixture-"));
  eligibilityCleanups.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const worldPath = join(dir, "world.json");
  const logPath = join(dir, "gh.log");
  writeFileSync(worldPath, JSON.stringify(world));
  return { dir, bin, worldPath, logPath };
}

function runEligibility(fixture, script = SCRIPT) {
  const { GITHUB_REPOSITORY: _githubRepository, ...inheritedEnv } = process.env;
  const env = { ...inheritedEnv, PATH: fixture.bin + ":" + process.env.PATH, FAKE_GH_WORLD: fixture.worldPath, FAKE_GH_LOG: fixture.logPath };
  const result = spawnSync(process.execPath, [script, "1"], { encoding: "utf8", env, timeout: 60_000 });
  const calls = existsSync(fixture.logPath) ? readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* non-JSON */ }
  return { ...result, calls, json };
}

const head = "abc123";
const valid = {
  pr: {
    headRefOid: head, baseRefName: "v2", baseRefOid: "base456", isDraft: false, author: { login: "author" },
    body: "Refs #41",
  },
  workflowFileMatchesBase: true,
  workflowRuns: [{
    head_sha: head, event: "pull_request", workflow_path: ".github/workflows/verification.yml",
    conclusion: "success", jobs: [{ name: "release-gates", conclusion: "success" }],
  }],
  reviews: [{ state: "APPROVED", author: "reviewer", commit_id: head, submitted_at: "2026-01-02" }],
  reviewThreads: [],
  dependencies: [],
};

function evaluate(patch = {}) {
  return evaluateEligibility({ ...valid, ...patch, pr: { ...valid.pr, ...patch.pr } });
}

test("requires successful release-gates from trusted workflow on exact head", () => {
  for (const workflowRuns of [
    [{ ...valid.workflowRuns[0], jobs: [{ name: "CodeRabbit", conclusion: "success" }] }],
    [{ ...valid.workflowRuns[0], head_sha: "stale" }],
    [{ ...valid.workflowRuns[0], workflow_path: ".github/workflows/other.yml" }],
    [{ ...valid.workflowRuns[0], event: "push" }],
    [{ ...valid.workflowRuns[0], conclusion: "failure" }],
  ]) assert.equal(evaluate({ workflowRuns }).eligible, false);
  assert.equal(evaluate({ workflowFileMatchesBase: false }).eligible, false);
  assert.equal(evaluate().eligible, true);
});

test("ordinary comments do not replace an active review decision", () => {
  assert.equal(evaluate({ reviews: [
    { state: "CHANGES_REQUESTED", author: "reviewer-a", commit_id: "old", submitted_at: "2026-01-01" },
    { state: "COMMENTED", author: "reviewer-a", commit_id: head, submitted_at: "2026-01-03" },
    { state: "APPROVED", author: "reviewer-b", commit_id: head, submitted_at: "2026-01-02" },
  ] }).eligible, false);
  assert.equal(evaluate({ reviews: [
    { state: "APPROVED", author: "reviewer-a", commit_id: head, submitted_at: "2026-01-01" },
    { state: "COMMENTED", author: "reviewer-a", commit_id: head, submitted_at: "2026-01-03" },
    { state: "APPROVED", author: "reviewer-b", commit_id: head, submitted_at: "2026-01-02" },
  ] }).eligible, true);
});

test("uses latest effective review per reviewer and blocks active change requests across revisions", () => {
  const oldRequestThenOtherApproval = [
    { state: "CHANGES_REQUESTED", author: "reviewer-a", commit_id: "old", submitted_at: "2026-01-01" },
    { state: "APPROVED", author: "reviewer-b", commit_id: head, submitted_at: "2026-01-02" },
  ];
  assert.equal(evaluate({ reviews: oldRequestThenOtherApproval }).eligible, false);
  assert.equal(evaluate({ reviews: [
    ...oldRequestThenOtherApproval,
    { state: "DISMISSED", author: "reviewer-a", commit_id: head, submitted_at: "2026-01-03" },
  ] }).eligible, true);
  assert.equal(evaluate({ reviewThreads: [{ isResolved: false }] }).eligible, false);
  assert.equal(evaluate({ reviewThreads: [{ isResolved: true }] }).eligible, true);
});

test("rejects missing author identity and unknown draft state", () => {
  assert.equal(evaluate({ pr: { author: null } }).eligible, false);
  assert.equal(evaluate({ pr: { isDraft: undefined } }).eligible, false);
  assert.equal(evaluate({ pr: { isDraft: true } }).eligible, false);
});

test("requires issue reference and all declared dependencies to be integrated into v2", () => {
  // Real `gh pr view --json state` shape for a merged PR is state:"MERGED".
  const merged = { kind: "pr", number: 35, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", base: "v2", integrated: true };
  assert.equal(evaluate({ dependencies: [merged] }).eligible, true);
  assert.equal(evaluate({ dependencies: [{ ...merged, state: "CLOSED" }] }).eligible, true);
  for (const dependency of [
    { ...merged, state: "OPEN", mergedAt: undefined },
    { ...merged, mergedAt: undefined },
    { ...merged, base: "main" },
    { ...merged, integrated: false },
    { ...merged, state: "WEIRD" },
    { kind: "issue", number: 37, state: "OPEN" },
    { kind: "unknown", number: 37 },
  ]) assert.equal(evaluate({ dependencies: [dependency] }).eligible, false);
});

test("parses every dependency in lists and GitHub URLs; rejects unknown declaration syntax", () => {
  assert.deepEqual(parseDependencies("Dependencies: #35, https://github.com/org/repo/pull/36"), [
    { kind: "ref", number: 35 }, { kind: "pr", number: 36, repo: "org/repo" },
  ]);
  assert.deepEqual(parseDependencies("Depends on #37"), [{ kind: "ref", number: 37 }]);
  assert.deepEqual(parseDependencies("Dependencies:\n- https://github.com/org/repo/issues/40"), [
    { kind: "issue", number: 40, repo: "org/repo" },
  ]);
  assert.throws(() => parseDependencies("Dependencies: #35 and maybe #36"), /unsupported dependency syntax/);
});

test("fails closed when review or required-check data is unknown", () => {
  assert.equal(evaluate({ reviews: undefined }).eligible, false);
  assert.equal(evaluate({ workflowRuns: undefined }).eligible, false);
  assert.equal(evaluate({ reviewThreads: undefined }).eligible, false);
});

test("selects newest workflow run before selecting same-run rerun attempt", () => {
  const jobs = [{ name: "release-gates", conclusion: "success" }];
  const mock = (args) => {
    if (args.some((arg) => arg.includes("actions/workflows/123/runs"))) return { total_count: 2, workflow_runs: [
      { id: 10, run_attempt: 2, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-01T00:00:00Z" },
      { id: 20, run_attempt: 1, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "failure", created_at: "2026-01-02T00:00:00Z" },
    ] };
    return { total_count: jobs.length, jobs };
  };
  assert.deepEqual(runEvidence("org/repo", 123, head, mock), [{
    head_sha: head, event: "pull_request", workflow_path: ".github/workflows/verification.yml",
    conclusion: "failure", jobs,
  }]);
  const sameRun = (args) => args.some((arg) => arg.includes("actions/workflows/123/runs"))
    ? { total_count: 2, workflow_runs: [
      { id: 30, run_attempt: 1, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "failure", created_at: "2026-01-03T00:00:00Z" },
      { id: 30, run_attempt: 2, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-03T00:00:00Z" },
    ] } : { total_count: jobs.length, jobs };
  assert.equal(runEvidence("org/repo", 123, head, sameRun)[0].conclusion, "success");
});

test("run and job inventories fail closed when the explicit first-100 page is incomplete", () => {
  const run = { id: 10, run_attempt: 1, head_sha: head, event: "pull_request", workflow_id: 123,
    path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-01T00:00:00Z" };
  const runPage = (total_count) => (args) => args.some((arg) => arg.includes("actions/workflows/123/runs"))
    ? { total_count, workflow_runs: [run] }
    : { total_count: 1, jobs: [{ name: "release-gates", conclusion: "success" }] };
  for (const total_count of [undefined, null, 150]) {
    assert.throws(() => runEvidence("org/repo", 123, head, runPage(total_count)),
      /workflow run inventory incomplete or exceeds bound/, `total_count=${total_count}`);
  }
  const jobsPage = (args) => args.some((arg) => arg.includes("actions/workflows/123/runs"))
    ? { total_count: 1, workflow_runs: [run] }
    : { total_count: 150, jobs: [{ name: "release-gates", conclusion: "success" }] };
  assert.throws(() => runEvidence("org/repo", 123, head, jobsPage), /workflow job inventory incomplete or exceeds bound/);
});

test("workflow comparison fails closed for absent or invalid content hashes", () => {
  const hash = "a".repeat(40);
  assert.equal(workflowHashesMatch({ sha: hash }, { sha: hash }), true);
  for (const pair of [
    [{}, {}],
    [{}, { sha: hash }],
    [{ sha: "" }, { sha: hash }],
    [{ sha: "not-a-github-sha" }, { sha: hash }],
    [{ sha: hash }, {}],
    [{ sha: hash }, { sha: "b".repeat(39) }],
  ]) assert.equal(workflowHashesMatch(...pair), false);
});

test("review-thread pagination requires explicit valid page metadata", () => {
  for (const reviewThreads of [
    { nodes: [] },
    { nodes: [], pageInfo: { hasNextPage: false } },
  ]) assert.throws(() => getReviewThreads("org/repo", 48, () => ({ data: { repository: { pullRequest: {
    reviewThreads,
  } } } })), /Review thread pagination unavailable/);
  let calls = 0;
  const pages = [
    { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } } },
    { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false, endCursor: null } } } } } },
  ];
  const threads = getReviewThreads("org/repo", 48, () => pages[calls++]);
  assert.deepEqual(threads, [{ isResolved: true }, { isResolved: false }]);
});

test("review-thread pagination rejects repeated cursors before requesting a page again", () => {
  for (const cursors of [["cursor-1", "cursor-1"], ["cursor-1", "cursor-2", "cursor-1"]]) {
    let calls = 0;
    assert.throws(() => getReviewThreads("org/repo", 48, () => {
      assert.ok(calls < cursors.length, "pagination requested a repeated page");
      return { data: { repository: { pullRequest: { reviewThreads: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: cursors[calls++] },
      } } } } };
    }), /Review thread pagination unavailable/);
    assert.equal(calls, cursors.length);
  }
});

test("review-thread pagination fails closed at the explicit default page bound", () => {
  let calls = 0;
  assert.throws(() => getReviewThreads("org/repo", 48, () => {
    if (++calls > 50) throw new Error("mock page cap reached before any implemented bound");
    return { data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ isResolved: true }], pageInfo: { hasNextPage: true, endCursor: "cursor-" + calls },
    } } } } };
  }), /Review thread pagination exceeds page bound/);
  assert.equal(calls, 10, "default page bound must stop pagination after exactly 10 requests");
});

test("review-thread pagination fails closed when one page exceeds the item count bound", () => {
  const nodes = Array.from({ length: 1001 }, () => ({ isResolved: true }));
  let calls = 0;
  assert.throws(() => getReviewThreads("org/repo", 48, () => {
    calls++;
    return { data: { repository: { pullRequest: { reviewThreads: {
      nodes, pageInfo: { hasNextPage: false, endCursor: null },
    } } } } };
  }), /Review thread item count exceeds bound/);
  assert.equal(calls, 1, "count overflow must fail closed on the overflowing page itself");
});

test("review-thread pagination fails closed when its time bound elapses", () => {
  let clock = 0;
  const now = () => (clock += 1000);
  let calls = 0;
  assert.throws(() => getReviewThreads("org/repo", 48, () => {
    if (++calls > 50) throw new Error("mock page cap reached before any implemented time bound");
    return { data: { repository: { pullRequest: { reviewThreads: {
      nodes: [{ isResolved: true }], pageInfo: { hasNextPage: true, endCursor: "cursor-" + calls },
    } } } } };
  }, { now, deadlineMs: 1500 }), /Review thread pagination exceeds time bound/);
  assert.equal(calls, 1, "elapsed deadline must stop pagination before the next page");
});

test("truncated run inventory and endless review-thread pagination fail closed in the CLI", () => {
  const truncated = runEligibility(scaffoldEligibility(eligibilityWorld({ ciRunsTotal: 150 })));
  assert.equal(truncated.status, 1, JSON.stringify({ stdout: truncated.stdout, stderr: truncated.stderr }));
  assert.match(truncated.stderr, /Eligibility check failed closed: workflow run inventory incomplete or exceeds bound/);

  const endless = runEligibility(scaffoldEligibility(eligibilityWorld({ endlessThreads: true })));
  assert.equal(endless.status, 1, JSON.stringify({ stdout: endless.stdout, stderr: endless.stderr }));
  assert.match(endless.stderr, /Eligibility check failed closed: Review thread pagination exceeds page bound/);
  const threadPages = endless.calls.filter((call) => call.includes("graphql")).length;
  assert.equal(threadPages, 10, "CLI must not request more than the explicit page bound");
});

test("CLI main-module detection works when script path contains spaces", () => {
  const temp = mkdtempSync(join(tmpdir(), "merge-eligibility-cli-"));
  try {
    const spacedDir = join(temp, "directory with spaces");
    mkdirSync(spacedDir);
    const script = join(spacedDir, "merge eligibility.mjs");
    copyFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url), script);
    chmodSync(script, 0o755);
    const scrubbedEnv = { ...process.env };
    delete scrubbedEnv.GH_TOKEN;
    delete scrubbedEnv.GITHUB_TOKEN;
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: scrubbedEnv });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node scripts\/merge-eligibility\.mjs/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("dependency parse failures throw a fixed diagnostic without echoing PR body text", () => {
  const payload = "\u001b]0;pwned\u0007PWNED-BODY-TOKEN";
  assert.throws(() => parseDependencies(`Refs #41\nDependencies: ${payload} and #42`), (error) =>
    error.message === "unsupported dependency syntax"
    && !error.message.includes("PWNED-BODY-TOKEN")
    && !error.message.includes("\u001b")
    && !error.message.includes("and"));
});

test("terminal control PR-body text never reaches terminal diagnostics", () => {
  const world = eligibilityWorld({
    pr: { headRefOid: E40_HEAD, baseRefName: "v2", baseRefOid: E40_BASE, isDraft: false, author: { login: "author-bot" },
      body: "Refs #41\nDependencies: PWNED-BODY-TOKEN\u001b]0;evil\u0007 and #42" },
  });
  const result = runEligibility(scaffoldEligibility(world));
  assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.match(result.stderr, /Eligibility check failed closed: unsupported dependency syntax/);
  assert.doesNotMatch(result.stderr, /PWNED-BODY-TOKEN/u);
  assert.doesNotMatch(result.stdout, /PWNED-BODY-TOKEN/u);
  assert.doesNotMatch(result.stderr, /\u001b/u);
});

test("malformed GitHub JSON carrying untrusted text never reaches terminal diagnostics", () => {
  const world = eligibilityWorld({ workflowRaw: "PWNED-JSON-TOKEN\u001b]0;evil\u0007 not json" });
  const result = runEligibility(scaffoldEligibility(world));
  assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.match(result.stderr, /Eligibility check failed closed: GitHub response was not valid JSON/);
  assert.doesNotMatch(result.stderr, /PWNED-JSON-TOKEN/u);
  assert.doesNotMatch(result.stderr, /\u001b/u);
});

function bindingQuery({ freshPr = { headRefOid: E40_HEAD, baseRefName: "v2", baseRefOid: E40_BASE }, parents = null, mergeSha = E40_PROPOSED, commitTrees = null } = {}) {
  let reads = 0;
  return (args) => {
    const joined = args.join(" ");
    if (args[0] === "pr") return freshPr;
    if (/\/pulls\/1$/.test(joined)) return { merge_commit_sha: mergeSha };
    if (joined.includes("/commits/")) {
      reads++;
      const tree = commitTrees ? commitTrees[Math.min(reads - 1, commitTrees.length - 1)] : E40_TREE;
      return { parents: parents ?? [{ sha: E40_BASE }, { sha: E40_HEAD }], commit: { tree: { sha: tree } } };
    }
    throw new Error(`unexpected revalidation query: ${joined}`);
  };
}

const expectedBinding = { head: E40_HEAD, base: E40_BASE, baseRefName: "v2" };

test("final revalidation returns no blocker when head, base, and proposed identity are unchanged", () => {
  const query = bindingQuery();
  const initial = fetchProposedMergeIdentity("org/repo", 1, query);
  assert.equal(revalidateEligibilityBinding({ repo: "org/repo", number: 1, expected: expectedBinding, initial, query }), null);
});

test("final revalidation blocks when head or base moved after evaluation", () => {
  for (const freshPr of [
    { headRefOid: "9".repeat(40), baseRefName: "v2", baseRefOid: E40_BASE },
    { headRefOid: E40_HEAD, baseRefName: "v2", baseRefOid: "8".repeat(40) },
    { headRefOid: E40_HEAD, baseRefName: "main", baseRefOid: E40_BASE },
  ]) {
    const query = bindingQuery({ freshPr });
    const initial = fetchProposedMergeIdentity("org/repo", 1, query);
    assert.equal(revalidateEligibilityBinding({ repo: "org/repo", number: 1, expected: expectedBinding, initial, query }),
      "PR head or base changed during eligibility revalidation");
  }
});

test("final revalidation blocks a proposed tree that differs between evidence and revalidation", () => {
  const query = bindingQuery({ commitTrees: [E40_TREE, "e".repeat(40)] });
  const initial = fetchProposedMergeIdentity("org/repo", 1, query);
  assert.equal(revalidateEligibilityBinding({ repo: "org/repo", number: 1, expected: expectedBinding, initial, query }),
    "proposed merge identity changed during eligibility revalidation");
});

test("final revalidation blocks proposed parents that do not match current base and head", () => {
  const query = bindingQuery({ parents: [{ sha: E40_HEAD }, { sha: E40_BASE }] });
  const initial = fetchProposedMergeIdentity("org/repo", 1, query);
  assert.equal(revalidateEligibilityBinding({ repo: "org/repo", number: 1, expected: expectedBinding, initial, query }),
    "proposed merge does not match current base and head");
});

test("final revalidation blocks unavailable proposed-merge identity", () => {
  const initial = null;
  const query = bindingQuery();
  assert.equal(revalidateEligibilityBinding({ repo: "org/repo", number: 1, expected: expectedBinding, initial, query }),
    "proposed merge identity unavailable");
  const malformed = bindingQuery({ mergeSha: "not-a-sha" });
  const validInitial = fetchProposedMergeIdentity("org/repo", 1, bindingQuery());
  assert.equal(revalidateEligibilityBinding({ repo: "org/repo", number: 1, expected: expectedBinding, initial: validInitial, query: malformed }),
    "proposed merge identity unavailable");
});

test("CLI re-fetches head, base, and proposed identity before returning eligible", () => {
  const result = runEligibility(scaffoldEligibility(eligibilityWorld()));
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.json.eligible, true);
  const prViews = result.calls.filter((call) => call[0] === "pr" && call[1] === "view" && call.some((arg) => typeof arg === "string" && arg.startsWith("headRefOid,baseRefName,baseRefOid")));
  assert.equal(prViews.length, 2, "eligibility must re-fetch the PR before returning");
  const proposedReads = result.calls.filter((call) => call[0] === "api" && /\/pulls\/1$/.test(call.at(-1))).length;
  assert.equal(proposedReads, 2, "eligibility must re-read proposed-merge identity before returning");
});

for (const [control, sequence] of [["head", { headSequence: [E40_HEAD, "9".repeat(40)] }], ["base", { baseSequence: [E40_BASE, "8".repeat(40)] }]]) {
  test(`CLI control: ${control} movement after evaluation fails closed`, () => {
    const result = runEligibility(scaffoldEligibility(eligibilityWorld(sequence)));
    assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.json.eligible, false);
    assert.ok(result.json.blockers.includes("PR head or base changed during eligibility revalidation"),
      JSON.stringify(result.json.blockers));
  });
}

test("CLI control: proposed tree mismatch between evidence and revalidation fails closed", () => {
  const result = runEligibility(scaffoldEligibility(eligibilityWorld({ treeSequence: "e".repeat(40) })));
  assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.json.eligible, false);
  assert.ok(result.json.blockers.includes("proposed merge identity changed during eligibility revalidation"),
    JSON.stringify(result.json.blockers));
});

test("guard removal control: disabling final revalidation reddens the movement assertion, restore is green", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const guard = "if (drift) outcome = { ...result, eligible: false, blockers: [...result.blockers, drift] };";
  assert.ok(source.includes(guard), "final revalidation guard must exist in the eligibility source");
  const movementWorld = () => eligibilityWorld({ headSequence: [E40_HEAD, "9".repeat(40)] });
  const baseline = runEligibility(scaffoldEligibility(movementWorld()));
  assert.equal(baseline.status, 1, "head movement must fail closed through the real CLI");
  assert.ok(baseline.json.blockers.includes("PR head or base changed during eligibility revalidation"));

  const mutant = source.replace(guard, "if (false) outcome = { ...result, eligible: false, blockers: [...result.blockers, drift] };");
  assert.notEqual(mutant, source, "mutant must differ from the tested source");
  const dir = mkdtempSync(join(tmpdir(), "me-mutant-"));
  eligibilityCleanups.push(dir);
  const copy = join(dir, "merge-eligibility-copy.mjs");
  writeFileSync(copy, mutant);
  const bypass = runEligibility(scaffoldEligibility(movementWorld()), copy);
  assert.equal(bypass.stderr, "", "disabled guard must reach the CLI acceptance boundary rather than import failure");
  assert.equal(bypass.status, 0, bypass.stdout);
  assert.equal(bypass.json.eligible, true, "mutant must accept moved head");
  assert.throws(() => assert.ok(bypass.json.blockers.includes("PR head or base changed during eligibility revalidation"),
    `head movement must fail closed through the real CLI: ${JSON.stringify(bypass.json.blockers)}`), /head movement must fail closed/u);

  writeFileSync(copy, source);
  assert.equal(createHash("sha256").update(readFileSync(copy)).digest("hex"), sourceHash);
  const restored = runEligibility(scaffoldEligibility(movementWorld()), copy);
  assert.equal(restored.status, 1, restored.stdout);
  assert.ok(restored.json.blockers.includes("PR head or base changed during eligibility revalidation"));
  assert.equal(createHash("sha256").update(readFileSync(SCRIPT)).digest("hex"), sourceHash, "tested source must stay untouched");
});
