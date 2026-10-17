import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION = join(ROOT, "index.ts");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let server;
let port;

function startFakeServer() {
  const child = spawn("node", [join(ROOT, "scripts/fake-provider-server.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("fake provider start timeout")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        if (ready.port) { clearTimeout(timer); resolve({ child, port: ready.port }); }
      } catch { /* wait for complete readiness JSON */ }
    });
    child.once("error", reject);
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bifrost-config-startup-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  const models = ["healthy", "classifier"].map((id) => ({
    id, name: id, reasoning: false, input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000, maxTokens: 1000,
  }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only", models,
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(work, "bifrost.json"), JSON.stringify({
    enabled: true, default: "general", strategy: "first", models: { general: ["fake/healthy"] },
    rules: [], classifier: { enabled: false }, cache: { enabled: false },
  }));
  writeFileSync(join(work, ".pi", "bifrost.json"), '{"schemaVersion":2,"tierPolicies":{"general":{"fallbackTiers":[]}}');
  return { root, home, work, agent };
}

async function stats() {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function runPi({ home, work }) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network.log"),
  };
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", "fake/healthy", "-p", "synthetic startup policy request"], {
      cwd: work, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi startup acceptance timed out")); }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function startRpc({ home, work }) {
  const child = spawn("pi", ["-e", EXTENSION, "--approve", "--mode", "rpc", "--no-session", "--no-tools", "--model", "bifrost/auto"], {
    cwd: work,
    env: {
      PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
      BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network.log"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  let pending = "";
  let stderr = "";
  let wake;
  let closed;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code) => { closed = code; wake?.(); resolve(code); }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${pending}${chunk}`.split("\n"); pending = lines.pop();
    for (const line of lines) { try { records.push(JSON.parse(line)); } catch { /* wait for the expected response */ } }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });
  const wait = (deadline) => new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now())); wake = finish;
  });
  async function prompt(message) {
    const id = `config-acceptance-${Date.now()}-${records.length}`;
    const start = records.length;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    const deadline = Date.now() + 30_000;
    let index = start;
    let started = false;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          started = record.data?.disposition === "started";
          if (!started) return;
        }
        if (started && record.type === "agent_settled") return;
      }
      assert.ifError(spawnError);
      assert.equal(closed, undefined, `Pi RPC exited before handling: ${message}`);
      await wait(deadline);
    }
    throw new Error(`Pi RPC timed out: ${message}\n${stderr}`);
  }
  async function close() {
    child.stdin.end();
    await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (closed === undefined) { child.kill("SIGKILL"); await childClosed; }
    assert.equal(closed, 0, stderr);
  }
  return { prompt, close, get stderr() { return stderr; } };
}

describe("startup config source acceptance", { timeout: 60_000, concurrency: 1 }, () => {
  before(async () => { const ready = await startFakeServer(); server = ready.child; port = ready.port; });
  after(() => server?.kill("SIGTERM"));

  it("blocks generation when a project config source is malformed", async () => {
    const paths = fixture();
    try {
      const before = await stats();
      const result = await runPi(paths);
      const after = await stats();
      const requests = after.stats.slice(before.stats.length);
      assert.deepEqual(requests, [],
        `malformed project policy must prevent probes, classification, and generation; got ${JSON.stringify(requests)}\n${result.stderr}`);
      assert.match(result.stderr, /project config is not valid JSON/u);
      if (existsSync(join(paths.home, "network.log"))) assert.equal(readFileSync(join(paths.home, "network.log"), "utf8"), "");
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });

  it("blocks paid setup and routing when a project source exceeds the config read bound", async () => {
    const paths = fixture();
    try {
      writeFileSync(join(paths.work, ".pi", "bifrost.json"), Buffer.alloc(10_000_001, 0x20));
      const before = await stats();
      const result = await runPi(paths);
      const requests = (await stats()).stats.slice(before.stats.length);
      assert.deepEqual(requests, [],
        `oversized project source must prevent probes, classification, and generation; got ${JSON.stringify(requests)}\n${result.stderr}`);
      assert.match(result.stderr, /size limit/u);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });

  it("blocks generation when a higher supported schema masks an unsupported lower layer", async () => {
    const paths = fixture();
    try {
      writeFileSync(join(paths.work, "bifrost.json"), JSON.stringify({
        schemaVersion: 999, enabled: true, default: "general", strategy: "first",
        models: { general: ["fake/healthy"] }, rules: [], classifier: { enabled: false },
      }));
      writeFileSync(join(paths.work, ".pi", "bifrost.json"), JSON.stringify({
        schemaVersion: 2, models: { general: ["fake/healthy"] },
      }));
      const before = await stats();
      const result = await runPi(paths);
      const after = await stats();
      const requests = after.stats.slice(before.stats.length);
      assert.deepEqual(requests, [],
        `unsupported workspace schema must prevent probes, classification, and generation; got ${JSON.stringify(requests)}\n${result.stderr}`);
      assert.match(result.stderr, /workspace config schemaVersion is unsupported/u);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });

  it("allows routing after reload repairs a malformed startup source", async () => {
    const paths = fixture();
    const projectConfigPath = join(paths.work, ".pi", "bifrost.json");
    const originalBytes = readFileSync(projectConfigPath);
    const rpc = startRpc(paths);
    try {
      const before = await stats();
      await rpc.prompt("synthetic blocked request");
      assert.deepEqual((await stats()).stats.slice(before.stats.length), [], "invalid source must not probe, classify, or generate");
      assert.deepEqual(readFileSync(projectConfigPath), originalBytes, "startup must not rewrite the invalid source");

      writeFileSync(projectConfigPath, JSON.stringify({
        schemaVersion: 2,
        models: { general: ["fake/healthy"] },
        tierPolicies: { general: { fallbackTiers: [] } },
      }));
      await rpc.prompt("/bifrost reload");
      const beforeRepairedPrompt = await stats();
      await rpc.prompt("synthetic repaired request");
      const afterRepairedPrompt = await stats();
      assert.equal(afterRepairedPrompt.stats.slice(beforeRepairedPrompt.stats.length).filter((item) => item.kind === "generation").length, 1);
    } finally {
      await rpc.close();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});
