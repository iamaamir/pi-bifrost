# Design note: complexity gate against a target revision

Status: design record for the change that removes the committed complexity
snapshot. It does not alter runtime routing behavior.

## Problem and file-level evidence

`quality/complexity-baseline.json` is a generated record of every measured file
plus per-scope maxima (`scripts/check-complexity.mjs`, `analyze`). Two gates read
it:

- `npm run check:complexity` fails when a per-file maximum or a scope hotspot
  count increases (`fileFindings`, `scopeFindings`).
- `npm run check:complexity:baseline` re-measures the working tree and fails when
  any recorded field differs (`stalenessFindings`).

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
the candidate measurement against it. The target is the pull request base SHA in
CI and the merge-base with the tracked main branch locally. No generated metrics
file is committed. `quality/complexity-baseline.json` is deleted.

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

- The candidate defaults to the working tree. In CI the checkout is clean at the
  pull request head, so the measured content is the head revision.
- The target comes from `--target <rev>`, then `BIFROST_COMPLEXITY_BASE`, then
  `GITHUB_BASE_SHA`, then the merge-base with `origin/main` or `main`, then
  `HEAD^`. If none resolves, the gate exits `2` and does not report a verdict.
- A revision is extracted with a detached `git worktree` in the OS temporary
  directory, measured, and removed. No file is written inside the repository.
- Measurements are bound to content, not to a user-supplied metrics file. The
  report carries the resolved target SHA, the candidate revision and dirty state,
  a SHA-256 of the measured inputs, and the resolved TypeScript version. A
  hand-edited number has no input path into the verdict.
- An incomplete walk (a file vanishing mid-analysis) or an unreadable revision
  fails closed with exit `2`. A verdict is never derived from a partial tree.

### Comparison policy (unchanged)

`compare` keeps the accepted policy from ADR 0027:

- scope maxima and counts above 30/50 must not increase (`maxCyc`, `maxCog`,
  `cycGt30`, `cycGt50`, `cogGt30`, `cogGt50`);
- a file present in the target must not raise its `maxCyc` or `maxCog`;
- a new file must not exceed the target scope's maxima;
- removed files are improvements and are not findings.

Added, removed, and renamed paths are evaluated against trees, not against the
previous file identity: a rename is a removal plus a new file, so the new path is
judged by the scope ceiling. This is the existing semantics and is documented and
tested.

Because the target is measured per run, branch movement needs no cache:
re-running against the moved base re-measures it. Repeated checks of unchanged
revisions are deterministic; no timestamp or generation provenance is compared.

### Trust boundary

The gate is a script in the candidate, so a change to its algorithm, scope
policy, thresholds, measurement dependency, or CI wiring could otherwise judge
itself. The gate therefore computes a policy digest over the analyzer source,
the static-analysis workflow, `tsconfig.json`, the complexity scripts in
`package.json`, and the resolved TypeScript version at both revisions:

- equal digests: the comparison runs normally;
- different digests: the gate still measures both trees with one algorithm, but
  exits `2` with `complexity-policy-changed` unless
  `--allow-policy-change` (or `BIFROST_COMPLEXITY_ALLOW_POLICY_CHANGE=1`) is
  present.

CI passes the override only when the pull request carries the
`quality-policy-change` label. A direct push to `main` is the merge of a pull
request that already went through that gate, so the push leg runs with the
override; branch protection remains the anchor against direct pushes. The
residual risk is explicit: a reviewer who applies the label to a weakening
change, or a repository that allows unreviewed pushes to `main`, can bypass it.
The digest and both revisions are printed so the policy diff can be reviewed
rather than inferred. `.github/CODEOWNERS` asks the owner to review the policy
files.

The analyzer is applied to both sides in one invocation, so a metric change is
apples-to-apples within that run. It is not possible to mix the target's
algorithm with the candidate's numbers, which was the silent-weakening risk of
keeping a committed snapshot.

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
7. rename is evaluated as remove plus add;
8. repeated and concurrent runs against the same revisions return the same
   verdict and digests.

Command-level demonstration uses `--json`, and the CI step is changed from three
complexity steps to the target-relative comparison, keeping the failure
behavior. Historical trends are recovered on demand:

```bash
node scripts/check-complexity.mjs --measure <rev> --json
```

No generated complexity file is committed or written by routine changes.
