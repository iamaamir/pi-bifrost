import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { debug, setupDebug } from "../debug.ts";
import { createRouter, type RouterModel, type RouterSnapshot } from "../router.ts";
import { emptyEconomicSnapshot, publishEconomicObservation, type EconomicSignal, type ReservePolicy } from "../economic-signals.ts";

function model(provider: string, id: string, input = 0.2, output = 0.3, contextWindow = 32_000): RouterModel {
  return { provider, id, cost: { input, output }, contextWindow };
}

function snapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  const available = model("fixture", "quick-model");
  return {
    config: {
      models: { quick: ["fixture/quick-model"], general: ["fixture/general-model"] },
      default: "quick",
      strategy: "first",
      rules: [],
    },
    registry: {
      knownModels: [available, model("fixture", "general-model", 0.4, 0.6)],
      availableModels: [available, model("fixture", "general-model", 0.4, 0.6)],
    },
    now: 1_000,
    ...overrides,
  };
}

describe("experimental resolve-only router", () => {
  it("resolves against explicit snapshots and returns only a content-free summary", async () => {
    const input = snapshot();
    const router = createRouter(input);
    const result = await router.resolve({ prompt: "ordinary request" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.decision.outcome, "selected");
    assert.equal(result.decision.selected, "fixture/quick-model");
    assert.equal("model" in result, false);
  });

  it("applies preference-only economic policy within the selected tier and exposes only the projection", async () => {
    const economicPolicy: ReservePolicy = {
      mode: "policy",
      scopes: {
        metered: { kind: "model", model: "fixture/metered" },
        subscription: { kind: "model", model: "fixture/subscription" },
      },
      sources: [
        { id: "metered-fact", scopeRef: "metered", authority: "declared" },
        { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
      ],
      sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"] },
      admission: [],
      preference: { billingClass: "subscription" },
    };
    let facts = emptyEconomicSnapshot();
    for (const observation of [
      { sourceId: "metered-fact", scopeRef: "metered", billing: "metered" },
      { sourceId: "subscription-fact", scopeRef: "subscription", billing: "subscription" },
    ]) {
      const result = publishEconomicObservation(facts, economicPolicy, {
        ...observation, observedAt: 100, expiresAt: 2_000, revision: 1, windows: [],
      } as EconomicSignal);
      assert.equal(result.accepted, true);
      facts = result.snapshot;
    }
    const router = createRouter(snapshot({
      config: {
        models: { quick: ["fixture/metered", "fixture/subscription"] },
        default: "quick",
        strategy: "cheapest",
        rules: [],
      },
      registry: {
        knownModels: [model("fixture", "metered", 0.01, 0.01), model("fixture", "subscription", 0.8, 0.8)],
        availableModels: [model("fixture", "metered", 0.01, 0.01), model("fixture", "subscription", 0.8, 0.8)],
      },
      economic: { policy: economicPolicy, snapshot: facts },
    }));
    const result = await router.resolve({ prompt: "request", forcedTier: "quick" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.decision.selected, "fixture/subscription");
    const preference = result.decision.requested?.billingPreference;
    assert.equal(preference?.mode, "policy");
    assert.equal(preference?.eligibleCount, 2);
    assert.equal(preference?.preferredCount, 1);
    assert.equal(preference?.selectionCount, 1);
    assert.equal(JSON.stringify(result.decision).includes("remaining"), false);
  });

  it("exposes caller-owned affinity as advisory evidence without changing selection or RNG", async () => {
    let randomCalls = 0;
    const router = createRouter(snapshot({
      config: {
        schemaVersion: 2,
        models: { general: ["fixture/quick-model", "fixture/general-model"] },
        default: "general",
        strategy: "random",
        rules: [],
        affinity: { mode: "observe", providerAdvisory: true },
      },
      affinity: {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/quick-model", provider: "fixture", lastSuccessfulDispatchAt: 500 },
      },
    }), { random: () => { randomCalls += 1; return 0.75; } });
    const result = await router.resolve({ prompt: "ordinary request" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.decision.selected, "fixture/general-model");
    assert.equal(randomCalls, 1);
    assert.equal(result.decision.affinity?.status, "current_eligible");
    assert.equal(result.decision.affinity?.baseStrategyWinner, "fixture/general-model");
    assert.equal(result.decision.affinity?.sameProviderCandidateAvailable, true);
  });

  it("exposes retain-within-tier as an advisory resolve result with an explicit selection source", async () => {
    const router = createRouter(snapshot({
      config: {
        schemaVersion: 2,
        models: { general: ["fixture/quick-model", "fixture/general-model"] },
        default: "general",
        strategy: "random",
        rules: [],
        affinity: { mode: "retain-within-tier" },
      },
      affinity: {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/quick-model", provider: "fixture", lastSuccessfulDispatchAt: 500 },
      },
    }), { random: () => 0.75 });
    const result = await router.resolve({ prompt: "ordinary request" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.decision.selected, "fixture/quick-model");
    assert.deepEqual(result.decision.affinity && {
      mode: result.decision.affinity.mode,
      strategyWinner: result.decision.affinity.strategyWinner,
      selectedModel: result.decision.affinity.selectedModel,
      selectedTier: result.decision.affinity.selectedTier,
      selection: result.decision.affinity.selection,
    }, {
      mode: "retain-within-tier",
      strategyWinner: "fixture/general-model",
      selectedModel: "fixture/quick-model",
      selectedTier: "general",
      selection: "retained_anchor",
    });
  });

  it("reports unknown locality without an anchor and prevents a caller auto origin from overriding a forced tier", async () => {
    const baseConfig = {
      schemaVersion: 2,
      models: { quick: ["fixture/quick-model"] },
      default: "quick",
      rules: [],
      affinity: { mode: "observe" as const },
    };
    const noAnchorRouter = createRouter(snapshot({ config: baseConfig, affinity: { targetOrigin: "automatic" } }));
    const noAnchor = await noAnchorRouter.resolve({ prompt: "ordinary request" });
    assert.equal(noAnchor.status === "completed" ? noAnchor.decision.affinity?.status : undefined, "locality_unknown");

    const forcedRouter = createRouter(snapshot({ config: baseConfig, affinity: {
      targetOrigin: "automatic",
      anchor: { modelKey: "fixture/quick-model", provider: "fixture", lastSuccessfulDispatchAt: 500 },
    } }));
    const forced = await forcedRouter.resolve({ prompt: "ordinary request", forcedTier: "quick" });
    assert.deepEqual(forced.status === "completed" ? forced.decision.affinity : undefined, {
      version: 1, status: "not_applicable", snapshotAsOf: 1_000, mode: "observe", selection: "not_applicable",
      strategyWinner: "fixture/quick-model", selectedModel: "fixture/quick-model", selectedTier: "quick",
    });
  });

  it("rejects malformed and future affinity anchors before a granted classifier can run", () => {
    let classifierCalls = 0;
    const classifier = { classify: async () => {
      classifierCalls++;
      return { tier: "quick", backend: "fixture-classifier" };
    } };
    for (const anchor of [
      { modelKey: "PRIVATE_AFFINITY_SENTINEL", provider: "fixture", lastSuccessfulDispatchAt: 500 },
      { modelKey: "fixture/quick-model", provider: "fixture", lastSuccessfulDispatchAt: 1_001 },
    ]) {
      assert.throws(() => createRouter(snapshot({
        config: {
          schemaVersion: 2,
          models: { quick: ["fixture/quick-model"] },
          default: "quick",
          rules: [],
          classifier: { enabled: true },
          affinity: { mode: "observe" },
        },
        affinity: { targetOrigin: "automatic", anchor },
      }), { networkClassifierGrant: true, networkClassifier: classifier }), /Invalid router affinity snapshot/);
    }
    assert.equal(classifierCalls, 0);
  });

  it("keeps intrinsic forced-tier intent ahead of retain-within-tier advice", async () => {
    const router = createRouter(snapshot({
      config: {
        schemaVersion: 2,
        models: { quick: ["fixture/quick-model", "fixture/general-model"] },
        default: "quick",
        strategy: "first",
        rules: [],
        affinity: { mode: "retain-within-tier" },
      },
      affinity: {
        targetOrigin: "automatic",
        anchor: { modelKey: "fixture/general-model", provider: "fixture", lastSuccessfulDispatchAt: 500 },
      },
    }));
    const result = await router.resolve({ prompt: "ordinary request", forcedTier: "quick" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.decision.selected, "fixture/quick-model");
    assert.equal(result.decision.affinity?.selection, "not_applicable");
  });

  it("rejects an affinity snapshot when observation mode is not enabled", () => {
    assert.throws(() => createRouter(snapshot({
      affinity: { targetOrigin: "automatic" },
    })), /Router affinity input requires affinity observation mode/);
  });

  it("keeps preference-only policy advisory when a configured tier has no available route", async () => {
    const economicPolicy: ReservePolicy = {
      mode: "policy",
      scopes: { offline: { kind: "model", model: "fixture/offline" } },
      sources: [{ id: "manual", scopeRef: "offline", authority: "declared" }],
      admission: [],
      preference: { billingClass: "subscription" },
    };
    const router = createRouter(snapshot({
      config: { models: { quick: ["fixture/offline"] }, default: "quick", strategy: "first", rules: [] },
      registry: { knownModels: [model("fixture", "offline")], availableModels: [] },
      economic: { policy: economicPolicy, snapshot: emptyEconomicSnapshot() },
    }));
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.decision.outcome, "unresolved");
    assert.equal(result.decision.selected, undefined);
    assert.deepEqual(result.knownUnavailableModels, ["fixture/offline"]);
  });

  it("selects only available models and reports known-but-unavailable exact bindings", async () => {
    const exact = createRouter(snapshot({
      config: { models: { quick: ["fixture/offline-model"] }, default: "quick", strategy: "first", rules: [] },
      registry: {
        knownModels: [model("fixture", "offline-model")],
        availableModels: [],
      },
    }));
    const exactResult = await exact.resolve({ prompt: "request" });
    assert.equal(exactResult.status, "completed");
    if (exactResult.status === "completed") {
      assert.equal(exactResult.decision.outcome, "unresolved");
      assert.equal(exactResult.decision.selected, undefined);
      assert.deepEqual(exactResult.knownUnavailableModels, ["fixture/offline-model"]);
    }

    const availableExact = createRouter(snapshot({
      config: { models: { quick: ["fixture/online-model"] }, default: "quick", strategy: "first", rules: [] },
      registry: {
        knownModels: [model("fixture", "online-model")],
        availableModels: [model("fixture", "online-model")],
      },
    }));
    const availableResult = await availableExact.resolve({ prompt: "request" });
    assert.equal(availableResult.status, "completed");
    if (availableResult.status === "completed") {
      assert.equal(availableResult.decision.selected, "fixture/online-model");
      assert.deepEqual(availableResult.knownUnavailableModels, []);
    }

    const fuzzy = createRouter(snapshot({
      config: { models: { quick: ["restricted"] }, default: "quick", strategy: "first", rules: [] },
      registry: {
        knownModels: [model("fixture", "restricted-model")],
        availableModels: [],
      },
    }));
    const fuzzyResult = await fuzzy.resolve({ prompt: "request" });
    assert.equal(fuzzyResult.status, "completed");
    if (fuzzyResult.status === "completed") assert.equal(fuzzyResult.decision.outcome, "unresolved");

    assert.throws(() => createRouter(snapshot({ registry: {
      knownModels: [model("fixture", "same", 0.2, 0.3, 32_000)],
      availableModels: [model("fixture", "same", 0.9, 0.8, 64_000)],
    } })), /Inconsistent router model metadata/);
  });

  it("keeps explicit fallback order, direct bindings, and inline tier overrides", async () => {
    const input = snapshot({
      config: {
        schemaVersion: 2,
        models: { quick: ["missing"], general: ["fixture/general-model"] },
        tierPolicies: { quick: { fallbackTiers: ["general"] } },
        default: "general",
        strategy: "first",
        rules: [{ pattern: "direct model", model: "fixture/general-model" }],
      },
    });
    const router = createRouter(input);
    const fallback = await router.resolve({ prompt: "quick please do task" });
    assert.equal(fallback.status, "completed");
    if (fallback.status === "completed") {
      assert.equal(fallback.decision.selected, "fixture/general-model");
      assert.deepEqual(fallback.decision.attempted?.map((pool) => pool.tier), ["quick", "general"]);
      assert.equal(fallback.decision.explicitBoundary, true);
    }
    const direct = await router.resolve({ prompt: "direct model" });
    assert.equal(direct.status, "completed");
    if (direct.status === "completed") assert.equal(direct.decision.selected, "fixture/general-model");
  });

  it("excludes explicitly virtual entries", async () => {
    const router = createRouter(snapshot({
      config: { models: { quick: ["bifrost/auto", "fixture/virtual"] }, default: "quick", rules: [] },
      registry: {
        knownModels: [
          { ...model("bifrost", "auto"), virtual: true },
          { ...model("fixture", "virtual"), virtual: true },
        ],
        availableModels: [
          { ...model("bifrost", "auto"), virtual: true },
          { ...model("fixture", "virtual"), virtual: true },
        ],
      },
    }));
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.decision.outcome, "unresolved");
  });

  it("uses only the explicit virtual marker, not provider-specific model names", async () => {
    const router = createRouter(snapshot({
      config: { models: { quick: ["bifrost/auto"] }, default: "quick", rules: [] },
      registry: {
        knownModels: [model("bifrost", "auto")],
        availableModels: [model("bifrost", "auto")],
      },
    }));
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.decision.selected, "bifrost/auto");
  });

  it("uses only caller-provided prices and a per-resolution RNG", async () => {
    const router = createRouter(snapshot({
      config: { models: { quick: ["fixture/a", "fixture/b"] }, default: "quick", strategy: "random", rules: [] },
      registry: {
        knownModels: [model("fixture", "a", 0.01, 0.02), model("fixture", "b", 0.03, 0.04)],
        availableModels: [model("fixture", "a", 0.01, 0.02), model("fixture", "b", 0.03, 0.04)],
      },
    }));
    const result = await router.resolve({ prompt: "request", random: () => 0.75 });
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.decision.selected, "fixture/b");
    assert.throws(() => createRouter(snapshot({ registry: {
      knownModels: [{ provider: "fixture", id: "missing-price", cost: {} as RouterModel["cost"], contextWindow: 16_000 }],
      availableModels: [],
    } })), /Invalid router model snapshot/);
  });

  it("captures the clock and factory options, and rejects unconfigured forced tiers", async () => {
    const mutableOptions = { random: () => 0.75 };
    const input = snapshot({
      config: { models: { quick: ["fixture/a", "fixture/b"] }, default: "quick", strategy: "random", rules: [] },
      registry: {
        knownModels: [model("fixture", "a"), model("fixture", "b")],
        availableModels: [model("fixture", "a"), model("fixture", "b")],
      },
      now: 200,
    });
    const router = createRouter(input, mutableOptions);
    Object.assign(input, { now: 20_000 });
    mutableOptions.random = () => 0;
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.decision.selected, "fixture/b");
    await assert.rejects(router.resolve({ prompt: "request", forcedTier: "fixture/a" }), /Forced tier is not configured/);
  });

  it("copies input snapshots and does not expose transport-only properties", async () => {
    const transportSecret = "PRIVATE_TRANSPORT_SENTINEL";
    const inputModel = { ...model("fixture", "quick-model"), api: "secret-api", baseUrl: transportSecret } as RouterModel;
    const input = snapshot({ registry: { knownModels: [inputModel], availableModels: [inputModel] } });
    const router = createRouter(input);
    (input.config.models as Record<string, string[]>).quick[0] = "fixture/changed";
    (inputModel.cost as { input: number }).input = 99;
    const result = await router.resolve({ prompt: "request" });
    const serialized = JSON.stringify(result);
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.decision.selected, "fixture/quick-model");
    assert.equal(serialized.includes(transportSecret), false);
    assert.equal(serialized.includes("baseUrl"), false);
  });

  it("does not call an external classifier without both explicit grant and config enablement", async () => {
    let calls = 0;
    const port = { classify: async () => { calls += 1; return { tier: "quick", backend: "custom-reviewer" }; } };
    const router = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [], classifier: { enabled: true },
    } }), { networkClassifier: port });
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    assert.equal(calls, 0);
  });

  it("bounds granted classifier prompts, preserves backend identity, and validates its tier", async () => {
    let observedPrompt = "";
    let observedCriteria: Record<string, unknown> = {};
    const port = {
      classify: async (input: { prompt: string; criteria: Record<string, unknown> }) => {
        observedPrompt = input.prompt;
        observedCriteria = input.criteria;
        return { tier: "quick", backend: "external.review.v2", model: "reviewer-4", confidence: 0.8 };
      },
    };
    const router = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [], classifier: { enabled: true },
    } }), { networkClassifierGrant: true, networkClassifier: port });
    const result = await router.resolve({ prompt: "x".repeat(20_000) });
    assert.equal(observedPrompt.length, 16_384);
    assert.deepEqual(observedCriteria, {});
    assert.equal(result.status, "completed");
    if (result.status === "completed") {
      assert.equal(result.decision.classification.classifier?.backend, "external.review.v2");
      assert.equal(result.decision.classification.classifier?.model, "reviewer-4");
    }

    const invalid = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [], classifier: { enabled: true },
    } }), { networkClassifierGrant: true, networkClassifier: {
      classify: async () => ({ tier: "unknown", backend: "external.review.v2" }),
    } });
    const fallback = await invalid.resolve({ prompt: "request" });
    assert.equal(fallback.status, "completed");
    if (fallback.status === "completed") assert.equal(fallback.decision.classification.source, "fallback");
  });

  it("passes only bounded configured criteria for requested tiers", async () => {
    const privateSentinel = "UNRELATED_PRIVATE_CRITERION_SENTINEL";
    let received: Record<string, unknown> = {};
    const router = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [],
      classifier: { enabled: true, criteria: {
        quick: { what: "Bounded work", examples: ["small edit"] },
        unrelated: privateSentinel,
      } },
    } }), { networkClassifierGrant: true, networkClassifier: {
      classify: async (input: { criteria: Record<string, unknown> }) => {
        received = input.criteria;
        return { tier: "quick", backend: "external.review" };
      },
    } });
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    assert.deepEqual(received, { quick: { what: "Bounded work", examples: ["small edit"] } });
    assert.equal(JSON.stringify(received).includes(privateSentinel), false);

    assert.throws(() => createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [],
      classifier: { enabled: true, criteria: { quick: {
        what: "Bounded", apiKey: "MUST_NOT_ESCAPE",
      } as unknown as { what: string } } },
    } }), { networkClassifierGrant: true, networkClassifier: { classify: async () => undefined } }), /Invalid router classifier criterion/);
  });

  it("honors configured minimum confidence and fails closed when confidence is absent", async () => {
    const config = {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [],
      classifier: { enabled: true, minConfidence: 0.7 },
    };
    const low = await createRouter(snapshot({ config }), {
      networkClassifierGrant: true,
      networkClassifier: { classify: async () => ({ tier: "quick", backend: "external.review", confidence: 0.6 }) },
    }).resolve({ prompt: "request" });
    assert.equal(low.status, "completed");
    if (low.status === "completed") assert.equal(low.decision.classification.source, "fallback");

    const missing = await createRouter(snapshot({ config }), {
      networkClassifierGrant: true,
      networkClassifier: { classify: async () => ({ tier: "quick", backend: "external.review" }) },
    }).resolve({ prompt: "request" });
    assert.equal(missing.status, "completed");
    if (missing.status === "completed") assert.equal(missing.decision.classification.source, "fallback");
    for (const invalid of [Number.NaN, -0.1, 1.1, "0.8"]) {
      assert.throws(() => createRouter(snapshot({ config: {
        models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [],
        classifier: { minConfidence: invalid as number },
      } })), /Invalid router classifier minimum confidence/);
    }
  });

  it("forwards the configured total classifier budget into the shared pipeline", async () => {
    let classifierSignal: AbortSignal | undefined;
    const router = createRouter(snapshot({
      config: {
        models: { quick: ["fixture/quick-model"] },
        default: "quick",
        strategy: "first",
        rules: [],
        classifier: { enabled: true, totalTimeoutMs: 10 },
      },
    }), {
      networkClassifierGrant: true,
      classifierTimeoutMs: 1_000,
      networkClassifier: {
        classify: async (_input, signal) => {
          classifierSignal = signal;
          return await new Promise(() => {});
        },
      },
    });

    const result = await router.resolve({ prompt: "bounded request" });
    assert.equal(result.status, "completed");
    if (result.status === "completed") {
      assert.equal(result.decision.classificationOutcome, "deadline");
    }
    assert.equal(classifierSignal?.aborted, true);
  });

  it("stops waiting on abort or deadline and never returns a late classifier route", async () => {
    let release: ((value: { tier: string; backend: string }) => void) | undefined;
    let called = false;
    const port = { classify: async () => {
      called = true;
      return await new Promise<{ tier: string; backend: string }>((resolve) => { release = resolve; });
    } };
    const router = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [], classifier: { enabled: true },
    } }), { networkClassifierGrant: true, networkClassifier: port });
    const controller = new AbortController();
    const pending = router.resolve({ prompt: "request", signal: controller.signal });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const check = () => {
        if (called) resolve();
        else if (Date.now() >= deadline) reject(new Error("classifier did not start"));
        else setTimeout(check, 1);
      };
      check();
    });
    controller.abort();
    const aborted = await pending;
    assert.deepEqual(aborted, { version: 1, status: "aborted", asOf: 1_000 });
    release?.({ tier: "quick", backend: "external.review.v2" });

    const deadlineRouter = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [], classifier: { enabled: true },
    } }), { networkClassifierGrant: true, classifierTimeoutMs: 20, networkClassifier: port });
    const start = Date.now();
    const deadlineResult = await deadlineRouter.resolve({ prompt: "request" });
    assert.ok(Date.now() - start < 500);
    assert.equal(deadlineResult.status, "completed");
    if (deadlineResult.status === "completed") assert.equal(deadlineResult.decision.classification.source, "fallback");
  });

  it("captures request signal and RNG before awaiting an external classifier", async () => {
    let releaseAbort: ((value: { tier: string; backend: string }) => void) | undefined;
    let abortClassifierStarted = false;
    const abortRouter = createRouter(snapshot({ config: {
      models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [], classifier: { enabled: true },
    } }), { networkClassifierGrant: true, networkClassifier: {
      classify: async () => {
        abortClassifierStarted = true;
        return await new Promise<{ tier: string; backend: string }>((resolve) => { releaseAbort = resolve; });
      },
    } });
    const originalController = new AbortController();
    const replacementController = new AbortController();
    const mutableAbortRequest = { prompt: "request", signal: originalController.signal };
    const abortPending = abortRouter.resolve(mutableAbortRequest);
    await waitUntil(() => abortClassifierStarted);
    mutableAbortRequest.signal = replacementController.signal;
    originalController.abort();
    assert.deepEqual(await abortPending, { version: 1, status: "aborted", asOf: 1_000 });
    releaseAbort?.({ tier: "quick", backend: "external" });

    let releaseRng: ((value: { tier: string; backend: string }) => void) | undefined;
    let rngClassifierStarted = false;
    const rngRouter = createRouter(snapshot({
      config: {
        models: { quick: ["fixture/a", "fixture/b"] }, default: "quick", strategy: "random", rules: [],
        classifier: { enabled: true },
      },
      registry: {
        knownModels: [model("fixture", "a"), model("fixture", "b")],
        availableModels: [model("fixture", "a"), model("fixture", "b")],
      },
    }), { networkClassifierGrant: true, networkClassifier: {
      classify: async () => {
        rngClassifierStarted = true;
        return await new Promise<{ tier: string; backend: string }>((resolve) => { releaseRng = resolve; });
      },
    } });
    const mutableRngRequest = { prompt: "request", random: () => 0.75 };
    const rngPending = rngRouter.resolve(mutableRngRequest);
    await waitUntil(() => rngClassifierStarted);
    mutableRngRequest.random = () => 0;
    releaseRng?.({ tier: "quick", backend: "external" });
    const rngResult = await rngPending;
    assert.equal(rngResult.status, "completed");
    if (rngResult.status === "completed") assert.equal(rngResult.decision.selected, "fixture/b");
  });

  it("returns an aborted result immediately when cancelled before classification", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createRouter(snapshot()).resolve({ prompt: "request", signal: controller.signal });
    assert.deepEqual(result, { version: 1, status: "aborted", asOf: 1_000 });
  });

  it("evaluates explicit economic snapshots through the shared resolver without changing them", async () => {
    const policy = {
      mode: "policy" as const,
      scopes: { selected: { kind: "provider" as const, provider: "fixture" } },
      sources: [{ id: "manual", scopeRef: "selected", authority: "declared" as const }],
      admission: [{ id: "daily-reserve", scopeRef: "selected", windowId: "daily", reserveRatio: 0.2, unknown: "block" as const }],
    };
    const signal = {
      sourceId: "manual",
      scopeRef: "selected",
      billing: "subscription" as const,
      observedAt: 100,
      expiresAt: 10_000,
      revision: 1,
      windows: [{ id: "daily", period: { id: "day-1", sequence: 1 }, unit: "requests" as const, remaining: 10, limit: 100 }],
    };
    const { publishEconomicObservation, emptyEconomicSnapshot } = await import("../economic-signals.ts");
    const published = publishEconomicObservation(emptyEconomicSnapshot(), policy, signal);
    assert.equal(published.accepted, true);
    const economicSnapshot = published.snapshot;
    const before = JSON.stringify(economicSnapshot);
    const input = snapshot({
      now: 200,
      config: {
        schemaVersion: 2,
        models: { quick: ["fixture/quick-model"] },
        default: "quick",
        rules: [],
      },
      economic: { policy, snapshot: economicSnapshot },
    });
    const router = createRouter(input);
    Object.assign(input, { now: 20_000 });
    const result = await router.resolve({ prompt: "request" });
    assert.equal(result.status, "completed");
    if (result.status === "completed") {
      assert.equal(result.decision.outcome, "unresolved");
      assert.equal(result.decision.requested?.candidates[0]?.exclusion, "economic_reserve");
    }
    assert.equal(result.status === "completed" ? result.asOf : undefined, 200);
    assert.equal(JSON.stringify(economicSnapshot), before);
  });

  it("validates reliability snapshots before any classifier call and omits unused reason text", async () => {
    let calls = 0;
    const classifier = { classify: async () => { calls += 1; return { tier: "quick", backend: "external" }; } };
    const invalid = snapshot({ reliabilityState: { version: 1, models: {
      "fixture/quick-model": { failures: ["bad timestamp"] as unknown as number[] },
    } } });
    assert.throws(() => createRouter(invalid, { networkClassifierGrant: true, networkClassifier: classifier }), /Invalid router reliability snapshot/);
    assert.equal(calls, 0);

    const reason = "PRIVATE_RELIABILITY_REASON_SENTINEL";
    const router = createRouter(snapshot({
      config: { models: { quick: ["fixture/quick-model"] }, default: "quick", rules: [] },
      reliabilityState: { version: 1, models: {
        "fixture/quick-model": { failures: [], lastFailureReason: reason },
      } },
    }));
    const result = await router.resolve({ prompt: "request" });
    assert.equal(JSON.stringify(result).includes(reason), false);
  });

  it("rejects v2 reliability lifecycle controls the resolve-only API cannot enforce", () => {
    const input = snapshot({ config: {
      ...snapshot().config,
      reliability: { stateVersion: 2, observations: { enabled: true } },
    } as unknown as RouterSnapshot["config"] });
    assert.throws(() => createRouter(input), /Unsupported router reliability controls/);
  });

  it("does not append pipeline debug events while the main process logger is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-router-debug-"));
    const logPath = join(directory, "debug.jsonl");
    const waitForStartup = async (): Promise<string> => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        try {
          const contents = await readFile(logPath, "utf8");
          if (contents.includes('"event":"startup"')) return contents;
        } catch { /* initial async flush has not created the log yet */ }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("debug startup event was not flushed");
    };
    setupDebug({ enabled: true, path: logPath }, directory);
    debug("router-test", "startup");
    const baseline = await waitForStartup();
    let classifierCalls = 0;
    try {
      const input = snapshot({ config: {
        models: { quick: ["fixture/quick-model"] }, default: "quick",
        rules: [{ pattern: "local task", model: "quick" }],
        classifier: { enabled: true },
      } });
      const router = createRouter(input, {
        networkClassifierGrant: true,
        networkClassifier: {
          classify: async () => {
            classifierCalls += 1;
            return { tier: "quick", backend: "external.fake" };
          },
        },
      });
      const local = await router.resolve({ prompt: "local task", forcedTier: "quick" });
      const classified = await router.resolve({ prompt: "ordinary task" });
      assert.equal(local.status, "completed");
      assert.equal(classified.status, "completed");
      assert.equal(classifierCalls, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await readFile(logPath, "utf8"), baseline);
    } finally {
      setupDebug({ enabled: false, path: logPath }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test callback.");
}
