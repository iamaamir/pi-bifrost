#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_CASES, MAX_REPORT_BYTES, makeReportData, renderCiReport } from "./ci-report.mjs";

export const COMMENT_MARKER = "<!-- bifrost-acceptance-report:v1 -->";
const WORKFLOW_PATH = ".github/workflows/verification.yml";
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const isFingerprint = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const safeRepo = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

export function validateReportData(payload) {
  const evidence = isObject(payload?.evidence) ? payload.evidence : payload;
  if (!Array.isArray(evidence?.cases) || evidence.cases.length > MAX_CASES) return null;
  try {
    const data = makeReportData(evidence);
    if (data?.evidence?.profile !== "deterministic") return null;
    const source = data.evidence.source;
    if (!isSha(source.revisionAtStart) || !isSha(source.revisionAtEnd)
        || !isFingerprint(source.fingerprintAtStart) || !isFingerprint(source.fingerprintAtEnd)
        || typeof source.changedDuringRun !== "boolean") return null;
    return data;
  } catch { return null; }
}

function sameRun(left, right) {
  return left.id === right.id && left.run_attempt === right.run_attempt && left.head_sha === right.head_sha
    && left.workflow_id === right.workflow_id && left.path === right.path;
}

async function assertCurrent({ api, repo, initialRun, prNumber }) {
  const [run, pr, candidates] = await Promise.all([
    api.getRun(repo, initialRun.id),
    api.getPullRequest(repo, prNumber),
    api.listWorkflowRuns(repo, initialRun.workflow_id, initialRun.head_sha),
  ]);
  if (!sameRun(run, initialRun) || run.path?.split("@")[0] !== WORKFLOW_PATH || run.event !== "pull_request") return null;
  if (pr.base?.repo?.full_name !== repo || pr.head?.sha !== run.head_sha || pr.head?.ref !== run.head_branch
      || pr.head?.repo?.full_name !== run.head_repository?.full_name) return null;
  const related = candidates.filter((candidate) => candidate.event === "pull_request" && candidate.path?.split("@")[0] === WORKFLOW_PATH);
  related.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  if (!related.length || related[0].id !== run.id || related[0].run_attempt !== run.run_attempt) return null;
  return { run, pr };
}

export async function publishWorkflowRun({ event, repository, serverUrl, api, reportData, artifactError }) {
  const eventRun = event?.workflow_run;
  if (!safeRepo(repository) || event?.repository?.full_name !== repository || !isObject(eventRun)
      || eventRun.event !== "pull_request"
      || !Number.isSafeInteger(eventRun.id) || !Number.isSafeInteger(eventRun.run_attempt)
      || !isSha(eventRun.head_sha) || (eventRun.pull_requests !== undefined && !Array.isArray(eventRun.pull_requests))) return { status: "ignored", reason: "The run event lacks trusted workflow metadata." };
  if (!new Set(["in_progress", "completed"]).has(event.action)) return { status: "ignored", reason: "Unsupported workflow_run activity." };
  const initialRun = await api.getRun(repository, eventRun.id);
  if (initialRun.id !== eventRun.id || initialRun.run_attempt !== eventRun.run_attempt || initialRun.head_sha !== eventRun.head_sha
      || initialRun.path?.split("@")[0] !== WORKFLOW_PATH || initialRun.event !== "pull_request"
      || !Number.isSafeInteger(initialRun.workflow_id) || !Number.isSafeInteger(initialRun.run_number)
      || (event.action === "completed" && initialRun.status !== "completed")
      || (event.action === "in_progress" && initialRun.status !== "in_progress")
      || (initialRun.repository?.full_name && initialRun.repository.full_name !== repository)) return { status: "stale", reason: "Workflow run metadata no longer matches the event." };
  const linkedPulls = await api.listPullRequestsForCommit(repository, initialRun.head_sha);
  const headRepository = initialRun.head_repository?.full_name;
  const headOwner = safeRepo(headRepository) ? headRepository.split("/")[0] : null;
  const fallbackPulls = !linkedPulls?.length && headOwner && initialRun.head_branch
    ? await api.listOpenPullRequestsByHead(repository, headOwner, initialRun.head_branch)
    : [];
  const linkedNumbers = new Set([...(linkedPulls ?? []), ...fallbackPulls.filter((item) => item.head?.sha === initialRun.head_sha && item.base?.repo?.full_name === repository)]
    .map((item) => item.number).filter(Number.isSafeInteger));
  const eventNumbers = (eventRun.pull_requests ?? []).map((item) => item?.number).filter(Number.isSafeInteger);
  const targets = [...new Set(eventNumbers.length ? eventNumbers.filter((number) => linkedNumbers.has(number)) : [...linkedNumbers])].slice(0, 10);
  if (!targets.length) return { status: "ignored", reason: "GitHub has no PR whose base repository and head SHA match this run." };
  const report = event.action === "completed" && !artifactError ? validateReportData(reportData) : null;
  const results = [];
  for (const prNumber of targets) {
    const confirmed = await assertCurrent({ api, repo: repository, initialRun, prNumber });
    if (!confirmed) { results.push({ status: "stale", prNumber }); continue; }
    const rendered = renderCiReport(report, {
      trusted: true,
      sha: confirmed.run.head_sha,
      runId: confirmed.run.id,
      attempt: confirmed.run.run_attempt,
      repository,
      serverUrl,
      conclusion: event.action === "in_progress" ? "in_progress" : confirmed.run.conclusion ?? "failure",
      crapHistory: Array.isArray(reportData?.crapHistory) ? reportData.crapHistory : undefined,
    });
    const body = `${COMMENT_MARKER}\n${rendered.markdown}`;
    if (Buffer.byteLength(body) > 65_000) throw new Error("Rendered CI report exceeds the GitHub comment limit");
    const comments = await api.listIssueComments(repository, prNumber);
    const existing = comments.filter((comment) => comment.user?.login === "github-actions[bot]"
      && comment.user?.type === "Bot" && typeof comment.body === "string" && comment.body.includes(COMMENT_MARKER))
      .sort((a, b) => a.id - b.id)[0];
    const finalState = await assertCurrent({ api, repo: repository, initialRun, prNumber });
    if (!finalState || finalState.run.status !== confirmed.run.status || finalState.run.conclusion !== confirmed.run.conclusion) {
      results.push({ status: "stale", prNumber });
      continue;
    }
    const comment = existing
      ? await api.updateIssueComment(repository, existing.id, body)
      : await api.createIssueComment(repository, prNumber, body);
    const confidence = rendered.confidence.state;
    results.push({ status: existing ? "updated" : "created", confidence, commentId: comment.id, prNumber });
  }
  return { status: results.some((item) => item.status === "created" || item.status === "updated") ? "published" : "stale", results };
}

export function reportArtifactName({ headSha, runId, runAttempt }) {
  if (!isSha(headSha) || !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1) return null;
  return `acceptance-report-${headSha}-run-${runId}-attempt-${runAttempt}`;
}

export function validateArtifactMetadata(artifacts, { runId, headSha, runAttempt }) {
  const expectedName = reportArtifactName({ headSha, runId, runAttempt });
  if (!expectedName) return null;
  const matches = (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => artifact.name === expectedName);
  if (matches.length !== 1) return null;
  const [artifact] = matches;
  if (!Number.isSafeInteger(artifact.id) || artifact.expired || !Number.isSafeInteger(artifact.size_in_bytes)
      || artifact.size_in_bytes > MAX_ARCHIVE_BYTES || artifact.workflow_run?.id !== runId
      || artifact.workflow_run?.head_sha !== headSha) return null;
  return artifact;
}

export function readReportDataDirectory(directory) {
  try {
    const names = readdirSync(directory);
    let path;
    if (names.length === 1 && names[0] === "report-data.json") path = join(directory, names[0]);
    else if (names.length === 1 && /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(names[0])) {
      const child = join(directory, names[0]);
      if (!lstatSync(child).isDirectory()) return undefined;
      const childNames = readdirSync(child);
      if (childNames.length !== 1 || childNames[0] !== "report-data.json") return undefined;
      path = join(child, childNames[0]);
    } else return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return undefined; }
}

export function createGitHubApi({ token, apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com", fetchImpl = fetch }) {
  const base = apiBase.replace(/\/$/, "");
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
  const repoPath = (repo) => repo.split("/").map(encodeURIComponent).join("/");
  const getJson = async (path) => {
    const response = await fetchImpl(`${base}${path}`, { headers });
    if (!response.ok) throw new Error(`GitHub API request failed (${response.status}).`);
    return response.json();
  };
  const requestComment = async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const reason = typeof detail?.message === "string" ? `: ${detail.message.replace(/[\r\n]/g, " ").slice(0, 200)}` : "";
      throw new Error(`GitHub comment request failed (${response.status})${reason}.`);
    }
    return response.json();
  };
  return {
    getRun: (repo, id) => getJson(`/repos/${repoPath(repo)}/actions/runs/${id}`),
    getPullRequest: (repo, number) => getJson(`/repos/${repoPath(repo)}/pulls/${number}`),
    async listWorkflowRuns(repo, workflowId, sha) {
      const result = await getJson(`/repos/${repoPath(repo)}/actions/workflows/${workflowId}/runs?head_sha=${encodeURIComponent(sha)}&event=pull_request&per_page=100`);
      return result.workflow_runs ?? [];
    },
    async listPullRequestsForCommit(repo, sha) {
      const rows = await getJson(`/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`);
      return Array.isArray(rows) ? rows : [];
    },
    async listOpenPullRequestsByHead(repo, owner, branch) {
      const rows = await getJson(`/repos/${repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
      return Array.isArray(rows) ? rows : [];
    },
    async listArtifacts(repo, runId) {
      const result = await getJson(`/repos/${repoPath(repo)}/actions/runs/${runId}/artifacts?per_page=100`);
      return result.artifacts ?? [];
    },
    async listIssueComments(repo, number) {
      const comments = [];
      for (let page = 1; page <= 10; page++) {
        const rows = await getJson(`/repos/${repoPath(repo)}/issues/${number}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error("GitHub returned an invalid comment list.");
        comments.push(...rows);
        if (rows.length < 100) return comments;
      }
      return comments;
    },
    createIssueComment: (repo, number, body) => requestComment("POST", `/repos/${repoPath(repo)}/issues/${number}/comments`, body),
    updateIssueComment: (repo, id, body) => requestComment("PATCH", `/repos/${repoPath(repo)}/issues/comments/${id}`, body),
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  if (!token || !safeRepo(repository)) throw new Error("Publisher is missing trusted repository credentials or context.");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const api = createGitHubApi({ token });
  if (process.argv.includes("--prepare")) {
    const run = event.workflow_run;
    if (event.action !== "completed" || run?.event !== "pull_request" || !isSha(run.head_sha)) return;
    const confirmed = await api.getRun(repository, run.id);
    if (confirmed.id !== run.id || confirmed.head_sha !== run.head_sha || confirmed.run_attempt !== run.run_attempt || confirmed.path?.split("@")[0] !== WORKFLOW_PATH) return;
    const artifact = validateArtifactMetadata(await api.listArtifacts(repository, run.id), { runId: run.id, headSha: run.head_sha, runAttempt: run.run_attempt });
    if (artifact) {
      const output = process.env.GITHUB_OUTPUT;
      if (output) await import("node:fs").then(({ appendFileSync }) => appendFileSync(output, `artifact-id=${artifact.id}\n`, { mode: 0o600 }));
    }
    return;
  }
  const reportData = event.action === "completed" ? readReportDataDirectory(process.env.BIFROST_REPORT_DIR ?? "") : undefined;
  const result = await publishWorkflowRun({
    event, repository, serverUrl, api, reportData,
    artifactError: event.action === "completed" && !reportData ? "The bounded acceptance report data is missing or invalid." : undefined,
  });
  process.stdout.write(`Acceptance report publisher: ${result.status}${result.reason ? ` (${result.reason})` : ""}\n`);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) await main();
