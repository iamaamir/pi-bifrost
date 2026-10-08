import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const MAX_CAPTURE_CHARS = 64 * 1024;

function appendBounded(current, chunk) {
  return current.length >= MAX_CAPTURE_CHARS ? current : current + chunk.slice(0, MAX_CAPTURE_CHARS - current.length);
}

function stopChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("close", () => { clearTimeout(kill); resolve(); });
    child.kill("SIGTERM");
  });
}

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await stopChild(child);
      reject(new Error(message));
    };
    const timer = setTimeout(() => { void fail("fake provider startup timed out"); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = appendBounded(output, chunk);
      try {
        const ready = JSON.parse(output);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: ready.port });
      } catch { /* wait for the startup record */ }
    });
    child.on("error", () => { void fail("fake provider failed before startup"); });
    child.on("close", () => { if (!settled) void fail("fake provider exited before startup"); });
  });
}

function writeFixture({ home, work, port, models, bifrost, retry = { enabled: false } }) {
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only", models } },
  }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify(bifrost));
}

function runPi({ home, work, model = "bifrost/auto", messages }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env: { ...env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKill;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 90_000);
    child.on("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      await stopChild(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function fakeStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function v2Config({ classifier = { enabled: false } } = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier,
    models: { quick: ["fake/healthy"] },
    reliability: { stateVersion: 2, failureThreshold: 1, windowMinutes: 10, cooldownMinutes: 1 },
  };
}

function seedExpiredV1Circuit(work, model = "fake/healthy") {
  const now = Date.now();
  writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
    version: 1,
    models: { [model]: { failures: [now - 60_000], openUntil: now - 1_000, trialActive: false } },
  }));
}

async function prepareV2AndRun({ home, work, port, models, config = v2Config(), messages, retry }) {
  writeFixture({ home, work, port, models, bifrost: config, retry });
  seedExpiredV1Circuit(work, config.models.quick[0]);
  return runPi({ home, work, messages: ["/bifrost reliability migrate", ...messages] });
}

describe("pinned Pi reliability v2 Auto path", { timeout: 360_000, concurrency: 1 }, () => {
  let server;
  before(async () => { server = await startFakeServer(); });
  after(async () => { if (server?.child) await stopChild(server.child); });

  it("closes the exact initialized v2 half-open lease after a successful pinned-Pi turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-e2e-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-e2e-work-"));
    try {
      const before = await fakeStats(server.port);
      const result = await prepareV2AndRun({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        messages: ["hello half-open"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, "pinned Pi must finish within the bounded test window");
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "the successful half-open user turn produces exactly one provider generation request");
      assert.match(result.stderr, /Reliability v2 sidecar initialized/);

      const state = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "utf8"));
      const dispatches = Object.values(state.dispatches);
      assert.equal(dispatches.length, 1, "one fresh Auto user turn owns one persisted dispatch receipt");
      const [receipt] = dispatches;
      assert.equal(receipt.settledKind, "success");
      assert.equal(receipt.scopes.length, 1);
      assert.equal(receipt.scopes[0].modelKey, "fake/healthy");
      assert.equal(typeof receipt.scopes[0].leaseId, "string", "the persisted receipt must identify the exact half-open lease it closed");
      const scope = state.scopes[receipt.scopes[0].scopeKey];
      assert.equal(scope.lease, undefined, "the exact half-open lease must be closed");
      assert.equal(scope.openUntil, undefined);
      assert.deepEqual(scope.failures, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reuses one v2 receipt and model across a Pi-owned error retry, without Bifrost replay", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-retry-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-retry-work-"));
    try {
      const before = await fakeStats(server.port);
      const result = await prepareV2AndRun({
        home, work, port: server.port,
        models: [{ id: "fail-then-ok", reasoning: false }],
        config: { ...v2Config({ classifier: { enabled: false } }), models: { quick: ["fake/fail-then-ok"] } },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
        messages: ["hello retry"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, "the deterministic Pi retry must complete within the bounded test window");
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts["fail-then-ok"] ?? 0) - (before.attempts["fail-then-ok"] ?? 0), 2,
        "one provider error followed by one host-owned retry must account for exactly two attempts");

      const state = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "utf8"));
      const dispatches = Object.values(state.dispatches);
      assert.equal(dispatches.length, 1, "retry remains part of its original logical dispatch, not a Bifrost replay");
      const [receipt] = dispatches;
      assert.equal(receipt.settledKind, "success", "the host retry's successful final result settles the original receipt");
      assert.equal(receipt.scopes.length, 1);
      assert.equal(receipt.scopes[0].modelKey, "fake/fail-then-ok", "retry must retain the originally admitted model");
      assert.equal(typeof receipt.scopes[0].leaseId, "string", "host retry must reuse the original half-open lease");
      const scope = state.scopes[receipt.scopes[0].scopeKey];
      assert.equal(scope.lease, undefined);
      assert.deepEqual(scope.failures, [], "the transient failed attempt is not settled as a separate Bifrost outcome");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  for (const corrupt of [false, true]) {
    it(`blocks Auto before classifier or generation requests when the v2 sidecar is ${corrupt ? "corrupt" : "missing"}`, async () => {
      const home = mkdtempSync(join(tmpdir(), "bifrost-v2-unready-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-v2-unready-work-"));
      try {
        const config = v2Config({ classifier: { enabled: true, backend: "prompt", model: "fake/classifier" } });
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "healthy", reasoning: false }, { id: "classifier", reasoning: false }],
          bifrost: config,
        });
        if (corrupt) writeFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "{ not-json");
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work, messages: ["hello must not send"] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "uninitialized v2 must stop before final generation");
        assert.equal((after.attempts.classifier ?? 0) - (before.attempts.classifier ?? 0), 0,
          "uninitialized v2 must stop before the external prompt classifier too");
        assert.match(result.stderr, /reliability v2 state is missing or unavailable/i);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it("blocks physical generation under v2 while leaving the explicitly selected physical model untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-physical-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-physical-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: v2Config(),
      });
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, model: "fake/healthy", messages: ["hello physical unsupported"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
        "physical routing cannot bypass the v2 receipt-owned Auto boundary");
      assert.match(`${result.stdout}\n${result.stderr}`, /supports Auto turns only; select bifrost\/auto or use reliability stateVersion 1/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  for (const command of ["off", "pin"]) {
    it(`keeps explicit /bifrost ${command} usable when the v2 sidecar is missing`, async () => {
      const home = mkdtempSync(join(tmpdir(), "bifrost-v2-manual-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-v2-manual-work-"));
      try {
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "healthy", reasoning: false }],
          bifrost: v2Config(),
        });
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work, messages: [`/bifrost ${command}`] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "manual exit selects a physical model but must not start generation");
        assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`Bifrost ${command === "off" ? "disabled" : "pinned"}`, "i"));
        assert.doesNotMatch(result.stderr, /reliability v2 state is missing or unavailable/i,
          "manual controls do not require the receipt sidecar to change the selected mode");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
