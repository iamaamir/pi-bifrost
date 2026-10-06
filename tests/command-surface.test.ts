import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BIFROST_COMMAND_OPTIONS, dashboardCommands } from "../commands.ts";
import {
  buildCommandSurface,
  main,
  renderJson,
  renderMarkdown,
  type SurfaceRow,
} from "../scripts/command-surface.ts";

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

  it("emits markdown by default", async () => {
    const out = await captureRunAsync(() => main([]));
    assert.match(out, /^Bifrost command surface/);
    assert.match(out, /## State toggles/);
  });

  it("rejects an unknown flag", async () => {
    await assert.rejects(() => main(["--nope"]), /unknown flag/);
  });
});

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

describe("renderMarkdown", () => {
  const state = { enabled: true, pinned: false };
  const rows = buildCommandSurface(state);

  it("renders command order identical to the dashboard", () => {
    const markdown = renderMarkdown(rows, state);
    const rendered = rows
      .map((row) => new RegExp(`^\\| \`/bifrost ${row.value}[^\`]*\` \\|`, "m").test(markdown))
      .every(Boolean);
    assert.ok(rendered);
    // Compare whole cells, not bare values: values contain spaces (`classifier
    // status`) and two of them carry an argument hint, so a value-only capture
    // would either truncate or leave the hint attached.
    const order = [...markdown.matchAll(/^\| `\/bifrost (.+?)` \|/gm)].map((match) => match[1]);
    const expected = dashboardCommands(state).map((spec) => {
      const hint = spec.argumentHint ? ` ${spec.argumentHint}` : "";
      return `${spec.value}${hint}`;
    });
    assert.deepEqual(order, expected);
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

  it("carries the state note on the no-op row only", () => {
    const markdown = renderMarkdown(rows, state);
    assert.match(markdown, /\| `\/bifrost on` \| Enable routing \| already on \|/);
    // An absent note leaves an empty cell, so the two delimiters are separated
    // by padding rather than sitting flush: `| |` would never match.
    assert.match(markdown, /\| `\/bifrost off` \| Disable routing \|\s+\|/);
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
