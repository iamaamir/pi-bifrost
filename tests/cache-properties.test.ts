// Replayable cache and classifier-identity properties. The linear oracle below
// uses its own Unicode normalizer and scans entries directly; it does not share
// the production token index or normalization implementation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { lookupCache, normalize, updateCache, type CacheEntry } from "../cache.ts";
import { classifierCacheKey } from "../classifier-semantics.ts";
import type { BifrostConfig } from "../config.ts";

const NOW = 1_700_000_000_000;
const REPLAY_PATH = process.env.FC_PATH;
const WORDS = ["alpha", "beta", "gamma", "delta", "naïve", "über", "λογος", "δοκιμή", "調試", "内存", "مرحبا", "٣"] as const;
const SEPARATORS = [" ", "  ", "-", "_", ",", "/", "!", "\n"] as const;
const WORD = fc.constantFrom(...WORDS);
const RAW_WORDS = fc.array(WORD, { minLength: 1, maxLength: 7 });

function oracleNormalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean).sort().join(" ");
}

function render(words: readonly string[], separators: readonly string[] = []): string {
  return words.map((word, index) => `${index === 0 ? "" : separators[(index - 1) % separators.length] ?? " "}${word}`).join("");
}

function withClock<T>(time: number, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => time;
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

function linearLookup(
  entries: readonly CacheEntry[],
  prompt: string,
  threshold: number,
  semanticKey: string | undefined,
  maxAgeMs: number,
  now: number,
): CacheEntry | undefined {
  const normalized = oracleNormalize(prompt);
  const cutoff = now - maxAgeMs;
  const usable = (entry: CacheEntry) => entry.lastUsed >= cutoff
    && (semanticKey === undefined || entry.semanticKey === semanticKey);
  const exact = entries.find((entry) => entry.normalized === normalized && usable(entry));
  if (exact) return exact;

  const promptTokens = tokenSet(normalized);
  if (promptTokens.size === 0) return undefined;
  let best: { entry: CacheEntry; score: number; index: number } | undefined;
  entries.forEach((entry, index) => {
    if (!usable(entry)) return;
    const entryTokens = tokenSet(entry.normalized);
    let intersection = 0;
    for (const token of promptTokens) if (entryTokens.has(token)) intersection++;
    if (intersection === 0) return;
    const union = promptTokens.size + entryTokens.size - intersection;
    const score = intersection / union;
    if (score < threshold) return;
    if (!best || score > best.score) best = { entry, score, index };
  });
  return best?.entry;
}

function assertReplayableProperty(property: fc.IProperty<unknown>, seed: number): void {
  fc.assert(property, { numRuns: 250, seed, path: REPLAY_PATH });
}

function cacheEntryArbitrary(now: number): fc.Arbitrary<CacheEntry> {
  return fc.record({
    words: RAW_WORDS,
    category: fc.constantFrom("quick", "general", "frontier"),
    age: fc.integer({ min: 0, max: 200 }),
    semanticKey: fc.option(fc.constantFrom("sem-a", "sem-b"), { nil: undefined }),
    hits: fc.integer({ min: 0, max: 20 }),
  }).map(({ words, category, age, semanticKey, hits }) => ({
    normalized: oracleNormalize(words.join(" ")),
    category,
    lastUsed: now - age,
    hits,
    ...(semanticKey === undefined ? {} : { semanticKey }),
  }));
}

const THRESHOLD = fc.oneof(
  fc.constantFrom(0, 0.25, 0.5, 0.75, 1),
  fc.double({ min: 0, max: 1, noNaN: true }),
);

function config(systemPrompt: string, criteria: Record<string, string>): BifrostConfig {
  return {
    models: { quick: ["chat/a"], general: ["chat/b"] },
    default: "general",
    classifier: { backend: "prompt", model: "chat/classifier", systemPrompt, criteria },
  };
}

describe("cache properties", () => {
  it("normalization is idempotent and supported Unicode tokens ignore order", () => {
    assertReplayableProperty(
      fc.property(RAW_WORDS, fc.array(fc.constantFrom(...SEPARATORS), { maxLength: 8 }), (words, separators) => {
        const raw = render(words, separators);
        const reordered = render([...words].reverse(), [...separators].reverse());
        const normalized = normalize(raw);
        assert.equal(normalized, oracleNormalize(raw));
        assert.equal(normalize(normalized), normalized);
        assert.equal(normalize(reordered), normalized);
      }),
      0x51ca01,
    );
  });

  it("linear exact/Jaccard lookup agrees with indexed lookup across keys, ties, thresholds, and TTL", () => {
    const entry = cacheEntryArbitrary(NOW);
    assertReplayableProperty(
      fc.property(
        fc.array(entry, { maxLength: 10 }),
        RAW_WORDS,
        THRESHOLD,
        fc.option(fc.constantFrom("sem-a", "sem-b", "sem-missing"), { nil: undefined }),
        fc.integer({ min: 0, max: 200 }),
        (entries, promptWords, threshold, semanticKey, ttl) => withClock(NOW, () => {
          const prompt = render(promptWords, [" ", "-", ","]);
          const expected = linearLookup(entries, prompt, threshold, semanticKey, ttl, NOW);
          const actual = lookupCache(entries as CacheEntry[], prompt, threshold, semanticKey, ttl);
          assert.equal(actual, expected);
        }),
      ),
      0x51ca02,
    );
  });

  it("keeps TTL boundary inclusive and rejects entries one millisecond older", () => {
    assertReplayableProperty(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (ttl) => withClock(NOW, () => {
        const entries: CacheEntry[] = [
          { normalized: "alpha beta", category: "quick", lastUsed: NOW - ttl - 1, hits: 0, semanticKey: "sem-a" },
          { normalized: "alpha beta", category: "general", lastUsed: NOW - ttl, hits: 0, semanticKey: "sem-a" },
          { normalized: "alpha beta", category: "frontier", lastUsed: NOW, hits: 0, semanticKey: "sem-b" },
        ];
        assert.equal(lookupCache(entries, "alpha beta", 1, "sem-a", ttl), entries[1]);
        assert.equal(lookupCache(entries, "alpha beta", 1, "sem-b", ttl), entries[2]);
      })),
      0x51ca03,
    );
  });

  it("lookup stays pure for hits and misses, including legacy entries", () => {
    assertReplayableProperty(
      fc.property(
        fc.array(cacheEntryArbitrary(NOW), { maxLength: 10 }),
        RAW_WORDS,
        THRESHOLD,
        fc.option(fc.constantFrom("sem-a", "sem-b"), { nil: undefined }),
        (entries, promptWords, threshold, semanticKey) => withClock(NOW, () => {
          const before = structuredClone(entries);
          lookupCache(entries as CacheEntry[], render(promptWords, [" ", "_"]), threshold, semanticKey, 1000);
          assert.deepEqual(entries, before);
        }),
      ),
      0x51ca04,
    );
  });

  it("eviction retains newest lastUsed entries", () => {
    const oldEntries = fc.array(
      fc.record({
        token: fc.integer({ min: 0, max: 1000 }),
        age: fc.integer({ min: 1, max: 4 }),
        seq: fc.integer({ min: 0, max: 10_000 }),
      }),
      { minLength: 1, maxLength: 10 },
    ).filter((items) => new Set(items.map((item) => item.token)).size === items.length);
    assertReplayableProperty(
      fc.property(oldEntries, fc.integer({ min: 1, max: 10 }), (specs, capInput) => withClock(NOW, () => {
        const entries: CacheEntry[] = specs.map(({ token, age, seq }) => ({
          normalized: `old${token}`,
          category: "quick",
          lastUsed: NOW - age,
          hits: 0,
          seq,
        }));
        const cap = Math.min(capInput, entries.length);
        const expected = [...entries, { normalized: "entry new", category: "general", lastUsed: NOW, hits: 1 }]
          .sort((a, b) => b.lastUsed - a.lastUsed || (b.seq ?? 0) - (a.seq ?? 0))
          .slice(0, cap)
          .map((item) => item.normalized);
        const actual = updateCache(entries, "new-entry", "general", cap).map((item) => item.normalized);
        assert.deepEqual(actual, expected);
      })),
      0x51ca05,
    );
  });

  it("eviction uses greatest seq when lastUsed timestamps tie", () => {
    const specs = fc.array(
      fc.record({ token: fc.integer({ min: 0, max: 1000 }), seq: fc.integer({ min: 0, max: 10_000 }) }),
      { minLength: 1, maxLength: 9 },
    ).filter((items) => new Set(items.map((item) => item.token)).size === items.length);
    assertReplayableProperty(
      fc.property(specs, fc.integer({ min: 1, max: 9 }), (items, capInput) => withClock(NOW, () => {
        const entries: CacheEntry[] = [
          ...items.map(({ token, seq }) => ({
            normalized: `item${token}`,
            category: "quick",
            lastUsed: NOW,
            hits: 0,
            seq,
          })),
          { normalized: "target", category: "quick", lastUsed: NOW, hits: 0, seq: 20_000 },
        ];
        const target = entries[entries.length - 1]!;
        const cap = Math.min(capInput, entries.length - 1);
        const expected = entries
          .map((entry) => entry === target ? { ...entry, category: "general", hits: 1 } : entry)
          .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
          .slice(0, cap)
          .map((entry) => entry.normalized);
        const actual = updateCache(entries, target.normalized, "general", cap).map((entry) => entry.normalized);
        assert.deepEqual(actual, expected);
      })),
      0x51ca08,
    );
  });
});

describe("classifier cache-key properties", () => {
  it("preserves identity across equivalent criteria insertion orders", () => {
    assertReplayableProperty(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ minLength: 1, maxLength: 30 }), (quick, general) => {
        const firstCriteria = { quick, general };
        const reversedCriteria = { general, quick };
        assert.equal(
          classifierCacheKey(config("instructions", firstCriteria), ["quick", "general"]),
          classifierCacheKey(config("instructions", reversedCriteria), ["quick", "general"]),
        );
      }),
      0x51ca06,
    );
  });

  it("changes identity when classifier semantics change", () => {
    assertReplayableProperty(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (text, suffix) => {
        const first = config(text, { quick: "bounded", general: "normal" });
        const changedPrompt = config(`${text}${suffix}x`, { quick: "bounded", general: "normal" });
        const changedCriteria = config(text, { quick: `bounded${suffix}x`, general: "normal" });
        const tiers = ["quick", "general"] as const;
        assert.notEqual(classifierCacheKey(first, tiers), classifierCacheKey(changedPrompt, tiers));
        assert.notEqual(classifierCacheKey(first, tiers), classifierCacheKey(changedCriteria, tiers));
        assert.notEqual(classifierCacheKey(first, tiers), classifierCacheKey(first, [...tiers].reverse()));
      }),
      0x51ca07,
    );
  });

  it("rejects controlled semantic-filter, TTL, and index-score mutants", () => {
    const same = (entry: CacheEntry | undefined) => entry?.category;
    const check = (entries: CacheEntry[], prompt: string, threshold: number, key: string | undefined, ttl: number) => {
      const expected = linearLookup(entries, prompt, threshold, key, ttl, NOW);
      const compare = (candidate: CacheEntry | undefined) => assert.equal(same(candidate), same(expected));
      return { expected, compare };
    };

    withClock(NOW, () => {
      const semanticEntries: CacheEntry[] = [
        { normalized: "alpha beta", category: "wrong-semantic", lastUsed: NOW, hits: 0, semanticKey: "other" },
        { normalized: "alpha beta", category: "right-semantic", lastUsed: NOW, hits: 0, semanticKey: "wanted" },
      ];
      const semantic = check(semanticEntries, "alpha beta", 1, "wanted", 100);
      assert.throws(() => semantic.compare(semanticEntries.find((entry) => entry.normalized === "alpha beta")));

      const legacy: CacheEntry[] = [
        { normalized: "alpha beta", category: "legacy", lastUsed: NOW, hits: 0 },
      ];
      const legacyResult = check(legacy, "alpha beta", 1, "wanted", 100);
      assert.equal(legacyResult.expected, undefined);
      assert.throws(() => legacyResult.compare(legacy[0]));

      const ttlEntries: CacheEntry[] = [
        { normalized: "alpha beta", category: "expired", lastUsed: NOW - 11, hits: 0, semanticKey: "wanted" },
      ];
      const ttl = check(ttlEntries, "alpha beta", 1, "wanted", 10);
      assert.throws(() => ttl.compare(ttlEntries[0]));

      const scoreEntries: CacheEntry[] = [
        { normalized: "alpha beta", category: "lower-score", lastUsed: NOW, hits: 0, semanticKey: "wanted" },
        { normalized: "alpha beta gamma", category: "best-score", lastUsed: NOW, hits: 0, semanticKey: "wanted" },
      ];
      const score = check(scoreEntries, "alpha beta gamma delta", 0.5, "wanted", 100);
      assert.equal(score.expected?.category, "best-score");
      assert.throws(() => score.compare(scoreEntries[0]));
    });
  });
});
