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
    candidates: value.candidates.map(({ model: key, status, exclusion }) => ({ model: key, status, exclusion: exclusion ?? null })),
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
});
