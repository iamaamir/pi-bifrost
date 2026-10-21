// ── Logging types ─────────────────────────────────────────────────
// Shared, dependency-free vocabulary for the bounded logging pipeline.
// The public surface stays in debug.ts; these types are internal.

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "debug";

export const OVERFLOW_POLICIES = ["severity-first", "drop-oldest", "drop-newest"] as const;
export type OverflowPolicyName = (typeof OVERFLOW_POLICIES)[number];
export const DEFAULT_OVERFLOW_POLICY: OverflowPolicyName = "severity-first";

export const MAX_ENTRY_BYTES = 64 * 1024;
export const DEFAULT_MAX_ENTRIES = 1_000;
export const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;
export const DEFAULT_FLUSH_INTERVAL_MS = 50;
export const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
export const DEFAULT_MAX_BATCH_ENTRIES = 256;
export const DEFAULT_MAX_FILE_SIZE_MB = 10;
export const DEFAULT_ROTATED_FILES = 3;
export const DEFAULT_DIRECTORY = ".pi/bifrost/logs";
export const DEFAULT_SHARED_PATH = ".pi/bifrost-debug.jsonl";
export const FAILURE_BACKOFF_MS = 30_000;

export interface DebugQueueConfig {
  /** Maximum number of admitted entries, including in-flight writes. */
  maxEntries?: number;
  /** Maximum admitted payload bytes, including in-flight writes. */
  maxBytes?: number;
  overflowPolicy?: OverflowPolicyName;
}

export interface DebugDrainConfig {
  /** Batching interval. */
  intervalMs?: number;
  /** Bytes that trigger an early flush. */
  maxBatchBytes?: number;
}

export interface DebugSinkConfig {
  type?: "async-file";
  maxFileSizeMB?: number;
  /** Number of rotated files retained per run file. `0` disables rotation. */
  rotatedFiles?: number;
}

export interface DebugConfig {
  enabled?: boolean;
  /** Explicit shared-file destination. When set, it wins over session scoping. */
  path?: string;
  level?: LogLevel;
  /** `session` is the default. `file` uses the shared default file path. */
  scope?: "session" | "file";
  directory?: string;
  queue?: DebugQueueConfig;
  drain?: DebugDrainConfig;
  sink?: DebugSinkConfig;
}

export interface ResolvedDebugConfig {
  readonly enabled: boolean;
  /** Absolute shared-file destination, or null for session-scoped storage. */
  readonly sharedPath: string | null;
  readonly level: LogLevel;
  /** Absolute session-scoped logging root. */
  readonly directory: string;
  readonly queue: {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly overflowPolicy: OverflowPolicyName;
  };
  readonly drain: {
    readonly intervalMs: number;
    readonly maxBatchBytes: number;
    readonly maxBatchEntries: number;
  };
  readonly sink: {
    readonly maxFileSizeBytes: number;
    readonly rotatedFiles: number;
  };
}

/** Logical ownership of a physical log destination. */
export interface LogIdentity {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly processId: number;
}

/** Session-aware call sites can override the default identity. */
export interface LogIdentityHint {
  readonly sessionId?: string;
  readonly rootSessionId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
}

export interface LogDestination {
  /** Stable map key. */
  readonly key: string;
  /** Absolute file path. */
  readonly path: string;
  /** Shared single-file destination used by explicit `debug.path` configs. */
  readonly shared: boolean;
  /**
   * Session-scoped logging root. Present only when writes must remain inside
   * the configured root; explicit legacy shared paths leave this undefined.
   */
  readonly root?: string;
}

export interface LogEntry {
  readonly id: number;
  readonly level: LogLevel;
  /** Higher values survive overflow longer. Derived from level and protection. */
  readonly retention: number;
  readonly destination: LogDestination;
  /** Source ownership captured at admission; summaries and failures use it. */
  readonly identity: LogIdentity;
  /** Prerendered JSONL line, including the trailing newline. */
  readonly line: string;
  readonly bytes: number;
}

export interface LogSink {
  /** Serialize writes internally. Resolve when the batch is appended or failed. */
  write(batch: readonly LogEntry[]): Promise<void>;
  /** Wait for all writes accepted by this sink. */
  flush(): Promise<void>;
  /** Stop accepting work and wait for accepted writes. */
  close(): Promise<void>;
}

export type DropReason = "queue_capacity" | "oversized" | "write_failure" | "sink_degraded" | "closed";

export interface LoggerStats {
  readonly queuedEntries: number;
  readonly queuedBytes: number;
  readonly inFlightEntries: number;
  readonly inFlightBytes: number;
  readonly droppedTotal: number;
  readonly droppedBySeverity: Readonly<Record<LogLevel, number>>;
  readonly droppedByReason: Readonly<Record<DropReason, number>>;
  readonly evictionsTotal: number;
  readonly batchesWritten: number;
  readonly bytesWritten: number;
  readonly writeFailures: number;
  readonly largestQueuedEntries: number;
  readonly largestQueuedBytes: number;
  readonly lastFlushAt: number | null;
  readonly lastWriteFailureAt: number | null;
  readonly openSinks: number;
}

export interface DebugEmitOptions {
  level?: LogLevel;
  identity?: LogIdentityHint;
  /** Elevate retention for lifecycle/reliability boundaries. */
  protected?: boolean;
}

export type DebugMeta = Record<string, unknown>;
export type DebugMetaSource = DebugMeta | (() => DebugMeta | undefined | null);
