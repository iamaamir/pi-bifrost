#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WORKFLOW_PATH = ".github/workflows/verification.yml";
const REQUIRED_JOB = "release-gates";
const LIMITATIONS = ["GitHub ruleset does not enforce this report; human merge required"];

export function parseDependencies(body) {
  const lines = (body ?? "").split(/\r?\n/);
  const refs = [];
  let dependencySection = false;
  for (const line of lines) {
    const heading = line.match(/^\s*#{1,6}\s*(dependencies|prerequisites)\s*:?\s*$/i);
    if (heading) { dependencySection = true; continue; }
    if (/^\s*#{1,6}\s+/.test(line)) dependencySection = false;
    const declaration = line.match(/^\s*(?:[-*]\s*)?(?:depends\s+on|dependencies|prerequisites)\s*(?::\s*|\s+)(.*)$/i);
    if (declaration && declaration[1].trim() === "") { dependencySection = true; continue; }
    const value = declaration?.[1] ?? (dependencySection ? line.replace(/^\s*[-*]\s*/, "").trim() : null);
    if (value === null || value === "") continue;
    for (const item of value.split(",")) {
      const token = item.trim().replace(/^[`'"<]+|[`'">]+$/g, "");
      const github = token.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)\/?$/i);
      const ref = token.match(/^(?:PR\s+)?#(\d+)$/i);
      if (github) refs.push({ kind: github[2].toLowerCase() === "pull" ? "pr" : "issue", repo: github[1].toLowerCase(), number: Number(github[3]) });
      else if (ref) refs.push({ kind: "ref", number: Number(ref[1]) });
      else throw new Error(`unsupported dependency syntax: ${token || value}`);
    }
  }
  return refs;
}

function effectiveReviews(reviews) {
  if (!Array.isArray(reviews)) return { error: "review data unavailable" };
  const ordered = [];
  for (const [index, review] of reviews.entries()) {
    if (!review || !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(review.state)
      || typeof review.author !== "string" || !review.author || typeof review.submitted_at !== "string"
      || !Number.isFinite(Date.parse(review.submitted_at))) return { error: "review evidence malformed or unknown" };
    ordered.push({ review, index });
  }
  ordered.sort((a, b) => Date.parse(a.review.submitted_at) - Date.parse(b.review.submitted_at) || a.index - b.index);
  const decisions = new Map();
  for (const { review } of ordered) {
    if (review.state === "COMMENTED") continue;
    if (review.state === "DISMISSED") decisions.delete(review.author);
    else decisions.set(review.author, review);
  }
  return { latest: [...decisions.values()] };
}

export function workflowHashesMatch(baseWorkflow, headWorkflow) {
  const credible = (value) => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
  return credible(baseWorkflow?.sha) && credible(headWorkflow?.sha) && baseWorkflow.sha === headWorkflow.sha;
}

function checkDependencies(dependencies, baseBranch, baseOid) {
  if (!Array.isArray(dependencies)) return "dependency evidence unavailable";
  for (const dependency of dependencies) {
    if (dependency?.kind === "issue") {
      if (dependency.state !== "CLOSED") return "issue dependency missing, unknown, or open";
    } else if (dependency?.kind === "pr") {
      // `gh pr view --json state` returns "MERGED" for merged PRs; eligibility
      // normalizes on mergedAt + integration into the current base tip.
      if (!["MERGED", "CLOSED"].includes(dependency.state) || !dependency.mergedAt || !Number.isFinite(Date.parse(dependency.mergedAt))
        || dependency.base !== baseBranch || dependency.integrated !== true) {
        return "PR dependency not merged into the current base";
      }
    } else return "dependency evidence missing or unknown";
  }
  if (!baseOid) return "base commit unavailable for dependency verification";
  return null;
}

export function evaluateEligibility({ pr, workflowFileMatchesBase, workflowRuns, reviews, reviewThreads, dependencies }) {
  const blockers = [];
  const head = pr?.headRefOid;
  if (!pr || typeof head !== "string" || !head) return { eligible: false, blockers: ["PR data or head SHA unavailable"], limitations: LIMITATIONS };
  if (pr.baseRefName !== "v2") blockers.push("base branch is not v2");
  if (typeof pr.baseRefOid !== "string" || !pr.baseRefOid) blockers.push("base commit unavailable");
  if (typeof pr.isDraft !== "boolean") blockers.push("draft state unavailable");
  else if (pr.isDraft) blockers.push("PR is draft");
  if (typeof pr.author?.login !== "string" || !pr.author.login) blockers.push("PR author identity unavailable");
  if (typeof pr.body !== "string" || !/Refs #\d+/i.test(pr.body)) blockers.push("linked issue reference missing");
  if (workflowFileMatchesBase !== true) blockers.push("verification workflow differs from current base or is unavailable");
  if (!Array.isArray(workflowRuns)) blockers.push("release-gates workflow evidence unavailable");
  else {
    const verified = workflowRuns.some((run) => run?.head_sha === head
      && run.event === "pull_request" && run.workflow_path === WORKFLOW_PATH
      && run.conclusion === "success" && Array.isArray(run.jobs)
      && run.jobs.some((job) => job?.name === REQUIRED_JOB && job.conclusion === "success"));
    if (!verified) blockers.push("successful release-gates job for current PR head missing");
  }
  const reviewEvidence = effectiveReviews(reviews);
  if (reviewEvidence.error) blockers.push(reviewEvidence.error);
  else {
    if (reviewEvidence.latest.some((review) => review.state === "CHANGES_REQUESTED")) blockers.push("active change request unresolved");
    if (!reviewEvidence.latest.some((review) => review.state === "APPROVED"
      && review.author !== pr.author?.login && review.commit_id === head)) blockers.push("no independent approval on current head");
  }
  if (!Array.isArray(reviewThreads)) blockers.push("review thread data unavailable");
  else if (reviewThreads.some((thread) => typeof thread?.isResolved !== "boolean" || !thread.isResolved)) blockers.push("unresolved or unknown review thread");
  const dependencyError = checkDependencies(dependencies, pr.baseRefName, pr.baseRefOid);
  if (dependencyError) blockers.push(dependencyError);
  return { eligible: blockers.length === 0, head, blockers, limitations: LIMITATIONS };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function getReviews(repo, number) {
  const output = gh(["api", "--paginate", "--jq", ".[]", `repos/${repo}/pulls/${number}/reviews`]);
  return output ? output.split("\n").map((line) => JSON.parse(line)).map((review) => ({
    state: review.state,
    author: review.user?.login,
    commit_id: review.commit_id,
    submitted_at: review.submitted_at,
  })) : [];
}

export function getReviewThreads(repo, number, query = ghJson) {
  const threads = [];
  const cursors = new Set();
  let cursor;
  do {
    const result = query(["api", "graphql", "-f", "query=query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}",
      "-F", "owner=" + repo.split("/")[0], "-F", "name=" + repo.split("/")[1], "-F", `number=${number}`,
      ...(cursor ? ["-F", `cursor=${cursor}`] : [])]);
    const page = result.data?.repository?.pullRequest?.reviewThreads;
    const pageInfo = page?.pageInfo;
    if (!page || !Array.isArray(page.nodes) || !pageInfo || typeof pageInfo.hasNextPage !== "boolean"
      || (pageInfo.endCursor !== null && (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor))) {
      throw new Error("Review thread pagination unavailable");
    }
    if (pageInfo.hasNextPage && (!pageInfo.endCursor || cursors.has(pageInfo.endCursor))) throw new Error("Review thread pagination unavailable");
    cursors.add(pageInfo.endCursor);
    threads.push(...page.nodes);
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

function dependencyEvidence(repo, ref, baseBranch, baseOid) {
  const dependencyRepo = ref.repo ?? repo.toLowerCase();
  if (dependencyRepo !== repo.toLowerCase()) throw new Error("cross-repository dependency unsupported");
  const issue = ghJson(["api", `repos/${repo}/issues/${ref.number}`]);
  if (!issue.pull_request) return { kind: "issue", number: ref.number, state: issue.state?.toUpperCase() };
  const pr = ghJson(["pr", "view", String(ref.number), "--repo", repo, "--json", "state,mergedAt,baseRefName,mergeCommit"]);
  let integrated = false;
  if (pr.mergedAt && pr.mergeCommit?.oid && pr.baseRefName === baseBranch) {
    const comparison = ghJson(["api", `repos/${repo}/compare/${pr.mergeCommit.oid}...${baseOid}`]);
    integrated = ["ahead", "identical"].includes(comparison.status);
  }
  return { kind: "pr", number: ref.number, state: pr.state?.toUpperCase(), mergedAt: pr.mergedAt, base: pr.baseRefName, integrated };
}

export function runEvidence(repo, workflowId, head, query = ghJson) {
  const runs = query(["api", `repos/${repo}/actions/workflows/${workflowId}/runs?head_sha=${head}&event=pull_request&per_page=100`]).workflow_runs ?? [];
  const groups = new Map();
  for (const run of runs) {
    if (run?.head_sha !== head || run.event !== "pull_request" || run.workflow_id !== workflowId) continue;
    const key = String(run.id);
    const prior = groups.get(key);
    if (!prior || (run.run_attempt ?? 0) > (prior.run_attempt ?? 0)) groups.set(key, run);
  }
  const candidateRuns = [...groups.values()].sort((a, b) => {
    const created = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (Number.isFinite(created) && created !== 0) return created;
    return Number(b.id) - Number(a.id);
  });
  if (!candidateRuns.length) return [];
  const latest = candidateRuns[0];
  const jobs = query(["api", `repos/${repo}/actions/runs/${latest.id}/jobs?per_page=100`]).jobs ?? [];
  return [{ head_sha: latest.head_sha, event: latest.event, workflow_path: latest.path,
    conclusion: latest.conclusion, jobs: jobs.map((job) => ({ name: job.name, conclusion: job.conclusion })) }];
}

function main() {
  const number = process.argv[2];
  if (!/^\d+$/.test(number ?? "")) throw new Error("Usage: node scripts/merge-eligibility.mjs <pr-number>");
  const repo = process.env.GITHUB_REPOSITORY ?? ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  const pr = ghJson(["pr", "view", number, "--repo", repo, "--json", "headRefOid,baseRefName,baseRefOid,isDraft,body,author"]);
  const workflow = ghJson(["api", `repos/${repo}/actions/workflows/verification.yml`]);
  const baseWorkflow = ghJson(["api", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${pr.baseRefOid}`]);
  const headWorkflow = ghJson(["api", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${pr.headRefOid}`]);
  const workflowRuns = runEvidence(repo, workflow.id, pr.headRefOid);
  const reviews = getReviews(repo, number);
  const reviewThreads = getReviewThreads(repo, number);
  const refs = parseDependencies(pr.body);
  const dependencies = refs.map((ref) => dependencyEvidence(repo, ref, pr.baseRefName, pr.baseRefOid));
  const result = evaluateEligibility({ pr, workflowFileMatchesBase: workflowHashesMatch(baseWorkflow, headWorkflow),
    workflowRuns, reviews, reviewThreads, dependencies });
  console.log(JSON.stringify({ ...result, policyLimit: LIMITATIONS[0] }, null, 2));
  process.exitCode = result.eligible ? 0 : 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  const script = resolve(fileURLToPath(import.meta.url));
  const invoked = resolve(process.argv[1]);
  if (script === invoked) return true;
  try {
    return realpathSync(script) === realpathSync(invoked);
  } catch {
    return false;
  }
}

if (isMain()) {
  try { main(); }
  catch (error) {
    console.error(`Eligibility check failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
