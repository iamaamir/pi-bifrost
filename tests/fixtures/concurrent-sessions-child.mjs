import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";

const root = new URL("../..", import.meta.url).pathname;
const scratch = process.env.BIFROST_CONCURRENT_SCRATCH;
assert.ok(scratch);
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "GOOGLE_API_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into concurrent-session child`);
}

const home = join(scratch, "home");
const cwd = join(scratch, "workspace");
const agentA = join(home, "agent-a");
const agentB = join(home, "agent-b");
for (const dir of [agentA, agentB, join(cwd, ".pi")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentA, "auth.json"), "{}\n");
writeFileSync(join(agentB, "auth.json"), "{}\n");
for (const dir of [agentA, agentB]) writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
  enabled: true,
  default: "alpha",
  classifier: { enabled: false },
  models: {
    alpha: ["faux-a/session-a-model"],
    beta: ["faux-b/session-b-model"],
  },
  rules: [
    { pattern: "session a dispatch marker", model: "faux-a/session-a-model" },
    { pattern: "session b dispatch marker", model: "faux-b/session-b-model" },
  ],
}));

const previous = { cwd: process.cwd(), HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.chdir(cwd);
process.env.HOME = home;
const [{ createAgentSession, ModelRuntime, DefaultResourceLoader, SessionManager }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
  import("@earendil-works/pi-coding-agent"),
  import("@earendil-works/pi-ai"),
]);
const { default: bifrostExtension } = await import(join(root, "index.ts"));
const { reliabilityPath } = await import(join(root, "reliability.ts"));
const { runtimeStatePath, loadRuntimeState } = await import(join(root, "runtime-state.ts"));

const STANDBY_A = "session-a-standby";
const STANDBY_B = "session-b-standby";
const TARGET_A = "faux-a/session-a-model";
const TARGET_B = "faux-b/session-b-model";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function barrier(count) {
  let arrived = 0;
  let release;
  const promise = new Promise((r) => { release = r; });
  return () => { arrived += 1; if (arrived === count) release(); return promise; };
}
function contextText(context) {
  return context.messages.map((message) => JSON.stringify(message)).join("\n");
}

let runtimeA;
let runtimeB;
let fauxA;
let fauxB;
let sessionA;
let sessionB;
let loaderA;
let loaderB;
// Ownership records are append-only: setup() never overwrites them, teardown
// disposes every recorded session even when a later setup replaces live refs.
const ownedSessions = [];
const disposedSessions = new Set();
const ownedRuntimes = [];
const report = { invocations: [], events: [], host: {}, cancellation: {}, storage: {} };

function trackSession(session) {
  ownedSessions.push(session);
  const original = session.dispose.bind(session);
  session.dispose = () => {
    disposedSessions.add(session);
    return original();
  };
  return session;
}

function teardownLivePair() {
  try { sessionA?.dispose(); } catch {}
  try { sessionB?.dispose(); } catch {}
  try { if (runtimeA) runtimeA.unregisterProvider("faux-a"); } catch {}
  try { if (runtimeB && runtimeB !== runtimeA) runtimeB.unregisterProvider("faux-b"); } catch {}
  sessionA = sessionB = loaderA = loaderB = undefined;
  runtimeA = runtimeB = undefined;
}

async function setup() {
  // Dispose the previous live pair before replacing refs so no session leaks.
  teardownLivePair();
  let nextRuntimeA;
  let nextRuntimeB;
  let nextSessionA;
  let nextSessionB;
  try {
    nextRuntimeA = await ModelRuntime.create({ authPath: join(agentA, "auth.json"), modelsPath: null, refreshOnCreate: false });
    nextRuntimeB = await ModelRuntime.create({ authPath: join(agentB, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const nextFauxA = fauxProvider({ provider: "faux-a", models: [{ id: "session-a-model" }, { id: STANDBY_A }] });
    const nextFauxB = fauxProvider({ provider: "faux-b", models: [{ id: "session-b-model" }, { id: STANDBY_B }] });
    nextRuntimeA.registerNativeProvider(nextFauxA.provider);
    nextRuntimeB.registerNativeProvider(nextFauxB.provider);
    await nextRuntimeA.setRuntimeApiKey("faux-a", "fixture-only");
    await nextRuntimeB.setRuntimeApiKey("faux-b", "fixture-only");
    await nextRuntimeA.refresh({ allowNetwork: false });
    await nextRuntimeB.refresh({ allowNetwork: false });
    const nextLoaderA = new DefaultResourceLoader({ cwd, agentDir: agentA, extensionFactories: [bifrostExtension] });
    const nextLoaderB = new DefaultResourceLoader({ cwd, agentDir: agentB, extensionFactories: [bifrostExtension] });
    await nextLoaderA.reload();
    await nextLoaderB.reload();
    // Start each session on a different eligible physical model from its own
    // registry. Bifrost must repair the selection to the rule target before
    // generation; without Bifrost the standby identity reaches the provider
    // and the assertions below fail.
    ({ session: nextSessionA } = await createAgentSession({ cwd, agentDir: agentA, modelRuntime: nextRuntimeA, model: nextRuntimeA.getModel("faux-a", STANDBY_A), noTools: "all", resourceLoader: nextLoaderA, sessionManager: SessionManager.inMemory(cwd) }));
    ({ session: nextSessionB } = await createAgentSession({ cwd, agentDir: agentB, modelRuntime: nextRuntimeB, model: nextRuntimeB.getModel("faux-b", STANDBY_B), noTools: "all", resourceLoader: nextLoaderB, sessionManager: SessionManager.inMemory(cwd) }));
    trackSession(nextSessionA);
    trackSession(nextSessionB);
    await nextSessionA.bindExtensions({ mode: "print" });
    await nextSessionB.bindExtensions({ mode: "print" });
    runtimeA = nextRuntimeA;
    runtimeB = nextRuntimeB;
    ownedRuntimes.push(nextRuntimeA, nextRuntimeB);
    fauxA = nextFauxA;
    fauxB = nextFauxB;
    loaderA = nextLoaderA;
    loaderB = nextLoaderB;
    sessionA = nextSessionA;
    sessionB = nextSessionB;
  } catch (error) {
    try { nextSessionA?.dispose(); } catch {}
    try { nextSessionB?.dispose(); } catch {}
    try { nextRuntimeA?.unregisterProvider("faux-a"); } catch {}
    try { if (nextRuntimeB && nextRuntimeB !== nextRuntimeA) nextRuntimeB.unregisterProvider("faux-b"); } catch {}
    throw error;
  }
}

function installSuccessResponses() {
  // Whole-parent denial control: with BIFROST_TEST_HANG_CHILD=1 both provider
  // callbacks stall after arrival (inside the test, so no top-level-await
  // tripwire), leaving the prompts unsettled for the caller deadline. Off by
  // default; normal routing proof hangs nowhere.
  const hangIfArmed = () => process.env.BIFROST_TEST_HANG_CHILD === "1" ? new Promise(() => {}) : Promise.resolve();
  const arrive = barrier(2);
  fauxA.setResponses([async (context, _options, _state, model) => {
    // Exact physical identity: the provider must observe Bifrost's repaired
    // target, never the standby the session started on.
    assert.equal(model.provider, "faux-a");
    assert.equal(model.id, "session-a-model");
    const text = contextText(context);
    assert.match(text, /session a dispatch marker/);
    assert.doesNotMatch(text, /session b dispatch marker/);
    report.invocations.push({ session: "a", model: `${model.provider}/${model.id}` });
    report.events.push("a:arrived");
    await hangIfArmed();
    await arrive();
    report.events.push("a:released");
    return fauxAssistantMessage(fauxText("session-a response"));
  }]);
  fauxB.setResponses([async (context, _options, _state, model) => {
    assert.equal(model.provider, "faux-b");
    assert.equal(model.id, "session-b-model");
    const text = contextText(context);
    assert.match(text, /session b dispatch marker/);
    assert.doesNotMatch(text, /session a dispatch marker/);
    report.invocations.push({ session: "b", model: `${model.provider}/${model.id}` });
    report.events.push("b:arrived");
    await hangIfArmed();
    await arrive();
    report.events.push("b:released");
    return fauxAssistantMessage(fauxText("session-b response"));
  }]);
}

it("dispatches concurrent native sessions to explicit physical identities without cross-session delivery", {
  // Armed stall must outlast the caller deadline by a wide margin so the
  // denied group is observably alive when the caller settles; default 30s.
  timeout: process.env.BIFROST_TEST_HANG_CHILD === "1" ? 120_000 : 30_000,
}, async () => {
  await setup();
  // Pre-generation selection: both sessions start on their standby decoy.
  assert.equal(sessionA.model.provider, "faux-a");
  assert.equal(sessionA.model.id, STANDBY_A);
  assert.equal(sessionB.model.provider, "faux-b");
  assert.equal(sessionB.model.id, STANDBY_B);
  const base = report.invocations.length;
  installSuccessResponses();
  await Promise.all([
    sessionA.prompt("session a dispatch marker alpha"),
    sessionB.prompt("session b dispatch marker beta"),
  ]);
  // Bifrost repaired the selection before generation.
  assert.equal(sessionA.model.provider, "faux-a");
  assert.equal(sessionA.model.id, "session-a-model");
  assert.equal(sessionB.model.provider, "faux-b");
  assert.equal(sessionB.model.id, "session-b-model");
  assert.equal(sessionA.getLastAssistantText(), "session-a response");
  assert.equal(sessionB.getLastAssistantText(), "session-b response");
  assert.equal(fauxA.state.callCount, 1);
  assert.equal(fauxB.state.callCount, 1);
  // Exact per-session physical invocation sequences: one target invocation
  // each, no standby and no cross-session delivery.
  const fresh = report.invocations.slice(base);
  assert.deepEqual(
    fresh.filter(({ session }) => session === "a").map(({ session, model }) => ({ session, model })),
    [{ session: "a", model: TARGET_A }],
  );
  assert.deepEqual(
    fresh.filter(({ session }) => session === "b").map(({ session, model }) => ({ session, model })),
    [{ session: "b", model: TARGET_B }],
  );
  assert.ok(fresh.every(({ model }) => model === TARGET_A || model === TARGET_B));
  const arrival = report.events.filter((event) => event.endsWith(":arrived"));
  const release = report.events.filter((event) => event.endsWith(":released"));
  assert.equal(arrival.length, 2);
  assert.equal(release.length, 2);
  assert.ok(Math.max(...arrival.map((event) => report.events.indexOf(event))) < Math.min(...release.map((event) => report.events.indexOf(event))));
  report.host.separateRuntimeRegistries = runtimeA.getModel("faux-b", "session-b-model") === undefined
    && runtimeB.getModel("faux-a", "session-a-model") === undefined;
  assert.equal(report.host.separateRuntimeRegistries, true);

  // Storage ownership: the two sessions intentionally share one workspace
  // policy file (persisted Bifrost policy), while registries, models and pins
  // stay session-local. Separate agentDir values isolate Pi auth paths only;
  // Bifrost config/storage resolve from cwd and are shared by design.
  const projectConfig = JSON.parse(readFileSync(join(cwd, ".pi", "bifrost.json"), "utf8"));
  assert.equal(projectConfig.enabled, true);
  assert.ok(projectConfig.rules.some((rule) => rule.model === TARGET_A));
  assert.ok(projectConfig.rules.some((rule) => rule.model === TARGET_B));
  assert.equal(reliabilityPath(cwd), join(cwd, ".pi", "bifrost-reliability.json"));
  assert.equal(runtimeStatePath(cwd), join(cwd, ".pi", "bifrost-state.json"));
  const probeStatePath = join(scratch, "pin-probe-state.json");
  writeFileSync(probeStatePath, JSON.stringify({ enabled: true, pinned: true, classifierEnabled: false }));
  assert.equal(loadRuntimeState(probeStatePath).pinned, false, "pinned stays session-local per ADR 0015");
  report.storage = {
    sharedWorkspacePolicy: true,
    sharedReliabilityPath: reliabilityPath(cwd),
    pinSessionLocal: true,
    separateRuntimeRegistries: true,
  };
});

it("cancels one native session while the other session stays active and cleans pending work", { timeout: 30_000 }, async () => {
  await setup();
  assert.equal(sessionA.model.id, STANDBY_A);
  assert.equal(sessionB.model.id, STANDBY_B);
  const base = report.invocations.length;
  const enteredA = deferred();
  const gateA = deferred();
  const enteredB = deferred();
  const gateB = deferred();
  let settledB = false;
  fauxA.setResponses([async (_context, _options, _state, model) => {
    assert.equal(model.provider, "faux-a");
    assert.equal(model.id, "session-a-model");
    report.invocations.push({ session: "a", model: `${model.provider}/${model.id}` });
    report.events.push("cancel-a:arrived");
    enteredA.resolve();
    await gateA.promise;
    report.events.push("cancel-a:released");
    return fauxAssistantMessage(fauxText("must not be delivered"));
  }]);
  fauxB.setResponses([async (_context, _options, _state, model) => {
    assert.equal(model.provider, "faux-b");
    assert.equal(model.id, "session-b-model");
    report.invocations.push({ session: "b", model: `${model.provider}/${model.id}` });
    report.events.push("cancel-b:arrived");
    enteredB.resolve();
    await gateB.promise;
    report.events.push("cancel-b:released");
    return fauxAssistantMessage(fauxText("session-b survives cancellation"));
  }]);
  // Both sessions enter their own provider callbacks concurrently.
  const promptA = sessionA.prompt("session a dispatch marker cancel");
  const promptB = sessionB.prompt("session b dispatch marker survives");
  void promptB.then(() => { settledB = true; }, () => { settledB = true; });
  await Promise.all([enteredA.promise, enteredB.promise]);
  assert.ok(report.events.includes("cancel-a:arrived"));
  assert.ok(report.events.includes("cancel-b:arrived"));
  // Abort only A while B remains gated inside its own provider callback.
  const abortPromise = sessionA.abort();
  await Promise.resolve();
  assert.equal(settledB, false, "session B must still be active while A is aborted");
  gateB.resolve();
  const outcomeB = await promptB;
  void outcomeB;
  gateA.resolve();
  const [settledA] = await Promise.all([Promise.allSettled([promptA, abortPromise])]);
  assert.ok(settledA.every((result) => result.status === "fulfilled" || result.status === "rejected"));
  assert.equal(sessionB.getLastAssistantText(), "session-b survives cancellation");
  assert.notEqual(sessionA.getLastAssistantText(), "must not be delivered");
  assert.equal(fauxA.state.callCount, 1);
  assert.equal(fauxB.state.callCount, 1);
  assert.equal(fauxA.getPendingResponseCount(), 0);
  assert.equal(fauxB.getPendingResponseCount(), 0);
  const fresh = report.invocations.slice(base);
  assert.deepEqual(
    fresh.filter(({ session }) => session === "a").map(({ session, model }) => ({ session, model })),
    [{ session: "a", model: TARGET_A }],
  );
  assert.deepEqual(
    fresh.filter(({ session }) => session === "b").map(({ session, model }) => ({ session, model })),
    [{ session: "b", model: TARGET_B }],
  );
  report.cancellation = { sessionAOutcome: settledA.map((result) => result.status), sessionBUnaffected: settledB && sessionB.getLastAssistantText() === "session-b survives cancellation" };
  assert.equal(report.cancellation.sessionBUnaffected, true);
});

after(() => {
  teardownLivePair();
  assert.equal(ownedSessions.length, 4, `expected 4 created sessions, saw ${ownedSessions.length}`);
  assert.equal(disposedSessions.size, ownedSessions.length, `disposed ${disposedSessions.size}/${ownedSessions.length} created sessions`);
  report.cleanup = {
    fauxAPending: fauxA?.getPendingResponseCount() ?? null,
    fauxBPending: fauxB?.getPendingResponseCount() ?? null,
  };
  writeFileSync(join(scratch, "concurrent-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
  if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
  process.chdir(previous.cwd);
});
