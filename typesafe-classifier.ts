import { performance } from "node:perf_hooks";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ReliabilityStore } from "./reliability-store.ts";
import { debug as bifrostDebug } from "./debug.ts";
import type { TypeSafeObservation, TypeSafeOutcome } from "./classifier-metrics.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV, TYPE_SAFE_CREDENTIAL_KEY, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL } from "./classifier-backends.ts";

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

export interface TypeSafeJudgment {
  readonly tier: string;
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return new Promise((resolve) => setTimeout(() => resolve(true), ms));
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(false); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function readJsonWithinDeadline(response: Response, deadline: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const remaining = Math.max(0, deadline - performance.now());
    const timer = setTimeout(() => finishReject(new Error("timeout")), remaining);
    const abort = () => finishReject(new Error("aborted"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finishResolve = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    response.json().then(finishResolve, finishReject);
  });
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
  } catch (error) {
    console.error(`[bifrost] failed to read TypeSafe credential: ${error}`);
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
    const finish = (outcome: TypeSafeOutcome, judgment?: TypeSafeJudgment): TypeSafeJudgment | undefined => {
      trace("finish", {
        outcome,
        attempts,
        tier: judgment?.tier,
        confidence: judgment?.confidence,
        probabilities: judgment?.probabilities,
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
        } catch (error) {
          console.error(`[bifrost] TypeSafe observation failed: ${error}`);
        }
      }
      return judgment;
    };
    if (!apiKey) {
      trace("credential_missing");
      if (!warnedMissingKey) { warnedMissingKey = true; console.error(`[bifrost] TypeSafe classifier disabled: configure ~/.pi/agent/auth.json or ${TYPE_SAFE_API_KEY_ENV}`); }
      return finish("missing_key");
    }
    const key = circuitKey();
    const now = Date.now();
    if (options.reliability && !options.reliability.tryBeginTrial(key, now)) {
      trace("circuit_open");
      return finish("circuit_open");
    }

    const deadline = performance.now() + timeoutMs;
    let failure: TypeSafeOutcome = "network";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (activeSignal?.aborted) return finish("aborted");
      attempts = attempt;
      const remaining = deadline - performance.now();
      trace("attempt", { attempt, remaining_ms: Math.max(0, Math.round(remaining)) });
      if (remaining <= 0) { failure = "timeout"; break; }
      const controller = new AbortController();
      const abort = () => controller.abort();
      activeSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), remaining);
      let response: Response | undefined;
      try {
        trace("request", { attempt, endpoint: TYPESAFE_SYSTEMONE_URL, body: buildTypeSafeRequest(input) });
        response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildTypeSafeRequest(input)),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        trace("transport_error", { attempt, error: error instanceof Error ? error.message : String(error), aborted: controller.signal.aborted });
        if (activeSignal?.aborted) return finish("aborted");
        failure = controller.signal.aborted ? "timeout" : "network";
      } finally {
        clearTimeout(timer);
        trace("response", { attempt, status: response?.status, ok: response?.ok });
        activeSignal?.removeEventListener("abort", abort);
      }
      if (response?.ok) {
        try {
          const body = await readJsonWithinDeadline(response!, deadline, activeSignal);
          trace("body", { attempt, payload: body });
          const judgment = decodeTypeSafeJudgment(body, input.tiers, 0);
          trace("decoded", { attempt, tier: judgment?.tier, confidence: judgment?.confidence, probabilities: judgment?.probabilities, valid: Boolean(judgment) });
          if (!judgment) {
            options.reliability?.recordFailure(key, "classifier", "decoder");
            return finish("invalid_response");
          }
          options.reliability?.recordSuccess(key, "classifier");
          if (judgment.confidence < (options.minConfidence ?? TYPESAFE_MIN_CONFIDENCE)) {
            trace("low_confidence", { confidence: judgment.confidence, min_confidence: options.minConfidence ?? TYPESAFE_MIN_CONFIDENCE });
            finish("low_confidence", judgment);
            return undefined;
          }
          trace("success", { tier: judgment.tier, confidence: judgment.confidence, probabilities: judgment.probabilities, attempts });
          return finish("success", judgment);
        } catch (error) {
          trace("decode_error", { attempt, error: error instanceof Error ? error.message : String(error) });
          if (activeSignal?.aborted) return finish("aborted");
          const timedOut = error instanceof Error && error.message === "timeout";
          options.reliability?.recordFailure(key, "classifier", timedOut ? "timeout" : "decoder");
          return finish(timedOut ? "timeout" : "invalid_response");
        }
      }
      const status = response?.status;
      trace("http_failure", { attempt, status, retryable: retryable(status) });
      if (status === 401 || status === 403) {
        options.reliability?.recordFailure(key, "classifier", "auth");
        return finish("auth");
      }
      if (!retryable(status)) {
        options.reliability?.recordFailure(key, "classifier", "http");
        return finish("http");
      }
      failure = status === 429 || status === 529 ? "rate_limited" : failure;
      if (attempt === maxAttempts) break;
      const delay = (response ? retryAfterMs(response) : undefined) ?? 100 * (2 ** (attempt - 1));
      trace("retry_wait", { attempt, delay_ms: delay });
      if (delay >= deadline - performance.now()) { failure = "timeout"; break; }
      const continued = sleepImpl === sleep
        ? await abortableDelay(delay, activeSignal)
        : await Promise.race([
            sleepImpl(delay).then(() => true),
            new Promise<boolean>((resolve) => activeSignal?.addEventListener("abort", () => resolve(false), { once: true })),
          ]);
      if (!continued) return finish("aborted");
    }
    options.reliability?.recordFailure(key, "classifier", failure);
    trace("failure", { outcome: failure, attempts });
    return finish(failure);
  };
}
