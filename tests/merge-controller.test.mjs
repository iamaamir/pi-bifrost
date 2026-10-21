import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/merge-controller.mjs", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);
const PROPOSED_SHA = "e".repeat(40);
const PROPOSED_TREE = "f".repeat(40);
const DIFF = "diff --git a/x b/x\n+hello\n";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const world = JSON.parse(fs.readFileSync(process.env.FAKE_GH_WORLD, "utf8"));
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
function out(v) { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); }
function die(code) { process.stderr.write(code + "\\n"); process.exit(1); }
const joined = args.join(" ");
if (joined.includes("headRefOid,baseRefName")) {
  world.prReads = (world.prReads ?? 0) + 1;
  if (world.prReads === 1 && world.concurrentIntentPath) fs.writeFileSync(world.concurrentIntentPath, world.concurrentIntentBytes);
  if (world.prReads === 3 && world.finalThreads) world.threads = world.finalThreads;
  if (world.prReads === 3 && world.finalCiRuns) world.ciRuns = world.finalCiRuns;
  fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
}
if (world.revokeReceipt && joined.includes("headRefOid,baseRefName")) {
  world.reads = (world.reads ?? 0) + 1;
  if (world.reads === (world.revokeReceiptRead ?? 2)) fs.writeFileSync(world.receiptPath, JSON.stringify(world.revokedReceipt));
  fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
}
if (world.revokeReceiptDuringCheck && joined.includes("/git/ref/heads/")) {
  fs.writeFileSync(world.receiptPath, JSON.stringify(world.revokedReceipt));
  fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
}
if (world.loseOutcome && joined.includes("--json state,mergeCommit")) {
  fs.rmSync(world.outcomePath, { force: true });
  fs.rmdirSync(require("node:path").dirname(world.outcomePath));
}
if (args[0] === "repo" && args[1] === "view") out({ nameWithOwner: world.repo });
if (args[0] === "pr" && args[1] === "diff") out(world.diff ?? "");
if (args[0] === "pr" && args[1] === "merge") {
  if (world.merge?.fail) {
    if (world.merge.stdout) process.stdout.write(world.merge.stdout);
    die(world.merge.message ?? "merge rejected");
  }
  out("merged");
}
if (args[0] === "pr" && args[1] === "view") {
  if (world.postMergeViewError && joined.includes("--json state,mergeCommit")) die(world.postMergeViewError);
  if (joined.includes("--json files")) out({ files: (world.pr.files ?? []).map((p) => ({ path: p })) });
  if (joined.includes("state,mergeCommit,headRefOid,baseRefOid")) out(world.afterMerge ?? { state: "MERGED", mergeCommit: { oid: world.pr.headRefOid }, headRefOid: world.pr.headRefOid, baseRefOid: world.pr.baseRefOid });
  if (joined.includes("state,mergeCommit")) out(world.afterMerge ?? { state: "MERGED", mergeCommit: { oid: MERGE_SHA } });
  let pr = world.pr;
  if (world.headSequence && joined.includes("headRefOid,baseRefName")) {
    pr = { ...pr, headRefOid: world.headSequence.shift() ?? world.pr.headRefOid };
    fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
  }
  if (world.baseSequence && joined.includes("headRefOid,baseRefName")) {
    pr = { ...pr, baseRefOid: world.baseSequence.shift() ?? world.pr.baseRefOid };
    fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
  }
  out(pr);
}
if (args[0] === "api") {
  if (joined.includes("/rules/branches/")) out(world.effectiveRules);
  if (joined.match(/\\/rulesets\\/\\d+$/)) out(world.serverRuleset);
  if (world.postMergeCommitError && joined.endsWith("/commits/" + world.afterMerge.mergeCommit.oid)) die(world.postMergeCommitError);
  if (world.postMergeRefError && joined.includes("/git/ref/heads/")) die(world.postMergeRefError);
  if (joined.includes("actions/workflows/verification.yml")) out({ id: world.workflowId ?? 123 });
  if (joined.includes("contents/")) out({ sha: joined.includes(world.pr.baseRefOid) ? (world.baseWorkflowSha ?? "1".repeat(40)) : (world.headWorkflowSha ?? "1".repeat(40)) });
  if (joined.includes("/runs?head_sha=")) { const runs = joined.includes("event=push") ? (world.pushRuns ?? []) : (world.ciRuns ?? []); out({ total_count: runs.length, workflow_runs: runs }); }
  if (joined.includes("/artifacts?")) out({ total_count: world.artifacts.length, artifacts: world.artifacts });
  if (joined.includes("/artifacts/") && joined.endsWith("/zip")) {
    const id = Number(joined.match(/artifacts\\/(\\d+)/)[1]);
    process.stdout.write(Buffer.from(world.archives[id], "base64")); process.exit(0);
  }
  if (joined.match(/actions\\/runs\\/\\d+\\/attempts\\/\\d+$/)) {
    const id = Number(joined.match(/runs\\/(\\d+)/)[1]);
    out(world.runDetails?.[id] ?? [...world.ciRuns, ...world.pushRuns].find(r => r.id === id && r.run_attempt === Number(joined.match(/attempts\\/(\\d+)/)[1])));
  }
  if (joined.match(/actions\\/runs\\/\\d+\\/(?:attempts\\/\\d+\\/)?jobs/)) {
    const id = Number(joined.match(/actions\\/runs\\/(\\d+)/)[1]);
    { const jobs = (world.jobs ?? {})[id] ?? []; out({ total_count: jobs.length, jobs }); }
  }
  if (world.leakToken && joined.includes("/reviews")) { process.stderr.write(world.leakToken + "\\n"); process.exit(1); }
  if (joined.includes("/reviews")) out((world.reviews ?? []).map((r) => JSON.stringify({ state: r.state, user: { login: r.author }, commit_id: r.commit_id, submitted_at: r.submitted_at })).join("\\n"));
  if (args.includes("graphql")) out({ data: { repository: { pullRequest: { reviewThreads: { nodes: world.threads ?? [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  if (joined.match(/\\/pulls\\/\\d+$/)) {
    if (world.proposedMergeSequence?.length) {
      const sha = world.proposedMergeSequence.shift();
      fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
      out({ merge_commit_sha: sha });
    }
    out(world.pull ?? { merge_commit_sha: PROPOSED_SHA });
  }
  if (joined.match(/\\/issues\\/\\d+$/)) {
    const n = Number(joined.match(/\\/issues\\/(\\d+)$/)[1]);
    out(world.issues?.[n] ?? { number: n, state: "CLOSED" });
  }
  if (joined.match(/\\/pulls\\/\\d+\\/files\\?/)) {
    const page = Number(new URLSearchParams(joined.split("?")[1]).get("page"));
    const files = world.pr.files ?? [];
    out(files.slice((page - 1) * 100, page * 100).map((filename) => ({ filename })));
  }
  if (joined.match(/\\/commits\\//)) {
    const sha = joined.match(/\\/commits\\/([0-9a-f]+)$/)[1];
    out((world.commits ?? {})[sha] ?? die("unknown commit " + sha));
  }
  if (joined.includes("/git/ref/heads/")) out(world.ref ?? { object: { sha: MERGE_SHA } });
  if (joined.includes("/compare/")) out({ status: world.compareStatus ?? "ahead" });
  die("unhandled api: " + joined);
}
die("unhandled: " + joined);
`;

function makeRun(id, head, event, extra = {}) {
  return { id, run_attempt: 1, head_sha: head, event, workflow_id: 123,
    path: ".github/workflows/verification.yml", status: "completed", conclusion: "success",
    repository: { full_name: "org/repo" }, created_at: "2026-01-01T00:00:00Z",
    run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:30:00Z", ...extra };
}

function artifact(id, prefix, revision) {
  const evidence = { schemaVersion: 1, profile: "deterministic", exitCode: 0,
    source: { revisionAtStart: revision, revisionAtEnd: revision,
      fingerprintAtStart: "1".repeat(64), fingerprintAtEnd: "1".repeat(64),
      dirtyPathsAtStart: [], dirtyPathsAtEnd: [], changedDuringRun: false },
    cases: [{ id: "candidate-stable", required: true, status: "passed" }] };
  const archive = execFileSync("python3", ["-c", 'import io,sys,json,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("run/evidence.json",sys.stdin.read()); z.close(); sys.stdout.buffer.write(b.getvalue())'], { input: JSON.stringify(evidence) });
  return { metadata: { id, name: prefix + revision, expired: false, size_in_bytes: archive.length,
    digest: "sha256:" + createHash("sha256").update(archive).digest("hex"),
    workflow_run: { id: 10, head_sha: HEAD }, created_at: "2026-01-01T00:10:00Z" }, archive: archive.toString("base64") };
}

function makeWorld(overrides = {}) {
  const candidate = artifact(101, "acceptance-evidence-", HEAD);
  const proposed = artifact(102, "merge-result-evidence-", PROPOSED_SHA);
  return {
    repo: "org/repo",
    pr: { headRefOid: HEAD, baseRefName: "v2", baseRefOid: BASE, isDraft: false, body: "Refs #1", author: { login: "author-bot" }, files: ["x"] },
    diff: DIFF,
    effectiveRules: [{ type: "required_status_checks", ruleset_source_type: "Repository", ruleset_source: "org/repo", ruleset_id: 77,
      parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "release-gates" }] } }],
    serverRuleset: { id: 77, target: "branch", enforcement: "active", bypass_actors: [], rules: [
      { type: "pull_request" },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "release-gates" }] } },
    ] },
    pull: { merge_commit_sha: PROPOSED_SHA },
    commits: {
      [HEAD]: { commit: { tree: { sha: TREE } } },
      [PROPOSED_SHA]: { parents: [{ sha: BASE }, { sha: HEAD }], commit: { tree: { sha: PROPOSED_TREE } } },
      [MERGE_SHA]: { parents: [{ sha: BASE }, { sha: HEAD }], commit: { tree: { sha: PROPOSED_TREE } } },
    },
    ciRuns: [makeRun(10, HEAD, "pull_request")],
    pushRuns: [makeRun(20, MERGE_SHA, "push")],
    artifacts: [candidate.metadata, proposed.metadata],
    archives: { 101: candidate.archive, 102: proposed.archive },
    jobs: { 10: [{ name: "release-gates", conclusion: "success", steps: [
      { name: "Upload acceptance evidence", conclusion: "success", started_at: "2026-01-01T00:09:00Z", completed_at: "2026-01-01T00:11:00Z" },
      { name: "Upload merge-result evidence", conclusion: "success", started_at: "2026-01-01T00:09:00Z", completed_at: "2026-01-01T00:11:00Z" },
    ] }], 20: [{ name: "release-gates", conclusion: "success" }] },
    reviews: [],
    threads: [],
    ref: { object: { sha: MERGE_SHA } },
    afterMerge: { state: "MERGED", mergeCommit: { oid: MERGE_SHA }, headRefOid: HEAD, baseRefOid: BASE },
    merge: { fail: false },
    ...overrides,
  };
}

function defaultReceipt(overrides = {}) {
  return {
    reviewerAgent: "reviewer-agent",
    implementerAgent: "implementer-agent",
    headSha: HEAD,
    baseSha: BASE,
    sourceTreeSha: TREE,
    deltaSha256: createHash("sha256").update(DIFF).digest("hex"),
    changedFiles: ["x"],
    unresolvedBlockingFindings: 0,
    ...overrides,
  };
}

const cleanups = [];
test.after(() => cleanups.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scaffold({ world = makeWorld(), receipt = defaultReceipt(), receiptText = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-fixture-"));
  cleanups.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, FAKE_GH, { mode: 0o755 });
  const worldPath = join(dir, "world.json");
  const logPath = join(dir, "gh.log");
  writeFileSync(worldPath, JSON.stringify(world));
  const receiptPath = join(dir, "receipt.json");
  writeFileSync(receiptPath, receiptText ?? JSON.stringify(receipt));
  const outcomePath = join(dir, "outcome.json");
  return { dir, bin, worldPath, logPath, receiptPath, outcomePath, world };
}

let receiptNumber = 0;

function controllerEnvironment(fixture, sourceEnv = process.env) {
  const { GITHUB_REPOSITORY: _githubRepository, ...inheritedEnv } = sourceEnv;
  return { ...inheritedEnv, PATH: fixture.bin + ":" + sourceEnv.PATH, FAKE_GH_WORLD: fixture.worldPath, FAKE_GH_LOG: fixture.logPath };
}

function runController(fixture, extraArgs = [], cwd = REPO_ROOT, script = SCRIPT) {
  const env = controllerEnvironment(fixture);
  const args = [script, "1", "--outcome", fixture.outcomePath, "--receipt", fixture.receiptPath, "--expected-reviewer", "reviewer-agent", "--expected-implementer", "implementer-agent", ...extraArgs];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env, cwd });
  const calls = existsSync(fixture.logPath) ? readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const mergeCalls = calls.filter((call) => call[0] === "pr" && call[1] === "merge");
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* non-JSON */ }
  if (process.env.CONTROLLER_CORRECTION_EVIDENCE) {
    const output = process.env.CONTROLLER_CORRECTION_EVIDENCE;
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${++receiptNumber}.json`), JSON.stringify({ script, sourceSha256: createHash("sha256").update(readFileSync(script)).digest("hex"), args, cwd,
      receipt: existsSync(fixture.receiptPath) ? readFileSync(fixture.receiptPath, "utf8") : null,
      world: JSON.parse(readFileSync(fixture.worldPath, "utf8")), status: result.status, stdout: result.stdout, stderr: result.stderr, calls, mergeCalls, json }, null, 2));
  }
  return { ...result, calls, mergeCalls, json };
}

test("valid dry-run passes without invoking merge", () => {
  const fixture = scaffold();
  const result = runController(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "dry-run");
  assert.equal(result.mergeCalls.length, 0);
});

test("valid apply merges exactly once and verifies push gates", () => {
  const fixture = scaffold();
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "merged-and-verified");
  assert.equal(result.mergeCalls.length, 1);
  assert.deepEqual(result.mergeCalls[0], ["pr", "merge", "1", "--repo", "org/repo", "--merge", "--match-head-commit", HEAD]);
});

const rejectionCases = [
  ["missing receipt file", (fixture) => { rmSync(fixture.receiptPath); }, /receipt/],
  ["missing blocking findings field", (fixture) => { const r = defaultReceipt(); delete r.unresolvedBlockingFindings; writeFileSync(fixture.receiptPath, JSON.stringify(r)); }, /zero unresolved blocking findings/],
  ["non-zero blocking findings", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ unresolvedBlockingFindings: 1 }))); }, /zero unresolved blocking findings/],
  ["self review", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ reviewerAgent: "implementer-agent" }))); }, /distinct from implementer/],
  ["wrong expected reviewer", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ reviewerAgent: "someone-else" }))); }, /does not match trusted expected reviewer/],
  ["stale head", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ headSha: "0".repeat(40) }))); }, /head does not match current PR head/],
  ["wrong base", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ baseSha: "0".repeat(40) }))); }, /base does not match current PR base/],
  ["wrong source tree", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ sourceTreeSha: "0".repeat(40) }))); }, /source tree does not match/],
  ["unverified delta", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ deltaSha256: "0".repeat(64) }))); }, /delta digest does not match/],
  ["wrong changed files", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ changedFiles: ["y"] }))); }, /changed files do not match/],
  ["unknown receipt field", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify({ ...defaultReceipt(), untrusted: true })); }, /contains unknown field/],
  ["duplicate receipt changed files", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ changedFiles: ["x", "x"] }))); }, /must not contain duplicates/],
  ["failed CI", (fixture) => { fixture.world.ciRuns[0].conclusion = "failure"; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /release-gates/],
  ["missing CI", (fixture) => { fixture.world.ciRuns = []; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /release-gates/],
  ["unresolved thread", (fixture) => { fixture.world.threads = [{ isResolved: false }]; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /unresolved/],
  ["open dependency", (fixture) => { fixture.world.pr.body = "Refs #1\nDependencies: #9"; fixture.world.issues = { 9: { number: 9, state: "OPEN" } }; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /dependency/],
  ["draft PR", (fixture) => { fixture.world.pr.isDraft = true; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /draft/],
  ["wrong PR base branch", (fixture) => { fixture.world.pr.baseRefName = "main"; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /base branch/],
  ["proposed merge parents mismatch", (fixture) => { fixture.world.commits[PROPOSED_SHA].parents = [{ sha: HEAD }, { sha: BASE }]; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /proposed merge parents/],
];

for (const [name, mutate, pattern] of rejectionCases) {
  test(`rejects ${name} without invoking merge`, () => {
    const fixture = scaffold();
    mutate(fixture);
    fixture.world = JSON.parse(readFileSync(fixture.worldPath, "utf8"));
    const result = runController(fixture, ["--apply"]);
    assert.equal(result.mergeCalls.length, 0, name === "non-zero blocking findings" ? "blocking findings must reject through the actual CLI validator" : `${name} must not invoke merge`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, pattern);
    assert.equal(result.mergeCalls.length, 0);
  });
}

test("rejects candidate-owned receipt inside the candidate checkout", () => {
  const fixture = scaffold();
  const inside = join(REPO_ROOT, "candidate-receipt.json");
  writeFileSync(inside, JSON.stringify(defaultReceipt()));
  cleanups.push(inside);
  const result = runController({ ...fixture, receiptPath: inside }, ["--apply"]);
  assert.match(result.stdout, /candidate-owned review receipt rejected/);
  assert.equal(result.mergeCalls.length, 0);
});

test("rejects symlink escaping into the candidate checkout", () => {
  const fixture = scaffold();
  const inside = join(REPO_ROOT, "candidate-receipt.json");
  writeFileSync(inside, JSON.stringify(defaultReceipt()));
  cleanups.push(inside);
  const link = join(fixture.dir, "link-receipt.json");
  symlinkSync(inside, link);
  const result = runController({ ...fixture, receiptPath: link }, ["--apply"]);
  assert.match(result.stdout, /candidate-owned review receipt rejected/);
  assert.equal(result.mergeCalls.length, 0);
});

test("rejects TOCTOU head change before merge", () => {
  const ALT_HEAD = "0".repeat(40);
  const world = makeWorld({ headSequence: [HEAD, ALT_HEAD] });
  world.commits[ALT_HEAD] = { commit: { tree: { sha: TREE } } };
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rejected-toctou/);
  assert.equal(result.mergeCalls.length, 0);
});

test("rejects final proposed merge identity change before merge", () => {
  const changedSha = "9".repeat(40);
  const world = makeWorld({ proposedMergeSequence: [PROPOSED_SHA, PROPOSED_SHA, changedSha] });
  world.commits[changedSha] = { parents: [{ sha: BASE }, { sha: HEAD }], commit: { tree: { sha: PROPOSED_TREE } } };
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rejected-toctou/);
  assert.equal(result.mergeCalls.length, 0, "final proposed merge identity change must not invoke merge");
});

test("postmerge parents mismatch is not merged-and-verified", () => {
  const world = makeWorld();
  world.commits[MERGE_SHA] = { parents: [{ sha: BASE }], commit: { tree: { sha: PROPOSED_TREE } } };
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "postmerge-verification-failed");
  assert.match(result.stdout, /merge parents mismatch/);
});

test("postmerge tree mismatch is not merged-and-verified", () => {
  const world = makeWorld();
  world.commits[MERGE_SHA].commit.tree.sha = "0".repeat(40);
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "postmerge-verification-failed");
  assert.match(result.stdout, /merge tree mismatch/);
});

test("missing exact push stops as waiting, not merged-and-verified", () => {
  const world = makeWorld({ ref: { object: { sha: "0".repeat(40) } } });
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "waiting-for-push-verification");
  assert.equal(result.mergeCalls.length, 1);
});

test("failed post-push release gates stop as waiting", () => {
  const world = makeWorld();
  world.jobs[20] = [{ name: "release-gates", conclusion: "failure" }];
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "waiting-for-push-verification");
});

test("merge command failure emits stable outcome without gh output", () => {
  const rawStdout = "untrusted merge stdout";
  const rawStderr = "untrusted merge stderr";
  const world = makeWorld({ merge: { fail: true, stdout: rawStdout, message: rawStderr } });
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "merge-failed");
  assert.deepEqual(result.json.postMerge, { code: "merge-command-failed", message: "GitHub merge command failed" });
  assert.doesNotMatch(result.stdout, new RegExp(`${rawStdout}|${rawStderr}`));
  assert.equal(result.mergeCalls.length, 1);
});

test("post-merge gh failures emit stable outcome without external messages", () => {
  for (const [field, raw] of [["postMergeViewError", "untrusted view error"], ["postMergeCommitError", "untrusted commit error"], ["postMergeRefError", "untrusted ref error"]]) {
    const fixture = scaffold({ world: makeWorld({ [field]: raw }) });
    const result = runController(fixture, ["--apply"]);
    assert.equal(result.status, 1, field);
    assert.equal(result.json.outcome, "waiting-for-push-verification", field);
    assert.deepEqual(result.json.postMerge, { code: "postmerge-evidence-unavailable", message: "Post-merge verification evidence unavailable" }, field);
    assert.doesNotMatch(result.stdout, new RegExp(raw), field);
    assert.equal(result.mergeCalls.length, 1, field);
  }
});

test("check mode verifies an already merged PR without merging", () => {
  const fixture = scaffold();
  const applied = runController(fixture, ["--apply"]);
  assert.equal(applied.json.outcome, "merged-and-verified");
  rmSync(fixture.logPath);
  fixture.world.afterMerge.baseRefOid = MERGE_SHA;
  writeFileSync(fixture.worldPath, JSON.stringify(fixture.world));
  const result = runController(fixture, ["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "merged-and-verified");
  assert.equal(result.mergeCalls.length, 0);
});

test("guard removal control: bypassing receipt validation reddens the named assertion, restore is green", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const guard = 'if (typeof receipt.unresolvedBlockingFindings !== "number" || !Number.isInteger(receipt.unresolvedBlockingFindings) || receipt.unresolvedBlockingFindings !== 0) {';
  const fixture = scaffold({ receipt: defaultReceipt({ unresolvedBlockingFindings: 1 }) });
  const rejected = runController(fixture, ["--apply"]);
  assert.match(rejected.stdout, /zero unresolved blocking findings/);
  assert.equal(rejected.mergeCalls.length, 0, "blocking findings must reject through the actual CLI validator");
  const root = join(fixture.dir, "source");
  mkdirSync(join(root, "scripts"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  const copy = join(realpathSync(root), "scripts", "merge-controller.mjs");
  writeFileSync(join(root, "scripts", "merge-eligibility.mjs"), readFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url)));
  const mutant = source.replace(guard, 'if (false) {');
  assert.notEqual(mutant, source);
  writeFileSync(copy, mutant);
  const bypassFixture = scaffold({ receipt: defaultReceipt({ unresolvedBlockingFindings: 1 }) });
  const bypass = runController(bypassFixture, ["--apply"], REPO_ROOT, copy);
  assert.equal(bypass.stderr, "", "disabled guard must reach the CLI acceptance boundary rather than import failure");
  assert.equal(bypass.status, 0, bypass.stdout);
  assert.equal(bypass.json.outcome, "merged-and-verified");
  assert.equal(bypass.mergeCalls.length, 1, "disabled guard must invoke the fake merge exactly once");
  assert.throws(() => assert.equal(bypass.mergeCalls.length, 0, "blocking findings must reject through the actual CLI validator"), /blocking findings must reject/);
  writeFileSync(copy, source);
  assert.equal(createHash("sha256").update(readFileSync(copy)).digest("hex"), sourceHash);
  const restored = runController(scaffold({ receipt: defaultReceipt({ unresolvedBlockingFindings: 1 }) }), ["--apply"], REPO_ROOT, copy);
  assert.match(restored.stdout, /zero unresolved blocking findings/);
  assert.equal(restored.mergeCalls.length, 0, "blocking findings must reject through the actual CLI validator");
  assert.equal(createHash("sha256").update(readFileSync(SCRIPT)).digest("hex"), sourceHash);
});

function saveWorld(fixture) { writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }

for (const conclusion of ["failure", "skipped", null]) {
  test(`latest ${conclusion ?? "pending"} exact push must stop continuation`, () => {
    const world = makeWorld();
    world.pushRuns.push(makeRun(21, MERGE_SHA, "push", { conclusion, status: conclusion ? "completed" : "in_progress" }));
    world.jobs[21] = [{ name: "release-gates", conclusion }];
    const result = runController(scaffold({ world }), ["--apply"]);
    assert.equal(result.json.outcome, "waiting-for-push-verification", "latest failed or skipped exact push must stop dependent continuation");
    assert.equal(result.mergeCalls.length, 1);
  });
}

test("latest rerun attempt must not reuse earlier successful jobs", () => {
  const world = makeWorld();
  world.pushRuns.push(makeRun(20, MERGE_SHA, "push", { run_attempt: 2, conclusion: "failure" }));
  const result = runController(scaffold({ world }), ["--apply"]);
  assert.equal(result.json.outcome, "waiting-for-push-verification");
});

test("CI for an old base without current proposed-tree evidence must not invoke merge", () => {
  const fixture = scaffold();
  fixture.world.ciRuns[0].pull_requests = [{ number: 1, head: { sha: HEAD }, base: { sha: "0".repeat(40) } }];
  fixture.world.artifacts = [];
  saveWorld(fixture);
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.mergeCalls.length, 0, "CI for an old base without current proposed-tree evidence must not invoke merge");
});

for (const fault of ["wrong tested revision", "wrong tested parents", "expired artifact", "old attempt artifact", "digest mismatch", "missing candidate artifact", "failed source evidence"]) {
  test(`rejects ${fault} before merge`, () => {
    const fixture = scaffold();
    if (fault === "wrong tested revision") fixture.world.artifacts[1].name = "merge-result-evidence-" + "0".repeat(40);
    if (fault === "wrong tested parents") fixture.world.commits[PROPOSED_SHA].parents[0].sha = "0".repeat(40);
    if (fault === "expired artifact") fixture.world.artifacts[1].expired = true;
    if (fault === "old attempt artifact") fixture.world.ciRuns[0].run_started_at = "2026-01-01T00:20:00Z";
    if (fault === "digest mismatch") fixture.world.artifacts[1].digest = "sha256:" + "0".repeat(64);
    if (fault === "missing candidate artifact") fixture.world.artifacts.shift();
    if (fault === "failed source evidence") {
      const bad = artifact(102, "merge-result-evidence-", "0".repeat(40));
      fixture.world.archives[102] = bad.archive;
      fixture.world.artifacts[1].digest = bad.metadata.digest;
      fixture.world.artifacts[1].size_in_bytes = bad.metadata.size_in_bytes;
    }
    saveWorld(fixture);
    const result = runController(fixture, ["--apply"]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, fault === "wrong tested parents" ? "proposed-merge-mismatch" : "tested-source");
    assert.equal(result.mergeCalls.length, 0, "missing or unbound tested source must reject before merge");
  });
}

test("check must not verify an unbound tree without its trusted apply evidence", () => {
  const fixture = scaffold(); rmSync(fixture.receiptPath);
  const result = runController(fixture, ["--check"]);
  assert.notEqual(result.json.outcome, "merged-and-verified", "check must not verify an unbound tree without its trusted apply evidence");
});

for (const tree of [undefined, "0".repeat(40)]) {
  test(`check rejects ${tree ? "different" : "missing"} merge tree against frozen intent`, () => {
    const fixture = scaffold();
    assert.equal(runController(fixture, ["--apply"]).status, 0);
    fixture.world.commits[MERGE_SHA].commit.tree = tree ? { sha: tree } : undefined;
    fixture.world.afterMerge.baseRefOid = MERGE_SHA;
    saveWorld(fixture);
    const result = runController(fixture, ["--check"]);
    assert.equal(result.json.outcome, "postmerge-verification-failed", "missing or unbound merge-tree evidence must never count as verified");
  });
}

test("candidate-owned receipt remains rejected independently of launch cwd", () => {
  const fixture = scaffold();
  const inside = join(REPO_ROOT, "candidate-receipt-other-cwd.json");
  writeFileSync(inside, JSON.stringify(defaultReceipt())); cleanups.push(inside);
  const other = join(fixture.dir, "other"); mkdirSync(other);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: other }).status, 0);
  const result = runController({ ...fixture, receiptPath: inside }, ["--apply"], other);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /candidate-owned review receipt rejected/);
  assert.equal(result.mergeCalls.length, 0, "candidate-owned review receipt must remain rejected independently of launch cwd");
});

test("revoked trusted receipt at recheck must prevent merge", () => {
  const fixture = scaffold();
  fixture.world.revokeReceipt = true; fixture.world.receiptPath = fixture.receiptPath;
  fixture.world.revokedReceipt = defaultReceipt({ unresolvedBlockingFindings: 1 }); saveWorld(fixture);
  const result = runController(fixture, ["--apply"]);
  assert.equal(JSON.parse(readFileSync(fixture.receiptPath)).unresolvedBlockingFindings, 1);
  assert.equal(result.mergeCalls.length, 0, "revoked trusted receipt at recheck must prevent merge");
});

test("third PR read receipt revocation rejects before intent or merge", (t) => {
  const revokedFixture = () => {
    const fixture = scaffold();
    fixture.world.revokeReceipt = true;
    fixture.world.revokeReceiptRead = 3;
    fixture.world.receiptPath = fixture.receiptPath;
    fixture.world.revokedReceipt = defaultReceipt({ unresolvedBlockingFindings: 1 });
    saveWorld(fixture);
    return fixture;
  };
  const fixture = revokedFixture();
  const result = runController(fixture, ["--apply"]);
  assert.equal(JSON.parse(readFileSync(fixture.worldPath)).reads, 3);
  assert.equal(JSON.parse(readFileSync(fixture.receiptPath)).unresolvedBlockingFindings, 1);
  assert.equal(result.mergeCalls.length, 0, "third-read revocation must prevent merge");
  assert.notEqual(result.status, 0);
  assert.equal(result.json.outcome, "rejected");
  assert.equal(result.json.code, "receipt-changed");
  assert.equal(JSON.parse(readFileSync(fixture.outcomePath)).applyIntent, undefined, "revocation must precede persisted apply intent");

  const source = readFileSync(SCRIPT, "utf8");
  const start = source.indexOf("  // GitHub reads above may outlive a receipt revocation;");
  const end = source.indexOf("  const workflowId = evidence.workflow.id;", start);
  assert.ok(start > 0 && end > start);
  const guard = source.slice(start, end);
  const mutant = source.replace(guard, "").replace("  const finalPrecheck = collectEvidence(repo, args.pr);", guard + "  const finalPrecheck = collectEvidence(repo, args.pr);");
  assert.notEqual(mutant, source);
  const root = join(fixture.dir, "source");
  mkdirSync(join(root, "scripts"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  const copy = join(realpathSync(root), "scripts", "merge-controller.mjs");
  writeFileSync(join(root, "scripts", "merge-eligibility.mjs"), readFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url)));
  writeFileSync(copy, mutant);
  assert.equal(readFileSync(copy, "utf8"), mutant);
  const bypass = runController(revokedFixture(), ["--apply"], REPO_ROOT, copy);
  assert.equal(bypass.status, 0, bypass.stdout + bypass.stderr);
  assert.equal(bypass.json.outcome, "merged-and-verified");
  assert.equal(bypass.mergeCalls.length, 1);
  assert.throws(() => assert.equal(bypass.mergeCalls.length, 0, "third-read revocation must prevent merge"), /third-read revocation must prevent merge/);
  writeFileSync(copy, source);
  assert.equal(readFileSync(copy, "utf8"), source);
  const restored = runController(revokedFixture(), ["--apply"], REPO_ROOT, copy);
  assert.equal(restored.mergeCalls.length, 0);
  assert.notEqual(restored.status, 0);
  assert.equal(restored.json.code, "receipt-changed");
  assert.equal(readFileSync(SCRIPT, "utf8"), source);
  t.diagnostic(JSON.stringify({ green: { status: result.status, outcome: result.json.outcome, mergeCalls: result.mergeCalls.length }, red: { status: bypass.status, outcome: bypass.json.outcome, mergeCalls: bypass.mergeCalls.length }, restored: { status: restored.status, outcome: restored.json.outcome, mergeCalls: restored.mergeCalls.length } }));
});

test("revoked trusted receipt during check must not emit merged-and-verified", () => {
  const fixture = scaffold();
  assert.equal(runController(fixture, ["--apply"]).json.outcome, "merged-and-verified");
  rmSync(fixture.logPath);
  fixture.world.afterMerge.baseRefOid = MERGE_SHA;
  fixture.world.revokeReceiptDuringCheck = true;
  fixture.world.receiptPath = fixture.receiptPath;
  fixture.world.revokedReceipt = defaultReceipt({ unresolvedBlockingFindings: 1 });
  saveWorld(fixture);
  const result = runController(fixture, ["--check"]);
  assert.equal(JSON.parse(readFileSync(fixture.receiptPath)).unresolvedBlockingFindings, 1);
  assert.notEqual(result.json.outcome, "merged-and-verified", "receipt revocation during check must prevent success");
  assert.equal(result.json.code, "receipt-changed");
  assert.equal(result.mergeCalls.length, 0);
});

test("isolated Python ZIP reader ignores shadow zipfile in launch cwd", () => {
  const shadowDir = mkdtempSync(join(tmpdir(), "mc-shadow-zipfile-"));
  cleanups.push(shadowDir);
  const marker = join(shadowDir, "zipfile-shadow-executed");
  writeFileSync(join(shadowDir, "zipfile.py"), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nraise SystemExit(42)\n`);
  const fixture = scaffold();
  const result = runController(fixture, ["--apply"], shadowDir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.outcome, "merged-and-verified");
  assert.equal(existsSync(marker), false, "a shadow zipfile.py in the launch directory must not be imported");
  assert.equal(result.mergeCalls.length, 1);

  const root = join(fixture.dir, "shadow-source");
  mkdirSync(join(root, "scripts"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  const copy = join(realpathSync(root), "scripts", "merge-controller.mjs");
  writeFileSync(join(root, "scripts", "merge-eligibility.mjs"), readFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url)));
  const source = readFileSync(SCRIPT, "utf8");
  const anchor = '["-I", "-c", READ_EVIDENCE_ZIP]';
  assert.equal(source.split(anchor).length, 2, "isolated import anchor must be unique");
  writeFileSync(copy, source.replace(anchor, '["-c", READ_EVIDENCE_ZIP]'));
  const control = runController(scaffold(), ["--apply"], shadowDir, copy);
  assert.equal(existsSync(marker), true, "control must prove the shadow module executes without -I");
  assert.notEqual(control.json.outcome, "merged-and-verified");
  assert.equal(control.mergeCalls.length, 0);
});

test("partly unavailable changed-file inventory must not authorize merge", () => {
  const world = makeWorld(); world.pr.files = ["x", null];
  const result = runController(scaffold({ world }), ["--apply"]);
  assert.match(result.stdout, /changed files unavailable or malformed/);
  assert.equal(result.mergeCalls.length, 0, "partly unavailable changed-file inventory must not authorize merge");
});

test("truncated changed-file inventory must not authorize merge", () => {
  const world = makeWorld(); world.pr.files = Array.from({ length: 101 }, (_, index) => `file-${index}`);
  const result = runController(scaffold({ world }), ["--apply"]);
  assert.match(result.stdout, /inventory incomplete or exceeds controller bound/);
  assert.equal(result.mergeCalls.length, 0, "an inventory beyond the controller bound must reject before merge");
});

test("requested durable outcome failure must not be silently successful", () => {
  const fixture = scaffold();
  fixture.outcomePath = join(fixture.dir, "absent", "outcome.json");
  const result = runController(fixture, ["--apply"]);
  assert.notEqual(result.status, 0, "requested durable outcome failure must not be silently successful");
  assert.equal(result.mergeCalls.length, 0, "outcome preflight must reject before merge");
});

test("postmerge persistence failure preserves truthful merge state and stops continuation", () => {
  const fixture = scaffold();
  const output = join(fixture.dir, "output"); mkdirSync(output);
  fixture.outcomePath = join(output, "outcome.json");
  fixture.world.loseOutcome = true; fixture.world.outcomePath = fixture.outcomePath; saveWorld(fixture);
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "outcome-persistence-failed");
  assert.equal(result.json.operation.outcome, "merged-and-verified");
  assert.equal(result.mergeCalls.length, 1);
});

test("latest successful push rerun selects its own attempt jobs", () => {
  const world = makeWorld();
  world.pushRuns.push(makeRun(20, MERGE_SHA, "push", { run_attempt: 2 }));
  const result = runController(scaffold({ world }), ["--apply"]);
  assert.equal(result.json.outcome, "merged-and-verified");
  assert.ok(result.calls.some((call) => call.includes("repos/org/repo/actions/runs/20/attempts/2/jobs?per_page=100")));
});

test("repeated apply preserves the frozen intent and never merges twice", () => {
  const fixture = scaffold();
  assert.equal(runController(fixture, ["--apply"]).status, 0);
  const saved = readFileSync(fixture.outcomePath, "utf8"); rmSync(fixture.logPath);
  const repeated = runController(fixture, ["--apply"]);
  assert.equal(repeated.status, 1); assert.equal(repeated.mergeCalls.length, 0);
  assert.equal(readFileSync(fixture.outcomePath, "utf8"), saved);
});

test("artifact from an earlier upload step cannot authorize a successful rerun", () => {
  const world = makeWorld();
  for (const step of world.jobs[10][0].steps) { step.started_at = "2026-01-01T00:20:00Z"; step.completed_at = "2026-01-01T00:21:00Z"; }
  const result = runController(scaffold({ world }), ["--apply"]);
  assert.equal(result.json.code, "tested-source"); assert.equal(result.mergeCalls.length, 0);
});

test("base moves after final evidence before merge rejects without merge", () => {
  const ALT_BASE = "0".repeat(40);
  const world = makeWorld({ baseSequence: [BASE, BASE, ALT_BASE] });
  world.commits[ALT_BASE] = { commit: { tree: { sha: TREE } } };
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rejected-toctou/);
  assert.equal(result.mergeCalls.length, 0);
});

test("concurrent applies: exactly one claims outcome and the other refuses", async () => {
  const fixture = scaffold();
  const runOnce = () => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, "1", "--outcome", fixture.outcomePath, "--receipt", fixture.receiptPath, "--expected-reviewer", "reviewer-agent", "--expected-implementer", "implementer-agent", "--apply"], {
      env: controllerEnvironment(fixture, { ...process.env, GITHUB_REPOSITORY: "ambient/unrelated" }),
      encoding: "utf8",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
  const [a, b] = await Promise.all([runOnce(), runOnce()]);
  const outcomes = [a, b].map((r) => { try { return JSON.parse(r.stdout).outcome; } catch { return null; } });
  assert.ok(outcomes.includes("merged-and-verified"), "one apply must complete the merge");
  assert.ok(outcomes.includes("rejected") || outcomes.some((r, i) => [a,b][i].stdout.includes("apply outcome already exists")), "the other apply must refuse the claimed outcome");
  const mergeCount = existsSync(fixture.logPath) ? readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c[0] === "pr" && c[1] === "merge").length : 0;
  assert.equal(mergeCount, 1, "exactly one merge may occur");
});

test("dry-run preserves existing apply intent", () => {
  const fixture = scaffold();
  assert.equal(runController(fixture, ["--apply"]).status, 0);
  rmSync(fixture.logPath, { force: true });
  const result = runController(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dry-run must not overwrite an existing outcome/);
  assert.equal(result.mergeCalls.length, 0);
});

test("entry executes from path containing spaces", () => {
  const spacedDir = join(realpathSync(tmpdir()), "mc spaced dir " + Date.now());
  mkdirSync(join(spacedDir, "scripts"), { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: spacedDir });
  const copy = join(spacedDir, "scripts", "merge-controller.mjs");
  writeFileSync(copy, readFileSync(SCRIPT));
  writeFileSync(join(spacedDir, "scripts", "merge-eligibility.mjs"), readFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url)));
  const fixture = scaffold();
  const result = runController(fixture, [], spacedDir, copy);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "dry-run");
  rmSync(spacedDir, { recursive: true, force: true });
});

test("failing gh child stderr never prints raw token", () => {
  const token = "ghp_RAWSECRET_TOKEN_VALUE";
  const world = makeWorld({ leakToken: token });
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  assert.equal(result.mergeCalls.length, 0);
});


test("refuses apply without strict server current-base checks", () => {
  const fixture = scaffold({ world: makeWorld({ effectiveRules: [] }) });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.mergeCalls.length, 0, "missing strict server guard must prevent merge");
  assert.notEqual(result.status, 0);
});

test("refuses apply with a bypassable server current-base rule", () => {
  const world = makeWorld();
  world.serverRuleset.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  const result = runController(scaffold({ world }), ["--apply"]);
  assert.equal(result.mergeCalls.length, 0, "bypassable strict server guard must prevent merge");
  assert.notEqual(result.status, 0);
});

test("third PR read unresolved threads reject before intent or merge", () => {
  const fixture = scaffold({ world: makeWorld({ finalThreads: [{ isResolved: false }] }) });
  const result = runController(fixture, ["--apply"]);
  assert.equal(JSON.parse(readFileSync(fixture.worldPath)).prReads, 3);
  assert.equal(result.mergeCalls.length, 0, "final unresolved threads must prevent merge");
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(fixture.outcomePath)).applyIntent, undefined);
});

test("third PR read changed CI attempt rejects before intent or merge", () => {
  const world = makeWorld({ finalCiRuns: [makeRun(10, HEAD, "pull_request", { run_attempt: 2 })] });
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.mergeCalls.length, 0, "final changed CI attempt must prevent merge");
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(fixture.outcomePath)).applyIntent, undefined);
});

test("blocked dry-run preserves existing apply intent bytes", () => {
  const fixture = scaffold();
  assert.equal(runController(fixture, ["--apply"]).status, 0);
  const original = readFileSync(fixture.outcomePath, "utf8");
  writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ unresolvedBlockingFindings: 1 })));
  const result = runController(fixture);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(fixture.outcomePath, "utf8"), original, "blocked dry-run must preserve the saved apply intent bytes");
});

test("source fault controls exercise server protection, final authorization, and saved intent", (t) => {
  const source = readFileSync(SCRIPT, "utf8");
  const owner = scaffold();
  const root = join(owner.dir, "private-controller");
  mkdirSync(join(root, "scripts"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  const copy = join(realpathSync(root), "scripts", "merge-controller.mjs");
  writeFileSync(join(root, "scripts", "merge-eligibility.mjs"), readFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url)));
  const finalStart = source.indexOf("  const finalAuthorizationChanged = ");
  const finalEnd = source.indexOf("  const finalProposedMismatch = ", finalStart);
  assert.ok(finalStart > 0 && finalEnd > finalStart);
  const intentGuard = '  if (!args.apply && !args.check && args.outcome && existsSync(resolve(args.outcome))) fail("outcome", "dry-run must not overwrite an existing outcome; use --check");';
  assert.equal(source.split(intentGuard).length, 2);
  const rows = [
    { claim: "strict server guard", source: source.replace("function requireServerBaseGuard(repo, baseBranch) {", "function requireServerBaseGuard(repo, baseBranch) { return { bypass: true };"), fixture: () => scaffold({ world: makeWorld({ effectiveRules: [] }) }), assertion: "missing strict server guard must prevent merge" },
    { claim: "final unresolved threads", source: source.slice(0, finalStart) + "  const finalAuthorizationChanged = false;\n" + source.slice(finalEnd), fixture: () => scaffold({ world: makeWorld({ finalThreads: [{ isResolved: false }] }) }), assertion: "final unresolved threads must prevent merge" },
    { claim: "final CI attempt", source: source.slice(0, finalStart) + "  const finalAuthorizationChanged = false;\n" + source.slice(finalEnd), fixture: () => scaffold({ world: makeWorld({ finalCiRuns: [makeRun(10, HEAD, "pull_request", { run_attempt: 2 })] }) }), assertion: "final changed CI attempt must prevent merge" },
    { claim: "concurrent intent", source: source.replace("if (exclusive) linkSync(temp, target);", "if (false) linkSync(temp, target);"), fixture: () => scaffold(), assertion: "dry run must not overwrite a concurrently created apply intent", concurrentIntent: true },
    { claim: "saved intent", source: source.replace(intentGuard, "").replace("if (exclusive) linkSync(temp, target);", "if (false) linkSync(temp, target);"), fixture: () => scaffold(), assertion: "blocked dry-run must preserve the saved apply intent bytes", savedIntent: true },
  ];
  for (const row of rows) {
    assert.notEqual(row.source, source, row.claim + " mutation must apply");
    const exercise = () => {
      const fixture = row.fixture();
      if (row.concurrentIntent) {
        const saved = JSON.stringify({ outcome: "apply-intent", applyIntent: { headSha: HEAD, baseSha: BASE } });
        fixture.world.concurrentIntentPath = fixture.outcomePath;
        fixture.world.concurrentIntentBytes = saved;
        saveWorld(fixture);
        const result = runController(fixture, [], REPO_ROOT, copy);
        assert.equal(readFileSync(fixture.outcomePath, "utf8"), saved, row.assertion);
        assert.notEqual(result.status, 0);
        return;
      }
      if (row.savedIntent) {
        // Create an actual apply intent before a later blocked dry run.
        assert.equal(runController(fixture, ["--apply"], REPO_ROOT, copy).status, 0);
        const saved = readFileSync(fixture.outcomePath, "utf8");
        writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ unresolvedBlockingFindings: 1 })));
        const result = runController(fixture, [], REPO_ROOT, copy);
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(fixture.outcomePath, "utf8"), saved, row.assertion);
        return;
      }
      const result = runController(fixture, ["--apply"], REPO_ROOT, copy);
      assert.equal(result.mergeCalls.length, 0, row.assertion);
      assert.notEqual(result.status, 0);
    };
    writeFileSync(copy, source);
    exercise();
    writeFileSync(copy, row.source);
    assert.equal(readFileSync(copy, "utf8"), row.source);
    assert.throws(exercise, (error) => error.name === "AssertionError" && error.message.includes(row.assertion), row.claim + " must fail the intended assertion, not an import or fixture error");
    writeFileSync(copy, source);
    assert.equal(readFileSync(copy, "utf8"), source);
    exercise();
    t.diagnostic(JSON.stringify({ claim: row.claim, assertion: row.assertion, sourceSha256: createHash("sha256").update(source).digest("hex"), faultSha256: createHash("sha256").update(row.source).digest("hex"), restoredSha256: createHash("sha256").update(readFileSync(copy)).digest("hex"), phases: ["GREEN", "intended AssertionError RED", "restored GREEN"] }));
  }
  assert.equal(readFileSync(SCRIPT, "utf8"), source, "author source must remain byte-identical");
});

for (const findings of [0, 1]) {
  test(`dry run preserves a concurrently published intent with ${findings} findings`, () => {
    const fixture = scaffold({ receipt: defaultReceipt({ unresolvedBlockingFindings: findings }) });
    const saved = JSON.stringify({ outcome: "apply-intent", applyIntent: { headSha: HEAD, baseSha: BASE } });
    fixture.world.concurrentIntentPath = fixture.outcomePath;
    fixture.world.concurrentIntentBytes = saved;
    saveWorld(fixture);
    const result = runController(fixture);
    assert.equal(readFileSync(fixture.outcomePath, "utf8"), saved, "dry run must not overwrite a concurrently created apply intent");
    assert.notEqual(result.status, 0, "a lost exclusive output claim must stop the dry run");
    assert.equal(result.mergeCalls.length, 0);
  });
}
