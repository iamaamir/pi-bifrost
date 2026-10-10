#!/usr/bin/env node
import http from "node:http";

const port = Number(process.env.PORT ?? 0);
const attempts = new Map();
const stats = [];

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sse(response, content = "ok") {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

const server = http.createServer((request, response) => {
  response.on("error", () => {});
  request.on("error", () => {});
  if (request.url === "/_stats") return json(response, 200, { attempts: Object.fromEntries(attempts), stats });
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
    const provider = request.headers.authorization === "Bearer ui-fixture-backup-only" ? "fake-backup" : "fake";
    stats.push({ provider, model, attempt, kind: classifierRequest ? "classifier" : "generation" });
    if (model === "usage-exhausted" || model === "usage-exhausted-alternate") return json(response, 429, { error: { code: "usage_limit_reached", message: "The usage limit has been reached. Please try again later." } });
    if (model === "quota") return json(response, 429, { error: { message: "quota exhausted" } }, { "retry-after": "1" });
    if (model === "fail") return json(response, 500, { error: { message: "simulated provider failure" } });
    if (model === "fail-then-ok" && attempt === 1) return json(response, 500, { error: { message: "simulated transient failure" } });
    if (model === "classifier") return sse(response, "general");
    if (model === "partial") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`);
      return response.socket.destroy();
    }
    // "slow" keeps an agent run open long enough to queue steer prompts.
    if (model === "slow") return setTimeout(() => sse(response, "slow-done"), 8000);
    return sse(response, "healthy");
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
