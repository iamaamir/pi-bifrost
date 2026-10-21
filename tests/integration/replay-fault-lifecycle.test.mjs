import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { processGroupExists } from "../../scripts/acceptance/core.mjs";
import { NORMAL_CLOSE_CLI, ROOT, setOwnedGroupSignalDenial, spawnOwned } from "../fixtures/child-auto-inline-harness.mjs";
import {
  FAULT_PROOFS,
  assertAssertionGreen,
  assertAssertionRed,
  removeScratchAfterVerifiedGroupDeath,
  runNamedReplayAssertion,
  runReplayGuardFaultProof,
} from "../fixtures/replay-fault-control.mjs";

// Focused lifecycle controls for the G03 replay fault control itself. Each
// control owns its children and private scratch; nothing here is guessed and
// shared helpers (scripts/acceptance/core.mjs, child-auto-inline-harness.mjs)
// are only reused, never edited. Skips on win32 where process groups do not
// exist as an owned signal target.
const WIN32 = process.platform === "win32";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function waitForGone(pid, group, boundMs = 5_000) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const descendantGone = pid == null || !isAlive(pid);
    const groupGone = !Number.isInteger(group) || group <= 0 || !processGroupExists(group);
    if (descendantGone && groupGone) return true;
    await sleep(25);
  }
  return false;
}

// Best-effort, non-throwing reclaim used by control finally blocks: kill only
// creation-recorded resources, verify the owned group and recorded descendant
// are absent, and delete the scratch only when both are proven gone. Never
// throws, so a finally here cannot mask the pending assertion failure, and a
// group that cannot be verified dead keeps its scratch.
async function safeReclaim({ scratch, ownedGroup, descendantPid, pidDir }) {
  if (Number.isInteger(descendantPid) && descendantPid > 0) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
  if (Number.isInteger(ownedGroup) && ownedGroup > 0) { try { process.kill(-ownedGroup, "SIGKILL"); } catch {} }
  await waitForGone(descendantPid, ownedGroup);
  const groupGone = !Number.isInteger(ownedGroup) || ownedGroup <= 0 || !processGroupExists(ownedGroup);
  const descendantGone = !Number.isInteger(descendantPid) || descendantPid <= 0 || !isAlive(descendantPid);
  if (scratch && existsSync(scratch) && groupGone && descendantGone) rmSync(scratch, { recursive: true, force: true });
  if (pidDir && existsSync(pidDir)) rmSync(pidDir, { recursive: true, force: true });
  return { groupGone, descendantGone };
}

describe("G03 replay fault control lifecycle", { concurrency: 1 }, () => {
  it("accepts exactly one GREEN pass and rejects a reporter pass count of 10", () => {
    const base = { timedOut: false, spawnError: null, verified: true, status: 0, stderr: "" };
    assert.doesNotThrow(() => assertAssertionGreen({ ...base, stdout: "ℹ pass 1\nℹ fail 0\n" }, "single-pass copy"));
    assert.throws(() => assertAssertionGreen({ ...base, stdout: "ℹ pass 10\nℹ fail 0\n" }, "ten-pass copy"),
      /exactly one passing assertion/, "a pass count of 10 must not satisfy the exact pass-1 format");
  });

  it("terminates a hung owned run, verifies group absence, and refuses a timeout as RED evidence", { skip: WIN32 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-g03-lifecycle-timeout-"));
    const marker = FAULT_PROOFS.sideEffectFreeAllowanceOutputEffect.redAssertionMessage;
    let ownedGroup = null;
    try {
      const hang = `process.stdout.write(${JSON.stringify(`AssertionError [ERR_ASSERTION]: ${marker}`)}); setInterval(() => {}, 1000);`;
      const receipt = await runNamedReplayAssertion({
        scratch,
        command: execPath,
        args: ["-e", hang],
        timeoutMs: 400,
        terminationGraceMs: 1_000,
      });
      // Capture ownership before any assertion so the finally can reclaim safely.
      ownedGroup = receipt.ownedGroup;
      assert.equal(receipt.timedOut, true, "the run must report its bounded timeout");
      assert.equal(receipt.verified, true, "the owned group must be proven dead after bounded termination");
      assert.ok(Number.isInteger(ownedGroup) && ownedGroup > 0, "the owned group id must be captured at creation");
      assert.equal(processGroupExists(ownedGroup), false, "the owned process group must be gone");
      assert.match(receipt.stdout, /AssertionError/, "the hung run printed the text that must not be accepted");
      assert.throws(() => assertAssertionRed(receipt, marker), /timed out/i,
        "a timeout that printed the matching text must not be accepted as RED evidence");

      // Verified death: the scratch is safe to reclaim.
      assert.doesNotThrow(() => removeScratchAfterVerifiedGroupDeath([scratch], receipt.ownedGroup));
      assert.equal(existsSync(scratch), false, "verified group death must allow scratch reclamation");
    } finally {
      await safeReclaim({ scratch, ownedGroup });
    }
  });

  it("retains the proof scratch and preserves the pending failure when owned-group signals are denied", { skip: WIN32 }, async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "bifrost-g03-lifecycle-denied-"));
    const pidFile = join(pidDir, "descendant.pid");
    let ownedGroup = null;
    let descendantPid = null;
    let retainedScratch = null;
    try {
      setOwnedGroupSignalDenial(() => { throw new Error("controlled owned-group signal denial"); });
      await assert.rejects(
        runReplayGuardFaultProof({
          root: ROOT,
          proof: FAULT_PROOFS.autoBoundaryToolSideEffect,
          runOptions: {
            command: execPath,
            args: [NORMAL_CLOSE_CLI],
            env: { ...process.env, BIFROST_DESCENDANT_PID_FILE: pidFile },
            timeoutMs: 5_000,
          },
        }),
        (error) => {
          // Capture ownership before the remaining assertions.
          ownedGroup = error.ownedGroup;
          retainedScratch = error.scratch;
          assert.equal(error.verified, false, "an unverifiable cleanup must be named as such");
          assert.match(error.message, /did not reach a verified dead state/,
            "the cleanup failure must be its own clause on the pending failure");
          assert.ok(Number.isInteger(ownedGroup) && ownedGroup > 0, "the run must preserve owned-group ownership");
          assert.equal(error.scratchRetained, true, "the pending failure must preserve retained-scratch ownership");
          assert.ok(typeof retainedScratch === "string" && retainedScratch.length > 0, "the pending failure must carry the retained scratch path");
          assert.deepEqual(error.scratchPaths, [retainedScratch], "the receipt paths must point at the retained scratch");
          return true;
        },
      );
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "the private fixture must record its descendant pid");
      assert.equal(existsSync(retainedScratch), true, "the scratch must be retained while the owned group is not proven dead");
      assert.equal(isAlive(descendantPid), true, "the unverified group descendant must still be alive");
    } finally {
      setOwnedGroupSignalDenial(null);
      await safeReclaim({ scratch: retainedScratch, ownedGroup, descendantPid, pidDir });
    }
    assert.equal(existsSync(retainedScratch), false, "verified death must reclaim the retained scratch");
  });

  it("retains scratch when an injected runner throws after spawning, then reclaims after verified death", { skip: WIN32 }, async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "bifrost-g03-lifecycle-throw-"));
    const pidFile = join(pidDir, "descendant.pid");
    let ownedGroup = null;
    let descendantPid = null;
    let retainedScratch = null;
    try {
      await assert.rejects(
        runReplayGuardFaultProof({
          root: ROOT,
          proof: FAULT_PROOFS.autoBoundaryToolSideEffect,
          runAssertion: async ({ scratch, onOwned }) => {
            // Spawn a real owned descendant that outlives the leader, then throw
            // before returning any receipt — the shape that previously lost
            // ownership and let finalize delete a live group's scratch.
            const child = spawnOwned(execPath, [NORMAL_CLOSE_CLI], {
              cwd: scratch,
              env: { ...process.env, BIFROST_DESCENDANT_PID_FILE: pidFile },
              stdio: ["ignore", "ignore", "ignore"],
            });
            ownedGroup = child.pid;
            onOwned(child.pid);
            await once(child, "close");
            throw new Error("controlled throw after spawn before any receipt");
          },
        }),
        (error) => {
          // Capture ownership before the remaining assertions.
          ownedGroup = ownedGroup ?? error.ownedGroups?.[0] ?? null;
          retainedScratch = error.scratch;
          assert.match(error.message, /controlled throw after spawn/,
            "the injected failure must be preserved, not replaced by a delete error");
          assert.equal(error.scratchRetained, true, "an incomplete receipt must retain scratch ownership");
          assert.ok(typeof retainedScratch === "string" && existsSync(retainedScratch), "the retained scratch must still exist");
          assert.ok(error.ownedGroups.includes(ownedGroup), "creation-time ownership must survive the throw");
          return true;
        },
      );
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "the private fixture must record its descendant pid");
      assert.equal(existsSync(retainedScratch), true, "the scratch must survive an injected post-spawn throw");
      assert.equal(isAlive(descendantPid), true, "the spawned descendant must still be alive while scratch is retained");
    } finally {
      await safeReclaim({ scratch: retainedScratch, ownedGroup, descendantPid, pidDir });
    }
    assert.equal(existsSync(retainedScratch), false, "verified death must reclaim the retained scratch");
  });

  it("preserves a real assertion failure and reclaims scratch once the owned group is verified dead", { skip: WIN32 }, async () => {
    const proof = {
      ...FAULT_PROOFS.allowanceRetryBoundaryV2,
      redAssertionMessage: "this-concrete-observable-is-deliberately-absent",
    };
    await assert.rejects(
      runReplayGuardFaultProof({ root: ROOT, proof }),
      (error) => {
        assert.match(error.message, /RED missing expected message/,
          "the original assertion failure must not be replaced by a scratch-deletion error");
        assert.equal(error.scratchRetained, false, "a verified-dead group must allow reclamation even on failure");
        assert.ok(typeof error.scratch === "string" && error.scratch.length > 0, "the failure must still report the scratch it owned");
        assert.equal(existsSync(error.scratch), false, "the scratch must be reclaimed after verified group death");
        return true;
      },
    );
  });
});
