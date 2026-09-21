# pi-bifrost

Configuration-first model-routing extension for the Pi coding agent, not an LLM gateway or proxy. Resolves each user prompt to a configured tier, filters unhealthy candidates, applies the user's per-tier strategy, and activates Pi's actual model before generation. It applies task-fit policy; it does not identify a universally best model. No native dependencies; uses Pi's built-in model registry.

## Language

**Tier**:
A quality/cost class of models (e.g. `frontier`, `economical`). Each tier maps to one or more model patterns. The classifier or regex rules produce a tier name; model selection then picks a candidate from that tier.
_Avoid_: category (the code uses both; prefer tier)

**Route rule**:
A regex pattern paired with a target tier. Rules are matched case-insensitively in order. First match wins. Example: `pattern: "\\b(debug|fix)\\b"` → `model: "frontier"`.
_Avoid_: routing rule, classification rule

**Classifier**:
Optional semantic tier selector invoked before regex rules. The prompt backend uses a configured Pi model. The TypeSafe/Jev backend is an explicit opt-in hosted integration that returns one tier, probabilities, and confidence. Classifiers choose tiers, never exact provider models; Bifrost config retains model-pool and strategy control.

**Strategy**:
How to pick among candidates within a tier. `first` = first available candidate. `cheapest` = lowest combined input+output cost per 1M tokens. Set globally or per-tier via `categoryStrategies`.

**Candidate**:
A model that matches a tier's pattern list. Resolved from pi's model registry. A tier may list multiple patterns; each pattern may match zero or more models.

**Model pattern**:
A string that resolves to models in pi's registry. Two forms: exact `provider/id` (e.g. `anthropic/claude-opus-4-5`) or bare substring (e.g. `qwen2.5-coder` matches any provider containing that string).

**Pin**:
Freeze the current model and stop automatic routing. Triggered automatically when the user runs `/model`, or manually via `/bifrost pin`. Reversed by `/bifrost unpin`.

**Config layer**:
One of four config sources merged in order: extension default → global (`~/.pi/agent/`) → project-local (`.pi/`) → project root. Later layers override earlier ones. The rules file (`bifrost-routes.json`) is loaded separately and overrides inline `rules` in `bifrost.json`.

**Fuzzy cache**:
Persisted classification cache using Jaccard token-set similarity. Stores `(normalizedPrompt, tier)` pairs in `.pi/bifrost-cache.jsonl`. On cache hit, skips the classifier entirely. Eviction is LRU by last-use timestamp.

## Example dialogue

**Dev:** "User types 'help me debug this race condition in my Go backend.' What happens?"

**Expert:** "Prompt enters the pipeline. First, fuzzy cache check — has Bifrost seen a similar prompt? If yes, reuse the cached tier, skip the classifier. If no, the LLM classifier reads the prompt and ideally returns `frontier` — 'debug' and 'race condition' are strong frontier signals. If the classifier is down, regex rules catch it — both 'debug' and 'race condition' hit the frontier rule. Once we have the tier, we look up the frontier model patterns, resolve candidates from the registry, apply the strategy — say `cheapest` — and switch pi's model."

**Dev:** "And if nothing matches?"

**Expert:** "Falls through to the configured default tier. Defaults are model-agnostic; users decide which models and strategy that tier uses."

**Dev:** "What happens when the user manually switches models with /model?"

**Expert:** "Bifrost detects the `model_select` event, pins itself, and logs a warning. It stops routing until the user runs `/bifrost unpin`. The assumption: if you manually picked a model, you had a reason."

**Dev:** "So the classifier costs tokens on every prompt?"

**Expert:** "Only on cache misses. The classifier model is configured to be cheap — typically a local Ollama model or a free-tier cloud model. Max 20 output tokens. And the fuzzy cache means repeat or near-repeat prompts skip it entirely. With threshold 0.85, 'debug the race condition' and 'help me debug a race condition' share a cache entry."

## Flagged ambiguities

- **tier vs category**: The codebase uses both interchangeably. The schema.json and `guessTier()` use "tier"; `classifyPrompt()` and cache entries use "category." The config key `categoryStrategies` retains the old name for backward compatibility. Prefer "tier" in new code and docs.
