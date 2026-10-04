import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClassifierContext, ClassifierModel, ClassifierApi, ClassifierResult } from "@earendil-works/pi-ai";
import { CLASSIFIER_BACKEND_IDS, type ClassifierRequest } from "../classifier-backends.ts";
import { createPiNativeClassifier, decodePiNativeJudgment, type PiClassifierRegistry } from "../classifier-pi-native.ts";
import type { TypeSafeObservation } from "../classifier-metrics.ts";

const tiers = ["quick", "general", "frontier"];
const request: ClassifierRequest = {
  prompt: "refactor this module",
  tiers,
  criteria: {
    quick: "bounded work",
    general: { what: "normal work", notFor: "trivial edits", examples: ["feature work"] },
    frontier: "complex work",
  },
};

function probabilities(choice: string): Record<string, number> {
  const base: Record<string, number> = { quick: 0.1, general: 0.1, frontier: 0.1 };
  base[choice] = 0.8;
  return base;
}

/** Fixture seam: minimal provider-shaped result. */
function answer(choice = "general", confidence = 0.8): ClassifierResult {
  return {
    api: "systemone",
    provider: "typesafe",
    model: "jev-latest",
    answers: { tier: { type: "choice", choice, confidence, probabilities: probabilities(choice) } },
    stopReason: "stop",
    timestamp: 1,
  } as unknown as ClassifierResult;
}

/** Fixture seam: minimal provider model entry. */
function model(provider = "typesafe", id = "jev-latest"): ClassifierModel<ClassifierApi> {
  return { type: "classifier", provider, id } as unknown as ClassifierModel<ClassifierApi>;
}

function harness(impl: {
  listed?: ClassifierModel<ClassifierApi>[];
  byId?: ClassifierModel<ClassifierApi>[];
  results: ClassifierResult[] | ((call: number) => ClassifierResult);
}) {
  const contexts: ClassifierContext[] = [];
  const lookups: string[] = [];
  let calls = 0;
  let listCalls = 0;
  const registry: PiClassifierRegistry = {
    getModelOfType: (_type, provider, id) => {
      lookups.push(`${provider}/${id}`);
      return impl.byId?.find((entry) => entry.provider === provider && entry.id === id);
    },
    getAvailableOfType: async () => {
      listCalls += 1;
      return impl.listed ?? [];
    },
    classify: async (_model, context) => {
      contexts.push(context);
      calls += 1;
      return typeof impl.results === "function" ? impl.results(calls) : impl.results[Math.min(calls - 1, impl.results.length - 1)];
    },
  };
  return { registry, contexts, lookups, calls: () => calls, listCalls: () => listCalls };
}

async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return errors;
}

describe("pi-native classifier transport", () => {
  it("maps a choice answer to a judgment with the resolved catalog model id", async () => {
    const h = harness({ listed: [model()], results: [answer("general", 0.8)] });
    const observations: TypeSafeObservation[] = [];
    const classify = createPiNativeClassifier({ registry: h.registry, observe: (o) => observations.push(o) });
    const judgment = await classify(request);
    assert.deepEqual(judgment, {
      tier: "general",
      confidence: 0.8,
      probabilities: probabilities("general"),
      backend: CLASSIFIER_BACKEND_IDS.piNative,
      model: "typesafe/jev-latest",
    });
    assert.equal(observations[0]?.outcome, "success");
    assert.equal(h.listCalls(), 1);
  });

  it("pre-bounds nothing and flattens criteria into one choice question", async () => {
    const h = harness({ listed: [model()], results: [answer()] });
    const classify = createPiNativeClassifier({ registry: h.registry });
    await classify(request);
    const context = h.contexts[0];
    assert.deepEqual(context.state, { prompt: request.prompt });
    const question = context.questions.tier as { type: string; instructions: string; criteria: Record<string, string> };
    assert.equal(question.type, "choice");
    assert.ok(question.instructions.includes("tier"));
    assert.equal(question.criteria.quick, "bounded work");
    assert.equal(question.criteria.general, "normal work Not for: trivial edits Examples: feature work");
  });

  it("resolves an explicit provider/id model at the first slash without listing", async () => {
    const h = harness({ byId: [model("custom", "jev-9")], results: [answer()] });
    const classify = createPiNativeClassifier({ registry: h.registry, model: "custom/jev-9" });
    const judgment = await classify(request);
    assert.deepEqual(h.lookups, ["custom/jev-9"]);
    assert.equal(h.listCalls(), 0);
    assert.equal(judgment?.model, "typesafe/jev-latest");
  });

  it("yields no judgment on stopReason error and retries up to maxAttempts", async () => {
    const error = { ...answer(), answers: {}, stopReason: "error", errorMessage: "boom" } as unknown as ClassifierResult;
    const h = harness({ listed: [model()], results: [error] });
    const classify = createPiNativeClassifier({ registry: h.registry, maxAttempts: 3, sleepImpl: async () => {} });
    const judgment = await classify(request);
    assert.equal(judgment, undefined);
    assert.equal(h.calls(), 3);
  });

  it("does not retry a non-retryable quota error", async () => {
    const error = { ...answer(), answers: {}, stopReason: "error", errorMessage: "insufficient_quota: buy more" } as unknown as ClassifierResult;
    const h = harness({ listed: [model()], results: [error] });
    const classify = createPiNativeClassifier({ registry: h.registry, maxAttempts: 3, sleepImpl: async () => {} });
    const judgment = await classify(request);
    assert.equal(judgment, undefined);
    assert.equal(h.calls(), 1);
  });

  it("does not retry an aborted result", async () => {
    const aborted = { ...answer(), stopReason: "aborted" } as unknown as ClassifierResult;
    const h = harness({ listed: [model()], results: [aborted] });
    const classify = createPiNativeClassifier({ registry: h.registry, maxAttempts: 3, sleepImpl: async () => {} });
    const judgment = await classify(request);
    assert.equal(judgment, undefined);
    assert.equal(h.calls(), 1);
  });

  it("skips classify entirely when the signal is already aborted", async () => {
    const h = harness({ listed: [model()], results: [answer()] });
    const classify = createPiNativeClassifier({ registry: h.registry });
    const controller = new AbortController();
    controller.abort();
    const judgment = await classify(request, controller.signal);
    assert.equal(judgment, undefined);
    assert.equal(h.calls(), 0);
  });

  it("drops a judgment below minConfidence and reports low_confidence", async () => {
    const h = harness({ listed: [model()], results: [answer("general", 0.5)] });
    const observations: TypeSafeObservation[] = [];
    const classify = createPiNativeClassifier({ registry: h.registry, observe: (o) => observations.push(o) });
    const judgment = await classify(request);
    assert.equal(judgment, undefined);
    assert.equal(h.calls(), 1);
    assert.equal(observations[0]?.outcome, "low_confidence");
    assert.equal(observations[0]?.confidence, 0.5);
  });

  it("branches the empty-catalog error on credential state", async () => {
    const withoutCredential = harness({ listed: [], results: [answer()] });
    const missing = createPiNativeClassifier({ registry: withoutCredential.registry, credentialMissing: () => true });
    const missingErrors = await captureErrors(async () => { await missing(request); });
    assert.ok(missingErrors.some((line) => line.includes("/login")), missingErrors.join("\n"));

    const withCredential = harness({ listed: [], results: [answer()] });
    const empty = createPiNativeClassifier({ registry: withCredential.registry, credentialMissing: () => false });
    const emptyErrors = await captureErrors(async () => { await empty(request); });
    assert.ok(emptyErrors.some((line) => line.includes("enabledModels")), emptyErrors.join("\n"));
  });
});

describe("decodePiNativeJudgment", () => {
  it("rejects probabilities that do not cover every tier", () => {
    const partial = answer();
    (partial.answers.tier as { probabilities: Record<string, number> }).probabilities = { quick: 1 };
    assert.equal(decodePiNativeJudgment(partial, tiers), undefined);
  });

  it("rejects a choice the tiers do not contain", () => {
    assert.equal(decodePiNativeJudgment(answer("bogus"), tiers), undefined);
  });

  it("rejects a non-maximal probability winner", () => {
    const rigged = answer();
    (rigged.answers.tier as { probabilities: Record<string, number> }).probabilities = { quick: 0.5, general: 0.4, frontier: 0.1 };
    assert.equal(decodePiNativeJudgment(rigged, tiers), undefined);
  });
});
