import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  agentEndContinues,
  hostIsOmp,
  initHost,
  inputHandled,
  isOmpHost,
  isProjectTrusted,
  typeSafeCredentialOptions,
  inputContinue,
  inputTransform,
  refreshRegistry,
  streamSimpleVia,
  OMP_NO_AUTH,
  _hostDeps,
  _resetHostForTests,
  _streamDeps,
} from "../host.ts";

// The Pi host package this test runs against reports ".pi".
const hostConfigDirName = _hostDeps.configDirName;

describe("host compat seam", () => {
  beforeEach(() => {
    _resetHostForTests();
    _hostDeps.configDirName = hostConfigDirName;
  });

  describe("hostIsOmp", () => {
    it("detects omp from the host config dir name alone", () => {
      _hostDeps.configDirName = ".omp";
      assert.equal(hostIsOmp({ on: () => {} }), true);
    });

    it("detects omp via the zod field", () => {
      assert.equal(hostIsOmp({ zod: {} }), true);
    });

    it("treats a Pi-shaped API (no zod) as Pi", () => {
      assert.equal(hostConfigDirName, ".pi");
      assert.equal(hostIsOmp({ on: () => {}, setModel: () => {} }), false);
      assert.equal(hostIsOmp(null), false);
      assert.equal(hostIsOmp("pi"), false);
    });
  });

  describe("agentEndContinues", () => {
    it("retains OMP willContinue and isTerminal lifecycle compatibility", () => {
      assert.equal(agentEndContinues({ willContinue: true }), true);
      assert.equal(agentEndContinues({ isTerminal: false }), true);
      assert.equal(agentEndContinues({ willContinue: false }), false);
      assert.equal(agentEndContinues({ isTerminal: true }), false);
      assert.equal(agentEndContinues({}), false);
      assert.equal(agentEndContinues({ willContinue: "yes" }), false);
      assert.equal(agentEndContinues(undefined), false);
      assert.equal(agentEndContinues(null), false);
    });
  });

  it("uses the host project trust API with OMP compatibility", () => {
    initHost({ zod: {} });
    assert.equal(isProjectTrusted({ isProjectTrusted: () => true } as never), true);
    initHost({});
    assert.equal(isProjectTrusted({ isProjectTrusted: () => false } as never), false);
  });

  it("maps handled results for both hosts", () => {
    initHost({});
    assert.deepEqual(inputHandled(), { action: "handled" });
    initHost({ zod: {} });
    assert.deepEqual(inputHandled(), { handled: true });
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

  describe("TypeSafe credential guidance", () => {
    it("keeps Pi's supported auth-file guidance on Pi", () => {
      initHost({});
      const hint = typeSafeCredentialOptions("TYPESAFE_API_KEY");
      assert.match(hint, /~\/\.pi\/agent\/auth\.json/);
      assert.match(hint, /TYPESAFE_API_KEY/);
    });

    it("uses portable environment guidance on OMP", () => {
      initHost({ zod: {} });
      const hint = typeSafeCredentialOptions("TYPESAFE_API_KEY");
      assert.match(hint, /TYPESAFE_API_KEY environment variable/);
      assert.doesNotMatch(hint, /auth\.json|\.pi/);
    });

    it("uses the OMP config signal before host initialization", () => {
      _hostDeps.configDirName = ".omp";
      const hint = typeSafeCredentialOptions("TYPESAFE_API_KEY");
      assert.match(hint, /TYPESAFE_API_KEY environment variable/);
      assert.doesNotMatch(hint, /auth\.json|\.pi/);
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


    it("uses OMP session resolver and forwards cwd, signal, and session identity", async () => {
      initHost({ zod: {} });
      const calls: Array<{ context: unknown; options: { apiKey?: unknown; cwd?: string; sessionId?: string; signal?: AbortSignal } }> = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, context: unknown, options: unknown) => {
        calls.push({ context, options: options as { apiKey?: unknown; cwd?: string; sessionId?: string; signal?: AbortSignal } });
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        const signal = new AbortController().signal;
        const resolverCalls: unknown[] = [];
        const ctx = {
          cwd: "/project/omp",
          signal,
          sessionManager: { getSessionId: () => "session-1" },
          modelRegistry: {
            resolver: (...args: unknown[]) => {
              resolverCalls.push(args);
              return "resolver";
            },
            getApiKey: async () => "stale",
          },
        };
        await streamSimpleVia(ctx as never, model, context, { signal });
        assert.deepEqual(resolverCalls, [[model, "session-1"]]);
        assert.equal(calls[0]?.options.apiKey, "resolver");
        assert.equal(calls[0]?.options.cwd, "/project/omp");
        assert.equal(calls[0]?.options.sessionId, "session-1");
        assert.equal(calls[0]?.options.signal, signal);
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
        const registry = { getApiKey: async () => OMP_NO_AUTH };
        await streamSimpleVia({ modelRegistry: registry } as never, model, context, baseOptions);
        const options = calls[0] as { apiKey?: string };
        assert.equal(options.apiKey, OMP_NO_AUTH);
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });

    it("does not invent a key when the resolver returns no credential", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, _context: unknown, options: unknown) => {
        calls.push(options);
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        // OMP returns the explicit "N/A" sentinel for keyless providers.
        // Undefined means a normal provider has no resolved credential and
        // must not be turned into a fake key.
        const registry = { getApiKey: async () => undefined };
        await streamSimpleVia({ modelRegistry: registry } as never, model, context, baseOptions);
        const options = calls[0] as { apiKey?: string };
        assert.equal("apiKey" in options, false);
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });

    it("propagates a credential resolution failure without faking credentials", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, _context: unknown, options: unknown) => {
        calls.push(options);
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        // OAuth refresh / broker / credential-command failures are real
        // errors: they must reach the caller, not become the no-auth
        // sentinel that turns a credential problem into a confusing 401.
        const registry = {
          getApiKey: async () => {
            throw new Error("credential resolution failed");
          },
        };
        await assert.rejects(
          streamSimpleVia({ modelRegistry: registry } as never, model, context, baseOptions),
          /credential resolution failed/,
        );
        assert.equal(calls.length, 0, "must not stream with substituted credentials");
      } finally {
        _streamDeps.standaloneStreamSimple = original;
      }
    });

    it("does not invent a key when the registry has no credential resolver", async () => {
      initHost({ zod: {} });
      const calls: unknown[] = [];
      const original = _streamDeps.standaloneStreamSimple;
      _streamDeps.standaloneStreamSimple = ((_model: unknown, _context: unknown, options: unknown) => {
        calls.push(options);
        return { marker: "standalone" };
      }) as unknown as typeof _streamDeps.standaloneStreamSimple;
      try {
        await streamSimpleVia({ modelRegistry: {} } as never, model, context, baseOptions);
        const options = calls[0] as { apiKey?: string };
        assert.equal("apiKey" in options, false);
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
