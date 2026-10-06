// Legacy physical-routing regression suite. Spins real pi sessions against the
// fake provider and proves v0.4.5-era behavior is intact alongside bifrost/auto:
// input-time routing, /bifrost pin, /bifrost off, and session-restore never
// pinning or flipping state.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

function runPi({ home, work, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-e", EXTENSION_PATH, "--approve", "--no-tools", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_ACP_DELEGATE_DEPTH: "0" },
      cwd: work,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`pi timed out: ${args.join(" ")}`));
    }, 120_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function readState(work) {
  try {
    return JSON.parse(readFileSync(join(work, ".pi", "bifrost-state.json"), "utf8"));
  } catch {
    return undefined;
  }
}

describe("legacy physical routing regression", { timeout: 240_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
  });
  after(() => {
    server?.child.kill();
  });

  it("input-time routing still switches models on a rule match", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-legacy-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-legacy-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
          rules: [{ pattern: "architecture", model: "frontier" }],
          debug: { enabled: true },
        },
      });
      const { code, stderr } = await runPi({
        home, work,
        args: ["--no-session", "--model", "fake/fast", "-p", "architecture design"],
      });
      assert.equal(code, 0);
      assert.match(stderr, /\[bifrost\] classify: frontier/);
      const debugLog = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8");
      assert.match(debugLog, /"event":"model_selected"[^}]*"model":"fake\/strong"/, "rule match must select fake/strong");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("unmatched prompts keep the legacy default-tier fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-legacy-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-legacy-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
          rules: [{ pattern: "architecture", model: "frontier" }],
        },
      });
      const { code, stderr } = await runPi({
        home, work,
        args: ["--no-session", "--model", "fake/fast", "-p", "just chatting"],
      });
      assert.equal(code, 0);
      assert.doesNotMatch(stderr, /\[bifrost\] classify: frontier/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("pin locks the current model for the session (deliberately never persisted)", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-legacy-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-legacy-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
          rules: [{ pattern: "architecture", model: "frontier" }],
        },
      });
      // Pin takes effect for the session: the rule-matched prompt must not switch.
      const pinned = await runPi({
        home, work,
        args: ["--no-session", "--model", "fake/fast", "-p", "/bifrost pin", "architecture design"],
      });
      assert.equal(pinned.code, 0);
      assert.match(pinned.stderr, /Bifrost pinned/);
      assert.doesNotMatch(pinned.stderr, /\[bifrost\] classify:/, "pinned prompts must bypass routing entirely");
      // pin is session-local by design (runtime-state.ts): never persisted.
      const state = readState(work);
      assert.notEqual(state?.pinned, true, "pin must not survive the session");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("/bifrost off disables routing", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-legacy-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-legacy-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }],
        bifrost: { enabled: true, default: "quick", classifier: { enabled: false }, models: { quick: ["fake/fast"] } },
      });
      const { code } = await runPi({ home, work, args: ["--no-session", "--model", "fake/fast", "-p", "/bifrost off"] });
      assert.equal(code, 0);
      const state = readState(work);
      assert.equal(state?.enabled, false, "off must persist to runtime state");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("session restore never pins or flips routing state", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-legacy-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-legacy-work-"));
    const sessions = mkdtempSync(join(tmpdir(), "bifrost-legacy-sessions-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"] },
          debug: { enabled: true },
        },
      });
      // Turn 1: record a session with model fake/fast active.
      const first = await runPi({
        home, work,
        args: ["--session-dir", sessions, "--model", "fake/fast", "-p", "hello there"],
      });
      assert.equal(first.code, 0);
      const saved = readdirSync(sessions).filter((name) => !name.startsWith("."));
      assert.ok(saved.length > 0, "session file must be saved");
      // Pre-write known state; restore must leave it untouched.
      mkdirSync(join(work, ".pi"), { recursive: true });
      writeFileSync(join(work, ".pi", "bifrost-state.json"), JSON.stringify({ enabled: true, pinned: false, classifierEnabled: true }));
      // Turn 2: restore the recorded session (no --model — Pi replays the selection).
      const second = await runPi({
        home, work,
        args: ["--session-dir", sessions, "--session", join(sessions, saved[0]), "-p", "and again"],
      });
      assert.equal(second.code, 0);
      const state = readState(work);
      assert.equal(state?.pinned, false, "restore must not pin the replayed model");
      assert.equal(state?.enabled, true, "restore must not flip routing state");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(sessions, { recursive: true, force: true });
    }
  });
});
