import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.BIFROST_NATIVE_CLASSIFIER_SCRATCH;
assert.ok(scratch, "BIFROST_NATIVE_CLASSIFIER_SCRATCH is required by the parent");
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
const fault = process.env.BIFROST_NATIVE_CLASSIFIER_FAULT ?? "";
const scenario = process.env.BIFROST_NATIVE_CLASSIFIER_SCENARIO ?? "";
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into the isolated classifier child`);
}

let runtime;
let session;
const providers = [];
const previous = { cwd: process.cwd(), environment: { ...process.env } };
after(() => {
  session?.dispose();
  for (const id of providers) {
    try { runtime?.unregisterProvider(id); } catch {}
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, previous.environment);
  process.chdir(previous.cwd);
});

it("routes real AgentSession through Pi-native classifier to a different physical model", async () => {
  const home = join(scratch, "home");
  const cwd = join(scratch, "workspace");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const name of ["PATH", "TMPDIR", "LANG", "TERM"]) {
    if (previous.environment[name] !== undefined) process.env[name] = previous.environment[name];
  }
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText, createProvider }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);

  const precedenceScenario = scenario === "backend-precedence" || scenario === "backend-precedence-mutant";
  const precedenceMutantScenario = scenario === "backend-precedence-mutant";
  const previewScenario = scenario === "preview-command";
  let classifyMode = scenario === "deadline-late" ? "late" : "success";
  let classifyCalls = 0;
  let classifySignal;
  const seen = [];
  const classifierProvider = createProvider({
    id: "fixture-class",
    auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
    models: [{
      type: "classifier",
      provider: "fixture-class",
      id: "fixture-jev",
      name: "fixture-jev",
      api: "fixture-classify",
      baseUrl: "http://127.0.0.1/",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
    }],
    classifiers: {
      "fixture-classify": {
        classify: async (model, context, options) => {
          classifyCalls += 1;
          classifySignal = options?.signal;
          seen.push({ provider: model.provider, id: model.id, api: model.api, state: context.state, questions: context.questions });
          if (classifyMode === "error") {
            return { api: "fixture-classify", provider: model.provider, model: model.id, answers: {}, stopReason: "error", errorMessage: "HTTP 402 Payment Required", timestamp: Date.now() };
          }
          if (classifyMode === "late") await new Promise((resolve) => setTimeout(resolve, 600));
          const choice = classifyMode === "late" ? "frontier" : fault === "wrong-tier" && classifyCalls === 1 ? "quick" : "general";
          // The preview turn is below the configured 0.8 gate on purpose: a
          // rejected `general/0.73` must still report the value it returned.
          const previewTurn = previewScenario && context.state?.prompt === "route this prompt";
          const confidence = previewTurn ? 0.73 : 0.85;
          const probabilities = previewTurn
            ? { quick: 0.07, general: 0.73, frontier: 0.2 }
            : classifyMode === "late" ? { quick: 0.05, general: 0.1, frontier: 0.85 } : { quick: 0.05, general: 0.85, frontier: 0.1 };
          return {
            api: "fixture-classify",
            provider: "fixture-class",
            model: "fixture-jev",
            answers: { tier: { type: "choice", choice, confidence, probabilities } },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    },
  });

  const faux = fauxProvider({ provider: "faux", models: [
    { id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: false },
    { id: "physical-frontier", reasoning: false }, { id: "prompt-decoy", reasoning: false },
  ] });
  const invocations = [];
  let promptDecoyCalls = 0;
  const promptDecoyResponse = (model) => {
    if (model.id !== "prompt-decoy") return undefined;
    promptDecoyCalls += 1;
    return fauxAssistantMessage(fauxText("frontier"));
  };
  faux.setResponses([
    (_context, _options, _state, model) => {
      const decoy = promptDecoyResponse(model);
      if (decoy) return decoy;
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText(classifyMode === "late" ? "fallback quick response" : "classified general response"));
    },
    (_context, _options, _state, model) => {
      const decoy = promptDecoyResponse(model);
      if (decoy) return decoy;
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText("fallback quick response"));
    },
    (_context, _options, _state, model) => {
      const decoy = promptDecoyResponse(model);
      if (decoy) return decoy;
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText("inline frontier response"));
    },
  ]);

  const classifierEnabled = fault !== "disabled";
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    models: { quick: ["faux/physical-fast"], general: ["faux/physical-capable"], frontier: ["faux/physical-frontier"] },
    classifier: {
      enabled: classifierEnabled,
      backend: "pi-native",
      piNative: { model: "fixture-class/fixture-jev", timeoutMs: 1000 },
      totalTimeoutMs: classifyMode === "late" ? 150 : undefined,
      ...(precedenceScenario ? { model: "faux/prompt-decoy" } : {}),
      fallback: precedenceScenario ? "prompt" : "regex",
      minConfidence: previewScenario ? 0.8 : 0,
    },
    cache: { enabled: false },
    rules: [],
  }));
  process.chdir(cwd);

  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(classifierProvider);
  providers.push("fixture-class");
  runtime.registerNativeProvider(faux.provider);
  providers.push("faux");
  await runtime.setRuntimeApiKey("fixture-class", "fixture-only");
  await runtime.setRuntimeApiKey("faux", "fixture-only");
  await runtime.refresh({ allowNetwork: false });
  const initialModel = runtime.getModel("faux", "physical-fast");
  assert.ok(initialModel, "distinct initial physical model must be available");

  const { default: bifrostExtension } = await import(join(root, "index.ts"));
  const hostInventory = { chat: undefined, classifiers: undefined };
  const captureHostInventory = (pi) => {
    pi.on("before_agent_start", async (_event, ctx) => {
      hostInventory.chat = ctx.modelRegistry.getAvailable();
      hostInventory.classifiers = await ctx.modelRegistry.getAvailableOfType("classifier", "fixture-class");
    });
  };
  const factories = [captureHostInventory, ...(fault === "no-extension" ? [] : [bifrostExtension])];
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: factories });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: initialModel,
    noTools: "all",
    resourceLoader,
  }));
  await session.bindExtensions({ mode: "print" });

  assert.equal(session.model.provider, "faux");
  assert.equal(session.model.id, "physical-fast");

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); originalError(...args); };
  try {
    await session.prompt("native classifier dispatch marker alpha");
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(hostInventory.chat?.map(({ provider, id }) => `${provider}/${id}`).sort(), [
    "bifrost/auto", "faux/physical-capable", "faux/physical-fast", "faux/physical-frontier", "faux/prompt-decoy",
  ], "Pi getAvailable includes chat-capable decoy and registered virtual models but excludes classifier-only entries");
  assert.deepEqual(hostInventory.classifiers?.map(({ provider, id }) => `${provider}/${id}`), ["fixture-class/fixture-jev"],
    "Pi exposes classifier models through getAvailableOfType instead of getAvailable");
  assert.equal(classifyCalls, 1, "native classifier must be invoked exactly once for the first turn");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, "fixture-class");
  assert.equal(seen[0].id, "fixture-jev");
  assert.equal(seen[0].api, "fixture-classify");
  assert.deepEqual(seen[0], {
    provider: "fixture-class",
    id: "fixture-jev",
    api: "fixture-classify",
    state: { prompt: "native classifier dispatch marker alpha" },
    questions: { tier: {
      type: "choice",
      instructions: "Which model tier best fits this coding-agent request? Judge task complexity and consequence, not stated preference or price.",
      criteria: {
        quick: "Bounded, reversible, obvious work such as formatting, lookup, or a small mechanical edit. Not complex debugging, architecture, or security analysis.",
        general: "Normal implementation, tests, API changes, or moderate reasoning with clear scope. Not purely mechanical or unusually ambiguous and consequential work.",
        frontier: "Complex debugging, architecture, security, concurrency, high ambiguity, or high-consequence work. Not routine bounded edits.",
      },
    } },
  });
  if (precedenceMutantScenario) {
    assert.equal(promptDecoyCalls, 1, "native miss must invoke chat-capable prompt decoy exactly once");
    assert.deepEqual(invocations, ["faux/physical-frontier"], "prompt decoy's distinct frontier judgment must determine dispatch");
    assert.equal(session.model.id, "physical-frontier", "prompt fallback's frontier judgment must select its configured model");
  } else if (classifyMode === "late") {
    assert.equal(classifySignal?.aborted, true, "the shared deadline must abort Pi's native classifier signal");
    assert.equal(session.getLastAssistantText(), "fallback quick response");
    assert.deepEqual(invocations, ["faux/physical-fast"], "deadline fallback dispatches configured default tier");
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(classifyCalls, 1, "deadline must not retry the classifier");
    assert.deepEqual(invocations, ["faux/physical-fast"], "late native judgment must not select or dispatch its frontier tier");
    assert.equal(session.model.id, "physical-fast", "late native judgment must not change Pi's active model");
    assert.equal(faux.state.callCount, 1, "late classifier result must not cause a second generation");
  } else {
    assert.equal(session.getLastAssistantText(), "classified general response");
    assert.deepEqual(invocations, ["faux/physical-capable"], "classifier judgment must move dispatch off the initial physical model");
    assert.equal(session.model.provider, "faux");
    assert.equal(session.model.id, "physical-capable");
    assert.equal(faux.state.callCount, 1);
    if (precedenceScenario) {
      assert.equal(promptDecoyCalls, 0, "successful native judgment must not call prompt-decoy model");
    }

    // The error turn opens the pi-native circuit, which would turn the preview
    // into `circuit_open` instead of the rejected judgment under test.
    if (!precedenceScenario && !previewScenario) {
      classifyMode = "error";
      try {
        console.error = (...args) => { errors.push(args.join(" ")); originalError(...args); };
        await session.prompt("native classifier dispatch marker beta");
      } finally {
        console.error = originalError;
        classifyMode = "success";
      }
      assert.equal(classifyCalls, 2, "classifier error turn must still invoke the classifier");
      assert.deepEqual(seen[1], {
        provider: "fixture-class",
        id: "fixture-jev",
        api: "fixture-classify",
        state: { prompt: "native classifier dispatch marker beta" },
        questions: seen[0].questions,
      });
      assert.equal(session.getLastAssistantText(), "fallback quick response");
      assert.ok(errors.some((message) => /pi-native classifier.*configured default tier/i.test(message)), `visible classifier failure fallback warning missing: ${errors.join("\\n")}`);
      assert.deepEqual(invocations, ["faux/physical-capable", "faux/physical-fast"], "classifier error must fall back to the configured default without replay");
      assert.equal(faux.state.callCount, 2, "fallback must generate exactly once");
      assert.equal(faux.getPendingResponseCount(), 1, "inline response must remain queued until the inline turn");
      assert.equal(session.model.id, "physical-fast");

      await session.prompt("frontier native classifier inline marker");
      assert.equal(session.getLastAssistantText(), "inline frontier response");
      assert.deepEqual(invocations, ["faux/physical-capable", "faux/physical-fast", "faux/physical-frontier"], "inline tier prefix must win over classifier routing");
      assert.equal(session.model.id, "physical-frontier");
      assert.equal(classifyCalls, 2, "inline override must not invoke the classifier");
      assert.equal(faux.state.callCount, 3);
      assert.equal(faux.getPendingResponseCount(), 0);
    }
  }

  if (previewScenario) {
    // The command path, not the turn path: Pi dispatches the registered
    // extension command through `prompt()`, and Bifrost's print-mode output is
    // what a headless user actually sees.
    const modelBeforePreview = `${session.model.provider}/${session.model.id}`;
    const invocationsBeforePreview = [...invocations];
    const callsBeforePreview = faux.state.callCount;
    const originalError = console.error;
    // Each invocation is captured on its own: a shared buffer would let the
    // `--json` run satisfy the text assertions for a plain run that printed
    // nothing, so the test would not observe the boundary it claims.
    const capturePreview = async (command) => {
      const lines = [];
      console.error = (...args) => { lines.push(args.join(" ")); };
      try {
        await session.prompt(command);
      } finally {
        console.error = originalError;
      }
      return lines;
    };
    const jsonOutput = await capturePreview("/bifrost preview --json route this prompt");
    assert.equal(classifyCalls, 2, `the JSON preview must invoke the native classifier exactly once:\n${jsonOutput.join("\n")}`);
    const textOutput = await capturePreview("/bifrost preview route this prompt");
    assert.equal(classifyCalls, 3, `each preview must invoke the native classifier exactly once:\n${textOutput.join("\n")}`);

    const jsonLines = jsonOutput.filter((line) => line.startsWith("[bifrost-json] "));
    assert.equal(jsonLines.length, 1, `expected one preview JSON marker line, got:\n${jsonOutput.join("\n")}`);
    assert.equal(
      jsonOutput.some((line) => line.includes("--- preview ---")),
      false,
      `the JSON preview must not also print its text report:\n${jsonOutput.join("\n")}`,
    );
    const report = JSON.parse(jsonLines[0].slice("[bifrost-json] ".length));
    assert.equal(report.ok, true);
    assert.equal(report.prompt, "route this prompt");
    assert.equal(report.source, "fallback", "a rejected direct judgment must not become the accepted source");
    assert.equal(report.tier, "quick");
    assert.equal(report.selectedTier, "quick");
    assert.equal("backend" in report, false, "rejected judgment must not populate accepted backend");
    assert.equal("model" in report, false, "rejected judgment must not populate accepted model");
    assert.equal("confidence" in report, false, "rejected judgment must not populate accepted confidence");
    assert.equal(report.classifierAttempt?.backend, "pi-native");
    assert.equal(report.classifierAttempt?.outcome, "low_confidence");
    assert.equal(report.classifierAttempt?.fallbackKind, "default");
    assert.equal(report.classifierAttempt?.confidence, 0.73, "the exact rejected confidence must survive the real command path");
    assert.match(String(report.classifierAttempt?.model), /(^|\/)fixture-jev$/, "the attempt must name the classifier model that answered");

    assert.equal(
      textOutput.some((line) => line.startsWith("[bifrost-json] ")),
      false,
      `the text preview must not emit a JSON marker:\n${textOutput.join("\n")}`,
    );
    const textLines = textOutput.filter((line) => line.startsWith("[bifrost] ")).map((line) => line.slice("[bifrost] ".length));
    assert.ok(textLines.includes("--- preview ---"), `preview text view missing:\n${textOutput.join("\n")}`);
    assert.ok(textLines.includes("classifier attempt: pi-native (low_confidence, fallback=default)"), `attempt line missing:\n${textOutput.join("\n")}`);
    assert.ok(textLines.includes("classifier attempt confidence: 0.73"), `exact confidence line missing:\n${textOutput.join("\n")}`);
    assert.equal(textLines.some((line) => line.startsWith("confidence:")), false, "the text view must not present rejected confidence as accepted");

    assert.equal(faux.state.callCount, callsBeforePreview, "preview must not dispatch a generation");
    assert.deepEqual(invocations, invocationsBeforePreview, "preview must not stream through a physical model");
    assert.equal(`${session.model.provider}/${session.model.id}`, modelBeforePreview, "preview must leave Pi's active model unchanged");
  }

  assert.equal(existsSync(violationPath) ? readFileSync(violationPath, "utf8") : "", "", "AgentSession made blocked outbound attempt");
  assert.equal(session.isStreaming, false, "session must be idle after completion");
  assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
});
