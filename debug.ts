// ── Structured debug logging (public facade) ──────────────────────
// Configuration-first, best-effort diagnostics. The routing hot path never
// performs filesystem I/O and never waits for logging capacity.
//
// An explicit path writes one shared file:
//   { "debug": { "enabled": true, "path": ".pi/bifrost-debug.jsonl" } }
// Without an explicit path, logs are session-scoped:
//   .pi/bifrost/logs/<root-session>/main/<run>.jsonl
//   .pi/bifrost/logs/<root-session>/subagents/<agent>/<run>.jsonl

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  UNATTRIBUTED_SESSION,
  createProcessIdentity,
  resolveDebugConfig,
} from "./logging/context.ts";
import { BifrostLogger } from "./logging/logger.ts";
import type { LoggerStats } from "./logging/types.ts";
import type {
  DebugConfig,
  DebugEmitOptions,
  DebugMetaSource,
  LogIdentity,
  LogIdentityHint,
} from "./logging/types.ts";

export type { DebugConfig, DebugEmitOptions, DebugMeta, DebugMetaSource, LogLevel, LoggerStats } from "./logging/types.ts";

export interface DebugSessionLike {
  getHeader?: () => { id?: unknown } | null | undefined;
}

export interface DebugBindOptions {
  rootSessionId?: string;
  agentId?: string;
  parentAgentId?: string;
}

let active: BifrostLogger | null = null;
let activeKey: string | null = null;
let exitHookInstalled = false;
const retiring = new Set<Promise<unknown>>();
const retiringLoggers = new Set<BifrostLogger>();

function headerSessionId(session: DebugSessionLike | undefined): string | undefined {
  try {
    const id = session?.getHeader?.()?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function retire(logger: BifrostLogger): void {
  retiringLoggers.add(logger);
  const tracked = logger.close(250).catch(() => undefined);
  retiring.add(tracked);
  void tracked.finally(() => {
    retiring.delete(tracked);
    retiringLoggers.delete(logger);
  });
}

const noopStop = (_meta?: DebugMetaSource, _options?: DebugEmitOptions): void => {};

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` cannot await asynchronous work. Flush a strictly bounded prefix
  // synchronously; lifecycle hooks above handle the ordinary graceful drain.
  process.on("exit", () => {
    try {
      active?.flushSyncBounded();
      for (const logger of retiringLoggers) logger.flushSyncBounded();
    } catch {
      // Logging never aborts process exit.
    }
  });
}

function configKey(resolved: ReturnType<typeof resolveDebugConfig>, cwd: string): string {
  return JSON.stringify({ cwd, ...resolved });
}

/**
 * Configure the logger. Repeated calls are idempotent for identical config.
 * A changed config retires the previous logger after its accepted events drain;
 * those events keep the destination captured at admission.
 */
export function setupDebug(cfg: DebugConfig, cwd: string): void {
  const resolved = resolveDebugConfig(cfg, cwd);
  const key = configKey(resolved, cwd);
  if (active && activeKey === key) return;

  const previous = active;
  active = null;
  activeKey = null;

  if (resolved.enabled) {
    try {
      mkdirSync(resolved.sharedPath ? dirname(resolved.sharedPath) : resolved.directory, {
        recursive: true,
        mode: 0o700,
      });
    } catch {
      try {
        process.stderr.write("[bifrost] debug directory unavailable\n");
      } catch {
        // Ignore stderr failures.
      }
      if (previous) retire(previous);
      return;
    }

    const logger = new BifrostLogger({
      config: resolved,
      identity: createProcessIdentity(),
    });
    const carried = previous?.currentIdentity();
    if (carried && carried.rootSessionId !== UNATTRIBUTED_SESSION) {
      logger.bindSession({
        sessionId: carried.sessionId,
        rootSessionId: carried.rootSessionId,
        ...(carried.agentId ? { agentId: carried.agentId } : {}),
        ...(carried.parentAgentId ? { parentAgentId: carried.parentAgentId } : {}),
      });
    }
    active = logger;
    activeKey = key;
    installExitHook();
  }

  if (previous) retire(previous);
}

/** Associate the current process with a Pi session. Safe when logging is off. */
export function bindDebugSession(session: DebugSessionLike | undefined, options?: DebugBindOptions): void {
  if (!active) return;
  const id = headerSessionId(session);
  if (!id) return;
  try {
    active.bindSession({ sessionId: id, ...options });
  } catch {
    // Diagnostics must never affect the host session lifecycle.
  }
}

/**
 * Configure logging and restore the binding for the session that requested the
 * reload. A reload can enable logging without another session_start event.
 */
export function setupDebugForSession(cfg: DebugConfig, cwd: string, session?: DebugSessionLike): void {
  setupDebug(cfg, cwd);
  bindDebugSession(session);
}

/** Return subsequent contextless events to the process fallback. */
export function endDebugSession(session?: DebugSessionLike): void {
  if (!active) return;
  if (session) {
    const id = headerSessionId(session);
    if (!id) return;
    // One process can host several sessions. Never clear another session's
    // binding because a different session shut down.
    if (active.currentIdentity().sessionId !== id) return;
  }
  active.endSession();
}

/** Whether structured logging is enabled for the current setup. */
export function isDebugEnabled(): boolean {
  return active?.enabled ?? false;
}

/** Log a discrete event. Async — serialized and queued, never awaited. */
export function debug(
  module: string,
  event: string,
  meta?: DebugMetaSource,
  options?: DebugEmitOptions,
): void {
  try {
    active?.emit(module, event, meta, options);
  } catch {
    // Diagnostics must never affect routing or the caller.
  }
}

/**
 * Start a performance measure. Durations use the monotonic clock, so
 * overlapping measurements with the same name remain independent. Ownership
 * is captured when the measurement starts, so a later session switch or config
 * reload cannot attribute the result to unrelated work.
 */
export function debugMeasure(
  module: string,
  event: string,
  options?: DebugEmitOptions,
): (meta?: DebugMetaSource, stopOptions?: DebugEmitOptions) => void {
  const logger = active;
  const initialLevel = options?.level ?? "debug";
  if (!logger?.accepts(initialLevel)) return noopStop;
  const startedAt = performance.now();
  const identity = options?.identity ?? identityHintFor(logger.currentIdentity());
  return (meta?: DebugMetaSource, stopOptions?: DebugEmitOptions) => {
    const level = stopOptions?.level ?? options?.level ?? "debug";
    // Use the logger that accepted the start, not whatever is active now.
    // A retired logger rejects new work, so a measurement that outlives a
    // reload is dropped rather than written to the replacement run.
    if (!logger.accepts(level)) return;
    const protectedEvent = stopOptions?.protected ?? options?.protected;
    try {
      logger.emit(
        module,
        event,
        meta,
        {
          level,
          identity,
          ...(protectedEvent ? { protected: true } : {}),
        },
        "measure",
        performance.now() - startedAt,
      );
    } catch {
      // Diagnostics must never affect the measured operation.
    }
  };
}

function identityHintFor(identity: LogIdentity): LogIdentityHint {
  return {
    sessionId: identity.sessionId,
    rootSessionId: identity.rootSessionId,
    ...(identity.agentId ? { agentId: identity.agentId } : {}),
    ...(identity.parentAgentId ? { parentAgentId: identity.parentAgentId } : {}),
  };
}

/** Best-effort bounded drain for awaited host shutdown hooks. */
export async function flushDebug(timeoutMs = 250): Promise<void> {
  const logger = active;
  const pending: Promise<unknown>[] = [...retiring];
  if (logger) {
    try {
      pending.push(logger.flush(timeoutMs));
    } catch {
      // A synchronous logger failure must not block host shutdown.
    }
  }
  if (pending.length === 0) return;
  const budget = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 0), 5_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budget);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Internal health snapshot. Returns null when logging is disabled. */
export function debugLoggerStats(): LoggerStats | null {
  return active?.stats() ?? null;
}

/** Current default identity, for tests and diagnostics. */
export function debugLoggerIdentity(): LogIdentity | null {
  return active?.currentIdentity() ?? null;
}
