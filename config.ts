import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoutingStrategy, RouteRule } from "./routing.ts";
import type { CacheOptions } from "./cache.ts";
import type { DebugConfig } from "./debug.ts";
import type { ReliabilityConfig } from "./reliability.ts";

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
  reliability?: ReliabilityConfig;
}

export const DEFAULT_RULES: RouteRule[] = [
  {
    pattern:
      "(^|\\s)\\/?commit(?:\\s|$)|\\b(commit message|conventional commit|git commit message)\\b",
    model: "quick",
  },
  {
    pattern:
      "(^|\\s)\\/?format(?:\\s|$)|\\b(prettify|reformat|format this json|format this yaml|format this code)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(json to yaml|yaml to json|csv to json|json to csv|convert this data)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(fix lint|lint errors?|eslint errors?|prettier errors?|stylelint errors?)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(generate mock data|create mock data|sample json|dummy data|fixture data)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(translate this|proofread this|fix grammar|grammar check|rewrite this sentence)\\b",
    model: "quick",
  },
  {
    pattern:
      "\\b(classify these|extract fields?|extract values?|extract entities|parse this text)\\b",
    model: "quick",
  },
  {
    pattern:
      "(^|\\s)\\/?test(?:\\s|$)|\\b(unit tests?|integration tests?|e2e tests?|test cases?|write tests?|generate tests?|test coverage|test fixtures?)\\b",
    model: "general",
  },
  {
    pattern:
      "(^|\\s)\\/?review(?:\\s|$)|\\b(review this code|review this diff|review this pull request|review this pr|code review|audit this code|security review of this code)\\b",
    model: "frontier",
  },
  {
    pattern:
      "(^|\\s)\\/?debug(?:\\s|$)|\\b(debug|diagnose|fix bug|stack trace|runtime error|compile error|build error|failing build|exception|crash|incorrect output|unexpected behaviou?r|flaky test)\\b",
    model: "frontier",
  },
  {
    pattern:
      "(^|\\s)\\/?arch(?:\\s|$)|\\b(system architecture|software architecture|architect this|architect a|distributed system design|microservices architecture|database architecture|database design|schema design|api design|migration architecture|scalability plan|capacity planning|repository-wide refactor|major refactor)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(race condition|deadlock|memory leak|segmentation fault|heisenbug|concurrency bug|production incident|root cause analysis|performance regression)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(security audit|threat model|vulnerability analysis|authentication flaw|authorization flaw|sql injection|cross-site scripting|\\bxss\\b|\\bcsrf\\b|remote code execution|privilege escalation)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(mathematical proof|prove that|formal proof|complex reasoning|logical puzzle|derive the equation|algorithmic proof)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(maximum quality|highest quality|best available model|strongest model|ignore cost|cost does not matter|cost isn't important|spare no expense)\\b",
    model: "frontier",
  },
  {
    pattern:
      "\\b(use a free model|free model only|no paid model|zero cost|spend nothing|do not spend)\\b",
    model: "quick",
  },
];

export const ALL_STRATEGIES: readonly RoutingStrategy[] = [
  "first",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
  "fastest",
];

export interface ConfigIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * Validate a resolved BifrostConfig. Returns issues (errors stop
 * the extension from starting, warnings are logged only).
 */
export function validateConfig(
  config: BifrostConfig,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const modelKeys = Object.keys(config.models ?? {});

  if (modelKeys.length === 0) {
    issues.push({
      severity: "error",
      message:
        'No tiers configured in "models". Add at least one tier to .pi/bifrost.json.',
    });
  }

  if (config.default && !modelKeys.includes(config.default)) {
    issues.push({
      severity: "error",
      message: `Default tier "${config.default}" not found in models [${modelKeys.join(", ")}].`,
    });
  }

  if (config.categoryStrategies) {
    for (const tier of Object.keys(config.categoryStrategies)) {
      if (!modelKeys.includes(tier)) {
        issues.push({
          severity: "error",
          message: `Category strategy for tier "${tier}" — tier not found in models [${modelKeys.join(", ")}].`,
        });
      }
    }
  }

  const strat = config.strategy;
  if (strat && !ALL_STRATEGIES.includes(strat as RoutingStrategy)) {
    issues.push({
      severity: "warning",
      message: `Unknown strategy "${strat}" — falling back to "first".`,
    });
  }

  if (config.cache?.threshold !== undefined && (config.cache.threshold < 0 || config.cache.threshold > 1)) {
    issues.push({
      severity: "error",
      message: `Cache threshold must be between 0 and 1, got ${config.cache.threshold}.`,
    });
  }

  if (config.cache?.maxEntries !== undefined && config.cache.maxEntries < 1) {
    issues.push({
      severity: "warning",
      message: `Cache maxEntries is ${config.cache.maxEntries}, should be > 0.`,
    });
  }

  const reliability = config.reliability;
  if (reliability?.failureThreshold !== undefined && (!Number.isInteger(reliability.failureThreshold) || reliability.failureThreshold < 1)) {
    issues.push({
      severity: "error",
      message: `Reliability failureThreshold must be an integer >= 1, got ${reliability.failureThreshold}.`,
    });
  }

  if (reliability?.windowMinutes !== undefined && (!Number.isInteger(reliability.windowMinutes) || reliability.windowMinutes < 1)) {
    issues.push({
      severity: "error",
      message: `Reliability windowMinutes must be an integer >= 1, got ${reliability.windowMinutes}.`,
    });
  }

  if (reliability?.cooldownMinutes !== undefined && (!Number.isInteger(reliability.cooldownMinutes) || reliability.cooldownMinutes < 1)) {
    issues.push({
      severity: "error",
      message: `Reliability cooldownMinutes must be an integer >= 1, got ${reliability.cooldownMinutes}.`,
    });
  }

  if (config.rules) {
    for (let i = 0; i < config.rules.length; i++) {
      const rule = config.rules[i];
      try {
        new RegExp(rule.pattern, "i");
      } catch {
        issues.push({
          severity: "error",
          message: `Invalid regex in rule #${i}: "${rule.pattern}".`,
        });
      }
    }
  }

  return issues;
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    console.error(`[bifrost] failed to parse ${path}: ${err}`);
    return undefined;
  }
}

/**
 * Shallow-merge a nested object field only when at least one side defines it.
 * Keeps `undefined` when both sides are undefined (preserves "not set" vs "{}").
 */
function mergeObj<T extends object>(
  base: T | undefined,
  override: T | undefined,
): T | undefined {
  if (base === undefined && override === undefined) return undefined;
  return { ...base, ...override } as T;
}

/**
 * Merge two BifrostConfig layers. Later layers win for primitives and
 * arrays; nested objects (models, classifier, cache, debug, strategies)
 * are shallow-merged key-by-key so per-tier overrides layer correctly.
 */
export function mergeConfig(
  base: BifrostConfig,
  override: BifrostConfig,
): BifrostConfig {
  const merged: BifrostConfig = { ...base, ...override };
  merged.categoryStrategies = mergeObj(
    base.categoryStrategies,
    override.categoryStrategies,
  );
  merged.models = mergeObj(base.models, override.models);
  merged.classifier = mergeObj(base.classifier, override.classifier);
  merged.cache = mergeObj(base.cache, override.cache);
  merged.debug = mergeObj(base.debug, override.debug);
  merged.reliability = mergeObj(base.reliability, override.reliability);
  return merged;
}

export function loadConfig(
  cwd: string,
  extensionDir: string,
): BifrostConfig {
  const base: BifrostConfig = {
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

  const configs = [
    readJson<BifrostConfig>(join(extensionDir, "bifrost.json")),
    readJson<BifrostConfig>(join(getAgentDir(), "bifrost.json")),
    readJson<BifrostConfig>(join(cwd, "bifrost.json")),
    readJson<BifrostConfig>(join(cwd, CONFIG_DIR_NAME, "bifrost.json")),
  ];

  let merged: BifrostConfig = base;
  for (const cfg of configs) {
    if (cfg) merged = mergeConfig(merged, cfg);
  }
  return merged;
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
