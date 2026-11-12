import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { assertCredentialsAbsent, assertNoViolations, assertProviderCallCounts, startFauxHarness } from "./faux-harness.mjs";

// The parent owns scratch lifetime. This child never deletes scratch: the parent
// removes it only after this process has exited, so no in-process async work can
// recreate fixture files afterwards.
const scratch = process.env.BIFROST_NATIVE_LIFECYCLE_SCRATCH;
assert.ok(scratch, "BIFROST_NATIVE_LIFECYCLE_SCRATCH is required by the parent");
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
assert.ok(violationPath, "BIFROST_TEST_NETWORK_VIOLATIONS is required by the parent");
assertCredentialsAbsent("lifecycle");

const scenario = process.env.BIFROST_NATIVE_LIFECYCLE_SCENARIO ?? "physical-default";
const childHost = scenario.startsWith("child-");

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

const routes = [
  { provider: "faux-seed", id: "physical", response: "seed response" },
  { provider: "faux-alpha", id: "physical", response: "alpha response" },
  { provider: "faux-beta", id: "physical", response: "beta response" },
  { provider: "faux-frontier", id: "physical", response: "frontier response" },
  { provider: "faux-default", id: "physical", response: "default response" },
  { provider: "faux-collision", id: "physical", response: "collision response" },
];

function modelKey(model) {
  return model ? `${model.provider}/${model.id}` : "";
}

it(`routes real AgentSession turns (${scenario})`, async () => {
  const harness = await startFauxHarness({
    scratch,
    // A marked child host must keep the exact producer marker that the extension
    // reads; an unmarked host must not carry it at all.
    wipeEnv: true,
    preserveEnv: childHost ? ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_CHILD_AGENT"] : [],
    bifrost: {
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
    },
    providers: routes.map(({ provider, id, response }) => ({ provider, models: [{ id, reasoning: false }], response })),
    startModel: "faux-seed/physical",
    selectModel: current.auto ? "bifrost/auto" : undefined,
  });
  try {
    if (current.auto) {
      const auto = harness.getModel("bifrost/auto");
      assert.ok(auto, "the production extension must register the bifrost/auto virtual model");
      assert.equal(auto.api, "pi-virtual", "bifrost/auto must be the registered virtual model");
    }
    if (childHost) assert.equal(process.env.PI_SUBAGENT_CHILD, "1", "child host marker must survive isolation");
    else assert.equal(process.env.PI_SUBAGENT_CHILD, undefined, "unmarked scenario must not carry the child host marker");
    if (current.auto) {
      assert.equal(modelKey(harness.session.model), "bifrost/auto", "explicitly selected Auto must stay the session model");
    } else {
      assert.equal(modelKey(harness.session.model), "faux-seed/physical", "the SDK seed must differ from every routed identity");
    }

    for (const [index, turn] of current.turns.entries()) {
      await harness.session.prompt(turn.prompt);
      assert.equal(harness.session.getLastAssistantText(), turn.response, `turn ${index + 1} ("${turn.prompt}") must complete with its own scripted response`);
      if (current.physicalSession) {
        assert.equal(modelKey(harness.session.model), turn.model, `turn ${index + 1} must leave Pi on the routed physical model`);
      } else {
        assert.equal(modelKey(harness.session.model), "bifrost/auto", `turn ${index + 1} must keep explicit Auto selected while dispatching a physical model`);
      }
    }

    const expectedInvocations = current.turns.map((turn) => turn.model);
    assert.equal(new Set(expectedInvocations).size, expectedInvocations.length, "each scenario must invoke a distinct physical model at most once");
    assert.deepEqual(harness.invocations, expectedInvocations, "provider model arguments must match exact per-turn routing with no extra calls");
    assertNoViolations(violationPath, "socket, UDP, and fetch guard must record zero outbound attempts");
    assertProviderCallCounts(harness.providers, Object.fromEntries(
      expectedInvocations.map((model) => [model.slice(0, model.indexOf("/")), 1]),
    ));
    for (const faux of harness.providers.values()) {
      assert.equal(faux.getPendingResponseCount(), 1 - faux.state.callCount, `${faux.provider.id} queue must match expected calls`);
    }
    // Forbidden-provider negatives: routing is not just "a physical model ran" —
    // the seed (auto scenarios) and the conflicting rule target (inline override)
    // must never be invoked.
    if (current.auto) {
      assert.equal(harness.providers.get("faux-seed").state.callCount, 0, "the seed provider must never be invoked once Auto dispatches");
      assert.equal(harness.providers.get("faux-collision").state.callCount, 0, "the conflicting direct rule target must not win against the inline tier override");
    }
    assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
  } finally {
    harness.dispose();
  }
});
