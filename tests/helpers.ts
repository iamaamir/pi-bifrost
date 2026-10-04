// ── Shared test helpers ──────────────────────────────────────────
// Centralizes model/context construction so test files don't each
// redefine `makeModel`/`makeCtx` with their own `as unknown as` casts.
// The casts that remain (Model<Api>, ExtensionContext) are contained
// here because those interfaces require fields the tests don't use.

import type { Api, AssistantMessage, Model, ClassifierApi, ClassifierContext, ClassifierModel as PiClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierModel } from "../classifier.ts";

/** Build a typed failed assistant message for `ModelRouteRequest["failed"]` fixtures. */
export function errorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture/model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
    ...overrides,
  };
}

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

export function makePiClassifierModel(provider: string, id: string): PiClassifierModel<ClassifierApi> {
  return {
    type: "classifier",
    provider,
    id,
    name: id,
    api: "systemone",
    baseUrl: "http://localhost:1234/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
  };
}

export interface FakeRegistryOptions {
  readonly classifierModels?: readonly PiClassifierModel<ClassifierApi>[];
  readonly availableClassifierModels?: readonly PiClassifierModel<ClassifierApi>[];
  readonly authSource?: string;
  readonly classify?: (model: PiClassifierModel<ClassifierApi>, context: ClassifierContext) => ClassifierResult;
}

export function makeRegistry(models: Model<Api>[], options: FakeRegistryOptions = {}) {
  const classifiers = options.classifierModels ?? [];
  const available = options.availableClassifierModels ?? classifiers;
  const ofType = (provider?: string) => classifiers.filter((model) => !provider || model.provider === provider);
  return {
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    getAvailable: () => models,
    getModelsOfType: (_type: "classifier", provider?: string) => ofType(provider),
    getAvailableOfType: async (_type: "classifier", provider?: string) =>
      available.filter((model) => !provider || model.provider === provider),
    getModelOfType: (_type: "classifier", provider: string, id: string) => ofType(provider).find((model) => model.id === id),
    findOfType: (_type: "classifier", provider: string, id: string) => ofType(provider).find((model) => model.id === id),
    getProviderAuthStatus: (_provider: string) => ({ configured: options.authSource !== undefined, source: options.authSource }),
    classify: async (model: PiClassifierModel<ClassifierApi>, context: ClassifierContext): Promise<ClassifierResult> =>
      options.classify?.(model, context) ?? {
        api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error", timestamp: Date.now(),
      },
  };
}

/**
 * Build a minimal ExtensionContext with only `modelRegistry` populated.
 * Other ExtensionContext fields are left undefined — routing functions
 * in tests only touch `modelRegistry`.
 */
export function makeCtx(models: Model<Api>[], options: FakeRegistryOptions = {}): ExtensionContext {
  return { modelRegistry: makeRegistry(models, options) } as unknown as ExtensionContext;
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

/**
 * Delay helper for testing timeouts and slow responses.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

