# 0008 — Direct-rule fallback chains

## Status

**Proposed** (2026-07-29). Pending review. Do **not** implement until the design is accepted and the implementation gate is green.

## Context

A route rule today pairs a regex pattern with a single `model` value (`routing.ts:14-17`, `schema.json:80-94`). The `model` field is either a tier name (e.g. `"frontier"`) or a direct binding (e.g. `"opencode-go/glm-5.1"`), detected by whether the string contains `/` (`classification-pipeline.ts:66`).

Direct bindings are sharp. If the bound model is circuit-open (ReliabilityStore says it failed recently), routing silently falls back to the configured default tier (`runtime-reliability.ts` + `resolveTierDisplay`). The user who wrote `"when I say /commit, use opencode/mimo-v2.5-free"` sees their commit routed to the default tier — the opposite of what they asked for — and `/bifrost preview` shows `fallback: circuit_open` only if they happen to look.

The same applies to a binding for a model the user has since removed from their registry. The rule fires, the model is missing, the default tier takes over.

The goal: let a direct rule bind to an ordered chain of models. The first healthy candidate is selected; if none are healthy, the rule's tier (if any) is consulted; otherwise the default tier. This composes with ADR 0005 (ReliabilityStore is the filter) and ADR 0007 (the trace records each skipped candidate).

## Goals

1. A rule can express a preference order over direct models, not just one.
2. Reliability filtering is applied per-chain-element, not just at the bound model.
3. The trace (ADR 0007) records each skipped element with its reason.
4. Existing single-binding rules keep working unchanged.
5. No new persistent state.

## Constraints

- **No change to `RouteRule.pattern`.** Backwards compatibility for the regex is non-negotiable.
- **No change to single-binding semantics.** `"model": "opencode-go/glm-5.1"` keeps meaning exactly that.
- **Array syntax is an addition, not a replacement.** A rule with `"model": ["A", "B", "C"]` is parsed as a chain; a rule with `"model": "A"` is the existing single-binding.
- **No new strategy enum value.** The chain is an inline ordered preference; the existing per-tier `strategy` enum is unaffected.
- **Chain elements are direct refs only.** A chain entry must contain `/`; tier names inside a chain are rejected by the linter (ADR 0009). Tier-name rules stay single-string.
- **Reliability is the only filter applied to chain elements.** Context-size, cost, latency — all out of scope. If we want them later, a separate ADR adds a `filter` block; the chain only orders.

## Decision (proposed)

### Schema change

`RouteRule.model` becomes `string | string[]`. An array is interpreted as an ordered chain. Empty array is a linter error (ADR 0009). Non-`/`-containing strings inside an array are linter errors.

```json
{
  "pattern": "(^|\\s)\\/?commit(?:\\s|$)\\b",
  "model": ["opencode/mimo-v2.5-free", "opencode/deepseek-v4-flash-free", "opencode/north-mini-code-free"]
}
```

### Pipeline change

`classification-pipeline.ts:60-70` (the `regex_pre` stage for direct bindings) returns a new classifier result kind: `{ kind: "classified_chain"; chain: string[]; source: "regex" }`. The downstream resolver — currently `resolveTierDisplay` in `commands.ts` and the inline routing in `index.ts` — iterates the chain in order, queries `ReliabilityStore.getCircuitState(key)` for each, picks the first healthy one, and records the rest as filtered candidates in the trace.

A chain with no healthy element falls back to the rule's tier if the rule also names one (it cannot — see "Chain elements are direct refs only" above — so this is unreachable; document it). In practice, a chain with no healthy element falls back to the default tier, same as today's single-binding behaviour.

### Trace integration

`StageTrace.regex_pre` gains a `chain?: readonly string[]` field. Each chain element is a `FilteredCandidate` with reason `circuit_open` / `cooldown` / `missing_from_registry`, except the selected one.

### Backwards compatibility

A string `model` is parsed as a singleton chain `["A"]`, semantically identical to today. No existing config breaks.

## Considered options

### Option A: Inline ordered array (proposed)
Chain is `"model": ["A", "B", "C"]`. Pipeline iterates.

**Pros:** Minimal surface change. Same field. Composes with reliability and trace.
**Cons:** The `model` field name now lies a little (it's a list of models, not "the model"). Could rename to `models` and keep `model` as a deprecated alias.

### Option B: New `chain` field alongside `model`
`"chain": ["A", "B", "C"]`, `"model"` stays for single bindings.

**Pros:** Field names are honest. No type union.
**Cons:** Two fields, mutual exclusion rule, linter work. More config surface.

### Option C: Per-tier fallback tiers in `categoryStrategies`
Instead of adding chains to rules, let `categoryStrategies.frontier` accept `{ "candidates": ["A", "B"] }`.

**Pros:** Centralised fallback per tier.
**Cons:** Wrong scope. The user wants fallback for the *specific* `/commit` rule, not every `frontier` rule. Rejected.

## Consequences

- `schema.json` `RouteRule.model` widens to `string | string[]`.
- `RouteRule.model` in `routing.ts:14-17` widens to the same union; `classify()` returns the raw value; downstream interpretation moves to the resolver.
- `resolveTierDisplay` (`commands.ts`) and the inline routing in `index.ts` share a new helper, e.g. `resolveChain(chain, store, registry): { selected?: string; filtered: FilteredCandidate[] }`.
- Linter (ADR 0009) gains rules: empty chain, non-`/`-containing chain element, chain element not in registry.
- Trace (ADR 0007) records each chain element.
- No new tests for `routing.ts:classify`'s single-binding behaviour; new tests for the chain resolver.

## Implementation gate (if accepted)

- [ ] Widen `RouteRule.model` type in `routing.ts:14-17` and `schema.json:80-94`. Document that array = ordered chain.
- [ ] In `classification-pipeline.ts:60-70`, return a `chain` payload when the matched rule's `model` is an array.
- [ ] Add `resolveChain(chain, store, registry)` helper. Used by both `commands.ts` (for `preview`) and `index.ts` (for routing).
- [ ] Update `resolveTierDisplay` / `commands.ts:handlePreview` to render chain selection and filtered candidates.
- [ ] Update `index.ts` hot path to call `resolveChain` for chain rules.
- [ ] Tests: `routing.test.ts` covers chain parsing; `runtime-reliability` integration test covers chain + circuit-open behaviour; trace integration test (ADR 0007) covers the filtered-candidate record.
- [ ] `npm test`, `npm run typecheck`, `npm run test:ui`, `npm run test:ui:reliability` all green.

## Open questions for reviewers

1. Should chains be limited to direct refs, or should a chain entry be allowed to name a tier (`"model": ["opencode/foo", "frontier", "opencode/bar"]`)? (My read: direct refs only for v1 — a tier name in a chain re-introduces the strategy decision mid-chain and complicates the trace. Defer.)
2. Should the linter (ADR 0009) refuse a chain longer than N to discourage abuse? (My read: yes, warn at N=5.)
3. Should the resolver prefer a chain element that is also a `premium`/`frontier` candidate, or strictly iterate? (My read: strictly iterate. The user wrote the order; we honour it.)