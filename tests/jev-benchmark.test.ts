import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  TYPESAFE_MODEL,
  TYPESAFE_SYSTEMONE_URL,
  baselineTier,
  buildRequest,
  calculateReport,
  parseJevResponse,
  parseJsonLines,
  runBenchmark,
  selectSplit,
  TypeSafeJevClient,
  type EvaluationRow,
  type Scenario,
} from "../scripts/jev-benchmark.ts";

const scenario = (id: string, prompt: string, goldTier: "quick" | "general" | "frontier", split: "dev" | "review" = "dev"): Scenario => ({
  id, prompt, family: "tests", goldTier, goldRationale: "fixture", ambiguity: "none", split,
});

function response(choice: "quick" | "general" | "frontier", model = TYPESAFE_MODEL): Response {
  const probabilities = { quick: 0.05, general: 0.05, frontier: 0.05 };
  probabilities[choice] = 0.9;
  return new Response(JSON.stringify({
    model,
    answers: { tier: { type: "choice", choice, probabilities, confidence: 0.85 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200 });
}

test("baseline uses ordered default rules and general fallback", () => {
  assert.deepEqual(baselineTier("format this JSON"), { tier: "quick", source: "regex_rule" });
  assert.deepEqual(baselineTier("implement pagination and add tests"), { tier: "general", source: "default" });
  assert.deepEqual(baselineTier("summarize this request"), { tier: "general", source: "default" });
});

test("request pins Jev and strict response parsing enforces the Choice distribution", () => {
  const request = buildRequest("diagnose flaky worker updates");
  assert.equal(request.model, "jev-1.13.0");
  assert.equal(TYPESAFE_MODEL, "jev-1.13.0");
  assert.deepEqual(parseJevResponse({
    model: TYPESAFE_MODEL,
    answers: { tier: { type: "choice", choice: "frontier", probabilities: { quick: 0.02, general: 0.18, frontier: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }).tier, "frontier");
  assert.throws(() => parseJevResponse({ model: "other-model", answers: { tier: { type: "choice", choice: "frontier", probabilities: { quick: 0, general: 0, frontier: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), /invalid_response/);
  assert.throws(() => parseJevResponse({ answers: { tier: { type: "choice", choice: "frontier", probabilities: { frontier: 1 }, confidence: 1 } } }), /invalid_response/);
  assert.throws(() => parseJevResponse({ answers: { tier: { type: "choice", choice: "quick", probabilities: { quick: 0.1, general: 0.8, frontier: 0.1 }, confidence: 0.5 } } }), /invalid_response/);
  assert.throws(() => parseJevResponse({ answers: { tier: { type: "choice", choice: "quick", probabilities: { quick: 0.8, general: 0.1, frontier: 0.2 }, confidence: 0.5 } } }), /invalid_response/);
});

test("client posts fixed endpoint, retries only transient failures, and never exposes key", async () => {
  const statuses = [529, 200];
  let calls = 0;
  let authorization = "";
  const client = new TypeSafeJevClient({
    apiKey: "not-for-output",
    maxAttempts: 2,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      assert.equal(url, TYPESAFE_SYSTEMONE_URL);
      authorization = (init?.headers as Record<string, string>).authorization;
      const status = statuses[calls++];
      return status === 200 ? response("quick") : new Response("", { status });
    },
  });
  assert.equal((await client.evaluate("format this")).tier, "quick");
  assert.equal(calls, 2);
  assert.equal(authorization, "Bearer not-for-output");

  let authCalls = 0;
  const authClient = new TypeSafeJevClient({ apiKey: "secret", maxAttempts: 3, sleepImpl: async () => {}, fetchImpl: async () => { authCalls++; return new Response("", { status: 401 }); } });
  await assert.rejects(authClient.evaluate("x"), /auth/);
  assert.equal(authCalls, 1);
});

test("live benchmark bounds concurrency and preserves input order", async () => {
  let active = 0;
  let maxActive = 0;
  const client = new TypeSafeJevClient({ apiKey: "test", fetchImpl: async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return response("general");
  } });
  const scenarios = [scenario("one", "first", "general"), scenario("two", "second", "general"), scenario("three", "third", "general")];
  const rows = await runBenchmark(scenarios, { mode: "live", client, concurrency: 2 });
  assert.deepEqual(rows.map((row) => row.id), ["one", "two", "three"]);
  assert.equal(maxActive, 2);
});

test("report compares baseline and Jev on same successful subset while retaining all-row baseline", () => {
  const rows: EvaluationRow[] = [
    { id: "one", split: "dev", baselineTier: "quick", baselineSource: "regex_rule", goldTier: "quick", jevTier: "quick", status: "ok" },
    { id: "two", split: "dev", baselineTier: "general", baselineSource: "default", goldTier: "frontier", status: "error", error: "timeout" },
  ];
  const report = calculateReport(rows, "1");
  assert.equal(report.strictAccuracy.scored, 1);
  assert.equal(report.baselineComparableAccuracy.scored, 1);
  assert.equal(report.baselineComparableAccuracy.rate, 1);
  assert.equal(report.baselineAllRowsAccuracy.scored, 2);
  assert.equal(report.correctedRoutingDelta, 0);
  assert.equal(report.model.requested, "jev-1.13.0");
});

test("report calculates multiclass probability calibration", () => {
  const rows: EvaluationRow[] = [
    { id: "a", split: "dev", baselineTier: "general", baselineSource: "default", goldTier: "quick", jevTier: "quick", confidence: 0.7, probabilities: { quick: 0.8, general: 0.1, frontier: 0.1 }, status: "ok" },
    { id: "b", split: "dev", baselineTier: "general", baselineSource: "default", goldTier: "quick", jevTier: "general", confidence: 0.6, probabilities: { quick: 0.2, general: 0.7, frontier: 0.1 }, status: "ok" },
  ];
  const calibration = calculateReport(rows).calibration;
  assert.equal(calibration.samples, 2);
  assert.ok(Math.abs(calibration.multiclassBrier! - 0.6) < 1e-12);
  assert.ok(Math.abs(calibration.logLoss! - 0.916290731874155) < 1e-12);
  assert.ok(Math.abs(calibration.expectedCalibrationError! - 0.45) < 1e-12);
});

test("corpus parser rejects invalid records and split selection defaults to dev", () => {
  const records = [scenario("dev", "format this JSON", "quick", "dev"), scenario("review", "diagnose a deadlock", "frontier", "review")];
  const parsed = parseJsonLines(records.map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(selectSplit(parsed, "dev").map((record) => record.id), ["dev"]);
  assert.deepEqual(selectSplit(parsed, "review").map((record) => record.id), ["review"]);
  assert.equal(selectSplit(parsed, "all").length, 2);
  assert.throws(() => parseJsonLines(`${JSON.stringify(records[0])}\n${JSON.stringify({ ...records[0], prompt: "other" })}`), /duplicate id/);
  assert.throws(() => parseJsonLines(JSON.stringify({ ...records[0], split: "locked" })), /invalid split/);
  assert.throws(() => parseJsonLines(JSON.stringify({ ...records[0], goldTier: "cheap" })), /invalid goldTier/);
});

test("checked-in corpus and manifest agree", () => {
  const scenarios = parseJsonLines(readFileSync("tests/corpus/jev/scenarios.jsonl", "utf8"));
  const manifest = JSON.parse(readFileSync("tests/corpus/jev/manifest.json", "utf8")) as { counts: { total: number; dev: number; review: number; byTier: Record<string, number> } };
  assert.equal(scenarios.length, manifest.counts.total);
  assert.equal(selectSplit(scenarios, "dev").length, manifest.counts.dev);
  assert.equal(selectSplit(scenarios, "review").length, manifest.counts.review);
  for (const tier of ["quick", "general", "frontier"] as const) assert.equal(scenarios.filter((item) => item.goldTier === tier).length, manifest.counts.byTier[tier]);
});
