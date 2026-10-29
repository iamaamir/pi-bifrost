import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packLockPath, reclaimStaleLock } from "./fixtures/pack-lock.mjs";

const moduleUrl = pathToFileURL(fileURLToPath(new URL("./fixtures/pack-lock.mjs", import.meta.url))).href;

// A worker enters and leaves the guarded section, recording both edges in a
// journal. The journal is the only shared state, so a lock violation shows up
// as an interleaved start/start/end/end rather than as a data race.
const WORKER = `
import { appendFileSync } from "node:fs";
import { withPackLock } from ${JSON.stringify(moduleUrl)};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const section = () => {
  appendFileSync(process.env.PACK_JOURNAL, "start\\n");
  sleep(300);
  appendFileSync(process.env.PACK_JOURNAL, "end\\n");
  if (process.env.PACK_THROW === "1") throw new Error("simulated packed-package failure");
};
if (process.env.PACK_LOCK === "bypass") section();
else withPackLock(process.env.PACK_ROOT, section, { timeoutMs: 30_000 });
`;

/** Run one worker process and resolve with its exit status and stderr. */
function runWorker(root, journal, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", WORKER], {
      env: { ...process.env, PACK_ROOT: root, PACK_JOURNAL: journal, ...env },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function journalOf(path) {
  return readFileSync(path, "utf8").trim().split("\n");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** PID of a child process that has already exited, so the kernel reports it gone. */
function exitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => resolve(child.pid));
  });
}

/** Block until the journal holds at least `lines` entries. */
function waitForJournal(path, lines, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (journalOf(path).length >= lines) return;
    } catch {
      // The worker has not written yet.
    }
    if (Date.now() >= deadline) throw new Error(`journal did not reach ${lines} lines within ${timeoutMs}ms`);
    sleep(10);
  }
}

function claimFiles(lock) {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`${basename(lock)}.claim-`));
}

/** Isolated lock key space so this file never contends with the real suite. */
function isolatedRoot() {
  return mkdtempSync(join(tmpdir(), "bifrost-pack-lock-"));
}

describe("packed-package build lock", () => {
  it("serializes overlapping packed-package builds across processes", async () => {
    const root = isolatedRoot();
    const journal = join(root, "journal.txt");
    try {
      const [first, second] = await Promise.all([runWorker(root, journal), runWorker(root, journal)]);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(journalOf(journal), ["start", "end", "start", "end"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the lock when a guarded build throws", async () => {
    const root = isolatedRoot();
    const journal = join(root, "journal.txt");
    try {
      const failed = await runWorker(root, journal, { PACK_THROW: "1" });
      assert.notEqual(failed.code, 0, "the simulated build failure must fail its process");
      assert.equal(existsSync(packLockPath(root)), false, "a throwing build must still release the lock");
      const next = await runWorker(root, journal);
      assert.equal(next.code, 0, "the next build must acquire the released lock");
      assert.deepEqual(journalOf(journal), ["start", "end", "start", "end"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("two workers recovering the same stale lock never overlap their builds", async () => {
    const root = isolatedRoot();
    const journal = join(root, "journal.txt");
    const lock = packLockPath(root);
    try {
      writeFileSync(lock, JSON.stringify({ pid: await exitedPid(), createdAt: Date.now() - 60_000 }));
      const [first, second] = await Promise.all([runWorker(root, journal), runWorker(root, journal)]);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(journalOf(journal), ["start", "end", "start", "end"]);
      assert.equal(existsSync(lock), false, "the recovered lock must be released by its holder");
      assert.deepEqual(claimFiles(lock), [], "recovery must not leave claim files behind");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovery never deletes a lock a live holder created in the meantime", async () => {
    const root = isolatedRoot();
    const journal = join(root, "journal.txt");
    const lock = packLockPath(root);
    try {
      writeFileSync(lock, JSON.stringify({ pid: await exitedPid(), createdAt: Date.now() - 60_000 }));
      const holder = runWorker(root, journal);
      try {
        waitForJournal(journal, 1);
        const live = JSON.parse(readFileSync(lock, "utf8"));
        // A reclaimer acting on the stale record it read earlier must not
        // remove the lock the live holder now owns.
        assert.equal(reclaimStaleLock(lock), undefined, "a live lock must not be reclaimed");
        assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, live.pid, "the live lock must be restored in place");
        assert.deepEqual(claimFiles(lock), [], "recovery must not leave claim files behind");
      } finally {
        const result = await holder;
        assert.equal(result.code, 0, result.stderr);
      }
      assert.deepEqual(journalOf(journal), ["start", "end"]);
      assert.equal(existsSync(lock), false, "the holder must still remove the lock it owns");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("release removes only the lock it still owns", async () => {
    const root = isolatedRoot();
    const journal = join(root, "journal.txt");
    const lock = packLockPath(root);
    const foreign = JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: "foreign-holder" });
    try {
      const holder = runWorker(root, journal);
      try {
        waitForJournal(journal, 1);
        // Simulate the holder's file being replaced by another process's lock
        // while it is inside the section.
        writeFileSync(lock, foreign);
      } finally {
        const result = await holder;
        assert.equal(result.code, 0, result.stderr);
      }
      assert.equal(readFileSync(lock, "utf8"), foreign, "a foreign lock must survive the displaced holder's release");
    } finally {
      rmSync(lock, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fault control: bypassing the lock interleaves the same two builds", async () => {
    const root = isolatedRoot();
    const journal = join(root, "journal.txt");
    try {
      const [first, second] = await Promise.all([
        runWorker(root, journal, { PACK_LOCK: "bypass" }),
        runWorker(root, journal, { PACK_LOCK: "bypass" }),
      ]);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(journalOf(journal), ["start", "start", "end", "end"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
