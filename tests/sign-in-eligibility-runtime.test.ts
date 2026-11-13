// Pre-dispatch sign-in eligibility (ADR 0026).
//
// A configured provider whose stored credential cannot be resolved is excluded
// before admission only when `signInEligibility: "exclude"` asks for it. The
// tests below drive the real Auto route through registered Pi hooks so the
// signal is proven at the seam that used to send the doomed request, not only
// in the pure resolver.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

type Hook = (event: any, ctx: ExtensionContext) => Promise<unknown>;

interface FixtureOptions {
  readonly eligibility?: "off" | "exclude";
  readonly models?: readonly Model<Api>[];
  readonly fallbackTiers?: readonly string[];
  readonly deadProviders?: readonly string[];
}

function fixture(options: FixtureOptions = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-sign-in-runtime-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });

  const inventory = [...(options.models ?? [makeModel("dead", "one", 1), makeModel("live", "two", 2)])];
  const dead = new Set(options.deadProviders ?? ["dead"]);
  const authCalls: string[] = [];
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "review",
    strategy: "first",
    ...(options.eligibility === undefined ? {} : { signInEligibility: options.eligibility }),
    models: { review: inventory.map((model) => `${model.provider}/${model.id}`) },
    ...(options.fallbackTiers === undefined
      ? {}
      : { tierPolicies: { review: { fallbackTiers: [...options.fallbackTiers] } } }),
    rules: [],
    classifier: { enabled: false },
    reliability: { enabled: true },
  };
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify(config));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let routeDefinition: VirtualModelDefinition | undefined;
  const dispatched: string[] = [];
  const handlers = new Map<string, Hook>();
  const branch: any[] = [];
  const sessionManager = { getHeader: () => ({ id: "sign-in-session" }), getBranch: () => branch };
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    signal: new AbortController().signal,
    model: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" } as Model<Api>,
    modelRegistry: {
      getAvailable: () => inventory,
      getAll: () => inventory,
      find: (provider: string, id: string) => inventory.find((model) => model.provider === provider && model.id === id),
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderAuth: async (provider: string) => {
        authCalls.push(provider);
        if (dead.has(provider)) throw new Error("token refresh failed");
        return { auth: { apiKey: "resolved" } };
      },
      refresh: async () => ({ refreshed: [], errors: new Map() }),
    },
    sessionManager,
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
  } as unknown as ExtensionContext;

  const pi = {
    registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: Hook) => { handlers.set(event, handler); return () => {}; },
    setModel: async (model: Model<Api>) => { dispatched.push(`${model.provider}/${model.id}`); return true; },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);

  const userMessage = { role: "user", content: [{ type: "text", text: "review the change" }] };
  branch.push({ type: "message", id: "user-1", parentId: "root", timestamp: new Date().toISOString(), message: userMessage });

  return {
    cwd,
    ctx,
    authCalls,
    dispatched,
    async route(): Promise<{ model: Model<Api> }> {
      const route = routeDefinition?.route as ((request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>) | undefined;
      assert.ok(route, "the extension must register the Auto route");
      return route({
        model: ctx.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [userMessage],
      } as unknown as ModelRouteRequest, ctx);
    },
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("pre-dispatch sign-in eligibility through the Auto route", { concurrency: false }, () => {
  it("excludes a provider whose sign-in cannot be resolved and dispatches the next model", async () => {
    const h = fixture({ eligibility: "exclude" });
    try {
      const result = await h.route();
      assert.equal(`${result.model.provider}/${result.model.id}`, "live/two");
      assert.ok(h.authCalls.includes("dead"), "the dead provider must be resolved before dispatch");
    } finally {
      h.cleanup();
    }
  });

  it("fault control: without the opt-in the doomed model is still dispatched and nothing is resolved", async () => {
    // Proves the exclusion above comes from the configuration, not from the
    // fixture, and that the default spends no auth resolution.
    const h = fixture({ eligibility: "off" });
    try {
      const result = await h.route();
      assert.equal(`${result.model.provider}/${result.model.id}`, "dead/one");
      assert.deepEqual(h.authCalls, []);
    } finally {
      h.cleanup();
    }
  });

  it("fails closed inside an explicit empty fallback boundary instead of borrowing another tier", async () => {
    const h = fixture({
      eligibility: "exclude",
      models: [makeModel("dead", "only", 1)],
      fallbackTiers: [],
    });
    try {
      // The tier's explicit empty boundary is terminal: the route fails closed
      // instead of borrowing another tier or sending the dead request.
      await assert.rejects(h.route());
      assert.deepEqual(h.dispatched, []);
    } finally {
      h.cleanup();
    }
  });
});
