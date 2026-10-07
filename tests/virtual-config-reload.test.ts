import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

function writeConfig(path: string, model: string): void {
  writeFileSync(path, JSON.stringify({
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: false, backend: CLASSIFIER_BACKEND_IDS.prompt },
    models: { quick: [model] },
    rules: [],
  }));
}

describe("virtual routing config reload", () => {
  it("uses the reloaded pool after an awaited registry refresh", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-reload-"));
    const agentDir = join(cwd, "agent");
    const configDir = join(cwd, ".pi");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const oldModel = makeModel("fixture", "old");
    const newModel = makeModel("fixture", "new");
    let available: Model<Api>[] = [];
    let refreshCount = 0;
    let virtualDefinition: VirtualModelDefinition | undefined;
    let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env[TYPE_SAFE_API_KEY_ENV];
      writeConfig(join(configDir, "bifrost.json"), "fixture/old");

      const modelRegistry = {
        getAvailable: () => available,
        find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        refresh: async () => {
          refreshCount += 1;
          markRefreshStarted();
          await refreshGate;
          available = [oldModel, newModel];
          return { refreshed: [], errors: [] };
        },
      };
      const sessionManager = { getBranch: () => [] };
      const ctx = {
        cwd,
        mode: "rpc",
        hasUI: false,
        model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
        modelRegistry,
        sessionManager,
      } as unknown as ExtensionContext;
      const pi = {
        registerVirtualModel: (definition: VirtualModelDefinition) => { virtualDefinition = definition; },
        registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
          commandHandler = options.handler;
        },
        on: () => () => {},
        setModel: async () => false,
      } as unknown as ExtensionAPI;

      bifrostExtension(pi);
      assert.ok(virtualDefinition);
      assert.ok(commandHandler);

      const request = {
        model: ctx.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "route this request" }] }],
      } as unknown as ModelRouteRequest;
      const route = virtualDefinition.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>;
      const routed = route(request, ctx);

      await refreshStarted;
      writeConfig(join(configDir, "bifrost.json"), "fixture/new");
      await commandHandler("reload", ctx);
      releaseRefresh();

      const result = await routed;
      assert.equal(refreshCount, 1);
      assert.equal(result.model, newModel);
      assert.notEqual(result.model, oldModel);
    } finally {
      releaseRefresh?.();
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
