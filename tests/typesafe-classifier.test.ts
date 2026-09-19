import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TYPESAFE_MODEL,
  TYPESAFE_SYSTEMONE_URL,
  createTypeSafeClassifier,
  decodeTypeSafeJudgment,
} from "../typesafe-classifier.ts";
import { ReliabilityStore } from "../reliability-store.ts";
import { emptyReliabilityState } from "../reliability.ts";

const criteria = {
  quick: "bounded work",
  general: "normal work",
  frontier: "complex work",
};

function payload(choice = "general", confidence = 0.9) {
  return {
    model: TYPESAFE_MODEL,
    answers: { tier: {
      type: "choice",
      choice,
      confidence,
      probabilities: { quick: choice === "quick" ? confidence : (1 - confidence) / 2, general: choice === "general" ? confidence : (1 - confidence) / 2, frontier: choice === "frontier" ? confidence : (1 - confidence) / 2 },
    } },
  };
}

describe("TypeSafe classifier", () => {
  it("posts pinned Jev request only to official endpoint", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const classifier = createTypeSafeClassifier({
      apiKey: "secret-key",
      fetchImpl: async (url, init) => {
        request = { url: String(url), init: init! };
        return new Response(JSON.stringify(payload()), { status: 200 });
      },
    });
    const result = await classifier({ prompt: "hello", tiers: ["quick", "general", "frontier"], criteria });
    assert.equal(result?.tier, "general");
    assert.equal(request?.url, TYPESAFE_SYSTEMONE_URL);
    assert.equal((request?.init.headers as Record<string, string>).authorization, "Bearer secret-key");
    assert.equal(JSON.parse(String(request?.init.body)).model, TYPESAFE_MODEL);
  });

  it("emits one content-free operational observation", async () => {
    const observations: unknown[] = [];
    const classifier = createTypeSafeClassifier({
      apiKey: "key",
      fetchImpl: async () => new Response(JSON.stringify(payload("frontier", 0.92)), { status: 200 }),
      observe: (observation) => observations.push(observation),
    });
    await classifier({ prompt: "sensitive prompt", tiers: ["quick", "general", "frontier"], criteria });
    assert.equal(observations.length, 1);
    assert.deepEqual({ ...(observations[0] as object), latencyMs: 0 }, {
      outcome: "success", attempts: 1, tier: "frontier", confidence: 0.92, latencyMs: 0,
    });
    assert.doesNotMatch(JSON.stringify(observations), /sensitive|probabilit|authorization|api.?key/i);
  });

  it("returns miss without API key", async () => {
    let called = false;
    const classifier = createTypeSafeClassifier({ apiKey: "", fetchImpl: async () => { called = true; throw new Error("network"); } });
    assert.equal(await classifier({ prompt: "hello", tiers: ["general"], criteria: { general: "normal" } }), undefined);
    assert.equal(called, false);
  });

  it("accepts confidence at threshold and rejects lower confidence", () => {
    const accepted = decodeTypeSafeJudgment(payload("general", 0.8), ["quick", "general", "frontier"]);
    assert.equal(accepted?.tier, "general");
    assert.equal(decodeTypeSafeJudgment(payload("general", 0.79), ["quick", "general", "frontier"]), undefined);
  });

  it("treats low confidence as a valid fallback signal, not a reliability failure", async () => {
    const observations: { outcome: string }[] = [];
    const reliability = new ReliabilityStore({
      cwd: "/tmp",
      config: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 5 },
      initialState: emptyReliabilityState(),
      io: { load: emptyReliabilityState, save: () => {} },
    });
    const classifier = createTypeSafeClassifier({
      apiKey: "key",
      reliability,
      observe: (observation) => observations.push(observation),
      fetchImpl: async () => new Response(JSON.stringify(payload("general", 0.7)), { status: 200 }),
    });
    assert.equal(await classifier({ prompt: "x", tiers: ["quick", "general", "frontier"], criteria }), undefined);
    assert.equal(observations[0]?.outcome, "low_confidence");
    assert.equal(reliability.getCircuitState(`classifier/typesafe/${TYPESAFE_MODEL}`).open, false);
  });

  it("rejects malformed judgment", () => {
    assert.equal(decodeTypeSafeJudgment({ ...payload(), answers: { tier: { type: "choice", choice: "nope", confidence: 1, probabilities: {} } } }, ["quick", "general", "frontier"]), undefined);
  });

  it("fails closed for extra keys, accessors, and non-plain objects", () => {
    assert.equal(decodeTypeSafeJudgment({ ...payload(), extra: true }, ["quick", "general", "frontier"]), undefined);
    const accessor = payload() as Record<string, unknown>;
    Object.defineProperty(accessor, "model", { get: () => TYPESAFE_MODEL, enumerable: true });
    assert.equal(decodeTypeSafeJudgment(accessor, ["quick", "general", "frontier"]), undefined);
    assert.equal(decodeTypeSafeJudgment(Object.create({ ...payload() }), ["quick", "general", "frontier"]), undefined);
  });

  it("retries network and 429, but not auth", async () => {
    let calls = 0;
    const classifier = createTypeSafeClassifier({
      apiKey: "key",
      maxAttempts: 2,
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response("busy", { status: 429 }) : new Response(JSON.stringify(payload()), { status: 200 });
      },
      sleepImpl: async () => {},
    });
    assert.equal((await classifier({ prompt: "x", tiers: ["quick", "general", "frontier"], criteria }))?.tier, "general");
    assert.equal(calls, 2);

    calls = 0;
    const authClassifier = createTypeSafeClassifier({ apiKey: "key", maxAttempts: 3, fetchImpl: async () => { calls++; return new Response("no", { status: 401 }); }, sleepImpl: async () => {} });
    assert.equal(await authClassifier({ prompt: "x", tiers: ["general"], criteria: { general: "normal" } }), undefined);
    assert.equal(calls, 1);
  });
});
