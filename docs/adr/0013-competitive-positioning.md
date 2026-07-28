# 0013 — Competitive positioning and product strategy

## Status

**Proposed** (2026-07-28). Pending review.

## Context

pi-bifrost is a query-aware model router for the pi coding agent (~3.4k LOC TypeScript). It classifies user prompts, selects the best model from configured tiers, and switches pi's active model transparently. An extensive landscape review was conducted in mid-2026 against every known competitor in the coding-agent model-routing space.

### Competitors evaluated

**OpenCode plugins** (detailed research at `docs/research/opencode-router-landscape.md`):

- **model-router** — Delegation router. Registers tiered subagents, injects a routing protocol into system prompts, and relies on primary-agent obedience. Strong task taxonomy and modes. Fundamentally a multi-agent orchestrator, not an active-turn model selector. Routes by persuading an LLM to delegate, which is correct for orchestration but not a substitute for deterministic per-prompt model selection.

- **model-fallback** — Event-driven transparent replay. Intercepts lifecycle events, holds per-session state (current model, failed models, replay locks), and replays failed prompts against fallback models. Extremely sophisticated race handling (first-token timers, abort propagation, stale event filtering, compaction). However, replay duplicates arbitrary user work — file changes, shell commands, external API calls — without an idempotency contract. Bifrost's future-turn avoidance is safer by default.

- **autopilot** — Router-as-provider proxy. Starts a local OpenAI-compatible proxy, receives every `/v1/chat/completions` request, applies classification + goal matrix + context-window filtering + health filtering, and forwards to a selected upstream. Strongest routing control because the proxy owns the request; also the hardest maintenance surface (auth, provider protocol variants, SSE semantics, streaming, error shaping, persistence). A different architectural tradeoff: maximum control at maximum coupling.

**Pi extensions** (detailed research at `docs/research/pi-extension-landscape.md`):

- **pi-model-router** — Virtual provider routing. Registers a virtual `router` provider whose models are profiles (e.g. `router/balanced`), then selects concrete models per request inside a custom `streamSimple` implementation. Rich signals (phase, budget, image support, thinking continuity). But conceals the actual selected model behind the virtual profile — footer shows `router/balanced`, not the real provider/model.

- **pi-router** — Channel routing. Maps one model across multiple provider channels with explicit channel ordering, sticky success, cooldown, latency records, and a route registry. Strong channel-identity concept but large surface area. Decision history commands (`/router explain`, `/router decisions`) are a direct precedent for Bifrost's decision traces.

- **pi-failover** — Custom-stream failover with error-driven model swap/replay. After exhausting retries, captures `lastUserPrompt` and calls `sendUserMessage` as a follow-up. Does not establish that the previous generation made no side effects. Directly validates Bifrost's no-replay policy.

- **pi-triage** — Heuristic + optional LLM classification with confidence gates and user-confirmed escalation. Routes only the first prompt automatically; later adjustments are suggestions. Confidence gating and dry-run UX are strong patterns.

- **pi-model-switch** — Agent tool for model inspection and switching. No routing policy, health state, or persistence. Useful capability-search pattern.

**Cursor Router** (July 2026) — Proprietary ML classifier, per-request routing, cache-aware cost optimization, explicit optimization modes (cost/balance/intelligence). Opaque — hides routed model identity from users. Enterprise-only, IDE-locked. No configuration portability. Strong ML-based routing at scale, but "black box" by design.

**Claude Code ecosystem** — No `BeforeModel` hook exists. Closest extensions:
- `tzachbon/claude-model-router-hook` (46★) — keyword-only `UserPromptSubmit` hook, no LLM classifier.
- `musistudio/claude-code-router` (36k★) — external proxy, not a plugin. Different architecture entirely.
- No existing Claude Code extension combines LLM classification, fuzzy caching, regex fallback, tier strategies, and pin support.

**Aider** — Static role-based model assignment (main/weak/editor). Not per-prompt routing. Complementary rather than competing.

### Key finding

Every competitor makes at least one major tradeoff that Bifrost avoids:

| Tradeoff | Who makes it |
|---|---|
| Routes via prompt obedience (indirect) | model-router |
| Replays user work without idempotency | model-fallback, pi-failover |
| Proxy maintenance surface | autopilot, Cursor Router (inherent), musistudio/CCR |
| Conceals actual model from user | pi-model-router |
| Routes first prompt only | pi-triage |
| Static role assignment, no per-prompt | Aider |
| Opaque ML routing, enterprise-locked | Cursor Router |

Bifrost's unique combination: **direct host-native routing (setModel before turn) + persistent circuit breaker (half-open, survives restart) + safe no-replay (future-turn avoidance) + transparent config + portable core/adapter seam.**

### Gaps that remain

The same research identified trust and explainability gaps that the competitive analysis (`docs/competitive-analysis.md`) captures as the Priority 0 work stream: decision traces, failure taxonomy, config lint, and a routing scenario corpus. These are the actionable gaps, addressed by ADRs 0007, 0009, and 0010.

## Decision

### 1. Product boundary

Bifrost is a **model router**, not an orchestrator, not a proxy, and not a replay engine.

- **Routing** is per-prompt model selection via the host's model-switching API (`setModel`), not prompt-guided delegation to a subagent.
- **Recovery** is future-turn avoidance (route the next prompt around a failed model), not transparent replay of the current turn.
- **Health** is tracked with a persistent half-open circuit breaker, not session-scoped cooldown or in-memory state.

```
prompt
  │
  ├─ inline override / fuzzy cache / LLM classifier / regex rules / default tier
  │
  ▼
requested tier
  │
  ├─ configured candidates + tier strategy
  ├─ circuit-health filtering
  └─ default-tier fallback when requested tier is exhausted
  ▼
selected model (via host setModel API)
  │
  └─ settled runtime outcome → persisted ReliabilityStore
```

### 2. Winning sequence

Validated by the landscape research. Each stage delivers user value independently and builds toward the next:

1. **Trust** — decision trace (ADR 0007) + config lint (ADR 0009) + failure taxonomy.
   - Makes every routing decision inspectable: source, candidates, exclusions, fallback, timing.
   - Closes the most important gap vs autopilot's reason metadata and pi-router's explain commands.
   - User can answer "what model, why this model, what was excluded, what can I change."

2. **Predictability** — scenario/eval corpus + preview parity.
   - A versioned routing scenario corpus prevents subjective regressions when rules or classifier change.
   - Preview uses the exact same decision builder as the real route — no drift.
   - Establishes a testable contract for routing policy.

3. **Suitability** — context eligibility + probe/reliability scoring.
   - Advisory context-window guard warns before routing to a model that cannot fit the session.
   - Probe freshness and reliability history inform candidate ordering within a strategy.
   - Advisory before enforcement; every exclusion traced.

4. **Control** — explicit modes and direct-rule fallback chains (ADR 0008).
   - Named policy overlays (economy, balanced, quality, reliable) let users shift behaviour without rewriting config.
   - Direct-rule chains express ordered model preferences with reliability-aware fallback.
   - Every mode and chain decision is traced.

5. **Expansion** — second-host adapter if the host exposes safe model override.
   - Core policy modules (config, routing, reliability, cache) are already host-independent.
   - Pi adapter is thin and documented. A Claude Code or OpenCode adapter follows the same pattern.
   - Proxy is the last-resort adapter strategy, not the default.

### 3. Product principles

1. **Direct beats implied.** Use host model-selection APIs rather than prompt instructions. The selected model is not contingent on an orchestrator model following a large system prompt.

2. **Safe degradation beats invisible recovery.** Do not replay user work without an idempotency contract. Recovery is future-turn avoidance by default; retry must be explicit, host-supported, and user-confirmed.

3. **Explain every route.** "Why this model?" is core UX, not debug-only data. Every routing decision emits a structured trace with source, candidates, exclusions, and timing.

4. **Config should be portable.** Ship no personal provider/model snapshot as default. Models are discovered at init time; defaults route only to tier names. No vendor lock-in.

5. **Persist reliability, not opaque magic.** JSON state must stay inspectable, repairable, and survivable across restarts. Circuit state, health records, and decision history are human-readable.

6. **Rules must be testable.** Every routing policy change gets scenario coverage and trace assertions. No untested classifier prompt or regex rule reaches production.

7. **Adapter thin, policy shared.** Port hosts by implementing capability adapters, not by cloning Bifrost logic. Core policy lives in host-independent modules; the host adapter handles events, model switching, probing, and UX.

### 4. Do not compete on

Bifrost strengthens its identity by explicitly declining these domains:

| Domain | Owned by | Why not Bifrost |
|---|---|---|
| Multi-agent orchestration | model-router | Subagent task decomposition is a different product. Bifrost routes one active turn. |
| Transparent replay/retry | model-fallback, pi-failover | Incompatible with safe-degradation principle. Replay requires host idempotency contract. |
| Proxy-level request control | autopilot, Cursor Router | Proxy gives control at the cost of auth, SSE, provider protocol, and security surface. |
| Channel-first routing | pi-router | Same-model multi-provider routing is a separate concern. Add channel dimension only after tier abstraction is mature. |
| Static role assignment | Aider | Per-prompt routing is the differentiator. Static roles are complementary, not a replacement. |
| Black-box ML routing | Cursor Router | Opaque model selection undermines explainability. Bifrost's decisions must remain inspectable and configurable. |
| Virtual provider abstraction | pi-model-router | Concealing the actual selected model conflicts with the "explain every route" principle. |
| Competitive cost/quality claims | — | Unmeasured claims erode trust. Bifrost competes on traceable decisions, not unverifiable benchmarks. |

### 5. Portability opportunity

The Claude Code ecosystem has no Bifrost equivalent — no extension combines LLM classification, fuzzy caching, regex fallback, tier strategies, and pin support. This is a genuine expansion path:

- **Core policy modules** (config, routing, classification, reliability, cache) are already host-independent. They import no Pi primitives.
- **Pi adapter** (`index.ts`, `commands.ts`, `ux-status.ts`, `result-viewer.ts`) is thin and documented. It maps pi events to policy calls and policy results to pi UX.
- **Claude Code adapter** would follow the same pattern: map Claude Code lifecycle hooks (e.g. `UserPromptSubmit`, `PreToolUse`) to the same policy core, render decisions via Claude Code TUI primitives.
- **Do NOT build a proxy as the first porting mechanism.** Use host hooks if `BeforeModel` exists; fall back to `UserPromptSubmit` if not. The proxy adapter is a last resort for hosts without any request-level model override API.

Porting is not in the current roadmap. The architectural seam exists and is documented so that when a second host is evaluated, the path is known and the core does not need restructuring.

## Consequences

### Positive

- **Clear product identity.** The boundary definition prevents scope creep toward orchestration, replay, or proxy maintenance.
- **Focused roadmap.** The winning sequence is ordered by user value and architectural fit. Every stage compounds on the previous one.
- **Principled rejection of feature parity.** Not having transparent replay or proxy-level control is a deliberate design decision, not a gap.
- **Portability is an option, not a dependency.** The core/adapter seam exists; a second host can be evaluated without restructuring.
- **Competitive narrative is evidence-based.** Every positioning claim is grounded in source-reviewed competitor analysis, not speculation.

### Negative

- **Feature comparison risk.** Against broader competitors (model-router with subagent governance, autopilot with proxy control, Cursor Router with ML routing), Bifrost will lose "spec sheet" comparisons. The response must be demonstration of trust and explainability, not a feature grid.
- **Ecosystem-specific lock-in risk.** Bifrost's direct-host-native routing (call `setModel` before the turn) is only as portable as the number of hosts that expose a safe model-selection API. If Pi changes this API or no other host exposes it, the portability advantage becomes a Pi-specific investment.
- **Evaluation corpus requires maintenance.** The scenario corpus (stage 2) needs periodic review to stay aligned with evolving user expectations and host capabilities.

### Migration

This ADR is a documentation and strategy decision. It changes no code, config, schema, or tests. It formalizes the product direction that the competitive analysis already recommends and that ADRs 0007–0010 already implement incrementally.

Existing ADRs remain valid. This ADR provides the strategic context that motivated them and a framework for evaluating future ADRs against product identity.
