import type { ExtensionAPI, ExtensionContext, TurnEndEvent, AgentBeforeSettleEvent, SessionMessageEntry, ModelRouteRequest, InputEventResult } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
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
import { getCircuitState, hasActiveAllowanceCooldown, type ReliabilityState } from "./reliability.ts";
import { projectReliabilityV2ForRouting } from "./reliability-v2-routing.ts";
import type { ReliabilityV2LegacyAllowanceMarker } from "./reliability-v2.ts";
import { projectProviderCooldownsForRouting, type LegacyAllowanceMarker, type ProviderTrialClaim } from "./provider-cooldowns.ts";
import { normalizeFailureObservation } from "./failure-observations.ts";
import { createRuntimeAffinityStore, type RuntimeAffinitySuccessProof, type RuntimeAffinityStore } from "./runtime-affinity.ts";
import { resolvePiAffinityMode, type AffinityAnchor } from "./affinity.ts";
import {
  AutoDispatchReceiptBook,
  createReliabilityV2Store,
  createProviderCooldownStore,
  reliabilityV2Config,
  reliabilityV2Path,
  serializeReceiptOperation,
  V2_LEASE_TTL_MS,
  V2_RENEW_INTERVAL_MS,
  V2_MAX_DISPATCH_LIFETIME_MS,
  type AutoDispatchReceipt,
} from "./runtime-reliability-v2.ts";
import { ReliabilityV2Store } from "./reliability-v2-store.ts";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState, isPassiveModelSelection, createSelfSelectTracker } from "./runtime-state.ts";
import { createCommandRouter, getBifrostCommandCompletions, runBifrostCommand, log, uiBusy, uiDone, syncBifrostModeStatus, clearBifrostWidgets, type BifrostState } from "./commands.ts";
import { setupDebug, debug, debugMeasure, isDebugEnabled, flushDebug } from "./debug.ts";
import { parseInlineOverride } from "./inline-override.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER, isBifrostAuto, isVirtualModel } from "./virtual-model.ts";
import { createDispatchOwnership, RuntimeReliabilityTracker } from "./runtime-reliability.ts";
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
import { buildBootstrapPools, canBootstrapModels, hasBlockingRuntimePreferences, hasExplicitExtensionRoutingFile, hasUserBootstrapFiles } from "./auto-setup.ts";
import { buildInitOwnershipReceipt } from "./reconciliation-command.ts";
import { applyReconciliationTransaction } from "./reconciliation-store.ts";

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
  readonly tiers: readonly string[];
}

const SAFE_RESERVE_REASON_CODES = new Set([
  "above_reserve", "reserve_reached", "missing_fact", "stale_fact", "invalid_fact",
  "source_conflict", "period_conflict", "unsupported_scope", "scope.invalid", "context.invalid",
]);

function reserveExclusionSummary(resolution: RoutedModelResolution): ReserveExclusionSummary {
  const pools = resolution.attemptedTiers?.map((attempt) => ({ tier: attempt.tier, resolution: attempt.resolution }))
    ?? [
      { tier: resolution.requestedTier, resolution: resolution.primary },
      ...(resolution.fallback ? [{ tier: resolution.fallbackTier ?? resolution.requestedTier, resolution: resolution.fallback }] : []),
    ];
  const candidates = new Map<string, Set<string>>();
  const tiers = new Set<string>();
  for (const { tier, resolution: pool } of pools) {
    for (const { key, evaluation } of pool.economic ?? []) {
      if (evaluation.mode !== "policy" || evaluation.disposition !== "rejected") continue;
      tiers.add(tier);
      const reasons = candidates.get(key) ?? new Set<string>();
      for (const result of evaluation.results) {
        if ((result.status === "reject" || (result.status === "unknown" && result.unknownHandling === "block"))
          && SAFE_RESERVE_REASON_CODES.has(result.reason)) reasons.add(result.reason);
      }
      candidates.set(key, reasons);
    }
  }
  const reasonCodes = [...new Set([...candidates.values()].flatMap((reasons) => [...reasons]))].sort();
  return { count: candidates.size, reasonCodes, tiers: [...tiers].sort() };
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
  isProviderClassifierUnavailable: (model: Model<Api>) => boolean,
  recordProviderClassifierFailure: (model: Model<Api>, status?: number, retryAfter?: string, errorText?: string) => Promise<void>,
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
      onProviderSelected: (providerModel) => !isProviderClassifierUnavailable(providerModel as Model<Api>),
      onProviderError: async (providerModel, errorText) => {
        const model = { provider: providerModel.provider, id: providerModel.id } as Model<Api>;
        await recordProviderClassifierFailure(model, undefined, undefined, errorText);
      },
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
        if (isProviderClassifierUnavailable(model.model)) {
          debug("classifier", "provider_cooldown_skip", { provider: model.model.provider, scope: "provider" });
          return undefined;
        }
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
        onProviderHttpResponse: async (providerModel, status, retryAfter, errorText) => {
          await recordProviderClassifierFailure(providerModel, status, retryAfter, errorText);
        },
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

function classifierRetryAt(value: string, now: number): number | undefined {
  const text = value.trim();
  const seconds = /^(?:0|[1-9]\d{0,8})$/.test(text) ? Number(text) : undefined;
  const parsed = seconds === undefined ? Date.parse(text) : now + seconds * 1000;
  return Number.isSafeInteger(parsed) && parsed > now && parsed - now <= 24 * 60 * 60 * 1000
    ? parsed : undefined;
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
  const providerCooldownStore = config.reliability?.enabled === false
    || configIssues.some((issue) => issue.severity === "error" && issue.code?.startsWith("config.reliability_"))
    ? undefined : createProviderCooldownStore(process.cwd(), config.reliability);
  const legacyV2Reader = new ReliabilityV2Store({
    path: reliabilityV2Path(process.cwd()),
    // This reader only validates and imports bounded legacy markers. Use a
    // stable internal store policy so otherwise-valid v1 thresholds cannot
    // make extension startup throw through v2-only limits.
    config: reliabilityV2Config(),
    requireInitialized: false,
  });
  let providerCooldownWriteFailed = false;
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
  const selfSetModelChangeBySession = new WeakMap<object, {
    entryId: string;
    parentId?: string;
    modelKey: string;
    thinkingEntryId?: string;
    thinkingLevel?: string;
  }>();
  // One extension runtime can host several sessions: scope mutable routing
  // state per session so concurrent sessions cannot consume each other's
  // prompt handoffs or reliability outcomes.
  const overridesBySession = new WeakMap<object, VirtualOverride>();
  const trackersBySession = new WeakMap<object, RuntimeReliabilityTracker>();
  const allowanceRetryBySession = new WeakMap<object, AllowanceRetryToken>();
  const allowanceRetryAttemptBySession = new WeakMap<object, AllowanceRetryToken>();
  const allowanceRetryCancelledBySession = new WeakMap<object, AllowanceRetryToken>();
  const allowanceRetryStopReasonBySession = new WeakMap<object, string>();
  const pendingAllowanceFailureBySession = new WeakMap<object, PendingAllowanceFailure>();
  const providerClaimsBySession = new WeakMap<object, Map<string, ProviderTrialClaim>>();
  const providerTrialTimersBySession = new WeakMap<object, Map<string, ReturnType<typeof setInterval>>>();
  const providerTrialSessionRefs = new Set<WeakRef<object>>();
  const providerTrialSessionRefBySession = new WeakMap<object, WeakRef<object>>();
  const autoRouteProofsBySession = new WeakMap<object, AutoRouteProof[]>();
  interface AutoBootstrapRecord {
    promise: Promise<boolean>;
    readonly config: BifrostConfig;
    readonly configGeneration: number;
    readonly branchLength: number;
    readonly branchHeadId: string | undefined;
    readonly projectRoot: string;
    readonly deadlineAt: number;
    cancelled: boolean;
  }
  const autoBootstrapBySession = new WeakMap<object, AutoBootstrapRecord>();
  const autoBootstrapLifecycleBySession = new WeakMap<object, number>();
  function advanceAutoBootstrapLifecycle(session: object): void {
    autoBootstrapLifecycleBySession.set(session, (autoBootstrapLifecycleBySession.get(session) ?? 0) + 1);
  }
  const allowanceRetrySessions = new Set<WeakRef<object>>();
  const allowanceRetrySessionRefs = new WeakMap<object, WeakRef<object>>();
  const v2Receipts = new AutoDispatchReceiptBook();
  const ALLOWANCE_RETRY_TTL_MS = 5 * 60_000;
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

  function effectiveClassifierFor(ctx: ExtensionContext, targetConfig: BifrostConfig): EffectiveBackend {
    const detected = detectionEngine.detect(() => collectDetectionFacts({
      readStoredCredential,
      getProviderAuthStatus: (providerId) => ctx.modelRegistry.getProviderAuthStatus(providerId),
      env: process.env,
      nativeSupported: piClassificationSupported(ctx.modelRegistry),
    }));
    const effective = selectEffectiveBackend(targetConfig.classifier?.backend, detected);
    if (effective.auto) state.classifierDetection = { backend: effective.backend, reason: effective.reason };
    return effective;
  }

  function getPipeline(ctx: ExtensionContext): ClassificationPipeline {
    const effective = effectiveClassifierFor(ctx, state.config);
    if (effective.auto) {
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
            const provider = model.slice(0, model.indexOf("/"));
            const providerView = providerCooldownsEnabled() && provider
              ? state.providerCooldownStore?.read(provider,
                state.config.reliability?.cooldownOnAllowanceExhausted !== false
                && state.config.reliability?.allowanceCooldownScope !== "model", now)
              : undefined;
            return circuit.open || circuit.trialActive || providerView?.openUntil !== undefined
              || providerView?.trialActive === true || providerView?.recoveryPending === true;
          } catch {
            return true;
          }
        },
        (model) => {
          if (!providerCooldownsEnabled()) return false;
          if (providerCooldownWriteFailed || !state.providerCooldownStore) return true;
          try {
            const view = state.providerCooldownStore.read(
              model.provider,
              state.config.reliability?.cooldownOnAllowanceExhausted !== false
                && state.config.reliability?.allowanceCooldownScope !== "model",
            );
            return view.openUntil !== undefined || view.trialActive || view.recoveryPending;
          } catch { return true; }
        },
        async (model, status, retryAfter, errorText) => {
          try { await recordClassifierProviderFailure(model, status, retryAfter, errorText); }
          catch {
            providerCooldownWriteFailed = true;
            throw new Error("Provider cooldown could not be saved; routing is blocked.");
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
    providerCooldownStore,
    classifierMetricsStore,
    extensionDir,
    getAffinityAnchor: affinityAnchor,
    effectiveClassifierBackend: (targetConfig, ctx) => ctx
      ? effectiveClassifierFor(ctx, targetConfig)
      : effectiveBackendOf(targetConfig, detectionEngine),
    getPipeline,
    invalidatePipeline,
    saveModeState: () => {
      const next = { enabled: state.enabled, classifierEnabled: state.classifierEnabled };
      return saveRuntimeState(runtimeStateFile, next);
    },
    lastRegistryRefreshAt: undefined,
    forceRegistryRefresh: false,
  };

  const legacyAllowanceModelKeys = new Set<string>();
  const legacyV1AllowanceMarkers = new Map<string, { openUntil: number; lastFailureAt?: number; reason: string }>();
  const legacyV2AllowanceMarkers = new Map<string, { openUntil: number; generation: number; observedAt: number }>();
  let providerAllowanceImportPromise: Promise<void> | undefined;
  function ensureProviderAllowanceImports(): Promise<void> {
    if (!providerCooldownsEnabled()
      || state.config.reliability?.cooldownOnAllowanceExhausted === false
      || state.config.reliability?.allowanceCooldownScope === "model") return Promise.resolve();
    if (!providerAllowanceImportPromise) {
      providerAllowanceImportPromise = (async () => {
        const providerStore = state.providerCooldownStore;
        if (!providerStore) throw new Error("Bifrost provider cooldown state is unavailable.");
        const now = Date.now();
        const markers: LegacyAllowanceMarker[] = [];
        const v1 = state.reliabilityStore.getState();
        for (const [key, record] of Object.entries(v1.models)) {
          if (!hasActiveAllowanceCooldown(v1, key, now)) continue;
          const separator = key.indexOf("/");
          if (separator <= 0) continue;
          markers.push({
            providerId: key.slice(0, separator), modelKey: key,
            sourceId: `v1|${key}|${record.lastFailureAt ?? record.openUntil}|${record.openUntil}`,
            openUntil: record.openUntil!,
          });
          legacyV1AllowanceMarkers.set(key, {
            openUntil: record.openUntil!, lastFailureAt: record.lastFailureAt, reason: record.lastFailureReason!,
          });
        }
        const v2PathExists = existsSync(reliabilityV2Path(process.cwd()));
        if (v2PathExists) {
          const v2 = (state.reliabilityV2Store ?? legacyV2Reader).readSnapshot();
          const activeObservations = Object.values(v2.settledOutcomes)
            .filter((outcome) => outcome.expiresAt > now && outcome.observation?.source === "runtime"
              && (outcome.observation.category === "allowance_exhausted" || outcome.observation.category === "billing_denied"));
          for (const [scopeKey, scope] of Object.entries(v2.scopes)) {
            const match = /^model:(\d+):(.+)$/.exec(scopeKey);
            const model = match?.[2];
            if (!model || Number(match?.[1]) !== model.length || !scope.openUntil || scope.openUntil <= now) continue;
            const observation = activeObservations
              .map((item) => item.observation!)
              .filter((item) => item.modelKey === model)
              .sort((left, right) => right.observedAt - left.observedAt)[0];
            if (!observation) continue;
            const separator = model.indexOf("/");
            if (separator <= 0) continue;
            markers.push({
              providerId: model.slice(0, separator), modelKey: model,
              sourceId: `v2|${model}|${observation.observedAt}|${scope.openUntil}`,
              openUntil: scope.openUntil,
            });
            legacyV2AllowanceMarkers.set(model, {
              openUntil: scope.openUntil, generation: scope.generation, observedAt: observation.observedAt,
            });
          }
        }
        for (const marker of markers) {
          await providerStore.importLegacyAllowance(marker, now);
          legacyAllowanceModelKeys.add(marker.modelKey);
        }
      })().catch((error) => {
        providerAllowanceImportPromise = undefined;
        throw error;
      });
    }
    return providerAllowanceImportPromise;
  }
  function isImportedLegacyV1AllowanceBlock(model: string): boolean {
    const marker = legacyV1AllowanceMarkers.get(model);
    const current = state.reliabilityStore.getState().models[model];
    return !!marker && !!current
      && current.openUntil === marker.openUntil
      && current.lastFailureAt === marker.lastFailureAt
      && current.lastFailureReason === marker.reason;
  }
  function importedLegacyV2AllowanceBlock(model: string): ReliabilityV2LegacyAllowanceMarker | undefined {
    const marker = legacyV2AllowanceMarkers.get(model);
    const store = state.reliabilityV2Store;
    if (!marker || !store) return undefined;
    const snapshot = store.readSnapshot();
    const scopeKey = `model:${model.length}:${model}`;
    const current = snapshot.scopes[scopeKey];
    const activeSource = !!current && current.generation === marker.generation && current.openUntil === marker.openUntil
      && Object.values(snapshot.settledOutcomes).some((outcome) => outcome.expiresAt > Date.now()
        && outcome.observation?.modelKey === model
        && outcome.observation.observedAt === marker.observedAt
        && (outcome.observation.category === "allowance_exhausted" || outcome.observation.category === "billing_denied")
        && outcome.observation.source === "runtime");
    return activeSource ? { modelKey: model, ...marker } : undefined;
  }

  state.onConfigInstalled = (nextConfig, previousConfig, validatedReload = false) => {
    void cleanupAllProviderTrials();
    providerAllowanceImportPromise = undefined;
    legacyAllowanceModelKeys.clear();
    legacyV1AllowanceMarkers.clear();
    legacyV2AllowanceMarkers.clear();
    state.bootstrapModelsInMemory = false;
    const previousReliability = previousConfig.reliability;
    const nextReliability = nextConfig.reliability;
    const keepActiveV2Store = previousReliability?.stateVersion === 2 && previousReliability.enabled !== false
      && nextReliability?.stateVersion === 2 && nextReliability.enabled !== false
      && (previousReliability.failureThreshold ?? 3) === (nextReliability.failureThreshold ?? 3)
      && (previousReliability.windowMinutes ?? 5) === (nextReliability.windowMinutes ?? 5)
      && (previousReliability.cooldownMinutes ?? 60) === (nextReliability.cooldownMinutes ?? 60)
      && (previousReliability.cooldownOnAllowanceExhausted ?? true) === (nextReliability.cooldownOnAllowanceExhausted ?? true)
      && (previousReliability.retryOnAllowanceExhausted ?? true) === (nextReliability.retryOnAllowanceExhausted ?? true)
      && (previousReliability.observations?.enabled ?? false) === (nextReliability.observations?.enabled ?? false);
    state.configGeneration = (state.configGeneration ?? 0) + 1;
    for (const reference of allowanceRetrySessions) {
      const session = reference.deref();
      if (session) clearAllowanceRetry(session, "config_changed");
      else allowanceRetrySessions.delete(reference);
    }
    debugLifecycle("config", "installed", undefined, undefined, {
      generation: state.configGeneration,
      reliabilityMode: nextConfig.reliability?.stateVersion === 2 && nextConfig.reliability.enabled !== false ? "reliability_v2" : "reliability_v1",
      routingEnabled: nextConfig.enabled === false ? false : true,
    });
    state.affinityConfigValid = validateConfig(nextConfig).every((issue) => issue.severity !== "error" || !issue.code?.startsWith("config.affinity_"));
    state.reliabilityV2ConfigValid = validateConfig(nextConfig).every((issue) => !issue.code?.startsWith("config.reliability_"));
    state.providerCooldownStore = nextConfig.reliability?.enabled === false || !state.reliabilityV2ConfigValid
      ? undefined : createProviderCooldownStore(process.cwd(), nextConfig.reliability);
    if (validatedReload) {
      try {
        state.providerCooldownStore?.store.readSnapshot();
        providerCooldownWriteFailed = false;
      } catch {
        providerCooldownWriteFailed = true;
      }
    }
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
    cancelAutoBootstrap(session);
    clearAllowanceRetry(session, "manual_control");
    debugLifecycle("bifrost", "manual_control", session, undefined, {
      action: action ?? "model_select",
      category: "routing_ownership_reset",
    });
    v2Receipts.advanceManual(session);
    void cleanupV2Receipts(session, "cancelled");
    affinityStore?.reset(session);
    pendingAffinityBySession.delete(session);
  };

  function cancelAutoBootstrap(session: object): void {
    const pending = autoBootstrapBySession.get(session);
    if (pending) pending.cancelled = true;
    autoBootstrapBySession.delete(session);
  }

  function bootstrapContextStillEligible(): boolean {
    const userFiles = hasUserBootstrapFiles(process.cwd(), getAgentDir(), CONFIG_DIR_NAME, join(extensionDir, "bifrost.json"));
    const runtimePreferencesChanged = hasBlockingRuntimePreferences(runtimeStateFile);
    return state.enabled && !state.pinned
      && !validateConfig(state.config).some((issue) => issue.severity === "error")
      && canBootstrapModels({
        ...userFiles,
        runtimePreferences: runtimePreferencesChanged,
        extensionRoutingOverride: hasExplicitExtensionRoutingFile(join(extensionDir, "bifrost.json")),
      });
  }

  function bootstrapStillEligible(): boolean {
    return configHasNoPools(state.config) && bootstrapContextStillEligible();
  }

  function persistAutoBootstrap(
    ctx: ExtensionContext,
    session: object,
    record: AutoBootstrapRecord,
    nextConfig: BifrostConfig,
    generatedModels: Record<string, string[]>,
    classifierModel: Model<Api> | undefined,
  ): void {
    const generation = state.configGeneration ?? 0;
    const ownsPersistence = (): boolean => !record.cancelled
      && autoBootstrapBySession.get(session) === record
      && resolve(process.cwd()) === record.projectRoot
      && state.config === nextConfig
      && (state.configGeneration ?? 0) === generation
      && state.bootstrapModelsInMemory === true;
    const stillOwned = (): boolean => ownsPersistence() && bootstrapContextStillEligible();
    const warn = (): void => {
      if (!record.cancelled) log(ctx, "Bifrost could not safely save the detected pools to project config; routing continues with in-memory pools.", "warning");
    };

    if (!stillOwned()) {
      if (ownsPersistence()) warn();
      return;
    }
    const projectDirectory = record.projectRoot;
    const piDirectory = join(projectDirectory, CONFIG_DIR_NAME);
    const configPath = join(piDirectory, "bifrost.json");
    const ownershipPath = join(piDirectory, "bifrost-reconcile-ownership.json");
    const journalPath = join(piDirectory, "bifrost-reconcile.journal");
    try {
      try { mkdirSync(piDirectory, 0o700); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const piStats = lstatSync(piDirectory);
      if (!piStats.isDirectory() || piStats.isSymbolicLink()
        || realpathSync(piDirectory) !== join(realpathSync(projectDirectory), CONFIG_DIR_NAME)) {
        warn();
        return;
      }
      if (!stillOwned()) {
        if (ownsPersistence()) warn();
        return;
      }

      let expectedConfigDigest: string | null = null;
      try {
        const configStats = lstatSync(configPath);
        if (!configStats.isFile() || configStats.isSymbolicLink() || configStats.size > 65_536) {
          warn();
          return;
        }
        const existingBytes = readFileSync(configPath);
        const existing = JSON.parse(existingBytes.toString("utf8")) as unknown;
        if (!existing || typeof existing !== "object" || Array.isArray(existing) || Object.keys(existing).length !== 0) {
          warn();
          return;
        }
        expectedConfigDigest = createHash("sha256").update(existingBytes).digest("hex");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warn();
          return;
        }
      }
      for (const path of [ownershipPath, journalPath]) {
        try { lstatSync(path); warn(); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { warn(); return; } }
      }
      const ownership = buildInitOwnershipReceipt(generatedModels, record.config.models ?? {});
      if (!ownership) return;
      if (!stillOwned()) {
        if (ownsPersistence()) warn();
        return;
      }
      const ownershipBytes = Buffer.from(JSON.stringify(ownership, null, 2) + "\n", "utf8");
      const savedConfig: BifrostConfig = {
        ...(nextConfig.schemaVersion === undefined ? {} : { schemaVersion: nextConfig.schemaVersion }),
        default: nextConfig.default,
        models: nextConfig.models ?? generatedModels,
        ...(classifierModel ? {
          classifier: { model: modelKey(classifierModel), method: nextConfig.classifier?.method ?? "auto" },
        } : {}),
      };
      const configBytes = Buffer.from(JSON.stringify(savedConfig, null, 2) + "\n", "utf8");
      applyReconciliationTransaction({
        configPath,
        ownershipPath,
        journalPath,
        expectedConfigDigest,
        expectedOwnershipDigest: null,
        nextConfigBytes: configBytes,
        nextOwnershipBytes: ownershipBytes,
      });
      if (state.config === nextConfig && (state.configGeneration ?? 0) === generation) {
        state.bootstrapModelsInMemory = false;
        log(ctx, "Bifrost saved the detected starter pools to project config at .pi/bifrost.json.");
      }
    } catch {
      warn();
    }
  }

  function startAutoBootstrap(ctx: ExtensionContext): AutoBootstrapRecord | undefined {
    const session = ctx.sessionManager;
    const existing = autoBootstrapBySession.get(session);
    if (existing && !existing.cancelled) return existing;
    if (!bootstrapStillEligible()) return undefined;
    const config = state.config;
    const configGeneration = state.configGeneration ?? 0;
    const branch = ctx.sessionManager.getBranch();
    const branchLength = branch.length;
    const branchHeadId = branch.at(-1)?.id;
    const record: AutoBootstrapRecord = {
      config,
      configGeneration,
      branchLength,
      branchHeadId,
      projectRoot: resolve(process.cwd()),
      deadlineAt: Date.now() + 500,
      cancelled: false,
      promise: Promise.resolve(false),
    };
    const currentBranch = (): boolean => {
      const now = ctx.sessionManager.getBranch();
      return now.length === branchLength && now.at(-1)?.id === branchHeadId;
    };
    const stillOwned = (): boolean => !record.cancelled
      && !ctx.signal?.aborted
      && Date.now() < record.deadlineAt
      && state.config === config
      && (state.configGeneration ?? 0) === configGeneration
      && currentBranch()
      && bootstrapStillEligible();
    record.promise = Promise.resolve().then(() => {
      if (!stillOwned()) return false;
      let available: readonly Model<Api>[];
      try { available = ctx.modelRegistry.getAvailable(); }
      catch { available = []; }
      const pools = buildBootstrapPools(available);
      if (!pools) {
        log(ctx, "Bifrost: Pi has no available chat models. Sign in to a provider or refresh Pi's catalog; /bifrost init can refresh the model list.", "warning");
        return false;
      }
      if (!stillOwned()) return false;
      const effective = state.effectiveClassifierBackend(state.config, ctx);
      const classifier = state.config.classifier;
      const classifierModel = state.enabled && state.classifierEnabled && classifier?.enabled !== false
        && effective.backend === CLASSIFIER_BACKEND_IDS.prompt && classifier?.model === undefined
        ? [...available]
          .filter((model) => !isVirtualModel(model))
          .sort((a, b) => modelKey(a).localeCompare(modelKey(b)))
          .find((model) => {
            const key = modelKey(model);
            const circuit = getCircuitState(state.reliabilityStore.getState(), key, Date.now(), state.config.reliability);
            let providerUnavailable = false;
            if (providerCooldownsEnabled()) {
              try {
                const provider = state.providerCooldownStore?.read(
                  model.provider,
                  state.config.reliability?.cooldownOnAllowanceExhausted !== false
                    && state.config.reliability?.allowanceCooldownScope !== "model",
                );
                providerUnavailable = providerCooldownWriteFailed || !provider
                  || provider.openUntil !== undefined || provider.trialActive || provider.recoveryPending;
              } catch { providerUnavailable = true; }
            }
            return !providerUnavailable && !circuit.open
              && !hasActiveAllowanceCooldown(state.reliabilityStore.getState(), key, Date.now());
          })
        : undefined;
      const nextConfig: BifrostConfig = {
        ...state.config,
        default: pools.default,
        models: {
          ...Object.fromEntries(Object.keys(state.config.categoryStrategies ?? {}).map((tier) => [tier, []])),
          ...pools.models,
        },
        ...(classifierModel ? { classifier: { ...classifier, model: modelKey(classifierModel), method: classifier?.method ?? "auto" } } : {}),
      };
      if (validateConfig(nextConfig).some((issue) => issue.severity === "error") || !stillOwned()) return false;
      state.config = nextConfig;
      state.onConfigInstalled?.(nextConfig, config);
      state.invalidatePipeline();
      state.bootstrapModelsInMemory = true;
      log(ctx, `Bifrost loaded ${Object.values(pools.models).reduce((count, pool) => count + pool.length, 0)} listed chat model(s) into in-memory pools. Catalog membership is not a health check; /bifrost init can refresh and save configuration.`);
      setImmediate(() => persistAutoBootstrap(ctx, session, record, nextConfig, pools.models, classifierModel));
      return true;
    }).catch(() => false).then((ready) => {
      if (!ready && autoBootstrapBySession.get(session) === record) autoBootstrapBySession.delete(session);
      return ready;
    });
    autoBootstrapBySession.set(session, record);
    return record;
  }

  async function joinAutoBootstrap(ctx: ExtensionContext): Promise<boolean> {
    if (ctx.signal?.aborted) return false;
    const record = startAutoBootstrap(ctx);
    if (!record) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    setBifrostWorkingMessage(ctx, "Bifrost checking models...");
    try {
      const ready = await Promise.race([
        record.promise,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(false); }, 500); }),
      ]);
      if (timedOut || ctx.signal?.aborted) {
        cancelAutoBootstrap(ctx.sessionManager);
        return false;
      }
      return ready;
    } finally {
      if (timer) clearTimeout(timer);
      setBifrostWorkingMessage(ctx, undefined);
    }
  }

  interface AutoUserBoundary {
    readonly sessionId: string;
    readonly entryId: string;
    readonly message: object;
    readonly branchEpoch: number;
    readonly manualGeneration: number;
    readonly configGeneration: number;
  }

  interface AutoRouteProof extends Omit<AutoUserBoundary, "message"> {
    readonly userMessage: WeakRef<object>;
    readonly modelKey: string;
    readonly requestedTier: string;
    readonly selectedTier: string;
    readonly explicitTier: boolean;
  }

  interface PendingAllowanceFailure extends Omit<AutoUserBoundary, "message"> {
    readonly userMessage: WeakRef<object>;
    readonly assistantEntryId: string;
    readonly assistantMessage: WeakRef<object>;
    readonly failedModelKey: string;
    readonly requestedTier: string;
    readonly selectedTier: string;
    readonly explicitTier: boolean;
    readonly observation: NonNullable<ReturnType<typeof normalizeFailureObservation>>;
    readonly receipt?: AutoDispatchReceipt;
  }

  interface AllowanceRetryToken extends Omit<AutoUserBoundary, "message"> {
    readonly userMessage: WeakRef<object>;
    readonly failedModelKey: string;
    readonly failureCategory: "allowance_exhausted" | "billing_denied";
    readonly assistantEntryId: string;
    readonly approvedAssistantEntryIds: readonly string[];
    readonly requestedTier: string;
    readonly explicitTier: boolean;
    readonly candidateKey: string;
    readonly selectedTier: string;
    readonly randomValue: number;
    readonly expiresAt: number;
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

  function hasActiveAllowanceRetryAttempt(
    ctx: ExtensionContext,
    boundary: { entryId: string; message: object },
    failedModelKey: string,
  ): boolean {
    const attempt = allowanceRetryAttemptBySession.get(ctx.sessionManager);
    return !!attempt && attempt.userMessage.deref() === boundary.message && attempt.entryId === boundary.entryId
      && attempt.candidateKey === failedModelKey && attempt.candidateKey !== attempt.failedModelKey
      && attempt.expiresAt > Date.now() && !ctx.signal?.aborted && !ctx.hasPendingMessages?.()
      && autoBoundaryStillActive(ctx, {
        sessionId: attempt.sessionId,
        entryId: attempt.entryId,
        message: boundary.message,
        branchEpoch: attempt.branchEpoch,
        manualGeneration: attempt.manualGeneration,
        configGeneration: attempt.configGeneration,
      });
  }

  function allowanceFailureStopReason(
    ctx: ExtensionContext,
    event: TurnEndEvent,
    boundary: { entryId: string; message: object },
    failedModelKey: string,
    failureCategory: NonNullable<ReturnType<typeof normalizeFailureObservation>>["category"],
  ): string {
    const content = (event.message as { content?: unknown }).content;
    if ((Array.isArray(content) && content.length > 0)
      || event.toolResults.length > 0 || event.toolResultEntryIds.length > 0) {
      return "Automatic retry stopped because this turn produced output or used tools.";
    }
    if (hasActiveAllowanceRetryAttempt(ctx, boundary, failedModelKey)) {
      const failureLabel = failureCategory === "billing_denied" ? "a billing denial"
        : failureCategory === "allowance_exhausted" ? "a usage limit" : "another failure";
      return `The alternate also returned ${failureLabel}. Automatic retry limit reached.`;
    }
    return "Automatic retry stopped because this turn had other activity.";
  }

  function isSideEffectFreeAllowanceFailure(
    ctx: ExtensionContext,
    assistantMessage: object,
    assistantEntryId: string,
    boundary: { entryId: string; message: object },
    failedModelKey: string,
    toolResults: readonly unknown[] = [],
    toolResultEntryIds: readonly unknown[] = [],
    approvedAssistantEntryIds?: readonly string[],
    requireCurrentOmitted = false,
  ): string[] | undefined {
    const failedMessage = assistantMessage as { role?: unknown; stopReason?: unknown; content?: unknown };
    if (failedMessage.role !== "assistant" || failedMessage.stopReason !== "error") return undefined;
    if (!Array.isArray(failedMessage.content) || failedMessage.content.length !== 0) return undefined;
    if (toolResults.length > 0 || toolResultEntryIds.length > 0) return undefined;
    // Pi computes canContinue before this event's context edits are applied. An empty
    // failed response is therefore marked non-continuable until we omit it below.
    if (ctx.signal?.aborted || ctx.hasPendingMessages?.()) return undefined;
    const branch = ctx.sessionManager.getBranch();
    const userIndexes = branch.flatMap((entry, index) => entry.type === "message"
      && entry.id === boundary.entryId && entry.message === boundary.message ? [index] : []);
    const assistantIndexes = branch.flatMap((entry, index) => entry.type === "message"
      && entry.id === assistantEntryId && entry.message === assistantMessage ? [index] : []);
    let latestAssistantIndex = -1;
    branch.forEach((entry, index) => {
      if (entry.type === "message" && entry.message.role === "assistant") latestAssistantIndex = index;
    });
    if (userIndexes.length !== 1 || assistantIndexes.length !== 1 || latestAssistantIndex !== assistantIndexes[0]) return undefined;
    const allowedRetryEntries = new Set<string>();
    const omittedRetryEntries = new Set<string>();
    // Pi applies the final context edit after its assistant entry. Inspect the
    // complete suffix so a later tool/result/custom entry cannot hide there.
    for (let index = userIndexes[0]! + 1; index < branch.length; index += 1) {
      const entry = branch[index]!;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const message = entry.message as { provider?: unknown; model?: unknown; stopReason?: unknown; content?: unknown };
        if (`${String(message.provider)}/${String(message.model)}` !== failedModelKey
          || message.stopReason !== "error" || !Array.isArray(message.content) || message.content.length !== 0) return undefined;
        allowedRetryEntries.add(entry.id);
        continue;
      }
      if (entry.type === "context_edit" && entry.replacement === null
        && allowedRetryEntries.has(entry.targetId) && !omittedRetryEntries.has(entry.targetId)) {
        omittedRetryEntries.add(entry.targetId);
        continue;
      }
      return undefined;
    }
    if (!allowedRetryEntries.has(assistantEntryId)
      || [...allowedRetryEntries].some((id) => id !== assistantEntryId && !omittedRetryEntries.has(id))
      || (requireCurrentOmitted && !omittedRetryEntries.has(assistantEntryId))) return undefined;
    const approved = [...allowedRetryEntries];
    if (approvedAssistantEntryIds && (approved.length !== approvedAssistantEntryIds.length
      || approved.some((id, index) => id !== approvedAssistantEntryIds[index]))) return undefined;
    return approved;
  }

  function uniqueV1RouteProof(
    ctx: ExtensionContext,
    boundary: { entryId: string; message: object },
    model: string,
  ): AutoRouteProof | undefined {
    const matches = (autoRouteProofsBySession.get(ctx.sessionManager) ?? []).filter((proof) =>
      proof.modelKey === model && proof.entryId === boundary.entryId && proof.userMessage.deref() === boundary.message
      && autoBoundaryStillActive(ctx, { ...proof, message: boundary.message }));
    return matches.length === 1 ? matches[0] : undefined;
  }

  async function retryAllowanceFailure(
    ctx: ExtensionContext,
    pending: PendingAllowanceFailure,
    event: AgentBeforeSettleEvent,
  ): Promise<{ entries: TurnEndEvent["entries"]; continue: true } | undefined> {
    const boundaryMessage = pending.userMessage.deref();
    const assistantMessage = pending.assistantMessage.deref();
    if (!boundaryMessage || !assistantMessage) return undefined;
    const boundary = { entryId: pending.entryId, message: boundaryMessage };
    const { failedModelKey, requestedTier, observation, receipt } = pending;
    const reliability = state.config.reliability;
    if (!isBudgetLimitFailure(observation) || observation?.source !== "runtime") return undefined;
    if (observation.category !== "allowance_exhausted" && observation.category !== "billing_denied") return undefined;
    const failureCategory = observation.category;
    const approvedAssistantEntryIds = isSideEffectFreeAllowanceFailure(ctx, assistantMessage, pending.assistantEntryId, boundary, failedModelKey);
    if (reliability?.retryOnAllowanceExhausted === false) {
      setAllowanceRetryStopReason(ctx, "Automatic retry is off.");
      return undefined;
    }
    if (reliability?.enabled === false || reliability?.cooldownOnAllowanceExhausted === false) {
      setAllowanceRetryStopReason(ctx, "Automatic retry requires reliability and allowance cooldowns to be enabled.");
      return undefined;
    }
    if (!approvedAssistantEntryIds) {
      setAllowanceRetryStopReason(ctx, "The turn changed before retry; no request was sent.");
      return undefined;
    }
    if (!isBifrostAuto(ctx.model) || !state.enabled || state.pinned) {
      setAllowanceRetryStopReason(ctx, "Automatic retry stopped because Auto is no longer active.");
      return undefined;
    }
    if (event.context.pendingMessages.length > 0) {
      setAllowanceRetryStopReason(ctx, "Automatic retry stopped because this turn has queued work.");
      return undefined;
    }
    const previousAttempt = allowanceRetryAttemptBySession.get(ctx.sessionManager);
    if (previousAttempt?.entryId === boundary.entryId && previousAttempt.userMessage.deref() === boundary.message) {
      const failureLabel = failureCategory === "billing_denied" ? "a billing denial" : "a usage limit";
      setAllowanceRetryStopReason(ctx, `The alternate also returned ${failureLabel}. Automatic retry limit reached.`);
      return undefined;
    }
    const proof = receipt
      ? receipt.retryEligible && receipt.userEntryId === boundary.entryId && receipt.userMessage.deref() === boundary.message
        && receipt.configGeneration === (state.configGeneration ?? 0) ? receipt : undefined
      : uniqueV1RouteProof(ctx, boundary, failedModelKey);
    if (!proof) {
      setAllowanceRetryStopReason(ctx, "The original route could not be verified; no retry was sent.");
      return undefined;
    }
    const explicitTier = receipt?.explicitTier ?? pending.explicitTier;
    const initialSelectedTier = receipt?.tier ?? pending.selectedTier;
    if (explicitTier && initialSelectedTier !== requestedTier) {
      setAllowanceRetryStopReason(ctx, "The requested tier selected another tier before this failure; no retry was sent.");
      return undefined;
    }
    const ownerBoundary: AutoUserBoundary = receipt
      ? {
        sessionId: receipt.sessionId,
        entryId: receipt.userEntryId,
        message: boundary.message,
        branchEpoch: receipt.branchEpoch,
        manualGeneration: receipt.manualGeneration,
        configGeneration: receipt.configGeneration,
      }
      : {
        sessionId: (proof as AutoRouteProof).sessionId,
        entryId: (proof as AutoRouteProof).entryId,
        message: boundary.message,
        branchEpoch: (proof as AutoRouteProof).branchEpoch,
        manualGeneration: (proof as AutoRouteProof).manualGeneration,
        configGeneration: (proof as AutoRouteProof).configGeneration,
      };
    if (!autoBoundaryStillActive(ctx, ownerBoundary)) {
      setAllowanceRetryStopReason(ctx, "The turn changed before retry; no request was sent.");
      return undefined;
    }

    const userContent = (boundary.message as { content?: unknown }).content;
    const prompt = typeof userContent === "string"
      ? userContent
      : Array.isArray(userContent)
        ? userContent.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
          && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join("\n")
        : "";
    if (!explicitTier && getPipeline(ctx).matchRule(prompt)?.includes("/")) {
      setAllowanceRetryStopReason(ctx, "Your explicit model route was preserved.");
      return undefined;
    }

    if (receipt) {
      if (!await settleV2Receipt(ctx, receipt, "failure", true)) return undefined;
    } else {
      const saved = state.reliabilityStore.recordFailure(
        failedModelKey,
        "agent_settled",
        observation.category === "billing_denied" ? "billing_denied" : "allowance_exhausted",
        undefined,
        observation,
      );
      if (!saved) {
        setAllowanceRetryStopReason(ctx, "Its cooldown could not be confirmed as saved, so no retry was sent.");
        debugLifecycle("reliability", "allowance_retry_unavailable", ctx.sessionManager, boundary.message, {
          model: failedModelKey,
          tier: requestedTier,
          reason: "cooldown_persistence_unconfirmed",
        });
        return undefined;
      }
      trackerFor(ctx).release(failedModelKey);
    }

    // V2 settlement is asynchronous. A user action, config reload, branch change,
    // or abort that happened while it settled must win over the prepared retry.
    if (ctx.signal?.aborted || ctx.hasPendingMessages?.() || event.context.pendingMessages.length > 0
      || !autoBoundaryStillActive(ctx, ownerBoundary)
      || state.config.reliability?.retryOnAllowanceExhausted === false
      || !isSideEffectFreeAllowanceFailure(ctx, assistantMessage, pending.assistantEntryId, boundary,
        failedModelKey, [], [], approvedAssistantEntryIds)) {
      setAllowanceRetryStopReason(ctx, "The turn changed while saving its cooldown; no request was sent.");
      return undefined;
    }

    const randomValue = Math.random();
    const alternative = resolveAllowanceAlternative(ctx, requestedTier, failedModelKey, randomValue, explicitTier);
    if (!alternative) {
      const failureLabel = failureCategory === "billing_denied" ? "billing was denied for" : "usage limit reached for";
      log(ctx, `Bifrost: ${failureLabel} ${failedModelKey}. No eligible configured alternative is available for ${requestedTier}; no retry was sent.`, "warning");
      debugLifecycle("reliability", "allowance_retry_unavailable", ctx.sessionManager, boundary.message, {
        model: failedModelKey,
        tier: requestedTier,
        reason: "no_configured_alternative",
      });
      return undefined;
    }
    const token: AllowanceRetryToken = {
      sessionId: ownerBoundary.sessionId,
      entryId: boundary.entryId,
      userMessage: new WeakRef(boundary.message),
      branchEpoch: ownerBoundary.branchEpoch,
      manualGeneration: ownerBoundary.manualGeneration,
      configGeneration: ownerBoundary.configGeneration,
      failedModelKey,
      failureCategory,
      assistantEntryId: pending.assistantEntryId,
      approvedAssistantEntryIds,
      requestedTier,
      explicitTier,
      candidateKey: modelKey(alternative.model),
      selectedTier: alternative.selectedTier,
      randomValue,
      expiresAt: Date.now() + ALLOWANCE_RETRY_TTL_MS,
    };
    allowanceRetryBySession.set(ctx.sessionManager, token);
    const priorReference = allowanceRetrySessionRefs.get(ctx.sessionManager);
    if (priorReference) allowanceRetrySessions.delete(priorReference);
    const sessionReference = new WeakRef(ctx.sessionManager);
    allowanceRetrySessionRefs.set(ctx.sessionManager, sessionReference);
    allowanceRetrySessions.add(sessionReference);
    autoRouteProofsBySession.delete(ctx.sessionManager);
    debugLifecycle("reliability", "allowance_retry_prepared", ctx.sessionManager, boundary.message, {
      model: token.candidateKey,
      tier: token.selectedTier,
      reason: "zero_effect_initial_generation",
    });
    return {
      entries: [{ type: "context_edit", targetId: pending.assistantEntryId, replacement: null }],
      continue: true,
    };
  }

  async function settleV2Receipt(
    ctx: ExtensionContext,
    receipt: AutoDispatchReceipt,
    kind: "success" | "failure" | "cancelled",
    suppressAllowanceNotice = false,
  ): Promise<boolean> {
    receipt.finalizing = true;
    const failureObservation = receipt.failureObservation;
    const budgetLimitFailure = isBudgetLimitFailure(failureObservation) ? failureObservation : undefined;
    let settlementConfirmed = false;
    try {
      await serializeReceiptOperation(receipt, async () => {
        if (receipt.finalized) return;
        if (receipt.providerTrialClaim) {
          try {
            await finishProviderDispatch(
              ctx,
              receipt.modelKey,
              kind === "failure" ? receipt.failureObservation : undefined,
              kind === "success",
              receipt.providerTrialClaim,
            );
            receipt.providerTrialClaim = undefined;
          } catch {
            setAllowanceRetryStopReason(ctx, "Provider cooldown could not be saved; no automatic retry was sent.");
            throw new Error("provider trial settlement was not confirmed");
          }
        }
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
          && state.config.reliability?.allowanceCooldownScope === "model"
          && budgetLimitFailure
          && budgetLimitFailure.source === "runtime"
          ? budgetLimitFailure : undefined;
        const recordedObservation = receipt.observationsEnabled ? failureObservation : undefined;
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
          category: kind === "failure" && budgetLimitFailure
            ? budgetLimitFailure.category : settlementConfirmed ? "receipt_settled" : "receipt_settlement_unconfirmed",
          ...(budgetLimitFailure ? {
            evidence: budgetLimitFailure.categoryEvidence,
            scope: state.config.reliability?.allowanceCooldownScope === "model" ? "model-only" : "provider",
          } : {}),
        });
        if (result.status !== "settled" && result.status !== "duplicate") {
          try { log(ctx, `Bifrost reliability v2 could not confirm receipt settlement (${result.status}); inspect local reliability state.`, "warning"); } catch { /* best effort */ }
        }
      });
      if (!suppressAllowanceNotice && kind === "failure" && settlementConfirmed && budgetLimitFailure) {
        const enabled = state.config.reliability?.enabled !== false;
        const cooldownEnabled = state.config.reliability?.cooldownOnAllowanceExhausted !== false;
        let openUntil: number | undefined;
        const providerScoped = state.config.reliability?.allowanceCooldownScope !== "model";
        try {
          openUntil = providerScoped
            ? state.providerCooldownStore?.read(receipt.modelKey.slice(0, receipt.modelKey.indexOf("/")), true).openUntil
            : receipt.store.readSnapshot().scopes[`model:${receipt.modelKey.length}:${receipt.modelKey}`]?.openUntil;
        } catch { /* warning remains best-effort */ }
        if (enabled && cooldownEnabled && openUntil !== undefined) {
          const until = Number.isSafeInteger(openUntil) && openUntil <= 8.64e15 ? new Date(openUntil).toISOString() : "the configured cooldown";
          try {
            const retryEnabled = state.config.reliability?.retryOnAllowanceExhausted !== false;
            const action = takeAllowanceRetryStopReason(ctx)
              ?? (retryEnabled ? "No eligible retry was available. Review the turn, select another model, or resubmit." : "Automatic retry is off.");
            log(ctx, `Bifrost: ${providerScoped ? `provider ${receipt.modelKey.slice(0, receipt.modelKey.indexOf("/"))} is paused` : `${receipt.modelKey} hit a billing or usage limit`}; paused until ${until}. ${action}`, "warning");
          } catch { /* best effort */ }
        } else if (!cooldownEnabled) {
          try { log(ctx, `Bifrost: ${receipt.modelKey} returned a billing or usage limit. Automatic retry requires reliability and allowance cooldowns to be enabled.`, "warning"); } catch { /* best effort */ }
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
    return settlementConfirmed;
  }

  function stopProviderTrialHeartbeat(session: object, model: string): void {
    const timers = providerTrialTimersBySession.get(session);
    const timer = timers?.get(model);
    if (timer) clearInterval(timer);
    timers?.delete(model);
  }

  function startProviderTrialHeartbeat(ctx: ExtensionContext, model: string, claim: ProviderTrialClaim): void {
    let timers = providerTrialTimersBySession.get(ctx.sessionManager);
    if (!timers) {
      timers = new Map();
      providerTrialTimersBySession.set(ctx.sessionManager, timers);
    }
    stopProviderTrialHeartbeat(ctx.sessionManager, model);
    const timer = setInterval(() => {
      const stillOwned = providerClaimsBySession.get(ctx.sessionManager)?.get(model) === claim;
      if (!stillOwned || claim.finalizing || claim.finalized || claim.renewalFailed) return;
      void claim.ownerStore.renewTrial(claim).catch(() => {
        if (!stillOwned || claim.finalizing || claim.finalized) return;
        claim.renewalFailed = true;
        providerCooldownWriteFailed = true;
        stopProviderTrialHeartbeat(ctx.sessionManager, model);
        try { ctx.abort(); } catch { /* abort is best-effort after a failed lease renewal */ }
        try { log(ctx, "Bifrost provider recovery trial could not renew its lease; the active turn was stopped.", "warning"); } catch { /* best effort */ }
      });
    }, V2_RENEW_INTERVAL_MS);
    timer.unref?.();
    timers.set(model, timer);
  }

  async function cleanupProviderTrials(session: object): Promise<void> {
    const claims = providerClaimsBySession.get(session);
    const sessionReference = providerTrialSessionRefBySession.get(session);
    for (const [model, claim] of claims ?? []) {
      if (providerClaimsBySession.get(session) === claims && claims?.get(model) === claim) {
        stopProviderTrialHeartbeat(session, model);
      }
      try { await claim.ownerStore.releaseTrial(claim); }
      catch { providerCooldownWriteFailed = true; }
      if (claims?.get(model) === claim) claims.delete(model);
    }
    if (claims && !claims.size && providerClaimsBySession.get(session) === claims) {
      providerClaimsBySession.delete(session);
      if (providerTrialSessionRefBySession.get(session) === sessionReference) {
        if (sessionReference) providerTrialSessionRefs.delete(sessionReference);
        providerTrialSessionRefBySession.delete(session);
      }
    }
  }

  async function cleanupAllProviderTrials(): Promise<void> {
    for (const reference of [...providerTrialSessionRefs]) {
      const session = reference.deref();
      if (session) await cleanupProviderTrials(session);
      else providerTrialSessionRefs.delete(reference);
    }
  }

  async function cleanupV2Receipts(session: object, kind: "cancelled" = "cancelled"): Promise<void> {
    const owner = v2Receipts.forSession(session);
    for (const receipt of [...owner.receipts.values()]) {
      receipt.finalizing = true;
      try {
        await serializeReceiptOperation(receipt, async () => {
          if (!receipt.finalized) {
            if (receipt.providerTrialClaim) {
              stopProviderTrialHeartbeat(session, receipt.modelKey);
              try { await receipt.providerTrialClaim.ownerStore.releaseTrial(receipt.providerTrialClaim); }
              catch { providerCooldownWriteFailed = true; }
              const pending = providerClaimsBySession.get(session);
              if (pending?.get(receipt.modelKey) === receipt.providerTrialClaim) pending.delete(receipt.modelKey);
              receipt.providerTrialClaim = undefined;
            }
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
    await cleanupProviderTrials(session);
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

  function providerCooldownsEnabled(): boolean {
    return state.enabled && state.config.reliability?.enabled !== false && state.providerCooldownStore !== undefined;
  }

  function isBudgetLimitFailure(observation: ReturnType<typeof normalizeFailureObservation> | undefined): boolean {
    return observation?.category === "allowance_exhausted" || observation?.category === "billing_denied";
  }

  async function recordClassifierProviderFailure(
    model: Pick<Model<Api>, "provider" | "id">,
    httpStatus?: number,
    retryAfter?: string,
    errorText?: string,
  ): Promise<void> {
    if (!providerCooldownsEnabled()) return;
    const observedAt = Date.now();
    const retryAt = typeof retryAfter === "string" ? classifierRetryAt(retryAfter, observedAt) : undefined;
    const observation = normalizeFailureObservation({
      outcomeId: randomUUID(),
      modelKey: `${model.provider}/${model.id}`,
      source: "runtime",
      ...(errorText === undefined ? {} : { errorText }),
      ...(httpStatus === undefined ? {} : { structured: { httpStatus, ...(retryAt === undefined ? {} : { retryAt }) } }),
      observedAt,
    }, { now: observedAt });
    if (!observation) return;
    const store = state.providerCooldownStore;
    if (!store) throw new Error("Provider cooldown state is unavailable.");
    if (isBudgetLimitFailure(observation)
      && state.config.reliability?.cooldownOnAllowanceExhausted !== false
      && state.config.reliability?.allowanceCooldownScope !== "model") {
      await store.pauseUsage(model.provider, observedAt);
    } else if (observation.category === "rate_limit" && observation.categoryEvidence === "http_status") {
      await store.pauseRate(model.provider, observation.retryAt, observedAt);
    }
  }

  async function claimProviderDispatch(ctx: ExtensionContext, model: Model<Api>): Promise<ProviderTrialClaim | undefined> {
    if (!providerCooldownsEnabled()) return undefined;
    if (providerCooldownWriteFailed) throw new Error("Bifrost provider cooldown state could not be saved; routing is blocked.");
    const session = ctx.sessionManager;
    const config = state.config;
    const configGeneration = state.configGeneration ?? 0;
    const lifecycle = autoBootstrapLifecycleBySession.get(session) ?? 0;
    const sessionId = session.getHeader?.()?.id;
    const branch = session.getBranch();
    const branchLength = branch.length;
    const branchHeadId = branch.at(-1)?.id;
    const manualGeneration = v2Receipts.forSession(session).manualGeneration;
    const allowPinnedModel = state.pinned && ctx.model === model;
    const signal = ctx.signal;
    const stillOwned = (): boolean => !signal?.aborted
      && providerCooldownsEnabled()
      && state.config === config
      && (state.configGeneration ?? 0) === configGeneration
      && (autoBootstrapLifecycleBySession.get(session) ?? 0) === lifecycle
      && session.getHeader?.()?.id === sessionId
      && session.getBranch().length === branchLength
      && session.getBranch().at(-1)?.id === branchHeadId
      && v2Receipts.forSession(session).manualGeneration === manualGeneration
      && (!state.pinned || allowPinnedModel);
    const key = modelKey(model);
    const pending = providerClaimsBySession.get(ctx.sessionManager)?.get(key);
    if (pending?.renewalFailed) throw new Error("Bifrost provider recovery-trial renewal failed; routing is blocked.");
    const store = state.providerCooldownStore;
    if (!store) throw new Error("Bifrost provider cooldown state is unavailable; the turn was not sent.");
    const includeUsagePause = state.config.reliability?.cooldownOnAllowanceExhausted !== false
      && state.config.reliability?.allowanceCooldownScope !== "model";
    const currentProvider = store.read(model.provider, includeUsagePause);
    if (currentProvider.openUntil !== undefined) throw new Error(`Bifrost: provider ${model.provider} is paused; no request was sent.`);
    if (pending) return pending;
    const claim = await store.claimTrial(model.provider, includeUsagePause);
    if (!claim.allowed) throw new Error(`Bifrost: provider ${model.provider} is paused or already has a recovery trial; no request was sent.`);
    if (!stillOwned()) {
      if (claim.claim) {
        try { await claim.claim.ownerStore.releaseTrial(claim.claim); }
        catch { providerCooldownWriteFailed = true; }
      }
      throw new Error("Bifrost provider admission became stale; the request was not sent.");
    }
    if (claim.claim) {
      let pending = providerClaimsBySession.get(ctx.sessionManager);
      if (!pending) {
        pending = new Map();
        providerClaimsBySession.set(ctx.sessionManager, pending);
      }
      pending.set(key, claim.claim);
      let reference = providerTrialSessionRefBySession.get(ctx.sessionManager);
      if (!reference) {
        reference = new WeakRef(ctx.sessionManager);
        providerTrialSessionRefBySession.set(ctx.sessionManager, reference);
        providerTrialSessionRefs.add(reference);
      }
      startProviderTrialHeartbeat(ctx, key, claim.claim);
    }
    return claim.claim;
  }

  async function finishProviderDispatch(
    ctx: ExtensionContext,
    model: string,
    observation: ReturnType<typeof normalizeFailureObservation> | undefined,
    succeeded: boolean,
    claim = providerClaimsBySession.get(ctx.sessionManager)?.get(model),
  ): Promise<void> {
    const provider = model.slice(0, model.indexOf("/"));
    const store = state.providerCooldownStore;
    if (!provider || (!store && !claim)) return;
    const session = ctx.sessionManager;
    const pendingClaims = providerClaimsBySession.get(session);
    const sessionReference = providerTrialSessionRefBySession.get(session);
    if (claim && pendingClaims?.get(model) === claim) stopProviderTrialHeartbeat(session, model);
    try {
    if (observation?.source === "runtime" && providerCooldownsEnabled()) {
      if (!store) throw new Error("Bifrost provider cooldown state is unavailable.");
      if ((observation.category === "allowance_exhausted" || observation.category === "billing_denied")
        && state.config.reliability?.cooldownOnAllowanceExhausted !== false) {
        if (state.config.reliability?.allowanceCooldownScope !== "model") await store.pauseUsage(provider);
      } else if (observation.category === "rate_limit"
        && (observation.categoryEvidence === "http_status" || observation.categoryEvidence === "structured")) {
        await store.pauseRate(provider, observation.retryAt);
      }
    }
    if (claim) {
      if (succeeded) await claim.ownerStore.settleTrial(claim);
      else await claim.ownerStore.releaseTrial(claim);
    }
    if (claim && pendingClaims?.get(model) === claim) pendingClaims.delete(model);
    if (pendingClaims && !pendingClaims.size && providerClaimsBySession.get(session) === pendingClaims) {
      providerClaimsBySession.delete(session);
      if (providerTrialSessionRefBySession.get(session) === sessionReference) {
        if (sessionReference) providerTrialSessionRefs.delete(sessionReference);
        providerTrialSessionRefBySession.delete(session);
      }
    }
    } catch (error) {
      providerCooldownWriteFailed = true;
      if (claim && pendingClaims?.get(model) === claim) pendingClaims.delete(model);
      if (pendingClaims && !pendingClaims.size && providerClaimsBySession.get(session) === pendingClaims) {
        providerClaimsBySession.delete(session);
        if (providerTrialSessionRefBySession.get(session) === sessionReference) {
          if (sessionReference) providerTrialSessionRefs.delete(sessionReference);
          providerTrialSessionRefBySession.delete(session);
        }
      }
      throw error;
    }
  }

  function resolveForTier(
    ctx: ExtensionContext,
    tier: string,
    affinityContext?: AffinityRoutingContext,
    bypassV2Snapshot = false,
    random?: () => number,
  ) {
    let reliabilityState = reliabilityV2Enabled() && !bypassV2Snapshot
      ? projectReliabilityV2ForRouting(
          state.reliabilityV2Store?.readSnapshot(),
          reliabilityV2Config(state.config.reliability),
          Date.now(),
        )
      : state.reliabilityStore.getState();
    if (providerCooldownsEnabled()) {
      if (providerCooldownWriteFailed) throw new Error("Bifrost provider cooldown state could not be saved; routing is blocked.");
      if (!state.providerCooldownStore) throw new Error("Bifrost provider cooldown state is unavailable; routing is blocked.");
      if (state.config.reliability?.cooldownOnAllowanceExhausted !== false
        && state.config.reliability?.allowanceCooldownScope !== "model"
        && legacyAllowanceModelKeys.size > 0) {
        const models: ReliabilityState["models"] = Object.assign(Object.create(null), reliabilityState.models);
        for (const key of legacyAllowanceModelKeys) {
          if (!isImportedLegacyV1AllowanceBlock(key) && !importedLegacyV2AllowanceBlock(key)) continue;
          const current = models[key];
          if (!current) continue;
          models[key] = { ...current, failures: [], openUntil: undefined, trialActive: false, cooldownMultiplier: undefined };
        }
        reliabilityState = { version: 1, models };
      }
      const registryModels = typeof ctx.modelRegistry.getAll === "function"
        ? ctx.modelRegistry.getAll() : ctx.modelRegistry.getAvailable();
      reliabilityState = projectProviderCooldownsForRouting(
        reliabilityState,
        state.providerCooldownStore,
        registryModels,
        state.config.reliability?.cooldownOnAllowanceExhausted !== false
          && state.config.reliability?.allowanceCooldownScope !== "model",
      );
    }
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
      random,
      affinityContext,
    );
  }

  function resolveAllowanceAlternative(
    ctx: ExtensionContext,
    requestedTier: string,
    failedModelKey: string,
    randomValue: number,
    explicitTier = false,
  ): { model: Model<Api>; selectedTier: string; attempt: ReturnType<typeof resolveConfiguredTier> } | undefined {
    const random = () => randomValue;
    const firstAttempt = resolveForTier(ctx, requestedTier, undefined, false, random);
    const first = firstAttempt.resolution;
    if (first.selected && modelKey(first.selected) !== failedModelKey
      && (!explicitTier || first.selectedTier === requestedTier)) {
      return { model: first.selected, selectedTier: first.selectedTier ?? requestedTier, attempt: firstAttempt };
    }
    if (explicitTier) return undefined;
    if (hasExplicitTierPolicy(state.config, requestedTier)) return undefined;

    const orderedTiers = [state.config.default, ...Object.keys(state.config.models ?? {})]
      .filter((tier, index, tiers): tier is string => typeof tier === "string" && tier !== requestedTier && tiers.indexOf(tier) === index);
    for (const tier of orderedTiers) {
      const attempt = resolveForTier(ctx, tier, undefined, false, random);
      const result = attempt.resolution;
      if (!result.selected || modelKey(result.selected) === failedModelKey) continue;
      return { model: result.selected, selectedTier: result.selectedTier ?? tier, attempt };
    }
    return undefined;
  }

  function clearAllowanceRetry(session: object, reason: string): void {
    const token = allowanceRetryBySession.get(session) ?? allowanceRetryAttemptBySession.get(session);
    if (reason === "agent_settled") allowanceRetryCancelledBySession.delete(session);
    else if (token && !["explicit_rule_matched", "explicit_tier_override"].includes(reason)) {
      allowanceRetryCancelledBySession.set(session, token);
    }
    allowanceRetryBySession.delete(session);
    allowanceRetryAttemptBySession.delete(session);
    pendingAllowanceFailureBySession.delete(session);
    autoRouteProofsBySession.delete(session);
    const sessionReference = allowanceRetrySessionRefs.get(session);
    if (sessionReference) allowanceRetrySessions.delete(sessionReference);
    allowanceRetrySessionRefs.delete(session);
    if (token) debugLifecycle("reliability", reason === "agent_settled" ? "allowance_retry_settled" : "allowance_retry_cancelled", session, token.userMessage.deref(), {
      model: token.candidateKey,
      tier: token.requestedTier,
      reason,
    });
  }

  function setAllowanceRetryStopReason(ctx: ExtensionContext, reason: string): void {
    allowanceRetryStopReasonBySession.set(ctx.sessionManager, reason);
  }

  function takeAllowanceRetryStopReason(ctx: ExtensionContext): string | undefined {
    const reason = allowanceRetryStopReasonBySession.get(ctx.sessionManager);
    allowanceRetryStopReasonBySession.delete(ctx.sessionManager);
    return reason;
  }

  function currentAllowanceRetry(ctx: ExtensionContext, boundary: AutoUserBoundary, now = Date.now()): AllowanceRetryToken | undefined {
    const token = allowanceRetryBySession.get(ctx.sessionManager);
    if (!token) return undefined;
    const valid = token.sessionId === boundary.sessionId
      && token.entryId === boundary.entryId
      && token.userMessage.deref() === boundary.message
      && token.branchEpoch === boundary.branchEpoch
      && token.manualGeneration === boundary.manualGeneration
      && token.configGeneration === boundary.configGeneration
      && now < token.expiresAt
      && state.enabled && !state.pinned
      && state.config.reliability?.retryOnAllowanceExhausted !== false
      && allowanceRetryBoundaryStillSafe(ctx, token, boundary.message);
    if (!valid) {
      clearAllowanceRetry(ctx.sessionManager, now >= token.expiresAt ? "expired" : "ownership_changed");
      return undefined;
    }
    return token;
  }

  function allowanceRetryBoundaryStillSafe(ctx: ExtensionContext, token: AllowanceRetryToken, message: object): boolean {
    if (ctx.signal?.aborted || ctx.hasPendingMessages?.() || !state.enabled || state.pinned
      || state.config.reliability?.enabled === false || state.config.reliability?.cooldownOnAllowanceExhausted === false
      || state.config.reliability?.retryOnAllowanceExhausted === false
      || !autoBoundaryStillActive(ctx, { ...token, message })) return false;
    const assistant = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.id === token.assistantEntryId);
    return !!assistant && assistant.type === "message"
      && !!isSideEffectFreeAllowanceFailure(ctx, assistant.message, token.assistantEntryId,
        { entryId: token.entryId, message }, token.failedModelKey, [], [], token.approvedAssistantEntryIds, true);
  }

  function recordAutoRouteProof(session: object, proof: AutoRouteProof): void {
    const proofs = (autoRouteProofsBySession.get(session) ?? []).filter((prior) =>
      prior.userMessage.deref() && prior.entryId !== proof.entryId);
    proofs.push(proof);
    while (proofs.length > 8) proofs.shift();
    autoRouteProofsBySession.set(session, proofs);
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
      let activeRouteRequestedTier: string | undefined;
      let activeRouteExplicitTier = false;
      let dispatchRecoveryToken: AllowanceRetryToken | undefined;
      let rejectionCategory = "preflight_rejection";
      let terminalRouteCategory: string | undefined;
      let activeRouteOrigin = request.reason === "direct" ? "direct" : request.reason === "retry" ? "retry" : request.reason === "continuation" ? "continuation" : "automatic";
      try {
      if (requestReason === "user" && state.enabled && !state.pinned) await joinAutoBootstrap(ctx);
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
      const canProveAffinityBoundary = typeof ctx.sessionManager?.getHeader === "function"
        && typeof ctx.sessionManager?.getBranch === "function";
      if (request.reason === "user" && canProveAffinityBoundary && !autoBoundary) {
        autoBoundary = findAutoUserBoundary(ctx, request);
        if (autoBoundary) {
          correlationTurn = autoBoundary.message;
          debugLifecycle("reliability", "boundary", ctx.sessionManager, correlationTurn, { reason: requestReason, status: "proven" });
        }
      }
      if (request.reason === "user" && canProveAffinityBoundary
        && state.enabled && !state.pinned
        && resolvePiAffinityMode(state.config.affinity?.mode, "auto").mode !== "off"
        && !affinityStore) affinityStore = createRuntimeAffinityStore();
      if (!v2Active && affinityStore && canProveAffinityBoundary && request.reason === "user") {
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
        claimTrial: (key) => isImportedLegacyV1AllowanceBlock(key)
          ? { allowed: true, claimed: false }
          : state.reliabilityStore.tryClaimTrial(key),
        abandonTrial: (key) => state.reliabilityStore.abandonTrial(key),
        begin: (key) => trackerFor(ctx).begin(key),
        release: (key) => trackerFor(ctx).release(key),
      });
      const route = createVirtualRoute({
        overrides: overrideFor(ctx),
        fallback: () => routeFailure?.explicitBoundary || v2Active ? undefined : lastDispatchedPhysical(ctx) ?? (state.config.default ? resolveForTier(ctx, state.config.default).resolution.selected : undefined),
        sticky: () => routeFailure?.explicitBoundary || v2Active ? undefined : lastDispatchedPhysical(ctx),
        select: async (prompt, forcedTier, signal) => {
          let activeRecoveryToken: AllowanceRetryToken | undefined;
          dispatchRecoveryToken = undefined;
          let recoveryRuleTier: string | undefined;
          if (request.reason === "user" && autoBoundary) {
            const prepared = allowanceRetryBySession.get(ctx.sessionManager);
            const cancelled = allowanceRetryCancelledBySession.get(ctx.sessionManager);
            const token = currentAllowanceRetry(ctx, autoBoundary);
            if (token && (!forcedTier || forcedTier === token.requestedTier)) {
              const ruleTarget = token.explicitTier ? undefined : getPipeline(ctx).matchRule(prompt);
              recoveryRuleTier = ruleTarget?.includes("/") ? ruleTarget : undefined;
              if (recoveryRuleTier === undefined) {
                activeRecoveryToken = token;
                dispatchRecoveryToken = token;
                allowanceRetryBySession.delete(ctx.sessionManager);
                allowanceRetryAttemptBySession.set(ctx.sessionManager, token);
                debugLifecycle("reliability", "allowance_retry_consumed", ctx.sessionManager, token.userMessage.deref(), {
                  model: token.candidateKey,
                  tier: token.requestedTier,
                  reason: "internal_user_generation",
                });
              } else {
                clearAllowanceRetry(ctx.sessionManager, "explicit_rule_matched");
                forcedTier = recoveryRuleTier;
              }
            } else if (token && forcedTier) {
              clearAllowanceRetry(ctx.sessionManager, "explicit_tier_override");
              terminalRouteCategory = "allowance_retry_tier_changed";
              throw new Error("Bifrost: the prepared usage-limit retry was cancelled because the requested tier changed; no model was dispatched.");
            } else if ([prepared, cancelled].some((candidate) => candidate?.entryId === autoBoundary.entryId
              && candidate.userMessage.deref() === autoBoundary.message)) {
              terminalRouteCategory = "allowance_retry_boundary_changed";
              throw new Error("Bifrost: the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched.");
            }
          } else if (request.reason === "user" && forcedTier) {
            clearAllowanceRetry(ctx.sessionManager, "explicit_tier_override");
          }
          activeRouteOrigin = activeRecoveryToken ? "recovery" : forcedTier ? "explicit_tier" : "automatic";
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
          if (!activeRecoveryToken && state.classifierEnabled && shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS)) {
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
          let classification: ClassificationResult = activeRecoveryToken
            ? { kind: "fallback", tier: activeRecoveryToken.requestedTier }
            : recoveryRuleTier !== undefined
              ? { kind: "classified", tier: recoveryRuleTier, source: "regex" }
              : forcedTier
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
          const affinityMode = resolvePiAffinityMode(
            state.config.affinity?.mode,
            state.enabled && !state.pinned ? "auto" : "physical",
          );
          const affinity: AffinityRoutingContext = {
            intrinsicOrigin: activeRouteOrigin,
            effectiveMode: affinityMode.mode,
            modeSource: affinityMode.source,
            ...(activeRouteOrigin === "automatic" && affinityStore ? (() => { const anchor = affinityAnchor(ctx); return anchor ? { anchor } : {}; })() : {}),
          };
          let recoveryResolution = activeRecoveryToken
            ? resolveAllowanceAlternative(ctx, activeRecoveryToken.requestedTier, activeRecoveryToken.failedModelKey, activeRecoveryToken.randomValue, activeRecoveryToken.explicitTier)
            : undefined;
          if (activeRecoveryToken && !recoveryResolution) {
            terminalRouteCategory = "allowance_retry_candidate_unavailable";
            debugLifecycle("reliability", "allowance_retry_cancelled", ctx.sessionManager, activeRecoveryToken.userMessage.deref(), {
              model: activeRecoveryToken.candidateKey,
              tier: activeRecoveryToken.requestedTier,
              reason: "candidate_unavailable",
            });
            throw new Error("Bifrost: the prepared usage-limit retry has no eligible configured model now; no model was dispatched. The failed turn was not replayed.");
          }
          let attempt = recoveryResolution?.attempt ?? resolveForTier(ctx, classification.tier, affinity);
          let routingDurationMs = +(performance.now() - routeStart).toFixed(3);
          let resolved = attempt.resolution;
          if (!activeRecoveryToken && !resolved.selected && resolved.primary.candidates.length === 0) {
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
              explicitBoundary: !!activeRecoveryToken || resolved.explicitBoundary || hasHardEconomicAdmission(state.economicPolicy) || v2Active || blockedStickyModel,
              ...(blockedStickyModel ? {
                message: `Bifrost: the last dispatched model is on an active model-only allowance cooldown and no configured alternative resolved for tier ${classification.tier}; no model was dispatched.`,
              } : {}),
            };
            if (activeRecoveryToken) {
              routeFailure.message = "Bifrost: the prepared allowance retry no longer has an eligible configured model; no model was dispatched. The failed turn was not replayed.";
              debugLifecycle("reliability", "allowance_retry_cancelled", ctx.sessionManager, activeRecoveryToken.userMessage.deref(), {
                model: activeRecoveryToken.candidateKey,
                tier: activeRecoveryToken.requestedTier,
                reason: "candidate_unavailable",
              });
            }
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
          activeRouteRequestedTier = classification.tier;
          activeRouteExplicitTier = activeRecoveryToken?.explicitTier ?? (activeRouteOrigin === "explicit_tier");
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
          if (request.reason === "user" && autoBoundary) {
            const { message: _userMessage, ...routeBoundary } = autoBoundary;
            recordAutoRouteProof(ctx.sessionManager, {
              ...routeBoundary,
              userMessage: new WeakRef(autoBoundary.message),
              modelKey: modelKey(model),
              requestedTier: classification.tier,
              selectedTier: activeRouteTier,
              explicitTier: activeRouteExplicitTier,
            });
          }
          if (activeRecoveryToken) {
            debugLifecycle("reliability", "allowance_retry_selected", ctx.sessionManager, activeRecoveryToken.userMessage.deref(), {
              model: modelKey(model),
              tier: activeRouteTier,
              reason: modelKey(model) === activeRecoveryToken.candidateKey ? "prepared_candidate" : "revalidated_alternative",
            });
          }
          saveClassifierDecision(prompt, classification);
          log(ctx, `Bifrost auto: ${activeRouteTier ?? classification.tier} → ${modelKey(model)} (${activeRecoveryToken ? "allowance recovery" : classification.kind === "classified" ? classification.source : "fallback"}${resolved.fallbackReason ? `; ${resolved.fallbackReason}` : ""}${resolved.skipped.length > 0 ? `; ${resolved.skipped.length} skipped: ${resolved.skipped.map((s) => s.key).join(", ")}` : ""})`);
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
            const retry = allowanceRetryAttemptBySession.get(ctx.sessionManager);
            if (activeRouteOrigin === "recovery" && retry) {
              const failureLabel = retry.failureCategory === "billing_denied" ? "billing was denied" : "usage limit reached";
              log(ctx, `Bifrost: ${failureLabel} for ${retry.failedModelKey}; retrying once with ${key} (${activeRouteTier ?? retry.selectedTier}).`, "warning");
            }
            return;
          }
          ownership.claim(key, intent, (trial) => debug("virtual", "trial", { model: key, allowed: trial.allowed, claimed: trial.claimed }));
          const retry = allowanceRetryAttemptBySession.get(ctx.sessionManager);
          if (activeRouteOrigin === "recovery" && retry) {
            const failureLabel = retry.failureCategory === "billing_denied" ? "billing was denied" : "usage limit reached";
            log(ctx, `Bifrost: ${failureLabel} for ${retry.failedModelKey}; retrying once with ${key} (${activeRouteTier ?? retry.selectedTier}).`, "warning");
          }
          debug("virtual", "dispatch", { model: key, thinkingLevel });
        },
        beforeDispatch: async (model, currentRequest, intent) => {
          if (dispatchRecoveryToken) {
            const recoveryUser = dispatchRecoveryToken.userMessage.deref();
            if (!recoveryUser || !allowanceRetryBoundaryStillSafe(ctx, dispatchRecoveryToken, recoveryUser)) {
              terminalRouteCategory = "allowance_retry_boundary_changed";
              throw new Error("Bifrost: the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched.");
            }
          }
          if (!v2Active) {
            if (!isVirtualModel(model)) await claimProviderDispatch(ctx, model);
            if (affinityStore && state.enabled && !state.pinned && activeRouteOrigin === "automatic" && currentRequest.reason === "user" && autoBoundary && !isVirtualModel(model)) {
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
              requestedTier: activeRouteRequestedTier ?? activeRouteTier,
              tier: activeRouteTier,
              explicitTier: activeRouteExplicitTier,
              affinityEligible: state.enabled && !state.pinned && activeRouteOrigin === "automatic",
              retryEligible: activeRouteOrigin === "automatic" || activeRouteOrigin === "explicit_tier",
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
            const legacyQuotaMarker = state.config.reliability?.cooldownOnAllowanceExhausted !== false
              && state.config.reliability?.allowanceCooldownScope !== "model"
              ? importedLegacyV2AllowanceBlock(key) : undefined;
            const admission = await store.admit({
              ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId,
              modelKeys: [key],
              ...(legacyQuotaMarker ? { legacyAllowanceMarkers: [legacyQuotaMarker] } : {}),
            });
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
            if (dispatchRecoveryToken && !allowanceRetryBoundaryStillSafe(ctx, dispatchRecoveryToken, boundary.message)) {
              terminalRouteCategory = "allowance_retry_boundary_changed_during_admission";
              await settleV2Receipt(ctx, receipt, "cancelled");
              dispatchReceipt = undefined;
              throw new Error("Bifrost: the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched.");
            }
            receipt.providerTrialClaim = await claimProviderDispatch(ctx, model);
            if (receipt.providerTrialClaim?.renewalFailed) {
              terminalRouteCategory = "provider_trial_renewal_failed";
              throw new Error("Bifrost provider recovery-trial renewal failed; the continuation was not sent.");
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
          receipt.providerTrialClaim = await claimProviderDispatch(ctx, model);
          if (receipt.providerTrialClaim?.renewalFailed) {
            terminalRouteCategory = "provider_trial_renewal_failed";
            throw new Error("Bifrost provider recovery-trial renewal failed; the continuation was not sent.");
          }
          await renewV2Receipt(ctx, receipt);
          if (receipt.providerTrialClaim?.renewalFailed) {
            terminalRouteCategory = "provider_trial_renewal_failed";
            throw new Error("Bifrost provider recovery-trial renewal failed; the continuation was not sent.");
          }
          if (dispatchRecoveryToken && !allowanceRetryBoundaryStillSafe(ctx, dispatchRecoveryToken, boundary.message)) {
            terminalRouteCategory = "allowance_retry_boundary_changed_during_admission";
            throw new Error("Bifrost: the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched.");
          }
          if (receipt.renewalFailed) {
            terminalRouteCategory = "lease_renewal_failed";
            throw new Error("Bifrost reliability v2 could not renew this turn's lease; the continuation was not sent.");
          }
        },
        onDispatchFailed: async (model) => {
          const key = modelKey(model);
          debug("virtual", "dispatch.release", { model: key });
          if (v2Active) {
            if (dispatchReceipt) {
              if (dispatchReceipt.providerTrialClaim) {
                await finishProviderDispatch(ctx, key, undefined, false, dispatchReceipt.providerTrialClaim);
                dispatchReceipt.providerTrialClaim = undefined;
              }
              await settleV2Receipt(ctx, dispatchReceipt, "cancelled");
            }
            dispatchReceipt = undefined;
            return;
          }
          try { await finishProviderDispatch(ctx, key, undefined, false); }
          catch { log(ctx, `Bifrost could not confirm recovery-trial release for provider ${model.provider}.`, "warning"); }
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
    const branch = ctx.sessionManager.getBranch();
    const branchLength = branch.length;
    const branchHeadId = branch.at(-1)?.id;
    const lifecycle = autoBootstrapLifecycleBySession.get(ctx.sessionManager) ?? 0;
    await cleanupProviderTrials(ctx.sessionManager);
    clearAllowanceRetry(ctx.sessionManager, "session_start");
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
    const currentBranch = ctx.sessionManager.getBranch();
    if (lifecycle === (autoBootstrapLifecycleBySession.get(ctx.sessionManager) ?? 0)
      && currentBranch.length === branchLength && currentBranch.at(-1)?.id === branchHeadId) {
      startAutoBootstrap(ctx);
    }
  });

  pi.on("session_before_tree", async (_event, ctx) => {
    advanceAutoBootstrapLifecycle(ctx.sessionManager);
    cancelAutoBootstrap(ctx.sessionManager);
    await cleanupProviderTrials(ctx.sessionManager);
    clearAllowanceRetry(ctx.sessionManager, "branch_changed");
    affinityStore?.reset(ctx.sessionManager);
    pendingAffinityBySession.delete(ctx.sessionManager);
    if (reliabilityV2Enabled()) {
      v2Receipts.advanceBranch(ctx.sessionManager);
      await cleanupV2Receipts(ctx.sessionManager);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    advanceAutoBootstrapLifecycle(ctx.sessionManager);
    cancelAutoBootstrap(ctx.sessionManager);
    await cleanupProviderTrials(ctx.sessionManager);
    clearAllowanceRetry(ctx.sessionManager, "session_shutdown");
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
    const allowanceRetryEnabled = state.config.reliability?.enabled !== false
      && state.config.reliability?.cooldownOnAllowanceExhausted !== false
      && state.config.reliability?.retryOnAllowanceExhausted !== false;
    if ((!reliabilityV2Enabled() && !affinityStore && !allowanceRetryEnabled && !providerCooldownsEnabled()) || event.message.role !== "assistant") return;
    const boundary = turnUserBoundary(ctx, event);
    if (!boundary) return;
    if (!reliabilityV2Enabled()) {
      const proof = pendingAffinity(ctx.sessionManager)?.get(boundary.entryId);
      if (proof && proof.userMessage.deref() === boundary.message && (event.message.stopReason === "stop" || event.message.stopReason === "length")) {
        proof.outcome = "success";
        proof.assistantEntryId = event.messageEntryId;
        proof.successObservedAt = Date.now();
      } else if (proof && proof.userMessage.deref() === boundary.message && event.message.stopReason === "toolUse") {
        proof.outcome = undefined;
        proof.assistantEntryId = undefined;
        proof.successObservedAt = undefined;
      } else if (proof && proof.userMessage.deref() === boundary.message) {
        proof.outcome = event.message.stopReason === "error" ? "failure" : "unknown";
        proof.assistantEntryId = undefined;
        proof.successObservedAt = undefined;
      }
      const provider = event.message.provider;
      const model = event.message.model;
      if ((allowanceRetryEnabled || providerCooldownsEnabled()) && event.message.stopReason === "error"
        && typeof provider === "string" && typeof model === "string") {
        const failedModelKey = `${provider}/${model}`;
        const observation = normalizeFailureObservation({
          outcomeId: randomUUID(), modelKey: failedModelKey, source: "runtime", observedAt: Date.now(),
          ...(typeof (event.message as typeof event.message & { errorMessage?: unknown }).errorMessage === "string"
            ? { errorText: (event.message as typeof event.message & { errorMessage: string }).errorMessage } : {}),
        });
        try { await finishProviderDispatch(ctx, failedModelKey, observation, false); }
        catch {
          setAllowanceRetryStopReason(ctx, "Provider cooldown could not be saved; no automatic retry was sent.");
          if (allowanceRetryEnabled && isBudgetLimitFailure(observation)) return;
        }
        const routeProof = uniqueV1RouteProof(ctx, boundary, failedModelKey);
        if (routeProof && observation && isBudgetLimitFailure(observation)) {
          const safeFailure = isSideEffectFreeAllowanceFailure(ctx, event.message, event.messageEntryId, boundary,
            failedModelKey, event.toolResults, event.toolResultEntryIds);
          if (safeFailure) pendingAllowanceFailureBySession.set(ctx.sessionManager, {
            sessionId: routeProof.sessionId,
            entryId: routeProof.entryId,
            userMessage: new WeakRef(boundary.message),
            branchEpoch: routeProof.branchEpoch,
            manualGeneration: routeProof.manualGeneration,
            configGeneration: routeProof.configGeneration,
            assistantEntryId: event.messageEntryId,
            assistantMessage: new WeakRef(event.message),
            failedModelKey,
            requestedTier: routeProof.requestedTier,
            selectedTier: routeProof.selectedTier,
            explicitTier: routeProof.explicitTier,
            observation,
          });
          else {
            setAllowanceRetryStopReason(ctx, allowanceFailureStopReason(ctx, event, boundary, failedModelKey, observation.category));
          }
        }
      }
      if (providerCooldownsEnabled() && typeof provider === "string" && typeof model === "string"
        && (event.message.stopReason === "stop" || event.message.stopReason === "length" || event.message.stopReason === "toolUse")) {
        try { await finishProviderDispatch(ctx, `${provider}/${model}`, undefined, true); }
        catch { log(ctx, `Bifrost could not confirm recovery-trial settlement for provider ${provider}.`, "warning"); }
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
    let providerObservation: ReturnType<typeof normalizeFailureObservation> | undefined;
    if (event.message.stopReason === "error") {
      receipt.outcome = "failure";
      receipt.assistantEntryId = undefined;
      receipt.successObservedAt = undefined;
      if (receipt.observationsEnabled || state.config.reliability?.cooldownOnAllowanceExhausted !== false || providerCooldownsEnabled()) {
        const errorText = (event.message as typeof event.message & { errorMessage?: unknown }).errorMessage;
        const observation = normalizeFailureObservation({
          outcomeId: receipt.outcomeId,
          modelKey: receipt.modelKey,
          source: "runtime",
          ...(typeof errorText === "string" ? { errorText } : {}),
        });
        providerObservation = observation;
        receipt.failureObservation = receipt.observationsEnabled
          ? observation
          : isBudgetLimitFailure(observation) ? observation : undefined;
      }
      try { await finishProviderDispatch(ctx, receipt.modelKey, providerObservation, false, receipt.providerTrialClaim); }
      catch {
        setAllowanceRetryStopReason(ctx, "Provider cooldown could not be saved; no automatic retry was sent.");
        receipt.providerTrialClaim = undefined;
        return;
      }
      receipt.providerTrialClaim = undefined;
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
      try { await finishProviderDispatch(ctx, receipt.modelKey, undefined, true, receipt.providerTrialClaim); }
      catch { log(ctx, `Bifrost could not confirm recovery-trial settlement for provider ${assistantProvider}.`, "warning"); }
      receipt.providerTrialClaim = undefined;
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
    if (allowanceRetryEnabled && event.message.stopReason === "error" && receipt.failureObservation && isBudgetLimitFailure(receipt.failureObservation)
      && (receipt.retryEligible || hasActiveAllowanceRetryAttempt(ctx, boundary, receipt.modelKey))) {
      const safeFailure = receipt.retryEligible && isSideEffectFreeAllowanceFailure(ctx, event.message, event.messageEntryId, boundary,
        receipt.modelKey, event.toolResults, event.toolResultEntryIds);
      if (safeFailure) pendingAllowanceFailureBySession.set(ctx.sessionManager, {
        sessionId: receipt.sessionId,
        entryId: receipt.userEntryId,
        userMessage: new WeakRef(boundary.message),
        branchEpoch: receipt.branchEpoch,
        manualGeneration: receipt.manualGeneration,
        configGeneration: receipt.configGeneration,
        assistantEntryId: event.messageEntryId,
        assistantMessage: new WeakRef(event.message),
        failedModelKey: receipt.modelKey,
        requestedTier: receipt.requestedTier,
        selectedTier: receipt.tier,
        explicitTier: receipt.explicitTier,
        observation: receipt.failureObservation,
        receipt,
      });
      else {
        setAllowanceRetryStopReason(ctx, allowanceFailureStopReason(ctx, event, boundary, receipt.modelKey, receipt.failureObservation.category));
      }
    }
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const pending = pendingAllowanceFailureBySession.get(ctx.sessionManager);
    if (!pending) return;
    pendingAllowanceFailureBySession.delete(ctx.sessionManager);
    const retry = await retryAllowanceFailure(ctx, pending, event);
    if (retry) return retry;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settled = trackerFor(ctx).settle();
    clearAllowanceRetry(ctx.sessionManager, "agent_settled");
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
      await cleanupProviderTrials(ctx.sessionManager);
      return;
    }
    if (affinityStore) {
      const pending = pendingAffinity(ctx.sessionManager);
      if (pending) {
        for (const proof of pending.values()) promotePendingAffinity(ctx, proof);
        pending.clear();
      }
    }
    await cleanupProviderTrials(ctx.sessionManager);
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
        const allowanceObservation = isBudgetLimitFailure(outcome.failureObservation)
          ? outcome.failureObservation : undefined;
        state.reliabilityStore.recordFailure(
          outcome.model,
          "agent_settled",
          allowanceObservation ? "allowance_exhausted" : outcome.reason ?? "provider request failed",
          undefined,
          allowanceObservation && state.config.reliability?.allowanceCooldownScope === "model"
            ? allowanceObservation : undefined,
        );
        if (allowanceObservation && state.config.reliability?.cooldownOnAllowanceExhausted !== false) {
          const providerScoped = state.config.reliability?.allowanceCooldownScope !== "model";
          let openUntil: number | undefined;
          try {
            openUntil = providerScoped
              ? state.providerCooldownStore?.read(outcome.model.slice(0, outcome.model.indexOf("/")), true).openUntil
              : state.reliabilityStore.getCircuitState(outcome.model).openUntil;
          } catch { /* best-effort message, routing remains fail-closed */ }
          const until = openUntil !== undefined && Number.isSafeInteger(openUntil) && openUntil <= 8.64e15
            ? new Date(openUntil).toISOString() : "the configured cooldown";
          const retryEnabled = state.config.reliability?.retryOnAllowanceExhausted !== false;
          const action = takeAllowanceRetryStopReason(ctx)
            ?? (retryEnabled ? "No eligible retry was available. Review the turn, select another model, or resubmit." : "Automatic retry is off.");
          log(ctx, `Bifrost: ${providerScoped ? `provider ${outcome.model.slice(0, outcome.model.indexOf("/"))} is paused` : `${outcome.model} hit a billing or usage limit`}; paused until ${until}. ${action}`, "warning");
        } else if (allowanceObservation) {
          log(ctx, `Bifrost: ${outcome.model} hit a provider billing or usage limit. Automatic retry requires reliability and allowance cooldowns to be enabled.`, "warning");
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
    if (selfSelect.consume(ctx.sessionManager, event.source, modelKey(event.model))) {
      const branch = ctx.sessionManager.getBranch();
      const tail = branch.at(-1) as {
        type?: unknown; id?: unknown; parentId?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown;
      } | undefined;
      const previous = branch.at(-2) as {
        type?: unknown; id?: unknown; parentId?: unknown; provider?: unknown; modelId?: unknown;
      } | undefined;
      const hasThinkingChange = tail?.type === "thinking_level_change";
      const entry = hasThinkingChange ? previous : tail;
      if (entry?.type === "model_change" && typeof entry.id === "string"
        && (entry.parentId === undefined || typeof entry.parentId === "string")
        && entry.provider === event.model.provider && entry.modelId === event.model.id
        && (!hasThinkingChange || (tail?.parentId === entry.id
          && typeof tail.id === "string" && typeof tail.thinkingLevel === "string"
          && tail.thinkingLevel === ctx.thinkingLevel))) {
        selfSetModelChangeBySession.set(ctx.sessionManager, {
          entryId: entry.id,
          ...(typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
          modelKey: modelKey(event.model),
          ...(hasThinkingChange && typeof tail?.id === "string" && typeof tail.thinkingLevel === "string"
            ? { thinkingEntryId: tail.id, thinkingLevel: tail.thinkingLevel } : {}),
        });
      }
      return;
    }
    // Session restore replays a recorded selection; it is not a user action.
    if (isPassiveModelSelection(event.source)) {
      debug("bifrost", "model_select.restore", { model: modelKey(event.model) });
      return;
    }
    advanceAutoBootstrapLifecycle(ctx.sessionManager);
    cancelAutoBootstrap(ctx.sessionManager);
    // Selecting the virtual profile is an explicit request for per-prompt routing.
    if (isBifrostAuto(ctx.model)) {
      affinityStore?.reset(ctx.sessionManager);
      pendingAffinityBySession.delete(ctx.sessionManager);
      if (reliabilityV2Enabled()) {
        v2Receipts.advanceManual(ctx.sessionManager);
        await cleanupV2Receipts(ctx.sessionManager);
      }
      await cleanupProviderTrials(ctx.sessionManager);
      overrideFor(ctx).clear();
      state.pinned = false;
      state.enabled = true;
      startAutoBootstrap(ctx);
      state.saveModeState();
      debugLifecycle("bifrost", "manual_selection", ctx.sessionManager, undefined, { target: "auto", category: "user_selected_auto" });
      debug("bifrost", "model_select.virtual_auto");
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost Auto selected; routing each prompt to a physical model");
      return;
    }
    if (!state.enabled) return;

    state.pinned = true;
    affinityStore?.reset(ctx.sessionManager);
    pendingAffinityBySession.delete(ctx.sessionManager);
    if (reliabilityV2Enabled()) {
      v2Receipts.advanceManual(ctx.sessionManager);
      await cleanupV2Receipts(ctx.sessionManager);
    }
    await cleanupProviderTrials(ctx.sessionManager);
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

  pi.on("input", async (event, ctx): Promise<InputEventResult> => {
    const admissionSession = ctx.sessionManager;
    selfSetModelChangeBySession.delete(admissionSession);
    const admissionSessionId = admissionSession.getHeader?.()?.id;
    const admissionLifecycle = autoBootstrapLifecycleBySession.get(admissionSession) ?? 0;
    const admissionBranch = admissionSession.getBranch();
    const admissionBranchLength = admissionBranch.length;
    const admissionBranchHeadId = admissionBranch.at(-1)?.id;
    const admissionBranchEntryIds = admissionBranch.map((entry) => entry.id);
    const admissionManualGeneration = v2Receipts.forSession(admissionSession).manualGeneration;
    const admissionSignal = ctx.signal;
    const result = await (async (): Promise<InputEventResult> => {
    const originalText = event.text;
    const editorTextAtInput = readEditorText(ctx);
    let routeBoundary = routingPolicyInvalid(state) || hasExplicitTierPolicies(state.config) || hasHardEconomicAdmission(state.economicPolicy) || reliabilityV2Enabled();
    let strictBoundary = routeBoundary || providerCooldownsEnabled();
    let begunStrictModel: string | undefined;
    let claimedTrial: string | undefined;
    let claimedProviderTrial: ProviderTrialClaim | undefined;
    try {
    if (event.source === "extension") {
      routeBoundary = false;
      strictBoundary = false;
      return { action: "continue" };
    }
    if (providerCooldownsEnabled()) {
      try { await ensureProviderAllowanceImports(); }
      catch {
        return strictInputHandled(ctx, state, originalText, editorTextAtInput,
          "Bifrost could not verify saved provider allowance cooldowns; the turn was not sent.");
      }
    }
    if (state.enabled && reliabilityV2Enabled() && !isBifrostAuto(ctx.model)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost reliability stateVersion 2 supports Auto turns only; select bifrost/auto or use reliability stateVersion 1. The turn was not sent.");
    }
    if (!state.enabled || state.pinned) {
      routeBoundary = false;
      strictBoundary = false;
    }
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
      const pinnedModel = ctx.model;
      if (state.enabled && state.pinned && pinnedModel && !isVirtualModel(pinnedModel) && providerCooldownsEnabled()) {
        try { claimedProviderTrial = await claimProviderDispatch(ctx, pinnedModel); }
        catch {
          return strictInputHandled(ctx, state, originalText, editorTextAtInput,
            `Bifrost: provider ${pinnedModel.provider} is paused, has a recovery trial in progress, or its cooldown state is unavailable; the pinned model was not dispatched.`);
        }
      }
      debug("input", "bypass", { enabled: state.enabled, pinned: state.pinned });
      syncBifrostModeStatus(ctx, state);
      // The accepted turn owns the claim until turn_end settles it.
      claimedProviderTrial = undefined;
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (text.startsWith("/")) {
      routeBoundary = false;
      strictBoundary = false;
      return { action: "continue" };
    }
    await joinAutoBootstrap(ctx);
    if (state.config.affinity?.mode === "retain-within-tier" && !isBifrostAuto(ctx.model)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost retain-within-tier is supported for Auto user turns only; select bifrost/auto, or use affinity mode observe for physical routing. The turn was not sent.");
    }
    if (routingPolicyInvalid(state)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing is blocked by an invalid routing or economic policy config; fix the config and run /bifrost reload.");
    }

    // Inline tier override: "frontier debug this" forces that tier for one prompt.
    // Pi reserves / for commands, ! for bash. Just type the tier name as first word.
    const { forcedTier, promptText } = parseInlineOverride(text, state.config.models);
    if (forcedTier) {
      routeBoundary = hasExplicitTierPolicy(state.config, forcedTier)
        || hasHardEconomicAdmission(state.economicPolicy);
      strictBoundary = routeBoundary || providerCooldownsEnabled();
    }
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
      routeBoundary = routeBoundary || (!!forcedTier && hasExplicitTierPolicy(state.config, forcedTier));
      strictBoundary = routeBoundary || providerCooldownsEnabled();
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
            return routeBoundary
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
        routeBoundary = routeBoundary || hasExplicitTierPolicies(state.config);
        strictBoundary = routeBoundary || providerCooldownsEnabled();
        return routeBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost configuration changed during routing; the turn was not sent. Resubmit after repair.")
          : { action: "continue" };
      }
      if (ctx.signal?.aborted) {
        endClassify({ kind: classification.kind, outcome: "aborted" });
        endInput({ outcome: "aborted" });
        return routeBoundary
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
        routeBoundary = false;
        strictBoundary = providerCooldownsEnabled();
        log(ctx, "Bifrost: no tier matched — using default model", "warning");
        debug("input", "unclassified");
        syncBifrostModeStatus(ctx, state);
        endInput();
        if (ctx.model && !isVirtualModel(ctx.model) && providerCooldownsEnabled()) {
          try { claimedProviderTrial = await claimProviderDispatch(ctx, ctx.model); }
          catch {
            return strictInputHandled(ctx, state, originalText, editorTextAtInput,
              `Bifrost: provider ${ctx.model.provider} is paused, has a recovery trial in progress, or its cooldown state is unavailable; the turn was not sent.`);
          }
          claimedProviderTrial = undefined;
        }
        return defaultAction;
      }

      const tier = classification.tier;
      routeBoundary = hasExplicitTierPolicy(state.config, tier)
        || hasHardEconomicAdmission(state.economicPolicy);
      strictBoundary = routeBoundary || providerCooldownsEnabled();
      const routeStart = performance.now();
      const physicalAffinityMode = resolvePiAffinityMode(state.config.affinity?.mode, "physical");
      const physicalAffinity: AffinityRoutingContext = {
        intrinsicOrigin: forcedTier ? "explicit_tier" : "automatic",
        effectiveMode: physicalAffinityMode.mode,
        modeSource: physicalAffinityMode.source,
      };
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
        try { claimedProviderTrial = await claimProviderDispatch(ctx, model); }
        catch {
          const message = `Bifrost: provider ${model.provider} is paused, has a recovery trial in progress, or its cooldown state is unavailable; the turn was not sent.`;
          log(ctx, message, "warning");
          endInput({ model: modelKey(model), outcome: "provider_cooldown_blocked" });
          return strictInputHandled(ctx, state, originalText, editorTextAtInput, message);
        }
        const selectedKey = modelKey(model);
        const trial = isImportedLegacyV1AllowanceBlock(selectedKey)
          ? { allowed: true, claimed: false }
          : state.reliabilityStore.tryClaimTrial(selectedKey);
        if (!trial.allowed) {
          debug("input", "trial_unavailable", { model: modelKey(model) });
          log(ctx, `Bifrost: ${modelKey(model)} already has a half-open trial in progress`, "warning");
          syncBifrostModeStatus(ctx, state);
          endInput();
          if (claimedProviderTrial) {
            try { await finishProviderDispatch(ctx, selectedKey, undefined, false, claimedProviderTrial); }
            catch {
              claimedProviderTrial = undefined;
              return strictInputHandled(ctx, state, originalText, editorTextAtInput,
                "Bifrost could not release the unused provider recovery trial; the turn was not sent.");
            }
            claimedProviderTrial = undefined;
          }
          if (routeBoundary) {
            return strictInputHandled(ctx, state, originalText, editorTextAtInput,
              "Bifrost strict route is unavailable; the turn was not sent. Resubmit after repair.");
          }
          if (ctx.model && !isVirtualModel(ctx.model) && providerCooldownsEnabled()) {
            try { claimedProviderTrial = await claimProviderDispatch(ctx, ctx.model); }
            catch {
              return strictInputHandled(ctx, state, originalText, editorTextAtInput,
                `Bifrost: provider ${ctx.model.provider} is paused, has a recovery trial in progress, or its cooldown state is unavailable; the turn was not sent.`);
            }
            claimedProviderTrial = undefined;
          }
          return defaultAction;
        }
        if (trial.claimed) claimedTrial = modelKey(model);
      }

      if (!model) {
        state.forceRegistryRefresh = true;
        debug("input", "no_model", { tier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache" });
        if (providerCooldownsEnabled() && ctx.model) {
          try {
            const paused = state.providerCooldownStore!.read(ctx.model.provider,
              state.config.reliability?.cooldownOnAllowanceExhausted !== false
              && state.config.reliability?.allowanceCooldownScope !== "model");
            if (paused.openUntil !== undefined || paused.trialActive) {
              return strictInputHandled(ctx, state, originalText, editorTextAtInput,
                `Bifrost: provider ${ctx.model.provider} is paused or has a recovery trial in progress; no configured route can handle this turn.`);
            }
          } catch {
            return strictInputHandled(ctx, state, originalText, editorTextAtInput,
              "Bifrost provider cooldown state is unavailable; the turn was not sent.");
          }
        }
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
        if (!routeBoundary && ctx.model && !isVirtualModel(ctx.model) && providerCooldownsEnabled()) {
          try { claimedProviderTrial = await claimProviderDispatch(ctx, ctx.model); }
          catch {
            return strictInputHandled(ctx, state, originalText, editorTextAtInput,
              `Bifrost: provider ${ctx.model.provider} is paused, has a recovery trial in progress, or its cooldown state is unavailable; the turn was not sent.`);
          }
          claimedProviderTrial = undefined;
        }
        return routeBoundary
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
        log(ctx, `Bifrost: ${selectedTier} → ${modelKey(model)} (already active, ${source}${reason})`);
        debug("input", "model_unchanged", { model: modelKey(model), selectedTier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", ...classifierIdentity, thinkingLevel: ctx.thinkingLevel });
        debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", ...classifierIdentity, thinkingLevel: ctx.thinkingLevel });
        begunStrictModel = modelKey(model);
        trackerFor(ctx).begin(begunStrictModel);
        endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: ctx.thinkingLevel });
        claimedProviderTrial = undefined;
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
        await finishProviderDispatch(ctx, modelKey(model), undefined, false, claimedProviderTrial);
        claimedProviderTrial = undefined;
        claimedTrial = undefined;
        try { syncBifrostModeStatus(ctx, state); } catch { /* best effort */ }
        try { log(ctx, `Bifrost: no API key for ${modelKey(model)}`, "error"); } catch { /* best effort */ }
        try { endInput({ model: modelKey(model), ok: false }); } catch { /* optional timing output */ }
        return routeBoundary
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
      claimedProviderTrial = undefined;
      claimedTrial = undefined;
      begunStrictModel = undefined;
      try { syncBifrostModeStatus(ctx, state); } catch { /* optional status must not suppress an activated turn */ }
      try { log(ctx, doneMsg); } catch { /* optional notification must not suppress an activated turn */ }
      try { debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", ...classifierIdentity, routingDurationMs, thinkingLevel: ctx.thinkingLevel }); } catch { /* optional trace output */ }
      try { endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: ctx.thinkingLevel }); } catch { /* optional timing output */ }
      return defaultAction;
    } finally {
      try {
        if (claimedProviderTrial) {
          const pending = providerClaimsBySession.get(ctx.sessionManager);
          for (const [key, claim] of pending ?? []) {
            if (claim !== claimedProviderTrial) continue;
            stopProviderTrialHeartbeat(ctx.sessionManager, key);
            pending?.delete(key);
          }
          await claimedProviderTrial.ownerStore.releaseTrial(claimedProviderTrial);
          if (!pending?.size) {
            providerClaimsBySession.delete(ctx.sessionManager);
            const reference = providerTrialSessionRefBySession.get(ctx.sessionManager);
            if (reference) providerTrialSessionRefs.delete(reference);
            providerTrialSessionRefBySession.delete(ctx.sessionManager);
          }
        }
      } catch { providerCooldownWriteFailed = true; }
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
    })();

    const isUserTurn = event.source !== "extension" && event.text.trim() !== "" && !event.text.trim().startsWith("/");
    const acceptedAction = result && typeof result === "object"
      && (result.action === "continue" || result.action === "transform");
    const activeModel = ctx.model;
    const selfSetModelChange = selfSetModelChangeBySession.get(admissionSession);
    selfSetModelChangeBySession.delete(admissionSession);
    if (isUserTurn && acceptedAction && state.enabled && providerCooldownsEnabled()
      && activeModel && !isVirtualModel(activeModel)) {
      const admissionIsCurrent = (): boolean => {
        const currentBranch = admissionSession.getBranch();
        const branchPrefixIsOriginal = admissionBranchEntryIds.every((id, index) => currentBranch[index]?.id === id);
        const branchIsOriginal = branchPrefixIsOriginal && currentBranch.length === admissionBranchLength
          && currentBranch.at(-1)?.id === admissionBranchHeadId;
        const modelChange = currentBranch[admissionBranchLength] as {
          type?: unknown; id?: unknown; parentId?: unknown; provider?: unknown; modelId?: unknown;
        } | undefined;
        const thinkingChange = currentBranch[admissionBranchLength + 1] as {
          type?: unknown; id?: unknown; parentId?: unknown; thinkingLevel?: unknown;
        } | undefined;
        const branchHasOnlyOwnSetModelEntries = !!selfSetModelChange
          && selfSetModelChange.modelKey === modelKey(activeModel)
          && currentBranch.length === admissionBranchLength + (selfSetModelChange.thinkingEntryId ? 2 : 1)
          && modelChange?.type === "model_change"
          && modelChange.id === selfSetModelChange.entryId
          && modelChange.parentId === admissionBranchHeadId
          && modelChange.provider === activeModel.provider
          && modelChange.modelId === activeModel.id
          && (!selfSetModelChange.thinkingEntryId || (
            thinkingChange?.type === "thinking_level_change"
            && thinkingChange.id === selfSetModelChange.thinkingEntryId
            && thinkingChange.parentId === selfSetModelChange.entryId
            && thinkingChange.thinkingLevel === selfSetModelChange.thinkingLevel
            && selfSetModelChange.thinkingLevel === ctx.thinkingLevel
          ));
        return !admissionSignal?.aborted
          && ctx.sessionManager === admissionSession
          && ctx.model === activeModel
          && modelKey(ctx.model) === modelKey(activeModel)
          && admissionSession.getHeader?.()?.id === admissionSessionId
          && (autoBootstrapLifecycleBySession.get(admissionSession) ?? 0) === admissionLifecycle
          && (state.pinned || v2Receipts.forSession(admissionSession).manualGeneration === admissionManualGeneration)
          && (branchIsOriginal || (branchPrefixIsOriginal && branchHasOnlyOwnSetModelEntries));
      };
      if (!admissionIsCurrent()) {
        return strictInputHandled(ctx, state, event.text, readEditorText(ctx),
          "Bifrost routing became stale before provider admission; the turn was not sent.");
      }
      if (reliabilityV2Enabled()) {
        return strictInputHandled(ctx, state, event.text, readEditorText(ctx),
          "Bifrost reliability stateVersion 2 supports Auto turns only; the physical turn was not sent.");
      }

      const actualKey = modelKey(activeModel);
      const claims = providerClaimsBySession.get(admissionSession);
      const claimsReference = providerTrialSessionRefBySession.get(admissionSession);
      for (const [key, claim] of [...(claims ?? [])]) {
        if (key === actualKey) continue;
        stopProviderTrialHeartbeat(admissionSession, key);
        try { await claim.ownerStore.releaseTrial(claim); }
        catch {
          providerCooldownWriteFailed = true;
          return strictInputHandled(ctx, state, event.text, readEditorText(ctx),
            "Bifrost could not release an unused provider recovery trial; the turn was not sent.");
        }
        if (claims?.get(key) === claim) claims.delete(key);
        if (!admissionIsCurrent()) {
          if (claims && !claims.size && providerClaimsBySession.get(admissionSession) === claims) {
            providerClaimsBySession.delete(admissionSession);
            if (providerTrialSessionRefBySession.get(admissionSession) === claimsReference) {
              if (claimsReference) providerTrialSessionRefs.delete(claimsReference);
              providerTrialSessionRefBySession.delete(admissionSession);
            }
          }
          return strictInputHandled(ctx, state, event.text, readEditorText(ctx),
            "Bifrost routing became stale before provider admission; the turn was not sent.");
        }
      }
      if (claims && !claims.size && providerClaimsBySession.get(admissionSession) === claims) {
        providerClaimsBySession.delete(admissionSession);
        if (providerTrialSessionRefBySession.get(admissionSession) === claimsReference) {
          if (claimsReference) providerTrialSessionRefs.delete(claimsReference);
          providerTrialSessionRefBySession.delete(admissionSession);
        }
      }
      let finalClaim: ProviderTrialClaim | undefined;
      try { finalClaim = await claimProviderDispatch(ctx, activeModel); }
      catch {
        return strictInputHandled(ctx, state, event.text, readEditorText(ctx),
          `Bifrost: provider ${activeModel.provider} is paused, has a recovery trial in progress, or its cooldown state is unavailable; the turn was not sent.`);
      }
      if (!admissionIsCurrent()) {
        const currentClaims = providerClaimsBySession.get(admissionSession);
        const currentReference = providerTrialSessionRefBySession.get(admissionSession);
        if (finalClaim && currentClaims?.get(actualKey) === finalClaim) {
          stopProviderTrialHeartbeat(admissionSession, actualKey);
          try { await finalClaim.ownerStore.releaseTrial(finalClaim); }
          catch { providerCooldownWriteFailed = true; }
          if (currentClaims.get(actualKey) === finalClaim) currentClaims.delete(actualKey);
          if (!currentClaims.size && providerClaimsBySession.get(admissionSession) === currentClaims) {
            providerClaimsBySession.delete(admissionSession);
            if (providerTrialSessionRefBySession.get(admissionSession) === currentReference) {
              if (currentReference) providerTrialSessionRefs.delete(currentReference);
              providerTrialSessionRefBySession.delete(admissionSession);
            }
          }
        }
        return strictInputHandled(ctx, state, event.text, readEditorText(ctx),
          "Bifrost routing became stale before provider admission; the turn was not sent.");
      }
    }
    return result;
  });
}
