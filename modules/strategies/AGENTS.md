# Strategies module instructions

Read the repository [AGENTS.md](../../AGENTS.md) and the local
[README.md](README.md) first. They define the capability contract, and the
repository rules still apply in full.

Local boundaries:

- Keep selection pure: no I/O, network, filesystem, clock, process, host runtime,
  dispatch, credentials, persistence or configuration loading.
- Select only from the supplied ordered pool. Never add eligibility, fallback,
  tier, reliability, affinity or billing authority here.
- Preserve observable behavior, including tie-breaking, singleton handling,
  injectable randomness, unknown-name fallback and the documented numeric edge
  characterization.
- Keep the canonical strategy list single-sourced. A new name updates the union,
  the list and the schema drift guard together.
- Do not import from `tests/`, `scripts/`, or host adapters, and do not add a
  barrel, package manifest or plugin registry.

Verify with:

```
node --test --experimental-strip-types modules/strategies/tests/selection.test.ts
node --test --experimental-strip-types modules/strategies/tests/selection-properties.test.ts
npm run typecheck
```
