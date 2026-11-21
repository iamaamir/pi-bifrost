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

/**
 * Text where a link is real: fenced code and HTML comments are inert on GitHub.
 *
 * A line scanner, not chained replacements. Removing a comment with one regex
 * lets a second removal re-form a marker inside the result, and a fence without a
 * closing marker leaves its contents scanned as prose. GitHub renders both as
 * inert, so the checker must too.
 */
function prose(markdown) {
  const lines = [];
  const comment = { open: false };
  let fence = null;
  for (const line of markdown.split(/\r?\n/u)) {
    // A fenced body is literal text, so a comment marker inside it is not a
    // comment and a comment cannot hide the closing fence.
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    // A comment hides everything up to `-->`, including a fence opener.
    const text = stripComments(line, comment);
    if (text === null) continue;
    const opened = /^\s*(`{3,}|~{3,})/u.exec(text);
    if (opened) {
      fence = opened[1];
      continue;
    }
    lines.push(text);
  }
  return lines.join("\n");
}

/** Whether a line ends a fence: only the opener's marker, at least as long as the opener. */
function closesFence(line, fence) {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && [...trimmed].every((char) => char === fence[0]);
}

/** A line without its comments, or null when the line ends inside a comment. */
function stripComments(text, comment) {
  let rest = text;
  if (comment.open) {
    const end = rest.indexOf("-->");
    if (end === -1) return null;
    rest = rest.slice(end + 3);
    comment.open = false;
  }
  for (;;) {
    const start = rest.indexOf("<!--");
    if (start === -1) return rest;
    const end = rest.indexOf("-->", start + 4);
    if (end === -1) {
      comment.open = true;
      return rest.slice(0, start);
    }
    rest = rest.slice(0, start) + rest.slice(end + 3);
  }
}

/** A link target as a repository-relative path, or null when it leaves the repository. */
function resolveTarget(file, path) {
  if (path === "") return file;
  const resolved =
    path.startsWith("/") ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(posix.dirname(file), path));
  return resolved.startsWith("..") ? null : resolved;
}

/** Inline HTML removed in one pass, so a tag cannot re-form inside the result. */
function stripInlineHtml(text) {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      if (end !== -1) {
        index = end;
        continue;
      }
    }
    result += text[index];
  }
  return result;
}

/** GitHub's heading slug: lowercase, punctuation removed, spaces to hyphens. */
function slugify(heading) {
  return stripInlineHtml(heading)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    // GitHub replaces each space with one hyphen and does not collapse runs, so
    // removing punctuation between two spaces leaves a double hyphen.
    .replace(/\s/gu, "-");
}

/**
 * Every anchor GitHub generates for a document, with duplicate suffixes.
 *
 * The suffix keeps counting until the candidate is unused, so headings `A`, `A`,
 * and `A-1` produce `a`, `a-1`, and `a-1-1`. Counting occurrences of the base slug
 * alone made the third heading collide with the second.
 */
function anchors(markdown) {
  const result = new Set();
  for (const line of prose(markdown).split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (!heading) continue;
    const base = slugify(heading[1]);
    let candidate = base;
    for (let suffix = 1; result.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
    result.add(candidate);
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
      // A leading slash is repository-root absolute on GitHub, not relative to
      // the linking document's directory.
      const resolved = resolveTarget(file, path);
      if (resolved === null) {
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
  const rooted = linkProblems({
    documents: ["docs/a.md"],
    read: () => "[readme](/README.md)\n",
    exists: (file) => file === "README.md",
    isDirectory: () => false,
  });
  assert.deepEqual(rooted, [], "a leading slash resolves from the repository root");

  // Fenced content and comments are inert on GitHub, even when unterminated.
  const inert = linkProblems({
    documents: ["docs/a.md"],
    read: () => "[live](b.md)\n```\n[gone](missing.md)\n```\n<!-- [also gone](missing.md) -->\n```\n[still gone](missing.md)\n",
    exists: (file) => file === "docs/b.md",
    isDirectory: () => false,
  });
  assert.deepEqual(inert, [], "links in fences and comments are not checked");

  // A fence opener inside an open comment must not hide what follows the `-->`.
  const commentedFence = linkProblems({
    documents: ["docs/a.md"],
    read: () => "<!--\n~~~\n-->\n\n[broken](missing.md)\n",
    exists: () => false,
    isDirectory: () => false,
  });
  assert.deepEqual(
    commentedFence,
    ["docs/a.md: missing.md does not exist"],
    "a fence opener inside an HTML comment is inert",
  );

  const mixedCloser = linkProblems({
    documents: ["docs/a.md"],
    read: () => "~~~\n~~~`\n[inside](missing.md)\n~~~~\n[live](b.md)\n",
    exists: (file) => file === "docs/b.md",
    isDirectory: () => false,
  });
  assert.deepEqual(mixedCloser, [], "a closer must use the opener's marker character");

  assert.deepEqual(anchors("# Hello, World!\n## `check:complexity` gate\n"), new Set(["hello-world", "checkcomplexity-gate"]));
  assert.deepEqual(anchors("# [linked](x.md) heading\n"), new Set(["linked-heading"]));
  assert.deepEqual(
    anchors("## A\n## A\n## A-1\n"),
    new Set(["a", "a-1", "a-1-1"]),
    "a generated anchor is taken, so the next candidate needs a second suffix",
  );
  assert.deepEqual(anchors("## <em>tagged</em> heading\n"), new Set(["tagged-heading"]));
  assert.deepEqual(relativeLinks("[a](x.md) [b](https://e.com/x) [c](#local) ![i](img.png)\n"), ["x.md", "#local", "img.png"]);
});
