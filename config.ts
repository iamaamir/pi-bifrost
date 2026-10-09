import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "./storage.ts";
import type { RoutingStrategy, RouteRule } from "./routing.ts";
import type { CacheOptions } from "./cache.ts";
import type { DebugConfig } from "./debug.ts";
import type { ReliabilityConfig } from "./reliability.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL, type ClassifierBackend, type TierCriterion } from "./classifier-backends.ts";
import { emptyEconomicSnapshot, publishEconomicObservation, validateEconomicPolicy, type EconomicSignal, type ReservePolicy } from "./economic-signals.ts";

export { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL } from "./classifier-backends.ts";
export type { ClassifierBackend, TierCriterion } from "./classifier-backends.ts";

type ClassifierMethod = "direct" | "subprocess" | "auto";

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

export interface TierPolicy {
  fallbackTiers: string[];
}

export interface EconomicConfig extends ReservePolicy {
  /** User-entered static/manual observations. No source adapter is inferred. */
  observations?: readonly EconomicSignal[];
}

export interface AffinityConfig {
  mode: "off" | "observe" | "retain-within-tier";
  /** Report same-provider candidate availability as advisory evidence. */
  providerAdvisory?: boolean;
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

export interface PiNativeConfig {
  /** Catalog id in "provider/id" form. Absent resolves the first available classifier entry. */
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Content-free local aggregate observation. Enabled by default when pi-native is active. */
  metrics?: {
    enabled?: boolean;
  };
}

export interface ClassifierConfig {
  enabled?: boolean;
  backend?: ClassifierBackend;
  /** Optional total external classification budget. Absent preserves backend-specific timeouts. */
  totalTimeoutMs?: number;
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
  piNative?: PiNativeConfig;
  minConfidence?: number;
  fallback?: "prompt" | "regex";
}

export interface BifrostConfig {
  schemaVersion?: number;
  tierPolicies?: Record<string, TierPolicy>;
  economics?: EconomicConfig;
  affinity?: AffinityConfig;
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
  /** Stable content-free identifier for supported structured diagnostics. */
  readonly code?: string;
  /** Static config path; dynamic tier and field names are replaced with placeholders. */
  readonly path?: string;
}

export function classifierTotalTimeoutIssue(config: BifrostConfig): ConfigIssue | undefined {
  const timeout = (config.classifier as unknown as Record<string, unknown> | undefined)?.totalTimeoutMs;
  if (timeout === undefined) return undefined;
  if (typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 60_000) return undefined;
  return {
    severity: "error",
    code: "config.classifier_total_timeout_invalid",
    path: "classifier.totalTimeoutMs",
    message: "Classifier totalTimeoutMs must be a safe integer between 1 and 60000.",
  };
}

export const PROMPT_ONLY_FIELDS = [
  "endpoint",
  "method",
  "systemPrompt",
  "maxTokens",
  "temperature",
  "fallbackToRegex",
] as const;

/** True when no configured tier lists a model — nothing to route. */
export function configHasNoPools(config: BifrostConfig): boolean {
  // Unvalidated JSON: treat non-string entries as blank instead of throwing.
  const blank = (entry: unknown): boolean => typeof entry !== "string" || entry.trim() === "";
  return Object.values(config.models ?? {}).every((pool) => (Array.isArray(pool) ? pool.every(blank) : blank(pool)));
}

export function hasExplicitTierPolicy(config: BifrostConfig, tier: string): boolean {
  return config.schemaVersion === 2
    && Object.hasOwn(config.tierPolicies ?? {}, tier)
    && Array.isArray(config.tierPolicies?.[tier]?.fallbackTiers);
}

export function hasExplicitTierPolicies(config: BifrostConfig): boolean {
  return config.schemaVersion === 2
    && Object.values(config.tierPolicies ?? {}).some((policy) => Array.isArray(policy?.fallbackTiers));
}

export function classifierConfigErrors(config: BifrostConfig, effectiveBackend?: ClassifierBackend): string[] {
  let checked = config;
  if (effectiveBackend && config.classifier?.backend === undefined) {
    // Auto-detection chooses the direct transport after layers merge. Retain
    // prompt-only settings for fallback, but do not validate them as direct
    // transport settings; still validate direct criteria and bounds.
    const classifier: Record<string, unknown> = { ...config.classifier, backend: effectiveBackend };
    if (effectiveBackend !== CLASSIFIER_BACKEND_IDS.prompt) {
      for (const field of PROMPT_ONLY_FIELDS) delete classifier[field];
    }
    checked = { ...config, classifier: classifier as ClassifierConfig };
  }
  return validateConfig(checked)
    .filter((issue) => issue.severity === "error" && /classifier/i.test(issue.message))
    .map((issue) => issue.message);
}

export function hasClassifierConfigErrors(config: BifrostConfig, effectiveBackend?: ClassifierBackend): boolean {
  return classifierConfigErrors(config, effectiveBackend).length > 0;
}

export function validateTierPolicyConfig(config: BifrostConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const policyIssue = (code: string, path: string, message: string): void => {
    issues.push({ severity: "error", code, path, message });
  };
  const modelKeys = Object.keys(config.models ?? {});
  const schemaVersion = config.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 1 && schemaVersion !== 2) {
    policyIssue("config.schema_version_unsupported", "schemaVersion", `Unsupported schemaVersion "${String(schemaVersion)}"; supported versions are 1 and 2.`);
  }
  const tierPolicies = config.tierPolicies as Record<string, unknown> | undefined;
  if (tierPolicies !== undefined && schemaVersion !== 2) {
    policyIssue("config.tier_policies_requires_v2", "tierPolicies", "tierPolicies requires schemaVersion 2.");
  }
  if (tierPolicies !== undefined && (!tierPolicies || typeof tierPolicies !== "object" || Array.isArray(tierPolicies))) {
    policyIssue("config.tier_policies_invalid", "tierPolicies", "tierPolicies must be an object keyed by configured tier.");
  }
  const edges = new Map<string, string[]>();
  if (tierPolicies && typeof tierPolicies === "object" && !Array.isArray(tierPolicies)) {
    for (const [tier, rawPolicy] of Object.entries(tierPolicies)) {
      if (!modelKeys.includes(tier)) {
        policyIssue("config.tier_policy_unknown_tier", "tierPolicies.*", `tierPolicies.${tier} references a tier not found in models [${modelKeys.join(", ")}].`);
      }
      if (!criterionObject(rawPolicy)) {
        policyIssue("config.tier_policy_invalid", "tierPolicies.*", `tierPolicies.${tier} must be an object with fallbackTiers.`);
        continue;
      }
      for (const key of Object.keys(rawPolicy)) {
        if (key !== "fallbackTiers") {
          policyIssue("config.tier_policy_unknown_field", "tierPolicies.*", `Unknown field "${key}" in tierPolicies.${tier}.`);
        }
      }
      const fallbackTiers = rawPolicy.fallbackTiers;
      if (!Array.isArray(fallbackTiers) || fallbackTiers.some((fallback) => typeof fallback !== "string")) {
        policyIssue("config.tier_policy_fallback_invalid", "tierPolicies.*.fallbackTiers", `tierPolicies.${tier}.fallbackTiers must be an array of tier names.`);
        continue;
      }
      const seenFallbacks = new Set<string>();
      for (const fallback of fallbackTiers) {
        if (!modelKeys.includes(fallback)) {
          policyIssue("config.tier_policy_unknown_fallback", "tierPolicies.*.fallbackTiers", `Fallback tier "${fallback}" in tierPolicies.${tier} was not found in models.`);
        }
        if (fallback === tier) {
          policyIssue("config.tier_policy_self_fallback", "tierPolicies.*.fallbackTiers", `tierPolicies.${tier} cannot fall back to itself.`);
        }
        if (seenFallbacks.has(fallback)) {
          policyIssue("config.tier_policy_duplicate_fallback", "tierPolicies.*.fallbackTiers", `Duplicate fallback tier "${fallback}" in tierPolicies.${tier}.`);
        }
        seenFallbacks.add(fallback);
      }
      edges.set(tier, fallbackTiers);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitTier = (tier: string): void => {
    if (visiting.has(tier)) {
      policyIssue("config.tier_policy_cycle", "tierPolicies.*.fallbackTiers", `tierPolicies contains a fallback cycle through tier "${tier}".`);
      return;
    }
    if (visited.has(tier)) return;
    visiting.add(tier);
    for (const fallback of edges.get(tier) ?? []) {
      if (edges.has(fallback)) visitTier(fallback);
    }
    visiting.delete(tier);
    visited.add(tier);
  };
  for (const tier of edges.keys()) visitTier(tier);
  issues.push(...validateEconomicConfig(config));
  return issues;
}

export function validateEconomicConfig(config: BifrostConfig): ConfigIssue[] {
  const raw = (config as unknown as Record<string, unknown>).economics;
  if (raw === undefined) return [];
  const issues: ConfigIssue[] = [];
  const add = (code: string, path: string, message: string): void => {
    issues.push({ severity: "error", code, path, message });
  };
  if (config.schemaVersion !== 2) {
    add("config.economics_requires_v2", "economics", "economics requires schemaVersion 2.");
  }
  if (!criterionObject(raw)) {
    add("config.economics_invalid", "economics", "economics must be an object.");
    return issues;
  }
  const allowedFields = new Set(["mode", "scopes", "sources", "sourceOrder", "admission", "preference", "tierOverrides", "observations"]);
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) add("config.economics_unknown_field", "economics.*", "economics contains an unsupported field.");
  }
  const { observations, ...policyValue } = raw;
  const checkUnknownFields = (value: unknown, allowed: readonly string[], path: string): void => {
    if (!criterionObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) add("config.economics_unknown_field", path, "economics contains an unsupported field.");
    }
  };
  if (criterionObject(policyValue.scopes)) {
    for (const scope of Object.values(policyValue.scopes)) {
      checkUnknownFields(scope, scope && typeof scope === "object" && (scope as { kind?: unknown }).kind === "model"
        ? ["kind", "model"] : ["kind", "provider"], "economics.scopes.*");
    }
  }
  if (Array.isArray(policyValue.sources)) {
    for (const source of policyValue.sources) {
      checkUnknownFields(source, ["id", "scopeRef", "authority"], "economics.sources[]");
      if (criterionObject(source) && source.authority === "authoritative") {
        add("config.economics_authority_forbidden", "economics.sources[].authority", "Config-declared economic sources cannot claim authoritative status.");
      }
    }
  }
  if (Array.isArray(policyValue.admission)) {
    for (const rule of policyValue.admission) {
      checkUnknownFields(rule, ["id", "scopeRef", "windowId", "reserveRatio", "unknown"], "economics.admission[]");
    }
  }
  if (policyValue.preference !== undefined) {
    checkUnknownFields(policyValue.preference, ["billingClass"], "economics.preference");
    if (!criterionObject(policyValue.preference)
      || !["subscription", "metered", "free"].includes(String(policyValue.preference.billingClass))) {
      add("config.economics_preference_invalid", "economics.preference.billingClass", "economics.preference.billingClass must name an explicit billing class.");
    }
  }
  if (criterionObject(policyValue.tierOverrides)) {
    for (const overrides of Object.values(policyValue.tierOverrides)) {
      if (!criterionObject(overrides)) continue;
      for (const override of Object.values(overrides)) {
        checkUnknownFields(override, ["reserveRatio", "unknown"], "economics.tierOverrides.*.*");
      }
    }
  }
  const validation = validateEconomicPolicy(policyValue as unknown as ReservePolicy, { accountDispatch: false });
  for (const issue of validation.diagnostics) {
    if (issue.code === "policy.invalid_preference") continue;
    const code = issue.code === "policy.unsupported_account_scope" ? "config.economics_account_scope_unsupported" : `config.economics_${issue.code.replaceAll(".", "_")}`;
    const path = issue.code === "policy.empty_admission" && policyValue.preference !== undefined
      ? "economics.admission"
      : issue.scopeRef ? "economics.scopes.*" : issue.sourceId ? "economics.sources[]" : issue.ruleId ? "economics.admission[]" : "economics";
    add(code, path, "The configured economic policy is invalid or unsupported.");
  }
  if (observations !== undefined && !Array.isArray(observations)) {
    add("config.economics_observations_invalid", "economics.observations", "economics.observations must be an array of static signals.");
  } else if (Array.isArray(observations)) {
    if (observations.length > 64) add("config.economics_observation_limit", "economics.observations", "economics.observations exceeds the configured observation limit.");
    let snapshot = emptyEconomicSnapshot();
    for (const observation of observations) {
      checkUnknownFields(observation, ["sourceId", "scopeRef", "billing", "observedAt", "expiresAt", "revision", "windows"], "economics.observations[]");
      if (criterionObject(observation) && Array.isArray(observation.windows)) {
        for (const window of observation.windows) {
          checkUnknownFields(window, ["id", "period", "unit", "currency", "remaining", "limit", "resetsAt"], "economics.observations[].windows[]");
          if (criterionObject(window)) checkUnknownFields(window.period, ["id", "sequence"], "economics.observations[].windows[].period");
        }
      }
      const result = publishEconomicObservation(snapshot, policyValue as unknown as ReservePolicy, observation as EconomicSignal);
      if (!result.accepted) {
        add("config.economics_observation_invalid", "economics.observations[]", "A configured static economic observation is invalid or stale.");
      } else {
        snapshot = result.snapshot;
      }
    }
  }
  return issues;
}

/**
 * Validate a resolved BifrostConfig. Returns issues (errors stop
 * the extension from starting, warnings are logged only).
 */
export function validateConfig(
  config: BifrostConfig,
): ConfigIssue[] {
  const issues: ConfigIssue[] = validateTierPolicyConfig(config);
  const modelKeys = Object.keys(config.models ?? {});
  const classifier = config.classifier;
  const totalTimeoutIssue = classifierTotalTimeoutIssue(config);
  if (totalTimeoutIssue) issues.push(totalTimeoutIssue);
  if (classifier?.backend && !Object.values(CLASSIFIER_BACKEND_IDS).includes(classifier.backend)) {
    issues.push({ severity: "error", message: `Unknown classifier backend "${classifier.backend}".` });
  }
  const directBackend = classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe || classifier?.backend === CLASSIFIER_BACKEND_IDS.piNative;
  const directLabel = classifier?.backend === CLASSIFIER_BACKEND_IDS.piNative ? "PiNative" : "TypeSafe";
  const directKey = classifier?.backend === CLASSIFIER_BACKEND_IDS.piNative ? "piNative" : "typesafe";
  if (classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe) {
    if (classifier.typesafe?.model !== undefined && classifier.typesafe.model !== TYPE_SAFE_MODEL) {
      issues.push({ severity: "error", message: `TypeSafe classifier model must be exactly "${TYPE_SAFE_MODEL}".` });
    }
    if (classifier.typesafe?.endpoint !== undefined && classifier.typesafe.endpoint !== TYPE_SAFE_ENDPOINT) {
      issues.push({ severity: "error", message: `TypeSafe classifier endpoint must be "${TYPE_SAFE_ENDPOINT}".` });
    }
    if (classifier.typesafe?.timeoutMs !== undefined && (!Number.isInteger(classifier.typesafe.timeoutMs) || classifier.typesafe.timeoutMs < 100 || classifier.typesafe.timeoutMs > 60_000)) {
      issues.push({ severity: "error", message: `TypeSafe classifier timeoutMs must be an integer between 100 and 60000, got ${classifier.typesafe.timeoutMs}.` });
    }
    if (classifier.typesafe?.maxAttempts !== undefined && (!Number.isInteger(classifier.typesafe.maxAttempts) || classifier.typesafe.maxAttempts < 1 || classifier.typesafe.maxAttempts > 3)) {
      issues.push({ severity: "error", message: `TypeSafe classifier maxAttempts must be an integer between 1 and 3, got ${classifier.typesafe.maxAttempts}.` });
    }
  }
  if (classifier?.backend === CLASSIFIER_BACKEND_IDS.piNative) {
    if (classifier.piNative?.timeoutMs !== undefined && (!Number.isInteger(classifier.piNative.timeoutMs) || classifier.piNative.timeoutMs < 100 || classifier.piNative.timeoutMs > 60_000)) {
      issues.push({ severity: "error", message: `PiNative classifier timeoutMs must be an integer between 100 and 60000, got ${classifier.piNative.timeoutMs}.` });
    }
    if (classifier.piNative?.maxAttempts !== undefined && (!Number.isInteger(classifier.piNative.maxAttempts) || classifier.piNative.maxAttempts < 1 || classifier.piNative.maxAttempts > 3)) {
      issues.push({ severity: "error", message: `PiNative classifier maxAttempts must be an integer between 1 and 3, got ${classifier.piNative.maxAttempts}.` });
    }
  }
  if (directBackend && classifier) {
    if (classifier.endpoint !== undefined || classifier.method !== undefined || classifier.systemPrompt !== undefined || classifier.maxTokens !== undefined || classifier.temperature !== undefined || classifier.fallbackToRegex !== undefined) {
      issues.push({ severity: "error", message: `${directLabel} classifier does not support endpoint, method, systemPrompt, maxTokens, temperature, or fallbackToRegex; use nested ${directKey} transport settings.` });
    }
    if (classifier.minConfidence !== undefined && (!Number.isFinite(classifier.minConfidence) || classifier.minConfidence < 0 || classifier.minConfidence > 1)) {
      issues.push({ severity: "error", message: `${directLabel} classifier minConfidence must be between 0 and 1, got ${classifier.minConfidence}.` });
    }
    if (classifier.fallback !== undefined && classifier.fallback !== "prompt" && classifier.fallback !== "regex") {
      issues.push({ severity: "error", message: `${directLabel} classifier fallback must be "prompt" or "regex", got ${classifier.fallback}.` });
    }
    const criteria = classifier.criteria ?? {};
    for (const tier of modelKeys) {
      if (criteria[tier] === undefined && DEFAULT_CLASSIFIER_CRITERIA[tier] === undefined) issues.push({ severity: "error", message: `${directLabel} classifier criteria missing for tier "${tier}".` });
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
  const affinityRaw = (config as unknown as Record<string, unknown>).affinity;
  if (affinityRaw !== undefined) {
    if (!criterionObject(affinityRaw)
      || Object.keys(affinityRaw).some((key) => key !== "mode" && key !== "providerAdvisory")
      || (affinityRaw.mode !== "off" && affinityRaw.mode !== "observe" && affinityRaw.mode !== "retain-within-tier")
      || (affinityRaw.providerAdvisory !== undefined && typeof affinityRaw.providerAdvisory !== "boolean")) {
      issues.push({ severity: "error", code: "config.affinity_invalid", path: "affinity", message: "affinity must contain a supported mode and optional boolean providerAdvisory." });
    }
    if (config.schemaVersion !== 2) {
      issues.push({ severity: "error", code: "config.affinity_requires_schema_v2", path: "affinity", message: "affinity requires schemaVersion 2." });
    }
  }
  const reliabilityProblem = (code: string, path: string, message: string): void => {
    issues.push({ severity: "error", code, path, message });
  };
  const reliabilityRaw = (config as unknown as Record<string, unknown>).reliability;
  const reliabilityRecord = criterionObject(reliabilityRaw) ? reliabilityRaw : undefined;
  if (reliabilityRaw !== undefined && !reliabilityRecord) {
    issues.push({ severity: "error", code: "config.reliability_invalid", path: "reliability", message: "reliability must be an object." });
  }
  if (reliabilityRecord) {
    const stateVersion = reliabilityRecord.stateVersion;
    if (stateVersion !== undefined && stateVersion !== 1 && stateVersion !== 2) {
      issues.push({ severity: "error", code: "config.reliability_state_version_unsupported", path: "reliability.stateVersion", message: "reliability.stateVersion must be 1 or 2." });
    }
    if (stateVersion === 2 && config.schemaVersion !== 2) {
      issues.push({ severity: "error", code: "config.reliability_state_v2_requires_schema_v2", path: "reliability.stateVersion", message: "reliability.stateVersion 2 requires schemaVersion 2." });
    }
    const observations = reliabilityRecord.observations;
    if (observations !== undefined) {
      if (stateVersion !== 2 || !criterionObject(observations)) {
        issues.push({ severity: "error", code: "config.reliability_observations_invalid", path: "reliability.observations", message: "reliability.observations requires stateVersion 2 and must be an object." });
      } else if (Object.keys(observations).some((key) => key !== "enabled") || (observations.enabled !== undefined && typeof observations.enabled !== "boolean")) {
        issues.push({ severity: "error", code: "config.reliability_observations_invalid", path: "reliability.observations", message: "reliability.observations supports only a boolean enabled field." });
      }
    }
    if (reliabilityRecord.cooldownOnAllowanceExhausted !== undefined
      && typeof reliabilityRecord.cooldownOnAllowanceExhausted !== "boolean") {
      reliabilityProblem("config.reliability_allowance_cooldown_invalid", "reliability.cooldownOnAllowanceExhausted", "reliability.cooldownOnAllowanceExhausted must be a boolean.");
    }
    if (reliabilityRecord.retryOnAllowanceExhausted !== undefined
      && typeof reliabilityRecord.retryOnAllowanceExhausted !== "boolean") {
      reliabilityProblem("config.reliability_allowance_retry_invalid", "reliability.retryOnAllowanceExhausted", "reliability.retryOnAllowanceExhausted must be a boolean.");
    }
    const known = new Set(["enabled", "failureThreshold", "windowMinutes", "cooldownMinutes", "path", "stateVersion", "observations", "cooldownOnAllowanceExhausted", "retryOnAllowanceExhausted"]);
    if (Object.keys(reliabilityRecord).some((key) => !known.has(key))) {
      issues.push({ severity: "error", code: "config.reliability_unknown_field", path: "reliability", message: "reliability contains an unsupported field." });
    }
  }
  if (reliability?.failureThreshold !== undefined && (!Number.isInteger(reliability.failureThreshold) || reliability.failureThreshold < 1)) {
    reliabilityProblem("config.reliability_threshold_invalid", "reliability.failureThreshold", "Reliability failureThreshold must be an integer >= 1.");
  }

  if (reliability?.windowMinutes !== undefined && (!Number.isInteger(reliability.windowMinutes) || reliability.windowMinutes < 1)) {
    reliabilityProblem("config.reliability_window_invalid", "reliability.windowMinutes", "Reliability windowMinutes must be an integer >= 1.");
  }

  if (reliability?.cooldownMinutes !== undefined && (!Number.isInteger(reliability.cooldownMinutes) || reliability.cooldownMinutes < 1)) {
    reliabilityProblem("config.reliability_cooldown_invalid", "reliability.cooldownMinutes", "Reliability cooldownMinutes must be an integer >= 1.");
  }
  if (reliability?.stateVersion === 2) {
    const threshold = reliability.failureThreshold ?? 3;
    const windowMinutes = reliability.windowMinutes ?? 5;
    const cooldownMinutes = reliability.cooldownMinutes ?? 60;
    if (!Number.isSafeInteger(threshold) || threshold > 10_000) {
      reliabilityProblem("config.reliability_v2_bounds_invalid", "reliability.failureThreshold", "Reliability v2 failureThreshold must be a safe integer from 1 to 10000.");
    }
    if (!Number.isSafeInteger(windowMinutes) || windowMinutes > 1_000_000
      || !Number.isSafeInteger(cooldownMinutes) || cooldownMinutes > 1_000_000) {
      reliabilityProblem("config.reliability_v2_bounds_invalid", "reliability", "Reliability v2 window and cooldown must be safe whole-minute values no greater than 1000000.");
    }
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
  merged.tierPolicies = mergeTierPolicies(base.tierPolicies, override.tierPolicies);
  merged.classifier = mergeObj(base.classifier, override.classifier);
  if (merged.classifier) {
    merged.classifier.criteria = mergeCriteria(base.classifier?.criteria, override.classifier?.criteria);
    merged.classifier.typesafe = mergeObj(base.classifier?.typesafe, override.classifier?.typesafe);
    merged.classifier.piNative = mergeObj(base.classifier?.piNative, override.classifier?.piNative);
    if (merged.classifier.backend === CLASSIFIER_BACKEND_IDS.typesafe || merged.classifier.backend === CLASSIFIER_BACKEND_IDS.piNative) {
      const mergedClassifier = merged.classifier as Record<string, unknown>;
      const overrideClassifier = override.classifier as Record<string, unknown> | undefined;
      for (const field of PROMPT_ONLY_FIELDS) {
        if (overrideClassifier?.[field] === undefined) delete mergedClassifier[field];
      }
    }
    if (merged.classifier.typesafe) {
      merged.classifier.typesafe.metrics = mergeObj(
        base.classifier?.typesafe?.metrics,
        override.classifier?.typesafe?.metrics,
      );
    }
    if (merged.classifier.piNative) {
      merged.classifier.piNative.metrics = mergeObj(
        base.classifier?.piNative?.metrics,
        override.classifier?.piNative?.metrics,
      );
    }
  }
  merged.cache = mergeObj(base.cache, override.cache);
  merged.debug = mergeObj(base.debug, override.debug);
  merged.reliability = mergeObj(base.reliability, override.reliability);
  merged.probe = mergeObj(base.probe, override.probe);
  return merged;
}

function mergeTierPolicies(
  base: unknown,
  override: unknown,
): BifrostConfig["tierPolicies"] {
  if (override === undefined) return base as BifrostConfig["tierPolicies"];
  if (!criterionObject(override)) return override as BifrostConfig["tierPolicies"];
  const merged = criterionObject(base) ? { ...base } : {};
  for (const [tier, policy] of Object.entries(override)) {
    const previous = merged[tier];
    merged[tier] = criterionObject(previous) && criterionObject(policy)
      ? { ...previous, ...policy } as unknown as TierPolicy
      : policy as TierPolicy;
  }
  return merged as BifrostConfig["tierPolicies"];
}

export function loadConfig(
  cwd: string,
  extensionDir: string,
): BifrostConfig {
  const base = defaultConfig();

  const configs = configLayerPaths(cwd, extensionDir).map(([, path]) => readJson<BifrostConfig>(path));
  let merged: BifrostConfig = base;
  for (const cfg of configs) {
    if (cfg) merged = mergeConfig(merged, cfg);
  }
  return merged;
}

export interface ConfigLoadDiagnostic {
  readonly layer: "extension" | "global" | "workspace" | "project";
  readonly message: string;
}

export interface ConfigLoadResult {
  readonly config: BifrostConfig;
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
}

/** Load command-reload layers while preserving parse/root-shape failures for strict last-good gating. */
export function loadConfigForReload(cwd: string, extensionDir: string): ConfigLoadResult {
  const diagnostics: ConfigLoadDiagnostic[] = [];
  let merged = defaultConfig();
  for (const [layer, path] of configLayerPaths(cwd, extensionDir)) {
    let text: string | undefined;
    try {
      if (existsSync(path)) text = readFileSync(path, "utf8");
    } catch {
      diagnostics.push({ layer, message: `${layer} config could not be read.` });
      continue;
    }
    if (text === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      diagnostics.push({ layer, message: `${layer} config is not valid JSON.` });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({ layer, message: `${layer} config must contain an object.` });
      continue;
    }
    merged = mergeConfig(merged, parsed as BifrostConfig);
  }
  return { config: merged, diagnostics };
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
  const diagnostics: ConfigLoadDiagnostic[] = [];
  if (source !== "project" && source !== "workspace" && source !== "user") {
    return {
      config: defaultConfig(),
      diagnostics: [{ layer: "project", message: "Selected config source is invalid." }],
    };
  }
  const selectedLayer: ConfigLoadDiagnostic["layer"] = source === "project" ? "project"
    : source === "workspace" ? "workspace" : "global";
  let merged = defaultConfig();
  for (const [layer, path] of configLayerPaths(cwd, extensionDir)) {
    let text: string | undefined;
    if (layer === selectedLayer) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(replacementBytes);
      } catch {
        diagnostics.push({ layer, message: `${layer} config is not valid UTF-8.` });
        continue;
      }
    } else {
      try {
        if (existsSync(path)) text = readFileSync(path, "utf8");
      } catch {
        diagnostics.push({ layer, message: `${layer} config could not be read.` });
        continue;
      }
    }
    if (text === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      diagnostics.push({ layer, message: `${layer} config is not valid JSON.` });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({ layer, message: `${layer} config must contain an object.` });
      continue;
    }
    merged = mergeConfig(merged, parsed as BifrostConfig);
  }
  return { config: merged, diagnostics };
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

function configLayerPaths(
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
