import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
import { describe, it } from "node:test";
import { makeModel } from "../helpers.ts";
import bifrostExtension from "../../index.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../../classifier-backends.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../../virtual-model.ts";

function strictConfig(overrides = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "restricted",
    strategy: "first",
    classifier: { enabled: false },
    models: { restricted: ["fixture/missing"] },
    tierPolicies: { restricted: { fallbackTiers: [] } },
    rules: [],
    ...overrides,
  };
}

function makeHarness(config, available = [], options = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-activation-cancel-"));
  const agentDir = join(cwd, "agent");
  const configDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "bifrost.json");
  const writeConfig = (next) => writeFileSync(configPath, JSON.stringify(next));
  writeConfig(config);
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env[TYPE_SAFE_API_KEY_ENV];

  const selected = [];
  // Every activation/dispatch attempt, recorded before the host hook resolves so
  // a rejected or throwing activation still counts as an attempted dispatch.
  const dispatchAttempts = [];
  const notices = [];
  const editor = { value: "" };
  const active = options.active ?? makeModel("fixture", "active");
  const modelRegistry = {
    getAvailable: () => available,
    find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
    getModelOfType: (type, provider, id) => options.classifierModel?.provider === provider && options.classifierModel.id === id ? options.classifierModel : undefined,
    getAvailableOfType: async () => options.classifierModel ? [options.classifierModel] : [],
    classify: options.classify ?? (async () => { throw new Error("unexpected fake classifier request"); }),
    refresh: options.refresh ?? (async () => ({ refreshed: [], errors: [] })),
  };
  const sessionManager = { getBranch: () => [] };
  const ui = {
    getEditorText: () => editor.value,
    setEditorText: (text) => { editor.value = text; },
    setWidget: () => {},
    setStatus: () => {
      if (options.statusThrows || (options.statusThrowsAfterSetModel && selected.length > 0)) {
        throw new Error("injected status cleanup failure");
      }
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    notify: (message) => { notices.push(String(message)); },
    custom: async () => null,
    theme: { fg: (color, text) => text },
  };
  const ctx = {
    cwd,
    mode: options.mode ?? "rpc",
    hasUI: options.mode === "tui",
    model: active,
    modelRegistry,
    sessionManager,
    ui,
    signal: undefined,
    thinkingLevel: "low",
  };
  let input;
  const commands = {};
  let definition;
  const pi = {
    registerVirtualModel: (registered) => { definition = registered; },
    registerCommand: (name, opts) => { commands[name] = opts.handler; },
    on: (event, handler) => { if (event === "input") input = handler; return () => {}; },
    setModel: async (model) => {
      dispatchAttempts.push(`${model.provider}/${model.id}`);
      selected.push(`${model.provider}/${model.id}`);
      return options.setModel ? options.setModel(model) : true;
    },
  };
  const extension = options.extension ?? bifrostExtension;
  extension(pi);
  if (!input || !definition?.route) throw new Error("extension did not register required hooks");

  return {
    cwd,
    ctx,
    input: async (event = { text: "do the task", source: "interactive", streamingBehavior: "steer" }) => input(event, ctx),
    command: async (name, args = "") => {
      if (!commands[name]) throw new Error(`unknown command ${name}`);
      return commands[name](args, ctx);
    },
    route: definition.route,
    selected,
    dispatchAttempts,
    notices,
    editor,
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function sendInput(harness, text = "do the task") {
  return harness.input({ text, source: "interactive", streamingBehavior: "steer" });
}

describe("activation cancellation acceptance", { timeout: 120_000 }, () => {
  it("handles false and throwing physical activation without late dispatch", async () => {
    for (const activate of [async () => false, async () => { throw new Error("injected activation failure"); }]) {
      const target = makeModel("fixture", "allowed");
      const harness = makeHarness(strictConfig({ models: { restricted: ["fixture/allowed"] } }), [target], {
        mode: "tui",
        setModel: activate,
      });
      try {
        assert.deepEqual(await sendInput(harness), { action: "handled" });
        assert.deepEqual(harness.selected, ["fixture/allowed"]);
        assert.ok(harness.notices.some((message) => /could not activate fixture\/allowed/i.test(message)),
          "activation failure must surface an actionable user-visible error, not fail silently");
      } finally {
        harness.cleanup();
      }
    }
  });

  it("stops an aborted registry wait and preserves a newer editor draft", async () => {
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise(() => {});
    const controller = new AbortController();
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({ classifier: { enabled: true } }), [target], {
      mode: "tui",
      refresh: async () => { markRefreshStarted(); return refreshGate; },
    });
    harness.ctx.signal = controller.signal;
    harness.editor.value = "original request";
    let deadline;
    try {
      const input = sendInput(harness, "original request");
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("strict abort test exceeded 5-second deadline")), 5000);
      });
      await Promise.race([refreshStarted, timeout]);
      harness.editor.value = "newer draft";
      controller.abort();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "handled" });
      assert.equal(harness.editor.value, "newer draft");
      assert.deepEqual(harness.selected, []);
      assert.deepEqual(harness.dispatchAttempts, [], "an aborted registry wait must make no activation attempt");
    } finally {
      if (deadline) clearTimeout(deadline);
      harness.cleanup();
    }
  });

  it("does not dispatch after a late classifier result", async () => {
    const controller = new AbortController();
    let markClassificationStarted;
    const classificationStarted = new Promise((resolve) => { markClassificationStarted = resolve; });
    let releaseClassification;
    const classificationGate = new Promise((resolve) => { releaseClassification = resolve; });
    const classifierModel = { type: "classifier", provider: "typesafe", id: "fixture" };
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/allowed"] },
      classifier: {
        enabled: true,
        backend: "pi-native",
        criteria: { restricted: "Bounded fixture classification criterion." },
        minConfidence: 0.1,
        piNative: { model: "typesafe/fixture", timeoutMs: 5000, maxAttempts: 1 },
      },
    }), [target], {
      classifierModel,
      classify: async () => { markClassificationStarted(); return classificationGate; },
    });
    harness.ctx.signal = controller.signal;
    let deadline;
    try {
      const input = sendInput(harness);
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("classifier cancellation test exceeded 5-second deadline")), 5000);
      });
      await Promise.race([classificationStarted, timeout]);
      releaseClassification({
        api: "systemone",
        provider: "typesafe",
        model: "fixture",
        answers: { tier: { type: "choice", choice: "restricted", confidence: 0.9, probabilities: { restricted: 1 } } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      controller.abort();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "handled" });
      assert.deepEqual(harness.selected, []);
      assert.deepEqual(harness.dispatchAttempts, [], "a late classifier result must make no activation attempt");
    } finally {
      if (deadline) clearTimeout(deadline);
      harness.cleanup();
    }
  });

  it("lets a manual pin win over an in-flight registry refresh", async () => {
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    const target = makeModel("fixture", "allowed");
    const active = makeModel("fixture", "active");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/allowed"] },
      classifier: { enabled: true, backend: "prompt", fallback: "regex" },
    }), [target, active], {
      active,
      refresh: async () => { markRefreshStarted(); await refreshGate; return { refreshed: [], errors: [] }; },
    });
    let deadline;
    try {
      const input = sendInput(harness);
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("manual pin race exceeded 5-second deadline")), 5000);
      });
      await Promise.race([refreshStarted, timeout]);
      await harness.command("bifrost", "pin");
      releaseRefresh();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "continue" });
      assert.deepEqual(harness.selected, []);
      assert.deepEqual(harness.dispatchAttempts, [], "a manual pin must make no automatic activation attempt");
    } finally {
      if (deadline) clearTimeout(deadline);
      releaseRefresh?.();
      harness.cleanup();
    }
  });

  it("fault control: removing the late-abort guard allows forbidden late dispatch", async () => {
    const BASELINE_SHA256 = "ec4c4da9720ba975d9634cc397458cd4599b5e68a7f1eae67f3964e11a5256bc";
    const sha256 = (text) => createHash("sha256").update(text).digest("hex");
    const original = readFileSync(join(ROOT, "index.ts"), "utf8");
    assert.equal(sha256(original), BASELINE_SHA256,
      "production index.ts must match the recorded baseline hash before fault injection");
    const guard = `      if (ctx.signal?.aborted) {
        endClassify({ kind: classification.kind, outcome: "aborted" });
        endInput({ outcome: "aborted" });
        return routeBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing was cancelled; the turn was not sent. Resubmit after repair.")
          : defaultAction;
      }`;
    assert.ok(original.includes(guard), "late-abort guard must exist in production source");
    const mutantSource = original.replace(guard, "      console.error('MUTANT_GUARD_REMOVED_REACHED');");
    assert.notEqual(mutantSource, original, "fault injection must change the production source");

    const scratch = mkdtempSync(join(tmpdir(), "bifrost-activation-fault-"));
    const copyDir = join(scratch, "src");
    mkdirSync(copyDir, { recursive: true });
    for (const file of readdirSync(ROOT)) {
      if (file.endsWith(".ts")) copyFileSync(join(ROOT, file), join(copyDir, file));
    }
    mkdirSync(join(copyDir, "logging"), { recursive: true });
    for (const file of readdirSync(join(ROOT, "logging"))) {
      if (file.endsWith(".ts")) copyFileSync(join(ROOT, "logging", file), join(copyDir, "logging", file));
    }
    writeFileSync(join(copyDir, "index.ts"), mutantSource);
    symlinkSync(join(ROOT, "node_modules"), join(copyDir, "node_modules"));
    const mutantExtension = (await import(pathToFileURL(join(copyDir, "index.ts")).href + `?fault=${Date.now()}`)).default;

    // Hard admission turns the aborted classifier result into a default-tier
    // fallback before the late-abort guard, and disabling reliability removes the
    // provider-admission abort gate. The late-abort guard is then the only abort
    // gate left between classification and dispatch, so removing it is observable.
    const faultConfig = () => strictConfig({
      models: { restricted: ["fixture/allowed"] },
      reliability: { enabled: false },
      economics: {
        mode: "policy",
        scopes: { selected: { kind: "model", model: "fixture/allowed" } },
        sources: [{ id: "manual", scopeRef: "selected", authority: "declared" }],
        admission: [{ id: "daily", scopeRef: "selected", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
        observations: [{
          sourceId: "manual", scopeRef: "selected", billing: "metered", observedAt: 100,
          expiresAt: 8_000_000_000_000_000, revision: 1,
          windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.4 }],
        }],
      },
      classifier: {
        enabled: true,
        backend: "pi-native",
        criteria: { restricted: "Bounded fixture classification criterion." },
        minConfidence: 0.1,
        piNative: { model: "typesafe/fixture", timeoutMs: 5000, maxAttempts: 1 },
      },
    });
    const classifierModel = { type: "classifier", provider: "typesafe", id: "fixture" };
    const classificationResult = () => ({
      api: "systemone",
      provider: "typesafe",
      model: "fixture",
      answers: { tier: { type: "choice", choice: "restricted", confidence: 0.9, probabilities: { restricted: 1 } } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    // Deterministic sequence: start the turn, abort while the classifier gate is
    // still pending, yield a macrotask so the abort has taken effect, then release
    // the classification result. This exercises the mutant's missing guard.
    const runGatedAbort = async (extension) => {
      let releaseClassification;
      const classificationGate = new Promise((resolve) => { releaseClassification = resolve; });
      let markClassificationStarted;
      const classificationStarted = new Promise((resolve) => { markClassificationStarted = resolve; });
      const target = makeModel("fixture", "allowed");
      const harness = makeHarness(faultConfig(), [target], {
        classifierModel,
        extension,
        classify: async () => { markClassificationStarted(); return classificationGate; },
      });
      const controller = new AbortController();
      harness.ctx.signal = controller.signal;
      let deadline;
      try {
        const input = harness.input({ text: "do the task", source: "interactive", streamingBehavior: "steer" });
        const timeout = new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("fault control exceeded 5-second deadline")), 5000);
        });
        await Promise.race([classificationStarted, timeout]);
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseClassification(classificationResult());
        const result = await Promise.race([input, timeout]);
        return { harness, result };
      } catch (error) {
        harness.cleanup();
        throw error;
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    };

    // The fault-sensitive assertion: under abort no model may be selected and no
    // activation may be attempted.
    const assertNoForbiddenLateDispatch = (run, label) => {
      assert.deepEqual(run.harness.selected, [],
        "late-abort guard removal must allow forbidden late dispatch");
      assert.deepEqual(run.harness.dispatchAttempts, [],
        "late-abort guard removal must allow forbidden late dispatch");
      assert.deepEqual(run.result, { action: "handled" }, `${label} must handle the aborted turn`);
    };

    try {
      // GREEN reference: pristine production extension passes the assertion.
      const pristine = await runGatedAbort(bifrostExtension);
      try {
        assertNoForbiddenLateDispatch(pristine, "pristine");
      } finally {
        pristine.harness.cleanup();
      }

      // RED fault: the guard-removed mutant must fail that exact assertion, and the
      // failure must be the named AssertionError, not a startup or syntax failure.
      const mutant = await runGatedAbort(mutantExtension);
      try {
        assert.throws(
          () => assertNoForbiddenLateDispatch(mutant, "mutant"),
          (error) => error instanceof assert.AssertionError
            && /late-abort guard removal must allow forbidden late dispatch/.test(error.message),
          "the guard-removed mutant must fail the forbidden-dispatch assertion",
        );
        assert.deepEqual(mutant.harness.dispatchAttempts, ["fixture/allowed"],
          "the forbidden late dispatch must be observable in the harness dispatch counter");
      } finally {
        mutant.harness.cleanup();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    assert.equal(sha256(readFileSync(join(ROOT, "index.ts"), "utf8")), BASELINE_SHA256,
      "production index.ts must remain byte-identical after the fault control restored the copy");
  });
});
