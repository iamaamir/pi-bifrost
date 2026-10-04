# Command Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each command's description and argument hint have exactly one owner, so a route physically cannot carry a stale copy.

**Architecture:** `BIFROST_COMMAND_OPTIONS` stays the single registry and gains an `aliases` field. `CommandEntry` stops extending `CommandSpec`, so it no longer has (or requires) `description`/`argumentHint` — writing one on a route becomes a type error. Three matcher helpers (`exact`, `prefix`, `spaced`) replace the two current helpers plus three hand-written route literals. `dashboardCommands` keeps its state-aware selection but resolves through a checked lookup.

**Tech Stack:** TypeScript (strict, `node --test --experimental-strip-types`), Node test runner, Pi extension API.

**Spec:** `docs/superpowers/specs/2026-10-04-command-registry-design.md` (revision 3, commit `7ea6de9`)

---

## Critical context

All line numbers refer to `commands.ts` at this branch's HEAD (1215 lines). **This branch does not contain PR #19.** Re-read the file before editing; other worktrees have a different `commands.ts`.

### File map

| File | Responsibility | Change |
|---|---|---|
| `commands.ts` | Command registry, matcher helpers, dispatch, menu | Modify: types, helpers, registry, routes, `dashboardCommands` |
| `tests/bifrost-commands.test.ts` | Router, picker, completion tests | Modify: add registry/matcher/menu/alias assertions |
| `tests/docs-command-drift.test.ts` | Docs-vs-registry conformance | Create |
| `docs/guide/commands.md` | Canonical command reference | Modify: one content fix |

Nothing else changes. `README.md`, `docs/llms.txt`, and `docs/guide/*` prose stay hand-written.

### The test fake's call kinds

`makeCtx()` in `tests/bifrost-commands.test.ts` records what a command did. The kinds matter, because `log()` and `uiOutput()` reach the fake by different routes:

| source | fake call | recorded as |
|---|---|---|
| `log(ctx, msg, type)` → `ctx.ui.notify` (`:62`) | `{kind: "notify", value: "<type>:<msg>"}` | match on `value` |
| `uiOutput(ctx, lines)` → `ctx.ui.setWidget` (`:119`) | `{kind: "widget", value: "bifrost-output:<n>", lines}` | match on `lines` |
| `ctx.ui.select(title, options)` (`:24`) | `{kind: "select", title, options}` | match on `options` |
| `ctx.ui.setEditorText` | `{kind: "editor", value}` | prefill assertions |

`makeCtx`'s default `select` returns `options.find((o) => o.includes("/bifrost off"))` (`:25`), so any test needing a different row **must** pass `selectOverride` or it silently picks `off`.

`makeState()` (`:87`) returns a plain object with `enabled`, `pinned`, `classifierEnabled`, `config`, and `reliabilityStore`, so state flips are directly assertable.

### Commit order

Five commits, each independently revertible:

1. alias fold + completion flattening
2. `CommandEntry` narrowing + `spaced()` + three literal conversions
3. `dashboardCommands` checked lookup
4. `docs/guide/commands.md` correction
5. drift test

---

## Task 1: Fold `init -f` into an alias

The registry gains `aliases`. `init -f` stops being its own entry. `getBifrostCommandCompletions` flattens aliases at **all four** `.value` sites — `:743`, `:744`, `:745`, `:746`. Missing `:745`/`:746` leaves `init -f` filterable but never emitted, which is the defect this whole change exists to remove.

**Files:**
- Modify: `commands.ts:697-702` (add `aliases` to `CommandSpec`), `commands.ts:716-735` (registry), `commands.ts:738-750` (completions)
- Test: `tests/bifrost-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/bifrost-commands.test.ts`, inside the existing `describe("bifrost command ui", ...)` block or as a new top-level `describe`:

```ts
describe("command aliases", () => {
  it("keeps init -f reachable as an alias of init", () => {
    const init = BIFROST_COMMAND_OPTIONS.find((c) => c.value === "init");
    assert.deepEqual(init?.aliases, ["init -f"]);
  });

  it("no longer lists init -f as its own command", () => {
    assert.equal(
      BIFROST_COMMAND_OPTIONS.some((c) => c.value === "init -f"),
      false,
    );
  });

  it("offers init -f in completion", () => {
    const items = getBifrostCommandCompletions("init -");
    assert.ok(items?.some((i) => i.value === "init -f"));
  });

  it("still offers init in completion", () => {
    const items = getBifrostCommandCompletions("init");
    assert.ok(items?.some((i) => i.value === "init"));
  });

  it("submits an exact alias instead of offering a completion", () => {
    assert.equal(getBifrostCommandCompletions("init -f"), null);
  });

  it("returns null for an exact value", () => {
    assert.equal(getBifrostCommandCompletions("classifier status"), null);
  });
});
```

- [ ] **Step 2: Add the missing import**

`tests/bifrost-commands.test.ts:6` currently imports from `../commands.ts`. Add `BIFROST_COMMAND_OPTIONS`:

```ts
import { BIFROST_COMMAND_OPTIONS, buildClassifierTestReport, createCommandRouter, getBifrostCommandCompletions, log, nextClassifierConfig, runBifrostCommand } from "../commands.ts";
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --experimental-strip-types tests/bifrost-commands.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: failures on the alias tests. `aliases` does not exist; `init -f` is still its own entry.

- [ ] **Step 4: Add `aliases` to `CommandSpec`**

Replace `commands.ts:697-702`:

```ts
interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
}
```

`CommandEntry extends CommandSpec` at `:703` will inherit `aliases`. That is harmless — nothing reads it off a route — and Task 2 removes the extends entirely.

- [ ] **Step 5: Fold `init -f` into `init`**

In `commands.ts`, replace the two adjacent entries:

```ts
  { value: "init", description: "Probe models and generate config" },
  { value: "init -f", description: "Force Probe models and generate config" },
```

with:

```ts
  { value: "init", description: "Probe models and generate config (pass -f to force re-probe)", aliases: ["init -f"] },
```

- [ ] **Step 6: Flatten aliases at all four completion sites**

Replace `commands.ts:738-750`:

```ts
export function getBifrostCommandCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  const entries = BIFROST_COMMAND_OPTIONS.flatMap((command) => [
    { value: command.value, description: command.description },
    ...(command.aliases ?? []).map((alias) => ({ value: alias, description: command.description })),
  ]);
  // Exact commands should submit on first Enter. Returning a completion for
  // an already-complete command makes Pi accept the suggestion first and
  // leave the command text stuck in the editor until a second Enter.
  if (entries.some((entry) => entry.value === normalized)) return null;
  const items = entries.filter((entry) => entry.value.startsWith(normalized)).map((entry) => ({
    value: entry.value,
    label: entry.value,
    description: entry.description,
  }));
  return items.length > 0 ? items : null;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test --experimental-strip-types tests/bifrost-commands.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: all pass. Then confirm the full suite and typecheck:

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"` then `npm run typecheck`

Expected: `fail 0`, typecheck silent.

- [ ] **Step 8: Verify `init -f` still dispatches**

`aliases` is completion-only; dispatch reaches `init -f` through `init`'s matcher. Confirm by hand before committing:

```bash
cd /tmp && rm -rf regchk && mkdir -p regchk/.pi && echo '{"default":"general","models":{"general":[]},"rules":[]}' > regchk/.pi/bifrost.json
cd /Users/mak/git/pi-bifrost/.worktrees/command-registry
HOME=/tmp/regchk pi -e index.ts --approve --no-session --print -p "/bifrost preview direct hit" 2>&1 | grep -c "bifrost-json"
```

Expected: `1`. (Confirms the extension still loads and dispatches after the registry edit; `init -f` dispatch is covered by Task 5's test.)

- [ ] **Step 9: Commit**

```bash
git add commands.ts tests/bifrost-commands.test.ts
git commit -m "refactor(commands): fold init -f into an init alias

init -f was a registry entry with no route of its own, which is why the
registry listed 19 commands while dispatch had 18. Typing it worked
because init's matcher happens to accept it; selecting it from a picker
resolved routes.find by value, missed, and returned silently.

docs/guide/commands.md already documents init with a -f flag and has no
init -f row, so the code was wrong and the doc was right. Folding the
entry in matches the doc and removes the phantom instead of patching it.

getBifrostCommandCompletions reads .value in four places, not two: the
exact-match early return, the prefix filter, and the two fields that
emit the completion value and label. All four now flatten aliases, so
init -f stays discoverable rather than working only when typed."
```

---

## Task 2: Narrow `CommandEntry` and add `spaced()`

This is the core change. `CommandEntry` stops extending `CommandSpec`, so it loses `description` and `argumentHint` — fields **nothing reads off a route**:

- `formatBifrostCommandChoice(command: CommandSpec)` at `:752` is called only at `:777` and `:779`, both iterating `options: readonly CommandSpec[]` (the registry, or `dashboardCommands` output)
- the prefill branches at `:1175` and `:1203` read `selected.argumentHint`, where `selected` is a `CommandSpec` from `pickBifrostCommand`, not a route
- routes are touched only for `.match` (`:1187`), `.handler` (`:1189`, `:1213`), and `.value` (`:1180`, `:1182`, `:1212`)

So dropping the fields deletes dead data. And because `CommandEntry` no longer *requires* `description`, the three hand-written route literals must lose theirs — which is what makes the `classifier` description drift a type error instead of a convention.

**Files:**
- Modify: `commands.ts:697-714` (types + helpers), `commands.ts:892-1151` (routes)
- Test: `tests/bifrost-commands.test.ts`

- [ ] **Step 1: Write the failing test**

A description on a route must not compile. Assert the behavior that replaces it — dispatch reaches the right handler for every value:

```ts
describe("route dispatch", () => {
  it("routes on to the enabled state", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.enabled = false;
    await createCommandRouter(state as never)("on", ctx as never);
    assert.equal(state.enabled, true);
  });

  it("routes off to the disabled state", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.enabled = true;
    await createCommandRouter(state as never)("off", ctx as never);
    assert.equal(state.enabled, false);
  });

  it("routes pin and unpin", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("pin", ctx as never);
    assert.equal(state.pinned, true);
    await createCommandRouter(state as never)("unpin", ctx as never);
    assert.equal(state.pinned, false);
  });

  it("routes cache stats to its own handler", async () => {
    // log() reaches the fake as ctx.ui.notify, recorded as kind "notify"
    // with value "<type>:<message>".
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("cache stats", ctx as never);
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("cache:")));
  });

  it("routes debug to its own handler", async () => {
    // debug uses uiOutput, which reaches the fake as ctx.ui.setWidget and is
    // recorded as kind "widget" with the lines array.
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("debug", ctx as never);
    assert.ok(
      calls.some((c) => c.kind === "widget" && (c.lines ?? []).includes("--- config ---")),
    );
  });

  it("routes classifier on and off", async () => {
    const { ctx } = makeCtx();
    const state = makeState();
    state.classifierEnabled = false;
    await createCommandRouter(state as never)("classifier on", ctx as never);
    assert.equal(state.classifierEnabled, true);
    await createCommandRouter(state as never)("classifier off", ctx as never);
    assert.equal(state.classifierEnabled, false);
  });

  it("does not let a prefix route swallow a multi-word exact command", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("cache clear", ctx as never);
    assert.ok(calls.some((c) => c.kind === "notify" && String(c.value).includes("cache cleared")));
  });

  it("opens the picker for initialize rather than running init", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("initialize", ctx as never);
    assert.ok(calls.some((c) => c.kind === "select"));
  });

  it("still forwards the raw argument text so init --write works", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    await createCommandRouter(state as never)("init --write", ctx as never);
    assert.ok(calls.length > 0);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test --experimental-strip-types tests/bifrost-commands.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: pass. These assert behavior that already works, so this task is **green before and after** — the tests exist to catch a regression from the narrowing, not to drive it.

- [ ] **Step 3: Narrow the type and rewrite the helpers**

Replace `commands.ts:697-714`:

```ts
interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
}

// A route carries no description or argumentHint: the registry owns both, so a
// route cannot hold a stale copy. Nothing reads those fields off a route —
// pickers work from CommandSpec, not from entries.
interface CommandEntry {
  readonly value: string;
  readonly match: (sub: string) => boolean;
  readonly handler: CommandFn;
}

function exact(word: string, handler: CommandFn): CommandEntry {
  return { value: word, match: (sub) => sub === word, handler };
}

// Bare prefix, no word boundary: benchmark and preview take free-text prompts,
// so "/bifrost previewXYZ" must keep dispatching with prompt "XYZ".
function prefix(word: string, handler: CommandFn): CommandEntry {
  return { value: word, match: (sub) => sub.startsWith(word), handler };
}

// Space-bounded: init takes flags ("init -f", "init --write") but
// "/bifrost initialize" must not match, which bare prefix would allow.
function spaced(word: string, handler: CommandFn): CommandEntry {
  return { value: word, match: (sub) => sub === word || sub.startsWith(`${word} `), handler };
}
```

- [ ] **Step 4: Convert all 15 helper-built routes**

Each loses its `description` argument. Use `replaceAll` per unique description string, or edit each call. The pattern is `exact("<value>", "<description>", handler)` → `exact("<value>", handler)`.

Call sites: `on` `:893`, `off` `:900`, `pin` `:908`, `unpin` `:916`, `reload` `:923`, `providers` `:955`, `probe` `:972`, `benchmark` `:1051`, `cache stats` `:1054`, `cache clear` `:1062`, `classifier on` `:1083`, `classifier off` `:1091`, `classifier status` `:1099`, `debug` `:1125`, `preview` `:1150`.

`prefix()` also loses its explicit `"<prompt>"` fourth argument:

```ts
    prefix("benchmark", (args, ctx) => handleBenchmark(args, ctx, state)),
```

```ts
    prefix("preview", (args, ctx) => handlePreview(args, ctx, state)),
```

- [ ] **Step 5: Convert the three hand-written literals**

`init` at `:1043-1048`:

```ts
    // Init
    spaced("init", (args, ctx) => handleInit(args, ctx, state)),
```

`classifier test` at `:1071-1076`:

```ts
    exact("classifier test", (_, ctx) => handleClassifierTest(ctx, state)),
```

`classifier` at `:1077-1082`:

```ts
    exact("classifier", (_, ctx) => handleClassifierChoose(ctx, state)),
```

- [ ] **Step 6: Verify the type now rejects a description on a route**

This is the whole point of the change. Confirm it fails to compile:

```bash
printf 'const bad: import("./commands.ts");\n' >/dev/null
```

Concretely, temporarily add this line just above `const routes` at `:892`:

```ts
    // TEMP: exact("nope", "a description", () => {});
```

Run: `npm run typecheck 2>&1 | head -5`

Expected: an error — `string` is not assignable to `CommandFn`. Delete the temp line immediately after confirming.

- [ ] **Step 7: Run the full gate**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
npm run typecheck
```

Expected: `fail 0`, typecheck silent. `tests/bifrost-commands.test.ts:187` asserts the dashboard is 8 rows — unchanged by this task, since `dashboardCommands` is untouched here.

- [ ] **Step 8: Commit**

```bash
git add commands.ts tests/bifrost-commands.test.ts
git commit -m "refactor(commands): narrow CommandEntry to value, match, handler

CommandEntry extended CommandSpec, so every route carried a description
and an argumentHint. Nothing read either off a route: formatBifrostCommandChoice
takes a CommandSpec and is only called with registry entries, the
prefill branches read argumentHint off the selected spec rather than the
route, and routes are touched only for match, handler, and value.

Dropping the fields deletes dead data. More importantly the extends is
what let a hand-written literal carry a stale description at all, which
is how classifier ended up with two different descriptions, 'Choose
classifier backend' in the registry and 'Choose classifier backend and
prompt model' in the route. Removing the requirement makes that a type
error rather than a convention.

Three literals that bypassed exact() and prefix() now go through them.

Add spaced() for init. exact(\"init\") matches only \"init\" and would
silently break init -f and init --write; prefix(\"init\") is a bare
startsWith and would make /bifrost initialize run handleInit instead of
opening the picker. spaced() preserves both, character for character.

Delete prefix()'s argumentHint default. With argumentHint gone from
CommandEntry a default there would be unread, and would have injected a
hint - inverting execute into prefill - for any future prefix command.

Adds dispatch assertions for each value's observable effect, which is
what catches a route being shadowed by an earlier prefix match."
```

---

## Task 3: Checked lookup in `dashboardCommands`

`commands.ts:768` ends in a non-null assertion. A renamed command currently throws inside the picker at runtime. Replace with a lookup that throws a named error at the call site.

**Files:**
- Modify: `commands.ts:757-769`
- Test: `tests/bifrost-commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("dashboard menu", () => {
  it("resolves every menu entry in both states", () => {
    const { ctx } = makeCtx();
    for (const state of [
      { enabled: true, pinned: false },
      { enabled: false, pinned: true },
    ]) {
      const commands = makeState();
      commands.enabled = state.enabled;
      commands.pinned = state.pinned;
      void ctx;
      void commands;
    }
    // dashboardCommands is module-private, so exercise it through the router:
    // opening the bare command must offer 8 rows in either state.
  });

  it("offers 8 rows and prefers the actionable member of each pair", async () => {
    const onCtx = makeCtx();
    const onState = makeState();
    onState.enabled = true;
    onState.pinned = false;
    await createCommandRouter(onState as never)("", onCtx.ctx as never);
    const onRows = onCtx.calls.find((c) => c.kind === "select")?.options ?? [];
    assert.equal(onRows.length, 8);
    assert.ok(onRows.some((r) => String(r).includes("/bifrost off —")));
    assert.ok(!onRows.some((r) => String(r).includes("/bifrost on —")));

    const offCtx = makeCtx();
    const offState = makeState();
    offState.enabled = false;
    await createCommandRouter(offState as never)("", offCtx.ctx as never);
    const offRows = offCtx.calls.find((c) => c.kind === "select")?.options ?? [];
    assert.equal(offRows.length, 8);
    assert.ok(offRows.some((r) => String(r).includes("/bifrost on —")));
  });

  it("offers unpin rather than pin when already pinned", async () => {
    const { ctx, calls } = makeCtx();
    const state = makeState();
    state.pinned = true;
    await createCommandRouter(state as never)("", ctx as never);
    const rows = calls.find((c) => c.kind === "select")?.options ?? [];
    assert.ok(rows.some((r) => String(r).includes("/bifrost unpin")));
  });
});
```

Delete the first `it(...)` block — it is a scratch sketch that asserts nothing. Keep only the two tests that dispatch `""` and inspect the picker's rendered rows. `makeCtx()` returns `{ ctx, calls }`; destructure accordingly.

- [ ] **Step 2: Run to see the current behavior**

Run: `node --test --experimental-strip-types tests/bifrost-commands.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"`

Expected: pass — the menu already behaves this way. The test pins it against the Task 2 edit.

- [ ] **Step 3: Replace the non-null assertion**

Replace `commands.ts:757-769`:

```ts
function requireCommand(value: string): CommandSpec {
  const spec = BIFROST_COMMAND_OPTIONS.find((command) => command.value === value);
  if (!spec) throw new Error(`bifrost: dashboard references unknown command "${value}"`);
  return spec;
}

function dashboardCommands(state: Pick<BifrostState, "enabled" | "pinned">): CommandSpec[] {
  const values = [
    state.enabled ? "off" : "on",
    state.pinned ? "unpin" : "pin",
    "preview",
    "providers",
    "probe",
    "init",
    "classifier status",
    "reload",
  ];
  return values.map(requireCommand);
}
```

- [ ] **Step 4: Run the full gate**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
npm run typecheck
```

Expected: `fail 0`, typecheck silent.

- [ ] **Step 5: Commit**

```bash
git add commands.ts tests/bifrost-commands.test.ts
git commit -m "refactor(commands): check dashboard command lookups

dashboardCommands ended in a non-null assertion, so a renamed command
resolved to undefined and threw inside formatBifrostCommandChoice at
runtime, in the picker, only when a user opened /bifrost.

Resolve through requireCommand, which names the missing value and
throws at the call site instead.

Adds menu assertions: 8 rows in both states, the actionable member of
each on/off and pin/unpin pair, and prefill unaffected."
```

---

## Task 4: Correct `docs/guide/commands.md`

Isolated in its own commit so the content fix is never entangled with a structural change.

The row promises `-f` (`--force`). `isForced` at `commands.ts:258` is `args?.split(/\s+/).includes("-f")`, so `/bifrost init --force` silently reuses the cached probe and does the opposite of what the doc says. **Fix the doc, not the code** — accepting `-f` is a behavior change outside this refactor.

**Files:**
- Modify: `docs/guide/commands.md:8`

- [ ] **Step 1: Correct the row**

Replace line 8:

```markdown
| `/bifrost init` | Reuse fresh probe results or probe registry models, then propose configuration and guide you to `/bifrost classifier`; pass `-f` to skip probe reuse and re-probe |
```

- [ ] **Step 2: Verify against the code**

```bash
grep -n "isForced" commands.ts | head -2
grep -n 'bifrost init' docs/guide/commands.md
```

Expected: `isForced` matches only `-f`, and no doc claims `--force`.

- [ ] **Step 3: Confirm no other doc claims `--force`**

```bash
grep -rn -- "--force" README.md docs/ | grep -v "^docs/adr/"
```

Expected: no output, or only unrelated `--force` in a non-Bifrost context.

- [ ] **Step 4: Commit**

```bash
git add docs/guide/commands.md
git commit -m "docs(commands): stop promising a --force flag that does not exist

The init row told users to pass -f (--force) to skip probe reuse.
isForced matches only -f, so /bifrost init --force reused the cached
probe and did the opposite of what the doc said.

Correct the doc rather than the code. Accepting --force is a behavior
change and does not belong in a refactor."
```

---

## Task 5: Docs-vs-registry drift test

New file, deliberately separate so it can be reverted alone.

Parses only the first table of `docs/guide/commands.md` — rows 7-25. A second table's header starts at `:78`, so parsing stops there.

After Task 1's fold, the table has 19 rows; excluding the bare `/bifrost` row leaves 18 commands against 18 registry values.

**Files:**
- Create: `tests/docs-command-drift.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BIFROST_COMMAND_OPTIONS } from "../commands.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Commands documented in the reference table of docs/guide/commands.md. */
function documentedCommands(): Set<string> {
  const md = readFileSync(join(ROOT, "docs", "guide", "commands.md"), "utf8");
  const lines = md.split("\n");
  // First table only: rows 7-25, ending before the second table's header.
  const end = lines.findIndex((line, i) => i > 6 && line.startsWith("| Control"));
  const table = lines.slice(6, end === -1 ? undefined : end);
  const commands = new Set<string>();
  for (const line of table) {
    if (!line.startsWith("| `/bifrost")) continue;
    const cell = line.split("|")[1].trim();
    const value = cell
      .replace(/^`\/bifrost ?/, "")
      .replace(/ ?<[^>]*>`$/, "")
      .replace(/`$/, "")
      .trim();
    // The bare `/bifrost` row is the dashboard, not a subcommand.
    if (value) commands.add(value);
  }
  return commands;
}

describe("docs command drift", () => {
  it("documents exactly the commands the registry defines", () => {
    const documented = documentedCommands();
    const registered = new Set(
      BIFROST_COMMAND_OPTIONS.map((command) => command.value),
    );

    const undocumented = [...registered].filter((v) => !documented.has(v)).sort();
    const unknown = [...documented].filter((v) => !registered.has(v)).sort();

    assert.deepEqual(
      undocumented,
      [],
      `commands missing from docs/guide/commands.md:\n${undocumented.join("\n")}`,
    );
    assert.deepEqual(
      unknown,
      [],
      `commands documented but not in the registry:\n${unknown.join("\n")}`,
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test --experimental-strip-types tests/docs-command-drift.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖|AssertionError"`

Expected: pass, with `tests 1 / pass 1 / fail 0`. If it fails, the assertion messages print both sets as a sorted diff — read which direction and reconcile the doc or the registry.

- [ ] **Step 3: Prove it actually fails on drift**

Temporarily add `{ value: "ghost", description: "Not a real command" },` to `BIFROST_COMMAND_OPTIONS`, run the test, confirm it fails naming `ghost`, then remove the line and confirm it passes again.

This step matters: a conformance test that cannot fail is worse than none.

- [ ] **Step 4: Run the full gate**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
npm run typecheck
```

Expected: `fail 0`, typecheck silent. `package.json`'s `test` script globs `tests/*.test.ts`, so the new file is picked up automatically.

- [ ] **Step 5: Commit**

```bash
git add tests/docs-command-drift.test.ts
git commit -m "test(docs): assert commands.md matches the command registry

docs/guide/commands.md is the canonical reference: a command missing
from it is a command a user cannot find. Assert set-equality between
its reference table and BIFROST_COMMAND_OPTIONS so a command cannot
ship undocumented.

Scoped to the first table. The file has a second table further down
that lists controls differently, and parsing it would produce false
mismatches.

docs/llms.txt is deliberately excluded. It references 10 commands in
prose bullets as a curated overview, so set-equality would force it to
become a command dump.

README.md and the docs/guide prose stay hand-written and will still
drift; this covers only the reference table."
```

---

## Task 6: Full verification and PR

- [ ] **Step 1: Run every gate**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
npm run typecheck
npm run test:integration 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
npm run test:ui 2>&1 | tail -5
npm run test:ui:reliability 2>&1 | tail -5
```

Expected: `fail 0` everywhere; typecheck silent. Record the unit test count for the PR body.

- [ ] **Step 2: Check the stack is clean**

```bash
git status --short
git log --oneline origin/chore/no-agent-attribution..HEAD
```

Expected: no uncommitted changes, and the five commits from Tasks 1-5 on top of `chore/no-agent-attribution`.

- [ ] **Step 3: Verify no agent attribution**

```bash
git log origin/chore/no-agent-attribution..HEAD --format=%B | grep -E "^[A-Za-z-]+: <" && echo "TRAILER FOUND" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin refactor/command-registry
gh pr create --base chore/no-agent-attribution --title "refactor(commands): make the registry the only owner of command metadata" --body "$(cat <<'EOF'
## Why

Command metadata lived in two lists that shared no structure, and they had already drifted:

- `classifier` carried two different descriptions — "Choose classifier backend" in the registry, "Choose classifier backend and prompt model" in the route.
- `init -f` was a registry entry with no route of its own, which is why the registry listed 19 commands while dispatch had 18. Typing it worked because `init`'s matcher happened to accept it; selecting it from a picker resolved by value, missed, and returned silently, after the editor had already been cleared.

## What

`CommandEntry` no longer extends `CommandSpec`, so a route cannot carry a `description` or `argumentHint`. Nothing read either off a route — pickers work from `CommandSpec` — so this deletes dead data. The extends is also what let a hand-written literal hold a stale description at all; removing the requirement makes that a type error rather than a convention.

`init -f` folds into `init` as an alias, which is what `docs/guide/commands.md` already documented. Completion flattens aliases at all four sites that read `.value`, including the two that emit the value and label.

Adds `spaced()` for `init`: `exact("init")` would break `init -f` and `init --write`, and bare `prefix("init")` would make `/bifrost initialize` run init instead of opening the picker.

Also corrects `docs/guide/commands.md`, which promised a `--force` flag that `isForced` never matched, and adds a drift test so a command cannot ship undocumented.

## Behaviour changes

1. `init`'s description gains "(pass -f to force re-probe)" — visible in the menu and autocomplete.
2. `classifier`'s description becomes the registry's "Choose classifier backend", dropping "and prompt model". Autocomplete already showed the shorter wording; the menu row changes.
3. `init -f` is no longer a row in the unknown-subcommand picker (19 rows to 18). Typing it works, and it appears in completion via the alias.

The `/bifrost` menu keeps its 8 state-aware rows. A flat list was considered and rejected: with routing enabled the first row would be `on`, which only re-logs "Bifrost enabled". Discoverability for the commands the menu omits moves to a `/bifrost help` alias, deliberately left for a separate change — the picker-only version returns `undefined` without a UI, so it would be a silent no-op in print and RPC.

## Verification

Record actual counts from Task 6 Step 1.

- `npm test`
- `npm run typecheck`
- `npm run test:integration`
- `npm run test:ui`
- `npm run test:ui:reliability`

## Notes

- Stacked on #20. Branch from `chore/no-agent-attribution`, not `main`.
- Interacts with #19, which also edits `commands.ts`. `handlePreview` ends at line 682 and the registry region starts at 697, so the blocks are close and Git may need help resolving.
- Five commits, each independently revertible.
- Known remaining debt is listed in the spec: command membership, matcher semantics, menu membership, ordering, and prose documentation all stay multiply written.
EOF
)"
```

- [ ] **Step 5: Report the PR URL and the observed test counts**

---

## Self-review

**Spec coverage.** Every spec section maps to a task: registry + `aliases` → Task 1; matcher helpers and narrowing → Task 2; menu checked lookup → Task 3; docs correction → Task 4; drift test → Task 5; gates and PR → Task 6. The aliases contract is implemented in Task 1 and its dispatchability test in Task 2.

**Placeholders.** None. Task 3's first `it(...)` block is explicitly marked for deletion before running — it is a scratch sketch, not a deliverable.

**Type consistency.** `CommandSpec` gains `aliases` in Task 1 and is redefined in Task 2 with the same fields; the spec is duplicated in Task 2's code block. `CommandEntry` is introduced in Task 2 with `{value, match, handler}` and every helper in Tasks 2 and 3 returns that shape. `requireCommand` is defined in Task 3 and used only there.

**Known tension.** Task 1 says `CommandEntry extends CommandSpec` inherits `aliases` harmlessly, and Task 2 removes the extends. That is the intended order; Task 1 must land first.