import { createHash } from "node:crypto";
import type { BifrostConfig } from "./config.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_MODEL, type ClassifierBackend, type TierCriterion } from "./classifier-backends.ts";

const CLASSIFIER_INSTRUCTION_VERSION = 1;

/** Bound what classifiers see (matches Pi's jev-router example: slice(0, 16_000)). */
export const CLASSIFIER_PROMPT_MAX_CHARS = 16_000;

export function boundedClassifierPrompt(text: string, maxChars = CLASSIFIER_PROMPT_MAX_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/** Flatten one criterion into the plain text a choice question carries. */
export function criterionText(value: TierCriterion): string {
  if (typeof value === "string") return value;
  return [value.what, value.notFor ? `Not for: ${value.notFor}` : "", value.examples?.length ? `Examples: ${value.examples.join(", ")}` : ""]
    .filter(Boolean).join(" ");
}

/** Shared direct-transport helpers (typesafe, pi-native). */
export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function abortableDelay(
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export interface ClassifierRuntimeSemantics {
  readonly typesafeCredentialAvailable?: boolean;
  /** Detection-resolved backend. A cached decision must never be tagged with a backend that did not produce it (fix 1). */
  readonly effectiveBackend?: ClassifierBackend;
  /** Optional resolved id for callers with one. Normal routing keys on configured id before discovery. */
  readonly piNativeModel?: string;
}

export function classifierCacheKey(
  config: BifrostConfig,
  tiers: readonly string[],
  runtime: ClassifierRuntimeSemantics = {},
): string {
  const classifier = config.classifier;
  const semantics = JSON.stringify(stableValue({
    instructionVersion: CLASSIFIER_INSTRUCTION_VERSION,
    backend: runtime.effectiveBackend ?? classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt,
    model: classifier?.model,
    piNativeModel: runtime.piNativeModel ?? classifier?.piNative?.model,
    endpoint: classifier?.endpoint,
    method: classifier?.method,
    systemPrompt: classifier?.systemPrompt,
    maxTokens: classifier?.maxTokens,
    temperature: classifier?.temperature,
    fallbackToRegex: classifier?.fallbackToRegex,
    typesafeModel: classifier?.typesafe?.model ?? TYPE_SAFE_MODEL,
    criteria: classifier?.criteria,
    minConfidence: classifier?.minConfidence ?? 0.8,
    fallback: classifier?.fallback,
    typesafeCredentialAvailable: runtime.typesafeCredentialAvailable ?? false,
    tiers,
  }));
  return createHash("sha256").update(semantics).digest("hex");
}
