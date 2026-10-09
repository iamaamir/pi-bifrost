import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Narrow journaled commit for one config file and its generated-membership sidecar.
 * Locks coordinate Bifrost writers only; external editors are not atomically CAS-protected.
 * A killed writer leaves locks behind: an operator must verify it has exited,
 * inspect and remove its exact stale lock files, then call recovery. UUID-only
 * locks cannot be safely reclaimed automatically.
 */

export interface ReconciliationStoreOperations {
  realpathSync(path: string): string;
  lstatSync(path: string): fs.Stats;
  fstatSync(fd: number): fs.Stats;
  openSync(path: string, flags: string | number, mode?: number): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  writeFileSync(fd: number, data: string | Uint8Array): void;
  fchmodSync(fd: number, mode: number): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  randomUUID(): string;
}

export interface ReconciliationStorePaths {
  readonly configPath: string;
  readonly ownershipPath: string;
  readonly journalPath: string;
}

export interface ApplyReconciliationTransactionInput extends ReconciliationStorePaths {
  readonly expectedConfigDigest: string | null;
  readonly expectedOwnershipDigest: string | null;
  readonly nextConfigBytes: Uint8Array;
  readonly nextOwnershipBytes: Uint8Array;
}

export type RecoveryResult =
  | { readonly status: "nothing_to_recover" }
  | { readonly status: "aborted"; readonly transactionId: string }
  | { readonly status: "completed"; readonly transactionId: string }
  | { readonly status: "conflict"; readonly transactionId?: string };

export interface ApplyResult {
  readonly status: "committed";
  readonly transactionId: string;
  readonly configBackupPath?: string;
  readonly ownershipBackupPath?: string;
}

type FileIdentity = { readonly dev: number; readonly ino: number };
type JournalTarget = {
  readonly path: string;
  readonly oldDigest: string | null;
  readonly nextDigest: string;
  readonly stageName: string;
  readonly stageIdentity?: FileIdentity;
  readonly backupName?: string;
  readonly backupDigest?: string;
  readonly backupIdentity?: FileIdentity;
  readonly mode: number;
};
type JournalRecord = {
  readonly version: 1;
  readonly transactionId: string;
  readonly phase: "preparing" | "ready" | "config_installed" | "ownership_installed" | "committed";
  readonly config: JournalTarget;
  readonly ownership: JournalTarget;
};
type NormalizedPaths = {
  readonly configPath: string;
  readonly ownershipPath: string;
  readonly journalPath: string;
  readonly lockPaths: readonly string[];
};
type FileSnapshot = { readonly bytes: Buffer; readonly digest: string; readonly mode: number; readonly identity: FileIdentity };

const DEFAULT_OPERATIONS: ReconciliationStoreOperations = {
  realpathSync: fs.realpathSync,
  lstatSync: fs.lstatSync,
  fstatSync: fs.fstatSync,
  openSync: fs.openSync,
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  writeFileSync: fs.writeFileSync,
  fchmodSync: fs.fchmodSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  randomUUID,
};

const DIRSYNC_UNSUPPORTED = new Set(["EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TRANSACTION_ID = /^[a-f0-9-]{36}$/u;
const MAX_CONFIG_BYTES = 10_000_000;
const MAX_OWNERSHIP_BYTES = 5_000_000;
const MAX_JOURNAL_BYTES = 1_000_000;
const MAX_LOCK_BYTES = 256;
const MAX_RECORDS = 1_000;

export class ReconciliationStoreError extends Error {
  readonly code: "invalid_input" | "conflict" | "locked" | "io_failure";

  constructor(code: "invalid_input" | "conflict" | "locked" | "io_failure") {
    super(`Reconciliation store ${code.replaceAll("_", " ")}.`);
    this.name = "ReconciliationStoreError";
    this.code = code;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function identity(stats: fs.Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function canonicalPath(path: string, operations: ReconciliationStoreOperations): string {
  if (typeof path !== "string" || path.length === 0 || !fsPathAbsolute(path)) throw new ReconciliationStoreError("invalid_input");
  const absolute = resolve(path);
  const parent = dirname(absolute);
  let realParent: string;
  try {
    realParent = operations.realpathSync(parent);
  } catch {
    throw new ReconciliationStoreError("invalid_input");
  }
  const fileName = basename(absolute);
  if (!fileName || fileName === "." || fileName === "..") throw new ReconciliationStoreError("invalid_input");
  return join(realParent, fileName);
}

function fsPathAbsolute(path: string): boolean {
  return isAbsolute(path);
}

function normalizePaths(paths: ReconciliationStorePaths, operations: ReconciliationStoreOperations): NormalizedPaths {
  const configPath = canonicalPath(paths.configPath, operations);
  const ownershipPath = canonicalPath(paths.ownershipPath, operations);
  const journalPath = canonicalPath(paths.journalPath, operations);
  const lockPaths = [configPath, ownershipPath, journalPath].map((path) => `${path}.bifrost-reconcile.lock`).sort();
  const all = [configPath, ownershipPath, journalPath, ...lockPaths];
  if (new Set(all).size !== all.length) throw new ReconciliationStoreError("invalid_input");
  const identities = new Map<string, FileIdentity>();
  for (const path of [configPath, ownershipPath, journalPath, ...lockPaths]) {
    try {
      const stats = operations.lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new ReconciliationStoreError("invalid_input");
      const id = identity(stats);
      const prior = identities.get(`${id.dev}:${id.ino}`);
      if (prior) throw new ReconciliationStoreError("invalid_input");
      identities.set(`${id.dev}:${id.ino}`, id);
    } catch (error) {
      if (error instanceof ReconciliationStoreError) throw error;
      if (errorCode(error) !== "ENOENT") throw new ReconciliationStoreError("invalid_input");
    }
  }
  return { configPath, ownershipPath, journalPath, lockPaths };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function assertPlainJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReconciliationStoreError("invalid_input");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new ReconciliationStoreError("invalid_input");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ReconciliationStoreError("invalid_input");
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, "models")) {
    const models = object.models;
    if (!isPlainRecord(models) || Object.keys(models).length > 100) throw new ReconciliationStoreError("invalid_input");
    for (const [tier, pool] of Object.entries(models)) {
      if (!validText(tier, 128)) throw new ReconciliationStoreError("invalid_input");
      const values = typeof pool === "string" ? [pool] : pool;
      if (!Array.isArray(values) || values.length > 5_000
        || values.some((entry) => !validText(entry, 512))
        || new Set(values).size !== values.length) throw new ReconciliationStoreError("invalid_input");
    }
  }
  return object;
}

function assertOwnershipPayload(bytes: Uint8Array): void {
  const value = assertPlainJsonObject(bytes);
  if (!hasExactKeys(value, ["version", "sources"]) || value.version !== 1
    || !isPlainRecord(value.sources) || Object.keys(value.sources).length > MAX_RECORDS) {
    throw new ReconciliationStoreError("invalid_input");
  }
  let membershipCount = 0;
  const generatedClaims = new Set<string>();
  for (const [sourceId, source] of Object.entries(value.sources)) {
    if (!validText(sourceId, 256)) throw new ReconciliationStoreError("invalid_input");
    if (!isPlainRecord(source) || !isPlainRecord(source.generated) || !isPlainRecord(source.tombstones)) {
      throw new ReconciliationStoreError("invalid_input");
    }
    if (!hasExactKeys(source, ["generated", "tombstones"])) throw new ReconciliationStoreError("invalid_input");
    for (const membershipMap of [source.generated, source.tombstones]) {
      if (Object.keys(membershipMap).length > 100) throw new ReconciliationStoreError("invalid_input");
      for (const [tier, memberships] of Object.entries(membershipMap)) {
        if (!validText(tier, 128) || !Array.isArray(memberships) || memberships.length > 5_000
          || memberships.some((key) => !validModelKey(key))
          || new Set(memberships).size !== memberships.length) {
          throw new ReconciliationStoreError("invalid_input");
        }
        membershipCount += memberships.length;
        if (membershipCount > MAX_RECORDS * 100) throw new ReconciliationStoreError("invalid_input");
      }
    }
    for (const [tier, rawMemberships] of Object.entries(source.generated as Record<string, unknown>)) {
      if (!Array.isArray(rawMemberships)) throw new ReconciliationStoreError("invalid_input");
      const memberships = rawMemberships;
      for (const modelKey of memberships) {
        const claim = `${tier}\u0000${modelKey}`;
        if (generatedClaims.has(claim)) throw new ReconciliationStoreError("invalid_input");
        generatedClaims.add(claim);
      }
    }
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validModelKey(value: unknown): value is string {
  if (!validText(value, 512) || /\s/u.test(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1 && !value.slice(0, separator).includes("/");
}

function checkPayloadBounds(configBytes: Uint8Array, ownershipBytes: Uint8Array): void {
  if (configBytes.byteLength > MAX_CONFIG_BYTES || ownershipBytes.byteLength > MAX_OWNERSHIP_BYTES) {
    throw new ReconciliationStoreError("invalid_input");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readLimit(path: string): number {
  if (path.endsWith(".bifrost-reconcile.lock")) return MAX_LOCK_BYTES;
  if (path.endsWith(".journal") || path.includes(".journal-tmp")) return MAX_JOURNAL_BYTES;
  if (path.includes(".ownership." ) || path.endsWith("ownership.json")) return MAX_OWNERSHIP_BYTES;
  return MAX_CONFIG_BYTES;
}

function readDescriptor(fd: number, maximum: number, operations: ReconciliationStoreOperations): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1));
  while (total <= maximum) {
    const length = Math.min(chunk.byteLength, maximum + 1 - total);
    const count = operations.readSync(fd, chunk, 0, length, total);
    if (count === 0) break;
    total += count;
    if (total > maximum) throw new ReconciliationStoreError("invalid_input");
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function readSnapshot(path: string, operations: ReconciliationStoreOperations): FileSnapshot | undefined {
  let before: fs.Stats;
  try {
    before = operations.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new ReconciliationStoreError("io_failure");
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new ReconciliationStoreError("invalid_input");
  const limit = readLimit(path);
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) {
    throw new ReconciliationStoreError("invalid_input");
  }
  let fd: number | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = operations.openSync(path, constants.O_RDONLY | noFollow);
    const opened = operations.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))
      || opened.size !== before.size || opened.size > limit) throw new ReconciliationStoreError("conflict");
    const bytes = readDescriptor(fd, limit, operations);
    const afterFd = operations.fstatSync(fd);
    const after = operations.lstatSync(path);
    if (!sameIdentity(identity(before), identity(after)) || !sameIdentity(identity(opened), identity(afterFd))
      || bytes.byteLength !== opened.size || afterFd.size !== opened.size) throw new ReconciliationStoreError("conflict");
    return { bytes, digest: digest(bytes), mode: before.mode & 0o777, identity: identity(before) };
  } catch (error) {
    if (error instanceof ReconciliationStoreError) throw error;
    throw new ReconciliationStoreError("io_failure");
  } finally {
    if (fd !== undefined) {
      try { operations.closeSync(fd); } catch { /* read result or original error takes precedence */ }
    }
  }
}

function verifyExpected(actual: FileSnapshot | undefined, expected: string | null): void {
  if (expected !== null && !SHA256.test(expected)) throw new ReconciliationStoreError("invalid_input");
  if ((actual?.digest ?? null) !== expected) throw new ReconciliationStoreError("conflict");
}

function writeExclusive(
  path: string,
  bytes: Uint8Array,
  mode: number,
  operations: ReconciliationStoreOperations,
): FileIdentity {
  let fd: number | undefined;
  let ownIdentity: FileIdentity | undefined;
  try {
    fd = operations.openSync(path, "wx", mode);
    ownIdentity = identity(operations.fstatSync(fd));
    operations.fchmodSync(fd, mode);
    operations.writeFileSync(fd, bytes);
    operations.fsyncSync(fd);
    operations.closeSync(fd);
    fd = undefined;
    const current = readSnapshot(path, operations);
    if (!current || !sameIdentity(current.identity, ownIdentity) || current.digest !== digest(bytes)) {
      throw new ReconciliationStoreError("conflict");
    }
    return ownIdentity;
  } catch (error) {
    if (fd !== undefined) {
      try { operations.closeSync(fd); } catch { /* preserve first error */ }
    }
    if (ownIdentity) safeUnlinkOwned(path, ownIdentity, operations);
    if (error instanceof ReconciliationStoreError) throw error;
    throw new ReconciliationStoreError("io_failure");
  }
}

function safeUnlinkOwned(path: string, expected: FileIdentity, operations: ReconciliationStoreOperations): boolean {
  try {
    const current = operations.lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(identity(current), expected)) return false;
    operations.unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    process.emitWarning("Bifrost: reconciliation could not clean an owned temporary file", { code: "BIFROST_RECONCILE_CLEANUP" });
    return false;
  }
}

function syncDirectory(path: string, operations: ReconciliationStoreOperations, postCommit: boolean): void {
  let fd: number | undefined;
  try {
    fd = operations.openSync(dirname(path), constants.O_RDONLY);
    operations.fsyncSync(fd);
  } catch (error) {
    const code = errorCode(error);
    if (DIRSYNC_UNSUPPORTED.has(code ?? "") || process.platform === "win32" && code === "EPERM") return;
    if (postCommit) {
      process.emitWarning("Bifrost: reconciliation rename completed but directory sync failed", { code: "BIFROST_RECONCILE_DIRSYNC" });
      return;
    }
    throw new ReconciliationStoreError("io_failure");
  } finally {
    if (fd !== undefined) {
      try { operations.closeSync(fd); } catch {
        if (postCommit) process.emitWarning("Bifrost: reconciliation directory handle did not close cleanly", { code: "BIFROST_RECONCILE_DIRSYNC" });
      }
    }
  }
}

type HeldLock = { readonly path: string; readonly fd: number; readonly identity: FileIdentity; readonly owner: string };

function assertHeldLocks(held: readonly HeldLock[], operations: ReconciliationStoreOperations): void {
  try {
    for (const lock of held) {
      const fdStats = operations.fstatSync(lock.fd);
      const snapshot = readSnapshot(lock.path, operations);
      if (!fdStats.isFile() || !sameIdentity(identity(fdStats), lock.identity)
        || !snapshot || !sameIdentity(snapshot.identity, lock.identity)
        || snapshot.bytes.toString("utf8") !== lock.owner) {
        throw new ReconciliationStoreError("conflict");
      }
    }
  } catch (error) {
    if (error instanceof ReconciliationStoreError) throw error;
    throw new ReconciliationStoreError("conflict");
  }
}

function acquireLocks(paths: NormalizedPaths, operations: ReconciliationStoreOperations): HeldLock[] {
  const held: HeldLock[] = [];
  try {
    for (const path of paths.lockPaths) {
      const owner = operations.randomUUID();
      const fd = operations.openSync(path, "wx", 0o600);
      let id: FileIdentity | undefined;
      try {
        id = identity(operations.fstatSync(fd));
        operations.fchmodSync(fd, 0o600);
        operations.writeFileSync(fd, owner);
        operations.fsyncSync(fd);
        const lockSnapshot = readSnapshot(path, operations);
        if (!lockSnapshot || lockSnapshot.bytes.toString("utf8") !== owner || !sameIdentity(lockSnapshot.identity, id)) {
          throw new ReconciliationStoreError("locked");
        }
        held.push({ path, fd, identity: id, owner });
      } catch (error) {
        try { operations.closeSync(fd); } catch { /* preserve first error */ }
        if (id) safeUnlinkOwned(path, id, operations);
        throw error;
      }
    }
    return held;
  } catch (error) {
    releaseLocks(held, operations);
    if (error instanceof ReconciliationStoreError) throw error;
    if (errorCode(error) === "EEXIST") throw new ReconciliationStoreError("locked");
    throw new ReconciliationStoreError("io_failure");
  }
}

function releaseLocks(held: readonly HeldLock[], operations: ReconciliationStoreOperations): void {
  for (const lock of [...held].reverse()) {
    try { operations.closeSync(lock.fd); } catch { /* lock file remains if ownership cannot be verified */ }
    try {
      const stats = operations.lstatSync(lock.path);
      if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(identity(stats), lock.identity)) continue;
      const snapshot = readSnapshot(lock.path, operations);
      if (snapshot?.bytes.toString("utf8") === lock.owner && sameIdentity(snapshot.identity, lock.identity)) {
        operations.unlinkSync(lock.path);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") process.emitWarning("Bifrost: reconciliation lock cleanup failed", { code: "BIFROST_RECONCILE_LOCK" });
    }
  }
}

function sameNullableDigest(path: string, expected: string | null, operations: ReconciliationStoreOperations): boolean {
  return (readSnapshot(path, operations)?.digest ?? null) === expected;
}

function initialRecord(
  transactionId: string,
  paths: NormalizedPaths,
  config: FileSnapshot | undefined,
  ownership: FileSnapshot | undefined,
  nextConfig: Uint8Array,
  nextOwnership: Uint8Array,
): JournalRecord {
  const configBase = basename(paths.configPath);
  const ownerBase = basename(paths.ownershipPath);
  return {
    version: 1,
    transactionId,
    phase: "preparing",
    config: {
      path: paths.configPath,
      oldDigest: config?.digest ?? null,
      nextDigest: digest(nextConfig),
      stageName: `.${configBase}.${transactionId}.config.stage`,
      ...(config ? { backupName: `.${configBase}.${transactionId}.config.backup`, backupDigest: config.digest } : {}),
      mode: config?.mode ?? 0o600,
    },
    ownership: {
      path: paths.ownershipPath,
      oldDigest: ownership?.digest ?? null,
      nextDigest: digest(nextOwnership),
      stageName: `.${ownerBase}.${transactionId}.ownership.stage`,
      ...(ownership ? { backupName: `.${ownerBase}.${transactionId}.ownership.backup`, backupDigest: ownership.digest } : {}),
      mode: ownership?.mode ?? 0o600,
    },
  };
}

function updateTarget(record: JournalTarget, update: Partial<JournalTarget>): JournalTarget {
  return { ...record, ...update };
}

function writeInitialJournal(path: string, record: JournalRecord, held: readonly HeldLock[], operations: ReconciliationStoreOperations): FileIdentity {
  const bytes = Buffer.from(JSON.stringify(record));
  let fd: number | undefined;
  let id: FileIdentity | undefined;
  try {
    assertHeldLocks(held, operations);
    fd = operations.openSync(path, "wx", 0o600);
    id = identity(operations.fstatSync(fd));
    operations.fchmodSync(fd, 0o600);
    operations.writeFileSync(fd, bytes);
    operations.fsyncSync(fd);
    operations.closeSync(fd);
    fd = undefined;
    syncDirectory(path, operations, false);
    return id;
  } catch (error) {
    if (fd !== undefined) {
      try { operations.closeSync(fd); } catch { /* preserve first error */ }
    }
    if (id) safeUnlinkOwned(path, id, operations);
    if (error instanceof ReconciliationStoreError) throw error;
    if (errorCode(error) === "EEXIST") throw new ReconciliationStoreError("conflict");
    throw new ReconciliationStoreError("io_failure");
  }
}

function writeJournal(
  path: string,
  record: JournalRecord,
  currentIdentity: FileIdentity,
  held: readonly HeldLock[],
  operations: ReconciliationStoreOperations,
): FileIdentity {
  const current = readSnapshot(path, operations);
  if (!current || !sameIdentity(current.identity, currentIdentity)) throw new ReconciliationStoreError("conflict");
  const tempPath = join(dirname(path), `.${basename(path)}.${record.transactionId}.${operations.randomUUID()}.journal-tmp`);
  const bytes = Buffer.from(JSON.stringify(record));
  const tempIdentity = writeExclusive(tempPath, bytes, 0o600, operations);
  try {
    const recheck = readSnapshot(path, operations);
    if (!recheck || !sameIdentity(recheck.identity, currentIdentity) || recheck.digest !== current.digest) {
      safeUnlinkOwned(tempPath, tempIdentity, operations);
      throw new ReconciliationStoreError("conflict");
    }
    assertHeldLocks(held, operations);
    operations.renameSync(tempPath, path);
    syncDirectory(path, operations, false);
    return identity(operations.lstatSync(path));
  } catch (error) {
    safeUnlinkOwned(tempPath, tempIdentity, operations);
    if (error instanceof ReconciliationStoreError) throw error;
    throw new ReconciliationStoreError("io_failure");
  }
}

function readJournal(path: string, operations: ReconciliationStoreOperations): { record: JournalRecord; identity: FileIdentity; digest: string } | undefined {
  const snapshot = readSnapshot(path, operations);
  if (!snapshot) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes));
  } catch {
    throw new ReconciliationStoreError("conflict");
  }
  if (!validateJournalRecord(record)) throw new ReconciliationStoreError("conflict");
  return { record, identity: snapshot.identity, digest: snapshot.digest };
}

function validateJournalRecord(value: unknown): value is JournalRecord {
  if (!isPlainRecord(value) || value.version !== 1 || typeof value.transactionId !== "string"
    || !SAFE_TRANSACTION_ID.test(value.transactionId)
    || !hasExactKeys(value, ["version", "transactionId", "phase", "config", "ownership"])
    || !["preparing", "ready", "config_installed", "ownership_installed", "committed"].includes(String(value.phase))) return false;
  if (!validateJournalTarget(value.config, value.transactionId, "config")
    || !validateJournalTarget(value.ownership, value.transactionId, "ownership")) return false;
  if (value.phase !== "preparing") {
    for (const target of [value.config, value.ownership]) {
      if (!target.stageIdentity || target.oldDigest !== null && !target.backupIdentity) return false;
    }
  }
  return true;
}

function validateJournalTarget(value: unknown, transactionId: string, role: "config" | "ownership"): value is JournalTarget {
  if (!isPlainRecord(value) || typeof value.path !== "string" || !fsPathAbsolute(value.path)
    || !(value.oldDigest === null || typeof value.oldDigest === "string" && SHA256.test(value.oldDigest))
    || typeof value.nextDigest !== "string" || !SHA256.test(value.nextDigest)
    || typeof value.stageName !== "string" || typeof value.mode !== "number"
    || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) return false;
  const allowed = ["path", "oldDigest", "nextDigest", "stageName", "stageIdentity", "backupName", "backupDigest", "backupIdentity", "mode"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  const expectedStage = `.${basename(value.path)}.${transactionId}.${role}.stage`;
  const expectedBackup = `.${basename(value.path)}.${transactionId}.${role}.backup`;
  if (value.stageName !== expectedStage) return false;
  if (value.oldDigest === null) {
    if (value.backupName !== undefined || value.backupDigest !== undefined || value.backupIdentity !== undefined) return false;
  } else if (value.backupName !== expectedBackup || value.backupDigest !== value.oldDigest
    || value.backupIdentity !== undefined && !validIdentity(value.backupIdentity)) return false;
  if (value.stageIdentity !== undefined && !validIdentity(value.stageIdentity)) return false;
  return true;
}

function validIdentity(value: unknown): value is FileIdentity {
  return isPlainRecord(value) && hasExactKeys(value, ["dev", "ino"])
    && typeof value.dev === "number" && Number.isSafeInteger(value.dev)
    && typeof value.ino === "number" && Number.isSafeInteger(value.ino);
}

function verifyNewPayloads(configBytes: Buffer, ownershipBytes: Buffer): void {
  assertPlainJsonObject(configBytes);
  assertOwnershipPayload(ownershipBytes);
}

function targetStagePath(target: JournalTarget): string {
  return join(dirname(target.path), target.stageName);
}

function targetBackupPath(target: JournalTarget): string | undefined {
  return target.backupName ? join(dirname(target.path), target.backupName) : undefined;
}

function fileMatches(
  path: string,
  expectedIdentity: FileIdentity | undefined,
  expectedDigest: string | null,
  operations: ReconciliationStoreOperations,
): boolean {
  if (!expectedIdentity) return true;
  const snapshot = readSnapshot(path, operations);
  return snapshot !== undefined && sameIdentity(snapshot.identity, expectedIdentity) && snapshot.digest === expectedDigest;
}

function backupsMatch(record: JournalRecord, operations: ReconciliationStoreOperations): boolean {
  for (const target of [record.config, record.ownership]) {
    if (target.oldDigest === null) continue;
    const path = targetBackupPath(target);
    if (!path || !target.backupIdentity
      || !fileMatches(path, target.backupIdentity, target.backupDigest ?? null, operations)) return false;
  }
  return true;
}

function removeRecordedFile(
  path: string | undefined,
  expectedIdentity: FileIdentity | undefined,
  expectedDigest: string | null,
  operations: ReconciliationStoreOperations,
): boolean {
  if (!path || !expectedIdentity) return true;
  let snapshot: FileSnapshot | undefined;
  try {
    snapshot = readSnapshot(path, operations);
  } catch {
    return false;
  }
  if (!snapshot) return true;
  if (!sameIdentity(snapshot.identity, expectedIdentity) || snapshot.digest !== expectedDigest) return false;
  return safeUnlinkOwned(path, expectedIdentity, operations);
}

function removeJournal(path: string, expectedIdentity: FileIdentity, expectedDigest: string, held: readonly HeldLock[], operations: ReconciliationStoreOperations): boolean {
  try {
    const current = readSnapshot(path, operations);
    if (!current || !sameIdentity(current.identity, expectedIdentity) || current.digest !== expectedDigest) return false;
    assertHeldLocks(held, operations);
    operations.unlinkSync(path);
    syncDirectory(path, operations, true);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    process.emitWarning("Bifrost: reconciliation journal cleanup failed", { code: "BIFROST_RECONCILE_JOURNAL" });
    return false;
  }
}

function ensureJournalBindsPaths(record: JournalRecord, paths: NormalizedPaths, operations: ReconciliationStoreOperations): void {
  const config = canonicalPath(record.config.path, operations);
  const ownership = canonicalPath(record.ownership.path, operations);
  if (config !== paths.configPath || ownership !== paths.ownershipPath) throw new ReconciliationStoreError("conflict");
  const expectedConfigStage = `.${basename(paths.configPath)}.${record.transactionId}.config.stage`;
  const expectedOwnerStage = `.${basename(paths.ownershipPath)}.${record.transactionId}.ownership.stage`;
  if (record.config.stageName !== expectedConfigStage || record.ownership.stageName !== expectedOwnerStage) {
    throw new ReconciliationStoreError("conflict");
  }
}

function cleanupAbortedRecord(
  record: JournalRecord,
  paths: NormalizedPaths,
  journalIdentity: FileIdentity,
  journalDigest: string,
  held: readonly HeldLock[],
  operations: ReconciliationStoreOperations,
): boolean {
  const configStageRemoved = removeRecordedFile(targetStagePath(record.config), record.config.stageIdentity, record.config.nextDigest, operations);
  const ownerStageRemoved = removeRecordedFile(targetStagePath(record.ownership), record.ownership.stageIdentity, record.ownership.nextDigest, operations);
  const configBackupRemoved = removeRecordedFile(targetBackupPath(record.config), record.config.backupIdentity, record.config.backupDigest ?? null, operations);
  const ownerBackupRemoved = removeRecordedFile(targetBackupPath(record.ownership), record.ownership.backupIdentity, record.ownership.backupDigest ?? null, operations);
  if (!configStageRemoved || !ownerStageRemoved || !configBackupRemoved || !ownerBackupRemoved) return false;
  return removeJournal(paths.journalPath, journalIdentity, journalDigest, held, operations);
}

function finalizeCommittedRecord(
  record: JournalRecord,
  paths: NormalizedPaths,
  journalIdentity: FileIdentity,
  journalDigest: string,
  held: readonly HeldLock[],
  operations: ReconciliationStoreOperations,
): boolean {
  if (!backupsMatch(record, operations)) return false;
  const configStageRemoved = removeRecordedFile(targetStagePath(record.config), record.config.stageIdentity, record.config.nextDigest, operations);
  const ownerStageRemoved = removeRecordedFile(targetStagePath(record.ownership), record.ownership.stageIdentity, record.ownership.nextDigest, operations);
  if (!configStageRemoved || !ownerStageRemoved) return false;
  return removeJournal(paths.journalPath, journalIdentity, journalDigest, held, operations);
}

function currentTargetState(record: JournalRecord, operations: ReconciliationStoreOperations): { config: string | null; ownership: string | null } {
  try {
    return {
      config: readSnapshot(record.config.path, operations)?.digest ?? null,
      ownership: readSnapshot(record.ownership.path, operations)?.digest ?? null,
    };
  } catch {
    throw new ReconciliationStoreError("conflict");
  }
}

function validOldTargetPayloads(record: JournalRecord, operations: ReconciliationStoreOperations): boolean {
  try {
    const config = readSnapshot(record.config.path, operations);
    const ownership = readSnapshot(record.ownership.path, operations);
    if (record.config.oldDigest !== null && config?.digest === record.config.oldDigest) assertPlainJsonObject(config.bytes);
    if (record.ownership.oldDigest !== null && ownership?.digest === record.ownership.oldDigest) assertOwnershipPayload(ownership.bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover a pending transaction under its cooperative locks. Unknown bytes are
 * a conflict: recovery never rolls back or overwrites an unrecognized edit.
 * If a prior process died, recovery reports a lock conflict until an operator
 * verifies that process is gone and removes its exact stale lock files.
 */
export function recoverReconciliationTransaction(
  input: ReconciliationStorePaths,
  operations: ReconciliationStoreOperations = DEFAULT_OPERATIONS,
): RecoveryResult {
  const paths = normalizePaths(input, operations);
  const held = acquireLocks(paths, operations);
  try {
    let journal: ReturnType<typeof readJournal>;
    try {
      journal = readJournal(paths.journalPath, operations);
    } catch {
      return Object.freeze({ status: "conflict" });
    }
    if (!journal) {
      assertHeldLocks(held, operations);
      return Object.freeze({ status: "nothing_to_recover" });
    }
    const { record, identity: journalIdentity, digest: journalDigest } = journal;
    try {
      ensureJournalBindsPaths(record, paths, operations);
    } catch {
      return Object.freeze({ status: "conflict", transactionId: record.transactionId });
    }
    if (!validOldTargetPayloads(record, operations)) return Object.freeze({ status: "conflict", transactionId: record.transactionId });

    const state = currentTargetState(record, operations);
    const oldOld = state.config === record.config.oldDigest && state.ownership === record.ownership.oldDigest;
    const newNew = state.config === record.config.nextDigest && state.ownership === record.ownership.nextDigest;
    const newOld = state.config === record.config.nextDigest && state.ownership === record.ownership.oldDigest;

    if (oldOld) {
      if (!cleanupAbortedRecord(record, paths, journalIdentity, journalDigest, held, operations)) {
        return Object.freeze({ status: "conflict", transactionId: record.transactionId });
      }
      assertHeldLocks(held, operations);
      return Object.freeze({ status: "aborted", transactionId: record.transactionId });
    }
    if (newNew) {
      if (!backupsMatch(record, operations)
        || !finalizeCommittedRecord(record, paths, journalIdentity, journalDigest, held, operations)) {
        return Object.freeze({ status: "conflict", transactionId: record.transactionId });
      }
      assertHeldLocks(held, operations);
      return Object.freeze({ status: "completed", transactionId: record.transactionId });
    }
    if (!newOld) return Object.freeze({ status: "conflict", transactionId: record.transactionId });

    const ownerStage = targetStagePath(record.ownership);
    if (!backupsMatch(record, operations) || !record.ownership.stageIdentity
      || !fileMatches(ownerStage, record.ownership.stageIdentity, record.ownership.nextDigest, operations)) {
      return Object.freeze({ status: "conflict", transactionId: record.transactionId });
    }
    const stagedOwner = readSnapshot(ownerStage, operations);
    if (!stagedOwner) return Object.freeze({ status: "conflict", transactionId: record.transactionId });
    try {
      assertOwnershipPayload(stagedOwner.bytes);
      if (!sameNullableDigest(record.config.path, record.config.nextDigest, operations)
        || !sameNullableDigest(record.ownership.path, record.ownership.oldDigest, operations)) {
        return Object.freeze({ status: "conflict", transactionId: record.transactionId });
      }
      assertHeldLocks(held, operations);
      operations.renameSync(ownerStage, record.ownership.path);
      syncDirectory(record.ownership.path, operations, true);
      const afterRename = readSnapshot(record.ownership.path, operations);
      if (!afterRename || afterRename.digest !== record.ownership.nextDigest) {
        return Object.freeze({ status: "conflict", transactionId: record.transactionId });
      }
      const updated = { ...record, phase: "ownership_installed" as const };
      const currentJournal = readJournal(paths.journalPath, operations);
      if (!currentJournal || !sameIdentity(currentJournal.identity, journalIdentity)) {
        return Object.freeze({ status: "conflict", transactionId: record.transactionId });
      }
      const updatedJournalIdentity = writeJournal(paths.journalPath, updated, journalIdentity, held, operations);
      const committed = { ...updated, phase: "committed" as const };
      const committedJournalIdentity = writeJournal(paths.journalPath, committed, updatedJournalIdentity, held, operations);
      const committedJournal = readJournal(paths.journalPath, operations);
      if (!committedJournal || !sameIdentity(committedJournal.identity, committedJournalIdentity)
        || !finalizeCommittedRecord(committed, paths, committedJournalIdentity, committedJournal.digest, held, operations)) {
        return Object.freeze({ status: "conflict", transactionId: record.transactionId });
      }
      assertHeldLocks(held, operations);
      return Object.freeze({ status: "completed", transactionId: record.transactionId });
    } catch {
      return Object.freeze({ status: "conflict", transactionId: record.transactionId });
    }
  } finally {
    releaseLocks(held, operations);
  }
}

/** Apply one previously validated two-file proposal with a durable recovery journal. */
export function applyReconciliationTransaction(
  input: ApplyReconciliationTransactionInput,
  operations: ReconciliationStoreOperations = DEFAULT_OPERATIONS,
): ApplyResult {
  if (!(input.nextConfigBytes instanceof Uint8Array) || !(input.nextOwnershipBytes instanceof Uint8Array)) {
    throw new ReconciliationStoreError("invalid_input");
  }
  const nextConfig = Buffer.from(input.nextConfigBytes);
  const nextOwnership = Buffer.from(input.nextOwnershipBytes);
  checkPayloadBounds(nextConfig, nextOwnership);
  verifyNewPayloads(nextConfig, nextOwnership);
  const paths = normalizePaths(input, operations);
  const held = acquireLocks(paths, operations);
  try {
    if (readSnapshot(paths.journalPath, operations)) throw new ReconciliationStoreError("conflict");
    const oldConfig = readSnapshot(paths.configPath, operations);
    const oldOwnership = readSnapshot(paths.ownershipPath, operations);
    verifyExpected(oldConfig, input.expectedConfigDigest);
    verifyExpected(oldOwnership, input.expectedOwnershipDigest);
    if (oldConfig) assertPlainJsonObject(oldConfig.bytes);
    if (oldOwnership) assertOwnershipPayload(oldOwnership.bytes);

    const transactionId = operations.randomUUID();
    if (!SAFE_TRANSACTION_ID.test(transactionId)) throw new ReconciliationStoreError("io_failure");
    let record = initialRecord(transactionId, paths, oldConfig, oldOwnership, nextConfig, nextOwnership);
    let journalIdentity = writeInitialJournal(paths.journalPath, record, held, operations);

    const configBackupPath = targetBackupPath(record.config);
    const ownerBackupPath = targetBackupPath(record.ownership);

    if (oldConfig && configBackupPath) {
      const backupIdentity = writeExclusive(configBackupPath, oldConfig.bytes, 0o600, operations);
      record = { ...record, config: updateTarget(record.config, { backupIdentity }) };
      journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);
    }
    if (oldOwnership && ownerBackupPath) {
      const backupIdentity = writeExclusive(ownerBackupPath, oldOwnership.bytes, 0o600, operations);
      record = { ...record, ownership: updateTarget(record.ownership, { backupIdentity }) };
      journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);
    }
    const configStageIdentity = writeExclusive(targetStagePath(record.config), nextConfig, record.config.mode, operations);
    record = { ...record, config: updateTarget(record.config, { stageIdentity: configStageIdentity }) };
    journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);
    const ownershipStageIdentity = writeExclusive(targetStagePath(record.ownership), nextOwnership, record.ownership.mode, operations);
    record = { ...record, ownership: updateTarget(record.ownership, { stageIdentity: ownershipStageIdentity }) };
    journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);
    syncDirectory(paths.configPath, operations, false);
    syncDirectory(paths.ownershipPath, operations, false);
    record = { ...record, phase: "ready" };
    journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);

    if (!sameNullableDigest(paths.configPath, record.config.oldDigest, operations)
      || !sameNullableDigest(paths.ownershipPath, record.ownership.oldDigest, operations)) {
      throw new ReconciliationStoreError("conflict");
    }
    operations.renameSync(targetStagePath(record.config), paths.configPath);
    syncDirectory(paths.configPath, operations, false);
    record = { ...record, phase: "config_installed" };
    journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);

    if (!sameNullableDigest(paths.configPath, record.config.nextDigest, operations)
      || !sameNullableDigest(paths.ownershipPath, record.ownership.oldDigest, operations)) {
      throw new ReconciliationStoreError("conflict");
    }
    operations.renameSync(targetStagePath(record.ownership), paths.ownershipPath);
    syncDirectory(paths.ownershipPath, operations, true);
    record = { ...record, phase: "ownership_installed" };
    journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);
    record = { ...record, phase: "committed" };
    journalIdentity = writeJournal(paths.journalPath, record, journalIdentity, held, operations);
    const committedJournal = readJournal(paths.journalPath, operations);
    if (!committedJournal || !sameIdentity(committedJournal.identity, journalIdentity)
      || !backupsMatch(record, operations)
      || !removeJournal(paths.journalPath, journalIdentity, committedJournal.digest, held, operations)) {
      throw new ReconciliationStoreError("io_failure");
    }

    assertHeldLocks(held, operations);

    return Object.freeze({
      status: "committed",
      transactionId,
      ...(configBackupPath ? { configBackupPath } : {}),
      ...(ownerBackupPath ? { ownershipBackupPath: ownerBackupPath } : {}),
    });
  } catch (error) {
    if (error instanceof ReconciliationStoreError) throw error;
    throw new ReconciliationStoreError("io_failure");
  } finally {
    releaseLocks(held, operations);
  }
}
