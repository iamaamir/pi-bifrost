import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelKey, resolveModelWithFallback } from "../routing.ts";
import {
  DEFAULT_RELIABILITY,
  emptyReliabilityState,
  loadReliability,
  recordModelSuccess,
  recordSetModelOutcome,
  reliabilityPath,
  saveReliability,
} from "../reliability.ts";
import { makeCtx, makeModel } from "./helpers.ts";

describe("runtime setModel failure handling", () => {
  it("records circuit failure when setModel returns false or throws", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-setmodel-"));
    const bad = makeModel("openai", "gpt-5.4", 10, 10);
    const good = makeModel("openai", "gpt-4.1-mini", 1, 1);
    const ctx = makeCtx([bad, good]);
    const cfg = {
      ...DEFAULT_RELIABILITY,
      failureThreshold: 1,
      windowMinutes: 5,
      cooldownMinutes: 60,
    };
    const frontierPattern = ["openai/gpt-5.4"];
    const economicalPattern = ["openai/gpt-4.1-mini"];
    const path = reliabilityPath(cwd);
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    try {
      let state = emptyReliabilityState();

      // Simulate setModel returning false (no API key)
      state = recordSetModelOutcome(state, "openai/gpt-5.4", cfg, t0, false, "setModel returned false");
      saveReliability(path, state);
      const afterFalse = loadReliability(path);
      assert.ok(afterFalse.models["openai/gpt-5.4"]?.openUntil, "circuit should open after false return");

      // Should route around bad model
      const second = resolveModelWithFallback(ctx, {
        requestedTier: "frontier",
        requestedPattern: frontierPattern,
        requestedStrategy: "first",
        defaultTier: "economical",
        defaultPattern: economicalPattern,
        defaultStrategy: "first",
        reliabilityState: afterFalse,
        reliabilityConfig: cfg,
        now: t0 + 1,
      });
      assert.equal(modelKey(second.selected), "openai/gpt-4.1-mini");

      // Simulate setModel throwing (auth error)
      let state2 = emptyReliabilityState();
      state2 = recordSetModelOutcome(state2, "openai/gpt-5.4", cfg, t0, false, "setModel threw");
      saveReliability(path, state2);
      const afterThrow = loadReliability(path);
      assert.ok(afterThrow.models["openai/gpt-5.4"]?.openUntil, "circuit should open after throw");

      // Successful probe closes circuit
      const afterProbe = recordModelSuccess(afterThrow, "openai/gpt-5.4", t0 + 2, "probe");
      saveReliability(path, afterProbe);
      const reopened = loadReliability(path);
      assert.equal(reopened.models["openai/gpt-5.4"]?.openUntil, undefined);

      // Original model selectable again
      const third = resolveModelWithFallback(ctx, {
        requestedTier: "frontier",
        requestedPattern: frontierPattern,
        requestedStrategy: "first",
        defaultTier: "economical",
        defaultPattern: economicalPattern,
        defaultStrategy: "first",
        reliabilityState: reopened,
        reliabilityConfig: cfg,
        now: t0 + 3,
      });
      assert.equal(modelKey(third.selected), "openai/gpt-5.4");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not record when setModel succeeds", () => {
    const state = recordSetModelOutcome(
      emptyReliabilityState(),
      "openai/gpt-5.4",
      DEFAULT_RELIABILITY,
      Date.UTC(2026, 0, 1, 12, 0, 0),
      true,
      "setModel returned false",
    );
    assert.deepEqual(state, emptyReliabilityState());
  });
});
