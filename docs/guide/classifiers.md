# Classifier backends

[Guide index](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

A classifier is optional. Regex rules and the configured default tier can route without another model call.

`/bifrost init` normally proposes an enabled prompt classifier when it finds a working classifier model. Review the generated `classifier` block. Run `/bifrost classifier off` or set `classifier.enabled` to `false` for rules/default-only routing.

Classifiers resolve **tiers**, not exact provider models. Model pools, reliability filtering, and strategies remain Bifrost policy.

## Prompt classifier

The prompt backend asks a configured Pi model to return one tier name. In `.pi/bifrost.json`:

```json
{
  "classifier": {
    "enabled": true,
    "backend": "prompt",
    "model": "provider/classifier-model"
  }
}
```

Prompt classification adds model tokens and latency on cache misses. Successful results may enter Bifrost's local classification cache.

If prompt classification fails or returns an unknown tier, Bifrost continues through configured fallback, regex rules, and default tier behavior.

## TypeSafe/Jev

TypeSafe/Jev is an optional hosted tier-classification backend and requires a TypeSafe credential. Selecting it is explicit opt-in.

Jev receives the current prompt and configured tier criteria, then returns:

- one configured tier choice;
- probability for each tier;
- confidence.

Jev does not receive Bifrost's provider model pool and does not select an exact provider/model.

Choose TypeSafe in Pi:

```text
/bifrost classifier
```

Or configure it in `.pi/bifrost.json`:

```json
{
  "classifier": {
    "enabled": true,
    "backend": "typesafe",
    "typesafe": {
      "model": "jev-1.13.0"
    },
    "minConfidence": 0.8,
    "fallback": "prompt",
    "model": "provider/fallback-classifier-model",
    "criteria": {
      "quick": "Bounded, reversible work",
      "general": "Normal implementation and moderate reasoning",
      "frontier": "Complex, ambiguous, or high-consequence work"
    }
  }
}
```

## Credentials

Recommended Pi user auth file, `~/.pi/agent/auth.json`:

```json
{
  "typesafe": {
    "type": "api_key",
    "key": "ts_..."
  }
}
```

Location:

```text
~/.pi/agent/auth.json
```

Or use:

```bash
export TYPESAFE_API_KEY="ts_..."
```

Repository config cannot redirect TypeSafe credentials to arbitrary origins. TypeSafe transport is pinned to its supported model and official endpoint contract.

## Test and inspect

```text
/bifrost classifier test
/bifrost classifier status
```

`test` makes a fresh request. `status` shows active backend, model, credential source, fallback, and safe metrics without exposing keys.

Low confidence, missing credentials, network failure, timeout, invalid response, rate limit, or open classifier circuit follows configured fallback. User prompts are never replayed.

## Privacy and preview behavior

The active classifier receives the current prompt and tier instructions. It does not receive conversation history, prior messages, source files, or tool output by default.

`/bifrost preview <prompt>` uses the same steps Bifrost uses to pick a tier for a normal message (local classification cache → optional classifier → rules → default). It does not treat a leading tier name as an override. When no local cache entry resolves first, an enabled prompt or TypeSafe/Jev classifier may receive the preview prompt and incur classifier usage. Preview does not submit a generation turn or activate the selected provider model.

TypeSafe operational metrics are content-free and local. Detailed troubleshooting requires both global debug and TypeSafe debug. In `.pi/bifrost.json`:

```json
{
  "debug": { "enabled": true },
  "classifier": {
    "backend": "typesafe",
    "typesafe": { "debug": true }
  }
}
```

Detailed traces contain bounded operational metadata. They do not persist raw prompts, request/response bodies, provider payloads, credentials, authorization headers, or external error text.

Bifrost's separate fuzzy classification cache may persist normalized prompt words. Disable that cache independently for sensitive work.
