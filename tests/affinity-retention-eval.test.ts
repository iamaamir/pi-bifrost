import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { emptyEconomicSnapshot, publishEconomicObservation, type EconomicSignal, type ReservePolicy } from "../economic-signals.ts";
import { createRouter, type RouterModel, type RouterResolveResult, type RouterSnapshot } from "../router.ts";

interface Turn {
  id: string;
  tier: string;
  origin?: "automatic" | "explicit_tier";
  action?: "branch_reset";
  modelsByTier?: Record<string, string[]>;
  strategy?: "first" | "random";
  seed?: number;
  strictBoundary?: boolean;
  filter?: "preferred-class" | "reserve" | "circuit";
  outcome: "success" | "failure" | "aborted" | "none" | "reset";
  allowedModelKeys?: string[];
  strategyWinner?: string;
  expectedRetention: boolean;
}

interface Scenario { id: string; turns: Turn[] }

const corpus = JSON.parse(readFileSync(new URL("./corpus/affinity-retention/scenarios.json", import.meta.url), "utf8")) as Scenario[];
const FIXED_NOW = 10_000;

function model(modelKey: string): RouterModel {
  const [provider, id] = modelKey.split("/", 2);
  return { provider: provider!, id: id!, cost: { input: 0.5, output: 0.5 }, contextWindow: 32_000 };
}

function allModels(turn: Turn): RouterModel[] {
  const modelKeys = [...new Set(Object.values(turn.modelsByTier ?? {}).flat())];
  return modelKeys.map(model);
}

function seededRandom(seed: number | undefined): () => number {
  const value = seed ?? 0;
  return () => ((value >>> 0) + 0.5) / 0x1_0000_0000;
}

function preferenceEconomic() {
  const policy: ReservePolicy = {
    mode: "policy",
    scopes: {
      metered: { kind: "model", model: "fixture/a" },
      subscription: { kind: "model", model: "fixture/b" },
    },
    sources: [
      { id: "metered-fact", scopeRef: "metered", authority: "declared" },
      { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
    ],
    sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"] },
    admission: [],
    preference: { billingClass: "subscription" },
  };
  let snapshot = emptyEconomicSnapshot();
  for (const fact of [
    { sourceId: "metered-fact", scopeRef: "metered", billing: "metered" },
    { sourceId: "subscription-fact", scopeRef: "subscription", billing: "subscription" },
  ]) {
    const published = publishEconomicObservation(snapshot, policy, {
      ...fact,
      observedAt: FIXED_NOW - 100,
      expiresAt: FIXED_NOW + 10_000,
      revision: 1,
      windows: [],
    } as EconomicSignal);
    assert.equal(published.accepted, true);
    snapshot = published.snapshot;
  }
  return { policy, snapshot };
}

function reserveEconomic() {
  const policy: ReservePolicy = {
    mode: "policy",
    scopes: { quota: { kind: "model", model: "fixture/a" } },
    sources: [{ id: "reserve-fact", scopeRef: "quota", authority: "declared" }],
    sourceOrder: { quota: ["reserve-fact"] },
    admission: [{ id: "reserve-a", scopeRef: "quota", windowId: "requests", reserveRatio: 0.2, unknown: "block" }],
  };
  const published = publishEconomicObservation(emptyEconomicSnapshot(), policy, {
    sourceId: "reserve-fact",
    scopeRef: "quota",
    billing: "unknown",
    observedAt: FIXED_NOW - 100,
    expiresAt: FIXED_NOW + 10_000,
    revision: 1,
    windows: [{ id: "requests", period: { id: "day", sequence: 1 }, unit: "ratio", remaining: 0.1 }],
  });
  assert.equal(published.accepted, true);
  return { policy, snapshot: published.snapshot };
}

function routerSnapshot(turn: Turn, mode: "observe" | "retain-within-tier", anchor?: { modelKey: string; provider: string; lastSuccessfulDispatchAt: number }): RouterSnapshot {
  const models = turn.modelsByTier ?? { [turn.tier]: [] };
  const knownModels = allModels(turn);
  const input: RouterSnapshot = {
    config: {
      schemaVersion: 2,
      models,
      ...(turn.strictBoundary ? { tierPolicies: { [turn.tier]: { fallbackTiers: [] } } } : {}),
      default: turn.tier,
      strategy: turn.strategy ?? "first",
      rules: [],
      affinity: { mode },
      ...(turn.filter === "circuit" ? {
        reliability: { enabled: true, failureThreshold: 1, windowMinutes: 10, cooldownMinutes: 1 },
      } : {}),
    },
    registry: { knownModels, availableModels: knownModels },
    now: FIXED_NOW,
    affinity: {
      targetOrigin: "automatic",
      ...(anchor ? { anchor } : {}),
    },
  };
  if (turn.filter === "preferred-class") return { ...input, economic: preferenceEconomic() };
  if (turn.filter === "reserve") return { ...input, economic: reserveEconomic() };
  if (turn.filter === "circuit") {
    return {
      ...input,
      reliabilityState: {
        version: 1,
        models: { "fixture/a": { failures: [FIXED_NOW - 1], openUntil: FIXED_NOW + 1_000 } },
      },
    };
  }
  return input;
}

async function resolveTurn(turn: Turn, mode: "observe" | "retain-within-tier", anchor?: { modelKey: string; provider: string; lastSuccessfulDispatchAt: number }): Promise<RouterResolveResult> {
  const router = createRouter(routerSnapshot(turn, mode, anchor), { random: seededRandom(turn.seed) });
  return router.resolve({
    prompt: "fixture request",
    ...(turn.origin === "explicit_tier" ? { forcedTier: turn.tier } : {}),
  });
}

function selected(result: RouterResolveResult): string | undefined {
  return result.status === "completed" && result.decision.outcome === "selected" ? result.decision.selected : undefined;
}

function routePool(result: RouterResolveResult, tier: string) {
  if (result.status !== "completed") return undefined;
  return result.decision.attempted?.find((pool) => pool.tier === tier)
    ?? (result.decision.requested?.tier === tier ? result.decision.requested : undefined)
    ?? (result.decision.fallback?.tier === tier ? result.decision.fallback : undefined);
}

function countSwitches(models: readonly string[]): number {
  let switches = 0;
  for (let index = 1; index < models.length; index++) {
    if (models[index] !== models[index - 1]) switches++;
  }
  return switches;
}

async function evaluateScenario(scenario: Scenario) {
  let baselineAnchor: { modelKey: string; provider: string; lastSuccessfulDispatchAt: number } | undefined;
  let retainedAnchor: typeof baselineAnchor;
  const baselineSelections: string[] = [];
  const retainedSelections: string[] = [];
  let retentionCount = 0;
  let invariantViolations = 0;

  for (const turn of scenario.turns) {
    if (turn.action === "branch_reset") {
      baselineAnchor = undefined;
      retainedAnchor = undefined;
      continue;
    }
    const baselineResult = await resolveTurn(turn, "observe", baselineAnchor);
    const retainedResult = await resolveTurn(turn, "retain-within-tier", retainedAnchor);
    const baselineModel = selected(baselineResult);
    const retainedModel = selected(retainedResult);
    const baselineDecision = baselineResult.status === "completed" ? baselineResult.decision : undefined;
    const retainedDecision = retainedResult.status === "completed" ? retainedResult.decision : undefined;
    const retentionApplied = retainedDecision?.affinity?.selection === "retained_anchor";

    if (turn.expectedRetention !== retentionApplied) invariantViolations++;
    if (baselineDecision?.affinity?.strategyWinner !== turn.strategyWinner) invariantViolations++;
    if (baselineModel !== turn.strategyWinner) invariantViolations++;
    if (turn.allowedModelKeys && retainedModel && !turn.allowedModelKeys.includes(retainedModel)) invariantViolations++;
    if (turn.allowedModelKeys && baselineModel && !turn.allowedModelKeys.includes(baselineModel)) invariantViolations++;
    if (retainedModel !== undefined) retainedSelections.push(retainedModel);
    if (baselineModel !== undefined) baselineSelections.push(baselineModel);
    if (retentionApplied) retentionCount++;

    const finalPool = routePool(retainedResult, turn.tier);
    if (turn.filter === "preferred-class") {
      const preference = finalPool?.billingPreference;
      const traces = preference?.candidates ?? [];
      if (preference?.mode !== "policy" || preference.selectionCount !== 1
        || traces.find((entry) => entry.model === "fixture/a")?.effect !== "baseline"
        || traces.find((entry) => entry.model === "fixture/b")?.effect !== "preferred"
        || retainedDecision?.affinity?.selection !== "anchor_not_eligible") invariantViolations++;
    }
    if (turn.filter === "reserve" || turn.filter === "circuit") {
      const excluded = finalPool?.candidates.find((candidate) => candidate.model === "fixture/a");
      const expectedExclusion = turn.filter === "reserve" ? "economic_reserve" : "open_circuit";
      if (excluded?.status !== "excluded" || excluded.exclusion !== expectedExclusion
        || retainedDecision?.affinity?.selection !== "anchor_not_eligible") invariantViolations++;
    }
    if (turn.strictBoundary && (retainedDecision?.explicitBoundary !== true
      || retainedDecision.selectedTier !== (retainedModel ? turn.tier : undefined)
      || retainedDecision.attempted?.some((pool) => pool.tier !== turn.tier))) invariantViolations++;

    if (turn.outcome === "success" && turn.origin !== "explicit_tier") {
      if (baselineModel) baselineAnchor = { modelKey: baselineModel, provider: baselineModel.split("/")[0]!, lastSuccessfulDispatchAt: FIXED_NOW };
      if (retainedModel) retainedAnchor = { modelKey: retainedModel, provider: retainedModel.split("/")[0]!, lastSuccessfulDispatchAt: FIXED_NOW };
    }
    // Failures and aborted results may have a route decision, but they never promote that model as a successful anchor.
  }

  return {
    baselineSwitches: countSwitches(baselineSelections),
    retainedSwitches: countSwitches(retainedSelections),
    retentionCount,
    invariantViolations,
  };
}

describe("synthetic affinity retain-within-tier evaluation", () => {
  it("runs production router decisions against independent allowed-route labels", async () => {
    assert.equal(corpus.length, 10);
    const results = Object.fromEntries(await Promise.all(corpus.map(async (scenario) => [scenario.id, await evaluateScenario(scenario)] as const)));
    assert.deepEqual(results["steady-tier-retains-anchor"], {
      baselineSwitches: 2, retainedSwitches: 0, retentionCount: 1, invariantViolations: 0,
    });
    assert.deepEqual(results["billing-preference-excludes-anchor"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["reserve-excludes-anchor"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["circuit-excludes-anchor"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["tier-change-keeps-new-tier-strategy"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["explicit-tier-bypasses-retention"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["failed-and-aborted-responses-do-not-create-anchors"], {
      baselineSwitches: 3, retainedSwitches: 2, retentionCount: 1, invariantViolations: 0,
    });
    assert.deepEqual(results["branch-reset-clears-anchor"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["strict-tier-boundary-keeps-selection-local"], {
      baselineSwitches: 1, retainedSwitches: 1, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(results["empty-requested-tier-does-not-retain-anchor-from-another-tier"], {
      baselineSwitches: 0, retainedSwitches: 0, retentionCount: 0, invariantViolations: 0,
    });
    assert.deepEqual(Object.values(results).reduce((total, item) => ({
      baselineSwitches: total.baselineSwitches + item.baselineSwitches,
      retainedSwitches: total.retainedSwitches + item.retainedSwitches,
      retentionCount: total.retentionCount + item.retentionCount,
      invariantViolations: total.invariantViolations + item.invariantViolations,
    }), { baselineSwitches: 0, retainedSwitches: 0, retentionCount: 0, invariantViolations: 0 }), {
      baselineSwitches: 12, retainedSwitches: 9, retentionCount: 2, invariantViolations: 0,
    });
  });
});
