# Command reference

[Guide index](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

| Command | Behavior |
|---------|----------|
| `/bifrost` | Open dashboard and quick actions |
| `/bifrost init` | Reuse fresh probe results or probe registry models, then propose configuration and guide you to `/bifrost classifier`; pass `-f` to skip probe reuse and re-probe |
| `/bifrost probe` | Send a tiny request to each registry model and report availability; usage may apply |
| `/bifrost preview <prompt>` | Show the route without generating; leading `--json` keeps the existing report, while leading `--trace` adds a content-free decision summary; an enabled classifier may receive the prompt, and a tier name in the prompt is not applied |
| `/bifrost on` | Enable routing policy |
| `/bifrost off` | Disable routing policy |
| `/bifrost pin` | Hard-lock current model for this session |
| `/bifrost unpin` | Resume per-message routing |
| `/bifrost reload` | Reload merged configuration |
| `/bifrost validate` | Check the active loaded configuration and local registry references; run `/bifrost reload` after editing config files |
| `/bifrost inspect` | Show configured model availability, auth presence, and local reliability circuits without routing or probing |
| `/bifrost config reconcile` | Preview exact generated model membership for one selected config source, tier, and provider; apply only with the reviewed digest |
| `/bifrost reliability migrate` | Prepare the configured receipt-owned reliability v2 state without changing the selected model; add `--fresh` only when no v1 state exists |
| `/bifrost cache stats` | Inspect local classification cache |
| `/bifrost cache clear` | Clear local classification cache |
| `/bifrost classifier` | Choose `prompt`, `typesafe`, or `pi-native`. The Pi-native picker can select a catalog model or use the default |
| `/bifrost classifier on` | Enable configured classifier |
| `/bifrost classifier off` | Disable classifier while retaining routing |
| `/bifrost classifier test` | Make fresh classifier request and show result/fallback |
| `/bifrost classifier status` | Show effective backend, detection reason, model, fallback, and safe metrics |
| `/bifrost debug` | Show effective routing and reliability diagnostics |
| `/bifrost providers` | List providers available through Pi |
| `/bifrost benchmark <prompt>` | Classify a prompt and show the outcome without generating |

`validate` and `inspect` accept a leading `--json` flag. Both commands are read-only: they do not classify, refresh the registry, probe providers, or write reliability state. `inspect` shows local registry/auth/circuit snapshots and, when affinity observation is enabled, the proven Auto anchor's model and age without branch or prompt data. Its “Bifrost last registry refresh age” is the time since this extension last refreshed Pi's registry, not a freshness claim about provider data. JSON mode emits a version-1 `[bifrost-json] ` report line to stderr. The validation report names its source as `loaded-effective-config`; it does not read un-reloaded disk edits.

## Common workflows

### Preview before generation

```text
/bifrost preview review this authorization design
```

Preview does not submit a generation turn or activate the selected model. It does run the normal tier pipeline, so an enabled prompt, TypeSafe/Jev, or Pi-native classifier can receive the preview prompt and incur classifier usage. Run `/bifrost classifier off` first for a rules-and-default-only preview.

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
| `backend`, `model`, `confidence` | Classifier judgment; absent when no classifier ran |
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

`error` is `usage` when the prompt was missing, and `unclassified` when no tier matched and no default tier is configured. A failure report carries `prompt` and `error` only; it has no routing keys. The human `usage` and `no tier matched` messages still appear, so the same command is usable from a terminal.

Add `--trace` as a leading flag to inspect a versioned, content-free route decision. You can use it alone or with `--json`, in either order. The text view shows the classification source, configured candidate pools, hard reserve and circuit exclusions, selected model and strategy, and any applicable affinity observation. Under `retain-within-tier`, affinity shows both the strategy winner and selected anchor. In the structured route summary, billing-preference evidence is separate from hard exclusions; a nonpreferred candidate remains marked eligible even when it is outside the final selection pool. `--trace --json` uses the same `[bifrost-json] ` marker and emits a version-1 `route-decision` object. It contains model identity strings and configured patterns, but never the prompt or model objects. If classifier routing is enabled, Bifrost warns that the classifier may receive the preview prompt before running classification and includes that disclosure in the result. The summary describes the resolver's selection; it does not report activation success or classifier stage timings. Without `--trace`, the existing `--json` fields and output remain unchanged.

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

### Reconcile generated model membership

Reconciliation changes one source and one tier at a time. The default source is the project file `.pi/bifrost.json`; `--source user` selects `getAgentDir()/bifrost.json` (normally `~/.pi/agent/bifrost.json`). It never flattens the merged config into either source. A preview reads local registry and refresh evidence only; it does not contact providers. If that evidence is stale, `--refresh` explicitly refreshes only the selected provider and still produces a preview. Apply is a separate command and requires the proposal digest from that preview:

```text
/bifrost config reconcile --tier general --provider openai
/bifrost config reconcile --tier general --provider openai --apply --proposal <digest>
```

Use `--source user` to select the user config file. The project, workspace, and extension layers remain part of prospective validation, so a higher layer may still override a user-layer value. Add `--json` to emit one `[bifrost-json] ` report line.

An explicit catalog refresh is network-enabled and can incur provider requests. It cannot be combined with `--apply`; review its proposal and run a separate apply command:

```text
/bifrost config reconcile --tier general --provider openai --refresh
```

Reconciliation updates only exact model keys owned by its sidecar. Existing manual entries are never adopted as generated membership. Incomplete, stale, or auth-unknown inventory cannot authorize removals. Apply uses a journal and keeps exact backups. `/bifrost config reconcile --recover` resumes or reports a pending journal. If a process crashed while holding a lock, recovery does not steal it: first verify that no Bifrost writer is active, inspect the exact lock files, and remove only locks proven stale before retrying recovery.

`/bifrost init` retains its current probe and confirmation flow. After a confirmed generation, it writes the config and an exact-membership ownership receipt together. Once that receipt exists, init does not regenerate the config: replacing it could discard managed-membership history. Use `config reconcile` for later membership changes; it keeps the receipt and exact backups in step with the selected tier.

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
| Classifier on/off | Yes | Follows shared runtime/config state |

Pin is a hard lock. A tier name at the start of a message is not applied while pinned.
