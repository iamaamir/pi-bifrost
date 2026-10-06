# Routing controls

[Guide index](index.md) · [Provider prompt caching](prompt-caching.md) · [Commands](commands.md)

Bifrost currently offers adaptive routing, explicit tier selection, hard pinning, and a persisted on/off policy.

## What happens when you send a message

| What you do | What happens |
|-------------|--------------|
| Send a normal message while routing is on and nothing is pinned | Bifrost picks a configured model for that message |
| Start a message with a tier name, for example `quick commit the changes` | Bifrost uses that tier for that message only |
| Select a model in Pi while routing is on | That model stays active for the rest of the session |
| `/bifrost pin` | Current model stays active for the rest of the session; automatic routing stops |
| `/bifrost unpin` | Bifrost goes back to picking a model for each message |
| `/bifrost off` | Bifrost stops routing until `/bifrost on` |
| `/bifrost on` | Bifrost resumes routing |
| Select `bifrost/auto` in Pi's `/model` | Bifrost routes each request to a physical model at dispatch time ([Bifrost Auto](#bifrost-auto-virtual-model)) |
| Another extension emits `bifrost:lock` | Every message routes through the locked tier until the owner emits `bifrost:release` ([Tier lock](#tier-lock-for-extensions)) |
| `/bifrost pin` or `/bifrost off` while `bifrost/auto` is selected | Bifrost leaves Auto and activates the last dispatched physical model, or resolves the default-tier model before any dispatch |

## Start a message with a tier name

The tier name must be one you configured in `.pi/bifrost.json`. It is not an alias and not a separate command. For example, this config:

```json
{
  "models": {
    "quick": ["provider/fast-model"],
    "deep": ["provider/reasoning-model"]
  }
}
```

lets these prompts choose a tier directly:

```text
quick commit the changes
deep review this authorization design
```

Bifrost removes the tier name before the model sees the prompt. The rest of the sentence reaches the model unchanged.

Forcing a tier skips the tier choice, but the name alone does not pick the model. Bifrost still:

1. takes the models configured for that tier;
2. removes unhealthy ones;
3. applies that tier's selection strategy;
4. activates the result in Pi.

### When a tier name is recognized

- The tier name must be the first word of the message, followed by a space.
- Matching ignores letter case, so `Quick` also works.
- Only a single lowercase alphabetic word works, such as `quick` or `frontier`.
- Tier keys may use any name you like (`long-context`, `code_review`), but those names cannot be typed at the start of a message.
- Digits, hyphens, punctuation, and multiword names are not recognized.
- There is no separate list of aliases.
- If the first word is not a configured tier, the whole message is routed normally.
- A tier name anywhere other than the first word is ordinary text.

## Bifrost Auto (virtual model)

Requires Pi `1.0.1` or newer. Selecting `bifrost/auto` in Pi's `/model` picker switches from input-time model activation to Pi's native per-request dispatch. The routing policy is the same: configured tier pools, inline tier prefixes, classification cache, optional classifiers, reliability filtering, and per-tier strategies.

| Property | Behavior |
|----------|----------|
| Visible selection | `bifrost/auto`; Pi's footer shows `bifrost/auto → provider/model` |
| Thinking level | Left footer level is your routing preference; Bifrost clamps the dispatched level to the target's capabilities (non-reasoning targets run `off`) |
| Recorded model | Every assistant message records the physical model that answered |
| Tier prefixes | Same syntax, still stripped before the model sees the prompt |
| Tool continuations and retries | Stay on the physical model that handled the previous request |
| Classification and overrides | Run on `user` requests only; compaction and extension calls use the last dispatched or default-tier physical model |
| Failure mode | Fresh sessions fail with an actionable explanation when no pool resolves (empty pool → `run /bifrost init`); later turns keep the last dispatched physical model with a visible warning. Disabled or pinned Auto requests end with an explanation; nothing is silently replayed |

Selecting `bifrost/auto` enables routing and clears a manual pin. `/bifrost pin` and `/bifrost off` exit Auto by activating the last dispatched physical model. Before any dispatch, they resolve the default-tier model instead. Pin locks the result; off disables routing. Manual model selection keeps its existing meaning: the selected physical model is pinned.

## Pin is a hard lock

`/bifrost pin` is session-local. It does not survive restart and does not propagate to child sessions.

Pinned sessions skip all routing, and the first word of a message is never treated as a tier name. Therefore:

```text
quick commit the changes
```

is sent unchanged to the pinned model. It does not select the `quick` tier.

Pinning is deliberate: it protects cost, compliance, continuity, and cache locality. Run `/bifrost unpin` to route per message again. See [Provider prompt caching and model switching](prompt-caching.md) for A → B → A, N-switch behavior, and cache-minded workflows.

## Tier lock for extensions

Another extension, such as a plan mode, can hold one tier over `pi.events` without knowing any model IDs:

```ts
pi.events.emit("bifrost:lock", { tier: "frontier", owner: "plan-mode", reply: (result) => console.log(result) });
pi.events.emit("bifrost:release", { owner: "plan-mode" });
```

While locked, every message, including input sent by other extensions, routes through the locked tier's pool with the usual health filtering and strategy, both with input-time routing and with `bifrost/auto`.
A tier name at the start of a message is still stripped, but the lock decides the tier.
Taking a lock switches to the tier's first healthy model right away; `bifrost/auto` stays selected and dispatches the locked tier.
When the locked tier has no healthy model, a locked message is refused instead of falling back to the default tier: input-time routing does not send the prompt, and `bifrost/auto` fails the request with an error naming the locked tier and its owner rather than keeping the last dispatched model.
The optional `reply` callback receives `{ ok: true, tier, model? }` or `{ ok: false, reason }`.
A lock is rejected when routing is off, the tier is not configured or has no healthy model, switching to it fails, another owner holds the lock, or the session is a delegate.
Only the owner can release it, and a lock is session-local.
Taking a lock clears a manual pin, and selecting a model in Pi still pins it; `/bifrost debug` and the status show the active lock.

## Subagents

Child sessions launched by an ACP delegate (`PI_ACP_DELEGATE_DEPTH` is set to 1 or more) start pinned to the `--provider`/`--model` they were launched with.
`/bifrost unpin`, manual model selection, and `bifrost:lock` do not change that pin.
A delegate launched on `bifrost/auto` keeps routing each request through Auto.

Other child sessions that load Bifrost start unpinned. Bifrost cannot determine whether their starting model came from an explicit per-run or role assignment. If an exact child model must remain fixed, ensure that child session does not load Bifrost.

Use fixed role/model assignments when the correct model is already known. Use adaptive routing only where task complexity can vary.
