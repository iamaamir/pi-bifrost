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

  let classifyMode = "success";
  let classifyCalls = 0;
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
        classify: async (model, context) => {
          classifyCalls += 1;
          seen.push({ provider: model.provider, id: model.id, api: model.api, state: context.state, questions: context.questions });
          if (classifyMode === "error") {
            return { api: "fixture-classify", provider: model.provider, model: model.id, answers: {}, stopReason: "error", errorMessage: "HTTP 402 Payment Required", timestamp: Date.now() };
          }
          const choice = fault === "wrong-tier" && classifyCalls === 1 ? "quick" : "general";
          return {
            api: "fixture-classify",
            provider: "fixture-class",
            model: "fixture-jev",
            answers: { tier: { type: "choice", choice, confidence: 0.85, probabilities: { quick: 0.05, general: 0.85, frontier: 0.1 } } },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    },
  });

  const faux = fauxProvider({ provider: "faux", models: [
    { id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: false }, { id: "physical-frontier", reasoning: false },
  ] });
  const invocations = [];
  faux.setResponses([
    (_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText("classified general response"));
    },
    (_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText("fallback quick response"));
    },
    (_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText("inline frontier response"));
    },
  ]);

  const classifierEnabled = fault !== "disabled";
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    models: { quick: ["faux/physical-fast"], general: ["faux/physical-capable"], frontier: ["faux/physical-frontier"] },
    classifier: { enabled: classifierEnabled, backend: "pi-native", piNative: { model: "fixture-class/fixture-jev" }, fallback: "regex", minConfidence: 0 },
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
  const factories = fault === "no-extension" ? [] : [bifrostExtension];
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
  assert.equal(session.getLastAssistantText(), "classified general response");
  assert.deepEqual(invocations, ["faux/physical-capable"], "classifier judgment must move dispatch off the initial physical model");
  assert.equal(session.model.provider, "faux");
  assert.equal(session.model.id, "physical-capable");
  assert.equal(faux.state.callCount, 1);

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

  assert.equal(existsSync(violationPath) ? readFileSync(violationPath, "utf8") : "", "", "AgentSession made blocked outbound attempt");
  assert.equal(session.isStreaming, false, "session must be idle after completion");
  assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
});
