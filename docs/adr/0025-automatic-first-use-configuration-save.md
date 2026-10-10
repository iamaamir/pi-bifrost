# 0025 — Automatic first-use configuration save

## Status

**Accepted, 10 October 2026.** This decision applies when Bifrost can safely create a first-use project configuration.

## Context

Fresh users can route from model lists built in memory, but those lists disappear when Pi closes. Requiring `/bifrost init` adds a setup step before first use.

## Decision

When no meaningful configuration, route file, or explicit routing override blocks setup, Bifrost builds model lists from Pi's catalog in the background. Routing is ready in memory before it saves a minimal project `.pi/bifrost.json` and ownership receipt in the background.

An empty `{}` configuration file does not block setup. A partial configuration with one or more settings does. A route file or explicit routing override also blocks automatic setup. When Pi runs from the extension checkout, the bundled default file does not count as a separate workspace configuration.

The save uses a journaled compare-and-swap transaction. It does not replace an existing meaningful configuration. It does not probe models or save prompts, provider errors, or credentials. If a write, safety check, or concurrent-change check prevents the save, routing continues from memory and Bifrost warns the user.

`/bifrost init` remains available for catalog refresh and generated-model reconciliation. It shows its short summary and asks before it updates an existing configuration.

## Consequences

New users can send a first message without running `/bifrost init`. Saved starter model lists remain available in the project. Users can inspect and edit those lists before later messages. The automatic save does not add probe evidence or change manual entries.
