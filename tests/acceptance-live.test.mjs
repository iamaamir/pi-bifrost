import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = fileURLToPath(import.meta.url);

if (process.env.BIFROST_LIVE_TEST_CHILD !== "1") {
  describe("bounded live acceptance profile isolation", () => {
    it("runs deterministic SDK tests with a sanitized environment and outbound guard preloaded", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-live-guard-"));
      const violations = join(directory, "network-violations.log");
      const result = spawnSync(process.execPath, ["--require", join(ROOT, "scripts/test-outbound-guard.cjs"), "--test", TEST_FILE], {
        encoding: "utf8",
        timeout: 180_000,
        env: {
          BIFROST_LIVE_TEST_CHILD: "1",
          BIFROST_TEST_ALLOWED_ORIGIN: "http://127.0.0.1:1",
          BIFROST_TEST_NETWORK_VIOLATIONS: violations,
          HOME: directory,
          PI_CODING_AGENT_DIR: join(directory, "agent-default"),
        },
      });
      const violationLog = existsSync(violations) ? readFileSync(violations, "utf8") : "";
      rmSync(directory, { recursive: true, force: true });
      assert.equal(violationLog, "", `unexpected outbound attempts were blocked:\n${violationLog}`);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  });
} else {
const { classifyLiveFailure, runProfile, validateLiveOptions } = await import("../scripts/acceptance/profiles/live.mjs");
const tempDirs = [];
after(() => {
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-live-test-"));
  tempDirs.push(directory);
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  return { directory, agentDir, modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json"), artifactDir: join(directory, "artifacts") };
}

function fakeProvider({ status = 200, waitForAbort = false, redirect = false, responseFor } = {}) {
  let calls = 0;
  let aborted = 0;
  let callsAfterFailure = 0;
  let follows = 0;
  let failureReturned = false;
  const redirects = [];
  const fetch = async (_input, init = {}) => {
    calls++;
    if (failureReturned) callsAfterFailure++;
    redirects.push(init.redirect);
    if (waitForAbort) return new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted++;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
    if (redirect) {
      if (init.redirect !== "error") follows++;
      throw new TypeError("fetch rejected redirect");
    }
    if (responseFor) {
      const payload = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const response = responseFor({ call: calls, payload });
      if (response) return response;
    }
    if (status !== 200) {
      failureReturned = true;
      return new Response(JSON.stringify({ error: { message: status === 429 ? "rate limit" : "Unsupported parameter: temperature" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    const events = [
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "live-fixture", choices: [{ index: 0, delta: { content: "BIFROST-LIVE-OK" }, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", created: 1, model: "live-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const stream = [
      ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
      "data: [DONE]\n\n",
    ].join("");
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls: () => calls, aborted: () => aborted, callsAfterFailure: () => callsAfterFailure, follows: () => follows, redirects: () => redirects, fetch, baseUrl: "https://api.openai.com/v1" };
}

function writeModels(path, baseUrl, includeKey = true) {
  writeFileSync(path, JSON.stringify({ providers: { fixture: {
    baseUrl,
    api: "openai-completions",
    ...(includeKey ? { apiKey: "fixture-only-secret" } : {}),
    models: [{ id: "live-fixture", name: "Acceptance fixture", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
}

const liveOptions = (overrides = {}) => ({ profile: "live", allowLive: true, allowModels: ["fixture/live-fixture"], maxRequestsPerModel: 4, deadlineSeconds: 8, ...overrides });

describe("bounded live acceptance profile", () => {
  it("requires explicit opt-in, exact models, and capped budgets before any work", () => {
    assert.throws(() => validateLiveOptions({ profile: "live", allowModels: ["x/y"] }), /--allow-live/);
    assert.throws(() => validateLiveOptions(liveOptions({ allowModels: ["fixture/*"] })), /exact/);
    assert.throws(() => validateLiveOptions(liveOptions({ allowModels: ["fixture/a", "fixture/b"] })), /exactly one/);
    assert.throws(() => validateLiveOptions(liveOptions({ maxRequestsPerModel: 5 })), /1 through 4/);
    assert.throws(() => validateLiveOptions(liveOptions({ deadlineSeconds: 301 })), /1 through 300/);
    assert.equal(classifyLiveFailure(new Error("HTTP 429 rate limit")), "quota_blocked");
    assert.equal(classifyLiveFailure(new Error("HTTP 401 unauthorized")), "auth_blocked");
    assert.equal(classifyLiveFailure(new Error("HTTP 400 Unsupported parameter: temperature")), "provider_failed");
  });

  it("runs real Pi AgentSession and Bifrost physical, Auto, probe, saved-pool, and restart journeys through the native SDK adapter", async () => {
    const local = fixture();
    const provider = fakeProvider();
    writeModels(local.modelsPath, provider.baseUrl);
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions({ deadlineSeconds: 15 }), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
    } });
    assert.equal(result.cases.length, 1);
    assert.equal(result.cases[0].status, "passed", JSON.stringify(result.cases[0]));
    assert.deepEqual(result.cases[0].attempts, { "fixture/live-fixture": 4 });
    assert.equal(provider.calls(), 4, "probe, physical turn, Auto turn, and restart turn each use one actual HTTP request");
    assert.deepEqual(provider.redirects(), ["error", "error", "error", "error"]);
    assert.deepEqual(result.cases[0].requirements, ["live-physical-session", "live-auto-session", "live-probe-consistency", "live-restart"]);
    const evidence = JSON.parse(readFileSync(join(local.artifactDir, "live-evidence.json"), "utf8"));
    assert.equal(evidence.toolCount, 0);
    assert.equal(evidence.probe[0].status, "ok");
    assert.equal(JSON.stringify(evidence).includes("BIFROST-LIVE-OK"), false, "synthetic prompt and response text are not recorded");
    assert.equal(JSON.stringify(evidence).includes("fixture-only-secret"), false);
  });

  it("does not pass an Auto turn that emitted text before a native SSE usage error", async () => {
    const local = fixture();
    const marker = "BIFROST-LIVE-OK";
    let usageInjected = false;
    const provider = fakeProvider({ responseFor: ({ call }) => {
      if (call !== 3) return undefined;
      usageInjected = true;
      const stream = [
        { id: "fixture-auto-error", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `${marker} partial` }, finish_reason: null }] },
        { error: { message: "The usage limit has been reached.", code: "usage_limit_reached" } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    } });
    writeModels(local.modelsPath, provider.baseUrl);
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions({ deadlineSeconds: 15 }), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
    } });
    assert.equal(usageInjected, true, "the native Auto request must receive the injected partial-output usage error");
    assert.equal(result.cases[0].status, "blocked", JSON.stringify(result.cases[0]));
    assert.equal(provider.calls(), 3, "the physical turn, probe, and failed Auto turn run; no restart request follows the error");
    assert.equal(result.cases[0].attempts["fixture/live-fixture"], provider.calls());
    const evidence = JSON.parse(readFileSync(join(local.artifactDir, "live-evidence.json"), "utf8"));
    assert.equal(evidence.outcome.autoStopReason, "error");
    assert.equal(JSON.stringify(evidence).includes(marker), false, "the response text is not written to live evidence");
  });

  it("requires the exact trimmed response at each live journey boundary", async () => {
    for (const { call, stage } of [
      { call: 2, stage: "physical" },
      { call: 3, stage: "auto" },
      { call: 4, stage: "restart" },
    ]) {
      const local = fixture();
      const provider = fakeProvider({ responseFor: ({ call: requestNumber }) => requestNumber === call
        ? new Response(`data: ${JSON.stringify({ id: "fixture-wrong-marker", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "BIFROST-LIVE-OK extra" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture-wrong-marker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
        : undefined });
      writeModels(local.modelsPath, provider.baseUrl);
      const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions({ deadlineSeconds: 15 }), dependencies: {
        userAgentDir: local.agentDir, modelsPath: local.modelsPath, authPath: local.authPath, fetch: provider.fetch,
      } });
      assert.equal(result.cases[0].status, "failed", `${stage}: ${JSON.stringify(result.cases[0])}`);
      assert.equal(provider.calls(), call, `${stage}: do not continue after a wrong marker`);
      const evidence = JSON.parse(readFileSync(join(local.artifactDir, "live-evidence.json"), "utf8"));
      assert.equal(evidence.outcome[`${stage}MarkerMatches`], false, `${stage}: evidence stores only the marker comparison`);
      assert.equal(JSON.stringify(evidence).includes("BIFROST-LIVE-OK extra"), false);
    }
  });

  it("fails closed on native error stop reasons at physical, Auto, and restart stages", async () => {
    for (const { call, stage } of [
      { call: 2, stage: "physical" },
      { call: 3, stage: "auto" },
      { call: 4, stage: "restart" },
    ]) {
      const local = fixture();
      const provider = fakeProvider({ responseFor: ({ call: requestNumber }) => requestNumber === call
        ? new Response(`data: ${JSON.stringify({ error: { message: "The usage limit has been reached.", code: "usage_limit_reached" } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
        : undefined });
      writeModels(local.modelsPath, provider.baseUrl);
      const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions({ deadlineSeconds: 15 }), dependencies: {
        userAgentDir: local.agentDir, modelsPath: local.modelsPath, authPath: local.authPath, fetch: provider.fetch,
      } });
      assert.equal(result.cases[0].status, "blocked", `${stage}: ${JSON.stringify(result.cases[0])}`);
      assert.equal(provider.calls(), call, `${stage}: stop after the provider error`);
      assert.equal(result.cases[0].attempts["fixture/live-fixture"], call);
    }
  });

  it("blocks missing authentication before any provider request", async () => {
    const local = fixture();
    const provider = fakeProvider();
    writeModels(local.modelsPath, provider.baseUrl, false);
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
    } });
    assert.equal(result.cases[0].status, "blocked");
    assert.equal(provider.calls(), 0);
  });

  it("blocks expired Pi OAuth credentials before runtime creation or refresh", async () => {
    const local = fixture();
    const provider = fakeProvider();
    writeModels(local.modelsPath, provider.baseUrl);
    writeFileSync(local.authPath, JSON.stringify({ fixture: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 } }));
    let runtimeCreated = false;
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
      createRuntime: async () => { runtimeCreated = true; throw new Error("runtime should not be constructed"); },
    } });
    assert.equal(result.cases[0].status, "blocked");
    assert.equal(runtimeCreated, false);
    assert.equal(provider.calls(), 0);
    assert.equal(readFileSync(local.authPath, "utf8").includes("fixture-refresh"), true, "the existing auth file remains unchanged");
  });

  it("blocks malformed or missing OAuth expiry before runtime creation", async () => {
    for (const oauth of [
      { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: "later" },
      { type: "oauth", access: "fixture-access", refresh: "fixture-refresh" },
    ]) {
      const local = fixture();
      const provider = fakeProvider();
      writeModels(local.modelsPath, provider.baseUrl);
      writeFileSync(local.authPath, JSON.stringify({ fixture: oauth }));
      let runtimeCreated = false;
      const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
        userAgentDir: local.agentDir,
        modelsPath: local.modelsPath,
        authPath: local.authPath,
        fetch: provider.fetch,
        createRuntime: async () => { runtimeCreated = true; throw new Error("runtime should not be constructed"); },
      } });
      assert.equal(result.cases[0].status, "blocked");
      assert.equal(runtimeCreated, false);
      assert.equal(provider.calls(), 0);
    }
  });

  it("blocks command and environment expansion in selected auth and model config before SDK setup", async () => {
    const cases = [
      (models) => { models.providers.fixture.apiKey = "!touch /tmp/bifrost-live-command-ran"; },
      (models) => { models.providers.fixture.apiKey = "$BIFROST_LIVE_TEST_SECRET"; },
      (models) => { models.providers.fixture.headers = { "x-test": "!touch /tmp/bifrost-live-header-ran" }; },
      (models) => { models.providers.fixture.models[0].headers = { "x-test": "$BIFROST_LIVE_TEST_SECRET" }; },
      (_models, auth) => { auth.fixture = { type: "api_key", key: "$BIFROST_LIVE_TEST_SECRET" }; },
      (_models, auth) => { auth.fixture = { type: "api_key", key: "!touch /tmp/bifrost-live-auth-ran" }; },
    ];
    for (const mutate of cases) {
      const local = fixture();
      const provider = fakeProvider();
      writeModels(local.modelsPath, provider.baseUrl);
      const originalModels = JSON.parse(readFileSync(local.modelsPath, "utf8"));
      const originalAuthObject = JSON.parse(readFileSync(local.authPath, "utf8"));
      mutate(originalModels, originalAuthObject);
      const originalText = `${JSON.stringify(originalModels)}\n`;
      writeFileSync(local.modelsPath, originalText);
      const mutatedAuth = `${JSON.stringify(originalAuthObject)}\n`;
      writeFileSync(local.authPath, mutatedAuth);
      const originalAuth = readFileSync(local.authPath, "utf8");
      let runtimeCreated = false;
      const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
        userAgentDir: local.agentDir,
        modelsPath: local.modelsPath,
        authPath: local.authPath,
        fetch: provider.fetch,
        createRuntime: async () => { runtimeCreated = true; throw new Error("unsafe configuration reached SDK"); },
      } });
      assert.equal(result.cases[0].status, "blocked");
      assert.equal(runtimeCreated, false);
      assert.equal(provider.calls(), 0);
      assert.equal(readFileSync(local.modelsPath, "utf8"), originalText);
      assert.equal(readFileSync(local.authPath, "utf8"), originalAuth);
    }
  });

  it("filters auth reads to explicitly selected providers and refuses refresh before invoking it", async () => {
    const local = fixture();
    const provider = fakeProvider();
    writeModels(local.modelsPath, provider.baseUrl);
    let refreshInvoked = false;
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      createRuntime: async ({ credentials, authPath, modelsPath }) => {
        const isolatedAuth = JSON.parse(readFileSync(authPath, "utf8"));
        const isolatedModels = JSON.parse(readFileSync(modelsPath, "utf8"));
        assert.deepEqual(Object.keys(isolatedAuth), []);
        assert.deepEqual(Object.keys(isolatedModels.providers), ["fixture"]);
        assert.deepEqual(isolatedModels.providers.fixture.models.map((model) => model.id), ["live-fixture"]);
        assert.equal(await credentials.read("unselected-provider"), undefined);
        assert.deepEqual(await credentials.list(), []);
        await assert.rejects(credentials.modify("fixture", async () => {
          refreshInvoked = true;
          return undefined;
        }), /read-only/);
        return { getPhysicalModel: () => undefined };
      },
    } });
    assert.equal(result.cases[0].status, "blocked");
    assert.equal(refreshInvoked, false);
  });

  it("reports auth/quota responses as blocked and aborts later provider dispatches", async () => {
    for (const status of [401, 429]) {
      const local = fixture();
      const provider = fakeProvider({ status });
      writeModels(local.modelsPath, provider.baseUrl);
      const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
        userAgentDir: local.agentDir,
        modelsPath: local.modelsPath,
        authPath: local.authPath,
        fetch: provider.fetch,
      } });
      assert.equal(result.cases[0].status, "blocked");
      assert.ok(provider.calls() >= 1 && provider.calls() <= 4, "all bootstrap and session HTTP attempts stay within the exact model budget");
      assert.equal(result.cases[0].attempts["fixture/live-fixture"], provider.calls());
      assert.equal(provider.callsAfterFailure(), 0, `the first HTTP ${status} response aborts later provider dispatches`);
    }
  });

  it("rejects redirects and never counts a followed off-origin request", async () => {
    const local = fixture();
    const provider = fakeProvider({ redirect: true });
    writeModels(local.modelsPath, provider.baseUrl);
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions(), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
    } });
    assert.equal(result.cases[0].status, "failed");
    assert.ok(provider.calls() >= 1 && provider.calls() <= 4);
    assert.ok(provider.redirects().length >= 1);
    assert.ok(provider.redirects().every((redirect) => redirect === "error"));
    assert.equal(provider.follows(), 0);
    assert.equal(result.cases[0].attempts["fixture/live-fixture"], provider.calls());
  });

  it("stops at the per-model outbound budget without retrying", async () => {
    const local = fixture();
    const provider = fakeProvider();
    writeModels(local.modelsPath, provider.baseUrl);
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions({ maxRequestsPerModel: 1, deadlineSeconds: 2 }), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
    } });
    assert.notEqual(result.cases[0].status, "passed");
    assert.equal(result.cases[0].status, "blocked");
    assert.equal(provider.calls(), 0, "insufficient budgets are rejected before transport setup");
    assert.equal(result.cases[0].attempts["fixture/live-fixture"], undefined);
  });

  it("aborts pending native requests at the hard deadline", async () => {
    const local = fixture();
    const provider = fakeProvider({ waitForAbort: true });
    writeModels(local.modelsPath, provider.baseUrl);
    const result = await runProfile({ root: ROOT, artifactDir: local.artifactDir, options: liveOptions({ deadlineSeconds: 4 }), dependencies: {
      userAgentDir: local.agentDir,
      modelsPath: local.modelsPath,
      authPath: local.authPath,
      fetch: provider.fetch,
    } });
    assert.notEqual(result.cases[0].status, "passed");
    assert.ok(provider.calls() > 0);
    assert.ok(provider.aborted() > 0, "the in-flight fake provider request received abort");
    assert.ok(Object.values(result.cases[0].attempts).every((count) => count <= 4));
  });

  it("aborts an in-flight request on SIGINT and removes its listeners", () => {
    const local = fixture();
    const provider = fakeProvider();
    writeModels(local.modelsPath, provider.baseUrl);
    const profileUrl = new URL("../scripts/acceptance/profiles/live.mjs", import.meta.url).href;
    const script = `
      import { runProfile } from ${JSON.stringify(profileUrl)};
      const [root, agentDir, modelsPath, authPath, artifactDir] = process.argv.slice(1);
      let calls = 0;
      let aborted = 0;
      const listenersBefore = process.listeners("SIGINT").map((listener) => listener.name);
      const fetch = async (_input, init = {}) => {
        calls++;
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => { aborted++; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
          process.emit("SIGINT");
        });
      };
      const result = await runProfile({ root, artifactDir, options: { profile: "live", allowLive: true, allowModels: ["fixture/live-fixture"], maxRequestsPerModel: 4, deadlineSeconds: 10 }, dependencies: { userAgentDir: agentDir, modelsPath, authPath, fetch } });
      process.stdout.write(JSON.stringify({ status: result.cases[0].status, attempts: result.cases[0].attempts, calls, aborted, listenersBefore, listenersAfter: process.listeners("SIGINT").map((listener) => listener.name) }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, ROOT, local.agentDir, local.modelsPath, local.authPath, local.artifactDir], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
      env: process.env,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, "failed");
    assert.equal(result.calls, 1, "the aborted profile sends no later provider request");
    assert.equal(result.aborted, 1, "the in-flight fake fetch receives the abort signal");
    assert.equal(result.listenersAfter.includes("onSigint"), false, "profile SIGINT listener is removed after completion");
    assert.equal(result.listenersAfter.includes("onSigterm"), false, "profile SIGTERM listener is removed after completion");
  });
});
}
