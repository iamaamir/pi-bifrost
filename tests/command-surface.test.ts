import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BIFROST_COMMAND_OPTIONS,
  bifrostModePhrase,
  dashboardCommands,
} from "../commands.ts";
import {
  buildCommandSurface,
  main,
  renderJson,
  renderMarkdown,
  type SurfaceRow,
} from "../scripts/command-surface.ts";

// The three group labels are a contract in both renderers: they are the markdown
// headings and the JSON `groups[].label`. Written out here rather than imported,
// because GROUP_LABELS is not exported and a test that read it back could only
// ever confirm the renderer used the list it was handed.
const GROUP_LABELS = ["State toggles", "Common", "Everything else"];

// BIFROST_COMMAND_OPTIONS is module-level shared state and is typed readonly, so
// a probe has to cast its way in and restore the length in a finally. Without
// the restore the rest of the suite would see the extra entries.
type ProbeSpec = {
  value: string;
  description: string;
  menu?: "common";
  argumentHint?: string;
  reflects?: { state: "enabled" | "pinned"; sets: boolean; note: string };
};

function withProbes<T>(extra: ProbeSpec[], fn: () => T): T {
  const registry = BIFROST_COMMAND_OPTIONS as unknown as ProbeSpec[];
  const original = registry.length;
  registry.push(...extra);
  try {
    return fn();
  } finally {
    registry.length = original;
  }
}

// Splits one rendered table row into its cells. Asserting the cell count, not
// just that the text is present, is what catches an unescaped pipe: the pipe
// turns into a fourth column and every cell after it shifts left.
function cellsOf(row: string): string[] {
  assert.ok(row.startsWith("| ") && row.endsWith(" |"), `not a table row: ${row}`);
  return row
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

// The rendered row for one command. Matched on the cell's own opening so a value
// that carries an argument hint is still found.
function rowFor(markdown: string, value: string): string {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith(`| \`/bifrost ${value}`));
  assert.ok(row, `no rendered row for ${value}`);
  return row;
}

async function captureRunAsync(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => chunks.push(parts.join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

describe("command-surface cli", () => {
  it("defaults to routing on, unpinned", async () => {
    const parsed = JSON.parse(await captureRunAsync(() => main(["--json"])));
    assert.deepEqual(parsed.state, { enabled: true, pinned: false });
    assert.equal(
      parsed.groups[0].rows.slice(0, 4).map((r: { value: string }) => r.value).join(","),
      "off,on,pin,unpin",
    );
  });

  it("honours both state flags", async () => {
    const parsed = JSON.parse(
      await captureRunAsync(() => main(["--json", "--enabled=false", "--pinned=true"])),
    );
    assert.deepEqual(parsed.state, { enabled: false, pinned: true });
    assert.equal(
      parsed.groups[0].rows.slice(0, 4).map((r: { value: string }) => r.value).join(","),
      "on,off,unpin,pin",
    );
  });

  // The false half of each flag pair had no case of its own. Only `--pinned=true`
  // and the unpinned default were exercised, so the assignment could be
  // tightened from "anything but false" to "literally true" — a change no test
  // could see, because on the two values strict validation accepts the two
  // spellings agree.
  it("reads --pinned=false as false, not as any value that is not true", async () => {
    const out = await captureRunAsync(() => main(["--json", "--pinned=false"]));
    assert.deepEqual(JSON.parse(out).state, { enabled: true, pinned: false });
    assert.match(out, /"pinned": false/);
    // The state also has to reach the rows, or a flag could be parsed and then
    // dropped before the surface was built.
    assert.equal(
      JSON.parse(out).groups[0].rows.slice(0, 4).map((r: { value: string }) => r.value).join(","),
      "off,on,pin,unpin",
    );
  });

  it("emits markdown by default", async () => {
    const out = await captureRunAsync(() => main([]));
    assert.match(out, /^Bifrost command surface/);
    assert.match(out, /## State toggles/);
  });

  it("rejects an unknown flag", async () => {
    await assert.rejects(() => main(["--nope"]), /unknown flag/);
  });

  // `--enabled=no` used to mean enabled. Reading every value that is not "false"
  // as true turned a typo into a silent state flip, while USAGE promised only
  // true or false.
  it("rejects a flag value that is neither true nor false", async () => {
    for (const flag of ["--enabled", "--pinned"]) {
      await assert.rejects(() => main([`${flag}=yes`]), /invalid value for/, `${flag}=yes`);
      await assert.rejects(() => main([`${flag}=`]), /invalid value for/, `${flag}= with no value`);
    }
  });
});

describe("dashboardCommands", () => {
  it("returns every registered command exactly once", () => {
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
    // Without the total, the four checks above would also pass if some other row
    // were wrongly inert, so "exactly" needs the count to back it up. Two
    // reflected pairs, so exactly two no-ops at any state.
    for (const state of [
      { enabled: true, pinned: false },
      { enabled: true, pinned: true },
      { enabled: false, pinned: false },
      { enabled: false, pinned: true },
    ]) {
      const inert = buildCommandSurface(state).filter((r) => r.inert);
      assert.deepEqual(
        inert.map((r) => r.value).sort(),
        BIFROST_COMMAND_OPTIONS.filter((c) => c.reflects)
          .filter((c) => c.reflects!.sets === state[c.reflects!.state as "enabled" | "pinned"])
          .map((c) => c.value)
          .sort(),
      );
      assert.equal(inert.length, 2);
    }
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

describe("group placement", () => {
  it("puts a menu:common probe in Common and a bare probe in Everything else", () => {
    const state = { enabled: true, pinned: false };
    withProbes(
      [
        { value: "zeta common", description: "probe in the common group", menu: "common" },
        { value: "alpha bare", description: "probe in the tail group" },
      ],
      () => {
        const markdown = renderMarkdown(buildCommandSurface(state), state);
        const common = markdown.split("## Common")[1].split("## Everything else")[0];
        const tail = markdown.split("## Everything else")[1];
        assert.match(common, /zeta common/);
        assert.doesNotMatch(common, /alpha bare/);
        assert.match(tail, /alpha bare/);
        assert.doesNotMatch(tail, /zeta common/);
      },
    );
  });

  });

describe("bifrostModePhrase", () => {
  // All four states are pinned because the header has to agree with the
  // dashboard title on every one of them. `off` only clears `enabled` and `pin`
  // only sets `pinned`, so {enabled: false, pinned: true} is reachable — and it
  // is the state the two copies disagreed on.
  it("names the mode the way the dashboard title does, for all four states", () => {
    for (const [state, expected] of [
      [{ enabled: true, pinned: false }, "on"],
      [{ enabled: true, pinned: true }, "pinned"],
      [{ enabled: false, pinned: false }, "off"],
      [{ enabled: false, pinned: true }, "off"],
    ] as const) {
      assert.equal(bifrostModePhrase(state), expected);
      // The header is the generator's own wording, so it is checked against the
      // same function: a reintroduced local phrase would fail here.
      assert.match(
        renderMarkdown(buildCommandSurface(state), state),
        new RegExp(`^Bifrost command surface — routing ${expected}$`, "m"),
      );
    }
  });
});

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

  it("emits one three-column header per group and nothing else in the header row", () => {
    const lines = renderMarkdown(rows, state).split("\n");
    // Asserted whole rather than by regex: a fourth column appended to the
    // header still matches every `contains`-shaped check, and a markdown table
    // takes its shape from the header, so an extra column there misaligns every
    // data row too.
    assert.deepEqual(
      lines.filter((line) => line.startsWith("| Command")),
      GROUP_LABELS.map(() => "| Command | Description | Note |"),
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith("|---")),
      GROUP_LABELS.map(() => "|---|---|---|"),
    );
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

  // The note and the argument hint come from a registry that contributors edit,
  // so neither is reachable today and both are latent rather than absent. A pipe
  // in either one splits the row: marked then reads four columns, the first cell
  // lands in the wrong place, and every assertion that only looks for the text
  // still passes. So each case asserts the cell count, not the substring.
  it("escapes a pipe in the note so the row stays three columns", () => {
    const note = "already pinned | see docs";
    const pinned = { enabled: true, pinned: true };
    const markdown = withProbes(
      [
        {
          value: "pipe note",
          description: "probe with a pipe in its note",
          reflects: { state: "pinned", sets: true, note },
        },
      ],
      () => renderMarkdown(buildCommandSurface(pinned), pinned),
    );
    const cells = cellsOf(rowFor(markdown, "pipe note"));
    assert.equal(cells.length, 3);
    assert.equal(cells[0], "`/bifrost pipe note`");
    assert.equal(cells[1], "probe with a pipe in its note");
    assert.equal(cells[2], "already pinned \\| see docs");
  });

  it("escapes a pipe in the argument hint so the code span stays one cell", () => {
    const markdown = withProbes(
      [
        {
          value: "pipe hint",
          description: "probe with a pipe in its hint",
          argumentHint: "--json | tee <prompt>",
        },
      ],
      () => renderMarkdown(buildCommandSurface(state), state),
    );
    const cells = cellsOf(rowFor(markdown, "pipe hint"));
    assert.equal(cells.length, 3);
    // Only the pipe is escaped: the hint sits inside the cell's code span, where
    // `<prompt>` is already safe and backtick-wrapping it would show the
    // backticks literally.
    assert.equal(cells[0], "`/bifrost pipe hint --json \\| tee <prompt>`");
    assert.equal(cells[2], "");
  });
});

describe("renderJson", () => {
  it("labels every group with the same words the markdown headings use", () => {
    const state = { enabled: true, pinned: false };
    const parsed = JSON.parse(renderJson(buildCommandSurface(state), state));
    // Unpinned before this, a rename in GROUP_LABELS failed only the markdown
    // heading assertion, so the machine-readable labels were free to drift.
    assert.deepEqual(
      parsed.groups.map((g: { label: string }) => g.label),
      GROUP_LABELS,
    );
    // Both renderers read the same list, so the headings cannot disagree with the
    // labels asserted above.
    const markdown = renderMarkdown(buildCommandSurface(state), state);
    for (const label of GROUP_LABELS) {
      assert.match(markdown, new RegExp(`^## ${label}$`, "m"));
    }
  });

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
