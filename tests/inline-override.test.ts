import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("inline tier override", () => {
  const models: Record<string, string[]> = { frontier: ["model1"], economical: ["model2"] };

  function checkOverride(text: string) {
    const firstWord = text.match(/^([a-z]+)\s+/i);
    if (!firstWord) return { forcedTier: undefined, promptText: text };
    const candidate = firstWord[1].toLowerCase();
    if (models[candidate]) {
      return { forcedTier: candidate, promptText: text.slice(firstWord[0].length) };
    }
    return { forcedTier: undefined, promptText: text };
  }

  it("matches frontier as first word", () => {
    const r = checkOverride("frontier debug this");
    assert.equal(r.forcedTier, "frontier");
    assert.equal(r.promptText, "debug this");
  });

  it("matches economical as first word", () => {
    const r = checkOverride("economical summarize this");
    assert.equal(r.forcedTier, "economical");
    assert.equal(r.promptText, "summarize this");
  });

  it("is case-insensitive", () => {
    const r = checkOverride("FRONTIER debug");
    assert.equal(r.forcedTier, "frontier");
    assert.equal(r.promptText, "debug");
  });

  it("strips only the first word", () => {
    const r = checkOverride("frontier debug extra");
    assert.equal(r.forcedTier, "frontier");
    assert.equal(r.promptText, "debug extra");
  });

  it("returns no tier for unknown first word", () => {
    const r = checkOverride("unknown debug");
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "unknown debug");
  });

  it("returns no tier when no space after word", () => {
    const r = checkOverride("frontier");
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "frontier");
  });

  it("returns no tier for empty string", () => {
    const r = checkOverride("");
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "");
  });

  it("ignores tier prefix in middle of prompt", () => {
    const r = checkOverride("please frontier this");
    assert.equal(r.forcedTier, undefined);
    assert.equal(r.promptText, "please frontier this");
  });
});