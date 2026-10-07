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

  it("requires schemaVersion 2 whenever tierPolicies is present", () => {
    const schema = readJson("schema.json") as {
      allOf?: Array<{
        if?: { required?: string[] };
        then?: { required?: string[]; properties?: { schemaVersion?: { const?: number } } };
      }>;
    };
    const gate = schema.allOf?.find((item) => item.if?.required?.includes("tierPolicies"));
    assert.deepEqual(gate?.then?.required, ["schemaVersion"]);
    assert.equal(gate?.then?.properties?.schemaVersion?.const, 2);
  });

  it("requires schemaVersion 2 for economics and only permits static non-authoritative scopes", () => {
    const schema = readJson("schema.json") as Record<string, unknown>;
    const allOf = schema.allOf as Array<{ if?: { required?: string[] }; then?: { required?: string[]; properties?: { schemaVersion?: { const?: number } } } }>;
    const definitions = schema.definitions as {
      EconomicsConfig?: {
        properties?: {
          sources?: { items?: { properties?: { authority?: { enum?: string[] } } } };
          scopes?: { additionalProperties?: { oneOf?: Array<{ properties?: { kind?: { const?: string } } }> } };
        };
      };
    };
    const gate = allOf.find((item) => item.if?.required?.includes("economics"));
    assert.deepEqual(gate?.then?.required, ["schemaVersion"]);
    assert.equal(gate?.then?.properties?.schemaVersion?.const, 2);
    assert.deepEqual(definitions.EconomicsConfig?.properties?.sources?.items?.properties?.authority?.enum, ["declared", "estimated"]);
    assert.deepEqual(definitions.EconomicsConfig?.properties?.scopes?.additionalProperties?.oneOf?.map((item) => item.properties?.kind?.const), ["model", "provider"]);
  });

  it("keeps checked-in examples parseable", () => {
    for (const path of [
      "bifrost.json",
      "examples/economical-frontier.json",
      "examples/economical-frontier-reliability.json",
      "examples/large-context.json",
      "examples/economic-reserve-observe.json",
    ]) {
      assert.doesNotThrow(() => readJson(path), path);
    }
  });
});
