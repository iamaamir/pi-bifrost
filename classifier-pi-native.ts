import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { AuthOperationOptions, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import type { ReliabilityStore } from "./reliability-store.ts";
import { debug as bifrostDebug } from "./debug.ts";
import type { TypeSafeObservation, TypeSafeOutcome } from "./classifier-metrics.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV, type ClassificationJudgment, type ClassifierRequest } from "./classifier-backends.ts";
import { abortableDelay, criterionText, finite, sleep } from "./classifier-semantics.ts";
import { TYPESAFE_MIN_CONFIDENCE } from "./typesafe-classifier.ts";

/**
 * Pi-native classifier transport (ADR 0020). Wraps Pi's own classify() in
 * Bifrost deadline, retry, minConfidence, reliability, and metrics policy.
 * classify() is single-attempt and accepts neither timeoutMs nor maxAttempts,
 * so those stay policy fields here and never enter its options.
 */
export const DEFAULT_PI_NATIVE_TIMEOUT_MS = 3_000;
export const DEFAULT_PI_NATIVE_MAX_ATTEMPTS = 2;
const MAX_PI_NATIVE_TIMEOUT_MS = 60_000;
const MAX_PI_NATIVE_ATTEMPTS = 3;

export interface PiNativeJudgment extends ClassificationJudgment {
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly backend: typeof CLASSIFIER_BACKEND_IDS.piNative;
  readonly model: string;
}

/** Registry surface the transport needs. `ctx.modelRegistry` satisfies it. */
export interface PiClassifierRegistry {
  getModelOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
  getAvailableOfType(type: "classifier", provider?: string, options?: AuthOperationOptions): Promise<readonly ClassifierModel<ClassifierApi>[]>;
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
}

/** Feature-detect host classification support. Structural only — no host-name checks. */
export function piClassificationSupported(registry: unknown): boolean {
  const candidate = registry as Partial<PiClassifierRegistry> | undefined;
  return typeof candidate?.classify === "function" && typeof candidate?.getAvailableOfType === "function";
}

export interface PiNativeOptions {
  readonly registry: PiClassifierRegistry;
  /** classifier.piNative.model in provider/id form. Absent resolves from Pi's catalog. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly minConfidence?: number;
  readonly reliability?: ReliabilityStore;
  readonly debug?: boolean;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  /** True when no TypeSafe credential resolves. Selects the empty-catalog error text. */
  readonly credentialMissing?: () => boolean;
  readonly observe?: (observation: TypeSafeObservation) => void;
}

type ResolvedClassifierModel = { readonly model: ClassifierModel<ClassifierApi>; readonly id: string };
type ModelResolution = ResolvedClassifierModel | "missing_credential" | "missing_catalog";

function catalogError(cause: "missing_credential" | "missing_catalog"): string {
  return cause === "missing_credential"
    ? `no TypeSafe credential; run /login or set ${TYPE_SAFE_API_KEY_ENV}`
    : "no classifier model in Pi's catalog; refresh the catalog and check the enabledModels filter in settings.json";
}

async function resolveClassifierModel(options: PiNativeOptions, signal: AbortSignal): Promise<ModelResolution> {
  const cause = (): "missing_credential" | "missing_catalog" => (options.credentialMissing?.() ? "missing_credential" : "missing_catalog");
  const configured = options.model;
  if (configured) {
    const slash = configured.indexOf("/");
    const model = slash > 0 && slash < configured.length - 1
      ? options.registry.getModelOfType("classifier", configured.slice(0, slash), configured.slice(slash + 1))
      : undefined;
    return model ? { model, id: configured } : cause();
  }
  const [first] = await options.registry.getAvailableOfType("classifier", "typesafe", { signal });
  return first ? { model: first, id: `${first.provider}/${first.id}` } : cause();
}

function abortableResult<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    // Always attach rejection handling, even if the registry aborted synchronously.
    if (signal.aborted) abort();
  });
}

function buildContext(request: ClassifierRequest): ClassifierContext {
  const criteria: Record<string, string> = {};
  for (const tier of request.tiers) criteria[tier] = criterionText(request.criteria[tier] ?? tier);
  return {
    state: { prompt: request.prompt },
    questions: {
      tier: {
        type: "choice",
        instructions: "Which model tier best fits this coding-agent request? Judge task complexity and consequence, not stated preference or price.",
        criteria,
      },
    },
  };
}

/**
 * Pi exposes only errorMessage, not structured HTTP status or headers.
 * Recognize transient errors conservatively; unknown errors stop, not retry.
 */
const NON_RETRYABLE_QUOTA = /insufficient[_ ]quota|out of budget|quota exceeded|billing|monthly usage limit|available balance|GoUsageLimitError|FreeUsageLimitError|subscription_sharing_usage_limit_exceeded/i;
const AUTH_ERROR = /\b(?:401|403)\b|unauthorized|forbidden|invalid[_ -]?(?:api[_ -]?)?key|authentication|login required/i;
const RATE_LIMIT = /\b(?:429|529)\b|rate.?limit/i;
const TERMINAL_HTTP = /\b4\d\d\b|bad request|invalid[_ -]?request|validation failed/i;
const TRANSIENT_ERROR = /\b(?:408|500|502|503|504)\b|timeout|timed out|temporar|overload|network|connection|socket|fetch failed|econnreset|econnrefused|enotfound/i;

function errorPolicy(message: string | undefined, thrown: boolean): { outcome: TypeSafeOutcome; retry: boolean; quota?: boolean } {
  if (NON_RETRYABLE_QUOTA.test(message ?? "")) return { outcome: RATE_LIMIT.test(message ?? "") ? "rate_limited" : "http", retry: false, quota: true };
  if (AUTH_ERROR.test(message ?? "")) return { outcome: "auth", retry: false };
  if (RATE_LIMIT.test(message ?? "")) return { outcome: "rate_limited", retry: true };
  if (TERMINAL_HTTP.test(message ?? "") && !/\b408\b/.test(message ?? "")) return { outcome: "http", retry: false };
  if (TRANSIENT_ERROR.test(message ?? "") || thrown) return { outcome: "network", retry: true };
  return { outcome: "http", retry: false };
}

/** Decode only provider data needed for routing. Invalid data is a classifier miss. */
export function decodePiNativeJudgment(result: ClassifierResult, tiers: readonly string[], minConfidence = 0, resolvedId?: string): PiNativeJudgment | undefined {
  const answer = result.answers?.tier;
  if (!answer || answer.type !== "choice") return undefined;
  if (typeof answer.choice !== "string" || !tiers.includes(answer.choice)) return undefined;
  if (!finite(answer.confidence) || answer.confidence < minConfidence || answer.confidence > 1) return undefined;
  const raw = answer.probabilities;
  if (!raw || typeof raw !== "object") return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== tiers.length || tiers.some((tier) => !Object.prototype.hasOwnProperty.call(raw, tier)) || keys.some((key) => !tiers.includes(key))) return undefined;
  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const tier of tiers) {
    const probability = raw[tier];
    if (!finite(probability) || probability < 0 || probability > 1) return undefined;
    probabilities[tier] = probability;
    sum += probability;
  }
  if (Math.abs(sum - 1) > 0.001) return undefined;
  const max = Math.max(...tiers.map((tier) => probabilities[tier]));
  if (Math.abs(probabilities[answer.choice] - max) > 1e-9) return undefined;
  return {
    tier: answer.choice,
    confidence: answer.confidence,
    probabilities,
    backend: CLASSIFIER_BACKEND_IDS.piNative,
    model: resolvedId ?? `${result.provider}/${result.model}`,
  };
}

export function createPiNativeClassifier(options: PiNativeOptions) {
  const timeoutMs = Math.min(MAX_PI_NATIVE_TIMEOUT_MS, Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_PI_NATIVE_TIMEOUT_MS)));
  const maxAttempts = Math.min(MAX_PI_NATIVE_ATTEMPTS, Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_PI_NATIVE_MAX_ATTEMPTS)));
  const sleepImpl = options.sleepImpl ?? sleep;
  let warnedMissingModel = false;

  return async function classifyWithPi(
    request: ClassifierRequest,
    signal?: AbortSignal,
    onObservation?: (observation: TypeSafeObservation) => void,
  ): Promise<PiNativeJudgment | undefined> {
    const startedAt = performance.now();
    const deadline = startedAt + timeoutMs;
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    const traceId = randomUUID();
    const trace = (event: string, meta: Record<string, unknown> = {}) => {
      if (options.debug) bifrostDebug(CLASSIFIER_BACKEND_IDS.piNative, event, { trace_id: traceId, model: options.model, ...meta });
    };
    trace("start", { tiers: request.tiers, prompt_length: request.prompt.length, timeout_ms: timeoutMs, max_attempts: maxAttempts });
    let attempts = 0;
    let observed = false;
    let trialClaimed = false;
    let key = "";
    let resolvedModelId: string | undefined;
    const finish = (outcome: TypeSafeOutcome, judgment?: PiNativeJudgment): PiNativeJudgment | undefined => {
      if (outcome === "aborted" && trialClaimed) {
        options.reliability?.abandonTrial(key);
        trialClaimed = false;
      }
      trace("finish", {
        outcome,
        attempts,
        model: judgment?.model ?? resolvedModelId,
        tier: judgment?.tier,
        confidence: judgment?.confidence,
        elapsed_ms: Math.round(performance.now() - startedAt),
      });
      if (!observed) {
        observed = true;
        const observation: TypeSafeObservation = Object.freeze({
          outcome,
          latencyMs: performance.now() - startedAt,
          attempts,
          model: judgment?.model ?? resolvedModelId,
          tier: judgment?.tier,
          confidence: judgment?.confidence,
        });
        try {
          options.observe?.(observation);
        } catch {
          console.error("[bifrost] pi-native observation failed");
        }
        try {
          onObservation?.(observation);
        } catch {
          // Per-call observers are advisory and must not change classification.
        }
      }
      return judgment;
    };

    try {
      if (!piClassificationSupported(options.registry)) return finish("unsupported");
      if (signal?.aborted) return finish("aborted");
      let resolved: ModelResolution;
      try {
        resolved = await abortableResult(resolveClassifierModel(options, controller.signal), controller.signal);
      } catch {
        if (signal?.aborted) return finish("aborted");
        if (controller.signal.aborted) return finish("timeout");
        trace("discovery_error", { outcome: "network" });
        return finish("network");
      }
      if (typeof resolved === "string") {
        if (!warnedMissingModel) {
          warnedMissingModel = true;
          console.error(`[bifrost] pi-native classifier disabled: ${catalogError(resolved)}`);
        }
        trace("model_missing", { cause: resolved });
        return finish(resolved === "missing_credential" ? "missing_key" : "missing_catalog");
      }
      resolvedModelId = resolved.id;
      key = `classifier/${CLASSIFIER_BACKEND_IDS.piNative}/${resolved.id}`;
      if (options.reliability) {
        const claim = options.reliability.tryClaimTrial(key);
        if (!claim.allowed) {
          trace("circuit_open");
          return finish("circuit_open");
        }
        trialClaimed = claim.claimed;
      }

      const recordFailure = (reason: string) => {
        options.reliability?.recordFailure(key, "classifier", reason);
        trialClaimed = false;
      };
      const recordSuccess = () => {
        options.reliability?.recordSuccess(key, "classifier");
        trialClaimed = false;
      };

      const context = buildContext(request);
      let failure: TypeSafeOutcome = "network";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) return finish("aborted");
        attempts = attempt;
        const remaining = deadline - performance.now();
        trace("attempt", { attempt, model: resolved.id, remaining_ms: Math.max(0, Math.round(remaining)) });
        if (remaining <= 0) { failure = "timeout"; break; }

        let result: ClassifierResult | undefined;
        try {
          result = await abortableResult(options.registry.classify(resolved.model, context, { signal: controller.signal }), controller.signal);
        } catch {
          if (signal?.aborted) return finish("aborted");
          if (controller.signal.aborted) {
            recordFailure("timeout");
            return finish("timeout");
          }
          // Defensive: classify() never rejects. A thrown error is a transport miss.
          result = undefined;
        }
        if (signal?.aborted) return finish("aborted");
        if (controller.signal.aborted) {
          recordFailure("timeout");
          return finish("timeout");
        }

        if (result?.stopReason === "aborted") {
          trace("aborted", { attempt });
          return finish("aborted");
        }
        if (result?.stopReason === "stop") {
          const judgment = decodePiNativeJudgment(result, request.tiers, 0, resolved.id);
          trace("decoded", { attempt, tier: judgment?.tier, confidence: judgment?.confidence, valid: Boolean(judgment) });
          if (!judgment) {
            recordFailure("decoder");
            return finish("invalid_response");
          }
          recordSuccess();
          if (judgment.confidence < (options.minConfidence ?? TYPESAFE_MIN_CONFIDENCE)) {
            trace("low_confidence", { confidence: judgment.confidence, min_confidence: options.minConfidence ?? TYPESAFE_MIN_CONFIDENCE });
            finish("low_confidence", judgment);
            return undefined;
          }
          trace("success", { tier: judgment.tier, confidence: judgment.confidence, attempts, model: judgment.model });
          return finish("success", judgment);
        }

        const policy = errorPolicy(result?.errorMessage, !result);
        failure = policy.outcome;
        trace("error", { attempt, stop_reason: result?.stopReason, outcome: failure, retryable: policy.retry });
        if (!policy.retry) {
          if (failure === "auth") {
            // New credentials can make the next attempt succeed; do not poison a circuit.
            if (trialClaimed) options.reliability?.abandonTrial(key);
            trialClaimed = false;
          } else {
            recordFailure(policy.quota ? "quota" : failure);
          }
          return finish(failure);
        }
        if (attempt < maxAttempts) {
          const delay = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
          if (delay >= deadline - performance.now()) {
            recordFailure("timeout");
            return finish("timeout");
          }
          const continued = await abortableDelay(delay, sleepImpl, controller.signal);
          if (!continued) {
            if (signal?.aborted) return finish("aborted");
            recordFailure("timeout");
            return finish("timeout");
          }
        }
      }
      recordFailure(failure);
      return finish(failure);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}
