# Pi extension router landscape

Research notes for Pi-native extensions. Separate from [OpenCode router landscape](opencode-router-landscape.md).

## Scope and sources

Shallow clones live outside this repository at `/tmp/bifrost-pi-extension-research`.

| Project | Commit inspected | Evidence reviewed | Role |
|---|---|---|---|
| [`yeliu84/pi-model-router`](https://github.com/yeliu84/pi-model-router) | `002b48f` | Architecture, provider/routing/state/index code, 7 test files | Closest direct tier-router peer |
| [`jiangge/pi-router`](https://github.com/jiangge/pi-router) | `caf4ba0` | Architecture, router implementation, route logic, 3 test files | Same-model multi-provider/channel routing |
| [`JoshTickles/pi-failover`](https://github.com/JoshTickles/pi-failover) | `5c32ab5` | Provider stream/failover code and real Pi subprocess integration tests | Failover + prompt replay comparator |
| [`alpozcan/pi-triage`](https://github.com/alpozcan/pi-triage) | `bf99046` | Full single-file extension; no automated tests found | Heuristic/LLM triage and discovery comparator |
| [`nicobailon/pi-model-switch`](https://github.com/nicobailon/pi-model-switch) | `e2798ea` | Full single-file extension; no automated tests found | Explicit agent-driven model-switch UX |

Additional candidates discovered, not source-reviewed yet:

- [`sunnysmol/privacy-guard`](https://github.com/sunnysmol/privacy-guard) — routes PII-bearing prompts local.
- [`xilnick/pi-fallback-provider`](https://github.com/xilnick/pi-fallback-provider) — fallback provider/cache.
- [`HyeokjaeLee/pi-auto-fallback`](https://github.com/HyeokjaeLee/pi-auto-fallback) — fallback chain and context switching.
- [`beettlle/pi-smart-router`](https://github.com/beettlle/pi-smart-router) — economical/frontier session router.
- [`jiangge/pi-router`](https://github.com/jiangge/pi-router) and [`yeliu84/pi-model-router`](https://github.com/yeliu84/pi-model-router) are current closest matches; review these before expanding scope.

---

## Executive read

Pi’s ecosystem already contains all major routing shapes:

```text
Bifrost                    direct Pi model switch per prompt; persisted reliability
pi-model-router            virtual provider → route to tier model inside stream
pi-router                  virtual model → route same model across provider channels
pi-failover                custom stream failover + error-driven model swap/replay
pi-triage                  initial heuristic/LLM tier choice + suggested later escalation
pi-model-switch            explicit agent tool selects model by capability/name
```

**Bifrost remains differentiated** by combining direct host-native selection, persisted half-open circuit state, safe no-replay behavior, minimal model-agnostic defaults, and real provider/TUI E2E verification.

The strongest Pi lessons are decision history, model/channel identity, pre-content-only transparent failover, context/window eligibility, and user-visible dry-run/diagnostic controls.

---

## 1. `pi-model-router`: closest direct routing peer

Full source analysis at commit `002b48f` (v0.4.4). Cloned to `/tmp/bifrost-pi-model-router`. All source files read. 2,344 LOC TypeScript across 8 source files + 7 test files.

### Architecture: virtual provider pattern

pi-model-router registers a virtual `router` provider whose models are **profiles** (e.g. `router/balanced`, `router/code`). A profile has three tiers: `high`, `medium`, `low`. Each tier maps to a concrete `provider/model` string with optional fallbacks.

The key architectural difference from Bifrost: **pi-model-router wraps the entire stream layer**. When a profile is selected as pi's active model, every request flows through `streamSimple` in `provider.ts:249-607`. This intercepts the full request lifecycle:

```
user prompt → pi → router/balanced (virtual)
                       ↓
         streamSimple() intercepts every request
                       ↓
               decideRouting() → heuristic pipeline
                       ↓
               optional LLM classifier (runClassifier)
                       ↓
               image capability eligibility check
                       ↓
               Google thinking tool-continuation guard
                       ↓
               try model → try fallbacks → delegate stream
                       ↓
               stream push events back to pi
```

Bifrost instead calls `pi.setModel()` before the turn, letting pi's native streaming handle the request. This is a more transparent approach — the actual model identity is visible in the footer, and there is no custom stream wrapper.

### Routing pipeline (detailed)

`decideRouting()` in `routing.ts:133-387` — called on every turn:

1. **Pinned tier check** — if `/router pin high` is set, use pinned tier directly, skip all heuristics.
2. **Custom keyword rules** — configurable `{ matches, tier }` rules, checked against last user prompt text. Highest-matching tier wins.
3. **Heuristic phase detection** (the most sophisticated part):
   - **Explicit hints**: `"think hard"` → high, `"briefly"` → low
   - **Planning keywords**: `"analyze"`, `"architecture"`, `"design"`, `"migration"`, `"strategy"`, `"compare"`
   - **Summary keywords**: `"summarize"`, `"changelog"`, `"reformat"`, `"tl;dr"`
   - **Implementation keywords**: `"implement"`, `"fix"`, `"refactor"`, `"continue"`, `"go ahead"`
   - **Lookup keywords**: `"where is"`, `"find"`, `"grep"`
   - **Word count thresholds**: >40 words → high, <4-12 words → low (with phase-bias adjustment)
   - **Multi-line detection**: 4+ lines → high
   - **Phase stickiness**: previous phase biases thresholds (planning lowers high-threshold, implementation raises low-threshold)
   - **Tool result count**: >0 → phase = implementation
4. **LLM classifier** (optional, runs only if not pinned, not rule-matched, and budget not exceeded): uses a configurable model to classify the prompt into high/medium/low with a reasoning string. Skips if no classifier model configured, if model unavailable, or if auth fails. Errors are silently caught and fall back to heuristic result.
5. **Budget downgrade**: if `maxSessionBudget` is exceeded and tier is `high`, downgrade to `medium`. Budget accumulates from actual stream cost.
6. **Tier availability resolution**: if the selected tier isn't configured in the profile, resolve "up" (low→medium→high), then "down" as last resort.
7. **Image capability eligibility** (`provider.ts:346-396`): if the prompt has image attachments and the selected tier's model doesn't support images, try higher tiers. This runs AFTER the routing decision and overrides the selected tier.
8. **Google thinking tool-continuation guard** (`provider.ts:322-344`): if continuing a Google thinking model's tool result, preserve the exact same model — switching breaks thought-signature replay.

### State management

Persists via `pi.appendEntry('router-state', ...)` — custom session entries that stay with Pi's branch history. This means:

- State is **per-session-branch**, not per-project. Switching branches restores branch-specific pins/history.
- Snapshot-based change detection: serializes state to JSON and compares against last snapshot before writing.
- Includes: enabled, selectedProfile, pinTier, pinByProfile, thinkingByProfile, debugEnabled, widgetEnabled, debugHistory (50 entries max), lastPhase, lastDecision, lastNonRouterModel, accumulatedCost.
- Reload on session_start: reads branch entries, finds last matching state, restores pins/thinking/history.

This is more sophisticated than Bifrost's file-based persistence for user-intent state. However, reliability state (circuit breakers) should remain file-based since it must survive across sessions and branches.

### Reliability model: absent

**No circuit breaker. No persisted health state. No half-open trials.** The only fallback mechanism is the `fallbacks[]` array per tier — a linear list of model refs tried in order. If all fail, the error propagates to the user.

Error handling in `provider.ts:429-558`:
- Try primary model from decision.
- If `registry.find()` fails → try next fallback.
- If auth fails → try next fallback.
- If stream throws before `contentReceived` → try next fallback.
- If content has been received and stream errors → error is forwarded, not retried (correct safety).
- If all exhausted → throw last error.

This is where Bifrost is structurally ahead: pi-model-router has no concept of a circuit state machine, no cooldown, no cross-session avoidance, no failure taxonomy.

### Decision history

Rich `RoutingDecision` object (types.ts:58-72):
```ts
{ profile, tier, phase, targetProvider, targetModelId, targetLabel,
  reasoning, thinking, timestamp, isClassifier, isFallback,
  isBudgetForced, isRuleMatched }
```

Stored in debug history (max 50). Viewable via `/router debug show`. Displayed in `/router status` output. Each decision carries a human-readable `reasoning` string explaining why it was chosen (e.g. "Detected planning, broad analysis, or a high-complexity request."). Flags indicate override sources.

No structured trace format for dashboard/preview. No candidate exclusion record. No timing information. No test assertions against decision objects.

### Key strengths for Bifrost to learn

| Strength | What Bifrost should do |
|---|---|
| **Phase system** (planning/implementation/lightweight) | Track conversation phase across turns for sticky tier selection |
| **Word count + multi-line heuristics** before LLM classifier | Add cheap deterministic signals before classifier invocation |
| **Budget tracking** with auto-downgrade | Add session cost accumulator and configurable max |
| **Image capability eligibility** | Add capability filter in candidate selection (image first, then context) |
| **Thinking level per tier** with clamping | Add thinking-level awareness to tier strategy |
| **Context-window honesty** (advertise profile max, truncate per-request) | Add advisory context-fit warning before automatic filtering |
| **Session-branch persistence** for user intent/pins | Use session entries for pins/modes alongside file-based reliability |
| **Exponential backoff registry wait** | Add registry-ready guard for subagent contexts |
| **10 subcommands with autocomplete** | Expand Bifrost command set with similar autocomplete polish |
| **Google thinking model continuity** | Keep provider-specific guards as adapter-level, not core |

### Key weaknesses to avoid

| Weakness | Why Bifrost should not follow |
|---|---|
| **No reliability state** (no circuit breaker) | Single biggest gap. Bifrost's circuit breaker is a core differentiator |
| **Virtual model hides actual identity** | Footer shows `router/balanced`, not the real model. Bifrost keeps real model visible |
| **Linear fallback without health awareness** | Every fallback tried regardless of prior failure. Bifrost filters by circuit health |
| **No fuzzy cache** | Every prompt runs full heuristic + optional classifier. Bifrost's Jaccard cache is more efficient |
| **No structured trace** | Debug history is internal/browsing-only. Bifrost's trace is testable and serializable |
| **No config linter** | Normalization produces warnings once at reload. Bifrost's `/bifrost validate` is persistent |
| **Profiles ship model refs** | Less portable than Bifrost's model-free default |
| **Fallback-only before content** | Correct but unexplained. Bifrost's explicit future-turn avoidance is clearer |

### Comparison with Bifrost

| Capability | Bifrost | pi-model-router | Advantage |
|---|---|---|---|
| Model selection approach | `setModel()` before turn | Virtual provider wraps stream | Bifrost: transparent model identity |
| Classification | LLM + regex + fuzzy cache | Heuristics + optional LLM | pi-model-router: richer heuristics; Bifrost: cache |
| Tier system | Configurable named tiers + patterns | Fixed high/medium/low per profile | Bifrost: more flexible |
| Strategy within tier | first/cheapest/random/largest_context | Linear fallback list only | Bifrost: more strategies |
| Reliability | Circuit breaker, half-open, persisted | None (basic fallback list) | **Bifrost wins decisively** |
| Phase tracking | None | planning/implementation/lightweight | pi-model-router: valuable addition |
| Budget | None | Session cost + auto-downgrade | pi-model-router: useful for cost control |
| Context handling | None | Honesty check + truncation | pi-model-router: useful (advisory first) |
| Thinking level | None | Per-tier with clamping | pi-model-router: useful if Bifrost adds thinking |
| Image capability | None | Escalation to image-capable tier | pi-model-router: useful capability guard |
| Model identity | Real model in footer | Virtual profile hides real model | **Bifrost wins decisively** |
| State persistence | File-based (global) | Session entries (branch-aware) | Different tradeoffs; both valid for intent state |
| Cache | Jaccard-similarity fuzzy | None | Bifrost: more efficient |
| Portability | Clean core/adapter seam | Tied to Pi provider API | Bifrost: more portable |
| Config portability | Model-free default | Ships model refs | Bifrost: more portable |
| Decision visibility | Dashboard, preview, debug | Status command, debug show | Bifrost: more accessible |
| Test coverage | 165 unit + UI + provider E2E | 7 test files | Bifrost: broader coverage |

### Bifrost lessons from deep source review

1. **Add phase tracking.** Track conversation phase (planning/implementation/lightweight) and use it for sticky tier selection. This is the single most valuable thing pi-model-router does that Bifrost doesn't. Cheap signal, large impact.

2. **Add cheap heuristics before classifier.** Word count, multi-line detection, explicit hint keywords, tool result count — all run before the LLM classifier. This would reduce classifier calls for clear-cut cases.

3. **Add session budget accumulator and auto-downgrade.** Track cost per session, allow users to set `maxSessionBudget`, auto-downgrade high tier when exceeded. Simple state addition.

4. **Add capability filter to candidate selection.** Image support is the obvious first capability. Check against registry model metadata before selecting.

5. **Keep session-branch persistence for user intent (pins, modes) alongside file-based reliability.** Best of both: pins follow branches, circuit breakers survive restarts.

6. **Add registry-ready guard with backoff.** Use exponential backoff to handle the subagent race condition where `session_start` hasn't fired yet.

7. **Do NOT adopt the virtual profile abstraction.** Hiding the actual model identity from the user is the wrong tradeoff for Bifrost's transparency-first design.

8. **Do NOT adopt silent context truncation.** Bifrost should first expose advisory context-fit warnings, then offer automated truncation as an opt-in.

---

## 2. `pi-router`: channel routing peer

### Architecture

`pi-router` maps a virtual model to a canonical upstream model over multiple **channels** (providers). It prioritizes channel failover before model fallback:

```text
router/claude-opus
  → provider A / same model
  → provider B / same model
  → provider C / same model
  → fallback model across channels
```

It exposes configuration for channel ordering (`manual`, `capabilityFirst`, `costFirst`, `latency`), sticky successful route, cooldown, circuit breaker, latency records, health probes, context transfer, route snapshots, and decision logging. It has a route registry that other extensions can query by symbol-based adapter interface.

### What it does well

- **Separates same-model/provider failover from model downgrade.** This preserves quality/model behavior when one gateway is down.
- **Channel identity is explicit.** Routes can include channel plus upstream model variant; avoids assuming a canonical model ID resolves identically across providers.
- **Latency-aware ordering.** Tracks time-to-first-token and can sort provider channels using observed performance.
- **Decision history / explain commands.** Architecture specifies `/router explain` and `/router decisions`, a direct precedent for Bifrost decision traces.
- **Cross-extension integration seam.** Route snapshot/registry lets other Pi extensions learn resolved upstream identity without hard-coding router internals.
- **Pre-content stream safety intent.** Architecture test plan names stream commit safety: no failover after committed output.

### Limits and risks

- **Large surface area.** Custom provider, provider route discovery, config wizards, footer behavior, health probing, summaries, context sanitation, and inter-extension protocol all increase maintenance risk.
- **Transparent model fallback requires context transfer.** Summary/full transfer introduces model calls, context loss, cache loss, and possible duplicate work.
- **Decision logs are in-memory per architecture doc.** Useful live diagnostics but weaker than Bifrost’s persisted reliability state.
- **Footer replacement option conflicts with Bifrost UX constraint.** `pi-router` supports replacing Pi’s footer for route alignment. Bifrost must continue using `setStatus`, preserving Pi default footer.
- **Documentation exceeds independently verified implementation scope.** Treat feature claims as source leads; test exact runtime behavior before copying.

### Bifrost lessons

1. Add channel/provider as a first-class future candidate dimension without changing basic tier abstraction.
2. Record candidate **route** (`provider/model`, perhaps channel) rather than only a friendly tier.
3. Learn latency from probe and runtime TTFT, but never make hidden latency scoring override explicit user strategy without trace explanation.
4. Build a small documented inter-extension capability interface only after a concrete integration needs it; do not adopt global symbol protocol preemptively.
5. Keep status surface additive; do not replace Pi footer.

---

## 3. `pi-failover`: strongest failover/replay warning

### Architecture

Two mechanisms:

1. A custom `failover` provider streams from configured Anthropic-compatible backends, retries a different backend if request fails.
2. Error listeners observe assistant message errors; after retries are exhausted it calls `setModel` then re-sends last captured user prompt as a follow-up.

It has four test files, including a real Pi subprocess integration test with mock HTTP/SSE servers for 429, connection failure, and model swap/retry.

### What it does well

- **Real host integration testing:** mock providers + `pi -p` validates custom stream behavior beyond unit tests.
- **Custom-stream failover resets output before retrying another backend.** This is appropriate when no meaningful stream output has committed.
- **Clear status/tool diagnostics:** user can inspect backend health and fallback chain.
- **Classifies retryable provider errors:** quota, 429/5xx, capacity, timeout, connection errors.

### Safety concern

The automatic model-swap path captures `lastUserPrompt` and calls `sendUserMessage(..., { deliverAs: "followUp" })` after an agent error. It does not establish that previous generation made no tool calls, file changes, or external side effects.

This can duplicate work after a partial turn. It also changes session semantics by appending a follow-up rather than retrying original request in place.

### Bifrost conclusion

Bifrost’s policy — record runtime failure after settlement and route future prompts around failure — is safer by default. Keep it.

Potential limited future exception requires all of:

- host proves no assistant text/tool event has committed;
- original request is still idempotent;
- user explicitly enables retry or confirms it;
- trace reports retry and reason;
- deterministic E2E covers duplicate-work boundaries.

Until then, no automatic prompt replay.

---

## 4. `pi-triage`: classification and discovery peer

### Architecture

Single-file extension routes initial prompt to `light`/`medium`/`heavy`.

Signal pipeline:

1. keyword rule matching;
2. heuristic scores: complexity, code content, error patterns, multi-step language, file hints, architecture terms;
3. session boost from tool count, changed file count, previous escalation;
4. optional LLM JSON triage if heuristic confidence is low;
5. `setModel` selected tier;
6. later prompts may trigger a **user-confirmed** escalation suggestion.

It reads Pi `models.json`, probes API-key availability, derives model tiers from cost/capability heuristics, handles duplicate model/provider choices interactively, and disables routing when only one model exists.

### What it does well

- **Cheap-first classification:** deterministic keywords/heuristics run before LLM classification.
- **Confidence gate:** LLM fallback only below confidence threshold.
- **Auto-discovery:** can become useful without a hand-authored model map.
- **User-confirmed mid-session upgrade:** recognizes cache/model-switch cost and asks rather than silently switching.
- **Dry-run UX:** `/triage dry-run <prompt>` explains signals, confidence, session boost, selected tier, and whether AI fallback would run.
- **Graceful small-pool handling:** disables routing when one model exists; collapses tiers sensibly with two models.

### Limits and risks

- **Only routes first prompt automatically.** Later adjustments are suggestions, so it is not a per-turn router.
- **No automated tests found.** Complex model discovery and heuristic policy lack regression evidence.
- **Reads `models.json` directly.** Registry APIs are safer for host compatibility than internal storage format assumptions.
- **Auto-discovery treats cost/capability metadata as truth.** Missing/incorrect metadata can create poor choices.
- **User manual model change disables routing globally for session.** This is respectful, but too coarse when users expect a temporary override.
- **Classifier uses model generation directly with JSON parsing.** Needs strict schema/robust parse policy and separate reliability accounting.

### Bifrost lessons

1. Add confidence visibility and classifier fallback reason in decision trace.
2. Provide a dry-run command/overlay that shares exact decision builder with real routing.
3. Handle one/two-model registry pools explicitly in `/bifrost init` and dashboard.
4. Preserve user override intent as a scoped pin/temporary bypass rather than broadly disabling state.
5. Do not copy direct `models.json` coupling; retain `modelRegistry` as source of truth.

---

## 5. `pi-model-switch`: user/agent control peer

### Architecture

A small tool lets the agent list, search, and switch models via `pi.setModel`. It supports aliases mapping a friendly term to one or more `provider/model` candidates, searches registry metadata, detects ambiguity, and reports model reasoning/vision/context/cost metadata.

### What it does well

- **Focused capability search.** Lets agent find models by provider/name and inspect capability/cost/context details.
- **Aliases with fallback list.** An alias can try multiple candidate models in order.
- **Ambiguity is surfaced.** It refuses loose switches when multiple models match.
- **Uses registry rather than private model file.** Good host integration discipline.

### Limits

- No routing policy, health state, probe, classification, persistence, or tests.
- Agent-authorized model selection can conflict with user intent without a visible policy layer.

### Bifrost lessons

1. Improve model inspection/search in `/bifrost` dashboard or init flow.
2. Consider alias/fallback chains only as explicit user config, preserving exact resolved model in trace.
3. Continue keeping automatic routing policy separate from an agent tool that can select arbitrary models.

---

## Cross-Pi comparison

| Capability | Bifrost | pi-model-router | pi-router | pi-failover | pi-triage | pi-model-switch |
|---|---:|---:|---:|---:|---:|---:|
| Per-prompt actual-model choice | **Yes** | Yes, inside virtual provider | Mostly channel/model route | No, failure-driven | First prompt only | Agent requested |
| Actual chosen model visible by default | **Yes** | Weak (virtual profile visible) | Mixed (virtual model; explain route) | Yes | Yes | Yes |
| Persisted circuit breaker | **Yes** | No equivalent found | In-memory/config-oriented | Backend cooldown only | No | No |
| Half-open trial | **Yes** | No | Documented | No | No | No |
| Safe post-output behavior | **Future-turn reroute** | No retry after content | Intended no failover after committed output | Auto replay risk | No retry | N/A |
| Probe / latency evidence | Probe + E2E | No dedicated probe | Health probe + TTFT | No probe | API-key probe only | No |
| Decision trace/history | Partial dashboard/debug | Persisted debug history | Explain + in-memory decisions | Status only | Dry-run/history | Tool result only |
| Config default portable | **Yes** | Model/profile config required | Channel config required | Backend/model config required | Discovery-oriented | Alias optional |
| Test evidence observed | **165 unit + UI + provider E2E** | 7 test files | 3 test files | 4 test files incl Pi E2E | None | None |

---

## Pi-specific Bifrost advantages to protect

1. **Status, not footer replacement.** Pi default footer stays intact; Bifrost uses `setStatus("bifrost-state", ...)`. Do not copy router footer replacement.
2. **Ephemeral preview.** Preview/benchmark uses overlay and does not create session entries or LLM context.
3. **Actual model identity.** Bifrost routes real models, so footer/model state reflects actual selected model rather than an abstraction.
4. **Reliability persistence is config-driven and human-readable.** State survives restart and remains inspectable.
5. **No unsafe replay.** Do not downgrade this advantage for feature parity.
6. **Default config does not assume registry/vendor.** `/bifrost init` discovers/populates models; shipped config remains minimal.

---

## Pi-specific gaps to prioritize

| Gap | External precedent | Bifrost-fit improvement |
|---|---|---|
| Route explanation | pi-router `/router explain`, pi-triage dry-run, pi-model-router history | Structured decision trace powering preview/dashboard/debug |
| Candidate capability guard | pi-model-router image/context handling | First image/capability, then advisory context eligibility |
| Probe/latency-aware ranking | pi-router TTFT sort | Fresh probe latency used only within configured strategy, traced |
| Classifier confidence UX | pi-triage | Show confidence/source/fallback; use scenario corpus before changing policy |
| Explicit temporary user intent | pi-model-router pins; pi-triage confirmation | Scoped Bifrost pin/mode, not blanket router disable |
| Small model-pool UX | pi-triage one/two-model behavior | Init/dashboard state tells user routing cannot provide meaningful choice |
| Friendly inspection/aliases | pi-model-switch | Optional explicit model alias/reference validation |

---

## Recommendations

### Adopt conceptually

1. **Decision trace + dry-run parity** — highest value, lowest architectural risk.
2. **Model capability eligibility** — image support first; context fit advisory before automatic filtering.
3. **Fresh latency/probe evidence in selection explanation** — never an unannounced strategy override.
4. **Small-pool detection** — explicitly explain when no meaningful routing choice exists.
5. **Explicit user modes/pins** — scoped and traceable.

### Study, but defer

1. **Channel-first routing** — valuable if multiple providers expose same model; needs a clean Bifrost candidate route model and test matrix.
2. **Session-entry persistence for user routing intent** — useful for branch-specific state; retain file persistence for reliability.
3. **Inter-extension route identity protocol** — only after concrete Pi ecosystem integration.

### Do not adopt by default

1. Replaying last prompt after any agent error.
2. Silent context truncation to make a route fit.
3. Footer replacement.
4. Direct parsing of Pi internal `models.json` for source-of-truth routing.
5. Virtual model/profile abstraction that conceals actual selected model.

---

## Next research questions

1. Does `privacy-guard` offer a better model for rules that must override normal tier policy (local-only prompts)?
2. Does `pi-fallback-provider` implement safe pre-content failure boundaries differently?
3. Can Pi expose provider/channel metadata without custom virtual provider complexity?
4. Which Bifrost decisions should persist by session branch (pins/modes) vs globally by project (reliability/probe data)?
5. Can a common fake-provider matrix test Bifrost and Pi peers against same stream/error scenarios?
