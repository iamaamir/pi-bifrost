import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLASSIFIER_BACKEND_IDS, isClassifierBackend, type ClassifierRequest, type ClassifierTransport, type TierCriterion } from "../classifier-backends.ts";
import type { TypeSafeInput } from "../typesafe-classifier.ts";

describe("classifier port types", () => {
  it("keeps TypeSafeInput interchangeable with ClassifierRequest", () => {
    const criterion: TierCriterion = { what: "bounded edits", notFor: "design", examples: ["formatting"] };
    const request: ClassifierRequest = { prompt: "p", tiers: ["quick"], criteria: { quick: criterion } };
    const alias: TypeSafeInput = request;
    const roundTrip: ClassifierRequest = alias;
    assert.equal(roundTrip.prompt, "p");
    assert.equal(roundTrip.criteria.quick, criterion);
  });

  it("accepts every declared backend id and rejects garbage", () => {
    assert.deepEqual(Object.values(CLASSIFIER_BACKEND_IDS), ["prompt", "typesafe", "pi-native"]);
    assert.equal(isClassifierBackend(CLASSIFIER_BACKEND_IDS.piNative), true);
    assert.equal(isClassifierBackend("bogus"), false);
    assert.equal(isClassifierBackend(undefined), false);
  });

  it("accepts a string criterion and a transport-shaped function", async () => {
    const request: ClassifierRequest = { prompt: "p", tiers: ["quick", "general"], criteria: { quick: "string form" } };
    const transport: ClassifierTransport = async (input) =>
      input.tiers.length > 0 ? { tier: input.tiers[0], backend: "prompt" } : undefined;
    const judgment = await transport(request);
    assert.equal(judgment?.tier, "quick");
  });
});
