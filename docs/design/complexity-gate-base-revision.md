# Design note: complexity gate against a target revision

Status: design record for the change that removes the committed complexity
snapshot. It does not alter runtime routing behavior.

## Problem and file-level evidence

`quality/complexity-baseline.json` is a generated record of every measured file
plus per-scope maxima (`scripts/check-complexity.mjs`, `analyze`). Two gates read
it:

- `npm run check:complexity` fails when a per-file maximum or a scope hotspot
  count increases (`fileFindings`, `scopeFindings`).
- the baseline-staleness gate re-measures the working tree and fails when any
  recorded field differs (`stalenessFindings`).

The second gate requires the committed record to describe the candidate exactly.
Any change to measured code changes `lines`, `funcs`, `sumCyc`, or `sumCog`, so a
routine feature branch must regenerate the whole shared file. Two branches that
touch different measured files both rewrite the same JSON, which conflicts on
rebase and forces repeated regeneration. CI's `check:complexity:base` reads the
record at the base revision, but that only prevents a *raised ceiling*; it does
not remove the regeneration requirement.

Root cause: the gate stores measurements as committed input. The measurements
are derived data, and a shared generated file is the wrong transport for them.

## Options considered

**A. Keep the committed file, generate it in CI or a merge queue.** A bot would
write the baseline after merge. This removes the contributor step but still
commits a moving generated file, so `main` gains a commit per measured change,
reviewers lose the metric diff from the feature PR, and the gate still depends on
a record that describes an older tree. It also requires workflow write
permissions that the current job deliberately does not have
(`permissions: contents: read`).

**B. Keep the committed file but scope it per directory/owner.** Splitting the
snapshot reduces conflict width but not the regeneration step, and it adds
another file-selection policy. New files still land in a shared shard. It does
not meet the objective.

**C. Measure the target revision on demand (chosen).** Run the same analyzer on
the source tree checked out at a defined target revision, in memory, and compare
the candidate measurement against it. The target is resolved from the pull
request base/merge-base in CI and from the tracked main branch locally. No
generated metrics file is committed. `quality/complexity-baseline.json` is
deleted.

**D. Minimal change: keep the file, drop only the staleness gate.** This removes
the regeneration step but leaves stale ceilings: a branch could lower a
function's complexity while the committed ceiling stays high, and a branch that
raises a ceiling still needs the file updated or it passes against the old
value. It weakens the ratchet and keeps the conflict.

C is the smallest architecture that removes the shared generated artifact while
keeping the ceiling derived from history. It also makes historical values
reconstructible from any revision with `--measure`, which the committed file
only provided indirectly through its own git history.

## Chosen design

### Measurement inputs

- The candidate defaults to the working tree. In CI it is passed explicitly as
  the pull request head commit, so the measured tree is immutable. A local
  working-tree candidate is fingerprinted before and after measurement; a change
  fails closed instead of reporting a mixed snapshot.
- The target comes from `--target <rev>`, then `BIFROST_COMPLEXITY_BASE`, then
  `GITHUB_BASE_SHA`, then the merge-base with `origin/main` or `main`. There is
  no implicit `HEAD^`; a last-commit comparison must opt in with
  `--target HEAD^`. If none resolves, the gate exits `2` and does not report a
  verdict.
- CI compares a pull request head against its merge-base with the base branch,
  and the protected judge separately compares the proposed merge result against
  the base tip. A base-only policy move after divergence is not reported as a
  pull request policy change.
- A revision is extracted with a detached `git worktree` in the OS temporary
  directory, measured, and removed. No measured file or generated snapshot is
  written into the candidate tree.
- Measurements are bound to content, not to a user-supplied metrics file. The
  report carries the resolved target SHA, the candidate revision and dirty state,
  a SHA-256 of the measured inputs, the resolved TypeScript version, and the
  policy digest. A hand-edited number has no input path into the verdict.
- An incomplete walk (a file vanishing mid-analysis) or an unreadable revision
  fails closed with exit `2`. A verdict is never derived from a partial tree.
  Symlinked measured paths are skipped so a candidate cannot make the judge read
  outside the revision tree.

### Comparison policy (unchanged)

`compare` keeps the accepted policy from ADR 0027:

- scope maxima and counts above 30/50 must not increase (`maxCyc`, `maxCog`,
  `cycGt30`, `cycGt50`, `cogGt30`, `cogGt50`);
- a file present in the target must not raise its `maxCyc` or `maxCog`;
- a new file must not exceed the target scope's maxima;
- removed files are improvements and are not findings.

Removed files are improvements. Git rename detection identifies a move; the new
path inherits the old path's per-file ceiling, so a rename cannot reset the
ratchet. A path Git does not recognize as a rename is a new file and is judged by
the scope ceiling. Scope maxima still apply to the resulting tree.

Because the target is measured per run, branch movement needs no cache:
re-running against the moved base re-measures it. Repeated checks of unchanged
revisions are deterministic; no timestamp or generation provenance is compared.

### Trust boundary and protected judge

The gate must not be judged by code in the candidate. The authoritative path is
`.github/workflows/complexity-gate.yml`, a `pull_request_target` workflow:

- GitHub runs the workflow and the analyzer from the protected target branch,
  not from the pull request.
- The workflow resolves the base ref once at run time, fetches the PR head and
  proposed merge refs, and records the resolved revisions. No source, policy,
  or test file contains a hard-coded commit SHA.
- The PR is present only as Git objects. The judge never installs, imports, or
  executes candidate code. It measures the base, head, and merge trees with the
  protected analyzer.
- It measures the PR delta against the merge-base and the proposed merge result
  against the base tip. A clean branch-point comparison cannot hide a
  merge-result regression.
- The workflow uploads JSON evidence for both measurements, including the
  resolved revisions, input digests, and policy digests. That artifact is the
  replay record after refs move.

The analyzer still computes a policy digest over its source, the workflow files,
`tsconfig.json`, the complexity scripts, and the resolved TypeScript version. A
different digest fails closed with `complexity-policy-changed`. A candidate
label is not sufficient authority for a policy change; the protected workflow
does not accept the self-authorizing override.

### Lint exception

Zizmor reports `dangerous-triggers` for every `pull_request_target` workflow.
`complexity-gate.yml` carries a line-scoped
`# zizmor: ignore[dangerous-triggers]` comment with the reason inline. That is an
explicit workaround, not evidence that the trigger is safe by itself. Zizmor
warns that avoiding pull-request code execution is not sufficient in every
workflow; the controls specific to this judge are the base-ref checkout, PR
refs treated as data, base-only dependency installation, a read-only token, and
the boundary tests.

No automatic in-repo replacement both preserves the protected judge and clears
the audit. `pull_request` runs candidate workflow code; `workflow_run` is also a
dangerous trigger; `schedule` or manual operation adds latency. An external
trusted check is the clean replacement. The suppression is scoped to this
trigger and must not be widened.

The ruleset must require the protected workflow's `complexity-trusted` context
for the check to block merges. CODEOWNERS routes policy paths to the owner, but
code-owner review is only blocking when the ruleset requires it. That is a
repository configuration dependency; it is not a commit-SHA pin in the code.

### Policy changes and bootstrap

A normal policy change is a protected PR to the target branch. The old protected
judge measures the candidate and fails closed when the policy digest differs.
The owner reviews the analyzer/workflow diff through the protected policy path;
after merge, the new judge becomes active automatically. There is no pin file and
no manual SHA bump.

The current migration is the one exception: the old target-branch checker does
not have the source-comparison interface, so it cannot judge its own replacement.
Treat this PR as a one-time owner-approved migration with independent
source-derived equivalence evidence. The candidate checker is evidence for that
migration, not an authority for later PRs. After merge, the protected workflow is
the authority and the bootstrap exception is no longer used.

The analyzer is still applied to both sides in one invocation, so a metric change
is apples-to-apples within that run. The difference is who supplies the judge:
the protected branch, not the candidate.

## Adversarial test plan

Deterministic tests at the real CLI boundary (temporary git repositories):

1. unchanged candidate against its parent exits `0`;
2. a measured function gaining a branch exits `1` with a file and scope finding;
3. a new file above the target scope maximum exits `1`;
4. a target that does not resolve, an unreadable analysis, and a partial walk
   exit `2`;
5. an analyzer/scope/threshold policy change without the override exits `2`, with
   the override exits according to the metric comparison;
6. two branches editing different measured files both exit `0` against the same
   base without touching any shared file, and a third branch adding a new file
   still gets the new-file ceiling;
7. a detected rename keeps the old per-file ceiling; an undetected rename is a
   new file and is judged by the scope ceiling;
8. repeated and concurrent runs against the same revisions return the same
   verdict and digests;
9. a base policy move after divergence forces no override for an untouched
   branch when the target is the merge-base;
10. CRLF-only policy bytes produce the same digest as the committed LF blob;
11. an unreadable policy input returns the structured exit-`2` JSON envelope;
12. no `main` ref does not silently fall back to `HEAD^`; the explicit
    `--target HEAD^` form still works;
13. an editing working-tree candidate is detected by the pre/post fingerprint;
14. a source-derived target and a serialized legacy baseline produce the same
    ratchet findings for an ordinary change;
15. the protected workflow measures both the PR delta and the proposed merge
    result and uploads both evidence files.

Command-level demonstration uses `--json`, and CI keeps the target-relative
comparison. Historical trends are recovered on demand and recorded as CI
artifacts:

```bash
node scripts/check-complexity.mjs --measure <rev> --json
```

No generated complexity file is committed or written by routine changes. Each
measurement carries both the executing analyzer's policy digest and the measured
revision's own policy digest, so a trend point is comparable only with points
produced under the same analyzer and scope policy. The protected workflow stores
the PR-delta and merge-result evidence as artifacts rather than in the tree.

### No literal revision or line pins

Policy, source, tests, and documentation resolve revisions from refs and runtime
events. Resolved commit SHAs and digests belong in evidence output, not in
configuration. Documentation cites files, functions, and context names rather
than line numbers, so routine edits do not invalidate the design record.
