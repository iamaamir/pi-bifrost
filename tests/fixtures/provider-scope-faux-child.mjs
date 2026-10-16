// ── Provider scope acceptance (native faux) ─────────────────────
// Runs the real Bifrost extension inside a real Pi AgentSession against Pi's
// in-process `fauxProvider`. The parent test routes a real Auto turn and
// asserts that only the permitted provider is dispatched; the excluded
// provider's faux handle must record zero calls.

import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCredentialsAbsent, assertProviderCallCounts, startFauxHarness } from "./faux-harness.mjs";

const scratch = process.env.BIFROST_FAUX_SCRATCH;
assert.ok(scratch, "BIFROST_FAUX_SCRATCH is required by the parent");
const permitted = process.env.BIFROST_SCOPE_PERMITTED;
const excluded = process.env.BIFROST_SCOPE_EXCLUDED;
const order = JSON.parse(process.env.BIFROST_SCOPE_ORDER ?? "[]");
assert.ok(permitted && excluded, "BIFROST_SCOPE_PERMITTED and BIFROST_SCOPE_EXCLUDED are required by the parent");

it(`dispatches a real Auto turn to ${permitted} and never reaches ${excluded}`, async () => {
  assertCredentialsAbsent("provider-scope");
  const harness = await startFauxHarness({
    scratch,
    bifrost: {
      schemaVersion: 2,
      enabled: true,
      default: "general",
      strategy: "first",
      models: { general: order },
      rules: [],
      classifier: { enabled: false },
      cache: { enabled: false },
      tierPolicies: { general: { fallbackTiers: [] } },
      routingScope: { providers: [permitted] },
    },
    providers: [permitted, excluded].map((provider) => ({
      provider,
      models: [{ id: "chat", reasoning: false }],
      response: `${provider} response`,
    })),
    // Bootstrap on the permitted physical model, then select the virtual
    // `bifrost/auto` so the prompt goes through a real Auto dispatch.
    startModel: `${permitted}/chat`,
    selectModel: "bifrost/auto",
  });
  try {
    await harness.session.prompt("synthetic provider scope request");
    assert.equal(harness.session.getLastAssistantText(), `${permitted} response`);
    assert.deepEqual(harness.invocations, [`${permitted}/chat`]);
    assertProviderCallCounts(harness.providers, { [permitted]: 1, [excluded]: 0 });
  } finally {
    harness.dispose();
  }
});
