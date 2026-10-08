import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIFROST_COMMAND_OPTIONS, BIFROST_JSON_PREFIX, buildClassifierTestReport, buildPreviewFailure, buildPreviewReport, createCommandRouter, getBifrostCommandCompletions, log, nextClassifierConfig, parsePreviewArgs, renderPreviewReport, runBifrostCommand, serializePreviewReport, type BifrostPreviewSuccess } from "../commands.ts";
import { makeModel, makePiClassifierModel, makeRegistry } from "./helpers.ts";
import { createPipeline } from "../classification-pipeline.ts";
import { DEFAULT_THRESHOLD, lookupCache, touchCacheEntry, updateCache, type CacheEntry } from "../cache.ts";
import { reliabilityPath } from "../reliability.ts";
import { reliabilityV2Path } from "../runtime-reliability-v2.ts";

function makeCtx(
  models: Array<{ provider: string; id: string }> = [],
  selectOverride?: (title: string, options: string[]) => string | undefined,
  customOverride?: () => Promise<unknown>,
  registryOverride?: Pick<ReturnType<typeof makeRegistry>, "getAvailableOfType">,
) {
  const calls: Array<{ kind: string; value?: unknown; title?: string; options?: string[]; lines?: string[] }> = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: {
        fg: (_: string, text: string) => text,
      },
      select: async (title: string, options: string[]) => {
        calls.push({ kind: "select", title, options });
        return selectOverride?.(title, options) ?? options.find((option) => option.includes("/bifrost off"));
      },
      notify: (message: string, type?: string) => {
        calls.push({ kind: "notify", value: `${type ?? "info"}:${message}` });
      },
      setStatus: (key: string, value: string | undefined) => {
        calls.push({ kind: "status", value: `${key}:${value ?? ""}` });
      },
      setWidget: (key: string, value: string[] | undefined) => {
        calls.push({ kind: "widget", value: `${key}:${value?.length ?? 0}`, lines: value });
      },
      setWorkingMessage: (_?: string) => {},
      setWorkingVisible: (_: boolean) => {},
      setEditorText: (value: string) => {
        calls.push({ kind: "editor", value });
      },
      setWorkingIndicator: () => {},
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => {
        calls.push({ kind: "custom" });
        return customOverride?.();
      },
      pasteToEditor: () => {},
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      getTheme: () => undefined,
      getAllThemes: () => [],
      setTheme: () => ({ success: true }),
    },
    modelRegistry: {
      getAvailable: () => models,
      ...registryOverride,
    },
    scopedModels: [],
  };
  return { ctx: ctx as never, calls };
}

function makeStore(reliabilityState?: Record<string, { failures: number[]; openUntil?: number }>, enabled = true) {
  const store = {
    getState: () => ({ version: 1 as const, models: reliabilityState ?? {} }),
    reload: () => {},
    openCircuitCount: (now?: number) => {
      if (!enabled) return 0;
      const t = now ?? Date.now();
      return Object.entries(reliabilityState ?? {}).filter(([, r]) => r.openUntil && r.openUntil > t).length;
    },
  };
  return store;
}

function makeState(saveModeState: () => void = () => {}) {
  return {
    config: {
      models: {},
      default: undefined as string | undefined,
      strategy: "first",
      reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
    },
    enabled: true,
    tierPolicyValid: true,
    classifierEnabled: true,
    pinned: false,
    cacheEntries: [],
    reliabilityStore: makeStore(),
    classifierMetricsStore: {
      snapshot: () => ({ version: 1, model: "jev-1.13.0", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0 }),
      reload: () => {},
    },
    extensionDir: ".",
    effectiveClassifierBackend: (config: { classifier?: { backend?: string } }) => ({
      backend: config.classifier?.backend ?? "prompt",
      reason: config.classifier?.backend ? "explicit config" : "no credential detected",
      auto: !config.classifier?.backend,
    }),
    getPipeline: () => ({ classify: async () => ({ kind: "unclassified" as const }) }),
    invalidatePipeline: () => {},
    saveModeState,
  };
}

async function captureJsonReports(run: () => Promise<void>): Promise<unknown[]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  const marked = lines.filter((line) => line.startsWith(BIFROST_JSON_PREFIX));
  assert.equal(marked.length, 1, `expected exactly one marker line, got:\n${lines.join("\n")}`);
  return [JSON.parse(marked[0].slice(BIFROST_JSON_PREFIX.length))];
}

describe("classifier chooser config", () => {
  it("sets pi-native model and removes prompt-only settings without losing fallback model", () => {
    const next = nextClassifierConfig({
      model: "chat/fallback", endpoint: "https://old", method: "auto", systemPrompt: "old",
      maxTokens: 12, temperature: 0, fallbackToRegex: true, piNative: { timeoutMs: 500 },
    }, { backend: "pi-native", piNativeModel: "typesafe/jev-latest" });
    assert.equal(next.backend, "pi-native");
    assert.deepEqual(next.piNative, { timeoutMs: 500, model: "typesafe/jev-latest" });
    assert.equal(next.model, "chat/fallback");
    assert.equal(next.fallback, "prompt");
    assert(next.criteria);
    for (const field of ["endpoint", "method", "systemPrompt", "maxTokens", "temperature", "fallbackToRegex"]) {
      assert.equal(field in next, false, field);
    }
  });

  it("catalog default clears a prior explicit pi-native model", () => {
    const next = nextClassifierConfig({ piNative: { model: "typesafe/old", maxAttempts: 2 } },
      { backend: "pi-native", piNativeModel: null });
    assert.deepEqual(next.piNative, { maxAttempts: 2 });
    assert.equal(next.fallback, "regex");
  });

  it("keeps prompt model on reselect and still clears it when unavailable", () => {
    assert.equal(nextClassifierConfig({ model: "chat/a" }, { backend: "prompt" }).model, "chat/a");
    assert.equal("model" in nextClassifierConfig({ model: "chat/a" }, { backend: "prompt", promptModel: null }), false);
  });
});

describe("bifrost command ui", () => {
  it("renders TUI log messages once without duplicating them to stderr", () => {
    const { ctx, calls } = makeCtx();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      log(ctx as never, "Bifrost config reloaded");
    } finally {
      console.error = original;
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(
      calls.filter((call) => call.kind === "notify").map((call) => call.value),
      ["info:Bifrost config reloaded"],
    );
  });

  it("surfaces command descriptions in autocomplete", () => {
    const items = getBifrostCommandCompletions("class") ?? [];
    assert(items.some((item) => item.value === "classifier status" && item.description === "Show classifier state"));
  });

  it("submits exact commands without requiring a second Enter", () => {
    assert.equal(getBifrostCommandCompletions("classifier status"), null);
    assert.equal(getBifrostCommandCompletions("classifier"), null);
  });

  it("clears submitted text before dispatch while preserving follow-up prefills", async () => {
    const { ctx, calls } = makeCtx();
    await runBifrostCommand("preview", ctx as never, async (_args, commandCtx) => {
      commandCtx.ui.setEditorText("/bifrost preview ");
    });
    assert.deepEqual(calls.filter((call) => call.kind === "editor").map((call) => call.value), ["", "/bifrost preview "]);
  });

  it("opens dashboard for root command", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const dispatch = createCommandRouter(state as never);

    await dispatch("", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    assert(select, "dashboard should open");
    assert.match(String(select?.title ?? ""), /Bifrost · on · model none/);
    assert.equal(select?.options?.length, BIFROST_COMMAND_OPTIONS.length);
    assert((select?.options ?? []).some((option) => option.includes("Disable routing")));
    assert.equal(state.enabled, false);
  });

  it("persists mode toggles", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState(() => calls.push({ kind: "save" }));
    const dispatch = createCommandRouter(state as never);

    await dispatch("off", ctx as never);
    await dispatch("pin", ctx as never);
    await dispatch("classifier off", ctx as never);

    assert.equal(calls.filter((call) => call.kind === "save").length, 3);
    assert.equal(state.enabled, false);
    assert.equal(state.pinned, true);
    assert.equal(state.classifierEnabled, false);
  });

  it("does not pin or disable a virtual selection until physical activation succeeds", async () => {
    const { ctx } = makeCtx();
    const state = Object.assign(makeState(), { selectPhysicalFromVirtual: async () => false });
    const dispatch = createCommandRouter(state as never);
    await dispatch("pin", ctx as never);
    await dispatch("off", ctx as never);
    assert.equal(state.pinned, false);
    assert.equal(state.enabled, true);
    state.selectPhysicalFromVirtual = async () => true;
    await dispatch("pin", ctx as never);
    assert.equal(state.pinned, true);
  });

  it("selecting prompt also persists a classifier model", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const { ctx, calls } = makeCtx(
        [{ provider: "fixture", id: "classifier" }],
        (_title, options) => options[0],
        async () => "fixture/classifier",
      );
      const state = makeState();
      const dispatch = createCommandRouter(state as never);

      await dispatch("classifier", ctx as never);

      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, "prompt");
      assert.equal(saved.classifier.model, "fixture/classifier");
      assert.ok(calls.some((call) => call.kind === "custom"));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("selecting TypeSafe makes Jev and prompt fallback explicit", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(join(tempDir, ".pi", "bifrost.json"), JSON.stringify({
        classifier: {
          enabled: true,
          backend: "prompt",
          model: "fixture/classifier",
          method: "auto",
          systemPrompt: "prompt-only",
        },
      }));
      const { ctx } = makeCtx([], (_title, options) => options.find((option) => option.startsWith("typesafe")));
      const state = makeState();
      const dispatch = createCommandRouter(state as never);

      await dispatch("classifier", ctx as never);

      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, "typesafe");
      assert.equal(saved.classifier.model, "fixture/classifier");
      assert.equal(saved.classifier.fallback, "prompt");
      assert.equal(saved.classifier.method, undefined);
      assert.equal(saved.classifier.systemPrompt, undefined);
      assert.equal(saved.classifier.typesafe?.model, "jev-1.13.0");
      assert.ok(saved.classifier.criteria);
      assert.equal(saved.classifier.typesafe?.trustedProjects, undefined);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows TypeSafe model and prompt fallback separately in status", async () => {
    const { ctx, calls } = makeCtx();
    const state: any = makeState();
    state.config = {
      models: {},
      classifier: {
        backend: "typesafe",
        model: "fixture/classifier",
        fallback: "prompt",
        typesafe: { model: "jev-1.13.0" },
      },
    };
    const dispatch = createCommandRouter(state as never);

    await dispatch("classifier status", ctx as never);

    const output = calls.find((call) => call.kind === "widget")?.lines?.join("\n") ?? "";
    assert.match(output, /backend=typesafe model=jev-1\.13\.0/);
    assert.match(output, /fallback=prompt fallbackModel=fixture\/classifier/);
  });

  it("shows auto-detected pi-native backend and reason in status", async () => {
    const { ctx, calls } = makeCtx();
    const state: any = makeState();
    state.effectiveClassifierBackend = () => ({ backend: "pi-native", reason: "Pi-managed TypeSafe credential", auto: true });
    await createCommandRouter(state)("classifier status", ctx as never);
    const output = calls.find((call) => call.kind === "widget")?.lines?.join("\n") ?? "";
    assert.match(output, /backend=auto: pi-native \(Pi-managed TypeSafe credential\) model=catalog default/);
    assert.match(output, /observations=0/);
  });

  it("names pi-native and its resolved model in classifier test report", () => {
    const metrics = {
      version: 1 as const, model: "typesafe/jev-latest", total: 1,
      outcomes: { success: 1 }, tiers: { quick: 1 }, confidenceBands: {}, latencyBuckets: {},
      totalLatencyMs: 100, totalAttempts: 1,
    };
    const lines = buildClassifierTestReport({
      classifier: { piNative: {} },
      effectiveBackend: { backend: "pi-native", reason: "Pi-managed TypeSafe credential", auto: true },
      result: { kind: "classified", tier: "quick", source: "classifier", judgment: {
        tier: "quick", backend: "pi-native", model: "typesafe/jev-latest", confidence: 0.93,
      } },
      before: { ...metrics, total: 0, outcomes: {} }, after: metrics,
    });
    assert(lines.includes("backend: auto: pi-native (Pi-managed TypeSafe credential)"));
    assert(lines.includes("model: typesafe/jev-latest"));
    assert(lines.includes("accepted: yes"));
    assert(lines.includes("outcome: success"));
  });

  it("separates a rejected TypeSafe judgment from the final fallback route", () => {
    const before = {
      version: 1, model: "jev-1.13.0", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
    } as const;
    const after = {
      ...before,
      total: 1,
      outcomes: { low_confidence: 1 },
      tiers: { quick: 1 },
      confidenceBands: { "<0.8": 1 },
      totalAttempts: 1,
    } as const;

    const lines = buildClassifierTestReport({
      classifier: { backend: "typesafe", typesafe: { model: "jev-1.13.0" }, minConfidence: 0.8 },
      result: {
        kind: "classified",
        tier: "frontier",
        source: "classifier",
        judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier" },
      },
      before,
      after,
      credential: "environment",
    });

    assert(lines.includes("backend: typesafe"));
    assert(lines.includes("model: jev-1.13.0"));
    assert(lines.includes("backend result: quick"));
    assert(lines.includes("confidence: <0.8"));
    assert(lines.includes("accepted: no"));
    assert(lines.includes("final result: frontier"));
    assert(lines.includes("final source: classifier"));
    assert(lines.includes("final backend: prompt"));
    assert(lines.includes("final model: fixture/classifier"));
    assert(lines.includes("outcome: low_confidence"));
  });

  it("prints classifier guidance after --write init without opening picker", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-guidance-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(join(tempDir, ".pi", "bifrost-probe.json"), JSON.stringify([
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]));
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState();
      await createCommandRouter(state as never)("init --write", ctx as never);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), true);
      assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("Next: run /bifrost classifier")));
      assert.equal(calls.some((call) => call.kind === "select"), false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("hides the pi-native backend on hosts without classification support", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-hide-native-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      // Plain makeCtx registry has no classify(): an unsupported host.
      const { ctx, calls } = makeCtx([], (_title, options) => options.find((item) => item.startsWith("pi-native")));
      const state = makeState();
      await createCommandRouter(state as never)("classifier", ctx as never);
      const picker = calls.find((call) => call.kind === "select" && call.title === "Classifier backend");
      assert.ok(picker?.options?.length);
      assert.ok(picker?.options?.every((item) => !item.startsWith("pi-native")));
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("lists only available Pi classifier models and writes the chosen id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-native-chooser-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const available = makePiClassifierModel("typesafe", "jev-latest");
      const unavailable = makePiClassifierModel("typesafe", "jev-private");
      const registry = makeRegistry([], {
        classifierModels: [available, unavailable], availableClassifierModels: [available],
      });
      const { ctx, calls } = makeCtx([], (title, options) => title === "Classifier backend"
        ? options.find((item) => item.startsWith("pi-native"))
        : options.find((item) => item === "typesafe/jev-latest"), undefined, registry);
      const state = makeState();
      await createCommandRouter(state as never)("classifier", ctx as never);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, "pi-native");
      assert.equal(saved.classifier.piNative.model, "typesafe/jev-latest");
      assert(calls.some((call) => call.kind === "select" && call.title === "Pi native classifier model"
        && call.options?.includes("typesafe/jev-latest") && !call.options?.includes("typesafe/jev-private")));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves config unchanged when prompt model picker is cancelled", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const { ctx } = makeCtx(
        [{ provider: "fixture", id: "classifier" }],
        (_title, options) => options[0],
        async () => null,
      );
      const state = makeState();
      const dispatch = createCommandRouter(state as never);

      await dispatch("classifier", ctx as never);

      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows picker for unknown subcommand", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState() as ReturnType<typeof makeState> & { lastRegistryRefreshAt?: number };
    const dispatch = createCommandRouter(state as never);

    await dispatch("abc", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    assert(select, "picker should open");
    assert.match(String(select?.title ?? ""), /Bifrost commands/);
    assert((select?.options ?? []).some((option) => option.includes("Disable routing")));
    assert.equal(state.enabled, false);
  });

  it("shows open circuit count in dashboard title", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const t = Date.now();
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [t], openUntil: t + 60_000 } });
    const dispatch = createCommandRouter(state as never);

    await dispatch("", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    assert(select, "dashboard should open");
    assert.match(String(select?.title ?? ""), /circuits 1 open/);
  });

  it("prints open circuit count in debug output", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const t = Date.now();
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [t], openUntil: t + 60_000 } });
    const dispatch = createCommandRouter(state as never);

    await dispatch("debug", ctx as never);

    const widget = calls.find((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-output:"));
    assert(widget?.lines?.some((line) => line.includes("openCircuits: 1")));
  });

  it("shows no open circuits when reliability is disabled", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.config.reliability.enabled = false;
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [Date.now()], openUntil: Date.now() + 60_000 } }, false);
    const dispatch = createCommandRouter(state as never);

    await dispatch("debug", ctx as never);

    const widget = calls.find((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-output:"));
    assert(widget?.lines?.some((line) => line.includes("openCircuits: 0")));
  });
});

describe("preview report", () => {
  const display = {
    strategy: "first-available",
    selected: "fake/chat",
    selectedTier: "general",
    fallbackReason: undefined as string | undefined,
    requestedCandidateLines: ["fake/chat"],
    fallbackCandidateLines: [] as string[],
    defaultTier: "general",
  };

  it("carries every routing decision as a typed field", () => {
    const report = buildPreviewReport({
      prompt: "direct hit",
      classification: { kind: "classified", tier: "general", source: "regex" },
      display,
    });

    assert.deepEqual(report, {
      ok: true,
      prompt: "direct hit",
      source: "regex",
      tier: "general",
      strategy: "first-available",
      selectedTier: "general",
      selected: "fake/chat",
      defaultTier: "general",
      requestedCandidates: ["fake/chat"],
      fallbackCandidates: [],
    });
  });

  it("reports fallback source and omits absent optional fields", () => {
    const report = buildPreviewReport({
      prompt: "anything",
      classification: { kind: "fallback", tier: "general" },
      display,
    });

    assert.equal(report.source, "fallback");
    assert.equal("backend" in report, false);
    assert.equal("model" in report, false);
    assert.equal("confidence" in report, false);
    assert.equal("fallbackReason" in report, false);
  });

  it("omits confidence when the judgment carries none", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "classified",
        tier: "quick",
        source: "classifier",
        judgment: { tier: "quick", backend: "pi-native", model: "typesafe/jev-latest" },
      },
      display,
    });

    assert.equal(report.backend, "pi-native");
    assert.equal(report.model, "typesafe/jev-latest");
    assert.equal("confidence" in report, false);
  });

  it("keeps a zero confidence, which is falsy but present", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "classified",
        tier: "quick",
        source: "classifier",
        judgment: { tier: "quick", backend: "pi-native", confidence: 0 },
      },
      display,
    });

    assert.equal(report.confidence, 0);
  });

  it("surfaces the fallback reason and both candidate lists", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "fallback", tier: "quick" },
      display: {
        ...display,
        selectedTier: "general",
        fallbackReason: "all requested models unavailable",
        requestedCandidateLines: ["a/one", "b/two"],
        fallbackCandidateLines: ["c/three"],
      },
    });

    assert.equal(report.fallbackReason, "all requested models unavailable");
    assert.deepEqual(report.requestedCandidates, ["a/one", "b/two"]);
    assert.deepEqual(report.fallbackCandidates, ["c/three"]);
  });

  it("renders the same report as the text view", () => {
    const report = buildPreviewReport({
      prompt: "direct hit",
      classification: { kind: "classified", tier: "general", source: "regex" },
      display,
    });
    const lines = renderPreviewReport(report);

    assert(lines.includes("prompt:    direct hit"));
    assert(lines.includes("source:    regex"));
    assert(lines.includes("tier:      general"));
    assert(lines.includes("selected:  fake/chat"));
  });

  it("keeps none and n/a placeholders in the text view while JSON omits the keys", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "classified",
        tier: "quick",
        source: "classifier",
        judgment: { tier: "quick", backend: "prompt" },
      },
      display,
    });
    const lines = renderPreviewReport(report);

    assert(lines.includes("model:     none"));
    assert(lines.includes("confidence: n/a"));
    assert.equal("model" in report, false);
    assert.equal("confidence" in report, false);
  });

  it("keeps a zero confidence visible in the text view", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "classified",
        tier: "quick",
        source: "classifier",
        judgment: { tier: "quick", backend: "pi-native", confidence: 0 },
      },
      display,
    });

    assert(renderPreviewReport(report).includes("confidence: 0"));
  });

  it("serializes to one parseable line with no prose envelope", () => {
    const report = buildPreviewReport({
      prompt: "direct hit",
      classification: { kind: "classified", tier: "general", source: "regex" },
      display,
    });
    const line = serializePreviewReport(report);

    assert.equal(line.split("\n").length, 1);
    assert.deepEqual(JSON.parse(line), report);
  });

  it("escapes a prompt that would otherwise break the JSON line", () => {
    const report = buildPreviewReport({
      prompt: 'quote " and\nnewline',
      classification: { kind: "classified", tier: "general", source: "regex" },
      display,
    });
    const line = serializePreviewReport(report);

    assert.equal(line.split("\n").length, 1);
    assert.equal(JSON.parse(line).prompt, 'quote " and\nnewline');
  });

  it("omits the unresolved selection keys instead of reporting a none sentinel", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "fallback", tier: "quick" },
      display: { ...display, selected: undefined, selectedTier: undefined },
    });

    assert.equal("selected" in report, false);
    assert.equal("selectedTier" in report, false);
    assert.equal(JSON.parse(serializePreviewReport(report)).selected, undefined);
  });

  it("reports a selection that really is the string none", () => {
    // `none` is a legal tier name and a legal config.default, so an unresolved
    // selection must be absent — not the string "none". Omitting the key for a
    // selection that resolved *into* a tier named none would misreport a
    // successful routing decision as nothing resolved.
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "fallback", tier: "none" },
      display: { ...display, selected: "none", selectedTier: "none", defaultTier: "none" },
    });

    assert.equal("selected" in report, true);
    assert.equal(report.selected, "none");
    assert.equal(report.selectedTier, "none");
    assert.equal(report.tier, "none");
  });

  it("keeps the none placeholder in the text view for an unresolved selection", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "fallback", tier: "quick" },
      display: { ...display, selected: undefined, selectedTier: undefined },
    });
    const lines = renderPreviewReport(report);

    assert(lines.includes("selected tier: none"));
    assert(lines.includes("selected:  none"));
  });

  it("renders a selection that really is the string none the same way", () => {
    // The placeholder and a real "none" render to the same bytes, which is why
    // the JSON report has to carry the distinction rather than the text view.
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "fallback", tier: "none" },
      display: { ...display, selected: "none", selectedTier: "none", defaultTier: "none" },
    });
    const lines = renderPreviewReport(report);

    assert(lines.includes("tier:      none"));
    assert(lines.includes("selected tier: none"));
    assert(lines.includes("selected:  none"));
  });

  it("allows a success report to carry no selection keys at all", () => {
    // Compile-time pin: the success type must let a consumer or a hand-built
    // report omit the unresolved selection keys, not require the sentinel.
    const lines = renderPreviewReport({
      ok: true,
      prompt: "p",
      source: "fallback",
      tier: "quick",
      strategy: "first",
      requestedCandidates: [],
      fallbackCandidates: [],
    });

    assert(lines.includes("selected tier: none"));
    assert(lines.includes("selected:  none"));
  });

  it("still reports a resolved model whose tier is configured", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "fallback", tier: "quick" },
      display,
    });

    assert.equal(report.selected, "fake/chat");
    assert.equal(report.selectedTier, "general");
  });
});

describe("preview failure report", () => {
  it("builds a machine-readable usage failure with no routing fields", () => {
    assert.deepEqual(buildPreviewFailure("", "usage"), { ok: false, prompt: "", error: "usage" });
  });

  it("builds a machine-readable unclassified failure carrying the prompt", () => {
    assert.deepEqual(buildPreviewFailure("hello", "unclassified"), {
      ok: false,
      prompt: "hello",
      error: "unclassified",
    });
  });

  it("serializes to one parseable line", () => {
    const line = serializePreviewReport(buildPreviewFailure("hello", "unclassified"));

    assert.equal(line.split("\n").length, 1);
    assert.deepEqual(JSON.parse(line), { ok: false, prompt: "hello", error: "unclassified" });
  });
});

describe("preview command hint", () => {
  it("advertises the --json flag in the dashboard menu row", async () => {
    const { ctx, calls } = makeCtx();
    const dispatch = createCommandRouter(makeState() as never);

    await dispatch("", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    const rows = select?.options ?? [];
    assert(
      rows.includes("/bifrost preview [--trace] [--json] <prompt> — Preview routing for a prompt"),
      `preview menu row must advertise --json, got:\n${rows.join("\n")}`,
    );
  });

  it("keeps the preview completion label and description stable", async () => {
    // Tab completion shows `value`/`label`/`description` only — the argument hint
    // is not part of a completion item, so the flag is discoverable in the menu
    // and not in the completion list. Pinned here so that split is a deliberate
    // record rather than an accident.
    const items = getBifrostCommandCompletions("prev") ?? [];
    assert.deepEqual(items, [{
      value: "preview",
      label: "preview",
      description: "Preview routing for a prompt",
    }]);
  });
});

describe("preview json marker", () => {
  it("reports a usage failure when the prompt is missing", async () => {
    const { ctx, calls } = makeCtx();
    const dispatch = createCommandRouter(makeState() as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json", ctx as never);
    });

    assert.deepEqual(report, { ok: false, prompt: "", error: "usage" });
    assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("usage: /bifrost preview --json")));
  });

  it("reports an unclassified failure when no tier matches", async () => {
    const { ctx, calls } = makeCtx();
    const dispatch = createCommandRouter(makeState() as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json hello", ctx as never);
    });

    assert.deepEqual(report, { ok: false, prompt: "hello", error: "unclassified" });
    assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("no tier matched")));
  });

  it("marks a successful report as ok", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.getPipeline = () => ({
      classify: async () => ({ kind: "fallback" as const, tier: "general" }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json hello", ctx as never);
    });

    assert.equal((report as { ok?: boolean }).ok, true);
    assert.equal((report as { prompt?: string }).prompt, "hello");
  });

  it("reports only attempted tiers for an explicit boundary, not the unvisited default", async () => {
    const { ctx } = makeCtx([
      makeModel("fixture", "allowed-model", 1, 1, 2000),
      makeModel("fixture", "default-model", 0, 0, 4000),
    ]);
    const state = makeState();
    Object.assign(state.config, {
      schemaVersion: 2,
      default: "default",
      models: {
        restricted: ["missing-model"],
        backup: ["backup-missing"],
        allowed: ["allowed-model"],
        default: ["default-model"],
      },
      categoryStrategies: { restricted: "first", backup: "cheapest", allowed: "largest_context" },
      tierPolicies: { restricted: { fallbackTiers: ["backup", "allowed"] } },
    });
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "restricted", source: "regex" }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json inspect", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.equal(report.fallbackBoundary, "explicit");
    assert.equal("defaultTier" in report, false);
    assert.deepEqual((report.attemptedTiers as Array<{ tier: string }>).map(({ tier }) => tier), ["restricted", "backup", "allowed"]);
    assert.equal(report.strategy, "largest_context");
    assert.doesNotMatch(JSON.stringify(report), /default-model/);
    const lines = renderPreviewReport(report as unknown as BifrostPreviewSuccess);
    assert(lines.includes("fallback boundary: explicit"));
    assert(lines.some((line) => line.includes("attempt 2 (backup,")));
    assert(lines.some((line) => line.includes("attempt 3 (allowed, largest_context):")));
    assert.doesNotMatch(lines.join("\n"), /default-model/);
  });

  it("keeps the selection keys for a tier literally named none", async () => {
    // End-to-end through resolveTierDisplay, which the pure buildPreviewReport
    // tests bypass. `none` is a legal tier name and a legal config.default, so a
    // successful resolution into it must not be reported as nothing resolved.
    const { ctx } = makeCtx([makeModel("openai", "gpt-5.4")]);
    const state = makeState();
    // A bare substring pattern keeps this on the getAvailable path, which the
    // local fake registry supports.
    state.config.models = { none: ["gpt-5.4"] };
    state.config.default = "none";
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "none", source: "regex" }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json hello", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.equal(report.tier, "none");
    assert.equal(report.selectedTier, "none");
    assert.equal(report.selected, "openai/gpt-5.4");
    assert.equal(report.defaultTier, "none");
  });

  it("omits the selection keys when the tier resolves to nothing", async () => {
    // The counterpart to the literal-none case above, through the same path: an
    // empty tier and no default must report absent keys, not "none".
    const { ctx } = makeCtx([makeModel("openai", "gpt-5.4")]);
    const state = makeState();
    state.config.models = { general: ["no-such-model"] };
    state.config.default = undefined;
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "general", source: "regex" }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json hello", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.equal(report.tier, "general");
    assert.equal("selectedTier" in report, false);
    assert.equal("selected" in report, false);
  });

  it("reports source cache when the prompt is already cached", async () => {
    // The review found the documented `source` values incomplete by tracing
    // `classify`: `handlePreview` calls the real pipeline, whose stage 2 is the
    // cache. Preview does not write the cache itself — the turn handler does —
    // so the entry is seeded the way index.ts seeds it after a real turn, then
    // the same prompt is previewed again. This must not be faked with a stub
    // `classify`, or the very path being pinned would be the one bypassed.
    const { ctx } = makeCtx([makeModel("openai", "gpt-5.4")]);
    const state = makeState();
    state.config.models = { general: ["gpt-5.4"] };
    state.config.default = "general";

    // Same wiring as index.ts: lookupCache + touchCacheEntry over shared entries.
    let entries: CacheEntry[] = [];
    state.cacheEntries = entries as never;
    const pipeline = createPipeline({
      cacheLookup: (text) => {
        const entry = lookupCache(entries, text, DEFAULT_THRESHOLD);
        if (!entry) return undefined;
        touchCacheEntry(entry);
        return entry.category;
      },
      classifierModels: [],
      classifyWithLLM: async () => undefined,
      regexRules: [],
      defaultTier: "general",
      tiers: ["general"],
    });
    state.getPipeline = () => pipeline as never;
    const dispatch = createCommandRouter(state as never);

    const prompt = "review this authorization design";
    const [first] = await captureJsonReports(async () => {
      await dispatch(`preview --json ${prompt}`, ctx as never);
    }) as Array<Record<string, unknown>>;
    // Cold: nothing cached and no rule matches, so the default tier resolves.
    assert.equal(first.source, "fallback");

    // The turn handler's write path (index.ts), then preview the same prompt.
    entries = updateCache(entries, prompt, "general", 500);
    state.cacheEntries = entries as never;

    const [second] = await captureJsonReports(async () => {
      await dispatch(`preview --json ${prompt}`, ctx as never);
    }) as Array<Record<string, unknown>>;
    assert.equal(second.source, "cache");
    assert.equal(second.tier, "general");
  });

  it("still writes a [bifrost] progress line alongside the marker outside the TUI", async () => {
    // The guide no longer claims the marker line is the only stderr output, so
    // the distinguishing property is pinned: the marker and the plain
    // diagnostics are separate lines, each with its own prefix.
    const tui = makeCtx();
    const ctx = { ...(tui.ctx as unknown as Record<string, unknown>), mode: "print" } as never;
    const state = makeState();
    state.getPipeline = () => ({
      classify: async () => ({ kind: "fallback" as const, tier: "general" }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await dispatch("preview --json hello", ctx);
    } finally {
      console.error = original;
    }

    assert.equal(lines.filter((line) => line.startsWith(BIFROST_JSON_PREFIX)).length, 1);
    assert(
      lines.includes("[bifrost] Classifying preview prompt..."),
      `expected the non-TUI progress line, got:\n${lines.join("\n")}`,
    );
  });

  it("emits no marker line on the text path", async () => {
    const { ctx } = makeCtx();
    const dispatch = createCommandRouter(makeState() as never);
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await dispatch("preview", ctx as never);
    } finally {
      console.error = original;
    }

    assert.deepEqual(lines.filter((line) => line.startsWith(BIFROST_JSON_PREFIX)), []);
  });
});

describe("preview source values", () => {
  const docsRoot = new URL("../", import.meta.url);

  function sourceRow(): string {
    const doc = readFileSync(new URL("docs/guide/commands.md", docsRoot), "utf8");
    const row = doc.split("\n").find((line) => line.startsWith("| `source`"));
    assert(row, "docs/guide/commands.md must document a `source` row for the preview report");
    return row;
  }

  it("documents every reachable source value", () => {
    // The union is `ClassificationSource | "fallback"`. A consumer switching
    // exhaustively on `source` must not hit a value the guide never names, so
    // the guide row is pinned to the declared union rather than trusted.
    for (const value of ["cache", "classifier", "regex", "inline", "fallback"]) {
      assert.match(sourceRow(), new RegExp(`\`${value}\``), `source row must name \`${value}\``);
    }
  });

  it("rejects a source outside the union at compile time", () => {
    // Compile-time pin, verified by `npm run typecheck` (tests are in the
    // tsconfig include set). `@ts-expect-error` becomes an error of its own the
    // moment `source` widens back to `string`, which is how this pin detects
    // the regression it exists to prevent.
    // @ts-expect-error `source` is the pipeline union, not an arbitrary string.
    const bogus: BifrostPreviewSuccess["source"] = "guessed";
    assert.equal(bogus, "guessed");
  });

  it("accepts every union member on the report type", () => {
    const every: readonly BifrostPreviewSuccess["source"][] = ["cache", "classifier", "regex", "inline", "fallback"];
    assert.equal(every.length, 5);
  });
});

describe("preview json flag", () => {
  it("treats --json as a flag only in the first position", () => {
    assert.deepEqual(parsePreviewArgs("preview --json fix the bug", "preview"), { prompt: "fix the bug", json: true });
    assert.deepEqual(parsePreviewArgs("preview fix the bug", "preview"), { prompt: "fix the bug", json: false });
    assert.deepEqual(parsePreviewArgs("preview --json", "preview"), { prompt: "", json: true });
  });

  it("leaves a later --json inside the prompt text", () => {
    assert.deepEqual(parsePreviewArgs("preview explain the --json flag", "preview"), {
      prompt: "explain the --json flag",
      json: false,
    });
  });

  it("accepts any whitespace after the flag, not only one space", () => {
    assert.deepEqual(parsePreviewArgs("preview --json\tfix the bug", "preview"), { prompt: "fix the bug", json: true });
    assert.deepEqual(parsePreviewArgs("preview --json   fix the bug", "preview"), { prompt: "fix the bug", json: true });
    assert.deepEqual(parsePreviewArgs("preview --json\nfix the bug", "preview"), { prompt: "fix the bug", json: true });
  });

  it("does not treat a prompt glued to the flag as a flag", () => {
    assert.deepEqual(parsePreviewArgs("preview --jsonfix the bug", "preview"), { prompt: "--jsonfix the bug", json: false });
  });

  it("slices exactly the subcommand passed in, not a hardcoded length", () => {
    // `sub` is the precondition, so the slice follows it. This is the silent
    // truncation the review flagged: the old signature hardcoded 7 characters
    // regardless of what they were.
    assert.deepEqual(parsePreviewArgs("preview fix the bug", "bench"), { prompt: "ew fix the bug", json: false });
  });

  it("keeps the whole string when no subcommand prefix is claimed", () => {
    // The documented precondition: `args` still carries the subcommand. A caller
    // that passes an empty `sub` for a bare prompt loses nothing, which is what
    // the old hardcoded slice could not express — the whole string survives, so
    // `--json` is then the first token and parses as the flag.
    assert.deepEqual(parsePreviewArgs("fix the bug", ""), { prompt: "fix the bug", json: false });
    assert.deepEqual(parsePreviewArgs("--json fix the bug", ""), { prompt: "fix the bug", json: true });
  });

  it("drops the prefix when the caller claims one the args do not have", () => {
    // The hazard made explicit: claiming a prefix that is not there truncates.
    assert.deepEqual(parsePreviewArgs("--json fix the bug", "preview"), { prompt: "fix the bug", json: false });
  });

  it("accepts trace and json flags only as unique leading tokens", () => {
    assert.deepEqual(parsePreviewArgs("preview --trace --json fix the bug", "preview"), {
      prompt: "fix the bug", json: true, trace: true,
    });
    assert.deepEqual(parsePreviewArgs("preview --json --trace fix the bug", "preview"), {
      prompt: "fix the bug", json: true, trace: true,
    });
    assert.deepEqual(parsePreviewArgs("preview --trace explain the --json flag", "preview"), {
      prompt: "explain the --json flag", json: false, trace: true,
    });
    assert.deepEqual(parsePreviewArgs("preview --json --json explain", "preview"), {
      prompt: "--json explain", json: true,
    });
    assert.deepEqual(parsePreviewArgs("preview --trace --trace explain", "preview"), {
      prompt: "--trace explain", json: false, trace: true,
    });
  });
});

describe("preview route trace", () => {
  it("emits versioned content-free JSON and discloses classifier access", async () => {
    const model = makeModel("openai", "gpt-5.4");
    const { ctx } = makeCtx([model]);
    const state = makeState();
    state.config.models = { general: ["gpt-5.4"] };
    state.config.default = "general";
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "general", source: "regex" as const, classificationOutcome: "deadline" as const }),
    }) as never;
    const dispatch = createCommandRouter(state as never);
    const [trace] = await captureJsonReports(async () => {
      await dispatch("preview --trace --json private prompt words", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.equal(trace.version, 1);
    assert.equal(trace.kind, "route-decision");
    assert.equal(trace.outcome, "selected");
    assert.equal(trace.classificationOutcome, "deadline");
    assert.equal(trace.selected, "openai/gpt-5.4");
    assert.deepEqual(trace.classifierDisclosure, { enabled: true, configuredClassifierMayReceivePrompt: true });
    assert.equal(JSON.stringify(trace).includes("private prompt words"), false);
  });

  it("reports usage explicitly for a missing trace prompt", async () => {
    const { ctx } = makeCtx();
    const dispatch = createCommandRouter(makeState() as never);
    const [trace] = await captureJsonReports(async () => {
      await dispatch("preview --trace --json", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.equal(trace.outcome, "usage");
    assert.equal(trace.error, "usage");
  });

  it("does not select a random route twice to build the summary", async () => {
    const { ctx } = makeCtx([
      makeModel("fixture", "model-a"),
      makeModel("fixture", "model-b"),
    ]);
    const state = makeState();
    state.config.models = { quick: ["model"] };
    state.config.default = "quick";
    state.config.strategy = "random";
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "quick", source: "regex" as const }),
    }) as never;
    const dispatch = createCommandRouter(state as never);
    const originalRandom = Math.random;
    let calls = 0;
    Math.random = () => { calls++; return 0.5; };
    try {
      await captureJsonReports(async () => {
        await dispatch("preview --trace --json hello", ctx as never);
      });
    } finally {
      Math.random = originalRandom;
    }
    assert.equal(calls, 1);
  });
});

describe("command aliases", () => {
  it("declares init -f as an alias of init", () => {
    const init = BIFROST_COMMAND_OPTIONS.find((c) => c.value === "init");
    assert.deepEqual(init?.aliases, ["init -f"]);
  });

  it("dispatches init -f to init rather than the unknown-subcommand picker", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-f-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      // Fresh, therefore reusable probe data: plain `init` would reuse it and
      // never probe. Only `-f` forces a re-probe, so "Probing" proves both
      // that the alias matched and that the flag reached handleInit.
      writeFileSync(join(tempDir, ".pi", "bifrost-probe.json"), JSON.stringify([
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]));
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState();
      // handleInit's forced-probe branch calls applyOutcomes, which makeStore
      // does not provide. The only existing init test uses --write, which
      // returns before that branch, so nothing else ever reached it.
      state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
      await createCommandRouter(state as never)("init -f", ctx as never);
      assert.equal(calls.some((call) => call.kind === "select" && call.title === "Bifrost commands"), false);
      assert(calls.some((call) => call.kind === "notify" && String(call.value).startsWith("info:Probing")));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("no longer lists init -f as its own command", () => {
    assert.equal(
      BIFROST_COMMAND_OPTIONS.some((c) => c.value === "init -f"),
      false,
    );
  });

  it("offers init -f in completion", () => {
    // "init -" isolates the alias: it is the only entry that matches, so this
    // cannot pass by `init` merely prefix-matching. Under "ini" both entries
    // are returned and the assertion could not tell them apart.
    const items = getBifrostCommandCompletions("init -");
    assert.ok(items?.some((i) => i.value === "init -f" && i.label === "init -f"));
  });

  it("still emits init itself alongside its alias", () => {
    const items = getBifrostCommandCompletions("ini") ?? [];
    assert.ok(items.some((i) => i.value === "init" && i.label === "init"));
    assert.ok(items.some((i) => i.value === "init -f"));
  });

  it("submits an exact alias instead of offering a completion", () => {
    assert.equal(getBifrostCommandCompletions("init -f"), null);
  });
});

describe("route dispatch", () => {
  // Config, probe, and cache paths all resolve against process.cwd(), and
  // several of these routes write: cache clear truncates the cache file, probe
  // and init overwrite .pi/bifrost-probe.json. Dispatching them in the repo
  // would damage real developer state, so they run in a temp directory.
  async function inTempDir<T>(fn: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-route-"));
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("routes on to the enabled state", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.enabled = false;
    await createCommandRouter(state as never)("on", ctx as never);
    assert.equal(state.enabled, true);
  });

  it("routes off to the disabled state", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.enabled = true;
    await createCommandRouter(state as never)("off", ctx as never);
    assert.equal(state.enabled, false);
  });

  it("routes pin and unpin", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("pin", ctx as never);
    assert.equal(state.pinned, true);
    await createCommandRouter(state as never)("unpin", ctx as never);
    assert.equal(state.pinned, false);
  });

  it("routes classifier on and off", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.classifierEnabled = false;
    await createCommandRouter(state as never)("classifier on", ctx as never);
    assert.equal(state.classifierEnabled, true);
    await createCommandRouter(state as never)("classifier off", ctx as never);
    assert.equal(state.classifierEnabled, false);
  });

  // log() reaches the fake as ctx.ui.notify, recorded as kind "notify" with
  // value "<type>:<message>".
  it("routes cache stats to its own handler", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await inTempDir(async () => {
      await createCommandRouter(state as never)("cache stats", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("cache:")));
  });

  it("routes cache clear to its own handler", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await inTempDir(async () => {
      await createCommandRouter(state as never)("cache clear", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("cache cleared")));
  });

  // debug uses uiOutput, which reaches the fake as ctx.ui.setWidget and is
  // recorded as kind "widget" with the lines array.
  it("routes debug to its own handler", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("debug", ctx as never);
    assert.ok(calls.some((c) => c.kind === "widget" && (c.lines ?? []).includes("--- config ---")));
  });

  // Each assertion below distinguishes the routed command from fallthrough:
  // if a route is deleted the command misses every route, opens the picker,
  // and lands on some other handler. So an assertion that merely checks "a
  // widget or notify happened" proves nothing, and cannot tell correct
  // routing from no routing at all.

  it("routes reload", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.pinned = true;
    await inTempDir(async () => {
      await createCommandRouter(state as never)("reload", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("Bifrost config reloaded")));
    assert.equal(state.pinned, true, "reload must preserve the session-local pin");
  });

  it("prepares v2 from unversioned explicit v1 config and preserves existing data", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    Object.assign(state.config, { reliability: { enabled: true, stateVersion: 1 } });
    Object.assign(state, { reliabilityV2ConfigValid: true });
    await inTempDir(async () => {
      const sourcePath = reliabilityPath(process.cwd());
      state.reliabilityStore = { ...makeStore(), path: sourcePath } as never;
      mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
      const sourceBytes = Buffer.from(JSON.stringify({ version: 1, models: { "fixture/model": { failures: [Date.now() - 1000] } } }));
      writeFileSync(sourcePath, sourceBytes);

      await createCommandRouter(state as never)("reliability migrate --fresh", ctx as never);
      assert.equal(existsSync(reliabilityV2Path(process.cwd())), false);
      assert.ok(calls.some((call) => String(call.value).includes("--fresh is allowed only when no v1 reliability file exists")));

      await createCommandRouter(state as never)("reliability migrate", ctx as never);
      const sidecarPath = reliabilityV2Path(process.cwd());
      assert.equal(existsSync(sidecarPath), true);
      assert.deepEqual(readFileSync(join(process.cwd(), ".pi", "bifrost-reliability-v1.json.backup")), sourceBytes);
      const seeded = readFileSync(sidecarPath);

      rmSync(sourcePath);
      await createCommandRouter(state as never)("reliability migrate", ctx as never);
      assert.deepEqual(readFileSync(sidecarPath), seeded);
      assert.ok(calls.some((call) => String(call.value).includes("sidecar already exists and was left unchanged")));
    });
  });

  it("rejects an invalid tier policy reload and retains the last-good routing state", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.tierPolicyValid = true;
    const lastGoodConfig = state.config;
    let invalidations = 0;
    state.invalidatePipeline = () => { invalidations++; };
    await inTempDir(async () => {
      writeFileSync("bifrost.json", JSON.stringify({
        schemaVersion: 2,
        default: "general",
        models: { general: ["fixture/model"] },
        tierPolicies: { general: { fallbackTiers: ["missing"] } },
      }));
      await createCommandRouter(state as never)("reload", ctx as never);
    });
    assert.equal(state.config, lastGoodConfig);
    assert.equal(state.tierPolicyValid, true);
    assert.equal(invalidations, 0);
    assert.ok(calls.some((call) => String(call.value).includes("reload rejected") && String(call.value).includes("missing")));
  });

  it("rejects invalid economic policy on reload without replacing the last-good snapshot", async () => {
    const { ctx, calls } = makeCtx();
    const state = Object.assign(makeState(), {
      economicPolicyValid: true,
      economicPolicy: { mode: "observe", sources: [], admission: [] },
      economicSnapshot: { revision: 7, signals: [], watermarks: [] },
    });
    const lastGoodConfig = state.config;
    const lastGoodPolicy = state.economicPolicy;
    const lastGoodSnapshot = state.economicSnapshot;
    let invalidations = 0;
    state.invalidatePipeline = () => { invalidations++; };
    await inTempDir(async () => {
      writeFileSync("bifrost.json", JSON.stringify({
        schemaVersion: 2,
        default: "general",
        models: { general: ["fixture/model"] },
        economics: {
          mode: "observe",
          scopes: { local: { kind: "model", model: "fixture/model" } },
          sources: [{ id: "manual", scopeRef: "local", authority: "declared" }],
          admission: [],
          observations: [],
          preference: { billingClass: "PRIVATE_INVALID_CLASS", privateExtra: "PRIVATE_VALUE" },
        },
      }));
      await createCommandRouter(state as never)("reload", ctx as never);
    });
    assert.equal(state.config, lastGoodConfig);
    assert.equal(state.economicPolicy, lastGoodPolicy);
    assert.equal(state.economicSnapshot, lastGoodSnapshot);
    assert.equal(state.economicPolicyValid, true);
    assert.equal(invalidations, 0);
    const rejection = calls.find((call) => String(call.value).includes("reload rejected"));
    assert.ok(rejection);
    assert.doesNotMatch(String(rejection.value), /PRIVATE_INVALID_CLASS|PRIVATE_VALUE/);
  });

  it("rejects an invalid classifier total budget reload without exposing its raw value", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const lastGoodConfig = state.config;
    let invalidations = 0;
    state.invalidatePipeline = () => { invalidations++; };
    await inTempDir(async () => {
      writeFileSync("bifrost.json", JSON.stringify({
        default: "general",
        models: { general: ["fixture/model"] },
        classifier: { backend: "prompt", totalTimeoutMs: "PRIVATE_TIMEOUT_VALUE" },
      }));
      await createCommandRouter(state as never)("reload", ctx as never);
    });
    assert.equal(state.config, lastGoodConfig);
    assert.equal(invalidations, 0);
    const rejection = calls.find((call) => String(call.value).includes("reload rejected"));
    assert.ok(rejection);
    assert.doesNotMatch(String(rejection.value), /PRIVATE_TIMEOUT_VALUE/);
  });

  it("retains an active strict config when a reload source is corrupt or has a non-object root", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    Object.assign(state.config, {
      schemaVersion: 2,
      default: "general",
      models: { restricted: ["fixture/missing"], general: ["fixture/default"] },
      tierPolicies: { restricted: { fallbackTiers: [] } },
    });
    state.tierPolicyValid = true;
    const lastGoodConfig = state.config;
    const dispatch = createCommandRouter(state as never);
    await inTempDir(async () => {
      for (const [source, expected] of [["{ broken", "not valid JSON"], ["null", "must contain an object"]] as const) {
        writeFileSync("bifrost.json", source);
        await dispatch("reload", ctx as never);
        assert.equal(state.config, lastGoodConfig);
        assert.equal(state.tierPolicyValid, true);
        assert.ok(calls.some((call) => String(call.value).includes("reload rejected") && String(call.value).includes(expected)));
      }
    });
  });

  it("routes providers", async () => {
    const { ctx, calls } = makeCtx([
      { provider: "fixture", id: "chat" },
      { provider: "fixture", id: "reason" },
    ]);
    const state = makeState();
    await createCommandRouter(state as never)("providers", ctx as never);
    const lines = calls.filter((c) => c.kind === "widget").flatMap((c) => c.lines ?? []);
    assert.ok(lines.includes("available providers:"));
    assert.ok(lines.includes("  fixture: 2 model(s)"));
  });

  it("routes probe", async () => {
    const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
    const state = makeState();
    // runProbe records outcomes on the reliability store; makeStore omits it.
    state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
    // No model carries an api, so probeOne returns "skipped" without any
    // network call. runProbe still writes .pi/bifrost-probe.json, so dispatch
    // from a temp dir rather than over the repo's real probe data.
    await inTempDir(async () => {
      await createCommandRouter(state as never)("probe", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).startsWith("info:Probing 1 model(s)")));
    const lines = calls.filter((c) => c.kind === "widget").flatMap((c) => c.lines ?? []);
    assert.ok(lines.includes("--- probe results (1 models) ---"));
  });

  it("routes benchmark", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    // makeState configures no tiers, so handleBenchmark reports that and
    // returns before reaching the classification pipeline.
    await createCommandRouter(state as never)("benchmark fix the build", ctx as never);
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("no categories configured")));
  });

  it("routes preview", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    // Bare "preview" with no prompt: only reachable if the prefix route
    // matches the word alone.
    await createCommandRouter(state as never)("preview", ctx as never);
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("usage: /bifrost preview <prompt>")));
  });

  it("dispatches previewXYZ to preview, which a space-bounded matcher would not", async () => {
    // prefix() is bare startsWith on purpose: "/bifrost previewXYZ" previews
    // prompt "XYZ". Requiring a space boundary would send it to the picker.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("previewXYZ", ctx as never);
    // The slice leaves "XYZ", so handlePreview classifies it rather than
    // printing usage text. The fake pipeline returns "unclassified".
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("no tier matched")));
    assert.ok(calls.some((c) => c.kind === "status" && String(c.value).includes("previewing prompt")));
    assert.equal(calls.some((c) => c.kind === "select"), false);
  });

  it("routes init", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
    // Empty temp dir means no cached probe, so handleInit probes inline. Its
    // wording ("to find working ones") is distinct from the probe route's
    // ("model(s) with"), so this cannot be satisfied by that route.
    await inTempDir(async () => {
      await createCommandRouter(state as never)("init", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("Probing 0 models to find working ones")));
  });

  it("opens the picker for initialize rather than running init", async () => {
    // Temp dir because the regression this guards sends "initialize" to
    // handleInit, which probes and writes .pi/bifrost-probe.json into the
    // working directory. A failing run must not damage real probe data.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await inTempDir(async () => {
      await createCommandRouter(state as never)("initialize", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "select"));
  });

  it("does not let prefix() swallow initialize either", async () => {
    // Guards against someone converting init to the bare-startsWith helper.
    // Same temp-dir reason as the guard above: under that regression
    // "initfoo" reaches handleInit and rewrites the repo's probe file.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await inTempDir(async () => {
      await createCommandRouter(state as never)("initfoo", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "select"));
  });
});

describe("dashboard menu", () => {
  // The dashboard is derived from BIFROST_COMMAND_OPTIONS, so it holds every
  // registered command: a command added to the registry appears in /bifrost
  // with no second edit. On top of that, ordering stays state-aware so the top
  // row always changes something.

  function rowsOf(calls: Array<{ kind: string; options?: string[] }>): string[] {
    return calls.find((call) => call.kind === "select")?.options ?? [];
  }

  async function rowsFor(overrides: { enabled?: boolean; pinned?: boolean } = {}): Promise<string[]> {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.enabled = overrides.enabled ?? true;
    state.pinned = overrides.pinned ?? false;
    await createCommandRouter(state as never)("", ctx as never);
    return rowsOf(calls);
  }

  function rowAt(rows: string[], value: string): number {
    return rows.findIndex((row) => row.startsWith(`/bifrost ${value} `));
  }

  it("offers every registered command exactly once", async () => {
    const rows = await rowsFor();
    // Parsed rather than prefix-matched: "/bifrost classifier " also prefixes
    // "classifier on" and friends.
    const commandOf = (row: string): string => {
      const match = /^\/bifrost (.+?) — /.exec(row);
      assert.ok(match, `unparseable row: ${row}`);
      // The hint grammar is `[optional-flag] <prompt>`: one or more bracketed
      // flag segments followed by one or more angle-bracketed operands. The
      // value is whatever precedes the first hint token, so any number of flags
      // or operands parses here without another edit - `[--json] [--tier]
      // <prompt>` needs no special case. The discarded tail is shape-checked so
      // a hint this parser does not understand fails loudly here rather than
      // silently yielding a value that is not in the registry.
      const head = match[1];
      const hintAt = head.search(/[[<]/);
      const command = hintAt === -1 ? head : head.slice(0, hintAt).trimEnd();
      assert.ok(command.length > 0, `no command value in row: ${row}`);
      if (hintAt !== -1) {
        assert.match(head.slice(hintAt), /^(?:\[[^\]]*\] ?|<[^>]*> ?)+$/, `malformed hint: ${row}`);
      }
      return command;
    };
    const rendered = rows.map(commandOf);
    const registered = BIFROST_COMMAND_OPTIONS.map((command) => command.value);
    // Same multiset, so no command is hidden and none is repeated.
    assert.equal(rendered.length, registered.length);
    assert.deepEqual([...rendered].sort(), [...registered].sort());
  });

  it("renders each command's registry argumentHint into its row", async () => {
    // The hint travels registry -> row, so `[--json]` is advertised by editing
    // the one registry entry rather than by editing the menu. The test above
    // checks membership and ignores hints entirely, so without this a hint that
    // the renderer silently dropped would go unnoticed.
    //
    // Scoped to the menu hint, deliberately not to completion items: completion
    // labels carry value/label/description only, never the argument hint, and
    // the test "keeps the preview completion label and description stable" pins
    // that split on purpose. Asserting menu and completion agree on the hint
    // would contradict that decision rather than guard it.
    const rows = await rowsFor();
    for (const command of BIFROST_COMMAND_OPTIONS) {
      const spec = command as { value: string; argumentHint?: string };
      const opening = spec.argumentHint ? ` ${spec.argumentHint} — ` : " — ";
      assert.ok(
        rows.some((row) => row.startsWith(`/bifrost ${spec.value}${opening}`)),
        `no row renders "/bifrost ${spec.value}${opening}": ${JSON.stringify(rows)}`,
      );
    }
  });

  it("shows a registry entry that declares neither menu nor reflects", async () => {
    // The auto-add guarantee, stated as a test: menu and reflects order a
    // command, they never hide one. Without this, the previous behaviour
    // (hand-written row list) and this behaviour both pass every other test
    // here.
    const registry = BIFROST_COMMAND_OPTIONS as unknown as Array<{ value: string; description: string }>;
    registry.push({ value: "probe entry", description: "Temporary probe" });
    try {
      const rows = await rowsFor();
      assert.ok(rows.some((row) => row.includes("/bifrost probe entry — Temporary probe")));
      assert.equal(rows.length, BIFROST_COMMAND_OPTIONS.length);
    } finally {
      // Load-bearing: BIFROST_COMMAND_OPTIONS is module-level shared state.
      // Without this restore a failing assertion corrupts the registry for
      // every test that runs afterwards.
      registry.pop();
    }
  });

  it("offers 22 rows", async () => {
    assert.equal((await rowsFor()).length, 22);
  });

  it("keeps the top row actionable in every state combination", async () => {
    for (const enabled of [true, false]) {
      for (const pinned of [true, false]) {
        const rows = await rowsFor({ enabled, pinned });
        const expected = enabled ? "/bifrost off —" : "/bifrost on —";
        assert.ok(rows[0]?.startsWith(expected), `enabled=${enabled} pinned=${pinned}: ${rows[0]}`);
        assert.ok(!rows[0]?.includes("already"), `row 1 must not be annotated: ${rows[0]}`);
      }
    }
  });

  it("marks the already-satisfied member of each pair, leaving the actionable one bare", async () => {
    const off = await rowsFor({ enabled: false, pinned: false });
    assert.deepEqual(
      off.filter((row) => row.startsWith("/bifrost on ") || row.startsWith("/bifrost off ")),
      ["/bifrost on — Enable routing", "/bifrost off — Disable routing (already off)"],
    );
    assert.deepEqual(
      off.filter((row) => row.startsWith("/bifrost pin ") || row.startsWith("/bifrost unpin ")),
      ["/bifrost pin — Lock current model", "/bifrost unpin — Resume routing (already unpinned)"],
    );

    const on = await rowsFor({ enabled: true, pinned: true });
    assert.deepEqual(
      on.filter((row) => row.startsWith("/bifrost on ") || row.startsWith("/bifrost off ")),
      ["/bifrost off — Disable routing", "/bifrost on — Enable routing (already on)"],
    );
    assert.deepEqual(
      on.filter((row) => row.startsWith("/bifrost pin ") || row.startsWith("/bifrost unpin ")),
      ["/bifrost unpin — Resume routing", "/bifrost pin — Lock current model (already pinned)"],
    );
  });

  it("places and annotates a reflected entry declared only in the registry", async () => {
    // Which way a command pushes its state lives on its registry entry, so a
    // new reflected command costs one edit. When that direction lived in a
    // side table keyed by value, an entry the table did not list silently lost
    // both its leading row and its annotation - nothing failed, the ordering
    // was just wrong.
    const registry = BIFROST_COMMAND_OPTIONS as unknown as Array<Record<string, unknown>>;
    registry.unshift({
      value: "probe mute",
      description: "Temporary probe",
      reflects: { state: "enabled", sets: false, note: "already off" },
    });
    try {
      // Routing is on, so a command that turns routing off changes something
      // and leads. Unshifted, it also precedes the registry's own member.
      const actionable = await rowsFor({ enabled: true, pinned: false });
      assert.equal(actionable[0], "/bifrost probe mute — Temporary probe");

      // Routing is off, so it is the no-op member: second, and annotated.
      const inert = await rowsFor({ enabled: false, pinned: false });
      assert.equal(inert[1], "/bifrost probe mute — Temporary probe (already off)");
    } finally {
      // Load-bearing: BIFROST_COMMAND_OPTIONS is module-level shared state.
      // Without this restore a failing assertion corrupts the registry for
      // every test that runs afterwards.
      registry.shift();
    }
  });

  it("keeps the prompt commands together in the common block", async () => {
    const rows = await rowsFor();
    assert.deepEqual(rows.slice(4, 11), [
      "/bifrost preview [--trace] [--json] <prompt> — Preview routing for a prompt",
      "/bifrost benchmark <prompt> — Classify a benchmark prompt",
      "/bifrost providers — List available providers",
      "/bifrost probe — Probe working models",
      "/bifrost init — Probe models and generate config (pass -f to force re-probe)",
      "/bifrost classifier status — Show classifier state",
      "/bifrost reload — Reload config after editing",
    ]);
    // Adjacency is the point: both take a prompt and prefill the editor, so
    // they must not be separated by a command that runs instead.
    assert.equal(rowAt(rows, "benchmark") - rowAt(rows, "preview"), 1);
  });

  it("renders no two identical rows", async () => {
    // pickBifrostCommand resolves the user's choice by rendered text, so a
    // duplicated row would run whichever command matches first.
    const rows = await rowsFor();
    assert.equal(new Set(rows).size, rows.length);
  });

  it("orders reflected rows first, then common rows, then the rest", async () => {
    const rows = await rowsFor({ enabled: true, pinned: false });
    assert.ok(rowAt(rows, "on") < rowAt(rows, "pin"), "reflected groups follow registry order");
    assert.ok(rowAt(rows, "unpin") < rowAt(rows, "reload"), "reflected rows precede common rows");
    assert.ok(rowAt(rows, "reload") < rowAt(rows, "cache stats"), "common rows precede the tail");
  });

  it("includes preview so the menu keeps prefilling it", async () => {
    // preview carries an argumentHint, so selecting its row must still
    // prefill the editor rather than run a handler.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("", ctx as never);
    const rows = rowsOf(calls);
    assert.ok(rows.some((row) => row.includes("/bifrost preview [--trace] [--json] <prompt>")));
  });

  it("cannot go stale when a command is renamed in the registry", async () => {
    // The dashboard used to list command values by hand, so renaming one left
    // the menu pointing at a value that no longer existed and the picker threw
    // a TypeError. Deriving from the registry removes that class of drift:
    // the rename shows up in the menu.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const original = BIFROST_COMMAND_OPTIONS[0];
    assert.equal(original.value, "on");
    (BIFROST_COMMAND_OPTIONS as unknown as Array<{ value: string; description: string }>)[0] = {
      ...original,
      value: "renamed",
    };
    try {
      await createCommandRouter(state as never)("", ctx as never);
      const rows = rowsOf(calls);
      assert.ok(rows.some((row) => row.includes("/bifrost renamed —")));
      assert.ok(!rows.some((row) => row.includes("/bifrost on —")));
    } finally {
      // Load-bearing: BIFROST_COMMAND_OPTIONS is module-level shared state.
      // Without this restore a failing assertion corrupts the registry for
      // every test that runs afterwards.
      (BIFROST_COMMAND_OPTIONS as unknown as Array<{ value: string; description: string }>)[0] = original;
    }
  });
});

describe("diagnostics commands", () => {
  function diagnosticHarness() {
    const model = makeModel("fixture", "known");
    const { ctx, calls } = makeCtx([model]);
    const context = ctx as unknown as { modelRegistry: Record<string, (...args: unknown[]) => unknown> };
    let registryReads = 0;
    let networkCalls = 0;
    Object.assign(context.modelRegistry, {
      getAll: () => { registryReads += 1; return [model]; },
      getAvailable: () => { registryReads += 1; return [model]; },
      find: () => model,
      getProviderAuthStatus: () => ({ configured: true, source: "PRIVATE_AUTH_SENTINEL", label: "PRIVATE_LABEL_SENTINEL" }),
      refresh: async () => { networkCalls += 1; throw new Error("refresh forbidden"); },
      classify: async () => { networkCalls += 1; throw new Error("classification forbidden"); },
    });
    const reliability = { version: 1 as const, models: { "fixture/known": { failures: [10], openUntil: Date.now() + 60_000 } } };
    let writes = 0;
    const state = makeState() as ReturnType<typeof makeState> & { lastRegistryRefreshAt?: number };
    state.config.models = { general: ["fixture/known"] };
    state.reliabilityStore = {
      getState: () => reliability,
      openCircuitCount: () => 1,
      reload: () => { writes += 1; },
      recordFailure: () => { writes += 1; },
      recordSuccess: () => { writes += 1; },
      applyOutcomes: () => { writes += 1; },
    } as never;
    state.getPipeline = () => ({ classify: async () => { networkCalls += 1; throw new Error("pipeline forbidden"); } }) as never;
    state.lastRegistryRefreshAt = 1000;
    return { state, context, calls, reliability, counters: () => ({ registryReads, networkCalls, writes }) };
  }

  async function withStubs(run: () => Promise<void>): Promise<string[]> {
    const oldRandom = Math.random;
    const oldError = console.error;
    const lines: string[] = [];
    Math.random = () => { throw new Error("random forbidden"); };
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try { await run(); } finally { Math.random = oldRandom; console.error = oldError; }
    return lines;
  }

  it("registers validate and inspect with JSON argument hints", () => {
    for (const command of ["validate", "inspect"]) {
      const spec = BIFROST_COMMAND_OPTIONS.find((item) => item.value === command);
      assert.equal(spec?.argumentHint, "[--json]");
      assert.equal(getBifrostCommandCompletions(command), null, "complete command submits without a suggestion");
      assert.ok(getBifrostCommandCompletions(command.slice(0, 1))?.some((item) => item.value === command));
    }
  });

  it("emits versioned validate JSON from the loaded config without private auth details", async () => {
    const h = diagnosticHarness();
    const before = JSON.stringify(h.reliability);
    const lines = await withStubs(() => createCommandRouter(h.state as never)("validate --json", h.context as never));
    const reports = lines.filter((line) => line.startsWith(BIFROST_JSON_PREFIX));
    assert.equal(reports.length, 1);
    const report = JSON.parse(reports[0]!.slice(BIFROST_JSON_PREFIX.length));
    assert.deepEqual({ version: report.version, kind: report.kind, configSource: report.configSource }, {
      version: 1, kind: "validation", configSource: "loaded-effective-config",
    });
    assert.equal(JSON.stringify(report).includes("PRIVATE_AUTH_SENTINEL"), false);
    assert.equal(JSON.stringify(report).includes("PRIVATE_LABEL_SENTINEL"), false);
    assert.equal(JSON.stringify(h.reliability), before);
    assert.deepEqual(h.counters(), { registryReads: 1, networkCalls: 0, writes: 0 });
  });

  it("emits a local inspect snapshot without refreshing, classifying, randomness, or writes", async () => {
    const h = diagnosticHarness();
    const before = JSON.stringify(h.reliability);
    const lines = await withStubs(() => createCommandRouter(h.state as never)("inspect --json", h.context as never));
    const report = JSON.parse(lines.find((line) => line.startsWith(BIFROST_JSON_PREFIX))!.slice(BIFROST_JSON_PREFIX.length));
    assert.equal(report.kind, "inspection");
    assert.equal(report.registry.knownModelCount, 1);
    assert.equal(report.registry.availableModelCount, 1);
    assert.equal(report.registry.bifrostLastRefreshAgeMs >= 0, true);
    assert.deepEqual(report.reliabilityPolicy, { enabled: true, cooldownOnAllowanceExhausted: true });
    assert.deepEqual(report.tiers[0].candidates[0], {
      model: "fixture/known", available: true, auth: "configured", circuit: "open", openUntil: h.reliability.models["fixture/known"].openUntil,
    });
    assert.equal(JSON.stringify(report).includes("PRIVATE_AUTH_SENTINEL"), false);
    assert.equal(JSON.stringify(report).includes("PRIVATE_LABEL_SENTINEL"), false);
    assert.equal(JSON.stringify(h.reliability), before);
    assert.deepEqual(h.counters(), { registryReads: 2, networkCalls: 0, writes: 0 });
  });

  it("adds reserve freshness to inspect without exposing allowance values", async () => {
    const h = diagnosticHarness();
    const now = Date.now();
    const state = h.state as unknown as {
      config: { economics?: unknown };
      economicPolicy: unknown;
      economicPolicyValid: boolean;
      economicSnapshot: unknown;
    };
    state.config.economics = {
      mode: "observe",
      scopes: { local: { kind: "provider", provider: "fixture" } },
      sources: [{ id: "manual-estimate", scopeRef: "local", authority: "estimated" }],
      admission: [{ id: "reserve", scopeRef: "local", windowId: "monthly", reserveRatio: 0.2, unknown: "ignore" }],
    };
    state.economicPolicyValid = true;
    state.economicPolicy = {
      mode: "observe",
      scopes: { local: { kind: "provider", provider: "fixture" } },
      sources: [{ id: "manual-estimate", scopeRef: "local", authority: "estimated" }],
      admission: [{ id: "reserve", scopeRef: "local", windowId: "monthly", reserveRatio: 0.2, unknown: "ignore" }],
    };
    state.economicSnapshot = {
      revision: 1,
      signals: [{ sourceId: "manual-estimate", scopeRef: "local", billing: "metered", observedAt: now - 10, expiresAt: now + 10000, revision: 1,
        windows: [
          { id: "weekly", period: { id: "week-7", sequence: 7 }, unit: "ratio", remaining: 0.1, resetsAt: now - 1 },
          { id: "monthly", period: { id: "month-2", sequence: 2 }, unit: "ratio", remaining: 0.8, resetsAt: now + 10000 },
        ] }],
      watermarks: [],
    };
    const lines = await withStubs(() => createCommandRouter(h.state as never)("inspect --json", h.context as never));
    const report = JSON.parse(lines.find((line) => line.startsWith(BIFROST_JSON_PREFIX))!.slice(BIFROST_JSON_PREFIX.length));
    assert.equal(report.economics.mode, "observe");
    assert.deepEqual(report.economics.sources[0], {
      source: "manual-estimate", scope: "local", authority: "estimated", freshness: "current",
      observedAgeMs: report.economics.sources[0].observedAgeMs, periods: [
        { window: "weekly", period: "week-7", unit: "ratio", applicability: "reset" },
        { window: "monthly", period: "month-2", unit: "ratio", applicability: "current" },
      ],
    });
    assert.doesNotMatch(JSON.stringify(report), /"remaining"\s*:/);
    (h.context as unknown as { mode: string }).mode = "cli";
    const text = (await withStubs(() => createCommandRouter(h.state as never)("inspect", h.context as never))).join("\n");
    assert.match(text, /reserve policy: observe/);
    assert.match(text, /source=manual-estimate scope=local authority=estimated freshness=current/);
    assert.match(text, /weekly:week-7\(reset\), monthly:month-2\(current\)/);
    assert.doesNotMatch(text, /\b(?:0\.1|0\.8)\b/);
  });

  it("renders text labels for loaded config and local last-refresh age", async () => {
    const h = diagnosticHarness();
    (h.context as unknown as { mode: string }).mode = "cli";
    const output = (await withStubs(async () => {
      const dispatch = createCommandRouter(h.state as never);
      await dispatch("validate", h.context as never);
      await dispatch("inspect", h.context as never);
    })).join("\n");
    assert.match(output, /loaded effective config \(run \/bifrost reload after editing files\)/);
    assert.match(output, /Bifrost last registry refresh age:/);
    assert.match(output, /allowance cooldown=on \(model-only\)/);
    assert.doesNotMatch(output, /provider data freshness/i);
    assert.doesNotMatch(output, /PRIVATE_(?:AUTH|LABEL)_SENTINEL/);
  });

  it("shows a sanitized strict-config field path in text validation output", async () => {
    const h = diagnosticHarness();
    const config = h.state.config as unknown as { schemaVersion?: number; tierPolicies?: unknown };
    config.schemaVersion = 2;
    config.tierPolicies = { general: { fallbackTiers: ["PRIVATE_BAD_FALLBACK"] } };
    (h.context as unknown as { mode: string }).mode = "cli";
    const output = (await withStubs(() => createCommandRouter(h.state as never)("validate", h.context as never))).join("\n");
    assert.match(output, /config\.tier_policy_unknown_fallback \(path=tierPolicies\.\*\.fallbackTiers\)/);
    assert.doesNotMatch(output, /PRIVATE_BAD_FALLBACK/);
  });

  it("renders an unusable circuit timestamp safely", async () => {
    const h = diagnosticHarness();
    h.reliability.models["fixture/known"].openUntil = Number.MAX_VALUE;
    (h.context as unknown as { mode: string }).mode = "cli";
    const output = (await withStubs(() => createCommandRouter(h.state as never)("inspect", h.context as never))).join("\n");
    assert.match(output, /until unknown/);
  });

  it("rejects extra flags without inspecting", async () => {
    const h = diagnosticHarness();
    const lines = await withStubs(() => createCommandRouter(h.state as never)("inspect --json extra", h.context as never));
    assert.ok(h.calls.some((call) => call.kind === "notify" && String(call.value).includes("usage: /bifrost inspect [--json]")));
    assert.equal(lines.some((line) => line.startsWith(BIFROST_JSON_PREFIX)), false);
    assert.deepEqual(h.counters(), { registryReads: 0, networkCalls: 0, writes: 0 });
  });
});
