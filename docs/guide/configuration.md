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

### Explicit fallback boundaries (schema version 2)

By default, an unavailable or unhealthy tier can still fall back to the configured `default` tier. To limit one tier to an explicit ordered list, set `schemaVersion` to `2` and add that tier's `fallbackTiers` policy:

```json
{
  "schemaVersion": 2,
  "models": {
    "frontier": ["provider/frontier-model"],
    "general": ["provider/general-model"],
    "quick": ["provider/quick-model"]
  },
  "tierPolicies": {
    "frontier": { "fallbackTiers": ["general", "quick"] },
    "quick": { "fallbackTiers": [] }
  }
}
```

For `frontier`, Bifrost tries `frontier`, then `general`, then `quick`; it stops at the first tier with an eligible model. The empty list makes `quick` a singleton boundary. A tier without a `tierPolicies` entry keeps the legacy default-tier fallback, including when `schemaVersion` is `2`. Version 2 by itself does not change routing. References must name configured tiers, and duplicate, self, or cyclic fallback references are rejected. Invalid version-2 policy configuration blocks physical and Auto routing until corrected. Reload rejects unreadable, malformed, or non-object config layers and keeps the active configuration, including any session-local pin.

### Economic observations and billing preference (schema version 2)

The optional `economics` namespace starts off when omitted. It accepts provider- or model-scoped facts that you enter in config. Sources must be marked `declared` or `estimated`; Pi does not read billing APIs or account scopes. Use `mode: "observe"` first. It records whether each rule would reject a candidate and leaves selection order and random selection unchanged.

`mode: "policy"` applies configured reserve rules before strategy selection. Each rule sets `unknown` to `block` or `ignore`, which controls candidates without a fresh allowance fact. A policy-mode no-route is handled by physical routing and does not fall through to Auto's last dispatched model. Manual pin and off controls remain in charge. Existing tool continuations and retries keep Pi's established model.

An optional `preference.billingClass` can prefer `subscription`, `metered`, or `free` billing facts. In observe mode, Bifrost reports which final eligible candidates would be preferred while preserving their order and random selection. In policy mode, it applies the existing strategy only within the preferred candidates in the already chosen tier. If no eligible candidate has a fresh matching fact, the existing strategy sees the full eligible pool. Unknown, stale, conflicting, or unsupported evidence stays neutral. Preference-only policy with `admission: []` does not create a hard admission rule or turn an otherwise unresolved route into a route.

Billing class comes only from a fresh explicit declared or estimated signal, not provider naming or a zero catalog price. The same source order and authority rules apply as for reserves. A window reset expires allowance facts for that period; it does not refresh or change the billing-class fact. Routing decision summaries report class, source alias, authority, and freshness without allowance values or account references. This preference is not a spend cap and makes no savings claim. See [`economic-reserve-observe.json`](../../examples/economic-reserve-observe.json) and [`economic-billing-preference.json`](../../examples/economic-billing-preference.json).

### Affinity observation and retention

In the Pi extension, Auto uses `retain-within-tier` when the `affinity` namespace is absent. It keeps a proven successful Auto model only when that model remains in the chosen tier's final selection pool. Physical selection stays off by default. The resolve-only API also stays off when affinity is omitted; it uses only the mode explicitly passed in its config.

The optional `affinity` namespace requires `schemaVersion: 2` and overrides the Pi defaults. Set `{"schemaVersion":2,"affinity":{"mode":"off"}}` to opt out in Auto, or use `mode: "observe"` to report the proven anchor without changing selection. `/bifrost inspect` and `/bifrost preview --trace` show the effective mode and whether it comes from the Auto default, physical default, or config. Init keeps writing the existing version-1 config shape and does not add the affinity namespace.

In Pi, Bifrost creates the anchor only from a proven successful Auto user turn and keeps it in memory for the session; with reliability state version 2, it reuses the receipt's branch and assistant-entry proof. The mode source is `auto_default` when the Auto-only default applies and `config` when an explicit namespace sets it. Physical routing with no namespace reports `physical_default` and does not retain the Auto anchor. If no anchor is available, the summary reports `locality_unknown`. `providerAdvisory: true` adds only whether the pool contains a candidate from the anchor provider.

The final selection pool is formed after hard reserve and circuit exclusions and any policy-mode billing preference. A nonpreferred model can remain healthy and hard-eligible while being outside the selection pool, so it will not be restored by affinity retention. The structured route summary keeps billing-preference evidence separate from reserve or circuit exclusions, and leaves nonpreferred candidates marked eligible. Retention does not cross tiers, restore a hard-excluded model, or replace an explicit tier/model choice. In Auto routing, direct, continuation, and retry outcomes do not retain the anchor. Physical routing is blocked before provider activity when retention mode is enabled unless manual pin/off controls already bypass routing; use `observe` for physical routing. Continuations and retries keep Pi's established model. Neither mode claims cache reuse or savings.

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
4. the optional direct classifier (`typesafe` or `pi-native`);
5. the optional prompt classifier;
6. other regex rules;
7. the configured default tier.

First matching step wins; later steps are skipped. A rule naming an exact model wins before the cache and classifiers; a rule naming a tier is checked after them. Reliability filtering and strategy selection happen after a tier is resolved.

Set optional `classifier.totalTimeoutMs` to bound all external classifier work for one request. It accepts an integer from `1` to `60000`; when the budget expires, Bifrost stops classifier calls and continues with local regex/default routing. Caller cancellation stops routing. When omitted, existing backend timeout and retry settings remain in effect. See the [classifier guide](classifiers.md#prompt-classifier) for details.

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
