// Tier-lock regression suite. A companion extension emits bifrost:lock over
// pi.events and sends extension input, proving the lock switches the active
// model, refuses unhealthy tiers, and routes extension-sent prompts.
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

const DRIVER = `
import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.registerCommand("locktest", {
    description: "Lock a Bifrost tier, then send extension prompts",
    handler: async (args, ctx) => {
      const [tier, ...prompts] = args.trim().split(/\\s+/);
      const reply = await new Promise((resolve) => {
        pi.events.emit("bifrost:lock", { tier, owner: "lock-test", reply: resolve });
      });
      const modelAfterLock = ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined;
      for (const prompt of prompts) {
        pi.sendUserMessage(prompt);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await ctx.waitForIdle();
      }
      writeFileSync(process.env.LOCK_TEST_OUT, JSON.stringify({ reply, modelAfterLock }));
    },
  });
}
`;

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

async function serverStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  return (await response.json()).stats;
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
  writeFileSync(join(home, "lock-driver.mjs"), DRIVER);
}

function runLockTest({ home, work, command, model = "fake/fast" }) {
  const out = join(work, "lock-result.json");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["-e", EXTENSION_PATH, "-e", join(home, "lock-driver.mjs"), "--approve", "--no-session", "--no-tools", "--model", model, "-p", command],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_ACP_DELEGATE_DEPTH: "0", LOCK_TEST_OUT: out },
        cwd: work,
      },
    );
    let stderr = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`pi timed out: ${command}`));
    }, 120_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(readFileSync(out, "utf8"));
      } catch {
        result = undefined;
      }
      resolve({ code, stderr, result });
    });
  });
}

function debugEvents(work) {
  return readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const MODELS = [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }, { id: "fail", reasoning: false }];

function lockConfig(frontier) {
  return {
    enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
    models: { quick: ["fake/fast"], frontier },
    reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
    debug: { enabled: true },
  };
}

describe("tier lock end to end", { timeout: 360_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
  });
  after(() => {
    server?.child.kill();
  });

  async function withFixture(frontier, run) {
    const home = mkdtempSync(join(tmpdir(), "bifrost-lock-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-lock-work-"));
    try {
      writeFixture({ home, work, port: server.port, models: MODELS, bifrost: lockConfig(frontier) });
      await run({ home, work });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }

  it("switches to the locked tier's first healthy model as soon as the lock is accepted", async () => {
    await withFixture(["fake/strong"], async ({ home, work }) => {
      const { code, stderr, result } = await runLockTest({ home, work, command: "/locktest frontier" });
      assert.equal(code, 0, stderr);
      assert.deepEqual(result.reply, { ok: true, tier: "frontier", model: "fake/strong" });
      assert.equal(result.modelAfterLock, "fake/strong");
      assert.match(stderr, /Bifrost: locked to frontier → fake\/strong/);
      assert.doesNotMatch(stderr, /Bifrost pinned/, "the lock switch must not count as a manual /model pin");
    });
  });

  it("rejects the lock and keeps the current model when the tier has no healthy model", async () => {
    await withFixture(["fake/strong"], async ({ home, work }) => {
      mkdirSync(join(work, ".pi"), { recursive: true });
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/strong": { failures: [Date.now()], openUntil: Date.now() + 3_600_000, trialActive: false } },
      }));
      const { code, stderr, result } = await runLockTest({ home, work, command: "/locktest frontier" });
      assert.equal(code, 0, stderr);
      assert.equal(result.reply.ok, false);
      assert.match(result.reply.reason, /no healthy frontier model is available/);
      assert.equal(result.modelAfterLock, "fake/fast");
      const rejected = debugEvents(work).find((entry) => entry.module === "lock" && entry.event === "rejected");
      assert.ok(rejected, "rejection must be logged");
    });
  });

  it("routes extension-sent input to the locked tier", async () => {
    await withFixture(["fake/strong"], async ({ home, work }) => {
      const before = (await serverStats(server.port)).length;
      const { code, stderr, result } = await runLockTest({ home, work, command: "/locktest frontier hello" });
      assert.equal(code, 0, stderr);
      assert.equal(result.reply.ok, true);
      const events = debugEvents(work);
      assert.ok(events.some((entry) => entry.module === "input" && entry.event === "locked" && entry.tier === "frontier"), "extension input must reach the locked route");
      assert.ok(events.some((entry) => entry.module === "input" && entry.event === "model_unchanged" && entry.model === "fake/strong"));
      const sent = (await serverStats(server.port)).slice(before).map((entry) => entry.model);
      assert.deepEqual(sent, ["strong"]);
    });
  });

  it("keeps Bifrost Auto selected and lets it dispatch the locked tier", async () => {
    await withFixture(["fake/strong"], async ({ home, work }) => {
      const { code, stderr, result } = await runLockTest({ home, work, command: "/locktest frontier hello", model: "bifrost/auto" });
      assert.equal(code, 0, stderr);
      assert.deepEqual(result.reply, { ok: true, tier: "frontier", model: "fake/strong" });
      assert.equal(result.modelAfterLock, "bifrost/auto");
      assert.match(stderr, /Bifrost auto: frontier → fake\/strong/);
    });
  });

  it("refuses a locked prompt once the locked tier turns unhealthy instead of falling back", async () => {
    await withFixture(["fake/fail"], async ({ home, work }) => {
      const before = (await serverStats(server.port)).length;
      const { stderr, result } = await runLockTest({ home, work, command: "/locktest frontier first second" });
      // Print mode exits 1 here: the simulated 500 stays the last assistant message.
      assert.match(stderr, /simulated provider failure/);
      assert.deepEqual(result.reply, { ok: true, tier: "frontier", model: "fake/fail" });
      assert.match(stderr, /lock-test locked the frontier tier but no healthy frontier model is available.*prompt not sent/);
      const sent = (await serverStats(server.port)).slice(before).map((entry) => entry.model);
      assert.deepEqual(sent, ["fail"], "the second prompt must neither reach the open circuit nor fall back to the default tier");
    });
  });
});
