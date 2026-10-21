// Reproducible local benchmark for the bounded logging subsystem.
// Run: npm run benchmark:logging
//
// The baseline reproduces the v2 call path (synchronous JSON.stringify into an
// unbounded array, flushed on setImmediate) against an in-memory sink so both
// implementations are measured without disk noise. Results are advisory and
// intentionally not asserted in CI.

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createProcessIdentity, resolveDebugConfig } from "../logging/context.ts";
import { BifrostLogger } from "../logging/logger.ts";
import type { LogDestination, LogEntry, LogSink } from "../logging/types.ts";

class CountingSink implements LogSink {
  entries = 0;
  bytes = 0;
  delayMs = 0;

  async write(batch: readonly LogEntry[]): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    this.entries += batch.length;
    for (const entry of batch) this.bytes += entry.bytes;
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

interface BaselineLogger {
  call(meta: Record<string, unknown>): void;
  flush(): void;
}

function createBaseline(): BaselineLogger {
  let buffer: string[] = [];
  let scheduled = false;
  return {
    call(meta) {
      buffer.push(JSON.stringify({ ts: new Date().toISOString(), module: "bench", event: "event", entryType: "event", ...meta }));
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          buffer = [];
          scheduled = false;
        });
      }
    },
    flush() {
      buffer = [];
    },
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

function summarize(name: string, latencies: number[], extra: Record<string, number | string>): Record<string, number | string> {
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    scenario: name,
    calls: sorted.length,
    avgUs: +(total / Math.max(1, sorted.length) * 1_000).toFixed(3),
    p95Us: +(percentile(sorted, 0.95) * 1_000).toFixed(3),
    p99Us: +(percentile(sorted, 0.99) * 1_000).toFixed(3),
    maxUs: +(sorted.at(-1)! * 1_000).toFixed(3),
    ...extra,
  };
}

async function measure(
  name: string,
  calls: number,
  run: (index: number) => void,
): Promise<Record<string, number | string>> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const heapBefore = process.memoryUsage().heapUsed;
  const latencies: number[] = [];
  const started = performance.now();
  for (let index = 0; index < calls; index += 1) {
    const before = performance.now();
    run(index);
    latencies.push(performance.now() - before);
  }
  const elapsedMs = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  // Give the loop one turn so the blocking burst is visible in the histogram.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  histogram.disable();
  return summarize(name, latencies, {
    totalMs: +elapsedMs.toFixed(2),
    throughputPerSec: Math.round(calls / (elapsedMs / 1_000)),
    eventLoopMeanMs: +(histogram.mean / 1e6).toFixed(3),
    eventLoopMaxMs: +(histogram.max / 1e6).toFixed(3),
    heapDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(2),
  });
}

function newLogger(options: {
  config?: Parameters<typeof resolveDebugConfig>[0];
  sink: CountingSink;
}): BifrostLogger {
  const config = resolveDebugConfig({ enabled: true, directory: "/tmp/bifrost-benchmark", ...options.config }, "/tmp/bifrost-benchmark");
  const logger = new BifrostLogger({
    config,
    identity: createProcessIdentity({}, process.pid),
    correlation: {},
    sinkFactory: (_destination: LogDestination) => options.sink,
  });
  logger.bindSession({ sessionId: "benchmark" });
  return logger;
}

async function main(): Promise<void> {
  const results: Array<Record<string, number | string>> = [];

  // 1. v2 baseline, small events.
  {
    const baseline = createBaseline();
    results.push(await measure("v2 baseline · small", 10_000, (index) => baseline.call({ index })));
    baseline.flush();
  }

  // 2. New logger, small events.
  {
    const sink = new CountingSink();
    const logger = newLogger({ sink });
    results.push(await measure("bounded · small", 10_000, (index) => logger.emit("bench", "event", { index })));
    const flushStarted = performance.now();
    await logger.flush(5_000);
    results.at(-1)!.flushMs = +(performance.now() - flushStarted).toFixed(2);
    results.at(-1)!.drops = logger.stats().droppedTotal;
    results.at(-1)!.finalEntries = sink.entries;
    await logger.close(500);
  }

  // 3. New logger, large metadata.
  {
    const sink = new CountingSink();
    const logger = newLogger({ sink, config: { queue: { maxEntries: 1_000, maxBytes: 4 * 1024 * 1024 } } });
    const payload = "x".repeat(2_048);
    results.push(await measure("bounded · large metadata", 2_000, (index) => logger.emit("bench", "event", { index, payload })));
    await logger.flush(5_000);
    results.at(-1)!.drops = logger.stats().droppedTotal;
    results.at(-1)!.finalEntries = sink.entries;
    await logger.close(500);
  }

  // 4. Disabled logging.
  {
    const config = resolveDebugConfig({ enabled: false }, "/tmp/bifrost-benchmark");
    const logger = new BifrostLogger({ config, identity: createProcessIdentity({}, process.pid), correlation: {} });
    results.push(await measure("disabled", 50_000, (index) => logger.emit("bench", "event", { index })));
  }

  // 5. Sustained overload with a slow sink (1 ms per batch).
  {
    const sink = new CountingSink();
    sink.delayMs = 1;
    const logger = newLogger({
      sink,
      config: {
        level: "trace",
        queue: { maxEntries: 200, maxBytes: 64 * 1024, overflowPolicy: "severity-first" },
        drain: { intervalMs: 50, maxBatchBytes: 8 * 1024 },
      },
    });
    const payload = "y".repeat(1_024);
    results.push(await measure("bounded · overload + slow sink", 20_000, (index) => {
      logger.emit("bench", "burst", { index, payload }, { level: "trace" });
      if (index % 25 === 0) logger.emit("bench", "warning", { index }, { level: "warn" });
    }));
    const flushStarted = performance.now();
    await logger.flush(5_000);
    const stats = logger.stats();
    results.at(-1)!.flushMs = +(performance.now() - flushStarted).toFixed(2);
    results.at(-1)!.drops = stats.droppedTotal;
    results.at(-1)!.inFlightEntries = stats.inFlightEntries;
    results.at(-1)!.finalEntries = sink.entries;
    results.at(-1)!.writeFailures = stats.writeFailures;
    await logger.close(500);
  }

  console.table(results);
  console.log(JSON.stringify(results, null, 2));
}

const keepAlive = setInterval(() => undefined, 1_000);
try {
  await main();
} finally {
  clearInterval(keepAlive);
}
