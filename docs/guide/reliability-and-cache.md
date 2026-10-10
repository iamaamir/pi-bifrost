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
    "retryOnAllowanceExhausted": true,
    "allowanceCooldownScope": "provider",
    "failureThreshold": 3,
    "windowMinutes": 5,
    "cooldownMinutes": 60
  }
}
```

Reliability state persists in `.pi/bifrost-reliability.json`. After cooldown, Bifrost may try that model once. Success restores it; failure keeps it excluded longer.

An `allowance_exhausted` result means a provider reported that usage or credit is exhausted. An HTTP 402 result means billing was denied. It does not prove that the provider account has no credits. By default, both results pause every model with the same configured Pi provider ID. This rule applies to Auto and physical routing.

This rule does not identify shared billing accounts. Set `reliability.allowanceCooldownScope` to `model` to limit usage and billing pauses to the reported model.

Generic HTTP 429 rate limits remain provider-scoped. A validated retry time can pause that provider for up to five minutes. Without one, the pause is five seconds. These rate-limit pauses do not retry the current prompt. HTTP 5xx responses follow normal model failure handling.

Usage and billing pauses last for `cooldownMinutes`, which defaults to 60. Set `cooldownOnAllowanceExhausted: false` to disable these pauses. Set `retryOnAllowanceExhausted: false` to keep the pause but disable the one Auto retry. `/bifrost reliability` shows active provider pauses and recovery trials. Use `/bifrost reliability reset --provider <id>` to clear one provider pause. The command does not clear model reliability records.

In Pi Auto, an explicit usage or billing rejection can trigger one attempt on another configured model. The pause applies first. Pi must prove that every failed response was empty and came from the same model. Pi must also omit its earlier failed responses from the next request. The turn must have no tool calls, tool results, queued work, or other activity.

Physical routing, direct model bindings, explicit tier prefixes, exhausted fallback boundaries, tool continuations, unsafe turns, and turns with no eligible alternate do not retry. Pi can make its own bounded retry first. Bifrost does not send an extra classifier or probe request for recovery. See [ADR 0023](../adr/0023-bounded-allowance-recovery.md) and [provider pauses](../adr/0024-provider-usage-and-rate-pauses.md).

## Existing users: migrate reliability state

An existing project can migrate saved reliability records to a format that tracks each model admission for an Auto turn. This format supports Auto user turns only. Physical routing and direct utility requests stop before they run while it is enabled. To use those workflows, set `reliability.stateVersion` to `1` or remove that field, then reload. `/bifrost pin` and `/bifrost off` let you leave Auto without sending a turn, but they do not send a generation request.

The existing format is deprecated but remains supported for this release. Any future removal will be announced at least one published release ahead and will wait until the intended workflows are supported. There is no removal date.

The migration has two parts. You update the project configuration, then you prepare the state file. The command does not change the configuration or selected model.

1. Stop every other Pi session that can write this project's reliability file. Finish or cancel active and queued generations in the current session.
2. Edit `.pi/bifrost.json`. Set `schemaVersion` to `2` and `reliability.stateVersion` to `2`. Keep the other reliability values that you use.
3. In the current Pi session, run `/bifrost reload` while no generation is active.
4. Run `/bifrost reliability migrate` in that same session. The command reads the latest saved reliability state, backs it up to `.pi/bifrost-reliability-v1.json.backup`, and creates `.pi/bifrost-reliability-v2.json`. It does not change the selected model.
5. Select `bifrost/auto` in Pi's model picker before sending a user turn.

If no reliability state file exists, run `/bifrost reliability migrate --fresh` only when you intend to start with empty state. If the current state is invalid or the source changes during migration, Bifrost stops and preserves the files.

Current Bifrost saves and migration share a source lock. The command holds that lock while it reads and backs up the source. Older Bifrost versions and other writers do not use this lock. They can still change the source after migration, so keep every other session stopped until migration completes.

If migration stops because a lock is busy, do not remove the lock based only on its age or process ID. The default lock path is `.pi/bifrost-reliability.json.migration.lock`. With a custom `reliability.path`, the lock path is that exact path plus `.migration.lock`. Stop every process that can write the source, then inspect the exact lock file and its owner metadata. A process ID can be reused. Bifrost never removes a lock automatically. Remove only a lock that you have proved is stale. If ownership is uncertain, leave it in place. After you remove a verified stale lock, leave the source and backup unchanged. Restart or reload the old Pi session before using it, so its in-memory reliability state cannot write after migration.

Set `reliability.enabled: false` to stop reliability checks and provider pause enforcement. This does not erase saved reliability state. With it off, Bifrost does not read the migrated state file for routing. Optional `reliability.observations.enabled: true` stores bounded model-level failure categories and times. Raw provider error text is never persisted.

## Provider pauses are not account checks

A provider pause groups models by the provider ID in Pi configuration. Bifrost does not identify provider accounts or fetch live usage limits.

Current safeguards for quota-sensitive models:

- remove them from broad adaptive tiers;
- isolate them in a dedicated tier;
- bind them behind deliberate direct rules;
- use deterministic strategies instead of `random` where needed;
- preview routes before sending consequential work.

These pauses use errors from requests that Pi already sent. They do not provide authoritative quota data or prevent every provider charge.

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

Normalized prompt text can still contain sensitive terms. Add this setting to your existing `.pi/bifrost.json` to disable classification-cache use:

```json
{
  "cache": {
    "enabled": false
  }
}
```

Keep the model pools and other settings in that file. Disabling cache use does not remove saved entries. Run `/bifrost cache clear` to empty them. If you have no config, save starter pools with `/bifrost init` before you add this setting.

Inspect or clear it:

```text
/bifrost cache stats
/bifrost cache clear
```

`cache clear` empties the stored entries. It does not delete the cache file.

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
