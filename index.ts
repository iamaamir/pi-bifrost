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
  type BifrostConfig,
} from "./config.js";
import {
  findCandidates,
  getStrategy,
  modelKey,
  resolveModel,
} from "./routing.js";
import { createCommandRouter, log, uiBusy, uiDone, type BifrostState } from "./commands.js";
import { setupDebug, debug, debugMeasure } from "./debug.js";

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
  const cacheEntries = loadCache(cachePath(process.cwd(), config.cache?.path));
  let selfSelecting = false;
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
    enabled: config.enabled ?? true,
    classifierEnabled: config.classifier?.enabled ?? true,
    pinned: false,
    cacheEntries,
    extensionDir,
    getPipeline,
    invalidatePipeline,
  };

  const handleCommand = createCommandRouter(state);

  pi.registerCommand("bifrost", {
    description: "Bifrost model router control",
    handler: async (args, ctx) => {
      await handleCommand(args, ctx);
    },
  });

  pi.on("model_select", async (_event, ctx) => {
    if (selfSelecting) {
      selfSelecting = false;
      return;
    }
    if (!state.enabled) return;

    state.pinned = true;
    debug("bifrost", "model_select", { model: modelKey(ctx.model) });
    log(
      ctx,
      `Model manually changed to ${modelKey(ctx.model)}; Bifrost pinned.`,
    );
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!state.enabled || state.pinned) {
      debug("input", "bypass", { enabled: state.enabled, pinned: state.pinned });
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (text.startsWith("/")) return { action: "continue" };

    const endInput = debugMeasure("input", "total");
    debug("input", "prompt", { length: text.length });

    if (state.classifierEnabled) {
      const endRefresh = debugMeasure("input", "registry.refresh");
      try {
        await ctx.modelRegistry.refresh();
        invalidatePipeline();
        endRefresh();
      } catch (err) {
        debug("input", "registry.refresh.error", { error: String(err) });
        console.error(`[bifrost] model registry refresh failed: ${err}`);
      }
    }

    uiBusy(ctx, "Bifrost classifying...");
    const endClassify = debugMeasure("input", "classify");
    const classification = await getPipeline(ctx).classify(text);
    endClassify({ kind: classification.kind, tier: classification.kind !== "unclassified" ? classification.tier : undefined });
    uiDone(ctx);

    if (classification.kind === "unclassified") {
      log(ctx, "Bifrost: no tier matched — using default model", "warning");
      debug("input", "unclassified");
      endInput();
      return { action: "continue" };
    }

    const tier = classification.tier;
    const source = classification.kind === "classified"
      ? classification.source
      : "fallback";
    const pattern = state.config.models?.[tier] ?? tier;
    const strategy = getStrategy(state.config.categoryStrategies, state.config.strategy, tier);
    const model = resolveModel(ctx, pattern, strategy);
    if (!model) {
      debug("input", "no_model", { tier });
      log(ctx, `Bifrost: tier "${tier}" matched but no model available`, "warning");
      endInput();
      return { action: "continue" };
    }

    // Only cache LLM classifier results (regex is deterministic).
    if (
      classification.kind === "classified" &&
      classification.source === "classifier"
    ) {
      const maxEntries = state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES;
      if (state.config.cache?.enabled ?? true) {
        const endCacheSave = debugMeasure("input", "cacheSave");
        state.cacheEntries = updateCache(state.cacheEntries, text, tier, maxEntries);
        saveCache(cachePath(process.cwd(), state.config.cache?.path), state.cacheEntries);
        invalidatePipeline();
        endCacheSave({ entries: state.cacheEntries.length });
      }
    }

    if (modelKey(model) === modelKey(ctx.model)) {
      uiDone(ctx);
      log(ctx, `Bifrost: ${tier} → ${modelKey(model)} (already active, ${source})`);
      debug("input", "model_unchanged", { model: modelKey(model) });
      endInput({ model: modelKey(model), tier, strategy, source });
      return { action: "continue" };
    }

    uiBusy(ctx, `Bifrost routing to ${modelKey(model)}...`);
    selfSelecting = true;
    const endSwitch = debugMeasure("input", "setModel");
    const ok = await pi.setModel(model);
    endSwitch({ model: modelKey(model), ok });
    uiDone(ctx);
    if (!ok) {
      selfSelecting = false;
      log(ctx, `Bifrost: no API key for ${modelKey(model)}`, "error");
      endInput({ model: modelKey(model), ok: false });
      return { action: "continue" };
    }

    const doneMsg = classification.kind === "classified"
      ? `Bifrost: ${tier} → ${modelKey(model)} (${classification.source})`
      : `Bifrost: ${tier} → ${modelKey(model)} (fallback)`;
    log(ctx, doneMsg);
    endInput({ model: modelKey(model), tier, strategy, source });
    return { action: "continue" };
  });
}
