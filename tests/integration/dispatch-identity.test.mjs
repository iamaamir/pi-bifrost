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
const OBSERVER = join(__dirname, "dispatch-identity-observer.mjs");
const LATER_HANDLER = join(__dirname, "dispatch-identity-later-handler.mjs");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const MAX_CAPTURE_CHARS = 64 * 1024;

function appendBounded(current, chunk) {
  return current.length >= MAX_CAPTURE_CHARS
    ? current
    : current + chunk.slice(0, MAX_CAPTURE_CHARS - current.length);
}

function stopChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("close", () => {
      clearTimeout(forceKill);
      resolve();
    });
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
      } catch {
        // Wait for the server's complete one-line startup record.
      }
    });
    child.on("error", () => { void fail("fake provider failed before startup"); });
    child.on("close", () => {
      if (!settled) void fail("fake provider exited before startup");
    });
  });
}

function writeFixture({ home, work, port, bifrost }) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [{ id: "healthy", reasoning: false }],
      },
    },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify(bifrost));
}

function runPi({ home, work, report, model, negative = false, generateExtensionTurn = false, prompt }) {
  const args = ["-e", OBSERVER];
  if (negative || generateExtensionTurn) args.push("-e", LATER_HANDLER);
  args.push("--approve", "--no-session", "--no-tools", "--model", model, "-p", prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(PI, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        PI_SKIP_VERSION_CHECK: "1",
        BIFROST_DISPATCH_IDENTITY_REPORT: report,
        ...(negative ? { BIFROST_DISPATCH_IDENTITY_NEGATIVE: "1" } : {}),
        ...(generateExtensionTurn ? { BIFROST_DISPATCH_IDENTITY_GENERATE: "1" } : {}),
      },
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
    }, 45_000);
    child.on("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      await stopChild(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      if (timedOut) {
        reject(new Error(`pinned Pi timed out and exited after termination (stdout=${stdout.length}, stderr=${stderr.length})`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function readEvents(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readPinnedPiVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["--version"]);
    let output = "";
    let timedOut = false;
    let forceKill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output = appendBounded(output, chunk); });
    child.on("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      await stopChild(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      if (timedOut || code !== 0) {
        reject(new Error(`pinned Pi version command failed (timedOut=${timedOut}, exitCode=${code})`));
        return;
      }
      resolve(output.trim());
    });
  });
}

function fixtureConfig() {
  return {
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: false },
    models: { quick: ["fake/healthy"] },
  };
}

describe("pinned Pi dispatch identity evidence", { timeout: 180_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
  });
  after(async () => {
    if (server) await stopChild(server.child);
  });

  it("binds physical and Auto turn_end IDs to the exact persisted assistant entry", async () => {
    assert.equal(await readPinnedPiVersion(), "1.0.1");

    for (const model of ["fake/healthy", "bifrost/auto"]) {
      const home = mkdtempSync(join(tmpdir(), "bifrost-dispatch-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-dispatch-work-"));
      const report = join(work, "identity.jsonl");
      try {
        writeFixture({ home, work, port: server.port, bifrost: fixtureConfig() });
        const result = await runPi({ home, work, report, model, prompt: "identity fixture prompt" });
        assert.equal(result.code, 0, result.stderr);

        const events = readEvents(report);
        const end = events.find((event) => event.type === "turn_end");
        assert.ok(end, `turn_end evidence missing for ${model}`);
        assert.equal(end.messageEntryMatchesEventObject, true);
        assert.ok(end.messageEntryId);
        assert.equal(end.entryRole, "assistant");

        const providerContext = events.find((event) => event.type === "provider_context");
        assert.ok(providerContext, `provider context evidence missing for ${model}`);
        assert.equal(providerContext.latestUserUniqueContentTimestampMatch, true);
        assert.ok(providerContext.matchedUserEntryId);
        assert.equal(providerContext.latestUserReferenceMatchesBranch, false,
          "content/time equality is diagnostic only because Pi projects user messages");

        if (model === "bifrost/auto") {
          const route = events.find((event) => event.type === "auto_route");
          assert.ok(route, "the test facade observes Bifrost's actual Auto route callback");
          assert.equal(route.reason, "user");
          assert.equal(route.latestUserReferenceMatchesBranch, true,
            "Auto request.messages preserves the branch user object");
          assert.ok(route.latestUserReferenceEntryId);
          assert.equal(route.latestUserUniqueContentTimestampMatch, true);
          assert.equal(route.matchedUserEntryId, route.latestUserReferenceEntryId);
          assert.equal(providerContext.selectedModelIsBifrostAuto, true,
            "provider context follows Bifrost's Auto request");
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
  });

  it("shows that a later extension can consume input without a user turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-dispatch-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-dispatch-work-"));
    const report = join(work, "identity.jsonl");
    try {
      writeFixture({ home, work, port: server.port, bifrost: fixtureConfig() });
      const result = await runPi({
        home,
        work,
        report,
        model: "fake/healthy",
        negative: true,
        prompt: "handled-identity-fixture",
      });
      assert.equal(result.code, 0, result.stderr);

      const events = readEvents(report);
      const handled = events.find((event) => event.type === "later_input_handled");
      assert.ok(handled, "the extension loaded after Bifrost must handle the original input");
      assert.equal(handled.source, "interactive");
      assert.equal(events.some((event) => event.type === "turn_end"), false,
        "a handled input creates no assistant turn to settle");
      const inputSeen = events.filter((event) => event.type === "input_seen");
      assert.deepEqual(inputSeen.map((event) => event.source), ["interactive"]);
      assert.equal(inputSeen[0].matchesHandledFixture, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("binds a separate extension-generated turn to its new branch user entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-dispatch-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-dispatch-work-"));
    const report = join(work, "identity.jsonl");
    try {
      writeFixture({ home, work, port: server.port, bifrost: fixtureConfig() });
      const result = await runPi({
        home,
        work,
        report,
        model: "bifrost/auto",
        generateExtensionTurn: true,
        prompt: "identity fixture prompt",
      });
      assert.equal(result.code, 0, result.stderr);

      const events = readEvents(report);
      const extensionTurn = events.find((event) => event.type === "extension_turn_requested" && event.accepted);
      assert.ok(extensionTurn,
        `extension user message was not accepted: ${JSON.stringify(events)}`);
      const ends = events.filter((event) => event.type === "turn_end");
      assert.equal(ends.length, 2, "original and extension-generated turns should both end");
      assert.ok(ends.every((end) => end.messageEntryMatchesEventObject));
      assert.ok(ends.every((end) => end.nearestUserEntryId));
      const extensionReceipt = events.find((event) => event.type === "extension_turn_attempt");
      assert.ok(extensionReceipt);
      assert.equal(extensionReceipt.priorUserEntryIds.includes(ends[1].nearestUserEntryId), false,
        "the extension-generated turn uses a new branch user entry");
      const contexts = events.filter((event) => event.type === "provider_context");
      const routes = events.filter((event) => event.type === "auto_route");
      assert.equal(contexts.length, 2);
      assert.equal(routes.length, 2);
      assert.deepEqual(contexts.map((event) => event.matchedUserEntryId), ends.map((event) => event.nearestUserEntryId));
      assert.ok(contexts.every((event) => event.latestUserUniqueContentTimestampMatch));
      assert.ok(contexts.every((event) => event.selectedModelIsBifrostAuto));
      assert.ok(routes.every((event) => event.reason === "user"));
      assert.ok(routes.every((event) => event.latestUserUniqueContentTimestampMatch));
      assert.ok(routes.every((event) => event.latestUserReferenceMatchesBranch));
      assert.deepEqual(routes.map((event) => event.latestUserReferenceEntryId), ends.map((event) => event.nearestUserEntryId));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
