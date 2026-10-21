import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.BIFROST_NATIVE_TOOL_CONTINUATION_SCRATCH;
assert.ok(scratch, "BIFROST_NATIVE_TOOL_CONTINUATION_SCRATCH is required by the parent");
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into the isolated tool-continuation child`);
}

let runtime;
let session;
let providers = [];
const invocations = [];
let toolExecutionCount = 0;
let toolResultValue = null;
let toolEventCounts = { toolStart: 0, toolEnd: 0, turnStart: 0, turnEnd: 0, agentStart: 0, agentEnd: 0 };
const previous = { cwd: process.cwd(), environment: { ...process.env } };
after(() => {
  session?.dispose();
  for (const faux of providers) runtime?.unregisterProvider(faux.provider.id);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, previous.environment);
  process.chdir(previous.cwd);
});

it("routes real AgentSession native tool-call result completion lifecycle exactly once", async () => {
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

  const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxToolCall }, { Type }, { defineTool }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
    import("typebox"),
    import("@earendil-works/pi-coding-agent"),
  ]);

  const toolParams = Type.Object({ value: Type.String({ description: "value inspected by local tool" }) });
  const localTool = defineTool({
    name: "local_inspect",
    label: "Local Inspect",
    description: "Deterministic local test tool",
    parameters: toolParams,
    async execute(_toolCallId, params) {
      toolExecutionCount += 1;
      toolResultValue = `inspected:${params.value}`;
      return { content: [{ type: "text", text: toolResultValue }] };
    },
  });

  const faux = fauxProvider({ provider: "faux", models: [
    { id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: true },
  ] });
  providers = [faux];
  faux.setResponses([
    (_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage([fauxToolCall("local_inspect", { value: "alpha" })], { stopReason: "toolUse" });
    },
    (context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      const hasToolResult = context.messages.some((message) =>
        message.role === "toolResult" &&
        String(JSON.stringify(message.content)).includes("inspected:alpha")
      );
      if (!hasToolResult) throw new Error("native tool result was not consumed");
      return fauxAssistantMessage("completed after tool");
    },
  ]);

  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    models: { quick: ["faux/physical-capable"], frontier: ["faux/physical-capable"] },
    classifier: { enabled: false },
    cache: { enabled: false },
    rules: [{ pattern: "native tool continuation marker", model: "faux/physical-capable" }],
  }));
  process.chdir(cwd);

  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("faux", "fixture-only");
  await runtime.refresh({ allowNetwork: false });
  const initialModel = runtime.getModel("faux", "physical-fast");
  assert.ok(initialModel, "distinct initial physical model must be available");
  const { default: bifrostExtension } = await import(join(root, "index.ts"));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [bifrostExtension] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: initialModel,
    noTools: "builtin",
    customTools: [localTool],
    resourceLoader,
  }));
  await session.bindExtensions({ mode: "print" });
  const unsubscribeEvents = session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolEventCounts.toolStart += 1;
    if (event.type === "tool_execution_end") toolEventCounts.toolEnd += 1;
    if (event.type === "turn_start") toolEventCounts.turnStart += 1;
    if (event.type === "turn_end") toolEventCounts.turnEnd += 1;
    if (event.type === "agent_start") toolEventCounts.agentStart += 1;
    if (event.type === "agent_end") toolEventCounts.agentEnd += 1;
  });

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); originalError(...args); };
  try {
    await session.prompt("native tool continuation marker");
  } finally {
    console.error = originalError;
  }

  assert.equal(session.getLastAssistantText(), "completed after tool");
  assert.equal(toolExecutionCount, 1, "deterministic local tool must run exactly once");
  assert.equal(toolResultValue, "inspected:alpha", "tool result must propagate");
  assert.equal(faux.state.callCount, 2, "provider must be invoked once for tool call and once for completion");
  assert.equal(faux.getPendingResponseCount(), 0, "faux response queue must be fully consumed");
  assert.deepEqual(invocations, ["faux/physical-capable", "faux/physical-capable"], "physical model sequence must use routed target without tool replay or unexpected models");
  assert.equal(session.model.provider, "faux");
  assert.equal(session.model.id, "physical-capable");
  assert.equal(errors.some((line) => line.includes("requested_tier_unavailable")), false);
  assert.equal(existsSync(violationPath) ? readFileSync(violationPath, "utf8") : "", "", "AgentSession made blocked outbound attempt");
  unsubscribeEvents();
  assert.equal(session.isStreaming, false, "session must be idle after completion");
  assert.equal(session.pendingMessageCount, 0, "public pending session messages must be zero");
  assert.deepEqual(session.getSteeringMessages(), [], "steering queue must be empty");
  assert.deepEqual(session.getFollowUpMessages(), [], "follow-up queue must be empty");
  assert.deepEqual(toolEventCounts, { toolStart: 1, toolEnd: 1, turnStart: 2, turnEnd: 2, agentStart: 1, agentEnd: 1 }, "actual tool and lifecycle event counts must match");
  assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
});

