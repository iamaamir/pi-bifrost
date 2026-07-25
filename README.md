# Bifrost

Automatic model routing for [pi](https://pi.dev). Reads your prompt, picks the right model, switches automatically.

**Why Bifrost over other model routers:**

- **Probe-first init** — tests every model before writing config. No dead providers in your tier lists.
- **Zero-token routing** — 7 selection strategies, all metadata-based. Routing decisions cost nothing.
- **Production observability** — Performance API traces, JSONL debug logs. AI-parseable.
- **Direct bindings** — assign specific models to specific prompts via regex rules or inline `!<tier>` prefix.

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

If you manually switch models with `/model`, Bifrost pins itself and stops routing. `/bifrost unpin` to resume.

## Commands

| Command | What it does |
|---------|-------------|
| `/bifrost` | Show current status |
| `/bifrost init` | Probe models and generate config |
| `/bifrost probe` | Test which models actually respond |
| `/bifrost preview <prompt>` | See what would happen without sending |
| `/bifrost on` / `off` | Enable / disable routing |
| `/bifrost pin` / `unpin` | Lock current model / resume routing |
| `/bifrost reload` | Reload config after editing |
| `/bifrost cache stats` | Show classification cache |
| `/bifrost cache clear` | Clear classification cache |
| `/bifrost classifier status` | Show classifier state |

## Config

Everything lives in `.pi/bifrost.json`. Editor autocomplete works in VS Code, Zed, Cursor.

### Tiers and models

```json
{
  "models": {
    "economical": [
      "opencode/deepseek-v4-flash-free",
      "lmstudio/openai/gpt-oss-20b"
    ],
    "frontier": [
      "opencode-go/glm-5.1",
      "opencode-go/grok-4.5"
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
    "economical": "cheapest"
  }
}
```

### Routing rules

Regex patterns that map prompts to tiers. First match wins. Case insensitive.

```json
{
  "rules": [
    {
      "pattern": "\\b(debug|fix|implement|refactor|architect)\\b",
      "model": "frontier"
    },
    {
      "pattern": "\\b(explain|summarize|format|hello)\\b",
      "model": "economical"
    }
  ]
}
```

### Routing rules

Regex patterns that map prompts to tiers. First match wins. Case insensitive.

```json
{
  "rules": [
    {
      "pattern": "\\b(debug|fix|implement|refactor|architect)\\b",
      "model": "frontier"
    },
    {
      "pattern": "\\b(explain|summarize|format|hello)\\b",
      "model": "economical"
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

Prefix a prompt with `!<tier>` to force a specific tier for that one message. No config change needed.

```
!frontier debug this race condition
!economical summarize this
!frontier implement the auth module
```

The tier must match a key in your `models` config. The prefix is stripped before routing so the prompt is classified and sent without the `!` marker.

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
  "debug": { "enabled": false }
}
```

Every field is optional. Config merges from: extension default → global (`~/.pi/agent/bifrost.json`) → project (`.pi/bifrost.json`).
