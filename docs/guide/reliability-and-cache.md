# Reliability and caching

[Guide index](index.md) · [Provider prompt caching](prompt-caching.md) · [Troubleshooting](troubleshooting.md)

## Reliability circuits

Bifrost tracks model failures from:

- availability probes;
- failed Pi model activation;
- settled provider stream failures.

After configured repeated failures inside a time window, Bifrost opens that model's circuit. Open-circuit candidates are excluded before tier strategy selection. In `.pi/bifrost.json`:

```json
{
  "reliability": {
    "enabled": true,
    "failureThreshold": 3,
    "windowMinutes": 5,
    "cooldownMinutes": 60
  }
}
```

Reliability state persists in `.pi/bifrost-reliability.json`. After cooldown, Bifrost may try that model once. Success restores it; failure keeps it excluded longer.

Bifrost never automatically replays the prompt that failed. Reliability affects future user turns only.

## Reliability is not quota enforcement

A circuit records observed model health. It does not know authoritative provider weekly quota unless Pi or the provider exposes that information.

Current safeguards for quota-sensitive models:

- remove them from broad adaptive tiers;
- isolate them in a dedicated tier;
- bind them behind deliberate direct rules;
- use deterministic strategies instead of `random` where needed;
- preview routes before sending consequential work.

Bifrost does not currently provide authoritative provider quota guards.

## Local classification cache

Bifrost's local cache stores routing classifications—not assistant answers.

Default project-local file:

```text
.pi/bifrost-cache.jsonl
```

Entries contain:

- normalized prompt words;
- selected tier;
- last-use timestamp;
- hit count;
- classifier-semantics fingerprint.

Normalized prompt text can still contain sensitive terms. Disable caching for sensitive projects in `.pi/bifrost.json`:

```json
{
  "cache": {
    "enabled": false
  }
}
```

Inspect or clear it:

```text
/bifrost cache stats
/bifrost cache clear
```

Bifrost does not cache assistant responses, tool output, source files, or failed prompts for replay.

## Provider prompt caches

Provider prompt or prefix caches are separate from Bifrost's local classification cache. Bifrost does not create, merge, clear, price, inspect, or guarantee them.

Treat every provider/model pair as an independent cache history. Repeated switching may fragment cache locality without necessarily deleting earlier provider entries. Returning to a model may reuse its longest still-valid matching prefix; later conversation content remains an uncached tail.

See also: [Provider prompt caching and model switching](prompt-caching.md) for A → B → A, N-switch behavior, adaptive-versus-pinned tradeoffs, and practical recommendations.

## Debug logging

Enable local JSONL routing diagnostics in `.pi/bifrost.json`:

```json
{
  "debug": {
    "enabled": true
  }
}
```

Default file:

```text
.pi/bifrost-debug.jsonl
```

Normal Bifrost debug events record routing reason, selected tier/model, and timing—not raw prompt bodies.

TypeSafe troubleshooting has additional explicit gates. See [Classifier backends](classifiers.md).
