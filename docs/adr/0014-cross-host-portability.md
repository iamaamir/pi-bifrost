# 0014 — Cross-host portability strategy

## Status

**Proposed** (2026-07-28). Pending review.

## Context

Bifrost's core policy modules — config, routing, classifier, cache, reliability, inline-override — operate on data structures and have no host-UI dependency. Pi-specific code is concentrated in a thin adapter layer:

| File | Role | Host dependency |
|---|---|---|
| `index.ts` | Event wiring, model switching, settle observation | Pi session events |
| `commands.ts` | `/bifrost` command handlers | Pi command registration |
| `ux-status.ts` | Dashboard status rendering | Pi `setStatus` |
| `result-viewer.ts` | Benchmark/result display | Pi TUI overlay |
| Probe transport | `probe.ts` calls Pi session | Pi session API |

The competitive analysis (§3.5) identifies this seam as a portability advantage. A second host needs a new adapter, not a new routing engine.

Recent ecosystem research confirms this is a genuine opportunity:

- **Claude Code** has NO equivalent to Bifrost despite a mature plugin system (36,000★ `musistudio/claude-code-router` is an external proxy, not a plugin). The closest hook-based solution is `tzachbon/claude-model-router-hook` (46★, keyword-only classification). Claude Code has `UserPromptSubmit`, `PreToolUse`, `SessionStart` hooks but no `BeforeModel` hook — meaning model selection cannot be intercepted at the switching API; it must be set before the turn starts.

- **OpenCode** hosts `model-router`, `model-fallback`, and `autopilot` as plugins, but none combine Bifrost's classifier + cache + reliability + rules + pin in a single in-process extension.

- **Gemini CLI** adopted a `BeforeModel` hook in 2026 (GitHub issue #9070), which would be the ideal hook point for Bifrost-style routing — but no Bifrost equivalent exists there either.

The strategic case for portability: Bifrost can become the model router for multiple coding agents, not just pi. The competitive risk of NOT doing this is that each ecosystem independently re-implements worse versions of the same capability.

However, premature portability creates maintenance burden. Porting before the core is stable means multiplying bugs across hosts. Porting before the adapter interface is clean means painful refactoring.

## Decision

### 1. Adapter principle

**One capability interface per host. Shared policy library. No proxy.**

```
┌─────────────────────────────────────────┐
│              Shared core                 │
│  config, routing, classifier, cache,    │
│  reliability, inline-override, trace     │
└──────────┬──────────────┬───────────────┘
           │              │
           ▼              ▼
┌──────────────────┐ ┌──────────────────┐
│  Pi adapter      │ │  Claude Code     │
│  (existing)      │ │  adapter (new)   │
│  index.ts        │ │  hooks +         │
│  commands.ts     │ │  settings.json   │
│  ux-status.ts    │ │  setModel        │
└──────────────────┘ └──────────────────┘
```

- The shared core is published as a library (npm package: `@bifrost/core`).
- Each host adapter depends on `@bifrost/core` and implements a thin translation layer.
- No adapter calls another adapter. No shared state between host instances.
- No proxy server. Routing decisions happen in-process on the host's event loop.

### 2. Capability interface

Each host adapter implements (or documents as unavailable) these capabilities:

| Capability | Pi implementation | Claude Code implementation | Notes |
|---|---|---|---|
| `modelRegistry()` | `pi.model.list()` → provider/id/cost/context | `fs.readdir(~/.claude/plugins/providers/)` + provider metadata | Must return same shape for core |
| `setModel(id)` | `pi.setModel(providerId, modelId)` | Write `model` to `settings.json` before next turn | Claude Code has no API; file write is best-effort |
| `onPrompt(callback)` | `ctx.on("user_prompt_submit", callback)` | `UserPromptSubmit` hook | Both have this |
| `onSettle(callback)` | `ctx.on("agent_settled", callback)` | `PostToolUse` + stream end observation | Weaker in Claude Code |
| `probe(id)` | `pi.session.send("probe", { model: id })` | `promptAsync("hello", { model: id })` | Different transport |
| `status(msg)` | `pi.setStatus("bifrost", msg)` | `console.error` or hook meta | Pi has richer status API |
| `commands(cmds)` | `pi.registerCommand(...)` | Hook `command` registration | Similar in both |

### 3. What the shared core provides

The `@bifrost/core` library exports:

- `loadConfig(paths)` — config loading, layering, validation
- `ClassificationPipeline` — cache → classifier → regex → default
- `resolveCandidates(tier, registry)` — pattern matching + strategy selection
- `ReliabilityStore` — circuit state machine, persistence, I/O
- `parseInlineOverride(prompt, models)` — first-word tier override
- `RoutingDecisionTrace` — struct definition + JSON serialisation
- `normaliseFailure(errorText)` — category normaliser (ADR 0012)
- `DEFAULT_CONFIG`, `DEFAULT_RULES` — portable defaults (ADR 0006)

The library has ZERO host imports. It imports only standard TypeScript types and `node:fs` for reliability persistence.

### 4. Claude Code adapter approach

Since Claude Code has no `BeforeModel` hook, the adapter uses a two-phase approach:

**Phase 1 — Pre-turn model routing (best-effort):**
1. `UserPromptSubmit` hook fires with prompt text.
2. Adapter runs classification pipeline (cache → classifier → regex → default).
3. Selected model ID is written to `~/.claude/settings.json`'s `model` field BEFORE the hook returns.
4. Claude Code uses the updated `model` for the upcoming turn.

**Limitations:**
- Race condition if two prompts arrive before the file write propagates.
- Settings.json write is not atomic with the turn start.
- No `setModel` confirm/error feedback.

**Phase 2 — Reliability observation:**
1. `PostToolUse` hook observes the turn outcome.
2. On error, adapter records failure via `ReliabilityStore.recordFailure()`.
3. On success, adapter records settlement via `ReliabilityStore.recordSettlement()`.

**Phase 3 — Future-proofing:**
If Claude Code adds a `BeforeModel` hook (as Gemini CLI did in 2026), the adapter switches to direct model interception. The pipeline logic is unchanged — only the call site moves from `UserPromptSubmit` to `BeforeModel`.

### 5. Porting sequence

Do not port until Bifrost core reaches at least stage 2 of the winning sequence (ADR 0013). Rationale: porting before the core has scenario coverage means debugging routing bugs across two hosts simultaneously.

| Stage | Core prerequisite | Port action |
|---|---|---|
| 1 (Trust) | Decision trace + config lint + failure taxonomy shipped | Define capability interface |
| 2 (Predictability) | Scenario corpus + preview parity validated | Build Claude Code adapter prototype |
| 3 (Suitability) | Context eligibility + probe scoring | Test adapter against corpus |
| 4 (Control) | Modes + fallback chains shipped | Ship Claude Code adapter v1 |
| 5 (Expansion) | Second host adapter validated | Consider OpenCode adapter |

### 6. Explicit non-goals

- **Do NOT build a generic multi-host CLI tool** that wraps `pi-bifrost + claude-bifrost + opencode-bifrost`. Each host installs its own adapter. A unified CLI is a product, not an architectural layer.

- **Do NOT build a proxy server** for model selection. The competitive analysis (§3.4) identifies proxy-as-default as a maintenance and security anti-pattern. Proxy is a last-resort adapter strategy, used only when a host has NO plugin/extension API for model switching.

- **Do NOT port every Pi-ism.** `commands.ts`, `ux-status.ts`, and `result-viewer.ts` are Pi-specific TUI code. Claude Code has different UX primitives (hooks, meta, console). Each adapter owns its UX; the shared core owns policy.

- **Do NOT share reliability state between hosts.** Pi's model registry differs from Claude Code's. A model that fails in Pi may work in Claude Code (different provider key, different endpoint). Each host adapter instantiates its own `ReliabilityStore` with its own JSON file.

- **Do NOT attempt a second adapter before the first one has shipped and been used for at least one release cycle.** The adapter interface will be wrong until it has been implemented at least twice.

## Consequences

### Positive

- **Ecosystem reach.** Bifrost becomes the model router for multiple coding agents, not just pi. Users who switch between Pi and Claude Code keep their routing policy.
- **Validates the adapter seam.** The portability claim in the competitive analysis becomes testable evidence, not architectural speculation.
- **Shared improvement.** A routing improvement to the core benefits all hosts. A bug fix in the core ships to all adapters simultaneously.
- **Reduces ecosystem fragmentation.** Each coding agent ecosystem is independently re-inventing model routing. Bifrost offers a shared, battle-tested core.

### Negative

- **Maintenance burden.** Each adapter requires CI, issue triage, and release management. `@bifrost/core` must not break adapter compatibility without a major version bump.
- **Host hook API instability.** Claude Code's plugin system is newer than Pi's extension API. Hook signatures, timing guarantees, and capabilities may change. The adapter must absorb these changes without disturbing the core.
- **No BeforeModel hook in Claude Code.** The settings.json approach is inherently racy. Some users may see routing failures because the model change didn't propagate before the turn started. Mitigation: document the limitation clearly; switch to `BeforeModel` if/when Claude Code adds it.
- **Cost of getting it wrong.** An adapter that silently fails to route (e.g. settings.json write fails but the hook succeeds) is worse than no adapter at all — the user thinks routing is active but it isn't.

### Migration

- No migration for existing users. The Pi adapter continues to work unchanged.
- `@bifrost/core` is extracted from the existing codebase. The first extraction preserves file structure (config.ts → @bifrost/core/config.ts) with no behaviour changes.
- The Pi adapter becomes the reference implementation for the capability interface. The Claude Code adapter is the first test of the interface's completeness.
