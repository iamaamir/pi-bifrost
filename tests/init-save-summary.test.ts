import { it } from "node:test";
import assert from "node:assert/strict";
import { initClassifierSummary, initSavePreviewLines, initSaveSummary } from "../ui/init-save-summary.ts";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

it("summarizes unique membership changes while counting duplicate saved entries", () => {
  const summary = initSaveSummary(bytes({ models: { old: ["a", "a"], keep: ["x"] }, gone: true }),
    bytes({ models: { keep: ["x", "y", "y", 3], new: "z" }, added: true }), new Set(["x"]));
  assert.deepEqual(summary, {
    modelTiers: "Model tiers  keep 4 (+1) · new 1 (+1) · old 0 (-1)",
    fieldsAdded: ["added"], fieldsChanged: ["models", "gone"], unverifiedSavedCount: 3,
  });
});

it("renders conditional preview lines exactly", () => {
  const summary = initSaveSummary(null, bytes({ models: { fast: "a" } }), new Set());
  assert.deepEqual(initSavePreviewLines({ sourceLabel: "project", workingCount: 1, ranProbe: false, probeAge: "2h",
    summary, receiptOnly: true, classifier: "off", inheritedLines: ["Also uses    global (~/.pi)"], uncategorizedCount: 2 }), [
    "Bifrost · ready to save", "Save to      project", "Models       1 working model found · cached 2h ago",
    "Model tiers  fast 1 (+1)", "Setup        model-management information will be saved", "Fields added   models",
    "Classifier  off", "Also uses    global (~/.pi)", "Uncategorized  2",
    "Uncategorized models stay out of generated pools.",
    "1 saved model tier entries were not verified by this check; handwritten entries are preserved.",
  ]);
  assert.deepEqual(initSavePreviewLines({ sourceLabel: "global", workingCount: 0, ranProbe: true, probeAge: "",
    summary: initSaveSummary(null, bytes({}), new Set()), receiptOnly: false, classifier: "off", inheritedLines: [], uncategorizedCount: 0 }), [
    "Bifrost · ready to save", "Save to      global", "Models       0 working models found", "Classifier  off",
  ]);
});

it("preserves classifier fallback and configured display", () => {
  assert.equal(initClassifierSummary(true, { backend: "prompt", auto: true }, undefined, undefined), "prompt (no eligible model; regex fallback)");
  assert.equal(initClassifierSummary(true, { backend: "prompt", auto: false }, ["a", "b"], undefined), "prompt (a,b, configured)");
});

it("ignores v3 model description metadata while retaining legacy description tiers", () => {
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  const v3 = initSaveSummary(null, bytes({ schemaVersion: 3, models: { description: "notes", general: ["p/m"] } }), new Set(["p/m"]));
  assert.doesNotMatch(v3.modelTiers, /description/);
  const legacy = initSaveSummary(null, bytes({ schemaVersion: 2, models: { description: "p/m" } }), new Set(["p/m"]));
  assert.match(legacy.modelTiers, /description 1/);
});
