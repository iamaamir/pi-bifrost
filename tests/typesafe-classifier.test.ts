import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupDebug } from "../debug.ts";
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

  it("aborts and cancels a stalled response body at deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    let cancelled = false;
    const outcomes: string[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const classifier = createTypeSafeClassifier({
      apiKey: "key",
      timeoutMs: 100,
      maxAttempts: 1,
      observe: ({ outcome }) => outcomes.push(outcome),
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(body, { status: 200 });
      },
    });
    assert.equal(await classifier({ prompt: "x", tiers: ["general"], criteria: { general: "normal" } }), undefined);
    assert.equal(requestSignal?.aborted, true);
    assert.equal(cancelled, true);
    assert.deepEqual(outcomes, ["timeout"]);
  });

  it("abandons a half-open trial when caller aborts", async () => {
    const key = `classifier/typesafe/${TYPESAFE_MODEL}`;
    const now = Date.now();
    const reliability = new ReliabilityStore({
      cwd: "/tmp",
      config: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 1 },
      initialState: { version: 1, models: { [key]: { failures: [now - 120_000], openUntil: now - 1 } } },
      io: { load: emptyReliabilityState, save: () => {} },
    });
    const caller = new AbortController();
    const body = new ReadableStream<Uint8Array>();
    const classifier = createTypeSafeClassifier({
      apiKey: "key",
      timeoutMs: 500,
      reliability,
      fetchImpl: async () => {
        setTimeout(() => caller.abort(), 10);
        return new Response(body, { status: 200 });
      },
    });
    assert.equal(await classifier({ prompt: "x", tiers: ["general"], criteria: { general: "normal" } }, caller.signal), undefined);
    assert.equal(reliability.getCircuitState(key, Date.now()).trialActive, false);
    assert.equal(reliability.getCircuitState(key, Date.now()).halfOpen, true);
    assert.equal(reliability.getState().models[key]?.lastSuccessAt, undefined);
  });

  it("persists only redacted TypeSafe debug metadata", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-typesafe-debug-"));
    const path = join(cwd, "trace.jsonl");
    try {
      setupDebug({ enabled: true, path }, cwd);
      const classifier = createTypeSafeClassifier({
        apiKey: "api-key-sentinel",
        debug: true,
        maxAttempts: 1,
        fetchImpl: async () => { throw new Error("transport-error-sentinel"); },
      });
      await classifier({ prompt: "prompt-sentinel", tiers: ["general"], criteria: { general: "criteria-sentinel" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const trace = readFileSync(path, "utf8");
      assert.doesNotMatch(trace, /prompt-sentinel|criteria-sentinel|api-key-sentinel|transport-error-sentinel/);
      assert.match(trace, /"event":"transport_error"/);
      assert.match(trace, /"category":"network"/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
