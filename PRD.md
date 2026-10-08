# Bifrost: explicit, inspectable route resolution

**Status:** release design authorized for implementation on 7 October 2026. Accepted behavior and remaining gates are tracked in [RELEASE-PLAN.md](RELEASE-PLAN.md); this document specifies scope, not completion.
**Research date:** 7 October 2026.
**Baseline:** upstream `main` / v0.5.0, `236622dbc40789e8ca82226337a26cdd1eb26d2f`.
**Companion:** [IMPLEMENTATION.md](IMPLEMENTATION.md). Requirement IDs below are the acceptance contract for that plan.

## 1. Product decision

Evolve Bifrost by making its existing route resolution reusable and complete, then adding explicit eligibility boundaries. Preserve the configuration-first identity: mechanisms describe facts; users decide how facts influence routing. Do not turn this release into a policy engine, gateway, account manager, or orchestrator.

**Review decisions:** image support deferred; recovery closure requires circuit-generation checks; quota policy specifies source/window/reset semantics; automatic quota routing requires one verified live adapter; strict fallback ships as an independent slice.

The first delivery improves explanations without changing routes. The next introduces opt-in capability enforcement and fallback boundaries. Scoped reliability, economic signals, and affinity follow only after their evidence can be inspected. A public decision API follows a stable internal contract rather than driving a wholesale package rewrite.

The requested expansion is a direction, not a commitment to implement all mechanisms. In particular, accurate multi-account dispatch, enforceable monetary caps, and provider cache savings require host or provider evidence that is not currently available. Interfaces must represent those unknowns rather than fabricate certainty.

### Outcomes

1. A developer can predict whether a prompt stays within a configured tier and why a candidate was selected or rejected.
2. A configured tier boundary stops an unavailable route before generation rather than escaping to an unintended model.
3. A known shared outage or account limit can suppress the correct set of candidates, without suppressing unrelated accounts or replaying work.
4. Users can experiment with subscription preference and session continuity without inheriting provider or task semantics.
5. Extensions can request a decision without switching the user's model or changing session affinity.

### Non-goals

- Automatic prompt replay, including behind a config toggle. A future independent design would need per-incident human confirmation, a host-proven zero-side-effect boundary, deterministic E2E coverage, and an approved ADR.
- Subagent creation, workflow execution, ACP servers, proxies, network RPC listeners, credential rotation, or account switching.
- Built-in opinions that coding belongs on a particular provider, frontier is planning-only, expensive means competent, or subscriptions always outrank metered access.
- Image-input detection, steering, enforcement, attachment previews, or image-specific tests in this evolution. Pi may retain its existing attachment behavior; Bifrost makes no image-suitability guarantee.
- Response caching, prompt replay stores, cloud analytics, automatic policy tuning, live-provider tests as release gates.
- Immediate removal of prompt/TypeSafe transports. The roadmap's post-v1 transport slimming requires separate semantic-parity evidence and migration approval.

## 2. Evidence and current architecture

Both repositories were cloned directly and their source and relevant history inspected. The fresh upstream HEAD equals the local checkout; findings below are bound to that SHA, not to moving `main` URLs. Fork HEAD was `9139163ecb0474a3223f0e9e4c7a92259f2cf430`. Pi v1.0.1 source was checked at `a7229ddc21810d6245105978033b7df645ecc2f7`. Source review establishes implementation presence, not live-provider behavior or routing quality.

### 2.1 Upstream inventory

| Surface | Source-backed current behavior | Consequence for design |
|---|---|---|
| Package | Root-level TypeScript modules, one package, `index.ts` Pi extension; Pi 1.0.1 minimum; MIT; no stable routing export map in `package.json` | Keep one package initially; add a narrow export only after publication smoke tests |
| Configuration | `config.ts` loads built-in → extension → global → project root → `.pi`; nested fields shallow-merge, arrays replace; `schema.json` draft-07; separate route files override inline rules | Normalize existing shapes; do not rename `models`/`categoryStrategies` or rewrite layers |
| Tiers/models | Arbitrary tier keys; string or ordered string-array pools; qualified IDs resolve exactly, unqualified patterns match provider/id substrings; dedup preserves discovery order | Strict membership must freeze resolved identities per registry snapshot; exact IDs recommended for sensitive tiers |
| Classification | `classification-pipeline.ts`: first regex match checked for direct binding, cache, direct backend, ordered prompt classifier attempts, regex, default; `ClassificationResult` discriminated union | Preserve precedence; separate target classification from candidate eligibility |
| Prompt backend | `classifier.ts`: registry streaming, raw compatible endpoint, subprocess/auto paths; empty registry output may invoke `session-fallback.ts` minimal session | Common deadlines and cancellation need consolidation; do not assume all backends already share transport semantics |
| Direct backends | `typesafe-classifier.ts`, `classifier-pi-native.ts`, `classifier-backends.ts`: validated tier judgments, confidence/probabilities, bounded attempts, deadlines, metrics; Pi-native uses `classify()` and classifier catalog | Reuse contracts/decoders; prompt confidence remains absent rather than invented |
| Detection | `classifier-detection.ts`: explicit backend wins; Pi-managed TypeSafe → native when supported, env key → direct, otherwise prompt; sticky per extension load; notices and invalid auto-backend downgrade | Already exists; preserve v0.5.0 behavior, including its documented backend-selection compatibility change |
| Strategies | `routing.ts`: seven names; cost input+output, input-only, output-only, largest context, random, first; `fastest` currently means list order | Do not claim measured latency or total-turn cost optimization |
| Reliability | `reliability.ts` version-1 model-key records; default threshold 3/5 min, 60 min cooldown; trial failure multiplier; `ReliabilityStore` owns persistence and trial claims | Extend store and pure transitions, not scattered writers; existing claims protect one store instance only |
| Failure capture | `runtime-reliability.ts` observes selected physical response identity and settles once; ordinary clean settle does not clear history, trial success does | Keep Policy A and dispatch attribution; do not count tool failures as provider outages |
| State | `runtime-state.ts`: enabled/classifier toggles persisted; pin ephemeral; self-selection keyed per session; virtual dispatch ownership isolated | Affinity must be session/branch scoped; existing global config/debug/cache state needs explicit ownership review |
| Cache | `cache.ts`: normalized prompt text, exact/fuzzy Jaccard lookup, semantic key, TTL/LRU-like use ordering; selected tier cached, not responses; implicit Pi-native catalog model bypasses cache | Sensitive text remains sensitive; final route eligibility must always be recomputed |
| Physical routing | `index.ts` input handler classifies then `setModel` before generation; slash/extension input bypasses; pin/off bypasses; unresolved route warns and continues with active model | New hard constraints need an actual pre-generation block; a warning is insufficient |
| Virtual routing | `virtual-routing.ts`, `virtual-override.ts`, `index.ts`: explicit `bifrost/auto`; user routes classify, continuation/retry remain sticky, direct uses prior/default; thinking clamped; empty fresh route errors, subsequent empty route visibly degrades to last physical model | Do not mistake continuity behavior for soft affinity or unconditional fail-closed routing |
| Commands | `commands.ts` registry drives completion/menu/handlers; preview and `--json`, providers, probe/init, reload, pin, classifier status/test, cache controls | Extend registry; avoid second command list; JSON preview currently includes prompt text and formatted candidate strings |
| Init/probes | `probe.ts`, `commands.ts`: intentional provider requests, configurable timeout/concurrency, probe-based config generation and cost-based `guessTier` | Init is advisory configuration generation, not objective quality measurement; reconciliation needs explicit diffs |
| Tests/evaluation | Unit tests, integration scripts, PTY smoke and fake-provider reliability harness; Jev corpus and benchmark in `tests/corpus/jev`, `scripts/jev-benchmark.ts` | Extend existing harnesses; corpus does not establish generation quality or universal routing accuracy |
| Public seams | Exported helpers and pipeline dependencies exist; resolver takes Pi `ExtensionContext`; preview JSON is a command boundary, not stable library API | Extract a host-neutral snapshot seam incrementally; do not redesign already pure selection functions |
| Migration | Reliability has a file version; config has no general schema-version/migration framework; storage writes directly | Introduce additive version handling and atomic writes before shared persistent mechanisms |

### 2.2 Roadmap/ADR reconciliation

Read `PRODUCT.md`, `docs/product-philosophy.md`, `ROADMAP.md`, ADRs 0005–0012, 0014–0015 and 0019, alongside source. ADR 0005's store and ADR 0015's ephemeral pin are implemented. ADRs 0007–0010 remain proposed: preview JSON partly covers trace goals, but full phase traces, direct-rule arrays, a dedicated linter, and prompt confidence are not thereby shipped. ADR 0012 taxonomy and ADR 0019 session stickiness are proposals, not permissions. The roadmap contains stale or aspirational statements; source above is authoritative for presence.

This proposal refines those ideas but does not edit their status. Before implementing conflicting portions, reconcile and approve the relevant ADR: trace contract (0007), fallback (0008), validation (0009), classifier confidence (0010), reliability taxonomy (0012), affinity versus sticky mode (0019). In particular, ADR 0012's probe treatment differs from current probe outcomes; changing it is a separate opt-in policy decision. Do not silently import its thresholds.

### 2.3 Fork experiments: feature-by-feature findings

| Experiment and source | Upstream status | Useful lesson | Recommendation / cost |
|---|---|---|---|
| Subscription-first/balance, `routing.ts`, `quota.ts` | Missing; cost strategies already exist | Billing and allowance differ from catalog price; freshness matters | Adapt normalized signals and explicit preference, reject provider-name billing inference and mandatory subscription dominance |
| Quota windows/reserves, `quota.ts` | Missing | Weekly and rolling windows must be represented separately | Adapter contract, manual fixtures first; reject undocumented endpoint dependence in core, raw `auth.json` scraping and bucket-name guessing |
| Provider reliability, `reliability.ts` | Partially exists (model only upstream) | Shared limit can affect siblings | Typed scope keys, conservative scope evidence; fork stores provider and model keys together; no verified general multi-account dispatch |
| Strict categories, `config.ts`, `routing.ts` | Missing | No route is preferable to forbidden fallback | Generic explicit boundary; reject `DEFAULT_STRICT_CATEGORIES = coding/ultra` |
| Image steering, `index.ts`/`routing.ts` | Missing general requirement enforcement | Pi can substitute placeholders for unsupported images | Deferred by product decision; retain as research evidence only, no image support in this release |
| Session momentum, `session-context.ts`, pipeline | Missing soft affinity; virtual continuation already exists | Short follow-ups may belong to same task | Use route/session fact, not retained normalized prompt history, lexical topic detection or dominant tier votes |
| Complexity, `complexity.ts` | Missing | Structural counts could be advisory metadata | Defer automatic classification shortcut; word count named tokenCount and quick/frontier thresholds are not calibrated complexity |
| Classifier cascade, `classification-pipeline.ts`, `classifier.ts` | Partially exists / should be refactored | Transport failures need bounded fallback | Reuse upstream direct backends; reject expanding cascades and transport recursion without one end-to-end budget |
| Reconciliation, `discovery.ts`, init | Partially exists init; missing ownership reconciliation | Track generated membership separately from user edits | Adopt ownership provenance and proposal/apply diff; failure to discover is not evidence for deletion |
| Diagnostics, `diagnostics.ts`, commands | Partially exists upstream preview/status/validation | Stable codes and repair hints help | Extend `/bifrost validate` and introduce `/bifrost inspect`; never copy fork command terminology; sanitize raw stderr/errors |
| RPC, `rpc.ts`, `index.ts` | Missing stable API | Versioned correlation and resolve-only calls | Direct TypeScript API first; fork-specific classifyTask/thinking coupling unnecessary; event bridge later, no server |
| Thinking, `thinking.ts` | Partially exists clamping upstream | Effective level should be visible | Keep host clamp; defer scoring. Fork source itself labels Jev effort cutoffs unverified |
| Replay, `runtime-reliability.ts`, `index.ts` agent_settled | Deliberately absent | Output/tool-result observation is incomplete proof | Reject: autoRetry defaults true, replaySafe uses absent output/results, then sendUserMessage; can duplicate external effects |
| Semantic tiers/system prompt, `config.ts`, `routing.ts`, `before_agent_start` | Arbitrary upstream tiers and configurable default criteria exist | Presets can offer opinions | Reject hardcoded ultra/writing/coding meanings and frontier planning-only prompt injection in core |
| Remote input/scoped discovery, `remote-signal.ts`, `discovery.ts`, history | Upstream extension input deliberately bypasses | Callers need an explicit integration contract | Resolve API supports deliberate caller requests; do not intercept every extension prompt or silently redirect manual models |
| File locking, `storage.ts`, `reliability-store.ts` | Missing cross-process writer protection | Multiple Pi processes can lose circuit updates | Adapt transaction principle, independently implement/test lock ownership and crash behavior; lock plus atomic rename is required |

History inspected includes fork `69bd300` (subscription-first enforcement), `dc558f2` (session exclusions), `8919a8e` (quota/scoping fixes), `d2b9940` (ultra/config preservation), `9139163` (delegate Codex auth to Pi), `0dd4d4c` (vision), and upstream v0.4/v0.5 release history. These illustrate evolving experiments, not proof they work in every environment. In fork routing, `ensureSubscriptionSurvives` can restore quota-filtered candidates; never adopt a design where ranking can reverse a hard constraint. Defaults freshness 15 minutes versus refresh 30 minutes also create a neutral interval; freshness and polling contracts must be explicit.

Additional operational lessons: fork storage changes default state locality from project to global agent directory; do not import that scope change silently. Its lock retries indefinitely and may reclaim solely by age, while atomic-write fallback can unlink the destination before retrying rename. Adapt the need for writer coordination, not those failure semantics. Its image repair occurs after selection and may cross tiers; eligibility must instead precede strategy inside the declared boundary.

## 3. Users and acceptance journeys

| Journey | Required result |
|---|---|
| Developer investigating unexpected selection | Preview explains classification source, requested/selected tier, resolved candidates, exclusions, strategy and fallback; inspect shows freshness and config provenance without prompt content |
| Developer with specialized tier | Explicitly empty fallback list blocks before generation when pool is unavailable; last dispatched model cannot escape boundary |
| Developer using a custom restricted tier | No eligible candidate means an actionable no-route result; current/last model cannot bypass the declared boundary |
| Developer hitting account quota | Known account-bound candidates excluded, siblings on another account remain eligible; no prompt is replayed and manual pin is not cleared |
| Subscription user | Can inspect allowance windows, reserve and staleness, then opt into an economic strategy; unavailable data is not treated as free or exhausted |
| Long-session user | Can compare ordinary routing against within-tier continuity, see why it stays/switches, pin manually, reset affinity; no heuristic locks them to an inappropriate tier |
| Extension author | Resolve returns decision/no-route/cancelled with trace and revisions; active Pi selection, pin, history and affinity unchanged |

## 4. Requirement catalogue and priorities

**P0** is a prerequisite/foundation. **P1** is the first capability release. **P2** is gated optional expansion. Status labels refer to the baseline, not this proposal.

| ID | Priority / baseline | Requirement and observable acceptance |
|---|---|---|
| R01 | P0 / Partially exists | One structured decision contract drives runtime, preview and API; each rejection has a stable code and evidence source; semantic parity fixtures cover baseline paths |
| R02 | P0 / Already exists | Physical selection remains default; Auto remains explicit; Pi footer intact and Bifrost uses `setStatus("bifrost-state", ...)`; manual model/pin/off semantics retained |
| R03 | P0 / Already exists | Never initiate replay or unpin on failure; settled failure updates reliability exactly once; continuation and host retry stay on their physical route |
| R04 | P1 / Partially exists | Exclude virtual/classifier-only entries from generation pools, probes and init with host-type proof; retain a general capability observation seam, with modality enforcement deferred |
| R05 | P1 / Missing | Configured fallback boundaries terminate in no-route; capability requirements persist across fallbacks; no stale-model escape in physical or Auto paths |
| R06 | P1 / Should be refactored | Strict-mode no-route and activation failure stop before inference; no selection side effects in resolve; cancellation cannot dispatch late results |
| R07 | P1 / Partially exists | Offline validation and inspect expose missing IDs, fallback cycles, unsupported requirements, auth observability, signal age, circuits; no probes or billing fetches by default |
| R08 | P1 / Partially exists | Persist model circuits; additive typed scopes and ownership-safe trial leases; only evidence-backed account/provider failures affect siblings |
| R09 | P0 / Should be refactored | Atomic config/state writes, valid-before-publish reload, exact file backup for explicit config edits; previous valid config remains active after invalid reload |
| R10 | P2 / Missing | Economic signals have units, multiple windows, opaque account scope, observation/expiry and provenance; advisory default; reserve filters only by explicit configuration |
| R11 | P2 / Missing | Soft affinity retains only an eligible model inside target boundary; explicit model/tier outranks affinity; continuations never invoke a new ranking; lifecycle is branch-local |
| R12 | P1 / Should be refactored | Shared classification deadline/abort/validation/fallback accounting; preserve selected backend and ordered precedence; no backend gets an independent unlimited retry budget |
| R13 | P2 / Missing | Stable versioned resolve-only TypeScript entry point, no Pi context in core contract; callers own their affinity contexts and transport grants |
| R14 | P1 / Partially exists | Local bounded observability excludes prompt/image/tool content, secrets and raw provider errors; detailed traces expose evidence and reason, not private request bodies |
| R15 | P2 / Missing | Reconciliation proposes changes only to owned membership; no deletion after partial discovery; no automatic user config rewrite |
| R16 | P0 / Partially exists | Offline replayable route scenarios and deterministic release gates; distinguish classification accuracy, route validity, generation quality, estimates and observed cost |
| R17 | P0 / Already exists | Custom tiers remain arbitrary strings, default pools contain no maintainer model IDs; generic strategies contain no provider-specific branches |

## 5. Routing semantics

### 5.1 Fixed pipeline, configurable policy

Use a fixed semantic order, not user-reorderable phases and not a universal weighted score:

```text
host request facts + immutable snapshots
  → explicit target / existing classification precedence
  → configured pool and fallback boundary
  → physical/generative candidate check + requirements
  → availability / reliability / explicit economic admission
  → configured strategy + optional bounded affinity
  → decision or no-route
  → adapter revalidation, trial reservation, activation/dispatch
```

Requirements may be extracted before classification without deciding the tier. Cheap deterministic validation runs before network classification where it can prove the request invalid, but requirements do not silently reroute task meaning. Classifier confidence gates acceptance of a tier; it is not model quality, a permission to cross tiers, or a reason to relax requirements. Policy lives in resolved user configuration and registered strategy choices. Unknown facts are visible and interpreted by explicit unknown-handling settings.

Hard filters can never be reversed by a strategy, affinity or fallback. Soft signals can be ignored by existing strategies. No-route is a successful policy outcome when a strict boundary, required capability, explicit reserve, unknown-data policy, or supported dispatch identity prevents a safe selection.

### 5.2 Explicit control and target precedence

Preserve input eligibility and classification order first. Manual physical selection/pin/off bypass automatic routing; never secretly unpin. For a routed user turn, explicit tier prefix wins, then existing direct-binding precheck/cache/classifier/regex/default. Existing first-rule matching nuance is covered by fixtures; changing regex priority is not included.

Within an explicit target boundary, enforce capabilities/reliability/economic admission before ranking. An explicit exact model request does not authorize choosing a different model; return no-route if unavailable. A user may choose a physical model through Pi to bypass Bifrost, but Bifrost cannot claim strict governance of such bypasses. This is configuration control, not a tenant security boundary.

### 5.3 Fallback and compatibility

Retain current `models` pools. Add optional `tierPolicies[tier].fallbackTiers`:

- Absent: legacy requested tier → configured default once, then existing visible keep-current/keep-last behavior where applicable.
- `[]`: only this tier, no cross-tier or retained-model escape.
- Explicit ordered list: try requested tier then only those listed tiers, each once; terminal no-route. Lists are direct ordered boundaries, not recursively expanded graphs.

Reject unknown/self/duplicate tier references; report cycles in declared relationships as configuration errors to avoid misleading reciprocal policies. Preserve the original request's requirements in every pool; a fallback tier can add requirements, never remove them. Direct rule arrays remain deferred until ADR 0008 is approved; an eventual chain has the same explicit terminal behavior.

Manual tier prefix and classifier tier receive identical fallback boundaries. Reliability failures do not loosen the boundary. For any enforced requirement or explicit hard economic constraint, even legacy retention must revalidate the retained model; it cannot restore an excluded candidate. The old permissive retention behavior remains only when no new hard control applies.

### 5.4 Continuations, host retries, direct calls

Tool continuations remain on the physical model/level that owns the tool transcript. Host-originated retries remain on failed/previous physical identity; Bifrost neither initiates nor migrates a failed turn. These are protocol continuity, not soft affinity. Newly opened reliability circuits govern the next routed user turn; they do not force a mid-tool switch. Enforced incompatibility or revoked credentials may terminate a continuation, but never select a replacement mid-turn. A provider outage can therefore end a turn rather than transparently recover it.

Direct requests such as compaction stay on prior/default physical identity without task reclassification or affinity changes. Enforced requirements apply to the actual direct payload, not blindly to the entire user history. Explain its intent separately from a routed user turn. Queued steering/follow-ups carry request-specific overrides; no global forced-tier slot.

## 6. Capability requirements

R04 ships exclusion of virtual/classifier-only entries. Image-input support is explicitly deferred; there is no image detection, steering or enforcement milestone. Extensible typed atoms cover input modalities, tools, structured output, reasoning, streaming, system messages and token limits; ship enforcement for an atom only when the host can extract and dispatch it correctly. Audio/JSON/provider feature names are reserved extensions, not claims of current Pi support. MCP is a host tool layer; an “MCP capable model” label is insufficient—express the actual tool/protocol requirement.

Sources are Pi registry metadata, explicit per-model user assertions, and registered adapters. Each observation is supported/unsupported/unknown with source, revision and freshness. User assertions have explicit precedence but cannot make a classifier or virtual model generative. Conflicting facts appear in diagnostics. Registry refresh replaces a snapshot; it does not mutate an in-flight decision.

The general requirement seam is advisory/future-facing. `requirements.mode = enforce` is reserved for a separately approved capability implementation and is rejected as unsupported in this release. Unsupported mandatory requirements reject a candidate. Unknown mandatory capabilities default to rejection in enforcement; `unknownCapabilities = allow` is an explicit permissive choice and must appear in the trace. Tier strictness and capability strictness are independent: the former bounds membership, the latter bounds technical suitability.

Do not introduce modality extraction or image requirements in this release. Attachment content must still remain private and must not be sent to economic adapters. Context estimation is advisory unless host supplies a reliable bound or caller explicitly supplies a hard lower bound. Context window ≥ required input plus output reserve is necessary, but not a guarantee that rendered provider messages fit. Pi compaction behavior is host-owned; do not claim Bifrost predicts it precisely.

General capability enforcement remains a future gated contract, not a shipped promise. A future enforced requirement must produce no-route when no compatible candidate exists and must never escape a strict tier. Diagnostics name the missing capability and configured fallback options.

## 7. Reliability and recovery

R08 separates failure category from scope and action. Normalized categories: rate limit, allowance exhausted, authentication, billing denied, overload, transport, model unavailable, invalid request, capability mismatch, context limit, tool protocol, activation failed and unknown. Provider adapters interpret structured errors/headers; generic text parsing can produce low-confidence diagnostics but cannot infer a global outage or another account's failure.

Model scope is available today. Provider scope requires explicit global-provider evidence; a 503 alone is not proof. Account scope requires an opaque host credential binding; a 429 may be per-model, per-account or shared. If scope cannot be proven, use the dispatch's model scope. Credential version is an epoch on that binding, not token content or a token-derived log identifier. Do not implement account dispatch until Pi can select and attribute that account.

Ship categories as observations first. Existing threshold/window/cooldown policy is stable by default. Opt-in scoped policy may use authoritative reset or Retry-After, then capped exponential cooldown. Invalid request/context/tool errors advise repair without penalizing unrelated candidates. Authentication/billing blocks require observed repair or explicit reset; probes cannot magically repair credentials. Cancellation is neither failure nor success.

State survives restart. A half-open trial uses a lease and owner token, with one admission across all applicable scopes. Shared-scope success closes only its owned, unexpired lease if the scope generation still matches admission; any newer failure invalidates that closure. Unrelated model success must not clear account limits. Stale lease recovery must be bounded after process death. Trial failure backs off; repeated shared failures must not multiply count once for every sibling. Manual probes are intentional paid requests and never replay user content. Preserve existing probe effects until an approved policy explicitly changes them.

## 8. Economics and budgets

R10 normalizes billing mode, units and allowance windows. A provider can serve subscription and metered credentials simultaneously; provider name and zero catalog price do not determine billing mode. Windows include absolute reset time and independent remaining/limit values. Currency and credits are different units; never add incompatible balances or rank incomparable prices as zero.

Economic metadata is snapshot-only on the route hot path. Refresh uses opt-in host-authenticated adapters with deadlines; no undocumented consumer endpoints bundled as mandatory infrastructure. Static/manual signals enable initial deterministic validation. A user-facing live quota-routing milestone requires at least one verified host/provider adapter; until it passes endpoint, auth, scope and freshness gates, label the implementation quota-snapshot-aware rather than automatic quota tracking. Never substitute an undocumented endpoint to satisfy this gate. Missing/stale signals are neutral for preference; for an explicit hard admission rule, user chooses block or ignore unknown, default block. Signals are validated for finite values, ratios in range, plausible timestamps and compatible units.

Catalog cost strategies remain unchanged. Optional strategies can prefer a configured billing class, then existing list/cost order; window balancing requires fresh comparable allowances and evaluation before release. Reserve rules may reject when any applicable fresh window reaches its configured floor. Reserve applies to all tiers equally unless an explicit tier override is configured; no quick-tier exception in core. Window resets expire prior observations rather than implying replenishment; each window remains independently applicable.

Support admission controls, not guaranteed monetary spending caps. A real cap requires an atomic reservation, known maximum cost, complete usage settlement, all callers participating, and account attribution. Output length, provider billing adjustments, external consumers and race conditions make a quota snapshot insufficient. Defer daily/monthly hard spend guarantees and automatic downgrades to an independently approved ledger design. The UI must say “admission based on observed allowance,” not “spend guaranteed.”

Never store credentials in signals. Account identifiers are opaque local aliases; traces redact them by default. Billing figures and adapter permissions are private local configuration/state, not telemetry for upload.

## 9. Affinity and prompt caching

R11 is a first-class route/session signal, separate from pinning and tier classification. Do not implement semantic topic tracking, dominant-tier voting, or cross-tier stickiness in this milestone. ADR 0019's stronger session-base mode remains a separate candidate design requiring approval.

Initially expose whether current physical identity remains eligible, whether staying would preserve model/provider locality, last successful dispatch time, and why a switch is mandatory. An experimental opt-in `affinity.mode = retain-within-tier` may retain the current eligible model in the selected tier for automatically classified turns. Explicit tier requests use the configured strategy without affinity; exact model overrides remain exact. Once the target changes to a tier that excludes the current model, affinity cannot pull it back. Hard constraints always win. Users choose this tradeoff knowingly: fewer switches may sacrifice their ordinary cost/list optimum.

Model locality is stronger evidence than provider locality. Provider-level affinity is advisory until adapters can identify transferable cache scope. Confidence can appear in recommendations but does not automatically lower a switch threshold; probability scales differ between backends and fuzzy cache hits may have no retained confidence. No universal quality-minus-cache-cost score is justified.

Continuations/retries are already sticky for protocol reasons and do not run affinity. Record affinity only after successful physical dispatch, not after preview or resolution and not merely after setModel. A failed turn cannot promote a new affinity anchor. New sessions and branch changes reset by default; resumed history can show last physical identity as evidence without restoring a binding promise. Optional restoration would need a separate approval and versioned branch-safe state. Idle age, compaction and tool/system prefix changes reduce confidence in locality; they do not reveal provider cache presence.

### 9.1 What cache locality can and cannot establish

Provider prompt caching reuses input computation; Bifrost's classification cache reuses a tier judgment. These stores are unrelated. Prompt caching neither replays generated actions nor transfers hidden reasoning between providers.

| Architecture | Verified conceptual behavior | Routing implication |
|---|---|---|
| OpenAI | Rendered prefix/settings and eligible cache boundaries govern reuse; model-specific behavior exists | Same model and stable prefix may help; model name alone cannot establish a hit or dollars saved |
| Anthropic | Tools/system/messages form a prefix through cache breakpoints; prefix changes affect reuse | Changing tool schemas or system instructions can defeat locality even if model stays |
| Gemini | Current Interactions API documents implicit caching; explicit cache objects use generateContent | Cache object/API details belong to host/provider adapter; do not assume one generic handle transfers across models |

Sources checked 7 October 2026: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching). These support the conceptual distinctions, not a claim that Pi exposes all cache controls.

Bifrost knows selected/dispatched identity, timing and any host-reported cache usage. It does not know rendered token prefixes, eviction, cache retention, backend placement or exact next-turn savings absent explicit telemetry. Measured cached tokens describe a past response, not authoritative future eligibility. Task boundary change, enforced capability, outage, explicit user choice or reserve pressure outweigh locality. Ordinary strategy gives aggressive per-turn selection; retain-within-tier offers a bounded cache-preserving alternative. Avoid three marketing modes with undocumented numeric thresholds.

## 10. Diagnostics, configuration and privacy

R07 extends existing surfaces: `/bifrost validate` for offline config structure/relationships and `/bifrost inspect [--json]` for current registry/auth-observability/circuit/capability/signal snapshots. `/bifrost preview` retains its current classifier disclosure; add `--offline` to forbid network classification and `--trace` for typed evidence. Inspect is offline; refresh/probe remains explicit and may consume quota. Report unknown auth as unknown, never “invalid” based solely on missing visibility.

Preview resolves without selection, reservation, affinity updates or circuit mutation. It may perform explicitly permitted classification; distinguish its network call from generation. Frozen-snapshot preview and dispatch can differ after freshness/config/reliability changes; show revision mismatch rather than promise a route forever. Existing JSON format remains available for compatibility; a new versioned trace format excludes prompt by default. Warn clearly that legacy JSON includes supplied prompt text.

R09 introduces additive schema versioning. Unversioned configs normalize as legacy version 1; new fields require version 2 support. No auto-write or mandatory reformat. Explicit migration previews diff, targets one source file, preserves unrelated fields/order where feasible, validates merged result and creates exact backup before atomic replacement. Unknown future versions stop load; invalid reload keeps previous valid snapshot. Layer provenance must distinguish inherited policy from edited policy. Reconciliation tracks owned membership in a sidecar, not ownership inferred from model existence; missing/partial discovery never deletes manual entries.

R14 observability is local opt-in structured events and bounded counters. Record request IDs, intent, config/registry/signal revisions, source, times, counts, reason codes, switch/affinity outcomes, circuit transitions and no-route counts. Never persist prompt/image/audio/tool bodies, system messages, raw errors, auth headers, credentials or billing account IDs in the new trace. Provider/model names may expose private deployment names; omit or map them when exporting. No prompt hashes by default: low-entropy secrets remain guessable. User-requested benchmark fixtures must be synthetic or explicitly curated.

## 11. Security and operational constraints

| Threat | Required mitigation / boundary |
|---|---|
| Prompt secrets leak into cache/debug/preview | Keep classification-cache sensitivity documented; opt-out honored; new events content-free, legacy preview identified; audit prompt backend raw output logging before consolidating traces |
| Malicious metadata or plugin signal | Plain-data bounded decode; finite numbers; stable registered capability keys; no executable expressions/import paths in JSON; strategies cannot add excluded candidates |
| Classifier injection, delay or paid-call loop | Whitelist configured tier output, one total deadline, bounded attempts, cancellation; classifier has no main-session tools, no recursive Bifrost extension invocation |
| Config regex denial of service | Length/count bounds and warning for risky patterns; do not silently truncate matching semantics; strict validation mode may reject unsafe patterns; JS regex cannot be cancelled mid-match |
| Shared state tampering/path attacks | Explicit trusted path configuration; reject symlink targets for managed writes, exclusive temp files, restrictive permissions, atomic replace, bounded input files, schema validation |
| Malicious caller requests expensive classification | Caller grants explicitly authorize network classifier; local-only default for exported service; input/concurrency bounds; no exposed unauthenticated RPC listener |
| Dynamic adapters/supply chain | Code registration only from installed trusted extension code; explicit allowlist and version; no arbitrary package download from config; MIT fork is research, no bulk copy |
| Billing privacy/account confusion | Opaque binding plus epoch; avoid account data in logs; no account switching until host dispatch contract exists |
| Failure/restart/state corruption | Atomic transaction, backup/quarantine visibility, fail closed for activated hard controls when authoritative state unreadable; permissive legacy path shows degraded reliability |

In-process extensions share process privileges; the API is not a sandbox against malicious installed code. “Enterprise-quality” here means explicit contracts and controls, not claims of organization-wide policy enforcement.

## 12. Performance, determinism and success criteria

Measure baseline before setting release claims. Proposed engineering targets, not measured promises: local resolution at 100 candidates/20 tiers p95 ≤10 ms and ≤20% overhead versus baseline (use the less restrictive bound for noisy hosts); trace building ≤1 ms p95 at 100 candidates; no new network wait for budgets/capabilities on hot path. Benchmarks record hardware, Node/Pi versions, warm/cold state and allocations; failed targets require profiling or revised evidence-backed targets before promotion.

Classifier orchestration preserves legacy budgets initially, adds an opt-in total deadline, then evaluates a recommended 2 s deadline separately. Existing direct backends permit up to 60 s; do not secretly replace user settings. One cancellation propagates to every attempt; shutdown/timeout releases owned leases. Metadata refresh is single-flight and deadline-bound outside deterministic resolution; no indefinite “stale while revalidate” for hard admission facts.

Deterministic strategies preserve list tie order. Snapshots freeze now/config/registry/health/signal revisions; random injects a seed for replay while legacy live random behavior stays unchanged. Explanations identify changing snapshots and random selection. Concurrency is isolated by request/session/branch; state writers serialize with owner-token leases, not global last-prompt state.

Release acceptance: all R01–R09/R12/R14/R16/R17 safety invariants tested as applicable; every selected candidate eligible; zero strict-boundary escapes in generated scenarios; zero Bifrost replay calls; no sensitive trace fixture leaks; no Pi footer takeover. Benchmark cost/switch improvements are reported only against a named baseline, corpus and measured or explicitly estimated usage. Fewer switches alone does not establish higher answer quality.

## 13. Compatibility and delivery policy

| Change | Classification | Default / rollback |
|---|---|---|
| Shared internal decision and richer text explanations | Backward compatible | Preserve route order and existing strings needed by fixtures; legacy JSON remains available |
| Versioned content-free trace / offline preview / inspect | Backward compatible, additive | Explicit invocation; old preview unchanged |
| Fallback boundaries | Opt-in | Absent settings retain legacy behavior; disabling restores legacy behavior, with warning about lost constraints |
| Excluding classifier-only candidates | Breaking safety correction if previously configured | Advisory inventory first; enforce only with release note/approved gate after host proof; migration names invalid pool entries |
| Scoped reliability/category-aware cooldown | Opt-in; state migration required | Legacy model policy default; separate versioned state sidecar supports rollback without v1 overwriting v2 |
| Classifier orchestration | Backward compatible only under preserved budgets/precedence | Semantic parity gate; new total deadline opt-in |
| Economic reserve/preference and affinity | Experimental opt-in | Signals/advice first; no default reordering; disable independently |
| Schema v2/explicit config migration | Requires migration only when using v2 fields | Unversioned v1 stays supported; backup restores source and required binary version |
| Public routing API | Additive experimental then stable | Versioned independent contract; no model/session mutation |
| Atomic writes/reconciliation | Compatible safety improvement / opt-in writes | Preserve handwritten config; apply only explicit validated proposal |
| Replay, orchestration, dynamic thinking/complexity escalation | Rejected or deferred | No feature flag that quietly enables them |

Dependencies and PR-sized gates are specified in IMPLEMENTATION.md. Do not release a giant architecture branch. Each PR ships with its own visible user benefit, deterministic proof and rollback. Existing ADRs must be reconciled before their proposed behavior ships.

### Initial feature lifecycle

| Capability | Initial release class | Promotion condition |
|---|---|---|
| Legacy routing/physical selection/Auto/circuits | Stable existing behavior | Regression parity maintained |
| Decision summary, validate/inspect, content-free trace | Stable additive after gates | Reason coverage, privacy and command tests |
| New snapshot/admission ports | Internal-only | Public consumer contract and packaging tests |
| Explicit tier boundaries | Opt-in, stable after host E2E | No generation after no-route; no retained-model escape |
| Scoped/category-aware reliability | Experimental opt-in | Attributed scope and cross-process recovery evidence |
| Economic observations/registered adapters | Experimental opt-in | Documented source, units, freshness and permissions |
| Economic admission/preference; soft affinity | Experimental opt-in | Safety properties plus held-out evaluation and user evidence |
| Direct routing API | Experimental versioned API | Independent consumer smoke, no-mutation contract and compatibility policy |
| Complexity/dynamic thinking/reset-window balancing | Research only | Specific user need and calibrated evidence before separate ADR |

Feature switches are orthogonal named config fields, not one `smartRouting` flag. Disabling an observation adapter must never silently make an enabled hard policy permissive; its unknown-data rule still applies.

## 14. Open decisions and launch blockers

1. **Host classifier inventory:** prove Pi v1.0.1 `getAvailable()` behavior for classifier-typed entries with fake registry and one controlled host test. Source filtering today excludes virtual entries, not all classifier types.
2. **Future capability enforcement:** image input is out of scope. Context/tool/other payload enforcement requires a proven final dispatch veto in both modes; input observations alone are insufficient. Do not infer veto capability from hooks that catch exceptions and continue.
3. **Account identity:** Pi provider auth APIs are not evidence of selectable multi-account dispatch. Account binding support remains adapter-gated; provider scope cannot impersonate it.
4. **Strict input preservation:** Pi `handled` stops input before agent processing. TUI editor restoration and non-TUI error visibility need targeted E2E evidence before enabling strict routing; never requeue via sendUserMessage.
5. **ADR 0019:** within-tier soft affinity does not implement session-base routing. Decide separately if reported user need requires a stable base across tier changes.
6. **Public export packaging:** current publication includes root TS files; Node/Pi loader and declaration delivery must be verified before calling the API stable.

These block only the dependent milestone, not explanation/validation work. No unanswered issue permits a permissive escape from a declared hard boundary.

## 15. Source index

Pinned source links provide reproducible entry points; file/symbol references throughout are to these revisions.

- [Upstream tree](https://github.com/iamaamir/pi-bifrost/tree/236622dbc40789e8ca82226337a26cdd1eb26d2f): `index.ts`, `routing.ts`, `classification-pipeline.ts`, `config.ts`, `schema.json`, classifier modules, `virtual-routing.ts`, `commands.ts`, `reliability*.ts`, `storage.ts`, tests and changelog.
- [Fork tree](https://github.com/the-matt-moo/pi-bifrost/tree/9139163ecb0474a3223f0e9e4c7a92259f2cf430): `quota.ts`, `routing.ts`, `session-context.ts`, `complexity.ts`, `thinking.ts`, `discovery.ts`, `diagnostics.ts`, `rpc.ts`, runtime reliability and `index.ts`.
- [Pi v1.0.1 tree](https://github.com/earendil-works/pi/tree/a7229ddc21810d6245105978033b7df645ecc2f7): `packages/coding-agent/docs/virtual-models.md`, `src/core/virtual-models.ts`, `src/core/extensions/types.ts` (`InputEventResult`), `src/core/agent-session.ts` (`_runInputHandlers`). Pi supports pre-generation `handled` input interception; thrown virtual route ends in an error response; continuation/retry/direct intents and physical dispatch identity are explicit.
