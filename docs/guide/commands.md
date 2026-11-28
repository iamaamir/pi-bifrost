# Command reference

[Guide index](index.md) · [Common workflows](workflows.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

| Command | Behavior |
|---------|----------|
| `/bifrost` | Open dashboard and quick actions |
| `/bifrost init` | Refresh Pi's model catalog. Bifrost reuses probe results from the last hour only when they cover the current catalog. If no recent results exist, or the catalog changed, it probes the models before it proposes pools. Then it asks one time before it saves. Pass `-f` to force new probes. Pass `--write` to save without the question |
| `/bifrost probe` | Send a tiny request to each registry model and report availability; usage may apply |
| `/bifrost preview <prompt>` | Show the route without generating. Put leading flags before the prompt: `--json`, `--trace`, and `--offline` in any order (use each once). `--offline` uses only local cache, rules, and the default tier for that request. Without `--offline`, an enabled classifier may receive the prompt. `--json` emits a machine-readable report line; `--trace` adds a versioned route summary (with `--json`, the same line carries the trace JSON form). A tier name inside the prompt is not applied. See [Preview output](#preview-output). |
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

## Preview output

This section is the canonical reference for `bifrost preview` machine-readable and trace output. Step-by-step examples are in [Common workflows](workflows.md).

Preview runs in the Pi command context. Behavior depends on flags:

- **`--offline`**: uses only local cache, rules, and the default tier for that request. It does not send the preview prompt to a configured classifier for that request and does not change session classifier settings (`/bifrost classifier off` / `on`). It does not generate a response and does not activate a model.
- **Without `--offline`**: the normal tier pipeline runs. If a prompt, TypeSafe/Jev, or Pi-native classifier is enabled for that path, it may receive the preview prompt. This is the same classifier path described in the classifier guide; see [Classifiers](classifiers.md). Run `/bifrost classifier off` for a rules-and-default-only preview for the current session when you want to avoid that classifier call for this session.
- **Leading flags**: put leading flags before the prompt. Supported leading flags are `--json`, `--trace`, and `--offline` in any order; use each once. Flag parsing stops at the first duplicate or unrecognized token, and that token and the remaining text become the prompt. For example, in `preview --json --json --offline review this code` the second `--json` ends flag parsing, so `--offline` is not applied.
- **`--json`**: writes one machine-readable line on stderr prefixed with `[bifrost-json] ` (in addition to normal `[bifrost]` progress and messages in non-TUI contexts). Find that line and parse the JSON on the rest of that line. Other stderr lines may appear. Ignore lines that do not start with that marker.
- **`--trace`**: adds a versioned route-trace summary. Use alone for human-readable trace output or with `--json` for the trace JSON form on the same `[bifrost-json] ` line. Route traces describe the resolver selection and do not include the prompt or model objects. If classifier routing is enabled, Bifrost warns before classification when the run may send the prompt to a classifier; the trace includes that disclosure. The trace summarizes selection; it does not report activation success or classifier stage timings.
- Preview does not generate a response and does not activate the selected model. These boundaries apply to all preview forms.
- Preview does not read a tier name from inside the prompt text as an override. To preview a forced tier’s candidates and strategy, check configuration for that tier instead.
- Invalid routing configuration stops preview before classification and returns `config_invalid` (with a `[bifrost-json] ` failure line when `--json` is set). Fix the reported source and run `/bifrost reload`.

### Normal preview JSON (`--json`, no `--trace`)

One line on stderr: `[bifrost-json] ` followed by a JSON object (the marker is the contract; other stderr lines may appear).

Example (success):

```text
[bifrost-json] {"ok":true,"prompt":"direct hit","source":"fallback","tier":"general","strategy":"first","fallbackReason":"requested_tier_unavailable","requestedCandidates":[],"fallbackCandidates":[],"defaultTier":"general"}
```

Keys are omitted when they do not apply; test for key presence rather than placeholder values.

| Key | Meaning |
|-----|---------|
| `ok` | In ordinary preview JSON (`--json` without `--trace`), `true` means the normal classified or fallback report was produced (not a `usage`, `unclassified`, or `config_invalid` failure). It does not mean a model was selected: `selected` and `selectedTier` may be absent even when `ok` is `true`. A successful report does not imply model activation or generation. For structured trace JSON (`--trace --json`), use `outcome` in the `route-decision` object instead of this key. |
| `prompt` | The prompt that was classified (included in ordinary preview JSON) |
| `source` | Tier source in the report: `cache`, `classifier`, `regex`, or `fallback`. A `cache` hit means an existing classification-cache entry was read for that prompt; preview does not insert a new classification entry into the cache. The cache may still be read (and may record lookup-related metadata such as age in its own storage behavior) without creating a new entry. Whether the cache is session-only depends on its storage and lifecycle, not this field alone. `inline` is part of the declared preview source type but is not produced by this preview path. |
| `backend`, `model`, `confidence` | Accepted classifier judgment; absent when no classifier judgment was accepted |
| `classifierAttempt` | Direct classifier attempt detail: `backend`, `outcome`, `fallbackKind`, plus `fallbackModel` when one is named, `circuitOpenUntil` when the classifier circuit is open, `tier` (the tier the backend proposed, which a rejected judgment still names), `model` (the resolved classifier model, when one is known) and the exact `confidence` when the backend reported a valid value. Present even when the attempt was rejected, so a rejected value can be compared with `classifier.minConfidence`. It never implies the judgment was accepted |
| `tier` | The classified or fallback tier used by the preview pipeline (the requested/effective tier in that report). It is not the same as the ultimately selected route model choice except by coincidence; check `selectedTier` and `selected` for what would be routed when a selection resolved. |
| `strategy` | The routing strategy used for the resolved tier context in the report |
| `selectedTier`, `selected` | The tier and model actually chosen; both absent when nothing resolved, so a tier named `none` is not mistaken for “no choice” |
| `fallbackReason` | Why the requested tier could not be used; absent when it was used |
| `requestedCandidates`, `fallbackCandidates` | Candidate lines for the requested tier and for the default tier |
| `defaultTier` | The configured default tier; absent when none is configured |
| `signInNote` | The sign-in advisory for this route, when the report has one |
| `fallbackBoundary`, `attemptedTiers` | Present only when an explicit `tierPolicies` boundary applied. `fallbackBoundary` is `explicit`, and `attemptedTiers` lists the tiers that were tried |

Failure examples (ordinary preview JSON, `--json` without `--trace`; still one line):

```text
[bifrost-json] {"ok":false,"prompt":"","error":"usage"}
[bifrost-json] {"ok":false,"prompt":"hello","error":"unclassified"}
```

- In ordinary preview JSON, `error` is `usage` when the prompt was missing, `unclassified` when no tier matched and no default tier is configured, and `config_invalid` when the effective configuration blocks routing. Structured trace JSON (`--trace --json`) uses the `route-decision` form with `outcome` instead of this `ok`/`error` shape.
- An ordinary preview failure report carries `prompt` and `error`, plus `classifierAttempt` when a direct classifier attempt was recorded (an aborted attempt is not reported), including a classifier-reported timeout that produced no judgment. When present in that context, `tier` is the tier the backend proposed, `model` names the resolved classifier model when known (not proof the provider answered), and `confidence` appears only when the backend reported a valid value. A failure report has no accepted-judgment routing keys beyond what is stated here and `ok` is always `false`.
- The human `usage` and `no tier matched` messages still appear in normal output, so the command remains usable from a terminal. When an attempt is available, the human view may also show it (including its exact confidence when reported) instead of only reporting that no tier matched.
- In normal (non-trace) JSON, the `prompt` field is included in the report. Without `--trace`, `--json` output is unchanged except that `classifierAttempt` may appear when a direct classifier attempt was recorded; every existing key keeps its meaning and shape, so consumers that ignore unknown keys remain compatible while strict shape checks must allow the optional `classifierAttempt` field.

### Route trace (`--trace`)

Add `--trace` as a leading flag to inspect a versioned, content-free route decision. Use it alone or with `--json`, in either order.

- Text view (no `--json`): shows the classification source, configured candidate pools, hard reserve and circuit exclusions, selected model and strategy, any applicable affinity observation, and, only when it adds detail the accepted classification does not already state, the direct classifier attempt (`backend`, `outcome`, `fallbackKind`, plus `tier`, `model`, and `confidence` when reported). A plain accepted attempt that repeats the `classifier` lines is not printed twice; a rejected, timed-out, or differently attributed attempt is always printed. Affinity is labeled `auto_default`, `physical_default`, or `config`. Under `retain-within-tier`, affinity shows both the strategy winner and selected anchor. In the structured route summary, billing-preference evidence is separate from hard exclusions; a nonpreferred candidate remains marked eligible even when it is outside the final selection pool.
- Structured route trace JSON (`--trace --json`): uses the same `[bifrost-json] ` marker and emits a version-1 `route-decision` object. It contains model identity strings and configured patterns, but never the prompt or model objects. If classifier routing is enabled, Bifrost warns that the classifier may receive the preview prompt before running classification and includes that disclosure in the result. The summary describes the resolver’s selection; it does not report activation success or classifier stage timings. The `classifierDisclosure` field states whether classifier routing was enabled for the context of the trace and whether the configured classifier may receive the prompt for that run (for example, `--offline` reports that the classifier will not be sent the prompt for that request).

## `validate` and `inspect`

`validate` and `inspect` accept a leading `--json` flag. Both commands are read-only: they do not classify, refresh the registry, probe providers, or write reliability state. They report configured classifier policy and effective session state. `inspect` shows local registry/auth/circuit snapshots and the effective affinity mode: Auto defaults to within-tier retention, while physical routing defaults off. It reports the mode source and, when active, the proven Auto anchor’s model and age without branch or prompt data. Its “Bifrost last registry refresh age” is the time since this extension last refreshed Pi’s registry, not a freshness claim about provider data. JSON mode emits a version-1 `[bifrost-json] ` report line to stderr. The validation report names its source as `loaded-effective-config`; it does not read un-reloaded disk edits.

## Registry refresh and setup notes

On a relevant routing or input event, Bifrost checks Pi’s model catalog if its local snapshot is older than 30 seconds. This is a freshness threshold, not a periodic timer. If a newly added model is missing or the catalog looks stale, request a fresh check with `/bifrost init`, or with `/bifrost config reconcile --tier <tier> --provider <provider> --refresh`. Reconciliation needs both flags; the explicit refresh contacts only the selected provider and still produces a preview. See [Reconcile generated model membership](workflows.md#reconcile-generated-model-membership). `/bifrost inspect` shows the threshold, the age of the last local refresh, and whether a refresh is needed; `/bifrost debug` shows the threshold too.

On first use, when no meaningful configuration, route file, runtime routing preference, or explicit routing override blocks setup, Bifrost loads provisional pools from Pi’s catalog before generation. It checks model access in the background and saves only successful generated pools with an ownership receipt. An empty `{}` configuration does not block setup. If every probe fails or a safe save cannot finish, Bifrost leaves configuration unchanged and warns. Probe requests can use provider credits or reach rate limits.

Provider usage and billing pauses use Pi’s configured provider ID. Bifrost does not identify shared billing accounts. Use `/bifrost reliability` to see active pauses. The reset command accepts only one exact provider ID that Bifrost knows. It stops during an active recovery trial.

## Cost reporting

`/bifrost cost` reads Pi’s session entries on demand. In the interactive view, use **Tab** to switch between Requests and Models for the current branch, **Up/Down** to move, **Enter** to expand or collapse a group, and **Esc** to close. Requests are derived from user-message boundaries; they are not a routing trace. The separate all-retained total may include copied fork history and alternate branches. The report shows assistant responses by reported model and auxiliary usage when Pi records it, including compaction. Unknown costs remain unknown; a known-cost subtotal does not include them. The report does not display or store prompt or tool content, and historical routing reasons are unavailable. Costs are Pi-reported estimates, not billing records; zero does not confirm free usage. Classifier and probe overhead may be outside the session or unknown. The report has no baseline and makes no savings claim. When an interactive TUI is unavailable, the command prints a plain-text report.

## Init and refresh notes

Init remains available to refresh the catalog or reconcile model lists. It reuses recent saved probe results for the current catalog when possible, and probes when it cannot. When it reuses saved results, init shows their approximate age. Pass `-f` to force a fresh check. Init preserves settings and handwritten model entries in the file it edits. Settings from other files remain inherited. It copies only the settings it writes, so private classifier templates and inherited user settings stay in their source layers. Its summary highlights membership changes; inspect the saved lists, selection rules, default tier, and status afterward. Edit the saved configuration before a model answers if needed.

Init displays its save target. It saves to project `.pi/bifrost.json` by default, or to user `~/.pi/agent/bifrost.json` when you pass `-g`.

### Run init without a confirmation prompt

Init writes the configuration only after one confirmation question. Pass `--write` to save the reviewed proposal without that question. `--write` saves to the target that init shows.

A TUI and an RPC session can ask the question. RPC reports `hasUI` as true, so Pi sends the question to the client. A session with no UI cannot ask the question. Without `--write`, it shows the proposal and stops before writing with `run in TUI or use --write to persist`.

If you also want new probes or the global target, use the flags together:

```text
/bifrost init --write
/bifrost init -f --write
/bifrost init --write -g
```

`--write` removes only the question. The other guards stay in effect. Init keeps a handwritten inherited pool and stops before writing a proposal that would shadow it. A canceled catalog refresh writes nothing.

A failure before the commit keeps the files. A failure after Bifrost replaces the configuration file can leave a pending reconciliation journal. Recover the source that init wrote. For the default project target, run `/bifrost config reconcile --recover`. After `-g`, run `/bifrost config reconcile --source user --recover`. Run the matching command before you retry.

If a proposed project pool would replace a handwritten pool in your global or workspace config with different models, init stops without saving. Pools that init generated before (tracked by an ownership receipt) and empty pools allow init to proceed. Edit the existing source or review a workspace update with `/bifrost config reconcile --source workspace --tier general --provider openai`; use `-g` when you intend to update the global source.

For safe migration, follow the [existing-user migration steps](reliability-and-cache.md#existing-users-migrate-reliability-state).

## Persistence summary

| Control | Survives restart | Propagates to child sessions |
|---------|------------------|------------------------------|
| `/bifrost on` / `off` | Yes | Yes, through shared runtime policy |
| `/bifrost pin` / `unpin` | No | No |
| `/bifrost classifier on` / `off` / `inherit` | No | No; choice applies to this Pi session only |

Pin is a hard lock. A tier name at the start of a message stays ordinary text while pinned.

<!-- Former command-reference section anchors. The procedures moved to workflows.md; these ids keep existing deep links pointing at the relocation notice instead of a missing heading. -->
<a id="common-workflows"></a>
<a id="preview-before-generation"></a>
<a id="scripted-preview"></a>
<a id="keep-one-model-for-a-long-session"></a>
<a id="route-one-unpinned-prompt-through-a-known-tier"></a>
<a id="change-config"></a>
<a id="migrate-a-config-schema"></a>
<a id="reconcile-generated-model-membership"></a>
<a id="diagnose-unavailable-models"></a>

## Relocated procedures

Preview, migration, reconciliation, and diagnostic procedures moved to [Common workflows](workflows.md).
