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
  it("reports a content-free final stream failure for the selected model", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([failed("private prompt text: Streaming response failed")]);
    assert.deepEqual(tracker.settle(), [{ model: "openai/gpt-5.4", outcome: "failure", reason: "provider request failed" }]);
  });

  it("uses a safe failure reason when the host error text is blank", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([{ ...failed(""), errorMessage: "  " }]);
    assert.deepEqual(tracker.settle(), [{
      model: "openai/gpt-5.4",
      outcome: "failure",
      reason: "provider request failed",
    }]);
  });

  it("does not report failure when Pi retry succeeds", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([failed()]);
    tracker.observe([succeeded]);
    assert.deepEqual(tracker.settle(), [{ model: "openai/gpt-5.4", outcome: "success" }]);
  });

  it("ignores failures from models Bifrost did not select", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([{ ...failed(), model: "gpt-4.1-mini" }]);
    assert.deepEqual(tracker.settle(), [{ model: "openai/gpt-5.4", outcome: "abandoned" }]);
  });

  it("accepts only known successful Pi stop reasons", () => {
    for (const stopReason of ["stop", "length", "toolUse"]) {
      const tracker = new RuntimeReliabilityTracker();
      tracker.begin("openai/gpt-5.4");
      tracker.observe([{ ...succeeded, stopReason }]);
      assert.deepEqual(tracker.settle(), [{ model: "openai/gpt-5.4", outcome: "success" }], stopReason);
    }
  });

  it("resets a model outcome when a later dispatch starts before settlement", () => {
    const tracker = new RuntimeReliabilityTracker();
    tracker.begin("openai/gpt-5.4");
    tracker.observe([succeeded]);
    tracker.begin("openai/gpt-5.4");
    assert.deepEqual(tracker.settle(), [{ model: "openai/gpt-5.4", outcome: "abandoned" }]);
  });

  it("abandons canceled, missing, and unknown outcomes without treating them as success", () => {
    for (const stopReason of ["aborted", "pending", "deferred", "future-value", undefined]) {
      const tracker = new RuntimeReliabilityTracker();
      tracker.begin("openai/gpt-5.4");
      if (stopReason !== undefined) tracker.observe([{ ...succeeded, stopReason }]);
      assert.deepEqual(tracker.settle(), [{ model: "openai/gpt-5.4", outcome: "abandoned" }], String(stopReason));
    }
  });
});
