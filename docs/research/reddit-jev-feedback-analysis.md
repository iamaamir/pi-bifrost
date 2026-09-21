# Reddit Jev launch feedback analysis

Source: [`reddit-jev-pi-comments-1wlczow.json`](reddit-jev-pi-comments-1wlczow.json)  
Post: [I think i found the best use case for JEV and PI](https://www.reddit.com/r/PiCodingAgent/comments/1wlczow/i_think_i_found_the_best_use_case_for_jev_and_pi/)  
Dataset: 50 comments; 30 external comments from 21 people; 20 maintainer replies.

## How to read this

This thread is qualitative discovery evidence, not a vote or statistically representative survey. All archived scores are `1`, so score cannot prioritize ideas. Repeated concerns, detailed workflows, misunderstandings, and independently reported constraints carry more weight than praise or isolated feature ideas.

Action labels:

- **Adopt** — evidence fits Bifrost's product boundary and should shape roadmap or messaging.
- **Improve** — existing behavior or explanation needs correction.
- **Research** — useful signal, but needs validation or design work.
- **Defer** — potentially valuable, but outside current router scope or missing evidence.
- **No action** — social response, joke, or insufficiently specific signal.

## Executive findings

### 1. Cache locality is launch's dominant unmet need

Five independent external commenters raised prompt-cache damage or model churn: `paxrt0r`, `paxtvkq`, `paygqy2`, `payq782`/`paz2x1f`, and `pb3prqg`. They do not merely ask for documentation. They question whether per-turn routing can deliver net value after cache misses, latency, and provider pricing.

**Adopt:** make session continuity first-class. ADR 0019's explicit sticky mode is strongest product-shaped answer: route first meaningful task, retain actual model, allow deliberate one-turn tier overrides, preserve pin as hard lock. Keep proposed until transition semantics, visibility, and tests satisfy its implementation gate.

**Improve now:** lead Jev messaging with routing modes and cache tradeoffs, not only classification speed. Explain that adaptive routing is one mode, not universal recommendation. Quantify no savings until measured; avoid cost-saving claims without provider-aware evidence.

### 2. Users fear probabilistic loss of control more than classifier latency

Comments describe “Jev roulette,” bad first-button choices, quota burn, and unwanted context breaks. Several readers inferred Jev directly chooses a provider/model or randomizes candidates. Actual architecture is safer: Jev judges configured tiers; Bifrost validates confidence and applies user-owned pools, health filters, and strategies.

**Improve:** show this separation before installation:

```text
Jev: task → configured tier probabilities
Bifrost: confidence gate → fallback → configured candidates/strategy
Pi: activate exact model
```

Add one concrete deterministic example (`frontier: [luna]`, `quick: [cheap-model]`, strategy `first`) and one rejected-low-confidence example. Do not use “best model” as shorthand; it contradicts actual tier-level behavior.

### 3. Product needs evidence that Jev judgments are useful

`paxzvmn` and `pb5a41l` challenge decision quality. `pb455ob` challenges novelty. Current reply asks whether criticism is proven, but Bifrost also has burden of proof.

**Adopt:** publish bounded evidence, not general Jev superiority claims:

- tier-classification accuracy on versioned synthetic/redacted scenarios;
- low-confidence rejection rate;
- fallback rate;
- latency distribution;
- per-decision classifier cost;
- comparison against regex/default and configured prompt classifier;
- explicit statement that benchmark does not prove downstream coding quality or savings.

Existing `tests/corpus/jev/` is foundation. Keep real Reddit text out of development/evaluation corpus unless separately consented, redacted, labelled, and split to prevent leakage.

### 4. Local/open alternatives are meaningful, but not immediate implementation approval

Von and Laya appear repeatedly (`paxqbii`, `paz1vr6`, `pazmswc`, `pb0ym3o`, `pb455ob`). Signals: privacy, zero per-request fee, lower round-trip latency, and self-hosting preference. Counter-signal: setup and Pi integration are unclear.

**Research:** document backend contract and evaluate one local adapter against same strict decoder, confidence, timeout, privacy, and fallback requirements. Do not hardcode specific local projects into defaults or imply support before deterministic integration exists. Prefer pluggable classifier transport over product-specific branches if architecture permits.

### 5. Naming and positioning cause avoidable confusion

`paz1vr6` confused Pi-Bifrost with another open-source Bifrost gateway. Other comments assumed proxy/gateway semantics.

**Improve:** consistently say “Pi extension; not a gateway or proxy” near first use of name. Add a short “not related to Bifrost gateway projects” note in README/landing FAQ. Emphasize native Pi model activation.

### 6. Advisory routing has stronger trust fit than more silent automation

`payss4m` explicitly asks for suggestions without routing or context break. `paz2x1f` proposes status-bar advice with confidence. This directly matches product ladder: observable signal → advisory recommendation → opt-in automation.

**Adopt:** after decision traces, explore advisory mode that reports recommended tier/model and confidence without switching. Requirements: explicit mode, no alarmist color-only signal, accessible text, configurable threshold, preview parity, and no hidden provider/model scoring.

### 7. Tool, skill, workflow, permission, response-selection, and continuation ideas are adjacent—not Bifrost scope

`payd51a`, `payics3`, `payn4ew`, `payss4m`, `pb1vtm0`, `pb43s4h`, and `pb37rxu` propose broader decision uses. These validate “bounded judgment” as a pattern, but most would turn Bifrost into a policy engine or orchestrator.

**Defer/reject for Bifrost:** do not add skill loading, tool selection, workflow/subagent orchestration, permission automation, best-of-N response judging, retries, or done/continue loops to this project. They require separate safety models and violate current product boundary. Capture as ecosystem/plugin opportunities, not Bifrost roadmap items. Never implement automatic “poor-quality → try again” because it can replay side effects.

### 8. Maintainer communication needs tighter claims and better listening

One user asked for first-turn-only routing. Replies initially claimed current prefixes solved it, then claimed it could already be done; they did not. ADR 0019 correctly records missing behavior. Other replies contain typos and uncertain setup guidance.

**Improve:** answer in four parts: current behavior, limitation, safe workaround, tracked proposal. Avoid “you can do that today” unless verified. Avoid inviting a fork before agreeing on semantics and tests. Use exact terms: adaptive, pinned, proposed sticky; classifier tier choice; strategy model choice.

## Recommended decisions

### Adopt

1. **Prioritize cache-safe sticky routing design** from ADR 0019 after approval gates.
2. **Add advisory-only recommendation mode** as a post-trace candidate, starting with design evidence rather than automation.
3. **Publish classifier evaluation evidence** with bounded claims and baseline comparisons.
4. **Make deterministic user control the lead story:** configured tiers, confidence gate, fallback, exact-model activation.
5. **Add explicit product identity:** Pi extension, no proxy, unrelated to similarly named gateways.

### Improve

1. Replace `prompt → JEV → best model` with `prompt → Jev tier judgment → Bifrost policy → configured model`.
2. Explain adaptive/pinned/sticky-proposed behavior next to prompt-cache guidance.
3. Add quota-sensitive configuration example using fixed ordered candidates and no `random` strategy.
4. State current Jev transport precisely: official TypeSafe endpoint; OpenRouter availability does not mean Bifrost uses it.
5. Add local-backend FAQ: unsupported today, what a compatible backend must provide, and why setup is non-trivial.
6. Tighten public replies and docs for spelling, confidence, and verified capability claims.

### Research

1. Provider-aware cache/cost model for A → B → A and long sessions.
2. Local classifier adapter feasibility for Von/Laya or a generic compatible transport.
3. Advisory recommendation UX and confidence semantics.
4. “First meaningful task” definition: first prompt may be `hi`; sticky mode needs explicit semantics, not hidden prompt-quality heuristics.
5. Real-world routing outcome collection that is local, opt-in, content-safe, and useful for evaluation.

### Defer or reject

1. Tool/skill/workflow/subagent orchestration inside Bifrost.
2. Automatic permission decisions.
3. Best-of-N answer selection.
4. Automatic continue/retry after assistant output.
5. Provider quota inference without authoritative telemetry.
6. Default self-hosted model IDs or dependencies.
7. Claims that Jev is universally “best,” cheaper, or higher quality.

### Remove

1. Remove “best model” wording where Jev only selects a tier.
2. Remove implication that per-turn adaptive routing is recommended for every session.
3. Remove implication that JEV randomizes exact models; randomness occurs only under explicit Bifrost strategy.
4. Remove unsupported savings claims until cache-aware measurements exist.
5. Remove vague “model agnostic” answers when question needs concrete control flow.

## Prioritized opportunity map

| Priority | Opportunity | Evidence | Product fit | Next proof |
|---|---|---:|---|---|
| P0 | Clarify architecture and cache tradeoff | Strong, repeated | High | Docs/landing review against five cache comments |
| P0 | Validate Jev tier quality | Strong challenge | High | Publish corpus methodology and baseline results |
| P1 | Sticky session routing | Strong, repeated | High | Approve ADR 0019 semantics and transition tests |
| P1 | Advisory-only recommendation | Two explicit users + philosophy fit | High | UX/design proposal after trace shape stabilizes |
| P2 | Local classifier backend contract | Four comments | Medium | Spike one adapter; measure setup, latency, decoding |
| P3 | Broader bounded-decision plugins | Several ideas | Low for Bifrost | Separate project/extension exploration |

## Comment-by-comment evidence ledger

Each archived comment appears once below. Maintainer replies are analyzed because they expose messaging and product-understanding gaps.

| ID | Actor | Signal | Learning | Action |
|---|---|---|---|---|
| `paxobqg` | User | Asks whether Luna/Sol should manage routing | Readers think router must be one named model | **Improve:** explain interchangeable classifier backend versus Bifrost-owned policy |
| `paxpo07` | Maintainer | Proposes rules → Jev → frontier escalation | Sensible concept, but unapproved and broader than shipped behavior | **Research:** confidence-based escalation only through explicit config and trace; avoid presenting long-term idea as current feature |
| `paxqbii` | User | Recommends Von/Laya to avoid per-request fees | Local cost/privacy alternative has demand | **Research:** generic local classifier contract; no default dependency |
| `paxqfv8` | Maintainer | Promises to look into alternatives | Correct openness, no concrete expectation | **Improve:** record research criteria rather than vague commitment |
| `paxrt0r` | User | Asks whether solution respects prompt cache | Cache impact is immediate purchase criterion | **Adopt:** surface cache behavior beside routing pitch |
| `paxtvkq` | User | Asks about prefix cache over many switches | Long-session switching model unclear | **Adopt:** explain A → B → A cache behavior and sticky/pin options |
| `paxtxph` | Maintainer | Recommends pinned orchestrator plus routed subagents | Workaround may help, but risks implying Bifrost orchestrates subagents | **Improve:** separate Pi child-session behavior from Bifrost scope; verify inheritance claim in docs/tests |
| `paxytph` | Maintainer | Posts only documentation link | Link-only reply misses direct answer and trust concern | **Improve:** summarize answer, limitation, then link |
| `paxzvmn` | User | Challenges assumption Jev routes better; highlights cascading error | Tier misclassification has high leverage; quality needs proof | **Adopt:** evaluate accuracy, confidence rejection, and fallback; avoid superiority framing |
| `pay0hf9` | Maintainer | Says Jev is one option in model-agnostic system | Correct direction but still vague | **Improve:** show exact tier/policy separation |
| `pay0mxz` | Maintainer | Claims Jev is fast, cheap, built for classification | Useful hypothesis, not sufficient product evidence | **Improve:** attach measured latency/cost and bounded quality result |
| `pay3xbr` | User | Independently building Jev/LiteLLM role pools | Confirms routing use case and interoperability interest | **Research:** study candidate-pool vocabulary and integration boundaries; no proxy pivot |
| `payd51a` | User | Suggests skills, subagents, tools, best-of-N, project context, goals, continuation loop | Bounded judgment has broad appeal; most ideas exceed router scope | **Defer:** ecosystem opportunities; explicitly reject automatic retry/replay inside Bifrost |
| `paygqy2` | User | Questions quality versus price and warns routing may raise total cost | Value proposition lacks declared objective and cache-aware accounting | **Adopt:** ask users to choose continuity/quality/cost policy; never promise savings by default |
| `payhfyx` | User | Prefers deterministic subagent models; fears quota burn and randomization | Exact assignments remain valuable; randomness misunderstood | **Improve:** show Jev selects tier only; add quota-safe fixed-order example |
| `payics3` | User | Supports skill hooks; proposes permission auto mode | Skills have interest; permissions raise separate safety problem | **Defer:** outside Bifrost; no permission automation without dedicated project and proof |
| `payn4ew` | User | Says general bounded-choice tools are easy/useful | Potential standalone primitive, not router requirement | **Defer:** separate extension/library idea |
| `payn72r` | Maintainer | Gives accurate tier-versus-model control flow | Strongest explanatory reply; should become canonical concise diagram | **Adopt:** reuse structure in docs, but shorten and fix spelling |
| `payq782` | User | Wants automatic choice only once, then manual routing | Clear missing middle between adaptive and pinned | **Adopt:** core evidence for ADR 0019 sticky mode |
| `payss4m` | User | Wants skill suggestions, not automatic context changes | Advisory behavior builds trust | **Adopt:** advisory mode candidate; keep skill routing outside Bifrost |
| `paytkfw` | Maintainer | Answers first-turn-only request with tier prefix | Misunderstands request; existing feature does not satisfy it | **Improve:** acknowledge gap; distinguish override from session mode |
| `payw0a2` | User | Corrects misunderstanding | Communication failure is explicit | **Improve:** restate request before proposing answer |
| `payy93d` | Maintainer | Claims requested mode already works | Incorrect capability claim | **Remove/correct:** current behavior is adaptive or pinned; sticky remains proposed |
| `paz1vr6` | User | Confuses project with Bifrost gateway; prefers local no-round-trip classifier | Name collision and architecture ambiguity hurt comprehension | **Improve:** “Pi extension, not gateway/proxy”; **Research:** local transport |
| `paz2x1f` | User | Specifies sticky first-route plus manual switch and status recommendation | Detailed, high-value workflow with cache goal | **Adopt:** ADR 0019 evidence plus advisory-mode input; do not use red as sole signal |
| `paz3yvz` | Maintainer | Explains projects are unrelated | Confirms naming problem but trivia does not resolve future confusion | **Improve:** permanent FAQ/readme disambiguation |
| `paz4buv` | Maintainer | Notes local alternatives are new/hard to set up | Setup burden is valid adoption constraint | **Research:** measure install UX and maintenance before support |
| `paz4xzo` | Maintainer | Notes first prompt may be `Hi` | First-turn routing semantics need care | **Research:** explicit “establish base” command or documented eligibility; avoid opaque meaningfulness detection |
| `paz5xwx` | User | Reiterates manual switch plus advisory signal | Trust requires user control over uncertain changes | **Adopt:** advisory recommendation before automation |
| `paz7kav` | Maintainer | Invites fork/contribution | Community interest useful, but design still unresolved | **Improve:** provide issue/ADR and acceptance criteria before soliciting code |
| `paza95z` | User | Wants to contribute but lacks Jev access | Hosted access blocks contributors | **Improve:** keep fallback/fake transport testable without Jev credentials |
| `pazal2x` | Maintainer | Social follow-up | No product evidence | **No action** |
| `pazmswc` | User | Rejects non-open/non-self-hostable Jev | Deployment philosophy can block adoption entirely | **Research:** local backend; keep Jev optional and defaults model-agnostic |
| `paznjfb` | User | Says “rag” | Too little context to infer request | **No action:** ask clarifying question if engagement continues |
| `paznua1` | Maintainer | Mentions open System One models | Directionally useful but vague | **Improve:** name only verified compatible options and clearly mark unsupported status |
| `pazztgb` | User | Sarcastically claims character-by-character generation | Pushback against overhyping speed/general capability | **Improve:** keep claims narrow; **No feature action** |
| `pb0ym3o` | User | Cannot determine how to use Von/Laya with Pi | Integration docs/setup are missing in ecosystem | **Research:** adapter feasibility; do not imply support exists |
| `pb1vtm0` | User | Suggests routing tool calls and skills | Wrong-tool failures are real but separate policy surface | **Defer:** not Bifrost scope; potential separate extension |
| `pb224oe` | User | Independently rebuilt similar router | Discovery and differentiation are weak; validates demand | **Improve:** SEO/readme comparison and clear existing capabilities |
| `pb2g3yd` | User | Notes Jev available through OpenRouter | Users expect provider flexibility | **Improve:** state Bifrost currently uses official fixed TypeSafe endpoint; evaluate alternatives separately |
| `pb37rxu` | User | Uses Jev for confidence/completion verification | Confidence/doneness is adjacent bounded judgment | **Defer:** separate verifier; never couple to automatic replay |
| `pb3prqg` | User | Calls routing cache-destructive and costly | Repeated core objection, even in hostile phrasing | **Adopt:** answer with modes, measurements, and limits—not defensiveness |
| `pb43s4h` | Maintainer | Says tools/skills are good additions | Risks uncontrolled scope expansion | **Remove/reframe:** good ecosystem idea, not approved Bifrost feature |
| `pb43u6j` | Maintainer | Says “Nice” to verification use case | No product evidence | **No action** |
| `pb43y4f` | Maintainer | Gives uncertain local-model setup advice | Speculation weakens trust | **Improve:** verify path or explicitly say unsupported/unknown |
| `pb441sv` | Maintainer | Clarifies extension is older; Jev support is new | Product maturity versus launch novelty was unclear | **Improve:** title/release notes should say “Jev backend added to existing router” |
| `pb455ob` | User | Says Jev is structured output with thinking off and easy self-hosting | Novelty claim contested; implementation category needs precise comparison | **Research:** compare typed judgment/probabilities/confidence against structured-output baseline; avoid novelty marketing |
| `pb5a41l` | User | Claims Jev makes fast bad decisions | Direct quality skepticism | **Adopt:** evidence burden; expose confidence/fallback and evaluation results |
| `pb5hyfu` | Maintainer | Asks whether criticism is proven | Fair question, but shifts burden to critic | **Improve:** respond with available evidence and invite reproducible counterexample |
| `pb6g249` | User | Thanks commenter for local alternatives | Weak positive signal for local option awareness | **Research:** counted only as supporting interest, not feature demand |

## Questions requiring decisions before implementation

1. Should sticky mode establish its base from first eligible prompt, current active model, or explicit command?
2. Should advisory mode recommend a tier only, or also show Bifrost's resulting configured model candidate?
3. What evidence threshold permits claims such as “faster,” “cheaper,” or “better routing”?
4. Is local classifier support best expressed as one generic backend contract or named integrations?
5. Which public telemetry, if any, can prove value without retaining prompt content?

## Suggested next sequence

1. Correct messaging and capability claims first.
2. Run/publish Jev evaluation against current baselines.
3. Finalize decision-trace shape.
4. Review and approve/reject ADR 0019 sticky semantics.
5. Design advisory mode using same trace data.
6. Evaluate local backend only after transport contract and maintenance cost are clear.

This sequence follows Bifrost's product ladder: explicit configuration → observable evidence → advisory recommendation → explicit opt-in → bounded automation.
