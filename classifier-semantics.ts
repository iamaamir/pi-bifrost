import { createHash } from "node:crypto";
import type { BifrostConfig } from "./config.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_MODEL } from "./classifier-backends.ts";

const CLASSIFIER_INSTRUCTION_VERSION = 1;

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
}

export function classifierCacheKey(
  config: BifrostConfig,
  tiers: readonly string[],
  runtime: ClassifierRuntimeSemantics = {},
): string {
  const classifier = config.classifier;
  const semantics = JSON.stringify(stableValue({
    instructionVersion: CLASSIFIER_INSTRUCTION_VERSION,
    backend: classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt,
    model: classifier?.model,
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
