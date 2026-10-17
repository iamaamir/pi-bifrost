# Bounded verification campaigns

Issue #85. The `Verification` workflow gains an opt-in
expanded campaign, a pinned Pi compatibility matrix, and an opt-in mutation
experiment, all using the existing workflow path. No standalone workflow was
added, and all seven release gates plus the proposed-merge report publisher
remain unconditional on ordinary PR, push, and default manual dispatch.

## How to run

Use the existing dispatch path with `--ref` to run the workflow version from any
branch (the workflow file must exist on the default branch first):

```bash
gh workflow run verification.yml --ref integration/completion-verification \
  -f campaign=expanded \
  -f campaign_repeats=3 \
  -f campaign_seed=1729
```

Add `-f mutation=true` to also run the existing Stryker experiment. `campaign`
defaults to `default`, so a normal `Run workflow` click keeps only the release
gates.

`campaign_repeats` is hard-bounded to 1-5 and validated by
`scripts/campaign-run.mjs --validate-only` before any attempt starts.
`campaign_seed` must be a signed 32-bit integer.

## Schedule

The workflow declares `on: schedule: - cron: "23 4 * * *"` (one daily run,
off the documented top-of-hour load window). Scheduled workflows will only run
on the default branch; `v2` is not the default branch, so nightly activation
remains pending until this workflow file is adopted onto `main`. There is no
active cron today, and this branch does not claim one.

## What a campaign attempt runs

- `properties`: model selection, classifier, and discovery property tests (seeded).
- `reliability`: reliability state machine, filter, and cache replay-control tests.
- `integration`: `npm run test:integration` (repeat measured; includes concurrency
  and native suites).
- `pi-compatibility`: both packages at pinned `1.0.1` and `1.3.0`, baseline kept on the `npm ci` lock and the alternate installed
  into `node_modules` only (`--no-save --package-lock=false`, no credentials),
  with installed-version verification, an unchanged tracked tree, `npm run
  typecheck`, native SDK/process tests, and the installed-package consumer test.
- `mutation-experiment`: the existing four-module Stryker configuration, manual
  boolean opt-in, low concurrency (`2`), a hard 55 minute step bound and 60
  minute job bound, and report plus file log uploaded even on failure.

## fast-check seeds

`tests/preload/fast-check-seed.mjs` reads `FC_SEED`, validates it as a signed
32-bit integer, and calls `fc.configureGlobal({ seed })` before any test loads;
it logs `[fc-seed] FC_SEED=<n> applied as fast-check global seed`. With `FC_SEED`
unset it changes nothing, so the ordinary `npm test` path is unchanged.

Campaign attempts set `FC_SEED` per run through `scripts/campaign-run.mjs`.
The seed for attempt `n` is `seed(base) + n * 1042543`, starting with attempt 0
exactly equal to the configured base; the result wraps into the signed 32-bit
range. `campaign.json` records each derived seed, so a
failure replays under `FC_SEED=<seed>` with NODE_OPTIONS carrying the preload.

Please be truthful about what this varies:
- Assertions that omit an explicit seed follow the configured global seed:
  `model-selection-properties`, `classifier-properties`, `discovery-properties`.
- Pinned regression controls are deliberately not varied. Configured seeds do
  not override an explicit assert option:
  - `reliability-state-machine.test.ts` (`SEQUENCE_SEED`, `SWEEP_SEED`, `FAULT_SEED`)
  - `reliability-filter-properties.test.ts` (`SEQUENCE_SEED`, `WITNESS_SEED`, `BOUNDARY_SEED`)
  - `cache-properties.test.ts` (`assertReplayableProperty` with its fixed seed and `FC_PATH`)

The campaign repeats those replay-control files as nightly regression evidence,
not because configured seeds change them.

## Mutation experiment

Reuses `stryker.config.mjs` with `commandRunner.commandRunner`, coverage
analysis off, `concurrency` 2, and the existing focused binding and disclosed
survivor limits. It does not invent a mutation score threshold or claim that
surviving mutants were caught. Report and file log are uploaded on failure.

## Compatibility claims

Normal release gates and `verify-release.mjs` keep pinned Pi `1.0.1`. The
compatibility jobs are separate and run both pinned `1.0.1` and `1.3.0` against
real native SDK, process, package-consumer, and typecheck tests. `verify-release`
is intentionally not used as an alternate-version oracle. This does not make a
broad compatibility claim beyond those executed checks.

## Bounds and measured cost

Campaign job timeout 30 minutes, Pi compatibility 20 minutes, mutation 60.
Repeat count is hard-capped at 5. Measured focused additions: a three-attempt
properties run takes about five seconds per attempt, the integration target
inherits the median integration gate of 43 seconds times 3 repeats, so a full
expanded campaign is roughly three minutes plus install and overhead. Baseline
median gate costs from `bifrost-ci-cost-inventory-verified.json`: unit 22 s,
integration 43 s, pinned Pi UI 201 s, pinned Pi reliability UI 49 s.

## Evidence and replay

Per attempt the runner records command, seed, derived seed, installed `node`
and `npm` versions, package versions, git revision, source fingerprint before
and after, elapsed time, status, exit code, output truncation, and process
cleanup result in `campaign.json` plus a per-attempt log. The evidence directory
is written outside the repository. A campaign is marked `validEvidence`: false
and aborted whenever an attempt fails, leaves a child process group, or the
source tree changes; it never runs a later attempt after one of those.
