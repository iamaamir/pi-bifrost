# Centralized Command Registry

Status: draft for review
Date: 2026-10-04
Branch: `refactor/command-registry` (stacked on `chore/no-agent-attribution`, PR #20)

## Problem

Bifrost advertises and dispatches its commands from three separate lists that
share no common structure:

| List | Location | Count | Drives |
|---|---|---|---|
| `BIFROST_COMMAND_OPTIONS` | `commands.ts:801` | 19 | slash completion, unknown-subcommand picker |
| `routes` | `commands.ts:977` | 18 (15 via helpers + 3 hand-written) | dispatch |
| `dashboardCommands` | `commands.ts:842` | 8 hardcoded strings | the `/bifrost` menu |

The lists have already drifted apart:

1. **`classifier` has two different descriptions.** The options list says
   `"Choose classifier backend"`. The route at `commands.ts:1164` says
   `"Choose classifier backend and prompt model"`.

2. **`init -f` is a phantom entry.** It appears in the options list but has no
   route of its own, which is why the options list has 19 entries and dispatch
   has 18. `init`'s matcher is
   `sub === "init" || sub.startsWith("init ")`, so `init -f` shares the `init`
   handler. Typing `/bifrost init -f` works, but *selecting* `init -f` from a
   picker resolves `routes.find(e => e.value === "init -f")` to `undefined` and
   `commands.ts:1294` returns silently.

3. **The `/bifrost` menu shows 8 rows covering 8 of 19 registry values.** Eleven
   values never appear: `init -f`, `benchmark`, `cache stats`, `cache clear`,
   `classifier`, `classifier on`, `classifier off`, `classifier test`, `debug`,
   plus one of `on`/`off` and one of `pin`/`unpin`, since the menu shows only
   the actionable member of each pair. This was reported directly: the menu
   looks outdated relative to what Bifrost actually offers.

4. **Handlers bypass the `exact()`/`prefix()` helpers.** `init`, `classifier`,
   and `classifier test` are hand-written object literals. That bypass is how
   the description drift and the phantom entry got in.

## Goal

One list of pure command data. Adding a command means adding one entry;
completions, the menu, and dispatch all follow automatically.

After this change the registry holds 18 entries plus one alias (`init -f`),
replacing today's 19 options and 18 routes.

## Approach

A module-level array of pure specs, plus a handler map keyed by the same values.
Handlers stay inside `createCommandRouter` because they close over `BifrostState`,
which the static array cannot hold.

The two structures are tied together by a parity test rather than by type
construction. This keeps handler code untouched and confines the diff to
`commands.ts` and tests, which matters while other agents work in this repo.

Rejected alternatives:

- **Single array holding handlers** (`(args, ctx, state)` signatures). Drift
  becomes structurally impossible rather than test-caught, but it rewrites ~15
  handler signatures in the file other agents' branches diverge from.
- **`buildCommands(state)` returning specs and handlers together.** Handlers
  would close over state naturally, but `getBifrostCommandCompletions` is
  module-level and state-free, so completions would need a router instance just
  to build their list. That re-splits the two things this change joins.

## Design

### Registry

```ts
export type CommandSpec = {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
  readonly match: "exact" | "prefix";
  readonly menu: "primary" | "advanced";
  readonly reflects?: "enabled" | "pinned";
};
```

`BIFROST_COMMAND_OPTIONS` is renamed to `COMMANDS`. The `exact()` and `prefix()`
helper functions are removed; the declarative `match` field replaces them, which
is what makes a hand-written route entry impossible to express by accident.

Array order preserves today's dispatch precedence.

`BIFROST_COMMAND_OPTIONS` is referenced only inside `commands.ts`. `index.ts`
exports only `bifrostExtension`, and `package.json` declares no `exports` or
`main`, so the rename breaks no external consumer.

### Entries

`primary` is exactly the set today's menu shows, plus the other half of each
state pair. This preserves the rows users already expect at the top rather than
demoting them.

| Rank | Commands |
|---|---|
| `primary` | `on` `off` `pin` `unpin` `preview` `providers` `probe` `init` `classifier status` `reload` |
| `advanced` | `classifier` `classifier on` `classifier off` `classifier test` `benchmark` `cache stats` `cache clear` `debug` |

Every command appears in the menu. `menu` controls ordering only; it hides
nothing, so a new command cannot be forgotten.

### `init -f`

Folds into `init` as `aliases: ["init -f"]`. `init` uses `match: "prefix"`, so
`init -f` still resolves to the same handler and typing it keeps working.

The separate `init -f` entry had its own description, `"Force Probe models and
generate config"`. An alias carries no description, so `init`'s description
becomes:

> Probe models and generate config (pass -f to force re-probe)

Discoverability is preserved without a phantom entry. `init -f` continues to
appear in slash completion via the alias.

### Handlers

```ts
export function buildCommandHandlers(state: BifrostState): Record<string, CommandFn>
```

Dispatch walks `COMMANDS`, matches each spec using its declarative strategy, and
calls `handlers[spec.value]`.

Lookup by `spec.value` rather than by an array scan means a spec value with no
handler is impossible to express quietly. The failure mode behind issue 2 above
disappears by construction rather than being patched.

### Menu

`dashboardCommands` is deleted.

The menu is `COMMANDS` sorted by rank, stable within rank. All 18 render.

State annotation applies only to the *actionable* row of a pair. For a spec with
`reflects`, it is annotated when `(spec.value === "on") !== state.enabled`:

```
/bifrost off — Disable routing (routing is currently on)
/bifrost on  — Enable routing
```

One informative line rather than two identical ones. `reflects` is declared on
the entry, so the annotation rule stays registry-driven.

## Testing

New `tests/command-registry.test.ts`:

- every `COMMANDS` value is a key in `buildCommandHandlers(stubState)`
- every key in `buildCommandHandlers(stubState)` is a `COMMANDS` value
- every `value` is globally unique
- every `alias` is globally unique and does not collide with any `value`
- every `alias` is reachable under its parent's `match` strategy
- `description` is non-empty on every entry
- `menu` and `match` are valid discriminants
- menu ordering lists all `primary` before all `advanced`
- state annotation appears on the actionable row only

Calling `buildCommandHandlers` with a stub state is what lets the test enumerate
handler keys without booting a router.

Existing coverage that must keep passing:

- `tests/bifrost-commands.test.ts` exercises the router, `classifier status`,
  `debug`, and completions.
- `tests/integration/integration.test.mjs` drives real `pi` sessions.
- `scripts/ui-smoke.py` types `/bifrost` commands through a PTY.

## Non-goals

- **Docs stay hand-written.** `README.md:163`, `docs/llms.txt:50-58`,
  `docs/guide/classifiers.md`, and `docs/guide/troubleshooting.md` enumerate
  commands independently of the registry and **will drift again** on the next
  added command. Accepted for this change; generating them is separate work that
  should not touch files other agents are editing.
- No `DecisionTrace`, no stage timings, no structured candidate records.
  ADR 0007 stays proposed.
- No behavior change to any command beyond menu contents and the `init`
  description text.
- No change to command completion semantics.

## Risks

- **Menu ordering** is a judgment call. The `primary` set is defensible but not
  objectively correct, and `probe` and `classifier status` would arguably sit
  better under `advanced`. Each entry's rank is a one-word change.
- **`AGENTS.md` asks for the smallest correct change.** This is a refactor with
  no user-visible feature beyond fixing the menu. It is justified because three
  of the four drift items are user-visible today.
- **Merge interaction with #19.** PR #19 rewrites `handlePreview` in the same
  file. The registry changes start near `commands.ts:782`, roughly 430 lines
  after the preview report code, so Git should merge them without conflict. This
  is expected, not verified.

## Verification

```bash
npm test
npm run typecheck
npm run test:integration
npm run test:ui
```