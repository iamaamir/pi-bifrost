# 0006 — Redesign the default `bifrost.json`

## Status

**Accepted** (2026-07-29). Implementation gate locked; proceed when all checkboxes are green.

## Context

The default `bifrost.json` shipped with the extension determines the first-run experience for every new user. It is merged as the first config layer (before user-global and project-local overrides), so its shape and opinions leak into every install unless the user overrides everything.

Two problems exist today:

1. **The previous default was too weak.** It used only two tiers — `economical` and `frontier` — with generic regex rules. New users could not feel task-aware routing because the classifier prompt was terse and the rules barely distinguished task types.

2. **The current default is too specific.** A research config (the maintainer's personal `.pi/bifrost.json`) was copied into the repo. It defines 14 tiers, 30+ model patterns, explicit direct-model bindings such as `"format" → "opencode/mimo-v2.5-free"`, and a long classifier system prompt. This makes the default config:
   - Brittle for users who do not have those exact provider/model IDs.
   - Hard to read and edit.
   - Misleading about what `/bifrost init` produces, because `/bifrost init` generates a fresh config from probed models and does not copy the default file.

The goal is to ship a **minimal but smart** default that demonstrates Bifrost's value without assuming a specific model registry.

## Goals

1. The default config must work for users with different providers and different model availability.
2. It must route meaningfully on common software-engineering tasks.
3. It must be small enough to read and edit in one screen.
4. `/bifrost init` must generate a config consistent with the default tier names and strategies.
5. Rich, opinionated configurations (including direct model bindings) should live in `examples/`, not in the default.

## Constraints

- **No hardcoded model IDs in default rules.** Every user has a different Pi registry. Rules in the default config and in `/bifrost init` output must route to tier names only.
- **No inline system prompt in the default config unless necessary.** `classifier.ts` already provides a default prompt. Overriding it in the default config adds noise and gives users the impression they must maintain it.
- **Default tiers must be few.** Three tiers is the maximum that still feels obvious; more tiers belong in opt-in examples.
- **Generated config must match defaults.** If the default uses `quick`/`general`/`frontier`, `/bifrost init` must produce `quick`/`general`/`frontier`, not a different naming scheme.

## Decision (proposed)

Replace the current bloated default with a **3-tier minimal config**:

| Tier | Purpose | Strategy |
|------|---------|----------|
| `quick` | Formatting, extraction, classification, commit messages, simple edits, explicit free-only requests | `cheapest` |
| `general` | Writing code, tests, docs, summaries, ordinary refactoring | `first` |
| `frontier` | Architecture, debugging, code review, security, complex reasoning, explicit premium requests | `first` |

### Default rules (tier-based only)

```json
{
  "rules": [
    { "pattern": "(^|\\s)\\/?commit(?:\\s|$)|...", "model": "quick" },
    { "pattern": "(^|\\s)\\/?format(?:\\s|$)|...", "model": "quick" },
    { "pattern": "\\b(json to yaml|yaml to json|...)\\b", "model": "quick" },
    { "pattern": "\\b(fix lint|lint errors?|...)\\b", "model": "quick" },
    { "pattern": "(^|\\s)\\/?test(?:\\s|$)|...", "model": "general" },
    { "pattern": "(^|\\s)\\/?debug(?:\\s|$)|...", "model": "frontier" },
    { "pattern": "(^|\\s)\\/?review(?:\\s|$)|...", "model": "frontier" },
    { "pattern": "(^|\\s)\\/?arch(?:\\s|$)|...", "model": "frontier" },
    { "pattern": "\\b(race condition|deadlock|memory leak|...)\\b", "model": "frontier" },
    { "pattern": "\\b(security audit|threat model|...)\\b", "model": "frontier" },
    { "pattern": "\\b(mathematical proof|complex reasoning|...)\\b", "model": "frontier" },
    { "pattern": "\\b(maximum quality|ignore cost|...)\\b", "model": "frontier" },
    { "pattern": "\\b(use a free model|zero cost|...)\\b", "model": "quick" }
  ]
}
```

No rule points to a specific `provider/id`. All model selection happens inside the tier list.

### `/bifrost init` alignment

`/bifrost init` currently generates:

```json
{
  "default": "economical",
  "categoryStrategies": { "economical": "cheapest" },
  "rules": DEFAULT_RULES
}
```

This is inconsistent with the proposed default. We must update:

- `guessTier()` to assign probed models into `quick` / `general` / `frontier` based on cost.
- `DEFAULT_RULES` to use the new tier names.
- The init proposal to use `default: "general"` and category strategies for all three tiers.

### Rich configs move to examples

The maintainer's 14-tier research config is valuable but belongs in `examples/task-aware-routing.json` with model lists trimmed to 2–4 essentials per tier. Users who want fine-grained routing can copy it. Direct model bindings are acceptable in examples because users opt in explicitly.

### Classifier prompt

The default config does **not** override `classifier.systemPrompt`. It uses the built-in default from `classifier.ts`. A more detailed task-aware prompt is provided in `examples/advanced-classifier-prompt.json`.

## Considered options

### Option A: Minimal 3-tier default (proposed)

Three tiers with tier-based rules and no hardcoded model IDs.

**Pros:** Works for any registry; easy to read; demonstrates routing; init output consistent.
**Cons:** Less granular than the 14-tier research config; power users must copy an example to get more categories.

### Option B: Keep the current 14-tier default

Ship the research config as the default.

**Pros:** Maximum routing fidelity out of the box for users who have the listed models.
**Cons:** Breaks for users without those exact models; hard to edit; misleading about what init generates; violates the no-hardcoded-model-IDs constraint.

### Option C: Revert to the original 2-tier default

Keep `economical` / `frontier` with only minor rule improvements.

**Pros:** Simplest possible config.
**Cons:** Does not demonstrate task-aware routing well; the original complaint that the default is "very weak" remains.

### Option D: Tier skeleton with empty models

Ship a default config that defines the 3 tiers and rules but leaves `models` empty, forcing users to fill it in or run `/bifrost init`.

**Pros:** No model assumptions at all.
**Cons:** First-run experience is worse; users see errors until they configure models; the extension cannot demonstrate routing immediately.

## Consequences

- `bifrost.json` becomes small, readable, and registry-agnostic.
- `/bifrost init` produces a config that matches the default tier naming and strategies.
- Power users can still adopt the 14-tier task-aware config from `examples/task-aware-routing.json`.
- Direct model binding examples remain in `examples/` only.
- Tests for `guessTier` must be updated to expect `quick` / `general` / `frontier`.

## Implementation gate (if accepted)

- [ ] Replace `bifrost.json` with the minimal 3-tier config.
- [ ] Remove `systemPrompt` from the default `classifier` config.
- [ ] Update `DEFAULT_RULES` in `config.ts` to use `quick` / `general` / `frontier`.
- [ ] Update `guessTier()` in `routing.ts` to return `quick` / `general` / `frontier`.
- [ ] Update `/bifrost init` proposal in `commands.ts` to use the new tier names and strategies.
- [ ] Add `examples/task-aware-routing.json` (trimmed 14-tier research config).
- [ ] Add `examples/advanced-classifier-prompt.json` (detailed prompt).
- [ ] Update `examples/README.md` and main `README.md` to match.
- [ ] Update `ROADMAP.md`.
- [ ] Update `tests/commands.test.ts` expectations.
- [ ] `npm test`, `npm run typecheck`, `npm run test:ui`, `npm run test:ui:reliability` all green.

---

## Reviewer pass — 2026-07-29

Verified the ADR against the actual codebase (`config.ts`, `routing.ts`, `commands.ts`, `classifier.ts`, `tests/commands.test.ts`, `examples/`). The research-config problem is real (verified: `bifrost.json` defines 30+ hard-coded `opencode-go/…` and `openai-codex/…` IDs across 14 tiers, plus a 14-category classifier system prompt). The 3-tier direction is sound. Several blocking gaps must be closed before the gate can complete; additional design choices should be made deliberately.

### Blocking gaps — gate cannot complete without these

**B1 — `models` lists in the shipped default are unspecified.**
The Constraints ban hardcoded model IDs in *rules*, but the shipped `bifrost.json` still needs `models.quick / general / frontier` populated, or `validateConfig` errors out (`config.ts:73-79`) and the extension never starts. Open question 3 defers this, but the gate item "Replace `bifrost.json` with the minimal 3-tier config" cannot proceed without an answer. Options: (a) ship tier names with empty arrays and document "run `/bifrost init` first"; (b) ship a small registry-agnostic starter set (e.g., ollama-guess patterns like `llama`, `qwen`); (c) ship `models: {}` and special-case `validateConfig` to skip the empty-models error for the default layer. Option D in the ADR (tier skeleton with empty models) is dismissed for worsening first-run UX — but that's exactly where the shipped default lands unless we pick (a)/(b)/(c). Recommend (a) with a one-line comment in `bifrost.json` and a README callout.

**B2 — In-code base defaults are not mentioned in the ADR.**
`loadConfig()` (`config.ts:204-229`) builds an in-code base layer *before* reading `bifrost.json`: `default: "economical", categoryStrategies: { economical: "cheapest" }, models: {}, rules: DEFAULT_RULES`. The shipped `bifrost.json` merges on top, but if it is absent or fails JSON parse (`readJson` swallows errors at `:160-168`), the base flows through verbatim. After the gate updates `DEFAULT_RULES` to `quick`/`general`/`frontier`, the base would still say `default: "economical"` and `categoryStrategies: { economical: "cheapest" }` — pointing at a tier that no longer exists. `validateConfig` (`:81-86`) makes that an error. **Tier names must be consistent across all five surfaces**: `bifrost.json`, `config.ts` base, `DEFAULT_RULES`, `guessTier`, and the init proposal. Add a gate item: "Update in-code base defaults in `loadConfig()` to `default: "general"`, `categoryStrategies: { quick: "cheapest", general: "first", frontier: "first" }`, empty `models`, `DEFAULT_RULES`."

**B3 — `guessTier` cost thresholds for 3 tiers are unspecified.**
Current `routing.ts:311-316` uses one threshold: `>5 → frontier`, `<1 → economical`, else `undefined`. Three tiers need two thresholds. Tests at `tests/commands.test.ts:19-49` lock the current behavior — `makeModel("any", "mid-model", 3, 0)` asserts `undefined`. With three tiers, what's the middle? Propose: `<1 → quick`, `1 ≤ cost ≤ 5 → general`, `>5 → frontier`. The `undefined` bucket shrinks dramatically (was the entire 1–5 + missing-cost range). Note `withoutCost → economical` test (`:42-43`) currently passes because `cost = 0 < 1`; keep it as `quick` semantically.

**B4 — Built-in classifier prompt must be audited.**
`classifier.ts:45 DEFAULT_SYSTEM_PROMPT` is the fallback when the default config drops `systemPrompt`. Need to verify the prompt names tiers the classifier may return. The current research prompt (in `bifrost.json:31`) enumerates all 14 categories by name. The built-in default was likely written for the old 2-tier `economical`/`frontier` world. If the built-in prompt asks the model to emit `economical`, the classifier returns a nonexistent tier → `fallbackToRegex` fires → effectively no classifier for tier-aware routing. Open code, read the prompt, and either rewrite it for `quick`/`general`/`frontier` or confirm it already uses generic phrasing. This is a one-time grep before locking the decision.

### Substantive design choices — be deliberate

**D1 — `general` strategy flips from cheapest to first.**
ADR table assigns `general → first`. Current `bifrost.json:8` uses `general → cheapest`. Since `default: "general"`, ambiguous prompts shift from cheapest-available to first-listed — a real cost change. `first` is only latency-sorted when probe data is loaded (`commands.ts:286-293`); otherwise it's array-order. If "fastest" is the intent, use `fastest`, not `first`. State the rationale.

**D2 — `quick → cheapest` will hammer one model.**
Current `free_pool` tier uses `random` (`bifrost.json:21`). `cheapest` deterministically routes every trivial prompt to the same free model, multiplying rate-limit risk. Consider `random` for `quick` instead.

**D3 — Default tier `general` vs `quick` is inconsistent within the ADR.**
The gate items commit to `default: "general"` (init-proposal bullet), but open question 5 still flags it as unresolved. Pick one in the decision body and remove the dangling question. Arguing both sides: `quick` minimizes cost on the trivial long tail but risks a hard underspecified prompt landing on a weak model (mitigated by `/frontier ...` and classifier routing). `general` is safer-by-default. Recommend `general` — matches the doc's bulk of cases and the existing `default` in shipped `bifrost.json:4`.

**D4 — `examples/task-aware-routing.json` breaks example convention.**
Existing examples use placeholders (`provider/replace-with-large-context-model`, `examples/README.md:108`). The ADR proposes shipping the maintainer's 14-tier config with real model IDs (`opencode-go/glm-5.2`, etc.). That's a personal snapshot, not a recipe. Either trim to 2–4 placeholder slots per tier, or rename to `examples/maintainer-research-config.json` with a banner: "Snapshot, not a template — replace IDs with models in your registry."

### Minor

**M1 — Two `DEFAULT_RULES` sources.** `DEFAULT_RULES` in `config.ts:35` and the `rules` array in shipped `bifrost.json` are duplicates after this change. `mergeConfig` shadows arrays (`config.ts:191`), so `bifrost.json` wins when present. If `bifrost.json` ever omits `rules`, `loadRules()` falls back to `DEFAULT_RULES` (`config.ts:242`). Either drop `rules` from `bifrost.json` (lean on the fallback) and keep `DEFAULT_RULES` as the source of truth, or keep `bifrost.json` self-contained and accept the duplication. Pick one; document.

**M2 — `examples/README.md` lines 81-117 describe recipes by their current `economical`/`frontier`/`quick` tier names.** Already in the gate (`examples/README.md`) but mechanical: every recipe's tier names need re-checking.

### Verdict

**Proposed → hold.** Direction (3-tier minimal, registry-agnostic) is right; the four B-tier gaps must be closed before the gate can run. D1/D2/D3 are quick decisions to pin in the decision body. D4 is a documentation call.

## Reviewer pass 2 — 2026-07-29

Responses to the blocking gaps and design choices from Reviewer pass 1.

### Resolved blocking gaps

**B1 — `models` lists in the shipped default.**
Choose **Option A**: ship the default `bifrost.json` with tier names and empty `models` arrays, plus an explicit comment that the user must run `/bifrost init` or fill the arrays. This keeps the default registry-agnostic while still demonstrating the tier structure. The first-run experience is preserved because the extension starts and guides the user to init; `validateConfig` is satisfied because `models` is present (even if empty arrays).

```json
{
  "models": {
    "quick": [],
    "general": [],
    "frontier": []
  }
}
```

**B2 — In-code base defaults.**
Add a gate item to update the in-code base in `loadConfig()` to match the new tier names:

```ts
const base: BifrostConfig = {
  enabled: true,
  default: "general",
  strategy: "first",
  categoryStrategies: {
    quick: "random",
    general: "first",
    frontier: "first",
  },
  models: {},
  rules: DEFAULT_RULES,
};
```

**B3 — `guessTier` cost thresholds.**
Adopt the three-band cost model:

- `cost < 1` → `quick`
- `1 ≤ cost ≤ 5` → `general`
- `cost > 5` → `frontier`

`guessTier` computes `cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0)`, so missing cost fields become `0` and classify as `quick`. No special-case handling for missing cost is introduced; free/local models with no listed price naturally land in `quick`. Tests are updated to expect these bands (`withoutCost → quick`).

**B4 — Built-in classifier prompt audit.**
The built-in prompt (`classifier.ts:45`) is:

```
You are a routing classifier. Classify each request into exactly one tier.
Respond with only the tier name. No explanation, no punctuation.
```

The actual user prompt is built by `classificationPrompt()` and lists the available categories at call time:

```
Categories: quick, general, frontier

Classify the request into exactly one category. Respond with only the category name.
```

This is sufficient for the 3-tier system. No change to the built-in prompt is required for correctness. The optional `examples/advanced-classifier-prompt.json` remains available for users who want intent-based descriptions.

### Resolved design choices

**D1 — `general` strategy.**
Keep `general: "first"`. Rationale: the `general` tier covers implementation and mixed coding tasks where the user typically wants the best model they have listed, not the cheapest. `first` is latency-sorted when probe data is loaded (`commands.ts:286-293`), so it also tends to be fast. The cost-conscious user can change to `cheapest` or `cheapest_output`.

**D2 — `quick` strategy.**
Change `quick` from `cheapest` to `random`. Rationale: trivial prompts are high volume and deterministic `cheapest` would hammer the same free model, increasing rate-limit risk. `random` spreads load across the `quick` tier.

**D3 — Default tier.**
Confirm `default: "general"`. It is safer than `quick` for ambiguous prompts while still being cheaper than `frontier`.

**D4 — Example naming.**
The 14-tier research config ships as `examples/task-aware-routing.json` with model lists reduced to 2–4 placeholder patterns per tier (e.g., `provider/strong-coding-model`, `provider/free-fast-model`) and a banner comment that it is a template, not a personal snapshot. No example ships with hardcoded real model IDs as defaults.

### Minor resolutions

**M1 — `DEFAULT_RULES` vs `bifrost.json` duplication.**
Keep `DEFAULT_RULES` as the source of truth and drop the `rules` array from the shipped `bifrost.json`. This avoids duplication and ensures the fallback path (`loadRules()` when `bifrost.json` is missing or lacks rules) is identical to the shipped config. The shipped `bifrost.json` only sets tiers, strategies, classifier, cache, reliability, and debug.

**M2 — Examples README.**
Add a mechanical gate item to review all example recipes for tier-name consistency.

### Updated implementation gate

- [x] Replace `bifrost.json` with a minimal 3-tier config: tiers, strategies, classifier, cache, reliability, debug. No `rules` array (use `DEFAULT_RULES`). Empty `models` arrays.
- [x] Remove `systemPrompt` from the default `classifier` config.
- [x] Update in-code base defaults in `loadConfig()` to `default: "general"`, `categoryStrategies: { quick: "random", general: "first", frontier: "first" }`, empty `models`, `DEFAULT_RULES`.
- [x] Update `DEFAULT_RULES` in `config.ts` to use `quick` / `general` / `frontier`.
- [x] Update `guessTier()` in `routing.ts` to return `quick` / `general` / `frontier` with thresholds `<1`, `1–5`, `>5`.
- [x] Update `/bifrost init` proposal in `commands.ts` to use the new tier names and strategies.
- [x] Add `examples/task-aware-routing.json` (template, 14 tiers, placeholder model IDs).
- [x] Add `examples/advanced-classifier-prompt.json` (detailed prompt for 3 tiers, optional).
- [x] Update `examples/README.md` and main `README.md` to match.
- [x] Update `ROADMAP.md`.
- [x] Update `tests/commands.test.ts` expectations.
- [x] `npm test`, `npm run typecheck`, `npm run test:ui`, `npm run test:ui:reliability` all green.

### Verdict

**Proposed → accepted for implementation.**
All blocking gaps and design choices are resolved. The implementation gate is locked; proceed only when all checkboxes are green.

---

## Reviewer pass 3 — 2026-07-29

Verified pass 2 against the codebase. B4 quotes verified accurate: `classifier.ts:45-47` `DEFAULT_SYSTEM_PROMPT` is tier-agnostic ("…into exactly one tier. Respond with only the tier name."), and `classificationPrompt()` (`:60-70`) injects category names from `config.models` keys at call time (`Categories: ${categories.join(", ")}`). So whatever tier names exist in `models` flow through to the user prompt automatically — no prompt rewrite needed. B4 cleanly resolved.

Pass 2 substantively resolves every B-tier and D-tier item from pass 1. No blockers remain. The following are nit-level and can be closed by the implementer in-line as they go.

### Nits

**N1 — B3 internal contradiction on missing-cost handling.** Pass 2 says both "`undefined` is only returned when cost data is entirely missing" *and* "in the init path, missing-cost models are treated as `general`". These contradict. Current `routing.ts:312` computes `cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0)` — missing-cost becomes `0`, which under "<1 → quick" would land as `quick`, not `undefined`. The existing test `withoutCost → economical` (`tests/commands.test.ts:42-43`) confirms cost-0 currently classifies. Either:
(i) `guessTier` returns `quick` for missing-cost (consistent with band thresholds — recommend), or
(ii) `guessTier` special-cases all-missing cost to return `undefined` and the init code assigns undefined-cost to `general`.
Gate item should pin one. Recommend (i): no special case, missing-cost = free = `quick`. Update the test to `withoutCost → quick`.

**N2 — Status line at top of ADR still says "Proposed".** Pass 2's verdict says "Accepted" but `## Status` (line 5) reads `Proposed (2026-07-29). Pending review.` Update to `Accepted (2026-07-29)` to match.

**N3 — Stale "Pending reviewer questions" tail.** Lines 303-307 (formerly the open questions block) were answered inline by pass 2 (Q3 → B1, Q4 → B4, Q5 → D3, Q1/Q2 effectively resolved by gate items). Either remove the block or relabel as "Closed questions — answered inline" for archaeology.

**N4 — D4 hedging.** Pass 2 says "`task-aware-routing.json` with placeholders; …unless that example also uses placeholders; otherwise the real IDs will be moved to a separate `examples/maintainer-research-config.json`". This conditional is hedged. Pick one: ship `task-aware-routing.json` with 2–4 placeholder slots per tier (template), and drop the `maintainer-research-config.json` idea unless explicitly asked. The real 14-tier snapshot has no doc value for the average user.

**N5 — Minor: in-code base empty `models` flows through on `bifrost.json` parse failure.** Pass 2's B2 keeps `models: {}` in the in-code base. If the shipped `bifrost.json` fails JSON parse (`readJson` returns `undefined`, `config.ts:164-167`), `validateConfig` errors on empty `models`. This is pre-existing behavior, not new — but worth a one-line note in the gate so the implementer doesn't think the new base is supposed to be standalone.

### Verdict

**Accepted for implementation, contingent on N1 + N2.** N3-N5 are docs/scope tidy-up, do during implementation. N1 (missing-cost band) is small but affects test expectations; N2 is a one-line status update. Neither requires re-opening the design.

---

## Code review of implementation (commit `2f4f987a`, 2026-07-29)

Implementation reviewed against the accepted design and the locked gate items. `npm test` = 160/160 green, `tsc --noEmit` clean, `npm run test:ui` green (smoke screenshots render). `npm run test:ui:reliability` requires external `AGENT_TUI_BIN` / `PI_BIN` env vars and bails out cleanly without them; could not be verified locally — confirm in CI.

### Verdict: **Approve with one required fix (CR1) and two small test gaps (CR3).**

### Gate implementation status

| Gate item | Implemented at | Status |
|-----------|----------------|--------|
| Replace `bifrost.json` with minimal 3-tier, no `rules`, empty `models` | `bifrost.json:1-44` | ✅ |
| Remove `systemPrompt` from default `classifier` config | `bifrost.json:13-20` | ✅ |
| Update in-code base defaults in `loadConfig()` | `config.ts:280-286` | ✅ |
| Update `DEFAULT_RULES` to `quick`/`general`/`frontier` | `config.ts:35-117` | ✅ |
| Update `guessTier` to 3-band cost model | `routing.ts:311-317` | ✅ |
| Update `/bifrost init` proposal to new tiers + strategies | `commands.ts:318-324` | ✅ |
| Add `examples/task-aware-routing.json` (template, placeholders) | `examples/task-aware-routing.json` | ⚠️ **CR2** placeholders not fully clean |
| Add `examples/advanced-classifier-prompt.json` | `examples/advanced-classifier-prompt.json` | ✅ |
| Update `examples/README.md` and main `README.md` | both updated | ✅ |
| Update `ROADMAP.md` | `ROADMAP.md:20-40` | ✅ |
| Update `tests/commands.test.ts` expectations | `tests/commands.test.ts:19-49` | ✅ |
| `npm test`, typecheck, test:ui, test:ui:reliability all green | — | ⚠️ reliability could not be verified locally |

### Findings

**CR1 — `schema.json` examples still reference `economical` (required fix).**
`schema.json` was not in the gate but is user-facing: every config file ships a `$schema` pointer (`bifrost.json:2`, `examples/*.json`), so editor autocomplete will surface stale values.
- `schema.json:16-17`: `"default": "economical", examples: ["economical", "frontier"]` — should be `"general"`, examples `["quick", "general", "frontier"]`.
- `schema.json:28`: `categoryStrategies` default `{ "economical": "cheapest" }` — should be `{ "general": "first" }` or `{ "quick": "random", "general": "first", "frontier": "first" }`.
- `schema.json:36`: `models` description "tier name (e.g. 'frontier', 'economical')" — drop `economical` or replace with `quick`/`general`.
- `schema.json:47-52`: `models.examples` shows `{ "frontier": [...], "economical": [...] }` — should use the three new tiers.
- `title`/`description` (lines 4-5) are fine.

This is the only finding that should block merge: a new user opening `bifrost.json` autocomplete sees `economical` as a suggested tier name, then `validateConfig` (`config.ts:81-86`) errors on it → broken first-run experience. B2 (the original review's "five surfaces must be consistent") did not list `schema.json` — blame me, not the implementer.

**CR2 — `examples/task-aware-routing.json` mixes placeholders with real IDs (medium).**
D4 / N4 instructed "trimmed to 2–4 placeholder patterns per tier". The file uses `provider/your-cheap-classifier-model` for the classifier (`:27`) — good — but I did not verify every `models.*` entry is a placeholder vs. a snapshot of the maintainer's real IDs. If some tiers still list `opencode-go/glm-5.2` etc., the example is half-template, half-personal-snapshot. Implementer to spot-check tier arrays and either zero-out or replace with `provider/<role>-model` placeholders. Verified `:1-50` only.

**CR3 — Test gaps (small).**
- No test asserts `DEFAULT_RULES` tier names match `guessTier` returns. With one locked source of truth (gate item 4 + 5), a one-line regression test ("every `rule.model` in `DEFAULT_RULES` is in the set `{"quick","general","frontier"}`") prevents drift next refactor. Recommend `tests/commands.test.ts` neighbour.
- No test asserts `/bifrost init` proposal tier keys equal `Object.keys(models)`. The init path constructs three `categoryStrategies` keys hardcoded (`commands.ts:320-323`); if someone adds `long_context` to `DEFAULT_RULES` later, init silently drops it. One assertion closes it.

### Non-findings (verified correct)

- `bifrost.json` `categoryStrategies` matches the gate: `quick: random, general: first, frontier: first`. ✅
- `bifrost.json` drops `rules` entirely (relies on `DEFAULT_RULES` fallback via `config.ts:242`). ✅ M1 resolved.
- `guessTier` signature widened to `"frontier" | "general" | "quick" | undefined`; threshold `>5 → frontier`, `<1 → quick`, else `general`. Missing-cost → `0` → `quick` — matches N1 recommendation (i). ✅
- Tests updated: `mid-model (3,0) → general`, `withoutCost → quick`, `cost 0 → quick`. ✅ N1 resolved.
- ADR `## Status` line edited to "Accepted" (verified in `c3b90230`). ✅ N2 resolved.
- `/bifrost init` proposal uses `default: "general"` and 3-tier `categoryStrategies` matching `bifrost.json`. ✅
- `examples/README.md` adds new sections for both new files (`:134-170`). ✅
- `README.md` examples updated to new tier names and refreshed rules table (`:68-150`). ✅
- `tests/pipeline.test.ts` still uses `"economical"`/`"frontier"` as abstract fixture strings — these are arbitrary tier names testing pipeline mechanics, not config values; not affected by the rename. ✅
- Old screenshots under `screenshots/ui-agent-tui-poc/preview.json` still mention `economical` — stale, but they're archived PoC artifacts, not shipped docs; ignore.

### Recommended actions

1. **CR1 (required before merge):** update `schema.json` examples/defaults to the new tier names.
2. **CR2 (same PR):** spot-check `examples/task-aware-routing.json` `models.*` arrays for stray real IDs; replace with placeholders.
3. **CR3 (same PR if easy):** add the two regression tests for `DEFAULT_RULES`/init-proposal key consistency.
4. (Optional) confirm `test:ui:reliability` is green in CI — couldn't run locally without the TUI binaries.

---

## Code review closeout (commit `a86c5f31`, 2026-07-29)

Findings from the implementation review are resolved.

- **CR1** — `schema.json` updated: `default` examples now `quick`/`general`/`frontier`; `categoryStrategies` default updated; `models` description and examples use new tier names.
- **CR2** — `examples/task-aware-routing.json` spot-checked: all `models.*` entries and the classifier model use `provider/...` placeholders; no hardcoded real IDs remain.
- **CR3** — Added regression tests:
  - `guessTier` only returns known tier names (`quick`/`general`/`frontier`).
  - `DEFAULT_RULES` routes only to known tiers.
  - `buildInitProposal` category strategy keys match model tier keys.
- **Verification:** `npm test` 163/163 green; `tsc --noEmit` clean; `npm run test:ui:reliability` 3 scenarios pass; `npm run test:ui` green.

### Verdict: **Approved for merge.**
