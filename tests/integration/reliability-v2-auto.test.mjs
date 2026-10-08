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

function runPi({ home, work, model = "bifrost/auto", messages, extraExtensions = [] }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const extensionArgs = extraExtensions.flatMap((extension) => ["-e", extension]);
    const child = spawn(PI, ["-e", EXTENSION, ...extensionArgs, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages], {
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

  it("retains the successful Auto model across native turns while prefixes use the random strategy", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-affinity-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-affinity-auto-work-"));
    const baselineHome = mkdtempSync(join(tmpdir(), "bifrost-affinity-baseline-home-"));
    const baselineWork = mkdtempSync(join(tmpdir(), "bifrost-affinity-baseline-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "allowed", reasoning: false }, { id: "alternate", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "random", classifier: { enabled: false },
          models: { quick: ["fake/allowed", "fake/alternate"] },
          reliability: { stateVersion: 1 },
          debug: { enabled: true },
        },
      });
      const rngExtension = join(work, "affinity-rng-extension.mjs");
      writeFileSync(rngExtension, `
        import { writeFileSync } from "node:fs";
        let inputIndex = 0;
        let active = false;
        let draws = 0;
        const records = [];
        const values = [0.05, 0.95, 0.95];
        Math.random = () => {
          if (active) draws += 1;
          return values[Math.min(inputIndex - 1, values.length - 1)] ?? 0.5;
        };
        export default function(pi) {
          pi.on("before_agent_start", () => {
            inputIndex += 1;
            draws = 0;
            active = true;
          });
          pi.on("turn_end", () => {
            if (active) {
              records.push({ input: inputIndex, draws });
              active = false;
            }
          });
          pi.on("session_shutdown", () => {
            if (active) records.push({ input: inputIndex, draws });
            writeFileSync("affinity-rng-records.json", JSON.stringify(records));
          });
        }
      `);

      const before = await fakeStats(server.port);
      const result = await runPi({
        home,
        work,
        extraExtensions: [rngExtension],
        messages: ["first same-tier turn", "second same-tier turn", "quick explicit tier turn"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, "pinned Pi must finish within the bounded test window");
      assert.equal(result.code, 0, result.stderr);

      const attempts = Object.fromEntries(Object.entries(after.attempts).map(([model, count]) => [model, count - (before.attempts[model] ?? 0)]));
      assert.deepEqual(attempts, { allowed: 2, alternate: 1 }, "three user turns generate exactly three fake-provider requests, with no classifier calls");
      assert.match(result.stderr, /Bifrost auto: quick → fake\/allowed/);
      assert.match(result.stderr, /Bifrost auto: quick → fake\/alternate/);

      const debug = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const decisions = debug.filter((entry) => entry.event === "route_decision").map((entry) => entry.decision);
      assert.equal(decisions.length, 3, "one route decision per native user turn");
      assert.deepEqual(decisions.slice(0, 2).map((decision) => decision.affinity.strategyWinner), ["fake/allowed", "fake/alternate"],
        "the controlled random strategy alternates its base winner across the automatic turns");
      assert.deepEqual(decisions.map((decision) => decision.selected), ["fake/allowed", "fake/allowed", "fake/alternate"],
        "the second automatic turn retains its proven anchor; the explicit prefix uses the strategy winner");
      assert.equal(decisions[1].affinity.selection, "retained_anchor");
      assert.equal(decisions[2].selectedStrategy, "random");
      assert.equal(decisions[2].affinity.selection, "not_applicable", "an explicit prefix bypasses retention policy");

      const rngRecords = JSON.parse(readFileSync(join(work, "affinity-rng-records.json"), "utf8"));
      assert.equal(rngRecords.length, 3);

      writeFixture({
        home: baselineHome, work: baselineWork, port: server.port,
        models: [{ id: "allowed", reasoning: false }, { id: "alternate", reasoning: false }],
        bifrost: {
          schemaVersion: 2,
          enabled: true, default: "quick", strategy: "random", classifier: { enabled: false },
          models: { quick: ["fake/allowed", "fake/alternate"] },
          affinity: { mode: "off" },
          reliability: { stateVersion: 1 },
          debug: { enabled: true },
        },
      });
      const baselineRngExtension = join(baselineWork, "affinity-rng-extension.mjs");
      writeFileSync(baselineRngExtension, readFileSync(rngExtension, "utf8"));
      const baselineBefore = await fakeStats(server.port);
      const baseline = await runPi({
        home: baselineHome,
        work: baselineWork,
        extraExtensions: [baselineRngExtension],
        messages: ["first same-tier turn", "second same-tier turn", "quick explicit tier turn"],
      });
      const baselineAfter = await fakeStats(server.port);
      assert.equal(baseline.timedOut, false, "baseline Pi must finish within the bounded test window");
      assert.equal(baseline.code, 0, baseline.stderr);
      assert.deepEqual(
        Object.fromEntries(Object.entries(baselineAfter.attempts).map(([model, count]) => [model, count - (baselineBefore.attempts[model] ?? 0)])),
        { allowed: 1, alternate: 2 },
        "the explicit-off baseline also makes exactly one provider request per turn",
      );
      const baselineDebug = readFileSync(join(baselineWork, ".pi", "bifrost-debug.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const baselineDecisions = baselineDebug.filter((entry) => entry.event === "route_decision").map((entry) => entry.decision);
      assert.deepEqual(baselineDecisions.map((decision) => decision.selected), ["fake/allowed", "fake/alternate", "fake/alternate"]);
      const baselineRngRecords = JSON.parse(readFileSync(join(baselineWork, "affinity-rng-records.json"), "utf8"));
      assert.deepEqual(rngRecords.map((record) => record.draws), baselineRngRecords.map((record) => record.draws),
        "Auto retention performs zero extra random draws compared with the configured off baseline");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(baselineHome, { recursive: true, force: true });
      rmSync(baselineWork, { recursive: true, force: true });
    }
  });

  for (const mode of ["v1", "v2"]) {
    it(`cools only an explicitly exhausted model before the next fresh ${mode} Auto turn`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          categoryStrategies: { quick: "first" },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
          debug: { enabled: true },
        };
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
          bifrost,
        });
        const before = await fakeStats(server.port);
        const messages = ["first request gets an explicit usage limit", "fresh follow-up request"];
        const result = await runPi({ home, work, messages: mode === "v2" ? ["/bifrost reliability migrate --fresh", ...messages] : messages });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false, "pinned Pi must finish within the bounded test window");
        assert.equal(result.code, 0, result.stderr);
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
          "the failed prompt is sent once and never replayed");
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
          "the next fresh user turn selects the other configured eligible model");
        assert.match(result.stderr, /Bifrost auto: quick → fake\/usage-exhausted/);
        assert.match(result.stderr, /reported allowance exhaustion \(text_heuristic\); a model-only cooldown applies/);
        assert.match(result.stderr, /Bifrost auto: quick → fake\/healthy/);
        assert.match(result.stderr, /Shared provider\/account scope is unknown; other models were not blocked/);

        const statePath = mode === "v2" ? ".pi/bifrost-reliability-v2.json" : ".pi/bifrost-reliability.json";
        const state = JSON.parse(readFileSync(join(work, statePath), "utf8"));
        const record = mode === "v2" ? state.scopes["model:20:fake/usage-exhausted"] : state.models["fake/usage-exhausted"];
        assert.ok(record.openUntil > Date.now() + 59 * 60_000, "default cooldown remains active for the next turn");
        if (mode === "v1") {
          assert.equal(record.lastFailureReason, "allowance_exhausted:text_heuristic:model-only");
        } else {
          assert.equal(Object.values(state.settledOutcomes).some((outcome) => outcome.observation !== undefined), false,
            "v2 enforces the typed evidence without enabling optional observation persistence");
        }
        const events = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.ok(events.some((event) => mode === "v1"
          ? event.event === "legacy_outcome_observed" && event.category === "allowance_exhausted"
          : event.event === "receipt_settled" && event.category === "allowance_exhausted"));
        assert.equal(JSON.stringify(events).includes("The usage limit has been reached"), false,
          "the content-free trace does not retain the provider error text");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it("does not degrade a fresh v1 Auto turn to a singleton model on allowance cooldown", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-single-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-single-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: false }, models: { quick: ["fake/usage-exhausted"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["trigger explicit usage exhaustion", "fresh request must not reuse blocked model"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
        "the first error is not replayed and the second fresh turn does not hit the blocked singleton");
      assert.match(result.stderr, /Bifrost: the last dispatched model is on an active model-only allowance cooldown/);
      assert.doesNotMatch(result.stderr, /Bifrost: keeping fake\/usage-exhausted/,
        "the legacy last-dispatched-model degrade path must not override a typed allowance cooldown");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not generate on an allowance-cooled physical model when no alternative resolves", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-physical-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-physical-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: false }, models: { quick: ["fake/usage-exhausted"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const result = await runPi({
        home, work, model: "fake/usage-exhausted",
        messages: ["trigger explicit usage exhaustion", "fresh physical request must not reach the cooled model"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 1, "the first provider error remains the command failure; the second turn is handled locally");
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
        "the follow-up physical input is handled before generation on the active cooled model");
      assert.match(result.stderr, /active physical model is on an active model-only allowance cooldown/);
      assert.match(result.stderr, /the turn was not sent/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("guards the last dispatched allowance-blocked model in a mixed hard/ordinary open pool", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-mixed-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-mixed-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "ordinary-open", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: false }, models: { quick: ["fake/usage-exhausted", "fake/ordinary-open"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const now = Date.now();
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/ordinary-open": { failures: [now], openUntil: now + 60 * 60_000, lastFailureReason: "provider request failed" } },
      }));
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["trigger explicit usage exhaustion", "fresh request must not reuse blocked model"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
      assert.equal((after.attempts["ordinary-open"] ?? 0) - (before.attempts["ordinary-open"] ?? 0), 0);
      assert.match(result.stderr, /last dispatched model is on an active model-only allowance cooldown/);
      assert.doesNotMatch(result.stderr, /Bifrost: keeping fake\/usage-exhausted/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips a prompt-classifier model with a proven active v1 allowance cooldown", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-classifier-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-classifier-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: true, backend: "prompt", model: "fake/usage-exhausted" },
          models: { quick: ["fake/healthy"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
          debug: { enabled: true },
        },
      });
      const now = Date.now();
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/usage-exhausted": {
          failures: [now], openUntil: now + 60 * 60_000,
          lastFailureReason: "allowance_exhausted:text_heuristic:model-only",
        } },
      }));
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["classify then route without the blocked classifier"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 0,
        "the known active model is skipped before classifier transport or generation");
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "default-tier routing continues without a provider-backed classifier call");
      const events = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.module === "classifier" && event.event === "allowance_cooldown_skip"
        && event.model === "fake/usage-exhausted" && event.scope === "model-only"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not invoke a registered v2 prompt classifier while its generation circuit is open", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-classifier-circuit-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-classifier-circuit-work-"));
    try {
      const config = v2Config({ classifier: { enabled: true, backend: "prompt", model: "fake/usage-exhausted" } });
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
        bifrost: { ...config, models: { quick: ["fake/healthy"] }, debug: { enabled: true } },
      });
      const now = Date.now();
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/usage-exhausted": { failures: [now], openUntil: now + 60 * 60_000, trialActive: false } },
      }));
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["/bifrost reliability migrate", "classify locally because classifier model is circuit-open"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 0,
        "the same registered model is not called as a classifier while its v2 generation circuit is open");
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "classification falls through to the configured default route");
      assert.match(result.stderr, /Bifrost auto: quick → fake\/healthy/);
      const events = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.module === "classifier" && event.event === "generation_circuit_unavailable_skip"
        && event.model === "fake/usage-exhausted" && event.scope === "model-only"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

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
        config: { ...v2Config({ classifier: { enabled: false } }), models: { quick: ["fake/fail-then-ok"] }, debug: { enabled: true } },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
        messages: ["secret-lifecycle-prompt-sentinel"],
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

      const traceText = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8");
      const trace = traceText.trim().split("\n").map((line) => JSON.parse(line));
      const userRequest = trace.find((row) => row.module === "virtual" && row.event === "request" && row.reason === "user");
      const retryRequest = trace.find((row) => row.module === "virtual" && row.event === "request" && row.reason === "retry");
      assert.ok(userRequest?.turn_correlation_id && retryRequest?.turn_correlation_id,
        "normal Pi shutdown must flush correlated Auto request records");
      assert.equal(userRequest.turn_correlation_id, retryRequest.turn_correlation_id,
        "Pi's retry belongs to the same proven user turn");
      assert.notEqual(userRequest.request_correlation_id, retryRequest.request_correlation_id,
        "the initial request and host retry have distinct log-only request IDs");
      assert.equal(userRequest.session_correlation_id, retryRequest.session_correlation_id);
      const retryTurn = userRequest.turn_correlation_id;
      assert.ok(trace.some((row) => row.event === "selected" && row.turn_correlation_id === retryTurn && row.model === "fake/fail-then-ok"));
      assert.ok(trace.some((row) => row.event === "admitted" && row.turn_correlation_id === retryTurn && row.status === "admitted"));
      assert.ok(trace.some((row) => row.event === "outcome_observed" && row.turn_correlation_id === retryTurn && row.outcome === "failure"));
      assert.ok(trace.some((row) => row.event === "outcome_observed" && row.turn_correlation_id === retryTurn && row.outcome === "success"));
      assert.ok(trace.some((row) => row.event === "receipt_settled" && row.turn_correlation_id === retryTurn && row.status === "confirmed"));
      assert.equal(traceText.includes("secret-lifecycle-prompt-sentinel"), false);
      assert.equal(traceText.includes("ownerToken"), false);
      assert.equal(traceText.includes(Object.keys(state.dispatches)[0]), false, "internal receipt IDs stay out of the log");
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
