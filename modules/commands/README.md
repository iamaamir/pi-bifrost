# Bifrost command catalog

The catalog describes the commands exposed under `/bifrost` and the dashboard
that displays them. It gives host adapters and offline developer tools one
authoritative source of command names, descriptions, hints, completion aliases,
state annotations and ordering. It does not execute commands.

## Example

For `{ enabled: false, pinned: true }`, `commandSurface(state)` starts with
`on`, `off`, `unpin`, `pin`. The `off` and `pin` rows carry the inert
notes `already off` and `already pinned`. The descriptions remain unchanged.
`bifrostModePhrase(state)` returns `off`: disabling routing takes precedence
over pinning for this dashboard label. A caller formats the rows and decides
how to present or execute a command.

## Ownership and consumers

- [catalog.ts](catalog.ts) owns the canonical command specs, completion,
  match predicates, surface ordering and state interpretation, and validation
  of catalog/handler correspondence.
- [commands.ts](../../commands.ts) owns the ordered executable handler bindings,
  raw argument text, dispatch, picker interaction, editor prefill and effects.
  The adapter validates its actual route list once when constructing a router.
- The documentation and landing-page drift tests remain system-owned. They
  import the catalog directly, so mutation binding includes those data-only
  checks without loading the Pi adapter. Existing host command tests retain
  their adapter imports and compatibility coverage. A future offline surface-map
  tool can also consume the catalog; its formatting, flags and serialization
  remain outside this module.

## Contract

The module has no imports, I/O, host context, execution, state mutation or
initialization requirements. Callers supply two booleans for the surface; rows
reference the original specs and carry a separate group, inert flag and note.
Reflected groups follow the first declaration of each state; actionable members
precede inert members; common and other commands preserve declaration order.
An optional catalog argument permits isolated evaluation of a supplied catalog.

Completion trims and lowercases input, includes completion-only aliases,
returns null for complete or unmatched input, and never attaches menu hints.
Matchers accept the adapter's normalized input: exact requires equality,
prefix accepts an immediate suffix (including no intervening space), and spaced
accepts equality or a literal space. Raw argument casing stays with the adapter.

Route validation rejects missing, overlapping and unadvertised top-level
routes, duplicate names, aliases routed to a different handler, and no-hint
dashboard commands lacking a direct handler. Grouped commands with argument
hints may match a parent route. This checks advertised names and aliases, not
every arbitrary suffix or the behavior inside a grouped handler; existing
dispatch and integration tests cover those contracts. A mismatch is a developer
configuration error, not a reason to silently execute another command.

The shared catalog is readonly by contract. Consumers must not mutate specs.
Existing exports from `commands.ts` remain available for compatibility.

## Design rationale

Keeping the catalog in the Pi command adapter forces offline consumers to
load unrelated host dependencies. Moving only data would leave duplicated
matching and ordering. This focused module keeps the existing imperative
handler bindings and validates their correspondence, without a second command
registry, generic parser, plugin framework or host-effect abstraction.

## Verification

Run the direct module tests:

```sh
node --test --experimental-strip-types modules/commands/tests/catalog.test.ts
```

The full and quick unit tiers discover this file through the existing module
test globs. Existing host command, documentation, landing-page, integration
and UI checks retain their ownership.

The optional capability-owned [mutation descriptor](mutation.json) enrolls the
catalog with the existing shared runner. It uses Node/TAP because the initial
Bun campaign reported interior coverage-attribution gaps for all three direct
consumers. TAP measures at file granularity and binds the module's contract
tests plus the documentation and landing-page drift tests.

```sh
node mutation/run.mjs modules/commands/catalog.ts --dry-run
node mutation/run.mjs modules/commands/catalog.ts
node mutation/workflow.mjs plan
```

Use [the shared measurement contract](../../mutation/README.md) when updating
the descriptor. Count and throughput are measured planning inputs, not score
thresholds. Keep equivalent survivors visible; do not weaken contracts to
improve the score.

## Safe extension

Add or change metadata here and bind the executable handler in the adapter.
Keep the current matching and prefill semantics, update command documentation
and relevant tests, and verify the actual route list. Do not introduce new
commands or alter user-visible behavior as an incidental refactor.
