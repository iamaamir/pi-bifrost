# Roadmap

## v0.2 — Power User Bridge

*Make routing feel transparent and controllable. The 10% of users who care about which model fires when need to see it and override it.*

### Direct model bindings
Per-prompt model overrides. Bind specific models to specific prompt patterns. `"when I say /commit, use glm-5.1"`. `"when I type /test, use gpt-oss-20b"`.

```json
{ "pattern": "\\bcommit\\b", "model": "opencode-go/glm-5.1" }
```

Also support inline override: "frontier debug this" forces frontier, "economical hello" forces economical. No `/bifrost pin` dance needed.

**Effort:** Low · **Reach:** Every user who's ever manually switched models

---

### Usage stats & cost visibility
`/bifrost stats` — per-model usage, cost estimates, cache hit rate, routing decisions over time. After each prompt: `⎇ frontier → claude-opus ($0.008)`. Prove Bifrost saves money. Convince teams. Optimize budgets.

**Effort:** Medium · **Reach:** Every user who needs to justify tool spend

---

### Fallback chains & circuit breaker
Model fails → try next in tier. 3 failures in 5 min → remove from rotation for 1 hour. Tier dead → cascade to default. In-process, no proxy latency. The differentiator for reliability-conscious teams.

```json
{ "models": { "frontier": { "patterns": [...], "fallback": "economical" } } }
```

**Effort:** Medium · **Reach:** Teams who can't afford silent failures

---

## v0.3 — Team & Trust

### Budget enforcement
Daily/monthly spend caps. At 80% → auto-downgrade. At 100% → lock to free tier. Tracked in `.pi/bifrost-budget.jsonl`. Makes Bifrost safe for teams with junior devs.

```json
{ "budget": { "daily": 2.00, "onExceeded": "downgrade" } }
```

**Effort:** Medium · **Reach:** Teams managing API costs

---

### Team policy layer
`.pi/bifrost-policy.json` that enforces constraints across the team. Allowed models per tier, minimum cache settings, required classifier. Team lead commits; dev configs validated against it at load.

**Effort:** Medium-High · **Reach:** Teams of 3+

---

### Context-aware routing
Detect conversation mode — debugging session stays on frontier, TDD red-green-refactor auto-escalates. Non-interactive mode (CI/CD) forces economical and disables classifier.

**Effort:** High · **Reach:** Power users in long sessions

---

## v0.4 — Intelligence

### Multi-turn stickiness
Once classified as `frontier`, stay there for N messages unless the prompt type diverges significantly. Sliding window + embedding similarity. Reduces re-classification overhead.

### Time-window routing
Route by time of day. `frontier` during deep work (8-12), `economical` during meetings.

### Context-size guard
Before switching to a smaller-context model, check if current context fits. Warn or refuse if it would truncate the conversation history.

---

## Already shipped (v0.1)

- [x] Probe-first init — tests models before writing config
- [x] 7 selection strategies — cheapest, fastest, largest_context, random
- [x] LLM + regex dual classifier with fuzzy cache
- [x] Performance API debug logging — JSONL, AI-parseable
- [x] Strict TypeScript typechecking
- [x] npm + GitHub distribution
