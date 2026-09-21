# Command reference

[Guide index](index.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

| Command | Behavior |
|---------|----------|
| `/bifrost` | Open dashboard and quick actions |
| `/bifrost init` | Reuse fresh probe results or probe registry models, then propose configuration |
| `/bifrost probe` | Send a tiny request to each registry model and report availability; usage may apply |
| `/bifrost preview <prompt>` | Show the model a prompt would use, without generating; an enabled classifier may receive the prompt, and a tier name in the prompt is not applied |
| `/bifrost on` | Enable routing policy |
| `/bifrost off` | Disable routing policy |
| `/bifrost pin` | Hard-lock current model for this session |
| `/bifrost unpin` | Resume per-message routing |
| `/bifrost reload` | Reload merged configuration |
| `/bifrost cache stats` | Inspect local classification cache |
| `/bifrost cache clear` | Clear local classification cache |
| `/bifrost classifier` | Open classifier backend/model picker |
| `/bifrost classifier on` | Enable configured classifier |
| `/bifrost classifier off` | Disable classifier while retaining routing |
| `/bifrost classifier test` | Make fresh classifier request and show result/fallback |
| `/bifrost classifier status` | Show backend, model, credentials, fallback, and safe metrics |
| `/bifrost debug` | Show effective routing and reliability diagnostics |
| `/bifrost providers` | List providers available through Pi |
| `/bifrost benchmark <prompt>` | Classify a prompt and show the outcome without generating |

## Common workflows

### Preview before generation

```text
/bifrost preview review this authorization design
```

Preview does not submit a generation turn or activate the selected model. It does run the normal tier pipeline, so an enabled prompt or TypeSafe/Jev classifier may receive the preview prompt and incur classifier usage. Run `/bifrost classifier off` first for a rules-and-default-only preview.

Preview does not read a tier name from the prompt. To preview a forced tier, confirm that tier's candidates and strategy in configuration instead.

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
