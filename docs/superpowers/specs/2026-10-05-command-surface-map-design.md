# Command Surface Map

Status: draft for review (revision 4)
Date: 2026-10-05
Branch: `feat/feature-map` (off `main` = `v0.5.0`, `236622d`)

> Revision 4 corrects a sample output that contradicted the spec's own design and
> test, and moves all logic into `scripts/` following the existing
> `scripts/jev-benchmark.ts` pattern. Review round 3 confirmed the architecture is
> sound and all four revision-2 blockers fixed; what remained were accuracy
> defects. Corrections are listed in [What changed](#what-changed-from-revision-3).

## Purpose

Answer one question, for a human or an agent with zero context: **what commands exist, and how do I reach each one?**

`/bifrost` already derives all 18 picker rows from `BIFROST_COMMAND_OPTIONS`. That ordering, grouping, and the per-command state notes exist only inside a TUI picker at runtime. This change makes that surface readable outside it.

## What this is not

- **Not a coverage matrix.** All 18 commands are already dispatch-tested somewhere. `classifier test`'s only dispatch is `tests/integration/integration.test.mjs:161`, outside `npm test`'s glob. No command is undiscovered, so a coverage map would track a gap that does not exist.
- **Not a routing-surface map.** Overlaps ADR 0007 and ADR 0011, both Proposed.
- **Not committed.** See below.

## Generated, never committed

Produced on demand, never written to the repo. A committed map would be a second ordering of the same 18 commands alongside `docs/guide/commands.md`, which is pedagogically ordered; two committed orderings are two drift surfaces. Precedent: `scripts/jev-benchmark.ts` prints to stdout and never writes a file.

## Design

### One export, no extraction

`commands.ts` exports `dashboardCommands`. Nothing else moves.

Revision 2 proposed extracting the registry into a pure module to avoid the Pi SDK load. It shipped a load-time `ReferenceError`: `PREVIEW_SUB` (`commands.ts:715`) is referenced *inside* `BIFROST_COMMAND_OPTIONS` at `:916`, so moving the registry without it creates a cycle, and the module-level array literal then reads `PREVIEW_SUB` while `commands.ts` is still in its temporal dead zone. Dropped. The SDK load costs a few hundred milliseconds for a script a human runs by hand.

The import graph is acyclic: `commands.ts` imports 15 local modules, none of which import it back.

### Everything lives in `scripts/command-surface.ts`

Following `scripts/jev-benchmark.ts`: the module exports `main(argv = process.argv.slice(2))` and self-invokes under a guard (`import.meta.url === \`file://${process.argv[1]}\``), and `tests/jev-benchmark.test.ts` imports its helpers directly.

This placement is deliberate on three counts:

- **Not published.** `package.json:6` is `files: ["*.ts", …]`, which matches the repo root only. Logic under `scripts/` stays out of the npm tarball. A root-level module would ship as a public entry point nothing imports, and `tests/release-package.test.mjs` asserts every root `*.ts` is packed.
- **Typechecked.** `tsconfig.json:17` is `include: ["*.ts", "tests/**/*.ts"]`, so `scripts/` is outside the program directly — but importing it from `tests/command-surface.test.ts` brings it into the program transitively. A planted type error in an imported script is reported.
- **Deterministic argv coverage.** `main(argv)` takes arguments as a parameter, so both renderers and both state flags are unit-testable without spawning a process.

`package.json:44` globs `tests/*.test.ts`, which is what makes the new test run.

### Signatures

`CommandSpec` is not exported (`commands.ts:865`), so the row type is derived:

```ts
type CommandRow = typeof BIFROST_COMMAND_OPTIONS[number];
type MenuState = Parameters<typeof dashboardCommands>[0];   // { enabled: boolean; pinned: boolean }

export function buildCommandSurface(state: MenuState): CommandRow[];
export function renderMarkdown(rows: CommandRow[], state: MenuState): string;
export function renderJson(rows: CommandRow[], state: MenuState): string;
export async function main(argv?: string[]): Promise<void>;
```

### Row construction

`buildCommandSurface` uses `dashboardCommands` **for order only**, and reads every field from the registry:

```ts
const ordered = dashboardCommands(state);
return ordered.map((row) => {
  const spec = BIFROST_COMMAND_OPTIONS.find((s) => s.value === row.value)!;
  const inert = spec.reflects ? spec.reflects.sets === state[spec.reflects.state] : false;
  return {
    ...spec,
    inert,
    note: inert ? spec.reflects!.note : null,
  };
});
```

`dashboardCommands` already folds the note into `description` for inert rows (`commands.ts:1017`), so taking `description` from its return value double-reports it. Stripping the parenthetical instead corrupts `init`, whose `(pass -f to force re-probe)` is genuine prose. Reading from the registry avoids both, and `reflects` is the authority for whether a note applies.

The non-null assertion is safe: `dashboardCommands` builds rows from `BIFROST_COMMAND_OPTIONS.map(…)` and resolves each through `requireCommand`, which throws on a miss, so every returned `value` is in the registry. `spec.reflects!` is required and sound — the `inert` ternary does not narrow through the alias.

The re-`find` is O(n²) over 18 rows. It is deliberate: only `description` genuinely requires the second read, and `dashboardCommands`'s return value is the one place it is already polluted.

### State is an input

The reflected pairs sort actionable-first, so output differs by state. Default `enabled: true, pinned: false`.

Reflected order by state, measured against the real `dashboardCommands`:

| `enabled` | `pinned` | first four rows |
|---|---|---|
| true | false | `off, on, pin, unpin` |
| true | true | `off, on, unpin, pin` |
| false | false | `on, off, pin, unpin` |
| false | true | `on, off, unpin, pin` |

Invoke via `node`, not `npm run` — npm writes its `> pkg@ver script` banner to **stdout**, which corrupts `--json`. `npm run --silent command-surface -- --json` also works.

### Grouping, and what is editorial

The dashboard has **no grouping**: `pickBifrostCommand` passes flat strings to `ctx.ui.select` (`commands.ts:1027`). The map *invents* three groups from the same fields the dashboard sorts by, matching `tierOf` (`commands.ts:995`) read top-down as ordered precedence:

| Label | Condition |
|---|---|
| `State toggles` | `spec.reflects` present |
| `Common` | `spec.menu === "common"` |
| `Everything else` | neither |

`tierOf` is a local inside `dashboardCommands`, not module-scope, so nothing cross-checks against it.

One lossiness, accepted: the map collapses `on`/`off` and `pin`/`unpin` into one `State toggles` table. The dashboard's sort keeps them as two groups (`reflectedStates` is `["enabled","enabled","pinned","pinned"]`). Order is preserved; the pairing is not visible.

### Output

Markdown by default, both renderers over one row array so they cannot disagree. The command count is **interpolated from `BIFROST_COMMAND_OPTIONS.length`**, never a literal.

The sample below is captured output from `node --experimental-strip-types scripts/command-surface.ts` at the default state, pasted verbatim. Note the header reads `routing on`, not `routing on, unpinned`: `statePhrase` returns one of `on` / `pinned` / `off`, so the unpinned-but-enabled state is simply `on`.

```
Bifrost command surface — routing on
18 commands. Order matches the /bifrost dashboard; grouping is editorial.

Open the surface by typing /bifrost and pressing enter.

## State toggles

| Command | Description | Note |
|---|---|---|
| `/bifrost off` | Disable routing |  |
| `/bifrost on` | Enable routing | already on |
| `/bifrost pin` | Lock current model |  |
| `/bifrost unpin` | Resume routing | already unpinned |

## Common

| Command | Description | Note |
|---|---|---|
| `/bifrost preview [--json] <prompt>` | Preview routing for a prompt |  |
| `/bifrost benchmark <prompt>` | Classify a benchmark prompt |  |
| `/bifrost providers` | List available providers |  |
| `/bifrost probe` | Probe working models |  |
| `/bifrost init` | Probe models and generate config (pass -f to force re-probe) |  |
| `/bifrost classifier status` | Show classifier state |  |
| `/bifrost reload` | Reload config after editing |  |

## Everything else

| Command | Description | Note |
|---|---|---|
| `/bifrost cache stats` | Show classification cache |  |
| `/bifrost cache clear` | Clear classification cache |  |
| `/bifrost classifier` | Choose classifier backend |  |
| `/bifrost classifier on` | Enable LLM classifier |  |
| `/bifrost classifier off` | Disable LLM classifier |  |
| `/bifrost classifier test` | Test selected classifier backend |  |
| `/bifrost debug` | Show config and routing state |  |
```

Three columns. There is no separate Argument column: the command cell already carries the argument hint, exactly as `formatBifrostCommandChoice` renders the menu row, so a second column would duplicate it.

**Escaping.** `|` becomes `\|`, and `<`/`>` are wrapped in backticks. The second rule is not cosmetic: `argumentHint` values are `[--json] <prompt>` and `<prompt>`, and in GitHub-flavored markdown a bare `<prompt>` is parsed as a raw HTML tag and renders as nothing — the argument hints would silently vanish wherever the map is pasted.

**The bare `/bifrost` entry point** is stated in the header. It is not a registry entry — `tests/docs-command-drift.test.ts:34-35` drops it deliberately as "the dashboard, not a subcommand."

**No alias column.** Aliases are not on `CommandEntry`, so the registry cannot prove per-alias dispatchability in general. (For the one live alias the registry *does* imply it — `spaced("init", …)` at `commands.ts:903` matches `init -f` — but that is a property of the matcher, not something the alias field asserts.) Aliases are carried in the JSON output, where no claim is attached.

`--json` emits `{ state, total, groups: [{ label, rows }] }` with `null` where inapplicable. `total` is `BIFROST_COMMAND_OPTIONS.length`.

### Discoverability

One prose line in `docs/guide/commands.md` pointing at the script.

**Placement constraint.** The drift test anchors on `| Command |` and the next `| Control` header, which is at line 115 — so it slices roughly 110 lines past the command table. A prose line is safe anywhere in that span *only because* the parse skips rows not starting with `` | `/bifrost ``. A line written as a table row beginning `` | `/bifrost` `` would break it. The line must be prose, not a row.

### Files

- Create: `scripts/command-surface.ts` — row builder, renderers, `main`
- Create: `tests/command-surface.test.ts`
- Modify: `commands.ts` — export `dashboardCommands`
- Modify: `docs/guide/commands.md` — one prose line
- Modify: `package.json` — `"command-surface": "node --experimental-strip-types scripts/command-surface.ts"`

## Testing

Registry and state are the reference for every assertion; none compares the builder to itself.

- **Markdown content.** Parse the command out of each rendered row and assert the sequence equals `dashboardCommands(state).map(r => r.value)` for all four states. This crosses builder → grouping → renderer, the only place a permutation or dropped row can hide, and it cannot be satisfied by re-deriving the same expression. Revision 3 had no test on the default output at all.
- **`description` equals the registry entry's**, asserted against `BIFROST_COMMAND_OPTIONS` — the only reading that catches the double-report this design exists to avoid.
- **Membership is a multiset check**: sorted row values deep-equal sorted registry values. A `some()`-per-value loop tolerates duplicates and extras.
- **`note`/`inert` are non-null exactly when the registry's `reflects.sets` equals the state's value** — computed from registry and state, not from the builder's internals.
- `init` has `note === null` despite its parenthetical.
- Markdown escapes `|` and wraps `<…>` in backticks.
- Header count equals `BIFROST_COMMAND_OPTIONS.length`.
- **argv:** `main(["--json", "--enabled=false", "--pinned=true"])` emits `state` deep-equal to `{ enabled: false, pinned: true }`, `total === 18`, and reflected order `["on", "off", "unpin", "pin"]`. Asserts both pairs, not one. `main(["--json"])` yields the default tuple `["off", "on", "pin", "unpin"]`.
- **Both renderers** are invoked directly, so neither is unexercised.
- Unknown flags are rejected with a usage line and a non-zero exit, rather than silently ignored.
- A probe entry in `BIFROST_COMMAND_OPTIONS` appears in the output, restored in a `finally` — the registry is module-level shared state and the array is `readonly`, so the test needs a cast. Insert two probes, one `menu: "common"` and one bare, so group *placement* is pinned, not just membership.

## Non-goals

- No committed artifact, and no new drift test for one.
- No matcher, side-effect, or test-coverage columns.
- No change to the dashboard's contents, order, or rendering.
- No change to `docs/guide/commands.md`'s command rows or ordering.

## Known constraints

- The map inherits the menu's ordering. `benchmark` and `providers` sit in the tail because they carry no `menu: "common"`.
- Registry order is also pinned by `tests/landing-command-menu.test.mjs` for `docs/terminal-demo.js`. Adding a 19th command correctly fails that test; this change inherits the coupling.
- The map is only as current as the commit it is run from.
- The header's `/bifrost` is the one output string with no drift guard.
- `commands.ts` renders a mode phrase for the dashboard title (`off` / `pinned` / `on`) and exports it as `bifrostModePhrase`. The generator's header phrase is that same function, so there is one definition rather than a second convention to keep aligned.

## Verification

```bash
npm test
npm run typecheck
node --experimental-strip-types scripts/command-surface.ts | head -30
node --experimental-strip-types scripts/command-surface.ts --json | head -40
```

## What changed from revision 3

- **Replaced the hand-written sample with generated output.** It was wrong three ways: it truncated `init`'s description to `Probe models and generate config`, omitting `(pass -f to force re-probe)` — the exact corruption the spec refuses elsewhere — it showed only two of four state toggles while the header claimed 18 commands, and it led the last group with `cache clear` when the real first row is `cache stats`.
- **Dropped the Argument column**, which duplicated the hint already present in the command cell.
- **Escape `<` and `>` as well as `|`.** `<prompt>` renders as nothing in GitHub-flavored markdown, so the argument hints would vanish wherever the map is pasted.
- **Moved all logic into `scripts/command-surface.ts` with `export main(argv)`,** following `scripts/jev-benchmark.ts`. No root module, so nothing dead is published into the tarball; the test import brings it into the typecheck program; and argv is testable without spawning a process.
- **Added a markdown-content test** — the default output had no content assertion at all, so a renderer that dropped a group or a column would pass.
- **Changed membership to a multiset check; specified the builder's signature; made the count derivation explicit; corrected the alias rationale** (`spaced()` does make `init -f` dispatchable); corrected `tierOf` to function-private; cited `package.json:44` and `package.json:6`; replaced the `execFileSync` smoke test with direct `main()` tests covering both renderers and both state flags, and dropped the false "covers both renderers" claim; and stated the prose-line placement constraint.