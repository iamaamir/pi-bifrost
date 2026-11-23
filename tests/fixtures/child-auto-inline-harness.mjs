import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(__dirname, "child-auto-inline-extension.mjs");
const DESCENDANT_CLI = join(__dirname, "child-auto-descendant-cli.mjs");
const PIPE_RACE_CLI = join(__dirname, "child-auto-pipe-race-descendant-cli.mjs");
const NORMAL_CLOSE_CLI = join(__dirname, "child-auto-normal-close-cli.mjs");
const RUNNER_WORKER = join(__dirname, "child-auto-runner-worker.mjs");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const CREDENTIALS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

let fakePort;

// Lets a caller that does not start the shared fake provider still build a
// self-consistent environment for a fixture child.
function setFakePort(port) { fakePort = port; }
const trackedChildren = new WeakMap();
// Upper bound for awaiting the close event. A descendant that inherited a
// child's stdio can hold the pipe open after the child itself has exited, so
// the wait is bounded to keep a leak from hanging the suite indefinitely.
const CLOSE_WAIT_MS = 10_000;
// Bounds for the owned-descendant path: a child that never reaches close is
// terminated as the leader of a process group this suite owns, and the result
// is only true when the real close event then arrives.
const DESCENDANT_GRACE_MS = 2_000;
const DESCENDANT_CLEANUP_MS = 5_000;
// How long the leader's own close may take after its grace window before the
// owned group is terminated anyway. Kept short so a stubborn leader cannot
// spend the whole descendant budget before the group phase begins.
const LEADER_CLOSE_SLOP_MS = 2_000;

// Every child this suite owns is spawned as the leader of its own process group
// so cleanup can signal that group and nothing else. Each carries one lifecycle
// record: the observed close event plus a single coordinated termination
// promise. The close path and the timeout path await that same promise, so
// neither can settle while a descendant of the owned group is still alive.
function spawnOwned(command, args, options = {}) {
  const child = spawn(command, args, { detached: process.platform !== "win32", ...options });
  let markClosed;
  const observed = new Promise((resolve) => { markClosed = resolve; });
  const lifecycle = { isClosed: false, observed, termination: null };
  child.once("close", () => {
    lifecycle.isClosed = true;
    markClosed(true);
  });
  lifecycle.terminate = (graceMs) => {
    // Memoized on purpose: one owned group, one termination, one result.
    lifecycle.termination ??= terminateOwnedGroup(child, graceMs);
    return lifecycle.termination;
  };
  trackedChildren.set(child, lifecycle);
  return child;
}

function closeTracking(child) {
  const tracking = trackedChildren.get(child);
  if (!tracking) throw new Error("child was not created by spawnOwned, so its close event is not tracked");
  return tracking;
}

// Resolves true only when the close event has actually been observed. False
// means the bound expired with a descendant still holding an inherited pipe.
function waitForObservedClose(child, boundMs = CLOSE_WAIT_MS) {
  const tracking = closeTracking(child);
  if (tracking.isClosed) return Promise.resolve(true);
  let bound;
  return Promise.race([
    tracking.observed,
    new Promise((resolve) => { bound = setTimeout(() => resolve(false), boundMs); }),
  ]).then((observed) => {
    clearTimeout(bound);
    return observed;
  });
}

// Terminates the owned child and its process group, and resolves true only when
// BOTH halves of the cleanup are proven: the leader's close event was actually
// observed, and the owned group is dead. A close event alone proves nothing --
// a descendant can close the inherited pipes when signalled and keep running,
// and an already-closed leader says nothing about what it left behind. False
// means cleanup could not be verified, and every caller must fail rather than
// assume.
async function terminateOwnedGroup(child, graceMs = 1_000) {
  if (child.exitCode === null && child.signalCode === null) {
    const forceKill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, graceMs);
    try { child.kill("SIGTERM"); } catch {}
    await waitForObservedClose(child, graceMs + LEADER_CLOSE_SLOP_MS);
    clearTimeout(forceKill);
  }
  // Signal only the process group this suite owns. Never a parent or shared
  // group, and never a bare pattern match against unrelated processes. The
  // signal step is injected only when a test asks for it, so the ordinary path
  // is byte-identical to the shared helper's own default.
  const options = { graceMs: DESCENDANT_GRACE_MS, cleanupTimeoutMs: DESCENDANT_CLEANUP_MS };
  if (denyOwnedGroupSignals) options.signalGroup = denyOwnedGroupSignals;
  const groupSignalled = await terminateProcessGroup(child, options);
  // terminateProcessGroup already returns group death; re-derive it here so the
  // result rests on observed evidence rather than on the helper's contract.
  const groupDead = groupSignalled === true && !processGroupExists(child.pid);
  const leaderClosed = await waitForObservedClose(child, DESCENDANT_CLEANUP_MS + CLOSE_WAIT_MS);
  return leaderClosed && groupDead;
}

// Terminates an owned child, resolving true only when its cleanup is verified.
async function stopChild(child, graceMs = 1_000) {
  return closeTracking(child).terminate(graceMs);
}

// Test-only seam: forces one child's cleanup to report failure without touching
// shared state, so a caller's cleanup-failure cause can be asserted directly.
function forceCleanupFailure(child) {
  closeTracking(child).terminate = () => Promise.resolve(false);
}

// Test-only seam: when set, the owned-group signal step throws, which is a
// deterministic stand-in for a signal the process is not permitted to send.
// It exercises the unverified-cleanup contract end to end. Never set outside a
// test that is asserting that contract.
let denyOwnedGroupSignals = null;

function setOwnedGroupSignalDenial(denial) {
  denyOwnedGroupSignals = denial;
}

// Releases the handles this runner owns for a child it could not verify. A
// surviving descendant may still hold an inherited pipe, and that pipe would
// otherwise keep this process alive long after the failure was reported — the
// worker's promise settles but its event loop never drains. Detaching is the
// only thing done here: nothing is deleted and no cleanup is claimed, so the
// scratch and the group ownership stay with the caller.
function detachOwnedHandles(child) {
  try { child.stdout?.destroy(); } catch {}
  try { child.stderr?.destroy(); } catch {}
  try { child.unref(); } catch {}
}

// Every caller reports cleanup the same way: the primary cause first, then an
// explicit clause when the owned group could not be verified gone. A caller can
// therefore tell "this run timed out" from "this run timed out and its cleanup
// could not be verified".
function cleanupFailure(message, verified) {
  return verified
    ? message
    : `${message}; cleanup failure: the owned process group did not reach a verified dead state`;
}

function waitForFakeReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The stop result is the only evidence of whether this child is really
      // gone. Discarding it is how an unverified cleanup stayed invisible.
      const verified = await stopChild(child);
      if (!verified) detachOwnedHandles(child);
      reject(new Error(cleanupFailure(message, verified)));
    };
    const timer = setTimeout(() => { void fail("fake provider startup timed out"); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (settled) return;
      try {
        const ready = JSON.parse(output);
        settled = true;
        clearTimeout(timer);
        resolve({ port: ready.port });
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

// Races a promise against a bound and always clears the timer, so a losing
// timer can never keep the event loop alive or drain it while the real
// promise is still pending.
function withBound(promise, boundMs, message) {
  let bound;
  const expiry = new Promise((_, reject) => { bound = setTimeout(() => reject(new Error(message)), boundMs); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(bound));
}

// Owns and settles the guard negative-control probe. It is a caller exactly
// like runPi, so it takes the same coordinated cleanup on every path —
// including a plain clean exit — and reports an unverifiable cleanup as its
// own cause rather than passing it off as a probe result.
function runGuardProbe({ command, args, cwd, env, windowMs = 30_000, graceMs = 1_000 }) {
  return new Promise((resolve, reject) => {
    const childProcess = spawnOwned(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd, env });
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      settle(value);
    };
    childProcess.stderr.setEncoding("utf8");
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    const detail = () => `guard negative-control probe exceeded its bounded window (stderr=${stderr.length})`;
    const lifecycle = closeTracking(childProcess);
    const settleClean = async (cause, value) => {
      const verified = await lifecycle.terminate(graceMs);
      const ownedGroup = childProcess.pid;
      const scratchPaths = [cwd];
      if (verified) {
        if (value === undefined) {
          const error = new Error(cause);
          error.ownedGroup = ownedGroup;
          error.verified = true;
          error.scratchPaths = scratchPaths;
          finish(reject, error);
        } else {
          finish(resolve, { ...value, ownedGroup, verified: true, scratchPaths });
        }
        return;
      }
      detachOwnedHandles(childProcess);
      const error = new Error(cleanupFailure(cause, false));
      error.ownedGroup = ownedGroup;
      error.verified = false;
      error.scratchPaths = scratchPaths;
      finish(reject, error);
    };
    const killer = setTimeout(() => {
      timedOut = true;
      void settleClean(detail());
    }, windowMs);
    childProcess.once("error", (error) => { void settleClean(error.message); });
    childProcess.once("close", (code) => {
      if (timedOut) void settleClean(detail());
      else void settleClean("guard negative-control probe completed with the owned process group still alive", { code, stderr });
    });
  });
}

function startFakeServer() {
  const child = spawnOwned("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return waitForFakeReady(child).then(({ port }) => ({ child, port }));
}

async function readStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  return response.json();
}

// A forbidden port must stay a legal, distinct port across the whole valid
// range. The previous `port + 1` arithmetic overflowed to 65536 as soon as the
// fake provider bound the top of the range, so fetch rejected before the
// guard ever logged a violation.
function alternatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("provider port must be 1..65535");
  return port === 65535 ? 65534 : 65535;
}

function assertAlternatePortStaysLegalAndDistinct(port) {
  const alternate = alternatePort(port);
  assert.ok(Number.isInteger(alternate) && alternate >= 1 && alternate <= 65535,
    `alternatePort(${port}) left the legal port range: ${alternate}`);
  assert.notEqual(alternate, port, `alternatePort(${port}) must differ from the allowed port`);
}

function writeFixture({ home, work, port }) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          { id: "physical-fast", reasoning: false },
          { id: "physical-capable", reasoning: true },
        ],
      },
    },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: false },
    models: {
      quick: ["fake/physical-fast"],
      general: ["fake/physical-capable"],
      frontier: ["fake/physical-capable"],
    },
    // The conflict regex: without the inline tier handoff, Auto routes the
    // marker prompt to the capable model instead of the quick-tier fast model.
    rules: [{ pattern: "native faux dispatch marker", model: "fake/physical-capable" }],
  }));
}

function runPi({ home, work, model, prompt, child, command = PI, args, windowMs = 60_000, terminationGraceMs = 5_000, readyRecord, startupMs = 3_000, extraEnv = {} }) {
  const violations = join(home, "test-network-violations.log");
  writeFileSync(violations, "");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
  };
  for (const name of CREDENTIALS) env[name] = "ambient-secret-fixture";
  // pi-subagents 0.77.0 producer contract: only the verified child marker
  // value "1" scopes the explicit child host; absent and empty stay parent.
  if (child !== undefined) env.PI_SUBAGENT_CHILD = child;
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const resolvedArgs = args ?? ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", prompt];
    const childProcess = spawnOwned(command, resolvedArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let waitingForReady = readyRecord !== undefined;
    let spawnError;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (waitingForReady && !timedOut && stdout.includes(readyRecord)) {
        waitingForReady = false;
        clearTimeout(timer);
        timer = setTimeout(onTimeout, windowMs);
      }
    });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("error", (error) => { spawnError = error; });
    // Bounded termination: SIGTERM, then SIGKILL after the grace window, and
    // then the owned process group. The run settles only once that cleanup has
    // reported back, so a child whose descendant closes the inherited pipes on
    // SIGTERM and keeps running fails the run instead of settling on a close
    // event that proves nothing.
    const lifecycle = closeTracking(childProcess);
    const timeoutDetail = () => waitingForReady
      ? `Pi exceeded the bounded startup window before readiness (stdout=${stdout.length}, stderr=${stderr.length})`
      : `Pi exceeded the bounded run window and was force-killed after SIGTERM (stdout=${stdout.length}, stderr=${stderr.length})`;
    // Every settlement path — success, assertion failure, spawn error and
    // timeout — goes through this, so none of them can settle or delete a
    // scratch while a member of the owned group is still alive. An unverified
    // cleanup detaches the runner's own handles so this process can actually
    // exit, and it is reported as a cleanup failure rather than passed off as
    // the primary cause.
    const settleClean = async (cause, value) => {
      const verified = await lifecycle.terminate(terminationGraceMs);
      const ownedGroup = childProcess.pid;
      const scratchPaths = [home, work];
      if (verified) {
        if (value === undefined) {
          const error = new Error(cause);
          error.ownedGroup = ownedGroup;
          error.verified = true;
          error.scratchPaths = scratchPaths;
          finish(reject, error);
        } else {
          finish(resolve, { ...value, ownedGroup, verified: true, scratchPaths });
        }
        return;
      }
      detachOwnedHandles(childProcess);
      const error = new Error(cleanupFailure(cause, false));
      error.ownedGroup = ownedGroup;
      error.verified = false;
      error.scratchPaths = scratchPaths;
      finish(reject, error);
    };
    const onTimeout = () => {
      timedOut = true;
      void settleClean(timeoutDetail());
    };
    // Readiness is opt-in; ordinary callers retain their spawn-based deadline.
    let timer = setTimeout(onTimeout, waitingForReady ? startupMs : windowMs);
    childProcess.on("close", async (code) => {
      if (spawnError) {
        await settleClean(spawnError.message);
        return;
      }
      if (timedOut) {
        // The leader closed, but the owned group may still have a live member
        // that closed the inherited pipes. Await the same coordinated
        // termination the timeout path started; it decides the message.
        await settleClean(timeoutDetail());
        return;
      }
      if (waitingForReady) {
        await settleClean("Pi exited before readiness");
        return;
      }
      try {
        const violationsText = readFileSync(violations, "utf8");
        assert.equal(violationsText, "", "Pi child made a blocked outbound attempt");
        // A clean exit code proves nothing about what the child left behind.
        await settleClean("Pi run completed with the owned process group still alive", { code, stdout, stderr, violations: violationsText });
      } catch (error) {
        await settleClean(error.message);
      }
    });
  });
}

// Extracted so the suite and the whole-run worker exercise the same lifecycle
// and the same callers. No behaviour lives here that the tests do not use.
export {
  ROOT, PI, EXTENSION, DESCENDANT_CLI, PIPE_RACE_CLI, NORMAL_CLOSE_CLI, RUNNER_WORKER,
  FAKE_SERVER, OUTBOUND_GUARD, CREDENTIALS,
  CLOSE_WAIT_MS, DESCENDANT_GRACE_MS, DESCENDANT_CLEANUP_MS,
  spawnOwned, closeTracking, waitForObservedClose, terminateOwnedGroup, stopChild,
  cleanupFailure, detachOwnedHandles, forceCleanupFailure, setOwnedGroupSignalDenial,
  writeFixture, runPi, alternatePort, assertAlternatePortStaysLegalAndDistinct,
  waitForFakeReady, startFakeServer, setFakePort, readStats, runGuardProbe, withBound,
};
