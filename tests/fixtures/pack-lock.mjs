import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** True only when the recorded holder process provably no longer exists. */
function holderIsGone(path) {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch {
    // A lock that cannot be read is treated as held, never removed blindly.
    return false;
  }
}

/**
 * Acquire the cross-process lock guarding a checkout's `dist/router` output.
 *
 * `npm pack` runs the `prepack` build, which replaces `dist/router` in place.
 * The unit suite runs the packed-package tests while the acceptance runner's
 * manifest-evidence gate runs the same file in a child process, so two builds
 * can otherwise overlap and one pack archives a half-rebuilt tree. Returns the
 * release function; only a holder whose process is proven gone is reclaimed.
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
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for the packed-package build lock at ${path}`);
      }
      sleep(pollMs);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  return () => {
    closeSync(fd);
    rmSync(path, { force: true });
  };
}

/** Run `run` while holding the packed-package build lock for `root`. */
export function withPackLock(root, run, options) {
  const release = acquirePackLock(root, options);
  try {
    return run();
  } finally {
    release();
  }
}
