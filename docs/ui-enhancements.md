# Bifrost UI enhancement backlog

Inventory of user-facing extension improvements. Ordered by user value, then implementation risk. Minimal when things work; informative when asked; explicit and durable when something important happens. Follow the [product guardrails](product-philosophy.md).

This is the maintained UI backlog and acceptance reference. The 16 November UI/UX handoff's findings, design constraints and regression scenarios are consolidated here; that handoff is historical input, not a second implementation plan. Its local screenshots and proposed layouts do not establish delivery. Current repository contracts and the revised issue owners below govern implementation.

`Done` means present on `main`, not released. `Partial` identifies existing behavior with a remaining gap. `In review` means implemented on an unmerged PR; `Next` remains backlog, not implementation approval.

## Reconciliation baseline — 18 November 2026

- Inspected `main` at [`8c9f2f3`](https://github.com/iamaamir/pi-bifrost/commit/8c9f2f35d57d9c44607d74ad2dd93b665bd71263), plus [PR #240](https://github.com/iamaamir/pi-bifrost/pull/240) at `de3f536` and [PR #252](https://github.com/iamaamir/pi-bifrost/pull/252) at `e8d7109`. Both PRs are open: #240 targets `main`; #252 targets #240's `exp/init-notice-ui` branch. Review status is not merge or release evidence.
- #240 supplies shared probe progress, grouped failure notices, compact Setup preview and terminal init outcomes ([#245](https://github.com/iamaamir/pi-bifrost/issues/245)). [#248](https://github.com/iamaamir/pi-bifrost/pull/248) merged into that holding branch; [#251](https://github.com/iamaamir/pi-bifrost/pull/251) is closed with its copy change present in #240. Neither makes the foundation delivered on `main`. #252 removes jargon and duplicate/truncated tier summaries; exact model-level preview remains open.
- The revised [parent #235](https://github.com/iamaamir/pi-bifrost/issues/235) governs init: [#243](https://github.com/iamaamir/pi-bifrost/issues/243) preflight; [#253](https://github.com/iamaamir/pi-bifrost/issues/253) ordered whole-tier ownership and [#255](https://github.com/iamaamir/pi-bifrost/issues/255) scope protection before [#254](https://github.com/iamaamir/pi-bifrost/issues/254) shared planner; then [#244](https://github.com/iamaamir/pi-bifrost/issues/244) choice UX and [#246](https://github.com/iamaamir/pi-bifrost/issues/246) exact preview; [#256](https://github.com/iamaamir/pi-bifrost/issues/256) acceptance coverage. [#247](https://github.com/iamaamir/pi-bifrost/issues/247) tracks review hygiene, not new UX. Older PLAN-card/pre-probe-question proposals are superseded.

Fresh explicit init retains progress → review → one Yes/No. Existing configuration gets one post-probe Keep / Merge / Bifrost defaults decision for distinct meaningful outcomes, with consequences visible before selection and no second confirmation. Headless without `--write` must stop before network work; `--write` conservatively uses Keep for existing config. These are pending requirements, not claims about `main`. Preserve manual order, empty/deleted tiers, inherited sources, unrelated settings and transactional safeguards. ADR 0025 background first-use setup remains separate; no new wizard or destination picker.

Use handlers/planners to decide outcomes and renderers to format those same proposals. Reuse #240's notice/progress components after integration, with one primary surface per event; no parallel notice system or mandatory UI-directory rewrite. Remaining general UI work below does not expand #235.

## Output and lifetime contract

| Intent | Primary surface and lifetime |
|---|---|
| Mutable progress | One updating widget per operation, normally about three lines; never append a transcript entry per tick. |
| Pre-write review | Compact widget or suitable interactive view until approval, cancellation or transition; the approval question does not repeat the preview. Honor explicit `--write` and ADR 0025's separately authorized automatic setup. |
| Important outcome | One durable custom notice after owned widgets clear; retained for session replay, outside LLM context. Describe saved and activated states separately if reload fails. |
| Brief acknowledgement | Transient notification; do not also produce a card/widget for the same acknowledgement. |
| Detailed inspection | Existing dismissible result overlay; full reports remain accessible without an unconditional inline dump. |
| Persistent mode/health | Bifrost status slot; keep Pi's built-in footer. Distinguish intentional modes from degraded health. |
| Print/RPC/JSON | Existing plain-text fallbacks and machine-output contracts; no unresolved UI prompts or diagnostic pollution of JSON stdout. |

Classify existing output call sites by importance, lifetime, surface and cleanup owner as each slice is changed; do not blindly turn every log into a durable entry. Keep renderers separate from routing, eligibility, ownership and transaction decisions. Use small extractions only when needed, not a directory-layout project.

## Current UI surface

- Footer status: mode and transient classification progress.
- `/bifrost` dashboard: mode, current model, contextual quick actions.
- Autocomplete: subcommands and descriptions.
- Scrollable ephemeral overlay: preview and benchmark results; no session entries or LLM context.
- Widgets: init, providers, debug; init has live probe counts on `main`. Shared init/standalone-probe progress is in review (#240).
- Notifications: command result, warning, error.
- PTY smoke: startup, fresh physical/Auto setup, init refresh, dashboard, classifier, diagnostics, preview/trace/dismissal, strict rejection and reliability scenarios. Existing assertions are not a full width/theme/lifecycle matrix; see verification below.

## P0 — discoverability and safe control

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Done | Root dashboard | `/bifrost` shows state/model and action picker | Executes no-argument actions; pre-fills prompt commands. |
| Done | Command autocomplete | `/bifrost <Tab>` shows names/descriptions | Source: `BIFROST_COMMAND_OPTIONS`. |
| Done | Bad-command recovery | `/bifrost typo` opens command picker | Print/RPC gives warning. |
| Next | `help` alias | Explicit help for TUI/RPC/print | Reuse command metadata and examples. |
| Next | Hierarchical completion | Complete `cache ` and `classifier ` after first word | Flat matching works; nested flow clearer. Keep exact commands submit-ready without a double-Enter regression, and preserve bad-command recovery. |
| Next | Argument hints | Show prompt requirements in completion rows | Include `<prompt>` in labels/descriptions. |
| Partial | Contextual ordering | Promote useful actions based on state/config health | `dashboardCommands` already prioritizes effective on/off and pin/unpin actions; config-health/init guidance remains. |
| Next | Destructive confirmation | Confirm interactive cache clear; review config consequences before save | Cache clear is immediate. Init follows #235's single approval, not extra pre-probe/long-probe questions; explain forced-probe cost without a mandatory PLAN card. |

## P1 — routing visibility and explainability

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Done | Footer mode/progress | Mode plus classification activity visible | One Bifrost `setStatus`; Pi footer stays intact. |
| Next — prioritized | Last decision | Dashboard shows last actual route: tier/source/model/strategy/duration, exclusions/fallback or bypass reason | Capture actual physical selection/Auto dispatch, not a fresh preview or merely Pi's current model; distinguish pending/blocked outcomes. Show duration only when measured; no invented confidence. Session-local, ephemeral only; no prompt text, LLM context or durable per-turn entry. Reset on session/branch change. |
| Next | Thinking-level visibility | Show effective level and preserve/clamp reason after routing | Preserve Pi behavior by default; see [`ADR 0004`](adr/0004-thinking-level-routing.md). |
| Partial | Decision trace | Explain the actual classification path and candidate exclusions | `preview --trace` and structured trace output already exist; full stage timings remain deferred under [ADR 0007](adr/0007-decision-traces.md). Reuse existing records; omit prompt text by default in new surfaces. |
| Next | Switch feedback | Brief previous → selected model notice | Suppress no-op switches; distinguish manual pin. |
| Next | Bypass explanation | Explain disabled/pinned/no-match/missing-model | Show actual reason, not generic status. |
| Next | Cancellation | Abort long classification cleanly | Respect Pi abort lifecycle. |
| Next | Blocked-prompt notice | Durable reason, “not sent” outcome and one recovery action | `strictInputHandled` currently restores editor text best-effort and uses a transient error. Reuse notices after #240; preserve handled/dispatch safety, never overwrite newer editor text or claim restoration succeeded without evidence. Deduplicate repeats; do not persist prompt content. |

## P1 — results and long-running work

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Done | Built-in working row | Probe/refresh/preview/benchmark show work | No custom spinner needed. |
| Partial; shared UI in review | Probe progress widget | One updating progress widget for init, standalone probe and background first-use checks | `main` has init counts; #240 shares `ui/probe-progress.ts` across manual commands and clears on rejected/cancelled probes. Align background presentation with the same compact renderer without changing ADR 0025 timing. Keep completed/total, success/error/timeout/skipped facts accurate; no verbose recent-model stream by default. Overlap ownership remains below. |
| In review / remaining | Probe summary card | Compact health/failure summary with inspectable details | #240 adds grouped failures and durable notices, replacing standalone probe's immediately cleared results on `main`. Duration/report age/retry remain follow-ups; keep full-results access and a bounded fallback on hosts without expansion. |
| Partial; improvements in review / Next | Init review screen | Show actual proposal before its single approval | `main` already previews counts. #240 adds Setup preview; #252 improves tier-level copy. Exact model IDs/order, retained/inherited tiers, settings and project/global destination remain #244/#246 work from #254's actual transaction proposal. Suppress zero-delta noise without hiding real removals. Say Setup preview until saving; probe success proves access, not quality, and cost buckets are not quality rankings. |
| Done | Preview/benchmark result viewer | Scrollable tier/source/model/alternatives/costs | Ephemeral overlay; full output remains reachable with ↑↓/jk. |
| Next | Benchmark comparison | Sort/filter candidate metadata | Never run candidate models merely to populate this metadata view; classifier invocation remains governed by the existing command contract. General report readability is tracked below. |
| Next | Report summaries | Outcome first for preview, benchmark, classifier test, validate, inspect and debug | At 80 columns, show the conclusion before scrolling, then selection/evidence/alternates or actionable issues. Group advanced details in the existing overlay where suitable; preserve diagnostic traceability and existing JSON shape/bytes. |
| Partial | Result lifecycle | Dismiss, copy, rerun; pin only where useful | Overlay already closes with Esc; remaining widget lifecycle must not leave stale results covering the editor or duplicate a durable outcome. |
| In review / lifecycle follow-up | Durable important outcomes | One terminal notice with outcome, changes and next action | #240's `ui/notice.ts` and `reportInitOutcome` implement #245, including no-change, cancel, blocked, save and reload failures. Retain stderr fallback and actual routing-off state. Verify registration before append, unsupported-host fallback, session replay/reload and no stale API reference across sessions; no permanent `globalThis` API storage. General call-site deduplication remains; merge/review gates stay open. |
| Next | Widget operation ownership | Older work cannot update or clear a newer operation's widget/working row | Cover manual init/probe and background first-use overlap, late callbacks, cancellation, failure, reload and session changes. Extend existing lifecycle owners; test A finishing after B starts, not only `finally` cleanup. Define completion/new-command/dismiss transitions and verify widget clearing against supported Pi APIs rather than assuming empty arrays and removal are equivalent. |

## P1 — config and recovery

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Partial | Config health | Severity counts, source paths and one repair action | `validate`/`inspect` already report diagnostics; distinguish invalid config from absent/unverified models. Optional repair must be previewed, validated and recoverable, not silent rewriting. |
| Next — constrained by #235 | Guided setup | Low-friction init progress, exact review and single approval | Reuse existing discovery/generation; no provider/tier/classifier wizard. Keep fresh Yes/No, existing Keep/Merge/Defaults, protected inheritance and headless behavior from #235/#243–#256. |
| Next | Config editor | Change enabled/default/strategy/classifier in TUI | Explicit save, validation, rollback. |
| Next | Missing-model repair | Suggest available replacements | Never rewrite user config without confirm. |
| Partial | Stale probe indicator | Report age and re-probe action | Init now reports reused probe report file age and mtime as file metadata; a richer interactive stale/re-probe indicator remains future UI work. |
| Partial | Actionable errors | Outcome → explanation → one useful next step | #240 improves init and important failures in review; other commands remain. Describe write/reload results truthfully; never promise unchanged files after an uncertain transaction or suggest reloading an invalid file as repair. |

## P2 — cache and classifier management

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Cache dashboard | Entries/hit rate/threshold/capacity/update time | Add counters; avoid full scan per redraw. |
| Next | Cache browser | Search/inspect/delete individual mappings | Prompt-derived data is sensitive. |
| Partial | Cache expiry | Expose existing retention and deliberate bulk prune | `cache.ttlHours` and expiry-aware loading already exist; reuse them before proposing new policy/schema. |
| Partial | Classifier health | Readable model/backend/errors/latency/fallback summary | `classifier status` already exposes readiness, enablement source and persisted aggregates. Reuse existing metrics; label scope/sample size and do not invent session-only resets. |
| Partial | Classifier picker | Review backend/model, credential readiness, fallback and save scope before write | Picker already supports prompt, TypeSafe/Jev and Pi-native backends. Show the exact target path, preview/approve persistent changes and report one factual outcome. Explicitly distinguish project-file save from session-only `on`/`off`/`inherit`; retain explicit config until approval. Probe access/low cost is not evidence of classification quality. |
| Partial | Rule tester | Test rule order without dispatch | `preview --offline` already provides local routing without classifier calls; improve explanation using that path. |
| Next | Utility summaries | Compact provider/cache/reliability facts with drill-down | Reuse available catalog counts, cache stats and cooldown records. Distinguish catalog/auth/probe evidence; show remaining cooldown/recovery state, handle expired pauses and retain absolute time in details. No invented availability/live quota or new interactive prompts blocking scripts. |

## P2 — accessibility and polish

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Keyboard legend | Dashboard key instructions | Pi selector already handles keys. |
| Next | Color-independent state | Labels/icons with every color state | Footer already has labels; retain. |
| Partial; notice style in review | Notice theme and readability | Dim extension badge, semantic icon/title, muted optional detail and subtle theme-derived background | #240 supplies theme-based notice styling. Keep padding minimal, avoid duplicated badge/title text and fixed severity hex palettes; verify contrast in dark/light/custom themes without assuming a tool background is neutral. |
| Next | Narrow-terminal layout | Display-width-aware wrap/truncation; retain state/actions and full detail access | `result-viewer.ts` uses character `slice`/`padEnd` and a fixed 10-row window. Cover ANSI, wide/combining Unicode, long model IDs, terminal height and resize; smoke 80-column and smaller PTYs. |
| Partial | Plain-text parity | Same outcome/model/scope facts with mode-appropriate rendering | Existing stderr paths and #240 notices are foundations; #246/#256 require exact model detail and old-Pi fallback. Preserve RPC/print and structured `--json` contracts; no human notices on machine-output stdout. |
| Next | Notification rate limiting | Collapse repeats; never hide errors | Especially probe/routing notices. |
| Next | Severity semantics | Separate intentional modes and no-op/cancel from degraded/failed outcomes | `ux-status.ts` currently warning-colors off/pinned/classifier-off. Keep those neutral and invalid policy unmistakable. Classify status before reason: incomplete/stale advisory remains warning even with `no_changes`; ordinary no-op/decline/cancel is info, failed validation/write/reload is error. Preserve #240 outcome distinctions; no-op never means every model is verified. |
| Partial; copy in review | Terminology pass | Standardize tier/model/source/pinned/classifier | #240 improves inherited-pool wording; #252 removes init jargon. #246 retains exact preview/copy/docs work; general command cleanup is separate. Keep precise developer diagnostics available. |

## P2 — observability, testing, docs

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Session timeline | Recent tier/model/source/duration decisions | Ephemeral default; history opt-in. |
| Next | Sanitized diagnostics export | Config/probe/debug bundle | Exclude prompts/cache by default. |
| Next | Metrics summary | Cache/classifier/regex/default distribution | Session scope first; show sample size. |
| Done | Command picker unit tests | Completion and recovery behavior | `tests/bifrost-commands.test.ts` exists; new nested/help flows still need their own assertions. Existence is not a fresh pass receipt. |
| Done | PTY smoke harness | Real Pi/fake-provider scenarios and screenshots | `scripts/ui-smoke.py` currently pins Pi 1.4.0 and 120×36, with inventory/network/state and selected content assertions. Broader matrix remains open; harness existence is not proof of every interaction. |
| Next | Dashboard ANSI assertion | Assert selector content using reliable terminal state | Use agent-tui semantic assertions for new PTY interactions; preserve Python screenshots and existing assertions. Do not invest in its handwritten ANSI emulator. The opt-in POC already checks dashboard/overlay state; deterministic CI promotion is separate. |
| Partial; init acceptance Next | Interaction smoke | Select actions, cancel, confirm once, inspect details and finish cleanly | Existing Python smoke plus #240 init-outcome assertions; #256 owns the revised ownership/scope/action matrix, stale review, failed reload and headless no-network proof. Add overlapping-operation and notice replay/dedup coverage for their owners. Agent-tui remains a POC, not a replacement gate; see [evaluation](agent-tui-evaluation.md). |
| Next | Width/theme matrix | 80/120/160 columns plus narrow/short terminals; dark/light/custom/high contrast | Screenshot/text checks with Unicode, long IDs, resize, scrolling and old-Pi expansion fallback. Test outcome labels without relying on color. |
| Next | README UX guide | Dashboard, autocomplete, recovery examples | Derive docs from metadata where possible. |
| Partial | UI release checklist | Apply existing verification gates and add missing UX scenarios | Follow AGENTS.md and the coverage contract; current acceptance already runs on head/proposed merge. Keep focused tests, relevant Pi integration/UI/reliability evidence and screenshot review; agent-tui promotion requires deterministic fixtures and verified CI setup, not merely its dev dependency. |

## Verification coverage and remaining acceptance

These are source-inspected coverage boundaries at the baseline above, not newly executed test results or checked-off acceptance. Keep [AGENTS.md](../AGENTS.md), [coverage requirements](testing-coverage.md), [tooling](dev-tooling.md) and the [agent-tui evaluation](agent-tui-evaluation.md) authoritative for commands and gates; do not maintain a second command checklist here.

| Area | Existing evidence boundary | Remaining acceptance when that work is implemented |
|---|---|---|
| Discovery/dashboard | Command unit tests and Python PTY scenarios; opt-in agent-tui dashboard/overlay waits | Enabled/off/pinned/classifier-off/invalid policy; contextual actions, help/nested hints and exact-command single-Enter behavior. |
| Explicit init | `tests/integration/init-regression.test.mjs`, command tests and Python init-refresh; #240 adds terminal-outcome checks in review | #256's fresh/existing Keep/Merge/Defaults matrix; additions/removals/order, preserved unverified/manual/inherited/empty/deleted tiers, no-op/stale inventory, invalid proposal, lock/destination/catalog races, abort/decline, failed save/reload, exact bytes and one approval. Headless without `--write` must prove no network work. |
| Probe/background | Python fresh physical/Auto and init scenarios; existing first-use/command integration fixtures | Standalone empty/mixed/all-success/all-failure/cancel; accurate timeout/skipped counts and report path, no persisted partial-result claim; background overlap/session change, no new transcript entry per tick and no stale working row. |
| Notices and rejection | Registered strict-input coverage; #240 notice renderer/fallback tests in review | Durable Prompt not sent, specific cause/recovery and observed editor restoration; no overwrite of newer text, no provider dispatch and repeated-error dedup. Registration-before-append, replay/reload, light/dark style, unsupported host and expansion fallback; outcome survives owned-widget cleanup. |
| Classifier/config/cache | Existing picker/session-toggle/JSON/diagnostic command tests | Each backend, missing credentials, fallback and preview/save/no-write facts; distinguish session override from file save. Cache-clear cancel preserves bytes, scripted path remains intentional, cooldown timing handles expiry. |
| Reports/viewer | `tests/result-viewer.test.ts` checks ASCII wrapping, blank lines and Escape encodings; Python preview/trace/dismiss scenarios | All six report headlines/readable details; ANSI, wide Unicode/combining marks, long IDs/paths, narrow/short viewports, resize, arrows/jk/page keys/Escape and reachable close hint. Existing tests do not prove display-cell layout. |
| Theme/accessibility | Existing labeled footer and screenshots; #240 semantic notice colors in review | 80/120/160 columns plus smaller/short terminals; dark/light/unusual low-contrast themes; text/icon meaning without color; subtle background contrast and minimal padding. |
| Contracts/privacy | Existing guarded Pi integration, JSON and persistence tests | Machine-readable output stays compatible; print/RPC has no unresolved UI call. No prompts/cache content in notices or last-route state. UI-only changes preserve eligibility, strict fail-closed behavior and reconciliation semantics; #235's separately authorized domain changes retain their own owners/gates. |

For implementation, use the existing `test:quick` tier for local iteration (it includes typecheck but excludes four heavy root files); run touched heavy files and relevant integration/UI targets as required. Full root tests are not Pi E2E. The `test:ui:agent-tui` target remains opt-in and its current runner still uses a fixed local model, so it is not a deterministic CI replacement. Use bounded expected-state waits rather than spinner stability or new fixed sleeps, with isolated Pi/provider fixtures and daemon/session state. Preserve screenshot review separately from semantic snapshots. Record actual commands, counts, failures, fault-sensitive controls and exact revision; apply existing frozen-candidate acceptance/release requirements rather than treating green totals or this backlog as proof.

## Avoid unless requirement changes

- Replacing Pi footer: removes built-in model/context information.
- Widget for simple mode: status footer is right surface.
- Fake classifier confidence: show source, not invented precision.
- Silent config rewrites after model failure: require preview/confirmation.
- Persisting prompt history by default: privacy/session-noise cost.
- Parallel progress/notice frameworks, obligatory PLAN cards, redundant init approvals or a setup wizard: reuse the revised #235 contract and existing owners.

## Suggested order

1. Finish review/integration of #240/#252 under existing gates; preserve the #235 dependency order and verify through #256. Do not reopen completed foundation work or add unrelated UI scope to init.
2. Widget operation ownership and durable blocked-prompt feedback; extend lifecycle/interaction coverage with each change.
3. Last-decision dashboard row: actual tier/source/model/strategy, elapsed time and bypass/fallback reason. Ephemeral only.
4. `help`, nested completion, completion argument hints, remaining contextual guidance, cache-clear confirmation and config recovery.
5. Classifier save-scope clarity, severity/terminology consistency, compact reports/utility summaries and remaining cache/classifier metrics views.
6. Width/Unicode/theme matrix and UI release checklist accompany the affected UI work, rather than waiting for a broader rewrite.
