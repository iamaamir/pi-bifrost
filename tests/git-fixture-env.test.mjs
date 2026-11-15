import test from "node:test";
import assert from "node:assert/strict";
import { fixtureGitEnv } from "./fixtures/git-env.mjs";

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
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG"]) {
      assert.equal(name in env, false, `${name} must not leak into fixture git spawns`);
    }
    assert.equal(env.HOME, leaky.HOME); // non-redirecting vars pass through
  } finally {
    process.env = original;
  }
});
