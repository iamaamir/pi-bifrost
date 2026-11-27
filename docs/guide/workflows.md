# Common workflows

[Guide index](index.md) · [Command reference](commands.md) · [Troubleshooting](troubleshooting.md)

## Preview before generation

Before running preview commands, understand these effects:

- Preview does not submit a generation turn or activate the selected model.
- If a prompt, TypeSafe/Jev, or Pi-native classifier is enabled for that path, preview may send the prompt to the configured classifier and may incur classifier usage. Use `--offline` to bypass classifier calls for that request; it does not change session classifier settings. You can also run `/bifrost classifier off` for a rules-and-default-only preview for the current Pi session.
- Ordinary preview JSON (`--json`, without `--trace`) contains the prompt in the report; handle that output accordingly.
- Preview does not read a tier name from inside the prompt as an override. To preview a forced tier, check that tier’s candidates and strategy in configuration.

```text
/bifrost preview review this authorization design
```

For scripted checks, `--offline` avoids classifier calls for that request (example first):

```text
/bifrost preview --offline review this authorization design
```

## Scripted preview

Before running scripted preview, note the same safeguards: preview does not generate or activate a model; an enabled classifier may receive the prompt and may incur classifier usage unless you use `--offline` (or turn the classifier off for the session); ordinary preview JSON contains the prompt.

Use leading flags before the prompt: `--json`, `--trace`, and `--offline` in any order, each once. Any other leading token is part of the prompt.

```text
/bifrost preview --offline review this authorization design
/bifrost preview --json review this authorization design
/bifrost preview --offline --trace --json review this authorization design
```

Behavior summary (full contract in [Preview output](commands.md#preview-output)):

- Without `--offline`, the normal tier pipeline runs and an enabled classifier may receive the prompt (and may incur usage).
- With `--offline`, preview uses only local cache, rules, and the default tier for that request; it does not send the prompt to a configured classifier for that request and does not change session classifier settings.
- With `--json` and no `--trace`, Bifrost writes one ordinary preview report line on stderr prefixed with `[bifrost-json] ` (other `[bifrost]` lines may appear). Parse JSON after that prefix on that line; ignore other stderr lines. Ordinary preview JSON contains the prompt.
- With `--trace` (alone or with `--json`), preview emits a versioned route-trace summary on the same `[bifrost-json] ` line when `--json` is set, or as text when `--json` is not set. Traces do not include the prompt or model objects and include classifier disclosure when relevant. A trace failure is a `route-decision` object with an `outcome` (`usage`, `config_invalid`, `unclassified`, or another resolver outcome), not the ordinary preview `ok`/`error` shape.
- Ordinary preview JSON (`--json` without `--trace`) reports failures with `ok:false`, `prompt`, and `error` (`usage`, `unclassified`, or `config_invalid`) plus any recorded attempt details per the full contract in [Preview output](commands.md#preview-output). Structured trace JSON (`--trace --json`) reports failures by `outcome` in the versioned `route-decision` form described there.

## Keep one model for a long session

```text
/bifrost pin
```

Resume adaptive routing:

```text
/bifrost unpin
```

## Route one unpinned prompt through a known tier

```text
quick commit the changes
```

`quick` must be a configured tier. It is removed before the model receives the prompt.

## Change config

Edit the relevant `bifrost.json`, then run:

```text
/bifrost reload
```

## Migrate a config schema

Migration is preview-only by default. It updates only the selected file's `schemaVersion` to `2`, validates the full merged configuration, and preserves unrelated values and key order while normalizing JSON formatting. Apply requires the digest from the latest preview; stale edits are rejected. Before atomic replacement, Bifrost creates a private exact-byte backup beside the source. It does not rewrite other layers or auto-reload the active snapshot.

```text
/bifrost config migrate --source project
/bifrost config migrate --source project --apply --proposal <digest>
```

Use `--source workspace` for `bifrost.json` in the current directory or `--source user` for `getAgentDir()/bifrost.json`. Add `--json` to emit one `[bifrost-json] ` report line. After a successful migration, run `/bifrost reload` to activate the new config version.

## Reconcile generated model membership

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

A preview or an apply needs `--tier` and `--provider` together. `--recover` takes neither, so do not combine it with `--tier` or `--provider`. A bare `/bifrost config reconcile` prints the usage line.

Reconciliation updates only exact model keys owned by its sidecar. Existing manual entries are never adopted as generated membership. Incomplete, stale, or auth-unknown inventory cannot authorize removals. Apply uses a journal and keeps exact backups. `/bifrost config reconcile --recover` resumes or reports a pending journal. If a process crashed while holding a lock, recovery does not steal it: first verify that no Bifrost writer is active, inspect the exact lock files, and remove only locks proven stale before retrying recovery.

On first use, Bifrost loads provisional pools from Pi's available chat-model catalog and checks them in the background. It saves only successful generated pools and keeps manual entries and other configuration fields. Probe requests can use provider credits or reach rate limits. `/bifrost init` refreshes the catalog, reuses probe results from the last hour when they cover the current catalog, or probes before proposing pools. Pass `-f` to force new probes. Pass `--write` to save without the confirmation question. Init saves to `.pi/bifrost.json` by default. Use `-g` to save to the global user configuration. Init does not write the workspace `bifrost.json`. The target is shown before confirmation. Settings from lower configuration layers remain inherited.

## Diagnose unavailable models

```text
/bifrost probe
/bifrost debug
```

Probe sends `1+1=` to every model available in Pi's registry. The primary transport requests 5 output tokens -- a requested budget, not an enforced cap, since the host may raise or omit it and native transport may send additional requests. An empty response may trigger one minimal-session fallback. Provider usage or burst rate limits may apply. See [Troubleshooting](troubleshooting.md).