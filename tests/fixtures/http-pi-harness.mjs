// ── Shared HTTP Pi + RPC test fixture ────────────────────────────
//
// ONE copyable helper for tests that drive the real Pi CLI against the local
// HTTP fake provider (`scripts/fake-provider-server.mjs`) through the real
// Bifrost extension (`index.ts`). It extracts only the mechanics that were
// duplicated across tests/integration/command-policy-acceptance.test.mjs and
// tests/integration/legacy-behavior.test.mjs:
//
//   - isolated child environment with the outbound guard pinned to the exact
//     fake-provider origin (plus an ambient-inheriting variant for older
//     callers that must keep their existing environment-selection semantics);
//   - the fake-provider server-ready handshake and guarded shutdown;
//   - the local pinned Pi binary invoked with the real extension;
//   - the correlated JSON-RPC prompt / `agent_settled` wait;
//   - provider `/_stats` reads and explicit delta helpers;
//   - guarded shutdown that observes child close AND owned-group absence.
//
// No provider framework is introduced: this is test-only plumbing around the
// pinned Pi CLI, the fake HTTP server, and the real extension. It mirrors the
// reviewed patterns of tests/fixtures/faux-harness.mjs (G01), which owns the
// native AgentSession + faux boundary; this file owns the CLI/RPC + HTTP
// boundary. Do not merge the two.
//
// SCRATCH LIFETIME BELONGS TO THE CALLER. `createHttpFixture` never deletes its
// home/work directories on failure; call `cleanup()` only after every Pi
// process is closed — `runPi` and `rpc.close()` verify owned-group absence and
// must fail rather than proceed while a group might still live.
//
// ── Copyable HTTP scenario recipe ───────────────────────────────
//  1. const server = await startFakeProviderServer();
//  2. const fixture = createHttpFixture({ prefix, port: server.port, models, config });
//  3. const before = await readStats(server.port);
//  4. const result = await runPi({ fixture, server, args: ["-p", "task"] });
//     assertOffline(result);                       // exit 0, inside deadline, no violations
//  5. const after = await readStats(server.port);
//     assert.deepEqual(statsEntriesDelta(before, after).map((e) => [e.kind, e.model]), [["generation", "chat"]]);
//     assert.deepEqual(attemptsDelta(before, after), { chat: 1 });
//  6. assert saved state / debug output directly (see module README pointers below)
//  7. await server.stop(); fixture.cleanup();
//
// For an interactive turn:
//   const rpc = startRpc({ fixture, server, model: "bifrost/auto" });
//   try { const turn = await rpc.prompt("/bifrost reload"); /* turn.response, turn.records */ }
//   finally { await rpc.close({ assertClean: true }); }
//
// A caller that adds an assertion must be able to watch it fail against the
// baseline revision; never treat a startup or syntax error as a feature
// failure. Use the server hold/release gate endpoints for deterministic races.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

/** Repository root resolved from this fixture (tests/fixtures → repo root). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Local pinned Pi binary — the version CI installs. Never PATH `pi`. */
export const PI_BIN = join(REPO_ROOT, "node_modules", ".bin", "pi");
/** Real production extension under test. */
export const EXTENSION_PATH = join(REPO_ROOT, "index.ts");
export const FAKE_PROVIDER_SERVER = join(REPO_ROOT, "scripts", "fake-provider-server.mjs");
export const OUTBOUND_GUARD = join(REPO_ROOT, "scripts", "test-outbound-guard.cjs");

/** Bounded deadline for the fake provider's startup record. */
export const PORT_DEADLINE_MS = 10_000;
/** Default bounded deadline for one one-shot Pi run. */
export const PI_DEADLINE_MS = 30_000;
/** Default bounded deadline for one RPC prompt. */
export const RPC_DEADLINE_MS = 30_000;
/** Violation-log filename shared by every migrated HTTP suite. */
export const VIOLATION_LOG_NAME = "network-violations.log";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readViolations(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

// ── Server-ready handshake + guarded shutdown ───────────────────

// Every shared fake provider is owned by creation-time receipt. It stays in the
// caller's process group instead of detaching into its own group: acceptance
// gates cancel a timed-out suite by signalling that group, so a detached child
// would survive as an orphan (PPID 1, its own PGID). The registry below adds
// the second half of cancellation safety — a direct SIGINT/SIGTERM/SIGHUP to
// the owner also tears down its providers before the signal is re-delivered.
const ownedProviderServers = new Set();
let cancellationHandlerInstalled = false;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function installCancellationOwnership() {
  if (cancellationHandlerInstalled) return;
  cancellationHandlerInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      // Signal only creation-recorded providers. Never a group, pattern, or
      // process this fixture did not spawn.
      for (const child of ownedProviderServers) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      // Re-deliver the cancellation so the runner's own signal semantics (or
      // the platform default) still terminate the owner.
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Start `scripts/fake-provider-server.mjs` and wait for its `{"port": N}` ready
 * record. The server is a creation-owned member of the caller's process group,
 * so cancelling that group tears it down. Returns `{ child, port, stop() }`;
 * `stop()` is a guarded shutdown — it terminates the owned child if still
 * alive, then asserts the child closed AND its creation-time pid is absent
 * before resolving, so a denied or failed cleanup throws instead of leaking a
 * stray provider. It never deletes scratch.
 */
export function startFakeProviderServer({ timeoutMs = PORT_DEADLINE_MS } = {}) {
  installCancellationOwnership();
  // Deliberately not detached: the caller's process group is the cancellation
  // boundary owned by the acceptance gate. Ownership is still tracked by the
  // exact child pid recorded at spawn.
  const child = spawn("node", [FAKE_PROVIDER_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  ownedProviderServers.add(child);
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let closeObserved = false;
    const closed = new Promise((resolveClose) => child.once("close", () => { closeObserved = true; resolveClose(); }));
    let stopPromise;
    const stop = ({ graceMs = 2_000 } = {}) => {
      stopPromise ??= stopOwnedChild(child, closed, () => closeObserved, graceMs);
      return stopPromise;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Guarded teardown on the failure path too: await the owned shutdown so
      // its assertions cannot be lost, but never mask the startup error.
      stop({ graceMs: 0 }).then(
        () => reject(error),
        (cleanupError) => reject(new AggregateError(
          [error, cleanupError],
          "fake provider startup failed and its owned process did not shut down cleanly",
        )),
      );
    };
    const timer = setTimeout(() => fail(new Error("fake provider startup timed out")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk;
      try {
        const ready = JSON.parse(output);
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: ready.port, stop });
      } catch { /* wait for the complete startup record */ }
    });
    child.once("error", fail);
    child.once("close", () => fail(new Error("fake provider exited before startup")));
  });
}

/**
 * Guarded shutdown of an owned provider. Signals gracefully, escalates with
 * SIGKILL if the child is still open, then ASSERTS — using only the
 * creation-time pid — that the child closed and the process is absent. A
 * denied or failed cleanup throws rather than returning as if teardown were
 * proven. Removes the child from the cancellation registry only after death is
 * verified, so an unverified provider remains owned.
 */
async function stopOwnedChild(child, closed, isClosed, graceMs) {
  if (!child) return;
  if (!isClosed()) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (graceMs > 0) await Promise.race([closed, delay(graceMs)]);
    if (!isClosed()) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await Promise.race([closed, delay(5_000)]);
    }
  }
  assert.equal(isClosed(), true, "fake provider must close before teardown completes");
  assert.equal(isProcessAlive(child.pid), false, "fake provider process must be absent after close");
  ownedProviderServers.delete(child);
  child.unref();
}

// ── Isolated environment ────────────────────────────────────────

/**
 * Build the guarded child environment.
 *
 * `inherit: false` (default) keeps only PATH/TMPDIR/LANG/TERM from the parent.
 * `inherit: true` starts from a copy of the parent environment minus ambient
 * provider credentials — the older environment-selection contract, preserved so
 * migrating callers do not drift semantically.
 *
 * Either way the child gets an isolated HOME/agent dir, offline mode, the
 * outbound guard, and an exact loopback allowlist for the fake provider origin.
 */
export function piEnvironment({ home, port, violationLog, inherit = false, extra = {} }) {
  const base = inherit
    ? (() => { const env = { ...process.env }; delete env.TYPESAFE_API_KEY; return env; })()
    : Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]));
  return {
    ...base,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: violationLog,
    ...extra,
  };
}

// ── Isolated workspace + synthetic provider catalog ─────────────

/** Write the synthetic fake-provider catalog; `modelDefaults` fill in unspecified fields. */
export function writeProviderCatalog({ home, port, models = [], apiKey = "fixture-only", modelDefaults = {} }) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey,
        models: models.map((model) => ({ ...modelDefaults, ...model })),
      },
    },
  }));
  return agentDir;
}

/** Write Pi's agent settings (retry disabled by default). */
export function writeAgentSettings({ home, settings = { retry: { enabled: false } } }) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

/**
 * Write the project config.
 *
 * `configDir = ".pi"` targets the project source (`<work>/.pi/bifrost.json`);
 * `configDir = ""` targets the legacy workspace source (`<work>/bifrost.json`).
 * `initialConfig` writes raw bytes (to prove byte-for-byte preservation);
 * otherwise `config` is JSON-serialized. Returns the directory it wrote to.
 */
export function writeProjectConfig({ work, configDir = ".pi", config, initialConfig, ownership, ownershipFile = "bifrost-reconcile-ownership.json" }) {
  const directory = configDir ? join(work, configDir) : work;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "bifrost.json"), initialConfig !== undefined ? initialConfig : JSON.stringify(config));
  if (ownership !== undefined) writeFileSync(join(directory, ownershipFile), ownership);
  return directory;
}

/**
 * Create an isolated home/work pair and write the synthetic catalog, agent
 * settings, and project config. Returns `{ home, work, project, violationLog,
 * cleanup() }`. Scratch is deleted only by `cleanup()`, which the caller must
 * invoke after every Pi process is closed.
 */
export function createHttpFixture({ prefix, port, models = [], apiKey, modelDefaults = {}, settings, config, initialConfig, ownership, configDir = ".pi" }) {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const work = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
  writeProviderCatalog({ home, port, models, apiKey, modelDefaults });
  writeAgentSettings({ home, settings });
  const project = writeProjectConfig({ work, configDir, config, initialConfig, ownership });
  return {
    home,
    work,
    project,
    violationLog: join(home, VIOLATION_LOG_NAME),
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

// ── Local pinned Pi (one-shot) ──────────────────────────────────

/**
 * Run the pinned local Pi with the real extension in one-shot (`-p`) mode as a
 * detached, owned process group under a bounded deadline. Returns
 * `{ code, signal, stdout, stderr, violations, timedOut, groupGone }` and never
 * deletes scratch. `onTimeout: "resolve"` returns with `timedOut: true`;
 * `onTimeout: "reject"` preserves the older reject-on-timeout contract.
 */
export function runPi({ fixture, server, args = [], port, violationLog, timeoutMs = PI_DEADLINE_MS, inherit = false, env, extraArgs = [], onTimeout = "resolve" }) {
  const home = fixture?.home;
  const work = fixture?.work;
  const resolvedPort = port ?? server?.port ?? fixture?.port;
  const resolvedViolations = violationLog ?? fixture?.violationLog ?? join(home, VIOLATION_LOG_NAME);
  const childEnv = env ?? piEnvironment({ home, port: resolvedPort, violationLog: resolvedViolations, inherit });
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, ["-e", EXTENSION_PATH, "--approve", "--no-tools", ...args, ...extraArgs], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: childEnv,
    });
    const groupId = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (processGroupExists(groupId)) {
        try { await terminateProcessGroup(child, { graceMs: 1_000, cleanupTimeoutMs: 5_000 }); }
        catch { /* denied cleanup: absence stays unproven */ }
      }
      const groupGone = !processGroupExists(groupId);
      child.unref();
      resolve({ code, signal, stdout, stderr, violations: readViolations(resolvedViolations), timedOut, groupGone });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (onTimeout === "reject") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        reject(new Error(`pi timed out: ${args.join(" ")}`));
        return;
      }
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { process.kill(-groupId, "SIGKILL"); } catch { /* group gone */ } }, 1_000);
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code, signal) => { void finish(code, signal); });
  });
}

// ── Correlated JSON-RPC session ─────────────────────────────────

/**
 * Start the pinned local Pi in RPC mode over stdin/stdout pipes as a detached,
 * owned process group. Returns:
 *
 *   prompt(message, { settle = true })
 *     writes a correlated prompt and waits for its `response`; auto-confirms any
 *     `confirm` UI request; when `settle` is true and the turn started, also
 *     waits for `agent_settled`. Resolves `{ response, records, stderr }` where
 *     `records` is this turn's stdout slice.
 *   userTurn(message)      prompt(message, { settle: true })
 *   close({ assertClean }) ends stdin, waits for close, terminates the owned
 *                          group if needed, and returns
 *                          `{ code, signal, violations, groupGone }`;
 *                          `assertClean` additionally requires exit 0 and no
 *                          recorded network violations.
 *   stderr / records       live stderr text / every parsed record so far.
 */
export function startRpc({ fixture, server, model = "fake/fast", port, violationLog, timeoutMs = RPC_DEADLINE_MS, inherit = false, env, approve = false, extraArgs = [] }) {
  const home = fixture?.home;
  const work = fixture?.work;
  const resolvedPort = port ?? server?.port ?? fixture?.port;
  const resolvedViolations = violationLog ?? fixture?.violationLog ?? join(home, VIOLATION_LOG_NAME);
  const childEnv = env ?? piEnvironment({ home, port: resolvedPort, violationLog: resolvedViolations, inherit });
  const args = ["-e", EXTENSION_PATH];
  if (approve) args.push("--approve");
  args.push("--mode", "rpc", "--no-session", "--no-tools", "--model", model, ...extraArgs);
  const child = spawn(PI_BIN, args, { cwd: work, stdio: ["pipe", "pipe", "pipe"], detached: true, env: childEnv });
  const groupId = child.pid;
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closeInfo;
  let closeObserved = false;
  let spawnError;
  let closePromise;
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeObserved = true;
    closeInfo = { code, signal };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${incompleteLine}${chunk}`.split("\n");
    incompleteLine = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { /* malformed output fails a later assertion */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  const turnResult = (start, stderrStart, response) => ({
    response,
    records: records.slice(start),
    stderr: stderr.slice(stderrStart),
  });

  async function prompt(message, { settle = true } = {}) {
    const id = `http-rpc-${records.length}-${Date.now()}`;
    const start = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = start;
    let response;
    let awaitingSettle = false;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
          continue;
        }
        if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          if (!settle || record.data?.disposition !== "started") return turnResult(start, stderrStart, record);
          response = record;
          awaitingSettle = true;
          continue;
        }
        if (awaitingSettle && record.type === "agent_settled") return turnResult(start, stderrStart, response);
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}`);
  }

  function userTurn(message) {
    return prompt(message, { settle: true });
  }

  async function close({ assertClean = false } = {}) {
    closePromise ??= (async () => {
      child.stdin.end();
      await Promise.race([childClosed, delay(2_000)]);
      if (!closeObserved) {
        try { await terminateProcessGroup(child, { graceMs: 2_000, cleanupTimeoutMs: 5_000 }); }
        catch { /* denied cleanup: absence stays unproven */ }
        await Promise.race([childClosed, delay(2_000)]);
      }
      assert.ok(closeObserved, "Pi RPC child must close before its fixture is removed");
      const violations = readViolations(resolvedViolations);
      const result = { ...closeInfo, violations, groupGone: !processGroupExists(groupId) };
      child.unref();
      if (assertClean) {
        assert.equal(result.code, 0, stderr);
        assert.equal(result.violations, "", "test network guard recorded a blocked external request");
      }
      return result;
    })();
    return closePromise;
  }

  return { prompt, userTurn, close, records, get stderr() { return stderr; } };
}

// ── Provider stats ──────────────────────────────────────────────

/** Read `/_stats` from the fake provider for the given port. */
export async function readStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

/** New `stats` entries recorded since `before` (each `{ kind, model }`). */
export function statsEntriesDelta(before, after) {
  return after.stats.slice(before.stats.length);
}

/** Per-provider attempt deltas keyed by the providers present in `after`. */
export function attemptsDelta(before, after) {
  return Object.fromEntries(Object.keys(after.attempts)
    .map((key) => [key, (after.attempts[key] ?? 0) - (before.attempts[key] ?? 0)]));
}

// ── Shared assertions ───────────────────────────────────────────

/** Parse the `[bifrost-json] ` report line a command writes to stdout/stderr. */
export function reportJson(output) {
  const line = `${output.stderr}\n${output.stdout}`.split("\n").find((item) => item.startsWith("[bifrost-json] "));
  assert.ok(line, `expected Pi command JSON report; output was:\n${output.stderr}\n${output.stdout}`);
  return JSON.parse(line.slice("[bifrost-json] ".length));
}

/** A one-shot Pi run finished cleanly: exit 0, inside its deadline, no violations. */
export function assertOffline(output) {
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.timedOut, false);
  assert.equal(output.violations, "", "Pi attempted a non-fixture network connection");
}
