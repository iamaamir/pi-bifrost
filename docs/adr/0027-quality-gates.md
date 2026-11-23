# 0027 — Quality gates for structural rules, duplication, and complexity

## Status

**Accepted.** Introduced by #289; hardened by #291.

## Context

#289 added four gates: stricter `tsconfig` flags, ast-grep structural rules, a
jscpd duplication budget, and a per-function complexity baseline. The first
review of that work found that the gates could report green while measuring
nothing:

- The extension rules used `files: ["/*.ts"]`, which matched no file. `check:ast`
  passed because the scan found nothing to inspect.
- `ast-grep test` does not apply a rule's `files` filter, so the rule self-tests
  could not detect the inert scope.
- The complexity baseline was generated before a rebase and failed on the
  rebased head.
- The complexity visitor counted nested closures inside their parent and
  skipped expression-bodied arrow branches.

A gate that can pass without measuring its target is worse than no gate: it
converts a missing check into a false signal. Bifrost's product boundary asks
for signals that are observable, overridable, and testable; quality gates are
no exception.

## Decision

Keep three independent gates, each with a committed baseline or budget, and
make "the gate measured nothing" a failure.

### Structural rules (ast-grep)

- Rules live in `rules/` and are wired through `sgconfig.yml`.
- A rule's `files`/`ignores` globs must match at least one tracked file. A rule
  with an empty scope reports `ast-grep-empty-scope` and fails `check:ast`.
- An empty tracked-file list, or a failed `git ls-files`, reports
  `ast-grep-scope-unverified` and fails. A scope that cannot be checked is not a
  pass.
- Rule scope is verified by a real `ast-grep scan` against a temp tree, not only
  by `ast-grep test`.
- Extension rules (`no-as-any`, `no-debugger`, `no-console-log`,
  `no-process-exit`) apply to root extension sources only; `tests/`, `ui/`, and
  `scripts/` are excluded by the rule, not by the runner.

### Duplication (jscpd)

- `.jscpd.json` is the single source of the threshold. `scripts/toolbox.mjs`
  reads it; the CLI does not pass a second copy.
- The budget is 3.3% of duplicated lines, measured with `minTokens 50` and
  `minLines 10` over TypeScript and JavaScript (3.02% when adopted). `format`
  must list both: jscpd maps `.mjs`/`.cjs` to the `javascript` format, so a
  typescript-only filter silently excluded every script and tooling test.
- Changing `format`, `minTokens`, or `minLines` changes the denominator. Rerun
  the audit and move the budget in the same change.
- The clone population has been audited: [`docs/quality/duplication-audit.md`](../quality/duplication-audit.md)
  shows that 87% of the duplication at a 6-line minimum sat inside `tests/`,
  and that the 6-9 line band was short test scaffolding. `minLines` moved to 10 and
  the budget came down with it, so the gate still measures the tree it guards.
  `tests/**` stays measured; a copy-pasted test is still a liability.
- This is a **budget**, not a ratchet: adding unique lines lowers the
  percentage. A true duplicated-line ratchet is deferred until the clone
  population needs it. The committed audit records the current headroom.

### Complexity (TypeScript compiler API)

- `scripts/check-complexity.mjs` measures per-function cyclomatic and
  cognitive complexity for `.ts`, `.mjs`, and `.cjs` under root, `ui/`,
  `scripts/`, and `tests/`.
- There is no committed complexity snapshot. The gate measures the target
  revision and the candidate from source with the same analyzer and compares
  them. The target comes from `--target`, then `BIFROST_COMPLEXITY_BASE`, then
  `GITHUB_BASE_SHA`, then the merge-base with `origin/main` or `main`. There is
  no implicit `HEAD^` fallback; a last-commit comparison must pass
  `--target HEAD^` explicitly. A revision that does not resolve fails with exit
  `2`.
- The gate is a **ratchet**: per-file maxima and scope counts must not increase
  against the target measurement. New files must not exceed the target scope
  maxima. Removed files are improvements. A rename is a removal plus a new file,
  so the new path is judged by the scope ceiling.
- Nested functions are scored separately; a parent does not absorb a child's
  branches. Expression-bodied arrow bodies are visited.
- Paths are normalized to forward slashes before scoping or file lookup so
  Windows and POSIX agree.
- Measurements are content-bound. The report carries the resolved target SHA,
  the candidate revision and dirty state, and a SHA-256 of the measured bytes.
  No metrics file is an input to a verdict, so a hand-edited number cannot
  become evidence.
- A file that disappears during analysis, an unreadable revision, or an
  incomplete measurement fails closed with exit `2` instead of reporting a
  verdict from a partial tree.
- The analyzer, its scope and threshold policy, the TypeScript version, the
  protected complexity workflow, the static-analysis and verification workflows,
  and the owner-routing file are hashed at both revisions. A differing digest
  exits `2` with `complexity-policy-changed` unless `--allow-policy-change` is
  present. The bootstrap `release-gates` path allows that override only for a
  pull request carrying the `quality-policy-change` label. The protected
  `complexity-trusted` workflow does not accept the override or the label. The
  complexity job is a dependency of the required `release-gates` context, and
  [CODEOWNERS](../../.github/CODEOWNERS) routes the policy files to the owner.
  Code-owner review is blocking only when the repository ruleset requires it.
  This is the trust boundary: the candidate script cannot silently relax the
  check that judges it.
- Historical values are reproduced on demand with
  `node scripts/check-complexity.mjs --measure <rev> --json`. The output is tied
  to that revision's SHA and input digest, the executing analyzer's policy
  digest, and the measured revision's policy digest; no generated trend file is
  committed.

### Process

- The base revision is the review anchor. A change that moves a metric is judged
  against it, so raising a ceiling requires a visible policy decision rather
  than a regenerated file.
- Tightening a threshold is a deliberate change with its own evidence, not a
  side effect of a refactor.
- CI compares a pull request's head against its merge-base with the base branch
  and a push against the previous tip. The complexity job is required by
  `release-gates` rather than only by the separate static-analysis workflow.
- Gate exit codes are covered by fault controls in
  `tests/quality-gates-fault-controls.test.mjs`, which drive `check:ast`,
  `check:duplication`, and `check:complexity` against fixture trees. A scope
  guard that stops reporting, or a threshold that ignores the measured tree,
  turns those tests red.
- The optional pre-push hook runs the quick tests and the fast gates
  (`check:ast`, `check:duplication`, `check:complexity`).

## Consequences

- CI cost is a few seconds per gate; the complexity analyzer parses roughly 280
  files twice, once per revision.
- A routine change no longer regenerates a shared file, so feature branches that
  edit different measured files cannot conflict through metrics.
- A policy change needs owner review and the protected repository procedure;
  the bootstrap `quality-policy-change` label is not authority for the protected
  judge. Reviewers inspect the analyzer diff rather than trusting a regenerated
  snapshot.
- Duplication can drift upward within the 3.3% budget. The committed audit
  records the current headroom. Trend history is tracked in #291 rather than in
  this ADR.
- The gates run on Linux CI and macOS locally; there is no Windows leg. Where a
  target name meets a filesystem path, the mutation tools normalize the separator
  to `/`, but a native Windows run remains unproven and untested.

## Alternatives considered

- **Lint-only, no gates.** Rejected: it cannot catch structural drift or
  copy-paste growth.
- **Warn-only gates.** Rejected: a warning that nobody reads is the same false
  signal this ADR exists to remove.
- **True duplication ratchet now.** Deferred: the clone population (tests, UI,
  generated fixtures) needs an audit before the count is meaningful.
- **A single combined gate.** Rejected: independent gates keep failures
  attributable and let one be tightened without re-baselining the others.
