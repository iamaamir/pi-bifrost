import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { ProviderCooldownStore } from "../provider-cooldowns.ts";
import { ReliabilityV2Store } from "../reliability-v2-store.ts";
import { createProviderCooldownStore, providerReliabilityPath, reliabilityV2Config } from "../runtime-reliability-v2.ts";
import { modelScopeKey } from "../reliability-v2.ts";
import { providerScopeModelKey } from "../provider-cooldowns.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

type Hook = (event: any, ctx: ExtensionContext) => Promise<unknown>;

const reliability = {
  enabled: true,
  cooldownMinutes: 1,
  allowanceCooldownScope: "provider",
  retryOnAllowanceExhausted: false,
} as const;

function fixture(options: {
  models?: Model<Api>[];
  defaultTier?: string;
  stateVersion2?: boolean;
  activeModel?: Model<Api>;
  setModelResult?: boolean;
  setModelWithoutChangingContext?: boolean;
  appendModelChangeOnSetModel?: boolean;
  appendThinkingChangeOnSetModel?: boolean;
  classifierEnabled?: boolean;
  classifierModel?: Model<Api>;
  streamSimple?: (model: Model<Api>, request: unknown, options: any) => unknown;
  refresh?: () => Promise<unknown>;
} = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-provider-runtime-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const configuredReliability = options.stateVersion2
    ? { ...reliability, stateVersion: 2 as const }
    : reliability;
  const config = {
    ...(options.stateVersion2 ? { schemaVersion: 2 } : {}),
    enabled: true,
    ...(options.defaultTier === undefined ? {} : { default: options.defaultTier }),
    strategy: "first",
    classifier: {
      enabled: options.classifierEnabled ?? false,
      ...(options.classifierModel ? { backend: "prompt", model: `${options.classifierModel.provider}/${options.classifierModel.id}` } : {}),
    },
    models: { quick: (options.models ?? [makeModel("provider-a", "model-a")]).map((model) => `${model.provider}/${model.id}`) },
    rules: [],
    reliability: configuredReliability,
  };
  writeFileSync(join(cwd, "bifrost.json"), JSON.stringify(config));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const inventory = [...(options.models ?? [makeModel("provider-a", "model-a")]), ...(options.classifierModel ? [options.classifierModel] : [])];
  const handlers = new Map<string, Hook>();
  const notices: string[] = [];
  let routeDefinition: VirtualModelDefinition | undefined;
  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let primary: ReturnType<typeof createContext>;
  function createContext(sessionId: string, activeModel: Model<Api>) {
    const branch: any[] = [];
    const sessionManager = { getHeader: () => ({ id: sessionId }), getBranch: () => branch };
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: false,
      signal: new AbortController().signal,
      model: activeModel,
      modelRegistry: {
        getAvailable: () => inventory,
        getAll: () => inventory,
        find: (provider: string, id: string) => inventory.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        refresh: options.refresh ?? (async () => ({ refreshed: [], errors: new Map() })),
        ...(options.streamSimple ? { streamSimple: options.streamSimple } : {}),
      },
      sessionManager,
      ui: { notify: (message: string) => notices.push(message), setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {} },
    } as unknown as ExtensionContext;
    return { ctx, branch, sessionManager };
  }
  primary = createContext("provider-runtime-session-1", options.activeModel ?? inventory[0]!);
  if (options.stateVersion2) {
    (primary.ctx as { model: Model<Api> }).model = { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" } as Model<Api>;
  }
  const pi = {
    registerVirtualModel: (definition: VirtualModelDefinition) => { routeDefinition = definition; },
    registerCommand: (_name: string, opts: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commandHandler = opts.handler; },
    on: (event: string, handler: Hook) => { handlers.set(event, handler); return () => {}; },
    setModel: async (model: Model<Api>) => {
      if (options.setModelResult === false) return false;
      if (!options.setModelWithoutChangingContext) {
        (primary.ctx as { model: Model<Api> }).model = model;
        if (options.appendModelChangeOnSetModel) {
          const branch = primary.branch;
          const entry = {
            type: "model_change",
            id: `set-model-${branch.length}`,
            ...(branch.at(-1)?.id === undefined ? {} : { parentId: branch.at(-1)!.id }),
            provider: model.provider,
            modelId: model.id,
          };
          branch.push(entry);
          if (options.appendThinkingChangeOnSetModel) {
            (primary.ctx as { thinkingLevel: string }).thinkingLevel = "low";
            branch.push({
              type: "thinking_level_change",
              id: `set-thinking-${branch.length}`,
              parentId: entry.id,
              thinkingLevel: "low",
            });
          }
          await handlers.get("model_select")?.({ model, source: "set" }, primary.ctx);
        }
      }
      return true;
    },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);

  return {
    cwd,
    handlers,
    notices,
    primary,
    createContext,
    routeDefinition: () => routeDefinition,
    commandHandler: () => commandHandler,
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function initializeV2(h: ReturnType<typeof fixture>): Promise<void> {
  const handler = h.commandHandler();
  assert.ok(handler, "the extension must register the Bifrost command");
  await handler("reliability migrate --fresh", h.primary.ctx);
}

async function routeAuto(
  h: ReturnType<typeof fixture>,
  ctx: ReturnType<typeof fixture>["primary"],
  message: object,
  reason: "user" | "continuation" = "user",
) {
  const route = h.routeDefinition()?.route as ((request: ModelRouteRequest, ctx: ExtensionContext) => Promise<{ model: Model<Api> }> ) | undefined;
  assert.ok(route, "the extension must register the Auto route");
  return route({ model: ctx.ctx.model, reason, thinkingLevel: "low", messages: [message] } as unknown as ModelRouteRequest, ctx.ctx);
}

function addUser(ctx: ReturnType<typeof fixture>["primary"], id: string, text: string) {
  const message = { role: "user", content: [{ type: "text", text }] };
  const entry = { type: "message", id, parentId: "root", timestamp: new Date().toISOString(), message };
  ctx.branch.push(entry);
  return { entry, message };
}

async function input(h: ReturnType<typeof fixture>, ctx: ReturnType<typeof fixture>["primary"], id: string, text: string) {
  addUser(ctx, id, text);
  return h.handlers.get("input")!({ text, source: "interactive", streamingBehavior: "steer" }, ctx.ctx);
}

async function turnEnd(
  h: ReturnType<typeof fixture>,
  ctx: ReturnType<typeof fixture>["primary"],
  userEntryId: string,
  model: Model<Api>,
  stopReason: "stop" | "error",
  errorMessage?: string,
) {
  const userEntry = ctx.branch.find((entry) => entry.type === "message" && entry.id === userEntryId);
  const message = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: Date.now(),
  };
  const messageEntryId = `${userEntryId}-assistant`;
  ctx.branch.push({ type: "message", id: messageEntryId, parentId: userEntry.id, timestamp: new Date().toISOString(), message });
  await h.handlers.get("turn_end")!({ messageEntryId, message, toolResults: [], toolResultEntryIds: [] }, ctx.ctx);
}

async function seedExpiredUsagePause(cwd: string, provider: string): Promise<void> {
  const seedTime = Date.now() - 120_000;
  const store = new ReliabilityV2Store({
    path: providerReliabilityPath(cwd),
    config: reliabilityV2Config(reliability),
    now: () => seedTime,
  });
  await new ProviderCooldownStore(store, 60_000).pauseUsage(provider, seedTime);
}

function scopeFromSidecar(cwd: string, kind: "usage" | "rate" | "trial", provider: string): any {
  const sidecar = JSON.parse(readFileSync(providerReliabilityPath(cwd), "utf8"));
  return sidecar.scopes[modelScopeKey(providerScopeModelKey(kind, provider))];
}

describe("provider cooldowns through registered Pi runtime hooks", { concurrency: false }, () => {
  it("routes the next physical prompt to another provider after a terminal usage failure", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    const h = fixture({ models: [modelA, modelB], defaultTier: "quick" });
    try {
      const first = await input(h, h.primary, "usage-user", "quick first request");
      assert.equal(first && (first as { action: string }).action, "transform");
      await turnEnd(h, h.primary, "usage-user", modelA, "error", "The usage limit has been reached.");
      const usage = scopeFromSidecar(h.cwd, "usage", "provider-a");
      assert.ok(usage?.openUntil > Date.now(), "turn_end must persist a provider-scoped usage pause");

      await input(h, h.primary, "next-user", "quick next request");
      assert.equal((h.primary.ctx.model as Model<Api>).provider, "provider-b");
      assert.equal((h.primary.ctx.model as Model<Api>).id, "model-b");
    } finally { h.cleanup(); }
  });

  it("pauses a classifier provider only for an explicit subscription 403", async () => {
    const models = [
      makeModel("provider-a", "go"),
      makeModel("provider-a", "sibling"),
      makeModel("provider-b", "quick"),
    ];
    const classifierModel = makeModel("provider-a", "classifier");
    const h = fixture({
      models,
      defaultTier: "quick",
      classifierEnabled: true,
      classifierModel,
      streamSimple: (_model, _request, options) => {
        options.onResponse({ status: 403, headers: {} });
        return {
          result: async () => ({
            content: [],
            stopReason: "error",
            errorMessage: "Upstream request failed: An active OpenCode Go subscription is required to use Go",
          }),
        };
      },
    });
    try {
      const result = await input(h, h.primary, "classifier-subscription-user", "summarize this code");
      assert.equal((result as { action: string }).action, "continue");
      assert.equal((h.primary.ctx.model as Model<Api>).provider, "provider-b",
        "the terminal classifier denial must pause provider A before model selection");
      assert.ok(scopeFromSidecar(h.cwd, "usage", "provider-a")?.openUntil > Date.now(),
        "the configured provider ID must receive the usage pause");
    } finally { h.cleanup(); }
  });

  it("claims an expired pinned-provider pause, blocks a second session, and drains the original claim on shutdown", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA], defaultTier: "quick" });
    try {
      await seedExpiredUsagePause(h.cwd, "provider-a");
      await h.handlers.get("model_select")!({ model: modelA, source: "set" }, h.primary.ctx);
      const first = await input(h, h.primary, "pinned-user", "do this pinned request");
      assert.equal((first as { action: string }).action, "continue");
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "pinned input should claim the expired provider pause before continuing");

      const second = h.createContext("provider-runtime-session-2", modelA);
      const blocked = await input(h, second, "second-user", "do another pinned request");
      assert.equal((blocked as { action: string }).action, "handled");
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "a second session must leave the first session's persisted provider lease active");

      await h.handlers.get("session_shutdown")!({}, h.primary.ctx);
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined,
        "shutdown must release the trial through the store that owns the claim");
      const allowedAfterDrain = await input(h, second, "second-user-after-drain", "do the pinned request again");
      assert.equal((allowedAfterDrain as { action: string }).action, "continue");
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease);
    } finally { h.cleanup(); }
  });

  it("releases a cancelled physical half-open claim at agent_settled so another session can claim it", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA], defaultTier: "quick" });
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const fakeTimer = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    let heartbeat: (() => void) | undefined;
    let heartbeatStopped = false;
    globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0]) => {
      heartbeat = () => (callback as () => void)();
      return fakeTimer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer?: ReturnType<typeof setInterval>) => {
      if (timer === fakeTimer) heartbeatStopped = true;
    }) as typeof clearInterval;
    try {
      await seedExpiredUsagePause(h.cwd, "provider-a");
      await h.handlers.get("model_select")!({ model: modelA, source: "set" }, h.primary.ctx);
      const first = await input(h, h.primary, "cancelled-user", "pinned request before cancellation");
      assert.equal((first as { action: string }).action, "continue");
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "the physical request should own the expired pause trial before cancellation");
      assert.ok(heartbeat, "an active provider trial must have a renewal heartbeat");

      await h.handlers.get("agent_settled")!({}, h.primary.ctx);
      assert.equal(heartbeatStopped, true, "agent_settled must stop the trial renewal heartbeat");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined,
        "agent_settled without turn_end must release the cancelled trial");
      heartbeat?.();
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined,
        "a late heartbeat callback must not renew a released claim");

      const second = h.createContext("provider-runtime-session-after-cancel", modelA);
      const retried = await input(h, second, "after-cancel-user", "pinned request from another session");
      assert.equal((retried as { action: string }).action, "continue");
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "the next session should acquire the released half-open provider claim");
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      h.cleanup();
    }
  });

  it("releases a provider lease acquired after its physical request lifecycle became stale", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA], defaultTier: "quick" });
    const originalClaim = ReliabilityV2Store.prototype.claimScopeTrial;
    let claimStored!: () => void;
    let allowClaimReturn!: () => void;
    const stored = new Promise<void>((resolve) => { claimStored = resolve; });
    const gate = new Promise<void>((resolve) => { allowClaimReturn = resolve; });
    ReliabilityV2Store.prototype.claimScopeTrial = async function (...args) {
      const result = await originalClaim.apply(this, args);
      claimStored();
      await gate;
      return result;
    };
    try {
      await seedExpiredUsagePause(h.cwd, "provider-a");
      const pendingInput = input(h, h.primary, "stale-claim-user", "quick delayed admission");
      await stored;
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "the half-open trial is persisted while admission is paused before return");
      await h.handlers.get("session_before_tree")!({}, h.primary.ctx);
      allowClaimReturn();
      const result = await pendingInput;
      assert.equal((result as { action: string }).action, "handled",
        "a stale physical request must not dispatch after the claim returns");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined,
        "the post-await lifecycle fence must release the claim it just acquired");
    } finally {
      allowClaimReturn();
      ReliabilityV2Store.prototype.claimScopeTrial = originalClaim;
      h.cleanup();
    }
  });

  it("holds an already-active physical recovery claim until turn_end settles it", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA], defaultTier: "quick" });
    try {
      await seedExpiredUsagePause(h.cwd, "provider-a");
      await input(h, h.primary, "active-user", "quick same active model");
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "input selecting the already-active model must retain its half-open claim");

      await turnEnd(h, h.primary, "active-user", modelA, "stop");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined);
      assert.equal(scopeFromSidecar(h.cwd, "usage", "provider-a")?.openUntil, undefined,
        "successful generation must settle and clear the recovered usage pause");
    } finally { h.cleanup(); }
  });

  it("keeps provider admission after Pi records Bifrost's own model and thinking changes", async () => {
    for (const appendThinkingChangeOnSetModel of [false, true]) {
      const modelA = makeModel("provider-a", "model-a");
      const priorModel = makeModel("provider-prior", "prior-model");
      const h = fixture({
        models: [modelA],
        defaultTier: "quick",
        activeModel: priorModel,
        appendModelChangeOnSetModel: true,
        appendThinkingChangeOnSetModel,
      });
      try {
        await seedExpiredUsagePause(h.cwd, "provider-a");
        const result = await input(h, h.primary, `self-model-change-${appendThinkingChangeOnSetModel}`, "quick switch model");
        assert.ok(["continue", "transform"].includes((result as { action: string }).action),
          "Pi's exact model_change and optional thinking_level_change from Bifrost setModel should not stale the turn");
        assert.ok(h.primary.branch.some((entry) => entry.type === "model_change"),
          "the fixture mirrors Pi appending model_change before model_select");
        assert.equal(h.primary.branch.at(-1)?.type, appendThinkingChangeOnSetModel
          ? "thinking_level_change" : "model_change");
        assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
          "provider admission must retain the half-open lease for the activated model");
      } finally { h.cleanup(); }
    }
  });

  it("blocks an unclassified physical prompt when its active provider is paused", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA] });
    try {
      const cooldown = createProviderCooldownStore(h.cwd, reliability);
      await cooldown.pauseRate("provider-a", Date.now() + 60_000);
      const result = await input(h, h.primary, "unclassified-user", "text with no matching tier");
      assert.equal((result as { action: string }).action, "handled");
      assert.equal((h.primary.ctx.model as Model<Api>).id, "model-a");
    } finally { h.cleanup(); }
  });

  it("blocks a selected candidate with a contended trial when the active fallback provider is paused", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    const h = fixture({ models: [modelA, modelB], defaultTier: "quick", activeModel: modelB });
    try {
      const store = createProviderCooldownStore(h.cwd, reliability);
      await seedExpiredUsagePause(h.cwd, "provider-a");
      const existingClaim = await store.claimTrial("provider-a");
      assert.equal(existingClaim.allowed, true);
      assert.ok(existingClaim.claim);
      await store.pauseRate("provider-b", Date.now() + 60_000);
      const result = await input(h, h.primary, "contended-route-user", "quick request with no healthy provider");
      assert.equal((result as { action: string }).action, "handled");
      assert.equal((h.primary.ctx.model as Model<Api>).provider, "provider-b");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease?.dispatchId, existingClaim.claim.dispatchId,
        "the rejected input must not steal or replace provider A's existing trial");
    } finally { h.cleanup(); }
  });

  it("handles a failed setModel when the still-active provider is paused", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    const h = fixture({ models: [modelA, modelB], defaultTier: "quick", activeModel: modelB, setModelResult: false });
    try {
      await createProviderCooldownStore(h.cwd, reliability).pauseRate("provider-b", Date.now() + 60_000);
      const result = await input(h, h.primary, "failed-switch-user", "quick request should try provider A");
      assert.equal((result as { action: string }).action, "handled",
        "a setModel failure must not continue the prompt on a paused active provider");
      assert.equal((h.primary.ctx.model as Model<Api>).provider, "provider-b");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined,
        "failed switching must release any provider A recovery claim before blocking");
    } finally { h.cleanup(); }
  });

  it("rejects stale input when a paused provider is manually pinned during registry refresh", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    let signalRefreshStarted!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { signalRefreshStarted = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const h = fixture({
      models: [modelA, modelB],
      defaultTier: "quick",
      classifierEnabled: true,
      refresh: async () => {
        signalRefreshStarted();
        await refreshGate;
        return { refreshed: [], errors: new Map() };
      },
    });
    try {
      await createProviderCooldownStore(h.cwd, reliability).pauseRate("provider-b", Date.now() + 60_000);
      const pendingInput = input(h, h.primary, "pin-during-refresh-user", "quick request during registry refresh");
      await refreshStarted;
      (h.primary.ctx as { model: Model<Api> }).model = modelB;
      await h.handlers.get("model_select")!({ model: modelB, source: "set" }, h.primary.ctx);
      releaseRefresh();
      const result = await pendingInput;
      assert.equal((result as { action: string }).action, "handled",
        "the stale route must stop after a manual pin to a paused provider");
      assert.equal((h.primary.ctx.model as Model<Api>).provider, "provider-b");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-b")?.lease, undefined,
        "the stale input must not create a dispatch or recovery-trial lease");
    } finally {
      releaseRefresh();
      h.cleanup();
    }
  });

  it("preserves a new provider claim when a stale input finishes releasing its unused claim", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    const h = fixture({
      // Keep A as the sole configured route so the stale input must acquire A's
      // half-open lease even if an earlier test left ambient route preferences.
      // B is still the actual active host model for the later unclassified turn.
      models: [modelA],
      defaultTier: "quick",
      activeModel: modelB,
      setModelWithoutChangingContext: true,
    });
    const originalRelease = ProviderCooldownStore.prototype.releaseTrial;
    let signalReleaseStarted!: () => void;
    let resumeRelease!: () => void;
    const releaseStarted = new Promise<void>((resolve) => { signalReleaseStarted = resolve; });
    const releaseGate = new Promise<void>((resolve) => { resumeRelease = resolve; });
    let delayFirstRelease = true;
    ProviderCooldownStore.prototype.releaseTrial = async function (claim) {
      if (delayFirstRelease) {
        delayFirstRelease = false;
        signalReleaseStarted();
        await releaseGate;
      }
      return originalRelease.call(this, claim);
    };
    try {
      await seedExpiredUsagePause(h.cwd, "provider-a");
      await seedExpiredUsagePause(h.cwd, "provider-b");
      const staleInput = input(h, h.primary, "stale-unused-claim-user", "quick route to provider A");
      await releaseStarted;
      assert.ok(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease,
        "the selected provider A claim should be held while the wrapper releases it as unused");

      await h.handlers.get("session_before_tree")!({}, h.primary.ctx);
      h.primary.branch.splice(0, h.primary.branch.length);
      const next = await input(h, h.primary, "new-provider-b-user", "unclassified request on provider B");
      assert.equal((next as { action: string }).action, "continue");
      const newerClaim = scopeFromSidecar(h.cwd, "trial", "provider-b")?.lease;
      assert.ok(newerClaim, "the new lifecycle should own provider B's expired-pause trial");

      resumeRelease();
      const rejected = await staleInput;
      assert.equal((rejected as { action: string }).action, "handled",
        "the stale pre-tree input must not continue after its unused claim release finishes");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-a")?.lease, undefined,
        "the exact old provider A claim must be released");
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-b")?.lease?.dispatchId, newerClaim?.dispatchId,
        "finishing cleanup of provider A must preserve the newer provider B claim");

      await h.handlers.get("session_shutdown")!({}, h.primary.ctx);
      assert.equal(scopeFromSidecar(h.cwd, "trial", "provider-b")?.lease, undefined,
        "the newer provider B claim must remain registered for normal shutdown cleanup");
    } finally {
      resumeRelease();
      ProviderCooldownStore.prototype.releaseTrial = originalRelease;
      h.cleanup();
    }
  });

  it("blocks later sibling routing after provider cooldown persistence fails", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    const h = fixture({ models: [modelA, modelB], defaultTier: "quick" });
    try {
      await input(h, h.primary, "write-failure-user", "first request");
      const sidecarPath = providerReliabilityPath(h.cwd);
      assert.equal(existsSync(sidecarPath), false, "healthy provider admission should be read-only");
      mkdirSync(sidecarPath);
      await turnEnd(h, h.primary, "write-failure-user", modelA, "error", "HTTP 429 Too Many Requests");

      const before = (h.primary.ctx.model as Model<Api>).provider;
      const blocked = await input(h, h.primary, "write-failure-next", "next request");
      assert.equal((blocked as { action: string }).action, "handled");
      assert.equal((h.primary.ctx.model as Model<Api>).provider, before,
        "an unconfirmed pause write must stop later routing instead of choosing a sibling");
    } finally { h.cleanup(); }
  });

  it("persists generic HTTP 429 provider rate pauses with V2 observations disabled", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA], defaultTier: "quick", stateVersion2: true });
    try {
      await initializeV2(h);
      const { message } = addUser(h.primary, "v2-rate-user", "route a normal request");
      const routed = await routeAuto(h, h.primary, message);
      assert.equal(routed.model.provider, "provider-a");
      await turnEnd(h, h.primary, "v2-rate-user", modelA, "error", "HTTP 429 Too Many Requests");
      const rate = scopeFromSidecar(h.cwd, "rate", "provider-a");
      assert.ok(rate?.openUntil > Date.now(), "V2 turn_end must persist generic HTTP 429 as provider rate pause");

      const config = JSON.parse(readFileSync(join(h.cwd, "bifrost.json"), "utf8"));
      assert.notEqual(config.reliability.observations?.enabled, true,
        "rate-limit enforcement must work with optional observations disabled by default");
    } finally { h.cleanup(); }
  });

  it("blocks an Auto continuation when an external provider pause arrives between requests", async () => {
    const modelA = makeModel("provider-a", "model-a");
    const h = fixture({ models: [modelA], defaultTier: "quick", stateVersion2: true });
    try {
      await initializeV2(h);
      const { message } = addUser(h.primary, "v2-continuation-user", "start a normal request");
      const routed = await routeAuto(h, h.primary, message);
      assert.equal(routed.model.provider, "provider-a");

      await createProviderCooldownStore(h.cwd, reliability).pauseRate("provider-a", Date.now() + 60_000);
      assert.ok(scopeFromSidecar(h.cwd, "rate", "provider-a")?.openUntil > Date.now(),
        "the external pause must be present in the shared provider sidecar before continuation");
      await assert.rejects(
        routeAuto(h, h.primary, message, "continuation"),
        /provider provider-a is paused|no healthy physical model|no eligible model/u,
        "the continuation must re-check provider admission after the external pause",
      );
    } finally { h.cleanup(); }
  });
});
