# 0005 — Consolidate reliability state behind a ReliabilityStore

## Status

**Accepted** (2026-07-28). Peer-review closeouts resolved (settle success = **Policy A**). Implement only with the refined interface and green implementation gate. No half-measures.

## Context

Reliability v1 introduces a persisted circuit-breaker state (`.pi/bifrost-reliability.json`). Four independent call sites mutate this state and each calls `saveReliability()` directly:

1. `index.ts` — `setModel` returns false / throws
2. `index.ts` — `agent_settled` (RuntimeReliabilityTracker)
3. `commands.ts` — `applyProbeReliability` after `/bifrost probe`
4. `commands.ts` — reload path re-reads from disk

Each site independently knows what function to call, how to update the mutable reference, and when to persist. A new call site must remember to persist and update the right reference — a silent bug surface with no compile-time safety.

## Decision

Introduce a `ReliabilityStore` module that owns the mutable `ReliabilityState` and its persistence path. All mutation goes through the store; all persistence is internal to the store.

### Interface (accepted)

Single source of truth: **Refined interface (accepted)** in the design review section below.

Key rules locked in:

- **Config is store-held only.** Write methods take **no** `config` parameter. Callers express intent (`model`, `source`, `reason`) only; the store reads its held config internally.
- **`getState(): Readonly<ReliabilityState>`** — compile-time guard against mutation bypassing save.
- **Must ship together:** `beginTrial`, `applyOutcomes` (probe batch), settle success via `recordSettled`, injectable `io`/`now`.

### What stays outside the store

- **Pure routing functions** (`getCircuitState`, `resolveHealthyModel`) remain pure in `reliability.ts` / `routing.ts`. The store calls them internally but does not replace them — testability of routing logic is preserved.
- **Schema validation** stays in `validateConfig`. The store is not a config validator.
- **Pipeline invalidation** stays in the command handler. The store does not know about the classification pipeline.

### Reload strategy — explicit calls, not events

When `/bifrost reload` fires, the command handler calls each module's reload in sequence:

```ts
// commands.ts
state.config = loadConfig(...);
state.reliabilityStore.reload(state.config.reliability, process.cwd()); // path resolve + load
state.cacheEntries = loadCache(...);
invalidatePipeline();
```

This is explicit (readable trace of reload order), local (each module owns its reload), and zero plumbing (no event bus). When the number of reload subscribers grows past ~8, or modules need to reload independently, an event bus becomes worth revisiting. Until then, direct calls are the right tool.

### State ownership change

Today `BifrostState` carries `reliabilityState` (mutable reference) and `reliabilityPath` (string). After this change:

- `BifrostState` carries `reliabilityStore: ReliabilityStore` instead.
- `index.ts` no longer imports `loadReliability`, `saveReliability`, `recordSetModelOutcome` — it calls `store.recordFailure` / `store.recordSettled` / `store.beginTrial`.
- `commands.ts` no longer imports `recordModelSuccess`, `recordModelFailure`, `saveReliability` — it calls `store.applyOutcomes` / `store.reload`.
- Routing reads `store.getState()` instead of `state.reliabilityState`.

## Considered options

### Option A: ReliabilityStore (chosen)

A thin impure facade over the existing pure functions. The store owns state + path and persists after every mutation.

**Pros:** Single write path, callers express intent not mechanism, testable without filesystem.
**Cons:** One more module; state is still a shared mutable reference (now behind an interface).

### Option B: Event bus for reload

Each module subscribes to `bifrost:configChanged` events; the reload handler emits one event.

**Pros:** Zero coupling between reload handler and subscribers.
**Cons:** Adds indirection for 4 subscribers; event ordering is implicit; debugging is harder. Premature for this codebase size.

### Option C: Status quo

Four call sites each call `saveReliability()` directly.

**Pros:** No new modules; current tests pass unchanged.
**Cons:** Distributed persistence knowledge; missed saves are silent bugs; no single place to add batching, debouncing, or locking later.

## Consequences

- All `saveReliability()` calls in `index.ts` and `commands.ts` are removed. Persistence is internal to the store.
- `reliability.ts` pure functions (`recordModelFailure`, `recordModelSuccess`, `normalizeRecord`, `getCircuitState`) are unchanged. They remain the test surface for correctness.
- Routing tests still pass — `resolveHealthyModel` reads `store.getState()` (same shape as before).
- New tests: store orchestration (mutate+persist, batch=1 save, reload, `recordSettled`); pure CB tests unchanged.
- `index.ts` `agent_settled` calls `store.recordSettled(...)`; tracker stays free of the store and returns model on both success and failure.
- Future v2 features (provider-level circuits, retry hooks) extend the store, not four call sites.

## Open questions for reviewers

**Resolved — see design review.** Summary:

1. **Config:** store-held only; write methods take **no** config param (stricter than “both”).
2. **Health helpers:** on the store; pure `getCircuitState` remains public for routing/tests.
3. **Class vs factory:** either; inject `io`/`now` either way.

---

## Design review discussion (2026-07-27)

Multi-expert review of this ADR against the live codebase (`reliability.ts`, `runtime-reliability.ts`, `index.ts`, `commands.ts`, `routing.ts`). Participants: Staff Engineer, Software Architect, Circuit-Breaker Domain Expert, Testing/DX Principal.

### Consensus verdict

**Approve with changes.** All four reviewers agree:

- The problem is real (distributed mutate+save is a silent-bug surface).
- A thin impure facade over pure CB transitions is the right size for ~3.4k LOC.
- Option B (event bus) is premature; Option C keeps the footgun.
- The proposed API is incomplete in the places that matter and slightly dual-pathed on config.

Ship the store only after the refinements below land in the interface.

### Call-site inventory correction

The ADR lists four sites. Review found a **fifth write path** omitted from the write API:

| # | Site | Today | Store method needed |
|---|------|--------|---------------------|
| 1 | `index.ts` setModel false/throw | `recordSetModelOutcome` + save | `recordFailure` |
| 2 | `index.ts` `agent_settled` | tracker settle → failure only + save | `recordFailure` **and** `recordSuccess` on clean settle |
| 3 | `commands.ts` probe | N pure updates, **one** save | `applyOutcomes` / batch (not N flushes) |
| 4 | `commands.ts` reload / init-write | `loadReliability` | `reload` with path swap |
| 5 | `index.ts` half-open select | `beginTrial` + save | **`beginTrial` (missing from original API)** |

If `beginTrial` stays outside the store, the ADR does not close the write surface it claims to own.

### Discussion transcript (condensed)

**Staff Engineer:** Right abstraction boundary — impure owner of path+state, pure math stays the correctness surface. Do not invent CacheStore “for consistency.” Biggest gaps: missing `beginTrial`, probe becomes N fsyncs if every record flushes, live `state` getter lets callers mutate and skip persist, dual config (param + `updateConfig`) invites drift after reload.

**Architect:** “Store” is a local name for a persistence-backed mutable facade — not a Repository or Unit of Work. Move *usage* of load/save into the store module; leave pure transitions in `reliability.ts`. `RuntimeReliabilityTracker` stays decoupled (returns pending failure; `index.ts` calls the store). Reload sample is wrong for path changes: today reload always recomputes path from config and reloads — API must support path swap, not “reload if path unchanged.” Explicit sequential reload stays; event bus only if subscribers approach ~8.

**Domain Expert:** Facade preserves CB invariants only if ops are complete. Critical domain hole on the live path: after `beginTrial`, successful `agent_settled` never calls `recordSuccess` today (`recordSetModelOutcome(ok=true)` is a no-op). Trial flags / multiplier may stick; next failure can incorrectly double cooldown. Store should make settle wire as failure *or* success. Hold config on the store only — mid-flight reload should not create split brain between “config arg on write” and “config used by `isModelHealthy`.” Expose `getCircuitState` (half-open ≠ open); `isModelHealthy ≡ !open` is enough for routing filters. Sources (`probe` | `setModel` | `agent_settled` | …) are observational, not store policy. Stale `trialActive` across process restart is sharper than missed trial persist — document trial persist policy (persist vs in-process-only, clear on reload if cooldown already expired).

**Testing/DX:** “Testable without filesystem” is underspecified. Require injectable `io` + `now` + optional `initialState`. Pure suite remains primary correctness surface; store suite is thin orchestration (~8–12 cases): did save run, reload replaces state, disabled no-ops, batch is one save. Do not re-test threshold math on the store. Migration: land store+tests first, strangler-migrate call sites, final grep that `saveReliability` only lives behind the store. Prefer factory+interface for fakes; class is fine if constructor options inject doubles. Anti-patterns: mutating `store.state` then asserting health; spying global `fs`; asserting pretty-printed JSON.

### Resolved open questions

| # | Original | Resolution |
|---|----------|------------|
| 1 | Config on every write *and* `updateConfig`? | **Store holds config only.** Writes are intent-only (`model`, `source`, `reason`). `updateConfig` / `reload` are the sole config entry points. Dual path rejected (desync footgun). |
| 2 | Health helpers on store? | **Yes** as thin wrappers for UI/commands. Keep pure `getCircuitState` public; routing takes a state snapshot, does not depend on the store class. Also expose `getCircuitState` on the store for half-open / trial UI. |
| 3 | Class vs factory? | **Either.** Class matches `RuntimeReliabilityTracker`; factory+`StoreOptions` is slightly better for test doubles. Pick one; inject `io`/`now` either way. |

### Additional decisions from review

1. **Add `beginTrial(model)`** as a first-class write.
2. **Add batch API** — `applyOutcomes(outcomes[])` or `transact(fn)` — so probe keeps one disk write.
3. **Read API:** prefer `getState(): Readonly<ReliabilityState>` (or `snapshot()`) over a mutable `state` getter; document do-not-mutate.
4. **`reload(config, cwd?)`** must re-resolve path, switch path if config moved the file, load, replace state, update held config. Do not leave dirty state on the old path.
5. **Settle success:** when Bifrost selected the model and the run is clean, call `recordSuccess(..., "agent_settled")` so trials close correctly. (Domain fix adjacent to the store; store makes the call site obvious.)

### Follow-up nuance — Finding 4 / trial success (reviewer assessment)

Agreed: Finding 4 is a **live v1 correctness bug**, not merely a store packaging concern. The fix belongs in `index.ts` (wire settle success) and is already expressed correctly in pure `recordModelSuccess` — the store only makes the call site hard to miss.

**`halfOpen` is not a stored field.** It is derived in `getCircuitState`:

```ts
halfOpen: !!openUntil && openUntil <= now && !record?.trialActive
```

`recordModelSuccess` already fully closes the circuit:

- `openUntil: undefined`
- `trialActive: false`
- `cooldownMultiplier: undefined`
- `failures: []`

So after success: `open === false` and `halfOpen === false`. No extra “clear halfOpen when trialActive” branch is required in the store or in `recordSuccess` — that transition is already implied by clearing `openUntil` + `trialActive`. Spec (`docs/reliability-spec.md`) agrees: “Trial success (`recordModelSuccess`) fully closes circuit,” and `tests/reliability.test.ts` asserts `closed.halfOpen === false` after trial success.

**What is broken today:** `agent_settled` only records failures. Clean settle after `beginTrial` never calls `recordModelSuccess`, so:

- `trialActive` can remain `true` across later prompts
- next failure still sees `wasTrial` and **doubles cooldown incorrectly**
- `halfOpen` stays false while trial is stuck (model remains selectable, but trial semantics are wrong)

**Fix (domain wire + store convenience) — Policy A (accepted):**

```ts
// index.ts agent_settled — Policy A: failure always; success only to close an in-flight trial
const settled = runtimeReliability.settle(); // { model, reason? } | undefined when no bifrost run
if (!settled || !state.enabled) return;
if (settled.reason) {
  store.recordSettled(settled.model, settled.reason);
} else if (store.getCircuitState(settled.model).trialActive) {
  store.recordSettled(settled.model); // success — closes trial / circuit
}
```

Tracker must return the selected model on clean settle (not only on failure). Pure `recordModelSuccess` needs no change for half-open clearing. `recordSettled` is store sugar over `recordSuccess` / `recordFailure` with source `"agent_settled"`. Policy lives in `index.ts`; store stays dumb. Policy B (always success on clean settle) is a later one-line change if product wants failure-window reset.
6. **No CacheStore / event bus / debounce / file lock** in this ADR. Batching and locking can become internal later without caller changes — that is the main ROI of centralizing persist.
7. **Sources:** optional typed union for known sources; store does not branch policy on source. Whether setModel auth failures “count” stays call-site policy.
8. **I/O errors:** centralizing save is the moment to consider surfacing last-persist failure (boolean / lastError) instead of only relocating `console.error` — optional, not a blocker.

### Refined interface (accepted)

Write methods take **no config parameter**. Config is held on the store; only `updateConfig` / `reload` change it.

```ts
type ReliabilityIo = {
  load(path: string): ReliabilityState;
  save(path: string, state: ReliabilityState): void;
};

type ReliabilitySource = "probe" | "setModel" | "agent_settled" | "trial" | (string & {});

type ReliabilityOutcome =
  | { model: string; ok: true; source: ReliabilitySource }
  | { model: string; ok: false; source: ReliabilitySource; reason: string };

type ReliabilityStoreOptions = {
  cwd: string;
  config: ReliabilityConfig | undefined;
  io?: ReliabilityIo;              // default: loadReliability / saveReliability
  now?: () => number;               // default: Date.now
  initialState?: ReliabilityState;  // skip load in unit tests
};

class ReliabilityStore {
  constructor(opts: ReliabilityStoreOptions);

  /** Compile-time guard: callers must not mutate. */
  getState(): Readonly<ReliabilityState>;
  get path(): string;

  getCircuitState(model: string, now?: number): CircuitState;
  isModelHealthy(model: string, now?: number): boolean;  // !open
  openCircuitCount(now?: number): number;

  // Intent-only writes — config read from store internally
  recordFailure(model: string, source: ReliabilitySource, reason: string, now?: number): void;
  recordSuccess(model: string, source: ReliabilitySource, now?: number): void;
  /** Settle wire: reason undefined => success; else failure. Source fixed to agent_settled. */
  recordSettled(model: string, reason?: string, now?: number): void;
  beginTrial(model: string): void;
  applyOutcomes(outcomes: readonly ReliabilityOutcome[], now?: number): void; // single persist — required for probe

  updateConfig(config: ReliabilityConfig | undefined): void; // in-memory only
  reload(config?: ReliabilityConfig, cwd?: string): void;    // path resolve + load
}
```

### What stays outside (unchanged + clarified)

- Pure transitions in `reliability.ts`: `recordModelFailure`, `recordModelSuccess`, `beginTrial`, `getCircuitState`, `normalizeRecord`.
- `resolveHealthyModel` stays pure; receives `store.getState()`.
- `RuntimeReliabilityTracker` stays session-scoped pending-failure only — no store injection.
- Config validation, pipeline invalidation, probe orchestration, UI.
- Cache remains free-function load/save until it has the same missed-save pain (follow-on, not this ADR).

### Reload sequence (corrected)

```ts
state.config = loadConfig(...);
// debug setup if needed
state.reliabilityStore.reload(state.config.reliability, process.cwd());
state.cacheEntries = loadCache(...);
invalidatePipeline();
```

### Test matrix (agreed)

| Layer | Coverage | FS |
|-------|----------|-----|
| Pure (existing) | CB thresholds, trial multiplier, normalize, disabled | No |
| I/O (existing) | load/save roundtrip, corrupt JSON, missing file | Temp dir |
| Store unit | each write updates state + save count; batch = 1 save; reload; disabled; health wrappers | Fake `io` |
| Integration (thin) | real temp file across two store instances | Temp dir |
| Migration | no `saveReliability` outside store + reliability I/O | Static / CI |

### Explicit non-goals (do not do in this change)

- Event bus / observable store
- Generic `StateContainer` or CacheStore symmetry
- Moving pure circuit math solely onto the class
- In-place mutation inside the store (keep replace-via-pure-fns)
- Debounced/queued persistence or cross-process locking until measured need
- Store-enforced policy on which failure sources count

### Implementation gate (merge blocker — all required)

Ship the store only when **every** box is green. No half-measures.

- [ ] `beginTrial` on store API (closes fifth write path)
- [ ] `applyOutcomes` ships with store — probe must not N-save (not optional / follow-on)
- [ ] `recordSettled(model, reason?)` convenience for settle wire
- [ ] Settle success **Policy A**: tracker returns model on clean settle; `index.ts` records failure always, success **only if** `trialActive` (fixes trial flag / cooldown-double; no write-every-prompt)
- [ ] Write methods take **no** config param; store holds config only
- [ ] `getState(): Readonly<ReliabilityState>` (not mutable `state` getter)
- [ ] `reload` handles path swap
- [ ] Injectable `io` + `now` for unit tests
- [ ] Pure `reliability.ts` tests remain green; store adds orchestration tests only
- [ ] No caller `saveReliability` / `loadReliability` outside store + reliability I/O

### Final acceptance (2026-07-28)

Reviewer approval with refinements:

1. **Missing `beginTrial`** — real gap; must be in store API.
2. **Probe `applyOutcomes`** — not optional; ship with the store.
3. **Settle success Policy A** — genuine domain bug; after `beginTrial`, clean settle never clears trial today. v1: failure always; success **only if** `trialActive`. Policy B deferred.
4. **`recordSettled(model, reason?)`** — store sugar; `index.ts` owns Policy A branch.
5. **`getState(): Readonly<ReliabilityState>`** — compile-time guard against mutation bypassing save.
6. **Config:** held on store only; write methods take **no** config param at all (stricter than dual API). Callers express intent only.

**Overall:** store design is correct. Gate blocks merge until `beginTrial`, batch, and settle success are addressed together.

**Net:** Consolidate writes behind the store; close the full write surface; keep pure CB core; leave cache, tracker, and eventing alone.

---

## Peer review (2026-07-28)

Independent pass over the accepted package against live code (`reliability.ts`, `runtime-reliability.ts`, `index.ts`, `commands.ts`, `routing.ts`). Goal: block unconditional “ship it” if anything is still underspecified or wrong.

### Verdict

**Do not treat as fully accepted yet.** Direction is sound and the gate is mostly right, but **one semantic decision is still open** and the ADR body still had stale references (now partially cleaned). Resolve closeouts below, then flip status to plain **Accepted**.

### What holds up

| Claim | Check |
|-------|--------|
| Distributed mutate+save is real | Confirmed: setModel fail, agent_settled fail, beginTrial, probe batch, reload/init — 5 paths |
| Thin facade over pure fns | Right size; matches how cache is *not* forced into a store |
| No event bus | Correct for this LOC |
| `beginTrial` on store | Required; otherwise write surface stays open |
| `applyOutcomes` with store | Required; probe today is one save |
| Config not on write args | Correct; dual config was a footgun |
| Tracker not injected with store | Correct; keep `settle()` return value → `index.ts` → store |
| `halfOpen` derived; success math already closes | Confirmed in `getCircuitState` + `recordModelSuccess` + tests |

### Blocking closeout — settle success scope — **RESOLVED: Policy A**

| Policy | Decision |
|--------|----------|
| **A. Trial-only success** | **Accepted for v1 store PR** |
| **B. Always success on clean settle** | Deferred — product decision, not a bug fix; one-line `index.ts` change later; store API unchanged |

**Reasoning (accepted):**

- Trial flag sticking is the only known correctness bug; A fixes it with minimal blast radius.
- B (“does a clean turn reset the failure window?”) needs its own discussion.
- Promoting A → B later does not touch the store API.

```ts
// Policy A — index.ts owns the branch; store stays dumb
if (settled.reason) store.recordSettled(settled.model, settled.reason);
else if (store.getCircuitState(settled.model).trialActive) store.recordSettled(settled.model);
```

### Non-blocking but must document

1. **`Readonly<ReliabilityState>` is shallow.**  
   `getState().models[k].failures.push(x)` still typechecks in many TS setups (nested mutability). This is **not** a hard compile-time save bypass guard. Mitigations: document “do not mutate”; optional `Object.freeze` in debug builds; or accept social contract. Do not oversell.

2. **`recordModelSuccess` ignores `enabled`.**  
   `recordModelFailure` no-ops when disabled; success does not (`reliability-v1-review` already noted probe success while disabled). Store-held config should make **both** writes no-op when `enabled === false` (small pure-layer or store-layer fix; include in PR).

3. **Stale `trialActive` after crash/reload.**  
   If `beginTrial` persists and process dies mid-run, reload leaves `trialActive: true` → `halfOpen` false forever until failure/success. Gate should pick one:  
   - **persist trial** + clear `trialActive` on `reload`/`load` when `openUntil <= now`, or  
   - **do not persist** `beginTrial` (in-process only).  
   Peer lean: **clear stale trial on load/reload** if `openUntil` already expired; still persist trial if you want multi-session half-open mutex (usually unnecessary for single Pi process).

4. **`updateConfig` vs path.**  
   `updateConfig` = in-memory thresholds only; path changes require `reload(config, cwd)`. Call sites that only `updateConfig` after editing `reliability.path` are wrong — reload sequence already correct; add one-line comment on `updateConfig`.

5. **Who checks `state.enabled` vs reliability `enabled`?**  
   Extension disable (`state.enabled`) stays in `index.ts`. Reliability `enabled` should be enforced inside store writes so commands/probe cannot forget. Callers may still early-return for UX (skip log noise).

6. **Tracker API change is in scope.**  
   `settle(): RuntimeFailure | undefined` must become something like:

   ```ts
   settle(): { model: string; reason?: string } | undefined
   // undefined = bifrost did not begin() this run
   // reason set = failure; reason absent = clean success
   ```

   Update `runtime-reliability-tracker` tests in the same PR. Not optional if settle success ships.

7. **ADR hygiene (fixed in this pass where noted).**  
   Decision/Consequences still said `store.state` / failure-only tracker wiring — corrected. Numbering glitch after trial-success section (items 6–8) is cosmetic.

8. **Option A “persists after every mutation” vs `applyOutcomes`.**  
   Slight tension in Considered options text. Precise rule: **persist after each public write API call**; `applyOutcomes` is one write API call → one persist. Fine; reword if anyone bikesheds.

9. **`recordSetModelOutcome`.**  
   Becomes dead at call sites; can remain pure helper or delete. Prefer delete once store lands to avoid “which entry point?” drift.

10. **Test gap for settle success.**  
    Gate lists orchestration tests but not an integration assertion: beginTrial → clean settle → `trialActive` false and multiplier cleared. **Required** for whichever policy A/B.

### Revised gate add-ons

- [x] **Closeout:** settle success **Policy A** (trial-only success) — locked 2026-07-28
- [ ] Store no-ops **all** mutations when reliability `enabled === false` (including success)
- [ ] Stale-trial policy on load/reload documented + implemented
- [ ] Tracker `settle()` returns model on success; tests updated
- [ ] Test: trial + clean settle closes circuit; clean settle **without** trial does **not** write
- [ ] Do not claim deep immutability from shallow `Readonly<>`

### Peer recommendation (post–Policy A)

| Item | Action |
|------|--------|
| Store facade, beginTrial, applyOutcomes, no config on writes, getState, reload path swap, io/now inject | **Ship** |
| `recordSettled` convenience | **Ship** |
| Settle success Policy A | **Ship** in same PR as store |
| Policy B | **Out of scope** — follow-up product decision |
| Status | **Accepted** — implement under gate |

**Bottom line:** Accepted. Implement under the gate; Policy A + enabled no-op on success + stale-trial on load are part of the PR, not follow-ons.

---

## Code review of implementation (commit `b6ad8584`, 2026-07-28)

Implementation review against the accepted interface and gate above. Suite green (158/158), `tsc --noEmit` clean. Caller migration complete: no `saveReliability` / `loadReliability` outside `reliability-store.ts`, `reliability.ts` I/O, and test fixtures.

### Verdict: **Approved.** Findings F1, F2, F4, F5, F6 closed in commit `a49f8d2b`; F3 accepted as-is. 160/160 tests, `tsc` clean. Track via the table below.

### Gate implementation status

| Gate item | Implemented at | Status |
|-----------|----------------|--------|
| `beginTrial` on store API | `reliability-store.ts:104` | ✅ |
| `applyOutcomes` ships with store (one persist) | `reliability-store.ts:109` | ✅ test asserts 1 save |
| `recordSettled(model, reason?)` | `reliability-store.ts:96` | ✅ |
| Settle success Policy A (trial-only) | `:96-102`, 3 tests | ✅ |
| Writes take no `config` param | `:84, :89, :96, :104, :109` | ✅ |
| `getState(): Readonly<…>` | `:64` (shallow — see F3) | ✅ |
| `reload` handles path swap | `:131-135` | ✅ (F1 fixed `a49f8d2b`) |
| Injectable `io` + `now` | `:34-40, :52-53` | ✅ |
| Pure `reliability.ts` tests green | — | ✅ |
| No caller `saveReliability` outside store + I/O | grep clean | ✅ |
| Store no-ops success when `enabled: false` | `:90`, `:114` | ✅ |
| Stale-trial policy on load/reload | `pruneStaleTrials :144` | ✅ |
| Tracker `settle()` returns model on success | `runtime-reliability.ts:48-50` | ✅ |
| Test: trial + clean settle closes circuit | `reliability-store.test.ts` | ✅ |
| No deep-immutability claim | doc comment only | ✅ |

### Findings

**F1 — `reload()` no-arg branch corrupts path (medium; unreachable today).** ✅ Fixed `a49f8d2b`
Dropped the `else` re-derivation branch; `pathValue` only changes when `cwd` is passed.

**F2 — `applyOutcomes` change-detection is mostly dead (nit).** ✅ Documented `a49f8d2b`
Comment added explaining the `changed` flag short-circuits the disabled case.

**F3 — `Readonly<ReliabilityState>` is shallow (known per ADR).** Accepted as-is for v1; optional `Object.freeze` in dev builds later.

**F4 — `beginTrial` has no `enabled` check (minor; pre-existing).** ✅ Fixed `a49f8d2b`
`if (this.configValue?.enabled === false) return;` added.

**F5 — Test gaps.** ✅ Fixed `a49f8d2b`
Added path-swap reload test + two-instance integration test.

**F6 — Log line only on failure (intentional).** ✅ Commented `a49f8d2b`
Policy A silent-clean-settle comment added in `index.ts`.

### Non-findings (verified correct)

- Policy A branch via `recordSettled` sugar; store stays dumb. ✅
- `pruneStaleTrials` runs on construct + reload. ✅
- `applyOutcomes` = one save for N updates. ✅
- Probe call sites folded via `applyOutcomes` (`commands.ts:137, :648`). ✅
- Settle trial-stick / cooldown-double bug fixed by Policy A success path. ✅

### Recommended actions

All complete. No outstanding work from this review.
