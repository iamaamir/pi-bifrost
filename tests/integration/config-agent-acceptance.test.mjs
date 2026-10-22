// Pi E2E acceptance for the agent-facing `bifrost_config` tool.
//
// Boundary: real pinned Pi in RPC mode, the shipped extension, a fake provider
// whose model is scripted to call the tool, and the extension-UI confirmation
// sub-protocol. This proves the full write path end to end: check (no write),
// an answered approval dialog, the saved project source, reload activation, and
// no outbound network beyond the local fixture. Live providers and credentials
// are excluded; the outbound guard fences everything else off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

let server;
let requests;
let scripted;
let lastApplyReport;

const PATCH = {
  schemaVersion: 2,
  enabled: true,
  default: "agentrole",
  models: { general: ["fake/agentconfig"], agentrole: ["fake/agentconfig"] },
  categoryStrategies: { general: "first", agentrole: "first" },
  classifier: { enabled: false },
  rules: [],
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function textSse(response, content) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolCallSse(response, name, args) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "fake-tool", object: "chat.completion.chunk", choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: "fixture-tool-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: null,
  }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ id: "fake-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}

// The scripted model: turn 1 calls check, turn 2 copies the digests the check
// report printed (exactly what the SKILL tells an agent to do) into apply, and
// turn 3 ends the turn with plain text.
function startFakeProvider() {
  requests = [];
  scripted = [];
  server = createServer((request, response) => {
    response.on("error", () => {});
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: "agentconfig", object: "model" }] });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, {});
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}");
      requests.push({ model: payload.model });
      const text = JSON.stringify(payload.messages ?? []);
      if (text.includes("bifrost configuration apply")) {
        scripted.push("final");
        lastApplyReport = text.match(/--- bifrost configuration apply ---[\s\S]{0,1200}/)?.[0] ?? text.slice(-1500);
        return textSse(response, "configuration applied");
      }
      if (text.includes("bifrost candidate check")) {
        if (scripted.filter((entry) => entry === "apply").length >= 3) return textSse(response, "giving up");
        const digests = {};
        for (const key of ["proposalDigest", "sourceDigest", "effectiveDigest", "catalogDigest"]) {
          // Match against the JSON-encoded transcript, so stop at whitespace or
          // a JSON escape (\\n): a broader match would drag the line break in.
          const match = text.match(new RegExp(`${key}: ([0-9a-f]{64}|absent)`));
          assert.ok(match, `check report must print ${key} for the model to copy: ${text.slice(-1200)}`);
          digests[key] = match[1];
        }
        scripted.push("apply");
        return toolCallSse(response, "bifrost_config", { operation: "apply", source: "project", patch: PATCH, ...digests });
      }
      scripted.push("check");
      return toolCallSse(response, "bifrost_config", { operation: "check", source: "project", patch: PATCH });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function fixture(port) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-config-agent-e2e-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-config-agent-e2e-work-"));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: "fixture-only",
    models: [{ id: "agentconfig", reasoning: false, contextWindow: 8192, maxTokens: 512 }],
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  // A configuration with settings blocks ADR 0025 automatic first-use saves, so
  // no background save can rewrite the source between check and apply.
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "general",
    models: { general: ["fake/agentconfig"] },
    classifier: { enabled: false },
  }));
  return { home, work };
}

function piEnvironment(home, port) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return {
    ...base,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
  };
}

function startRpc({ home, work, port, timeoutMs = 60_000 }) {
  // Tools stay enabled: the scripted model must be able to call bifrost_config.
  const child = spawn(PI, ["-e", EXTENSION, "--approve", "--mode", "rpc", "--no-session", "--model", "fake/agentconfig"], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnvironment(home, port),
  });
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closePromise;
  let closeInfo;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeInfo = { code, signal };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${incompleteLine}${chunk}`.split("\n");
    incompleteLine = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); }
      catch { /* malformed output remains a protocol assertion failure */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = undefined;
        resolve();
      };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  async function prompt(message) {
    const id = `config-agent-e2e-${records.length}-${Date.now()}`;
    const start = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return { response: record, stderr: stderr.slice(stderrStart) };
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}\n${stderr}`);
  }

  async function userTurn(message) {
    const start = records.length;
    const accepted = await prompt(message);
    if (accepted.response.data?.disposition !== "started") return accepted;
    const deadline = Date.now() + timeoutMs;
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.type === "agent_settled") return accepted;
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before settling: ${message}\n${stderr}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC turn did not settle: ${message}\n${stderr}`);
  }

  async function close() {
    closePromise ??= (async () => {
      child.stdin.end();
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (!closeInfo) {
        child.kill("SIGKILL");
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      assert.ok(closeInfo, "Pi RPC child must close before its fixture is removed");
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...closeInfo, violations };
    })();
    return closePromise;
  }

  return { prompt, userTurn, close, get records() { return records; }, get stderr() { return stderr; } };
}

function jsonReport(output) {
  const line = `${output.stderr}\n${output.stdout ?? ""}`.split("\n").find((item) => item.startsWith("[bifrost-json] "));
  assert.ok(line, `expected a bifrost JSON report; stderr was:\n${output.stderr}`);
  return JSON.parse(line.slice("[bifrost-json] ".length));
}

describe("config agent tool Pi acceptance", { concurrency: 1, timeout: 180_000 }, () => {
  let port;
  before(async () => { port = await startFakeProvider(); });
  after(async () => { await new Promise((resolve) => server?.close(resolve)); });

  it("checks, applies through an answered approval, saves one source, and activates it", async () => {
    const env = fixture(port);
    const rpc = startRpc({ ...env, port });
    try {
      const confirmBefore = rpc.records.filter((record) => record.type === "extension_ui_request").length;
      await rpc.userTurn("please configure my routing e2e-config-agent-marker");

      // The scripted sequence ran: check first, then apply with copied digests.
      assert.deepEqual([...new Set(scripted)].sort(), ["apply", "check", "final"].sort(), `scripted turns: ${JSON.stringify(scripted)}`);

      // The approval dialog was surfaced over the extension-UI protocol.
      const dialogs = rpc.records.filter((record) => record.type === "extension_ui_request");
      assert.ok(dialogs.length > confirmBefore, "apply must ask for approval in the client");
      assert.ok(dialogs.some((record) => /Apply this Bifrost configuration/u.test(JSON.stringify(record))), `dialogs: ${JSON.stringify(dialogs)}\napply report: ${lastApplyReport ?? "(none)"}`);

      // Saved state: exactly one source changed, to the merged proposal.
      const savedPath = join(env.work, ".pi", "bifrost.json");
      assert.ok(existsSync(savedPath), "apply must persist the project source");
      const saved = JSON.parse(readFileSync(savedPath, "utf8"));
      assert.equal(saved.default, "agentrole");
      assert.deepEqual(saved.models, PATCH.models);
      assert.equal(saved.classifier.enabled, false);

      // Activation: the reloaded config decides routes offline. Before the
      // change the default tier was `general`; it must now be `agentrole`.
      const preview = await rpc.prompt("/bifrost preview --json route this prompt e2e");
      const report = jsonReport(preview);
      assert.equal(report.tier, "agentrole", JSON.stringify(report));
      assert.equal(report.source, "fallback", JSON.stringify(report));

      const closed = await rpc.close();
      assert.equal(closed.code, 0, rpc.stderr);
      assert.equal(closed.violations, "", "Pi attempted a non-fixture network connection");
      // Only the scripted model was talked to; the fixture is the sole origin.
      assert.ok(requests.length >= 3, `expected the scripted turns, saw ${requests.length}`);
      assert.ok(requests.every((entry) => entry.model === "agentconfig"), JSON.stringify(requests));
    } finally {
      rpc.close().catch(() => {});
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });
});