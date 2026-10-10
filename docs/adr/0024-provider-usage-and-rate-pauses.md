# 0024 — Provider usage and rate pauses

## Status

**Accepted, 10 October 2026.** This decision defines reactive pauses from provider responses. It does not add live quota lookup.

## Context

A usage or billing rejection can apply beyond one model. Pi exposes configured provider IDs, but Bifrost does not know whether different IDs share an account. The policy must use visible configuration and not claim account identity.

## Decision

By default, a confirmed usage-exhaustion or billing-denial response pauses models that use the same configured Pi provider ID. The pause applies to Auto and physical routing. `reliability.allowanceCooldownScope: "model"` limits usage and billing pauses to the reported model. `reliability.cooldownOnAllowanceExhausted: false` disables these pauses.

`reliability.enabled: false` disables provider pause recording and enforcement. It does not erase saved provider pause state.

An HTTP 402 response is `billing_denied`. It pauses the provider by default, but does not prove that the provider account has no credits. Explicit usage or credit exhaustion is `allowance_exhausted`.

HTTP 429 rate limits pause the configured provider. A validated retry time sets a pause of up to five minutes. If no valid time is available, the pause lasts five seconds. A clear usage-exhaustion response follows the usage-pause policy. Rate-limit pauses do not retry the current prompt. HTTP 5xx responses follow normal model failure handling.

After a usage or billing pause expires, one controlled recovery trial can test the provider. The project-scoped state is shared across Auto, physical routing, and reliability versions. It stores provider IDs, pause times, and recovery leases. It does not store prompts, credentials, or provider error text.

`/bifrost reliability` shows active provider pauses and recovery trials. `/bifrost reliability reset --provider <id>` clears one known provider's pause and trial state. It does not clear model reliability records. Reset stops during an active recovery trial. A pinned model cannot bypass a provider pause while Bifrost routing is on. `/bifrost off` remains the explicit manual bypass.

## Consequences

The default protects other models that use the same configured provider ID after a usage or billing rejection. It does not detect shared accounts across different IDs. Users with separate accounts behind one ID can select model scope. Users who disable usage pauses also disable the associated Auto retry. They can separately disable the retry while keeping pauses with `reliability.retryOnAllowanceExhausted: false`.

This policy uses errors from requests Pi already sent. It does not fetch live usage, prove provider account limits, or prevent every provider charge.
