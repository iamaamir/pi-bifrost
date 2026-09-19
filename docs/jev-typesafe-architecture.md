# TypeSafe/Jev Classifier Architecture

Status: implemented, opt-in backend

This document explains how Bifrost uses TypeSafe/Jev, why the boundaries exist, and which operational traps matter.

## Executive summary

Jev does not select an exact provider/model. It makes one typed semantic judgment: which configured Bifrost tier best fits the current coding-agent request.

```text
Pi user prompt
  → Bifrost pre-generation hook
  → bypass / inline override / cache
  → TypeSafe/Jev Choice judgment
  → confidence and response validation
  → configured fallback when needed
  → Bifrost availability, reliability, and model strategy
  → Pi activates actual provider/model
  → prompt generation
```

Core separation:

```text
Jev:      semantic suitability judgment
Bifrost:  policy, fallback, model availability, reliability, selection
Pi:       host model activation and generation
```

## Why Jev chooses tier, not exact model

Bifrost owns model policy. Users configure model candidates under tiers such as `quick`, `general`, and `frontier`; Bifrost then applies configured strategy (`first`, `random`, `cheapest`, `largest_context`, and so on).

Keeping Jev at tier level means:

- user model lists remain authoritative;
- Jev does not need a current provider catalog;
- unavailable or circuit-open models are filtered locally;
- selection strategy remains deterministic and inspectable;
- changing model lists does not require changing the classifier prompt;
- provider/model identifiers are not unnecessarily sent to a hosted classifier.

Jev probabilities describe confidence in tier suitability, not comparative quality between individual models.

## End-to-end flow

### 1. Pi hook receives prompt

Bifrost runs before generation and first checks:

- routing enabled;
- pinned-model state;
- inline tier override;
- configured tiers;
- cache.

Pinned or disabled routing intentionally bypasses classification. This prevents Bifrost from changing a user-selected model.

### 2. Cache lookup

A cache hit returns a previously classified tier without a Jev call. Cache keys include classifier semantics, tier set, criteria, backend, model, confidence policy, and trust/credential availability where relevant.

The cache stores normalized prompt text and is therefore potentially sensitive. It is local, bounded, expiring, and can be disabled or cleared.

### 3. TypeSafe request

For a cache miss, Bifrost sends the current prompt and configured tier criteria to the official endpoint:

```text
POST https://api.typesafe.ai/v1/systemone
model: jev-1.13.0
```

Conceptual payload:

```json
{
  "state": "current coding-agent prompt",
  "model": "jev-1.13.0",
  "questions": {
    "tier": {
      "type": "choice",
      "instructions": "Which model tier best fits this coding-agent request? Judge task complexity and consequence, not stated preference or price.",
      "criteria": {
        "quick": "bounded, reversible, obvious work",
        "general": "normal implementation and moderate reasoning",
        "frontier": "complex debugging, architecture, security, or high consequence"
      }
    }
  }
}
```

The criteria are contrastive. Tier names alone are insufficient because names such as `quick` or `frontier` are user-defined labels, not reliable semantic definitions.

### 4. Response validation

Bifrost accepts only a strict Choice response:

- pinned model is exactly `jev-1.13.0`;
- selected tier exists in current configured tiers;
- probabilities contain exactly current tiers;
- all probabilities are finite and in `[0, 1]`;
- probabilities sum to approximately `1`;
- selected choice has maximum probability;
- confidence is finite and in `[0, 1]`;
- confidence meets `minConfidence` (default `0.80`).

Invalid or uncertain results are classifier misses, not routing errors.

### 5. Fallback

Default TypeSafe fallback is the existing prompt classifier, then regex/default:

```text
Jev
  → configured prompt classifier
  → regex rules
  → default tier
```

With `fallback: "regex"`:

```text
Jev
  → regex rules
  → default tier
```

Fallback never replays the user turn. It only attempts classification alternatives before generation.

### 6. Actual model selection

Once a tier is known, Bifrost:

1. resolves configured candidates;
2. excludes unavailable candidates;
3. excludes open reliability circuits;
4. applies tier/global strategy;
5. calls Pi's model switch;
6. lets Pi generate using the actual selected model.

Jev does not bypass user model policy.

## Failure behavior

TypeSafe failures degrade safely:

| Condition | Behavior |
|---|---|
| Missing credential | record `missing_key`, use fallback |
| `401`/`403` | record `auth`, use fallback |
| `429`/`529` | bounded retry, then fallback |
| Other HTTP failure | record `http`, use fallback |
| Network failure | bounded retry, then fallback |
| Timeout | stop within total deadline, use fallback |
| Invalid JSON/shape | record `invalid_response`, use fallback |
| Low confidence | reject judgment, use fallback |
| Open circuit | skip request, use fallback |
| Abort | stop request, do not replay, use fallback |

Retries apply only to the classifier HTTP call and are bounded by one total deadline. They never replay the user's Pi turn or tool activity.

Repeated failures persist in Bifrost reliability state. After threshold, the TypeSafe circuit opens. After cooldown, one controlled half-open trial tests recovery.

## Credentials and permission

Credential lookup order:

```text
~/.pi/agent/auth.json entry "typesafe"
  → TYPESAFE_API_KEY
  → missing
```

Recommended Pi auth entry:

```json
{
  "typesafe": {
    "type": "api_key",
    "key": "ts_..."
  }
}
```

Environment alternative:

```bash
export TYPESAFE_API_KEY="ts_..."
```

Keys never belong in project config.

Selecting TypeSafe through `/bifrost classifier` is the explicit user opt-in. It writes the backend choice to project config; credentials remain user-managed and are never stored in project config.

## Configuration

Minimal active setup:

```json
{
  "classifier": {
    "enabled": true,
    "backend": "typesafe",
    "fallback": "prompt",
    "typesafe": {
      "model": "jev-1.13.0"
    },
    "criteria": {
      "quick": "Bounded, reversible, obvious work",
      "general": "Normal implementation and moderate reasoning",
      "frontier": "Complex, ambiguous, or high-consequence work"
    }
  }
}
```

Canonical `quick`, `general`, and `frontier` criteria are supplied by Bifrost when omitted. Custom tier names require explicit criteria.

Prompt-backend fields are incompatible with TypeSafe and must not be used for active TypeSafe configuration:

- `endpoint` at classifier level;
- `method`;
- `systemPrompt`;
- `maxTokens`;
- `temperature`;
- `fallbackToRegex`.

TypeSafe uses its fixed official endpoint and nested `typesafe` transport settings.

## Commands and observability

```text
/bifrost classifier
```

Interactive backend selection. TypeSafe selection enables Jev and checks credential availability.

```text
/bifrost classifier test
```

Runs one fresh classifier pipeline smoke test with a nonce to avoid cache reuse. It reports backend, final result, source, whether a request was observed, credential source, and TypeSafe outcome.

```text
/bifrost classifier status
```

Shows enabled state, backend, model, credential source, and content-free aggregate metrics. It never prints credentials.

```text
/bifrost debug
```

Shows broader Bifrost state.

## Full TypeSafe trace

Normal global debug:

```json
{ "debug": { "enabled": true } }
```

Detailed TypeSafe trace requires both flags:

```json
{
  "debug": { "enabled": true },
  "classifier": {
    "backend": "typesafe",
    "typesafe": { "debug": true }
  }
}
```

Trace file:

```text
.pi/bifrost-debug.jsonl
```

TypeSafe events include:

```text
start
credential_missing
circuit_open
attempt
request
transport_error
response
body
decoded
low_confidence
http_failure
retry_wait
decode_error
success
failure
finish
```

Trace includes correlation ID, attempt, endpoint, status, decoded tier, confidence, probabilities, retry/failure outcome, and timing. Detailed debug intentionally includes prompt/response classification data for troubleshooting. It must remain off during normal use if that data is sensitive.

API keys and authorization headers are never logged.

## Operational traps

### `source: regex` does not mean Jev was skipped

If test output says:

```text
request observed: yes
outcome: low_confidence
source: regex
```

Jev was called and returned a judgment, but Bifrost rejected it below the confidence gate and used regex.

### `result` may be final fallback, not Jev's answer

Use the TypeSafe `decoded` trace event to see Jev's actual tier. The classifier test reports final pipeline result separately.

### Debug is two-level

`typesafe.debug: true` alone produces no file events. Global `debug.enabled` must also be true.

### Cache can hide calls

A normal prompt may return from cache. Use `/bifrost cache clear` or `/bifrost classifier test`, which adds a nonce.

### Rules can hide calls

Direct rules and inline overrides happen before classifier. Use a novel prompt without obvious `debug`, `test`, `format`, `commit`, `review`, or architecture keywords when testing normal routing.

### Pinning can hide routing

Pinned or disabled Bifrost intentionally does not classify or switch models. Unpin before testing normal pre-generation routing.

### Low confidence is not an API failure

It means Jev returned structurally valid data but uncertainty exceeded policy threshold. It follows fallback policy deliberately.

### Config can be malformed

User/global and project configs are separate. A malformed config layer can prevent TypeSafe settings from loading even when project status appears to show TypeSafe. Validate relevant JSON files before diagnosing classifier behavior.

### Installed extension may differ from source checkout

Testing a local checkout does not prove the currently installed Pi package contains latest changes. Confirm extension path/version when debugging behavior.

## Design guardrails

- TypeSafe is explicit opt-in; default backend remains prompt.
- Model-agnostic defaults remain intact.
- Bifrost never automatically replays a failed user turn.
- Hosted classification is visible, disableable, and fallback-safe.
- User overrides, pins, rules, and model strategies remain authoritative.
- Metrics are content-free by default.
- Detailed traces require deliberate dual opt-in.
- Exact model selection remains Bifrost policy, not hosted classifier policy.
