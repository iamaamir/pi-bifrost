# Coverage contract

An end-to-end (E2E) test starts Pi, loads Bifrost, and checks what the user or provider can observe. A handler mock or screenshot alone is not E2E proof.

## For each change

When a feature changes routing, commands, or saved state, add or update a Pi E2E test. Use the local fake provider. Check the requested model, excluded models, retry count, visible result, and saved state where they apply. Use isolated homes and workspaces. The outbound guard must report no external requests.

When a user reports a failure, keep their error shape and sequence in a regression test. Show that the assertion detects the faulty behavior. Use an isolated older revision or a controlled fault in a temporary fixture. Keep production files and user state unchanged during this proof.

Some contracts need a different boundary. The resolve-only API uses an installed-package consumer test. File-system faults, lease races, and exact deadline boundaries use deterministic lower-level tests as well as the Pi happy and failure paths. State this distinction in review. Do not call these tests Pi E2E.

Before review, run `npm run verify:release` on a clean, frozen candidate. Attach its result manifest to the reviewed revision. If source changes during the run, rerun the full command on the final candidate. Partial reruns do not replace a failed manifest. The reviewer checks this map against the changed behavior and checks that assertions can fail for the reported regression.

## Per-change executed evidence

PR acceptance requires a tracked `change-evidence.json` declaration. Set `schemaVersion` to `1` and `base` to the PR base commit's full SHA. Update the branch when that base is no longer an ancestor. The declaration must match the current PR base; an older declaration fails.

Each entry in `contracts` has a unique `id`, a requirement (`R01` through `R17`), exact changed `files`, a `boundary`, and observable `assertions`. Cover every changed file, including tests, documentation and workflows. The declaration itself is excluded from this list. File renames count as deletion and addition.

Each contract declares `boundaryTest`, `invariant`, and `fault`. Each dimension is either `{ "file": "tests/example.test.ts", "name": "exact Node test name" }` or `{ "exception": "specific reason this dimension does not apply" }`. The fault case must assert that a controlled faulty implementation fails the intended assertion. A failure caused by invalid input alone does not establish fault sensitivity.

The existing deterministic acceptance run checks each test reference against its completed Node events. Missing, duplicate, failed, skipped and TODO cases fail acceptance. References use exact repository-relative paths and exact case names. This first version supports the Node unit and integration events already captured by the runner. For a boundary outside that capture, document the exception and its separate evidence for review.

For a local run, set `BIFROST_EVIDENCE_BASE` to the full base SHA and run `npm run acceptance`. CI reads the PR base from the GitHub event instead. Acceptance records the declaration in its result, alongside the existing start/end revision and source fingerprints. The declaration does not embed its own commit SHA, which would change whenever the declaration is committed.

After merging a published base into a branch, rebind and check the declaration with `node scripts/acceptance/evidence-rebind.mjs <base-ref> --apply`. The helper resolves the base as a real commit, validates that it is an ancestor of HEAD, rewrites the declaration's `base` when `--apply` is given, and reports every declared file that is outside the candidate diff and every changed file that is undeclared. It checks the candidate-diff structure only; the acceptance run still validates named test references against real test events.

Take a merge through its local checks after committing it. The workflow-acceptance tests compute the merge predecessor from committed history, and the candidate-stable gate refuses a dirty working tree, so an uncommitted merge fails them misleadingly.

The validator checks declared test execution, not semantic adequacy. An independent reviewer must judge contract completeness, assertions, fault controls and exception rationales on the exact head. A declaration is not an approval. This change does not activate automatic merging or alter branch protection. Push and manual runs without an explicit base retain the existing release gates. The PR workflow must first be adopted before this requirement is operational; existing PRs are not modified by this local implementation.

## Release feature map

The requirement IDs come from [the PRD](../PRD.md). These rows name test boundaries, not percentages of coverage. More than one row can use the same user scenario.

| Requirement | Pi or consumer boundary | Deterministic support |
| --- | --- | --- |
| R01: explainable decisions | [Pi preview and status](../tests/integration/integration.test.mjs); [command acceptance](../tests/integration/command-policy-acceptance.test.mjs) | Routing pipeline and decision-envelope tests |
| R02: physical default, Auto, pin and off | [Physical controls](../tests/integration/legacy-behavior.test.mjs); [Auto dispatch](../tests/integration/auto-virtual.test.mjs) | Registered input and manual-control tests |
| R03: bounded recovery and no unsafe replay | [V1/V2 Auto recovery](../tests/integration/reliability-v2-auto.test.mjs); [HTTP 402 acceptance](../tests/integration/release-acceptance.test.mjs) | Tool, output, queue, cancellation and ownership guards |
| R04: chat-model pools | [Fresh catalog setup and background probe completion](../tests/integration/auto-virtual.test.mjs); [init probe regressions](../tests/integration/init-regression.test.mjs) | Pinned Pi catalog contract and model-type tests; all-failed background warning and no-write checks; image routing is deferred |
| R05: strict fallback | [Physical no-route](../tests/integration/legacy-behavior.test.mjs); [Auto boundary and reserve rejection](../tests/integration/auto-virtual.test.mjs) | Ordered fallback and requirement propagation tests |
| R06: stop before unsafe generation | Physical and Auto no-route cases above | Activation, cancellation and late-result tests |
| R07: offline inspection and validation | [Command acceptance](../tests/integration/command-policy-acceptance.test.mjs); [offline preview and invalid-source rejection](../tests/integration/preview-offline-acceptance.test.mjs) | Config diagnostics and inspection projections |
| R08: durable model and provider pauses | [V2 leases and recovery](../tests/integration/reliability-v2-auto.test.mjs); [physical 402 and restart](../tests/integration/release-acceptance.test.mjs); [scope reload](../tests/integration/command-policy-acceptance.test.mjs) | Lease ownership, half-open recovery and both scope-reload directions |
| R09: safe reload and storage | [Invalid physical reload](../tests/integration/legacy-behavior.test.mjs); [startup source validation and repair](../tests/integration/config-startup-acceptance.test.mjs); [reload UI](../scripts/ui-smoke.py) | Atomic storage, compare-and-swap, journal and invalid-config tests |
| R10: declared economic policy | [Reserve rejection](../tests/integration/auto-virtual.test.mjs); [billing preference dispatch](../tests/integration/command-policy-acceptance.test.mjs) | Signal units, freshness, conflicts and unknown-value tests; live quota fetching is deferred |
| R11: retention within a tier | [Native-turn retention and prefix selection](../tests/integration/reliability-v2-auto.test.mjs) | Branch-local ownership and affinity tests |
| R12: bounded classification and visible fallback | [Timeout notice followed by generation](../tests/integration/command-policy-acceptance.test.mjs) | Shared budget, pending callbacks, abort and notice-deduplication tests |
| R13: resolve-only API | [Installed consumer](../tests/router-package.test.mjs) | Router API contract and immutable snapshot tests |
| R14: private diagnostics | Command acceptance and Pi UI notices | Debug projection, secret and prompt-content tests |
| R15: reviewed membership changes | [Pi reconciliation and init](../tests/integration/command-policy-acceptance.test.mjs); [init probe regressions](../tests/integration/init-regression.test.mjs) | Ownership, stale inventory, concurrent edits, preserved settings, successful-only pools, recent probe reuse, forced probes, and exact backup tests |
| R16: repeatable release checks | [Verification runner](../scripts/verify-release.mjs), guarded Pi suites and UI scenarios | Routing corpus, runner failure and source-change tests |
| R17: custom tiers and neutral defaults | Physical and Auto routing cases above | Config, schema, generated defaults and strategy tests |

## Manual-session regressions

The physical HTTP 402 pause, same-provider exclusion after restart, and same-tier HTTP 402 recovery live in [release acceptance](../tests/integration/release-acceptance.test.mjs). The empty global configuration case also checks that first-use setup saves a project configuration without changing the global file.

The exact OpenCode Go subscription error, one alternate attempt, disabled retry, exhausted alternatives, and no cross-tier escape live in [Auto reliability acceptance](../tests/integration/reliability-v2-auto.test.mjs). The parser still treats bare tier words as overrides; [issue 27](https://github.com/iamaamir/pi-bifrost/issues/27) tracks changing that behavior.

Classifier-timeout fallback, offline commands, billing preference, reviewed reconciliation, probes that outlast catalog freshness, and provider-to-model allowance-scope reload live in [command acceptance](../tests/integration/command-policy-acceptance.test.mjs). Precise callback cancellation and both allowance-scope reload directions are also tested through registered host handlers.

The first-use background scenarios check that the first response returns before probes finish, that saving does not interrupt active generation, and that the next input uses verified pools. They also check all-failed warnings without configuration writes, provider pauses, and concurrent configuration edits. The earlier one-shot scenario cancels its background probe at process exit and does not prove persistence. Final release evidence must come from the frozen-candidate verification manifest.

The audit repair adds finite branch checks. Source tests cover every on-disk layer and every prospective edit target, unsupported versions, intrinsic policy errors, legitimate partial overrides, last-good reload, bounded reads and deep graphs. Init tests cover normal and forced runs across fresh, existing-empty and unchanged-owned targets. They check exact source bytes, inherited private settings, later edits and fresh classifier use. The background restart case checks that a surviving model makes the saved default usable. Offline tests use an enabled classifier and an unmatched prompt; a direct-rule-only case cannot prove offline classification.

Provider projection tests require one state snapshot per nonempty decision and zero for an empty catalog. They check pause semantics, cross-revision consistency and failed reads. The performance script compares the actual pinned baseline export with the current export across memory and durable-file fixtures; each case checks identical projected state. Latency measurements are evidence, not timing assertions in unit tests.

## Limits

Fake providers prove Bifrost's supported behavior. They do not prove account access, live provider limits, billing accuracy, or compatibility with a different Pi version. Keep the final live-provider acceptance check separate. No coverage claim includes deferred image routing, automatic live quota lookup, or thinking-level policy.
