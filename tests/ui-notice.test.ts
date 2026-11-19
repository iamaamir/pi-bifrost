import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "@earendil-works/pi-tui";
import { log, registerBifrostNotices } from "../ui/notice.ts";

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

test("notice card keeps old-host failure output bounded and links complete results", () => {
  const failingModels = Array.from({ length: 400 }, (_, i) => `· provider/model-${i}`);
  const largeEntry = {
    data: {
      ...entry.data,
      details: ["400 failed", "provider errors ×400", "full errors: .pi/bifrost-probe.json"],
      expandedDetails: [
        "400 failed",
        "provider errors ×400",
        ...failingModels,
        "full errors: .pi/bifrost-probe.json",
      ],
    },
  };
  const render = makeRenderer()(largeEntry as never, {} as never, theme as never) as {
    render(width: number): string[];
  };
  const text = render.render(80).join("\n");
  assert.ok(text.includes("400 failed"), text);
  assert.ok(text.includes("full errors: .pi/bifrost-probe.json"), text);
  assert.ok(!text.includes("provider/model-0"), text);
  assert.ok(!text.includes("provider/model-399"), text);
  assert.ok(!text.includes("to expand"), text);
  assert.ok(text.split("\n").length < 10, text);
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

test("headless notices stay on stderr for every level", () => {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const seen: Array<[string, string]> = [];
  const record = (stream: string) => (...values: unknown[]) => {
    seen.push([stream, values.map(String).join(" ")]);
  };
  console.log = record("log");
  console.info = record("info");
  console.warn = record("warn");
  console.error = record("error");
  try {
    for (const level of ["info", "success", "warning", "error"] as const) {
      log({ hasUI: false, mode: "print" } as never, "Title", "Message", level);
    }
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  assert.deepEqual(seen.map(([stream]) => stream), ["error", "error", "warn", "error"]);
  assert.ok(seen.every(([, line]) => line === "[bifrost] Title: Message"), JSON.stringify(seen));
});
