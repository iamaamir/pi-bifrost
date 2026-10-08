import type { ExtensionAPI, ExtensionContext, TurnEndEvent, SessionMessageEntry, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { classifyWithLLM as invokeClassifier, type ClassifierModel } from "./classifier.ts";
import { classifierCacheEnabled, classifierCacheKey, boundedClassifierPrompt, directStagePlan } from "./classifier-semantics.ts";
import { ClassifierMetricsStore, classifierMetricsEnabled } from "./classifier-metrics.ts";
import {
  buildRouteDecisionSummary,
  createPipeline,
  type ClassificationPipeline,
  type DirectClassifierAttempt,
  type DirectClassifierObservation,
  type ClassificationResult,
} from "./classification-pipeline.ts";
import type { ClassificationJudgment } from "./classifier-backends.ts";
import type { TypeSafeObservation } from "./classifier-metrics.ts";
import {
  cachePath,
  lookupCache,
  touchCacheEntry,
  loadCache,
  saveCache,
  updateCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_THRESHOLD,
  DEFAULT_TTL_HOURS,
  type CacheEntry,
} from "./cache.ts";
import {
  loadConfig,
  loadRules,
  configHasNoPools,
  DEFAULT_CLASSIFIER_CRITERIA,
  validateConfig,
  hasExplicitTierPolicy,
  hasExplicitTierPolicies,
  hasClassifierConfigErrors,
  classifierConfigErrors,
  validateTierPolicyConfig,
  validateEconomicConfig,
  type BifrostConfig,
} from "./config.ts";
import {
  resolveConfiguredTier,
  findCandidates,
  modelKey,
  type RoutedModelResolution,
  type SkippedCandidate,
  type AffinityRoutingContext,
} from "./routing.ts";
import { reconcileEconomicSnapshot } from "./economic-config.ts";
import { emptyEconomicSnapshot, hasHardEconomicAdmission } from "./economic-signals.ts";
import { ReliabilityStore } from "./reliability-store.ts";
import { getCircuitState, hasActiveAllowanceCooldown } from "./reliability.ts";
import { projectReliabilityV2ForRouting } from "./reliability-v2-routing.ts";
import { normalizeFailureObservation } from "./failure-observations.ts";
import { createRuntimeAffinityStore, type RuntimeAffinitySuccessProof, type RuntimeAffinityStore } from "./runtime-affinity.ts";
import type { AffinityAnchor } from "./affinity.ts";
import {
  AutoDispatchReceiptBook,
  createReliabilityV2Store,
  reliabilityV2Config,
  serializeReceiptOperation,
  V2_LEASE_TTL_MS,
  V2_RENEW_INTERVAL_MS,
  V2_MAX_DISPATCH_LIFETIME_MS,
  type AutoDispatchReceipt,
} from "./runtime-reliability-v2.ts";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState, isPassiveModelSelection, createSelfSelectTracker } from "./runtime-state.ts";
import { createCommandRouter, getBifrostCommandCompletions, runBifrostCommand, log, uiBusy, uiDone, syncBifrostModeStatus, clearBifrostWidgets, type BifrostState } from "./commands.ts";
import { setupDebug, debug, debugMeasure, isDebugEnabled, flushDebug } from "./debug.ts";
import { parseInlineOverride } from "./inline-override.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER, isBifrostAuto, isVirtualModel } from "./virtual-model.ts";
import { createDispatchOwnership, RuntimeReliabilityTracker } from "./runtime-reliability.ts";
import { randomUUID } from "node:crypto";
import { VirtualOverride } from "./virtual-override.ts";
import { createVirtualRoute, noModelError, poolProblem } from "./virtual-routing.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV } from "./classifier-backends.ts";
import { createTypeSafeClassifier, resolveTypeSafeApiKey } from "./typesafe-classifier.ts";
import { createPiNativeClassifier, piClassificationSupported } from "./classifier-pi-native.ts";
import { collectDetectionFacts, createDetectionEngine, createDetectionNoticeGate, effectiveBackendOf, piNativeCredentialMissing, selectEffectiveBackend, type EffectiveBackend } from "./classifier-detection.ts";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  REGISTRY_REFRESH_TTL_MS,
  setBifrostStatus,
  setBifrostWorkingMessage,
  shouldRefreshRegistry,
} from "./ux-status.ts";
import { projectProviderRefreshEvidence, waitForRegistryRefresh } from "./registry-refresh.ts";

interface DebugCorrelationState {
  readonly id: string;
  readonly turns: WeakMap<object, string>;
}

let debugRunCorrelationId: string | undefined;
let debugSessionCorrelations: WeakMap<object, DebugCorrelationState> | undefined;
const classifierNoticeStates = new WeakMap<object, Map<string, { readonly binding: string; readonly stateKey: string }>>();
const MAX_LOGGABLE_CIRCUIT_EPOCH = 8_640_000_000_000_000;

function classifierOutcomeLabel(outcome: TypeSafeObservation["outcome"]): string {
  switch (outcome) {
    case "timeout": return "timed out";
    case "network": return "could not connect";
    case "auth": return "was rejected by authentication";
    case "rate_limited": return "was rate limited";
    case "http": return "returned an HTTP error";
    case "invalid_response": return "returned an invalid response";
    case "low_confidence": return "did not meet its confidence threshold";
    case "missing_key": return "has no configured credential";
    case "missing_catalog": return "has no available classifier model";
    case "unsupported": return "is unsupported in this environment";
    case "circuit_open": return "is temporarily disabled by its circuit breaker";
    case "aborted": return "was cancelled";
    case "success": return "completed successfully";
  }
}

function classifierFallbackLabel(result: ClassificationResult): string {
  const attempt = result.classifierAttempt;
  switch (attempt?.fallbackKind) {
    case "prompt": return `the prompt classifier${attempt.fallbackModel ? ` (${attempt.fallbackModel})` : ""}`;
    case "regex": return "regex routing";
    case "default": return "the configured default tier";
    default: return "no configured tier matched";
  }
}

function reportClassifierAttempt(
  ctx: ExtensionContext,
  result: ClassificationResult,
  turn?: object,
  requestCorrelationId?: string,
): void {
  try {
    const attempt = result.classifierAttempt;
    if (!attempt) {
      if (result.kind === "classified" && result.source === "classifier" && result.judgment?.backend === "prompt") {
        const recovered = classifierNoticeStates.get(ctx.sessionManager)?.delete("pipeline") ?? false;
        if (recovered) {
          debugLifecycle("classifier", "budget_recovered", ctx.sessionManager, turn, {
            request_correlation_id: requestCorrelationId ?? null,
            backend: "prompt",
          });
        }
      }
      if (result.classificationOutcome !== "deadline") return;
      let states = classifierNoticeStates.get(ctx.sessionManager);
      if (!states) {
        states = new Map();
        classifierNoticeStates.set(ctx.sessionManager, states);
      }
      debugLifecycle("classifier", "budget_expired", ctx.sessionManager, turn, {
        request_correlation_id: requestCorrelationId ?? null,
        fallback: result.kind === "unclassified" ? "none" : result.kind === "fallback" ? "default" : result.source === "regex" ? "regex" : "none",
      });
      if (states.get("pipeline")?.stateKey === "deadline") return;
      states.set("pipeline", { binding: "pipeline", stateKey: "deadline" });
      const routeMessage = result.kind === "unclassified"
        ? "No tier was selected; select a tier/model or adjust routing rules."
        : `Using ${result.kind === "fallback" ? "the configured default tier" : "local routing"}. Routing is still active.`;
      log(ctx, `Bifrost classifier time budget expired. ${routeMessage}`, "warning");
      return;
    }
    const meta = {
      request_correlation_id: requestCorrelationId ?? null,
      backend: attempt.backend,
      outcome: attempt.outcome,
      ...(attempt.model ? { model: attempt.model } : {}),
      fallback: attempt.fallbackKind,
      ...(attempt.fallbackModel ? { fallback_model: attempt.fallbackModel } : {}),
      ...(attempt.circuitOpenUntil ? { circuit_open_until: attempt.circuitOpenUntil } : {}),
      ...(result.classificationOutcome === "deadline" ? { classification_outcome: "deadline" } : {}),
    };
    debugLifecycle("classifier", "attempt_outcome", ctx.sessionManager, turn, meta);
    if (result.classificationOutcome === "deadline") {
      debugLifecycle("classifier", "budget_expired", ctx.sessionManager, turn, {
        ...meta,
        budget_scope: "total_classifier",
      });
    }

    let states = classifierNoticeStates.get(ctx.sessionManager);
    if (!states) {
      states = new Map();
      classifierNoticeStates.set(ctx.sessionManager, states);
    }
    const binding = `${attempt.backend}:${attempt.model ?? "unknown"}`;
    if (attempt.outcome === "success") {
      const recoveredBackend = states.delete(attempt.backend);
      const recoveredPipeline = states.delete("pipeline");
      const recovered = recoveredBackend || recoveredPipeline;
      if (recovered) {
        debugLifecycle("classifier", "recovered", ctx.sessionManager, turn, {
          request_correlation_id: requestCorrelationId ?? null,
          backend: attempt.backend,
          ...(attempt.model ? { model: attempt.model } : {}),
        });
        log(ctx, `Bifrost: ${attempt.backend} classifier recovered${attempt.model ? ` (${attempt.model})` : ""}.`);
      }
      return;
    }

    if (attempt.outcome === "aborted") return;
    const openUntil = attempt.circuitOpenUntil;
    const validOpenUntil = Number.isSafeInteger(openUntil) && (openUntil ?? 0) <= MAX_LOGGABLE_CIRCUIT_EPOCH && (openUntil ?? 0) > Date.now();
    const stateKey = validOpenUntil
      ? `open:${openUntil}`
      : `outcome:${attempt.outcome}`;
    const noticeStateKey = `${stateKey}${result.classificationOutcome === "deadline" ? ":deadline" : ""}`;
    const previous = states.get(attempt.backend);
    if (previous?.binding === binding && previous.stateKey === noticeStateKey) return;
    states.set(attempt.backend, { binding, stateKey: noticeStateKey });

    const circuitMessage = validOpenUntil
      ? ` Its model-only circuit is open until ${new Date(openUntil!).toISOString()}.`
      : "";
    debugLifecycle("classifier", "degraded", ctx.sessionManager, turn, meta);
    const routeMessage = attempt.fallbackKind === "none"
      ? `No tier was selected; ${classifierFallbackLabel(result)}. Select a tier/model or adjust routing rules.`
      : `Using ${classifierFallbackLabel(result)}. Routing is still active.`;
    const budgetMessage = result.classificationOutcome === "deadline" ? " The total classifier time budget expired." : "";
    log(ctx, `Bifrost: ${attempt.backend} classifier ${classifierOutcomeLabel(attempt.outcome)}${attempt.model ? ` (${attempt.model})` : ""}. ${routeMessage}${budgetMessage}${circuitMessage}`, "warning");
  } catch {
    // Warning and telemetry failures must never affect a route or input action.
  }
}

function debugCorrelation(session?: object, turn?: object): Record<string, string> | undefined {
  if (!isDebugEnabled()) return undefined;
  debugRunCorrelationId ??= randomUUID();
  const correlation: Record<string, string> = { run_correlation_id: debugRunCorrelationId };
  if (!session) return correlation;
  debugSessionCorrelations ??= new WeakMap();
  let sessionState = debugSessionCorrelations.get(session);
  if (!sessionState) {
    sessionState = { id: randomUUID(), turns: new WeakMap() };
    debugSessionCorrelations.set(session, sessionState);
  }
  correlation.session_correlation_id = sessionState.id;
  if (turn) {
    let turnId = sessionState.turns.get(turn);
    if (!turnId) {
      turnId = randomUUID();
      sessionState.turns.set(turn, turnId);
    }
    correlation.turn_correlation_id = turnId;
  }
  return correlation;
}

function debugLifecycle(
  module: string,
  event: string,
  session: object | undefined,
  turn: object | undefined,
  meta: Record<string, unknown>,
): void {
  try {
    const correlation = debugCorrelation(session, turn);
    if (!correlation) return;
    debug(module, event, { ...correlation, ...meta });
  } catch { /* optional observability must not change routing */ }
}

// ── Pipeline builder (composition root) ────────────────────────

function lastDispatchedPhysical(ctx: ExtensionContext): Model<Api> | undefined {
  for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    // Defense in depth: assistant messages record physical dispatches only
    // (a virtual model never reaches a provider), but never trust identity
    // bookkeeping when choosing a model to activate.
    if (isVirtualModel(entry.message)) continue;
    const model = ctx.modelRegistry.find(entry.message.provider, entry.message.model);
    if (model && !isVirtualModel(model)) return model;
  }
  return undefined;
}

function readEditorText(ctx: ExtensionContext): string | undefined {
  if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
  try {
    return ctx.ui.getEditorText();
  } catch {
    return undefined;
  }
}

function restoreRejectedPrompt(
  ctx: ExtensionContext,
  originalText: string,
  editorTextAtInput: string | undefined,
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    const current = ctx.ui.getEditorText();
    if (current === "" || current === editorTextAtInput) ctx.ui.setEditorText(originalText);
  } catch {
    // Failing to restore the text must never let the rejected turn continue.
  }
}

function strictInputHandled(
  ctx: ExtensionContext,
  state: Pick<BifrostState, "enabled" | "pinned" | "classifierEnabled" | "config" | "economicPolicyValid">,
  originalText: string,
  editorTextAtInput: string | undefined,
  message: string,
) {
  restoreRejectedPrompt(ctx, originalText, editorTextAtInput);
  try { log(ctx, message, "error"); } catch { /* preserve handled result */ }
  try { uiDone(ctx); } catch { /* best effort */ }
  try { setBifrostWorkingMessage(ctx, undefined); } catch { /* best effort */ }
  try { syncBifrostModeStatus(ctx, state); } catch { /* best effort */ }
  return { action: "handled" as const };
}

function resolveClassifierModels(
  ctx: ExtensionContext,
  config: BifrostConfig,
): ClassifierModel[] {
  const pattern = config.classifier?.model;
  if (!pattern) return [];
  return findCandidates(ctx, pattern)
    .slice(0, 3)
    .map((model) => ({ kind: "registry" as const, model }));
}

function endpointClassifier(id: string, endpoint: string): ClassifierModel {
  return { kind: "endpoint", id, baseUrl: endpoint };
}

interface ReserveExclusionSummary {
  readonly count: number;
  readonly reasonCodes: readonly string[];
}

const SAFE_RESERVE_REASON_CODES = new Set([
  "above_reserve", "reserve_reached", "missing_fact", "stale_fact", "invalid_fact",
  "source_conflict", "period_conflict", "unsupported_scope", "scope.invalid", "context.invalid",
]);

function reserveExclusionSummary(resolution: RoutedModelResolution): ReserveExclusionSummary {
  const pools = resolution.attemptedTiers?.map((attempt) => attempt.resolution)
    ?? [resolution.primary, ...(resolution.fallback ? [resolution.fallback] : [])];
  const candidates = new Map<string, Set<string>>();
  for (const pool of pools) {
    for (const { key, evaluation } of pool.economic ?? []) {
      if (evaluation.mode !== "policy" || evaluation.disposition !== "rejected") continue;
      const reasons = candidates.get(key) ?? new Set<string>();
      for (const result of evaluation.results) {
        if ((result.status === "reject" || (result.status === "unknown" && result.unknownHandling === "block"))
          && SAFE_RESERVE_REASON_CODES.has(result.reason)) reasons.add(result.reason);
      }
      candidates.set(key, reasons);
    }
  }
  const reasonCodes = [...new Set([...candidates.values()].flatMap((reasons) => [...reasons]))].sort();
  return { count: candidates.size, reasonCodes };
}

function routingPolicyInvalid(state: Pick<BifrostState, "tierPolicyValid" | "economicPolicyValid" | "reliabilityV2ConfigValid" | "affinityConfigValid">): boolean {
  return state.tierPolicyValid === false || state.economicPolicyValid === false || state.reliabilityV2ConfigValid === false || state.affinityConfigValid === false;
}

function registryProviders(ctx: ExtensionContext): string[] {
  try {
    const registered = ctx.modelRegistry.getRegisteredProviderIds();
    if (Array.isArray(registered)) return [...new Set(registered.filter((id): id is string => typeof id === "string" && id.length > 0))];
  } catch { /* fall back to the current catalog snapshot */ }
  try {
    return [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider).filter((id) => typeof id === "string" && id.length > 0))];
  } catch { return []; }
}

function updateRegistryInventoryEvidence(
  state: BifrostState,
  ctx: ExtensionContext,
  result?: Parameters<typeof projectProviderRefreshEvidence>[0],
): void {
  const evidence = Object.assign(Object.create(null) as Record<string, { status: "complete" | "partial" | "stale"; refreshedAt: number }>, state.registryInventoryEvidence ?? {});
  const providers = registryProviders(ctx);
  const refreshedAt = Date.now();
  for (const provider of providers) {
    const value = result
      ? projectProviderRefreshEvidence(result, provider, providers, refreshedAt)
      : { status: "stale" as const, refreshedAt };
    Object.defineProperty(evidence, provider, { value, enumerable: true, configurable: true, writable: true });
  }
  state.registryInventoryEvidence = Object.freeze(evidence);
}

function activeClassifierCacheKey(config: BifrostConfig, detectionEngine: ReturnType<typeof createDetectionEngine>): string {
  const effective = effectiveBackendOf(config, detectionEngine);
  return classifierCacheKey(config, Object.keys(config.models ?? {}), {
    typesafeCredentialAvailable: resolveTypeSafeApiKey().source !== "missing",
    effectiveBackend: effective.backend,
  });
}

function boundedClassifierModel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function directClassifierAttempt(
  backend: DirectClassifierObservation["backend"],
  observation: TypeSafeObservation | undefined,
  judgment?: ClassificationJudgment,
  reliabilityStore?: ReliabilityStore,
  config?: BifrostConfig,
): DirectClassifierAttempt {
  const model = boundedClassifierModel(observation?.model);
  const circuitKey = model ? `classifier/${backend}/${model}` : undefined;
  const circuit = circuitKey && reliabilityStore && config?.reliability?.enabled !== false
    ? getCircuitState(reliabilityStore.getState(), circuitKey, Date.now(), config?.reliability)
    : undefined;
  const circuitOpenUntil = circuit?.open && Number.isSafeInteger(circuit.openUntil)
    && (circuit.openUntil ?? 0) <= MAX_LOGGABLE_CIRCUIT_EPOCH && (circuit.openUntil ?? 0) > Date.now()
    ? circuit.openUntil
    : undefined;
  return {
    kind: "direct-classifier-attempt",
    ...(judgment ? { judgment } : {}),
    ...(observation ? {
      observation: {
        backend,
        outcome: observation.outcome,
        ...(model ? { model } : {}),
        ...(circuitOpenUntil !== undefined ? { circuitOpenUntil } : {}),
      },
    } : {}),
  };
}

function buildPipeline(
  ctx: ExtensionContext,
  config: BifrostConfig,
  cacheEntries: CacheEntry[],
  classifierEnabled: boolean,
  reliabilityStore: ReliabilityStore,
  classifierMetricsStore: ClassifierMetricsStore,
  cacheSemanticKey: string,
  effective: EffectiveBackend,
  isGenerationCircuitUnavailable: (model: string) => boolean,
): ClassificationPipeline {
  const tiers = Object.keys(config.models ?? {});
  const cacheCfg = config.cache;
  const cacheEnabled = classifierCacheEnabled(config, effective.backend);
  const threshold = cacheCfg?.threshold ?? DEFAULT_THRESHOLD;
  const cacheMaxAgeMs = (cacheCfg?.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000;

  // Resolve classifier models once at pipeline construction.
  // If classifier is disabled, pass empty array — pipeline skips LLM stage.
  let classifierModels: ClassifierModel[] = [];
  let classifyDirect: ((text: string, tiers: readonly string[], signal?: AbortSignal) => Promise<DirectClassifierAttempt>) | undefined;
  const directConfigOk = !hasClassifierConfigErrors(config, effective.backend);
  const plan = directStagePlan({
    backend: effective.backend,
    auto: effective.auto,
    classifierEnabled,
    tierCount: tiers.length,
    directConfigOk,
    fallback: config.classifier?.fallback,
  });
  if (plan.directDegraded) {
    for (const message of classifierConfigErrors(config, effective.backend)) {
      console.error(`[bifrost/config] error: ${message}`);
    }
    console.error(`[bifrost/config] auto backend ${effective.backend} is unusable; ${plan.usePromptFallback ? "using prompt classifier fallback" : "regex/default fallback only"}. Fix the errors above or pin classifier.backend.`);
  }
  if (plan.useDirect && effective.backend === CLASSIFIER_BACKEND_IDS.typesafe) {
    const classifierConfig = config.classifier!;
    const classify = createTypeSafeClassifier({
      timeoutMs: classifierConfig.typesafe?.timeoutMs,
      maxAttempts: classifierConfig.typesafe?.maxAttempts,
      debug: Boolean(config.debug?.enabled && classifierConfig.typesafe?.debug),
      minConfidence: classifierConfig.minConfidence,
      reliability: reliabilityStore,
      observe: (observation) => classifierMetricsStore.record(observation),
    });
    classifyDirect = async (text, availableTiers, signal) => {
      let observation: TypeSafeObservation | undefined;
      const judgment = await classify(
        { prompt: boundedClassifierPrompt(text), tiers: availableTiers, criteria: classifierConfig.criteria ?? DEFAULT_CLASSIFIER_CRITERIA },
        signal,
        (value) => { observation = value; },
      );
      return directClassifierAttempt("typesafe", observation, judgment, reliabilityStore, config);
    };
  }
  if (plan.useDirect && effective.backend === CLASSIFIER_BACKEND_IDS.piNative) {
    const classify = createPiNativeClassifier({
      registry: ctx.modelRegistry,
      model: config.classifier?.piNative?.model,
      timeoutMs: config.classifier?.piNative?.timeoutMs,
      maxAttempts: config.classifier?.piNative?.maxAttempts,
      debug: Boolean(config.debug?.enabled),
      minConfidence: config.classifier?.minConfidence,
      reliability: reliabilityStore,
      credentialMissing: () => piNativeCredentialMissing(
        (providerId) => ctx.modelRegistry.getProviderAuthStatus(providerId),
        resolveTypeSafeApiKey().source !== "missing",
      ),
      observe: (observation) => classifierMetricsStore.record(observation),
    });
    classifyDirect = async (text, availableTiers, signal) => {
      let observation: TypeSafeObservation | undefined;
      const judgment = await classify(
        { prompt: boundedClassifierPrompt(text), tiers: availableTiers, criteria: config.classifier?.criteria ?? DEFAULT_CLASSIFIER_CRITERIA },
        signal,
        (value) => { observation = value; },
      );
      return directClassifierAttempt("pi-native", observation, judgment, reliabilityStore, config);
    };
  }
  const usePromptClassifier = plan.usePromptFallback;
  if (usePromptClassifier) {
    const classifierEndpoint = config.classifier?.endpoint;
    if (classifierEndpoint) {
      const rawModel = config.classifier?.model;
      const modelIds = Array.isArray(rawModel) ? rawModel : [rawModel ?? "classifier"];
      classifierModels = modelIds.map((modelId) => endpointClassifier(modelId, classifierEndpoint));
    } else {
      classifierModels = resolveClassifierModels(ctx, config);
    }
  }

  return createPipeline({
    classifyDirect,
    totalTimeoutMs: config.classifier?.totalTimeoutMs,
    cacheLookup: (text) => {
      if (!cacheEnabled) return undefined;
      const entry = lookupCache(cacheEntries, text, threshold, cacheSemanticKey, cacheMaxAgeMs);
      if (entry) {
        touchCacheEntry(entry);
        return entry.category;
      }
      return undefined;
    },
    classifierModels,
    classifyWithLLM: async (model, text, tiers, signal) => {
      if (model.kind === "registry") {
        const key = modelKey(model.model);
        if (config.reliability?.enabled !== false
          && config.reliability?.cooldownOnAllowanceExhausted !== false
          && config.reliability?.stateVersion !== 2
          && hasActiveAllowanceCooldown(reliabilityStore.getState(), key, Date.now())) {
          debug("classifier", "allowance_cooldown_skip", { model: key, scope: "model-only" });
          return undefined;
        }
        if (config.reliability?.enabled !== false
          && config.reliability?.stateVersion === 2
          && isGenerationCircuitUnavailable(key)) {
          debug("classifier", "generation_circuit_unavailable_skip", { model: key, scope: "model-only" });
          return undefined;
        }
      }
      const tier = await invokeClassifier(ctx, model, tiers, boundedClassifierPrompt(text), {
        systemPrompt: config.classifier?.systemPrompt,
        maxTokens: config.classifier?.maxTokens,
        temperature: config.classifier?.temperature,
        method: config.classifier?.method,
      }, signal);
      if (!tier) return undefined;
      return {
        tier,
        backend: CLASSIFIER_BACKEND_IDS.prompt,
        model: model.kind === "registry" ? `${model.model.provider}/${model.model.id}` : model.id,
      };
    },
    regexRules: loadRules(process.cwd(), config),
    defaultTier: config.default,
    tiers,
  });
}

export default function bifrostExtension(pi: ExtensionAPI) {
  const extensionDir = fileURLToPath(new URL(".", import.meta.url));

  // Setup debug logging first — so startup errors are captured.
  const bootConfig = loadConfig(process.cwd(), extensionDir);
  setupDebug(bootConfig.debug ?? { enabled: false }, process.cwd());
  if (bootConfig.debug?.enabled) {
    debugLifecycle("bifrost", "startup", undefined, undefined, {
      extensionDir,
      processId: process.pid,
      runtimeVersion: process.version,
      routingMode: bootConfig.reliability?.stateVersion === 2 && bootConfig.reliability.enabled !== false ? "reliability_v2" : "reliability_v1",
      enabled: bootConfig.enabled === false ? false : true,
    });
  }

  const config = bootConfig;
  const detectionEngine = createDetectionEngine();

  // Validate config on startup. Errors are logged; the extension
  // continues with best-effort routing for warnings.
  const configIssues = validateConfig(config);
  if (config.classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe && resolveTypeSafeApiKey().source === "missing") {
    console.warn(`[bifrost/config] warning: TypeSafe classifier unavailable; configure typesafe in ~/.pi/agent/auth.json or set ${TYPE_SAFE_API_KEY_ENV}`);
  }
  for (const issue of configIssues) {
    const tag = issue.severity === "error" ? "error" : "warning";
    console.error(`[bifrost/config] ${tag}: ${issue.message}`);
  }
  const cacheTtlMs = (config.cache?.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
  const cacheEntries = loadCache(cachePath(process.cwd(), config.cache?.path), cacheTtlMs);
  const reliabilityStore = new ReliabilityStore({ cwd: process.cwd(), config: config.reliability });
  const classifierMetricsStore = new ClassifierMetricsStore({
    cwd: process.cwd(),
    enabled: classifierMetricsEnabled(config, effectiveBackendOf(config, detectionEngine).backend),
  });
  const runtimeStateFile = runtimeStatePath(process.cwd());
  const runtimeState = loadRuntimeState(runtimeStateFile, {
    enabled: config.enabled ?? true,
    pinned: false,
    classifierEnabled: config.classifier?.enabled ?? true,
  });
  // Programmatic activation keys, scoped per session: two sessions selecting
  // the same model concurrently must never swallow each other's event (#17).
  const selfSelect = createSelfSelectTracker();
  let offeredSetup = false;
  // One extension runtime can host several sessions: scope mutable routing
  // state per session so concurrent sessions cannot consume each other's
  // prompt handoffs or reliability outcomes.
  const overridesBySession = new WeakMap<object, VirtualOverride>();
  const trackersBySession = new WeakMap<object, RuntimeReliabilityTracker>();
  const v2Receipts = new AutoDispatchReceiptBook();
  interface PendingAffinityProof {
    readonly userEntryId: string;
    readonly userMessage: WeakRef<object>;
    readonly modelKey: string;
    readonly dispatchId: string;
    outcome?: "success" | "failure" | "unknown";
    assistantEntryId?: string;
    successObservedAt?: number;
  }
  const usesRuntimeAffinity = (value: BifrostConfig): boolean =>
    value.affinity?.mode === "observe" || value.affinity?.mode === "retain-within-tier";
  let affinityStore: RuntimeAffinityStore | undefined = usesRuntimeAffinity(config) ? createRuntimeAffinityStore() : undefined;
  let pendingAffinityBySession = new WeakMap<object, Map<string, PendingAffinityProof>>();
  function pendingAffinity(session: object, create = false): Map<string, PendingAffinityProof> | undefined {
    let pending = pendingAffinityBySession.get(session);
    if (!pending && create) {
      pending = new Map();
      pendingAffinityBySession.set(session, pending);
    }
    return pending;
  }
  function affinityAnchor(ctx: ExtensionContext): AffinityAnchor | undefined {
    const anchor = affinityStore?.read(ctx.sessionManager, ctx.sessionManager.getBranch());
    return anchor ? { modelKey: anchor.modelKey, provider: anchor.provider, lastSuccessfulDispatchAt: anchor.observedAt } : undefined;
  }
  function affinityProofStillJoined(
    userEntryId: string,
    userMessage: object,
    assistantEntryId: string,
    key: string,
    branch: readonly unknown[],
  ): boolean {
    const entries = branch as readonly SessionMessageEntry[];
    const userIndexes = entries.flatMap((entry, index) => entry.type === "message" && entry.id === userEntryId && entry.message === userMessage ? [index] : []);
    const assistantIndexes = entries.flatMap((entry, index) => entry.type === "message" && entry.id === assistantEntryId
      && entry.message.role === "assistant" && `${entry.message.provider}/${entry.message.model}` === key ? [index] : []);
    if (userIndexes.length !== 1 || assistantIndexes.length !== 1 || assistantIndexes[0]! <= userIndexes[0]!) return false;
    for (let index = assistantIndexes[0]! - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.type === "message" && entry.message.role === "user") return entry.id === userEntryId && entry.message === userMessage;
    }
    return false;
  }
  function promoteAffinityProof(
    session: object,
    proof: Omit<RuntimeAffinitySuccessProof, "dispatchUnambiguous" | "physicalDispatch" | "outcome"> & { userEntryId: string; userMessage: object },
    branch: readonly unknown[],
  ): boolean {
    if (!affinityStore || !affinityProofStillJoined(proof.userEntryId, proof.userMessage, proof.branchEntryId, proof.modelKey, branch)) return false;
    return affinityStore.promote(session, {
      outcome: "success",
      modelKey: proof.modelKey,
      branchEntryId: proof.branchEntryId,
      dispatchId: proof.dispatchId,
      dispatchUnambiguous: true,
      physicalDispatch: true,
      observedAt: proof.observedAt,
    }, branch);
  }
  function promotePendingAffinity(ctx: ExtensionContext, pending: PendingAffinityProof): boolean {
    const userMessage = pending.userMessage.deref();
    if (!userMessage || pending.outcome !== "success" || !pending.assistantEntryId || pending.successObservedAt === undefined) return false;
    return promoteAffinityProof(ctx.sessionManager, {
      userEntryId: pending.userEntryId,
      userMessage,
      modelKey: pending.modelKey,
      dispatchId: pending.dispatchId,
      branchEntryId: pending.assistantEntryId,
      observedAt: pending.successObservedAt,
    }, ctx.sessionManager.getBranch());
  }
  function finalizePriorAffinityProofs(ctx: ExtensionContext, currentUserEntryId: string): void {
    const pending = pendingAffinity(ctx.sessionManager);
    if (!pending) return;
    for (const [entryId, proof] of pending) {
      if (entryId === currentUserEntryId) continue;
      promotePendingAffinity(ctx, proof);
      pending.delete(entryId);
    }
  }
  function promoteV2ReceiptAffinity(ctx: ExtensionContext, receipt: AutoDispatchReceipt): void {
    const userMessage = receipt.userMessage.deref();
    if (!receipt.affinityEligible || !userMessage || !receipt.assistantEntryId || receipt.successObservedAt === undefined) return;
    promoteAffinityProof(ctx.sessionManager, {
      userEntryId: receipt.userEntryId,
      userMessage,
      modelKey: receipt.modelKey,
      dispatchId: receipt.dispatchId,
      branchEntryId: receipt.assistantEntryId,
      observedAt: receipt.successObservedAt,
    }, ctx.sessionManager.getBranch());
  }
  function overrideFor(ctx: ExtensionContext): VirtualOverride {
    const key = ctx.sessionManager;
    let value = overridesBySession.get(key);
    if (!value) {
      value = new VirtualOverride();
      overridesBySession.set(key, value);
    }
    return value;
  }
  function trackerFor(ctx: ExtensionContext): RuntimeReliabilityTracker {
    const key = ctx.sessionManager;
    let value = trackersBySession.get(key);
    if (!value) {
      value = new RuntimeReliabilityTracker();
      trackersBySession.set(key, value);
    }
    return value;
  }
  let pipeline: ClassificationPipeline | undefined;
  const shouldNotifyDetection = createDetectionNoticeGate();

  function getPipeline(ctx: ExtensionContext): ClassificationPipeline {
    const detected = detectionEngine.detect(() => collectDetectionFacts({
      readStoredCredential,
      getProviderAuthStatus: (providerId) => ctx.modelRegistry.getProviderAuthStatus(providerId),
      env: process.env,
      nativeSupported: piClassificationSupported(ctx.modelRegistry),
    }));
    const effective = selectEffectiveBackend(state.config.classifier?.backend, detected);
    if (effective.auto) {
      state.classifierDetection = { backend: effective.backend, reason: effective.reason };
      if (shouldNotifyDetection(ctx.sessionManager)) {
        debug("classifier", "backend.detected", { backend: effective.backend, reason: effective.reason });
        console.warn(`Bifrost: classifier backend auto: ${effective.backend} (${effective.reason}). Run /bifrost classifier to change.`);
      }
    }
    if (!pipeline) {
      classifierMetricsStore.setEnabled(classifierMetricsEnabled(state.config, effective.backend));
      pipeline = buildPipeline(
        ctx,
        state.config,
        state.cacheEntries,
        state.classifierEnabled,
        reliabilityStore,
        classifierMetricsStore,
        activeClassifierCacheKey(state.config, detectionEngine),
        effective,
        (model) => {
          if (!reliabilityV2Enabled()) return false;
          if (!state.reliabilityV2Store) return true;
          const now = Date.now();
          try {
            const reliability = projectReliabilityV2ForRouting(
              state.reliabilityV2Store.readSnapshot(),
              reliabilityV2Config(state.config.reliability),
              now,
            );
            const circuit = getCircuitState(reliability, model, now, state.config.reliability);
            return circuit.open || circuit.trialActive;
          } catch {
            return true;
          }
        },
      );
    }
    return pipeline;
  }

  function invalidatePipeline() {
    debug("bifrost", "pipeline.invalidate");
    pipeline = undefined;
  }

  // Mutable state shared with command handlers.
  const economicPolicyValid = validateEconomicConfig(config).every((issue) => issue.severity !== "error");
  const initialEconomic = economicPolicyValid
    ? reconcileEconomicSnapshot(undefined, undefined, config.economics)
    : { snapshot: emptyEconomicSnapshot(), diagnostics: [], policy: undefined, historyPolicy: undefined, quarantinedSourceRevisions: new Map() };
  const state: BifrostState = {
    config,
    tierPolicyValid: validateTierPolicyConfig(config).every((issue) => issue.severity !== "error"),
    affinityConfigValid: validateConfig(config).every((issue) => issue.severity !== "error" || !issue.code?.startsWith("config.affinity_")),
    reliabilityV2ConfigValid: validateConfig(config).every((issue) => !issue.code?.startsWith("config.reliability_")),
    reliabilityV2Store: config.reliability?.stateVersion === 2 && config.reliability.enabled !== false
      && validateConfig(config).every((issue) => !issue.code?.startsWith("config.reliability_"))
      ? createReliabilityV2Store(process.cwd(), config.reliability)
      : undefined,
    configGeneration: 0,
    economicSnapshot: initialEconomic.snapshot,
    economicPolicy: initialEconomic.policy,
    economicHistoryPolicy: initialEconomic.historyPolicy,
    economicPolicyValid,
    economicDiagnostics: initialEconomic.diagnostics,
    economicQuarantinedSourceRevisions: initialEconomic.quarantinedSourceRevisions,
    enabled: runtimeState.enabled,
    classifierEnabled: runtimeState.classifierEnabled,
    pinned: runtimeState.pinned,
    cacheEntries,
    reliabilityStore,
    classifierMetricsStore,
    extensionDir,
    getAffinityAnchor: affinityAnchor,
    effectiveClassifierBackend: (config) => effectiveBackendOf(config, detectionEngine),
    getPipeline,
    invalidatePipeline,
    saveModeState: () => saveRuntimeState(runtimeStateFile, {
      enabled: state.enabled,
      classifierEnabled: state.classifierEnabled,
    }),
    lastRegistryRefreshAt: undefined,
    forceRegistryRefresh: false,
  };

  state.onConfigInstalled = (nextConfig, previousConfig) => {
    const previousReliability = previousConfig.reliability;
    const nextReliability = nextConfig.reliability;
    const keepActiveV2Store = previousReliability?.stateVersion === 2 && previousReliability.enabled !== false
      && nextReliability?.stateVersion === 2 && nextReliability.enabled !== false
      && (previousReliability.failureThreshold ?? 3) === (nextReliability.failureThreshold ?? 3)
      && (previousReliability.windowMinutes ?? 5) === (nextReliability.windowMinutes ?? 5)
      && (previousReliability.cooldownMinutes ?? 60) === (nextReliability.cooldownMinutes ?? 60)
      && (previousReliability.cooldownOnAllowanceExhausted ?? true) === (nextReliability.cooldownOnAllowanceExhausted ?? true)
      && (previousReliability.observations?.enabled ?? false) === (nextReliability.observations?.enabled ?? false);
    state.configGeneration = (state.configGeneration ?? 0) + 1;
    debugLifecycle("config", "installed", undefined, undefined, {
      generation: state.configGeneration,
      reliabilityMode: nextConfig.reliability?.stateVersion === 2 && nextConfig.reliability.enabled !== false ? "reliability_v2" : "reliability_v1",
      routingEnabled: nextConfig.enabled === false ? false : true,
    });
    state.affinityConfigValid = validateConfig(nextConfig).every((issue) => issue.severity !== "error" || !issue.code?.startsWith("config.affinity_"));
    state.reliabilityV2ConfigValid = validateConfig(nextConfig).every((issue) => !issue.code?.startsWith("config.reliability_"));
    state.reliabilityV2Store = keepActiveV2Store && state.reliabilityV2ConfigValid
      ? state.reliabilityV2Store
      : nextConfig.reliability?.stateVersion === 2 && nextConfig.reliability.enabled !== false && state.reliabilityV2ConfigValid
        ? createReliabilityV2Store(process.cwd(), nextConfig.reliability)
        : undefined;
    // Existing receipts retain their originating store and config generation;
    // a later route/settlement abandons those exact leases without touching a
    // newer runtime's state.
    if (!keepActiveV2Store || !state.reliabilityV2ConfigValid) {
      for (const session of v2Receipts.knownSessions()) void cleanupV2Receipts(session);
    }
    affinityStore = usesRuntimeAffinity(nextConfig) ? createRuntimeAffinityStore() : undefined;
    pendingAffinityBySession = new WeakMap();
  };

  state.onManualControl = (session, action) => {
    debugLifecycle("bifrost", "manual_control", session, undefined, {
      action: action ?? "model_select",
      category: "routing_ownership_reset",
    });
    v2Receipts.advanceManual(session);
    void cleanupV2Receipts(session, "cancelled");
    affinityStore?.reset(session);
    pendingAffinityBySession.delete(session);
  };

  interface AutoUserBoundary {
    readonly sessionId: string;
    readonly entryId: string;
    readonly message: object;
    readonly branchEpoch: number;
    readonly manualGeneration: number;
    readonly configGeneration: number;
  }

  function findAutoUserBoundary(ctx: ExtensionContext, request: ModelRouteRequest): AutoUserBoundary | undefined {
    const branch = ctx.sessionManager.getBranch();
    const latestBranchUser = branch.filter((entry): entry is SessionMessageEntry =>
      entry.type === "message" && entry.message.role === "user").at(-1);
    const sessionId = ctx.sessionManager.getHeader()?.id;
    if (!latestBranchUser || !sessionId || !request.messages.some((message) => message === latestBranchUser.message)) return undefined;
    const matches = branch.filter((entry) => entry.type === "message" && entry.message === latestBranchUser.message);
    if (matches.length !== 1) return undefined;
    const owner = v2Receipts.forSession(ctx.sessionManager);
    return {
      sessionId,
      entryId: latestBranchUser.id,
      message: latestBranchUser.message,
      branchEpoch: owner.branchEpoch,
      manualGeneration: owner.manualGeneration,
      configGeneration: state.configGeneration ?? 0,
    };
  }

  function debugRequestTurn(ctx: ExtensionContext, request: ModelRouteRequest): object | undefined {
    if (!isDebugEnabled()) return undefined;
    try {
      const branch = ctx.sessionManager.getBranch();
      const latestUser = branch.filter((entry): entry is SessionMessageEntry =>
        entry.type === "message" && entry.message.role === "user").at(-1);
      if (!latestUser || !request.messages.some((message) => message === latestUser.message)) return undefined;
      const matches = branch.filter((entry) => entry.type === "message" && entry.message === latestUser.message);
      return matches.length === 1 ? latestUser.message : undefined;
    } catch { return undefined; }
  }

  function autoBoundarySessionManualBranchActive(ctx: ExtensionContext, boundary: AutoUserBoundary): boolean {
    if (ctx.sessionManager.getHeader()?.id !== boundary.sessionId) return false;
    const owner = v2Receipts.forSession(ctx.sessionManager);
    if (owner.branchEpoch !== boundary.branchEpoch || owner.manualGeneration !== boundary.manualGeneration || !state.enabled || state.pinned) return false;
    const branch = ctx.sessionManager.getBranch();
    const matches = branch.filter((entry) =>
      entry.type === "message" && entry.id === boundary.entryId && entry.message === boundary.message);
    const latestUser = branch.filter((entry): entry is SessionMessageEntry =>
      entry.type === "message" && entry.message.role === "user").at(-1);
    return matches.length === 1 && latestUser?.id === boundary.entryId && latestUser.message === boundary.message;
  }

  function autoBoundaryStillActive(ctx: ExtensionContext, boundary: AutoUserBoundary): boolean {
    return autoBoundarySessionManualBranchActive(ctx, boundary)
      && (state.configGeneration ?? 0) === boundary.configGeneration;
  }

  function turnUserBoundary(ctx: ExtensionContext, event: TurnEndEvent): { entryId: string; message: object } | undefined {
    const branch = ctx.sessionManager.getBranch();
    const assistantIndexes = branch.flatMap((entry, index) =>
      entry.type === "message" && entry.id === event.messageEntryId && entry.message === event.message
        ? [index] : []);
    if (assistantIndexes.length !== 1 || event.message.role !== "assistant") return undefined;
    for (let index = assistantIndexes[0]! - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (entry.type === "message" && entry.message.role === "user") return { entryId: entry.id, message: entry.message };
    }
    return undefined;
  }

  async function settleV2Receipt(ctx: ExtensionContext, receipt: AutoDispatchReceipt, kind: "success" | "failure" | "cancelled"): Promise<void> {
    receipt.finalizing = true;
    let settlementConfirmed = false;
    try {
      await serializeReceiptOperation(receipt, async () => {
        if (receipt.finalized) return;
        if (kind === "cancelled") {
          const result = await receipt.store.abandon({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId, leaseReferences: receipt.leases });
          debugLifecycle("reliability", "receipt_abandoned", ctx.sessionManager, receipt.userMessage.deref(), {
            model: receipt.modelKey,
            status: result.status === "abandoned" || result.status === "duplicate" ? "confirmed" : "rejected",
            category: result.status === "abandoned" || result.status === "duplicate" ? "receipt_released" : "receipt_release_unconfirmed",
          });
          if (result.status !== "abandoned" && result.status !== "duplicate") {
            try { log(ctx, `Bifrost reliability v2 could not confirm receipt release (${result.status}); inspect local reliability state.`, "warning"); } catch { /* best effort */ }
          }
          return;
        }
        const policyAllowanceEvidence = state.config.reliability?.cooldownOnAllowanceExhausted !== false
          && receipt.failureObservation?.category === "allowance_exhausted"
          && receipt.failureObservation.source === "runtime"
          ? receipt.failureObservation : undefined;
        const recordedObservation = receipt.observationsEnabled ? receipt.failureObservation : undefined;
        const result = await receipt.store.settle({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId,
          settlement: kind === "success" ? { kind: "success" } : {
            kind: "failure",
            ...(recordedObservation ? { observation: recordedObservation } : {}),
            ...(policyAllowanceEvidence ? { allowanceExhaustion: policyAllowanceEvidence } : {}),
          } });
        settlementConfirmed = result.status === "settled" || result.status === "duplicate";
        debugLifecycle("reliability", "receipt_settled", ctx.sessionManager, receipt.userMessage.deref(), {
          model: receipt.modelKey,
          outcome: kind,
          status: settlementConfirmed ? "confirmed" : "rejected",
          category: kind === "failure" && receipt.failureObservation?.category === "allowance_exhausted"
            ? "allowance_exhausted" : settlementConfirmed ? "receipt_settled" : "receipt_settlement_unconfirmed",
          ...(receipt.failureObservation?.category === "allowance_exhausted" ? {
            evidence: receipt.failureObservation.categoryEvidence,
            scope: "model-only",
          } : {}),
        });
        if (result.status !== "settled" && result.status !== "duplicate") {
          try { log(ctx, `Bifrost reliability v2 could not confirm receipt settlement (${result.status}); inspect local reliability state.`, "warning"); } catch { /* best effort */ }
        }
      });
      if (kind === "failure" && settlementConfirmed && receipt.failureObservation?.category === "allowance_exhausted") {
        const enabled = state.config.reliability?.enabled !== false;
        const cooldownEnabled = state.config.reliability?.cooldownOnAllowanceExhausted !== false;
        let openUntil: number | undefined;
        try { openUntil = receipt.store.readSnapshot().scopes[`model:${receipt.modelKey.length}:${receipt.modelKey}`]?.openUntil; } catch { /* warning remains best-effort */ }
        if (enabled && cooldownEnabled && openUntil !== undefined) {
          const until = Number.isSafeInteger(openUntil) && openUntil <= 8.64e15 ? new Date(openUntil).toISOString() : "the configured cooldown";
          try { log(ctx, `Bifrost: ${receipt.modelKey} reported allowance exhaustion (${receipt.failureObservation.categoryEvidence}); a model-only cooldown applies until ${until}. Shared provider/account scope is unknown; other models were not blocked. The failed prompt was not replayed.`, "warning"); } catch { /* best effort */ }
        } else if (!cooldownEnabled) {
          try { log(ctx, `Bifrost: ${receipt.modelKey} reported allowance exhaustion (${receipt.failureObservation.categoryEvidence}); the immediate model cooldown is disabled by config, so the ordinary failure threshold applies.`, "warning"); } catch { /* best effort */ }
        }
      }
      if (kind === "success" && settlementConfirmed) promoteV2ReceiptAffinity(ctx, receipt);
    } catch {
      debugLifecycle("reliability", kind === "cancelled" ? "receipt_abandoned" : "receipt_settled", ctx.sessionManager, receipt.userMessage.deref(), {
        model: receipt.modelKey,
        outcome: kind,
        status: "rejected",
        category: "receipt_store_error",
      });
      try { log(ctx, "Bifrost reliability v2 could not confirm receipt settlement; inspect local reliability state.", "warning"); } catch { /* no throw from receipt cleanup */ }
    } finally {
      v2Receipts.remove(ctx.sessionManager, receipt);
    }
  }

  async function cleanupV2Receipts(session: object, kind: "cancelled" = "cancelled"): Promise<void> {
    const owner = v2Receipts.forSession(session);
    for (const receipt of [...owner.receipts.values()]) {
      receipt.finalizing = true;
      try {
        await serializeReceiptOperation(receipt, async () => {
          if (!receipt.finalized) {
            const result = await receipt.store.abandon({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId, leaseReferences: receipt.leases });
            debugLifecycle("reliability", "receipt_abandoned", session, receipt.userMessage.deref(), {
              model: receipt.modelKey,
              status: result.status === "abandoned" || result.status === "duplicate" ? "confirmed" : "rejected",
              category: result.status === "abandoned" || result.status === "duplicate" ? "receipt_released" : "receipt_release_unconfirmed",
            });
            if (result.status !== "abandoned" && result.status !== "duplicate") {
              console.warn(`[bifrost] reliability v2 could not confirm receipt release (${result.status}); inspect local reliability state.`);
            }
          }
        });
      } catch {
        debugLifecycle("reliability", "receipt_abandoned", session, receipt.userMessage.deref(), {
          model: receipt.modelKey,
          status: "rejected",
          category: "receipt_store_error",
        });
        /* lifecycle cleanup is best effort and never escapes Pi's hook */
      }
      v2Receipts.remove(session, receipt);
    }
    void kind;
  }

  async function renewV2Receipt(ctx: ExtensionContext, receipt: AutoDispatchReceipt): Promise<void> {
    if (receipt.leases.length === 0) return;
    try {
      const result = await serializeReceiptOperation(receipt, async () => {
        if (receipt.finalized || receipt.finalizing) return undefined;
        return receipt.store.renew({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId,
          leaseReferences: receipt.leases, ttlMs: V2_LEASE_TTL_MS });
      });
      if (!result) return;
      if (!result || result.status !== "renewed" || !result.leases) {
        receipt.renewalFailed = true;
        debugLifecycle("reliability", "lease_renewal_failed", ctx.sessionManager, receipt.userMessage.deref(), {
          model: receipt.modelKey,
          category: "lease_renewal_unconfirmed",
        });
        try { log(ctx, "Bifrost reliability v2 lease renewal failed; this Auto turn will stop before another provider request.", "error"); } catch { /* best effort */ }
        return;
      }
      receipt.leases = result.leases;
    } catch {
      receipt.renewalFailed = true;
      debugLifecycle("reliability", "lease_renewal_failed", ctx.sessionManager, receipt.userMessage.deref(), {
        model: receipt.modelKey,
        category: "lease_renewal_error",
      });
      try { log(ctx, "Bifrost reliability v2 lease renewal failed; this Auto turn will stop before another provider request.", "error"); } catch { /* best effort */ }
    }
  }

  function startV2Heartbeat(ctx: ExtensionContext, receipt: AutoDispatchReceipt): void {
    if (receipt.leases.length === 0 || receipt.timer) return;
    receipt.timer = setInterval(() => { void renewV2Receipt(ctx, receipt).catch(() => { receipt.renewalFailed = true; }); }, V2_RENEW_INTERVAL_MS);
    receipt.timer.unref?.();
  }

  function reliabilityV2Enabled(config: BifrostConfig = state.config): boolean {
    return config.reliability?.stateVersion === 2 && config.reliability.enabled !== false;
  }

  function resolveForTier(
    ctx: ExtensionContext,
    tier: string,
    affinityContext?: AffinityRoutingContext,
    bypassV2Snapshot = false,
  ) {
    const reliabilityState = reliabilityV2Enabled() && !bypassV2Snapshot
      ? projectReliabilityV2ForRouting(
          state.reliabilityV2Store?.readSnapshot(),
          reliabilityV2Config(state.config.reliability),
          Date.now(),
        )
      : state.reliabilityStore.getState();
    return resolveConfiguredTier(
      ctx,
      tier,
      state.config,
      reliabilityState,
      state.config.reliability,
      undefined,
      state.config.economics && state.economicPolicyValid && state.economicPolicy && state.economicSnapshot
        ? { policy: state.economicPolicy, snapshot: state.economicSnapshot }
        : undefined,
      undefined,
      affinityContext,
    );
  }

  function saveClassifierDecision(prompt: string, result: ClassificationResult): void {
    try {
      if (result.kind !== "classified" || result.source !== "classifier"
        || !classifierCacheEnabled(state.config, effectiveBackendOf(state.config, detectionEngine).backend)) return;
      const maxEntries = state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES;
      state.cacheEntries = updateCache(state.cacheEntries, prompt, result.tier, maxEntries, activeClassifierCacheKey(state.config, detectionEngine));
      saveCache(cachePath(process.cwd(), state.config.cache?.path), state.cacheEntries);
      invalidatePipeline();
    } catch (error) {
      // Cache persistence must never fail the route.
      debug("virtual", "cache.save_error", { category: "cache_write_failed" });
    }
  }

  state.selectPhysicalFromVirtual = async (ctx) => {
    if (!isBifrostAuto(ctx.model)) return true;
    // Prefer the last dispatched model; otherwise resolve the default tier —
    // without requiring v2's dispatch sidecar for this explicit manual exit.
    const physical = lastDispatchedPhysical(ctx)
      ?? (state.config.default ? resolveForTier(ctx, state.config.default, undefined, true).resolution.selected : undefined);
    if (!physical) {
      log(ctx, "Bifrost: no healthy physical model to fall back to; configure a default-tier model or select one in /model", "warning");
      return false;
    }
    selfSelect.claim(ctx.sessionManager, modelKey(physical));
    try {
      if (!(await pi.setModel(physical))) {
        log(ctx, `Bifrost: failed to activate ${modelKey(physical)}; select a physical model in /model`, "error");
        return false;
      }
      overrideFor(ctx).clear();
      return true;
    } catch {
      log(ctx, `Bifrost: cannot activate ${modelKey(physical)}`, "error");
      return false;
    } finally {
      // The key's safety comes from this finally: pi.setModel awaits its
      // model_select emission, but _emitModelSelect early-returns without an
      // event on same-model sets — either way the key dies here.
      selfSelect.release(ctx.sessionManager);
    }
  };

  // Virtual adapter for `bifrost/auto`: selecting it makes Pi dispatch each request
  // through route() below instead of Bifrost switching the active model at input time.
  // - `user` requests classify + select from configured pools (inline tier handoff applies);
  // - `continuation`/`retry` stay sticky so prompt caches and thinking signatures stay valid;
  // - `direct` requests use the last dispatched or default-tier model;
  // - the dispatched thinking level is clamped to the target model's capabilities;
  // - disabled/pinned never dispatches; unresolvable pools fail fresh sessions with an
  //   actionable error and visibly keep the last dispatched model afterwards.
  // Prompts are never replayed. Model identity stays visible in Pi's footer and messages.
  pi.registerVirtualModel({
    provider: BIFROST_AUTO_PROVIDER,
    id: BIFROST_AUTO_ID,
    name: "Bifrost Auto",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    async route(request, ctx) {
      const v2Active = reliabilityV2Enabled();
      const requestReason = request.reason === "user" || request.reason === "retry" || request.reason === "continuation" || request.reason === "direct"
        ? request.reason : "unknown";
      let requestCorrelationId: string | undefined;
      if (isDebugEnabled()) {
        try { requestCorrelationId = randomUUID(); } catch { /* optional correlation */ }
      }
      let correlationTurn: object | undefined = debugRequestTurn(ctx, request);
      debugLifecycle("virtual", "request", ctx.sessionManager, correlationTurn, {
        request_correlation_id: requestCorrelationId ?? null,
        reason: requestReason,
        reliabilityMode: v2Active ? "reliability_v2" : "reliability_v1",
      });
      let autoBoundary: AutoUserBoundary | undefined;
      let dispatchReceipt: AutoDispatchReceipt | undefined;
      let activeRouteTier: string | undefined;
      let rejectionCategory = "preflight_rejection";
      let terminalRouteCategory: string | undefined;
      let activeRouteOrigin = request.reason === "direct" ? "direct" : request.reason === "retry" ? "retry" : request.reason === "continuation" ? "continuation" : "automatic";
      try {
      if (v2Active) {
        if (!state.reliabilityV2ConfigValid) {
          rejectionCategory = "reliability_config_invalid";
          throw new Error("Bifrost reliability v2 config is invalid; fix it and run /bifrost reload.");
        }
        if (!state.reliabilityV2Store) {
          rejectionCategory = "reliability_state_unavailable";
          throw new Error("Bifrost reliability v2 is unavailable; run /bifrost reliability migrate [--fresh] after reviewing the v2 config.");
        }
        try { state.reliabilityV2Store.readSnapshot(); }
        catch {
          rejectionCategory = "reliability_state_unavailable";
          throw new Error("Bifrost reliability v2 state is missing or unavailable; run /bifrost reliability migrate [--fresh] or repair the sidecar before routing.");
        }
        if (!state.enabled || state.pinned) {
          rejectionCategory = "disabled_or_pinned";
          throw new Error("Bifrost Auto is disabled or pinned; turn it on or select Auto again before routing.");
        }
        if (request.reason === "direct") {
          rejectionCategory = "direct_unsupported";
          throw new Error("Bifrost reliability v2 does not support direct utility requests; select Auto for a user turn or use reliability stateVersion 1.");
        }
        autoBoundary = findAutoUserBoundary(ctx, request);
        if (!autoBoundary) {
          rejectionCategory = "boundary_unproven";
          throw new Error("Bifrost reliability v2 could not prove this Auto request belongs to one persisted user turn; the turn was not sent.");
        }
        correlationTurn = autoBoundary.message;
        debugLifecycle("virtual", "boundary", ctx.sessionManager, correlationTurn, { reason: requestReason, status: "proven" });
        const owner = v2Receipts.forSession(ctx.sessionManager);
        if (request.reason === "user") {
          if (v2Receipts.find(ctx.sessionManager, autoBoundary.entryId, autoBoundary.message)) {
            rejectionCategory = "duplicate_turn_receipt";
            throw new Error("Bifrost reliability v2 already owns this user turn; it will not create a second dispatch receipt.");
          }
          for (const previous of [...owner.receipts.values()]) {
            if (previous.userEntryId === autoBoundary.entryId) continue;
            const stale = previous.branchEpoch !== owner.branchEpoch
              || previous.configGeneration !== (state.configGeneration ?? 0)
              || previous.manualGeneration !== owner.manualGeneration;
            await settleV2Receipt(ctx, previous, stale ? "cancelled" : previous.outcome ?? "cancelled");
          }
          if (!autoBoundaryStillActive(ctx, autoBoundary)) {
            rejectionCategory = "boundary_changed";
            throw new Error("Bifrost reliability v2 routing boundary changed; resubmit the turn.");
          }
        } else {
          dispatchReceipt = v2Receipts.find(ctx.sessionManager, autoBoundary.entryId, autoBoundary.message);
          if (!dispatchReceipt) {
            rejectionCategory = "receipt_unowned";
            throw new Error("Bifrost reliability v2 has no owned receipt for this continuation or retry; it will not dispatch without one.");
          }
          if (dispatchReceipt.sessionId !== autoBoundary.sessionId
            || dispatchReceipt.branchEpoch !== autoBoundary.branchEpoch
            || dispatchReceipt.manualGeneration !== autoBoundary.manualGeneration
            || Date.now() >= dispatchReceipt.proofUntil) {
            await settleV2Receipt(ctx, dispatchReceipt, "cancelled");
            dispatchReceipt = undefined;
            rejectionCategory = "receipt_stale";
            throw new Error("Bifrost reliability v2 receipt is stale or expired; this continuation was not sent. Start a new user turn.");
          }
          dispatchReceipt.outcome = undefined;
        }
      }
      if (!v2Active && affinityStore && request.reason === "user") {
        autoBoundary = findAutoUserBoundary(ctx, request);
        if (autoBoundary) {
          correlationTurn = autoBoundary.message;
          debugLifecycle("virtual", "boundary", ctx.sessionManager, correlationTurn, { reason: requestReason, status: "proven" });
        }
        if (autoBoundary) finalizePriorAffinityProofs(ctx, autoBoundary.entryId);
      }
      } catch (error) {
        debugLifecycle("virtual", "route_rejected", ctx.sessionManager, correlationTurn, {
          request_correlation_id: requestCorrelationId ?? null,
          reason: requestReason,
          category: rejectionCategory,
          reliabilityMode: v2Active ? "reliability_v2" : "reliability_v1",
        });
        throw error;
      }
      let routeFailure: { tier: string; pool: string | string[] | undefined; reason?: RoutedModelResolution["fallbackReason"]; skipped?: readonly SkippedCandidate[]; reserveExcluded?: ReserveExclusionSummary; explicitBoundary?: boolean; message?: string } | undefined;
      const ownership = createDispatchOwnership({
        claimTrial: (key) => state.reliabilityStore.tryClaimTrial(key),
        abandonTrial: (key) => state.reliabilityStore.abandonTrial(key),
        begin: (key) => trackerFor(ctx).begin(key),
        release: (key) => trackerFor(ctx).release(key),
      });
      const route = createVirtualRoute({
        overrides: overrideFor(ctx),
        fallback: () => routeFailure?.explicitBoundary || v2Active ? undefined : lastDispatchedPhysical(ctx) ?? (state.config.default ? resolveForTier(ctx, state.config.default).resolution.selected : undefined),
        sticky: () => routeFailure?.explicitBoundary || v2Active ? undefined : lastDispatchedPhysical(ctx),
        select: async (prompt, forcedTier, signal) => {
          activeRouteOrigin = forcedTier ? "explicit_tier" : "automatic";
          if (routingPolicyInvalid(state)) {
            terminalRouteCategory = "routing_policy_invalid";
            const tier = state.config.default ?? "default";
            routeFailure = {
              tier,
              pool: state.config.models?.[tier],
              explicitBoundary: true,
              message: "Bifrost Auto is blocked by invalid routing policy config; fix it and run /bifrost reload",
            };
            throw new Error(routeFailure.message);
          }
          if (!state.enabled || state.pinned) {
            terminalRouteCategory = "disabled_or_pinned";
            throw new Error("Bifrost: virtual auto is disabled or pinned; select a physical model");
          }
          if (state.classifierEnabled && shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS)) {
            try {
              const outcome = await waitForRegistryRefresh(
                (refreshSignal) => ctx.modelRegistry.refresh(refreshSignal ? { signal: refreshSignal } : undefined),
                signal,
                (result) => updateRegistryInventoryEvidence(state, ctx, result),
              );
              if (outcome === "aborted") {
                terminalRouteCategory = "request_cancelled";
                updateRegistryInventoryEvidence(state, ctx);
                throw new Error("Bifrost: model registry refresh aborted");
              }
              state.lastRegistryRefreshAt = Date.now();
              state.forceRegistryRefresh = false;
              invalidatePipeline();
            } catch (error) {
              updateRegistryInventoryEvidence(state, ctx);
              if (signal?.aborted) {
                terminalRouteCategory = "request_cancelled";
                throw error;
              }
              debug("virtual", "registry.refresh.error", { category: "registry_refresh_failure" });
            }
          }
          if (!state.enabled || state.pinned) {
            terminalRouteCategory = "disabled_or_pinned";
            throw new Error("Bifrost: virtual auto was disabled or pinned during routing; select a physical model");
          }
          const classificationConfig = state.config;
          let classification: ClassificationResult = forcedTier
            ? { kind: "classified", tier: forcedTier, source: "inline" }
            : await getPipeline(ctx).classify(prompt, signal);
          if (!signal?.aborted) reportClassifierAttempt(ctx, classification, correlationTurn, requestCorrelationId);
          if (classification.kind === "unclassified" && hasHardEconomicAdmission(state.economicPolicy) && state.config.default) {
            classification = { kind: "fallback", tier: state.config.default, ...(classification.classifierAttempt ? { classifierAttempt: classification.classifierAttempt } : {}) };
          }
          if (signal?.aborted) {
            terminalRouteCategory = "request_cancelled";
            throw new Error("Bifrost: route aborted");
          }
          if (!state.enabled || state.pinned) {
            terminalRouteCategory = "disabled_or_pinned";
            throw new Error("Bifrost: virtual auto was disabled or pinned during routing; select a physical model");
          }
          if (!forcedTier && state.config !== classificationConfig) {
            terminalRouteCategory = "config_changed_during_route";
            throw new Error("Bifrost: configuration changed during routing; retry the turn");
          }
          if (classification.kind === "unclassified") {
          if (hasHardEconomicAdmission(state.economicPolicy)) {
              routeFailure = { tier: "default", pool: state.config.models?.[state.config.default ?? "default"], explicitBoundary: true };
            }
            terminalRouteCategory = "unclassified_request";
            throw new Error("Bifrost: no configured tier for virtual request");
          }
          const classifierIdentity = classification.kind === "classified" && classification.judgment
            ? { classifierBackend: classification.judgment.backend, classifierModel: classification.judgment.model }
            : {};
          // Resolve from current config on every attempt. A registry refresh
          // may overlap /bifrost reload, so options cannot be captured ahead.
          let routeStart = performance.now();
          const affinity: AffinityRoutingContext | undefined = affinityStore
            ? { intrinsicOrigin: activeRouteOrigin, ...(activeRouteOrigin === "automatic" ? (() => { const anchor = affinityAnchor(ctx); return anchor ? { anchor } : {}; })() : {}) }
            : undefined;
          let attempt = resolveForTier(ctx, classification.tier, affinity);
          let routingDurationMs = +(performance.now() - routeStart).toFixed(3);
          let resolved = attempt.resolution;
          if (!resolved.selected && resolved.primary.candidates.length === 0) {
            // Registry merge can lag the first request; one bounded refresh + re-resolve.
            try {
              const outcome = await waitForRegistryRefresh(
                (refreshSignal) => ctx.modelRegistry.refresh(refreshSignal ? { signal: refreshSignal } : undefined),
                signal,
                (result) => updateRegistryInventoryEvidence(state, ctx, result),
              );
              if (outcome === "aborted") {
                updateRegistryInventoryEvidence(state, ctx);
                throw new Error("Bifrost: model registry refresh aborted");
              }
              state.lastRegistryRefreshAt = Date.now();
              state.forceRegistryRefresh = false;
              invalidatePipeline();
              routeStart = performance.now();
              attempt = resolveForTier(ctx, classification.tier, affinity);
              routingDurationMs += +(performance.now() - routeStart).toFixed(3);
              resolved = attempt.resolution;
            } catch (error) {
              updateRegistryInventoryEvidence(state, ctx);
              if (signal?.aborted) throw error;
              debug("virtual", "registry.refresh.error", { category: "registry_refresh_failure" });
            }
          }
          if (state.config.debug?.enabled) {
            debugLifecycle("virtual", "route_decision", ctx.sessionManager, correlationTurn, {
              request_correlation_id: requestCorrelationId ?? null,
              decision: buildRouteDecisionSummary(classification, attempt),
              routingDurationMs,
            });
          }
          const model = resolved.selected;
          if (!model) {
            state.forceRegistryRefresh = true;
            const priorPhysical = request.reason === "user" && !v2Active
              && state.config.reliability?.enabled !== false
              && state.config.reliability?.cooldownOnAllowanceExhausted !== false
              ? lastDispatchedPhysical(ctx) : undefined;
            const blockedStickyModel = priorPhysical
              && hasActiveAllowanceCooldown(state.reliabilityStore.getState(), modelKey(priorPhysical), Date.now());
            routeFailure = {
              tier: classification.tier,
              pool: state.config.models?.[classification.tier],
              reason: resolved.fallbackReason,
              skipped: resolved.skipped,
              reserveExcluded: reserveExclusionSummary(resolved),
              explicitBoundary: resolved.explicitBoundary || hasHardEconomicAdmission(state.economicPolicy) || v2Active || blockedStickyModel,
              ...(blockedStickyModel ? {
                message: `Bifrost: the last dispatched model is on an active model-only allowance cooldown and no configured alternative resolved for tier ${classification.tier}; no model was dispatched. Wait for cooldown or select another tier/model.`,
              } : {}),
            };
            debug("virtual", "fail", { tier: classification.tier, reason: resolved.fallbackReason, pool: routeFailure.pool, skipped: resolved.skipped });
            debugLifecycle("virtual", "no_route", ctx.sessionManager, correlationTurn, {
              request_correlation_id: requestCorrelationId ?? null,
              reason: requestReason,
              tier: classification.tier,
              category: resolved.fallbackReason ?? "no_eligible_model",
              reliabilityMode: v2Active ? "reliability_v2" : "reliability_v1",
            });
            return undefined;
          }
          activeRouteTier = resolved.selectedTier ?? classification.tier;
          if (!state.enabled || state.pinned) throw new Error("Bifrost: virtual auto was disabled or pinned during routing; select a physical model");
          debug("virtual", "select", { tier: classification.tier, model: modelKey(model), source: classification.kind === "classified" ? classification.source : "fallback", ...classifierIdentity, skipped: resolved.skipped, routingDurationMs });
          debugLifecycle("virtual", "selected", ctx.sessionManager, correlationTurn, {
            request_correlation_id: requestCorrelationId ?? null,
            reason: requestReason,
            model: modelKey(model),
            tier: activeRouteTier,
            origin: activeRouteOrigin,
            source: classification.kind === "classified" ? classification.source : "fallback",
            reliabilityMode: v2Active ? "reliability_v2" : "reliability_v1",
          });
          saveClassifierDecision(prompt, classification);
          log(ctx, `Bifrost auto: ${classification.tier} → ${modelKey(model)} (${classification.kind === "classified" ? classification.source : "fallback"}${resolved.fallbackReason ? `; ${resolved.fallbackReason}` : ""}${resolved.skipped.length > 0 ? `; ${resolved.skipped.length} skipped: ${resolved.skipped.map((s) => s.key).join(", ")}` : ""})`);
          return model;
        },
        onDispatch: (model, thinkingLevel, intent) => {
          const key = modelKey(model);
          debugLifecycle("virtual", "dispatch", ctx.sessionManager, correlationTurn, {
            request_correlation_id: requestCorrelationId ?? null,
            model: key,
            reason: requestReason,
            intent,
            reliabilityMode: v2Active ? "reliability_v2" : "reliability_v1",
          });
          if (v2Active) {
            debug("virtual", "dispatch", { model: key, thinkingLevel, reliabilityStateVersion: 2 });
            return;
          }
          ownership.claim(key, intent, (trial) => debug("virtual", "trial", { model: key, allowed: trial.allowed, claimed: trial.claimed }));
          debug("virtual", "dispatch", { model: key, thinkingLevel });
        },
        beforeDispatch: async (model, currentRequest, intent) => {
          if (!v2Active) {
            if (affinityStore && activeRouteOrigin === "automatic" && currentRequest.reason === "user" && autoBoundary && !isVirtualModel(model)) {
              pendingAffinity(ctx.sessionManager, true)!.set(autoBoundary.entryId, {
                userEntryId: autoBoundary.entryId,
                userMessage: new WeakRef(autoBoundary.message),
                modelKey: modelKey(model),
                dispatchId: randomUUID(),
              });
            }
            void intent;
            return;
          }
          const boundary = autoBoundary;
          const store = state.reliabilityV2Store;
          if (!boundary || !store || currentRequest.reason === "direct") {
            terminalRouteCategory = currentRequest.reason === "direct" ? "direct_unsupported" : "dispatch_boundary_unavailable";
            throw new Error("Bifrost reliability v2 requires a proven Auto user-turn receipt; direct dispatch is unsupported.");
          }
          if (!autoBoundaryStillActive(ctx, boundary)) {
            terminalRouteCategory = "boundary_changed";
            throw new Error("Bifrost Auto boundary changed before admission; the turn was not sent.");
          }
          if (currentRequest.reason === "user") {
            const key = modelKey(model);
            if (!activeRouteTier) throw new Error("Bifrost reliability v2 could not bind the selected model to a configured tier.");
            const receipt = v2Receipts.create({
              session: ctx.sessionManager,
              sessionId: boundary.sessionId,
              userEntryId: boundary.entryId,
              userMessage: boundary.message,
              configGeneration: boundary.configGeneration,
              modelKey: key,
              tier: activeRouteTier,
              affinityEligible: activeRouteOrigin === "automatic",
              observationsEnabled: state.config.reliability?.observations?.enabled === true,
              admittedAt: Date.now(),
              proofUntil: Date.now() + V2_MAX_DISPATCH_LIFETIME_MS,
              leases: [],
              store,
            });
            dispatchReceipt = receipt;
            debugLifecycle("reliability", "admission_started", ctx.sessionManager, boundary.message, {
              request_correlation_id: requestCorrelationId ?? null,
              model: key,
              tier: receipt.tier,
              reason: requestReason,
            });
            const admission = await store.admit({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId, modelKeys: [key] });
            if (admission.status !== "admitted") {
              terminalRouteCategory = "admission_rejected";
              v2Receipts.remove(ctx.sessionManager, receipt);
              dispatchReceipt = undefined;
              debugLifecycle("reliability", "admission_blocked", ctx.sessionManager, boundary.message, {
                request_correlation_id: requestCorrelationId ?? null,
                model: key,
                tier: receipt.tier,
                status: admission.status,
                category: "admission_rejected",
              });
              const reason = admission.status === "blocked" ? "a circuit is open or another trial owns it" : "reliability state rejected admission";
              throw new Error(`Bifrost reliability v2 blocked ${key}: ${reason}. No provider request was sent.`);
            }
            receipt.leases = admission.leases ?? [];
            receipt.proofUntil = admission.state.dispatches[receipt.dispatchId]?.proofUntil ?? receipt.proofUntil;
            debugLifecycle("reliability", "admitted", ctx.sessionManager, boundary.message, {
              request_correlation_id: requestCorrelationId ?? null,
              model: key,
              tier: receipt.tier,
              status: "admitted",
            });
            if (!autoBoundaryStillActive(ctx, boundary) || state.reliabilityV2Store !== store) {
              terminalRouteCategory = "boundary_changed_during_admission";
              await settleV2Receipt(ctx, receipt, "cancelled");
              dispatchReceipt = undefined;
              throw new Error("Bifrost Auto boundary or configuration changed during admission; the turn was not sent.");
            }
            startV2Heartbeat(ctx, receipt);
            return;
          }
          const receipt = dispatchReceipt;
          const pool = receipt ? state.config.models?.[receipt.tier] : undefined;
          const bindingStillConfigured = receipt && pool !== undefined && findCandidates(ctx, pool).some((candidate) => modelKey(candidate) === receipt.modelKey);
          if (!receipt || receipt.modelKey !== modelKey(model) || receipt.renewalFailed
            || Date.now() >= receipt.proofUntil || !autoBoundarySessionManualBranchActive(ctx, boundary) || !bindingStillConfigured) {
            terminalRouteCategory = "receipt_invalid";
            throw new Error("Bifrost reliability v2 receipt is no longer valid; the continuation was not sent.");
          }
          await renewV2Receipt(ctx, receipt);
          if (receipt.renewalFailed) {
            terminalRouteCategory = "lease_renewal_failed";
            throw new Error("Bifrost reliability v2 could not renew this turn's lease; the continuation was not sent.");
          }
        },
        onDispatchFailed: async (model) => {
          const key = modelKey(model);
          debug("virtual", "dispatch.release", { model: key });
          if (v2Active) {
            if (dispatchReceipt) await settleV2Receipt(ctx, dispatchReceipt, "cancelled");
            dispatchReceipt = undefined;
            return;
          }
          // Release only the bookkeeping this dispatch owns.
          ownership.fail(key);
        },
        onDegrade: (model) => {
          const detail = routeFailure ? poolProblem(routeFailure.tier, routeFailure.pool, routeFailure.skipped) : "no configured model resolved";
          debug("virtual", "degrade", { model: modelKey(model), tier: routeFailure?.tier });
          log(ctx, `Bifrost: keeping ${modelKey(model)} (last dispatched) — ${detail}`, "warning");
        },
        routeError: (detail) => {
          if (routeFailure?.message) return new Error(routeFailure.message);
          if (!routeFailure) return new Error(`Bifrost: ${detail}`);
          const problem = noModelError(routeFailure.tier, routeFailure.pool, routeFailure.reason, routeFailure.skipped, routeFailure.reserveExcluded);
          return new Error(problem);
        },
      });
      try {
        return await route(request);
      } catch (error) {
        debugLifecycle("virtual", "route_rejected", ctx.sessionManager, correlationTurn, {
          request_correlation_id: requestCorrelationId ?? null,
          reason: requestReason,
          category: routeFailure?.explicitBoundary ? "policy_no_route" : routeFailure ? "model_unavailable" : terminalRouteCategory ?? "route_exception",
          reliabilityMode: v2Active ? "reliability_v2" : "reliability_v1",
        });
        throw error;
      }
    },
  });

  const handleCommand = createCommandRouter(state);

  pi.registerCommand("bifrost", {
    description: "Bifrost model router control",
    getArgumentCompletions: getBifrostCommandCompletions,
    handler: async (args, ctx) => {
      await runBifrostCommand(args, ctx, handleCommand);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    debugLifecycle("bifrost", "session_start", ctx.sessionManager, undefined, { reliabilityMode: reliabilityV2Enabled() ? "reliability_v2" : "reliability_v1" });
    classifierNoticeStates.delete(ctx.sessionManager);
    overrideFor(ctx).clear();
    affinityStore?.reset(ctx.sessionManager);
    pendingAffinityBySession.delete(ctx.sessionManager);
    if (reliabilityV2Enabled()) {
      v2Receipts.advanceBranch(ctx.sessionManager);
      await cleanupV2Receipts(ctx.sessionManager);
    }
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
  });

  pi.on("session_before_tree", async (_event, ctx) => {
    affinityStore?.reset(ctx.sessionManager);
    pendingAffinityBySession.delete(ctx.sessionManager);
    if (reliabilityV2Enabled()) {
      v2Receipts.advanceBranch(ctx.sessionManager);
      await cleanupV2Receipts(ctx.sessionManager);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    debugLifecycle("bifrost", "session_shutdown", ctx.sessionManager, undefined, { category: "session_cleanup" });
    classifierNoticeStates.delete(ctx.sessionManager);
    affinityStore?.reset(ctx.sessionManager);
    pendingAffinityBySession.delete(ctx.sessionManager);
    if (reliabilityV2Enabled()) await cleanupV2Receipts(ctx.sessionManager);
    await flushDebug();
  });

  pi.on("agent_end", async (event, ctx) => {
    trackerFor(ctx).observe(event.messages, (model, message) => {
      const observedAt = Date.now();
      return normalizeFailureObservation({
        outcomeId: randomUUID(), modelKey: model, source: "runtime", observedAt,
        ...(typeof message.errorMessage === "string" ? { errorText: message.errorMessage } : {}),
      }, { now: observedAt });
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    if ((!reliabilityV2Enabled() && !affinityStore) || event.message.role !== "assistant") return;
    const boundary = turnUserBoundary(ctx, event);
    if (!boundary) return;
    if (!reliabilityV2Enabled()) {
      const proof = pendingAffinity(ctx.sessionManager)?.get(boundary.entryId);
      if (!proof || proof.userMessage.deref() !== boundary.message) return;
      if (event.message.stopReason === "stop" || event.message.stopReason === "length") {
        proof.outcome = "success";
        proof.assistantEntryId = event.messageEntryId;
        proof.successObservedAt = Date.now();
      } else if (event.message.stopReason === "toolUse") {
        proof.outcome = undefined;
        proof.assistantEntryId = undefined;
        proof.successObservedAt = undefined;
      } else {
        proof.outcome = event.message.stopReason === "error" ? "failure" : "unknown";
        proof.assistantEntryId = undefined;
        proof.successObservedAt = undefined;
      }
      return;
    }
    const receipt = v2Receipts.find(ctx.sessionManager, boundary.entryId, boundary.message);
    if (!receipt) return;
    if (receipt.sessionId !== ctx.sessionManager.getHeader()?.id
      || receipt.branchEpoch !== v2Receipts.forSession(ctx.sessionManager).branchEpoch) return;
    const assistantProvider = event.message.provider;
    const assistantModel = event.message.model;
    if (typeof assistantProvider !== "string" || typeof assistantModel !== "string"
      || `${assistantProvider}/${assistantModel}` !== receipt.modelKey) return;
    if (event.message.stopReason === "error") {
      receipt.outcome = "failure";
      receipt.assistantEntryId = undefined;
      receipt.successObservedAt = undefined;
      if (receipt.observationsEnabled || state.config.reliability?.cooldownOnAllowanceExhausted !== false) {
        const errorText = (event.message as typeof event.message & { errorMessage?: unknown }).errorMessage;
        const observation = normalizeFailureObservation({
          outcomeId: receipt.outcomeId,
          modelKey: receipt.modelKey,
          source: "runtime",
          ...(typeof errorText === "string" ? { errorText } : {}),
        });
        receipt.failureObservation = receipt.observationsEnabled
          ? observation
          : observation?.category === "allowance_exhausted" ? observation : undefined;
      }
      debugLifecycle("reliability", "outcome_observed", ctx.sessionManager, boundary.message, {
        model: receipt.modelKey,
        outcome: "failure",
        source: "turn_end",
        ...(receipt.failureObservation?.category === "allowance_exhausted" ? {
          category: "allowance_exhausted",
          evidence: receipt.failureObservation.categoryEvidence,
          scope: "model-only",
        } : {}),
      });
    }
    else if (event.message.stopReason === "stop" || event.message.stopReason === "length") {
      receipt.outcome = "success";
      receipt.assistantEntryId = event.messageEntryId;
      receipt.successObservedAt = Date.now();
      debugLifecycle("reliability", "outcome_observed", ctx.sessionManager, boundary.message, {
        model: receipt.modelKey,
        outcome: "success",
        source: "turn_end",
      });
    }
    else if (event.message.stopReason === "toolUse") {
      receipt.outcome = undefined;
      receipt.assistantEntryId = undefined;
      receipt.successObservedAt = undefined;
      receipt.failureObservation = undefined;
      debugLifecycle("reliability", "outcome_observed", ctx.sessionManager, boundary.message, {
        model: receipt.modelKey,
        outcome: "provisional",
        source: "turn_end",
      });
      await renewV2Receipt(ctx, receipt);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settled = trackerFor(ctx).settle();
    // Clear at settle, not agent_end: agent_end handlers can queue fresh work
    // whose input-prepared tiers are still pending. Queued user input drains
    // before agent_end, so anything left here was abandoned.
    overrideFor(ctx).clear();
    if (reliabilityV2Enabled()) {
      const owner = v2Receipts.forSession(ctx.sessionManager);
      for (const receipt of [...owner.receipts.values()]) {
        const stale = receipt.sessionId !== ctx.sessionManager.getHeader()?.id
          || receipt.branchEpoch !== owner.branchEpoch
          || receipt.manualGeneration !== owner.manualGeneration;
        await settleV2Receipt(ctx, receipt, stale ? "cancelled" : receipt.outcome ?? "cancelled");
      }
      return;
    }
    if (affinityStore) {
      const pending = pendingAffinity(ctx.sessionManager);
      if (pending) {
        for (const proof of pending.values()) promotePendingAffinity(ctx, proof);
        pending.clear();
      }
    }
    if (settled.length === 0) return;
    if (!state.enabled || state.config.reliability?.enabled === false) {
      // Policy off mid-run: still resolve claimed trials so models never wedge.
      for (const outcome of settled) state.reliabilityStore.abandonTrial(outcome.model);
      return;
    }
    // Only explicit known completion can settle success. Cancellation, a
    // missing assistant response, and unknown stop reasons release the claim
    // without changing the circuit. Failures use an explicit write so an empty
    // host error string can never be mistaken for successful settlement.
    for (const outcome of settled) {
      debugLifecycle("reliability", "legacy_outcome_observed", ctx.sessionManager, undefined, {
        model: outcome.model,
        outcome: outcome.outcome,
        attribution: "model_only",
        category: outcome.failureObservation?.category === "allowance_exhausted"
          ? "allowance_exhausted" : outcome.outcome === "abandoned" ? "outcome_abandoned" : outcome.outcome === "failure" ? "provider_failed" : "provider_succeeded",
        ...(outcome.failureObservation?.category === "allowance_exhausted" ? {
          evidence: outcome.failureObservation.categoryEvidence,
          scope: "model-only",
        } : {}),
      });
      if (outcome.outcome === "abandoned") {
        state.reliabilityStore.abandonTrial(outcome.model);
        continue;
      }
      if (outcome.outcome === "failure") {
        const allowanceObservation = outcome.failureObservation?.category === "allowance_exhausted"
          ? outcome.failureObservation : undefined;
        state.reliabilityStore.recordFailure(
          outcome.model,
          "agent_settled",
          allowanceObservation ? "allowance_exhausted" : outcome.reason ?? "provider request failed",
          undefined,
          allowanceObservation,
        );
        if (allowanceObservation && state.config.reliability?.cooldownOnAllowanceExhausted !== false) {
          const openUntil = state.reliabilityStore.getCircuitState(outcome.model).openUntil;
          const until = openUntil !== undefined && Number.isSafeInteger(openUntil) && openUntil <= 8.64e15
            ? new Date(openUntil).toISOString() : "the configured cooldown";
          log(ctx, `Bifrost: ${outcome.model} reported allowance exhaustion (${allowanceObservation.categoryEvidence}); a model-only cooldown applies until ${until}. Shared provider/account scope is unknown; other models were not blocked. The failed prompt was not replayed.`, "warning");
        } else if (allowanceObservation) {
          log(ctx, `Bifrost: ${outcome.model} reported allowance exhaustion (${allowanceObservation.categoryEvidence}); the immediate model cooldown is disabled by config, so the ordinary failure threshold applies.`, "warning");
        } else {
          log(ctx, `Bifrost: recorded provider failure for ${outcome.model}; future prompts may route around it.`, "warning");
        }
        continue;
      }
      state.reliabilityStore.recordSettled(outcome.model);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    // Swallow only this session's own programmatic activation, matched by exact model.
    if (selfSelect.consume(ctx.sessionManager, event.source, modelKey(event.model))) return;
    // Session restore replays a recorded selection; it is not a user action.
    if (isPassiveModelSelection(event.source)) {
      debug("bifrost", "model_select.restore", { model: modelKey(event.model) });
      return;
    }
    // Selecting the virtual profile is an explicit request for per-prompt routing.
    if (isBifrostAuto(ctx.model)) {
      affinityStore?.reset(ctx.sessionManager);
      pendingAffinityBySession.delete(ctx.sessionManager);
      if (reliabilityV2Enabled()) {
        v2Receipts.advanceManual(ctx.sessionManager);
        await cleanupV2Receipts(ctx.sessionManager);
      }
      overrideFor(ctx).clear();
      state.pinned = false;
      state.enabled = true;
      state.saveModeState();
      debugLifecycle("bifrost", "manual_selection", ctx.sessionManager, undefined, { target: "auto", category: "user_selected_auto" });
      debug("bifrost", "model_select.virtual_auto");
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost Auto selected; routing each prompt to a physical model");
      // Nothing to route: offer setup once instead of letting requests fail later.
      if (!offeredSetup && configHasNoPools(state.config)) {
        offeredSetup = true;
        if (ctx.mode === "tui" && ctx.hasUI) {
          const setup = await ctx.ui.confirm(
            "Bifrost has no models configured for this project. Run /bifrost init now?",
            "Init probes every available model; provider usage may apply.",
          );
          if (setup) await runBifrostCommand("init", ctx, handleCommand);
        }
      }
      return;
    }
    if (!state.enabled) return;

    affinityStore?.reset(ctx.sessionManager);
    pendingAffinityBySession.delete(ctx.sessionManager);
    if (reliabilityV2Enabled()) {
      v2Receipts.advanceManual(ctx.sessionManager);
      await cleanupV2Receipts(ctx.sessionManager);
    }
    state.pinned = true;
    state.saveModeState();
    debugLifecycle("bifrost", "manual_selection", ctx.sessionManager, undefined, { target: modelKey(ctx.model), category: "physical_model_pinned" });
    debug("bifrost", "model_select", { model: modelKey(ctx.model) });
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
    log(
      ctx,
      `Model manually changed to ${modelKey(ctx.model)}; Bifrost pinned.`,
    );
  });

  pi.on("input", async (event, ctx) => {
    const originalText = event.text;
    const editorTextAtInput = readEditorText(ctx);
    let strictBoundary = routingPolicyInvalid(state) || hasExplicitTierPolicies(state.config) || hasHardEconomicAdmission(state.economicPolicy) || reliabilityV2Enabled();
    let begunStrictModel: string | undefined;
    let claimedTrial: string | undefined;
    try {
    if (event.source === "extension") {
      strictBoundary = false;
      return { action: "continue" };
    }
    if (!state.enabled || state.pinned) strictBoundary = false;
    clearBifrostWidgets(ctx);
    // Passive subagent observation — logged even when routing is disabled,
    // so child-session model usage stays visible in debug logs.
    if (process.env.PI_SUBAGENT_RUN_ID) {
      debug("input", "subagent", {
        source: "PI-subagent",
        agent: process.env.PI_SUBAGENT_CHILD_AGENT,
        model: modelKey(ctx.model),
        thinkingLevel: ctx.thinkingLevel,
        depth: process.env.PI_SUBAGENT_PARENT_DEPTH,
      });
    }
    if (!state.enabled || state.pinned) {
      debug("input", "bypass", { enabled: state.enabled, pinned: state.pinned });
      syncBifrostModeStatus(ctx, state);
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (text.startsWith("/")) {
      strictBoundary = false;
      return { action: "continue" };
    }
    if (reliabilityV2Enabled() && !isBifrostAuto(ctx.model)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost reliability stateVersion 2 supports Auto turns only; select bifrost/auto or use reliability stateVersion 1. The turn was not sent.");
    }
    if (state.config.affinity?.mode === "retain-within-tier" && !isBifrostAuto(ctx.model)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost retain-within-tier is supported for Auto user turns only; select bifrost/auto, or use affinity mode observe for physical routing. The turn was not sent.");
    }
    if (routingPolicyInvalid(state)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing is blocked by an invalid routing or economic policy config; fix the config and run /bifrost reload.");
    }

    // Inline tier override: "frontier debug this" forces that tier for one prompt.
    // Pi reserves / for commands, ! for bash. Just type the tier name as first word.
    const { forcedTier, promptText } = parseInlineOverride(text, state.config.models);
    if (forcedTier) strictBoundary = hasExplicitTierPolicy(state.config, forcedTier) || hasHardEconomicAdmission(state.economicPolicy);
    if (forcedTier) {
      debug("input", "inline_override", { tier: forcedTier });
    }

    // Inline override should strip the tier keyword from what LLM sees.
    const defaultAction = forcedTier
      ? { action: "transform" as const, text: promptText }
      : { action: "continue" as const };

    // Virtual auto: Pi dispatches the physical model in route(); skip the
    // legacy input-time switch. Hand the stripped prompt + forced tier across.
    if (isBifrostAuto(ctx.model)) {
      strictBoundary = strictBoundary || (!!forcedTier && hasExplicitTierPolicy(state.config, forcedTier));
      overrideFor(ctx).prepare(forcedTier, promptText, event.streamingBehavior);
      debug("input", "virtual_auto", { forcedTier, streamingBehavior: event.streamingBehavior });
      syncBifrostModeStatus(ctx, state);
      return defaultAction;
    }

    const endInput = debugMeasure("input", "total");
    debug("input", "prompt", { length: promptText.length });

    const shouldRefresh = state.classifierEnabled
      ? shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS)
      : false;

    try {
      if (shouldRefresh) {
        setBifrostWorkingMessage(ctx, "Bifrost checking models...");
        const endRefresh = debugMeasure("input", "registry.refresh");
        let refreshOutcome: "success" | "error" | "aborted" = "error";
        try {
          const result = await waitForRegistryRefresh(
            (signal) => ctx.modelRegistry.refresh(signal ? { signal } : undefined),
            ctx.signal,
            (refreshResult) => updateRegistryInventoryEvidence(state, ctx, refreshResult),
          );
          if (result === "aborted") {
            updateRegistryInventoryEvidence(state, ctx);
            refreshOutcome = "aborted";
            endInput({ outcome: "aborted" });
            return strictBoundary
              ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing was cancelled; the turn was not sent. Resubmit after repair.")
              : defaultAction;
          }
          refreshOutcome = "success";
          state.lastRegistryRefreshAt = Date.now();
          state.forceRegistryRefresh = false;
          invalidatePipeline();
        } catch {
          updateRegistryInventoryEvidence(state, ctx);
          debug("input", "registry.refresh.error", { category: "registry_refresh_failure" });
          console.error("[bifrost] model registry refresh failed");
        } finally {
          endRefresh({ outcome: refreshOutcome });
        }
      }

      if (!state.enabled || state.pinned) return { action: "continue" };
      if (routingPolicyInvalid(state)) {
        return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing is blocked by an invalid routing or economic policy config; fix the config and run /bifrost reload.");
      }

      setBifrostStatus(ctx, forcedTier ? `using ${forcedTier}...` : "classifying prompt...", "accent");
      uiBusy(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      setBifrostWorkingMessage(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      const endClassify = debugMeasure("input", "classify");
      const classificationConfig = state.config;
      let classification = forcedTier
        ? { kind: "classified" as const, tier: forcedTier, source: "inline" as const }
        : await getPipeline(ctx).classify(promptText, ctx.signal);
      if (!ctx.signal?.aborted) reportClassifierAttempt(ctx, classification);
      if (classification.kind === "unclassified" && hasHardEconomicAdmission(state.economicPolicy) && state.config.default) {
        classification = { kind: "fallback", tier: state.config.default, ...(classification.classifierAttempt ? { classifierAttempt: classification.classifierAttempt } : {}) };
      }

      if (!state.enabled || state.pinned) return { action: "continue" };
      if (routingPolicyInvalid(state)) {
        return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing is blocked by an invalid routing or economic policy config; fix the config and run /bifrost reload.");
      }
      if (!forcedTier && state.config !== classificationConfig) {
        strictBoundary = strictBoundary || hasExplicitTierPolicies(state.config);
        return strictBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost configuration changed during routing; the turn was not sent. Resubmit after repair.")
          : { action: "continue" };
      }
      if (ctx.signal?.aborted) {
        endClassify({ kind: classification.kind, outcome: "aborted" });
        endInput({ outcome: "aborted" });
        return strictBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing was cancelled; the turn was not sent. Resubmit after repair.")
          : defaultAction;
      }

      if (classification.kind === "classified") {
        const tag = classification.source === "inline" ? "!" : classification.source;
        console.error(`[bifrost] classify: ${classification.tier} [${tag}]`);
      }

      endClassify({ kind: classification.kind, tier: classification.kind !== "unclassified" ? classification.tier : undefined });
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);

      if (classification.kind === "unclassified") {
        if (hasHardEconomicAdmission(state.economicPolicy)) {
          return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost reserve policy could not resolve a tier; the turn was not sent. Configure a default tier or classify the request, then resubmit.");
        }
        strictBoundary = false;
        log(ctx, "Bifrost: no tier matched — using default model", "warning");
        debug("input", "unclassified");
        syncBifrostModeStatus(ctx, state);
        endInput();
        return defaultAction;
      }

      const tier = classification.tier;
      strictBoundary = hasExplicitTierPolicy(state.config, tier) || hasHardEconomicAdmission(state.economicPolicy);
      const routeStart = performance.now();
      const physicalAffinity: AffinityRoutingContext | undefined = state.config.affinity?.mode === "observe"
        ? { intrinsicOrigin: forcedTier ? "explicit_tier" : "automatic" }
        : undefined;
      const attempt = resolveForTier(ctx, tier, physicalAffinity);
      const routingDurationMs = +(performance.now() - routeStart).toFixed(3);
      const options = attempt.options;
      const strategy = options.requestedStrategy;
      const source = classification.kind === "classified"
        ? classification.source
        : "fallback";
      const classifierIdentity = classification.kind === "classified" && classification.judgment
        ? { classifierBackend: classification.judgment.backend, classifierModel: classification.judgment.model }
        : {};
      const resolved = attempt.resolution;
      if (state.config.debug?.enabled) {
        debug("input", "route_decision", {
          decision: buildRouteDecisionSummary(classification, attempt),
        });
      }
      const model = resolved.selected;
      const selectedTier = resolved.selectedTier ?? tier;

      // Claim the single half-open trial before using the selected model.
      if (model) {
        const trial = state.reliabilityStore.tryClaimTrial(modelKey(model));
        if (!trial.allowed) {
          debug("input", "trial_unavailable", { model: modelKey(model) });
          log(ctx, `Bifrost: ${modelKey(model)} already has a half-open trial in progress`, "warning");
          syncBifrostModeStatus(ctx, state);
          endInput();
          return strictBoundary
            ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost strict route is unavailable; the turn was not sent. Resubmit after repair.")
            : defaultAction;
        }
        if (trial.claimed) claimedTrial = modelKey(model);
      }

      if (!model) {
        state.forceRegistryRefresh = true;
        debug("input", "no_model", { tier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache" });
        const activeModelAllowanceCooldown = state.enabled && !state.pinned
          && state.config.reliability?.enabled !== false
          && state.config.reliability?.cooldownOnAllowanceExhausted !== false
          && state.config.reliability?.stateVersion !== 2
          && hasActiveAllowanceCooldown(state.reliabilityStore.getState(), modelKey(ctx.model), Date.now());
        if (activeModelAllowanceCooldown) {
          const message = "Bifrost: the active physical model is on an active model-only allowance cooldown and no configured alternative resolved; the turn was not sent. Wait for cooldown or select another tier/model.";
          debug("input", "allowance_cooldown_no_route", { model: modelKey(ctx.model), scope: "model-only" });
          return strictInputHandled(ctx, state, originalText, editorTextAtInput, message);
        }
        const why = resolved.fallbackReason ? ` (${resolved.fallbackReason})` : "";
        const reserveExcluded = reserveExclusionSummary(resolved);
        const reserveDetail = reserveExcluded.count > 0
          ? `; reserve policy excluded ${reserveExcluded.count} candidate(s)${reserveExcluded.reasonCodes.length ? ` (reasons: ${reserveExcluded.reasonCodes.join(", ")})` : ""}`
          : "";
        const eligibility = resolved.fallbackReason === "requested_tier_excluded" || reserveExcluded.count > 0 ? "eligible" : "healthy";
        log(ctx, `Bifrost: tier "${tier}" matched but no ${eligibility} model available${why}${reserveDetail}`, "warning");
        syncBifrostModeStatus(ctx, state);
        endInput();
        return strictBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, `Bifrost strict route for tier "${tier}" has no ${eligibility} model; the turn was not sent. Resubmit after repair.`)
          : defaultAction;
      }

      if (
        classification.kind === "classified" &&
        classification.source === "classifier"
      ) {
        const maxEntries = state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES;
        if (classifierCacheEnabled(state.config, effectiveBackendOf(state.config, detectionEngine).backend)) {
          const endCacheSave = debugMeasure("input", "cacheSave");
          state.cacheEntries = updateCache(state.cacheEntries, promptText, tier, maxEntries, activeClassifierCacheKey(state.config, detectionEngine));
          saveCache(cachePath(process.cwd(), state.config.cache?.path), state.cacheEntries);
          invalidatePipeline();
          endCacheSave({ entries: state.cacheEntries.length });
        }
      }

      if (modelKey(model) === modelKey(ctx.model)) {
        uiDone(ctx);
        syncBifrostModeStatus(ctx, state);
        const reason = resolved.fallbackReason ? `, ${resolved.fallbackReason}` : "";
        log(ctx, `Bifrost: ${tier} → ${modelKey(model)} (already active, ${source}${reason})`);
        debug("input", "model_unchanged", { model: modelKey(model), selectedTier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", ...classifierIdentity, thinkingLevel: ctx.thinkingLevel });
        debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", ...classifierIdentity, thinkingLevel: ctx.thinkingLevel });
        begunStrictModel = modelKey(model);
        trackerFor(ctx).begin(begunStrictModel);
        endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: ctx.thinkingLevel });
        claimedTrial = undefined;
        begunStrictModel = undefined;
        return defaultAction;
      }

      uiBusy(ctx, `Bifrost routing to ${modelKey(model)}...`);
      setBifrostWorkingMessage(ctx, `Bifrost routing to ${modelKey(model)}...`);
      if (!state.enabled || state.pinned) return { action: "continue" };
      if (routingPolicyInvalid(state)) {
        return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing is blocked by an invalid routing or economic policy config; fix the config and run /bifrost reload.");
      }
      selfSelect.claim(ctx.sessionManager, modelKey(model));
      const endSwitch = debugMeasure("input", "setModel");
      let ok = false;
      let setModelError: unknown;
      try {
        ok = await pi.setModel(model);
      } catch (err) {
        setModelError = err;
        debug("input", "setModel.throw", { model: modelKey(model), category: "set_model_failure" });
      } finally {
        // Key lives only inside the awaited setModel window (see selectPhysicalFromVirtual).
        selfSelect.release(ctx.sessionManager);
      }
      try { endSwitch({ model: modelKey(model), ok }); } catch { /* optional timing output */ }
      try { uiDone(ctx); } catch { /* optional UI output must not suppress an activated turn */ }
      try { setBifrostWorkingMessage(ctx, undefined); } catch { /* optional UI output must not suppress an activated turn */ }
      if (!ok) {
        state.forceRegistryRefresh = true;
        const reason = setModelError
          ? "setModel threw"
          : "setModel returned false";
        state.reliabilityStore.recordFailure(modelKey(model), "setModel", reason);
        claimedTrial = undefined;
        try { syncBifrostModeStatus(ctx, state); } catch { /* best effort */ }
        try { log(ctx, `Bifrost: no API key for ${modelKey(model)}`, "error"); } catch { /* best effort */ }
        try { endInput({ model: modelKey(model), ok: false }); } catch { /* optional timing output */ }
        return strictBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, `Bifrost strict route could not activate ${modelKey(model)}; the turn was not sent. Resubmit after repair.`)
          : defaultAction;
      }

      const detail = [
        selectedTier !== tier ? `selected tier ${selectedTier}` : undefined,
        resolved.fallbackReason,
        resolved.skipped.length > 0 ? `${resolved.skipped.length} skipped` : undefined,
      ].filter(Boolean).join(", ");
      const doneMsg = classification.kind === "classified"
        ? `Bifrost: ${tier} → ${modelKey(model)} (${classification.source}${detail ? `; ${detail}` : ""})`
        : `Bifrost: ${tier} → ${modelKey(model)} (fallback${detail ? `; ${detail}` : ""})`;
      begunStrictModel = modelKey(model);
      trackerFor(ctx).begin(begunStrictModel);
      claimedTrial = undefined;
      begunStrictModel = undefined;
      try { syncBifrostModeStatus(ctx, state); } catch { /* optional status must not suppress an activated turn */ }
      try { log(ctx, doneMsg); } catch { /* optional notification must not suppress an activated turn */ }
      try { debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", ...classifierIdentity, routingDurationMs, thinkingLevel: ctx.thinkingLevel }); } catch { /* optional trace output */ }
      try { endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: ctx.thinkingLevel }); } catch { /* optional timing output */ }
      return defaultAction;
    } finally {
      try { if (claimedTrial) state.reliabilityStore.abandonTrial(claimedTrial); } catch { /* best effort */ }
      try { uiDone(ctx); } catch { /* best effort */ }
      try { setBifrostWorkingMessage(ctx, undefined); } catch { /* best effort */ }
      try { syncBifrostModeStatus(ctx, state); } catch { /* best effort */ }
    }
    } catch (error) {
      if (!strictBoundary) throw error;
      try { if (begunStrictModel) trackerFor(ctx).release(begunStrictModel); } catch { /* best effort */ }
      try { if (claimedTrial) state.reliabilityStore.abandonTrial(claimedTrial); } catch { /* best effort */ }
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost strict routing failed; the turn was not sent. Resubmit after repair.");
    }
  });
}
