import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectProviderRefreshEvidence,
  waitForRegistryRefresh,
} from "../registry-refresh.ts";

describe("provider-scoped registry refresh evidence", () => {
  it("projects only content-free selected-provider status from Pi refresh results", () => {
    const privateError = new Error("PRIVATE_PROVIDER_DETAIL");
    const partial = projectProviderRefreshEvidence({ aborted: false, errors: new Map([["openai", privateError]]) }, "openai", ["openai", "anthropic"], 1234);
    const complete = projectProviderRefreshEvidence({ aborted: false, errors: new Map([["anthropic", privateError]]) }, "openai", ["openai", "anthropic"], 1235);
    const unknown = projectProviderRefreshEvidence({ aborted: false, errors: new Map() }, "missing", ["openai"], 1236);
    const aborted = projectProviderRefreshEvidence({ aborted: true, errors: new Map() }, "openai", ["openai"], 1237);

    assert.deepEqual(partial, { status: "partial", refreshedAt: 1234 });
    assert.deepEqual(complete, { status: "complete", refreshedAt: 1235 });
    assert.deepEqual(unknown, { status: "stale", refreshedAt: 1236 });
    assert.deepEqual(aborted, { status: "stale", refreshedAt: 1237 });
    assert.doesNotMatch(JSON.stringify([partial, complete, unknown, aborted]), /PRIVATE_PROVIDER_DETAIL/u);
    assert.equal(Object.hasOwn(partial, "providerError"), false);
  });

  it("marks malformed or invalid observation times stale", () => {
    const result = { aborted: false, errors: new Map<string, Error>() };
    assert.equal(projectProviderRefreshEvidence(result, "openai", ["openai"], Number.NaN).status, "stale");
    assert.equal(projectProviderRefreshEvidence(result, "openai", ["openai"], 8_640_000_000_000_001).status, "stale");
    assert.equal(projectProviderRefreshEvidence({ aborted: false, errors: undefined } as never, "openai", ["openai"], 1).status, "stale");
  });

  it("does not launch refresh or observe a result when cancellation wins before launch", async () => {
    const controller = new AbortController();
    let called = false;
    let observed = false;
    const pending = waitForRegistryRefresh(
      async () => { called = true; return { aborted: false, errors: new Map() }; },
      controller.signal,
      () => { observed = true; },
    );
    controller.abort();
    assert.equal(await pending, "aborted");
    assert.equal(called, false);
    assert.equal(observed, false);
  });

  it("does not call the observer for a result that arrives after caller abort", async () => {
    const controller = new AbortController();
    let resolveRefresh: (value: { aborted: boolean; errors: Map<string, Error> }) => void = () => {};
    const pendingRefresh = new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => { resolveRefresh = resolve; });
    let observed = false;
    const waiting = waitForRegistryRefresh(() => pendingRefresh, controller.signal, () => { observed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal(await waiting, "aborted");
    resolveRefresh({ aborted: false, errors: new Map() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observed, false);
  });

  it("passes the exact completed result to the observer and preserves compatibility outcome", async () => {
    const result = { aborted: false, errors: new Map<string, Error>() };
    let observed: typeof result | undefined;
    const outcome = await waitForRegistryRefresh(async () => result, undefined, (value) => { observed = value; });
    assert.equal(outcome, "completed");
    assert.equal(observed, result);
  });
});
