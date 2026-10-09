import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

type Hook = (event: any, ctx: ExtensionContext) => Promise<unknown>;

function freshHarness(auto = false, persistedRuntimeState?: { enabled: boolean; classifierEnabled: boolean }) {
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
  let selected: string | undefined;
  let routeDefinition: VirtualModelDefinition | undefined;
  let confirmCalls = 0;
  const autoModel = { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" };
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    model: auto ? autoModel : makeModel("fixture", "physical"),
    modelRegistry: {
      getAvailable: () => { availableReads += 1; return models; },
      getAll: () => models,
      find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
      getProviderAuthStatus: () => ({ configured: false }),
      refresh: async () => { refreshCalls += 1; return { refreshed: [], errors: new Map() }; },
    },
    sessionManager: {
      getHeader: () => ({ id: "auto-bootstrap-session" }),
      getBranch: () => branch,
    },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      setWidget: () => {},
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
    handlers,
    model,
    setAvailable: (next: Model<Api>[]) => { models = next; },
    autoModel,
    branch,
    routeDefinition: () => routeDefinition,
    notices,
    availableReads: () => availableReads,
    refreshCalls: () => refreshCalls,
    selected: () => selected,
    confirmCalls: () => confirmCalls,
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
  it("loads metadata on a fresh physical first input and routes without init or probe writes", async () => {
    const harness = freshHarness();
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
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost.json")), false);
      assert.equal(existsSync(join(process.cwd(), ".pi", "bifrost-probe.json")), false);
      assert.ok(harness.refreshCalls() <= 1, "existing first-prompt registry refresh is bounded to one call");
    } finally { harness.cleanup(); }
  });

  it("still bootstraps when the global config is an empty object", async () => {
    const harness = freshHarness();
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
