# 0026 — Pre-dispatch sign-in eligibility for Auto routing

## Status

**Accepted and implemented as Shape A, default off.** Finding P0-2 of #208 is closed for the configured case only: `signInEligibility: "exclude"` resolves provider sign-in before selection and removes a provider whose credential cannot be resolved. Unconfigured users dispatch exactly as before. The advisory surface from PR #209 stays: `inspect` reports sign-in state and `check` warns before a write without spending a credit.

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

- `Auto` (`bifrost/auto`) enters `route()` and resolves a tier through `resolveForTier` (`index.ts:2667`), which calls `resolveConfiguredTier` (`routing.ts:428`).
- Candidate filtering today comes from `routingScope`, schema-v2 `tierPolicies`, economic reserves, and reliability projections (circuits, provider pauses). A tier with an explicit `fallbackTiers` list resolves only inside that list; an empty list is a terminal boundary.
- `resolveModelWithFallback` (`routing.ts:631`) and `resolveWithExplicitTierBoundary` (`routing.ts:745`) both pick from the already-filtered candidate set. Neither accepts an eligibility predicate.
- The only signal that surfaces a dead refresh token is `modelRegistry.getProviderAuth`, the same call the configuration tool uses (`config-agent.ts`). `getProviderAuthStatus` is the cheap "nothing stored" fast path.

## Decision

Resolve provider sign-in **before admission**, and let a configuration opt in to excluding a provider whose credential cannot be resolved.

```json
{ "schemaVersion": 2, "signInEligibility": "exclude" }
```

The closed set is `"off"` and `"exclude"`; absent means off. A typo is rejected by validation rather than read as off, because silently keeping a dead provider in the pool is the failure this decision exists to stop.

- `off`: no resolution, no network call, today's dispatch behavior.
- `exclude`: resolve the sign-in of every provider the configured pools name and treat `invalid` or `not_configured` as ineligible. The filter runs after the hard provider scope and before economic admission and reliability, so an excluded candidate is never scored, reserved, claimed, or dispatched.

The answer is per session and per configuration generation, behind a 60-second cache. Preparation runs at the start of a user turn, and runs again inside that turn when a config reload advances the generation or a registry refresh makes a provider selectable, because a pool that changed after the answer was produced is not covered by it. The turn keeps the set it prepared for its own selection; everything else (physical input routing, the preview report, the allowance-retry preselection) reads the age-checked cache, so a credential fixed after a failed turn stops excluding as soon as the window passes.
- The exclusion uses its own reason, `sign_in_unavailable`. It is not written to the reliability store: no circuit opens and no pause is recorded, because no provider failure happened. `/bifrost preview` and route errors surface the reason through the existing skipped-candidate reporting.
- Selection continues inside the same tier. An explicit `fallbackTiers: []` boundary stays terminal; a configured fallback list is honored exactly as it is for any other ineligible candidate.
- `unknown` never excludes. A resolution that could not run — timeout, cancellation, a host with no `getProviderAuth` — is not proof that the credential is dead, and treating it as proof would route away from healthy providers on a transient failure.
- A resolution that **threw** is reported as `invalid`, not `unknown`, and therefore excludes. The failure this ADR closes was a thrown OAuth refresh (`401 refresh_token_reused`), so counting a throw as unusable is what makes the fix work; the price is that a transient network error during a refresh also excludes for at most one cache window. Separating the two would mean classifying provider error text, which is less reliable than the window is short.

The advisory-only shape (`observe`) was dropped. The signal already exists in `inspect` and `check` without a per-request network call, so a mode that pays the resolution cost and changes no route would add a knob with no decision behind it.

## Constraints

- **No resolution without a reason.** `getProviderAuth` may refresh an expired OAuth token, which is a network call. Resolution therefore runs only when the configuration opts in, once per session per provider behind a 60-second cache, and never for a request that does not enter Auto.
- **Same-tier only.** The swap may not borrow the allowance recovery path's cross-tier behavior. An explicit tier prefix keeps its tier, and an exhausted schema-v2 boundary stays exhausted.
- **No state invention.** The exclusion must not write a fabricated circuit or pause, so `/bifrost inspect` and the reliability store never claim a provider failure that did not happen.
- **No replay.** The rule holds that failed user work is never automatically rerun. Shape A acts strictly before dispatch; any failure after dispatch keeps today's behavior.
- **Physical selection stays physical.** A pinned model is never swapped.
- **Default off.** Absent or `"off"` disables the check; `"exclude"` is explicit configuration.

## Consequences

The reported failure mode is removed when a credential dies while its provider is still in a configured tier, and the dead provider stays visible instead of being rewritten out of the user's configuration. The cost is one auth resolution per configured provider per session-minute for users who opt in, repeated inside a turn that reloads or refreshes, plus a new eligibility reason that has to stay explainable wherever exclusions are printed. Resolutions are sequential with a 4-second timeout each and an 8-second budget for the whole set, so a host where several stored credentials hang cannot hold the turn for longer than the budget: providers the budget does not reach are reported `unknown`, which never excludes. Providers a hard provider scope forbids for the tier that names them are skipped before any resolution, because waiting on a sign-in that could never be selected buys nothing. That bounded wait is the price of not sending a request that would fail, and the TTL caps how often it is paid. A session that signs in again may keep the exclusion for up to one cache window; `off` and a restart remove it immediately.

A pool emptied only by sign-in reports `sign_in_unavailable` per candidate and now carries the same code as its tier-level reason, so `/bifrost preview` names the provider's sign-in instead of calling the tier unhealthy — no reliability event happened, and sending the user to that store explains nothing. A pool with mixed skips keeps `requested_tier_unhealthy`, because something outside sign-in also excluded a candidate. The virtual route's own no-model error still names the tier it finally failed in, which can be a fallback tier; that is the existing message shape, not an attribution of this feature.

The failure is still terminal when the configuration does not opt in, when the tier has no other eligible model and no configured fallback, or when resolution itself cannot run.

## Verification

- `tests/sign-in-eligibility-runtime.test.ts` drives the real Auto route through registered Pi hooks: with `exclude` and a provider whose `getProviderAuth` throws, it dispatches the next model; with `off` it dispatches the doomed model and records zero auth resolutions; with a dead-only tier and `fallbackTiers: []` it rejects and dispatches nothing. It also covers a bare pool entry, a provider the registry only makes selectable during the turn, a reload during a turn, a config reload that lands mid-resolution, cache expiry, and a continuation that keeps its model.
- `tests/routing.test.ts` proves the resolver records `sign_in_unavailable`, keeps the explicit empty boundary terminal, reports a sign-in-only empty tier as `sign_in_unavailable` rather than `requested_tier_unhealthy` (mutation: dropping that branch turns the assertion RED), keeps the reliability wording for a mixed pool, and still selects the same model without the predicate (fault control).
- `tests/config.test.ts` rejects an unknown value, requires schemaVersion 2, and surfaces the invalid value through whole-config validation.
- `tests/config-agent.test.ts` proves the resolution bound directly: a never-settling registry over six providers stops asking once the total budget is spent, reports every unasked provider as `unknown`, and spends no more than the budget.
- Mutation checks: dropping the sign-in filter from the candidate pool, widening the closed value set to accept anything, dropping the post-refresh preparation, dropping the generation-change re-preparation, and removing the total-budget gate each turn their named assertions RED.
- `tests/sign-in-eligibility-runtime.test.ts` covers the boundaries directly: a pinned session spends no resolution and adds no dispatch (mutation: dropping `!state.pinned` from the preparation gate turns it RED), a host with no `getProviderAuth` reports `unknown` and keeps the configured order (mutation: counting `unknown` as an exclusion turns it RED), and a turn that carries a previous, now-excluded model does not dispatch it. The last-model guard itself is pinned by `tests/routing.test.ts` (mutation: removing `excludedBySignIn` from `lastModelFallbackAllowed` turns it RED).
- Not covered by a runtime test, and checked by reading instead: physical input routing never prepares, because the preparation gate is `request.reason === "user"` inside the virtual route; and a cancelled resolution is not cached, because the early return happens before the cache write.
