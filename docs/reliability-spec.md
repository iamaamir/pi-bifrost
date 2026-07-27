# Pi-Bifrost Reliability System

Complete specification, implementation status, design rationale, and extension guide.

## Table of Contents

1. [Overview](#overview)
2. [Implemented: health-aware selection & circuit breaker](#implemented-health-aware-selection--circuit-breaker)
3. [Implemented: post-settlement failure tracking](#implemented-post-settlement-failure-tracking)
4. [Not yet implemented](#not-yet-implemented)
5. [Design decisions & rationale](#design-decisions--rationale)
6. [Mistakes, gotchas & learnings](#mistakes-gotchas--learnings)
7. [Test infrastructure](#test-infrastructure)
8. [How to add a feature](#how-to-add-a-feature)
9. [File map](#file-map)
10. [Configuration reference](#configuration-reference)

---

## Overview

Pi-Bifrost routes every user prompt through classification and model selection. In v0.1, if a selected model was producing errors, Bifrost would keep selecting it — the next prompt that matched the same tier would route to the same broken model again.

The reliability system adds **pre-send health filtering** and **post-settlement runtime-failure tracking**. Before routing, models known to be unhealthy are skipped. After a request fails, the failure is persisted so future prompts route around that model.

### Circuit states

```
CLOSED → failures ≥ threshold → OPEN (cooldown active)
OPEN  → cooldown expires     → HALF-OPEN (one trial allowed)
HALF-OPEN → trial succeeds   → CLOSED
HALF-OPEN → trial fails      → OPEN (2× cooldown)
```

---

## Implemented: health-aware selection & circuit breaker

### How it works (end to end)

1. User sends a prompt.
2. Bifrost classifies → selects requested tier + strategy.
3. `resolveModelWithFallback()` finds candidates, filters open-circuit models.
4. Healthy candidates go through selection strategy; open-circuit models are skipped.
5. If no healthy candidate remains in requested tier, falls back to configured default tier.
6. If default tier also empty, returns `all_tiers_exhausted`.
7. Selected model is checked for half-open state; if half-open, trial begins.
8. `pi.setModel(model)` switches Pi to selected model.
9. Pi sends request; agent processes.
10. On `agent_settled`, if terminal failure detected → circuit opens.
11. Next prompt skips that model.

### Key files

| File | Purpose |
|---|---|
| `reliability.ts` | Core logic: state, circuit, failure/success records, trial management, persistence |
| `routing.ts` | `resolveHealthyModel()` and `resolveModelWithFallback()` — filtering + tier fallback |
| `index.ts` | Wiring: trial begin, setModel failure tracking, agent_end/agent_settled hooks |
| `runtime-reliability.ts` | `RuntimeReliabilityTracker` — per-request pending-failure tracker |
| `config.ts` | `validateConfig()` — integer validation for reliability fields |
| `schema.json` | `ReliabilityConfig` JSON schema |

### Persistence

Circuit state saved to `.pi/bifrost-reliability.json` (configurable path). Format:

```json
{
  "version": 1,
  "models": {
    "provider/model-id": {
      "failures": [1785000000000],
      "openUntil": 1785003600000,
      "trialActive": false,
      "cooldownMultiplier": 2,
      "lastFailureAt": 1785000000000,
      "lastFailureSource": "setModel",
      "lastFailureReason": "500: simulated failure"
    }
  }
}
```

### Failure sources (what opens a circuit)

| Source | When | Code path |
|---|---|---|
| Probe error/timeout | `/bifrost probe` fails for a model | `applyProbeReliability()` → `recordModelFailure()` |
| setModel returns false | No API key for selected model | `index.ts` setModel error path |
| setModel throws | Auth check rejection in Pi AgentSession | `index.ts` try/catch around `pi.setModel()` |
| Terminal stream error | Assistant response ends with `stopReason: "error"` after Pi exhausts retries | `agent_settled` handler → `recordSetModelOutcome()` |

### Half-open circuit details

After cooldown expires, model enters **half-open** state:
- `getCircuitState()` returns `open: false, halfOpen: true` when `openUntil ≤ now` and no trial active.
- `index.ts` calls `beginTrial()` before routing to a half-open model.
- Trial success (`recordModelSuccess`) fully closes circuit.
- Trial failure (`recordModelFailure`) reopens circuit with `2× cooldownMultiplier`. Each subsequent trial failure doubles again.
- Trial flag resets on success or failure; stale trial flags are safe — they only affect state during the brief window between begin and settle.

---

## Implemented: post-settlement failure tracking

### Why post-settlement and not agent_end

Pi auto-retries on HTTP 5xx errors. Each retry creates a new low-level agent run that fires `agent_end`. If we recorded a failure on every `agent_end`, a single request that Pi retries 3 times would create 3 failure records, opening the circuit prematurely even if the 3rd retry succeeded.

`agent_settled` fires only after Pi has exhausted all retries and the run is truly final. We track pending failure per agent_end, but only commit to circuit state at agent_settled.

### RuntimeReliabilityTracker

```typescript
class RuntimeReliabilityTracker {
  begin(selectedModel: string): void
  observe(messages: readonly AssistantOutcome[]): void   // called on agent_end
  settle(): RuntimeFailure | undefined                     // called on agent_settled
}
```

- `begin()` records which model Bifrost selected for this run.
- `observe()` scans the last matching assistant message; if `stopReason === "error"`, sets pending failure.
- `settle()` returns the failure if the final settled run ended with error. Pi retries: each retry overwrites pending failure. Last retry succeeding clears it.

### Known limitation: recovered retry not tracked

If Pi retries and succeeds, `settle()` returns undefined — no failure recorded. The request that initially failed but recovered is treated as clean success. This is intentional for v2: we do not penalize models for transient issues Pi handles internally. A future `degradedHealth` policy can add optional scoring.

---

## Not yet implemented

### Provider-wide degradation (P3)

**Problem:** Three models on same provider, provider goes down. Each model gets independent circuit. One model hitting threshold doesn't protect the other two.

**Design sketch:**

```typescript
interface ProviderHealth {
  failures: number[];
  lastFailureAt?: number;
}

interface ReliabilityState {
  version: 2;
  models: Record<string, ModelRecord>;
  providers: Record<string, ProviderHealth>;  // new
}
```

Provider records incremented alongside model records. `resolveHealthyModel()` checks both. Config option: `providerFailureThreshold` (default: same as model threshold).

**Files:** `reliability.ts` (+provider record functions), `routing.ts` (+provider check in resolveHealthyModel), `tests/reliability.test.ts` (+provider-breaker tests), `tests/routing.test.ts` (+provider-breaker selection test).

**Acceptance:** Provider-breaker test in fake-server E2E: two fake models on same provider, both fail → provider circuit opens, both skipped.

---

### Fallback context-window guard (P3)

**Problem:** Fallback model (e.g., `economical`) may have smaller context window than requested model (e.g., `frontier`). Switching without checking context size can cause Pi to auto-compact or truncate history.

**Design sketch:**

```typescript
function checkFallbackContext(
  ctx: ExtensionContext,
  requested: Model,
  fallback: Model,
): { safe: boolean; warning?: string } {
  // Compare contextWindow; warn if fallback < current session context
  // Could access ctx.sessionTokenCount or estimate from ctx.model.contextWindow
}
```

Called in `resolveModelWithFallback()` before returning fallback. If unsafe, log warning, still use fallback (don't block routing), but notify user.

**Files:** `routing.ts`, `tests/routing.test.ts`.

**Danger:** Do NOT block routing on context mismatch. A circuit-open situation is already degraded; blocking would leave user with no model at all. Warn only.

---

### All-candidates-open policy improvements (P3)

Currently: `all_tiers_exhausted` fallback reason returned. User sees warning. Pi continues with current model.

**Gap:** Bifrost doesn't try to use the least-recently-failed model or pick the model with the closest cooldown expiry. It just reports exhaustion.

**Design sketch:** When all candidates are open, pick the one with nearest `openUntil` and show "all models unhealthy, using soonest-recovering model."

---

### Degraded-recovery scoring (P3)

**Problem:** Repeated "fail → Pi retries → succeeds" patterns are invisible. Model might be degrading but circuit stays closed because Pi always recovers.

**Design sketch:** Add `degradedCount` to `ReliabilityRecord`. Increment when a recovered retry happens (tracker sees first message error, last message success in same settlement). Configurable threshold opens circuit at degraded level without requiring hard failures.

**Danger:** Pi retry is internal implementation detail. A model that recovers on retry 1 is not necessarily degraded — it might have been a one-off network glitch. Need explicit policy: e.g., 5 recovered retries within window → open circuit.

---

### Multi-process state safety (P4)

**Problem:** Two Pi sessions in same repo write `.pi/bifrost-reliability.json` concurrently. Last write wins; intermediate state lost.

**Design sketch:**
1. File lock (flock on Unix) during read-modify-write.
2. Read current state, apply changes, write back atomically (write to temp + rename).
3. On write conflict, re-read and re-apply.

**Files:** `reliability.ts` (saveReliability, loadReliability).

**Acceptance:** Two processes writing concurrently → both changes preserved. Test with parallel node processes.

---

## Design decisions & rationale

### Why model-keyed state, not provider-keyed

Provider→model is a many-to-one relationship. A single provider outage should not disable every model from that provider (some may use different backends). Provider-level health is additive, not a replacement for model-level.

### Why JSON file, not SQLite or in-memory

Circuit state must survive Pi restart. JSON file in `.pi/` directory is zero-dependency, human-readable for debugging, and trivial to inspect. SQLite adds dependency complexity for a record that typically has < 20 entries. In-memory state vanishes on restart, which defeats the purpose of a circuit breaker.

### Why cooldown multiplier per-circuit, not global

A model that keeps failing after repeated half-open trials is likely persistently broken. Doubling cooldown each time protects against thrashing without requiring manual intervention. Global constant would either be too aggressive (long cooldown for one-time issues) or too lenient (short cooldown for persistent failures).

### Why trial flag is explicit, not inferred

`openUntil <= now` alone would mean "model is half-open." But the model might be half-open because no trial has started yet, OR a trial is in progress. `trialActive` disambiguates. Without it, a second concurrent request could also try the same half-open model, defeating the "one trial" guarantee.

### Why not retry same prompt on different model

Pi may have already streamed text or executed tools before the request failed. Replaying the prompt on a different model risks duplicating work. Pre-send filtering handles future requests; it does not rewrite history. See [ADR 0004](./adr/0004-thinking-level-routing.md) for similar thinking-level reasoning.

### Why disabled reliability still has behavioral knobs

`reliability.enabled: false` disables filtering (all models treated as healthy), disables failure recording (no state mutations), and causes dashboard to report 0 open circuits. This was a deliberate fix: v1 draft had `openCircuitCount()` and `applyProbeReliability()` ignoring the enabled flag, causing confusing UI (dashboard said "circuits 3 open" while routing ignored them).

---

## Mistakes, gotchas & learnings

### 1. Pi's `pi.setModel()` throws, not returns false

**What happened:** Initial v1 implementation checked `const ok = await pi.setModel(model); if (!ok) recordFailure(...)`. But Pi's `AgentSession.setModel()` **throws** when auth is missing — the `!ok` branch was never reached. Thrown errors skipped `selfSelecting = false`, leaving Bifrost stuck ignoring manual model selections.

**Fix:** Wrap in try/catch. Both false return AND thrown error record circuit failure and clear selection guard. See `index.ts` setModel block.

**Test:** `tests/runtime-setmodel-throw.test.ts` — mocks both false-return and throw paths.

---

### 2. Malformed-but-valid JSON crashes routing

**What happened:** Initial `loadReliability()` validated only `version` and `typeof models === "object"`. A file like `{"version":1,"models":{"x":{"failures":"invalid"}}}` was accepted. Later `pruneFailures()` called `failures.filter()` which threw `TypeError: failures.filter is not a function` — crashing routing on every prompt.

**Fix:** `normalizeRecord()` validates every field. `pruneFailures()` accepts `unknown`, returns `[]` for non-arrays. `filter()` callback is type-guarded (`ts is number`). See `reliability.ts`.

**Test:** `tests/reliability.test.ts` — "fails open with malformed-but-valid JSON records." Mixed invalid fields (`"invalid"`, `{}`, `NaN`, `Infinity`) all discarded.

---

### 3. `agent_end` fires per retry, not per request

**What happened:** Initial design called `recordModelFailure()` directly on `agent_end`. Every Pi retry created a new failure record, so one request that Pi auto-retried 3 times would open the circuit in a single turn.

**Fix:** `RuntimeReliabilityTracker` absorbs per-retry events. Only `agent_settled` commits. Each `observe()` overwrites pending failure with the latest terminal assistant message; last successful retry clears it.

**Test:** `tests/runtime-reliability-tracker.test.ts` — "does not report failure when Pi retry succeeds."

---

### 4. `PI_CODING_AGENT_DIR`, not `PI_AGENT_DIR` or `HOME`

**What happened:** Fake-server E2E tried to isolate Pi config by setting `PI_AGENT_DIR` and `HOME` — both ignored. Pi uses `PI_CODING_AGENT_DIR` internally (`config.js`, `ENV_AGENT_DIR`). Two hours wasted debugging "where are my custom models?"

**Fix:** E2E script uses `PI_CODING_AGENT_DIR`. Documented in this file.

---

### 5. Fake server: HTTP 500 triggers retry, broken streams do not

**What happened:** `fail-then-ok` scenario: first attempt returns broken SSE stream, expect Pi to retry. Pi does NOT auto-retry on broken streams — only on HTTP-level errors (500, 503). Broken stream is treated as terminal error immediately.

**Fix:** Scenario changed to test "healthy model creates no false circuit" instead. `fail-then-ok` model changed to use HTTP 500 (which DOES trigger retry) on first attempt, SSE success on second.

---

### 6. SSE `finish_reason: null` causes Pi to continue generating

**What happened:** Fake server sent `finish_reason: null` in SSE chunks, then `[DONE]`. Pi interpreted `[DONE]` without a prior `finish_reason: "stop"` as a dangling stream and tried to continue, generating additional requests. Circuit opened even after a successful retry because Pi kept going.

**Fix:** SSE response sends `finish_reason: "stop"` in the content chunk. Pi sees a clean completion and stops.

---

### 7. Half-open design evolved through three iterations

**V1 thought:** "After cooldown, model is immediately healthy again." → Wrong: a broken model would repeatedly fail, open circuit, wait, fail again. Thrashing.

**V2 thought:** "Double the cooldown each time." → Better, but still allows unlimited parallel requests when cooldown expires, all of which could fail.

**V3 (shipped):** Half-open with trial flag. Only ONE request can trial a half-open model. Success closes circuit. Failure doubles cooldown AND clears trial flag (so next expiry gets a new single trial).

---

### 8. Disabled reliability reported stale circuits

**What happened:** When `reliability.enabled: false`, routing correctly ignored circuits. But `openCircuitCount()` still counted persisted open records, and `applyProbeReliability()` still wrote state. Dashboard showed "circuits 5 open" while routing used all models.

**Fix:** `openCircuitCount()` returns 0 when disabled. `applyProbeReliability()` is a no-op when disabled. Dashboard test added: "shows no open circuits when reliability is disabled."

---

## Test infrastructure

### Unit tests: 146 tests, 48 suites

```bash
npm test                 # all unit tests
npm run typecheck        # TypeScript strict mode
```

Key test files:
- `tests/reliability.test.ts` — 8 tests: threshold, cooldown, reset, persistence, corrupt state, half-open success, half-open failure
- `tests/routing.test.ts` — resolveHealthyModel, resolveModelWithFallback, all_tiers_exhausted
- `tests/runtime-reliability-tracker.test.ts` — terminal error, retry recovery, unrelated model
- `tests/runtime-reliability.test.ts` — end-to-end simulation
- `tests/runtime-setmodel-throw.test.ts` — setModel false vs throw paths

### Fake provider E2E: deterministic HTTP/SSE server

```bash
npm run test:ui:reliability   # 3 scenarios
```

Server: `scripts/fake-provider-server.mjs`
- No dependencies beyond Node.js built-ins
- Models: `fail` (500), `quota` (429+Retry-After), `fail-then-ok` (500 then success), `partial` (SSE then socket destroy), any other → healthy SSE
- Stats endpoint: `/_stats` for request counts
- Self-contained: no global state, no external process requirements

Scenarios (`scripts/ui-reliability-fake-provider.sh`):
1. Stream failure opens circuit, follow-up preview shows `xx` skip
2. Quota/429 opens circuit
3. Healthy model creates no false circuit

Runner uses `agent-tui` for PTY management:
- `PI_CODING_AGENT_DIR` isolates custom provider config
- Per-scenario temp directories, daemon lifecycle, cleanup
- File-polling circuit state (not screen-scraping) for reliable assertions

### Visual smoke: unchanged

```bash
npm run test:ui            # Python PTY screenshots
npm run test:ui:agent-tui  # agent-tui behavioral smoke
```

---

## How to add a feature

### Adding a new circuit state field

1. Add field to `ReliabilityRecord` interface in `reliability.ts`.
2. Add normalization in `normalizeRecord()` (defensive: check type, finiteness).
3. Update `getCircuitState()` to expose it.
4. Update `recordModelFailure()` / `recordModelSuccess()` to set/clear it.
5. Add unit test: create state, mutate, check circuit.
6. Add persistence test: save, reload, verify field survives.
7. Add malformed-state test: field with wrong type → normalized away.
8. Run `npm test` + `npm run typecheck`.

### Adding a new failure source

1. Identify where in the request lifecycle the failure occurs (probe, setModel, agent_settled).
2. Call `recordModelFailure()` or `recordSetModelOutcome()` with descriptive `source` string.
3. Add unit test: simulate that failure path, assert circuit opens.
4. If it's a post-selection runtime failure:
   - Must use `RuntimeReliabilityTracker` flow (begin → observe per agent_end → settle at agent_settled).
   - Must NOT record on agent_end directly.
5. Add E2E scenario if the failure source can be deterministically triggered through the fake server.

### Adding an E2E scenario

1. Add model behavior to `scripts/fake-provider-server.mjs`.
2. Create bifrost.json config that routes to that model.
3. Add phase to `scripts/ui-reliability-fake-provider.sh` using the existing `start_pi`, `prompt`, `poll_until` helpers.
4. Assert with file-polling (`poll_until` / `grep` on circuit file) over screen-text waits.
5. Verify: `AGENT_TUI_BIN=/path/to/agent-tui npm run test:ui:reliability`.

### Architecture rules

- `reliability.ts` is pure state machine. No Pi context, no ExtensionContext, no side effects other than file I/O.
- `routing.ts` calls `reliability.ts` for circuit state; never mutates reliability state directly.
- `index.ts` is the only place that wires Pi events (agent_end, agent_settled, model_select) to reliability mutations.
- `runtime-reliability.ts` is stateless between begin/settle; one instance per Bifrost session.
- `commands.ts` calls `reliability.ts` for probe-health integration; exposes circuit count in debug/dashboard.
- Test files mirror source structure: `tests/reliability.test.ts` tests `reliability.ts`, etc.

---

## File map

```
reliability.ts                       # Core state machine, persistence, circuit logic
runtime-reliability.ts               # Per-request pending-failure tracker
routing.ts                           # resolveHealthyModel, resolveModelWithFallback
index.ts                             # Pi event wiring, trial begin, setModel error handling
commands.ts                          # openCircuitCount, applyProbeReliability, dashboard/debug
config.ts                            # validateConfig reliability fields
schema.json                          # ReliabilityConfig JSON schema

tests/reliability.test.ts            # 8 tests: core circuit behavior
tests/routing.test.ts                # Healthy model resolution + fallback
tests/runtime-reliability-tracker.test.ts  # 3 tests: tracker behavior
tests/runtime-reliability.test.ts    # E2E simulation
tests/runtime-setmodel-throw.test.ts      # 2 tests: setModel error paths
tests/bifrost-commands.test.ts       # Dashboard circuit count + disabled
tests/config.test.ts                 # Config validation: integer checks

scripts/fake-provider-server.mjs     # Deterministic OpenAI/SSE fixture
scripts/ui-reliability-fake-provider.sh  # 3-scenario E2E matrix

docs/reliability-v1-review.md        # Original implementation review
docs/adr/0004-thinking-level-routing.md  # Related: thinking-level clamping
```

---

## Configuration reference

```json
{
  "reliability": {
    "enabled": true,
    "failureThreshold": 3,
    "windowMinutes": 5,
    "cooldownMinutes": 60,
    "path": ".pi/bifrost-reliability.json"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable circuit-breaker based model health filtering |
| `failureThreshold` | integer ≥ 1 | `3` | Open circuit after this many failures within windowMinutes |
| `windowMinutes` | integer ≥ 1 | `5` | Rolling failure window in minutes |
| `cooldownMinutes` | integer ≥ 1 | `60` | How long circuit stays open before half-open trial |
| `path` | string | `.pi/bifrost-reliability.json` | Custom path for persisted state (relative to cwd, or absolute) |

Validation: all three numeric fields must be finite integers ≥ 1. Non-integer values rejected at config load.
