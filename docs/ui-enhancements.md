# Bifrost UI enhancement backlog

Inventory of user-facing extension improvements. Ordered by user value, then implementation risk. `Done` means current branch, not released.

## Current UI surface

- Footer status: mode and transient classification progress.
- `/bifrost` dashboard: mode, current model, contextual quick actions.
- Autocomplete: subcommands and descriptions.
- Scrollable ephemeral overlay: preview and benchmark results; no session entries or LLM context.
- Widgets: init, probe, providers, debug.
- Notifications: command result, warning, error.
- PTY smoke: startup, dashboard, disabled, classify, pinned.

## P0 — discoverability and safe control

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Done | Root dashboard | `/bifrost` shows state/model and action picker | Executes no-argument actions; pre-fills prompt commands. |
| Done | Command autocomplete | `/bifrost <Tab>` shows names/descriptions | Source: `BIFROST_COMMAND_OPTIONS`. |
| Done | Bad-command recovery | `/bifrost typo` opens command picker | Print/RPC gives warning. |
| Next | `help` alias | Explicit help for TUI/RPC/print | Reuse command metadata and examples. |
| Next | Hierarchical completion | Complete `cache ` and `classifier ` after first word | Flat matching works; nested flow clearer. |
| Next | Argument hints | Show prompt requirements in completion rows | Include `<prompt>` in labels/descriptions. |
| Next | Contextual ordering | Promote `on`, `unpin`, `init` when relevant | Derive from mode/config health. |
| Next | Destructive confirmation | Confirm cache clear/config overwrite/long probe | Cache clear currently immediate. |

## P1 — routing visibility and explainability

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Done | Footer mode/progress | Mode plus classification activity visible | One Bifrost `setStatus`; Pi footer stays intact. |
| Next — prioritized | Last decision | Dashboard shows tier/source/model/duration and bypass reason | Update after every normal prompt; ephemeral only, no LLM context or durable session entry. |
| Next | Thinking-level visibility | Show effective level and preserve/clamp reason after routing | Preserve Pi behavior by default; see [`ADR 0004`](adr/0004-thinking-level-routing.md). |
| Next | Decision trace | Cache → classifier → regex → default explanation | Reuse debug events; redact prompt by default. |
| Next | Switch feedback | Brief previous → selected model notice | Suppress no-op switches; distinguish manual pin. |
| Next | Bypass explanation | Explain disabled/pinned/no-match/missing-model | Show actual reason, not generic status. |
| Next | Cancellation | Abort long classification cleanly | Respect Pi abort lifecycle. |

## P1 — results and long-running work

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Done | Built-in working row | Probe/refresh/preview/benchmark show work | No custom spinner needed. |
| Done | Probe progress widget | Counts/errors/recent models | Remove at completion. |
| Next | Probe summary card | Health counts, duration, report age/path, retry | Compact default; drill-down optional. |
| Next | Init review screen | Compare proposal before config write | Highlight uncategorized/overwrite impact. |
| Done | Preview/benchmark result viewer | Scrollable tier/source/model/alternatives/costs | Ephemeral overlay; full output remains reachable with ↑↓/jk. |
| Next | Benchmark comparison | Sort/filter candidate metadata | Never run models for this view. |
| Next | Result lifecycle | Pin, dismiss, copy, rerun | Prevent stale widgets covering editor. |

## P1 — config and recovery

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Config health | Issues, source paths, reload action | Build on `validateConfig`. |
| Next | Guided setup | Provider → probe → tiers → classifier → write | Keep `/bifrost init` non-interactive path. |
| Next | Config editor | Change enabled/default/strategy/classifier in TUI | Explicit save, validation, rollback. |
| Next | Missing-model repair | Suggest available replacements | Never rewrite user config without confirm. |
| Next | Stale probe indicator | Report age and re-probe action | Init currently uses one-hour freshness. |
| Next | Actionable errors | Errors link to reload/init/probe/edit next step | Avoid diagnostics-only messages. |

## P2 — cache and classifier management

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Cache dashboard | Entries/hit rate/threshold/capacity/update time | Add counters; avoid full scan per redraw. |
| Next | Cache browser | Search/inspect/delete individual mappings | Prompt-derived data is sensitive. |
| Next | Cache expiry | TTL and bulk prune | Needs config/schema decision. |
| Next | Classifier health | Model/endpoint/errors/latency/fallback rate | Aggregate locally, reset on reload/session boundary. |
| Next | Classifier picker | Choose verified cheap probe model | Preserve explicit config until confirm. |
| Next | Rule tester | Test rule order without dispatch | Natural extension of preview. |

## P2 — accessibility and polish

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Keyboard legend | Dashboard key instructions | Pi selector already handles keys. |
| Next | Color-independent state | Labels/icons with every color state | Footer already has labels; retain. |
| Next | Narrow-terminal layout | Truncate IDs, retain state/actions | Smoke 80-column and smaller PTYs. |
| Next | Plain-text parity | Concise non-TUI output for every widget | Covers RPC/print. |
| Next | Notification rate limiting | Collapse repeats; never hide errors | Especially probe/routing notices. |
| Next | Terminology pass | Standardize tier/model/source/pinned/classifier | Apply code, README, debug output. |

## P2 — observability, testing, docs

| Status | Enhancement | Outcome | Notes |
|---|---|---|---|
| Next | Session timeline | Recent tier/model/source/duration decisions | Ephemeral default; history opt-in. |
| Next | Sanitized diagnostics export | Config/probe/debug bundle | Exclude prompts/cache by default. |
| Next | Metrics summary | Cache/classifier/regex/default distribution | Session scope first; show sample size. |
| Done | Command picker unit tests | Completion and recovery behavior | `tests/bifrost-commands.test.ts`. |
| Done | PTY smoke harness | Key TUI screenshots, including result overlay | `npm run test:ui`. |
| Next | Dashboard ANSI assertion | Assert selector content in smoke capture | Improve parser frame fidelity first. |
| Next | Interaction smoke | Select actions, cancel, destructive confirmations | Temp config/cache only. |
| Next | Width/theme matrix | 80/120/160 columns, default/high contrast | Screenshot and text snapshots. |
| Next | README UX guide | Dashboard, autocomplete, recovery examples | Derive docs from metadata where possible. |
| Next | UI release checklist | Unit, typecheck, smoke, screenshot review | Gate UI changes before release. |

## Avoid unless requirement changes

- Replacing Pi footer: removes built-in model/context information.
- Widget for simple mode: status footer is right surface.
- Fake classifier confidence: show source, not invented precision.
- Silent config rewrites after model failure: require preview/confirmation.
- Persisting prompt history by default: privacy/session-noise cost.

## Suggested order

1. Last-decision dashboard row: tier, source, model, elapsed time, and bypass reason. Ephemeral only.
2. `help`, nested completion, contextual dashboard ordering, and cache-clear confirmation.
3. Probe/init cards plus config health/recovery.
4. Cache/classifier dashboards and routing metrics.
5. Interaction smoke, width/theme matrix, UI release checklist.
