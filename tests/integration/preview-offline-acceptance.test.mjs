import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      return json(response, 200, { object: "list", data: [{ id: "classifier" }, { id: "generation" }] });
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
  const home = mkdtempSync(join(tmpdir(), "bifrost-preview-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-preview-work-"));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: ["classifier", "generation"].map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 512 })),
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "general",
    models: { general: ["fake/generation"] },
    classifier: { enabled: true, backend: "prompt", model: "fake/classifier", criteria: { general: "general" } },
  }));
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

describe("preview offline acceptance", { concurrency: 1, timeout: 120_000 }, () => {
  let port;
  before(async () => { port = await startFakeProvider(); });
  after(async () => { await new Promise((resolve) => server?.close(resolve)); });

  it("does not call an enabled prompt classifier in offline mode and keeps ordinary preview classification", async () => {
    const env = fixture(port);
    try {
      const offline = await runPi({ ...env, prompt: "/bifrost preview --offline --json a prompt with no local rule" });
      assert.equal(offline.code, 0, offline.stderr);
      assert.equal(offline.violations, "", "Pi attempted a non-fixture network connection");
      assert.deepEqual(requests, [], "offline preview must skip the enabled prompt classifier");
      const offlineReport = JSON.parse(offline.stderr.split("[bifrost-json] ").at(-1));
      assert.equal(offlineReport.source, "fallback");
      assert.equal(offlineReport.tier, "general");

      requests = [];
      const ordinary = await runPi({ ...env, prompt: "/bifrost preview --json a prompt with no local rule" });
      assert.equal(ordinary.code, 0, ordinary.stderr);
      assert.equal(ordinary.violations, "", "Pi attempted a non-fixture network connection");
      assert.deepEqual(requests, ["classifier"], "ordinary preview should still classify through the configured provider");
      const ordinaryReport = JSON.parse(ordinary.stderr.split("[bifrost-json] ").at(-1));
      assert.equal(ordinaryReport.source, "classifier");
      assert.equal(ordinaryReport.tier, "general");
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });
});
