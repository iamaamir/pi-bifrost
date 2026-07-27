import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELIABILITY,
  emptyReliabilityState,
  getCircuitState,
  loadReliability,
  recordModelFailure,
  recordModelSuccess,
  beginTrial,
  reliabilityPath,
  saveReliability,
} from "../reliability.ts";

describe("reliability", () => {
  it("opens circuit after threshold failures within window", () => {
    const cfg = {
      ...DEFAULT_RELIABILITY,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
    };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 60_000, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 120_000, "probe", "timeout");

    const circuit = getCircuitState(state, key, t0 + 120_000, cfg);
    assert.equal(circuit.open, true);
    assert.equal(circuit.recentFailures, 3);
    assert.equal(circuit.openUntil, t0 + 120_000 + 60 * 60_000);
  });

  it("does not record failures when reliability is disabled", () => {
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const state = recordModelFailure(
      emptyReliabilityState(),
      key,
      { enabled: false, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
      t0,
      "probe",
      "timeout",
    );
    assert.deepEqual(state, emptyReliabilityState());
  });

  it("closes circuit on successful probe", () => {
    const cfg = {
      ...DEFAULT_RELIABILITY,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
    };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 60_000, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 120_000, "probe", "timeout");
    state = recordModelSuccess(state, key, t0 + 180_000, "probe");

    const circuit = getCircuitState(state, key, t0 + 180_000, cfg);
    assert.equal(circuit.open, false);
    assert.equal(circuit.recentFailures, 0);
  });

  it("saves and loads persisted state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    try {
      const path = reliabilityPath(cwd);
      const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
      let state = emptyReliabilityState();
      state = recordModelFailure(state, "openai/gpt-5.4", DEFAULT_RELIABILITY, t0, "probe", "timeout");
      saveReliability(path, state);
      const loaded = loadReliability(path);
      assert.equal(loaded.version, 1);
      assert.deepEqual(loaded.models["openai/gpt-5.4"]?.failures, [t0]);
      assert.equal(loaded.models["openai/gpt-5.4"]?.lastFailureSource, "probe");
      assert.equal(loaded.models["openai/gpt-5.4"]?.lastFailureReason, "timeout");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns empty state for corrupt persisted file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    try {
      const path = reliabilityPath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "bifrost-reliability.json"), "{not json", "utf8");
      const loaded = loadReliability(path);
      assert.deepEqual(loaded, emptyReliabilityState());
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails open with malformed-but-valid JSON records", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    try {
      const path = reliabilityPath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      const malformed = JSON.stringify({
        version: 1,
        models: {
          "openai/demo": { failures: "invalid" },
          "openai/ok": { failures: [ Date.UTC(2026, 0, 1, 12, 0, 0) ], openUntil: "not-a-number" },
          "openai/skipped-nested": { failures: { not: "array" } },
          "": { openUntil: Infinity },
        },
      });
      writeFileSync(join(cwd, ".pi", "bifrost-reliability.json"), malformed, "utf8");
      const loaded = loadReliability(path);
      assert.equal(loaded.version, 1);
      assert.equal(typeof loaded.models, "object");
      for (const key of Object.keys(loaded.models)) {
        const record = loaded.models[key]!;
        assert.ok(Array.isArray(record.failures), `failures should be array for ${key}`);
        if (record.openUntil !== undefined) assert.ok(Number.isFinite(record.openUntil), `openUntil should be finite for ${key}`);
      }
      const circuit = getCircuitState(loaded, "openai/demo", Date.UTC(2026, 0, 1, 12, 0, 0), DEFAULT_RELIABILITY);
      assert.equal(circuit.open, false);
      assert.equal(circuit.recentFailures, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("half-open: allows one trial after cooldown, closes on success", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = recordModelFailure(emptyReliabilityState(), key, cfg, t0, "probe", "timeout");
    assert.equal(getCircuitState(state, key, t0, cfg).open, true);
    assert.equal(getCircuitState(state, key, t0, cfg).halfOpen, false);
    const t1 = t0 + 61 * 60_000;
    assert.equal(getCircuitState(state, key, t1, cfg).open, false);
    assert.equal(getCircuitState(state, key, t1, cfg).halfOpen, true);
    assert.equal(getCircuitState(state, key, t1, cfg).trialActive, false);
    state = beginTrial(state, key);
    assert.equal(getCircuitState(state, key, t1, cfg).trialActive, true);
    state = recordModelSuccess(state, key, t1 + 1, "trial");
    const closed = getCircuitState(state, key, t1 + 1, cfg);
    assert.equal(closed.open, false);
    assert.equal(closed.halfOpen, false);
    assert.equal(closed.trialActive, false);
  });

  it("half-open: trial failure reopens circuit with double cooldown", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = recordModelFailure(emptyReliabilityState(), key, cfg, t0, "probe", "timeout");
    const t1 = t0 + 61 * 60_000;
    state = beginTrial(state, key);
    state = recordModelFailure(state, key, cfg, t1, "trial", "timeout");
    const circuit = getCircuitState(state, key, t1, cfg);
    assert.equal(circuit.open, true);
    assert.equal(circuit.openUntil, t1 + 120 * 60_000);
    assert.equal(circuit.trialActive, false);
  });
});
