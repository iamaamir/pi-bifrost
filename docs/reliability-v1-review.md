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

### P2 — “runtime failure” coverage is not real provider-request coverage

`tests/runtime-reliability.test.ts` directly calls `recordModelFailure(..., "setModel", ...)`; it does not exercise extension runtime behavior. `setModel` auth/selection failure is not a provider request failure.

The roadmap says V1 records probe failures and observed provider failures. Current implementation records:

- probe `error`/`timeout` results;
- `setModel()` false return only (and currently not thrown rejection; see P1).

It does **not** observe agent/provider request failures after model selection.

**Suggested decision:** either:

1. narrow V1 documentation to “probe and model-selection health”, rename test accordingly; or
2. add a validated Pi lifecycle listener for assistant/provider errors, only if it is safe and supported by target Pi versions.

Do not claim provider-runtime failure coverage until it exists.

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
