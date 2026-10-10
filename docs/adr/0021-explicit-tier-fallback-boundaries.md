# 0021 — Explicit tier fallback boundaries

## Status

**Accepted for the strict tier-boundary release slice** (2026-10-07). The user approved execution of the release design. This decision covers only per-tier `fallbackTiers` configuration for resolved tiers. It does not approve direct-model rule fallback arrays or the broader proposal in ADR 0008.

## Context

Legacy routing uses the configured default tier when the requested tier has no healthy candidate. That behavior is useful as a simple default, but some users need a tier to stop at a visible, bounded list. A hidden default fallback can cross a user's intended boundary even when every candidate and strategy is configured explicitly.

## Decision

- Accept `schemaVersion` values 1 and 2. Missing version and version 1 retain existing behavior. Version 2 alone also retains existing behavior.
- In version 2, a `tierPolicies.<tier>.fallbackTiers` entry opts that tier into a strict boundary. Bifrost resolves the requested tier, then each listed tier once in order, using each tier's configured strategy, and stops at the first eligible model.
- An empty list makes the requested tier a singleton boundary. A tier without an entry retains legacy configured-default fallback behavior.
- Reject unsupported versions, malformed tier-policy entries, unknown fields within `tierPolicies`, unknown tier references, duplicate entries, self-references, and cycles. Unknown fields elsewhere retain the existing permissive behavior.
- Invalid strict configuration blocks physical input routing and Auto dispatch. Reload keeps the last valid configuration active when the new configuration is invalid.
- If a strict route is exhausted or physical activation fails, the turn is handled without generation. Auto must not degrade to its previous physical model. Manual pin/off controls remain available, and prompts are never replayed.

## Consequences

Users can opt a tier into a bounded fallback order without changing policies for other tiers. Preview/debug decisions can report the attempted tiers and their strategies. The boundary is configuration for generic tiers; it does not add inline model arrays, exact-reference fallback options, provider economics, affinity, migrations, or new defaults.

## Validation

The implementation requires deterministic tests for schema validation and merging, ordered selection, legacy behavior, startup/reload failure gates, and registered physical/Auto route hooks. A fake-provider integration check must show that an exhausted strict boundary performs no provider attempt.
