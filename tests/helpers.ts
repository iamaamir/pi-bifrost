// ── Shared test helpers ──────────────────────────────────────────
// Centralizes model/context construction so test files don't each
// redefine `makeModel`/`makeCtx` with their own `as unknown as` casts.
// The casts that remain (Model<Api>, ExtensionContext) are contained
// here because those interfaces require fields the tests don't use.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierModel } from "../classifier.ts";

/**
 * Build a minimal OpenAI-compatible model for tests.
 * Positional args match the pre-existing call sites.
 * Defaults: zero cost, 128k context, text-only input.
 */
export function makeModel(
  provider: string,
  id: string,
  inputCost = 0,
  outputCost = 0,
  contextWindow = 128000,
): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
  };
}

function makeRegistry(models: Model<Api>[]) {
  return {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => models,
  };
}

/**
 * Build a minimal ExtensionContext with only `modelRegistry` populated.
 * Other ExtensionContext fields are left undefined — routing functions
 * in tests only touch `modelRegistry`.
 */
export function makeCtx(models: Model<Api>[]): ExtensionContext {
  return { modelRegistry: makeRegistry(models) } as unknown as ExtensionContext;
}

/**
 * Build a registry-based ClassifierModel wrapping a minimal model.
 * Used by pipeline tests.
 */
export function makeClassifierModel(provider: string, id: string): ClassifierModel {
  return { kind: "registry", model: makeModel(provider, id) };
}

/**
 * Strip the cost field from a model — for testing graceful handling
 * of models with missing cost metadata. Replaces the previous
 * `(m as any).cost = undefined` pattern with a typed helper.
 */
export function withoutCost<T extends Model<Api>>(model: T): T {
  const copy = { ...model };
  (copy as Partial<Model<Api>>).cost = undefined as unknown as Model<Api>["cost"];
  return copy;
}
