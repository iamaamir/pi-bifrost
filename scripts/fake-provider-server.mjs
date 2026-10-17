#!/usr/bin/env node
import http from "node:http";
import { createHash } from "node:crypto";

const port = Number(process.env.PORT ?? 0);
const attempts = new Map();
const generationAttempts = new Map();
const stats = [];
let catalogRequests = 0;
const heldProbeModels = new Set();
const heldProbeWaiters = new Map();
const heldGenerationModels = new Set();
const heldGenerationWaiters = new Map();

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sse(response, content = "ok") {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function partialAllowanceSse(response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "fake-partial-allowance", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial output before quota failure" }, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ error: { message: "The usage limit has been reached.", code: "usage_limit_reached" } })}\n\n`);
}

function toolCallSse(response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "fake-tool", object: "chat.completion.chunk", choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: "fixture-tool-call", type: "function", function: { name: "acceptance_counter", arguments: '{"marker":"synthetic"}' } }] },
    finish_reason: null,
  }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ id: "fake-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}

const server = http.createServer((request, response) => {
  response.on("error", () => {});
  request.on("error", () => {});
  if (request.method === "POST" && request.url?.startsWith("/_probe-gate/")) {
    const url = new URL(request.url, "http://127.0.0.1");
    const model = url.searchParams.get("model");
    if (!model) return json(response, 400, { error: "model is required" });
    if (url.pathname === "/_probe-gate/hold") heldProbeModels.add(model);
    else if (url.pathname === "/_probe-gate/release") {
      heldProbeModels.delete(model);
      for (const release of heldProbeWaiters.get(model) ?? []) release();
      heldProbeWaiters.delete(model);
    } else return json(response, 404, { error: "unknown probe gate action" });
    return json(response, 200, { model, held: heldProbeModels.has(model) });
  }
  if (request.method === "POST" && request.url?.startsWith("/_generation-gate/")) {
    const url = new URL(request.url, "http://127.0.0.1");
    const model = url.searchParams.get("model");
    if (!model) return json(response, 400, { error: "model is required" });
    if (url.pathname === "/_generation-gate/hold") heldGenerationModels.add(model);
    else if (url.pathname === "/_generation-gate/release") {
      heldGenerationModels.delete(model);
      for (const release of heldGenerationWaiters.get(model) ?? []) release();
      heldGenerationWaiters.delete(model);
    } else return json(response, 404, { error: "unknown generation gate action" });
    return json(response, 200, { model, held: heldGenerationModels.has(model) });
  }
  if (request.url === "/_stats") return json(response, 200, { attempts: Object.fromEntries(attempts), stats, catalogRequests });
  if (request.method === "GET" && request.url === "/v1/models") {
    catalogRequests++;
    return json(response, 200, {
      object: "list",
      data: ["new", "probe-slow"].map((id) => ({ id, object: "model" })),
    });
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, { error: "not found" });
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const model = payload.model ?? "unknown";
    const attempt = (attempts.get(model) ?? 0) + 1;
    attempts.set(model, attempt);
    const classifierRequest = JSON.stringify(payload.messages ?? [])
      .includes("Classify the request into exactly one category.");
    const probeRequest = JSON.stringify(payload.messages ?? []).includes("1+1=");
    const authorization = request.headers.authorization ?? "";
    const provider = authorization === "Bearer ui-fixture-backup-only"
      ? "fake-backup"
      : authorization === "Bearer fixture-only"
        ? "fake"
        : authorization.startsWith("Bearer fixture-")
          ? authorization.slice("Bearer fixture-".length)
          : "fake";
    const kind = classifierRequest ? "classifier" : probeRequest ? "probe" : "generation";
    const userMessages = (payload.messages ?? []).filter((message) => message.role === "user").map((message) =>
      (typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("")));
    const stat = {
      provider,
      model,
      attempt,
      kind,
      ...(kind === "generation" ? { userMessageDigest: createHash("sha256").update(userMessages.at(-1) ?? "").digest("hex") } : {}),
      completed: false,
    };
    stats.push(stat);
    response.on("finish", () => { stat.completed = true; });
    response.on("close", () => { if (!response.writableFinished) stat.clientClosed = true; });
    const generationAttempt = kind === "generation" ? (generationAttempts.get(model) ?? 0) + 1 : 0;
    if (kind === "generation") generationAttempts.set(model, generationAttempt);
    if (kind === "generation" && heldGenerationModels.has(model)) {
      const waiters = heldGenerationWaiters.get(model) ?? [];
      heldGenerationWaiters.set(model, waiters);
      waiters.push(() => {
        stat.gateReleased = true;
        if (response.destroyed) return;
        if (model === "slow-partial") {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.write(`data: ${JSON.stringify({ id: "fake-partial", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial output" }, finish_reason: null }] })}\n\n`, () => response.socket.destroy());
          return;
        }
        if (model === "queue-tool-then-fail" && generationAttempt === 1) return toolCallSse(response);
        if (model === "queue-tool-then-fail" && generationAttempt > 1) return json(response, 402, { error: { message: "You have no remaining credits. Synthetic queued allowance failure." } });
        sse(response, "gate released");
      });
      return;
    }
    if (model === "partial-allowance") { stat.syntheticOutcome = "partial_output_then_usage_limit_reached"; return partialAllowanceSse(response); }
    if (["tool-then-fail", "queue-tool-then-fail"].includes(model) && generationAttempt === 1) return toolCallSse(response);
    if (["tool-then-fail", "queue-tool-then-fail"].includes(model) && generationAttempt > 1) return json(response, 402, { error: { message: "You have no remaining credits; synthetic allowance failure after tool result." } });
    if (model === "credits-exhausted") return json(response, 402, {
      error: { message: "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get monthly included credits." },
    });
    if (model === "background-credits-exhausted" && probeRequest) return json(response, 402, {
      error: { message: "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers." },
    });
    if (model === "codex-like-temperature-rejects" && probeRequest && payload.temperature !== undefined) return json(response, 400, {
      error: { message: "Unsupported parameter: temperature" },
    });
    if (model === "subscription-required") return json(response, 403, {
      type: "error",
      error: { api_error: { message: "An active OpenCode Go subscription is required to use Go" } },
    });
    if (model === "usage-exhausted" || model === "usage-exhausted-alternate") return json(response, 429, { error: { code: "usage_limit_reached", message: "The usage limit has been reached. Please try again later." } });
    if (model === "quota") return json(response, 429, { error: { message: "quota exhausted" } }, { "retry-after": "1" });
    if (model === "fail") return json(response, 500, { error: { message: "simulated provider failure" } });
    if (model === "fail-then-ok" && attempt === 1) return json(response, 500, { error: { message: "simulated transient failure" } });
    if (model === "classifier") return sse(response, "general");
    if (model === "malformed-sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return response.end("data: {malformed-json\n\n");
    }
    if (model === "partial") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`, () => response.socket.destroy());
    }
    if (model === "probe-slow") return setTimeout(() => sse(response, "probe-slow-done"), 32_000);
    if (model === "probe-background-slow-fail" && probeRequest) {
      return setTimeout(() => json(response, 500, { error: { message: "probe-only failure" } }), 1_000);
    }
    if (probeRequest && heldProbeModels.has(model)) {
      const waiters = heldProbeWaiters.get(model) ?? [];
      heldProbeWaiters.set(model, waiters);
      waiters.push(() => {
        stat.gateReleased = true;
        if (response.destroyed) return;
        if (model === "registered-inaccessible") return json(response, 403, {
          error: { message: "synthetic fixture model is registered but inaccessible" },
        });
        sse(response, "held-probe-released");
      });
      return;
    }
    if (model === "registered-inaccessible") return json(response, 403, {
      error: { message: "synthetic fixture model is registered but inaccessible" },
    });
    if (model === "probe-background-slow-fail") return setTimeout(() => sse(response, "slow-generation-done"), 4_000);
    // "slow" keeps an agent run open long enough to queue steer prompts.
    if (model === "slow") return setTimeout(() => sse(response, "slow-done"), 8000);
    return sse(response, "healthy");
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
