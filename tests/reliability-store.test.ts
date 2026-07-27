import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RELIABILITY,
  emptyReliabilityState,
  recordModelFailure,
  type ReliabilityState,
} from "../reliability.ts";
import { ReliabilityStore, type ReliabilityIo } from "../reliability-store.ts";

function makeIo() {
  const calls: string[] = [];
  const io: ReliabilityIo = {
    load: () => emptyReliabilityState(),
    save: (_p, _s) => { calls.push("save"); },
  };
  return { io, calls };
}

const key = "openai/gpt-5.4";
const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 2, windowMinutes: 5, cooldownMinutes: 60 };

describe("reliability store", () => {
  it("recordFailure updates state and saves", () => {
    const { io, calls } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: cfg, io });
    store.recordFailure(key, "probe", "timeout", 1000);
    assert.equal(store.getState().models[key]?.lastFailureReason, "timeout");
    assert.equal(calls.length, 1);
  });

  it("recordSuccess clears failures and saves", () => {
    const { io, calls } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: cfg, io });
    store.recordFailure(key, "probe", "timeout", 1000);
    store.recordSuccess(key, "probe", 2000);
    assert.equal(store.getState().models[key]?.openUntil, undefined);
    assert.equal(calls.length, 2);
  });

  it("recordSuccess no-ops when disabled", () => {
    const { io, calls } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: { ...cfg, enabled: false }, io });
    store.recordSuccess(key, "probe", 1000);
    assert.deepEqual(store.getState(), emptyReliabilityState());
    assert.equal(calls.length, 0);
  });

  it("recordSettled — Policy A: failure always records", () => {
    const { io, calls } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: { ...cfg, failureThreshold: 1 }, io });
    store.recordSettled(key, "500 error", 1000);
    assert.equal(store.getState().models[key]?.lastFailureReason, "500 error");
    assert.equal(calls.length, 1);
  });

  it("recordSettled — Policy A: clean settle only records if trialActive", () => {
    const { io, calls } = makeIo();
    // Start with a circuit opened by failure
    const initial = emptyReliabilityState();
    const stateWithFailure = recordModelFailure(initial, key, cfg, 1000, "probe", "timeout");
    const store = new ReliabilityStore({
      cwd: "/tmp", config: { ...cfg, failureThreshold: 1 }, io,
      initialState: { ...stateWithFailure, models: { [key]: { ...stateWithFailure.models[key]!, trialActive: true } } },
    });
    // Clean settle with trialActive → should call recordSuccess
    store.recordSettled(key, undefined, 1000);
    assert.equal(calls.length, 1);
    assert.equal(store.getState().models[key]?.trialActive, false);
    assert.equal(store.getState().models[key]?.openUntil, undefined);
  });

  it("recordSettled — Policy A: clean settle without trialActive does NOT record", () => {
    const { io, calls } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: cfg, io });
    // Clean settle, no trial active → no-op
    store.recordSettled(key, undefined, 1000);
    assert.equal(calls.length, 0);
  });

  it("beginTrial sets trialActive", () => {
    const { io } = makeIo();
    const initial = emptyReliabilityState();
    const stateWithFailure = recordModelFailure(initial, key, cfg, 1000, "probe", "timeout");
    const store = new ReliabilityStore({ cwd: "/tmp", config: { ...cfg, failureThreshold: 1 }, io, initialState: stateWithFailure });
    store.beginTrial(key);
    assert.equal(store.getCircuitState(key, 1000).trialActive, true);
  });

  it("applyOutcomes batches multiple outcomes into one save", () => {
    const { io, calls } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: { ...cfg, failureThreshold: 1 }, io });
    store.applyOutcomes([
      { model: "openai/gpt-5.4", ok: false, source: "probe", reason: "timeout" },
      { model: "openai/gpt-4.1-mini", ok: true, source: "probe" },
    ], 1000);
    // Only one save despite two outcomes
    assert.equal(calls.length, 1);
    assert.equal(store.getState().models["openai/gpt-5.4"]?.lastFailureReason, "timeout");
  });

  it("openCircuitCount returns 0 when disabled", () => {
    const { io } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: { ...cfg, enabled: false }, io });
    assert.equal(store.openCircuitCount(), 0);
  });

  it("reload re-reads from disk", () => {
    const io: ReliabilityIo = {
      load: () => ({ version: 1, models: { "x": { failures: [], lastSuccessAt: 42 } } }),
      save: () => {},
    };
    const store = new ReliabilityStore({ cwd: "/tmp", config: cfg, io });
    store.reload(cfg, "/tmp");
    assert.equal(store.getState().models["x"]?.lastSuccessAt, 42);
  });

  it("reload swaps path when cwd changes", () => {
    const io: ReliabilityIo = {
      load: (path: string) => ({ version: 1, models: {}, _path: path } as unknown as ReturnType<ReliabilityIo["load"]>),
      save: () => {},
    };
    const store = new ReliabilityStore({ cwd: "/proj-a", config: cfg, io });
    assert.match(store.path, /proj-a/);
    store.reload(cfg, "/proj-b");
    assert.match(store.path, /proj-b/);
  });

  it("two store instances on same file see each other after persist", () => {
    const writes: ReliabilityState[] = [];
    const shared: { state: ReliabilityState } = { state: emptyReliabilityState() };
    const io: ReliabilityIo = {
      load: () => shared.state,
      save: (_p, s) => { shared.state = s; writes.push(s); },
    };
    const storeA = new ReliabilityStore({ cwd: "/tmp", config: cfg, io });
    storeA.recordFailure(key, "probe", "timeout", 1000);
    // Second store loads same state
    const storeB = new ReliabilityStore({ cwd: "/tmp", config: cfg, io });
    assert.equal(storeB.getState().models[key]?.lastFailureReason, "timeout");
    assert.equal(writes.length, 1);
  });

  it("pruneStaleTrials clears trialActive when openUntil expired", () => {
    const { io } = makeIo();
    const t0 = 1000;
    const store = new ReliabilityStore({
      cwd: "/tmp", config: cfg, io, now: () => t0,
      initialState: {
        version: 1,
        models: { [key]: { failures: [t0], openUntil: t0 - 1, trialActive: true } },
      },
    });
    // openUntil is in the past → stale trial should be cleared
    assert.equal(store.getCircuitState(key, t0).trialActive, false);
    assert.equal(store.getCircuitState(key, t0).halfOpen, true);
  });

  it("isModelHealthy returns false for open circuit", () => {
    const { io } = makeIo();
    const store = new ReliabilityStore({ cwd: "/tmp", config: { ...cfg, failureThreshold: 1 }, io });
    store.recordFailure(key, "probe", "timeout", 1000);
    assert.equal(store.isModelHealthy(key, 1000), false);
  });
});
