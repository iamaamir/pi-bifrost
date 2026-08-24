import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalize,
  lookupCache,
  touchCacheEntry,
  findCachedCategory,
  updateCache,
  cachePath,
  loadCache,
} from "../cache.ts";

describe("cache", () => {
  describe("normalize", () => {
    it("lowercases, strips punctuation, sorts tokens", () => {
      assert.equal(normalize("Hello, World!"), "hello world");
      assert.equal(normalize("  Plan   the architecture? "), "architecture plan the");
    });

    it("returns empty string for empty input", () => {
      assert.equal(normalize(""), "");
    });

    it("preserves non-Latin characters", () => {
      const result = normalize("调试 内存泄漏");
      assert.ok(result.includes("调试"));
      assert.ok(result.includes("内存泄漏"));
    });

    it("normalizes empty string for Jaccard edge case", () => {
      // Empty-vs-empty should still produce cache-viable normalized form
      assert.equal(normalize("!@#$%"), "");
    });
  });

  describe("lookupCache", () => {
    it("returns entry for exact match (no mutation)", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 5 },
      ];
      const result = lookupCache(entries, "Hello World!", 0.85);
      assert.ok(result);
      assert.equal(result!.category, "economical");
      assert.equal(entries[0].hits, 5);
      assert.equal(entries[0].lastUsed, 1);
    });

    it("returns entry for fuzzy match above threshold", () => {
      const entries = [
        { normalized: "hello world today is nice", category: "economical", lastUsed: 1, hits: 0 },
      ];
      const result = lookupCache(entries, "hello world today is good", 0.5);
      assert.ok(result);
      assert.equal(result!.category, "economical");
      assert.equal(entries[0].lastUsed, 1);
    });

    it("returns undefined when nothing matches", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
      ];
      assert.equal(lookupCache(entries, "plan architecture", 0.85), undefined);
    });

    // ── Inverted-index semantics (must hold regardless of implementation) ──

    it("returns the FIRST entry among duplicate normalized values", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
        { normalized: "hello world", category: "frontier", lastUsed: 2, hits: 0 },
      ];
      const result = lookupCache(entries, "hello world", 0.85);
      assert.equal(result!.category, "economical");
    });

    it("returns the EARLIER entry on equal fuzzy scores", () => {
      // Both entries score identically against the prompt — earliest wins.
      const entries = [
        { normalized: "alpha beta gamma", category: "economical", lastUsed: 1, hits: 0 },
        { normalized: "alpha beta delta", category: "frontier", lastUsed: 2, hits: 0 },
      ];
      // Prompt is equidistant from both: shares alpha+beta with each,
      // one distinct token each way → same Jaccard for both.
      const result = lookupCache(entries, "alpha beta zeta", 0.5);
      assert.ok(result);
      assert.equal(result!.category, "economical");
    });

    it("returns undefined when prompt shares no tokens with any entry", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
        { normalized: "foo bar baz", category: "frontier", lastUsed: 2, hits: 0 },
      ];
      assert.equal(lookupCache(entries, "completely different words here", 0.5), undefined);
    });

    it("skips entries whose size ratio is below threshold even with full overlap", () => {
      // min/max = 2/6 = 0.33 < 0.8 — prefilter must reject despite the
      // smaller entry's tokens being fully contained in the prompt.
      const entries = [
        { normalized: "a b", category: "economical", lastUsed: 1, hits: 0 },
      ];
      assert.equal(lookupCache(entries, "a b c d e f", 0.8), undefined);
    });

    it("matches when score equals threshold exactly", () => {
      // Sizes 4 and 5, intersection 4 → union 5, score 4/5 = 0.8 ≥ 0.8.
      // The size prefilter (min/max = 4/5) must also admit this pair.
      const entries = [
        { normalized: "a b c d e", category: "economical", lastUsed: 1, hits: 0 },
      ];
      const result = lookupCache(entries, "a b c d", 0.8);
      assert.ok(result);
      assert.equal(result!.category, "economical");
    });

    describe("threshold 0 (blessed semantics)", () => {
      // At threshold 0 any entry sharing ≥1 token scores ≥ 0 and matches.
      // Zero-overlap prompts never match — this differs from the original
      // scan (which returned an arbitrary entry for every prompt) and is
      // the documented behavior per schema.json.
      it("matches when at least one token is shared", () => {
        const entries = [
          { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
        ];
        const result = lookupCache(entries, "hello completely different tail", 0);
        assert.ok(result);
        assert.equal(result!.category, "economical");
      });

      it("returns undefined for zero token overlap", () => {
        const entries = [
          { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
        ];
        assert.equal(lookupCache(entries, "unrelated words entirely", 0), undefined);
      });
    });
  });

  describe("touchCacheEntry", () => {
    it("mutates lastUsed and hits", () => {
      const entry = { normalized: "hello", category: "economical", lastUsed: 100, hits: 3 };
      touchCacheEntry(entry);
      assert.ok(entry.lastUsed > 100);
      assert.equal(entry.hits, 4);
    });
  });

  describe("findCachedCategory", () => {
    it("returns exact match", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
      ];
      assert.equal(findCachedCategory(entries, "Hello World!", 0.85), "economical");
    });

    it("returns fuzzy match above threshold", () => {
      const entries = [
        { normalized: "hello world today is nice", category: "economical", lastUsed: 1, hits: 0 },
      ];
      assert.equal(
        findCachedCategory(entries, "hello world today is good", 0.5),
        "economical",
      );
    });

    it("returns undefined when nothing matches", () => {
      const entries = [
        { normalized: "hello world", category: "economical", lastUsed: 1, hits: 0 },
      ];
      assert.equal(findCachedCategory(entries, "plan architecture", 0.85), undefined);
    });

    it("updates hits and lastUsed on match", () => {
      const entries = [
        { normalized: "hello", category: "economical", lastUsed: 1, hits: 1 },
      ];
      findCachedCategory(entries, "hello", 0.85);
      assert.equal(entries[0].hits, 2);
      assert.ok(entries[0].lastUsed > 1);
    });
  });

  describe("updateCache", () => {
    it("adds new entry", () => {
      const entries = updateCache([], "hello", "economical", 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].normalized, "hello");
      assert.equal(entries[0].category, "economical");
    });

    it("updates existing entry", () => {
      let entries = updateCache([], "hello", "economical", 10);
      entries = updateCache(entries, "hello", "frontier", 10);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].category, "frontier");
    });

    it("evicts oldest entries over cap", () => {
      let entries: ReturnType<typeof updateCache> = [];
      for (let i = 0; i < 5; i++) {
        entries = updateCache(entries, `token${i}`, "economical", 3);
      }
      assert.equal(entries.length, 3);
      assert.ok(!entries.some((e) => e.normalized === "token0"));
    });
  });

  describe("cachePath", () => {
    it("defaults to .pi/bifrost-cache.jsonl under cwd", () => {
      assert.equal(cachePath("/project"), "/project/.pi/bifrost-cache.jsonl");
    });

    it("expands leading tilde", () => {
      const home = process.env.HOME;
      process.env.HOME = "/home/user";
      try {
        assert.equal(cachePath("/project", "~/cache.jsonl"), "/home/user/cache.jsonl");
      } finally {
        process.env.HOME = home;
      }
    });

    it("joins relative path to cwd", () => {
      assert.equal(cachePath("/project", "cache.jsonl"), "/project/cache.jsonl");
    });
  });

  describe("loadCache", () => {
    it("returns empty array for missing file", () => {
      const cwd = mkdtempSync(join(tmpdir(), "bifrost-cache-"));
      try {
        assert.deepEqual(loadCache(join(cwd, ".pi", "bifrost-cache.jsonl")), []);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("skips corrupt lines and keeps valid entries", () => {
      const cwd = mkdtempSync(join(tmpdir(), "bifrost-cache-"));
      try {
        const path = join(cwd, ".pi", "bifrost-cache.jsonl");
        mkdirSync(join(cwd, ".pi"), { recursive: true });
        writeFileSync(path, "{not json\n{\"normalized\":\"hello\",\"category\":\"quick\",\"lastUsed\":1,\"hits\":2}\n", "utf8");
        const entries = loadCache(path);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].category, "quick");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
