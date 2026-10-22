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
| `npm run check:ast` | Structural rules and rule self-tests (`sgconfig.yml`) | `npm ci` |
| `npm run check:actions` | Workflow syntax and expressions (actionlint) | actionlint |
| `npm run check:sast` | Repository Semgrep rules | semgrep |
| `npm run check:secrets` | Working-tree secret scan | gitleaks |
| `npm run check:secrets:history` | Full-history secret scan (slow) | gitleaks |
| `npm run check:deps` | Lockfile vulnerabilities (OSV) | osv-scanner |
| `npm run toolbox:doctor` | Tool availability and install hints | none |

Add `--json` for a structured result:

```bash
npm run check:arch -- --json
```

Exit codes are `0` clean, `1` findings, and `2` unavailable tool or invalid
invocation.

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

The Gitleaks allowlist in `.gitleaks.toml` covers only the `generic-api-key` rule under `tests/`,
where fixtures use synthetic canaries to prove redaction. It does not
allowlist other rules or other paths. A new secret-like value anywhere else
still fails the scan.

## Continuous integration

| Workflow | Trigger | Checks |
| --- | --- | --- |
| [`static-analysis.yml`](../.github/workflows/static-analysis.yml) | Pull request, push to `main`/`v2` | architecture, dead code, ast-grep, actionlint, Zizmor, Semgrep (baseline diff), Gitleaks, OSV (diff) |
| [`security-audit.yml`](../.github/workflows/security-audit.yml) | Weekly schedule, manual | full-history Gitleaks, full Semgrep, full OSV, actionlint, Zizmor |
| [`verification.yml`](../.github/workflows/verification.yml) | Pull request, push, schedule | existing acceptance, UI, compatibility, and mutation gates |

Pull-request security checks are diff-scoped where the tool supports it, so
old findings do not block unrelated work. The scheduled workflow scans
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
| Gitleaks | Integrate | Pull-request scan and weekly full-history scan |
| OSV-Scanner | Integrate | Diff scan on pull requests, full scan weekly |
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
