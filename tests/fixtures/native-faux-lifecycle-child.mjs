import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { assertNoViolations, assertProviderCallCounts, startFauxHarness } from "./faux-harness.mjs";

// The parent owns scratch lifetime. This child never deletes scratch: the parent
// removes it only after this process has exited, so no in-process async work can
// recreate fixture files afterwards.
const scratch = process.env.BIFROST_NATIVE_LIFECYCLE_SCRATCH;
assert.ok(scratch, "BIFROST_NATIVE_LIFECYCLE_SCRATCH is required by the parent");
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;

const routes = [
  { provider: "faux-seed", id: "physical", response: "seed response" },
  { provider: "faux-alpha", id: "physical", response: "alpha response" },
  { provider: "faux-beta", id: "physical", response: "beta response" },
  { provider: "faux-frontier", id: "physical", response: "frontier response" },
  { provider: "faux-default", id: "physical", response: "default response" },
  { provider: "faux-collision", id: "physical", response: "collision response" },
];
const turns = [
  { prompt: "direct alpha marker", model: "faux-alpha/physical", response: "alpha response" },
  { prompt: "direct beta marker", model: "faux-beta/physical", response: "beta response" },
  { prompt: "frontier override collision marker", model: "faux-frontier/physical", response: "frontier response" },
  { prompt: "plain request with no configured marker", model: "faux-default/physical", response: "default response" },
];

it("routes real AgentSession turns by direct rules, tier override precedence, and default", async () => {
  // wipeEnv strips the environment to PATH/TMPDIR/LANG/TERM before boot: no
  // ambient provider config may reach this session.
  const harness = await startFauxHarness({
    scratch,
    wipeEnv: true,
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
  });
  try {
    for (const [index, turn] of turns.entries()) {
      await harness.session.prompt(turn.prompt);
      assert.equal(harness.session.getLastAssistantText(), turn.response, `turn ${index + 1} must complete with its own scripted response`);
      assert.equal(`${harness.session.model.provider}/${harness.session.model.id}`, turn.model, `turn ${index + 1} must leave Pi on selected physical model`);
    }

    assert.deepEqual(harness.invocations, turns.map(({ model }) => model), "provider model arguments must match exact per-turn routing with no extra calls");
    assertNoViolations(violationPath, "socket, UDP, and fetch guard must record zero outbound attempts");
    assertProviderCallCounts(harness.providers, Object.fromEntries(
      turns.map(({ model }) => [model.slice(0, model.indexOf("/")), 1]),
    ));
    for (const faux of harness.providers.values()) {
      assert.equal(faux.getPendingResponseCount(), 1 - faux.state.callCount, `${faux.provider.id} queue must match expected calls`);
    }
    assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
  } finally {
    harness.dispose();
  }
});
