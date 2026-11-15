import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createHttpFixture, readStats, startFakeProviderServer, startRpc, statsEntriesDelta,
} from "../fixtures/http-pi-harness.mjs";

const PROMPT_CANARY = "COST_PROMPT_CANARY_8d31";
let server;

function snapshotBifrostFiles(roots) {
  const found = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /bifrost/i.test(entry.name)) found[path] = readFileSync(path);
    }
  };
  for (const root of roots) visit(root);
  return found;
}

before(async () => { server = await startFakeProviderServer(); });
after(async () => { await server?.stop(); });

describe("session cost command with real Pi", () => {
  it("reports recorded usage without generating or exposing prompt content", async () => {
    const fixture = createHttpFixture({
      prefix: "bifrost-cost-report",
      port: server.port,
      models: [{ id: "chat" }],
      settings: { retry: { enabled: false }, enabledModels: ["fake/*"] },
      config: { schemaVersion: 2, enabled: true, default: "general", strategy: "first", classifier: { enabled: false }, models: { general: ["fake/chat"] } },
    });
    const rpc = startRpc({ fixture, server, model: "fake/chat" });
    let scenarioError;
    try {
      const beforeCost = await readStats(server.port);
      await rpc.prompt(`${PROMPT_CANARY} answer briefly`);
      const afterGeneration = await readStats(server.port);
      assert.equal((afterGeneration.attempts.chat ?? 0) - (beforeCost.attempts.chat ?? 0), 1);
      const bifrostFilesBefore = snapshotBifrostFiles([fixture.work, fixture.home]);
      const report = await rpc.prompt("/bifrost cost", { expectedStderr: "[bifrost]   No baseline is available to determine savings." });
      const combined = `${report.stderr}\n${report.response?.data?.content ?? ""}`;
      assert.match(report.stderr, /Current branch: \$\d/);
      assert.match(report.stderr, /fake\/chat/);
      assert.doesNotMatch(report.stderr, new RegExp(PROMPT_CANARY));
      const afterReport = await readStats(server.port);
      assert.deepEqual(statsEntriesDelta(afterGeneration, afterReport), [], "cost command must not make provider requests");
      assert.deepEqual(snapshotBifrostFiles([fixture.work, fixture.home]), bifrostFilesBefore, "cost command must not write Bifrost files");
      assert.equal(combined.includes(PROMPT_CANARY), false);
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      try {
        const closed = await rpc.close({ assertClean: true });
        assert.equal(closed.groupGone, true, "Pi RPC process group must be gone before fixture cleanup");
        fixture.cleanup();
      } catch (cleanupError) {
        if (scenarioError) throw new AggregateError([scenarioError, cleanupError], "cost acceptance scenario and teardown failed");
        throw cleanupError;
      }
    }
  });
});
