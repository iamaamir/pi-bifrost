// A relative link or a heading anchor is a reference by name, and a rename
// breaks it without any build failure. These checks resolve every relative
// link in the documentation set against the file system, and every `#anchor`
// against the headings of the file it points at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT_DOCUMENTS = ["README.md", "AGENTS.md", "PRODUCT.md", "ROADMAP.md", "DEVELOPMENT.md", "CONTEXT.md", "CHANGELOG.md"];

function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

const DOCUMENTS = [...markdownFiles("docs"), ...ROOT_DOCUMENTS.filter((name) => existsSync(join(ROOT, name)))];

/** Text outside fenced code blocks and HTML comments, where links are inert. */
function prose(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^```[\s\S]*?^```/gmu, "")
    .replace(/^~~~[\s\S]*?^~~~/gmu, "");
}

/** GitHub's heading slug: lowercase, punctuation removed, spaces to hyphens. */
function slugify(heading) {
  return heading
    .replace(/<[^>]*>/gu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    // GitHub replaces each space with one hyphen and does not collapse runs, so
    // removing punctuation between two spaces leaves a double hyphen.
    .replace(/\s/gu, "-");
}

/** Every anchor GitHub generates for a document, with duplicate suffixes. */
function anchors(markdown) {
  const seen = new Map();
  const result = new Set();
  for (const line of prose(markdown).split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (!heading) continue;
    const base = slugify(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

/** The relative targets of every markdown link in the document. */
function relativeLinks(markdown) {
  const links = [];
  for (const match of prose(markdown).matchAll(/!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/gu)) {
    const target = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target) === false && !target.startsWith("#")) links.push(target);
    else if (target.startsWith("#")) links.push(target);
  }
  return links;
}

/**
 * Every broken relative link or anchor. `read` and `exists` are injected so a
 * control can run against in-memory documents.
 */
function linkProblems({ documents, read = (file) => readFileSync(join(ROOT, file), "utf8"), exists = (file) => existsSync(join(ROOT, file)), isDirectory = (file) => statSync(join(ROOT, file)).isDirectory() }) {
  const problems = [];
  const anchorCache = new Map();
  for (const file of documents) {
    const markdown = read(file);
    for (const target of relativeLinks(markdown)) {
      const [rawPath, rawAnchor] = target.split("#", 2);
      const path = decodeURIComponent(rawPath);
      const anchor = rawAnchor === undefined ? undefined : decodeURIComponent(rawAnchor);
      const resolved = path === "" ? file : posix.normalize(posix.join(posix.dirname(file), path));
      if (resolved.startsWith("..")) {
        problems.push(`${file}: ${target} leaves the repository`);
        continue;
      }
      if (!exists(resolved)) {
        problems.push(`${file}: ${target} does not exist`);
        continue;
      }
      if (anchor === undefined || anchor === "" || !resolved.endsWith(".md")) continue;
      if (isDirectory(resolved)) continue;
      if (!anchorCache.has(resolved)) anchorCache.set(resolved, anchors(read(resolved)));
      if (!anchorCache.get(resolved).has(anchor)) {
        problems.push(`${file}: ${target} names a heading that does not exist`);
      }
    }
  }
  return problems;
}

test("every relative link and heading anchor in the documents resolves", () => {
  assert.equal(DOCUMENTS.length > 50, true, `expected the document set, found ${DOCUMENTS.length}`);
  assert.deepEqual(linkProblems({ documents: DOCUMENTS }), []);
});

test("a document outside the set still resolves its links through the same rules", () => {
  assert.equal(DOCUMENTS.some((file) => relative(ROOT, join(ROOT, file)).startsWith("..")), false);
});

test("fault control: a missing file, a renamed heading, and an escaped path are reported", () => {
  const documents = new Map([
    ["docs/a.md", "# Title\n\nSee [the guide](b.md#wrong-heading) and [gone](missing.md).\n"],
    ["docs/b.md", "# Real Heading\n\n## Real Heading\n"],
  ]);
  const read = (file) => documents.get(file) ?? "";
  const exists = (file) => documents.has(file) || file === "docs";
  assert.deepEqual(linkProblems({ documents: [...documents.keys()], read, exists, isDirectory: () => false }), [
    "docs/a.md: b.md#wrong-heading names a heading that does not exist",
    "docs/a.md: missing.md does not exist",
  ]);

  const duplicate = linkProblems({
    documents: ["docs/b.md", "docs/c.md"],
    read: (file) => (file === "docs/b.md" ? "## Real Heading\n## Real Heading\n" : "[second](b.md#real-heading-1)\n"),
    exists: () => true,
    isDirectory: () => false,
  });
  assert.deepEqual(duplicate, [], "a duplicate heading gets the -1 suffix GitHub generates");

  const escape = linkProblems({ documents: ["docs/a.md"], read: () => "[out](../../etc/passwd)\n", exists: () => true, isDirectory: () => false });
  assert.deepEqual(escape, ["docs/a.md: ../../etc/passwd leaves the repository"]);

  assert.deepEqual(anchors("# Hello, World!\n## `check:complexity` gate\n"), new Set(["hello-world", "checkcomplexity-gate"]));
  assert.deepEqual(anchors("# [linked](x.md) heading\n"), new Set(["linked-heading"]));
  assert.deepEqual(relativeLinks("[a](x.md) [b](https://e.com/x) [c](#local) ![i](img.png)\n"), ["x.md", "#local", "img.png"]);
});
