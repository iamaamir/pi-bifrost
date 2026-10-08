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

  it("allows an optional bounded total classifier timeout without a default", () => {
    const schema = readJson("schema.json") as {
      definitions?: { ClassifierConfig?: { properties?: { totalTimeoutMs?: { type?: string; minimum?: number; maximum?: number; default?: number } } } };
    };
    const timeout = schema.definitions?.ClassifierConfig?.properties?.totalTimeoutMs;
    assert.equal(timeout?.type, "integer");
    assert.equal(timeout?.minimum, 1);
    assert.equal(timeout?.maximum, 60_000);
    assert.equal(timeout?.default, undefined);
  });

  it("requires schemaVersion 2 for reliability state versions without forcing reliability on", () => {
    const schema = readJson("schema.json") as { allOf?: Array<{ if?: unknown; then?: unknown }> };
    const gate = schema.allOf?.find((item) => {
      const condition = item.if as { properties?: { reliability?: { required?: string[] } }; required?: string[] } | undefined;
      return condition?.required?.includes("reliability") && condition.properties?.reliability?.required?.includes("stateVersion");
    });
    const then = gate?.then as { required?: string[]; properties?: { schemaVersion?: { const?: number }; reliability?: { properties?: { enabled?: { const?: boolean } } } } } | undefined;
    assert.deepEqual(then?.required, ["schemaVersion"]);
    assert.equal(then?.properties?.schemaVersion?.const, 2);
    assert.equal(then?.properties?.reliability?.properties?.enabled?.const, undefined);
  });

  it("requires schemaVersion 2 for economics and only permits static non-authoritative scopes", () => {
    const schema = readJson("schema.json") as Record<string, unknown>;
    const allOf = schema.allOf as Array<{ if?: { required?: string[] }; then?: { required?: string[]; properties?: { schemaVersion?: { const?: number } } } }>;
    const definitions = schema.definitions as {
      EconomicsConfig?: {
        properties?: {
          sources?: { items?: { properties?: { authority?: { enum?: string[] } } } };
          scopes?: { additionalProperties?: { oneOf?: Array<{ properties?: { kind?: { const?: string } } }> } };
          preference?: { type?: string; additionalProperties?: boolean; required?: string[]; properties?: { billingClass?: { enum?: string[] } } };
        };
      };
    };
    const gate = allOf.find((item) => item.if?.required?.includes("economics"));
    assert.deepEqual(gate?.then?.required, ["schemaVersion"]);
    assert.equal(gate?.then?.properties?.schemaVersion?.const, 2);
    assert.deepEqual(definitions.EconomicsConfig?.properties?.sources?.items?.properties?.authority?.enum, ["declared", "estimated"]);
    assert.deepEqual(definitions.EconomicsConfig?.properties?.scopes?.additionalProperties?.oneOf?.map((item) => item.properties?.kind?.const), ["model", "provider"]);
    assert.deepEqual(definitions.EconomicsConfig?.properties?.preference?.properties?.billingClass?.enum, ["subscription", "metered", "free"]);
  });

  it("gates explicit affinity overrides behind schemaVersion 2 without claiming one surface default", () => {
    const schema = readJson("schema.json") as Record<string, unknown>;
    const allOf = schema.allOf as Array<{ if?: { required?: string[] }; then?: { required?: string[]; properties?: { schemaVersion?: { const?: number } } } }>;
    const affinity = schema.definitions as { AffinityConfig?: { additionalProperties?: boolean; required?: string[]; properties?: { mode?: { enum?: string[]; default?: string }; providerAdvisory?: { type?: string } } } };
    const gate = allOf.find((item) => item.if?.required?.includes("affinity"));
    assert.deepEqual(gate?.then?.required, ["schemaVersion"]);
    assert.equal(gate?.then?.properties?.schemaVersion?.const, 2);
    assert.equal(affinity.AffinityConfig?.additionalProperties, false);
    assert.deepEqual(affinity.AffinityConfig?.properties?.mode?.enum, ["off", "observe", "retain-within-tier"]);
    assert.equal(affinity.AffinityConfig?.properties?.mode?.default, undefined);
    assert.equal(affinity.AffinityConfig?.properties?.providerAdvisory?.type, "boolean");
  });

  it("allows explicit reliability v1 without schemaVersion 2 and gates only v2", () => {
    const schema = readJson("schema.json") as Record<string, unknown>;
    const definition = (schema.definitions as { ReliabilityConfig?: { properties?: { stateVersion?: { enum?: number[] } } } }).ReliabilityConfig;
    assert.deepEqual(definition?.properties?.stateVersion?.enum, [1, 2]);
    const allOf = schema.allOf as Array<{ if?: { properties?: { reliability?: { properties?: { stateVersion?: { const?: number } } } } }; then?: { properties?: { schemaVersion?: { const?: number } } } }>;
    assert.ok(allOf.some((item) => item.if?.properties?.reliability?.properties?.stateVersion?.const === 2
      && item.then?.properties?.schemaVersion?.const === 2));
  });

  it("documents the default-on, model-only allowance cooldown and explicit opt-out", () => {
    const schema = readJson("schema.json") as {
      definitions?: { ReliabilityConfig?: { properties?: { cooldownOnAllowanceExhausted?: { type?: string; default?: unknown; description?: string } } } };
    };
    const property = schema.definitions?.ReliabilityConfig?.properties?.cooldownOnAllowanceExhausted;
    assert.equal(property?.type, "boolean");
    assert.equal(property?.default, true);
    assert.match(String(property?.description), /model-only/);
    assert.match(String(property?.description), /Generic HTTP 429/);
  });

  it("keeps checked-in examples parseable", () => {
    for (const path of [
      "bifrost.json",
      "examples/economical-frontier.json",
      "examples/economical-frontier-reliability.json",
      "examples/large-context.json",
      "examples/economic-reserve-observe.json",
      "examples/economic-billing-preference.json",
      "examples/reliability-v2-auto.json",
    ]) {
      assert.doesNotThrow(() => readJson(path), path);
    }
  });
});
