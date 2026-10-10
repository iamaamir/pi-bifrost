import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const EXTENSION_PATH = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let fakePort;

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("fake server start timeout")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      try {
        const parsed = JSON.parse(buf);
        if (parsed.port) {
          settled = true;
          clearTimeout(timer);
          resolve({ child, port: parsed.port });
        }
      } catch {
        // partial JSON; wait for more
      }
    });
    child.on("error", (error) => fail(error));
    child.on("close", () => fail(new Error("fake server exited before ready")));
  });
}

function writeFixture({ home, work, port, models, bifrost }) {
  writePiModels({ home, port, models });
  writeFileSync(join(work, "bifrost.json"), JSON.stringify(bifrost));
}

function writePiModels({ home, port, models }) {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models },
      },
    }),
  );
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
}

function piTestEnv(home) {
  const agentDir = join(home, ".pi", "agent");
  return {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
  };
}

function assertNoNetworkViolations(home) {
  const path = join(home, "test-network-violations.log");
  if (!existsSync(path)) return;
  assert.equal(readFileSync(path, "utf8"), "", "test network guard recorded a blocked external request");
}

function listAvailableProviders({ home, work }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-e", EXTENSION_PATH, "--list-models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: piTestEnv(home),
      cwd: work,
    });
    let stdout = "";
    let stderr = "";
    let forceKill;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      reject(new Error("pi model inventory timed out"));
    }, 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      try {
        assertNoNetworkViolations(home);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function fakeStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function runAuto({ home, work, messages, model = "bifrost/auto" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["-e", EXTENSION_PATH, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Keep real provider credentials from the developer shell out of the
        // subprocess. The fixture registry should contain only fake providers.
        env: piTestEnv(home),
        cwd: work,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`pi timed out: ${messages.join(" | ")}`));
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Nonzero exit is a valid outcome under test; callers assert on code/output.
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

it("rejects a pre-recorded network guard violation without an uncaught close error", async () => {
  const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
  try {
    writePiModels({ home, port: 0, models: [] });
    writeFileSync(join(home, "test-network-violations.log"), "blocked external request fixture\n");
    await assert.rejects(
      listAvailableProviders({ home, work }),
      /test network guard recorded a blocked external request/u,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

describe("auto virtual production path", { timeout: 240_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
    fakePort = server.port;
  });
  after(() => {
    server?.child.kill();
  });

  it("bootstraps a fresh install on the first physical and direct Auto prompt", async () => {
    for (const model of ["fake/healthy", "bifrost/auto"]) {
      const home = mkdtempSync(join(tmpdir(), "bifrost-fresh-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-fresh-work-"));
      try {
        writePiModels({ home, port: server.port, models: [{ id: "healthy", reasoning: false }] });
        const beforeInventory = await fakeStats(server.port);
        const inventory = await listAvailableProviders({ home, work });
        const afterInventory = await fakeStats(server.port);
        assertNoNetworkViolations(home);
        assert.deepEqual(afterInventory.attempts, beforeInventory.attempts, "startup/model inventory must issue zero provider POSTs");
        assert.deepEqual(afterInventory.stats, beforeInventory.stats, "startup/model inventory must issue zero provider POSTs");
        const before = afterInventory;
        assert.equal(inventory.code, 0, inventory.stderr);
        const rows = inventory.stdout
          .split("\n")
          .slice(1)
          .filter((line) => line.trim())
          .map((line) => line.trim().split(/\s+/u));
        assert.ok(rows.length > 0, inventory.stdout);
        assert.deepEqual(
          [...new Set(rows.filter(([provider]) => provider !== "bifrost").map(([provider]) => provider))],
          ["fake"],
          inventory.stdout,
        );
        assert.deepEqual(rows.filter(([provider]) => provider === "bifrost").map(([, model]) => model), ["auto"]);
        for (const [index, prompt] of ["Review this module and suggest one useful improvement", "Explain one design choice in this module"].entries()) {
          if (model === "bifrost/auto" && index === 1) {
            mkdirSync(join(work, ".pi"), { recursive: true });
            // The registered model_select hook persists this owned, routing-neutral
            // mode file; the CLI's --model flag does not emit model_select.
            writeFileSync(join(work, ".pi", "bifrost-state.json"), JSON.stringify({ enabled: true, classifierEnabled: true }));
          }
          const beforePrompt = await fakeStats(server.port);
          const result = await runAuto({ home, work, model, messages: [prompt] });
          const afterPrompt = await fakeStats(server.port);
          const promptStats = afterPrompt.stats.slice(beforePrompt.stats.length);
          assert.equal(result.code, 0, result.stderr);
          assert.match(result.stdout, /healthy/u);
          if (index === 0) {
            assert.match(result.stderr, /Bifrost loaded 1 listed chat model\(s\) into in-memory pools/u);
            assert.match(result.stderr, /Bifrost saved the detected starter pools to project config/u);
          } else {
            assert.doesNotMatch(result.stderr, /Bifrost loaded .* into in-memory pools/u);
          }
          assert.match(result.stderr, /Bifrost(?: auto)?: quick → fake\/healthy/u);
          assert.deepEqual(
            promptStats.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
            { classifier: 2, generation: 1 },
            `ordinary ${model} prompt ${index + 1} must make exactly two classification and one generation requests`,
          );
        }
        const after = await fakeStats(server.port);
        const newStats = after.stats.slice(before.stats.length);
        assert.deepEqual(
          newStats.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
          { classifier: 4, generation: 2 },
          `the two ordinary ${model} sessions must make exact bounded request counts`,
        );
        assert.equal(existsSync(join(work, "bifrost.json")), false);
        const savedConfigPath = join(work, ".pi", "bifrost.json");
        const ownershipPath = join(work, ".pi", "bifrost-reconcile-ownership.json");
        assert.equal(existsSync(savedConfigPath), true);
        assert.equal(existsSync(ownershipPath), true);
        const savedConfig = JSON.parse(readFileSync(savedConfigPath, "utf8"));
        assert.equal(savedConfig.default, "quick");
        assert.deepEqual(savedConfig.models.quick, ["fake/healthy"]);
        const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
        assert.ok(Object.values(ownership.sources).some((source) => source.generated.quick?.includes("fake/healthy")));
        if (model === "bifrost/auto") {
          assert.deepEqual(JSON.parse(readFileSync(join(work, ".pi", "bifrost-state.json"), "utf8")), {
            enabled: true,
            classifierEnabled: true,
          });
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
  });

  it("fails fresh sessions actionably when no pools are configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: { enabled: true, default: "general", classifier: { enabled: false }, models: { quick: [], general: [], frontier: [] } },
      });
      const { code, stderr } = await runAuto({ home, work, messages: ["hi"] });
      assert.notEqual(code, 0);
      assert.match(stderr, /0 models configured for "general"/);
      assert.match(stderr, /bifrost init/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("dispatches per request with prefix handoff intact", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
          rules: [{ pattern: "hello", model: "quick" }],
        },
      });
      const { code, stderr } = await runAuto({ home, work, messages: ["frontier hello", "hello"] });
      assert.equal(code, 0, stderr);
      assert.match(stderr, /Bifrost auto: frontier → fake\/strong/);
      assert.match(stderr, /Bifrost auto: quick → fake\/fast/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("lets /bifrost off resolve the default-tier model without a prior dispatch", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
        bifrost: {
          enabled: true, default: "general", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], general: ["fake/strong"] },
        },
      });
      // The first turn is the command itself: nothing ever dispatched through
      // Auto, so leaving it must resolve the default-tier model instead of
      // dead-ending with "select one in /model first" (issue #17 P2).
      const { code, stderr } = await runAuto({ home, work, messages: ["/bifrost off"] });
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost disabled/);
      assert.doesNotMatch(stderr, /no dispatched physical model/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("settles a claimed half-open trial end to end", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/healthy"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
          debug: { enabled: true },
        },
      });
      // Seed an expired-cooldown circuit: the route must CLAIM a half-open trial.
      mkdirSync(join(work, ".pi"), { recursive: true });
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/healthy": { failures: [Date.now() - 7_200_000], openUntil: Date.now() - 1_000, trialActive: false } },
      }));
      const { code, stderr } = await runAuto({ home, work, messages: ["hello"] });
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost auto: quick → fake\/healthy/);
      const reliability = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability.json"), "utf8"));
      const record = reliability.models["fake/healthy"];
      assert.equal(record.trialActive, false, "claimed half-open trial must resolve at settle");
      const debugLog = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8");
      assert.match(debugLog, /"event":"trial","entryType":"event","model":"fake\/healthy","allowed":true,"claimed":true/, "seeded half-open trial must actually be claimed");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("opens the circuit on failure and visibly degrades to the last dispatched model", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fail-then-ok", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fail-then-ok"] },
          reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const { code, stderr } = await runAuto({ home, work, messages: ["hello one", "hello two"] });
      const after = await fakeStats(server.port);
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost auto: quick → fake\/fail-then-ok/);
      assert.match(stderr, /Bifrost: keeping fake\/fail-then-ok/);
      assert.equal((after.attempts["fail-then-ok"] ?? 0) - (before.attempts["fail-then-ok"] ?? 0), 2,
        "the two user turns must produce two provider attempts; Bifrost must not replay the failed prompt");
      const reliability = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability.json"), "utf8"));
      assert.equal(reliability.models["fake/fail-then-ok"].lastFailureSource, "agent_settled");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not degrade an exhausted explicit tier boundary to the last dispatched model", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: {
          schemaVersion: 2,
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/healthy"], frontier: ["fake/missing"] },
          tierPolicies: { frontier: { fallbackTiers: [] } },
          rules: [
            { pattern: "warmup", model: "quick" },
            { pattern: "strict-boundary", model: "frontier" },
          ],
        },
      });
      const before = await fakeStats(server.port);
      const { stderr } = await runAuto({ home, work, messages: ["warmup", "strict-boundary"] });
      const after = await fakeStats(server.port);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "only the warmup turn may reach the healthy model; the exhausted frontier boundary must not dispatch it");
      assert.match(stderr, /Bifrost auto: quick → fake\/healthy/);
      assert.match(stderr, /no healthy physical model for tier frontier/);
      assert.doesNotMatch(stderr, /Bifrost: keeping fake\/healthy/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not send an exhausted reserve-policy turn to Auto's previous model", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }, { id: "reserved", reasoning: false }],
        bifrost: {
          schemaVersion: 2,
          enabled: true, default: "reserve", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/healthy"], restricted: ["fake/missing"], reserve: ["fake/reserved"] },
          rules: [
            { pattern: "warmup", model: "quick" },
            { pattern: "reserve-task", model: "restricted" },
          ],
          economics: {
            mode: "policy",
            scopes: { reserved: { kind: "model", model: "fake/reserved" } },
            sources: [{ id: "manual", scopeRef: "reserved", authority: "declared" }],
            admission: [{ id: "daily", scopeRef: "reserved", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
            observations: [{
              sourceId: "manual", scopeRef: "reserved", billing: "metered", observedAt: Date.now() - 1, expiresAt: Date.now() + 60_000, revision: 1,
              windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.1 }],
            }],
          },
        },
      });
      const before = await fakeStats(server.port);
      const { stderr } = await runAuto({ home, work, messages: ["warmup", "reserve-task"] });
      const after = await fakeStats(server.port);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "the warmup may reach its selected model once");
      assert.equal((after.attempts.reserved ?? 0) - (before.attempts.reserved ?? 0), 0,
        "a reserve-excluded candidate must never reach the fake provider");
      assert.match(stderr, /no eligible physical model for tier restricted \(reserve policy exclusion\)/);
      assert.match(stderr, /reserve policy excluded 1 configured candidate\(s\) in fallback tier reserve \(reasons: reserve_reached\)/);
      assert.doesNotMatch(stderr, /resolved 0 available models|check provider credentials/);
      assert.doesNotMatch(stderr, /reserve-task|0\.1/);
      assert.doesNotMatch(stderr, /Bifrost: keeping fake\/healthy/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
