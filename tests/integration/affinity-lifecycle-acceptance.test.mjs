import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const MAX_CAPTURE_CHARS = 64 * 1024;
const temporary = [];
let fakeServer;

function appendBounded(current, chunk) {
  return current.length >= MAX_CAPTURE_CHARS ? current : current + chunk.slice(0, MAX_CAPTURE_CHARS - current.length);
}

function startFakeServer() {
  const child = spawn(process.execPath, [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => fail("fake provider startup timed out"), 10_000);
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(message));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = appendBounded(output, chunk);
      try {
        const ready = JSON.parse(output);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ child, port: ready.port });
      } catch { /* wait for the complete startup JSON line */ }
    });
    child.once("error", () => fail("fake provider failed before startup"));
    child.once("close", () => fail("fake provider exited before startup"));
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("close", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

function makeFixture(port, { affinityMode = "retain-within-tier" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-affinity-branch-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-affinity-branch-work-"));
  temporary.push(home, work);
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(work, ".pi"), { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: "branch-fixture-only",
    models: ["alpha", "beta"].map((id) => ({ id, reasoning: false })),
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify({
    schemaVersion: 2,
    enabled: true,
    default: "quick",
    strategy: "random",
    categoryStrategies: { quick: "random", general: "first", frontier: "first" },
    classifier: { enabled: false },
    models: { quick: ["fake/alpha", "fake/beta"], frontier: ["fake/beta"] },
    affinity: { mode: affinityMode },
    reliability: { stateVersion: 1 },
    debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
  }));
  const rngExtension = join(work, "affinity-rng-extension.mjs");
  writeFileSync(rngExtension, `
    let inputIndex = 0;
    let active = false;
    let draws = 0;
    const values = [0.05, 0.95, 0.95, 0.95];
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
        if (active) active = false;
      });
    }
  `);
  return { home, work, agentDir, rngExtension };
}

function startRpc({ home, work, port, rngExtension }) {
  const child = spawn(PI, ["-e", EXTENSION, "-e", rngExtension, "--approve", "--mode", "rpc", "--no-tools", "--model", "bifrost/auto"], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
      BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
    },
  });
  const records = [];
  let remainder = "";
  let stderr = "";
  let closeInfo;
  let spawnError;
  let wake;
  const closed = new Promise((resolve) => child.once("close", (code) => {
    closeInfo = { code };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError = error; wake?.(); });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${remainder}${chunk}`.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > MAX_CAPTURE_CHARS || records.length >= 2000) continue;
      try { records.push(JSON.parse(line)); } catch { /* malformed protocol lines fail the awaited command */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); wake?.(); });

  function waitFor(predicate, start, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const scan = () => {
        clearTimeout(timer);
        for (let index = start; index < records.length; index++) {
          if (predicate(records[index])) return finish(null, records[index]);
        }
        if (spawnError) return finish(spawnError);
        if (closeInfo) return finish(new Error(`Pi RPC exited before ${description} (exit ${closeInfo.code}).`));
        if (Date.now() >= deadline) return finish(new Error(`Pi RPC timed out waiting for ${description}. ${stderr}`));
        timer = setTimeout(scan, 20);
        wake = scan;
      };
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer);
        if (wake === scan) wake = undefined;
        error ? reject(error) : resolve(value);
      };
      scan();
    });
  }

  async function command(type, fields = {}) {
    const id = `affinity-${Date.now()}-${records.length}-${type}`;
    const start = records.length;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await waitFor((record) => record.type === "response" && record.id === id, start, 20_000, `${type} response`);
    assert.equal(response.success, true, `Pi RPC ${type} failed`);
    return response.data;
  }

  async function prompt(message) {
    const id = `affinity-prompt-${Date.now()}-${records.length}`;
    const start = records.length;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    const response = await waitFor((record) => record.type === "response" && record.id === id, start, 30_000, "prompt preflight");
    assert.equal(response.success, true, "Pi accepted the synthetic prompt");
    assert.equal(response.data?.disposition, "started", "prompt should start generation");
    await waitFor((record) => record.type === "agent_settled", start, 30_000, "agent settlement");
  }

  let closePromise;
  function close() {
    if (!closePromise) {
      closePromise = (async () => {
        child.stdin.end();
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (!closeInfo) {
          child.kill("SIGKILL");
          await closed;
        }
        assert.equal(closeInfo.code, 0, "Pi RPC should shut down cleanly");
      })();
    }
    return closePromise;
  }

  return { command, prompt, close, get records() { return records; }, get stderr() { return stderr; } };
}

async function fakeStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function branchProjection(entries) {
  const shape = entries.map((entry) => ({
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId ?? null,
    ...(entry.type === "message" && entry.message?.role === "assistant" ? {
      provider: entry.message.provider,
      model: entry.message.model,
      stopReason: entry.message.stopReason,
    } : {}),
  }));
  return {
    ids: shape.map((entry) => entry.id),
    fingerprint: createHash("sha256").update(JSON.stringify(shape)).digest("hex"),
    assistants: shape.filter((entry) => entry.type === "message" && entry.provider).map(({ id, provider, model }) => ({ id, model: `${provider}/${model}` })),
  };
}

function routeProjection(work) {
  return readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.module === "virtual" && entry.event === "route_decision")
    .map((entry) => ({
      selected: entry.decision?.selected,
      selectedTier: entry.decision?.selectedTier,
      strategyWinner: entry.decision?.affinity?.strategyWinner,
      affinitySelection: entry.decision?.affinity?.selection,
      affinityMode: entry.decision?.affinity?.mode,
    }));
}

describe("Pi RPC branch-local affinity acceptance", { timeout: 120_000, concurrency: 1 }, () => {
  before(async () => { fakeServer = await startFakeServer(); });
  after(async () => { if (fakeServer?.child) await stopChild(fakeServer.child); });
  after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

  it("retains same-tier affinity, bypasses it for another tier, and drops it after an RPC fork", async () => {
    const controlFixture = makeFixture(fakeServer.port, { affinityMode: "off" });
    const controlPi = startRpc({ ...controlFixture, port: fakeServer.port });
    let controlBefore;
    let controlAfter;
    try {
      controlBefore = await fakeStats(fakeServer.port);
      await controlPi.prompt("branch-lifecycle control first synthetic turn");
      await controlPi.prompt("branch-lifecycle control second synthetic turn");
      controlAfter = await fakeStats(fakeServer.port);
      assertNoNetworkViolations(controlFixture.home);
      await controlPi.close();
      const controlRoutes = routeProjection(controlFixture.work);
      assert.deepEqual(controlRoutes.map((route) => route.selected), ["fake/alpha", "fake/beta"],
        "with affinity off, the same deterministic strategy sequence selects beta on the second turn");
    } finally {
      await controlPi.close();
    }

    const fixture = makeFixture(fakeServer.port);
    const pi = startRpc({ ...fixture, port: fakeServer.port });
    let beforeStats;
    let afterStats;
    try {
      beforeStats = controlAfter;
      await pi.prompt("branch-lifecycle first same-tier synthetic turn");
      await pi.prompt("branch-lifecycle second same-tier synthetic turn");
      await pi.prompt("frontier branch-lifecycle explicit other-tier synthetic turn");
      const originalStats = await pi.command("get_session_stats");
      const originalEntries = (await pi.command("get_entries")).entries;
      const originalBranch = branchProjection(originalEntries);
      const forkMessages = (await pi.command("get_fork_messages")).messages;
      const forkPoint = forkMessages[0]?.entryId;
      assert.equal(typeof forkPoint, "string", "Pi exposes a fork point for the first user turn");
      assert.equal(forkMessages[0]?.text, "branch-lifecycle first same-tier synthetic turn",
        "the first RPC fork choice is the first same-tier synthetic turn");
      assert.equal(originalEntries.some((entry) => entry.id === forkPoint
        && entry.type === "message"
        && entry.message?.role === "user"), true,
      "the selected RPC fork id maps to a user entry in the original session branch");
      const discardedAssistantId = originalBranch.assistants[0]?.id;
      assert.equal(typeof discardedAssistantId, "string", "the original branch contains a successful assistant entry");

      const forkResult = await pi.command("fork", { entryId: forkPoint });
      assert.equal(forkResult.cancelled, false, "the real RPC fork should create the child branch");
      const forkedStats = await pi.command("get_session_stats");
      const forkedBranch = branchProjection((await pi.command("get_entries")).entries);
      assert.notEqual(forkedStats.sessionId, originalStats.sessionId, "fork creates a distinct Pi session branch ID");
      assert.equal(forkedBranch.ids.includes(discardedAssistantId), false, "the chosen fork point discards the previous successful assistant proof");

      await pi.prompt("branch-lifecycle same-tier prompt on forked branch");
      afterStats = await fakeStats(fakeServer.port);
      await pi.close();
      const routes = routeProjection(fixture.work);
      assert.equal(routes.length, 4, "one route decision per RPC prompt");
      assert.equal(routes[0].selected, "fake/alpha");
      assert.equal(routes[1].strategyWinner, "fake/beta");
      assert.equal(routes[1].selected, "fake/alpha", "a proven same-tier anchor wins over the next random strategy result");
      assert.equal(routes[1].affinitySelection, "retained_anchor");
      assert.equal(routes[2].selectedTier, "frontier");
      assert.equal(routes[2].selected, "fake/beta", "an explicit other tier bypasses the quick-tier anchor");
      assert.equal(routes[2].affinitySelection, "not_applicable");
      assert.equal(routes[3].strategyWinner, "fake/beta");
      assert.equal(routes[3].selected, "fake/beta", "the forked branch uses its strategy result instead of the discarded branch anchor");
      assert.equal(routes[3].affinitySelection, "no_anchor", "the forked branch has no proven anchor from the discarded branch");

      const attemptCounts = Object.fromEntries(Object.entries(afterStats.attempts)
        .map(([model, count]) => [model, count - (beforeStats.attempts[model] ?? 0)])
        .filter(([, count]) => count > 0));
      assert.deepEqual(attemptCounts, { alpha: 2, beta: 2 }, "the four user prompts produce exactly four counted fake-provider attempts");
      const generatedCounts = Object.fromEntries(["alpha", "beta"].map((model) => [model, afterStats.stats
        .filter((stat) => stat.model === model && stat.kind === "generation").length - beforeStats.stats
        .filter((stat) => stat.model === model && stat.kind === "generation").length]).filter(([, count]) => count > 0));
      assert.deepEqual(generatedCounts, { alpha: 2, beta: 2 }, "two retained/explicit and two strategy-selected generations reach the expected models");
      const evidence = {
        event: "affinity_branch_lifecycle",
        models: routes.map((route) => ({ selected: route.selected, tier: route.selectedTier ?? "quick", affinitySelection: route.affinitySelection })),
        strategyWinners: routes.map((route) => route.strategyWinner ?? null),
        requests: { allAttempts: attemptCounts, generationAttempts: generatedCounts },
        branches: {
          originalSessionId: originalStats.sessionId,
          forkedSessionId: forkedStats.sessionId,
          originalFingerprint: originalBranch.fingerprint,
          forkedFingerprint: forkedBranch.fingerprint,
          forkPointId: forkPoint,
          discardedAssistantId,
        },
      };
      const eventFile = process.env.BIFROST_ACCEPTANCE_EVENTS;
      if (eventFile) {
        mkdirSync(dirname(eventFile), { recursive: true });
        writeFileSync(eventFile, `${JSON.stringify(evidence)}\n`, { flag: "a" });
      }
      assertNoNetworkViolations(fixture.home);
    } finally {
      await pi.close();
    }
  });
});

function assertNoNetworkViolations(home) {
  const violations = join(home, "network-violations.log");
  if (existsSync(violations)) assert.equal(readFileSync(violations, "utf8"), "", "the RPC process attempted outbound network access");
}
