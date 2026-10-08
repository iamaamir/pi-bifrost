# Implementation design: inspectable route resolution

**Status:** release design authorized for implementation on 7 October 2026. Accepted behavior and remaining gates are tracked in [RELEASE-PLAN.md](RELEASE-PLAN.md); this document specifies scope, not completion.
**Baseline:** v0.5.0 upstream `236622dbc40789e8ca82226337a26cdd1eb26d2f`, inspected 7 October 2026.
**Product/acceptance contract:** [PRD.md](PRD.md), requirements R01–R17. All new names and shapes below are proposed APIs/configuration, not current capabilities.

## 1. Architectural decisions

1. Keep one npm package and root-level module style. Extract only the host-facing dependency in resolution; do not immediately introduce a monorepo, event bus, dependency container or proxy.
2. Reuse `ClassificationResult`, `ClassificationJudgment`, pure strategy functions, circuit transitions and `ReliabilityStore`. A wrapper unifies route planning; it does not replace the working classification pipeline wholesale.
3. Fix semantic phase order. Hard eligibility precedes ranking and cannot be undone. Strategies rank only the supplied eligible identities; results are validated again at the boundary.
4. Separate **resolve**, **admit**, **dispatch**, and **settle**. Resolve is read-only over route/session state; classification may make granted network calls. Admit atomically owns trial leases. Only Pi adapter mutates the user's active model. Settle attributes outcome once to actual dispatched identity.
5. New signals start advisory. State/config version changes and altered behavior require the relevant ADR approval; this document does not approve proposed ADRs.
6. Prefer a narrow direct TypeScript API after internal parity. No extension service registry, RPC server, tool or ACP transport in the first API release.

### Module changes

| Module | Responsibility / retained surface |
|---|---|
| `routing.ts` | Keep key/pattern expansion, stable strategies and legacy resolver wrappers; add registry-view dependency rather than core Pi context |
| proposed `route-decision.ts` | Plain data result, reason codes, revisions and trace serialization; no host imports |
| proposed `route-resolver.ts` | Compose target, boundary, hard filters and strategy; injected immutable snapshots, clock, RNG and classification port |
| proposed `requirements.ts` | Typed requirement merge and tri-state capability checks, pure; modality extraction stays in adapter |
| proposed `capabilities.ts` | Normalize registry metadata/user assertions/registered observations with provenance; no network refresh inside filter |
| `classification-pipeline.ts` | Preserve stage order; add optional trace sink and orchestration budget at invocation boundary |
| proposed `classification-runner.ts` | Total deadline/attempt ledger, normalized errors, cancellation and validation shared by backends; adapters own invocation/auth/decoding |
| `classifier.ts`, native/TypeSafe modules | Retain transport-specific decoding/auth; progressively delegate scheduling to runner without double retry loops |
| `reliability.ts`, store | Pure category/scope/lease transitions plus transaction owner; keep v1 compatibility reader/writer until opted into v2 |
| proposed `failure-normalization.ts` | Generic conservative normalized categories; registered provider adapters supply stronger scope evidence |
| proposed `economic-signals.ts` | Validate immutable allowance/cost observations and policy filters; refresh owned by registered adapter/runtime coordinator |
| proposed `affinity.ts` | Pure eligible-current check and optional within-tier retain policy; no prompt history or topic classifier |
| `index.ts`, virtual modules | Host facts, input/route intents, selection/dispatch lifecycle, override handoff, lease ownership, status |
| `commands.ts` + proposed `diagnostics.ts` | Registry-driven validate/inspect/preview, stable codes and repair hints; no policy duplication in rendering |
| `config.ts`, `schema.json` | Version normalization, layer provenance, new fields, validation, last-good reload |
| `storage.ts` | Bounded reads, atomic replace, restrictive managed-state writes and transaction locks; no domain decisions |
| proposed `reconciliation.ts` | Pure owned-membership diff; explicit command applies to one config source |
| proposed `router-api.ts` | Stable facade and registration types only; no Pi, filesystem globals or active-session selection |

These are seams, not a mandate to create every file in one PR. Split files when the feature lands; do not add empty frameworks.

## 2. Baseline behavior that must be preserved

- Pattern strings containing `/` use exact provider plus remaining ID; substring patterns iterate available models; first resolved occurrence wins deduplication. Freeze order but do not alphabetically resort existing pools.
- `cheapest` uses catalog input+output rates, ignoring cache rates and predicted token counts. `fastest` equals first/list order. Cost/context ties keep first. Live random remains unseeded unless explicitly requested.
- Pipeline precheck uses the **first matching rule** and only short-circuits if it is a direct reference; do not scan later direct rules ahead of an earlier matching tier rule.
- Direct backend → explicit prompt fallback → regex/default order comes from effective stage planning in `index.ts`. Auto-detection stays sticky per extension load; reload must not silently redetect.
- TypeSafe/native retain strict decoders and confidence gate; prompt backend returns a tier without calibrated confidence. Implicit native catalog model disables fuzzy cache as it does today.
- Pin is session-local; runtime enabled/classifier toggles survive restart. Manual physical selection pins; passive restore and Bifrost self-selection do not. Keep per-session self-select tracking and dispatch ownership.
- Fresh Auto no-route throws; established Auto no-route keeps last physical with visible warning, and physical no-route continues with selected model in legacy mode. New hard policies explicitly override this permissive behavior only when enabled.
- Host retries/continuations are sticky. Bifrost does not call `sendUserMessage` to replay, does not unpin on rate limit, and does not interpret lack of output as proof of safety.
- Probe outcomes currently enter reliability; preserve this default until a separately approved observation-only policy. Runtime ordinary success does not clear failure history; half-open success does.

Add frozen legacy fixtures before extraction. A source ADR or roadmap assertion cannot override these observed behaviors without a documented compatibility decision.

## 3. Proposed contracts

### 3.1 Identities and immutable facts

```ts
type ModelKey = string; // canonical provider/id; validated at adapter boundary
type Revision = string; // local monotonically changing identifier, not prompt hash
type RouteIntent = "user" | "continuation" | "host-retry" | "direct";
type DispatchBinding = {
  model: ModelKey;
  provider: string;
  accountRef?: string; // opaque host-supplied alias, never a credential
  credentialEpoch?: string;
};
type Fact<T> = {
  value: T;
  source: string;
  observedAt: number; // UTC epoch ms
  expiresAt?: number; // omitted only for immutable/static facts
  revision: Revision;
};
type Support = "supported" | "unsupported" | "unknown";
type CapabilityKey =
  | "tools" | "structured-output" | "reasoning"
  | "streaming" | "system-message";
type RequirementSet = {
  required: readonly CapabilityKey[];
  minInputTokens?: number;
  outputReserveTokens?: number;
  provenance: readonly { key: string; source: string }[];
};
type Candidate = {
  binding: DispatchBinding;
  kind: "generative" | "classifier" | "virtual" | "unknown";
  registryOrder: number;
  capabilities: Readonly<Partial<Record<CapabilityKey, Fact<Support>>>>;
  contextWindow?: Fact<number>;
  maxOutputTokens?: Fact<number>;
  rates?: Fact<{ input: number; output: number; unit: "USD/1M-tokens" }>;
};
```

The core's normalized rates support legacy metadata, not a new pricing promise. Other currencies/credits live in economic observations and cannot feed legacy cheapest without explicit unit conversion. Unknown kind must be visible; known classifier/virtual is never generative. Registry adapter must use Pi's actual typed catalog predicates where available; do not infer kind from provider name. Bound all identifiers and validate finite positive token limits before creating these records.

Image-input support does not ship in this evolution. Capability atoms above are a future contract; production initially exposes observations/model-kind checks only. Unsupported requirement enforcement keys in config are load errors, not ignored. A future registered key requires a validator, a requirement extractor and dispatch support. This is a typed registry, not arbitrary JSON rule evaluation.

### 3.2 Request and result

```ts
type RouteRequest = {
  version: 1;
  requestId: string;
  context: { sessionId: string; branchId: string };
  intent: RouteIntent;
  target?: { kind: "tier"; tier: string }
         | { kind: "model"; model: ModelKey };
  text?: string; // transient classification input; never copied into decision
  requirements: RequirementSet;
  current?: DispatchBinding;
  continuation?: { binding: DispatchBinding; thinkingLevel?: string };
  classifierAccess: "local-only" | "configured-network";
  trace: "summary" | "full";
  seed?: number;
  signal?: AbortSignal;
};
type RouteReason = {
  code: string; // versioned registry; unknown codes can be displayed generically
  stage: "target" | "requirements" | "availability" | "economics"
       | "strategy" | "affinity" | "dispatch";
  candidate?: ModelKey;
  evidence?: { source: string; revision: Revision; ageMs?: number };
  details?: Readonly<Record<string, string | number | boolean>>;
};
type DecisionBase = {
  version: 1;
  requestId: string;
  intent: RouteIntent;
  revisions: { config: Revision; registry: Revision; reliability: Revision;
    capabilities: Revision; economics: Revision; affinity: Revision };
  observedAt: number;
  requestedTarget?: { kind: "tier"; tier: string } | { kind: "model"; model: ModelKey };
  classification?: { tier: string; source: string; backend?: string;
    confidence?: number; cache?: "exact" | "fuzzy" };
  requirements: RequirementSet;
  attemptedTiers: readonly string[];
  eligible: readonly ModelKey[];
  reasons: readonly RouteReason[];
  trace?: readonly { stage: string; durationMs: number; outcome: string }[];
};
type RouteDecision =
  | (DecisionBase & { outcome: "selected"; binding: DispatchBinding;
      selectedTier?: string; strategy: string; selection: "strategy" | "affinity" | "continuity" })
  | (DecisionBase & { outcome: "no-route"; code: string })
  | (DecisionBase & { outcome: "cancelled"; code: "aborted" | "deadline" });
```

Implementation may narrow strings into unions; full contract must distinguish no-route and cancellation from exceptions. `eligible` represents the final attempted pool, while full reasons record considered pools; it is not a union permitting cross-boundary selection. Missing exact patterns generate `unresolved_reference` evidence even though they never appear as candidates. No model object, prompt, account secret, raw error or entire config is serialized. Full traces include pool input/matched/rejected identities; summary records counts plus selection reasons. Account refs in internal binding are omitted by public trace serializers unless explicitly requested locally.

Keep old `PreviewReport` and `[bifrost-json]` serialization separately. New `--trace --json` returns this versioned content-free envelope; do not append a prompt field to DecisionBase for convenience. Unknown fields/codes must not crash tolerant readers of this new envelope; unsupported major versions must fail explicitly.

### 3.3 Dependency ports and plugin scope

```ts
interface ClassifierPort {
  classify(input: { text: string; tiers: readonly string[]; deadline: number;
    access: "local-only" | "configured-network"; signal?: AbortSignal }):
    Promise<ClassificationResult>;
}
interface RoutingStrategyPort {
  readonly id: string;
  select(input: { candidates: readonly Candidate[]; now: number;
    random: () => number; economic: EconomicSnapshot }):
    { model?: ModelKey; reasons: readonly RouteReason[] };
}
interface Router {
  resolve(request: RouteRequest): Promise<RouteDecision>;
}
```

Snapshot providers supply normalized registry/capability/economic/health data; they do not get prompt text. Cache lookup/write is an injected classification seam already present in pipeline dependencies. ReliabilityStore remains the sole state writer. Affinity is a small injected pure function plus session fact snapshot. These contracts make components replaceable without a discovery framework for every function.

Built-ins register explicitly at construction; duplicate IDs fail construction. Trusted extension code can register a strategy/normalizer/signal adapter programmatically; config can reference only registered IDs. No dynamic import paths, arbitrary npm adapters or executable expressions in config. Deadline-bound asynchronous observation occurs before snapshot construction, not inside a strategy. A strategy returning an identity absent from eligible candidates yields `strategy_invalid_result`; fail closed rather than accepting it. A provider-specific adapter may inspect only its allowed host binding, not unrelated credentials.

## 4. Resolver algorithm and dispatch lifecycle

### 4.1 User route resolution

1. Validate request version, bounded text, target, requirements and cancellation. Capture immutable config/registry/reliability/capability/economic/affinity revisions and one wall clock. Use monotonic clock for elapsed deadlines.
2. Derive requirements from host payload before classification; merge caller facts and global/tier requirements with set union and maximum token bounds. No image/modality extractor is included. Future callers cannot negate host-observed mandatory requirements.
3. Honor explicit model/tier; otherwise call the existing classification pipeline with permitted access. Cache is keyed by classifier semantics, not by final model suitability. Validate returned tier/direct reference and carry rejection/fallback source in trace.
4. Resolve boundary: requested tier plus its explicit direct fallback list, or legacy single default. Exact-model target creates a singleton boundary with no implicit fallback. Do not recursively traverse fallback lists.
5. For each pool, expand patterns in existing order, dedup identity, reject known virtual/classifier entries, record unresolved patterns. Then capability checks, availability/credentials when observable, circuits/active leases, explicit economic constraints.
6. If eligible is nonempty, configured strategy chooses; optional within-tier affinity can retain current on automatic user target only. Validate result membership and explain both base strategy preference and retained identity.
7. Empty pool advances only within boundary. Terminal no-route names constraint, attempted tiers and all relevant reasons. Legacy adapter retention is possible only when the request has no activated hard control; retention is recorded as a separate continuity/degraded decision and validated under any active hard requirements.
8. Return plain decision. Do not claim leases, select Pi model, write route history, update affinity or persist final-route cache. Classifier cache/LRU/metrics side effects are separate disclosed classification behavior; exported local-only resolution uses read-only cache access by default.

Classification network fallback stops once its total deadline is exhausted; local regex/default may still produce a valid decision unless caller cancellation occurred. Cancellation returns cancelled, not a default route. No output after abort can trigger activation.

### 4.2 Admission and physical input

For selected decision, adapter checks config/model selection hasn't changed while awaiting classification. Per-session generation sequence or cancellable queue ensures an older decision cannot override a newer manual model choice. If stale, stop with `decision_stale` or re-resolve **once before generation** under the same remaining deadline. This re-resolution is not prompt replay; no coding request has been dispatched.

Recheck hard facts and atomically reserve all required half-open scope leases. Contention permits at most one bounded re-resolution to another already allowed candidate; otherwise return no-route. Do not hold locks while classifying or invoking providers. Then claim per-session self-selection, await `pi.setModel`, release self-selection in finally, and start dispatch tracking on success. False/throw records activation failure and releases only owned trials.

Under strict boundary/enforced hard policy, unresolved route, contention or failed activation returns `{ action: "handled" }` in input handler and reports an actionable error. It must never fall through `continue` on the old selected model. Pi v1.0.1 `_runInputHandlers` returns before processing when handled. Restore typed user text to TUI editor only if still empty/unchanged, preserve attachments through host-supported mechanism, and never persist/requeue via `sendUserMessage`. If attachment restoration is unavailable, disclose that the user must reattach; do not log bytes. Non-TUI emits structured no-route and stops input; determining process exit code requires an E2E gate rather than invented ExtensionAPI support.

Legacy paths continue matching current behavior when hard controls are absent. Do not run requirement or economic network calls while pinned/off. Status must distinguish selected model from actual dispatch and pending failure.

### 4.3 Virtual route

Build facts from `request.messages` and `request.signal`, not latest user text alone. Keep latest-user text for classification and override association; do not add image/modality extraction in this release. Request-bound override queues keep steer/follow-up FIFO ownership; terminal outcomes clear only their own entry.

For `user`, resolve/admit as above and return physical model plus clamped thinking level. Strict no-route throws a structured adapter error; disable the existing `deps.sticky()` degrade escape for this decision. For legacy permissive user route, preserve visible last-physical retention.

For `continuation`, use previous physical pair; for `retry`, failed/previous physical pair. No classification, budget preference, affinity ranking or replay. Preserve owned in-flight lease instead of acquiring another at each tool continuation. A revoked binding or new actual hard capability mismatch stops with error; a newly recorded open circuit does not retroactively migrate the transcript. `direct` uses last/default identity with direct payload requirements, no affinity write, no user-target classification. No virtual-to-virtual dispatch.

Keep `createDispatchOwnership` semantics: only owner releases a claimed lease; setup failure never abandons someone else's trial. Associate every actual physical request with request/turn binding so overlapping direct calls cannot overwrite main-turn attribution. A host retry routed after a failure remains a host retry; Bifrost does not create it or claim transparent recovery.

### 4.4 Settlement

Record only observed provider outcome on the physical identity Pi dispatched, once per turn/outcome ID. Tool-result error alone is not a provider failure. Aborted/incomplete turn abandons owned trial without success/failure. Successful half-open settlement closes owned scopes; ordinary model success retains Policy A. Successful response promotes affinity anchor, but preview/setModel/failed response does not. Observed token/cache/cost usage may enter optional counters with its measurement source, never as inferred savings.

## 5. Configuration schema and migration

Retain existing fields. Proposed version-2 additions:

```json
{
  "schemaVersion": 2,
  "models": {
    "restricted": ["provider-a/model-x", "provider-a/model-y"],
    "ordinary": ["provider-b/model-z"]
  },
  "default": "ordinary",
  "strategy": "first",
  "tierPolicies": {
    "restricted": { "fallbackTiers": [] },
    "ordinary": { "fallbackTiers": ["restricted"] }
  },
  "requirements": {
    "mode": "advisory"
  },
  "affinity": { "mode": "off" },
  "economics": { "mode": "observe" }
}
```

Placeholder provider IDs are illustrative and never ship in default pools. Default settings when additions are absent: legacy fallback, advisory requirements, no affinity ranking, no economic adapters or filters. Only non-empty observed requirements cause capability warnings; do not flood every text turn with unknown unused capabilities.

### Layer and validation rules

- Unversioned source layer is v1. Validate each layer's shape/version before merge; mixed v1/v2 layers are allowed if binary supports v2, effective config revision includes all layer versions. An older binary ignoring new fields is not a safe rollback for users relying on hard boundaries.
- `tierPolicies` shallow-merges by tier, each policy merges known scalar/object fields; `fallbackTiers` arrays replace, including `[]`. Never use a truthiness/default helper that turns empty list into legacy fallback.
- `modelCapabilities` merges per exact model/key with explicit observation provenance; no provider wildcard capability assertion initially. `requirements` mode/unknown handling merges like existing nested settings. Tier-specific requirements use optional `tierPolicies[tier].requires` with monotone union at fallback.
- New version-2 namespaces reject unknown keys/unsupported strategies/requirement atoms. Legacy unknown fields produce advisory warnings and are preserved during explicit migration. Do not pass prototype keys/accessors into maps; decode plain own-data properties and size-limit files.
- Fallback targets must exist, differ from source and be unique; detect cycles with bounded DFS. Lists are nonrecursive by contract, but cycles are rejected as contradictory user intent. Maximum configured tiers 100, patterns 1,000, fallback length 100, IDs 512 chars as initial defensive bounds; verify compatibility before enforcing against existing fixtures/users.
- Malformed config reload keeps last valid effective config, caches and store binding; report file/path/code without raw file contents. Startup with invalid version/policy cannot partially activate routing. No-pool legacy setup offer stays intact; no partial v2 enforcement on invalid startup.
- Key modelCapabilities by exact identities; unresolved assertions warn rather than inventing models. Timestamp-free static assertions remain valid until config revision changes.

### Explicit migration/reconciliation

Offer `/bifrost config migrate --preview` before `--apply`; generate transformation for one selected source, not flattened merged config. Preview shows source and inherited values, backup path, required minimum binary version and rollback warning. Apply validates prospective merged config and uses compare-and-swap on original file digest; concurrent edits abort. Back up exact bytes; JSON serialization must not silently destroy unrelated fields. If preserving comments is required, reject non-JSON with explanation rather than treating it as supported JSONC today.

`/bifrost config reconcile` initially proposes a diff only; separate explicit `--apply` adds/removes generated membership using ownership sidecar revision. Existing init confirmation remains. Track source IDs, successful discovery revision, exact model memberships and user removals as tombstones. Never infer ownership of a handwritten entry. Partial/auth-failed/stale registry discovery only warns; removal requires complete successful source inventory and explicit apply. Do not overwrite classifier, category strategy or tier policy during init/reconcile. No automatic tier reclassification by cost or model name.

Schema, `BifrostConfig`, validators, docs, defaults, examples, init and migration fixtures must land together for each addition. New defaults must not introduce provider IDs or unapproved tier semantics.

## 6. Reliability scopes, policy and persistent transactions

### 6.1 Failure contract

```ts
type FailureCategory = "rate_limit" | "allowance_exhausted" | "authentication"
  | "billing_denied" | "overload" | "transport" | "model_unavailable"
  | "invalid_request" | "capability_mismatch" | "context_limit"
  | "tool_protocol" | "activation_failed" | "unknown";
type HealthScope =
  | { kind: "model"; model: ModelKey }
  | { kind: "provider"; provider: string }
  | { kind: "account"; provider: string; accountRef: string; epoch: string };
type FailureObservation = {
  outcomeId: string;
  binding: DispatchBinding;
  category: FailureCategory;
  scope: HealthScope;
  scopeEvidence: "structured-adapter" | "host-binding" | "model-only";
  observedAt: number;
  retryAt?: number;
  allowanceWindow?: { windowId: string; periodId: string; periodRevision: string };
  source: "runtime" | "activation" | "probe";
};
```

For allowance_exhausted observations, allowanceWindow is required when the adapter knows the exhausted window; adapters validate this conditional contract. Unknown-window exhaustion creates a separate scope-wide allowance block with explicit unknown-window provenance, never overwrites a named window, and requires authoritative scope-wide recovery or explicit repair. A named window refresh cannot clear an unknown-window block.

Use discriminated, length-safe encoded tuple keys in persistence, not ambiguous `provider:model` strings sharing the model map. Generic error-text parsing returns category plus model-only scope; do not serialize raw text. Adapter scope must match dispatched binding; an adapter cannot name another account. HTTP 429 alone supports rate-limit category but not account/provider scope. 503 alone supports overload, still model-only. Authentication error for known binding may be account scope; credential epoch change retires that block with explicit revision, not silent success.

### 6.2 Policy table

| Observation | Legacy default | Optional scoped policy |
|---|---|---|
| Rate limit/overload/transport/model unavailable | Existing threshold/window/cooldown | Known scope threshold; structured retry/reset; controlled half-open |
| Allowance exhausted | Existing model failure observation | Block known allowance scope until authoritative reset/repair; do not collapse weekly and session windows |
| Auth/billing denied | Existing model failure observation | Repair-required known binding block; no endless scheduled probe loop |
| Invalid request/capability/context/tool protocol | Existing observed error behavior | Diagnostic/request-local failure, no unrelated circuit penalty |
| Activation false/throw | Existing failure | Model-only unless host confirms binding/auth detail |
| Cancellation | No failure | No failure, owned lease release |
| Probe | Existing batch behavior | Optional observation-only semantics only after ADR approval; intentional recovery can own trial |

Normalize Retry-After delta seconds and HTTP date, plus adapter reset times. Use wall clock once, clamp past timestamps to now, reject nonfinite/negative values and enforce configurable upper bound (initial 24 h for transient cooldown, allowance reset can be longer and labeled accordingly). In scoped policy, authoritative retryAt wins over heuristic delay; delay is never shortened by an unrelated model success. Exponential cooldown has cap and deterministic injected jitter for tests. Existing v1 defaults remain unchanged.

### 6.3 State and leases

V2 state lives in separate `.pi/bifrost-reliability-v2.json` only when opted in, seeded from a backed-up v1 snapshot. Schema includes revision, per-scope generation, scope records, last observation codes, cooldown, independent allowance-window blocks, repair-required status and leases `{ owner, outcomeId, admittedGeneration, expiresAt }`. No raw errors or credentials. Keep bounded outcome-ID deduplication until longer than maximum active turn/lease horizon; duplicate settle must not count twice.

Atomic admission claims all applicable half-open scopes in one transaction. A shared account half-open trial excludes all matching siblings; closed scopes need no trial lease. Lease extends only through owner heartbeat if turns exceed configured TTL; TTL initial 120 s with renewal ≤40 s is a proposal to verify against long tools/host pauses. On shutdown abandon owned lease; crashed owners expire. A stale in-memory decision may fail admission even though resolve saw eligibility.

Every block-affecting failure/reset/repair increments the scope generation atomically. Success closes only scopes leased by the outcome with matching owner/outcome ID, an unexpired lease and unchanged admittedGeneration, checked in the same transaction. A newer failure takes precedence over an older successful trial. Expired/lost-renewal/reclaimed leases cannot clear state or renew themselves after ownership changes; late settlement may be recorded as observation but cannot close the block. If an explicit account limit persists, a successful unrelated model call is not authority to clear it. If scopes have different cooldowns, admission waits until every applicable scope permits dispatch. Garbage-collect closed unused records after configured retention (initial 30 days), never active block/reset/lease. Credentials rotated to another epoch produce a new binding; retain old record for audit/retention but stop applying it to new binding.

### 6.4 Transaction IO

Current `writeJsonFile` is direct sync write; atomic rename alone does not prevent lost updates. For shared reliability/admission, acquire an exclusive lock for the path, reload+validate latest state, apply pure mutation, write sibling exclusive temp file, fsync file, atomically rename, fsync directory where supported, release owned lock. Never await provider/network work under this lock. Preserve mode 0600 for private managed files; user config permissions preserved with backup, reject unsafe symlink targets for writes. Windows rename/fsync differences need tests and documented durability limits.

Owner token and heartbeat protect lock removal; stale lock reclamation requires expired lease plus process-liveness evidence where supported. On uncertainty time out rather than stealing a live lock. Default lock wait proposal 100 ms on route admission, configurable and benchmarked; contention yields visible no-route/retry-admission, not silent dispatch without reliability. Lock scope is a local filesystem only, not NFS/distributed consensus. No network-shared state support promised.

Unreadable v2 state with active strict reliability policy blocks admission until repair; legacy mode can continue with explicit degraded-reliability warning. Keep old file/quarantine intact and expose reset/repair command; never silently erase state as “healthy.” Readers receive deep immutable snapshot/copy, not `Readonly` shallow nested mutation. Batch probes still commit once. Reload/path change completes current transaction under old owner and installs new snapshot only after validation.

## 7. Economic signal design

```ts
type AllowanceWindow = {
  id: string;
  period: { id: string; revision: string; source: string; startsAt?: number };
  unit: "requests" | "tokens" | "credits" | "ratio" | "currency";
  currency?: string;
  remaining: number;
  limit?: number;
  resetsAt?: number;
};
type EconomicSignal = {
  source: string;
  scope: HealthScope;
  billing: "subscription" | "metered" | "free" | "unknown";
  windows: readonly AllowanceWindow[];
  observedAt: number;
  expiresAt: number;
  revision: Revision;
  confidence: "authoritative" | "declared" | "estimated";
};
type EconomicSnapshot = {
  revision: Revision;
  signals: readonly EconomicSignal[];
};
```

A window period ID is mandatory and adapter-normalized, not guessed from optional reset time. Fixed windows identify the billing period; rolling windows identify the observation interval/bucket using documented provider semantics. Revision must be orderable within that source/window (validated sequence or observation epoch); reject delayed lower revisions. If an adapter cannot distinguish period rollover or order observations safely, its signal is advisory-only and cannot drive hard admission. Failure observations carry this same window ID/period identity when available.

Absence is unknown, never zero. Static signals require a user-declared expiry except immutable billing declaration; allowance data is always time-bound. Normalize percent to ratios in adapters with known schema, not magnitude heuristics that confuse 0.5% with 50%. Multiple windows are independent; a candidate must satisfy every applicable hard reserve. When two sources disagree at equal authority, report conflict and treat hard data unknown; do not cherry-pick the favorable balance.

Initial economic config supports observe mode and static facts. Later opt-in `mode: policy` supports the named scope/source/admission schema below and billing preference strategy options. Validate scopeRef against actually dispatchable host bindings; reject configured account routing on unsupported host. Reserved floor is a ratio of a known limit (or ratio unit), otherwise unknown. Equal preference retains candidate order/cost tie rule. No default billing preference.

Adapters refresh single-flight per binding outside hot path, observe-at completion, exponential bounded retry, source-specific TTL and explicit user enablement. Stale data can remain in inspect with age, but not enforce a hard reserve unless user explicitly accepts unknown handling. Failure refresh does not publish an empty “fresh” success snapshot. All callers share immutable refresh results; route cancellation detaches that caller and does not necessarily abort refresh needed by others. Never bundle the fork's consumer quota endpoints or read unrelated auth files.

Balance-across-reset strategy is deferred: first require comparable windows, expected consumption model and labelled simulations. Cost strategy remains catalog price, not subscription effective marginal dollars. A true monetary cap needs ledger/reservation/settlement and external-consumer limitations; no implementation milestone here claims it.

### 7.1 Quota policy schema and resolution rules

The following complete policy fragment illustrates model-scoped live observations, two independent allowance windows, and an explicit tier reserve override. IDs are placeholders, not shipped provider assumptions. An adapter's scope must actually cover this model; if the allowance is account-shared, use a verified account scope instead. Reject unsupported account bindings rather than relabeling account quota as model quota.

```json
{
  "schemaVersion": 2,
  "economics": {
    "mode": "policy",
    "scopes": {
      "primary": { "kind": "model", "model": "provider-a/model-x" }
    },
    "sources": {
      "live-primary": { "adapter": "registered-quota-adapter", "scopeRef": "primary", "enabled": true }
    },
    "sourceOrder": { "primary": ["live-primary"] },
    "admission": [
      { "id": "weekly-reserve", "scopeRef": "primary", "windowId": "weekly", "reserveRatio": 0.10, "unknown": "block" },
      { "id": "rolling-reserve", "scopeRef": "primary", "windowId": "rolling", "reserveRatio": 0.05, "unknown": "block" }
    ],
    "tierOverrides": {
      "restricted": { "weekly-reserve": { "reserveRatio": 0.20 } }
    }
  }
}
```

`scopes` maps local alias to the exact HealthScope discriminated shape. Account scope requires provider/accountRef/epoch from the host; provider scope applies only if the source proves provider-wide allowance. `sources` lists explicitly enabled registered adapters or declared manual observations; `sourceOrder` references those source IDs. Remove an undeclared source or fail validation; never invent a source. A production complete merged config also supplies pools/default and the named tier. Source configuration contains no credential value.

For each candidate, apply every matching model/provider/account rule, including all configured windows. Tier overrides are keyed by admission ID and may alter only reserveRatio or unknown handling. They apply to the currently evaluated pool tier, not a classifier label retained across fallback. Original request admission requirements, if any, cannot be weakened by fallback; tier rules add to them. Rules from unrelated scopes do not apply. No implicit per-tier quota exemptions.

| Condition | Deterministic resolution |
|---|---|
| Fresh sources for same scope/window | Explicit sourceOrder selects first usable source; without it authoritative > declared > estimated; equal-rank disagreement becomes unknown, never optimistic selection |
| Explicit source preference | Configured ordering wins only among fresh valid facts; selecting a declared source over live authoritative evidence is an explicit traced user override |
| Preferred source stale/missing | Try next configured source; without a fresh usable fact result is unknown and rule's block/ignore applies |
| Conflicting window periods | Window identity includes reset/period provenance; incompatible periods are not merged, conflict is unknown |
| Reserve equality | Reject when remaining/limit <= reserveRatio; ratio-unit facts use remaining directly |
| Missing limit in absolute units | ReserveRatio cannot be calculated: unknown; never infer a limit |
| Multiple matching scopes/windows | All admission rules must pass; one passing weekly window cannot erase an exhausted rolling window |
| Reset reached | Prior period fact expires at min(expiresAt, resetsAt); remaining becomes unknown pending a new-period observation, never assumed full |
| New observation after reset | Adapter must attribute a new period/reset revision; old-period delayed responses cannot replace newer-period state |
| Unsupported dispatch account | Configuration rejected; no account selection or provider-wide approximation |

Allowance-exhaustion reliability blocks carry window ID and period revision. Advancing one window does not clear another; post-reset unknown follows configured admission handling, while independent authentication/billing/circuit blocks remain. Admission reads current source revisions again immediately before dispatch. These are snapshot admission controls, not atomic subscription reservations against external users.

M5b is required for a release advertised as automatic quota-aware routing. Adapter selection is evidence-driven: prefer a documented Pi quota signal; otherwise one documented, authorized provider API using Pi-managed auth. Verify schema, independent windows, account scope, reset meaning, freshness and error behavior before choosing a provider. If neither path exists, the milestone is blocked and the release remains explicitly quota-snapshot-aware. Do not fabricate endpoint availability or silently adopt the fork's private consumer endpoints. Live adapter network refresh remains opt-in; fake fixtures are the release gate, and any controlled live validation requires user-authorized credentials.

## 8. Affinity and classification cache

### Affinity state

Session/branch-local record: physical model key, provider, last successful dispatch time, source outcome ID, branch/config revision. No prompt or normalized text. In-process WeakMap by host session with explicit branch partition; reset on new session/branch navigation by default. Virtual `request.state` is persisted branch state in Pi, so do not use it for ephemeral soft affinity without approving persistence semantics. Restoration can display transcript identity but has mode off until explicit supported restoration policy.

Observe mode emits `current_eligible`, `locality_unknown`, `switch_required` and base-strategy comparison. Experimental retain-within-tier mode applies only to automatically targeted user requests and only if current key is in final eligible pool. Explicit target, fallback that excludes current, unsupported modality, hard reserve or unavailable binding wins. Explain `affinity_retained` including which configured strategy winner was displaced; no numeric cache savings. Provider-only locality remains advisory.

If caller requests a decision for another workflow, it passes its own current/session/branch fact; it must not read main Pi session affinity implicitly. Concurrent background resolutions cannot promote the main anchor. Only settle on successful dispatch updates anchor once; failures preserve prior anchor but current identity may be excluded on next resolution. Legacy selection-disabled/pin retains explicit selection outside affinity.

### Classification cache

Retain fuzzy tier cache as optional classifier optimization. Semantic key includes effective backend, explicit classifier identity, tier definitions/criteria, prompt policy and classifier configuration revision. Requirements/economics/reliability do not belong in that tier-judgment cache; reevaluate eligibility on every request. Add confidence/provenance only with explicit schema evolution; never manufacture original confidence for a fuzzy hit. Enforced tier controls apply even to stale cached labels; unknown removed tiers miss cache.

Normalized prompt strings are recoverable sensitive text. Keep cache opt-out honored, private permissions/retention, never export it automatically. Do not relabel prompt-derived hashes as anonymous. New affinity uses no classification-history text. Avoid adding CacheStore solely for symmetry; existing injected cache seam is sufficient until mutation ownership needs independent improvement.

## 9. Classification orchestration

Inventory before refactor: direct TypeSafe and native have their own deadline/retry/strict confidence infrastructure; prompt registry, endpoint, subprocess and minimal session paths differ. Native calls Pi classify once per attempt; Bifrost currently owns retry. Do not wrap a retried backend in another full retry loop.

Use one invocation context with monotonic deadline, attempt tokens and caller cancellation. Transport accepts an attempt signal; orchestrator chooses whether to call next backend/fallback. Adapter parses/validates its wire schema; common runner validates configured-tier membership, reports outcome and applies shared fallback rules. Backend-specific credential refresh/error interpretation remains adapter-owned. Classifier cooldown state is separate from coding-model availability and keyed by actual classifier binding.

Initial extraction keeps existing per-backend budgets and max attempts; common total-budget option is opt-in. When enabled, total includes model resolution/auth, backoff, every prompt fallback, subprocess startup and minimal session. Limit retries to normalized transient errors; no retry for invalid criteria, unavailable auth, decode error or low confidence unless current explicitly documented behavior must be retained during parity stage. Record rejected judgment outcome separately from final regex/default route. Confidence output is optional and must pass existing validation; do not treat classifier failure as coding task failure.

Propagate AbortSignal to registry calls, HTTP and minimal session; subprocess cancellation sends TERM then bounded KILL, drains/limits output and removes timers/listeners. If host helper cannot cancel, runner can stop waiting but must account for orphan work and prevent subsequent paid fallback from multiplying requests; unsupported cancellation path blocks promotion until fixed. Minimal classifier session uses no main tools/resources/Bifrost recursion; inspect existing session-fallback loader and add a fake-tool assertion rather than assuming its name guarantees isolation.

Local-only exported requests skip network/backend attempts and use read-only cache, compiled regex and default. Main Pi/explicit ordinary preview keeps configured-network behavior with existing disclosure. No requirement/budget adapter receives classifier prompt. Prompt backend raw response debug snippets today can contain sensitive text; new runner events must remove them or retain only an explicitly isolated legacy debug mode with warning, never feed them into route traces.

## 10. Diagnostics, trace and metrics implementation

Trace sink is request-local and optional. Capture timings independently of debug enablement; `debugMeasure` currently writes rather than returns duration and can be a no-op. Do not reconstruct traces by parsing debug JSONL. Summary decision required; full stage/candidate allocations requested by preview/API/tests. This reconciles ADR 0007 with current PreviewReport while limiting hot-path overhead.

Stable rejection codes include `unresolved_reference`, `non_generative`, `capability_missing`, `capability_unknown`, `context_bound`, `auth_unobservable`, `auth_unavailable`, `circuit_open`, `trial_active`, `allowance_reserve`, `economic_unknown`, `fallback_boundary`, `strategy_invalid_result`, `decision_stale`, `activation_failed`. `auth_unobservable` is advisory unless caller explicitly requires known auth. Codes do not embed raw patterns/prompts/errors; details are bounded allowlisted primitives.

Command registry entries:

- `validate [--json]`: offline structural/layer/fallback/regex/reference checks; no provider calls. Distinguish structural error from heuristic lint warning; reachability cannot be proven for arbitrary regex, only demonstrable duplicates/simple catchalls.
- `inspect [--json]`: registry revision, metadata ages, configured candidates, classifier effective backend and cooldown, auth availability if observable, scoped circuits, economic/affinity mode. No implicit probe or refresh.
- `preview [--offline] [--trace] [--json] <prompt>`: same resolver, optional full trace; no active model/trial/affinity mutation. No attachment preview or image-file parsing is included; text preview must not imply image-suitability validation.
- Existing probe/refresh/init controls keep explicit paid-call disclosure. Proposed config migrate/reconcile commands are separate later registry additions.

Local event envelope: `{version,event,requestId,observedAt,durationMs?,revisions,counts?,codes?,modelAlias?}`. Events include route decision/rejection counts/classification outcome/circuit transition; no per-candidate event flood by default. Default observability off except existing content-free metrics behavior. Opt-in log rotation and bounded queue; drop events with a counted drop metric on pressure, never block inference. Proposed bounds 10 MB per file, two retained files, 1,000 queued events; validate on synthetic load before release. Sampling deterministic by random request ID, no prompt hash. No cloud exporter bundled. New serializers redact account refs and private model aliases on export.

## 11. Ownership, concurrency and lifetime

| State | Owner / lifetime | Concurrency contract |
|---|---|---|
| Resolved config and model registry | Extension coordinator, immutable version snapshots | Validate entire reload then atomic pointer swap; in-flight requests hold old version until admission recheck |
| Classification pipeline/cache | Per effective config/classifier revision; cache location user-configured | Read-only service mode; serialize writes where shared; semantic revision prevents mixed backend judgments |
| Reliability/circuits | Store by canonical state path; persistent | Cross-process read-modify-write lock, owned multi-scope leases, dedup outcome IDs |
| Economic refresh | Adapter by host binding/epoch | Single-flight, timeout, immutable publication, expiry; no prompt or main-model mutation |
| Affinity/pin/inline overrides | Session and branch/request | No global last prompt/tier; per-session activation generation; background calls separate context |
| Physical dispatch tracker | Turn/dispatch owner | Actual model binding, own lease tokens, no overlapping direct call overwrite |
| Trace | Request only | Never shared mutable accumulator; bounded serialization after outcome |
| Debug/metrics | Existing debug currently module-global | Audit simultaneous instances; inject sink/context before claiming reusable concurrent service |

Main-session setModel operations serialize; programmatic resolve calls run concurrently on snapshots. Avoid holding a session lock across network classification: use cancellation/generation check. Snapshot returned to API consumer is not a reservation; it may be stale by dispatch time. API caller owns its own admission integration, not the user's model. Shared-file locking protects local processes, not independently stored copies or distributed quotas.

## 12. Public API and packaging

Propose `pi-bifrost/router` direct import with `createRouter({config, registrySnapshot, classifier, healthSnapshot, capabilitySnapshot, economicSnapshot, clock, random})`. First mark experimental version 1 and pin API examples to supported Node/Pi loader. Dependencies explicit, no `process.cwd()` default, global auth read, default main-session state or filesystem writes. Config normalizer and adapters may be imported separately only if needed; do not export every internal type/function as stable.

Return `RouteDecision` without `setModel` or trial reservation. A separate internal admission port stays adapter-owned initially; advanced consumer can supply isolated observation snapshots and dispatch independently. Document that resolve-only API does not enforce quota atomically and cannot promise availability. API request permits configured-network classification only through caller grant and injected adapter; local-only is default in facade.

Before stable promotion: add export map and type declarations or supported TS loader guidance, `npm pack` consumer test, Node import in temporary clean consumer, Pi extension load test and API-version fixtures. Avoid interfering with `pi.extensions: ["./index.ts"]`. Existing package includes root `.ts`; stable JS consumers may require a build/declaration output—decide from consumer smoke evidence, not assume runtime TS support everywhere. Host event bridge could later serialize this same envelope with bounded IDs/grants, but no custom classifyTask/thinking RPC now.

## 13. Testing and evaluation plan

### 13.1 Deterministic test cases

| Suite / proposed file | Cases and assertions | Requirements |
|---|---|---|
| legacy-resolution fixtures | Every strategy including equal costs/context; substring/exact duplicates; direct first-rule nuance; regex/cache/default; all pool failure; physical/Auto legacy retention | R01/R02/R17 |
| requirements/capabilities | Future requirement seam fixtures, unsupported/unknown/stale assertions, missing registry types, configured override conflict, token lower bound/reserve overflow | R04/R05 |
| fallback boundaries | Absent vs [] vs ordered lists; explicit/classified tier parity; requirements monotone through fallback; no retained escape; invalid cycles/self/duplicates | R05/R06 |
| scoped reliability | Model/account/provider matching, 429/503 scope unknown, sibling isolation, Retry-After seconds/date/skew, repair blocks, success ownership/generation, newer failure before trial success, expired/reclaimed lease, lease crash/renewal/contention, dedup settle | R03/R08 |
| economic normalization | Multiple windows, finite/range/units, incompatible currency, stale/unknown/conflict, reserve boundary equality, no hard cap claims, no provider inference | R10 |
| affinity | Explicit target beats retain, current outside tier, reserve/outage forces switch, branch/new-session reset, preview/failed dispatch no promotion, successful settle promotion once | R11 |
| classifier runner | Total deadline covers retry/backoff/fallback/model auth; malformed/low-confidence/unknown tier; abort at every phase; no double retry; subprocess cleanup/minimal session isolation | R12 |
| config/storage | Versioned mixed layers, array replace including [], unknown fields, last-good reload, backup/CAS, torn writes, symlink/permission, corrupt state, lock owner death | R09/R15 |
| traces/diagnostics | Text/JSON same decision, no prompt/secret/tool/error leakage, reason coverage for unresolved refs, inspect offline, preview no lease/model mutation, legacy JSON compatibility | R01/R07/R14 |
| API concurrency | Resolve sessions isolated; manual selection while await prevents late activation; config reload mid-attempt stale admission; plugin returns excluded key; cancellation no dispatch | R06/R13 |

Use existing Node test runner. Introduce fast-check as dev dependency only in the property milestone with fixed seeds/failure shrink output; bounded exhaustive generated cases are acceptable initially. Properties:

1. Selected identity ∈ final eligible set and configured boundary.
2. Hard filtering is monotone: no subsequent phase reintroduces removed identity.
3. Strict tier never emits another tier or legacy-retained identity.
4. Required unsupported capability is never dispatched in enforcement.
5. Account scope suppresses only bindings with same provider/account/epoch.
6. Manual target/pin always defeats soft affinity.
7. Two successful simultaneous half-open admissions cannot own the same scope lease.
8. Cancelled requests perform zero activation/dispatch and no failure penalty.
9. Same snapshots/clock/seed produce same decision apart from duration/request ID.

### 13.2 Host integration and E2E

Use fake Pi registry/classifier/provider, not billing accounts. Extend existing runtime/virtual tests and fake-provider UI reliability script. Test physical activation false/throw with strict handler returning handled, zero generation calls, and prompt/attachment recovery; Auto same no-route throws and never uses previous model. Verify 429 and 503 injected after tool side effects cause one failed turn and no Bifrost replay. Preserve footer/status and effective thinking clamp.

Exercise continuation with tools, host retry physical identity, direct compaction calls concurrent with main turn, queued steer/follow-up override order, session tree navigation, restore, pin/off leaving Auto, registry refresh failure, config reload while pending classifier, shutdown during leased trial. Confirm classifier entries cannot enter probes/init pools once safety correction enabled. Check non-TUI error result separately; no invented process exit guarantee.

Required production behavior-change checks: `npm test`, `npm run typecheck`, relevant `npm run test:ui` and `npm run test:ui:reliability`, integration tests for dispatcher/API packaging. Documentation-only proposal checks are recorded at the end; PTY checks do not validate an unimplemented proposal.

### 13.3 Compatibility matrix

Use pairwise coverage plus mandatory high-risk intersections, not a full combinatorial explosion:

| Axis | Values |
|---|---|
| Classifier | off/regex, prompt registry/endpoint/subprocess, TypeSafe, native explicit/catalog, detected backend |
| Strategy | all 7 existing; experimental economic; retain-within-tier modifier |
| Boundary | legacy default/retention, [], explicit list, exact model |
| Capability | advisory metadata; supported/unsupported/unknown/stale; future enforcement is separately gated |
| Health | closed/open/half-open/trial-owned/lease-contention; model/account/provider |
| Economics | off/observe/policy; fresh/stale/absent/conflict/multi-window exhausted |
| Session | new/restored/branch/queued user/tool continuation/retry/direct/concurrent background |
| Host mode | physical automatic, Auto, manually selected/pinned/off |

Mandatory: Auto + strict + all unhealthy + prior dispatched; physical + strict tier + activation failure; native catalog cache bypass + reload; continuation + quota circuit opens; reserve + stale data + unknown block; explicit tier + affinity; shared account half-open across processes; newer quota failure followed by older trial success; manual selection during network classifier. Freeze expected trace and dispatch count, not fragile timing/string order only.

### 13.4 Failure injection

Inject bounded malformed JSON/probabilities, classifier never resolving, abort before/after refresh, 429 with each Retry-After shape, 503 without scope evidence, exhausted account window, unknown capability, stale billing snapshot, empty/partially discovered catalog, truncated config/state, ENOSPC at temp/fsync/rename, lock held/dead owner, duplicate/out-of-order settle and config CAS conflict. For each assert user-visible code, selected/no-route state, no replay, owned lease release, and prior file preservation. Cancellation during atomic commit must not leave an incomplete published state.

### 13.5 Replayable evaluation

Extend existing Jev corpus with separate synthetic route scenarios, not a store of real user prompts. Manifest pins corpus/version/labels, config, registry, capability/economic/health snapshots, initial session state, clock/RNG seed, expected allowed set/no-route, and baseline implementation SHA. Multi-turn cases model quota resets, outages, branch switches and locality changes. Label allowed routes/preferences independently of a particular strategy; two valid models may both be acceptable.

Report invariant violations/no-route and fallback rates first; classification tier accuracy only where labels have clear criteria. Compare baseline routes, p50/p95 local and classifier latency, switches, instability under tiny prompt changes, observed/estimated usage, allowance reserve compliance, failures and false exclusions. Cache-locality preservation is a proxy distinct from measured cached tokens. Cost estimates disclose rates/output assumptions; real cost comparison requires matched workloads and settlement, not “cheapest” naming. Generation quality requires separate controlled task execution and human/automated acceptance labels; do not infer quality from category agreement.

Promote experimental strategy only after zero safety violations, documented tradeoff on held-out sessions, opt-in user report and approval. No automatic tuning/default replacement. Sanitized real traces may enrich aggregate operational metrics, but prompt-derived corpus additions require explicit curation/consent; no upload or reconstruction pipeline bundled.

## 14. Performance verification

Benchmark existing pure resolver and wrapper at 10/100/1,000 candidates, 3/20/100 tiers, exact/substring pools, full/summary traces, warm/cold metadata and random seed. Separate filesystem admission time from deterministic resolve and network classify time. Measure allocation/event loop delay and repeated source normalization; memoize per immutable revision/object, not global mutable model metadata.

Proposed targets from PRD: p95 local resolve ≤10 ms at representative 100/20 workload or ≤20% overhead baseline (less restrictive); full trace overhead p95 ≤1 ms at 100 candidates; no network capability/budget lookup during filtering. These are initial gates requiring measured calibration, not current achievements. Large generated stress scenarios can be slower but must remain bounded. Set limits/timeout recommendations after recording hardware and Node/Pi versions.

Metadata refresh single-flight timeout does not consume each caller's entire classifier allowance by accident; overall route deadline budgets refresh plus classification when explicitly enabled. Preview full trace retains bounded data; metrics queue drop policy never blocks route. Existing sync reliability writes are included in baseline; transaction costs need separate profiling before advertising sub-10 ms dispatch admission.

## 15. PR-sized delivery sequence

No long-lived architecture branch. Each milestone is independently shippable; split by the listed sub-PRs, not one massive series withheld until completion. No estimates imply approval to code now.

| Milestone / sub-PR | Scope, user value and dependencies | Gate / rollback |
|---|---|---|
| M0a: baseline scenarios | Capture actual legacy routing/Auto/input behavior and research SHA; R16, no production behavior change | Existing checks plus fixtures; revert fixtures independently |
| M0b: decision envelope | Typed summary and optional full trace around existing helpers; richer preview, R01/R14; reconcile ADR 0007 | Snapshot parity + privacy; old report remains; disable full trace |
| M0c: snapshot seam | Host-neutral registry view with legacy resolver wrappers, no public API; R13 foundation | All route parity tests; adapter swap reversible |
| M1a: atomic writes | Replace managed-state write primitive, bounded decode; R09; visible corruption/write diagnostics | Fault injection; no schema change; backup original file |
| M1b: config v2 + validate | Version normalizer, provenance, last-good reload, offline diagnostics; no new enforcement yet | v1 fixtures/schema/docs/init consistency; v1 stays readable |
| M2a: model-kind observations | Generative/classifier/virtual facts and warnings in inspect/preview; R04/R07 | Fake registry plus controlled host type proof; default route parity |
| M2b: boundary resolution | Add explicit fallback arrays with trace and strict terminal decision, no unsafe host rollout | Property monotonicity; cannot release runtime enforcement until M2c |
| M2c: strict physical/Auto adapters | Opt-in pre-generation handled/error, remove strict retained escape; R05/R06 | Targeted UI/integration prompt preservation + zero inference after no-route; feature off restores legacy with warning |
| M2d: generation type safety | Classifier-only pool exclusion in routing/probes/init, staged release note; no image enforcement | Typed catalog fake-provider tests; remove invalid entries via explicit migration |
| M3a: classifier accounting | Common deadline/abort trace orchestration with preserved budgets; R12, existing adapters retained | Malformed/abort/no double retry and no-tool isolation; old budget path preserved |
| M3b: failure observations | Normalized categories/model-only scope evidence in inspect, no cooldown change; R08 | 429/503/body privacy; revert observation schema independent of policy |
| M3c: transactional leases | Cross-process state transaction/lease ownership under existing model policy; R08/R09 | Multi-process fake-clock/crash/contention; read backup, do not dispatch without required admission |
| M3d: scoped opt-in policy | v2 sidecar, provider/account adapters only where host identity proven; R08 | sibling isolation/epoch/reset/repair; disable scoped policy, retain sidecar and v1 backup |
| M4a: public experimental API | Export resolver after internal stability, explicit grants, consumer package tests; R13 | clean consumer/Pi load/cancellation/no mutation; versioned export marked experimental |
| M4b: reconciliation proposals | Owned membership diff and explicit apply/CAS/backup, R15; depends M1 | partial discovery/no delete/manual edits/tombstones; restore exact backup |
| M5a: economic observations | Normalized static/manual windows + inspect freshness, adapters opt-in; R10 | no provider branching/no network default/privacy; disable adapter |
| M5b: first verified live quota adapter | Opt-in host/provider adapter with documented authorized endpoint, Pi-managed auth, attributable scope, independent windows and bounded refresh; depends M5a and host evidence | Recorded source/auth contract, fake HTTP fixtures, freshness/reset/error tests; if unavailable remain snapshot-only and do not claim live tracking |
| M5c: economic admission/preference | Experimental reserves and billing preference, explicit unknown policy; depends M2/M3/M5a; user-facing automatic quota routing requires M5b | multi-window/stale/unit tests + offline eval; disable independently, warn about lost admission control |
| M6a: affinity observations | eligible-current/locality advisory facts, R11; depends shared decision and session ownership | session/branch/preview isolation; no behavior change |
| M6b: retain-within-tier | Experimental explicit opt-in, R11; no ADR 0019 session-base implementation | held-out multi-turn eval + strict/explicit intersections; switch off restores ordinary strategy |

Strict fallback is an independent vertical slice: M0a/M0b plus the minimal M1b schema-v2 reader/validator and M2b/M2c, without waiting for M0c snapshot extraction, M1a storage hardening, or M3 transactional scopes. M2b remains internal/preview-only until M2c ships; do not expose partially enforced strict policy. Boundary fields require schemaVersion 2 consistently; this slice includes only the minimal version reader/validator and boundary validation, while general migration commands/provenance tooling and storage hardening remain independently deliverable. Unversioned v1 remains supported with legacy behavior. Persistent/scoped policies still depend on M1 storage/versioning; API follows the snapshot seam and stable dispatch lifecycle; economic/affinity changes follow observations. M5/M6 research can proceed independently, but their routing changes require the common invariant gate. Hard spend caps, quota reset optimization, dynamic thinking, complexity shortcuts, network RPC, cross-tier session-base policy and replay are outside these milestones.

For every behavior PR: reconcile/approve relevant ADR, document explicit policy and override, include trace, deterministic evidence, schema/example/init parity, release note, and rollback. Keep unrelated worktree changes untouched. Conventional commits with project-required emoji, atomic scope, no agent attribution. No commits/PRs are made by this documentation task unless requested separately.

## 16. Launch gates, unresolved dependencies and validation record

### Launch gates

- M0 must demonstrate semantic parity before any new feature alters selection. A replacement resolver cannot quietly reinterpret first-rule or substring order.
- M2 strict release requires actual Pi handled-input and Auto throw E2E, input-preservation boundary and non-TUI outcome evidence. Host types confirm interception exists, not all UX behavior.
- Classifier-only exclusion requires catalog behavior proof. The existing roadmap explicitly leaves this question open; do not mark it implemented from comments.
- Account-level signals require observable dispatch binding/epoch. Unsupported account selection is rejected, not emulated with provider-wide policy.
- Persistent lease implementation must pass process-crash and lost-update tests, not just in-memory Promise concurrency tests.
- Experimental economics/affinity cannot become defaults without eval evidence and product approval. No dependency delay justifies weakening a hard exclusion.

### Decisions intentionally left gated

Stable JS artifact packaging versus runtime-TS consumers is decided by M4 consumer tests. Final classifier recommended timeout and lock/lease durations are benchmark/lifecycle calibrated. Supported provider quota adapters require documented/authorized endpoints and host credential boundary; no live account was read for this design. Context/tools/structured-output enforcement requires actual payload visibility in physical input path. Policy-level session stickiness requires separate ADR 0019 decision. These are explicit implementation gates with safe behavior (unsupported/observe/no-route), not hidden TODOs that permit routing anyway.

### Validation of this proposal

Research used fresh temporary upstream/fork clones, pinned Pi v1.0.1 source, current primary provider cache documentation and a Context7 Pi documentation lookup checked against the pinned host source. No provider generation/quota calls or production behavior modifications were performed. This task creates only PRD.md and IMPLEMENTATION.md. Baseline checks and document validation results are recorded after completion below; they validate baseline/document integrity, not the proposed architecture's future runtime behavior.

Validation on 7 October 2026:

- `npm test`: **438 passed, 0 failed**. Initial sandbox run passed 437 and failed npm packaging because npm cache access was denied; the authorized rerun passed the full suite.
- `npm run typecheck`: **passed**.
- `git diff --check`: **passed**; new-document trailing whitespace checked separately because the files are untracked.
- Both documents inspected; Markdown fences balanced, local links resolved, R01–R17 present in both documents. Later review revisions also checked JSON examples for syntactic validity; baseline test results above are from the initial documentation task, not a new runtime implementation.
- No UI/routing implementation changed, so PTY/UI harnesses and live-provider evaluation were not run. Future milestone tests above are specifications, not claimed results.
- Development dependencies installed without generating a lockfile or changing package.json. Working-tree deliverables are only these two new documents; no commit or PR created.
