import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  categoryLabel,
  classificationPrompt,
  classifyWithLLM,
  extractCategory,
} from "../classifier.ts";
import { makeModel } from "./helpers.ts";

describe("classifier", () => {
  describe("categoryLabel", () => {
    it("returns category name unchanged", () => {
      assert.equal(categoryLabel("frontier"), "frontier");
      assert.equal(categoryLabel("economical"), "economical");
      assert.equal(categoryLabel("local"), "local");
    });
  });

  describe("classificationPrompt", () => {
    it("lists categories by name", () => {
      const prompt = classificationPrompt(["frontier", "economical"], "hello");
      assert.ok(prompt.includes("frontier, economical"));
      assert.ok(prompt.includes("Request: hello"));
    });
  });

  it("routes registry classification through modelRegistry.streamSimple", async () => {
    let observedContext: { systemPrompt?: string; messages?: unknown[] } | undefined;
    let observedOptions: { maxTokens?: number; cacheRetention?: string } | undefined;
    const model = {
      provider: "fixture",
      id: "classifier",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      cost: { input: 0, output: 0 },
    };
    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      modelRegistry: {
        streamSimple: (_model: unknown, context: typeof observedContext, options: typeof observedOptions) => {
          observedContext = context;
          observedOptions = options;
          return {
            result: async () => ({
              role: "assistant",
              api: "openai-completions",
              provider: "fixture",
              model: "classifier",
              content: [{ type: "text", text: "frontier" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            }),
          };
        },
      },
    };

    const result = await classifyWithLLM(
      ctx as never,
      { kind: "registry", model } as never,
      ["quick", "frontier"],
      "design the architecture",
      { method: "direct" },
    );

    assert.equal(result, "frontier");
    assert.match(observedContext?.systemPrompt ?? "", /routing classifier/);
    assert.equal(observedContext?.messages?.length, 1);
    assert.equal(observedOptions?.maxTokens, 20);
    assert.equal(observedOptions?.cacheRetention, "none");
  });

  it("propagates caller abort to registry classification and skips paid fallbacks", async () => {
    const controller = new AbortController();
    let registrySignal: AbortSignal | undefined;
    let subprocessCalls = 0;
    const classifierModel = { kind: "registry" as const, model: makeModel("fixture", "classifier") };
    const ctx = {
      cwd: process.cwd(),
      modelRegistry: {
        streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
          registrySignal = options.signal;
          return {
            result: () => new Promise((resolve) => {
              options.signal?.addEventListener("abort", () => resolve({ content: [] }), { once: true });
            }),
          };
        },
      },
    } as never;
    const resultPromise = classifyWithLLM(ctx, classifierModel, ["frontier"], "request", {
      method: "auto",
      spawnImpl: (() => { subprocessCalls += 1; throw new Error("must not spawn after abort"); }) as unknown as typeof import("node:child_process").spawn,
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await resultPromise, undefined);
    assert.equal(registrySignal?.aborted, true);
    assert.equal(subprocessCalls, 0);
  });

  it("propagates caller abort to prompt HTTP fetch", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const classifierModel = { kind: "endpoint" as const, id: "fixture-classifier", baseUrl: "https://example.invalid/v1" };
    const ctx = { cwd: process.cwd() } as never;
    const resultPromise = classifyWithLLM(ctx, classifierModel, ["frontier"], "request", {
      method: "direct",
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        });
      },
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await resultPromise, undefined);
    assert.equal(requestSignal?.aborted, true);
  });

  it("terminates only its owned prompt subprocess when caller aborts", async () => {
    const controller = new AbortController();
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const kills: string[] = [];
    child.kill = (signal) => {
      kills.push(signal ?? "default");
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const classifierModel = { kind: "registry" as const, model: makeModel("fixture", "classifier") };
    const ctx = { cwd: process.cwd() } as never;
    const resultPromise = classifyWithLLM(ctx, classifierModel, ["frontier"], "request", {
      method: "subprocess",
      spawnImpl: (() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn,
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await resultPromise, undefined);
    assert.deepEqual(kills, ["SIGTERM"]);
  });

  describe("extractCategory", () => {
    it("extracts exact category name", () => {
      assert.equal(extractCategory("frontier", ["frontier", "economical"]), "frontier");
    });

    it("is case-insensitive", () => {
      assert.equal(extractCategory("Frontier", ["frontier", "economical"]), "frontier");
    });

    it("handles surrounding whitespace", () => {
      assert.equal(extractCategory("  economical  ", ["frontier", "economical"]), "economical");
    });

    it("returns undefined for non-matching text", () => {
      assert.equal(extractCategory("unknown", ["frontier", "economical"]), undefined);
    });

    it("does not substring match", () => {
      // "not economical" should not match "economical"
      assert.equal(extractCategory("not economical", ["frontier", "economical"]), undefined);
    });
  });
});
