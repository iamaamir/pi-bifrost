import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe, DEFAULT_PROBE_CONCURRENCY, probeOptionsFromConfig, probeResultsPath } from "../probe.ts";
import { delay } from "./helpers.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface FixtureModel {
  provider: string;
  id: string;
  api: string;
  cost: { input: number; output: number };
  baseUrl: string;
}

function textResponse(model: FixtureModel, text: string) {
  return {
    role: "assistant" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text" as const, text }],
    usage,
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function emptyResponse(model: FixtureModel, stopReason: "error" | "stop" = "error") {
  return {
    role: "assistant" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function modelFixture(id = "fixture", provider = "test"): FixtureModel {
  return { provider, id, api: "openai-completions", cost: { input: 0, output: 0 }, baseUrl: "https://example.invalid/v1" };
}

function context(cwd: string, model: FixtureModel, response: unknown) {
  return {
    cwd,
    modelRegistry: {
      getAvailable: () => [model],
      streamSimple: () => ({ result: async () => response }),
    },
  } as never;
}

function tempCwd(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("probe transport", () => {
  it("uses modelRegistry.streamSimple and persists under the context cwd", async () => {
    const cwd = tempCwd("bifrost-probe-");
    const repositoryProbe = join(process.cwd(), ".pi", "bifrost-probe.json");
    const repositoryBefore = existsSync(repositoryProbe) ? readFileSync(repositoryProbe) : undefined;
    const model = { ...modelFixture("gpt-5.4-mini", "openai-codex"), api: "openai-codex-responses" };
    try {
      const ctx = context(cwd, model, textResponse(model, "2"));
      const result = await runProbe(ctx, {});
      assert.equal(result.path, probeResultsPath(cwd));
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
      assert.equal(readFileSync(result.path, "utf8").trim(), JSON.stringify(result.results, null, 2));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const repositoryAfter = existsSync(repositoryProbe) ? readFileSync(repositoryProbe) : undefined;
    assert.deepEqual(
      repositoryAfter?.toString("utf8"),
      repositoryBefore?.toString("utf8"),
    );
  });

  it("falls back to a minimal session for an empty error response", async () => {
    const cwd = tempCwd("bifrost-probe-error-fallback-");
    const model = { ...modelFixture("gpt-5.4-mini", "openai-codex"), api: "openai-codex-responses" };
    try {
      const result = await runProbe(context(cwd, model, emptyResponse(model)), { promptWithSession: async () => "2" });
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.transport, "session");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a minimal session for an empty successful response", async () => {
    const cwd = tempCwd("bifrost-probe-stop-fallback-");
    const model = modelFixture("empty-stop");
    try {
      const result = await runProbe(context(cwd, model, emptyResponse(model, "stop")), { promptWithSession: async () => "2" });
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.transport, "session");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects fallback text that settles after the probe deadline", async () => {
    const cwd = tempCwd("bifrost-probe-late-fallback-");
    const model = modelFixture("late-fallback");
    try {
      const result = await runProbe(context(cwd, model, emptyResponse(model)), {
        timeoutMs: 10,
        promptWithSession: async () => {
          await delay(25);
          return "2";
        },
      });
      assert.equal(result.results[0]?.status, "timeout");
      assert.equal(result.results[0]?.error, "timeout");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("classifies partial aborted output as timeout before text", async () => {
    const cwd = tempCwd("bifrost-probe-aborted-");
    const model = modelFixture("aborted");
    const response = { ...textResponse(model, "partial"), stopReason: "aborted" as const };
    try {
      const result = await runProbe(context(cwd, model, response), {});
      assert.equal(result.results[0]?.status, "timeout");
      assert.equal(result.results[0]?.error, "timeout");
      assert.equal(result.path, probeResultsPath(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("recognizes host-neutral AbortError throws", async () => {
    const cwd = tempCwd("bifrost-probe-abort-error-");
    const model = modelFixture("abort-error");
    const ctx = {
      cwd,
      modelRegistry: {
        getAvailable: () => [model],
        streamSimple: () => { throw { name: "AbortError", message: "aborted" }; },
      },
    } as never;
    try {
      const result = await runProbe(ctx, {});
      assert.equal(result.results[0]?.status, "timeout");
      assert.equal(result.path, probeResultsPath(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("probe concurrency and persistence", () => {
  it("handles many models with bounded concurrency and timeout", async () => {
    const cwd = tempCwd("bifrost-probe-many-");
    const modelCount = 500;
    const models = Array.from({ length: modelCount }, (_, index) => ({ ...modelFixture(`model-${index}`), cost: { input: 1, output: 2 } }));
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const progress: number[] = [];
    try {
      const ctx = {
        cwd,
        modelRegistry: {
          getAvailable: () => models,
          streamSimple: (_model: (typeof models)[number], _messages: unknown, options: { signal: AbortSignal }) => {
            const index = models.indexOf(_model);
            const signal = options.signal;
            return {
              result: async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                try {
                  if (index % 2 === 0) {
                    await Promise.race([
                      delay(200),
                      new Promise<never>((_, reject) => {
                        if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
                        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
                      }),
                    ]);
                  } else {
                    await delay(10);
                  }
                  return textResponse(_model, "ok");
                } finally {
                  active--;
                  completed++;
                }
              },
            };
          },
        },
      } as never;
      const result = await runProbe(ctx, {
        timeoutMs: 50,
        onProgress: (done) => { progress.push(done); },
      });
      assert.equal(result.results.length, modelCount);
      assert.equal(completed, modelCount);
      assert.equal(progress.length, modelCount);
      assert.equal(progress.at(-1), modelCount);
      assert.ok(maxActive <= DEFAULT_PROBE_CONCURRENCY);
      assert.ok(maxActive > 1);
      assert.equal(result.results.filter((item) => item.status === "timeout").length, modelCount / 2);
      assert.equal(result.results.filter((item) => item.status === "ok").length, modelCount / 2);
      assert.equal(JSON.parse(readFileSync(result.path, "utf8")).length, modelCount);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("honors an explicit concurrency cap", async () => {
    const cwd = tempCwd("bifrost-probe-cap-");
    const models = Array.from({ length: 20 }, (_, index) => modelFixture(`model-${index}`));
    let active = 0;
    let maxActive = 0;
    try {
      const ctx = {
        cwd,
        modelRegistry: {
          getAvailable: () => models,
          streamSimple: (selected: (typeof models)[number]) => ({
            result: async () => {
              active++;
              maxActive = Math.max(maxActive, active);
              try {
                await delay(10);
                return textResponse(selected, "ok");
              } finally {
                active--;
              }
            },
          }),
        },
      } as never;
      await runProbe(ctx, { concurrency: 4 });
      assert.ok(maxActive <= 4);
      assert.ok(maxActive > 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns results when persistence fails", async () => {
    const cwd = tempCwd("bifrost-probe-iofail-");
    writeFileSync(join(cwd, ".pi"), "not a directory");
    const model = modelFixture("io-failure");
    try {
      const result = await runProbe(context(cwd, model, textResponse(model, "ok")), {});
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]?.status, "ok");
    } finally {
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
