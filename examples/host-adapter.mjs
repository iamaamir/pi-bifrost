// ── Host adapter consumer ──────────────────────────────────────
// A host translates ITS OWN model inventory into Bifrost's public DTOs,
// resolves an advisory route, revalidates it, and executes it itself.
// Bifrost never dispatches, selects models in the host, or keeps state.
//
// Run standalone: `node examples/host-adapter.mjs` after `npm install`.
// The fake host here shows the full integration shape without needing
// any real agent SDK.

import { createRouter } from "pi-bifrost/router";

// Host-owned state: inventory, credentials, dispatch lifecycle.
const fakeHost = {
  // Anything the host considers runnable right now. The host is the only
  // source of truth — Bifrost never discovers or probes models.
  models: [
    {
      provider: "host-provider",
      id: "host-small",
      cost: { input: 0.2, output: 0.4 },
      contextWindow: 64_000,
      hostSideData: { endpoint: "https://host.example/v1" },
    },
    {
      provider: "host-provider",
      id: "host-large",
      cost: { input: 3, output: 12 },
      contextWindow: 200_000,
      hostSideData: { endpoint: "https://host.example/v1" },
    },
  ],
  // Reliable hosts may expose their own failure bookkeeping; for this
  // example the state is empty and reliability filtering is skipped.
  // Retry and dispatch budgets always stay host-owned.
  reliabilityState: undefined,
};

// Translation boundary: host model objects → Bifrost RouterModel DTOs.
// Strip host fields; Bifrost rejects unexpected shapes rather than
// guessing through them.
function toRouterModel(hostModel) {
  return {
    provider: hostModel.provider,
    id: hostModel.id,
    cost: { input: hostModel.cost.input, output: hostModel.cost.output },
    contextWindow: hostModel.contextWindow,
  };
}

function buildSnapshot(host) {
  const models = host.models.map(toRouterModel);
  return {
    now: hostNow(host),
    config: {
      models: {
        quick: ["host-provider/host-small"],
        deep: ["host-provider/host-large"],
      },
      default: "quick",
      strategy: "cheapest",
      rules: [],
      reliability:
        host.reliabilityState === undefined
          ? { enabled: false }
          : { enabled: true },
    },
    registry: {
      knownModels: models,
      availableModels: models,
    },
    ...(host.reliabilityState ? { reliabilityState: host.reliabilityState } : {}),
  };
}

// One router per resolved batch; refresh by rebuilding the snapshot.
function buildRouter(host) {
  return createRouter(buildSnapshot(host), {
    random: () => 0, // deterministic for this example; omit for default behavior
  });
}

// Typical subagent flow: resolve → inspect → revalidate → execute.
export async function pickModelForTask(router, prompt, signal) {
  const result = await router.resolve({ prompt, signal });
  if (result.status === "aborted") {
    return { status: "aborted" };
  }
  const decision = result.decision;
  if (decision.outcome !== "selected") {
    return { status: "no-route", outcome: decision.outcome };
  }

  // The decision is advisory and pinned to the snapshot time (result.asOf).
  // Revalidate against the host before dispatch; the example host does not
  // change between resolve and dispatch, but a real host must.
  const provider = decision.selected?.split("/")[0];
  const id = decision.selected?.split("/").slice(1).join("/");
  const live = fakeHost.models.find((m) => m.provider === provider && m.id === id);
  if (!live) {
    return { status: "no-route", outcome: "revalidation_failed" };
  }
  return { status: "selected", model: live, asOf: result.asOf };
}

// Simulated dispatch: the host — not Bifrost — owns credentials, request
// building, retries, and lifecycle.
async function fakeDispatch(model, prompt) {
  return { ok: true, model: `${model.provider}/${model.id}`, prompt: prompt.length };
}

const router = buildRouter(fakeHost);
const picked = await pickModelForTask(router, "Write a small helper module", undefined);
if (picked.status === "selected") {
  console.log(`host picked ${picked.model.provider}/${picked.model.id} (advisory asOf ${picked.asOf})`);
  const outcome = await fakeDispatch(picked.model, "Write a small helper module");
  console.log("dispatch:", outcome);
} else {
  console.log("host executes nothing without a resolved model:", picked);
}

function hostNow() {
  return Date.now();
}
