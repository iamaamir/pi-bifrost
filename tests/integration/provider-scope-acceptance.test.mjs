// ── Provider routing scope acceptance ────────────────────────────
// Runs the real Pi extension against the fake provider server with two
// configured providers and a hard `routingScope`. Proves that Bifrost
// dispatches only to the permitted provider and that an excluded
// provider receives zero generation requests.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const EXTENSION_PATH = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let fakePort;
let server;

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
        if (parsed.port) { settled = true; clearTimeout(timer); resolve({ child, port: parsed.port }); }
      } catch { /* partial JSON; wait for more */ }
    });
    child.on("error", fail);
    child.on("close", () => fail(new Error("fake server exited before ready")));
  });
}

function writeFixture({ home, work, port, bifrost }) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  const providers = {};
  for (const provider of ["fake", "scoped"]) {
    providers[provider] = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: provider === "fake" ? "fixture-only" : `fixture-${provider}`,
      models: [{ id: "chat", reasoning: false }],
    };
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify(bifrost));
}

function piTestEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${OUTBOUND_GUARD}`.trim(),
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
  };
}

function runAuto({ home, work, prompt }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-e", EXTENSION_PATH, "--approve", "--no-session", "--no-tools", "--model", "bifrost/auto", "-p", prompt], {
      stdio: ["ignore", "pipe", "pipe"], env: piTestEnv(home), cwd: work,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("pi provider-scope run timed out")); }, 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function stats() {
  const response = await fetch(`http://127.0.0.1:${fakePort}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function assertNoNetworkViolations(home) {
  const path = join(home, "test-network-violations.log");
  if (!existsSync(path)) return;
  assert.equal(readFileSync(path, "utf8"), "", "test network guard recorded a blocked external request");
}

const scopeConfig = (providers, models) => ({
  schemaVersion: 2,
  enabled: true,
  default: "general",
  strategy: "first",
  models: { general: models },
  rules: [],
  classifier: { enabled: false },
  cache: { enabled: false },
  tierPolicies: { general: { fallbackTiers: [] } },
  routingScope: { providers },
});

describe("provider routing scope acceptance", { timeout: 120_000, concurrency: 1 }, () => {
  before(async () => { const ready = await startFakeServer(); server = ready.child; fakePort = ready.port; });
  after(() => server?.kill("SIGTERM"));

  for (const [permitted, excluded, order] of [
    ["fake", "scoped", ["scoped/chat", "fake/chat"]],
    ["scoped", "fake", ["fake/chat", "scoped/chat"]],
  ]) {
    it(`dispatches to ${permitted} and never reaches ${excluded}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "bifrost-provider-scope-"));
      const home = join(root, "home");
      const work = join(root, "work");
      try {
        writeFixture({ home, work, port: fakePort, bifrost: scopeConfig([permitted], order) });
        const before = await stats();
        const result = await runAuto({ home, work, prompt: "synthetic provider scope request" });
        const requests = (await stats()).stats.slice(before.stats.length);
        const generations = requests.filter((item) => item.kind === "generation");

        assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
        assert.equal(generations.length, 1, `expected one dispatch, got ${JSON.stringify(requests)}`);
        assert.equal(generations[0].provider, permitted);
        assert.equal(generations[0].model, "chat");
        assert.equal(requests.some((item) => item.provider === excluded), false,
          `${excluded} must receive zero requests, got ${JSON.stringify(requests)}`);
        assertNoNetworkViolations(home);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
