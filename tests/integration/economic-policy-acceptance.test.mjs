// G06 (P1) economic policy acceptance: declared-snapshot reserve matrix.
//
// Boundary: the real Bifrost extension is loaded into this process and driven
// through its registered Pi host hooks (`input`, `bifrost` command) with a
// synthetic registry. This is the registered-handler boundary described by the
// audit, not a full Pi process E2E. Every fact is a declared snapshot in the
// fixture config; expected pools come from the independent oracle below, never
// from production code.
//
// Controlled fault: the final case copies index.ts/routing.ts/economic-signals.ts
// into a private scratch tree, flips the reserve equality guard (`<=` -> `<`)
// there, and proves the named equality assertion turns RED. The committed
// index.ts must stay at its baseline hash.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { makeModel } from "../helpers.ts";
import bifrostExtension from "../../index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRODUCTION_INDEX_SHA256 = "ec4c4da9720ba975d9634cc397458cd4599b5e68a7f1eae67f3964e11a5256bc";
const RESERVE_EQUALITY_GUARD = "remainingRatio <= rule.reserveRatio";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ── Independent allowed-model oracle ───────────────────────────────────────
//
// A small reimplementation of the *declared* reserve semantics. It deliberately
// does not import economic-signals.ts so a production mistake cannot make the
// expectation agree with itself.
//
// facts: Map<modelKey, { fresh: boolean, remainingRatio?: number }>
// Returns Map<modelKey, { status, disposition, reasons }>.
function economicOracle({ mode, reserveRatio, unknown, candidates, facts, scopedKeys }) {
  const result = new Map();
  for (const key of candidates) {
    if (!scopedKeys.has(key)) {
      result.set(key, { status: "eligible", disposition: "no_rules", reasons: [] });
      continue;
    }
    const fact = facts.get(key);
    const reject = Boolean(fact?.fresh && fact.remainingRatio !== undefined && fact.remainingRatio <= reserveRatio);
    if (mode === "observe") {
      result.set(key, { status: "eligible", disposition: "observed", reasons: reject ? ["reserve_reached"] : ["above_reserve"] });
      continue;
    }
    if (!fact?.fresh || fact.remainingRatio === undefined) {
      const reason = fact?.fresh ? "invalid_fact" : "stale_fact";
      result.set(key, unknown === "ignore"
        ? { status: "eligible", disposition: "unknown_ignored", reasons: [reason] }
        : { status: "excluded", disposition: "rejected", reasons: [reason] });
      continue;
    }
    result.set(key, reject
      ? { status: "excluded", disposition: "rejected", reasons: ["reserve_reached"] }
      : { status: "eligible", disposition: "admitted", reasons: ["above_reserve"] });
  }
  return result;
}

// ── Config builders ────────────────────────────────────────────────────────

function baseConfig(economics) {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "restricted",
    strategy: "first",
    classifier: { enabled: false, backend: "prompt" },
    models: { restricted: ["fixture/a"] },
    rules: [{ pattern: "work", model: "restricted" }],
    reliability: { stateVersion: 1, enabled: true },
    ...(economics ? { economics } : {}),
  };
}

function reserveEconomics({ mode = "policy", scopeModel = "fixture/a", reserveRatio = 0.2, unknown = "block", observations, sources = [{ id: "manual", scopeRef: "reserved", authority: "declared" }], admission }) {
  return {
    mode,
    scopes: { reserved: { kind: "model", model: scopeModel } },
    sources,
    admission: admission ?? [{ id: "daily", scopeRef: "reserved", windowId: "day", reserveRatio, unknown }],
    observations,
  };
}

function ratioObservation({ remaining, sourceId = "manual", scopeRef = "reserved", observedAt = Date.now() - 1, expiresAt = Date.now() + 60_000, billing = "metered", periodId = "p1" }) {
  return {
    sourceId, scopeRef, billing, observedAt, expiresAt, revision: 1,
    windows: [{ id: "day", period: { id: periodId, sequence: 1 }, unit: "ratio", remaining }],
  };
}

// ── Harness ────────────────────────────────────────────────────────────────

function makeHarness(config, available, options = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-economic-acceptance-"));
  const agentDir = join(cwd, "agent");
  const projectDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "bifrost.json"), JSON.stringify(config));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const selected = [];
  const notices = [];
  const registry = available;
  const sessionManager = { getHeader: () => ({ id: "economic-acceptance" }), getBranch: () => [] };
  const modelRegistry = {
    getAvailable: () => registry,
    getAll: () => registry,
    find: (provider, id) => registry.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
    getModelsOfType: () => [],
    getModelOfType: () => undefined,
    getAvailableOfType: async () => [],
    refresh: async () => ({ refreshed: [], errors: [] }),
  };
  const ui = {
    setWidget: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
    notify: (message) => { notices.push(String(message)); }, custom: async () => null,
    theme: { fg: (_color, text) => text },
  };
  const active = options.active ?? makeModel("fixture", "active");
  const ctx = { cwd, mode: "rpc", hasUI: false, model: active, modelRegistry, sessionManager, ui, thinkingLevel: "low" };

  let inputHandler;
  let commandHandler;
  const pi = {
    registerVirtualModel: () => {},
    registerCommand: (_name, opts) => {
      if (commandHandler) throw new Error("economic harness registered more than one command");
      commandHandler = opts.handler;
    },
    on: (event, handler) => {
      if (event === "input" && !inputHandler) inputHandler = handler;
      return () => {};
    },
    setModel: async (model) => { selected.push(`${model.provider}/${model.id}`); return true; },
  };
  (options.extension ?? bifrostExtension)(pi);
  if (!inputHandler || !commandHandler) throw new Error("extension did not register the required hooks");

  const preview = async (prompt) => {
    const output = [];
    const originalError = console.error;
    console.error = (...values) => { output.push(values.map(String).join(" ")); };
    try {
      await commandHandler(`preview --trace --json ${prompt}`, ctx);
    } finally {
      console.error = originalError;
    }
    const marker = output.find((line) => line.startsWith("[bifrost-json] "));
    assert.ok(marker, `preview returned no JSON summary: ${output.join("\n")}`);
    return JSON.parse(marker.slice("[bifrost-json] ".length));
  };

  return {
    cwd, ctx, preview, selected, notices,
    run: (text) => inputHandler({ text, source: "interactive", streamingBehavior: "steer" }, ctx),
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function poolByModel(preview) {
  return new Map((preview.requested?.candidates ?? []).map((candidate) => [candidate.model, candidate]));
}

// ── Named assertion shared with the controlled fault ───────────────────────

async function assertReserveEqualityRejects(harness) {
  const preview = await harness.preview("work task");
  assert.equal(preview.outcome, "unresolved", "reserve equality must leave the route unresolved");
  const candidate = poolByModel(preview).get("fixture/a");
  assert.equal(candidate?.status, "excluded", "reserve equality must mark the candidate excluded");
  assert.equal(candidate?.exclusion, "economic_reserve", "reserve equality must report an economic reserve exclusion");
  assert.deepEqual(candidate?.reserve?.reasons, ["reserve_reached"], "reserve equality must report reserve_reached");
  const result = await harness.run("work task");
  assert.deepEqual(result, { action: "handled" }, "reserve equality must handle the turn without dispatching");
  assert.deepEqual(harness.selected, [], "reserve equality must reject before dispatch");
}

// ── Isolated source copy (for the controlled fault) ────────────────────────

function createIsolatedCopy(prefix) {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of readdirSync(ROOT)) {
    if (["node_modules", "index.ts", "routing.ts", "economic-signals.ts"].includes(entry)) continue;
    symlinkSync(join(ROOT, entry), join(scratch, entry));
  }
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
  cpSync(join(ROOT, "index.ts"), join(scratch, "index.ts"));
  cpSync(join(ROOT, "routing.ts"), join(scratch, "routing.ts"));
  cpSync(join(ROOT, "economic-signals.ts"), join(scratch, "economic-signals.ts"));
  return scratch;
}

// ── Network fence ──────────────────────────────────────────────────────────

function withNetworkFence(body) {
  const violations = [];
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  globalThis.fetch = (input) => {
    violations.push(`fetch:${String(input)}`);
    return Promise.reject(new Error("network access is forbidden in economic acceptance"));
  };
  net.Socket.prototype.connect = function patchedConnect(...args) {
    violations.push("socket-connect");
    return originalConnect.apply(this, args);
  };
  const restore = () => {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  };
  return Promise.resolve()
    .then(body)
    .then((value) => { restore(); return { value, violations }; }, (error) => { restore(); throw error; });
}

describe("G06 economic policy acceptance", { timeout: 60_000 }, () => {
  it("dispatches the reserve-positive candidate and records the exact allowed-model set", async () => {
    const config = baseConfig(reserveEconomics({ observations: [ratioObservation({ remaining: 0.5 })] }));
    const a = makeModel("fixture", "a");
    const b = makeModel("fixture", "b");
    config.models.restricted = ["fixture/a", "fixture/b"];
    const harness = makeHarness(config, [a, b]);
    try {
      const oracle = economicOracle({
        mode: "policy", reserveRatio: 0.2, unknown: "block",
        candidates: ["fixture/a", "fixture/b"],
        scopedKeys: new Set(["fixture/a"]),
        facts: new Map([["fixture/a", { fresh: true, remainingRatio: 0.5 }]]),
      });
      const preview = await harness.preview("work task");
      const pool = poolByModel(preview);
      assert.equal(preview.outcome, "selected");
      assert.equal(preview.selected, "fixture/a", "the first declared strategy order selects the reserve-positive candidate");
      assert.equal(pool.get("fixture/a")?.status, oracle.get("fixture/a").status);
      assert.equal(pool.get("fixture/a")?.reserve?.disposition, oracle.get("fixture/a").disposition);
      assert.equal(pool.get("fixture/b")?.status, oracle.get("fixture/b").status);
      const result = await harness.run("work task");
      assert.deepEqual(result, { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/a"]);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a candidate whose remaining ratio equals the reserve ratio", async () => {
    const config = baseConfig(reserveEconomics({ observations: [ratioObservation({ remaining: 0.2 })] }));
    const harness = makeHarness(config, [makeModel("fixture", "a")]);
    try {
      await assertReserveEqualityRejects(harness);
    } finally {
      harness.cleanup();
    }
  });

  it("reports would-reject in observe mode without excluding or blocking the candidate", async () => {
    const config = baseConfig(reserveEconomics({ mode: "observe", observations: [ratioObservation({ remaining: 0.05 })] }));
    const harness = makeHarness(config, [makeModel("fixture", "a")]);
    try {
      const oracle = economicOracle({
        mode: "observe", reserveRatio: 0.2, unknown: "block",
        candidates: ["fixture/a"], scopedKeys: new Set(["fixture/a"]),
        facts: new Map([["fixture/a", { fresh: true, remainingRatio: 0.05 }]]),
      });
      const preview = await harness.preview("work task");
      const candidate = poolByModel(preview).get("fixture/a");
      assert.equal(candidate?.status, "eligible", "observe mode must never exclude a candidate");
      assert.equal(candidate?.exclusion, undefined, "observe mode must not attach a hard exclusion");
      assert.equal(candidate?.reserve?.disposition, oracle.get("fixture/a").disposition);
      assert.equal(candidate?.reserve?.wouldReject, true, "observe mode must still report the would-reject fact");
      assert.deepEqual(candidate?.reserve?.reasons, ["reserve_reached"]);
      const result = await harness.run("work task");
      assert.deepEqual(result, { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/a"], "observe mode must dispatch the candidate it did not exclude");
    } finally {
      harness.cleanup();
    }
  });

  it("treats an expired declared fact as a neutral unknown when unknown is ignore", async () => {
    const now = Date.now();
    const config = baseConfig(reserveEconomics({
      unknown: "ignore",
      observations: [ratioObservation({ remaining: 0.01, observedAt: now - 2_000, expiresAt: now - 1_000 })],
    }));
    const harness = makeHarness(config, [makeModel("fixture", "a")]);
    try {
      const oracle = economicOracle({
        mode: "policy", reserveRatio: 0.2, unknown: "ignore",
        candidates: ["fixture/a"], scopedKeys: new Set(["fixture/a"]),
        facts: new Map([["fixture/a", { fresh: false }]]),
      });
      const preview = await harness.preview("work task");
      const candidate = poolByModel(preview).get("fixture/a");
      assert.equal(candidate?.status, oracle.get("fixture/a").status, "an expired fact with unknown=ignore is neutral");
      assert.equal(candidate?.reserve?.disposition, "unknown_ignored");
      assert.equal(candidate?.reserve?.wouldReject, false);
      assert.deepEqual(candidate?.reserve?.reasons, ["stale_fact"]);
      assert.deepEqual(await harness.run("work task"), { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/a"]);
    } finally {
      harness.cleanup();
    }
  });

  it("treats conflicting declared facts as a neutral unknown when unknown is ignore", async () => {
    const config = baseConfig(reserveEconomics({
      unknown: "ignore",
      sources: [
        { id: "manual-a", scopeRef: "reserved", authority: "declared" },
        { id: "manual-b", scopeRef: "reserved", authority: "declared" },
      ],
      observations: [
        ratioObservation({ remaining: 0.9, sourceId: "manual-a" }),
        ratioObservation({ remaining: 0.1, sourceId: "manual-b" }),
      ],
    }));
    const harness = makeHarness(config, [makeModel("fixture", "a")]);
    try {
      const preview = await harness.preview("work task");
      const candidate = poolByModel(preview).get("fixture/a");
      assert.equal(candidate?.status, "eligible", "an equal-authority conflict with unknown=ignore is neutral");
      assert.equal(candidate?.reserve?.disposition, "unknown_ignored");
      assert.equal(candidate?.reserve?.wouldReject, false);
      assert.deepEqual(candidate?.reserve?.reasons, ["source_conflict"]);
      assert.deepEqual(await harness.run("work task"), { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/a"]);
    } finally {
      harness.cleanup();
    }
  });

  it("makes no hidden quota fetch or external socket while routing and previewing", async () => {
    const config = baseConfig(reserveEconomics({ observations: [ratioObservation({ remaining: 0.5 })] }));
    const harness = makeHarness(config, [makeModel("fixture", "a")]);
    try {
      const { violations } = await withNetworkFence(async () => {
        await harness.preview("work task");
        await harness.run("work task");
      });
      assert.deepEqual(violations, [], "declared economic facts must not trigger a quota fetch or external socket");
      assert.deepEqual(harness.selected, ["fixture/a"]);
    } finally {
      harness.cleanup();
    }
  });

  it("preserves exact callback and dispatch ordering across declared turns", async () => {
    const config = baseConfig(undefined);
    config.models = { quick: ["fixture/q"], deep: ["fixture/d"], other: ["fixture/o"] };
    config.strategy = "first";
    config.default = "quick";
    config.rules = [
      { pattern: "alpha", model: "quick" },
      { pattern: "beta", model: "deep" },
      { pattern: "gamma", model: "other" },
    ];
    const harness = makeHarness(config, [makeModel("fixture", "q"), makeModel("fixture", "d"), makeModel("fixture", "o")]);
    try {
      const declaredOrder = ["fixture/q", "fixture/d", "fixture/o"];
      for (const [index, prompt] of ["alpha turn", "beta turn", "gamma turn"].entries()) {
        assert.deepEqual(await harness.run(prompt), { action: "continue" });
        assert.deepEqual(harness.selected, declaredOrder.slice(0, index + 1), `dispatch order must match the declared order after ${prompt}`);
      }
      assert.deepEqual(harness.selected, declaredOrder);
    } finally {
      harness.cleanup();
    }
  });

  it("fails the named reserve-equality assertion under a hard-filter-bypass fault in an isolated copy", async () => {
    const pristineIndex = readFileSync(join(ROOT, "index.ts"), "utf8");
    const pristineRouting = readFileSync(join(ROOT, "routing.ts"), "utf8");
    const pristineSignals = readFileSync(join(ROOT, "economic-signals.ts"), "utf8");
    assert.equal(sha256(pristineIndex), PRODUCTION_INDEX_SHA256, "the committed index.ts must start at its baseline hash");
    const pristineScratch = createIsolatedCopy("bifrost-g06-economic-pristine-");
    const mutantScratch = createIsolatedCopy("bifrost-g06-economic-mutant-");
    try {
      // GREEN: the pristine copy must satisfy the same named assertion.
      const pristineExtension = (await import(pathToFileURL(join(pristineScratch, "index.ts")).href)).default;
      const pristineHarness = makeHarness(
        baseConfig(reserveEconomics({ observations: [ratioObservation({ remaining: 0.2 })] })),
        [makeModel("fixture", "a")],
        { extension: pristineExtension },
      );
      try {
        await assertReserveEqualityRejects(pristineHarness);
      } finally {
        pristineHarness.cleanup();
      }

      // MUTATE: hard-filter bypass — equality is admitted instead of rejected.
      const mutantSignals = pristineSignals.replace(RESERVE_EQUALITY_GUARD, "remainingRatio < rule.reserveRatio");
      assert.notEqual(mutantSignals, pristineSignals, "the reserve equality guard anchor must exist in economic-signals.ts");
      writeFileSync(join(mutantScratch, "economic-signals.ts"), mutantSignals);
      assert.notEqual(sha256(mutantSignals), sha256(pristineSignals), "the mutant source must differ from the pristine source");

      // RED: a fresh module graph must fail the named assertion meaningfully.
      const mutatedExtension = (await import(pathToFileURL(join(mutantScratch, "index.ts")).href)).default;
      const mutantHarness = makeHarness(
        baseConfig(reserveEconomics({ observations: [ratioObservation({ remaining: 0.2 })] })),
        [makeModel("fixture", "a")],
        { extension: mutatedExtension },
      );
      try {
        await assert.rejects(
          () => assertReserveEqualityRejects(mutantHarness),
          (error) => error?.name === "AssertionError" && /reserve equality must/.test(String(error.message)),
          "the bypassed equality guard must fail a named reserve-equality assertion with an AssertionError, not a startup or syntax error",
        );
      } finally {
        mutantHarness.cleanup();
      }

      // RESTORE: the mutant scratch copy returns to the pristine bytes.
      writeFileSync(join(mutantScratch, "economic-signals.ts"), pristineSignals);
      assert.equal(sha256(readFileSync(join(mutantScratch, "economic-signals.ts"), "utf8")), sha256(pristineSignals));
    } finally {
      rmSync(pristineScratch, { recursive: true, force: true });
      rmSync(mutantScratch, { recursive: true, force: true });
    }
    assert.equal(sha256(readFileSync(join(ROOT, "index.ts"), "utf8")), PRODUCTION_INDEX_SHA256, "the committed index.ts must be untouched");
    assert.equal(sha256(readFileSync(join(ROOT, "routing.ts"), "utf8")), sha256(pristineRouting));
    assert.equal(sha256(readFileSync(join(ROOT, "economic-signals.ts"), "utf8")), sha256(pristineSignals));
  });
});
