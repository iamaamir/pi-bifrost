import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categoryLabel, classificationPrompt, classifyWithLLM, extractCategory, _classifierDeps } from "../classifier.ts";
import { _subprocessDeps, classifierSubprocessInvocation, initHost, _processDeps } from "../host.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

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


  it("passes subprocess prompts through stdin and cancels the child", async () => {
    const originalSpawn = _classifierDeps.spawn;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    let received = "";
    let killed = false;
    child.stdin = stdin;
    child.stdout = new PassThrough() as never;
    child.stderr = new PassThrough() as never;
    child.kill = (() => { killed = true; return true; }) as never;
    stdin.on("data", (chunk) => { received += String(chunk); });
    _classifierDeps.spawn = (() => child) as unknown as typeof originalSpawn;
    const controller = new AbortController();
    try {
      initHost({});
      const model = { provider: "fixture", id: "classifier", api: "openai-completions", baseUrl: "https://example.invalid/v1", cost: { input: 0, output: 0 } } as never;
      const ctx = { cwd: process.cwd(), modelRegistry: {} } as never;
      const pending = classifyWithLLM(ctx, { kind: "registry", model }, ["quick"], "hello", { method: "subprocess", signal: controller.signal });
      controller.abort();
      assert.equal(await pending, undefined);
      assert.equal(killed, true);
      assert.match(received, /Request: hello/);
    } finally {
      _classifierDeps.spawn = originalSpawn;
    }
  });

  it("turns an early stdin EPIPE into one classifier miss", async () => {
    const originalSpawn = _classifierDeps.spawn;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    let kills = 0;
    child.stdin = stdin;
    child.stdout = new PassThrough() as never;
    child.stderr = new PassThrough() as never;
    child.kill = (() => { kills++; return true; }) as never;
    _classifierDeps.spawn = (() => child) as unknown as typeof originalSpawn;
    try {
      initHost({});
      const model = { provider: "fixture", id: "classifier", api: "openai-completions", baseUrl: "https://example.invalid/v1", cost: { input: 0, output: 0 } } as never;
      const ctx = { cwd: process.cwd(), modelRegistry: {} } as never;
      const pending = classifyWithLLM(ctx, { kind: "registry", model }, ["quick"], "hello", { method: "subprocess" });
      stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      child.emit("close", 0);
      assert.equal(await pending, undefined);
      assert.equal(kills, 1);
    } finally {
      _classifierDeps.spawn = originalSpawn;
    }
  });

  it("builds supported OMP subprocess flags without placing the prompt in argv", () => {
    initHost({ zod: {} });
    const previous = { ..._processDeps };
    const previousExists = _subprocessDeps.existsSync;
    _processDeps.execPath = "/tmp/omp";
    _processDeps.argv0 = "/tmp/omp";
    _processDeps.entry = "/tmp/omp";
    _subprocessDeps.existsSync = () => true;
    try {
      const model = { provider: "fixture", id: "classifier", api: "openai-completions", baseUrl: "https://example.invalid/v1", cost: { input: 0, output: 0 } } as never;
      const invocation = classifierSubprocessInvocation({ cwd: "/project" } as never, model, "classifier system");
      assert.ok(invocation);
      assert.ok(invocation.args.includes("--no-tools"));
      assert.ok(invocation.args.includes("--no-extensions"));
      assert.ok(invocation.args.includes("--no-session"));
      assert.ok(invocation.args.includes("--print"));
      assert.equal(invocation.args.some((arg) => arg.includes("hello")), false);
    } finally {
      Object.assign(_processDeps, previous);
      _subprocessDeps.existsSync = previousExists;
    }
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
