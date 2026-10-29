import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Remove a lock whose recorded holder is gone without deleting a live one.
 *
 * `rename` is the claim: the file system moves the lock for exactly one
 * reclaimer, so a second reclaimer gets ENOENT and retries instead of deleting
 * the lock the winner just created. The claimed file is inspected afterwards
 * because a live holder can create a lock between the staleness read and the
 * claim; that lock is linked back into place rather than discarded, and the
 * release path only unlinks a file it still owns.
 *
 * Returns the claimed record when this call reclaimed a dead holder's lock.
 */
export function reclaimStaleLock(path) {
  const claim = `${path}.claim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, claim);
  } catch (error) {
    // Another reclaimer claimed it first, or the holder released normally.
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const owner = readOwner(claim);
    if (owner === undefined || processGone(owner.pid)) return owner;
    // A live holder owned the claimed file: put it back. A third process may
    // have taken the path meanwhile, in which case that lock wins and the
    // displaced holder's release notices it no longer owns the file.
    try { linkSync(claim, path); } catch { /* path is owned by another process */ }
    return undefined;
  } finally {
    rmSync(claim, { force: true });
  }
}

/**
 * Acquire the cross-process lock guarding a checkout's `dist/router` output.
 *
 * `npm pack` runs the `prepack` build, which replaces `dist/router` in place.
 * The unit suite runs the packed-package tests while the acceptance runner's
 * manifest-evidence gate runs the same file in a child process, so two builds
 * can otherwise overlap and one pack archives a half-rebuilt tree. Returns the
 * release function; only a holder whose process is proven gone is reclaimed,
 * and only one reclaimer can claim that holder's file.
 */
export function acquirePackLock(root, options = {}) {
  const path = packLockPath(root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(path, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (holderIsGone(path)) {
        reclaimStaleLock(path);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for the packed-package build lock at ${path}`);
      }
      sleep(pollMs);
    }
  }
  // The record doubles as the ownership token: release compares the file with
  // these exact bytes, so a rejected or reclaimed replacement is never removed.
  const record = JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomUUID() });
  try {
    writeFileSync(fd, record);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  return () => {
    closeSync(fd);
    let owned = false;
    try {
      owned = readFileSync(path, "utf8") === record;
    } catch {
      // Already released or displaced; nothing of ours is left to remove.
    }
    if (owned) rmSync(path, { force: true });
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
