## Summary

<!--
The smallest view that makes the point: a diagram, tree, call sketch, or diff.
Link the issue or ADR this implements.
-->

## Evidence

<!--
What proves the change works: before/after output, or the exact test that went
from red to green. Paste real output; never retype it.
-->

### UI smoke screenshots (required for UI changes)

<!-- Embed PNG captures from the real Pi smoke test (or browser captures for website UI), not local paths or CI artifact links. Label the changed states and relevant failure/empty states. If the existing smoke suite does not capture the change, extend it. See docs/testing-coverage.md. -->
UI impact: <!-- affected UI surface(s), or N/A — no visible UI change -->
Test command + observed result: <!-- exact output; N/A for non-UI -->
Reviewed head SHA: <!-- N/A for non-UI -->
Screenshots: <!-- ![tested state](uploaded-image-url); N/A for non-UI -->

### Gate evidence

<!--
Required when this PR adds, removes, or changes a quality gate. For each gate
listed: the command you ran, its real output, and what it would catch that the
other gates do not. A gate without evidence is a claim, not a gate. See
docs/dev-tooling.md.
-->

- [ ] `npm run check:ast`
- [ ] `npm run check:duplication`
- [ ] `npm run check:complexity`

command:
observed output:
what it catches that the others do not:

## Merge Danger

**Door:** two-way

<!-- One-way if rolling back is destructive or expensive; two-way otherwise. -->

**Blast Radius:**

<!-- How far a bad merge reaches: users, consumers, layout, stored data. -->

## Verification

<!--
Commands run and their results. `npm test` and `npm run typecheck` are the
floor; name any check you could not run and why.
-->
