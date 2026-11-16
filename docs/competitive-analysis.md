# Bifrost competitive architecture analysis

> **Purpose:** identify where Bifrost is structurally ahead, where it is behind, and which improvements strengthen its identity instead of copying competitors.
>
> **Evidence:** local Bifrost source/tests plus shallow source reviews of `opencode-model-router` (`b8bef97`), `opencode-model-fallback` (`ea88f94`), and `opencode-autopilot` (`30b9999`). Detailed source map: [OpenCode router landscape](research/opencode-router-landscape.md).

## Executive summary

Bifrost has a strong technical core: it performs **direct, deterministic model selection before a Pi turn**, records reliability state persistently, and avoids replaying user work after a failure. This gives it a cleaner safety model than event-replay fallback plugins and a much smaller maintenance/security surface than a local LLM proxy.

Bifrost is not yet equally strong at making routing decisions **visible, explainable, and controllable**. The main product gap is not “more routing intelligence”; it is a user being able to answer:

1. What model did Bifrost select?
2. Why this model instead of another candidate?
3. What was excluded because of reliability, cost, context, or config?
4. What can I change now to get a different outcome?

**Primary strategic direction:** become the most trustworthy model router for coding agents: direct routing, persistent reliability, inspectable decisions, safe degradation. Do not become a general multi-agent orchestrator or a transparent replay engine by default.

---

## 1. What Bifrost is

### Product boundary

Bifrost maps an incoming Pi prompt to a configured model tier, selects an eligible model, switches Pi’s active model, and tracks model health for future routing.

```text
prompt
  │
  ├─ inline override / cache / classifier / regex rules / default tier
  │
  ▼
requested tier
  │
  ├─ configured candidates + tier strategy
  ├─ circuit-health filtering
  └─ default-tier fallback when requested tier is exhausted
  ▼
selected Pi model
  │
  ├─ ctx.setModel(...)
  ▼
Pi generates turn
  │
  └─ settled runtime outcome → persisted ReliabilityStore
```

### Architectural separation

| Area | Main files | Role | Portability |
|---|---|---|---|
| Configuration | `config.ts`, `schema.json` | Load, normalize, validate config and default rules | High |
| Decision policy | `classification-pipeline.ts`, `routing.ts`, `inline-override.ts` | Determine requested tier and candidate model | High |
| Reliability policy | `reliability.ts`, `reliability-store.ts`, `runtime-reliability.ts` | Circuit breaker, persisted state, settlement semantics | High |
| Probe/cache | `probe.ts`, `cache.ts` | Verify models, cache classification | High to medium |
| Pi adapter | `index.ts`, `commands.ts`, `ux-status.ts`, `result-viewer.ts` | Pi events, model switching, commands, UI | Low |

This separation is Bifrost’s portability advantage. A second host needs a new adapter, not a new routing/reliability engine.

---

## 2. Comparative scorecard

Scores describe current source architecture, not marketing claims or benchmark results.

| Capability | Bifrost | model-router | model-fallback | autopilot | Cursor Router | Why it matters |
|---|---:|---:|---:|---:|---|
| Select actual model before primary turn | **5** | 2 | 1 | **5** | **5** | Deterministic routing is more reliable than asking an LLM to delegate |
| Persistent health across restart | **5** | 1 | 2 | 4 | 3 | Broken models must stay avoided after restart |
| Failure safety: no duplicate user work | **5** | 4 | 2 | 3 | 3 | Replaying after tools/edits can duplicate side effects |
| Automatic same-turn recovery | 2 | 2 | **5** | **5** | 3 | Useful only when host semantics make replay safe |
| Explainability of decisions | 3 | 3 | 3 | **5** | 2 | Users need “why this model?” and repair guidance |
| User policy controls | 3 | **5** | 3 | **5** | 4 | Modes, overrides, status and allowlists reduce friction |
| Config safety/default portability | **5** | 2 | 4 | 3 | 2 | Defaults should work across registries without private model IDs |
| Context-window suitability | 2 | 2 | 2 | **4** | 3 | Avoid routing a long request to an unusable context window |
| Probe and health UX | 4 | 2 | 2 | **5** | 3 | Users need clear verified/unavailable model state |
| Runtime/event race hardening | 4 | 3 | **5** | 4 | 3 | Event ordering produces hard-to-reproduce routing defects |
| Maintenance surface | **5** | 3 | 3 | 1 | 3 | Smaller host integration surface means fewer protocol/security bugs |
| Host portability | **5** | 2 | 2 | 3 | 1 | Matters for future OpenCode or other host support |

### Read this scorecard correctly

- Bifrost should not chase a maximum score in every row.
- `model-fallback` wins same-turn retry by accepting replay risk and substantial lifecycle complexity.
- `autopilot` wins proxy-level control by owning HTTP, auth, SSE, forwarding, and response semantics.
- `model-router` wins multi-agent workflow governance by intentionally turning one user task into several agent tasks.
- `Cursor Router` wins per-request ML-based routing at scale with cache-aware cost optimization, but is opaque (hidden model names), enterprise-only, and IDE-locked.

Those are different products and risks. Bifrost should borrow mechanisms, not identities.

---

## 3. Where Bifrost shines

### 3.1 Direct model routing, not prompt-guided routing

Bifrost calls Pi model switching before the turn starts. The selected model is not contingent on an orchestrator model following a large system prompt, choosing to use a task tool, or complying with a delegation convention.

**Why this wins**

- predictable model selection;
- no extra delegation/model context merely to route;
- no primary-agent “I ignored routing instruction” failure mode;
- avoids turning trivial questions into multiple agent turns;
- user config maps directly to selected model behavior.

`model-router` has valuable role-specialization concepts, but it routes by persuading a primary agent to delegate. That is appropriate for multi-agent orchestration, not a substitute for Bifrost’s active-turn selection.

### 3.2 Reliability design has correct safety bias

Bifrost records runtime failure after Pi settles and routes **future prompts** around unhealthy models. It does not replay a failed prompt automatically.

This protects against:

- duplicate file changes;
- repeated shell commands;
- duplicate external API calls;
- partially completed tasks rerun without user consent;
- confusing duplicated session context.

`model-fallback` shows how much machinery transparent replay requires: first-token timers, abort propagation delay, stale event filtering, replay degradation, compaction special cases, child-session handling, locks, and plan/commit state. Its implementation is sophisticated, but replay correctness remains host- and task-dependent.

**Bifrost position:** recovery should be safe by default. Retry or replay must be explicit, idempotent, and host-supported before it becomes automatic.

### 3.3 Persisted circuit breaker is more mature than simple cooldown

Bifrost has:

- JSON persistence; state survives restart;
- circuit open/closed lifecycle;
- half-open trial after cooldown;
- trial-only success semantics (Policy A);
- configurable threshold/window/cooldown;
- batch probe outcome application;
- malformed-state fail-open behavior;
- runtime stream failure and `setModel` failure observation.

`autopilot` persists basic `ok/down` records and differentiates quota from transient failure. That is useful, but it does not replace a half-open circuit state machine. `model-fallback` tracks cooldown inside per-session state, which is less useful for cross-session model avoidance.

### 3.4 Minimal, model-agnostic default is a strategic advantage

ADR 0006’s default config intentionally contains no hardcoded model IDs. Models are discovered/populated through `/bifrost init`; default rules route only to tier names.

This reduces first-run failure, stale vendor-model config, and maintainer-specific behavior. Competitors often ship provider/model presets; those are valuable as **examples**, not as a safe universal default.

### 3.5 Core logic is already portable

Most routing and reliability policy has no Pi UI dependency. A future OpenCode package can reuse policy while translating:

| Bifrost host capability | OpenCode equivalent needed |
|---|---|
| model registry | provider/model catalog or plugin client registry |
| `setModel` | request-level model override or proxy routing |
| `agent_settled` | terminal session/message event |
| probe transport | client session prompt or provider request |
| status/overlay/commands | OpenCode TUI commands, slots, dialogs, toasts |

A proxy is only needed when target host has no official request-level model override. That is a last-resort adapter strategy, not Bifrost core architecture.

### 3.6 Verification discipline is strong

Bifrost has 165 unit tests, TypeScript checking, real TUI smoke screenshots, and a deterministic fake-provider reliability matrix. The latter validates real Pi HTTP/SSE behavior for stream errors, quota errors, and non-failure paths.

This is stronger evidence than only unit-mocking routing decisions.

---

## 4. Where Bifrost lacks

### 4.1 Decision visibility is not yet first-class

Bifrost can calculate a decision, but current user surfaces do not retain a complete structured decision trace.

A user should not need to infer routing from logs or inspect config manually. Current gaps:

- selected candidate vs rejected candidates not consistently shown;
- rule/cache/classifier/default source not displayed as a durable record;
- circuit exclusions are summarized but not fully explained in normal flow;
- model switch failure vs runtime failure are hard to compare after the fact;
- config changes cannot be confidently connected to routing outcome.

**Competitor lesson:** Autopilot carries reason/escalation/override metadata through its decision and exposes health/status commands. Bifrost should do this better without proxy complexity.

### 4.2 Failure taxonomy is too coarse for repair guidance

Current reliability tracks failure reason text and circuit state. Users need normalized classifications:

- `quota` / billing;
- `rate_limit`;
- `auth`;
- `not_found`;
- `set_model_failed`;
- `transport` / network;
- `stream_error`;
- `timeout`;
- `unknown`.

Without a taxonomy, Bifrost cannot offer targeted actions such as “re-auth provider”, “this model name is unavailable”, “wait for quota cooldown”, or “probe again.”

**Important:** raw error should remain preserved for diagnostics; category should be additive, never destructive.

### 4.3 No context-window eligibility guard

Bifrost tier selection does not yet reject a candidate that cannot fit likely request/session context before Pi attempts it.

Autopilot estimates request tokens, applies a headroom allowance, and filters candidates by declared context window. Its estimate is approximate, but it prevents obvious bad selections.

Bifrost needs a conservative design because Pi session context may include more than current prompt. A wrong estimate could falsely exclude usable low-cost models. This should be advisory/observable before enforcement.

### 4.4 User intent modes are underdeveloped

Bifrost has on/off/pinned state, strategies, and inline tier override. It does not offer a named policy layer such as:

- `economy` — bias cheap/fast tiers;
- `balanced` — current behavior;
- `quality` — prefer stronger tiers;
- `reliable` — prefer probe-verified/healthier models;
- `offline/strict` — avoid unverified or paid candidates if user chooses.

Modes should not change tier names or silently mutate user config. They should be ephemeral/explicit overlays with clear dashboard status and one-line explanation of their effect.

### 4.5 Probe data has more potential than current selection uses

Probe results can inform:

- eligibility (verified working vs unknown);
- latency ordering for `first` strategies;
- reliability-weighted selection;
- provider/model diagnostics;
- selection explanation.

Bifrost already uses probe data in init and has reliability state, but does not yet expose an intentional selection policy combining probe freshness, reliability, cost, and user intent.

### 4.6 No explicit continuation model for output truncation

Autopilot detects stream completion due to output length, makes bounded continuation requests, and preserves accumulated output. Bifrost currently treats stream behavior primarily as reliability signal.

Automatic continuation can create poor context and duplicated work. Still, users need a recovery path when output truncates. A safe first version is an explicit `/bifrost continue` recommendation/command that preserves clarity and does not pretend the original turn completed.

### 4.7 No evaluation harness for routing quality

Bifrost tests mechanics and reliability well. It does not yet have a versioned scenario corpus that asks:

- Did this prompt route to expected tier under default rules?
- Did config/mode/override change route as promised?
- Did circuit state change candidate selection as promised?
- Did low-confidence classifier output produce predictable fallback behavior?

Without this, rule and classifier changes risk subjective regressions.

---

## 5. Improvement opportunities

### Priority 0 — strengthen trust before intelligence

| Opportunity | User value | Architectural fit | Effort | Risk | Recommendation |
|---|---|---|---:|---:|---|
| Structured decision trace | Makes routing debuggable, auditable, supportable | Excellent | Medium | Low | **Do next** |
| Normalize failure categories | Tailored repair guidance and future policy | Excellent | Low-Medium | Low | **Do next** |
| Decision scenario corpus | Prevents routing regressions | Excellent | Medium | Low | **Do next** |
| Config linter | Catch missing tiers/rules/invalid model refs before runtime | Excellent | Medium | Low | **Do next** |

#### Decision trace: proposed record

```ts
interface RoutingDecisionTrace {
  id: string;
  at: string;
  promptSource: "inline_override" | "cache" | "classifier" | "regex_rule" | "default";
  requestedTier?: string;
  selectedTier?: string;
  selectedModel?: string;
  strategy?: string;
  candidates: Array<{
    model: string;
    eligible: boolean;
    rejectedBecause?: "open_circuit" | "missing" | "context_limit" | "probe_failed";
  }>;
  fallbackReason?: string;
  reliability?: { circuit: "closed" | "open" | "half_open"; trial: boolean };
  configPath: string;
}
```

Design rules:

- trace data is bounded: retain latest N records, no prompt body by default;
- retain model identifiers and reasons, not secrets/provider payloads;
- preview and actual route must use same decision builder so they cannot drift;
- trace is presentation-independent: dashboard, debug, and future hosts can render it;
- configuration failure is recorded separately from model/provider failure.

#### Failure category design

```text
raw error/event
  ↓
normalizer
  ├─ quota | rate_limit | auth | not_found
  ├─ set_model_failed | transport | stream_error | timeout
  └─ unknown
  ↓
ReliabilityStore event + persisted raw summary + category
  ↓
selection policy / user repair guidance / cooldown policy
```

Do not alter whether a failure opens a circuit until category policy is explicitly tested and configurable.

### Priority 1 — make selection more capable but predictable

| Opportunity | User value | Architectural fit | Effort | Risk | Recommendation |
|---|---|---|---:|---:|---|
| Context eligibility guard | Avoid predictable context failures | Strong | Medium | Medium | Prototype advisory mode |
| Explicit routing modes | Faster user intent changes | Strong | Medium | Medium | ADR first |
| Probe freshness + health scoring | Better first-choice candidate | Strong | Medium | Medium | Add after trace exists |
| Classifier confidence policy | Safer ambiguity handling | Strong | Medium | Medium | Evaluate against scenario corpus |
| Direct rule fallback chains | Graceful model-specific routing | Strong | Medium | Medium | Keep direct refs explicit |

#### Context eligibility: safe rollout

1. Record estimated prompt/session size and candidate context window in trace.
2. Warn in preview when estimated fit is unsafe.
3. Observe false positives/negatives in scenario tests and real usage.
4. Enable filtering only after user-configurable safety margin exists.
5. Preserve default-tier fallback when a requested tier has no eligible context candidate.

#### Modes: policy overlay, not hidden config rewrite

```text
base config tiers/rules/strategies
  +
explicit temporary mode
  ├─ economy: prefer quick / lower cost when otherwise tied
  ├─ balanced: base config behavior
  ├─ quality: elevate ambiguous or high-risk work
  └─ reliable: prefer fresh-probed / lower-failure candidates
  ↓
trace says what the mode changed
```

Modes must never silently ignore an explicit direct model override. They may influence fallback only if user understands that rule.

### Priority 2 — safe recovery and larger product capability

| Opportunity | User value | Architectural fit | Effort | Risk | Recommendation |
|---|---|---|---:|---:|---|
| Explicit output continuation | Recover from truncation | Medium | Medium | Medium | Explicit command first |
| Optional replay for read-only/idempotent prompts | Faster recovery | Weak until host guarantees exist | High | High | Research only |
| Delegated task decomposition | Cost savings on composite work | Different product boundary | High | High | Do not add to Bifrost core |
| Proxy adapter for hosts without model switching | Cross-host support | Adapter-only fallback | High | High | Only after official API check |

---

## 6. What to learn, not copy

### Learn from model-router

| Keep lesson | Do not copy |
|---|---|
| Explicit user modes and task taxonomy | Huge permanent system-prompt protocol for deterministic routing |
| Golden tests for generated user-facing output | Requiring an LLM to obey routing instructions for core correctness |
| Optional acceptance criteria for escalation | Conflating Bifrost with a multi-agent orchestrator |
| Bounded work/verification concepts | Hard-blocking normal user workflows by default |

### Learn from model-fallback

| Keep lesson | Do not copy |
|---|---|
| Plan → dispatch → commit semantics | Automatic replay of arbitrary prompt/tool/file state |
| First-token vs stream-failure distinction | Session mutation through raw/private client APIs |
| Race and stale-event test matrix | Complex retry state unless user benefit justifies it |
| Compaction needs separate handling | Assuming every host gives reliable event ordering |

### Learn from autopilot

| Keep lesson | Do not copy |
|---|---|---|
| Route reason and health/status UX | Proxy as default integration approach |
| Context-fit and health eligibility | Modifying host config automatically without clear consent |
| Distinct quota/transient backoff | Injecting model-selection badges into assistant text by default |
| Explicit user goals and allowlists | Provider/auth/SSE ownership unless unavoidable |

### Learn from Cursor Router

| Keep lesson | Do not copy |
|---|---|
| Cache-aware cost optimization across model switches | Opaque ML classifier; hide routed model identity from users |
| Explicit optimization modes (cost/balance/intelligence) | Enterprise-only gating of routing features |
| Telemetry-scale scenario validation | Training-data dependency for routing correctness |
| Per-request classification granularity | Black-box model that users cannot configure or override |

### Learn from Claude Code ecosystem gap

No existing Claude Code extension combines LLM classification, fuzzy caching, regex fallback, tier strategies, and pin support. The closest are:

- `tzachbon/claude-model-router-hook` (46★) — keyword-only UserPromptSubmit hook, no LLM classifier
- `junoseong/claude-model-router` — Haiku-based classifier, but PyPI library not integrated into agent lifecycle
- `musistudio/claude-code-router` (36k★) — external proxy, not a plugin; different architecture entirely

| Keep lesson | Do not copy |
|---|---|
| Rich hook system (UserPromptSubmit, PreToolUse) is possible without BeforeModel | Building a proxy just to intercept model selection |
| Subagent-level model constraint (subagent-bouncer) for cost control | Requiring external service (proxy) for basic routing |
| Cross-CLI ecosystem shows demand (CCR's 36k★) | Copying proxy-first architecture; keep Bifrost in-process |

---

## 7. Bifrost differentiation strategy

### Positioning

> **Bifrost is deterministic, host-native, reliability-aware model routing for coding agents.**
> It selects the active model directly, explains the decision, persists model health, and avoids replaying user work after failure.

### Product principles

1. **Direct beats implied.** Use host model-selection APIs rather than prompt instructions whenever possible.
2. **Safe degradation beats invisible recovery.** Do not repeat user work without an idempotency contract.
3. **Explain every route.** “Why this model?” is core UX, not debug-only data.
4. **Config should be portable.** Ship no personal provider/model snapshot as default.
5. **Persist reliability, not opaque magic.** JSON state must stay inspectable and repairable.
6. **Rules must be testable.** Every routing policy change gets scenario coverage and trace assertions.
7. **Adapter thin, policy shared.** Port hosts by implementing capability adapters, not by cloning Bifrost logic.

### Winning sequence

```text
1. Trust: decision trace + config lint + failure categories
2. Predictability: scenario/eval corpus + preview parity
3. Suitability: context eligibility + probe/reliability scoring
4. Control: explicit modes and direct-rule fallback chains
5. Expansion: second-host adapter if host exposes safe model override
```

This sequence delivers visible user value after each stage and avoids premature proxy/replay complexity.

### Competitive advantage summary

Verified against all known competitors (autopilot, model-router, model-fallback, Cursor Router, pi-model-router, pi-router, pi-triage, pi-failover, Aider). Bifrost is the only system that combines:

| Advantage | Bifrost | What competitors do instead |
|---|---|---|
| Direct model API, not proxy or virtual provider | Calls `setModel()` — real model visible in footer | Proxy wraps stream (autopilot, CCR); virtual provider hides real model (pi-model-router); prompt delegation (model-router) |
| Circuit breaker with half-open trials, persisted across restarts | JSON state machine survives restart, cooldown, trial-only recovery | No circuit breaker (pi-model-router, pi-triage, Aider); session-only cooldown (model-fallback); basic ok/down (autopilot) |
| Fuzzy cache for classification | Jaccard-similarity LRU cache skips classifier on near-repeat prompts | No classification cache (pi-model-router, Cursor Router, model-router, model-fallback) |
| Auto-pin on manual model switch | Detects `/model` and freezes routing until explicit `/bifrost unpin` | Manual pin only (pi-model-router); no pin concept (autopilot, Cursor Router, Aider) |
| Model-free portable default | Tier-based default, no hardcoded provider/model IDs | Ships provider/model refs (pi-model-router, model-router, autopilot); proprietary training data (Cursor Router) |
| Clean core/adapter seam | Policy modules have zero host imports; adapter is thin translation layer | Policy coupled to host API (pi-model-router, model-router, model-fallback); proxy requires external service (autopilot, CCR) |
| Structured decision trace | JSON-serialisable trace with candidate exclusions and timing | Decision objects (pi-model-router), reason strings (autopilot), in-memory logs (pi-router) — none are structured for test assertions |
| Safe no-replay reliability | Records failure after settlement; routes future prompts around unhealthy models | Transparent replay duplicates work (model-fallback, pi-failover); no failure tracking (pi-model-router, Aider) |

**What we learned from competitors that we should add:**
- Phase tracking (planning/implementation/lightweight) — pi-model-router's best insight
- Word count / multi-line heuristics before LLM classifier — pi-model-router, pi-triage
- Session budget accumulator with auto-downgrade — pi-model-router
- Capability eligibility (image) in candidate selection — pi-model-router, autopilot
- Registry-ready guard with backoff — pi-model-router

**What we confirmed we should NOT do:**
- Proxy architecture — too much maintenance and security surface (autopilot, CCR)
- Transparent replay — wrong safety model for agent work (model-fallback, pi-failover)
- Virtual profile abstraction — hides model identity from users (pi-model-router)
- Opaque ML classifier — users cannot configure or override (Cursor Router)
- Static role assignment — different problem domain (Aider)

---

## 8. Marketing translation

Competitor analysis is internal evidence, not public copy. Public marketing should communicate a clear independent promise:

> **Bifrost picks the right model for each coding task, shows why, avoids models that just failed, and never silently reruns your work.**

### Message pillars

| Pillar | User-facing claim | Evidence to demonstrate |
|---|---|---|
| Direct | "Routes the active turn directly." | Before/after route trace or live dashboard screenshot |
| Safe | "Avoids failed models without repeating tools or edits." | Circuit event timeline and explicit no-replay policy |
| Inspectable | "See why a model was selected." | Decision trace showing source, candidates, exclusions, and fallback |
| Portable | "Start from tiers, not somebody else's model list." | Empty-model default plus `/bifrost init` flow |

Avoid public feature grids that name competitors or make unmeasured cost/quality claims. Show actual Bifrost route examples instead: a quick lookup, an implementation task, an open circuit fallback, and an all-candidates-exhausted explanation.

### Expert review before commitment

Before roadmap work begins, use a small review panel with independent lenses:

1. **Routing/reliability reviewer:** validates state machine, event timing, and no-replay safety.
2. **Pi extension reviewer:** validates host API constraints, UI/context behavior, and testability.
3. **Product/UX reviewer:** validates that decision traces/modes reduce confusion rather than expose internals.
4. **Go-to-market reviewer:** turns evidence into differentiated, accurate landing-page claims.

Give each reviewer the same scenario corpus and ask for: missing failure modes, user-visible ambiguity, maintenance cost, and claim evidence. Treat consensus as input, not authority; preserve Bifrost principles above.

---

## 9. Measurement plan

Do not claim superiority from architecture alone. Measure it.

### Core metrics

| Metric | Definition | Target direction |
|---|---|---|
| Route explainability | % routes with source, selected model, candidate exclusions, fallback reason | 100% |
| First-attempt usability | % user turns selecting an available, context-fitting model | Up |
| Circuit effectiveness | % attempted selection of models with known-open circuit | Down toward 0 |
| False circuit rate | healthy models incorrectly opened from runtime observation | Down |
| Recovery clarity | % all-candidate-failure outputs containing actionable category/remedy | 100% |
| Config validity before runtime | config errors caught by init/lint rather than on turn | Up |
| Routing regression rate | expected scenario route changed unintentionally | Down toward 0 |
| Host adapter duplication | policy lines copied between host implementations | Down toward 0 |

### Scenario corpus seed

| Scenario | Expected assertion |
|---|---|
| Short lookup | `quick` requested/selected when configured candidate healthy |
| Implementation prompt | `general` requested/selected |
| Architecture/security prompt | `frontier` requested/selected |
| Explicit tier override | override wins classification; trace says override |
| Direct model rule | direct model is attempted; explicit fallback rule shown if unavailable |
| Requested-tier circuit open | next eligible requested candidate or default-tier fallback |
| All circuits open | no selection; `all_tiers_exhausted` trace and user action |
| Quota error | circuit/failure trace identifies quota; next prompt avoids model |
| Stream failure after output | failure recorded after settlement; no prompt replay |
| Missing general tier from init | generated default/strategies only reference populated tiers |
| Context too large | advisory warning then, after rollout, unsuitable candidate excluded |

---

## 10. Risks and guardrails

| Risk | Guardrail |
|---|---|
| Feature creep toward orchestration | Keep subagent/task delegation outside Bifrost core scope |
| Hidden policy surprises | Every mode/fallback rule emits trace reason and dashboard state |
| Retry duplicates user work | No transparent replay without explicit idempotency boundary |
| Untrusted model metadata | Context fit begins advisory; make estimates/fudge factor visible |
| Configuration complexity returns | Minimal default remains empty-model/tier-based; advanced configs live in `examples/` |
| Persistent-state corruption | Continue fail-open normalization and atomic human-readable writes |
| New adapter forks policy | Extract capability interfaces only when second host work begins |
| Competitor claim chasing | Run common scenario matrix; cite observed behavior, not README savings claims |

---

## Conclusion

Bifrost does not need to become a proxy, a replay engine, or a multi-agent manager to compete. Its durable advantage is smaller and stronger: **select the right model directly, know which models are unhealthy, never silently repeat user work, and make every routing decision inspectable.**

Next best move: decision trace + config lint + failure taxonomy, backed by a routing scenario corpus. These close the most important trust gaps while reinforcing Bifrost’s existing architecture.
