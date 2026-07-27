# Reliability v1 implementation review

## Verdict

**Changes are promising but not merge-ready.** Health-aware selection, default-tier fallback, persisted state, probe integration, UI visibility, schema support, and test coverage are all present. Resolve P1 findings before merge.

## What was reviewed

Uncommitted reliability-v1 implementation:

- `reliability.ts`
- routing changes in `routing.ts`
- extension/runtime changes in `index.ts`
- command/probe/UI changes in `commands.ts`
- config/schema/test changes

## Verification run

```text
npm test           # 133 pass
npm run typecheck  # pass
npm run test:ui    # pass
```

`crit` review also completed with no human comments.

## Strengths

- Circuit state is model-keyed and persisted outside user config.
- Candidate filtering happens before model selection; open models are skipped.
- Requested tier falls back to configured default tier only when no healthy requested candidate remains.
- Preview/benchmark surfaces skipped candidates and fallback reason.
- Probe results close/open circuits using explicit success/error/timeout handling.
- `reliability.enabled: false` correctly bypasses filtering in `resolveHealthyModel`.
- Core unit coverage covers threshold, cooldown state, probe-success reset, persistence, healthy selection, and default-tier fallback.

## Findings

### P1 — thrown `pi.setModel()` failures bypass circuit recording

**Location:** `index.ts`, model-switch path around `await pi.setModel(model)`.

The new failure recording executes only when `pi.setModel()` returns `false`.

In installed Pi `0.82.0`, `AgentSession.setModel()` throws when provider auth is unavailable:

```ts
if (!(await this._modelRuntime.checkAuth(model.provider))) {
  throw new Error(`No API key for ${model.provider}/${model.id}`);
}
```

A thrown failure skips `recordModelFailure`, `saveReliability`, `selfSelecting = false`, and Bifrost's user-facing error path. `finally` clears UI status, but does not clear `selfSelecting`.

**Impact:** Missing credentials do not open circuit; repeated routing can keep selecting broken model. `selfSelecting` may remain true, causing next real manual model selection to be ignored.

**Required fix:** Wrap `pi.setModel()` in `try/catch/finally` at switch scope. On either returned `false` or thrown rejection:

1. clear `selfSelecting`;
2. record/save failure with sanitized error reason;
3. set `forceRegistryRefresh` as appropriate;
4. log/notify and return `defaultAction`.

**Required test:** mock `pi.setModel()` rejection, then assert persisted failure/open circuit and that subsequent selection can still react to a manual `model_select` event.

---

### P1 — valid-but-malformed persisted reliability JSON can crash routing

**Location:** `reliability.ts`, `loadReliability()` and `pruneFailures()`.

`loadReliability()` validates only top-level `version` and `models` being an object. A syntactically valid file such as:

```json
{
  "version": 1,
  "models": {
    "openai/demo": { "failures": "invalid" }
  }
}
```

is accepted. Later `getCircuitState()` calls `failures.filter(...)`, throwing `TypeError: failures.filter is not a function` during routing.

Reproduction against current diff:

```text
getCircuitState({ version: 1, models: { "openai/demo": { failures: "invalid" } } }, ...)
# TypeError: failures.filter is not a function
```

The existing corrupt-file test covers invalid JSON syntax only, not valid JSON with invalid shape.

**Impact:** User-editable/corrupted state file can break every routed prompt instead of failing open.

**Required fix:** Parse and normalize records defensively at load time. Accept only finite numeric failure timestamps, finite numeric `openUntil`, and string metadata; otherwise drop invalid values/records and return usable empty state. Also make `pruneFailures()` robust against non-array input as final boundary.

**Required test:** load valid JSON with `failures: "invalid"`, `failures: {}`, and mixed invalid timestamps. Assert routing continues and malformed fields are discarded.

---

### P2 — disabled reliability still reports old circuits and writes probe successes

**Locations:** `commands.ts`, `openCircuitCount()` and `applyProbeReliability()`.

When `reliability.enabled` is false:

- `resolveHealthyModel()` correctly ignores circuits;
- `openCircuitCount()` still counts persisted open records because `getCircuitState()` does not consult `enabled`;
- successful probe results still create/clear/save state because `recordModelSuccess()` has no enabled guard.

**Impact:** Dashboard/debug can say `circuits N open` while routing intentionally ignores them. Disabled feature still mutates reliability state on probe.

**Suggested fix:** Return zero from `openCircuitCount()` when disabled. Make `applyProbeReliability()` a no-op when disabled, including no save. Add disabled probe/dashboard tests.

---

### P1 — no post-selection provider-failure feedback loop

`tests/runtime-reliability.test.ts` directly calls `recordModelFailure(..., "setModel", ...)`; it does not exercise extension runtime behavior. `setModel` auth/selection failure is not a provider request failure.

This creates harmful routing behavior:

1. Bifrost selects model X successfully.
2. X hits quota, connection reset, or `Streaming response failed` during generation.
3. Pi retries X; it may eventually fail, or repeatedly recover only after retry.
4. User asks a follow-up such as “what happened?”
5. Bifrost has no health signal from failed/degraded request and can select X again.

The model is faulty from user perspective, but current circuit state remains healthy. This can cause repeated broken turns and route a recovery question back to the same provider/model.

**Required fix:** add a post-selection failure feedback loop for future routing. Pi `agent_end` includes completed low-level-run messages, while `agent_settled` fires only after Pi has exhausted automatic retry/compaction/queued continuation. Track a Bifrost-owned run health record:

- Capture selected model key before request starts; do not infer it later from mutable `ctx.model`.
- On `agent_end`, inspect terminal assistant failure metadata (`stopReason: "error"` / error message) and record candidate failure/recovery evidence for that run.
- Defer circuit mutation until `agent_settled`, so Pi's own retries are not counted as independent user-visible failures.
- If final settlement still failed, record a hard failure and persist it. Future prompts then skip/open-circuit model normally.
- If Pi recovered after retry, record degraded/recovered telemetry. Decide explicitly whether repeated recovered failures count toward a lower-weight or normal threshold; do not pretend they are clean success.
- Never replay current prompt automatically in V1. A stream may have emitted text or triggered tools, so replay risks duplicate work.

**Required tests:**

1. terminal stream error after successful selection opens/advances circuit only after final `agent_settled`;
2. Pi retry that succeeds does not mark hard failure;
3. repeated recovered retries affect documented degraded-health policy;
4. follow-up routing skips model after hard circuit opens;
5. event sequence cannot attribute prior model failure to a later model switch.

Do not claim provider-runtime failure coverage until this exists.

---

### P3 — runtime config validation should match schema integer constraints

`schema.json` requires integer reliability thresholds/windows/cooldowns. `validateConfig()` only rejects values `< 1`; `1.5`, `NaN` (programmatic callers), and non-finite values can pass and yield surprising threshold behavior.

**Suggested fix:** require `Number.isInteger(value) && value >= 1` for all three fields. Add table-driven tests.

## Follow-up test matrix

Before merge, add:

1. rejected `pi.setModel()` records failure, clears selection guard, and fails safely;
2. malformed-but-valid persisted state fails open without throwing;
3. disabled config neither filters, reports, nor mutates circuits;
4. invalid numeric reliability config is rejected;
5. if provider-request failures remain out of scope, test/document exact supported failure sources.

## Merge recommendation

Fix both P1 items, rerun full unit/type/UI suite, then merge. P2/P3 can follow only if V1 scope is explicitly narrowed and user-facing disabled-mode output is corrected before release.
