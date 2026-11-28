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
// The guide index is navigation, not one of the four forms. It may declare this
// narrow hybrid label; no substantive page may use it to escape classification.
const HYBRID = "Navigational (hybrid)";
const HYBRID_PAGES = new Set([`${GUIDE}/index.md`]);
const MAP_HEADING = /^## Guide map\s*$/u;

function guidePages(files) {
  return files
    .filter((name) => name.endsWith(".md") && name !== "STYLE.md")
    .map((name) => `${GUIDE}/${name}`)
    .sort();
}

const TABLE_HEADER = /^\|\s*Page\s*\|\s*Form\s*\|\s*Reader task\s*\|\s*$/u;
const TABLE_SEPARATOR = /^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/u;

/**
 * The map table rows and malformed table rows, or null when the section is
 * absent. A row-shaped line inside the table that does not parse is a finding,
 * not a line to skip: otherwise a valid row followed by a malformed duplicate
 * can hide the duplicate and pass. Rows after the table closes belong to
 * another table and must not satisfy this one's coverage.
 */
function mapRows(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => MAP_HEADING.test(line));
  if (start === -1) return null;
  const rows = [];
  const malformed = [];
  let headerSeen = false;
  let separatorSeen = false;
  let tableClosed = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    const row = line.trim();
    if (!row.startsWith("|")) {
      // A blank line ends a Markdown table just as prose does. Once the table
      // has begun, any non-table line before the separator also breaks its
      // required adjacency, so no later row can supply map coverage.
      if (headerSeen || separatorSeen) tableClosed = true;
      continue;
    }
    if (tableClosed) continue;
    if (!headerSeen) {
      if (TABLE_HEADER.test(row)) headerSeen = true;
      else malformed.push(row);
      continue;
    }
    if (!separatorSeen) {
      if (TABLE_SEPARATOR.test(row)) separatorSeen = true;
      else malformed.push(row);
      continue;
    }
    const match = /^\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/u.exec(row);
    if (match) {
      rows.push({ target: match[1].trim(), form: match[2].trim(), task: match[3].trim() });
    } else {
      malformed.push(row);
    }
  }
  return { rows, malformed };
}

/** Every disagreement between the guide pages and the guide map. */
function mapProblems({ pages, markdown }) {
  const parsed = mapRows(markdown);
  if (parsed === null) return [`${GUIDE}/index.md: missing "## Guide map"`];
  const { rows, malformed } = parsed;
  const problems = malformed.map((line) => `${GUIDE}/index.md: malformed guide map row ${JSON.stringify(line)}`);
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
    const hybridAllowed = HYBRID_PAGES.has(file) && row.form === HYBRID;
    if (!FORMS.includes(row.form) && !hybridAllowed) {
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
    mapProblems({ pages, markdown: markdown.replace("| [Index](index.md) | Explanation |", "| [Index](index.md) | Navigational (hybrid) |") }),
    [],
    "the guide index may declare the narrow hybrid form",
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to |", "| [Task](task.md) | Navigational (hybrid) |") }),
    [`${GUIDE}/index.md: task.md uses unknown form "Navigational (hybrid)"`],
    "the hybrid label must not become a general escape",
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to |", "| [Task](task.md) | Policy |") }),
    [`${GUIDE}/index.md: task.md uses unknown form "Policy"`],
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to | Do the task |", "| [Task](task.md) | How-to | Do the task |\n| [Task again](task.md) | Reference | Look it up |") }),
    [`${GUIDE}/index.md: task.md has more than one form`],
  );
  const malformedDuplicate = markdown.replace(
    "| [Task](task.md) | How-to | Do the task |",
    "| [Task](task.md) | How-to | Do the task |\n| [Task again](task.md) | How-to |",
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: malformedDuplicate }),
    [`${GUIDE}/index.md: malformed guide map row ${JSON.stringify("| [Task again](task.md) | How-to |")}`],
    "a malformed duplicate must not be skipped",
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace("| [Task](task.md) | How-to | Do the task |", "| [Task](task.md) | How-to |  |") }),
    [`${GUIDE}/index.md: task.md has no reader task`],
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: `${markdown}| [Gone](gone.md) | Reference | Look it up |\n` }),
    [`${GUIDE}/index.md: gone.md is not a guide page`],
  );
  const withoutHeader = markdown.replace("| Page | Form | Reader task |\n| --- | --- | --- |\n", "");
  const headerProblems = mapProblems({ pages, markdown: withoutHeader });
  assert.equal(headerProblems.some((problem) => problem.includes("malformed guide map row")), true,
    "a table without the declared header cannot supply the map");
  const badSeparator = markdown.replace("| --- | --- | --- |", "| --- | --- |");
  const separatorProblems = mapProblems({ pages, markdown: badSeparator });
  assert.equal(separatorProblems.some((problem) => problem.includes('malformed guide map row "| --- | --- |"')), true,
    "a header without a valid adjacent separator cannot supply the map");
  const missingTask = markdown.replace("| [Task](task.md) | How-to | Do the task |\n", "");
  for (const [suffix, control] of [
    ["\nSome later prose\n\n| [Task](task.md) | How-to | Do the task |\n", "a row outside the table"],
    ["# Later section\n\n| [Task](task.md) | How-to | Do the task |\n", "a row under a level-one heading"],
  ]) {
    assert.deepEqual(
      mapProblems({ pages, markdown: missingTask.concat(suffix) }),
      [`${GUIDE}/index.md: task.md is missing from the guide map`],
      `${control} must not satisfy map coverage`,
    );
  }
  assert.deepEqual(mapProblems({ pages, markdown: "# Guide\n" }), [`${GUIDE}/index.md: missing "## Guide map"`]);
});

test("fault control: a blank line ends the table and the separator must be adjacent to the header", () => {
  const pages = [`${GUIDE}/index.md`, `${GUIDE}/task.md`];
  const taskRow = "| [Task](task.md) | How-to | Do the task |";
  const markdown = [
    "## Guide map",
    "",
    "| Page | Form | Reader task |",
    "| --- | --- | --- |",
    "| [Index](index.md) | Explanation | Find a page |",
    taskRow,
    "",
  ].join("\n");
  const missingTask = [`${GUIDE}/index.md: task.md is missing from the guide map`];
  const uncovered = [
    `${GUIDE}/index.md: index.md is missing from the guide map`,
    `${GUIDE}/index.md: task.md is missing from the guide map`,
  ];

  assert.deepEqual(
    mapProblems({ pages, markdown }),
    [],
    "the baseline table still supplies full coverage",
  );
  assert.deepEqual(
    mapProblems({ pages, markdown: markdown.replace(`${taskRow}\n`, "").concat("\n", taskRow, "\n") }),
    missingTask,
    "a page row after a blank line following the table must not restore coverage",
  );
  for (const [insert, control] of [
    ["\n", "a blank line"],
    ["\nSome prose", "intervening prose"],
  ]) {
    const broken = markdown.replace("| Page | Form | Reader task |", `| Page | Form | Reader task |${insert}`);
    assert.deepEqual(
      mapProblems({ pages, markdown: broken }),
      uncovered,
      `${control} between the header and separator must break the table`,
    );
  }
});
