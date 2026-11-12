# Merge controller

Status: **INACTIVE.** This helper needs independent exact-head review and fresh
current-base CI before any operational activation. Local tests use fake `gh`;
they do not authorize a live merge.

```bash
node scripts/merge-controller.mjs <pr-number> \
  --receipt <trusted-path-outside-candidate-checkout> \
  --expected-reviewer <agent-id> \
  --expected-implementer <agent-id> \
  --repo <owner/name> [--base v2] \
  [--outcome <trusted-outcome-path>] [--apply | --check]
```

Default mode is dry-run. `--apply` merges once; it requires a new outcome path
outside the candidate checkout in an existing writable directory. `--check`
requires that same persisted outcome and the same trusted review receipt and
identities. It never invokes merge. Apply and check are mutually exclusive.

The real candidate Git root is anchored to the controller module's checkout,
independent of the launch directory. Missing or mismatched Git context rejects;
there is no CWD fallback. Receipt and apply/check outcome paths must resolve
outside that root, including through symlinks. Repository inference also runs
from that checkout; an explicit `--repo` is preferred.

The local operator supplies trusted reviewer and implementer identities. A
candidate-supplied comment or file cannot provide approval. The receipt is a
local operator trust boundary, not a cryptographic attestation or GitHub review
enforcement. Operators must protect these files and the controller checkout.
Normal GitHub branch protections still apply. There is no admin bypass:

```text
gh pr merge <pr> --repo <repo> --merge --match-head-commit <head>
```

The head-only merge flag cannot atomically compare a base SHA. Apply therefore
also verifies the effective branch rules and their repository ruleset: active
pull-request enforcement, strict `release-gates` checks, and an empty bypass
actor list. GitHub's strict checks require the branch to be current with its
base at merge time. Missing, unsupported, truncated, or bypassable policy fails
closed. The controller rechecks this policy before persisting intent; it never
changes protections. This relies on the server continuing to enforce that
policy, not a client-side atomic base-SHA claim. See [GitHub strict status
checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).

The final GitHub read must still be eligible and bind the same workflow, run,
and attempt. New unresolved threads or a new CI attempt prevent intent and
merge. Every dry run refuses an existing outcome before any rejection path can
write it; use `--check` to inspect a saved apply intent. At publication, dry-run
output uses an atomic no-replace link from its fsynced private temporary file.
An intent created during GitHub reads also remains untouched, and the dry run
stops instead of replacing it.

## Trusted review receipt

Every field is required. Missing findings are never treated as zero.

```json
{
  "reviewerAgent": "reviewer-agent-id",
  "implementerAgent": "implementer-agent-id",
  "headSha": "<40-hex commit sha>",
  "baseSha": "<40-hex commit sha>",
  "sourceTreeSha": "<40-hex tree sha>",
  "deltaSha256": "<64-hex sha256 of the raw PR diff>",
  "changedFiles": ["path/one", "path/two"],
  "unresolvedBlockingFindings": 0
}
```

The receipt must match the actual GitHub head tree, current base, raw PR diff,
and complete changed-file inventory. The controller supports at most 100 changed
files: it accepts a short first API page, or exactly 100 only when a second page
is empty; any overflow, malformed, or duplicate entry rejects. Entries are never
silently discarded. Reviewer and implementer must
differ and match the trusted expected identities. Apply rechecks GitHub
eligibility, proposed parents/tree, receipt canonical path, exact receipt bytes,
and tested-source artifacts. It rereads the receipt again after artifact checks
and immediately before saving the apply intent. Check rereads the canonical
receipt after its GitHub checks and refuses `merged-and-verified` if the path,
digest, shape, expected identities, head, or base changed.

## Tested-source binding

Head-only workflow success is insufficient. The controller selects the latest
exact-head Verification run and its latest attempt first, then requires completed
success and exactly one successful `release-gates` job from that attempt. It
uses the existing workflow's `acceptance-evidence-<head>` and
`merge-result-evidence-<proposed-commit>` artifacts. It checks:

- Exact run/head identity, unique artifact name, nonexpired metadata and SHA256.
- Artifact creation within both the attempt and the matching successful upload
  step returned by the attempt-specific jobs endpoint. Old-attempt artifacts
  cannot fill in evidence for a rerun.
- Downloaded deterministic acceptance evidence, exact start/end revision,
  unchanged source fingerprint, clean source, passed candidate-stable case, and
  no skipped or failed required cases.
- Current proposed commit parents `[base, head]` and tree. A tested proposed
  commit binds these immutable identities, rather than inferring what CI tested
  from the current PR metadata.

Artifacts are downloaded by ID and read as bounded ZIP data with Python 3's
standard library in isolated mode (`-I`), so a `zipfile.py` in the launch
directory cannot shadow the standard module; their content is never executed or
extracted. Each archive is
limited to 64 MiB; selected JSON members total at most 8 MiB, 2 MiB per member,
and 100 evidence members. Runs, jobs, and artifact inventories must fit the
single 100-entry API page. Missing, ambiguous, oversized, or incomplete evidence
rejects instead of falling back to historical success. No workflow change or
new dependency is required.

### Current-base rebind

A completed run is not clearance when its checkout or proposed merge predates
the current base. Preserve that run as historical evidence, then rebuild the
candidate declaration from a clean current-base worktree and push that new
candidate for fresh CI. Do not reinterpret an old success after the base moves.

The API contracts are documented in [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
and [GitHub artifacts](https://docs.github.com/en/rest/actions/artifacts).
These field contracts are not a claim of live validation of this controller.

## Durable intent and continuation

Before any merge, apply checks the output destination and atomically persists
an intent containing repo, PR, head, premerge base, proposed tree, workflow ID,
review-receipt path/digest, and tested artifact identities. Writes use a private
temporary file, fsync, rename, and directory fsync. An existing outcome stops
apply; use check to continue. Do not repeat apply after an uncertain result.

Check loads that trusted frozen intent, revalidates the receipt and identities,
and compares the actual merge's parents/tree with the intent. It never derives
the historical premerge parent from the now-advanced base ref. A missing or
wrong tree cannot verify. Both modes require the exact base-branch tip and
latest exact merge-SHA push run/attempt to pass its `release-gates` job.

Outcomes:

- `dry-run`: eligible; no merge.
- `merged-and-verified`: exact parents/tree, branch tip, and current push gates
  all verified.
- `rejected`, `rejected-toctou`, `merge-failed`: no verified merge.
- `postmerge-verification-failed`: actual merge parents/tree mismatch.
- `waiting-for-push-verification`: required post-merge evidence is missing,
  failed, skipped, pending, or unavailable. Dependent work stays stopped.
- `outcome-persistence-failed`: required persistence failed. Exit is nonzero;
  stdout's `operation` retains the truthful observed merge result. This does
  not imply rollback. Recover the original intent and use check; never retry
  merge automatically.

Continuation example (same PR, repo, receipt, identities, and outcome):

```bash
node scripts/merge-controller.mjs <pr-number> --check \
  --repo <owner/name> --receipt <trusted-review.json> \
  --expected-reviewer <agent-id> --expected-implementer <agent-id> \
  --outcome <original-apply-outcome.json>
```

There is no polling, operational schedule, or automatic dependent-PR action.
