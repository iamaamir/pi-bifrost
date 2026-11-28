import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeFailureObservation, providerPauseIntent } from "../failure-observations.ts";

const now = 1_000;
const modelKey = "fixture/model";
const context = {
  modelKey, source: "probe" as const, attribution: "legacy-terminal" as const,
  inferredRate: false, enabled: true, allowanceEnabled: true, allowanceScope: "provider" as const, now,
};
const allowance = normalizeFailureObservation({
  outcomeId: "probe-1", modelKey, source: "probe", errorText: "The usage limit has been reached.",
}, { now })!;
const rate = normalizeFailureObservation({
  outcomeId: "probe-2", modelKey, source: "probe", errorText: "429 Too Many Requests",
}, { now })!;

describe("provider pause authorization", () => {
  it("authorizes the existing qualified probe allowance path with provider scope", () => {
    assert.equal(providerPauseIntent(allowance, context)?.kind, "usage");
  });
  for (const override of [
    { enabled: false }, { allowanceEnabled: false }, { allowanceScope: "model" as const },
    { modelKey: "fixture/other" }, { source: "runtime" as const }, { attribution: "unconfirmed" as const },
  ]) {
    it(`rejects a probe allowance without applicable action authority (${JSON.stringify(override)})`, () => {
      assert.equal(providerPauseIntent(allowance, { ...context, ...override }), undefined);
    });
  }
  it("requires the explicitly qualified legacy rate path independently of allowance scope", () => {
    assert.equal(providerPauseIntent(rate, context), undefined);
    assert.equal(providerPauseIntent(rate, { ...context, inferredRate: true, allowanceScope: "model", allowanceEnabled: false })?.kind, "rate");
  });
  it("does not grant a runtime provider action to an unbound diagnostic", () => {
    const diagnostic = normalizeFailureObservation({
      outcomeId: "diagnostic", modelKey, source: "runtime", structured: { category: "allowance_exhausted" },
    }, { now })!;
    assert.equal(providerPauseIntent(diagnostic, { ...context, source: "runtime", attribution: "unconfirmed" }), undefined);
    assert.equal(providerPauseIntent(diagnostic, { ...context, source: "runtime" }), undefined);
  });
});
