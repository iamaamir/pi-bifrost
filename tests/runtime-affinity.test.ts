import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeAffinityStore, type RuntimeAffinitySuccessProof } from "../runtime-affinity.ts";

function assistantEntry(id: string, model = "gpt-5.4", options: { stopReason?: string; api?: string } = {}) {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      provider: "openai",
      model,
      api: options.api,
      stopReason: options.stopReason ?? "stop",
      content: [{ type: "text", text: "PRIVATE_RESPONSE_SENTINEL" }],
    },
  };
}

function proof(entryId: string, overrides: Partial<RuntimeAffinitySuccessProof> = {}): RuntimeAffinitySuccessProof {
  return {
    outcome: "success",
    modelKey: "openai/gpt-5.4",
    branchEntryId: entryId,
    dispatchId: `dispatch-${entryId}`,
    dispatchUnambiguous: true,
    physicalDispatch: true,
    observedAt: 100,
    ...overrides,
  };
}

describe("runtime affinity anchor store", () => {
  it("promotes only an unambiguous physical success with one matching successful branch entry", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const branch = [assistantEntry("assistant-1")];

    assert.equal(store.promote(session, proof("assistant-1"), branch), true);
    assert.deepEqual(store.read(session, branch), {
      modelKey: "openai/gpt-5.4",
      provider: "openai",
      branchEntryId: "assistant-1",
      dispatchId: "dispatch-assistant-1",
      observedAt: 100,
    });
  });

  it("rejects missing, counterfeit, ambiguous, virtual, or unsuccessful success proof", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const branch = [assistantEntry("assistant-1")];
    const invalidProofs = [
      proof("assistant-1", { dispatchUnambiguous: false as true }),
      proof("assistant-1", { physicalDispatch: false as true }),
      proof("assistant-1", { outcome: "failure" as "success" }),
      proof("assistant-1", { modelKey: "anthropic/sonnet" }),
      proof("missing-entry"),
      proof("assistant-1", { observedAt: Number.NaN }),
    ];
    for (const item of invalidProofs) assert.equal(store.promote(session, item, branch), false);
    assert.equal(store.promote(session, proof("assistant-1"), [assistantEntry("assistant-1", "gpt-5.4", { api: "pi-virtual" })]), false);
    for (const stopReason of ["pending", "aborted", "error", "deferred", "unknown"]) {
      assert.equal(store.promote(session, proof("assistant-1"), [assistantEntry("assistant-1", "gpt-5.4", { stopReason })]), false);
    }
    assert.equal(store.read(session, branch), undefined);
  });

  it("requires exactly one branch entry ID and rejects non-message entries", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const entry = assistantEntry("same-id");
    assert.equal(store.promote(session, proof("same-id"), [entry, { ...entry }]), false);
    assert.equal(store.promote(session, proof("same-id"), [{ type: "custom", id: "same-id" }]), false);
    assert.equal(store.promote(session, proof("same-id"), [entry, { type: "custom", id: "same-id" }]), false);
  });

  it("rejects provider IDs containing a slash", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const entry = {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        provider: "other/foo",
        model: "id",
        stopReason: "stop",
      },
    };
    assert.equal(store.promote(session, proof("assistant-1", { modelKey: "other/foo/id" }), [entry]), false);
    assert.equal(store.promote(session, proof("assistant-1", { modelKey: "other/id" }), [entry]), false);
  });

  it("does not replace a newer anchor with duplicate or out-of-order settlement", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const first = assistantEntry("assistant-1");
    const second = assistantEntry("assistant-2", "gpt-5.4-mini");
    assert.equal(store.promote(session, proof("assistant-1"), [first]), true);
    assert.equal(store.promote(session, proof("assistant-1", { dispatchId: "new-dispatch", observedAt: 300 }), [first]), false);
    assert.equal(store.promote(session, proof("assistant-2", { modelKey: "openai/gpt-5.4-mini", observedAt: 99 }), [first, second]), false);
    assert.equal(store.promote(session, proof("assistant-2", { modelKey: "openai/gpt-5.4-mini", observedAt: 200 }), [first, second]), true);
    assert.equal(store.read(session, [first, second])?.branchEntryId, "assistant-2");
  });

  it("requires the newer success entry to follow the existing anchor on the branch", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const oldEntry = assistantEntry("assistant-old");
    const newerEntry = assistantEntry("assistant-new", "gpt-5.4-mini");
    assert.equal(store.promote(session, proof("assistant-old"), [oldEntry]), true);
    assert.equal(store.promote(session, proof("assistant-new", { modelKey: "openai/gpt-5.4-mini", observedAt: 200 }), [newerEntry, oldEntry]), false);
  });

  it("accepts a later branch success with the same timestamp", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const first = assistantEntry("assistant-1");
    const second = assistantEntry("assistant-2", "gpt-5.4-mini");
    assert.equal(store.promote(session, proof("assistant-1", { observedAt: 100 }), [first]), true);
    assert.equal(store.promote(session, proof("assistant-2", {
      modelKey: "openai/gpt-5.4-mini",
      observedAt: 100,
    }), [first, second]), true);
    assert.equal(store.read(session, [first, second])?.branchEntryId, "assistant-2");
  });

  it("keeps anchors session-local and supports adapter-owned reset", () => {
    const store = createRuntimeAffinityStore();
    const firstSession = {};
    const secondSession = {};
    const branch = [assistantEntry("assistant-1")];
    assert.equal(store.promote(firstSession, proof("assistant-1"), branch), true);
    assert.equal(store.read(secondSession, branch), undefined);
    store.reset(firstSession);
    assert.equal(store.read(firstSession, branch), undefined);
  });

  it("reads without mutating when the branch changes, then can read the anchor again", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    const branch = [assistantEntry("assistant-1")];
    assert.equal(store.promote(session, proof("assistant-1"), branch), true);
    assert.equal(store.read(session, [assistantEntry("other-branch")]), undefined);
    assert.equal(store.read(session, branch)?.branchEntryId, "assistant-1");
  });

  it("projects safe metadata only and ignores payload fields and accessors", () => {
    const store = createRuntimeAffinityStore();
    const session = {};
    let getterRead = false;
    const message = {
      role: "assistant",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
    };
    Object.defineProperty(message, "content", {
      get() {
        getterRead = true;
        throw new Error("PRIVATE_GETTER_SENTINEL");
      },
    });
    const entry = { type: "message", id: "assistant-1", message };
    assert.equal(store.promote(session, proof("assistant-1"), [entry]), true);
    const anchor = store.read(session, [entry]);
    assert.equal(getterRead, false);
    assert.equal(JSON.stringify(anchor).includes("PRIVATE"), false);
    assert.deepEqual(Object.keys(anchor ?? {}).sort(), ["branchEntryId", "dispatchId", "modelKey", "observedAt", "provider"]);
  });
});
