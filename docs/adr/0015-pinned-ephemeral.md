# ADR 0015: `pinned` is ephemeral, `enabled` is persisted

## Status

Accepted

## Context

When an outer orchestrator pins a model, subagents inherit the same `pinned: true` state via the shared `.pi/bifrost-state.json` file. This prevents subagents from routing through bifrost independently.

Root cause analysis revealed two distinct persistence mechanisms:

- **`bifrost.json` (config)** — `enabled` as a default/fallback value, read by `loadConfig()`
- **`bifrost-state.json` (state)** — `enabled`, `pinned`, `classifierEnabled` as runtime overrides, read by `loadRuntimeState()`

The orchestrator wrote `{"enabled": false}` to `.pi/bifrost.json`, which propagated to subagents via config merge. Separately, `pinned` was persisted to the state file and inherited by children sharing the same cwd.

## Decision

Two semantic changes:

### 1. `pinned` is session-local (pi-bifrost)

- `loadRuntimeState()` always returns `pinned: false`, ignoring file content
- `saveModeState()` omits `pinned` from the write
- Mental model: `enabled` = policy (persisted), `pinned` = session preference (ephemeral)

### 2. Orchestrator stops writing `enabled: false` (bifrost-patterns)

- Remove `writeFileSync(... '{"enabled":false}' ...)` from workspace setup
- Subagents boot with `config.enabled: true` (default) and route normally

## Consequences

- Parent can pin a model for its own session; subagents inherit `enabled: true` + `pinned: false`
- `/bifrost pin` still works within a session — survives reload but not restart or child spawn
- Old state files with `pinned: true` are silently ignored on load
- Tests updated to assert `pinned: false` on load regardless of file content
