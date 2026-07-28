# 0012 — Normalised failure taxonomy

## Status

**Proposed** (2026-07-28). Pending review. Do **not** implement until the design is accepted and the implementation gate is green.

## Context

Bifrost records runtime failure after the Pi turn settles. ReliabilityStore entries contain a `reason: string` (free text from the error or event) and drive circuit state (`closed` / `half-open` / `open`) via failure threshold and cooldown. This works for basic circuit breaking, but several gaps have emerged:

1. **No targeted repair guidance.** A quota error and a transient network error are both recorded as `reason: "provider returned 429"` and `reason: "socket hang up"`. The user sees "model X is unavailable" in the dashboard — they cannot distinguish "re-auth your provider" from "try again in a minute" from "this model name doesn't exist in your registry."

2. **Uniform cooldown is wrong for different failure types.** Quota errors require longer cooldowns (providers enforce minute-level or hour-level rate windows). Transient network errors may resolve in seconds. Auth failures require user action before any retry is useful. Currently all failures use the same `failureThreshold` and `cooldownMinutes`.

3. **Selection policy cannot be failure-type-aware.** Future improvements — skip a model that hit quota, prefer models with no auth failures, avoid a model that returned `not_found` — require a category, not just a text reason.

4. **Competitive precedent.** Autopilot distinguishes `transient` from `quota` backoff (5 min vs 60 min). The competitive analysis (§4.2) ranks failure taxonomy as Priority 0 — alongside decision traces and config linter.

5. **Decision trace enrichment.** ADR 0007 proposes a structured trace. Failure category should appear in that trace so the user sees "model X excluded: circuit open (quota, retry at 14:32)" rather than "model X excluded: circuit open."

## Decision

### 1. Category set

Nine categories, defined by what the user or system should do about them:

| Category | Meaning | Recovery hint | Default cooldown multiplier |
|---|---|---|---|
| `quota` | Billing limit, provider quota exhausted, or spend cap hit | "Re-auth provider or wait for quota reset" | 3× base cooldown |
| `rate_limit` | 429 or provider rate-limit signal (distinct from billing quota) | "Brief backoff; automatic retry" | 0.5× base cooldown |
| `auth` | Authentication failure, expired key, invalid token, unauthorised provider | "Check provider credentials" | No auto-retry (user must act) |
| `not_found` | Model ID or provider does not exist in registry; config refers to unknown model | "Update config or re-run /bifrost init" | No auto-retry (config must be fixed) |
| `set_model_failed` | pi's `setModel` rejected the model (e.g. not available in this session context) | "Model not selectable; check provider availability" | 1× base cooldown |
| `transport` | Network error, DNS failure, connection refused, socket timeout before response | "Transient; retry" | 0.5× base cooldown |
| `stream_error` | Stream terminated mid-response after partial output was received | "Partial output may exist; inspect before retry" | 1× base cooldown |
| `timeout` | LLM did not respond within the expected time window | "Model may be overloaded; try alternative" | 1.5× base cooldown |
| `unknown` | Unrecognised error pattern; preserve raw text | "Check logs for details" | 1× base cooldown |

Cooldown multipliers are defaults, overridable per-category in config:

```jsonc
{
  "reliability": {
    "enabled": true,
    "failureThreshold": 2,
    "windowMinutes": 5,
    "cooldownMinutes": 30,
    "cooldownMultipliers": {
      "quota": 3,
      "rate_limit": 0.5,
      "auth": -1,        // -1 = never auto-retry
      "not_found": -1,
      "transport": 0.5,
      "stream_error": 1,
      "timeout": 1.5,
      "set_model_failed": 1,
      "unknown": 1
    }
  }
}
```

### 2. Data model

The category is **additive** — it augments the raw error, never replaces it:

```ts
interface ReliabilityEvent {
  model: string;
  timestamp: string;
  reason: string;          // raw error text — unchanged
  category: FailureCategory;  // new — normalised
  recoveryHint?: string;   // derived from category, overridable in config
}
```

Changes to existing structures:
- `ReliabilityStore` records gain an optional `category` field (absent for pre-migration records → treated as `unknown`).
- `CircuitState` gains an optional `lastCategory: FailureCategory` for trace display.
- The `reason` field is preserved verbatim. No existing call site changes.

### 3. Normaliser design

A pattern-based normaliser maps raw error text to category:

```
raw error text
  ↓
normalise(errorText): { category, recoveryHint }
  ├─ pattern match (regex list, checked in order)
  │   ├─ /quota|insufficient_quota|exceeded.*limit|billing/i  →  quota
  │   ├─ /429|rate.limit|too many requests/i                   →  rate_limit
  │   ├─ /unauthorized|unauthorised|invalid.*key|auth/i        →  auth
  │   ├─ /not found|model.*not.*found|no such model/i          →  not_found
  │   ├─ /setModel|model.*select/i                             →  set_model_failed
  │   ├─ /econnrefused|enotfound|network|dns|socket/i          →  transport
  │   ├─ /stream.*(error|interrupt|end)|incomplete.*response/i →  stream_error
  │   ├─ /timeout|timed out|took too long/i                    →  timeout
  │   └─ no match                                              →  unknown
  ↓
  ReliabilityEvent
```

The pattern list is **configurable** — users can add provider-specific patterns:

```jsonc
{
  "reliability": {
    "failurePatterns": [
      { "pattern": "openai.*quota", "category": "quota" },
      { "pattern": "anthropic.*overloaded", "category": "rate_limit" }
    ]
  }
}
```

Built-in patterns match against the concatenated `reason` text. User patterns extend (not replace) the built-in list and are checked first.

### 4. Integration points

**ReliabilityStore** — `recordFailure(model, reason)` now takes an optional `category` parameter. When absent, the normaliser runs on `reason` to derive it. The category is persisted alongside the raw reason.

**Circuit breaker** — `cooldownMinutes` is multiplied by the category's cooldown multiplier. A `quota` failure with base cooldown 30 min → 90 min. A `rate_limit` failure → 15 min. `auth` and `not_found` set cooldown to `Infinity` (no auto-retry). The multiplier is evaluated when the circuit transitions to `open`, using the **last** recorded category for that model. If no category exists (migration gap), multiplier is 1×.

**Decision trace** (ADR 0007) — the trace records each candidate's exclusion reason including circuit state AND last known category:

```jsonc
{
  "candidates": [
    { "model": "claude-opus-4", "eligible": false, "reason": "circuit_open",
      "lastCategory": "quota", "retryAt": "2026-07-28T14:32:00Z" }
  ]
}
```

**Dashboard / debug** — `recoveryHint` appears next to circuit-open models: "model X: circuit open (quota — re-auth provider or wait for reset, retry at 14:32)".

**Selection policy (future)** — categories become selection signals. A `cheapest` strategy could deprioritise models with recent `quota` or `auth` failures. This is explicitly deferred until the scenario corpus (ADR 0011) validates the behaviour.

### 5. What NOT to do

- **Do not alter whether a failure opens a circuit based on category — yet.** The current threshold (`failureThreshold: 2` within `windowMinutes: 5`) remains the sole gate for opening a circuit. Category-aware circuit gating (e.g. "open circuit immediately on `auth`") is a future policy extension, not v1. Changing this without scenario coverage risks silent behaviour changes.

- **Do not add categories to the probe system.** Probes are intentional checks, not runtime failures. A probe that fails due to quota should still log the category for diagnostics, but probe failures must NOT open circuits or trigger cooldown. Probes observe availability; runtime failures observe production behaviour.

- **Do not make categories host-specific by default.** `set_model_failed` is the one host-specific category (pi's `setModel`). All other categories are provider-agnostic. The pattern system lets individual providers add custom patterns; the built-in set must not assume a specific provider's error format.

- **Do not retroactively categorise existing reliability state.** Records written before this ADR have no `category` field. The normaliser treats absent category as `unknown` with multiplier 1×. A future migration script could re-normalise, but that is not P0.

## Consequences

### Positive

- **Actionable recovery.** A user seeing "circuit open (quota, retry at 14:32)" knows what to do. "circuit open (auth)" tells them to check credentials.
- **Smarter cooldowns.** A 429 gets a shorter cooldown than a billing quota hit. Auth failures don't waste cooldown time — they require user intervention.
- **Trace enrichment.** Decision traces (ADR 0007) show why each candidate was excluded, including failure category. The user sees not just "open circuit" but "open circuit (quota)."
- **Configurable without code changes.** User-provided failure patterns let teams add provider-specific mappings without forking the normaliser.
- **Backward compatible.** New `category` field is optional in all persisted records. Old records are read as `unknown`.

### Negative

- **Pattern maintenance.** Provider error messages change. The built-in patterns may become stale. Mitigation: normaliser is a single module with documented patterns; PRs to update patterns are low-effort.
- **Category ambiguity.** Some errors could fit multiple categories (e.g. a 429 that is simultaneously a rate limit and a quota signal). The ordered-pattern-list design picks the first match, which is deterministic but may be wrong for edge cases. Mitigation: `unknown` exists for genuinely ambiguous errors; provider-specific patterns can disambiguate.
- **Cooldown multiplier complexity.** Users may not expect different cooldown durations per failure type. The default config keeps multipliers simple; users who want uniform cooldown can set all multipliers to 1.

### Migration

- No changes to existing reliability JSON files. Absent `category` → multiplier 1×, recovery hint "check logs."
- No changes to `schema.json` yet — `category` is internal to ReliabilityEvent. Schema update for `cooldownMultipliers` and `failurePatterns` config keys is a separate task.
- The normaliser is a pure function with no side effects, added as a new module. Existing `recordFailure` call sites are updated to pass the normalised category.
