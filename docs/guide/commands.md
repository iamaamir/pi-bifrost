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

`validate` and `inspect` accept a leading `--json` flag. Both commands are read-only: they do not classify, refresh the registry, probe providers, or write reliability state. `inspect` shows only local registry/auth/circuit snapshots. Its “Bifrost last registry refresh age” is the time since this extension last refreshed Pi's registry, not a freshness claim about provider data. JSON mode emits a version-1 `[bifrost-json] ` report line to stderr. The validation report names its source as `loaded-effective-config`; it does not read un-reloaded disk edits.

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

Add `--trace` as a leading flag to inspect a versioned, content-free route decision. You can use it alone or with `--json`, in either order. The text view shows the classification source, configured candidate pools, reliability exclusions, selected model and strategy. `--trace --json` uses the same `[bifrost-json] ` marker and emits a version-1 `route-decision` object. It contains model identity strings and configured patterns, but never the prompt or model objects. If classifier routing is enabled, Bifrost warns that the classifier may receive the preview prompt before running classification and includes that disclosure in the result. The summary describes the resolver's selection; it does not report activation success or classifier stage timings. Without `--trace`, the existing `--json` fields and output remain unchanged.

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
