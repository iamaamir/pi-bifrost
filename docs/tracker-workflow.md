# Tracker workflow

How Bifrost's GitHub issues, sub-issues, dependencies, milestones and project board are read and written by agents. The delivery plan lives in the issue tracker; `roadmap-next.md` holds the requirement IDs the tickets cite.

Every command below was run against `iamaamir/pi-bifrost`.

## Read authoritatively

Search-backed listings lag. `gh issue list --label <label>` is search-backed and under-reported right after a write in this repository (20 versus 23, 5 versus 7, 9 versus 11 within one session). Treat list output as a hint.

Authoritative per object:

```bash
gh issue view 176 -R iamaamir/pi-bifrost --json labels,parent,subIssues
```

Children of a parent:

```bash
gh api repos/iamaamir/pi-bifrost/issues/176/sub_issues --jq 'length'
```

Many objects at once — one GraphQL query, aliased:

```bash
gh api graphql -f query='query { repository(owner:"iamaamir", name:"pi-bifrost") { i153: issue(number:153) { blockedBy(first:50) { nodes { number } } } i168: issue(number:168) { blockedBy(first:50) { nodes { number } } } } }'
```

After any write, verify from the object, not from a listing.

## Write

Blocking edges are native. Add and remove them on the blocked issue:

```bash
gh issue edit 153 -R iamaamir/pi-bifrost --add-blocked-by 149,150
gh issue edit 153 -R iamaamir/pi-bifrost --remove-blocked-by 150
```

Keep the body's `## Blocked by` list in step with the native edges. Neither is generated from the other, so both must be updated.

Parent/child attachment needs the child's database id, not its number:

```bash
id=$(gh api repos/iamaamir/pi-bifrost/issues/146 --jq .id)
gh api --method POST repos/iamaamir/pi-bifrost/issues/169/sub_issues -F sub_issue_id="$id"
```

Nesting works: master → wave → ticket is two levels deep here.

Milestones and board items:

```bash
gh issue edit 146 -R iamaamir/pi-bifrost --milestone "Wave 0 — Baseline integration"
gh project item-add 2 --owner iamaamir --url https://github.com/iamaamir/pi-bifrost/issues/146 --format json
```

Before claiming a CLI cannot do something, run `gh <command> --help`. `gh issue edit` supports `--add-blocked-by` and `--remove-blocked-by`; `gh project` needs the `project` OAuth scope and fails with an explicit message when it is missing.

## Bulk edits

1. Fetch bodies into a staging directory.
2. Transform the staged copies.
3. Diff against the originals and read the diff.
4. Publish with `gh issue edit --body-file`.
5. Re-fetch and read the section that changed.

Do not skip step 3. A transform that re-read the originals instead of the staged copy kept only the last edit for 12 of 18 issues; the diff was the only thing that noticed before publication.

## Citation rule

A citation must be readable by the agent doing the work. Repository sources are committed by default, but `roadmap-next.md` is deliberately local-only: it is the requirement source for these tickets and is never published.

`node scripts/check-issue-refs.mjs --ref v2 <issue>…` checks every repository path cited in the given issues.

- A path missing from the working tree fails the check.
- A path present locally but absent from the branch is reported as local-only and does not fail. Add `--require-remote` when a citation must be readable from the remote.
- `--ref` selects the branch, defaulting to the default branch of the repository being checked. `--offline` checks the working tree only.

To confirm remote presence directly:

```bash
gh api repos/iamaamir/pi-bifrost/contents/AGENTS.md?ref=v2
```

A 404 means that path is not on that branch.

## Conventions

- One milestone per wave. Labels: `wave` on parents, `ready-for-agent` on tickets, `experimental` on waves without production authorization.
- Tickets cite requirement IDs from the PRD instead of restating requirements.
- Correcting a ticket set means editing issues: preserve requirement IDs, issue numbers and scope, and do not recreate issues to fix text or edges.
