import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { classifyWithLLM as invokeClassifier, type ClassifierModel } from "./classifier.ts";
import { classifierCacheKey } from "./classifier-semantics.ts";
import { ClassifierMetricsStore } from "./classifier-metrics.ts";
import {
  createPipeline,
  type ClassificationPipeline,
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
  DEFAULT_CLASSIFIER_CRITERIA,
  validateConfig,
  type BifrostConfig,
} from "./config.ts";
import {
  findCandidates,
  getStrategy,
  modelKey,
  resolveModelWithFallback,
} from "./routing.ts";
import { ReliabilityStore } from "./reliability-store.ts";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState } from "./runtime-state.ts";
import { createCommandRouter, getBifrostCommandCompletions, runBifrostCommand, log, uiBusy, uiDone, syncBifrostModeStatus, clearBifrostWidgets, type BifrostState } from "./commands.ts";
import { setupDebug, debug, debugMeasure } from "./debug.ts";
import { parseInlineOverride } from "./inline-override.ts";
import { RuntimeReliabilityTracker } from "./runtime-reliability.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV } from "./classifier-backends.ts";
import { createTypeSafeClassifier, resolveTypeSafeApiKey } from "./typesafe-classifier.ts";
import {
  initHost,
  CONFIG_DIR_NAME,
  inputContinue,
  inputTransform,
  agentEndContinues,
  ctxSignal,
  thinkingLevelOf,
  isOmpHost,
  refreshRegistry,
} from "./host.ts";
import {
  REGISTRY_REFRESH_TTL_MS,
  setBifrostStatus,
  setBifrostWorkingMessage,
  shouldRefreshRegistry,
} from "./ux-status.ts";
import { waitForRegistryRefresh } from "./registry-refresh.ts";

// ── Pipeline builder (composition root) ────────────────────────

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

function hasTypeSafeConfigErrors(config: BifrostConfig): boolean {
  return validateConfig(config).some((issue) => issue.severity === "error" && (issue.message.includes("TypeSafe") || issue.message.includes("Classifier criteria")));
}

function activeClassifierCacheKey(config: BifrostConfig): string {
  return classifierCacheKey(config, Object.keys(config.models ?? {}), {
    typesafeCredentialAvailable: resolveTypeSafeApiKey().source !== "missing",
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
): ClassificationPipeline {
  const tiers = Object.keys(config.models ?? {});
  const cacheCfg = config.cache;
  const cacheEnabled = cacheCfg?.enabled ?? true;
  const threshold = cacheCfg?.threshold ?? DEFAULT_THRESHOLD;
  const cacheMaxAgeMs = (cacheCfg?.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000;

  // Resolve classifier models once at pipeline construction.
  // If classifier is disabled, pass empty array — pipeline skips LLM stage.
  let classifierModels: ClassifierModel[] = [];
  let classifyWithTypeSafe: ((text: string, tiers: readonly string[], signal?: AbortSignal) => Promise<ClassificationJudgment | undefined>) | undefined;
  const typeSafeUsable = config.classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe && !hasTypeSafeConfigErrors(config);
  if (classifierEnabled && typeSafeUsable && tiers.length > 0) {
    const classifierConfig = config.classifier!;
    const classify = createTypeSafeClassifier({
      timeoutMs: classifierConfig.typesafe?.timeoutMs,
      maxAttempts: classifierConfig.typesafe?.maxAttempts,
      debug: Boolean(config.debug?.enabled && classifierConfig.typesafe?.debug),
      minConfidence: classifierConfig.minConfidence,
      reliability: reliabilityStore,
      observe: (observation) => classifierMetricsStore.record(observation),
    });
    classifyWithTypeSafe = async (text, availableTiers, signal) => {
      const judgment = await classify({ prompt: text, tiers: availableTiers, criteria: classifierConfig.criteria ?? DEFAULT_CLASSIFIER_CRITERIA }, signal);
      return judgment;
    };
  }
  const usePromptClassifier = classifierEnabled && tiers.length > 0 && (
    (config.classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt) === CLASSIFIER_BACKEND_IDS.prompt ||
    (typeSafeUsable && config.classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe && config.classifier.fallback !== "regex")
  );
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
    classifyWithTypeSafe,
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
      const tier = await invokeClassifier(ctx, model, tiers, text, {
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
  initHost(pi);
  const extensionDir = fileURLToPath(new URL(".", import.meta.url));

  // Setup debug logging first — so startup errors are captured.
  const bootConfig = loadConfig(process.cwd(), extensionDir);
  if (bootConfig.debug?.enabled) {
    setupDebug(bootConfig.debug, process.cwd());
    debug("bifrost", "startup", { extensionDir });
  }

  const config = bootConfig;

  // Validate config on startup. Errors are logged; the extension
  // continues with best-effort routing for warnings.
  const configIssues = validateConfig(config);
  if (config.classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe && resolveTypeSafeApiKey().source === "missing") {
    console.warn(`[bifrost/config] warning: TypeSafe classifier unavailable; configure typesafe in ~/${CONFIG_DIR_NAME}/agent/auth.json or set ${TYPE_SAFE_API_KEY_ENV}`);
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
    enabled: config.classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe && (config.classifier.typesafe?.metrics?.enabled ?? true),
  });
  const runtimeStateFile = runtimeStatePath(process.cwd());
  const runtimeState = loadRuntimeState(runtimeStateFile, {
    enabled: config.enabled ?? true,
    pinned: false,
    classifierEnabled: config.classifier?.enabled ?? true,
  });
  let selfSelecting = false;
  const runtimeReliability = new RuntimeReliabilityTracker();
  let pipeline: ClassificationPipeline | undefined;

  function getPipeline(ctx: ExtensionContext): ClassificationPipeline {
    if (!pipeline) {
      pipeline = buildPipeline(
        ctx,
        state.config,
        state.cacheEntries,
        state.classifierEnabled,
        reliabilityStore,
        classifierMetricsStore,
        activeClassifierCacheKey(state.config),
      );
    }
    return pipeline;
  }

  function invalidatePipeline() {
    debug("bifrost", "pipeline.invalidate");
    pipeline = undefined;
  }

  // Mutable state shared with command handlers.
  const state: BifrostState = {
    config,
    enabled: runtimeState.enabled,
    classifierEnabled: runtimeState.classifierEnabled,
    pinned: runtimeState.pinned,
    cacheEntries,
    reliabilityStore,
    classifierMetricsStore,
    extensionDir,
    getPipeline,
    invalidatePipeline,
    saveModeState: () => saveRuntimeState(runtimeStateFile, {
      enabled: state.enabled,
      classifierEnabled: state.classifierEnabled,
    }),
    lastRegistryRefreshAt: undefined,
    forceRegistryRefresh: false,
  };

  const handleCommand = createCommandRouter(state);

  pi.registerCommand("bifrost", {
    description: "Bifrost model router control",
    getArgumentCompletions: getBifrostCommandCompletions,
    handler: async (args, ctx) => {
      await runBifrostCommand(args, ctx, handleCommand);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
  });

  // Reliability observation. Pi settles after its internal retries via
  // agent_settled; omp never emits that event, so its terminal agent_end is
  // the settle point. omp marks a non-terminal end — another continuation is
  // already scheduled — with willContinue: true, which is not a completed run
  // and must not settle. No pending-settlement state is needed: settle()
  // consumes the tracked run, and begin() runs only for a routed turn, so
  // repeated agent_end events cannot double-record.
  pi.on("agent_end", async (event, ctx) => {
    runtimeReliability.observe(event.messages);
    if (!isOmpHost() || agentEndContinues(event)) return;
    settleReliability(ctx);
  });

  function settleReliability(ctx: ExtensionContext): void {
    const settled = runtimeReliability.settle();
    if (!settled || !state.enabled || state.config.reliability?.enabled === false) return;
    // Policy A: failure logged, clean settle silent (trial-only success).
    // Intentional — normal routing produces no log noise.
    state.reliabilityStore.recordSettled(settled.model, settled.reason);
    if (settled.reason) {
      log(ctx, `Bifrost: recorded provider failure for ${settled.model}; future prompts may route around it.`, "warning");
    }
  }

  pi.on("agent_settled", async (_event, ctx) => {
    settleReliability(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (selfSelecting) {
      selfSelecting = false;
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
    if (event.source === "extension") return inputContinue();
    clearBifrostWidgets(ctx);
    // Passive subagent observation — logged even when routing is disabled,
    // so child-session model usage stays visible in debug logs.
    if (process.env.PI_SUBAGENT_RUN_ID) {
      debug("input", "subagent", {
        source: "PI-subagent",
        agent: process.env.PI_SUBAGENT_CHILD_AGENT,
        model: modelKey(ctx.model),
        thinkingLevel: thinkingLevelOf(ctx),
        depth: process.env.PI_SUBAGENT_PARENT_DEPTH,
      });
    }
    if (!state.enabled || state.pinned) {
      debug("input", "bypass", { enabled: state.enabled, pinned: state.pinned });
      syncBifrostModeStatus(ctx, state);
      return inputContinue();
    }

    const text = event.text.trim();
    if (text.startsWith("/")) return inputContinue();

    // Inline tier override: "frontier debug this" forces that tier for one prompt.
    // Pi reserves / for commands, ! for bash. Just type the tier name as first word.
    const { forcedTier, promptText } = parseInlineOverride(text, state.config.models);
    if (forcedTier) {
      debug("input", "inline_override", { tier: forcedTier });
    }

    // Inline override should strip the tier keyword from what LLM sees.
    const defaultAction = forcedTier
      ? inputTransform(promptText)
      : inputContinue();

    const endInput = debugMeasure("input", "total");
    debug("input", "prompt", { length: promptText.length });

    const shouldRefresh = state.classifierEnabled
      ? shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS)
      : false;

    let claimedTrial: string | undefined;
    try {
      if (shouldRefresh) {
        setBifrostWorkingMessage(ctx, "Bifrost checking models...");
        const endRefresh = debugMeasure("input", "registry.refresh");
        let refreshOutcome: "success" | "error" | "aborted" = "error";
        try {
          const result = await waitForRegistryRefresh((signal) => refreshRegistry(ctx.modelRegistry, signal), ctxSignal(ctx));
          if (result === "aborted") {
            refreshOutcome = "aborted";
            endInput({ outcome: "aborted" });
            return defaultAction;
          }
          refreshOutcome = "success";
          state.lastRegistryRefreshAt = Date.now();
          state.forceRegistryRefresh = false;
          invalidatePipeline();
        } catch (err) {
          debug("input", "registry.refresh.error", { category: "registry_refresh_failure" });
          console.error(`[bifrost] model registry refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          endRefresh({ outcome: refreshOutcome });
        }
      }

      setBifrostStatus(ctx, forcedTier ? `using ${forcedTier}...` : "classifying prompt...", "accent");
      uiBusy(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      setBifrostWorkingMessage(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      const endClassify = debugMeasure("input", "classify");
      const classification = forcedTier
        ? { kind: "classified" as const, tier: forcedTier, source: "inline" as const }
        : await getPipeline(ctx).classify(promptText, ctxSignal(ctx));

      if (classification.kind === "classified") {
        const tag = classification.source === "inline" ? "!" : classification.source;
        console.error(`[bifrost] classify: ${classification.tier} [${tag}]`);
      }

      endClassify({ kind: classification.kind, tier: classification.kind !== "unclassified" ? classification.tier : undefined });
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);

      if (classification.kind === "unclassified") {
        log(ctx, "Bifrost: no tier matched — using default model", "warning");
        debug("input", "unclassified");
        syncBifrostModeStatus(ctx, state);
        endInput();
        return defaultAction;
      }

      const tier = classification.tier;
      const source = classification.kind === "classified"
        ? classification.source
        : "fallback";
      const pattern = state.config.models?.[tier] ?? tier;
      const strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
      const defaultTier = state.config.default;
      const defaultPattern = defaultTier ? (state.config.models?.[defaultTier] ?? defaultTier) : undefined;
      const defaultStrategy = defaultTier
        ? getStrategy(state.config.categoryStrategies, state.config.strategy, defaultTier)
        : strategy;

      const routeStart = performance.now();
      const resolved = resolveModelWithFallback(ctx, {
        requestedTier: tier,
        requestedPattern: pattern,
        requestedStrategy: strategy,
        defaultTier,
        defaultPattern,
        defaultStrategy,
        reliabilityState: state.reliabilityStore.getState(),
        reliabilityConfig: state.config.reliability,
      });
      const routingDurationMs = +(performance.now() - routeStart).toFixed(3);
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
          return defaultAction;
        }
        if (trial.claimed) claimedTrial = modelKey(model);
      }

      if (!model) {
        state.forceRegistryRefresh = true;
        debug("input", "no_model", { tier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache" });
        const why = resolved.fallbackReason ? ` (${resolved.fallbackReason})` : "";
        log(ctx, `Bifrost: tier "${tier}" matched but no healthy model available${why}`, "warning");
        syncBifrostModeStatus(ctx, state);
        endInput();
        return defaultAction;
      }

      if (
        classification.kind === "classified" &&
        classification.source === "classifier"
      ) {
        const maxEntries = state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES;
        if (state.config.cache?.enabled ?? true) {
          const endCacheSave = debugMeasure("input", "cacheSave");
          state.cacheEntries = updateCache(state.cacheEntries, promptText, tier, maxEntries, activeClassifierCacheKey(state.config));
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
        debug("input", "model_unchanged", { model: modelKey(model), selectedTier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", thinkingLevel: thinkingLevelOf(ctx) });
        debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", thinkingLevel: thinkingLevelOf(ctx) });
        runtimeReliability.begin(modelKey(model));
        claimedTrial = undefined;
        endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: thinkingLevelOf(ctx) });
        return defaultAction;
      }

      uiBusy(ctx, `Bifrost routing to ${modelKey(model)}...`);
      setBifrostWorkingMessage(ctx, `Bifrost routing to ${modelKey(model)}...`);
      selfSelecting = true;
      const endSwitch = debugMeasure("input", "setModel");
      let ok = false;
      let setModelError: unknown;
      try {
        ok = await pi.setModel(model);
      } catch (err) {
        setModelError = err;
        debug("input", "setModel.throw", { model: modelKey(model), category: "set_model_failure" });
      }
      endSwitch({ model: modelKey(model), ok });
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);
      if (!ok) {
        selfSelecting = false;
        state.forceRegistryRefresh = true;
        const reason = setModelError
          ? "setModel threw"
          : "setModel returned false";
        state.reliabilityStore.recordFailure(modelKey(model), "setModel", reason);
        claimedTrial = undefined;
        syncBifrostModeStatus(ctx, state);
        log(ctx, `Bifrost: no API key for ${modelKey(model)}`, "error");
        endInput({ model: modelKey(model), ok: false });
        return defaultAction;
      }

      const detail = [
        selectedTier !== tier ? `selected tier ${selectedTier}` : undefined,
        resolved.fallbackReason,
        resolved.skipped.length > 0 ? `${resolved.skipped.length} skipped` : undefined,
      ].filter(Boolean).join(", ");
      const doneMsg = classification.kind === "classified"
        ? `Bifrost: ${tier} → ${modelKey(model)} (${classification.source}${detail ? `; ${detail}` : ""})`
        : `Bifrost: ${tier} → ${modelKey(model)} (fallback${detail ? `; ${detail}` : ""})`;
      syncBifrostModeStatus(ctx, state);
      log(ctx, doneMsg);
      runtimeReliability.begin(modelKey(model));
      claimedTrial = undefined;
      debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped, cacheHit: source === "cache", routingDurationMs, thinkingLevel: thinkingLevelOf(ctx) });
      endInput({ model: modelKey(model), tier: selectedTier, strategy, source, thinkingLevel: thinkingLevelOf(ctx) });
      return defaultAction;
    } finally {
      if (claimedTrial) state.reliabilityStore.abandonTrial(claimedTrial);
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);
      syncBifrostModeStatus(ctx, state);
    }
  });
}
