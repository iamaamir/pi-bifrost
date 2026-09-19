import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ClassifierMetricsStore,
  type ClassifierMetricsIo,
  type ClassifierMetricsState,
} from "../classifier-metrics.ts";

function memoryIo() {
  let saved: ClassifierMetricsState | undefined;
  const io: ClassifierMetricsIo = {
    load: () => saved,
    save: (_path, state) => { saved = structuredClone(state); },
  };
  return { io, saved: () => saved };
}

describe("classifier metrics", () => {
  it("persists only bounded content-free aggregates", () => {
    const memory = memoryIo();
    const store = new ClassifierMetricsStore({ cwd: "/project", io: memory.io, now: () => 1234 });
    store.record({ outcome: "success", latencyMs: 420, attempts: 1, tier: "frontier", confidence: 0.93 });
    store.record({ outcome: "timeout", latencyMs: 3000, attempts: 2 });

    const snapshot = store.snapshot();
    assert.equal(snapshot.total, 2);
    assert.deepEqual(snapshot.outcomes, { success: 1, timeout: 1 });
    assert.deepEqual(snapshot.tiers, { frontier: 1 });
    assert.deepEqual(snapshot.confidenceBands, { "0.9-1.0": 1 });
    assert.equal(snapshot.latencyBuckets["<=500ms"], 1);
    assert.equal(snapshot.latencyBuckets["<=3000ms"], 1);
    assert.equal(snapshot.totalAttempts, 3);
    assert.equal(snapshot.lastObservedAt, 1234);
    const persisted = JSON.stringify(memory.saved());
    assert.doesNotMatch(persisted, /prompt|probabilit|api.?key|authorization/i);
  });

  it("never makes classification fail when persistence fails", () => {
    const store = new ClassifierMetricsStore({
      cwd: "/project",
      io: { load: () => undefined, save: () => { throw new Error("disk full"); } },
    });
    assert.doesNotThrow(() => store.record({ outcome: "success", latencyMs: 1, attempts: 1 }));
    assert.equal(store.snapshot().total, 1);
  });

  it("does not load or save when disabled", () => {
    let loads = 0;
    let saves = 0;
    const store = new ClassifierMetricsStore({
      cwd: "/project",
      enabled: false,
      io: { load: () => { loads++; return undefined; }, save: () => { saves++; } },
    });
    store.record({ outcome: "success", latencyMs: 1, attempts: 1, tier: "quick", confidence: 1 });
    assert.equal(loads, 0);
    assert.equal(saves, 0);
    assert.equal(store.snapshot().total, 0);
  });
});
