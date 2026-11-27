# Command catalog module instructions

Read [AGENTS.md](../../AGENTS.md) and [README.md](README.md).

- Keep this capability pure and host-neutral. No host runtime or type imports,
  UI, filesystem, network, session mutation or handler execution.
- Keep one catalog and preserve command names, descriptions, hints, aliases,
  order, normalization and state annotations unless a behavior change is authorized.
- The Pi adapter owns executable bindings and effects. Validate correspondence
  against its actual routes, not a parallel list. Preserve grouped parent routes.
- Do not introduce a barrel, generic CLI framework or plugin registry.
- Keep direct contract tests here and preserve system-owned host and package tests.

Verify with:

```sh
node --test --experimental-strip-types modules/commands/tests/catalog.test.ts
```
