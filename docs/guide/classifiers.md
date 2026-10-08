# Classifier backends

[Guide index](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

A classifier is optional. Regex rules and the configured default tier can route without another model call.

`/bifrost init` normally proposes an enabled prompt classifier when it finds a working model. After init writes configuration, run `/bifrost classifier` to choose a backend. Run `/bifrost classifier off` or set `classifier.enabled` to `false` for rules/default-only routing.

Classifiers resolve **tiers**, not exact provider models. Model pools, reliability filtering, and strategies remain Bifrost policy.

Set `classifier.backend` to `prompt`, `typesafe`, or `pi-native` for a fixed choice. If you omit it, Bifrost selects a backend when it first builds the classifier pipeline:

1. Pi-managed TypeSafe credential (including `/login`, a runtime key, or `models.json`): `pi-native`.
2. `TYPESAFE_API_KEY` in the environment: `typesafe`.
3. No detected credential: `prompt`.

An explicit backend always wins. Detection stays fixed until the extension restarts, even after `/bifrost reload`. On first use, Bifrost prints the detected backend and reason. `/bifrost classifier status` and `/bifrost classifier test` show `auto: <backend> (<reason>)` when detection supplies the choice. Users upgrading with no explicit backend can switch from prompt to a direct backend. Set `"backend": "prompt"` to keep prompt classification.

If the auto-detected direct backend's settings are invalid (for example a missing criterion for a custom tier), Bifrost prints the config errors and falls back to prompt classification when `fallback` is not `regex`. An explicit `classifier.backend` fails closed instead.

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

Set `classifier.totalTimeoutMs` to an integer from `1` to `60000` to cap all external classifier work for one classification, including direct backends, retries, and prompt fallback. When the budget expires, Bifrost stops further classifier calls and continues with local regex/default routing. Cancelling the caller stops classification and routing. If you omit this option, each backend keeps its existing timeout and retry budget.

```json
{
  "classifier": {
    "totalTimeoutMs": 2500
  }
}
```

## TypeSafe/Jev

TypeSafe/Jev is an optional hosted tier-classification backend and requires a TypeSafe credential. Set `"backend": "typesafe"` to select Bifrost's direct TypeSafe transport.

Jev receives the current prompt and configured tier criteria, then returns:

- one configured tier choice;
- probability for each tier;
- confidence.

Jev does not receive Bifrost's provider model pool and does not select an exact provider/model.

Confidence measures how concentrated Jev's returned distribution is. It is not a correctness guarantee. Exploratory Pi-Bifrost evaluation found stable judgments for clear, bounded prompts, but current criteria also produced high-confidence under-routing for some mechanically small, high-consequence tasks. Treat tier criteria as versioned policy: keep fallback enabled, pin the evaluated Jev version, and test criteria against representative locked cases before relying on thresholds.

TypeSafe/Jev support uses a fixed hosted endpoint. Bifrost does not provide a generic local, self-hosted, or OpenRouter-compatible classifier transport.

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

## Pi-native classifier

The `pi-native` backend calls Pi's `ctx.modelRegistry.classify()` API. Pi resolves the TypeSafe credential and classifier model. Set up TypeSafe through Pi's `/login` command, or set `TYPESAFE_API_KEY` in your environment. Select `pi-native` in `/bifrost classifier` or set it in `.pi/bifrost.json`. The `pi-native` picker entry appears only when the host exposes classification support (`classify()`).

```json
{
  "classifier": {
    "enabled": true,
    "backend": "pi-native",
    "piNative": { "model": "typesafe/jev-latest" },
    "minConfidence": 0.8,
    "fallback": "regex",
    "criteria": {
      "quick": "Bounded, reversible work",
      "general": "Normal implementation and moderate reasoning",
      "frontier": "Complex, ambiguous, or high-consequence work"
    }
  }
}
```

You can omit `classifier.piNative.model`. Pi then uses the first available TypeSafe classifier model in its catalog. Bifrost skips its fuzzy classification cache in this mode because the catalog choice can change. Set a model id to enable that cache for Pi-native classification. If no model is available, Bifrost reports whether credentials or the catalog need attention. Set `fallback` to `prompt` and provide `classifier.model` to use a chat model after a direct-classifier miss. Set it to `regex` to skip that extra model call. The direct transport retries bounded errors and never replays a user turn.

See [the full example](../../examples/classifier-pi-native.json).

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

`test` makes a fresh request. `status` shows the active backend, model, fallback, and safe metrics without exposing keys. The direct TypeSafe backend also shows the credential source. Pi-native shows the catalog model or the configured `classifier.piNative.model`.

Low confidence, missing credentials, network failure, timeout, invalid response, rate limit, or open classifier circuit follows configured fallback. User prompts are never replayed.

When a direct classifier misses during normal routing, Bifrost warns once for that classifier state and names the fallback that actually produced the tier. If its model-only circuit opens, the warning includes the local cooldown expiry. Repeated requests during the same open circuit do not repeat the warning; a successful classifier call after recovery clears the notice and reports recovery. If no tier is selected, the warning says so instead of implying routing continued. These notices do not change routing or make extra classifier calls.

## Privacy and preview behavior

The active classifier receives the current prompt and tier instructions. It does not receive conversation history, prior messages, source files, or tool output by default.

`/bifrost preview <prompt>` uses the same steps Bifrost uses to pick a tier for a normal message (local classification cache → optional classifier → rules → default). It does not treat a leading tier name as an override. When no local cache entry resolves first, an enabled prompt, TypeSafe/Jev, or Pi-native classifier can receive the preview prompt and incur classifier usage. Preview does not submit a generation turn or activate the selected provider model.

Direct-classifier metrics are content-free and local. With global debug enabled, the JSONL log records typed direct-classifier outcomes and the actual fallback used, even when detailed TypeSafe debug is off. Detailed direct TypeSafe traces still require both global debug and TypeSafe debug. In `.pi/bifrost.json`:

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
