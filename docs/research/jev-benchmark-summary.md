# Jev benchmark — executive summary and conclusion

## Bottom line

Jev `1.13.0` is promising for bounded semantic tier classification and appears cheap, fast at median, and repeatable on clear prompts. Evidence supports retaining Jev as an explicit opt-in classifier behind confidence gating and deterministic fallback.

Evidence does **not** support making Jev default, claiming it selects the “best model,” promising cost or quality gains, or adding more automatic routing. Main discovered weakness is not transport reliability; it is criteria sensitivity. Current tier wording can confidently under-route small-looking but high-consequence work.

## What was tested

Two phases produced:

- original 60-prompt synthetic development/review benchmark;
- three repeated runs of that corpus;
- 47 harder exploratory prompts covering boundaries, mixed intent, adversarial instructions, underspecified turns, multilingual prompts, irrelevant context, and high-consequence edits;
- repeated comparisons between labels-only, current criteria, richer structured criteria, and risk-first criteria;
- 12 controlled long-context prompts with task at start/end and up to approximately 12,000 words of irrelevant background;
- 651 API requests total, all pinned to `jev-1.13.0`.

Full evidence: [`jev-access-expiry-results.md`](jev-access-expiry-results.md).  
Hash manifest: [`jev-live-expiry-manifest.json`](jev-live-expiry-manifest.json).

## Key results

### Reliability, latency, and cost

| Measure | Result |
|---|---:|
| Successful requests | 648/651 |
| Availability | 99.5% |
| Failures | 2 timeouts, 1 invalid response |
| Easy-corpus p50 | 368–381 ms |
| Easy-corpus p95 | 2.4–6.5 s |
| Total input tokens | 1,017,052 |
| Estimated input cost | `$0.04272` |

Median latency and classifier cost are operationally attractive. Tail latency and malformed/timeout outcomes still require bounded timeout, validation, and fallback.

### Easy synthetic corpus

Every successful response matched all 60 existing labels across repeated runs. This demonstrates stable behavior on clear, criteria-aligned prompts. It does not demonstrate broad production accuracy; perfect performance mainly shows that corpus is too easy.

### Hard exploratory corpus

Current shipped criteria matched provisional labels on 106 of 139 successful benchmark responses, about 76%. Labels remain unresolved and were not independently adjudicated, so this is diagnostic—not publishable accuracy.

Jev handled small exploratory multilingual, mixed-intent, adversarial, and irrelevant-context subsets encouragingly. Samples are too small and agent-authored for product claims.

### Criteria wording materially changes quality

Across 141 repeated judgments:

| Criteria variant | Provisional matches | Low-confidence judgments |
|---|---:|---:|
| Labels only | 83/141 (58.9%) | 103/141 |
| Current criteria | 108/141 (76.6%) | 40–41/141 |
| Structured criteria | 112–113/141 (79.4–80.1%) | 34/141 |
| Risk-first criteria | 117/141 (83.0%) | 29/141 |

Conclusion: Jev should not receive bare tier labels. Explicit, contrastive criteria are part of classifier behavior—not documentation decoration.

## Most important failure found

Current criteria repeatedly classified small-looking but consequential work as `quick`:

- enabling deletion of dormant production accounts;
- changing a tax percentage constant;
- deleting an unused production backup table.

Tax change returned `quick` with confidence `1.00` in all three current-criteria comparisons. Current “small mechanical edit” language can dominate consequence.

Risk-first criteria made consequence override edit size. It classified all 12 high-consequence judgments as provisional `frontier`; current criteria matched only 3/12. No modal regression appeared elsewhere in this exploratory set.

This is strong evidence for a criteria redesign experiment, not enough evidence to change shipped defaults. Risk-first wording was developed after seeing corpus failures and must be evaluated on new locked examples.

## Confidence and underspecified prompts

`Hi` consistently classified as `quick` with high confidence. Prompts such as `Help me`, `Continue`, `Fix it`, and `What do you think?` were often low-confidence or unstable because Jev receives only current prompt and cannot recover missing conversational reference.

Therefore:

- retain confidence threshold;
- retain deterministic fallback;
- never treat low confidence as permission to guess;
- prefer advisory behavior when context is missing;
- do not use Jev to invent a hidden “meaningful first prompt” heuristic;
- keep sticky/session-routing semantics explicit and user-controlled.

## Long-context result

Controlled repetitive background up to about 12,000 words did not change selected tier. Confidence declined slightly when a quick task appeared after longest filler. This narrow result does not disprove TypeSafe's documented context-rot limitation: test contained benign repetitive filler and no competing task.

Do not expand Jev state from current prompt to full conversation history based on this result.

## Product decision

| Question | Conclusion |
|---|---|
| Keep Jev integration? | **Yes**, explicit opt-in with current safety boundaries. |
| Make Jev default? | **No.** Evidence insufficient. |
| Claim Jev chooses best model? | **No.** Jev judges configured semantic tier; Bifrost chooses model. |
| Claim cost or coding-quality improvement? | **No.** Not measured. |
| Keep confidence fallback? | **Yes. Essential.** |
| Keep strict validation and timeout fallback? | **Yes.** Three live failures confirm need. |
| Change criteria immediately? | **No.** First independently adjudicate labels and test risk-first wording on locked unseen cases. |
| Send full conversation history? | **No.** Increases privacy, cost, and context-rot risk without supporting evidence. |
| Add more automatic switching? | **No.** Decision traces, sticky semantics, and advisory UX come first. |

## What benchmark proves

- API contract works with pinned `jev-1.13.0`.
- Jev is highly consistent on clear criteria-aligned prompts.
- Explicit criteria improve confidence and provisional agreement over labels alone.
- Low cost makes bounded classification economically plausible.
- Existing fallback, timeout, and validation safeguards are justified.
- Criteria design can materially affect safety-critical routing outcomes.

## What benchmark does not prove

- production routing accuracy;
- superiority over a hosted prompt classifier or human routing;
- downstream coding quality;
- token, cache, latency, or total-session savings;
- robust multilingual performance;
- calibrated confidence on real user traffic;
- immunity to adversarial prompts or context rot;
- that risk-first criteria generalize beyond observed corpus;
- that automatic per-prompt switching benefits users.

## Next evidence gate

Before stronger marketing, default expansion, criteria replacement, or added automation:

1. Independently label and adjudicate existing hard corpus.
2. Create unseen locked set, especially small-edit/high-consequence cases.
3. Pre-register subgroup sizes, repeat count, confidence policy, and maximum frontier false-negative rate.
4. Compare current and risk-first criteria without editing after results begin.
5. Compare Jev against configured hosted classifier and deterministic baseline on same successful rows.
6. Add realistic multilingual, contradictory, code/log-heavy, and competing-task long-context prompts.
7. Report confidence intervals, fallback rate, tail latency, and frontier under-routing separately.
8. Run separate cache/session study; classifier accuracy alone cannot validate adaptive routing economics.

## Final conclusion

Jev is technically viable as a bounded, optional tier judge. Current evidence favors cautious continuation—not promotion. Highest-value improvement is safer criteria plus stronger evaluation, followed by transparent decision traces and advisory/session-stable routing controls. Biggest risk is confident under-routing caused by wording that mistakes textual simplicity for operational safety.
