# Mutation testing (issue #62)

Focused, reproducible mutation testing for the core policy modules. This is an
**opt-in, expensive campaign**. It is not part of `npm test`, `npm run typecheck`,
or fast PR CI. Run it deliberately when changing routing, reliability, cache, or
classifier semantics.

## Verdict

StrykerJS 10 (`@stryker-mutator/core`) is compatible with this repository's
`node:test` suite and native TypeScript type stripping (Node >= 22.18; measured
on Node v24.14.0). No incompatibility was found, so no custom mutation runner
was built. The measured constraints that shaped the setup:

- `node:test` has no Stryker per-test coverage plugin, so the `command` test
  runner with `coverageAnalysis: "off"` is required. Every mutant runs the
  whole bound test command; there is no per-test mutant attribution.
- Stryker's Babel-based instrumenter parses the `.ts` sources directly and the
  sandbox mutants stay valid for Node's type stripping. No build step, no
  `buildCommand`, no enums/namespaces/parameter properties in the targets.
- Stryker resolves `node_modules` from the parent project directory even though
  the sandbox excludes it.
- Mutant timeout is `dryRunDuration * timeoutFactor + timeoutMS`. Under worker
  contention a suite that measures 12 s can exceed the default 1.5x+5s budget
  and every mutant is reported as a spurious timeout. Size these to the slowest
  bound suite (`tests/reliability-state-machine.test.ts`, ~4.3 s alone).

## How to run

```bash
npm ci
npm run test:mutation            # four-target campaign, focused binding (~3.5 min on 10 cores)
npx stryker run stryker.config.classifier-semantics.mjs  # binding-sensitivity check (~40 s)
```

`stryker.config.mjs` (committed) mutates `cache.ts`, `classifier-semantics.ts`,
`reliability.ts`, and `routing.ts` and binds the five directly owning test
files (`cache`, `classifier-cache-key`, `classifier-detection`,
`reliability`, `routing`). `stryker.config.classifier-semantics.mjs`
(committed) re-runs `classifier-semantics.ts` against all three test files
that import it directly; it exists because focused binding measurably
undercounts kills (see below).

Reports land in `reports/mutation/` (gitignored). The JSON report contains
every mutant, its replacement, status, and location.

## Measured results (Node v24.14.0, macOS, 10 cores)

Focused binding, 5 test files (~0.6 s per mutant run), 3 min 24 s total.
Stryker-reported statuses: 0 Timeout, 0 RuntimeError, 0 CompileError,
0 NoCoverage. These are Stryker-reported statuses under the command runner,
not cause classifications: any nonzero bound-command exit counts as Killed,
so Killed includes assertion failures, thrown exceptions, and startup
failures alike; with `coverageAnalysis: "off"` coverage is unmeasured, so a
zero NoCoverage count does not prove every mutant executed. Scores below use
Stryker's definition, Killed + Timeout over Killed + Timeout + Survived +
NoCoverage (RuntimeError/CompileError excluded); with Timeout and NoCoverage
at zero the denominator is exactly the mutant count:

| File | Mutants | Killed | Survived | Score |
| --- | --- | --- | --- | --- |
| cache.ts | 226 | 145 | 81 | 64.16% |
| classifier-semantics.ts | 157 | 42 | 115 | 26.75% |
| reliability.ts | 352 | 209 | 143 | 59.38% |
| routing.ts | 520 | 372 | 148 | 71.54% |
| **All** | **1255** | **768** | **487** | **61.20%** |

The `classifier-semantics.ts` score is binding-sensitive. Adding its third
direct consumer (`tests/classifier-effective-validation.test.ts`) raises the
score from 26.75% to 51.59% (81 killed / 76 survived, 0 Stryker-reported
timeouts, 38 s):

| File | Binding | Mutants | Killed | Survived | Score |
| --- | --- | --- | --- | --- | --- |
| classifier-semantics.ts | cache-key + detection (in focused run) | 157 | 42 | 115 | 26.75% |
| classifier-semantics.ts | all 3 direct consumers | 157 | 81 | 76 | 51.59% |

Binding choice, not test quality alone, drives these numbers. The remaining
76 survivors with full direct-consumer binding are committed in
[`mutation-evidence-62/classifier-semantics-all-consumers-survivors.jsonl`](mutation-evidence-62/classifier-semantics-all-consumers-survivors.jsonl).
Consumers reached only through Pi adapter integration suites are still not
bound, so even 51.59% is a lower bound for this module.

## Boundary/transition kill proof

377 killed mutants are comparator/conditional/logical mutations on
boundary and state-transition lines: every Killed mutant with mutator in
`{EqualityOperator, ConditionalExpression, LogicalOperator}`
(92 + 203 + 82 = 377). The committed extract
[`mutation-evidence-62/boundary-kills-focused-binding.jsonl`](mutation-evidence-62/boundary-kills-focused-binding.jsonl)
lists mutant ID, exact start/end range, mutator, replacement, status, and
the source line for each, so every row is individually identifiable (the
earlier revision of this extract omitted IDs and left 105 rows
indistinguishable). Run provenance — source/config/lock hashes, versions,
command, raw totals, and report hashes — is in
[`mutation-evidence-62/run-manifest.json`](mutation-evidence-62/run-manifest.json).
Confirmed examples:

- `cache.ts` TTL freshness (`lastUsed >= cutoff` in `loadCache` and in the
  `lookupCache` usable check): 12 killed mutants.
- `cache.ts` eviction boundary (`entries.length <= maxEntries`): killed.
- `cache.ts` Jaccard threshold (`score < threshold`, size-ratio bound): killed.
- `cache.ts` best-entry tie-breaking (`score > best.score`): 10 killed mutants.
- `reliability.ts` open transition (`openUntil > now`): 7 killed mutants;
  half-open transition (`openUntil <= now`): 7 killed mutants.
- `reliability.ts` failure-threshold transition
  (`failures.length >= resolved.failureThreshold`): 6 killed mutants.
- `reliability.ts` bounded allowance retry-hint horizon: killed.
- `routing.ts` `minBy` selection (`s < bestScore`): 4 killed mutants.

A controlled mutant was applied by hand, not only through Stryker:
[`mutation-evidence-62/controlled-mutant-red-green.txt`](mutation-evidence-62/controlled-mutant-red-green.txt)
shows `cache.ts:130` flipping the eviction-boundary test red (28 pass / 1
fail) and the restore returning 29/29 green, with no test edits.

## Surviving-mutant evidence

All 487 focused-binding survivors (mutant ID, exact start/end range,
mutator, replacement, status, source line) are committed in
[`mutation-evidence-62/survivors-focused-binding.jsonl`](mutation-evidence-62/survivors-focused-binding.jsonl).
Notable real survivors worth targeted tests (for the test lanes, not patched
here):

- `routing.ts` `guessTier` cost boundaries (`cost > FRONTIER_COST_THRESHOLD`,
  `cost < QUICK_COST_THRESHOLD`) and its returned string literals.
- `cache.ts` seq-counter reseeding after load (`maxSeq >= nextSeq`).
- `cache.ts` `updateCache` semantic-key compound condition and the
  `hits + 1` increment.
- `cache.ts:147` TTL `>=` vs `>` at the exact cutoff (verified by hand, see
  the controlled-mutant file); some survivors may be equivalent mutants.

## Limitations

- Mutation outcomes can be stochastic, so no deterministic replay of a
  historical status or exact score is promised. The recorded survivor
  `routing.ts` mutant 839 (`ConditionalExpression` at lines 162–164,
  replacement `case "largest_context":`, which drops the return and falls
  through to the unseeded `random` strategy) is Killed or Survived depending
  on the run: an independent 16-trial replay of the identical 5-file command
  produced 12 nonzero exits and 4 zero exits (surviving trials 6, 8, 11,
  13; 126 tests each), and a worktree repeat produced 7 kills / 3 survivals
  over 10 trials (surviving trials 1, 8, 9). The owning tests stub
  `Math.random` only for the explicit `random` strategy, not for this
  fallthrough. Repeated outcomes are preserved in
  [`mutation-evidence-62/run-manifest.json`](mutation-evidence-62/run-manifest.json)
  (`stochasticMutants`); any rerun establishes a new outcome.
- `coverageAnalysis: "off"` means no per-test attribution; a mutant is
  reported Killed if the whole bound command exits non-zero, whether that
  exit came from an assertion failure, a thrown exception (for example a
  `TypeError` from an optional-chain removal), or a startup failure.
  Equivalent-mutant candidates
  are included in the survivor counts and were not audited exhaustively.
- Focused binding undercounts kills (measured: +25 percentage points on
  `classifier-semantics.ts` with one more consumer file). Widening the binding
  further costs about one second per additional bound test file per mutant;
  a full-suite-per-mutant run (`npm test`, measured at ~21.5 s) is not
  affordable per mutant (~7 h for this campaign).
- Scores are evidence, not a CI gate. No mutation threshold is enforced and
  nothing in `verify:release` depends on this campaign.
- `tests/acceptance-runner.test.mjs` ("runs the real contract CLI to final
  stable-fingerprint evidence") intentionally fails on a dirty working tree
  (`candidate-stable`). Run full verification on a clean, frozen candidate.

## Reproducibility

Exact commands, versions, config files, and the committed evidence extracts
above are sufficient to replay both campaigns. Full JSON reports from the
recorded runs are local artifacts under `evidence/mutation-62/` (gitignored,
regenerable); the compact extracts in `docs/mutation-evidence-62/` are the
committed record, bound to those report bytes by
[`mutation-evidence-62/run-manifest.json`](mutation-evidence-62/run-manifest.json)
(report hashes, source/config/lock hashes, versions, command, raw totals).
Fields the Stryker JSON report does not record (VCS revision at run time,
worker concurrency) are marked not-recorded in the manifest, not
reconstructed. Because stochastic mutants (see Limitations) make reruns land
on new outcomes, a replay establishes a new run; it does not necessarily
reconstruct the recorded statuses. Measured failure mode to reproduce the caution: at the
default `timeoutFactor: 1.5` + `timeoutMS: 5000`, binding 22 consumer test
files (~12.4 s per run) under 9 workers made every mutant report as a timeout;
the per-run budget must exceed the contended suite duration, not the idle one.
Refs #62.
