# Roadmap

This roadmap is grouped by status, not by version. Each item links to its ADR when one exists, and each item lists an effort estimate (Low / Medium / High) plus the user it reaches. Items move up when paired with a concrete user report; speculative features stay in **Backlog / Intentionally deferred** until reported.

## How we decide what to build

We keep Bifrost a **configuration-first router**, not a policy engine. See [`docs/product-philosophy.md`](docs/product-philosophy.md): explicit configuration → observable signal → advisory recommendation → explicit opt-in → bounded automation.

A feature earns a slot when:

1. A real user reports a routing outcome they could not predict or fix with current config.
2. The fix composes with the pure-CB boundary (ADR 0005) and the minimal-default identity (ADR 0006).
3. Its effect is inspectable, overridable, and covered by deterministic scenarios before it automates a routing choice.
4. Its cost (state, infra, breaking change) is small enough to ship in one PR.

Features that need an eval harness, persistent analytics, telemetry infra, or upstream Pi changes go to **Research / Unknowns** until that stack exists.

---

## Shipped

### v0.1 — core router
- [x] Probe-first init — tests models before writing config.
- [x] 7 selection strategies — `first`, `cheapest`, `cheapest_input`, `cheapest_output`, `largest_context`, `random`, `fastest`.
- [x] LLM + regex dual classifier with fuzzy Jaccard cache.
- [x] Direct model bindings — `"model": "provider/id"` rules bypass tier selection. Inline overrides (`frontier ...`, `economical ...`).
- [x] Performance API debug logging — JSONL, AI-parseable.
- [x] Strict TypeScript (`tsc --noEmit` clean), npm + GitHub distribution.

### v0.2.x — reliability + minimal defaults
- [x] **Reliability v1 — circuit breaker.** Probe/runtime failures recorded; circuit opens after N failures in M minutes; open-circuit models are skipped with fallback to default tier. State persisted in `.pi/bifrost-reliability.json`. See [`docs/adr/0005-reliability-store.md`](docs/adr/0005-reliability-store.md).
- [x] **Default config overhaul.** Replaced the bloated research config with a 3-tier minimal default (`quick`/`general`/`frontier`), no hardcoded model IDs, `DEFAULT_RULES` is the single source of truth, `/bifrost init` and `guessTier` aligned to the new names. See [`docs/adr/0006-default-config.md`](docs/adr/0006-default-config.md).

---

## In progress (v0.3 — transparency & safety)

Four small ADRs. Each is a building block: traces make the rest debuggable; the other three fix specific sharp edges the latest reviews uncovered.

### [ADR 0007 — Explainable decision traces](docs/adr/0007-decision-traces.md)
`/bifrost preview` today prints a flattened summary. Promote it to a structured, machine-readable trace: stage timings (`cache`, `classifier`, `regex`, `fallback`), inputs, route taken, candidates filtered by reliability, strategy choice, and selected model. Same data shown to the user; same data available to tests. **Effort:** Low · **Reach:** every user who debugs a misroute.

### [ADR 0008 — Direct-rule fallback chains](docs/adr/0008-direct-rule-fallback-chains.md)
A rule today binds to a single `provider/id`; if that model is circuit-open, routing falls to the default tier silently. Let `model` accept an ordered list `["A", "B", "C"]` so B is tried after A is filtered by reliability, then C, then the default tier. Composes with ReliabilityStore; no new infra. **Effort:** Low-Medium · **Reach:** every user with direct bindings.

### [ADR 0009 — Config linter](docs/adr/0009-config-linter.md)
`/bifrost validate` (offline, no probes) reports: regex compile errors, tier names referenced in `rules`/`categoryStrategies` but missing from `models`, classifier `model` not resolvable from registry, conflicting strategies (e.g. `random` on a tier with one model), duplicate rule patterns, unreachable rules after a catch-all. Distinct from runtime `validateConfig` which is an error gate; linter is advisory. **Effort:** Low · **Reach:** every user editing `bifrost.json`.

### [ADR 0010 — Classifier confidence and graceful downgrade](docs/adr/0010-classifier-confidence.md)
The LLM classifier today returns a tier or nothing. Let it emit `<tier>:<conf 0–1>`; below a configured threshold (`classifier.minConfidence`, default 0.6) we downgrade to regex rules instead of trusting the call. Composes with the trace ADR: the confidence number flows into the trace. **Effort:** Low-Medium · **Reach:** every user who has watched the classifier pick a wrong tier on a hard prompt.

---

## Research / Unknowns — needs upstream or external evidence

These stay parked until the listed dependency is resolved.

### Thinking-level routing
**ADR candidate, not yet implemented.** When Bifrost routes to a reasoning-capable model, Pi can clamp or elevate thinking level. Need to expose effective level + clamp reason in routing feedback; any policy must be opt-in. Waiting on: nothing — ADR 0004 is documented and ready. Moved to In progress when picked up. See [`docs/adr/0004-thinking-level-routing.md`](docs/adr/0004-thinking-level-routing.md). **Effort:** Low for visibility.

### Reliability v2 — safe request retry
Re-sending a prompt after a provider failure risks duplicating work (output may have streamed, tools may have fired). Blocked on Pi extension hooks for pre-output error interception and turn replay. Until then, fail-fast + record + circuit-open. **Effort:** Research first.

### PTY test harness evolution
`agent-tui` POC passed startup/dashboard/preview scenarios; existing Python smoke remains the gate. Promotion blocked on pinning `agent-tui` install and deterministic Pi behavior in CI. See [`docs/agent-tui-evaluation.md`](docs/agent-tui-evaluation.md). **Effort:** Medium.

---

## Backlog — picked up when reported

### Usage stats & cost visibility
`/bifrost stats` — per-model usage, cost estimates, cache hit rate, routing decisions over time. Inline telemetry after each prompt: `⎇ frontier → claude-opus ($0.008)`. Proves saving, justifies tool spend. **Effort:** Medium · **Reach:** teams justifying API costs. Need a local JSONL store; no cloud.

### Budget enforcement
Daily/monthly spend caps in `.pi/bifrost-budget.jsonl`. At 80% → auto-downgrade default tier; at 100% → lock to free tier. Composes with usage stats. **Effort:** Medium · **Reach:** teams with junior devs.

### Team policy layer
`.pi/bifrost-policy.json` committed by a team lead; dev configs validated against it at load. Allowed models per tier, minimum cache settings, required classifier. **Effort:** Medium-High · **Reach:** teams of 3+.

### Multi-turn stickiness
Once classified as `frontier`, stay for N messages unless the prompt diverges significantly (sliding window + embedding similarity). Reduces re-classification overhead and keeps a debugging session from bouncing tiers. **Effort:** Medium · **Reach:** power users in long sessions.

### Context-size guard
Before switching to a smaller-context model, check that current context fits. Warn or refuse if it would truncate history. **Effort:** Medium · **Reach:** long sessions with large context.

### Time-window routing
Route by time of day (`frontier` during deep work, `economical` during meetings). Cheap to add; compelling for a narrow audience. **Effort:** Low.

---

## Intentionally deferred — saw these proposed, holding

The proposed "confidence-aware policy engine" expansion included 17 features. Several need infrastructure Bifrost does not own and should not own as a config-first router extension. Holding until a concrete user report makes one of these the cheapest fix.

- **Weighted multi-dimensional scoring** (quality × cost × latency × reliability × context × suitability). Needs per-model quality scores from an eval harness we don't have. Until then the discrete `strategy` enum covers what we can measure today.
- **Model suitability profiles.** Same dependency — needs quality scores.
- **Quota-aware routing.** Needs per-provider quota telemetry; pi not an LLM gateway.
- **Shadow evaluation + automatic data-driven tuning.** Needs labelled routing data and an offline eval stack. Out of scope until a separate observability story lands.
- **Routing analytics.** Overlaps with usage stats; defer the routing-quality analytics until stats ships.
- **Token estimation + expected total-cost projection.** Token estimation alone is a small add; full cost projection requires output-token prediction which is rarely accurate enough to drive routing. Defer the projection; revisit estimation if a real need appears.
- **Multi-intent classification with configurable priority.** The current classifier already picks "the hardest and most consequential part" of a multi-part prompt. Defer until a mis-multi-intent report arrives.
- **Round-robin / weighted-random load balancing.** `random` already added in ADR 0006 for the `quick` tier. Round-robin needs cross-session state; revisit only on reported rate-limit pain.

These are not "no"; they are "not yet." Any one becomes a candidate ADR the day a user files a bug whose cheapest fix is that feature.