// The guide map is the only record of each page's Diátaxis form. A new page
// can appear with no form, or a page can change job while the map keeps the
// old one. This test treats the map as the index and fails when it and
// docs/guide disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDE = "docs/guide";
const FORMS = ["Tutorial", "How-to", "Reference", "Explanation"];
const MAP_HEADING = /^## Guide map\s*$/u;

function guidePages(files) {
  return files
    .filter((name) => name.endsWith(".md") && name !== "STYLE.md")
    .map((name) => `${GUIDE}/${name}`)
    .sort();
}

/** The map table rows, or null when the section is absent. */
function mapRows(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => MAP_HEADING.test(line));
  if (start === -1) return null;
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/u.test(line)) break;
    const match = /^\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/u.exec(line);
    if (match) {
      rows.push({ target: match[1].trim(), form: match[2].trim(), task: match[3].trim() });
    }
  }
  return rows;
}

/** Every disagreement between the guide pages and the guide map. */
function mapProblems({ pages, markdown }) {
  const rows = mapRows(markdown);
  if (rows === null) return [`${GUIDE}/index.md: missing "## Guide map"`];
  const problems = [];
  const seen = new Set();
  for (const row of rows) {
    const file = `${GUIDE}/${row.target}`;
    if (!pages.includes(file)) {
      problems.push(`${GUIDE}/index.md: ${row.target} is not a guide page`);
    }
    if (seen.has(file)) {
      problems.push(`${GUIDE}/index.md: ${row.target} has more than one form`);
    }
    seen.add(file);
    if (!FORMS.includes(row.form)) {
      problems.push(`${GUIDE}/index.md: ${row.target} uses unknown form ${JSON.stringify(row.form)}`);
    }
    if (row.task === "") {
      problems.push(`${GUIDE}/index.md: ${row.target} has no reader task`);
    }
  }
  for (const page of pages) {
    if (!seen.has(page)) {
      problems.push(`${GUIDE}/index.md: ${page.slice(GUIDE.length + 1)} is missing from the guide map`);
    }
  }
  return problems;
}

test("every guide page has one valid form in the guide map", () => {
  const pages = guidePages(readdirSync(join(ROOT, GUIDE)));
  assert.equal(pages.length > 5, true, `expected the guide pages, found ${pages.length}`);
  assert.deepEqual(
    mapProblems({ pages, markdown: readFileSync(join(ROOT, GUIDE, "index.md"), "utf8") }),
    [],
  );
});

test("fault control: a missing page, a duplicate, a bad form, and a missing map are reported", () => {
  const pages = [`${GUIDE}/index.md`, `${GUIDE}/task.md`];
  const markdown = [
    "## Guide map",
    "",
    "| Page | Form | Reader task |",
    "| --- | --- | --- |",
    "| [Index](index.md) | Explanation | Find a page |",
    "| [Task](task.md) | How-to | Do the task |",
    "",
  ].join("\n");
  assert.deepEqual(mapProblems({ pages, markdown }), []);

  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to | Do the task |", "") }),
    [`${GUIDE}/index.md: task.md is missing from the guide map`],
  );
  assert.deepEqual(
    mapProblems({ pages: [...pages, `${GUIDE}/extra.md`], markdown }),
    [`${GUIDE}/index.md: extra.md is missing from the guide map`],
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to |", "| [Task](task.md) | Tutorial |") }),
    [],
    "another valid form is accepted",
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to |", "| [Task](task.md) | Policy |") }),
    [`${GUIDE}/index.md: task.md uses unknown form "Policy"`],
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to | Do the task |", "| [Task](task.md) | How-to | Do the task |\n| [Task again](task.md) | Reference | Look it up |") }),
    [`${GUIDE}/index.md: task.md has more than one form`],
  );
  assert.deepEqual(mapProblems({ pages, markdown: "# Guide\n" }), [`${GUIDE}/index.md: missing "## Guide map"`]);
});
