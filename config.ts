import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoutingStrategy, RouteRule } from "./routing.js";
import type { CacheOptions } from "./cache.js";
import type { DebugConfig } from "./debug.js";

type ClassifierMethod = "direct" | "subprocess" | "auto";

export interface ClassifierConfig {
  enabled?: boolean;
  model?: string | string[];
  endpoint?: string;
  method?: ClassifierMethod;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  fallbackToRegex?: boolean;
}

export interface BifrostConfig {
  enabled?: boolean;
  default?: string;
  strategy?: RoutingStrategy;
  categoryStrategies?: Record<string, RoutingStrategy>;
  models?: Record<string, string | string[]>;
  rules?: RouteRule[];
  classifier?: ClassifierConfig;
  cache?: CacheOptions;
  debug?: DebugConfig;
}

export const DEFAULT_RULES: RouteRule[] = [
  {
    pattern:
      "\\b(plan|design|architect|refactor|debug|fix|implement|complex|performance|memory leak|race condition)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(explain|summarize|define|what is|how to|format|lint|convert|hello|idea)\\b",
    model: "economical",
  },
];

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    console.error(`[bifrost] failed to parse ${path}: ${err}`);
    return undefined;
  }
}

export function mergeConfig<T extends Record<string, unknown>>(
  base: T,
  override: T,
): T {
  const merged: T = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (overrideVal === undefined) continue;
    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overrideVal === "object" &&
      overrideVal !== null &&
      !Array.isArray(overrideVal)
    ) {
      merged[key] = { ...baseVal, ...overrideVal } as T[typeof key];
    } else {
      merged[key] = overrideVal as T[typeof key];
    }
  }
  return merged;
}

export function loadConfig(
  cwd: string,
  extensionDir: string,
): BifrostConfig {
  const base: BifrostConfig = {
    enabled: true,
    default: "economical",
    strategy: "first",
    categoryStrategies: { economical: "cheapest" },
    models: {},
    rules: DEFAULT_RULES,
  };

  const configs = [
    readJson<BifrostConfig>(join(extensionDir, "bifrost.json")),
    readJson<BifrostConfig>(join(getAgentDir(), "bifrost.json")),
    readJson<BifrostConfig>(join(cwd, "bifrost.json")),
    readJson<BifrostConfig>(join(cwd, CONFIG_DIR_NAME, "bifrost.json")),
  ];

  let merged = base as unknown as Record<string, unknown>;
  for (const cfg of configs) {
    if (cfg) merged = mergeConfig(merged, cfg as unknown as Record<string, unknown>);
  }
  return merged as unknown as BifrostConfig;
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
