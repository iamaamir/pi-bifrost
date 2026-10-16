# Coverage contract

An end-to-end (E2E) test starts Pi, loads Bifrost, and checks what the user or provider can observe. A handler mock or screenshot alone is not E2E proof.

## For each change

When a feature changes routing, commands, or saved state, add or update a Pi E2E test. Use the local fake provider. Check the requested model, excluded models, retry count, visible result, and saved state where they apply. Use isolated homes and workspaces. The outbound guard must report no external requests.

When a user reports a failure, keep their error shape and sequence in a regression test. Show that the assertion detects the faulty behavior. Use an isolated older revision or a controlled fault in a temporary fixture. Keep production files and user state unchanged during this proof.

Some contracts need a different boundary. The resolve-only API uses an installed-package consumer test. File-system faults, lease races, and exact deadline boundaries use deterministic lower-level tests as well as the Pi happy and failure paths. State this distinction in review. Do not call these tests Pi E2E.

Two local provider fixtures exist. `scripts/fake-provider-server.mjs` is an HTTP server. Use it to check transport behavior: HTTP status codes, `retry-after`, stream failures, and full `pi` CLI runs. Pi's `fauxProvider` runs in-process. Use it to check dispatch identity, because it reports an exact `callCount` and the exact model argument. Reach it through `tests/fixtures/faux-harness.mjs`. That harness runs a fixture child behind the outbound guard with a credential-scrubbed environment, then opens a real AgentSession with the real Bifrost extension.

Before review, run `npm run verify:release` on a clean, frozen candidate. Attach its result manifest to the reviewed revision. If source changes during the run, rerun the full command on the final candidate. Partial reruns do not replace a failed manifest. The reviewer checks this map against the changed behavior and checks that assertions can fail for the reported regression.

## Release feature map

The requirement IDs come from [the PRD](../PRD.md). These rows name test boundaries, not percentages of coverage. More than one row can use the same user scenario.

| Requirement | Pi or consumer boundary | Deterministic support |
| --- | --- | --- |
| R01: explainable decisions | [Pi preview and status](../tests/integration/integration.test.mjs); [command acceptance](../tests/integration/command-policy-acceptance.test.mjs) | Routing pipeline and decision-envelope tests |
| R02: physical default, Auto, pin and off | [Physical controls](../tests/integration/legacy-behavior.test.mjs); [Auto dispatch](../tests/integration/auto-virtual.test.mjs) | Registered input and manual-control tests |
| R03: bounded recovery and no unsafe replay | [V1/V2 Auto recovery](../tests/integration/reliability-v2-auto.test.mjs); [HTTP 402 acceptance](../tests/integration/release-acceptance.test.mjs) | Tool, output, queue, cancellation and ownership guards |
| R04: chat-model pools | [Fresh catalog setup and background probe completion](../tests/integration/auto-virtual.test.mjs); [init probe regressions](../tests/integration/init-regression.test.mjs) | Pinned Pi catalog contract and model-type tests; all-failed background warning and no-write checks; image routing is deferred |
| R05: strict fallback | [Physical no-route](../tests/integration/legacy-behavior.test.mjs); [Auto boundary and reserve rejection](../tests/integration/auto-virtual.test.mjs); [provider scope dispatch](../tests/integration/provider-scope-acceptance.test.mjs) | Ordered fallback and requirement propagation tests; provider-scope intersection and per-tier scope tests |
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
| R17: custom tiers and neutral defaults | Physical and Auto routing cases above | Config, schema, generated defaults, provider-scope validation and strategy tests |

## Manual-session regressions

The physical HTTP 402 pause, same-provider exclusion after restart, and same-tier HTTP 402 recovery live in [release acceptance](../tests/integration/release-acceptance.test.mjs). The empty global configuration case also checks that first-use setup saves a project configuration without changing the global file.

The exact OpenCode Go subscription error, one alternate attempt, disabled retry, exhausted alternatives, and no cross-tier escape live in [Auto reliability acceptance](../tests/integration/reliability-v2-auto.test.mjs). The parser still treats bare tier words as overrides; [issue 27](https://github.com/iamaamir/pi-bifrost/issues/27) tracks changing that behavior.

Classifier-timeout fallback, offline commands, billing preference, reviewed reconciliation, probes that outlast catalog freshness, and provider-to-model allowance-scope reload live in [command acceptance](../tests/integration/command-policy-acceptance.test.mjs). Precise callback cancellation and both allowance-scope reload directions are also tested through registered host handlers.

The first-use background scenarios check that the first response returns before probes finish, that saving does not interrupt active generation, and that the next input uses verified pools. They also check all-failed warnings without configuration writes, provider pauses, and concurrent configuration edits. The earlier one-shot scenario cancels its background probe at process exit and does not prove persistence. Final release evidence must come from the frozen-candidate verification manifest.

The audit repair adds finite branch checks. Source tests cover every on-disk layer and every prospective edit target, unsupported versions, intrinsic policy errors, legitimate partial overrides, last-good reload, bounded reads and deep graphs. Init tests cover normal and forced runs across fresh, existing-empty and unchanged-owned targets. They check exact source bytes, inherited private settings, later edits and fresh classifier use. The background restart case checks that a surviving model makes the saved default usable. Offline tests use an enabled classifier and an unmatched prompt; a direct-rule-only case cannot prove offline classification.

Provider projection tests require one state snapshot per nonempty decision and zero for an empty catalog. They check pause semantics, cross-revision consistency and failed reads. The performance script compares the actual pinned baseline export with the current export across memory and durable-file fixtures; each case checks identical projected state. Latency measurements are evidence, not timing assertions in unit tests.

## Limits

Fake providers prove Bifrost's supported behavior. They do not prove account access, live provider limits, billing accuracy, or compatibility with a different Pi version. Keep the final live-provider acceptance check separate. No coverage claim includes deferred image routing, automatic live quota lookup, or thinking-level policy.
