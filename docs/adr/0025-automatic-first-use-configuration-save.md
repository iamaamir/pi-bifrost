# 0025 — Automatic first-use configuration save

## Status

**Accepted, 10 October 2026. Amended, 11 October 2026, with the user's explicit authorization for background provider probes.** This decision applies when Bifrost can safely create a first-use project configuration.

## Context

Fresh users can route from model lists built in memory, but those lists disappear when Pi closes. Requiring `/bifrost init` adds a setup step before first use.

## Decision

When no meaningful configuration, route file, or explicit routing override blocks setup, Bifrost loads provisional model lists from Pi's catalog into memory before generation. It starts provider health probes in the background and does not wait for them before routing. Once a model passes its probe, first-use routing prefers verified models and excludes unchecked models until the background check finishes. Before any probe passes, the provisional pool remains available so the first prompt does not wait. Background probes default to three concurrent requests. The `probe.concurrency` and `probe.timeoutMs` settings apply to background and manual probes. The catalog lists available chat models; they do not prove that a provider request will succeed.

An empty `{}` configuration file does not block setup. A configuration with one or more settings does. A route file, runtime routing preference, or explicit routing override also blocks automatic setup. When Pi runs from the extension checkout, the bundled default file does not count as a separate workspace configuration.

After probes finish, Bifrost saves only successful generated model pools and the ownership receipt. Automatic saves include supported public settings. Private classifier templates stay inherited and unknown fields are not copied. Manual init preserves existing configuration fields and handwritten model entries. If every probe fails, it leaves configuration unchanged and warns the user. If a write, safety check, or concurrent-change check prevents the save, routing continues from the provisional in-memory pools and Bifrost warns the user. Probe requests can use provider credits or reach rate limits. The generated configuration does not add prompts, provider errors, or credentials. The local probe report contains provider diagnostics and must be treated as private. When `debug.enabled` is on, structured probe events record catalog counts, model identities, outcomes, durations, transport, fixed failure categories, and cache-write disposition; they omit provider error text, prompts, and credentials.

`/bifrost init` remains available for catalog refresh and generated-model reconciliation. It reuses probe results from the last hour unless the user passes `-f`, which forces fresh probes. It asks once before saving changes to an existing configuration. The ordinary init path retains its health checks.

## Consequences

New users can send a first message without running `/bifrost init`. The first route uses provisional pools while health checks run. When a later input can safely install the completed result, Bifrost uses the verified pools and their saved configuration. Users can inspect and edit saved lists. Background checks do not interrupt active generation. If all checks fail, no starter configuration is saved.
