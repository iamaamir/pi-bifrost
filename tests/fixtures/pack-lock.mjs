import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 25;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lock path for one checkout's packed-package build output.
 *
 * Keyed by the checkout root so worktrees never contend, and placed in the OS
 * temp directory so a lock file never appears in the repository tree.
 */
export function packLockPath(root) {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(tmpdir(), `pi-bifrost-pack-${digest}.lock`);
}

/** Recorded holder of a lock file, or undefined when it is missing or unreadable. */
function readOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** True only for a PID the kernel reports as nonexistent. */
function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

/** True only when the recorded holder process provably no longer exists. */
function holderIsGone(path) {
  const owner = readOwner(path);
  // A lock that is missing or cannot be read is treated as held.
  return owner !== undefined && processGone(owner.pid);
}

/** Serialize every path mutation, including recovery and release.
 *
 * A guard left by a process killed during this short critical section is not
 * stolen: its owner cannot be proven from a mkdir alone. Waiters time out
 * rather than risk letting two builders run concurrently.
 */
function withGuard(path, deadline, pollMs, run) {
  const guard = `${path}.guard`;
  for (;;) {
    try {
      mkdirSync(guard, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for packed-package lock guard at ${guard}`);
      sleep(pollMs);
    }
  }
  try {
    return run();
  } finally {
    rmdirSync(guard);
  }
}

/** Reclaim a lock only after checking its current holder under the guard. */
export function reclaimStaleLock(path, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  return withGuard(path, deadline, pollMs, () => {
    const owner = readOwner(path);
    if (owner === undefined || !processGone(owner.pid)) return undefined;
    rmSync(path);
    return owner;
  });
}

/** Acquire the cross-process lock guarding a checkout's `dist/router` output. */
export function acquirePackLock(root, options = {}) {
  const path = packLockPath(root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const record = JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomUUID() });
  let fd;
  for (;;) {
    const acquired = withGuard(path, deadline, pollMs, () => {
      if (holderIsGone(path)) rmSync(path);
      try {
        fd = openSync(path, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") return false;
        throw error;
      }
      try {
        writeFileSync(fd, record);
      } catch (error) {
        closeSync(fd);
        rmSync(path, { force: true });
        throw error;
      }
      return true;
    });
    if (acquired) break;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for the packed-package build lock at ${path}`);
    sleep(pollMs);
  }
  return () => {
    closeSync(fd);
    // Take a fresh bounded wait: long builds may exceed the acquisition deadline.
    withGuard(path, Date.now() + timeoutMs, pollMs, () => {
      let owned = false;
      try { owned = readFileSync(path, "utf8") === record; } catch { /* already absent */ }
      if (owned) rmSync(path, { force: true });
    });
  };
}

/**
 * Run `run` while holding the packed-package build lock for `root`.
 *
 * The lock is held until a returned promise settles, so an async build cannot
 * release the lock while it is still writing `dist/router`.
 */
export function withPackLock(root, run, options) {
  const release = acquirePackLock(root, options);
  let result;
  try {
    result = run();
  } catch (error) {
    release();
    throw error;
  }
  if (result !== null && typeof result?.then === "function") return result.finally(release);
  release();
  return result;
}
