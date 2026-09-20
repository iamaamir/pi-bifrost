# Jev benchmark v1 — preliminary development results

Evaluation-only research. These results do **not** authorize production routing or establish Jev superiority.

## Setup

- Model: pinned `jev-1.13.0`
- API: TypeSafe `POST /v1/systemone`
- Corpus: `tests/corpus/jev/scenarios.jsonl`, version 1
- Tiers: `quick`, `general`, `frontier`
- Baseline: current ordered `DEFAULT_RULES`, then `general`
- Criteria: fixed contrastive descriptions from `scripts/jev-benchmark.ts`
- Development split: 48 synthetic prompts, 16 per tier
- Review split: 12 synthetic prompts, 4 per tier
- Concurrency: 4
- Per-prompt total deadline: 10 seconds
- Price calculation: published `$0.042` per million input tokens; output free

The development corpus was agent-authored and then corrected against the documented tier policy after independent review found invalid labels. It has not received dual independent human labels or adjudication. The review split was run once after criteria were fixed, but it is still development evidence rather than a locked promotion set.

## Results

| Metric | Regex/default baseline — dev | Jev — dev | Regex/default baseline — review | Jev — review |
|---|---:|---:|---:|---:|
| Correct | 31/48 | 48/48 | 6/12 | 12/12 |
| Accuracy | 64.6% | 100.0% | 50.0% | 100.0% |
| Frontier false negatives | 6/16 | 0/16 | 3/4 | 0/4 |
| Availability | n/a | 48/48 | n/a | 12/12 |
| Baseline agreement | n/a | 64.6% | n/a | 50.0% |
| p50 latency | n/a | 377 ms | n/a | 396 ms |
| p95 latency | n/a | 1,397 ms | n/a | 2,158 ms |
| Input tokens | n/a | 20,311 | n/a | 5,083 |
| Estimated cost | n/a | $0.000853 | n/a | $0.000213 |

### Probability metrics

| Metric | Development | Review |
|---|---:|---:|
| Multiclass Brier score | 0.00531 | 0.00782 |
| Log loss | 0.02295 | 0.02643 |
| Expected calibration error | 0.02146 | 0.02417 |

Lower is better for these probability metrics. With no mistakes and only 60 simple examples, these values mostly show that Jev assigned high probability to the expected tier; they do not establish broad calibration.

## Interpretation

The first result is encouraging:

- every request completed;
- Jev matched all current development labels;
- no labelled frontier prompt was under-routed;
- latency was sub-second at p50;
- total estimated input cost for all 60 prompts was about `$0.00107`.

The perfect score is also a warning that this corpus is too easy and too aligned with the tier criteria. It does not yet test the boundary cases most likely to matter in production.

Missing evidence:

- independently labelled prompts and adjudication;
- ambiguous neighboring-tier cases;
- multi-intent requests where the hardest part should dominate;
- prompts containing adversarial classification instructions;
- non-English prompts;
- long prompts with irrelevant detail;
- repeated runs for consistency and uncertainty;
- confidence intervals on a materially larger locked set;
- comparison with the current hosted prompt classifier.

## Artifacts

- Development report: [`jev-benchmark-dev-v1.json`](jev-benchmark-dev-v1.json)
- Review report: [`jev-benchmark-review-v1.json`](jev-benchmark-review-v1.json)
- Corpus: [`../../tests/corpus/jev/scenarios.jsonl`](../../tests/corpus/jev/scenarios.jsonl)
- Harness: [`../../scripts/jev-benchmark.ts`](../../scripts/jev-benchmark.ts)

The JSON reports intentionally omit prompt text and API credentials. Rows contain scenario IDs, judgments, probabilities, timings, usage, and computed baseline outcomes.

## Next gate

Before considering active routing:

1. Freeze a larger, harder corpus with independent labels.
2. Pre-register sample size, subgroup minimums, repeat count, and maximum frontier false-negative rate.
3. Add ambiguous, adversarial, multilingual, long-context, and multi-intent subsets.
4. Compare Jev with the currently configured hosted classifier using the same successful-row denominator.
5. Run the locked set without criteria changes, then report confidence intervals.
