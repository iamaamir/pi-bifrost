import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureGitEnv } from "./fixtures/git-env.mjs";

const workflow = readFileSync(new URL("../.github/workflows/complexity-gate.yml", import.meta.url), "utf8");

function workflowRunBlock(stepName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.includes(`name: ${stepName}`));
  assert.notEqual(start, -1, `workflow step not found: ${stepName}`);
  let index = start;
  while (index < lines.length && lines[index] !== "        run: |") index++;
  assert.ok(index < lines.length, `workflow step has no run block: ${stepName}`);
  index++;
  const body = [];
  while (index < lines.length && lines[index].startsWith("          ")) {
    body.push(lines[index].slice(10));
    index++;
  }
  return body.join("\n") + "\n";
}

function git(dir, args) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", ...args], {
    cwd: dir,
    env: fixtureGitEnv(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function commitFile(dir, rel, content, message) {
  writeFileSync(join(dir, rel), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--no-gpg-sign", "-qm", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}


test("CODEOWNERS covers the protected judge and every policy input", () => {
  const codeowners = readFileSync(new URL("../.github/CODEOWNERS", import.meta.url), "utf8");
  for (const path of [
    ".github/CODEOWNERS",
    "scripts/check-complexity.mjs",
    ".github/workflows/complexity-gate.yml",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
  ]) {
    assert.match(codeowners, new RegExp(`^/?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} @iamaamir$`, "mu"));
  }
  assert.match(codeowners, /^\/?\.github\/workflows\/ @iamaamir$/mu, "the bootstrap workflows share the owner route");
});

test("the trusted complexity gate runs from the protected base and measures the PR as data", () => {
  assert.match(workflow, /^on:\n(?: {2}#[^\n]*\n)* {2}pull_request_target:/mu);
  assert.match(workflow, /pull_request_target:\n {4}branches: \[main\]\n {4}types: \[opened, synchronize, reopened, ready_for_review, edited\]/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head/u);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/merge/u);
  assert.match(workflow, /--is-ancestor "\$base_sha" "\$merge_sha"/u);
  assert.match(workflow, /--is-ancestor "\$event_head_sha" "\$merge_sha"/u);
  assert.doesNotMatch(workflow, /pull_request\.head\.ref/u, "the candidate branch must not choose the judge");
  assert.equal((workflow.match(/npm ci/gu) ?? []).length, 1, "dependencies must be installed only for the protected judge");
});

test("the trusted gate checks both the PR delta and the proposed merge result", () => {
  assert.match(workflow, /--target "\$MERGE_BASE" --candidate "\$HEAD_SHA"/u);
  assert.match(workflow, /--target "\$BASE_SHA" --candidate "\$MERGE_SHA"/u);
  assert.match(workflow, /complexity-evidence\/delta\.json/u);
  assert.match(workflow, /complexity-evidence\/merge\.json/u);
  assert.doesNotMatch(workflow, /--allow-policy-change/u, "a candidate label must not authorize its own policy");
});

test("the protected revision step rejects a stale merge ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-complexity-workflow-"));
  const envFile = join(dir, "github-env");
  const summaryFile = join(dir, "github-summary");
  try {
    git(dir, ["init", "-q"]);
    const baseBranch = git(dir, ["symbolic-ref", "--short", "HEAD"]);
    commitFile(dir, "base.ts", "export const base = true;\n", "base");
    const baseTip = commitFile(dir, "base-tip.ts", "export const baseTip = true;\n", "base tip");

    git(dir, ["checkout", "-q", "-b", "feature", `${baseTip}~1`]);
    const head = commitFile(dir, "head.ts", "export const head = true;\n", "head");
    git(dir, ["checkout", "-q", baseBranch]);
    git(dir, ["merge", "--no-edit", "feature"]);
    const merge = git(dir, ["rev-parse", "HEAD"]);

    git(dir, ["update-ref", "refs/remotes/pull/7/head", head]);
    git(dir, ["update-ref", "refs/remotes/pull/7/merge", merge]);
    git(dir, ["checkout", "-q", baseTip]);
    writeFileSync(envFile, "");
    writeFileSync(summaryFile, "");

    const script = workflowRunBlock("Resolve the revisions for this run");
    const runStep = () => spawnSync("bash", ["-e"], {
      cwd: dir,
      env: {
        ...fixtureGitEnv(),
        PR_NUMBER: "7",
        HEAD_SHA: head,
        GITHUB_ENV: envFile,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
      input: script,
      encoding: "utf8",
    });

    const passing = runStep();
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(readFileSync(envFile, "utf8"), new RegExp(`MERGE_SHA=${merge}`, "u"));

    const mergeTree = git(dir, ["rev-parse", `${merge}^{tree}`]);
    const wrongParents = git(dir, ["commit-tree", mergeTree, "-p", head, "-p", baseTip, "-m", "wrong parent order"]);
    git(dir, ["update-ref", "refs/remotes/pull/7/merge", wrongParents]);
    const wrong = runStep();
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /does not have the intended parents/u);

    git(dir, ["update-ref", "refs/remotes/pull/7/merge", baseTip]);
    const stale = runStep();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /merge result is stale/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the protected gate rejects a candidate workflow that publishes its context", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-complexity-context-"));
  try {
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    commitFile(dir, ".github/workflows/other.yaml", "name: other\njobs:\n  complexity-trusted:\n    runs-on: ubuntu-latest\n", "duplicate context");
    const head = git(dir, ["rev-parse", "HEAD"]);
    const script = workflowRunBlock("Reject candidate workflows that publish the protected context");
    const runStep = () => spawnSync("bash", ["-e"], {
      cwd: dir,
      env: { ...fixtureGitEnv(), HEAD_SHA: head },
      input: script,
      encoding: "utf8",
    });

    const rejected = runStep();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /publishes the protected complexity-trusted context/u);

    commitFile(dir, ".github/workflows/other.yaml", "name: other\njobs:\n  build:\n    runs-on: ubuntu-latest\n", "remove duplicate context");
    const cleanHead = git(dir, ["rev-parse", "HEAD"]);
    const accepted = spawnSync("bash", ["-e"], {
      cwd: dir,
      env: { ...fixtureGitEnv(), HEAD_SHA: cleanHead },
      input: script,
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the trusted gate publishes replayable evidence from the resolved revisions", () => {
  assert.match(workflow, /BASE_SHA=\$base_sha/u);
  assert.match(workflow, /HEAD_SHA=\$event_head_sha/u);
  assert.match(workflow, /MERGE_SHA=\$merge_sha/u);
  assert.match(workflow, /MERGE_BASE=\$merge_base/u);
  assert.match(workflow, /name: complexity-evidence-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/complexity-evidence/u);
  assert.match(workflow, /permissions:\n {2}contents: read/u);
});
