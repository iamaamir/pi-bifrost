import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIFROST_COMMAND_OPTIONS, BIFROST_JSON_PREFIX, buildClassifierTestReport, buildPreviewFailure, buildPreviewReport, buildTracePreview, createCommandRouter, describeInitCommitFailure, getBifrostCommandCompletions, initRecoveryCommand, log, nextClassifierConfig, parsePreviewArgs, renderPreviewReport, renderTracePreview, resolveTierDisplay, runBifrostCommand, serializePreviewReport, type BifrostPreviewSuccess } from "../commands.ts";
import { makeModel, makePiClassifierModel, makeRegistry } from "./helpers.ts";
import { buildRouteDecisionSummary, createPipeline } from "../classification-pipeline.ts";
import { DEFAULT_THRESHOLD, lookupCache, touchCacheEntry, updateCache, type CacheEntry } from "../cache.ts";
import { reliabilityPath } from "../reliability.ts";
import { providerReliabilityPath, reliabilityV2Path } from "../runtime-reliability-v2.ts";
import { createProviderCooldownStore } from "../runtime-reliability-v2.ts";
import { emptyReliabilityV2State } from "../reliability-v2.ts";
import { buildInitMembershipPlan, buildInitOwnershipReceipt } from "../reconciliation-command.ts";
import { REGISTRY_REFRESH_TTL_MS } from "../ux-status.ts";
import { loadConfigForReload } from "../config-load.ts";
import { flushDebug, setupDebug } from "../debug.ts";
import { resolveClassifierEnablement } from "../runtime-state.ts";

it("renders missing configured entries in text route traces", () => {
  const trace = buildTracePreview({
    version: 1, kind: "route-decision", outcome: "unresolved", classification: { source: "regex" },
    requested: {
      tier: "general", strategy: "first", patterns: ["fake/missing", "fuzzy"], candidates: [],
      unresolvedPatterns: [
        { pattern: "fake/missing", exclusion: "model_unavailable", exclusionEvidence: [{ code: "model_unavailable", source: "registry_snapshot" }] },
        { pattern: "fuzzy", exclusion: "pattern_unavailable", exclusionEvidence: [{ code: "pattern_unavailable", source: "registry_snapshot" }] },
      ],
    },
  }, false);
  const text = renderTracePreview(trace).join("\n");
  assert.match(text, /fake\/missing.*model_unavailable.*registry_snapshot/u);
  assert.match(text, /fuzzy.*pattern_unavailable.*registry_snapshot/u);
});

describe("render trace preview", () => {
  it("renders classifier attempt details with exact confidence", () => {
    const lines = renderTracePreview({
      version: 1,
      kind: "route-decision",
      outcome: "unresolved",
      classification: { source: "fallback", tier: "general" },
      classifierAttempt: {
        backend: "typesafe",
        outcome: "low_confidence",
        fallbackKind: "prompt",
        model: "jev-1.13.0",
        fallbackModel: "fixture/classifier",
        confidence: 0.73,
      },
      classifierDisclosure: { enabled: true, configuredClassifierMayReceivePrompt: true },
    }).join("\n");

    assert.match(lines, /classifier attempt: typesafe \(low_confidence, fallback=prompt\)/u);
    assert.match(lines, /classifier attempt model: jev-1\.13\.0/u);
    assert.match(lines, /classifier attempt confidence: 0\.73/u);
  });

  it("renders classifier attempt details with zero confidence", () => {
    const lines = renderTracePreview({
      version: 1,
      kind: "route-decision",
      outcome: "unresolved",
      classification: { source: "fallback", tier: "general" },
      classifierAttempt: {
        backend: "pi-native",
        outcome: "low_confidence",
        fallbackKind: "default",
        model: "typesafe/jev-latest",
        confidence: 0,
      },
      classifierDisclosure: { enabled: true, configuredClassifierMayReceivePrompt: true },
    }).join("\n");

    assert.match(lines, /classifier attempt: pi-native \(low_confidence, fallback=default\)/u);
    assert.match(lines, /classifier attempt model: typesafe\/jev-latest/u);
    assert.match(lines, /^classifier attempt confidence: 0$/mu);
  });

  it("omits absent optional classifier attempt fields", () => {
    const lines = renderTracePreview({
      version: 1,
      kind: "route-decision",
      outcome: "unresolved",
      classification: { source: "fallback", tier: "general" },
      classifierAttempt: {
        backend: "typesafe",
        outcome: "timeout",
        fallbackKind: "regex",
      },
      classifierDisclosure: { enabled: true, configuredClassifierMayReceivePrompt: true },
    }).join("\n");

    assert.match(lines, /classifier attempt: typesafe \(timeout, fallback=regex\)/u);
    assert.doesNotMatch(lines, /classifier attempt model:/u);
    assert.doesNotMatch(lines, /classifier attempt confidence:/u);
  });
});

describe("standard preview rejected direct confidence", () => {
  const display = {
    strategy: "first-available",
    selected: "fake/chat",
    selectedTier: "general",
    fallbackReason: undefined as string | undefined,
    requestedCandidateLines: ["fake/chat"],
    fallbackCandidateLines: [] as string[],
    defaultTier: "general",
  };

  it("exposes rejected direct attempt confidence in preview JSON and text without inventing accepted confidence", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "fallback",
        tier: "general",
        classifierAttempt: {
          backend: "typesafe",
          outcome: "low_confidence",
          fallbackKind: "default",
          model: "jev-1.13.0",
          confidence: 0.73,
        },
      },
      display,
    });

    assert.equal("backend" in report, false);
    assert.equal("model" in report, false);
    assert.equal("confidence" in report, false);
    assert.equal(report.classifierAttempt?.backend, "typesafe");
    assert.equal(report.classifierAttempt?.confidence, 0.73);
    assert.equal(report.classifierAttempt?.outcome, "low_confidence");

    const lines = renderPreviewReport(report).join("\n");
    assert.match(lines, /classifier attempt: typesafe \(low_confidence, fallback=default\)/u);
    assert.match(lines, /classifier attempt model: jev-1\.13\.0/u);
    assert.match(lines, /classifier attempt confidence: 0\.73/u);
    assert.doesNotMatch(lines, /^backend:   /mu);
    assert.doesNotMatch(lines, /^confidence:/mu);
  });

  it("preserves zero rejected attempt confidence in preview JSON and text", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "fallback",
        tier: "general",
        classifierAttempt: {
          backend: "pi-native",
          outcome: "low_confidence",
          fallbackKind: "default",
          model: "typesafe/jev-latest",
          confidence: 0,
        },
      },
      display,
    });

    assert.equal(report.classifierAttempt?.confidence, 0);
    const lines = renderPreviewReport(report).join("\n");
    assert.match(lines, /^classifier attempt confidence: 0$/mu);
  });

  it("omits rejected attempt confidence when absent but keeps the attempt observable", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "fallback",
        tier: "general",
        classifierAttempt: {
          backend: "typesafe",
          outcome: "timeout",
          fallbackKind: "regex",
        },
      },
      display,
    });

    assert.equal(report.classifierAttempt?.backend, "typesafe");
    assert.equal("confidence" in (report.classifierAttempt ?? {}), false);
    const lines = renderPreviewReport(report).join("\n");
    assert.match(lines, /classifier attempt: typesafe \(timeout, fallback=regex\)/u);
    assert.doesNotMatch(lines, /classifier attempt confidence:/u);
  });

  it("keeps accepted judgment and rejected attempt distinct after prompt fallback", () => {
    const report = buildPreviewReport({
      prompt: "p",
      classification: {
        kind: "classified",
        tier: "frontier",
        source: "classifier",
        judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier", confidence: 0.91 },
        classifierAttempt: {
          backend: "typesafe",
          outcome: "low_confidence",
          fallbackKind: "prompt",
          model: "jev-1.13.0",
          fallbackModel: "fixture/classifier",
          confidence: 0.73,
        },
      },
      display: { ...display, selectedTier: "frontier", selected: "fixture/frontier" },
    });

    assert.equal(report.backend, "prompt");
    assert.equal(report.model, "fixture/classifier");
    assert.equal(report.confidence, 0.91);
    assert.equal(report.classifierAttempt?.backend, "typesafe");
    assert.equal(report.classifierAttempt?.confidence, 0.73);

    const lines = renderPreviewReport(report).join("\n");
    assert.match(lines, /^backend:   prompt$/mu);
    assert.match(lines, /^model:     fixture\/classifier$/mu);
    assert.match(lines, /^confidence: 0\.91$/mu);
    assert.match(lines, /classifier attempt: typesafe \(low_confidence, fallback=prompt\)/u);
    assert.match(lines, /classifier attempt confidence: 0\.73/u);
  });
});

describe("preview command rejected direct confidence", () => {
  const generalDisplayState = (tiers: Record<string, string[]> = { general: ["fixture/chat"] }) => {
    const models = [...new Set(Object.values(tiers).flat())].map((key) => {
      const slash = key.indexOf("/");
      return makeModel(slash >= 0 ? key.slice(0, slash) : "fixture", slash >= 0 ? key.slice(slash + 1) : key);
    });
    const { ctx } = makeCtx(models, undefined, undefined, {
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAll: () => models,
      getAvailable: () => models,
    } as never);
    const state = makeState();
    state.config.models = tiers;
    state.config.default = "general";
    return { ctx, state };
  };

  it("surfaces rejected direct confidence in /bifrost preview output", async () => {
    const { ctx, state } = generalDisplayState();
    state.getPipeline = () => ({
      classify: async () => ({
        kind: "fallback" as const,
        tier: "general",
        classifierAttempt: {
          backend: "typesafe" as const,
          outcome: "low_confidence" as const,
          fallbackKind: "default" as const,
          model: "jev-1.13.0",
          confidence: 0.73,
        },
      }),
    }) as never;
    const lines = await captureCommandText(async () => {
      await createCommandRouter(state as never)("preview hello", printModeCtx(ctx));
    });
    const text = lines.join("\n");

    assert.match(text, /classifier attempt: typesafe \(low_confidence, fallback=default\)/u);
    assert.match(text, /classifier attempt confidence: 0\.73/u);
    assert.doesNotMatch(text, /^confidence:/mu);
  });

  it("surfaces rejected direct confidence in /bifrost preview --json", async () => {
    const { ctx, state } = generalDisplayState();
    state.getPipeline = () => ({
      classify: async () => ({
        kind: "fallback" as const,
        tier: "general",
        classifierAttempt: {
          backend: "typesafe" as const,
          outcome: "low_confidence" as const,
          fallbackKind: "default" as const,
          model: "jev-1.13.0",
          confidence: 0.73,
        },
      }),
    }) as never;
    const [report] = await captureJsonReports(async () => {
      await createCommandRouter(state as never)("preview --json hello", ctx as never);
    }) as Array<Record<string, any>>;

    assert.equal(report.ok, true);
    assert.equal("confidence" in report, false);
    assert.equal(report.classifierAttempt?.backend, "typesafe");
    assert.equal(report.classifierAttempt?.confidence, 0.73);
  });

  it("surfaces zero and missing rejected confidence in standard preview command outputs", async () => {
    for (const attempt of [
      { backend: "pi-native" as const, outcome: "low_confidence" as const, fallbackKind: "default" as const, model: "jev-latest", confidence: 0 },
      { backend: "typesafe" as const, outcome: "timeout" as const, fallbackKind: "regex" as const },
    ]) {
      const { ctx, state } = generalDisplayState();
      state.getPipeline = () => ({ classify: async () => ({ kind: "fallback" as const, tier: "general", classifierAttempt: attempt }) }) as never;
      const dispatch = createCommandRouter(state as never);

      const [json] = await captureJsonReports(async () => {
        await dispatch("preview --json hello", ctx as never);
      }) as Array<Record<string, any>>;
      assert.equal(json.classifierAttempt?.backend, attempt.backend);
      if ("confidence" in attempt) assert.equal(json.classifierAttempt?.confidence, 0);
      else assert.equal("confidence" in (json.classifierAttempt ?? {}), false);

      const text = (await captureCommandText(async () => {
        await dispatch("preview hello", printModeCtx(ctx));
      })).join("\n");
      if ("confidence" in attempt) assert.match(text, /^classifier attempt confidence: 0$/mu);
      else assert.doesNotMatch(text, /classifier attempt confidence:/u);
    }
  });

  it("keeps accepted prompt confidence distinct in standard preview command outputs after direct rejection", async () => {
    const { ctx, state } = generalDisplayState({ general: ["fixture/chat"], frontier: ["fixture/chat"] });
    state.getPipeline = () => ({
      classify: async () => ({
        kind: "classified" as const,
        tier: "frontier",
        source: "classifier" as const,
        judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier", confidence: 0.91 },
        classifierAttempt: {
          backend: "typesafe" as const,
          outcome: "low_confidence" as const,
          fallbackKind: "prompt" as const,
          model: "jev-1.13.0",
          fallbackModel: "fixture/classifier",
          confidence: 0.73,
        },
      }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [json] = await captureJsonReports(async () => {
      await dispatch("preview --json hello", ctx as never);
    }) as Array<Record<string, any>>;
    assert.equal(json.backend, "prompt");
    assert.equal(json.confidence, 0.91);
    assert.equal(json.classifierAttempt?.backend, "typesafe");
    assert.equal(json.classifierAttempt?.confidence, 0.73);

    const text = (await captureCommandText(async () => {
      await dispatch("preview hello", printModeCtx(ctx));
    })).join("\n");
    assert.match(text, /^backend:   prompt$/mu);
    assert.match(text, /^confidence: 0\.91$/mu);
    assert.match(text, /classifier attempt: typesafe \(low_confidence, fallback=prompt\)/u);
    assert.match(text, /classifier attempt confidence: 0\.73/u);
  });

  it("surfaces rejected direct confidence in /bifrost preview --trace text and JSON", async () => {
    const { ctx, state } = generalDisplayState();
    state.getPipeline = () => ({
      classify: async () => ({
        kind: "fallback" as const,
        tier: "general",
        classifierAttempt: {
          backend: "typesafe" as const,
          outcome: "low_confidence" as const,
          fallbackKind: "default" as const,
          model: "jev-1.13.0",
          confidence: 0.73,
        },
      }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [traceJson] = await captureJsonReports(async () => {
      await dispatch("preview --trace --json hello", ctx as never);
    }) as Array<Record<string, any>>;
    assert.equal(traceJson.classifierAttempt?.backend, "typesafe");
    assert.equal(traceJson.classifierAttempt?.confidence, 0.73);

    const traceText = (await captureCommandText(async () => {
      await dispatch("preview --trace hello", printModeCtx(ctx));
    })).join("\n");
    assert.match(traceText, /classifier attempt: typesafe \(low_confidence, fallback=default\)/u);
    assert.match(traceText, /classifier attempt confidence: 0\.73/u);
  });

  it("surfaces zero and missing rejected confidence in trace command outputs", async () => {
    for (const attempt of [
      { backend: "pi-native" as const, outcome: "low_confidence" as const, fallbackKind: "default" as const, model: "jev-latest", confidence: 0 },
      { backend: "typesafe" as const, outcome: "timeout" as const, fallbackKind: "regex" as const },
    ]) {
      const { ctx, state } = generalDisplayState();
      state.getPipeline = () => ({ classify: async () => ({ kind: "fallback" as const, tier: "general", classifierAttempt: attempt }) }) as never;
      const dispatch = createCommandRouter(state as never);

      const [traceJson] = await captureJsonReports(async () => {
        await dispatch("preview --trace --json hello", ctx as never);
      }) as Array<Record<string, any>>;
      assert.equal(traceJson.classifierAttempt?.backend, attempt.backend);
      if ("confidence" in attempt) assert.equal(traceJson.classifierAttempt?.confidence, 0);
      else assert.equal("confidence" in (traceJson.classifierAttempt ?? {}), false);

      const traceText = (await captureCommandText(async () => {
        await dispatch("preview --trace hello", printModeCtx(ctx));
      })).join("\n");
      if ("confidence" in attempt) assert.match(traceText, /^classifier attempt confidence: 0$/mu);
      else assert.doesNotMatch(traceText, /classifier attempt confidence:/u);
    }
  });

  it("keeps rejected attempt confidence distinct in trace outputs after accepted prompt fallback", async () => {
    const { ctx, state } = generalDisplayState({ general: ["fixture/chat"], frontier: ["fixture/chat"] });
    state.getPipeline = () => ({
      classify: async () => ({
        kind: "classified" as const,
        tier: "frontier",
        source: "classifier" as const,
        judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier", confidence: 0.91 },
        classifierAttempt: {
          backend: "typesafe" as const,
          outcome: "low_confidence" as const,
          fallbackKind: "prompt" as const,
          model: "jev-1.13.0",
          fallbackModel: "fixture/classifier",
          confidence: 0.73,
        },
      }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [traceJson] = await captureJsonReports(async () => {
      await dispatch("preview --trace --json hello", ctx as never);
    }) as Array<Record<string, any>>;
    assert.equal(traceJson.classification?.classifier?.backend, "prompt");
    assert.equal(traceJson.classification?.classifier?.confidence, 0.91);
    assert.equal(traceJson.classifierAttempt?.backend, "typesafe");
    assert.equal(traceJson.classifierAttempt?.confidence, 0.73);

    const traceText = (await captureCommandText(async () => {
      await dispatch("preview --trace hello", printModeCtx(ctx));
    })).join("\n");
    assert.match(traceText, /classifier: prompt/u);
    assert.match(traceText, /classifier confidence: 0\.91/u);
    assert.match(traceText, /classifier attempt: typesafe \(low_confidence, fallback=prompt\)/u);
    assert.match(traceText, /classifier attempt confidence: 0\.73/u);
  });
});

describe("classifier test command rejected direct confidence", () => {
  it("reports exact rejected direct confidence and keeps final prompt fallback distinct", async () => {
    const { ctx } = makeCtx([makeModel("fixture", "classifier")]);
    const state = makeState() as any;
    const before = {
      version: 1, model: "jev-1.13.0", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
    };
    const after = {
      ...before,
      total: 1,
      outcomes: { low_confidence: 1 },
      tiers: { quick: 1 },
      confidenceBands: { "<0.8": 1 },
      totalAttempts: 1,
    };
    let snapshot = before;
    state.config.classifier = { enabled: true, backend: "typesafe", typesafe: { model: "jev-1.13.0" }, minConfidence: 0.8 };
    state.effectiveClassifierBackend = () => ({ backend: "typesafe", reason: "configured", auto: false });
    state.classifierMetricsStore = { snapshot: () => snapshot, reload: () => {} };
    state.getPipeline = () => ({
      classify: async () => {
        snapshot = after;
        return {
          kind: "classified" as const,
          tier: "frontier",
          source: "classifier" as const,
          judgment: { tier: "frontier", backend: "prompt", model: "fixture/classifier", confidence: 0.91 },
          classifierAttempt: {
            backend: "typesafe" as const,
            outcome: "low_confidence" as const,
            fallbackKind: "prompt" as const,
            fallbackModel: "fixture/classifier",
            model: "jev-1.13.0",
            confidence: 0.73,
          },
        };
      },
    }) as never;

    const lines = (await captureCommandText(async () => {
      await createCommandRouter(state as never)("classifier test", printModeCtx(ctx));
    })).join("\n");

    assert.match(lines, /backend: typesafe/u);
    assert.match(lines, /backend result: quick/u);
    assert.match(lines, /^confidence: 0\.73$/mu);
    assert.match(lines, /accepted: no/u);
    assert.match(lines, /final result: frontier/u);
    assert.match(lines, /final backend: prompt/u);
    assert.match(lines, /final model: fixture\/classifier/u);
  });

  it("reports zero and missing rejected direct confidence in classifier test output", async () => {
    const { ctx } = makeCtx();
    const state = makeState() as any;
    state.config.classifier = { enabled: true, backend: "typesafe", typesafe: { model: "jev-1.13.0" }, minConfidence: 0.8 };
    state.effectiveClassifierBackend = () => ({ backend: "typesafe", reason: "configured", auto: false });

    for (const [attempt, expectedConfidence] of [
      [{ backend: "typesafe" as const, outcome: "low_confidence" as const, fallbackKind: "default" as const, model: "jev-1.13.0", confidence: 0 }, /^confidence: 0$/mu],
      [{ backend: "typesafe" as const, outcome: "low_confidence" as const, fallbackKind: "default" as const, model: "jev-1.13.0" }, /^confidence: <0\.8$/mu],
    ] as const) {
      const before = {
        version: 1, model: "jev-1.13.0", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
      };
      const after = {
        ...before,
        total: 1,
        outcomes: { low_confidence: 1 },
        tiers: { quick: 1 },
        confidenceBands: { "<0.8": 1 },
        totalAttempts: 1,
      };
      let snapshot = before;
      state.classifierMetricsStore = { snapshot: () => snapshot, reload: () => {} };
      state.getPipeline = () => ({
        classify: async () => {
          snapshot = after;
          return { kind: "fallback" as const, tier: "general", classifierAttempt: attempt };
        },
      }) as never;

      const lines = (await captureCommandText(async () => {
        await createCommandRouter(state as never)("classifier test", printModeCtx(ctx));
      })).join("\n");
      assert.match(lines, expectedConfidence);
      assert.match(lines, /accepted: no/u);
    }
  });
});

function writeRecentProbeCache(path: string, results: unknown): void {
  writeFileSync(path, JSON.stringify(results));
  const recent = new Date(Date.now() - 60_000);
  utimesSync(path, recent, recent);
}

function makeCtx(
  models: Array<{ provider: string; id: string }> = [],
  selectOverride?: (title: string, options: string[]) => string | undefined,
  customOverride?: () => Promise<unknown>,
  registryOverride?: Pick<ReturnType<typeof makeRegistry>, "getAvailableOfType">,
) {
  const calls: Array<{ kind: string; value?: unknown; title?: string; options?: string[]; lines?: string[] }> = [];
  const sessionManager = {};
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
      setWidget: (key: string, value: string[] | undefined | ((tui: unknown, theme: unknown) => unknown)) => {
        if (typeof value === "function") {
          // Render component-factory widgets so tests can assert their text content.
          const component = value(undefined, {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            style: (text: string) => text,
            colors: {},
          }) as { text?: string } | undefined;
          calls.push({ kind: "widget", value: `${key}:func`, lines: component?.text?.split("\n") ?? [] });
          return;
        }
        calls.push({ kind: "widget", value: `${key}:${value?.length ?? 0}`, lines: value });
      },
      setWorkingMessage: (_message?: string) => {},
      setWorkingVisible: (_visible: boolean) => {},
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
    sessionManager,
    scopedModels: [],
  };
  return { ctx: ctx as never, sessionManager, calls };
}

function makeStore(reliabilityState?: Record<string, { failures: number[]; openUntil?: number }>, enabled = true) {
  const store = {
    getState: () => ({ version: 1 as const, models: reliabilityState ?? {} }),
    reload: () => {},
    applyOutcomes: () => {},
    openCircuitCount: (now?: number) => {
      if (!enabled) return 0;
      const t = now ?? Date.now();
      return Object.entries(reliabilityState ?? {}).filter(([, r]) => r.openUntil && r.openUntil > t).length;
    },
  };
  return store;
}

function makeState(saveModeState: () => void = () => {}) {
  const classifierOverrides = new WeakMap<object, boolean>();
  const state = {
    config: {
      models: {},
      default: undefined as string | undefined,
      strategy: "first",
      reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
      classifier: undefined as { enabled?: boolean; backend?: string } | undefined,
    },
    enabled: true,
    tierPolicyValid: true,
    legacyClassifierEnabled: undefined as boolean | undefined,
    classifierRuntimeStateIssue: undefined as "unreadable" | "invalid-json" | "invalid-shape" | undefined,
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
    getPipeline: (_ctx?: unknown) => ({ classify: async (_prompt?: string, _signal?: AbortSignal, _options?: { readonly offline?: boolean }) => ({ kind: "unclassified" as const }) }),
    invalidatePipeline: () => {},
    saveModeState,
  };
  return Object.assign(state, {
    getClassifierEnablementForSession: (session: object, config = state.config) => resolveClassifierEnablement(
      (config as { classifier?: { enabled?: boolean } }).classifier?.enabled !== false,
      state.legacyClassifierEnabled,
      classifierOverrides.get(session),
      state.classifierRuntimeStateIssue,
    ),
    setClassifierSessionOverride: (session: object, enabled?: boolean) => {
      if (enabled === undefined) classifierOverrides.delete(session);
      else classifierOverrides.set(session, enabled);

    },
    classifyForSession: async (ctx: unknown, prompt: string, signal?: AbortSignal, options?: { readonly offline?: boolean }) =>
      await state.getPipeline(ctx).classify(prompt, signal, options),
  });
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

async function captureCommandText(run: () => Promise<void>): Promise<string[]> {
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
  return lines
    .filter((line) => line.startsWith("[bifrost] "))
    .map((line) => line.slice("[bifrost] ".length));
}

function printModeCtx(ctx: unknown): never {
  return { ...(ctx as Record<string, unknown>), mode: "print" } as never;
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
    assert(items.some((item) => item.value === "classifier off" && item.description === "Disable LLM classifier for this session"));
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

  it("prints the effective debug log path and fixed rotation target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-debug-status-"));
    const path = join(directory, "trace.jsonl");
    const { ctx } = makeCtx();
    setupDebug({ enabled: true, path }, directory);
    try {
      const lines = await captureCommandText(() => createCommandRouter(makeState() as never)("debug", printModeCtx(ctx)));
      assert.ok(lines.includes("debug: on"));
      assert.ok(lines.includes(`debugLog: ${path}`));
      assert.ok(lines.includes(`debugRotation: 10 MiB per file → ${join(directory, "trace.old.jsonl")} (replaced at each rotation)`));
      await flushDebug(1_000);
    } finally {
      setupDebug({ enabled: false }, directory);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders control characters in configured debug paths as escapes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-debug-status-escape-"));
    const rawPath = join(directory, "trace\n\u001b[31mred.jsonl");
    const escapedPath = join(directory, "trace\\u000a\\u001b[31mred.jsonl");
    const { ctx } = makeCtx();
    setupDebug({ enabled: true, path: rawPath }, directory);
    try {
      const lines = await captureCommandText(() => createCommandRouter(makeState() as never)("debug", printModeCtx(ctx)));
      assert.ok(lines.includes(`debugLog: ${escapedPath}`), `expected escaped debugLog line, got:\n${lines.join("\n")}`);
      assert.ok(lines.includes(`debugRotation: 10 MiB per file → ${join(directory, "trace\\u000a\\u001b[31mred.old.jsonl")} (replaced at each rotation)`));
      assert.ok(lines.every((line) => !line.includes("\u001b")), "raw terminal control characters must not reach command output");
      await flushDebug(1_000);
    } finally {
      setupDebug({ enabled: false }, directory);
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("persists global mode but keeps pin and classifier toggles session-only", async () => {
    const { ctx, calls, sessionManager } = makeCtx();
    const state = makeState(() => calls.push({ kind: "save" }));
    const dispatch = createCommandRouter(state as never);

    await dispatch("off", ctx as never);
    await dispatch("pin", ctx as never);
    await dispatch("classifier off", ctx as never);

    assert.equal(calls.filter((call) => call.kind === "save").length, 1);
    assert.equal(state.enabled, false);
    assert.equal(state.pinned, true);
    assert.deepEqual(state.getClassifierEnablementForSession(sessionManager), { enabled: false, source: "session" });
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

  it("reports legacy classifier conflict without disabled-backend criteria errors", async () => {
    const { ctx, calls } = makeCtx();
    const state: any = makeState();
    state.config = { models: { custom: ["fixture/chat"] }, classifier: { enabled: false, backend: "prompt" } };
    state.legacyClassifierEnabled = true;
    const dispatch = createCommandRouter(state);

    await dispatch("classifier status", ctx as never);
    let output = calls.filter((call) => call.kind === "widget").at(-1)?.lines?.join("\n") ?? "";
    assert.match(output, /classifier: enabled=false \(legacy-conflict\)/);
    assert.match(output, /configured=off/);
    assert.match(output, /legacy saved classifierEnabled=true conflicts with configured=false/);
    assert.match(output, /configured off takes precedence/);
    assert.doesNotMatch(output, /classification paused/u);
    assert.match(output, /readiness=inactive/);
    assert.doesNotMatch(output, /criteria missing/);

    await dispatch("classifier on", ctx as never);
    await dispatch("classifier status", ctx as never);
    output = calls.filter((call) => call.kind === "widget").at(-1)?.lines?.join("\n") ?? "";
    assert.match(output, /classifier: enabled=true \(session\)/);
    assert.match(output, /configured=off/);
    assert.match(output, /explicit session-only override is active/);
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
        classifierAttempt: {
          backend: "typesafe",
          outcome: "low_confidence",
          fallbackKind: "prompt",
          fallbackModel: "fixture/classifier",
          model: "jev-1.13.0",
          confidence: 0.73,
        },
      },
      before,
      after,
      credential: "environment",
    });

    assert(lines.includes("backend: typesafe"));
    assert(lines.includes("model: jev-1.13.0"));
    assert(lines.includes("backend result: quick"));
    assert(lines.includes("confidence: 0.73"));
    assert(lines.includes("accepted: no"));
    assert(lines.includes("final result: frontier"));
    assert(lines.includes("final source: classifier"));
    assert(lines.includes("final backend: prompt"));
    assert(lines.includes("final model: fixture/classifier"));
    assert(lines.includes("classifier fallback: prompt"));
    assert(lines.includes("outcome: low_confidence"));
  });

  it("attributes a rejected auto-resolved pi-native attempt to the observed model", () => {
    const before = {
      version: 1, model: "typesafe/jev-latest", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
    } as const;
    const after = {
      ...before,
      total: 1,
      outcomes: { low_confidence: 1 },
      tiers: { quick: 1 },
      totalAttempts: 1,
    } as const;

    const lines = buildClassifierTestReport({
      classifier: { piNative: {}, minConfidence: 0.8 },
      effectiveBackend: { backend: "pi-native", reason: "Pi-managed TypeSafe credential", auto: true },
      result: {
        kind: "fallback",
        tier: "quick",
        classifierAttempt: {
          backend: "pi-native",
          outcome: "low_confidence",
          fallbackKind: "default",
          model: "typesafe/jev-latest",
          confidence: 0.73,
        },
      },
      before,
      after,
    });

    assert(lines.includes("model: typesafe/jev-latest"), JSON.stringify(lines));
    assert(lines.includes("confidence: 0.73"));
    assert.equal(lines.some((line) => line.includes("catalog default")), false, JSON.stringify(lines));
  });

  it("attributes a rejected attempt to its observed model over an explicitly configured one", () => {
    const before = {
      version: 1, model: "typesafe/configured", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
    } as const;
    const after = {
      ...before,
      total: 1,
      outcomes: { low_confidence: 1 },
      tiers: { quick: 1 },
      totalAttempts: 1,
    } as const;

    const lines = buildClassifierTestReport({
      classifier: { piNative: { model: "typesafe/configured" }, minConfidence: 0.8 },
      effectiveBackend: { backend: "pi-native", reason: "test", auto: false },
      result: {
        kind: "fallback",
        tier: "quick",
        classifierAttempt: {
          backend: "pi-native",
          outcome: "low_confidence",
          fallbackKind: "default",
          model: "typesafe/observed",
          confidence: 0.4,
        },
      },
      before,
      after,
    });

    assert(lines.includes("model: typesafe/observed"), JSON.stringify(lines));
    assert(lines.includes("confidence: 0.4"));
  });

  it("keeps configured model attribution when a rejected attempt observed no model", () => {
    const before = {
      version: 1, model: "typesafe/configured", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
    } as const;
    const after = {
      ...before,
      total: 1,
      outcomes: { timeout: 1 },
      tiers: { quick: 1 },
      totalAttempts: 0,
    } as const;

    const lines = buildClassifierTestReport({
      classifier: { piNative: { model: "typesafe/configured" }, minConfidence: 0.8 },
      effectiveBackend: { backend: "pi-native", reason: "test", auto: false },
      result: {
        kind: "fallback",
        tier: "quick",
        classifierAttempt: {
          backend: "pi-native",
          outcome: "timeout",
          fallbackKind: "default",
        },
      },
      before,
      after,
    });

    assert(lines.includes("model: typesafe/configured"), JSON.stringify(lines));
    assert(lines.includes("confidence: n/a"), JSON.stringify(lines));
  });

  it("falls back to confidence bands when a rejected attempt has no exact confidence", () => {
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
        classifierAttempt: {
          backend: "typesafe",
          outcome: "low_confidence",
          fallbackKind: "prompt",
          fallbackModel: "fixture/classifier",
          model: "jev-1.13.0",
        },
      },
      before,
      after,
      credential: "environment",
    });

    assert(lines.includes("confidence: <0.8"));
  });

  it("reports the tier a rejected attempt proposed when metrics are disabled", () => {
    const empty = {
      version: 1, model: "jev-1.13.0", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0,
    } as const;
    const report = (attempt: { tier?: string; outcome?: "low_confidence" | "timeout"; confidence?: number }) => buildClassifierTestReport({
      classifier: { backend: "typesafe", typesafe: { model: "jev-1.13.0" }, minConfidence: 0.8 },
      result: {
        kind: "fallback",
        tier: "frontier",
        classifierAttempt: {
          backend: "typesafe",
          outcome: attempt.outcome ?? "low_confidence",
          fallbackKind: "default",
          model: "jev-1.13.0",
          ...(attempt.tier !== undefined ? { tier: attempt.tier } : {}),
          ...(attempt.confidence !== undefined ? { confidence: attempt.confidence } : {}),
        },
      },
      before: empty,
      after: empty,
      credential: "environment",
    });

    // No metric delta exists, so without the attempt's own tier the exact
    // confidence would be attributable to nothing.
    const rejected = report({ tier: "quick", confidence: 0.73 });
    assert(rejected.includes("backend result: quick"), JSON.stringify(rejected));
    assert(rejected.includes("confidence: 0.73"));
    assert.equal(rejected.includes("backend result: none"), false);

    // A timeout proposes nothing, so the honest answer is still absent.
    const timedOut = report({ outcome: "timeout" });
    assert(timedOut.includes("backend result: none"), JSON.stringify(timedOut));
  });

  it("shows zero confidence for a rejected direct classifier attempt", () => {
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
        kind: "fallback",
        tier: "frontier",
        classifierAttempt: {
          backend: "typesafe",
          outcome: "low_confidence",
          fallbackKind: "default",
          model: "jev-1.13.0",
          confidence: 0,
        },
      },
      before,
      after,
      credential: "environment",
    });

    assert(lines.includes("backend result: quick"));
    assert(lines.includes("confidence: 0"));
    assert(lines.includes("accepted: no"));
    assert(lines.includes("final result: frontier"));
    assert(lines.includes("final source: fallback"));
  });

  it("uses detected classifier defaults after init without opening the picker", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-guidance-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState();
      await createCommandRouter(state as never)("init --write", ctx as never);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), true);
      assert(calls.some(
        (call) =>
          call.kind === "widget" &&
          String(call.lines?.join("\n")).includes("Classifier") &&
          String(call.lines?.join("\n")).includes("detected default") &&
          String(call.lines?.join("\n")).includes("fixture/chat"),
      ));
      assert.equal(calls.some((call) => call.kind === "select"), false);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, undefined);
      assert.equal(saved.classifier.model, "fixture/chat", "fresh init persists only a detected model backed by a recent healthy probe");
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds large init previews in a private full-details file without requiring an overlay", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-large-preview-"));
    const previousCwd = process.cwd();
    let detailsDirectory: string | undefined;
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(join(tempDir, ".pi", "bifrost.json"), JSON.stringify({ models: { quick: ["manual/keep"] } }));
      writeFileSync(join(tempDir, ".pi", "bifrost-reconcile-ownership.json"), JSON.stringify(
        buildInitOwnershipReceipt("project", { quick: ["manual/keep"] }),
      ));
      const models = Array.from({ length: 220 }, (_, index) => makeModel("fixture", `model-${String(index).padStart(3, "0")}`, 0.2, 0.2));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), models.map((model) => ({
        provider: model.provider, model: model.id, status: "ok", cost_input: 0.2, cost_output: 0.2, duration_ms: 10,
      })));
      const { ctx, calls } = makeCtx(
        models as never,
        (_title, options) => options.find((option) => option.startsWith("Keep my models")),
      );
      (ctx as any).ui.custom = undefined;
      (ctx as any).modelRegistry.getProviderAuthStatus = () => ({ configured: true });
      const state = makeState() as any;
      state.registryInventoryEvidence = { fixture: { status: "complete", refreshedAt: Date.now() } };
      const stderr: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
      try {
        await createCommandRouter(state)("init", ctx as never);
      } finally {
        console.error = originalError;
      }
      const preview = calls.find((call) => call.kind === "widget" && call.lines?.length && String(call.value).startsWith("bifrost-output:"));
      const inline = preview?.lines?.join("\n") ?? "";
      assert.ok(inline.length < 3_000, `inline preview was ${inline.length} chars`);
      assert.match(inline, /Full ordered details: /, JSON.stringify(calls));
      assert.doesNotMatch(inline, /fixture\/model-\d{3}/);
      const detailsPath = inline.match(/Full ordered details: (.+)/)?.[1];
      assert.ok(detailsPath);
      detailsDirectory = dirname(detailsPath);
      assert.equal(statSync(detailsPath).mode & 0o777, 0o600);
      const detail = readFileSync(detailsPath, "utf8");
      assert.deepEqual(stderr, []);
      assert.equal(calls.some((call) => call.kind === "custom"), false);
      let lastModelPosition = -1;
      for (let index = 0; index < 220; index++) {
        const position = detail.indexOf(`fixture/model-${String(index).padStart(3, "0")}`);
        assert.ok(position > lastModelPosition, `missing or reordered model ${index}`);
        lastModelPosition = position;
      }
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), true);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
      if (detailsDirectory) rmSync(detailsDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed without config writes when private full-details file cannot be created", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-preview-failure-"));
    const previousCwd = process.cwd();
    const previousTmpdir = process.env.TMPDIR;
    const previousTmp = process.env.TMP;
    const previousTemp = process.env.TEMP;
    const blockedTmpdir = join(tempDir, "missing-tmp");
    process.env.TMPDIR = blockedTmpdir;
    process.env.TMP = blockedTmpdir;
    process.env.TEMP = blockedTmpdir;
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      const existing = Array.from({ length: 220 }, (_, index) => `manual/model-${String(index).padStart(3, "0")}`);
      writeFileSync(join(tempDir, ".pi", "bifrost.json"), JSON.stringify({ models: { quick: existing } }));
      const ownershipPath = join(tempDir, ".pi", "bifrost-reconcile-ownership.json");
      writeFileSync(ownershipPath, JSON.stringify(buildInitOwnershipReceipt("project", { quick: existing })));
      const originalConfig = readFileSync(join(tempDir, ".pi", "bifrost.json"));
      const originalOwnership = readFileSync(ownershipPath);
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0.2, cost_output: 0.2, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx(
        [makeModel("fixture", "chat", 0.2, 0.2) as never],
        (_title, options) => options.find((option) => option.startsWith("Keep my models")),
      );
      (ctx as any).ui.custom = undefined;
      (ctx as any).modelRegistry.getProviderAuthStatus = () => ({ configured: true });
      const state = makeState() as any;
      state.registryInventoryEvidence = { fixture: { status: "complete", refreshedAt: Date.now() } };
      const stderr: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
      try {
        await createCommandRouter(state)("init", ctx as never);
      } finally {
        console.error = originalError;
      }
      const preview = calls.find((call) => call.kind === "widget" && call.lines?.length && String(call.value).startsWith("bifrost-output:"));
      const inline = preview?.lines?.join("\n") ?? "";
      assert.ok(inline.length < 3_000, `inline preview was ${inline.length} chars`);
      assert.match(inline, /Full details unavailable; private output failed/);
      assert.doesNotMatch(inline, /manual\/model-\d{3}/);
      assert.deepEqual(stderr, []);
      assert.equal(calls.some((call) => call.kind === "custom"), false);
      assert.equal(calls.some((call) => call.kind === "select"), false);
      assert.ok(calls.some((call) => call.kind === "notify" && String(call.value).includes("Nothing was saved; full model details could not be written to a private file")));
      assert.deepEqual(readFileSync(join(tempDir, ".pi", "bifrost.json")), originalConfig);
      assert.deepEqual(readFileSync(ownershipPath), originalOwnership);
    } finally {
      process.chdir(previousCwd);
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      if (previousTmp === undefined) delete process.env.TMP;
      else process.env.TMP = previousTmp;
      if (previousTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = previousTemp;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses bundled public init defaults without loading extension config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-extension-ownership-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const extensionDir = join(tempDir, "extension");
    mkdirSync(extensionDir);
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(join(extensionDir, "bifrost.json"), JSON.stringify({
        classifier: { enabled: true, backend: "prompt", endpoint: "https://extension-private.invalid", systemPrompt: "EXTENSION_PRIVATE_CANARY" },
        cache: { enabled: false, maxEntries: 17, threshold: 0.1 },
        reliability: { enabled: true, failureThreshold: 19 },
        debug: { enabled: true },
      }));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState();
      state.extensionDir = extensionDir;
      await createCommandRouter(state as never)("init --write", ctx as never);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.enabled, true);
      assert.equal(saved.cache.enabled, true);
      assert.equal(saved.cache.maxEntries, 500);
      assert.equal(saved.reliability.failureThreshold, 3);
      assert.equal(saved.debug.enabled, false);
      const effective = loadConfigForReload(tempDir, extensionDir).config;
      assert.equal(effective.classifier?.systemPrompt, undefined);
      assert.equal(effective.classifier?.endpoint, undefined);
      assert.equal(effective.cache?.enabled, true);
      assert.equal(effective.cache?.maxEntries, 500);
      assert.equal(effective.reliability?.failureThreshold, 3);
      assert.equal(effective.debug?.enabled, false);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses bundled public init defaults on forced fresh init", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-extension-force-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const extensionDir = join(tempDir, "extension");
    mkdirSync(extensionDir);
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeFileSync(join(extensionDir, "bifrost.json"), JSON.stringify({
        classifier: { enabled: true, backend: "prompt", endpoint: "https://extension-private.invalid", systemPrompt: "EXTENSION_PRIVATE_CANARY" },
        cache: { enabled: false, maxEntries: 17, threshold: 0.1 },
        reliability: { enabled: true, failureThreshold: 19 },
        debug: { enabled: true },
      }));
      const model = makeModel("fixture", "chat");
      const { ctx } = makeCtx([model as never]);
      const modelRegistry = (ctx as any).modelRegistry;
      modelRegistry.streamSimple = () => ({ result: async () => ({
        role: "assistant", content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop",
      }) });
      const state = makeState() as any;
      state.extensionDir = extensionDir;
      state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} };
      await createCommandRouter(state)("init -f --write", ctx);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.enabled, true);
      assert.equal(saved.cache.enabled, true);
      assert.equal(saved.cache.maxEntries, 500);
      assert.equal(saved.reliability.failureThreshold, 3);
      assert.equal(saved.debug.enabled, false);
      const effective = loadConfigForReload(tempDir, extensionDir).config;
      assert.equal(effective.classifier?.systemPrompt, undefined);
      assert.equal(effective.cache?.enabled, true);
      assert.equal(effective.reliability?.failureThreshold, 3);
      assert.equal(effective.debug?.enabled, false);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("saves in-memory starter pools and their default atomically with a manual classifier choice", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-classifier-save-bootstrap-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(agentDir);
    process.chdir(tempDir);
    try {
      const { ctx } = makeCtx([{ provider: "fixture", id: "chat" }], (title, options) =>
        title === "Classifier backend" ? options.find((option) => option.startsWith("typesafe")) : undefined,
      );
      const state = makeState() as any;
      state.bootstrapModelsInMemory = true;
      state.config.default = "quick";
      state.config.models = { quick: ["fixture/chat"] };

      await createCommandRouter(state)("classifier", ctx);

      const configPath = join(tempDir, ".pi", "bifrost.json");
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(saved.default, "quick");
      assert.deepEqual(saved.models, { quick: ["fixture/chat"] });
      assert.equal(saved.classifier.backend, "typesafe");
      assert.ok(existsSync(join(tempDir, ".pi", "bifrost-reconcile-ownership.json")));
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const scope of ["user", "workspace"] as const) it(`saves starter pools with ${scope} ownership when a classifier is chosen`, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-classifier-empty-bootstrap-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(agentDir);
    process.chdir(tempDir);
    try {
      const globalConfig = scope === "user" ? join(agentDir, "bifrost.json") : join(tempDir, "bifrost.json");
      writeFileSync(globalConfig, "{}\n");
      const { ctx } = makeCtx([{ provider: "fixture", id: "chat" }], (title, options) =>
        title === "Classifier backend" ? options.find((option) => option.startsWith("typesafe")) : undefined,
      );
      const state = makeState() as any;
      state.bootstrapModelsInMemory = true;
      state.config.default = "quick";
      state.config.models = { quick: ["fixture/chat"] };

      await createCommandRouter(state)("classifier", ctx);

      const saved = JSON.parse(readFileSync(globalConfig, "utf8"));
      assert.equal(saved.default, "quick");
      assert.deepEqual(saved.models, { quick: ["fixture/chat"] });
      assert.equal(saved.classifier.backend, "typesafe");
      const receiptPath = scope === "user"
        ? join(agentDir, "bifrost-reconcile-ownership.json")
        : join(tempDir, ".pi", "bifrost-reconcile-workspace-ownership.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.deepEqual(receipt, { version: 2, scope, tiers: { quick: { state: "generated", models: ["fixture/chat"] } } });
      const plan = buildInitMembershipPlan({
        source: scope,
        configPath: globalConfig,
        ownershipPath: receiptPath,
        journalPath: join(tempDir, "unused.journal"),
        configBytes: readFileSync(globalConfig),
        ownershipBytes: readFileSync(receiptPath),
      }, [{ provider: "fixture", status: "complete", modelsByTier: { quick: ["fixture/chat", "fixture/new"] } }], () => true);
      assert.equal(plan.status, "ready");
      assert.deepEqual(plan.changes.map(({ kind, tier, modelKey }) => ({ kind, tier, modelKey })),
        [{ kind: "add", tier: "quick", modelKey: "fixture/new" }]);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("disables the classifier for this session without writing runtime preference", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-classifier-off-bootstrap-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      const { ctx, calls, sessionManager } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState(() => false) as any;
      state.bootstrapModelsInMemory = true;
      state.config.default = "quick";
      state.config.models = { quick: ["fixture/chat"] };

      await createCommandRouter(state)("classifier off", ctx);
      await createCommandRouter(state)("classifier test", ctx);

      assert.deepEqual(state.getClassifierEnablementForSession(sessionManager), { enabled: false, source: "session" });
      assert.equal(calls.filter((call) => call.kind === "save").length, 0);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost-state.json")), false);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
      assert.ok(calls.some((call) => call.kind === "notify" && String(call.value).includes("Classifier is disabled")));
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves a user config created while the classifier picker is open", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-classifier-picker-race-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      const configPath = join(tempDir, ".pi", "bifrost.json");
      const manualConfig = {
        default: "general",
        models: { general: ["manual/only"] },
        rules: [{ pattern: "keep this", model: "general" }],
        strictSetting: { keep: true },
      };
      const { ctx } = makeCtx([{ provider: "fixture", id: "chat" }], (title, options) => {
        if (title === "Classifier backend") {
          mkdirSync(join(tempDir, ".pi"), { recursive: true });
          writeFileSync(configPath, JSON.stringify(manualConfig));
          return options.find((option) => option.startsWith("typesafe"));
        }
        return undefined;
      });
      const state = makeState() as any;
      state.bootstrapModelsInMemory = true;
      state.config.default = "quick";
      state.config.models = { quick: ["fixture/chat"] };

      await createCommandRouter(state)("classifier", ctx);

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(saved.default, "general");
      assert.deepEqual(saved.models, { general: ["manual/only"] });
      assert.deepEqual(saved.rules, manualConfig.rules);
      assert.deepEqual(saved.strictSetting, manualConfig.strictSetting);
      assert.equal(saved.classifier.backend, "typesafe");
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("asks once to save during normal init, then reports the detected classifier without another prompt", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-normal-flow-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      let confirmCalls = 0;
      (ctx as any).ui.confirm = async () => { confirmCalls += 1; return true; };
      const state = makeState();
      await createCommandRouter(state as never)("init", ctx as never);
      assert.equal(confirmCalls, 1);
      assert.equal(calls.some((call) => call.kind === "select"), false);
      assert(calls.some(
        (call) =>
          (call.kind === "widget" || call.kind === "notify") &&
          String(call.lines?.join("\n") ?? call.value).includes("Classifier") &&
          String(call.lines?.join("\n") ?? call.value).includes("detected default"),
      ));
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.backend, undefined);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps inherited classifier settings out of a new project config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-classifier-preserve-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      let confirmCalls = 0;
      (ctx as any).ui.confirm = async () => { confirmCalls += 1; return true; };
      const state = makeState();
      (state.config as any).classifier = {
        backend: "typesafe",
        enabled: false,
        model: "fixture/custom-fallback",
        criteria: { general: "Keep this user criterion." },
        typesafe: { model: "jev-1.13.0" },
      };
      await createCommandRouter(state as never)("init", ctx as never);
      assert.equal(confirmCalls, 1);
      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.equal(saved.classifier.enabled, true);
      assert.equal(saved.classifier.backend, undefined);
      assert.equal(saved.classifier.model, undefined);
      assert.equal(saved.classifier.criteria, undefined);
      assert.equal(saved.classifier.typesafe, undefined);
      assert.equal(calls.some((call) => call.kind === "select"), false);
      assert.equal(calls.some((call) => call.kind === "notify" && String(call.value).includes("No working models found for classifier")), false);
      assert(calls.some((call) => call.kind === "widget" && call.lines?.some((line) => line.includes("Classifier  off"))));
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not restore a reliability-excluded probe model as the prompt classifier", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-classifier-cooldown-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      let confirmCalls = 0;
      (ctx as any).ui.confirm = async () => { confirmCalls += 1; return true; };
      const state = makeState() as any;
      state.config.classifier = { backend: "prompt", enabled: true };
      state.reliabilityStore = makeStore({
        "fixture/chat": { failures: [Date.now()], openUntil: Date.now() + 60 * 60_000 },
      });

      await createCommandRouter(state)("init", ctx);

      assert.equal(confirmCalls, 1);
      assert.equal(calls.some((call) => call.kind === "notify" && String(call.value).includes("No working models found for classifier")), false);
      assert(calls.some((call) => call.kind === "widget" && call.lines?.some((line) => line.includes("prompt (no eligible model; regex fallback)"))));
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a replaced init config instead of claiming the files were preserved", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-failure-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      // A journal written before the rename is what makes recovery possible.
      writeFileSync(join(tempDir, "bifrost-reconcile.journal"), "{}");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from("{}\n", "utf8");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /already holds the planned configuration/);
      assert.match(message, /a reconciliation journal is pending/);
      assert.match(message, /\/bifrost config reconcile --recover/);
      assert.doesNotMatch(message, /existing files were preserved/);
      assert.doesNotMatch(message, /nothing to recover/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not promise a pending journal when no journal was written", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-no-journal-"));
    try {
      // An ownership-only plan leaves the config bytes unchanged, so matching
      // bytes prove nothing about whether a journal was staged.
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from("{}\n", "utf8");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.doesNotMatch(message, /a reconciliation journal is pending/);
      assert.match(message, /no reconciliation journal is currently present/);
      assert.match(message, /ownership record does not hold the planned update/);
      assert.match(message, /Inspect .*ownership record before you retry/);
      assert.doesNotMatch(message, /existing files were preserved/);
      assert.doesNotMatch(message, /Retry Init to finish updating the ownership record/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not tell the user to retry a completed save when journal is absent and files match", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-complete-"));
    try {
      // applyReconciliationTransaction removes the journal after installing both
      // files, then validates held locks; a lock-read failure can throw after a
      // complete save with no journal left behind.
      const configPath = join(tempDir, "bifrost.json");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      const nextOwnershipBytes = Buffer.from(JSON.stringify({ version: 1, tiers: {} }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      writeFileSync(ownershipPath, nextOwnershipBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not confirm the reviewed membership update completed/);
      assert.match(message, /no reconciliation journal is currently present/);
      assert.match(message, /ownership record matches the planned update/);
      assert.match(message, /Inspect Init's status before retrying/);
      assert.match(message, /rerunning Init may report that no files were changed/);
      assert.doesNotMatch(message, /Retry Init to finish updating the ownership record/);
      assert.doesNotMatch(message, /a reconciliation journal is pending/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the preserved message when config and ownership do not hold the planned update", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-preserved-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, JSON.stringify({ models: { quick: ["fixture/other"] } }, null, 2) + "\n");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from(JSON.stringify({ version: 1, tiers: {} }, null, 2) + "\n", "utf8");
      writeFileSync(ownershipPath, "{}\n");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.equal(message, "Init could not safely commit the reviewed membership update; existing files were preserved.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not claim preservation when config bytes differ but ownership was updated and no journal remains", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-ownership-complete-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, JSON.stringify({ models: { quick: ["fixture/other"] } }, null, 2) + "\n");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from(JSON.stringify({ version: 1, tiers: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(ownershipPath, nextOwnershipBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /does not hold the planned configuration/);
      assert.match(message, /ownership record matches the planned update/);
      assert.match(message, /no reconciliation journal is currently present/);
      assert.doesNotMatch(message, /existing files were preserved/);
      assert.match(message, /rerunning Init may report that no files were changed/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not report a journal it could not check as absent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-journal-unknown-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath: join(tempDir, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        // A path under a regular file fails lstat with ENOTDIR, not ENOENT.
        journalPath: join(configPath, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.doesNotMatch(message, /no reconciliation journal was written/);
      assert.doesNotMatch(message, /has nothing to recover/);
      assert.match(message, /could not check whether a reconciliation journal is pending/);
      assert.match(message, /reports nothing to recover when no journal exists/);
      assert.match(message, /\/bifrost config reconcile --recover/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not claim preservation when a pending journal means the update may be installed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-preserved-journal-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, JSON.stringify({ models: { quick: ["fixture/other"] } }, null, 2) + "\n");
      writeFileSync(join(tempDir, "bifrost-reconcile.journal"), "{}");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from("{}\n", "utf8");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      // The journal can reach `config_installed` and then conflict, so differing
      // bytes do not prove the config rename never happened. Retrying Init would
      // also hit the existing journal, so recovery must come first.
      assert.doesNotMatch(message, /existing files were preserved/);
      assert.match(message, /does not hold the planned configuration/);
      assert.match(message, /may already be partly installed/);
      assert.match(message, /a reconciliation journal is pending/);
      assert.match(message, /\/bifrost config reconcile --recover/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("promises neither preservation nor replacement when the config cannot be read", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-unreadable-"));
    try {
      // A directory at the config path makes readFileSync throw a non-ENOENT error,
      // the same shape as a disk fault after the rename installed the new config.
      const configPath = join(tempDir, "bifrost.json");
      mkdirSync(configPath);
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from("{}\n", "utf8");
      writeFileSync(ownershipPath, nextOwnershipBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.doesNotMatch(message, /existing files were preserved/);
      assert.doesNotMatch(message, /already holds the planned configuration/);
      assert.match(message, /could not read project \(\.pi\/bifrost\.json\) to check what it now holds/);
      assert.match(message, /ownership record matches the planned update/);
      assert.match(message, /No reconciliation journal is currently present/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats a symlinked config as unknown instead of reading through it", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-symlink-"));
    try {
      const targetPath = join(tempDir, "elsewhere.json");
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(targetPath, nextConfigBytes);
      symlinkSync(targetPath, configPath);
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from("{}\n", "utf8");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      // The error path must not follow a link a concurrent writer swapped in.
      assert.doesNotMatch(message, /already holds the planned configuration/);
      assert.match(message, /could not read project \(\.pi\/bifrost\.json\) to check what it now holds/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the preserved message when the config is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-missing-"));
    try {
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: false,
        configPath: join(tempDir, "bifrost.json"),
        nextConfigBytes: Buffer.from("{}\n", "utf8"),
        ownershipPath: join(tempDir, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.equal(message, "Init could not safely commit the reviewed membership update; existing files were preserved.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not claim a replaced config when init wrote only the ownership receipt", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-receipt-only-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: true,
        configPath,
        nextConfigBytes,
        ownershipPath: join(tempDir, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not finish recording the ownership receipt/);
      assert.match(message, /already holds the planned configuration/);
      assert.match(message, /no reconciliation journal is currently present/);
      assert.match(message, /ownership record does not hold the planned update/);
      assert.doesNotMatch(message, /a reconciliation journal is pending/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports uncertainty when a receipt-only ownership sidecar was created before a later failure", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-receipt-created-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      const nextOwnershipBytes = Buffer.from(JSON.stringify({ version: 1, sources: {} }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      writeFileSync(ownershipPath, nextOwnershipBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: true,
        configPath,
        nextConfigBytes,
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not confirm the ownership receipt was recorded/);
      assert.match(message, /ownership record matches the planned update/);
      assert.doesNotMatch(message, /existing files were preserved/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports pending journal recovery for receipt-only failures when ownership is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-receipt-journal-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, JSON.stringify({ models: { quick: ["fixture/other"] } }, null, 2) + "\n");
      writeFileSync(join(tempDir, "bifrost-reconcile.journal"), "{}");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: true,
        configPath,
        nextConfigBytes,
        ownershipPath: join(tempDir, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /a reconciliation journal is pending/);
      assert.match(message, /\/bifrost config reconcile --recover/);
      assert.match(message, /may already be partly installed/);
      assert.doesNotMatch(message, /existing files were preserved/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports uncertainty for receipt-only failures when ownership matches but config is unreadable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-receipt-unreadable-config-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      mkdirSync(configPath);
      const ownershipPath = join(tempDir, "bifrost-reconcile-ownership.json");
      const nextOwnershipBytes = Buffer.from(JSON.stringify({ version: 1, sources: {} }, null, 2) + "\n", "utf8");
      writeFileSync(ownershipPath, nextOwnershipBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: true,
        configPath,
        nextConfigBytes: Buffer.from("{}\n", "utf8"),
        ownershipPath,
        nextOwnershipBytes,
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not read project \(\.pi\/bifrost\.json\) to check what it now holds/);
      assert.match(message, /ownership record matches the planned update/);
      assert.doesNotMatch(message, /already holds the planned configuration/);
      assert.doesNotMatch(message, /existing files were preserved/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports recovery advice for receipt-only failures when journal state is unknown", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-receipt-unknown-journal-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from(JSON.stringify({ models: { quick: ["fixture/chat"] } }, null, 2) + "\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: true,
        configPath,
        nextConfigBytes,
        ownershipPath: join(tempDir, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        journalPath: join(configPath, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not check whether a reconciliation journal is pending/);
      assert.match(message, /reports nothing to recover when no journal exists/);
      assert.match(message, /\/bifrost config reconcile --recover/);
      assert.doesNotMatch(message, /no reconciliation journal is currently present/);
      assert.doesNotMatch(message, /existing files were preserved/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not contradict verified absent-journal state for receipt-only failures when config and ownership are unknown", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-receipt-absent-journal-unknown-state-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      mkdirSync(configPath);
      const ownershipParent = join(tempDir, "not-a-directory");
      writeFileSync(ownershipParent, "not a directory");
      const message = describeInitCommitFailure({
        locked: false,
        receiptOnly: true,
        configPath,
        nextConfigBytes: Buffer.from("{}\n", "utf8"),
        ownershipPath: join(ownershipParent, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not read project \(\.pi\/bifrost\.json\) to check what it now holds/);
      assert.match(message, /No reconciliation journal is currently present/);
      assert.match(message, /ownership record could not be checked/);
      assert.doesNotMatch(message, /could not check whether a reconciliation journal is pending/);
      assert.doesNotMatch(message, /existing files were preserved/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a lock failure before it inspects the config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-commit-locked-"));
    try {
      const configPath = join(tempDir, "bifrost.json");
      const nextConfigBytes = Buffer.from("{}\n", "utf8");
      writeFileSync(configPath, nextConfigBytes);
      const message = describeInitCommitFailure({
        locked: true,
        receiptOnly: false,
        configPath,
        nextConfigBytes,
        ownershipPath: join(tempDir, "bifrost-reconcile-ownership.json"),
        nextOwnershipBytes: Buffer.from("{}\n", "utf8"),
        journalPath: join(tempDir, "bifrost-reconcile.journal"),
        target: "project (.pi/bifrost.json)",
        recoveryCommand: "/bifrost config reconcile --recover",
      });
      assert.match(message, /could not acquire reconciliation locks/);
      assert.doesNotMatch(message, /already holds the new memberships/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("advertises every reconcile source the parser accepts", async () => {
    const { ctx, calls } = makeCtx();
    await createCommandRouter(makeState() as never)("config reconcile --source nowhere", ctx as never);
    const usage = calls
      .filter((call) => call.kind === "notify")
      .map((call) => String(call.value))
      .find((message) => message.includes("usage: /bifrost config reconcile"));
    assert.ok(usage !== undefined, JSON.stringify(calls));
    // ReconciliationConfigSource is "project" | "workspace" | "user"; the usage
    // string once omitted workspace, so the conflict footer's advice looked invalid.
    for (const source of ["project", "workspace", "user"]) {
      assert.ok(usage.includes(source), `usage does not mention ${source}: ${usage}`);
    }
  });

  it("builds source-specific init recovery commands for all reconciliation sources", () => {
    assert.equal(initRecoveryCommand("project"), "/bifrost config reconcile --recover");
    assert.equal(initRecoveryCommand("workspace"), "/bifrost config reconcile --source workspace --recover");
    assert.equal(initRecoveryCommand("user"), "/bifrost config reconcile --source user --recover");
  });

  it("reconciles generated memberships from a recent probe cache and keeps manual config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-refresh-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const piDir = join(tempDir, ".pi");
      mkdirSync(piDir);
      writeFileSync(join(piDir, "bifrost.json"), JSON.stringify({
        enabled: true,
        models: { quick: ["fixture/old", "manual/keep"] },
        classifier: { backend: "prompt", enabled: false, model: "fixture/manual-classifier" },
        customSetting: { preserve: true },
      }, null, 2));
      writeFileSync(join(piDir, "bifrost-reconcile-ownership.json"), JSON.stringify(
        buildInitOwnershipReceipt("project", { quick: ["fixture/old"] }),
      ));
      writeRecentProbeCache(join(piDir, "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx(
        [{ provider: "fixture", id: "chat" }],
        (_title, options) => options.find((option) => option.startsWith("Keep my models")),
      );
      let refreshCalls = 0;
      const registry = (ctx as any).modelRegistry;
      registry.getAll = () => [{ provider: "fixture", id: "chat", api: "openai-completions", cost: { input: 0.2, output: 0.2 } }];
      registry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
      registry.refresh = async () => { refreshCalls += 1; return { aborted: false, errors: new Map() }; };
      let confirmCalls = 0;
      (ctx as any).ui.confirm = async () => { confirmCalls += 1; return true; };
      await createCommandRouter(makeState() as never)("init", ctx as never);
      const saved = JSON.parse(readFileSync(join(piDir, "bifrost.json"), "utf8"));
      assert.equal(confirmCalls, 0);
      assert.equal(refreshCalls, 1);
      assert.ok(calls.some((call) => call.kind === "select" && call.title === "How should init update your model pools?"));
      assert.deepEqual(saved.models.quick, ["fixture/old", "manual/keep"]);
      assert.deepEqual(saved.customSetting, { preserve: true });
      assert.deepEqual(saved.classifier, { backend: "prompt", enabled: false, model: "fixture/manual-classifier" });
      assert.equal(calls.some((call) => call.kind === "notify" && String(call.value).includes("Probing models")), false);
      assert.equal(calls.some((call) => call.kind === "select"), false);
      const reusedNotice = calls.find((call) => call.kind === "notify" && String(call.value).includes("saved probe results"));
      assert.ok(reusedNotice, "expected saved probe provenance in init output");
      assert.match(String(reusedNotice?.value), /Using 1 saved probe results \(\d+[smhd.]+ old\)\. Run \/bifrost init -f to check again\./);
      assert.doesNotMatch(String(reusedNotice?.value), /file mtime|provider-data freshness|registry refresh and other commands may still use network/i);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports cached report provenance when a reused complete report has no usable models", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-cached-all-failed-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const piDir = join(tempDir, ".pi");
      mkdirSync(piDir);
      writeRecentProbeCache(join(piDir, "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "error", error: "provider rejected probe", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      let probes = 0;
      (ctx as any).modelRegistry.streamSimple = () => { probes++; return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop" }) }; };
      await createCommandRouter(makeState() as never)("init", ctx as never);
      assert.equal(probes, 0, "cached all-failed report must not trigger new probes");
      const notices = calls.filter((call) => call.kind === "notify").map((call) => String(call.value));
      const error = notices.find((value) => value.includes("No usable models found in saved probe results"));
      assert.ok(error, `expected cached provenance on no-usable-models exit, got: ${JSON.stringify(notices)}`);
      assert.match(error ?? "", /No usable models found in saved probe results \(\d+[smhd.]+ old\)\. Run \/bifrost init -f after checking access\. Configuration unchanged\./);
      assert.doesNotMatch(error ?? "", /file mtime|provider-data freshness|registry refresh and other commands may still use network/i);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-probes malformed or incomplete recent caches instead of accepting a partial pool", async () => {
    const invalidReports: unknown[] = [
      [],
      [{ provider: "fixture", model: "one", status: "ok" }],
      [
        { provider: "fixture", model: "one", status: "ok" },
        { provider: "fixture", model: "one", status: "ok" },
      ],
      [
        { provider: "fixture", model: "one", status: "ok" },
        { provider: "fixture", model: "unknown", status: "ok" },
      ],
    ];
    for (const invalidReport of invalidReports) {
      const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-invalid-cache-"));
      const previousCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const piDir = join(tempDir, ".pi");
        mkdirSync(piDir);
        writeRecentProbeCache(join(piDir, "bifrost-probe.json"), invalidReport);
        const models = [makeModel("fixture", "one"), makeModel("fixture", "two")];
        const { ctx } = makeCtx(models);
        let probes = 0;
        const registry = (ctx as any).modelRegistry;
        registry.streamSimple = (model: { provider: string; id: string; api: string }) => {
          probes++;
          return { result: async () => ({
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop", timestamp: Date.now(),
          }) };
        };
        await createCommandRouter(makeState() as never)("init --write", ctx as never);
        assert.equal(probes, 2);
        const cached = JSON.parse(readFileSync(join(piDir, "bifrost-probe.json"), "utf8")) as Array<{ model: string; status: string }>;
        assert.deepEqual(cached.map((row) => [row.model, row.status]), [["one", "ok"], ["two", "ok"]]);
      } finally {
        process.chdir(previousCwd);
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-malformed-cache-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const piDir = join(tempDir, ".pi");
      mkdirSync(piDir);
      const cachePath = join(piDir, "bifrost-probe.json");
      writeFileSync(cachePath, "not-json");
      const models = [makeModel("fixture", "one"), makeModel("fixture", "two")];
      const { ctx } = makeCtx(models);
      let probes = 0;
      const registry = (ctx as any).modelRegistry;
      registry.streamSimple = (model: { provider: string; id: string; api: string }) => {
        probes++;
        return { result: async () => ({
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop", timestamp: Date.now(),
        }) };
      };
      await createCommandRouter(makeState() as never)("init --write", ctx as never);
      assert.equal(probes, 2);
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Array<{ model: string; status: string }>;
      assert.deepEqual(cached.map((row) => [row.model, row.status]), [["one", "ok"], ["two", "ok"]]);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes and reuses the probe cache in the active project when ctx.cwd differs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-project-cache-path-"));
    const otherCwd = mkdtempSync(join(tmpdir(), "bifrost-init-context-cwd-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      const { ctx } = makeCtx([makeModel("fixture", "chat")]);
      (ctx as any).cwd = otherCwd;
      let probes = 0;
      (ctx as any).modelRegistry.streamSimple = (model: { provider: string; id: string; api: string }) => {
        probes++;
        return { result: async () => ({
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop", timestamp: Date.now(),
        }) };
      };
      const state = makeState() as never;
      await createCommandRouter(state)("probe", ctx as never);
      const projectCache = join(tempDir, ".pi", "bifrost-probe.json");
      const originalCache = readFileSync(projectCache, "utf8");
      assert.equal(existsSync(join(otherCwd, ".pi", "bifrost-probe.json")), false);
      assert.equal(probes, 1);

      await createCommandRouter(state)("init --write", ctx as never);
      assert.equal(probes, 1);
      assert.equal(readFileSync(projectCache, "utf8"), originalCache);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("skips the save question when refreshed inventory is incomplete", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-incomplete-inventory-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const piDir = join(tempDir, ".pi");
      mkdirSync(piDir);
      writeFileSync(join(piDir, "bifrost.json"), JSON.stringify({ models: { quick: ["fixture/old"] } }));
      writeFileSync(join(piDir, "bifrost-reconcile-ownership.json"), JSON.stringify(
        buildInitOwnershipReceipt("project", { quick: ["fixture/old"] }),
      ));
      writeRecentProbeCache(join(piDir, "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const registry = (ctx as any).modelRegistry;
      registry.getAll = () => [makeModel("fixture", "chat", 0.2, 0.2)];
      registry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
      registry.refresh = async () => ({ aborted: false, errors: new Map([["fixture", new Error("partial")]]) });
      let confirmCalls = 0;
      (ctx as any).ui.confirm = async () => { confirmCalls += 1; return true; };

      await createCommandRouter(makeState() as never)("init", ctx as never);

      assert.equal(confirmCalls, 0);
      assert.equal(readFileSync(join(piDir, "bifrost.json"), "utf8"), JSON.stringify({ models: { quick: ["fixture/old"] } }));
      assert.ok(calls.some((call) => call.kind === "notify" && String(call.value).includes("inventory is incomplete or stale")));
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

  it("renders five distinct confidences each as its own exact value in preview, trace, and failure views", async () => {
    const confidences = [0, 0.42, 0.73, 0.999, 1];
    const attemptLines = (lines: string[]) => lines.filter((line) => line.startsWith("classifier attempt confidence:"));

    for (const confidence of confidences) {
      const attempt = {
        backend: "pi-native" as const,
        outcome: "low_confidence" as const,
        fallbackKind: "default" as const,
        model: "jev-1.13.0",
        confidence,
      };
      const expected = [`classifier attempt confidence: ${confidence}`];

      const report = buildPreviewReport({
        prompt: `prompt ${confidence}`,
        classification: { kind: "fallback", tier: "general", classifierAttempt: attempt },
        display,
      });
      assert.equal(report.classifierAttempt?.confidence, confidence);
      assert.deepEqual(attemptLines(renderPreviewReport(report)), expected);

      const trace = buildTracePreview(buildRouteDecisionSummary({ kind: "fallback", tier: "general", classifierAttempt: attempt }), true);
      assert.deepEqual(attemptLines(renderTracePreview(trace)), expected);

      const state = makeState();
      state.getPipeline = () => ({ classify: async () => ({ kind: "unclassified" as const, classifierAttempt: attempt }) }) as never;
      const { ctx } = makeCtx();
      const failureText = await captureCommandText(async () => {
        await createCommandRouter(state as never)("preview hello", printModeCtx({ ...(ctx as any), hasUI: false }) as never);
      });
      assert.deepEqual(attemptLines(failureText), expected);
    }
  });

  it("does not repeat an accepted classifier attempt the classification lines already state", () => {
    const classification = {
      kind: "classified" as const,
      tier: "quick",
      source: "classifier" as const,
      judgment: { tier: "quick", backend: "pi-native" as const, model: "jev-1.13.0", confidence: 0.93 },
      classifierAttempt: {
        backend: "pi-native" as const,
        outcome: "success" as const,
        fallbackKind: "none" as const,
        model: "jev-1.13.0",
        confidence: 0.93,
      },
    };

    const report = buildPreviewReport({ prompt: "p", classification, display });
    // Suppression is a text-view decision: the machine-readable report keeps the
    // attempt, so a JSON consumer can still see what was recorded.
    assert.equal(report.classifierAttempt?.confidence, 0.93);
    const preview = renderPreviewReport(report);
    assert(preview.includes("confidence: 0.93"));
    assert.equal(preview.some((line) => line.startsWith("classifier attempt")), false);

    const trace = renderTracePreview(buildTracePreview(buildRouteDecisionSummary(classification), true));
    assert(trace.includes("classifier confidence: 0.93"));
    assert.equal(trace.some((line) => line.startsWith("classifier attempt")), false);
  });

  it("names the tier a rejected attempt proposed in preview text, trace text and JSON", () => {
    const classification = {
      kind: "fallback" as const,
      tier: "frontier",
      classifierAttempt: {
        backend: "typesafe" as const,
        outcome: "low_confidence" as const,
        fallbackKind: "default" as const,
        tier: "quick",
        model: "jev-1.13.0",
        confidence: 0.73,
      },
    };

    const report = buildPreviewReport({ prompt: "p", classification, display });
    assert.equal(report.classifierAttempt?.tier, "quick");
    assert(renderPreviewReport(report).includes("classifier attempt tier: quick"));
    assert(renderTracePreview(buildTracePreview(buildRouteDecisionSummary(classification), true)).includes("classifier attempt tier: quick"));
  });

  it("keeps a successful attempt when its confidence differs from the classification", () => {
    // Not produced by today's pipeline, which copies one value into both fields.
    // The renderer must still prefer a visible divergence over a silent one.
    const classification = {
      kind: "classified" as const,
      tier: "quick",
      source: "classifier" as const,
      judgment: { tier: "quick", backend: "pi-native" as const, model: "jev-1.13.0", confidence: 0.93 },
      classifierAttempt: {
        backend: "pi-native" as const,
        outcome: "success" as const,
        fallbackKind: "none" as const,
        model: "jev-1.13.0",
        confidence: 0.42,
      },
    };

    const preview = renderPreviewReport(buildPreviewReport({ prompt: "p", classification, display }));
    assert(preview.includes("classifier attempt confidence: 0.42"));

    const trace = renderTracePreview(buildTracePreview(buildRouteDecisionSummary(classification), true));
    assert(trace.includes("classifier attempt confidence: 0.42"));
  });

  it("keeps a successful attempt whose model the classification did not report", () => {
    // Synthetic renderer guard, not a reachable pi-native response: the decoder
    // fills the resolved catalog id when the API judgment omits `model`
    // (classifier-pi-native.ts:158), so the accepted classification carries it
    // as well. The renderer must still not drop a model only it holds.
    const classification = {
      kind: "classified" as const,
      tier: "quick",
      source: "classifier" as const,
      judgment: { tier: "quick", backend: "pi-native" as const, confidence: 0.93 },
      classifierAttempt: {
        backend: "pi-native" as const,
        outcome: "success" as const,
        fallbackKind: "none" as const,
        model: "catalog/resolved-model",
        confidence: 0.93,
      },
    };

    const preview = renderPreviewReport(buildPreviewReport({ prompt: "p", classification, display }));
    assert(preview.includes("classifier attempt model: catalog/resolved-model"));

    const trace = renderTracePreview(buildTracePreview(buildRouteDecisionSummary(classification), true));
    assert(trace.includes("classifier attempt model: catalog/resolved-model"));
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

  it("carries rejected classifier-attempt detail on unclassified failures without fabricating acceptance", () => {
    const attempt = {
      backend: "pi-native" as const,
      outcome: "low_confidence" as const,
      fallbackKind: "none" as const,
      model: "fixture/prompt",
      confidence: 0.73,
    };
    assert.deepEqual(buildPreviewFailure("hello", "unclassified", attempt), {
      ok: false,
      prompt: "hello",
      error: "unclassified",
      classifierAttempt: attempt,
    });
  });

  it("serializes to one parseable line", () => {
    const line = serializePreviewReport(buildPreviewFailure("hello", "unclassified"));

    assert.equal(line.split("\n").length, 1);
    assert.deepEqual(JSON.parse(line), { ok: false, prompt: "hello", error: "unclassified" });
  });

  it("serializes unclassified rejected-attempt confidence without implying acceptance", () => {
    const line = serializePreviewReport(buildPreviewFailure("hello", "unclassified", {
      backend: "pi-native",
      outcome: "low_confidence",
      fallbackKind: "none",
      model: "fixture/prompt",
      confidence: 0.73,
    }));
    assert.deepEqual(JSON.parse(line), {
      ok: false,
      prompt: "hello",
      error: "unclassified",
      classifierAttempt: {
        backend: "pi-native",
        outcome: "low_confidence",
        fallbackKind: "none",
        model: "fixture/prompt",
        confidence: 0.73,
      },
    });
  });
});

describe("preview command hint", () => {
  it("advertises preview flags in the dashboard menu row", async () => {
    const { ctx, calls } = makeCtx();
    const dispatch = createCommandRouter(makeState() as never);

    await dispatch("", ctx as never);

    const select = calls.find((call) => call.kind === "select");
    const rows = select?.options ?? [];
    assert(
      rows.includes("/bifrost preview [--offline] [--trace] [--json] <prompt> — Preview routing for a prompt"),
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
    assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("No configured tier matched")));
  });

  it("surfaces rejected direct-classifier confidence in unclassified /bifrost preview --json, text, and trace", async () => {
    const attempt = {
      backend: "pi-native" as const,
      outcome: "low_confidence" as const,
      fallbackKind: "none" as const,
      model: "fixture/prompt",
      confidence: 0.73,
    };
    const classification = { kind: "unclassified" as const, classifierAttempt: attempt };
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.getPipeline = () => ({ classify: async () => classification }) as never;

    const [jsonReport] = await captureJsonReports(async () => {
      await createCommandRouter(state as never)("preview --json hello", ctx as never);
    });

    assert.deepEqual(jsonReport, {
      ok: false,
      prompt: "hello",
      error: "unclassified",
      classifierAttempt: attempt,
    });
    assert.equal("backend" in (jsonReport as Record<string, unknown>), false);
    assert.equal("confidence" in (jsonReport as Record<string, unknown>), false);
    assert.equal("tier" in (jsonReport as Record<string, unknown>), false);
    assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("no tier matched")));

    const { ctx: textCtx } = makeCtx();
    const text = (await captureCommandText(async () => {
      await createCommandRouter(state as never)("preview hello", printModeCtx({ ...(textCtx as any), hasUI: false }) as never);
    })).join("\n");
    assert.match(text, /--- preview ---/u);
    assert.match(text, /source:    unclassified/u);
    assert.match(text, /classifier attempt: pi-native \(low_confidence, fallback=none\)/u);
    assert.match(text, /classifier attempt confidence: 0\.73/u);
    assert.match(text, /result:    unclassified/u);
    assert.doesNotMatch(text, /^backend:/mu);
    assert.doesNotMatch(text, /^confidence:/mu);
    assert.match(text, /no tier matched/u);

    const [traceJson] = await captureJsonReports(async () => {
      await createCommandRouter(state as never)("preview --trace --json hello", ctx as never);
    }) as Array<Record<string, any>>;
    assert.equal(traceJson.outcome, "unclassified");
    assert.deepEqual(traceJson.classification, { source: "unclassified" });
    assert.deepEqual(traceJson.classifierAttempt, attempt);
    assert.equal((traceJson.classification as { classifier?: unknown }).classifier, undefined);
    const traceText = (await captureCommandText(async () => {
      await createCommandRouter(state as never)("preview --trace hello", printModeCtx({ ...(ctx as any), hasUI: false }) as never);
    })).join("\n");
    assert.match(traceText, /outcome: unclassified/u);
    assert.match(traceText, /^classifier attempt confidence: 0\.73$/mu);
  });

  it("preserves zero and missing rejected confidence on unclassified preview JSON and trace", async () => {
    for (const attempt of [
      { backend: "pi-native" as const, outcome: "low_confidence" as const, fallbackKind: "none" as const, model: "fixture/prompt", confidence: 0 },
      { backend: "typesafe" as const, outcome: "timeout" as const, fallbackKind: "none" as const },
    ]) {
      const classification = { kind: "unclassified" as const, classifierAttempt: attempt };
      const { ctx } = makeCtx();
      const state = makeState();
      state.getPipeline = () => ({ classify: async () => classification }) as never;
      const dispatch = createCommandRouter(state as never);

      const [jsonReport] = await captureJsonReports(async () => {
        await dispatch("preview --json hello", ctx as never);
      }) as Array<Record<string, any>>;
      assert.equal(jsonReport.ok, false);
      assert.equal(jsonReport.error, "unclassified");
      assert.equal(jsonReport.classifierAttempt?.backend, attempt.backend);
      if ("confidence" in attempt) assert.equal(jsonReport.classifierAttempt?.confidence, 0);
      else assert.equal("confidence" in (jsonReport.classifierAttempt ?? {}), false);

      const [traceJson] = await captureJsonReports(async () => {
        await dispatch("preview --trace --json hello", ctx as never);
      }) as Array<Record<string, any>>;
      if ("confidence" in attempt) assert.equal(traceJson.classifierAttempt?.confidence, 0);
      else assert.equal("confidence" in (traceJson.classifierAttempt ?? {}), false);
    }
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

  it("labels a provider-scope exclusion in the preview candidate list", async () => {
    const { ctx } = makeCtx([makeModel("fixture", "allowed-model")]);
    const state = makeState();
    Object.assign(state.config, {
      schemaVersion: 2,
      models: { general: ["allowed-model"] },
      default: undefined,
      routingScope: { providers: ["other"] },
    });
    state.getPipeline = () => ({
      classify: async () => ({ kind: "classified" as const, tier: "general", source: "regex" }),
    }) as never;
    const dispatch = createCommandRouter(state as never);

    const [report] = await captureJsonReports(async () => {
      await dispatch("preview --json hello", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.deepEqual(report.requestedCandidates, ["xx fixture/allowed-model (provider not allowed)"]);
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

  it("accepts offline with the other leading flags and leaves unknown flags as prompt text", () => {
    assert.deepEqual(parsePreviewArgs("preview --offline --trace --json fix the bug", "preview"), {
      prompt: "fix the bug", json: true, trace: true, offline: true,
    });
    assert.deepEqual(parsePreviewArgs("preview --json --offline fix it", "preview"), {
      prompt: "fix it", json: true, offline: true,
    });
    assert.deepEqual(parsePreviewArgs("preview --unknown keep this", "preview"), {
      prompt: "--unknown keep this", json: false,
    });
    assert.deepEqual(parsePreviewArgs("preview --offline --offline keep this", "preview"), {
      prompt: "--offline keep this", json: false, offline: true,
    });
  });
});

describe("preview route trace", () => {
  it("blocks preview and emits a content-free config error for every invalid policy flag", async () => {
    for (const key of ["tierPolicyValid", "economicPolicyValid", "reliabilityV2ConfigValid", "affinityConfigValid"] as const) {
      const { ctx, calls } = makeCtx();
      const state = makeState() as any;
      state[key] = false;
      let classifyCalls = 0;
      state.getPipeline = () => ({ classify: async () => {
        classifyCalls++;
        return { kind: "fallback" as const, tier: "general" };
      } });
      const dispatch = createCommandRouter(state);
      const [trace] = await captureJsonReports(async () => {
        await dispatch("preview --trace --json PRIVATE_PROMPT_CANARY", ctx as never);
      }) as Array<Record<string, any>>;

      assert.equal(classifyCalls, 0, `${key} must block preview classification`);
      assert.equal(trace.outcome, "config_invalid");
      assert.equal(trace.error, "config_invalid");
      assert.deepEqual(trace.classification, { source: "unclassified" });
      assert.deepEqual(trace.classifierDisclosure, { enabled: false, configuredClassifierMayReceivePrompt: false });
      assert.equal(JSON.stringify(trace).includes("PRIVATE_PROMPT_CANARY"), false);
      assert(calls.some((call) => String(call.value).includes("configuration source is invalid")));
    }
  });

  it("marks offline traces as unable to send the prompt to a classifier", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    let options: unknown;
    state.getPipeline = () => ({
      classify: async (_prompt: string, _signal?: AbortSignal, classificationOptions?: unknown) => {
        options = classificationOptions;
        return { kind: "fallback" as const, tier: "general" };
      },
    }) as never;
    const dispatch = createCommandRouter(state as never);
    const [trace] = await captureJsonReports(async () => {
      await dispatch("preview --offline --trace --json private prompt words", ctx as never);
    }) as Array<Record<string, unknown>>;

    assert.deepEqual(options, { offline: true });
    assert.deepEqual(trace.classifierDisclosure, { enabled: false, configuredClassifierMayReceivePrompt: false });
  });

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
  it("does not save when an inherited config appears during init confirmation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-inherited-race-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      mkdirSync(agentDir);
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      (ctx as any).ui.confirm = async () => {
        writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ models: { quick: ["manual/keep"] } }));
        return true;
      };
      await createCommandRouter(makeState() as never)("init", ctx);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
      assert.ok(
        calls.some((call) =>
          String(call.value).includes("init: stale review. Nothing was saved; your inherited config changed"),
        ),
        JSON.stringify(calls),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not save when an inherited ownership receipt disappears during init confirmation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-receipt-race-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      mkdirSync(agentDir);
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ models: { quick: ["manual/keep"] } }));
      writeFileSync(join(agentDir, "bifrost-reconcile-ownership.json"), JSON.stringify(
        buildInitOwnershipReceipt("user", { quick: ["manual/keep"] }),
      ));
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      (ctx as any).ui.confirm = async () => {
        rmSync(join(agentDir, "bifrost-reconcile-ownership.json"));
        return true;
      };
      await createCommandRouter(makeState() as never)("init", ctx);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
      assert.ok(
        calls.some((call) =>
          String(call.value).includes("init: stale review. Nothing was saved; your inherited config changed"),
        ),
        JSON.stringify(calls),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears the probe widget when init exits after probing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-widget-clear-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      mkdirSync(agentDir);
      // No probe cache: init must run a real probe so the bifrost-probe widget gets set.
      const { ctx, calls } = makeCtx([makeModel("fixture", "chat")]);
      (ctx as any).modelRegistry.streamSimple = (model: { provider: string; id: string; api: string }) => ({
        result: async () => ({
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop", timestamp: Date.now(),
        }),
      });
      (ctx as any).ui.confirm = async () => {
        // Inherited config appears while the dialog is open: init aborts after probing.
        writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ models: { quick: ["manual/keep"] } }));
        return true;
      };
      await createCommandRouter(makeState() as never)("init", ctx as never);
      const probeWidgetCalls = calls.filter((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-probe:"));
      assert.ok(probeWidgetCalls.length > 0, "probe widget was never set");
      const last = probeWidgetCalls[probeWidgetCalls.length - 1]!;
      assert.notEqual(last.value, "bifrost-probe:func", "probe widget was not cleared after probing");
      assert.ok(
        last.lines === undefined || last.lines.length === 0,
        "probe widget was not cleared after probing",
      );
      assert.ok(
        calls.some((call) =>
          String(call.value).includes("init: stale review. Nothing was saved; your inherited config changed"),
        ),
        JSON.stringify(calls),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("shows the selected init destination in the confirmation and respects cancellation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-confirm-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      (ctx as any).ui.confirm = async () => false;
      for (const args of ["init", "init -g"]) {
        await createCommandRouter(makeState() as never)(args, ctx);
      }
      const previewLines = calls
        .filter((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-output:"))
        .flatMap((call) => call.lines ?? []);
      assert.ok(previewLines.some((line) => line.includes("project (.pi/bifrost.json)")), previewLines.join("\n"));
      assert.ok(previewLines.some((line) => line.includes("user (")), previewLines.join("\n"));
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
      assert.equal(existsSync(join(tempDir, "bifrost.json")), false);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses headless init before refresh, probing, or bootstrap cancellation", async () => {
    for (const args of ["init", "init -f", "init -g", "init -g -f"]) {
      const { ctx } = makeCtx([makeModel("fixture", "chat")]);
      const state = makeState();
      let refreshes = 0;
      let probes = 0;
      let initStarts = 0;
      (ctx as any).hasUI = false;
      (ctx as any).mode = "print";
      (ctx as any).modelRegistry.refresh = async () => { refreshes++; };
      (ctx as any).modelRegistry.streamSimple = () => { probes++; throw new Error("unexpected probe"); };
      (state as any).onInitStarted = () => { initStarts++; };
      await createCommandRouter(state as never)(args, ctx);
      assert.deepEqual({ refreshes, probes, initStarts }, { refreshes: 0, probes: 0, initStarts: 0 }, args);
    }
  });

  it("rejects invalid selected and inherited sources before discovery", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-preflight-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      mkdirSync(join(tempDir, "agent"));
      for (const [args, path] of [
        ["init --write", join(tempDir, ".pi", "bifrost.json")],
        ["init --write", join(tempDir, "agent", "bifrost.json")],
        ["init -g --write", join(tempDir, "agent", "bifrost.json")],
      ]) {
        writeFileSync(path, "{invalid");
        const { ctx, calls } = makeCtx([makeModel("fixture", "chat")]);
        let refreshes = 0;
        let probes = 0;
        (ctx as any).modelRegistry.refresh = async () => { refreshes++; };
        (ctx as any).modelRegistry.streamSimple = () => { probes++; throw new Error("unexpected probe"); };
        await createCommandRouter(makeState() as never)(args, ctx as never);
        assert.deepEqual({ refreshes, probes }, { refreshes: 0, probes: 0 }, args);
        assert.ok(calls.some((call) => String(call.value).includes("init: blocked")), JSON.stringify(calls));
        assert.equal(readFileSync(path, "utf8"), "{invalid");
        rmSync(path);
      }
      const invalidPools = Buffer.from('{"models":[]}\n');
      const targetPath = join(tempDir, ".pi", "bifrost.json");
      writeFileSync(targetPath, invalidPools);
      const { ctx, calls } = makeCtx([makeModel("fixture", "chat")]);
      let refreshes = 0;
      let probes = 0;
      (ctx as any).modelRegistry.refresh = async () => { refreshes++; };
      (ctx as any).modelRegistry.streamSimple = () => { probes++; throw new Error("unexpected probe"); };
      await createCommandRouter(makeState() as never)("init --write", ctx as never);
      assert.deepEqual({ refreshes, probes }, { refreshes: 0, probes: 0 });
      assert.deepEqual(readFileSync(targetPath), invalidPools);
      assert.ok(calls.some((call) => String(call.value).includes("init: blocked")));
      rmSync(targetPath);
      const invalidInherited = Buffer.from('{"models":[]}\n');
      const globalPath = join(tempDir, "agent", "bifrost.json");
      writeFileSync(globalPath, invalidInherited);
      const inheritedCtx = makeCtx([makeModel("fixture", "chat")]).ctx;
      let inheritedRefreshes = 0;
      let inheritedProbes = 0;
      (inheritedCtx as any).modelRegistry.refresh = async () => { inheritedRefreshes++; };
      (inheritedCtx as any).modelRegistry.streamSimple = () => { inheritedProbes++; throw new Error("unexpected probe"); };
      await createCommandRouter(makeState() as never)("init --write", inheritedCtx as never);
      assert.deepEqual({ inheritedRefreshes, inheritedProbes }, { inheritedRefreshes: 0, inheritedProbes: 0 });
      assert.deepEqual(readFileSync(globalPath), invalidInherited);
      assert.equal(existsSync(targetPath), false);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ends every init exit on the terminal footer standard", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-footer-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const router = createCommandRouter(makeState() as never);
      await router("init --bogus", ctx as never);
      (ctx as any).ui.confirm = async () => false;
      await router("init", ctx as never);
      (ctx as any).ui.confirm = async () => true;
      await router("init --write", ctx as never);
      const notices = calls
        .filter((call) => call.kind === "notify")
        .map((call) => String(call.value));
      // #245: `init: <outcome>. <what changed>. <one next step>`, TUI and headless.
      assert.equal(
        notices.find((notice) => notice.includes("init: not started.")),
        "warning:init: not started. Nothing was read or written. Usage: /bifrost init [-f] [--write] [-g].",
      );
      assert.equal(
        notices.find((notice) => notice.includes("init: declined.")),
        "info:init: declined. Nothing was saved; recent probe results are reused for an hour unless you pass -f or the catalog changes. Run /bifrost init again to review and save.",
        JSON.stringify(notices),
      );
      assert.ok(
        // notify() has no "success" type, so a saved footer arrives as info there.
        notices.some((notice) => notice.includes("init: saved. Saved ") && notice.endsWith("Send a prompt to try it.")),
        JSON.stringify(notices),
      );
      // No exit may keep its old ad-hoc title: the footer is the only terminus.
      assert.ok(
        !notices.some((notice) =>
          /No usable models found|Setup cancelled|Init blocked|No updates needed|Save unavailable|Bifrost initialized/.test(notice),
        ),
        JSON.stringify(notices),
      );
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("makes a new init exit report an outcome or fail this test", () => {
    // The footer contract is "every exit", so guard the source, not a denylist of
    // strings a previous exit used: a newly added bare `return;` is the regression.
    const source = readFileSync(new URL("../commands.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function handleInit(");
    assert.notEqual(start, -1, "handleInit must exist in commands.ts");
    const end = source.indexOf("\nfunction increasedMetric(", start);
    assert.notEqual(end, -1, "handleInit boundary not found");
    const body = source.slice(start, end).split("\n");
    // `if (cond) return;` is the dominant exit form in this function, so match
    // any line that ends in a bare return rather than only `return;` alone.
    const exits = body
      .map((line, index) => ({ index, text: line.trim() }))
      .filter(({ text }) => text.endsWith("return;"));
    assert.ok(exits.length >= 20, `expected many init exits, found ${exits.length}`);
    for (const { index } of exits) {
      const preceding = body.slice(Math.max(0, index - 12), index).join("\n");
      assert.ok(
        preceding.includes("reportInitOutcome("),
        `init exit at handleInit+${index} returns without reporting an outcome`,
      );
    }
  });

  it("does not claim routing is active after saving while it is off", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-footer-off-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      // /bifrost off persists enabled:false, and init reloads that state.
      writeFileSync(join(tempDir, ".pi", "bifrost-state.json"), JSON.stringify({ enabled: false }));
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState();
      await createCommandRouter(state as never)("init --write", ctx as never);
      const notices = calls
        .filter((call) => call.kind === "notify")
        .map((call) => String(call.value));
      assert.equal((state as { enabled?: boolean }).enabled, false, "init must not switch routing on");
      const saved = notices.find((notice) => notice.includes("init: saved."));
      assert.ok(saved?.includes("but routing is off"), JSON.stringify(notices));
      assert.ok(saved?.endsWith("Run /bifrost on to route prompts."), JSON.stringify(notices));
      assert.ok(!saved?.includes("Bifrost is active"), JSON.stringify(notices));
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
      const state = makeState();
      // handleInit's forced-probe branch calls applyOutcomes, which makeStore
      // does not provide. The only existing init test uses --write, which
      // returns before that branch, so nothing else ever reached it.
      state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
      await createCommandRouter(state as never)("init -f", ctx as never);
      assert.equal(calls.some((call) => call.kind === "select" && call.title === "Bifrost commands"), false);
      assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("Checking 1 models (forced by -f).")));
      assert(calls.some((call) => call.kind === "notify" && String(call.value).includes("Checking 1 models (forced by -f).")));
      assert.equal(calls.some((call) => call.kind === "notify" && String(call.value).includes("saved probe results")), false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refreshes catalog and keeps failed paid probes from changing existing memberships", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-force-reconcile-"));
    const previousCwd = process.cwd();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    process.chdir(tempDir);
    try {
      const piDir = join(tempDir, ".pi");
      mkdirSync(piDir);
      const configPath = join(piDir, "bifrost.json");
      const ownershipPath = join(piDir, "bifrost-reconcile-ownership.json");
      writeFileSync(configPath, JSON.stringify({ default: "quick", models: {
        quick: ["fixture/failed-existing", "manual/only"],
      } }));
      writeFileSync(ownershipPath, JSON.stringify(buildInitOwnershipReceipt("project", {
        quick: ["fixture/failed-existing"],
      })));
      const models = ["failed-existing", "verified", "failed-new"].map((id) => makeModel("fixture", id));
      let refreshCalls = 0;
      const { ctx } = makeCtx(models);
      const registry = (ctx as any).modelRegistry;
      registry.getAll = () => models;
      registry.getProvider = () => ({ id: "fixture" });
      registry.getProviderAuthStatus = () => ({ configured: true });
      registry.getError = () => undefined;
      registry.refresh = async () => { refreshCalls++; return { aborted: false, errors: new Map() }; };
      registry.streamSimple = (model: { id: string }) => ({ result: async () => {
        now += REGISTRY_REFRESH_TTL_MS + 1;
        return {
          role: "assistant", content: model.id === "verified" ? [{ type: "text", text: "ok" }] : [],
          usage: { totalTokens: 1 }, stopReason: model.id === "verified" ? "stop" : "error",
        };
      } });
      (ctx as any).ui.confirm = async () => true;
      const state = makeState() as any;
      state.forceRegistryRefresh = true;
      state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} };

      await createCommandRouter(state)("init -f", ctx);

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(refreshCalls, 1);
      assert.deepEqual(saved.models.quick, ["fixture/failed-existing", "manual/only"]);
      assert.equal(saved.models.quick.includes("fixture/failed-new"), false);
    } finally {
      Date.now = realNow;
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps preexisting stale inventory advisory after successful forced probes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-force-stale-evidence-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const piDir = join(tempDir, ".pi");
      mkdirSync(piDir);
      const configPath = join(piDir, "bifrost.json");
      const original = { default: "quick", models: { quick: ["fixture/existing"] } };
      writeFileSync(configPath, JSON.stringify(original));
      writeFileSync(join(piDir, "bifrost-reconcile-ownership.json"), JSON.stringify(
        buildInitOwnershipReceipt("project", { quick: ["fixture/existing"] }),
      ));
      const models = [makeModel("fixture", "existing"), makeModel("fixture", "verified")];
      const { ctx } = makeCtx(models);
      const registry = (ctx as any).modelRegistry;
      registry.getAll = () => models;
      registry.getProviderAuthStatus = () => ({ configured: true });
      registry.streamSimple = (_model: { id: string }) => ({ result: async () => ({
        role: "assistant", content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop",
      }) });
      (ctx as any).ui.confirm = async () => { throw new Error("stale inventory must not reach save confirmation"); };
      const state = makeState() as any;
      state.registryInventoryEvidence = {
        fixture: { status: "complete", refreshedAt: Date.now() - REGISTRY_REFRESH_TTL_MS - 1 },
      };
      state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} };

      await createCommandRouter(state)("init -f", ctx);

      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stops forced init when catalog refresh is cancelled and marks evidence stale", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-force-cancel-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const model = makeModel("fixture", "chat");
      const { ctx } = makeCtx([model]);
      let probes = 0;
      const registry = (ctx as any).modelRegistry;
      registry.getAll = () => [model];
      registry.getProviderAuthStatus = () => ({ configured: true });
      registry.refresh = async () => ({ aborted: false, errors: new Map() });
      registry.streamSimple = () => { probes++; throw new Error("cancelled refresh must stop before probes"); };
      const controller = new AbortController();
      controller.abort();
      (ctx as any).signal = controller.signal;
      const state = makeState() as any;
      state.registryInventoryEvidence = { fixture: { status: "complete", refreshedAt: Date.now() } };

      await createCommandRouter(state)("init -f", ctx);

      assert.equal(probes, 0);
      assert.equal(state.registryInventoryEvidence.fixture.status, "stale");
      assert.equal(state.forceRegistryRefresh, true);
      assert.equal(existsSync(join(tempDir, ".pi", "bifrost.json")), false);
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

  it("routes pin and unpin without claiming routing is enabled when off", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("pin", ctx as never);
    assert.equal(state.pinned, true);
    await createCommandRouter(state as never)("off", ctx as never);
    await createCommandRouter(state as never)("unpin", ctx as never);
    assert.equal(state.pinned, false);
    assert.ok(calls.some((call) => String(call.value).includes("The model is unpinned, but routing is off. Run /bifrost on to route prompts.")));

    state.enabled = true;
    state.pinned = true;
    await createCommandRouter(state as never)("unpin", ctx as never);
    assert.ok(calls.some((call) => String(call.value).includes("Automatic model switching is enabled.")));
  });

  it("routes classifier on and off as session-only choices", async () => {
    const { ctx, sessionManager } = makeCtx();
    let saves = 0;
    const state = makeState(() => { saves++; }) as any;
    const getEnabled = () => state.getClassifierEnablementForSession(sessionManager).enabled;
    await createCommandRouter(state)("classifier on", ctx as never);
    assert.equal(getEnabled(), true);
    assert.equal(state.getClassifierEnablementForSession(sessionManager).source, "session");
    await createCommandRouter(state)("classifier off", ctx as never);
    assert.equal(getEnabled(), false);
    assert.equal(state.getClassifierEnablementForSession(sessionManager).source, "session");
    await createCommandRouter(state)("classifier inherit", ctx as never);
    assert.equal(getEnabled(), true, "inherit returns to configured behavior");
    assert.equal(state.getClassifierEnablementForSession(sessionManager).source, "configuration");
    assert.equal(saves, 0);
  });

  it("explains each legacy conflict accurately when clearing the session override", async () => {
    for (const configured of [false, true]) {
      const { ctx, calls } = makeCtx();
      const state = makeState();
      state.config.classifier = { enabled: configured };
      state.legacyClassifierEnabled = !configured;
      await createCommandRouter(state as never)("classifier inherit", ctx as never);
      const output = calls.filter((call) => call.kind === "notify").map((call) => String(call.value)).join("\n");
      if (configured) {
        assert.match(output, /classification paused/);
        assert.match(output, /remove only classifierEnabled/);
      } else {
        assert.match(output, /configured off takes precedence/);
        assert.doesNotMatch(output, /resume configured behavior/);
      }
    }
  });

  it("keeps invalid runtime state paused even when classifier on is requested", async () => {
    const { ctx, calls, sessionManager } = makeCtx();
    const state = makeState() as any;
    state.classifierRuntimeStateIssue = "invalid-json";
    const dispatch = createCommandRouter(state);
    await dispatch("classifier on", ctx as never);
    assert.deepEqual(state.getClassifierEnablementForSession(sessionManager), {
      enabled: false, source: "runtime-state-invalid", runtimeStateIssue: "invalid-json",
    });
    await dispatch("classifier status", ctx as never);
    const output = calls.filter((call) => call.kind === "widget").at(-1)?.lines?.join("\n") ?? "";
    assert.match(output, /enabled=false \(runtime-state-invalid\)/);
    assert.match(output, /readiness=blocked/);
    assert.match(output, /classification is paused/);
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("Runtime state is invalid")));
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
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("Cache cleared")));
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

  it("shows provider cooldowns and resets only the exact configured provider", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.config.models = { general: ["fixture/model"] };
    await inTempDir(async () => {
      const providerCooldownStore = createProviderCooldownStore(process.cwd(), state.config.reliability);
      Object.assign(state, { providerCooldownStore });
      await providerCooldownStore.pauseUsage("fixture");
      await createCommandRouter(state as never)("reliability", ctx as never);
      assert.ok(calls.some((call) => String(call.value).includes("fixture: paused until")));
      await createCommandRouter(state as never)("reliability reset --provider other", ctx as never);
      assert.ok(calls.some((call) => String(call.value).includes("not configured or present in cooldown state")));
      assert.ok(providerCooldownStore.read("fixture").openUntil);
      await createCommandRouter(state as never)("reliability reset --provider fixture", ctx as never);
      assert.ok(calls.some((call) => String(call.value).includes("fixture cooldown was reset")));
      assert.equal(providerCooldownStore.read("fixture").openUntil, undefined);
      await createCommandRouter(state as never)("reliability reset --provider *", ctx as never);
      assert.ok(calls.some((call) => String(call.value).includes("usage: /bifrost reliability reset")));
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

  it("reports each economic validation error once and retains the last-good config on reload", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    const lastGoodConfig = state.config;
    await inTempDir(async () => {
      mkdirSync("extension");
      state.extensionDir = join(process.cwd(), "extension");
      writeFileSync("bifrost.json", JSON.stringify({
        schemaVersion: 2,
        default: "general",
        models: { general: ["fixture/model"] },
        economics: {
          mode: "policy",
          scopes: { local: { kind: "model", model: "fixture/model" } },
          sources: [{ id: "manual", scopeRef: "local", authority: "declared" }],
          admission: [],
        },
      }));
      await createCommandRouter(state as never)("reload", ctx as never);
    });
    assert.equal(state.config, lastGoodConfig);
    const rejection = calls.find((call) => String(call.value).includes("reload rejected"));
    assert.ok(rejection);
    const message = String(rejection.value);
    assert.equal(message.split("workspace config economics contains an invalid source-local policy.").length - 1, 1, message);
    assert.doesNotMatch(message, /extension config economics/u);
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

  it("clears the probe widget when /bifrost probe is cancelled", async () => {
    const { ctx, calls } = makeCtx([makeModel("fixture", "one"), makeModel("fixture", "two")]);
    const state = makeState();
    state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
    const controller = new AbortController();
    (ctx as any).signal = controller.signal;
    // The first model finishes and aborts the turn. The probe then returns
    // cancelled, which takes the early return: the progress widget must not
    // survive it as a frozen "still probing" bar.
    (ctx as any).modelRegistry.streamSimple = () => ({
      result: async () => {
        controller.abort();
        return {
          role: "assistant", api: "openai-completions", provider: "fixture", model: "one",
          content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop", timestamp: Date.now(),
        };
      },
    });
    await inTempDir(async () => {
      await createCommandRouter(state as never)("probe", ctx as never);
    });
    const probeWidgetCalls = calls.filter((call) => call.kind === "widget" && String(call.value).startsWith("bifrost-probe:"));
    assert.ok(probeWidgetCalls.some((call) => call.value === "bifrost-probe:func"), "progress widget was never set");
    assert.equal(
      probeWidgetCalls[probeWidgetCalls.length - 1]?.value,
      "bifrost-probe:0",
      "cancelled probe left a stale progress widget",
    );
    assert.ok(calls.some((call) => String(call.value).includes("Probe cancelled")), "cancellation was not reported");
  });

  it("tells the user an on/off choice survives a restart", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("on", ctx as never);
    await createCommandRouter(state as never)("off", ctx as never);
    const notices = calls.filter((call) => call.kind === "notify").map((call) => String(call.value));
    // saveModeState persists the flag, and docs/guide/commands.md records that
    // on/off survives a restart: the notice must not call the choice temporary.
    assert.ok(notices.includes("info:Bifrost enabled: Routing is enabled; this choice survives a restart."), JSON.stringify(notices));
    assert.ok(notices.includes("info:Bifrost disabled: Routing is disabled; this choice survives a restart."), JSON.stringify(notices));
  });

  it("does not promise persistence when the mode state could not be saved", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState(() => false);
    await createCommandRouter(state as never)("on", ctx as never);
    await createCommandRouter(state as never)("off", ctx as never);
    const notices = calls.filter((call) => call.kind === "notify").map((call) => String(call.value));
    // saveModeState's boolean is the only evidence the choice survives a restart.
    assert.ok(
      notices.includes(
        "warning:Bifrost enabled: Routing is enabled for this session; the mode state could not be saved.",
      ),
      JSON.stringify(notices),
    );
    assert.ok(
      notices.includes(
        "warning:Bifrost disabled: Routing is disabled for this session; the mode state could not be saved.",
      ),
      JSON.stringify(notices),
    );
  });

  it("clears the probe widget when the init probe rejects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-probe-reject-"));
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      const { ctx, calls } = makeCtx([makeModel("fixture", "chat")]);
      const probeWidgets: string[] = [];
      (ctx as any).ui.setWidget = (key: string, value: unknown) => {
        if (key !== "bifrost-probe") return;
        const shape = typeof value === "function" ? "component" : JSON.stringify(value);
        probeWidgets.push(shape);
        calls.push({ kind: "widget", value: `bifrost-probe:${shape}` });
        if (typeof value === "function") throw new Error("progress render failed");
      };
      // A progress render that throws rejects runProbe before the widget clear.
      await assert.rejects(
        createCommandRouter(makeState() as never)("init", ctx as never),
        /progress render failed/,
      );
      assert.equal(
        probeWidgets[probeWidgets.length - 1],
        "[]",
        "a rejected init probe left the progress widget on screen",
      );
    } finally {
      process.chdir(previousCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("groups probe failures by reason in the summary card", async () => {
    const { ctx, calls } = makeCtx([makeModel("fixture", "chat"), makeModel("fixture", "bad")]);
    const state = makeState();
    state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
    (ctx as any).modelRegistry.streamSimple = (model: { id: string }) => {
      if (model.id === "bad") return { result: async () => { throw new Error("boom"); } };
      return {
        result: async () => ({
          role: "assistant", api: "openai-completions", provider: "fixture", model: model.id,
          content: [{ type: "text", text: "ok" }], usage: { totalTokens: 1 }, stopReason: "stop", timestamp: Date.now(),
        }),
      };
    };
    await inTempDir(async () => {
      await createCommandRouter(state as never)("probe", ctx as never);
    });
    const card = calls
      .filter((c) => c.kind === "notify")
      .map((c) => String(c.value))
      .find((v) => v.includes("Probe finished with failures"));
    assert.ok(card, "failure summary card missing");
    assert.ok(card.includes("1 of 2 models are working"), card);
    assert.ok(card.includes("1 failed · 0 timed out"), card);
    assert.ok(card.includes("provider errors ×1 — fixture/bad"), card);
    assert.ok(!card.includes("e.g."), card);
    assert.ok(card.includes("full errors: .pi/bifrost-probe.json"), card);
  });

  it("routes benchmark", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    // makeState configures no tiers, so handleBenchmark reports that and
    // returns before reaching the classification pipeline.
    await createCommandRouter(state as never)("benchmark fix the build", ctx as never);
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("No categories configured")));
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
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("No configured tier matched")));
    assert.ok(calls.some((c) => c.kind === "status" && String(c.value).includes("previewing prompt")));
    assert.equal(calls.some((c) => c.kind === "select"), false);
  });

  it("routes init", async () => {
    const { ctx, calls } = makeCtx([{ provider: "fixture", id: "chat" }]);
    const state = makeState();
    state.reliabilityStore = { ...state.reliabilityStore, applyOutcomes: () => {} } as never;
    // Normal init reuses a complete recent report; forced init would probe afresh.
    await inTempDir(async () => {
      mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
      writeRecentProbeCache(join(process.cwd(), ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "chat", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      await createCommandRouter(state as never)("init", ctx as never);
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost-probe.json")), true);
    });
    assert.equal(calls.some((c) => c.kind === "notify" && String(c.value).includes("Probing")), false);
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
      const command = BIFROST_COMMAND_OPTIONS.map((item) => item.value)
        .sort((left, right) => right.length - left.length)
        .find((value) => head === value || head.startsWith(`${value} `));
      assert.ok(command, `no command value in row: ${row}`);
      const hint = head.slice(command.length).trim();
      if (hint) {
        assert.match(hint, /^(?:\[[^\]]*\]|--[\w-]+|<[^>]*>)(?: (?:\[[^\]]*\]|--[\w-]+|<[^>]*>))*$/, `malformed hint: ${row}`);
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

it("offers 27 rows", async () => {
    assert.equal((await rowsFor()).length, 27);
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
      "/bifrost preview [--offline] [--trace] [--json] <prompt> — Preview routing for a prompt",
      "/bifrost benchmark <prompt> — Classify a benchmark prompt",
      "/bifrost providers — List available providers",
      "/bifrost probe — Probe working models",
      "/bifrost init — Refresh model catalog and save setup (pass -f to probe)",
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
    assert.ok(rows.some((row) => row.includes("/bifrost preview [--offline] [--trace] [--json] <prompt>")));
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
    (h.state as any).bootstrapModelsInMemory = true;
    const before = JSON.stringify(h.reliability);
    const lines = await withStubs(() => createCommandRouter(h.state as never)("inspect --json", h.context as never));
    const report = JSON.parse(lines.find((line) => line.startsWith(BIFROST_JSON_PREFIX))!.slice(BIFROST_JSON_PREFIX.length));
    assert.equal(report.kind, "inspection");
    assert.equal(report.modelPoolSource, "session_catalog_in_memory");
    assert.equal(report.registry.knownModelCount, 1);
    assert.equal(report.registry.availableModelCount, 1);
    assert.equal(report.registry.bifrostLastRefreshAgeMs >= 0, true);
    assert.equal(report.registry.bifrostRegistryRefreshTtlMs, 30_000);
    assert.equal(report.registry.forceRegistryRefresh, false);
    assert.deepEqual(report.reliabilityPolicy, {
      enabled: true, cooldownOnAllowanceExhausted: true, allowanceCooldownScope: "provider",
    });
    assert.deepEqual(report.tiers[0].candidates[0], {
      model: "fixture/known", available: true, auth: "configured", circuit: "open", openUntil: h.reliability.models["fixture/known"].openUntil,
    });
    assert.equal(JSON.stringify(report).includes("PRIVATE_AUTH_SENTINEL"), false);
    assert.equal(JSON.stringify(report).includes("PRIVATE_LABEL_SENTINEL"), false);
    assert.equal(JSON.stringify(h.reliability), before);
    assert.deepEqual(h.counters(), { registryReads: 2, networkCalls: 0, writes: 0 });
  });

  it("projects provider cooldowns into inspect for v1 and v2 without writing or refreshing", async () => {
    const h = diagnosticHarness();
    const modelKey = "fixture/known";
    h.reliability.models[modelKey] = { failures: [], openUntil: 0 };
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-inspect-provider-cooldown-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const providerStore = createProviderCooldownStore(cwd, {
      enabled: true,
      cooldownMinutes: 1,
      allowanceCooldownScope: "provider",
    });
    (h.state as any).providerCooldownStore = providerStore;
    try {
      await providerStore.pauseUsage("fixture");
      const providerPath = providerReliabilityPath(cwd);
      const sidecarBefore = readFileSync(providerPath);
      const inspect = async () => {
        const lines = await withStubs(() => createCommandRouter(h.state as never)("inspect --json", h.context as never));
        return JSON.parse(lines.find((line) => line.startsWith(BIFROST_JSON_PREFIX))!.slice(BIFROST_JSON_PREFIX.length));
      };
      const v1 = await inspect();
      assert.equal(v1.tiers[0].candidates[0].circuit, "open",
        "v1 inspection should project provider usage pause onto configured candidates");
      assert.ok(v1.tiers[0].candidates[0].openUntil > Date.now());

      const mutableState = h.state as any;
      mutableState.config.reliability.stateVersion = 2;
      mutableState.reliabilityV2Store = { readSnapshot: () => emptyReliabilityV2State() };
      const v2 = await inspect();
      assert.equal(v2.tiers[0].candidates[0].circuit, "open",
        "v2 model projection should retain the shared provider cooldown projection");

      mutableState.config.reliability.cooldownOnAllowanceExhausted = false;
      const optedOut = await inspect();
      assert.equal(optedOut.tiers[0].candidates[0].circuit, "closed",
        "usage pause projection must respect the cooldown opt-out");
      mutableState.config.reliability.cooldownOnAllowanceExhausted = true;
      mutableState.config.reliability.allowanceCooldownScope = "model";
      const modelScope = await inspect();
      assert.equal(modelScope.tiers[0].candidates[0].circuit, "closed",
        "provider usage pauses must not project when scope is model-only");
      mutableState.config.reliability.allowanceCooldownScope = "provider";
      mutableState.config.reliability.enabled = false;
      const disabled = await inspect();
      assert.equal(disabled.tiers[0].candidates[0].circuit, "disabled",
        "disabled reliability must suppress provider pause projection");
      mutableState.config.reliability.enabled = true;
      mutableState.enabled = false;
      const routerOff = await inspect();
      assert.equal(routerOff.tiers[0].candidates[0].circuit, "closed",
        "disabled Bifrost routing must suppress provider pause projection");

      assert.deepEqual(h.counters(), { registryReads: 16, networkCalls: 0, writes: 0 });
      assert.deepEqual(readFileSync(providerPath), sidecarBefore,
        "inspection must only read provider cooldown state");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
    assert.match(output, /Registry refresh threshold: 30s/);
    assert.doesNotMatch(output, /Model catalog: refresh needed/);
    assert.match(output, /usage\/billing cooldown=on \(provider scope\)/);
    assert.doesNotMatch(output, /provider data freshness/i);
    assert.doesNotMatch(output, /PRIVATE_(?:AUTH|LABEL)_SENTINEL/);
  });

  it("reports pending registry refresh state in JSON and text without claiming completion", async () => {
    const h = diagnosticHarness();
    (h.state as any).forceRegistryRefresh = true;
    (h.context as unknown as { mode: string }).mode = "cli";
    const lines = await withStubs(() => createCommandRouter(h.state as never)("inspect --json", h.context as never));
    const report = JSON.parse(lines.find((line) => line.startsWith(BIFROST_JSON_PREFIX))!.slice(BIFROST_JSON_PREFIX.length));
    assert.equal(report.registry.forceRegistryRefresh, true);
    assert.equal(report.registry.bifrostRegistryRefreshTtlMs, 30_000);
    assert.deepEqual(h.counters(), { registryReads: 2, networkCalls: 0, writes: 0 });

    const text = (await withStubs(() => createCommandRouter(h.state as never)("inspect", h.context as never))).join("\n");
    assert.match(text, /Model catalog: refresh needed/);
    assert.deepEqual(h.counters(), { registryReads: 4, networkCalls: 0, writes: 0 });
  });

  it("reports the fixed registry refresh interval in debug output", async () => {
    const h = diagnosticHarness();
    (h.context as unknown as { mode: string }).mode = "cli";
    const output = (await withStubs(() => createCommandRouter(h.state as never)("debug", h.context as never))).join("\n");
    assert.match(output, /Registry refresh threshold: 30s/);
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

describe("preview parity with Auto sign-in exclusions", () => {
  const models = [makeModel("dead", "one", 1), makeModel("live", "two", 2)];
  const previewCtx = { modelRegistry: makeRegistry(models) } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

  function stateWith(signInEligibility: "off" | "exclude", excluded?: ReadonlySet<string>) {
    const state: any = makeState();
    state.config = {
      schemaVersion: 2,
      default: "review",
      strategy: "first",
      models: { review: ["dead/one", "live/two"] },
      reliability: { enabled: false },
      signInEligibility,
    };
    state.getSignInExclusions = () => excluded;
    return state;
  }

  it("renders the skip reason Auto would apply instead of claiming the provider is up", () => {
    const display = resolveTierDisplay("review", stateWith("exclude", new Set(["dead"])), previewCtx);
    assert.equal(display.selected, "live/two");
    assert.ok(display.requestedCandidateLines.includes("xx dead/one (provider sign-in unavailable)"));
    assert.equal(display.signInNote, undefined);
  });

  it("says the signal is unresolved instead of implying every provider is ready", () => {
    const display = resolveTierDisplay("review", stateWith("exclude", undefined), previewCtx);
    assert.match(display.signInNote ?? "", /not been resolved in this session/);
    assert.equal(display.selected, "dead/one");
  });

  it("applies no exclusion when the configuration leaves the check off", () => {
    const display = resolveTierDisplay("review", stateWith("off", new Set(["dead"])), previewCtx);
    assert.equal(display.selected, "dead/one");
    assert.equal(display.signInNote, undefined);
  });

  it("carries the unresolved note into the text and JSON views", () => {
    const display = resolveTierDisplay("review", stateWith("exclude", undefined), previewCtx);
    const report = buildPreviewReport({
      prompt: "p",
      classification: { kind: "classified", tier: "review", source: "regex" },
      display,
    });
    assert.match(report.signInNote ?? "", /not been resolved/);
    assert(renderPreviewReport(report).some((line) => line.startsWith("sign-in:")));
  });
});

describe("bifrost init probe ordering", () => {
  it("orders generated pools and the auto classifier by measured probe time", async () => {
    // The CHANGELOG says elapsed probe time now reorders init's generated pools
    // and its automatic classifier model. The registry order here is slow-first
    // on purpose, so only the probe-time sort can produce the fast-first result.
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-init-probe-order-"));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.chdir(tempDir);
    try {
      mkdirSync(join(tempDir, ".pi"));
      writeRecentProbeCache(join(tempDir, ".pi", "bifrost-probe.json"), [
        { provider: "fixture", model: "slow", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 90 },
        { provider: "fixture", model: "fast", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
      ]);
      const { ctx } = makeCtx([{ provider: "fixture", id: "slow" }, { provider: "fixture", id: "fast" }]);
      const state = makeState();
      await createCommandRouter(state as never)("init --write", ctx as never);

      const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "bifrost.json"), "utf8"));
      assert.deepEqual(saved.models.quick, ["fixture/fast", "fixture/slow"], "the fastest probed model leads its tier");
      assert.equal(saved.classifier.model, "fixture/fast", "the automatic classifier model is the fastest eligible probe");
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
