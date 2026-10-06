# Command Surface Map

Status: draft for review (revision 3)
Date: 2026-10-05
Branch: `feat/feature-map` (off `main` = `v0.5.0`, `236622d`)

> Revision 3 drops the pure-module extraction, which revision 2 introduced and
> whose first review found a load-time `ReferenceError`. It also fixes a
> self-contradictory `description` contract and relocates the renderers out of the
> untypechecked `scripts/` directory. Corrections are listed in
> [What changed](#what-changed-from-revision-2).

## Purpose

Answer one question, for a human or an agent with zero context: **what commands exist, and how do I reach each one?**

`/bifrost` already derives all 18 picker rows from `BIFROST_COMMAND_OPTIONS`. That ordering, grouping, and the per-command state notes exist only inside a TUI picker at runtime. This change makes that surface readable outside it.

## What this is not

- **Not a coverage matrix.** All 18 commands are already dispatch-tested somewhere. `classifier test`'s only dispatch is `tests/integration/integration.test.mjs:161`, which is outside `npm test`'s glob. There are no undiscovered commands, so a coverage map would track a gap that does not exist.
- **Not a routing-surface map** (prompt → tier → candidate → model). Overlaps ADR 0007 and ADR 0011, both still Proposed.
- **Not committed.** See below.

## Generated, never committed

Produced on demand, never written to the repo. A committed map would be a second ordering of the same 18 commands alongside `docs/guide/commands.md`, which is pedagogically ordered. Two committed orderings are two drift surfaces. Precedent: `scripts/jev-benchmark.ts` prints to stdout and never writes a file.

## Design

### One export, no extraction

`commands.ts` exports `dashboardCommands`. Nothing else moves.

Revision 2 proposed extracting the registry into a root-level pure module to avoid loading the Pi SDK (~394 ms measured for the SDK, ~17 ms without). That is a real but modest gain for a script a human runs by hand, and it cost correctness: `PREVIEW_SUB` (`commands.ts:715`) is referenced *inside* `BIFROST_COMMAND_OPTIONS` at `:916`, so moving the registry without it creates a circular import, and the module-level array literal then reads `PREVIEW_SUB` while `commands.ts` is still in its temporal dead zone — a `ReferenceError` on module load. Dropped.

`dashboardCommands`'s dependencies are `BIFROST_COMMAND_OPTIONS`, `requireCommand`, and `reflectedIsInert` — all already in `commands.ts`. No hidden coupling.

### Where the logic lives

| File | Contents | Typechecked? |
|---|---|---|
| `command-surface.ts` (repo root) | `buildCommandSurface`, `renderMarkdown`, `renderJson` | **yes** — `tsconfig.json` includes `"*.ts"` |
| `scripts/command-surface.ts` | argv parsing, print | **no** — `scripts/` is outside the program |

`tsconfig.json:17` includes `["*.ts", "tests/**/*.ts"]`. A planted type error under `scripts/` produces zero errors from `npm run typecheck`; the same file at the repo root errors. So all logic lives at the root and is directly importable by tests; the script is a thin wrapper whose argv handling is covered by an `execFileSync` smoke test instead.

The root file imports `commands.ts`. `commands.ts` does not import it, so there is no cycle.

### Row construction

`buildCommandSurface` uses `dashboardCommands` **for order only**, and reads every field from the registry:

```ts
const ordered = dashboardCommands(state);              // order, nothing else
return ordered.map((row) => {
  const spec = BIFROST_COMMAND_OPTIONS.find((s) => s.value === row.value)!;
  const inert = spec.reflects ? spec.reflects.sets === state[spec.reflects.state] : false;
  return {
    value: spec.value,
    description: spec.description,                     // bare, from the registry
    argument: spec.argumentHint ?? null,
    note: inert ? spec.reflects!.note : null,
    inert,
    aliases: spec.aliases ?? [],
  };
});
```

Revision 2 said "copy the row before annotating" and "emit `description` unmodified." Those conflict. `dashboardCommands` already folds the note into `description` for inert rows (`commands.ts:1017`: `` `${resolved.description} (${note})` ``), so taking `description` from its return value double-reports it — `Enable routing (already on)` plus a separate `note`. Stripping the parenthetical with a regex is worse: it corrupts `init`, whose `(pass -f to force re-probe)` is genuine prose. Reading the bare description from the registry avoids both, and `reflects` is already the authority for whether a note applies.

The one non-null assertion is safe because `dashboardCommands` resolves every row through `requireCommand`, so a row without a registry entry throws before reaching it.

### State is an input

The reflected pair sorts actionable-first, so output differs by state. Default `enabled: true, pinned: false`.

```
node --experimental-strip-types scripts/command-surface.ts --enabled=false
node --experimental-strip-types scripts/command-surface.ts --pinned=true
```

Invoke via `node`, not `npm run` — npm writes its `> pkg@ver script` banner to **stdout**, which corrupts `--json`. (`npm run --silent command-surface -- --json` also works; the `node` form is documented because it does not depend on npm's flag handling.)

### Grouping, and what is editorial

The dashboard has **no grouping**: `pickBifrostCommand` passes 18 flat strings to `ctx.ui.select` (`commands.ts:1027`). The map *invents* three groups from the same fields the dashboard sorts by:

| Label | Condition |
|---|---|
| `State toggles` | `spec.reflects` present |
| `Common` | `spec.menu === "common"` |
| `Everything else` | neither |

Read top-down as ordered precedence, matching `tierOf` at `commands.ts:995`. `CommandSpec` permits `reflects` *and* `menu: "common"` together; `tierOf` places that in tier 0, and so does this table. No live entry does.

One lossiness, accepted: the map collapses `on`/`off` and `pin`/`unpin` into one `State toggles` table. The dashboard's sort keeps them as two groups (`reflectedStates` is `["enabled","enabled","pinned","pinned"]`). Order is preserved; the pairing is not visible.

### Output

Markdown by default, both renderers over one row array so they cannot disagree.

```
Bifrost command surface — routing on, unpinned
18 commands. Order matches the /bifrost dashboard; grouping is editorial.

Open the surface by typing /bifrost and pressing enter.

## State toggles

| Command | Description | Argument | Note |
|---|---|---|---|
| /bifrost off | Disable routing | | |
| /bifrost on | Enable routing | | already on |

## Common

| /bifrost preview | Preview routing for a prompt | [--json] <prompt> | |
| /bifrost init | Probe models and generate config | | |

## Everything else

| /bifrost cache clear | Clear classification cache | | |
```

Markdown cells escape `|` as `\|`. No current description contains a pipe, so the table renders correctly today by luck; this makes it a rule.

The `Note` column is populated only for the four reflected commands.

**The bare `/bifrost` entry point is stated in the header.** It is not a registry entry — `tests/docs-command-drift.test.ts:34-35` drops it deliberately as "the dashboard, not a subcommand" — so the generator states it. Without it the map cannot answer "how do I reach each one."

**No alias column.** Aliases are completion-only and are not on `CommandEntry`, so a column headed "Also accepted as" would assert a dispatchability the contract does not guarantee. Aliases are carried in the JSON output, where no claim is attached.

`--json` emits `{ state, total, groups: [{ label, rows: [{ command, value, description, argument, note, inert, aliases }] }] }`, with `null` where inapplicable.

### Discoverability

One prose line in `docs/guide/commands.md`, **outside** the command table, pointing at the script. Without it an uncommitted artifact is unreachable by its stated audience. The drift test's parse is set-based over `` | `/bifrost `` rows, so a prose line outside the table does not affect it.

### Files

- Create: `command-surface.ts` — pure row builder and renderers
- Create: `scripts/command-surface.ts` — thin CLI
- Create: `tests/command-surface.test.ts`
- Modify: `commands.ts` — export `dashboardCommands`
- Modify: `docs/guide/commands.md` — one prose line
- Modify: `package.json` — `"command-surface": "node --experimental-strip-types scripts/command-surface.ts"`

## Testing

- every registry `value` appears exactly once
- row order equals `dashboardCommands(state)` for **all four** state combinations
- `description` equals the **registry entry's** description — asserted against `BIFROST_COMMAND_OPTIONS`, not against the builder's own output, since the vacuous reading ("the builder did not mutate it") cannot catch the double-report this design exists to avoid
- `note` and `inert` are non-null exactly when `spec.reflects.sets === state[spec.reflects.state]`; `init` has `note === null` despite its parenthetical
- markdown output escapes a `|` in a description
- the header's command count equals `BIFROST_COMMAND_OPTIONS.length`
- a probe entry inserted into `BIFROST_COMMAND_OPTIONS` appears in the output and is restored in a `finally` — the registry is module-level shared state and the array is `readonly`, so the test needs a cast
- **one `execFileSync` smoke test** runs the CLI with `--json --enabled=false --pinned=true`, parses the output, and asserts the reflected pair swapped. This covers argv parsing and both renderers — including that the two state flags actually take effect, which is the entire reason `dashboardCommands` is state-parameterised. Precedent: `tests/release-package.test.mjs` uses `execFileSync`.

There is deliberately **no labels-match-tiers test**. Revision 2 proposed one; it was a tautology, because the builder's label and the test's expected label derive from the same fields through the same expression, and `tierOf` is module-private so neither reads it. Cross-checking would require exporting `tierOf` purely for the test, which is surface for no gain. The order test is the real one.

## Non-goals

- No committed artifact, and therefore no new drift test for one.
- No matcher, side-effect, or test-coverage columns.
- No change to the dashboard's contents, order, or rendering.
- No change to `docs/guide/commands.md`'s command rows or ordering.

## Known constraints

- The map inherits the menu's ordering. `benchmark` and `providers` sit in the tail because they carry no `menu: "common"`.
- Registry order is also pinned by `tests/landing-command-menu.test.mjs` for `docs/terminal-demo.js`. Adding a 19th command correctly fails that test; this change inherits the coupling.
- The map is only as current as the commit it is run from.
- `scripts/command-surface.ts` remains outside the tsconfig program. Its whole surface is argv handling, covered by the smoke test.
- The header's `/bifrost` string is the one output line with no drift guard. `docs/guide/commands.md:7` documents it, but nothing asserts the two stay in step.

## Verification

```bash
npm test
npm run typecheck
node --experimental-strip-types scripts/command-surface.ts | head -30
node --experimental-strip-types scripts/command-surface.ts --json | head -40
```

## What changed from revision 2

- **Dropped the pure-module extraction.** It introduced a load-time `ReferenceError`: `PREVIEW_SUB` is used inside `BIFROST_COMMAND_OPTIONS`, so moving the registry without it creates a cycle and a TDZ read. The ~394 ms SDK load is accepted.
- **Fixed a self-contradictory `description` contract.** Revision 2 said both "copy the row before annotating" and "emit `description` unmodified"; `dashboardCommands` already folds the note in, so the two combined into a double-report. Row fields now come from the registry; only order comes from `dashboardCommands`.
- **Moved the renderers to the repo root**, out of the untypechecked and unimportable `scripts/` directory, which is what made one of revision 2's seven tests impossible to write.
- **Deleted the tautological labels-match-tiers test**, with the reason stated.
- **Extended the smoke test to cover `--enabled` and `--pinned`**, which revision 2 left untested despite state being the reason `dashboardCommands` is parameterised.
- **Corrected three facts:** the SDK load is ~394 ms and the pure module ~17 ms (directionally right, ~23×, but the earlier figures were wrong); there are **three** importers of `BIFROST_COMMAND_OPTIONS`, not two; `ReflectedState` would have been exported and used by nobody.