import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  hostIsOmp,
  initHost,
  isOmpHost,
  inputContinue,
  inputTransform,
  refreshRegistry,
  streamSimpleVia,
  _resetHostForTests,
  _streamDeps,
} from "../host.ts";

describe("host compat seam", () => {
  beforeEach(() => {
    _resetHostForTests();
  });

  describe("hostIsOmp", () => {
    it("detects omp via the zod field", () => {
      assert.equal(hostIsOmp({ zod: {} }), true);
    });

    it("treats a Pi-shaped API (no zod) as Pi", () => {
      assert.equal(hostIsOmp({ on: () => {}, setModel: () => {} }), false);
      assert.equal(hostIsOmp(null), false);
      assert.equal(hostIsOmp("pi"), false);
    });
  });

  describe("initHost", () => {
    it("latches omp mode and reports it", () => {
      assert.equal(isOmpHost(), false);
      initHost({ zod: {} });
      assert.equal(isOmpHost(), true);
    });

    it("latches Pi mode by default", () => {
      initHost({});
      assert.equal(isOmpHost(), false);
    });
  });

  describe("input result mapping", () => {
    it("returns Pi action results on Pi", () => {
      initHost({});
      assert.deepEqual(inputContinue(), { action: "continue" });
      assert.deepEqual(inputTransform("fast"), { action: "transform", text: "fast" });
    });

    it("returns omp text-replacement results on omp", () => {
      initHost({ zod: {} });
      // omp: {} passes through; { text } replaces the prompt.
      assert.deepEqual(inputContinue(), {});
      assert.deepEqual(inputTransform("fast"), { text: "fast" });
    });
  });

  describe("refreshRegistry", () => {
    it("passes a signal options object on Pi", async () => {
      initHost({});
      const calls: unknown[] = [];
      const signal = new AbortController().signal;
      await refreshRegistry(
        { refresh: async (...args: unknown[]) => { calls.push(args); } } as never,
        signal,
      );
      assert.deepEqual(calls, [[{ signal }]]);
    });

    it("passes no args when no signal on Pi", async () => {
      initHost({});
      const calls: unknown[] = [];
      await refreshRegistry(
        { refresh: async (...args: unknown[]) => { calls.push(args); } } as never,
        undefined,
      );
      assert.deepEqual(calls, [[]]);
    });

    it("passes the omp refresh strategy on omp", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const signal = new AbortController().signal;
      await refreshRegistry(
        { refresh: async (...args: unknown[]) => { calls.push(args); } } as never,
        signal,
      );
      assert.deepEqual(calls, [["online-if-uncached"]]);
    });
  });

  describe("streamSimpleVia", () => {
    const model = {
      provider: "fixture",
      id: "m",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      cost: { input: 0, output: 0 },
    } as never;
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    const baseOptions = { maxTokens: 5 };

    it("prefers the registry method when present (Pi)", async () => {
      initHost({});
      const calls: unknown[] = [];
      const registry = {
        streamSimple: (...args: unknown[]) => {
          calls.push(args);
          return { marker: "registry" };
        },
      };
      const result = await streamSimpleVia(
        { modelRegistry: registry } as never,
        model,
        context,
        baseOptions,
      );
      assert.deepEqual(result, { marker: "registry" });
      assert.equal(calls.length, 1);
      assert.deepEqual((calls[0] as unknown[])[1], context);
    });

    it("falls back to the standalone function on omp", async () => {
      initHost({ zod: {} });
      const calls: Array<{ context: unknown; options: unknown }> = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, context: unknown, options: unknown) => {
        calls.push({ context, options });
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        const registry = { getApiKey: async () => "sk-test" };
        const result = await streamSimpleVia(
          { modelRegistry: registry } as never,
          model,
          context,
          baseOptions,
        );
        assert.deepEqual(result, { marker: "standalone" });
        assert.equal(calls.length, 1);
        assert.deepEqual((calls[0]!.options as { apiKey?: string }).apiKey, "sk-test");
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });

    it("passes the omp keyless sentinel through as the apiKey", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, _context: unknown, options: unknown) => {
        calls.push(options);
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        const registry = { getApiKey: async () => "N/A" };
        await streamSimpleVia({ modelRegistry: registry } as never, model, context, baseOptions);
        const options = calls[0] as { apiKey?: string };
        assert.equal(options.apiKey, "N/A");
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });

    it("sends the sentinel when the registry has no key at all", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, _context: unknown, options: unknown) => {
        calls.push(options);
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        // Keyless provider (e.g. local Ollama): no stored credential. omp's
        // providers throw MissingApiKeyError without a key, so the sentinel
        // must still be sent for the request to be issued.
        const registry = { getApiKey: async () => undefined };
        await streamSimpleVia({ modelRegistry: registry } as never, model, context, baseOptions);
        const options = calls[0] as { apiKey?: string };
        assert.equal(options.apiKey, "N/A");
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });

    it("does not override an explicit apiKey", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, _context: unknown, options: unknown) => {
        calls.push(options);
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        const registry = { getApiKey: async () => "sk-registry" };
        await streamSimpleVia(
          { modelRegistry: registry } as never,
          model,
          context,
          { ...baseOptions, apiKey: "sk-explicit" },
        );
        const options = calls[0] as { apiKey?: string };
        assert.equal(options.apiKey, "sk-explicit");
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });
  });
});
