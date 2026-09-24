import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readJsonFile } from "./storage.ts";
import type { RoutingStrategy, RouteRule } from "./routing.ts";
import type { CacheOptions } from "./cache.ts";
import type { DebugConfig } from "./debug.ts";
import type { ReliabilityConfig } from "./reliability.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL, type ClassifierBackend } from "./classifier-backends.ts";

export { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL } from "./classifier-backends.ts";
export type { ClassifierBackend } from "./classifier-backends.ts";

type ClassifierMethod = "direct" | "subprocess" | "auto";
export type TierCriterion = string | {
  what: string;
  notFor?: string;
  examples?: string[];
};

/** Conservative defaults used when users opt into TypeSafe through init or the picker. */
export const DEFAULT_CLASSIFIER_CRITERIA: Record<string, TierCriterion> = {
  quick: "Bounded, reversible, obvious work such as formatting, lookup, or a small mechanical edit. Not complex debugging, architecture, or security analysis.",
  general: "Normal implementation, tests, API changes, or moderate reasoning with clear scope. Not purely mechanical or unusually ambiguous and consequential work.",
  frontier: "Complex debugging, architecture, security, concurrency, high ambiguity, or high-consequence work. Not routine bounded edits.",
};

export interface ProbeConfig {
  /** Max concurrent model probes. Default 50. Lower this if providers rate-limit. */
  concurrency?: number;
  /** Per-model probe timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

export interface TypeSafeConfig {
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Detailed request/response trace requires this and global debug.enabled. Never logs credentials; may log prompt/response data. */
  debug?: boolean;
  /** Content-free local aggregate observation. Enabled by default when TypeSafe is active. */
  metrics?: {
    enabled?: boolean;
  };
}

export interface ClassifierConfig {
  enabled?: boolean;
  backend?: ClassifierBackend;
  /** Existing prompt classifier model. Also used for explicit TypeSafe prompt fallback. */
  model?: string | string[];
  endpoint?: string;
  method?: ClassifierMethod;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  fallbackToRegex?: boolean;
  criteria?: Record<string, TierCriterion>;
  typesafe?: TypeSafeConfig;
  minConfidence?: number;
  fallback?: "prompt" | "regex";
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
  probe?: ProbeConfig;
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

const TYPESAFE_PROMPT_FIELDS = [
  "endpoint",
  "method",
  "systemPrompt",
  "maxTokens",
  "temperature",
  "fallbackToRegex",
] as const;

/**
 * Validate a resolved BifrostConfig. Returns issues (errors stop
 * the extension from starting, warnings are logged only).
 */
export function validateConfig(
  config: BifrostConfig,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const modelKeys = Object.keys(config.models ?? {});
  const classifier = config.classifier;
  if (classifier?.backend && !Object.values(CLASSIFIER_BACKEND_IDS).includes(classifier.backend)) {
    issues.push({ severity: "error", message: `Unknown classifier backend "${classifier.backend}".` });
  }
  if (classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe) {
    if (classifier.typesafe?.model !== undefined && classifier.typesafe.model !== TYPE_SAFE_MODEL) {
      issues.push({ severity: "error", message: `TypeSafe classifier model must be exactly "${TYPE_SAFE_MODEL}".` });
    }
    if (classifier.typesafe?.endpoint !== undefined && classifier.typesafe.endpoint !== TYPE_SAFE_ENDPOINT) {
      issues.push({ severity: "error", message: `TypeSafe classifier endpoint must be "${TYPE_SAFE_ENDPOINT}".` });
    }
    if (classifier.backend === CLASSIFIER_BACKEND_IDS.typesafe && (classifier.endpoint !== undefined || classifier.method !== undefined || classifier.systemPrompt !== undefined || classifier.maxTokens !== undefined || classifier.temperature !== undefined || classifier.fallbackToRegex !== undefined)) {
      issues.push({ severity: "error", message: "TypeSafe classifier does not support endpoint, method, systemPrompt, maxTokens, temperature, or fallbackToRegex; use nested typesafe transport settings." });
    }
    if (classifier.typesafe?.timeoutMs !== undefined && (!Number.isInteger(classifier.typesafe.timeoutMs) || classifier.typesafe.timeoutMs < 100 || classifier.typesafe.timeoutMs > 60_000)) {
      issues.push({ severity: "error", message: `TypeSafe timeoutMs must be an integer between 100 and 60000, got ${classifier.typesafe.timeoutMs}.` });
    }
    if (classifier.typesafe?.maxAttempts !== undefined && (!Number.isInteger(classifier.typesafe.maxAttempts) || classifier.typesafe.maxAttempts < 1 || classifier.typesafe.maxAttempts > 3)) {
      issues.push({ severity: "error", message: `TypeSafe maxAttempts must be an integer between 1 and 3, got ${classifier.typesafe.maxAttempts}.` });
    }
    if (classifier.minConfidence !== undefined && (!Number.isFinite(classifier.minConfidence) || classifier.minConfidence < 0 || classifier.minConfidence > 1)) {
      issues.push({ severity: "error", message: `TypeSafe minConfidence must be between 0 and 1, got ${classifier.minConfidence}.` });
    }
    if (classifier.fallback !== undefined && classifier.fallback !== "prompt" && classifier.fallback !== "regex") {
      issues.push({ severity: "error", message: `TypeSafe fallback must be "prompt" or "regex", got ${classifier.fallback}.` });
    }
    const criteria = classifier.criteria ?? {};
    for (const tier of modelKeys) {
      if (criteria[tier] === undefined && DEFAULT_CLASSIFIER_CRITERIA[tier] === undefined) issues.push({ severity: "error", message: `TypeSafe classifier criteria missing for tier "${tier}".` });
    }
    for (const [tier, criterion] of Object.entries(criteria)) {
      if (!modelKeys.includes(tier)) issues.push({ severity: "error", message: `Classifier criteria references unknown tier "${tier}".` });
      if (typeof criterion === "string") {
        if (!criterion.trim()) issues.push({ severity: "error", message: `Classifier criterion for tier "${tier}" must not be empty.` });
      } else if (!criterionObject(criterion) || typeof criterion.what !== "string" || !criterion.what.trim()) {
        issues.push({ severity: "error", message: `Classifier criterion for tier "${tier}" requires a non-empty "what" string.` });
      } else if (criterion.notFor !== undefined && typeof criterion.notFor !== "string") {
        issues.push({ severity: "error", message: `Classifier criterion notFor for tier "${tier}" must be a string.` });
      } else if (criterion.examples !== undefined && (!Array.isArray(criterion.examples) || criterion.examples.some((example) => typeof example !== "string"))) {
        issues.push({ severity: "error", message: `Classifier criterion examples for tier "${tier}" must be strings.` });
      }
    }
  }

  if (modelKeys.length === 0) {
    issues.push({
      severity: "error",
      message:
        `No tiers configured in "models". Add at least one tier to ${CONFIG_DIR_NAME}/bifrost.json.`,
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

  if (config.cache?.ttlHours !== undefined && (!Number.isFinite(config.cache.ttlHours) || config.cache.ttlHours < 1)) {
    issues.push({
      severity: "error",
      message: `Cache ttlHours must be a finite number >= 1, got ${config.cache.ttlHours}.`,
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

  const probe = config.probe;
  if (probe?.concurrency !== undefined && (!Number.isInteger(probe.concurrency) || probe.concurrency < 1)) {
    issues.push({
      severity: "error",
      message: `Probe concurrency must be an integer >= 1, got ${probe.concurrency}.`,
    });
  }

  if (probe?.timeoutMs !== undefined && (!Number.isInteger(probe.timeoutMs) || probe.timeoutMs < 1)) {
    issues.push({
      severity: "error",
      message: `Probe timeoutMs must be an integer >= 1, got ${probe.timeoutMs}.`,
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
  try {
    return readJsonFile<T>(path);
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

function criterionObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeCriteria(
  base: Record<string, TierCriterion> | undefined,
  override: Record<string, TierCriterion> | undefined,
): Record<string, TierCriterion> | undefined {
  if (base === undefined && override === undefined) return undefined;
  const result: Record<string, TierCriterion> = { ...(base ?? {}) };
  const rawOverride = override as Record<string, TierCriterion | null> | undefined;
  for (const [tier, value] of Object.entries(rawOverride ?? {})) {
    if (value === null) {
      delete result[tier];
    } else if (criterionObject(result[tier]) && criterionObject(value)) {
      result[tier] = { ...result[tier], ...value } as TierCriterion;
    } else {
      result[tier] = value;
    }
  }
  return result;
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
  if (merged.classifier) {
    merged.classifier.criteria = mergeCriteria(base.classifier?.criteria, override.classifier?.criteria);
    merged.classifier.typesafe = mergeObj(base.classifier?.typesafe, override.classifier?.typesafe);
    if (merged.classifier.backend === CLASSIFIER_BACKEND_IDS.typesafe) {
      const mergedClassifier = merged.classifier as Record<string, unknown>;
      const overrideClassifier = override.classifier as Record<string, unknown> | undefined;
      for (const field of TYPESAFE_PROMPT_FIELDS) {
        if (overrideClassifier?.[field] === undefined) delete mergedClassifier[field];
      }
    }
    if (merged.classifier.typesafe) {
      merged.classifier.typesafe.metrics = mergeObj(
        base.classifier?.typesafe?.metrics,
        override.classifier?.typesafe?.metrics,
      );
    }
  }
  merged.cache = mergeObj(base.cache, override.cache);
  merged.debug = mergeObj(base.debug, override.debug);
  merged.reliability = mergeObj(base.reliability, override.reliability);
  merged.probe = mergeObj(base.probe, override.probe);
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
