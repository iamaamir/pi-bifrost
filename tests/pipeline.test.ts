import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRouteDecisionSummary, createPipeline, type PipelineDeps } from "../classification-pipeline.ts";
import { debug, setupDebug } from "../debug.ts";
import { makeClassifierModel } from "./helpers.ts";

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    cacheLookup: () => undefined,
    classifierModels: [],
    classifyWithLLM: async () => undefined,
    regexRules: [],
    defaultTier: undefined,
    tiers: ["frontier", "economical"],
    ...overrides,
  };
}

describe("classification-pipeline", () => {
  it("disables external classification for an invalid total budget but keeps local fallback available", async () => {
    let directCalls = 0;
    let promptCalls = 0;
    const pipeline = createPipeline(deps({
      totalTimeoutMs: Number.NaN,
      classifyDirect: async () => { directCalls++; return { tier: "frontier", backend: "typesafe" }; },
      classifierModels: [makeClassifierModel("a", "one")],
      classifyWithLLM: async () => { promptCalls++; return "frontier"; },
      defaultTier: "economical",
    }));

    assert.deepEqual(await pipeline.classify("ordinary"), { kind: "fallback", tier: "economical" });
    assert.equal(directCalls, 0);
    assert.equal(promptCalls, 0);
  });

  it("shares an optional classifier deadline across attempts and falls through locally", async () => {
    const attempts: string[] = [];
    const pipeline = createPipeline(deps({
      totalTimeoutMs: 15,
      classifierModels: [makeClassifierModel("a", "one"), makeClassifierModel("b", "two")],
      classifyWithLLM: async (model, _text, _tiers, signal) => {
        attempts.push(model.kind === "registry" ? model.model.id : model.id);
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return undefined;
      },
      regexRules: [{ pattern: "hello", model: "economical" }],
    }));

    const result = await pipeline.classify("hello");
    assert.deepEqual(attempts, ["one"]);
    assert.deepEqual(result, { kind: "classified", tier: "economical", source: "regex", classificationOutcome: "deadline" });
    assert.equal(buildRouteDecisionSummary(result).classificationOutcome, "deadline");
  });

  it("uses the same deadline for the direct classifier and skips prompt fallback after expiry", async () => {
    let directCalls = 0;
    let promptCalls = 0;
    const pipeline = createPipeline(deps({
      totalTimeoutMs: 15,
      classifyDirect: async (_text, _tiers, signal) => {
        directCalls += 1;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return undefined;
      },
      classifierModels: [makeClassifierModel("a", "one")],
      classifyWithLLM: async () => { promptCalls += 1; return "frontier"; },
      defaultTier: "economical",
    }));
    const result = await pipeline.classify("ordinary");
    assert.equal(directCalls, 1);
    assert.equal(promptCalls, 0);
    assert.deepEqual(result, { kind: "fallback", tier: "economical", classificationOutcome: "deadline" });
  });

  it("passes caller cancellation through the direct classifier even without a total budget", async () => {
    const controller = new AbortController();
    let directCalls = 0;
    let promptCalls = 0;
    const pipeline = createPipeline(deps({
      classifyDirect: async (_text, _tiers, signal) => {
        directCalls += 1;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return undefined;
      },
      classifierModels: [makeClassifierModel("a", "one")],
      classifyWithLLM: async () => { promptCalls += 1; return "frontier"; },
      defaultTier: "economical",
    }));
    const resultPromise = pipeline.classify("ordinary", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.deepEqual(await resultPromise, { kind: "unclassified", classificationOutcome: "aborted" });
    assert.equal(directCalls, 1);
    assert.equal(promptCalls, 0);
  });

  it("does not launch a classifier whose Promise turn follows caller cancellation", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pipeline = createPipeline(deps({
      classifierModels: [makeClassifierModel("a", "one")],
      classifyWithLLM: async () => { calls++; return "frontier"; },
      defaultTier: "economical",
    }));
    const result = pipeline.classify("ordinary", controller.signal);
    controller.abort();
    assert.deepEqual(await result, { kind: "unclassified", classificationOutcome: "aborted" });
    assert.equal(calls, 0);
  });

  it("aborts prompt classification on caller cancellation and does not use local routing", async () => {
    const controller = new AbortController();
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const pipeline = createPipeline(deps({
      classifierModels: [makeClassifierModel("a", "one"), makeClassifierModel("b", "two")],
      classifyWithLLM: async (_model, _text, _tiers, signal) => {
        calls += 1;
        receivedSignal = signal;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return "frontier";
      },
      regexRules: [{ pattern: "hello", model: "economical" }],
      defaultTier: "frontier",
    }));
    const resultPromise = pipeline.classify("hello", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await resultPromise;
    assert.equal(calls, 1);
    assert.equal(receivedSignal?.aborted, true);
    assert.deepEqual(result, { kind: "unclassified", classificationOutcome: "aborted" });
  });

  it("does not accept or apply a late classifier result after deadline fallback", async () => {
    let finishLate: ((value: string | undefined) => void) | undefined;
    let attempts = 0;
    const pipeline = createPipeline(deps({
      totalTimeoutMs: 10,
      classifierModels: [makeClassifierModel("a", "one"), makeClassifierModel("b", "two")],
      classifyWithLLM: async () => {
        attempts++;
        return new Promise((resolve) => { finishLate = resolve; });
      },
      defaultTier: "economical",
    }));
    const result = await pipeline.classify("ordinary");
    assert.equal(attempts, 1);
    assert.deepEqual(result, { kind: "fallback", tier: "economical", classificationOutcome: "deadline" });
    finishLate?.("frontier");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(result, { kind: "fallback", tier: "economical", classificationOutcome: "deadline" });
    assert.equal(attempts, 1, "expiry must not start the second classifier model or reconsider the late result");
  });

  it("keeps the existing backend budget when no total deadline is configured", async () => {
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const pipeline = createPipeline(deps({
      classifierModels: [makeClassifierModel("a", "one")],
      classifyWithLLM: async (_model, _text, _tiers, signal) => {
        calls += 1;
        receivedSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return "frontier";
      },
    }));
    const result = await pipeline.classify("ordinary");
    assert.equal(calls, 1);
    assert.equal(receivedSignal, undefined);
    assert.deepEqual(result, { kind: "classified", tier: "frontier", source: "classifier", judgment: { tier: "frontier", backend: "prompt", model: "one" } });
  });

  it("can disable the process-global debug sink for isolated callers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-pipeline-debug-"));
    const logPath = join(directory, "debug.jsonl");
    setupDebug({ enabled: true, path: logPath }, directory);
    debug("pipeline-test", "baseline");
    let baseline: string | undefined;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        baseline = await readFile(logPath, "utf8");
        if (baseline.includes('"event":"baseline"')) break;
      } catch { /* async debug flush has not created the file yet */ }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    try {
      assert.ok(baseline?.includes('"event":"baseline"'));
      const pipeline = createPipeline(deps({
        instrumentation: "none",
        regexRules: [{ pattern: "hello", model: "frontier" }],
      }));
      const result = await pipeline.classify("hello");
      assert.equal(result.kind, "classified");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await readFile(logPath, "utf8"), baseline);
    } finally {
      setupDebug({ enabled: false, path: logPath }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("unclassified", () => {
    it("returns unclassified when no tiers configured", async () => {
      const p = createPipeline(deps({ tiers: [] }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "unclassified");
    });

    it("returns unclassified when nothing matches and no default", async () => {
      const p = createPipeline(deps({ defaultTier: undefined }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "unclassified");
    });
  });

  describe("cache", () => {
    it("returns classified from cache hit", async () => {
      const p = createPipeline(
        deps({ cacheLookup: () => "economical" }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "economical");
        assert.equal(r.source, "cache");
      }
    });

    it("skips cache when result is not a known tier", async () => {
      const p = createPipeline(
        deps({ cacheLookup: () => "unknown" }),
      );
      const r = await p.classify("hello");
      // Falls through to default
      assert.notEqual(r.kind, "classified");
    });

    it("keeps a valid cache hit ahead of the direct classifier observation seam", async () => {
      let directCalls = 0;
      const p = createPipeline(deps({
        cacheLookup: () => "frontier",
        classifyDirect: async () => {
          directCalls++;
          return { kind: "direct-classifier-attempt", observation: { backend: "typesafe", outcome: "timeout" } };
        },
      }));
      const result = await p.classify("cached");
      assert.equal(result.kind, "classified");
      if (result.kind === "classified") assert.equal(result.source, "cache");
      assert.equal(result.classifierAttempt, undefined);
      assert.equal(directCalls, 0);
    });
  });

  describe("classifier", () => {
    it("tries TypeSafe before existing prompt classifier", async () => {
      const calls: string[] = [];
      const p = createPipeline(deps({
        classifyDirect: async () => {
          calls.push("typesafe");
          return { tier: "frontier", backend: "typesafe", model: "jev-1.13.0", confidence: 0.93 };
        },
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => { calls.push("prompt"); return "economical"; },
      }));
      const r = await p.classify("debug this");
      assert.deepEqual(calls, ["typesafe"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.deepEqual(r.judgment, { tier: "frontier", backend: "typesafe", model: "jev-1.13.0", confidence: 0.93 });
      }
    });

    it("does not continue fallback work after TypeSafe cancellation", async () => {
      const controller = new AbortController();
      controller.abort();
      let promptCalled = false;
      const p = createPipeline(deps({
        classifyDirect: async () => undefined,
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => { promptCalled = true; return "frontier"; },
      }));
      const result = await p.classify("hello", controller.signal);
      assert.equal(result.kind, "unclassified");
      assert.equal(promptCalled, false);
    });

    it("falls from TypeSafe to prompt, then regex/default", async () => {
      const calls: string[] = [];
      const p = createPipeline(deps({
        classifyDirect: async () => { calls.push("typesafe"); return undefined; },
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => { calls.push("prompt"); return undefined; },
        regexRules: [{ pattern: "hello", model: "frontier" }],
        defaultTier: "economical",
      }));
      const r = await p.classify("hello");
      assert.deepEqual(calls, ["typesafe", "prompt"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") assert.equal(r.source, "regex");
    });

    it("uses TypeSafe miss with prompt fallback and default", async () => {
      const p = createPipeline(deps({
        classifyDirect: async () => undefined,
        classifierModels: [makeClassifierModel("a", "m1")],
        classifyWithLLM: async () => undefined,
        defaultTier: "economical",
      }));
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
    });

    it("keeps direct classifier degradation and the actual local fallback in content-free route summaries", async () => {
      const directFailure = {
        kind: "direct-classifier-attempt" as const,
        observation: {
          backend: "typesafe" as const,
          outcome: "timeout" as const,
          model: "jev-1.13.0",
          circuitOpenUntil: 1_900_000_000_000,
        },
      };
      const regexPipeline = createPipeline(deps({
        classifyDirect: async () => directFailure,
        regexRules: [{ pattern: "route-regex", model: "frontier" }],
        defaultTier: "economical",
      }));
      const regexResult = await regexPipeline.classify("route-regex with PRIVATE_PROMPT");
      assert.deepEqual(regexResult.classifierAttempt, { ...directFailure.observation, fallbackKind: "regex" });
      assert.deepEqual(buildRouteDecisionSummary(regexResult).classifierAttempt, regexResult.classifierAttempt);

      const defaultPipeline = createPipeline(deps({ classifyDirect: async () => directFailure, defaultTier: "economical" }));
      const defaultResult = await defaultPipeline.classify("unmatched PRIVATE_PROMPT");
      assert.equal(defaultResult.kind, "fallback");
      assert.equal(defaultResult.classifierAttempt?.fallbackKind, "default");
      assert.equal(JSON.stringify(buildRouteDecisionSummary(defaultResult)).includes("PRIVATE_PROMPT"), false);
    });

    it("retains prompt backend and model metadata", async () => {
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("fixture", "prompt-model")],
        classifyWithLLM: async () => ({ tier: "frontier", backend: "prompt", confidence: 0.81 }),
      }));
      const r = await p.classify("debug this");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.judgment?.backend, "prompt");
        assert.equal(r.judgment?.model, "prompt-model");
        assert.equal(r.judgment?.confidence, 0.81);
      }
    });

    it("uses first successful classifier model", async () => {
      let calls = 0;
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
          classifyWithLLM: async (model) => {
            calls++;
            if (model.kind === "registry" && model.model.id === "m1") return "frontier";
            return undefined;
          },
        }),
      );
      const r = await p.classify("debug this");
      assert.equal(calls, 1); // second model never tried
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.equal(r.source, "classifier");
      }
    });

    it("tries second model when first fails", async () => {
      let calls: string[] = [];
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1"), makeClassifierModel("b", "m2")],
          classifyWithLLM: async (model) => {
            calls.push(model.kind === "registry" ? model.model.id : model.id);
            if (model.kind === "registry" && model.model.id === "m2") return "economical";
            return undefined;
          },
        }),
      );
      const r = await p.classify("hello");
      assert.deepEqual(calls, ["m1", "m2"]);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "classifier");
      }
    });

    it("validates classifier result against known tiers", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => "unknown",
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello");
      // Unknown tier → falls through to default
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });

    it("skips classifier when classifierModels is empty", async () => {
      let called = false;
      const p = createPipeline(
        deps({
          classifierModels: [],
          classifyWithLLM: async () => { called = true; return "frontier"; },
          regexRules: [{ pattern: "hello", model: "frontier" }],
        }),
      );
      await p.classify("hello");
      assert.equal(called, false);
    });
  });

  describe("regex", () => {
    it("matches regex rule", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bdebug\\b", model: "frontier" }],
        }),
      );
      const r = await p.classify("debug the thing");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "frontier");
        assert.equal(r.source, "regex");
      }
    });

    it("matches regex rule with direct model reference", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bcommit\\b", model: "opencode-go/glm-5.1" }],
        }),
      );
      const r = await p.classify("commit the changes");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "opencode-go/glm-5.1");
        assert.equal(r.source, "regex");
      }
    });

    it("direct model reference bypasses tier lookup", async () => {
      // Model reference "unknown/model" is not in tiers, should still match.
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: ".*", model: "custom/model" }],
          tiers: ["frontier"],
        }),
      );
      const r = await p.classify("anything");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.tier, "custom/model");
      }
    });

    it("falls through to default when no rule matches", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: "\\bdebug\\b", model: "frontier" }],
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello world");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });

  describe("priority order", () => {
    it("does not skip an earlier matching tier rule to reach a later direct-model rule", async () => {
      let classifierCalled = false;
      const p = createPipeline(deps({
        classifierModels: [makeClassifierModel("fixture", "classifier")],
        classifyWithLLM: async () => {
          classifierCalled = true;
          return "economical";
        },
        regexRules: [
          { pattern: "debug", model: "frontier" },
          { pattern: "debug", model: "custom/direct-model" },
        ],
      }));

      const result = await p.classify("debug this");

      assert.equal(classifierCalled, true);
      assert.deepEqual(result, { kind: "classified", tier: "economical", source: "classifier", judgment: { tier: "economical", backend: "prompt", model: "classifier" } });
    });

    it("cache beats classifier", async () => {
      let classifierCalled = false;
      const p = createPipeline(
        deps({
          cacheLookup: () => "frontier",
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { classifierCalled = true; return "economical"; },
        }),
      );
      const r = await p.classify("test");
      assert.equal(classifierCalled, false);
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "cache");
      }
    });

    it("classifier beats regex", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => "economical",
          regexRules: [{ pattern: ".*", model: "frontier" }],
        }),
      );
      const r = await p.classify("test");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "classifier");
        assert.equal(r.tier, "economical");
      }
    });

    it("regex beats default", async () => {
      const p = createPipeline(
        deps({
          regexRules: [{ pattern: ".*", model: "frontier" }],
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("test");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "regex");
      }
    });
  });

  describe("fallback", () => {
    it("returns fallback when only default matches", async () => {
      const p = createPipeline(
        deps({ defaultTier: "economical" }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });

  describe("classifier error resilience", () => {
    it("catches classifier throw and falls through to regex", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { throw new Error("boom"); },
          regexRules: [{ pattern: ".*", model: "frontier" }],
        }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "classified");
      if (r.kind === "classified") {
        assert.equal(r.source, "regex");
      }
    });

    it("catches classifier throw and falls through to default", async () => {
      const p = createPipeline(
        deps({
          classifierModels: [makeClassifierModel("a", "m1")],
          classifyWithLLM: async () => { throw new Error("boom"); },
          defaultTier: "economical",
        }),
      );
      const r = await p.classify("hello");
      assert.equal(r.kind, "fallback");
      if (r.kind === "fallback") {
        assert.equal(r.tier, "economical");
      }
    });
  });
});
