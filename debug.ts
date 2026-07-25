// ── Structured debug logging with Performance API ──────────────────
// Buffered async writes. No sync I/O on the hot path — events are
// queued in memory and flushed via setImmediate. On process exit the
// remaining buffer is flushed synchronously.
//
// Configure: { "debug": { "enabled": true, "path": ".pi/bifrost-debug.jsonl" } }

import { existsSync, mkdirSync } from "node:fs";
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

// ── Async write buffer ────────────────────────────────────────────

let buffer: string[] = [];
let flushScheduled = false;
let flushing = false;

async function rotateIfNeeded(): Promise<void> {
  if (!debugPath) return;
  try {
    const info = await stat(debugPath).catch(() => null);
    if (info && info.size > maxSizeBytes) {
      await rename(debugPath, debugPath.replace(/\.jsonl$/, ".old.jsonl")).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function flushBuffer(): Promise<void> {
  // Write lock: only one flush runs at a time. Prevents interleaved
  // appendFile calls that would corrupt JSONL.
  if (flushing) return;
  flushing = true;
  flushScheduled = false;

  while (buffer.length > 0 && debugPath) {
    const lines = buffer.join("\n") + "\n";
    buffer = [];
    try {
      await rotateIfNeeded();
      await appendFile(debugPath, lines, "utf-8");
    } catch (err) {
      try {
        process.stderr.write(`[bifrost] debug write failed: ${err}\n`);
      } catch { /* silence */ }
    }
  }

  flushing = false;
  // New entries may have arrived during the await.
  if (buffer.length > 0) scheduleFlush();
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
    appendFileSync(debugPath, lines, "utf-8");
  } catch { /* silence */ }
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

  if (debugEnabled && !startupDone) {
    startupDone = true;
    try {
      const dir = dirname(debugPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (err) {
      process.stderr.write(`[bifrost] debug: cannot create log dir: ${err}\n`);
      debugEnabled = false;
      return;
    }

    // Flush remaining on exit (sync — exit hook cannot do async I/O).
    process.on("exit", () => {
      buffer.push(JSON.stringify({ ts: new Date().toISOString(), module: "bifrost", event: "shutdown", entryType: "event" }));
      flushSync();
    });
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
    buffer.push(JSON.stringify({ ts: new Date().toISOString(), module, event, entryType: "event", ...meta }));
  } catch {
    buffer.push(JSON.stringify({ ts: new Date().toISOString(), module, event, entryType: "event", _meta_error: "unserializable" }));
  }
  scheduleFlush();
}

/**
 * Start a performance measure. Returns a stop function that records
 * a measure entry via the Performance API. Async — queued like debug().
 */
export function debugMeasure(module: string, event: string) {
  if (!debugEnabled) return (_meta?: Record<string, unknown>) => {};
  const name = `bifrost:${module}:${event}`;
  performance.mark(`${name}:start`);
  return (meta?: Record<string, unknown>) => {
    try {
      performance.mark(`${name}:end`);
      performance.measure(name, `${name}:start`, `${name}:end`);
      const entry = performance.getEntriesByName(name, "measure")[0];
      if (entry) {
        const data: Record<string, unknown> = {
          ts: new Date().toISOString(),
          module,
          event,
          entryType: "measure",
          duration_ms: +entry.duration.toFixed(3),
          ...meta,
        };
        try {
          buffer.push(JSON.stringify(data));
        } catch {
          buffer.push(JSON.stringify({ ...data, _meta_error: "unserializable" }));
        }
      }
    } finally {
      performance.clearMarks(`${name}:start`);
      performance.clearMarks(`${name}:end`);
      performance.clearMeasures(name);
    }
    scheduleFlush();
  };
}
