import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.BIFROST_NATIVE_FAUX_SCRATCH;
assert.ok(scratch);
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into isolated faux-provider child`);
}
const home = join(scratch, "home");
const cwd = join(scratch, "workspace");
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(join(agentDir, "auth.json"), "{}\n");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
  enabled: true,
  models: { quick: ["faux/physical-fast"], general: ["faux/physical-capable"], frontier: ["faux/physical-capable"] },
  default: "quick",
  classifier: { enabled: false },
  rules: [{ pattern: "native faux dispatch marker", model: "faux/physical-capable" }],
}));
const previous = { cwd: process.cwd(), HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.chdir(cwd);
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
  import("@earendil-works/pi-coding-agent"),
  import("@earendil-works/pi-ai"),
]);
const faux = fauxProvider({ provider: "faux", models: [
  { id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: true },
] });
const invocations = [];
faux.setResponses([(_context, _options, _state, model) => {
  invocations.push(`${model.provider}/${model.id}`);
  return fauxAssistantMessage(fauxText("native faux response"));
}]);
let session;
let runtime;
after(() => {
  session?.dispose();
  if (runtime) runtime.unregisterProvider("faux");
  if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
  if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
  process.chdir(previous.cwd);
});

it("routes real AgentSession request to configured physical faux model behind preload fence", async () => {
  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("faux", "fixture-only");
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual((await runtime.getAvailable("faux")).map(({ id }) => id), ["physical-fast", "physical-capable"]);
  const { default: bifrostExtension } = await import(join(root, "index.ts"));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [bifrostExtension] });
  await resourceLoader.reload();

  await runtime.getAvailable("faux");
  const model = runtime.getModel("faux", "physical-fast");
  assert.ok(model, "registered physical model must be available");
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, noTools: "all", resourceLoader }));
  await session.bindExtensions({ mode: "print" });
  await session.prompt("native faux dispatch marker");
  assert.equal(session.getLastAssistantText(), "native faux response");
  assert.equal(session.model.provider, "faux");
  assert.equal(session.model.id, process.env.BIFROST_EXPECTED_MODEL);
  assert.equal(faux.state.callCount, 1);
  assert.equal(readFileSync(violationPath, "utf8"), "", "AgentSession made blocked outbound attempt");
  assert.deepEqual(invocations, [`faux/${process.env.BIFROST_EXPECTED_MODEL}`]);
  assert.equal(faux.getPendingResponseCount(), 0);
  assert.deepEqual(runtime.getModels("faux").map(({ id }) => id), ["physical-fast", "physical-capable"]);
});
