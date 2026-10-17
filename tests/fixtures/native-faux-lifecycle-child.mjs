import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

// The parent owns scratch lifetime. This child never deletes scratch: the parent
// removes it only after this process has exited, so no in-process async work can
// recreate fixture files afterwards.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.BIFROST_NATIVE_LIFECYCLE_SCRATCH;
assert.ok(scratch, "BIFROST_NATIVE_LIFECYCLE_SCRATCH is required by the parent");
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
const scenario = process.env.BIFROST_NATIVE_LIFECYCLE_SCENARIO ?? "physical-default";
const childHost = scenario.startsWith("child-");
const autoSelected = scenario === "auto-unmarked" || scenario === "child-auto";
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into the isolated lifecycle child`);
}

// One scenario per run keeps independent sessions from sharing response queues
// or provider call state. Each scenario is proven by the physical identity
// recorded at the provider callback, the exact call counts, and queue drain.
const SCENARIOS = {
  // Unchanged baseline: a physical seed routes every turn through direct rules,
  // inline tier override precedence, and the configured default.
  "physical-default": {
    auto: false,
    physicalSession: true,
    turns: [
      { prompt: "direct alpha marker", model: "faux-alpha/physical", response: "alpha response" },
      { prompt: "direct beta marker", model: "faux-beta/physical", response: "beta response" },
      { prompt: "frontier override collision marker", model: "faux-frontier/physical", response: "frontier response" },
      { prompt: "plain request with no configured marker", model: "faux-default/physical", response: "default response" },
    ],
  },
  // An ordinary host explicitly selects the virtual Auto model: each turn must
  // dispatch a configured physical model, and the inline tier prefix must beat
  // the conflicting direct rule.
  "auto-unmarked": {
    auto: true,
    physicalSession: false,
    turns: [
      { prompt: "direct alpha marker", model: "faux-alpha/physical", response: "alpha response" },
      { prompt: "frontier override collision marker", model: "faux-frontier/physical", response: "frontier response" },
      { prompt: "plain request with no configured marker", model: "faux-default/physical", response: "default response" },
    ],
  },
  // pi-subagents sets PI_SUBAGENT_CHILD=1 in its child host. An explicit physical
  // selection must never be rerouted, even when a direct rule would match.
  "child-physical": {
    auto: false,
    physicalSession: true,
    turns: [
      { prompt: "direct alpha marker", model: "faux-seed/physical", response: "seed response" },
    ],
  },
  // The same marked child host that explicitly selects Auto still owns ordinary
  // routing and the inline tier handoff.
  "child-auto": {
    auto: true,
    physicalSession: false,
    turns: [
      { prompt: "direct alpha marker", model: "faux-alpha/physical", response: "alpha response" },
      { prompt: "frontier override collision marker", model: "faux-frontier/physical", response: "frontier response" },
    ],
  },
};

const current = SCENARIOS[scenario];
assert.ok(current, `unknown lifecycle scenario: ${scenario}`);

let runtime;
let session;
let providers = [];
const invocations = [];
const previous = { cwd: process.cwd(), environment: { ...process.env } };
after(() => {
  session?.dispose();
  for (const provider of providers) runtime?.unregisterProvider(provider.provider.id);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, previous.environment);
  process.chdir(previous.cwd);
});

function modelKey(model) {
  return model ? `${model.provider}/${model.id}` : "";
}

it(`routes real AgentSession turns (${scenario})`, async () => {
  const home = join(scratch, "home");
  const cwd = join(scratch, "workspace");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

  const preserved = ["PATH", "TMPDIR", "LANG", "TERM"];
  // A marked child host must keep the exact producer marker that the extension
  // reads; an unmarked host must not carry it at all.
  if (childHost) preserved.push("PI_SUBAGENT_CHILD", "PI_SUBAGENT_CHILD_AGENT");
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const name of preserved) {
    if (previous.environment[name] !== undefined) process.env[name] = previous.environment[name];
  }
  if (childHost) assert.equal(process.env.PI_SUBAGENT_CHILD, "1", "child host marker must survive isolation");
  else assert.equal(process.env.PI_SUBAGENT_CHILD, undefined, "unmarked scenario must not carry the child host marker");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);

  const routes = [
    { provider: "faux-seed", id: "physical", response: "seed response" },
    { provider: "faux-alpha", id: "physical", response: "alpha response" },
    { provider: "faux-beta", id: "physical", response: "beta response" },
    { provider: "faux-frontier", id: "physical", response: "frontier response" },
    { provider: "faux-default", id: "physical", response: "default response" },
    { provider: "faux-collision", id: "physical", response: "collision response" },
  ];
  providers = routes.map(({ provider, id, response }) => {
    const faux = fauxProvider({ provider, models: [{ id, reasoning: false }] });
    faux.setResponses([(_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText(response));
    }]);
    return faux;
  });
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    models: { quick: ["faux-default/physical"], frontier: ["faux-frontier/physical"] },
    classifier: { enabled: false },
    cache: { enabled: false },
    rules: [
      { pattern: "direct alpha marker", model: "faux-alpha/physical" },
      { pattern: "direct beta marker", model: "faux-beta/physical" },
      { pattern: "override collision marker", model: "faux-collision/physical" },
    ],
  }));
  process.chdir(cwd);

  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  for (const faux of providers) {
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "fixture-only");
  }
  await runtime.refresh({ allowNetwork: false });
  const seed = runtime.getModel("faux-seed", "physical");
  assert.ok(seed, "seed model must be available and differ from every route target");
  const { default: bifrostExtension } = await import(join(root, "index.ts"));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [bifrostExtension] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: seed, noTools: "all", resourceLoader }));
  await session.bindExtensions({ mode: "print" });

  assert.equal(modelKey(session.model), "faux-seed/physical", "the SDK seed must differ from every routed identity");
  if (current.auto) {
    const auto = runtime.getModel("bifrost", "auto");
    assert.ok(auto, "the production extension must register the bifrost/auto virtual model");
    assert.equal(auto.api, "pi-virtual", "bifrost/auto must be the registered virtual model");
    await session.setModel(auto);
    assert.equal(modelKey(session.model), "bifrost/auto", "explicitly selected Auto must stay the session model");
  }

  for (const [index, turn] of current.turns.entries()) {
    await session.prompt(turn.prompt);
    assert.equal(session.getLastAssistantText(), turn.response, `turn ${index + 1} ("${turn.prompt}") must complete with its own scripted response`);
    if (current.physicalSession) {
      assert.equal(modelKey(session.model), turn.model, `turn ${index + 1} must leave Pi on the routed physical model`);
    } else {
      assert.equal(modelKey(session.model), "bifrost/auto", `turn ${index + 1} must keep explicit Auto selected while dispatching a physical model`);
    }
  }

  const expectedInvocations = current.turns.map((turn) => turn.model);
  assert.equal(new Set(expectedInvocations).size, expectedInvocations.length, "each scenario must invoke a distinct physical model at most once");
  assert.deepEqual(invocations, expectedInvocations, "provider model arguments must match exact per-turn routing with no extra calls");
  assert.equal(existsSync(violationPath) ? readFileSync(violationPath, "utf8") : "", "", "socket, UDP, and fetch guard must record zero outbound attempts");
  for (const faux of providers) {
    const expectedCalls = expectedInvocations.some((model) => model === `${faux.provider.id}/physical`) ? 1 : 0;
    assert.equal(faux.state.callCount, expectedCalls, `${faux.provider.id} must receive only expected calls`);
    assert.equal(faux.getPendingResponseCount(), 1 - expectedCalls, `${faux.provider.id} queue must match expected calls`);
  }
  // Forbidden-provider negatives: routing is not just "a physical model ran" —
  // the seed (auto scenarios) and the conflicting rule target (inline override)
  // must never be invoked.
  if (current.auto) {
    const byId = new Map(providers.map((faux) => [faux.provider.id, faux]));
    assert.equal(byId.get("faux-seed").state.callCount, 0, "the seed provider must never be invoked once Auto dispatches");
    assert.equal(byId.get("faux-collision").state.callCount, 0, "the conflicting direct rule target must not win against the inline tier override");
  }
  assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
});
