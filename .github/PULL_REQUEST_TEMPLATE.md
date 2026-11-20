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
