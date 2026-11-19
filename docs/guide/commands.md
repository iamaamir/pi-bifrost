# Command reference

[Guide index](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

| Command | Behavior |
|---------|----------|
| `/bifrost` | Open dashboard and quick actions |
| `/bifrost init` | Refresh Pi's model catalog, reuse probe results from the last hour or probe before proposing pools, then ask once before saving; pass `-f` to force fresh probes and `--write` to save without the prompt |
| `/bifrost probe` | Send a tiny request to each registry model and report availability; usage may apply |
| `/bifrost preview <prompt>` | Show the route without generating; leading `--offline` uses only local cache, rules and the default tier; `--json` keeps the existing report, and `--trace` adds a content-free summary. Without `--offline`, an enabled classifier may receive the prompt. A tier name in the prompt is not applied |
| `/bifrost on` | Enable routing policy |
| `/bifrost off` | Disable routing policy |
| `/bifrost pin` | Hard-lock current model for this session |
| `/bifrost unpin` | Resume per-message routing |
| `/bifrost reload` | Reload merged configuration |
| `/bifrost validate` | Check the active loaded configuration and local registry references; run `/bifrost reload` after editing config files |
| `/bifrost inspect` | Show configured model availability, auth presence, and local reliability circuits without routing, classifying, or probing |
| `/bifrost config reconcile` | Preview exact generated model membership for one selected config source, tier, and provider; apply only with the reviewed digest |
| `/bifrost config migrate` | Preview schema-version migration for one config source; apply only with the reviewed digest and exact backup |
| `/bifrost reliability migrate` | Prepare migrated reliability state; see the [existing-user migration steps](reliability-and-cache.md#existing-users-migrate-reliability-state) |
| `/bifrost reliability` | Show active provider pauses and recovery trials |
| `/bifrost reliability reset` | Clear one provider pause and its trial state with `--provider <exact-id>`. Model reliability records stay unchanged. |
| `/bifrost cache stats` | Inspect local classification cache |
| `/bifrost cost` | Browse usage recorded in this Pi session and Pi-reported cost estimates |
| `/bifrost cache clear` | Empty saved local classification-cache entries |
| `/bifrost classifier` | Choose `prompt`, `typesafe`, or `pi-native`. The Pi-native picker can select a catalog model or use the default |
| `/bifrost classifier on` | Enable classifier for this Pi session after backend validation |
| `/bifrost classifier off` | Disable classifier for this Pi session while retaining routing |
| `/bifrost classifier inherit` | Clear this session's classifier override and resume configured behavior; invalid runtime state still blocks classification |
| `/bifrost classifier test` | Make fresh classifier request and show result/fallback |
| `/bifrost classifier status` | Show effective backend, detection reason, model, fallback, and safe metrics |
| `/bifrost debug` | Show effective routing and reliability diagnostics |
| `/bifrost providers` | List providers available through Pi |
| `/bifrost benchmark <prompt>` | Classify a prompt and show the outcome without generating |

`preview --offline` skips both direct and prompt classifiers for that request. It does not change your classifier settings. Invalid routing configuration stops preview before classification and returns `config_invalid`. Fix the reported source and run `/bifrost reload`.

`validate` and `inspect` accept a leading `--json` flag. Both commands are read-only: they do not classify, refresh the registry, probe providers, or write reliability state. They report configured classifier policy and effective session state. `inspect` shows local registry/auth/circuit snapshots and the effective affinity mode: Auto defaults to within-tier retention, while physical routing defaults off. It reports the mode source and, when active, the proven Auto anchor's model and age without branch or prompt data. Its “Bifrost last registry refresh age” is the time since this extension last refreshed Pi's registry, not a freshness claim about provider data. JSON mode emits a version-1 `[bifrost-json] ` report line to stderr. The validation report names its source as `loaded-effective-config`; it does not read un-reloaded disk edits.

On first use, when no meaningful configuration, route file, runtime routing preference, or explicit routing override blocks setup, Bifrost loads provisional pools from Pi's catalog before generation. It checks model access in the background and saves only successful generated pools with an ownership receipt. An empty `{}` configuration does not block setup. If every probe fails or a safe save cannot finish, Bifrost leaves configuration unchanged and warns. Probe requests can use provider credits or reach rate limits.

Provider usage and billing pauses use Pi's configured provider ID. Bifrost does not identify shared billing accounts. Use `/bifrost reliability` to see active pauses. The reset command accepts only one exact provider ID that Bifrost knows. It stops during an active recovery trial.

`/bifrost cost` reads Pi's session entries on demand. In the interactive view, use **Tab** to switch between Requests and Models for the current branch, **Up/Down** to move, **Enter** to expand or collapse a group, and **Esc** to close. Requests are derived from user-message boundaries; they are not a routing trace. The separate all-retained total may include copied fork history and alternate branches. The report shows assistant responses by reported model and auxiliary usage when Pi records it, including compaction. Unknown costs remain unknown; a known-cost subtotal does not include them. The report does not display or store prompt or tool content, and historical routing reasons are unavailable. Costs are Pi-reported estimates, not billing records; zero does not confirm free usage. Classifier and probe overhead may be outside the session or unknown. The report has no baseline and makes no savings claim. When an interactive TUI is unavailable, the command prints a plain-text report.

Init remains available to refresh the catalog or reconcile model lists. It reuses probe results from the last hour unless you pass `-f`. Init preserves settings and handwritten model entries in the file it edits. Settings from other files remain inherited. It does not copy private classifier templates or pin inherited user settings into the edited file. Its summary does not show every model ID, selection rule, or default tier. After init saves, inspect the lists and status. Edit the saved configuration before a model answers if needed.

Init displays its save target. It saves to project `.pi/bifrost.json` by default, or to user `~/.pi/agent/bifrost.json` when you pass `-g`.

### Run init without a confirmation prompt

Init writes only after its one confirmation question. Pass `--write` to skip that question and save the reviewed proposal; it saves to the displayed target in a TUI and outside one. Outside a TUI without `--write`, init still refreshes the catalog and prints the proposal, then stops before writing and logs `run in TUI or use --write to persist`. Combine the flags when you also need fresh probes or the global target:

```text
/bifrost init --write
/bifrost init -f --write
/bifrost init -g --write
```

`--write` skips only the question. Every other guard still applies: a proposal that would shadow a handwritten inherited pool, a cancelled catalog refresh, and a failed save all leave configuration unchanged.

If a proposed project pool would replace a handwritten pool in your global or workspace config with different models, init stops without saving. Pools that init generated before (tracked by an ownership receipt) and empty pools do not block init. Edit the existing source or review a workspace update with `/bifrost config reconcile --source workspace`; use `-g` when you intend to update the global source.

For safe migration, follow the [existing-user migration steps](reliability-and-cache.md#existing-users-migrate-reliability-state).

## Common workflows

### Preview before generation

```text
/bifrost preview review this authorization design
```

Preview does not submit a generation turn or activate the selected model. It does run the normal tier pipeline, so an enabled prompt, TypeSafe/Jev, or Pi-native classifier can receive the preview prompt and incur classifier usage. Run `/bifrost classifier off` first for a rules-and-default-only preview. This choice lasts for the current Pi session.

Preview does not read a tier name from the prompt. To preview a forced tier, confirm that tier's candidates and strategy in configuration instead.

### Scripted preview

```text
/bifrost preview --json review this authorization design
```

`--json` is recognized only as the first token, so a prompt that merely contains the string `--json` is passed through unchanged. With the flag, the human view is replaced by one line on stderr prefixed with `[bifrost-json] `:

```text
[bifrost-json] {"ok":true,"prompt":"direct hit","source":"fallback","tier":"general","strategy":"first","fallbackReason":"requested_tier_unavailable","requestedCandidates":[],"fallbackCandidates":[],"defaultTier":"general"}
```

That line is not the only output. Outside the TUI, Bifrost also writes progress lines such as `[bifrost] Classifying preview prompt...` to stderr, and the human `usage` and `no tier matched` messages still appear. All of those start with `[bifrost] `. So the contract is the marker, not the absence of other lines: find the line that starts with `[bifrost-json] `, then parse the rest of that line as JSON. Ignore any other stderr output.

Keys are omitted when they do not apply, so test for the key itself rather than for a placeholder value:

| Key | Meaning |
|-----|---------|
| `ok` | `true` when a route was resolved, `false` when it was not |
| `prompt` | The prompt that was classified |
| `source` | Where the tier came from: `cache`, `classifier`, `regex`, `inline`, or `fallback`. `cache` means the prompt was already classified in this session, so previewing it twice reports `cache` the second time; `inline` means a tier named in the prompt as an inline override |
| `backend`, `model`, `confidence` | Accepted classifier judgment; absent when no classifier judgment was accepted |
| `classifierAttempt` | Direct classifier attempt detail: `backend`, `outcome`, `fallbackKind`, plus `tier` (the tier the backend proposed, which a rejected judgment still names), `model` (the resolved classifier model, when one is known) and the exact `confidence` when the backend reported a valid value. Present even when the attempt was rejected, so a rejected value can be compared with `classifier.minConfidence`; it never implies the judgment was accepted |
| `tier`, `strategy` | The tier that resolved and the strategy used for it |
| `selectedTier`, `selected` | The tier and model actually chosen; both absent when nothing resolved, so a tier named `none` is not mistaken for "no choice" |
| `fallbackReason` | Why the requested tier could not be used; absent when it was used |
| `requestedCandidates`, `fallbackCandidates` | Candidate lines for the requested tier and for the default tier |
| `defaultTier` | The configured default tier; absent when none is configured |

A failure is still one line, so a script never has to infer the outcome from a missing line:

```text
[bifrost-json] {"ok":false,"prompt":"","error":"usage"}
[bifrost-json] {"ok":false,"prompt":"hello","error":"unclassified"}
```

`error` is `usage` when the prompt was missing, and `unclassified` when no tier matched and no default tier is configured. A failure report carries `prompt` and `error`, plus `classifierAttempt` when a direct classifier attempt was recorded (an aborted attempt is not reported), including a classifier-reported timeout that produced no judgment, where `tier` is the tier the backend proposed, `model` names the resolved classifier model when known — that is not proof the provider answered — and `confidence` appears only when the backend reported a valid value; it has no accepted-judgment or routing keys, and `ok` stays `false`. The human `usage` and `no tier matched` messages still appear, so the same command is usable from a terminal. When an attempt is available, the human view also shows it, with its exact confidence when one was reported, instead of only reporting that no tier matched.

Add `--trace` as a leading flag to inspect a versioned, content-free route decision. You can use it alone or with `--json`, in either order. The text view shows the classification source, configured candidate pools, hard reserve and circuit exclusions, selected model and strategy, any applicable affinity observation, and, only when it adds detail the accepted classification does not already state, the direct classifier attempt (`backend`, `outcome`, `fallbackKind`, plus `tier`, `model` and `confidence` when reported). A plain accepted attempt repeats the `classifier` lines and is not printed twice; a rejected, timed-out, or differently attributed attempt is always printed. It labels affinity as `auto_default`, `physical_default`, or `config`. Under `retain-within-tier`, affinity shows both the strategy winner and selected anchor. In the structured route summary, billing-preference evidence is separate from hard exclusions; a nonpreferred candidate remains marked eligible even when it is outside the final selection pool. `--trace --json` uses the same `[bifrost-json] ` marker and emits a version-1 `route-decision` object. It contains model identity strings and configured patterns, but never the prompt or model objects. If classifier routing is enabled, Bifrost warns that the classifier may receive the preview prompt before running classification and includes that disclosure in the result. The summary describes the resolver's selection; it does not report activation success or classifier stage timings. Without `--trace`, `--json` output is unchanged except for one additive field: `classifierAttempt` appears when a direct classifier attempt was recorded. Every existing key keeps its meaning and shape, so a consumer that ignores unknown keys is unaffected, while a strict shape check must allow that optional field.

### Keep one model for a long session

```text
/bifrost pin
```

Resume adaptive routing:

```text
/bifrost unpin
```

### Route one unpinned prompt through a known tier

```text
quick commit the changes
```

`quick` must be a configured tier. It is removed before the model receives the prompt.

### Change config

Edit the relevant `bifrost.json`, then run:

```text
/bifrost reload
```

### Migrate a config schema

Migration is preview-only by default. It updates only the selected file's `schemaVersion` to `2`, validates the full merged configuration, and preserves unrelated values and key order while normalizing JSON formatting. Apply requires the digest from the latest preview; stale edits are rejected. Before atomic replacement, Bifrost creates a private exact-byte backup beside the source. It does not rewrite other layers or auto-reload the active snapshot.

```text
/bifrost config migrate --source project
/bifrost config migrate --source project --apply --proposal <digest>
```

Use `--source workspace` for `bifrost.json` in the current directory or `--source user` for `getAgentDir()/bifrost.json`. Add `--json` to emit one `[bifrost-json] ` report line. After a successful migration, run `/bifrost reload` to activate the new config version.

### Reconcile generated model membership

Reconciliation changes one source and one tier at a time. The default source is the project file `.pi/bifrost.json`; `--source workspace` selects `bifrost.json` in the current directory; `--source user` selects `getAgentDir()/bifrost.json` (normally `~/.pi/agent/bifrost.json`). Workspace membership ownership is stored separately under `.pi/` so it cannot be confused with project ownership. It never flattens the merged config into either source. A preview reads local registry and refresh evidence only; it does not contact providers. If that evidence is stale, `--refresh` explicitly refreshes only the selected provider and still produces a preview. Apply is a separate command and requires the proposal digest from that preview:

```text
/bifrost config reconcile --tier general --provider openai
/bifrost config reconcile --tier general --provider openai --apply --proposal <digest>
```

Use `--source workspace` or `--source user` to select those config files. The other project, workspace, and user layers remain part of prospective validation, so a higher layer may still override the selected source. The bundled package template is not a runtime layer. Add `--json` to emit one `[bifrost-json] ` report line.

An explicit catalog refresh is network-enabled and can incur provider requests. It cannot be combined with `--apply`; review its proposal and run a separate apply command:

```text
/bifrost config reconcile --tier general --provider openai --refresh
```

Reconciliation updates only exact model keys owned by its sidecar. Existing manual entries are never adopted as generated membership. Incomplete, stale, or auth-unknown inventory cannot authorize removals. Apply uses a journal and keeps exact backups. `/bifrost config reconcile --recover` resumes or reports a pending journal. If a process crashed while holding a lock, recovery does not steal it: first verify that no Bifrost writer is active, inspect the exact lock files, and remove only locks proven stale before retrying recovery.

On first use, Bifrost loads provisional pools from Pi's available chat-model catalog and checks them in the background. It saves only successful generated pools and keeps manual entries and other configuration fields. Probe requests can use provider credits or reach rate limits. `/bifrost init` refreshes the catalog, reuses probe results from the last hour, or probes before proposing pools. Pass `-f` to force fresh probes and `--write` to save without the confirmation question. Init saves to `.pi/bifrost.json` by default; use `-g` to save to the global user config. Init does not write the workspace `bifrost.json`. The target is shown before confirmation. Settings from lower configuration layers remain inherited.

### Diagnose unavailable models

```text
/bifrost probe
/bifrost debug
```

Probe sends `1+1=` to every model available in Pi's registry. The primary transport caps output at 5 tokens; an empty response may trigger one minimal-session fallback. Provider usage or burst rate limits may apply. See [Troubleshooting](troubleshooting.md).

## Persistence summary

| Control | Survives restart | Propagates to child sessions |
|---------|------------------|------------------------------|
| `/bifrost on` / `off` | Yes | Yes, through shared runtime policy |
| `/bifrost pin` / `unpin` | No | No |
| `/bifrost classifier on` / `off` / `inherit` | No | No; choice applies to this Pi session only |

Pin is a hard lock. A tier name at the start of a message is not applied while pinned.
