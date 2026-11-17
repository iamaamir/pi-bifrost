import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "@earendil-works/pi-tui";
import { registerBifrostNotices } from "../ui/notice.ts";

function makeRenderer() {
  let renderer: ((entry: never, options: never, theme: never) => unknown) | undefined;
  registerBifrostNotices({
    registerEntryRenderer: (_type: string, fn: never) => {
      renderer = fn as never;
    },
    appendEntry: () => {},
  } as never);
  assert.ok(renderer, "renderer was not registered");
  return renderer!;
}

const theme = {
  colors: {
    toolPendingBg: parseColor("#1a242b"),
    success: parseColor("#8bc34a"),
    error: parseColor("#e57373"),
    warning: parseColor("#ffb74d"),
    muted: parseColor("#90a4ae"),
  },
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  style: (t: string) => t,
};

const entry = {
  data: {
    title: "Probe finished with failures",
    level: "warning",
    message: "9 of 475 models are working",
    details: ["465 failed · 1 timed out", "provider errors        ×436", "timed out              ×  1 — openai/gpt-4o-mini"],
    expandedDetails: [
      "465 failed · 1 timed out",
      "provider errors ×436",
      "· openai/chat-latest",
      "· openai/chat-2024",
      "timed out ×1",
      "· openai/gpt-4o-mini",
    ],
  },
};

test("notice card stays compact when collapsed and hints the expand key", () => {
  const render = makeRenderer()(entry as never, { expanded: false, keyHint: (_k: string, d: string) => `ctrl+o ${d}` } as never, theme as never) as {
    render(width: number): string[];
  };
  const text = render.render(80).join("\n");
  assert.ok(text.includes("×436"), text);
  assert.ok(!text.includes("openai/chat-latest"), text);
  assert.ok(text.includes("ctrl+o to expand"), text);
});

test("notice card lists every failing model when expanded", () => {
  const render = makeRenderer()(entry as never, { expanded: true, keyHint: (_k: string, d: string) => `ctrl+o ${d}` } as never, theme as never) as {
    render(width: number): string[];
  };
  const text = render.render(80).join("\n");
  assert.ok(text.includes("openai/chat-latest"), text);
  assert.ok(text.includes("openai/gpt-4o-mini"), text);
  assert.ok(!text.includes("to expand"), text);
});
