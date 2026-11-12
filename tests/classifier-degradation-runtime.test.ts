import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { flushDebug } from "../debug.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

describe("direct classifier degradation at the registered Auto route", () => {
  it("warns on a TypeSafe timeout, deduplicates its open circuit, and reports recovery without logging prompt text", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousApiKey = process.env[TYPE_SAFE_API_KEY_ENV];
    const previousFetch = globalThis.fetch;
    const previousNow = Date.now;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-classifier-degradation-"));
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
        typesafe: { timeoutMs: 100, maxAttempts: 1, debug: false },
      },
      reliability: { enabled: true, failureThreshold: 1, cooldownMinutes: 1 },
      cache: { enabled: false },
      debug: { enabled: true, path: ".pi/degradation.jsonl" },
      models: { quick: ["fixture/generation"] },
      rules: [],
    };
    const configPath = join(cwd, ".pi", "bifrost.json");
    writeFileSync(configPath, JSON.stringify(config));

    const generation = makeModel("fixture", "generation");
    const promptModel = makeModel("fixture", "prompt");
    const models: Model<Api>[] = [generation, promptModel];
    const notifications: Array<{ message: string; type?: string }> = [];
    const branch: unknown[] = [];
    const sessionManager = { getHeader: () => ({ id: "classifier-degradation" }), getBranch: () => branch };
    let fetchMode: "timeout" | "success" = "timeout";
    let externalRequests = 0;
    let promptRequests = 0;
    let now = 1_800_000_000_000;
    let definition: VirtualModelDefinition | undefined;
    const ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        getAvailableOfType: async () => [],
        refresh: async () => ({ refreshed: [], errors: new Map() }),
        streamSimple: () => {
          promptRequests += 1;
          return { result: async () => ({ content: [{ type: "text", text: "quick" }] }) };
        },
      },
      sessionManager,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: (message: string, type?: string) => { notifications.push({ message, type }); },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
      },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (registered: VirtualModelDefinition) => { definition = registered; },
      registerCommand: () => {},
      on: () => () => {},
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const routeRequest = (): ModelRouteRequest => ({
      model: ctx.model,
      reason: "user",
      thinkingLevel: "low",
      messages: [{ role: "user", content: [{ type: "text", text: "SECRET_PROMPT_SENTINEL classify this task" }] }],
    } as unknown as ModelRouteRequest);

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env[TYPE_SAFE_API_KEY_ENV] = "test-only-key";
      Date.now = () => now;
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        externalRequests += 1;
        if (fetchMode === "success") {
          const payload = {
            model: "jev-1.13.0",
            answers: { tier: { type: "choice", choice: "quick", confidence: 0.95, probabilities: { quick: 0.95, general: 0.025, frontier: 0.025 } } },
          };
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => reject(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }) as typeof fetch;

      bifrostExtension(pi);
      assert.ok(definition?.route);
      const route = definition.route as (request: ModelRouteRequest, context: ExtensionContext) => Promise<{ model: Model<Api> }>;

      const first = await route(routeRequest(), ctx);
      assert.equal(first.model, generation);
      assert.equal(externalRequests, 1);
      assert.equal(promptRequests, 1);
      const warningAfterTimeout = notifications.filter(({ type }) => type === "warning");
      assert.equal(warningAfterTimeout.length, 1);
      assert.match(warningAfterTimeout[0]!.message, /typesafe classifier timed out/);
      assert.match(warningAfterTimeout[0]!.message, /prompt classifier \(fixture\/prompt\)/);
      assert.match(warningAfterTimeout[0]!.message, /model-only circuit is open until/);

      await route(routeRequest(), ctx);
      assert.equal(externalRequests, 1, "open circuit prevents another TypeSafe provider request");
      assert.equal(promptRequests, 2, "the configured prompt fallback remains active");
      assert.equal(notifications.filter(({ type }) => type === "warning").length, 1, "the same open circuit is announced once");

      const openUntil = 1_800_000_060_000;
      assert.match(warningAfterTimeout[0]!.message, new RegExp(new Date(openUntil).toISOString()));
      now = openUntil + 1;
      fetchMode = "success";
      await route(routeRequest(), ctx);
      assert.equal(externalRequests, 2);
      await flushDebug();
      assert.equal(promptRequests, 2, "a successful direct classifier no longer uses the prompt fallback");
      assert.ok(notifications.some(({ message }) => /typesafe classifier recovered/.test(message)));
      notifications.length = 0;
      const healthyCtx = { ...ctx, sessionManager: { getHeader: () => ({ id: "healthy-classifier" }), getBranch: () => [] } } as unknown as ExtensionContext;
      await route(routeRequest(), healthyCtx);
      assert.equal(externalRequests, 3);
      assert.equal(promptRequests, 2);
      assert.equal(notifications.filter(({ type }) => type === "warning").length, 0, "a healthy classifier does not emit a degradation warning");
      await flushDebug();
      const events = readFileSync(join(cwd, ".pi", "degradation.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

      const degraded = events.find((event) => event.module === "classifier" && event.event === "degraded");
      assert.ok(degraded);
      const attempts = events.filter((event) => event.module === "classifier" && event.event === "attempt_outcome");
      assert.deepEqual(attempts.map((event) => event.outcome), ["timeout", "circuit_open", "success", "success"]);
      assert.equal(new Set(attempts.slice(0, 3).map((event) => event.request_correlation_id)).size, 3);
      assert.equal(events.filter((event) => event.module === "classifier" && event.event === "degraded").length, 1);
      assert.ok(events.some((event) => event.module === "classifier" && event.event === "recovered"));
      const decisions = events.filter((event) => event.module === "virtual" && event.event === "route_decision");
      const firstDecision = decisions[0]?.decision as { classifierAttempt?: { outcome?: string; fallbackKind?: string; fallbackModel?: string } } | undefined;
      assert.deepEqual(firstDecision?.classifierAttempt, {
        backend: "typesafe",
        outcome: "timeout",
        model: "jev-1.13.0",
        fallbackKind: "prompt",
        fallbackModel: "fixture/prompt",
        circuitOpenUntil: openUntil,
      });
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes("SECRET_PROMPT_SENTINEL"), false);
      assert.equal(serialized.includes("test-only-key"), false);
    } finally {
      await flushDebug();
      globalThis.fetch = previousFetch;
      Date.now = previousNow;
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousApiKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousApiKey;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("logs every total-budget expiry while deduplicating warnings, then re-arms after a successful prompt result", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-classifier-budget-warning-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const configPath = join(cwd, ".pi", "bifrost.json");
    const config = {
      enabled: true,
      default: "quick",
      strategy: "first",
      classifier: { enabled: true, backend: "prompt", model: "fixture/prompt", totalTimeoutMs: 10 },
      cache: { enabled: false },
      debug: { enabled: true, path: ".pi/budget.jsonl" },
      models: { quick: ["fixture/generation"] },
      rules: [],
    };
    writeFileSync(configPath, JSON.stringify(config));

    const generation = makeModel("fixture", "generation");
    const promptModel = makeModel("fixture", "prompt");
    const models: Model<Api>[] = [generation, promptModel];
    const notifications: Array<{ message: string; type?: string }> = [];
    const handlers = new Map<string, (args: string, context: ExtensionContext) => Promise<void>>();
    const manager = { getHeader: () => ({ id: "classifier-budget" }), getBranch: () => [] };
    let promptMode: "hang" | "success" = "hang";
    let promptRequests = 0;
    let definition: VirtualModelDefinition | undefined;
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: true,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        getAvailableOfType: async () => [],
        refresh: async () => ({ refreshed: [], errors: new Map() }),
        streamSimple: (_model: Model<Api>, _request: unknown, options: { signal?: AbortSignal }) => {
          promptRequests += 1;
          if (promptMode === "success") return { result: async () => ({ content: [{ type: "text", text: "quick" }] }) };
          return { result: () => new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ content: [] }), { once: true })) };
        },
      },
      sessionManager: manager,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: (message: string, type?: string) => { notifications.push({ message, type }); },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
      },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (registered: VirtualModelDefinition) => { definition = registered; },
      registerCommand: (_name: string, options: { handler: (args: string, context: ExtensionContext) => Promise<void> }) => { handlers.set(_name, options.handler); },
      on: () => () => {},
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const request = (): ModelRouteRequest => ({
      model: ctx.model,
      reason: "user",
      thinkingLevel: "low",
      messages: [{ role: "user", content: [{ type: "text", text: "BUDGET_PROMPT_SENTINEL" }] }],
    } as unknown as ModelRouteRequest);

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      bifrostExtension(pi);
      assert.ok(definition?.route);
      const route = definition.route as (request: ModelRouteRequest, context: ExtensionContext) => Promise<{ model: Model<Api> }>;
      await route(request(), ctx);
      await route(request(), ctx);
      assert.equal(promptRequests, 2);
      assert.equal(notifications.filter(({ type }) => type === "warning").length, 1);
      assert.match(notifications.find(({ type }) => type === "warning")!.message, /classifier time budget expired/);

      const reload = handlers.get("bifrost");
      assert.ok(reload);
      writeFileSync(configPath, JSON.stringify({ ...config, classifier: { ...config.classifier, totalTimeoutMs: 100 } }));
      await reload("reload", ctx);
      promptMode = "success";
      await route(request(), ctx);
      assert.equal(promptRequests, 3);
      assert.equal(notifications.filter(({ type }) => type === "warning").length, 1);

      writeFileSync(configPath, JSON.stringify(config));
      await reload("reload", ctx);
      promptMode = "hang";
      await route(request(), ctx);
      assert.equal(promptRequests, 4);
      assert.equal(notifications.filter(({ type }) => type === "warning").length, 2);

      await flushDebug();
      const events = readFileSync(join(cwd, ".pi", "budget.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const expiries = events.filter((event) => event.module === "classifier" && event.event === "budget_expired");
      assert.equal(expiries.length, 3);
      assert.equal(new Set(expiries.map((event) => event.request_correlation_id)).size, 3);
      assert.ok(events.some((event) => event.module === "classifier" && event.event === "budget_recovered"));
      assert.equal(JSON.stringify(events).includes("BUDGET_PROMPT_SENTINEL"), false);
    } finally {
      await flushDebug();
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("logs a prompt fallback deadline alongside a direct classifier warning without duplicate notices", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousApiKey = process.env[TYPE_SAFE_API_KEY_ENV];
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-mixed-classifier-deadline-"));
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
        totalTimeoutMs: 500,
        typesafe: { timeoutMs: 100, maxAttempts: 1, debug: false },
      },
      cache: { enabled: false },
      debug: { enabled: true, path: ".pi/mixed-deadline.jsonl" },
      models: { quick: ["fixture/generation"] },
      rules: [],
    };
    writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify(config));

    const generation = makeModel("fixture", "generation");
    const promptModel = makeModel("fixture", "prompt");
    const models: Model<Api>[] = [generation, promptModel];
    const notifications: Array<{ message: string; type?: string }> = [];
    const manager = { getHeader: () => ({ id: "classifier-mixed-deadline" }), getBranch: () => [] };
    let promptRequests = 0;
    let definition: VirtualModelDefinition | undefined;
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: true,
      model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" },
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        getAvailableOfType: async () => [],
        refresh: async () => ({ refreshed: [], errors: new Map() }),
        streamSimple: (_model: Model<Api>, _request: unknown, options: { signal?: AbortSignal }) => {
          promptRequests += 1;
          return { result: () => new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ content: [] }), { once: true })) };
        },
      },
      sessionManager: manager,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: (message: string, type?: string) => { notifications.push({ message, type }); },
        setStatus: () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
      },
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: (registered: VirtualModelDefinition) => { definition = registered; },
      registerCommand: () => {},
      on: () => () => {},
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const routeRequest = (): ModelRouteRequest => ({
      model: ctx.model,
      reason: "user",
      thinkingLevel: "low",
      messages: [{ role: "user", content: [{ type: "text", text: "MIXED_DEADLINE_PROMPT_SENTINEL" }] }],
    } as unknown as ModelRouteRequest);

    try {
      process.chdir(cwd);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env[TYPE_SAFE_API_KEY_ENV];
      bifrostExtension(pi);
      assert.ok(definition?.route);
      const route = definition.route as (request: ModelRouteRequest, context: ExtensionContext) => Promise<{ model: Model<Api> }>;
      const first = await route(routeRequest(), ctx);
      assert.equal(first.model, generation);
      assert.equal(promptRequests, 1);
      const firstWarning = notifications.filter(({ type }) => type === "warning");
      assert.equal(firstWarning.length, 1, "direct failure and total deadline share one notice");
      assert.match(firstWarning[0]!.message, /typesafe classifier has no configured credential/);
      assert.match(firstWarning[0]!.message, /configured default tier/);
      assert.match(firstWarning[0]!.message, /total classifier time budget expired/);

      await route(routeRequest(), ctx);
      assert.equal(promptRequests, 2);
      assert.equal(notifications.filter(({ type }) => type === "warning").length, 1, "the same direct-plus-deadline state is deduplicated");

      await flushDebug();
      const events = readFileSync(join(cwd, ".pi", "mixed-deadline.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const expiries = events.filter((event) => event.module === "classifier" && event.event === "budget_expired");
      assert.equal(expiries.length, 2, "each total deadline is recorded even when the notice is deduplicated");
      assert.ok(expiries.every((event) => event.classification_outcome === "deadline" && event.budget_scope === "total_classifier"));
      assert.equal(new Set(expiries.map((event) => event.request_correlation_id)).size, 2);
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes("MIXED_DEADLINE_PROMPT_SENTINEL"), false);
      assert.equal(serialized.includes("SECRET"), false);
    } finally {
      await flushDebug();
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousApiKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousApiKey;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
