import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForRegistryRefresh } from "../registry-refresh.ts";

describe("registry refresh wait", () => {
  it("does not start refresh after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    assert.equal(await waitForRegistryRefresh(async () => { called = true; }, controller.signal), "aborted");
    assert.equal(called, false);
  });

  it("returns promptly when cancelled and handles late rejection", async () => {
    const controller = new AbortController();
    let rejectRefresh: (error: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });
    const waiting = waitForRegistryRefresh(() => pending, controller.signal);
    controller.abort();
    assert.equal(await waiting, "aborted");
    rejectRefresh(new Error("late failure"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("propagates refresh failure before cancellation", async () => {
    await assert.rejects(waitForRegistryRefresh(async () => { throw new Error("refresh failed"); }), /refresh failed/);
  });
});
