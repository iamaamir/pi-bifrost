# Jev classifier evaluation

Research notes. No product commitment or implementation approval.

## Summary

Jev has a promising contract fit for Bifrost's hosted-classifier use case because its native task shape matches Bifrost's problem: evaluate prompt state, choose one configured tier, and return typed probabilities and confidence. Whether it outperforms existing options remains unproven pending live evaluation. It should be evaluated as an **optional classifier backend**, not replace Bifrost's current classifier or regex fallback.

Current recommendation:

1. Keep current registry/OpenAI-compatible/subprocess classifier paths.
2. Add provider-neutral tier criteria as a general classifier primitive.
3. Put classifier policy behind a stable internal judgment interface.
4. Implement any direct TypeSafe HTTP transport as a thin replaceable adapter.
5. Build and test configuration, request construction, response normalization, failure handling, and traces without a live Jev key.
6. Do not claim Jev quality, calibration, or latency until a real API key enables evaluation on Bifrost's routing corpus.
7. Start live use through an explicit benchmark/preview comparison command. Design persistent shadowing separately only if needed. Enable route-changing behavior only after measured results and trusted user opt-in.

TypeSafe API access and live verification are now available through the evaluation-only `scripts/jev-benchmark.ts` harness. The preliminary 60-prompt version-1 run completed successfully; see [`jev-benchmark-v1.md`](jev-benchmark-v1.md). Its synthetic, highly separable development labels are encouraging contract evidence, not promotion evidence, Jev superiority, or production-routing approval.

---

## Why Jev fits Bifrost

Bifrost needs a narrow semantic judgment:

```text
Given this coding-agent request and these configured tier definitions,
which tier should handle the request?
```

TypeSafe's `Choice` primitive provides the useful output directly:

- one selected option from a closed set;
- probability for every option;
- confidence derived from the distribution;
- structured output without prompt-and-parse tier extraction.

This is a better conceptual fit than asking a general-purpose LLM to emit a tier name and optional textual confidence. It also composes naturally with Bifrost's desired decision trace and confidence-aware fallback work.

Published Jev 1.13 characteristics relevant to Bifrost:

| Property | Published value / behavior | Bifrost relevance |
|---|---|---|
| API | `POST /v1/systemone` | Not OpenAI-compatible; needs a dedicated adapter today |
| Input | Text, including strings and text-bearing JSON/arrays | Suitable for prompt plus tier criteria |
| Output | Typed Choice/Score/Noul judgments | Choice matches tier selection |
| Context | 64k total; 32k for state plus longest question | More than enough for normal prompt classification |
| Price | $0.042 per million input tokens; output free | Classification cost should be negligible |
| Confidence | Derived from probability distribution | Better signal than self-reported confidence text |
| Language | English strongest; other languages uneven | Requires multilingual corpus coverage if promised |
| Data use | Customer requests not used for model training | Positive, but does not remove retention/privacy concerns |
| Zero data retention | Enterprise option | Normal hosted use still needs explicit privacy disclosure |

The official documentation does not provide a Bifrost-like coding-task benchmark or a latency SLO. “Fast” and “calibrated” remain vendor claims until measured on Bifrost's workload.

Prices, limits, aliases, retention terms, and endpoints above are mutable vendor facts captured during this research pass. Revalidate them against current official documentation before implementation and again before a live benchmark. Contract fixtures should record the source model/API version they represent.

---

## Important model limitations

TypeSafe documents several Jev 1.13 failure modes that matter here:

- literal interpretation of instructions;
- weaker handling of indirection;
- accuracy loss from large irrelevant state;
- adversarial state can steer answers;
- English performs best;
- confidence describes distribution concentration, not guaranteed correctness;
- model versions and aliases can change behavior.

Consequences for Bifrost:

1. Tier names alone are insufficient. `quick`, `general`, and `frontier` need explicit contrastive definitions.
2. Send only current routing-relevant prompt state. Do not add unrelated session history by default.
3. Test pasted prompt injection and content that asks to classify itself into a cheaper tier.
4. Treat high confidence as evidence, not permission or proof.
5. Pin a version such as `jev-1.13.0` during evaluation. Test new versions before moving an alias.
6. Keep deterministic user overrides and explicit route rules outside model judgment.

---

## Keep existing classifier paths

Jev should extend the classifier system, not replace it.

Reasons:

- local classifiers preserve privacy and offline operation;
- Pi registry classifiers reuse credentials and provider support users already have;
- OpenAI-compatible endpoints cover many hosted and local models;
- subprocess fallback covers providers without a direct compatible transport;
- TypeSafe access, availability, pricing, and model behavior may change;
- users should not depend on one hosted classifier vendor.

Default installs should remain model-agnostic. A TypeSafe/Jev backend must be explicit, visible, disableable, and reversible.

Expected degradation remains:

```text
classifier unavailable / invalid / below accepted confidence
  → configured classifier fallback
  → regex rules
  → default tier
```

No classifier outage should prevent Bifrost from routing a turn.

---

## General classifier criteria

Tier criteria are useful beyond Jev. Current classification largely exposes tier names and a generic instruction. A provider-neutral criteria map would improve Jev, general LLM classifiers, preview output, and routing tests.

Illustrative configuration only:

```json
{
  "classifier": {
    "criteria": {
      "quick": {
        "what": "Routine, bounded, reversible work with an obvious solution",
        "notFor": "Complex debugging, security analysis, architecture, or broad refactoring",
        "examples": ["format this JSON", "write a commit message"]
      },
      "general": {
        "what": "Normal feature implementation, tests, and moderate multi-step reasoning",
        "notFor": "Purely mechanical work or unusually ambiguous and consequential work",
        "examples": ["add pagination to this endpoint", "write integration tests"]
      },
      "frontier": {
        "what": "Complex debugging, architecture, security, high ambiguity, or high-consequence work",
        "notFor": "Routine mechanical changes with clear acceptance criteria",
        "examples": ["diagnose this race condition", "design the authorization architecture"]
      }
    }
  }
}
```

Design requirements:

- keys must match configured tiers;
- custom tier names remain supported;
- strings should remain valid for simple criteria;
- structured criteria should support contrasts, exclusions, and examples;
- missing criteria may fall back to the tier label for compatibility, but TypeSafe configuration should fail validation when an active custom tier lacks explicit criteria;
- criteria must appear in preview/effective-config output;
- criteria changes should invalidate classifier cache entries or version the cache key;
- defaults may cover Bifrost's canonical tiers, but must not silently define custom tiers;
- criteria maps should deep-merge by tier across config layers; `null` should explicitly remove an inherited criterion;
- normalized criteria must use stable key ordering before cache fingerprinting.

“Everything configurable” should mean all meaningful policy choices are configurable. It should not expose transport internals that users cannot safely reason about. Configuration needs a small stable surface with explicit defaults, validation, and trace visibility.

---

## Replaceable adapter boundary

Do not spread TypeSafe request/response types through routing policy. Normalize all classifier backends to one internal result.

Illustrative boundary:

```ts
interface ClassificationJudgment {
  readonly tier: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly backend: string;
  readonly model?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

interface ClassifierBackend {
  classify(input: ClassificationInput): Promise<ClassificationJudgment | undefined>;
}
```

Suggested ownership:

```text
core classifier policy
  ├─ criteria and tier validation
  ├─ confidence/fallback policy
  ├─ cache policy
  └─ normalized ClassificationJudgment

classifier adapters
  ├─ Pi registry / existing LLM adapter
  ├─ OpenAI-compatible endpoint adapter
  ├─ subprocess adapter
  └─ TypeSafe HTTP adapter
```

The TypeSafe adapter should own only:

- authentication lookup;
- `POST /v1/systemone` request construction;
- timeout/retry behavior;
- TypeSafe response validation;
- normalization into `ClassificationJudgment`;
- provider-specific error normalization.

If Pi later adds native System One/TypeSafe support, replace this adapter with a Pi-backed adapter. Core policy, config semantics, tests, and traces should remain unchanged.

Direct HTTP is preferable to pretending TypeSafe is OpenAI-compatible. SDK use is optional: the official JavaScript SDK provides typed requests and retry behavior, while a small direct client reduces dependency surface. Choose after comparing timeout control, retry behavior, bundle cost, and maintenance burden.

---

## Candidate configuration surface

This is a discussion shape, not an accepted schema.

```json
{
  "classifier": {
    "enabled": true,
    "backend": "typesafe",
    "model": "jev-1.13.0",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "timeoutMs": 3000,
    "maxAttempts": 2,
    "minConfidence": 0.6,
    "fallback": "regex",
    "criteria": {
      "quick": "...",
      "general": "...",
      "frontier": "..."
    }
  }
}
```

Potential values:

- `backend`: existing Pi/LLM path, OpenAI-compatible path, subprocess path, or `typesafe`;
- `model`: alias or pinned version;
- `endpoint`: official TypeSafe origin by default; project config cannot redirect TypeSafe credentials to another origin;
- credentials: fixed `TYPESAFE_API_KEY` lookup for official TypeSafe transport, never configurable from repository-owned config;
- custom endpoint trust: user-level approval outside project config; credentials bound to approved origin; unauthenticated loopback allowed for tests;
- `timeoutMs`: total request budget because classification blocks routing;
- `maxAttempts`: total attempts including first call;
- `minConfidence`: policy threshold, validated in `[0, 1]`;
- `fallback`: at minimum `regex` or configured default behavior;
- mode: active backend selection stays separate from explicit command-scoped comparison; persistent shadow mode is not part of this initial config;
- `criteria`: tier definitions shared across classifier backends.

Sensible defaults should be conservative:

- current classifier backend remains default;
- TypeSafe requires explicit opt-in;
- official endpoint and fixed standard API-key environment name need no project configuration;
- bearer credentials are sent only to the official or explicitly user-approved origin;
- fallback remains regex/default rather than failing the turn;
- secrets stay outside JSON;
- request timeout and retry count are bounded under one deterministic retry contract;
- trace identifies backend, model version, selected tier, confidence, and fallback;
- persisted traces prohibit raw prompt text; live preview may show user-supplied text because the user invoked it;
- existing fuzzy cache persistence of normalized prompt text is documented prominently, can be disabled/cleared, and gets an explicit retention policy;
- no confidence threshold should be treated as validated until corpus results support it.

A published default threshold can be introduced after evaluation. Before then, any provisional threshold must be labeled provisional and remain user-overridable.

---

## What was built before live evaluation

The evaluation-only contract and harness were developed deterministically before using live Jev responses:

1. **Provider-neutral criteria schema and validation**
   - criteria keys match tiers;
   - simple and structured criteria normalize consistently;
   - config precedence and defaults are deterministic.
2. **Normalized classifier judgment boundary**
   - existing classifier results adapt into the new shape;
   - pipeline remains backend-agnostic.
3. **TypeSafe request builder**
   - exact documented `/v1/systemone` payload fixtures;
   - tier criteria become one Choice question;
   - pinned model, state, and question IDs are deterministic.
4. **TypeSafe response decoder**
   - success fixtures;
   - unknown tier, missing answer, malformed probabilities, invalid confidence, and version reporting.
5. **Fake TypeSafe server contract tests**
   - auth header;
   - success, timeout, abort, `401`, `429`, `500`, and `529`;
   - bounded retry and fallback behavior.
6. **Pipeline and trace tests**
   - confidence threshold;
   - regex/default fallback;
   - command-scoped comparison does not alter active route or cache;
   - existing classifiers remain unchanged.
7. **Corpus/evaluation harness**
   - labelled prompt records;
   - pluggable classifier runner;
   - confusion matrix, latency, confidence, and cost reporting.

Another model can test the normalized backend interface and end-to-end sandbox behavior. It cannot substitute for Jev when validating:

- Jev classification accuracy;
- probability calibration;
- confidence thresholds;
- prompt sensitivity;
- adversarial robustness;
- Jev latency and availability;
- token accounting and real cost.

A generic model returning Jev-shaped JSON would test our code, not Jev. This distinction must stay explicit in docs and test names.

---

## Evaluation plan with API access

### Phase 1 — Offline contract gate

Run without network:

- config/schema tests;
- request/response fixture tests;
- fake-server transport tests;
- existing classifier regression tests;
- no-key startup and fallback tests.

Passing this gate proves integration mechanics only.

### Phase 2 — Labelled benchmark

This phase waits until ADR 0011 or an equivalent accepted corpus contract exists. Use a substantially expanded set of realistic coding-agent prompts; its 14 seed scenarios are insufficient for model-quality claims. Disable fuzzy cache while measuring classifier behavior.

Pre-register before seeing locked-test results:

- task-family taxonomy and subgroup minimum sizes;
- dual independent labels plus adjudication for disagreements;
- train/development/locked-test split;
- minimum corpus size and fixed repeated-run count;
- promotion thresholds, especially maximum `frontier` false-negative rate;
- latency environment and timeout policy;
- confidence interval method.

Compare:

1. regex/default baseline;
2. current configured LLM classifier;
3. Jev with tier labels only;
4. Jev with explicit criteria;
5. Jev with revised criteria after error analysis.

Measure:

- exact-tier accuracy;
- confusion matrix;
- `frontier` false-negative rate;
- over-routing rate and expected cost impact;
- fallback/abstention rate at candidate thresholds;
- confidence versus empirical accuracy;
- Brier score or log loss plus expected calibration error;
- bootstrap confidence intervals for primary quality metrics;
- p50/p95/p99 latency under a controlled environment;
- timeout/error/rate-limit frequency;
- input tokens and cost per classification;
- consistency across repeated runs;
- results by prompt language, length, and task family.

Use development data for criteria edits. Evaluate the locked test set once for a promotion decision; further tuning requires a new locked set.

### Phase 3 — Explicit benchmark/preview comparison

Initial live comparison should be an explicit command, not persistent background shadowing. It invokes the configured active baseline and Jev for the same supplied benchmark/preview prompt, but Jev does not change the selected tier. Show both outcomes:

```text
active route: frontier (regex)
jev comparison: general
jev confidence: 0.68
probabilities: quick=0.02 general=0.74 frontier=0.24
```

Command-scoped comparison validates transport latency, failures, privacy expectations, and disagreement patterns without silently changing routes or creating a persistent dataset.

Persistent shadow mode is deferred to a separate design covering active baseline selection, sampling, cache behavior, retention, storage, redaction, duration, and minimum sample count.

### Phase 4 — Bounded active mode

Consider active routing only when:

- decision traces are available;
- criteria and thresholds are configurable;
- inline override and classifier disable remain available;
- fallback is deterministic;
- benchmark evidence meets pre-registered numeric acceptance bars;
- any required persistent shadow phase has a separately accepted design and completed evidence;
- docs clearly state prompt transmission, local cache persistence, and retention implications.

Start with reversible, low-risk routes. Preserve explicit user rules and safety-sensitive routing behavior.

---

## Evaluation acceptance questions

Exact thresholds should be selected before active rollout, but after a representative corpus exists. At minimum answer:

1. Does Jev materially reduce misroutes versus current classifier and regex baselines?
2. Does it stay below the pre-registered maximum under-routing rate for debugging, security, architecture, and broad-change prompts, with confidence intervals?
3. Does explicit criteria outperform labels on locked-test data enough to justify config complexity?
4. Is confidence predictive enough to support fallback?
5. What threshold minimizes harmful under-routing without collapsing into constant fallback?
6. Is added p95 latency acceptable on every cache miss?
7. Do errors degrade cleanly without blocking the turn?
8. Are users comfortable sending prompts to TypeSafe under its standard retention terms?
9. Can a pinned Jev version be upgraded without unexplained routing drift?

If these are not answered, keep Jev in research or explicit comparison mode.

---

## Product boundary

Jev does not justify a general scoring or policy engine.

Smallest product-shaped addition remains:

```text
configured tiers + criteria
  → one typed classifier judgment
  → visible confidence/probabilities
  → explicit threshold/fallback
  → direct active-model selection
```

Do not add multi-agent delegation, automatic prompt replay, hidden weighted policy, or provider lock-in as part of this work.

Feature-gate status:

| Gate | Current status |
|---|---|
| User value | Plausible; typed classification and useful uncertainty |
| Explicit policy | Achievable through opt-in backend/config |
| Visibility | Requires structured classifier trace/comparison output |
| Override | Must preserve pin, inline override, classifier off, and fallback |
| Proof | Preliminary harness available; benchmark success still unclaimed pending parent-run live evidence and locked evaluation |

Result: approved for continued research and contract-level prototyping, not yet proven for automatic routing.

---

## Open design questions

1. Should route rules always precede semantic classification, or should precedence remain unchanged? This research does not authorize a precedence change.
2. Should direct HTTP use the official SDK or a minimal transport adapter under the same fixed retry contract?
3. What pre-registered corpus size, subgroup sizes, and frontier false-negative ceiling are required before active rollout?
4. Which standard-retention disclosure is sufficient for non-enterprise users?
5. Does active rollout require a separately approved persistent shadow phase, or can locked benchmark plus explicit command-scoped comparison provide enough evidence?

---

## Opinion

Building integration mechanics before live evaluation was reasonable and useful, provided claims remain disciplined. API access is now available, but promotion evidence is still absent until the labelled benchmark is run and reviewed.

Best sequence:

1. land provider-neutral criteria and normalized judgment design only after its ADR is accepted;
2. test transport through a fake TypeSafe server;
3. retain current classifiers unchanged;
4. use other models only to validate shared architecture, never as evidence for Jev quality;
5. wait for real Jev access before tuning thresholds or promoting active routing;
6. use locked benchmark and explicit comparison first; design persistent shadow separately only if needed; then consider optional active mode.

This avoids idle waiting without pretending substitute-model tests answer the important product question. Main risk is building too much provider-specific machinery before Jev proves better. Keep adapter thin, configuration explicit, and first live milestone an evaluation—not a launch.

---

## Sources

TypeSafe documentation consulted:

- [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- [System One](https://docs.typesafe.ai/concepts/system-one)
- [Choice](https://docs.typesafe.ai/primitives/choice)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Intent routing](https://docs.typesafe.ai/patterns/intent-routing)
- [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Models and pricing](https://docs.typesafe.ai/models)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [API reference](https://docs.typesafe.ai/api)
- [Legal and data handling](https://docs.typesafe.ai/legal)

Related Bifrost documents:

- [`docs/product-philosophy.md`](../product-philosophy.md)
- [ADR 0007 — Explainable decision traces](../adr/0007-decision-traces.md)
- [ADR 0010 — Classifier confidence](../adr/0010-classifier-confidence.md)
- [ADR 0011 — Routing scenario corpus](../adr/0011-routing-scenario-corpus.md)
- [ADR 0016 — Classifier reliability](../adr/0016-classifier-reliability.md)
- [ADR 0017 — Config primitives](../adr/0017-bifrost-config-primitives.md)
