import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedQueue } from "../logging/bounded-queue.ts";
import { resolveOverflowPolicy } from "../logging/overflow-policy.ts";
import { retentionFor } from "../logging/severity.ts";
import type { LogEntry, LogIdentity, LogLevel } from "../logging/types.ts";

let nextId = 0;

const identity: LogIdentity = {
  rootSessionId: "test",
  sessionId: "test",
  runId: "run",
  processId: 1,
};

function entry(level: LogLevel, bytes: number): LogEntry {
  nextId += 1;
  return {
    id: nextId,
    level,
    retention: retentionFor(level, false),
    destination: { key: "test", path: "/tmp/test.jsonl", shared: false },
    identity,
    line: `${"x".repeat(Math.max(0, bytes - 1))}\n`,
    bytes,
  };
}

describe("bounded logging queue", () => {
  it("enforces the exact entry-count boundary", () => {
    const queue = new BoundedQueue(2, 1_000);
    const policy = resolveOverflowPolicy("severity-first");
    const first = entry("debug", 10);
    const second = entry("debug", 10);
    assert.equal(queue.admit(first, policy).accepted, true);
    assert.equal(queue.admit(second, policy).accepted, true);
    assert.equal(queue.totalEntries, 2);
    // Equal severity: oldest-first eviction keeps the newest entry.
    const third = entry("debug", 10);
    const result = queue.admit(third, policy);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.evicted.map((item) => item.id), [first.id]);
    assert.equal(queue.totalEntries, 2);
  });

  it("admits without eviction only when there is room", () => {
    const queue = new BoundedQueue(1, 100);
    const first = entry("debug", 10);
    assert.equal(queue.tryAdmit(first), true);
    const second = entry("error", 10);
    assert.equal(queue.tryAdmit(second), false);
    assert.equal(queue.totalEntries, 1);
    assert.equal(queue.view().entryAt(0)?.id, first.id);
  });

  it("enforces the byte-size limit without sorting", () => {
    const queue = new BoundedQueue(100, 100);
    const policy = resolveOverflowPolicy("drop-newest");
    assert.equal(queue.admit(entry("debug", 60), policy).accepted, true);
    assert.equal(queue.admit(entry("debug", 60), policy).accepted, false);
    assert.equal(queue.totalBytes, 60);
  });

  it("rejects an individually oversized event", () => {
    const queue = new BoundedQueue(10, 100);
    assert.equal(queue.admit(entry("error", 101), resolveOverflowPolicy("severity-first")).accepted, false);
  });

  it("never evicts a higher severity event to admit a lower one", () => {
    const queue = new BoundedQueue(1, 1_000);
    const policy = resolveOverflowPolicy("severity-first");
    const warn = entry("warn", 10);
    assert.equal(queue.admit(warn, policy).accepted, true);
    const debug = entry("debug", 10);
    const result = queue.admit(debug, policy);
    assert.equal(result.accepted, false);
    assert.deepEqual(result.evicted, []);
    assert.equal(queue.totalEntries, 1);
  });

  it("evicts the lowest severity first and oldest within a severity", () => {
    const queue = new BoundedQueue(100, 160);
    const policy = resolveOverflowPolicy("severity-first");
    const trace = entry("trace", 40);
    const debugA = entry("debug", 40);
    const debugB = entry("debug", 40);
    assert.equal(queue.admit(trace, policy).accepted, true);
    assert.equal(queue.admit(debugA, policy).accepted, true);
    assert.equal(queue.admit(debugB, policy).accepted, true);
    const incoming = entry("error", 100);
    const result = queue.admit(incoming, policy);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.evicted.map((item) => item.id), [trace.id, debugA.id]);
    assert.equal(queue.totalEntries, 2);
  });

  it("preserves higher-severity events when lower-severity ones are available", () => {
    const queue = new BoundedQueue(100, 120);
    const policy = resolveOverflowPolicy("severity-first");
    const warn = entry("warn", 50);
    const info = entry("info", 50);
    assert.equal(queue.admit(warn, policy).accepted, true);
    assert.equal(queue.admit(info, policy).accepted, true);
    const result = queue.admit(entry("error", 50), policy);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.evicted.map((item) => item.id), [info.id]);
    assert.equal(queue.totalEntries, 2);
  });

  it("drop-oldest evicts from the head and drop-newest rejects", () => {
    const oldest = resolveOverflowPolicy("drop-oldest");
    const oldestQueue = new BoundedQueue(2, 1_000);
    const first = entry("trace", 10);
    const second = entry("error", 10);
    oldestQueue.admit(first, oldest);
    oldestQueue.admit(second, oldest);
    const incoming = entry("warn", 10);
    const dropped = oldestQueue.admit(incoming, oldest);
    assert.equal(dropped.accepted, true);
    assert.deepEqual(dropped.evicted.map((item) => item.id), [first.id]);

    const newest = resolveOverflowPolicy("drop-newest");
    const newestQueue = new BoundedQueue(2, 1_000);
    newestQueue.admit(entry("trace", 10), newest);
    newestQueue.admit(entry("debug", 10), newest);
    assert.equal(newestQueue.admit(entry("warn", 10), newest).accepted, false);
  });

  it("frees enough pending bytes when in-flight writes hold capacity", () => {
    const queue = new BoundedQueue(100, 100);
    const policy = resolveOverflowPolicy("severity-first");
    const entries = [entry("debug", 20), entry("debug", 20), entry("debug", 20), entry("debug", 20), entry("debug", 20)];
    for (const item of entries) assert.equal(queue.admit(item, policy).accepted, true);
    const inFlight = queue.drain(2, 1_000);
    assert.equal(inFlight.length, 2);
    const incoming = entry("error", 40);
    const result = queue.admit(incoming, policy);
    assert.equal(result.accepted, true, "the policy must account for in-flight bytes");
    assert.equal(result.evicted.length, 2);
    assert.equal(queue.totalBytes, 100);
    queue.release(inFlight);
  });

  it("counts in-flight entries against both budgets until release", () => {
    const queue = new BoundedQueue(2, 1_000);
    const policy = resolveOverflowPolicy("drop-newest");
    const first = entry("debug", 100);
    const second = entry("debug", 100);
    assert.equal(queue.admit(first, policy).accepted, true);
    assert.equal(queue.admit(second, policy).accepted, true);
    const batch = queue.drain(10, 1_000);
    assert.equal(batch.length, 2);
    assert.equal(queue.pendingEntryCount, 0);
    assert.equal(queue.inFlightEntryCount, 2);
    assert.equal(queue.totalBytes, 200);
    // In-flight entries still occupy the budget.
    assert.equal(queue.admit(entry("debug", 10), policy).accepted, false);
    queue.release(batch);
    assert.equal(queue.totalEntries, 0);
    assert.equal(queue.admit(entry("debug", 10), policy).accepted, true);
  });

  it("drains in FIFO order and respects batch byte limits", () => {
    const queue = new BoundedQueue(10, 1_000);
    const policy = resolveOverflowPolicy("severity-first");
    const entries = [entry("debug", 30), entry("debug", 30), entry("debug", 30)];
    for (const item of entries) queue.admit(item, policy);
    const first = queue.drain(10, 60);
    assert.deepEqual(first.map((item) => item.id), [entries[0]!.id, entries[1]!.id]);
    const second = queue.drain(10, 60);
    assert.deepEqual(second.map((item) => item.id), [entries[2]!.id]);
    const third = queue.drain(10, 60);
    assert.deepEqual(third, []);
  });
});
