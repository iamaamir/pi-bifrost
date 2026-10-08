import * as fs from "node:fs";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 30_000;
const MAX_LOCK_POLL_MS = 250;
const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReliabilitySourceFenceErrorCode = "contended" | "timeout" | "unsafe_source" | "source_changed" | "owner_lost" | "lock_create_failed";

export class ReliabilitySourceFenceError extends Error {
  readonly code: ReliabilitySourceFenceErrorCode;

  constructor(code: ReliabilitySourceFenceErrorCode, message: string) {
    super(message);
    this.name = "ReliabilitySourceFenceError";
    this.code = code;
  }
}

export interface ReliabilitySourceFenceOwner {
  readonly path: string;
  readonly ownerToken: string;
  readonly dev: number;
  readonly ino: number;
}

export interface ReliabilitySourceSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export function reliabilitySourceFencePath(sourcePath: string): string {
  return `${resolve(sourcePath)}.migration.lock`;
}

/** Synchronous v1 persistence must fail fast instead of blocking Pi's event loop. */
export function acquireReliabilitySourceFenceSync(sourcePath: string): ReliabilitySourceFenceOwner {
  return createOwner(sourcePath);
}

/** Migration waits for a cooperative v1 writer, but never steals or repairs its lock. */
export async function acquireReliabilitySourceFence(
  sourcePath: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ReliabilitySourceFenceOwner> {
  const timeoutMs = options.timeoutMs ?? MAX_LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? 10;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_LOCK_WAIT_MS
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > MAX_LOCK_POLL_MS) {
    throw new ReliabilitySourceFenceError("lock_create_failed", "Reliability migration lock wait settings are invalid.");
  }
  const started = performance.now();
  while (true) {
    try {
      return createOwner(sourcePath);
    } catch (error) {
      if (!(error instanceof ReliabilitySourceFenceError) || error.code !== "contended") throw error;
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new ReliabilitySourceFenceError("timeout", "Reliability source is busy; stop other Pi sessions and retry migration.");
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, Math.min(pollMs, remaining)));
    }
  }
}

export function releaseReliabilitySourceFence(owner: ReliabilitySourceFenceOwner): void {
  if (!ownsLock(owner)) throw new ReliabilitySourceFenceError("owner_lost", "Reliability source lock ownership changed; the lock was left untouched.");
  const current = lstatRegular(owner.path);
  if (!current || current.dev !== owner.dev || current.ino !== owner.ino) {
    throw new ReliabilitySourceFenceError("owner_lost", "Reliability source lock identity changed; the lock was left untouched.");
  }
  fs.unlinkSync(owner.path);
}

export function reliabilitySourceFenceOwned(owner: ReliabilitySourceFenceOwner): boolean {
  return ownsLock(owner);
}

/** Reads a bounded no-follow v1 source and records enough identity to recheck it before commit. */
export function readReliabilitySourceSnapshot(sourcePath: string): ReliabilitySourceSnapshot | undefined {
  const path = resolve(sourcePath);
  const beforePath = lstatRegular(path);
  if (!beforePath) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size > MAX_SOURCE_BYTES) {
      throw new ReliabilitySourceFenceError("unsafe_source", "Reliability v1 source is unsafe or exceeds the migration size limit.");
    }
    const bytes = readBounded(fd);
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) {
      throw new ReliabilitySourceFenceError("source_changed", "Reliability v1 source changed while it was read; retry migration.");
    }
    return {
      path,
      bytes,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
  } catch (error) {
    if (error instanceof ReliabilitySourceFenceError) throw error;
    throw new ReliabilitySourceFenceError("unsafe_source", "Reliability v1 source is unsafe or could not be read.");
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve read outcome */ }
    }
  }
}

export function reliabilitySourceSnapshotStillCurrent(snapshot: ReliabilitySourceSnapshot): boolean {
  const current = readReliabilitySourceSnapshot(snapshot.path);
  return !!current && current.dev === snapshot.dev && current.ino === snapshot.ino
    && current.size === snapshot.size && current.mtimeMs === snapshot.mtimeMs && current.ctimeMs === snapshot.ctimeMs
    && current.bytes.equals(snapshot.bytes);
}

export function reliabilitySourceStillAbsent(sourcePath: string): boolean {
  return lstatRegular(resolve(sourcePath)) === undefined;
}

function createOwner(sourcePath: string): ReliabilitySourceFenceOwner {
  const path = reliabilitySourceFencePath(sourcePath);
  fs.mkdirSync(dirname(path), { recursive: true });
  let fd: number | undefined;
  let owner: ReliabilitySourceFenceOwner | undefined;
  try {
    fd = fs.openSync(path, "wx", 0o600);
    const stats = fs.fstatSync(fd);
    const ownerToken = randomUUID();
    owner = { path, ownerToken, dev: stats.dev, ino: stats.ino };
    fs.writeFileSync(fd, JSON.stringify({ ownerToken, pid: process.pid, createdAt: Date.now() }), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDirectory(path);
    return owner;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve lock creation outcome */ }
    }
    if (owner) {
      try {
        const current = fs.lstatSync(owner.path);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(owner.path);
      } catch { /* leave any foreign or uninspectable lock untouched */ }
    }
    if (errorCode(error) === "EEXIST") throw new ReliabilitySourceFenceError("contended", "Reliability v1 source is locked for migration; retry after it completes.");
    throw new ReliabilitySourceFenceError("lock_create_failed", "Could not create the reliability source lock; no migration was performed.");
  }
}

function ownsLock(owner: ReliabilitySourceFenceOwner): boolean {
  let fd: number | undefined;
  try {
    const before = lstatRegular(owner.path);
    if (!before || before.dev !== owner.dev || before.ino !== owner.ino) return false;
    fd = fs.openSync(owner.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== owner.dev || opened.ino !== owner.ino || opened.size > 4096) return false;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= 4096) {
      const chunk = Buffer.allocUnsafe(4097 - total);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total > 4096) return false;
    const value = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().join(",") === "createdAt,ownerToken,pid"
      && record.ownerToken === owner.ownerToken && OWNER_ID.test(owner.ownerToken)
      && typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
      && typeof record.createdAt === "number" && Number.isSafeInteger(record.createdAt)
      && record.createdAt >= 0 && record.createdAt <= 8.64e15;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ownership check is read-only */ }
    }
  }
}

function lstatRegular(path: string): fs.Stats | undefined {
  try {
    const stats = fs.lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ReliabilitySourceFenceError("unsafe_source", "Reliability source and lock files must be regular files.");
    }
    return stats;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof ReliabilitySourceFenceError) throw error;
    throw new ReliabilitySourceFenceError("unsafe_source", "Reliability source or lock file could not be inspected.");
  }
}

function readBounded(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_SOURCE_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SOURCE_BYTES + 1 - total));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > MAX_SOURCE_BYTES) throw new ReliabilitySourceFenceError("unsafe_source", "Reliability v1 source exceeds the migration size limit.");
  return Buffer.concat(chunks, total);
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirname(path), constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
