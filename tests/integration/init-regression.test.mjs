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
      // The bootstrap save holds only detected tiers, so the canned classifier
      // reply must name a tier that exists in the saved config.
      response.end(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "quick" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
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

function ownership(generated, scope = "project") {
  return JSON.stringify({ version: 2, scope, tiers: { quick: { state: "generated", models: generated } } });
}

const COMMIT_FAULT_PRELOAD = join(ROOT, "tests", "fixtures", "fail-ownership-rename.cjs");

function runInit({ home, work, args, extensionPath = EXTENSION, prompt = `/bifrost init ${args}`, env: extraEnv = {} }) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const preload = extraEnv.BIFROST_TEST_FAIL_OWNERSHIP_RENAME === "1"
    ? `--require=${OUTBOUND_GUARD} --require=${COMMIT_FAULT_PRELOAD}`
    : `--require=${OUTBOUND_GUARD}`;
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", extensionPath, "--approve", "--no-tools", "--no-session", "-p", prompt], {
      cwd: work,
      env: { ...base, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1",
        NODE_OPTIONS: preload, BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
        ...(process.env.BIFROST_ACCEPTANCE_EVENTS ? { BIFROST_ACCEPTANCE_EVENTS: process.env.BIFROST_ACCEPTANCE_EVENTS } : {}),
        ...extraEnv },
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

function runInteractiveInit({ home, work, extensionPath = EXTENSION, confirm, select }) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", extensionPath, "--mode", "rpc", "--no-tools", "--no-session"], {
      cwd: work,
      env: { ...base, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1",
        NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`, BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let incompleteLine = "";
    let records = [];
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = `${incompleteLine}${chunk}`.split("\n");
      incompleteLine = lines.pop();
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          records.push(record);
          if (record.type === "extension_ui_request" && record.method === "confirm") {
            child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: confirm })}\n`);
          }
          if (record.type === "extension_ui_request" && record.method === "select" && select) {
            child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value: select })}\n`);
          }
          if (record.id === "init-command" && record.type === "response") {
            settled = true;
            child.stdin.end();
          }
        } catch { /* non-JSON host output */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") { reject(error); return; } }
      resolve({ code, stdout, stderr, violations, settled, records });
    });
    child.stdin.write(`${JSON.stringify({ id: "init-command", type: "prompt", message: "/bifrost init" })}\n`);
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
      assert.doesNotMatch(result.stdout + result.stderr, /Review model choices|Update project model pools/);
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

  for (const layer of ["user", "workspace"]) {
    for (const conflict of [false, true]) {
      it(`rejects a linked ${layer} config ${conflict ? "with an inherited pool" : "without an inherited pool"} before probing`, async () => {
        requests = [];
        const env = fixture(port, ["healthy"]);
        const link = layer === "user" ? join(env.home, ".pi", "agent", "bifrost.json") : join(env.work, "bifrost.json");
        const target = join(env.home, "linked-config.json");
        const original = Buffer.from(JSON.stringify({ classifier: { enabled: false }, ...(conflict ? { models: { quick: ["manual/keep"] } } : {}) }) + "\n");
        writeFileSync(target, original);
        symlinkSync(target, link);
        try {
          const result = await runInit({ ...env, args: "--write" });
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.violations, "");
          assert.deepEqual(readFileSync(target), original);
          assert.equal(existsSync(join(env.work, ".pi", "bifrost.json")), false);
          assert.deepEqual(requests, []);
          assert.match(result.stdout + result.stderr, /init: blocked.*Nothing was probed or saved/i);
        } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
      });
    }
  }

  for (const layer of ["user", "workspace"]) {
    it(`keeps unreviewed init from overriding an inherited ${layer} manual pool`, async () => {
      const env = fixture(port, ["healthy"]);
      const lowerPath = layer === "user" ? join(env.home, ".pi", "agent", "bifrost.json") : join(env.work, "bifrost.json");
      const original = Buffer.from(JSON.stringify({ models: { quick: ["manual/keep"] }, classifier: { enabled: false } }) + "\n");
      writeFileSync(lowerPath, original);
      try {
        const result = await runInit({ ...env, args: "--write" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.deepEqual(readFileSync(lowerPath), original);
        const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
        assert.equal(Object.hasOwn(saved.models, "quick"), false);
        assert.doesNotMatch(result.stdout + result.stderr, /Review model choices|Update project model pools/);
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });

    it(`keeps unreviewed init from replacing an inherited ${layer} empty pool`, async () => {
      const env = fixture(port, ["healthy"]);
      const lowerPath = layer === "user" ? join(env.home, ".pi", "agent", "bifrost.json") : join(env.work, "bifrost.json");
      const original = Buffer.from(JSON.stringify({ models: { quick: [] }, classifier: { enabled: false } }) + "\n");
      writeFileSync(lowerPath, original);
      try {
        const result = await runInit({ ...env, args: "--write" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.deepEqual(readFileSync(lowerPath), original);
        const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
        assert.equal(Object.hasOwn(saved.models, "quick"), false);
        assert.doesNotMatch(result.stdout + result.stderr, /Review model choices|Update project model pools/);
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

  it("keeps unreviewed project pools out of inherited tiers without changing global config", async () => {
    const env = fixture(port, ["healthy"]);
    const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
    const original = Buffer.from(JSON.stringify({ models: { quick: ["anthropic/claude-sonnet-4-20250514"], frontier: ["manual/global-frontier"] } }) + "\n");
    writeFileSync(globalPath, original);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.deepEqual(readFileSync(globalPath), original);
      const projectPath = join(env.work, ".pi", "bifrost.json");
      const saved = JSON.parse(readFileSync(projectPath, "utf8"));
      assert.equal(Object.hasOwn(saved.models, "quick"), false);
      assert.doesNotMatch(result.stdout + result.stderr, /Review model choices|Update project model pools/);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  for (const inheritedPool of [["manual/inherited"], []]) {
    for (const targetKind of ["absent", "empty"]) {
      it(`keeps ${targetKind} project target from overriding inherited ${inheritedPool.length ? "nonempty" : "empty"} pools`, async () => {
        const env = fixture(port, ["healthy"]);
        const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
        const projectPath = join(env.work, ".pi", "bifrost.json");
        const original = Buffer.from(JSON.stringify({ models: { quick: inheritedPool } }) + "\n");
        const targetBytes = Buffer.from("{}\n");
        writeFileSync(globalPath, original);
        if (targetKind === "empty") writeFileSync(projectPath, targetBytes);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = join(env.home, ".pi", "agent");
        try {
          const result = await runInit({ ...env, args: "--write" });
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.violations, "");
          assert.deepEqual(readFileSync(globalPath), original);
          const saved = JSON.parse(readFileSync(projectPath, "utf8"));
          assert.equal(Object.hasOwn(saved.models ?? {}, "quick"), false);
          assert.deepEqual(loadConfigForReload(env.work, ROOT).config.models?.quick, inheritedPool);
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          rmSync(env.home, { recursive: true, force: true });
          rmSync(env.work, { recursive: true, force: true });
        }
      });
    }
  }

  it("creates a project pool when inherited tiers do not overlap", async () => {
    const env = fixture(port, ["healthy"]);
    const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
    const original = Buffer.from('{"models":{"custom":["manual/keep"]},"classifier":{"enabled":false}}\n');
    writeFileSync(globalPath, original);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.deepEqual(readFileSync(globalPath), original);
      const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.ok(saved.models.quick.includes("fake/healthy"));
      assert.equal(Object.hasOwn(saved.models, "custom"), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("does not create a local override when generated and inherited pools are identical", async () => {
    const env = fixture(port, ["healthy"]);
    const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
    const original = Buffer.from(JSON.stringify({ models: { quick: ["fake/healthy"], general: [], frontier: [] } }) + "\n");
    writeFileSync(globalPath, original);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.deepEqual(readFileSync(globalPath), original);
      const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.equal(Object.hasOwn(saved.models, "quick"), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("keeps an unreviewed missing target from overriding an inherited generated pool", async () => {
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
    const receiptPath = join(env.home, ".pi", "agent", "bifrost-reconcile-ownership.json");
    const original = Buffer.from(JSON.stringify({ models: { quick: ["fake/healthy", "fake/credits-exhausted"] } }) + "\n");
    writeFileSync(globalPath, original);
    writeFileSync(receiptPath, ownership(["fake/healthy", "fake/credits-exhausted"], "user"));
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.deepEqual(readFileSync(globalPath), original);
      const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.equal(Object.hasOwn(saved.models, "quick"), false);
      assert.doesNotMatch(result.stdout + result.stderr, /Review model choices|Update project model pools/);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("keeps an unreviewed missing target without trusting inherited ownership receipt", async () => {
    const env = fixture(port, ["healthy"]);
    const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
    const receiptPath = join(env.home, ".pi", "agent", "bifrost-reconcile-ownership.json");
    const original = Buffer.from(JSON.stringify({ models: { quick: ["fake/credits-exhausted"] } }) + "\n");
    writeFileSync(globalPath, original);
    // Missing tombstones makes the whole receipt invalid; its coverage claim must not count.
    writeFileSync(receiptPath, JSON.stringify({ version: 1, sources: { "pi-models-v1-fake": { generated: { quick: ["fake/credits-exhausted"] } } } }));
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.deepEqual(readFileSync(globalPath), original);
      const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.equal(Object.hasOwn(saved.models, "quick"), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("saves a project config when an inherited receipt is unreadable but the config has no pools", async () => {
    const env = fixture(port, ["healthy"]);
    writeFileSync(join(env.home, ".pi", "agent", "bifrost-reconcile-ownership.json"), Buffer.from([0xff, 0xfe]));
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.doesNotMatch(result.stdout + result.stderr, /could not safely read inherited config/i);
      assert.ok(existsSync(join(env.work, ".pi", "bifrost.json")));
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  for (const selected of ["default", "default-global-only", "global"]) {
    it(`saves init to the ${selected} source without changing other layers`, async () => {
      requests = [];
      const env = fixture(port, ["healthy"]);
      const paths = {
        project: join(env.work, ".pi", "bifrost.json"),
        workspace: join(env.work, "bifrost.json"),
        user: join(env.home, ".pi", "agent", "bifrost.json"),
      };
      const original = Buffer.from('{"cache":{"enabled":false},"classifier":{"enabled":false}}\n');
      writeFileSync(paths.user, original);
      if (selected !== "default-global-only") writeFileSync(paths.workspace, original);
      try {
        const args = `--write${selected === "global" ? " -g" : ""}`;
        const result = await runInit({ ...env, args });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        const target = selected === "global" ? "user" : "project";
        assert.doesNotMatch(result.stdout + result.stderr, /Review model choices|Update (?:project|global) model pools/);
        assert.ok(JSON.parse(readFileSync(paths[target], "utf8")).models);
        for (const layer of ["workspace", "user"]) {
          if (layer === "workspace" && selected === "default-global-only") {
            assert.equal(existsSync(paths.workspace), false);
          } else if (layer !== target) assert.deepEqual(readFileSync(paths[layer]), original);
        }
        if (target !== "project") assert.equal(existsSync(paths.project), false);
        if (target === "project") {
          const saved = JSON.parse(readFileSync(paths.project, "utf8"));
          assert.equal(Object.hasOwn(saved, "cache"), false);
          assert.equal(Object.hasOwn(saved, "classifier"), false);
        }
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

  for (const args of ["--source workspace", "--source user", "--unknown"]) {
    it(`rejects invalid init arguments ${args} before probing or writing`, async () => {
      requests = [];
      const env = fixture(port, ["healthy"]);
      const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
      const original = Buffer.from('{"classifier":{"enabled":false}}\n');
      writeFileSync(globalPath, original);
      try {
        const result = await runInit({ ...env, args });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.match(result.stdout + result.stderr, /usage: \/bifrost init/i);
        assert.deepEqual(requests, []);
        assert.deepEqual(readFileSync(globalPath), original);
        assert.equal(existsSync(join(env.work, ".pi", "bifrost.json")), false);
        assert.equal(existsSync(join(env.work, ".pi", "bifrost-probe.json")), false);
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

  for (const args of ["", "-f", "-g", "-g -f"]) {
    it(`stops headless init ${args || "(default)"} before provider requests or writes`, async () => {
      requests = [];
      const env = fixture(port, ["healthy", "credits-exhausted"]);
      const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
      const globalBytes = Buffer.from('{"classifier":{"enabled":false}}\n');
      const projectPath = join(env.work, ".pi", "bifrost.json");
      const projectReceiptPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
      const globalReceiptPath = join(env.home, ".pi", "agent", "bifrost-reconcile-ownership.json");
      const projectBytes = Buffer.from('{"models":{"quick":["manual/project"]}}\n');
      const projectReceipt = Buffer.from(ownership(["manual/project"]));
      const globalReceipt = Buffer.from(ownership([], "user"));
      writeFileSync(globalPath, globalBytes);
      writeFileSync(projectPath, projectBytes);
      writeFileSync(projectReceiptPath, projectReceipt);
      writeFileSync(globalReceiptPath, globalReceipt);
      try {
        const result = await runInit({ ...env, args });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.match(result.stdout + result.stderr, /init: stopped before saving.*--write/i);
        assert.deepEqual(requests, []);
        assert.deepEqual(readFileSync(globalPath), globalBytes);
        assert.deepEqual(readFileSync(globalReceiptPath), globalReceipt);
        assert.deepEqual(readFileSync(projectPath), projectBytes);
        assert.deepEqual(readFileSync(projectReceiptPath), projectReceipt);
        assert.equal(existsSync(join(env.work, ".pi", "bifrost-probe.json")), false);
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

  it("rejects an invalid project config before provider probing", async () => {
    requests = [];
    const env = fixture(port, ["healthy"]);
    const configPath = join(env.work, ".pi", "bifrost.json");
    const original = Buffer.from("{invalid\n");
    writeFileSync(configPath, original);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.match(result.stdout + result.stderr, /init: blocked.*Nothing was probed or saved/i);
      assert.deepEqual(requests, []);
      assert.deepEqual(readFileSync(configPath), original);
      assert.equal(existsSync(join(env.work, ".pi", "bifrost-reconcile-ownership.json")), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  for (const confirm of [true, false]) {
    it(`interactive fresh init blocks unknown inherited pool replacement${confirm ? "" : " regardless of confirmation"}`, async () => {
      requests = [];
      const env = fixture(port, ["healthy"]);
      const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
      const globalBytes = Buffer.from('{"models":{"quick":["manual/inherited"],"frontier":["manual/frontier"]},"classifier":{"enabled":false}}\n');
      writeFileSync(globalPath, globalBytes);
      const projectPath = join(env.work, ".pi", "bifrost.json");
      const ownershipPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
      try {
        const result = await runInteractiveInit({ ...env, confirm });
        assert.equal(result.settled, true, JSON.stringify(result));
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.deepEqual(readFileSync(globalPath), globalBytes);
        assert.deepEqual([...new Set(requests)], ["healthy"]);
        assert.equal(requests.length, 1);
        if (confirm) {
          assert.equal(existsSync(projectPath), false);
          assert.equal(existsSync(ownershipPath), false);
          assert.match(result.stdout + result.stderr, /init: blocked.*Nothing was saved; inherited quick pool cannot be safely replaced/i);
          assert.match(result.stdout + result.stderr, /Sign in to each inherited provider and refresh its model catalog/i);
        } else {
          assert.equal(existsSync(projectPath), false);
          assert.equal(existsSync(ownershipPath), false);
          assert.match(result.stdout + result.stderr, /init: blocked.*Nothing was saved/i);
        }
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

  it("interactive fresh init reviews and saves a differing inherited pool with fresh authenticated inventory", async () => {
    requests = [];
    const env = fixture(port, ["healthy"]);
    const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
    const globalBytes = Buffer.from('{"models":{"quick":["fake/credits-exhausted"]},"classifier":{"enabled":false}}\n');
    writeFileSync(globalPath, globalBytes);
    const projectPath = join(env.work, ".pi", "bifrost.json");
    const ownershipPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
    try {
      const result = await runInteractiveInit({ ...env, confirm: true });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.match(result.stdout + result.stderr, /quick: project override[\s\S]*Inherited:[\s\S]*1\. fake\/credits-exhausted[\s\S]*Project:[\s\S]*1\. fake\/healthy/u);
      assert.deepEqual(readFileSync(globalPath), globalBytes);
      assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")).models, { quick: ["fake/healthy"] });
      assert.deepEqual(JSON.parse(readFileSync(ownershipPath, "utf8")), {
        version: 2, scope: "project", tiers: { quick: { state: "generated", models: ["fake/healthy"] } },
      });
      assert.deepEqual(loadConfigForReload(env.work, ROOT).config.models?.quick, ["fake/healthy"]);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  for (const mode of ["interactive", "write"]) {
    for (const inherited of ["different", "identical"]) {
      it(`fresh ${mode} handles ${inherited} inherited pool conservatively`, async () => {
        requests = [];
        const env = fixture(port, ["healthy"]);
        const inheritedPool = inherited === "identical" ? ["fake/healthy"] : ["manual/inherited"];
        const globalPath = join(env.home, ".pi", "agent", "bifrost.json");
        const projectPath = join(env.work, ".pi", "bifrost.json");
        writeFileSync(globalPath, JSON.stringify({ models: { quick: inheritedPool }, classifier: { enabled: false } }));
        try {
          const result = mode === "interactive"
            ? await runInteractiveInit({ ...env, confirm: true })
            : await runInit({ ...env, args: "--write" });
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.violations, "");
          const shouldBlock = mode === "interactive" && inherited === "different";
          assert.equal(existsSync(projectPath), !shouldBlock, result.stdout + result.stderr);
          const saved = shouldBlock ? undefined : JSON.parse(readFileSync(projectPath, "utf8"));
          const reportsProjectOverride = /Project-only overrides[\s\S]*?quick: project override[\s\S]*?Project:[\s\S]*?1\. fake\/healthy/u.test(result.stdout + result.stderr);
          assert.equal(reportsProjectOverride, false, result.stdout + result.stderr);
          if (shouldBlock) {
            assert.match(result.stdout + result.stderr, /init: blocked.*Nothing was saved; inherited quick pool cannot be safely replaced/i);
            assert.equal(existsSync(join(env.work, ".pi", "bifrost-reconcile-ownership.json")), false);
          } else {
            assert.equal(saved.models?.quick, undefined);
          }
          assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")).models.quick, inheritedPool);
        } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
      });
    }
  }

  for (const action of ["keep", "defaults"]) {
    it(`deleted intent ${action} preview matches saved config`, async () => {
      requests = [];
      const env = fixture(port, ["healthy"]);
      const projectPath = join(env.work, ".pi", "bifrost.json");
      const ownershipPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
      writeFileSync(projectPath, JSON.stringify({ default: "general", classifier: { enabled: false }, models: { general: ["manual/base"] } }));
      writeFileSync(ownershipPath, JSON.stringify({ version: 2, scope: "project", tiers: { quick: { state: "deleted" } } }));
      try {
        const result = action === "keep"
          ? await runInit({ ...env, args: "--write" })
          : await runInteractiveInit({ ...env, confirm: true, select: "Bifrost defaults" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        const saved = JSON.parse(readFileSync(projectPath, "utf8"));
        if (action === "keep") {
          assert.equal(Object.hasOwn(saved.models, "quick"), false);
          assert.doesNotMatch(result.stdout + result.stderr, /quick: remains deleted/);
        } else {
          assert.deepEqual(saved.models.quick, ["fake/healthy"]);
          assert.match(result.stdout + result.stderr, /quick[\s\S]*?Before: not configured[\s\S]*?After:[\s\S]*?1\. fake\/healthy/u);
        }
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

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
      assert.equal(config.cache.threshold, 1);
      assert.equal(config.reliability.failureThreshold, 3);
      assert.equal(config.debug.enabled, false);
      assert.equal(config.classifier?.model, "fake/healthy", "fresh init should persist the healthy prompt classifier model with bundled public defaults");
      assert.deepEqual(Object.keys(config.categoryStrategies), Object.keys(config.models));
      requests = [];
      const preview = await runInit({ ...env, args: "", prompt: "/bifrost preview --json a prompt with no local rule" });
      assert.equal(preview.code, 0, preview.stderr);
      assert.equal(preview.violations, "");
      assert.deepEqual(requests, ["healthy"], `ordinary preview should use the classifier model selected by init :: ${JSON.stringify({ requests, stdout: preview.stdout, stderr: preview.stderr, config })}`);
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
      assert.match(cached.stderr + cached.stdout, /Using \d+ saved probe results \(\d+[smhd.]+ old\)\. Run \/bifrost init -f to check again\./u);
      assert.doesNotMatch(cached.stderr + cached.stdout, /file mtime|provider-data freshness|registry refresh and other commands may still use network/i);
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
      assert.match(forced.stderr + forced.stdout, /Checking 2 models \(forced by -f\)\./u);
      assert.match(forced.stderr + forced.stdout, /Using \d+ working models from this check\./u);
      assert.doesNotMatch(forced.stderr + forced.stdout, /saved probe results \(|file mtime|provider-data freshness/i);
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
      assert.deepEqual(saved.models.quick, ["fake/credits-exhausted", "handwritten/model"]);
      assert.equal(saved.cache.enabled, false);
      assert.equal(saved.strategy, "cheapest");
      assert.equal(saved.classifier.endpoint, "https://PROJECT_ENDPOINT_CANARY.invalid");
      assert.equal(saved.classifier.systemPrompt, "PROJECT_SYSTEM_PROMPT_CANARY");
      assert.equal(saved.classifier.projectPrivateSetting, "PROJECT_CLASSIFIER_UNKNOWN_CANARY");
      assert.deepEqual(saved.classifier.criteria, { general: "keep classifier criteria" });
      assert.deepEqual(saved.classifier.typesafe, { timeoutMs: 1234, maxAttempts: 2, debug: true, metrics: { enabled: false } });
      assert.deepEqual(saved.classifier.piNative, { timeoutMs: 2345, maxAttempts: 2, metrics: { enabled: false } });
      assert.deepEqual(saved.retained, { owner: "user" });
      assert.match(result.stdout + result.stderr, /Using verified models: 1 working models/u);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  for (const [intent, pool] of [["empty", []], ["deleted", undefined], ["reordered", ["fake/healthy", "fake/credits-exhausted"]]]) {
    it(`preserves ${intent} tier through init, restart, and config reconcile`, async () => {
      requests = [];
      const env = fixture(port, ["healthy", "credits-exhausted"]);
      const configPath = join(env.work, ".pi", "bifrost.json");
      const receiptPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
      const models = { general: ["fake/healthy"], ...(pool === undefined ? {} : { quick: pool }) };
      const config = { ...BUNDLED_PUBLIC_INIT_DEFAULTS, default: "general", classifier: { enabled: false }, rules: [], models };
      const original = Buffer.from(JSON.stringify(config, null, 4) + "\n\n");
      writeFileSync(configPath, original);
      writeFileSync(receiptPath, ownership(["fake/credits-exhausted", "fake/healthy"]));
      try {
        for (let run = 0; run < 2; run++) {
          const result = await runInit({ ...env, args: "--write" });
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.violations, "");
          assert.deepEqual(readFileSync(configPath), original, "ownership-only init must preserve exact config bytes");
          assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).models, models);
          assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")).tiers.quick,
            { state: intent === "deleted" ? "deleted" : "user" });
        }
        const before = readFileSync(configPath);
        const receiptBefore = readFileSync(receiptPath);
        const result = await runInit({ ...env, prompt: "/bifrost config reconcile --tier quick --provider fake --json" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.match(result.stderr + result.stdout, /tier_protected|tier_not_explicit/);
        assert.deepEqual(readFileSync(configPath), before);
        assert.deepEqual(readFileSync(receiptPath), receiptBefore);
      } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
    });
  }

  it("preserves a deleted tier when the entire models property is absent", async () => {
    requests = [];
    const env = fixture(port, ["healthy"]);
    const configPath = join(env.work, ".pi", "bifrost.json");
    const receiptPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
    const original = Buffer.from(JSON.stringify({ ...BUNDLED_PUBLIC_INIT_DEFAULTS, default: "quick", classifier: { enabled: false }, rules: [] }, null, 4) + "\n\n");
    writeFileSync(configPath, original);
    writeFileSync(receiptPath, ownership(["fake/healthy"]));
    try {
      for (let run = 0; run < 2; run++) {
        const result = await runInit({ ...env, args: "--write" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.violations, "");
        assert.deepEqual(readFileSync(configPath), original);
        assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")).tiers.quick, { state: "deleted" });
      }
      const receiptBefore = readFileSync(receiptPath);
      const result = await runInit({ ...env, prompt: "/bifrost config reconcile --tier quick --provider fake --json" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      assert.match(result.stderr + result.stdout, /tier_protected|tier_not_explicit/);
      assert.deepEqual(readFileSync(configPath), original);
      assert.deepEqual(readFileSync(receiptPath), receiptBefore);
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
      assert.match(result.stderr + result.stdout, /No usable models found in this check\. Check API keys, network, and credits; no configuration was changed\./u);
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
    const probePath = join(env.work, ".pi", "bifrost-probe.json");
    writeFileSync(probePath, JSON.stringify([
      { provider: "fake", model: "credits-exhausted", status: "error", cost_input: 0, cost_output: 0, duration_ms: 10 },
    ]));
    const recent = new Date(Date.now() - 60_000);
    utimesSync(probePath, recent, recent);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(requests, []);
      assert.match(result.stderr + result.stdout, /No usable models found in saved probe results \(\d+[smhd.]+ old\)\. Run \/bifrost init -f after checking access\. Configuration unchanged\./u);
      assert.doesNotMatch(result.stderr + result.stdout, /file mtime|provider-data freshness|registry refresh and other commands may still use network/i);
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
      assert.equal(saved.cache.threshold, 1);
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

  it("reports a pending journal when init commit fails after the config rename", async () => {
    // Deterministic fault: preload patches fs.renameSync so the ownership
    // sidecar install throws EIO after applyReconciliationTransaction has
    // renamed the staged config into place and written a config_installed journal.
    requests = [];
    const env = fixture(port, ["healthy"]);
    const configPath = join(env.work, ".pi", "bifrost.json");
    const journalPath = join(env.work, ".pi", "bifrost-reconcile.journal");
    const ownershipPath = join(env.work, ".pi", "bifrost-reconcile-ownership.json");
    try {
      const result = await runInit({
        ...env,
        args: "--write",
        env: { BIFROST_TEST_FAIL_OWNERSHIP_RENAME: "1" },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.match(output, /could not finish the reviewed membership update/u);
      assert.match(output, /already holds the planned configuration/u);
      assert.match(output, /a reconciliation journal is pending/u);
      assert.match(output, /\/bifrost config reconcile --recover/u);
      assert.doesNotMatch(output, /existing files were preserved/u);
      assert.doesNotMatch(output, /may already be partly installed/u);

      assert.equal(existsSync(journalPath), true, "expected pending reconciliation journal");
      assert.equal(existsSync(configPath), true, "expected config to remain on disk");
      assert.equal(existsSync(ownershipPath), false, "expected ownership rename to have been faulted");
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(saved.models?.quick, ["fake/healthy"]);

      writeFileSync(join(env.home, "commit-failure-output.txt"), output);
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("reports the source-specific recovery command for user init commit failures", async () => {
    requests = [];
    const env = fixture(port, ["healthy"]);
    const userConfigPath = join(env.home, ".pi", "agent", "bifrost.json");
    const journalPath = join(env.home, ".pi", "agent", "bifrost-reconcile.journal");
    try {
      const result = await runInit({
        ...env,
        args: "-g --write",
        env: { BIFROST_TEST_FAIL_OWNERSHIP_RENAME: "1" },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.match(output, /could not finish the reviewed membership update/u);
      assert.match(output, /\/bifrost config reconcile --source user --recover/u);
      assert.doesNotMatch(output, /Run \/bifrost config reconcile --recover before you retry/u);
      assert.equal(existsSync(journalPath), true, "expected pending user reconciliation journal");
      assert.equal(existsSync(userConfigPath), true, "expected user config to remain on disk");
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });
});
