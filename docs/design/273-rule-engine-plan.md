# #273 rule module — implementation plan

**Status: approved 2026-11-26 with owner adjudication; implementation candidate.**
The owner accepted the five Crux corrections in section 2 and approved the `safety.ts`
seam as `verifyRulePatterns` + `isPatternAccepted`, keeping the structural scanner
private. This document is the approved delivery contract for issue #273. It does not
authorize tooling redesign, configuration changes, new dependencies or a merge.

The five Crux corrections are ACCEPTED and folded into this contract (section 2). They
do not authorize redesigning the safety engine, verdict cache, probe protocol, SDK,
mutation infrastructure or module architecture.

- Delivery revision: `a624026d9b7c01d6336a5aea438608669eff3c81` (`origin/main`, the #272
  merge commit "fix(routing): restore the published selectModel signature").
- Worktree: `.worktrees/rule-engine-273`, branch `feat/273-rule-engine`, clean at the
  revision above.
- Evidence date: 2026-11-26, probe output captured from that tree.
- Reused prerequisite: issue #351 / PR #352 (module-aware tooling) and issue #272 / PR #354
  (`modules/strategies/`), both merged. Their tooling conclusions are reused, not
  re-researched.

## 1. Decision summary

Extract route-rule compilation, compiled matching, the deprecated per-call matcher, and the
regex safety engine from `routing.ts` into one adopted capability, `modules/rules/`, with a
public behavior file, one internal security file, no barrel, no new dependency, no plugin
or registry, no configuration field and no lifecycle change.

Routing keeps rule discovery and precedence, tier resolution, eligibility, reliability,
economics, affinity, fallback, scope and dispatch. The new module owns only: giving a
configured rule its compiled form, deciding whether a pattern is safe to run, and matching
text against the already-compiled set.

The safety engine is the reason this is not a cosmetic split. It is an out-of-process
canary probe plus a textual superlinear-shape scan: heuristic defenses that must keep
their fail-closed handling of unverifiable patterns, must describe themselves as
heuristics rather than a safety guarantee, must keep running under a pinned Node binary,
and must never run on the per-message path. The capability becomes the single documented
effect authority allowed to spawn a child process during compilation.

## 2. Crux challenge corrections and adjudication

The independent Crux challenge accepted the two-file capability boundary, the compatibility
approach, the test ownership and the mutation target expansion, and required five
corrections. All five are **ACCEPTED** and folded into this contract; none reopens the
design.

| # | Correction | Disposition and where it lands |
| --- | --- | --- |
| 1 | Describe the existing checks as heuristic defenses, not a universal safety guarantee; preserve the implementation. | ACCEPT. The contract states what the scan and the probe can and cannot claim, and the module docs repeat it. No code change is authorized. |
| 2 | Record the pre-existing SDK effect-contract discrepancy; preserve existing effects; defer broader SDK policy changes. | ACCEPT. The verified contradiction and the deferral are recorded; the extraction moves the effects and neither adds nor advertises new ones. |
| 3 | Verify meaningful direct mutation bindings for both module files; no artificial imports; isolate potentially blocking regex fault controls inside bounded processes. | ACCEPT. The binding evidence, the expected binding set and a binding red control are fixed in the mutation section; the two match-executing cases move inside bounded children. |
| 4 | Preserve and verify partial verdict handling, timeout rejection, continuation of remaining patterns and malformed-stream rejection. | ACCEPT. The exact decode rules are written down, three stub-probe controls are added, and the fault controls cover short, malformed and timed-out streams. |
| 5 | Use the existing architecture tooling to verify the capability boundary while permitting the legitimate subprocess dependency. | ACCEPT. The verification plan requires the architecture edge-set evidence; no architecture rule is added, widened or taught to ignore the module. |

Explicitly out of scope for this revision, per the challenge: redesigning the safety engine,
the verdict cache, the probe protocol, the SDK, the mutation infrastructure or the module
architecture.

### Unresolved evidence for owner adjudication

| Item | Why it is unresolved | What resolves it |
| --- | --- | --- |
| SDK wording vs construction-time probe | `docs/router-api.md` says the SDK never reads environment variables; the verified construction path does. Correcting the wording is an SDK policy change, so it is deferred. | Owner chooses a follow-up issue for the wording, or accepts the discrepancy until a later SDK revision. |
| Mutation budgets for the two new targets | No dry run exists yet, and a budget constant must come from a measurement, not a guess. | First `--dry-run` plus one focused run after approval; work stops if the wall-clock envelope is breached. |
| Binding files for the new targets | Bindings exist only once the files and their tests exist; the expected set is asserted, not yet observed. | `--dry-run` binding inventory at the implementation head, captured verbatim. |
| `routing.ts` estimate after extraction | The target loses the rule mutants, so the recorded 1000 is stale. | Re-measure with `--dry-run`, then write `MUTANT_ESTIMATE` from the output. |
| Internal `safety.ts` seam | A meaningful direct mutation binding needs `safety.ts` to export something, so the diff is not a pure move. | RESOLVED: owner approved `verifyRulePatterns` and `isPatternAccepted` only; the structural scanner stays module-private. |
| Match-executing test shape | Two moved cases compile and match a pattern that verification would reject; a mutant can remove the bound. | Run their compile-and-match step in a bounded child process; assertions unchanged. |
| Architecture rule scope | `router-no-runtime-host-sdk` and `router-no-host-adapters` key on `router.ts` only, while the module is reachable from the SDK. | Edge-set evidence covers this change; extending the rule scope is a separate tooling decision. |

## 3. Reconciled research

Reconciled at `a624026`; no claim below is inherited unverified from the issue text.

| Research claim | Current state |
| --- | --- |
| The whole rule engine lives in `routing.ts` | Confirmed. `RouteRule` at line 57, deprecated `classify` at 816, `CompiledRule` at 831, safety engine and probe at 838–1067, `compileRules` at 1069, `classifyCompiled` at 1084. `routing.ts` is 1109 lines; the moved span is roughly 275 lines. |
| Rule discovery and route-file precedence are separate | Confirmed: `config-load.ts` `loadRules` (438–453) applies `.bifrost/bifrost-routes.json`, then `bifrost-routes.json`, fails closed on a malformed override, then falls back to `config.rules` and `DEFAULT_RULES`. `DEFAULT_RULES` (16 entries) lives in `config.ts`. |
| Compilation happens once per pipeline, not per message | Confirmed: `classification-pipeline.ts:427` compiles inside `createPipeline`; `index.ts:946` rebuilds the pipeline only when config generation, classifier enablement or backend changes. `router.ts:667` builds one pipeline per router process. |
| Matching is pure and cheap | Confirmed by probe: 2000 matches of one compiled rule in 0.3 ms, zero child processes. |
| Verdicts are cached process-globally | Confirmed: `const patternVerdicts = new Map<string, boolean>()`, keyed by pattern text, `true` = rejected, `false` = verified safe, never evicted. The cache is what makes a rejection log once per process and a recompile spawn nothing. |
| Consumers | `classification-pipeline.ts` (compile once, `classifyCompiled` at 530 and 624, exposes `rules`/`compiledRules`/`matchRule`), `config-agent.ts:40` (`compileRules` for the live-probe plan), `scripts/jev-benchmark.ts:4` (both functions), `config.ts:5` and `config-load.ts:11` (`type RouteRule`). `index.ts` and `router.ts` read only the pipeline surface. |
| No other runtime owner | Confirmed: `routing.ts` is the only file importing `node:child_process` for this purpose; `spawnSync` appears only in the probe call sites (1041, 1045). |
| Root test globs would not pick up nested tests | Superseded by #351: full, coverage, quick and acceptance suites include module globs. Not re-researched. |
| Tooling omits nested module paths | Superseded by #351 for Knip, complexity scope, dep-cruiser, AST, duplication, mutation discovery and packaging. Not re-researched. |
| Mutation bindings derive from tests that import the target | Confirmed: `mutation/targets.mjs` `directConsumers()` resolves relative imports, so module tests bind automatically and an unbound target throws. |

## 4. Prerequisite verification

| Concern | Verified evidence at `a624026` |
| --- | --- |
| Typecheck | `tsconfig.json` include covers `modules/**/*.ts` |
| Full / coverage / quick / acceptance | module test globs already included (#351) |
| Knip | module runtime is in `project`; only spawned module tests are `entry` |
| Complexity | `scopeOf` maps `modules/<cap>/tests/` to `tests` and other `modules/` files to `source` |
| Architecture / AST | dep-cruiser production root and toolbox scope include `modules/` |
| Mutation | `allTestFiles()` includes `modules/<cap>/tests/*.test.{ts,mjs}`; `directConsumers()` resolves the import graph |
| Packaging | `package.json` `files` ships `modules/**/*.ts`, excluding `tests/` and `*.test.ts` |
| Router build | `scripts/build-router.mjs` compiles `tsconfig.router-build.json`; the program graph emits nested modules without a hand-maintained entry list (verified for `modules/strategies/selection.ts` in #272) |
| Docs | `tests/docs-links.test.mjs` covers module `README.md` and `AGENTS.md`, and skips module `tests/` |
| Path contract | executable module tests must be direct children of `modules/<capability>/tests/`; dot-prefixed directories are not discoverable |

One prerequisite is *not* inherited: the new mutation targets need a first dry run before a
budget is written down. See section 10.

## 5. Verified behavior (captured, not transcribed)

A throwaway probe (kept outside the repository) imported `routing.ts` and `config.ts` with
`node --experimental-strip-types`, pointed `BIFROST_PROBE_NODE` at a wrapper script that
appends one byte per spawn and then execs the hosting binary, and recorded:

```
compile-fresh-pattern: kept=1 ms=326 spawns=1
match-2000: hits=2000 ms=0.3 spawns=0
recompile-cached: spawns=0
[bifrost] rejecting rule pattern with unbounded backtracking or unverifiable safety: "^(w+)+$"
classify-fresh-catastrophic: result=undefined spawns=0
rejected-pattern-diagnostics: count=1
default-rules: configured=16 kept=16 ms=29 spawns=1
default-rules-match: hit=frontier miss=undefined
```

Readings that shape the contract:

- A fresh benign pattern costs one child process; the same patterns again cost zero,
  because the verdict is cached by pattern text.
- A catastrophic nested-quantifier pattern is rejected by the textual scan *before* any
  spawn, so the defense does not depend on the probe being reachable.
- Two compiles of the same rejected pattern log exactly one diagnostic.
- Matching is a pure in-process regex test; the 2000-match loop spawned nothing and cost
  0.3 ms.
- The 16 default rules keep their model mapping (`review this pull request` → `frontier`).

The absolute compile latency is host-dependent (first spawn pays process startup, a warm
batch does not). This plan claims only the shape: spawns occur in compilation, never in
matching, and repeat compilations of known patterns do not spawn.

## 6. Contract to preserve

Moved verbatim in behavior; the only structural change is the internal export seam
described in section 7. Public surface, re-exported from `routing.ts` for
compatibility:

```ts
export interface RouteRule {
  pattern: string;
  model: string;
}

export interface CompiledRule {
  readonly re: RegExp;
  readonly model: string;
}

export function compileRules(rules: readonly RouteRule[]): CompiledRule[];
export function classifyCompiled(text: string, rules: readonly CompiledRule[]): string | undefined;

/** @deprecated Production uses `compileRules` + `classifyCompiled`. */
export function classify(text: string, rules: readonly RouteRule[]): string | undefined;
```

Behavior invariants:

- Rules are matched in configured order; the first rule whose pattern matches wins,
  regardless of where in the text it matches. No combined or reordered regex.
- Compilation drops a pattern that is not a valid `RegExp` (case-insensitive) and logs
  `[bifrost] invalid regex "<pattern>": <error>` at compile time.
- Compilation drops a pattern the safety engine rejects and logs
  `[bifrost] rejecting rule pattern with unbounded backtracking or unverifiable safety:
  "<pattern>"` once per process per pattern text.
- An empty rule list compiles to an empty list; a match miss returns `undefined`.
- The deprecated `classify` constructs and verifies per call, uses only verified rules, and
  is covered by parity tests. It stays exported and deprecated; no new caller may adopt it.

Safety defenses — heuristic, not a guarantee:

The engine is a risk-reduction gate, not a proof. It can reject a pattern that is safe and it
can accept one that is slow on the real prompt; what it must not do is run a pattern the
verifier could not judge. Module documentation, code comments and review language keep that
distinction and never call an accepted pattern "safe".

- **Heuristic 1 — textual scan.** `patternHasSuperlinearShape` walks the pattern without
  executing it and rejects a group repeated without a finishing bound whose body carries a
  variable quantifier, or whose alternation splits a subject ambiguously (prefix branch or
  empty branch), including behind anchors, lookarounds, comments, escapes and character
  classes. It models the shapes it enumerates and nothing else: an unmodelled construct is
  treated as acceptable. Fixed brace repetition stays accepted.
- **Heuristic 2 — out-of-process canary probe.** Patterns the scan does not reject run in a
  child process under a 10 ms per-canary budget against ten fixed canaries, batching up to
  32 patterns per spawn. Ten canaries sample behaviour; they do not cover a pattern's worst
  case. The probe's value is that it runs the pattern where the event loop is not, and that
  a probe which cannot answer rejects the pattern.
- **Pinned engine.** On Node the probe uses `process.execPath` and never resolves `node`
  through `PATH`; on Bun/Deno it looks up `node`; `BIFROST_PROBE_NODE` overrides either;
  `ENOENT` falls back to the hosting runtime so rules are not lost on a host without Node.
- **Bounded.** Timeout `500 ms + 20 ms × patterns`, `SIGKILL`, `maxBuffer` sized to the
  verdict lines, and `NODE_OPTIONS: ""` so the ambient environment cannot inject flags into
  the verifier.
- **Unverifiable means rejected.** A timeout rejects the stalled pattern and continues; a
  short, malformed or missing verdict stream rejects every remaining pattern in that batch.
- **Verdicts persist for the process.** The cache prevents re-probing on config reload and
  prevents repeated diagnostics. It is deliberately not persisted to disk: a stored
  "safe" verdict could outlive the engine that produced it.

Verdict decode (preserved exactly; guarded by the partial, timeout and malformed controls):

1. Verdict lines are consumed in batch order. `0` is accepted, `1` is rejected, and any
   other line ends decoding for that batch.
2. Verdicts decoded before the stream ends are honored.
3. Every pattern in the batch without a decoded verdict after a short, malformed or
   truncated stream is rejected. Later batches are still processed.
4. `ETIMEDOUT` rejects the first still-pending pattern only, then the loop continues with
   the rest, which may be re-probed in a new batch.
5. A verdict reaches the parent only through the child's stdout. There is no fallback
   channel, no partial-trust mode and no branch that assumes a missing verdict is accepted.

Why the implementation is preserved: this is the production behavior at `a624026`, and #273
relocates it. Changing the scan's coverage, the canaries, the budget, the runtime choice or
the decode policy is a security change with its own evidence requirements, not part of an
extraction.

Diagnostics use `console.error`, as today. No new logging surface, no status-bar change, no
telemetry.

## 7. Module boundary and effect authority

```
modules/rules/
  README.md
  AGENTS.md
  rules.ts      # RouteRule, CompiledRule, compileRules, classifyCompiled, deprecated classify
  safety.ts     # internal: superlinear scan, canary probe, probe runtime pinning, verdict cache
  tests/
    rules.test.ts
    safety.test.ts
```

`rules.ts` owns the contract: the two types, compilation, compiled matching, and the
deprecated reference matcher. `safety.ts` owns verification: the structural scan, the probe
script, batch transport, runtime selection and the verdict cache. `rules.ts` is the only runtime
importer of `safety.ts`; nothing outside the module imports `safety.ts`, and it is not
re-exported from `routing.ts`.

`safety.ts` exports two module-internal names so its behavior can be tested directly
instead of only through `rules.ts`: `verifyRulePatterns` (scan, batching, probe transport
and verdict writes) and `isPatternAccepted` (the cached verdict read). `rules.ts` and
`safety.test.ts` import both. The structural scanner (`patternHasSuperlinearShape`) stays
module-private and is exercised through the behavior it decides, not called directly. This
is the extraction's one structural change: the verdict map stays private to `safety.ts`,
and `compileRules` filters through `isPatternAccepted` instead of reading the map itself.
Behavior, diagnostics and cache lifetime are identical, and no name is re-exported from
`routing.ts`.

Effect authority, stated for the module guide's host-neutrality clause:

- `safety.ts` is the only file allowed to import `node:child_process` in this capability.
  It does so only inside compilation, only with the bounded options above, and only to run
  its own inline probe script. It reads `BIFROST_PROBE_NODE`, forwards the ambient
  environment to the child, writes nothing to disk, opens no network connection and reads no
  configuration file or credential.
- `rules.ts` matching is a pure function over an already-compiled rule list. It must not
  spawn, read the environment, or parse a pattern.
- The process-global verdict cache is documented as intentional module state, not a hidden
  service. It is not exported and not configurable.

### Pre-existing SDK effect-contract discrepancy (recorded, deferred)

Verified at `a624026`: `docs/router-api.md` states that `pi-bifrost/router` "never reads or
writes files, environment variables, or provider credentials, and never caches responses",
and presents the subpath as host-neutral. Constructing a router over a snapshot that carries
`rules` reaches the rule engine before any resolve:

- `createRouter` calls `createPipeline` (`router.ts:667`), which calls
  `compileRules(rawRegexRules)` at construction (`classification-pipeline.ts:427`);
- `compileRules` runs `verifyRulePatterns`, which reads `process.env.BIFROST_PROBE_NODE` in
  `probeRuntime()`, spreads `process.env` into the child environment and calls `spawnSync`
  for the bounded probe;
- rejection diagnostics write to `console.error`.

`router.resolve()` spawns nothing, and re-compiling only cached patterns spawns nothing
(measured in section 5). A snapshot with no rules has nothing to probe, so construction
cannot spawn for it.

This is pre-existing behavior that the extraction relocates; it is not behavior this change
introduces. Disposition:

- Preserve the effects exactly: no new spawn, no new environment read, no removed check and
  no new diagnostic.
- Do not change `docs/router-api.md`, the SDK surface or its tests in #273. Wording versus
  behavior is a policy decision the owner resolves separately (section 2).
- `modules/rules/README.md` describes the bounded spawn and the environment reads instead of
  repeating host-neutral phrasing.

Non-responsibilities: rule discovery and route-file precedence (`config-load.ts`), the
default rule set (`config.ts`), probe enablement, consent, candidate discovery or model
selection for live probes (`config-agent.ts`), tier resolution, provider scope, reliability,
fallback and dispatch (`routing.ts`), previews, traces and status rendering.

Import direction: `routing.ts` imports the module; the module imports nothing from the
repository. No barrel, no `index.ts`, no package, no registry.

Replaceability (the #129 questions in the issue): consumers depend on two structural types
and three functions, not on the probe design. A different safety verifier can replace
`safety.ts` without touching routing policy, and a host can compile once and match many
times without adopting the module's internals. This internal interface is not declared
public SDK API.

## 8. Compatibility preservation

- `routing.ts` re-exports `RouteRule`, `CompiledRule`, `compileRules`, `classifyCompiled`
  and `classify`, so `pi-bifrost/routing` keeps every published name, signature and
  declaration. Re-exports are direct, not wrapped.
- `classification-pipeline.ts`, `config-agent.ts` and `scripts/jev-benchmark.ts` import from
  the owner file directly; `config.ts` and `config-load.ts` take `type RouteRule` from it.
  Existing internal call sites change import paths only.
- The pipeline surface (`rules`, `compiledRules`, `matchRule`, `regexRules`) is unchanged,
  including the guarantee that `compiledRules` is what classification actually matches.
- Configuration, `schema.json`, `DEFAULT_RULES`, `loadRules` precedence, the malformed
  override failure, and every diagnostic string stay byte-identical.
- No new export from `router.ts`, no SDK change, no new dependency, no package `exports`
  change.
- The deprecated `classify` keeps its deprecation comment and stays available for parity
  coverage.

## 9. Test ownership

Move from the `classify (regex)` block in `tests/routing.test.ts` (13 named cases), by
behavior:

Moved to `modules/rules/` (12):

| Case | Home |
| --- | --- |
| returns undefined for invalid regex pattern | `rules.test.ts` |
| precompiled matching preserves rule-order precedence across positions | `rules.test.ts` |
| drops rule patterns whose backtracking explodes on a small canary | `safety.test.ts` |
| falls back to the hosting runtime when the pinned probe binary is absent | `safety.test.ts` |
| does not let PATH choose the probe binary on a Node host | `safety.test.ts` |
| parity path drops the same catastrophic pattern | `safety.test.ts` |
| reports a rejected rule once across repeated classify calls | `safety.test.ts` |
| rejects lookahead-anchored catastrophic patterns without paying the long probe | `safety.test.ts` |
| bounds a disguised catastrophic rule while compiling (child-process bound) | `safety.test.ts` |
| rejects deterministic-free catastrophic alternations without exec | `safety.test.ts` |
| accepts lazy fixed repeats and still rejects lazy variable repeats | `safety.test.ts` |
| keeps benign quantified rules that shuttle variable tokens safely | `safety.test.ts` |

Stays system-owned (1):

- `still compiles every shipped default rule` remains in `tests/routing.test.ts`: it couples
  the rule engine to `config.ts` `DEFAULT_RULES`, which the module must not import.
- `tests/config-agent.test.ts` keeps its `compileRules`/`classifyCompiled` cases through the
  root import; they cover the probe plan and the compatibility surface, not the module
  contract.
- `tests/classifier-properties.test.ts` keeps its `type RouteRule` import as a compatibility
  check.
- Pipeline, command, router, integration and acceptance suites stay where they are.

New module tests, each guarding a contract not currently covered:

1. **No spawn on the match path.** Compile a fresh literal rule with the wrapper probe,
   clear the spawn marker, run 2000 matching prompts, assert 2000 hits and zero spawns.
2. **One spawn per batch.** Compile several fresh benign patterns and assert a single child
   process.
3. **Ambient `NODE_OPTIONS` cannot reach the verifier.** Set `NODE_OPTIONS` to a `--require`
   poison file, compile a fresh pattern, assert the rule is kept and the poison file never
   ran.
4. **A hung verifier fails closed.** Point `BIFROST_PROBE_NODE` at a script that sleeps past
   the timeout, compile a fresh pattern, assert the rule is dropped and the rejection is
   logged once.
5. **A malformed verdict stream fails closed.** A probe stub printing a non-verdict line
   causes every pattern after the last decoded verdict in that batch to be rejected; no
   pattern from a malformed stream is accepted on assumption.
6. **Root re-export identity.** `routing.ts` exposes the same function objects and type
   names as the owner file (root compatibility test, system-owned).
7. **A partial verdict stream keeps the decoded prefix.** A stub probe writes verdicts for
   the first patterns of a batch and exits 0: the decoded verdicts are honored, the rest of
   that batch is rejected, and a later batch is still probed.
8. **A timeout rejects one pattern and continues.** A stub probe writes one accepted verdict
   and then hangs past the probe timeout on its first invocation, answering normally on the
   next: the first pattern is kept, the stalled one is rejected once, later patterns are
   kept, and the test finishes inside its own bound.
9. **A malformed stream keeps its decoded prefix.** A stub probe writes one valid verdict
   and then a non-verdict line: the valid verdict is honored, the remainder of that batch is
   rejected, and a later batch still runs.

The stub-probe controls talk to `BIFROST_PROBE_NODE`, as the existing fallback and
PATH cases do, and never execute a configured pattern in the parent process.

Isolation requirement (Crux correction 3). Two moved cases match a pattern that verification
would reject if it were working: `parity path drops the same catastrophic pattern` and
`reports a rejected rule once across repeated classify calls`. Under a mutant that removes
the rejection, that match runs in the parent process. Keep both assertions, but run the
compile-and-match step in a child process with a timeout and `SIGKILL` — the shape the
existing `bounds a disguised catastrophic rule while compiling` case already uses — and
assert on the bounded child's output. Patterns, budget, diagnostics and engine behavior are
unchanged.

The existing timing assertion ("rejection must not pay a long probe", < 250 ms) is moved
verbatim; it is a regression guard on the textual scan's cost, not a benchmark. If it proves
flaky on CI, that is a separate decision — do not loosen it while extracting.

A named before/after inventory is captured; the total test count may grow from the new
cases, and no moved behavior may silently disappear.

## 10. Mutation

`mutation/config.mjs` gains two targets with budgets from their first dry run, and its
`routing.ts` estimate is re-measured because the rule-engine mutants leave that target:

- `modules/rules/rules.ts`
- `modules/rules/safety.ts`

Both need a `RUNNER_OVERRIDES` entry using the Node/TAP runner: when a mutant bypasses the
structural scan, a catastrophic pattern can run in-process, and V8 and JavaScriptCore
backtrack at different speeds (the recorded reason for `routing.ts` today).

Binding is verified, not assumed (Crux correction 3). `bindingFor()` binds only test files
that import the target directly and are not self-referential (a test that reads the target's
source bytes is excluded). The expected post-extraction binding is:

| Target | Bound tests | Why it is meaningful |
| --- | --- | --- |
| `modules/rules/rules.ts` | `modules/rules/tests/rules.test.ts` and `modules/rules/tests/safety.test.ts` | `rules.test.ts` covers compilation, ordering and drop behavior; `safety.test.ts` covers the compile-and-match parity cases |
| `modules/rules/safety.ts` | `modules/rules/tests/safety.test.ts` | imports `../safety.ts` directly and exercises the scan, probe transport, verdict decode and cache |
| `routing.ts` | its existing root consumers | still owns the resolver and rule-adjacent policy |

A test imports `safety.ts` only when it exercises `safety.ts`; a case that needs only
`compileRules` does not add the import, and no import exists solely to create a binding.

Evidence required at the implementation head, captured verbatim:

- `node mutation/run.mjs <target> --dry-run` for all three targets: the dry run resolves the
  binding and fails with "no bindable test consumers" when a target is unbound;
- the module targets' `binding` arrays from `mutation/targets.mjs`, showing exactly the files
  above;
- `bindingExclusions()` showing no self-referential exclusion for either module target.

No artificial import is added to satisfy discovery. If `safety.test.ts` did not import
`safety.ts`, the target would be dropped rather than propped up with an unused import.

`routing.ts` keeps its target and its current TAP override in this change. Removing that
override is a budget/CI decision that becomes safe only once the moved rule tests are shown
to bind the new targets; that removal is deferred, not smuggled in.

Focused execution:

```
node mutation/run.mjs modules/rules/rules.ts --dry-run
node mutation/run.mjs modules/rules/safety.ts --dry-run
node mutation/run.mjs modules/rules/rules.ts
node mutation/run.mjs modules/rules/safety.ts
node mutation/run.mjs routing.ts --dry-run
```

`MUTANT_ESTIMATE` and `secondsPerMutant` are written from the dry run and the focused run,
not guessed. If the measured total breaches the configured wall-clock budget, affected work
stops and the owner decides the split; no budget constant is raised quietly.

## 11. Packaging and distribution

Expected: `modules/rules/rules.ts` and `modules/rules/safety.ts` ship as runtime source;
module tests, `README.md` and `AGENTS.md` do not. The router build emits
`dist/router/modules/rules/rules.js` and `safety.js` plus declarations because
`routing.ts` is in the build program; the nested pair is addressable through the existing
`./*` behavior and is not a new documented API. No `files` entry changes.

Verification uses the existing release and packaged-consumer suites, which derive the router
inventory from the TypeScript project graph and inspect the installed tree recursively. A
manual `dist/router` listing is captured as supplemental evidence, not as the gate.

## 12. Documentation

`modules/rules/README.md`: purpose, non-responsibilities, contract, ordering guarantee,
what the safety checks do and do not guarantee (explicitly heuristics, with the accepted
residual risk), fail-closed handling of unverifiable patterns, the structural-scan and
out-of-process-probe design, the pinned-engine and environment rules, verdict-cache
semantics, verdict-decode behavior, effect authority ("compilation may spawn one bounded
child process and read the probe environment; matching may not"), compatibility note, and
the exact isolated command:

```
node --test --experimental-strip-types modules/rules/tests/rules.test.ts
node --test --experimental-strip-types modules/rules/tests/safety.test.ts
```

`modules/rules/AGENTS.md`: references the repository and module rules, and adds only local
boundaries — never weaken fail-closed rejection, never resolve the verifier through `PATH`,
never spawn on the match path, never persist verdicts, keep rules discovery and route-file
precedence out, require a red control (or a recorded limitation) for security changes.

Root documentation already describes the `rules` configuration shape and needs no semantic
change. If a line implies the engine lives in `routing.ts`, only that ownership sentence is
updated.

## 13. Verification plan

Run at the exact clean head, capture actual output, and re-run after any edit. Local runs are
the focused suites and fast gates; CI owns the full tier.

```
node --test --experimental-strip-types modules/rules/tests/rules.test.ts
node --test --experimental-strip-types modules/rules/tests/safety.test.ts
node --test --experimental-strip-types tests/routing.test.ts
npm run typecheck
npm run test:quick
npm run check:complexity
npm run check:complexity:base
npm run check:arch
npm run check:arch -- --json
npm run check:dead-code
npm run check:ast
npm run check:duplication
npm run build:router
npm run verify:release
node mutation/run.mjs modules/rules/rules.ts --dry-run
node mutation/run.mjs modules/rules/safety.ts --dry-run
node mutation/run.mjs routing.ts --dry-run
```

CI additionally runs `npm test`, `test:coverage`, `test:integration`, `acceptance`,
`test:ui` and `test:ui:reliability`. Because the public pipeline surface is unchanged, UI
suites are expected to pass untouched; a failure there is a finding, not a test to update.

Architecture evidence (Crux correction 5): the capability's `node:child_process` import is
legitimate and must not be suppressed. From `npm run check:arch -- --json`, record that the
new capability's edge set is exactly `rules.ts → safety.ts` and
`safety.ts → node:child_process`, with no edge to a repository module, host adapter, Pi
package or dev dependency. Existing rules already cover the module: `no-circular`,
`production-no-dev-dependency` and `production-no-repository-tooling` apply through
`PRODUCTION_ROOTS`, and `no-unresolvable` covers the build graph. No architecture rule is
added, widened, or taught to ignore `modules/rules/`.

Residual gap, recorded not fixed: `router-no-runtime-host-sdk` and `router-no-host-adapters`
match `^router\.ts$` only, so a future host-SDK import inside `modules/rules/` would escape
them even though the module is reachable from the SDK. The edge-set evidence above guards
this change; extending that rule scope is a separate tooling decision (section 2).

`check:complexity` is expected to stay clean: the code moves from a measured root file into
an already measured `modules/` source scope, per-file maxima only decrease, and no policy
input changes, so the protected judge compares equal digests. If the new files trip the
new-file ceiling, affected work stops and the owner decides before anything else happens.

## 14. Fault controls

Each applied then reverted; a control that does not go red means the behavior is untested.
Controls that could execute an unverified pattern run in a bounded child process (timeout,
`SIGKILL`); a control that hangs is reported as a failed control, not as a pass.

1. Delete the nested-quantifier branch of the structural scan → the moved catastrophic tests
   go red. The probe may catch the pattern first, so this is the slow, Node-only red.
2. Make verdict decoding fail open (a missing line means accepted) → the malformed-stream and
   partial-stream tests go red.
3. Make `ETIMEDOUT` continue without rejecting, or drop the whole batch → the
   timeout-continuation test goes red.
4. Treat a short stream as complete → the partial-stream test goes red.
5. Decode past a non-verdict line instead of stopping → the malformed-stream test goes red.
6. Resolve the verifier from `PATH` under Node → the PATH-substitution test goes red.
7. Remove `NODE_OPTIONS: ""` → the ambient-environment test goes red.
8. Drop the verdict cache → the reject-once and no-re-spawn tests go red.
9. Make `classifyCompiled` compile or verify first → the no-spawn-on-match test goes red.
10. Return the last matching rule instead of the first → the precedence test goes red.
11. Remove a `routing.ts` re-export → the root compatibility test goes red.
12. Remove a module test's direct import (scratch, reverted) → the mutation dry run fails to
    resolve a binding, which is the binding control.

## 15. Risks, uncertainties and rollback

- **Process-global cache is real state in a new module.** Parity requires keeping it. It
  makes tests order-sensitive, so new cases use fresh pattern text (the existing tests
  already do, and one says why). Exporting a cache reset would be new API; it is not part of
  this change and is recorded as a possible follow-up.
- **The module is not host-neutral by accident.** It imports `node:child_process`. That is
  the documented effect authority, not an oversight; the README states it, and dep-cruiser
  must not be taught to ignore the whole module.
- **Mutation cost.** Rule tests that let a catastrophic pattern run in-process are slow
  under a mutant; the Node/TAP override is required. Measured budget may exceed the current
  envelope, in which case work stops for an owner decision.
- **Router bundle.** The build gains a nested runtime pair. The release inventory derives it
  from the program graph; a manual entry list must not be added.
- **Embedded probe script.** It is a template string containing escapes and stdin JSON; it
  moves verbatim. A visible diff in its body is a defect, and the "disguised catastrophic
  rule" test is the guard.
- **Timing assertions.** Two moved tests assert elapsed time (< 250 ms for the scan; successful
  child compilation within 2500 ms). They are unchanged; a CI flake is reported, not
  silenced.
- **Misreading the deprecated path.** `classify` is the parity reference, not a supported
  entry point. Keeping it exported preserves compatibility; adopting it anywhere new is a
  review finding.
- **Complexity of `safety.ts`.** The scanner is the densest moved function. New-file ceilings
  are checked before review; splitting it further is out of scope.
- **Heuristic safety can be overstated.** The scan and the canary probe are not a proof, and
  documentation that says otherwise becomes a security claim with no evidence behind it.
  The module README, code comments and the PR body say "heuristic" and "fail closed for
  unverifiable patterns", never "safe".
- **The SDK documentation is already inaccurate.** `docs/router-api.md` claims no
  environment reads while router construction probes. This change preserves the behavior and
  defers the wording; leaving it unrecorded would let a reviewer treat the extraction as the
  cause, or the contradiction as new.
- **Architecture rule scope is narrower than the SDK reach.** The module is reachable from
  `router.ts`, but the host-SDK rules key on `router.ts` only. Recorded as a residual gap;
  widening the rule is not part of this change.
- **One bound test file per new target.** Mutation strength depends on `safety.test.ts`
  alone for `safety.ts`. That is the meaningful binding, not a reason to import the target
  from an unrelated suite; if coverage proves thin, the answer is a better safety test.
- **The internal seam is the one non-verbatim change.** `safety.ts` gains two internal
  exports and `compileRules` filters through an accessor. Behavior and diagnostics are
  identical, but the diff is not a pure move and the review must check that seam.

Rollback is a revert: no persisted format, stored state, configuration, migration or
scheduled campaign is involved. Verdicts are in-memory only.

## 16. Owner adjudication and approval checklist

The independent Crux challenge is complete and its five corrections are ACCEPTED and folded
into this contract (section 2). The owner adjudicated all seven items below on 2026-11-26;
the implementation candidate applies them:

1. Adjudicate the SDK effect-contract discrepancy: confirm the effects are preserved,
   `docs/router-api.md` is not edited in #273, and the wording/policy follow-up is tracked
   separately.
2. Adjudicate the test-shape change: the parity and reject-once cases run their
   compile-and-match step in a bounded child process so a mutant cannot hang the runner.
3. Approve the `safety.ts` internal seam (`verifyRulePatterns`, `isPatternAccepted`; the
   structural scanner stays private) as the meaningful mutation binding — or drop that
   target and record the weaker binding instead.
4. Confirm the architecture edge-set evidence is sufficient for the boundary, including the
   recorded residual gap in the `router-no-runtime-host-sdk` scope.
5. Approve recording measured mutation budgets and the re-measured `routing.ts` estimate from
   the dry runs, with affected work stopping if the wall-clock envelope is breached.
6. Confirm whether this plan document may be committed (docs only) and pushed as the review
   artifact; no production file changes until approval is recorded.
7. Confirm an independent exact-head review is still required for merge, and that the binding
   inventory and architecture edge set are part of its evidence.

Approval checklist:

- [x] Heuristic framing of the safety checks approved; no safety-engine change implied.
- [x] SDK effect-contract discrepancy recorded and its follow-up assigned.
- [x] Boundary and file layout approved (unchanged by the challenge).
- [x] `safety.ts` internal export seam approved as the mutation binding.
- [x] Test ownership, the stub-probe controls and the two isolated cases approved.
- [x] Mutation bindings, measured budgets and the re-measured `routing.ts` estimate approved.
- [x] Verification list, architecture edge-set evidence and fault controls approved.
- [x] Crux completed and recorded; owner approval recorded.
