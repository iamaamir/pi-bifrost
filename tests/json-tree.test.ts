import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonTreeRow } from "../ui/json-tree.ts";

test("JSON tree preserves nested values and escapes terminal controls without mutation", () => {
  const value = { $schema: "kept", items: ["\u001b[31m\u009b", null, {}, []] };
  const before = structuredClone(value);
  const row = jsonTreeRow("JSON", value, "json");
  assert.equal(row.children?.[0]?.label, '"$schema": "kept"');
  assert.match(row.children?.[1]?.children?.[0]?.label ?? "", /\\u001b\[31m\\u009b/);
  assert.equal(row.children?.[1]?.children?.[1]?.label, "1: null");
  assert.deepEqual(value, before);
});

test("JSON tree includes unknown keys and nested arrays", () => {
  const row = jsonTreeRow("Config", { futureOption: [[{ unexpected: false }]] }, "config");
  assert.equal(row.children?.[0]?.label, '"futureOption": […]');
  assert.equal(row.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.label, '"unexpected": false');
});

test("JSON tree follows JSON serialization for sparse arrays and non-finite values", () => {
  const row = jsonTreeRow("value", { items: [undefined, NaN, Infinity], omitted: undefined }, "value");
  assert.equal(row.children?.length, 1);
  assert.deepEqual(row.children?.[0]?.children?.map((child) => child.label), ["0: null", "1: null", "2: null"]);
  assert.throws(() => jsonTreeRow("value", undefined, "value"), /JSON-serializable/);
});
