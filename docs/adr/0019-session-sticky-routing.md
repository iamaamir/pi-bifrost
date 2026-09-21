# 0019 — Session-sticky routing with explicit tier overrides

## Status

**Proposed** (2026-09-20). This ADR records a reported need and a candidate design. It does not approve implementation or change current routing behavior.

## Context

Bifrost currently offers two session behaviors:

- **adaptive** — while enabled and unpinned, every eligible user prompt passes through routing;
- **pinned** — `/bifrost pin` locks the current model for the session and bypasses all routing.

Users have asked for a middle behavior: choose a model from the first user prompt in an otherwise empty session, retain that model for continuity, and route again only after an explicit instruction.

Bifrost already supports an inline tier override. If the first word of an unpinned prompt matches a configured tier key, Bifrost strips that word and routes the remaining prompt through that tier:

```text
quick commit the changes
```

Here, `quick` is not a reserved built-in prefix. It is a configured tier name from `models`. Users can create custom lowercase alphabetic single-word tier names, which automatically become inline prefixes.

The current implementation checks `pinned` before parsing an inline override. Therefore `/bifrost pin` is a hard lock: `quick commit the changes` remains unchanged and goes to the pinned model. Allowing a bare tier word to bypass pin would weaken a useful safety guarantee and could route accidentally when natural prose begins with a tier name, such as `quick question about this code`.

The requested behavior should not be implemented by silently changing `pin`. It needs an explicit, visible routing mode with different semantics.

## Decision drivers

1. Preserve `/bifrost pin` as an exact-model lock.
2. Improve model and provider-prefix cache locality in long sessions.
3. Keep explicit tier overrides fast and configuration-first.
4. Avoid new prefix characters that conflict with Pi input conventions such as file selection.
5. Keep current adaptive behavior backward compatible.
6. Make active mode, sticky base model, temporary override, and restoration inspectable.
7. Avoid semantic-divergence scoring, hidden rerouting, or prompt replay.

## Proposed decision

### 1. Add an explicit sticky routing mode

Bifrost gains three user-visible session states:

| State | Automatic routing | Inline tier override | Meaning |
|---|---|---|---|
| Adaptive | Every eligible prompt | Forces that prompt's tier | Re-evaluate task fit per turn |
| Sticky | First eligible prompt only | Temporarily forces that prompt's tier | Prefer continuity; reroute only on explicit input |
| Pinned | Never | Ignored | Hard-lock exact active model |

`sticky` is the missing middle state. It must be explicit, named, visible in status, reversible, and disabled by default for backward compatibility.

Illustrative commands:

```text
/bifrost sticky
/bifrost adaptive
/bifrost pin
/bifrost unpin
```

Exact command names remain subject to command-UX review. The semantic distinction is fixed by this proposal: sticky permits explicit tier overrides; pin does not.

### 2. Establish one sticky base model

In a fresh session with sticky mode active:

1. The first eligible user prompt follows the normal classification pipeline.
2. Bifrost selects and activates Pi's actual provider/model.
3. That provider/model becomes the session's sticky base model.
4. Later normal prompts use the sticky base without classification or strategy selection.

If sticky mode is activated after a session already has history, Bifrost adopts the current active model as the base. It must not unexpectedly classify and switch a running conversation merely because mode changed.

Sticky state is session-local. It does not propagate to child sessions and does not survive restart unless a future, separately reviewed config default explicitly enables sticky mode for new sessions. This preserves ADR 0015's distinction between persisted policy and ephemeral session preference.

### 3. Keep existing tier-name prefix syntax

No new marker such as `@quick` is introduced. Pi and user workflows may already assign meaning to punctuation-prefixed input.

In adaptive or sticky mode, the first alphabetic word may force a tier when it case-insensitively matches a configured `models` key and is followed by whitespace:

```text
quick commit the changes
deep review this authorization design
```

Bifrost strips the tier word before the selected model receives the prompt.

Current parser boundaries remain explicit:

- prefix is a configured tier name, not a separate alias;
- custom tier names work when they are lowercase-compatible, alphabetic, and one word;
- aliases such as `q` → `quick` are not supported unless `q` is itself a configured tier;
- punctuation forms such as `quick:`, `@quick`, and multiword tier prefixes are not supported;
- a tier word in the middle of a prompt is ordinary prompt text;
- an unknown first word is ordinary prompt text.

Supporting aliases, punctuation, digits, hyphens, or multiword tier names requires a separate parser/config decision.

### 4. Treat sticky inline overrides as one-turn exceptions

In sticky mode:

```text
sticky base: provider/general-model
prompt: quick commit the changes
```

Bifrost:

1. recognizes and strips `quick`;
2. resolves the configured `quick` pool;
3. removes unavailable and circuit-open candidates;
4. applies the `quick` tier strategy;
5. activates the selected model for that turn;
6. retains `provider/general-model` as the sticky base;
7. restores the sticky base before the next normal prompt is generated.

The override does not replace the sticky base. A separate explicit action may change the base model.

Restoration is a future-turn action. Bifrost must never replay the override prompt or resend work to the base model.

### 5. Keep pin as a hard lock

Pinned mode continues to bypass classification, rules, strategies, and inline tier parsing.

```text
/bifrost pin
quick commit the changes
```

The prompt remains unchanged and goes to the pinned model. This prevents a natural opening word from silently escaping a cost, quota, compliance, or cache-locality boundary.

To route again, the user must deliberately unpin, choose another model, or use a future command whose wording explicitly states that it changes the pinned model. Bare prompt text is not enough.

### 6. Preserve explicit precedence

Proposed session precedence:

```text
routing disabled
  → no Bifrost intervention

pinned
  → exact active model; prompt unchanged

sticky + recognized tier prefix
  → one-turn tier override; restore sticky base next normal turn

sticky + no recognized prefix
  → sticky base model

adaptive + recognized tier prefix
  → forced tier for current turn

adaptive + no recognized prefix
  → normal classification pipeline
```

Direct-model regex rules remain part of the normal classification pipeline. They do not run for ordinary sticky turns because sticky mode intentionally skips automatic routing after the base is established.

### 7. Make sticky behavior observable

Status and preview must distinguish:

- `adaptive`;
- `sticky: provider/model`;
- `sticky override: quick → provider/model; returns to provider/model`;
- `pinned: provider/model`.

A decision trace for a sticky override must include:

- source: `inline`;
- requested tier;
- eligible and excluded candidates;
- configured strategy;
- temporary selected model;
- sticky base model;
- restoration pending/completed state.

`/bifrost preview` must explain sticky behavior without mutating sticky state or changing the active model.

### 8. Keep sticky independent from classifier backend

Sticky mode controls **when** tier judgment runs. Prompt classifiers, TypeSafe/Jev, regex rules, cache, and default tier control **how** the initial tier is resolved.

Jev still returns a tier judgment, probabilities, and confidence. It does not choose the sticky base provider/model. The configured pool, reliability filter, and strategy choose that model.

Inline tier overrides bypass semantic classification in both adaptive and sticky modes.

## Feature-gate assessment

1. **User value:** yes — reduces unwanted model churn and supports better provider-cache locality.
2. **Explicit policy:** yes — sticky mode is opt-in and tier overrides are deliberate configured names.
3. **Visibility:** required — status, preview, and trace identify base and temporary model.
4. **Override:** yes — adaptive, sticky, pin, unpin, and manual model selection remain available.
5. **Proof:** required before acceptance — deterministic state-transition and host-model activation tests.

This proposal must not move to Accepted until visibility and proof designs are concrete.

## State-transition scenarios required before implementation

1. Fresh sticky session routes first prompt and records selected model as base.
2. Second normal prompt skips classification and keeps base model.
3. Recognized tier prefix in sticky mode routes one turn and strips prefix.
4. Next normal prompt restores base before generation.
5. Failed temporary activation leaves base intact and never replays prompt.
6. Pin blocks tier prefix and leaves prompt unchanged.
7. Adaptive mode preserves current per-turn and inline-override behavior.
8. Activating sticky mid-session adopts current model without routing.
9. Manual model selection retains current behavior and becomes an explicit hard pin unless separately changed.
10. Child session starts without inherited sticky or pinned state.
11. Preview reports outcome without mutating base, active model, or restoration state.
12. Restart clears ephemeral sticky base.

## Consequences

### Positive

- Users can choose continuity without giving up deliberate tier routing.
- `/bifrost pin` keeps a clear safety meaning.
- Existing configured tier names remain the manual control vocabulary.
- First-turn routing still uses pools, reliability, and strategies.
- Long sessions can avoid unnecessary reclassification and model switching.

### Negative

- Session state grows beyond `enabled` and `pinned`.
- Temporary overrides require tracking both active and base models.
- A normal prompt beginning with a tier name may still trigger an override in sticky mode.
- Restoring the base creates an A → B → A provider-cache pattern; content produced during B becomes an uncached tail for A.
- Commands, status, preview, tests, and docs need another mode.

## Alternatives considered

### A. Let tier prefixes override `/bifrost pin`

Rejected. Convenient, but it weakens pin's hard-lock guarantee and makes accidental natural-language routing possible inside a state users chose for stability or safety.

### B. Auto-pin after first route

Rejected. It overloads `pinned` with two meanings: a user-requested exact lock and an automatically selected sticky base. Inline override behavior then becomes ambiguous.

### C. Keep only adaptive and pinned

Rejected as product direction. Reported users want first-turn selection plus continuity, and neither existing state provides it.

### D. Add punctuation-prefixed override syntax

Rejected for this proposal. Pi may reserve or use punctuation such as `@` for other input features, and configured tier names already provide a working vocabulary.

### E. Add N-turn or semantic-divergence stickiness

Deferred. Sliding windows and divergence scoring introduce hidden automation, thresholds, and evaluation burden. First-message stickiness plus explicit override is smaller, inspectable, and user-controlled.

## Non-goals

- Implement sticky mode in this ADR-only change.
- Change current `/bifrost pin` behavior.
- Allow inline tier overrides while pinned.
- Add prefix aliases or new prefix punctuation.
- Detect semantic task changes automatically.
- Replay a prompt after failure.
- Persist sticky base models across restarts or child sessions.
- Add quota enforcement or provider-authoritative usage tracking.
- Add subagent role orchestration.

## Relationship to existing ADRs

- **ADR 0015:** preserved. Pin remains ephemeral and session-local; sticky base follows the same non-propagating session boundary.
- **ADR 0017:** sticky mode is a small routing primitive, not workflow logic.
- **ADR 0018:** classifier backends remain responsible only for tier judgment.
- **Product philosophy:** mode is explicit, visible, reversible, and must be proven before automation ships.

## Implementation gate

Before changing runtime behavior:

- [ ] Approve user-facing terms and exact commands.
- [ ] Decide config default shape without changing current default behavior.
- [ ] Define sticky base and temporary override state formally.
- [ ] Define restoration behavior for activation failure, cancellation, manual selection, and reload.
- [ ] Add deterministic transition tests for every required scenario.
- [ ] Expose mode/base/override in status and preview.
- [ ] Update schema, defaults, examples, README, landing page, and generated init behavior together if config semantics change.
- [ ] Run unit, type, UI, reliability, and host-real model-switch checks.
