// ── Authoritative structural configuration contract ───────────
// The shipped `schema.json` governs which configuration fields exist, what
// types and values they accept, and where inline `description` metadata is
// allowed. This module is the single structural-validation entry point:
// config-load.ts runs it for every source layer (partial mode) and for the
// merged effective configuration (full mode), which covers startup, reload,
// reconciliation, user-facing validation, and the agent check/preview/apply
// paths without duplicating structural rules anywhere else.
//
// Semantic validation stays in config.ts: tier references, fallback cycles,
// classifier constraints, and economic/reliability invariants require context
// a single JSON document does not have. Structural and semantic validation
// complement each other; neither replaces the other.
//
// Deliberately NOT imported by config.ts or router.ts: the resolve-only router
// graph stays free of the schema toolchain, and schema.json is read from the
// installed package root next to this file.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { ConfigIssue } from "./config.ts";

// ajv is CommonJS; this project compiles without esModuleInterop, so the
// constructor is loaded through require, which returns the class directly.
type AjvLike = { compile(schema: object): ValidateFunction };
const AjvConstructor = createRequire(import.meta.url)("ajv") as new (options?: object) => AjvLike;

/** Dynamically keyed configuration maps. In schemaVersion 3 their `description`
 * key is reserved inline metadata; in versions 1 and 2 it keeps its original
 * meaning as a user-defined key. Kept in one list so validation and metadata
 * stripping cannot drift apart. Paths use dots; entries address the map. */
export const DYNAMIC_CONFIG_MAP_PATHS: readonly string[] = Object.freeze([
  "models",
  "categoryStrategies",
  "tierPolicies",
  "classifier.criteria",
  "economics.scopes",
  "economics.tierOverrides",
  "economics.sourceOrder",
]);

/** One dynamically keyed map nests further user-keyed data below it:
 * `economics.tierOverrides.<tier>` maps admission rule IDs, and a rule ID
 * named "description" is legal in every schema version. Those inner keys are
 * routing data, never metadata, so stripping must not touch them. */
const NESTED_RULE_ID_MAP_PARENTS: readonly string[] = Object.freeze([
  "economics.tierOverrides",
]);

const MAX_SCHEMA_ISSUES = 12;

interface CompiledConfigSchema {
  readonly text: string;
  readonly digest: string;
  /** Merged/effective documents: every root conditional applies. */
  readonly validateEffective: ValidateFunction;
  /** Single source layers: root conditionals marked x-bifrost-effective-only are
   * dropped, because another layer may supply the version they require. */
  readonly validateSourceLayer: ValidateFunction;
}

let compiled: CompiledConfigSchema | undefined;

/**
 * Load schema.json from the installed Bifrost package and compile it once.
 * Both validators share one Ajv instance, so the schema is parsed and compiled
 * a single time per process. Never reaches the network or a dev-only path.
 */
export function compiledConfigSchema(): CompiledConfigSchema {
  if (compiled) return compiled;
  const path = fileURLToPath(new URL("./schema.json", import.meta.url));
  const text = readFileSync(path, "utf-8");
  const schema = JSON.parse(text) as Record<string, unknown>;
  const ajv = new AjvConstructor({ allErrors: true, strict: false });
  const validateEffective = ajv.compile(schema);
  const sourceSchema = { ...schema } as Record<string, unknown>;
  // The partial schema is derived from the authoritative document, not
  // maintained separately: `$id` must not collide, and effective-only
  // conditionals (tagged in schema.json itself) require in-document
  // information that a layered source legitimately receives elsewhere.
  delete sourceSchema["$id"];
  sourceSchema.allOf = (Array.isArray(schema.allOf) ? schema.allOf : [])
    .filter((entry) => !(entry && typeof entry === "object" && (entry as Record<string, unknown>)["x-bifrost-effective-only"] === true));
  const validateSourceLayer = ajv.compile(sourceSchema);
  compiled = Object.freeze({
    text,
    digest: createHash("sha256").update(text, "utf-8").digest("hex"),
    validateEffective,
    validateSourceLayer,
  });
  return compiled;
}

/** Stable content digest of the installed schema, for identity and drift checks. */
export function configSchemaDigest(): string {
  return compiledConfigSchema().digest;
}

function dottedPath(instancePath: string): string {
  return instancePath ? instancePath.slice(1).replaceAll("/", ".") : "";
}

function pathSuffix(keyword: string, params: Record<string, unknown>, parent: string): string {
  const key = keyword === "additionalProperties" ? params.additionalProperty
    : keyword === "required" ? params.missingProperty
      : undefined;
  if (typeof key !== "string") return parent;
  return parent ? `${parent}.${key}` : key;
}

function issueFor(error: ErrorObject): ConfigIssue {
  const parent = dottedPath(error.instancePath);
  const path = pathSuffix(error.keyword, error.params as Record<string, unknown>, parent);
  const at = path ? ` at "${path}"` : "";
  const base = { severity: "error" as const, path: path || undefined };
  switch (error.keyword) {
    case "additionalProperties": {
      return { ...base, code: "config.schema_unsupported_field", message: `Unsupported configuration field "${path}". Check the shipped schema.json for supported fields.` };
    }
    case "required": {
      const property = String((error.params as Record<string, unknown>).missingProperty);
      return { ...base, code: "config.schema_missing_field", message: `Missing required configuration field "${property}"${parent ? ` inside "${parent}"` : ""}.` };
    }
    case "enum": {
      const values = ((error.params as Record<string, unknown>).allowedValues ?? []) as unknown[];
      return { ...base, code: "config.schema_enum", message: `Invalid value${at}; allowed values are ${values.map((value) => JSON.stringify(value)).join(", ")}.` };
    }
    case "const": {
      const value = (error.params as Record<string, unknown>).allowedValue;
      return { ...base, code: "config.schema_const", message: `Invalid value${at}; it must be ${JSON.stringify(value)}.` };
    }
    case "type": {
      const type = String((error.params as Record<string, unknown>).type);
      return { ...base, code: "config.schema_type", message: `Invalid type${at}; expected ${type}.` };
    }
    default:
      return { ...base, code: `config.schema_${error.keyword}`, message: `Invalid configuration${at}: ${error.message ?? "fails a schema constraint"}.` };
  }
}

function issuesOf(validate: ValidateFunction, document: unknown): ConfigIssue[] {
  if (validate(document)) return [];
  const issues = (validate.errors ?? []).filter((error) => error.keyword !== "if")
    .map(issueFor)
    .slice(0, MAX_SCHEMA_ISSUES);
  return issues.length > 0 ? issues : [{
    severity: "error",
    code: "config.schema_invalid",
    message: "The configuration does not match the installed Bifrost schema.",
  }];
}

/**
 * Structural validation for one source layer. Root conditionals that require
 * in-document information supplied by another layer (for example a
 * tierPolicies layer that relies on a schemaVersion declared elsewhere) are
 * not enforced here; they are enforced on the merged configuration.
 */
export function validateConfigSourceStructure(source: unknown): ConfigIssue[] {
  return issuesOf(compiledConfigSchema().validateSourceLayer, source);
}

/**
 * Structural validation for a merged/effective configuration, where every
 * root conditional (including version requirements) applies.
 */
export function validateEffectiveConfigStructure(config: unknown): ConfigIssue[] {
  return issuesOf(compiledConfigSchema().validateEffective, config);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}


/**
 * Remove inline `description` metadata from a structurally validated source,
 * producing the runtime-semantic view that merges into the effective
 * configuration. Central on purpose: no routing subsystem ever sees a
 * `description` key it could mistake for a tier, strategy, or policy.
 *
 * Under schemaVersion 3, `description` inside dynamically keyed maps is
 * reserved metadata and is stripped. Under versions 1 and 2 those keys keep
 * their original user-defined meaning (for example a tier named
 * "description") and are preserved as routing data. Keys one level below
 * `economics.tierOverrides` are admission rule IDs in every version and are
 * always preserved.
 */
export function stripConfigMetadata(source: Record<string, unknown>): Record<string, unknown> {
  const version = typeof source.schemaVersion === "number" ? source.schemaVersion : 1;
  const walk = (value: unknown, path: string, inRuleIdMap: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`, inRuleIdMap));
    if (!isPlainRecord(value)) return value;
    const result: Record<string, unknown> = {};
    // Descending into a tier of `economics.tierOverrides` lands in its
    // rule-ID map; the tier itself is still a key of the reserved map.
    const childrenAreRuleIds = inRuleIdMap || NESTED_RULE_ID_MAP_PARENTS.includes(path);
    for (const [key, entry] of Object.entries(value)) {
      if (key === "description" && !inRuleIdMap && !(version < 3 && DYNAMIC_CONFIG_MAP_PATHS.includes(path))) continue;
      result[key] = walk(entry, path ? `${path}.${key}` : key, childrenAreRuleIds);
    }
    return result;
  };
  return walk(source, "", false) as Record<string, unknown>;
}
