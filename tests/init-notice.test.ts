import { it } from "node:test";
import assert from "node:assert/strict";
import { log, registerBifrostNotices } from "../ui/notice.ts";

it("appends an init notice in TUI and falls back when append fails", () => {
  const entries: unknown[] = [];
  const notifications: string[] = [];
  const pi = { registerEntryRenderer: () => {}, appendEntry: (...args: unknown[]) => entries.push(args) };
  registerBifrostNotices(pi as never);
  const ctx = { mode: "tui", hasUI: true, ui: { notify: (message: string) => notifications.push(message) } };
  log(ctx as never, "Init", "Routing disabled", "warning");
  assert.equal(entries.length, 1);
  assert.match(JSON.stringify(entries), /Routing disabled/);
  pi.appendEntry = () => { throw new Error("no session"); };
  log(ctx as never, "Init", "not saved", "error");
  assert.deepEqual(notifications, ["Init: not saved"]);
});

it("writes headless notices to stderr rather than appending", () => {
  const lines: string[] = [];
  const previous = console.error;
  console.error = (message: string) => { lines.push(message); };
  try { log({ hasUI: false } as never, "Init", "not saved", "error"); }
  finally { console.error = previous; }
  assert.deepEqual(lines, ["[bifrost] Init: not saved"]);
});
