# Pi-Bifrost post-launch Jev decisions

## Inherited decisions

- Bifrost remains configuration-first router. Native Pi model activation. No proxy, orchestration, hidden scoring, automatic replay, provider-specific defaults, or override bypass. [`AGENTS.md`](../../AGENTS.md), [`docs/product-philosophy.md`](../product-philosophy.md)
- TypeSafe/Jev is implemented opt-in tier judgment. Bifrost owns candidates, health, strategy, fallback; Pi activates exact model. [`docs/jev-typesafe-architecture.md`](../jev-typesafe-architecture.md)
- ADR 0007 and ADR 0019 remain proposed. No behavior approval follows from research. [`docs/adr/0007-decision-traces.md`](../adr/0007-decision-traces.md), [`docs/adr/0019-session-sticky-routing.md`](../adr/0019-session-sticky-routing.md)

## Decisions approved now

### Docs

1. Correct launch explanation everywhere:  
   `prompt → Jev tier judgment → Bifrost configured policy → Pi exact active model`.  
   Remove “best model,” universal savings, universal speed, and implied random selection. Evidence: post body, `payhfyx`, `payn72r`, `paygqy2`. Source: [`docs/research/reddit-jev-pi-comments-1wlczow.json`](reddit-jev-pi-comments-1wlczow.json).

2. Add near install/title: “Pi extension; not gateway or proxy; unrelated to similarly named Bifrost gateway projects.” Evidence: `paz1vr6`, `paz3yvz`.

3. Add routing-mode/cache guidance: adaptive can harm provider cache locality; pin is current continuity control; sticky is proposed, not shipped. Include “when not to use adaptive routing.” Evidence: `paxrt0r`, `paxtvkq`, `paygqy2`, `pb3prqg`.

4. Correct local/OpenRouter wording: current TypeSafe backend uses fixed official endpoint; Von/Laya/OpenRouter unsupported. No setup guesses. Evidence: `pb2g3yd`, `pb0ym3o`, `pb43y4f`; source: [`docs/jev-typesafe-architecture.md`](../jev-typesafe-architecture.md).

### Research

5. Publish benchmark v1 only as preliminary synthetic development evidence, with its limits. Freeze harder independently labelled corpus before comparative claims. [`docs/research/jev-benchmark-v1.md`](jev-benchmark-v1.md)

6. Run cache/session study before savings or cache-safe claims: fixed model vs adaptive vs sticky candidate, including A→B→A override tail. No prompt retention by default.

7. Define local typed-classifier contract only as architecture research. No named adapter commitment, default ID, or provider branch.

### Roadmap

8. Keep v0.4 transparency work ahead of new automation. Do not move ADR 0019, advisory mode, or local support to implementation status. Add post-launch evidence gates beside them. [`ROADMAP.md`](../../ROADMAP.md)

## Behavior decisions

- **Decision traces:** revise, re-review, then accept/reject. Do not implement current ADR 0007.
- **Sticky mode:** advance to decision packet only. If accepted later: opt-in, disabled default; fresh sticky base = first non-command prompt; mid-session base = current active model; no “meaningful prompt” heuristic; pin stays hard lock; override remains one-turn and trace-visible. `hi` remains user choice, not classifier problem. Evidence: `payq782`, `paz2x1f`, `paz4xzo`.
- **Advisory mode:** advance after trace shape exists. Show recommended tier **and resulting configured candidate**, confidence/source/exclusions, accessible text, explicit apply action. Never switch automatically. Evidence: `payss4m`, `paz2x1f`, `paz5xwx`.
- **Config linter:** retain existing ADR 0009 priority. Advisory warnings only for random/quota-risk patterns; never infer provider quotas.
- **Local backend:** research only. Existing backend enum and TypeSafe validation mean generic transport needs an ADR, not “one adapter.”
- **Automatic retry/continue:** reject.

## Exact priority and gates

1. **P0: public/docs correction.** Evidence: capability confusion and false sticky claim `paytkfw`, `payw0a2`, `payy93d`; gateway confusion `paz1vr6`.  
   **Gate:** source-verified copy review; no unsupported claim remains.

2. **P1: locked Jev evaluation plus cache-cost study.** Evidence: quality challenge `paxzvmn`, `pb5a41l`; cache/cost objections `paxrt0r`, `paygqy2`, `pb3prqg`.  
   **Gate:** pre-registered corpus, independent labels/adjudication, hard subsets, baseline prompt-classifier comparison, repeated runs, limitations published. No downstream-quality or savings claim.

3. **P2: revise ADR 0007, then approval review.** Evidence: inspectability promise; [`docs/adr/0007-decision-traces.md`](../adr/0007-decision-traces.md).  
   **Gate:** trace omits raw normalized prompt from serializable form; timing contract works with debug off or scope is explicit; direct structured skipped-candidate source; multi-attempt representation; ADR 0008/0010 types reconciled; deterministic tests.

4. **P3: ADR 0019 approval decision, then implementation only if gate passes.** Evidence: `payq782`, `paz2x1f`.  
   **Gate:** all ADR transition scenarios, host activation checks, status/preview non-mutating behavior, cancellation/manual-selection/reload semantics, docs/schema/init alignment.

5. **P4: advisory design.**  
   **Gate:** P2 trace accepted; explicit enable/disable/apply; deterministic no-switch tests; accessible status text.

6. **P5: linter and local-backend research.**  
   **Gate:** linter remains advisory; local contract proves strict decode, timeout, fallback, privacy, credential, maintenance story.

## Explicitly outside Bifrost

Reject skills/tool routing, permission automation, workflow/subagent orchestration, generic decision engine, best-of-N response selection, completion/doneness loops, automatic continue, and any replay. Evidence: `payd51a`, `payics3`, `payn4ew`, `pb1vtm0`, `pb37rxu`, `pb43s4h`. These need separate safety and host-control models.

## Claims/replies needing correction

- Post: “`prompt → JEV → best model`” — false authority boundary.
- `paytkfw`/`payy93d`: prefix does not provide first-route-only session behavior.
- `pay0mxz`: “fast, cheap” needs bounded measured wording from benchmark, not product conclusion.
- `paxtxph`: do not present subagent routing/inheritance as Bifrost product behavior without host proof.
- `paznua1`/`pb43y4f`: remove speculative local setup guidance.
- `pb43s4h`: retract “tools calls and skills” as Bifrost addition; ecosystem idea only.

## Drift / contradiction check

- Benchmark says gate is “before considering active routing,” while Jev routing is already implemented opt-in. Revise gate: before stronger marketing, default expansion, or more automation. [`docs/research/jev-benchmark-v1.md`](jev-benchmark-v1.md), [`docs/jev-typesafe-architecture.md`](../jev-typesafe-architecture.md)
- Feedback analysis treats sticky as cache answer without session measurement. Sticky reduces normal churn; one-turn override still creates A→B→A. [`docs/research/reddit-jev-feedback-analysis.md`](reddit-jev-feedback-analysis.md)
- Coverage map calls generic local contract small research, but current config supports only `prompt` and `typesafe`; this is architecture/config change. [`docs/research/reddit-jev-coverage-gap-map.md`](reddit-jev-coverage-gap-map.md)
- ADR 0007 reviewer claims `trial_in_progress` unavailable. Current `routing.ts` emits `trial_active`; enum naming/source remains wrong, claim does not. ADR also overstates preview blindness: current candidate lines show open circuits.
- ADR 0007 serializable `prompt` conflicts with sensitive-normalized-text guardrail. Remove from trace payload.

## 30/60/90 outcome plan

- **30 days:** corrected docs/reply template; benchmark limitations published; evaluation and cache-study protocols frozen; ADR 0007 revised.
- **60 days:** locked evaluation/cache findings published; ADR 0007 accepted or rejected; ADR 0019 command/state decision completed.
- **90 days:** ship only accepted transparency work; sticky only if full transition gate passes; advisory remains design unless trace and usability gates pass.

## Risks

- Reddit sample is qualitative: 30 external comments, 21 people, identical archived score. Not demand sizing.
- No provider-authoritative cache or quota data.
- Sticky can preserve continuity yet still harm cache around explicit overrides.
- Benchmark labels remain non-independent until P1 gate passes.

## Need from main agent

Owner signoff needed for public corpus governance: consent/redaction, independent labeller selection, adjudication, and publication rules. No runtime behavior needs approval before P2/P3 gates.

## Suggested execution prompt

No executor handoff warranted.