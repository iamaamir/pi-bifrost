# Changelog

All notable changes to pi-bifrost are documented here.

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

### Security
- TypeSafe decoder fails closed on non-plain objects, accessors, extra fields, and malformed probabilities.
- Detailed TypeSafe traces are metadata-only and exclude prompts, request bodies, provider responses, external error text, API keys, and authorization headers.
