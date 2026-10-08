# Reliability and caching

[Guide index](index.md) · [Provider prompt caching](prompt-caching.md) · [Troubleshooting](troubleshooting.md)

## Reliability circuits

Bifrost tracks model failures from:

- availability probes;
- failed Pi model activation;
- settled provider stream failures.

After configured repeated failures inside a time window, Bifrost opens that model's circuit. Open-circuit candidates are excluded before tier strategy selection. In `.pi/bifrost.json`:

```json
{
  "reliability": {
    "enabled": true,
    "cooldownOnAllowanceExhausted": true,
    "failureThreshold": 3,
    "windowMinutes": 5,
    "cooldownMinutes": 60
  }
}
```

Reliability state persists in `.pi/bifrost-reliability.json`. After cooldown, Bifrost may try that model once. Success restores it; failure keeps it excluded longer.

A normalized runtime `allowance_exhausted` result opens that model's circuit immediately by default, even before `failureThreshold` is reached. `cooldownMinutes` is the minimum cooldown and defaults to 60 minutes; a valid future retry hint may extend it, never shorten it. Set `cooldownOnAllowanceExhausted: false` to keep the ordinary repeated-failure threshold instead. Generic HTTP 429 and `rate_limit` results still use `failureThreshold`.

This signal is model-scoped. Bifrost does not know whether another model shares the same provider account, so it excludes only the reported model and warns that shared scope is unknown. `/bifrost inspect --json` shows the effective setting and allowlisted evidence when available. The warning and debug JSONL event identify the category, evidence kind, and model-only scope; they do not include the provider error text.

Bifrost never automatically replays the prompt that failed. Reliability affects future user turns only.

## Receipt-owned reliability state (experimental)

V1 is deprecated, but remains the default and supported this release. V2 is recommended for Auto workflows within its documented scope. V1 removal will be announced at least one published release ahead, and only after intended workflow coverage is ready; no removal date is set.

Opt in with `schemaVersion: 2` and `reliability.stateVersion: 2`. You can prepare the sidecar first while reliability remains on v1: `/bifrost reliability migrate` preserves and backs up an existing v1 state, while `/bifrost reliability migrate --fresh` is allowed only when no v1 state file exists. Migration does not change the config or selected model. V2 applies only when Bifrost Auto routes a new user turn and requires the initialized project sidecar; missing or invalid v2 state stops Auto before classification or provider generation. Physical routing and direct utility requests are unsupported while v2 is enabled; use Auto or set `stateVersion: 1`. Explicit `/bifrost pin` and `/bifrost off` remain available to leave Auto even when the sidecar is missing or invalid. They may select a configured physical model, but do not send a generation request.

Before migration, stop all other Pi sessions that may write this project's v1 reliability file, and ensure the current session has no active or queued generation. The migration command runs in the current session. Current Bifrost v1 saves and migration share a source lock: migration reads the latest source only after it owns that lock, then holds it through backup and v2 seed. A source change detected during the operation stops migration without committing v2. Older or uncooperative processes, and a stale v1 store writing after migration, cannot be fenced; this is not a universal live-cutover guarantee.

If a source lock remains after a crash, its default path is `.pi/bifrost-reliability.json.migration.lock`; with a custom `reliability.path`, the lock is that exact path plus `.migration.lock`. Stop every other process that can write the v1 file and keep the current Pi session idle. Inspect only that lock file and its owner metadata. A PID may have been reused, and age alone does not prove that a lock is stale. Bifrost never steals a lock automatically. Remove only the exact lock you have verified is stale; leave the v1 state and backup untouched. Then restart or reload the v1 session before using it, so an old in-memory store cannot write after migration. If ownership is uncertain, leave the lock in place.

Set `reliability.enabled: false` to turn v2 off. With it off, Bifrost does not read the v2 sidecar for routing. Optional `reliability.observations.enabled: true` stores bounded model-level failure categories and times. Raw provider error text is never persisted.

## Reliability is not quota enforcement

A circuit records observed model health. It does not know authoritative provider weekly quota unless Pi or the provider exposes that information.

Current safeguards for quota-sensitive models:

- remove them from broad adaptive tiers;
- isolate them in a dedicated tier;
- bind them behind deliberate direct rules;
- use deterministic strategies instead of `random` where needed;
- preview routes before sending consequential work.

Bifrost does not currently provide authoritative provider quota guards.

## Local classification cache

Bifrost's local cache stores routing classifications—not assistant answers.

Default project-local file:

```text
.pi/bifrost-cache.jsonl
```

Entries contain:

- normalized prompt words;
- selected tier;
- last-use timestamp;
- hit count;
- classifier-semantics fingerprint.

Normalized prompt text can still contain sensitive terms. Disable caching for sensitive projects in `.pi/bifrost.json`:

```json
{
  "cache": {
    "enabled": false
  }
}
```

Inspect or clear it:

```text
/bifrost cache stats
/bifrost cache clear
```

Bifrost does not cache assistant responses, tool output, source files, or failed prompts for replay.

## Provider prompt caches

Provider prompt or prefix caches are separate from Bifrost's local classification cache. Bifrost does not create, merge, clear, price, inspect, or guarantee them.

Treat every provider/model pair as an independent cache history. Repeated switching may fragment cache locality without necessarily deleting earlier provider entries. Returning to a model may reuse its longest still-valid matching prefix; later conversation content remains an uncached tail.

See also: [Provider prompt caching and model switching](prompt-caching.md) for A → B → A, N-switch behavior, adaptive-versus-pinned tradeoffs, and practical recommendations.

## Debug logging

Enable local JSONL routing diagnostics in `.pi/bifrost.json`:

```json
{
  "debug": {
    "enabled": true
  }
}
```

Default file:

```text
.pi/bifrost-debug.jsonl
```

When debug is enabled, lifecycle events include a random run ID, a per-session ID, and—when Pi exposes the exact user-message object—a per-turn ID. These IDs are only for log correlation; they are not Pi session/entry IDs or reliability receipt IDs. Auto retry and continuation events reuse the turn ID. V1 settlement is model-scoped, so its event says `model_only` instead of claiming an exact turn match.

The event stream can show request reason, selection or no-route, reliability admission, known outcome, settlement/release result, renewal failure, and manual/config changes. It is best-effort diagnostic evidence, not a provider request ledger: compare it with the Pi session transcript and provider/tool evidence to determine whether Pi retried or side effects occurred. Abrupt process termination can still lose buffered events.

The default file is `.pi/bifrost-debug.jsonl` under the current working directory. A configured relative path is also resolved from that directory; an absolute path is used as given. Bifrost rotates a file larger than 10 MiB to `.old.jsonl`; inspect both files when the session crosses a rotation. On session shutdown Bifrost requests a bounded flush. Lifecycle fields added for this trace contain only static categories, routing reason, model/tier, and random correlation IDs. Review the full file before sharing it, since other enabled diagnostics may have different detail.

For a useful capture, enable debug before starting a fresh Pi process, note the Pi version and start time, reproduce one issue, then close the session normally so the bounded flush runs. Keep the matching Pi transcript and relevant provider/tool outcome separately; do not include prompts, responses, credentials, or raw provider errors when sharing logs.

Direct TypeSafe and Pi-native classifiers have separate reliability circuits. See [Classifier backends](classifiers.md).
