// ── Structured debug logging with Performance API ──────────────────
// Buffered async writes. No sync I/O on the hot path — events are
// queued in memory and flushed via setImmediate. On process exit the
// remaining buffer is flushed synchronously.
//
// Configure: { "debug": { "enabled": true, "path": ".pi/bifrost-debug.jsonl" } }

import { mkdirSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { appendFileSync } from "node:fs";

export interface DebugConfig {
  enabled?: boolean;
  path?: string;
}

const DEFAULT_MAX_SIZE_MB = 10;

let debugEnabled = false;
let debugPath: string | null = null;
const maxSizeBytes: number = DEFAULT_MAX_SIZE_MB * 1024 * 1024;
let startupDone = false;
const patternRunId = process.env.BIFROST_PATTERN_RUN_ID;
const subagentRunId = process.env.PI_SUBAGENT_RUN_ID;
const runCorrelation = {
  ...(patternRunId ? { pattern_run_id: patternRunId } : {}),
  ...(subagentRunId ? { subagent_run_id: subagentRunId } : {}),
};

// ── Async write buffer ────────────────────────────────────────────

let buffer: string[] = [];
let flushScheduled = false;
let flushing = false;
let activeFlush: Promise<void> | undefined;

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const info = await stat(path).catch(() => null);
    if (info && info.size > maxSizeBytes) {
      const rotatedPath = path.endsWith(".jsonl")
        ? path.slice(0, -".jsonl".length) + ".old.jsonl"
        : `${path}.old`;
      await rename(path, rotatedPath).catch(() => {});
    }
  } catch { /* ignore */ }
}

function startFlush(): Promise<void> {
  if (activeFlush) return activeFlush;
  flushing = true;
  flushScheduled = false;
  activeFlush = (async () => {
    while (buffer.length > 0 && debugPath) {
      const destination = debugPath;
      const lines = buffer.join("\n") + "\n";
      buffer = [];
      try {
        await rotateIfNeeded(destination);
        await appendFile(destination, lines, { encoding: "utf-8", flag: "a", mode: 0o600 });
      } catch {
        try { process.stderr.write("[bifrost] debug write failed\n"); } catch { /* silence */ }
      }
    }
  })().finally(() => {
    flushing = false;
    activeFlush = undefined;
    if (buffer.length > 0) scheduleFlush();
  });
  return activeFlush;
}

function flushBuffer(): void {
  void startFlush();
}

function scheduleFlush(): void {
  if (!flushScheduled && !flushing) {
    flushScheduled = true;
    setImmediate(flushBuffer);
  }
  // If already flushing, the running flush will drain the buffer
  // and re-schedule if more entries arrive.
}

/** Synchronous flush for process.exit (must be sync). */
function flushSync(): void {
  if (buffer.length === 0 || !debugPath) return;
  const lines = buffer.join("\n") + "\n";
  buffer = [];
  try {
    appendFileSync(debugPath, lines, { encoding: "utf-8", flag: "a", mode: 0o600 });
  } catch { /* silence */ }
}

/** Whether structured logging is enabled for the current setup. */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/** Best-effort bounded drain for awaited host shutdown hooks. */
export async function flushDebug(timeoutMs = 250): Promise<void> {
  if (!debugEnabled || !debugPath || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
  const deadline = performance.now() + Math.min(timeoutMs, 5_000);
  while (debugEnabled && debugPath && (buffer.length > 0 || flushing || flushScheduled)) {
    if (!activeFlush && buffer.length > 0) void startFlush();
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    const pending = activeFlush;
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); })]);
      if (timer !== undefined) clearTimeout(timer);
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(5, remaining)));
    }
  }
}

// ── Setup ─────────────────────────────────────────────────────────

export function setupDebug(cfg: DebugConfig, cwd: string) {
  debugEnabled = cfg.enabled ?? false;
  if (cfg.path) {
    debugPath = cfg.path.startsWith("/") || cfg.path.startsWith("~")
      ? cfg.path.replace(/^~/, process.env.HOME ?? "/tmp")
      : `${cwd}/${cfg.path}`;
  } else {
    debugPath = `${cwd}/.pi/bifrost-debug.jsonl`;
  }

  if (debugEnabled) {
    try {
      const dir = dirname(debugPath);
      mkdirSync(dir, { recursive: true });
    } catch {
      try { process.stderr.write("[bifrost] debug directory unavailable\n"); } catch { /* silence */ }
      debugEnabled = false;
      return;
    }

    if (!startupDone) {
      startupDone = true;
      // Flush remaining on exit (sync — exit hook cannot do async I/O).
      process.on("exit", () => {
        if (!debugEnabled || !debugPath) return;
        buffer.push(JSON.stringify({ ts: new Date().toISOString(), module: "bifrost", event: "shutdown", entryType: "event", ...runCorrelation }));
        flushSync();
      });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────

/** Log a discrete event. Async — queued and flushed via setImmediate. */
export function debug(
  module: string,
  event: string,
  meta?: Record<string, unknown>,
) {
  if (!debugEnabled) return;
  try {
    buffer.push(JSON.stringify({ ts: new Date().toISOString(), module, event, entryType: "event", ...runCorrelation, ...meta }));
  } catch {
    buffer.push(JSON.stringify({ ts: new Date().toISOString(), module, event, entryType: "event", ...runCorrelation, _meta_error: "unserializable" }));
  }
  scheduleFlush();
}

/**
 * Start a performance measure. Returns a stop function that records
 * a measure entry via the Performance API. Async — queued like debug().
 */
export function debugMeasure(module: string, event: string) {
  if (!debugEnabled) return (_meta?: Record<string, unknown>) => {};
  const startedAt = performance.now();
  return (meta?: Record<string, unknown>) => {
    if (!debugEnabled) return;
    try {
      const data: Record<string, unknown> = {
        ts: new Date().toISOString(),
        module,
        event,
        entryType: "measure",
        ...runCorrelation,
        duration_ms: +(performance.now() - startedAt).toFixed(3),
        ...meta,
      };
      try {
        buffer.push(JSON.stringify(data));
      } catch {
        buffer.push(JSON.stringify({
          ts: data.ts,
          module,
          event,
          entryType: "measure",
          ...runCorrelation,
          duration_ms: data.duration_ms,
          _meta_error: "unserializable",
        }));
      }
    } catch { /* logging never interrupts routing */ }
    scheduleFlush();
  };
}
