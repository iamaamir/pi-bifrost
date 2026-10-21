#!/usr/bin/env node
// Bounded merge controller for an eligible PR with a trusted, controller-side
// independent-review receipt.
//
// The caller (local controller operator) designates a receipt file outside the
// candidate checkout and the trusted reviewer/implementer identities. The
// receipt is NOT a cryptographic attestation and does not enforce GitHub review
// policy; it is a local trust boundary. Every check fails closed.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  dependencyEvidence,
  evaluateEligibility,
  getReviewThreads,
  getReviews,
  parseDependencies,
  workflowHashesMatch,
} from "./merge-eligibility.mjs";

const WORKFLOW_PATH = ".github/workflows/verification.yml";
const REQUIRED_JOB = "release-gates";
const BASE_BRANCH = "v2";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256_64 = /^[0-9a-f]{64}$/;
const LIMITATIONS = [
  "GitHub ruleset does not enforce this report; human merge required",
  "Trusted receipt is a local operator trust boundary, not a cryptographic attestation",
];

const RECEIPT_FIELDS = [
  "reviewerAgent",
  "implementerAgent",
  "headSha",
  "baseSha",
  "sourceTreeSha",
  "deltaSha256",
  "changedFiles",
  "unresolvedBlockingFindings",
];
const MERGE_COMMAND_FAILURE = { code: "merge-command-failed", message: "GitHub merge command failed" };
const POSTMERGE_EVIDENCE_UNAVAILABLE = { code: "postmerge-evidence-unavailable", message: "Post-merge verification evidence unavailable" };

class ControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControllerError(code, message);
}

function ghRaw(args, cwd) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd });
}

function gh(args, cwd) {
  return ghRaw(args, cwd).trim();
}

function ghJson(args, cwd) {
  return JSON.parse(gh(args, cwd));
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function parseArgs(argv) {
  const values = { pr: null, receipt: null, expectedReviewer: null, expectedImplementer: null, apply: false, check: false, repo: process.env.GITHUB_REPOSITORY ?? null, base: BASE_BRANCH, outcome: null };
  const valueFlags = new Map([
    ["--receipt", "receipt"],
    ["--expected-reviewer", "expectedReviewer"],
    ["--expected-implementer", "expectedImplementer"],
    ["--repo", "repo"],
    ["--base", "base"],
    ["--outcome", "outcome"],
  ]);
  let i = 0;
  for (; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--") { i++; break; }
    const eq = raw.indexOf("=");
    const flag = eq < 0 ? raw : raw.slice(0, eq);
    if (valueFlags.has(flag)) {
      const value = eq < 0 ? argv[++i] : raw.slice(eq + 1);
      if (value === undefined || value.startsWith("--") || value === "") fail("cli", `${flag} requires a value`);
      values[valueFlags.get(flag)] = value;
      continue;
    }
    if (raw === "--apply") { values.apply = true; continue; }
    if (raw === "--check") { values.check = true; continue; }
    if (/^\d+$/.test(raw) && values.pr === null) { values.pr = Number(raw); continue; }
    fail("cli", `unknown merge-controller argument: ${JSON.stringify(raw)}`);
  }
  for (const item of argv.slice(i)) {
    if (/^\d+$/.test(item) && values.pr === null) values.pr = Number(item);
    else fail("cli", `unexpected argument: ${JSON.stringify(item)}`);
  }
  if (values.pr === null) fail("cli", "Usage: node scripts/merge-controller.mjs <pr-number> --receipt <path> --expected-reviewer <id> --expected-implementer <id> [--apply|--check]");
  return values;
}

export function candidateRoot() {
  const directory = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  try {
    const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: directory, stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (root === directory) return root;
  } catch { /* missing target context must fail closed */ }
  fail("candidate-context", "controller candidate Git root unavailable or mismatched");
}

function readTrustedReceipt(path, root) {
  const canonical = resolveTrustedReceiptPath(path, root);
  let text, receipt;
  try {
    text = readFileSync(canonical, "utf8");
    receipt = JSON.parse(text);
  } catch { fail("receipt-malformed", "trusted review receipt is not valid JSON"); }
  return { canonical, receipt, digest: sha256Text(text) };
}

export function resolveTrustedReceiptPath(receiptPath, root) {
  let real;
  try {
    real = realpathSync(resolve(receiptPath));
  } catch {
    fail("receipt-missing", `trusted review receipt unavailable: ${receiptPath}`);
  }
  if (real === root || real.startsWith(root + sep)) {
    fail("receipt-candidate-owned", "candidate-owned review receipt rejected");
  }
  return real;
}

export function validateReceiptShape(receipt) {
  const errors = [];
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { errors: ["trusted review receipt malformed"] };
  }
  for (const field of RECEIPT_FIELDS) {
    if (!(field in receipt)) errors.push(`trusted review receipt missing required field: ${field}`);
  }
  for (const field of Object.keys(receipt)) {
    if (!RECEIPT_FIELDS.includes(field)) errors.push(`trusted review receipt contains unknown field: ${field}`);
  }
  if (typeof receipt.reviewerAgent !== "string" || !receipt.reviewerAgent) errors.push("trusted review receipt reviewer agent missing");
  if (typeof receipt.implementerAgent !== "string" || !receipt.implementerAgent) errors.push("trusted review receipt implementer agent missing");
  if (receipt.reviewerAgent && receipt.implementerAgent && receipt.reviewerAgent === receipt.implementerAgent) errors.push("reviewer agent must be distinct from implementer");
  if (typeof receipt.unresolvedBlockingFindings !== "number" || !Number.isInteger(receipt.unresolvedBlockingFindings) || receipt.unresolvedBlockingFindings !== 0) {
    errors.push("trusted review receipt must declare exactly zero unresolved blocking findings");
  }
  if (!SHA40.test(receipt.headSha ?? "")) errors.push("trusted review receipt headSha must be a 40-hex commit SHA");
  if (!SHA40.test(receipt.baseSha ?? "")) errors.push("trusted review receipt baseSha must be a 40-hex commit SHA");
  if (!SHA40.test(receipt.sourceTreeSha ?? "")) errors.push("trusted review receipt sourceTreeSha must be a 40-hex tree SHA");
  if (!SHA256_64.test(receipt.deltaSha256 ?? "")) errors.push("trusted review receipt deltaSha256 must be a 64-hex digest");
  if (!Array.isArray(receipt.changedFiles) || receipt.changedFiles.some((file) => typeof file !== "string" || !file)) {
    errors.push("trusted review receipt changedFiles must be a list of non-empty paths");
  } else if (new Set(receipt.changedFiles).size !== receipt.changedFiles.length) {
    errors.push("trusted review receipt changedFiles must not contain duplicates");
  }
  return { errors };
}

export function bindReceiptToExpectedIdentities(receipt, { expectedReviewer, expectedImplementer }) {
  const errors = [];
  if (!expectedReviewer) errors.push("trusted expected reviewer identity is required");
  else if (receipt?.reviewerAgent !== expectedReviewer) errors.push("reviewer agent does not match trusted expected reviewer");
  if (!expectedImplementer) errors.push("trusted expected implementer identity is required");
  else if (receipt?.implementerAgent !== expectedImplementer) errors.push("implementer agent does not match trusted expected implementer");
  return errors;
}

export function bindReceiptToEvidence(receipt, { headSha, baseSha, sourceTreeSha, deltaSha256, changedFiles }) {
  const errors = [];
  if (receipt?.headSha !== headSha) errors.push("trusted review receipt head does not match current PR head");
  if (receipt?.baseSha !== baseSha) errors.push("trusted review receipt base does not match current PR base");
  if (receipt?.sourceTreeSha !== sourceTreeSha) errors.push("trusted review receipt source tree does not match current PR head tree");
  if (receipt?.deltaSha256 !== deltaSha256) errors.push("trusted review receipt delta digest does not match actual PR diff");
  const expected = [...(changedFiles ?? [])].sort();
  const actual = Array.isArray(receipt?.changedFiles) ? [...receipt.changedFiles].sort() : [];
  if (expected.length !== actual.length || expected.some((file, index) => file !== actual[index])) {
    errors.push("trusted review receipt changed files do not match actual PR files");
  }
  return errors;
}

function requiresCurrentBase(rule) {
  return rule?.type === "required_status_checks"
    && rule.parameters?.strict_required_status_checks_policy === true
    && Array.isArray(rule.parameters.required_status_checks)
    && rule.parameters.required_status_checks.some((check) => check.context === REQUIRED_JOB);
}

function requireServerBaseGuard(repo, baseBranch) {
  try {
    const rules = ghJson(["api", `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}?per_page=100`]);
    if (!Array.isArray(rules) || rules.length >= 100) fail("server-protection", "effective branch rules unavailable or truncated");
    for (const rule of rules) {
      if (!requiresCurrentBase(rule) || rule.ruleset_source_type !== "Repository" || rule.ruleset_source !== repo
        || !Number.isSafeInteger(rule.ruleset_id) || rule.ruleset_id <= 0) continue;
      const policy = ghJson(["api", `repos/${repo}/rulesets/${rule.ruleset_id}`]);
      if (policy?.id !== rule.ruleset_id || policy.target !== "branch" || policy.enforcement !== "active"
        || !Array.isArray(policy.bypass_actors) || policy.bypass_actors.length !== 0 || !Array.isArray(policy.rules)
        || !policy.rules.some(requiresCurrentBase) || !policy.rules.some((item) => item.type === "pull_request")) continue;
      return { rulesetId: rule.ruleset_id, strict: true, requiredCheck: REQUIRED_JOB, bypassActors: 0 };
    }
  } catch (error) {
    if (error instanceof ControllerError) throw error;
    fail("server-protection", "effective strict server protection could not be verified");
  }
  fail("server-protection", "an active non-bypassable strict release-gates and pull-request ruleset is required");
}

function collectEvidence(repo, number) {
  const pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,baseRefName,baseRefOid,isDraft,body,author"]);
  const workflow = ghJson(["api", `repos/${repo}/actions/workflows/verification.yml`]);
  const baseWorkflow = ghJson(["api", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${pr.baseRefOid}`]);
  const headWorkflow = ghJson(["api", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${pr.headRefOid}`]);
  const currentRun = latestExactRun(repo, workflow.id, pr.headRefOid, "pull_request");
  const workflowRuns = currentRun ? [{ ...currentRun, workflow_path: currentRun.path }] : [];
  const reviews = getReviews(repo, number);
  const reviewThreads = getReviewThreads(repo, number);
  const refs = parseDependencies(pr.body ?? "");
  const dependencies = refs.map((ref) => dependencyEvidence(repo, ref, pr.baseRefName, pr.baseRefOid));
  const workflowFileMatchesBase = workflowHashesMatch(baseWorkflow, headWorkflow);
  const eligibility = evaluateEligibility({ pr, workflowFileMatchesBase, workflowRuns, reviews, reviewThreads, dependencies });
  return { pr, workflow, currentRun, workflowRuns, reviews, reviewThreads, dependencies, workflowFileMatchesBase, eligibility };
}

export function fetchHeadTree(repo, headSha) {
  const commit = ghJson(["api", `repos/${repo}/commits/${headSha}`]);
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (!SHA40.test(tree ?? "")) fail("evidence", "head commit tree unavailable");
  return tree;
}

export function fetchPrDiffDigest(repo, number) {
  return sha256Text(ghRaw(["pr", "diff", String(number), "--repo", repo]));
}

export function fetchChangedFiles(repo, number) {
  const first = ghJson(["api", `repos/${repo}/pulls/${number}/files?per_page=100&page=1`]);
  if (!Array.isArray(first)) fail("evidence", "PR changed files unavailable or malformed");
  // This controller deliberately supports at most 100 changed files. A full first
  // page requires an empty second page; otherwise no receipt can bind complete scope.
  if (first.length === 100) {
    const second = ghJson(["api", `repos/${repo}/pulls/${number}/files?per_page=100&page=2`]);
    if (!Array.isArray(second) || second.length !== 0) fail("evidence", "PR changed files inventory incomplete or exceeds controller bound");
  }
  if (first.some((file) => typeof file?.filename !== "string" || !file.filename || file.filename.includes("\0"))
    || new Set(first.map((file) => file.filename)).size !== first.length) fail("evidence", "PR changed files unavailable or malformed");
  return first.map((file) => file.filename);
}

export function fetchProposedMerge(repo, number) {
  const pr = ghJson(["api", `repos/${repo}/pulls/${number}`]);
  if (!SHA40.test(pr.merge_commit_sha ?? "")) fail("proposed-merge-unavailable", "proposed merge commit unavailable");
  const commit = ghJson(["api", `repos/${repo}/commits/${pr.merge_commit_sha}`]);
  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent.sha) : [];
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (!SHA40.test(tree ?? "")) fail("proposed-merge-unavailable", "proposed merge tree unavailable");
  return { sha: pr.merge_commit_sha, parents, tree };
}

// Select before inspecting success. An older success can never mask a failed rerun.
function latestExactRun(repo, workflowId, sha, event) {
  const page = ghJson(["api", `repos/${repo}/actions/workflows/${workflowId}/runs?head_sha=${sha}&event=${event}&per_page=100`]);
  const runs = page.workflow_runs;
  if (!Array.isArray(runs) || runs.length === 0 || page.total_count !== runs.length) return null;
  if (runs.some((run) => !Number.isSafeInteger(run?.id) || !Number.isSafeInteger(run.run_attempt)
    || run.run_attempt < 1 || run.head_sha !== sha || run.event !== event || run.workflow_id !== workflowId
    || run.path !== WORKFLOW_PATH || !Number.isFinite(Date.parse(run.created_at)))) return null;
  const [latest] = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id || b.run_attempt - a.run_attempt);
  if (latest.status !== "completed" || latest.conclusion !== "success"
    || runs.filter((run) => run.id === latest.id && run.run_attempt === latest.run_attempt).length !== 1) return null;
  const run = ghJson(["api", `repos/${repo}/actions/runs/${latest.id}/attempts/${latest.run_attempt}`]);
  if (run.id !== latest.id || run.run_attempt !== latest.run_attempt || run.head_sha !== sha || run.event !== event
    || run.workflow_id !== workflowId || run.path !== WORKFLOW_PATH || run.repository?.full_name !== repo
    || run.status !== "completed" || run.conclusion !== "success") return null;
  const pageJobs = ghJson(["api", `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`]);
  const jobs = pageJobs.jobs;
  if (!Array.isArray(jobs) || pageJobs.total_count !== jobs.length) return null;
  const gates = jobs.filter((job) => job?.name === REQUIRED_JOB);
  if (gates.length !== 1 || gates[0].conclusion !== "success") return null;
  return { ...run, jobs };
}

export function pushGatePassed(repo, workflowId, sha) {
  return latestExactRun(repo, workflowId, sha, "push") !== null;
}

// Read bounded JSON members without extracting or executing anything from the ZIP.
const READ_EVIDENCE_ZIP = `import io,json,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
items=[i for i in z.infolist() if i.filename == "evidence.json" or i.filename.endswith("/evidence.json")]
assert 0 < len(items) <= 100
assert all(i.file_size <= 2*1024*1024 for i in items)
assert sum(i.file_size for i in items) <= 8*1024*1024
print(json.dumps([json.loads(z.read(i)) for i in items]))`;

function testedSource(repo, run, artifacts, name, revision, stepName) {
  const matches = artifacts.filter((artifact) => artifact?.name === name);
  const artifact = matches[0];
  const started = Date.parse(run.run_started_at), ended = Date.parse(run.updated_at);
  const created = Date.parse(artifact?.created_at);
  const steps = run.jobs.find((job) => job.name === REQUIRED_JOB)?.steps;
  const uploads = Array.isArray(steps) ? steps.filter((step) => step.name === stepName && step.conclusion === "success") : [];
  const uploadStart = Date.parse(uploads[0]?.started_at), uploadEnd = Date.parse(uploads[0]?.completed_at);
  if (matches.length !== 1 || !Number.isSafeInteger(artifact?.id) || artifact.expired !== false
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 64*1024*1024
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || !Number.isFinite(started) || !Number.isFinite(ended) || !Number.isFinite(created) || created < started || created > ended
    || uploads.length !== 1 || !Number.isFinite(uploadStart) || !Number.isFinite(uploadEnd) || created < uploadStart || created > uploadEnd
    || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? "")) fail("tested-source", "current-attempt tested-source artifact missing or ambiguous");
  const archive = execFileSync("gh", ["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 64*1024*1024 });
  if (archive.length !== artifact.size_in_bytes || "sha256:" + createHash("sha256").update(archive).digest("hex") !== artifact.digest) fail("tested-source", "tested-source artifact digest mismatch");
  const evidence = JSON.parse(execFileSync("python3", ["-I", "-c", READ_EVIDENCE_ZIP], { input: archive, encoding: "utf8", maxBuffer: 8*1024*1024 }));
  const candidates = evidence.filter((item) => item?.source?.revisionAtStart === revision);
  const item = candidates[0], source = item?.source;
  if (candidates.length !== 1 || item.schemaVersion !== 1 || item.profile !== "deterministic" || item.exitCode !== 0
    || source.revisionAtEnd !== revision || source.changedDuringRun !== false
    || !SHA256_64.test(source.fingerprintAtStart ?? "") || source.fingerprintAtEnd !== source.fingerprintAtStart
    || !Array.isArray(source.dirtyPathsAtStart) || source.dirtyPathsAtStart.length !== 0
    || !Array.isArray(source.dirtyPathsAtEnd) || source.dirtyPathsAtEnd.length !== 0
    || !Array.isArray(item.cases) || !item.cases.some((test) => test.id === "candidate-stable" && test.required === true && test.status === "passed")
    || item.cases.some((test) => test.required === true && test.status !== "passed")) fail("tested-source", "tested-source acceptance evidence missing, failed, or stale");
  return { id: artifact.id, digest: artifact.digest, revision, runId: run.id, attempt: run.run_attempt };
}

function testedSources(repo, run, headSha, proposed) {
  if (!run) fail("tested-source", "successful current release-gates attempt unavailable");
  const page = ghJson(["api", `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`]);
  if (!Array.isArray(page.artifacts) || page.total_count !== page.artifacts.length) fail("tested-source", "tested-source artifact inventory incomplete");
  return [testedSource(repo, run, page.artifacts, `acceptance-evidence-${headSha}`, headSha, "Upload acceptance evidence"),
    testedSource(repo, run, page.artifacts, `merge-result-evidence-${proposed.sha}`, proposed.sha, "Upload merge-result evidence")];
}

function writeOutcome(path, payload, { exclusive = false } = {}) {
  if (!path) return;
  const target = resolve(path), temp = target + ".tmp-" + process.pid;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    if (exclusive) linkSync(temp, target);
    else renameSync(temp, target);
    fd = openSync(dirname(target), "r"); fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function emit(payload, outcomePath) {
  try { writeOutcome(outcomePath, payload, { exclusive: payload.mode === "dry-run" }); }
  catch (error) {
    console.log(JSON.stringify({ outcome: "outcome-persistence-failed", error: error.message, operation: payload }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.outcome === "dry-run" || payload.outcome === "merged-and-verified" ? 0 : 1;
}

function outcomeDestination(path, root) {
  if (!path) fail("outcome", "--outcome is required for apply and check");
  const target = resolve(path);
  const canonical = existsSync(target) ? realpathSync(target) : join(realpathSync(dirname(target)), basename(target));
  if (canonical === root || canonical.startsWith(root + sep)) fail("outcome", "candidate-owned outcome rejected");
  return canonical;
}

function mergeAndVerify({ args, repo, baseBranch, headSha, baseSha, proposedTree, workflowId }) {
  const mergeResult = spawnSync("gh", ["pr", "merge", String(args.pr), "--repo", repo, "--merge", "--match-head-commit", headSha], { encoding: "utf8" });
  if (mergeResult.status !== 0) {
    return { outcome: "merge-failed", details: MERGE_COMMAND_FAILURE };
  }
  let after;
  try {
    after = ghJson(["pr", "view", String(args.pr), "--repo", repo, "--json", "state,mergeCommit"]);
  } catch {
    return { outcome: "waiting-for-push-verification", details: POSTMERGE_EVIDENCE_UNAVAILABLE };
  }
  const mergeSha = after?.mergeCommit?.oid;
  if (after?.state !== "MERGED" || !SHA40.test(mergeSha ?? "")) {
    return { outcome: "merge-failed", details: { state: after?.state, mergeCommit: mergeSha } };
  }
  let commit;
  try {
    commit = ghJson(["api", `repos/${repo}/commits/${mergeSha}`]);
  } catch {
    return { outcome: "waiting-for-push-verification", details: POSTMERGE_EVIDENCE_UNAVAILABLE };
  }
  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent.sha) : [];
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge parents mismatch", parents, mergeSha } };
  }
  if (tree !== proposedTree) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge tree mismatch", tree, proposedTree, mergeSha } };
  }
  let ref;
  try {
    ref = ghJson(["api", `repos/${repo}/git/ref/heads/${baseBranch}`]);
  } catch {
    return { outcome: "waiting-for-push-verification", details: POSTMERGE_EVIDENCE_UNAVAILABLE };
  }
  const refSha = ref?.object?.sha ?? ref?.sha;
  if (refSha !== mergeSha) {
    return { outcome: "waiting-for-push-verification", details: { reason: "exact push not observed", refSha, mergeSha } };
  }
  if (!pushGatePassed(repo, workflowId, mergeSha)) {
    return { outcome: "waiting-for-push-verification", details: { reason: "required release gates not successful after push", mergeSha } };
  }
  return { outcome: "merged-and-verified", details: { mergeSha, parents, tree, refSha } };
}

function checkMerged({ args, repo, baseBranch, workflowId, headSha, baseSha, proposedTree }) {
  const after = ghJson(["pr", "view", String(args.pr), "--repo", repo, "--json", "state,mergeCommit,headRefOid,baseRefOid"]);
  if (after?.state !== "MERGED" || !SHA40.test(after?.mergeCommit?.oid ?? "")) {
    return { outcome: "not-merged", details: { state: after?.state } };
  }
  const mergeSha = after.mergeCommit.oid;
  const commit = ghJson(["api", `repos/${repo}/commits/${mergeSha}`]);
  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent.sha) : [];
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge parents mismatch", parents, mergeSha } };
  }
  if (!SHA40.test(tree ?? "") || tree !== proposedTree) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge tree mismatch", tree, proposedTree, mergeSha } };
  }
  const ref = ghJson(["api", `repos/${repo}/git/ref/heads/${baseBranch}`]);
  const refSha = ref?.object?.sha ?? ref?.sha;
  if (refSha !== mergeSha) return { outcome: "waiting-for-push-verification", details: { reason: "exact push not observed", refSha, mergeSha } };
  if (!pushGatePassed(repo, workflowId, mergeSha)) return { outcome: "waiting-for-push-verification", details: { reason: "required release gates not successful after push", mergeSha } };
  return { outcome: "merged-and-verified", details: { mergeSha, parents, tree } };
}

let outcomeContext;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = candidateRoot();
  if (!args.apply && !args.check && args.outcome && existsSync(resolve(args.outcome))) fail("outcome", "dry-run must not overwrite an existing outcome; use --check");
  const repo = args.repo ?? ghJson(["repo", "view", "--json", "nameWithOwner"], root).nameWithOwner;

  if (args.apply && args.check) fail("cli", "--apply and --check are mutually exclusive");
  if (!args.receipt) fail("cli", "--receipt is required");
  if (args.apply || args.check) {
    args.outcome = outcomeDestination(args.outcome, root);
    if (args.outcome === resolve(args.receipt)) fail("outcome", "outcome must differ from review receipt");

  }
  if (args.apply) {
    let claimFd;
    try {
      claimFd = openSync(args.outcome, "wx", 0o600);
    } catch {
      fail("outcome", "apply outcome already exists; use --check for continuation");
    }
    const payload = { outcome: "preflight", pr: args.pr, repo };
    writeFileSync(claimFd, JSON.stringify(payload, null, 2) + "\n");
    fsyncSync(claimFd);
    closeSync(claimFd);
    claimFd = undefined;
    outcomeContext = { path: args.outcome, payload };
  }
  const trusted = readTrustedReceipt(args.receipt, root);
  const receipt = trusted.receipt;
  if (args.outcome && resolve(args.outcome) === trusted.canonical) fail("outcome", "outcome must differ from review receipt");
  if (args.check) {
    const prior = JSON.parse(readFileSync(args.outcome, "utf8"));
    const intent = prior.applyIntent;
    if (!["apply", "check"].includes(prior.mode) || !intent || intent.version !== 1 || intent.repo !== repo || intent.pr !== args.pr
      || intent.baseBranch !== args.base || !SHA40.test(intent.headSha ?? "") || !SHA40.test(intent.baseSha ?? "")
      || !SHA40.test(intent.proposedTree ?? "") || !Number.isSafeInteger(intent.workflowId)
      || intent.receiptPath !== trusted.canonical || intent.receiptDigest !== trusted.digest
      || intent.headSha !== receipt.headSha || intent.baseSha !== receipt.baseSha
      || validateReceiptShape(receipt).errors.length || bindReceiptToExpectedIdentities(receipt, args).length) fail("intent", "trusted frozen apply intent unavailable or mismatched");
    outcomeContext = { path: args.outcome, payload: prior };
    let result;
    try { result = checkMerged({ args, ...intent }); }
    catch { result = { outcome: "waiting-for-push-verification", details: POSTMERGE_EVIDENCE_UNAVAILABLE }; }
    // The receipt is a live trust input. If it is revoked while GitHub checks
    // run, the earlier read must not authorize a successful check outcome.
    if (result.outcome === "merged-and-verified") {
      const finalTrusted = readTrustedReceipt(args.receipt, root);
      const finalReceipt = finalTrusted.receipt;
      const finalReceiptErrors = [
        ...validateReceiptShape(finalReceipt).errors,
        ...bindReceiptToExpectedIdentities(finalReceipt, args),
      ];
      if (finalTrusted.canonical !== trusted.canonical || finalTrusted.digest !== trusted.digest
        || finalTrusted.canonical !== intent.receiptPath || finalTrusted.digest !== intent.receiptDigest
        || finalReceipt.headSha !== intent.headSha || finalReceipt.baseSha !== intent.baseSha
        || finalReceiptErrors.length !== 0) {
        fail("receipt-changed", "trusted review receipt changed during check");
      }
    }
    emit({ pr: args.pr, repo, mode: "check", applyIntent: intent, ...result, limitations: LIMITATIONS }, args.outcome);
    return;
  }

  const baseBranch = args.base;
  const evidence = collectEvidence(repo, args.pr);
  const pr = evidence.pr;
  if (pr.baseRefName !== baseBranch) fail("wrong-base", `PR base branch is not ${baseBranch}`);
  const headSha = pr.headRefOid;
  const baseSha = pr.baseRefOid;
  const sourceTreeSha = fetchHeadTree(repo, headSha);
  const deltaSha256 = fetchPrDiffDigest(repo, args.pr);
  const changedFiles = fetchChangedFiles(repo, args.pr);
  if (changedFiles === null) fail("evidence", "PR changed files unavailable");
  const proposed = fetchProposedMerge(repo, args.pr);
  if (proposed.parents.length !== 2 || proposed.parents[0] !== baseSha || proposed.parents[1] !== headSha) {
    fail("proposed-merge-mismatch", "proposed merge parents do not match current base and head");
  }

  const shape = validateReceiptShape(receipt);
  const identityErrors = bindReceiptToExpectedIdentities(receipt, { expectedReviewer: args.expectedReviewer, expectedImplementer: args.expectedImplementer });
  const evidenceErrors = bindReceiptToEvidence(receipt, { headSha, baseSha, sourceTreeSha, deltaSha256, changedFiles });
  const receiptErrors = [...shape.errors, ...identityErrors, ...evidenceErrors];
  const githubBlockers = (evidence.eligibility.blockers ?? []).filter((blocker) => blocker !== "no independent approval on current head");
  const blockers = [...githubBlockers, ...receiptErrors];
  const serverGuard = blockers.length ? null : requireServerBaseGuard(repo, baseBranch);
  const tested = blockers.length ? null : testedSources(repo, evidence.currentRun, headSha, proposed);

  const summary = {
    pr: args.pr,
    repo,
    mode: args.apply ? "apply" : "dry-run",
    head: headSha,
    base: baseSha,
    sourceTree: sourceTreeSha,
    proposedMerge: { sha: proposed.sha, parents: proposed.parents, tree: proposed.tree },
    trustedReview: { reviewerAgent: receipt?.reviewerAgent, implementerAgent: receipt?.implementerAgent, valid: receiptErrors.length === 0 },
    blockers,
    testedSources: tested,
    serverGuard,
    limitations: LIMITATIONS,
  };

  if (blockers.length) {
    emit({ ...summary, outcome: "rejected" }, args.outcome);
    return;
  }

  if (!args.apply) {
    emit({ ...summary, outcome: "dry-run" }, args.outcome);
    return;
  }

  // TOCTOU requery: every bound value must be identical immediately before merge.
  const recheck = collectEvidence(repo, args.pr);
  const reHead = recheck.pr.headRefOid;
  const reBase = recheck.pr.baseRefOid;
  const reTree = fetchHeadTree(repo, reHead);
  const reDelta = fetchPrDiffDigest(repo, args.pr);
  const reFiles = fetchChangedFiles(repo, args.pr);
  const reProposed = fetchProposedMerge(repo, args.pr);
  const reTrusted = readTrustedReceipt(args.receipt, root);
  const reReceipt = reTrusted.receipt;
  const reShape = validateReceiptShape(reReceipt);
  const reEvidenceErrors = bindReceiptToEvidence(reReceipt, { headSha: reHead, baseSha: reBase, sourceTreeSha: reTree, deltaSha256: reDelta, changedFiles: reFiles ?? [] });
  const reGithubBlockers = (recheck.eligibility.blockers ?? []).filter((blocker) => blocker !== "no independent approval on current head");
  const toctouMismatch = reHead !== headSha || reBase !== baseSha || reTree !== sourceTreeSha || reDelta !== deltaSha256
    || JSON.stringify([...(reFiles ?? [])].sort()) !== JSON.stringify([...changedFiles].sort())
    || reProposed.sha !== proposed.sha || reProposed.tree !== proposed.tree
    || JSON.stringify(reProposed.parents) !== JSON.stringify(proposed.parents)
    || reTrusted.canonical !== trusted.canonical || reTrusted.digest !== trusted.digest
    || bindReceiptToExpectedIdentities(reReceipt, args).length !== 0
    || recheck.pr.baseRefName !== baseBranch || reFiles === null
    || reShape.errors.length !== 0 || reEvidenceErrors.length !== 0 || reGithubBlockers.length !== 0;
  if (toctouMismatch) {
    emit({ ...summary, head: reHead, base: reBase, proposedMerge: { sha: reProposed.sha, parents: reProposed.parents, tree: reProposed.tree }, outcome: "rejected-toctou" }, args.outcome);
    return;
  }

  const reTested = testedSources(repo, recheck.currentRun, reHead, reProposed);
  if (JSON.stringify(reTested) !== JSON.stringify(tested)) fail("tested-source", "tested-source evidence changed at apply recheck");
  // Final pre-merge base/head check: --match-head-commit pins only the head,
  // so re-read immediately before merge and refuse if the tested base moved.
  const finalPrecheck = collectEvidence(repo, args.pr);
  const finalPreHead = finalPrecheck.pr.headRefOid;
  const finalPreBase = finalPrecheck.pr.baseRefOid;
  const finalProposed = fetchProposedMerge(repo, args.pr);
  const finalGithubBlockers = (finalPrecheck.eligibility.blockers ?? []).filter((blocker) => blocker !== "no independent approval on current head");
  const finalAuthorizationChanged = finalGithubBlockers.length !== 0
    || finalPrecheck.workflow.id !== evidence.workflow.id
    || finalPrecheck.currentRun?.id !== evidence.currentRun?.id
    || finalPrecheck.currentRun?.run_attempt !== evidence.currentRun?.run_attempt;
  const finalProposedMismatch = finalProposed.sha !== proposed.sha || finalProposed.tree !== proposed.tree
    || JSON.stringify(finalProposed.parents) !== JSON.stringify(proposed.parents)
    || finalProposed.parents.length !== 2 || finalProposed.parents[0] !== baseSha || finalProposed.parents[1] !== headSha;
  if (finalPreHead !== headSha || finalPreBase !== baseSha || finalPrecheck.pr.baseRefName !== baseBranch || finalProposedMismatch || finalAuthorizationChanged) {
    emit({ ...summary, head: finalPreHead, base: finalPreBase, proposedMerge: { sha: proposed.sha, parents: proposed.parents, tree: proposed.tree }, outcome: "rejected-toctou" }, args.outcome);
    return;
  }
  const finalServerGuard = requireServerBaseGuard(repo, baseBranch);
  if (JSON.stringify(finalServerGuard) !== JSON.stringify(serverGuard)) fail("server-protection", "server base protection changed during apply");
  // GitHub reads above may outlive a receipt revocation; revalidate the live
  // trust input only after those reads, immediately before persisting intent.
  const finalTrusted = readTrustedReceipt(args.receipt, root);
  const finalReceipt = finalTrusted.receipt;
  if (finalTrusted.canonical !== trusted.canonical || finalTrusted.digest !== trusted.digest
    || validateReceiptShape(finalReceipt).errors.length !== 0
    || bindReceiptToExpectedIdentities(finalReceipt, args).length !== 0
    || bindReceiptToEvidence(finalReceipt, { headSha, baseSha, sourceTreeSha, deltaSha256, changedFiles }).length !== 0) {
    fail("receipt-changed", "trusted review receipt changed before apply");
  }
  const workflowId = evidence.workflow.id;
  const applyIntent = { version: 1, repo, pr: args.pr, baseBranch, headSha, baseSha, proposedTree: proposed.tree, workflowId,
    receiptPath: trusted.canonical, receiptDigest: trusted.digest, testedSources: tested };
  summary.applyIntent = applyIntent;
  writeOutcome(args.outcome, { ...summary, outcome: "apply-intent" });
  outcomeContext = { path: args.outcome, payload: { ...summary, outcome: "apply-intent" } };
  let result;
  try { result = mergeAndVerify({ args, repo, baseBranch, headSha, baseSha, proposedTree: proposed.tree, workflowId }); }
  catch { result = { outcome: "waiting-for-push-verification", details: POSTMERGE_EVIDENCE_UNAVAILABLE }; }
  emit({ ...summary, outcome: result.outcome, postMerge: result.details }, args.outcome);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    const payload = { outcome: error.code === "cli" ? "usage-error" : "rejected", error: error.message, code: error.code ?? "unknown", limitations: LIMITATIONS };
    emit({ ...outcomeContext?.payload, ...payload }, outcomeContext?.path);
    process.exitCode = 1;
  }
}
