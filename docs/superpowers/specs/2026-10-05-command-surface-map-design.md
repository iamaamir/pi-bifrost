# Command Surface Map

Status: draft for review (revision 2)
Date: 2026-10-05
Branch: `feat/feature-map` (off `main` = `v0.5.0`, `236622d`)

> Revision 2 fixes five blocking defects found in review. Revision 1 asserted
> three things that were false about the code; the corrections are listed in
> [What changed](#what-changed-from-revision-1).

## Purpose

Answer one question, for a human or an agent with zero context: **what commands exist, and how do I reach each one?**

`/bifrost` already derives all 18 picker rows from `BIFROST_COMMAND_OPTIONS`. That ordering, grouping, and the per-command state notes exist only inside a TUI picker at runtime. This change makes that surface readable outside it.

## What this is not

- **Not a coverage matrix.** All 18 commands are already dispatch-tested somewhere. `classifier test`'s only dispatch is `tests/integration/integration.test.mjs:161`, which is not in `npm test` — but there are no undiscovered commands, so a coverage map would track a gap that does not exist.
- **Not a routing-surface map** (prompt → tier → candidate → model). That overlaps ADR 0007 and ADR 0011, both still Proposed.
- **Not committed.** See below.

## Generated, never committed

Produced on demand, never written to the repo. A committed map would be a second ordering of the same 18 commands alongside `docs/guide/commands.md`, which is pedagogically ordered. Two committed orderings are two drift surfaces; an on-demand generator has none. Precedent: `scripts/jev-benchmark.ts` prints to stdout and never writes a file.

## Design

### Extract a pure registry module

New `command-registry.ts` at the repo root, importing nothing from the Pi SDK, holding:

- `CommandSpec`
- `ReflectedState` and a `MenuState` type (`{ enabled: boolean; pinned: boolean }`)
- `BIFROST_COMMAND_OPTIONS`
- `requireCommand`, `reflectedIsInert`, `dashboardCommands`

`commands.ts` re-exports `BIFROST_COMMAND_OPTIONS` so the two existing test imports (`tests/docs-command-drift.test.ts`, `tests/landing-command-menu.test.mjs`) keep working unchanged.

**Why extract rather than just export from `commands.ts`:** `commands.ts:2` has a runtime import of `@earendil-works/pi-coding-agent`. A generator importing it loads the whole SDK — 453 ms measured — to read an array of 18 static objects. A pure module loads in single-digit milliseconds. It also satisfies the prior registry spec's non-goal ("No new exported surface") rather than overriding it, and lets `CommandSpec` be exported, so the generator's row type is nameable.

Note: `dashboardCommands` currently takes `Pick<BifrostState, ReflectedState>`, and `BifrostState` lives in `commands.ts`. The pure module cannot import it without a cycle, so the parameter becomes the structurally identical local `MenuState`.

### The generator calls the real menu builder

`scripts/command-surface.ts` calls `dashboardCommands(state)`. It does not re-derive the order. One implementation, two consumers.

`dashboardCommands` returns **registry objects by identity** for the 14 rows that carry no state note. `buildCommandSurface` must copy any row before annotating, or a consumer that mutates a row corrupts `BIFROST_COMMAND_OPTIONS`.

### State is an input

The reflected pair sorts actionable-first, so output differs by state:

```
node --experimental-strip-types scripts/command-surface.ts --enabled=false
node --experimental-strip-types scripts/command-surface.ts --pinned=true
```

Default is `enabled: true, pinned: false`. Invoke through `node` directly, **not** `npm run` — npm writes its `> pkg@ver script` banner to **stdout**, which corrupts `--json` output. `npm run command-surface` is fine for reading; `--json` is documented with the `node` form.

### Grouping, and what is editorial

The dashboard has **no grouping**. `pickBifrostCommand` passes 18 flat strings to `ctx.ui.select` (`commands.ts:1027`) — no headers, no separators. The map *invents* three groups, derived from the same registry fields the dashboard sorts by:

| Label | Condition |
|---|---|
| `State toggles` | `spec.reflects` present |
| `Common` | `spec.menu === "common"` |
| `Everything else` | neither |

This is label-only; the map preserves `dashboardCommands`' array order and cannot disagree with the menu about ordering. But it is editorial, and the header line must say so rather than claiming fidelity.

One known lossiness: the map collapses `on`/`off` and `pin`/`unpin` into a single `State toggles` table. The dashboard's own sort keeps them as two groups (`reflectedStates` is `["enabled","enabled","pinned","pinned"]`). Order is preserved; the pairing is not visible. Accepted.

### Output

Markdown by default. Rows come from `buildCommandSurface`, rendered by two functions over the same row array so they cannot disagree.

```
Bifrost command surface — routing on, unpinned
18 commands. Order matches the /bifrost dashboard. Grouping is editorial.

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

Four changes from revision 1:

1. **A `Note` column, and `description` stays bare.** Revision 1 claimed the state note was unrecoverable because `dashboardCommands` folds it into `description`. That is false: the spread at `commands.ts:1017` carries `reflects` through, so `spec.reflects.note` and `spec.reflects.sets === state[spec.reflects.state]` are both available per row. Emitting them means a consumer can tell a state note from genuine prose — `init`'s `(pass -f to force re-probe)` has `reflects === undefined`, `on`'s `(already on)` does not. `description` is emitted unmodified.
2. **The bare `/bifrost` entry point is stated in the header.** It is not a registry entry — `tests/docs-command-drift.test.ts` drops it deliberately as "the dashboard, not a subcommand" — so the generator states it explicitly. Without this the map cannot answer "how do I reach each one."
3. **No alias column.** Per the registry spec, aliases are **completion-only** and are not on `CommandEntry`. A column headed "Also accepted as" would assert a dispatchability the contract does not guarantee. Dropped rather than mislabelled.
4. **Markdown cells are escaped.** `|` becomes `\|`. Zero current descriptions contain a pipe, so the table renders correctly today **by luck**; this makes it a rule.

`--json` emits:

```json
{
  "state": { "enabled": true, "pinned": false },
  "total": 18,
  "groups": [
    { "label": "State toggles", "rows": [
      { "command": "/bifrost on", "value": "on", "description": "Enable routing",
        "argument": null, "note": "already on", "inert": true, "aliases": ["init -f"] }
    ]}
  ]
}
```

`note` and `inert` are `null` when not applicable. `aliases` is carried in JSON (structured, no claim attached) but not rendered in the markdown table.

### Discoverability

One line is added to `docs/guide/commands.md` pointing at the script, because an uncommitted, undocumented artifact is unreachable by its stated audience. This moves that file out of revision 1's non-goals.

### Files

- Create: `command-registry.ts` — pure registry + menu builder
- Create: `scripts/command-surface.ts` — thin CLI
- Create: `tests/command-surface.test.ts`
- Modify: `commands.ts` — remove the moved code, re-export `BIFROST_COMMAND_OPTIONS`, use `MenuState`
- Modify: `docs/guide/commands.md` — one discoverability line
- Modify: `package.json` — `"command-surface": "node --experimental-strip-types scripts/command-surface.ts"`

`buildCommandSurface` lives in `command-registry.ts`, **not** in `scripts/`. `tsconfig.json` includes `["*.ts", "tests/**/*.ts"]`, so `scripts/` is outside the program: I planted a type error there and `npm run typecheck` reported zero errors. Root-level `command-registry.ts` is covered.

## Testing

- every registry `value` appears exactly once
- row order equals `dashboardCommands(state)` for **all four** state combinations
- **labels match tiers** — a test that each row's group label equals the label implied by its `reflects`/`menu` fields. Without this, widening `menu` and rewriting the dashboard's tier logic could silently desynchronise labels while the order test stayed green.
- a probe entry inserted into `BIFROST_COMMAND_OPTIONS` appears in the output, restored in a `finally` — the registry is module-level shared state
- `description` is emitted unmodified; `note`/`inert` derive from `reflects`; a row with a genuine parenthetical (`init`) has `note === null`
- the header's command count equals `BIFROST_COMMAND_OPTIONS.length`
- markdown output escapes a `|` in a description
- **one `execFileSync` smoke test** runs the CLI end to end, parses its `--json`, and asserts exit code. This covers argv parsing and both renderers — none of which the pure-function tests touch. Precedent: `tests/release-package.test.mjs` already uses `execFileSync`.

## Non-goals

- No committed artifact, and therefore no new drift test for one.
- No matcher, side-effect, or test-coverage columns. Those need data the registry does not hold.
- No change to the dashboard's contents, order, or rendering.
- No change to `docs/guide/commands.md`'s command rows or ordering.

## Known constraints

- The map inherits the menu's ordering. `benchmark` and `providers` sit in the tail because they carry no `menu: "common"` — faithful to the menu, not an editorial choice.
- Registry order is also pinned by `tests/landing-command-menu.test.mjs` for `docs/terminal-demo.js`. Adding a 19th command correctly fails that test; this change does not alter the coupling, it inherits it.
- The map is only as current as the commit it is run from.
- `scripts/` remains outside the tsconfig program. The `execFileSync` test is what keeps the CLI honest; the pure logic is typechecked only because it lives at the repo root.

## Verification

```bash
npm test
npm run typecheck
node --experimental-strip-types scripts/command-surface.ts | head -30
node --experimental-strip-types scripts/command-surface.ts --json | head -40
```

## What changed from revision 1

- **Corrected a false claim.** Revision 1 said the state note is unrecoverable because it was folded into `description`. `reflects` survives on every returned row, so it is recoverable — and revision 1 specified `--json` wrong for exactly that reason.
- **Corrected a false verification command.** Revision 1 documented `npm run command-surface -- --json`, whose output includes npm's stdout banner and does not parse.
- **Corrected an unstated typecheck gap.** `scripts/` is outside the tsconfig program; `buildCommandSurface` moved to root.
- **Extract a pure module** rather than exporting from `commands.ts`, dropping a 453 ms SDK load and satisfying the prior non-goal instead of overriding it.
- **Copy rows before annotating**, because `dashboardCommands` returns registry objects by identity for 14 of 18.
- **Added the bare `/bifrost` entry point**, without which the map cannot answer its own question.
- **Added discoverability**, without which the artifact is unreachable by its stated audience.
- **Dropped the alias column**, added markdown escaping, added the labels-match-tiers test and the `execFileSync` smoke test, and stopped claiming the dashboard has grouping.