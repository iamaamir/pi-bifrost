# Bifrost configuration reference

Field-level facts for composing a candidate. Bifrost validates every candidate
with the same rules `/bifrost validate` uses: a candidate that breaks them comes
back as `status: "rejected"` with the error text.

## Layers and precedence

Layers merge lowest to highest. Later layers override scalar fields and merge map
fields (`models`, `categoryStrategies`, `tierPolicies`, `classifier`, `cache`,
`reliability`, `probe`, `debug`).

| Layer | Path | Writable |
| --- | --- | --- |
| extension | bundled `bifrost.json` in the extension directory | no (ships defaults) |
| user | `~/.pi/agent/bifrost.json` (`$PI_CODING_AGENT_DIR`) | yes (`source: "user"`) |
| workspace | `<cwd>/bifrost.json` | yes (`source: "workspace"`) |
| project | `<cwd>/.pi/bifrost.json` | yes (`source: "project"`, default) |

The bundled extension layer contributes `default: "general"`,
`strategy: "first"`, `categoryStrategies: { quick: random, general: first, frontier: first }`,
`models: { quick: [], general: [], frontier: [] }`, the default `rules`, and the
public cache/reliability/classifier defaults. Empty pools are valid.

A `.pi/bifrost-routes.json` or `./bifrost-routes.json` file replaces `config.rules`
while it exists; the first file found wins.

## Top-level fields

| Field | Values | Notes |
| --- | --- | --- |
| `schemaVersion` | `1`, `2` | v2 is required for `tierPolicies`, `economics`, and `affinity` |
| `enabled` | boolean | Bifrost off means no automatic switching |
| `default` | tier name | must exist in the merged `models` |
| `strategy` | strategy name | global fallback strategy |
| `categoryStrategies` | `{ tier: strategy }` | every key must exist in the merged `models` |
| `models` | `{ tier: "provider/id" \| ["provider/id", ...] }` | ordered pool; a bare string is also a fuzzy match on id/provider |
| `rules` | `[{ pattern, model }]` | first matching pattern wins; `model` is a tier name or a `provider/id` |
| `tierPolicies` | `{ tier: { fallbackTiers: [...] } }` | schemaVersion 2; `[]` is terminal |
| `classifier` | see below | enabled by default in the bundled config |
| `cache`, `debug`, `probe`, `reliability` | see below | operational, not routing shape |

Strategies: `first` (pool order), `cheapest` (input+output per 1M), `cheapest_input`,
`cheapest_output`, `largest_context`, `random`, `fastest`.

## Rules and inline tier prefixes

- The first word of a prompt that matches a tier name (case-insensitive) forces
  that tier for that turn and is stripped from the prompt: `frontier debug this`.
- Regex rules run when no tier prefix matches. A direct `provider/id` value in a
  rule bypasses tier selection entirely.
- Rules that reference a tier must reference a tier that exists in the merged
  `models`.

## Tiers and fallback boundaries

- A pool entry with `/` is an exact `provider/id`; it must match a model in the
  Pi catalog. An entry without `/` is a case-insensitive substring match on model
  id or provider, so `gpt` can match several models.
- A tier resolves its pool through its own strategy, then a fallback pool (the
  `default` tier, unless `tierPolicies` says otherwise).
- `tierPolicies[tier].fallbackTiers` replaces the default fallback with an
  ordered list of tiers. An empty list is terminal: nothing is selected rather
  than escalating to another model.
- Tiers without a `tierPolicies` entry keep the legacy behavior of falling back
  to the `default` tier.
- Unavailable models (no auth, catalog miss) are skipped; reliability circuits
  and provider pauses can also exclude candidates.

## Classifier

| Field | Values | Notes |
| --- | --- | --- |
| `enabled` | boolean | `false` makes routing deterministic from rules and the default tier only |
| `backend` | `prompt`, `typesafe`, `pi-native` | `typesafe`/`pi-native` are direct transports and reject `endpoint`, `method`, `systemPrompt`, `maxTokens`, `temperature`, `fallbackToRegex` |
| `model` | `provider/id` or list | prompt-classifier model, resolved from the catalog |
| `criteria` | `{ tier: "what it is for" \| { what, notFor, examples } }` | required for every tier when a direct backend is used, unless the tier is one of the three defaults with bundled criteria |
| `totalTimeoutMs` | 1..60000 | total classifier budget per prompt |
| `minConfidence` | 0..1 | direct backends only |
| `fallback` | `prompt`, `regex` | direct backends only |

The bundled criteria cover `quick`, `general`, and `frontier`. Custom tiers with a
direct classifier backend need their own criteria, otherwise validation fails with
`criteria missing for tier "<name>"`.

With the classifier disabled, a prompt that matches no rule takes the `default`
tier. That is deterministic and needs no model call.

## Affinity

`affinity.mode`: `off`, `observe`, or `retain-within-tier`. Requires schemaVersion 2.
Pi Auto defaults to retaining a proven successful model, but retention stays
inside the tier that resolved last, is a preference over eligible candidates, and
does not cross tiers or override hard exclusions. Physical routing and the
resolve-only API stay off unless configured. Bifrost does not manage provider
prompt caches.

## Reliability

`reliability.enabled` (default true), `failureThreshold`, `windowMinutes`,
`cooldownMinutes`, `cooldownOnAllowanceExhausted`, `allowanceCooldownScope`
(`provider` default, `model`), `retryOnAllowanceExhausted`, `stateVersion`
(`1` default, `2`), `observations.enabled`, `path`.

- Circuits are persisted and recover through controlled half-open trials.
- Usage and billing rejections pause models for the same Pi provider by default.
  Generic 429 pauses are provider-scoped. Shared billing accounts are not
  identified.
- `stateVersion: 2` needs its own migration and only covers supported Auto turns;
  physical routing still uses v1. Do not switch it as part of a routing goal
  unless the user asks.
- `retryOnAllowanceExhausted` is the one narrow failover case (ADR 0023) and only
  applies when Pi proves the failed attempt was empty.

## Economics (advisory)

`economics.mode` (`observe` or `policy`), `scopes`, `sources` (`authority`:
`declared` or `estimated`; `authoritative` is rejected), `sourceOrder`, `admission`
(reserve rules), `preference.billingClass` (`subscription`, `metered`, `free`),
`tierOverrides`, `observations` (static declared facts, max 64).

Facts are snapshots. Bifrost does not fetch live quota, does not infer billing
state, and enforces no spending cap. Admission rules require `mode: "policy"` and
at least one rule, or an explicit billing preference.

## Worked examples

Three-role coding workflow (custom roles, no classifier calls, no silent escalation):

```json
{
  "schemaVersion": 2,
  "default": "implement",
  "models": {
    "orchestrator": ["provider/strong-reasoner"],
    "implement": ["provider/cheap-coder"],
    "review": ["provider/reviewer"]
  },
  "categoryStrategies": { "orchestrator": "first", "implement": "cheapest", "review": "first" },
  "classifier": { "enabled": false },
  "rules": [{ "pattern": "\\breview\\b", "model": "review" }],
  "tierPolicies": {
    "orchestrator": { "fallbackTiers": [] },
    "review": { "fallbackTiers": [] },
    "implement": { "fallbackTiers": ["review"] }
  }
}
```

Budget-first with a quality escape hatch:

```json
{
  "schemaVersion": 2,
  "default": "work",
  "strategy": "cheapest",
  "models": {
    "work": ["provider/cheap-coder", "provider/free-coder"],
    "hard": ["provider/strong-reasoner"]
  },
  "categoryStrategies": { "work": "cheapest", "hard": "first" },
  "rules": [{ "pattern": "\\b(architecture|race condition|security audit)\\b", "model": "hard" }],
  "tierPolicies": { "work": { "fallbackTiers": [] }, "hard": { "fallbackTiers": [] } }
}
```

Both examples still inherit the bundled `quick`, `general`, and `frontier` tiers
with empty pools, which is expected.

## Limitations to state honestly

- No spend cap, no live quota, no billing inference.
- No guaranteed savings; per-token price does not predict cost per successful task.
- No provider prompt-cache management or cache-hit promises.
- Routing configuration does not orchestrate child agents. A Pi subagent must
  load Bifrost and use a Bifrost-selected model for Bifrost to influence it.
- Another extension that pins a model explicitly is not controlled by Bifrost.
- Preview evaluates configuration, not results: it never sends a prompt.
- Reliability v2, allowance recovery, and Auto affinity have the specific limits
  listed above; never present them as general guarantees.
