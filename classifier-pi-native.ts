import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import type { ReliabilityStore } from "./reliability-store.ts";
import { debug as bifrostDebug } from "./debug.ts";
import type { TypeSafeObservation, TypeSafeOutcome } from "./classifier-metrics.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV, type ClassificationJudgment, type ClassifierRequest, type ClassifierTransport } from "./classifier-backends.ts";
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
  getAvailableOfType(type: "classifier", provider?: string): Promise<readonly ClassifierModel<ClassifierApi>[]>;
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
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

async function resolveClassifierModel(options: PiNativeOptions): Promise<ModelResolution> {
  const cause = (): "missing_credential" | "missing_catalog" => (options.credentialMissing?.() ? "missing_credential" : "missing_catalog");
  const configured = options.model;
  if (configured) {
    const slash = configured.indexOf("/");
    const model = slash > 0 && slash < configured.length - 1
      ? options.registry.getModelOfType("classifier", configured.slice(0, slash), configured.slice(slash + 1))
      : undefined;
    return model ? { model, id: configured } : cause();
  }
  const [first] = await options.registry.getAvailableOfType("classifier", "typesafe");
  return first ? { model: first, id: `${first.provider}/${first.id}` } : cause();
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
 * classify() exposes failures only through stopReason and errorMessage, with no
 * status codes. Retry every error except the known non-retryable quota taxonomy
 * (pi-ai utils/retry.js), which covers the 429/529/network retry policy.
 */
const NON_RETRYABLE_QUOTA = /insufficient[_ ]quota|out of budget|quota exceeded|billing|monthly usage limit|available balance/i;

function errorOutcome(message: string | undefined): TypeSafeOutcome {
  if (message && /429|529|rate.?limit/i.test(message)) return "rate_limited";
  if (message && /401|403|unauthorized|forbidden/i.test(message)) return "auth";
  return "network";
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

export function createPiNativeClassifier(options: PiNativeOptions): ClassifierTransport {
  const timeoutMs = Math.min(MAX_PI_NATIVE_TIMEOUT_MS, Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_PI_NATIVE_TIMEOUT_MS)));
  const maxAttempts = Math.min(MAX_PI_NATIVE_ATTEMPTS, Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_PI_NATIVE_MAX_ATTEMPTS)));
  const sleepImpl = options.sleepImpl ?? sleep;
  let warnedMissingModel = false;

  return async function classifyWithPi(request: ClassifierRequest, signal?: AbortSignal): Promise<PiNativeJudgment | undefined> {
    const startedAt = performance.now();
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
        try {
          options.observe?.({
            outcome,
            latencyMs: performance.now() - startedAt,
            attempts,
            model: judgment?.model ?? resolvedModelId,
            tier: judgment?.tier,
            confidence: judgment?.confidence,
          });
        } catch {
          console.error("[bifrost] pi-native observation failed");
        }
      }
      return judgment;
    };

    const resolved = await resolveClassifierModel(options);
    if (typeof resolved === "string") {
      if (!warnedMissingModel) {
        warnedMissingModel = true;
        console.error(`[bifrost] pi-native classifier disabled: ${catalogError(resolved)}`);
      }
      trace("model_missing", { cause: resolved });
      return finish("missing_key");
    }
    resolvedModelId = resolved.id;
    key = `classifier/${CLASSIFIER_BACKEND_IDS.piNative}/${resolved.id}`;
    const now = Date.now();
    if (options.reliability) {
      const claim = options.reliability.tryClaimTrial(key, now);
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
    const deadline = performance.now() + timeoutMs;
    let failure: TypeSafeOutcome = "network";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) return finish("aborted");
      attempts = attempt;
      const remaining = deadline - performance.now();
      trace("attempt", { attempt, model: resolved.id, remaining_ms: Math.max(0, Math.round(remaining)) });
      if (remaining <= 0) { failure = "timeout"; break; }

      const controller = new AbortController();
      const abort = () => controller.abort(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), remaining);
      let result: ClassifierResult | undefined;
      try {
        result = await options.registry.classify(resolved.model, context, { signal: controller.signal });
      } catch {
        // Defensive: classify() never rejects. A thrown error is a transport miss.
        result = undefined;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      if (signal?.aborted) return finish("aborted");

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

      const message = result?.errorMessage;
      failure = errorOutcome(message);
      trace("error", { attempt, stop_reason: result?.stopReason, message });
      if (NON_RETRYABLE_QUOTA.test(message ?? "")) {
        recordFailure("quota");
        return finish(failure);
      }
      if (attempt < maxAttempts) {
        const continued = await abortableDelay(Math.min(1_000 * 2 ** (attempt - 1), 30_000), sleepImpl, signal);
        if (!continued) return finish("aborted");
      }
    }
    recordFailure(failure);
    return finish(failure);
  };
}
