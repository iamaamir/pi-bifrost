// Research-only adapter for native retry stop/fault controls. The owner
// primitives are production modules; the wiring and interventions are not.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { resolveConfiguredTier } from "../../routing.ts";
import { AutoDispatchReceiptBook, reliabilityV2Config } from "../../runtime-reliability-v2.ts";
import { ReliabilityV2Store } from "../../reliability-v2-store.ts";
import { emptyReliabilityV2State, modelScopeKey } from "../../reliability-v2.ts";
import { projectReliabilityV2ForRouting } from "../../reliability-v2-routing.ts";
import { createRuntimeAffinityStore } from "../../runtime-affinity.ts";
import { writeJsonFile } from "../../storage.ts";

const key = model => `${model.provider}/${model.id}`;
const identity = receipt => ({ ownerToken: receipt.ownerToken, dispatchId: receipt.dispatchId, outcomeId: receipt.outcomeId });

function awaitAbort(signal, barrier) {
  assert.ok(signal, "Pi supplied a native cancellation signal");
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", finish); reject(new Error("native abort signal not delivered")); }, 15_000);
    signal.addEventListener("abort", finish, { once: true });
    writeFileSync(barrier, "alternate admitted");
    if (signal.aborted) finish();
  });
}

export function installReceiptControls(pi, { work, scenario, first, alternate, tracePath, barrier }) {
  const a = `fake/${first}`, b = `fake/${alternate}`;
  const policy = { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 1 };
  const v2 = reliabilityV2Config(policy);
  const initial = emptyReliabilityV2State();
  initial.scopes[modelScopeKey(b)] = { generation: 1, failures: [Date.now() - 60_000], openUntil: Date.now() - 1_000 };
  const path = join(work, ".pi", "receipt-controls-v2.json");
  writeFileSync(path, JSON.stringify(initial));
  let failWrite = false;
  const store = new ReliabilityV2Store({ path, config: v2, requireInitialized: true, io: {
    writeState(path, state) {
      if (failWrite) throw new Error("injected durable write failure");
      writeJsonFile(path, state);
    },
  } });
  const book = new AutoDispatchReceiptBook();
  const affinity = createRuntimeAffinityStore();
  const config = scenario === "strict-tier"
    ? { schemaVersion: 2, default: "general", strategy: "first", models: { quick: [a], general: [b] }, tierPolicies: { quick: { fallbackTiers: [] } } }
    : { schemaVersion: 2, default: "quick", strategy: "first", models: { quick: scenario === "no-alternate" ? [a] : [a, b] } };
  const trace = { routes: [], admissions: [], settled: [], rejections: [], toolCalls: [], promotions: [], hostSettlements: [], stop: null };
  let boundary, receipt, outcome, assistantEntryId, external, session;
  const attempted = new Set();

  function stop(reason) {
    trace.stop = reason;
    throw new Error(`fixture stopped: ${reason}`);
  }

  function resolve(ctx) {
    const registry = ctx.modelRegistry;
    const eligible = model => model && !attempted.has(key(model));
    return resolveConfiguredTier({ modelRegistry: {
      getAvailable: () => registry.getAvailable().filter(eligible),
      find: (provider, id) => {
        const model = registry.find(provider, id);
        return eligible(model) ? model : undefined;
      },
    } }, "quick", config, projectReliabilityV2ForRouting(store.readSnapshot(), v2, Date.now()), policy).resolution;
  }

  function recordSettled(current, kind, cleanup = false) {
    const durable = store.readSnapshot().dispatches[current.dispatchId];
    assert.equal(durable.settledKind, kind);
    assert.equal(durable.scopes[0].modelKey, current.modelKey);
    trace.settled.push({ model: current.modelKey, kind, dispatchId: current.dispatchId, outcomeId: current.outcomeId,
      leaseId: durable.scopes[0].leaseId, cleanup });
    book.remove(session, current);
    assert.equal(book.find(session, boundary.id, boundary.message), undefined);
    receipt = undefined;
  }

  async function settle(kind, cleanup = false) {
    const current = receipt;
    assert.ok(current);
    assert.equal(book.find(session, boundary.id, boundary.message), current);
    const result = await store.settle({ ...identity(current), settlement: { kind } });
    assert.equal(result.status, "settled");
    recordSettled(current, kind, cleanup);
    return current;
  }

  async function rejectSettlement() {
    const before = store.readSnapshot();
    if (scenario === "stale-settlement") {
      const result = await store.settle({ ...identity(receipt), ownerToken: randomUUID(), settlement: { kind: "failure" } });
      assert.equal(result.status, "stale");
      trace.rejections.push(result.status);
    } else {
      failWrite = true;
      try {
        await assert.rejects(store.settle({ ...identity(receipt), settlement: { kind: "failure" } }), error => {
          assert.equal(error.code, "state_write_failed");
          trace.rejections.push(error.code);
          return true;
        });
      } finally { failWrite = false; }
    }
    assert.deepEqual(store.readSnapshot(), before, "rejected settlement did not change durable state");
    stop("settlement-unconfirmed");
  }

  async function admit(modelKey, reason) {
    assert.equal(book.find(session, boundary.id, boundary.message), undefined, "prior owner must be removed before admission");
    const now = Date.now();
    const current = book.create({ session, sessionId: session.getHeader().id, userEntryId: boundary.id, userMessage: boundary.message,
      configGeneration: 0, modelKey, requestedTier: "quick", tier: "quick", explicitTier: scenario === "strict-tier",
      observationsEnabled: false, affinityEligible: scenario !== "strict-tier" && scenario !== "exact-model",
      retryEligible: scenario !== "exact-model", admittedAt: now, proofUntil: now + 60_000, leases: [], store });
    const result = await store.admit({ ...identity(current), modelKeys: [modelKey] });
    trace.admissions.push({ reason, model: modelKey, status: result.status, dispatchId: current.dispatchId, outcomeId: current.outcomeId });
    if (result.status !== "admitted") {
      book.remove(session, current);
      assert.equal(store.readSnapshot().dispatches[current.dispatchId], undefined, "rejected admission owns no durable dispatch");
      if (external) {
        const lease = store.readSnapshot().scopes[modelScopeKey(b)].lease;
        assert.equal(lease.leaseId, external.leases[0].leaseId, "contention cannot steal another owner's trial");
        trace.externalLeasePreserved = true;
      }
      stop("admission-rejected");
    }
    current.leases = result.leases ?? [];
    receipt = current;
    outcome = undefined;
    return current;
  }

  async function contend() {
    const ids = { ownerToken: randomUUID(), dispatchId: randomUUID(), outcomeId: randomUUID() };
    const result = await store.admit({ ...ids, modelKeys: [b] });
    assert.equal(result.status, "admitted");
    assert.equal(result.leases.length, 1);
    external = { ...ids, leases: result.leases };
    trace.externalDispatchId = ids.dispatchId;
  }

  async function transition(request, ctx) {
    assert.equal(key(request.failed.model), receipt.modelKey);
    assert.equal(request.failed.message.content.length, 0);
    assert.equal(outcome, "failure");
    if (scenario === "exact-model") {
      trace.explicitPreserved = true;
      return request.failed.model;
    }
    if (["stale-settlement", "write-failure"].includes(scenario)) await rejectSettlement();
    await settle("failure");
    // These are controlled owner-epoch interventions, not native branch/pin events.
    if (scenario === "branch-invalidated") book.advanceBranch(session);
    if (scenario === "manual-invalidated") book.advanceManual(session);
    const owner = book.forSession(session);
    if (owner.branchEpoch !== boundary.branchEpoch || owner.manualGeneration !== boundary.manualGeneration) {
      trace.epoch = { branch: owner.branchEpoch, manual: owner.manualGeneration };
      stop("authority-changed");
    }
    if (request.signal?.aborted) stop("cancelled");
    const resolved = resolve(ctx);
    if (!resolved.selected) stop("no-eligible-alternate");
    const candidate = key(resolved.selected);
    assert.equal(attempted.has(candidate), false);
    if (scenario === "admission-contention") await contend();
    await admit(candidate, "retry");
    attempted.add(candidate);
    if (scenario === "cancel-after-admission") {
      assert.equal(receipt.leases.length, 1, "abort barrier follows durable half-open admission");
      await awaitAbort(request.signal, barrier);
      trace.nativeSignalAborted = request.signal.aborted;
      const cancelled = await store.abandon({ ...identity(receipt), leaseReferences: receipt.leases });
      assert.equal(cancelled.status, "abandoned");
      recordSettled(receipt, "cancelled");
      stop("cancelled-after-admission");
    }
    return resolved.selected;
  }

  pi.registerTool({ name: "acceptance_counter", label: "Acceptance Counter", description: "Synthetic tool side effect.",
    parameters: Type.Object({ marker: Type.String() }),
    execute: async (_id, params) => {
      trace.toolCalls.push(params.marker);
      return { content: [{ type: "text", text: "synthetic counter recorded" }], details: {} };
    },
  });
  pi.registerVirtualModel({ provider: "experiment", id: "controls-auto", name: "Native failover controls", thinkingLevels: ["off"],
    async route(request, ctx) {
      session = ctx.sessionManager;
      const entry = session.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
      assert.ok(entry);
      let model;
      if (request.reason === "user") {
        assert.equal(boundary, undefined);
        const owner = book.forSession(session);
        boundary = { id: entry.id, message: entry.message, branchEpoch: owner.branchEpoch, manualGeneration: owner.manualGeneration };
        model = resolve(ctx).selected;
        assert.equal(key(model), a);
        await admit(a, "user");
        attempted.add(a);
      } else {
        assert.equal(entry.id, boundary.id);
        assert.equal(entry.message, boundary.message);
        if (request.reason === "retry") model = await transition(request, ctx);
        else {
          assert.equal(request.reason, "continuation");
          assert.equal(key(request.previous.model), receipt.modelKey);
          model = request.previous.model;
        }
      }
      trace.routes.push({ reason: request.reason, model: key(model), dispatchId: receipt.dispatchId, entryId: entry.id,
        toolsInProjection: request.messages.filter(m => m.role === "toolResult").length });
      return { model, thinkingLevel: "off" };
    },
  });
  pi.on("turn_end", event => {
    const modelKey = `${event.message.provider}/${event.message.model}`;
    // A deliberate route rejection may surface as a virtual assistant error.
    // It cannot be attributed to either physical owner.
    if (trace.stop && modelKey === "experiment/controls-auto") return;
    assert.ok(receipt);
    assert.equal(modelKey, receipt.modelKey);
    if (event.message.stopReason === "error") outcome = "failure";
    else if (["stop", "length"].includes(event.message.stopReason)) {
      outcome = "success";
      assistantEntryId = event.messageEntryId;
    } else {
      assert.equal(event.message.stopReason, "toolUse");
      outcome = undefined;
    }
  });
  pi.on("agent_settled", async (event, ctx) => {
    trace.hostSettlements.push({ aborted: event.aborted });
    if (receipt) {
      assert.ok(outcome === "success" || outcome === "failure");
      const current = await settle(outcome, trace.stop === "settlement-unconfirmed");
      if (outcome === "success" && current.affinityEligible) {
        assert.equal(affinity.promote(session, { outcome, modelKey: current.modelKey, branchEntryId: assistantEntryId,
          dispatchId: current.dispatchId, dispatchUnambiguous: true, physicalDispatch: true, observedAt: Date.now() }, ctx.sessionManager.getBranch()), true);
        trace.promotions.push(current.modelKey);
      }
    }
    if (external) {
      const result = await store.abandon({ ...identity(external), leaseReferences: external.leases });
      assert.equal(result.status, "abandoned", "only external owner cleans up its own trial");
    }
  });
  pi.on("session_shutdown", () => writeFileSync(tracePath, JSON.stringify({ ...trace, state: store.readSnapshot(),
    liveReceipts: session ? book.receipts(session).length : -1 })));
}
