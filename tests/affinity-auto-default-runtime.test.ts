import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, SessionMessageEntry, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import bifrostExtension from "../index.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

describe("Pi Auto affinity default", () => {
  it("retains a proven same-tier anchor by default, leaves prefixes and physical routing on strategy, and supports explicit off", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalRandom = Math.random;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-auto-affinity-default-"));
    const agentDir = join(cwd, "agent");
    const configDir = join(cwd, ".pi");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "bifrost.json");
    const config = {
      enabled: true,
      default: "quick",
      strategy: "random",
      classifier: { enabled: false },
      models: { quick: ["fixture/allowed", "fixture/alternate"] },
      reliability: { stateVersion: 1 },
      rules: [],
    } as const;
    writeFileSync(configPath, JSON.stringify(config));

    const allowed = makeModel("fixture", "allowed");
    const alternate = makeModel("fixture", "alternate");
    const models: Model<Api>[] = [allowed, alternate];
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
    let routeDefinition: VirtualModelDefinition | undefined;
    let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const setModelTargets: string[] = [];
    const branch: SessionMessageEntry[] = [];
    const sessionManager = { getHeader: () => ({ id: "session-auto-affinity-default" }), getBranch: () => branch };
    const autoModel = { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" };
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: false,
      model: autoModel,
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getAvailableOfType: async () => [],
        getModelOfType: () => undefined,
        getProviderAuthStatus: () => ({ configured: false }),
        refresh: async () => ({ refreshed: [], errors: new Map() }),
      },
      sessionManager,
      ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
      registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = options.handler; },
      on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => { handlers.set(event, handler); return () => {}; },
      setModel: async (model: Model<Api>) => { setModelTargets.push(`${model.provider}/${model.id}`); return true; },
    } as unknown as ExtensionAPI;
    const requestFor = (user: object): ModelRouteRequest => ({
      model: autoModel,
      reason: "user",
      thinkingLevel: "low",
      messages: [user],
    } as unknown as ModelRouteRequest);
    const addUser = (id: string, text: string, parentId: string): object => {
      const message = { role: "user", content: [{ type: "text", text }] };
      branch.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: message as never });
      return message;
    };
    const settle = async (userId: string, assistantId: string, model: Model<Api>): Promise<void> => {
      const assistant = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() };
      branch.push({ type: "message", id: assistantId, parentId: userId, timestamp: new Date().toISOString(), message: assistant as never });
      await handlers.get("turn_end")?.({ messageEntryId: assistantId, message: assistant } as never, ctx);
      await handlers.get("agent_settled")?.({} as never, ctx);
    };
    const preview = async (context: ExtensionContext = ctx): Promise<Record<string, unknown>> => {
      const output: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
      try { await commandHandler!("preview --trace --json continue", context); }
      finally { console.error = originalConsoleError; }
      const marker = output.find((line) => line.startsWith("[bifrost-json] "));
      assert.ok(marker);
      return JSON.parse(marker.slice("[bifrost-json] ".length)) as Record<string, unknown>;
    };
    const inspect = async (): Promise<Record<string, unknown>> => {
      const output: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
      try { await commandHandler!("inspect --json", ctx); }
      finally { console.error = originalConsoleError; }
      const marker = output.find((line) => line.startsWith("[bifrost-json] "));
      assert.ok(marker);
      return JSON.parse(marker.slice("[bifrost-json] ".length)) as Record<string, unknown>;
    };

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      bifrostExtension(pi);
      const route = routeDefinition!.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>;

      const firstUser = addUser("auto-user-1", "first turn", "root");
      Math.random = () => 0;
      assert.equal((await route(requestFor(firstUser), ctx)).model, allowed);
      await settle("auto-user-1", "auto-assistant-1", allowed);
      const initialInspection = await inspect() as { affinity?: { mode?: string; source?: string; status?: string; anchor?: { model?: string } } };
      assert.deepEqual(initialInspection.affinity, {
        mode: "retain-within-tier",
        source: "auto_default",
        status: "anchored",
        anchor: initialInspection.affinity?.anchor,
      });
      assert.equal(initialInspection.affinity?.anchor?.model, "fixture/allowed");

      const secondUser = addUser("auto-user-2", "continue in the same tier", "auto-assistant-1");
      Math.random = () => 0.99;
      assert.equal((await route(requestFor(secondUser), ctx)).model, allowed, "an uninterrupted conversation retains the successful same-tier model");
      const trace = await preview() as { affinity?: { mode?: string; modeSource?: string; selection?: string; strategyWinner?: string; selectedModel?: string } };
      assert.equal(trace.affinity?.mode, "retain-within-tier");
      assert.equal(trace.affinity?.modeSource, "auto_default");
      assert.equal(trace.affinity?.selection, "retained_anchor");
      assert.equal(trace.affinity?.strategyWinner, "fixture/alternate");
      assert.equal(trace.affinity?.selectedModel, "fixture/allowed");
      await settle("auto-user-2", "auto-assistant-2", allowed);

      const prefixEvent = await handlers.get("input")?.({ text: "quick use the other strategy winner", source: "interactive" } as never, ctx) as { action?: string; text?: string };
      assert.equal(prefixEvent.action, "transform");
      assert.equal(prefixEvent.text, "use the other strategy winner");
      const prefixUser = addUser("auto-user-prefix", prefixEvent.text!, "auto-assistant-2");
      assert.equal((await route(requestFor(prefixUser), ctx)).model, alternate, "a tier prefix bypasses automatic retention");
      await settle("auto-user-prefix", "auto-assistant-prefix", alternate);

      const thirdUser = addUser("auto-user-3", "continue after an explicit tier", "auto-assistant-prefix");
      assert.equal((await route(requestFor(thirdUser), ctx)).model, allowed, "a successful prefixed turn does not replace the Auto anchor");
      await settle("auto-user-3", "auto-assistant-3", allowed);

      const physical = { ...ctx, model: allowed } as ExtensionContext;
      Math.random = () => 0.99;
      await handlers.get("input")?.({ text: "physical route stays strategy driven", source: "interactive" } as never, physical);
      assert.equal(setModelTargets.at(-1), "fixture/alternate", "implicit Auto retention does not activate on physical routing");
      const physicalTrace = await preview(physical) as { affinity?: { mode?: string; modeSource?: string; selection?: string } };
      assert.equal(physicalTrace.affinity?.mode, "off");
      assert.equal(physicalTrace.affinity?.modeSource, "physical_default");
      assert.equal(physicalTrace.affinity?.selection, "not_applicable");

      await handlers.get("session_before_tree")?.({} as never, ctx);
      const afterTree = await inspect() as { affinity?: { mode?: string; source?: string; status?: string } };
      assert.deepEqual(afterTree.affinity, { mode: "retain-within-tier", source: "auto_default", status: "locality_unknown" });
      const newBranchUser = addUser("auto-user-new-branch", "new branch starts from strategy", "root");
      assert.equal((await route(requestFor(newBranchUser), ctx)).model, alternate, "a new branch starts without the prior branch anchor");
      await settle("auto-user-new-branch", "auto-assistant-new-branch", alternate);

      const offConfig = { ...config, schemaVersion: 2, affinity: { mode: "off" } };
      writeFileSync(configPath, JSON.stringify(offConfig));
      await commandHandler!("reload", ctx);
      const optedOutUser = addUser("auto-user-off", "after opting out", "auto-assistant-new-branch");
      assert.equal((await route(requestFor(optedOutUser), ctx)).model, alternate, "explicit schema-v2 off preserves the strategy winner");
      const offTrace = await preview() as { affinity?: { mode?: string; modeSource?: string; selection?: string } };
      assert.equal(offTrace.affinity?.mode, "off");
      assert.equal(offTrace.affinity?.modeSource, "config");
      assert.equal(offTrace.affinity?.selection, "not_applicable");
      const offInspection = await inspect() as { affinity?: { mode?: string; source?: string; status?: string } };
      assert.deepEqual(offInspection.affinity, { mode: "off", source: "config", status: "disabled" });
    } finally {
      Math.random = originalRandom;
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
