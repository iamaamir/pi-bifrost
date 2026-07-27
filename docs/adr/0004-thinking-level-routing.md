# Thinking level during Bifrost model switches

## Status

Proposed. Documentation and design context for a follow-up task; no behavior changes in this ADR.

## Problem

When Bifrost routes to a reasoning-capable model, Pi can show `high` thinking even though the user did not explicitly select `high` for that prompt. This can add latency and token cost, particularly when Bifrost chooses an economical tier.

Bifrost must not silently override a user's thinking preference. It also must make an effective level that Pi changed during a model switch explainable.

## Local observation

During investigation, the local Pi preference was:

```json
{ "defaultThinkingLevel": "medium" }
```

After switching to a target whose supported-level map does not include `medium` but does include `high`, Pi displayed `high`.

This is not Bifrost assigning `high`.

## Evidence and call chain

Verified against installed `@earendil-works/pi-coding-agent` `0.82.0`:

1. `index.ts` routes by calling only `await pi.setModel(model)`. It never calls `pi.setThinkingLevel(...)`.
2. Pi's `AgentSession.setModel()` saves selected model, then calls `setThinkingLevel(thinkingLevel)` to re-clamp level for target model capabilities.
   - Source: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` (`setModel`).
3. Pi obtains requested level with `_getThinkingLevelForModelSwitch()`:
   - explicit scoped-model level, if supplied;
   - otherwise current session level for a reasoning model;
   - otherwise persisted default thinking level, falling back to Pi default `medium`.
4. Pi's `clampThinkingLevel()` chooses requested level if supported. If not, it searches higher supported levels first, then lower levels.
   - Source: `node_modules/@earendil-works/pi-ai/dist/models.js`.
5. Pi writes an effective changed thinking level back to session/settings. Thus one capability clamp can influence later model switches.

Pi documents this behavior: a model change can emit `thinking_level_select` when level changes or is clamped. See Pi `docs/extensions.md`, model/thinking lifecycle and `pi.setModel` sections.

## Consequences

- `high` is functionally valid when required by target model capability mapping.
- It is not necessarily economically appropriate for an economical routing tier.
- Bifrost cannot infer that `high` was user intent; it may be Pi's capability clamp.
- Forcing `off`, `low`, or another level on every switch would overwrite Pi user preference and can be unsupported by target model.

## Decision for current behavior

Keep Pi behavior unchanged. Bifrost continues to call `pi.setModel(model)` and does not call `pi.setThinkingLevel(...)` implicitly.

A future implementation must first add visibility. Per-tier thinking policy is opt-in only and requires explicit configuration/schema design.

## Follow-up scope

### Phase 1: visibility

Add effective thinking level to Bifrost's last-routing-decision surface:

- requested context: inherited Pi level when available;
- effective level after model switch;
- reason: `preserved`, `clamped for target`, `target has no reasoning`, or explicit policy;
- selected model/tier/source alongside it.

Do not add prompt text to this state. Keep it ephemeral like existing routing status.

### Phase 2: optional policy, only after Phase 1

Evaluate opt-in per-tier policy, for example:

```json
{
  "thinking": {
    "default": "inherit",
    "tiers": { "economical": "low", "frontier": "inherit" }
  }
}
```

Open design questions:

- Is `inherit` default and only valid default? Recommended: yes.
- Does policy run after `pi.setModel()` so Pi can clamp requested policy for target model? Recommended: yes.
- How should unsupported configured levels be surfaced: error, warning, or target clamp? Require explicit answer and visible outcome.
- Should policy be model-specific rather than tier-specific? Defer until tier policy has a demonstrated need.
- Should Pi's persisted default remain untouched when Bifrost applies a temporary policy? Validate Pi API/session semantics before implementing.

## Acceptance criteria for implementation

1. Normal Bifrost routing preserves Pi behavior when no thinking policy is configured.
2. Decision UI/log identifies effective thinking level and clamp reason without entering LLM context.
3. Tests cover:
   - reasoning → reasoning switch preserving supported level;
   - non-reasoning → reasoning switch using Pi persisted default;
   - unsupported `medium` clamped upward to supported `high`;
   - reasoning → non-reasoning switch resulting in `off`;
   - no Bifrost policy means no Bifrost `setThinkingLevel` call.
4. If opt-in policy ships, tests cover supported, unsupported, and non-reasoning targets plus config validation.
5. UI smoke covers a model-switch result containing effective thinking level; preserve Pi's native thinking indicator.

## Non-goals

- Change Pi global default thinking level.
- Guess model capability from name or tier.
- Implicitly lower thinking for economical routes.
- Persist prompt history or decision history only to explain thinking level.
