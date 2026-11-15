import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { formatCostReport } from "../cost-report.ts";

const usage = (input: number, cost: number) => ({ input, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: input + 9, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });

describe("session cost report", () => {
  it("separates response, compaction, and auxiliary records without content leakage", () => {
    const entries = [
      { type: "message", message: { role: "assistant", provider: "p", model: "alias", responseModel: "openai/gpt-4", content: [{ type: "toolCall", name: "secret-tool", arguments: { canary: "TOOL-ARGS-CANARY" } }], usage: usage(10, 0.5) } },
      { type: "message", message: { role: "assistant", provider: "p", model: "openai/gpt-4", usage: usage(5, 0.25) } },
      { type: "compaction", usage: usage(7, 0.1), summary: "PROMPT-CANARY" },
      { type: "usage", kind: "cache_warm", usage: usage(999, 99) },
      { type: "message", message: { role: "toolResult", usage: usage(1, 0.05), content: "TOOL-ARGS-CANARY" } },
      { type: "branch_summary", usage: usage(2, 0.02), content: "PROMPT-CANARY" },
    ] as any;
    const report = formatCostReport(entries).join("\n");
    assert.match(report, /assistant p\/openai\/gpt-4: recorded input 15/);
    assert.match(report, /compaction \(model unspecified\): recorded input 7/);
    assert.match(report, /whole session: recorded input 1024/);
    assert.match(report, /compaction \(model unspecified\).*\$0\.100000 reported/);
    assert.match(report, /auxiliary usage entry: recorded input 999/);
    assert.match(report, /tool result: recorded input 1/);
    assert.match(report, /branch summary \(model unspecified\): recorded input 2/);
    assert.doesNotMatch(report, /CANARY|secret-tool|cache_warm/);
  });

  it("marks malformed usage and zero cost without implying free use", () => {
    const report = formatCostReport([
      { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: NaN, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
      { type: "message", message: { role: "assistant", provider: "p", model: "n", usage: usage(0, 0) } },
      { type: "message", message: { role: "assistant", provider: "p", model: "missing" } },
      null,
    ] as any).join("\n");
    assert.match(report, /partial; malformed\/missing usage.*1 incomplete fields\/records/);
    assert.match(report, /cost unavailable/);
    assert.match(report, /assistant p\/n: recorded input 0, output 2, cache read 3, cache write 4; \$0\.000000 reported/);
    assert.match(report, /assistant p\/missing: partial; malformed\/missing usage.*1 incomplete fields\/records/);
    assert.match(report, /unreadable session entries: 1/);
    assert.match(report, /Zero reported cost is not proof of free usage/);

    const incompleteWholeSession = formatCostReport([
      { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage(1, 0.1) } }, null,
    ] as any)[1];
    assert.match(incompleteWholeSession, /^whole session: partial; malformed\/missing usage/);
    assert.match(incompleteWholeSession, /cost unavailable/);
    assert.match(incompleteWholeSession, /1 incomplete fields\/records/);
  });

  it("registers and runs the real /bifrost cost command repeatedly", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-cost-command-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({ schemaVersion: 2, enabled: true, default: "general", strategy: "first", classifier: { enabled: false }, models: { general: [] } }));
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let recorded = [{ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage(10, 0.2) } }] as any;
    let viewer: any;
    let overlayOptions: any;
    const ui = {
      setEditorText: () => {},
      custom: async (factory: (...args: any[]) => any, options: unknown) => {
        overlayOptions = options;
        viewer = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
      },
    };
    const ctx = { cwd, mode: "rpc", hasUI: false, model: {}, modelRegistry: { getAvailable: () => [], find: () => undefined, getProviderAuthStatus: () => ({ configured: false }), refresh: async () => ({ refreshed: [], errors: [] }) }, sessionManager: { getEntries: () => recorded }, ui } as unknown as ExtensionContext;
    let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, context: ExtensionContext) => Promise<void> }) => { if (name === "bifrost") command = options.handler; },
      on: () => () => {},
      registerTool: () => {},
      registerVirtualModel: () => {},
    } as unknown as ExtensionAPI;
    const output: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
      bifrostExtension(pi);
      assert.ok(command);
      await command("cost", ctx);
      await command("cost", ctx);
      assert.equal(output.length, 12);
      assert.equal(output.filter((value) => value.includes("whole session: recorded input 10")).length, 2);

      recorded = Array.from({ length: 16 }, (_, index) => ({ type: "message", message: { role: "assistant", provider: "fake", model: `model-${String(index).padStart(2, "0")}`, usage: usage(index, 0.1) } })) as any;
      const tuiCtx = Object.assign(ctx, { mode: "tui", hasUI: true });
      await command("cost", tuiCtx);
      assert.equal(overlayOptions.overlay, true);
      assert.match(viewer.render(120).join("\n"), /↑↓\/jk scroll/);
      viewer.handleInput("\x1b[6~");
      assert.match(viewer.render(120).join("\n"), /assistant fake\/model-15/);
    } finally {
      console.error = originalError;
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
