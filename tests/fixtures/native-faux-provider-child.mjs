import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCredentialsAbsent, startFauxHarness } from "./faux-harness.mjs";

const scratch = process.env.BIFROST_NATIVE_FAUX_SCRATCH;
assert.ok(scratch);
const expectedModel = process.env.BIFROST_EXPECTED_MODEL;
assert.ok(expectedModel);

it("routes real AgentSession request to configured physical faux model behind preload fence", async () => {
  assertCredentialsAbsent("faux-provider");
  const harness = await startFauxHarness({
    scratch,
    bifrost: {
      enabled: true,
      models: { quick: ["faux/physical-fast"], general: ["faux/physical-capable"], frontier: ["faux/physical-capable"] },
      default: "quick",
      classifier: { enabled: false },
      rules: [{ pattern: "native faux dispatch marker", model: "faux/physical-capable" }],
    },
    providers: [{
      provider: "faux",
      models: [{ id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: true }],
      response: "native faux response",
    }],
    // The host's explicitly selected physical model is what must survive a
    // child turn without a run id, so the session starts on the expected model.
    startModel: (runtime) => runtime.getModel("faux", expectedModel),
  });
  try {
    assert.deepEqual((await harness.runtime.getAvailable("faux")).map(({ id }) => id), ["physical-fast", "physical-capable"]);
    await harness.session.prompt("native faux dispatch marker");
    assert.equal(harness.session.getLastAssistantText(), "native faux response");
    assert.equal(harness.session.model.provider, "faux");
    assert.equal(harness.session.model.id, expectedModel);
    const faux = harness.providers.get("faux");
    assert.equal(faux.state.callCount, 1);
    assert.deepEqual(harness.invocations, [`faux/${expectedModel}`]);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(harness.runtime.getModels("faux").map(({ id }) => id), ["physical-fast", "physical-capable"]);
  } finally {
    harness.dispose();
  }
});
