import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/complexity-gate.yml", import.meta.url), "utf8");

test("the trusted complexity gate runs from the protected base and measures the PR as data", () => {
  assert.match(workflow, /^on:\n(?: {2}#[^\n]*\n)* {2}pull_request_target:/mu);
  assert.match(workflow, /pull_request_target:\n {4}branches: \[main\]/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head/u);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/merge/u);
  assert.match(workflow, /--is-ancestor "\$base_sha" "\$merge_sha"/u);
  assert.match(workflow, /--is-ancestor "\$event_head_sha" "\$merge_sha"/u);
  assert.doesNotMatch(workflow, /pull_request\.head\.ref/u, "the candidate branch must not choose the judge");
  assert.equal((workflow.match(/npm ci/gu) ?? []).length, 1, "dependencies must be installed only for the protected judge");
});

test("the trusted gate checks both the PR delta and the proposed merge result", () => {
  assert.match(workflow, /--target "\$MERGE_BASE" --candidate "\$HEAD_SHA"/u);
  assert.match(workflow, /--target "\$BASE_SHA" --candidate "\$MERGE_SHA"/u);
  assert.match(workflow, /complexity-evidence\/delta\.json/u);
  assert.match(workflow, /complexity-evidence\/merge\.json/u);
  assert.doesNotMatch(workflow, /--allow-policy-change/u, "a candidate label must not authorize its own policy");
});

test("the trusted gate publishes replayable evidence from the resolved revisions", () => {
  assert.match(workflow, /BASE_SHA=\$base_sha/u);
  assert.match(workflow, /HEAD_SHA=\$event_head_sha/u);
  assert.match(workflow, /MERGE_SHA=\$merge_sha/u);
  assert.match(workflow, /MERGE_BASE=\$merge_base/u);
  assert.match(workflow, /name: complexity-evidence-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/complexity-evidence/u);
  assert.match(workflow, /permissions:\n {2}contents: read/u);
});
