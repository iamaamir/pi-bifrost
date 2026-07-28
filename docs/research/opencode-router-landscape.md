# OpenCode router landscape

Research notes. No product commitment. Sources shallow-cloned outside this repo under `/tmp/bifrost-opencode-router-research`.

## Scope and sources

| Project | Commit inspected | Architecture | Why relevant |
|---|---|---|---|
| [`marco-jardim/opencode-model-router`](https://github.com/marco-jardim/opencode-model-router) | `b8bef97` | OpenCode plugin; registers tiered subagents and injects an orchestration protocol | Closest tier-routing UX and policy competitor |
| [`Agent-Pattern-Labs/opencode-model-fallback`](https://github.com/Agent-Pattern-Labs/opencode-model-fallback) | `ea88f94` | OpenCode plugin; intercepts lifecycle events and replays requests on fallback models | Closest runtime-failure/reliability comparator |
| [`yagneshempyreal-dotcom/opencode-autopilot`](https://github.com/yagneshempyreal-dotcom/opencode-autopilot) | `30b9999` | Local OpenAI-compatible proxy registered as an OpenCode provider | Closest full per-request router |

Related portability/adapter projects found but not source-reviewed yet:

- [`sigilco/agentplugins`](https://github.com/sigilco/agentplugins) — multi-host plugin adapter framework (includes Pi and OpenCode).
- [`caiokf/valet`](https://github.com/caiokf/valet) — headless unified API across coding CLIs, including Pi and OpenCode.
- [`loonbac/pi-claude-code`](https://github.com/loonbac/pi-claude-code) — Pi port of an OpenCode plugin; useful adapter precedent.

No direct Pi Bifrost → OpenCode adapter was found.

---

## Architecture map

### Bifrost today

Bifrost is **host-native routing**:

1. Read registry and project config.
2. Classify prompt into configured tier.
3. Pick a healthy model using tier strategy.
4. Call Pi's model-selection API before turn runs.
5. Persist circuit state, observe runtime outcome after settlement, and avoid bad candidates on later turns.

Core policy/state modules are host-independent or nearly so: `config.ts`, `routing.ts`, `classifier.ts`, `cache.ts`, `reliability.ts`, `reliability-store.ts`, `runtime-reliability.ts`, and `inline-override.ts`. Pi integration is concentrated in `index.ts`, `commands.ts`, `ux-status.ts`, `result-viewer.ts`, and probe transport.

### model-router

**Delegation router, not active-turn model router.**

- `config` hook registers `fast`, `medium`, and `heavy` as OpenCode subagents, each fixed to a configured model.
- `experimental.chat.system.transform` injects a detailed routing/delegation protocol into primary-agent system prompts.
- Primary model is instructed to delegate exploration, implementation, and deep analysis through OpenCode's `Task` capability.
- Adds tool-call caps, repeated-read detection, optional hard blocks, narration detection, a task verification gate, and quality escalation for plugin-created subagents.
- Persists active preset/mode/enforcement as separate JSON state; atomically writes state.

This optimizes a **multi-agent workflow**, not direct model selection for every user prompt. Its actual route depends on primary agent obeying prompt instructions.

### model-fallback

**Event-driven transparent replay.**

- Watches `session.error`, provider retry status, idle state, message updates, deltas, and compaction events.
- Holds per-session state: current model, failed models, fallback index, pending replay, first-token marker, parent relation, and locks.
- On error/timeout, aborts if needed, waits for abort propagation, finds last replayable user/non-assistant message, then calls OpenCode `promptAsync` with next model.
- Uses plan → dispatch → commit to limit race windows. Has special handling for stale events, TTFT, child sessions, replay degradation, and compaction.

This is a sophisticated recovery layer, but it deliberately retries same user work. It has materially different correctness tradeoffs from Bifrost.

### autopilot

**Router-as-provider proxy.**

- Starts a localhost OpenAI-compatible proxy and patches/registers an `openauto/auto` provider in OpenCode.
- Receives every `/v1/chat/completions` request, classifies complexity, applies goal matrix + sticky quality floor + manual override + context-window filtering + health filtering, and forwards to selected provider/model.
- Maintains JSON health records. Supports probe-all, concurrency-limited verification, status-specific backoffs, candidate fallback during dispatch, tags, allowlists, premium mode, and output-limit continuation.
- Rewrites/forwards HTTP and SSE response streams, including optional routing badge injection.

This has strongest routing control because proxy owns request. It also owns hardest compatibility surface: auth, provider protocol variants, SSE semantics, streaming, error shaping, persistence, and config mutation.

---

## What each does well

| Capability | model-router | model-fallback | autopilot | Bifrost status |
|---|---|---|---|---|
| Tier concepts | Strong task taxonomy, modes, presets, explicit role contracts | Not scope | Goal matrix and free/cheap/top tiers | Strong configurable tiers + rules; minimal default |
| Active model selection before turn | Delegates through primary agent; indirect | Only after failure | Strong — proxy selects target model | Strong — Pi `setModel` before turn |
| Runtime failure recovery | Prompt-level provider chain only | Very strong replay/race handling | Strong proxy candidate fallback + health | Strong future-turn avoidance; intentionally no replay |
| Persistent health | No circuit breaker equivalent | Session-only cooldown | JSON health + distinct transient/quota backoff | JSON circuit breaker, half-open trial, persisted across restart |
| Probe UX | Not primary focus | Not primary focus | Probe-all + auto-pin verified models | Probe + persisted reliability state |
| User controls | Preset, budget, enforce, bypass, plan annotation | Config + toast | Goal, status, health, allowlist, free mode | Init, probe, preview, dashboard, pin, debug |
| Tests | Broad unit/integration/golden/smoke structure | 13 focused TS test files, especially races | Many unit + proxy integration tests | 165 unit tests + Pi UI smoke + fake-provider reliability E2E |

### model-router lessons

1. **Modes can express user intent better than one global strategy.** `budget`, `normal`, `quality`, and `deep` are understandable policy presets.
2. **Task decomposition is a distinct feature.** Fast research → stronger implementation is not same as choosing one model for a whole user turn.
3. **Acceptance criteria can make escalation meaningful.** Their optional Definition-of-Done gate separates "model responded" from "work passed verification".
4. **Golden tests for prompt/config output are useful** where Bifrost has user-facing generated config and preview text.

### model-fallback lessons

1. **Failure paths are race-prone.** It explicitly guards duplicate event sources, stale errors, abort propagation, TTFT timers, compaction, and child sessions.
2. **Plan → side effect → commit** is safer than mutating fallback state before dispatch succeeds.
3. **First-token tracking** is a useful distinction: timeout before output differs from stream failure after output.
4. **Per-error-class policy matters.** Rate/quota/transient/model-not-found should not share identical handling.

### autopilot lessons

1. **Decision quality improves with multiple signals.** It combines heuristic complexity, optional model triage, task tags, context-window fit, health, sticky floor, and user goal.
2. **Health behavior should distinguish transient from quota.** Current values are 5-minute retry for transient down vs 60-minute retry for quota/billing.
3. **Decision explanations should be first-class.** Its decision includes `reason`, `escalated`, and `override`; user status output exposes model pools and health.
4. **Output-limit continuation is a separate reliability concern.** It continues `finish_reason: length` responses with bounded hops, preserving accumulated text.

---

## Bifrost strengths to protect

1. **Direct routing, not prompt obedience.** Bifrost chooses Pi active model before generation. No giant delegation protocol, primary-agent compliance dependency, or subagent cost overhead.
2. **No automatic prompt replay.** Bifrost does not duplicate a user request after tools/partial output. This prevents repeated edits, duplicate external side effects, and confusing session history. Keep this default unless a host supplies idempotent replay semantics.
3. **Circuit state is persisted and half-open.** Bifrost survives restart and uses trial-only recovery. `model-fallback` cooldown lives in session state; `autopilot` health is persistent but simpler than Bifrost's circuit model.
4. **Minimal registry-agnostic default.** ADR 0006 avoids shipping a maintainer-specific model snapshot. `model-router` ships provider/model presets; useful as examples, poor as Bifrost default policy.
5. **Host-real verification.** Bifrost uses real Pi TUI smoke and deterministic fake OpenAI/SSE reliability E2E, not only mocked function tests.
6. **Clean core/adapter seam.** Bifrost is substantially more portable than plugin/proxy code that couples policy directly to OpenCode hook semantics.

---

## Gaps worth considering

These are candidates, not commitments.

### High-value, low-risk

1. **Decision trace / reason ledger.** Record: requested tier, rule/classifier/cache source, eligible candidates, rejected candidates and reason, selected model, fallback reason, circuit state. Surface in preview/dashboard/debug. This makes routing debuggable without Autopilot's proxy complexity.
2. **Decision-centric tests.** Add snapshot/golden tests for `/bifrost init` proposal, preview output, and invalid-config diagnostics. Core logic already has strong unit coverage; generated UX remains a drift risk.
3. **Failure taxonomy in persisted records.** Preserve normalized cause categories (`quota`, `rate_limit`, `auth`, `not_found`, `transport`, `stream`) next to raw error. It enables tailored cooldown and user repair advice without changing base circuit semantics.
4. **Probe policy by failure type.** Consider distinct cooldown/backoff defaults for quota vs transient failures. Must remain configurable and explainable.

### Medium-value; needs product/design ADR

1. **User routing modes.** `economy` / `balanced` / `quality` could alter tier strategies and defaults. Keep distinct from model tier names; modes are policy overlays. Avoid hiding the actual chosen model.
2. **Context-window eligibility before selection.** Reject candidates whose declared context cannot accommodate estimated session/request size. Requires trustworthy model metadata and a conservative token estimate.
3. **Optional model-specific role prompts.** Useful for subagent-centric hosts, but Pi Bifrost routes one active agent. Do not copy a long universal system-prompt injection into Bifrost without measuring context cost and behavior.
4. **Output truncation recovery.** Could offer an explicit user action / continuation path. Automatic continuation has duplication/context cost and needs robust host semantics.

### Do not copy without a strong safety case

- **Transparent replay after arbitrary failure.** Model-fallback does extensive work to reduce risk, but no generic plugin can guarantee a previous agent turn had no external or file side effect. Bifrost's future-turn reroute is safer.
- **Local proxy as first porting mechanism.** Proxy gives control but drastically expands maintenance and security surface. Use only when an external host cannot switch models through an official plugin API.
- **Hard-coded vendor preset as shipped default.** Keep Bifrost default model-free. Put registry/provider recipes in `examples/`.
- **Large adversarial routing prompt.** model-router's strategy is appropriate for delegation enforcement, not deterministic Pi model selection. It increases context cost and prompt-interaction risk.

---

## Competitive positioning

Short form:

> **Bifrost is deterministic, host-native, reliability-aware model selection.**
> It routes the active turn directly, persists health across restarts, and explains/avoids failures without replaying user work.

Where competitors lead today:

- model-router: subagent workflow governance, task decomposition, verification ladder.
- model-fallback: exhaustive replay/retry race handling.
- autopilot: proxy-level request control, goal modes, context fit, model health UX.

Where Bifrost can win:

- transparent **per-turn** routing without proxy or prompt obedience;
- safest reliability model: persistent circuit state, half-open trials, no hidden replay;
- portable policy core with thin host adapters;
- inspectable config + decision trace + real transport E2E;
- minimal safe default, rich opt-in recipes.

## Suggested next research

1. Review `sigilco/agentplugins` only for adapter boundaries: can it carry model-selection hooks or merely tools/prompts?
2. Run a fixed scenario matrix against each contender and Bifrost: cheap lookup, implementation, quota 429, stream failure after output, all candidates down, context limit, and restart after failure.
3. Convert only validated gaps into ADRs. Existing local ADR proposals should be reconciled before starting overlapping work.
