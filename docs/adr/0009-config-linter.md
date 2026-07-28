# 0009 — Config linter

## Status

**Proposed** (2026-07-29). Pending review. Do **not** implement until the design is accepted and the implementation gate is green.

## Context

`validateConfig()` (`config.ts:137-158`) is a runtime error gate: empty `models`, unknown `default`, unknown tier in `categoryStrategies`, bad `cache.threshold`, bad reliability integers, invalid regex. It returns issues that block the extension from starting. It is not a linter — it does not catch the mistakes users make *after* the config parses.

Concrete sharp edges that have already bitten the project:

- **Tier-name typos in `rules`.** A `rule.model` of `"frontier"` passes `validateConfig` because `frontier` exists in `models`. A typo like `"frotier"` is silently ignored — no rule matches the prompt, default tier takes over, user sees "Bifrost didn't route my commit to quick." The ADR 0006 review found this exact class of bug.
- **Classifier `model` not in registry.** The classifier silently fails (`classification-pipeline.ts:94-97`, logs and falls back to regex). User wonders why the classifier never fires.
- **Rule patterns that shadow earlier rules.** A `.*` catch-all at position 5 makes rules 6+ unreachable. Today nothing flags this; the user thinks they have routing they don't.
- **Conflicting strategies.** `categoryStrategies: { "quick": "first" }` on a tier with one model — strategy is meaningless. `largest_context` on a tier with one model — same. Not an error, but a warning worth surfacing.
- **Duplicate rule patterns.** Two rules with the same pattern — the second is unreachable.
- **Direct-rule chain validity.** Once ADR 0008 lands, a chain that mixes tier names and direct refs, or references a model not in the registry, is malformed.
- **Inline override tier that doesn't exist.** `frontier debug this` — `frontier` is a known tier. `fronteer debug this` silently routes to default.

The goal: a single offline command (`/bifrost validate`) that reports these without running probes, calling the classifier, or persisting anything. Distinct from `validateConfig` (runtime error gate) and from `/bifrost debug` (live state inspection).

## Goals

1. `/bifrost validate` runs offline against the current config + model registry. No probes, no classifier calls, no network.
2. Reports are advisory: warnings and errors. Errors block startup only if `validateConfig` already blocks them; linter errors are advisory unless `--strict` is passed.
3. Every check is unit-testable in isolation.
4. Reason text is actionable: tells the user what to change, not just what is wrong.
5. Composes with ADR 0007 — linter output can be a `StageTrace` if helpful.
6. Composes with ADR 0008 — chain rules get their own checks.

## Constraints

- **No new persistent state.** Lint is on-demand.
- **No I/O beyond reading the config files and the model registry.** No probes.
- **No new module boundary.** Live next to `config.ts`; the linter is a config-time concern.
- **No config schema change.** Lint reads the same `BifrostConfig` shape.
- **Reads registry, does not mutate it.** A missing-from-registry chain element is a warning, not an error.

## Decision (proposed)

### Command

`/bifrost validate` — no arguments. Reads `state.config`, `ctx.modelRegistry.getAvailable()`, runs all checks, prints issues.

Optional `--strict` exits non-zero on warnings (for CI use). Default exits zero unless `validateConfig` errors are present.

### Checks

| ID | Severity | Check |
|----|----------|-------|
| L1 | error | `validateConfig` already covers this — re-run and surface in lint output |
| L2 | error | `rule.model` is a string but not a known tier and contains no `/` (typo) — see Note |
| L3 | warning | `rule.model` contains `/` but the `provider/id` is not in the model registry |
| L4 | warning | `classifier.model` (or `classifier[].model`) is not in the registry |
| L5 | warning | Rule pattern shadows every subsequent rule (catch-all like `.*`, `\\b.*\\b`) |
| L6 | info | Duplicate rule pattern (only the first fires) |
| L7 | warning | `categoryStrategies[tier]` is `largest_context` and the tier has one candidate model |
| L8 | warning | `categoryStrategies[tier]` is `random` and the tier has one candidate model |
| L9 | error | ADR 0008 — chain rule mix of tier-names and direct refs (a chain element without `/` is not a direct ref) |
| L10 | error | ADR 0008 — empty chain |
| L11 | warning | ADR 0008 — chain longer than 5 |
| L12 | info | Rule pattern matches an inline-override tier name (e.g. pattern `fronteer` — typo). Bonus, low priority |
| L13 | warning | `models[tier]` array is empty for a tier referenced by `default` or any `rule.model` |
| L14 | warning | `default` tier has zero candidate models after registry resolution |

**Note on L2:** a `rule.model` with no `/` could be a tier name (fine) or a plain typo (error). The check is: if it's not in `models` and not in the registry as `provider/id`, it's a typo. A user could write `"model": "gemini-pro"` hoping the registry has it as `google/gemini-pro` — the linter cannot read minds. L2 reports unknown-tier-name as error; L3 reports unknown-direct-ref as warning. Both are actionable.

### Module shape

```ts
export interface LintIssue {
  readonly id: string;          // L1..L14
  readonly severity: "error" | "warning" | "info";
  readonly message: string;    // actionable prose
  readonly location?: { readonly file?: string; readonly rule?: number };
}

export function lintConfig(
  config: BifrostConfig,
  registry: readonly Model<Api>[],
  opts?: { readonly rulesFilePath?: string },
): LintIssue[];
```

Live in `config-lint.ts`. Each check is a function `(config, registry) => LintIssue[]`. Compose them in `lintConfig`. Tests cover each one independently; one integration test covers the composition.

### Trace integration

Optional and out of scope for v1. The linter prints issues to the UI; a future ADR could expose lint issues via a `StageTrace.lint` entry. Mentioned here only to confirm the design doesn't block it.

## Considered options

### Option A: Standalone `/bifrost validate` command (proposed)
Lives next to `/bifrost debug`. Same config + registry inputs.

**Pros:** Offline, repeatable, CI-friendly. Distinct from runtime validation. Composes with the linter's own unit tests.
**Cons:** One more command.

### Option B: Promote `validateConfig` to do all of this
Move all the L2–L14 checks into `validateConfig`.

**Pros:** One validator.
**Cons:** `validateConfig` is a startup gate; making it slower and more opinionated risks blocking legit configs that the linter would only warn about. The two have different semantics — gate vs advisory. Rejected.

### Option C: External CLI tool
`npx bifrost-lint` shipped separately.

**Pros:** Decoupled from the extension lifecycle.
**Cons:** Two distributions, two version drift problems. The linter must see the same `BifrostConfig` and registry as the runtime, so coupling is correct. Rejected.

## Consequences

- New `config-lint.ts` module and `/bifrost validate` command.
- `commands.ts` gains a `handleValidate` handler.
- Lint output is consumed by `uiResult` (same as `preview`), no new UI primitives.
- No `BifrostConfig` schema change.
- No `commands.ts` changes beyond the new handler and command spec entry.
- Tests for each check in `tests/config-lint.test.ts`; one integration test calling `lintConfig` against a known-malformed fixture.
- If ADR 0008 has not landed, L9–L11 are skipped silently (the chain doesn't exist yet).

## Implementation gate (if accepted)

- [ ] Add `config-lint.ts` with `lintConfig` and `LintIssue`.
- [ ] Implement L1–L8 first (do not block on ADR 0008).
- [ ] Add `handleValidate` in `commands.ts`; wire `/bifrost validate` and `--strict` flag.
- [ ] Render output via `uiResult`; group by severity.
- [ ] Add `tests/config-lint.test.ts` — one test per check, one composition test.
- [ ] Update `README.md` with a `validate` section under "Commands".
- [ ] Update `examples/README.md` with a note on running `validate` against copied recipes.
- [ ] `npm test`, `npm run typecheck`, `npm run test:ui`, `npm run test:ui:reliability` all green.

## Open questions for reviewers

1. Should the linter be allowed to call probes for "is this model reachable?" — i.e. should L3/L4 escalate from warning to error after a probe round? (My read: no — probes are slow; the linter is offline. The `/bifrost probe` command remains the networked check.)
2. Should `--strict` be the default in `npm run release` so cut releases don't ship with lint warnings? (My read: yes, gate the release on lint warnings; separate from `npm test`.)
3. Should L5 (catch-all shadow) be `error` instead of `warning`? (My read: warning for v1 — `.*` rules are legitimate in some configs; we shouldn't block.)
4. Should the linter also inspect `examples/*.json` when run from the repo root? (My read: no — `examples` are templates with placeholder `provider/...` IDs that would all warn. Out of scope.)