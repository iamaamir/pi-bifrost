import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packLockPath } from "./fixtures/pack-lock.mjs";

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
