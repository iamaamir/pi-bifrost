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
  /** Configured regex rules (direct-model or tier). */
  readonly rules?: readonly { readonly pattern: string; readonly model: string }[];
  /** Simulate a host whose registry cannot resolve sign-in at all. */
  readonly withoutAuthResolver?: boolean;
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
  const refreshHooks: Array<() => void> = [];
  let authGate: { provider: string; promise: Promise<void>; release: () => void } | undefined;
  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "review",
    strategy: "first",        ...(options.eligibility === undefined ? {} : { signInEligibility: options.eligibility }),
    models: { review: [...(options.pool ?? inventory.map((model) => `${model.provider}/${model.id}`))] },
    rules: [...(options.rules ?? [])],
    ...(options.fallbackTiers === undefined
      ? {}
      : { tierPolicies: { review: { fallbackTiers: [...options.fallbackTiers] } } }),
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
      ...(options.withoutAuthResolver ? {} : {
        getProviderAuth: async (provider: string) => {
          authCalls.push(provider);
          if (authGate?.provider === provider) await authGate.promise;
          if (dead.has(provider)) throw new Error("token refresh failed");
          return { auth: { apiKey: "resolved" } };
        },
      }),
      // A refresh is the moment the registry learns about models it did not
      // report before, so it can make a configured provider selectable.
      refresh: async () => {
        for (const hook of refreshHooks.splice(0)) hook();
        return { refreshed: [], errors: new Map() };
      },
    },
    sessionManager,
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
  } as unknown as ExtensionContext;

  const pi = {
    registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
    registerTool: () => {},
    registerCommand: (_name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }) => {
      commandHandler = definition.handler as (args: string, ctx: ExtensionContext) => Promise<unknown>;
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
    /** Apply the next registry refresh to this fixture, as a real refresh would. */
    onRefresh(hook: () => void): void {
      refreshHooks.push(hook);
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
    /** Run one `/bifrost <line>` command the way the command router would. */
    async command(line: string): Promise<unknown> {
      assert.ok(commandHandler, "the extension must register the bifrost command");
      return commandHandler(line, ctx);
    },
    /** Run the inline `/bifrost preview` command and capture its rendered lines. */
    async preview(): Promise<string> {
      assert.ok(commandHandler, "the extension must register the bifrost command");
      const lines: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
      try {
        await commandHandler("preview review the change", ctx);
      } finally {
        console.error = realError;
      }
      return lines.join("\n");
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

  it("checks a provider reached only by a direct-model rule", async () => {
    // A regex rule pointing at `provider/id` bypasses the tier pools, so the
    // sign-in check must enumerate it separately; otherwise that provider is
    // never resolved and can be dispatched unchecked.
    const h = fixture({
      eligibility: "exclude",
      pool: ["live/two"],
      rules: [{ pattern: "review", model: "dead/one" }],
    });
    try {
      try { await h.route(); } catch { /* excluded direct model yields no route */ }
      assert.ok(h.authCalls.includes("dead"), "the direct rule's provider must be resolved before dispatch");
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

  it("stops reporting an exclusion once the cached answer expires", async () => {
    // Preview may only repeat an answer that is still current. After the TTL the
    // next Auto turn checks again, so a stale exclusion would contradict it and
    // hide that the provider was never re-checked.
    const h = fixture({ eligibility: "exclude" });
    try {
      await h.route();
      const fresh = await h.preview();
      assert.match(fresh, /provider sign-in unavailable/);

      const expired = await h.withExpiredCache(() => h.preview());
      assert.doesNotMatch(expired, /provider sign-in unavailable/);
      assert.match(expired, /not been resolved in this session/);
    } finally {
      h.cleanup();
    }
  });

  it("checks a provider the empty-pool refresh makes selectable", async () => {
    // A bare pool entry can match nothing until the registry refresh lands. The
    // answer cached before that refresh covered no provider, so dispatching the
    // newly visible one without a check would send the doomed request anyway.
    const h = fixture({ eligibility: "exclude", models: [], pool: ["two"] });
    try {
      h.onRefresh(() => h.inventory.push(makeModel("dead", "two", 1), makeModel("live", "two", 2)));
      h.markDead("dead");

      const result = await h.route();
      assert.equal(`${result.model.provider}/${result.model.id}`, "live/two");
      assert.ok(h.authCalls.includes("dead"), "a provider the refresh made selectable must be resolved before dispatch");
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
    // went dead during the reload look resolvable for the rest of the TTL, and
    // abandoning it would send this turn to the reloaded pool unchecked, so the
    // turn re-checks the configuration it is actually going to select from.
    const h = fixture({ eligibility: "exclude", deadProviders: [] });
    try {
      const held = h.holdAuth("dead");
      const pending = h.route();
      while (!h.authCalls.includes("dead")) await new Promise((resolve) => setImmediate(resolve));

      await h.reload(["dead/one", "live/two"]);
      h.markDead("dead");
      held.release();

      const inFlight = await pending;
      assert.equal(`${inFlight.model.provider}/${inFlight.model.id}`, "live/two");
      assert.equal(h.authCalls.filter((provider) => provider === "dead").length, 2,
        "the reload must force a fresh resolution inside the same turn");
      assert.ok(!h.dispatched.includes("dead/one"), "the reloaded pool's dead provider must not dispatch");
    } finally {
      h.cleanup();
    }
  });

  it("resolves nothing for a pinned session and leaves the model alone", async () => {
    // Pin means the user chose the model. Swapping it would be the one thing the
    // manual control exists to prevent, so preparation never even starts.
    const h = fixture({ eligibility: "exclude" });
    try {
      await h.command("pin");
      // Pinning itself selects the physical model; the routed turn must add no
      // dispatch and spend no resolution, because there is nothing to swap.
      const dispatchedAtPin = h.dispatched.length;
      await assert.rejects(h.route(), /virtual auto is disabled or pinned/);
      assert.deepEqual(h.authCalls, [], "a pinned session must not spend a sign-in resolution");
      assert.equal(h.dispatched.length, dispatchedAtPin);
    } finally {
      h.cleanup();
    }
  });

  it("keeps a provider eligible when the host cannot resolve sign-in at all", async () => {
    // `unknown` is not proof of a dead credential. A registry with no resolver
    // must leave the configured order intact instead of excluding everything.
    const h = fixture({ eligibility: "exclude", withoutAuthResolver: true });
    try {
      const result = await h.route();
      assert.equal(`${result.model.provider}/${result.model.id}`, "dead/one");
      assert.deepEqual(h.authCalls, []);
    } finally {
      h.cleanup();
    }
  });

  it("does not revive an excluded model as the last-model fallback", async () => {
    // The keep-last path exists to reuse a model that was working. One the
    // exclusion ruled out is not that, so the fallback may not spend the request
    // the exclusion was meant to prevent.
    const h = fixture({ eligibility: "exclude" });
    try {
      const previous = h.inventory.find((model) => model.provider === "dead")!;
      const result = await h.route({ previous: { model: previous, thinkingLevel: "low" } });
      assert.equal(`${result.model.provider}/${result.model.id}`, "live/two");
      assert.ok(!h.dispatched.includes("dead/one"), "the excluded model must not be revived");
    } finally {
      h.cleanup();
    }
  });

  it("names sign-in when preview explains why a tier is empty", async () => {
    // The preview reads the settled answer from the cache, so the turn above has
    // to have produced one. What matters is that the exclusion is attributed to
    // sign-in rather than to the reliability store.
    const h = fixture({ eligibility: "exclude", models: [makeModel("dead", "only", 1)] });
    try {
      await assert.rejects(h.route());
      const preview = await h.preview();
      assert.match(preview, /provider sign-in unavailable/);
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
