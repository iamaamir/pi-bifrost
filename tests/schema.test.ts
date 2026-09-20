import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const root = new URL("../", import.meta.url);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, root), "utf8"));
}

describe("shipped JSON artifacts", () => {
  it("has a parseable configuration schema", () => {
    const schema = readJson("schema.json");
    assert.ok(schema !== null && typeof schema === "object");
    assert.ok(schema !== null && typeof schema === "object" && "$schema" in schema);
  });

  it("keeps checked-in examples parseable", () => {
    for (const path of [
      "bifrost.json",
      "examples/economical-frontier.json",
      "examples/economical-frontier-reliability.json",
      "examples/large-context.json",
    ]) {
      assert.doesNotThrow(() => readJson(path), path);
    }
  });
});
