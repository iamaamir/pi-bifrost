import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BifrostConfig } from "./config.ts";
import { DEFAULT_RULES, loadConfig } from "./config.ts";
import type { CacheEntry } from "./cache.ts";
import { cachePath, loadCache, saveCache, DEFAULT_MAX_ENTRIES, DEFAULT_THRESHOLD } from "./cache.ts";
import type { ClassificationPipeline } from "./classification-pipeline.ts";
import { setupDebug, debug, debugMeasure } from "./debug.ts";
import { runProbe, PROBE_PROMPT_TEXT } from "./probe.ts";
import { setBifrostModeStatus, setBifrostStatus } from "./ux-status.ts";
import { showBifrostResult } from "./result-viewer.ts";
import {
  getStrategy,
  guessTier,
  modelKey,
  resolveModelWithFallback,
  type HealthyModelResolution,
  type RoutingStrategy,
} from "./routing.ts";
import type { ReliabilityStore } from "./reliability-store.ts";

// ── Mutable state shared across commands ────────────────────

export interface BifrostState {
  config: BifrostConfig;
  enabled: boolean;
  classifierEnabled: boolean;
  pinned: boolean;
  cacheEntries: CacheEntry[];
  reliabilityStore: ReliabilityStore;
  extensionDir: string;
  getPipeline: (ctx: ExtensionContext) => ClassificationPipeline;
  invalidatePipeline: () => void;
  lastRegistryRefreshAt?: number;
  forceRegistryRefresh?: boolean;
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

async function uiResult(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
  if (await showBifrostResult(ctx, title, lines)) return;
  for (const line of lines) console.error(`[bifrost] ${line}`);
}

export function clearBifrostWidgets(ctx: ExtensionContext) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", []);
    ctx.ui.setWidget("bifrost-probe", []);
  }
}

export function syncBifrostModeStatus(ctx: ExtensionContext, state: Pick<BifrostState, "enabled" | "pinned" | "classifierEnabled">) {
  setBifrostModeStatus(ctx, state);
}

function openCircuitCount(state: BifrostState, now = Date.now()): number {
  return state.reliabilityStore.openCircuitCount(now);
}

function formatCandidateLines(
  resolution: HealthyModelResolution,
  selectedKey: string | undefined,
): string[] {
  const skipped = new Map(resolution.skipped.map((item) => [item.key, item]));
  return resolution.candidates.map((m) => {
    const key = modelKey(m);
    const skippedCandidate = skipped.get(key);
    if (skippedCandidate) {
      const until = skippedCandidate.openUntil
        ? new Date(skippedCandidate.openUntil).toISOString()
        : "unknown";
      return `xx ${key} (open circuit until ${until})`;
    }
    const marker = key === selectedKey ? "=>" : "  ";
    return `${marker} ${key} ($${(m.cost.input + m.cost.output).toFixed(2)}/1M tokens, ctx ${m.contextWindow})`;
  });
}

// ── Shared tier-resolution + display ───────────────────────

function resolveTierDisplay(
  tier: string,
  state: BifrostState,
  ctx: ExtensionContext,
) {
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

  const selectedKey = resolved.selected ? modelKey(resolved.selected) : undefined;
  const requestedCandidateLines = formatCandidateLines(
    resolved.primary,
    resolved.selectedTier === tier ? selectedKey : undefined,
  );
  const fallbackCandidateLines = resolved.fallback
    ? formatCandidateLines(
        resolved.fallback,
        resolved.selectedTier && resolved.selectedTier !== tier ? selectedKey : undefined,
      )
    : [];

  return {
    strategy,
    selected: selectedKey ?? "none",
    selectedTier: resolved.selectedTier ?? "none",
    fallbackReason: resolved.fallbackReason,
    requestedCandidateLines,
    fallbackCandidateLines,
    defaultTier,
  };
}

// ── Init proposal builder (exported for tests) ──────────────

/** Default strategy per tier when generating init proposals. */
const PROPOSAL_STRATEGIES: Record<string, RoutingStrategy> = {
  quick: "random",
  general: "first",
  frontier: "first",
  economical: "cheapest",
};

export function buildInitProposal(
  models: Record<string, string[]>,
  classifierModel: string,
  extensionDir: string,
): Record<string, unknown> {
  const tierKeys = Object.keys(models);
  // Pick the first populated tier as default, or fall back to first key.
  const defaultTier = tierKeys.length > 0 ? tierKeys[0] : "general";
  const categoryStrategies: Record<string, RoutingStrategy> = {};
  for (const t of tierKeys) {
    categoryStrategies[t] = PROPOSAL_STRATEGIES[t] ?? "first";
  }
  return {
    $schema: `${extensionDir.replace(/\/$/, "")}/schema.json`,
    enabled: true,
    default: defaultTier,
    strategy: "first" as RoutingStrategy,
    categoryStrategies,
    classifier: {
      enabled: true,
      model: classifierModel,
      method: "auto" as const,
    },
    models,
    rules: DEFAULT_RULES,
  };
}

// ── Command handlers ────────────────────────────────────────

async function handleInit(
  _args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  clearBifrostWidgets(ctx);

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
    state.reliabilityStore.applyOutcomes(
      results.map((r) =>
        r.status === "ok"
          ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
          : { model: `${r.provider}/${r.model}`, ok: false as const, source: "probe", reason: r.error ?? r.status }
      ),
      Date.now()
    );

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
    const errors = results.filter((r) => r.status === "error").length;
    const timeouts = results.filter((r) => r.status === "timeout").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    log(ctx, `Probe complete: ok=${ok} error=${errors} timeout=${timeouts} skipped=${skipped}.`);
    if (ok === 0) {
      log(ctx, "No usable models found. Check API keys, network, and credits.", "error");
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

  const proposal = buildInitProposal(models, classifierModel, state.extensionDir);

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
  state.reliabilityStore.reload(state.config.reliability, process.cwd());
  state.invalidatePipeline();

  log(ctx, "wrote .pi/bifrost.json and reloaded config");
  log(ctx, `Bifrost active with ${Object.keys(state.config.models ?? {}).length} tier(s). Try a prompt.`);

  // Clear the init widget so it doesn't persist in the TUI.
  if (ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", []);
    ctx.ui.setWidget("bifrost-probe", []);
  }
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

  clearBifrostWidgets(ctx);
  setBifrostStatus(ctx, "benchmarking prompt...", "accent");
  uiBusy(ctx, "Classifying benchmark prompt...");
  let classification;
  try {
    classification = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
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
    const display = resolveTierDisplay(tierName, state, ctx);
    lines.push(`  ${tierName} (${display.strategy} → ${display.selectedTier}):`);
    if (display.fallbackReason) lines.push(`    fallback: ${display.fallbackReason}`);
    lines.push(...display.requestedCandidateLines.map((line) => `    ${line}`));
    if (display.fallbackCandidateLines.length > 0 && display.defaultTier && display.defaultTier !== tierName) {
      lines.push(`    fallback candidates (${display.defaultTier}):`);
      lines.push(...display.fallbackCandidateLines.map((line) => `    ${line}`));
    }
  }

  lines.push("-----------------");
  await uiResult(ctx, "Bifrost benchmark", lines);
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

  clearBifrostWidgets(ctx);
  setBifrostStatus(ctx, "previewing prompt...", "accent");
  uiBusy(ctx, "Classifying preview prompt...");
  let classification;
  try {
    classification = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  if (classification.kind === "unclassified") {
    log(ctx, "no tier matched", "warning");
    return;
  }
  const tier = classification.tier;
  const source = classification.kind === "classified" ? classification.source : "fallback";
  const display = resolveTierDisplay(tier, state, ctx);

  const lines = [
    "--- preview ---",
    `prompt:    ${prompt}`,
    `source:    ${source}`,
    `tier:      ${tier}`,
    `strategy:  ${display.strategy}`,
    `selected tier: ${display.selectedTier}`,
    ...(display.fallbackReason ? [`fallback:  ${display.fallbackReason}`] : []),
    `requested candidates (${tier}):`,
    ...display.requestedCandidateLines,
  ];
  if (display.fallbackCandidateLines.length > 0 && display.defaultTier && display.defaultTier !== tier) {
    lines.push(`fallback candidates (${display.defaultTier}):`);
    lines.push(...display.fallbackCandidateLines);
  }
  lines.push(`selected:  ${display.selected}`);
  lines.push("---------------");

  await uiResult(ctx, "Bifrost preview", lines);
}

// ── Command type ────────────────────────────────────────────

type CommandFn = (args: string, ctx: ExtensionContext) => void | Promise<void>;

interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
}

interface CommandEntry extends CommandSpec {
  readonly match: (sub: string) => boolean;
  readonly handler: CommandFn;
}

function exact(word: string, description: string, handler: CommandFn): CommandEntry {
  return { value: word, description, match: (sub) => sub === word, handler };
}

function prefix(word: string, description: string, handler: CommandFn, argumentHint = "<prompt>"): CommandEntry {
  return { value: word, description, argumentHint, match: (sub) => sub.startsWith(word), handler };
}

export const BIFROST_COMMAND_OPTIONS: readonly CommandSpec[] = [
  { value: "on", description: "Enable routing" },
  { value: "off", description: "Disable routing" },
  { value: "pin", description: "Lock current model" },
  { value: "unpin", description: "Resume routing" },
  { value: "reload", description: "Reload config after editing" },
  { value: "providers", description: "List available providers" },
  { value: "probe", description: "Probe working models" },
  { value: "init", description: "Probe models and generate config" },
  { value: "benchmark", description: "Classify a benchmark prompt", argumentHint: "<prompt>" },
  { value: "cache stats", description: "Show classification cache" },
  { value: "cache clear", description: "Clear classification cache" },
  { value: "classifier on", description: "Enable LLM classifier" },
  { value: "classifier off", description: "Disable LLM classifier" },
  { value: "classifier status", description: "Show classifier state" },
  { value: "debug", description: "Show config and routing state" },
  { value: "preview", description: "Preview routing for a prompt", argumentHint: "<prompt>" },
] as const;

export function getBifrostCommandCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  const items = BIFROST_COMMAND_OPTIONS.filter((command) => command.value.startsWith(normalized)).map((command) => ({
    value: command.value,
    label: command.value,
    description: command.description,
  }));
  return items.length > 0 ? items : null;
}

function formatBifrostCommandChoice(command: CommandSpec): string {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `/bifrost ${command.value}${hint} — ${command.description}`;
}

function dashboardCommands(state: Pick<BifrostState, "enabled" | "pinned">): CommandSpec[] {
  const values = [
    state.enabled ? "off" : "on",
    state.pinned ? "unpin" : "pin",
    "preview",
    "providers",
    "probe",
    "init",
    "classifier status",
    "reload",
  ];
  return values.map((value) => BIFROST_COMMAND_OPTIONS.find((command) => command.value === value)!);
}

async function pickBifrostCommand(
  ctx: ExtensionContext,
  title = "Bifrost commands",
  options: readonly CommandSpec[] = BIFROST_COMMAND_OPTIONS,
): Promise<CommandSpec | undefined> {
  if (!ctx.hasUI) return undefined;
  const selected = await ctx.ui.select(title, options.map(formatBifrostCommandChoice));
  if (!selected) return undefined;
  return options.find((command) => formatBifrostCommandChoice(command) === selected);
}

// ── Route table ─────────────────────────────────────────────

export function createCommandRouter(
  state: BifrostState,
): (args: string, ctx: ExtensionContext) => Promise<void> {
  const routes: CommandEntry[] = [
    exact("on", "Enable routing", (_, ctx) => {
      state.enabled = true;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost enabled");
    }),
    exact("off", "Disable routing", (_, ctx) => {
      state.enabled = false;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost disabled");
    }),
    exact("pin", "Lock current model", (_, ctx) => {
      state.pinned = true;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost pinned");
    }),
    exact("unpin", "Resume routing", (_, ctx) => {
      state.pinned = false;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost unpinned");
    }),
    exact("reload", "Reload config after editing", (_, ctx) => {
      const done = debugMeasure("command", "reload");
      state.config = loadConfig(process.cwd(), state.extensionDir);
      // Re-init debug — user may have updated debug config since startup.
      setupDebug(state.config.debug ?? { enabled: false }, process.cwd());
      state.enabled = state.config.enabled ?? true;
      state.classifierEnabled = state.config.classifier?.enabled ?? true;
      state.pinned = false;
      state.cacheEntries = loadCache(cachePath(process.cwd(), state.config.cache?.path));
      state.reliabilityStore.reload(state.config.reliability, process.cwd());
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      done();
      debug("command", "reloaded", {
        enabled: state.enabled,
        classifierEnabled: state.classifierEnabled,
        tiers: Object.keys(state.config.models ?? {}).join(","),
      });
      log(ctx, "Bifrost config reloaded");
    }),

    // Providers
    exact("providers", "List available providers", (_, ctx) => {
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
    exact("probe", "Probe working models", async (_, ctx) => {
      const available = ctx.modelRegistry.getAvailable();
      if (available.length === 0) {
        log(ctx, "No models available in registry.", "warning");
        return;
      }
      clearBifrostWidgets(ctx);
      uiBusy(ctx, `Probing ${available.length} models...`);
      log(ctx, `Probing ${available.length} model(s) with "${PROBE_PROMPT_TEXT}"...`);

      const { results, path } = await runProbe(ctx);
      uiDone(ctx);
      state.reliabilityStore.applyOutcomes(
        results.map((r) =>
          r.status === "ok"
            ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
            : { model: `${r.provider}/${r.model}`, ok: false as const, source: "probe", reason: r.error ?? r.status }
        ),
        Date.now()
      );

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

      // Clear the probe widget so results don't persist in the TUI.
      if (ctx.hasUI) {
        ctx.ui.setWidget("bifrost-probe", []);
        ctx.ui.setWidget("bifrost-output", []);
      }
    }),

    // Init
    exact("init", "Probe models and generate config", (args, ctx) => handleInit(args, ctx, state)),

    // Benchmark
    prefix("benchmark", "Classify a benchmark prompt", (args, ctx) => handleBenchmark(args, ctx, state), "<prompt>"),

    // Cache
    exact("cache stats", "Show classification cache", (_, ctx) => {
      const path = cachePath(process.cwd(), state.config.cache?.path);
      const entries = loadCache(path);
      log(
        ctx,
        `cache: ${entries.length} entries (cap ${state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES}, threshold ${state.config.cache?.threshold ?? DEFAULT_THRESHOLD})`,
      );
    }),
    exact("cache clear", "Clear classification cache", (_, ctx) => {
      const path = cachePath(process.cwd(), state.config.cache?.path);
      saveCache(path, []);
      state.cacheEntries = [];
      state.invalidatePipeline();
      log(ctx, "cache cleared");
    }),

    // Classifier
    exact("classifier on", "Enable LLM classifier", (_, ctx) => {
      state.classifierEnabled = true;
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: true });
      log(ctx, "LLM classifier enabled");
    }),
    exact("classifier off", "Disable LLM classifier", (_, ctx) => {
      state.classifierEnabled = false;
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: false });
      log(ctx, "LLM classifier disabled; regex fallback active");
    }),
    exact("classifier status", "Show classifier state", (_, ctx) => {
      const rawModel = state.config.classifier?.model;
      const modelId = Array.isArray(rawModel)
        ? rawModel.join(", ")
        : (rawModel ?? "none");
      log(
        ctx,
        `classifier: enabled=${state.classifierEnabled} model=${modelId} endpoint=${state.config.classifier?.endpoint ?? "registry"} method=${state.config.classifier?.method ?? "auto"}`,
      );
    }),

    // Debug — show loaded config state
    exact("debug", "Show config and routing state", (_, ctx) => {
      const rules = state.config.rules ?? [];
      const tiers = Object.keys(state.config.models ?? {});
      const lines = [
        "--- config ---",
        `cwd: ${process.cwd()}`,
        `enabled: ${state.enabled}`,
        `pinned: ${state.pinned}`,
        `classifierEnabled: ${state.classifierEnabled}`,
        `default: ${state.config.default}`,
        `strategy: ${state.config.strategy}`,
        `tiers: ${tiers.join(", ")}`,
        `debug: ${JSON.stringify(state.config.debug)}`,
        `cache: ${state.cacheEntries.length} entries`,
        `reliability: ${JSON.stringify(state.config.reliability ?? {})}`,
        `openCircuits: ${openCircuitCount(state)}`,
        "",
        `rules (${rules.length}):`,
        ...rules.map((r, i) => `  ${i}: "${r.pattern}" → "${r.model}"`),
        "---",
      ];
      uiOutput(ctx, lines);
      log(ctx, "debug info printed above");
    }),
    prefix("preview", "Preview routing for a prompt", (args, ctx) => handlePreview(args, ctx, state), "<prompt>"),
  ];

  return async (args: string, ctx: ExtensionContext) => {
    const trimmed = args.trim();
    const sub = trimmed.toLowerCase();

    if (!trimmed) {
      debug("command", "dashboard");
      if (!ctx.hasUI) {
        log(
          ctx,
          `Bifrost: enabled=${state.enabled} pinned=${state.pinned} current=${modelKey(ctx.model)}`,
        );
        return;
      }

      const mode = !state.enabled ? "off" : state.pinned ? "pinned" : "on";
      const selected = await pickBifrostCommand(
        ctx,
        `Bifrost · ${mode} · model ${modelKey(ctx.model)}${openCircuitCount(state) > 0 ? ` · circuits ${openCircuitCount(state)} open` : ""}`,
        dashboardCommands(state),
      );
      if (!selected) return;

      if (selected.argumentHint) {
        ctx.ui.setEditorText(`/bifrost ${selected.value} `);
        return;
      }

      const route = routes.find((entry) => entry.value === selected.value);
      if (!route) return;
      await route.handler(route.value, ctx);
      return;
    }

    for (const route of routes) {
      if (route.match(sub)) {
        debug("command", "dispatch", { command: sub });
        await route.handler(trimmed, ctx);
        return;
      }
    }

    debug("command", "picker", { command: sub });
    if (!ctx.hasUI) {
      log(ctx, `Unknown /bifrost subcommand: ${trimmed}`, "warning");
      return;
    }

    const selected = await pickBifrostCommand(ctx);
    if (!selected) return;

    if (selected.argumentHint) {
      ctx.ui.setEditorText(`/bifrost ${selected.value} `);
      log(ctx, `Prefilled /bifrost ${selected.value}`);
      return;
    }

    const route = routes.find((entry) => entry.value === selected.value);
    if (!route) return;

    debug("command", "dispatch", { command: route.value });
    await route.handler(route.value, ctx);
  };
}
