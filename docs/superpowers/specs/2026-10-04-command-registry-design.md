# Centralized Command Registry

Status: draft for review (revision 2)
Date: 2026-10-04
Branch: `refactor/command-registry` (stacked on `chore/no-agent-attribution`, PR #20)

> Revision 2 supersedes revision 1 after independent review. Revision 1 was
> drafted against the wrong file state, overstated a merge-safety claim, and
> proposed a design larger than the problem. Changes are listed in
> [What changed](#what-changed-from-revision-1).

All line numbers refer to `commands.ts` at this branch's base (`e2beb5b`, 1215
lines). This branch does **not** contain PR #19.

## Problem

Command metadata lives in two lists that share no common structure:

| List | Location | Count | Owns |
|---|---|---|---|
| `BIFROST_COMMAND_OPTIONS` | `commands.ts:716` | 19 | value, description, argumentHint |
| `routes` | `commands.ts:892` | 18 | dispatch, plus a second copy of value and description |
| `dashboardCommands` | `commands.ts:757` | 8 hardcoded strings | which commands the menu shows |

Three defects are already present:

1. **`classifier` has two different descriptions.**
   `commands.ts:729` says `"Choose classifier backend"`.
   `commands.ts:1079` says `"Choose classifier backend and prompt model"`.

2. **`init -f` is a phantom entry.** It exists in the options list
   (`commands.ts:725`) with no route of its own, which is why the lists are 19
   and 18. `init`'s matcher (`commands.ts:1046`) accepts it, so typing
   `/bifrost init -f` works. Selecting it from a picker does not: both picker
   paths resolve by value and bail on a miss —
   `commands.ts:1180-1181` (dashboard) and `commands.ts:1209-1210` (unknown
   subcommand). The second is reachable, and `runBifrostCommand` has already
   cleared the editor at `commands.ts:693`, so the user gets a silent no-op.

   The canonical doc disagrees with the code here: `docs/guide/commands.md`
   documents `init` with a `-f` flag and has no `init -f` row. The code is
   wrong, not the doc.

3. **The menu shows 8 of 19 values.** `benchmark`, `cache stats`,
   `cache clear`, `classifier`, `classifier on`, `classifier off`,
   `classifier test`, `debug`, and `init -f` never appear. The dashboard also
   shows only the actionable member of each `on`/`off` and `pin`/`unpin` pair.

## Goal

Each fact about a command is written once. Adding a command means adding one
registry entry; descriptions, completion, and dispatch follow from it.

## Approach

Keep `BIFROST_COMMAND_OPTIONS` as the single registry, unchanged in name and
location. Keep `exact()`, `prefix()`, and `routes` where they are. Change one
thing: **the route helpers stop taking a description and resolve it from the
registry instead.**

```ts
function exact(value: string, handler: CommandFn): CommandEntry {
  const spec = requireSpec(value);
  return { ...spec, match: (sub) => sub === value, handler };
}
```

`description` and `argumentHint` then exist in exactly one place per command, so
defect 1 becomes structurally impossible rather than merely test-caught.

`init` keeps its bespoke matcher. `prefix()` is a bare `startsWith` with no
word boundary; `init` is space-bounded (`commands.ts:1046`). Replacing it with
a declarative strategy would make `/bifrost initialize` run `handleInit`, where
today it falls through to the picker. That behavior change is not wanted.

### Why not a bigger refactor

Revision 1 proposed extracting `buildCommandHandlers`, renaming the export to
`COMMANDS`, replacing the helpers with a declarative `match` discriminant, and
adding a `menu` rank field. Review found the justification did not survive
contact with the design:

- Extracting the handler map moves every handler body anyway, so "avoid touching
  15 handlers" did not discriminate it from the alternative it rejected.
- A rank field that only orders a flat list is equivalent to array position,
  and `ctx.ui.select` is called with `string[]`, so there is no grouping
  primitive to feed.
- `match: "exact" | "prefix"` cannot express `init`'s space-bounded matcher.

The registry-plus-description-resolution above captures the actual win — one
owner per fact — at roughly a quarter of the diff, with no renamed export and no
new module surface.

## Design

### Registry

`BIFROST_COMMAND_OPTIONS` gains one field:

```ts
interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
}
```

`init -f` folds into `init` as `aliases: ["init -f"]`. `init`'s description
becomes:

> Probe models and generate config (pass -f to force re-probe)

This matches what `docs/guide/commands.md` already documents and removes the
phantom entry rather than patching it.

### Completion

`getBifrostCommandCompletions` (`commands.ts:738`) currently reads `.value` in
two places: the exact-match early return (`:743`) and the prefix filter
(`:744`). Both must flatten aliases, or `init -f` silently disappears from
completion while still working when typed.

The early return exists to stop Pi accepting a suggestion and leaving the
command text stuck in the editor (`commands.ts:740-742`). It must cover exact
aliases too, and that needs its own test.

### Routes

The three hand-written literals — `init` (`commands.ts:1043-1048`),
`classifier test` (`commands.ts:1071-1076`), `classifier` (`commands.ts:1077-1082`) — are
converted to `exact()`/`prefix()` calls so all 18 routes carry a
registry-resolved description. Bypassing the helpers is what allowed the
description drift.

Dispatch keeps its first-match-wins loop (`commands.ts:1186-1192`) and its array
order. Order was verified not to be load-bearing: no route's matcher can match
another route's value.

Dispatch must continue to pass the original argument text, not the spec value.
`commands.ts:1189` passes `trimmed`; `handleInit` parses `--write` from it and
`tests/bifrost-commands.test.ts:381` covers that. Passing `spec.value` would
silently break `init --write` while the report stays green.

### Menu

`dashboardCommands` keeps its state-aware selection — the actionable member of
each pair — but resolves values, descriptions, and hints from the registry
instead of hardcoding eight strings and looking them up.

A flat 18-row menu was considered and rejected: with routing enabled, the first
row would be `on`, which only re-logs "Bifrost enabled". That trades a real UX
regression for extra discoverability.

This leaves defect 3's discoverability half open, so it is addressed directly:

**Add a `/bifrost help` alias that opens the full command list.** `help` is
already on the roadmap at `docs/ui-enhancements.md:22` ("Explicit help for
TUI/RPC/print — reuse command metadata and examples"), so this is the planned
answer rather than a new invention. It is one registry entry plus one route, and
it makes all 18 discoverable without putting an inert row first.

## Testing

New `tests/command-registry.test.ts`:

- every `BIFROST_COMMAND_OPTIONS` value resolves to a route, and every route
  value is in the registry — in both directions
- every route's description and `argumentHint` equal the registry's, which fails
  if a hand-written literal reappears
- every alias is globally unique and does not collide with any value
- `getBifrostCommandCompletions` offers every alias
- `getBifrostCommandCompletions` returns `null` for an exact value **and** for an
  exact alias
- `/bifrost help` lists every command value
- dispatch passes the original argument text through, so `init --write` still
  works

New `tests/docs-command-drift.test.ts`:

- parse the command column from `docs/guide/commands.md` and assert set-equality
  with the registry, excluding the bare `/bifrost` row and aliases
- same for `docs/llms.txt`

`tests/bifrost-commands.test.ts:187` asserts the menu is 8 rows. That assertion
is correct today and must be updated deliberately rather than discovered by a
failing run.

## Docs

`docs/guide/commands.md:8` tells users to pass `-f` (`--force`) to re-probe.
`isForced` (`commands.ts:258`) only matches `-f`, so `/bifrost init --force`
silently reuses the cached probe and does the opposite of what the doc promises.
The drift test will fail on this file; the doc line is corrected to `-f` in the
same change. The code is not changed.

`docs/ui-enhancements.md:22` names `BIFROST_COMMAND_OPTIONS` as the completion
source, which stays accurate under this design.

Eleven files enumerate commands. Only the two machine-checkable ones
(`docs/guide/commands.md`, `docs/llms.txt`) are covered by the drift test; the
rest are prose and stay hand-written. Generating prose documentation is out of
scope.

## Non-goals

- No rename of `BIFROST_COMMAND_OPTIONS`; no new exported module surface.
- No `DecisionTrace`, no stage timings, no structured candidate records.
  ADR 0007 stays proposed.
- No change to how any command behaves, apart from `init` gaining the `help`
  alias and `init -f` resolving through one entry.

## Risks

- **Merge interaction with PR #19.** Both edit `commands.ts`. `handlePreview`
  ends near line 682 and the registry region starts near 697, so the regions are
  close, not far apart. Revision 1 claimed 430 lines of separation; that was
  wrong and is the main reason merge resolution may be needed. The description
  pull-through touches `commands.ts:716-736`, the same block PR #19 does not
  modify, so the overlap should stay small.
- **Revert leaves tests behind.** Reverting restores the old helpers but leaves
  `tests/command-registry.test.ts` and the doc-drift test asserting the new
  shape. Reverting requires removing the two new test files in the same revert.
- **The `help` alias is new user-facing surface**, small but not zero. It is the
  smallest thing that makes the remaining commands discoverable.

## Verification

```bash
npm test
npm run typecheck
npm run test:integration
npm run test:ui
```

`npm run test:ui` types `/bifrost` and captures the open menu. It has no golden
comparison, so it will pass regardless of menu contents; the menu assertions
live in `tests/bifrost-commands.test.ts`.

## What changed from revision 1

- Line numbers corrected. Revision 1 cited `commands.ts` from a worktree
  containing PR #19 and was off by ~85 lines throughout.
- Merge-gap claim corrected from 430 lines to roughly 15.
- `tests/bifrost-commands.test.ts:187`'s menu-size assertion was missed entirely.
- Menu reverted from a flat 18 rows to state-aware rows, plus a `help` alias for
  discoverability. The annotation predicate revision 1 specified keyed off
  `"on"` and `state.enabled` and was wrong for the `pin`/`unpin` pair.
- The claim that an alias keeps `init -f` in completion was false;
  `getBifrostCommandCompletions` reads only `.value`. Now specified and tested.
- The `match: "exact" | "prefix"` discriminant was dropped because it cannot
  express `init`'s space-bounded matcher without changing behavior.
- `buildCommandHandlers`, the `COMMANDS` rename, and the `menu` rank field were
  dropped as unjustified diff.
- Doc drift moved from accepted debt to a test, after `docs/guide/commands.md`
  was found to be wrong about `--force`.