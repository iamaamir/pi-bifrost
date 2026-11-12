import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe, DEFAULT_PROBE_CONCURRENCY, probeOptionsFromConfig, readRecentCompleteProbeReport, validateCompleteProbeReport } from "../probe.ts";
import { flushDebug, setupDebug } from "../debug.ts";
import { delay } from "./helpers.ts";
import { streamSimple as streamCodexSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";

describe("probe transport", () => {
  it("uses modelRegistry.streamSimple", async () => {
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
              stopReason: "stop",
              timestamp: Date.now(),
            }),
          }),
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

  it("does not send session fallback after a provider error, even when content is empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-provider-error-"));
    const model = { provider: "fixture", id: "limited", api: "openai-completions", cost: { input: 0, output: 0 } };
    const cwdBefore = process.cwd();
    let content: Array<{ type: string; text?: string }> = [];
    let fallbackCalls = 0;
    const ctx = {
      modelRegistry: {
        getAvailable: () => [model],
        streamSimple: () => ({
          result: async () => ({
            role: "assistant",
            api: "openai-completions",
            provider: model.provider,
            model: model.id,
            content,
            usage: { totalTokens: 0 },
            stopReason: "error",
            errorMessage: "HTTP 402: no remaining credits",
            timestamp: Date.now(),
          }),
        }),
      },
    } as never;

    try {
      process.chdir(cwd);
      for (const errorContent of [[], [{ type: "text", text: "partial" }]]) {
        content = errorContent;
        const result = await runProbe(ctx, { promptWithSession: async () => { fallbackCalls++; return "2"; } });
        assert.equal(result.results[0]?.status, "error");
      }
      assert.equal(fallbackCalls, 0);
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits unsupported temperature from the native Codex health request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-codex-temperature-"));
    const model = {
      provider: "openai-codex",
      id: "gpt-fixture",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: false,
      input: ["text"],
      contextWindow: 8_192,
      maxTokens: 4_096,
      cost: { input: 0.1, output: 0.1 },
    };
    const accountClaim = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
    })).toString("base64url");
    const syntheticJwt = `e30.${accountClaim}.synthetic-signature`;
    const cwdBefore = process.cwd();
    let payload: Record<string, unknown> | undefined;
    let probeOptions: Record<string, unknown> | undefined;

    try {
      const ctx = {
        modelRegistry: {
          getAvailable: () => [model],
          streamSimple: (requestModel: typeof model, context: unknown, options: Record<string, unknown>) => {
            probeOptions = options;
            return streamCodexSimple(requestModel as never, context as never, {
              ...options,
              apiKey: syntheticJwt,
              transport: "sse",
              maxRetries: 0,
              onPayload: (request: unknown) => { payload = request as Record<string, unknown>; },
              fetch: async () => {
                if (payload?.temperature !== undefined) {
                  return new Response(JSON.stringify({ error: { message: "Unsupported parameter: temperature" } }), {
                    status: 400,
                    headers: { "content-type": "application/json" },
                  });
                }
                const events = [
                  {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { id: "msg_fixture", type: "message", role: "assistant", content: [] },
                  },
                  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "2" },
                  {
                    type: "response.completed",
                    response: {
                      id: "resp_fixture",
                      status: "completed",
                      output: [{ id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "2", annotations: [] }] }],
                      usage: { input_tokens: 1, output_tokens: 1 },
                    },
                  },
                ];
                const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
                return new Response(sse, {
                  headers: { "content-type": "text/event-stream" },
                });
              },
            } as never);
          },
        },
      } as never;

      process.chdir(cwd);
      const result = await runProbe(ctx, { timeoutMs: 2_000 });
      assert.ok(probeOptions, "native Codex test stream was called");
      assert.ok(payload, "native Codex request payload was built");
      assert.equal(result.results[0]?.status, "ok", result.results[0]?.error ?? "probe did not succeed");
      assert.equal(payload?.temperature, undefined);
      assert.equal(payload?.model, "gpt-fixture");
      assert.equal(probeOptions?.temperature, undefined);
      assert.equal(probeOptions?.maxTokens, 5);
      assert.equal(probeOptions?.cacheRetention, "none");
      assert.ok(probeOptions?.signal instanceof AbortSignal);
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
    const TIMEOUT_MS = 500;

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
                    await new Promise<never>((_, reject) => {
                      const abort = () => reject(new DOMException("Aborted", "AbortError"));
                      if (signal.aborted) abort();
                      else signal.addEventListener("abort", abort, { once: true });
                    });
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

      // Verify concurrency limit (default cap)
      assert.ok(maxConcurrentWorkers <= DEFAULT_PROBE_CONCURRENCY, `max concurrent workers ${maxConcurrentWorkers} should not exceed ${DEFAULT_PROBE_CONCURRENCY}`);
      assert.ok(maxConcurrentWorkers >= DEFAULT_PROBE_CONCURRENCY || maxConcurrentWorkers === MODEL_COUNT, `should reach max concurrency of ${DEFAULT_PROBE_CONCURRENCY} or total models`);

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

describe("probe debug evidence", () => {
  it("records catalog identities, sanitized outcomes, and why an incomplete run was not cached", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-debug-"));
    const logPath = join(cwd, "probe.jsonl");
    const cwdBefore = process.cwd();
    const models = [
      { provider: "openai-codex", id: "gpt-fixture", api: "openai-codex-responses", cost: { input: 1, output: 2 } },
      { provider: "fixture", id: "limited", api: "openai-completions", cost: { input: 0, output: 0 } },
      { provider: "fixture", id: "healthy", api: "openai-completions", cost: { input: 1, output: 1 } },
      { provider: "fixture", id: "unsupported", api: "openai-completions", cost: { input: 1, output: 1 } },
      { provider: "openai-codex", id: "codex-auth", api: "openai-codex-responses" },
    ];
    const ctx = {
      modelRegistry: {
        getAvailable: () => models,
        streamSimple: (model: typeof models[number]) => ({ result: async () => model.id === "limited"
          ? ({ stopReason: "error", errorMessage: "secret=provider-token HTTP 429 quota exceeded" })
          : model.id === "unsupported"
            ? ({ stopReason: "error", errorMessage: "HTTP 400: Unsupported parameter: temperature secret=provider-token" })
            : model.id === "codex-auth"
              ? ({ stopReason: "error", errorMessage: "Failed to extract accountId from token" })
              : ({ stopReason: "stop", content: [{ type: "text", text: "2" }], usage: { totalTokens: 1 } }) }),
      },
    } as never;

    try {
      process.chdir(cwd);
      setupDebug({ enabled: true, path: logPath }, cwd);
      const result = await runProbe(ctx, { shouldProbe: (model) => model.id !== "gpt-fixture" });
      await flushDebug(1_000);
      const rows = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const outcomes = rows.filter((row) => row.event === "model_result");
      assert.equal(new Set(rows.map((row) => row.runId)).size, 1);
      assert.equal(result.results.length, 5);
      assert.deepEqual(outcomes.map(({ model, status, reason }) => [model, status, reason]).sort(), [
        ["gpt-fixture", "skipped", "not_eligible"],
        ["healthy", "ok", null],
        ["limited", "error", "rate_limited"],
        ["unsupported", "error", "unsupported_parameter"],
        ["codex-auth", "error", "authentication_or_access"],
      ].sort());
      assert.ok(rows.some((row) => row.event === "catalog" && row.modelCount === 5 && row.providerCounts["openai-codex"] === 2));
      const unsupported = outcomes.find((row) => row.model === "unsupported");
      assert.deepEqual([unsupported.reason, unsupported.httpStatus, unsupported.parameter], ["unsupported_parameter", 400, "temperature"]);
      const terminal = rows.find((row) => row.event === "complete");
      assert.equal(terminal.cache, "not_written");
      assert.equal(terminal.cacheReason, "incomplete_report");
      assert.equal(JSON.stringify(rows).includes("provider-token"), false);
      assert.equal(existsSync(join(cwd, ".pi", "bifrost-probe.json")), false);
    } finally {
      setupDebug({ enabled: false, path: logPath }, cwd);
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records callback failures before preserving the original rejection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-debug-callback-"));
    const logPath = join(cwd, "probe.jsonl");
    const cwdBefore = process.cwd();
    const failure = new Error("callback failure fixture");
    try {
      process.chdir(cwd);
      setupDebug({ enabled: true, path: logPath }, cwd);
      const model = { provider: "fixture", id: "one", api: "openai-completions", cost: { input: 1, output: 1 } };
      const ctx = { modelRegistry: { getAvailable: () => [model], streamSimple: () => ({ result: async () => ({
        stopReason: "stop", content: [{ type: "text", text: "2" }], usage: { totalTokens: 1 },
      }) }) } } as never;
      await assert.rejects(runProbe(ctx, { onProgress: () => { throw failure; } }), (error) => error === failure);
      await flushDebug(1_000);
      const rows = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(rows.find((row) => row.event === "complete").cacheReason, "worker_failed");
      assert.equal(rows.filter((row) => row.event === "model_result").length, 1);
    } finally {
      setupDebug({ enabled: false, path: logPath }, cwd);
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records cancellation as terminal and reports the partial result count", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-debug-cancel-"));
    const logPath = join(cwd, "probe.jsonl");
    const cwdBefore = process.cwd();
    const controller = new AbortController();
    const models = [{ provider: "fixture", id: "one", api: "openai-completions" }, { provider: "fixture", id: "two", api: "openai-completions" }];
    const ctx = { modelRegistry: { getAvailable: () => models, streamSimple: () => ({ result: () => new Promise(() => {}) }) } } as never;
    try {
      process.chdir(cwd);
      setupDebug({ enabled: true, path: logPath }, cwd);
      const pending = runProbe(ctx, { concurrency: 1, signal: controller.signal });
      await delay(5);
      controller.abort();
      const result = await pending;
      await flushDebug(1_000);
      const rows = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(result.cancelled, true);
      assert.equal(result.results[0]?.status, "skipped");
      assert.equal(rows.find((row) => row.event === "complete").cancelled, true);
      assert.equal(rows.find((row) => row.event === "complete").resultCount, 1);
      assert.equal(rows.find((row) => row.event === "complete").cacheReason, "cancelled");
    } finally {
      setupDebug({ enabled: false, path: logPath }, cwd);
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("probe concurrency and resilience", () => {
  const makeFastModel = (i: number) => ({
    provider: "test",
    id: `model-${i}`,
    api: "openai-completions",
    cost: { input: 1, output: 2 },
    baseUrl: "http://localhost/v1",
  });

  function makeFastCtx(models: ReturnType<typeof makeFastModel>[]) {
    return {
      modelRegistry: {
        getAvailable: () => models,
        streamSimple: () => ({
          result: async () => {
            await delay(10);
            return {
              role: "assistant",
              api: "openai-completions",
              provider: "test",
              model: "x",
              content: [{ type: "text", text: "ok" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
        }),
      },
    } as never;
  }

  it("stops claiming models and skips cache writes when cancelled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-cancel-"));
    const cwdBefore = process.cwd();
    const controller = new AbortController();
    let calls = 0;
    const models = [makeFastModel(0), makeFastModel(1), makeFastModel(2)];
    const ctx = {
      modelRegistry: {
        getAvailable: () => models,
        streamSimple: () => {
          calls++;
          return { result: () => new Promise(() => {}) };
        },
      },
    } as never;

    try {
      process.chdir(cwd);
      const probing = runProbe(ctx, { concurrency: 1, signal: controller.signal });
      await delay(5);
      controller.abort();
      const result = await probing;
      assert.equal(result.cancelled, true);
      assert.equal(calls, 1);
      assert.equal(result.results.length, 1);
      assert.equal(existsSync(join(cwd, ".pi", "bifrost-probe.json")), false);
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rechecks eligibility when each queued model reaches a worker", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-eligibility-"));
    const cwdBefore = process.cwd();
    const models = [makeFastModel(0), makeFastModel(1), makeFastModel(2)];
    const ctx = makeFastCtx(models) as unknown as { modelRegistry: { streamSimple: (...args: unknown[]) => unknown } };
    const streamSimple = ctx.modelRegistry.streamSimple;
    let providerCalls = 0;
    let eligible = true;
    ctx.modelRegistry.streamSimple = (...args) => {
      providerCalls++;
      return streamSimple(...args);
    };

    try {
      process.chdir(cwd);
      const result = await runProbe(ctx as never, {
        concurrency: 1,
        shouldProbe: () => eligible,
        onProgress: (done) => { if (done === 1) eligible = false; },
      });
      assert.equal(providerCalls, 1);
      assert.deepEqual(result.results.map(({ status, error }) => [status, error]), [
        ["ok", undefined],
        ["skipped", "model is no longer eligible"],
        ["skipped", "model is no longer eligible"],
      ]);
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("honors an explicit concurrency cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-cap-"));
    const cwdBefore = process.cwd();
    const models = Array.from({ length: 20 }, (_, i) => makeFastModel(i));
    let activeWorkers = 0;
    let maxConcurrentWorkers = 0;

    try {
      const ctx = makeFastCtx(models) as Parameters<typeof runProbe>[0];
      // Wrap streamSimple to observe in-flight workers.
      const registry = ctx.modelRegistry as unknown as {
        streamSimple: (...args: unknown[]) => { result: () => Promise<unknown> };
      };
      const innerStream = registry.streamSimple;
      registry.streamSimple = (...args: unknown[]) => {
        const stream = innerStream.apply(registry, args);
        return {
          result: async () => {
            activeWorkers++;
            maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
            try {
              return await stream.result();
            } finally {
              activeWorkers--;
            }
          },
        };
      };

      process.chdir(cwd);
      await runProbe(ctx, { concurrency: 4 });
      assert.ok(maxConcurrentWorkers <= 4, `max concurrent workers ${maxConcurrentWorkers} should not exceed 4`);
      assert.ok(maxConcurrentWorkers > 1, "should run some workers concurrently");
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns results even when writing the results file fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-iofail-"));
    const logPath = join(cwd, "probe.jsonl");
    const cwdBefore = process.cwd();

    try {
      setupDebug({ enabled: true, path: logPath }, cwd);
      // A file named ".pi" makes mkdir/write fail deterministically.
      writeFileSync(join(cwd, ".pi"), "not a directory");
      const ctx = makeFastCtx([makeFastModel(0)]) as Parameters<typeof runProbe>[0];
      process.chdir(cwd);
      const result = await runProbe(ctx, {});
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]?.status, "ok");
      await flushDebug(1_000);
      const terminal = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.event === "complete");
      assert.equal(terminal.cache, "error");
      assert.equal(terminal.cacheError, "write_failed");
    } finally {
      setupDebug({ enabled: false, path: logPath }, cwd);
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not overwrite a symlink target when saving probe results", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-symlink-"));
    const target = join(cwd, "user-data.json");
    const cwdBefore = process.cwd();

    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(target, "keep this file\n");
      symlinkSync(target, join(cwd, ".pi", "bifrost-probe.json"));
      const ctx = makeFastCtx([makeFastModel(0)]) as Parameters<typeof runProbe>[0];
      process.chdir(cwd);
      const result = await runProbe(ctx, {});
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(readFileSync(target, "utf8"), "keep this file\n");
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts only a complete, unique report for the current physical catalog", () => {
    const catalog = [{ provider: "fixture", id: "one" }, { provider: "fixture", id: "two" }];
    const first = { provider: "fixture", model: "one", status: "ok" };
    const second = { provider: "fixture", model: "two", status: "error" };
    assert.deepEqual(validateCompleteProbeReport([first, second], catalog), [first, second]);
    for (const invalid of [
      [first],
      [first, first],
      [first, { provider: "fixture", model: "other", status: "ok" }],
      [{ ...first, cost_input: Number.NaN }, second],
      [{ ...first, status: "skipped" }, second],
      [],
    ]) {
      assert.equal(validateCompleteProbeReport(invalid, catalog), undefined);
    }
  });

  it("reads probe bytes and freshness from one safe file snapshot", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-cache-"));
    const path = join(cwd, "bifrost-probe.json");
    const catalog = [{ provider: "fixture", id: "one" }];
    const report = [{ provider: "fixture", model: "one", status: "ok" }];
    try {
      writeFileSync(path, JSON.stringify(report));
      const recent = new Date(Date.now() - 60_000);
      utimesSync(path, recent, recent);
      assert.deepEqual(readRecentCompleteProbeReport(path, catalog), report);
      assert.deepEqual(readRecentCompleteProbeReport(path, catalog, statSync(path).mtimeMs - 0.5), report);
      assert.equal(readRecentCompleteProbeReport(path, catalog, statSync(path).mtimeMs - 1), undefined);
      const future = new Date(Date.now() + 60_000);
      utimesSync(path, future, future);
      assert.equal(readRecentCompleteProbeReport(path, catalog), undefined);
      const stale = new Date(Date.now() - 2 * 60 * 60_000);
      utimesSync(path, stale, stale);
      assert.equal(readRecentCompleteProbeReport(path, catalog), undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not replace the canonical cache after subset or skipped probes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-subset-cache-"));
    const cwdBefore = process.cwd();
    const path = join(cwd, ".pi", "bifrost-probe.json");
    const original = "[{\"preserve\":true}]\n";
    const models = [makeFastModel(0), makeFastModel(1)];
    const ctx = makeFastCtx(models) as Parameters<typeof runProbe>[0];
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(path, original);
      process.chdir(cwd);
      await runProbe(ctx, { models: [models[0] as never] });
      assert.equal(readFileSync(path, "utf8"), original);
      await runProbe(ctx, { shouldProbe: (model) => model.id !== "model-1" });
      assert.equal(readFileSync(path, "utf8"), original);
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never probes or caches virtual or classifier catalog models", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-virtual-"));
    const cwdBefore = process.cwd();
    const physical = makeFastModel(0);
    const virtual = { ...makeFastModel(1), provider: "bifrost", id: "auto", api: "pi-virtual" };
    const classifier = { ...makeFastModel(2), type: "classifier" };
    let calls = 0;
    const ctx = makeFastCtx([physical, virtual, classifier] as never) as Parameters<typeof runProbe>[0];
    const registry = ctx.modelRegistry as unknown as { streamSimple: (...args: unknown[]) => unknown };
    const original = registry.streamSimple;
    registry.streamSimple = (...args) => { calls++; return original(...args); };
    try {
      process.chdir(cwd);
      const result = await runProbe(ctx, { models: [physical, virtual, classifier] as never });
      assert.equal(calls, 1);
      assert.deepEqual(result.results.map(({ provider, model }) => [provider, model]), [["test", "model-0"]]);
      const report = JSON.parse(readFileSync(join(cwd, ".pi", "bifrost-probe.json"), "utf8")) as Array<{ provider: string; model: string }>;
      assert.deepEqual(report.map(({ provider, model }) => [provider, model]), [["test", "model-0"]]);
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("probeOptionsFromConfig", () => {
  it("forwards configured values and falls back to undefined", () => {
    assert.deepEqual(probeOptionsFromConfig({ concurrency: 8, timeoutMs: 5000 }), { concurrency: 8, timeoutMs: 5000 });
    assert.deepEqual(probeOptionsFromConfig({}), { concurrency: undefined, timeoutMs: undefined });
    assert.deepEqual(probeOptionsFromConfig(undefined), { concurrency: undefined, timeoutMs: undefined });
  });
});
