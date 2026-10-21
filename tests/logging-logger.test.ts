import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createProcessIdentity,
  resolveDebugConfig,
} from "../logging/context.ts";
import { BifrostLogger } from "../logging/logger.ts";
import type { DebugConfig, LogDestination, LogEntry, LogSink } from "../logging/types.ts";

class FakeSink implements LogSink {
  readonly entries: LogEntry[] = [];
  readonly batches: LogEntry[][] = [];
  failNext = 0;
  stall = false;
  closed = false;

  async write(batch: readonly LogEntry[]): Promise<void> {
    this.batches.push([...batch]);
    if (this.stall) return new Promise<void>(() => {});
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("injected write failure");
    }
    this.entries.push(...batch);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

function create(
  overrides: DebugConfig = {},
  options: {
    identity?: ReturnType<typeof createProcessIdentity>;
    bootstrapTimeoutMs?: number;
    correlation?: Record<string, string>;
    date?: () => Date;
  } = {},
) {
  const sinks = new Map<string, FakeSink>();
  const config = resolveDebugConfig(
    { enabled: true, directory: join(tmpdir(), "bifrost-logger-unit"), ...overrides },
    join(tmpdir(), "bifrost-logger-project"),
  );
  const logger = new BifrostLogger({
    config,
    identity: options.identity ?? createProcessIdentity({}, 4242),
    correlation: options.correlation ?? {},
    bootstrapTimeoutMs: options.bootstrapTimeoutMs ?? 5_000,
    ...(options.date ? { date: options.date } : {}),
    sinkFactory: (destination: LogDestination) => {
      let sink = sinks.get(destination.key);
      if (!sink) {
        sink = new FakeSink();
        sinks.set(destination.key, sink);
      }
      return sink;
    },
  });
  return { logger, sinks, config };
}

function rows(sink: FakeSink): Record<string, unknown>[] {
  return sink.entries.map((entry) => JSON.parse(entry.line.trim()) as Record<string, unknown>);
}

function allRows(sinks: Map<string, FakeSink>): Array<Record<string, unknown> & { destination: string }> {
  return [...sinks.entries()].flatMap(([key, sink]) =>
    rows(sink).map((row) => ({ ...row, destination: key })));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("bifrost logger", () => {
  it("filters by severity before evaluating lazy metadata", async () => {
    const { logger, sinks } = create({ level: "warn" });
    let calls = 0;
    logger.emit("router", "filtered", () => {
      calls += 1;
      return { expensive: true };
    });
    assert.equal(calls, 0);
    logger.emit("router", "kept", () => {
      calls += 1;
      return { expensive: true };
    }, { level: "warn" });
    await logger.flush(1_000);
    assert.equal(calls, 1);
    const output = [...sinks.values()].flatMap(rows);
    assert.equal(output.length, 1);
    assert.equal(output[0]!.level, "warn");
    assert.equal(output[0]!.event, "kept");
  });

  it("survives a throwing metadata callback", async () => {
    const { logger, sinks } = create();
    logger.emit("router", "callback", () => {
      throw new Error("boom");
    });
    await logger.flush(1_000);
    const output = [...sinks.values()].flatMap(rows);
    assert.equal(output[0]!._meta_error, "callback_threw");
    assert.equal(output[0]!.event, "callback");
  });

  it("does not execute a metadata getter", async () => {
    const { logger, sinks } = create();
    let calls = 0;
    const meta: Record<string, unknown> = { ok: true };
    Object.defineProperty(meta, "boom", {
      enumerable: true,
      get: () => {
        calls += 1;
        throw new Error("getter");
      },
    });
    logger.emit("router", "getter", meta);
    await logger.flush(1_000);
    const row = [...sinks.values()].flatMap(rows)[0]!;
    assert.equal(row.event, "getter");
    assert.equal(calls, 0, "getters must not run during logging");
    assert.equal(Object.hasOwn(row, "ok"), true);
    assert.equal(Object.hasOwn(row, "boom"), false);
  });

  it("does not let metadata override reserved fields and redacts string secrets", async () => {
    const { logger, sinks } = create();
    logger.emit("router", "collision", {
      level: "error",
      ts: "not-a-time",
      run_id: "spoofed",
      root_session_id: "spoofed",
      module: "spoofed",
      request_correlation_id: "req-1",
      prompt: "secret text",
      api_key: "key",
      token: "token",
      errorMessage: "boom",
      error: 3,
      request: { body: "secret" },
      response: { text: "secret" },
      ok: true,
    });
    await logger.flush(1_000);
    const output = [...sinks.values()].flatMap(rows);
    const row = output[0]!;
    assert.equal(row.level, "debug");
    assert.equal(row.module, "router");
    assert.notEqual(row.ts, "not-a-time");
    assert.notEqual(row.run_id, "spoofed");
    assert.notEqual(row.root_session_id, "spoofed");
    assert.equal(row.request_correlation_id, "req-1");
    assert.equal(Object.hasOwn(row, "prompt"), false);
    assert.equal(Object.hasOwn(row, "api_key"), false);
    assert.equal(Object.hasOwn(row, "token"), false);    assert.equal(Object.hasOwn(row, "errorMessage"), false);
    assert.equal(Object.hasOwn(row, "request"), false);
    assert.equal(Object.hasOwn(row, "response"), false);
    assert.equal(row.error, 3);
  });

  it("keeps process correlation authoritative and ignores prototype keys", async () => {
    const { logger, sinks } = create({}, { correlation: { run_correlation_id: "real-run" } });
    const meta = JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","run_correlation_id":"spoofed","ok":true}');
    logger.emit("router", "spoof", meta);
    await logger.flush(1_000);
    const row = [...sinks.values()].flatMap(rows)[0]!;
    assert.equal(row.run_correlation_id, "real-run");
    assert.equal(row.ok, true);
    assert.equal(Object.hasOwn(row, "constructor"), false);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });


  it("serializes serialization failures with a bounded fallback record", async () => {
    const { logger, sinks } = create();
    logger.emit("router", "bad-meta", { big: 1n } as unknown as Record<string, unknown>);
    await logger.flush(1_000);
    const row = [...sinks.values()].flatMap(rows)[0]!;
    assert.equal(row._meta_error, "unserializable");
    assert.equal(row.level, "debug");
    assert.equal(typeof row.run_id, "string");
  });

  it("rejects events larger than the per-entry cap", async () => {
    const { logger } = create();
    logger.emit("router", "huge", { blob: "x".repeat(70 * 1024) });
    await logger.flush(1_000);
    const stats = logger.stats();
    assert.equal(stats.droppedByReason.oversized, 1);
    assert.equal(stats.droppedTotal, 1);
  });

  it("skips lazy metadata when entry-count pressure cannot admit the event", async () => {
    const { logger } = create({
      level: "trace",
      queue: { maxEntries: 1, maxBytes: 64 * 1024, overflowPolicy: "severity-first" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "capacity" });
    logger.emit("router", "warn-event", undefined, { level: "warn" });
    let calls = 0;
    logger.emit("router", "debug-event", () => {
      calls += 1;
      return { expensive: true };
    });
    assert.equal(calls, 0, "metadata must not run for a pre-admission rejection");
    await logger.flush(1_000);
    assert.equal(logger.stats().droppedByReason.queue_capacity, 1);
  });

  it("drop-oldest evicts the oldest pending event even when the incoming event has lower retention", async () => {
    const { logger, sinks } = create({
      level: "trace",
      queue: { maxEntries: 2, maxBytes: 64 * 1024, overflowPolicy: "drop-oldest" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "drop-oldest-mixed" });
    logger.emit("router", "pending-error", undefined, { level: "error" });
    logger.emit("router", "pending-debug");
    let calls = 0;
    logger.emit("router", "incoming-trace", () => {
      calls += 1;
      return { admitted: true };
    }, { level: "trace" });

    assert.equal(calls, 1, "drop-oldest must evaluate the incoming event instead of applying severity admission");
    assert.equal(logger.stats().evictionsTotal, 1);
    assert.equal(logger.stats().droppedBySeverity.error, 1);

    await logger.flush(1_000);
    const output = allRows(sinks).filter((row) => row.module === "router");
    assert.deepEqual(output.map((row) => row.event), ["pending-debug", "incoming-trace"]);
    assert.equal(output[1]!.admitted, true);
  });

  it("severity-first rejects a lower-retention event before preparation", async () => {
    const { logger, sinks } = create({
      level: "trace",
      queue: { maxEntries: 2, maxBytes: 64 * 1024, overflowPolicy: "severity-first" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "severity-first-mixed" });
    logger.emit("router", "pending-error", undefined, { level: "error" });
    logger.emit("router", "pending-debug");
    let calls = 0;
    logger.emit("router", "rejected-trace", () => {
      calls += 1;
      return { admitted: true };
    }, { level: "trace" });

    assert.equal(calls, 0, "severity-first must keep the lazy-metadata fast path");
    assert.equal(logger.stats().evictionsTotal, 0);
    assert.equal(logger.stats().droppedByReason.queue_capacity, 1);

    await logger.flush(1_000);
    const output = allRows(sinks).filter((row) => row.module === "router");
    assert.deepEqual(output.map((row) => row.event), ["pending-error", "pending-debug"]);
  });

  it("drop-newest rejects a full queue without evicting a mixed-severity event", async () => {
    const { logger, sinks } = create({
      level: "trace",
      queue: { maxEntries: 2, maxBytes: 64 * 1024, overflowPolicy: "drop-newest" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "drop-newest-mixed" });
    logger.emit("router", "pending-error", undefined, { level: "error" });
    logger.emit("router", "pending-debug");
    logger.emit("router", "rejected-trace", undefined, { level: "trace" });

    assert.equal(logger.stats().evictionsTotal, 0);
    assert.equal(logger.stats().droppedByReason.queue_capacity, 1);

    await logger.flush(1_000);
    const output = allRows(sinks).filter((row) => row.module === "router");
    assert.deepEqual(output.map((row) => row.event), ["pending-error", "pending-debug"]);
  });

  it("drop-oldest can free pending capacity while an earlier write is in flight", async () => {
    const { logger, sinks } = create({
      level: "trace",
      queue: { maxEntries: 2, maxBytes: 64 * 1024, overflowPolicy: "drop-oldest" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "inflight-drop-oldest" });
    logger.emit("router", "in-flight");
    await logger.flush(20);
    const sink = [...sinks.values()][0]!;
    sink.stall = true;
    logger.emit("router", "stalled");
    await logger.flush(20);
    assert.equal(logger.stats().inFlightEntries, 1);

    logger.emit("router", "pending-error", undefined, { level: "error" });
    let calls = 0;
    logger.emit("router", "incoming-trace", () => {
      calls += 1;
      return { admitted: true };
    }, { level: "trace" });

    assert.equal(calls, 1, "capacity held by an in-flight write must not become a severity restriction");
    assert.equal(logger.stats().queuedEntries, 1);
    assert.equal(logger.stats().inFlightEntries, 1);
    assert.equal(logger.stats().evictionsTotal, 1);
    await logger.close(20);
  });

  for (const overflowPolicy of ["severity-first", "drop-oldest", "drop-newest"] as const) {
    it(`rejects when every capacity slot is in flight under ${overflowPolicy}`, async () => {
      const { logger, sinks } = create({
        level: "trace",
        queue: { maxEntries: 1, maxBytes: 64 * 1024, overflowPolicy },
        drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
      });
      logger.bindSession({ sessionId: `inflight-full-${overflowPolicy}` });
      logger.emit("router", "in-flight");
      await logger.flush(20);
      const sink = [...sinks.values()][0]!;
      sink.stall = true;
      logger.emit("router", "stalled");
      await logger.flush(20);
      assert.equal(logger.stats().inFlightEntries, 1);

      logger.emit("router", "rejected", undefined, { level: "trace" });
      assert.equal(logger.stats().queuedEntries, 0);
      assert.equal(logger.stats().inFlightEntries, 1, "an active write must never be evicted");
      assert.equal(logger.stats().droppedByReason.queue_capacity, 1);
      await logger.close(20);
    });
  }

  it("writes JSONL in FIFO order and batches multiple events", async () => {
    const { logger, sinks } = create({ drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 } });
    for (let index = 0; index < 5; index += 1) logger.emit("router", `event-${index}`, { index });
    await logger.flush(1_000);
    const sink = [...sinks.values()][0]!;
    assert.equal(sink.batches.length, 1);
    assert.equal(sink.batches[0]!.length, 5);
    assert.deepEqual(rows(sink).map((row) => row.event), ["event-0", "event-1", "event-2", "event-3", "event-4"]);
    assert.equal(logger.stats().batchesWritten, 1);
  });

  it("keeps each queued event bound to its original session destination", async () => {
    const { logger, sinks } = create({ drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 } });
    logger.bindSession({ sessionId: "session-a" });
    logger.emit("router", "a-before-switch");
    logger.bindSession({ sessionId: "session-b" });
    logger.emit("router", "b-after-switch");
    logger.emit("router", "a-late", undefined, { identity: { sessionId: "session-a" } });
    await logger.flush(1_000);
    assert.equal(sinks.size, 2);
    const output = allRows(sinks);
    const aRows = output.filter((row) => String(row.destination).includes("session-a"));
    const bRows = output.filter((row) => String(row.destination).includes("session-b"));
    assert.deepEqual(aRows.map((row) => row.event).sort(), ["a-before-switch", "a-late"]);
    assert.deepEqual(bRows.map((row) => row.event), ["b-after-switch"]);
  });

  it("adopts startup bootstrap events when a session becomes available", async () => {
    const { logger, sinks } = create();
    logger.emit("bifrost", "startup", { phase: "boot" }, { level: "info" });
    logger.bindSession({ sessionId: "session-1" });
    await logger.flush(1_000);
    const output = allRows(sinks);
    assert.equal(output.length, 1);
    assert.equal(output[0]!.event, "startup");
    assert.match(String(output[0]!.destination), /session-1[\\/]main[\\/]/);
  });

  it("snapshots bootstrap metadata and its original timestamp", async () => {
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    const { logger, sinks } = create({}, { date: () => fixed });
    const metadata: Record<string, unknown> = { decision: "A" };
    logger.emit("router", "snapshot", metadata, { level: "info" });
    metadata.decision = "B";
    metadata.payload = "x".repeat(70 * 1024);
    logger.bindSession({ sessionId: "session-snapshot" });
    await logger.flush(1_000);

    const row = allRows(sinks)[0]!;
    assert.equal(row.event, "snapshot");
    assert.equal(row.decision, "A", "bootstrap must retain the value recorded at admission");
    assert.equal(Object.hasOwn(row, "payload"), false);
    assert.equal(row.ts, fixed.toISOString());
    assert.equal(logger.stats().droppedByReason.oversized, 0);
  });

  it("enforces the bootstrap capacity at the actual retained size", async () => {
    const { logger, sinks } = create();
    for (let index = 0; index < 64; index += 1) {
      logger.emit("bifrost", `boot-${index}`, {
        index,
        payload: "x".repeat(3_000),
      }, { level: "info" });
    }
    logger.bindSession({ sessionId: "session-capacity" });
    await logger.flush(1_000);

    const entries = [...sinks.values()].flatMap((sink) => sink.entries);
    const retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    assert.equal(entries.length < 64, true, "older bootstrap entries must be evicted");
    assert.equal(
      retainedBytes <= 128 * 1024 + 4 * 1024,
      true,
      `retained bootstrap bytes were ${retainedBytes}`,
    );
    assert.equal(logger.stats().droppedByReason.queue_capacity > 0, true);
  });

  it("falls back to an unattributed run when identity never arrives", async () => {
    const { logger, sinks } = create({}, { bootstrapTimeoutMs: 20 });
    logger.emit("bifrost", "early", undefined, { level: "info" });
    await delay(80);
    await logger.flush(1_000);
    const output = allRows(sinks);
    assert.equal(output.length, 1);
    assert.match(String(output[0]!.destination), /_unattributed[\\/]main[\\/]/);
  });

  it("gives concurrent processes on the same session distinct run files", async () => {
    const first = create();
    const second = create();
    first.logger.bindSession({ sessionId: "shared" });
    second.logger.bindSession({ sessionId: "shared" });
    first.logger.emit("router", "first");
    second.logger.emit("router", "second");
    await first.logger.flush(1_000);
    await second.logger.flush(1_000);
    const firstKey = [...first.sinks.keys()][0]!;
    const secondKey = [...second.sinks.keys()][0]!;
    assert.notEqual(firstKey, secondKey);
    assert.match(firstKey, /shared[\\/]main[\\/]/);
    assert.match(secondKey, /shared[\\/]main[\\/]/);
  });

  it("places a subagent under an explicitly propagated root", async () => {
    const identity = createProcessIdentity({
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_CHILD_AGENT: "explore",
      PI_SUBAGENT_ROOT_SESSION_ID: "root-session",
      PI_SUBAGENT_PARENT_AGENT_ID: "parent-agent",
    }, 7);
    const { logger, sinks } = create({}, { identity });
    logger.bindSession({ sessionId: "child-session" });
    logger.emit("input", "subagent");
    await logger.flush(1_000);
    const key = [...sinks.keys()][0]!;
    assert.match(key, /root-session[\\/]subagents[\\/]explore[\\/]/);
    const row = allRows(sinks)[0]!;
    assert.equal(row.agent_id, "explore");
    assert.equal(row.parent_agent_id, "parent-agent");
    assert.equal(row.root_session_id, "root-session");
    assert.equal(row.session_id, "child-session");
  });

  it("keeps a subagent with no parent identity independent instead of guessing", async () => {
    const identity = createProcessIdentity({
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_CHILD_AGENT: "explore",
      PI_SUBAGENT_RUN_ID: "run-9",
    }, 8);
    const { logger, sinks } = create({}, { identity });
    logger.bindSession({ sessionId: "child-session" });
    logger.emit("input", "subagent");
    await logger.flush(1_000);
    const key = [...sinks.keys()][0]!;
    assert.match(key, /child-session[\\/]subagents[\\/]explore[\\/]/);
    assert.doesNotMatch(key, /root-session/);
  });

  it("recovers after a transient sink failure and counts the lost batch", async () => {
    const { logger, sinks } = create();
    // The sink is created lazily on the first dispatch.
    logger.emit("router", "first");
    // Force sink creation, then inject a failure for the next write.
    await logger.flush(1_000);
    const activeSink = [...sinks.values()][0]!;
    activeSink.failNext = 1;
    logger.emit("router", "lost");
    await logger.flush(1_000);
    let stats = logger.stats();
    assert.equal(stats.writeFailures, 1);
    assert.equal(stats.droppedByReason.write_failure, 1);
    logger.emit("router", "recovered");
    await logger.flush(1_000);
    stats = logger.stats();
    assert.equal(stats.batchesWritten >= 2, true);
    assert.ok(rows(activeSink).some((row) => row.event === "recovered"));
  });

  it("does not hold post-session events for the next session", async () => {
    const { logger, sinks } = create();
    logger.bindSession({ sessionId: "sess-before" });
    logger.emit("router", "in-session");
    await logger.flush(1_000);
    logger.endSession();
    logger.emit("router", "after-session");
    await delay(150);
    const row = allRows(sinks).find((entry) => entry.event === "after-session");
    assert.ok(row, "the event must flush without waiting for another session");
    assert.match(row.destination, /_unattributed[\\/]main[\\/]/);
  });

  it("drains pending bootstrap events when the logger closes", async () => {
    const { logger, sinks } = create();
    logger.emit("bifrost", "startup", { phase: "boot" }, { level: "info", protected: true });
    await logger.close(1_000);
    const output = allRows(sinks);
    assert.equal(output.length, 1);
    assert.equal(output[0]!.event, "startup");
  });

  it("bounds idle sinks across many session switches", async () => {
    const { logger } = create();
    for (let index = 0; index < 24; index += 1) {
      logger.bindSession({ sessionId: `session-${index}` });
      logger.emit("router", "event");
      await logger.flush(1_000);
    }
    assert.equal(logger.stats().openSinks <= 16, true, `openSinks=${logger.stats().openSinks}`);
    assert.equal(logger.stats().openSinks >= 1, true);
    await logger.close(500);
  });

  it("prunes idle sinks under continuous activity without closing an active write", async () => {
    const { logger, sinks } = create({ drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 } });
    logger.bindSession({ sessionId: "stalled-session" });
    logger.emit("router", "stalled");
    await logger.flush(20);
    const stalled = [...sinks.entries()].find(([key]) => key.includes("stalled-session"))?.[1];
    assert.ok(stalled, "stalled sink must exist");
    stalled.stall = true;
    // Create the stalled write and keep it in flight.
    logger.emit("router", "still-stalled");
    await logger.flush(20);

    for (let index = 0; index < 40; index += 1) {
      logger.bindSession({ sessionId: `active-${index}` });
      logger.emit("router", `event-${index}`);
      await logger.flush(20);
    }

    assert.equal(logger.stats().openSinks <= 16, true, `openSinks=${logger.stats().openSinks}`);
    assert.equal(stalled.closed, false, "a sink with an active write must not be closed");
    await logger.close(20);
  });

  it("returns from flush at the deadline when a sink stalls", async () => {
    const { logger, sinks } = create();
    logger.emit("router", "stalled");
    await Promise.resolve();
    const sink = [...sinks.values()][0];
    if (sink) sink.stall = true;
    // Ensure the sink exists before stalling.
    if (!sink) {
      await logger.flush(50);
      const created = [...sinks.values()][0]!;
      created.stall = true;
      logger.emit("router", "second");
    }
    const started = performance.now();
    await logger.flush(60);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `flush took ${elapsed}ms`);
    await logger.close(20);
  });

  it("emits a bounded drop summary after the next successful write", async () => {
    const { logger, sinks } = create({
      queue: { maxEntries: 1, maxBytes: 64 * 1024, overflowPolicy: "severity-first" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "sess-drop" });
    logger.emit("router", "first");
    logger.emit("router", "second");
    logger.emit("router", "third");
    await logger.flush(1_000);
    const output = allRows(sinks);
    const summary = output.find((row) => row.module === "logger" && row.event === "events_dropped");
    assert.ok(summary, `expected a drop summary, got ${JSON.stringify(output)}`);
    assert.deepEqual(summary!.counts, { debug: 2 });
    assert.equal(summary!.dropped_total, 2);
    assert.ok(output.some((row) => row.event === "third"));
  });

  it("reports the final drop summary while closing", async () => {
    const { logger, sinks } = create({
      queue: { maxEntries: 1, maxBytes: 64 * 1024, overflowPolicy: "severity-first" },
      drain: { intervalMs: 60_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "sess-close" });
    logger.emit("router", "first");
    logger.emit("router", "second");
    await logger.close(1_000);
    const output = allRows(sinks);
    assert.ok(output.some((row) => row.event === "second"));
    const summary = output.find((row) => row.module === "logger" && row.event === "events_dropped");
    assert.ok(summary, `expected a close-time drop summary, got ${JSON.stringify(output)}`);
    assert.equal(summary!.dropped_total, 1);
  });

  it("counts a sink construction failure instead of throwing", async () => {
    const config = resolveDebugConfig(
      { enabled: true, directory: join(tmpdir(), "bifrost-logger-factory") },
      join(tmpdir(), "bifrost-logger-project"),
    );
    const logger = new BifrostLogger({
      config,
      identity: createProcessIdentity({}, 4242),
      sinkFactory: () => { throw new Error("factory failed"); },
    });
    logger.emit("router", "factory");
    await logger.flush(1_000);
    assert.equal(logger.stats().writeFailures, 1);
    assert.equal(logger.stats().droppedTotal, 1);
    await logger.close(1_000);
  });

  it("degrades instead of retrying a persistently failing sink forever", async () => {
    const { logger, sinks } = create();
    logger.emit("router", "warmup");
    await logger.flush(500);
    const sink = [...sinks.values()][0]!;
    for (let index = 0; index < 6; index += 1) {
      sink.failNext = 1;
      logger.emit("router", `attempt-${index}`);
      await logger.flush(500);
    }
    const stats = logger.stats();
    assert.equal(stats.writeFailures >= 5, true);
    assert.equal(stats.droppedByReason.sink_degraded >= 1, true);
    await logger.close(50);
  });

  it("keeps a failing session from degrading a healthy destination", async () => {
    const { logger, sinks } = create({
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "session-a" });
    logger.emit("router", "a-warm");
    await logger.flush(1_000);
    const aSink = [...sinks.entries()].find(([key]) => key.includes("session-a"))?.[1];
    assert.ok(aSink, "session A sink must exist");

    // Drive A past the failure threshold and into its degraded window.
    aSink.failNext = 10_000;
    for (let index = 0; index < 6; index += 1) {
      logger.emit("router", `a-fails-${index}`);
      await logger.flush(200);
    }
    const degradedDropsBefore = logger.stats().droppedByReason.sink_degraded;

    logger.bindSession({ sessionId: "session-b" });
    logger.emit("router", "b-healthy");
    await logger.flush(1_000);

    const output = allRows(sinks);
    const bRows = output.filter((row) => String(row.destination).includes("session-b"));
    assert.deepEqual(bRows.map((row) => row.event), ["b-healthy"]);
    assert.equal(
      bRows.some((row) => row.event === "events_dropped"),
      false,
      "session B must not receive session A's drop summary",
    );
    assert.equal(
      logger.stats().droppedByReason.sink_degraded,
      degradedDropsBefore,
      "session B's healthy sink must not be degraded by session A",
    );
    await logger.close(50);
  });

  it("attributes drop summaries to the destination that lost events", async () => {
    const { logger, sinks } = create({
      queue: { maxEntries: 1, maxBytes: 64 * 1024, overflowPolicy: "severity-first" },
      drain: { intervalMs: 10_000, maxBatchBytes: 64 * 1024 },
    });
    logger.bindSession({ sessionId: "session-a" });
    logger.emit("router", "a-first");
    logger.emit("router", "a-second");
    logger.bindSession({ sessionId: "session-b" });
    logger.emit("router", "b-third");
    await logger.flush(1_000);

    const output = allRows(sinks);
    const aRows = output.filter((row) => String(row.destination).includes("session-a"));
    const bRows = output.filter((row) => String(row.destination).includes("session-b"));
    assert.equal(bRows.some((row) => row.event === "events_dropped"), false);
    const summary = aRows.find((row) => row.event === "events_dropped");
    assert.ok(summary, `expected A's drop summary, got ${JSON.stringify(output)}`);
    assert.equal(summary!.dropped_total, 2);
    assert.equal(summary!.session_id, "session-a");
    await logger.close(50);
  });
});

describe("bifrost logger filesystem integration", () => {
  it("writes session-scoped files with restrictive permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-logger-fs-"));
    try {
      const config = resolveDebugConfig({ enabled: true }, cwd);
      const logger = new BifrostLogger({ config, identity: createProcessIdentity({}, 11) });
      logger.bindSession({ sessionId: "fs-session" });
      logger.emit("router", "file-event", { value: 1 });
      await logger.flush(1_000);
      const destination = logger.currentDestination().path;
      const contents = await readFile(destination, "utf8");
      assert.match(contents, /"event":"file-event"/);
      const info = await stat(destination);
      assert.equal(info.mode & 0o077, 0);
      await logger.close(500);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("recreates a deleted run file on the next flush", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-logger-delete-"));
    try {
      const config = resolveDebugConfig({ enabled: true }, cwd);
      const logger = new BifrostLogger({ config, identity: createProcessIdentity({}, 12) });
      logger.bindSession({ sessionId: "delete-session" });
      logger.emit("router", "before-delete");
      await logger.flush(1_000);
      const destination = logger.currentDestination().path;
      await rm(destination);
      logger.emit("router", "after-delete");
      await logger.flush(1_000);
      const contents = await readFile(destination, "utf8");
      assert.match(contents, /after-delete/);
      assert.doesNotMatch(contents, /before-delete/);
      await logger.close(500);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not follow a session-directory symlink outside the logging root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-logger-link-parent-"));
    const outside = await mkdtemp(join(tmpdir(), "bifrost-logger-link-outside-"));
    try {
      const config = resolveDebugConfig({ enabled: true }, cwd);
      const sessionRoot = join(config.directory, "escape");
      await mkdir(sessionRoot, { recursive: true });
      await symlink(outside, join(sessionRoot, "main"), "dir");

      const logger = new BifrostLogger({ config, identity: createProcessIdentity({}, 13) });
      logger.bindSession({ sessionId: "escape" });
      logger.emit("router", "must-not-escape");
      await logger.flush(1_000);

      assert.equal(logger.stats().writeFailures >= 1, true);
      assert.deepEqual(await readdir(outside), [], "nothing may be written through the symlink");
      await logger.close(500);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a pre-existing run-file symlink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-logger-link-file-"));
    const outside = await mkdtemp(join(tmpdir(), "bifrost-logger-link-target-"));
    try {
      const config = resolveDebugConfig({ enabled: true }, cwd);
      const runDir = join(config.directory, "linked", "main");
      await mkdir(runDir, { recursive: true });
      const target = join(outside, "target.jsonl");
      await writeFile(target, "");
      await symlink(target, join(runDir, "run-fixed.jsonl"));

      const logger = new BifrostLogger({
        config,
        identity: { rootSessionId: "linked", sessionId: "linked", runId: "run-fixed", processId: 14 },
      });
      logger.emit("router", "must-not-follow");
      await logger.flush(1_000);

      assert.equal(logger.stats().writeFailures >= 1, true);
      assert.equal(await readFile(target, "utf8"), "");
      await logger.close(500);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
