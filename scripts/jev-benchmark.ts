import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RULES } from "../config.ts";
import { classifyCompiled, compileRules } from "../routing.ts";
import { resolveTypeSafeApiKey } from "../typesafe-classifier.ts";

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-1.13.0";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const TIERS = ["quick", "general", "frontier"] as const;
export type Tier = (typeof TIERS)[number];
export type CorpusSplit = "dev" | "review";
export type SelectedSplit = CorpusSplit | "all";

export interface Scenario {
  readonly id: string;
  readonly prompt: string;
  readonly family: string;
  readonly goldTier: Tier;
  readonly goldRationale: string;
  readonly ambiguity: string;
  readonly split: CorpusSplit;
  readonly expectedAlternative?: readonly Tier[];
  readonly tags?: readonly string[];
  readonly unresolved?: boolean;
}

export interface JevJudgment {
  readonly tier: Tier;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Tier, number>>;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface EvaluationRow {
  readonly id: string;
  readonly split: CorpusSplit;
  readonly baselineTier: string;
  readonly baselineSource: "regex_rule" | "default";
  readonly goldTier?: Tier;
  readonly family?: string;
  readonly unresolved?: boolean;
  readonly jevTier?: Tier;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<Tier, number>>;
  readonly model?: string;
  readonly status: "baseline" | "ok" | "error";
  readonly error?: "auth" | "timeout" | "http" | "invalid_response" | "network";
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedInputCostUsd?: number;
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

type SleepLike = (milliseconds: number) => Promise<void>;

export interface ClientOptions {
  readonly fetchImpl?: FetchLike;
  readonly sleepImpl?: SleepLike;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export type BaselineRule = { readonly pattern: string; readonly model: string };
const DEFAULT_COMPILED_RULES = compileRules(DEFAULT_RULES);

export function baselineTier(prompt: string, rules: readonly BaselineRule[] = DEFAULT_RULES, defaultTier = "general"): { tier: string; source: "regex_rule" | "default" } {
  const compiled = rules === DEFAULT_RULES ? DEFAULT_COMPILED_RULES : compileRules(rules);
  const tier = classifyCompiled(prompt, compiled);
  return tier === undefined ? { tier: defaultTier, source: "default" } : { tier, source: "regex_rule" };
}

export function buildRequest(prompt: string): Record<string, unknown> {
  return {
    state: prompt,
    model: TYPESAFE_MODEL,
    questions: {
      tier: {
        type: "choice",
        instructions: "Which model tier best fits this coding-agent request? Judge task complexity and consequence, not stated preference or price.",
        criteria: {
          quick: "Bounded, reversible, obvious work such as formatting, lookup, or a small mechanical edit. Not complex debugging, design, or security analysis.",
          general: "Normal implementation, tests, API changes, or moderate reasoning with clear scope. Not purely mechanical or unusually ambiguous and consequential work.",
          frontier: "Complex debugging, architecture, security, high ambiguity, concurrency, or high-consequence work. Not routine bounded edits.",
        },
      },
    },
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalidResponse(): never {
  throw new Error("invalid_response");
}

export function parseJevResponse(payload: unknown): JevJudgment {
  if (!payload || typeof payload !== "object") invalidResponse();
  const body = payload as Record<string, unknown>;
  if (body.model !== TYPESAFE_MODEL) invalidResponse();
  if (!body.answers || typeof body.answers !== "object") invalidResponse();
  const answer = (body.answers as Record<string, unknown>).tier;
  if (!answer || typeof answer !== "object") invalidResponse();
  const value = answer as Record<string, unknown>;
  if (value.type !== "choice" || typeof value.choice !== "string" || !TIERS.includes(value.choice as Tier)) invalidResponse();
  if (!value.probabilities || typeof value.probabilities !== "object") invalidResponse();

  const entries = Object.entries(value.probabilities as Record<string, unknown>);
  if (entries.length !== TIERS.length || entries.some(([key]) => !TIERS.includes(key as Tier))) invalidResponse();
  const probabilities = {} as Record<Tier, number>;
  for (const tier of TIERS) {
    const probability = (value.probabilities as Record<string, unknown>)[tier];
    if (!finiteNumber(probability) || probability < 0 || probability > 1) invalidResponse();
    probabilities[tier] = probability;
  }
  const sum = TIERS.reduce((total, tier) => total + probabilities[tier], 0);
  if (Math.abs(sum - 1) > 0.001) invalidResponse();
  const selected = value.choice as Tier;
  const maximum = Math.max(...TIERS.map((tier) => probabilities[tier]));
  if (Math.abs(probabilities[selected] - maximum) > 1e-9) invalidResponse();
  if (!finiteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1) invalidResponse();

  if (!body.usage || typeof body.usage !== "object") invalidResponse();
  const usage = body.usage as Record<string, unknown>;
  if (!Number.isInteger(usage.input_tokens) || (usage.input_tokens as number) < 0) invalidResponse();
  if (!Number.isInteger(usage.output_tokens) || (usage.output_tokens as number) < 0) invalidResponse();

  return {
    tier: selected,
    confidence: value.confidence,
    probabilities,
    model: body.model,
    usage: { inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number },
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function errorCode(error: unknown): EvaluationRow["error"] {
  if (error instanceof Error && ["auth", "timeout", "http", "invalid_response", "network"].includes(error.message)) return error.message as EvaluationRow["error"];
  return "network";
}

export class TypeSafeJevClient {
  readonly #fetch: FetchLike;
  readonly #sleep: SleepLike;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;

  constructor(options: ClientOptions = {}) {
    const key = options.apiKey ?? resolveTypeSafeApiKey().apiKey;
    if (!key) throw new Error("TypeSafe credential is required: configure ~/.pi/agent/auth.json or TYPESAFE_API_KEY");
    this.#apiKey = key;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleepImpl ?? sleep;
    this.#timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    this.#maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)));
  }

  async evaluate(prompt: string): Promise<JevJudgment> {
    const deadline = performance.now() + this.#timeoutMs;
    let lastFailure: EvaluationRow["error"] = "network";

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("timeout");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let response: Response | undefined;
      try {
        response = await this.#fetch(TYPESAFE_SYSTEMONE_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
          body: JSON.stringify(buildRequest(prompt)),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error("timeout");
        lastFailure = "network";
      } finally {
        clearTimeout(timer);
      }

      if (response?.ok) {
        let payload: unknown;
        try { payload = await response.json(); } catch { throw new Error("invalid_response"); }
        return parseJevResponse(payload);
      }
      if (response && (response.status === 401 || response.status === 403)) throw new Error("auth");
      const retryable = response === undefined || response.status === 429 || response.status === 529;
      if (response && !retryable) throw new Error("http");
      if (response) lastFailure = "http";
      if (attempt === this.#maxAttempts) throw new Error(lastFailure);

      const delay = response ? (retryAfterMs(response) ?? 100 * (2 ** (attempt - 1))) : 100 * (2 ** (attempt - 1));
      if (delay >= deadline - performance.now()) throw new Error("timeout");
      await this.#sleep(delay);
    }
    throw new Error(lastFailure);
  }
}

export interface BenchmarkOptions {
  readonly mode?: "baseline" | "live" | "fixture";
  readonly client?: TypeSafeJevClient;
  readonly fixture?: Readonly<Record<string, unknown>>;
  readonly concurrency?: number;
}

async function boundedMap<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}

function rowBaseline(scenario: Scenario): EvaluationRow {
  const baseline = baselineTier(scenario.prompt);
  return { id: scenario.id, split: scenario.split, baselineTier: baseline.tier, baselineSource: baseline.source, goldTier: scenario.goldTier, family: scenario.family, unresolved: scenario.unresolved, status: "baseline" };
}

export async function runBenchmark(scenarios: readonly Scenario[], options: BenchmarkOptions = {}): Promise<EvaluationRow[]> {
  const mode = options.mode ?? "baseline";
  if (mode === "baseline") return scenarios.map(rowBaseline);
  const fixture = options.fixture ?? {};
  const client = mode === "live" ? (options.client ?? new TypeSafeJevClient()) : options.client;
  return boundedMap(scenarios, Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))), async (scenario) => {
    const baseline = baselineTier(scenario.prompt);
    const started = performance.now();
    try {
      const judgment = mode === "fixture" ? parseJevResponse(fixture[scenario.id]) : await client!.evaluate(scenario.prompt);
      return {
        id: scenario.id,
        split: scenario.split,
        baselineTier: baseline.tier,
        baselineSource: baseline.source,
        goldTier: scenario.goldTier,
        family: scenario.family,
        unresolved: scenario.unresolved,
        jevTier: judgment.tier,
        confidence: judgment.confidence,
        probabilities: judgment.probabilities,
        model: judgment.model,
        status: "ok",
        latencyMs: Math.round(performance.now() - started),
        inputTokens: judgment.usage.inputTokens,
        outputTokens: judgment.usage.outputTokens,
        estimatedInputCostUsd: judgment.usage.inputTokens * 0.042 / 1_000_000,
      };
    } catch (error) {
      return { id: scenario.id, split: scenario.split, baselineTier: baseline.tier, baselineSource: baseline.source, goldTier: scenario.goldTier, family: scenario.family, unresolved: scenario.unresolved, status: "error", error: errorCode(error), latencyMs: Math.round(performance.now() - started) };
    }
  });
}

function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

interface Accuracy {
  readonly correct: number;
  readonly scored: number;
  readonly rate?: number;
}

function accuracy(rows: readonly EvaluationRow[], predicted: (row: EvaluationRow) => string | undefined): Accuracy {
  const correct = rows.filter((row) => predicted(row) === row.goldTier).length;
  return { correct, scored: rows.length, rate: rows.length ? correct / rows.length : undefined };
}

export interface BenchmarkReport {
  readonly disclaimer: string;
  readonly n: number;
  readonly corpusVersion?: string;
  readonly splits: Record<string, number>;
  readonly model: { readonly requested: string; readonly observed: readonly string[] };
  readonly availability: { readonly successful: number; readonly total: number; readonly rate?: number };
  readonly strictAccuracy: Accuracy;
  readonly baselineComparableAccuracy: Accuracy;
  readonly baselineAllRowsAccuracy: Accuracy;
  readonly baselineFrontierFalseNegatives: { readonly count: number; readonly denominator: number; readonly rate?: number };
  readonly perTier: Record<string, { readonly gold: number; readonly correct: number; readonly precision: number; readonly recall: number }>;
  readonly perFamily: Record<string, { readonly scored: number; readonly correct: number; readonly accuracy?: number }>;
  readonly confusionMatrix: Record<string, Record<string, number>>;
  readonly frontierFalseNegatives: { readonly count: number; readonly denominator: number; readonly rate?: number };
  readonly baselineAgreement?: number;
  readonly correctedRoutingDelta?: number;
  readonly errors: Record<string, number>;
  readonly latencyMs: { readonly p50?: number; readonly p95?: number };
  readonly tokenUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedInputCostUsd: number };
  readonly calibration: { readonly samples: number; readonly multiclassBrier?: number; readonly logLoss?: number; readonly expectedCalibrationError?: number };
}

function calculateCalibration(rows: readonly EvaluationRow[]): BenchmarkReport["calibration"] {
  const probabilistic = rows.filter((row) => row.goldTier !== undefined && row.jevTier !== undefined && row.probabilities !== undefined);
  if (!probabilistic.length) return { samples: 0 };
  let brier = 0;
  let logLoss = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, correct: 0 }));
  for (const row of probabilistic) {
    for (const tier of TIERS) {
      const target = row.goldTier === tier ? 1 : 0;
      brier += ((row.probabilities![tier] - target) ** 2) / probabilistic.length;
    }
    logLoss += -Math.log(Math.max(1e-15, row.probabilities![row.goldTier!])) / probabilistic.length;
    const selectedProbability = row.probabilities![row.jevTier!];
    const bin = bins[Math.min(9, Math.floor(selectedProbability * 10))];
    bin.count++;
    bin.probability += selectedProbability;
    if (row.jevTier === row.goldTier) bin.correct++;
  }
  const expectedCalibrationError = bins.reduce((sum, bin) => {
    if (!bin.count) return sum;
    return sum + (bin.count / probabilistic.length) * Math.abs((bin.correct / bin.count) - (bin.probability / bin.count));
  }, 0);
  return { samples: probabilistic.length, multiclassBrier: brier, logLoss, expectedCalibrationError };
}

export function calculateReport(rows: readonly EvaluationRow[], corpusVersion?: string): BenchmarkReport {
  const labelled = rows.filter((row) => row.goldTier !== undefined && !row.unresolved && TIERS.includes(row.baselineTier as Tier));
  const scored = labelled.filter((row) => row.status === "ok" && row.jevTier !== undefined);
  const baselineEvaluated = scored.length ? scored : labelled;
  const predicted = (row: EvaluationRow): Tier | undefined => (scored.length ? row.jevTier : row.baselineTier) as Tier | undefined;
  const matrix: Record<string, Record<string, number>> = {};
  for (const gold of TIERS) { matrix[gold] = {}; for (const tier of TIERS) matrix[gold][tier] = 0; }
  for (const row of baselineEvaluated) matrix[row.goldTier!][predicted(row)!]++;

  const perTier: BenchmarkReport["perTier"] = {};
  for (const tier of TIERS) {
    const gold = baselineEvaluated.filter((row) => row.goldTier === tier).length;
    const predictedCount = baselineEvaluated.filter((row) => predicted(row) === tier).length;
    perTier[tier] = { gold, correct: matrix[tier][tier], precision: predictedCount ? matrix[tier][tier] / predictedCount : 0, recall: gold ? matrix[tier][tier] / gold : 0 };
  }
  const families = new Set(labelled.flatMap((row) => row.family === undefined ? [] : [row.family]));
  const perFamily: BenchmarkReport["perFamily"] = {};
  for (const family of families) {
    const familyRows = baselineEvaluated.filter((row) => row.family === family);
    const correct = familyRows.filter((row) => predicted(row) === row.goldTier).length;
    perFamily[family] = { scored: familyRows.length, correct, accuracy: familyRows.length ? correct / familyRows.length : undefined };
  }

  const errors: Record<string, number> = {};
  for (const row of rows) if (row.error) errors[row.error] = (errors[row.error] ?? 0) + 1;
  const frontierGold = baselineEvaluated.filter((row) => row.goldTier === "frontier");
  const frontierFalseNegatives = frontierGold.filter((row) => predicted(row) !== "frontier").length;
  const baselineFrontierGold = labelled.filter((row) => row.goldTier === "frontier");
  const baselineFrontierFalseNegatives = baselineFrontierGold.filter((row) => row.baselineTier !== "frontier").length;
  const baselineWrongJevCorrect = scored.filter((row) => row.baselineTier !== row.goldTier && row.jevTier === row.goldTier).length;
  const baselineCorrectJevWrong = scored.filter((row) => row.baselineTier === row.goldTier && row.jevTier !== row.goldTier).length;
  const successful = rows.filter((row) => row.status === "ok").length;
  const splits: Record<string, number> = {};
  for (const row of rows) splits[row.split] = (splits[row.split] ?? 0) + 1;
  const inputTokens = rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const outputTokens = rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  const observedModels = [...new Set(rows.flatMap((row) => row.model ? [row.model] : []))].sort();

  return {
    disclaimer: "Preliminary development evaluation only. Labels are development labels; this report does not authorize production routing or claim Jev superiority.",
    n: rows.length,
    corpusVersion,
    splits,
    model: { requested: TYPESAFE_MODEL, observed: observedModels },
    availability: { successful, total: rows.length, rate: rows.length ? successful / rows.length : undefined },
    strictAccuracy: scored.length ? accuracy(scored, (row) => row.jevTier) : { correct: 0, scored: 0 },
    baselineComparableAccuracy: scored.length ? accuracy(scored, (row) => row.baselineTier) : accuracy(labelled, (row) => row.baselineTier),
    baselineAllRowsAccuracy: accuracy(labelled, (row) => row.baselineTier),
    baselineFrontierFalseNegatives: { count: baselineFrontierFalseNegatives, denominator: baselineFrontierGold.length, rate: baselineFrontierGold.length ? baselineFrontierFalseNegatives / baselineFrontierGold.length : undefined },
    perTier,
    perFamily,
    confusionMatrix: matrix,
    frontierFalseNegatives: { count: frontierFalseNegatives, denominator: frontierGold.length, rate: frontierGold.length ? frontierFalseNegatives / frontierGold.length : undefined },
    baselineAgreement: scored.length ? scored.filter((row) => row.baselineTier === row.jevTier).length / scored.length : undefined,
    correctedRoutingDelta: scored.length ? (baselineWrongJevCorrect - baselineCorrectJevWrong) / scored.length : undefined,
    errors,
    latencyMs: { p50: percentile(rows.flatMap((row) => row.latencyMs === undefined ? [] : [row.latencyMs]), 0.5), p95: percentile(rows.flatMap((row) => row.latencyMs === undefined ? [] : [row.latencyMs]), 0.95) },
    tokenUsage: { inputTokens, outputTokens, estimatedInputCostUsd: inputTokens * 0.042 / 1_000_000 },
    calibration: calculateCalibration(scored),
  };
}

function requiredString(record: Record<string, unknown>, key: string, line: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`input line ${line} requires ${key}`);
  return value;
}

export function parseJsonLines(text: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  const prompts = new Set<string>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const line = index + 1;
    let value: unknown;
    try { value = JSON.parse(rawLine); } catch { throw new Error(`invalid JSON on line ${line}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`input line ${line} must be an object`);
    const record = value as Record<string, unknown>;
    const id = requiredString(record, "id", line);
    const prompt = requiredString(record, "prompt", line);
    const family = requiredString(record, "family", line);
    const goldRationale = requiredString(record, "goldRationale", line);
    const ambiguity = requiredString(record, "ambiguity", line);
    if (ids.has(id)) throw new Error(`duplicate id ${id}`);
    if (prompts.has(prompt)) throw new Error(`duplicate prompt on line ${line}`);
    ids.add(id);
    prompts.add(prompt);
    if (!TIERS.includes(record.goldTier as Tier)) throw new Error(`invalid goldTier on line ${line}`);
    if (record.split !== "dev" && record.split !== "review") throw new Error(`invalid split on line ${line}`);
    const expectedAlternative = record.expectedAlternative;
    if (expectedAlternative !== undefined && (!Array.isArray(expectedAlternative) || expectedAlternative.some((tier) => !TIERS.includes(tier as Tier)))) throw new Error(`invalid expectedAlternative on line ${line}`);
    scenarios.push({
      id,
      prompt,
      family,
      goldTier: record.goldTier as Tier,
      goldRationale,
      ambiguity,
      split: record.split,
      expectedAlternative: expectedAlternative as Tier[] | undefined,
      tags: Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string") ? record.tags as string[] : undefined,
      unresolved: record.unresolved === true,
    });
  }
  if (!scenarios.length) throw new Error("corpus is empty");
  return scenarios;
}

export function selectSplit(scenarios: readonly Scenario[], split: SelectedSplit): Scenario[] {
  return split === "all" ? [...scenarios] : scenarios.filter((scenario) => scenario.split === split);
}

function usage(): never {
  console.error("Usage: npm run benchmark:jev -- [--baseline|--live|--fixture file] [input.jsonl|-] [--split dev|review|all] [--concurrency N] [--timeout-ms N]");
  process.exit(2);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let mode: "baseline" | "live" | "fixture" = "baseline";
  let fixturePath: string | undefined;
  let inputPath: string | undefined;
  let split: SelectedSplit = "dev";
  let concurrency = DEFAULT_CONCURRENCY;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") { console.log("Evaluation-only Jev benchmark. Preliminary development evidence; never changes routing.\nUsage: [--baseline|--live|--fixture file] [input.jsonl|-] [--split dev|review|all] [--concurrency N] [--timeout-ms N]"); return; }
    if (arg === "--baseline") mode = "baseline";
    else if (arg === "--live") mode = "live";
    else if (arg === "--fixture") { mode = "fixture"; fixturePath = argv[++i]; }
    else if (arg === "--split") split = argv[++i] as SelectedSplit;
    else if (arg === "--concurrency") concurrency = Number(argv[++i]);
    else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i]);
    else if (arg.startsWith("--")) usage();
    else if (!inputPath) inputPath = arg;
    else usage();
  }
  if (!["dev", "review", "all"].includes(split) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) usage();
  const input = inputPath && inputPath !== "-" ? readFileSync(inputPath, "utf8") : await new Promise<string>((resolve) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => text += chunk); process.stdin.on("end", () => resolve(text)); });
  const allScenarios = parseJsonLines(input);
  const scenarios = selectSplit(allScenarios, split);
  if (!scenarios.length) throw new Error(`no scenarios in split ${split}`);
  const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown> : undefined;
  const client = mode === "live" ? new TypeSafeJevClient({ timeoutMs }) : undefined;
  const rows = await runBenchmark(scenarios, { mode, fixture, client, concurrency });
  let corpusVersion: string | undefined;
  if (inputPath && inputPath !== "-") {
    try { corpusVersion = readFileSync(join(dirname(inputPath), "VERSION"), "utf8").trim(); } catch { /* optional for ad-hoc corpora */ }
  }
  const report = calculateReport(rows, corpusVersion);
  console.log(JSON.stringify({ ...report, rows }, null, 2));
  const accuracy = mode === "baseline" ? report.baselineAllRowsAccuracy : report.strictAccuracy;
  const frontierErrors = mode === "baseline" ? report.baselineFrontierFalseNegatives : report.frontierFalseNegatives;
  const latency = report.latencyMs.p50 === undefined ? "n/a" : `${report.latencyMs.p50}/${report.latencyMs.p95 ?? "n/a"}ms`;
  const availability = mode === "baseline" ? "baseline-only" : `${report.availability.successful}/${report.availability.total}`;
  console.error(`Jev benchmark (${split}): ${report.n} prompts; availability ${availability}; accuracy ${accuracy.scored ? `${(accuracy.rate! * 100).toFixed(1)}%` : "n/a"}; frontier false negatives ${frontierErrors.count}/${frontierErrors.denominator}; latency p50/p95 ${latency}; tokens in/out ${report.tokenUsage.inputTokens}/${report.tokenUsage.outputTokens}; estimated cost $${report.tokenUsage.estimatedInputCostUsd.toFixed(6)}. Preliminary development evaluation only.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error instanceof Error ? error.message : "benchmark failed"); process.exitCode = 1; });
