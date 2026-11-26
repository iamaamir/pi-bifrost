// Research fixture only. Composes the real owner modules with Pi's public
// virtual model API. Does not load index.ts or authorize production failover.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { resolveConfiguredTier } from "../../routing.ts";
import { createRuntimeAffinityStore } from "../../runtime-affinity.ts";
import { AutoDispatchReceiptBook, reliabilityV2Config } from "../../runtime-reliability-v2.ts";
import { ReliabilityV2Store } from "../../reliability-v2-store.ts";
import { emptyReliabilityV2State, modelScopeKey } from "../../reliability-v2.ts";
import { projectReliabilityV2ForRouting } from "../../reliability-v2-routing.ts";
import { ReliabilityStore } from "../../reliability-store.ts";
import { createDispatchOwnership, RuntimeReliabilityTracker } from "../../runtime-reliability.ts";

const key = model => `${model.provider}/${model.id}`;
function userBoundary(ctx) {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
  assert.ok(entry, "fixture requires a persisted user boundary");
  return entry;
}

function createOwners(work, version, alternate) {
  const config = { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 1 };
  const now = Date.now();
  const expired = { failures: [now - 60_000], openUntil: now - 1_000 };
  if (version === 1) {
    const store = new ReliabilityStore({ cwd: work, config, initialState: { version: 1, models: { [alternate]: { ...expired, trialActive: false } } } });
    const tracker = new RuntimeReliabilityTracker();
    return {
      snapshot: () => store.getState(),
      persisted: () => store.getState(),
      async admit(_ctx, _entry, modelKey) {
        const ownership = createDispatchOwnership({
          claimTrial: k => store.tryClaimTrial(k), abandonTrial: k => store.abandonTrial(k),
          begin: k => tracker.begin(k), release: k => tracker.release(k),
        });
        const trial = ownership.claim(modelKey, "select");
        assert.equal(trial.allowed, true);
        return { dispatchId: randomUUID(), modelKey, trial: trial.claimed };
      },
      observe(message) { tracker.observe([message]); },
      async settle(_ctx, receipt, outcome) {
        const results = tracker.settle();
        assert.deepEqual(results.map(r => [r.model, r.outcome]), [[receipt.modelKey, outcome]]);
        if (outcome === "failure") assert.equal(store.recordFailure(receipt.modelKey, "agent_settled", "fixture failure"), true);
        else store.recordSettled(receipt.modelKey);
        return { confirmed: true, trial: receipt.trial };
      },
    };
  }
  const v2Config = reliabilityV2Config(config);
  const path = join(work, ".pi", "receipt-experiment-v2.json");
  const initial = emptyReliabilityV2State();
  initial.scopes[modelScopeKey(alternate)] = { generation: 1, ...expired };
  writeFileSync(path, JSON.stringify(initial));
  const store = new ReliabilityV2Store({ path, config: v2Config, requireInitialized: true });
  const book = new AutoDispatchReceiptBook();
  return {
    snapshot: () => projectReliabilityV2ForRouting(store.readSnapshot(), v2Config, Date.now()),
    persisted: () => store.readSnapshot(),
    async admit(ctx, entry, modelKey, intent) {
      const session = ctx.sessionManager;
      assert.equal(book.find(session, entry.id, entry.message), undefined, "old owner removed before new admission");
      const admittedAt = Date.now();
      const receipt = book.create({ session, sessionId: session.getHeader().id, userEntryId: entry.id,
        userMessage: entry.message, configGeneration: 0, modelKey, requestedTier: intent.requestedTier,
        tier: intent.requestedTier, explicitTier: false, observationsEnabled: false, affinityEligible: intent.affinityEligible,
        retryEligible: true, admittedAt, proofUntil: admittedAt + 60_000, leases: [], store });
      const admission = await store.admit({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId,
        outcomeId: receipt.outcomeId, modelKeys: [modelKey] });
      assert.equal(admission.status, "admitted");
      receipt.leases = admission.leases ?? [];
      assert.equal(book.find(session, entry.id, entry.message), receipt);
      return receipt;
    },
    observe() {},
    async settle(ctx, receipt, outcome) {
      const session = ctx.sessionManager;
      const entry = userBoundary(ctx);
      assert.equal(book.find(session, entry.id, entry.message), receipt, "settle exact live receipt");
      const result = await store.settle({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId,
        outcomeId: receipt.outcomeId, leaseReferences: receipt.leases, settlement: { kind: outcome } });
      assert.equal(result.status, "settled");
      const persisted = store.readSnapshot().dispatches[receipt.dispatchId];
      assert.equal(persisted.settledKind, outcome);
      assert.equal(persisted.scopes[0].modelKey, receipt.modelKey);
      book.remove(session, receipt);
      assert.equal(book.find(session, entry.id, entry.message), undefined);
      return { confirmed: true, trial: receipt.leases.length > 0, leaseId: persisted.scopes[0].leaseId,
        outcomeId: receipt.outcomeId };
    },
  };
}

export function installReceiptExperiment(pi, { work, version, first, alternate, mode, tracePath }) {
  const firstKey = `fake/${first}`, alternateKey = `fake/${alternate}`;
  const owners = createOwners(work, version, alternateKey);
  const affinity = createRuntimeAffinityStore();
  const config = { schemaVersion: 2, default: "quick", strategy: "random",
    models: { quick: [firstKey, alternateKey] }, affinity: { mode } };
  const trace = { routes: [], settled: [], promotions: [], toolCalls: [] };
  let turn = 0;
  let active;

  function choose(ctx, origin, exclude) {
    const branch = ctx.sessionManager.getBranch();
    const anchor = affinity.read(ctx.sessionManager, branch);
    const now = Date.now();
    // Test-only candidate projection: exclude before the real resolver's affinity
    // stage. Production must carry explicit failure exclusion through its resolver.
    const registry = ctx.modelRegistry;
    const eligible = model => model && !exclude.has(key(model));
    const resolution = resolveConfiguredTier({ modelRegistry: {
      getAvailable: () => registry.getAvailable().filter(eligible),
      find: (provider, id) => {
        const model = registry.find(provider, id);
        return eligible(model) ? model : undefined;
      },
    } }, "quick", config, owners.snapshot(), { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 1 },
    now, undefined, () => turn === 2 ? 0.95 : 0.05,
    { intrinsicOrigin: origin, ...(anchor ? { anchor: { modelKey: anchor.modelKey,
      provider: anchor.provider, lastSuccessfulDispatchAt: anchor.observedAt } } : {}) }).resolution;
    assert.ok(resolution.selected, "fixture has a configured eligible alternative");
    return { model: resolution.selected, observation: resolution.affinityObservation, anchor: anchor?.modelKey };
  }

  async function settle(ctx, outcome) {
    const receipt = active.receipt;
    const settled = await owners.settle(ctx, receipt, outcome);
    trace.settled.push({ turn, model: receipt.modelKey, dispatchId: receipt.dispatchId, outcome, ...settled });
    if (outcome === "success" && active.intent.affinityEligible && mode !== "off") {
      const promoted = affinity.promote(ctx.sessionManager, { outcome, modelKey: receipt.modelKey,
        branchEntryId: active.assistantEntryId, dispatchId: receipt.dispatchId,
        dispatchUnambiguous: true, physicalDispatch: true, observedAt: Date.now() }, ctx.sessionManager.getBranch());
      assert.equal(promoted, true, "promote confirmed physical success only");
      trace.promotions.push({ turn, model: receipt.modelKey, dispatchId: receipt.dispatchId });
    }
    active.receipt = undefined;
  }

  pi.registerTool({ name: "acceptance_counter", label: "Acceptance Counter", description: "Synthetic test side effect.",
    parameters: Type.Object({ marker: Type.String() }),
    execute: async (_id, params) => {
      trace.toolCalls.push(params.marker);
      return { content: [{ type: "text", text: "synthetic counter recorded" }], details: {} };
    },
  });
  pi.registerVirtualModel({ provider: "experiment", id: "receipt-auto", name: "Receipt transition experiment", thinkingLevels: ["off"],
    async route(request, ctx) {
      const entry = userBoundary(ctx);
      let selection;
      if (request.reason === "user") {
        assert.equal(active, undefined, "previous user boundary settled");
        turn++;
        active = { entryId: entry.id, message: entry.message, attempted: new Set(),
          intent: { requestedTier: "quick", affinityEligible: true } };
        selection = choose(ctx, "automatic", active.attempted);
      } else {
        assert.ok(active && active.entryId === entry.id && active.message === entry.message, "same original persisted user boundary");
        if (request.reason === "retry") {
          assert.equal(key(request.failed.model), active.receipt.modelKey);
          assert.equal(active.outcome, "failure");
          assert.equal(request.failed.message.content.length, 0);
          await settle(ctx, "failure");
          selection = choose(ctx, "retry", active.attempted);
        } else {
          assert.equal(request.reason, "continuation");
          assert.equal(active.receipt.modelKey, key(request.previous.model), "normal continuation retains alternate receipt");
          trace.routes.push({ turn, reason: request.reason, model: active.receipt.modelKey,
            dispatchId: active.receipt.dispatchId, entryId: entry.id, toolsInProjection: request.messages.filter(m => m.role === "toolResult").length });
          return { model: request.previous.model, thinkingLevel: "off" };
        }
      }
      const modelKey = key(selection.model);
      assert.equal(active.attempted.has(modelKey), false);
      active.attempted.add(modelKey);
      active.receipt = await owners.admit(ctx, entry, modelKey, active.intent);
      active.outcome = undefined;
      trace.routes.push({ turn, reason: request.reason, model: modelKey, dispatchId: active.receipt.dispatchId,
        entryId: entry.id, anchor: selection.anchor, strategy: selection.observation?.strategyWinner,
        affinitySelection: selection.observation?.selection });
      return { model: selection.model, thinkingLevel: "off" };
    },
  });
  pi.on("turn_end", (event) => {
    assert.ok(active?.receipt);
    assert.equal(`${event.message.provider}/${event.message.model}`, active.receipt.modelKey);
    owners.observe(event.message);
    if (event.message.stopReason === "error") active.outcome = "failure";
    else if (event.message.stopReason === "stop" || event.message.stopReason === "length") {
      active.outcome = "success";
      active.assistantEntryId = event.messageEntryId;
    } else {
      assert.equal(event.message.stopReason, "toolUse");
      active.outcome = undefined;
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    assert.ok(active?.receipt);
    assert.ok(active.outcome === "success" || active.outcome === "failure");
    await settle(ctx, active.outcome);
    active = undefined;
  });
  pi.on("session_shutdown", () => writeFileSync(tracePath, JSON.stringify({ ...trace, state: owners.persisted(), projection: owners.snapshot() })));
}
