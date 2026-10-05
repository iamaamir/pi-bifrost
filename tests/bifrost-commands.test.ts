import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIFROST_COMMAND_OPTIONS, buildClassifierTestReport, createCommandRouter, getBifrostCommandCompletions, log, nextClassifierConfig, runBifrostCommand } from "../commands.ts";
import { makePiClassifierModel, makeRegistry } from "./helpers.ts";

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
    config: { models: {}, reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 } },
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
    await inTempDir(async () => {
      await createCommandRouter(state as never)("reload", ctx as never);
    });
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("Bifrost config reloaded")));
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
      const match = /^\/bifrost (.+?)(?: <[^>]*>)? — /.exec(row);
      assert.ok(match, `unparseable row: ${row}`);
      return match[1];
    };
    const rendered = rows.map(commandOf);
    const registered = BIFROST_COMMAND_OPTIONS.map((command) => command.value);
    // Same multiset, so no command is hidden and none is repeated.
    assert.equal(rendered.length, registered.length);
    assert.deepEqual([...rendered].sort(), [...registered].sort());
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

  it("offers 18 rows", async () => {
    assert.equal((await rowsFor()).length, 18);
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
    assert.ok(rowAt(rows, "reload") < rowAt(rows, "benchmark"), "common rows precede the tail");
  });

  it("includes preview so the menu keeps prefilling it", async () => {
    // preview carries an argumentHint, so selecting its row must still
    // prefill the editor rather than run a handler.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("", ctx as never);
    const rows = rowsOf(calls);
    assert.ok(rows.some((row) => row.includes("/bifrost preview <prompt>")));
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
