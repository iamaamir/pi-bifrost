// Packaging and discovery coverage for the configure-bifrost skill.
// The skill must ship with the published package, be discoverable from its
// description, stay within the documented structure, and keep the limitations
// that the tool depends on.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { BIFROST_CONFIG_TOOL_NAME } from "../config-agent.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillDir = join(root, "skills", "configure-bifrost");
const skillPath = join(skillDir, "SKILL.md");

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

interface Frontmatter {
  readonly fields: Record<string, string>;
  readonly body: string;
  readonly raw: string;
}

function parseFrontmatter(text: string): Frontmatter {
  assert.ok(text.startsWith("---\n"), "SKILL.md must start with frontmatter");
  const end = text.indexOf("\n---\n", 3);
  assert.ok(end > 0, "SKILL.md frontmatter must be closed");
  const block = text.slice(4, end);
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of block.split("\n")) {
    const match = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (match) {
      key = match[1]!;
      fields[key] = match[2]!.trim();
      continue;
    }
    if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  return { fields, body: text.slice(end + 5), raw: block };
}

function packageJson(): {
  files?: string[];
  pi?: { extensions?: string[]; skills?: string[]; minPiVersion?: string };
} {
  return JSON.parse(read(join(root, "package.json"))) as ReturnType<typeof packageJson>;
}

describe("configure-bifrost skill packaging", () => {
  it("ships a discoverable skill with valid frontmatter", () => {
    assert.ok(existsSync(skillPath), "the skill must live at skills/configure-bifrost/SKILL.md");
    const { fields } = parseFrontmatter(read(skillPath));
    assert.equal(fields.name, "configure-bifrost", "the declared name must match the directory");
    assert.ok(fields.description, "the description decides when the skill loads");
    assert.ok((fields.description ?? "").length <= 1024, "descriptions are capped at 1024 characters");
    assert.equal(fields["disable-model-invocation"], undefined, "the skill must stay model-invocable");

    // The description has to carry the requests users actually type.
    const description = fields.description!.toLowerCase();
    for (const phrase of [
      "bifrost", "routing", "tiers", "available models", "cost", "quality",
      "multi-agent", "subscription", "workflow", "routing config",
    ]) {
      assert.match(description, new RegExp(phrase), `description is missing "${phrase}"`);
    }
  });

  it("is included in the published package", () => {
    const manifest = packageJson();
    assert.ok(manifest.pi?.skills?.includes("./skills/configure-bifrost"), "pi.skills must declare the skill directory");
    assert.ok((manifest.files ?? []).some((entry) => entry === "skills/" || entry.startsWith("skills")), "files must include the skill directory");
    assert.deepEqual(manifest.pi?.extensions, ["./index.ts"], "the tool and the skill ship from the same package");

    for (const declared of manifest.pi?.skills ?? []) {
      const path = join(root, declared);
      assert.equal(statSync(path).isDirectory(), true, `${declared} must resolve to a directory`);
      assert.ok(existsSync(join(path, "SKILL.md")), `${declared} must contain SKILL.md`);
    }
  });

  it("resolves every bundled reference relative to the skill directory", () => {
    const { body } = parseFrontmatter(read(skillPath));
    const links = [...body.matchAll(/\]\((?!https?:)([^)]+)\)/g)].map((match) => match[1]!);
    assert.ok(links.length > 0, "the skill should point at its reference material");
    for (const link of links) {
      const target = join(skillDir, link.split("#")[0]!);
      assert.ok(existsSync(target), `${link} does not exist inside the skill directory`);
    }
    // Docs are outside the published tarball, so the skill must not depend on them.
    assert.doesNotMatch(body, /\]\(\.\.\/\.\.\/docs\//, "the skill must not link to unpublished docs");
  });

  it("names the tool and the safety gates the agent must use", () => {
    const text = read(skillPath);
    for (const required of [
      BIFROST_CONFIG_TOOL_NAME,
      "operation\":\"inspect",
      "proposalDigest",
      "sourceDigest",
      "effectiveDigest",
      "catalogDigest",
      "stale",
    ]) {
      assert.ok(text.includes(required), `the skill must mention ${required}`);
    }
    assert.match(text, /Never apply without the user's agreement/);
    assert.match(text, /Do not retry `apply` after a `stale` result/);
  });

  it("states the limitations the tool reports", () => {
    const skill = read(skillPath);
    const reference = read(join(skillDir, "references", "configuration-reference.md"));
    for (const claim of [
      /no spending cap|not a budget/i,
      /prompt cache/i,
      /no guaranteed savings|does not prove savings/i,
      /inline tier prefix|first word/i,
    ]) {
      assert.match(`${skill}\n${reference}`, claim);
    }
    // A negated statement is fine; a promise is not.
    for (const forbidden of [
      /guarantees? savings/i,
      /guarantees? cost (reduction|savings)/i,
      /guarantees? cache (reuse|hits)/i,
      /enforces? a (spend|budget|spending) cap/i,
      /optimal (configuration|policy|routing)/i,
    ]) {
      assert.doesNotMatch(`${skill}\n${reference}`, forbidden);
    }
  });

  it("keeps the always-loaded description short and the detail in the body", () => {
    const { fields, body } = parseFrontmatter(read(skillPath));
    assert.ok((fields.description?.length ?? 0) < 700, "keep the discovered description lean");
    assert.ok(body.length > (fields.description?.length ?? 0) * 5, "detailed guidance belongs in the body");
    assert.ok(body.split("\n").length > 40, "the body carries the workflow the agent follows");
  });
});

describe("bifrost_config tool registration", () => {
  it("registers the agent tool alongside the extension", () => {
    const registered: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => { registered.push(tool.name); },
      registerVirtualModel: () => {},
      registerCommand: () => {},
      on: () => () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      registerMarkdownTransformer: () => {},
      registerToolRenderer: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    } as unknown as ExtensionAPI;
    const cwd = process.cwd();
    try {
      process.chdir(join(root));
      bifrostExtension(pi);
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(registered, [BIFROST_CONFIG_TOOL_NAME]);
  });
});

describe("repository skill layout", () => {
  it("keeps skill directories under the packaged root", () => {
    assert.equal(relative(root, skillDir), join("skills", "configure-bifrost"));
    assert.ok(existsSync(join(skillDir, "references", "configuration-reference.md")));
  });
});
