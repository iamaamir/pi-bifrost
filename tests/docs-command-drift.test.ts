import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BIFROST_COMMAND_OPTIONS } from "../commands.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Commands documented in the reference table of docs/guide/commands.md. */
function documentedCommands(): Set<string> {
  const md = readFileSync(join(ROOT, "docs", "guide", "commands.md"), "utf8");
  const lines = md.split("\n");
  // Anchor both ends on table headers rather than row numbers, so prose
  // inserted above the table cannot silently shift the parse.
  const start = lines.findIndex((line) => line.startsWith("| Command |"));
  assert.notEqual(start, -1, "docs/guide/commands.md: command table header not found");
  // Asserted first so `i > start` is never evaluated against a start of -1.
  // Scoped to the first table: the command rows sit above a second table
  // whose header line starts with "| Control".
  const end = lines.findIndex((line, i) => i > start && line.startsWith("| Control"));
  assert.notEqual(end, -1, "docs/guide/commands.md: following table not found, parse would scan the whole file");
  const table = lines.slice(start, end);
  const commands = new Set<string>();
  for (const line of table) {
    if (!line.startsWith("| `/bifrost")) continue;
    const value = line
      .split("|")[1]
      .trim()
      .replace(/^`\/bifrost ?/, "")
      .replace(/ ?<[^>]*>`$/, "")
      .replace(/`$/, "")
      .trim();
    // The bare `/bifrost` row is the dashboard, not a subcommand.
    if (value) commands.add(value);
  }
  return commands;
}

describe("docs command drift", () => {
  it("documents exactly the commands the registry defines", () => {
    const documented = documentedCommands();
    const registered = new Set(BIFROST_COMMAND_OPTIONS.map((command) => command.value));

    const undocumented = [...registered].filter((v) => !documented.has(v)).sort();
    const unknown = [...documented].filter((v) => !registered.has(v)).sort();

    assert.equal(
      documented.size,
      registered.size,
      `documented ${documented.size} commands but the registry defines ${registered.size}; a count mismatch usually means the parse found the wrong rows`,
    );
    assert.deepEqual(
      undocumented,
      [],
      `commands missing from docs/guide/commands.md:\n${undocumented.join("\n")}`,
    );
    assert.deepEqual(
      unknown,
      [],
      `commands documented but not in the registry:\n${unknown.join("\n")}`,
    );
  });
});
