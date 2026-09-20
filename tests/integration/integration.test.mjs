import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(__dirname, "..", "..", "index.ts");

const PI_ARGS = [
  "-e",
  EXTENSION_PATH,
  "--approve",
  "--no-session",
  "--print",
  "-p",
];

let integrationDir;

async function runPi(command, cwd = process.cwd(), env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", [...PI_ARGS, command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
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
    integrationDir = mkdtempSync(join(tmpdir(), "bifrost-integration-"));
    mkdirSync(join(integrationDir, ".pi"), { recursive: true });
    writeFileSync(
      join(integrationDir, ".pi", "bifrost.json"),
      JSON.stringify({
        default: "general",
        classifier: { enabled: true, backend: "prompt", model: "integration/test-classifier" },
        models: { quick: [], general: [], frontier: [] },
      }),
    );
    await runPi("/bifrost cache clear", integrationDir);
  });

  after(() => {
    rmSync(integrationDir, { recursive: true, force: true });
  });

  it("reports classifier status", async () => {
    const out = combined(await runPi("/bifrost classifier status", integrationDir));
    assert.ok(out.includes("enabled=true"));
    assert.ok(out.includes("model=integration/test-classifier"));
    assert.ok(out.includes("endpoint=registry"));
  });

  it("smokes TypeSafe production composition without credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-typesafe-smoke-"));
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi", "bifrost.json"),
      JSON.stringify({
        default: "general",
        classifier: { enabled: true, backend: "typesafe" },
        models: { quick: [], general: [], frontier: [] },
      }),
    );

    try {
      const out = combined(await runPi("/bifrost classifier test", tempDir, {
        HOME: tempDir,
        TYPESAFE_API_KEY: "",
      }));
      assert.ok(out.includes("backend: typesafe"));
      assert.ok(out.includes("credential: missing"));
      assert.ok(out.includes("outcome: missing_key"));
      assert.ok(out.includes("request observed: yes"));
      assert.ok(out.includes("model: jev-1.13.0"));
      assert.ok(out.includes("accepted: no"));
      assert.ok(out.includes("final result: general"));
      assert.ok(out.includes("final source: fallback"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to configured general tier for an unmatched prompt", async () => {
    const out = combined(await runPi("/bifrost preview hello", integrationDir));
    assert.ok(out.includes("source:    fallback"));
    assert.ok(out.includes("tier:      general"));
  });

  it("routes architecture prompt to frontier by regex", async () => {
    const out = combined(await runPi("/bifrost preview design the system architecture", integrationDir));
    assert.ok(out.includes("source:    regex"));
    assert.ok(out.includes("tier:      frontier"));
  });

  it("clears and reports an isolated cache", async () => {
    await runPi("/bifrost cache clear", integrationDir);
    const out = combined(await runPi("/bifrost cache stats", integrationDir));
    assert.ok(out.includes("cache: 0 entries"));
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
        await runPi("/bifrost preview fix lint this file", tempDir),
      );
      assert.ok(out.includes("source:    regex"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses project-local tier names in preview output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bifrost-test-"));
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tempDir, ".pi", "bifrost.json"),
      JSON.stringify({
        classifier: { enabled: false, backend: "prompt" },
        default: "general",
        models: { quick: [], general: [], frontier: [] },
      }),
    );

    try {
      const out = combined(await runPi("/bifrost preview hello", tempDir));
      assert.ok(out.includes("source:    fallback"));
      assert.ok(out.includes("tier:      general"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
