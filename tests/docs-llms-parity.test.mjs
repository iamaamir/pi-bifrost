// docs/llms.txt is a second index of the guide for LLM readers. It has no
// build step, so a new guide page can be absent from it and a removed page can
// leave a stale link. This test keeps its Links section aligned with
// docs/guide/*.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDE = "docs/guide";
const LLMS = "docs/llms.txt";

function guidePages(files) {
  return files
    .filter((name) => name.endsWith(".md") && name !== "STYLE.md")
    .map((name) => `${GUIDE}/${name}`)
    .sort();
}

/** Guide pages linked from the `## Links` section, or null when it is absent. */
function linkedPages(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^## Links\s*$/u.test(line));
  if (start === -1) return null;
  const pages = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/u.test(line)) break;
    const entry = /^\s*-\s+[^:]+:\s+(\S+)\s*$/u.exec(line);
    if (!entry) continue;
    const target = /\/docs\/guide\/([^/?#\s]+\.md)(?:[?#]\S*)?$/u.exec(entry[1]);
    if (target) pages.push(`${GUIDE}/${target[1]}`);
  }
  return pages;
}

/** Every disagreement between the guide pages and the llms.txt Links section. */
function parityProblems({ pages, markdown }) {
  const linked = linkedPages(markdown);
  if (linked === null) return [`${LLMS}: missing "## Links"`];
  const problems = [];
  const seen = new Set();
  for (const page of linked) {
    if (!pages.includes(page)) {
      problems.push(`${LLMS}: links to ${page}, which is not a guide page`);
    }
    if (seen.has(page)) {
      problems.push(`${LLMS}: links to ${page} more than once`);
    }
    seen.add(page);
  }
  for (const page of pages) {
    if (!seen.has(page)) {
      problems.push(`${LLMS}: ${page.slice(GUIDE.length + 1)} is missing from Links`);
    }
  }
  return problems;
}

test("every guide page is linked exactly once from docs/llms.txt", () => {
  const pages = guidePages(readdirSync(join(ROOT, GUIDE)));
  assert.equal(pages.length > 5, true, `expected the guide pages, found ${pages.length}`);
  assert.deepEqual(
    parityProblems({ pages, markdown: readFileSync(join(ROOT, LLMS), "utf8") }),
    [],
  );
});

test("fault control: a missing page, a duplicate, an unknown page, and a missing section are reported", () => {
  const pages = [`${GUIDE}/index.md`, `${GUIDE}/task.md`];
  const markdown = [
    "# Docs",
    "",
    "## Links",
    "",
    "- Guide: https://github.com/example/project/blob/main/docs/guide/index.md",
    "- Task: https://github.com/example/project/blob/main/docs/guide/task.md",
    "",
    "## Other",
    "",
  ].join("\n");
  assert.deepEqual(parityProblems({ pages, markdown }), []);

  assert.deepEqual(
    parityProblems({ pages, markdown: markdown.replace("- Task: https://github.com/example/project/blob/main/docs/guide/task.md\n", "") }),
    [`${LLMS}: task.md is missing from Links`],
  );
  assert.deepEqual(
    parityProblems({ pages: [...pages, `${GUIDE}/extra.md`], markdown }),
    [`${LLMS}: extra.md is missing from Links`],
  );
  const duplicate = markdown.replace(
    "\n## Other",
    "\n- Task again: https://github.com/example/project/blob/main/docs/guide/task.md\n\n## Other",
  );
  assert.deepEqual(
    parityProblems({ pages, markdown: duplicate }),
    [`${LLMS}: links to ${GUIDE}/task.md more than once`],
  );
  const unknown = markdown.replace(
    "\n## Other",
    "\n- Gone: https://github.com/example/project/blob/main/docs/guide/gone.md\n\n## Other",
  );
  assert.deepEqual(
    parityProblems({ pages, markdown: unknown }),
    [`${LLMS}: links to ${GUIDE}/gone.md, which is not a guide page`],
  );
  assert.deepEqual(parityProblems({ pages, markdown: "# Docs\n" }), [`${LLMS}: missing "## Links"`]);
});
