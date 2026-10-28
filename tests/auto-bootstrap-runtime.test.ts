import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { validateConfig } from "../config.ts";
import { loadConfigForReload } from "../config-load.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { ReliabilityV2Store } from "../reliability-v2-store.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel, makePiClassifierModel } from "./helpers.ts";

type Hook = (event: any, ctx: ExtensionContext) => Promise<unknown>;
const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

function freshHarness(auto = false, persistedRuntimeState?: { enabled: boolean; classifierEnabled: boolean }, deferProbe = false, blockProbe = false) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-auto-bootstrap-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (persistedRuntimeState) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "bifrost-state.json"), JSON.stringify(persistedRuntimeState));
  }
  if (blockProbe) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "bifrost-reliability.json"), JSON.stringify({
      version: 1,
      models: { "fixture/quick": { failures: [Date.now()], openUntil: Date.now() + 60_000 } },
    }));
  }
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env[TYPE_SAFE_API_KEY_ENV];

  const model = makeModel("fixture", "quick", 0.2, 0.2);
  let models: Model<Api>[] = [model];
  const branch: any[] = [];
  const handlers = new Map<string, Hook>();
  const notices: string[] = [];
  let availableReads = 0;
  let refreshCalls = 0;
  let probeRequests = 0;
  const probedModels: string[] = [];
  let classifierModels: unknown[] = [];
  let selected: string | undefined;
  let routeDefinition: VirtualModelDefinition | undefined;
  let confirmCalls = 0;
  let staleContext = false;
  const probeWidgetWrites: string[][] = [];
  const statuses = new Map<string, string>();
  let onProbeStarted!: () => void;
  let onProbeWidgetStarted!: () => void;
  let onProbeWidgetVisible = () => {};
  let probeWidgetWasVisible = false;
  let releaseProbe!: (response: unknown) => void;
  const probeStarted = new Promise<void>((resolve) => { onProbeStarted = resolve; });
  const probeWidgetStarted = new Promise<void>((resolve) => { onProbeWidgetStarted = resolve; });
  const deferredProbe = new Promise<unknown>((resolve) => { releaseProbe = resolve; });
  const successfulProbeResponse = () => ({
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "2" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const autoModel = { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" };
  const ctx = {
    cwd,
    get mode() {
      if (staleContext) throw new Error("stale extension context mode read");
      return "tui";
    },
    get hasUI() {
      if (staleContext) throw new Error("stale extension context UI read");
      return true;
    },
    signal: new AbortController().signal,
    model: auto ? autoModel : makeModel("fixture", "physical"),
    modelRegistry: {
      getAvailable: () => { availableReads += 1; return models; },
      getAll: () => models,
      find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
      getProviderAuthStatus: () => ({ configured: false }),
      refresh: async () => { refreshCalls += 1; return { refreshed: [], errors: new Map() }; },
      getModelsOfType: () => classifierModels,
      getAvailableOfType: async () => classifierModels,
      ...(deferProbe ? { streamSimple: (probeModel: Model<Api>) => {
        probeRequests += 1;
        probedModels.push(`${probeModel.provider}/${probeModel.id}`);
        onProbeStarted();
        return { result: () => deferredProbe };
      } } : {}),
    },
    sessionManager: {
      getHeader: () => ({ id: "auto-bootstrap-session" }),
      getBranch: () => branch,
    },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      notify: (message: string) => notices.push(message),
      setStatus: (id: string, text: string) => { statuses.set(id, text); },
      setWidget: (id: string, lines: string[]) => {
        if (id === "bifrost-probe") {
          probeWidgetWrites.push([...lines]);
          if (lines.length > 0) {
            onProbeWidgetStarted();
            if (!probeWidgetWasVisible) {
              probeWidgetWasVisible = true;
              onProbeWidgetVisible();
            }
          }
        }
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      confirm: async () => { confirmCalls += 1; return false; },
    },
  } as unknown as ExtensionContext;
  const pi = {
    registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
    registerCommand: () => {},
    on: (event: string, handler: Hook) => { handlers.set(event, handler); return () => {}; },
    setModel: async (next: Model<Api>) => { selected = `${next.provider}/${next.id}`; return true; },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);
  return {
    ctx,
    setContextModel: (next: Model<Api>) => { ctx.model = next; },
    handlers,
    model,
    setAvailable: (next: Model<Api>[]) => { models = next; },
    setClassifierModels: (next: unknown[]) => { classifierModels = next; },
    probeModels: () => [...probedModels],
    autoModel,
    branch,
    routeDefinition: () => routeDefinition,
    notices,
    availableReads: () => availableReads,
    refreshCalls: () => refreshCalls,
    probeRequests: () => probeRequests,
    probeWidgetWrites: () => probeWidgetWrites,
    probeWidgetStarted,
    onProbeWidgetVisible: (callback: () => void) => { onProbeWidgetVisible = callback; },
    markContextStale: () => { staleContext = true; },
    status: (id: string) => statuses.get(id),
    selected: () => selected,
    confirmCalls: () => confirmCalls,
    probeStarted,
    completeProbe: () => releaseProbe(successfulProbeResponse()),
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("automatic setup through registered Pi hooks", () => {
  it("routes from first-use metadata before saving readable config and ownership in the background", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      assert.equal(harness.availableReads(), 0);
      assert.equal(harness.refreshCalls(), 0);
      const result = await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.deepEqual(result, { action: "transform", text: "do a small task" });
      assert.equal(harness.selected(), "fixture/quick");
      assert.match(harness.notices.join("\n"), /in-memory pools/);
      await harness.probeStarted;
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost-probe.json")), false,
        "the synthetic probe has not resolved while the foreground first use returns");
      assert.ok(harness.refreshCalls() <= 1, "existing first-prompt registry refresh is bounded to one call");
      harness.branch.push({ type: "message", id: "ordinary-first-prompt-append" });
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), true);
      const receipt = JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost-reconcile-ownership.json"), "utf8")) as {
        sources: Record<string, { generated: Record<string, string[]> }>;
      };
      assert.deepEqual(Object.values(receipt.sources).flatMap((source) => source.generated.quick ?? []), ["fixture/quick"]);
      const probeReport = JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost-probe.json"), "utf8")) as Array<{ status: string }>;
      assert.deepEqual(probeReport.map((result) => result.status), ["ok"]);
      const reloaded = loadConfigForReload(process.cwd(), fileURLToPath(new URL("..", import.meta.url))).config;
      assert.equal(reloaded.default, "quick");
      assert.deepEqual(reloaded.models?.quick, ["fixture/quick"]);
      assert.equal(validateConfig(reloaded).some((issue) => issue.severity === "error"), false);
    } finally { harness.cleanup(); }
  });

  it("excludes virtual and classifier-typed models from first-use probes and generated pools", async () => {
    const harness = freshHarness(false, undefined, true);
    const classifier = makePiClassifierModel("typesafe", "jev-latest");
    harness.setAvailable([harness.model, harness.autoModel as Model<Api>]);
    harness.setClassifierModels([classifier]);
    try {
      const typedClassifiers = await harness.ctx.modelRegistry.getAvailableOfType("classifier", "typesafe");
      assert.deepEqual(typedClassifiers.map((model) => `${model.provider}/${model.id}`), ["typesafe/jev-latest"]);
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      assert.deepEqual(harness.probeModels(), ["fixture/quick"],
        "first-use probing must filter registered virtual models and use the host's chat-only available catalog");
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();
      const generated = JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost.json"), "utf8"));
      assert.deepEqual(Object.values(generated.models).flat(), ["fixture/quick"],
        "generated starter pools must not contain virtual or classifier-only entries");
      const report = JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost-probe.json"), "utf8"));
      assert.deepEqual(report.map((result: { status: string }) => result.status), ["ok"]);
    } finally { harness.cleanup(); }
  });

  it("keeps an eligible background save alive when the user selects Auto", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
      assert.deepEqual(harness.probeWidgetWrites().at(-1), ["Checking models: 0/1", "  passed: 0"]);

      harness.setContextModel(harness.autoModel);
      await harness.handlers.get("model_select")!({ model: harness.autoModel, source: "set" }, harness.ctx);
      assert.deepEqual(harness.probeWidgetWrites().at(-1), ["Checking models: 0/1", "  passed: 0"],
        "selecting Auto clears command widgets, then restores active bootstrap progress");
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();

      assert.equal(harness.probeRequests(), 1, "Auto selection must retain the in-flight probe rather than restart it");
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), true);
      const config = JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost.json"), "utf8"));
      assert.deepEqual(config.models.quick, ["fixture/quick"]);
      const report = JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost-probe.json"), "utf8"));
      assert.deepEqual(report.map((result: { status: string }) => result.status), ["ok"]);
      assert.deepEqual(harness.probeWidgetWrites().at(-1), [], "the widget clears when checks finish");
    } finally { harness.cleanup(); }
  });

  it("keeps background probe progress visible while routing a prompt", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      const result = await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.deepEqual(result, { action: "transform", text: "do a small task" });
      assert.deepEqual(harness.probeWidgetWrites().at(-1), ["Checking models: 0/1", "  passed: 0"]);
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();
    } finally { harness.cleanup(); }
  });

  it("bounds durable provider reads across 100-model bootstrap scans", async () => {
    const original = ReliabilityV2Store.prototype.readSnapshot;
    let reads = 0;
    ReliabilityV2Store.prototype.readSnapshot = function (...args) {
      reads++;
      return original.apply(this, args);
    };
    const harness = freshHarness(false, undefined, true);
    try {
      harness.setAvailable([
        harness.model,
        ...Array.from({ length: 99 }, (_, index) => makeModel("fixture", `other-${index}`)),
      ]);
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      assert.ok(reads < 10, `100-model scan made ${reads} durable reads before probes settled`);
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), true);
      assert.ok(reads < 120, `100-model bootstrap made ${reads} durable reads including fresh probe admission`);
    } finally {
      try {
        await harness.handlers.get("session_shutdown")!({}, harness.ctx);
        harness.completeProbe();
        await flushImmediate();
      } finally {
        ReliabilityV2Store.prototype.readSnapshot = original;
        harness.cleanup();
      }
    }
  });

  it("does not touch a torn-down UI when a cancelled background check settles", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      const writesBeforeShutdown = harness.probeWidgetWrites().length;
      await harness.handlers.get("session_shutdown")!({}, harness.ctx);
      harness.markContextStale();
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();

      assert.equal(harness.probeWidgetWrites().length, writesBeforeShutdown,
        "a stale asynchronous completion must not inspect or update the destroyed UI");
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
    } finally { harness.cleanup(); }
  });

  it("clears progress when every catalog model is paused before probing", async () => {
    const harness = freshHarness(false, undefined, true, true);
    try {
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeWidgetStarted;
      const routingStatus = harness.status("bifrost-state");
      for (let i = 0; i < 5; i += 1) await flushImmediate();

      assert.equal(harness.probeRequests(), 0, "open-circuit catalog entries are not probed");
      assert.deepEqual(harness.probeWidgetWrites().at(-1), [], "progress clears when no models pass admission");
      assert.equal(harness.status("bifrost-state"), routingStatus, "bootstrap progress does not replace the routing status");
    } finally { harness.cleanup(); }
  });

  it("clears progress when setup becomes ineligible before probe admission", async () => {
    const harness = freshHarness(false, undefined, true);
    const configPath = join(harness.ctx.cwd, ".pi", "bifrost.json");
    try {
      let routingStatusBefore: string | undefined;
      harness.onProbeWidgetVisible(() => {
        routingStatusBefore = harness.status("bifrost-state");
        mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ strategy: "random" }));
      });
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeWidgetStarted;
      for (let i = 0; i < 5; i += 1) await flushImmediate();

      assert.equal(harness.probeRequests(), 0, "the newly appeared config blocks background admission");
      assert.deepEqual(harness.probeWidgetWrites().at(-1), [], "current-session progress clears after the eligibility abort");
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { strategy: "random" });
      assert.equal(harness.status("bifrost-state"), routingStatusBefore, "background cleanup leaves routing status intact");
    } finally { harness.cleanup(); }
  });

  it("still cancels the in-flight save when the user pins a physical model", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      await harness.handlers.get("model_select")!({ model: makeModel("fixture", "physical"), source: "set" }, harness.ctx);
      assert.deepEqual(harness.probeWidgetWrites().at(-1), [], "manual physical selection clears bootstrap progress immediately");
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();

      assert.equal(harness.probeRequests(), 1);
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost-reconcile-ownership.json")), false);
    } finally { harness.cleanup(); }
  });

  it("does not leave a delayed status callback bound to a saved session", async () => {
    const harness = freshHarness(false, undefined, true);
    const originalSetTimeout = globalThis.setTimeout;
    const delayedStatusCallbacks: Array<() => void> = [];
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 3000 && typeof handler === "function") {
        delayedStatusCallbacks.push(() => handler(...args));
        return {} as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof globalThis.setTimeout;
    try {
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await harness.probeStarted;
      harness.completeProbe();
      await flushImmediate();
      await flushImmediate();
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), true);
      await harness.handlers.get("session_shutdown")!({}, harness.ctx);
      harness.markContextStale();

      assert.equal(delayedStatusCallbacks.length, 0, "saved background setup needs no delayed footer-status clear");
      for (const callback of delayedStatusCallbacks) assert.doesNotThrow(callback);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      harness.cleanup();
    }
  });

  it("keeps routing in memory when a meaningful project config appears before the background save", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      await harness.probeStarted;
      const routingStatus = harness.status("bifrost-state");
      assert.ok((harness.probeWidgetWrites().at(-1) ?? []).length > 0, "the active background check displays progress");
      const configPath = join(process.cwd(), ".pi", "bifrost.json");
      mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ strategy: "random" }));
      harness.completeProbe();
      for (let i = 0; i < 5; i += 1) await flushImmediate();
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { strategy: "random" });
      assert.equal(harness.selected(), "fixture/quick");
      assert.match(harness.notices.join("\n"), /could not safely save.*routing continues with in-memory pools/);
      assert.deepEqual(harness.probeWidgetWrites().at(-1), [], "a late config change clears progress even after it aborts the probe");
      assert.equal(harness.status("bifrost-state"), routingStatus, "late probe completion leaves routing status intact");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps routing available when the project config directory becomes unsafe", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      const piDirectory = join(process.cwd(), ".pi");
      const alternateDirectory = join(process.cwd(), "alternate");
      mkdirSync(alternateDirectory);
      symlinkSync(alternateDirectory, piDirectory);
      await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      await harness.probeStarted;
      harness.completeProbe();
      await flushImmediate();
      assert.equal(existsSync(join(alternateDirectory, "bifrost.json")), false);
      assert.equal(harness.selected(), "fixture/quick");
      assert.match(harness.notices.join("\n"), /could not safely save.*routing continues with in-memory pools/);
    } finally { harness.cleanup(); }
  });

  it("cancels a pending save on session teardown and never writes into a later project", async () => {
    const harness = freshHarness(false, undefined, true);
    const originalCwd = process.cwd();
    try {
      await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      await harness.probeStarted;
      await harness.handlers.get("session_shutdown")!({}, harness.ctx);
      harness.completeProbe();
      const otherProject = join(originalCwd, "other-project");
      mkdirSync(otherProject);
      process.chdir(otherProject);
      await flushImmediate();
      assert.equal(existsSync(join(originalCwd, ".pi", "bifrost.json")), false);
      assert.equal(existsSync(join(otherProject, ".pi", "bifrost.json")), false);
    } finally {
      process.chdir(originalCwd);
      harness.cleanup();
    }
  });

  it("still bootstraps when the global config is an empty object", async () => {
    const harness = freshHarness(false, undefined, true);
    try {
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "bifrost.json"), "{}\n");
      const result = await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.deepEqual(result, { action: "transform", text: "do a small task" });
      assert.equal(harness.selected(), "fixture/quick");
      assert.match(harness.notices.join("\n"), /in-memory pools/);
      await harness.probeStarted;
      harness.completeProbe();
      await flushImmediate();
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), true);
      assert.equal(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "bifrost.json"), "utf8"), "{}\n");
    } finally { harness.cleanup(); }
  });

  it("lets direct Auto selection persist its own runtime mode while fresh setup is pending", async () => {
    const harness = freshHarness(true);
    try {
      await harness.handlers.get("model_select")!({ model: harness.autoModel, source: "set" }, harness.ctx);
      assert.equal(harness.confirmCalls(), 0);
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
      const input = await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.deepEqual(input, { action: "transform", text: "do a small task" });
      assert.match(harness.notices.join("\n"), /in-memory pools/);
      assert.equal(harness.confirmCalls(), 0);
      assert.ok(existsSync(join(process.cwd(), ".pi", "bifrost-state.json")));
      const message = { role: "user", content: [{ type: "text", text: "quick do a small task" }] };
      harness.branch.push({ type: "message", id: "auto-first-user", parentId: "root", timestamp: new Date().toISOString(), message });
      const request = {
        model: harness.autoModel,
        reason: "user",
        thinkingLevel: "low",
        messages: [message],
      } as unknown as ModelRouteRequest;
      const route = harness.routeDefinition()!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>;
      assert.equal((await route(request, harness.ctx)).model, harness.model);
    } finally { harness.cleanup(); }
  });

  it("bootstraps after a prior empty-catalog classifier-off preference when models become available", async () => {
    const harness = freshHarness(true, { enabled: true, classifierEnabled: false });
    try {
      await harness.handlers.get("model_select")!({ model: harness.autoModel, source: "set" }, harness.ctx);
      const result = await harness.handlers.get("input")!({
        text: "Review this code and suggest an improvement",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.deepEqual(result, { action: "continue" });
      assert.match(harness.notices.join("\n"), /in-memory pools/);
      assert.deepEqual(JSON.parse(readFileSync(join(process.cwd(), ".pi", "bifrost-state.json"), "utf8")), {
        enabled: true,
        classifierEnabled: false,
      });
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
      const message = { role: "user", content: [{ type: "text", text: "Review this code and suggest an improvement" }] };
      harness.branch.push({ type: "message", id: "classifier-off-user", parentId: "root", timestamp: new Date().toISOString(), message });
      const request = {
        model: harness.autoModel,
        reason: "user",
        thinkingLevel: "low",
        messages: [message],
      } as unknown as ModelRouteRequest;
      const route = harness.routeDefinition()!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>;
      assert.equal((await route(request, harness.ctx)).model, harness.model);
    } finally { harness.cleanup(); }
  });

  it("drops a pending snapshot when a user config appears before it is applied", async () => {
    const harness = freshHarness();
    try {
      const start = harness.handlers.get("session_start")!({}, harness.ctx);
      mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
      writeFileSync(join(process.cwd(), ".pi", "bifrost.json"), JSON.stringify({ models: {} }));
      await start;
      await Promise.resolve();
      assert.doesNotMatch(harness.notices.join("\n"), /in-memory pools/);
    } finally { harness.cleanup(); }
  });

  it("treats malformed user config as present and does not mask it with generated pools", async () => {
    const harness = freshHarness();
    try {
      mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
      writeFileSync(join(process.cwd(), ".pi", "bifrost.json"), "{not-json");
      await harness.handlers.get("session_start")!({}, harness.ctx);
      await Promise.resolve();
      assert.doesNotMatch(harness.notices.join("\n"), /in-memory pools/);
    } finally { harness.cleanup(); }
  });

  it("cancels a pending snapshot on a real physical model selection", async () => {
    const harness = freshHarness();
    try {
      const start = harness.handlers.get("session_start")!({}, harness.ctx);
      const selected = harness.handlers.get("model_select")!({ model: makeModel("fixture", "physical"), source: "set" }, harness.ctx);
      await Promise.all([start, selected]);
      await Promise.resolve();
      assert.equal(harness.availableReads(), 0);
      assert.doesNotMatch(harness.notices.join("\n"), /in-memory pools/);
    } finally { harness.cleanup(); }
  });

  it("does not apply a pending snapshot after session teardown or branch movement", async () => {
    for (const mutate of [
      (h: ReturnType<typeof freshHarness>) => h.handlers.get("session_shutdown")!({}, h.ctx),
      (h: ReturnType<typeof freshHarness>) => { h.branch.push({ type: "message", id: "changed", parentId: "root" }); },
    ]) {
      const harness = freshHarness();
      try {
        const start = harness.handlers.get("session_start")!({}, harness.ctx);
        await mutate(harness);
        await start;
        await Promise.resolve();
        assert.doesNotMatch(harness.notices.join("\n"), /in-memory pools/);
      } finally { harness.cleanup(); }
    }
  });

  it("retries an empty catalog on a later fresh prompt after models become available", async () => {
    const harness = freshHarness();
    try {
      harness.setAvailable([]);
      const first = await harness.handlers.get("input")!({
        text: "quick do a small task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.deepEqual(first, { action: "transform", text: "do a small task" });
      assert.doesNotMatch(harness.notices.join("\n"), /in-memory pools/);
      harness.setAvailable([harness.model]);
      await harness.handlers.get("input")!({
        text: "quick do another task",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert.match(harness.notices.join("\n"), /in-memory pools/);
    } finally { harness.cleanup(); }
  });

  it("uses Pi registry auth sources when detecting the startup classifier default", async () => {
    const harness = freshHarness();
    const registry = (harness.ctx as any).modelRegistry;
    registry.getProviderAuthStatus = (provider: string) => provider === "typesafe"
      ? { configured: true, source: "runtime" }
      : { configured: false };
    registry.getAvailableOfType = async () => [];
    registry.classify = async () => ({ stopReason: "error", answers: {}, timestamp: Date.now() });
    const messages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { messages.push(String(message)); };
    try {
      await harness.handlers.get("input")!({
        text: "Please explain this code briefly",
        source: "interactive",
        streamingBehavior: "steer",
      }, harness.ctx);
      assert(messages.some((message) => message.includes("classifier backend auto: pi-native (Pi-managed TypeSafe credential)")));
    } finally {
      console.warn = originalWarn;
      harness.cleanup();
    }
  });
});
