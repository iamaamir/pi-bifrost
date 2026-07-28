# 0010 — Classifier confidence and graceful downgrade

## Status

**Proposed** (2026-07-29). Pending review. Do **not** implement until the design is accepted and the implementation gate is green.

## Context

The LLM classifier (`classifier.ts`, `classification-pipeline.ts:84-98`) asks the classifier model to emit a tier name. The pipeline accepts the result if the tier is in `tiers[]`, otherwise falls back to regex rules. There is no notion of confidence.

Observations:

- The classifier sometimes returns a wrong tier on a hard prompt. "Debug the race condition in this scheduler" classifier-routes to `general` when the user obviously meant `frontier`. Today the only debug surface is the regex rule `\\bdebug\\b` winning — but if the classifier fires first, the regex never gets a chance.
- Cheaper classifier models (DeepSeek flash free, Mimo free, etc. — what ADR 0006 picked as the default) hallucinate tier names more often than the maintainer's previous `opencode-go/deepseek-v4-pro`. Latency and accuracy trade off; we configured for low latency.
- The classifier has no way to say "I don't know." Its only escape is to emit a string that fails the `tiers.includes()` test, which looks the same as a misroute.

The goal: let the classifier emit a confidence score with its tier; below a configurable threshold, treat the result as no classification and let downstream stages (regex rules, default tier) take over. This is the smallest possible classifier-side change; it composes with ADR 0007 (the trace records the confidence) and ADR 0009 (the linter flags a missing `minConfidence`).

## Goals

1. The classifier may emit a confidence score alongside a tier.
2. Below a configurable threshold, the pipeline treats the result as `"classifier returned nothing"` and proceeds to regex rules.
3. The threshold is configurable per-classifier-call, not per-prompt. Default 0.6.
4. The trace (ADR 0007) records the confidence; `/bifrost preview` shows it.
5. Existing configs without `classifier.minConfidence` keep current behaviour. (See "Backwards-compat" — strict reading of the default.)
6. Existing `extractCategory()` parser handles the new format gracefully.

## Constraints

- **No new classifier model.** `ClassifierConfig.model` and `ClassifierConfig.endpoint` are unchanged.
- **No new `-Classifier` kind.** The union stays `RegistryClassifier | EndpointClassifier` (`classifier.ts`).
- **Prompt change is opt-in.** The default `classificationPrompt()` continues to ask for "exactly one category." The new prompt that asks for `tier:conf` is enabled by `classifier.confidence: true` (or similar) — see Decision.
- **Parser is forgiving.** A model that ignores the new prompt and returns `general` (no colon, no number) must still parse. Confidence defaults to 1.0 in that case; we don't downgrade unless the model emitted the confidence explicitly. This keeps the existing default classifier's behaviour unchanged.
- **No persistent state.** `cache.ts` stores `(prompt, tier)` pairs; adding confidence to the cache is out of scope. A cache-hit result has no confidence; the trace records `confidence: undefined` for cache hits.
- **No new strategy enum, no scoring.** This is a binary threshold, not a weighted score across dimensions. Weighted scoring is explicitly out of scope (see ROADMAP "Intentionally deferred").

## Decision (proposed)

### Config

Add `ClassifierConfig.confidence` (boolean, default `false`) and `ClassifierConfig.minConfidence` (number 0–1, default 0.6).

```json
{
  "classifier": {
    "enabled": true,
    "model": "opencode/deepseek-v4-flash-free",
    "confidence": true,
    "minConfidence": 0.65
  }
}
```

Leaving `confidence` off keeps the existing single-tier-name prompt and parser. Default behaviour for existing configs is unchanged.

### Prompt

When `confidence: true`, `classificationPrompt()` emits:

```
Categories: <tiers>

Classify the request into exactly one category. Respond with the category
name followed by a colon and a confidence score between 0 and 1. Example:
"general:0.8". Respond with only that, no explanation.
```

The system prompt (`classifier.ts:45-47`) gains an optional line about confidence when enabled. Keep it terse.

### Parser

`extractCategory(text, tiers)` (`classifier.ts:72+`) is replaced by `extractCategoryWithConfidence(text, tiers): { category: string; confidence: number } | undefined`. The new parser:

1. Trim.
2. If `text` contains a colon, split into `[category, confStr]`. If `confStr` parses to a number 0–1, attach; else treat the whole text as the category and `confidence = 1.0`.
3. If no colon, treat the whole text as the category and `confidence = 1.0`.
4. Verify category ∈ tiers. If not, return undefined.

A model that responds with just `general` (existing behaviour) gets `confidence = 1.0`. The threshold never fires for those responses. This is the backwards-compat path.

### Pipeline

`classification-pipeline.ts:84-93` checks the result against `classifierMinConfidence` (sourced from config, defaulted per pipeline construction). If `confidence < minConfidence`:
- The trace records `{stage: "classifier", tier: returned, confidence: c, downgrade: true}`.
- The pipeline falls through to regex rules, exactly as if the classifier had returned a non-tier string.
- The cache is not written. (A below-threshold result is not a useful cache entry.)

If `confidence >= minConfidence`, behaviour is unchanged.

### Trace integration (ADR 0007)

`StageTrace.classifier` already declares `confidence?: number`. This ADR fills it in. A below-threshold result additionally sets `downgrade: true` on the stage.

### Render

`/bifrost preview` shows `classifier: general (conf 0.42 → downgrade)` when below threshold; `classifier: general (conf 0.91)` when above.

## Considered options

### Option A: Explicit `tier:conf` format with threshold (proposed)
New `confidence` config flag; new parser; binary threshold.

**Pros:** Opt-in, backwards compatible, composes with cache (cache stays tier-only), composes with trace. Smallest possible classifier-side change.
**Cons:** Classifier model must comply. Some models emit `general:0.8`; some emit `general` (treated as 1.0). Inconsistent across classifier models — but the trace shows which, and the user can tune.

### Option B: Always-on confidence; default threshold 0
Always ask for confidence; threshold zero means "accept any."

**Pros:** One code path.
**Cons:** Existing free classifiers that ignore the new prompt get `confidence = 1.0` (parser fallback) — not 0.0. Threshold 0 doesn't change behaviour. The default path is a confusing no-op. Worse, a careless user who sets `minConfidence: 0.6` later sees no change for their ignored-prompt classifier and assumes the feature is broken. Explicit opt-in via `confidence: true` is honest.

### Option C: N-best classification with disambiguation
The classifier returns a ranked list `["general:0.5", "frontier:0.4", "quick:0.1"]`; the pipeline picks the top above threshold.

**Pros:** More information; could drive future weighted scoring.
**Cons:** More parser surface, more prompt surface (the model has to rank), more cache-key questions. Out of scope for a binary threshold feature. Rejected — defer to "Intentionally deferred."

### Option D: Two-stage classifier (tier + difficulty) 
Separate classifier calls for tier and difficulty/risk; route on the cross.

**Pros:** More signal.
**Cons:** Two classifier calls per prompt, more latency, more cost. The "Intentionally deferred" section of the ROADMAP mentions multi-intent classification; this is its cousin. Rejected for this ADR.

## Consequences

- `ClassifierConfig` gains two optional fields. No schema break.
- `classifier.ts` gains `extractCategoryWithConfidence`; `extractCategory` could be removed or kept as a thin wrapper.
- `classification-pipeline.ts:84-93` adds the threshold check before returning a classifier result.
- ` PiperipelineDeps` gains `classifierMinConfidence?: number` so the pipeline test can pass it.
- Cache writes below threshold are suppressed. Cache reads are unaffected.
- `index.ts` builds the pipeline with the new dependency. One-line change.
- ADR 0007's `StageTrace.classifier.confidence` field is populated. ADR 0009's linter gains a check: `classifier.confidence: true` without `minConfidence` set warns (use the default 0.6).

## Implementation gate (if accepted)

- [ ] Add `confidence?: boolean` and `minConfidence?: number` to `ClassifierConfig` (`config.ts`) and to `schema.json`.
- [ ] Add a `buildClassificationPrompt(tiers, { confidence })` helper in `classifier.ts` that emits the confidence-aware prompt when enabled.
- [ ] Replace `extractCategory` with `extractCategoryWithConfidence`; keep a thin alias if useful.
- [ ] In `classification-pipeline.ts:84-93`, read `classifierMinConfidence` from deps; if the returned confidence is below threshold, fall through and skip cache write.
- [ ] In `index.ts`, pass `classifierMinConfidence` (resolved from config) into `createPipeline`.
- [ ] Trace integration (ADR 0007): `StageTrace.classifier.confidence` populated; `downgrade: true` when below threshold.
- [ ] Linter (ADR 0009): add a check that `classifier.confidence: true` without `classifier.minConfidence` uses the default 0.6 — informational.
- [ ] Tests: `tests/classifier.test.ts` covers `extractCategoryWithConfidence` for colon format, no-colon, malformed number, out-of-range number. `tests/pipeline.test.ts` covers the threshold downgrade path. One trace integration test (ADR 0007) covers the recorded confidence and downgrade flag.
- [ ] Update `examples/advanced-classifier-prompt.json` to show `confidence: true` documented.
- [ ] `npm test`, `npm run typecheck`, `npm run test:ui`, `npm run test:ui:reliability` all green.

## Open questions for reviewers

1. Default `minConfidence` — 0.6 or 0.5? (My read: 0.6. Below 0.5 is "I'm basically guessing" territory and we'd be better off with regex; above 0.7 starts rejecting legitimate-but-uncertain classifier calls on cheap models. 0.6 is the middle.)
2. Should the cache key include the confidence so a re-classification at a different threshold isn't a forced cache miss? (My read: no — confidence is not part of the routing decision after acceptance; tier is. Cache stays `(prompt, tier)`.)
3. Should the threshold be per-tier (some tiers are more consequential to misroute than others)? (My read: no — adds config surface for a problem we haven't measured. Single threshold for v1.)
4. Should the downgrade path record the rejected tier in the cache as a negative entry? (My read: no — scope creep, and "negative cache" semantics differ across users.)