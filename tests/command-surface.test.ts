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
