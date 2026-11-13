// ── Pre-dispatch sign-in eligibility acceptance (native faux) ────
// Runs the real Bifrost extension inside a real Pi AgentSession with two faux
// providers, one of them registered without a credential. With
// `signInEligibility: "exclude"` the Auto turn must dispatch the provider whose
// sign-in resolves and leave the unauthenticated provider at zero calls. The
// parent runs the same scenario with the check off as a fault control, where the
// unauthenticated provider is the configured first choice and the turn fails.

import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCredentialsAbsent, assertProviderCallCounts, startFauxHarness } from "./faux-harness.mjs";

const scratch = process.env.BIFROST_FAUX_SCRATCH;
assert.ok(scratch, "BIFROST_FAUX_SCRATCH is required by the parent");
const live = process.env.BIFROST_SIGN_IN_LIVE;
const dead = process.env.BIFROST_SIGN_IN_DEAD;
const order = JSON.parse(process.env.BIFROST_SIGN_IN_ORDER ?? "[]");
const mode = process.env.BIFROST_SIGN_IN_MODE === "exclude" ? "exclude" : "off";
assert.ok(live && dead, "BIFROST_SIGN_IN_LIVE and BIFROST_SIGN_IN_DEAD are required by the parent");

it(mode === "exclude"
  ? `dispatches the ${live} provider and never calls the unauthenticated ${dead} provider`
  : `fault control: without the opt-in the unauthenticated ${dead} provider is attempted`, async () => {
  assertCredentialsAbsent("sign-in-eligibility");
  const harness = await startFauxHarness({
    scratch,
    bifrost: {
      schemaVersion: 2,
      enabled: true,
      default: "general",
      strategy: "first",
      signInEligibility: mode,
      models: { general: order },
      rules: [],
      classifier: { enabled: false },
      cache: { enabled: false },
      tierPolicies: { general: { fallbackTiers: [] } },
    },
    providers: [
      { provider: live, models: [{ id: "chat", reasoning: false }], response: `${live} response` },
    ],
    // A configured provider with no credential: Pi cannot resolve its sign-in,
    // so selecting it spends the turn the check is meant to protect.
    uncredentialedProviders: [{ provider: dead, models: [{ id: "chat" }] }],
    // Bootstrap on the live physical model, then select the virtual
    // `bifrost/auto` so the prompt goes through a real Auto dispatch.
    startModel: `${live}/chat`,
    selectModel: "bifrost/auto",
  });
  try {
    if (mode === "off") {
      // The dead provider heads the pool, so the unchecked route selects it and
      // the missing credential ends the turn. That failed turn is the control: it
      // proves the exclusion above came from the configuration, not the fixture.
      await harness.session.prompt("synthetic sign-in eligibility request");
      assert.notEqual(harness.session.getLastAssistantText(), `${live} response`);
      assert.deepEqual(harness.invocations, []);
      assertProviderCallCounts(harness.providers, { [live]: 0 });
      return;
    }
    await harness.session.prompt("synthetic sign-in eligibility request");
    assert.equal(harness.session.getLastAssistantText(), `${live} response`);
    assert.deepEqual(harness.invocations, [`${live}/chat`]);
    assertProviderCallCounts(harness.providers, { [live]: 1 });
  } finally {
    harness.dispose();
  }
});
