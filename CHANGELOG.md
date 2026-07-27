# Changelog

All notable changes to pi-bifrost are documented here.

## [0.2.0] - UNRELEASED

### Added
- Inline tier override via first-word detection (`frontier debug this`)
- Config validation on startup (`validateConfig`)
- Extracted `parseInlineOverride` for testability
- User-facing config issue messages

### Changed
- Eliminated all `as unknown as` casts from production code
- Config merge order: `.pi/bifrost.json` now wins over root `bifrost.json`

## [0.1.7] - 2026-07-xx

### Added
- Direct model bindings via `"model": "provider/id"` in regex rules
- `parseInlineOverride` extraction
- Config validation
