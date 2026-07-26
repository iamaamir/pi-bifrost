# Pi-Bifrost examples

These recipes show decisions Bifrost can automate. They are templates, not universal model lists. Replace model patterns with models available in your Pi registry.

Install Bifrost first:

```text
pi install npm:pi-bifrost
/bifrost init
```

Copy a recipe to `.pi/bifrost.json`, then reload:

```text
/bifrost reload
```

Preview before sending:

```text
/bifrost preview fix the race condition in the worker queue
```

## Recipes

### `rules-only-local.json`

Use when prompts must stay local or routing should never make an extra classifier call.

- Disables the LLM classifier.
- Uses ordered regex rules.
- Routes complex work to a local frontier tier.
- Falls back to `economical` when no rule matches.

Try:

```text
/bifrost preview explain what this function does
/bifrost preview fix this race condition
```

Tradeoff: deterministic and private, but rules only understand patterns you define.

### `economical-frontier.json`

General-purpose setup for using cheap models by default and stronger models for harder work.

- Optional classifier handles prompts regex rules do not describe well.
- Economical tier selects by combined cost.
- Frontier tier selects the largest available context window.
- Classification cache reduces repeated classifier calls.
- Regex remains the fallback path.

Try:

```text
/bifrost preview summarize this file
/bifrost preview design a retry strategy for this distributed worker
```

Tradeoff: better coverage for ambiguous prompts, with possible classifier tokens and latency on cache misses.

### `large-context.json`

Use when repository analysis, migrations, logs, or long conversations need a dedicated context tier.

- Adds `quick`, `deep`, and `long-context` tiers.
- Uses `largest_context` for deep and long-context work.
- Routes explicit large-input prompts before general debugging rules.

Replace `provider/replace-with-large-context-model` with an installed model.

Try:

```text
/bifrost preview analyze the whole repository for duplicated authorization logic
/bifrost preview summarize this 20000-line log
```

Tradeoff: large-context models may cost more or respond slower.

### `exact-bindings.json`

Use when certain operations must always use a specific model.

- Direct `provider/id` rules bypass tier selection.
- Commits and release notes can use a dependable model.
- Tests and formatting can use a fast local model.
- Security prompts can route to the frontier tier.

Try:

```text
/bifrost preview write the changelog for this release
/bifrost preview run through this security audit
```

Tradeoff: exact bindings are predictable but less flexible when model availability changes.

### `project-routes.json`

Use when each repository needs different routing rules.

Rename it to `.pi/bifrost-routes.json` inside a project. It overrides the `rules` array from the main config while keeping the same model tiers.

The example separates frontend, backend, and infrastructure work. Add matching tiers to `.pi/bifrost.json` first:

```json
{
  "models": {
    "frontend": ["provider/frontend-model"],
    "backend": ["provider/backend-model"],
    "infrastructure": ["provider/infrastructure-model"]
  }
}
```

Try:

```text
/bifrost preview make this layout responsive
/bifrost preview add an index for this query
/bifrost preview update the deployment pipeline
```

Tradeoff: project-local rules keep routing relevant, but they need maintenance as the repository changes.

## Manual control

Automation is always reversible:

```text
!frontier implement the auth module
/bifrost pin
/bifrost unpin
/bifrost classifier off
/bifrost classifier on
```

Use `/bifrost preview` before changing rules. Use `/bifrost debug` to inspect loaded tiers and rules, `/bifrost benchmark` to compare per-tier candidates, and `/bifrost probe` to check which models respond.

## Strategy cookbook

Set a global strategy or override it per tier:

```json
{
  "strategy": "first",
  "categoryStrategies": {
    "economical": "cheapest",
    "deep": "largest_context",
    "latency-sensitive": "fastest",
    "load-balanced": "random"
  }
}
```

- `cheapest`: lowest combined input and output cost.
- `cheapest_input`: lowest input cost.
- `cheapest_output`: lowest output cost.
- `largest_context`: largest context window.
- `first`: first available candidate in list order.
- `fastest`: probe-sorted first candidate.
- `random`: random available candidate.
