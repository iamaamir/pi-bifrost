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
  // First table only: the command rows sit above the second table, whose
  // header line starts with "| Control".
  const end = lines.findIndex((line, i) => i > 6 && line.startsWith("| Control"));
  const table = lines.slice(6, end === -1 ? undefined : end);
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
