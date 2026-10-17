import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateEligibility, getReviewThreads, parseDependencies, runEvidence, workflowHashesMatch } from "../scripts/merge-eligibility.mjs";

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
    if (args.some((arg) => arg.includes("actions/workflows/123/runs"))) return { workflow_runs: [
      { id: 10, run_attempt: 2, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-01T00:00:00Z" },
      { id: 20, run_attempt: 1, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "failure", created_at: "2026-01-02T00:00:00Z" },
    ] };
    return { jobs };
  };
  assert.deepEqual(runEvidence("org/repo", 123, head, mock), [{
    head_sha: head, event: "pull_request", workflow_path: ".github/workflows/verification.yml",
    conclusion: "failure", jobs,
  }]);
  const sameRun = (args) => args.some((arg) => arg.includes("actions/workflows/123/runs"))
    ? { workflow_runs: [
      { id: 30, run_attempt: 1, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "failure", created_at: "2026-01-03T00:00:00Z" },
      { id: 30, run_attempt: 2, head_sha: head, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-03T00:00:00Z" },
    ] } : { jobs };
  assert.equal(runEvidence("org/repo", 123, head, sameRun)[0].conclusion, "success");
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
