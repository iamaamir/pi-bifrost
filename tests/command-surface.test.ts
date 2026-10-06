import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BIFROST_COMMAND_OPTIONS, dashboardCommands } from "../commands.ts";
import { buildCommandSurface } from "../scripts/command-surface.ts";

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
