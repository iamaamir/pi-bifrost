import type { ClassifierModel } from "./classifier.ts";
import { classifyCompiled, compileRules, type RouteRule } from "./routing.ts";
import type { RoutedModelResolution, RoutingStrategy, SkippedCandidate, TierResolutionOptions } from "./routing.ts";
import { debug, debugMeasure } from "./debug.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassificationJudgment, type ClassifierOutput, type ClassifierBackend } from "./classifier-backends.ts";

// ── ADT result type ────────────────────────────────────────────

export type ClassificationSource = "cache" | "classifier" | "regex" | "inline";

export type ClassificationResult =
  | { readonly kind: "classified"; readonly tier: string; readonly source: ClassificationSource; readonly judgment?: ClassificationJudgment }
  | { readonly kind: "fallback"; readonly tier: string }
  | { readonly kind: "unclassified" };

export interface RouteDecisionCandidate {
  readonly model: string;
  readonly status: "eligible" | "excluded";
  readonly exclusion?: SkippedCandidate["reason"];
}

export interface RouteDecisionPool {
  readonly tier: string;
  readonly strategy: RoutingStrategy;
  readonly patterns: readonly string[];
  readonly candidates: readonly RouteDecisionCandidate[];
}

/** Content-free summary shared by runtime observation and preview output. */
export interface RouteDecisionSummary {
  readonly version: 1;
  readonly kind: "route-decision";
  readonly outcome: "selected" | "unresolved" | "unclassified" | "usage";
  readonly error?: "usage";
  readonly classification: {
    readonly source: ClassificationSource | "fallback" | "unclassified";
    readonly tier?: string;
    readonly classifier?: {
      readonly backend: string;
      readonly model?: string;
      readonly confidence?: number;
    };
  };
  readonly requested?: RouteDecisionPool;
  readonly fallback?: RouteDecisionPool;
  readonly attempted?: readonly RouteDecisionPool[];
  readonly explicitBoundary?: boolean;
  readonly selectedTier?: string;
  readonly selected?: string;
  readonly selectedStrategy?: RoutingStrategy;
  readonly fallbackReason?: RoutedModelResolution["fallbackReason"];
}

export interface ResolvedRouteDecisionInput {
  readonly resolution: RoutedModelResolution;
  readonly options: TierResolutionOptions;
}

function summarizePool(
  tier: string,
  strategy: RoutingStrategy,
  pattern: string | readonly string[] | undefined,
  candidates: RoutedModelResolution["primary"]["candidates"],
  skipped: readonly SkippedCandidate[],
): RouteDecisionPool {
  const exclusions = new Map(skipped.map((candidate) => [candidate.key, candidate.reason]));
  return {
    tier,
    strategy,
    patterns: pattern === undefined ? [] : Array.isArray(pattern) ? [...pattern] : [pattern],
    candidates: candidates.map((candidate) => {
      const model = `${candidate.provider}/${candidate.id}`;
      const exclusion = exclusions.get(model);
      return exclusion
        ? { model, status: "excluded", exclusion }
        : { model, status: "eligible" };
    }),
  };
}

/** Summarize the actual classification and resolver result without retaining prompt or model objects. */
export function buildRouteDecisionSummary(
  classification: ClassificationResult,
  route?: ResolvedRouteDecisionInput,
): RouteDecisionSummary {
  if (classification.kind === "unclassified") {
    return {
      version: 1,
      kind: "route-decision",
      outcome: "unclassified",
      classification: { source: "unclassified" },
    };
  }

  const resolution = route?.resolution;
  const options = route?.options;
  const judgment = classification.kind === "classified" ? classification.judgment : undefined;
  const summary: RouteDecisionSummary = {
    version: 1,
    kind: "route-decision",
    outcome: resolution?.selected ? "selected" : "unresolved",
    classification: {
      source: classification.kind === "classified" ? classification.source : "fallback",
      tier: classification.tier,
      ...(judgment ? {
        classifier: {
          backend: judgment.backend,
          ...(judgment.model !== undefined ? { model: judgment.model } : {}),
          ...(judgment.confidence !== undefined ? { confidence: judgment.confidence } : {}),
        },
      } : {}),
    },
    ...(resolution && options ? {
      requested: summarizePool(
        options.requestedTier,
        options.requestedStrategy,
        options.requestedPattern,
        resolution.primary.candidates,
        resolution.primary.skipped,
      ),
      ...(resolution.fallback ? {
        fallback: summarizePool(
          options.defaultTier ?? options.requestedTier,
          options.defaultStrategy ?? options.requestedStrategy,
          options.defaultPattern,
          resolution.fallback.candidates,
          resolution.fallback.skipped,
        ),
      } : {}),
      ...(resolution.selectedTier !== undefined ? { selectedTier: resolution.selectedTier } : {}),
      ...(resolution.selected ? { selected: `${resolution.selected.provider}/${resolution.selected.id}` } : {}),
      ...(resolution.selected ? { selectedStrategy: resolution.strategy } : {}),
      ...(resolution.fallbackReason !== undefined ? { fallbackReason: resolution.fallbackReason } : {}),
    } : {}),
  };
  if (resolution?.explicitBoundary && resolution.attemptedTiers) {
    const attempted = resolution.attemptedTiers.map((attempt) => summarizePool(
      attempt.tier,
      attempt.strategy,
      attempt.pattern,
      attempt.resolution.candidates,
      attempt.resolution.skipped,
    ));
    return {
      ...summary,
      explicitBoundary: true,
      ...(attempted[0] ? { requested: attempted[0] } : {}),
      ...(attempted[1] ? { fallback: attempted[1] } : {}),
      attempted,
    };
  }
  return summary;
}

// ── Pipeline dependencies ──────────────────────────────────────

/**
 * Dependencies injected into the pipeline. All are in-process.
 *
 * `cacheLookup` may internally mutate its backing store for LRU
 * tracking — this is an accepted impurity (see ADR candidate #4).
 */
export interface PipelineDeps {
  /** Query cache. Returns tier or undefined. */
  readonly cacheLookup: (text: string) => string | undefined;
  /** Optional direct backend (typesafe or pi-native) attempted before the prompt classifier. */
  readonly classifyDirect?: (text: string, tiers: readonly string[], signal?: AbortSignal) => Promise<ClassificationJudgment | undefined>;
  /** Classifier models in priority order. Empty array = skip LLM. */
  readonly classifierModels: readonly ClassifierModel[];
  /** Invoke the LLM classifier for a single model. Returns tier or undefined. */
  readonly classifyWithLLM: (
    model: ClassifierModel,
    text: string,
    tiers: readonly string[],
  ) => Promise<ClassifierOutput | undefined>;
  /** Regex routing rules. First match wins. */
  readonly regexRules: readonly RouteRule[];
  /** Default tier when nothing matches. */
  readonly defaultTier: string | undefined;
  /** Known tier names, from config.models keys. */
  readonly tiers: readonly string[];
}

// ── Pipeline interface ─────────────────────────────────────────

export interface ClassificationPipeline {
  readonly classify: (text: string, signal?: AbortSignal) => Promise<ClassificationResult>;
}

function normalizeJudgment(output: ClassifierOutput, backend: ClassifierBackend): ClassificationJudgment {
  return typeof output === "string"
    ? { tier: output, backend }
    : output;
}

// ── Factory ────────────────────────────────────────────────────

export function createPipeline(deps: PipelineDeps): ClassificationPipeline {
  const {
    cacheLookup,
    classifyDirect,
    classifierModels,
    classifyWithLLM,
    regexRules: rawRegexRules,
    defaultTier,
    tiers,
  } = deps;

  // Compile rules once at pipeline construction — no per-turn regex building.
  // Per-rule testing preserves rule-order match precedence exactly.
  const regexRules = compileRules(rawRegexRules);

  async function classify(text: string, signal?: AbortSignal): Promise<ClassificationResult> {
    // Stage 1: pre-check regex for direct model references only.
    // Runs before tiers check — direct bindings work even with zero tiers.
    {
      const endPre = debugMeasure("pipeline", "regex_pre");
      const pre = classifyCompiled(text, regexRules);
      endPre({ match: !!pre, tier: pre });
      if (pre && pre.includes("/") && !tiers.includes(pre)) {
        debug("pipeline", "result", { source: "regex", tier: pre, direct: true });
        return { kind: "classified", tier: pre, source: "regex" };
      }
    }

    if (tiers.length === 0) return { kind: "unclassified" };

    // Stage 2: cache lookup
    const endCache = debugMeasure("pipeline", "cache");
    const cached = cacheLookup(text);
    endCache({ hit: !!cached });
    if (cached && tiers.includes(cached)) {
      debug("pipeline", "result", { source: "cache", tier: cached });
      return { kind: "classified", tier: cached, source: "cache" };
    }

    // Stage 3: optional direct classifier (typesafe or pi-native), then prompt fallback.
    if (classifyDirect) {
      try {
        const endDirect = debugMeasure("pipeline", "direct.attempt");
        const judgment = await classifyDirect(text, tiers, signal);
        const tier = judgment?.tier;
        endDirect({ tier, backend: judgment?.backend, confidence: judgment?.confidence });
        if (judgment && tiers.includes(judgment.tier)) {
          debug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model, confidence: judgment.confidence });
          return { kind: "classified", tier: judgment.tier, source: "classifier", judgment };
        }
      } catch {
        debug("pipeline", "direct.error", { aborted: signal?.aborted ?? false });
      }
      if (signal?.aborted) return { kind: "unclassified" };
    }

    // Existing prompt classifier — try each model in priority order.
    for (const model of classifierModels) {
      try {
        const endLLM = debugMeasure("pipeline", "classifier.attempt");
        const output = await classifyWithLLM(model, text, tiers);
        const modelId = model.kind === "registry" ? model.model.id : model.id;
        const judgment = output === undefined ? undefined : normalizeJudgment(output, CLASSIFIER_BACKEND_IDS.prompt);
        const tier = judgment?.tier;
        endLLM({ model: modelId, tier, backend: judgment?.backend, confidence: judgment?.confidence });
        if (judgment && tiers.includes(judgment.tier)) {
          debug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model ?? modelId, confidence: judgment.confidence });
          return { kind: "classified", tier: judgment.tier, source: "classifier", judgment: { ...judgment, model: judgment.model ?? modelId } };
        }
      } catch {
        debug("pipeline", "classifier.error", { category: "classifier_failure" });
        console.error("[bifrost] classifier model failed");
      }
    }

    if (signal?.aborted) return { kind: "unclassified" };

    // Stage 4: regex rules
    const endRegex = debugMeasure("pipeline", "regex");
    const regex = classifyCompiled(text, regexRules);
    endRegex({ match: !!regex, tier: regex });
    if (regex) {
      if (tiers.includes(regex)) {
        // Tier name match — route through strategy.
        debug("pipeline", "result", { source: "regex", tier: regex });
        return { kind: "classified", tier: regex, source: "regex" };
      }
      if (regex.includes("/")) {
        // Direct model reference (e.g. "opencode-go/glm-5.1" in rule).
        debug("pipeline", "result", { source: "regex", tier: regex, direct: true });
        return { kind: "classified", tier: regex, source: "regex" };
      }
    }

    // Stage 4: default fallback
    debug("pipeline", "result", { source: "fallback", tier: defaultTier });
    if (defaultTier) {
      return { kind: "fallback", tier: defaultTier };
    }

    return { kind: "unclassified" };
  }

  return { classify };
}
