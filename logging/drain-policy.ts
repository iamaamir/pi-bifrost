// ── Drain policy ──────────────────────────────────────────────────
// Draining decides when accepted entries are persisted. It is deliberately
// independent of overflow: capacity chooses what survives, batching chooses
// when surviving entries reach the sink.

import type { ResolvedDebugConfig } from "./types.ts";

export interface DrainPolicy {
  readonly intervalMs: number;
  readonly maxBatchBytes: number;
  readonly maxBatchEntries: number;
  /** Whether the pending queue has reached a size that justifies an early flush. */
  shouldDrainNow(pendingBytes: number, pendingEntries: number): boolean;
}

export function createDrainPolicy(config: ResolvedDebugConfig): DrainPolicy {
  const { intervalMs, maxBatchBytes, maxBatchEntries } = config.drain;
  return {
    intervalMs,
    maxBatchBytes,
    maxBatchEntries,
    shouldDrainNow: (pendingBytes, pendingEntries) =>
      pendingBytes >= maxBatchBytes || pendingEntries >= maxBatchEntries,
  };
}
