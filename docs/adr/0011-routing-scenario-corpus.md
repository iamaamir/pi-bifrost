# 0011 — Versioned routing scenario corpus

## Status

**Proposed** (2026-07-28). Pending review. Do **not** implement until the design is accepted and the implementation gate is green.

## Context

Bifrost has 165 unit tests, most covering mechanics (config parsing, cache I/O, reliability state transitions, classifier invocation) and integration plumbing (pipeline wiring, command handlers). These catch implementation bugs well. They do not answer:

- Did this prompt route to the expected tier under the default rules?
- Did a config override or mode change alter the route as promised?
- Did circuit state change candidate selection as promised?
- Did a low-confidence classifier result produce predictable fallback behaviour?

Without a versioned scenario corpus, every rule change, classifier prompt tweak, or reliability-policy adjustment risks subjective regressions. A maintainer changing the default regex from `\bdebug\b` to `\b(debug|troubleshoot)\b` cannot tell whether the change affects unrelated prompts without manually testing each one. A reviewer of that PR cannot tell which prompts were tested.

The competitive analysis (sections 4.7, 9) identifies this as Priority 0 and seeds 11 scenarios. Downstream ADRs — confidence thresholds (ADR 0010), failure taxonomy, fallback chains (ADR 0008) — each need a corpus to validate against before they can be safely shipped.

The gap is not just "we need more tests." The gap is a **versioned, structured set of expected routing outcomes** that survives refactoring, survives config changes, and makes routing-regression rate measurable (measurement-plan metric from competitive analysis §9).

## Decision

### 1. Scenario format

Each scenario is a structured record:

```
{
  id: number;
  description: string;
  prompt: string;
  config?: Record<string, unknown>;
  reliabilityState?: Array<{ model: string; circuit: "closed" | "open" | "half_open"; cooldownUntil?: string }>;
  expected: {
    tier: string;
    source?: "inline_override" | "cache" | "classifier" | "regex_rule" | "default";
    model?: string;
    fallbackReason?: string;
  };
}
```

- `id` — sequential numeric (e.g. 1001). Non-semantic. Never reused.
- `description` — human-readable, written for reviewers and regression triage.
- `prompt` — the user message that enters the pipeline.
- `config` — optional config overlays applied on top of the default config for this scenario. If absent, the default config is used as-is.
- `reliabilityState` — optional pre-seeded reliability state for the fake store. If absent, all circuits are closed.
- `expected` — the minimally sufficient assertion:
  - `tier` — the tier name the pipeline must select.
  - `source` — the pipeline stage that produced the classification. Omit if the test only cares about the resulting tier.
  - `model` — the exact model selected. Omit unless the scenario asserts a specific binding.
  - `fallbackReason` — present only when the scenario asserts a fallback path occurred. Omit if no fallback is expected.

Scenarios reference but do not depend on specific provider/model availability. The runner uses a **deterministic fake model registry** with a fixed set of model IDs and tier patterns, not the host's live `pi model list`. This keeps scenarios portable across machines, CI environments, and provider-outage windows.

### 2. Seed scenarios

Formalised from the competitive analysis §9 seed, plus three additional scenarios identified during ADR drafting (low-confidence classifier, invalid override, zero-candidate pattern). All 14 scenarios use the fake registry.

#### Tier classification

| ID | Description | Prompt | Expected tier | Notes |
|---|---|---|---|---|
| 1001 | Short lookup routes to cheapest tier | `"list files in cwd"` | `quick` | Default rules route `quick` for short queries |
| 1002 | Implementation prompt routes to general tier | `"write a function that merges two sorted arrays"` | `general` | No strong frontier signal in prompt |
| 1003 | Architecture/security prompt routes to frontier | `"design a capability-based auth system for a distributed file store"` | `frontier` | Strong frontier signal |

#### Override behaviour

| ID | Description | Prompt | Expected assertion |
|---|---|---|---|
| 1004 | Explicit tier override wins over classifier | `"/quick implement a red-black tree"` | `expected.tier = "quick"`, `expected.source = "inline_override"` |
| 1005 | Invalid inline override tier is ignored | `"/turbo implement a red-black tree"` | Pipeline proceeds to classifier/regex without error, `expected.source !== "inline_override"` |
| 1006 | Direct model rule attempts binding before falling back | `"deploy the release"` (with rule matching to `opencode/mimo-v2.5-free`) | Model `opencode/mimo-v2.5-free` is tried first; if circuit-open, expected fallback tier resolves |

#### Circuit behaviour

| ID | Description | Prompt | Expected assertion |
|---|---|---|---|
| 1007 | Requested-tier circuit open selects next eligible | Architecture prompt, `frontier` tier; set `opencode/claude-opus-4` circuit = open | `expected.tier = "frontier"` (next `frontier` candidate selected), OR falls to `default` only if all frontier candidates are open |
| 1008 | All circuits in every tier are open | Architecture prompt; all models in all tiers circuit = open | `expected.fallbackReason = "all_tiers_exhausted"`, no model selected |
| 1009 | Model pattern resolves to zero candidates | Config has a tier pattern `^nosuchmodel-\d+$` that matches nothing in the fake registry | `expected.tier = "default"`, pipeline logs advisory for the empty tier |

#### Reliability effects

| ID | Description | Prompt | Expected assertion |
|---|---|---|---|
| 1010 | Quota error on a model is recorded; next prompt avoids it | First prompt routes to model X; inject quota failure via reliability store; second prompt for same tier | First: failure recorded as quota. Second: model X is skipped; next eligible candidate selected |
| 1011 | Stream failure after output is recorded without replay | Stream produces partial output then fails; prompt classifies to same tier again | Failure recorded after settlement; second routing does NOT replay — model X may be circuit-open or the candidate set is unchanged |
| 1012 | Low classifier confidence falls through to regex | Classifier returns `"general:0.3"` (below `minConfidence: 0.6`); prompt contains `\bdebug\b` which matches `frontier` regex rule | `expected.tier = "frontier"`, `expected.source = "regex_rule"`. Trace records classifier attempt with `downgrade: true` |

#### Config and init

| ID | Description | Prompt | Expected assertion |
|---|---|---|---|
| 1013 | Missing tier from config defaults only to populated tiers | Config has `tiers: { frontier: [...], quick: [...] }` but no `general` | Default tier reference resolves to first populated tier (`quick` or `frontier` depending on default config). Pipeline does not crash |
| 1014 | Context-too-large produces advisory warning | Prompt is padded > context of the cheapest eligible candidate | Pipeline selects the candidate but records an advisory warning. (Context filtering is optional in v1; the scenario asserts the warning exists, not that the model is excluded.) |

### 3. Runner design (conceptual)

The runner is a function, not a binary or a plugin:

```
runScenario(scenario, { registry, config, reliabilityStore }): ScenarioResult
```

- `registry` — a fake model registry initialised per-run with a fixed model set (e.g. `opencode/mimo-v2.5-free` at $0.15/Mtok, `opencode/deepseek-v4-flash-free` at $0.30/Mtok, `opencode/claude-opus-4` at $15/Mtok).
- `config` — the default bifrost config with scenario-specific overlays applied via deep merge.
- `reliabilityStore` — an in-memory fake store that can be pre-seeded with circuit state and accepts failure/settlement events.

The runner constructs the pipeline in the same way `index.ts` does, runs the prompt through it, and asserts against the resulting `ClassificationResult` (or `RoutingDecisionTrace` per ADR 0007). Assertions are deep-match on expected fields; unexpected fields are ignored so scenarios survive trace-structure additions.

**Runnable everywhere:**
- Invoked directly in unit tests as `runScenario(scenario)`.
- Invoked as a bulk gate via a script that loads all active scenarios, runs each, and exits nonzero on any failure.
- Does NOT require a live Pi host, a network connection, or a classifier endpoint — the classifier stage can be replaced by a mock that returns a configurable result.
- Scenarios that specifically test the real classifier use the fake registry but may optionally exercise the real classifier call if a classifier endpoint is configured. Those scenarios are tagged `needsClassifier` and excluded from the default CI gate.

**Comparison with existing tests:**
`tests/pipeline.test.ts` already tests the pipeline with mocked classifier and mock registry. The scenario corpus differs in four ways:

1. **Versioned.** A corpus version number lives in the scenario directory manifest. Changing an expected assertion bumps the version. Existing tests are not versioned.
2. **Self-documenting.** Each scenario carries a `description` field written for human reviewers. Existing tests have `it("does X")` strings that describe implementation, not routing intent.
3. **Bulk-runnable.** The corpus has a single entry point: `runAllScenarios(version?)`. No need to know which test file covers which routing case.
4. **Config-aware.** Each scenario carries `config` and `reliabilityState` overlays. Existing tests set up config inline in `beforeEach` blocks — hard to audit which scenarios use which config.

### 4. Evolution rules

- **Adding a scenario is a PR, not an ADR.** New routing features, new reliability states, new config knobs — each gets at least one scenario. The PR description must list the scenario IDs added.
- **Changing an expected assertion requires documented rationale in the PR description.** If a classifier prompt change makes scenario 1003 route to `general` instead of `frontier`, the PR must explain why the new behaviour is correct. A reviewer can spot subjective regressions.
- **Deprecating a scenario** removes it from the active set (the runner skips it) but preserves the record in the corpus directory. Deprecated scenarios carry a `deprecated: true` field and a `deprecatedReason` string. Never delete a scenario record.
- **Corpus version bumps** happen on backward-incompatible assertion changes to one or more scenarios. The version is a single integer in `corpus/VERSION`. The runner can assert against a specific version (`runAllScenarios(2)`) to support branch-based development where the main branch corpus is ahead of the feature branch.
- **Scenarios are additive by default.** A new scenario does not need a version bump. Only changing or removing an existing scenario's expected field does.

### 5. What NOT to do

- **Do not couple to a specific test runner.** The scenario format is JSON-compatible data, not Jest/Vitest assertions. The `runScenario` wrapper adapts to the runner — Jest `expect()` in unit tests, exit-code in CI gate.
- **Do not require live provider connections.** The fake model registry is the default. A scenario may opt into real classifier calls only when explicitly tagged; the CI gate does not require network.
- **Do not make scenario IDs semantic.** IDs are sequential. No `"short-lookup"` or `SC_SHORT_LOOKUP`. Semantic strings drift from the code; numbers are reviewable in PRs. Maintain a `corpus/index.json` map from ID to description for grepping.
- **Do not embed scenario corpus in production config.** `bifrost.json` carries config, not scenarios. The corpus lives in `tests/corpus/` alongside the runner. Production code never imports a scenario.
- **Do not assert on trace rendering (string format).** Assert against structured trace fields, not the `/bifrost preview` output. The rendering can change without invalidating scenarios.

### 6. Corpus directory layout (illustrative)

```
tests/
  corpus/
    VERSION              # integer, currently 1
    scenarios.json       # Array<ScenarioRecord>, the active set
    deprecated.json      # Array<ScenarioRecord> with deprecated: true
    index.json           # { "1001": "Short lookup routes to cheapest tier", ... }
    runner.ts            # runScenario, runAllScenarios
    fake-registry.ts     # deterministic model set and tier resolution
```

## Consequences

### Positive

- **Regression detection.** A rule or classifier change that alters an expected route is caught in the same PR, not weeks later when a user complains.
- **Reviewer confidence.** A PR that touches `classification-pipeline.ts` can point to the scenario run as evidence that existing routes still work.
- **Measurable routing regression rate.** Competitive analysis §9 defines "routing regression rate: expected scenario route changed unintentionally" as a core metric. The corpus makes this measurable — zero regressions on a corpus run means the rate is 0 for that commit.
- **Downstream ADR validation.** ADR 0008 (fallback chains), ADR 0010 (classifier confidence), and future reliability-policy ADRs each get a set of scenarios added to validate their behaviour. The corpus becomes the shared proof surface.
- **Onboarding.** A new contributor can read `scenarios.json` and understand what routing outcomes the project considers correct, without tracing through test setup code.

### Negative

- **Corpus maintenance burden.** Scenarios must be updated when default config, default rules, or tier names change. If the maintainer forgets, the corpus becomes a source of false-positive failures. Mitigation: the `VERSION` bump rule makes intentional changes explicit; spurious failures are caught at CI review.
- **Seed size is modest.** 14 scenarios do not cover every edge case. But the corpus is designed to grow additively — each new feature's PR adds its own scenarios. The initial seed is a foundation, not a complete set.
- **Fake registry drift.** If the real model registry (e.g. `opencode/deepseek-v4-flash-free` changes cost or is removed), the fake registry stays unchanged until scenarios explicitly need the new data. Mitigation: the fake registry is documented in `fake-registry.ts` with a comment noting last sync date. A periodic maintenance task cross-checks fake entries against the real pi registry.

### Migration and backwards compatibility

- No migration needed — the corpus is new, not replacing anything. Existing tests continue to pass unchanged.
- Scenario IDs start at 1001 (not 1) to avoid confusion with ADR numbers.
- The first corpus version is 1. Version bumps are integers, not semver — no patch/minor/major distinction for a test artifact.
- No changes to `bifrost.json`, `schema.json`, or any production source file.
