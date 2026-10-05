# Command Surface Map

Status: draft for review
Date: 2026-10-05
Branch: `feat/feature-map` (off `main` = `v0.5.0`, `236622d`)

## Purpose

Answer one question, for a human or an agent with zero context: **what commands exist, and how do I reach each one?**

Bifrost's `/bifrost` dashboard already derives all 18 rows from `BIFROST_COMMAND_OPTIONS`. That ordering, grouping, and the per-command state notes exist only inside a picker at runtime. This change makes that surface readable outside the TUI, as a map.

## What this is not

- **Not a coverage matrix.** A survey of `tests/`, `tests/integration/`, and the PTY scripts found all 18 commands already dispatch-tested somewhere; there are no undiscovered commands. The gaps that exist are test-*layer* distribution, which this change deliberately does not claim to track.
- **Not a routing-surface map** (prompt → tier → candidate → model). That overlaps ADR 0007 and ADR 0011, both still Proposed.
- **Not a committed document.** See "Generated, never committed."

## Generated, never committed

The map is produced on demand and never written to the repository.

Rationale: a committed map becomes a second ordering of the same 18 commands alongside `docs/guide/commands.md`, which is pedagogically ordered. Two committed orderings are two drift surfaces. An on-demand generator has none — there is no file to hand-edit. This follows `scripts/jev-benchmark.ts`, which prints to stdout and never writes a file.

`docs/guide/commands.md` remains the human reference. The map and it are deliberately different artifacts and the map never claims to replace it.

## Design

### One implementation, no duplicated sort

The generator **calls the real menu builder** rather than re-deriving the ordering. `dashboardCommands` (`commands.ts:988`) currently returns `CommandSpec[]`, already ordered, with the state note folded into `description` (`commands.ts:1017`: `` `${resolved.description} (${note})` ``).

That function is currently module-private. This change **exports it**.

This overrides the "no new exported surface" rule in `docs/superpowers/specs/2026-10-04-command-registry-design.md`. The justification: without the export, the generator would re-implement `tierOf`, `groupOf`, `reflectedIsInert`, and the stable sort — a second copy of the ordering logic that could silently diverge from the menu it claims to mirror. One implementation, two consumers. The exposure is one pure function over `{ enabled, pinned }`.

### State is an input, because the order depends on it

The reflected pair sorts actionable-first, so the map's contents differ by state:

```
npm run command-surface                        # default: routing on, unpinned
npm run command-surface -- --enabled=false    # routing off
npm run command-surface -- --pinned=true
```

### Grouping

The dashboard sorts by tier but does not label tiers. The map derives **labels only** from the same registry fields the dashboard reads (`reflects` → state toggles, `menu === "common"` → common, else everything else). That is three lines and it labels the real order; it does not re-sort anything. Label-only derivation cannot make the map disagree with the menu about order.

### Output

Markdown by default, `--json` for a script. Both render from one row array, so they cannot disagree.

```
Bifrost command surface — routing on, unpinned
18 commands, in the order and grouping the /bifrost dashboard presents.

## State toggles

| Command | Description | Argument | Also accepted as |
|---|---|---|---|
| /bifrost off | Disable routing | | |
| /bifrost on | Enable routing (already on) | | |

## Common

| /bifrost preview | Preview routing for a prompt | [--json] <prompt> | |
| /bifrost init | Probe models and generate config (pass -f to force re-probe) | | init -f |
...

## Everything else

| /bifrost cache clear | Clear classification cache | | |
```

There is no separate state-note column: `dashboardCommands` already folds the note into `description`.

`--json` emits `{ state, groups: [{ label, rows: [{ command, description, argument, aliases }] }] }`.

### Files

- Create: `scripts/command-surface.ts`
- Modify: `package.json` — add `"command-surface": "node --experimental-strip-types scripts/command-surface.ts"`
- Modify: `commands.ts` — export `dashboardCommands`
- Test: `tests/command-surface.test.ts`

## Testing

The row array is produced by a pure exported `buildCommandSurface(state)`, so it is testable without running the CLI.

- every registry `value` appears exactly once
- row order equals `dashboardCommands(state)` for **all four** state combinations
- a probe entry inserted into the registry appears in the output — the auto-add guarantee
- `--json` parses and its row set deep-equals the markdown renderer's row set
- the map contains no column it cannot derive from the registry

## Non-goals

- No committed artifact, and therefore no new drift test for one.
- No matcher, side-effect, or test-coverage columns. Those need data the registry does not hold; this change stays inside what `CommandSpec` actually contains.
- No change to the dashboard's contents, order, or rendering.
- No change to `docs/guide/commands.md`.

## Known constraints

- **The map inherits the menu's ordering decisions.** `benchmark` and `providers` sit in the tail because they carry no `menu: "common"`. That is faithful to the menu, not an editorial choice. If the map should ever be ordered pedagogically instead, it stops being a faithful mirror and becomes a second opinion.
- **Registry order is the tiebreak for both this map and `docs/terminal-demo.js`**, which `tests/landing-command-menu.test.mjs` pins to registry order. This change does not alter that coupling; it inherits it.
- **The map is only as current as the commit you run it from.** It carries no version stamp beyond the registry it read.

## Verification

```bash
npm test
npm run typecheck
npm run command-surface
npm run command-surface -- --json | head -40
```

## Open question for the reviewer

Whether exporting `dashboardCommands` is the right call versus recomputing the order inside the generator and accepting a second copy of the sort logic. The spec argues for the export; a reviewer that disagrees should say what drift risk they think is worse.