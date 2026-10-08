import type { ClassifierModel } from "./classifier.ts";
import { classifyCompiled, compileRules, type RouteRule } from "./routing.ts";
import type { RoutedModelResolution, RoutingStrategy, SkippedCandidate, TierResolutionOptions } from "./routing.ts";
import { debug, debugMeasure } from "./debug.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassificationJudgment, type ClassifierOutput, type ClassifierBackend } from "./classifier-backends.ts";
import type { EconomicCandidateEvaluation } from "./routing.ts";
import type { BillingPreferenceProjection } from "./economic-preferences.ts";
import type { AffinityRouteObservation } from "./affinity.ts";
import { performance } from "node:perf_hooks";

// ── ADT result type ────────────────────────────────────────────

export type ClassificationSource = "cache" | "classifier" | "regex" | "inline";
export type ClassificationOutcome = "deadline" | "aborted";

export type ClassificationResult =
  | { readonly kind: "classified"; readonly tier: string; readonly source: ClassificationSource; readonly judgment?: ClassificationJudgment; readonly classificationOutcome?: ClassificationOutcome }
  | { readonly kind: "fallback"; readonly tier: string; readonly classificationOutcome?: ClassificationOutcome }
  | { readonly kind: "unclassified"; readonly classificationOutcome?: ClassificationOutcome };

export interface RouteDecisionCandidate {
  readonly model: string;
  readonly status: "eligible" | "excluded";
  readonly exclusion?: SkippedCandidate["reason"] | "economic_reserve";
  readonly reserve?: {
    readonly disposition: string;
    readonly wouldReject: boolean;
    readonly reasons: readonly string[];
  };
}

export interface RouteDecisionPool {
  readonly tier: string;
  readonly strategy: RoutingStrategy;
  readonly patterns: readonly string[];
  readonly candidates: readonly RouteDecisionCandidate[];
  readonly billingPreference?: {
    readonly mode: "observe" | "policy";
    readonly preferredClass: string;
    readonly eligibleCount: number;
    readonly preferredCount: number;
    readonly selectionCount: number;
    readonly candidates: BillingPreferenceProjection["traces"];
  };
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
  readonly classificationOutcome?: ClassificationOutcome;
  readonly affinity?: AffinityRouteObservation;
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
  economic?: readonly EconomicCandidateEvaluation[],
  billingPreference?: BillingPreferenceProjection,
): RouteDecisionPool {
  const exclusions = new Map(skipped.map((candidate) => [candidate.key, candidate.reason]));
  const reserveEvaluations = new Map((economic ?? []).map(({ key, evaluation }) => [key, evaluation]));
  return {
    tier,
    strategy,
    patterns: pattern === undefined ? [] : Array.isArray(pattern) ? [...pattern] : [pattern],
    candidates: candidates.map((candidate) => {
      const model = `${candidate.provider}/${candidate.id}`;
      const exclusion = exclusions.get(model);
      const reserve = reserveEvaluations.get(model);
      const hardExcluded = reserve?.mode === "policy" && reserve.disposition === "rejected";
      return {
        model,
        status: exclusion || hardExcluded ? "excluded" : "eligible",
        ...(exclusion ? { exclusion } : hardExcluded ? { exclusion: "economic_reserve" as const } : {}),
        ...(reserve ? {
          reserve: {
            disposition: reserve.disposition,
            wouldReject: reserve.wouldReject,
            reasons: reserve.results.map((result) => result.reason),
          },
        } : {}),
      };
    }),
    ...(billingPreference ? {
      billingPreference: {
        mode: billingPreference.mode,
        preferredClass: billingPreference.preferredClass ?? "unknown",
        eligibleCount: billingPreference.eligibleCount,
        preferredCount: billingPreference.preferredCount,
        selectionCount: billingPreference.selectionCount,
        candidates: billingPreference.traces.map((trace) => ({
          model: trace.model,
          billingClass: trace.billingClass,
          sourceAliases: [...trace.sourceAliases],
          authorities: [...trace.authorities],
          freshness: trace.freshness,
          effect: trace.effect,
        })),
      },
    } : {}),
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
      ...(classification.classificationOutcome ? { classificationOutcome: classification.classificationOutcome } : {}),
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
    ...(classification.classificationOutcome ? { classificationOutcome: classification.classificationOutcome } : {}),
    ...(resolution?.affinityObservation ? { affinity: resolution.affinityObservation } : {}),
    ...(resolution && options ? {
      requested: summarizePool(
        options.requestedTier,
        options.requestedStrategy,
        options.requestedPattern,
        resolution.primary.candidates,
        resolution.primary.skipped,
        resolution.primary.economic,
        resolution.primary.billingPreference,
      ),
      ...(resolution.fallback ? {
        fallback: summarizePool(
          options.defaultTier ?? options.requestedTier,
          options.defaultStrategy ?? options.requestedStrategy,
          options.defaultPattern,
          resolution.fallback.candidates,
          resolution.fallback.skipped,
          resolution.fallback.economic,
          resolution.fallback.billingPreference,
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
      attempt.resolution.economic,
      attempt.resolution.billingPreference,
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
  /** Disable process-global debug instrumentation for isolated resolve-only callers. */
  readonly instrumentation?: "none";
  /** Optional total network-classification budget. Absent preserves backend budgets. */
  readonly totalTimeoutMs?: number;
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
    signal?: AbortSignal,
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
  const totalTimeoutMs = deps.totalTimeoutMs;
  const totalTimeoutValid = totalTimeoutMs === undefined
    || (Number.isSafeInteger(totalTimeoutMs) && totalTimeoutMs >= 1 && totalTimeoutMs <= 60_000);
  const disableExternalForInvalidTimeout = !totalTimeoutValid;
  const emitDebug = (
    module: string,
    event: string,
    meta?: Record<string, unknown>,
  ): void => {
    if (deps.instrumentation !== "none") debug(module, event, meta);
  };
  const measureDebug = (module: string, event: string) => {
    if (deps.instrumentation === "none") return (_meta?: Record<string, unknown>) => {};
    return debugMeasure(module, event);
  };

  // Compile rules once at pipeline construction — no per-turn regex building.
  // Per-rule testing preserves rule-order match precedence exactly.
  const regexRules = compileRules(rawRegexRules);

  async function classify(text: string, signal?: AbortSignal): Promise<ClassificationResult> {
    const startedAt = performance.now();
    const deadlineAt = totalTimeoutValid && totalTimeoutMs !== undefined ? startedAt + totalTimeoutMs : undefined;
    let runController: AbortController | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let removeCallerAbort: (() => void) | undefined;
    let classificationOutcome: ClassificationOutcome | undefined;
    const markOutcome = (outcome: ClassificationOutcome): void => {
      if (classificationOutcome === outcome) return;
      classificationOutcome = outcome;
      emitDebug("pipeline", outcome === "deadline" ? "classifier.deadline" : "classifier.aborted", {
        elapsed_ms: Math.round(performance.now() - startedAt),
      });
    };
    const stop = (outcome: ClassificationOutcome): ClassificationResult => {
      markOutcome(outcome);
      return { kind: "unclassified", classificationOutcome: outcome };
    };
    const ensureSignal = (): AbortSignal | undefined => {
      if (runController) return runController.signal;
      if (!signal && deadlineAt === undefined) return undefined;
      runController = new AbortController();
      if (signal) {
        const abortCaller = () => runController?.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abortCaller();
        else {
          signal.addEventListener("abort", abortCaller, { once: true });
          removeCallerAbort = () => signal.removeEventListener("abort", abortCaller);
        }
      }
      if (deadlineAt !== undefined) {
        const remaining = Math.max(0, deadlineAt - performance.now());
        deadlineTimer = setTimeout(() => {
          markOutcome("deadline");
          runController?.abort(new DOMException("Classifier deadline exceeded", "TimeoutError"));
        }, remaining);
      }
      return runController.signal;
    };
    const invokeExternal = async <T>(
      operation: (attemptSignal?: AbortSignal) => Promise<T>,
    ): Promise<{ readonly status: "completed"; readonly value: T } | { readonly status: ClassificationOutcome }> => {
      if (signal?.aborted) return { status: "aborted" };
      if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
        markOutcome("deadline");
        return { status: "deadline" };
      }
      const attemptSignal = ensureSignal();
      if (attemptSignal?.aborted) return { status: signal?.aborted ? "aborted" : "deadline" };
      const result = Promise.resolve().then(() => {
        if (attemptSignal?.aborted || signal?.aborted) return undefined as T;
        return operation(attemptSignal);
      });
      if (!attemptSignal) return { status: "completed", value: await result };
      const raced = await new Promise<
        | { readonly status: "completed"; readonly value: T }
        | { readonly status: "rejected"; readonly error: unknown }
        | { readonly status: "aborted" }
      >((resolve) => {
        let settled = false;
        const finish = (value: { readonly status: "completed"; readonly value: T } | { readonly status: "rejected"; readonly error: unknown } | { readonly status: "aborted" }) => {
          if (settled) return;
          settled = true;
          attemptSignal.removeEventListener("abort", abort);
          resolve(value);
        };
        const abort = () => finish({ status: "aborted" });
        attemptSignal.addEventListener("abort", abort, { once: true });
        result.then(
          (value) => finish({ status: "completed", value }),
          (error) => finish({ status: "rejected", error }),
        );
        if (attemptSignal.aborted) abort();
      });
      if (signal?.aborted) return { status: "aborted" };
      if (classificationOutcome === "deadline" || (deadlineAt !== undefined && performance.now() >= deadlineAt)) {
        markOutcome("deadline");
        return { status: "deadline" };
      }
      if (raced.status === "aborted") return { status: "aborted" };
      if (raced.status === "rejected") throw raced.error;
      return raced;
    };
    const withOutcome = <T extends ClassificationResult>(result: T): T =>
      classificationOutcome ? { ...result, classificationOutcome } as T : result;

    try {
      if (signal?.aborted) return stop("aborted");
    // Stage 1: pre-check regex for direct model references only.
    // Runs before tiers check — direct bindings work even with zero tiers.
    {
      const endPre = measureDebug("pipeline", "regex_pre");
      const pre = classifyCompiled(text, regexRules);
      endPre({ match: !!pre, tier: pre });
      if (pre && pre.includes("/") && !tiers.includes(pre)) {
        emitDebug("pipeline", "result", { source: "regex", tier: pre, direct: true });
        return { kind: "classified", tier: pre, source: "regex" };
      }
    }

    if (tiers.length === 0) return { kind: "unclassified" };

    // Stage 2: cache lookup
    const endCache = measureDebug("pipeline", "cache");
    const cached = cacheLookup(text);
    endCache({ hit: !!cached });
    if (cached && tiers.includes(cached)) {
      emitDebug("pipeline", "result", { source: "cache", tier: cached });
      return { kind: "classified", tier: cached, source: "cache" };
    }

    // Stage 3: optional direct classifier (typesafe or pi-native), then prompt fallback.
    if (classifyDirect && classificationOutcome !== "deadline" && !disableExternalForInvalidTimeout) {
      const endDirect = measureDebug("pipeline", "direct.attempt");
      let directMeasured = false;
      const finishDirect = (meta?: Record<string, unknown>): void => {
        if (directMeasured) return;
        directMeasured = true;
        endDirect(meta);
      };
      try {
        const attempt = await invokeExternal((attemptSignal) => classifyDirect(text, tiers, attemptSignal));
        if (attempt.status !== "completed") finishDirect({ outcome: attempt.status });
        if (attempt.status === "aborted") return stop("aborted");
        if (attempt.status === "deadline") markOutcome("deadline");
        const judgment = attempt.status === "completed" ? attempt.value : undefined;
        const tier = judgment?.tier;
        if (attempt.status === "completed") {
          finishDirect({ tier, backend: judgment?.backend, confidence: judgment?.confidence });
        }
        if (judgment && tiers.includes(judgment.tier)) {
          emitDebug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model, confidence: judgment.confidence });
          return { kind: "classified", tier: judgment.tier, source: "classifier", judgment };
        }
      } catch {
        finishDirect({ outcome: signal?.aborted ? "aborted" : "error" });
        emitDebug("pipeline", "direct.error", { aborted: signal?.aborted ?? false });
      }
      if (signal?.aborted) return stop("aborted");
    }

    // Existing prompt classifier — try each model in priority order.
    for (const model of disableExternalForInvalidTimeout ? [] : classifierModels) {
      if (classificationOutcome === "deadline") break;
      const endLLM = measureDebug("pipeline", "classifier.attempt");
      let llmMeasured = false;
      const finishLLM = (meta?: Record<string, unknown>): void => {
        if (llmMeasured) return;
        llmMeasured = true;
        endLLM(meta);
      };
      try {
        const attempt = await invokeExternal((attemptSignal) => classifyWithLLM(model, text, tiers, attemptSignal));
        if (attempt.status !== "completed") finishLLM({ outcome: attempt.status });
        if (attempt.status === "aborted") return stop("aborted");
        if (attempt.status === "deadline") {
          markOutcome("deadline");
          break;
        }
        if (attempt.status !== "completed") continue;
        const output = attempt.value;
        const modelId = model.kind === "registry" ? model.model.id : model.id;
        const judgment = output === undefined ? undefined : normalizeJudgment(output, CLASSIFIER_BACKEND_IDS.prompt);
        const tier = judgment?.tier;
        finishLLM({ model: modelId, tier, backend: judgment?.backend, confidence: judgment?.confidence });
        if (judgment && tiers.includes(judgment.tier)) {
          emitDebug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model ?? modelId, confidence: judgment.confidence });
          return { kind: "classified", tier: judgment.tier, source: "classifier", judgment: { ...judgment, model: judgment.model ?? modelId } };
        }
      } catch {
        finishLLM({ outcome: signal?.aborted ? "aborted" : "error" });
        emitDebug("pipeline", "classifier.error", { category: "classifier_failure" });
        console.error("[bifrost] classifier model failed");
      }
      if (signal?.aborted) return stop("aborted");
    }

    if (signal?.aborted) return stop("aborted");

    // Stage 4: regex rules
    const endRegex = measureDebug("pipeline", "regex");
    const regex = classifyCompiled(text, regexRules);
    endRegex({ match: !!regex, tier: regex });
    if (regex) {
      if (tiers.includes(regex)) {
        // Tier name match — route through strategy.
        emitDebug("pipeline", "result", { source: "regex", tier: regex });
        return withOutcome({ kind: "classified", tier: regex, source: "regex" });
      }
      if (regex.includes("/")) {
        // Direct model reference (e.g. "opencode-go/glm-5.1" in rule).
        emitDebug("pipeline", "result", { source: "regex", tier: regex, direct: true });
        return withOutcome({ kind: "classified", tier: regex, source: "regex" });
      }
    }

    // Stage 4: default fallback
    emitDebug("pipeline", "result", { source: "fallback", tier: defaultTier });
    if (defaultTier) {
      return withOutcome({ kind: "fallback", tier: defaultTier });
    }

    return withOutcome({ kind: "unclassified" });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      removeCallerAbort?.();
    }
  }

  return { classify };
}
