# 0023 — Bounded allowance recovery for Pi Auto

## Status

**Accepted and implemented.** This decision defines the proof required for one narrow Auto retry. Provider pause scope and status are defined by [ADR 0024](0024-provider-usage-and-rate-pauses.md). This decision does not authorize retry after output, tool use, or an unknown boundary.

## Context

When Pi reports a usage or billing rejection, the request can end before it produces a response. A user can then select another model or submit the request again. This decision describes the one safe Auto recovery case.

## Decision

When `reliability.retryOnAllowanceExhausted` is enabled (default `true`) and allowance cooldown is enabled, Pi Auto may make at most one automatic attempt on a different configured model after an explicit usage or billing rejection. The retry is allowed only when Pi's pinned `agent_before_settle` boundary proves all of the following:

- the request belongs to one exact user message and one Auto model selection, either automatic or from an explicit tier prefix;
- every failed assistant attempt from the original user boundary has no content and names the same admitted model;
- any earlier failed attempt was omitted from the model projection by Pi's exact null context edit;
- there are no tool calls or tool results, queued messages, aborts, or intervening messages;
- the turn is still owned by the same session, branch, config generation, and manual-control generation;
- Pi has finished any host-owned retry; tool continuations and other intervening activity remain excluded.

Bifrost settles the original failure before editing the model-context projection or continuing. V2 requires a confirmed settlement. V1 requires a confirmed synchronous state write; if it cannot confirm the write, it stops. The context edit omits the empty failed response only from the next model request. The raw transcript remains visible. Bifrost then revalidates configured candidates through normal circuit, reserve, and eligibility checks and performs one normal admission for the selected alternate. It does not use `sendUserMessage`, retain prompt text, or call a classifier or probe for recovery. The provider pause policy does not identify shared billing accounts.

The retry setting applies only when reliability is enabled and `cooldownOnAllowanceExhausted` is enabled. Bifrost must save the configured model or provider pause before it can safely dispatch an alternate. See ADR 0024 for pause scope.

Physical selection, direct model bindings, exhausted explicit schema-v2 fallback boundaries, tool continuations, unsafe or unknown failures, and the absence of an eligible configured alternate do not trigger this behavior. An explicit tier prefix can recover only when the initial selection stayed in that tier, and its alternate must also come from that tier. If the initial selection used the existing fallback to another tier, or the requested tier has no eligible alternate, recovery stops even when a general fallback is configured. An unprefixed Auto route keeps its existing fallback behavior. Pi's own bounded retries may run first. Bifrost accepts that chain only when each preceding attempt is an empty error from the same admitted model and Pi recorded a null context edit for that exact assistant entry. When an unprefixed requested tier has no eligible alternate and no explicit fallback policy, Bifrost checks the configured default and remaining configured tiers in stable config order. The retry flag is adapter lifecycle policy and is rejected by the resolve-only router API. A second Bifrost allowance failure ends the turn; Bifrost does not try a third model.

The user can turn the behavior off with:

```json
{
  "reliability": {
    "retryOnAllowanceExhausted": false
  }
}
```

## UX

For the safe path, show one concise warning naming the rejected model and the alternate being tried. If recovery stops, explain that no retry was sent and give a useful next action. Keep evidence categories and lifecycle ownership details in content-free debug output.

## Consequences

The common empty allowance rejection can recover without asking the user to resubmit. Output, tool use, queued work, cancellation, uncertain ownership, and strict routing boundaries still stop safely. The second provider request is intentional and bounded, and the feature can be disabled without changing the configured pools.

## Verification

Registered-hook tests prove the safety guards. Pinned Pi fake-provider tests prove one failed request followed by one alternate request in both reliability versions, preserve the original user boundary, settle V2 receipts independently, and verify disabled/no-alternative outcomes. The full test and UI checks remain the release gates.
