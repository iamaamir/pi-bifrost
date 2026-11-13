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
  /** Pool entries verbatim; default names every inventory model in full. */
  readonly pool?: readonly string[];
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
  let authGate: { provider: string; promise: Promise<void>; release: () => void } | undefined;
  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "review",
    strategy: "first",
    ...(options.eligibility === undefined ? {} : { signInEligibility: options.eligibility }),
    models: { review: [...(options.pool ?? inventory.map((model) => `${model.provider}/${model.id}`))] },
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
        if (authGate?.provider === provider) await authGate.promise;
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
    registerCommand: (_name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commandHandler = definition.handler;
    },
    on: (event: string, handler: Hook) => { handlers.set(event, handler); return () => {}; },
    setModel: async (model: Model<Api>) => { dispatched.push(`${model.provider}/${model.id}`); return true; },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);

  const userMessage = { role: "user", content: [{ type: "text", text: "review the change" }] };
  branch.push({ type: "message", id: "user-1", parentId: "root", timestamp: new Date().toISOString(), message: userMessage });

  return {
    cwd,
    ctx,
    inventory,
    authCalls,
    dispatched,
    /** Rewrite the pools on disk and run the extension's own reload path. */
    async reload(entries: readonly string[], extraModels: readonly Model<Api>[] = []): Promise<void> {
      for (const model of extraModels) {
        if (!inventory.some((entry) => entry.provider === model.provider && entry.id === model.id)) inventory.push(model);
      }
      writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({ ...config, models: { review: [...entries] } }));
      assert.ok(commandHandler, "the extension must register the bifrost command");
      await commandHandler("reload", ctx);
    },
    /** Hold one provider's resolution open, so a configuration change can land mid-wait. */
    holdAuth(provider: string) {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => { release = resolve; });
      authGate = { provider, promise, release };
      return {
        release: () => { authGate = undefined; release(); },
      };
    },
    markDead(...providers: string[]): void {
      for (const provider of providers) dead.add(provider);
    },
    async route(options: { reason?: string; previous?: { model: Model<Api>; thinkingLevel: "low" } } = {}): Promise<{ model: Model<Api> }> {
      const route = routeDefinition?.route as ((request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }>) | undefined;
      assert.ok(route, "the extension must register the Auto route");
      return route({
        model: ctx.model,
        reason: options.reason ?? "user",
        thinkingLevel: "low",
        messages: [userMessage],
        ...(options.previous === undefined ? {} : { previous: options.previous }),
      } as unknown as ModelRouteRequest, ctx);
    },
    /** Run `body` with the sign-in cache already past its TTL. */
    async withExpiredCache<T>(body: () => Promise<T>): Promise<T> {
      const real = Date.now;
      Date.now = () => real() + 120_000;
      try {
        return await body();
      } finally {
        Date.now = real;
      }
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

  it("checks a provider reached only by a bare pool entry", async () => {
    // Routing matches a bare entry against provider and model-id substrings, so
    // "dead" can select dead/one. Discovery for the check must use the same
    // rules or that provider escapes the exclusion entirely.
    const h = fixture({ eligibility: "exclude", pool: ["dead", "live"] });
    try {
      const result = await h.route();
      assert.equal(`${result.model.provider}/${result.model.id}`, "live/two");
      assert.ok(h.authCalls.includes("dead"), "the bare entry's provider must be resolved before dispatch");
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

  it("re-checks a provider the registry only just made selectable", async () => {
    // The cached answer named the providers it checked. A registry refresh that
    // makes the bare entry "two" reach another provider must not let the TTL
    // carry the old answer onto a provider nobody resolved.
    const h = fixture({ eligibility: "exclude", models: [makeModel("live", "two", 2)], pool: ["two"] });
    try {
      const first = await h.route();
      assert.equal(`${first.model.provider}/${first.model.id}`, "live/two");
      assert.deepEqual(h.authCalls, ["live"]);

      h.inventory.push(makeModel("dead", "two", 3));
      h.markDead("dead");

      const second = await h.route();
      assert.equal(`${second.model.provider}/${second.model.id}`, "live/two");
      assert.ok(h.authCalls.includes("dead"), "a provider the cached answer never checked must be resolved before dispatch");
    } finally {
      h.cleanup();
    }
  });

  it("re-checks providers added by a reload instead of reusing the previous answer", async () => {
    const h = fixture({ eligibility: "exclude" });
    try {
      const first = await h.route();
      assert.equal(`${first.model.provider}/${first.model.id}`, "live/two");

      await h.reload(["dead2/three", "dead/one", "live/two"], [makeModel("dead2", "three", 3)]);
      h.markDead("dead2");

      const second = await h.route();
      assert.equal(`${second.model.provider}/${second.model.id}`, "live/two");
      assert.ok(h.authCalls.includes("dead2"), "the reloaded pool's provider must be resolved before dispatch");
      assert.deepEqual(h.dispatched, []);
    } finally {
      h.cleanup();
    }
  });

  it("does not resolve sign-in for a continuation that keeps its model", async () => {
    // A continuation dispatches the previous model without touching the pools,
    // so exclusions cannot apply to it. Resolving every provider again after
    // the TTL expires would only make the user wait before a sticky dispatch.
    const h = fixture({ eligibility: "exclude" });
    try {
      const first = await h.route();
      assert.equal(`${first.model.provider}/${first.model.id}`, "live/two");
      const resolved = h.authCalls.length;

      const continued = await h.withExpiredCache(() =>
        h.route({ reason: "continuation", previous: { model: first.model, thinkingLevel: "low" } }));

      assert.equal(`${continued.model.provider}/${continued.model.id}`, "live/two");
      assert.equal(h.authCalls.length, resolved, "a continuation must not spend a sign-in resolution");
    } finally {
      h.cleanup();
    }
  });

  it("does not reuse an answer resolved under an earlier configuration", async () => {
    // The cached set answered a question about the pools as they were. A reload
    // that follows must not inherit that answer: here the provider was healthy
    // when the answer was produced and is dead by the time it would be reused.
    const h = fixture({ eligibility: "exclude", deadProviders: [] });
    try {
      const first = await h.route();
      assert.equal(`${first.model.provider}/${first.model.id}`, "dead/one");

      await h.reload(["dead/one", "live/two"]);
      h.markDead("dead");

      const next = await h.route();
      assert.equal(`${next.model.provider}/${next.model.id}`, "live/two");
      assert.equal(h.authCalls.filter((provider) => provider === "dead").length, 2, "the reload must force a fresh resolution");
    } finally {
      h.cleanup();
    }
  });

  it("drops a resolution that lands after the configuration changed", async () => {
    // The wait described the old pools. Caching it would let a provider that
    // went dead during the reload look resolvable for the rest of the TTL.
    const h = fixture({ eligibility: "exclude", deadProviders: [] });
    try {
      const held = h.holdAuth("dead");
      const pending = h.route();
      while (!h.authCalls.includes("dead")) await new Promise((resolve) => setImmediate(resolve));

      await h.reload(["dead/one", "live/two"]);
      held.release();
      await pending;
      h.markDead("dead");

      const next = await h.route();
      assert.equal(`${next.model.provider}/${next.model.id}`, "live/two");
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
