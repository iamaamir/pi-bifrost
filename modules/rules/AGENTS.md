# Rules module instructions

Read the repository [AGENTS.md](../../AGENTS.md) and the local [README.md](README.md) first.
They define the capability contract, and the repository rules still apply in full.

Local boundaries:

- Never weaken fail-closed rejection. A malformed or short stream rejects the un-decoded
  remainder of its batch. A timeout rejects only the first still-pending pattern and continues;
  no incomplete verdict is ever treated as safe.
- `classifyCompiled` is the spawn-free match path. The deprecated `classify` verifies per call
  and can spawn for a pattern without a cached verdict; describe it that way in docs.
- Never resolve the verifier through `PATH` on a Node host: use `process.execPath`. On Bun/Deno
  keep the `node` lookup, the hosting-runtime fallback when it is absent, and the
  `BIFROST_PROBE_NODE` override. Never remove the `NODE_OPTIONS` clear.
- Never persist verdicts. The cache is process memory only, and `safety.ts` stays internal.
- Keep rule discovery, route-file precedence, the default rule set, probing for live model
  selection, tier resolution and dispatch out of this module.
- Keep the reported behavior and diagnostic strings unchanged; `classify` stays the deprecated
  parity reference.
- Do not import from `tests/`, `scripts/`, or host adapters, and do not add a barrel, package
  manifest or registry.
- A security change needs a fault control that goes red, or a recorded limitation in the PR.

Verify with:

```
node --test --experimental-strip-types modules/rules/tests/rules.test.ts
node --test --experimental-strip-types modules/rules/tests/safety.test.ts
npm run typecheck
```
