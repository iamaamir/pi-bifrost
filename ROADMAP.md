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

### v0.2.x — reliability + minimal defaults (shipped)
- [x] **Reliability v1 — circuit breaker.** Probe/runtime failures recorded; circuit opens after N failures in M minutes; open-circuit models are skipped with fallback to default tier. State persisted in `.pi/bifrost-reliability.json`. See [`docs/adr/0005-reliability-store.md`](docs/adr/0005-reliability-store.md).
- [x] **Default config overhaul.** Replaced the bloated research config with a 3-tier minimal default (`quick`/`general`/`frontier`), no hardcoded model IDs, `DEFAULT_RULES` is the single source of truth, `/bifrost init` and `guessTier` aligned to the new names. See [`docs/adr/0006-default-config.md`](docs/adr/0006-default-config.md).
- [x] **Optional TypeSafe/Jev classifier.** Explicit opt-in tier judgment with strict decoding, confidence gates, safe credential handling, bounded failure recovery, local metrics, and dual-gated troubleshooting traces. See [`docs/jev-typesafe-architecture.md`](docs/jev-typesafe-architecture.md).

## Current release candidate (not shipped)

The current working candidate adds the following opt-in and inspectable behavior. These items are not shipped until the release candidate passes its final verification and is published; see [`RELEASE-PLAN.md`](RELEASE-PLAN.md) for checkpoint and gate evidence.

- **Strict fallback boundaries:** schema v2 can give a tier an ordered `fallbackTiers` list. An empty list is terminal: an exhausted boundary does not fall through to the active or previously dispatched model. Tiers without a policy retain legacy behavior.
- **Reliability version policy:** v1 remains the default and available this release, but is deprecated; the v1-to-v2 migration command remains available. Receipt-owned v2 is recommended only for supported Auto user turns. Physical routing and direct utility calls still require v1, so v2 is not a general switch for every workflow. Before migration, stop other Pi sessions that may write v1 state and ensure the current session has no active or queued generation. The cooperative source lock cannot fence older/uncooperative binaries or a stale v1 writer after migration. Any future v1 removal must be announced at least one published release ahead and wait until intended v1-dependent workflows are covered; no removal version or date is set.
- **Receipt-owned reliability v2:** explicitly enabled Auto turns use separate, durable admission receipts and controlled recovery trials. The bounded allowance-recovery exception in ADR 0023 also applies after confirmed V2 settlement.
- **Bounded allowance recovery:** Auto can make one visible attempt on another configured eligible model after an explicit usage-limit rejection, only when Pi proves failed responses were empty, from the same model, and exactly omitted, with no tools, results, queue, or other activity. Pi's own bounded retry may run first. `reliability.retryOnAllowanceExhausted: false` disables Bifrost failover. See [ADR 0023](docs/adr/0023-bounded-allowance-recovery.md).
- **Provider usage and rate pauses:** usage and billing rejections pause models with the same configured Pi provider ID by default. The policy applies in Auto and physical routing. It does not identify shared billing accounts. `reliability.allowanceCooldownScope: "model"` limits usage and billing pauses to one model. Generic HTTP 429 pauses remain provider-scoped. See [ADR 0024](docs/adr/0024-provider-usage-and-rate-pauses.md).
- **Explicit config reconciliation:** preview is local and write-free by default; a reviewed proposal digest is required for apply. Optional provider refresh is a separate preview action. The ownership sidecar tracks exact generated memberships, and the journal keeps exact backups. Init updates only generated memberships that remain safe to reconcile and preserves handwritten entries and other config fields.
- **Automatic fresh setup:** when no meaningful config, route file, or explicit routing override blocks setup, Bifrost starts with physical selection and builds model lists from Pi's catalog on the first prompt. It saves a minimal project `.pi/bifrost.json` and ownership receipt in the background. An empty `{}` file does not block setup. The save does not probe or store prompts or secrets. Init remains available for catalog refresh and reconciliation. Selecting `bifrost/auto` remains a separate opt-in. See [ADR 0025](docs/adr/0025-automatic-first-use-configuration-save.md).
- **Economic snapshots and billing preference:** schema v2 accepts explicit declared/estimated facts, windows and resets, with observe or configured reserve behavior and an optional billing-class preference. Facts are snapshots; Bifrost does not fetch live quota or infer subscription/billing state, and these controls do not provide a spend-cap guarantee.
- **Branch-local affinity:** Pi Auto defaults to retaining an eligible model after a proven successful same-tier dispatch; physical routing and the resolve-only API stay off by default. Schema-v2 config can opt out or select observation mode. Retention does not cross tiers or override hard exclusions. This is not the session-base behavior proposed in ADR 0019.
- **Experimental resolve-only API:** `pi-bifrost/router` evaluates caller-supplied snapshots without changing Pi's selected model. Results are advisory and require fresh validation before dispatch.

The pinned Pi 1.0.1 host source also settles the classifier catalog question for this candidate: `ModelRegistry.getAvailable()` returns `Model<Api>[]` (`packages/coding-agent/src/core/model-registry.ts` at Pi tag `v1.0.1`, commit `a7229ddc21810d6245105978033b7df645ecc2f7`). The `pi-ai` `Models` contract documents unqualified accessors, including `getAvailable()`, as chat-only; classifier entries have a distinct `ClassifierModel` type for `classify()` (`packages/ai/src/models.ts`, `packages/ai/src/types.ts` at the same tag). Bifrost's routing, probe, and init use this available chat catalog. This is a pinned host-contract dependency, not a Bifrost predicate that can protect against a future Pi contract change.

---

## Remaining ADR work

These earlier ADRs remain tracked independently from the current release candidate above. Some candidate behavior overlaps their scope; use each ADR for its full requirements and remaining gaps.

### [ADR 0007 — Explainable decision traces](docs/adr/0007-decision-traces.md)
`/bifrost preview` today prints a flattened summary. Promote it to a structured, machine-readable trace: stage timings (`cache`, `classifier`, `regex`, `fallback`), inputs, route taken, candidates filtered by reliability, strategy choice, and selected model. Same data shown to the user; same data available to tests. **Effort:** Low · **Reach:** every user who debugs a misroute.

### [ADR 0008 — Direct-rule fallback chains](docs/adr/0008-direct-rule-fallback-chains.md)
A rule today binds to a single `provider/id`; if that model is circuit-open, routing falls to the default tier silently. Let `model` accept an ordered list `["A", "B", "C"]` so B is tried after A is filtered by reliability, then C, then the default tier. Composes with ReliabilityStore; no new infra. **Effort:** Low-Medium · **Reach:** every user with direct bindings.

### [ADR 0009 — Config linter](docs/adr/0009-config-linter.md)
`/bifrost validate` (offline, no probes) reports: regex compile errors, tier names referenced in `rules`/`categoryStrategies` but missing from `models`, classifier `model` not resolvable from registry, conflicting strategies (e.g. `random` on a tier with one model), duplicate rule patterns, unreachable rules after a catch-all. Distinct from runtime `validateConfig` which is an error gate; linter is advisory. **Effort:** Low · **Reach:** every user editing `bifrost.json`.

### [ADR 0010 — Classifier confidence and graceful downgrade](docs/adr/0010-classifier-confidence.md)
The LLM classifier today returns a tier or nothing. Let it emit `<tier>:<conf 0–1>`; below a configured threshold (`classifier.minConfidence`, default 0.6) we downgrade to regex rules instead of trusting the call. Composes with the trace ADR: the confidence number flows into the trace. **Effort:** Low-Medium · **Reach:** every user who has watched the classifier pick a wrong tier on a hard prompt.

---

## Post-v1 direction — slim the adapter, double down on policy (not now)

Maintainer direction (2026-10-03): once v1 is ready, remove or avoid reimplementing anything Pi now provides natively, and concentrate Bifrost on what hosts do not provide. **v1 ships the current architecture first — no speculative rewrites.**

- **Remove/avoid (Pi-native now or soon):** custom classifier transports (TypeSafe direct HTTP, prompt endpoint, subprocess) — Pi's `ctx.modelRegistry.classify()` and classifier-model catalog cover invocation (ADR 0018 anticipated exactly this seam); probe transports re-audited against evolving Pi model APIs; any UI Pi already renders (footer, model display) — Bifrost keeps `setStatus("bifrost-state", ...)` only.
- **Double down (Bifrost's moat):** policy and decision engines — tier judgment and classification semantics, decision traces (ADR 0007), confidence gating (ADR 0010), escalation and fallback chains (ADR 0008), reliability circuits (ADR 0005), provider/model selection strategies, config primitives (ADR 0017).
- **Discipline:** each removal needs evidence the Pi-native path matches current semantics (credentials, retries, abort, reliability, traces) plus a migration ADR. Thin adapters stay; policy never migrates out.

---

## Research / Unknowns — needs upstream or external evidence

These stay parked until the listed dependency is resolved.

### Thinking-level routing
**ADR candidate, not yet implemented.** When Bifrost routes to a reasoning-capable model, Pi can clamp or elevate thinking level. Need to expose effective level + clamp reason in routing feedback; any policy must be opt-in. Waiting on: nothing — ADR 0004 is documented and ready. Moved to In progress when picked up. See [`docs/adr/0004-thinking-level-routing.md`](docs/adr/0004-thinking-level-routing.md). **Effort:** Low for visibility.

### Broader automatic request retry or replay
Deferred. The narrow allowance-recovery exception in ADR 0023 does not authorize retries after output, tool use, queued work, host-owned retry, or unknown activity. Broader replay would need a separate safety design and deterministic host proof for each supported boundary. **Effort:** Deferred.

### Live quota allowance adapter
Blocked on documented provider or host support that exposes authoritative allowance windows, reset semantics, account identity, freshness, and authorization through Pi-managed credentials. The candidate includes reactive pauses based on errors from requests that Pi already sent. It does not fetch live limits. Explicit economic snapshots remain separate. Do not use private consumer endpoints or describe either feature as live tracking. **Effort:** External evidence required.

### PTY test harness evolution
`agent-tui` POC passed startup/dashboard/preview scenarios; existing Python smoke remains the gate. Promotion blocked on pinning `agent-tui` install and deterministic Pi behavior in CI. See [`docs/agent-tui-evaluation.md`](docs/agent-tui-evaluation.md). **Effort:** Medium.

---

## Backlog — picked up when reported

### Usage stats & cost visibility
`/bifrost stats` — per-model usage, cost estimates, cache hit rate, routing decisions over time. Inline telemetry after each prompt: `⎇ frontier → claude-opus ($0.008)`. Reports observed usage so teams can evaluate routing tradeoffs; it does not prove savings without a valid baseline. **Effort:** Medium · **Reach:** teams evaluating API costs. Need a local JSONL store; no cloud.

### Budget enforcement
Daily/monthly spend caps in `.pi/bifrost-budget.jsonl`. At 80% → auto-downgrade default tier; at 100% → lock to free tier. Composes with usage stats. **Effort:** Medium · **Reach:** teams with junior devs.

### Team policy layer
`.pi/bifrost-policy.json` committed by a team lead; dev configs validated against it at load. Allowed models per tier, minimum cache settings, required classifier. **Effort:** Medium-High · **Reach:** teams of 3+.

### Session-sticky routing
**Proposed in [ADR 0019](docs/adr/0019-session-sticky-routing.md); not implemented.** Route the first eligible prompt, retain the selected provider/model as a session-local base, and skip automatic rerouting on normal later prompts. A configured tier-name prefix may explicitly route one turn before Bifrost restores the base; `/bifrost pin` remains a hard lock that ignores prefixes. This reported need replaces earlier speculative N-turn and semantic-divergence stickiness with a smaller, inspectable mode. **Effort:** Medium · **Reach:** users with long sessions, prompt-cache concerns, or unwanted model churn.

### Context-size guard
Before switching to a smaller-context model, check that current context fits. Warn or refuse if it would truncate history. **Effort:** Medium · **Reach:** long sessions with large context.

### Time-window routing
Route by time of day (`frontier` during deep work, `economical` during meetings). Cheap to add; compelling for a narrow audience. **Effort:** Low.

---

## Intentionally deferred — saw these proposed, holding

The proposed "confidence-aware policy engine" expansion included 17 features. Several need infrastructure Bifrost does not own and should not own as a config-first router extension. Holding until a concrete user report makes one of these the cheapest fix.

- **Weighted multi-dimensional scoring** (quality × cost × latency × reliability × context × suitability). Needs per-model quality scores from an eval harness we don't have. Until then the discrete `strategy` enum covers what we can measure today.
- **Model suitability profiles.** Same dependency — needs quality scores.
- **Proactive quota-aware routing.** Reactive pauses use errors from requests already sent. Proactive routing needs documented per-provider quota telemetry through Pi; Pi is not an LLM gateway.
- **Shadow evaluation + automatic data-driven tuning.** Needs labelled routing data and an offline eval stack. Out of scope until a separate observability story lands.
- **Routing analytics.** Overlaps with usage stats; defer the routing-quality analytics until stats ships.
- **Token estimation + expected total-cost projection.** Token estimation alone is a small add; full cost projection requires output-token prediction which is rarely accurate enough to drive routing. Defer the projection; revisit estimation if a real need appears.
- **Multi-intent classification with configurable priority.** The current classifier already picks "the hardest and most consequential part" of a multi-part prompt. Defer until a mis-multi-intent report arrives.
- **Round-robin / weighted-random load balancing.** `random` already added in ADR 0006 for the `quick` tier. Round-robin needs cross-session state; revisit only on reported rate-limit pain.

These are not "no"; they are "not yet." Any one becomes a candidate ADR the day a user files a bug whose cheapest fix is that feature.
