// ── Provider scope acceptance (native faux) ─────────────────────
// Runs the real Bifrost extension inside a real Pi AgentSession against Pi's
// in-process `fauxProvider`. The parent test routes a real Auto turn and
// asserts that only the permitted provider is dispatched; the excluded
// provider's faux handle must record zero calls. With `BIFROST_SCOPE_DENY_ALL`
// the scope is an empty allowlist, and the turn must reject with every
// provider still at zero calls.

import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCredentialsAbsent, assertProviderCallCounts, startFauxHarness } from "./faux-harness.mjs";

const scratch = process.env.BIFROST_FAUX_SCRATCH;
assert.ok(scratch, "BIFROST_FAUX_SCRATCH is required by the parent");
const permitted = process.env.BIFROST_SCOPE_PERMITTED;
const excluded = process.env.BIFROST_SCOPE_EXCLUDED;
const order = JSON.parse(process.env.BIFROST_SCOPE_ORDER ?? "[]");
const denyAll = process.env.BIFROST_SCOPE_DENY_ALL === "1";
assert.ok(permitted && excluded, "BIFROST_SCOPE_PERMITTED and BIFROST_SCOPE_EXCLUDED are required by the parent");

it(denyAll
  ? "denies every provider when the allowlist is empty"
  : `dispatches a real Auto turn to ${permitted} and never reaches ${excluded}`, async () => {
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
      routingScope: denyAll ? { providers: [] } : { providers: [permitted] },
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
    if (denyAll) {
      await harness.session.prompt("synthetic provider scope request");
      // An empty global allowlist denies every provider, so nothing dispatches.
      assertProviderCallCounts(harness.providers, { [permitted]: 0, [excluded]: 0 });
      assert.deepEqual(harness.invocations, []);
      assert.notEqual(harness.session.getLastAssistantText(), `${permitted} response`);
      assert.notEqual(harness.session.getLastAssistantText(), `${excluded} response`);
      return;
    }
    await harness.session.prompt("synthetic provider scope request");
    assert.equal(harness.session.getLastAssistantText(), `${permitted} response`);
    assert.deepEqual(harness.invocations, [`${permitted}/chat`]);
    assertProviderCallCounts(harness.providers, { [permitted]: 1, [excluded]: 0 });
  } finally {
    harness.dispose();
  }
});
