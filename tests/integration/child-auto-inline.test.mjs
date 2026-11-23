import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";
import {
  CLOSE_WAIT_MS, DESCENDANT_CLEANUP_MS, DESCENDANT_GRACE_MS, DESCENDANT_CLI, PIPE_RACE_CLI,
  NORMAL_CLOSE_CLI, RUNNER_WORKER,
  spawnOwned, closeTracking, stopChild, waitForObservedClose, waitForFakeReady,
  cleanupFailure, detachOwnedHandles, forceCleanupFailure, setOwnedGroupSignalDenial,
  writeFixture, runPi, alternatePort, assertAlternatePortStaysLegalAndDistinct,
  setFakePort, startFakeServer, readStats, runGuardProbe, withBound, ROOT, OUTBOUND_GUARD,
} from "../fixtures/child-auto-inline-harness.mjs";

// Caller scratch may only be reclaimed after the owned process group it ran in
// is independently proven gone. Success, assertion failure, or promise
// settlement alone says nothing: only processGroupExists(ownedGroup) === false
// proves the group is dead. When death cannot be verified the scratch is
// retained with its ownership and paths, and the caller fails explicitly
// rather than deleting evidence a live group may still be using.
function removeScratchAfterVerifiedGroupDeath(paths, ownedGroup) {
  const unique = [...new Set(paths)];
  if (!Number.isInteger(ownedGroup) || ownedGroup <= 0) {
    throw new Error(`refusing to delete scratch without owned-group ownership: ${unique.join(",")}`);
  }
  if (processGroupExists(ownedGroup)) {
    throw new Error(`refusing to delete scratch while owned process group ${ownedGroup} still alive: ${unique.join(",")}`);
  }
  for (const path of unique) rmSync(path, { recursive: true, force: true });
}

// Finally-block safe path: when the associated run already failed, retain the
// scratch while its group is alive and let the original failure (which carries
// the owned group and the cleanup-failure cause) propagate. Only throw a new
// retention failure when there is no pending error to preserve.
function retainOrRemoveScratch({ paths, ownedGroup, runSettled, pendingError }) {
  if (!runSettled) {
    for (const path of [...new Set(paths)]) rmSync(path, { recursive: true, force: true });
    return;
  }
  if (!Number.isInteger(ownedGroup) || ownedGroup <= 0) {
    if (pendingError) return;
    throw new Error(`refusing to delete scratch without owned-group ownership: ${[...new Set(paths)].join(",")}`);
  }
  if (processGroupExists(ownedGroup)) {
    if (pendingError) return;
    throw new Error(`refusing to delete scratch while owned process group ${ownedGroup} still alive: ${[...new Set(paths)].join(",")}`);
  }
  for (const path of [...new Set(paths)]) rmSync(path, { recursive: true, force: true });
}

// Best-effort descendant reaping for finally blocks: signal only the exact pid
// recorded by this invocation, then verify its absence before the caller
// deletes the scratch it ran in. Returns true only when no recorded descendant
// remains alive.
async function reapRecordedDescendant(pidFile, { timeoutMs = 2_000 } = {}) {
  if (!existsSync(pidFile)) return true;
  let pid = null;
  try { pid = Number(readFileSync(pidFile, "utf8")); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, "SIGKILL"); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; else throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

describe("explicit child host keeps Auto inline overrides", { timeout: 300_000, concurrency: 1 }, () => {
  let server;
  let fakePort;
  before(async () => {
    server = await startFakeServer();
    fakePort = server.port;
    setFakePort(server.port);
  });
  after(async () => {
    // Cleanup is asserted, never assumed: an unverified stop is a test failure.
    if (server) assert.equal(await stopChild(server.child), true, "fake provider must reach an observed close during cleanup");
  });

  it("routes Auto inline tiers in child hosts without weakening physical identity", async () => {
    for (const testCase of [
      // The regression: marker 1 + bifrost/auto + inline quick prefix must
      // keep the quick-tier fast model even though the conflict regex routes
      // the stripped prompt to the capable model.
      { child: "1", model: "bifrost/auto", prompt: "quick native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
      // Plain Auto children (no inline prefix) still route through Bifrost.
      { child: "1", model: "bifrost/auto", prompt: "native faux dispatch marker", expected: { "physical-fast": 0, "physical-capable": 1 } },
      // Absent and empty markers are ordinary parent sessions: the inline
      // handoff routes the fast model before the conflict regex.
      { model: "bifrost/auto", prompt: "quick native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
      { child: "", model: "bifrost/auto", prompt: "quick native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
      // Explicit physical child identity still wins over the conflict regex.
      { child: "1", model: "fake/physical-fast", prompt: "native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
    ]) {
      const home = mkdtempSync(join(tmpdir(), "bifrost-child-auto-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-child-auto-work-"));
      let ownedGroup = null;
      let runSettled = false;
      let pendingError = null;
      try {
        writeFixture({ home, work, port: server.port });
        const before = await readStats(server.port);
        const result = await runPi({
          home,
          work,
          model: testCase.model,
          prompt: testCase.prompt,
          child: testCase.child,
        }).then(
          (value) => { runSettled = true; ownedGroup = value.ownedGroup; return value; },
          (error) => { runSettled = true; ownedGroup = error?.ownedGroup ?? null; throw error; },
        );
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assert.notEqual(result.stdout.trim(), "", "Pi produced no response through the fake provider");
        const after = await readStats(server.port);
        const attempts = Object.fromEntries(Object.entries(after.attempts).map(([model, count]) => [model, count - (before.attempts[model] ?? 0)]));
        const dispatch = { "physical-fast": 0, "physical-capable": 0, ...attempts };
        assert.deepEqual(dispatch, testCase.expected,
          `child=${JSON.stringify(testCase.child)} model=${testCase.model} prompt=${JSON.stringify(testCase.prompt)} dispatched ${JSON.stringify(attempts)}`);
        // The main matrix keeps the real allowed loopback transport and
        // asserts zero outbound violations. That absence alone is not proof
        // the guard blocks; the negative-control test below supplies it.
        assert.equal(result.violations, "", "network fence recorded a violation");
      } catch (error) {
        pendingError = error;
        throw error;
      } finally {
        retainOrRemoveScratch({ paths: [home, work], ownedGroup, runSettled, pendingError });
      }
    }
  });

  it("retains ordinary routing caller scratch when owned cleanup cannot be verified", async () => {
    // Regression for the main-matrix P2: the ordinary routing caller must not
    // delete home/work when runPi rejects with an unverified owned-group
    // cleanup. Drives the actual caller finally path (runPi + retained
    // ownership + verified-deletion helper), not a helper-only assertion,
    // with denied group signals and a no-stdio descendant.
    const home = mkdtempSync(join(tmpdir(), "bifrost-caller-retention-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-caller-retention-work-"));
    const pidFile = join(home, "descendant.pid");
    let ownedGroup = null;
    let runSettled = false;
    let pendingError = null;
    let descendantPid = null;
    let restored = false;
    try {
      writeFixture({ home, work, port: server.port });
      setOwnedGroupSignalDenial(() => { throw new Error("controlled owned-group signal denial"); });
      try {
        await runPi({
          home,
          work,
          model: "bifrost/auto",
          prompt: "native faux dispatch marker",
          child: "1",
          command: execPath,
          args: [NORMAL_CLOSE_CLI],
          windowMs: 1_000,
          terminationGraceMs: 200,
          extraEnv: { BIFROST_DESCENDANT_PID_FILE: pidFile },
        }).then(
          (value) => { runSettled = true; ownedGroup = value.ownedGroup; return value; },
          (error) => { runSettled = true; ownedGroup = error?.ownedGroup ?? null; throw error; },
        );
        assert.fail("runPi must reject when owned-group signals are denied");
      } catch (error) {
        if (error.message.includes("must reject when owned-group signals are denied")) throw error;
        pendingError = error;
        assert.match(error.message, /cleanup failure: the owned process group did not reach a verified dead state/,
          "an unverifiable owned-group cleanup must be named as its own cause");
        assert.ok(Number.isInteger(ownedGroup) && ownedGroup > 0, "the run must preserve owned-group ownership");
        assert.deepEqual(error.scratchPaths, [home, work], "the run must preserve scratch ownership");
        assert.equal(processGroupExists(ownedGroup), true, `owned process group ${ownedGroup} must still be alive`);
        descendantPid = Number(readFileSync(pidFile, "utf8"));
        assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "the fixture must record its descendant pid");
        assert.doesNotThrow(() => process.kill(descendantPid, 0), "an unverified cleanup must leave ownership intact");
      } finally {
        setOwnedGroupSignalDenial(null);
      }
      // The actual caller finally path: with a pending cleanup failure and a
      // live owned group it must retain, never delete.
      retainOrRemoveScratch({ paths: [home, work], ownedGroup, runSettled, pendingError });
      assert.equal(existsSync(home), true, "the ordinary caller must retain home while the owned group is alive");
      assert.equal(existsSync(work), true, "the ordinary caller must retain work while the owned group is alive");
      assert.equal(processGroupExists(ownedGroup), true, "the owned group must still be alive after the retained cleanup");
      // Retention proven: clear the pending failure so safe restoration below
      // can reclaim the scratch, then restore only creation-recorded resources.
      pendingError = null;
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
      try { process.kill(-ownedGroup, "SIGKILL"); } catch {}
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        let descendantGone = false;
        try { process.kill(descendantPid, 0); } catch (check) { if (check.code === "ESRCH") descendantGone = true; else throw check; }
        if (descendantGone && !processGroupExists(ownedGroup)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(descendantPid, 0), (check) => check.code === "ESRCH",
        `recorded descendant ${descendantPid} must be gone before scratch deletion`);
      assert.equal(processGroupExists(ownedGroup), false, `owned process group ${ownedGroup} must be gone before scratch deletion`);
      removeScratchAfterVerifiedGroupDeath([home, work], ownedGroup);
      restored = true;
      assert.equal(existsSync(home), false, "safe restoration must leave home removable after verified death");
      assert.equal(existsSync(work), false, "safe restoration must leave work removable after verified death");
    } catch (error) {
      if (!pendingError) pendingError = error;
      throw error;
    } finally {
      if (!restored && existsSync(home)) {
        if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
        if (Number.isInteger(ownedGroup) && ownedGroup > 0) { try { process.kill(-ownedGroup, "SIGKILL"); } catch {} }
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          let descendantGone = descendantPid == null;
          if (!descendantGone) {
            try { process.kill(descendantPid, 0); } catch (check) { if (check.code === "ESRCH") descendantGone = true; }
          }
          const groupGone = !Number.isInteger(ownedGroup) || ownedGroup <= 0 || !processGroupExists(ownedGroup);
          if (descendantGone && groupGone) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        let verifiedGone = true;
        if (descendantPid) {
          try { process.kill(descendantPid, 0); verifiedGone = false; } catch (check) { if (check.code !== "ESRCH") throw check; }
        }
        if (verifiedGone && Number.isInteger(ownedGroup) && ownedGroup > 0 && processGroupExists(ownedGroup)) verifiedGone = false;
        if (verifiedGone) {
          try {
            if (Number.isInteger(ownedGroup) && ownedGroup > 0) removeScratchAfterVerifiedGroupDeath([home, work], ownedGroup);
            else { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
          } catch {}
        }
      } else if (!restored) {
        if (existsSync(work)) { try { rmSync(work, { recursive: true, force: true }); } catch {} }
      }
    }
  });

  it("retains guard caller scratch when owned cleanup cannot be verified", async () => {
    // Guard negative-control counterpart: the same unverified-cleanup
    // retention for runGuardProbe, with denied signals and a no-stdio
    // descendant, through the actual guard caller path.
    const home = mkdtempSync(join(tmpdir(), "bifrost-guard-retention-home-"));
    const pidFile = join(home, "descendant.pid");
    let ownedGroup = null;
    let runSettled = false;
    let pendingError = null;
    let descendantPid = null;
    let restored = false;
    try {
      setOwnedGroupSignalDenial(() => { throw new Error("controlled owned-group signal denial"); });
      try {
        await runGuardProbe({
          command: execPath,
          args: [NORMAL_CLOSE_CLI],
          cwd: home,
          windowMs: 1_000,
          graceMs: 200,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            BIFROST_DESCENDANT_PID_FILE: pidFile,
          },
        }).then(
          (value) => { runSettled = true; ownedGroup = value.ownedGroup; return value; },
          (error) => { runSettled = true; ownedGroup = error?.ownedGroup ?? null; throw error; },
        );
        assert.fail("runGuardProbe must reject when owned-group signals are denied");
      } catch (error) {
        if (error.message.includes("must reject when owned-group signals are denied")) throw error;
        pendingError = error;
        assert.match(error.message, /cleanup failure: the owned process group did not reach a verified dead state/,
          "an unverifiable guard cleanup must be named as its own cause");
        assert.ok(Number.isInteger(ownedGroup) && ownedGroup > 0, "the probe must preserve owned-group ownership");
        assert.equal(processGroupExists(ownedGroup), true, `owned process group ${ownedGroup} must still be alive`);
        descendantPid = Number(readFileSync(pidFile, "utf8"));
        assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "the fixture must record its descendant pid");
        assert.doesNotThrow(() => process.kill(descendantPid, 0), "an unverified guard cleanup must leave ownership intact");
      } finally {
        setOwnedGroupSignalDenial(null);
      }
      retainOrRemoveScratch({ paths: [home], ownedGroup, runSettled, pendingError });
      assert.equal(existsSync(home), true, "the guard caller must retain scratch while the owned group is alive");
      assert.equal(processGroupExists(ownedGroup), true, "the owned group must still be alive after the retained guard cleanup");
      pendingError = null;
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
      try { process.kill(-ownedGroup, "SIGKILL"); } catch {}
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        let descendantGone = false;
        try { process.kill(descendantPid, 0); } catch (check) { if (check.code === "ESRCH") descendantGone = true; else throw check; }
        if (descendantGone && !processGroupExists(ownedGroup)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(descendantPid, 0), (check) => check.code === "ESRCH",
        `recorded descendant ${descendantPid} must be gone before scratch deletion`);
      assert.equal(processGroupExists(ownedGroup), false, `owned process group ${ownedGroup} must be gone before scratch deletion`);
      removeScratchAfterVerifiedGroupDeath([home], ownedGroup);
      restored = true;
      assert.equal(existsSync(home), false, "safe restoration must leave guard scratch removable after verified death");
    } catch (error) {
      if (!pendingError) pendingError = error;
      throw error;
    } finally {
      if (!restored && existsSync(home)) {
        if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
        if (Number.isInteger(ownedGroup) && ownedGroup > 0) { try { process.kill(-ownedGroup, "SIGKILL"); } catch {} }
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          let descendantGone = descendantPid == null;
          if (!descendantGone) {
            try { process.kill(descendantPid, 0); } catch (check) { if (check.code === "ESRCH") descendantGone = true; }
          }
          const groupGone = !Number.isInteger(ownedGroup) || ownedGroup <= 0 || !processGroupExists(ownedGroup);
          if (descendantGone && groupGone) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        let verifiedGone = true;
        if (descendantPid) {
          try { process.kill(descendantPid, 0); verifiedGone = false; } catch (check) { if (check.code !== "ESRCH") throw check; }
        }
        if (verifiedGone && Number.isInteger(ownedGroup) && ownedGroup > 0 && processGroupExists(ownedGroup)) verifiedGone = false;
        if (verifiedGone) {
          try {
            if (Number.isInteger(ownedGroup) && ownedGroup > 0) removeScratchAfterVerifiedGroupDeath([home], ownedGroup);
            else rmSync(home, { recursive: true, force: true });
          } catch {}
        }
      }
    }
  });

  it("waits for close when exit precedes close", async () => {
    const child = spawnOwned(execPath, ["-e", `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 100)"], {
        stdio: ["ignore", "inherit", "ignore"],
      });
      process.stdout.write("exit-gap-ready\\n");
      process.exit(0);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      child.stdout.once("data", (chunk) => {
        if (chunk.includes("exit-gap-ready")) resolve();
        else reject(new Error(`unexpected startup output: ${chunk}`));
      });
      child.once("error", reject);
    });
    await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    assert.equal(closeTracking(child).isClosed, false, "close must not have been observed before stopChild");
    const observed = await stopChild(child);
    assert.equal(closeTracking(child).isClosed, true, "stopChild must await the real close event after exit");
    assert.equal(observed, true, "stopChild must report the observed close");
  });

  it("reports the observed close for an already-closed child", async () => {
    const child = spawnOwned(execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "ignore"] });
    await once(child, "close");
    // The close event already fired. Asserting the boolean result itself keeps
    // this fault-sensitive: mapping any outcome to one string would let a
    // failed closure pass as success.
    assert.equal(await stopChild(child), true, "already-closed child must report its observed close");
    assert.equal(await stopChild(child), true, "a repeated stop must still report an observed close");
    assert.equal(closeTracking(child).isClosed, true, "close must be observed, not inferred");
  });

  it("observes close for a child created without stdio pipes", async () => {
    const child = spawnOwned(execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    // Record when the real close event lands relative to the stop result. With
    // no pipes there is no stream state to inspect, so an inferred fast path
    // would report success before the event it claims to have observed.
    const order = [];
    child.once("close", () => { order.push("close"); });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        order.push("exit");
        closeTracking(child);
        stopChild(child).then((observed) => {
          order.push("stopChild");
          try {
            assert.deepEqual(order, ["exit", "close", "stopChild"],
              "stopChild must resolve only after the real close event, never from an inferred exit");
            assert.equal(observed, true, "no-stdio child must report its observed close");
            assert.equal(closeTracking(child).isClosed, true, "close must be observed, never inferred from exit");
            resolve();
          } catch (error) {
            reject(error);
          }
        }, reject);
      });
    });
  });

  it("force-kills a real SIGTERM-ignoring child, awaits close, and frees its scratch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-term-proof-"));
    const stubborn = spawnOwned(execPath, ["-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('stubborn-ready\\n'); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "ignore"], cwd: scratch });
    let pendingError = null;
    try {
      // Readiness comes from the child's observable ready record, no sleep.
      await new Promise((resolve, reject) => {
        stubborn.stdout.setEncoding("utf8");
        stubborn.stdout.once("data", (chunk) => {
          if (chunk.includes("stubborn-ready")) resolve();
          else reject(new Error(`unexpected startup output: ${chunk}`));
        });
        stubborn.once("error", reject);
        stubborn.once("close", () => reject(new Error("child exited before it could ignore SIGTERM")));
      });
      assert.equal(await stopChild(stubborn, 300), true, "force-kill must reach a verified close");
      // stopChild resolves on close, so the dead child cannot hold the scratch.
      assert.equal(stubborn.exitCode, null, "SIGTERM-ignoring child must not exit via TERM");
      assert.equal(stubborn.signalCode, "SIGKILL", "SIGTERM-ignoring child must be force-killed");
      assert.equal(processGroupExists(stubborn.pid), false, "the owned process group must be gone");
      rmSync(scratch, { recursive: true, force: true });
      assert.equal(existsSync(scratch), false, "scratch must be removable after the forced close");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (existsSync(scratch)) {
        const verified = await stopChild(stubborn, 300);
        if (!verified || processGroupExists(stubborn.pid)) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to delete scratch while owned process group ${stubborn.pid} still alive: ${scratch}`);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it("rejects fake-provider startup when the child exits before its ready record", async () => {
    const failing = spawnOwned(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    await assert.rejects(waitForFakeReady(failing), /fake provider exited before startup/);
    assert.equal(await stopChild(failing), true, "failed startup must still reach a verified close");
  });

  it("settles a timed-out run only after the owned group is verified dead", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-pipe-race-home-"));
    const pidFile = join(home, "descendant.pid");
    let pendingError = null;
    try {
      // The leader exits and its descendant releases the inherited pipes when
      // signalled but keeps running, so the close event lands while a member of
      // the owned group is still alive. A close event is not cleanup evidence:
      // the run must not settle until the group is verified gone.
      const run = runPi({
        home,
        work: home,
        model: "bifrost/auto",
        prompt: "native faux dispatch marker",
        child: "1",
        command: execPath,
        args: [PIPE_RACE_CLI],
        windowMs: 1_000,
        terminationGraceMs: 200,
        extraEnv: { BIFROST_DESCENDANT_PID_FILE: pidFile },
      });
      // withBound clears its own timer when the race settles, so a losing
      // bound cannot idle this process long after the test has finished.
      await assert.rejects(
        withBound(run, 40_000, "runPi stayed pending after its bounded window and owned termination"),
        /exceeded the bounded run window/,
        "a run whose descendant releases the pipes but survives must still fail bounded",
      );
      // Settling above is only legitimate if the group descendant is already
      // dead. Rejecting while it lived is exactly the defect this pins.
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record its descendant pid");
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned group descendant ${pid} survived the run's cleanup`,
      );
      // Verified cleanup means the scratch is safe to reclaim.
      rmSync(home, { recursive: true, force: true });
      assert.equal(existsSync(home), false, "verified cleanup must leave the scratch removable");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (existsSync(home)) {
        const reaped = await reapRecordedDescendant(pidFile);
        if (!reaped) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to delete scratch while recorded descendant from ${pidFile} still alive: ${home}`);
        }
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("reaps a live group descendant behind an already-closed leader", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-closed-leader-"));
    // The descendant takes no inherited pipes at all, so it cannot influence
    // when the leader's close event arrives. Only the owned group's death says
    // anything about it.
    const leader = spawnOwned(execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const d = spawn(process.execPath, ['-e', \"process.send({ pid: process.pid }); setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "d.once('message', (m) => process.stdout.write(JSON.stringify(m) + '\\n', () => process.exit(0)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"], cwd: scratch });
    let pendingError = null;
    try {
      const pid = await new Promise((resolve, reject) => {
        let seen = "";
        leader.stdout.setEncoding("utf8");
        leader.stdout.on("data", (chunk) => {
          seen += chunk;
          try { resolve(JSON.parse(seen).pid); } catch { /* wait for the record */ }
        });
        leader.once("error", reject);
      });
      await once(leader, "close");
      // Safety: cleanup may only ever signal this child's own isolated group,
      // never a parent or shared one.
      assert.equal(processGroupExists(leader.pid), true, "the owned child must lead its own live process group");
      assert.equal(await stopChild(leader), true, "an already-closed leader still needs verified group cleanup");
      assert.equal(processGroupExists(leader.pid), false, "the owned process group must be dead");
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned group descendant ${pid} survived behind a closed leader`,
      );
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (existsSync(scratch)) {
        const verified = await stopChild(leader);
        if (!verified || processGroupExists(leader.pid)) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to delete scratch while owned process group ${leader.pid} still alive: ${scratch}`);
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it("reports a cleanup failure as its own cause instead of a bare timeout", async () => {
    // Forced, not simulated: the child really does exit, but its cleanup
    // reports failure so the caller's cause-clause can be asserted. Both
    // seams are attached synchronously, before close can possibly fire.
    const unverified = spawnOwned(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    forceCleanupFailure(unverified);
    await assert.rejects(
      waitForFakeReady(unverified),
      (error) => {
        assert.match(error.message, /fake provider/, "the startup cause must survive alongside the cleanup cause");
        assert.match(
          error.message,
          /cleanup failure: the owned process group did not reach a verified dead state/,
          "an unverified cleanup must be named as its own cause",
        );
        return true;
      },
      "a startup failure whose cleanup is unverified must name the cleanup failure",
    );
    // Contrast: the same caller with verified cleanup keeps only the startup
    // cause, so the clause above can never be mistaken for ordinary output.
    const verified = spawnOwned(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    await assert.rejects(
      waitForFakeReady(verified),
      (error) => {
        assert.doesNotMatch(error.message, /cleanup failure/, "verified cleanup must not claim a cleanup failure");
        return true;
      },
      "a verified cleanup must report the startup cause alone",
    );
  });

  it("verifies the guard probe's owned group before it rejects or deletes scratch", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-guard-race-home-"));
    const pidFile = join(home, "descendant.pid");
    let pendingError = null;
    try {
      // The guard probe driven against a fixture whose descendant keeps an
      // inherited pipe. A probe close handler that rejects before its own group
      // termination would settle here with the group still alive and the scratch
      // still in use, so this asserts group death and scratch safety too.
      const started = Date.now();
      await assert.rejects(
        withBound(
          runGuardProbe({
            command: execPath,
            args: [DESCENDANT_CLI],
            cwd: home,
            windowMs: 1_000,
            graceMs: 200,
            env: {
              PATH: process.env.PATH,
              HOME: home,
              BIFROST_DESCENDANT_PID_FILE: pidFile,
            },
          }),
          40_000,
          "the guard probe stayed pending past its bound and owned termination",
        ),
        /exceeded its bounded window/,
        "a leaking guard probe must fail bounded rather than settle on its close event",
      );
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs < 30_000, `the guard probe must fail bounded, took ${elapsedMs}ms`);
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned descendant ${pid} survived the guard probe's cleanup`,
      );
      assert.equal(existsSync(home), true, "the scratch must survive until the probe's cleanup is verified");
      rmSync(home, { recursive: true, force: true });
      assert.equal(existsSync(home), false, "verified cleanup must leave the scratch removable");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (existsSync(home)) {
        const reaped = await reapRecordedDescendant(pidFile);
        if (!reaped) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to delete scratch while recorded descendant from ${pidFile} still alive: ${home}`);
        }
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("cleans the owned group before a normal completion is reported", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-normal-close-home-"));
    const pidFile = join(home, "descendant.pid");
    let pendingError = null;
    try {
      // Exit code 0 with a live descendant that owns no inherited pipes. A
      // clean exit and an observed close say nothing about it, so the run must
      // not report success — nor let the caller delete a scratch the group is
      // still using — until the owned group is verified gone.
      const result = await runPi({
        home,
        work: home,
        model: "bifrost/auto",
        prompt: "native faux dispatch marker",
        child: "1",
        command: execPath,
        args: [NORMAL_CLOSE_CLI],
        windowMs: 30_000,
        terminationGraceMs: 500,
        extraEnv: { BIFROST_DESCENDANT_PID_FILE: pidFile },
      });
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record its descendant pid");
      assert.equal(result.code, 0, "the fixture must exit cleanly so only cleanup can decide the outcome");
      // Independent group death, not inferred from the leader's close.
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned descendant ${pid} survived a normally completing run`,
      );
      assert.equal(existsSync(home), true, "the scratch must survive until cleanup is verified");
      // Only now is the scratch safe to reclaim.
      rmSync(home, { recursive: true, force: true });
      assert.equal(existsSync(home), false, "verified cleanup must leave the scratch removable");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (existsSync(home)) {
        const reaped = await reapRecordedDescendant(pidFile);
        if (!reaped) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to delete scratch while recorded descendant from ${pidFile} still alive: ${home}`);
        }
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("exits bounded after an unverified cleanup instead of hanging on inherited pipes", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-whole-run-home-"));
    const pidFile = join(home, "descendant.pid");
    let worker;
    let ownedGroup;
    let descendant;
    let pendingError = null;
    try {
      // The real runPi, in a real worker process, with the owned-group signal
      // step denied. The descendant survives and keeps the inherited pipe, so a
      // worker that merely rejects its promise would still never exit.
      worker = spawnOwned(execPath, [RUNNER_WORKER, home], { stdio: ["ignore", "pipe", "pipe"] });
      ownedGroup = worker.pid;
      const report = await new Promise((resolve, reject) => {
        let text = "";
        worker.stdout.setEncoding("utf8");
        worker.stdout.on("data", (chunk) => {
          text += chunk;
          const line = text.split("\n").find((entry) => entry.startsWith("{"));
          if (line) { try { resolve(JSON.parse(line)); } catch { /* wait for a complete record */ } }
        });
        worker.once("error", reject);
      });
      assert.equal(report.event, "bounded-rejection", "the worker must report the bounded rejection");
      assert.match(report.message, /cleanup failure: the owned process group did not reach a verified dead state/,
        "an unverifiable owned-group cleanup must be named as its own cause");
      assert.match(report.message, /exceeded the bounded run window/, "the primary cause must survive");
      // Unverified cleanup retains scratch and ownership; nothing is deleted.
      assert.equal(report.scratchRetained, true, "an unverified cleanup must retain the scratch");
      assert.equal(existsSync(home), true, "the worker must not delete an unsafe scratch");
      descendant = Number(readFileSync(pidFile, "utf8"));
      assert.doesNotThrow(() => process.kill(descendant, 0), "an unverified cleanup must leave ownership intact");
      // The load-bearing property: the process actually exits, bounded, without
      // waiting on a pipe held by a descendant it could not kill.
      const exitStart = Date.now();
      const exited = await withBound(once(worker, "close").then(() => true), 5_000, "worker close bound expired").then(() => true, () => false);
      const exitMs = Date.now() - exitStart;
      assert.equal(exited, true, `worker hung for ${exitMs}ms after reporting an unverified cleanup`);
      assert.equal(closeTracking(worker).isClosed, true, "the worker must reach a real close");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (existsSync(home)) {
        if (descendant == null && existsSync(pidFile)) {
          try {
            const recorded = Number(readFileSync(pidFile, "utf8"));
            if (Number.isInteger(recorded) && recorded > 0) descendant = recorded;
          } catch {}
        }
        if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
        if (worker) await terminateProcessGroup(worker, { graceMs: 200, cleanupTimeoutMs: 2_000 });
        // SIGKILL needs a bounded reap window before absence can be verified;
        // checking synchronously would mistake a dying pid for a live leak.
        const deadline = Date.now() + 5_000;
        let descendantAlive = false;
        let groupAlive = false;
        while (Date.now() < deadline) {
          descendantAlive = false;
          if (descendant) {
            try { process.kill(descendant, 0); descendantAlive = true; } catch (check) { if (check.code !== "ESRCH") throw check; }
          }
          groupAlive = worker ? processGroupExists(worker.pid) : false;
          if (!descendantAlive && !groupAlive) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (descendantAlive || groupAlive) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to delete scratch while owned resources still alive (descendant=${descendant}, workerGroup=${worker?.pid}): ${home}`);
        }
        rmSync(home, { recursive: true, force: true });
      } else if (worker && processGroupExists(worker.pid)) {
        if (pendingError) throw pendingError;
        throw new Error(`refusing to finish while owned worker group ${worker.pid} still alive`);
      }
    }
  });

  for (const scenario of [
    { name: "fails a bounded run and reaps the owned descendant holding inherited pipes", delayMs: 0 },
    { name: "waits for descendant readiness beyond the old run window", delayMs: 1_500 },
    { name: "fails boundedly and reaps the owned descendant when readiness never arrives", delayMs: 0, neverReady: true },
  ]) it(scenario.name, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-child-descendant-home-"));
    const pidFile = join(home, "descendant.pid");
    let pendingError = null;
    let runError;
    try {
      // Delay is negative stimulus; only the fixture's receipt-backed record
      // starts the unchanged one-second run window.
      const run = runPi({
        home,
        work: home,
        model: "bifrost/auto",
        prompt: "native faux dispatch marker",
        child: "1",
        command: execPath,
        args: [DESCENDANT_CLI],
        readyRecord: "descendant-ready\n",
        startupMs: 3_000,
        windowMs: 1_000,
        terminationGraceMs: 200,
        extraEnv: {
          BIFROST_DESCENDANT_PID_FILE: pidFile,
          BIFROST_DESCENDANT_STARTUP_DELAY_MS: String(scenario.delayMs),
          BIFROST_DESCENDANT_NEVER_READY: scenario.neverReady ? "1" : "0",
        },
      });
      await assert.rejects(
        withBound(run, 30_000, "runPi stayed pending after its bounded window and owned termination"),
        (error) => {
          runError = error;
          t.diagnostic(JSON.stringify({ ownedGroup: error.ownedGroup, verified: error.verified, scratchPaths: error.scratchPaths }));
          assert.match(error.message, scenario.neverReady ? /exceeded the bounded startup window/ : /exceeded the bounded run window/);
          assert.equal(error.verified, true, "cleanup must observe close and prove owned group death");
          return true;
        },
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record its descendant pid");
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned descendant ${pid} must be terminated, not left alive`,
      );
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (runError?.verified !== true || !Number.isInteger(runError.ownedGroup) || runError.ownedGroup <= 0 || processGroupExists(runError.ownedGroup)) {
        if (pendingError) throw pendingError;
        throw new Error(`refusing to delete scratch without verified owned-group cleanup: ${home}`);
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("records forbidden fetch, socket, and UDP attempts through the same preloaded guard", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-guard-negative-home-"));
    let ownedGroup = null;
    let runSettled = false;
    let pendingError = null;
    try {
      const violations = join(home, "test-network-violations.log");
      const forbiddenPort = alternatePort(fakePort);
      // Independent boundary regression: the forbidden port stays legal and
      // distinct for every valid provider port, including the top of the
      // range that the previous arithmetic overflowed.
      assertAlternatePortStaysLegalAndDistinct(65535);
      assert.equal(alternatePort(65535), 65534);
      assert.equal(alternatePort(65534), 65535);
      for (let port = 1; port <= 65535; port += 1) assertAlternatePortStaysLegalAndDistinct(port);
      assertAlternatePortStaysLegalAndDistinct(fakePort);
      writeFileSync(violations, "");
      // Same preload, same guard, same allowed-origin contract as runPi.
      // Without the preload (guard-removal mutation) nothing records the
      // forbidden attempts, so the record assertions below go RED.
      const probe = await runGuardProbe({
        command: execPath,
        args: ["-e", `
          const net = require("node:net");
          const dgram = require("node:dgram");
          (async () => {
            const allowed = await fetch("http://127.0.0.1:${fakePort}/_stats");
            const stats = await allowed.json();
            if (!stats || typeof stats.attempts !== "object") process.exitCode = 7;
            const unreachable = ${forbiddenPort};
            for (const attempt of [
              () => fetch("http://127.0.0.1:" + unreachable),
              () => new Promise((resolveAttempt) => {
                const socket = new net.Socket();
                const done = () => { socket.destroy(); resolveAttempt(); };
                socket.once("error", done);
                try { socket.connect({ port: unreachable, host: "127.0.0.1" }, done); } catch { done(); }
              }),
              () => new Promise((resolveAttempt) => {
                const socket = dgram.createSocket("udp4");
                const done = () => { try { socket.close(); } catch {} resolveAttempt(); };
                try {
                  socket.send(Buffer.from("fixture"), unreachable, "127.0.0.1", done);
                } catch { done(); }
              }),
            ]) { try { await attempt(); } catch {} }
          })();
        `],
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
          BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
          BIFROST_TEST_NETWORK_VIOLATIONS: violations,
        },
      }).then(
        (value) => { runSettled = true; ownedGroup = value.ownedGroup; return value; },
        (error) => { runSettled = true; ownedGroup = error?.ownedGroup ?? null; throw error; },
      );
      assert.equal(probe.code, 0, probe.stderr);
      const attempts = readFileSync(violations, "utf8");
      // Exactly three violations: the guard records the forbidden attempt it
      // blocked and nothing else. An allowed-origin request or an overflowing
      // port that fetch rejects before the guard sees it changes this count.
      const records = attempts.split("\n").map((line) => line.trim()).filter(Boolean);
      assert.equal(records.length, 3, `guard recorded ${records.length} violations: ${JSON.stringify(records)}`);
      assert.deepEqual(records, [
        `blocked fetch to http://127.0.0.1:${forbiddenPort}`,
        `blocked socket connection to 127.0.0.1:${forbiddenPort}`,
        "blocked UDP datagram to 127.0.0.1",
      ], "forbidden fetch, socket, and UDP attempts must each be recorded exactly once");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      // The probe runs with cwd ROOT but records violations into home: the
      // home scratch may only be reclaimed after the probe's owned group is
      // independently proven gone, exactly like the main routing caller.
      retainOrRemoveScratch({ paths: [home], ownedGroup, runSettled, pendingError });
    }
  });
});
