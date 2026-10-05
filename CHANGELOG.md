# Changelog

All notable changes to pi-bifrost are documented here.

## [0.5.0] - UNRELEASED

### Added
- `pi-native` classifier backend through Pi's `modelRegistry.classify()`. It uses Pi-managed TypeSafe credentials and a classifier model from Pi's catalog. Set `classifier.piNative.model` to `typesafe/jev-latest` or omit it to use the first available model.
- `/bifrost classifier` now offers `prompt`, `typesafe`, and `pi-native`. Successful init prints the picker command; interactive init can open the picker after writing configuration.
- `bifrost/auto` virtual model (Pi 1.0.1+): per-request dispatch through the existing tier, cache, reliability, and strategy policy. Select it in `/model`; Pi's footer shows `bifrost/auto → provider/model` and assistant messages record the physical model.
- Inline tier overrides hand off from input-time prompt stripping to virtual routing without persisting prompt text.
- Setup offer: selecting `bifrost/auto` with no configured pools asks once (TUI) whether to run `/bifrost init`, disclosing that init probes every available model; non-TUI keeps the actionable error. Init itself still confirms before writing config.

### Changed
- When `classifier.backend` is absent, Bifrost now detects Pi-managed TypeSafe credentials first, then `TYPESAFE_API_KEY`, and otherwise uses `prompt`. This can change the classifier for existing configurations that omit the backend. Set `classifier.backend` explicitly to keep the old choice. Detection stays fixed for the extension session and prints its reason on first use.
- Pi-native classification without `classifier.piNative.model` skips the fuzzy classification cache. A changing catalog cannot reuse a tier chosen by a different classifier model. Set an explicit model id to enable the cache.
- When auto-detection picks a direct backend (`typesafe` or `pi-native`) but its settings are invalid (for example a missing criterion for a custom tier), Bifrost prints the config errors and keeps prompt classification instead of silently disabling it. An explicit `classifier.backend` still fails closed.
- The `pi-native` option is hidden on hosts without classification support. Auto-detection skips it there as well.
- Require Pi 1.0.1+ (`minPiVersion`), matching the virtual-model API.
- Selecting `bifrost/auto` opts into per-prompt routing; selecting a physical model still pins. `/bifrost pin` and `/bifrost off` exit Auto and lock the last dispatched physical model.
- Virtual entries (`api: pi-virtual`) are excluded from tier candidate pools; Bifrost never routes a virtual model to another virtual model.
- The `/bifrost` dashboard is derived from the command registry instead of a second hand-written list, so every registered command appears (18 rows) and a command added to the registry appears in the menu with no second edit. The member of the on/off and pin/unpin pairs that changes something stays on top, and the member that would do nothing now says so (`Enable routing (already on)`). `cache clear` is reachable from the menu and still unconfirmed, as noted under Next in `docs/ui-enhancements.md`.

### Fixed
- Fail-closed virtual route errors are actionable: empty pools say `0 models configured — add models to bifrost.json or run /bifrost init`; configured pools that resolve nothing name the patterns and point at credentials/model ids.
- Virtual route selection and failure emit debug events (`virtual.select`, `virtual.fail`, `virtual.degrade`) so fail-closed routes self-document when debug logging is on.
- No wedged Auto sessions: when a user turn finds no resolvable model, a session that already dispatched a physical model keeps the last one with a visible warning (continuations already worked this way); fresh sessions fail with the actionable error above.
- Auto dispatch clamps the thinking level to the physical model's capabilities via pi-ai's `clampThinkingLevel` (non-reasoning targets dispatch `off`), and debug traces log the dispatched level instead of the virtual selection level.
- Session restore (`model_select` source `restore`) no longer pins or flips Auto state — restore is passive, matching Pi's `model-status` example semantics.
- Classifier backends receive prompt text bounded to 16k chars (matches Pi's `jev-router` example); cache matching still uses the full prompt.

## [0.4.0] - UNRELEASED

### Added
- Direct model bindings, config validation, and inline tier overrides.
- Opt-in TypeSafe/Jev classifier backend with confidence validation, bounded retries, persisted reliability, safe credential resolution, metrics, and detailed local tracing.
- `/bifrost classifier` backend picker, `/bifrost classifier test`, and expanded classifier status diagnostics.
- TypeSafe/Jev architecture and operational guidance in `docs/jev-typesafe-architecture.md`.
- Inline tier override via first-word detection (`frontier debug this`).
- Extracted `parseInlineOverride` for testability.
- User-facing config issue messages.

### Changed
- Require Pi 0.86.0+ and route registry classifier/probe calls through Pi's authenticated `modelRegistry.streamSimple()` API.
- Kept the Pi model-selector compatibility cast confined to one documented adapter boundary.
- Config merge order: `.pi/bifrost.json` now wins over root `bifrost.json`.

### Fixed
- Init now prefers a populated `general` tier as default regardless of model discovery order.
- TUI command feedback no longer appears twice through both notifications and stderr extension output.
- TypeSafe backend selection now writes explicit Jev and fallback settings, status distinguishes Jev from its prompt fallback model, and classifier tests separate rejected backend judgments from final fallback routes.

### Security
- TypeSafe decoder fails closed on non-plain objects, accessors, extra fields, and malformed probabilities.
- Detailed TypeSafe traces are metadata-only and exclude prompts, request bodies, provider responses, external error text, API keys, and authorization headers.
