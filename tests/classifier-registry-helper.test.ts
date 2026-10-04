import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { makeCtx, makeModel } from "./helpers.ts";

describe("fake registry classifier seam", () => {
  it("separates chat models from classifier catalog and exposes auth and classify", async () => {
    const classifier = {
      type: "classifier", provider: "typesafe", id: "jev-latest", api: "systemone",
    } as ClassifierModel<ClassifierApi>;
    const result = {
      api: "systemone", provider: "typesafe", model: "jev-latest", answers: {}, stopReason: "stop", timestamp: 1,
    } as ClassifierResult;
    const ctx = makeCtx([makeModel("fake", "chat")], {
      classifierModels: [classifier], authSource: "models_json_key", classify: () => result,
    });
    const registry = ctx.modelRegistry;
    assert.deepEqual(registry.getAvailable().map((m) => m.id), ["chat"]);
    assert.deepEqual(registry.getModelsOfType("classifier", "typesafe").map((m) => m.id), ["jev-latest"]);
    assert.equal(registry.getModelOfType("classifier", "typesafe", "jev-latest"), classifier);
    assert.equal(registry.findOfType("classifier", "typesafe", "jev-latest"), classifier);
    assert.deepEqual(await registry.getAvailableOfType("classifier", "typesafe"), [classifier]);
    assert.equal(registry.getProviderAuthStatus("typesafe").source, "models_json_key");
    const classified = await registry.classify(classifier, { state: {}, questions: {} });
    assert.equal(classified, result);
  });
});
