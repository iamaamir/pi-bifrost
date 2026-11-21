# Config-Agent Preview Input Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the offline config-agent preview state which supplied prompts it did not evaluate and which it shortened, without changing any limit.

**Architecture:** Count supplied, considered, skipped and truncated prompts inside `previewConfigCandidate()`'s existing case loop, then append up to two coverage notes to the result's existing `notes` array. The report renderer already prints every note as `note: ${note}` and preserves digest tail lines when bounding, so nothing downstream changes. No new result field, no schema change, no config setting.

**Tech Stack:** TypeScript, Node test runner (`node --test --experimental-strip-types`), TypeBox tool schema (unchanged).

**Spec:** https://github.com/iamaamir/pi-bifrost/issues/261 plus "Design decisions" below.

## Global Constraints

- `MAX_PROMPTS = 8` and `MAX_PROMPT_CHARS = 2_000` stay exactly as they are (`config-agent.ts:49-50`).
- No new config setting, no `bifrost.json` change, no tool-schema change.
- Notes only. No new result field and no structured coverage object.
- Never echo prompt text in a note. Counts, positions and the fixed limit only.
- A preview with nothing dropped or shortened emits no new coverage notes. Existing note text stays unchanged.
- Coverage notes must remain visible in the model/user-facing report even when `renderPreview()` hits the 120-line bound; digests stay in the preserved tail.
- Delivery base after merge is current `main` tip; re-check line numbers on the delivery branch before editing. The constants/loop shape were verified on this worktree at `config-agent.ts:49-50,1568-1627`.

## Design decisions (agreed with the maintainer)

- Keep the existing limits; this change is visibility only.
- Notes-only, because the calling agent and the human both read the report, and `cases` already lists every evaluated prompt.
- Counts and positions only. No prompt text, no per-prompt lengths.
- Report only what actually happened; a clean preview says nothing.
- The code slices to the first 8 before skipping blanks, so a blank entry inside the first 8 consumes a slot. Keep that order and word the note accurately.
- Truncation is recorded only after the blank/non-string checks, because only evaluated prompts have a computed route. An overlong blank/whitespace prompt is skipped, not reported as truncated.
- Prompt evaluation uses `raw.slice(0, MAX_PROMPT_CHARS)` then `trim().length === 0` as today; do not scan raw strings beyond `.length` and that slice. If the inspected prefix is blank and `raw.length > MAX_PROMPT_CHARS`, record it as a blank-inspected-prefix case without scanning the uninspected tail; this is a bounded diagnostic and can include an overlong all-whitespace prompt. Coverage notes do not echo prompt text; representative prompt rows in the report still show the evaluated prompt slice as before.
- Truncation positions are 1-based positions in the considered first-8 window (`index + 1` over `consideredPrompts.entries()`), i.e. countable supplied slots, not prompt text.
- `renderPreview()` appends `note: ...` lines before `boundedWithTail(lines, tail)`. `boundedWithTail` preserves only `tail`; a large case list can drop late notes. To satisfy #261's "never silently assert..." acceptance without changing the 120-line cap, move preview notes into the preserved tail (notes first, then digests, then separator) and keep digest lines present.
- The `resolved.status !== "completed"` branch stays untouched: preview passes no abort signal and router resolve returns only `completed` or `aborted` (`router.ts:85-95,682-730`); preview already continues on non-completed.
- Out of scope, recorded as follow-ups: schema-level `maxItems`/`maxLength` rejection for oversized payloads, tool description/schema hint for prompt bounds, and the 80-character display cut in `renderPreview` (belongs with #268).

## Trace / Adversarial Focus

Full path traced:

- `previewConfigCandidate()` (`config-agent.ts:1482-1627`) builds preview cases offline. It slices prompts to `MAX_PROMPTS`, skips non-string/blank-after-trim entries, slices each evaluated prompt to `MAX_PROMPT_CHARS`, resolves through `router.resolve({ prompt, random: () => 0 })`, pushes cases, then appends existing notes and returns `{ ...base, status: "ok", cases, tiers, routing, notes }`.
- The config-agent tool (`createBifrostConfigTool`, wired in `index.ts:67,87`) returns `content: [{type:"text", text: deps.render(result) + handleNote}]` and `details: result`.
- `reportText()` dispatches preview to `renderPreview()` (`config-agent-report.ts:199-266`). `renderPreview` currently prints `note: ${note}` for every note before `boundedWithTail(lines, tail)`. `boundedWithTail` (`config-agent-report.ts:39-43`, `MAX_REPORT_LINES=120`) preserves only `tail` (digests + separator). Concrete counterexample: 150 detail lines + 2 coverage notes + 5 digest-tail lines => output drops both coverage notes while keeping digests. That violates #261's "never silently assert..." requirement in the model/user-facing report.
- Fix: in `renderPreview`, remove notes from body and build `tail` as `[...noteLines, ...digestLines(...), separator]`. This preserves digests and guarantees coverage notes remain visible. Existing preview tests do not assert note ordering relative to digests except by text presence.
- Existing tests in `tests/config-agent.test.ts:1555-1748` already cover preview determinism/offline behavior; the harness `run()` goes through the real tool, so `contentOf(result)` is the user/model-visible report path.

Adversarial cases to keep honest:

- **Single multi-megabyte prompt:** only `.length` and `slice(0, 2_000)` run; note must not copy, echo, or scan prompt text beyond that. No `trim()` on raw mega-string.
- **Exactly 2,000 UTF-16 code units:** `raw.length > MAX_PROMPT_CHARS` is false; no truncation note. (JS `.length/slice` use UTF-16 code units; this matches existing `MAX_PROMPT_CHARS` behavior.)
- **Overlong blank/whitespace prompt (e.g. 2,500 spaces):** sliced prompt trims empty, so it is skipped, not evaluated, and must not emit a truncation note. Do not trim raw input.
- **Prompt whose first 2,000 chars are whitespace but char 2,001+ is non-whitespace:** it was not evaluated because the inspected prefix was blank. Report it as a blank-inspected-prefix case: "blank or not text (N was/were blank in the first 2,000 characters inspected)". Because the check is bounded (no tail scan), an overlong all-whitespace prompt is reported the same way; do not scan the whole raw string. Coverage notes must not echo prompt text.
- **Blank/non-string/sparse entries inside first 8:** consume considered slots; count as skipped, never evaluated. `typeof raw !== "string"` covers `undefined`, numbers, objects, arrays, null.
- **More than 8 prompts:** note names supplied count; considered window is first 8 only. Prompt 9+ is never evaluated and never gets a truncation note.
- **All 8 considered entries skipped in an over-limit request:** report considered/skipped/0 evaluated. No truncation note.
- **8 or fewer supplied with skipped entries:** report skipped count; do not claim limit reached.
- **Over-limit plus truncation:** emit both notes. Truncation positions are 1-based in considered window.
- **Empty/omitted prompts:** no coverage notes; existing notes unchanged.
- **Report bounding:** coverage notes and digests are in the preserved tail; detail lines can be truncated, but omission/truncation notices cannot disappear. Verify the final report length is exactly 120 lines (the truncation marker is counted inside `MAX_REPORT_LINES` by `boundedWithTail`).

## #261 acceptance mapping

Read from GitHub issue #261 (`audit(config-agent): expose sample-preview truncation and test limits without misleading results`, OPEN):

- **Demonstrate actual behavior with 0,8,9 and longer-than-2,000-char inputs (and malformed/empty cases); confirm ignored/truncated and whether missing previews are explained.** Covered by new tests + existing preview tests.
- **Specify bounded method for requesting more preview coverage or clearly documented fixed bound with truthful omission/truncation notices; user knows which samples evaluated and which not.** Fixed bound remains 8/2000; notes state considered/supplied/skipped/evaluated/truncated positions; docs state bound.
- **Never silently assert a preview is complete when only a subset/prefix was evaluated. Do not confuse deterministic/offline preview with live backend classification.** Coverage notes address subset/prefix; existing offline/classifier notes remain.
- **Preserve bounded latency/memory and no-network-by-default preview behavior; no unbounded batch size or sensitive prompt echo in diagnostics.** No limits changed; no raw scan; no prompt echo.
- **Test input/boundary behavior, output provenance, report integrity, and limits under config-agent check/preview/apply where relevant.** Tests go through tool harness (real render path); add report-bounding assertion; check/apply unaffected because no schema/writes.

---

### Task 1: Count prompt coverage and emit notes

**Files:**
- Modify: `config-agent.ts` case-loop preamble and notes block before preview return (currently around `config-agent.ts:1568-1626`; re-check on delivery branch).
- Modify: `config-agent-report.ts` `renderPreview()` tail construction (currently around `config-agent-report.ts:235-237`) so coverage notes survive 120-line bounding.
- Test: `tests/config-agent.test.ts` inside `describe("preview is offline, deterministic, and non-mutating")`, before its closing `});` (currently around `tests/config-agent.test.ts:1748`).

**Interfaces:**
- Consumes: existing `ConfigAgentPreviewResult.notes: readonly string[]` and existing `threeRoleGoal` fixture.
- Produces: up to two note strings with exact wording asserted below. No exported signature/result-field changes.

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing preview `describe` block, after the last test in it:

```ts
  it("stays silent about prompt coverage when every supplied prompt was evaluated", async () => {
    const harness = freshHarness();
    try {
      const prompts = Array.from({ length: 8 }, (_, index) => `task ${index + 1}`);
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 8);
      assert.equal(details.notes.some((note) => /supplied prompts|exceeded|blank/.test(note)), false);

      const none = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts: [] }),
      );
      assert.deepEqual(none.cases, []);
      assert.equal(none.notes.some((note) => /supplied prompts|exceeded|blank/.test(note)), false);
    } finally {
      harness.cleanup();
    }
  });

  it("reports prompts beyond the evaluation limit", async () => {
    const harness = freshHarness();
    try {
      const prompts = Array.from({ length: 11 }, (_, index) => `task ${index + 1}`);
      const result = await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      assert.equal(details.cases.length, 8);
      assert.ok(details.notes.includes("preview considered the first 8 of 11 supplied prompts."));
      assert.match(contentOf(result), /note: preview considered the first 8 of 11 supplied prompts\./);
    } finally {
      harness.cleanup();
    }
  });

  it("reports skipped entries instead of counting them as evaluated", async () => {
    const harness = freshHarness();
    try {
      const prompts: unknown[] = ["task 1", "", "task 3", "   ", 42, "task 6", "task 7", "task 8", "task 9"];
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 5);
      assert.ok(details.notes.includes("preview considered the first 8 of 9 supplied prompts; 3 were blank or not text, so 5 were evaluated."));
    } finally {
      harness.cleanup();
    }
  });

  it("reports skipped entries when the prompt limit was not reached", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts: ["task 1", "", "task 3"] }),
      );
      assert.equal(details.cases.length, 2);
      assert.ok(details.notes.includes("preview skipped 1 of 3 supplied prompts as blank or not text, so 2 were evaluated."));
    } finally {
      harness.cleanup();
    }
  });

  it("reports when every considered prompt in an over-limit request was skipped", async () => {
    const harness = freshHarness();
    try {
      const prompts: unknown[] = ["", " ", 1, null, undefined, "\t", {}, [], "task 9"];
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 0);
      assert.ok(details.notes.includes("preview considered the first 8 of 9 supplied prompts; 8 were blank or not text, so 0 were evaluated."));
    } finally {
      harness.cleanup();
    }
  });

  it("distinguishes a blank input from a prompt whose inspected prefix was blank", async () => {
    const harness = freshHarness();
    try {
      const overlongBlankPrefix = " ".repeat(2_000) + "SENSITIVE-TAIL";
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({
          operation: "preview",
          candidate: threeRoleGoal,
          prompts: ["", overlongBlankPrefix, "task 3"],
        }),
      );
      assert.equal(details.cases.length, 1);
      assert.deepEqual(details.cases.map((c) => c.prompt), ["task 3"]);
      assert.ok(details.notes.includes("preview skipped 2 of 3 supplied prompts as blank or not text (1 was blank in the first 2,000 characters inspected), so 1 was evaluated."));
      assert.equal(details.notes.some((note) => /exceeded 2,000 characters/.test(note)), false);
      assert.ok(details.notes.every((note) => !note.includes("SENSITIVE-TAIL")));
    } finally {
      harness.cleanup();
    }
  });

  it("reports truncated prompts by position without echoing the tail", async () => {
    const harness = freshHarness();
    try {
      const long = `review ${"x".repeat(1_000_000)} SENSITIVE-TAIL`;
      const exact = "y".repeat(2_000);
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts: ["task 1", long, exact] }),
      );
      assert.equal(details.cases[1]?.prompt.length, 2_000);
      assert.ok(!details.cases[1]?.prompt.includes("SENSITIVE-TAIL"));
      assert.equal(details.cases[2]?.prompt.length, 2_000);
      assert.ok(details.notes.includes("prompt 2 exceeded 2,000 characters; each route was computed from the first 2,000 characters."));
      assert.ok(details.notes.every((note) => !note.includes("SENSITIVE-TAIL")));
    } finally {
      harness.cleanup();
    }
  });

  it("reports both limit overflow and truncation", async () => {
    const harness = freshHarness();
    try {
      const long = "x".repeat(2_001);
      const prompts = ["ok", long, ...Array.from({ length: 7 }, (_, i) => `task ${i + 3}`)];
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 8);
      assert.ok(details.notes.includes("preview considered the first 8 of 9 supplied prompts."));
      assert.ok(details.notes.includes("prompt 2 exceeded 2,000 characters; each route was computed from the first 2,000 characters."));
    } finally {
      harness.cleanup();
    }
  });

  it("keeps coverage notes and digests visible when preview report exceeds the 120-line bound", async () => {
    const harness = freshHarness();
    try {
      const prompts = Array.from({ length: 11 }, (_, i) => `task ${i + 1} ${"detail ".repeat(30)}`);
      prompts[1] = "x".repeat(2_001);
      const result = await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      const bigCase = {
        prompt: "x".repeat(200),
        decidedBy: "default_tier" as const,
        confidence: "deterministic" as const,
        tier: "implement",
        selectedTier: "implement",
        selected: "beta/code",
        excluded: Array.from({ length: 200 }, (_, i) => ({ model: `missing/model-${i}`, exclusion: "not_in_catalog" })),
        unavailable: Array.from({ length: 200 }, (_, i) => `missing/model-${i}`),
      };
      const synthetic: ConfigAgentPreviewResult = { ...details, cases: Array.from({ length: 8 }, () => bigCase) };
      const text = reportText(synthetic);
      const lines = text.split("\n");
      assert.match(text, /note: preview considered the first 8 of 11 supplied prompts\./);
      assert.match(text, /note: prompt 2 exceeded 2,000 characters; each route was computed from the first 2,000 characters\./);
      assert.match(text, /proposalDigest: [a-f0-9]{64}/);
      assert.match(text, /catalogDigest: [a-f0-9]{64}/);
      assert.equal(lines.length, 120, `report should respect 120-line bound, got ${lines.length}`);
      assert.ok(lines.some((line) => line.includes("more line(s)")), "expected report to be bounded in this fixture");
    } finally {
      harness.cleanup();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --experimental-strip-types tests/config-agent.test.ts`
Expected: FAIL on the new note-content assertions because no coverage note is produced yet. Silent/length/exact-2000/non-echo assertions may already pass.

- [ ] **Step 3: Replace the case-loop preamble**

Add coverage accounting around the existing prompt loop in `previewConfigCandidate()`. The implementation extracts small helpers (`createPreviewPromptCoverage`, `previewPromptFromRaw`, `previewDecidedBy`, `previewCaseConfidence`, `previewPromptCoverageNotes`) to keep complexity bounded; the behavior is equivalent to this logic:

```ts
const promptCoverage = createPreviewPromptCoverage(request.prompts ?? []);
for (const [index, raw] of promptCoverage.consideredPrompts.entries()) {
  if (typeof raw !== "string") { promptCoverage.skippedPrompts += 1; continue; }
  const inspectedPrompt = raw.slice(0, MAX_PROMPT_CHARS);
  if (inspectedPrompt.trim().length === 0) {
    promptCoverage.skippedPrompts += 1;
    // Bounded: no tail scan. A prompt longer than the inspected prefix may have
    // uninspected content after a blank inspected prefix.
    if (raw.length > MAX_PROMPT_CHARS) promptCoverage.blankInspectedPrefixPrompts += 1;
    continue;
  }
  if (raw.length > MAX_PROMPT_CHARS) promptCoverage.truncatedPromptPositions.push(index + 1);
  // evaluate inspectedPrompt...
}
```

Do not trim or otherwise scan `raw` beyond `.length` and the first-2000 slice.

- [ ] **Step 4: Append the coverage notes**

Immediately before `return { ...base, status: "ok", cases, tiers, routing, notes };`, after the existing `if (catalog.available.length === 0)` block, add:

```ts
notes.push(...previewPromptCoverageNotes(promptCoverage, cases.length));
```

`previewPromptCoverageNotes` emits no notes for clean previews. It reports:
- over limit: `preview considered the first 8 of N supplied prompts; ...` (and skipped/evaluated counts when any were skipped)
- skipped within limit: `preview skipped X of N supplied prompts as blank or not text..., so Y evaluated.`
- blank-inspected-prefix qualifier: `(N was/were blank in the first 2,000 characters inspected)` (bounded; can include an overlong all-whitespace prompt)
- truncation: `prompt(s) P... exceeded 2,000 characters; each route was computed from the first 2,000 characters.`

- [ ] **Step 4b: Preserve coverage notes in the bounded report**

In `config-agent-report.ts` `renderPreview()`, move notes into the preserved tail so they cannot be dropped by `boundedWithTail`:

Replace:

```ts
  for (const note of result.notes) lines.push(`note: ${note}`);
  const tail = [...digestLines(result.proposalDigest, result.guards), "-------------------------------------------"];
  return boundedWithTail(lines, tail).join("\n");
```

with:

```ts
  const noteLines = result.notes.map((note) => `note: ${note}`);
  const tail = [...noteLines, ...digestLines(result.proposalDigest, result.guards), "-------------------------------------------"];
  return boundedWithTail(lines, tail).join("\n");
```

This keeps digests visible (still in tail) and makes omission/truncation notices visible in the user/model-facing report under the existing 120-line cap.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --experimental-strip-types tests/config-agent.test.ts`
Expected: PASS, including the new tests and every existing config-agent test.

If the report-bounding test does not naturally exceed 120 lines with the chosen fixture, strengthen the fixture (more cases/detail lines) until it proves truncation while keeping the note/digest assertions. Do not weaken the assertion.

- [ ] **Step 6: Mutation-check the guards**

Comment out all three coverage `notes.push(...)` calls added in Step 4 and re-run `node --test --experimental-strip-types tests/config-agent.test.ts`. Expected: coverage note-content assertions fail; silent-preview/length/exact-2000/non-echo assertions still pass. Restore.

Then temporarily revert Step 4b (move notes back to body, before `boundedWithTail`) and re-run. Expected: the "keeps coverage notes visible when preview report exceeds the 120-line bound" test fails while digest assertions may still pass. Restore Step 4b and re-run green. Record failure counts/output as evidence.

- [ ] **Step 7: Run the repo checks**

Run: `npm run typecheck`
Run: `npm run test:quick`
Run: `npm test` (required before claiming completion for feature/regression changes; record if a narrower run was used for local iteration and why, but full suite should pass before completion.)
Expected: pass. Record exact commands and real output for PR evidence.

- [ ] **Step 8: Commit**

```bash
git add config-agent.ts tests/config-agent.test.ts
git commit -m "feat(config-agent): report preview prompt coverage"
```

---

### Task 2: Document the fixed preview bound

**Files:**
- Modify: `docs/guide/configuration.md` in the configuration-agent preview paragraph (currently around line 126).

- [ ] **Step 1: Add the sentence**

In the paragraph beginning "`inspect` reports sign-in state and `check` warns", insert before the final `See [ADR 0026]` sentence:

```text
Preview evaluates the first 8 prompts you supply and reads at most 2,000 characters of each. The result notes any prompt it skipped or shortened.
```

- [ ] **Step 2: Check the diff**

Run: `git diff --check`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/guide/configuration.md
git commit -m "docs(guide): state the preview prompt bound"
```
