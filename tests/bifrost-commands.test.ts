import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHost, _hostDeps, _resetHostForTests } from "../host.ts";
import { probeResultsPath } from "../probe.ts";
import { cachePath } from "../cache.ts";
import { _selectorDeps, buildClassifierTestReport, createCommandRouter, getBifrostCommandCompletions, log, runBifrostCommand } from "../commands.ts";

interface FixtureModel {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  cost?: { input: number; output: number };
  contextWindow?: number;
}

interface FixtureCall {
  kind: string;
  value?: unknown;
  title?: string;
  options?: string[];
  lines?: string[];
}

function makeCtx(
  models: FixtureModel[] = [],
  selectOverride?: (title: string, options: string[]) => string | undefined,
  customOverride?: () => Promise<unknown>,
  registryOverrides: Record<string, unknown> = {},
  cwd = process.cwd(),
) {
  const calls: FixtureCall[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: {
      theme: { fg: (_: string, text: string) => text },
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
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setEditorText: (value: string) => calls.push({ kind: "editor", value }),
      setWorkingIndicator: () => {},
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async (factory: (tui: unknown, theme: { fg: (color: string, text: string) => string }, keybindings: unknown, done: (value: void) => void) => unknown) => {
        calls.push({ kind: "custom" });
        if (customOverride) return customOverride();
        const component = factory(
          { requestRender: () => {} },
          { fg: (_color: string, text: string) => text },
          {},
          () => {},
        ) as { render(width: number): string[] };
        calls.push({ kind: "render", lines: component.render(120) });
        return undefined;
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
      refresh: async () => {},
      ...registryOverrides,
    },
    scopedModels: [],
  };
  return { ctx: ctx as never, calls };
}

function makeStore(reliabilityState?: Record<string, { failures: number[]; openUntil?: number }>, enabled = true) {
  return {
    getState: () => ({ version: 1 as const, models: reliabilityState ?? {} }),
    openCircuitCount: (now?: number) => {
      if (!enabled) return 0;
      const t = now ?? Date.now();
      return Object.entries(reliabilityState ?? {}).filter(([, reliability]) => reliability.openUntil && reliability.openUntil > t).length;
    },
    applyOutcomes: () => {},
    reload: () => {},
  };
}

function makeState(saveModeState: () => void = () => {}) {
  return {
    config: {
      models: {},
      reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
      cache: {} as { ttlHours?: number },
      probe: {} as { timeoutMs?: number },
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
    getPipeline: () => ({ classify: async () => ({ kind: "unclassified" as const }) }),
    invalidatePipeline: () => {},
    saveModeState,
  };
}

function outputLines(calls: FixtureCall[]) {
  return calls.find((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-output:"))?.lines ?? [];
}

describe("bifrost command ui", () => {
  it("renders TUI log messages once without duplicating them to stderr", () => {
    const { ctx, calls } = makeCtx();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      log(ctx, "Bifrost config reloaded");
    } finally {
      console.error = original;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(calls.filter((call) => call.kind === "notify").map((call) => call.value), ["info:Bifrost config reloaded"]);
  });

  it("surfaces command descriptions in autocomplete", () => {
    const items = getBifrostCommandCompletions("class") ?? [];
    assert(items.some((item) => item.value === "classifier status" && item.description === "Show classifier state"));
  });

  it("submits exact commands without requiring a second Enter", () => {
    assert.equal(getBifrostCommandCompletions("classifier status"), null);
    assert.equal(getBifrostCommandCompletions("classifier"), null);
  });

  it("offers both init force spellings", () => {
    const short = getBifrostCommandCompletions("init -") ?? [];
    const long = getBifrostCommandCompletions("init --f") ?? [];
    assert(short.some((item) => item.value === "init -f"));
    assert(long.some((item) => item.value === "init --force"));
  });

  it("clears submitted text before dispatch while preserving follow-up prefills", async () => {
    const { ctx, calls } = makeCtx();
    await runBifrostCommand("preview", ctx, async (_args, commandCtx) => {
      commandCtx.ui.setEditorText("/bifrost preview ");
    });
    assert.deepEqual(calls.filter((call) => call.kind === "editor").map((call) => call.value), ["", "/bifrost preview "]);
  });

  it("opens dashboard for root command", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const dispatch = createCommandRouter(state as never);
    await dispatch("", ctx);
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
    await dispatch("off", ctx);
    await dispatch("pin", ctx);
    await dispatch("classifier off", ctx);
    assert.equal(calls.filter((call) => call.kind === "save").length, 3);
    assert.equal(state.enabled, false);
    assert.equal(state.pinned, true);
    assert.equal(state.classifierEnabled, false);
  });

  it("preserves the session pin across reload and init config replacement", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-pin-preserve-"));
    const { ctx } = makeCtx([], undefined, undefined, {}, tempDir);
    const state = makeState();
    state.pinned = true;
    state.extensionDir = tempDir;
    const dispatch = createCommandRouter(state as never);
    try {
      await dispatch("reload", ctx);
      assert.equal(state.pinned, true);
      await dispatch("init --write", ctx);
      assert.equal(state.pinned, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("selecting prompt also persists a classifier model", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    try {
      const { ctx, calls } = makeCtx(
        [{ provider: "fixture", id: "classifier" }],
        (_title, options) => options[0],
        async () => "fixture/classifier",
        {},
        tempDir,
      );
      const state = makeState();
      await createCommandRouter(state as never)("classifier", ctx);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, "prompt");
      assert.equal(saved.classifier.model, "fixture/classifier");
      assert.ok(calls.some((call) => call.kind === "custom"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the host model dialog when the rich selector is unavailable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    const previousCwd = process.cwd();
    const originalSelector = _selectorDeps.modelSelectorComponent;
    _selectorDeps.modelSelectorComponent = undefined;
    process.chdir(tempDir);
    try {
      let selectCount = 0;
      const { ctx, calls } = makeCtx(
        [
          { provider: "fixture", id: "classifier", name: "Classifier model" },
          { provider: "backup", id: "classifier", name: "Classifier model" },
        ],
        (_title, options) => {
          selectCount++;
          return selectCount === 1 ? options[0] : options[1];
        },
      );
      await createCommandRouter(makeState() as never)("classifier", ctx);
      const selects = calls.filter((call) => call.kind === "select");
      assert.equal(selects.length, 2);
      assert.deepEqual(selects[1]?.options, [
        "fixture/classifier — Classifier model",
        "backup/classifier — Classifier model",
      ]);
      assert.equal(calls.some((call) => call.kind === "custom"), false);
    } finally {
      _selectorDeps.modelSelectorComponent = originalSelector;
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
      writeFileSync(join(tempDir, ".pi", "bifrost.json"), JSON.stringify({ classifier: { enabled: true, backend: "prompt", model: "fixture/classifier", method: "auto", systemPrompt: "prompt-only" } }));
      const { ctx } = makeCtx([], (_title, options) => options.find((option) => option.startsWith("typesafe")));
      await createCommandRouter(makeState() as never)("classifier", ctx);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, "typesafe");
      assert.equal(saved.classifier.fallback, "prompt");
      assert.equal(saved.classifier.method, undefined);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows changing a valid prompt model selection", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    const previousCwd = process.cwd();
    const originalSelector = _selectorDeps.modelSelectorComponent;
    _selectorDeps.modelSelectorComponent = undefined;
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(join(tempDir, ".pi", "bifrost.json"), JSON.stringify({ models: { general: ["fixture/current"] }, classifier: { backend: "prompt", model: "fixture/current" } }));
      let selectCount = 0;
      const { ctx } = makeCtx([{ provider: "fixture", id: "current" }, { provider: "fixture", id: "next" }], (_title, options) => {
        selectCount++;
        return selectCount === 1 ? options[0] : options.find((option) => option.includes("next"));
      });
      await createCommandRouter(makeState() as never)("classifier", ctx);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.model, "fixture/next");
    } finally {
      _selectorDeps.modelSelectorComponent = originalSelector;
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows TypeSafe model and prompt fallback separately in status", async () => {
    const { ctx, calls } = makeCtx();
    const base = makeState();
    const state = Object.assign(base, {
      config: { ...base.config, models: {}, classifier: { backend: "typesafe", model: "fixture/classifier", fallback: "prompt", typesafe: { model: "jev-1.13.0" } } },
    });
    await createCommandRouter(state as never)("classifier status", ctx);
    const output = calls.find((call) => call.kind === "render")?.lines?.join("\n") ?? "";
    assert.match(output, /backend=typesafe model=jev-1\.13\.0/);
    assert.match(output, /fallback=prompt fallbackModel=fixture\/classifier/);
  });

  it("separates a rejected TypeSafe judgment from the final fallback route", () => {
    const before = { version: 1, model: "jev-1.13.0", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0 } as const;
    const after = { ...before, total: 1, outcomes: { low_confidence: 1 }, tiers: { quick: 1 }, confidenceBands: { "<0.8": 1 }, totalAttempts: 1 } as const;
    const lines = buildClassifierTestReport({
      classifier: { backend: "typesafe", typesafe: { model: "jev-1.13.0" }, minConfidence: 0.8 },
      result: { kind: "classified", tier: "frontier", source: "classifier", judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier" } },
      before,
      after,
      credential: "environment",
    });
    assert(lines.includes("backend: typesafe"));
    assert(lines.includes("model: jev-1.13.0"));
    assert(lines.includes("backend result: quick"));
    assert(lines.includes("accepted: no"));
    assert(lines.includes("final result: frontier"));
  });

  it("leaves config unchanged when prompt model picker is cancelled", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-test-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const { ctx } = makeCtx([{ provider: "fixture", id: "classifier" }], (_title, options) => options[0], async () => null);
      await createCommandRouter(makeState() as never)("classifier", ctx);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows picker for unknown subcommand", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("abc", ctx);
    const select = calls.find((call) => call.kind === "select");
    assert(select);
    assert.match(String(select?.title ?? ""), /Bifrost commands/);
    assert.equal(state.enabled, false);
  });

  it("shows open circuit count in dashboard title", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const t = Date.now();
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [t], openUntil: t + 60_000 } });
    await createCommandRouter(state as never)("", ctx);
    const select = calls.find((call) => call.kind === "select");
    assert.match(String(select?.title ?? ""), /circuits 1 open/);
  });

  it("reports classifier state and TTL-effective persisted cache in debug", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-debug-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      const path = cachePath(tempDir);
      writeFileSync(path, [
        JSON.stringify({ normalized: "fresh", category: "quick", lastUsed: Date.now(), hits: 1 }),
        JSON.stringify({ normalized: "stale", category: "general", lastUsed: Date.now() - 2 * 60 * 60 * 1000, hits: 1 }),
      ].join("\n") + "\n");
      const { ctx, calls } = makeCtx();
      const state = makeState();
      state.classifierEnabled = false;
      state.config.cache = { ttlHours: 1 };
      await createCommandRouter(state as never)("debug", ctx);
      const lines = outputLines(calls);
      assert(lines.includes("classifierEnabled: false"));
      assert(lines.includes("cache: 1 entries (retention 1h)"));
      assert(lines.includes("openCircuits: 0"));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the same TTL-effective cache count for cache stats", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-command-cache-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(cachePath(tempDir), [
        JSON.stringify({ normalized: "fresh", category: "quick", lastUsed: Date.now(), hits: 1 }),
        JSON.stringify({ normalized: "stale", category: "general", lastUsed: Date.now() - 2 * 60 * 60 * 1000, hits: 1 }),
      ].join("\n") + "\n");
      const { ctx, calls } = makeCtx();
      const state = makeState();
      state.config.cache = { ttlHours: 1 };
      await createCommandRouter(state as never)("cache stats", ctx);
      assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("cache: 1 entries")));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows no open circuits when reliability is disabled", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.config.reliability.enabled = false;
    state.reliabilityStore = makeStore({ "openai/gpt-5.4": { failures: [Date.now()], openUntil: Date.now() + 60_000 } }, false);
    await createCommandRouter(state as never)("debug", ctx);
    assert(outputLines(calls).some((line) => line.includes("openCircuits: 0")));
  });

  it("bounds an OMP probe refresh while persisting probe results", async () => {
    const previousTimeout = _hostDeps.operationTimeoutMs;
    const previousConfigDir = _hostDeps.configDirName;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-command-refresh-"));
    try {
      _resetHostForTests();
      _hostDeps.configDirName = ".omp";
      _hostDeps.operationTimeoutMs = 10;
      initHost({ zod: {} });
      const pending = new Promise<void>(() => {});
      const { ctx, calls } = makeCtx(
        [{ provider: "fixture", id: "model", api: "openai-completions", cost: { input: 0, output: 0 }, contextWindow: 128000 }],
        undefined,
        undefined,
        {
          awaitBackgroundRefresh: () => pending,
          streamSimple: () => ({
            result: async () => ({
              role: "assistant",
              api: "openai-completions",
              provider: "fixture",
              model: "model",
              content: [{ type: "text", text: "2" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            }),
          }),
        },
        cwd,
      );
      const state = makeState();
      state.config.probe = { timeoutMs: 20 };
      await createCommandRouter(state as never)("probe", ctx);
      assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("refresh timed out")));
      assert.equal(existsSync(probeResultsPath(cwd)), true);
      assert(calls.some((call) => call.kind === "render"));
    } finally {
      _resetHostForTests();
      _hostDeps.operationTimeoutMs = previousTimeout;
      _hostDeps.configDirName = previousConfigDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("continues init after a timed-out OMP refresh and writes the proposed config", async () => {
    const previousTimeout = _hostDeps.operationTimeoutMs;
    const previousConfigDir = _hostDeps.configDirName;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-command-init-refresh-"));
    try {
      _resetHostForTests();
      _hostDeps.configDirName = ".omp";
      _hostDeps.operationTimeoutMs = 10;
      initHost({ zod: {} });
      const { ctx, calls } = makeCtx(
        [{ provider: "fixture", id: "model", api: "openai-completions", cost: { input: 0, output: 0 }, contextWindow: 128000 }],
        undefined,
        undefined,
        {
          awaitBackgroundRefresh: () => new Promise<void>(() => {}),
          streamSimple: () => ({
            result: async () => ({
              role: "assistant",
              api: "openai-completions",
              provider: "fixture",
              model: "model",
              content: [{ type: "text", text: "2" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            }),
          }),
        },
        cwd,
      );
      const state = makeState();
      state.config.probe = { timeoutMs: 20 };
      state.extensionDir = cwd;
      await createCommandRouter(state as never)("init --write", ctx);
      assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("refresh timed out")));
      assert.equal(existsSync(join(cwd, ".pi", "bifrost.json")), true);
    } finally {
      _resetHostForTests();
      _hostDeps.operationTimeoutMs = previousTimeout;
      _hostDeps.configDirName = previousConfigDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
