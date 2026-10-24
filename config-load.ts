// ── Host configuration loading ─────────────────────────────────
// Layered Bifrost configuration loading: bundled defaults, the user-level
// agent config, a workspace bifrost.json, and the project `.pi/bifrost.json`.
// Parsing and validation live in config.ts; this module owns host paths,
// bounded file reads, and layer composition.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJsonFile } from "./storage.ts";
import type { RouteRule } from "./routing.ts";
import {
  BUNDLED_PUBLIC_INIT_DEFAULTS,
  DEFAULT_RULES,
  MAX_CONFIG_SOURCE_BYTES,
  SUPPORTED_SCHEMA_VERSIONS,
  mergeConfig,
  schemaVersionAtLeast,
  validateConfig,
  validateEconomicConfig,
  validateTierPolicyConfigInternal,
  type BifrostConfig,
} from "./config.ts";
import {
  DYNAMIC_CONFIG_MAP_PATHS,
  stripConfigMetadata,
  validateConfigSourceStructure,
  validateEffectiveConfigStructure,
} from "./config-schema.ts";

const MAX_CONFIG_SOURCE_DIAGNOSTICS = 32;
const MAX_CONFIG_SOURCE_DIAGNOSTIC_CHARS = 192;

function criterionObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readJson<T>(path: string): T | undefined {
  try {
    return readJsonFile<T>(path);
  } catch (err) {
    console.error(`[bifrost] failed to parse ${path}: ${err}`);
    return undefined;
  }
}

export function loadConfig(
  cwd: string,
  extensionDir: string,
): BifrostConfig {
  return loadConfigForReload(cwd, extensionDir).config;
}

/** File-backed configuration layers. `effective` never owns a source file, so it cannot appear here. */
export type ConfigSourceLayer = "extension" | "global" | "workspace" | "project";

export interface ConfigLoadDiagnostic {
  /** `effective` marks a problem in the merged policy that no single layer owns. */
  readonly layer: ConfigSourceLayer | "effective";
  readonly message: string;
}

export interface ConfigLoadResult {
  readonly config: BifrostConfig;
  /** Problems that leave a layer unusable: routing, reload, and apply stay fail-closed. */
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
  /**
   * Path-level schema findings the domain validators own. The value is reported
   * but the layer still loads, because semantic validation decides whether the
   * surrounding policy must fail closed (economics, reliability, tier policies)
   * or degrade safely (an invalid classifier budget disables external
   * classification while local routing continues).
   */
  readonly warnings: readonly ConfigLoadDiagnostic[];
  readonly sourceFields: readonly { readonly layer: ConfigLoadDiagnostic["layer"]; readonly fields: readonly string[] }[];
  readonly publicDefaultFields: readonly string[];
}

function sourcePolicyDiagnostics(value: Record<string, unknown>): string[] {
  const diagnostics: string[] = [];
  const add = (message: string): void => {
    if (diagnostics.length < 8) diagnostics.push(message.slice(0, MAX_CONFIG_SOURCE_DIAGNOSTIC_CHARS));
  };
  const version = value.schemaVersion;
  if (version !== undefined && !SUPPORTED_SCHEMA_VERSIONS.includes(version as 1 | 2 | 3)) {
    add("schemaVersion is unsupported; supported versions are 1, 2, and 3.");
  }
  const tierPolicies = value.tierPolicies;
  if (tierPolicies !== undefined) {
    if (!criterionObject(tierPolicies)) add("tierPolicies must be an object.");
    else {
      const sourceTierNames = new Set(Object.keys(tierPolicies));
      for (const policy of Object.values(tierPolicies)) {
        if (criterionObject(policy) && Object.keys(policy).some((key) => key !== "fallbackTiers")) {
          add("tierPolicies contains an unsupported field.");
        }
        if (!criterionObject(policy) || !Array.isArray(policy.fallbackTiers)) continue;
        for (const fallback of policy.fallbackTiers) if (typeof fallback === "string") sourceTierNames.add(fallback);
      }
      const completeSourcePolicies = Object.fromEntries(Object.entries(tierPolicies)
        .filter(([, policy]) => !criterionObject(policy) || Object.hasOwn(policy, "fallbackTiers")));
      const tierIssues = validateTierPolicyConfigInternal({
        ...defaultConfig(),
        schemaVersion: 2,
        models: Object.fromEntries([...sourceTierNames].map((tier) => [tier, []])),
        tierPolicies: completeSourcePolicies as BifrostConfig["tierPolicies"],
      }, 8).filter(({ code }) => code?.startsWith("config.tier_policy_")
        && code !== "config.tier_policy_unknown_tier"
        && code !== "config.tier_policy_unknown_fallback");
      if (tierIssues.length) add("tierPolicies contains an invalid source-local policy.");
    }
  }
  const economics = value.economics;
  if (economics !== undefined) {
    const economicIssues = validateEconomicConfig({ ...value, schemaVersion: 2 } as unknown as BifrostConfig);
    if (economicIssues.length) add("economics contains an invalid source-local policy.");
  }
  const affinity = value.affinity;
  const reliability = value.reliability;
  const sourceIssues = validateConfig({
    ...defaultConfig(),
    schemaVersion: 2,
    models: {},
    ...(affinity === undefined ? {} : { affinity }),
    ...(reliability === undefined ? {} : { reliability }),
  } as BifrostConfig).filter((issue) => issue.severity === "error"
    && (issue.code?.startsWith("config.affinity_") || issue.code?.startsWith("config.reliability_"))
    && issue.code !== "config.reliability_observations_invalid");
  if (sourceIssues.length) add("affinity or reliability contains an invalid source-local policy.");
  const observations = criterionObject(reliability) ? reliability.observations : undefined;
  if (observations !== undefined && (!criterionObject(observations)
    || Object.keys(observations).some((key) => key !== "enabled")
    || (observations.enabled !== undefined && typeof observations.enabled !== "boolean"))) {
    add("reliability.observations is invalid.");
  }
  return diagnostics;
}

function readBoundedConfigText(path: string): { readonly text?: string; readonly oversized?: true; readonly invalidUtf8?: true } {
  const beforeOpen = statSync(path);
  if (!beforeOpen.isFile()) throw new Error("not a regular config file");
  if (beforeOpen.size > MAX_CONFIG_SOURCE_BYTES) return { oversized: true };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("not a regular config file");
    if (opened.size > MAX_CONFIG_SOURCE_BYTES) return { oversized: true };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_CONFIG_SOURCE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_SOURCE_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      chunks.push(chunk.subarray(0, count));
    }
    if (total > MAX_CONFIG_SOURCE_BYTES) return { oversized: true };
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)) }; }
    catch { return { invalidUtf8: true }; }
  } finally {
    closeSync(fd);
  }
}

/** `description` keys inside dynamically keyed maps of one source document,
 * with the shape each one actually holds. Schema version 3 reserves those
 * keys as string metadata, so a non-string value is a user-defined key the
 * layer never opted into reserving. */
function reservedDescriptionEntries(document: Record<string, unknown>): { readonly path: string; readonly isString: boolean }[] {
  const entries: { readonly path: string; readonly isString: boolean }[] = [];
  for (const mapPath of DYNAMIC_CONFIG_MAP_PATHS) {
    let value: unknown = document;
    for (const segment of mapPath.split(".")) {
      if (!criterionObject(value)) { value = undefined; break; }
      value = value[segment];
    }
    if (criterionObject(value) && Object.hasOwn(value, "description")) {
      entries.push({ path: `${mapPath}.description`, isString: typeof value.description === "string" });
    }
  }
  return entries;
}

/** Parse and validate each layer before merging; cross-layer references are checked after composition. */
function loadConfigLayers(
  cwd: string,
  extensionDir: string,
  replacement?: { readonly layer: ConfigLoadDiagnostic["layer"]; readonly bytes: Uint8Array },
): ConfigLoadResult {
  const diagnostics: ConfigLoadDiagnostic[] = [];
  const addDiagnostic = (layer: ConfigLoadDiagnostic["layer"], message: string): void => {
    if (diagnostics.length < MAX_CONFIG_SOURCE_DIAGNOSTICS) {
      diagnostics.push({ layer, message: message.slice(0, MAX_CONFIG_SOURCE_DIAGNOSTIC_CHARS) });
    }
  };
  const warnings: ConfigLoadDiagnostic[] = [];
  const addWarning = (layer: ConfigLoadDiagnostic["layer"], message: string): void => {
    if (warnings.length < MAX_CONFIG_SOURCE_DIAGNOSTICS) {
      warnings.push({ layer, message: message.slice(0, MAX_CONFIG_SOURCE_DIAGNOSTIC_CHARS) });
    }
  };
  const sourceFields: Array<{ layer: ConfigLoadDiagnostic["layer"]; fields: readonly string[] }> = [];
  const publicDefaultFields: string[] = [];
  const reportedStructural = new Set<string>();
  const reservedKeys: Array<{ layer: ConfigLoadDiagnostic["layer"]; declaredVersion: unknown; paths: readonly string[] }> = [];
  let merged = defaultConfig();
  for (const [layer, path] of configLayerPaths(cwd, extensionDir)) {
    let text: string | undefined;
    if (replacement?.layer === layer) {
      if (replacement.bytes.byteLength > MAX_CONFIG_SOURCE_BYTES) {
        addDiagnostic(layer, `${layer} config exceeds the ${MAX_CONFIG_SOURCE_BYTES}-byte size limit.`);
        continue;
      }
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(replacement.bytes); }
      catch {
        addDiagnostic(layer, `${layer} config is not valid UTF-8.`);
        continue;
      }
    } else {
      try {
        if (existsSync(path)) {
          const readResult = readBoundedConfigText(path);
          if (readResult.oversized) {
            addDiagnostic(layer, `${layer} config exceeds the ${MAX_CONFIG_SOURCE_BYTES}-byte size limit.`);
            continue;
          }
          if (readResult.invalidUtf8) {
            addDiagnostic(layer, `${layer} config is not valid UTF-8.`);
            continue;
          }
          text = readResult.text;
        }
      } catch {
        addDiagnostic(layer, `${layer} config could not be read.`);
        continue;
      }
    }
    if (text === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      addDiagnostic(layer, `${layer} config is not valid JSON.`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      addDiagnostic(layer, `${layer} config must contain an object.`);
      continue;
    }
    // Structural validation runs on the document as authored; the runtime
    // then works from its metadata-stripped semantic view. Path-level issues
    // are reported as warnings because the domain validators below own the
    // safety decision: an invalid economic or reliability invariant fails
    // closed, while an invalid classifier budget degrades to local routing.
    // An unsupported schemaVersion is different: it decides what every other
    // key means, so the layer cannot be interpreted at all and is rejected.
    const structuralIssues = validateConfigSourceStructure(parsed);
    const masksVersion = structuralIssues.some((issue) => !issue.path || issue.path.split(".")[0] === "schemaVersion");
    if (masksVersion) {
      addDiagnostic(layer, `${layer} config schemaVersion is unsupported; supported versions are 1, 2, and 3.`);
      continue;
    }
    for (const issue of structuralIssues) {
      reportedStructural.add(issue.message);
      addWarning(layer, `${layer} config: ${issue.message}`);
    }
    const source = parsed as Record<string, unknown>;
    const reserved = reservedDescriptionEntries(source);
    // A version 3 layer that puts a non-string value on a reserved key cannot
    // be metadata. Stripping it would delete a tier, rule, or scope before the
    // semantic check could name it, so the layer stays unusable instead of
    // routing with the key silently removed.
    const nonStringReserved = reserved.filter(({ isString }) => !isString);
    if (source.schemaVersion === 3 && nonStringReserved.length > 0) {
      addDiagnostic(layer, `${layer} config defines ${nonStringReserved.map(({ path }) => path).join(", ")} as non-string values, which schemaVersion 3 reserves for inline metadata; rename the user-defined key or keep the version that treats it as one.`);
      continue;
    }
    const semantic = stripConfigMetadata(source);
    reservedKeys.push({ layer, declaredVersion: source.schemaVersion, paths: reserved.map(({ path }) => path) });
    const sourceDiagnostics = sourcePolicyDiagnostics(semantic);
    if (sourceDiagnostics.length) {
      for (const message of sourceDiagnostics) addDiagnostic(layer, `${layer} config ${message}`);
      continue;
    }
    sourceFields.push(Object.freeze({ layer, fields: Object.freeze(Object.keys(source)) }));
    if (layer === "extension") {
      publicDefaultFields.push(...Object.keys(BUNDLED_PUBLIC_INIT_DEFAULTS)
        .filter((key) => Object.hasOwn(semantic, key)
          && isDeepStrictEqual(semantic[key], BUNDLED_PUBLIC_INIT_DEFAULTS[key])));
    }
    merged = mergeConfig(merged, semantic as BifrostConfig);
  }
  // schemaVersion 3 reserves `description` inside dynamically keyed maps. A
  // layer that did not itself opt into version 3 may still define such a key
  // (versions 1 and 2 treat it as a user key, e.g. a tier named
  // "description"). Merging that layer under version 3 would silently
  // reinterpret it, so the ambiguity is rejected until the user resolves it.
  if (schemaVersionAtLeast(merged.schemaVersion, 3)) {
    for (const entry of reservedKeys) {
      if (entry.declaredVersion === 3 || entry.paths.length === 0) continue;
      addDiagnostic(entry.layer, `${entry.layer} config defines ${entry.paths.join(", ")}, which schemaVersion 3 reserves for inline metadata; rename the user-defined key or declare schemaVersion 3 in that layer.`);
    }
  }
  // The effective policy is validated for composition-dependent rules (for
  // example a version requirement satisfied by a different layer). These are
  // warnings for the same reason: the domain validators decide the safety
  // direction. Issues a source layer already reported are not repeated.
  for (const issue of validateEffectiveConfigStructure(merged)) {
    if (reportedStructural.has(issue.message)) continue;
    addWarning("effective", `effective configuration: ${issue.message}`);
  }
  return {
    config: merged,
    diagnostics,
    warnings,
    sourceFields: Object.freeze(sourceFields),
    publicDefaultFields: Object.freeze(publicDefaultFields),
  };
}

/** Load startup/reload layers while retaining invalid-source diagnostics for fail-closed routing. */
export function loadConfigForReload(cwd: string, extensionDir: string): ConfigLoadResult {
  return loadConfigLayers(cwd, extensionDir);
}

/**
 * Compose the existing config layers while substituting exact bytes for one
 * selected source. This is for prospective validation only; diagnostics make
 * the result ineligible for apply until every layer parses as an object.
 */
export function loadConfigWithSourceOverride(
  cwd: string,
  extensionDir: string,
  source: "project" | "workspace" | "user",
  replacementBytes: Uint8Array,
): ConfigLoadResult {
  if (source !== "project" && source !== "workspace" && source !== "user") {
    return {
      config: defaultConfig(),
      diagnostics: [{ layer: "project", message: "Selected config source is invalid." }],
      warnings: [],
      sourceFields: Object.freeze([]),
      publicDefaultFields: [],
    };
  }
  const selectedLayer: ConfigLoadDiagnostic["layer"] = source === "project" ? "project"
    : source === "workspace" ? "workspace" : "global";
  return loadConfigLayers(cwd, extensionDir, { layer: selectedLayer, bytes: replacementBytes });
}

function defaultConfig(): BifrostConfig {
  return {
    enabled: true,
    default: "general",
    strategy: "first",
    categoryStrategies: {
      quick: "random",
      general: "first",
      frontier: "first",
    },
    models: {},
    rules: DEFAULT_RULES,
  };
}

/** Layer paths in merge order (lowest precedence first). Single source of truth
 * for which file each source lives in. */
export function configLayerPaths(
  cwd: string,
  extensionDir: string,
): Array<readonly [ConfigSourceLayer, string]> {
  return [
    ["extension", join(extensionDir, "bifrost.json")],
    ["global", join(getAgentDir(), "bifrost.json")],
    ["workspace", join(cwd, "bifrost.json")],
    ["project", join(cwd, CONFIG_DIR_NAME, "bifrost.json")],
  ];
}

export function loadRules(cwd: string, config: BifrostConfig): RouteRule[] {
  const routeFiles = [
    join(cwd, CONFIG_DIR_NAME, "bifrost-routes.json"),
    join(cwd, "bifrost-routes.json"),
  ];

  for (const p of routeFiles) {
    const rules = readJson<RouteRule[]>(p);
    if (rules) return rules;
  }

  return config.rules?.length ? config.rules : DEFAULT_RULES;
}
