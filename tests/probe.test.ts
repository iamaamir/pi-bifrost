import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe } from "../probe.ts";

describe("probe transport", () => {
  it("uses provider.streamSimple", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-"));
    const model = {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      cost: { input: 0.75, output: 4.5 },
      baseUrl: "https://example.invalid/v1",
    };
    const cwdBefore = process.cwd();

    try {
      const ctx = {
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [{ type: "text", text: "2" }],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      process.chdir(cwd);
      const result = await runProbe(ctx);
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to minimal session when stream is empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-probe-"));
    const model = {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      cost: { input: 0.75, output: 4.5 },
      baseUrl: "https://example.invalid/v1",
    };
    const cwdBefore = process.cwd();

    try {
      const ctx = {
        cwd,
        modelRegistry: {
          getAvailable: () => [model],
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4-mini",
                content: [],
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "error",
                errorMessage: "empty response",
                timestamp: Date.now(),
              }),
            }),
          }),
          getProviderAuth: async () => ({ auth: { apiKey: "key" } }),
        },
      } as never;

      process.chdir(cwd);
      const result = await runProbe(ctx, undefined, async () => "2");
      assert.equal(result.results[0]?.status, "ok");
      assert.equal(result.results[0]?.model, "gpt-5.4-mini");
    } finally {
      process.chdir(cwdBefore);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
