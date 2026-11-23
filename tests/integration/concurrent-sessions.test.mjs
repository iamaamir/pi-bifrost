import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "concurrent-sessions-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN"];
const MAX_STREAM_BYTES = 256 * 1024;

function appendBounded(capture, chunk) {
  if (capture.size >= MAX_STREAM_BYTES) return;
  const text = chunk.toString("utf8");
  const room = MAX_STREAM_BYTES - capture.size;
  capture.text += text.slice(0, room);
  capture.size += Math.min(room, Buffer.byteLength(text));
}

// The caller owns its child process group: detached spawn, bounded output,
// bounded kill deadline, and a hard wall bound that settles independently of
// error/close. On the failure path only caller-owned stdio handles are
// released; group death is never claimed, only observed via processGroupExists.
// signalGroup is an injection point for the denied-kill control; production
// use always passes the real group signal through terminateProcessGroup.
function runIsolatedNode(args, {
  cwd,
  env,
  timeoutMs,
  graceMs = 2000,
  cleanupTimeoutMs = 3000,
  drainMs = 2000,
  marginMs = 5000,
  signalGroup,
}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const childProcess = spawn(execPath, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const groupId = childProcess.pid;
    const stdout = { text: "", size: 0 };
    const stderr = { text: "", size: 0 };
    let timedOut = false;
    let hardBoundHit = false;
    let closeMissing = false;
    let exitCode;
    let exitSignal;
    let finished = false;
    let termination;
    // Whole-parent denial control: with BIFROST_TEST_DENY_GROUP_KILL=1 the
    // caller runs its real PIDs, pipes, deadlines and scratch while every
    // owned-group signal is swallowed. An explicit signalGroup always wins.
    const denyGroupKill = signalGroup === undefined && process.env.BIFROST_TEST_DENY_GROUP_KILL === "1";
    const terminateOptions = signalGroup
      ? { graceMs, cleanupTimeoutMs, signalGroup }
      : denyGroupKill
        ? { graceMs, cleanupTimeoutMs, signalGroup: () => {} }
        : { graceMs, cleanupTimeoutMs };
    const terminate = () => termination ??= terminateProcessGroup(childProcess, terminateOptions).catch(() => false);
    const destroyOwnedHandles = () => {
      try { childProcess.stdout.destroy(); } catch {}
      try { childProcess.stderr.destroy(); } catch {}
      // A still-running child handle keeps the whole runner alive even with
      // its pipes destroyed; release it on failure paths without claiming
      // the group is dead (group death is only ever observed, below).
      try { childProcess.unref(); } catch {}
      childProcess.removeAllListeners("error");
      childProcess.removeAllListeners("close");
      childProcess.removeAllListeners("exit");
    };
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      clearTimeout(hardTimer);
      if (!termination && process.platform !== "win32" && groupId !== undefined && processGroupExists(groupId)) terminate();
      const groupTerminated = termination ? await termination : true;
      if (hardBoundHit || closeMissing) destroyOwnedHandles();
      resolve({
        status: !groupTerminated ? 1 : exitCode !== undefined && exitCode !== null ? exitCode : timedOut || hardBoundHit ? 124 : 1,
        signal: exitSignal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        hardBoundHit,
        closeMissing,
        cleanupFailed: !groupTerminated,
        groupGone: groupId === undefined || !processGroupExists(groupId),
        groupId,
        durationMs: Date.now() - startedAt,
      });
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      void terminate().then(() => {
        // Settlement still requires exit/close/drain/hard-bound below; the
        // kill alone never resolves the caller.
      });
    }, timeoutMs);
    // After exit without close (a descendant inherited the pipes), wait a
    // bounded drain, then settle with the exit code and clean the group.
    let drainArmed = false;
    let drainTimer;
    const armDrain = () => {
      if (drainArmed) return;
      drainArmed = true;
      drainTimer = setTimeout(() => {
        if (finished) return;
        closeMissing = true;
        void finish();
      }, drainMs);
      drainTimer.unref?.();
    };
    const hardTimer = setTimeout(() => {
      hardBoundHit = true;
      void finish();
    }, timeoutMs + graceMs + cleanupTimeoutMs + drainMs + marginMs);
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    childProcess.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    childProcess.once("error", () => { void finish(); });
    childProcess.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      armDrain();
    });
    childProcess.once("close", () => { void finish(); });
  });
}

// Scratch is removed only when every tracked owned group is confirmed gone.
// The group list is required: there is no path that deletes scratch without
// checking observed group absence first.
function removeScratchWhenGroupGone(scratch, groupIds) {
  assert.ok(Array.isArray(groupIds), "owned group list is required before scratch removal");
  if (process.platform !== "win32" && groupIds.some((groupId) => groupId !== undefined && processGroupExists(groupId))) return false;
  rmSync(scratch, { recursive: true, force: true });
  return !existsSync(scratch);
}

function scrubbedEnv(scratch, port, violations) {
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    BIFROST_CONCURRENT_SCRATCH: scratch,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
    NODE_OPTIONS: `--require=${guard}`,
    // Test-control passthrough for the whole-parent denial proof only; never
    // a secret, never on in normal runs.
    ...(process.env.BIFROST_TEST_HANG_CHILD === undefined
      ? {}
      : { BIFROST_TEST_HANG_CHILD: process.env.BIFROST_TEST_HANG_CHILD }),
  };
}

it("proves concurrent native AgentSession dispatch and isolation behind non-vacuous network fence", { timeout: 90_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-concurrent-"));
  const violations = join(scratch, "network-violations.log");
  const ownedGroups = [];
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  let bodyError;
  let probe;
  let result;
  let server;
  try {
    server = createServer((_request, response) => response.end("allowed fixture"));
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      throw new Error(`guard server failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const port = server.address().port;
    // Negative probes target a port that can never be the ephemeral guard
    // server, so an unrelated listener cannot mask a fence failure.
    const closedPort = port === 65535 ? 65534 : 65535;
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const env = scrubbedEnv(scratch, port, violations);
    for (const name of credentials) assert.equal(env[name], undefined, `${name} entered isolated child env`);

    probe = await runIsolatedNode(["-e", `
      const net = require("node:net");
      const dgram = require("node:dgram");
      (async () => {
        await (await fetch("http://127.0.0.1:${port}")).text();
        for (const attempt of [
          () => fetch("https://127.0.0.1:${port}"),
          () => fetch("http://127.0.0.1:${closedPort}"),
          () => new net.Socket().connect({ host: "127.0.0.1", port: ${closedPort} }),
          () => dgram.createSocket("udp4").send(Buffer.from("probe"), ${closedPort}, "127.0.0.1"),
        ]) { try { await attempt(); } catch {} }
      })();
    `], { cwd: root, env, timeoutMs: 30_000 });
    ownedGroups.push(probe.groupId);
    assert.equal(probe.cleanupFailed, false, `probe group ${probe.groupId} cleanup failed`);
    assert.equal(probe.groupGone, true, `probe group ${probe.groupId} still observable after close`);
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const probeLog = readFileSync(violations, "utf8");
    assert.match(probeLog, /blocked fetch to https/);
    assert.match(probeLog, /blocked fetch to http/);
    assert.match(probeLog, /blocked socket connection/);
    assert.match(probeLog, /blocked UDP datagram/);
    writeFileSync(violations, "");

    // Caller deadline: 60s default; the whole-parent denial proof shortens it
    // below the fixture's own test timeouts via BIFROST_TEST_CALLER_TIMEOUT_MS
    // so the caller (not the fixture) settles the stalled child first.
    const callerTimeoutMs = process.env.BIFROST_TEST_CALLER_TIMEOUT_MS === undefined
      ? 60_000
      : Math.max(1_000, Number(process.env.BIFROST_TEST_CALLER_TIMEOUT_MS) || 60_000);
    result = await runIsolatedNode(["--test", "--experimental-strip-types", child], { cwd: root, env, timeoutMs: callerTimeoutMs });
    ownedGroups.push(result.groupId);
    assert.equal(result.timedOut, false, `child group ${result.groupId} exceeded its deadline after ${result.durationMs}ms`);
    assert.equal(result.hardBoundHit, false, `child group ${result.groupId} needed the hard wall bound`);
    assert.equal(result.cleanupFailed, false, `child group ${result.groupId} did not terminate cleanly`);
    assert.equal(result.groupGone, true, `child group ${result.groupId} still observable after close`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null, "child required forced termination; cleanup leaked a handle");
    assert.equal(readFileSync(violations, "utf8"), "", "native sessions made blocked outbound request");
    const report = JSON.parse(readFileSync(join(scratch, "concurrent-report.json"), "utf8"));
    assert.equal(report.host.separateRuntimeRegistries, true);
    assert.equal(report.cancellation.sessionBUnaffected, true);
    assert.ok(report.cancellation.sessionAOutcome.every((status) => status === "fulfilled" || status === "rejected"));
    assert.equal(report.storage.sharedWorkspacePolicy, true);
    assert.equal(report.storage.pinSessionLocal, true);
    assert.equal(report.cleanup.fauxAPending, 0);
    assert.equal(report.cleanup.fauxBPending, 0);
    assert.ok(report.invocations.some(({ model }) => model === "faux-a/session-a-model"));
    assert.ok(report.invocations.some(({ model }) => model === "faux-b/session-b-model"));
    assert.ok(!report.invocations.some(({ model }) => /standby/.test(model)), "standby decoy reached a provider");
  } catch (error) {
    bodyError = error;
  }
  try {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  } catch {}
  const liveGroups = ownedGroups.filter((groupId) => groupId !== undefined && process.platform !== "win32" && processGroupExists(groupId));
  // Scratch safety is driven by observed group absence, never by assertion
  // success: any still-observable owned group retains the scratch and is
  // named in the error. Clean runs remove it below. A file receipt preserves
  // owned-group ownership independently of stdout parsing for outer supervisors.
  let cleanupError;
  if (liveGroups.length) {
    try { writeFileSync(join(scratch, "owned-groups.json"), JSON.stringify({ ownedGroups, liveGroups })); } catch {}
    const flags = [["probe", probe], ["child", result]]
      .filter(([, run]) => run && (run.cleanupFailed || run.hardBoundHit))
      .map(([label, run]) => `${label}:cleanupFailed=${run.cleanupFailed},hardBoundHit=${run.hardBoundHit}`)
      .join("; ");
    cleanupError = new Error(`scratch retained: owned groups still active ${liveGroups.join(",")}${flags ? ` (${flags})` : ""}`);
  }
  if (!cleanupError) {
    if (!removeScratchWhenGroupGone(scratch, ownedGroups)) {
      cleanupError = new Error(`scratch retained: group absence changed during removal for groups ${ownedGroups.join(",")}`);
    }
  }
  if (bodyError) {
    if (cleanupError) process.stderr.write(`concurrent-sessions cleanup: ${cleanupError.message}\n`);
    throw bodyError;
  }
  if (cleanupError) throw cleanupError;
});

it("bounds a hanging descendant group and retains scratch while the group stays active", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "POSIX-only: process-group lifecycle requires POSIX killpg semantics" : false,
}, async () => {
  const hanging = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 1_500 });
  assert.equal(hanging.timedOut, true);
  assert.equal(hanging.hardBoundHit, false, `hanging group ${hanging.groupId} needed the hard wall bound`);
  assert.equal(hanging.cleanupFailed, false, hanging.stderr);
  assert.equal(hanging.groupGone, true, `hanging descendant group ${hanging.groupId} survived the owned kill`);
  assert.ok(hanging.durationMs < 15_000, `caller not bounded: ${hanging.durationMs}ms`);
});

it("fails bounded with scratch retained when the owned group kill is denied", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "POSIX-only: process-group lifecycle requires POSIX killpg semantics" : false,
}, async () => {
  // Actual caller path with real PIDs, pipes, wall time and scratch; only the
  // group kill signal is denied. Settlement must not depend on close.
  // Cleanup ownership (denied.groupId) is acquired before any assertion; the
  // bounded restoration below runs even when assertions throw.
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-concurrent-denied-"));
  const startedAt = Date.now();
  let denied;
  let bodyError;
  let ownedGroupId;
  try {
    denied = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `], {
      cwd: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_500,
      graceMs: 500,
      cleanupTimeoutMs: 1_000,
      drainMs: 500,
      marginMs: 2_000,
      signalGroup: () => {},
    });
    ownedGroupId = denied.groupId;
    if (process.env.BIFROST_TEST_INJECT_DIRECT_FAILURE === "1") {
      throw new Error(`injected direct assertion failure, owned group ${ownedGroupId}`);
    }
    const wallMs = Date.now() - startedAt;
    assert.equal(denied.timedOut, true);
    assert.equal(denied.hardBoundHit, true, `denied-kill caller for group ${denied.groupId} settled via close instead of the wall bound`);
    assert.equal(denied.cleanupFailed, true, `denied kill of owned group ${denied.groupId} reported success`);
    assert.equal(denied.groupGone, false, `owned group ${denied.groupId} gone despite denied kill`);
    assert.ok(denied.durationMs < 15_000 && wallMs < 15_000, `denied-kill caller not bounded: runner ${denied.durationMs}ms, wall ${wallMs}ms`);
    assert.equal(removeScratchWhenGroupGone(scratch, [denied.groupId]), false, "active-group scratch was removed");
    assert.equal(existsSync(scratch), true, `scratch for live group ${denied.groupId} missing`);
    // Restoration signals only the owned group, then scratch goes away once the
    // group is confirmed gone.
    try { process.kill(-denied.groupId, "SIGKILL"); } catch {}
    const deadline = Date.now() + 5_000;
    while (processGroupExists(denied.groupId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(processGroupExists(denied.groupId), false, `owned group ${denied.groupId} survived restoration`);
    assert.equal(removeScratchWhenGroupGone(scratch, [denied.groupId]), true, `scratch for group ${denied.groupId} retained after group exit`);
    assert.equal(existsSync(scratch), false, "scratch not removed after cleanup");
  } catch (error) {
    bodyError = error;
  }
  // Failure-safe finalizer: restore only the creation-proven owned group,
  // retain scratch while absence cannot be established, preserve both errors.
  let cleanupError;
  if (ownedGroupId !== undefined) {
    try {
      if (processGroupExists(ownedGroupId)) {
        try { process.kill(-ownedGroupId, "SIGKILL"); } catch {}
        const deadline = Date.now() + 5_000;
        while (processGroupExists(ownedGroupId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (processGroupExists(ownedGroupId)) {
        cleanupError = new Error(`cleanup failed: owned group ${ownedGroupId} still observable after bounded restoration`);
      } else if (existsSync(scratch)) {
        try {
          if (!removeScratchWhenGroupGone(scratch, [ownedGroupId])) {
            cleanupError = new Error(`scratch retained: group absence changed during removal for group ${ownedGroupId}`);
          }
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        }
      }
    } catch (error) {
      cleanupError ??= error instanceof Error ? error : new Error(String(error));
    }
  } else if (existsSync(scratch)) {
    cleanupError = new Error(`cleanup failed: caller settlement threw before ownership acquired; scratch retained at ${scratch}`);
  }
  if (bodyError) {
    if (cleanupError) process.stderr.write(`concurrent-sessions direct-proof cleanup: ${cleanupError.message}\n`);
    if (cleanupError) bodyError.message += ` [cleanup: ${cleanupError.message}]`;
    throw bodyError;
  }
  if (cleanupError) throw cleanupError;
});

it("settles children whose descendants outlive them via inherited or no stdio", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "POSIX-only: process-group lifecycle requires POSIX killpg semantics" : false,
}, async () => {
  // The descendant inherits the leader's pipes, so close never arrives; the
  // caller settles on the bounded exit drain and still cleans the group.
  const inherited = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000);"], { stdio: "inherit" });
    descendant.unref();
    process.stdout.write("leader-done");
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.closeMissing, true, `inherited-pipe group ${inherited.groupId} closed cleanly; drain path not exercised`);
  assert.equal(inherited.cleanupFailed, false, `inherited-pipe group ${inherited.groupId} cleanup failed`);
  assert.equal(inherited.groupGone, true, `inherited-pipe group ${inherited.groupId} still observable`);
  assert.match(inherited.stdout, /leader-done/);
  assert.ok(inherited.durationMs < 15_000, `inherited-pipe caller not bounded: ${inherited.durationMs}ms`);
  // A no-stdio descendant holds no pipes: close arrives normally and the
  // lingering group member is still terminated and awaited.
  const nostriod = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000);"], { stdio: "ignore" });
    descendant.unref();
    process.stdout.write("leader-done");
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
  assert.equal(nostriod.status, 0, nostriod.stderr);
  assert.equal(nostriod.cleanupFailed, false, `no-stdio group ${nostriod.groupId} cleanup failed`);
  assert.equal(nostriod.groupGone, true, `no-stdio group ${nostriod.groupId} still observable`);
  assert.match(nostriod.stdout, /leader-done/);
  assert.ok(nostriod.durationMs < 15_000, `no-stdio caller not bounded: ${nostriod.durationMs}ms`);
});

it("fails the whole parent bounded with scratch retained while denied-kill groups stay alive", {
  timeout: 220_000,
  skip: process.env.BIFROST_INNER_PROOF === "1"
    ? "inner proof recursion: outer supervisor does not run inside itself"
    : process.platform === "win32"
      ? "POSIX-only: process-group lifecycle requires POSIX killpg semantics"
      : false,
}, async () => {
  // Whole-parent proof: run this exact file's main caller test as a subprocess
  // with every owned-group signal denied and the fixture stalled. The inner
  // main caller must exit by itself with an explicit failure while its group
  // stays alive and its scratch is retained. Other lifecycle controls keep
  // their independent assertions; only the main caller runs here.
  // Direct cleanup ownership (inner.groupId) is acquired before any assertion;
  // reported grandchild IDs are unioned from stdout diagnostics and the file
  // receipt so a missing/malformed diagnostic cannot bypass restoration.
  // Restoration signals only creation/receipt-proven groups.
  const retainBase = mkdtempSync(join(tmpdir(), "bifrost-concurrent-outer-"));
  const selfPath = fileURLToPath(import.meta.url);
  let inner;
  let bodyError;
  let ownedDirect;
  let groupIds = [];
  let mainScratchDirs = [];
  try {
    inner = await runIsolatedNode(["--test", "--experimental-strip-types", "--test-name-pattern=non-vacuous", selfPath], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: retainBase,
        BIFROST_TEST_DENY_GROUP_KILL: "1",
        BIFROST_TEST_HANG_CHILD: "1",
        BIFROST_TEST_CALLER_TIMEOUT_MS: "10000",
        BIFROST_INNER_PROOF: "1",
      },
      timeoutMs: 150_000,
      graceMs: 3_000,
      cleanupTimeoutMs: 5_000,
    });
    ownedDirect = inner.groupId;
    if (process.env.BIFROST_TEST_INJECT_OUTER_FAILURE === "1") {
      throw new Error(`injected outer assertion failure, direct group ${ownedDirect}`);
    }
    assert.equal(inner.timedOut, false, `inner parent needed the outer kill after ${inner.durationMs}ms`);
    assert.equal(inner.hardBoundHit, false, "inner parent needed the outer hard wall bound");
    assert.equal(inner.status, 1, `inner parent exit not an explicit failure: status=${inner.status}\n${inner.stdout}\n${inner.stderr}`);
    assert.ok(inner.durationMs < 200_000, `whole-parent proof not bounded: ${inner.durationMs}ms`);
    const combined = `${inner.stdout}\n${inner.stderr}`;
    // Malformed-diagnostic control: ignore stdout text so ownership must come
    // from the direct group ID and the file receipt, not the regex.
    const combinedForParse = process.env.BIFROST_TEST_INJECT_OUTER_MALFORMED === "1" ? "" : combined;
    const retainedMatch = /scratch retained: owned groups still active ([\d, ]+)/.exec(combinedForParse);
    let parseError;
    let stdoutGroups = [];
    if (!retainedMatch) {
      parseError = new Error(`inner parent did not report live owned groups:\n${combined.slice(-2000)}`);
    } else {
      stdoutGroups = [...new Set(retainedMatch[1].split(",").map((part) => Number(part.trim())).filter((id) => Number.isFinite(id) && id > 0))];
      if (!stdoutGroups.length) parseError = new Error("no owned group IDs reported by the inner parent");
    }
    const scratchDirs = readdirSync(retainBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-"))
      .map((entry) => join(retainBase, entry.name));
    const mainScratch = scratchDirs.filter((dir) => existsSync(join(dir, "network-violations.log")));
    assert.equal(mainScratch.length, 1, `expected one retained main scratch, saw ${scratchDirs.join(",")}`);
    mainScratchDirs = mainScratch;
    // File-receipt channel: inner cleanup writes owned-groups.json into its
    // scratch independently of stdout text. Only liveGroups prove denied
    // groups still alive; ownedGroups may include already-cleaned probe groups.
    let fileGroups = [];
    for (const dir of mainScratch) {
      try {
        const receipt = JSON.parse(readFileSync(join(dir, "owned-groups.json"), "utf8"));
        for (const id of [...(receipt.liveGroups ?? [])]) {
          if (Number.isFinite(id) && id > 0) fileGroups.push(id);
        }
      } catch {}
    }
    groupIds = [...new Set([...stdoutGroups, ...fileGroups].filter((id) => Number.isFinite(id) && id > 0))];
    // Direct caller group is creation-proven but expected gone after inner
    // settlement (outer caller terminates it); grandchild liveness below
    // proves the denied groups stayed alive. Direct is still restored in the
    // finalizer if observable.
    if (ownedDirect !== undefined && processGroupExists(ownedDirect)) groupIds.push(ownedDirect);
    groupIds = [...new Set(groupIds)];
    if (process.env.BIFROST_TEST_INJECT_OUTER_MALFORMED === "1" && parseError) {
      // Ownership must not be tied to the regex: direct + file receipt still
      // identify owned groups; record the diagnostic failure without losing it.
      bodyError = parseError;
    } else if (parseError) {
      throw parseError;
    }
    if (bodyError) throw bodyError;
    assert.ok(groupIds.length > 0, "no owned group IDs reported by the inner parent");
    for (const groupId of groupIds) {
      assert.equal(processGroupExists(groupId), true, `reported owned group ${groupId} is not actually alive`);
    }
    // The stalled child never reaches teardown, so no report is written; the
    // violations log proves this is the main parent scratch.
    for (const groupId of groupIds) {
      try { process.kill(-groupId, "SIGKILL"); } catch {}
    }
    const deadline = Date.now() + 5_000;
    while (groupIds.some((groupId) => processGroupExists(groupId)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const groupId of groupIds) {
      assert.equal(processGroupExists(groupId), false, `owned group ${groupId} survived restoration`);
    }
    assert.equal(removeScratchWhenGroupGone(mainScratch[0], groupIds), true, "scratch retained after owned groups exited");
    assert.equal(existsSync(mainScratch[0]), false, "scratch not removed after cleanup");
    rmSync(retainBase, { recursive: true, force: true });
  } catch (error) {
    bodyError ??= error instanceof Error ? error : new Error(String(error));
    // Fallback ownership when parsing threw before groupIds were built: the
    // direct caller group is creation-proven only if still observable; file
    // receipts are best-effort. Never invent grandchild IDs.
    if (!groupIds.length && ownedDirect !== undefined && processGroupExists(ownedDirect)) groupIds = [ownedDirect];
    if (!mainScratchDirs.length) {
      try {
        const scratchDirs = readdirSync(retainBase, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-"))
          .map((entry) => join(retainBase, entry.name));
        const found = scratchDirs.filter((dir) => existsSync(join(dir, "network-violations.log")));
        if (found.length) mainScratchDirs = found;
        for (const dir of found) {
          try {
            const receipt = JSON.parse(readFileSync(join(dir, "owned-groups.json"), "utf8"));
            for (const id of [...(receipt.liveGroups ?? [])]) {
              if (Number.isFinite(id) && id > 0 && !groupIds.includes(id)) groupIds.push(id);
            }
          } catch {}
        }
      } catch {}
    }
  }
  // Failure-safe finalizer: restore only proven groups, retain scratch while
  // any proven group stays observable, preserve both primary and cleanup errors.
  let cleanupError;
  try {
    for (const groupId of groupIds) {
      try { if (processGroupExists(groupId)) process.kill(-groupId, "SIGKILL"); } catch {}
    }
    const deadline = Date.now() + 5_000;
    while (groupIds.some((groupId) => processGroupExists(groupId)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const live = groupIds.filter((groupId) => processGroupExists(groupId));
    if (live.length) {
      cleanupError = new Error(`cleanup failed: owned groups still observable after bounded restoration ${live.join(",")}`);
    } else if (mainScratchDirs.length && !groupIds.length) {
      cleanupError = new Error(`scratch retained: ownership incomplete, no proven group IDs for ${mainScratchDirs.join(",")}`);
    } else if (mainScratchDirs.length) {
      for (const dir of mainScratchDirs) {
        try {
          if (existsSync(dir) && !removeScratchWhenGroupGone(dir, groupIds)) {
            cleanupError = new Error(`scratch retained: group absence changed during removal for groups ${groupIds.join(",")}`);
          }
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (!cleanupError && existsSync(retainBase)) {
        try {
          const remaining = readdirSync(retainBase, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-"));
          if (!remaining.length) rmSync(retainBase, { recursive: true, force: true });
        } catch {}
      }
    } else if (existsSync(retainBase)) {
      // Ownership incomplete (no scratch identified): retain base for inspection.
      try {
        const remaining = readdirSync(retainBase, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-"));
        if (remaining.length || groupIds.some((id) => processGroupExists(id))) {
          cleanupError = new Error(`scratch retained: ownership incomplete, retained base ${retainBase} groups ${groupIds.join(",")}`);
        } else {
          rmSync(retainBase, { recursive: true, force: true });
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
  } catch (error) {
    cleanupError ??= error instanceof Error ? error : new Error(String(error));
  }
  if (bodyError) {
    if (cleanupError) process.stderr.write(`concurrent-sessions outer-proof cleanup: ${cleanupError.message}\n`);
    if (cleanupError) bodyError.message += ` [cleanup: ${cleanupError.message}]`;
    throw bodyError;
  }
  if (cleanupError) throw cleanupError;
});

it("restores the denied-kill group after an injected direct assertion failure", {
  timeout: 60_000,
  skip: process.env.BIFROST_INNER_PROOF === "1"
    ? "inner proof recursion"
    : process.platform === "win32"
      ? "POSIX-only: process-group lifecycle requires POSIX killpg semantics"
      : false,
}, async () => {
  // Source-bound fault proof: run the actual denied-kill proof with failure
  // injected immediately after real caller settlement, without removing
  // cleanup logic. The proof process must fail bounded while its own
  // finalizer leaves no owned group or scratch behind.
  const retainBase = mkdtempSync(join(tmpdir(), "bifrost-concurrent-supervisor-direct-"));
  const selfPath = fileURLToPath(import.meta.url);
  let proof;
  let bodyError;
  let reported = [];
  try {
    proof = await runIsolatedNode(["--test", "--experimental-strip-types", "--test-name-pattern=fails bounded with scratch retained when the owned group kill is denied", selfPath], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: retainBase,
        BIFROST_TEST_INJECT_DIRECT_FAILURE: "1",
        BIFROST_INNER_PROOF: "1",
      },
      timeoutMs: 30_000,
      graceMs: 2_000,
      cleanupTimeoutMs: 3_000,
    });
    assert.equal(proof.timedOut, false, `injected direct proof needed the supervisor kill after ${proof.durationMs}ms`);
    assert.equal(proof.hardBoundHit, false, "injected direct proof needed the hard wall bound");
    assert.equal(proof.status, 1, `injected direct proof did not fail as injected: status=${proof.status}\n${proof.stdout}\n${proof.stderr}`);
    assert.ok(proof.durationMs < 45_000, `injected direct proof not bounded: ${proof.durationMs}ms`);
    const combined = `${proof.stdout}\n${proof.stderr}`;
    assert.match(combined, /injected direct assertion failure/, "proof did not take the injected assertion-failure path");
    const match = /owned group (\d+)/.exec(combined);
    if (match) reported = [Number(match[1])].filter((id) => Number.isFinite(id) && id > 0);
    assert.ok(reported.length > 0, "injected proof did not report its owned group");
    for (const groupId of reported) {
      assert.equal(processGroupExists(groupId), false, `injected-failure group ${groupId} survived the proof finalizer`);
    }
    const remaining = existsSync(retainBase)
      ? readdirSync(retainBase, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-denied-"))
      : [];
    assert.equal(remaining.length, 0, `injected-proof scratch remains: ${remaining.map((e) => e.name).join(",")}`);
  } catch (error) {
    bodyError = error instanceof Error ? error : new Error(String(error));
  }
  let supervisorError;
  try {
    for (const groupId of reported) {
      try { if (processGroupExists(groupId)) process.kill(-groupId, "SIGKILL"); } catch {}
    }
    const deadline = Date.now() + 5_000;
    while (reported.some((id) => processGroupExists(id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const live = reported.filter((id) => processGroupExists(id));
    if (live.length) supervisorError = new Error(`supervisor cleanup failed for groups ${live.join(",")}`);
    else if (existsSync(retainBase)) rmSync(retainBase, { recursive: true, force: true });
  } catch (error) {
    supervisorError ??= error instanceof Error ? error : new Error(String(error));
  }
  if (bodyError) {
    if (supervisorError) process.stderr.write(`direct supervisor cleanup: ${supervisorError.message}\n`);
    throw bodyError;
  }
  if (supervisorError) throw supervisorError;
});

it("restores outer groups when the diagnostic is missing or malformed", {
  timeout: 300_000,
  skip: process.env.BIFROST_INNER_PROOF === "1"
    ? "inner proof recursion"
    : process.platform === "win32"
      ? "POSIX-only: process-group lifecycle requires POSIX killpg semantics"
      : false,
}, async () => {
  // Outer ownership must not be tied to the stdout regex: run the actual
  // whole-parent proof with a malformed diagnostic so group IDs must come
  // from the direct caller ID and the file receipt. The proof fails with the
  // diagnostic error while its own finalizer still restores every proven group.
  const retainBase = mkdtempSync(join(tmpdir(), "bifrost-concurrent-supervisor-outer-"));
  const selfPath = fileURLToPath(import.meta.url);
  let proof;
  let bodyError;
  let reported = [];
  try {
    proof = await runIsolatedNode(["--test", "--experimental-strip-types", "--test-name-pattern=fails the whole parent bounded", selfPath], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: retainBase,
        BIFROST_TEST_INJECT_OUTER_MALFORMED: "1",
      },
      timeoutMs: 240_000,
      graceMs: 5_000,
      cleanupTimeoutMs: 5_000,
    });
    assert.equal(proof.timedOut, false, `malformed outer proof needed the supervisor kill after ${proof.durationMs}ms`);
    assert.equal(proof.status, 1, `malformed outer proof did not fail as expected: status=${proof.status}\n${proof.stdout}\n${proof.stderr}`);
    const combined = `${proof.stdout}\n${proof.stderr}`;
    assert.match(combined, /did not report live owned groups/, "proof did not take the malformed-diagnostic path");
    const ids = [...combined.matchAll(/(?:owned group|groups?)[^\d]*(\d{2,7})/gi)].map((m) => Number(m[1])).filter((id) => Number.isFinite(id) && id > 0);
    reported = [...new Set(ids)];
    for (const groupId of reported) {
      assert.equal(processGroupExists(groupId), false, `malformed-proof group ${groupId} survived the proof finalizer`);
    }
    const remaining = existsSync(retainBase)
      ? readdirSync(retainBase, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-"))
      : [];
    assert.equal(remaining.length, 0, `malformed-proof scratch remains: ${remaining.map((e) => e.name).join(",")}`);
  } catch (error) {
    bodyError = error instanceof Error ? error : new Error(String(error));
  }
  let supervisorError;
  try {
    for (const groupId of reported) {
      try { if (processGroupExists(groupId)) process.kill(-groupId, "SIGKILL"); } catch {}
    }
    const deadline = Date.now() + 5_000;
    while (reported.some((id) => processGroupExists(id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const live = reported.filter((id) => processGroupExists(id));
    if (live.length) supervisorError = new Error(`supervisor cleanup failed for groups ${live.join(",")}`);
    else if (existsSync(retainBase)) {
      const remaining = readdirSync(retainBase, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("bifrost-concurrent-"));
      if (!remaining.length) rmSync(retainBase, { recursive: true, force: true });
      else {
        process.stderr.write("outer supervisor retained scratch with incomplete process ownership\n");
      }
    }
  } catch (error) {
    supervisorError ??= error instanceof Error ? error : new Error(String(error));
  }
  if (bodyError) {
    if (supervisorError) process.stderr.write(`outer supervisor cleanup: ${supervisorError.message}\n`);
    throw bodyError;
  }
  if (supervisorError) throw supervisorError;
});
