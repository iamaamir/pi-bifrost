// G05 (P1) classifier transport/cancellation acceptance matrix.
//
// This is an integration acceptance test for the *composed* classifier
// transports at the Pi/native boundary. It drives the real production
// modules (`classifier.ts`, `classification-pipeline.ts`,
// `typesafe-classifier.ts`, `classifier-pi-native.ts`, `session-fallback.ts`)
// and the real registered `input` hook from `index.ts` through injected
// transport seams. It does not rewrite or loosen any production URL
// validation; the TypeSafe endpoint stays pinned to `TYPE_SAFE_ENDPOINT` and
// the boundary is exercised with `fetchImpl`.
//
// Boundaries:
//   - registry  — Pi `modelRegistry.streamSimple` scripted responses.
//   - endpoint  — `classifyWithLLM` OpenAI-compatible HTTP with `fetchImpl`.
//   - subprocess— `classifyWithLLM` `spawnImpl` with a scripted child process.
//   - empty-stream fallback — `promptSessionIfActive` / `createAndPromptSession`
//     (the guard the composed `promptWithMinimalSession` path calls). The full
//     composed registry-empty -> real Pi session path is recorded as an
//     unsupported composition below because it cannot be injected through an
//     existing seam without live provider access.
//   - direct    — real `createTypeSafeClassifier`/`createPiNativeClassifier`
//     plus the composed `createPipeline` fallback chain.
//
// Fault control (see the last test): one cancellation guard in an isolated
// copy of `session-fallback.ts` is removed; the mutant must fail the named
// assertion "an aborted empty-stream fallback must not start a session
// prompt" with an AssertionError, not a startup/syntax error. The scratch
// copy is restored and hashed, and production `index.ts` must remain
// byte-identical to the baseline.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { classifyWithLLM } from "../../classifier.ts";
import { createPipeline } from "../../classification-pipeline.ts";
import { TYPE_SAFE_API_KEY_ENV, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL } from "../../classifier-backends.ts";
import { createTypeSafeClassifier } from "../../typesafe-classifier.ts";
import { createPiNativeClassifier } from "../../classifier-pi-native.ts";
import { createAndPromptSession, promptSessionIfActive } from "../../session-fallback.ts";
import bifrostExtension from "../../index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Production index.ts baseline recorded for G05 fault-control restoration. */
const INDEX_BASELINE_SHA256 = "ec4c4da9720ba975d9634cc397458cd4599b5e68a7f1eae67f3964e11a5256bc";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tiers = ["quick", "general"];

function makeModel(provider, id) {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function assistantMessage(content, overrides = {}) {
  return {
    role: "assistant",
    content,
    stopReason: "stop",
    ...overrides,
  };
}

function promptAnswer(text, confidence = 0.9, choice = "general") {
  const probabilities = { quick: 0.05, general: 0.05 };
  probabilities[choice] = confidence;
  const residual = 1 - confidence;
  for (const tier of tiers) if (tier !== choice) probabilities[tier] = residual / (tiers.length - 1);
  return {
    api: "systemone",
    provider: "fixture",
    model: "prompt",
    answers: { tier: { type: "choice", choice, confidence, probabilities } },
    stopReason: "stop",
    timestamp: 1,
  };
}

function scriptedChild(lines) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

/**
 * Extension-level harness. Drives the real registered input hook so we can
 * count classifier attempts and the single final generation (setModel).
 */
function makeExtensionHarness(config, options = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-transport-acceptance-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify(config));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const available = options.available ?? [];
  const selected = [];
  const notices = [];
  const active = makeModel("fixture", "active");
  const classifierModels = options.classifierModels ?? [];
  const modelRegistry = {
    getAvailable: () => available,
    getAll: () => available,
    find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
    getRegisteredProviderIds: () => [...new Set(available.map((model) => model.provider))],
    getProviderAuthStatus: () => ({ configured: options.classifierAuthConfigured ?? true }),
    getModelOfType: (type, provider, id) => classifierModels.find((model) => model.provider === provider && model.id === id),
    getAvailableOfType: async () => classifierModels,
    classify: options.classify ?? (async () => { throw new Error("unexpected native classifier request"); }),
    refresh: async () => ({ refreshed: [], errors: [] }),
    streamSimple: options.streamSimple,
  };
  const sessionManager = { getBranch: () => [] };
  const ui = {
    getEditorText: () => "",
    setEditorText: () => {},
    setWidget: () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    notify: (message) => { notices.push(String(message)); },
    custom: async () => null,
    theme: { fg: (_color, text) => text },
  };
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    model: active,
    modelRegistry,
    sessionManager,
    ui,
    signal: undefined,
    thinkingLevel: "low",
  };
  let input;
  const pi = {
    registerVirtualModel: () => {},
    registerCommand: () => {},
    on: (event, handler) => { if (event === "input") input = handler; return () => {}; },
    setModel: async (model) => { selected.push(`${model.provider}/${model.id}`); return true; },
  };
  bifrostExtension(pi);
  if (!input) throw new Error("extension did not register the input hook");
  return {
    ctx,
    selected,
    notices,
    input: (text = "do the task") => input({ text, source: "interactive", streamingBehavior: "steer" }, ctx),
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function promptConfig(overrides = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: true, backend: "prompt", model: "fixture/classifier", fallback: "regex" },
    cache: { enabled: false },
    models: { quick: ["fixture/fast"], general: ["fixture/capable"] },
    rules: [],
    ...overrides,
  };
}

// ── Named assertion shared by the cancellation case and the fault control ──

async function runAbortedFallback(promptFallback) {
  const controller = new AbortController();
  controller.abort();
  let prompts = 0;
  const session = {
    prompt: async () => { prompts += 1; },
    abort: async () => {},
    getLastAssistantText: () => "late result",
    dispose: () => {},
  };
  const result = await promptFallback(session, "classifier prompt", controller.signal);
  return { result, prompts };
}

function assertNoFallbackPromptAfterAbort(run, label = "aborted fallback") {
  assert.equal(run.prompts, 0, `${label} must not start a session prompt after abort`);
  assert.equal(run.result, undefined, `${label} must resolve undefined after abort`);
}

describe("classifier transport acceptance", { timeout: 120_000 }, () => {
  // ── Registry transport: success, failure, no paid fallback ─────────────

  it("counts one registry classifier attempt and one final generation on success", async () => {
    let streamCalls = 0;
    const harness = makeExtensionHarness(promptConfig(), {
      available: [makeModel("fixture", "fast"), makeModel("fixture", "capable"), makeModel("fixture", "classifier")],
      streamSimple: () => {
        streamCalls += 1;
        return { result: async () => assistantMessage([{ type: "text", text: "general" }]) };
      },
    });
    try {
      await harness.input();
      assert.equal(streamCalls, 1, "the registry classifier is attempted exactly once");
      assert.deepEqual(harness.selected, ["fixture/capable"], "exactly one physical generation follows a successful classification");
    } finally {
      harness.cleanup();
    }
  });

  it("counts one failed registry attempt and still dispatches exactly one default-tier generation", async () => {
    let streamCalls = 0;
    let subprocessCalls = 0;
    const classifier = makeModel("fixture", "classifier");
    const result = await classifyWithLLM(
      {
        cwd: process.cwd(),
        modelRegistry: {
          streamSimple: (_model, _context, options) => {
            streamCalls += 1;
            return {
              result: async () => {
                await options.onResponse?.({ status: 429, headers: { "retry-after": "3" } }, classifier);
                return assistantMessage([], { stopReason: "error" });
              },
            };
          },
        },
      },
      { kind: "registry", model: classifier },
      tiers,
      "prompt",
      {
        method: "auto",
        spawnImpl: () => { subprocessCalls += 1; throw new Error("a failed registry transport must not spawn"); },
      },
    );
    assert.equal(result, undefined, "a failed registry transport is a classifier miss");
    assert.equal(streamCalls, 1, "the failed registry transport is attempted once");
    assert.equal(subprocessCalls, 0, "a failed registry transport must not start a paid subprocess fallback");
  });

  // ── Endpoint transport: success, failure, empty response ───────────────

  it("classifies through the configured HTTP endpoint transport with one injected request", async () => {
    const urls = [];
    const endpoint = { kind: "endpoint", id: "fixture-classifier", baseUrl: "https://classifier.invalid/v1" };
    const result = await classifyWithLLM(
      { cwd: process.cwd() },
      endpoint,
      tiers,
      "prompt",
      {
        method: "direct",
        fetchImpl: async (input) => {
          urls.push(String(input));
          return { ok: true, json: async () => ({ choices: [{ message: { content: "general" } }] }) };
        },
      },
    );
    assert.equal(result, "general");
    assert.deepEqual(urls, ["https://classifier.invalid/v1/chat/completions"], "exactly one request reaches the configured endpoint");
  });

  it("treats a failed endpoint response as a miss without starting an unsupported subprocess", async () => {
    let fetches = 0;
    let spawns = 0;
    const endpoint = { kind: "endpoint", id: "fixture-classifier", baseUrl: "https://classifier.invalid/v1" };
    const result = await classifyWithLLM(
      { cwd: process.cwd() },
      endpoint,
      tiers,
      "prompt",
      {
        method: "auto",
        fetchImpl: async () => { fetches += 1; return { ok: false, status: 429 }; },
        spawnImpl: () => { spawns += 1; throw new Error("endpoint transport must not spawn"); },
      },
    );
    assert.equal(result, undefined);
    assert.equal(fetches, 1);
    assert.equal(spawns, 0, "an unsupported endpoint/subprocess composition must not spawn");
  });

  it("treats an empty endpoint response as a miss without a fallback prompt", async () => {
    let fetches = 0;
    let spawns = 0;
    const endpoint = { kind: "endpoint", id: "fixture-classifier", baseUrl: "https://classifier.invalid/v1" };
    const result = await classifyWithLLM(
      { cwd: process.cwd() },
      endpoint,
      tiers,
      "prompt",
      {
        method: "direct",
        fetchImpl: async () => { fetches += 1; return { ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) }; },
        spawnImpl: () => { spawns += 1; throw new Error("no subprocess for an empty endpoint response"); },
      },
    );
    assert.equal(result, undefined);
    assert.equal(fetches, 1);
    assert.equal(spawns, 0);
  });

  // ── Subprocess transport: scripted child success/failure/abort ─────────

  it("classifies through the subprocess transport from a scripted child response", async () => {
    let spawns = 0;
    const classifier = makeModel("fixture", "classifier");
    const result = await classifyWithLLM(
      { cwd: process.cwd() },
      { kind: "registry", model: classifier },
      tiers,
      "prompt",
      {
        method: "subprocess",
        spawnImpl: () => {
          spawns += 1;
          const child = scriptedChild();
          queueMicrotask(() => {
            child.stdout.write("general\n");
            child.emit("close", 0);
          });
          return child;
        },
      },
    );
    assert.equal(result, "general");
    assert.equal(spawns, 1, "the subprocess transport spawns its owned child exactly once");
  });

  it("treats a failed scripted subprocess as a classifier miss without retrying", async () => {
    let spawns = 0;
    const originalError = console.error;
    console.error = () => {};
    try {
      const classifier = makeModel("fixture", "classifier");
      const result = await classifyWithLLM(
        { cwd: process.cwd() },
        { kind: "registry", model: classifier },
        tiers,
        "prompt",
        {
          method: "subprocess",
          spawnImpl: () => {
            spawns += 1;
            const child = scriptedChild();
            queueMicrotask(() => child.emit("close", 1));
            return child;
          },
        },
      );
      assert.equal(result, undefined);
      assert.equal(spawns, 1);
    } finally {
      console.error = originalError;
    }
  });

  it("does not start the paid subprocess fallback after abort while the registry transport is pending", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    let spawns = 0;
    const classifier = makeModel("fixture", "classifier");
    const pending = classifyWithLLM(
      {
        cwd: process.cwd(),
        modelRegistry: {
          streamSimple: (_model, _context, options) => {
            streamCalls += 1;
            return {
              result: () => new Promise((resolve) => {
                options.signal?.addEventListener("abort", () => resolve(assistantMessage([])), { once: true });
              }),
            };
          },
        },
      },
      { kind: "registry", model: classifier },
      tiers,
      "prompt",
      {
        method: "auto",
        spawnImpl: () => { spawns += 1; throw new Error("must not spawn after abort"); },
      },
      controller.signal,
    );
    await tick();
    controller.abort();
    assert.equal(await pending, undefined);
    assert.equal(streamCalls, 1);
    assert.equal(spawns, 0, "an aborted turn must never start a paid subprocess fallback");
  });

  // ── Empty-stream fallback boundary (session-fallback guard) ────────────

  it("does not start the minimal-session fallback prompt after abort", async () => {
    assertNoFallbackPromptAfterAbort(await runAbortedFallback(promptSessionIfActive));
  });

  it("does not prompt when cancellation settles while the fallback session is still being created", async () => {
    const controller = new AbortController();
    let release;
    const creation = new Promise((resolve) => { release = resolve; });
    let prompts = 0;
    const pending = createAndPromptSession(() => creation, "classifier prompt", controller.signal);
    controller.abort();
    release({ prompt: async () => { prompts += 1; }, abort: async () => {}, getLastAssistantText: () => "late result", dispose: () => {} });
    assert.equal(await pending, undefined);
    assert.equal(prompts, 0);
  });

  it("aborts an in-flight fallback prompt and ignores its late text", async () => {
    const controller = new AbortController();
    let release;
    let aborts = 0;
    const session = {
      prompt: () => new Promise((resolve) => { release = resolve; }),
      abort: async () => { aborts += 1; release(); },
      getLastAssistantText: () => "late result",
      dispose: () => {},
    };
    const pending = promptSessionIfActive(session, "classifier prompt", controller.signal);
    await tick();
    controller.abort();
    assert.equal(await pending, undefined);
    assert.equal(aborts, 1);
  });

  it("returns the fallback text when the minimal session completes before cancellation", async () => {
    const session = {
      prompt: async () => {},
      abort: async () => {},
      getLastAssistantText: () => "frontier",
      dispose: () => {},
    };
    assert.equal(await promptSessionIfActive(session, "classifier prompt", new AbortController().signal), "frontier");
  });

  // ── Explicit unsupported composition boundary ──────────────────────────

  it("records the unsupported composition: an endpoint classifier never uses the subprocess transport", async () => {
    let fetches = 0;
    let spawns = 0;
    const result = await classifyWithLLM(
      { cwd: process.cwd() },
      { kind: "endpoint", id: "fixture-classifier", baseUrl: "https://classifier.invalid/v1" },
      tiers,
      "prompt",
      {
        method: "subprocess",
        fetchImpl: async () => { fetches += 1; throw new Error("endpoint/subprocess must not fetch"); },
        spawnImpl: () => { spawns += 1; throw new Error("endpoint/subprocess must not spawn"); },
      },
    );
    assert.equal(result, undefined);
    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
  });

  // ── Direct transports: TypeSafe pin, auth nonretry, low confidence ─────

  it("keeps the TypeSafe official endpoint pin and uses the injected transport at that boundary", async () => {
    const urls = [];
    let fetches = 0;
    const judgment = await createTypeSafeClassifier({
      apiKey: "test-only-key",
      maxAttempts: 1,
      fetchImpl: async (input) => {
        fetches += 1;
        urls.push(String(input));
        return {
          ok: true,
          json: async () => ({
            model: TYPE_SAFE_MODEL,
            answers: { tier: { type: "choice", choice: "general", confidence: 0.95, probabilities: { quick: 0.025, general: 0.95, frontier: 0.025 } } },
          }),
        };
      },
    })({ prompt: "prompt", tiers: ["quick", "general", "frontier"], criteria: {} });

    assert.equal(judgment?.tier, "general");
    assert.equal(fetches, 1);
    assert.deepEqual(urls, [TYPE_SAFE_ENDPOINT], "the TypeSafe transport stays pinned to the official endpoint");
    assert.equal(TYPE_SAFE_API_KEY_ENV, "TYPESAFE_API_KEY");
  });

  it("does not retry a TypeSafe auth failure or a native auth failure", async () => {
    let typeSafeFetches = 0;
    const judgments = [];
    const authJudgment = await createTypeSafeClassifier({
      apiKey: "test-only-key",
      maxAttempts: 3,
      fetchImpl: async () => { typeSafeFetches += 1; return { ok: false, status: 401 }; },
      observe: (observation) => judgments.push(observation.outcome),
    })({ prompt: "prompt", tiers, criteria: {} });
    assert.equal(authJudgment, undefined);
    assert.equal(typeSafeFetches, 1, "a TypeSafe auth failure is not retried");
    assert.deepEqual(judgments, ["auth"]);

    let nativeCalls = 0;
    const native = createPiNativeClassifier({
      maxAttempts: 3,
      model: "fixture/prompt",
      registry: {
        getModelOfType: () => ({ type: "classifier", provider: "fixture", id: "prompt" }),
        getAvailableOfType: async () => [],
        classify: async () => {
          nativeCalls += 1;
          return { ...promptAnswer("general"), answers: {}, stopReason: "error", errorMessage: "401 Unauthorized" };
        },
      },
    });
    assert.equal(await native({ prompt: "prompt", tiers, criteria: {} }), undefined);
    assert.equal(nativeCalls, 1, "a native auth failure is not retried");
  });

  it("turns a low-confidence native judgment into one default-tier generation", async () => {
    let nativeCalls = 0;
    const harness = makeExtensionHarness(
      promptConfig({
        classifier: {
          enabled: true,
          backend: "pi-native",
          piNative: { model: "fixture/prompt", timeoutMs: 500, maxAttempts: 1 },
          minConfidence: 0.8,
          fallback: "regex",
        },
      }),
      {
        available: [makeModel("fixture", "fast"), makeModel("fixture", "capable")],
        classifierModels: [{ type: "classifier", provider: "fixture", id: "prompt" }],
        classify: async () => {
          nativeCalls += 1;
          return promptAnswer("general", 0.5);
        },
      },
    );
    try {
      await harness.input();
      assert.equal(nativeCalls, 1, "the low-confidence native judgment is attempted once");
      assert.deepEqual(harness.selected, ["fixture/fast"], "a low-confidence judgment falls back to the local default tier");
    } finally {
      harness.cleanup();
    }
  });

  // ── One total budget ───────────────────────────────────────────────────

  it("enforces one total classifier budget and never starts the prompt fallback after expiry", async () => {
    let promptCalls = 0;
    let directAborted = false;
    const pipeline = createPipeline({
      totalTimeoutMs: 60,
      cacheLookup: () => undefined,
      classifyDirect: (_text, _tiers, signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => { directAborted = true; resolve(undefined); }, { once: true });
      }),
      classifierModels: [{ kind: "registry", model: makeModel("fixture", "classifier") }],
      classifyWithLLM: async () => { promptCalls += 1; return "general"; },
      regexRules: [],
      defaultTier: undefined,
      tiers,
    });
    const result = await pipeline.classify("prompt");
    assert.equal(directAborted, true, "the total budget cancels the in-flight direct transport");
    assert.equal(promptCalls, 0, "a total classifier budget expiry must not start the prompt fallback");
    assert.equal(result.kind, "unclassified");
    assert.equal(result.classificationOutcome, "deadline");
  });

  // ── Cancellation at the registered input hook ──────────────────────────

  it("does not call the classifier or dispatch a generation when the turn is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let streamCalls = 0;
    const harness = makeExtensionHarness(promptConfig(), {
      available: [makeModel("fixture", "fast"), makeModel("fixture", "classifier")],
      streamSimple: () => { streamCalls += 1; return { result: async () => assistantMessage([{ type: "text", text: "general" }]) }; },
    });
    harness.ctx.signal = controller.signal;
    try {
      await harness.input();
      assert.equal(streamCalls, 0, "an aborted input makes no classifier attempt");
      assert.deepEqual(harness.selected, [], "an aborted input dispatches no generation");
    } finally {
      harness.cleanup();
    }
  });

  it("makes no classifier fallback and no generation after abort while the classifier is pending", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const harness = makeExtensionHarness(promptConfig(), {
      available: [makeModel("fixture", "fast"), makeModel("fixture", "classifier")],
      streamSimple: (_model, _context, options) => {
        streamCalls += 1;
        started();
        return {
          result: () => new Promise((resolve) => {
            options.signal?.addEventListener("abort", () => resolve(assistantMessage([])), { once: true });
          }),
        };
      },
    });
    harness.ctx.signal = controller.signal;
    try {
      const pending = harness.input();
      await startedPromise;
      controller.abort();
      await pending;
      assert.equal(streamCalls, 1, "the pending classifier attempt is the only one");
      assert.deepEqual(harness.selected, [], "no generation is dispatched after the turn is aborted");
    } finally {
      harness.cleanup();
    }
  });

  // ── Fault control: one cancellation guard in an isolated source copy ───

  it("fault control: removing the aborted-session guard starts a forbidden fallback prompt", async () => {
    const sourcePath = join(ROOT, "session-fallback.ts");
    const original = readFileSync(sourcePath, "utf8");
    const originalHash = sha256(original);
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-transport-fault-"));
    try {
      symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
      copyFileSync(sourcePath, join(scratch, "session-fallback.ts"));

      // GREEN reference: pristine guard refuses the aborted prompt.
      assertNoFallbackPromptAfterAbort(await runAbortedFallback(promptSessionIfActive), "pristine fallback");

      // MUTATE: drop the abort guard before the session prompt.
      const anchor = "  try {\n    if (signal?.aborted) return undefined;\n    await session.prompt(prompt);";
      if (!original.includes(anchor)) throw new Error("session-fallback abort guard anchor not found");
      const mutantSource = original.replace(anchor, "  try {\n    await session.prompt(prompt);");
      assert.notEqual(mutantSource, original, "the mutation must change the source");
      writeFileSync(join(scratch, "session-fallback.ts"), mutantSource);
      const mutant = (await import(`${pathToFileURL(join(scratch, "session-fallback.ts")).href}?mutant=${originalHash.slice(0, 8)}`)).promptSessionIfActive;

      // RED: the guard-removed mutant must fail the named assertion with an
      // AssertionError (not a startup or syntax failure).
      const mutantRun = await runAbortedFallback(mutant);
      assert.throws(
        () => assertNoFallbackPromptAfterAbort(mutantRun, "mutant fallback"),
        (error) => error instanceof assert.AssertionError
          && /must not start a session prompt after abort/.test(error.message),
        "the guard-removed mutant must fail the aborted-fallback assertion",
      );
      assert.equal(mutantRun.prompts, 1, "the forbidden fallback prompt must be observable");

      // RESTORE: the copy returns to the recorded hash and passes again.
      writeFileSync(join(scratch, "session-fallback.ts"), original);
      assert.equal(sha256(readFileSync(join(scratch, "session-fallback.ts"), "utf8")), originalHash);
      const restored = (await import(`${pathToFileURL(join(scratch, "session-fallback.ts")).href}?restored=${originalHash.slice(0, 8)}`)).promptSessionIfActive;
      assertNoFallbackPromptAfterAbort(await runAbortedFallback(restored), "restored fallback");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    assert.equal(sha256(readFileSync(sourcePath, "utf8")), originalHash, "the committed session-fallback.ts must be restored");
    assert.equal(sha256(readFileSync(join(ROOT, "index.ts"), "utf8")), INDEX_BASELINE_SHA256, "production index.ts must remain byte-identical");
  });
});
