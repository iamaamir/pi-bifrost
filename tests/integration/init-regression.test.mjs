import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PUBLIC_INIT_DEFAULTS } from "../../config.ts";
import { loadConfigForReload } from "../../config-load.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let server;
let requests;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startFakeProvider() {
  requests = [];
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: "healthy" }, { id: "credits-exhausted" }] });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, {});
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const model = JSON.parse(body).model;
      requests.push(model);
      if (model === "timeout") return;
      if (model === "credits-exhausted") {
        return json(response, 402, { error: { message: "No remaining credits" } });
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "general" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function fixture(port, models, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-init-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-init-work-"));
  const extensionDir = join(home, "extension");
  mkdirSync(extensionDir, { recursive: true });
  for (const entry of readdirSync(ROOT)) {
    if ([".git", "node_modules", "index.ts", "bifrost.json"].includes(entry)) continue;
    symlinkSync(join(ROOT, entry), join(extensionDir, entry));
  }
  symlinkSync(join(ROOT, "node_modules"), join(extensionDir, "node_modules"));
  copyFileSync(EXTENSION, join(extensionDir, "index.ts"));
  writeFileSync(join(extensionDir, "bifrost.json"), JSON.stringify({
    $schema: "./schema.json",
    ...BUNDLED_PUBLIC_INIT_DEFAULTS,
    models: { quick: [], general: [], frontier: [] },
    ...(options.probe ? { probe: options.probe } : {}),
  }));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: models.map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 512 })),
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  return { home, work, extensionPath: join(extensionDir, "index.ts") };
}

function ownership(generated) {
  const sourceId = `pi-models-v1-${createHash("sha256").update(JSON.stringify(["fake", "quick"])).digest("hex").slice(0, 40)}`;
  return JSON.stringify({ version: 1, sources: { [sourceId]: { generated: { quick: generated }, tombstones: {} } } });
}

function runInit({ home, work, args, extensionPath = EXTENSION, prompt = `/bifrost init ${args}` }) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", extensionPath, "--approve", "--no-tools", "--no-session", "-p", prompt], {
      cwd: work,
      env: { ...base, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1",
        NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`, BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
        ...(process.env.BIFROST_ACCEPTANCE_EVENTS ? { BIFROST_ACCEPTANCE_EVENTS: process.env.BIFROST_ACCEPTANCE_EVENTS } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killTimer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      const timedOut = Boolean(killTimer);
      clearTimeout(timer);
      clearTimeout(killTimer);
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") { reject(error); return; } }
      resolve({ code, stdout, stderr, violations, timedOut });
    });
  });
}

function globalPrivateSettings(revision = "BEFORE") {
  return {
    classifier: {
      enabled: true,
      backend: "prompt",
      model: "fake/healthy",
      endpoint: `https://${revision.toLowerCase()}.private-endpoint.invalid`,
      systemPrompt: `${revision}_SYSTEM_PROMPT_CANARY`,
      criteria: { general: `${revision}_CRITERIA_CANARY` },
      privateSetting: `${revision}_CLASSIFIER_UNKNOWN_CANARY`,
    },
    cache: { enabled: false, maxEntries: revision === "BEFORE" ? 17 : 23, threshold: revision === "BEFORE" ? 0.1 : 0.2 },
    reliability: { failureThreshold: revision === "BEFORE" ? 19 : 23, windowMinutes: 47, cooldownMinutes: 91 },
    rules: [{ pattern: `${revision}_RULE_CANARY`, model: "general" }],
  };
}

async function assertInheritedSettingsMatrixCase(port, args, targetKind) {
  requests = [];
  const env = fixture(port, ["healthy", "credits-exhausted"]);
  const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
  const targetPath = join(env.work, ".pi", "bifrost.json");
  const ownershipPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
  const probePath = join(env.work, ".pi", "bifrost-probe.json");
  const globalBytes = targetKind === "absent" ? null : Buffer.from(JSON.stringify(globalPrivateSettings()));
  if (globalBytes) writeFileSync(globalPath, globalBytes);
  if (targetKind === "empty") writeFileSync(targetPath, "{}\n");
  if (targetKind === "owned") {
    writeFileSync(targetPath, JSON.stringify({ models: { quick: ["fake/healthy"] }, targetPrivateSetting: "KEEP_TARGET_CANARY" }));
    writeFileSync(ownershipPath, ownership(["fake/healthy"]));
    writeFileSync(probePath, JSON.stringify([
      { provider: "fake", model: "healthy", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
    ]));
    const recent = new Date(Date.now() - 60_000);
    utimesSync(probePath, recent, recent);
  }
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(env.home, ".pi", "agent");
  try {
    const result = await runInit({ ...env, args });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.violations, "");
    assert.equal(existsSync(targetPath), true, `${args} should write the selected project source`);
    const saved = JSON.parse(readFileSync(targetPath, "utf8"));
    if (targetKind === "absent") {
      assert.equal(existsSync(globalPath), false, `${args} fresh init unexpectedly created a lower global config`);
      assert.equal(saved.classifier?.model, "fake/healthy");
      assert.equal(saved.cache?.enabled, true);
      assert.equal(saved.reliability?.failureThreshold, 3);
      assert.ok(Array.isArray(saved.rules));
    } else {
      for (const key of ["classifier", "cache", "reliability", "rules"]) {
        assert.equal(Object.hasOwn(saved, key), false, `${args} ${targetKind} target pinned inherited ${key}`);
      }
      assert.deepEqual(readFileSync(globalPath), globalBytes, `${args} ${targetKind} init changed the inherited global bytes`);
    }
    if (targetKind === "owned") {
      assert.deepEqual(saved.models, { quick: ["fake/healthy"] });
      assert.equal(saved.targetPrivateSetting, "KEEP_TARGET_CANARY");
      assert.match(result.stdout + result.stderr, /memberships: \+0 \/ -0/, `expected the owned-membership case to exercise settings-only reconciliation: ${JSON.stringify(result)}`);
    }

    const before = loadConfigForReload(env.work, ROOT).config;
    if (targetKind === "absent") {
      assert.equal(before.cache?.enabled, true);
      assert.equal(before.reliability?.failureThreshold, 3);
    } else {
      assert.equal(before.classifier?.systemPrompt, "BEFORE_SYSTEM_PROMPT_CANARY");
      assert.deepEqual(before.classifier?.criteria, { general: "BEFORE_CRITERIA_CANARY" });
      assert.equal(before.classifier?.endpoint, "https://before.private-endpoint.invalid");
      assert.equal(before.classifier?.privateSetting, "BEFORE_CLASSIFIER_UNKNOWN_CANARY");
      assert.deepEqual(before.cache, { enabled: false, maxEntries: 17, threshold: 0.1 });
      assert.equal(before.reliability?.failureThreshold, 19);
      assert.equal(before.rules?.[0]?.pattern, "BEFORE_RULE_CANARY");

      writeFileSync(globalPath, JSON.stringify(globalPrivateSettings("AFTER")));
      const after = loadConfigForReload(env.work, ROOT).config;
      assert.equal(after.classifier?.systemPrompt, "AFTER_SYSTEM_PROMPT_CANARY");
      assert.deepEqual(after.classifier?.criteria, { general: "AFTER_CRITERIA_CANARY" });
      assert.equal(after.classifier?.endpoint, "https://after.private-endpoint.invalid");
      assert.equal(after.classifier?.privateSetting, "AFTER_CLASSIFIER_UNKNOWN_CANARY");
      assert.deepEqual(after.cache, { enabled: false, maxEntries: 23, threshold: 0.2 });
      assert.equal(after.reliability?.failureThreshold, 23);
      assert.equal(after.rules?.[0]?.pattern, "AFTER_RULE_CANARY");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(env.home, { recursive: true, force: true });
    rmSync(env.work, { recursive: true, force: true });
  }
}

describe("Pi init probe regression", { concurrency: 1, timeout: 120_000 }, () => {
  let port;
  before(async () => { port = await startFakeProvider(); });
  after(async () => { await new Promise((resolve) => server?.close(resolve)); });

  it("probes on ordinary init and saves only successful models", async () => {
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    writeFileSync(join(env.work, ".pi", "bifrost-routes.json"), "[]\n");
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "", "Pi attempted a non-fixture network connection");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual([...new Set(requests)], ["healthy", "credits-exhausted"]);
      assert.ok(requests.length >= 2, "expected provider probes for both catalog models");
      assert.equal(requests.filter((model) => model === "credits-exhausted").length, 1, "a provider error must not trigger a second session probe");
      const config = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.ok(Object.values(config.models).flat().includes("fake/healthy"));
      assert.equal(Object.values(config.models).flat().includes("fake/credits-exhausted"), false, JSON.stringify({ requests, stdout: result.stdout, stderr: result.stderr, config }));
      assert.equal(config.cache.threshold, 0.88);
      assert.equal(config.reliability.failureThreshold, 3);
      assert.equal(config.debug.enabled, false);
      assert.equal(config.classifier?.model, "fake/healthy", "fresh init should persist the healthy prompt classifier model with bundled public defaults");
      assert.deepEqual(Object.keys(config.categoryStrategies), Object.keys(config.models));
      requests = [];
      const preview = await runInit({ ...env, args: "", prompt: "/bifrost preview --json a prompt with no local rule" });
      assert.equal(preview.code, 0, preview.stderr);
      assert.equal(preview.violations, "");
      assert.deepEqual(requests, ["healthy"], "ordinary preview should use the classifier model selected by init");
      const report = JSON.parse(preview.stderr.split("[bifrost-json] ").at(-1));
      assert.equal(report.source, "classifier");
      assert.equal(report.model, "fake/healthy");
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("keeps timed-out models out of generated pools when another model succeeds", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "timeout", "credits-exhausted"], { probe: { timeoutMs: 1_000 } });
    try {
      const result = await runInit({ ...env, args: "-f --write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual([...new Set(requests)], ["healthy", "timeout", "credits-exhausted"]);
      const config = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      const savedModels = Object.values(config.models).flat();
      assert.ok(savedModels.includes("fake/healthy"));
      assert.equal(savedModels.includes("fake/timeout"), false);
      assert.equal(savedModels.includes("fake/credits-exhausted"), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("uses a complete recent probe cache on ordinary init and refreshes it on forced init", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    const probePath = join(env.work, ".pi", "bifrost-probe.json");
    try {
      writeFileSync(probePath, JSON.stringify([
        { provider: "fake", model: "healthy", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 8 },
        { provider: "fake", model: "credits-exhausted", status: "error", error: "provider rejected probe", duration_ms: 9 },
      ]));
      const recent = new Date(Date.now() - 60_000);
      utimesSync(probePath, recent, recent);
      const cached = await runInit({ ...env, args: "--write" });
      assert.equal(cached.code, 0, cached.stderr);
      assert.equal(cached.violations, "");
      assert.deepEqual(requests, [], "ordinary init must reuse a complete recent report without new provider requests");
      const configPath = join(env.work, ".pi", "bifrost.json");
      const cachedConfigBytes = readFileSync(configPath);
      const cachedConfig = JSON.parse(cachedConfigBytes);
      assert.ok(Object.values(cachedConfig.models).flat().includes("fake/healthy"));
      assert.equal(Object.values(cachedConfig.models).flat().includes("fake/credits-exhausted"), false);
      if (process.env.BIFROST_ACCEPTANCE_EVENTS) appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify({
        event: "init_cached_results",
        providerRequests: requests.length,
        savedModels: cachedConfig.models,
        savedSha256: createHash("sha256").update(cachedConfigBytes).digest("hex"),
      })}\n`);

      requests = [];
      const forced = await runInit({ ...env, args: "-f --write" });
      assert.equal(forced.code, 0, forced.stderr);
      assert.equal(forced.violations, "");
      assert.deepEqual([...new Set(requests)], ["healthy", "credits-exhausted"], "forced init must disregard even a complete recent cache");
      const forcedBytes = readFileSync(configPath);
      const forcedConfig = JSON.parse(forcedBytes);
      assert.equal(Object.values(forcedConfig.models).flat().includes("fake/credits-exhausted"), false);
      if (process.env.BIFROST_ACCEPTANCE_EVENTS) appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify({
        event: "init_force_ignores_cache",
        providerRequests: requests.length,
        requestCounts: Object.fromEntries([...new Set(requests)].map((model) => [model, requests.filter((item) => item === model).length])),
        savedModels: forcedConfig.models,
        savedSha256: createHash("sha256").update(forcedBytes).digest("hex"),
      })}\n`);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("fills an empty config from verified pools without shadowing its default", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    writeFileSync(join(env.work, ".pi", "bifrost.json"), "{}\n");
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      const config = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.ok(config.models[config.default]?.includes("fake/healthy"));
      assert.equal(Object.values(config.models).flat().includes("fake/credits-exhausted"), false);
      assert.deepEqual(Object.keys(config.categoryStrategies), Object.keys(config.models));
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("persists the detected prompt classifier model on forced fresh init", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    try {
      const result = await runInit({ ...env, args: "-f --write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.deepEqual([...new Set(requests)], ["healthy", "credits-exhausted"]);
      const config = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.equal(config.classifier.model, "fake/healthy");
      assert.equal(Object.values(config.models).flat().includes("fake/credits-exhausted"), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("removes failed generated memberships, keeps handwritten entries and preserves settings", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    const original = Buffer.from(JSON.stringify({
      enabled: true,
      default: "quick",
      strategy: "cheapest",
      classifier: {
        enabled: false,
        endpoint: "https://PROJECT_ENDPOINT_CANARY.invalid",
        systemPrompt: "PROJECT_SYSTEM_PROMPT_CANARY",
        criteria: { general: "keep classifier criteria" },
        projectPrivateSetting: "PROJECT_CLASSIFIER_UNKNOWN_CANARY",
        typesafe: { timeoutMs: 1234, maxAttempts: 2, debug: true, metrics: { enabled: false } },
        piNative: { timeoutMs: 2345, maxAttempts: 2, metrics: { enabled: false } },
      },
      cache: { enabled: false },
      models: { quick: ["fake/credits-exhausted", "handwritten/model"] },
      retained: { owner: "user" },
    }, null, 2) + "\n");
    writeFileSync(join(env.work, ".pi", "bifrost.json"), original);
    writeFileSync(join(env.work, ".pi", "bifrost-reconcile-ownership.json"), ownership(["fake/credits-exhausted"]));
    try {
      const result = await runInit({ ...env, args: "-f --write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.deepEqual(saved.models.quick, ["handwritten/model", "fake/healthy"]);
      assert.equal(saved.cache.enabled, false);
      assert.equal(saved.strategy, "cheapest");
      assert.equal(saved.classifier.endpoint, "https://PROJECT_ENDPOINT_CANARY.invalid");
      assert.equal(saved.classifier.systemPrompt, "PROJECT_SYSTEM_PROMPT_CANARY");
      assert.equal(saved.classifier.projectPrivateSetting, "PROJECT_CLASSIFIER_UNKNOWN_CANARY");
      assert.deepEqual(saved.classifier.criteria, { general: "keep classifier criteria" });
      assert.deepEqual(saved.classifier.typesafe, { timeoutMs: 1234, maxAttempts: 2, debug: true, metrics: { enabled: false } });
      assert.deepEqual(saved.classifier.piNative, { timeoutMs: 2345, maxAttempts: 2, metrics: { enabled: false } });
      assert.deepEqual(saved.retained, { owner: "user" });
      assert.match(result.stdout + result.stderr, /handwritten entries are preserved/u);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("leaves existing config untouched when forced probes have zero successes", async () => {
    requests = [];
    const env = fixture(port, ["credits-exhausted"]);
    const original = Buffer.from('{\n  "enabled": true,\n  "default": "general",\n  "models": { "general": ["handwritten/model"] },\n  "retained": { "owner": "user" }\n}\n');
    writeFileSync(join(env.work, ".pi", "bifrost.json"), original);
    try {
      const result = await runInit({ ...env, args: "-f --write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "", "Pi attempted a non-fixture network connection");
      assert.equal(result.code, 0, result.stderr);
      assert.ok(requests.length > 0 && requests.every((model) => model === "credits-exhausted"));
      assert.deepEqual(readFileSync(join(env.work, ".pi", "bifrost.json")), original);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("does not create config or ownership when a fresh probe has zero successes", async () => {
    requests = [];
    const env = fixture(port, ["credits-exhausted"]);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.ok(requests.length > 0 && requests.every((model) => model === "credits-exhausted"));
      assert.throws(() => readFileSync(join(env.work, ".pi", "bifrost.json")), { code: "ENOENT" });
      assert.throws(() => readFileSync(join(env.work, ".pi", "bifrost-reconcile-ownership.json")), { code: "ENOENT" });
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("does not replace an all-failed fresh probe cache with the full registry", async () => {
    requests = [];
    const env = fixture(port, ["credits-exhausted"]);
    const original = Buffer.from('{"enabled":true,"models":{"general":["handwritten/model"]}}\n');
    writeFileSync(join(env.work, ".pi", "bifrost.json"), original);
    writeFileSync(join(env.work, ".pi", "bifrost-probe.json"), JSON.stringify([
      { provider: "fake", model: "credits-exhausted", status: "error", cost_input: 0, cost_output: 0, duration_ms: 10 },
    ]));
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(requests, []);
      assert.deepEqual(readFileSync(join(env.work, ".pi", "bifrost.json")), original);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("adds public starter defaults when reconciliation has no membership changes", async () => {
    requests = [];
    const env = fixture(port, ["healthy"]);
    const configPath = join(env.work, ".pi", "bifrost.json");
    const ownershipPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
    const probePath = join(env.work, ".pi", "bifrost-probe.json");
    writeFileSync(configPath, JSON.stringify({ models: { quick: ["fake/healthy"] }, selectedPrivate: "KEEP_ME" }));
    writeFileSync(ownershipPath, ownership(["fake/healthy"]));
    writeFileSync(probePath, JSON.stringify([
      { provider: "fake", model: "healthy", status: "ok", cost_input: 0, cost_output: 0, duration_ms: 10 },
    ]));
    const recent = new Date(Date.now() - 60_000);
    utimesSync(probePath, recent, recent);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(saved.models, { quick: ["fake/healthy"] });
      assert.equal(saved.selectedPrivate, "KEEP_ME");
      assert.equal(saved.cache.enabled, true);
      assert.equal(saved.cache.maxEntries, 500);
      assert.equal(saved.cache.threshold, 0.88);
      assert.equal(saved.reliability.failureThreshold, 3);
      assert.equal(saved.debug.enabled, false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("keeps inherited private and nondefault policy out of a new project config", async () => {
    requests = [];
    const env = fixture(port, ["healthy"]);
    const agentConfig = join(env.home, ".pi", "agent", "bifrost.json");
    const projectConfig = join(env.work, ".pi", "bifrost.json");
    writeFileSync(agentConfig, JSON.stringify({
      classifier: {
        enabled: true,
        backend: "prompt",
        model: "fake/healthy",
        endpoint: "https://private-endpoint-canary.invalid",
        systemPrompt: "GLOBAL_SYSTEM_PROMPT_CANARY",
        criteria: { general: "GLOBAL_CRITERIA_CANARY" },
        privateSetting: "GLOBAL_CLASSIFIER_UNKNOWN_CANARY",
      },
      cache: { enabled: false, maxEntries: 17, threshold: 0.1 },
      reliability: { failureThreshold: 19, windowMinutes: 47, cooldownMinutes: 91 },
      rules: [{ pattern: "GLOBAL_RULE_CANARY", model: "general" }],
    }));
    writeFileSync(projectConfig, "{}\n");
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.ok(requests.includes("healthy"));
      const saved = JSON.parse(readFileSync(projectConfig, "utf8"));
      const savedText = JSON.stringify(saved);
      for (const inherited of ["GLOBAL_SYSTEM_PROMPT_CANARY", "GLOBAL_CRITERIA_CANARY", "private-endpoint-canary", "GLOBAL_CLASSIFIER_UNKNOWN_CANARY", "GLOBAL_RULE_CANARY"]) {
        assert.equal(savedText.includes(inherited), false, `project config copied inherited value ${inherited}`);
      }
      for (const inheritedNamespace of ["classifier", "cache", "reliability", "rules"]) {
        assert.equal(Object.hasOwn(saved, inheritedNamespace), false, `project config pinned inherited ${inheritedNamespace}`);
      }

      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(env.home, ".pi", "agent");
      try {
        const inherited = loadConfigForReload(env.work, dirname(env.extensionPath)).config;
        assert.equal(inherited.classifier?.systemPrompt, "GLOBAL_SYSTEM_PROMPT_CANARY");
        assert.deepEqual(inherited.classifier?.criteria, { general: "GLOBAL_CRITERIA_CANARY" });
        assert.equal(inherited.classifier?.endpoint, "https://private-endpoint-canary.invalid");
        assert.equal(inherited.classifier?.privateSetting, "GLOBAL_CLASSIFIER_UNKNOWN_CANARY");
        assert.equal(inherited.cache?.enabled, false);
        assert.equal(inherited.cache?.maxEntries, 17);
        assert.equal(inherited.cache?.threshold, 0.1);
        assert.equal(inherited.reliability?.failureThreshold, 19);
        assert.deepEqual(inherited.rules, [{ pattern: "GLOBAL_RULE_CANARY", model: "general" }]);
        writeFileSync(agentConfig, JSON.stringify({ classifier: {
          enabled: true,
          backend: "prompt",
          model: "fake/healthy",
          endpoint: "https://private-endpoint-canary.invalid",
          systemPrompt: "GLOBAL_SYSTEM_PROMPT_AFTER_EDIT",
          criteria: { general: "GLOBAL_CRITERIA_AFTER_EDIT" },
          privateSetting: "GLOBAL_CLASSIFIER_UNKNOWN_AFTER_EDIT",
        } }));
        assert.equal(loadConfigForReload(env.work, dirname(env.extensionPath)).config.classifier?.systemPrompt, "GLOBAL_SYSTEM_PROMPT_AFTER_EDIT");
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  for (const args of ["--write", "-f --write"]) {
    for (const targetKind of ["absent", "empty", "owned"]) {
      const expectation = targetKind === "absent" ? "creates a fresh public starter" : "preserves inherited private settings";
      it(`${expectation} through ${args} with ${targetKind} target`, async () => {
        await assertInheritedSettingsMatrixCase(port, args, targetKind);
      });
    }
  }
});
