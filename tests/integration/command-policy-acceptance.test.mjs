import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let server;

function piEnvironment(home) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  return {
    ...base,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
  };
}

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fake provider startup timed out")); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        clearTimeout(timer);
        resolve({ child, port: ready.port });
      } catch { /* wait for the startup record */ }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("fake provider exited before startup")); });
  });
}

function fixture({ models = [], config = {}, initialConfig, ownership, apiKey = "fixture-only" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-command-policy-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-command-policy-work-"));
  const agent = join(home, ".pi", "agent");
  const project = join(work, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: "openai-completions",
        apiKey,
        models: models.map((model) => ({ reasoning: false, contextWindow: 8192, maxTokens: 512, ...model })),
      },
    },
  }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  if (initialConfig !== undefined) writeFileSync(join(project, "bifrost.json"), initialConfig);
  else writeFileSync(join(project, "bifrost.json"), JSON.stringify(config));
  if (ownership !== undefined) writeFileSync(join(project, "bifrost-reconcile-ownership.json"), ownership);
  return { home, work, project };
}

function runPi({ home, work, args, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-tools", ...args], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      env: piEnvironment(home),
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
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") { reject(error); return; } }
      resolve({ code, stdout, stderr, violations, timedOut: Boolean(killTimer) });
    });
  });
}

function startRpc({ home, work, model = "fake/chat", timeoutMs = 30_000 }) {
  const child = spawn(PI, ["-e", EXTENSION, "--mode", "rpc", "--no-session", "--no-tools", "--model", model], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnvironment(home),
  });
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closePromise;
  let closeInfo;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeInfo = { code, signal };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${incompleteLine}${chunk}`.split("\n");
    incompleteLine = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); }
      catch { /* malformed output remains a protocol assertion failure */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = undefined;
        resolve();
      };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  async function prompt(message) {
    const id = `command-${records.length}-${Date.now()}`;
    const start = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return { response: record, stderr: stderr.slice(stderrStart) };
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}`);
  }

  async function userTurn(message) {
    const start = records.length;
    const accepted = await prompt(message);
    if (accepted.response.data?.disposition !== "started") return accepted;
    const deadline = Date.now() + timeoutMs;
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "agent_settled") return accepted;
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before settling: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC turn did not settle: ${message}`);
  }

  async function close() {
    closePromise ??= (async () => {
      child.stdin.end();
      await Promise.race([
        childClosed,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (!closeInfo) {
        child.kill("SIGKILL");
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      assert.ok(closeInfo, "Pi RPC child must close before its fixture is removed");
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...closeInfo, violations };
    })();
    return closePromise;
  }

  return { prompt, userTurn, close };
}

async function stats() {
  const response = await fetch(`http://127.0.0.1:${server.port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function report(output) {
  const line = `${output.stderr}\n${output.stdout}`.split("\n").find((item) => item.startsWith("[bifrost-json] "));
  assert.ok(line, `expected Pi command JSON report; output was:\n${output.stderr}\n${output.stdout}`);
  return JSON.parse(line.slice("[bifrost-json] ".length));
}

function assertOffline(output) {
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.timedOut, false);
  assert.equal(output.violations, "", "Pi attempted a non-fixture network connection");
}

function writeFixtureReceipt(generatedByTier) {
  const ownershipSource = `pi-models-v1-${createHash("sha256").update(JSON.stringify(["fake", "general"])).digest("hex").slice(0, 40)}`;
  return JSON.stringify({ version: 1, sources: {
    [ownershipSource]: { generated: { general: generatedByTier }, tombstones: {} },
  } });
}

describe("pinned Pi command and routing acceptance", { concurrency: 1, timeout: 180_000 }, () => {
  before(async () => { server = await startFakeServer(); });
  after(async () => {
    if (!server?.child || server.child.exitCode !== null) return;
    const child = server.child;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  it("dispatches to the fresh declared billing-class preference and makes no classifier call", async () => {
    const env = fixture({
      models: [
        { id: "metered", cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 } },
        { id: "subscription", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      ],
      config: {
        schemaVersion: 2,
        enabled: true,
        default: "general",
        strategy: "cheapest",
        classifier: { enabled: false },
        models: { general: ["fake/metered", "fake/subscription"] },
        economics: {
          mode: "policy",
          scopes: {
            metered: { kind: "model", model: "fake/metered" },
            subscription: { kind: "model", model: "fake/subscription" },
          },
          sources: [
            { id: "metered-fact", scopeRef: "metered", authority: "declared" },
            { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
          ],
          sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"] },
          admission: [],
          preference: { billingClass: "subscription" },
          observations: [
            { sourceId: "metered-fact", scopeRef: "metered", billing: "metered", observedAt: 1, expiresAt: 4102444800000, revision: 1, windows: [] },
            { sourceId: "subscription-fact", scopeRef: "subscription", billing: "subscription", observedAt: 1, expiresAt: 4102444800000, revision: 1, windows: [] },
          ],
        },
      },
    });
    try {
      const beforeStats = await stats();
      const result = await runPi({ home: env.home, work: env.work, args: ["--no-session", "--model", "fake/metered", "-p", "ordinary implementation task"] });
      const afterStats = await stats();
      assertOffline(result);
      assert.equal(result.code, 0, result.stderr);
      const delta = afterStats.stats.slice(beforeStats.stats.length);
      assert.deepEqual(delta.map((item) => [item.kind, item.model]), [["generation", "subscription"]]);
      const changes = Object.fromEntries(Object.keys(afterStats.attempts).map((key) => [key, (afterStats.attempts[key] ?? 0) - (beforeStats.attempts[key] ?? 0)]));
      assert.deepEqual(changes, { subscription: 1 });
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("runs inspect, validate, and a direct-rule preview offline without provider requests", async () => {
    const env = fixture({
      models: [{ id: "chat" }],
      config: {
        enabled: true,
        default: "general",
        classifier: { enabled: true, backend: "prompt", model: "fake/chat" },
        models: { general: ["fake/chat"] },
        rules: [{ pattern: "POLICY_ACCEPTANCE_DIRECT", model: "fake/chat" }],
        debug: { enabled: true },
        privateMetadata: "private-config-canary",
      },
      apiKey: "synthetic-provider-secret-canary",
    });
    try {
      const beforeStats = await stats();
      const commandOutputs = [];
      for (const command of ["/bifrost inspect --json", "/bifrost validate --json", "/bifrost preview --json POLICY_ACCEPTANCE_DIRECT"]) {
        const result = await runPi({ home: env.home, work: env.work, args: ["--no-session", "-p", command] });
        commandOutputs.push(`${command}: ${result.stderr}\n${result.stdout}`);
        assertOffline(result);
        if (command.includes("preview")) {
          const preview = report(result);
          assert.equal(preview.source, "regex");
          assert.equal(preview.selected, "fake/chat");
        } else {
          const diagnostic = report(result);
          assert.equal(diagnostic.kind, command.includes("inspect") ? "inspection" : "validation");
          if (diagnostic.kind === "inspection") {
            assert.ok(diagnostic.tiers.some((tier) => tier.candidates.some((candidate) => candidate.model === "fake/chat" && candidate.available === true)));
          } else assert.equal(diagnostic.diagnostics.filter((entry) => entry.severity === "error").length, 0);
        }
        assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /private-config-canary|synthetic-provider-secret-canary/u);
      }
      const afterStats = await stats();
      assert.deepEqual(afterStats.attempts, beforeStats.attempts, `commands made provider attempts:\n${commandOutputs.join("\n")}`);
      assert.deepEqual(afterStats.stats, beforeStats.stats, `commands made provider requests:\n${commandOutputs.join("\n")}`);
      assert.equal(afterStats.catalogRequests, beforeStats.catalogRequests, "offline diagnostics must not refresh provider catalogs");
      const debugPath = join(env.project, "bifrost-debug.jsonl");
      if (existsSync(debugPath)) {
        const debugLog = readFileSync(debugPath, "utf8");
        assert.doesNotMatch(debugLog, /private-config-canary|synthetic-provider-secret-canary/u);
      }
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("applies only a reviewed Pi-command reconciliation digest and preserves manual config", async () => {
    const original = Buffer.from('{\n  "enabled": true,\n  "default": "general",\n  "classifier": { "enabled": false },\n  "models": { "general": ["fake/old", "handwritten/model"] },\n  "retained": { "owner": "user" }\n}\n');
    const env = fixture({
      models: [{ id: "new" }],
      initialConfig: original,
      ownership: writeFixtureReceipt(["fake/old"]),
    });
    const rpc = startRpc({ home: env.home, work: env.work, model: "fake/new" });
    try {
      const beforeStats = await stats();
      const previewOutput = await rpc.prompt("/bifrost config reconcile --tier general --provider fake --refresh --json");
      const refreshedPreview = report(previewOutput);
      assert.equal(refreshedPreview.status, "ready", JSON.stringify(refreshedPreview));
      assert.equal(refreshedPreview.inventoryStatus, "complete");
      assert.deepEqual(readFileSync(join(env.project, "bifrost.json")), original, "preview must not change config bytes");

      const offlinePreviewOutput = await rpc.prompt("/bifrost config reconcile --tier general --provider fake --json");
      const proposal = report(offlinePreviewOutput);
      assert.equal(proposal.status, "ready", JSON.stringify(proposal));
      assert.equal(proposal.proposalDigest, refreshedPreview.proposalDigest);
      assert.ok(proposal.proposalDigest);
      assert.deepEqual(readFileSync(join(env.project, "bifrost.json")), original, "preview must not change config bytes");

      const configBeforeRejectedApply = readFileSync(join(env.project, "bifrost.json"));
      const receiptBeforeRejectedApply = readFileSync(join(env.project, "bifrost-reconcile-ownership.json"));
      const rejectedOutput = await rpc.prompt(`/bifrost config reconcile --tier general --provider fake --apply --proposal ${"0".repeat(64)} --json`);
      const rejected = report(rejectedOutput);
      assert.notEqual(rejected.status, "committed", "an unreviewed digest must not commit");
      assert.deepEqual(readFileSync(join(env.project, "bifrost.json")), configBeforeRejectedApply);
      assert.deepEqual(readFileSync(join(env.project, "bifrost-reconcile-ownership.json")), receiptBeforeRejectedApply);

      const appliedOutput = await rpc.prompt(`/bifrost config reconcile --tier general --provider fake --apply --proposal ${proposal.proposalDigest} --json`);
      const applied = report(appliedOutput);
      assert.equal(applied.status, "committed");
      const config = JSON.parse(readFileSync(join(env.project, "bifrost.json"), "utf8"));
      assert.deepEqual(config.models.general, ["handwritten/model", "fake/new"]);
      assert.deepEqual(config.retained, { owner: "user" });
      const receiptPath = join(env.project, "bifrost-reconcile-ownership.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const ownership = Object.values(receipt.sources);
      assert.ok(ownership.some((source) => source.generated.general?.includes("fake/new")));
      assert.equal(ownership.some((source) => source.generated.general?.includes("fake/old")), false);
      assert.ok(existsSync(applied.applyResult.configBackupPath));
      assert.deepEqual(readFileSync(applied.applyResult.configBackupPath), original);
      const oldReceipt = writeFixtureReceipt(["fake/old"]);
      assert.ok(existsSync(applied.applyResult.ownershipBackupPath));
      assert.deepEqual(readFileSync(applied.applyResult.ownershipBackupPath), Buffer.from(oldReceipt));
      const afterStats = await stats();
      assert.deepEqual(afterStats.attempts, beforeStats.attempts);
      assert.deepEqual(afterStats.stats, beforeStats.stats);
      assert.equal(afterStats.catalogRequests, beforeStats.catalogRequests,
        "the command boundary should not make hidden catalog requests beyond its explicit refresh operation");
    } finally {
      const stopped = await rpc.close();
      assert.equal(stopped.code, 0);
      assert.equal(stopped.violations, "");
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("saves generated ownership after long probes without replacing handwritten config", async () => {
    const original = Buffer.from(JSON.stringify({
      enabled: true,
      default: "quick",
      classifier: { enabled: false },
      probe: { timeoutMs: 45_000, concurrency: 2 },
      models: { quick: ["handwritten/model"] },
      metadata: { createdAt: "2020-01-02T03:04:05.000Z" },
    }, null, 2) + "\n");
    const env = fixture({
      models: [{ id: "new" }, { id: "probe-slow" }],
      initialConfig: original,
    });
    try {
      const beforeStats = await stats();
      const result = await runPi({
        home: env.home,
        work: env.work,
        args: ["--no-session", "-p", "/bifrost init -f --write"],
        timeoutMs: 70_000,
      });
      const afterStats = await stats();
      assertOffline(result);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(afterStats.stats.slice(beforeStats.stats.length).map((item) => [item.kind, item.model]), [
        ["generation", "new"],
        ["generation", "probe-slow"],
      ]);
      assert.equal(afterStats.catalogRequests, beforeStats.catalogRequests,
        "init probes configured models directly and does not need a provider catalog refresh");
      const saved = JSON.parse(readFileSync(join(env.project, "bifrost.json"), "utf8"));
      assert.equal(saved.metadata.createdAt, "2020-01-02T03:04:05.000Z");
      assert.ok(saved.models.quick.includes("handwritten/model"));
      assert.ok(saved.models.quick.includes("fake/new"));
      assert.ok(saved.models.quick.includes("fake/probe-slow"));
      const receipt = JSON.parse(readFileSync(join(env.project, "bifrost-reconcile-ownership.json"), "utf8"));
      const generated = Object.values(receipt.sources).flatMap((source) => source.generated.quick ?? []);
      assert.ok(generated.includes("fake/new"));
      assert.ok(generated.includes("fake/probe-slow"));
      assert.equal(generated.includes("handwritten/model"), false);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("warns on prompt-classifier timeout, falls back locally, then generates on the physical model", async () => {
    const env = fixture({
      models: [{ id: "slow" }, { id: "healthy" }],
      config: {
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: true, backend: "prompt", model: "fake/slow", totalTimeoutMs: 1_000 },
        models: { general: ["fake/healthy"] },
        debug: { enabled: true },
      },
    });
    try {
      const beforeStats = await stats();
      const result = await runPi({ home: env.home, work: env.work, args: ["--no-session", "--model", "fake/healthy", "-p", "a task that needs a model"], timeoutMs: 20_000 });
      const afterStats = await stats();
      assertOffline(result);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /classifier time budget expired/i);
      assert.deepEqual(afterStats.stats.slice(beforeStats.stats.length).map((item) => [item.kind, item.model]), [
        ["classifier", "slow"],
        ["generation", "healthy"],
      ]);
      assert.equal((afterStats.attempts.slow ?? 0) - (beforeStats.attempts.slow ?? 0), 1);
      assert.equal((afterStats.attempts.healthy ?? 0) - (beforeStats.attempts.healthy ?? 0), 1);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("uses reloaded v2 model-scope allowance policy for the next Auto turn", async () => {
    const config = {
      schemaVersion: 2,
      enabled: true,
      default: "quick",
      strategy: "first",
      categoryStrategies: { quick: "first" },
      classifier: { enabled: false },
      models: { quick: ["fake/usage-exhausted", "fake/sibling"] },
      reliability: {
        enabled: true,
        stateVersion: 2,
        failureThreshold: 3,
        windowMinutes: 5,
        cooldownMinutes: 1,
        allowanceCooldownScope: "provider",
        cooldownOnAllowanceExhausted: true,
        retryOnAllowanceExhausted: false,
      },
    };
    const env = fixture({ models: [{ id: "usage-exhausted" }, { id: "sibling" }], config });
    const rpc = startRpc({ home: env.home, work: env.work, model: "bifrost/auto" });
    try {
      const migrated = await rpc.prompt("/bifrost reliability migrate --fresh");
      assert.equal(migrated.response.data.disposition, "handled");
      assert.ok(existsSync(join(env.project, "bifrost-reliability-v2.json")), "the registered migration command must initialize v2 state");

      const changed = { ...config, reliability: { ...config.reliability, allowanceCooldownScope: "model" } };
      writeFileSync(join(env.project, "bifrost.json"), JSON.stringify(changed));
      const reloaded = await rpc.prompt("/bifrost reload");
      assert.equal(reloaded.response.data.disposition, "handled");

      const before = await stats();
      const firstTurn = await rpc.userTurn("first ordinary coding task");
      const afterFailure = await stats();
      assert.equal(firstTurn.response.data.disposition, "started");
      assert.equal((afterFailure.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
        `expected one usage-exhausted provider call; stats delta: ${JSON.stringify(afterFailure.stats.slice(before.stats.length))}`);
      assert.equal((afterFailure.attempts.sibling ?? 0) - (before.attempts.sibling ?? 0), 0,
        "allowance retry is disabled, so the failed turn must stop on its original model");

      const providerStatePath = join(env.project, "bifrost-provider-reliability.json");
      if (existsSync(providerStatePath)) {
        const providerState = JSON.parse(readFileSync(providerStatePath, "utf8"));
        assert.equal(Object.keys(providerState.scopes ?? {}).some((key) => key.includes("bifrost-provider-usage/fake")), false,
          "the reloaded model scope must not write a provider usage pause");
      }
      const statePath = join(env.project, "bifrost-reliability-v2.json");
      const reliabilityState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.ok(Object.keys(reliabilityState.scopes ?? {}).some((key) => key.includes("fake/usage-exhausted")),
        "the allowance failure should be recorded against the failed model");

      await rpc.userTurn("second ordinary coding task");
      const afterSecond = await stats();
      assert.equal((afterSecond.attempts["usage-exhausted"] ?? 0) - (afterFailure.attempts["usage-exhausted"] ?? 0), 0,
        "the model-scoped pause must exclude the failed model on the following turn");
      assert.equal((afterSecond.attempts.sibling ?? 0) - (afterFailure.attempts.sibling ?? 0), 1,
        "the next Auto turn should use the healthy sibling on the same provider");
      const stopped = await rpc.close();
      assert.equal(stopped.code, 0);
      assert.equal(stopped.violations, "");
    } finally {
      await rpc.close();
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });
});
