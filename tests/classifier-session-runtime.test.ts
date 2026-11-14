import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { flushDebug } from "../debug.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

describe("classifier session isolation", () => {
  it("isolates session overrides, in-flight aborts, and pipelines", { timeout: 15_000 }, async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousApiKey = process.env[TYPE_SAFE_API_KEY_ENV];
    const previousFetch = globalThis.fetch;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-classifier-session-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const config = {
      enabled: true,
      default: "quick",
      strategy: "first",
      classifier: {
        enabled: true,
        backend: "typesafe",
        fallback: "prompt",
        model: "fixture/prompt",
        criteria: { quick: "Small, bounded work.", general: "Larger implementation work." },
        totalTimeoutMs: 10_000,
        typesafe: { timeoutMs: 5_000, maxAttempts: 1, debug: false },
      },
      cache: { enabled: false, threshold: 1, ttlHours: 1 },
      models: { quick: ["fixture/quick"], general: ["fixture/general"] },
      rules: [],
    };
    writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify(config));

    const quick = makeModel("fixture", "quick");
    const general = makeModel("fixture", "general");
    const prompt = makeModel("fixture", "prompt");
    const models: Model<Api>[] = [quick, general, prompt];
    let sessionAId = "session-a";
    const managers = ["session-a", "session-b"].map((id) => ({
      getSessionId: () => id === "session-a" ? sessionAId : id,
      getHeader: () => ({ id }),
      getBranch: () => [],
    }));
    const makeContext = (sessionManager: typeof managers[number]): ExtensionContext => ({
      cwd,
      mode: "rpc",
      hasUI: false,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        getAvailableOfType: async () => [],
        refresh: async () => ({ refreshed: [], errors: new Map() }),
        streamSimple: () => {
          promptRequests += 1;
          return { result: async () => ({ content: [{ type: "text", text: "general" }] }) };
        },
      },
      sessionManager,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: () => {},
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
      },
    } as unknown as ExtensionContext);
    const [ctxA, ctxB] = managers.map(makeContext) as [ExtensionContext, ExtensionContext];
    let definition: VirtualModelDefinition | undefined;
    let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    let directRequests = 0;
    let promptRequests = 0;
    const pendingSignals = new Map<number, AbortSignal>();
    let releaseSessionB: ((response: Response) => void) | undefined;
    const choiceResponse = (choice: string): Response => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { tier: { type: "choice", choice, confidence: 0.95, probabilities: { quick: choice === "quick" ? 0.95 : 0.05, general: choice === "general" ? 0.95 : 0.05 } } },
    }), { status: 200 });

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env[TYPE_SAFE_API_KEY_ENV] = "test-only-key";
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        directRequests += 1;
        if (directRequests === 3 || directRequests === 4 || directRequests === 6) {
          const requestNumber = directRequests;
          const signal = init?.signal ?? undefined;
          if (signal) pendingSignals.set(requestNumber, signal);
          return await new Promise<Response>((resolve, reject) => {
            if (requestNumber === 4) releaseSessionB = resolve;
            const abort = () => reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return choiceResponse(directRequests === 1 ? "quick" : "general");
      }) as typeof fetch;
      const pi = {
        registerVirtualModel: (registered: VirtualModelDefinition) => { definition = registered; },
        registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { command = options.handler; },
        on: () => () => {},
        setModel: async () => true,
      } as unknown as ExtensionAPI;
      bifrostExtension(pi);
      assert.ok(definition?.route);
      assert.ok(command);
      const route = definition.route as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>;
      const request = (text: string): ModelRouteRequest => ({
        model: ctxA.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      } as unknown as ModelRouteRequest);

      assert.equal((await route(request("shared prompt"), ctxA)).model, quick);
      assert.equal((await route(request("shared prompt"), ctxB)).model, general, "session B must use its own classifier pipeline");
      assert.equal(directRequests, 2);

      const waitForRequest = async (number: number): Promise<void> => {
        for (let attempt = 0; attempt < 100 && !pendingSignals.has(number); attempt += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.ok(pendingSignals.has(number), `TypeSafe request ${number} started`);
      };
      const pendingRouteA = route(request("pending classification A"), ctxA);
      await waitForRequest(3);
      const pendingRouteB = route(request("pending classification B"), ctxB);
      await waitForRequest(4);
      await command("classifier off", ctxA);
      assert.equal(pendingSignals.get(3)?.aborted, true, "session A off aborts its in-flight classifier request");
      assert.equal(pendingSignals.get(4)?.aborted, false, "session A off does not abort session B's classifier request");
      await assert.rejects(pendingRouteA, /no configured tier|classifier settings changed/i);
      assert.ok(releaseSessionB);
      releaseSessionB(choiceResponse("general"));
      assert.equal((await pendingRouteB).model, general, "session B's in-flight classification completes");
      assert.equal(promptRequests, 0);

      const modelB = await route(request("session B after A opted out"), ctxB);
      assert.equal(modelB.model, general, "session B classifier remains enabled");
      assert.equal(directRequests, 5, "session B still makes its own direct classifier request");
      assert.equal(promptRequests, 0, "aborting direct classification must not start prompt fallback");

      await command("classifier on", ctxA);
      const replacedRoute = route(request("pending old session"), ctxA);
      await waitForRequest(6);
      sessionAId = "session-c";
      await command("classifier status", ctxA);
      assert.equal(pendingSignals.get(6)?.aborted, true, "replacing session aborts old classifier");
      await assert.rejects(replacedRoute, /classifier settings changed/i);
      assert.equal(promptRequests, 0, "replaced session cannot start prompt fallback");

      let selectedBeforeReplacement = false;
      const dispatchContext = {
        ...ctxA,
        hasUI: true,
        ui: { ...ctxA.ui, notify: (message: string) => {
          if (message.startsWith("Bifrost auto:")) {
            selectedBeforeReplacement = true;
            sessionAId = "session-d";
          }
        } },
      } as ExtensionContext;
      await assert.rejects(route(request("replace after selection"), dispatchContext), /changed before dispatch/i);
      assert.equal(selectedBeforeReplacement, true, "session changed after selection and before dispatch");
    } finally {
      await flushDebug();
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousApiKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousApiKey;
      globalThis.fetch = previousFetch;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
