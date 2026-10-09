import type { Api, Model } from "@earendil-works/pi-ai";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RULES } from "./config.ts";
import { guessTier } from "./routing.ts";
import { isVirtualModel } from "./virtual-model.ts";

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

export function canBootstrapModels(facts: AutoBootstrapFacts): boolean {
  return !facts.userConfig && !facts.routeFile && !facts.runtimePreferences && !facts.extensionRoutingOverride;
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
    || JSON.stringify(strategies) !== JSON.stringify({ quick: "random", general: "first", frontier: "first" }))) return true;
  return value.rules !== undefined && JSON.stringify(value.rules) !== JSON.stringify(DEFAULT_RULES);
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

export function hasUserBootstrapFiles(cwd: string, globalAgentDir: string, configDirName: string): { userConfig: boolean; routeFile: boolean } {
  const configFiles = [
    join(globalAgentDir, "bifrost.json"),
    join(cwd, "bifrost.json"),
    join(cwd, configDirName, "bifrost.json"),
  ];
  const routeFiles = [
    join(cwd, "bifrost-routes.json"),
    join(cwd, configDirName, "bifrost-routes.json"),
  ];
  return {
    userConfig: configFiles.some(pathPresentOrUnsafe),
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
    if (isVirtualModel(model)) continue;
    const tier = guessTier(model);
    if (tier) (models[tier] ??= []).push(`${model.provider}/${model.id}`);
  }
  const tiers = ["general", "quick", "frontier"];
  const defaultTier = tiers.find((tier) => models[tier]?.length);
  return defaultTier ? { default: defaultTier, models } : undefined;
}
