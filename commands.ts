import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BifrostConfig } from "./config.js";
import { DEFAULT_RULES, loadConfig } from "./config.js";
import type { CacheEntry } from "./cache.js";
import { cachePath, loadCache, saveCache, DEFAULT_MAX_ENTRIES, DEFAULT_THRESHOLD } from "./cache.js";
import type { ClassificationPipeline } from "./classification-pipeline.js";
import { debug, debugMeasure } from "./debug.ts";
import { runProbe, PROBE_PROMPT_TEXT } from "./probe.js";
import {
  findCandidates,
  getStrategy,
  guessTier,
  modelKey,
  selectModel,
  type RoutingStrategy,
} from "./routing.js";

// ── Mutable state shared across commands ────────────────────

export interface BifrostState {
  config: BifrostConfig;
  enabled: boolean;
  classifierEnabled: boolean;
  pinned: boolean;
  cacheEntries: CacheEntry[];
  extensionDir: string;
  getPipeline: (ctx: ExtensionContext) => ClassificationPipeline;
  invalidatePipeline: () => void;
}

export function log(
  ctx: ExtensionContext,
  message: string,
  type?: "info" | "warning" | "error",
) {
  console.error(`[bifrost] ${message}`);
  if (ctx.hasUI) ctx.ui.notify(message, type ?? "info");
}

export function uiBusy(ctx: ExtensionContext, message: string) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWorkingMessage(message);
    ctx.ui.setWorkingVisible(true);
  } else {
    console.error(`[bifrost] ${message}`);
  }
}

export function uiDone(ctx: ExtensionContext) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWorkingMessage(undefined);
    ctx.ui.setWorkingVisible(false);
  }
}

function uiOutput(ctx: ExtensionContext, lines: string[]) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", lines);
  } else {
    for (const line of lines) console.error(`[bifrost] ${line}`);
  }
}

// ── Shared tier-resolution + display ───────────────────────

function resolveTierDisplay(
  tier: string,
  config: BifrostConfig,
  ctx: ExtensionContext,
) {
  const pattern = config.models?.[tier] ?? tier;
  const strategy = getStrategy(config.categoryStrategies, config.strategy, tier);
  const candidates = findCandidates(ctx, pattern);
  const selected = selectModel(candidates, strategy);

  const lines = candidates.map((m) => {
    const marker = m === selected ? "=>" : "  ";
    return `${marker} ${modelKey(m)} ($${(m.cost.input + m.cost.output).toFixed(2)}/1M tokens, ctx ${m.contextWindow})`;
  });

  return { strategy, candidateLines: lines, selected: selected ? modelKey(selected) : "none" };
}

// ── Command handlers ────────────────────────────────────────

async function handleInit(
  _args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  // Try to load cached probe results. If stale or missing, run probe inline.
  const probePath = join(process.cwd(), ".pi", "bifrost-probe.json");
  let workingModels: { provider: string; model: string; cost: { input: number; output: number }; duration_ms: number }[] = [];
  let probeLoaded = false;
  let probeAge = "";

  if (existsSync(probePath)) {
    try {
      const probeData = JSON.parse(readFileSync(probePath, "utf-8"));
      const probeStat = statSync(probePath);
      const ageMs = Date.now() - probeStat.mtimeMs;
      const ageMin = Math.round(ageMs / 60000);

      if (ageMs < 3600_000) {
        workingModels = probeData
          .filter((r: any) => r.status === "ok")
          .map((r: any) => ({
            provider: r.provider,
            model: r.model,
            cost: { input: r.cost_input ?? 0, output: r.cost_output ?? 0 },
            duration_ms: r.duration_ms ?? 0,
          }));
        probeAge = `${ageMin}m ago`;
        probeLoaded = true;
      }
    } catch {
      // Corrupt — will re-probe below.
    }
  }

  // If no fresh probe data, run probe inline.
  if (!probeLoaded) {
    const available = ctx.modelRegistry.getAvailable();
    const availableCount = available.length;
    log(ctx, `Probing ${availableCount} models to find working ones...`);
    let okCount = 0;
    let errCount = 0;
    const lastModels: string[] = [];

    uiBusy(ctx, `Probing ${availableCount} models...`);
    const { results } = await runProbe(ctx, (done, total, last) => {
      if (last.status === "ok") okCount++;
      else if (last.status === "error" || last.status === "timeout") errCount++;
      lastModels.push(`${last.provider}/${last.model}: ${last.status} (${last.duration_ms}ms)`);
      if (lastModels.length > 5) lastModels.shift();

      if (ctx.hasUI) {
        ctx.ui.setWidget("bifrost-probe", [
          `Probing models: ${done}/${total}`,
          `  ok: ${okCount}  errors: ${errCount}`,
          "",
          ...lastModels,
        ]);
      }
    });
    uiDone(ctx);

    workingModels = results
      .filter((r) => r.status === "ok")
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        cost: { input: r.cost_input ?? 0, output: r.cost_output ?? 0 },
        duration_ms: r.duration_ms ?? 0,
      }));
    probeLoaded = true;
    probeAge = "just now";

    const ok = results.filter((r) => r.status === "ok").length;
    log(ctx, `Probe complete: ${ok}/${results.length} models responded.`);
    if (ok === 0) {
      log(ctx, "Zero models responded. Check API keys, network, and credits.", "error");
      log(ctx, "Proceeding with full registry — most models will likely be unreachable.", "warning");
      probeLoaded = false;
    }
  }

  if (probeLoaded && workingModels.length > 0) {
    log(ctx, `Using ${workingModels.length} probe-verified models (${probeAge}).`);
  }

  const available = ctx.modelRegistry.getAvailable();
  const models: Record<string, string[]> = {};
  const uncategorized: string[] = [];

  for (const m of available) {
    const key = `${m.provider}/${m.id}`;

    // If probe data is loaded, skip models that failed or timed out.
    if (probeLoaded && workingModels.length > 0) {
      const working = workingModels.find(
        (w) => w.provider === m.provider && w.model === m.id,
      );
      if (!working) continue; // known-broken, silently skip
    }

    const tier = guessTier(m);
    if (tier) {
      models[tier] = models[tier] ?? [];
      models[tier].push(key);
    } else {
      uncategorized.push(key);
    }
  }

  // Sort each tier by probe response time (fastest first) so "first"
  // strategy picks the fastest model.
  if (probeLoaded) {
    const speedMap = new Map(workingModels.map((w) => [`${w.provider}/${w.model}`, w.duration_ms]));
    for (const tier of Object.keys(models)) {
      models[tier].sort((a, b) => (speedMap.get(a) ?? Infinity) - (speedMap.get(b) ?? Infinity));
    }
  }

  // Pick a classifier default: fastest cheap working model.
  let classifierModel: string | undefined;
  if (probeLoaded && workingModels.length > 0) {
    const cheapWorking = workingModels
      .filter((w) => (w.cost.input + w.cost.output) < 2)
      .sort((a, b) => a.duration_ms - b.duration_ms);
    if (cheapWorking.length > 0) {
      classifierModel = `${cheapWorking[0].provider}/${cheapWorking[0].model}`;
    }
  }
  if (!classifierModel) {
    // Fallback: any working model, or a sensible default.
    if (workingModels.length > 0) {
      classifierModel = `${workingModels[0].provider}/${workingModels[0].model}`;
    } else {
      classifierModel = "opencode/mimo-v2.5-free";
      log(ctx, "No working models found for classifier. Using default — it may not work.", "warning");
    }
  }

  const proposal = {
    $schema: `${state.extensionDir.replace(/\/$/, "")}/schema.json`,
    enabled: true,
    default: "economical",
    strategy: "first" as RoutingStrategy,
    categoryStrategies: { economical: "cheapest" as RoutingStrategy },
    classifier: {
      enabled: true,
      model: classifierModel,
      method: "auto" as const,
    },
    models,
    rules: DEFAULT_RULES,
  };

  const totalAssigned = Object.values(models).reduce((s, v) => s + v.length, 0);
  uiOutput(ctx, [
    "--- init ---",
    `source: ${probeLoaded ? `probe (${workingModels.length} working)` : `registry (${available.length} listed)`}`,
    `assigned: ${totalAssigned} models`,
    `classifier: ${classifierModel}`,
    `uncategorized: ${uncategorized.length}`,
    "proposed config:",
    JSON.stringify(proposal, null, 2),
    "----------------",
    probeLoaded ? "" : "⚠ Run /bifrost probe first to filter unreachable models.",
    "Assign uncategorized models manually in the generated config.",
  ].filter(Boolean));

  if (uncategorized.length > 0) {
    log(ctx, `${uncategorized.length} model(s) uncategorized — edit .pi/bifrost.json to assign them.`);
  }

  if (!ctx.hasUI) {
    log(ctx, "run in TUI or use --write (not implemented) to persist", "warning");
    return;
  }

  const ok = await ctx.ui.confirm(
    "Write config?",
    "Write proposed config to .pi/bifrost.json?",
  );
  if (!ok) {
    log(ctx, "config not written");
    return;
  }

  const dir = join(process.cwd(), CONFIG_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bifrost.json"), JSON.stringify(proposal, null, 2));

  // Auto-reload so the extension picks up the new config immediately.
  state.config = loadConfig(process.cwd(), state.extensionDir);
  state.enabled = state.config.enabled ?? true;
  state.classifierEnabled = state.config.classifier?.enabled ?? true;
  state.invalidatePipeline();

  log(ctx, "wrote .pi/bifrost.json and reloaded config");
  log(ctx, `Bifrost active with ${Object.keys(state.config.models ?? {}).length} tier(s). Try a prompt.`);

  // Clear the init widget so it doesn't persist in the TUI.
  if (ctx.hasUI) ctx.ui.setWidget("bifrost-output", []);
}

async function handleBenchmark(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const prompt =
    args.slice("benchmark".length).trim() ||
    "Write a short Python function to reverse a string and explain it briefly.";
  const categories = Object.keys(state.config.models ?? {});

  if (categories.length === 0) {
    log(ctx, "no categories configured; run /bifrost init first", "warning");
    return;
  }

  uiBusy(ctx, "Classifying benchmark prompt...");
  const classification = await state.getPipeline(ctx).classify(prompt);
  uiDone(ctx);
  const tier = classification.kind !== "unclassified" ? classification.tier : undefined;
  const source = classification.kind === "classified" ? classification.source : "fallback";

  const lines = [
    "--- benchmark ---",
    `prompt: ${prompt}`,
    `tier: ${tier ?? "none"}`,
    `source: ${source}`,
    "per-tier selection:",
  ];

  for (const tierName of categories) {
    const display = resolveTierDisplay(tierName, state.config, ctx);
    lines.push(`  ${tierName} (${display.strategy}):`);
    lines.push(...display.candidateLines);
  }

  lines.push("-----------------");
  uiOutput(ctx, lines);
}

async function handlePreview(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const prompt = args.slice("preview".length).trim();
  if (!prompt) {
    log(ctx, "usage: /bifrost preview <prompt>", "warning");
    return;
  }

  uiBusy(ctx, "Classifying preview prompt...");
  const classification = await state.getPipeline(ctx).classify(prompt);
  uiDone(ctx);
  if (classification.kind === "unclassified") {
    log(ctx, "no tier matched", "warning");
    return;
  }
  const tier = classification.tier;
  const source = classification.kind === "classified" ? classification.source : "fallback";
  const display = resolveTierDisplay(tier, state.config, ctx);

  uiOutput(ctx, [
    "--- preview ---",
    `prompt:    ${prompt}`,
    `source:    ${source}`,
    `tier:      ${tier}`,
    `strategy:  ${display.strategy}`,
    `candidates:`,
    ...display.candidateLines,
    `selected:  ${display.selected}`,
    "---------------",
  ]);
}

// ── Command type ────────────────────────────────────────────

type CommandFn = (args: string, ctx: ExtensionContext) => void | Promise<void>;

interface CommandEntry {
  readonly match: (sub: string) => boolean;
  readonly handler: CommandFn;
}

function exact(word: string, handler: CommandFn): CommandEntry {
  return { match: (sub) => sub === word, handler };
}

function prefix(word: string, handler: CommandFn): CommandEntry {
  return { match: (sub) => sub.startsWith(word), handler };
}

// ── Route table ─────────────────────────────────────────────

export function createCommandRouter(
  state: BifrostState,
): (args: string, ctx: ExtensionContext) => Promise<void> {
  const routes: CommandEntry[] = [
    exact("on", (_, ctx) => {
      state.enabled = true;
      log(ctx, "Bifrost enabled");
    }),
    exact("off", (_, ctx) => {
      state.enabled = false;
      log(ctx, "Bifrost disabled");
    }),
    exact("pin", (_, ctx) => {
      state.pinned = true;
      log(ctx, "Bifrost pinned");
    }),
    exact("unpin", (_, ctx) => {
      state.pinned = false;
      log(ctx, "Bifrost unpinned");
    }),
    exact("reload", (_, ctx) => {
      const done = debugMeasure("command", "reload");
      state.config = loadConfig(process.cwd(), state.extensionDir);
      state.enabled = state.config.enabled ?? true;
      state.classifierEnabled = state.config.classifier?.enabled ?? true;
      state.pinned = false;
      state.cacheEntries = loadCache(cachePath(process.cwd(), state.config.cache?.path));
      state.invalidatePipeline();
      done();
      debug("command", "reloaded", {
        enabled: state.enabled,
        classifierEnabled: state.classifierEnabled,
        tiers: Object.keys(state.config.models ?? {}).join(","),
      });
      log(ctx, "Bifrost config reloaded");
    }),

    // Providers
    exact("providers", (_, ctx) => {
      uiBusy(ctx, "Loading providers...");
      const available = ctx.modelRegistry.getAvailable();
      const counts = new Map<string, number>();
      for (const m of available) {
        counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
      }
      uiDone(ctx);
      uiOutput(ctx, [
        "available providers:",
        ...Array.from(counts.entries()).map(
          ([provider, count]) => `  ${provider}: ${count} model(s)`,
        ),
      ]);
    }),

    // Probe — test every model with a tiny prompt
    exact("probe", async (_, ctx) => {
      const available = ctx.modelRegistry.getAvailable();
      if (available.length === 0) {
        log(ctx, "No models available in registry.", "warning");
        return;
      }
      uiBusy(ctx, `Probing ${available.length} models...`);
      log(ctx, `Probing ${available.length} model(s) with "${PROBE_PROMPT_TEXT}"...`);

      const { results, path } = await runProbe(ctx);
      uiDone(ctx);

      const ok = results.filter((r) => r.status === "ok");
      const errs = results.filter((r) => r.status === "error");
      const timeouts = results.filter((r) => r.status === "timeout");
      const skipped = results.filter((r) => r.status === "skipped");

      const lines = [
        `--- probe results (${results.length} models) ---`,
        `  ok:      ${ok.length}`,
        `  error:   ${errs.length}`,
        `  timeout: ${timeouts.length}`,
        `  skipped: ${skipped.length}`,
        "",
      ];

      if (errs.length > 0) {
        lines.push("errors:");
        for (const e of errs.slice(0, 10)) {
          lines.push(`  ${e.provider}/${e.model} — ${e.error}`);
        }
        if (errs.length > 10) lines.push(`  ... and ${errs.length - 10} more`);
      }

      if (timeouts.length > 0) {
        lines.push("timeouts:");
        for (const t of timeouts) {
          lines.push(`  ${t.provider}/${t.model}`);
        }
      }

      lines.push("", `full results → ${path}`);
      uiOutput(ctx, lines);

      if (ok.length < results.length) {
        log(
          ctx,
          `${ok.length}/${results.length} models responded. Check ${path} for details.`,
          "warning",
        );
      } else if (ok.length > 0) {
        log(ctx, `All ${ok.length} models responded successfully.`);
      }
    }),

    // Init
    exact("init", (args, ctx) => handleInit(args, ctx, state)),

    // Benchmark
    prefix("benchmark", (args, ctx) => handleBenchmark(args, ctx, state)),

    // Cache
    exact("cache stats", (_, ctx) => {
      const path = cachePath(process.cwd(), state.config.cache?.path);
      const entries = loadCache(path);
      log(
        ctx,
        `cache: ${entries.length} entries (cap ${state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES}, threshold ${state.config.cache?.threshold ?? DEFAULT_THRESHOLD})`,
      );
    }),
    exact("cache clear", (_, ctx) => {
      const path = cachePath(process.cwd(), state.config.cache?.path);
      saveCache(path, []);
      state.cacheEntries = [];
      state.invalidatePipeline();
      log(ctx, "cache cleared");
    }),

    // Classifier
    exact("classifier on", (_, ctx) => {
      state.classifierEnabled = true;
      state.invalidatePipeline();
      debug("command", "classifier_toggle", { enabled: true });
      log(ctx, "LLM classifier enabled");
    }),
    exact("classifier off", (_, ctx) => {
      state.classifierEnabled = false;
      state.invalidatePipeline();
      debug("command", "classifier_toggle", { enabled: false });
      log(ctx, "LLM classifier disabled; regex fallback active");
    }),
    exact("classifier status", (_, ctx) => {
      const rawModel = state.config.classifier?.model;
      const modelId = Array.isArray(rawModel)
        ? rawModel.join(", ")
        : (rawModel ?? "none");
      log(
        ctx,
        `classifier: enabled=${state.classifierEnabled} model=${modelId} endpoint=${state.config.classifier?.endpoint ?? "registry"} method=${state.config.classifier?.method ?? "auto"}`,
      );
    }),

    // Preview
    prefix("preview", (args, ctx) => handlePreview(args, ctx, state)),
  ];

  return async (args: string, ctx: ExtensionContext) => {
    const trimmed = args.trim();
    const sub = trimmed.toLowerCase();

    for (const route of routes) {
      if (route.match(sub)) {
        debug("command", "dispatch", { command: sub });
        await route.handler(trimmed, ctx);
        return;
      }
    }

    // Fallback: status
    debug("command", "status");
    log(
      ctx,
      `Bifrost: enabled=${state.enabled} pinned=${state.pinned} current=${modelKey(ctx.model)}`,
    );
  };
}
