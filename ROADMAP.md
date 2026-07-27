# Roadmap

## v0.2 — Power User Bridge

*Make routing feel transparent and controllable. The 10% of users who care about which model fires when need to see it and override it.*

### [x] Direct model bindings
Per-prompt model overrides. Bind specific models to specific prompt patterns. `"when I say /commit, use glm-5.1"`. `"when I type /test, use gpt-oss-20b"`.

```json
{ "pattern": "\\bcommit\\b", "model": "opencode-go/glm-5.1" }
```

Also support inline override: "frontier debug this" forces frontier, "economical hello" forces economical. No `/bifrost pin` dance needed.

**Effort:** Low · **Reach:** Every user who's ever manually switched models

---

### Default config overhaul — task-aware routing

Replace the weak two-tier `economical`/`frontier` default with a minimal 3-tier config:

- `quick` — formatting, extraction, classification, commit messages, simple edits, explicit free-only requests. Strategy: `random`.
- `general` — writing code, tests, docs, summaries, ordinary refactoring. Strategy: `first`.
- `frontier` — architecture, debugging, code review, security, complex reasoning, explicit premium requests. Strategy: `first`.

Ship together with:

- Tier-based rules only (no hardcoded model IDs) so `/bifrost init` works for any registry.
- `DEFAULT_RULES` as the single source of truth; shipped `bifrost.json` omits `rules`.
- Updated `guessTier` cost bands: `<1 → quick`, `1–5 → general`, `>5 → frontier`.
- Empty `models` arrays in the default config, populated by `/bifrost init`.
- Rich 14-tier task-aware config and detailed classifier prompt moved to `examples/`.

**Effort:** Low · **Reach:** Every new install

**Status:** ✅ Shipped in v0.2.2 via updated `bifrost.json`, `config.ts`, `routing.ts`, `commands.ts`, and new examples.

---

### Usage stats & cost visibility
`/bifrost stats` — per-model usage, cost estimates, cache hit rate, routing decisions over time. After each prompt: `⎇ frontier → claude-opus ($0.008)`. Prove Bifrost saves money. Convince teams. Optimize budgets.

**Effort:** Medium · **Reach:** Every user who needs to justify tool spend

---

### Thinking-level preservation and visibility

Model selection can cause Pi to preserve or capability-clamp its thinking level. A target that does not support the current level may be clamped upward (for example `medium` → `high`), affecting latency and cost.

First expose effective level and clamp reason in routing feedback. Preserve Pi behavior by default. Any tier-level thinking policy must be explicit, opt-in, capability-aware, and never silently rewrite user preferences.

Full evidence, design questions, and acceptance criteria: [`docs/adr/0004-thinking-level-routing.md`](docs/adr/0004-thinking-level-routing.md).

**Effort:** Low for visibility · Medium for optional policy · **Reach:** Every routed reasoning-capable model

---

### PTY test harness evolution

An isolated `agent-tui` POC passed startup, dashboard, preview, and Escape-dismissal scenarios while the existing Python smoke remained unchanged. Use it as the future behavioral TUI driver: real terminal emulation plus semantic waits. Keep Python screenshots during migration.

Do not promote it to required CI until agent-tui installation is pinned and Pi settings/model/provider behavior is deterministic. Full evidence, findings, and migration gate: [`docs/agent-tui-evaluation.md`](docs/agent-tui-evaluation.md).

**Effort:** Medium · **Reach:** Every TUI change and release gate

---

### Reliability v1 — health-aware selection & circuit breaker

**Next priority.** Before sending a prompt, select only candidates that are not known-bad:

- Record probe failures and observed provider failures.
- 3 failures in 5 minutes → open model circuit for 1 hour.
- Skip open-circuit models, try next candidate in tier, then configured fallback/default tier.
- Show selected, skipped, and fallback reason in Bifrost status/dashboard.
- Persist breaker state deliberately; never silently rewrite user model config.

This is pre-send resilience: routing avoids models already known to be unhealthy. It adds no proxy latency and has no duplicate-request risk.

```json
{
  "reliability": {
    "failureThreshold": 3,
    "windowMinutes": 5,
    "cooldownMinutes": 60
  }
}
```

**Effort:** Medium · **Reach:** Every user affected by flaky providers

---

### Reliability v2 — safe request retry (research gate)

Do **not** blindly re-send a submitted prompt after provider failure. Pi-Bifrost selects a model before the agent request, while a failed request may already have streamed output or triggered tools. Automatic replay can duplicate work.

First validate Pi extension hooks for provider-error interception and turn replay. Only ship retry when all are true:

- failure occurs before assistant or tool output;
- retry is explicitly enabled;
- exact prompt/attachments can be replayed once on a fallback model;
- user sees retry/fallback outcome.

Until then, record failure, open circuit when warranted, and route subsequent prompts away from that model.

**Effort:** Research first · **Reach:** Reliability-conscious teams

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
