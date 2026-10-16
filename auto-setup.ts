import type { Api, Model } from "@earendil-works/pi-ai";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALL_STRATEGIES, DEFAULT_RULES, type BifrostConfig } from "./config.ts";
import { guessTier } from "./routing.ts";
import { isGenerativeModel } from "./virtual-model.ts";
import { isClassifierBackend } from "./classifier-backends.ts";

export interface AutoBootstrapFacts {
  readonly userConfig: boolean;
  readonly routeFile: boolean;
  readonly runtimePreferences: boolean;
  readonly extensionRoutingOverride: boolean;
}

export interface BootstrapPools {
  readonly default: string;
  readonly models: Record<string, string[]>;
}

type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): PlainRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as PlainRecord : undefined; }
  catch { return undefined; }
}

function projectKnownFields(source: unknown, keys: readonly string[]): PlainRecord | undefined {
  const record = plainRecord(source);
  if (!record) return undefined;
  const result: PlainRecord = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Preserve explicit provider restrictions across generated first-use config. */
function projectRoutingScope(source: unknown): PlainRecord | undefined {
  const record = plainRecord(source);
  if (!record) return undefined;
  const result: PlainRecord = {};
  if (Array.isArray(record.providers)) {
    const providers = record.providers.filter((provider) => typeof provider === "string");
    if (providers.length === record.providers.length) result.providers = providers;
  }
  const tiers = plainRecord(record.tiers);
  if (tiers) {
    const projected: PlainRecord = {};
    for (const [tier, value] of Object.entries(tiers)) {
      const entry = plainRecord(value);
      if (!entry || !Array.isArray(entry.providers)) continue;
      const providers = entry.providers.filter((provider) => typeof provider === "string");
      if (providers.length !== entry.providers.length) continue;
      projected[tier] = { providers };
    }
    if (Object.keys(projected).length) result.tiers = projected;
  }
  return Object.keys(result).length ? result : undefined;
}

function projectClassifier(source: unknown): PlainRecord | undefined {
  const record = plainRecord(source);
  if (!record) return undefined;
  const result = projectKnownFields(record, [
    "enabled", "model", "method", "maxTokens", "temperature", "fallbackToRegex",
    "totalTimeoutMs", "minConfidence", "fallback", "apiKeyEnv",
  ]) ?? {};
  if (typeof record.backend === "string" && isClassifierBackend(record.backend)) result.backend = record.backend;
  if (typeof record.model === "string" || (Array.isArray(record.model) && record.model.every((item) => typeof item === "string"))) {
    result.model = Array.isArray(record.model) ? [...record.model] : record.model;
  } else delete result.model;
  if (record.method !== "direct" && record.method !== "subprocess" && record.method !== "auto") delete result.method;
  if (record.fallback !== "prompt" && record.fallback !== "regex") delete result.fallback;
  for (const [key, nestedKeys] of [
    ["typesafe", ["model", "timeoutMs", "maxAttempts", "debug", "apiKeyEnv"]],
    ["piNative", ["model", "timeoutMs", "maxAttempts"]],
  ] as const) {
    const nested: PlainRecord = projectKnownFields(record[key], nestedKeys) ?? {};
    const nestedSource = plainRecord(record[key]);
    const metrics = plainRecord(nestedSource?.metrics);
    if (metrics && typeof metrics.enabled === "boolean") nested.metrics = { enabled: metrics.enabled };
    if (Object.keys(nested).length) result[key] = nested;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Serialize only supported public settings for first-use project setup. */
export function serializeBootstrapConfig(
  source: BifrostConfig,
  defaultTier: string,
  generatedModels: Record<string, string[]>,
): BifrostConfig {
  const result: PlainRecord = { default: defaultTier, models: generatedModels };
  const strategySet = new Set<string>(ALL_STRATEGIES);
  if (typeof source.schemaVersion === "number" && Number.isSafeInteger(source.schemaVersion)) result.schemaVersion = source.schemaVersion;
  if (typeof source.enabled === "boolean") result.enabled = source.enabled;
  if (typeof source.strategy === "string" && strategySet.has(source.strategy)) result.strategy = source.strategy;
  const categoryStrategies = plainRecord(source.categoryStrategies);
  if (categoryStrategies) {
    result.categoryStrategies = Object.fromEntries(Object.entries(categoryStrategies)
      .filter((entry) => typeof entry[1] === "string" && strategySet.has(entry[1])));
  }
  if (Array.isArray(source.rules)) {
    const rules = source.rules.filter((rule) => !!rule && typeof rule.pattern === "string" && typeof rule.model === "string")
      .map(({ pattern, model }) => ({ pattern, model }));
    if (rules.length) result.rules = rules;
  }
  const sourceTierPolicies = plainRecord(source.tierPolicies);
  if (sourceTierPolicies) {
    const tierPolicies = Object.fromEntries(Object.entries(sourceTierPolicies).flatMap(([tier, value]) => {
      const policy = plainRecord(value);
      return policy && Array.isArray(policy.fallbackTiers) && policy.fallbackTiers.every((name) => typeof name === "string")
        ? [[tier, { fallbackTiers: [...policy.fallbackTiers] }]] : [];
    }));
    if (Object.keys(tierPolicies).length) result.tierPolicies = tierPolicies;
  }
  for (const [key, value] of [
    ["classifier", projectClassifier(source.classifier)],
    ["cache", projectKnownFields(source.cache, ["enabled", "maxEntries", "threshold", "ttlHours", "path"])],
    ["debug", projectKnownFields(source.debug, ["enabled", "path"])],
    ["reliability", projectKnownFields(source.reliability, [
      "enabled", "stateVersion", "cooldownOnAllowanceExhausted", "allowanceCooldownScope", "retryOnAllowanceExhausted",
      "failureThreshold", "windowMinutes", "cooldownMinutes", "path",
    ])],
    ["probe", projectKnownFields(source.probe, ["concurrency", "timeoutMs"])],
  ] as const) if (value) result[key] = value;
  const routingScope = projectRoutingScope(source.routingScope);
  if (routingScope) result.routingScope = routingScope;
  if (source.affinity && (source.affinity.mode === "off" || source.affinity.mode === "observe" || source.affinity.mode === "retain-within-tier")) {
    result.affinity = { mode: source.affinity.mode, ...(typeof source.affinity.providerAdvisory === "boolean" ? { providerAdvisory: source.affinity.providerAdvisory } : {}) };
  }
  return result as BifrostConfig;
}

export function canBootstrapModels(facts: AutoBootstrapFacts): boolean {
  return !facts.userConfig && !facts.routeFile && !facts.runtimePreferences && !facts.extensionRoutingOverride;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}

export function hasExplicitExtensionRoutingOverride(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return true;
  const value = config as Record<string, unknown>;
  if (value.enabled === false || value.disabled !== undefined || (value.default !== undefined && value.default !== "general")
    || (value.enabled !== undefined && typeof value.enabled !== "boolean")
    || (value.default !== undefined && typeof value.default !== "string")
    || (value.strategy !== undefined && typeof value.strategy !== "string")
    || (value.strategy !== undefined && value.strategy !== "first")) return true;
  const tierPolicies = value.tierPolicies;
  if (tierPolicies !== undefined && (!tierPolicies || typeof tierPolicies !== "object" || Array.isArray(tierPolicies)
    || Object.keys(tierPolicies).length > 0)) return true;
  const models = value.models;
  if (models !== undefined && (!models || typeof models !== "object" || Array.isArray(models)
    || Object.entries(models).some(([tier, pool]) => {
      if (!["quick", "general", "frontier"].includes(tier)) return true;
      if (typeof pool === "string") return true;
      if (!Array.isArray(pool) || pool.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) return true;
      return pool.length > 0;
    }))) return true;
  const strategies = value.categoryStrategies;
  if (strategies !== undefined && (!strategies || typeof strategies !== "object" || Array.isArray(strategies)
    || Object.values(strategies).some((strategy) => typeof strategy !== "string")
    || !sameJsonValue(strategies, { quick: "random", general: "first", frontier: "first" }))) return true;
  return value.rules !== undefined && !sameJsonValue(value.rules, DEFAULT_RULES);
}

export function pathPresentOrUnsafe(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

export function hasBlockingRuntimePreferences(path: string): boolean {
  if (!pathPresentOrUnsafe(path)) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 65_536) return true;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype) return true;
    const value = parsed as Record<string, unknown>;
    const keys = Object.keys(value);
    return value.enabled !== true || typeof value.classifierEnabled !== "boolean"
      || keys.some((key) => key !== "enabled" && key !== "classifierEnabled");
  } catch {
    return true;
  }
}

export function hasUserBootstrapFiles(cwd: string, globalAgentDir: string, configDirName: string, extensionConfigPath?: string): { userConfig: boolean; routeFile: boolean } {
  const configFiles = [
    join(globalAgentDir, "bifrost.json"),
    join(cwd, "bifrost.json"),
    join(cwd, configDirName, "bifrost.json"),
  ];
  const routeFiles = [
    join(cwd, "bifrost-routes.json"),
    join(cwd, configDirName, "bifrost-routes.json"),
  ];
  const userConfig = configFiles.some((path) => {
    if (!pathPresentOrUnsafe(path)) return false;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 65_536) return true;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return true;
      if (extensionConfigPath && resolve(path) === resolve(extensionConfigPath) && !hasExplicitExtensionRoutingOverride(parsed)) return false;
      return Object.keys(parsed).length > 0;
    } catch {
      return true;
    }
  });
  return {
    userConfig,
    routeFile: routeFiles.some(pathPresentOrUnsafe),
  };
}

export function hasExplicitExtensionRoutingFile(path: string): boolean {
  if (!pathPresentOrUnsafe(path)) return false;
  try {
    return hasExplicitExtensionRoutingOverride(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return true;
  }
}

export function buildBootstrapPools(available: readonly Model<Api>[]): BootstrapPools | undefined {
  const models: Record<string, string[]> = {};
  for (const model of [...available].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))) {
    if (!isGenerativeModel(model)) continue;
    const tier = guessTier(model);
    if (tier) (models[tier] ??= []).push(`${model.provider}/${model.id}`);
  }
  const tiers = ["general", "quick", "frontier"];
  const defaultTier = tiers.find((tier) => models[tier]?.length);
  return defaultTier ? { default: defaultTier, models } : undefined;
}
