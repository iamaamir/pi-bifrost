import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, "..", "index.ts");

const PI_ARGS = [
  "-e",
  EXTENSION_PATH,
  "--approve",
  "--no-session",
  "--print",
  "-p",
];

async function runPi(command, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", [...PI_ARGS, command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`pi timed out: ${command}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, 120_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`pi exited ${code}: ${command}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function combined(output) {
  return `${output.stderr}\n${output.stdout}`;
}

describe("bifrost integration", { timeout: 300_000, concurrency: 1 }, () => {
  before(async () => {
    await runPi("/bifrost cache clear");
  });

  it("reports classifier status", async () => {
    const out = combined(await runPi("/bifrost classifier status"));
    assert.ok(out.includes("enabled=true"));
    assert.ok(out.includes("opencode/mimo-v2.5-free"));
    assert.ok(out.includes("endpoint=registry"));
  });

  it("classifies hello as economical", async () => {
    const out = combined(await runPi("/bifrost preview hello"));
    assert.ok(out.includes("source:    classifier"));
    assert.ok(out.includes("category:  economical"));
  });

  it("classifies architecture prompt as frontier", async () => {
    const out = combined(await runPi("/bifrost preview plan the architecture"));
    assert.ok(out.includes("source:    classifier"));
    assert.ok(out.includes("category:  frontier"));
  });

  it("caches classifications", async () => {
    await runPi("/bifrost cache clear");
    let out = combined(await runPi("/bifrost cache stats"));
    assert.ok(out.includes("cache: 0 entries"));

    // Run a live prompt. Routing to the local economical model may fail,
    // but the classifier result is still cached before routing.
    try {
      await runPi("format this file");
    } catch {
      // acceptable; routing failure is not the concern of this test
    }

    out = combined(await runPi("/bifrost cache stats"));
    assert.ok(out.includes("cache: 1 entries"));

    out = combined(await runPi("/bifrost preview format this file"));
    assert.ok(out.includes("source:    cache"));
  });

  it("falls back to regex when classifier is disabled in config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-test-"));
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi", "bifrost.json"),
      JSON.stringify({ classifier: { enabled: false } }),
    );

    try {
      const out = combined(
        await runPi("/bifrost preview lint this file", tempDir),
      );
      assert.ok(out.includes("source:    regex"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies without endpoint when model is in pi registry", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-test-"));
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi", "bifrost.json"),
      JSON.stringify({
        classifier: { model: "lmstudio/qwen/qwen3-vl-8b" },
        models: {
          economical: "lmstudio/qwen/qwen3-vl-8b",
          frontier: "openai-codex/gpt-5.4",
        },
      }),
    );

    try {
      const out = combined(
        await runPi("/bifrost preview hello", tempDir),
      );
      assert.ok(out.includes("source:    classifier"));
      assert.ok(out.includes("category:  economical"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
