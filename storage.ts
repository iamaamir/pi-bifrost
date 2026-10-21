import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export function resolveStoragePath(
  cwd: string,
  configuredPath: string | undefined,
  defaultRelativePath: string,
): string {
  if (configuredPath) {
    if (isAbsolute(configuredPath)) return configuredPath;
    if (configuredPath.startsWith("~")) {
      return (process.env.HOME ?? "/tmp") + configuredPath.slice(1);
    }
    return join(cwd, configuredPath);
  }
  return join(cwd, defaultRelativePath);
}

export function readTextFile(path: string): string | undefined {
  if (!fs.existsSync(path)) return undefined;
  return fs.readFileSync(path, "utf-8");
}

export interface AtomicWriteOperations {
  lstatSync: typeof fs.lstatSync;
  mkdirSync: typeof fs.mkdirSync;
  openSync: typeof fs.openSync;
  fchmodSync: typeof fs.fchmodSync;
  writeFileSync: typeof fs.writeFileSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
}

const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  "EBADF",
  "EISDIR",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return String(error.code);
}

function reportDirectorySyncFailure(error: unknown): void {
  const code = errorCode(error);
  if (DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code ?? "")) return;
  if (process.platform === "win32" && code === "EPERM") return;
  process.emitWarning(
    "Bifrost: atomic state was replaced, but its directory could not be synced",
    { code: "BIFROST_STORAGE_DIRSYNC" },
  );
}

function reportTempCleanupFailure(): void {
  process.emitWarning(
    "Bifrost: failed to remove an incomplete managed-state temp file",
    { code: "BIFROST_STORAGE_CLEANUP" },
  );
}

function syncDirectory(dir: string, operations: AtomicWriteOperations): void {
  let fd: number | undefined;
  try {
    fd = operations.openSync(dir, constants.O_RDONLY);
    operations.fsyncSync(fd);
  } catch (error) {
    reportDirectorySyncFailure(error);
  } finally {
    if (fd !== undefined) {
      try {
        operations.closeSync(fd);
      } catch (error) {
        reportDirectorySyncFailure(error);
      }
    }
  }
}

function atomicWriteTextFile(path: string, text: string, operations: AtomicWriteOperations): void {
  const dir = dirname(path);
  operations.mkdirSync(dir, { recursive: true });

  let mode = 0o600;
  try {
    const target = operations.lstatSync(path);
    if (target.isSymbolicLink()) throw new Error(`Refusing to replace symlink managed file: ${path}`);
    if (!target.isFile()) throw new Error(`Managed file target is not a regular file: ${path}`);
    mode = target.mode & 0o777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let ownsTemp = false;
  let replaced = false;
  try {
    fd = operations.openSync(tempPath, "wx", mode);
    ownsTemp = true;
    operations.fchmodSync(fd, mode);
    operations.writeFileSync(fd, text, "utf-8");
    operations.fsyncSync(fd);
    operations.closeSync(fd);
    fd = undefined;
    operations.renameSync(tempPath, path);
    replaced = true;
  } finally {
    if (fd !== undefined) {
      try {
        operations.closeSync(fd);
      } catch {
        // Preserve the write error; the owned temporary is removed below.
      }
    }
    if (!replaced && ownsTemp) {
      try {
        operations.unlinkSync(tempPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") reportTempCleanupFailure();
      }
    }
  }

  syncDirectory(dir, operations);
}

/**
 * Explicit filesystem seam for deterministic atomic-write failure tests.
 * This is internal support, not a stable storage API.
 */
export function writeTextFileWithOperations(
  path: string,
  text: string,
  overrides: Partial<AtomicWriteOperations>,
): void {
  atomicWriteTextFile(path, text, { ...fs, ...overrides });
}

export function writeTextFile(path: string, text: string): void {
  atomicWriteTextFile(path, text, fs);
}

export function readJsonFile<T>(path: string): T | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  // Compact JSON: these are machine-written state files (reliability,
  // runtime state). Indentation doubled their size and stringify time.
  writeTextFile(path, JSON.stringify(value) + "\n");
}
