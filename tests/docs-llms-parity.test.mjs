// docs/llms.txt is a second index of the guide for LLM readers. It has no
// build step, so a new guide page can be absent from it and a removed page can
// leave a stale link. This test checks canonical page-link coverage in the
// Links section; it does not claim semantic agreement between the two files.
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

const GUIDE_URL_PREFIX = "https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/";

/**
 * Guide pages linked from the `## Links` section, plus non-canonical URLs, or
 * null when the section is absent. A filename match alone would accept a link
 * to another host, repository, or branch, so the destination is part of the
 * contract.
 */
function linkedPages(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^## Links\s*$/u.test(line));
  if (start === -1) return null;
  const pages = [];
  const problems = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    const entry = /^\s*-\s+[^:]+:\s+(\S+)\s*$/u.exec(line);
    if (!entry) continue;
    const target = entry[1];
    // The Links section also names the project site, repository, and package.
    // Only a guide destination has to be canonical.
    if (!target.includes("/docs/guide/")) continue;
    if (!target.startsWith(GUIDE_URL_PREFIX)) {
      problems.push(`${LLMS}: ${target} is not a canonical guide URL`);
      continue;
    }
    const page = /^([^/?#\s]+\.md)$/u.exec(target.slice(GUIDE_URL_PREFIX.length));
    if (page) pages.push(`${GUIDE}/${page[1]}`);
    else problems.push(`${LLMS}: ${target} is not a canonical guide URL`);
  }
  return { pages, problems };
}

/** Every disagreement between the guide pages and the llms.txt Links section. */
function parityProblems({ pages, markdown }) {
  const linked = linkedPages(markdown);
  if (linked === null) return [`${LLMS}: missing "## Links"`];
  const problems = [...linked.problems];
  const seen = new Set();
  for (const page of linked.pages) {
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
    "- Guide: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/index.md",
    "- Task: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md",
    "",
    "## Other",
    "",
  ].join("\n");
  assert.deepEqual(parityProblems({ pages, markdown }), []);

  assert.deepEqual(
    parityProblems({ pages, markdown: markdown.replace("- Task: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md\n", "") }),
    [`${LLMS}: task.md is missing from Links`],
  );
  assert.deepEqual(
    parityProblems({ pages: [...pages, `${GUIDE}/extra.md`], markdown }),
    [`${LLMS}: extra.md is missing from Links`],
  );
  const duplicate = markdown.replace(
    "\n## Other",
    "\n- Task again: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md\n\n## Other",
  );
  assert.deepEqual(
    parityProblems({ pages, markdown: duplicate }),
    [`${LLMS}: links to ${GUIDE}/task.md more than once`],
  );
  const unknown = markdown.replace(
    "\n## Other",
    "\n- Gone: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/gone.md\n\n## Other",
  );
  assert.deepEqual(
    parityProblems({ pages, markdown: unknown }),
    [`${LLMS}: links to ${GUIDE}/gone.md, which is not a guide page`],
  );
  for (const hostile of [
    "https://example.invalid/docs/guide/task.md",
    "https://github.com/someone/pi-bifrost/blob/main/docs/guide/task.md",
    "https://github.com/iamaamir/pi-bifrost/blob/next/docs/guide/task.md",
  ]) {
    const problems = parityProblems({
      pages,
      markdown: markdown.replace("https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md", hostile),
    });
    assert.equal(
      problems.includes(`${LLMS}: ${hostile} is not a canonical guide URL`),
      true,
      "a filename match must not accept another host, repository, or branch",
    );
  }
  for (const suffix of ["?raw=1", "#usage"]) {
    const hostile = `https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md${suffix}`;
    const problems = parityProblems({
      pages,
      markdown: markdown.replace("https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md", hostile),
    });
    assert.equal(
      problems.includes(`${LLMS}: ${hostile} is not a canonical guide URL`),
      true,
      "a query string or fragment is not a canonical page link",
    );
  }
  const missingTask = markdown.replace("- Task: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md\n", "");
  assert.deepEqual(
    parityProblems({
      pages,
      markdown: missingTask.replace(
        "\n## Other",
        "\n# Later section\n\n- Task: https://github.com/iamaamir/pi-bifrost/blob/main/docs/guide/task.md\n\n## Other",
      ),
    }),
    [`${LLMS}: task.md is missing from Links`],
    "a canonical link under a level-one heading cannot close the Links section",
  );
  assert.deepEqual(parityProblems({ pages, markdown: "# Docs\n" }), [`${LLMS}: missing "## Links"`]);
});
