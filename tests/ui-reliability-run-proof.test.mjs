import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertSingleRun, assertControl, assertPending, assertSettledState, MODELS, PROMPTS } from "./fixtures/ui-reliability-run-proof.mjs";

function evidence(runs = [3]) {
  const events = [], debug = [], messages = [{ role: "system", id: "system" }], requests = [];
  let index = 0;
  for (const [runIndex, count] of runs.entries()) {
    const run = runIndex + 1;
    const stamp = { session: "native-one", run, at: 10 };
    events.push({ type: "start", ...stamp });
    const group = MODELS.slice(index, index + count);
    for (const model of group) {
      const prompt = PROMPTS[index];
      const entryId = "a" + index;
      messages.push({ role: "user", text: prompt, id: "u" + index },
        { role: "assistant", provider: "fake", model, stopReason: "stop", id: entryId });
      events.push({ type: "turn", ...stamp, provider: "fake", model, stopReason: "stop", entryId });
      debug.push({ event: "dispatch", module: "virtual", model: "fake/" + model,
        session_correlation_id: "bifrost-one", turn_correlation_id: "turn-" + index, request_correlation_id: "request-" + index });
      if (model === "fast") debug.push({ event: "trial", model: "fake/fast", allowed: true, claimed: true });
      requests.push({ provider: "fake", model, kind: "generation", completed: true,
        userMessageDigest: createHash("sha256").update(prompt).digest("hex") });
      index++;
    }
    for (const model of group) debug.push({ event: "legacy_outcome_observed", model: "fake/" + model,
      outcome: "success", session_correlation_id: "bifrost-one" });
    events.push({ type: "settled", ...stamp, messages: structuredClone(messages) });
  }
  const record = index === 3
    ? { trialActive: false, failures: [], lastSuccessAt: 20, lastSuccessSource: "agent_settled" }
    : { trialActive: false, failures: [1], openUntil: 1 };
  return { events, debug, requests, state: { models: { "fake/fast": record } } };
}

test("accepts the complete ordered single run", () => assertSingleRun(evidence()));
test("persisted-state poll rejects observed but unwritten settlement until recovery", () => {
  const value = evidence();
  value.state.models["fake/fast"].trialActive = true;
  assert.throws(() => assertSettledState(value), /persist successful settlement/);
  value.state.models["fake/fast"].trialActive = false;
  assertSettledState(value);
  value.state.models["fake/fast"].openUntil = 1;
  assert.throws(() => assertSettledState(value), /persist successful settlement/);
});
test("rejects real-control trace shapes while accepting their witness contracts", () => {
  assertControl(evidence([2]), "missing");
  assertControl(evidence([1, 1, 1]), "separate");
  assert.throws(() => assertSingleRun(evidence([2])), /run boundaries/);
  assert.throws(() => assertSingleRun(evidence([1, 1, 1])), /run boundaries/);
});

test("rejects a held trial until it actually settles", () => {
  const value = evidence();
  value.events.splice(3);
  value.requests[2].completed = false;
  value.state.models["fake/fast"] = { trialActive: true, failures: [1], openUntil: 1 };
  const fastOutcome = value.debug.pop();
  assertPending(value);
  value.debug.push(fastOutcome);
  assert.throws(() => assertPending(value), /held trial already settled successfully/);
  assert.throws(() => assertSingleRun(value), /run boundaries/);
});

const faults = [
  ["mixed sessions", (v) => { v.events[2].session = "other"; }, /mixed native sessions/],
  ["wrong run", (v) => { v.events[4].run = 2; }, /wrong run attribution/],
  ["intermediate failure", (v) => { v.events[2].stopReason = "error"; }, /native turn outcomes/],
  ["wrong assistant identity", (v) => { v.events[2].entryId = "other"; }, /final transcript/],
  ["duplicated dispatch", (v) => { v.requests.push(v.requests[2]); }, /provider request identity/],
  ["reordered dispatch", (v) => { [v.requests[0], v.requests[1]] = [v.requests[1], v.requests[0]]; }, /provider request identity/],
  ["wrong request content", (v) => { v.requests[1].userMessageDigest = v.requests[0].userMessageDigest; }, /provider request identity/],
  ["unstripped tier override at provider", (v) => { v.requests[1].userMessageDigest = createHash("sha256").update("frontier one").digest("hex"); }, /provider request identity/],
  ["unstripped tier override in branch", (v) => { v.events.at(-1).messages[3].text = "frontier one"; }, /final branch transcript/],
  ["missing leading system message", (v) => { v.events.at(-1).messages.shift(); }, /missing leading system message/],
  ["extra leading system message", (v) => { v.events.at(-1).messages.unshift({ role: "system", id: "extra" }); }, /final branch transcript/],
  ["interleaved system message", (v) => { v.events.at(-1).messages.splice(3, 0, { role: "system", id: "extra" }); }, /final branch transcript/],
  ["duplicate system identity", (v) => { v.events.at(-1).messages[0].id = "u0"; }, /duplicate message entries/],
  ["duplicate correlation", (v) => { v.debug[1].request_correlation_id = v.debug[0].request_correlation_id; }, /duplicate dispatch request/],
  ["unrelated settlement", (v) => { v.debug.at(-1).session_correlation_id = "other"; }, /observed settlement outcomes/],
  ["premature settlement", (v) => { v.debug.splice(1, 0, v.debug.splice(4, 1)[0]); }, /settlement occurred outside/],
  ["abandoned outcome", (v) => { v.debug.at(-1).outcome = "abandoned"; }, /observed settlement outcomes/],
  ["stuck trial", (v) => { v.state.models["fake/fast"].trialActive = true; }, /persist successful settlement/],
  ["stale success", (v) => { v.state.models["fake/fast"].lastSuccessAt = 1; }, /persist successful settlement/],
  ["other wedged trial", (v) => { v.state.models["fake/other"] = { trialActive: true }; }, /another circuit/],
];
for (const [name, mutate, expected] of faults) {
  test("rejects " + name, () => {
    const value = evidence();
    mutate(value);
    assert.throws(() => assertSingleRun(value), expected);
  });
}
