// Schema-version primitives, kept in a leaf module.
//
// routing.ts needs the version gate at runtime and config.ts type-imports
// routing's rule types, so a definition that lives in config.ts puts those two
// policy modules in an import cycle. This module imports nothing, which keeps
// the graph acyclic while the predicate stays single-sourced.

/** Schema versions Bifrost accepts. Version 3 keeps every version 2 routing
 * capability and reserves `description` inside dynamically keyed maps. */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3] as const;

/** True when the configured schemaVersion is at least `minimum`. An absent or
 * non-integer version counts as version 1 (legacy behavior). Version 3 keeps
 * all version 2 features, so gates written as `=== 2` must use this instead. */
export function schemaVersionAtLeast(version: unknown, minimum: number): boolean {
  return typeof version === "number" && Number.isInteger(version) && version >= minimum;
}
