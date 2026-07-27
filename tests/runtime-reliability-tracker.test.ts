import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeReliabilityTracker } from "../runtime-reliability.ts";

const failed = (reason = "Streaming response failed") => ({
  role: "assistant",
  provider: "openai",
  model: "gpt-5.4",
  stopReason: "error",
  errorMessage: reason,
});
const succeeded = { role: "assistant", provider: "openai", model: "gpt-5.4", stopReason: "stop" };

describe("runtime reliability tracker", () => {
  it("reports final stream failure for selected model only after settlement", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([failed()]);
    assert.deepEqual(tracker.settle(), { model: "openai/gpt-5.4", reason: "Streaming response failed" });
  });

  it("does not report failure when Pi retry succeeds", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([failed()]);
    tracker.observe([succeeded]);
    assert.deepEqual(tracker.settle(), { model: "openai/gpt-5.4", reason: undefined });
  });

  it("ignores failures from models Bifrost did not select", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([{ ...failed(), model: "gpt-4.1-mini" }]);
    assert.deepEqual(tracker.settle(), { model: "openai/gpt-5.4", reason: undefined });
  });
});
