import { debug } from "../debug.ts";
import { saveCostData, generateSessionId } from "./cost-persist.ts";
import { isCostPersistenceEnabled, getCostConfig } from "./cost-config.ts";
import type { CostMetrics, CostTurn, CostBreakdown } from "./cost-types.ts";

const DEFAULT_MAX_HISTORY = 100;

const sessionMetrics = new WeakMap<object, CostMetrics>();
const sessionHistory = new WeakMap<object, CostTurn[]>();
const sessionIds = new WeakMap<object, string>();
const sessionTurnsSinceSave = new WeakMap<object, number>();
const sessionLastSaveTime = new WeakMap<object, number>();

/**
 * Resolve the maximum number of cost turns to retain in memory, based on config.
 */
function maxHistory(): number {
  return getCostConfig().maxHistory ?? DEFAULT_MAX_HISTORY;
}

/**
 * Retrieve the current cost metrics for a given session context.
 */
export function getMetrics(session: object): CostMetrics | undefined {
  return sessionMetrics.get(session);
}

/**
 * Retrieve the bounded history of cost turns for a given session context.
 */
export function getHistory(session: object): CostTurn[] | undefined {
  return sessionHistory.get(session);
}

/**
 * Retrieve the generated session ID for a given session context.
 */
export function getSessionId(session: object): string | undefined {
  return sessionIds.get(session);
}

/**
 * Record a cost turn into the in-memory metrics and bounded history for a session.
 * Updates aggregate totals (input/output/cache read/write/missed tokens) and
 * the ring-buffer history, tracking turns since last checkpoint.
 */
export function recordTurn(session: object, turn: CostTurn): void {
  let metrics = sessionMetrics.get(session);
  if (!metrics) {
    metrics = {
      totalInput: 0,
      totalRead: 0,
      totalWritten: 0,
      totalOutput: 0,
      missedTokens: 0,
      missedCost: 0,
    };
    sessionMetrics.set(session, metrics);
  }
  if (!sessionIds.has(session)) {
    sessionIds.set(session, generateSessionId());
  }

  // Update aggregates
  metrics.totalInput += turn.input + turn.cacheRead;
  metrics.totalRead += turn.cacheRead;
  metrics.totalWritten += turn.cacheWrite;
  metrics.totalOutput += turn.output;
  metrics.missedTokens += turn.missedTokens;
  metrics.missedCost += turn.missedCost;

  // Update last state
  if (turn.promptTokens > 0) {
    metrics.lastPromptTokens = turn.promptTokens;
    metrics.lastModelKey = turn.modelKey;
    metrics.lastTimestamp = turn.timestamp;
    metrics.lastReportedCache = turn.cacheRead + turn.cacheWrite > 0;
  }

  // Update history (ring buffer)
  let history = sessionHistory.get(session);
  if (!history) {
    history = [];
    sessionHistory.set(session, history);
  }
  history.push(turn);
  if (history.length > maxHistory()) {
    history.shift();
  }

  // Track turns since last save
  const currentTurns = (sessionTurnsSinceSave.get(session) ?? 0) + 1;
  sessionTurnsSinceSave.set(session, currentTurns);
}

/**
 * Persist in-memory metrics for a session to disk.
 * No-op unless persistence is enabled via config.
 */
export async function persistSessionCost(session: object, cwd: string): Promise<void> {
  if (!isCostPersistenceEnabled()) {
    debug("cost", "persist_skip", { reason: "persistence_disabled" });
    return;
  }
  const sessionId = sessionIds.get(session);
  const metrics = sessionMetrics.get(session);
  const history = sessionHistory.get(session);
  if (!sessionId || !metrics) {
    debug("cost", "persist_skip", { reason: "missing_session_or_metrics" });
    return;
  }
  const config = getCostConfig();
  debug("cost", "persist_start", { sessionId, path: config.path });
  await saveCostData(cwd, config.path, sessionId, metrics, history ?? [], config.retentionDays);
  
  // Reset save state after successful write
  sessionTurnsSinceSave.set(session, 0);
  sessionLastSaveTime.set(session, Date.now());
  debug("cost", "persist_success", { sessionId, metricKeys: Object.keys(metrics) });
}

/**
 * Checkpoint: returns true when the session has accumulated enough new turns
 * or elapsed time to warrant flushing metrics to disk. No-op when persistence is disabled.
 */
export function shouldCheckpoint(session: object): boolean {
  if (!isCostPersistenceEnabled()) return false;
  const config = getCostConfig();
  const turns = sessionTurnsSinceSave.get(session) ?? 0;
  const lastSave = sessionLastSaveTime.get(session) ?? 0;
  const now = Date.now();

  return (
    turns >= (config.checkpointTurns ?? 25) ||
    (lastSave > 0 && now - lastSave >= (config.checkpointIntervalMs ?? 60000))
  );
}

/**
 * Compute estimated cache-miss tokens and cost for a turn, based on Pi's
 * model: overlap against the previous prompt minus cache read.
 * Uses a noise floor to avoid micro-misses and only estimates cost when
 * the missed tokens exceed the threshold.
 */
export function computeMiss(
  session: object,
  finalCost: any,
  breakdown: CostBreakdown,
): Omit<CostTurn, "timestamp" | "modelKey" | "provider" | "model" | "promptTokens"> {
  const metrics = sessionMetrics.get(session);
  const promptTokens = breakdown.input + breakdown.cacheRead + breakdown.cacheWrite;
  const NOISE_FLOOR_TOKENS = 1024;
  let missedTokens = 0;
  let missedCost = 0;

  if (metrics?.lastPromptTokens) {
    // Pi computes overlap against the previous request's prompt size;
    // tokens that were in the previous prompt but not cache-read now
    // count as re-billed. Model switches re-bill the full prompt.
    missedTokens = Math.max(
      0,
      Math.min(metrics.lastPromptTokens, promptTokens) - breakdown.cacheRead,
    );
    if (missedTokens > NOISE_FLOOR_TOKENS) {
      const paidTokens = breakdown.input + breakdown.cacheWrite;
      const paidPerToken =
        paidTokens > 0
          ? ((finalCost.cost?.input ?? 0) + (finalCost.cost?.cacheWrite ?? 0)) / paidTokens
          : 0;
      const readPerToken =
        breakdown.cacheRead > 0 && finalCost.cost?.cacheRead
          ? finalCost.cost.cacheRead / breakdown.cacheRead
          : 0.00001;
      missedCost = missedTokens * Math.max(0, paidPerToken - readPerToken);
    }
  }

  return {
    missedTokens,
    missedCost,
    input: breakdown.input,
    output: breakdown.output,
    cacheRead: breakdown.cacheRead,
    cacheWrite: breakdown.cacheWrite,
  };
}

/**
 * Build a CostTurn record from a settled assistant message, its cost/usage
 * breakdown, and a computed cache-miss estimate.
 */
export function buildTurn(
  session: object,
  msg: any,
  finalCost: any,
  breakdown: CostBreakdown,
): CostTurn {
  const miss = computeMiss(session, finalCost, breakdown);
  return {
    timestamp: msg.timestamp ? Date.parse(msg.timestamp) : Date.now(),
    modelKey: msg.provider && msg.model ? `${msg.provider}/${msg.model}` : undefined,
    provider: msg.provider,
    model: msg.model,
    promptTokens: breakdown.input + breakdown.cacheRead + breakdown.cacheWrite,
    ...miss,
    cost: finalCost,
  };
}

const pendingMicrotasks = new WeakSet<object>();

/**
 * Asynchronously record a cost turn off the hot path via a microtask,
 * to avoid blocking event processing.
 */
export function recordTurnAsync(session: object, turn: CostTurn): void {
  pendingMicrotasks.add(session);
  queueMicrotask(() => {
    recordTurn(session, turn);
    pendingMicrotasks.delete(session);
  });
}

/**
 * Wait for all pending asynchronous cost turns for a session to flush
 * before persistence, so no metrics are lost on shutdown.
 */
export function flushPendingTurns(session: object): Promise<void> {
  return new Promise((resolve) => {
    if (!pendingMicrotasks.has(session)) {
      resolve();
      return;
    }
    queueMicrotask(() => resolve());
  });
}
