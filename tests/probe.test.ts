import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe } from "../probe.ts";
import { delay } from "./helpers.ts";

describe("probe transport", () => {
  it("uses provider.streamSimple", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-"));
    const model = {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      cost: { input: 0.75, output: 4.5 },
      baseUrl: "https://example.invalid/v1",
    };
    const cwdBefore = process.cwd();

    try {
      const ctx = {
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [{ type: "text", text: "2" }],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      process.chdir(cwd);
      const result = await runProbe(ctx, {});
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to minimal session when stream is empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-"));
    const model = {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      cost: { input: 0.75, output: 4.5 },
      baseUrl: "https://example.invalid/v1",
    };
    const cwdBefore = process.cwd();

    try {
      const ctx = {
        cwd,
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: "empty response",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      process.chdir(cwd);
      const result = await runProbe(ctx, { promptWithSession: async () => "2" });
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("probe with many models and slow responses", () => {
  it("handles 500 models with mixed fast/slow responses, respects concurrency and timeout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-500-"));
    const cwdBefore = process.cwd();
    const MODEL_COUNT = 500;
    const TIMEOUT_MS = 50; // short timeout for fast test
    const SLOW_DELAY_MS = 200; // longer than timeout -> timeout status
    const FAST_DELAY_MS = 10; // shorter than timeout -> ok status

    // Create 500 models: even indices are slow, odd are fast
    const models = Array.from({ length: MODEL_COUNT }, (_, i) => ({
      provider: "test",
      id: `model-${i}`,
      api: "openai-completions",
      cost: { input: 1, output: 2 },
      baseUrl: "http://localhost/v1",
    }));

    let activeWorkers = 0;
    let maxConcurrentWorkers = 0;
    let completed = 0;
    const progressCalls: Array<{ done: number; total: number }> = [];

    try {
      const ctx = {
        modelRegistry: {
          getAvailable: () => models,
          getProvider: () => ({
            streamSimple: (_model: typeof models[0], _messages: unknown, options: { signal: AbortSignal }) => {
              const model = _model;
              const signal = options.signal;
              const index = models.indexOf(model);
              const isSlow = index % 2 === 0;
              return {
                result: async () => {
                  activeWorkers++;
                  maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
                  try {
                    if (isSlow) {
                      await Promise.race([
                        delay(SLOW_DELAY_MS),
                        new Promise<never>((_, reject) => {
                          if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
                          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
                        }),
                      ]);
                    } else {
                      await delay(FAST_DELAY_MS);
                    }
                    return {
                      role: "assistant",
                      api: "openai-completions",
                      provider: model.provider,
                      model: model.id,
                      content: [{ type: "text", text: "ok" }],
                      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                      stopReason: "stop",
                      timestamp: Date.now(),
                    };
                  } finally {
                    activeWorkers--;
                    completed++;
                  }
                },
              };
            },
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      process.chdir(cwd);
      const result = await runProbe(ctx, {
        timeoutMs: TIMEOUT_MS,
        onProgress: (done, total, last) => {
          progressCalls.push({ done, total });
          assert.equal(total, MODEL_COUNT);
          assert.equal(last.provider, "test");
        },
      });

      // Verify results count
      assert.equal(result.results.length, MODEL_COUNT);

      // Verify all models have a result in correct order
      for (let i = 0; i < MODEL_COUNT; i++) {
        const r = result.results[i];
        assert.equal(r?.provider, "test");
        assert.equal(r?.model, `model-${i}`);
      }

      // Verify slow models timed out, fast models succeeded
      let timeoutCount = 0;
      let okCount = 0;
      for (let i = 0; i < MODEL_COUNT; i++) {
        const r = result.results[i];
        const isSlow = i % 2 === 0;
        if (isSlow) {
          assert.equal(r?.status, "timeout", `model-${i} should be timeout`);
          timeoutCount++;
        } else {
          assert.equal(r?.status, "ok", `model-${i} should be ok`);
          okCount++;
        }
      }
      assert.equal(timeoutCount, Math.ceil(MODEL_COUNT / 2));
      assert.equal(okCount, Math.floor(MODEL_COUNT / 2));

      // Verify concurrency limit (max 50 workers)
      assert.ok(maxConcurrentWorkers <= 50, `max concurrent workers ${maxConcurrentWorkers} should not exceed 50`);
      assert.ok(maxConcurrentWorkers >= 50 || maxConcurrentWorkers === MODEL_COUNT, `should reach max concurrency of 50 or total models`);

      // Verify progress was called for each completion
      assert.equal(progressCalls.length, MODEL_COUNT);
      assert.equal(progressCalls[progressCalls.length - 1]?.done, MODEL_COUNT);

      // Verify results are written to file
      const probePath = join(cwd, ".pi", "bifrost-probe.json");
      const probeData = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(probePath, "utf-8")));
      assert.equal(probeData.length, MODEL_COUNT);
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
