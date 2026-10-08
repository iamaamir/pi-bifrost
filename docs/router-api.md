# Experimental resolve-only API

The `pi-bifrost/router` package subpath exposes an experimental, host-neutral way to ask Bifrost for a route decision. It does not select a Pi model, dispatch a request, read configuration files, load provider credentials, or update session state.

The packed JavaScript API was verified on Node.js 24.14 and 26.9. Its Pi peer packages declare Node.js 22.19 or newer. This does not change the Pi extension's separate Pi 1.0.1 requirement.

The offline packed-consumer smoke test links the workspace's already-installed Pi peer packages into its temporary consumer. It verifies the packed API against those package files, but does not verify a fresh peer-dependency installation from a registry.

When working from the source checkout, install the development dependencies and run `npm run build:router` to generate the ignored `dist/router` files. `npm pack` runs this build automatically.

```ts
import { createRouter } from "pi-bifrost/router";

const model = {
  provider: "example",
  id: "small-model",
  cost: { input: 0.1, output: 0.2 },
  contextWindow: 32_000,
};

const router = createRouter({
  config: {
    models: { quick: ["example/small-model"] },
    default: "quick",
    strategy: "first",
    rules: [],
  },
  registry: {
    knownModels: [model],
    availableModels: [model],
  },
  now: Date.now(),
});

const result = await router.resolve({ prompt: "Format this file" });
if (result.status === "completed") {
  console.log(result.decision.selected, result.asOf);
}
```

Supply model costs and context windows from your own data. The API does not infer prices. `knownModels` is inventory; only `availableModels` can be selected. An exact configured reference that is known but unavailable is reported through `knownUnavailableModels`.

Each router captures its configuration, registry, reliability state, economic facts, and clock when created. The returned `asOf` value identifies that snapshot time. A result is advisory and may be stale immediately. Before dispatch, refresh the inputs, create a new router, and resolve again. The API does not reserve capacity or guarantee that a later dispatch will succeed.

External classification is disabled unless the caller supplies both `networkClassifierGrant: true` and an injected classifier port, and the config enables classification. The port receives at most 16,384 prompt characters, known configured tiers, and only explicitly configured criteria for those tiers. Missing criteria are passed as an empty object. The API supplies no default classifier guidance. An abort signal or bounded classifier deadline stops waiting; a late classifier response cannot produce a route.

The result contains a normalized route-decision summary, not Pi transport models or provider credentials. Unsupported config fields are rejected. Economic policy and observations must be supplied as an explicit economic snapshot. Results never dispatch or change Pi state.

The resolve-only API accepts only the v1 reliability routing thresholds and `enabled` flag, plus an explicit v1 circuit snapshot. It rejects reliability v2 store and observation controls because resolution cannot reserve a lease or settle a dispatch. A v2 circuit snapshot supplied by a caller remains advisory and does not authorize dispatch.

Affinity is off unless schema-v2 config explicitly sets `affinity.mode` to `observe` or `retain-within-tier`. The caller may pass a successful-dispatch anchor and target origin in the router snapshot; the API never invents an anchor. The anchor must be a valid model/provider pair with a timestamp no later than the captured snapshot clock. Malformed or future anchors are rejected when the router is created, before an optional classifier port can run. Forced tiers override a caller's automatic origin.

`observe` leaves selection, candidate order, and random calls unchanged. `retain-within-tier` may change the result's `decision.selected` to the anchor only when it belongs to that tier's final selection pool. That pool is evaluated after hard reserve/circuit exclusions and any policy-mode billing preference; a nonpreferred model can remain hard-eligible while being outside the selection pool. The summary reports preference and hard exclusions separately. This resolve-only result never dispatches or authorizes a later dispatch.

An optional economic `preference.billingClass` can rank fresh explicit billing facts among the final eligible candidates of the selected tier. Observe mode leaves selection and random ordering unchanged; policy mode applies the existing strategy within the preferred subset when one exists. The summary exposes class, source alias, authority, freshness, and candidate counts without allowance balances or account references. This preference does not guarantee savings or spending limits.
