# Changelog

All notable changes to pi-bifrost are documented here.

## [0.4.0] - UNRELEASED

### Added
- Direct model bindings, config validation, and inline tier overrides.
- Opt-in TypeSafe/Jev classifier backend with confidence validation, bounded retries, persisted reliability, trust approval, safe credential resolution, metrics, and detailed local tracing.
- `/bifrost classifier` backend picker, `/bifrost classifier test`, and expanded classifier status diagnostics.
- TypeSafe/Jev architecture and operational guidance in `docs/jev-typesafe-architecture.md`.
- Inline tier override via first-word detection (`frontier debug this`).
- Extracted `parseInlineOverride` for testability.
- User-facing config issue messages.

### Changed
- Eliminated all `as unknown as` casts from production code.
- Config merge order: `.pi/bifrost.json` now wins over root `bifrost.json`.

### Security
- TypeSafe decoder fails closed on non-plain objects, accessors, extra fields, and malformed probabilities.
- Detailed TypeSafe traces exclude API keys and authorization headers but may include prompt/provider response content; enable only for local troubleshooting.
