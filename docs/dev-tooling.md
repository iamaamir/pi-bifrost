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
| `npm run check:duplication` | Copy-paste detection and threshold (`.jscpd.json`) | `npm ci` |
| `npm run check:complexity` | Per-function complexity against `quality/complexity-baseline.json` | `npm ci` |
| `npm run check:complexity:baseline` | The committed baseline matches the tree; stale records fail (see [Baselines after a rebase](#baselines-after-a-rebase)) | `npm ci` |
| `npm run check:contracts` | Host integration contracts read from `index.ts` and `debug.ts` (`scripts/check-contracts.mjs`) | `npm ci` |
| `npm run check:actions` | Workflow syntax and expressions (actionlint) | actionlint |
| `npm run check:sast` | Repository Semgrep rules | semgrep |
| `npm run check:secrets` | Working-tree secret scan | gitleaks |
| `npm run check:secrets:history` | Full-history secret scan (slow) | gitleaks |
| `npm run check:deps` | Lockfile vulnerabilities (OSV) | osv-scanner |
| `npm run check:issue-refs` | Repository paths cited in tracker issues; on demand, not a gate (see [`tracker-workflow.md`](tracker-workflow.md)) | `gh` |
| `npm run toolbox:doctor` | Tool availability and install hints | none |
| `npm run test:quick` | Quick local tier: typecheck + root tests minus the four heavy files (see `scripts/test-quick.mjs`) | `npm ci` |
| `scripts/git-hooks/pre-push` | Optional pre-push gate running `test:quick` plus the fast gates (`check:ast`, `check:duplication`, `check:complexity`); enable with `git config core.hooksPath scripts/git-hooks`, bypass with `--no-verify` | `npm ci` |

Add `--json` for a structured result:

```bash
npm run check:arch -- --json
```

Exit codes are `0` clean, `1` findings, and `2` unavailable tool or invalid
invocation. Each check also accepts `--root <path>` to measure another tree with
this repository's tool binaries; the fault-control tests use it to run a real
gate against a fixture and assert its exit code.

The architecture rules encode existing seams: the resolve-only router may use
Pi types but not the Pi runtime, host UI modules are imported only by the Pi
adapter entry points, shipped modules cannot import dev tooling, and no cycles
are allowed. A new rule must pass on the current tree before it is added.

Knip treats every root module as an entry point. `package.json` exports `./*`
and ships `*.ts`, so every root file is a public subpath. Knip still reports
unused dependencies, unlisted imports, unlisted binaries, and unresolved
paths. It does not report unused entry exports.

The Semgrep rules live in `semgrep/`. Each rule has a matching fixture in
`tests/semgrep/targets/`. The fixture must contain one `ruleid:` example and
one `ok:` example. `npm run check:sast` scans the tree; the CI job also runs
`semgrep --test`, and the Node tests check that rule names and fixture names
stay aligned.

The Gitleaks allowlist in `.gitleaks.toml` covers only the `generic-api-key` rule. It ignores two exact synthetic canary values used by redaction fixtures regardless of file path, and additional reviewed fixture values only when their exact test-file paths also match. It does not allowlist whole files or other rules.

## Baselines after a rebase

`quality/complexity-baseline.json` must describe the tree in the same commit.
After a rebase, or any change that intentionally moves a ceiling:

```bash
npm run check:complexity -- --update-baseline
```

Commit the regenerated baseline with the change that moved it, and never
hand-edit a ceiling. `npm run check:complexity:baseline` re-measures in memory
and fails with `complexity-baseline-stale` when any record differs, so a stale
baseline cannot merge. That covers line and function counts as well as maxima: a
baseline describing an older tree is stale even when the ratchet still passes.

`generatedAt` and `sourceCommit` record provenance and are never compared.
`sourceCommit` names the HEAD the numbers were measured from, which is the
baseline commit's parent, because a commit cannot contain its own SHA.

Tests must not write inside a measured path: root `*.ts`, `ui/`, `scripts/`, or
`tests/`. The staleness check reads the tree, so a temporary file there fails a
concurrent run. Write fixtures to a temp directory instead, and pin any relative
import to an absolute URL if the fixture must run from outside the repository.

## Continuous integration

| Workflow | Trigger | Checks |
| --- | --- | --- |
| [`static-analysis.yml`](../.github/workflows/static-analysis.yml) | Pull request, push to `main`/`v2` | architecture, dead code, ast-grep, actionlint, Zizmor, Semgrep (baseline diff), Gitleaks, OSV (diff) |
| [`security-audit.yml`](../.github/workflows/security-audit.yml) | Manual dispatch | full-history Gitleaks, full Semgrep, full OSV, actionlint, Zizmor |
| [`verification.yml`](../.github/workflows/verification.yml) | Pull request, push, schedule | existing acceptance, UI, compatibility, and mutation gates |
| [`report-publisher-checks.yml`](../.github/workflows/report-publisher-checks.yml) | Pull request, push to `main` | `node --test tests/ci-report-publish.test.mjs` for the trusted report publisher |
| [`acceptance-report.yml`](../.github/workflows/acceptance-report.yml) | `workflow_run` of Verification | adds one marker-owned report comment to the pull request. It uses only default-branch code and never operates pull-request code |

Pull-request security checks are diff-scoped where the tool supports it, so
old findings do not block unrelated work. The dispatch-only workflow scans
everything and fails on any finding.

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
| Hyperfine | On demand | No stable CI timing threshold |
| Node profiler | On demand | Artifacts are for local investigation |
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
