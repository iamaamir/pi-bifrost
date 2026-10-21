// ── Bifrost logger ────────────────────────────────────────────────
// Bounded, best-effort diagnostics. The routing hot path only filters,
// optionally evaluates lazy metadata, serializes, and admits into a bounded
// queue. Filesystem work runs later, off the caller's stack, and failures are
// counted rather than propagated.

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { BoundedQueue } from "./bounded-queue.ts";
import { createDrainPolicy, type DrainPolicy } from "./drain-policy.ts";
import { AsyncFileSink } from "./file-sink.ts";
import {
  UNATTRIBUTED_SESSION,
  destinationFor,
  mergeIdentity,
  processCorrelation,
} from "./context.ts";
import {
  buildRecord,
  retentionFor,
  sanitizeMeta,
  serializeRecord,
  shouldEmit,
} from "./severity.ts";
import { resolveOverflowPolicy, type OverflowPolicy } from "./overflow-policy.ts";
import {
  FAILURE_BACKOFF_MS,
  MAX_ENTRY_BYTES,
  type DebugEmitOptions,
  type DebugMeta,
  type DebugMetaSource,
  type DropReason,
  type LogDestination,
  type LogEntry,
  type LogIdentity,
  type LogIdentityHint,
  type LogLevel,
  type LogSink,
  type LoggerStats,
  type ResolvedDebugConfig,
} from "./types.ts";

const BOOTSTRAP_MAX_ENTRIES = 64;
const BOOTSTRAP_MAX_BYTES = 128 * 1024;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
const SYNC_FLUSH_MAX_ENTRIES = 128;
const SYNC_FLUSH_MAX_BYTES = 256 * 1024;
const SYNC_FLUSH_MAX_FILES = 8;
const MAX_FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_THRESHOLD = 5;
const DIAGNOSTIC_INTERVAL_MS = 30_000;
const MAX_IDLE_SINKS = 16;
const MAX_DROP_SUMMARIES = 64;

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface BootstrapRecord {
  readonly level: LogLevel;
  readonly retention: number;
  readonly module: string;
  readonly event: string;
  readonly entryType: "event" | "measure";
  readonly now: Date;
  readonly meta: DebugMeta | undefined;
  readonly durationMs?: number;
  readonly metaError?: string;
}

interface BootstrapItem {
  readonly record: BootstrapRecord;
  readonly bytes: number;
  readonly identity: LogIdentity;
  readonly destination: LogDestination;
}

interface DestinationHealth {
  consecutiveFailures: number;
  degradedUntil: number;
  summarySuppressed: boolean;
}

interface DropSummary {
  readonly destination: LogDestination;
  readonly identity: LogIdentity;
  total: number;
  readonly byLevel: Record<LogLevel, number>;
  readonly byReason: Record<DropReason, number>;
}

export interface BifrostLoggerOptions {
  readonly config: ResolvedDebugConfig;
  readonly identity: LogIdentity;
  readonly correlation?: Readonly<Record<string, string>>;
  readonly sinkFactory?: (destination: LogDestination, config: ResolvedDebugConfig) => LogSink;
  readonly bootstrapTimeoutMs?: number;
  readonly now?: () => number;
  readonly date?: () => Date;
}

interface MutableStats {
  droppedTotal: number;
  droppedBySeverity: Record<LogLevel, number>;
  droppedByReason: Record<DropReason, number>;
  evictionsTotal: number;
  batchesWritten: number;
  bytesWritten: number;
  writeFailures: number;
  lastFlushAt: number | null;
  lastWriteFailureAt: number | null;
}

function emptyByLevel(): Record<LogLevel, number> {
  return { trace: 0, debug: 0, info: 0, warn: 0, error: 0 };
}

function emptyByReason(): Record<DropReason, number> {
  return { queue_capacity: 0, oversized: 0, write_failure: 0, sink_degraded: 0, closed: 0 };
}

function evaluateMeta(source: DebugMetaSource | undefined): { meta?: DebugMeta; error?: string } {
  try {
    const value = typeof source === "function" ? source() : source;
    if (value && typeof value === "object" && !Array.isArray(value)) return { meta: value };
    return {};
  } catch {
    return { error: "callback_threw" };
  }
}

export class BifrostLogger {
  private readonly config: ResolvedDebugConfig;
  private readonly queue: BoundedQueue;
  private readonly overflow: OverflowPolicy;
  private readonly drainPolicy: DrainPolicy;
  private readonly baseIdentity: LogIdentity;
  private readonly correlation: Readonly<Record<string, string>>;
  private readonly sinkFactory: (destination: LogDestination, config: ResolvedDebugConfig) => LogSink;
  private readonly bootstrapTimeoutMs: number;
  private readonly now: () => number;
  private readonly date: () => Date;

  private sessionIdentity: LogIdentity | null = null;
  private cachedIdentity: LogIdentity | null = null;
  private cachedDestination: LogDestination | null = null;
  private readonly sinks = new Map<string, LogSink>();
  private readonly sinkLastUsed = new Map<string, number>();
  private readonly activeWritesByDestination = new Map<string, number>();
  private readonly pendingByDestination = new Map<string, number>();
  private readonly destinationHealth = new Map<string, DestinationHealth>();
  private readonly activeWrites = new Set<Promise<void>>();
  private readonly flushWaiters = new Set<() => void>();
  private bootstrap: BootstrapItem[] = [];
  private bootstrapBytes = 0;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Once a session has ended, process events are no longer startup events. */
  private bootstrapSealed = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private accepting = true;
  private closePromise: Promise<void> | null = null;
  private stopped = false;
  private entrySequence = 0;
  private lastDiagnosticAt = 0;
  private readonly dropSummaries = new Map<string, DropSummary>();
  private emittingSummary = false;
  private readonly statsValue: MutableStats = {
    droppedTotal: 0,
    droppedBySeverity: emptyByLevel(),
    droppedByReason: emptyByReason(),
    evictionsTotal: 0,
    batchesWritten: 0,
    bytesWritten: 0,
    writeFailures: 0,
    lastFlushAt: null,
    lastWriteFailureAt: null,
  };

  constructor(options: BifrostLoggerOptions) {
    this.config = options.config;
    this.queue = new BoundedQueue(options.config.queue.maxEntries, options.config.queue.maxBytes);
    this.overflow = resolveOverflowPolicy(options.config.queue.overflowPolicy);
    this.drainPolicy = createDrainPolicy(options.config);
    this.baseIdentity = options.identity;
    this.correlation = options.correlation ?? processCorrelation();
    this.sinkFactory = options.sinkFactory ?? ((destination, config) => new AsyncFileSink(destination, {
      maxFileSizeBytes: config.sink.maxFileSizeBytes,
      rotatedFiles: config.sink.rotatedFiles,
    }));
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.date = options.date ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.accepting;
  }

  get minimumLevel(): LogLevel {
    return this.config.level;
  }

  accepts(level: LogLevel): boolean {
    return this.accepting && shouldEmit(this.config.level, level);
  }

  currentIdentity(): LogIdentity {
    return this.sessionIdentity ?? this.baseIdentity;
  }

  currentDestination(): LogDestination {
    return destinationFor(this.config, this.currentIdentity());
  }

  /** Associate subsequent default-attributed events with a Pi session. */
  bindSession(hint: LogIdentityHint): LogIdentity {
    const next = mergeIdentity(this.baseIdentity, hint);
    this.sessionIdentity = next;
    this.finalizeBootstrap(next);
    return next;
  }

  endSession(): void {
    this.finalizeBootstrap();
    this.sessionIdentity = null;
    this.bootstrapSealed = true;
  }

  emit(
    module: string,
    event: string,
    metaSource?: DebugMetaSource,
    options?: DebugEmitOptions,
    entryType: "event" | "measure" = "event",
    durationMs?: number,
  ): void {
    if (!this.accepting || !this.config.enabled) return;
    const level = options?.level ?? "debug";
    if (!shouldEmit(this.config.level, level)) return;
    const protectedEvent = options?.protected === true;
    const retention = retentionFor(level, protectedEvent);
    const identity = this.identityFor(options?.identity);
    const bootstrap = this.needsBootstrap(options?.identity);
    if (!bootstrap && this.wouldRejectBeforePreparation(retention)) {
      this.recordDrop(level, "queue_capacity", identity);
      return;
    }
    const outcome = evaluateMeta(metaSource);
    const record: BootstrapRecord = {
      level,
      retention,
      module,
      event,
      entryType,
      now: this.date(),
      meta: outcome.meta,
      ...(durationMs !== undefined ? { durationMs: Math.round(durationMs * 1_000) / 1_000 } : {}),
      ...(outcome.error ? { metaError: outcome.error } : {}),
    };
    if (bootstrap) {
      this.addBootstrap(record, identity);
      return;
    }
    const entry = this.prepare(record, identity);
    if (entry) this.enqueue(entry);
  }

  stats(): LoggerStats {
    return {
      queuedEntries: this.queue.pendingEntryCount,
      queuedBytes: this.queue.pendingBytes,
      inFlightEntries: this.queue.inFlightEntryCount,
      inFlightBytes: this.queue.inFlightBytes,
      droppedTotal: this.statsValue.droppedTotal,
      droppedBySeverity: { ...this.statsValue.droppedBySeverity },
      droppedByReason: { ...this.statsValue.droppedByReason },
      evictionsTotal: this.statsValue.evictionsTotal,
      batchesWritten: this.statsValue.batchesWritten,
      bytesWritten: this.statsValue.bytesWritten,
      writeFailures: this.statsValue.writeFailures,
      largestQueuedEntries: this.queue.largestObservedEntries,
      largestQueuedBytes: this.queue.largestObservedBytes,
      lastFlushAt: this.statsValue.lastFlushAt,
      lastWriteFailureAt: this.statsValue.lastWriteFailureAt,
      openSinks: this.sinks.size,
    };
  }

  /** Bounded drain. The timeout is a real deadline, not a retry budget. */
  async flush(timeoutMs = 250): Promise<void> {
    const budget = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 0), MAX_FLUSH_TIMEOUT_MS);
    this.finalizeBootstrap();
    if (this.stopped && this.queue.totalEntries === 0 && this.activeWrites.size === 0) return;
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
    if (this.queue.totalEntries === 0 && this.activeWrites.size === 0 && !this.pumping) {
      this.maybeEmitDropSummary();
      if (this.queue.totalEntries === 0 && this.activeWrites.size === 0) return;
    }
    if (budget <= 0) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.flushWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, budget);
      // A caller awaiting shutdown must keep the event loop alive until the
      // drain either settles or reaches its deadline. If this timer were
      // unref'ed, Node could exit while a host shutdown hook is still awaiting
      // flushDebug(), truncating later extension handlers and logs.
      this.flushWaiters.add(finish);
      this.schedulePump(0);
    });
  }

  /** Stop accepting work, drain what is already accepted, then close sinks. */
  close(timeoutMs = 250): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal(timeoutMs);
    return this.closePromise;
  }

  private async closeInternal(timeoutMs: number): Promise<void> {
    // Adopt bootstrap events before blocking new ones; otherwise closing a
    // logger that never saw a session would silently discard startup history.
    this.finalizeBootstrap();
    this.accepting = false;
    this.schedulePump(0);
    await this.flush(timeoutMs);
    this.stopped = true;
    this.clearTimers();
    const sinks = [...this.sinks.values()];
    this.sinks.clear();
    const closings = sinks.map((sink) => Promise.resolve()
      .then(() => sink.close())
      .catch(() => undefined));
    await Promise.race([
      Promise.allSettled(closings),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(timeoutMs, 1_000));
        timer.unref?.();
      }),
    ]);
    this.resolveWaiters();
  }

  /** Strictly bounded synchronous fallback for `process.exit`. */
  flushSyncBounded(): void {
    try {
      this.accepting = false;
      this.finalizeBootstrapSync();
      const batch = this.queue.takePendingSync(SYNC_FLUSH_MAX_ENTRIES, SYNC_FLUSH_MAX_BYTES);
      if (batch.length === 0) return;
      // The batch is no longer pending even if the per-file cap leaves some
      // entries unwritten on the exit path.
      for (const entry of batch) this.adjustPending(entry.destination.key, -1);
      const groups = new Map<string, { path: string; shared: boolean; root?: string; lines: string[] }>();
      for (const entry of batch) {
        let group = groups.get(entry.destination.key);
        if (!group) {
          if (groups.size >= SYNC_FLUSH_MAX_FILES) break;
          group = {
            path: entry.destination.path,
            shared: entry.destination.shared,
            ...(entry.destination.root ? { root: entry.destination.root } : {}),
            lines: [],
          };
          groups.set(entry.destination.key, group);
        }
        group.lines.push(entry.line);
      }
      for (const group of groups.values()) {
        try {
          mkdirSync(dirname(group.path), { recursive: true, mode: 0o700 });
          if (group.shared) {
            // Explicitly configured legacy paths keep their historical behavior.
            appendFileSync(group.path, group.lines.join(""), { encoding: "utf-8", flag: "a", mode: 0o600 });
            continue;
          }
          if (group.root) {
            const realRoot = realpathSync(group.root);
            const realParent = realpathSync(dirname(group.path));
            if (!isInsidePath(realRoot, realParent)) continue;
          }
          const fd = openSync(
            group.path,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NO_FOLLOW,
            0o600,
          );
          try {
            writeSync(fd, group.lines.join(""));
          } finally {
            closeSync(fd);
          }
        } catch {
          // Exit path: no diagnostics, no retries.
        }
      }
    } catch {
      // Logging must never abort process exit.
    }
  }

  // ── Admission ──────────────────────────────────────────────────

  private identityFor(hint?: LogIdentityHint): LogIdentity {
    const current = this.currentIdentity();
    if (!hint?.sessionId) return current;
    // The overwhelmingly common case is a call site naming the already-bound
    // session. Reuse the identity object so destination lookup stays cached.
    if (hint.sessionId === current.sessionId
      && (hint.rootSessionId === undefined || hint.rootSessionId === current.rootSessionId)
      && (hint.agentId === undefined || hint.agentId === current.agentId)
      && (hint.parentAgentId === undefined || hint.parentAgentId === current.parentAgentId)) {
      return current;
    }
    return mergeIdentity(this.baseIdentity, hint);
  }

  private destinationForIdentity(identity: LogIdentity): LogDestination {
    if (this.cachedIdentity === identity && this.cachedDestination) return this.cachedDestination;
    const destination = destinationFor(this.config, identity);
    this.cachedIdentity = identity;
    this.cachedDestination = destination;
    return destination;
  }

  /**
   * Cheap pre-admission check that avoids evaluating lazy metadata when the
   * queue is entry-count full and no eligible pending victim exists. Byte
   * pressure still requires the record to be prepared.
   */
  private wouldRejectBeforePreparation(retention: number): boolean {
    // drop-oldest deliberately ignores severity. It must always reach the
    // policy so an older high-severity event can make room for a newer one.
    if (this.overflow.name === "drop-oldest") return false;
    return this.queue.totalEntries >= this.config.queue.maxEntries
      && this.queue.minRetention > retention;
  }

  private needsBootstrap(hint?: LogIdentityHint): boolean {
    if (this.config.sharedPath) return false;
    if (hint?.sessionId) return false;
    if (this.sessionIdentity) return false;
    if (this.bootstrapSealed) return false;
    return this.baseIdentity.rootSessionId === UNATTRIBUTED_SESSION;
  }

  private prepare(record: BootstrapRecord, identity: LogIdentity): LogEntry | null {
    const destination = this.destinationForIdentity(identity);
    const input = {
      now: record.now,
      module: record.module,
      event: record.event,
      entryType: record.entryType,
      level: record.level,
      identity,
      correlation: this.correlation,
      meta: record.meta,
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.metaError !== undefined ? { metaError: record.metaError } : {}),
    } as const;
    let built: Record<string, unknown>;
    try {
      built = buildRecord(input);
    } catch {
      // A hostile getter or proxy must not escape into the routing hot path.
      try {
        built = buildRecord({ ...input, meta: undefined, metaError: "meta_threw" });
      } catch {
        this.recordDrop(record.level, "oversized", identity, destination);
        return null;
      }
    }
    const serialized = serializeRecord(built, MAX_ENTRY_BYTES);
    if (!serialized) {
      this.recordDrop(record.level, "oversized", identity, destination);
      return null;
    }
    this.entrySequence += 1;
    return {
      id: this.entrySequence,
      level: record.level,
      retention: record.retention,
      destination,
      identity,
      line: serialized.line,
      bytes: serialized.bytes,
    };
  }

  private enqueue(entry: LogEntry): void {
    if (!this.accepting) {
      this.recordDrop(entry.level, "closed", entry.identity, entry.destination);
      return;
    }
    const result = this.queue.admit(entry, this.overflow);
    if (!result.accepted) {
      this.recordDrop(entry.level, "queue_capacity", entry.identity, entry.destination);
      return;
    }
    this.adjustPending(entry.destination.key, 1);
    for (const evicted of result.evicted) {
      this.adjustPending(evicted.destination.key, -1);
      this.statsValue.evictionsTotal += 1;
      this.recordDrop(evicted.level, "queue_capacity", evicted.identity, evicted.destination);
    }
    if (this.queue.pendingEntryCount > 0) {
      if (this.drainPolicy.shouldDrainNow(this.queue.pendingBytes, this.queue.pendingEntryCount)) {
        this.schedulePump(0);
      } else {
        this.ensurePumpTimer();
      }
    }
  }

  private adjustPending(key: string, delta: number): void {
    const next = (this.pendingByDestination.get(key) ?? 0) + delta;
    if (next > 0) this.pendingByDestination.set(key, next);
    else this.pendingByDestination.delete(key);
  }

  private recordDrop(
    level: LogLevel,
    reason: DropReason,
    identity: LogIdentity,
    destination?: LogDestination,
  ): void {
    this.statsValue.droppedTotal += 1;
    this.statsValue.droppedBySeverity[level] += 1;
    this.statsValue.droppedByReason[reason] += 1;
    if (this.emittingSummary) return;
    const target = destination ?? this.destinationForIdentity(identity);
    let summary = this.dropSummaries.get(target.key);
    if (!summary) {
      if (this.dropSummaries.size >= MAX_DROP_SUMMARIES) {
        const oldest = this.dropSummaries.keys().next().value;
        if (oldest !== undefined) this.dropSummaries.delete(oldest);
      }
      summary = {
        destination: target,
        identity,
        total: 0,
        byLevel: emptyByLevel(),
        byReason: emptyByReason(),
      };
      this.dropSummaries.set(target.key, summary);
    }
    summary.total += 1;
    summary.byLevel[level] += 1;
    summary.byReason[reason] += 1;
  }

  // ── Bootstrap ──────────────────────────────────────────────────

  private addBootstrap(record: BootstrapRecord, identity: LogIdentity): void {
    // Startup metadata waits for a session identity, but the caller keeps
    // ownership of the original object. Snapshot it now so later mutation
    // cannot rewrite an already-recorded event.
    const snapshot: BootstrapRecord = {
      ...record,
      meta: record.meta ? sanitizeMeta(record.meta) : undefined,
    };
    const destination = this.destinationForIdentity(identity);
    const provisional = this.prepare(snapshot, identity);
    if (!provisional) return;
    while (this.bootstrap.length > 0
      && (this.bootstrap.length >= BOOTSTRAP_MAX_ENTRIES
        || this.bootstrapBytes + provisional.bytes > BOOTSTRAP_MAX_BYTES)) {
      const removed = this.bootstrap.shift();
      if (!removed) break;
      this.bootstrapBytes -= removed.bytes;
      this.recordDrop(removed.record.level, "queue_capacity", removed.identity, removed.destination);
    }
    if (provisional.bytes > BOOTSTRAP_MAX_BYTES) {
      this.recordDrop(record.level, "oversized", identity, destination);
      return;
    }
    this.bootstrap.push({ record: snapshot, bytes: provisional.bytes, identity, destination });
    this.bootstrapBytes += provisional.bytes;
    if (!this.bootstrapTimer) {
      this.bootstrapTimer = setTimeout(() => this.finalizeBootstrap(), this.bootstrapTimeoutMs);
      this.bootstrapTimer.unref?.();
    }
  }

  private finalizeBootstrap(identity?: LogIdentity): void {
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    if (this.bootstrap.length === 0) return;
    const records = this.bootstrap;
    this.bootstrap = [];
    this.bootstrapBytes = 0;
    const target = identity ?? this.currentIdentity();
    for (const item of records) {
      const entry = this.prepare(item.record, target);
      if (!entry) continue;
      // Startup records are older than any accepted event; if the queue is
      // full, drop the startup record rather than evicting live work.
      if (!this.queue.tryAdmit(entry)) {
        this.recordDrop(entry.level, "queue_capacity", target, entry.destination);
      } else {
        this.adjustPending(entry.destination.key, 1);
      }
    }
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
  }

  private finalizeBootstrapSync(): void {
    if (this.bootstrap.length === 0) return;
    const records = this.bootstrap;
    this.bootstrap = [];
    this.bootstrapBytes = 0;
    const target = this.currentIdentity();
    for (const item of records) {
      const entry = this.prepare(item.record, target);
      if (!entry) continue;
      // Exit path: preserve already-accepted events instead of evicting them
      // for older startup records.
      if (!this.queue.tryAdmit(entry)) {
        this.recordDrop(entry.level, "queue_capacity", target, entry.destination);
      } else {
        this.adjustPending(entry.destination.key, 1);
      }
    }
  }

  // ── Draining ───────────────────────────────────────────────────

  private ensurePumpTimer(): void {
    if (this.pumpTimer || this.stopped) return;
    this.schedulePump(this.drainPolicy.intervalMs);
  }

  private schedulePump(delayMs: number): void {
    if (this.stopped) return;
    if (this.pumpTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, delayMs));
    this.pumpTimer.unref?.();
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    const batch = this.queue.drain(this.drainPolicy.maxBatchEntries, this.drainPolicy.maxBatchBytes);
    for (const entry of batch) this.adjustPending(entry.destination.key, -1);
    if (batch.length === 0) {
      this.pumping = false;
      this.maybeEmitDropSummary();
      this.pruneIdleSinks();
      this.maybeSettle();
      return;
    }
    this.dispatch(batch);
    this.pumping = false;
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
    else this.maybeSettle();
    // Prune after every pump, not only when the whole pipeline is idle. A
    // continuously busy process must still be able to reclaim old destinations.
    this.pruneIdleSinks();
  }

  private dispatch(batch: readonly LogEntry[]): void {
    const groups = new Map<string, { destination: LogDestination; entries: LogEntry[] }>();
    for (const entry of batch) {
      let group = groups.get(entry.destination.key);
      if (!group) {
        group = { destination: entry.destination, entries: [] };
        groups.set(entry.destination.key, group);
      }
      group.entries.push(entry);
    }
    for (const group of groups.values()) {
      const key = group.destination.key;
      const bytes = group.entries.reduce((total, entry) => total + entry.bytes, 0);
      const health = this.destinationHealth.get(key);
      if (health && this.now() < health.degradedUntil) {
        this.queue.release(group.entries);
        for (const entry of group.entries) {
          this.recordDrop(entry.level, "sink_degraded", entry.identity, entry.destination);
        }
        continue;
      }
      this.sinkLastUsed.set(key, this.now());
      this.activeWritesByDestination.set(key, (this.activeWritesByDestination.get(key) ?? 0) + 1);
      let write: Promise<void>;
      try {
        write = this.sinkFor(group.destination).write(group.entries);
      } catch (error) {
        this.activeWritesByDestination.set(
          key,
          (this.activeWritesByDestination.get(key) ?? 1) - 1,
        );
        try {
          this.onWriteFailure(group.entries, bytes, error, group.destination);
        } catch {
          // Failure accounting must never escape the pump.
        }
        continue;
      }
      write
        .then(
          () => {
            try {
              this.onWriteSuccess(group.entries, bytes, group.destination);
            } catch {
              // A bookkeeping failure must not be reported as a write failure.
            }
          },
          (error: unknown) => {
            try {
              this.onWriteFailure(group.entries, bytes, error, group.destination);
            } catch {
              // Failure accounting must never escape the async boundary.
            }
          },
        )
        .finally(() => {
          this.activeWrites.delete(write);
          const remaining = (this.activeWritesByDestination.get(key) ?? 1) - 1;
          if (remaining > 0) this.activeWritesByDestination.set(key, remaining);
          else this.activeWritesByDestination.delete(key);
          try {
            this.maybeSettle();
          } catch {
            // Settling is best-effort; flush deadlines still release waiters.
          }
        });
      this.activeWrites.add(write);
    }
  }

  private sinkFor(destination: LogDestination): LogSink {
    const existing = this.sinks.get(destination.key);
    if (existing) return existing;
    const sink = this.sinkFactory(destination, this.config);
    this.sinks.set(destination.key, sink);
    return sink;
  }

  private onWriteSuccess(
    entries: readonly LogEntry[],
    bytes: number,
    destination: LogDestination,
  ): void {
    this.queue.release(entries);
    this.destinationHealth.delete(destination.key);
    this.statsValue.batchesWritten += 1;
    this.statsValue.bytesWritten += bytes;
    this.statsValue.lastFlushAt = this.now();
    this.maybeEmitDropSummary();
  }

  private onWriteFailure(
    entries: readonly LogEntry[],
    _bytes: number,
    error: unknown,
    destination: LogDestination,
  ): void {
    this.queue.release(entries);
    this.statsValue.writeFailures += 1;
    this.statsValue.lastWriteFailureAt = this.now();
    const health = this.destinationHealth.get(destination.key) ?? {
      consecutiveFailures: 0,
      degradedUntil: 0,
      summarySuppressed: false,
    };
    health.consecutiveFailures += 1;
    health.summarySuppressed = true;
    if (health.consecutiveFailures >= FAILURE_BACKOFF_THRESHOLD) {
      health.degradedUntil = this.now() + FAILURE_BACKOFF_MS;
      health.consecutiveFailures = 0;
    }
    this.destinationHealth.set(destination.key, health);
    for (const entry of entries) {
      this.recordDrop(entry.level, "write_failure", entry.identity, entry.destination);
    }
    this.reportFailure(error, destination);
  }

  private reportFailure(error: unknown, destination: LogDestination): void {
    const current = this.now();
    if (current - this.lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
    this.lastDiagnosticAt = current;
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "write_failed";
    try {
      process.stderr.write(`[bifrost] debug logging degraded (${code}) for ${destination.shared ? "shared file" : "session log"}\n`);
    } catch {
      // Never let diagnostics fail the caller.
    }
  }

  private maybeEmitDropSummary(): void {
    if (this.dropSummaries.size === 0 || this.emittingSummary || this.stopped) return;
    const now = this.now();
    const pending = [...this.dropSummaries.entries()];
    this.emittingSummary = true;
    try {
      for (const [key, summary] of pending) {
        if (this.dropSummaries.get(key) !== summary) continue;
        // A destination must never report its drops through another session's
        // file. Suppression is therefore per destination, not process-wide.
        const health = this.destinationHealth.get(key);
        if (health?.summarySuppressed || (health && now < health.degradedUntil)) continue;
        const counts: Partial<Record<LogLevel, number>> = {};
        for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
          const value = summary.byLevel[level];
          if (value > 0) counts[level] = value;
        }
        const reasons: Partial<Record<DropReason, number>> = {};
        let dominantReason: DropReason = "queue_capacity";
        let dominantCount = 0;
        for (const reason of ["queue_capacity", "oversized", "write_failure", "sink_degraded", "closed"] as const) {
          const value = summary.byReason[reason];
          if (value > 0) reasons[reason] = value;
          if (value > dominantCount) {
            dominantCount = value;
            dominantReason = reason;
          }
        }
        // Bypass the bootstrap stage: each summary belongs to the destination
        // whose events were dropped, even if another session is current now.
        const entry = this.prepare({
          level: "warn",
          retention: retentionFor("warn", true),
          module: "logger",
          event: "events_dropped",
          entryType: "event",
          now: this.date(),
          meta: {
            counts,
            reasons,
            dropped_total: summary.total,
            reason: dominantReason,
          },
        }, summary.identity);
        if (!entry || entry.destination.key !== key) continue;
        // A diagnostic summary must never evict a real event; retry later if
        // the queue is currently full.
        if (!this.queue.tryAdmit(entry)) continue;
        this.adjustPending(key, 1);
        this.dropSummaries.delete(key);
      }
    } finally {
      this.emittingSummary = false;
    }
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
  }

  private maybeSettle(): void {
    if (this.queue.totalEntries > 0 || this.activeWrites.size > 0 || this.pumping) return;
    this.maybeEmitDropSummary();
    if (this.queue.totalEntries > 0 || this.activeWrites.size > 0) return;
    this.pruneIdleSinks();
    this.resolveWaiters();
  }

  /** Session switching creates a sink per run destination; keep that set bounded. */
  private pruneIdleSinks(): void {
    if (this.sinks.size <= MAX_IDLE_SINKS) return;
    const currentKey = this.destinationForIdentity(this.currentIdentity()).key;
    const candidates: Array<{ key: string; sink: LogSink; lastUsed: number }> = [];
    for (const [key, sink] of this.sinks) {
      if (key === currentKey) continue;
      if ((this.pendingByDestination.get(key) ?? 0) > 0) continue;
      if ((this.activeWritesByDestination.get(key) ?? 0) > 0) continue;
      candidates.push({ key, sink, lastUsed: this.sinkLastUsed.get(key) ?? 0 });
    }
    candidates.sort((left, right) => left.lastUsed - right.lastUsed);
    for (const candidate of candidates) {
      if (this.sinks.size <= MAX_IDLE_SINKS) break;
      this.sinks.delete(candidate.key);
      this.sinkLastUsed.delete(candidate.key);
      this.destinationHealth.delete(candidate.key);
      // Drops are best-effort metadata. Once a destination has been idle long
      // enough to prune, its un-emitted summary is discarded with it.
      this.dropSummaries.delete(candidate.key);
      try {
        void Promise.resolve(candidate.sink.close()).catch(() => undefined);
      } catch {
        // A failing idle sink must not destabilize the logger.
      }
    }
  }

  private resolveWaiters(): void {
    for (const waiter of [...this.flushWaiters]) waiter();
  }

  private clearTimers(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
  }
}

