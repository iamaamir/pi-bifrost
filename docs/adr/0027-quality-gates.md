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
- `quality/complexity-baseline.json` stores per-file maxima plus scope maxima
  and counts above 30 and 50.
- The gate is a **ratchet**: per-file maxima and scope counts must not increase.
  New files must not exceed the scope maxima.
- Nested functions are scored separately; a parent does not absorb a child's
  branches. Expression-bodied arrow bodies are visited.
- Paths are normalized to forward slashes before scoping or baseline lookup so
  Windows and POSIX agree.
- Regenerate the baseline with `npm run check:complexity -- --update-baseline`
  after rebasing onto `main` or after an intentional complexity reduction.
- `npm run check:complexity:baseline` re-measures in memory and fails with
  `complexity-baseline-stale` when any record differs, so a baseline that
  describes an older tree cannot merge. Every recorded field is compared, not
  only maxima, so line and function drift fails too.
- A pull request can regenerate the committed baseline in its own change, so
  the budget and staleness checks cannot see a raised maximum. CI also compares
  the tree against the baseline recorded at the base revision
  (`npm run check:complexity:base -- <base-sha>`). A new file is judged against
  that record's scope maxima. When the base revision has no baseline, the gate
  fails with `complexity-base-baseline-missing`.
- `generatedAt` and `sourceCommit` are provenance and are never compared.
  `sourceCommit` names the generation-time HEAD, which is the baseline commit's
  parent, because a commit cannot contain its own SHA.
- A file that disappears while the analyzer reads the tree is skipped with a
  warning, so a moving tree on a developer machine is not a crash. A directory
  that disappears during the walk is recorded the same way, because its files
  are equally absent from the snapshot. Read errors other than `ENOENT` still
  fail, and `--update-baseline` refuses an incomplete analysis rather than
  recording a baseline that omits real files.

### Process

- Baselines are committed and reviewed like code.
- The author of a change that moves a metric regenerates the affected baseline
  in the same change. A reviewer checks that diff contains only metric updates,
  not unrelated entries.
- Tightening a threshold is a deliberate change with its own evidence, not a
  side effect of a refactor.
- CI runs the staleness check after the ratchet, so a forgotten regeneration is
  a red build rather than a review note.
- Gate exit codes are covered by fault controls in
  `tests/quality-gates-fault-controls.test.mjs`, which drive `check:ast`,
  `check:duplication`, and `check:complexity` against fixture trees. A scope
  guard that stops reporting, or a threshold that ignores the measured tree,
  turns those tests red.
- The optional pre-push hook runs the quick tests and the fast gates
  (`check:ast`, `check:duplication`, `check:complexity`).

## Consequences

- CI cost is a few seconds per gate; the complexity analyzer parses roughly 280
  files.
- Baseline regeneration produces a large diff when the metric changes. That is
  expected: it is the record of the new ceiling.
- A contributor who lowers complexity should regenerate the baseline in the same
  change, otherwise the ratchet keeps the old, higher ceiling.
- Duplication can drift upward within the 3.3% budget. The committed audit
  records the current headroom. Trend history is tracked in #291 rather than in
  this ADR.
- The gates run on Linux CI and macOS locally; there is no Windows leg. Windows
  separator handling is normalized before comparison and unit-tested with
  `path.win32`, but a native Windows run remains unproven.

## Alternatives considered

- **Lint-only, no gates.** Rejected: it cannot catch structural drift or
  copy-paste growth.
- **Warn-only gates.** Rejected: a warning that nobody reads is the same false
  signal this ADR exists to remove.
- **True duplication ratchet now.** Deferred: the clone population (tests, UI,
  generated fixtures) needs an audit before the count is meaningful.
- **A single combined gate.** Rejected: independent gates keep failures
  attributable and let one be tightened without re-baselining the others.
