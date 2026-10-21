// Legacy physical-routing regression suite. Spins real pi sessions against the
// fake provider and proves v0.4.5-era behavior is intact alongside bifrost/auto:
// input-time routing, /bifrost pin, /bifrost off, and session-restore never
// pinning or flipping state.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHttpFixture,
  readStats,
  runPi as runPinnedPi,
  startFakeProviderServer,
  startRpc,
} from "../fixtures/http-pi-harness.mjs";

let server;

// Legacy fixture policy: workspace-root config source (`<work>/bifrost.json`),
// raw model entries (no injected defaults), the ambient-minus-credentials child
// env, and the older 120s reject-on-timeout contract. The isolated env / server
// handshake / pinned-Pi / RPC / stats / guarded-shutdown mechanics live in the
// shared fixture (tests/fixtures/http-pi-harness.mjs).
function legacyFixture({ models, bifrost }) {
  return createHttpFixture({
    prefix: "bifrost-legacy",
    port: server.port,
    models,
    apiKey: "test",
    config: bifrost,
    configDir: "",
  });
}

async function runPi({ fixture, args }) {
  const result = await runPinnedPi({ fixture, server, args, timeoutMs: 120_000, onTimeout: "reject", inherit: true });
  assert.equal(result.violations, "", "test network guard recorded a blocked external request");
  return result;
}

function readState(work) {
  try {
    return JSON.parse(readFileSync(join(work, ".pi", "bifrost-state.json"), "utf8"));
  } catch {
    return undefined;
  }
}

describe("legacy physical routing regression", { timeout: 240_000, concurrency: 1 }, () => {
  before(async () => {
    server = await startFakeProviderServer();
  });
  after(async () => {
    await server?.stop();
  });

  it("input-time routing still switches models on a rule match", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
      bifrost: {
        enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
        models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
        rules: [{ pattern: "architecture", model: "frontier" }],
        debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
      },
    });
    try {
      const { code, stderr } = await runPi({
        fixture,
        args: ["--no-session", "--model", "fake/fast", "-p", "architecture design"],
      });
      assert.equal(code, 0);
      assert.match(stderr, /\[bifrost\] classify: frontier/);
      const debugLog = readFileSync(join(fixture.work, ".pi", "bifrost-debug.jsonl"), "utf8");
      assert.match(debugLog, /"event":"model_selected"[^}]*"model":"fake\/strong"/, "rule match must select fake/strong");
    } finally {
      fixture.cleanup();
    }
  });

  it("unmatched prompts keep the legacy default-tier fallback", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }],
      bifrost: {
        enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
        models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
        rules: [{ pattern: "architecture", model: "frontier" }],
      },
    });
    try {
      const { code, stderr } = await runPi({
        fixture,
        args: ["--no-session", "--model", "fake/fast", "-p", "just chatting"],
      });
      assert.equal(code, 0);
      assert.doesNotMatch(stderr, /\[bifrost\] classify: frontier/);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the active physical model when the resolved tier has no available model", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }],
      bifrost: {
        enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
        models: { quick: ["fake/missing"] },
      },
    });
    try {
      const before = await readStats(server.port);
      const { code, stderr } = await runPi({
        fixture,
        args: ["--no-session", "--model", "fake/fast", "-p", "hello"],
      });
      const after = await readStats(server.port);

      assert.equal(code, 0);
      assert.match(stderr, /no healthy model available/);
      assert.equal((after.attempts.fast ?? 0) - (before.attempts.fast ?? 0), 1,
        "legacy physical mode must continue this turn on Pi's active model");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not generate on the active physical model after an explicit boundary is exhausted", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }],
      bifrost: {
        schemaVersion: 2,
        enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
        models: { quick: ["fake/fast"], restricted: ["fake/missing"] },
        tierPolicies: { restricted: { fallbackTiers: [] } },
        rules: [{ pattern: "restricted", model: "restricted" }],
      },
    });
    try {
      const before = await readStats(server.port);
      const { code, stderr } = await runPi({
        fixture,
        args: ["--no-session", "--model", "fake/fast", "-p", "restricted keep this turn"],
      });
      const after = await readStats(server.port);

      assert.equal(code, 0);
      assert.match(stderr, /tier "restricted" matched but no healthy model available/);
      assert.match(stderr, /the turn was not sent/);
      assert.equal((after.attempts.fast ?? 0) - (before.attempts.fast ?? 0), 0,
        "an exhausted strict physical route must not fall through to Pi's active model");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the last-good strict boundary after a null project reload and blocks active-model generation", async () => {
    const strictConfig = {
      schemaVersion: 2,
      enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
      models: { quick: ["fake/fast"], restricted: ["fake/missing"] },
      tierPolicies: { restricted: { fallbackTiers: [] } },
      rules: [{ pattern: "restricted", model: "restricted" }],
    };
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }],
      bifrost: strictConfig,
    });
    const { work } = fixture;
    try {
      const rpc = startRpc({ fixture, server, model: "fake/fast", approve: true, inherit: true });
      try {
        const handshake = await rpc.prompt("/bifrost inspect --json");
        assert.ok(handshake.records.some((record) => record.type === "response" && record.data?.disposition === "handled"),
          "Pi must finish the inspect handshake with the valid strict config before the source changes");
        writeFileSync(join(work, "bifrost.json"), "null\n");

        const before = await readStats(server.port);
        const reload = await rpc.prompt("/bifrost reload");
        const rejectedTurn = await rpc.prompt("restricted keep this turn");
        const after = await readStats(server.port);
        const messages = [...reload.records, ...rejectedTurn.records]
          .filter((record) => record.type === "extension_ui_request" && record.method === "notify")
          .map((record) => record.message);
        const output = `${messages.join("\n")}\n${rpc.stderr}`;

        assert.match(output, /config reload rejected: workspace config must contain an object/);
        assert.match(output, /strict route for tier "restricted" has no healthy model/);
        assert.match(output, /the turn was not sent/);
        assert.equal((after.attempts.fast ?? 0) - (before.attempts.fast ?? 0), 0,
          "a malformed project layer must not erase the last-good strict boundary and continue on Pi's active model");
      } finally {
        await rpc.close({ assertClean: true });
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("pin locks the current model for the session (deliberately never persisted)", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
      bifrost: {
        enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
        models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
        rules: [{ pattern: "architecture", model: "frontier" }],
      },
    });
    try {
      // Pin takes effect for the session: the rule-matched prompt must not switch.
      const pinned = await runPi({
        fixture,
        args: ["--no-session", "--model", "fake/fast", "-p", "/bifrost pin", "architecture design"],
      });
      assert.equal(pinned.code, 0);
      assert.match(pinned.stderr, /Bifrost pinned/);
      assert.doesNotMatch(pinned.stderr, /\[bifrost\] classify:/, "pinned prompts must bypass routing entirely");
      // pin is session-local by design (runtime-state.ts): never persisted.
      const state = readState(fixture.work);
      assert.notEqual(state?.pinned, true, "pin must not survive the session");
    } finally {
      fixture.cleanup();
    }
  });

  it("/bifrost off disables routing", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }],
      bifrost: { enabled: true, default: "quick", classifier: { enabled: false }, models: { quick: ["fake/fast"] } },
    });
    try {
      const { code } = await runPi({ fixture, args: ["--no-session", "--model", "fake/fast", "-p", "/bifrost off"] });
      assert.equal(code, 0);
      const state = readState(fixture.work);
      assert.equal(state?.enabled, false, "off must persist to runtime state");
    } finally {
      fixture.cleanup();
    }
  });

  it("session restore never pins or flips routing state", async () => {
    const fixture = legacyFixture({
      models: [{ id: "fast", reasoning: false }],
      bifrost: {
        enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
        models: { quick: ["fake/fast"] },
        debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
      },
    });
    const { work } = fixture;
    const sessions = mkdtempSync(join(tmpdir(), "bifrost-legacy-sessions-"));
    try {
      // Turn 1: record a session with model fake/fast active.
      const first = await runPi({
        fixture,
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
        fixture,
        args: ["--session-dir", sessions, "--session", join(sessions, saved[0]), "-p", "and again"],
      });
      assert.equal(second.code, 0);
      const state = readState(work);
      assert.equal(state?.pinned, false, "restore must not pin the replayed model");
      assert.equal(state?.enabled, true, "restore must not flip routing state");
    } finally {
      fixture.cleanup();
      rmSync(sessions, { recursive: true, force: true });
    }
  });
});
