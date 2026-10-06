# Command Surface Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a script that prints the `/bifrost` command surface as a readable map, ordered and grouped exactly as the dashboard presents it.

**Architecture:** `commands.ts` exports `dashboardCommands` (one keyword). A new `scripts/command-surface.ts` uses it for **order only**, reading every field from `BIFROST_COMMAND_OPTIONS`, and renders markdown by default or JSON behind `--json`. State is a CLI flag because the reflected pairs sort actionable-first.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, run with `node --experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-10-05-command-surface-map-design.md` (revision 4)

---

## Critical context

- Work in `/Users/mak/git/pi-bifrost/.worktrees/feature-map-v2`, branch `feat/feature-map`. Worktree is clean.
- `commands.ts` is ~1450 lines. Verify line numbers before editing; the spec's citations are accurate at `main` = `236622d`.
- `tsconfig.json:17` is `include: ["*.ts", "tests/**/*.ts"]`. `scripts/` is **outside** the program directly, but importing it from `tests/**/*.ts` brings it in transitively — so `tests/command-surface.test.ts` importing the script is what typechecks it.
- `package.json:44` globs `tests/*.test.ts`, so a new test at `tests/` runs under `npm test`.
- `package.json:6` is `files: ["*.ts", …]`, which matches the **repo root only**. Logic must stay under `scripts/` or it ships in the npm tarball as an entry point nothing imports.

## File map

| File | Responsibility | Change |
|---|---|---|
| `commands.ts` | Command registry, dispatch, menu | Modify: export `dashboardCommands` |
| `scripts/command-surface.ts` | Row builder, renderers, CLI | Create |
| `tests/command-surface.test.ts` | All assertions | Create |
| `docs/guide/commands.md` | User-facing command reference | Modify: one prose line |
| `package.json` | npm scripts | Modify: add `command-surface` |

---

## Task 1: Export `dashboardCommands`

**Files:**
- Modify: `commands.ts:988`

- [ ] **Step 1: Write the failing test**

Create `tests/command-surface.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BIFROST_COMMAND_OPTIONS, dashboardCommands } from "../commands.ts";

describe("dashboardCommands", () => {
  it("returns every registered command exactly once, in menu order", () => {
    const rows = dashboardCommands({ enabled: true, pinned: false });
    const values = rows.map((row) => row.value).sort();
    assert.deepEqual(values, BIFROST_COMMAND_OPTIONS.map((c) => c.value).sort());
    assert.equal(rows.length, BIFROST_COMMAND_OPTIONS.length);
  });

  it("leads each reflected pair with the member that changes something", () => {
    assert.deepEqual(
      dashboardCommands({ enabled: true, pinned: false }).slice(0, 4).map((r) => r.value),
      ["off", "on", "pin", "unpin"],
    );
    assert.deepEqual(
      dashboardCommands({ enabled: false, pinned: true }).slice(0, 4).map((r) => r.value),
      ["on", "off", "unpin", "pin"],
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "SyntaxError|does not provide|^ℹ (pass|fail)"`

Expected: fails — `dashboardCommands` is not exported.

- [ ] **Step 3: Export it**

Change `commands.ts:988` from:

```ts
function dashboardCommands(state: Pick<BifrostState, ReflectedState>): CommandSpec[] {
```

to:

```ts
export function dashboardCommands(state: Pick<BifrostState, ReflectedState>): CommandSpec[] {
```

The doc comment above it already explains the ordering contract; leave it.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"` then `npm run typecheck`

Expected: `fail 0`, typecheck silent. Record the unit count (baseline is 438).

- [ ] **Step 5: Commit**

```bash
git add commands.ts tests/command-surface.test.ts
git commit -m "refactor(commands): export dashboardCommands

The dashboard's ordering logic is the authority for how commands are
presented, and a map generator needs to call it rather than re-derive
it. One keyword; nothing else moves."
```

**HARD RULE:** no `Co-Authored-By` trailer, no agent attribution — this repo forbids it. Verify: `git log -1 --format=%B | grep -E "^[A-Za-z-]+: <" && echo "TRAILER FOUND" || echo clean`

---

## Task 2: `buildCommandSurface`

**Files:**
- Create: `scripts/command-surface.ts`
- Test: `tests/command-surface.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/command-surface.test.ts`, extending the existing import from `../commands.ts` rather than adding a second import statement for the same module:

```ts
describe("buildCommandSurface", () => {
  it("returns every registry value exactly once", () => {
    const rows = buildCommandSurface({ enabled: true, pinned: false });
    assert.deepEqual(
      rows.map((r) => r.value).sort(),
      BIFROST_COMMAND_OPTIONS.map((c) => c.value).sort(),
    );
  });

  it("takes each description from the registry, never from dashboardCommands", () => {
    const rows = buildCommandSurface({ enabled: true, pinned: false });
    for (const row of rows) {
      const spec = BIFROST_COMMAND_OPTIONS.find((c) => c.value === row.value)!;
      assert.equal(row.description, spec.description, `${row.value} description drifted`);
    }
  });

  it("keeps init's parenthetical in the description with no note", () => {
    const init = buildCommandSurface({ enabled: true, pinned: false }).find((r) => r.value === "init")!;
    assert.equal(init.description, "Probe models and generate config (pass -f to force re-probe)");
    assert.equal(init.note, null);
  });

  it("marks exactly the no-op member of each reflected pair", () => {
    const rows = buildCommandSurface({ enabled: true, pinned: false });
    const byValue = new Map(rows.map((r) => [r.value, r]));
    assert.equal(byValue.get("on")!.inert, true);
    assert.equal(byValue.get("on")!.note, "already on");
    assert.equal(byValue.get("off")!.inert, false);
    assert.equal(byValue.get("off")!.note, null);
    assert.equal(byValue.get("unpin")!.inert, true);
    assert.equal(byValue.get("pin")!.inert, false);
  });

  it("orders rows exactly as the dashboard does, for all four states", () => {
    for (const state of [
      { enabled: true, pinned: false },
      { enabled: true, pinned: true },
      { enabled: false, pinned: false },
      { enabled: false, pinned: true },
    ]) {
      assert.deepEqual(
        buildCommandSurface(state).map((r) => r.value),
        dashboardCommands(state).map((r) => r.value),
      );
    }
  });
});
```

Merge the two import lines into one at the top of the file rather than leaving two.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "Cannot find|SyntaxError|^ℹ (pass|fail)"`

Expected: fails — `scripts/command-surface.ts` does not exist.

- [ ] **Step 3: Create the script with the row builder**

Create `scripts/command-surface.ts`:

```ts
import { BIFROST_COMMAND_OPTIONS, dashboardCommands } from "../commands.ts";

type CommandRow = (typeof BIFROST_COMMAND_OPTIONS)[number];
type MenuState = Parameters<typeof dashboardCommands>[0];

export type SurfaceRow = CommandRow & {
  readonly inert: boolean;
  readonly note: string | null;
};

const GROUP_LABELS = ["State toggles", "Common", "Everything else"] as const;

// dashboardCommands folds a reflected command's note into `description`
// (commands.ts:1017), so its return value is authoritative for order only.
// Every field here is read from the registry, which keeps `description` bare and
// leaves `reflects` the only authority on whether a note applies.
export function buildCommandSurface(state: MenuState): SurfaceRow[] {
  return dashboardCommands(state).map((row) => {
    const spec = BIFROST_COMMAND_OPTIONS.find((candidate) => candidate.value === row.value)!;
    const inert = spec.reflects ? spec.reflects.sets === state[spec.reflects.state] : false;
    return { ...spec, inert, note: inert ? spec.reflects!.note : null };
  });
}

export function groupOf(row: SurfaceRow): number {
  return row.reflects ? 0 : row.menu === "common" ? 1 : 2;
}

export function statePhrase(state: MenuState): string {
  return state.pinned ? "pinned" : state.enabled ? "on" : "off";
}
```

`spec.reflects!` is required — the `inert` ternary does not narrow through the alias, and removing it is a TS18048 error. It is sound because `inert === true` implies `spec.reflects` is truthy.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: pass. Then `npm run typecheck` — the test's import brings the script into the program, so a type error here **must** surface.

- [ ] **Step 5: Commit**

```bash
git add scripts/command-surface.ts tests/command-surface.test.ts
git commit -m "feat(scripts): add a command surface row builder

Reads every field from BIFROST_COMMAND_OPTIONS and uses dashboardCommands
for order only. Taking description from the dashboard's return value
would double-report the state note, which commands.ts:1017 already folds
in; reading the registry keeps it bare and leaves reflects the only
authority on whether a note applies."
```

---

## Task 3: Renderers

**Files:**
- Modify: `scripts/command-surface.ts`
- Test: `tests/command-surface.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the existing `../scripts/command-surface.ts` import to also pull in `renderJson` and `renderMarkdown`:

```ts
describe("renderMarkdown", () => {
  const state = { enabled: true, pinned: false };
  const rows = buildCommandSurface(state);

  it("renders command order identical to the dashboard for all four states", () => {
    for (const current of [
      { enabled: true, pinned: false },
      { enabled: true, pinned: true },
      { enabled: false, pinned: false },
      { enabled: false, pinned: true },
    ]) {
      const markdown = renderMarkdown(buildCommandSurface(current), current);
      // Compare whole cells, not bare values: values contain spaces (`classifier
      // status`) and two of them carry an argument hint, so a value-only capture
      // would either truncate or leave the hint attached.
      const order = [...markdown.matchAll(/^\| `\/bifrost (.+?)`/gm)].map((match) => match[1]);
      const expected = dashboardCommands(current).map((spec) => {
        const hint = spec.argumentHint ? ` ${spec.argumentHint}` : "";
        return `${spec.value}${hint}`;
      });
      assert.deepEqual(order, expected);
    }
  });

  it("shows every command exactly once", () => {
    const markdown = renderMarkdown(rows, state);
    for (const command of BIFROST_COMMAND_OPTIONS) {
      // The cell carries the argument hint, so match the whole cell: a bare value
      // would miss `preview` (its cell continues past the value) and would
      // count `classifier` inside `classifier status` as a duplicate.
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      const occurrences = markdown.split(`\`/bifrost ${command.value}${hint}\``).length - 1;
      assert.equal(occurrences, 1, `${command.value} appeared ${occurrences} times`);
    }
  });

  it("renders a three-column row with an empty Note cell when there is no note", () => {
    const markdown = renderMarkdown(rows, state);
    assert.match(markdown, /^\| `\/bifrost on` \| Enable routing \| already on \|$/m);
    // "m" plus the ^…$ anchors are load-bearing: \s+ spans newlines, so an
    // unanchored version of this assertion still matches when the Note column is
    // dropped entirely and the next row's cells line up across the boundary.
    assert.match(markdown, /^\| `\/bifrost off` \| Disable routing \| *\|$/m);
  });

  it("keeps init's parenthetical in the description column", () => {
    assert.match(
      renderMarkdown(rows, state),
      /Probe models and generate config \(pass -f to force re-probe\)/,
    );
  });

  it("interpolates the count from the registry", () => {
    assert.match(
      renderMarkdown(rows, state),
      // "m" is load-bearing: the count is on line two, not at the string start.
      new RegExp(`^${BIFROST_COMMAND_OPTIONS.length} commands\\.`, "m"),
    );
  });

  it("states the /bifrost entry point", () => {
    assert.match(renderMarkdown(rows, state), /typing \/bifrost and pressing enter/);
  });

  it("escapes pipes and wraps angle brackets", () => {
    const markdown = renderMarkdown(
      [{ ...rows[0], description: "a | b <c>" }] as SurfaceRow[],
      state,
    );
    assert.match(markdown, /a \\\| b `<c>`/);
    // The hint rides inside the command cell's own code span, which is what
    // keeps a bare `<prompt>` from parsing as a raw HTML tag.
    assert.match(renderMarkdown(rows, state), /`\/bifrost preview \[--json\] <prompt>`/);
  });
});

describe("renderJson", () => {
  it("emits state, total and the same rows", () => {
    const state = { enabled: false, pinned: true };
    const parsed = JSON.parse(renderJson(buildCommandSurface(state), state));
    assert.deepEqual(parsed.state, state);
    assert.equal(parsed.total, BIFROST_COMMAND_OPTIONS.length);
    assert.deepEqual(
      parsed.groups.flatMap((g: { rows: Array<{ value: string }> }) => g.rows.map((r) => r.value)).sort(),
      BIFROST_COMMAND_OPTIONS.map((c) => c.value).sort(),
    );
  });

  it("uses null for an absent note", () => {
    const state = { enabled: true, pinned: false };
    const parsed = JSON.parse(renderJson(buildCommandSurface(state), state));
    const off = parsed.groups
      .flatMap((g: { rows: Array<Record<string, unknown>> }) => g.rows)
      .find((r: Record<string, unknown>) => r.value === "off");
    assert.equal(off!.note, null);
    assert.equal(off!.inert, false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "does not provide|^ℹ (pass|fail)"`

Expected: fails — no `renderMarkdown`/`renderJson` export.

- [ ] **Step 3: Implement the renderers**

Append to `scripts/command-surface.ts`:

```ts
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "`<").replace(/>/g, ">`");
}

function commandCell(row: SurfaceRow): string {
  const hint = row.argumentHint ? ` ${row.argumentHint}` : "";
  return `\`/bifrost ${row.value}${hint}\``;
}

export function renderMarkdown(rows: readonly SurfaceRow[], state: MenuState): string {
  const total = BIFROST_COMMAND_OPTIONS.length;
  const lines = [
    `Bifrost command surface — routing ${statePhrase(state)}`,
    `${total} commands. Order matches the /bifrost dashboard; grouping is editorial.`,
    "",
    "Open the surface by typing /bifrost and pressing enter.",
  ];
  for (let tier = 0; tier < GROUP_LABELS.length; tier += 1) {
    const tierRows = rows.filter((row) => groupOf(row) === tier);
    if (tierRows.length === 0) continue;
    lines.push("", `## ${GROUP_LABELS[tier]}`, "", "| Command | Description | Note |", "|---|---|---|");
    for (const row of tierRows) {
      lines.push(`| ${commandCell(row)} | ${escapeCell(row.description)} | ${row.note ?? ""} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(rows: readonly SurfaceRow[], state: MenuState): string {
  return `${JSON.stringify(
    {
      state: { enabled: state.enabled, pinned: state.pinned },
      total: BIFROST_COMMAND_OPTIONS.length,
      groups: GROUP_LABELS.map((label, tier) => ({
        label,
        rows: rows.filter((row) => groupOf(row) === tier),
      })),
    },
    null,
    2,
  )}\n`;
}
```

`renderJson` returns the serialised string rather than the object, because `main` writes it straight to stdout and the tests `JSON.parse` it; returning `unknown` would make `JSON.parse(renderJson(...))` a typecheck error and would print `[object Object]` from the CLI.

`commandCell` embeds the argument hint in the command column, matching `formatBifrostCommandChoice`, so there is no separate Argument column.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: pass. If the markdown-order test fails, the renderer and the row builder disagree about order — fix the renderer, not the test.

- [ ] **Step 5: Commit**

```bash
git add scripts/command-surface.ts tests/command-surface.test.ts
git commit -m "feat(scripts): render the command surface as markdown or json

Markdown escapes pipes and wraps angle brackets in backticks, because a
bare <prompt> is parsed as a raw HTML tag in GitHub-flavored markdown and
would render as nothing wherever the map is pasted.

The command count is interpolated from the registry rather than written
as a literal, so it cannot go stale when a command is added."
```

---

## Task 4: CLI

**Files:**
- Modify: `scripts/command-surface.ts`
- Test: `tests/command-surface.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the existing `../scripts/command-surface.ts` import to also pull in `main`:

```ts
describe("command-surface cli", () => {
  it("defaults to routing on, unpinned", () => {
    const out = captureRun(() => main(["--json"]));
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.state, { enabled: true, pinned: false });
    assert.equal(parsed.groups[0].rows.slice(0, 4).map((r: { value: string }) => r.value).join(","), "off,on,pin,unpin");
  });

  it("honours both state flags", () => {
    const parsed = JSON.parse(captureRun(() => main(["--json", "--enabled=false", "--pinned=true"])));
    assert.deepEqual(parsed.state, { enabled: false, pinned: true });
    assert.equal(parsed.groups[0].rows.slice(0, 4).map((r: { value: string }) => r.value).join(","), "on,off,unpin,pin");
  });

  it("emits markdown by default", () => {
    const out = captureRun(() => main([]));
    assert.match(out, /^Bifrost command surface/);
    assert.match(out, /## State toggles/);
  });

  it("rejects an unknown flag", async () => {
    await assert.rejects(() => main(["--nope"]), /unknown flag/);
  });
});
```

Add this helper near the top of the test file:

```ts
function captureRun(run: () => Promise<void>): string {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => chunks.push(parts.join(" "));
  try {
    run();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}
```

If `main` turns out to be genuinely async in a way that makes this racy, make `captureRun` async and `await` it in each test instead.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "does not provide|^ℹ (pass|fail)"`

Expected: fails — no `main` export.

- [ ] **Step 3: Implement the CLI**

Append to `scripts/command-surface.ts`:

```ts
const USAGE = "usage: command-surface [--json] [--enabled=true|false] [--pinned=true|false]";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let json = false;
  const state = { enabled: true, pinned: false };
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--enabled=")) state.enabled = arg.slice("--enabled=".length) !== "false";
    else if (arg.startsWith("--pinned=")) state.pinned = arg.slice("--pinned=".length) !== "false";
    else throw new Error(`unknown flag: ${arg}\n${USAGE}`);
  }
  const rows = buildCommandSurface(state);
  console.log(json ? renderJson(rows, state).trimEnd() : renderMarkdown(rows, state).trimEnd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "command-surface failed");
    process.exitCode = 1;
  });
}
```

The self-invocation guard mirrors `scripts/jev-benchmark.ts:480`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test --experimental-strip-types tests/command-surface.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"` then `npm run typecheck`

Expected: pass, typecheck silent.

- [ ] **Step 5: Verify the CLI end to end**

```bash
cd /Users/mak/git/pi-bifrost/.worktrees/feature-map-v2
node --experimental-strip-types scripts/command-surface.ts | head -12
node --experimental-strip-types scripts/command-surface.ts --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('parsed OK, total',j.total,'state',JSON.stringify(j.state))})"
node --experimental-strip-types scripts/command-surface.ts --nope; echo "exit=$?"
```

Expected: markdown table; `parsed OK, total 18 state {"enabled":true,"pinned":false}`; unknown flag prints usage and `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add scripts/command-surface.ts tests/command-surface.test.ts
git commit -m "feat(scripts): add the command-surface CLI

State is a flag because the reflected pairs sort actionable-first, so
the output legitimately differs by state. Both flags are covered by
tests, since an argv parser that ignored them would leave the header
lying while every other test stayed green.

Unknown flags exit non-zero rather than being silently ignored."
```

---

## Task 5: npm script and discoverability

**Files:**
- Modify: `package.json` (add to `scripts`)
- Modify: `docs/guide/commands.md` (one prose line)

- [ ] **Step 1: Add the npm script**

Add to `package.json`'s `scripts` object, next to `benchmark:jev`:

```json
"command-surface": "node --experimental-strip-types scripts/command-surface.ts",
```

Note for docs, not code: `npm run command-surface` is fine for reading, but `--json` output must be obtained via the `node` form or `npm run --silent`, because npm writes its `> pkg@ver script` banner to stdout.

- [ ] **Step 2: Add the discoverability line**

In `docs/guide/commands.md`, add one **prose** line near the top of the page — outside the command table, and not starting with `` | `/bifrost ``:

```markdown
Run `npm run command-surface` to print every command in the order the `/bifrost` dashboard presents it.
```

**Placement constraint:** the drift test anchors on `| Command |` and the next `| Control` header, which is at line 115, so it scans roughly 110 lines past the command table. A prose line is safe anywhere in that span *only because* the parse skips rows that do not begin with `` | `/bifrost ``. Writing it as a table row beginning `` | `/bifrost `` would break `tests/docs-command-drift.test.ts`.

- [ ] **Step 3: Verify both tests still pass**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: `fail 0`, including `docs command drift` and `landing command picker lists every canonical Pi Bifrost command`.

- [ ] **Step 4: Verify the script runs through npm**

```bash
npm run command-surface 2>&1 | head -4
```

Expected: the banner (from npm) then the table. That banner is why `--json` is documented via the `node` form.

- [ ] **Step 5: Commit**

```bash
git add package.json docs/guide/commands.md
git commit -m "chore(scripts): wire command-surface into npm and the guide

An uncommitted, undocumented artifact is unreachable by the audience it
is written for, so add the npm entry and one prose line in the command
guide. The line is prose rather than a table row: the drift test scans
past the command table to the persistence summary at line 115 and only
skips lines that do not begin with a /bifrost table cell."
```

---

## Task 6: Final verification

- [ ] **Step 1: Run every gate**

```bash
cd /Users/mak/git/pi-bifrost/.worktrees/feature-map-v2
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|suites)|✖"
npm run typecheck
npm run test:integration 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
```

Expected: `fail 0` everywhere, typecheck silent. Baseline before this branch was 438 unit and 21 integration.

- [ ] **Step 2: Confirm the script is not published**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).files)"
npm pack --dry-run 2>&1 | grep -c "command-surface"
```

Expected: `files` is `["*.ts", …]` and the pack contains **0** matches for `command-surface` — the logic lives under `scripts/`, which `files` does not match.

- [ ] **Step 3: Confirm no root module was added**

```bash
ls *.ts
```

Expected: no `command-surface.ts` at the repo root.

- [ ] **Step 4: Check hygiene**

```bash
git status --short
git log --oneline origin/main..HEAD
git log origin/main..HEAD --format=%B | grep -E "^[A-Za-z-]+: <" && echo "TRAILER FOUND" || echo "no trailers"
git diff --check origin/main..HEAD
```

Expected: clean status, six commits, no trailers, no whitespace errors.

- [ ] **Step 5: Record the counts and report**

Report the unit count, integration count, and the rendered sample output.

---

## Self-review

**Spec coverage.** Every spec section maps to a task: export → Task 1; row construction → Task 2; renderers and escaping → Task 3; state flags, both renderers, unknown flags → Task 4; npm + discoverability + placement constraint → Task 5; gates and the not-published check → Task 6. The spec's non-goals (no committed artifact, no coverage columns, no dashboard change, no `commands.md` row changes) are honoured by omission and asserted in Task 6.

**Placeholder scan.** No TBD, TODO, or "similar to Task N". Every code step shows the code.

**Type consistency.** `SurfaceRow`, `MenuState`, `CommandRow`, `buildCommandSurface`, `groupOf`, `statePhrase`, `renderMarkdown`, `renderJson`, `main`, `commandCell`, `escapeCell`, `captureRun` are each defined once and used under the same name throughout.

**Known tension.** `captureRun` calls `run()` synchronously while `main` is `async`. If that produces a timing problem, the plan says to make it async rather than to leave it subtly wrong.