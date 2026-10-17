import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { createProviderCooldownStore } from "../runtime-reliability-v2.ts";
import { makeModel } from "./helpers.ts";

type Hook = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function startTrialHarness(freshAllowance = false) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-settlement-hook-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const modelKey = "fixture/trial";
  const now = Date.now();
  const openUntil = now - 1;
  const reliabilityPath = join(cwd, ".pi", "bifrost-reliability.json");
  if (!freshAllowance) writeFileSync(reliabilityPath, JSON.stringify({
    version: 1,
    models: { [modelKey]: { failures: [now - 1000], openUntil, cooldownMultiplier: 1 } },
  }));
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "restricted",
    strategy: "first",
    classifier: { enabled: false, backend: "prompt" },
    reliability: {
      enabled: true, failureThreshold: freshAllowance ? 3 : 1, windowMinutes: 5, cooldownMinutes: 1,
      ...(freshAllowance ? { allowanceCooldownScope: "model" } : {}),
    },
    models: { restricted: freshAllowance ? [modelKey, "fixture/alternative"] : [modelKey] },
    rules: [{ pattern: "hello", model: "restricted" }],
  }));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const active = makeModel("fixture", "active");
  const trial = makeModel("fixture", "trial");
  const alternative = makeModel("fixture", "alternative");
  const available: Model<Api>[] = [active, trial, alternative];
  const handlers = new Map<string, Hook>();
  let selected: string | undefined;
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    model: active,
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
      getProviderAuthStatus: () => ({ configured: false }),
      getAvailableOfType: async () => [],
      refresh: async () => ({ refreshed: [], errors: [] }),
    },
    sessionManager: { getBranch: () => [] },
    ui: {},
  } as unknown as ExtensionContext;
  const pi = {
    registerVirtualModel: () => {},
    registerCommand: () => {},
    on: (event: string, handler: Hook) => { handlers.set(event, handler); return () => {}; },
    setModel: async (model: Model<Api>) => { selected = `${model.provider}/${model.id}`; return true; },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);

  return {
    ctx,
    handlers,
    reliabilityPath,
    openUntil,
    selected: () => selected,
    run: async (messages: unknown[]) => {
      const input = handlers.get("input");
      const agentEnd = handlers.get("agent_end");
      const agentSettled = handlers.get("agent_settled");
      assert.ok(input && agentEnd && agentSettled);
      const result = await input({ text: "hello", source: "interactive", streamingBehavior: "steer" }, ctx);
      assert.deepEqual(result, { action: "continue" });
      agentEnd({ type: "agent_end", messages }, ctx);
      await agentSettled({ type: "agent_settled" }, ctx);
    },
    state: () => JSON.parse(readFileSync(reliabilityPath, "utf8")).models[modelKey] as {
      failures: number[];
      openUntil?: number;
      trialActive?: boolean;
      lastSuccessAt?: number;
      lastFailureReason?: string;
    },
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("reliability settlement through registered Pi hooks", () => {
  it("blocks legacy fallback when the active provider is paused after a selected model trial is contended", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-trial-contention-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const now = Date.now();
    const active = makeModel("provider-b", "active");
    const candidate = makeModel("provider-a", "trial");
    const reliabilityPath = join(cwd, ".pi", "bifrost-reliability.json");
    writeFileSync(reliabilityPath, JSON.stringify({
      version: 1,
      models: { "provider-a/trial": { failures: [now - 1000], openUntil: now - 1 } },
    }));
    writeFileSync(join(cwd, "bifrost.json"), JSON.stringify({
      enabled: true,
      default: "restricted",
      strategy: "first",
      classifier: { enabled: false, backend: "prompt" },
      reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 1, allowanceCooldownScope: "model" },
      models: { restricted: ["provider-a/trial"] },
      rules: [{ pattern: "hello", model: "restricted" }],
    }));
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const providerStore = createProviderCooldownStore(cwd, { cooldownMinutes: 1, allowanceCooldownScope: "model" });
    await providerStore.pauseRate("provider-b", now + 60_000, now);

    const inventory: Model<Api>[] = [active, candidate];
    const handlers = new Map<string, Hook>();
    let modelSwitches = 0;
    const createContext = (sessionId: string) => {
      const branch: unknown[] = [];
      return {
        cwd,
        mode: "rpc",
        hasUI: false,
        signal: new AbortController().signal,
        model: active,
        modelRegistry: {
          getAvailable: () => inventory,
          find: (provider: string, id: string) => inventory.find((model) => model.provider === provider && model.id === id),
          getProviderAuthStatus: () => ({ configured: false }),
          getAvailableOfType: async () => [],
          refresh: async () => ({ refreshed: [], errors: [] }),
        },
        sessionManager: { getHeader: () => ({ id: sessionId }), getBranch: () => branch },
        ui: {},
      } as unknown as ExtensionContext;
    };
    const firstContext = createContext("trial-contention-session-1");
    const secondContext = createContext("trial-contention-session-2");
    const pi = {
      registerVirtualModel: () => {},
      registerCommand: () => {},
      on: (event: string, handler: Hook) => { handlers.set(event, handler); return () => {}; },
      setModel: async (model: Model<Api>) => {
        modelSwitches += 1;
        (firstContext as { model: Model<Api> }).model = model;
        return true;
      },
    } as unknown as ExtensionAPI;
    bifrostExtension(pi);

    try {
      const input = handlers.get("input")!;
      const [firstResult, secondResult] = await Promise.all([
        input({ text: "hello", source: "interactive", streamingBehavior: "steer" }, firstContext),
        input({ text: "hello", source: "interactive", streamingBehavior: "steer" }, secondContext),
      ]);
      const actions = [firstResult, secondResult]
        .map((value) => (value as { action: string }).action)
        .sort();
      assert.deepEqual(actions, ["continue", "handled"],
        "one request owns the selected model trial; its contended sibling must not fall back onto a paused provider");
      assert.equal(modelSwitches, 1, "only the trial owner activates the selected model");
      assert.equal(providerStore.read("provider-b", false).openUntil, now + 60_000,
        "the active provider remains paused after the selected model's trial contention");
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not close a half-open trial for missing, canceled, or unknown assistant outcomes", async () => {
    const abandonedMessages = [
      [],
      [{ role: "assistant", provider: "fixture", model: "trial", stopReason: "aborted" }],
      [{ role: "assistant", provider: "fixture", model: "trial", stopReason: "future-value" }],
    ];
    for (const messages of abandonedMessages) {
      const harness = startTrialHarness();
      try {
        await harness.run(messages);
        assert.equal(harness.selected(), "fixture/trial");
        const record = harness.state();
        assert.equal(record.trialActive, false);
        assert.equal(record.failures.length, 1);
        assert.equal(record.openUntil, harness.openUntil);
        assert.equal(record.lastSuccessAt, undefined);
      } finally {
        harness.cleanup();
      }
    }
  });

  it("closes a half-open trial only for a known successful assistant stop reason", async () => {
    const harness = startTrialHarness();
    try {
      await harness.run([{ role: "assistant", provider: "fixture", model: "trial", stopReason: "toolUse" }]);
      const record = harness.state();
      assert.equal(record.trialActive, false);
      assert.deepEqual(record.failures, []);
      assert.equal(record.openUntil, undefined);
      assert.equal(typeof record.lastSuccessAt, "number");
    } finally {
      harness.cleanup();
    }
  });

  it("opens an immediate model-only circuit for a terminal billing denial", async () => {
    const harness = startTrialHarness(true);
    try {
      await harness.run([{
        role: "assistant", provider: "fixture", model: "trial", stopReason: "error",
        errorMessage: "HTTP 402 Payment Required",
      }]);
      const record = harness.state();
      assert.equal(record.failures.length, 1);
      assert.ok(record.openUntil && record.openUntil > Date.now());
      assert.match(record.lastFailureReason ?? "", /billing_denied/u);
    } finally {
      harness.cleanup();
    }
  });

  it("records a matching provider error as a failure", async () => {
    const harness = startTrialHarness();
    try {
      await harness.run([{ role: "assistant", provider: "fixture", model: "trial", stopReason: "error", errorMessage: "fixture error" }]);
      const record = harness.state();
      assert.equal(record.trialActive, false);
      assert.equal(record.failures.length, 2);
      assert.ok((record.openUntil ?? 0) > Date.now());
    } finally {
      harness.cleanup();
    }
  });

  it("cools a model immediately on explicit exhausted credits and routes the next physical turn around it", async () => {
    const harness = startTrialHarness(true);
    const errorMessage = 'Error: 402 "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get monthly included credits."';
    try {
      await harness.run([{ role: "assistant", provider: "fixture", model: "trial", stopReason: "error", errorMessage }]);
      const record = harness.state();
      assert.equal(record.failures.length, 1, "allowance exhaustion opens before the ordinary three-failure threshold");
      assert.ok((record.openUntil ?? 0) > Date.now());
      assert.equal(record.lastFailureReason, "allowance_exhausted:text_heuristic:model-only");

      const next = await harness.handlers.get("input")!({ text: "hello", source: "interactive", streamingBehavior: "steer" }, harness.ctx);
      assert.deepEqual(next, { action: "continue" });
      assert.equal(harness.selected(), "fixture/alternative");
    } finally {
      harness.cleanup();
    }
  });

  it("never persists provider error or prompt text in legacy reliability state", async () => {
    const harness = startTrialHarness();
    const privateText = "private prompt: secret-token-123 provider returned internal detail";
    const message = { role: "assistant", provider: "fixture", model: "trial", stopReason: "error", errorMessage: privateText };
    try {
      await harness.run([message]);
      const record = harness.state();
      assert.equal(record.lastFailureReason, "provider request failed");
      assert.doesNotMatch(JSON.stringify(record), /private prompt|secret-token-123|internal detail/u);
      assert.equal(message.errorMessage, privateText, "Pi's transcript keeps its original error text");
    } finally {
      harness.cleanup();
    }
  });

  it("does not treat an empty provider error string as successful settlement", async () => {
    const harness = startTrialHarness();
    try {
      await harness.run([{ role: "assistant", provider: "fixture", model: "trial", stopReason: "error", errorMessage: "" }]);
      const record = harness.state();
      assert.equal(record.trialActive, false);
      assert.equal(record.failures.length, 2);
      assert.ok((record.openUntil ?? 0) > Date.now());
      assert.equal(record.lastFailureReason, "provider request failed");
      assert.equal(existsSync(join(harness.ctx.cwd, ".pi", "bifrost-debug.jsonl")), false,
        "debug-disabled routing does not create a log file");
    } finally {
      harness.cleanup();
    }
  });
});
