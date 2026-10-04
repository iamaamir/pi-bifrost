import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const EXTENSION_PATH = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("fake server start timeout")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      try {
        const parsed = JSON.parse(buf);
        if (parsed.port) {
          clearTimeout(timer);
          resolve({ child, port: parsed.port });
        }
      } catch {
        // partial JSON; wait for more
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("fake server exited before ready"));
    });
  });
}

function writeFixture({ home, work, port, models, bifrost }) {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models },
      },
    }),
  );
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(work, "bifrost.json"), JSON.stringify(bifrost));
}

function runAuto({ home, work, messages }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["-e", EXTENSION_PATH, "--approve", "--no-session", "--no-tools", "--model", "bifrost/auto", "-p", ...messages],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1" },
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

describe("auto virtual production path", { timeout: 240_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
  });
  after(() => {
    server?.child.kill();
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
      assert.equal(code, 0);
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
      const { code, stderr } = await runAuto({ home, work, messages: ["hello one", "hello two"] });
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost auto: quick → fake\/fail-then-ok/);
      assert.match(stderr, /Bifrost: keeping fake\/fail-then-ok/);
      const reliability = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability.json"), "utf8"));
      assert.equal(reliability.models["fake/fail-then-ok"].lastFailureSource, "agent_settled");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
