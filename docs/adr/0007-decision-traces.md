# 0007 — Explainable decision traces

## Status

**Proposed** (2026-07-29). Pending review. Do **not** implement until the design is accepted and the implementation gate is green.

## Context

`/bifrost preview <prompt>` (`commands.ts:450-496`) prints a flattened summary: prompt, source, tier, strategy, selected tier, requested candidates, fallback reason, selected model. This is the only visibility into *why* a route was chosen.

Several sharp edges:

1. **No stage timings.** `classification-pipeline.ts` already records `debugMeasure` for `regex_pre`, `cache`, `classifier.attempt`, `regex`, but those only flow to the JSONL debug log. A slow classification shows up as "preview took a while" — the user cannot tell whether the classifier model was slow, the cache missed, or the reliability filter rejected candidates.

2. **No reliability filter visibility.** `resolveTierDisplay()` (`commands.ts`) shows `fallbackReason` when a tier has zero healthy candidates, but it does not show which candidates were circuit-open or cooldown-locked. A user who sees "selected: default-tier model" after a `frontier` rule hit has no way to know whether `frontier` was empty or whether every `frontier` model was open-circuited.

3. **No classifier confidence.** The LLM classifier returns a tier or nothing (`classification-pipeline.ts:84-93`). When it returns a wrong tier, the preview can only say "source: classifier" — no signal of how sure it was. See ADR 0010 for the classifier-side fix; this ADR is the trace plumbing that receives the number.

4. **No machine-readable form.** The preview is a human string. Tests assert against the same `ClassificationResult` interface the pipeline returns, but integration tests and external tools cannot consume a structured trace without scraping text.

5. **No structured fallback record.** When a direct rule binds to `provider/id` and that model is circuit-open, routing falls to the default tier with no record in the preview of which direct binding was skipped. (Composes with ADR 0008 — fallback chains need to be observable.)

The goal is a single, structured trace that the user sees in `/bifrost preview`, that tests can assert against, and that future features (confidence, fallback chains, linter) plug into without rewriting the surface.

## Goals

1. One trace structure, produced by the pipeline, consumed by `/bifrost preview`, tests, and the JSONL debug log.
2. Every routing-decision stage records its input, output, and timing.
3. Filtered-out candidates (reliability, missing-from-registry) appear in the trace with a reason.
4. The trace is JSON-serialisable; the user-facing string is a rendering of it.
5. No new persistent state. Traces are produced on demand.

## Constraints

- **No new files for the trace type.** Live next to `classification-pipeline.ts` where the result type already lives. Keep it close to the producing code.
- **No breaking change to `ClassificationResult`.** The current ADT (`classification-pipeline.ts:9-12`) is used by tests and the pipeline boundary. Extend by adding a parallel `DecisionTrace` type, not by mutating the existing kind union.
- **Traces are opt-in.** The pipeline computes a trace only when asked (a `withTrace` flag on `classify` or a new `classifyWithTrace`). The hot path (`index.ts` routing per prompt) does not build traces.
- **No I/O in the trace.** The trace is a value; `commands.ts` decides whether to print it, persist it, or discard it.
- **Faithful to ADR 0005.** Reliability filter reasons come from `ReliabilityStore.getState()` snapshots — no new store APIs.

## Decision (proposed)

### Trace shape

```ts
export interface DecisionTrace {
  readonly prompt: string;
  readonly stages: readonly StageTrace[];
  readonly result: ClassificationResult;
  readonly selectedModel?: string;
  readonly filteredCandidates: readonly FilteredCandidate[];
}

export type StageTrace =
  | { readonly stage: "regex_pre"; readonly durationMs: number; readonly match?: string }
  | { readonly stage: "cache"; readonly durationMs: number; readonly hit: boolean; readonly tier?: string }
  | { readonly stage: "classifier"; readonly durationMs: number; readonly model: string; readonly tier?: string; readonly confidence?: number }
  | { readonly stage: "regex"; readonly durationMs: number; readonly match?: string }
  | { readonly stage: "fallback"; readonly durationMs: number; readonly tier: string }
  | { readonly stage: "select"; readonly durationMs: number; readonly strategy: RoutingStrategy; readonly selected?: string };

export interface FilteredCandidate {
  readonly key: string;
  readonly reason: "circuit_open" | "cooldown" | "missing_from_registry" | "trial_in_progress";
  readonly detail?: string;
}
```

`confidence` field is declared now but optional — ADR 0010 fills it in. A trace without confidence simply omits the field.

### Pipeline change

`createPipeline` gains an optional `withTrace: boolean` on `classify`, or a new method `classifyWithTrace(text): Promise<{ result: ClassificationResult; trace: DecisionTrace }>`. Recommend the latter to keep the hot path zero-allocation.

Each `debugMeasure(...)` block already wraps a stage; the trace records the same `durationMs` value the debug log sees. No new measurement paths.

### `/bifrost preview` rendering

`commands.ts:handlePreview` builds the trace (via `classifyWithTrace`) and renders it as the existing human string plus a `trace: <JSON>` line, or — if `--json` is passed — prints the trace only. Existing string output stays for backwards compatibility; the structured form is additive.

Reliability-filtered candidates come from comparing `display.requestedCandidates` (pre-filter) with `display.healthyCandidates` (post-filter). Each missing candidate gets a reason by querying `store.getCircuitState(key)` and translating to the enum above.

### Tests

- `tests/pipeline.test.ts` gains `classifyWithTrace` cases: each stage produces one entry; result matches; filtered candidates recorded for a known circuit-open model.
- `tests/commands.test.ts` (or a new `tests/preview-trace.test.ts`) asserts the rendered trace contains stage timings and filtered-candidate reasons.

## Considered options

### Option A: New `DecisionTrace` parallel to `ClassificationResult` (proposed)
Tests and debug log keep working; the new structure is additive; opt-in via a separate method.

**Pros:** No breaking change. Zero cost on hot path. Composable with confidence and fallback chains.
**Cons:** Two classify methods on the pipeline interface (slightly more API).

### Option B: Extend `ClassificationResult` with an optional `trace` field
Every classify returns a trace; hot path discards it.

**Pros:** One method.
**Cons:** Allocation on every prompt. The trace is only useful to `preview` and tests — paying for it always is wrong. Forces every test that pattern-matches `ClassificationResult` to ignore the new field.

### Option C: External tracer wrapping the pipeline
A second module observes pipeline calls and reconstructs the trace from `debug` events.

**Pros:** Pipeline untouched.
**Cons:** Debug events are coarse strings; reconstructing structured `StageTrace` from them is fragile and racy. Tracer couples to debug log internals. Rejected.

## Consequences

- `/bifrost preview` becomes the primary debugging surface for routing. New features (confidence, fallback chains, linter) wire into the trace rather than into ad-hoc log lines.
- Tests can assert on the trace instead of scraping strings.
- The debug JSONL log gains a structured sibling for trace events; the existing `debug("pipeline", "result", ...)` calls can stay or be derived from the trace — out of scope for this ADR.
- No persistent state. No new files beyond the trace type definition.

## Implementation gate (if accepted)

- [ ] Add `DecisionTrace`, `StageTrace`, `FilteredCandidate` to `classification-pipeline.ts` (or a sibling file `decision-trace.ts` if size warrants).
- [ ] Add `classifyWithTrace` to `ClassificationPipeline`. Hot path `classify` stays trace-free.
- [ ] Wrap each existing `debugMeasure` block with a `StageTrace` push.
- [ ] In `commands.ts:handlePreview`, call `classifyWithTrace` when rendering. Keep existing string output; add a `trace` line or `--json` flag.
- [ ] Translate `ReliabilityStore` circuit states to `FilteredCandidate.reason` (one helper, unit-tested).
- [ ] Tests: `pipeline.test.ts` covers `classifyWithTrace` for cache hit, classifier hit, regex hit, fallback, and circuit-open filtering.
- [ ] Tests: `commands.test.ts` (or sibling) asserts the rendered preview contains the new fields.
- [ ] `npm test`, `npm run typecheck`, `npm run test:ui`, `npm run test:ui:reliability` all green.

## Open questions for reviewers

1. Should the trace also record the resolved `ReliabilityState` snapshot, or only the per-candidate filter reasons? (My read: only the per-candidate reasons — the snapshot is large and the reasons are the actionable surface.)
2. Should `classifyWithTrace` be the only path used by `preview`, with `classify` reserved for the hot routing path? (My read: yes.)
3. Should we add a `--json` flag now or wait for a reported need? (My read: add it now — it's two lines and unblocks external tools.)

---

## Reviewer pass 1 — pi-routed `opencode-go/glm-5.2` (2026-07-29)

Real Bifrost run via `pi -p` on this repo. Prompt routed to the `code_review` tier via the project-local `.pi/bifrost.json` (left intentionally as a 14-tier research config; the shipped `bifrost.json` is the ADR-0006 minimal default — see ADR 0006 reviewer pass 1, B1). Classifier cache hit from an earlier run; first healthy candidate in `code_review` was `opencode-go/glm-5.2` (now removed from the tier for cost; future runs on this repo will route to `openai-codex/gpt-5.6-sol`).

The review verified every code citation against actual files. Findings are reproduced below; commentary on each in brackets where the author agrees or disagrees.

### Blocking gaps — gate cannot pass as written

**B1. `fallback` and `select` `StageTrace` stages have no `debugMeasure` source.**
`debugMeasure` exists only for `regex_pre` (`classification-pipeline.ts:63`), `cache` (`:75`), `classifier.attempt` (`:86`), `regex` (`:101`). The declared `fallback` and `select` stages have no instrumentation. The gate item "Wrap each existing `debugMeasure` block with a `StageTrace` push" covers only half the declared stages.

**B2. `debugMeasure` does not expose `durationMs` to its caller.**
`debug.ts:138-167` returns a closure that pushes `{duration_ms}` into the JSONL buffer and returns nothing. `classifyWithTrace` cannot read the value the debug log sees without changing `debugMeasure` to return the entry or re-timing with its own `performance.now()`. Both are new measurement paths — contradicts the "No new measurement paths" constraint.

**B3. `debugMeasure` is a no-op when debug is disabled.**
`debug.ts:140`. Debug defaults off. On a default install, trace stages would have `durationMs: undefined`. Goal #2 ("every stage records timing") is incompatible with this gate. Either trace times independently of `debug` or scope Goal #2 to "when debug is on."

**B4. `FilteredCandidate.reason` enum does not match the reliability layer.**
ADR proposes `circuit_open | cooldown | missing_from_registry | trial_in_progress`.
- Existing `SkippedCandidate.reason` (`routing.ts:182`) is the single value `"open_circuit"` — different spelling.
- `CircuitState` (`reliability.ts:29-34`) has no distinct `cooldown` state; cooldown *is* the open window (`openUntil > now`). `cooldown` collides with `circuit_open`.
- `resolveHealthyModel` (`routing.ts:180-186`) skips only when `circuit.open`. A `trialActive` model with `openUntil <= now` is kept as healthy. So `trial_in_progress` is not derivable from this diff.
- `missing_from_registry` cannot be produced by diffing `candidates` vs `healthyCandidates`: a missing model never appears in `candidates` (filtered earlier in `findCandidates`).

[Author response: B4 is correct and under-specified. Trim enum to `circuit_open | missing_from_registry` for v1; align spelling with existing `open_circuit` (or rename both ways); acknowledge `cooldown` / `trial_in_progress` need store-side derivation that doesn't exist yet. Fold into the gate.]

**B5. Proposed filtered-candidate source fields do not exist on the display object.**
ADR says "compare `display.requestedCandidates` (pre-filter) with `display.healthyCandidates` (post-filter)." `resolveTierDisplay` (`commands.ts:218-247`) returns only formatted `*CandidateLines` strings; the structured arrays live one level down on `HealthyModelResolution` (`routing.ts:185-190`). And `skipped: SkippedCandidate[]` already carries structured reasons. Reconstructing by diff is strictly worse than reading `resolved.primary.skipped` / `resolved.fallback.skipped`.

[Author response: B5 is the author's miss. Switch the design to read `resolved.primary.skipped` + `resolved.fallback.skipped` directly and map `SkippedCandidate → FilteredCandidate`. Drop the reconstruction-by-diff.]

### Design choices that should be deliberate

**D1. `StageTrace.classifier` cannot represent multiple classifier attempts.**
`classification-pipeline.ts:84-98` loops over `classifierModels`. A failed first model + retry produces two `debugMeasure("pipeline","classifier.attempt")` entries. The declared single-classifier-entry variant can't represent a two-attempt classification. Either allow multiple `classifier` stage entries, or add `attempts: ClassifierAttempt[]`.

[Author response: agree; adopt `attempts: ClassifierAttempt[]` shape in 0007's `classifier` variant before landing.]

**D2. `StageTrace.regex.match` typed `string` but debug payload uses `boolean`.**
`classification-pipeline.ts:101-103` records `{ match: !!regex, tier: regex }`. ADR declares `match?: string`. Renamed field avoids overload — use `tier?: string` or `matchedTier`.

**D3. Stage name `"classifier"` vs debug event `"classifier.attempt"`.**
Cross-reference between trace and JSONL needs explicit mapping. Align names or document the mapping.

### Cross-ADR consistency

**C1. ADR 0008's `chain` field absent from 0007.**
0007 forward-declares `confidence` for 0010 but does **not** forward-declare `chain` for 0008. Inconsistent. Either pre-declare `chain?` on `regex_pre` now, or 0008 must list "amend 0007" as an explicit gate item.

[Author response: agreed. Add `chain?: readonly string[]` to the `regex_pre` variant and cite 0008.]

**C2. ADR 0008 violates 0007's "no mutation of kind union" constraint.**
0007 Constraints: *"…not by mutating the existing kind union."* 0008 Decision: *"returns a new classifier result kind: `{ kind: "classified_chain"; chain: string[]; source: "regex" }`."* These contradict. Resolution: 0008 carries `chain` on the `regex_pre`/`regex` stage or on `DecisionTrace` directly; do not add to `ClassificationResult.kind`. This must be fixed in 0008 before either ADR lands.

[Author response: biggest cross-ADR collision. 0008 needs a revision pass to honour 0007's constraint. The chain data rides on the trace stage, not on the result kind.]

**C3. ADR 0010's `downgrade` field absent from 0007.**
0010 says "sets `downgrade: true` on the stage" — 0007 declares `confidence?` but no `downgrade?`. The forward-declaration contract is incomplete. Add `downgrade?: boolean` to 0007's `classifier` variant now, or list "amend 0007" as a 0010 gate item.

[Author response: agreed. Add `downgrade?: boolean` to the `classifier` variant in 0007.]

**C4. `FilteredCandidate.reason` enums disagree between 0007 and 0008.**
0007: 4 members. 0008 (chain elements): 3 members (drops `trial_in_progress`). Converge to the actually-producible subset (see B4).

**C5. Citation drift.** Minor: 0007 Context cites `commands.ts:450-496` for `handlePreview`; function starts at `:448`. Fix to `:448-496`.

**Factual error in Context §2.** 0007 states `resolveTierDisplay` "does not show which candidates were circuit-open or cooldown-locked." `formatCandidateLines` (`commands.ts`) already renders skipped candidates with `openUntil` and `handlePreview` prints `requestedCandidateLines` (`commands.ts:485-486`). Circuit-open candidates ARE visible today. The ADR overstates current blindness; tighten the motivation.

[Author response: most embarrassing finding and the most correct one. The author conflated "no machine-readable form" with "not visible at all." Tighten the Context §2 paragraph. The real gap is structured + machine-readable trace, not raw visibility.]

### Verdict from reviewer

**Proposed → block before promotion.** Direction right; gate not runnable as written (B1/B2/B3 timing, B4/B5 filtered-candidate enum and source). Cross-ADR collisions C2 (0008 mutating the kind union) and C3 (0010's `downgrade` undeclared) must be reconciled in type before either sibling lands.

### Author's intended revisions before next reviewer pass

- Drop `fallback` and `select` from v1 stages OR strike "No new measurement paths" constraint and add `fallback`/`select` timing.
- Either add a `debugMeasure` returning the entry to its caller (small API change to `debug.ts`) or scope `classifyWithTrace` timing to its own `performance.now()` delta independent of `debug`.
- Scope Goal #2 to "when debug is on" OR add an always-on minimal timer for trace use.
- Trim `FilteredCandidate.reason` enum to `circuit_open | missing_from_registry` for v1; align spelling with `routing.ts:182` `open_circuit`. Add `cooldown` / `trial_in_progress` only when `reliability-store.ts` exposes derivation.
- Read `resolved.primary.skipped` / `resolved.fallback.skipped` directly; drop the reconstruction-by-diff design.
- Forward-declare `chain?: readonly string[]` on `regex_pre` variant (refs ADR 0008).
- Forward-declare `downgrade?: boolean` on `classifier` variant (refs ADR 0010).
- Settle on `attempts: ClassifierAttempt[]` shape for the `classifier` variant.
- Rename `regex.match` → `regex.tier` (or `matchedTier`).
- Fix `commands.ts:450` → `:448` citation.
- Tighten Context §2: structured + machine-readable trace is the gap, not raw visibility.