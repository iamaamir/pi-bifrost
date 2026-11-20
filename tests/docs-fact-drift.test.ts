// Documentation quotes the configuration it describes. When the configuration
// moves first, the prose keeps the old number and still reads as fact. These
// assertions read the number from the source of truth, so a threshold change
// must edit every document that quotes it in the same change.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jscpd = JSON.parse(readFileSync(join(ROOT, ".jscpd.json"), "utf8"));

/** Documents that quote duplication settings, with the text under test. */
const DOCUMENTS = [
  { file: "docs/dev-tooling.md", text: readFileSync(join(ROOT, "docs", "dev-tooling.md"), "utf8") },
  {
    file: "docs/adr/0027-quality-gates.md",
    text: readFileSync(join(ROOT, "docs", "adr", "0027-quality-gates.md"), "utf8"),
  },
];

const SETTINGS = { minTokens: jscpd.minTokens, minLines: jscpd.minLines, threshold: jscpd.threshold };

/** Every disagreement between a document's duplication quotes and `.jscpd.json`. */
function duplicationDrift(document: { file: string; text: string }, settings = SETTINGS): string[] {
  const findings: string[] = [];
  for (const match of document.text.matchAll(/\bminTokens (\d+)|\bminLines (\d+)/gu)) {
    const label = match[1] !== undefined ? "minTokens" : "minLines";
    const quoted = Number(match[1] ?? match[2]);
    const expected = label === "minTokens" ? settings.minTokens : settings.minLines;
    if (quoted !== expected) {
      findings.push(`${document.file}: quotes \`${label} ${quoted}\` but .jscpd.json sets \`${label} ${expected}\``);
    }
  }
  for (const match of document.text.matchAll(/\bbudget (?:is )?(\d+(?:\.\d+)?)%/gu)) {
    const quoted = Number(match[1]);
    if (quoted !== settings.threshold) {
      findings.push(`${document.file}: quotes a ${quoted}% budget but .jscpd.json sets ${settings.threshold}%`);
    }
  }
  return findings;
}

/** How many duplication numbers a document quotes. Zero would pass vacuously. */
function duplicationQuoteCount(document: { text: string }): number {
  const settings = [...document.text.matchAll(/\bminTokens \d+|\bminLines \d+/gu)];
  const budget = [...document.text.matchAll(/\bbudget (?:is )?\d+(?:\.\d+)?%/gu)];
  return settings.length + budget.length;
}

describe("documented gate facts", () => {
  it("quotes the committed duplication settings in every document", () => {
    for (const document of DOCUMENTS) {
      assert.ok(
        duplicationQuoteCount(document) >= 2,
        `${document.file} must quote the duplication settings; a missing quote is not a pass`,
      );
      assert.deepEqual(duplicationDrift(document), []);
    }
  });

  it("turns red when a document keeps an old threshold or a setting", () => {
    const guide = DOCUMENTS[0];
    assert.notEqual(guide.text, guide.text.replace("budget 3.3%", "budget 3.4%"), "the threshold mutation must apply");
    const threshold = duplicationDrift({ ...guide, text: guide.text.replace(/budget \d+(?:\.\d+)?%/u, "budget 3.4%") });
    assert.equal(threshold.length, 1);
    assert.match(threshold[0], /3\.4% budget but \.jscpd\.json sets/u);

    const adr = DOCUMENTS[1];
    const setting = duplicationDrift({ ...adr, text: adr.text.replace(/`minLines \d+`/u, "`minLines 12`") });
    assert.equal(setting.length >= 1, true, "a stale setting quote must be reported");
    assert.match(setting[0], /minLines 12/u);

    assert.deepEqual(duplicationDrift({ file: "inline", text: "minTokens 50 and `minLines 10`, budget 3.3%" }), []);
    assert.deepEqual(duplicationQuoteCount({ text: "no numbers here" }), 0);
  });
});
