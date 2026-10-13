import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_REPORT_BYTES, makeReportData, renderCiReport, writeCiReport } from "../scripts/ci-report.mjs";
import {
  COMMENT_MARKER,
  createGitHubApi,
  publishWorkflowRun,
  reportArtifactName,
  readReportDataDirectory,
  validateArtifactMetadata,
  validateReportData,
} from "../scripts/ci-report-publish.mjs";

test("reports a bounded GitHub permission error without logging a token", async () => {
  const api = createGitHubApi({
    token: "fixture-secret",
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: "Permission denied\nby GitHub" }) }),
  });
  await assert.rejects(api.createIssueComment("iamaamir/pi-bifrost", 35, "test"), /GitHub comment request failed \(403\): Permission denied by GitHub\./);
});

const headSha = "a".repeat(40);
const workflowPath = ".github/workflows/verification.yml@main";
const gates = ["preflight", "unit", "typecheck", "router-build", "pinned-pi-integration", "pinned-pi-ui", "pinned-pi-reliability-ui"];

function reportData() {
  return {
    schemaVersion: 1,
    evidence: {
      schemaVersion: 1,
      profile: "deterministic",
      startedAt: "2026-10-12T10:00:00Z",
      endedAt: "2026-10-12T10:04:00Z",
      exitCode: 0,
      source: {
        revisionAtStart: headSha,
        revisionAtEnd: headSha,
        fingerprintAtStart: "f".repeat(64),
        fingerprintAtEnd: "f".repeat(64),
        dirtyPathsAtStart: [],
        dirtyPathsAtEnd: [],
        changedDuringRun: false,
      },
      toolVersions: { runtime: { node: "v24" } },
      cases: [
        ...gates.map((id, index) => ({ order: index + 1, id: `gate:${id}`, requirements: ["R16"], boundary: "release gate", status: "passed", required: true, startedAt: "2026-10-12T10:00:00Z", endedAt: "2026-10-12T10:00:01Z", durationMs: 1000, attempts: index === 0 ? [{ durationMs: 10, result: "passed" }] : 1, exclusions: [], artifacts: [] })),
        { order: 8, id: "journey:first-use", requirements: ["R03"], boundary: "physical Pi RPC", status: "passed", required: true, startedAt: "2026-10-12T10:00:00Z", endedAt: "2026-10-12T10:00:01Z", durationMs: 1000, attempts: "passed once", exclusions: [], artifacts: [] },
      ],
    },
  };
}

function fixture({ action = "completed", attempt = 1, head = headSha, prHead = headSha, conclusion = "success", pullRepository = "fork-owner/pi-bifrost", mutateBeforeFinalCheck } = {}) {
  const prNumber = 41;
  const run = {
    id: 9001,
    run_attempt: attempt,
    head_sha: head,
    head_branch: "feature/report",
    head_repository: { full_name: pullRepository },
    workflow_id: 77,
    run_number: 14,
    path: workflowPath,
    event: "pull_request",
    status: action === "in_progress" ? "in_progress" : "completed",
    conclusion: action === "in_progress" ? null : conclusion,
    pull_requests: [],
    repository: { full_name: "iamaamir/pi-bifrost" },
  };
  const pr = {
    number: prNumber,
    base: { repo: { full_name: "iamaamir/pi-bifrost" } },
    head: { sha: prHead, ref: "feature/report", repo: { full_name: pullRepository } },
  };
  const calls = { create: [], update: [], comments: [], headLookups: [] };
  const state = { run, pr, comments: [], workflows: [run], linkedPulls: [], headPulls: [pr] };
  const api = {
    async getRun() { return structuredClone(state.run); },
    async getPullRequest() { return structuredClone(state.pr); },
    async listWorkflowRuns() { return structuredClone(state.workflows); },
    async listPullRequestsForCommit() { return structuredClone(state.linkedPulls); },
    async listOpenPullRequestsByHead(_repo, owner, branch) {
      calls.headLookups.push({ owner, branch });
      return structuredClone(state.headPulls);
    },
    async listIssueComments() {
      calls.comments.push(true);
      if (mutateBeforeFinalCheck) mutateBeforeFinalCheck(state);
      return structuredClone(state.comments);
    },
    async createIssueComment(_repo, number, body) {
      const comment = { id: 81, issue: number, body };
      calls.create.push(comment);
      return comment;
    },
    async updateIssueComment(_repo, id, body) {
      const comment = { id, body };
      calls.update.push(comment);
      return comment;
    },
  };
  const event = {
    action,
    repository: { full_name: "iamaamir/pi-bifrost" },
    workflow_run: {
      id: run.id,
      run_attempt: attempt,
      head_sha: head,
      event: "pull_request",
      repository: { full_name: "iamaamir/pi-bifrost" },
      pull_requests: [],
    },
  };
  return { api, event, calls, state, report: reportData(), repository: "iamaamir/pi-bifrost" };
}

test("creates one candidate-bound comment for a fork PR after all release gates pass", async () => {
  const value = fixture();
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "published");
  assert.equal(result.results[0].status, "created");
  assert.equal(result.results[0].confidence, "VERIFIED CHECKS");
  assert.equal(value.calls.create.length, 1);
  assert.deepEqual(value.calls.headLookups, [{ owner: "fork-owner", branch: "feature/report" }]);
  assert.match(value.calls.create[0].body, /Workflow run/);
  assert.equal(value.calls.create[0].body.includes("fork-owner"), false);
});

test("ignores a fork head lookup whose SHA no longer matches the run", async () => {
  const value = fixture();
  value.state.headPulls[0].head.sha = "b".repeat(40);
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "ignored");
  assert.equal(value.calls.create.length, 0);
});

test("keeps closing provenance when a failing report exceeds the old comment cap", async () => {
  const value = fixture({ conclusion: "failure" });
  value.report.evidence.cases.push(...Array.from({ length: 8 }, (_, index) => ({
    id: `failure-${index}-${"@".repeat(180)}`,
    status: "failed",
    required: true,
    detail: "@".repeat(2_000),
    artifacts: Array(30).fill("`".repeat(1_000)),
  })));
  value.report.evidence.cases.push(...Array.from({ length: 200 }, (_, index) => ({
    id: `deferred-${index}-${"@".repeat(180)}`,
    status: "deferred",
    required: false,
    boundary: "@".repeat(300),
  })));
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "published");
  const body = value.calls.create[0].body;
  assert.ok(Buffer.byteLength(body) > 10_000);
  assert.ok(Buffer.byteLength(body) <= 65_000);
  assert.match(body, /and 27 more in the workflow artifact/u);
  assert.match(body, /PR controls the workflow producer and test code/u);
  assert.ok(body.endsWith("</details>\n"));
});

test("updates only a marker comment owned by github-actions[bot]", async () => {
  const value = fixture();
  value.state.comments = [
    { id: 2, body: COMMENT_MARKER, user: { login: "human", type: "User" } },
    { id: 8, body: `${COMMENT_MARKER}\nold`, user: { login: "github-actions[bot]", type: "Bot" } },
  ];
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "published");
  assert.equal(result.results[0].status, "updated");
  assert.equal(value.calls.update.length, 1);
  assert.equal(value.calls.update[0].id, 8);
  assert.equal(value.calls.create.length, 0);
});

test("rejects an old run attempt and a changed PR head before writing", async () => {
  const oldAttempt = fixture({ attempt: 1 });
  oldAttempt.state.run.run_attempt = 2;
  oldAttempt.state.workflows = [{ ...oldAttempt.state.run }];
  const oldResult = await publishWorkflowRun({ ...oldAttempt, serverUrl: "https://github.com", reportData: oldAttempt.report });
  assert.equal(oldResult.status, "stale");
  assert.equal(oldAttempt.calls.create.length, 0);

  const changedHead = fixture({ mutateBeforeFinalCheck(state) { state.pr.head.sha = "b".repeat(40); } });
  const changedResult = await publishWorkflowRun({ ...changedHead, serverUrl: "https://github.com", reportData: changedHead.report });
  assert.equal(changedResult.status, "stale");
  assert.equal(changedHead.calls.create.length, 0);
});

test("rejects a run that is no longer the latest verification run for this PR", async () => {
  const value = fixture();
  value.state.workflows.push({ ...value.state.run, id: 9002, run_number: 15 });
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "stale");
  assert.equal(value.calls.create.length, 0);
});

test("creates a low-confidence incomplete report when report data is missing", async () => {
  const value = fixture({ conclusion: "cancelled" });
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", artifactError: "The named report artifact is missing." });
  assert.equal(result.status, "published");
  assert.equal(result.results[0].confidence, "BLOCKED");
  assert.match(value.calls.create[0].body, /concluded cancelled/i);
  assert.match(value.calls.create[0].body, /INCOMPLETE|MISSING/);
});

test("rejects spoofed repository association and malformed evidence", async () => {
  const wrongRepository = fixture();
  wrongRepository.event.repository.full_name = "attacker/fork";
  const result = await publishWorkflowRun({ ...wrongRepository, serverUrl: "https://github.com", reportData: wrongRepository.report });
  assert.equal(result.status, "ignored");
  assert.equal(wrongRepository.calls.create.length, 0);

  const badReport = reportData();
  badReport.evidence.cases[0].artifacts = ["../../hostile.md"];
  const safe = validateReportData(badReport);
  assert.ok(safe);
  const rendered = renderCiReport(safe, { trusted: true, sha: headSha, runId: 9001, repository: "iamaamir/pi-bifrost", serverUrl: "https://github.com", conclusion: "success" }).markdown;
  assert.equal(rendered.includes("](../../hostile.md)"), false, "artifact paths remain inert text, never links");
});

test("rejects malformed source provenance before publishing a verified report", async () => {
  const corruptions = [
    (source) => { source.revisionAtStart = "garbage"; },
    (source) => { source.fingerprintAtEnd = "garbage"; },
    (source) => { source.changedDuringRun = "false"; },
  ];
  for (const corrupt of corruptions) {
    const value = fixture();
    corrupt(value.report.evidence.source);
    assert.equal(validateReportData(value.report), null);
    const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
    assert.equal(result.status, "published");
    assert.notEqual(result.results[0].confidence, "VERIFIED CHECKS");
    assert.match(value.calls.create[0].body, /INCOMPLETE|MISSING|BLOCKED/u);
  }
});

test("shared renderer never verifies the wrong SHA, limited profile, duplicate IDs, or required deferred cases", () => {
  const context = { trusted: true, sha: headSha, runId: 9001, attempt: 1, repository: "iamaamir/pi-bifrost", serverUrl: "https://github.com", conclusion: "success" };
  const wrongSha = reportData();
  wrongSha.evidence.source.revisionAtStart = "b".repeat(40);
  wrongSha.evidence.source.revisionAtEnd = "b".repeat(40);
  assert.equal(renderCiReport(makeReportData(wrongSha.evidence), context).confidence.state, "BLOCKED");

  const contract = reportData();
  contract.evidence.profile = "contract";
  assert.equal(renderCiReport(makeReportData(contract.evidence), context).confidence.state, "LIMITED");

  const deferred = reportData();
  deferred.evidence.cases[7].status = "deferred";
  assert.equal(renderCiReport(makeReportData(deferred.evidence), context).confidence.state, "BLOCKED");

  const duplicate = reportData();
  duplicate.evidence.cases[7].id = duplicate.evidence.cases[0].id;
  assert.equal(renderCiReport(makeReportData(duplicate.evidence), context).confidence.state, "BLOCKED");
});

test("renders untrusted case strings as inert table text and neutralizes mentions", async () => {
  const value = fixture();
  value.report.evidence.cases[7].boundary = "tier | <img src=x> @all";
  value.report.evidence.cases[7].status = "failed";
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "published");
  const body = value.calls.create[0].body;
  assert.equal(body.includes("@all"), false);
  assert.equal(body.includes("<img src=x>"), false);
  assert.equal(body.includes("@all"), false);
});

test("validates only the exact SHA, run, and attempt artifact name and report directory shape", () => {
  const identity = { headSha, runId: 9001, runAttempt: 2 };
  const artifact = { id: 3, name: reportArtifactName(identity), expired: false, size_in_bytes: 900, workflow_run: { id: 9001, head_sha: headSha } };
  assert.equal(artifact.name, `acceptance-report-${headSha}-run-9001-attempt-2`);
  assert.equal(validateArtifactMetadata([artifact], identity), artifact);
  assert.equal(validateArtifactMetadata([{ ...artifact, name: reportArtifactName({ ...identity, runAttempt: 1 }) }], identity), null);
  assert.equal(validateArtifactMetadata([{ ...artifact, name: reportArtifactName({ ...identity, runId: 9002 }) }], identity), null);
  assert.equal(validateArtifactMetadata([{ ...artifact, workflow_run: { id: 99, head_sha: headSha } }], identity), null);
  assert.equal(validateArtifactMetadata([{ ...artifact, size_in_bytes: 2 * 1024 * 1024 }], identity), null);
  assert.equal(validateArtifactMetadata([artifact], { ...identity, runAttempt: 0 }), null);

  const root = mkdtempSync(join(tmpdir(), "bifrost-report-"));
  try {
    writeFileSync(join(root, "report-data.json"), JSON.stringify(reportData()));
    assert.equal(validateReportData(readReportDataDirectory(root))?.evidence.profile, "deterministic");
    writeFileSync(join(root, "ci-report.md"), "Untrusted rendered Markdown is ignored.");
    assert.equal(readReportDataDirectory(root), undefined, "publisher input artifact stays JSON-only");
    rmSync(join(root, "ci-report.md"));
    writeFileSync(join(root, "extra.txt"), "ignored files must reject the artifact");
    assert.equal(readReportDataDirectory(root), undefined);
    rmSync(join(root, "report-data.json"));
    rmSync(join(root, "extra.txt"));
    const payload = join(root, "report-data.json");
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(reportData()));
    symlinkSync(outside, payload);
    assert.equal(readReportDataDirectory(root), undefined);
    rmSync(payload);
    rmSync(outside);
    mkdirSync(join(root, "2026-10-12T10-00-00-000Z"));
    writeFileSync(join(root, "2026-10-12T10-00-00-000Z", "report-data.json"), JSON.stringify(reportData()));
    assert.equal(validateReportData(readReportDataDirectory(root))?.evidence.profile, "deterministic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every accepted report fits the publisher's file limit", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-report-limit-"));
  try {
    const evidence = reportData().evidence;
    evidence.cases = Array.from({ length: 200 }, (_, index) => ({
      id: `case-${index}`,
      status: "passed",
      detail: "x".repeat(2_000),
    }));
    const output = writeCiReport({ evidence, outputDir: root });
    assert.ok(readFileSync(output.dataPath).byteLength <= MAX_REPORT_BYTES);
    assert.ok(readReportDataDirectory(root) === undefined, "publisher input stays JSON-only");
    rmSync(output.markdownPath);
    assert.ok(readReportDataDirectory(root));

    evidence.cases = Array.from({ length: 300 }, (_, index) => ({
      id: `case-${index}`,
      status: "passed",
      detail: "x".repeat(2_000),
    }));
    assert.throws(() => makeReportData(evidence), /size limit/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending workflow_run activity updates the existing report without trusting artifacts", async () => {
  const value = fixture({ action: "in_progress" });
  value.state.comments = [{ id: 18, body: COMMENT_MARKER, user: { login: "github-actions[bot]", type: "Bot" } }];
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: { malicious: true } });
  assert.equal(result.status, "published");
  assert.equal(result.results[0].confidence, "INCOMPLETE");
  assert.match(value.calls.update[0].body, /PENDING/);
  assert.equal(value.calls.update[0].body.includes("malicious"), false);
});

test("late in-progress event cannot overwrite a completed attempt", async () => {
  const value = fixture({ action: "in_progress" });
  value.state.run.status = "completed";
  value.state.run.conclusion = "success";
  value.state.workflows = [{ ...value.state.run }];
  const result = await publishWorkflowRun({ ...value, serverUrl: "https://github.com", reportData: value.report });
  assert.equal(result.status, "stale");
  assert.equal(value.calls.update.length + value.calls.create.length, 0);
});
