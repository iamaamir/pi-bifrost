# Rules module instructions

Read the repository [AGENTS.md](../../AGENTS.md) and the local [README.md](README.md) first.
They define the capability contract, and the repository rules still apply in full.

Local boundaries:

- Never weaken fail-closed rejection. A probe that cannot complete rejects the unverified
  remainder of its batch; a malformed, short or timed-out stream is never treated as safe.
- Never resolve the verifier through `PATH` on a Node host, never remove the `NODE_OPTIONS`
  clear, and never spawn on the match path.
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
