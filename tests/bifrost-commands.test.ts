import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIFROST_JSON_PREFIX, buildClassifierTestReport, buildPreviewFailure, buildPreviewReport, createCommandRouter, getBifrostCommandCompletions, log, nextClassifierConfig, parsePreviewArgs, renderPreviewReport, runBifrostCommand, serializePreviewReport, type BifrostPreviewSuccess } from "../commands.ts";
import { makeModel, makePiClassifierModel, makeRegistry } from "./helpers.ts";
import { createPipeline } from "../classification-pipeline.ts";
import { DEFAULT_THRESHOLD, lookupCache, touchCacheEntry, updateCache, type CacheEntry } from "../cache.ts";

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
      reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
    },
    enabled: true,
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
    assert.equal(select?.options?.length, 8);
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
    const state = makeState();
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
      rows.includes("/bifrost preview [--json] <prompt> — Preview routing for a prompt"),
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
});
