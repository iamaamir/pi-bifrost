# Configure routing policy

[Guide index](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

Bifrost policy follows this flow:

```text
pick a tier → that tier's models → skip unhealthy ones → per-tier strategy → Pi's active model
```

## Tier model pools

Keys under `models` are tier names. Values list the models allowed in that tier. Add this to `.pi/bifrost.json`:

```json
{
  "models": {
    "quick": [
      "provider/fast-model",
      "provider/backup-fast-model"
    ],
    "general": [
      "provider/general-model"
    ],
    "frontier": [
      "provider/frontier-model"
    ]
  }
}
```

Adding a model makes it available in that tier. Removing it prevents selection through that tier. Model pools are the primary adaptive-routing boundary.

Patterns containing `/` may resolve an exact `provider/id`. Shorter strings may substring-match multiple registry IDs. Use exact IDs when ambiguity matters, then confirm candidates with `/bifrost preview <prompt>`.

## Selection strategies

Strategies choose the exact healthy candidate after a tier has resolved:

| Strategy | Selection behavior |
|----------|--------------------|
| `first` | First healthy candidate in list order |
| `fastest` | Alias for `first`; init may order list from its one-time probe |
| `cheapest` | Lowest combined input and output cost |
| `cheapest_input` | Lowest input cost |
| `cheapest_output` | Lowest output cost |
| `largest_context` | Largest context window |
| `random` | Random healthy candidate |

Set one global fallback and override individual tiers. In `.pi/bifrost.json`:

```json
{
  "strategy": "first",
  "categoryStrategies": {
    "quick": "cheapest",
    "general": "first",
    "frontier": "largest_context"
  }
}
```

`random` occurs only when configured explicitly, and the built-in default does configure it: `quick` uses `random`, while `general` and `frontier` use `first`. Set a tier's strategy yourself if you want a stable choice there. `fastest` is not live latency routing; it behaves as `first` over current list order.

## Tier rules

Regex rules are case-insensitive and evaluated in configured order. First match wins within the regex stage. In `.pi/bifrost.json`:

```json
{
  "rules": [
    {
      "pattern": "\\b(commit message|conventional commit)\\b",
      "model": "quick"
    },
    {
      "pattern": "\\b(race condition|deadlock|security audit)\\b",
      "model": "frontier"
    }
  ]
}
```

Despite the property name `model`, a rule value without `/` names a tier.

## Direct-model rules

A rule value containing `/` binds one exact provider/model and skips tier selection. In `.pi/bifrost.json`:

```json
{
  "rules": [
    {
      "pattern": "\\bcommit\\b",
      "model": "provider/specific-model"
    }
  ]
}
```

Use direct bindings when role or task policy already knows the exact model. Tier strategies do not apply to direct-model rules.

## Tier-resolution order

For a normal message with routing on and nothing pinned, routing considers:

1. a tier name at the start of the message;
2. a regex rule that names an exact `provider/id`;
3. a matching entry in the local classification cache;
4. the optional TypeSafe/Jev classifier;
5. the optional prompt classifier;
6. other regex rules;
7. the configured default tier.

First matching step wins; later steps are skipped. A rule naming an exact model wins before the cache and classifiers; a rule naming a tier is checked after them. Reliability filtering and strategy selection happen after a tier is resolved.

## Complete example

Full configuration file, `.pi/bifrost.json`:

```json
{
  "enabled": true,
  "default": "general",
  "strategy": "first",
  "categoryStrategies": {
    "quick": "cheapest",
    "general": "first",
    "frontier": "largest_context"
  },
  "models": {
    "quick": ["provider/fast-model", "provider/backup-fast-model"],
    "general": ["provider/general-model"],
    "frontier": ["provider/frontier-model"]
  },
  "rules": [
    {
      "pattern": "\\b(commit message|format this)\\b",
      "model": "quick"
    },
    {
      "pattern": "\\b(race condition|security audit)\\b",
      "model": "frontier"
    }
  ],
  "classifier": {
    "enabled": false
  },
  "cache": {
    "enabled": true,
    "maxEntries": 500,
    "threshold": 0.85
  },
  "reliability": {
    "enabled": true,
    "failureThreshold": 3,
    "windowMinutes": 5,
    "cooldownMinutes": 60
  }
}
```

## More examples

See [`examples/`](../../examples/) and its [recipe guide](../../examples/README.md).
