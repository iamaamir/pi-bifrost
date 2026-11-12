import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let server;
let requests;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startFakeProvider() {
  requests = [];
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: "classifier" }] });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, {});
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body).model);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "general" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function fixture(port) {
  const home = join(tmpdir(), `bifrost-invalid-preview-home-${process.pid}`);
  const work = join(tmpdir(), `bifrost-invalid-preview-work-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "classifier", reasoning: false, contextWindow: 8192, maxTokens: 512 }],
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeFileSync(join(agent, "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "general",
    models: { general: ["fake/classifier"] },
    classifier: { enabled: true, backend: "prompt", model: "fake/classifier", criteria: { general: "general" } },
  }));
  writeFileSync(join(work, ".pi", "bifrost.json"), "{\"schemaVersion\":2,\"models\":{\"general\":[\"fake/classifier\"]}");
  return { home, work };
}

function runPi({ home, work, prompt }) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-tools", "--no-session", "-p", prompt], {
      cwd: work,
      env: { ...base, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1",
        NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`, BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") { reject(error); return; } }
      resolve({ code, stdout, stderr, violations });
    });
  });
}

describe("preview invalid-config acceptance", { concurrency: 1, timeout: 120_000 }, () => {
  let port;
  before(async () => { port = await startFakeProvider(); });
  after(async () => { await new Promise((resolve) => server?.close(resolve)); });

  it("reports invalid project config without invoking an inherited enabled classifier", async () => {
    requests = [];
    const env = fixture(port);
    try {
      const result = await runPi({ ...env, prompt: "/bifrost preview --trace --json synthetic audit request" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "", "Pi attempted a non-fixture network connection");
      assert.deepEqual(requests, [], "invalid config preview must not call the inherited prompt classifier");
      const reportLine = result.stderr.split("\n").find((line) => line.startsWith("[bifrost-json] "));
      assert.ok(reportLine, result.stderr);
      const report = JSON.parse(reportLine.slice("[bifrost-json] ".length));
      assert.equal(report.outcome, "config_invalid");
      assert.equal(report.error, "config_invalid");
      assert.equal(report.classifierDisclosure.configuredClassifierMayReceivePrompt, false);
      assert.equal(JSON.stringify(report).includes("synthetic audit request"), false);
      assert.match(result.stderr, /configuration source is invalid/u);

      requests = [];
      const plain = await runPi({ ...env, prompt: "/bifrost preview --json synthetic audit request" });
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(plain.violations, "", "Pi attempted a non-fixture network connection");
      assert.deepEqual(requests, [], "plain JSON preview must not call the inherited prompt classifier");
      const plainLine = plain.stderr.split("\n").find((line) => line.startsWith("[bifrost-json] "));
      assert.ok(plainLine, plain.stderr);
      assert.deepEqual(JSON.parse(plainLine.slice("[bifrost-json] ".length)), {
        ok: false,
        prompt: "synthetic audit request",
        error: "config_invalid",
      });
      assert.match(plain.stderr, /configuration source is invalid/u);
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });
});
