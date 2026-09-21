# Reddit Jev feedback — coverage, gaps, misunderstandings, and options

Inputs:

- Raw archive: [`reddit-jev-pi-comments-1wlczow.json`](reddit-jev-pi-comments-1wlczow.json)
- Per-comment analysis: [`reddit-jev-feedback-analysis.md`](reddit-jev-feedback-analysis.md)
- Current architecture: [`../jev-typesafe-architecture.md`](../jev-typesafe-architecture.md)
- Product guardrails: [`../product-philosophy.md`](../product-philosophy.md)
- Roadmap: [`../../ROADMAP.md`](../../ROADMAP.md)

This is qualitative product discovery from 30 external comments by 21 people plus 20 maintainer replies. Percentages below are directional assessments, not measured product metrics.

## Coverage summary

| Area | Approximate coverage | Current evidence |
|---|---:|---|
| Core safety and architecture | 75% | Jev tier judgment, strict decoding, confidence gate, fallback, reliability, no replay |
| User control | 65% | Configured pools/strategies, inline tiers, pin, on/off, classifier on/off |
| User-facing explanation | 45% | Preview/status exist; unified trace and last-decision view do not |
| Cache-conscious workflow | 35% | Pin and detailed docs exist; sticky first-route mode does not |
| Real-world proof | 25% | Preliminary 60-prompt synthetic benchmark; no hard locked evaluation or downstream outcomes |
| Local/self-hosted choice | 10% | Backend separation exists; no supported local Jev-like adapter or guide |

## Covered well

### Jev integration

- Explicit opt-in hosted backend.
- Jev selects a configured tier, never an exact provider/model.
- Probabilities and confidence are strictly decoded.
- Confidence threshold rejects uncertain judgments.
- Prompt/regex/default fallback degrades safely.
- Timeouts/retries are bounded and never replay user work.
- Classifier reliability state survives restart with controlled recovery.
- Current prompt and tier criteria are sent; conversation history/files/tool output are not sent by default.

### User-owned policy

- Model pools and strategies remain configuration-owned.
- `random` applies only when explicitly configured.
- Inline tier override, hard pin, manual Pi model selection, routing on/off, and classifier on/off exist.
- Exact active Pi model changes before generation; no proxy or virtual profile.
- Unavailable and circuit-open candidates are excluded.

### Cache and safety documentation

- Provider prompt cache and Bifrost classification cache are distinguished.
- A → B → A and N-switch behavior is documented.
- Bifrost is cache-mindful, not cache-managing.
- Pinning is documented as continuity/cache-locality control.
- Automatic failed-turn replay is explicitly forbidden.

## Partially covered

### Cache-safe routing

Current workaround: select/pin exact model. Missing requested middle mode:

```text
first eligible task → route and establish base
later normal tasks → retain base
explicit tier override → one-turn route → restore base
```

ADR 0019 proposes this sticky mode but does not approve implementation.

### Jev quality evidence

Preliminary benchmark covers 60 simple synthetic prompts and reports accuracy, latency, probabilities, and estimated cost. It does not establish superiority because it lacks independent labels, hard boundary cases, locked evaluation, adversarial/multilingual/long/multi-intent prompts, repeated runs, prompt-classifier comparison, and downstream coding outcomes.

### Explainability

Preview and classifier test/status expose useful pieces. Missing: unified structured trace, normal-turn last decision, stage timing, confidence/fallback display, switch/no-switch reason, and machine-readable explanation. ADR 0007 remains proposed and needs revision before implementation.

### Quota/cost safety

Configured candidates and deterministic strategies can avoid quota-sensitive models. Missing: spend visibility, provider-authoritative quota telemetry, cache-aware total-cost accounting, and lint warnings for risky pools/strategies. Automatic quota policy must wait for observable authoritative signals.

### Product identity

README states native activation and no proxy behavior, but does not prominently disambiguate Pi-Bifrost from similarly named gateway projects.

## Missing

1. Explicit sticky routing mode.
2. Advisory-only recommendation mode that does not switch models.
3. Unified structured decision trace and last-decision UI.
4. Hard, independently labelled, locked Jev evaluation.
5. Cache-aware cost evidence across realistic sessions.
6. Generic local typed-classifier backend contract and supported adapter.
7. Clear gateway/name disambiguation near install and landing copy.
8. Config lint warnings for quota-sensitive/random or ineffective strategies.
9. Content-safe local feedback metrics: overrides, fallback, low confidence, tier distribution, and switch frequency.
10. Explicit handling of a first trivial prompt such as `hi` when establishing sticky base.

## User misunderstandings to correct

| Misunderstanding | Correct behavior |
|---|---|
| Jev picks exact/best model | Jev judges configured tier; Bifrost policy selects exact model |
| Jev randomizes models | Randomness occurs only under explicit Bifrost `random` strategy |
| Pi-Bifrost is a gateway/proxy | It is a Pi extension using native active-model selection |
| Adaptive routing always saves money | Switching may reduce cache locality and increase total cost |
| Bifrost manages provider caches | Providers own caches; Bifrost only chooses model |
| OpenRouter Jev is automatically supported | Current TypeSafe transport uses official fixed endpoint |
| Bifrost is a subagent/workflow router | Core scope is model selection for eligible Pi turns |
| Tier prefix provides session continuity | Prefix selects one turn; it does not establish sticky base |

## Maintainer misunderstandings and communication failures

1. First-turn-only routing request was initially answered with tier prefixes; these solve different problems.
2. Maintainer claimed requested behavior worked today; it does not. Sticky remains proposed.
3. “Prompt → Jev → best model” overstates Jev authority and hides Bifrost policy.
4. “Fast, cheap, built for classification” was stated without enough project-specific proof.
5. Asking critic to prove poor quality shifted burden away from launch claim; better response is current evidence plus reproducible-case invitation.
6. Tool/skill routing was casually accepted as an addition despite product boundary.
7. Link-only, speculative, and typo-heavy replies weakened otherwise strong architecture explanation.
8. Community contribution was invited before semantics and acceptance criteria were settled.

## Improvements requiring no new routing behavior

1. Replace “best model” with “tier judgment → policy → configured model.”
2. Put cache tradeoff and routing-mode choice near first product explanation.
3. State “Pi extension; not gateway or proxy” near title/install.
4. Publish preliminary benchmark with limitations, not only favorable numbers.
5. Add four recipes: cache-first pin, adaptive task-fit, deterministic tiers, classifier-off privacy-first.
6. Explain official TypeSafe endpoint versus unsupported local/OpenRouter alternatives.
7. Add “when not to use adaptive routing.”
8. Use precise public-answer format: current behavior, limitation, safe workaround, tracked proposal.
9. Add quota-safe configuration example with fixed ordered candidates.
10. Reframe subagent examples so Bifrost does not appear to orchestrate agents or override explicit assignments.

## Product additions worth considering

### Priority 1 — trust foundation

- Revised structured decision trace.
- Normal-turn last-decision display.
- Clear confidence/fallback/candidate-exclusion/switch reason.
- Harder locked Jev evaluation.

### Priority 2 — cache-safe control

- Sticky session mode from ADR 0019 after approval gates.
- Explicit base establishment and restoration semantics.
- Cache-fragmentation warning during setup.

### Priority 3 — advisory behavior

- Recommend tier/resulting configured model without switching.
- Accessible text signal, explicit apply action, configurable threshold.
- Same trace data as preview; no hidden scoring.

### Priority 4 — safer configuration

- Lint risky `random` pools, unusable tier prefixes, missing criteria, meaningless strategies, and weak fallback.
- Local aggregate metrics without prompt text.

### Priority 5 — backend portability

Define a generic result contract:

```ts
{
  tier: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
```

Then research local-process/local-HTTP adapters and named integrations such as Von/Laya. Preserve strict validation, timeout, fallback, and credential boundaries. Do not add maintainer-specific local model IDs to defaults.

## Do not add to Bifrost core

- Skill or tool-call selection.
- Permission automation.
- Workflow/subagent orchestration.
- Best-of-N response judging.
- Automatic continue or retry loops.
- Prompt replay.
- Hidden weighted quality scoring.
- Guessed quota state without authoritative telemetry.

These may be separate extensions or ecosystem experiments. They do not belong in configuration-first model router.

## Recommended order

1. Correct public messaging and capability claims.
2. Publish honest benchmark summary and evidence limits.
3. Revise/approve structured decision trace.
4. Decide ADR 0019 sticky semantics, then implement only after tests/visibility gates.
5. Design advisory mode from same trace data.
6. Add configuration-risk linting and local aggregate feedback metrics.
7. Research generic local classifier backend after contract and maintenance cost are clear.

## Open decisions

1. How should sticky mode establish base when first prompt is trivial?
2. Should advisory mode recommend tier only or resulting configured model too?
3. What locked-evaluation thresholds justify active Jev quality claims?
4. Should local support be one generic backend contract or named integrations?
5. What content-free local metrics prove value without retaining prompts?
6. Which documentation changes should ship immediately versus alongside behavior?
