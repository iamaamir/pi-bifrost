import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

const NOW = Date.now();

function reserveConfig(models: string[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "restricted",
    strategy: "first",
    classifier: { enabled: false, backend: "prompt" },
    models: { restricted: models },
    rules: [{ pattern: "work", model: "restricted" }],
    economics: {
      mode: "policy",
      scopes: { reserved: { kind: "model", model: "fixture/a" } },
      sources: [{ id: "manual", scopeRef: "reserved", authority: "declared" }],
      admission: [{ id: "daily", scopeRef: "reserved", windowId: "day", reserveRatio: 0.2, unknown: "ignore" }],
      observations: [{
        sourceId: "manual", scopeRef: "reserved", billing: "metered", observedAt: NOW - 1, expiresAt: NOW + 60_000, revision: 1,
        windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.1 }],
      }],
    },
  };
}

function makeHarness(models: string[], available: Model<Api>[], auto = false, configured = reserveConfig(models)) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-economic-runtime-"));
  const agentDir = join(cwd, "agent");
  const projectDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "bifrost.json"), JSON.stringify(configured));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const selected: string[] = [];
  const sessionManager = {
    getBranch: () => auto ? [{ type: "message", message: { role: "assistant", provider: "fixture", model: "a" } }] : [],
  };
  const modelRegistry = {
    getAvailable: () => available,
    find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
    refresh: async () => ({ refreshed: [], errors: [] }),
  };
  const ui = {
    setWidget: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {}, notify: () => {},
  };
  const active = auto
    ? { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" }
    : makeModel("fixture", "active");
  const ctx = { cwd, mode: "rpc", hasUI: false, model: active, modelRegistry, sessionManager, ui, thinkingLevel: "low" } as unknown as ExtensionContext;
  let input: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let virtual: VirtualModelDefinition | undefined;
  const pi = {
    registerVirtualModel: (definition: VirtualModelDefinition) => { virtual = definition; },
    registerCommand: (_name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { command = options.handler; },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { if (event === "input") input = handler; return () => {}; },
    setModel: async (model: Model<Api>) => { selected.push(`${model.provider}/${model.id}`); return true; },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);
  assert.ok(input);
  assert.ok(virtual?.route);
  return {
    ctx, input, command, route: virtual.route, selected,
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("economic reserve behavior through registered Pi hooks", () => {
  function invalidReserveConfig(models: string[]): Record<string, unknown> {
    const configured = reserveConfig(models);
    const economics = configured.economics as { sources: Array<Record<string, unknown>> };
    economics.sources[0].authority = "authoritative";
    return configured;
  }

  it("physically activates only a reserve-eligible model", async () => {
    const a = makeModel("fixture", "a");
    const b = makeModel("fixture", "b");
    const harness = makeHarness(["fixture/a", "fixture/b"], [a, b]);
    try {
      const result = await harness.input({ text: "work on this task", source: "interactive", streamingBehavior: "steer" }, harness.ctx);
      assert.deepEqual(result, { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/b"]);
    } finally { harness.cleanup(); }
  });

  it("handles a policy-exhausted physical route without activating the current model", async () => {
    const a = makeModel("fixture", "a");
    const harness = makeHarness(["fixture/a"], [a]);
    const output: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
    try {
      const result = await harness.input({ text: "work on this task", source: "interactive", streamingBehavior: "steer" }, harness.ctx);
      assert.deepEqual(result, { action: "handled" });
      assert.deepEqual(harness.selected, []);
      const message = output.join("\n");
      assert.match(message, /no eligible model available \(requested_tier_excluded\); reserve policy excluded 1 candidate\(s\) \(reasons: reserve_reached\)/);
      assert.doesNotMatch(message, /resolved 0 available models|provider credentials/);
    } finally {
      console.error = originalError;
      harness.cleanup();
    }
  });

  it("fails closed on an invalid reserve source at physical startup", async () => {
    const a = makeModel("fixture", "a");
    const harness = makeHarness(["fixture/a"], [a], false, invalidReserveConfig(["fixture/a"]));
    try {
      const result = await harness.input({ text: "work on this task", source: "interactive", streamingBehavior: "steer" }, harness.ctx);
      assert.deepEqual(result, { action: "handled" });
      assert.deepEqual(harness.selected, []);
    } finally { harness.cleanup(); }
  });

  it("fails closed on an invalid reserve source before Auto can return its previous model", async () => {
    const a = makeModel("fixture", "a");
    const harness = makeHarness(["fixture/a"], [a], true, invalidReserveConfig(["fixture/a"]));
    try {
      const route = harness.route as unknown as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<unknown>;
      const request = {
        model: harness.ctx.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "work on this task" }] }],
      } as unknown as ModelRouteRequest;
      await assert.rejects(route(request, harness.ctx), /invalid routing policy config/i);
      assert.deepEqual(harness.selected, []);
    } finally { harness.cleanup(); }
  });

  it("does not let Auto degrade to a previously dispatched reserve-excluded model", async () => {
    const a = makeModel("fixture", "a");
    const harness = makeHarness(["fixture/a"], [a], true);
    try {
      const route = harness.route as unknown as (request: ModelRouteRequest, ctx: ExtensionContext) => Promise<unknown>;
      const request = {
        model: harness.ctx.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "work on this task" }] }],
      } as unknown as ModelRouteRequest;
      let error = "";
      try { await route(request, harness.ctx); } catch (caught) { error = String(caught); }
      assert.match(error, /no eligible physical model.*reserve policy excluded 1 configured candidate\(s\) \(reasons: reserve_reached\)/);
      assert.doesNotMatch(error, /resolved 0 available models|credentials|0\.1|work on this task/);
      assert.deepEqual(harness.selected, []);
    } finally { harness.cleanup(); }
  });

  it("keeps the last good observation when reload proposes an older period", async () => {
    const a = makeModel("fixture", "a");
    const harness = makeHarness(["fixture/a"], [a]);
    try {
      const event = { text: "work on this task", source: "interactive", streamingBehavior: "steer" };
      assert.deepEqual(await harness.input(event, harness.ctx), { action: "handled" });
      const stale = reserveConfig(["fixture/a"]);
      const economics = stale.economics as { observations: Array<Record<string, unknown> & { windows: Array<Record<string, unknown> & { period: { id: string; sequence: number } }> }> };
      economics.observations = [{
        ...economics.observations[0],
        observedAt: NOW,
        expiresAt: NOW + 60_000,
        revision: 2,
        windows: [{ id: "day", period: { id: "older", sequence: 0 }, unit: "ratio", remaining: 0.9 }],
      }];
      writeFileSync(join(harness.ctx.cwd as string, ".pi", "bifrost.json"), JSON.stringify(stale));
      await harness.command?.("reload", harness.ctx);
      assert.deepEqual(await harness.input(event, harness.ctx), { action: "handled" });
      assert.deepEqual(harness.selected, []);
    } finally { harness.cleanup(); }
  });

  it("keeps inactive economic facts private but available across remove and re-enable reloads", async () => {
    const a = makeModel("fixture", "a");
    const harness = makeHarness(["fixture/a"], [a]);
    const event = { text: "work on this task", source: "interactive", streamingBehavior: "steer" };
    const configPath = join(harness.ctx.cwd as string, ".pi", "bifrost.json");
    try {
      assert.deepEqual(await harness.input(event, harness.ctx), { action: "handled" });
      assert.deepEqual(harness.selected, [], "fresh reserve fact initially rejects the candidate");

      const samePolicyWithoutStaticRefresh = reserveConfig(["fixture/a"]);
      const economics = samePolicyWithoutStaticRefresh.economics as { observations: unknown[] };
      economics.observations = [];
      writeFileSync(configPath, JSON.stringify(samePolicyWithoutStaticRefresh));
      await harness.command?.("reload", harness.ctx);

      const disabled = reserveConfig(["fixture/a"]);
      delete disabled.economics;
      writeFileSync(configPath, JSON.stringify(disabled));
      await harness.command?.("reload", harness.ctx);
      assert.deepEqual(await harness.input(event, harness.ctx), { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/a"], "removed economics is inactive during routing");

      writeFileSync(configPath, JSON.stringify(samePolicyWithoutStaticRefresh));
      await harness.command?.("reload", harness.ctx);
      assert.deepEqual(await harness.input(event, harness.ctx), { action: "handled" });
      assert.deepEqual(harness.selected, ["fixture/a"], "re-enabled policy reuses the still-fresh fact rather than treating it as unknown");
    } finally { harness.cleanup(); }
  });
});
