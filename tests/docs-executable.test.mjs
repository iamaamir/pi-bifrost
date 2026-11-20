// Documentation that names a command reads as a promise that the command
// exists. A renamed script or a removed flag breaks the promise and no test
// notices, because prose is not compiled. These checks resolve every command
// the documents show back to package.json and to the script source, then run
// the two cheapest documented invocations for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ROOT_DOCUMENTS = ["README.md", "AGENTS.md", "PRODUCT.md", "ROADMAP.md", "DEVELOPMENT.md", "CONTEXT.md"];

function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

const DOCUMENTS = [
  ...markdownFiles("docs"),
  ...ROOT_DOCUMENTS.filter((name) => existsSync(join(ROOT, name))),
].map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

/** The shell commands a document shows, one entry per line, continuations joined. */
function shellCommands(markdown) {
  const commands = [];
  for (const block of markdown.matchAll(/```(?:bash|sh)\r?\n([\s\S]*?)```/gu)) {
    const joined = block[1].replace(/\\\r?\n/gu, " ");
    for (const line of joined.split(/\r?\n/u)) {
      const command = line.trim().replace(/\s+/gu, " ");
      if (command === "" || command.startsWith("#") || command.startsWith("$ ")) continue;
      commands.push(command);
    }
  }
  return commands;
}

/**
 * Command examples outside a fenced block: inline code spans, and the table cells
 * they usually sit in.
 *
 * A script renamed in a table row is the same broken promise as one renamed in a
 * block, and the fenced-only scan stayed green while this guide's own
 * `npm run check:complexity:base` row went stale. Only spans that name a command
 * count, so ordinary inline code is not treated as one.
 */
function inlineCommands(markdown) {
  const commands = [];
  for (const span of markdown.matchAll(/`([^`\n]+)`/gu)) {
    const text = span[1].trim().replace(/\s+/gu, " ");
    if (/^(?:npm run|node)(?:\s|$)/u.test(text)) commands.push(text);
  }
  return commands;
}

/** Every command example in a document, fenced or inline, without duplicates. */
function documentCommands(markdown) {
  return [...new Set([...shellCommands(markdown), ...inlineCommands(markdown)])];
}

/** The long options a command line passes, without the `--` separator itself. */
function commandFlags(command) {
  return [...command.matchAll(/(?:^|\s)(--[a-z][\w-]*)/gu)].map((match) => match[1]);
}

/**
 * Every disagreement between a documented command and the code it names.
 * `read` and `exists` are injected so a control can run against in-memory text.
 */
function commandProblems({ documents, scripts, read = (file) => readFileSync(join(ROOT, file), "utf8"), exists = (file) => existsSync(join(ROOT, file)) }) {
  const problems = [];
  for (const document of documents) {
    for (const command of documentCommands(document.text)) {
      const npm = /npm run ([\w:-]+)/u.exec(command);
      const direct = /node\s+(?:--[\w-]+\s+)*(scripts\/[\w.-]+)/u.exec(command);
      let target = null;
      if (npm) {
        if (!Object.hasOwn(scripts, npm[1])) {
          problems.push(`${document.file}: documents an unknown npm script, ${npm[1]}`);
          continue;
        }
        target = /scripts\/[\w.-]+/u.exec(scripts[npm[1]])?.[0] ?? null;
      } else if (direct) {
        target = direct[1];
      }
      if (target === null) continue;
      if (!exists(target)) {
        problems.push(`${document.file}: names ${target}, which does not exist`);
        continue;
      }
      const source = read(target);
      // Flags before a direct script path are node's own. Only the tail after
      // the path belongs to the script's argument parser.
      const argumentsTail = npm ? command : command.slice(command.indexOf(target) + target.length);
      for (const flag of commandFlags(argumentsTail)) {
        if (!source.includes(flag)) {
          problems.push(`${document.file}: ${target} does not accept ${flag}`);
        }
      }
    }
  }
  return problems;
}

test("every npm script, script path, and flag named in the documents exists", () => {
  assert.equal(DOCUMENTS.length > 50, true, `expected the document set, found ${DOCUMENTS.length} files`);
  assert.deepEqual(commandProblems({ documents: DOCUMENTS, scripts: MANIFEST.scripts }), []);
});

test("fault control: a renamed script, a removed flag, and a missing file are reported", () => {
  const scripts = { "check:demo": "node scripts/demo.mjs" };
  const read = () => "const argv = process.argv.slice(2);\nif (argv.includes(\"--json\")) {}\n";
  const exists = (file) => file === "scripts/demo.mjs";
  const documents = [
    { file: "guide.md", text: "```bash\nnpm run check:demo -- --json\nnpm run check:gone\nnode scripts/absent.mjs --json\n```\n" },
  ];
  assert.deepEqual(commandProblems({ documents, scripts, read, exists }), [
    "guide.md: documents an unknown npm script, check:gone",
    "guide.md: names scripts/absent.mjs, which does not exist",
  ]);

  const removedFlag = [{ file: "guide.md", text: "```bash\nnode scripts/demo.mjs --json --base-line\n```\n" }];
  assert.deepEqual(commandProblems({ documents: removedFlag, scripts, read, exists }), [
    "guide.md: scripts/demo.mjs does not accept --base-line",
  ]);

  // A table cell and a sentence hide a command the same way a block does.
  const inline = [
    { file: "guide.md", text: "| `npm run check:gone` | rename |\n\nRun `node scripts/absent.mjs --json` from the root.\n" },
  ];
  assert.deepEqual(commandProblems({ documents: inline, scripts, read, exists }), [
    "guide.md: documents an unknown npm script, check:gone",
    "guide.md: names scripts/absent.mjs, which does not exist",
  ]);
  const inlineFlag = [{ file: "guide.md", text: "Use `npm run check:demo -- --removed-flag` for it.\n" }];
  assert.deepEqual(commandProblems({ documents: inlineFlag, scripts, read, exists }), [
    "guide.md: scripts/demo.mjs does not accept --removed-flag",
  ]);
  assert.deepEqual(inlineCommands("plain `code` and `npm test` are not script references"), []);

  assert.deepEqual(shellCommands("```bash\nnpm run check:demo \\\n  --json\n```\n"), ["npm run check:demo --json"]);
  assert.deepEqual(commandFlags("npm run check:demo -- --json --root tree"), ["--json", "--root"]);
});

test("the documented structured-output invocation runs and keeps its envelope", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-complexity.mjs"), "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.check, "complexity");
  assert.equal(envelope.status, "passed");
  assert.equal(envelope.exitCode, 0);
});

test("the documented toolbox entry point prints its usage", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "toolbox.mjs"), "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^Usage: node scripts\/toolbox\.mjs <check>/mu);
  assert.match(result.stdout, /Exit codes: 0 clean, 1 findings, 2 unavailable tool or invalid invocation\./u);
});

test("the document set covers the guide and every reference document", () => {
  const files = DOCUMENTS.map((document) => document.file);
  for (const required of ["docs/dev-tooling.md", "docs/guide/commands.md", "AGENTS.md", "README.md"]) {
    assert.equal(files.includes(required), true, `${required} must be in the document set`);
  }
  assert.equal(files.some((file) => relative(ROOT, join(ROOT, file)).startsWith("..")), false);
});
