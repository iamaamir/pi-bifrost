import * as fs from "node:fs";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  abandonReliabilityV2Dispatch,
  admitReliabilityV2Dispatch,
  emptyReliabilityV2State,
  renewReliabilityV2Leases,
  settleReliabilityV2Dispatch,
  validateReliabilityV2State,
  type ReliabilityV2Admission,
  type ReliabilityV2Config,
  type ReliabilityV2LeaseOperation,
  type ReliabilityV2Result,
  type ReliabilityV2SettleRequest,
  type ReliabilityV2State,
} from "./reliability-v2.ts";
import { convertReliabilityV1Snapshot } from "./reliability-migration.ts";
import { writeJsonFile } from "./storage.ts";

export type ReliabilityV2StoreErrorCode =
  | "invalid_options"
  | "unsafe_state_target"
  | "corrupt_state"
  | "lock_contended"
  | "orphan_lock"
  | "invalid_lock"
  | "lock_create_failed"
  | "lock_owner_lost"
  | "invalid_migration"
  | "backup_conflict"
  | "backup_write_failed"
  | "state_write_failed";

export class ReliabilityV2StoreError extends Error {
  readonly code: ReliabilityV2StoreErrorCode;

  constructor(code: ReliabilityV2StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ReliabilityV2StoreError";
  }
}

export interface ReliabilityV2StoreIo {
  readState(path: string): unknown;
  writeState(path: string, state: ReliabilityV2State): void;
  writeLock(fd: number, contents: string): void;
}

export interface ReliabilityV2StoreOptions {
  path: string;
  config: ReliabilityV2Config;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  now?: () => number;
  io?: Partial<ReliabilityV2StoreIo>;
}

export interface ReliabilityV2MigrationResult {
  status: "seeded" | "already_initialized";
  state: ReliabilityV2State;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockOwner extends FileIdentity {
  path: string;
  ownerToken: string;
}

interface LockData extends FileIdentity {
  ownerToken: string;
  pid: number;
  createdAt: number;
}

interface DataRecord extends Record<string, unknown> {}

const DEFAULT_LOCK_TIMEOUT_MS = 150;
const DEFAULT_LOCK_POLL_MS = 10;
const MAX_LOCK_TIMEOUT_MS = 5000;
const MAX_LOCK_POLL_MS = 100;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_LOCK_BYTES = 4096;
const MAX_TIMESTAMP = 8.64e15;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function plainRecord(value: unknown): DataRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as DataRecord : undefined;
  } catch {
    return undefined;
  }
}

function ownData(record: DataRecord, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exactKeys(record: DataRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  try {
    const keys = Object.keys(record);
    const permitted = new Set([...required, ...optional]);
    return required.every((key) => keys.includes(key))
      && keys.every((key) => permitted.has(key))
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return !!descriptor && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  try {
    return String((error as { code: unknown }).code);
  } catch {
    return undefined;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedBytes(fd: number, maxBytes: number, kind: "state" | "lock"): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > maxBytes) throw new ReliabilityV2StoreError(kind === "state" ? "corrupt_state" : "invalid_lock", "Reliability v2 file exceeds its size limit");
  return Buffer.concat(chunks, total);
}

function targetStat(path: string, kind: "state" | "lock" = "state"): fs.Stats | undefined {
  try {
    const stats = fs.lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ReliabilityV2StoreError(kind === "state" ? "unsafe_state_target" : "invalid_lock", "Reliability v2 state and lock targets must be regular files");
    }
    return stats;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function readRegularFile(path: string, kind: "state" | "lock"): { text: string; bytes: Buffer; identity: FileIdentity } | undefined {
  const before = targetStat(path, kind);
  if (!before) return undefined;
  let fd: number | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(path, constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new ReliabilityV2StoreError(kind === "state" ? "unsafe_state_target" : "invalid_lock", "Reliability v2 file changed while opening");
    }
    const maxBytes = kind === "state" ? MAX_STATE_BYTES : MAX_LOCK_BYTES;
    if (opened.size > maxBytes) {
      throw new ReliabilityV2StoreError(kind === "state" ? "corrupt_state" : "invalid_lock", "Reliability v2 file exceeds its size limit");
    }
    const bytes = readBoundedBytes(fd, maxBytes, kind);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, bytes, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    if (error instanceof ReliabilityV2StoreError) throw error;
    if (errorCode(error) === "ENOENT") return undefined;
    if (errorCode(error) === "ELOOP") {
      throw new ReliabilityV2StoreError(kind === "state" ? "unsafe_state_target" : "invalid_lock", "Refusing to follow a reliability v2 symlink", { cause: error });
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the read result or original failure takes precedence */ }
    }
  }
}

function defaultReadState(path: string): unknown {
  const file = readRegularFile(path, "state");
  if (!file) return undefined;
  try {
    return JSON.parse(file.text) as unknown;
  } catch (error) {
    throw new ReliabilityV2StoreError("corrupt_state", "Reliability v2 state contains invalid JSON", { cause: error });
  }
}

const DEFAULT_IO: ReliabilityV2StoreIo = {
  readState: defaultReadState,
  writeState: writeJsonFile,
  writeLock(fd, contents) {
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  },
};

function lockData(file: { text: string; identity: FileIdentity }): LockData | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text) as unknown;
  } catch {
    return undefined;
  }
  const value = plainRecord(parsed);
  if (!value || !exactKeys(value, ["ownerToken", "pid", "createdAt"])) return undefined;
  const ownerToken = ownData(value, "ownerToken");
  const pid = ownData(value, "pid");
  const createdAt = ownData(value, "createdAt");
  if (typeof ownerToken !== "string" || !OWNER_ID.test(ownerToken)
    || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1
    || !timestamp(createdAt)) return undefined;
  return { ownerToken, pid, createdAt, ...file.identity };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function lockTimeoutError(path: string): ReliabilityV2StoreError {
  let file: ReturnType<typeof readRegularFile>;
  try {
    file = readRegularFile(path, "lock");
  } catch (error) {
    if (error instanceof ReliabilityV2StoreError) return error;
    return new ReliabilityV2StoreError("invalid_lock", "Cannot inspect the existing reliability v2 lock", { cause: error });
  }
  if (!file) return new ReliabilityV2StoreError("lock_contended", "Reliability v2 lock is changing; retry the operation");
  const parsed = lockData(file);
  if (!parsed) return new ReliabilityV2StoreError("invalid_lock", "Reliability v2 lock is malformed; repair it explicitly");
  return pidIsAlive(parsed.pid)
    ? new ReliabilityV2StoreError("lock_contended", "Reliability v2 lock is held by a live process")
    : new ReliabilityV2StoreError("orphan_lock", "Reliability v2 lock belongs to a stopped process; repair it explicitly");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sameOwner(lockPath: string, owner: LockOwner): boolean {
  const file = readRegularFile(lockPath, "lock");
  if (!file || !sameIdentity(file.identity, owner)) return false;
  const parsed = lockData(file);
  return !!parsed && parsed.ownerToken === owner.ownerToken;
}

function unlinkCreatedLock(owner: LockOwner): void {
  try {
    const stats = fs.lstatSync(owner.path);
    if (stats.isFile() && !stats.isSymbolicLink() && sameIdentity(stats, owner)) fs.unlinkSync(owner.path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function removeCreatedBackup(path: string, identity: FileIdentity): void {
  try {
    const stats = fs.lstatSync(path);
    if (stats.isFile() && !stats.isSymbolicLink() && sameIdentity(stats, identity)) fs.unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
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

function writeMigrationBackup(path: string, snapshot: Buffer): void {
  let fd: number | undefined;
  let identity: FileIdentity | undefined;
  try {
    fd = fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const stats = fs.fstatSync(fd);
    identity = { dev: stats.dev, ino: stats.ino };
    fs.writeFileSync(fd, snapshot);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDirectory(path);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve original backup failure */ }
    }
    if (identity) {
      try { removeCreatedBackup(path, identity); } catch { /* preserve original backup failure */ }
    }
    if (errorCode(error) === "EEXIST") {
      try {
        const existing = readRegularFile(path, "state");
        if (existing?.bytes.equals(snapshot)) return;
      } catch { /* mismatch, unsafe target, or read failure all require explicit backup repair */ }
      throw new ReliabilityV2StoreError("backup_conflict", "Reliability migration backup exists with different or unsafe bytes");
    }
    throw new ReliabilityV2StoreError("backup_write_failed", "Could not create the reliability migration backup");
  }
}

function releaseLock(owner: LockOwner): void {
  if (!sameOwner(owner.path, owner)) {
    throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock ownership changed; the lock was left untouched");
  }
  const current = targetStat(owner.path, "lock");
  if (!current || !sameIdentity(current, owner)) {
    throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock identity changed; the lock was left untouched");
  }
  fs.unlinkSync(owner.path);
}

function safeRequest(value: unknown, required: readonly string[], optional: readonly string[] = []): DataRecord | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  try {
    const keys = Object.keys(record);
    const permitted = new Set([...required, ...optional]);
    if (required.some((key) => !keys.includes(key)) || keys.some((key) => !permitted.has(key))) return undefined;
    const result: DataRecord = Object.create(null) as DataRecord;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      const item = descriptor.value;
      if (key === "modelKeys") {
        const copied = safeDataArray(item, (entry) => typeof entry === "string");
        if (!copied) return undefined;
        result[key] = copied;
      } else if (key === "leaseReferences") {
        const copied = safeDataArray(item, (entry) => {
          const reference = plainRecord(entry);
          return !!reference && exactKeys(reference, ["scopeKey", "generation", "leaseId", "expiresAt", "maxExpiresAt"]);
        });
        if (!copied) return undefined;
        result[key] = copied.map((entry) => {
          const source = entry as DataRecord;
          return Object.assign(Object.create(null) as DataRecord, {
            scopeKey: ownData(source, "scopeKey"),
            generation: ownData(source, "generation"),
            leaseId: ownData(source, "leaseId"),
            expiresAt: ownData(source, "expiresAt"),
            maxExpiresAt: ownData(source, "maxExpiresAt"),
          });
        });
      } else if (key === "settlement") {
        const settlement = plainRecord(item);
        if (!settlement || !exactKeys(settlement, ["kind"])) return undefined;
        result[key] = Object.assign(Object.create(null) as DataRecord, { kind: ownData(settlement, "kind") });
      } else if (item === null || ["string", "number", "boolean", "undefined"].includes(typeof item)) {
        result[key] = item;
      } else {
        return undefined;
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

function safeDataArray(value: unknown, validItem: (item: unknown) => boolean): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !validItem(descriptor.value)) return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

export class ReliabilityV2Store {
  readonly path: string;
  readonly lockPath: string;
  private readonly config: ReliabilityV2Config;
  private readonly io: ReliabilityV2StoreIo;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;

  constructor(options: ReliabilityV2StoreOptions) {
    if (!options || typeof options.path !== "string" || options.path.length === 0
      || !validateReliabilityV2State(emptyReliabilityV2State(), options.config)) {
      throw new ReliabilityV2StoreError("invalid_options", "Reliability v2 store needs an explicit path and valid configuration");
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS
      || !Number.isSafeInteger(lockPollMs) || lockPollMs < 1 || lockPollMs > MAX_LOCK_POLL_MS) {
      throw new ReliabilityV2StoreError("invalid_options", "Reliability v2 lock wait settings are outside their safe bounds");
    }
    this.path = resolve(options.path);
    this.lockPath = `${this.path}.lock`;
    this.config = Object.freeze({ ...options.config });
    this.io = { ...DEFAULT_IO, ...options.io };
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockPollMs = lockPollMs;
  }

  async admit(requestValue: Omit<ReliabilityV2Admission, "now">): Promise<ReliabilityV2Result> {
    const request = safeRequest(requestValue, ["ownerToken", "dispatchId", "outcomeId", "modelKeys"]);
    if (!request) return { status: "invalid", reason: "invalid_admission_request", state: emptyReliabilityV2State() };
    return this.transact((state, now) => admitReliabilityV2Dispatch(state, { ...request, now }, this.config));
  }

  async renew(requestValue: Omit<ReliabilityV2LeaseOperation, "now">): Promise<ReliabilityV2Result> {
    const request = safeRequest(requestValue, ["ownerToken", "dispatchId", "outcomeId", "leaseReferences"], ["ttlMs"]);
    if (!request) return { status: "invalid", reason: "invalid_renew_request", state: emptyReliabilityV2State() };
    return this.transact((state, now) => renewReliabilityV2Leases(state, { ...request, now }, this.config));
  }

  async settle(requestValue: Omit<ReliabilityV2SettleRequest, "now">): Promise<ReliabilityV2Result> {
    const request = safeRequest(requestValue, ["ownerToken", "dispatchId", "outcomeId", "settlement"]);
    if (!request) return { status: "invalid", reason: "invalid_settle_request", state: emptyReliabilityV2State() };
    return this.transact((state, now) => settleReliabilityV2Dispatch(state, { ...request, now }, this.config));
  }

  async abandon(requestValue: Omit<ReliabilityV2LeaseOperation, "now">): Promise<ReliabilityV2Result> {
    const request = safeRequest(requestValue, ["ownerToken", "dispatchId", "outcomeId", "leaseReferences"]);
    if (!request) return { status: "invalid", reason: "invalid_abandon_request", state: emptyReliabilityV2State() };
    return this.transact((state, now) => abandonReliabilityV2Dispatch(state, { ...request, now }, this.config));
  }

  /** @internal One-purpose initializer used only by explicit v1 migration. */
  async initializeFromV1Migration(input: { sourceSnapshot: Uint8Array; backupPath: string; sourcePath?: string }): Promise<ReliabilityV2MigrationResult> {
    const inputRecord = plainRecord(input);
    if (!inputRecord || !exactKeys(inputRecord, ["sourceSnapshot", "backupPath"], ["sourcePath"])) {
      throw new ReliabilityV2StoreError("invalid_migration", "Reliability migration input is invalid");
    }
    const rawSnapshot = ownData(inputRecord, "sourceSnapshot");
    const rawBackupPath = ownData(inputRecord, "backupPath");
    const rawSourcePath = ownData(inputRecord, "sourcePath");
    if (!(rawSnapshot instanceof Uint8Array) || rawSnapshot.byteLength > 16 * 1024 * 1024
      || typeof rawBackupPath !== "string" || rawBackupPath.length === 0
      || (rawSourcePath !== undefined && (typeof rawSourcePath !== "string" || rawSourcePath.length === 0))) {
      throw new ReliabilityV2StoreError("invalid_migration", "Reliability migration input is invalid");
    }
    const sourceSnapshot = Buffer.from(rawSnapshot);
    const backupPath = resolve(rawBackupPath);
    const sourcePath = rawSourcePath === undefined ? undefined : resolve(rawSourcePath);
    if (backupPath === this.path || backupPath === this.lockPath || backupPath === sourcePath
      || dirname(backupPath) !== dirname(this.path)) {
      throw new ReliabilityV2StoreError("invalid_migration", "Reliability migration backup path is unsafe");
    }

    const owner = await this.acquireLock();
    let result: ReliabilityV2MigrationResult | undefined;
    let failure: unknown;
    try {
      const existing = targetStat(this.path);
      const current = this.loadState();
      if (existing) {
        result = { status: "already_initialized", state: current };
      } else {
        let seed: ReliabilityV2State;
        try {
          seed = convertReliabilityV1Snapshot(sourceSnapshot, this.config);
        } catch (error) {
          throw new ReliabilityV2StoreError("invalid_migration", "Reliability v1 snapshot failed strict validation", { cause: error });
        }
        if (!validateReliabilityV2State(seed, this.config)) {
          throw new ReliabilityV2StoreError("invalid_migration", "Reliability v1 snapshot produced invalid v2 state");
        }
        if (!sameOwner(this.lockPath, owner)) {
          throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock changed before migration backup");
        }
        writeMigrationBackup(backupPath, sourceSnapshot);
        if (!sameOwner(this.lockPath, owner)) {
          throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock changed before migration commit");
        }
        try {
          this.assertSafeStateTarget();
          this.io.writeState(this.path, seed);
        } catch (error) {
          if (error instanceof ReliabilityV2StoreError) throw error;
          throw new ReliabilityV2StoreError("state_write_failed", "Reliability v2 migration seed was not committed", { cause: error });
        }
        if (!sameOwner(this.lockPath, owner)) {
          throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock changed during migration commit");
        }
        result = { status: "seeded", state: seed };
      }
    } catch (error) {
      failure = error;
    }
    try {
      releaseLock(owner);
    } catch (releaseError) {
      if (failure === undefined) failure = releaseError;
      else if (failure instanceof Error) {
        try { Object.defineProperty(failure, "releaseError", { value: releaseError, enumerable: false }); } catch { /* preserve original migration failure */ }
      }
    }
    if (failure !== undefined) throw failure;
    return result!;
  }

  private async transact(mutate: (state: ReliabilityV2State, now: number) => ReliabilityV2Result): Promise<ReliabilityV2Result> {
    const owner = await this.acquireLock();
    let result: ReliabilityV2Result | undefined;
    let failure: unknown;
    try {
      const current = this.loadState();
      const now = this.now();
      result = mutate(current, now);
      if (result.status !== "invalid" && result.state.revision !== current.revision) {
        if (!validateReliabilityV2State(result.state, this.config)) {
          throw new ReliabilityV2StoreError("corrupt_state", "Reliability v2 transition produced invalid state");
        }
        if (!sameOwner(this.lockPath, owner)) {
          throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock changed before state commit");
        }
        try {
          this.assertSafeStateTarget();
          this.io.writeState(this.path, result.state);
        } catch (error) {
          throw new ReliabilityV2StoreError("state_write_failed", "Reliability v2 state was not committed", { cause: error });
        }
        if (!sameOwner(this.lockPath, owner)) {
          throw new ReliabilityV2StoreError("lock_owner_lost", "Reliability v2 lock changed during state commit; do not dispatch this admission");
        }
      }
    } catch (error) {
      failure = error;
    }
    try {
      releaseLock(owner);
    } catch (releaseError) {
      if (failure === undefined) failure = releaseError;
      else if (failure instanceof Error) {
        try { Object.defineProperty(failure, "releaseError", { value: releaseError, enumerable: false }); } catch { /* preserve the original transaction failure */ }
      }
    }
    if (failure !== undefined) throw failure;
    return result!;
  }

  private loadState(): ReliabilityV2State {
    this.assertSafeStateTarget();
    let loaded: unknown;
    try {
      loaded = this.io.readState(this.path);
    } catch (error) {
      if (error instanceof ReliabilityV2StoreError) throw error;
      throw new ReliabilityV2StoreError("corrupt_state", "Cannot read reliability v2 state", { cause: error });
    }
    if (loaded === undefined) return emptyReliabilityV2State();
    if (!validateReliabilityV2State(loaded, this.config)) {
      throw new ReliabilityV2StoreError("corrupt_state", "Reliability v2 state failed schema or lease validation");
    }
    return loaded;
  }

  private assertSafeStateTarget(): void {
    const stats = targetStat(this.path);
    if (stats && !stats.isFile()) throw new ReliabilityV2StoreError("unsafe_state_target", "Reliability v2 state target is not a regular file");
  }

  private async acquireLock(): Promise<LockOwner> {
    fs.mkdirSync(dirname(this.path), { recursive: true });
    const started = performance.now();
    while (true) {
      const ownerToken = randomUUID();
      let fd: number | undefined;
      let owner: LockOwner | undefined;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        const identity = fs.fstatSync(fd);
        owner = { path: this.lockPath, ownerToken, dev: identity.dev, ino: identity.ino };
        const createdAt = this.now();
        if (!timestamp(createdAt)) throw new ReliabilityV2StoreError("lock_create_failed", "Invalid clock while creating reliability v2 lock");
        this.io.writeLock(fd, JSON.stringify({ ownerToken, pid: process.pid, createdAt }));
        fs.closeSync(fd);
        fd = undefined;
        return owner;
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* preserve lock creation failure */ }
        }
        if (owner) {
          try { unlinkCreatedLock(owner); } catch { /* preserve original failure; any remaining lock fails closed */ }
        }
        if (errorCode(error) !== "EEXIST") {
          if (error instanceof ReliabilityV2StoreError) throw error;
          throw new ReliabilityV2StoreError("lock_create_failed", "Could not create reliability v2 owner lock", { cause: error });
        }
        if (performance.now() - started >= this.lockTimeoutMs) throw lockTimeoutError(this.lockPath);
        await sleep(Math.min(this.lockPollMs, Math.max(1, this.lockTimeoutMs - (performance.now() - started))));
      }
    }
  }
}
