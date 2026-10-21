// Cancellation ownership proof for the shared fake-provider launcher.
//
// The reproduced leak: cache-lifecycle and command-privacy each spawned the
// fake provider with `detached: true` and `unref()`. An acceptance gate cancels
// a timed-out suite by signalling the suite's process group; the detached
// provider escaped that boundary and survived with PPID 1 and its own PGID.
//
// This control proves the contract deterministically:
//   1. baseline GREEN  — the shared owner's provider dies with the cancelled
//                        owner group and its creation pid is absent;
//   2. bypass RED      — a private re-introduction of detached+unref leaves a
//                        real orphan, and the named assertion rejects it;
//   3. restored GREEN  — the shared owner passes again.
//
// It also guards the two migrated paths against re-introducing a duplicate
// launcher. Only creation-time receipts (owner pid, provider pid) are signalled;
// there is no pattern matching and no cleanup sweep.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHARED_OWNER = join(ROOT, "tests", "fixtures", "http-pi-harness.mjs");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const WIN32 = process.platform === "win32";
const MIGRATED_PATHS = [
  "tests/integration/cache-lifecycle-acceptance.test.mjs",
  "tests/integration/command-privacy-acceptance.test.mjs",
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function waitFor(predicate, boundMs, describeFailure) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  throw new Error(typeof describeFailure === "function" ? describeFailure() : describeFailure);
}

const BASELINE_WORKER = `
import { writeFileSync } from "node:fs";
import { startFakeProviderServer } from ${JSON.stringify(SHARED_OWNER)};

const server = await startFakeProviderServer();
writeFileSync(process.argv[2], JSON.stringify({
  ownerPid: process.pid,
  serverPid: server.child.pid,
  owner: "shared",
}));
setInterval(() => {}, 1000);
`;

// Ownership bypass: the exact pre-fix shape. Kept private to this control and
// never imported by a suite under test.
const BYPASS_WORKER = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, [${JSON.stringify(FAKE_SERVER)}], {
  stdio: ["ignore", "pipe", "ignore"],
  detached: true,
});
child.unref();
let output = "";
child.stdout.setEncoding("utf8");
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("bypass provider startup timed out")), 10_000);
  child.stdout.on("data", (chunk) => {
    output += chunk;
    try {
      const record = JSON.parse(output);
      clearTimeout(timer);
      resolve(record);
    } catch { /* wait for the startup record */ }
  });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", () => { clearTimeout(timer); reject(new Error("bypass provider exited before startup")); });
});
writeFileSync(process.argv[2], JSON.stringify({
  ownerPid: process.pid,
  serverPid: child.pid,
  port: ready.port,
  owner: "bypass",
}));
setInterval(() => {}, 1000);
`;

function ownedProviderAbsent(receipt, label) {
  assert.equal(processGroupExists(receipt.ownerPid), false,
    `${label}: owner process group must be absent after cancellation`);
  assert.equal(isProcessAlive(receipt.serverPid), false,
    `${label}: owned fake provider must be absent after owner cancellation`);
}

async function runCancelledOwner({ scratch, runs, label, source, hard = true, direct = false, observeGroup = processGroupExists }) {
  const workerPath = join(scratch, `${label}.mjs`);
  const receiptPath = join(scratch, `${label}.json`);
  writeFileSync(workerPath, source);
  const worker = spawn(process.execPath, [workerPath, receiptPath], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  let closeObserved = false;
  const closed = new Promise((resolve) => worker.once("close", (code, signal) => {
    closeObserved = true;
    resolve({ code, signal });
  }));
  const owned = { worker, closed, receiptPath, receipt: undefined, isClosed: () => closeObserved };
  runs.push(owned);
  try {
    await waitFor(() => existsSync(receiptPath), 15_000,
      () => `${label}: worker did not publish its creation receipt (stderr=${stderr.trim()})`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.ok(Number.isInteger(receipt.ownerPid) && receipt.ownerPid > 0,
      `${label}: creation-time owner pid must be recorded`);
    assert.ok(Number.isInteger(receipt.serverPid) && receipt.serverPid > 0,
      `${label}: creation-time provider pid must be recorded`);
    assert.equal(receipt.ownerPid, worker.pid,
      `${label}: receipt must identify the actual spawned owner`);

    owned.receipt = receipt;

    // Hard cancellation is the acceptance gate's escalation: a handler cannot
    // run, so only process-group membership can keep the provider owned.
    let terminated;
    if (direct) {
      worker.kill("SIGTERM");
      await waitFor(() => !processGroupExists(worker.pid), 5_000,
        `${label}: direct owner cancellation must also reap its provider`);
      terminated = true;
    } else if (hard) {
      try { process.kill(-worker.pid, "SIGKILL"); } catch { /* group already gone */ }
      await Promise.race([closed, delay(3_000)]);
      // Owner close can precede OS reaping of the rest of its group. Require
      // bounded observed absence rather than equating these separate events.
      await waitFor(() => !observeGroup(worker.pid), 5_000,
        `${label}: owner process group must terminate`);
      terminated = true;
    } else {
      // Graceful cancellation also exercises the direct-signal handler path.
      terminated = await terminateProcessGroup(worker, { graceMs: 1_000, cleanupTimeoutMs: 5_000 });
      await Promise.race([closed, delay(2_000)]);
    }
    assert.equal(terminated, true, `${label}: owner process group must terminate`);
    return receipt;
  } finally {
    // Reclaim only the group this control created, never a pattern or a parent.
    if (processGroupExists(worker.pid)) {
      await terminateProcessGroup(worker, { graceMs: 100, cleanupTimeoutMs: 2_000 });
    }
    worker.stderr.destroy();
    worker.unref();
  }
}

it("owns the fake provider across owner cancellation (baseline GREEN, bypass RED, restored GREEN)", { skip: WIN32, timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-provider-ownership-"));
  const runs = [];
  let pendingError;
  try {
    // 1. Baseline GREEN: the shared owner is cancellation-safe.
    let absentObservations = 0;
    const observeDelayedAbsence = (pid) => {
      const exists = processGroupExists(pid);
      // Conservatively report one extra live observation only after real death.
      // Removing the caller's wait must fail even on a fast-reaping host.
      if (!exists && ++absentObservations === 1) return true;
      return exists;
    };
    const baseline = await runCancelledOwner({ scratch, runs, label: "baseline", source: BASELINE_WORKER,
      observeGroup: observeDelayedAbsence });
    assert.ok(absentObservations >= 2, "hard cancellation must observe group absence after the delayed observation");
    assert.doesNotThrow(() => ownedProviderAbsent(baseline, "baseline"),
      "the shared owner must tear its provider down with the cancelled owner group");

    // 2. Ownership bypass RED: same assertion, old detached+unref shape.
    const bypassReceipt = await runCancelledOwner({ scratch, runs, label: "bypass", source: BYPASS_WORKER });
    assert.throws(
      () => ownedProviderAbsent(bypassReceipt, "ownership bypass"),
      /owned fake provider must be absent after owner cancellation/,
      "a detached provider that survives its owner must fail the named ownership assertion",
    );
    // The bypass server is its own group leader; reclaim exactly that receipt.
    assert.equal(await terminateProcessGroup({ pid: bypassReceipt.serverPid }, { graceMs: 1_000, cleanupTimeoutMs: 5_000 }), true,
      "the bypass provider group must terminate under its own creation receipt");
    assert.equal(processGroupExists(bypassReceipt.serverPid), false,
      "the bypass provider group must be absent after receipt-based reclamation");

    // 3. Restored GREEN: the shared owner still passes after the fault.
    const restored = await runCancelledOwner({ scratch, runs, label: "restored", source: BASELINE_WORKER, hard: false });
    assert.doesNotThrow(() => ownedProviderAbsent(restored, "restored"),
      "restoring the shared owner must restore cancellation-safe teardown");
    const direct = await runCancelledOwner({ scratch, runs, label: "direct", source: BASELINE_WORKER, direct: true });
    ownedProviderAbsent(direct, "direct owner signal");
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    // Keep every creation receipt even if a phase throws before returning.
    // Reclaim scratch only after observed owner close and proven process death.
    const failures = [];
    for (const owned of runs) {
      try {
        if (processGroupExists(owned.worker.pid)) {
          assert.equal(await terminateProcessGroup(owned.worker, { graceMs: 100, cleanupTimeoutMs: 2_000 }), true);
        }
        await Promise.race([owned.closed, delay(2_000)]);
        const receipt = owned.receipt ?? (existsSync(owned.receiptPath)
          ? JSON.parse(readFileSync(owned.receiptPath, "utf8")) : undefined);
        assert.equal(receipt?.ownerPid, owned.worker.pid, "cleanup requires the actual owner receipt");
        assert.ok(Number.isInteger(receipt.serverPid) && receipt.serverPid > 0);
        if (isProcessAlive(receipt.serverPid)) {
          if (receipt.owner === "bypass") {
            assert.equal(await terminateProcessGroup({ pid: receipt.serverPid }, { graceMs: 100, cleanupTimeoutMs: 2_000 }), true);
          } else {
            process.kill(receipt.serverPid, "SIGKILL");
          }
          await waitFor(() => !isProcessAlive(receipt.serverPid), 2_000, "recorded provider must die before reclaim");
        }
        assert.equal(owned.isClosed(), true, "owner close must be observed before reclaim");
        ownedProviderAbsent(receipt, "cleanup");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) {
      try { rmSync(scratch, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      const cleanupError = new AggregateError(failures, `unverified provider cleanup; retained ${scratch}`);
      if (pendingError) {
        pendingError.cleanupError = cleanupError;
        pendingError.retainedScratch = scratch;
      } else {
        throw cleanupError;
      }
    }
  }
});

it("keeps one fake-provider owner in the two former leak paths", () => {
  for (const relative of MIGRATED_PATHS) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    assert.match(source, /startFakeProviderServer/,
      `${relative} must use the shared fake-provider owner`);
    assert.doesNotMatch(source, /fake-provider-server\.mjs/,
      `${relative} must not re-introduce a duplicate fake-provider launcher`);
    assert.doesNotMatch(source, /async function startFakeServer\s*\(/,
      `${relative} must not re-introduce a local startFakeServer`);
    assert.doesNotMatch(source, /server\?\.shutdown\(/,
      `${relative} must use the shared owner's guarded stop()`);
  }
});
