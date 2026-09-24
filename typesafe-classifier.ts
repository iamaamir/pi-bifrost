import { performance } from "node:perf_hooks";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ReliabilityStore } from "./reliability-store.ts";
import { debug as bifrostDebug } from "./debug.ts";
import { CONFIG_DIR_NAME } from "./host.ts";
import type { TypeSafeObservation, TypeSafeOutcome } from "./classifier-metrics.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV, TYPE_SAFE_CREDENTIAL_KEY, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL, type ClassificationJudgment } from "./classifier-backends.ts";

/** Compatibility exports for the TypeSafe provider seam and benchmark. */
export const TYPESAFE_SYSTEMONE_URL = TYPE_SAFE_ENDPOINT;
export const TYPESAFE_MODEL = TYPE_SAFE_MODEL;
export const DEFAULT_TYPESAFE_TIMEOUT_MS = 3_000;
export const DEFAULT_TYPESAFE_MAX_ATTEMPTS = 2;
const MAX_TYPESAFE_TIMEOUT_MS = 60_000;
const MAX_TYPESAFE_ATTEMPTS = 3;
export const TYPESAFE_MIN_CONFIDENCE = 0.8;

type TierCriterion = string | {
  readonly what: string;
  readonly notFor?: string;
  readonly examples?: readonly string[];
};

export interface TypeSafeInput {
  readonly prompt: string;
  readonly tiers: readonly string[];
  readonly criteria: Readonly<Record<string, TierCriterion>>;
}

export interface TypeSafeJudgment extends ClassificationJudgment {
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly backend: typeof CLASSIFIER_BACKEND_IDS.typesafe;
  readonly model: typeof TYPESAFE_MODEL;
}

export interface TypeSafeFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface TypeSafeOptions {
  readonly apiKey?: string;
  readonly fetchImpl?: TypeSafeFetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly reliability?: ReliabilityStore;
  readonly debug?: boolean;
  readonly minConfidence?: number;
  readonly observe?: (observation: TypeSafeObservation) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function criterionText(value: TierCriterion): string {
  if (typeof value === "string") return value;
  return [value.what, value.notFor ? `Not for: ${value.notFor}` : "", value.examples?.length ? `Examples: ${value.examples.join(", ")}` : ""]
    .filter(Boolean).join(" ");
}

export function buildTypeSafeRequest(input: TypeSafeInput): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const tier of input.tiers) criteria[tier] = criterionText(input.criteria[tier] ?? tier);
  return {
    state: input.prompt,
    model: TYPESAFE_MODEL,
    questions: {
      tier: {
        type: "choice",
        instructions: "Which model tier best fits this coding-agent request? Judge task complexity and consequence, not stated preference or price.",
        criteria,
      },
    },
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function strictRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    for (const key of required) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    for (const key of ownKeys) {
      const descriptor = descriptors[key as string];
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Decode only provider data needed for routing. Invalid data is a classifier miss. */
export function decodeTypeSafeJudgment(payload: unknown, tiers: readonly string[], minConfidence = TYPESAFE_MIN_CONFIDENCE): TypeSafeJudgment | undefined {
  const body = strictRecord(payload, ["model", "answers"], ["usage"]);
  if (!body || body.model !== TYPESAFE_MODEL) return undefined;
  const answers = strictRecord(body.answers, ["tier"]);
  if (!answers) return undefined;
  const value = strictRecord(answers.tier, ["type", "choice", "confidence", "probabilities"]);
  if (!value || value.type !== "choice" || typeof value.choice !== "string" || !tiers.includes(value.choice)) return undefined;
  if (!finite(value.confidence) || value.confidence < minConfidence || value.confidence > 1) return undefined;
  const raw = strictRecord(value.probabilities, tiers);
  if (!raw) return undefined;
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
  if (Math.abs(probabilities[value.choice] - max) > 1e-9) return undefined;
  return { tier: value.choice, confidence: value.confidence, probabilities, backend: CLASSIFIER_BACKEND_IDS.typesafe, model: TYPESAFE_MODEL };
}

function retryable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status === 529;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function abortableDelay(
  ms: number,
  delay: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = (continued: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(continued);
    };
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    delay(ms).then(() => finish(true), (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
  if (!response?.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch {
    // Cleanup failure must not replace classifier outcome.
  }
}

async function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAborted: (reason?: unknown) => void = () => {};
  const abort = () => rejectAborted(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      chunks.push(result.value);
      total += result.value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* cleanup only */ }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type TypeSafeCredentialSource = "auth-file" | "environment" | "missing";

function resolveCredentialKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const match = value.match(/^\$\{?([A-Z][A-Z0-9_]*)\}?$/);
  if (match) return process.env[match[1]];
  return value;
}

export function resolveTypeSafeApiKey(): { apiKey?: string; source: TypeSafeCredentialSource } {
  try {
    const credential = readStoredCredential(TYPE_SAFE_CREDENTIAL_KEY);
    if (credential && credential.type === "api_key") {
      const key = resolveCredentialKey(credential.key);
      if (key) return { apiKey: key, source: "auth-file" };
    }
  } catch {
    console.error("[bifrost] failed to read TypeSafe credential");
  }
  const apiKey = process.env[TYPE_SAFE_API_KEY_ENV];
  return apiKey ? { apiKey, source: "environment" } : { source: "missing" };
}

function circuitKey(): string { return `classifier/${CLASSIFIER_BACKEND_IDS.typesafe}/${TYPESAFE_MODEL}`; }

/** Thin System One adapter. Returns misses for all transport/decoder failures. */
export function createTypeSafeClassifier(options: TypeSafeOptions = {}) {
  const apiKey = options.apiKey ?? resolveTypeSafeApiKey().apiKey;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const timeoutMs = Math.min(MAX_TYPESAFE_TIMEOUT_MS, Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_TYPESAFE_TIMEOUT_MS)));
  const maxAttempts = Math.min(MAX_TYPESAFE_ATTEMPTS, Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_TYPESAFE_MAX_ATTEMPTS)));
  let warnedMissingKey = false;

  return async function classify(input: TypeSafeInput, signal?: AbortSignal): Promise<TypeSafeJudgment | undefined> {
    const activeSignal = signal ?? options.signal;
    const startedAt = performance.now();
    const traceId = `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const trace = (event: string, meta: Record<string, unknown> = {}) => {
      if (options.debug) bifrostDebug(CLASSIFIER_BACKEND_IDS.typesafe, event, { trace_id: traceId, model: TYPESAFE_MODEL, ...meta });
    };
    trace("start", { tiers: input.tiers, prompt_length: input.prompt.length, timeout_ms: timeoutMs, max_attempts: maxAttempts });
    let attempts = 0;
    let observed = false;
    let trialClaimed = false;
    const finish = (outcome: TypeSafeOutcome, judgment?: TypeSafeJudgment): TypeSafeJudgment | undefined => {
      if (outcome === "aborted" && trialClaimed) {
        options.reliability?.abandonTrial(circuitKey());
        trialClaimed = false;
      }
      trace("finish", {
        outcome,
        attempts,
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
            tier: judgment?.tier,
            confidence: judgment?.confidence,
          });
        } catch {
          console.error("[bifrost] TypeSafe observation failed");
        }
      }
      return judgment;
    };
    if (!apiKey) {
      trace("credential_missing");
      if (!warnedMissingKey) { warnedMissingKey = true; console.error(`[bifrost] TypeSafe classifier disabled: configure ~/${CONFIG_DIR_NAME}/agent/auth.json or ${TYPE_SAFE_API_KEY_ENV}`); }
      return finish("missing_key");
    }
    const key = circuitKey();
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
    const deadline = performance.now() + timeoutMs;
    let failure: TypeSafeOutcome = "network";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (activeSignal?.aborted) return finish("aborted");
      attempts = attempt;
      const remaining = deadline - performance.now();
      trace("attempt", { attempt, remaining_ms: Math.max(0, Math.round(remaining)) });
      if (remaining <= 0) { failure = "timeout"; break; }

      const controller = new AbortController();
      const abort = () => controller.abort(new DOMException("Aborted", "AbortError"));
      activeSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), remaining);
      let response: Response | undefined;
      let phase: "fetch" | "body" = "fetch";
      let shouldRetry = false;
      let delay = 0;
      try {
        trace("request", { attempt, endpoint: TYPESAFE_SYSTEMONE_URL });
        response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildTypeSafeRequest(input)),
          signal: controller.signal,
          redirect: "error",
        });
        trace("response", { attempt, status: response.status, ok: response.ok });

        if (response.ok) {
          phase = "body";
          const body = await readResponseJson(response, controller.signal);
          const judgment = decodeTypeSafeJudgment(body, input.tiers, 0);
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
          trace("success", { tier: judgment.tier, confidence: judgment.confidence, attempts });
          return finish("success", judgment);
        }

        const status = response.status;
        trace("http_failure", { attempt, status, retryable: retryable(status) });
        if (status === 401 || status === 403) {
          recordFailure("auth");
          return finish("auth");
        }
        if (!retryable(status)) {
          recordFailure("http");
          return finish("http");
        }
        failure = status === 429 || status === 529 ? "rate_limited" : failure;
        shouldRetry = true;
        delay = retryAfterMs(response) ?? 100 * (2 ** (attempt - 1));
      } catch {
        const callerAborted = activeSignal?.aborted ?? false;
        const timedOut = controller.signal.aborted && !callerAborted;
        trace(phase === "fetch" ? "transport_error" : "decode_error", {
          attempt,
          category: callerAborted ? "aborted" : timedOut ? "timeout" : phase === "body" ? "invalid_response" : "network",
        });
        if (callerAborted) return finish("aborted");
        if (timedOut) {
          recordFailure("timeout");
          return finish("timeout");
        }
        if (phase === "body") {
          recordFailure("decoder");
          return finish("invalid_response");
        }
        failure = "network";
        shouldRetry = true;
      } finally {
        clearTimeout(timer);
        activeSignal?.removeEventListener("abort", abort);
        await cancelResponseBody(response);
      }

      if (!shouldRetry || attempt === maxAttempts) break;
      trace("retry_wait", { attempt, delay_ms: delay });
      if (delay >= deadline - performance.now()) { failure = "timeout"; break; }
      if (!await abortableDelay(delay, sleepImpl, activeSignal)) return finish("aborted");
    }
    recordFailure(failure);
    trace("failure", { outcome: failure, attempts });
    return finish(failure);
  };
}
