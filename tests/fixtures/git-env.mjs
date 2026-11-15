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
