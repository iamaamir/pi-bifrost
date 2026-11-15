import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const debugModule = pathToFileURL(join(root, "debug.ts")).href;

function runDebugProbe(path, env) {
  const source = `
    import { debug, flushDebug, setupDebug } from ${JSON.stringify(debugModule)};
    setupDebug({ enabled: true, path: ${JSON.stringify(path)} }, ${JSON.stringify(root)});
    debug("contract", "sentinel");
    await flushDebug(1000);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(`probe exited ${code}: ${stderr}`)));
  });
}

describe("host contract debug projection", () => {
  it("keeps unsupported subagent metadata out of emitted records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-contract-"));
    const path = join(directory, "trace.jsonl");
    try {
      await runDebugProbe(path, {
        PI_SUBAGENT_RUN_ID: "unsupported-run-id",
        PI_SUBAGENT_CHILD_AGENT: "unsupported-agent",
        PI_SUBAGENT_PARENT_DEPTH: "unsupported-depth",
        BIFROST_PATTERN_RUN_ID: "supported-pattern-id",
      });
      const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.subagent_run_id, undefined);
        assert.equal(row.agent, undefined);
        assert.equal(row.depth, undefined);
        assert.equal(row.pattern_run_id, "supported-pattern-id");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
