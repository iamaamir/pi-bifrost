// ── Bounded queue ─────────────────────────────────────────────────
// One queue per logger process. Pending and in-flight entries count against
// the same entry and byte budgets, so a slow sink cannot grow memory without
// bound. The queue owns all mutations; overflow policies only select victims.

import type { LogEntry } from "./types.ts";
import type { OverflowPolicy } from "./overflow-policy.ts";

export interface QueueView {
  readonly length: number;
  /** Total admitted entries/bytes, including in-flight writes. */
  readonly totalEntries: number;
  readonly totalBytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  /** Lowest retention currently pending, or Infinity when empty. */
  readonly minRetention: number;
  entryAt(index: number): LogEntry | undefined;
}

export interface AdmissionResult {
  readonly accepted: boolean;
  readonly evicted: readonly LogEntry[];
}

export class BoundedQueue {
  private pending: LogEntry[] = [];
  private head = 0;
  private readonly inFlight = new Map<number, LogEntry>();
  private pendingBytesValue = 0;
  private inFlightBytesValue = 0;
  private readonly retentionCounts = new Map<number, number>();
  private minRetentionValue = Number.POSITIVE_INFINITY;
  private largestEntries = 0;
  private largestBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get pendingEntryCount(): number {
    return this.pending.length - this.head;
  }

  get pendingBytes(): number {
    return this.pendingBytesValue;
  }

  get totalEntries(): number {
    return this.pendingEntryCount + this.inFlight.size;
  }

  get totalBytes(): number {
    return this.pendingBytesValue + this.inFlightBytesValue;
  }

  get inFlightEntryCount(): number {
    return this.inFlight.size;
  }

  get inFlightBytes(): number {
    return this.inFlightBytesValue;
  }

  get minRetention(): number {
    return this.minRetentionValue;
  }

  get largestObservedEntries(): number {
    return this.largestEntries;
  }

  get largestObservedBytes(): number {
    return this.largestBytes;
  }

  view(): QueueView {
    return {
      length: this.pendingEntryCount,
      totalEntries: this.totalEntries,
      totalBytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      minRetention: this.minRetentionValue,
      entryAt: (index: number) => this.pendingAt(index),
    };
  }

  admit(entry: LogEntry, policy: OverflowPolicy): AdmissionResult {
    if (this.maxEntries < 1 || entry.bytes > this.maxBytes) return { accepted: false, evicted: [] };
    if (!this.fits(entry.bytes, 1)) {
      const decision = policy.select(entry, this.view());
      if (!decision.accept || decision.evict.length === 0) return { accepted: false, evicted: [] };
      const evictIds = new Set<number>();
      let evictedBytes = 0;
      for (const victim of decision.evict) {
        if (this.inFlight.has(victim.id) || evictIds.has(victim.id)) continue;
        evictIds.add(victim.id);
        evictedBytes += victim.bytes;
      }
      if (evictIds.size === 0) return { accepted: false, evicted: [] };
      // Verify the planned eviction actually creates room before mutating.
      if (!this.fitsAfterEviction(entry.bytes, evictIds.size, evictedBytes)) {
        return { accepted: false, evicted: [] };
      }
      const evicted = this.removePending(evictIds);
      this.push(entry);
      return { accepted: true, evicted };
    }
    this.push(entry);
    return { accepted: true, evicted: [] };
  }

  /** Admit only when the queue already has room; never evicts a real event. */
  tryAdmit(entry: LogEntry): boolean {
    if (this.maxEntries < 1 || entry.bytes > this.maxBytes || !this.fits(entry.bytes, 1)) return false;
    this.push(entry);
    return true;
  }

  /** Move up to the batch limits from the head into the in-flight budget. */
  drain(maxEntries: number, maxBatchBytes: number): LogEntry[] {
    const batch: LogEntry[] = [];
    let bytes = 0;
    while (this.head < this.pending.length && batch.length < maxEntries) {
      const next = this.pending[this.head]!;
      if (batch.length > 0 && bytes + next.bytes > maxBatchBytes) break;
      batch.push(next);
      bytes += next.bytes;
      this.pending[this.head] = undefined as unknown as LogEntry;
      this.head += 1;
    }
    if (batch.length === 0) return batch;
    this.pendingBytesValue -= bytes;
    this.inFlightBytesValue += bytes;
    for (const entry of batch) {
      this.inFlight.set(entry.id, entry);
      this.adjustRetention(entry.retention, -1);
    }
    this.compact();
    return batch;
  }

  /** Release an in-flight batch after its write settles (success or failure). */
  release(entries: readonly LogEntry[]): void {
    for (const entry of entries) {
      if (this.inFlight.delete(entry.id)) this.inFlightBytesValue -= entry.bytes;
    }
  }

  /** Synchronous exit fallback: remove a strictly bounded prefix of pending entries. */
  takePendingSync(maxEntries: number, maxBytes: number): LogEntry[] {
    const batch: LogEntry[] = [];
    let bytes = 0;
    while (this.head < this.pending.length && batch.length < maxEntries) {
      const next = this.pending[this.head]!;
      if (batch.length > 0 && bytes + next.bytes > maxBytes) break;
      batch.push(next);
      bytes += next.bytes;
      this.pending[this.head] = undefined as unknown as LogEntry;
      this.head += 1;
    }
    if (batch.length > 0) {
      this.pendingBytesValue -= bytes;
      for (const entry of batch) this.adjustRetention(entry.retention, -1);
      this.compact();
    }
    return batch;
  }

  clearPending(): void {
    this.pending = [];
    this.head = 0;
    this.pendingBytesValue = 0;
    this.retentionCounts.clear();
    this.minRetentionValue = Number.POSITIVE_INFINITY;
  }

  private fits(bytes: number, entries: number): boolean {
    return this.totalBytes + bytes <= this.maxBytes && this.totalEntries + entries <= this.maxEntries;
  }

  private fitsAfterEviction(bytes: number, evictedEntries: number, evictedBytes: number): boolean {
    return this.totalBytes - evictedBytes + bytes <= this.maxBytes
      && this.totalEntries - evictedEntries + 1 <= this.maxEntries;
  }

  private pendingAt(index: number): LogEntry | undefined {
    if (index < 0 || index >= this.pendingEntryCount) return undefined;
    return this.pending[this.head + index];
  }

  private push(entry: LogEntry): void {
    this.pending.push(entry);
    this.pendingBytesValue += entry.bytes;
    this.adjustRetention(entry.retention, 1);
    if (this.totalEntries > this.largestEntries) this.largestEntries = this.totalEntries;
    if (this.totalBytes > this.largestBytes) this.largestBytes = this.totalBytes;
  }

  private removePending(ids: ReadonlySet<number>): LogEntry[] {
    const head = this.pending[this.head];
    if (ids.size === 1 && head && ids.has(head.id)) {
      this.pending[this.head] = undefined as unknown as LogEntry;
      this.head += 1;
      this.pendingBytesValue -= head.bytes;
      this.adjustRetention(head.retention, -1);
      this.compact();
      return [head];
    }
    const evicted: LogEntry[] = [];
    const kept: LogEntry[] = [];
    for (let index = this.head; index < this.pending.length; index += 1) {
      const entry = this.pending[index]!;
      if (ids.has(entry.id)) {
        evicted.push(entry);
        this.pendingBytesValue -= entry.bytes;
        this.adjustRetention(entry.retention, -1);
      } else {
        kept.push(entry);
      }
    }
    this.pending = kept;
    this.head = 0;
    return evicted;
  }

  private adjustRetention(retention: number, delta: number): void {
    const next = (this.retentionCounts.get(retention) ?? 0) + delta;
    if (next <= 0) {
      this.retentionCounts.delete(retention);
      if (retention === this.minRetentionValue) {
        let minimum = Number.POSITIVE_INFINITY;
        for (const value of this.retentionCounts.keys()) minimum = Math.min(minimum, value);
        this.minRetentionValue = minimum;
      }
    } else {
      this.retentionCounts.set(retention, next);
      if (retention < this.minRetentionValue) this.minRetentionValue = retention;
    }
  }

  private compact(): void {
    if (this.head === 0) return;
    if (this.head >= this.pending.length) {
      this.pending = [];
      this.head = 0;
      return;
    }
    if (this.head > 256 && this.head * 2 >= this.pending.length) {
      this.pending = this.pending.slice(this.head);
      this.head = 0;
    }
  }
}
