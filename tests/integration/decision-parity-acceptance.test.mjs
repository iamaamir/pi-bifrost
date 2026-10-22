import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const require = createRequire(import.meta.url);
const temporary = [];
let server;
let serverPort;

function model(id) {
  return { id, name: id, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } };
}

function startProvider() {
  server = spawn(process.execPath, [join(ROOT, "scripts", "fake-provider-server.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("fake provider did not start")), 10_000);
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        serverPort = ready.port;
        clearTimeout(timeout);
        resolve();
      } catch { /* wait for the startup line */ }
    });
    server.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function providerEnvironment(home, workspace) {
  const inherited = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return {
    ...inherited,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${serverPort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(workspace, "network-violations.log"),
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
  };
}

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), "bifrost-parity-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "bifrost-parity-work-"));
  temporary.push(home, workspace);
  const agent = join(home, ".pi", "agent");
  const project = join(workspace, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  const catalog = [model("circuit"), model("ready"), model("general")];
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${serverPort}/v1`, api: "openai-completions", apiKey: "synthetic-only", models: catalog,
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  const now = Date.now();
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "general",
    strategy: "first",
    categoryStrategies: { quick: "first", general: "first", locked: "first" },
    models: { quick: ["fake/circuit"], general: ["fake/ready"], locked: ["fake/circuit"] },
    tierPolicies: { quick: { fallbackTiers: ["general"] }, locked: { fallbackTiers: [] } },
    rules: [
      { pattern: "parity-fallback", model: "quick" },
      { pattern: "parity-no-route", model: "locked" },
    ],
    classifier: { enabled: false },
    affinity: { mode: "off" },
    reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 30 },
    debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
  };
  writeFileSync(join(project, "bifrost.json"), JSON.stringify(config));
  const reliabilityState = { version: 1, models: {
    "fake/circuit": { failures: [now - 1000], openUntil: now + 600_000, trialActive: false },
  } };
  writeFileSync(join(project, "bifrost-reliability.json"), JSON.stringify(reliabilityState));
  const models = catalog.map(({ id, cost, contextWindow, virtual }) => ({
    provider: "fake", id, cost: { input: cost.input, output: cost.output }, contextWindow, ...(virtual ? { virtual } : {}),
  }));
  return { home, workspace, project, config, now, models, reliabilityState };
}

function runPi(fixture, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", join(ROOT, "index.ts"), "--approve", "--no-tools", "--no-session", "--model", "fake/ready", "-p", prompt], {
      cwd: fixture.workspace,
      env: providerEnvironment(fixture.home, fixture.workspace),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      let violations = "";
      try { violations = readFileSync(join(fixture.workspace, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") { reject(error); return; } }
      resolve({ code, stdout, stderr, violations });
    });
  });
}

function readRuntimeDecision(fixture) {
  const path = join(fixture.workspace, ".pi", "bifrost-debug.jsonl");
  const entries = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return entries.filter((entry) => entry.module === "input" && entry.event === "route_decision")
    .map((entry) => entry.decision).at(-1);
}

function readPreviewDecision(output) {
  const line = `${output.stderr}\n${output.stdout}`.split("\n").find((value) => value.startsWith("[bifrost-json] "));
  assert.ok(line, `preview did not return a JSON summary: ${output.stderr}`);
  return JSON.parse(line.slice("[bifrost-json] ".length));
}

function semanticProjection(decision) {
  const pool = (value) => value && ({
    tier: value.tier,
    strategy: value.strategy,
    patterns: value.patterns,
    candidates: value.candidates.map(({ model: key, status, exclusion, exclusionEvidence }) => ({
      model: key, status, exclusion: exclusion ?? null, exclusionEvidence: exclusionEvidence ?? [],
    })),
  });
  return {
    outcome: decision.outcome,
    classifiedTier: decision.classification?.tier ?? null,
    requested: pool(decision.requested) ?? null,
    fallback: pool(decision.fallback) ?? null,
    attempted: decision.attempted?.map(pool) ?? null,
    explicitBoundary: decision.explicitBoundary ?? false,
    selectedTier: decision.selectedTier ?? null,
    selected: decision.selected ?? null,
    selectedStrategy: decision.selectedStrategy ?? null,
    fallbackReason: decision.fallbackReason ?? null,
  };
}

function candidateProjection(candidate) {
  return {
    model: candidate.model,
    status: candidate.status,
    exclusion: candidate.exclusion ?? null,
    exclusionEvidence: candidate.exclusionEvidence ?? [],
    reserve: candidate.reserve
      ? {
        disposition: candidate.reserve.disposition,
        wouldReject: candidate.reserve.wouldReject,
        reasons: candidate.reserve.reasons,
      }
      : null,
  };
}

function poolProjection(pool) {
  if (!pool) return null;
  return {
    tier: pool.tier,
    strategy: pool.strategy,
    patterns: pool.patterns,
    candidates: pool.candidates.map(candidateProjection),
    billingPreference: pool.billingPreference ?? null,
  };
}

/** Parity projection that adds per-candidate reserve evidence to the shared summary. */
function economicProjection(decision) {
  return {
    outcome: decision.outcome,
    classifiedTier: decision.classification?.tier ?? null,
    requested: poolProjection(decision.requested),
    fallback: poolProjection(decision.fallback),
    attempted: decision.attempted?.map(poolProjection) ?? null,
    explicitBoundary: decision.explicitBoundary ?? false,
    selectedTier: decision.selectedTier ?? null,
    selected: decision.selected ?? null,
    selectedStrategy: decision.selectedStrategy ?? null,
    fallbackReason: decision.fallbackReason ?? null,
  };
}

/** Parity projection for affinity observations. `modeSource` and `snapshotAsOf` are
 * adapter-local metadata (the Pi adapter reports `config`; the pure API does not) and
 * are deliberately excluded so the routing semantics can be compared directly. */
function affinityProjection(decision) {
  const affinity = decision.affinity ?? null;
  return {
    ...semanticProjection(decision),
    affinity: affinity ? {
      mode: affinity.mode,
      status: affinity.status,
      selection: affinity.selection,
      strategyWinner: affinity.strategyWinner ?? null,
      selectedModel: affinity.selectedModel ?? null,
      selectedTier: affinity.selectedTier ?? null,
      baseStrategyComparison: affinity.baseStrategyComparison ?? null,
      anchorModel: affinity.anchor?.modelKey ?? null,
    } : null,
  };
}

function economyCatalog() {
  return [model("ready"), model("alpha"), model("beta")];
}

function writeEconomyRegistry(agent, catalog) {
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${serverPort}/v1`, api: "openai-completions", apiKey: "synthetic-only", models: catalog,
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
}

function routerModels(catalog) {
  return catalog.map(({ id, cost, contextWindow }) => ({
    provider: "fake", id, cost: { input: cost.input, output: cost.output }, contextWindow,
  }));
}

/** Runtime config, packed-API economic snapshot, and registry built from one source so
 * all three surfaces evaluate the same reserve facts without a production-derived oracle. */
function createEconomicFixture({ mode = "policy", remaining = 0.1 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-parity-econ-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "bifrost-parity-econ-work-"));
  temporary.push(home, workspace);
  const agent = join(home, ".pi", "agent");
  const project = join(workspace, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  const catalog = economyCatalog();
  writeEconomyRegistry(agent, catalog);
  const now = Date.now();
  const observation = {
    sourceId: "synthetic", scopeRef: "quota", billing: "metered",
    observedAt: now - 1, expiresAt: now + 600_000, revision: 1,
    windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining }],
  };
  const scope = { kind: "model", model: "fake/alpha" };
  const sources = [{ id: "synthetic", scopeRef: "quota", authority: "declared" }];
  const admission = [{ id: "daily", scopeRef: "quota", windowId: "day", reserveRatio: 0.2, unknown: "block" }];
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "fallback",
    strategy: "first",
    models: { primary: ["fake/alpha"], fallback: ["fake/beta"] },
    rules: [{ pattern: "parity-economics", model: "primary" }],
    classifier: { enabled: false },
    affinity: { mode: "off" },
    reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 30 },
    economics: { mode, scopes: { quota: scope }, sources, admission, observations: [observation] },
    debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
  };
  writeFileSync(join(project, "bifrost.json"), JSON.stringify(config));
  return {
    home, workspace, project, config, now,
    models: routerModels(catalog),
    apiEconomic: {
      policy: { mode, scopes: { quota: scope }, sources, admission },
      snapshot: {
        revision: 1,
        signals: [observation],
        watermarks: [{ sourceId: "synthetic", scopeRef: "quota", windowId: "day", periodId: "p1", periodSequence: 1, revision: 1 }],
      },
    },
  };
}

function createAffinityFixture(mode = "observe") {
  const home = mkdtempSync(join(tmpdir(), "bifrost-parity-affinity-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "bifrost-parity-affinity-work-"));
  temporary.push(home, workspace);
  const agent = join(home, ".pi", "agent");
  const project = join(workspace, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  const catalog = economyCatalog();
  writeEconomyRegistry(agent, catalog);
  const config = {
    schemaVersion: 2,
    enabled: true,
    default: "primary",
    strategy: "first",
    models: { primary: ["fake/alpha", "fake/beta"] },
    rules: [{ pattern: "parity-affinity", model: "primary" }],
    classifier: { enabled: false },
    affinity: { mode },
    reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 30 },
    debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
  };
  writeFileSync(join(project, "bifrost.json"), JSON.stringify(config));
  return { home, workspace, project, config, now: Date.now(), models: routerModels(catalog) };
}

function apiClientConfig(config) {
  const { enabled, debug, economics, ...routerConfig } = config;
  return routerConfig;
}

/** Independent reserve facts for API-direct cases: the caller names the model
 * scope and remaining ratio so the expected outcome is chosen, not derived from
 * any production path. */
function economicReserveFor(model, remaining, now, reserveRatio = 0.5) {
  return {
    policy: {
      mode: "policy",
      scopes: { quota: { kind: "model", model } },
      sources: [{ id: "synthetic", scopeRef: "quota", authority: "declared" }],
      admission: [{ id: "daily", scopeRef: "quota", windowId: "day", reserveRatio, unknown: "block" }],
    },
    snapshot: {
      revision: 1,
      signals: [{
        sourceId: "synthetic", scopeRef: "quota", billing: "metered",
        observedAt: now - 1, expiresAt: now + 600_000, revision: 1,
        windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining }],
      }],
      watermarks: [{ sourceId: "synthetic", scopeRef: "quota", windowId: "day", periodId: "p1", periodSequence: 1, revision: 1 }],
    },
  };
}

/** Resolve the installed packed API for a fixture, optionally with extra snapshot
 * sections (economic/affinity) or router options, and require a completed result. */
async function resolveInstalledApi(createRouter, fixture, prompt, snapshot = {}, options) {
  const router = createRouter({
    config: apiClientConfig(fixture.config),
    registry: { knownModels: fixture.models, availableModels: fixture.models },
    now: fixture.now,
    ...snapshot,
  }, options);
  const result = await router.resolve({ prompt });
  assert.equal(result.status, "completed", `installed API did not complete: ${JSON.stringify(result)}`);
  if (result.status !== "completed") throw new Error("installed API returned an aborted result");
  return result.decision;
}

/** Poll a predicate across event-loop turns. */
async function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function linkInstalledDependencies(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "pi-bifrost") continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.name.startsWith("@")) {
      mkdirSync(destinationPath, { recursive: true });
      for (const scoped of readdirSync(sourcePath)) symlinkSync(join(sourcePath, scoped), join(destinationPath, scoped), "dir");
    } else symlinkSync(sourcePath, destinationPath, "dir");
  }
}

function installPackedRouter() {
  const temp = mkdtempSync(join(tmpdir(), "bifrost-parity-package-"));
  temporary.push(temp);
  const cache = join(temp, "npm-cache");
  const consumer = join(temp, "consumer");
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--cache", cache, "--pack-destination", temp], {
    cwd: ROOT, encoding: "utf8", timeout: 90_000,
  }))[0];
  mkdirSync(consumer);
  execFileSync("npm", ["install", "--prefix", consumer, "--cache", cache, "--offline", "--ignore-scripts",
    "--legacy-peer-deps", "--no-audit", "--no-fund", join(temp, packed.filename)], {
    cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 90_000,
  });
  const modules = join(consumer, "node_modules");
  linkInstalledDependencies(join(ROOT, "node_modules"), modules);
  const entry = join(modules, "pi-bifrost", "dist", "router", "router.js");
  assert.ok(existsSync(entry), "the installed archive must contain its resolve-only API entry");
  return pathToFileURL(entry).href;
}

async function apiDecision(fixture, createRouter) {
  const { enabled, debug, ...routerConfig } = fixture.config;
  const snapshot = {
    config: routerConfig,
    registry: { knownModels: fixture.models, availableModels: fixture.models },
    reliabilityState: fixture.reliabilityState,
    now: fixture.now,
  };
  const router = createRouter(snapshot);
  const fallback = await router.resolve({ prompt: "parity-fallback task" });
  const noRoute = await router.resolve({ prompt: "parity-no-route task" });
  assert.equal(fallback.status, "completed");
  assert.equal(noRoute.status, "completed");
  if (fallback.status !== "completed" || noRoute.status !== "completed") throw new Error("API returned an aborted parity result");
  return { fallback: fallback.decision, noRoute: noRoute.decision };
}

describe("runtime, preview, and installed router semantic parity", { concurrency: 1, timeout: 180_000 }, () => {
  let routerModule;
  before(async () => {
    await startProvider();
    const path = installPackedRouter();
    routerModule = await import(path);
  });
  after(async () => {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("close", resolve));
    }
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
  });

  it("keeps selected, excluded, fallback, and no-route decisions aligned across all three surfaces", async () => {
    const fixture = createFixture();
    const api = await apiDecision(fixture, routerModule.createRouter);
    const before = await fetch(`http://127.0.0.1:${serverPort}/_stats`).then((response) => response.json());
    const runtimeFallbackRun = await runPi(fixture, "parity-fallback task");
    assert.equal(runtimeFallbackRun.code, 0, runtimeFallbackRun.stderr);
    assert.equal(runtimeFallbackRun.violations, "");
    const runtimeFallback = readRuntimeDecision(fixture);
    const previewFallbackRun = await runPi(fixture, "/bifrost preview --offline --trace --json parity-fallback task");
    assert.equal(previewFallbackRun.code, 0, previewFallbackRun.stderr);
    assert.equal(previewFallbackRun.violations, "");
    const previewFallback = readPreviewDecision(previewFallbackRun);
    const previewTextRun = await runPi(fixture, "/bifrost preview --offline --trace parity-fallback task");
    assert.equal(previewTextRun.code, 0, previewTextRun.stderr);
    assert.match(`${previewTextRun.stderr}\n${previewTextRun.stdout}`, /evidence: open_circuit from reliability_state/);

    const runtimeNoRouteRun = await runPi(fixture, "parity-no-route task");
    assert.equal(runtimeNoRouteRun.code, 0, runtimeNoRouteRun.stderr);
    assert.equal(runtimeNoRouteRun.violations, "");
    const runtimeNoRoute = readRuntimeDecision(fixture);
    const previewNoRouteRun = await runPi(fixture, "/bifrost preview --offline --trace --json parity-no-route task");
    assert.equal(previewNoRouteRun.code, 0, previewNoRouteRun.stderr);
    assert.equal(previewNoRouteRun.violations, "");
    const previewNoRoute = readPreviewDecision(previewNoRouteRun);
    const after = await fetch(`http://127.0.0.1:${serverPort}/_stats`).then((response) => response.json());
    const generationCalls = after.stats.slice(before.stats.length).filter((item) => item.kind === "generation");

    assert.deepEqual(generationCalls.map((item) => item.model), ["ready"], "only the selected fallback route may generate");
    assert.equal(runtimeFallback.selected, "fake/ready");
    assert.equal(runtimeFallback.requested?.candidates[0]?.exclusion, "open_circuit");
    assert.deepEqual(runtimeFallback.requested?.candidates[0]?.exclusionEvidence, [
      { code: "open_circuit", source: "reliability_state" },
    ]);
    assert.equal(runtimeFallback.fallback?.tier, "general");
    assert.equal(runtimeNoRoute.outcome, "unresolved");

    const surfaces = {
      fallback: {
        runtime: semanticProjection(runtimeFallback),
        preview: semanticProjection(previewFallback),
        api: semanticProjection(api.fallback),
      },
      noRoute: {
        runtime: semanticProjection(runtimeNoRoute),
        preview: semanticProjection(previewNoRoute),
        api: semanticProjection(api.noRoute),
      },
    };
    assert.deepEqual(surfaces.fallback.preview, surfaces.fallback.runtime, "preview and runtime fallback summaries must agree");
    assert.deepEqual(surfaces.fallback.api, surfaces.fallback.runtime, "installed API and runtime fallback summaries must agree");
    assert.deepEqual(surfaces.noRoute.preview, surfaces.noRoute.runtime, "preview and runtime no-route summaries must agree");
    assert.deepEqual(surfaces.noRoute.api, surfaces.noRoute.runtime, "installed API and runtime no-route summaries must agree");

    const artifactRoot = process.env.BIFROST_ACCEPTANCE_ARTIFACT_DIR;
    if (artifactRoot) {
      const directory = join(artifactRoot, "cases", "runtime-preview-router-parity");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "parity.json"), JSON.stringify({
        schemaVersion: 1,
        boundary: "pinned Pi physical runtime debug summary vs pinned Pi offline trace preview vs installed packed resolve-only API",
        config: { tierPolicies: fixture.config.tierPolicies, affinity: "off", economics: "none" },
        registry: { models: fixture.models.map(({ provider, id }) => `${provider}/${id}`), reliabilityState: "synthetic-open-circuit" },
        scenarios: surfaces,
      }, null, 2) + "\n");
    }
  });

  it("aligns active economic reserve decisions across all three surfaces", async () => {
    const cases = [
      {
        name: "a hard reserve rejection excludes the requested tier and falls back",
        mode: "policy", remaining: 0.1,
        selected: "fake/beta", selectedTier: "fallback", fallbackReason: "requested_tier_excluded",
        requested: {
          model: "fake/alpha", status: "excluded", exclusion: "economic_reserve",
          exclusionEvidence: [{ code: "economic_reserve", source: "economic_snapshot" }],
          reserve: { disposition: "rejected", wouldReject: true, reasons: ["reserve_reached"] },
        },
      },
      {
        name: "remaining above the reserve admits the requested model",
        mode: "policy", remaining: 0.9,
        selected: "fake/alpha", selectedTier: "primary", fallbackReason: null,
        requested: {
          model: "fake/alpha", status: "eligible", exclusion: null, exclusionEvidence: [],
          reserve: { disposition: "admitted", wouldReject: false, reasons: ["above_reserve"] },
        },
      },
      {
        name: "observe mode reports the reserve without excluding the model",
        mode: "observe", remaining: 0.1,
        selected: "fake/alpha", selectedTier: "primary", fallbackReason: null,
        requested: {
          model: "fake/alpha", status: "eligible", exclusion: null, exclusionEvidence: [],
          reserve: { disposition: "observed", wouldReject: true, reasons: ["reserve_reached"] },
        },
      },
    ];

    for (const scenario of cases) {
      const fixture = createEconomicFixture({ mode: scenario.mode, remaining: scenario.remaining });
      const api = await resolveInstalledApi(routerModule.createRouter, fixture, "parity-economics task", { economic: fixture.apiEconomic });
      const runtimeRun = await runPi(fixture, "parity-economics task");
      assert.equal(runtimeRun.code, 0, `${scenario.name}: ${runtimeRun.stderr}`);
      assert.equal(runtimeRun.violations, "", `${scenario.name}: runtime must not escape the test network`);
      const runtime = readRuntimeDecision(fixture);
      const previewRun = await runPi(fixture, "/bifrost preview --offline --trace --json parity-economics task");
      assert.equal(previewRun.code, 0, `${scenario.name}: ${previewRun.stderr}`);
      assert.equal(previewRun.violations, "", `${scenario.name}: preview must not escape the test network`);
      const preview = readPreviewDecision(previewRun);

      for (const [surface, decision] of [["runtime", runtime], ["preview", preview], ["api", api]]) {
        const projection = economicProjection(decision);
        assert.equal(projection.selected, scenario.selected, `${scenario.name}: ${surface} selected model`);
        assert.equal(projection.selectedTier, scenario.selectedTier, `${scenario.name}: ${surface} selected tier`);
        assert.equal(projection.fallbackReason ?? null, scenario.fallbackReason, `${scenario.name}: ${surface} fallback reason`);
        assert.deepEqual(
          projection.requested.candidates.find((candidate) => candidate.model === scenario.requested.model),
          scenario.requested,
          `${scenario.name}: ${surface} requested candidate reserve evidence`,
        );
      }
      assert.deepEqual(economicProjection(preview), economicProjection(runtime), `${scenario.name}: preview and runtime economic summaries must agree`);
      assert.deepEqual(economicProjection(api), economicProjection(runtime), `${scenario.name}: installed API and runtime economic summaries must agree`);
    }
  });

  it("aligns affinity observation semantics across all three surfaces without an anchor", async () => {
    const fixture = createAffinityFixture("observe");
    const api = await resolveInstalledApi(routerModule.createRouter, fixture, "parity-affinity task", { affinity: { targetOrigin: "automatic" } });
    const runtimeRun = await runPi(fixture, "parity-affinity task");
    assert.equal(runtimeRun.code, 0, runtimeRun.stderr);
    assert.equal(runtimeRun.violations, "");
    const runtime = readRuntimeDecision(fixture);
    const previewRun = await runPi(fixture, "/bifrost preview --offline --trace --json parity-affinity task");
    assert.equal(previewRun.code, 0, previewRun.stderr);
    assert.equal(previewRun.violations, "");
    const preview = readPreviewDecision(previewRun);

    assert.equal(runtime.selected, "fake/alpha");
    const expectedAffinity = {
      mode: "observe",
      status: "locality_unknown",
      selection: "no_anchor",
      strategyWinner: "fake/alpha",
      selectedModel: "fake/alpha",
      selectedTier: "primary",
      baseStrategyComparison: "no_anchor",
      anchorModel: null,
    };
    assert.deepEqual(affinityProjection(runtime).affinity, expectedAffinity, "runtime affinity observation");
    assert.deepEqual(affinityProjection(preview), affinityProjection(runtime), "preview and runtime affinity summaries must agree");
    assert.deepEqual(affinityProjection(api), affinityProjection(runtime), "installed API and runtime affinity summaries must agree");
  });

  it("retains an eligible anchor and reports a hard-excluded anchor on the installed API", async () => {
    const now = 1_700_000_000_000;
    const models = routerModels(economyCatalog());
    const registry = { knownModels: models, availableModels: models };
    const config = {
      schemaVersion: 2,
      default: "primary",
      strategy: "first",
      models: { primary: ["fake/alpha", "fake/beta"] },
      rules: [{ pattern: "parity-retain", model: "primary" }],
      classifier: { enabled: false },
      affinity: { mode: "retain-within-tier" },
      reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 30 },
    };
    const anchor = { modelKey: "fake/beta", provider: "fake", lastSuccessfulDispatchAt: now - 1000 };

    const retained = await routerModule.createRouter({
      config, registry, now, affinity: { targetOrigin: "automatic", anchor },
    }).resolve({ prompt: "parity-retain task" });
    assert.equal(retained.status, "completed");
    assert.equal(retained.decision.selected, "fake/beta", "an eligible anchor is retained over the strategy winner");
    assert.deepEqual(affinityProjection(retained.decision).affinity, {
      mode: "retain-within-tier",
      status: "current_eligible",
      selection: "retained_anchor",
      strategyWinner: "fake/alpha",
      selectedModel: "fake/beta",
      selectedTier: "primary",
      baseStrategyComparison: "selected_other",
      anchorModel: "fake/beta",
    });

    const excluded = await routerModule.createRouter({
      config, registry, now,
      economic: economicReserveFor("fake/beta", 0.1, now),
      affinity: { targetOrigin: "automatic", anchor },
    }).resolve({ prompt: "parity-retain task" });
    assert.equal(excluded.status, "completed");
    assert.equal(excluded.decision.selected, "fake/alpha", "a hard-excluded anchor is never retained");
    assert.deepEqual(
      economicProjection(excluded.decision).requested.candidates.find((candidate) => candidate.model === "fake/beta"),
      {
        model: "fake/beta", status: "excluded", exclusion: "economic_reserve",
        exclusionEvidence: [{ code: "economic_reserve", source: "economic_snapshot" }],
        reserve: { disposition: "rejected", wouldReject: true, reasons: ["reserve_reached"] },
      },
      "the excluded anchor is reported as a reserve exclusion",
    );
    assert.deepEqual(affinityProjection(excluded.decision).affinity, {
      mode: "retain-within-tier",
      status: "switch_required",
      selection: "anchor_not_eligible",
      strategyWinner: "fake/alpha",
      selectedModel: "fake/alpha",
      selectedTier: "primary",
      baseStrategyComparison: "selected_other",
      anchorModel: "fake/beta",
    });
  });

  it("returns a cancelled envelope with no classifier call before or after cancellation on the installed API", async () => {
    const now = Date.now();
    const models = routerModels([model("alpha")]);
    let classifyCalls = 0;
    const router = routerModule.createRouter({
      config: { models: { primary: ["fake/alpha"] }, default: "primary", rules: [], classifier: { enabled: true } },
      registry: { knownModels: models, availableModels: models },
      now,
    }, {
      networkClassifierGrant: true,
      networkClassifier: { classify: () => { classifyCalls += 1; return new Promise(() => {}); } },
    });

    const preAborted = new AbortController();
    preAborted.abort();
    const preResult = await router.resolve({ prompt: "parity-cancel pre-aborted", signal: preAborted.signal });
    assert.deepEqual(preResult, { version: 1, status: "aborted", asOf: now }, "a pre-aborted request returns the aborted envelope");
    assert.equal(classifyCalls, 0, "a pre-aborted request never starts the classifier");

    const controller = new AbortController();
    const pending = router.resolve({ prompt: "parity-cancel while pending", signal: controller.signal });
    await waitFor(() => classifyCalls === 1);
    controller.abort();
    const cancelled = await pending;
    assert.deepEqual(cancelled, { version: 1, status: "aborted", asOf: now }, "cancelling a pending classify returns the aborted envelope");
    assert.equal(classifyCalls, 1, "cancellation must not start another classifier call");

    const after = await router.resolve({ prompt: "parity-cancel after cancellation", signal: preAborted.signal });
    assert.deepEqual(after, { version: 1, status: "aborted", asOf: now });
    assert.equal(classifyCalls, 1, "a cancelled router holds no post-cancel classifier work");
  });
});
