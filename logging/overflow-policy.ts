// ── Overflow policies ─────────────────────────────────────────────
// Policies choose victims; the queue performs eviction. Severity-first never
// evicts a higher-retention entry to admit a lower-retention one and avoids
// sorting the queue (retention values are small and bounded).

import {
  DEFAULT_OVERFLOW_POLICY,
  OVERFLOW_POLICIES,
  type LogEntry,
  type OverflowPolicyName,
} from "./types.ts";
import type { QueueView } from "./bounded-queue.ts";

export interface OverflowDecision {
  readonly accept: boolean;
  readonly evict: readonly LogEntry[];
}

export interface OverflowPolicy {
  readonly name: OverflowPolicyName;
  select(incoming: LogEntry, queue: QueueView): OverflowDecision;
}

const REJECT: OverflowDecision = { accept: false, evict: [] };

const dropNewest: OverflowPolicy = {
  name: "drop-newest",
  select: () => REJECT,
};

const dropOldest: OverflowPolicy = {
  name: "drop-oldest",
  select(incoming, queue) {
    if (queue.length === 0) return REJECT;
    const evict: LogEntry[] = [];
    let freed = 0;
    const needed = queue.totalBytes + incoming.bytes - queue.maxBytes;
    for (let index = 0; index < queue.length; index += 1) {
      if (freed >= needed && evict.length > 0) break;
      const entry = queue.entryAt(index);
      if (!entry) break;
      evict.push(entry);
      freed += entry.bytes;
    }
    if (evict.length === 0 || freed < needed) return REJECT;
    return { accept: true, evict };
  },
};

const severityFirst: OverflowPolicy = {
  name: "severity-first",
  select(incoming, queue) {
    if (queue.length === 0) return REJECT;
    const needed = queue.totalBytes + incoming.bytes - queue.maxBytes;
    // Fast path for sustained uniform load: evict the oldest eligible entry,
    // which is all that byte or entry-count pressure usually requires.
    const head = queue.entryAt(0);
    if (head
      && head.retention === queue.minRetention
      && head.retention <= incoming.retention
      && (needed <= 0 || needed <= head.bytes)) {
      return { accept: true, evict: [head] };
    }
    // Bucket eligible entries by retention. The bucket count is small (ten at
    // most), so selection is linear with no full sort.
    const buckets = new Map<number, LogEntry[]>();
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue.entryAt(index);
      if (!entry || entry.retention > incoming.retention) continue;
      const bucket = buckets.get(entry.retention);
      if (bucket) bucket.push(entry);
      else buckets.set(entry.retention, [entry]);
    }
    if (buckets.size === 0) return REJECT;
    const ranks = [...buckets.keys()].sort((a, b) => a - b);
    const evict: LogEntry[] = [];
    let freed = 0;
    let rankIndex = 0;
    let offset = 0;
    while (rankIndex < ranks.length) {
      if (evict.length > 0 && freed >= needed) break;
      const bucket = buckets.get(ranks[rankIndex]!)!;
      while (offset < bucket.length) {
        const entry = bucket[offset]!;
        offset += 1;
        evict.push(entry);
        freed += entry.bytes;
        if (evict.length > 0 && freed >= needed) break;
      }
      if (offset >= bucket.length) {
        rankIndex += 1;
        offset = 0;
      }
    }
    if (evict.length === 0 || freed < needed) return REJECT;
    return { accept: true, evict };
  },
};

const REGISTRY = new Map<OverflowPolicyName, OverflowPolicy>([
  [dropNewest.name, dropNewest],
  [dropOldest.name, dropOldest],
  [severityFirst.name, severityFirst],
]);

export function isOverflowPolicyName(value: unknown): value is OverflowPolicyName {
  return typeof value === "string" && (OVERFLOW_POLICIES as readonly string[]).includes(value);
}

export function resolveOverflowPolicy(name: string | undefined): OverflowPolicy {
  if (isOverflowPolicyName(name)) return REGISTRY.get(name) ?? severityFirst;
  return REGISTRY.get(DEFAULT_OVERFLOW_POLICY) ?? severityFirst;
}
