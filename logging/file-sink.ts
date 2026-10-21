// ── Asynchronous file sink ────────────────────────────────────────
// One sink instance owns one physical file. Writes are serialized so rotation
// and append never overlap. A batch is retried at most once; repeated failure
// is reported to the logger, which degrades instead of retrying forever.

import { constants } from "node:fs";
import { appendFile, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import type { LogDestination, LogEntry, LogSink } from "./types.ts";

interface WritableFileHandle {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
  stat(): Promise<{ size: number }>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

export interface FileSinkOptions {
  readonly maxFileSizeBytes: number;
  readonly rotatedFiles: number;
  readonly onFailure?: (error: unknown) => void;
  /** Test seam for controlled short writes and failures. */
  readonly openFile?: (path: string, flags: number, mode: number) => Promise<WritableFileHandle>;
}

/**
 * A failure after at least one byte was written must not be retried as if the
 * whole batch were still pending; replaying it would duplicate the prefix.
 */
class UncertainWriteError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super(original instanceof Error ? original.message : "log write failed after partial progress", { cause: original });
    this.name = "UncertainWriteError";
    this.original = original;
  }
}

function unwrapWriteError(error: unknown): unknown {
  return error instanceof UncertainWriteError ? error.original : error;
}

async function writeComplete(handle: WritableFileHandle, payload: string): Promise<void> {
  const buffer = Buffer.from(payload, "utf8");
  let written = 0;
  while (written < buffer.length) {
    const remaining = buffer.length - written;
    let result: { bytesWritten: number; buffer: Buffer };
    try {
      result = await handle.write(buffer, written, remaining, null);
    } catch (error) {
      throw written > 0 ? new UncertainWriteError(error) : error;
    }
    if (!Number.isSafeInteger(result.bytesWritten)
      || result.bytesWritten <= 0
      || result.bytesWritten > remaining) {
      const error = new Error("file write did not persist a valid number of bytes");
      throw written > 0 ? new UncertainWriteError(error) : error;
    }
    written += result.bytesWritten;
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export class AsyncFileSink implements LogSink {
  private chain: Promise<void> = Promise.resolve();
  private directoryReady = false;
  private closed = false;
  private readonly destination: LogDestination;
  private readonly options: FileSinkOptions;
  private readonly openFile: (path: string, flags: number, mode: number) => Promise<WritableFileHandle>;
  /** Pre-append size to restore after an incomplete write, if cleanup failed. */
  private repairTo: number | null = null;

  constructor(destination: LogDestination, options: FileSinkOptions) {
    this.destination = destination;
    this.options = options;
    this.openFile = options.openFile ?? ((path, flags, mode) => open(path, flags, mode));
  }

  write(batch: readonly LogEntry[]): Promise<void> {
    if (this.closed || batch.length === 0) return Promise.resolve();
    const payload = batch.map((entry) => entry.line).join("");
    const task = this.chain.then(() => this.writeWithRetry(payload));
    // Keep the chain alive after a failure so later batches still run.
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  flush(): Promise<void> {
    return this.chain;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.chain;
  }

  private async writeWithRetry(payload: string): Promise<void> {
    try {
      await this.writeOnce(payload);
    } catch (firstFailure) {
      const firstError = unwrapWriteError(firstFailure);
      // Retry only a missing directory/file race with no bytes written.
      // Replaying after partial progress (ENOSPC, EIO, or a missing path after
      // a short write) could duplicate lines, so fail the batch instead.
      if (firstFailure instanceof UncertainWriteError || !isMissingPath(firstError)) {
        this.options.onFailure?.(firstError);
        throw firstError;
      }
      this.directoryReady = false;
      try {
        await this.writeOnce(payload);
      } catch (retryFailure) {
        const secondError = unwrapWriteError(retryFailure);
        this.options.onFailure?.(secondError);
        throw secondError;
      }
    }
  }

  private async writeOnce(payload: string): Promise<void> {
    if (!this.directoryReady) {
      await mkdir(dirname(this.destination.path), { recursive: true, mode: 0o700 });
      this.directoryReady = true;
    }
    await this.assertInsideRoot();
    await this.rotateIfNeeded();
    await this.append(payload);
  }

  /**
   * Lexical destination checks cannot see a pre-existing symlink inside the
   * logging root. Resolve the parent directory before every scoped append so a
   * link cannot redirect session logs outside the configured root. Explicit
   * shared paths keep their legacy behavior.
   */
  private async assertInsideRoot(): Promise<void> {
    const root = this.destination.root;
    if (!root) return;
    const [realRoot, realParent] = await Promise.all([
      realpath(root),
      realpath(dirname(this.destination.path)),
    ]);
    if (!isInside(realRoot, realParent)) {
      throw new Error("session log path escapes the configured logging root");
    }
  }

  /**
   * Restore the file to its pre-failure size before appending again. Immediate
   * cleanup is attempted after a partial write; this deferred path covers the
   * case where the disk is still failing at that moment.
   */
  private async prepareAppend(handle: WritableFileHandle): Promise<number> {
    const current = (await handle.stat()).size;
    const target = this.repairTo;
    if (target === null) return current;
    if (current < target) {
      // The file was replaced or externally truncated, so the incomplete
      // prefix is already gone. Truncating to the old size would extend it.
      this.repairTo = null;
      return current;
    }
    await handle.truncate(target);
    this.repairTo = null;
    return target;
  }

  private async append(payload: string): Promise<void> {
    if (!this.destination.root) {
      // Explicit shared path: preserve historical append semantics.
      await appendFile(this.destination.path, payload, { encoding: "utf-8", flag: "a", mode: 0o600 });
      return;
    }
    // O_NOFOLLOW prevents a pre-existing run-file symlink from being followed.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW;
    const handle = await this.openFile(this.destination.path, flags, 0o600);
    let primaryFailure: unknown;
    let complete = false;
    let startSize: number | undefined;
    try {
      startSize = await this.prepareAppend(handle);
      try {
        await writeComplete(handle, payload);
        complete = true;
      } catch (error) {
        primaryFailure = error;
        if (error instanceof UncertainWriteError) {
          try {
            // Remove the incomplete JSONL prefix before any later append.
            await handle.truncate(startSize);
          } catch {
            // Keep the pre-write size so the next append can repair it.
            this.repairTo = startSize;
          }
        }
      }
    } catch (error) {
      primaryFailure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      // A close failure after a complete append is not safe to retry.
      if (!primaryFailure && complete) primaryFailure = new UncertainWriteError(error);
      else if (!primaryFailure) primaryFailure = error;
    }
    if (primaryFailure) throw primaryFailure;
  }

  private async rotateIfNeeded(): Promise<void> {
    if (this.options.rotatedFiles <= 0) return;
    let size = 0;
    try {
      size = (await stat(this.destination.path)).size;
    } catch {
      return; // No current file; the append creates it.
    }
    if (size <= this.options.maxFileSizeBytes) return;
    // Rotation is best-effort: a failed rename must not fail the write.
    try {
      await this.rotate();
    } catch {
      // Ignore; the append continues against the current file.
    }
  }

  private async rotate(): Promise<void> {
    const path = this.destination.path;
    const old = `${path}.old`;
    const keep = this.options.rotatedFiles;
    if (keep <= 1) {
      // Windows refuses to replace an existing target, so remove it first.
      await rm(old, { force: true }).catch(() => undefined);
      await rename(path, old);
      return;
    }
    await rm(`${old}.${keep - 1}`, { force: true }).catch(() => undefined);
    for (let index = keep - 2; index >= 1; index -= 1) {
      await rename(`${old}.${index}`, `${old}.${index + 1}`).catch(() => undefined);
    }
    await rename(old, `${old}.1`).catch(() => undefined);
    await rm(old, { force: true }).catch(() => undefined);
    await rename(path, old);
  }
}
