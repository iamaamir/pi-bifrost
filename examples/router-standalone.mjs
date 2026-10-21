// ── Standalone Router SDK consumer ─────────────────────────────
// Applications resolve a route with Bifrost and execute it themselves.
// This example needs only `npm install pi-bifrost` — no Pi, no API key,
// no provider connection: `node examples/router-standalone.mjs`.

import { createRouter } from "pi-bifrost/router";

// Your application's own model inventory. Bifrost does not fetch,
// probe, or price models; these facts come from the caller.
const models = [
  {
    provider: "example",
    id: "fast-small",
    cost: { input: 0.1, output: 0.2 },
    contextWindow: 32_000,
  },
  {
    provider: "example",
    id: "deep-frontier",
    cost: { input: 2.5, output: 10 },
    contextWindow: 200_000,
  },
];

// Custom tier pools over that inventory. Tier names are yours to define;
// `bifrost` never hardcodes them.
const router = createRouter({
  now: Date.now(),
  config: {
    // Schema v2 opts into explicit ordered fallback boundaries via tierPolicies.
    schemaVersion: 2,
    models: {
      quick: ["example/fast-small"],
      deep: ["example/deep-frontier"],
      fallback: ["example/fast-small", "example/deep-frontier"],
    },
    default: "fallback",
    strategy: "first",
    tierPolicies: {
      quick: { fallbackTiers: ["fallback"] },
    },
    rules: [],
  },
  registry: {
    // Known models are inventory; availableModels are selectable right now.
    knownModels: models,
    availableModels: models,
  },
});

// Classify and resolve from your prompt plus any reliability/economic
// state you own. External classification stays opt-in and is omitted here.
const formatting = await router.resolve({ prompt: "Format this function" });
report("formatting request", formatting);

const hardTask = await router.resolve({
  prompt: "Reviewer checklist: concurrency and security analysis",
  forcedTier: "deep",
});
report("forced deep task", hardTask);

// Snapshot replay: a router captures state at creation time. The registry
// can change underneath it; results stay advisory until you revalidate.
const staleRouter = createRouter({
  now: 0,
  config: {
    models: { quick: ["example/fast-small"] },
    default: "quick",
    strategy: "first",
    rules: [],
  },
  registry: {
    knownModels: models,
    availableModels: [models[1]],
  },
});
const stale = await staleRouter.resolve({ prompt: "hello" });
report("snapshot without availability", stale);

function report(label, result) {
  console.log(`\n${label}`);
  if (result.status === "aborted") {
    console.log("  evaluation aborted; no decision");
    return;
  }
  const decision = result.decision;
  if (decision.outcome === "selected") {
    // Advisory only. Revalidate the inventory and reliability state,
    // then your host executes the selected model.
    console.log(`  selected: ${decision.selected} (asOf ${result.asOf})`);
  } else {
    console.log(`  no decision: outcome=${decision.outcome}`);
    if (result.knownUnavailableModels.length > 0) {
      console.log(`  known but unavailable: ${result.knownUnavailableModels.join(", ")}`);
    }
  }
}
