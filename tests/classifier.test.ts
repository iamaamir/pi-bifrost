import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categoryLabel,
  classificationPrompt,
  extractCategory,
} from "../classifier.ts";

describe("classifier", () => {
  describe("categoryLabel", () => {
    it("returns category name unchanged", () => {
      assert.equal(categoryLabel("frontier"), "frontier");
      assert.equal(categoryLabel("economical"), "economical");
      assert.equal(categoryLabel("local"), "local");
    });
  });

  describe("classificationPrompt", () => {
    it("lists categories by name", () => {
      const prompt = classificationPrompt(["frontier", "economical"], "hello");
      assert.ok(prompt.includes("frontier, economical"));
      assert.ok(prompt.includes("Request: hello"));
    });
  });

  describe("extractCategory", () => {
    it("extracts exact category name", () => {
      assert.equal(extractCategory("frontier", ["frontier", "economical"]), "frontier");
    });

    it("is case-insensitive", () => {
      assert.equal(extractCategory("Frontier", ["frontier", "economical"]), "frontier");
    });

    it("handles surrounding whitespace", () => {
      assert.equal(extractCategory("  economical  ", ["frontier", "economical"]), "economical");
    });

    it("returns undefined for non-matching text", () => {
      assert.equal(extractCategory("unknown", ["frontier", "economical"]), undefined);
    });

    it("does not substring match", () => {
      // "not economical" should not match "economical"
      assert.equal(extractCategory("not economical", ["frontier", "economical"]), undefined);
    });
  });
});
