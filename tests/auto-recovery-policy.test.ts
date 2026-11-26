import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoRecoveryCategory, autoRecoveryEnabled, requestBudgetRejectionHint } from "../auto-recovery-policy.ts";
import { normalizeFailureObservation } from "../failure-observations.ts";

const key = "fake/model";
const text = "Request too large for model in organization fixture-only on tokens per min (TPM): Limit 60000, Requested 74499. The input or output tokens must be reduced in order to run successfully.";

describe("qualified Auto request-budget recovery", () => {
  it("recognizes model-bound prose and Pi-formatted 429 JSON without inventing structured transport evidence", () => {
    for (const errorText of [text, "429 " + text, "429: " + JSON.stringify({ message: text, code: "rate_limit_exceeded" })]) {
      assert.equal(requestBudgetRejectionHint(errorText, key), true);
      const observation = normalizeFailureObservation({ outcomeId: "fixture", modelKey: key, source: "runtime", errorText });
      assert.equal(autoRecoveryCategory(observation, true), "request_budget_exceeded");
      assert.notEqual(observation?.categoryEvidence, "http_status");
    }
  });
  it("rejects other failures, mismatched identities, ambiguous amounts and contradictory codes", () => {
    for (const errorText of [
      "429 Too many requests", "503 " + text, "untrusted prefix " + text,
      text.replace("74499", "59999"), text.replace("74499", "60000"),
      text.replace("for model", "for other"),
      text.replace("Limit 60000", "Limit 0"),
      "429: " + JSON.stringify({ message: text, code: "insufficient_quota" }),
      "429: {not valid json",
    ]) assert.equal(requestBudgetRejectionHint(errorText, key), false, errorText);
  });
  it("requires a distinct opt-in and runtime evidence; allowance settings retain their meaning", () => {
    const observation = normalizeFailureObservation({ outcomeId: "fixture", modelKey: key, source: "runtime", errorText: text });
    assert.equal(autoRecoveryCategory(observation, false), undefined);
    assert.equal(autoRecoveryCategory(undefined, true), undefined);
    assert.equal(autoRecoveryCategory(observation && { ...observation, source: "probe" }, true), undefined);
    assert.equal(autoRecoveryCategory(observation && { ...observation, category: "authentication" }, true), undefined);
    assert.equal(autoRecoveryEnabled({ retryOnAllowanceExhausted: true }, "request_budget_exceeded"), false);
    assert.equal(autoRecoveryEnabled({ retryOnRequestBudgetExceeded: true }, "allowance_exhausted"), false);
    assert.equal(autoRecoveryEnabled({ retryOnRequestBudgetExceeded: true, enabled: false }, "request_budget_exceeded"), false);
    assert.equal(autoRecoveryEnabled({ retryOnRequestBudgetExceeded: true, cooldownOnAllowanceExhausted: false }, "request_budget_exceeded"), true);
  });
});
