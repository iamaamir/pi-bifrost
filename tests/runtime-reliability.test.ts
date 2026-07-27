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
  recordModelFailure,
  recordModelSuccess,
  reliabilityPath,
  saveReliability,
} from "../reliability.ts";
import { makeCtx, makeModel } from "./helpers.ts";

describe("runtime reliability simulation", () => {
  it("opens circuit on runtime failure, routes around it, then closes after successful probe", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-"));
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

      const first = resolveModelWithFallback(ctx, {
        requestedTier: "frontier",
        requestedPattern: frontierPattern,
        requestedStrategy: "first",
        defaultTier: "economical",
        defaultPattern: economicalPattern,
        defaultStrategy: "first",
        reliabilityState: state,
        reliabilityConfig: cfg,
        now: t0,
      });
      assert.equal(modelKey(first.selected), "openai/gpt-5.4");
      assert.equal(first.fallbackReason, undefined);

      state = recordModelFailure(state, "openai/gpt-5.4", cfg, t0, "setModel", "setModel returned false");
      saveReliability(path, state);

      const afterFailure = loadReliability(path);
      assert.ok(afterFailure.models["openai/gpt-5.4"]?.openUntil, "circuit should open after runtime failure");

      const second = resolveModelWithFallback(ctx, {
        requestedTier: "frontier",
        requestedPattern: frontierPattern,
        requestedStrategy: "first",
        defaultTier: "economical",
        defaultPattern: economicalPattern,
        defaultStrategy: "first",
        reliabilityState: afterFailure,
        reliabilityConfig: cfg,
        now: t0 + 1,
      });
      assert.equal(modelKey(second.selected), "openai/gpt-4.1-mini");
      assert.equal(second.selectedTier, "economical");
      assert.equal(second.fallbackReason, "requested_tier_unhealthy");

      const afterProbe = recordModelSuccess(afterFailure, "openai/gpt-5.4", t0 + 2, "probe");
      saveReliability(path, afterProbe);
      const reopened = loadReliability(path);
      assert.equal(reopened.models["openai/gpt-5.4"]?.openUntil, undefined);
      assert.deepEqual(reopened.models["openai/gpt-5.4"]?.failures ?? [], []);

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
      assert.equal(third.fallbackReason, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
