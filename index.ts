import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { classifyWithLLM as invokeClassifier, type ClassifierModel } from "./classifier.ts";
import { classifierCacheEnabled, classifierCacheKey, boundedClassifierPrompt, directStagePlan } from "./classifier-semantics.ts";
import { ClassifierMetricsStore, classifierMetricsEnabled } from "./classifier-metrics.ts";
import {
  buildRouteDecisionSummary,
  createPipeline,
  type ClassificationPipeline,
  type ClassificationResult,
} from "./classification-pipeline.ts";
import type { ClassificationJudgment } from "./classifier-backends.ts";
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
} from "./routing.ts";
import { reconcileEconomicSnapshot } from "./economic-config.ts";
import { emptyEconomicSnapshot } from "./economic-signals.ts";
import { ReliabilityStore } from "./reliability-store.ts";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState, isPassiveModelSelection, createSelfSelectTracker } from "./runtime-state.ts";
import { createCommandRouter, getBifrostCommandCompletions, runBifrostCommand, log, uiBusy, uiDone, syncBifrostModeStatus, clearBifrostWidgets, type BifrostState } from "./commands.ts";
import { setupDebug, debug, debugMeasure } from "./debug.ts";
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
import { waitForRegistryRefresh } from "./registry-refresh.ts";

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

function routingPolicyInvalid(state: Pick<BifrostState, "tierPolicyValid" | "economicPolicyValid">): boolean {
  return state.tierPolicyValid === false || state.economicPolicyValid === false;
}

function activeClassifierCacheKey(config: BifrostConfig, detectionEngine: ReturnType<typeof createDetectionEngine>): string {
  const effective = effectiveBackendOf(config, detectionEngine);
  return classifierCacheKey(config, Object.keys(config.models ?? {}), {
    typesafeCredentialAvailable: resolveTypeSafeApiKey().source !== "missing",
    effectiveBackend: effective.backend,
  });
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
): ClassificationPipeline {
  const tiers = Object.keys(config.models ?? {});
  const cacheCfg = config.cache;
  const cacheEnabled = classifierCacheEnabled(config, effective.backend);
  const threshold = cacheCfg?.threshold ?? DEFAULT_THRESHOLD;
  const cacheMaxAgeMs = (cacheCfg?.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000;

  // Resolve classifier models once at pipeline construction.
  // If classifier is disabled, pass empty array — pipeline skips LLM stage.
  let classifierModels: ClassifierModel[] = [];
  let classifyDirect: ((text: string, tiers: readonly string[], signal?: AbortSignal) => Promise<ClassificationJudgment | undefined>) | undefined;
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
      const judgment = await classify({ prompt: boundedClassifierPrompt(text), tiers: availableTiers, criteria: classifierConfig.criteria ?? DEFAULT_CLASSIFIER_CRITERIA }, signal);
      return judgment;
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
      const judgment = await classify({ prompt: boundedClassifierPrompt(text), tiers: availableTiers, criteria: config.classifier?.criteria ?? DEFAULT_CLASSIFIER_CRITERIA }, signal);
      return judgment;
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
    classifyWithLLM: async (model, text, tiers) => {
      const tier = await invokeClassifier(ctx, model, tiers, boundedClassifierPrompt(text), {
        systemPrompt: config.classifier?.systemPrompt,
        maxTokens: config.classifier?.maxTokens,
        temperature: config.classifier?.temperature,
        method: config.classifier?.method,
      });
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
  if (bootConfig.debug?.enabled) {
    setupDebug(bootConfig.debug, process.cwd());
    debug("bifrost", "startup", { extensionDir });
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

  function resolveForTier(
    ctx: ExtensionContext,
    tier: string,
  ) {
    return resolveConfiguredTier(
      ctx,
      tier,
      state.config,
      state.reliabilityStore.getState(),
      state.config.reliability,
      undefined,
      state.config.economics && state.economicPolicyValid && state.economicPolicy && state.economicSnapshot
        ? { policy: state.economicPolicy, snapshot: state.economicSnapshot }
        : undefined,
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
      debug("virtual", "cache.save_error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  state.selectPhysicalFromVirtual = async (ctx) => {
    if (!isBifrostAuto(ctx.model)) return true;
    // Prefer the last dispatched model; otherwise resolve the default tier —
    // the same fallback route() uses — so a fresh session can still exit Auto.
    const physical = lastDispatchedPhysical(ctx)
      ?? (state.config.default ? resolveForTier(ctx, state.config.default).resolution.selected : undefined);
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
      let routeFailure: { tier: string; pool: string | string[] | undefined; reason?: RoutedModelResolution["fallbackReason"]; skipped?: readonly SkippedCandidate[]; reserveExcluded?: ReserveExclusionSummary; explicitBoundary?: boolean; message?: string } | undefined;
      const ownership = createDispatchOwnership({
        claimTrial: (key) => state.reliabilityStore.tryClaimTrial(key),
        abandonTrial: (key) => state.reliabilityStore.abandonTrial(key),
        begin: (key) => trackerFor(ctx).begin(key),
        release: (key) => trackerFor(ctx).release(key),
      });
      const route = createVirtualRoute({
        overrides: overrideFor(ctx),
        fallback: () => routeFailure?.explicitBoundary ? undefined : lastDispatchedPhysical(ctx) ?? (state.config.default ? resolveForTier(ctx, state.config.default).resolution.selected : undefined),
        sticky: () => routeFailure?.explicitBoundary ? undefined : lastDispatchedPhysical(ctx),
        select: async (prompt, forcedTier, signal) => {
          if (routingPolicyInvalid(state)) {
            const tier = state.config.default ?? "default";
            routeFailure = {
              tier,
              pool: state.config.models?.[tier],
              explicitBoundary: true,
              message: "Bifrost Auto is blocked by invalid routing policy config; fix it and run /bifrost reload",
            };
            throw new Error(routeFailure.message);
          }
          if (!state.enabled || state.pinned) throw new Error("Bifrost: virtual auto is disabled or pinned; select a physical model");
          if (state.classifierEnabled && shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS)) {
            try {
              const outcome = await waitForRegistryRefresh((refreshSignal) => ctx.modelRegistry.refresh(refreshSignal ? { signal: refreshSignal } : undefined), signal);
              if (outcome === "aborted") throw new Error("Bifrost: model registry refresh aborted");
              state.lastRegistryRefreshAt = Date.now();
              state.forceRegistryRefresh = false;
              invalidatePipeline();
            } catch (error) {
              if (signal?.aborted) throw error;
              debug("virtual", "registry.refresh.error", { category: "registry_refresh_failure" });
            }
          }
          if (!state.enabled || state.pinned) throw new Error("Bifrost: virtual auto was disabled or pinned during routing; select a physical model");
          const classificationConfig = state.config;
          let classification: ClassificationResult = forcedTier
            ? { kind: "classified", tier: forcedTier, source: "inline" }
            : await getPipeline(ctx).classify(prompt, signal);
          if (classification.kind === "unclassified" && state.economicPolicy?.mode === "policy" && state.config.default) {
            classification = { kind: "fallback", tier: state.config.default };
          }
          if (signal?.aborted) throw new Error("Bifrost: route aborted");
          if (!state.enabled || state.pinned) throw new Error("Bifrost: virtual auto was disabled or pinned during routing; select a physical model");
          if (!forcedTier && state.config !== classificationConfig) {
            throw new Error("Bifrost: configuration changed during routing; retry the turn");
          }
          if (classification.kind === "unclassified") {
            if (state.economicPolicy?.mode === "policy") {
              routeFailure = { tier: "default", pool: state.config.models?.[state.config.default ?? "default"], explicitBoundary: true };
            }
            throw new Error("Bifrost: no configured tier for virtual request");
          }
          const classifierIdentity = classification.kind === "classified" && classification.judgment
            ? { classifierBackend: classification.judgment.backend, classifierModel: classification.judgment.model }
            : {};
          // Resolve from current config on every attempt. A registry refresh
          // may overlap /bifrost reload, so options cannot be captured ahead.
          let attempt = resolveForTier(ctx, classification.tier);
          let resolved = attempt.resolution;
          if (!resolved.selected && resolved.primary.candidates.length === 0) {
            // Registry merge can lag the first request; one bounded refresh + re-resolve.
            try {
              const outcome = await waitForRegistryRefresh((refreshSignal) => ctx.modelRegistry.refresh(refreshSignal ? { signal: refreshSignal } : undefined), signal);
              if (outcome === "aborted") throw new Error("Bifrost: model registry refresh aborted");
              state.lastRegistryRefreshAt = Date.now();
              state.forceRegistryRefresh = false;
              invalidatePipeline();
              attempt = resolveForTier(ctx, classification.tier);
              resolved = attempt.resolution;
            } catch (error) {
              if (signal?.aborted) throw error;
              debug("virtual", "registry.refresh.error", { category: "registry_refresh_failure" });
            }
          }
          if (state.config.debug?.enabled) {
            debug("virtual", "route_decision", {
              decision: buildRouteDecisionSummary(classification, attempt),
            });
          }
          const model = resolved.selected;
          if (!model) {
            state.forceRegistryRefresh = true;
            routeFailure = { tier: classification.tier, pool: state.config.models?.[classification.tier], reason: resolved.fallbackReason, skipped: resolved.skipped, reserveExcluded: reserveExclusionSummary(resolved), explicitBoundary: resolved.explicitBoundary || state.economicPolicy?.mode === "policy" };
            debug("virtual", "fail", { tier: classification.tier, reason: resolved.fallbackReason, pool: routeFailure.pool, skipped: resolved.skipped });
            return undefined;
          }
          if (!state.enabled || state.pinned) throw new Error("Bifrost: virtual auto was disabled or pinned during routing; select a physical model");
          debug("virtual", "select", { tier: classification.tier, model: modelKey(model), source: classification.kind === "classified" ? classification.source : "fallback", ...classifierIdentity, skipped: resolved.skipped });
          saveClassifierDecision(prompt, classification);
          log(ctx, `Bifrost auto: ${classification.tier} → ${modelKey(model)} (${classification.kind === "classified" ? classification.source : "fallback"}${resolved.fallbackReason ? `; ${resolved.fallbackReason}` : ""}${resolved.skipped.length > 0 ? `; ${resolved.skipped.length} skipped: ${resolved.skipped.map((s) => s.key).join(", ")}` : ""})`);
          return model;
        },
        onDispatch: (model, thinkingLevel, intent) => {
          const key = modelKey(model);
          ownership.claim(key, intent, (trial) => debug("virtual", "trial", { model: key, allowed: trial.allowed, claimed: trial.claimed }));
          debug("virtual", "dispatch", { model: key, thinkingLevel });
        },
        onDispatchFailed: (model) => {
          const key = modelKey(model);
          debug("virtual", "dispatch.release", { model: key });
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
      return route(request);
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
    overrideFor(ctx).clear();
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    trackerFor(ctx).observe(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settled = trackerFor(ctx).settle();
    // Clear at settle, not agent_end: agent_end handlers can queue fresh work
    // whose input-prepared tiers are still pending. Queued user input drains
    // before agent_end, so anything left here was abandoned.
    overrideFor(ctx).clear();
    if (settled.length === 0) return;
    if (!state.enabled || state.config.reliability?.enabled === false) {
      // Policy off mid-run: still resolve claimed trials so models never wedge.
      for (const outcome of settled) state.reliabilityStore.abandonTrial(outcome.model);
      return;
    }
    // Policy A: failure logged, clean settle silent (trial-only success).
    // Intentional — normal routing produces no log noise.
    for (const outcome of settled) {
      state.reliabilityStore.recordSettled(outcome.model, outcome.reason);
      if (outcome.reason) {
        log(ctx, `Bifrost: recorded provider failure for ${outcome.model}; future prompts may route around it.`, "warning");
      }
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
      overrideFor(ctx).clear();
      state.pinned = false;
      state.enabled = true;
      state.saveModeState();
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

    state.pinned = true;
    state.saveModeState();
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
    let strictBoundary = routingPolicyInvalid(state) || hasExplicitTierPolicies(state.config) || state.economicPolicy?.mode === "policy";
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
    if (routingPolicyInvalid(state)) {
      return strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing is blocked by an invalid routing or economic policy config; fix the config and run /bifrost reload.");
    }

    // Inline tier override: "frontier debug this" forces that tier for one prompt.
    // Pi reserves / for commands, ! for bash. Just type the tier name as first word.
    const { forcedTier, promptText } = parseInlineOverride(text, state.config.models);
    if (forcedTier) strictBoundary = hasExplicitTierPolicy(state.config, forcedTier) || state.economicPolicy?.mode === "policy";
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
          const result = await waitForRegistryRefresh((signal) => ctx.modelRegistry.refresh(signal ? { signal } : undefined), ctx.signal);
          if (result === "aborted") {
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
      if (classification.kind === "unclassified" && state.economicPolicy?.mode === "policy" && state.config.default) {
        classification = { kind: "fallback", tier: state.config.default };
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
        if (state.economicPolicy?.mode === "policy") {
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
      strictBoundary = hasExplicitTierPolicy(state.config, tier) || state.economicPolicy?.mode === "policy";
      const attempt = resolveForTier(ctx, tier);
      const options = attempt.options;
      const strategy = options.requestedStrategy;
      const source = classification.kind === "classified"
        ? classification.source
        : "fallback";
      const classifierIdentity = classification.kind === "classified" && classification.judgment
        ? { classifierBackend: classification.judgment.backend, classifierModel: classification.judgment.model }
        : {};
      const routeStart = performance.now();
      const resolved = attempt.resolution;
      const routingDurationMs = +(performance.now() - routeStart).toFixed(3);
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
