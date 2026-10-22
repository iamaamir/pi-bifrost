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
  mergeConfig,
  validateConfig,
  validateEconomicConfig,
  validateTierPolicyConfigInternal,
  type BifrostConfig,
} from "./config.ts";

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

export interface ConfigLoadDiagnostic {
  readonly layer: "extension" | "global" | "workspace" | "project";
  readonly message: string;
}

export interface ConfigLoadResult {
  readonly config: BifrostConfig;
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
  readonly sourceFields: readonly { readonly layer: ConfigLoadDiagnostic["layer"]; readonly fields: readonly string[] }[];
  readonly publicDefaultFields: readonly string[];
}

function sourcePolicyDiagnostics(value: Record<string, unknown>): string[] {
  const diagnostics: string[] = [];
  const add = (message: string): void => {
    if (diagnostics.length < 8) diagnostics.push(message.slice(0, MAX_CONFIG_SOURCE_DIAGNOSTIC_CHARS));
  };
  const version = value.schemaVersion;
  if (version !== undefined && version !== 1 && version !== 2) {
    add("schemaVersion is unsupported; supported versions are 1 and 2.");
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
  const sourceFields: Array<{ layer: ConfigLoadDiagnostic["layer"]; fields: readonly string[] }> = [];
  const publicDefaultFields: string[] = [];
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
    const sourceDiagnostics = sourcePolicyDiagnostics(parsed as Record<string, unknown>);
    if (sourceDiagnostics.length) {
      for (const message of sourceDiagnostics) addDiagnostic(layer, `${layer} config ${message}`);
      continue;
    }
    sourceFields.push(Object.freeze({ layer, fields: Object.freeze(Object.keys(parsed)) }));
    if (layer === "extension") {
      publicDefaultFields.push(...Object.keys(BUNDLED_PUBLIC_INIT_DEFAULTS)
        .filter((key) => Object.hasOwn(parsed, key)
          && isDeepStrictEqual((parsed as Record<string, unknown>)[key], BUNDLED_PUBLIC_INIT_DEFAULTS[key])));
    }
    merged = mergeConfig(merged, parsed as BifrostConfig);
  }
  return {
    config: merged,
    diagnostics,
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
): Array<readonly [ConfigLoadDiagnostic["layer"], string]> {
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
