import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { types as nodeTypes } from "node:util";
import { validateConfig, type BifrostConfig } from "./config.ts";
import { buildRouteDecisionSummary, createPipeline, type ClassificationResult, type RouteDecisionSummary } from "./classification-pipeline.ts";
import type { ClassificationJudgment, TierCriterion } from "./classifier-backends.ts";
import { parseInlineOverride } from "./inline-override.ts";
import { emptyReliabilityState, type ReliabilityConfig, type ReliabilityState } from "./reliability.ts";
import { resolveConfiguredTier } from "./routing.ts";
import { hasHardEconomicAdmission, validateEconomicPolicy, validateEconomicSnapshot, type EconomicSnapshot, type ReservePolicy } from "./economic-signals.ts";
import { observeAffinity, type AffinityAnchor, type AffinityTargetOrigin } from "./affinity.ts";

export interface RouterModel {
  readonly provider: string;
  readonly id: string;
  readonly cost: {
    readonly input: number;
    readonly output: number;
  };
  readonly contextWindow: number;
  /** Mark host virtual entries so this physical-model resolver can exclude them. */
  readonly virtual?: boolean;
}

export interface RouterRegistrySnapshot {
  /** Inventory used only to explain exact references that are known but unavailable. */
  readonly knownModels: readonly RouterModel[];
  /** Required availability snapshot; both exact and fuzzy routing select only these entries. */
  readonly availableModels: readonly RouterModel[];
}

export interface RouterEconomicSnapshot {
  readonly policy: ReservePolicy;
  readonly snapshot: EconomicSnapshot;
}

export type RouterReliabilityConfig = Pick<ReliabilityConfig,
  "enabled" | "failureThreshold" | "windowMinutes" | "cooldownMinutes">;

type RouterConfigSnapshot = Omit<Pick<BifrostConfig,
  "schemaVersion" | "tierPolicies" | "default" | "strategy" | "categoryStrategies" | "models" | "rules" | "classifier" | "reliability" | "affinity">,
"reliability"> & { readonly reliability?: RouterReliabilityConfig };

export interface RouterAffinitySnapshot {
  readonly targetOrigin?: string;
  readonly anchor?: AffinityAnchor;
}

export interface RouterSnapshot {
  /** Supported routing subset. Economic policy/state lives in `economic`. */
  readonly config: RouterConfigSnapshot;
  readonly registry: RouterRegistrySnapshot;
  readonly now: number;
  readonly reliabilityState?: ReliabilityState;
  readonly economic?: RouterEconomicSnapshot;
  /** Optional, caller-owned anchor/origin. Required only when affinity is configured to observe. */
  readonly affinity?: RouterAffinitySnapshot;
}

export interface RouterClassifierPort {
  /** External classification transport. It is never called without an explicit grant. */
  classify(input: {
    readonly prompt: string;
    readonly tiers: readonly string[];
    /** Only explicitly configured criteria for requested tiers; empty means none. */
    readonly criteria: Readonly<Record<string, TierCriterion>>;
  }, signal?: AbortSignal): Promise<ClassificationJudgment | undefined>;
}

export interface RouterOptions {
  /** Both this grant and a supplied classifier port are required for external calls. */
  readonly networkClassifierGrant?: true;
  readonly networkClassifier?: RouterClassifierPort;
  readonly classifierTimeoutMs?: number;
  /** Optional route-local RNG; omission preserves the routing engine's Math.random behavior. */
  readonly random?: () => number;
}

export interface RouterResolveRequest {
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly forcedTier?: string;
  /** Per-resolution override; otherwise the factory's optional RNG is used. */
  readonly random?: () => number;
}

export type RouterResolveResult =
  | { readonly version: 1; readonly status: "aborted"; readonly asOf: number }
  | {
    readonly version: 1;
    readonly status: "completed";
    /** Snapshot time only. Recreate/revalidate before any real dispatch. */
    readonly asOf: number;
    readonly decision: RouteDecisionSummary;
    /** Exact pool references present in knownModels but absent from availableModels. */
    readonly knownUnavailableModels: readonly string[];
  };

export interface Router {
  /**
   * Advisory resolution only. Before actual dispatch, refresh registry/config/
   * reliability/economic inputs, create a new router, and resolve again.
   */
  readonly resolve: (request: RouterResolveRequest) => Promise<RouterResolveResult>;
}

const MAX_PROMPT_CHARS = 16_384;
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 5_000;
const MAX_CLASSIFIER_TIMEOUT_MS = 60_000;
const MAX_ID_LENGTH = 256;
const MAX_EPOCH = 8.64e15;

interface InternalRegistry {
  readonly find: (provider: string, modelId: string) => Model<Api> | undefined;
  readonly getAvailable: () => Model<Api>[];
  readonly knownUnavailable: (decision: RouteDecisionSummary) => readonly string[];
}

function safeId(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function modelKey(model: Pick<RouterModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function assertValidModel(model: RouterModel): void {
  if (!model || typeof model !== "object"
    || !safeId(model.provider) || model.provider.includes("/")
    || !safeId(model.id) || !Number.isFinite(model.cost?.input) || model.cost.input < 0
    || !Number.isFinite(model.cost?.output) || model.cost.output < 0
    || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
    || model.virtual !== undefined && typeof model.virtual !== "boolean") {
    throw new Error("Invalid router model snapshot.");
  }
}

function internalModel(model: RouterModel): Model<Api> {
  // The resolver reads only these fields. The peer transport model is never
  // accepted or returned by the public API.
  return {
    provider: model.provider,
    id: model.id,
    cost: { input: model.cost.input, output: model.cost.output },
    contextWindow: model.contextWindow,
  } as Model<Api>;
}

interface DataObjectSchema { readonly [key: string]: DataSchema }
type DataSchema = DataObjectSchema | { readonly array: DataSchema }
  | { readonly map: DataSchema } | { readonly oneOf: readonly DataSchema[] } | null;

function invalidSnapshot(): never {
  throw new Error("Invalid router snapshot data.");
}

function ownRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return invalidSnapshot();
  if (nodeTypes.isProxy(value)) return invalidSnapshot();
  if (Array.isArray(value)) return invalidSnapshot();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidSnapshot();
    const keys = Reflect.ownKeys(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return invalidSnapshot();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return invalidSnapshot();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalidSnapshot();
  }
}

function ownArray(value: unknown): unknown[] {
  if (nodeTypes.isProxy(value)) return invalidSnapshot();
  if (!Array.isArray(value)) return invalidSnapshot();
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalidSnapshot();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0) return invalidSnapshot();
    const length = lengthDescriptor.value as number;
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)) return invalidSnapshot();
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= length || index >= 0xffff_ffff || String(index) !== key) {
        return invalidSnapshot();
      }
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return invalidSnapshot();
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return invalidSnapshot();
  }
}

function normalizeData(value: unknown, schema: DataSchema): unknown {
  if (value === undefined) return undefined;
  if (schema === null) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    return invalidSnapshot();
  }
  const oneOf = (schema as { readonly oneOf?: readonly DataSchema[] }).oneOf;
  if (Array.isArray(oneOf)) {
    for (const option of oneOf) {
      try { return normalizeData(value, option); } catch { /* try the next declared shape */ }
    }
    return invalidSnapshot();
  }
  if ("array" in schema) return ownArray(value).map((entry) => normalizeData(entry, schema.array));
  if ("map" in schema) {
    const source = ownRecord(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source)) result[key] = normalizeData(source[key], schema.map);
    return result;
  }
  const source = ownRecord(value);
  const allowed = schema as Readonly<Record<string, DataSchema>>;
  for (const key of Object.keys(source)) if (!Object.hasOwn(allowed, key)) return invalidSnapshot();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) result[key] = normalizeData(source[key], allowed[key]!);
  return result;
}

const scalar: DataSchema = null;
const stringArray: DataSchema = { array: scalar };
const modelTier: DataSchema = { oneOf: [scalar, stringArray] };
const classifierModel: DataSchema = { oneOf: [scalar, stringArray] };
const criterion: DataSchema = { oneOf: [scalar, { what: scalar, notFor: scalar, examples: stringArray }] };
const modelSnapshotSchema: DataSchema = {
  provider: scalar, id: scalar, cost: { input: scalar, output: scalar }, contextWindow: scalar, virtual: scalar,
};
const economicScopeSchema: DataSchema = {
  kind: scalar, model: scalar, provider: scalar, accountRef: scalar, epoch: scalar,
};
const economicWindowSchema: DataSchema = {
  id: scalar, period: { id: scalar, sequence: scalar }, unit: scalar, currency: scalar,
  remaining: scalar, limit: scalar, resetsAt: scalar,
};
const economicSignalSchema: DataSchema = {
  sourceId: scalar, scopeRef: scalar, billing: scalar, observedAt: scalar, expiresAt: scalar,
  revision: scalar, windows: { array: economicWindowSchema },
};
const reserveRuleSchema: DataSchema = {
  id: scalar, scopeRef: scalar, windowId: scalar, reserveRatio: scalar, unknown: scalar,
};
const routerSnapshotSchema: DataSchema = {
  config: {
    schemaVersion: scalar, tierPolicies: { map: { fallbackTiers: stringArray } }, default: scalar, strategy: scalar,
    categoryStrategies: { map: scalar }, models: { map: modelTier },
    rules: { array: { pattern: scalar, model: scalar } },
    classifier: {
      enabled: scalar, backend: scalar, totalTimeoutMs: scalar, model: classifierModel, endpoint: scalar,
      method: scalar, systemPrompt: scalar, maxTokens: scalar, temperature: scalar, fallbackToRegex: scalar,
      criteria: { map: criterion }, typesafe: {
        model: scalar, endpoint: scalar, timeoutMs: scalar, maxAttempts: scalar, debug: scalar, metrics: { enabled: scalar },
      }, piNative: { model: scalar, timeoutMs: scalar, maxAttempts: scalar, metrics: { enabled: scalar } },
      minConfidence: scalar, fallback: scalar,
    },
    reliability: {
      enabled: scalar, stateVersion: scalar, observations: { enabled: scalar }, path: scalar,
      failureThreshold: scalar, windowMinutes: scalar, cooldownMinutes: scalar,
      cooldownOnAllowanceExhausted: scalar,
      allowanceCooldownScope: scalar,
      retryOnAllowanceExhausted: scalar,
    },
    affinity: { mode: scalar, providerAdvisory: scalar },
  },
  registry: { knownModels: { array: modelSnapshotSchema }, availableModels: { array: modelSnapshotSchema } },
  now: scalar,
  reliabilityState: { version: scalar, models: { map: {
    failures: { array: scalar }, openUntil: scalar, trialActive: scalar, cooldownMultiplier: scalar,
    lastFailureAt: scalar, lastFailureSource: scalar, lastFailureReason: scalar,
    lastSuccessAt: scalar, lastSuccessSource: scalar,
  } } },
  economic: {
    policy: {
      mode: scalar, scopes: { map: economicScopeSchema },
      sources: { array: { id: scalar, scopeRef: scalar, authority: scalar } },
      sourceOrder: { map: stringArray }, admission: { array: reserveRuleSchema },
      preference: { billingClass: scalar }, tierOverrides: { map: { map: { reserveRatio: scalar, unknown: scalar } } },
      observations: { array: economicSignalSchema },
    },
    snapshot: {
      revision: scalar, signals: { array: economicSignalSchema },
      watermarks: { array: { sourceId: scalar, scopeRef: scalar, windowId: scalar, periodId: scalar, periodSequence: scalar, revision: scalar } },
    },
  },
  affinity: { targetOrigin: scalar, anchor: { modelKey: scalar, provider: scalar, lastSuccessfulDispatchAt: scalar } },
};

function freezeTree<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
  return Object.freeze(value);
}

function normalizeSnapshot(snapshot: unknown): RouterSnapshot {
  try {
    return freezeTree(normalizeData(snapshot, routerSnapshotSchema)) as RouterSnapshot;
  } catch {
    throw new Error("Invalid router snapshot data.");
  }
}

function buildRegistry(snapshot: RouterRegistrySnapshot): InternalRegistry {
  if (!Array.isArray(snapshot?.knownModels) || !Array.isArray(snapshot?.availableModels)) {
    throw new Error("Invalid router registry snapshot.");
  }
  const known = new Map<string, Model<Api>>();
  for (const model of snapshot.knownModels) {
    assertValidModel(model);
    if (model.virtual) continue;
    const key = modelKey(model);
    if (known.has(key)) throw new Error("Duplicate model in router registry snapshot.");
    known.set(key, internalModel(model));
  }
  const available: Model<Api>[] = [];
  const availableKeys = new Set<string>();
  const availableByKey = new Map<string, Model<Api>>();
  for (const model of snapshot.availableModels) {
    assertValidModel(model);
    if (model.virtual) continue;
    const key = modelKey(model);
    const knownModel = known.get(key);
    if (!knownModel || availableKeys.has(key)) throw new Error("Inconsistent router registry snapshot.");
    if (knownModel.cost.input !== model.cost.input
      || knownModel.cost.output !== model.cost.output
      || knownModel.contextWindow !== model.contextWindow
      || snapshot.knownModels.find((knownEntry) => modelKey(knownEntry) === key)?.virtual !== model.virtual) {
      throw new Error("Inconsistent router model metadata.");
    }
    availableKeys.add(key);
    availableByKey.set(key, knownModel);
    available.push(knownModel);
  }
  return {
    find: (provider, modelId) => availableByKey.get(`${provider}/${modelId}`),
    getAvailable: () => [...available],
    knownUnavailable: (decision) => {
      const pools = decision.attempted ?? [decision.requested, decision.fallback].filter((pool) => pool !== undefined);
      const unavailable = new Set<string>();
      for (const pool of pools) {
        for (const pattern of pool.patterns) {
          if (!pattern.includes("/")) continue;
          const knownModel = known.get(pattern);
          if (knownModel && !availableKeys.has(pattern)) unavailable.add(pattern);
        }
      }
      return [...unavailable];
    },
  };
}

function validEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH;
}

function plainOwnDataRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string" || !allowedKeys.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function checkedAffinitySnapshot(value: RouterAffinitySnapshot, now: number): RouterAffinitySnapshot {
  const record = plainOwnDataRecord(value, ["targetOrigin", "anchor"]);
  if (!record) throw new Error("Invalid router affinity snapshot.");
  const targetOrigin = record.targetOrigin;
  const origins: readonly AffinityTargetOrigin[] = [
    "automatic", "explicit_tier", "explicit_model", "pinned", "off", "direct", "continuation", "retry",
  ];
  if (targetOrigin !== undefined && !origins.includes(targetOrigin as AffinityTargetOrigin)) {
    throw new Error("Invalid router affinity snapshot.");
  }
  const rawAnchor = record.anchor;
  if (rawAnchor === undefined) {
    return { ...(targetOrigin !== undefined ? { targetOrigin: targetOrigin as string } : {}) };
  }
  const anchor = plainOwnDataRecord(rawAnchor, ["modelKey", "provider", "lastSuccessfulDispatchAt"]);
  if (!anchor || typeof anchor.modelKey !== "string" || typeof anchor.provider !== "string"
    || !validEpoch(anchor.lastSuccessfulDispatchAt)) {
    throw new Error("Invalid router affinity snapshot.");
  }
  const normalizedAnchor: AffinityAnchor = {
    modelKey: anchor.modelKey,
    provider: anchor.provider,
    lastSuccessfulDispatchAt: anchor.lastSuccessfulDispatchAt,
  };
  try {
    // Reuse the production validator against sanitized own data before any
    // optional classifier port can be invoked by resolve().
    observeAffinity({
      targetOrigin: "automatic",
      eligibleModelKeys: [],
      anchor: normalizedAnchor,
      snapshotAsOf: now,
    });
  } catch {
    throw new Error("Invalid router affinity snapshot.");
  }
  return {
    ...(targetOrigin !== undefined ? { targetOrigin: targetOrigin as string } : {}),
    anchor: normalizedAnchor,
  };
}

function sanitizedReliabilityState(value: ReliabilityState | undefined, now: number): ReliabilityState {
  if (value === undefined) return emptyReliabilityState();
  const isPlain = (item: unknown): item is Record<string, unknown> => !!item
    && typeof item === "object" && !Array.isArray(item)
    && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
  if (!isPlain(value) || value.version !== 1 || !isPlain(value.models)) {
    throw new Error("Invalid router reliability snapshot.");
  }
  const models: ReliabilityState["models"] = Object.create(null) as ReliabilityState["models"];
  for (const [key, raw] of Object.entries(value.models)) {
    if (!safeId(key) || !isPlain(raw) || !Array.isArray(raw.failures)
      || !raw.failures.every((time) => validEpoch(time) && time <= now)
      || raw.openUntil !== undefined && !validEpoch(raw.openUntil)
      || raw.trialActive !== undefined && typeof raw.trialActive !== "boolean"
      || raw.cooldownMultiplier !== undefined && (typeof raw.cooldownMultiplier !== "number" || !Number.isFinite(raw.cooldownMultiplier) || raw.cooldownMultiplier <= 0)
      || raw.lastFailureAt !== undefined && (!validEpoch(raw.lastFailureAt) || raw.lastFailureAt > now)
      || raw.lastSuccessAt !== undefined && (!validEpoch(raw.lastSuccessAt) || raw.lastSuccessAt > now)) {
      throw new Error("Invalid router reliability snapshot.");
    }
    models[key] = {
      failures: [...raw.failures],
      ...(raw.openUntil !== undefined ? { openUntil: raw.openUntil } : {}),
      ...(raw.trialActive !== undefined ? { trialActive: raw.trialActive } : {}),
      ...(raw.cooldownMultiplier !== undefined ? { cooldownMultiplier: raw.cooldownMultiplier } : {}),
      ...(raw.lastFailureAt !== undefined ? { lastFailureAt: raw.lastFailureAt } : {}),
      ...(raw.lastSuccessAt !== undefined ? { lastSuccessAt: raw.lastSuccessAt } : {}),
    };
  }
  return { version: 1, models };
}

function registryContext(registry: InternalRegistry): ExtensionContext {
  return { modelRegistry: registry } as unknown as ExtensionContext;
}

function isValidJudgment(value: unknown, tiers: readonly string[]): value is ClassificationJudgment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const judgment = value as ClassificationJudgment;
  return tiers.includes(judgment.tier)
    && safeId(judgment.backend, 128)
    && (judgment.model === undefined || safeId(judgment.model, 256))
    && (judgment.confidence === undefined || Number.isFinite(judgment.confidence) && judgment.confidence >= 0 && judgment.confidence <= 1);
}

function classifierTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CLASSIFIER_TIMEOUT_MS) {
    throw new Error("Invalid router classifier timeout.");
  }
  return timeout;
}

function classifierMethod(value: unknown): { readonly receiver: object; readonly method: RouterClassifierPort["classify"] } {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) throw new Error("Invalid router options.");
  try {
    let current: object | null = value;
    while (current && current !== Object.prototype) {
      if (nodeTypes.isProxy(current)) throw new Error("Invalid router options.");
      const descriptor = Object.getOwnPropertyDescriptor(current, "classify");
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new Error("Invalid router options.");
        return { receiver: value, method: descriptor.value as RouterClassifierPort["classify"] };
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    throw new Error("Invalid router options.");
  }
  throw new Error("Invalid router options.");
}

function captureRouterOptions(value: unknown): Readonly<RouterOptions> {
  const input = ownRecord(value);
  const allowed = new Set(["networkClassifierGrant", "networkClassifier", "classifierTimeoutMs", "random"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Invalid router options.");
  const grant = input.networkClassifierGrant;
  const timeout = input.classifierTimeoutMs;
  const random = input.random;
  if (grant !== undefined && grant !== true || timeout !== undefined && typeof timeout !== "number"
    || random !== undefined && typeof random !== "function") throw new Error("Invalid router options.");
  let port: RouterClassifierPort | undefined;
  if (input.networkClassifier !== undefined) {
    const capability = classifierMethod(input.networkClassifier);
    port = Object.freeze({ classify: capability.method.bind(capability.receiver) });
  }
  return Object.freeze({
    ...(grant === true ? { networkClassifierGrant: true as const } : {}),
    ...(port ? { networkClassifier: port } : {}),
    ...(timeout !== undefined ? { classifierTimeoutMs: timeout as number } : {}),
    ...(random !== undefined ? { random: random as () => number } : {}),
  });
}

function configuredCriteria(config: BifrostConfig, tiers: readonly string[]): Readonly<Record<string, TierCriterion>> {
  const configured = config.classifier?.criteria;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return Object.freeze({});
  const criteria: Record<string, TierCriterion> = {};
  for (const tier of tiers) {
    if (!Object.hasOwn(configured, tier)) continue;
    const value: unknown = configured[tier];
    if (typeof value === "string") {
      if (!value.trim() || value.length > 4096) throw new Error("Invalid router classifier criterion.");
      criteria[tier] = value;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error("Invalid router classifier criterion.");
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["what", "notFor", "examples"].includes(key))
      || typeof record.what !== "string" || !record.what.trim() || record.what.length > 4096
      || record.notFor !== undefined && (typeof record.notFor !== "string" || record.notFor.length > 4096)
      || record.examples !== undefined && (!Array.isArray(record.examples) || record.examples.length > 16
        || !record.examples.every((example) => typeof example === "string" && example.length <= 2048))) {
      throw new Error("Invalid router classifier criterion.");
    }
    criteria[tier] = {
      what: record.what,
      ...(record.notFor !== undefined ? { notFor: record.notFor as string } : {}),
      ...(record.examples !== undefined ? { examples: [...record.examples] as string[] } : {}),
    };
  }
  return Object.freeze(criteria);
}

function createClassifier(
  config: BifrostConfig,
  options: Readonly<RouterOptions>,
): ((prompt: string, tiers: readonly string[], signal?: AbortSignal) => Promise<ClassificationJudgment | undefined>) | undefined {
  const port = options.networkClassifier;
  if (!port || options.networkClassifierGrant !== true || config.classifier?.enabled !== true) return undefined;
  const timeoutMs = classifierTimeout(options.classifierTimeoutMs);
  const criteriaByTier = configuredCriteria(config, Object.keys(config.models ?? {}));
  return async (prompt, tiers, callerSignal) => {
    if (callerSignal?.aborted) return undefined;
    const controller = new AbortController();
    let cancelPending: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<undefined>((resolve) => {
      cancelPending = () => resolve(undefined);
    });
    const onAbort = () => {
      controller.abort();
      cancelPending?.();
    };
    try {
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      if (callerSignal?.aborted) onAbort();
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      });
      const response = port.classify({
        prompt: prompt.slice(0, MAX_PROMPT_CHARS),
        tiers,
        criteria: Object.freeze(Object.fromEntries(tiers.flatMap((tier) =>
          Object.hasOwn(criteriaByTier, tier) ? [[tier, criteriaByTier[tier]]] : []))),
      }, controller.signal);
      const judgment = await Promise.race([response, timedOut, cancelled]);
      if (callerSignal?.aborted || controller.signal.aborted || !isValidJudgment(judgment, tiers)) return undefined;
      const minConfidence = config.classifier?.minConfidence;
      if (minConfidence !== undefined && (judgment.confidence === undefined || judgment.confidence < minConfidence)) return undefined;
      return {
        tier: judgment.tier,
        backend: judgment.backend,
        ...(judgment.model !== undefined ? { model: judgment.model } : {}),
        ...(judgment.confidence !== undefined ? { confidence: judgment.confidence } : {}),
      };
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function checkSnapshot(snapshot: RouterSnapshot): void {
  if (!Number.isSafeInteger(snapshot.now) || snapshot.now < 0 || snapshot.now > MAX_EPOCH) {
    throw new Error("Invalid router snapshot clock.");
  }
  let configIssues;
  const supportedConfigKeys = new Set([
    "schemaVersion", "tierPolicies", "default", "strategy", "categoryStrategies",
    "models", "rules", "classifier", "reliability", "affinity",
  ]);
  if (!snapshot.config || typeof snapshot.config !== "object"
    || Object.keys(snapshot.config).some((key) => !supportedConfigKeys.has(key))) {
    throw new Error("Unsupported router config fields.");
  }
  const reliability = snapshot.config.reliability as unknown;
  if (reliability !== undefined) {
    const plain = !!reliability && typeof reliability === "object" && !Array.isArray(reliability)
      && (Object.getPrototypeOf(reliability) === Object.prototype || Object.getPrototypeOf(reliability) === null);
    const supportedReliabilityKeys = new Set(["enabled", "failureThreshold", "windowMinutes", "cooldownMinutes"]);
    if (!plain || Object.keys(reliability).some((key) => !supportedReliabilityKeys.has(key))) {
      throw new Error("Unsupported router reliability controls.");
    }
  }
  const minConfidence = snapshot.config.classifier?.minConfidence;
  if (minConfidence !== undefined && (typeof minConfidence !== "number"
    || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
    throw new Error("Invalid router classifier minimum confidence.");
  }
  try {
    configIssues = validateConfig(snapshot.config);
  } catch {
    throw new Error("Invalid router config snapshot.");
  }
  if (configIssues.some((issue) => issue.severity === "error")) throw new Error("Invalid router config snapshot.");
  if (snapshot.affinity !== undefined && snapshot.config.affinity?.mode !== "observe" && snapshot.config.affinity?.mode !== "retain-within-tier") {
    throw new Error("Router affinity input requires affinity observation mode.");
  }
  if (snapshot.affinity !== undefined) checkedAffinitySnapshot(snapshot.affinity, snapshot.now);
  if (snapshot.economic) {
    const policy = validateEconomicPolicy(snapshot.economic.policy);
    const facts = validateEconomicSnapshot(snapshot.economic.snapshot, snapshot.economic.policy, snapshot.now);
    if (!policy.valid || !facts.valid) throw new Error("Invalid router economic snapshot.");
  }
}

/** Create an experimental, resolve-only router over explicit read-only snapshots.
 * Results describe only those snapshots and never authorize a later dispatch. */
export function createRouter(snapshot: RouterSnapshot, options: RouterOptions = {}): Router {
  const normalized = normalizeSnapshot(snapshot);
  checkSnapshot(normalized);
  const capturedOptions = captureRouterOptions(options);
  const now = normalized.now;
  const config = normalized.config;
  const registry = buildRegistry(normalized.registry);
  const reliabilityState = freezeTree(sanitizedReliabilityState(normalized.reliabilityState, now));
  const economic = normalized.economic;
  const affinity = normalized.affinity ? freezeTree(checkedAffinitySnapshot(normalized.affinity, now)) : undefined;
  const classifier = createClassifier(config, capturedOptions);
  const tiers = Object.keys(config.models ?? {});
  const pipeline = createPipeline({
    instrumentation: "none",
    cacheLookup: () => undefined,
    ...(classifier ? { classifyDirect: classifier } : {}),
    ...(config.classifier?.totalTimeoutMs !== undefined
      ? { totalTimeoutMs: config.classifier.totalTimeoutMs }
      : {}),
    classifierModels: [],
    classifyWithLLM: async () => undefined,
    regexRules: config.rules ?? [],
    defaultTier: config.default,
    tiers,
  });

  return Object.freeze({
    resolve: async (request: RouterResolveRequest): Promise<RouterResolveResult> => {
      if (!request || typeof request.prompt !== "string") throw new Error("Invalid router resolve request.");
      const prompt = request.prompt;
      const signal = request.signal;
      const forcedTier = request.forcedTier;
      const random = request.random;
      if (signal?.aborted) return { version: 1, status: "aborted", asOf: now };
      if (forcedTier !== undefined && !Object.hasOwn(config.models ?? {}, forcedTier)) {
        throw new Error("Forced tier is not configured.");
      }
      const inline = forcedTier === undefined
        ? parseInlineOverride(prompt, config.models)
        : { forcedTier, promptText: prompt };
      let classification: ClassificationResult = inline.forcedTier
        ? { kind: "classified", tier: inline.forcedTier, source: "inline" }
        : await pipeline.classify(inline.promptText, signal);
      if (signal?.aborted) return { version: 1, status: "aborted", asOf: now };
      if (classification.kind === "unclassified" && hasHardEconomicAdmission(economic?.policy) && config.default) {
        classification = { kind: "fallback", tier: config.default };
      }
      if (classification.kind === "unclassified") {
        const decision = buildRouteDecisionSummary(classification);
        return { version: 1, status: "completed", asOf: now, decision, knownUnavailableModels: [] };
      }
      const resolved = resolveConfiguredTier(
        registryContext(registry),
        classification.tier,
        config,
        reliabilityState,
        config.reliability as ReliabilityConfig | undefined,
        now,
        economic,
        random ?? capturedOptions.random,
        {
          ...(affinity?.targetOrigin !== undefined ? { targetOrigin: affinity.targetOrigin } : {}),
          ...((request.forcedTier !== undefined || inline.forcedTier !== undefined) ? { intrinsicOrigin: "explicit_tier" } : {}),
          ...(affinity?.anchor ? { anchor: affinity.anchor } : {}),
        },
      );
      if (signal?.aborted) return { version: 1, status: "aborted", asOf: now };
      const decision = buildRouteDecisionSummary(classification, resolved);
      return {
        version: 1,
        status: "completed",
        asOf: now,
        decision,
        knownUnavailableModels: registry.knownUnavailable(decision),
      };
    },
  });
}
