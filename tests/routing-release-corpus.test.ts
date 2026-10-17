import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createRouter, type RouterModel, type RouterSnapshot } from "../router.ts";

interface Scenario {
  id: string;
  schemaVersion: number;
  tiers: Record<string, string[]>;
  strictFallbackTiers?: Record<string, string[]>;
  requestedTier: string;
  defaultTier: string;
  forcedTier?: string;
  prompt?: string;
  strategy?: "first" | "cheapest" | "random";
  seed?: number;
  available: string[];
  circuits?: Record<string, { openUntil?: number; trialActive?: boolean }>;
  economic?: {
    rules: Array<{ windowId: string; reserveRatio: number; unknown: "block" | "ignore" }>;
    observedAt?: number;
    expiresAt?: number;
    windows: Array<{ id: string; remaining: number; resetsAt?: number }>;
  };
  allowedModels: string[];
  expectedUnavailable?: string[];
}

const NOW = 1_000;
const scenarios = JSON.parse(readFileSync(new URL("./corpus/routing-release/scenarios.json", import.meta.url), "utf8")) as Scenario[];

function model(key: string, index: number): RouterModel {
  const separator = key.indexOf("/");
  return {
    provider: key.slice(0, separator),
    id: key.slice(separator + 1),
    cost: { input: (index + 1) / 100, output: (index + 1) / 50 },
    contextWindow: 16_000 + index * 100,
  };
}

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function makeSnapshot(scenario: Scenario): RouterSnapshot {
  const keys = [...new Set([...Object.values(scenario.tiers).flat(), ...scenario.available])];
  const catalog = new Map(keys.map((key, index) => [key, model(key, index)]));
  const knownModels = [...catalog.values()];
  const availableModels = scenario.available.map((key) => catalog.get(key)!);
  const economic = scenario.economic ? {
    policy: {
      mode: "policy" as const,
      scopes: { providerFixture: { kind: "provider" as const, provider: "fixture" } },
      sources: [{ id: "synthetic", scopeRef: "providerFixture", authority: "authoritative" as const }],
      admission: scenario.economic.rules.map((rule, index) => ({ id: `reserve-${index}`, scopeRef: "providerFixture", ...rule })),
    },
    snapshot: {
      revision: 1,
      signals: [{
        sourceId: "synthetic",
        scopeRef: "providerFixture",
        billing: "subscription" as const,
        observedAt: scenario.economic.observedAt ?? 100,
        expiresAt: scenario.economic.expiresAt ?? 5_000,
        revision: 1,
        windows: scenario.economic.windows.map((window, index) => ({
          ...window,
          unit: "ratio" as const,
          period: { id: `period-${index}`, sequence: index + 1 },
        })),
      }],
      watermarks: scenario.economic.windows.map((window, index) => ({
        sourceId: "synthetic",
        scopeRef: "providerFixture",
        windowId: window.id,
        periodId: `period-${index}`,
        periodSequence: index + 1,
        revision: 1,
      })),
    },
  } : undefined;
  const reliabilityState = scenario.circuits ? {
    version: 1 as const,
    models: Object.fromEntries(Object.entries(scenario.circuits).map(([key, circuit]) => [key, { failures: [], ...circuit }])),
  } : undefined;
  return {
    config: {
      ...(scenario.schemaVersion === 1 ? {} : { schemaVersion: scenario.schemaVersion }),
      models: scenario.tiers,
      default: scenario.defaultTier,
      strategy: scenario.strategy ?? "first",
      rules: [],
      ...(scenario.strictFallbackTiers ? {
        tierPolicies: Object.fromEntries(Object.entries(scenario.strictFallbackTiers).map(([tier, fallbackTiers]) => [tier, { fallbackTiers }])),
      } : {}),
      ...(reliabilityState ? { reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 } } : {}),
    },
    registry: { knownModels, availableModels },
    now: NOW,
    ...(reliabilityState ? { reliabilityState } : {}),
    ...(economic ? { economic } : {}),
  };
}

async function resolve(scenario: Scenario) {
  const snapshot = makeSnapshot(scenario);
  const before = JSON.stringify(snapshot);
  const router = createRouter(snapshot);
  const result = await router.resolve({
    prompt: scenario.prompt ?? "synthetic release scenario",
    ...(scenario.prompt === undefined ? { forcedTier: scenario.forcedTier ?? scenario.requestedTier } : {}),
    ...(scenario.seed === undefined ? {} : { random: seeded(scenario.seed) }),
  });
  assert.equal(JSON.stringify(snapshot), before, "router resolution must not write to supplied snapshots");
  return result;
}

describe("synthetic routing release corpus", () => {
  it("matches independently labelled allowed-model and no-route sets", async () => {
    assert.equal(scenarios.length, 19);
    for (const scenario of scenarios) {
      const result = await resolve(scenario);
      assert.equal(result.status, "completed", scenario.id);
      if (result.status !== "completed") continue;
      if (scenario.allowedModels.length === 0) {
        assert.equal(result.decision.outcome, "unresolved", scenario.id);
        assert.equal(result.decision.selected, undefined, scenario.id);
      } else {
        assert.equal(result.decision.outcome, "selected", scenario.id);
        assert.ok(scenario.allowedModels.includes(result.decision.selected!), `${scenario.id}: unexpected ${result.decision.selected}`);
      }
      if (scenario.expectedUnavailable) {
        assert.deepEqual(result.knownUnavailableModels, scenario.expectedUnavailable, scenario.id);
      }
    }
  });

  it("replays seeded random routes and never invokes an ungranted classifier port", async () => {
    const scenario = scenarios.find((item) => item.id === "seeded-random-replay")!;
    const first = await resolve(scenario);
    const second = await resolve(scenario);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    if (first.status === "completed" && second.status === "completed") {
      assert.equal(first.decision.selected, second.decision.selected);
      assert.ok(scenario.allowedModels.includes(first.decision.selected!));
    }

    let calls = 0;
    const config = makeSnapshot(scenario).config;
    const guardedSnapshot = { ...makeSnapshot(scenario), config: { ...config, classifier: { enabled: true } } };
    const guarded = createRouter(guardedSnapshot, {
      networkClassifier: { classify: async () => { calls += 1; throw new Error("external classifier must not run"); } },
    });
    await guarded.resolve({ prompt: "synthetic request", forcedTier: scenario.requestedTier, random: seeded(scenario.seed!) });
    assert.equal(calls, 0);
  });
});
