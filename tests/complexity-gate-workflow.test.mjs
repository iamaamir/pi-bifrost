import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

test("the protected fetch step waits for GitHub to publish the merge ref", () => {
  assert.match(workflow, /MERGE_REF_RETRY_ATTEMPTS: "36"/u);
  assert.match(workflow, /MERGE_REF_RETRY_DELAY_SECONDS: "10"/u);
  const dir = mkdtempSync(join(tmpdir(), "bifrost-complexity-fetch-"));
  try {
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    const fakeBin = join(dir, "bin");
    mkdirSync(work);
    mkdirSync(fakeBin);
    const bare = spawnSync("git", ["init", "--bare", "-q", remote], { encoding: "utf8" });
    assert.equal(bare.status, 0, bare.stderr);
    git(work, ["init", "-q"]);
    git(work, ["remote", "add", "origin", remote]);
    const baseBranch = git(work, ["symbolic-ref", "--short", "HEAD"]);
    const base = commitFile(work, "base.ts", "export const base = true;\n", "base");
    git(work, ["checkout", "-q", "-b", "feature"]);
    const head = commitFile(work, "head.ts", "export const head = true;\n", "head");
    git(work, ["checkout", "-q", baseBranch]);
    git(work, ["merge", "--no-ff", "--no-edit", "feature"]);
    const merge = git(work, ["rev-parse", "HEAD"]);
    assert.notEqual(base, head);
    assert.notEqual(merge, head, "the fixture must be a two-parent merge commit, not a fast-forward");
    assert.equal(git(work, ["show", "-s", "--format=%P", merge]), `${base} ${head}`);
    git(work, ["push", "-q", "origin", `${head}:refs/pull/7/head`]);
    git(work, ["push", "-q", "origin", `${merge}:refs/heads/merge-source`]);

    const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realGit, "real git executable is required for the wrapper test");
    const wrapper = join(fakeBin, "git");
    writeFileSync(wrapper, `#!/bin/sh
if [ "$FAIL_FETCH" = "1" ]; then
  echo "fatal: Authentication failed for the remote repository" >&2
  exit 128
fi
if [ "$MISSING_HEAD" = "1" ]; then
  case " $* " in
    *"refs/pull/7/head"*)
      echo "fatal: couldn't find remote ref refs/pull/7/head" >&2
      exit 1
      ;;
  esac
fi
if [ "$MIXED_FETCH" = "1" ]; then
  case " $* " in
    *"refs/pull/7/merge"*)
      echo "fatal: couldn't find remote ref refs/pull/7/merge" >&2
      echo "fatal: unable to access the remote repository" >&2
      exit 1
      ;;
  esac
fi
if [ "$PUBLISH_MERGE" = "1" ] && [ ! -f "$MERGE_MARKER" ]; then
  case " $* " in
    *"refs/pull/7/merge"*)
      : > "$MERGE_MARKER"
      "$REAL_GIT" --git-dir="$REMOTE" update-ref refs/pull/7/merge "$MERGE_SHA" || exit 9
      echo "fatal: couldn't find remote ref refs/pull/7/merge" >&2
      exit 1
      ;;
  esac
fi
exec "$REAL_GIT" "$@"
`);
    chmodSync(wrapper, 0o755);

    const script = workflowRunBlock("Fetch the proposed head and merge result as data");
    const runStep = (overrides = {}) => spawnSync("bash", ["-e"], {
      cwd: work,
      env: {
        ...fixtureGitEnv(),
        PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
        PR_NUMBER: "7",
        MERGE_REF_RETRY_ATTEMPTS: "3",
        MERGE_REF_RETRY_DELAY_SECONDS: "0",
        PUBLISH_MERGE: "0",
        FAIL_FETCH: "0",
        MISSING_HEAD: "0",
        MIXED_FETCH: "0",
        MERGE_MARKER: join(dir, "merge-ref-published"),
        REAL_GIT: realGit,
        REMOTE: remote,
        MERGE_SHA: merge,
        ...overrides,
      },
      input: script,
      encoding: "utf8",
    });

    git(remote, ["update-ref", "refs/pull/7/merge", merge]);
    const immediate = runStep();
    assert.equal(immediate.status, 0, immediate.stderr);
    assert.doesNotMatch(immediate.stderr, /is unavailable \(attempt/u);
    assert.equal(git(work, ["rev-parse", "refs/remotes/pull/7/merge"]), merge);

    git(remote, ["update-ref", "-d", "refs/pull/7/merge"]);
    git(work, ["update-ref", "-d", "refs/remotes/pull/7/merge"]);
    const waiting = runStep({ PUBLISH_MERGE: "1" });
    assert.equal(waiting.status, 0, waiting.stderr);
    assert.match(waiting.stderr, /refs\/pull\/7\/merge is unavailable \(attempt 1\/3\); retrying/u);
    assert.equal(git(work, ["rev-parse", "refs/remotes/pull/7/merge"]), merge);

    git(remote, ["update-ref", "-d", "refs/pull/7/merge"]);
    git(work, ["update-ref", "-d", "refs/remotes/pull/7/merge"]);
    const exhausted = runStep();
    assert.notEqual(exhausted.status, 0);
    assert.match(exhausted.stderr, /did not publish refs\/pull\/7\/merge within 3 attempts/u);
    assert.match(exhausted.stderr, /conflicted pull request may never get a merge ref/u);

    const mixed = runStep({ MIXED_FETCH: "1" });
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /couldn't find remote ref refs\/pull\/7\/merge/u);
    assert.match(mixed.stderr, /unable to access the remote repository/u);
    assert.match(mixed.stderr, /not retrying/u);
    assert.doesNotMatch(mixed.stderr, /is unavailable \(attempt/u);

    const missingHead = runStep({ MISSING_HEAD: "1" });
    assert.notEqual(missingHead.status, 0);
    assert.match(missingHead.stderr, /head fetch failed; not retrying/u);
    assert.doesNotMatch(missingHead.stderr, /is unavailable \(attempt/u);

    const failed = runStep({ FAIL_FETCH: "1" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Authentication failed/u);
    assert.match(failed.stderr, /not retrying/u);
    assert.doesNotMatch(failed.stderr, /is unavailable \(attempt/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    git(dir, ["merge", "--no-ff", "--no-edit", "feature"]);
    const merge = git(dir, ["rev-parse", "HEAD"]);
    assert.notEqual(merge, head, "the stale-ref fixture must be a two-parent merge commit");

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
