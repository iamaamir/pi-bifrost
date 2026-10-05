import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BIFROST_COMMAND_OPTIONS } from "../commands.ts";

const demo = readFileSync(new URL("../docs/terminal-demo.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");

// The site is static: keep its command picker aligned with Pi's real command menu.
test("landing command picker lists every canonical Pi Bifrost command in registry order", () => {
  const table = demo.match(/const commands = \[([\s\S]*?)\n  \];/)?.[1];
  assert.ok(table, "command picker table exists");
  const entries = [...table.matchAll(/^\s*\["([^"]+)", "[^"]+", "([^"]+)", "[^"]+"\],?$/gm)];
  assert.deepEqual(entries.map((entry) => entry[1]), BIFROST_COMMAND_OPTIONS.map((command) => command.value));
  const chapters = new Set([...page.matchAll(/data-demo-scene="([^"]+)"/g)].map((match) => match[1]));
  assert.ok(entries.every((entry) => chapters.has(entry[2])), "every command has a matching chapter");
});
