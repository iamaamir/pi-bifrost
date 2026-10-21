// Generated-boundary properties for classification validation and
// semantic cache identity (issue #60).
//
// Three documented contracts are restated independently of production:
//
// 1. Result validation — `decodePiNativeJudgment` accepts only a choice
//    from the configured tiers with a usable confidence and a probability
//    distribution that covers exactly those tiers, sums to one within the
//    documented tolerance, and makes the chosen tier a maximal-probability
//    winner ("Decode only provider data needed for routing. Invalid data
//    is a classifier miss."). `extractCategory` returns only a configured
//    category, matched case-insensitively after stripping edge
//    punctuation, or undefined — it never invents a tier.
// 2. Documented fallback — "If prompt classification fails or returns an
//    unknown tier, Bifrost continues through configured fallback, regex
//    rules, and default tier behavior" (docs/guide/classifiers.md). The
//    pipeline properties drive generated classifier, cache, and direct
//    results through that stage order with local fakes only.
// 3. Semantic config/cache identity — the classification cache key is a
//    hash of the semantic classifier settings plus the tier list; every
//    semantic change (config field, runtime resolution, tier membership)
//    must move the key, while non-semantic configuration must not.
//    A pi-native decision with no configured model keeps its cache off
//    because the catalog choice can change.
//
// Generators stay small so fast-check shrinks a failure to a minimal
// boundary case, and every controlled-fault run carries a seed and a
// counterexample path that replays exactly. These are deterministic
// lower-level tests with fake transports, not Pi E2E proofs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { extractCategory } from "../classifier.ts";
import { decodePiNativeJudgment } from "../classifier-pi-native.ts";
import {
  classifierCacheEnabled,
  classifierCacheKey,
  type ClassifierRuntimeSemantics,
} from "../classifier-semantics.ts";
import { createPipeline, type ClassificationResult } from "../classification-pipeline.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassifierBackend } from "../classifier-backends.ts";
import type { BifrostConfig, ClassifierConfig } from "../config.ts";
import type { RouteRule } from "../routing.ts";
import { makeClassifierModel } from "./helpers.ts";

// ── Generators ─────────────────────────────────────────────────

/** Tier names shrink toward single letters; `z` never appears, so "z"-prefixed sentinels stay unique. */
const TIER_CHARS = ["a", "b", "c", "d", "1", "2"] as const;
const NOISE_CHARS = [" ", "\t", "\n", ".", ",", "!", "?", ":", ";", "-", "(", ")"] as const;

function characters(charset: readonly string[], maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...charset), { minLength: 1, maxLength }).map((parts) => parts.join(""));
}

const WORD = characters(TIER_CHARS, 4);
const TIER_NAME = characters(TIER_CHARS.slice(0, 4), 3);
const TIERS = fc.uniqueArray(TIER_NAME, { minLength: 2, maxLength: 5 });
const NOISE = fc.array(fc.constantFrom(...NOISE_CHARS), { maxLength: 4 }).map((parts) => parts.join(""));
const TEXT = fc.tuple(NOISE, WORD, NOISE).map(([prefix, word, suffix]) => `${prefix}${word}${suffix}`);
const CATEGORIES = fc.uniqueArray(WORD, { minLength: 1, maxLength: 4 });
const POSITIVE_WEIGHT = fc.double({ min: 0.001, max: 1, noNaN: true });

/** Normalize positive weights into a distribution that sums to one within floating-point error. */
function normalized(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

interface ValidCase {
  readonly tiers: readonly string[];
  readonly probabilities: Record<string, number>;
  readonly choice: string;
  readonly confidence: number;
}

/** A generated result that satisfies every documented acceptance rule (choice = maximal probability). */
const VALID = TIERS.chain((tiers) => fc.tuple(
  fc.array(POSITIVE_WEIGHT, { minLength: tiers.length, maxLength: tiers.length }),
  fc.double({ min: 0, max: 1, noNaN: true }),
).map(([weights, confidence]): ValidCase => {
  const values = normalized(weights);
  let maxIndex = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[maxIndex]) maxIndex = index;
  return {
    tiers,
    probabilities: Object.fromEntries(tiers.map((tier, index) => [tier, values[index]])),
    choice: tiers[maxIndex],
    confidence,
  };
}));

/** A generated result whose choice carries strictly less than the maximal probability. */
const NON_MAXIMAL = TIERS.chain((tiers) => fc.tuple(
  fc.nat(),
  fc.array(fc.double({ min: 0.5, max: 1, noNaN: true }), { minLength: tiers.length, maxLength: tiers.length }),
  fc.double({ min: 0.001, max: 0.4, noNaN: true }),
).map(([choiceNat, others, loser]): ValidCase => {
  const choiceIndex = choiceNat % tiers.length;
  const values = normalized(others.map((weight, index) => (index === choiceIndex ? loser : weight)));
  return {
    tiers,
    probabilities: Object.fromEntries(tiers.map((tier, index) => [tier, values[index]])),
    choice: tiers[choiceIndex],
    confidence: 0.8,
  };
}));

function choiceAnswer(c: ValidCase, overrides: { choice?: unknown; confidence?: number; probabilities?: Record<string, number> } = {}) {
  return {
    type: "choice",
    choice: overrides.choice ?? c.choice,
    confidence: overrides.confidence ?? c.confidence,
    probabilities: overrides.probabilities ?? { ...c.probabilities },
  };
}

/** Fixture seam: minimal provider-shaped result, matching the existing unit-test shape. */
function resultFixture(answer: unknown): ClassifierResult {
  return {
    api: "systemone",
    provider: "typesafe",
    model: "jev-latest",
    answers: { tier: answer },
    stopReason: "stop",
    timestamp: 1,
  } as unknown as ClassifierResult;
}

function scaleProbabilities(probabilities: Record<string, number>, scale: number): Record<string, number> {
  return Object.fromEntries(Object.entries(probabilities).map(([tier, value]) => [tier, value * scale]));
}

// ── Result validation: pi-native decoder ───────────────────────

describe("pi-native judgment validation properties", () => {
  it("accepts a generated valid result with exactly the expected judgment fields", () => {
    fc.assert(
      fc.property(VALID, fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }), (c, resolvedId) => {
        const judgment = decodePiNativeJudgment(resultFixture(choiceAnswer(c)), c.tiers, 0, resolvedId);
        assert.ok(judgment, `expected acceptance for ${JSON.stringify(c)}`);
        assert.equal(judgment.tier, c.choice);
        assert.equal(judgment.confidence, c.confidence);
        assert.equal(judgment.backend, CLASSIFIER_BACKEND_IDS.piNative);
        assert.equal(judgment.model, resolvedId ?? "typesafe/jev-latest");
        assert.deepEqual(judgment.probabilities, c.probabilities);
        // Invariants any accepted judgment must satisfy.
        assert.deepEqual(new Set(Object.keys(judgment.probabilities)), new Set(c.tiers));
        const values = c.tiers.map((tier) => judgment.probabilities[tier]);
        assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.001);
        assert.equal(judgment.probabilities[judgment.tier], Math.max(...values));
      }),
      { numRuns: 250 },
    );
  });

  it("accepts a confidence at or above minConfidence and rejects one below it", () => {
    fc.assert(
      fc.property(VALID, fc.double({ min: 0, max: 1, noNaN: true }), (c, minConfidence) => {
        const judgment = decodePiNativeJudgment(resultFixture(choiceAnswer(c)), c.tiers, minConfidence);
        if (c.confidence >= minConfidence) assert.ok(judgment, `conf ${c.confidence} >= ${minConfidence} must be accepted`);
        else assert.equal(judgment, undefined, `conf ${c.confidence} < ${minConfidence} must be rejected`);
      }),
      { numRuns: 250 },
    );
  });

  it("rejects a confidence outside the documented range", () => {
    const fault = fc.constantFrom<"above-one" | "negative" | "not-a-number">("above-one", "negative", "not-a-number");
    fc.assert(
      fc.property(VALID, fc.double({ min: 1e-6, max: 1, noNaN: true }), fault, (c, delta, kind) => {
        const confidence = kind === "above-one" ? 1 + delta : kind === "negative" ? -delta : Number.NaN;
        const judgment = decodePiNativeJudgment(resultFixture(choiceAnswer(c, { confidence })), c.tiers, 0);
        assert.equal(judgment, undefined, `${kind} confidence must be a classifier miss`);
      }),
      { numRuns: 250 },
    );
  });

  it("rejects a choice the tiers do not contain", () => {
    fc.assert(
      fc.property(VALID, (c) => {
        // "unknown" cannot collide: tier names use only the a–d/1–2 alphabet.
        assert.equal(decodePiNativeJudgment(resultFixture(choiceAnswer(c, { choice: "unknown" })), c.tiers, 0), undefined);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects invalid probability values", () => {
    const fault = fc.constantFrom<"above-one" | "negative" | "not-a-number" | "infinite">(
      "above-one", "negative", "not-a-number", "infinite",
    );
    fc.assert(
      fc.property(VALID, fc.nat(), fc.double({ min: 1e-6, max: 1, noNaN: true }), fault, (c, indexNat, delta, kind) => {
        const tier = c.tiers[indexNat % c.tiers.length];
        const value = kind === "above-one" ? 1 + delta
          : kind === "negative" ? -delta
          : kind === "not-a-number" ? Number.NaN
          : Number.POSITIVE_INFINITY;
        const probabilities = { ...c.probabilities, [tier]: value };
        assert.equal(
          decodePiNativeJudgment(resultFixture(choiceAnswer(c, { probabilities })), c.tiers, 0),
          undefined,
          `${kind} probability must be a classifier miss`,
        );
      }),
      { numRuns: 250 },
    );
  });

  it("rejects distributions that miss a tier, invent a tier, or leave the sum tolerance", () => {
    const fault = fc.constantFrom<"missing" | "extra" | "sum-off">("missing", "extra", "sum-off");
    fc.assert(
      fc.property(
        VALID,
        fc.nat(),
        fault,
        fc.double({ min: 0.9, max: 0.996, noNaN: true }),
        (c, indexNat, kind, scale) => {
          const tier = c.tiers[indexNat % c.tiers.length];
          const probabilities = { ...c.probabilities };
          if (kind === "missing") delete probabilities[tier];
          else if (kind === "extra") probabilities.ghost = 0.5;
          else Object.assign(probabilities, scaleProbabilities(c.probabilities, scale));
          assert.equal(
            decodePiNativeJudgment(resultFixture(choiceAnswer(c, { probabilities })), c.tiers, 0),
            undefined,
            `${kind} distribution must be a classifier miss`,
          );
        },
      ),
      { numRuns: 250 },
    );
  });

  it("accepts and rejects generated sums on both sides of the exact tolerance boundary", () => {
    const boundedPair = fc.tuple(
      fc.double({ min: 0.25, max: 0.75, noNaN: true }),
      fc.double({ min: 0.25, max: 0.75, noNaN: true }),
    ).map(([left, right]) => ({
      tiers: ["a", "b"] as const,
      probabilities: { a: left / (left + right), b: right / (left + right) },
      choice: left >= right ? "a" : "b",
      confidence: 0.9,
    }));
    const within = fc.constantFrom(0.9995, 1.0005);
    const outside = fc.constantFrom(0.9985, 1.0015);
    fc.assert(
      fc.property(boundedPair, within, (c, scale) => {
        const probabilities = scaleProbabilities(c.probabilities, scale);
        assert.ok(
          decodePiNativeJudgment(resultFixture(choiceAnswer(c, { probabilities })), c.tiers, 0),
          `sum ${scale} must stay within the 0.001 tolerance`,
        );
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(boundedPair, outside, (c, scale) => {
        const probabilities = scaleProbabilities(c.probabilities, scale);
        assert.equal(
          decodePiNativeJudgment(resultFixture(choiceAnswer(c, { probabilities })), c.tiers, 0),
          undefined,
          `sum ${scale} must be rejected outside the 0.001 tolerance`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a choice that is not a maximal-probability winner", () => {
    fc.assert(
      fc.property(NON_MAXIMAL, (c) => {
        assert.equal(
          decodePiNativeJudgment(resultFixture(choiceAnswer(c)), c.tiers, 0),
          undefined,
          "a strictly non-maximal choice must be a classifier miss",
        );
      }),
      { numRuns: 250 },
    );
  });

  it("accepts either side of a maximal-probability tie", () => {
    fc.assert(
      fc.property(TIERS, (tiers) => {
        const probabilities = Object.fromEntries(
          tiers.map((tier, index) => [tier, index < 2 ? 1 : 0.5]),
        );
        const total = tiers.reduce((sum, _tier, index) => sum + probabilities[tiers[index]], 0);
        const scaled = Object.fromEntries(tiers.map((tier) => [tier, probabilities[tier] / total]));
        for (const choice of tiers.slice(0, 2)) {
          const judgment = decodePiNativeJudgment(
            resultFixture(choiceAnswer({ tiers, probabilities: scaled, choice, confidence: 0.9 })),
            tiers,
            0,
          );
          assert.ok(judgment, `tied winner ${choice} must be accepted`);
          assert.equal(judgment.tier, choice);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("rejects malformed results before any field reads can route", () => {
    const malformed = fc.constantFrom<unknown>(
      undefined, // answers.tier missing
      {}, // empty answer object
      { type: "score", score: 0.9, confidence: 0.9 }, // wrong answer kind
      { type: "choice", choice: 42, confidence: 0.9, probabilities: { a: 1 } }, // non-string choice
      { type: "choice", choice: "a", confidence: 0.9, probabilities: null }, // null probabilities
      { type: "choice", choice: "a", confidence: 0.9 }, // missing probabilities
      { type: "choice", choice: "a", confidence: 0.9, probabilities: "a" }, // non-object probabilities
    );
    fc.assert(
      fc.property(malformed, (answer) => {
        assert.equal(decodePiNativeJudgment(resultFixture(answer), ["a", "b"], 0), undefined);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Result validation: text category extraction ────────────────

/** Independent end-stripping over the controlled ASCII alphabet — not production's unicode regex. */
function referenceNormalize(text: string): string {
  let normalizedText = text.toLowerCase();
  const isToken = (char: string): boolean => /[a-z0-9]/.test(char);
  while (normalizedText.length > 0 && !isToken(normalizedText[0])) normalizedText = normalizedText.slice(1);
  while (normalizedText.length > 0 && !isToken(normalizedText[normalizedText.length - 1])) {
    normalizedText = normalizedText.slice(0, -1);
  }
  return normalizedText;
}

describe("text category extraction properties", () => {
  it("returns exactly the independently expected category or undefined", () => {
    fc.assert(
      fc.property(TEXT, CATEGORIES, (text, categories) => {
        const expected = categories.find((category) => category === referenceNormalize(text));
        assert.equal(extractCategory(text, categories), expected);
      }),
      { numRuns: 300 },
    );
  });

  it("matches a configured category through generated punctuation and whitespace noise", () => {
    fc.assert(
      fc.property(NOISE, WORD, NOISE, (prefix, word, suffix) => {
        assert.equal(extractCategory(`${prefix}${word}${suffix}`, [word, "zzz"]), word);
      }),
      { numRuns: 250 },
    );
  });

  it("matches categories case-insensitively and never invents one", () => {
    fc.assert(
      fc.property(CATEGORIES, fc.string({ maxLength: 12 }), (categories, text) => {
        const result = extractCategory(text, categories);
        assert.ok(result === undefined || categories.includes(result), `invented tier: ${String(result)}`);
        const upper = categories[0].toUpperCase();
        assert.equal(extractCategory(upper, categories), categories[0]);
      }),
      { numRuns: 250 },
    );
  });

  it("never matches a category the text only contains as a substring", () => {
    fc.assert(
      fc.property(WORD, (category) => {
        assert.equal(extractCategory(`${category}z`, [category]), undefined);
        assert.equal(extractCategory(`z${category}`, [category]), undefined);
      }),
      { numRuns: 250 },
    );
  });
});

// ── Documented fallback stage order ────────────────────────────

interface FallbackCase {
  readonly tiers: readonly string[];
  readonly promptWord: string;
  readonly hasRule: boolean;
  readonly ruleModel: string;
  readonly defaultTier: string | undefined;
}

const FALLBACK_CASE = TIERS.chain((tiers) => fc.record({
  promptWord: WORD,
  hasRule: fc.boolean(),
  ruleModel: fc.constantFrom(...tiers),
  defaultTier: fc.option(fc.constantFrom(...tiers), { nil: undefined }),
}).map((partial): FallbackCase => ({ tiers, ...partial })));

/** The documented stage order restated locally: classifier tier, then regex rule, then default tier. */
type ExpectedOutcome =
  | { kind: "classified"; tier: string; source: "classifier" | "cache" | "regex" }
  | { kind: "fallback"; tier: string }
  | { kind: "unclassified" };

function expectedFallback(
  case_: FallbackCase,
  classifierTier: string | undefined,
  source: "classifier" | "cache",
): ExpectedOutcome {
  if (classifierTier !== undefined && case_.tiers.includes(classifierTier)) {
    return { kind: "classified", tier: classifierTier, source };
  }
  if (case_.hasRule) return { kind: "classified", tier: case_.ruleModel, source: "regex" };
  if (case_.defaultTier !== undefined) return { kind: "fallback", tier: case_.defaultTier };
  return { kind: "unclassified" };
}

function assertSameClassification(actual: ClassificationResult, expected: ExpectedOutcome): void {
  assert.equal(actual.kind, expected.kind);
  assert.equal("tier" in actual ? actual.tier : undefined, "tier" in expected ? expected.tier : undefined);
  if (expected.kind === "classified") {
    assert.equal("source" in actual ? actual.source : undefined, expected.source);
  }
}

function fallbackRules(case_: FallbackCase): RouteRule[] {
  return case_.hasRule ? [{ pattern: `^${case_.promptWord}$`, model: case_.ruleModel }] : [];
}

describe("documented fallback properties", () => {
  it("continues through regex rules and the default tier after a prompt-classifier miss", async () => {
    await fc.assert(
      fc.asyncProperty(
        FALLBACK_CASE,
        fc.constantFrom<"tier" | "unknown-tier" | "no-result">("tier", "unknown-tier", "no-result"),
        async (case_, mode) => {
          const classifierOutput = mode === "tier" ? case_.tiers[0] : mode === "unknown-tier" ? "unknown" : undefined;
          const pipeline = createPipeline({
            instrumentation: "none",
            cacheLookup: () => undefined,
            classifierModels: [makeClassifierModel("fixture", "classifier")],
            classifyWithLLM: async () => classifierOutput,
            regexRules: fallbackRules(case_),
            defaultTier: case_.defaultTier,
            tiers: case_.tiers,
          });
          assertSameClassification(
            await pipeline.classify(case_.promptWord),
            expectedFallback(case_, mode === "tier" ? case_.tiers[0] : undefined, "classifier"),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("continues through regex rules and the default tier after a direct-classifier miss", async () => {
    await fc.assert(
      fc.asyncProperty(
        FALLBACK_CASE,
        fc.constantFrom<"tier" | "unknown-tier" | "no-result">("tier", "unknown-tier", "no-result"),
        async (case_, mode) => {
          const judgmentTier = mode === "tier" ? case_.tiers[0] : mode === "unknown-tier" ? "unknown" : undefined;
          const pipeline = createPipeline({
            instrumentation: "none",
            cacheLookup: () => undefined,
            classifyDirect: async () =>
              judgmentTier === undefined ? undefined : { tier: judgmentTier, backend: CLASSIFIER_BACKEND_IDS.piNative },
            classifierModels: [],
            classifyWithLLM: async () => undefined,
            regexRules: fallbackRules(case_),
            defaultTier: case_.defaultTier,
            tiers: case_.tiers,
          });
          assertSameClassification(
            await pipeline.classify(case_.promptWord),
            expectedFallback(case_, judgmentTier, "classifier"),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("uses configured prompt fallback after a direct miss, including prompt errors", async () => {
    await fc.assert(
      fc.asyncProperty(
        TIERS,
        fc.constantFrom<"success" | "unknown" | "empty" | "error">("success", "unknown", "empty", "error"),
        async (tiers, mode) => {
          let calls = 0;
          const promptTier = tiers[1];
          const defaultTier = tiers[0];
          const pipeline = createPipeline({
            instrumentation: "none",
            cacheLookup: () => undefined,
            classifyDirect: async () => undefined,
            classifierModels: [makeClassifierModel("fixture", "prompt-fallback")],
            classifyWithLLM: async () => {
              calls += 1;
              if (mode === "error") throw new Error("prompt fallback fixture failure");
              return mode === "success" ? promptTier : mode === "unknown" ? "unknown" : undefined;
            },
            regexRules: [],
            defaultTier,
            tiers,
          });
          const result = await pipeline.classify("configured prompt fallback");
          assert.equal(calls, 1, "direct miss must invoke configured prompt fallback exactly once");
          if (mode === "success") {
            assertSameClassification(result, { kind: "classified", tier: promptTier, source: "classifier" });
          } else {
            assertSameClassification(result, { kind: "fallback", tier: defaultTier });
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("routes a cached tier only when the cache value is a configured tier", async () => {
    await fc.assert(
      fc.asyncProperty(
        FALLBACK_CASE,
        fc.constantFrom<"hit" | "unknown" | "empty">("hit", "unknown", "empty"),
        async (case_, mode) => {
          const cached = mode === "hit" ? case_.tiers[0] : mode === "unknown" ? "unknown" : undefined;
          const pipeline = createPipeline({
            instrumentation: "none",
            cacheLookup: () => cached,
            classifierModels: [],
            classifyWithLLM: async () => {
              throw new Error("a cache decision must not trigger classifier calls");
            },
            regexRules: fallbackRules(case_),
            defaultTier: case_.defaultTier,
            tiers: case_.tiers,
          });
          assertSameClassification(
            await pipeline.classify(case_.promptWord),
            expectedFallback(case_, cached, "cache"),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ── Semantic config/cache identity ─────────────────────────────

const OPTIONAL_TEXT = fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: undefined });
const OPTIONAL_MODEL = fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: undefined });

interface SemanticFields {
  readonly backend: ClassifierBackend;
  readonly model: string | undefined;
  readonly endpoint: string | undefined;
  readonly method: "direct" | "subprocess" | "auto";
  readonly systemPrompt: string | undefined;
  readonly maxTokens: number | undefined;
  readonly temperature: number | undefined;
  readonly fallbackToRegex: boolean | undefined;
  readonly typesafeModel: string | undefined;
  readonly piNativeModel: string | undefined;
  readonly criteria: Record<string, string>;
  readonly minConfidence: number | undefined;
  readonly fallback: "prompt" | "regex" | undefined;
}

const SEMANTIC_FIELDS: fc.Arbitrary<SemanticFields> = fc.record({
  backend: fc.constantFrom<ClassifierBackend>(
    CLASSIFIER_BACKEND_IDS.prompt,
    CLASSIFIER_BACKEND_IDS.typesafe,
    CLASSIFIER_BACKEND_IDS.piNative,
  ),
  model: OPTIONAL_MODEL,
  endpoint: OPTIONAL_TEXT,
  method: fc.constantFrom<"direct" | "subprocess" | "auto">("direct", "subprocess", "auto"),
  systemPrompt: OPTIONAL_TEXT,
  maxTokens: fc.option(fc.integer({ min: 1, max: 4_096 }), { nil: undefined }),
  temperature: fc.option(fc.double({ min: 0, max: 2, noNaN: true }), { nil: undefined }),
  fallbackToRegex: fc.option(fc.boolean(), { nil: undefined }),
  typesafeModel: OPTIONAL_MODEL,
  piNativeModel: OPTIONAL_MODEL,
  criteria: fc.uniqueArray(fc.tuple(TIER_NAME, WORD), { maxLength: 3 })
    .map((entries) => Object.fromEntries(entries)),
  minConfidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
  fallback: fc.option(fc.constantFrom<"prompt" | "regex">("prompt", "regex"), { nil: undefined }),
});

interface SemanticCase {
  readonly config: BifrostConfig;
  readonly tiers: readonly string[];
  readonly runtime: ClassifierRuntimeSemantics;
}

function classifierOf(fields: SemanticFields): ClassifierConfig {
  return {
    backend: fields.backend,
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.endpoint !== undefined ? { endpoint: fields.endpoint } : {}),
    method: fields.method,
    ...(fields.systemPrompt !== undefined ? { systemPrompt: fields.systemPrompt } : {}),
    ...(fields.maxTokens !== undefined ? { maxTokens: fields.maxTokens } : {}),
    ...(fields.temperature !== undefined ? { temperature: fields.temperature } : {}),
    ...(fields.fallbackToRegex !== undefined ? { fallbackToRegex: fields.fallbackToRegex } : {}),
    ...(fields.typesafeModel !== undefined ? { typesafe: { model: fields.typesafeModel } } : {}),
    ...(fields.piNativeModel !== undefined ? { piNative: { model: fields.piNativeModel } } : {}),
    ...(Object.keys(fields.criteria).length > 0 ? { criteria: fields.criteria } : {}),
    ...(fields.minConfidence !== undefined ? { minConfidence: fields.minConfidence } : {}),
    ...(fields.fallback !== undefined ? { fallback: fields.fallback } : {}),
  };
}

const SEMANTIC_CASE: fc.Arbitrary<SemanticCase> = fc.tuple(
  SEMANTIC_FIELDS,
  TIERS,
  fc.option(fc.constantFrom<ClassifierBackend>(
    CLASSIFIER_BACKEND_IDS.prompt,
    CLASSIFIER_BACKEND_IDS.typesafe,
    CLASSIFIER_BACKEND_IDS.piNative,
  ), { nil: undefined }),
  OPTIONAL_MODEL,
  fc.boolean(),
).map(([fields, tiers, effectiveBackend, piNativeModel, credential]) => ({
  config: { classifier: classifierOf(fields) },
  tiers,
  runtime: {
    ...(effectiveBackend !== undefined ? { effectiveBackend } : {}),
    ...(piNativeModel !== undefined ? { piNativeModel } : {}),
    typesafeCredentialAvailable: credential,
  },
}));

const keyOf = (case_: SemanticCase): string => classifierCacheKey(case_.config, case_.tiers, case_.runtime);

describe("semantic cache identity properties", () => {
  it("is a deterministic hash of equal semantics, independent of key order and absent fields", () => {
    fc.assert(
      fc.property(SEMANTIC_CASE, (case_) => {
        const clone = JSON.parse(JSON.stringify(case_.config)) as BifrostConfig;
        const rerun = classifierCacheKey(clone, [...case_.tiers], { ...case_.runtime });
        assert.equal(keyOf(case_), rerun);
        assert.match(rerun, /^[a-f0-9]{64}$/);
        // Criteria key insertion order is not a semantic change.
        const classifier = case_.config.classifier;
        if (classifier?.criteria) {
          const reordered = Object.fromEntries(Object.entries(classifier.criteria).reverse());
          const shuffled = classifierCacheKey(
            { ...case_.config, classifier: { ...classifier, criteria: reordered } },
            case_.tiers,
            case_.runtime,
          );
          assert.equal(keyOf(case_), shuffled);
        }
      }),
      { numRuns: 250 },
    );
  });

  it("moves the key for every semantic classifier field that changes", () => {
    const backends: readonly ClassifierBackend[] = [
      CLASSIFIER_BACKEND_IDS.prompt,
      CLASSIFIER_BACKEND_IDS.typesafe,
      CLASSIFIER_BACKEND_IDS.piNative,
    ];
    const rotate = <T>(values: readonly T[], current: T): T =>
      values[(values.indexOf(current) + 1) % values.length];
    const varyText = (value: string | undefined, fallback: string): string => `${value ?? fallback}-x`;
    fc.assert(
      fc.property(SEMANTIC_CASE, (case_) => {
        // Config-side semantics: runtime resolutions shadow config fields by design
        // (`runtime.x ?? config.x`), so clear them to observe config mutations.
        const configCase: SemanticCase = {
          ...case_,
          runtime: { typesafeCredentialAvailable: case_.runtime.typesafeCredentialAvailable },
        };
        const fields: SemanticFields = JSON.parse(JSON.stringify({
          ...configCase.config.classifier,
          criteria: configCase.config.classifier?.criteria ?? {},
        })) as SemanticFields;
        const base = keyOf(configCase);
        const withClassifier = (patch: Partial<ClassifierConfig>): SemanticCase => ({
          ...configCase,
          config: { ...configCase.config, classifier: { ...classifierOf(fields), ...patch } },
        });
        const mutations: readonly (readonly [string, SemanticCase])[] = [
          ["backend", withClassifier({ backend: rotate(backends, fields.backend) })],
          ["model", withClassifier({ model: varyText(fields.model, "m") })],
          ["endpoint", withClassifier({ endpoint: varyText(fields.endpoint, "e") })],
          ["method", withClassifier({ method: rotate(["direct", "subprocess", "auto"] as const, fields.method) })],
          ["systemPrompt", withClassifier({ systemPrompt: varyText(fields.systemPrompt, "s") })],
          ["maxTokens", withClassifier({ maxTokens: (fields.maxTokens ?? 0) + 1 })],
          ["temperature", withClassifier({ temperature: (fields.temperature ?? 0) + 0.5 })],
          ["fallbackToRegex", withClassifier({ fallbackToRegex: !(fields.fallbackToRegex ?? false) })],
          ["typesafe.model", withClassifier({ typesafe: { model: varyText(fields.typesafeModel, "t") } })],
          ["piNative.model", withClassifier({ piNative: { model: varyText(fields.piNativeModel, "p") } })],
          ["criteria", withClassifier({ criteria: { ...fields.criteria, ["z"]: "w" } })],
          ["minConfidence", withClassifier({ minConfidence: (fields.minConfidence ?? 0) + 0.25 })],
          ["fallback", withClassifier({ fallback: rotate(["prompt", "regex"] as const, fields.fallback ?? "prompt") })],
        ];
        for (const [label, mutated] of mutations) {
          assert.notEqual(base, keyOf(mutated), `semantic field ${label} must move the cache key`);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("moves the key for every runtime resolution that changes", () => {
    const backends: readonly ClassifierBackend[] = [
      CLASSIFIER_BACKEND_IDS.prompt,
      CLASSIFIER_BACKEND_IDS.typesafe,
      CLASSIFIER_BACKEND_IDS.piNative,
    ];
    fc.assert(
      fc.property(SEMANTIC_CASE, (case_) => {
        const base = keyOf(case_);
        const move = (runtime: ClassifierRuntimeSemantics): string =>
          classifierCacheKey(case_.config, case_.tiers, runtime);
        const current = case_.runtime;
        // Rotate from the effective backend semantics the base key already carries.
        const effective = current.effectiveBackend ?? case_.config.classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt;
        assert.notEqual(
          base,
          move({ ...current, effectiveBackend: backends[(backends.indexOf(effective) + 1) % backends.length] }),
          "effectiveBackend must move the cache key",
        );
        assert.notEqual(
          base,
          move({ ...current, piNativeModel: `${current.piNativeModel ?? "p"}-x` }),
          "resolved pi-native model must move the cache key",
        );
        assert.notEqual(
          base,
          move({ ...current, typesafeCredentialAvailable: !current.typesafeCredentialAvailable }),
          "credential availability must move the cache key",
        );
      }),
      { numRuns: 150 },
    );
  });

  it("moves the key when tier membership changes and holds it when tiers are equal", () => {
    fc.assert(
      fc.property(SEMANTIC_CASE, (case_) => {
        const replaced = ["z" + case_.tiers[0], ...case_.tiers.slice(1)];
        assert.notEqual(keyOf(case_), classifierCacheKey(case_.config, replaced, case_.runtime));
        assert.equal(keyOf(case_), classifierCacheKey(case_.config, [...case_.tiers], case_.runtime));
      }),
      { numRuns: 250 },
    );
  });

  it("ignores non-semantic configuration around the classifier block", () => {
    fc.assert(
      fc.property(SEMANTIC_CASE, (case_) => {
        const noisy: BifrostConfig = {
          ...case_.config,
          schemaVersion: 2,
          enabled: false,
          default: case_.tiers[0],
          strategy: "cheapest",
          models: { noise: "prov/model" },
          rules: [{ pattern: "^x$", model: "y" }],
          cache: { enabled: false },
          debug: { enabled: true },
        };
        assert.equal(keyOf(case_), classifierCacheKey(noisy, case_.tiers, case_.runtime));
      }),
      { numRuns: 250 },
    );
  });
});

describe("classifier cache enablement properties", () => {
  it("keeps pi-native without a configured model out of the cache and follows cache.enabled otherwise", () => {
    const flag = fc.constantFrom<boolean | undefined>(undefined, true, false);
    const backend = fc.constantFrom<ClassifierBackend>(
      CLASSIFIER_BACKEND_IDS.prompt,
      CLASSIFIER_BACKEND_IDS.typesafe,
      CLASSIFIER_BACKEND_IDS.piNative,
    );
    fc.assert(
      fc.property(flag, backend, OPTIONAL_MODEL, (enabled, activeBackend, model) => {
        const config: BifrostConfig = {
          models: { general: "prov/model" },
          ...(enabled === undefined ? {} : { cache: { enabled } }),
          classifier: {
            backend: activeBackend,
            ...(model !== undefined ? { piNative: { model } } : {}),
          },
        };
        // Documented rule: a pi-native decision without a configured catalog model has
        // no stable fingerprint, and cache.enabled=false disables cache use.
        const expected = (enabled ?? true) && !(activeBackend === CLASSIFIER_BACKEND_IDS.piNative && model === undefined);
        assert.equal(classifierCacheEnabled(config, activeBackend), expected);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Controlled fault sensitivity ───────────────────────────────

/** Controlled fault: the documented checks minus the maximal-probability requirement. */
function decodeWithoutMaximalCheck(result: ClassifierResult, tiers: readonly string[]): boolean {
  const answer = result.answers?.tier as
    | { type?: string; choice?: unknown; confidence?: unknown; probabilities?: unknown }
    | undefined;
  if (!answer || answer.type !== "choice") return false;
  if (typeof answer.choice !== "string" || !tiers.includes(answer.choice)) return false;
  const confidence = answer.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
  const raw = answer.probabilities;
  if (!raw || typeof raw !== "object") return false;
  const probabilities = raw as Record<string, number>;
  if (Object.keys(probabilities).length !== tiers.length) return false;
  let sum = 0;
  for (const tier of tiers) {
    const probability = probabilities[tier];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return false;
    sum += probability;
  }
  return Math.abs(sum - 1) <= 0.001;
}

const CLASSIFIER_CACHE_CONFIG: BifrostConfig = { classifier: { backend: CLASSIFIER_BACKEND_IDS.prompt } };

/** Controlled fault: substring containment instead of normalized equality. */
function substringMatch(text: string, categories: readonly string[]): string | undefined {
  return categories.find((category) => text.toLowerCase().includes(category));
}

/** Controlled fault: a cache-key builder whose semantics omit the tier list. */
function tierBlindKey(tiers: readonly string[]): string {
  return classifierCacheKey(
    { ...CLASSIFIER_CACHE_CONFIG, models: Object.fromEntries(tiers.map((tier) => [tier, "prov/model"])) },
    ["ignored"],
  );
}

describe("controlled fault sensitivity", () => {
  // Committed replay evidence: the exact seed and counterexample path these
  // mutant properties produced at authoring time. A drift in the generators
  // changes the shrink path and fails this test loudly.
  const REPLAY = {
    argmax: { seed: -716482210, path: "0:0:0:0:0:0:0:0" },
    substring: { seed: -1540316168, path: "0:0:0" },
    tiers: { seed: -1521897426, path: "0:0:0" },
  };

  /** Controlled fault: the documented checks minus the maximal-probability requirement. */
  const argmaxCases = fc.oneof(
    VALID.map((case_) => ({ case_, accepted: true })),
    NON_MAXIMAL.map((case_) => ({ case_, accepted: false })),
  );
  const argmaxBlindMutant = fc.property(argmaxCases, ({ case_, accepted }) =>
    decodeWithoutMaximalCheck(resultFixture(choiceAnswer(case_)), case_.tiers) === accepted);
  const substringMutant = fc.property(WORD, (category) =>
    substringMatch(`${category}z`, [category]) === undefined);
  const tiersBlindMutant = fc.property(TIERS, (tiers) =>
    tierBlindKey(tiers) !== tierBlindKey(["z" + tiers[0], ...tiers.slice(1)]));

  it("detects a decoder contract that drops the maximal-probability check, shrinks, and replays", () => {
    // The production decoder passes the documented property on the same data…
    const documented = fc.property(argmaxCases, ({ case_, accepted }) =>
      (decodePiNativeJudgment(resultFixture(choiceAnswer(case_)), case_.tiers, 0) !== undefined) === accepted);
    assert.equal(fc.check(documented, { numRuns: 300 }).failed, false);

    // …while the argmax-blind mutant accepts strictly non-maximal winners.
    const rejected = fc.check(argmaxBlindMutant, { numRuns: 300 });
    assert.equal(rejected.failed, true);
    assert.equal(typeof rejected.seed, "number");
    assert.ok((rejected.counterexamplePath ?? "").length > 0);
    // A single tier can never be non-maximal, so the counterexample must keep two.
    assert.ok(rejected.counterexamplePath !== null && typeof rejected.counterexamplePath === "string");
    assert.equal(rejected.counterexample[0].case_.tiers.length, 2);

    const replay = fc.check(argmaxBlindMutant, {
      seed: rejected.seed,
      path: rejected.counterexamplePath ?? undefined,
      numRuns: 300,
    });
    assert.equal(replay.failed, true);
    assert.deepEqual(replay.counterexample, rejected.counterexample);
  });

  it("detects a substring category contract, shrinks, and replays", () => {
    const documented = fc.property(WORD, (category) => extractCategory(`${category}z`, [category]) === undefined);
    assert.equal(fc.check(documented, { numRuns: 300 }).failed, false);

    const rejected = fc.check(substringMutant, { numRuns: 300 });
    assert.equal(rejected.failed, true);
    assert.equal(typeof rejected.seed, "number");
    assert.ok((rejected.counterexamplePath ?? "").length > 0);
    assert.ok(rejected.counterexamplePath !== null && typeof rejected.counterexamplePath === "string");
    assert.equal(rejected.counterexample[0].length, 1, "shrinking must reach a one-character category");

    const replay = fc.check(substringMutant, {
      seed: rejected.seed,
      path: rejected.counterexamplePath ?? undefined,
      numRuns: 300,
    });
    assert.equal(replay.failed, true);
    assert.deepEqual(replay.counterexample, rejected.counterexample);
  });

  it("detects a cache key that ignores tier identity, shrinks, and replays", () => {
    const moveTier = (tiers: readonly string[]): string[] => ["z" + tiers[0], ...tiers.slice(1)];
    const documented = fc.property(TIERS, (tiers) =>
      classifierCacheKey(CLASSIFIER_CACHE_CONFIG, tiers) !== classifierCacheKey(CLASSIFIER_CACHE_CONFIG, moveTier(tiers)));
    assert.equal(fc.check(documented, { numRuns: 300 }).failed, false);

    const rejected = fc.check(tiersBlindMutant, { numRuns: 300 });
    assert.equal(rejected.failed, true);
    assert.equal(typeof rejected.seed, "number");
    assert.ok((rejected.counterexamplePath ?? "").length > 0);
    assert.ok(rejected.counterexamplePath !== null && typeof rejected.counterexamplePath === "string");
    assert.equal(rejected.counterexample[0].length, 2, "shrinking must reach the smallest tier pair");

    const replay = fc.check(tiersBlindMutant, {
      seed: rejected.seed,
      path: rejected.counterexamplePath ?? undefined,
      numRuns: 300,
    });
    assert.equal(replay.failed, true);
    assert.deepEqual(replay.counterexample, rejected.counterexample);
  });

  it("replays the committed seed and path evidence to the same minimal counterexamples", () => {
    const argmax = fc.check(argmaxBlindMutant, { seed: REPLAY.argmax.seed, path: REPLAY.argmax.path, numRuns: 300 });
    assert.equal(argmax.failed, true);
    assert.ok(argmax.counterexamplePath !== null && typeof argmax.counterexamplePath === "string");
    assert.equal(argmax.counterexample[0].case_.tiers.length, 2);

    const substring = fc.check(substringMutant, { seed: REPLAY.substring.seed, path: REPLAY.substring.path, numRuns: 300 });
    assert.equal(substring.failed, true);
    assert.ok(substring.counterexamplePath !== null && typeof substring.counterexamplePath === "string");
    assert.equal(substring.counterexample[0].length, 1);

    const tiers = fc.check(tiersBlindMutant, { seed: REPLAY.tiers.seed, path: REPLAY.tiers.path, numRuns: 300 });
    assert.equal(tiers.failed, true);
    assert.ok(tiers.counterexamplePath !== null && typeof tiers.counterexamplePath === "string");
    assert.equal(tiers.counterexample[0].length, 2);
  });
});
