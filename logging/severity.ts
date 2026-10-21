// ── Severity, record shaping, and redaction ───────────────────────
// Filtering and record construction stay cheap: no recursive traversal of
// arbitrary metadata, no work for filtered events.

import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  type LogIdentity,
  type LogLevel,
} from "./types.ts";

const RANK: Readonly<Record<LogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  return isLogLevel(value) ? value : fallback;
}

export function levelRank(level: LogLevel): number {
  return RANK[level];
}

/** Higher retention survives overflow longer. Protected events rank above peers. */
export function retentionFor(level: LogLevel, protectedEvent: boolean): number {
  return RANK[level] * 2 + (protectedEvent ? 1 : 0);
}

export function shouldEmit(minimum: LogLevel, level: LogLevel): boolean {
  return RANK[level] >= RANK[minimum];
}

// Ownership and record identity are reserved. Process correlation is applied
// separately and cannot be overwritten by metadata; per-request correlation
// identifiers stay writable because session-aware callers supply them.
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const RESERVED_BASE = new Set([
  "ts", "level", "module", "event", "entryType", "duration_ms", "_meta_error",
  "root_session_id", "session_id", "run_id", "agent_id", "parent_agent_id", "process_id",
  ...DANGEROUS_KEYS,
]);

// Top-level channels that could carry raw user or provider text. Primitive
// counters stay (for example the probe report's numeric `error` count), while
// strings and structured values are dropped before serialization.
const SENSITIVE_KEYS = new Set([
  "prompt", "prompts", "message", "messages", "content", "response", "responsebody",
  "request", "requestbody", "body", "apikey", "api_key", "authorization", "secret",
  "credentials", "endpoint", "url", "error", "errortext", "errormessage", "stack",
  "criteria", "systemprompt", "token", "accesstoken", "access_token",
  "refreshtoken", "refresh_token", "password", "output", "input", "text",
  "stderr", "stdout", "detail", "providererror", "provider_error", "errorcode",
  "error_code", "stacktrace",
]);

// Nested metadata is untrusted. Traversal is deliberately shallow and node
// bounded so a hostile object cannot turn logging into unbounded work.
// Deep enough for routing diagnostics such as
// meta.decision.attempted[].candidates[].reserve.reasons[], while still
// bounding hostile input.
const MAX_META_DEPTH = 8;
const MAX_META_NODES = 256;
const MAX_META_KEYS = 64;
const MAX_META_CHARS = 128 * 1024;
const TRUNCATED = "[truncated]";
const CIRCULAR = "[circular]";

interface SanitizeState {
  nodes: number;
  chars: number;
  readonly ancestors: WeakSet<object>;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function isSkippedNestedKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key) || key.toLowerCase() === "tojson";
}

function safeDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function safeOwnKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return [];
  }
}

function noteNode(state: SanitizeState): boolean {
  state.nodes += 1;
  return state.nodes <= MAX_META_NODES;
}

function sanitizePrimitiveOrDrop(key: string, value: unknown): { keep: boolean; value?: unknown } {
  if (isSensitiveKey(key)) {
    const sensitiveString = typeof value === "string" && value.length > 0;
    const sensitiveStructure = value !== null && typeof value === "object";
    if (sensitiveString || sensitiveStructure) return { keep: false };
  }
  return { keep: true, value };
}

function sanitizeValue(value: unknown, depth: number, state: SanitizeState, countNode = true): unknown {
  if (countNode && !noteNode(state)) return TRUNCATED;
  if (value === null) return null;
  if (typeof value === "string") {
    const remaining = MAX_META_CHARS - state.chars;
    if (value.length <= remaining) {
      state.chars += value.length;
      return value;
    }
    state.chars = MAX_META_CHARS;
    return `${value.slice(0, Math.max(0, remaining))}${TRUNCATED}`;
  }
  if (typeof value !== "object") return value;

  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    return TRUNCATED;
  }
  if (array) {
    if (depth >= MAX_META_DEPTH) return TRUNCATED;
    if (state.ancestors.has(value as object)) return CIRCULAR;
    state.ancestors.add(value as object);
    const output: unknown[] = [];
    try {
      const source = value as unknown[];
      for (let index = 0; index < source.length; index += 1) {
        // Arrays may be sparse or have accessor elements. Count every visited
        // slot so holes cannot bypass the node budget and materialize a huge
        // output array. The slot itself represents the child node.
        if (!noteNode(state)) {
          output.push(TRUNCATED);
          break;
        }
        const descriptor = safeDescriptor(source, String(index));
        if (!descriptor || !descriptor.enumerable) {
          output.push(null);
          continue;
        }
        if (!("value" in descriptor)) {
          output.push(TRUNCATED);
          continue;
        }
        output.push(sanitizeValue(descriptor.value, depth + 1, state, false));
      }
    } finally {
      state.ancestors.delete(value as object);
    }
    return output;
  }

  if (state.ancestors.has(value as object)) return CIRCULAR;
  // Dates are legitimate diagnostics and have no enumerable data properties.
  try {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? null : value.toISOString();
    }
  } catch {
    return TRUNCATED;
  }
  if (depth >= MAX_META_DEPTH) return TRUNCATED;

  state.ancestors.add(value as object);
  const clean: Record<string, unknown> = {};
  try {
    let kept = 0;
    for (const key of safeOwnKeys(value as object)) {
      if (typeof key !== "string") continue;
      if (kept >= MAX_META_KEYS || state.nodes >= MAX_META_NODES) break;
      if (isSkippedNestedKey(key)) continue;
      const descriptor = safeDescriptor(value as object, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) continue;
      const decision = sanitizePrimitiveOrDrop(key, descriptor.value);
      if (!decision.keep) continue;
      clean[key] = sanitizeValue(descriptor.value, depth + 1, state);
      kept += 1;
    }
  } finally {
    state.ancestors.delete(value as object);
  }
  return clean;
}

/**
 * Returns a bounded, plain-data copy of metadata. Reserved ownership fields are
 * removed, sensitive channels are dropped at every depth, accessors and
 * `toJSON` are never executed, and circular or oversized structures degrade to
 * markers instead of throwing or growing without bound.
 */
export function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const state: SanitizeState = { nodes: 0, chars: 0, ancestors: new WeakSet() };
  const clean: Record<string, unknown> = {};
  let kept = 0;
  state.ancestors.add(meta);
  try {
    for (const key of safeOwnKeys(meta)) {
      if (typeof key !== "string") continue;
      if (kept >= MAX_META_KEYS) break;
      if (RESERVED_BASE.has(key) || key.toLowerCase() === "tojson") continue;
      const descriptor = safeDescriptor(meta, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) continue;
      const decision = sanitizePrimitiveOrDrop(key, descriptor.value);
      if (!decision.keep) continue;
      clean[key] = sanitizeValue(descriptor.value, 0, state);
      kept += 1;
    }
  } finally {
    state.ancestors.delete(meta);
  }
  return clean;
}

export interface BuildRecordInput {
  readonly now: Date;
  readonly module: string;
  readonly event: string;
  readonly entryType: "event" | "measure";
  readonly level: LogLevel;
  readonly identity: LogIdentity;
  readonly correlation: Readonly<Record<string, string>>;
  readonly meta: Record<string, unknown> | undefined;
  readonly durationMs?: number;
  readonly metaError?: string;
}

export function buildRecord(input: BuildRecordInput): Record<string, unknown> {
  const clean = sanitizeMeta(input.meta);
  // Process correlation is authoritative; metadata may supply per-request
  // correlation (request_correlation_id) but cannot spoof a process id.
  for (const key of Object.keys(input.correlation)) delete clean[key];
  // Base and correlation fields first so metadata key order stays stable for
  // existing consumers; ownership fields are appended and cannot be overridden.
  const record: Record<string, unknown> = {
    ts: input.now.toISOString(),
    module: input.module,
    event: input.event,
    entryType: input.entryType,
    ...input.correlation,
    ...clean,
  };
  if (input.entryType === "measure" && input.durationMs !== undefined) {
    record.duration_ms = input.durationMs;
  }
  if (input.metaError !== undefined) record._meta_error = input.metaError;
  record.level = input.level;
  record.root_session_id = input.identity.rootSessionId;
  record.session_id = input.identity.sessionId;
  record.run_id = input.identity.runId;
  record.process_id = input.identity.processId;
  if (input.identity.agentId !== undefined) record.agent_id = input.identity.agentId;
  if (input.identity.parentAgentId !== undefined) record.parent_agent_id = input.identity.parentAgentId;
  return record;
}

export interface SerializedLine {
  readonly line: string;
  readonly bytes: number;
}

/**
 * Serialize one record. Returns null when the record exceeds the per-entry cap,
 * so callers can count a bounded rejection instead of retaining a huge string.
 * Serialization failures fall back to a metadata-free record.
 */
export function serializeRecord(
  record: Record<string, unknown>,
  maxEntryBytes: number,
): SerializedLine | null {
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    try {
      const fallback: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (DANGEROUS_KEYS.has(key) || key.toLowerCase() === "tojson") continue;
        const value = record[key];
        if (isSensitiveKey(key)
          && (typeof value === "string" || (value !== null && typeof value === "object"))) {
          continue;
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
          fallback[key] = value;
        }
      }
      fallback._meta_error = "unserializable";
      line = `${JSON.stringify(fallback)}\n`;
    } catch {
      return null;
    }
  }
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > maxEntryBytes) return null;
  return { line, bytes };
}
