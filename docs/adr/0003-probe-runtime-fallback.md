# Probe runtime fallback for Codex models

pi-bifrost's model probe originally used `provider.streamSimple(...)` as the only availability check. That worked for many providers, but failed for working `openai-codex` models such as `openai-codex/gpt-5.4-mini`.

## What we observed

- `provider.streamSimple(...)` on `openai-codex/gpt-5.4-mini` returned an empty assistant response and `stopReason: "error"`.
- `ModelRuntime.completeSimple(...)` and `ModelRuntime.complete(...)` showed the same failure mode.
- The model was not actually dead:
  - `createAgentSession(...)` with a minimal loader, no extensions, no tools, and the same model returned a valid answer.
  - A probe prompt (`1+1=`) returned `2`.
  - A classifier prompt returned the expected tier.
- Session payloads looked normal. The request included the model, instructions, user input, and tool config as expected.
- Auth was valid. The failure was not missing credentials.

## What that means

`streamSimple` is not a reliable health check for every provider/model combination exposed through Pi. It is a fast path, not a truth oracle.

For Codex-backed models, the working runtime path is closer to a real agent session than a bare completion call.

## Measured behavior

- `streamSimple`: fast, but failed on `openai-codex/gpt-5.4-mini`.
- Minimal `createAgentSession`: worked, roughly ~2.4s in local testing.
- Subprocess `pi --no-extensions ...`: worked too, but was slower (~6s+).

## Decision

Use a tiered probe/runtime strategy:

1. Try fast provider streaming first.
2. If the response is empty or errors in a provider-specific way, retry through a minimal Pi session.
3. Keep subprocess as last-resort fallback, not primary probe path.

## Why this is the right shape

- Preserves speed for providers that already behave well.
- Makes probe results trustworthy for real working models.
- Avoids marking healthy Codex models as broken.
- Keeps runtime behavior closer to how Pi actually runs agents.

## Consequences

- Probe logic becomes slightly more complex.
- Availability checks now have two tiers of trust.
- Classifier fallback should match probe fallback, so routing and probing stay consistent.

## Open questions

- Which provider failures should trigger session fallback automatically?
- Should fallback be limited to empty responses only, or to any `stopReason: "error"`?
- Should probe telemetry record whether the direct or session path succeeded?
