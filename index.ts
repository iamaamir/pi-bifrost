import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { classifyWithLLM as invokeClassifier, type ClassifierModel } from "./classifier.js";
import {
  createPipeline,
  type ClassificationPipeline,
} from "./classification-pipeline.js";
import {
  cachePath,
  lookupCache,
  touchCacheEntry,
  loadCache,
  saveCache,
  updateCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_THRESHOLD,
  type CacheEntry,
} from "./cache.js";
import {
  loadConfig,
  loadRules,
  validateConfig,
  type BifrostConfig,
} from "./config.js";
import {
  findCandidates,
  getStrategy,
  modelKey,
  resolveModelWithFallback,
} from "./routing.js";
import { ReliabilityStore } from "./reliability-store.js";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState } from "./runtime-state.js";
import { createCommandRouter, getBifrostCommandCompletions, log, uiBusy, uiDone, syncBifrostModeStatus, clearBifrostWidgets, type BifrostState } from "./commands.js";
import { setupDebug, debug, debugMeasure } from "./debug.js";
import { parseInlineOverride } from "./inline-override.js";
import { RuntimeReliabilityTracker } from "./runtime-reliability.js";
import {
  REGISTRY_REFRESH_TTL_MS,
  setBifrostStatus,
  setBifrostWorkingMessage,
  shouldRefreshRegistry,
} from "./ux-status.js";

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

function buildPipeline(
  ctx: ExtensionContext,
  config: BifrostConfig,
  cacheEntries: CacheEntry[],
  classifierEnabled: boolean,
): ClassificationPipeline {
  const tiers = Object.keys(config.models ?? {});
  const cacheCfg = config.cache;
  const cacheEnabled = cacheCfg?.enabled ?? true;
  const threshold = cacheCfg?.threshold ?? DEFAULT_THRESHOLD;

  // Resolve classifier models once at pipeline construction.
  // If classifier is disabled, pass empty array — pipeline skips LLM stage.
  let classifierModels: ClassifierModel[] = [];
  if (classifierEnabled && tiers.length > 0) {
    const classifierEndpoint = config.classifier?.endpoint;
    if (classifierEndpoint) {
      const rawModel = config.classifier?.model;
      const modelId = Array.isArray(rawModel)
        ? rawModel[0]
        : (rawModel ?? "classifier");
      classifierModels = [endpointClassifier(modelId, classifierEndpoint)];
    } else {
      classifierModels = resolveClassifierModels(ctx, config);
    }
  }

  return createPipeline({
    cacheLookup: (text) => {
      if (!cacheEnabled) return undefined;
      const entry = lookupCache(cacheEntries, text, threshold);
      if (entry) {
        touchCacheEntry(entry);
        return entry.category;
      }
      return undefined;
    },
    classifierModels,
    classifyWithLLM: (model, text, tiers) =>
      invokeClassifier(ctx, model, tiers, text, {
        systemPrompt: config.classifier?.systemPrompt,
        maxTokens: config.classifier?.maxTokens,
        temperature: config.classifier?.temperature,
        method: config.classifier?.method,
      }),
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

  // Validate config on startup. Errors are logged; the extension
  // continues with best-effort routing for warnings.
  const configIssues = validateConfig(config);
  for (const issue of configIssues) {
    const tag = issue.severity === "error" ? "error" : "warning";
    console.error(`[bifrost/config] ${tag}: ${issue.message}`);
  }
  const cacheEntries = loadCache(cachePath(process.cwd(), config.cache?.path));
  const reliabilityStore = new ReliabilityStore({ cwd: process.cwd(), config: config.reliability });
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
      pipeline = buildPipeline(ctx, state.config, state.cacheEntries, state.classifierEnabled);
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
    extensionDir,
    getPipeline,
    invalidatePipeline,
    saveModeState: () => saveRuntimeState(runtimeStateFile, {
      enabled: state.enabled,
      pinned: state.pinned,
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
      await handleCommand(args, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
  });

  pi.on("agent_end", async (event) => {
    runtimeReliability.observe(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settled = runtimeReliability.settle();
    if (!settled || !state.enabled || state.config.reliability?.enabled === false) return;
    // Policy A: failure logged, clean settle silent (trial-only success).
    // Intentional — normal routing produces no log noise.
    state.reliabilityStore.recordSettled(settled.model, settled.reason);
    if (settled.reason) {
      log(ctx, `Bifrost: recorded provider failure for ${settled.model}; future prompts may route around it.`, "warning");
    }
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
    if (event.source === "extension") return { action: "continue" };
    clearBifrostWidgets(ctx);
    if (!state.enabled || state.pinned) {
      debug("input", "bypass", { enabled: state.enabled, pinned: state.pinned });
      syncBifrostModeStatus(ctx, state);
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (text.startsWith("/")) return { action: "continue" };

    // Inline tier override: "frontier debug this" forces that tier for one prompt.
    // Pi reserves / for commands, ! for bash. Just type the tier name as first word.
    const { forcedTier, promptText } = parseInlineOverride(text, state.config.models);
    if (forcedTier) {
      debug("input", "inline_override", { tier: forcedTier });
    }

    // Inline override should strip the tier keyword from what LLM sees.
    const defaultAction = forcedTier
      ? { action: "transform" as const, text: promptText }
      : { action: "continue" as const };

    const endInput = debugMeasure("input", "total");
    debug("input", "prompt", { length: promptText.length });

    const shouldRefresh = state.classifierEnabled
      ? shouldRefreshRegistry(state, Date.now(), REGISTRY_REFRESH_TTL_MS)
      : false;

    try {
      if (shouldRefresh) {
        setBifrostWorkingMessage(ctx, "Bifrost checking models...");
        const endRefresh = debugMeasure("input", "registry.refresh");
        try {
          await ctx.modelRegistry.refresh();
          state.lastRegistryRefreshAt = Date.now();
          state.forceRegistryRefresh = false;
          invalidatePipeline();
          endRefresh();
        } catch (err) {
          debug("input", "registry.refresh.error", { error: String(err) });
          console.error(`[bifrost] model registry refresh failed: ${err}`);
        }
      }

      setBifrostStatus(ctx, forcedTier ? `using ${forcedTier}...` : "classifying prompt...", "accent");
      uiBusy(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      setBifrostWorkingMessage(ctx, forcedTier ? `Bifrost using ${forcedTier}...` : "Bifrost classifying...");
      const endClassify = debugMeasure("input", "classify");
      const classification = forcedTier
        ? { kind: "classified" as const, tier: forcedTier, source: "inline" as const }
        : await getPipeline(ctx).classify(promptText);

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
      const model = resolved.selected;
      const selectedTier = resolved.selectedTier ?? tier;

      // If selected model is half-open, mark trial in progress
      if (model) {
        const circuit = state.reliabilityStore.getCircuitState(modelKey(model));
        if (circuit.halfOpen && !circuit.trialActive) {
          state.reliabilityStore.beginTrial(modelKey(model));
        }
      }

      if (!model) {
        state.forceRegistryRefresh = true;
        debug("input", "no_model", { tier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped.length });
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
          state.cacheEntries = updateCache(state.cacheEntries, promptText, tier, maxEntries);
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
        debug("input", "model_unchanged", { model: modelKey(model), selectedTier, fallbackReason: resolved.fallbackReason, skipped: resolved.skipped.length });
        debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason });
        runtimeReliability.begin(modelKey(model));
        endInput({ model: modelKey(model), tier: selectedTier, strategy, source });
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
        debug("input", "setModel.throw", { model: modelKey(model), error: String(err) });
      }
      endSwitch({ model: modelKey(model), ok });
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);
      if (!ok) {
        selfSelecting = false;
        state.forceRegistryRefresh = true;
        const reason = setModelError
          ? `setModel threw: ${String(setModelError).slice(0, 200)}`
          : "setModel returned false";
        state.reliabilityStore.recordFailure(modelKey(model), "setModel", reason);
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
      debug("input", "model_selected", { model: modelKey(model), tier: selectedTier, strategy, source, fallbackReason: resolved.fallbackReason });
      endInput({ model: modelKey(model), tier: selectedTier, strategy, source });
      return defaultAction;
    } finally {
      uiDone(ctx);
      setBifrostWorkingMessage(ctx, undefined);
      syncBifrostModeStatus(ctx, state);
    }
  });
}
