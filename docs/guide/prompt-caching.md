# Provider prompt caching and model switching

[Guide index](index.md) · [Routing controls](routing-controls.md) · [Reliability and local cache](reliability-and-cache.md)

## Short answer

Pi-Bifrost is **prompt-cache mindful, not prompt-cache managing**.

Bifrost chooses and activates Pi's model before generation. It does not create, merge, clear, price, inspect, or guarantee provider prompt-cache entries. Each provider decides whether an input prefix qualifies, how long it remains reusable, and how usage is billed.

If Bifrost switches models during one long session, treat every provider/model pair as having an independent cache history. Returning to an earlier model may reuse that model's longest still-valid matching prefix. Conversation content added since that model last handled the session is an uncached tail.

## Two different caches

Bifrost and model providers cache different things:

| Cache | Owner | Stores | Purpose |
|------|-------|--------|---------|
| Bifrost classification cache | Pi-Bifrost | Normalized prompt terms and selected tier | Avoid repeating tier classification |
| Provider prompt or prefix cache | Provider through Pi's integration | Provider-defined reusable prefix the provider accepts for a model | Avoid recomputing the same input |

`/bifrost cache stats` reports only Bifrost's local classification cache. It does not show provider prompt-cache hits, lifetime, savings, or billing.

Normalized classification-cache text can still contain sensitive terms. See [Reliability and local cache](reliability-and-cache.md#local-classification-cache) to inspect, clear, move, or disable it.

## One long session with N model switches

Consider a session routed through this sequence:

```text
A → B → C → A → B → A
```

Use this mental model:

```text
provider/model A: history from requests handled by A
provider/model B: history from requests handled by B
provider/model C: history from requests handled by C
```

Switching away from A does not mean Bifrost deleted A's provider cache. Bifrost has no API for doing that. When the session returns to A, the provider may reuse A's longest still-valid prefix if the serialized request still begins with that exact reusable prefix.

Everything added to the conversation after A's previous request is new input from A's perspective. That content forms an uncached tail. More switching usually means longer uncached tails and less predictable cache locality.

Reuse can also fail because of provider-specific expiry, minimum-length rules, request serialization, system-prompt changes, tool definitions, account boundaries, or other provider policy. Bifrost cannot promise a hit simply because the same model is selected again.

## A → B → A example

| Turn | Active model | Likely cache interpretation |
|------|--------------|-----------------------------|
| 1 | A | A may create or extend a reusable prefix |
| 2 | B | B sees its own request and may create or extend a separate prefix |
| 3 | A | A may reuse its longest still-valid Turn 1 prefix; Turn 2 and later content are an uncached tail |

This is a provider-neutral model, not a guarantee for every provider. Eligibility, retention, hit reporting, and pricing remain provider-specific.

## Are Bifrost's routing modes prompt-cache mindful?

Yes, because the tradeoff is explicit and controllable. No mode can guarantee provider caching.

| Mode | Model behavior | Cache-locality tradeoff | Best fit |
|------|----------------|-------------------------|----------|
| Adaptive routing (routing on, nothing pinned) | May pick a different configured model for every message | Lowest predictability | Task and model fit matter more than continuity |
| Tier name in the message | Uses one tier for one message; that tier's strategy picks the model | May switch the model for one message | You know which capability tier the message needs |
| Pinned | Keeps one exact model for the whole session | Best chance of one continuous model history | Long context, iterative work, cache locality |
| Model chosen manually in Pi | Locks that model, exactly like pin | Same continuity benefit as pin | You know the exact model you want |

`/bifrost pin` is a hard lock. While pinned, Bifrost does not route automatically and ignores tier names in messages. `/bifrost unpin` restores per-message routing.

## Practical workflows

### Prefer task fit

Leave routing on and nothing pinned. Accept that different provider/model pairs build separate histories.

```text
/bifrost on
/bifrost unpin
```

### Prefer continuity

Select the desired model, then pin it:

```text
/bifrost pin
```

Use this for long debugging sessions, sustained refactors, or any conversation where continuity matters more than per-turn model fit.

### Keep the parent stable and route delegated work

A cache-minded multi-agent pattern is:

```text
main session → pinned model
unassigned child sessions → their own Bifrost routing
```

A parent pin is session-local and does not propagate to children. Each child has its own conversation and provider/model cache history. If an exact child model assignment must never be changed, ensure that child session does not load Bifrost; current Bifrost cannot distinguish an explicit child assignment from another starting model.

## Decision checklist

Choose **adaptive routing** when:

- prompts vary substantially in complexity;
- model fit or cost policy matters more than one continuous model history;
- separate provider/model cache histories are acceptable.

Choose **pinning** when:

- one long conversation repeatedly builds on the same context;
- provider cache locality matters more than task-by-task routing;
- you need an exact model to remain active.

Use a **tier name at the start of a message** when:

- one message clearly needs a known capability tier;
- you accept that its exact model comes from that tier's configured strategy;
- switching the model for one message is acceptable.

## Common questions

### Does switching models clear the previous model's cache?

Not necessarily. Bifrost does not clear provider caches. The previous entry may remain reusable until provider expiry or invalidation.

### Does switching back guarantee reuse?

No. The provider may reuse the longest still-valid matching prefix, but eligibility and lifetime are provider-controlled.

### Does Bifrost merge cache histories across models?

No. Treat every provider/model pair as independent.

### Does `/bifrost cache stats` show provider cache savings?

No. It reports Bifrost's local tier-classification cache only.

### Does pinning guarantee lower cost?

No. Pinning improves the opportunity for cache locality by keeping the model stable. Providers still control cache eligibility and billing.

### Can Bifrost automatically replay a failed request on another model?

No. It never automatically replays failed prompts because the original turn may already have caused side effects. Reliability circuits change future routing only.
