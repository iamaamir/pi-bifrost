import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitEnv, REPO_REDIRECT_VARS, withFixtureEnv } from "./fixtures/git-env.mjs";

test("fixtureGitEnv strips every repo-redirecting variable (issue #231)", () => {
  const leaky = {
    ...process.env,
    GIT_DIR: "/operator/repo/.git",
    GIT_WORK_TREE: "/operator/repo",
    GIT_INDEX_FILE: "/operator/repo/.git/index",
    GIT_OBJECT_DIRECTORY: "/operator/repo/.git/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/operator/repo/.git/objects",
    GIT_COMMON_DIR: "/operator/repo/.git",
    GIT_NAMESPACE: "operator",
    GIT_CONFIG: "/operator/repo/.git/config",
  };
  const original = process.env;
  process.env = leaky;
  try {
    const env = fixtureGitEnv();
    for (const name of REPO_REDIRECT_VARS) {
      assert.equal(name in env, false, `${name} must not leak into fixture git spawns`);
    }
    assert.equal(env.HOME, leaky.HOME); // non-redirecting vars pass through
  } finally {
    process.env = original;
  }
});

test("withFixtureEnv scrubs redirects for the duration and restores them", async () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/operator/repo/.git";
  try {
    await withFixtureEnv(async () => {
      assert.equal("GIT_DIR" in process.env, false);
      assert.equal("GIT_WORK_TREE" in process.env, false);
    });
    assert.equal(process.env.GIT_DIR, "/operator/repo/.git");
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test("git children stay on the fixture repo under inherited redirects (issue #231 regression)", async () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-fixture-env-"));
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-fixture-scratch-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: fixtureGitEnv() });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: scratch, env: fixtureGitEnv() });
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(scratch, ".git");
    try {
      // No env option on purpose: the scrubbed process.env is what protects
      // this child, exactly as it protects in-process library helpers. Await
      // the helper so its restore runs before the scratch repo is deleted.
      await withFixtureEnv(() => {
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
      });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: fixtureGitEnv(), encoding: "utf8" }).trim();
      assert.match(head, /^[0-9a-f]{40}$/);
      // The redirected scratch repo must have received nothing.
      assert.throws(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratch, env: fixtureGitEnv() }));
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

