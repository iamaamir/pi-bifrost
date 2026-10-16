# Router SDK

The `pi-bifrost/router` package subpath exposes Bifrost's routing engine as a host-neutral SDK: `createRouter(snapshot, options)` and `router.resolve(request)` evaluate explicit snapshots and return an inspectable, advisory route decision. The consumer decides whether, when, and how to execute it. Bifrost does not select a Pi model, dispatch a request, read configuration files, load provider credentials, update session state, persist anything, or make network calls on its own.

The SDK does not require the Pi packages. Those two peer packages are optional (`peerDependenciesMeta`) and are needed only when the package runs as a Pi extension. The resolved route is a decision, not a dispatch authorization.

## What the SDK deliberately does not do

- It never dispatches a model request or authorizes a later dispatch. Revalidate and re-resolve right before you execute.
- It never reads or writes files, environment variables, or provider credentials, and never caches responses.
- It never invents evidence: unavailable models, reliability state, economic facts, and affinity anchors are caller-supplied.
- External classification calls something only when the caller injects a classifier port and explicitly grants permission; no other network behavior exists.
- It never replaces a no-decision with a default model.

## Install

```bash
npm install pi-bifrost
```

The packed JavaScript API was verified on Node.js 24.14 and 26.9. When the Pi peer packages are installed, they declare Node.js 22.19 or newer; this does not change the Pi extension's separate Pi 1.0.1 requirement. The standalone consumer test installs the packed package into a directory with no Pi packages present, runs plain Node ESM imports, and compiles a TypeScript consumer with `skipLibCheck` off, so the published declarations resolve without Pi.

When working from a source checkout, run `npm run build:router` to generate the ignored `dist/router` files; `npm pack` runs this build automatically.

## Plain JavaScript usage

```js
import { createRouter } from "pi-bifrost/router";

const model = {
  provider: "example",
  id: "small-model",
  cost: { input: 0.1, output: 0.2 },
  contextWindow: 32_000,
};

const router = createRouter({
  config: { models: { quick: ["example/small-model"] }, default: "quick", strategy: "first", rules: [] },
  registry: { knownModels: [model], availableModels: [model] },
  now: Date.now(),
});

const result = await router.resolve({ prompt: "Format this file" });
if (result.status === "completed" && result.decision.outcome === "selected") {
  console.log(result.decision.selected, result.asOf);
}
```

A complete runnable copy is `examples/router-standalone.mjs` (shipped in the package). It covers custom tiers, selected and no-decision results, and known-but-unavailable reporting.

`status: "completed"` means the evaluation finished. It does not mean a model was selected: inspect `decision.outcome` — `"selected"`, `"unresolved"`, `"unclassified"`, `"usage"`, or `"config_invalid"`. A no-decision result never masquerades as a selection.

## TypeScript usage

```ts
import { createRouter, type RouterSnapshot, type RouterResolveResult } from "pi-bifrost/router";
```

Public types are host-neutral DTOs (`RouterModel`, `RouterRegistrySnapshot`, `RouterSnapshot`, `RouterOptions`, `RouterResolveRequest`, `RouterResolveResult`, `RouterClassifierPort`, `RouterEconomicSnapshot`, `RouterAffinitySnapshot`); they never reference Pi types. Results support exhaustive narrowing on `result.status` and `decision.outcome`.

Supply model costs and context windows from your own data. The API does not infer prices. `knownModels` is inventory; only `availableModels` can be selected. An exact configured reference that is known but unavailable is reported through `knownUnavailableModels`.

## Custom tiers and strategies

Tier names are caller-defined. Configure any number of pools under `config.models` and per-tier strategies under `config.categoryStrategies`; the engine supports `first`, `cheapest`, `cheapest_input`, `cheapest_output`, `largest_context`, `random`, and `fastest`. Supply `random` (per resolution or at creation) for deterministic tests; omission preserves default randomness.

Under `schemaVersion: 2`, a tier may declare ordered `tierPolicies.<tier>.fallbackTiers`. An explicitly empty fallback list is terminal; the resolver never escapes an explicit fallback boundary.

Each `resolve` result carries structured exclusions: per-pool candidates with `exclusion` reasons (`open_circuit`, `trial_active`, `economic_reserve`) and a machine-readable `fallbackReason` where applicable.

## Router snapshots

Create the router from what you know right now:

- `config` — the supported routing subset (`models`, `default`, `strategy`, `categoryStrategies`, `tierPolicies`, `rules`, `classifier`, `reliability` v1 thresholds + `enabled`, `affinity`). Unsupported fields are rejected.
- `registry` — `knownModels` (inventory) and `availableModels` (eligible). Registry snapshots must be consistent; available entries must match their known metadata exactly.
- `now` — captured snapshot clock.
- `reliabilityState` — optional caller-owned v1 circuit snapshot. Lifecycle modes (cooldown-on-allowance-exhausted, v2 store controls, leases, retries) are rejected: resolution cannot reserve or settle a dispatch.
- `economic` — optional declared billing policy and explicitly qualified signal facts.
- `affinity` — optional caller-owned anchor/target origin required only when affinity is configured to `observe` or `retain-within-tier`.

The returned `asOf` identifies that snapshot time. A result is advisory and may be stale immediately. Before dispatch, refresh the inputs, create a new router, and resolve again. The API does not reserve capacity or guarantee that a later dispatch will succeed.

Snapshot DTOs must use plain records with own data fields and ordinary dense arrays. The factory rejects accessors, symbol keys, unknown fields, sparse or extended arrays, nonplain records, and proxies detectable by Node's runtime. It reads descriptors without invoking getters, validates the detached normalized copy, and uses that same copy for routing. Do not pass live host objects or mutable transport models as snapshot DTOs. Router instances are independent; caller mutations after creation cannot alter a snapshot, and concurrent resolves share no request state.

## External classifier injection

External classification is disabled unless the caller supplies both `networkClassifierGrant: true` and an injected classifier port, and the config enables classification. The port receives at most 16,384 prompt characters, known configured tiers, and only explicitly configured criteria for those tiers (missing criteria are passed as an empty object; the API supplies no default guidance). An abort signal or bounded classifier deadline stops waiting; a late classifier response cannot produce a route, and no second request is issued. Bifrost does not know how your classifier authenticates and makes no classifier network calls of its own.

Classifier and RNG functions are explicit capabilities, not snapshot data. The options object must itself be a plain own-data record with only the documented option fields.

## Economic and affinity policy

An optional economic `preference.billingClass` ranks fresh explicit billing facts among the final eligible candidates of the selected tier. In observe mode, selection and random ordering stay unchanged; policy mode applies the configured strategy within the preferred subset when one exists. The summary exposes class, source alias, authority, freshness, and candidate counts — never allowance balances or account references. This preference does not guarantee savings or spend limits, and Bifrost does not fetch live quota data.

Affinity is off unless schema-v2 config explicitly sets `affinity.mode` to `observe` or `retain-within-tier`. The caller may pass a successful-dispatch anchor and target origin in the router snapshot; the API never invents an anchor, never persists affinity state, and preserves hard reserve/circuit exclusions, policy-mode preference, and explicit tier boundaries in the final eligible pool. In `retain-within-tier`, the anchor may be retained only when it remains in that pool; malformed or future anchors are rejected at router creation, before any classifier port can run.

## Integrating a custom host

A host (coding agent, subagent orchestrator) translates its own model inventory into the public DTOs, resolves an advisory route, revalidates against its live state, and executes through its own dispatch path. `examples/host-adapter.mjs` (shipped in the package) shows the full flow with a simulated host: build snapshot → `createRouter` → `resolve` → inspect the decision → revalidate → host dispatch. The Pi extension continues to work unchanged through the same package.

## Configuration file loading

Pure config validation (`validateConfig`, defaults, merging) is imported from `pi-bifrost/config.ts`; layered file loading with host paths (`loadConfigForReload`, `loadConfigWithSourceOverride`, `loadRules`) lives in `pi-bifrost/config-load.ts` and is Pi-extension-only. The routing SDK itself reads no files.
