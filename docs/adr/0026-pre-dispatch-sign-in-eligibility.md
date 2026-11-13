# 0026 — Pre-dispatch sign-in eligibility for Auto routing

## Status

**Proposed, not implemented.** This ADR records the design for finding P0-2 of #208 and the two shapes it could take. Nothing here changes routing yet: [AGENTS.md](../../AGENTS.md) requires an observable signal, an advisory surface, and an explicit opt-in before a new signal silently changes a route, and a proposed ADR is not implementation approval. The product owner picks a shape below before code lands.

## Context

A live `v2` run put the `review` and `orchestrator` tiers on `openai-codex` models whose stored OAuth credential was dead. The provider fail was reported only when the request reached the provider:

```
[bifrost] Bifrost auto: review → openai-codex/gpt-6.1-terra (inline)
[bifrost] Bifrost: recorded provider failure for openai-codex/gpt-6.1-terra; future prompts may route around it.
OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {"code":"refresh_token_reused"}
```

The turn ended with no fallback. Two properties combine to produce that:

- Pi's `getProviderAuthStatus` reports that a credential is **stored**, and `getAvailable()` keeps serving a provider's catalog entries until something actually resolves the credential. Selection therefore cannot see that the provider will reject.
- The failure is observed at settlement, not at selection: `agent_settled` records it in the reliability store, so it influences the *next* prompt rather than the current one. The next turn that matches the `review` rule re-enters the same tier.

[PR #209](../..) made the dead credential visible in `inspect`/`check` and warned before the write. It deliberately did not change dispatch, because a swap at selection time is a routing/reliability behavior change and needs this decision.

This is not a [replay](../adr/0023-bounded-allowance-recovery.md) request. Nothing has been sent when selection happens, so choosing another candidate would not repeat completed work; the boundary this ADR must respect is the *tier* boundary, not the turn boundary.

## What the code does today

- `Auto` (`bifrost/auto`) enters `route()` and resolves a tier through `resolveForTier` (`index.ts:2526`), which calls `resolveConfiguredTier` (`routing.ts:409`).
- Candidate filtering today comes from `routingScope`, schema-v2 `tierPolicies`, economic reserves, and reliability projections (circuits, provider pauses). A tier with an explicit `fallbackTiers` list resolves only inside that list; an empty list is a terminal boundary.
- `resolveModelWithFallback` (`routing.ts:598`) and `resolveWithExplicitTierBoundary` (`routing.ts:709`) both pick from the already-filtered candidate set. Neither accepts an eligibility predicate.
- The only signal that surfaces a dead refresh token is `modelRegistry.getProviderAuth`, the same call the configuration tool uses (`config-agent.ts`). `getProviderAuthStatus` is the cheap "nothing stored" fast path.

## Decision (proposed)

Resolve the selected provider's sign-in **before admission**, and let a configuration opt in to excluding a provider whose credential cannot be resolved.

Two shapes, one decision:

### Shape A — pre-dispatch exclusion, opt-in

Add an explicit configuration, default `observe`:

```json
{ "routing": { "signInEligibility": "observe" } }
```

- `observe`: once per Auto request, resolve the selected model's provider sign-in and put the result in the route explanation (`ready`, `not_configured`, `invalid`, `unknown`) without changing the selection. This is the advisory step.
- `exclude`: a provider whose resolution is `invalid` or `not_configured` is excluded before admission. Selection repeats once within the same tier; it never crosses an explicit `fallbackTiers` boundary, and an empty boundary stays terminal.
- `unknown` never excludes. An unresolved check is not proof that the credential is dead, and treating it as proof would route away from healthy providers on a transient failure.

The swap is visible: the route explanation names the excluded model, the provider, the observed state, and the reason string. It is not recorded as a circuit, because it is not a provider failure — the request never left the host.

### Shape B — leave dispatch terminal

Keep dispatch as it is and rely on the configuration signal: a dead credential is loudly reported by `inspect` and warned about by `check`, and the skill refuses to build such a tier silently. The trade-off is that a config written before the credential died, or one the user applies against advice, still ends the turn.

## Constraints for either shape

- **No resolution without a reason.** `getProviderAuth` may refresh an expired OAuth token, which is a network call. A per-request resolution on every Auto turn is a latency and side-effect cost that must be measured, not assumed. A short-lived per-session cache (with invalidation on provider failure) is the starting point; the measurement belongs in the implementation PR.
- **Same-tier only.** The swap may not borrow the allowance recovery path's cross-tier behavior. An explicit tier prefix keeps its tier, and an exhausted schema-v2 boundary stays exhausted.
- **No state invention.** The exclusion must not write a fabricated circuit or pause, so `/bifrost inspect` and the reliability store never claim a provider failure that did not happen.
- **No replay.** The rule holds that failed user work is never automatically rerun. Shape A acts strictly before dispatch; any failure after dispatch keeps today's behavior.
- **Physical selection stays physical.** A pinned model is never swapped.
- **Default off.** `observe` is the default; `exclude` is explicit configuration.

## Consequences

Shape A removes the reported failure mode when a credential dies while its provider is still in a configured tier, and it keeps the dead provider visible instead of silently rewriting the user's configuration. It adds one auth resolution to the Auto path, needs a cache to stay cheap, and introduces a new eligibility reason that must stay explainable in preview, status, and the route trace.

Shape B costs nothing and leaves the failure in place for configs that predate the credential dying.

## Verification plan (Shape A)

- A fake registry whose `getProviderAuthStatus` says configured and whose `getProviderAuth` throws selects the next candidate in the same tier, and the route explanation names `sign_in_unavailable` with the provider and state.
- A tier with `fallbackTiers: []` and one dead provider fails closed instead of borrowing another tier.
- An explicit tier prefix never leaves its tier.
- `unknown` resolution dispatches the originally selected model.
- Mutation checks: removing the exclusion predicate, the same-tier guard, and the `unknown` guard each turn their named assertion RED.

## Open questions for the product owner

1. Shape A or shape B?
2. If A: is `routing.signInEligibility` the right config surface, or does this belong under `reliability` (where pauses and allowances live) even though it is eligibility rather than failure?
3. Is one same-tier hop the right bound, or should the swap require the tier to list an explicit `fallbackTiers` alternate before it may move at all?
