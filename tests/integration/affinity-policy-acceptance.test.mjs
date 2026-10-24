// G06 (P1) affinity policy acceptance: composed opt-out / retention matrix.
//
// Boundary: the pure route resolver (`resolveConfiguredTier`) is driven with
// declared config, reliability, anchor and RNG snapshots. The Auto adapter is
// additionally exercised through the real extension's registered route/inspect
// hooks for the branch-reset case. Expected selections come from the
// independent oracle below, never from production code.
//
// Controlled fault: the final case copies routing.ts into a private scratch
// tree and makes the retained-anchor lookup fall back to the *unfiltered*
// candidate list, so a hard-excluded anchor is retained. The named
// hard-exclusion assertion must turn RED. Committed sources stay untouched.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { makeModel } from "../helpers.ts";
import bifrostExtension from "../../index.ts";
import { resolveConfiguredTier } from "../../routing.ts";
import { buildRouteDecisionSummary } from "../../classification-pipeline.ts";
import { REPLAY_GUARD_BASELINE_SHA256 } from "../fixtures/replay-fault-control.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRODUCTION_INDEX_SHA256 = REPLAY_GUARD_BASELINE_SHA256;
const SELECTION_CANDIDATES_GUARD = "const selectionCandidates = targetPool.selectionCandidates ?? targetPool.healthyCandidates;";
const SELECTION_CANDIDATES_MUTANT = "const selectionCandidates = targetPool.candidates ?? targetPool.selectionCandidates ?? targetPool.healthyCandidates;";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ── Independent affinity oracle ────────────────────────────────────────────
//
// Declared semantics, reimplemented without importing affinity.ts or routing.ts.
// `pool` is the ordered eligible pool; `randomValue` models one strategy draw.
function affinityOracle({ mode, origin = "automatic", pool, anchorKey, strategy, randomValue = 0 }) {
  const strategyWinner = pick(pool, strategy, randomValue);
  if (mode === "off" || origin !== "automatic" || pool.length === 0) {
    return { selection: "not_applicable", selected: strategyWinner, strategyWinner };
  }
  if (mode === "observe") return { selection: "strategy", selected: strategyWinner, strategyWinner };
  if (!anchorKey) return { selection: "no_anchor", selected: strategyWinner, strategyWinner };
  if (!pool.includes(anchorKey)) return { selection: "anchor_not_eligible", selected: strategyWinner, strategyWinner };
  if (strategyWinner !== anchorKey) return { selection: "retained_anchor", selected: anchorKey, strategyWinner };
  return { selection: "strategy", selected: anchorKey, strategyWinner };
}

function pick(pool, strategy, randomValue) {
  if (pool.length === 0) return undefined;
  return strategy === "random" ? pool[Math.floor(randomValue * pool.length)] : pool[0];
}

// ── Resolver snapshots ─────────────────────────────────────────────────────

function resolverContext(available) {
  return {
    modelRegistry: {
      getAvailable: () => available,
      find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
    },
  };
}

function resolverConfig({ mode = "retain-within-tier", models, strategy = "random" }) {
  return { schemaVersion: 2, models, default: "quick", strategy, affinity: { mode } };
}

function anchorFor(modelKey, at = 1_000) {
  return { modelKey, provider: modelKey.slice(0, modelKey.indexOf("/")), lastSuccessfulDispatchAt: at };
}

function openCircuitState(modelKey, now) {
  return { version: 1, models: { [modelKey]: { failures: [], openUntil: now + 600_000, trialActive: false } } };
}

function resolve(routing, { config, available, modelKey, anchor, origin = "automatic", mode, strategy = "random", randomValue = 0.9, reliabilityState, now = 1_000, tier = "quick", economic }) {
  const pool = available.map((model) => `${model.provider}/${model.id}`);
  const draws = [];
  const random = () => { draws.push(randomValue); return randomValue; };
  const affinity = {
    intrinsicOrigin: origin,
    effectiveMode: mode ?? config.affinity.mode,
    modeSource: "auto_default",
    ...(anchor ? { anchor } : {}),
  };
  const result = routing.resolveConfiguredTier(
    resolverContext(available), tier, config, reliabilityState, { enabled: true }, now, economic, random, affinity,
  );
  const resolution = result.resolution;
  const summary = buildRouteDecisionSummary(
    { kind: "classified", tier, source: "regex" },
    { resolution, options: result.options },
  );
  return { resolution, summary, draws, pool };
}

// ── Named assertion shared with the controlled fault ───────────────────────

function assertHardExcludedAnchor(routing, { available, now = 1_000 }) {
  const config = resolverConfig({ models: { quick: ["fixture/a", "fixture/b"] } });
  const { resolution, summary } = resolve(routing, {
    config,
    available,
    tier: "quick",
    anchor: anchorFor("fixture/a"),
    reliabilityState: openCircuitState("fixture/a", now),
    now,
    randomValue: 0.9,
  });
  const observation = resolution.affinityObservation;
  assert.equal(observation.selection, "anchor_not_eligible", "a hard-excluded anchor must not be retained");
  assert.equal(observation.selectedModel, "fixture/b", "the hard-excluded anchor must lose to the eligible strategy winner");
  assert.notEqual(resolution.selected && `${resolution.selected.provider}/${resolution.selected.id}`, "fixture/a");
  const candidate = summary.requested.candidates.find((entry) => entry.model === "fixture/a");
  assert.equal(candidate?.status, "excluded", "the anchor model must remain reported as hard-excluded");
  return { observation, summary };
}

// ── Auto adapter harness (branch reset) ────────────────────────────────────

function makeAdapterHarness(config, available) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalRandom = Math.random;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-affinity-adapter-"));
  const agentDir = join(cwd, "agent");
  const configDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "bifrost.json"), JSON.stringify(config));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map();
  let routeDefinition, commandHandler;
  const selected = [];
  const branch = [];
  const autoModel = { ...makeModel("bifrost", "auto"), api: "pi-virtual" };
  const sessionManager = { getHeader: () => ({ id: "affinity-adapter" }), getBranch: () => branch };
  const ctx = {
    cwd, mode: "rpc", hasUI: false, model: autoModel, sessionManager,
    modelRegistry: {
      getAvailable: () => available,
      getAll: () => available,
      find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
      getProviderAuthStatus: () => ({ configured: false }),
      getModelsOfType: () => [], getModelOfType: () => undefined, getAvailableOfType: async () => [],
      refresh: async () => ({ refreshed: [], errors: [] }),
    },
    ui: {
      setWidget: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
      notify: () => {}, custom: async () => null, theme: { fg: (_c, text) => text },
    },
    thinkingLevel: "low",
  };
  const pi = {
    registerVirtualModel: (definition) => { routeDefinition = definition; },
    registerCommand: (_name, opts) => { commandHandler = opts.handler; },
    on: (event, handler) => { handlers.set(event, handler); return () => {}; },
    setModel: async (model) => { selected.push(`${model.provider}/${model.id}`); return true; },
  };
  bifrostExtension(pi);
  if (!routeDefinition?.route || !commandHandler) throw new Error("affinity adapter did not register required hooks");

  const inspect = async () => {
    const output = [];
    const originalError = console.error;
    console.error = (...values) => { output.push(values.map(String).join(" ")); };
    try {
      await commandHandler("inspect --json", ctx);
    } finally {
      console.error = originalError;
    }
    const marker = output.find((line) => line.startsWith("[bifrost-json] "));
    assert.ok(marker, `inspect returned no JSON summary: ${output.join("\n")}`);
    return JSON.parse(marker.slice("[bifrost-json] ".length));
  };
  return {
    ctx, inspect, selected, branch,
    async routeTurn({ userId, assistantId, text, randomValue }) {
      const userMessage = { role: "user", content: [{ type: "text", text }] };
      branch.push({ type: "message", id: userId, parentId: branch.at(-1)?.id ?? "root", timestamp: new Date().toISOString(), message: userMessage });
      Math.random = () => randomValue;
      const result = await routeDefinition.route({ model: autoModel, reason: "user", thinkingLevel: "low", messages: [userMessage] }, ctx);
      const model = `${result.model.provider}/${result.model.id}`;
      selected.push(model);
      const assistant = { role: "assistant", content: [], api: result.model.api, provider: result.model.provider, model: result.model.id, stopReason: "stop", timestamp: Date.now() };
      branch.push({ type: "message", id: assistantId, parentId: userId, timestamp: new Date().toISOString(), message: assistant });
      await handlers.get("turn_end")?.({ messageEntryId: assistantId, message: assistant }, ctx);
      await handlers.get("agent_settled")?.({}, ctx);
      return model;
    },
    async beforeTree() { await handlers.get("session_before_tree")?.({}, ctx); },
    restore: () => { Math.random = originalRandom; },
    cleanup: () => {
      Math.random = originalRandom;
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// ── Isolated source copy (for the controlled fault) ────────────────────────

function createIsolatedCopy(prefix) {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of readdirSync(ROOT)) {
    if (["node_modules", "routing.ts"].includes(entry)) continue;
    symlinkSync(join(ROOT, entry), join(scratch, entry));
  }
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
  cpSync(join(ROOT, "routing.ts"), join(scratch, "routing.ts"));
  return scratch;
}

describe("G06 affinity policy acceptance", { timeout: 60_000 }, () => {
  const a = makeModel("fixture", "a");
  const b = makeModel("fixture", "b");

  it("retains an eligible same-tier anchor over the strategy winner", () => {
    const { resolution, draws } = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ models: { quick: ["fixture/a", "fixture/b"] } }),
      available: [a, b],
      anchor: anchorFor("fixture/a"),
      randomValue: 0.9,
    });
    const oracle = affinityOracle({ mode: "retain-within-tier", pool: ["fixture/a", "fixture/b"], anchorKey: "fixture/a", strategy: "random", randomValue: 0.9 });
    const observation = resolution.affinityObservation;
    assert.equal(observation.strategyWinner, oracle.strategyWinner);
    assert.equal(observation.selection, oracle.selection);
    assert.equal(observation.selectedModel, oracle.selected);
    assert.equal(`${resolution.selected.provider}/${resolution.selected.id}`, "fixture/a");
    assert.equal(draws.length, 1, "retention still consumes exactly one strategy draw");
  });

  it("off and observe modes both follow the strategy RNG outcome unchanged", () => {
    const pool = ["fixture/a", "fixture/b"];
    const oracle = affinityOracle({ mode: "observe", pool, anchorKey: "fixture/a", strategy: "random", randomValue: 0.9 });
    const observed = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ mode: "observe", models: { quick: pool } }),
      available: [a, b],
      anchor: anchorFor("fixture/a"),
      mode: "observe",
      randomValue: 0.9,
    });
    const off = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ mode: "off", models: { quick: pool } }),
      available: [a, b],
      anchor: anchorFor("fixture/a"),
      mode: "off",
      randomValue: 0.9,
    });
    assert.equal(observed.resolution.affinityObservation.mode, "observe");
    assert.equal(observed.resolution.affinityObservation.selection, "strategy");
    assert.equal(off.resolution.affinityObservation.mode, "off");
    assert.equal(off.resolution.affinityObservation.selection, "not_applicable");
    assert.equal(observed.resolution.affinityObservation.selectedModel, oracle.selected, "observe mode must not retain the anchor");
    const observedModel = `${observed.resolution.selected.provider}/${observed.resolution.selected.id}`;
    const offModel = `${off.resolution.selected.provider}/${off.resolution.selected.id}`;
    assert.equal(observedModel, oracle.selected);
    assert.equal(offModel, oracle.selected);
    assert.equal(observedModel, offModel, "observe and off must agree on the strategy outcome");
    assert.deepEqual(observed.draws, off.draws, "observe mode must leave the RNG draw sequence unchanged");
  });

  it("does not retain a quick-tier anchor for another tier or explicit tier/model and pinned origins", () => {
    const c = makeModel("fixture", "c");
    const d = makeModel("fixture", "d");
    const otherTier = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ models: { quick: ["fixture/a", "fixture/b"], frontier: ["fixture/c", "fixture/d"] } }),
      available: [a, b, c, d],
      tier: "frontier",
      anchor: anchorFor("fixture/a"),
      randomValue: 0.9,
    });
    assert.equal(otherTier.resolution.affinityObservation.selection, "anchor_not_eligible");
    assert.equal(otherTier.resolution.affinityObservation.selectedModel, "fixture/d");
    const explicit = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ models: { quick: ["fixture/a", "fixture/b"] } }),
      available: [a, b],
      anchor: anchorFor("fixture/a"),
      origin: "explicit_tier",
      mode: "retain-within-tier",
      randomValue: 0.9,
    });
    assert.equal(explicit.resolution.affinityObservation.selection, "not_applicable");
    assert.equal(explicit.resolution.affinityObservation.selectedModel, "fixture/b");
    const explicitModel = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ models: { quick: ["fixture/a", "fixture/b"] } }),
      available: [a, b],
      anchor: anchorFor("fixture/a"),
      origin: "explicit_model",
      tier: "fixture/b",
      randomValue: 0.9,
    });
    assert.equal(explicitModel.resolution.affinityObservation.selection, "not_applicable");
    assert.equal(explicitModel.resolution.affinityObservation.selectedModel, "fixture/b");
    const pinned = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ models: { quick: ["fixture/a", "fixture/b"] } }),
      available: [a, b],
      anchor: anchorFor("fixture/a"),
      origin: "pinned",
      mode: "retain-within-tier",
      randomValue: 0.9,
    });
    assert.equal(pinned.resolution.affinityObservation.selection, "not_applicable");
  });

  it("hard-excludes an anchor that leaves the eligible pool", () => {
    const { observation, summary } = assertHardExcludedAnchor({ resolveConfiguredTier }, { available: [a, b] });
    assert.equal(observation.selection, "anchor_not_eligible");
    assert.deepEqual(summary.requested.candidates.find((entry) => entry.model === "fixture/a")?.exclusion, "open_circuit");
  });

  it("drops the anchor after a branch reset and falls back to strategy", () => {
    const { resolution } = resolve({ resolveConfiguredTier }, {
      config: resolverConfig({ models: { quick: ["fixture/a", "fixture/b"] } }),
      available: [a, b],
      mode: "retain-within-tier",
      randomValue: 0.9,
    });
    assert.equal(resolution.affinityObservation.status, "locality_unknown");
    assert.equal(resolution.affinityObservation.selection, "no_anchor");
    assert.equal(resolution.affinityObservation.selectedModel, "fixture/b");
  });

  it("resets the Auto adapter anchor on a branch change and then routes from strategy", async () => {
    const config = {
      schemaVersion: 2, enabled: true, default: "quick", strategy: "random",
      classifier: { enabled: false }, models: { quick: ["fixture/a", "fixture/b"] },
      affinity: { mode: "retain-within-tier" }, reliability: { stateVersion: 1 },
    };
    const harness = makeAdapterHarness(config, [a, b]);
    try {
      assert.equal(await harness.routeTurn({ userId: "u1", assistantId: "s1", text: "first", randomValue: 0 }), "fixture/a");
      const anchored = await harness.inspect();
      assert.equal(anchored.affinity?.status, "anchored");
      assert.equal(anchored.affinity?.anchor?.model, "fixture/a");
      await harness.beforeTree();
      const reset = await harness.inspect();
      assert.equal(reset.affinity?.status, "locality_unknown", "fork/reset must drop the proven anchor");
      assert.equal(await harness.routeTurn({ userId: "u2", assistantId: "s2", text: "after reset", randomValue: 0.9 }), "fixture/b",
        "a new branch must route from the strategy winner instead of the discarded anchor");
    } finally {
      harness.restore();
      harness.cleanup();
    }
  });

  it("fails the named hard-exclusion assertion under a hard-filter-bypass fault in an isolated copy", async () => {
    const pristineIndex = readFileSync(join(ROOT, "index.ts"), "utf8");
    const pristineRouting = readFileSync(join(ROOT, "routing.ts"), "utf8");
    assert.equal(sha256(pristineIndex), PRODUCTION_INDEX_SHA256, "the committed index.ts must start at its baseline hash");
    const pristineScratch = createIsolatedCopy("bifrost-g06-affinity-pristine-");
    const mutantScratch = createIsolatedCopy("bifrost-g06-affinity-mutant-");
    try {
      // GREEN: the pristine copy must satisfy the same named assertion.
      const pristineRoutingModule = await import(pathToFileURL(join(pristineScratch, "routing.ts")).href);
      assertHardExcludedAnchor(pristineRoutingModule, { available: [a, b] });

      // MUTATE: retained-anchor lookup falls back to the unfiltered candidate list.
      const mutantRouting = pristineRouting.replace(SELECTION_CANDIDATES_GUARD, SELECTION_CANDIDATES_MUTANT);
      assert.notEqual(mutantRouting, pristineRouting, "the selectionCandidates guard anchor must exist in routing.ts");
      writeFileSync(join(mutantScratch, "routing.ts"), mutantRouting);
      assert.notEqual(sha256(mutantRouting), sha256(pristineRouting), "the mutant source must differ from the pristine source");

      // RED: a fresh module graph must fail the named assertion meaningfully.
      const mutantRoutingModule = await import(pathToFileURL(join(mutantScratch, "routing.ts")).href);
      assert.throws(
        () => assertHardExcludedAnchor(mutantRoutingModule, { available: [a, b] }),
        (error) => error?.name === "AssertionError" && /hard-excluded anchor must not be retained/.test(String(error.message)),
        "a bypassed hard filter must fail the named hard-exclusion assertion with an AssertionError, not a startup or syntax error",
      );

      // RESTORE: the mutant scratch copy returns to the pristine bytes.
      writeFileSync(join(mutantScratch, "routing.ts"), pristineRouting);
      assert.equal(sha256(readFileSync(join(mutantScratch, "routing.ts"), "utf8")), sha256(pristineRouting));
    } finally {
      rmSync(pristineScratch, { recursive: true, force: true });
      rmSync(mutantScratch, { recursive: true, force: true });
    }
    assert.equal(sha256(readFileSync(join(ROOT, "index.ts"), "utf8")), PRODUCTION_INDEX_SHA256, "the committed index.ts must be untouched");
    assert.equal(sha256(readFileSync(join(ROOT, "routing.ts"), "utf8")), sha256(pristineRouting));
  });
});
