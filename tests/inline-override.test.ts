import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInlineOverride } from "../inline-override.ts";

const models: Record<string, string[]> = {
  frontier: ["model1"],
  economical: ["model2"],
};

describe("inline tier override", () => {
  it("matches frontier as first word", () => {
    const r = parseInlineOverride("frontier debug this", models);
    assert.equal(r.forcedTier, "frontier");
    assert.equal(r.promptText, "debug this");
  });

  it("matches economical as first word", () => {
    const r = parseInlineOverride("economical summarize this", models);
    assert.equal(r.forcedTier, "economical");
    assert.equal(r.promptText, "summarize this");
  });

  it("is case-insensitive", () => {
    const r = parseInlineOverride("FRONTIER debug", models);
    assert.equal(r.forcedTier, "frontier");
    assert.equal(r.promptText, "debug");
  });

  it("strips only the first word and trailing whitespace", () => {
    const r = parseInlineOverride("frontier debug extra", models);
    assert.equal(r.forcedTier, "frontier");
    assert.equal(r.promptText, "debug extra");
  });

  it("returns no tier for unknown first word", () => {
    const r = parseInlineOverride("unknown debug", models);
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "unknown debug");
  });

  it("returns no tier when no space after word", () => {
    const r = parseInlineOverride("frontier", models);
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "frontier");
  });

  it("returns no tier for empty string", () => {
    const r = parseInlineOverride("", models);
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "");
  });

  it("ignores tier name in middle of prompt", () => {
    const r = parseInlineOverride("please frontier this", models);
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "please frontier this");
  });

  it("returns no tier when models is undefined", () => {
    const r = parseInlineOverride("frontier debug", undefined);
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "frontier debug");
  });

  it("returns no tier when models is empty", () => {
    const r = parseInlineOverride("frontier debug", {});
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "frontier debug");
  });
});
