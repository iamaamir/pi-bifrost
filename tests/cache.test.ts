import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  lookupCache,
  touchCacheEntry,
  findCachedCategory,
  updateCache,
  cachePath,
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
      process.env.HOME = "/home/user";
      assert.equal(cachePath("/project", "~/cache.jsonl"), "/home/user/cache.jsonl");
    });

    it("joins relative path to cwd", () => {
      assert.equal(cachePath("/project", "cache.jsonl"), "/project/cache.jsonl");
    });
  });
});
