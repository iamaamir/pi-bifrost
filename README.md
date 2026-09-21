# Pi-Bifrost

![Pi-Bifrost social card](docs/social-card.png)

Pi-Bifrost is a **configuration-first model-routing extension for [Pi](https://pi.dev)**, not an LLM gateway or proxy. You define model pools and per-tier selection strategies. Before generation, Bifrost resolves a configured tier, filters unhealthy candidates, applies your strategy, and activates Pi's actual provider/model. It applies your task-fit policy; it does not claim to discover a universally best model.

```text
"quick commit the changes"  → explicit quick tier → configured cheapest candidate
"debug this race condition" → adaptive frontier   → configured largest-context candidate
```

## Why Bifrost

- **User-owned model pools** — add or remove Pi models directly in config.
- **Per-tier strategies** — choose list order, cost, context window, probe-sorted speed, or explicit random selection.
- **Native activation** — Pi uses the selected provider/model for the turn; no proxy or virtual profile.
- **Persistent reliability** — repeated model failures survive restart and affect future routing.
- **No automatic replay** — Bifrost never silently repeats prompts that may have edited files or called tools.
- **Inspectable control** — preview a route, name a tier directly, pin an exact model, or disable routing.
- **Optional semantic classifiers** — prompt models and TypeSafe/Jev judge tiers; they never select the provider model.

## Install

Requires Pi `0.86.0` or newer and at least one configured, authenticated provider model visible in Pi.

```bash
pi install npm:pi-bifrost
```

Or from source:

```bash
pi install git:github.com/iamaamir/pi-bifrost
```

Inside Pi:

```text
/bifrost init
```

Initialization reuses probe results newer than one hour or probes every model available through Pi, then proposes tier pools and writes only after confirmation. The primary probe transport uses `1+1=` with at most 5 output tokens; empty responses may trigger a minimal-session fallback. Provider usage or rate limits may apply. See [Install and initialize](docs/guide/getting-started.md) before running init.

## How routing works

```text
prompt
  → pick a tier
  → configured model pool
  → reliability filtering
  → per-tier strategy
  → Pi's active provider/model
```

Bifrost picks a tier from a tier name at the start of the message, a rule that names an exact model, the local classification cache, an optional classifier, another regex rule, or your configured default. A rule that names an exact `provider/id` skips tiers and binds one model.

| Decision | Owner |
|----------|-------|
| Models allowed in each tier | Your config |
| Strategy used inside each tier | Your config |
| Tier that fits the prompt | Override, cache, classifier, rule, or default |
| Unhealthy candidates excluded | Bifrost reliability |
| Model that generates the turn | Pi, after Bifrost activates it |

## Routing controls

| What you do | What happens |
|-------------|--------------|
| Send a normal message with routing on and nothing pinned | Bifrost picks a configured model for that message |
| Start a message with a tier name, for example `quick commit the changes` | Bifrost uses that tier for that message only |
| Select a model in Pi, or run `/bifrost pin` | That exact model stays active for the rest of the session |
| Run `/bifrost unpin` | Bifrost goes back to picking a model per message |
| Run `/bifrost off` | Bifrost stops routing until you turn it on again |

A prefix is the configured tier name itself:

```text
quick commit the changes
frontier debug this race condition
```

Bifrost removes the tier name before the model sees the prompt, then uses that tier's model pool, reliability filter, and strategy. Custom tier names must currently be lowercase alphabetic single-word config keys. Pinned sessions ignore tier names in messages; a prefix does not override `/bifrost pin`.

## When not to use adaptive routing

Keep one exact model selected or run `/bifrost pin` when:

- a long session repeatedly builds on the same context;
- provider prompt-cache locality matters more than per-turn task fit;
- you already know which exact model you want;
- switching providers or models would disrupt latency, billing, or workflow expectations.

Adaptive routing may improve policy fit, but it does not guarantee better coding results, lower cost, lower latency, or provider cache savings. Every provider/model pair has an independent cache history. Use explicit tier names for deliberate one-turn routing, or pin for continuity.

## Minimal configuration

In `.pi/bifrost.json`:

```json
{
  "default": "general",
  "strategy": "first",
  "models": {
    "quick": ["provider/fast-model", "provider/backup-fast"],
    "general": ["provider/general-model"],
    "frontier": ["provider/frontier-model"]
  },
  "categoryStrategies": {
    "quick": "cheapest",
    "general": "first",
    "frontier": "largest_context"
  }
}
```

Tier arrays are eligibility boundaries. Strategies choose the exact healthy candidate after tier resolution. The built-in default uses `random` for `quick` and `first` for `general` and `frontier`, so `quick` can vary between messages until you set its strategy. `fastest` behaves as `first` over current list order, which init may sort using its one-time probe.

Config precedence, later wins:

1. extension default
2. `~/.pi/agent/bifrost.json`
3. project-root `bifrost.json`
4. `.pi/bifrost.json`

## Documentation

Detailed reference now lives in versioned guides committed with code:

- [Guide index](docs/guide/index.md)
- [Install and initialize](docs/guide/getting-started.md)
- [Adaptive, explicit-tier, and pinned controls](docs/guide/routing-controls.md)
- [Tier pools, strategies, rules, and direct bindings](docs/guide/configuration.md)
- [Provider prompt caching across A → B → A and N model switches](docs/guide/prompt-caching.md)
- [Reliability and Bifrost's local classification cache](docs/guide/reliability-and-cache.md)
- [Prompt and TypeSafe/Jev classifiers](docs/guide/classifiers.md)
- [Troubleshooting setup and routing](docs/guide/troubleshooting.md)
- [Command reference](docs/guide/commands.md)
- [Configuration examples](examples/README.md)

## Common commands

| Command | What it does |
|---------|--------------|
| `/bifrost` | Open dashboard and quick actions |
| `/bifrost init` | Probe models and propose configuration |
| `/bifrost probe` | Test model availability |
| `/bifrost preview <prompt>` | Show the model a prompt would use, without generating or activating it; a tier name in the prompt is not applied; an enabled classifier may receive the prompt |
| `/bifrost on` / `off` | Enable or disable routing policy |
| `/bifrost pin` / `unpin` | Hard-lock current model or resume routing |
| `/bifrost reload` | Reload merged configuration |
| `/bifrost cache stats` / `clear` | Inspect or clear local classification cache |
| `/bifrost classifier` | Choose classifier backend/model |
| `/bifrost classifier test` / `status` | Test or inspect classifier safely |
| `/bifrost providers` | List providers available through Pi |
| `/bifrost benchmark <prompt>` | Classify a prompt and show the outcome without generating |

See the [full command guide](docs/guide/commands.md).

## Reliability and cache behavior

Bifrost records probe, activation, and settled stream failures in `.pi/bifrost-reliability.json`. Repeated failures open a circuit, so future turns skip unhealthy candidates until cooldown and one controlled recovery trial. The failed user prompt is never replayed automatically.

Bifrost's local classification cache stores normalized prompt terms and selected tiers, not assistant answers. Provider prompt caches are separate. Treat every provider/model pair as an independent cache history: switching may fragment locality, and returning to a model may reuse its longest still-valid prefix while newer conversation content remains an uncached tail. `/bifrost pin` keeps one model stable when continuity matters more than per-turn routing. See [Provider prompt caching and model switching](docs/guide/prompt-caching.md).

Reliability circuits guard observed model health, not authoritative provider quota. Remove quota-sensitive models from broad adaptive tiers or isolate them behind deliberate policy.

## Optional TypeSafe/Jev classifier

TypeSafe/Jev is explicit opt-in. Jev returns one configured tier, probabilities, and confidence. Bifrost still owns model pools, reliability filtering, fallback, selection strategy, and Pi model activation.

Confidence is a routing signal, not proof of correctness. Exploratory evaluation found consistent judgments for clear prompts, but also high-confidence misses when mechanically small tasks had serious consequences. Keep fallback enabled and validate tier criteria against your workload.

See [Classifier backends](docs/guide/classifiers.md).

## Related project

[Bifrost Patterns](https://github.com/iamaamir/bifrost-pattern) explores multi-agent and workflow experiments on top of Bifrost. It is optional and outside Bifrost's core router.

## Development

```bash
npm test
npm run typecheck
npm run test:integration
npm run test:ui
npm run test:ui:reliability
```

UI smoke output lands in `screenshots/ui-smoke/`.

## License

[MIT](https://opensource.org/license/mit)
