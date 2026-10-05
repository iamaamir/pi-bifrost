# Centralized Command Registry

Status: draft for review (revision 3)
Date: 2026-10-04
Branch: `refactor/command-registry` (stacked on `chore/no-agent-attribution`, PR #20)

> Revision 3 supersedes revisions 1 and 2. Revision 1 cited the wrong file and
> over-engineered the solution. Revision 2 fixed the citations but specified a
> mechanism that copies a field nothing reads. Changes are listed in
> [What changed](#what-changed-from-revision-2).

All line numbers refer to `commands.ts` at commit `e2beb5b` (1215 lines). This
branch does **not** contain PR #19.

## Problem

Command metadata lives in two lists that share no structure:

| List | Location | Count | Carries |
|---|---|---|---|
| `BIFROST_COMMAND_OPTIONS` | `commands.ts:716` | 19 | value, description, argumentHint |
| `routes` | `commands.ts:892` | 18 | value, description, match, handler |
| `dashboardCommands` | `commands.ts:757` | 8 hardcoded strings | which commands the menu shows |

Three defects are already present:

1. **`classifier` has two different descriptions.**
   `commands.ts:729` says `"Choose classifier backend"`.
   `commands.ts:1077-1082` says `"Choose classifier backend and prompt model"`
   (`:1079`).

2. **`init -f` is a phantom entry.** It exists in the registry (`:725`) with no
   route of its own, which is why the counts are 19 and 18. `init`'s matcher
   (`:1046`) happens to accept it, so `/bifrost init -f` works when typed.
   Selecting it from a picker does not: both picker paths resolve by value and
   bail on a miss — `commands.ts:1180-1181` and `commands.ts:1209-1210`. The
   second is reachable, and `runBifrostCommand` has already cleared the editor at
   `commands.ts:693`, so the user gets a silent no-op.

   `docs/guide/commands.md` documents `init` with a `-f` flag and has no
   `init -f` row. The code is wrong, not the doc.

3. **The menu shows 8 of 19 values.** `benchmark`, `cache stats`,
   `cache clear`, `classifier`, `classifier on`, `classifier off`,
   `classifier test`, `debug`, and `init -f` never appear.

## Goal

**Each description and argument hint is written once, and a route physically
cannot carry one.**

Not "one list of commands." Command membership, matcher semantics, menu
membership, and ordering all stay multiply-written; see
[Known debt](#known-debt).

## Approach

Narrow `CommandEntry` so it no longer extends `CommandSpec`:

```ts
interface CommandEntry {
  readonly value: string;
  readonly match: (sub: string) => boolean;
  readonly handler: CommandFn;
}
```

Nothing reads a route's description or `argumentHint` today.
`formatBifrostCommandChoice` takes a `CommandSpec` (`commands.ts:752`) and is
only ever called with registry entries — from `dashboardCommands`, or from the
default `options` at `commands.ts:774`. The picker paths read
`selected.argumentHint` (`:1175`, `:1203`) off a `CommandSpec`, not off a route.
Routes are touched only for `.match`, `.handler`, and `.value` (`:1180`,
`:1182`, `:1187`, `:1189`, `:1209`, `:1212`, `:1213`).

So dropping the fields deletes dead data rather than adding a lookup. More
importantly, `CommandEntry extends CommandSpec` currently *requires* a
`description` on every route, which is precisely how a hand-written literal with
a stale description compiles at all. Removing the requirement makes defect 1 a
type error instead of a convention.

### Matchers

Three helpers, each preserving today's exact semantics:

```ts
function exact(word: string, handler: CommandFn): CommandEntry
function prefix(word: string, handler: CommandFn): CommandEntry   // bare startsWith
function spaced(word: string, handler: CommandFn): CommandEntry   // === word || startsWith(word + " ")
```

`prefix()` is a bare `startsWith` with no word boundary today, which is correct
for free-text prompts: `/bifrost previewXYZ` dispatches `handlePreview` with
prompt `XYZ`. That behavior is preserved.

`init` needs `spaced()`. Converting it to `exact()` would match only
`sub === "init"` and silently break both `/bifrost init -f` and
`/bifrost init --write`. Converting it to `prefix()` would make
`/bifrost initialize` run `handleInit`, where today it falls through to the
picker. `spaced()` keeps both correct.

`prefix()`'s existing `argumentHint = "<prompt>"` default is deleted. With
`argumentHint` gone from `CommandEntry`, a default there would be unread.

### `init -f`

Folds into `init` as `aliases: ["init -f"]`, and `init`'s description becomes:

> Probe models and generate config (pass -f to force re-probe)

This matches what `docs/guide/commands.md` already documents and removes the
phantom rather than patching it.

### Completion

`getBifrostCommandCompletions` (`commands.ts:738`) reads `.value` in **four**
places, and all four must change:

| Line | Read | Purpose |
|---|---|---|
| `:743` | `.some((c) => c.value === normalized)` | early return so an exact command submits |
| `:744` | `.filter((c) => c.value.startsWith(normalized))` | which commands match the typed prefix |
| `:745` | `value: command.value` | the emitted completion value |
| `:746` | `label: command.value` | the emitted completion label |

Flattening only `:743` and `:744` would leave `init -f` filterable but never
*emitted* — reintroducing exactly the "works when typed, missing from
completion" defect this change removes.

The early return exists so Pi accepts the command instead of leaving the text
stuck in the editor (`commands.ts:740-742`). It must cover exact aliases too.

### The `aliases` contract

`aliases` is **completion-only**. Dispatch (`commands.ts:1186-1192`) consults
`route.match(sub)` and nothing else; `aliases` is not on `CommandEntry` at all.

`/bifrost init -f` dispatches because `spaced("init")` accepts
`"init -f"`, not because the alias is honored.

That makes the following an invariant, stated so it is not broken later:

> Every alias must be reachable by its parent's matcher. For an `exact()` or
> `spaced()` parent that means `alias === parent.value + " " + <rest>`. An alias
> on an `exact()` command is a bug: it would appear in autocomplete, submit
> cleanly on exact match, and then fall through to the unknown-subcommand
> picker — a silent failure of the class this change removes.

An alias test asserts dispatchability, not just presence in completion.

### Menu

`dashboardCommands` keeps its state-aware selection — the actionable member of
each pair — but resolves values, descriptions, and hints from the registry
instead of hardcoding eight strings.

Its trailing non-null assertion (`commands.ts:768`) becomes a checked lookup, so
a renamed command fails a test instead of throwing inside the picker.

A flat 18-row menu was considered and rejected: with routing enabled the first
row would be `on`, which only re-logs "Bifrost enabled". That trades a real UX
regression for discoverability.

That leaves defect 3's discoverability half open. It is addressed by a
`/bifrost help` alias in a **separate** PR, already on the roadmap at
`docs/ui-enhancements.md:22`. It is deliberately not in this change: the obvious
implementation opens a picker, which returns `undefined` without a UI
(`commands.ts:776`), so it would be a silent no-op in print and RPC — the exact
defect class this change exists to remove.

## Testing

Registry and menu assertions go in `tests/bifrost-commands.test.ts`, which
 already builds the router and the fake context. Only the drift test gets a new
 file, deliberately, so it can be reverted alone. Every commit is independently
 revertible; see [Revert](#revert).

**Registry and matcher**

`routes` is a function-local `const` inside `createCommandRouter`
(`commands.ts:892`), and the router returns only the dispatcher closure
(`:1153`). No handler echoes its route's `value`, and a first-match-wins loop
makes "exactly one route matched" unobservable — a shadowed route produces no
difference. So this asserts **observable effects**, table-driven through the
real router with the existing fake context, which needs no new export:

| input | asserted effect |
|---|---|
| `on` | `state.enabled === true` |
| `off` | `state.enabled === false` |
| `pin` | `state.pinned === true` |
| `unpin` | `state.pinned === false` |
| `cache stats` | logged output contains `cache:` |
| `debug` | logged output contains `--- config ---` |
| `classifier on` / `classifier off` | `state.classifierEnabled` flips |

This catches shadowing, which is the point: if a `prefix` route swallowed
`cache stats` or `classifier test`, the wrong effect fires and the row fails.
Every registry value must map to an effect, and every value that produces no
distinct effect must be listed with the reason.

Two authoring traps in `tests/bifrost-commands.test.ts`:

- the shared fake resolves a selection with
  `options.find((o) => o.includes("/bifrost off"))`, so any test needing
  `preview` or `pin` must pass an explicit `selectOverride` or it passes
  vacuously
- match on `"/bifrost pin"`, not `"pin"`, or `/bifrost unpin` false-positives

Plus:

- `/bifrost initialize` opens the unknown-subcommand picker and does **not** run
  `handleInit`
- `classifier status`, `cache stats`, `cache clear`, `classifier test` are not
  swallowed by a `prefix` route
- dispatch passes the original argument text through, so `init --write` still
  works (`tests/bifrost-commands.test.ts:381` covers this today)
- `/bifrost init -f` forces a re-probe while `/bifrost init` reuses a fresh one

**Aliases and completion**

- every alias is unique and does not collide with any value
- completion offers every alias
- completion returns `null` for an exact value **and** for an exact alias
- every alias is reachable under its parent's matcher, asserted through the real
  router, not merely present in completion
- alias case handling, since dispatch lowercases (`commands.ts:1155`) and so
  does completion (`:739`)

**Menu**

- `dashboardCommands` resolves every entry for `enabled`/`pinned` in both states
- with routing enabled the menu offers `off`, and selecting it runs the `off`
  route rather than `on`
- with routing pinned the menu offers `unpin`, not `pin`
- selecting `preview` prefills the editor and does not run `handlePreview`
  (`:1175-1178`)

**Documentation drift**

`tests/docs-command-drift.test.ts`, parsing only the first table of
`docs/guide/commands.md` (rows 7-25; a second table's header starts at `:78`,
so parsing stops there):

- read the first cell of each row
- strip the `/bifrost ` prefix and any `<prompt>` suffix
- drop the bare `/bifrost` row, which is the dashboard entry, not a subcommand
- assert set-equality with the registry values, excluding aliases
- on failure, print both sets as a sorted diff

`docs/guide/commands.md:8` is corrected in the same change: it promises `-f`
(`--force`), but `isForced` (`commands.ts:258`) matches only `-f`, so
`/bifrost init --force` silently reuses the cached probe and does the opposite
of what the doc says. The code is not changed.

After folding `init -f` into an alias, the table has 19 rows, of which the bare
`/bifrost` row is excluded, leaving 18 commands against 18 registry values. The
assertion holds without inventing documentation.

`docs/llms.txt` is deliberately excluded. It references 10 commands in prose
bullets, not as a reference table. Set-equality would fail on roughly 10 absent
commands and would turn a curated overview into a command dump.

## Docs

One content fix: `docs/guide/commands.md:8`, above.

`docs/ui-enhancements.md:20` names `BIFROST_COMMAND_OPTIONS` as the completion
source, which stays accurate.

Everything else that mentions commands stays hand-written.

## Non-goals

- No rename of `BIFROST_COMMAND_OPTIONS`. No new exported surface.
- No `/bifrost help`; that is a separate PR.
- No `DecisionTrace`, no stage timings, no structured candidate records.
  ADR 0007 stays proposed.
- No change to how any command behaves, except `init -f` resolving through a
  single entry.

### Behavior changes this does cause

Stated plainly so the diff's blast radius is not understated:

1. `init`'s description gains the `(pass -f to force re-probe)` clause. Visible
   in the menu row and in autocomplete.
2. `classifier`'s description becomes the registry's
   `"Choose classifier backend"`, dropping `"and prompt model"`. This is a
   product copy decision; the shorter wording is the one already shown in
   autocomplete today, so autocomplete is unchanged and the menu row changes.
3. `init -f` is no longer a row in the unknown-subcommand picker. Typing it
   still works, and it still appears in completion via the alias. The picker
   goes from 19 rows to 18.

## Revert

Reverting the code leaves the new assertions in `tests/bifrost-commands.test.ts`
referencing `aliases` and the new helper signatures. The assertions live in the
existing file specifically so a revert is one commit range rather than a
coordinated deletion of new files. Commits are ordered so each is independently
revertible:

1. alias fold and completion flattening
2. `CommandEntry` narrowing, `spaced()`, and the three literal conversions
3. `dashboardCommands` checked lookup
4. `docs/guide/commands.md` correction
5. drift test

## Known debt

Stated so the goal is not read as more than it is.

- **Command membership** — which values are dispatchable is still written twice,
  registry and routes.
- **Matcher semantics** — encoded in the helper call, separate from the registry.
- **Menu membership** — `dashboardCommands` (`:759-766`) is still a hand-written
  list of eight values.
- **Ordering** — registry array order, routes array order, and the
  `dashboardCommands` list are three independent orderings.
- **Documentation** — `README.md`, `docs/llms.txt`, and the `docs/guide/*`
  prose remain hand-written and will drift on the next added command.

## Risks

- **Merge interaction with PR #19.** Both edit `commands.ts`. `handlePreview`
  ends at `:682` and the registry region starts at `:697`, a gap of 14 lines, so
  the regions are close and Git may need help. The blocks touched are
  `:697-736` (types and registry) and `:892-1151` (routes); PR #19's last hunk
  ends at old line 684, so the overlap should be limited to the type block.
- **`init -f` folding changes unknown-subcommand picker rows** from 19 to 18.
  No test asserts that count today, so it lands silently unless one is added.
  This is separate from `tests/bifrost-commands.test.ts:187`, which asserts the
  dashboard is 8 rows and needs no change under this design.
- **Description changes are user-visible** and are copy decisions, not mechanics.

## Verification

```bash
npm test
npm run typecheck
npm run test:integration
npm run test:ui
npm run test:ui:reliability
```

`AGENTS.md` requires `test:ui:reliability` for Pi UI and routing changes.

`npm run test:ui` types `/bifrost` and captures the open menu with no golden
comparison, so it passes regardless of menu contents. Menu assertions live in
`tests/bifrost-commands.test.ts`.

## What changed from revision 2

- Replaced the registry-lookup mechanism with a narrowed `CommandEntry`.
  Revision 2 had the helpers resolve the spec and spread it onto the entry,
  which copied `description` and `argumentHint` onto routes — fields nothing
  reads — and left `extends CommandSpec` in place, so a stale description on a
  hand-written literal would still compile. The claim that this made defect 1
  "structurally impossible" was an overclaim.
- Added `spaced()`. Revision 2 said `init` keeps its bespoke matcher *and* that
  all three hand-written literals convert to `exact()`/`prefix()`, which cannot
  both hold; `exact("init")` breaks `init -f` and `init --write`.
- Deleted `prefix()`'s `argumentHint` default, which would otherwise inject a
  hint — and so invert execute into prefill — for a future command.
- Cut `/bifrost help`. It is new surface in a change whose headline is "no
  behavior change," the picker-only version is a silent no-op without a UI
  (`commands.ts:776`), and it would have forced a documentation row.
- Narrowed the drift test to `docs/guide/commands.md`. `docs/llms.txt` documents
  7 commands as prose and cannot satisfy set-equality.
- Specified the doc parser's scope, because `commands.md` has a second table at
  `:79` and two rows carry `<prompt>` suffixes.
- Replaced the description-equality test with matcher-bijection and
  menu-dispatch tests. Set-equality of strings cannot catch a route that exists,
  holds the right value, and never matches it — the `init -f` bug class.
- Corrected `docs/ui-enhancements.md` citation: `:20` is the completion-source
  row, `:22` is the `help` row.
- Restated the goal, and listed what stays multiply-written.

Revision 3 additionally failed a third review. Two blocking defects, both in
the spec's own specification rather than in the code:

- The headline matcher test — "every registry value dispatches to exactly one
  route, and that route's `value` equals it" — is unobservable. `routes` is
  function-local (`commands.ts:892`), the router returns only the dispatcher
  closure (`:1153`), no handler echoes its route value, and a first-match-wins
  loop cannot distinguish one match from a shadowed second. Replaced with a
  table of observable effects, which catches shadowing without a new export.
- The completion instruction was wrong in a way that would have shipped the
  original defect. `.value` is read in four places (`:743`, `:744`, `:745`,
  `:746`), not two; `:745` and `:746` are what emit the completion. Flattening
  only the two the spec named would have made `init -f` filterable but never
  emitted.

Also fixed: the `aliases` contract is now stated (completion-only; every alias
must be reachable under its parent's matcher, so an alias on an `exact()` route
is a bug) and tested for dispatchability rather than mere presence; the
"rather than a new file" sentence no longer contradicts the drift-test file; six
citation errors corrected; `npm run test:ui:reliability` added to Verification.