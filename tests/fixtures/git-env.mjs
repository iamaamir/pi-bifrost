// Fixture `git` subprocesses must not inherit repo-redirecting environment
// variables: git gives them precedence over `cwd`, so when the suite runs
// under a git hook (which exports GIT_DIR) or similar automation, a fixture
// targeting a temp repo via `cwd` silently reads and writes the operator's
// real repository instead (issue #231).
const REPO_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
];

/**
 * Environment for fixture `git` spawns: the parent env minus the variables
 * that redirect git at another repository. All of these are unset in a normal
 * terminal, so ordinary runs are byte-for-byte unaffected.
 */
export function fixtureGitEnv() {
  const env = { ...process.env };
  for (const name of REPO_REDIRECT_VARS) delete env[name];
  return env;
}

/**
 * Runs `fn` with the repo-redirecting variables removed from process.env and
 * restores them afterwards. For in-process helpers whose git children inherit
 * the ambient env (runVerification, gitTruth, sourceFingerprint, controller
 * children) — an `env` option only covers the test's own direct spawns.
 */
export async function withFixtureEnv(fn) {
  const saved = {};
  for (const name of REPO_REDIRECT_VARS) {
    if (name in process.env) saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return await fn();
  } finally {
    for (const name of REPO_REDIRECT_VARS) {
      if (name in saved) process.env[name] = saved[name];
      else delete process.env[name];
    }
  }
}
