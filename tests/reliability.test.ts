import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELIABILITY,
  emptyReliabilityState,
  getCircuitState,
  hasActiveAllowanceCooldown,
  loadReliability,
  recordModelFailure,
  recordModelSuccess,
  beginTrial,
  abandonTrial,
  reliabilityPath,
  saveReliability,
} from "../reliability.ts";
import { normalizeFailureObservation } from "../failure-observations.ts";

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

  it("opens immediately for a bound allowance-exhaustion observation, with a configured minimum and explicit opt-out", () => {
    const key = "openai/gpt-5.4";
    const now = 1_000;
    const observation = normalizeFailureObservation({
      outcomeId: "allowance-outcome", modelKey: key, source: "runtime", observedAt: now,
      structured: { category: "allowance_exhausted", retryAt: now + 1_000 },
      errorText: "private provider details",
    }, { now })!;
    const config = { failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const opened = recordModelFailure(emptyReliabilityState(), key, config, now, "agent_settled", "private raw error", observation);
    assert.equal(getCircuitState(opened, key, now, config).open, true);
    assert.equal(opened.models[key]?.openUntil, now + 60 * 60_000,
      "a short retry hint cannot shorten the configured cooldown");
    assert.equal(opened.models[key]?.lastFailureReason, "allowance_exhausted:structured:model-only",
      "the persisted reason contains only the allowlisted category/evidence/scope");
    assert.equal(JSON.stringify(opened).includes("private provider details"), false);
    assert.equal(JSON.stringify(opened).includes("private raw error"), false);

    const longerOpenUntil = now + 2 * 60 * 60_000;
    const alreadyBackedOff = {
      ...emptyReliabilityState(),
      models: { [key]: { failures: [], openUntil: longerOpenUntil } },
    };
    const extended = recordModelFailure(alreadyBackedOff, key, config, now, "agent_settled", "provider request failed", observation);
    assert.equal(extended.models[key]?.openUntil, longerOpenUntil,
      "an allowance observation never shortens an existing longer circuit backoff");
    const laterGenericFailure = recordModelFailure(opened, key, config, now + 1, "agent_settled", "generic retry failure");
    assert.equal(hasActiveAllowanceCooldown(laterGenericFailure, key, now + 1), true,
      "a later generic Pi retry failure preserves the active typed cooldown marker");
    const disabledDuringCooldownObservation = normalizeFailureObservation({
      outcomeId: "allowance-while-disabled", modelKey: key, source: "runtime", observedAt: now + 1,
      structured: { category: "allowance_exhausted" },
    }, { now: now + 1 })!;
    const disabledDuringCooldown = recordModelFailure(opened, key, {
      ...config, cooldownOnAllowanceExhausted: false,
    }, now + 1, "agent_settled", "new allowance failure", disabledDuringCooldownObservation);
    assert.equal(hasActiveAllowanceCooldown(disabledDuringCooldown, key, now + 1), true,
      "turning the policy off does not erase an already active allowance cooldown marker");

    const longHint = normalizeFailureObservation({
      outcomeId: "allowance-long-hint", modelKey: key, source: "runtime", observedAt: now,
      structured: { category: "allowance_exhausted", retryAt: now + 6 * 60 * 60_000 },
    }, { now })!;
    let longCooldown = recordModelFailure(emptyReliabilityState(), key, config, now, "agent_settled", "provider request failed", longHint);
    const hintedUntil = longCooldown.models[key]?.openUntil;
    for (let failure = 1; failure <= config.failureThreshold; failure += 1) {
      longCooldown = recordModelFailure(longCooldown, key, config, now + failure, "agent_settled", "generic retry failure");
    }
    assert.equal(longCooldown.models[key]?.openUntil, hintedUntil,
      "later threshold failures cannot shorten a longer allowance retry hint");
    assert.equal(hasActiveAllowanceCooldown(longCooldown, key, now + 3), true);

    const optedOut = recordModelFailure(emptyReliabilityState(), key, {
      ...config, cooldownOnAllowanceExhausted: false,
    }, now, "agent_settled", "provider request failed", observation);
    assert.equal(optedOut.models[key]?.openUntil, undefined);
    assert.equal(optedOut.models[key]?.lastFailureReason, "provider request failed");

    const ordinaryCircuit = {
      ...emptyReliabilityState(),
      models: { [key]: { failures: [], openUntil: now + 30_000, lastFailureReason: "timeout" } },
    };
    const allowanceWhileOptedOut = recordModelFailure(ordinaryCircuit, key, {
      ...config, cooldownOnAllowanceExhausted: false,
    }, now, "agent_settled", "allowance failure", observation);
    assert.equal(allowanceWhileOptedOut.models[key]?.openUntil, now + 30_000,
      "the existing ordinary circuit remains active");
    assert.equal(allowanceWhileOptedOut.models[key]?.lastFailureReason, "allowance failure",
      "an allowance failure does not relabel an ordinary circuit while the allowance cooldown is off");
    assert.equal(hasActiveAllowanceCooldown(allowanceWhileOptedOut, key, now), false,
      "enabling the policy later must not mistake this ordinary circuit for an allowance cooldown");

    const recoveredAt = opened.models[key]!.openUntil! + 1;
    assert.equal(getCircuitState(opened, key, recoveredAt, config).halfOpen, true);
    const trial = beginTrial(opened, key);
    assert.equal(getCircuitState(trial, key, recoveredAt, config).trialActive, true);
    const recovered = recordModelSuccess(trial, key, recoveredAt, "trial");
    assert.equal(getCircuitState(recovered, key, recoveredAt, config).open, false,
      "the model can re-enter controlled half-open recovery after its cooldown");
  });

  it("opens immediately for a model-bound runtime billing-denied observation", () => {
    const key = "openai/gpt-5.4";
    const now = 1_000;
    const config = { failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const billing = normalizeFailureObservation({
      outcomeId: "billing-denied", modelKey: key, source: "runtime", observedAt: now,
      structured: { httpStatus: 402 },
    }, { now })!;
    const opened = recordModelFailure(emptyReliabilityState(), key, config, now, "agent_settled", "payment required", billing);
    assert.equal(opened.models[key]?.openUntil, now + 60 * 60_000);
    assert.equal(opened.models[key]?.lastFailureReason, "billing_denied:http_status:model-only");
    assert.equal(hasActiveAllowanceCooldown(opened, key, now), true);
  });

  it("does not promote generic rate limits, unbound observations, or non-runtime sources to immediate cooldowns", () => {
    const key = "openai/gpt-5.4";
    const now = 1_000;
    const config = { failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const generic429 = normalizeFailureObservation({
      outcomeId: "rate-limit-outcome", modelKey: key, source: "runtime", observedAt: now,
      structured: { httpStatus: 429 },
    }, { now })!;
    assert.equal(generic429.category, "rate_limit");
    for (const observation of [
      generic429,
      { ...normalizeFailureObservation({ outcomeId: "other-model", modelKey: "openai/other", source: "runtime", observedAt: now, structured: { category: "allowance_exhausted" } }, { now })!, modelKey: key, scope: { kind: "model" as const, modelKey: "openai/other" } },
      normalizeFailureObservation({ outcomeId: "probe-outcome", modelKey: key, source: "probe", observedAt: now, structured: { category: "allowance_exhausted" } }, { now })!,
    ]) {
      const state = recordModelFailure(emptyReliabilityState(), key, config, now, "agent_settled", "provider request failed", observation);
      assert.equal(state.models[key]?.openUntil, undefined);
    }

    const accessor = Object.defineProperties({}, {
      category: { get: () => { throw new Error("getter must not run"); } },
      modelKey: { value: key },
    });
    assert.doesNotThrow(() => recordModelFailure(emptyReliabilityState(), key, config, now, "agent_settled", "provider request failed", accessor as never));
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

  it("returns empty state for missing persisted file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-reliability-"));
    try {
      const path = reliabilityPath(cwd);
      assert.deepEqual(loadReliability(path), emptyReliabilityState());
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

  it("half-open: abandoning a trial preserves failure and cooldown state", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const failed = recordModelFailure(emptyReliabilityState(), key, cfg, t0, "probe", "timeout");
    const trial = beginTrial(failed, key);
    const abandoned = abandonTrial(trial, key);
    assert.equal(abandoned.models[key]?.trialActive, false);
    assert.equal(abandoned.models[key]?.openUntil, failed.models[key]?.openUntil);
    assert.deepEqual(abandoned.models[key]?.failures, failed.models[key]?.failures);
    assert.equal(abandoned.models[key]?.lastFailureReason, "timeout");
    assert.equal(abandonTrial(abandoned, key), abandoned);
    assert.equal(abandonTrial(abandoned, "missing"), abandoned);
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

  it("half-open: failed trial reopens after prior failures age out of the window", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 60_000, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 120_000, "probe", "timeout");

    const trialAt = t0 + 63 * 60_000;
    assert.equal(getCircuitState(state, key, trialAt, cfg).halfOpen, true);
    state = beginTrial(state, key);
    state = recordModelFailure(state, key, cfg, trialAt, "trial", "timeout");

    const circuit = getCircuitState(state, key, trialAt, cfg);
    assert.equal(circuit.open, true);
    assert.equal(circuit.openUntil, trialAt + 120 * 60_000);
    assert.equal(circuit.recentFailures, 1);
    assert.equal(circuit.trialActive, false);
  });

  it("half-open: canceling an expired trial does not record a failure or reopen", () => {
    const cfg = { ...DEFAULT_RELIABILITY, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
    const key = "openai/gpt-5.4";
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    let state = emptyReliabilityState();
    state = recordModelFailure(state, key, cfg, t0, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 60_000, "probe", "timeout");
    state = recordModelFailure(state, key, cfg, t0 + 120_000, "probe", "timeout");

    const trialAt = t0 + 63 * 60_000;
    const trial = beginTrial(state, key);
    const canceled = abandonTrial(trial, key);
    const circuit = getCircuitState(canceled, key, trialAt, cfg);
    assert.equal(circuit.open, false);
    assert.equal(circuit.halfOpen, true);
    assert.equal(circuit.trialActive, false);
    assert.equal(circuit.recentFailures, 0);
    assert.equal(canceled.models[key]?.openUntil, state.models[key]?.openUntil);
    assert.equal(canceled.models[key]?.cooldownMultiplier, state.models[key]?.cooldownMultiplier);
  });
});
