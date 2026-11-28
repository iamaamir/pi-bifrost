import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCommandRoutes,
  BIFROST_COMMAND_OPTIONS,
  bifrostModePhrase,
  commandSurface,
  getBifrostCommandCompletions,
  matchesCommand,
  type CommandSpec,
} from "../catalog.ts";

describe("command catalog and completions", () => {
  it("surfaces command descriptions in autocomplete", () => {
    const items = getBifrostCommandCompletions("class") ?? [];
    assert(items.some((item) => item.value === "classifier status" && item.description === "Show classifier state"));
    assert(items.some((item) => item.value === "classifier off" && item.description === "Disable LLM classifier for this session"));
  });

  it("submits exact commands without requiring a second Enter", () => {
    assert.equal(getBifrostCommandCompletions("classifier status"), null);
    assert.equal(getBifrostCommandCompletions("classifier"), null);
  });

  it("keeps the preview completion label and description stable", () => {
    // Tab completion shows `value`/`label`/`description` only — the argument hint
    // is not part of a completion item, so the flag is discoverable in the menu
    // and not in the completion list. Pinned here so that split is a deliberate
    // record rather than an accident.
    const items = getBifrostCommandCompletions("prev") ?? [];
    assert.deepEqual(items, [{
      value: "preview",
      label: "preview",
      description: "Preview routing for a prompt",
    }]);
  });

  it("declares init -f as an alias of init", () => {
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
    // "init -" isolates the alias: it is the only entry that matches, so this
    // cannot pass by `init` merely prefix-matching. Under "ini" both entries
    // are returned and the assertion could not tell them apart.
    const items = getBifrostCommandCompletions("init -");
    assert.ok(items?.some((i) => i.value === "init -f" && i.label === "init -f"));
  });

  it("still emits init itself alongside its alias", () => {
    const items = getBifrostCommandCompletions("ini") ?? [];
    assert.ok(items.some((i) => i.value === "init" && i.label === "init"));
    assert.ok(items.some((i) => i.value === "init -f"));
  });

  it("submits an exact alias instead of offering a completion", () => {
    assert.equal(getBifrostCommandCompletions("init -f"), null);
  });

  it("registers validate and inspect with JSON argument hints", () => {
    for (const command of ["validate", "inspect"]) {
      const spec = BIFROST_COMMAND_OPTIONS.find((item) => item.value === command);
      assert.equal(spec?.argumentHint, "[--json]");
      assert.equal(getBifrostCommandCompletions(command), null, "complete command submits without a suggestion");
      assert.ok(getBifrostCommandCompletions(command.slice(0, 1))?.some((item) => item.value === command));
    }
  });

  it("normalizes case and surrounding whitespace and returns null for unknown input", () => {
    assert.deepEqual(getBifrostCommandCompletions("  PREV "), getBifrostCommandCompletions("prev"));
    assert.equal(getBifrostCommandCompletions("unknown command"), null);
  });
});

describe("command surface", () => {
  it("shows a registry entry that declares neither menu nor reflects", () => {
    const catalog = [...BIFROST_COMMAND_OPTIONS, { value: "probe entry", description: "Temporary probe" }];
    const rows = commandSurface({ enabled: true, pinned: false }, catalog);
    assert.equal(rows.length, catalog.length);
    assert.deepEqual(rows.at(-1), { spec: catalog.at(-1), group: "other", inert: false, note: null });
  });

  it("places and annotates a reflected entry declared only in the registry", () => {
    const probe: CommandSpec = {
      value: "probe mute",
      description: "Temporary probe",
      reflects: { state: "enabled", sets: false, note: "already off" },
    };
    const catalog = [probe, ...BIFROST_COMMAND_OPTIONS];
    const actionable = commandSurface({ enabled: true, pinned: false }, catalog);
    assert.deepEqual(actionable[0], { spec: probe, group: "state", inert: false, note: null });
    const inert = commandSurface({ enabled: false, pinned: false }, catalog);
    assert.deepEqual(inert[1], { spec: probe, group: "state", inert: true, note: "already off" });
  });

  it("cannot go stale when a command is renamed in the registry", () => {
    const catalog = [{ ...BIFROST_COMMAND_OPTIONS[0], value: "renamed" }, ...BIFROST_COMMAND_OPTIONS.slice(1)];
    const rows = commandSurface({ enabled: true, pinned: false }, catalog);
    assert.ok(rows.some(({ spec }) => spec.value === "renamed"));
    assert.ok(!rows.some(({ spec }) => spec.value === "on"));
  });

  for (const enabled of [true, false]) {
    for (const pinned of [true, false]) {
      it("orders and annotates every command for enabled=" + enabled + ", pinned=" + pinned, () => {
        const state = { enabled, pinned };
        const rows = commandSurface(state);
        assert.deepEqual(rows.slice(0, 4).map(({ spec }) => spec.value), [
          ...(enabled ? ["off", "on"] : ["on", "off"]),
          ...(pinned ? ["unpin", "pin"] : ["pin", "unpin"]),
        ]);
        assert.deepEqual(rows.slice(0, 4).map(({ inert }) => inert), [false, true, false, true]);
        assert.deepEqual(rows.slice(0, 4).map(({ note }) => note), [
          null, enabled ? "already on" : "already off",
          null, pinned ? "already pinned" : "already unpinned",
        ]);
        assert.deepEqual(rows.slice(4).map(({ spec }) => spec.value),
          BIFROST_COMMAND_OPTIONS.filter((spec) => spec.menu === "common").concat(
            BIFROST_COMMAND_OPTIONS.filter((spec) => !spec.menu && !spec.reflects),
          ).map((spec) => spec.value));
        assert.deepEqual(rows.map(({ spec }) => spec.value).sort(),
          BIFROST_COMMAND_OPTIONS.map((spec) => spec.value).sort());
        assert.equal(rows.find(({ spec }) => spec.value === "on")?.spec.description, "Enable routing");
        assert.equal(bifrostModePhrase(state), !enabled ? "off" : pinned ? "pinned" : "on");
      });
    }
  }
});

describe("matching semantics", () => {
  it("keeps exact, bare prefix and space-bounded matching distinct", () => {
    assert.equal(matchesCommand("exact", "classifier", "classifier"), true);
    assert.equal(matchesCommand("exact", "classifier", "classifier status"), false);
    assert.equal(matchesCommand("prefix", "preview", "preview"), true);
    assert.equal(matchesCommand("prefix", "preview", "previewxyz"), true);
    assert.equal(matchesCommand("prefix", "benchmark", "benchmark prompt"), true);
    assert.equal(matchesCommand("spaced", "init", "init"), true);
    assert.equal(matchesCommand("spaced", "init", "init -f"), true);
    assert.equal(matchesCommand("spaced", "init", "initialize"), false);
    assert.equal(matchesCommand("spaced", "init", "init\t-f"), false);
    assert.equal(matchesCommand("spaced", "init", "initfoo"), false);
  });
});

describe("catalog-to-route consistency", () => {
  const catalog: readonly CommandSpec[] = [
    { value: "on", description: "On" },
    { value: "init", description: "Init", aliases: ["init -f"] },
    { value: "config reconcile", description: "Reconcile", argumentHint: "[flags]" },
    { value: "config migrate", description: "Migrate", argumentHint: "[flags]" },
  ];
  const exact = (value: string) => ({ value, match: (sub: string) => matchesCommand("exact", value, sub) });
  const spaced = (value: string) => ({ value, match: (sub: string) => matchesCommand("spaced", value, sub) });
  const routes = [exact("on"), spaced("init"), spaced("config")];

  it("accepts parent handlers, direct handlers and completion-only aliases", () => {
    assert.doesNotThrow(() => assertCommandRoutes(routes, catalog));
  });

  it("rejects missing or overlapping executable routes", () => {
    assert.throws(() => assertCommandRoutes(routes.slice(1), catalog), /one route for command "on"/);
    assert.throws(() => assertCommandRoutes([...routes, exact("on")], catalog), /one route for command "on"/);
  });

  it("rejects a handler not represented by any catalog entry", () => {
    assert.throws(() => assertCommandRoutes([...routes, exact("orphan")], catalog), /unadvertised route "orphan"/);
  });

  it("rejects a grouped command without a prefill hint or direct handler", () => {
    const changed = catalog.map((spec) => spec.value === "config reconcile" ? { ...spec, argumentHint: undefined } : spec);
    assert.throws(() => assertCommandRoutes(routes, changed), /no direct dashboard route/);
  });

  it("rejects aliases that are missing, ambiguous or handled by the wrong route", () => {
    assert.throws(() => assertCommandRoutes([exact("on"), exact("init"), spaced("config")], catalog), /one route for command "init -f"/);
    assert.throws(() => assertCommandRoutes([...routes, exact("init -f")], catalog), /one route for command "init -f"/);
    assert.throws(() => assertCommandRoutes([exact("on"), exact("init"), exact("init -f"), spaced("config")], catalog), /alias reaches a different route/);
  });

  it("rejects duplicate catalog names", () => {
    assert.throws(() => assertCommandRoutes(routes, [...catalog, catalog[0]]), /duplicate command or alias "on"/);
  });
});

describe("additional catalog fault controls", () => {
  it("returns the complete canonical and alias inventory for empty input", () => {
    const expected = BIFROST_COMMAND_OPTIONS.flatMap(({ value, description, aliases }) =>
      [value, ...(aliases ?? [])].map((name) => ({ value: name, label: name, description })),
    );
    assert.deepEqual(getBifrostCommandCompletions(""), expected);
  });

  it("sorts interleaved catalog entries into explicit groups", () => {
    const catalog: readonly CommandSpec[] = [
      { value: "other-a", description: "Other A" },
      { value: "common-a", description: "Common A", menu: "common" },
      { value: "pin", description: "Pin", reflects: { state: "pinned", sets: true, note: "pinned" } },
      { value: "on", description: "On", reflects: { state: "enabled", sets: true, note: "on" } },
      { value: "other-b", description: "Other B" },
      { value: "unpin", description: "Unpin", reflects: { state: "pinned", sets: false, note: "unpinned" } },
      { value: "common-b", description: "Common B", menu: "common" },
      { value: "off", description: "Off", reflects: { state: "enabled", sets: false, note: "off" } },
    ];
    assert.deepEqual(commandSurface({ enabled: true, pinned: true }, catalog).map(({ spec, group, inert, note }) => [spec.value, group, inert, note]), [
      ["unpin", "state", false, null], ["pin", "state", true, "pinned"],
      ["off", "state", false, null], ["on", "state", true, "on"],
      ["common-a", "common", false, null], ["common-b", "common", false, null],
      ["other-a", "other", false, null], ["other-b", "other", false, null],
    ]);
  });

  it("rejects a duplicate completion alias even when both match the same route", () => {
    const route = { value: "init", match: (sub: string) => matchesCommand("spaced", "init", sub) };
    const spec: CommandSpec = { value: "init", description: "Init", aliases: ["init -f", "init -f"] };
    assert.throws(() => assertCommandRoutes([route], [spec]), /duplicate command or alias "init -f"/);
  });
});
