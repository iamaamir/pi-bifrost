import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, SessionMessageEntry, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { reliabilityV2Config, reliabilityV2Path } from "../runtime-reliability-v2.ts";
import { ReliabilityV2Store } from "../reliability-v2-store.ts";
import { modelScopeKey } from "../reliability-v2.ts";
import { writeJsonFile } from "../storage.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { CLASSIFIER_BACKEND_IDS } from "../classifier-backends.ts";
import { makeModel, makePiClassifierModel } from "./helpers.ts";

async function runAllowanceRuntime({ reloadOptOut = false, failedContent = [], toolResults = [], priorToolHistory = false, rejectSettlement = false, interveneDuringSettlement = false, routeAfterPrepare = false, reloadAfterPrepare = false }: {
  reloadOptOut?: boolean;
  failedContent?: unknown[];
  toolResults?: unknown[];
  priorToolHistory?: boolean;
  rejectSettlement?: boolean;
  interveneDuringSettlement?: boolean;
  routeAfterPrepare?: boolean;
  reloadAfterPrepare?: boolean;
} = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-v2-allowance-runtime-"));
  const agentDir = join(cwd, "agent");
  const configDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: false },
    models: { quick: routeAfterPrepare || reloadAfterPrepare ? ["fixture/allowed", "fixture/alternate"] : ["fixture/allowed"] },
    reliability: { stateVersion: 2, failureThreshold: 3, windowMinutes: 10, cooldownMinutes: 1 },
    rules: [],
  } as const;
  const configPath = join(configDir, "bifrost.json");
  writeFileSync(configPath, JSON.stringify(config));
  const user = { role: "user", content: [{ type: "text", text: "fresh user turn" }] } as const;
  const branch: SessionMessageEntry[] = [{ type: "message", id: "user-allowance", parentId: "root", timestamp: new Date().toISOString(), message: user as never }];
  const model = makeModel("fixture", "allowed");
  const alternate = makeModel("fixture", "alternate");
  const availableModels = [model];
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
  let routeDefinition: VirtualModelDefinition | undefined;
  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const ctx = {
    cwd, mode: "rpc", hasUI: false,
    model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
    modelRegistry: {
      getAvailable: () => availableModels,
      find: (provider: string, id: string) => availableModels.find((item) => provider === item.provider && id === item.id),
      getAvailableOfType: async () => [],
      getModelOfType: () => undefined,
      getProviderAuthStatus: () => ({ configured: false }),
      refresh: async () => ({ refreshed: [], errors: [] }),
    },
    sessionManager: { getHeader: () => ({ id: "session-allowance" }), getBranch: () => branch },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = options.handler; },
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; },
    setModel: async () => true,
  } as unknown as ExtensionAPI;
  try {
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    bifrostExtension(pi);
    assert.ok(routeDefinition?.route && commandHandler);
    await commandHandler("reliability migrate --fresh", ctx);
    if (reloadOptOut) {
      writeFileSync(configPath, JSON.stringify({ ...config, reliability: { ...config.reliability, cooldownOnAllowanceExhausted: false } }));
      await commandHandler("reload", ctx);
    }
    const route = routeDefinition.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: unknown }>;
    const request = { model: ctx.model, reason: "user", thinkingLevel: "low", messages: [user] } as unknown as ModelRouteRequest;
    assert.equal((await route(request, ctx)).model, model);
    if (routeAfterPrepare || reloadAfterPrepare) availableModels.push(alternate);
    if (priorToolHistory) {
      const earlierToolCall = {
        role: "assistant", content: [{ type: "toolCall", id: "tool-call", name: "edit_file", arguments: {} }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
      } as const;
      branch.push({ type: "message", id: "assistant-tool-call", parentId: "user-allowance", timestamp: new Date().toISOString(), message: earlierToolCall as never });
      branch.push({ type: "toolResult", id: "tool-result", parentId: "assistant-tool-call", timestamp: new Date().toISOString(), message: { role: "toolResult", content: [] } } as never);
    }
    const assistant = {
      role: "assistant", content: failedContent, api: model.api, provider: model.provider, model: model.id,
      stopReason: "error", errorMessage: "The usage limit has been reached.", timestamp: Date.now(),
    } as const;
    branch.push({ type: "message", id: "assistant-allowance", parentId: "user-allowance", timestamp: new Date().toISOString(), message: assistant as never });
    if (rejectSettlement) writeFileSync(`${reliabilityV2Path(cwd)}.lock`, "malformed held lock");
    await handlers.get("turn_end")?.({ messageEntryId: "assistant-allowance", message: assistant, toolResults, toolResultEntryIds: toolResults.map((_, index) => `tool-${index}`) } as never, ctx);
    const beforeSettleOperation = handlers.get("agent_before_settle")?.({ context: { pendingMessages: [] } } as never, ctx);
    if (interveneDuringSettlement) branch.push({ type: "custom" } as never);
    const beforeSettle = await beforeSettleOperation;
    let routeError: unknown;
    if ((routeAfterPrepare || reloadAfterPrepare) && beforeSettle) {
      branch.push({ type: "context_edit", targetId: "assistant-allowance", replacement: null } as never);
      if (routeAfterPrepare) branch.push({ type: "custom" } as never);
      if (reloadAfterPrepare) {
        writeFileSync(configPath, JSON.stringify({ ...config, reliability: { ...config.reliability, retryOnAllowanceExhausted: false } }));
        await commandHandler("reload", ctx);
      }
      try {
        const route = routeDefinition!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: unknown }>;
        await route({ model: ctx.model, reason: "user", thinkingLevel: "low", messages: [user] } as unknown as ModelRouteRequest, ctx);
      } catch (error) { routeError = error; }
    }
    await handlers.get("agent_settled")?.({} as never, ctx);
    const state = new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(reloadOptOut
      ? { ...config.reliability, cooldownOnAllowanceExhausted: false }
      : config.reliability), requireInitialized: true }).readSnapshot();
    return { state, beforeSettle, routeError };
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("reliability v2 registered Auto runtime", () => {
  it("fails closed before a registered prompt-classifier call if the v2 snapshot becomes unreadable after preflight", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-v2-classifier-state-race-"));
    const agentDir = join(cwd, "agent");
    const configDir = join(cwd, ".pi");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const config = {
      schemaVersion: 2,
      enabled: true,
      default: "quick",
      strategy: "first",
      classifier: { enabled: true, backend: "prompt", model: "fixture/classifier" },
      models: { quick: ["fixture/healthy"] },
      reliability: { stateVersion: 2, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 1 },
      rules: [],
    } as const;
    writeFileSync(join(configDir, "bifrost.json"), JSON.stringify(config));
    const user = { role: "user", content: [{ type: "text", text: "route without an unavailable classifier" }] } as const;
    const branch: SessionMessageEntry[] = [{ type: "message", id: "race-user", parentId: "root", timestamp: new Date().toISOString(), message: user as never }];
    const classifier = makeModel("fixture", "classifier");
    const healthy = makeModel("fixture", "healthy");
    const v2Path = reliabilityV2Path(cwd);
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
    let routeDefinition: VirtualModelDefinition | undefined;
    let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    let classifierCalls = 0;
    let refreshCalls = 0;
    const ctx = {
      cwd, mode: "rpc", hasUI: false,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => [classifier, healthy],
        find: (provider: string, id: string) => [classifier, healthy].find((model) => model.provider === provider && model.id === id),
        getAvailableOfType: async () => [],
        getModelOfType: () => undefined,
        getProviderAuthStatus: () => ({ configured: false }),
        streamSimple: () => {
          classifierCalls += 1;
          return { result: async () => ({ content: [{ type: "text", text: "quick" }] }) };
        },
        refresh: async () => {
          refreshCalls += 1;
          writeFileSync(v2Path, "{invalid sidecar");
          return { refreshed: [], errors: new Map() };
        },
      },
      sessionManager: { getHeader: () => ({ id: "session-classifier-state-race" }), getBranch: () => branch },
      ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
      registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = options.handler; },
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; },
      setModel: async () => true,
    } as unknown as ExtensionAPI;

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      bifrostExtension(pi);
      assert.ok(routeDefinition?.route && commandHandler);
      await commandHandler("reliability migrate --fresh", ctx);
      const request = { model: ctx.model, reason: "user", thinkingLevel: "low", messages: [user] } as unknown as ModelRouteRequest;
      const route = routeDefinition.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<unknown>;
      await assert.rejects(route(request, ctx));
      assert.equal(refreshCalls, 1, "the test invalidates state only after the route preflight read");
      assert.equal(classifierCalls, 0, "an unreadable required v2 snapshot must suppress the registered classifier request");
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("enforces allowance cooldown with observations off, and honors a reload opt-out", async () => {
    const { state: enforced } = await runAllowanceRuntime();
    const enforcedScope = enforced.scopes[modelScopeKey("fixture/allowed")];
    assert.ok(enforcedScope?.openUntil && enforcedScope.openUntil > Date.now(),
      "a runtime-bound allowance observation should immediately cool down the selected model");
    assert.equal(enforcedScope?.failures.length, 1);
    assert.equal(Object.values(enforced.settledOutcomes).some((outcome) => outcome.observation !== undefined), false,
      "enforcement evidence must not silently enable optional observation persistence");

    const { state: optedOut } = await runAllowanceRuntime({ reloadOptOut: true });
    const optedOutScope = optedOut.scopes[modelScopeKey("fixture/allowed")];
    assert.equal(optedOutScope?.openUntil, undefined,
      "a valid reload with cooldownOnAllowanceExhausted=false restores threshold behavior");
    assert.equal(optedOutScope?.failures.length, 1);
  });

  it("does not request allowance recovery after output or tool results", async () => {
    const withOutput = await runAllowanceRuntime({ failedContent: [{ type: "text", text: "partial output" }] });
    const withTools = await runAllowanceRuntime({ toolResults: [{ content: [{ type: "text", text: "tool ran" }] }] });
    const withPriorTools = await runAllowanceRuntime({ priorToolHistory: true });
    assert.equal(withOutput.beforeSettle, undefined, "partial assistant output cannot enter the retry boundary");
    assert.equal(withTools.beforeSettle, undefined, "tool results cannot enter the retry boundary");
    assert.equal(withPriorTools.beforeSettle, undefined, "earlier tool calls and results cannot enter the retry boundary");
    for (const { state } of [withOutput, withTools, withPriorTools]) {
      assert.ok(state.scopes[modelScopeKey("fixture/allowed")]?.openUntil,
        "unsafe failures still settle and apply the model-only cooldown");
    }
  });

  it("does not continue the failed turn when v2 receipt settlement is unconfirmed", async () => {
    const { state, beforeSettle } = await runAllowanceRuntime({ rejectSettlement: true });
    assert.equal(beforeSettle, undefined, "the real registered before-settle hook must not omit the failure or continue");
    const dispatch = Object.values(state.dispatches)[0];
    assert.ok(dispatch);
    assert.equal(dispatch.settledAt, undefined, "the receipt remains visibly unsettled for inspection");
  });

  it("rechecks the raw branch after awaited settlement before preparing an alternate", async () => {
    const { state, beforeSettle } = await runAllowanceRuntime({ interveneDuringSettlement: true });
    assert.equal(beforeSettle, undefined, "a branch entry appended during settlement must cancel the retry");
    const dispatch = Object.values(state.dispatches)[0];
    assert.ok(dispatch?.settledAt, "the original allowance failure remains settled");
  });

  it("stops a prepared retry after new branch activity instead of routing normally", async () => {
    const { state, beforeSettle, routeError } = await runAllowanceRuntime({ routeAfterPrepare: true });
    assert.ok(beforeSettle, "the original safe boundary prepares the alternate");
    assert.match(String(routeError), /prepared usage-limit retry was cancelled/);
    assert.equal(Object.keys(state.dispatches).length, 1, "the stale continuation does not admit a second model");
  });

  it("stops a prepared retry after reload disables recovery instead of routing normally", async () => {
    const { state, beforeSettle, routeError } = await runAllowanceRuntime({ reloadAfterPrepare: true });
    assert.ok(beforeSettle, "the original safe boundary prepares the alternate");
    assert.match(String(routeError), /prepared usage-limit retry was cancelled/);
    assert.equal(Object.keys(state.dispatches).length, 1, "the reloaded route does not admit another model");
  });

  it("binds the latest real branch user despite a trailing synthetic user message and stores only normalized failure evidence", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-v2-runtime-"));
    const agentDir = join(cwd, "agent");
    const configDir = join(cwd, ".pi");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const config = {
      schemaVersion: 2,
      enabled: true,
      default: "quick",
      strategy: "first",
      classifier: { enabled: true, backend: CLASSIFIER_BACKEND_IDS.piNative, piNative: { model: "fixture/classifier" } },
      models: { quick: ["fixture/allowed"] },
      affinity: { mode: "observe" },
      reliability: { stateVersion: 2, observations: { enabled: true }, failureThreshold: 2 },
      debug: { enabled: true, path: "trace.jsonl" },
      rules: [],
    } as const;
    writeFileSync(join(configDir, "bifrost.json"), JSON.stringify(config));
    const user = { role: "user", content: [{ type: "text", text: "do the task" }] } as const;
    const branch: SessionMessageEntry[] = [{ type: "message", id: "user-entry", parentId: "root", timestamp: new Date().toISOString(), message: user as never }];
    const model = makeModel("fixture", "allowed");
    const classifier = makePiClassifierModel("fixture", "classifier");
    let classifierCalls = 0;
    let duringClassify: (() => Promise<void>) | undefined;
    let setModelCalls = 0;
    let refreshCalls = 0;
    let refreshGate: { entered: () => void; enteredPromise: Promise<void>; releasePromise: Promise<void> } | undefined;
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
    let routeDefinition: VirtualModelDefinition | undefined;
    let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    let logs: string[] = [];
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: false,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => [model],
        find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getAvailableOfType: async () => [classifier],
        getModelOfType: (_type: string, provider: string, id: string) => provider === classifier.provider && id === classifier.id ? classifier : undefined,
        classify: async () => {
          classifierCalls += 1;
          await duringClassify?.();
          return { api: "systemone", provider: classifier.provider, model: classifier.id, answers: { tier: { type: "choice", choice: "quick", confidence: 0.9, probabilities: { quick: 0.9 } } }, stopReason: "stop", timestamp: Date.now() } as never;
        },
        getProviderAuthStatus: () => ({ configured: false }),
        refresh: async () => {
          refreshCalls += 1;
          const gate = refreshGate;
          if (gate) {
            refreshGate = undefined;
            gate.entered();
            await gate.releasePromise;
          }
          return { refreshed: [], errors: [] };
        },
      },
      sessionManager: {
        getHeader: () => ({ id: "session-1" }),
        getBranch: () => branch,
      },
      ui: { notify: (message: string) => { logs.push(message); }, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
      registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = options.handler; },
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; },
      setModel: async () => { setModelCalls += 1; return true; },
    } as unknown as ExtensionAPI;

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env[TYPE_SAFE_API_KEY_ENV];
      bifrostExtension(pi);
      assert.ok(routeDefinition?.route);
      assert.ok(commandHandler);
      const synthetic = { role: "user", content: [{ type: "text", text: "unrelated extension context" }] } as const;
      const request = {
        model: ctx.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [user, synthetic],
      } as unknown as ModelRouteRequest;
      const route = routeDefinition.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: unknown }>;
      await assert.rejects(route(request, ctx), /sidecar before routing/);
      assert.equal(classifierCalls, 0);
      assert.equal(refreshCalls, 0);
      await commandHandler("reliability migrate --fresh", ctx);
      const directRequest = { ...request, reason: "direct" } as unknown as ModelRouteRequest;
      await assert.rejects(route(directRequest, ctx), /does not support direct utility requests/);
      const mutableContext = ctx as unknown as { model: typeof model };
      mutableContext.model = model;
      const physicalResult = await handlers.get("input")?.({ text: "do the task", source: "interactive", streamingBehavior: "steer" } as never, ctx);
      assert.deepEqual(physicalResult, { action: "handled" });
      assert.equal(classifierCalls, 0);
      assert.equal(refreshCalls, 0);
      assert.equal(setModelCalls, 0);
      mutableContext.model = { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" } as never;
      const makeRefreshGate = () => {
        let enter!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { enter = resolve; });
        const releasePromise = new Promise<void>((resolve) => { release = resolve; });
        refreshGate = { entered: enter, enteredPromise, releasePromise };
        return { enteredPromise, release };
      };
      const branchGate = makeRefreshGate();
      const branchRace = route(request, ctx);
      await branchGate.enteredPromise;
      const raceUser = { role: "user", content: [{ type: "text", text: "newer queued user" }] } as const;
      branch.push({ type: "message", id: "racing-user-entry", parentId: "user-entry", timestamp: new Date().toISOString(), message: raceUser as never });
      branchGate.release();
      await assert.rejects(branchRace, /boundary changed before admission/);
      branch.pop();
      assert.equal(Object.keys(new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(config.reliability), requireInitialized: true }).readSnapshot().dispatches).length, 0);

      const realNow = Date.now;
      let testNow = realNow() + 60_000;
      Date.now = () => testNow;
      try {
        const manualGate = makeRefreshGate();
        const manualRace = route(request, ctx);
        await manualGate.enteredPromise;
        mutableContext.model = model;
        await handlers.get("model_select")?.({ model, source: "set" } as never, ctx);
        mutableContext.model = { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" } as never;
        manualGate.release();
        await assert.rejects(manualRace, /disabled or pinned during routing/);
        assert.equal(Object.keys(new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(config.reliability), requireInitialized: true }).readSnapshot().dispatches).length, 0);
        await commandHandler("unpin", ctx);

        testNow += 60_000;
        const configGate = makeRefreshGate();
        const configRace = route(request, ctx);
        await configGate.enteredPromise;
        writeFileSync(join(configDir, "bifrost.json"), JSON.stringify({ ...config, strategy: "random" }));
        await commandHandler("reload", ctx);
        configGate.release();
        await assert.rejects(configRace, /boundary changed before admission/);
        assert.equal(Object.keys(new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(config.reliability), requireInitialized: true }).readSnapshot().dispatches).length, 0);
      } finally {
        Date.now = realNow;
      }
      const routed = await route(request, ctx);
      assert.equal(routed.model, model);
      assert.equal(classifierCalls, 2);
      const store = new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(config.reliability), requireInitialized: true });

      const unrelatedAssistant = {
        role: "assistant", content: [], api: model.api, provider: "fixture-other", model: "other",
        stopReason: "stop", timestamp: Date.now(),
      } as const;
      branch.push({ type: "message", id: "assistant-unrelated-model", parentId: "user-entry", timestamp: new Date().toISOString(), message: unrelatedAssistant as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-unrelated-model", message: unrelatedAssistant } as never, ctx);
      const beforeOwnedAssistant = Object.values(store.readSnapshot().dispatches)[0]!;
      assert.equal(beforeOwnedAssistant.settledAt, undefined,
        "an assistant result from another physical model cannot settle this user's receipt");

      const assistant = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: "429 rate limit for secret-user-request-token",
        timestamp: Date.now(),
      } as const;
      branch.push({ type: "message", id: "assistant-entry", parentId: "user-entry", timestamp: new Date().toISOString(), message: assistant as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-entry", message: assistant } as never, ctx);
      await handlers.get("agent_settled")?.({} as never, ctx);

      const snapshot = store.readSnapshot();
      assert.equal(Object.values(snapshot.scopes)[0]?.failures.length, 1);
      const persisted = JSON.stringify(snapshot);
      assert.match(persisted, /"category":"rate_limit"/);
      assert.doesNotMatch(persisted, /secret-user-request-token/);
      assert.equal(logs.some((line) => line.includes("secret-user-request-token")), false);

      const secondUser = { role: "user", content: [{ type: "text", text: "another task" }] } as const;
      branch.push({ type: "message", id: "user-entry-2", parentId: "assistant-entry", timestamp: new Date().toISOString(), message: secondUser as never });
      const secondRequest = { ...request, messages: [secondUser] } as unknown as ModelRouteRequest;
      assert.equal((await route(secondRequest, ctx)).model, model);
      const secondReceiptIds = Object.keys(store.readSnapshot().dispatches);
      assert.equal(secondReceiptIds.length, 2, "the prior settled receipt remains for dedup while the new turn is admitted");
      const classifierCallsBeforeStickyRoutes = classifierCalls;
      const retryError = { ...assistant, stopReason: "error", errorMessage: "temporary retryable failure" } as const;
      branch.push({ type: "message", id: "assistant-entry-2-error", parentId: "user-entry-2", timestamp: new Date().toISOString(), message: retryError as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-entry-2-error", message: retryError } as never, ctx);
      const retryRequest = { ...secondRequest, reason: "retry", failed: { model, thinkingLevel: "low" } } as unknown as ModelRouteRequest;
      assert.equal((await route(retryRequest, ctx)).model, model);
      assert.deepEqual(Object.keys(store.readSnapshot().dispatches), secondReceiptIds);
      const toolUse = { ...assistant, stopReason: "toolUse", errorMessage: undefined } as const;
      branch.push({ type: "message", id: "assistant-entry-2-tool", parentId: "assistant-entry-2-error", timestamp: new Date().toISOString(), message: toolUse as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-entry-2-tool", message: toolUse } as never, ctx);
      const continuationRequest = { ...secondRequest, reason: "continuation", previous: { model, thinkingLevel: "low" } } as unknown as ModelRouteRequest;
      assert.equal((await route(continuationRequest, ctx)).model, model);
      assert.deepEqual(Object.keys(store.readSnapshot().dispatches), secondReceiptIds);
      const success = { ...assistant, stopReason: "stop", errorMessage: undefined } as const;
      branch.push({ type: "message", id: "assistant-entry-2-success", parentId: "assistant-entry-2-tool", timestamp: new Date().toISOString(), message: success as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-entry-2-success", message: success } as never, ctx);
      await handlers.get("agent_settled")?.({} as never, ctx);
      assert.equal(classifierCalls, classifierCallsBeforeStickyRoutes, "continuation and retry do not classify again");

      const originalConsoleError = console.error;
      const output: string[] = [];
      console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
      try { await commandHandler("inspect --json", ctx); }
      finally { console.error = originalConsoleError; }
      const inspection = JSON.parse(output.find((line) => line.startsWith("[bifrost-json] "))!.slice("[bifrost-json] ".length)) as { affinity?: { status?: string; anchor?: { model?: string } } };
      assert.equal(inspection.affinity?.status, "anchored");
      assert.equal(inspection.affinity?.anchor?.model, "fixture/allowed");
      assert.equal(JSON.stringify(inspection).includes("user-entry"), false);
      const noRouteUser = { role: "user", content: [{ type: "text", text: "no route fixture prompt" }] } as const;
      branch.push({ type: "message", id: "user-entry-no-route", parentId: "assistant-entry-2-success", timestamp: new Date().toISOString(), message: noRouteUser as never });
      writeFileSync(join(configDir, "bifrost.json"), JSON.stringify({ ...config, models: { quick: ["fixture/missing"] } }));
      await commandHandler("reload", ctx);
      await assert.rejects(route({ ...request, messages: [noRouteUser] } as unknown as ModelRouteRequest, ctx), /no healthy physical model for tier quick/);
      await handlers.get("session_shutdown")?.({} as never, ctx);
      const traceText = readFileSync(join(cwd, "trace.jsonl"), "utf8");
      const trace = traceText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const lifecycle = trace.filter((row) => ["request", "selected", "admitted", "outcome_observed", "receipt_settled", "route_rejected", "no_route"].includes(String(row.event)));
      const retryEvent = lifecycle.find((row) => row.event === "request" && row.reason === "retry");
      assert.ok(retryEvent?.turn_correlation_id, "Pi retry receives a log-only turn correlation ID");
      assert.equal(retryEvent?.session_correlation_id !== undefined, true);
      assert.equal(retryEvent?.run_correlation_id !== undefined, true);
      assert.ok(lifecycle.some((row) => row.event === "request" && row.reason === "user" && row.turn_correlation_id === retryEvent.turn_correlation_id),
        "the retry shares its original fresh user turn correlation");
      assert.ok(lifecycle.some((row) => row.event === "outcome_observed" && row.outcome === "failure" && row.turn_correlation_id === retryEvent.turn_correlation_id));
      assert.ok(lifecycle.some((row) => row.event === "outcome_observed" && row.outcome === "success" && row.turn_correlation_id === retryEvent.turn_correlation_id));
      assert.ok(lifecycle.some((row) => row.event === "receipt_settled" && row.status === "confirmed" && row.turn_correlation_id === retryEvent.turn_correlation_id));
      assert.ok(lifecycle.some((row) => row.event === "route_rejected" && row.category === "reliability_state_unavailable"));
      assert.ok(lifecycle.some((row) => row.event === "route_rejected" && row.category === "boundary_changed"),
        "a branch race is logged as a static cancellation category");
      assert.ok(lifecycle.some((row) => row.event === "no_route" && row.category === "requested_tier_unavailable"),
        "strict no-route is distinguishable from provider dispatch failure");
      assert.ok(lifecycle.some((row) => row.event === "route_rejected" && row.category === "policy_no_route"));
      for (const receiptId of secondReceiptIds) assert.equal(traceText.includes(receiptId), false, "internal receipt IDs are not logged");
      assert.equal(traceText.includes("secret-user-request-token"), false);
      assert.equal(traceText.includes("do the task"), false);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("retains an in-memory anchor within an eligible Auto tier under v1", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-affinity-v1-"));
    const agentDir = join(cwd, "agent");
    const configDir = join(cwd, ".pi");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const config = {
      schemaVersion: 2,
      enabled: true,
      default: "quick",
      strategy: "random",
      classifier: { enabled: false },
      models: { quick: ["fixture/allowed", "fixture/alternate"] },
      affinity: { mode: "retain-within-tier" },
      reliability: { stateVersion: 1, failureThreshold: 2 },
      rules: [],
    } as const;
    writeFileSync(join(configDir, "bifrost.json"), JSON.stringify(config));
    const user = { role: "user", content: [{ type: "text", text: "do the task" }] } as const;
    const branch: SessionMessageEntry[] = [{ type: "message", id: "user-entry", parentId: "root", timestamp: new Date().toISOString(), message: user as never }];
    const model = makeModel("fixture", "allowed");
    const alternate = makeModel("fixture", "alternate");
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
    let routeDefinition: VirtualModelDefinition | undefined;
    let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    let physicalSetModelCalls = 0;
    const ctx = {
      cwd, mode: "rpc", hasUI: false,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => [model, alternate],
        find: (provider: string, id: string) => [model, alternate].find((candidate) => candidate.provider === provider && candidate.id === id),
        getAvailableOfType: async () => [],
        getModelOfType: () => undefined,
        getProviderAuthStatus: () => ({ configured: false }),
        refresh: async () => ({ refreshed: [], errors: [] }),
      },
      sessionManager: { getHeader: () => ({ id: "session-affinity" }), getBranch: () => branch },
      ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
      registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = options.handler; },
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; },
      setModel: async () => { physicalSetModelCalls += 1; return true; },
    } as unknown as ExtensionAPI;
    const inspect = async (): Promise<{ affinity?: { mode?: string; status?: string; anchor?: { model?: string } } }> => {
      const originalConsoleError = console.error;
      const output: string[] = [];
      console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
      try { await commandHandler!("inspect --json", ctx); }
      finally { console.error = originalConsoleError; }
      return JSON.parse(output.find((line) => line.startsWith("[bifrost-json] "))!.slice("[bifrost-json] ".length));
    };

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      bifrostExtension(pi);
      const request = { model: ctx.model, reason: "user", thinkingLevel: "low", messages: [user] } as unknown as ModelRouteRequest;
      const route = routeDefinition!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: unknown }>;
      const originalRandom = Math.random;
      Math.random = () => 0;
      try { assert.equal((await route(request, ctx)).model, model); }
      finally { Math.random = originalRandom; }
      const assistant = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() } as const;
      branch.push({ type: "message", id: "assistant-entry", parentId: "user-entry", timestamp: new Date().toISOString(), message: assistant as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-entry", message: assistant } as never, ctx);
      await handlers.get("agent_settled")?.({} as never, ctx);
      const anchored = await inspect();
      assert.equal(anchored.affinity?.status, "anchored");
      assert.equal(anchored.affinity?.anchor?.model, "fixture/allowed");
      assert.equal(anchored.affinity?.mode, "retain-within-tier");
      assert.equal(existsSync(reliabilityV2Path(cwd)), false);

      const nextUser = { role: "user", content: [{ type: "text", text: "continue the task" }] } as const;
      branch.push({ type: "message", id: "user-entry-next", parentId: "assistant-entry", timestamp: new Date().toISOString(), message: nextUser as never });
      const nextRequest = { ...request, messages: [nextUser] } as unknown as ModelRouteRequest;
      Math.random = () => 0.99;
      let retained: { model: unknown };
      try { retained = await route(nextRequest, ctx); }
      finally { Math.random = originalRandom; }
      assert.equal(retained.model, model, "the strategy's alternate winner is replaced by the eligible successful anchor");
      const nextAssistant = { ...assistant, timestamp: Date.now() + 1 } as const;
      branch.push({ type: "message", id: "assistant-entry-next", parentId: "user-entry-next", timestamp: new Date().toISOString(), message: nextAssistant as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-entry-next", message: nextAssistant } as never, ctx);
      await handlers.get("agent_settled")?.({} as never, ctx);

      const originalConsoleError = console.error;
      const previewOutput: string[] = [];
      console.error = (...values: unknown[]) => { previewOutput.push(values.map(String).join(" ")); };
      Math.random = () => 0.99;
      try { await commandHandler!("preview --trace --json follow up", ctx); }
      finally { Math.random = originalRandom; console.error = originalConsoleError; }
      const trace = JSON.parse(previewOutput.find((line) => line.startsWith("[bifrost-json] "))!.slice("[bifrost-json] ".length)) as { affinity?: { selection?: string; strategyWinner?: string; selectedModel?: string } };
      assert.equal(trace.affinity?.selection, "retained_anchor");
      assert.equal(trace.affinity?.strategyWinner, "fixture/alternate");
      assert.equal(trace.affinity?.selectedModel, "fixture/allowed");
      await handlers.get("session_before_tree")?.({} as never, ctx);
      assert.equal((await inspect()).affinity?.status, "locality_unknown");

      const physical = { ...ctx, model } as ExtensionContext;
      const originalPhysicalConsoleError = console.error;
      const physicalLog: string[] = [];
      console.error = (...values: unknown[]) => { physicalLog.push(values.map(String).join(" ")); };
      try {
        writeFileSync(join(configDir, "bifrost.json"), JSON.stringify({ ...config, affinity: { mode: "off", unsupportedSetting: "PRIVATE_CONFIG_SENTINEL" } }));
        await commandHandler!("reload", ctx);
        assert.ok(physicalLog.some((line) => line.includes("config reload rejected")));
        assert.equal(physicalLog.some((line) => line.includes("PRIVATE_CONFIG_SENTINEL")), false);
        assert.deepEqual(await handlers.get("input")?.({ text: "physical must remain blocked", source: "interactive" } as never, physical), { action: "handled" });
      } finally { console.error = originalPhysicalConsoleError; }
      assert.ok(physicalLog.some((line) => line.includes("retain-within-tier is supported for Auto user turns only")));
      assert.equal(physicalSetModelCalls, 0);

      bifrostExtension(pi);
      const startupInvalidLog: string[] = [];
      const startupConsoleError = console.error;
      console.error = (...values: unknown[]) => { startupInvalidLog.push(values.map(String).join(" ")); };
      try {
        assert.deepEqual(await handlers.get("input")?.({ text: "invalid affinity startup" , source: "interactive" } as never, physical), { action: "handled" });
      } finally { console.error = startupConsoleError; }
      assert.ok(startupInvalidLog.some((line) => line.includes("invalid routing or economic policy config")));
      assert.equal(startupInvalidLog.some((line) => line.includes("PRIVATE_CONFIG_SENTINEL")), false);
      assert.equal(physicalSetModelCalls, 0);

      const preferenceOnlyConfig = {
        schemaVersion: 2,
        enabled: true,
        default: "quick",
        classifier: { enabled: false },
        models: { quick: ["fixture/allowed"] },
        economics: { mode: "policy", scopes: {}, sources: [], admission: [], preference: { billingClass: "subscription" } },
        rules: [],
      };
      writeFileSync(join(configDir, "bifrost.json"), JSON.stringify(preferenceOnlyConfig));
      await commandHandler!("reload", ctx);
      await commandHandler!("classifier off", ctx);
      const preferenceUser = { role: "user", content: [{ type: "text", text: "no configured classification" }] } as const;
      branch.push({ type: "message", id: "user-preference-only", parentId: "assistant-entry-next", timestamp: new Date().toISOString(), message: preferenceUser as never });
      const preferenceRequest = { model: ctx.model, reason: "user", thinkingLevel: "low", messages: [preferenceUser] } as unknown as ModelRouteRequest;
      const routeAfterPreferenceConfig = routeDefinition!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: unknown }>;
      assert.equal((await routeAfterPreferenceConfig(preferenceRequest, ctx)).model, model, "preference-only policy preserves the last-model legacy fallback instead of adding a hard boundary");
      assert.equal(physicalSetModelCalls, 0);

    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("settles an owned half-open trial and ignores a later success from a stale generation", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-v2-halfopen-"));
    const agentDir = join(cwd, "agent");
    const configDir = join(cwd, ".pi");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const config = {
      schemaVersion: 2,
      enabled: true,
      default: "quick",
      strategy: "first",
      classifier: { enabled: false },
      models: { quick: ["fixture/allowed"] },
      affinity: { mode: "observe" },
      reliability: { stateVersion: 2, failureThreshold: 1, windowMinutes: 10, cooldownMinutes: 1 },
      rules: [],
    } as const;
    writeFileSync(join(configDir, "bifrost.json"), JSON.stringify(config));
    const now = Date.now();
    const v1Bytes = Buffer.from(JSON.stringify({ version: 1, models: { "fixture/allowed": { failures: [now - 1000], openUntil: now - 1 } } }));
    writeFileSync(join(configDir, "bifrost-reliability.json"), v1Bytes);
    const model = makeModel("fixture", "allowed");
    const user = { role: "user", content: [{ type: "text", text: "half-open recovery" }] } as const;
    const branch: SessionMessageEntry[] = [{ type: "message", id: "user-halfopen", parentId: "root", timestamp: new Date().toISOString(), message: user as never }];
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
    let routeDefinition: VirtualModelDefinition | undefined;
    let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const ctx = {
      cwd, mode: "rpc", hasUI: false,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => [model],
        find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getAvailableOfType: async () => [],
        getModelOfType: () => undefined,
        getProviderAuthStatus: () => ({ configured: false }),
        refresh: async () => ({ refreshed: [], errors: [] }),
      },
      sessionManager: { getHeader: () => ({ id: "session-halfopen" }), getBranch: () => branch },
      ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
      registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = options.handler; },
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; },
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const readInspect = async () => {
      const originalConsoleError = console.error;
      const output: string[] = [];
      console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
      try { await commandHandler!("inspect --json", ctx); }
      finally { console.error = originalConsoleError; }
      return JSON.parse(output.find((line) => line.startsWith("[bifrost-json] "))!.slice("[bifrost-json] ".length)) as { affinity?: { anchor?: { lastSuccessfulAt?: string } } };
    };
    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env[TYPE_SAFE_API_KEY_ENV];
      bifrostExtension(pi);
      await commandHandler!("reliability migrate", ctx);
      const route = routeDefinition!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: unknown }>;
      const request = { model: ctx.model, reason: "user", thinkingLevel: "low", messages: [user] } as unknown as ModelRouteRequest;
      assert.equal((await route(request, ctx)).model, model);
      const store = new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(config.reliability), requireInitialized: true });
      const key = modelScopeKey("fixture/allowed");
      assert.ok(store.readSnapshot().scopes[key]?.lease, "the admitted dispatch owns the expired half-open circuit trial");
      const success = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() } as const;
      branch.push({ type: "message", id: "assistant-halfopen", parentId: "user-halfopen", timestamp: new Date().toISOString(), message: success as never });
      await handlers.get("turn_end")?.({ messageEntryId: "assistant-halfopen", message: success } as never, ctx);
      await handlers.get("agent_settled")?.({} as never, ctx);
      const recovered = store.readSnapshot().scopes[key]!;
      assert.equal(recovered.lease, undefined);
      assert.equal(recovered.openUntil, undefined);
      assert.deepEqual(recovered.failures, []);
      const anchorBeforeStale = (await readInspect()).affinity?.anchor?.lastSuccessfulAt;
      assert.ok(anchorBeforeStale);

      const secondUser = { role: "user", content: [{ type: "text", text: "stale owner test" }] } as const;
      branch.push({ type: "message", id: "user-stale", parentId: "assistant-halfopen", timestamp: new Date().toISOString(), message: secondUser as never });
      const secondRequest = { ...request, messages: [secondUser] } as unknown as ModelRouteRequest;
      const realNow = Date.now;
      let expectedStaleGeneration = recovered.generation;
      Date.now = () => realNow() + 5000;
      try {
        const beforeTrial = structuredClone(store.readSnapshot());
        const prior = beforeTrial.scopes[key]!;
        beforeTrial.scopes[key] = {
          generation: prior.generation + 1,
          failures: [realNow() - 2000, realNow() - 1000],
          openUntil: realNow() - 1,
        };
        writeJsonFile(reliabilityV2Path(cwd), beforeTrial);
        assert.equal((await route(secondRequest, ctx)).model, model);
        const snapshot = structuredClone(store.readSnapshot());
        const trialScope = snapshot.scopes[key]!;
        assert.ok(trialScope.lease, "the second turn owns a distinct half-open lease before staleness is injected");
        expectedStaleGeneration = trialScope.generation + 1;
        snapshot.scopes[key] = {
          generation: expectedStaleGeneration,
          failures: [...trialScope.failures],
          ...(trialScope.openUntil === undefined ? {} : { openUntil: trialScope.openUntil }),
        };
        writeJsonFile(reliabilityV2Path(cwd), snapshot);
        const secondSuccess = { ...success, timestamp: Date.now() } as const;
        branch.push({ type: "message", id: "assistant-stale", parentId: "user-stale", timestamp: new Date().toISOString(), message: secondSuccess as never });
        await handlers.get("turn_end")?.({ messageEntryId: "assistant-stale", message: secondSuccess } as never, ctx);
        await handlers.get("agent_settled")?.({} as never, ctx);
      } finally { Date.now = realNow; }
      assert.equal(store.readSnapshot().scopes[key]?.generation, expectedStaleGeneration);
      assert.equal((await readInspect()).affinity?.anchor?.lastSuccessfulAt, anchorBeforeStale, "a stale generation cannot promote a newer success anchor");
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
