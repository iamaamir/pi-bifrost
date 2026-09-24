# Jev access-expiry capture results

See:

- Plan: [`jev-access-expiry-plan.md`](jev-access-expiry-plan.md)
- Manifest and hashes: [`jev-live-expiry-manifest.json`](jev-live-expiry-manifest.json)
- Existing corpus: [`../../tests/corpus/jev/scenarios.jsonl`](../../tests/corpus/jev/scenarios.jsonl)
- Hard exploratory corpus: [`jev-expiry-hard-corpus.jsonl`](jev-expiry-hard-corpus.jsonl)
- Criteria capture script: [`../../scripts/jev-expiry-criteria-capture.py`](../../scripts/jev-expiry-criteria-capture.py)

## Scope and limits

This was a time-boxed evidence capture before temporary TypeSafe/Jev access expired. It used pinned `jev-1.13.0` and synthetic prompts only. No Reddit comments, private prompts, credentials, source files, or tool output were sent.

The hard corpus contains 47 provisional, explicitly unresolved labels. Its “accuracy” figures are diagnostic comparisons against those provisional labels—not publishable quality evidence, locked-test results, or authorization to change routing policy.

## Captured evidence

- Three live runs over existing 60-prompt development/review corpus.
- Three live runs over 47 hard exploratory prompts.
- Three repeated within-request comparisons of labels-only, shipped criteria, and structured criteria.
- Three repeated comparisons adding a risk-first criterion variant.
- Two current-criteria and two multi-criteria runs over controlled long, noisy prompts with task at start/end.
- TypeSafe model-list metadata snapshot.
- Full probabilities, confidence, model identity, latency, usage, and errors.
- File hashes and exact commands.

Total capture:

| Metric | Value |
|---|---:|
| API requests | 651 |
| Successful requests | 648 |
| Availability | 99.5% |
| Input tokens | 1,017,052 |
| Output tokens | 57,846 |
| Estimated input cost at captured `$0.042/Mtok` | `$0.04272` |
| Credential persisted | No |
| User/Reddit text sent | No |

## Existing corpus repeat

Across three 60-prompt runs:

| Run | Availability | Accuracy among successful rows | p50 | p95 |
|---|---:|---:|---:|---:|
| 1 | 59/60 | 59/59 | 368 ms | 2,383 ms |
| 2 | 60/60 | 60/60 | 381 ms | 6,516 ms |
| 3 | 60/60 | 60/60 | 376 ms | 3,582 ms |

One request timed out at 10 seconds. Every successful row matched existing development label. Observed model was always `jev-1.13.0`.

Interpretation remains unchanged: corpus is easy and synthetic. Repeat confirms contract stability on those examples, not broad routing superiority.

## Hard exploratory corpus repeat

Hard corpus covers:

- neighboring-tier boundaries;
- mixed-intent requests;
- tier/model/price instruction injection;
- trivial or context-free session openings;
- eight non-English prompts;
- irrelevant context;
- tiny but high-consequence changes;
- broad mechanical tasks.

Three shipped-criteria benchmark runs produced 139 successful responses from 141 requests. Failures: one timeout and one structurally invalid response. Provisional-label matches were 36/47, 35/46, and 35/46.

Main stability exception was underspecified `Fix it.`: selections varied between `frontier` and `quick`, always with low confidence. This supports fallback/advisory handling—not automatic action—when prompt lacks referenced context.

## Criteria experiment

Each prompt was sent once per run with independent parallel Choice questions over identical state:

1. tier labels only;
2. current shipped criteria;
3. richer structured criteria;
4. risk-first structured criteria.

Across three repeated runs (141 judgments per variant):

| Variant | Provisional matches | Confidence `< 0.8` | IDs with repeated choice instability |
|---|---:|---:|---:|
| Labels only | 83/141 (58.9%) | 103/141 | 4 |
| Current criteria | 108/141 (76.6%) | 40–41/141 | 0–2 across capture batches |
| Structured criteria | 112–113/141 (79.4–80.1%) | 34/141 | 1 |
| Risk-first criteria | 117/141 (83.0%) | 29/141 | 0 |

Because labels are provisional and criteria were tested on same corpus used to identify weaknesses, these numbers are development diagnostics only.

### Strong signal: explicit criteria matter

Labels-only judgment disagreed with criteria-bearing judgments frequently. Current criteria materially improved provisional agreement, confidence, and repeat stability. This supports keeping explicit contrastive tier criteria as mandatory Jev input.

### Strong signal: shipped criteria underweight consequence

Current criteria classified these tiny but consequential tasks as `quick` across all three risk-comparison runs:

- enabling deletion of dormant production accounts;
- changing a tax percentage constant;
- deleting an unused production backup table.

Tax change returned `quick` at confidence `1.00` in every current-criteria run. “Small mechanical edit” language appears able to dominate general instruction to judge consequence.

Risk-first criteria explicitly stated that security, financial, destructive, production, and data-integrity consequence overrides textual edit size. It classified all 12 consequence judgments (four prompts × three runs) as provisional `frontier`; current criteria matched only 3/12. Within this exploratory set, risk-first changed three modal outcomes and all three changes moved toward provisional labels, with no modal regression.

This is important evidence, not sufficient promotion proof. Next step is independent review of labels and new locked consequence cases before changing defaults.

### Underspecified prompts remain unsuitable for automatic base selection

`Hi` consistently mapped to `quick` with high confidence. `Help me`, `Continue`, `Fix it`, and `What do you think?` generally produced low-confidence or unstable choices. Jev sees only current prompt, so missing conversation reference cannot be recovered.

Implications:

- confidence fallback remains necessary;
- first-turn sticky semantics should remain explicit and user-owned;
- do not invent hidden “meaningful prompt” detection from these results;
- advisory or default-tier behavior is safer for context-free prompts.

### Multilingual and adversarial subsets were encouraging but tiny

Current and structured criteria matched all provisional multilingual, mixed-intent, adversarial, irrelevant-context, and preference labels in this small corpus. Samples are too few and agent-authored; they justify harder locked testing, not public claims.

## Controlled long-context capture

A separate 12-prompt corpus placed a clear `quick` or `frontier` task before or after repeated irrelevant project background at approximately 100, 2,000, and 12,000 words. Two normal benchmark runs and two multi-criteria runs completed 48/48 requests successfully.

All captured variants selected the provisional tier in every case. Current-criteria confidence for the 12,000-word quick task declined slightly when task appeared at end (`0.93–0.95`) versus start (`0.99`); frontier cases remained near `1.00`. Normal benchmark p50 was about 1.1 seconds and p95 ranged from about 2.3 to 3.2 seconds.

This does **not** refute TypeSafe's documented context-rot warning. Filler was repetitive, benign, and carried no competing task. Result proves only that this controlled pattern remained stable below documented state limits. Future locked testing needs diverse distractors, contradictory requirements, code/log content, and competing tasks.

## Decisions enabled by capture

1. Preserve explicit contrastive criteria; labels alone are inadequate.
2. Add independently labelled “small edit, high consequence” cases to next locked corpus.
3. Review current canonical criteria wording before any stronger marketing/default expansion.
4. Keep confidence gating and deterministic fallback.
5. Treat underspecified first prompts as policy/UX problem, not classifier intelligence problem.
6. Keep current-prompt-only state; do not expand to full conversation history based on controlled long-context success.
7. Do not claim savings, downstream coding quality, multilingual strength, calibration, context-rot immunity, or Jev superiority from this capture.

## Offline work now possible without Jev access

- Independent label review and adjudication.
- Cross-run choice/probability/confidence analysis.
- Criteria error taxonomy.
- Threshold simulation from stored distributions.
- Decision-trace fixture creation using stored responses.
- Sticky/advisory product decisions.
- Public benchmark wording and limitations.
- New locked-corpus design; live execution waits for future access.
