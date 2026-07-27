# Bifrost

Automatic model routing for [pi](https://pi.dev). Routes each prompt to a model based on task complexity, price, speed, or context length.

**Why Bifrost over other model routers:**

- **Probe-first init** — tests every model before writing config. No dead providers in your tier lists.
- **Zero-token routing** — 7 selection strategies, all metadata-based. Routing decisions cost nothing.
- **Production observability** — Performance API traces, JSONL debug logs. AI-parseable.
- **Direct bindings** — assign specific models to specific prompts via regex rules or inline tier name prefix.

## Install

```bash
pi install npm:pi-bifrost
```

Or from source:

```bash
pi install git:github.com/iamaamir/pi-bifrost
```

## Setup

Run this once:

```
/bifrost init
```

It probes every model you have access to, finds the ones that actually work, and writes a config. Say yes when asked.

Done. Bifrost is now routing your prompts.

## What it does

You type a prompt. Bifrost classifies it as `frontier` (hard) or `economical` (easy), picks the best available model for that tier, and switches pi's model before the prompt is sent. You just type — the model changes behind the scenes.

If a model fails repeatedly (probe timeout, auth error, provider stream failure), Bifrost opens a circuit breaker and routes around it until a cooldown period expires or a probe confirms it's healthy again. The dashboard shows open-circuit count in its title.

If you manually switch models with `/model`, Bifrost pins itself and stops routing. `/bifrost unpin` to resume.

## Commands

| Command | What it does |
|---------|-------------|
| `/bifrost` | Open mode/model dashboard and quick actions |
| `/bifrost init` | Probe models and generate config |
| `/bifrost probe` | Test which models actually respond |
| `/bifrost preview <prompt>` | See what would happen without sending |
| `/bifrost on` / `off` | Enable / disable routing |
| `/bifrost pin` / `unpin` | Lock current model / resume routing |
| `/bifrost reload` | Reload config after editing |
| `/bifrost cache stats` | Show classification cache |
| `/bifrost cache clear` | Clear classification cache |
| `/bifrost classifier status` | Show classifier state |

## UI smoke test

Run `npm run test:ui` to capture Pi TUI screenshots for startup, dashboard, preview, disabled, classify, and pinned states. Output lands in `screenshots/ui-smoke/`.

UI backlog and priorities: [`docs/ui-enhancements.md`](docs/ui-enhancements.md).

## Config

Everything lives in `.pi/bifrost.json`. Editor autocomplete works in VS Code, Zed, Cursor.

### Tiers and models

The default config ships with three tiers. Run `/bifrost init` to populate them from your Pi registry, or edit the arrays manually.

```json
{
  "models": {
    "quick": [
      "opencode/deepseek-v4-flash-free",
      "opencode/mimo-v2.5-free"
    ],
    "general": [
      "opencode-go/deepseek-v4-pro",
      "opencode-go/glm-5.2",
      "openai-codex/gpt-5.4-mini"
    ],
    "frontier": [
      "openai-codex/gpt-5.6-sol",
      "opencode-go/glm-5.2",
      "opencode-go/deepseek-v4-pro"
    ]
  }
}
```

Each tier has a list of model patterns. `provider/id` for exact, or just `qwen` for substring match.

### Strategies

How Bifrost picks from the list. Set globally or per-tier:

| Strategy | Picks |
|----------|-------|
| `cheapest` | Lowest cost (input + output) |
| `cheapest_input` | Lowest input cost |
| `cheapest_output` | Lowest output cost |
| `largest_context` | Biggest context window |
| `random` | Random pick |
| `first` / `fastest` | First in list (init sorts by speed) |

```json
{
  "strategy": "first",
  "categoryStrategies": {
    "quick": "random",
    "general": "first",
    "frontier": "first"
  }
}
```

### Routing rules

Regex patterns that map prompts to tiers. First match wins. Case insensitive.

```json
{
  "rules": [
    {
      "pattern": "(^|\\s)\\/?commit(?:\\s|$)|\\b(commit message|conventional commit)\\b",
      "model": "quick"
    },
    {
      "pattern": "(^|\\s)\\/?format(?:\\s|$)|\\b(format this json|format this code)\\b",
      "model": "quick"
    },
    {
      "pattern": "(^|\\s)\\/?test(?:\\s|$)|\\b(unit tests?|integration tests?|e2e tests?)\\b",
      "model": "general"
    },
    {
      "pattern": "(^|\\s)\\/?debug(?:\\s|$)|\\b(stack trace|crash|memory leak|flaky test)\\b",
      "model": "frontier"
    },
    {
      "pattern": "(^|\\s)\\/?arch(?:\\s|$)|\\b(system architecture|api design|migration strategy)\\b",
      "model": "frontier"
    },
    {
      "pattern": "\\b(review this code|code review|audit this code)\\b",
      "model": "frontier"
    }
  ]
}
```

Rules can also live in a separate `.pi/bifrost-routes.json` file — it overrides inline rules.

### Direct model bindings

Instead of a tier name, use a model reference (`provider/id`) — the matched prompt routes directly to that exact model, bypassing tier selection entirely.

```json
{
  "rules": [
    {
      "pattern": "\\bcommit\\b",
      "model": "opencode-go/glm-5.1"
    },
    {
      "pattern": "\\btest\\b",
      "model": "opencode/deepseek-v4-flash-free"
    }
  ]
}
```

Useful for `/commit`, `/test`, `/explain` — any pattern where you want a specific model every time. The value must contain `/` to be treated as a direct reference.

### Inline override

Type a tier name as the first word to force that tier for one message. No config change needed.

```
frontier debug this race condition
economical summarize this
frontier implement the auth module
```

The tier name is stripped before routing — the rest goes to your prompt clean.

### Classifier

An LLM that reads your prompt and picks a tier. More accurate than regex, costs a few tokens. Uses a cheap model — you configure which one.

```json
{
  "classifier": {
    "enabled": true,
    "model": "opencode/mimo-v2.5-free"
  }
}
```

If the classifier fails or is disabled, regex rules take over. Both paths cache results so repeat prompts skip the check entirely.

### Debug logging

```json
{
  "debug": { "enabled": true }
}
```

Writes `.pi/bifrost-debug.jsonl` — one JSON line per event. Timings, tiers, decisions. Useful for understanding what Bifrost is doing.

### Full config reference

```json
{
  "$schema": "../pi-bifrost/schema.json",
  "enabled": true,
  "default": "economical",
  "strategy": "first",
  "categoryStrategies": { "economical": "cheapest" },
  "models": { ... },
  "rules": [ ... ],
  "classifier": {
    "enabled": true,
    "model": "...",
    "method": "auto",
    "maxTokens": 20,
    "temperature": 0,
    "fallbackToRegex": true,
    "systemPrompt": "..."
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
  },
  "debug": { "enabled": false }
}
```

### Reliability: circuit breaker for flaky models

Tracks model health across probe results and runtime failures. Models that fail repeatedly are temporarily skipped (circuit open) and Bifrost falls back to the default tier.

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

**How it works:**
- Records failures from probe timeouts, `setModel` auth errors, and provider stream errors
- Opens circuit after `failureThreshold` failures within `windowMinutes`
- Open-circuit models are excluded from routing; Bifrost falls back to default tier
- Circuit closes automatically after `cooldownMinutes` — next request attempts a trial
- Successful trial closes the circuit; repeated failure doubles cooldown
- State persists in `.pi/bifrost-reliability.json`
- Disabled reliability (`"enabled": false`) is a clean no-op — no tracking, no persistence

The dashboard shows open-circuit count in the title. `/bifrost preview` and `/bifrost debug` display skipped candidates with remaining cooldown.

See [`examples/economical-frontier-reliability.json`](examples/economical-frontier-reliability.json) for a complete config.

Every field is optional. Config merges from: extension default → global (`~/.pi/agent/bifrost.json`) → project (`.pi/bifrost.json`).
