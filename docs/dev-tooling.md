# Developer tooling

This guide lists the deterministic checks that guard the repository. Run
`npm run toolbox:doctor` to see which tools are installed. A missing tool is
reported as unavailable; it never counts as a pass.

## Setup

Install the repository dependencies first:

```bash
npm ci
```

The Node checks need no other install. The security and workflow checks use
separate tools. Install the pinned versions:

```bash
# actionlint and osv-scanner (Go)
GOBIN="$HOME/.local/bin" go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
GOBIN="$HOME/.local/bin" go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.7.0

# semgrep and zizmor (Python)
uv tool install semgrep==1.182.0
uv tool install zizmor==1.31.1

# gitleaks, hyperfine, difftastic, ripgrep, gh (Homebrew on macOS)
brew install gitleaks hyperfine difftastic ripgrep gh
```

CI installs the same versions. Do not upgrade one side alone.

## Commands

| Command | What it checks | Needs |
| --- | --- | --- |
| `npm run check:arch` | Import boundaries and cycles (`.dependency-cruiser.cjs`) | `npm ci` |
| `npm run check:dead-code` | Unused and unlisted dependencies (`knip.jsonc`) | `npm ci` |
| `npm run check:ast` | Structural rules, rule self-tests, and rule scope against tracked files (`sgconfig.yml`) | `npm ci` |
| `npm run check:duplication` | Copy-paste detection and threshold (`.jscpd.json`: TypeScript and JavaScript, `minTokens 50`, `minLines 10`, budget 3.3%) | `npm ci` |
| `npm run check:complexity` | Per-function complexity against a target revision measured from source (see [Complexity against a target revision](#complexity-against-a-target-revision)) | `npm ci`, git |
| `npm run check:complexity:base` | The tree against an explicit revision, such as the base commit of a pull request | `npm ci`, git |
| `npm run check:contracts` | Host integration contracts read from `index.ts` and `debug.ts` (`scripts/check-contracts.mjs`) | `npm ci` |
| `npm run check:actions` | Workflow syntax and expressions (actionlint) | actionlint |
| `npm run check:sast` | Repository Semgrep rules | semgrep |
| `npm run check:secrets` | Working-tree secret scan | gitleaks |
| `npm run check:secrets:history` | Full-history secret scan (slow) | gitleaks |
| `npm run check:deps` | Lockfile vulnerabilities (OSV) | osv-scanner |
| `npm run check:package` | Builds `dist/router`, then publint reports problems in the packed package | `npm ci` |
| `npm run lint` | Oxlint reports code findings; errors stop the command | `npm ci` |
| `npm run check:issue-refs` | Repository paths cited in tracker issues; on demand, not a gate (see [`tracker-workflow.md`](tracker-workflow.md)) | `gh` |
| `npm run check:pr-evidence` | A pull request body's head/base claims against the live PR, plus opt-in scans for removed user-visible phrases; on demand, not a gate (see [`testing-coverage.md`](testing-coverage.md#revision-bound-pr-evidence)) | `gh`, git |
| `npm run toolbox:doctor` | Tool availability and install hints | none |
| `npm run test:quick` | Quick local tier: typecheck + root tests minus the four heavy files (see `scripts/test-quick.mjs`) | `npm ci` |
| `scripts/git-hooks/pre-push` | Optional pre-push gate running `test:quick` plus the fast gates (`check:ast`, `check:duplication`, `check:complexity`); enable with `git config core.hooksPath scripts/git-hooks`, bypass with `--no-verify` | `npm ci` |

The pull request template follows the shape of the `pr` skill — Summary,
Evidence, Merge Danger, Verification — so a skill-written body and GitHub's
template describe the same PR. A PR that adds, removes, or changes a gate states
the gate's evidence in the **Gate evidence** subsection of Evidence: the command,
its real output, and what it catches that the other gates do not. A test pins
that subsection to the fast gates and checks the surrounding headings, so a new
gate or a dropped section cannot pass silently.

Add `--json` for a structured result:

```bash
npm run check:arch -- --json
```

Exit codes are `0` clean, `1` findings, and `2` unavailable tool or invalid
invocation. Every toolbox-backed check (`check:arch`, `check:dead-code`,
`check:ast`, `check:duplication`) accepts `--root <path>` to measure another tree
with this repository's tool binaries; the fault-control tests use it to run a real
gate against a fixture and assert its exit code. `check:complexity` is its own
script; `--repo <path>` points it at another repository and `--target <rev>`
names the revision to compare against.

`npm run lint` runs Oxlint 1.94.0 with the default rules. It reads source files,
tests, and scripts. It does not read types. Warnings do not stop CI. Broken
syntax and a bad configuration stop CI. No rule is set to error.

GitHub shows ten annotations for one step. The step summary lists all warnings
and errors by rule. An annotation is not a review comment. You cannot reply to it.

`npm run typecheck` runs `tsc --noEmit`. It reports type errors only.
`verification.yml` runs it. Lint and typecheck do not depend on each other.

`npm run check:package` builds `dist/router` first. Then publint packs the
package and reads each `exports` and `types` target. Publint reports missing
files and wrong module formats. `npm pack` alone does not read those targets.
Publint packs with `--dry-run`, so it skips `prepack`. The build must run first.

### Warnings we keep

- `eslint(no-unsafe-finally)`: Test teardown keeps the first error. The
  `finally` block rethrows the cleanup error or combines both errors in an
  `AggregateError`. The rule objects to that control flow.
- `unicorn(no-useless-spread)`: The spread copies a collection before a loop
  deletes from it.
- `unicorn(no-new-array)`: Three sites make an array of a known length. A loop
  fills it by index.
- `typescript(no-this-alias)`: A patched method saves a dynamic `this`. An arrow
  function would save the wrong receiver.
- `eslint(no-unassigned-vars)`: One test leaves a receipt unset on purpose. It
  then makes sure that the report has no receipt.

We turn off `eslint(no-control-regex)` for the whole repository. Twenty uses
match ANSI escape codes or reject control characters in model IDs and
configuration values.

PR 331 applies the mechanical fixes from `oxlint --fix`. Until it lands, you
will see more warning categories. None of them stop CI.

The architecture rules encode existing seams: the resolve-only router may use
Pi types but not the Pi runtime, host UI modules are imported only by the Pi
adapter entry points, shipped modules cannot import dev tooling, and no cycles
are allowed. A new rule must pass on the current tree before it is added.

Knip treats every root module as an entry point. `package.json` exports `./*`
and ships `*.ts`, so every root file is a public subpath. Knip still reports
unused dependencies, unlisted imports, unlisted binaries, and unresolved
paths. It does not report unused entry exports.

The duplication budget is measured, not guessed. `node scripts/duplication-audit.mjs`
runs jscpd over a `minTokens` x `minLines` grid and groups every clone by
directory, so the settings can be chosen from the clone population. It is an
audit, not a gate. Its captured output is committed in
[`quality/duplication-audit.md`](quality/duplication-audit.md).

The Semgrep rules live in `semgrep/`. Each rule has a matching fixture in
`tests/semgrep/targets/`. The fixture must contain one `ruleid:` example and
one `ok:` example. `npm run check:sast` scans the tree; the CI job also runs
`semgrep --test`, and the Node tests check that rule names and fixture names
stay aligned.

The Gitleaks allowlist in `.gitleaks.toml` covers only the `generic-api-key` rule. It ignores two exact synthetic canary values used by redaction fixtures regardless of file path, and additional reviewed fixture values only when their exact test-file paths also match. It does not allowlist whole files or other rules.

## Complexity against a target revision

No complexity snapshot is committed. The gate measures the candidate and a
target revision from source with the same analyzer, then ratchets the candidate
against the target:

```bash
npm run check:complexity
```

The target comes from `--target <rev>`, then `BIFROST_COMPLEXITY_BASE`, then
`GITHUB_BASE_SHA`, then the merge-base with `origin/main` or `main`. There is no
implicit `HEAD^` fallback: pass `--target HEAD^` explicitly for a last-commit
comparison. A revision that does not resolve fails the gate; it does not
silently fall back to a different tree. The candidate defaults to the working
tree and is reported with its HEAD revision, a dirty flag, and a digest of the
measured bytes. A working-tree change during measurement fails closed; CI passes
the explicit head commit instead.

`npm run check:complexity:base -- <rev>` supplies the target explicitly. On a
pull request CI compares the head against its merge-base with the base branch,
so a base-only policy move is not charged to the branch. The protected judge
also compares the proposed merge result against the base tip. The push leg
compares against the previous tip.

`quality/complexity-baseline.json` no longer exists. A routine change to
measured code needs no generated file and cannot conflict with another branch
through one. Rebase, re-run the gate, and the new target is measured again.

Tests must not write inside a measured path: root `*.ts`, `*.mjs`, `*.cjs`,
`ui/`, `scripts/`, or `tests/`. A temporary file there becomes part of a
concurrent candidate measurement. Write fixtures to a temp directory instead,
and pin any relative import to an absolute URL if the fixture must run from
outside the repository.

An incomplete measurement is a failure, not a warning: if a file disappears
while the analyzer reads a tree, the gate exits `2` and reports no verdict.

### Policy changes are not silent

The analyzer, its scope and threshold policy, the TypeScript version, and the
workflow files can change what the gate reports. The gate hashes those inputs at
both revisions. When the digests differ it exits `2` with
`complexity-policy-changed` unless the reviewed policy path authorizes the
migration. A candidate label is not by itself an approval.

The authoritative judge is
[`complexity-gate.yml`](../.github/workflows/complexity-gate.yml). GitHub runs
that `pull_request_target` workflow and its analyzer from the protected target
branch. It fetches the PR head once and fails immediately; it retries the merge
ref only when Git emits its exact missing-merge-ref diagnostic, so mixed or
unrelated failures also fail immediately. It measures both the PR delta and the
proposed merge result as data, and uploads the evidence. It never installs or
executes candidate code. A candidate label is not by itself an approval.

Zizmor flags `pull_request_target` as a dangerous trigger. The workflow uses a
line-scoped `# zizmor: ignore[dangerous-triggers]` annotation with the reason
inline. This is a documented exception, not a claim that the trigger is safe by
itself. Zizmor's preferred `pull_request` alternative cannot be the protected
judge because it runs candidate workflow code. Removing the exception requires
an external trusted check or a different protected design; do not widen it.

GitHub blocks `pull_request_target` by default in public repositories from
December 2, 2026 unless an applicable Actions event policy allows it. The
repository must have an owner-configured policy targeting only
`.github/workflows/complexity-gate.yml` and permitting that event; do not allow
it repository-wide. Configure it under Settings, Actions, Policies, then confirm
on Policy insights that this workflow is not listed as blocked. This is an
external repository-admin step and must be in place before the default
enforcement date.

The existing verification complexity job remains the bootstrap/local path until
the protected workflow is present on the target branch. The ruleset must require
the protected `complexity-trusted` context for that check to block merges. The
policy inputs (analyzer, workflows, `.github/CODEOWNERS`, `tsconfig.json`,
`package.json`, and the resolved TypeScript lock entry) are covered by
[`.github/CODEOWNERS`](../.github/CODEOWNERS), but code-owner review only blocks
when the ruleset requires it. The protected context is matched by name, so a
same-repository candidate workflow can create a duplicate job with that name;
the protected workflow's artifact is evidence, not a ruleset identity. A
complete UI-merge fix needs an app-scoped check, an organization/enterprise
required workflow, or a ruleset path restriction on workflow changes.

For a later owner policy migration, the owner verifies the candidate locally
with `--allow-policy-change`, captures the comparison and policy evidence, and
uses a repository-admin ruleset procedure outside the workflow. A candidate
label cannot authorize the protected judge. The temporary ruleset change and its
restoration must be recorded and verified separately.

Policy, source, tests, and documentation resolve revisions from refs and runtime
events. Resolved SHAs and digests belong in evidence output, not in
configuration. Documentation cites files, functions, and context names rather
than line numbers.

### Historical trends

Measure any revision on demand; nothing is stored in the repository:

```bash
node scripts/check-complexity.mjs --measure <rev> --json
```

Each output is bound to the measured revision's SHA, a digest of the measured
bytes, the digest of the executing analyzer policy (`policyDigest`), and the
measured revision's own policy digest (`revisionPolicyDigest`). A trend point is
comparable only when both the source and the analyzer that produced it match.

## Documented commands and links

Three tests read the documents in `docs/` and the root guides.

`tests/docs-executable.test.mjs` resolves each `npm run <script>` and each
`node scripts/<file>` that a document shows. It makes sure that the script is in
`package.json`, that the file exists, and that the script source contains each
flag on the command line. It also runs the documented `--json` call of
`check:complexity` and the documented `--help` call of `toolbox.mjs`.

`tests/docs-links.test.mjs` resolves each relative link and each heading anchor
in the documentation set. If a file moves or a heading changes, the test fails.

`tests/docs-fact-drift.test.ts` reads the duplication settings from
`.jscpd.json` and compares them with the numbers that the guide and the ADR
quote. If a threshold or a minimum moves, the prose must move in the same
change.

These tests do not prove that a command prints the output that a document shows.
A captured output block is evidence only when it names the revision, and when a
clean working tree produced it.

## Pull request evidence

Run the read-only check against the live PR before requesting or refreshing
review:

```bash
node scripts/check-pr-evidence.mjs 123
node scripts/check-pr-evidence.mjs 123 --forbid "report file age" --forbid "file mtime"
```

`npm run check:pr-evidence -- <pr>` is the same check. It fails when a body head
claim (`Reviewed head SHA`, `Final head`, `Head`) does not match the live head,
when a current-base claim does not match the live base, when a historical base
is not an ancestor of the head, when a declared revision is malformed, or when a
required check cannot be verified locally. `--forbid` also fails when a removed
user-visible phrase still appears. The output reports the forbidden phrases
checked (`none` when none were supplied). The phrase scan is a heuristic and
cannot prove that no semantic claim remains. The check never edits the PR body.
See [revision-bound PR evidence](testing-coverage.md#revision-bound-pr-evidence).

## Before you verify a change

The smallest useful check covers the change's **blast radius**, not only the file
you edited. For the changes below a targeted test cannot see the coupling, so run
`npm test` first and narrow afterwards:

| If the change… | Check this before trusting a targeted run |
| --- | --- |
| touches `.jscpd.json`, a baseline, or any threshold or default in config | Every test that **derives** from the value, not only the ones that spell it out. Search the accessor (`duplicationThreshold`, `analyze`, `parseJscpd`) and confirm each caller passes the value explicitly. A test that inherits the committed value breaks as a side effect of a legal config change. |
| adds or edits a file under a measured path (root `*.ts`, `*.mjs`, `*.cjs`, `ui/`, `scripts/`, `tests/`) | `npm run check:complexity`: a new file must stay within the target scope maxima. No baseline is regenerated or committed. |
| changes a number the docs state | Every place that quotes it — the ADR, this guide, a committed audit — in the same commit. A stale quote is a defect, not a lag. |
| adds a gate command | The gate inventory test, and a command-table row. A prose mention does not make a gate "documented". |
| runs `npm test` with uncommitted work | Commit or stash first: the acceptance contract fails a dirty candidate by design (`candidate-stable`), which looks like a regression and is not one. |

When a check can be wrong in two directions, prove it goes red before believing
it when it is green. A negative result from an unvalidated harness is not
evidence.

### Fault-control checks by hand

A contract test is only evidence once you have seen it fail for the right
reason. Do this one guard at a time:

1. Back up the file you are about to change (`cp config-agent-report.ts /tmp/bak`).
2. Break exactly one rule: remove an escape, raise a cap, delete an early return.
3. Run only the owning file, and check that the expected test is the one that goes
   red, for the expected assertion, e.g.
   `node --test --experimental-strip-types tests/config-agent.test.ts`.
4. Restore the backup and re-run the file. Green again, or the failure was not
   caused by the mutation.
5. Record the mutation, the test name, and both counts in the PR body.

A file-wide pass count is not enough. If raising `MAX_PROBE_FAILURE_LINES` leaves
139 of 140 tests green, the one that failed must be the budget test. A mutation
that turns nothing red means the guard is untested; one that turns several
unrelated tests red means the test is over-coupled and will be distrusted later.

Examples from the config-agent report work: dropping backslash doubling in
`displayPath()` reddened only the ambiguous-paths test; charging the truncation
marker to the budget reddened only the report bound, at 121 lines.

## Continuous integration

| Workflow | Trigger | Checks |
| --- | --- | --- |
| [`static-analysis.yml`](../.github/workflows/static-analysis.yml) | Pull request, push to `main`/`v2` | Oxlint, package metadata (publint), architecture, dead code, ast-grep, actionlint, Zizmor, Semgrep (baseline diff), Gitleaks, OSV (diff) |
| [`security-audit.yml`](../.github/workflows/security-audit.yml) | Manual dispatch | full-history Gitleaks, full Semgrep, full OSV, actionlint, Zizmor; SARIF uplink for Gitleaks and Semgrep |
| [`verification.yml`](../.github/workflows/verification.yml) | Pull request, push, schedule | existing acceptance, UI, compatibility, and mutation gates |
| [`complexity-gate.yml`](../.github/workflows/complexity-gate.yml) | `pull_request_target` | trusted complexity judge from the protected base branch; PR delta and proposed merge-result evidence |
| [`report-publisher-checks.yml`](../.github/workflows/report-publisher-checks.yml) | Pull request, push to `main` | `node --test tests/ci-report-publish.test.mjs` for the trusted report publisher |
| [`acceptance-report.yml`](../.github/workflows/acceptance-report.yml) | `workflow_run` of Verification | adds one marker-owned report comment to the pull request. It uses only default-branch code and never operates pull-request code |
| [`docs-links-scheduled.yml`](../.github/workflows/docs-links-scheduled.yml) | Weekly cron, manual dispatch | advisory external URL check (lychee), reported in the job summary; never runs on pull requests or gates a merge |

External documentation URLs are checked on a schedule, not on pull requests.
The deterministic docs tests already resolve relative links and heading anchors,
and `scripts/check-issue-refs.mjs` keeps issue-cited repository paths honest.
An external check depends on third-party uptime and rate limits, so making it a
required pull-request check would gate merges on outages this repository does not
control. The scheduled job uses [`.lychee.toml`](../.lychee.toml) for timeouts,
retries, and reviewed exclusions; broken links appear in the run summary and
never fail the job.

Pull-request security checks are diff-scoped where the tool supports it, so
old findings do not block unrelated work. The dispatch-only workflow scans
everything and fails on any finding.

Full-tree Gitleaks and Semgrep runs also upload SARIF to GitHub Code Scanning
under the `gitleaks` and `semgrep` categories; OSV already uploads its own.
SARIF is a second render of the same scan, so Code Scanning alerts never change
a gate verdict. Uploads happen only in the dispatch-only workflow: pull requests
keep the diff-scoped gate, and uploading a baseline-diff SARIF would truncate
the alert history. Dispatch the security audit after merging to refresh alerts.
The Gitleaks SARIF keeps `--redact`, so no secret value is uploaded.

Actions are pinned to full commit SHAs with a version comment. Checkout steps
set `persist-credentials: false`. Both rules are tested.

Two findings are ignored inline with a written reason:

- `acceptance-report.yml` uses `workflow_run` as a trusted publisher. It runs
  default-branch code, validates artifact metadata, and never runs pull-request
  code.
- `verification.yml` installs an alternate Pi version for the compatibility
  matrix without a lockfile, then asserts the tree is unchanged.

## Performance work

Measure first, then profile:

```bash
npm run bench -- --runs 5 --warmup 2          # Hyperfine, 200k router resolves
npm run bench:projection -- --json             # provider projection workload
npm run profile:cpu                            # -> reports/profiles/.../*.cpuprofile
npm run profile:heap                           # -> reports/profiles/.../*.heapprofile
```

Reports and profiles are gitignored. Open a `.cpuprofile` or `.heapprofile` in
Chrome DevTools. The workload is deterministic and checks its own selection, so
a timing difference is not a fixture difference. Hyperfine and Node profiling
are on-demand only; no CI job enforces a timing threshold.

`scripts/routing-release-benchmark.ts` remains the pinned release comparison for
routing quality. It needs the pinned baseline worktree and is not a default
benchmark target.

## Tool decisions

| Capability | Decision | Reason |
| --- | --- | --- |
| LSP | Reuse the editor or agent client | `tsc --noEmit` is the repository gate; no server to pin |
| ripgrep | Reuse | Installed for agents and developers; no repository config needed |
| ast-grep | Integrate | Rules encode repository invariants and run in CI |
| Knip | Integrate | Finds dependency drift that TypeScript cannot |
| dependency-cruiser | Integrate | Enforces the documented adapter and router seams |
| Difftastic | On demand | Reviewer choice, not a gate |
| Semgrep | Integrate | Local rules with self-tests; baseline diff in pull requests |
| Gitleaks | Integrate | Pull-request scan and dispatch-only full-history scan |
| OSV-Scanner | Integrate | Diff scan on pull requests, dispatch-only full scan |
| GitHub CLI | Reuse | Agent and maintainer environment only |
| actionlint | Integrate | Fast gate on every workflow change |
| Zizmor | Integrate | Workflow security, now clean with two documented ignores |
| Oxlint | Integrate | Fast advisory lint; errors fail, warnings stay visible |
| publint | Integrate | Checks packed exports and types that `npm pack` does not |
| Hyperfine | On demand | No stable CI timing threshold |
| Node profiler | On demand | Artifacts are for local investigation |
| CLI argument parsing | Reuse `node:util` | New scripts bind values with `parseArgs`; existing parsers keep their loops where duplicate-flag detection and exact error text are asserted, because the adapter costs more than the binding it saves |
| ts-morph | Defer | No codemod is needed yet; adding it now would be an unused dependency |
| Renovate | Configured | Repository config only; the hosted app still needs installation |
| Codemode | Unavailable | This host does not provide it; do not depend on it |

## External setup

The Renovate config in `renovate.json` is validated, but the hosted Renovate app
must be installed on the repository by an owner. A repository file cannot do
that. Until then, Renovate does not open update pull requests.

Gitleaks Action needs `GITLEAKS_LICENSE` only for organization-owned
repositories. This repository belongs to a personal account, so the workflow
does not set it. Add the secret before moving the repository into an
organization.
