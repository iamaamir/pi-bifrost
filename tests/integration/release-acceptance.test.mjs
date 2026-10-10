import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let fakePort;

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("close", () => { clearTimeout(forceKill); resolve(); });
    child.kill("SIGTERM");
  });
}

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await stopChild(child);
      reject(new Error(message));
    };
    const timer = setTimeout(() => { void fail("fake provider startup timed out"); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: ready.port });
      } catch { /* wait for the startup record */ }
    });
    child.on("error", () => { void fail("fake provider failed before startup"); });
    child.on("close", () => { if (!settled) void fail("fake provider exited before startup"); });
  });
}

function environment(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
  };
}

function assertNoNetworkViolations(home) {
  const path = join(home, "test-network-violations.log");
  if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), "", "outbound request was blocked");
}

function writeModels(home, models) {
  const providers = {};
  for (const { provider = "fake", ...model } of models) {
    const entry = providers[provider] ??= {
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      api: "openai-completions",
      apiKey: provider === "fake" ? "fixture-only" : `fixture-${provider}`,
      models: [],
    };
    entry.models.push(model);
  }
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: false },
    enabledModels: Object.keys(providers).map((provider) => `${provider}/*`),
  }));
}

function writeConfig(work, config) {
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify(config));
}

async function runPi({ home, work, model = "bifrost/auto", messages }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages], {
      stdio: ["ignore", "pipe", "pipe"], cwd: work, env: environment(home),
    });
    let stdout = "";
    let stderr = "";
    let forceKill;
    let timedOut = false;
    let spawnError;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 90_000);
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      try { assertNoNetworkViolations(home); }
      catch (error) { reject(error); return; }
      if (spawnError) { reject(spawnError); return; }
      if (timedOut) {
        reject(new Error(`Pi timed out: ${messages.join(" | ")}\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function fakeStats() {
  const response = await fetch(`http://127.0.0.1:${fakePort}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(existsSync(path), true, `background save did not create ${path}`);
}

function freshDirs() {
  return {
    home: mkdtempSync(join(tmpdir(), "bifrost-release-home-")),
    work: mkdtempSync(join(tmpdir(), "bifrost-release-work-")),
  };
}

const configuredModels = [
  { provider: "fake-a", id: "credits-exhausted", reasoning: false },
  { provider: "fake-a", id: "sibling", reasoning: false },
  { provider: "fake-b", id: "alternate", reasoning: false },
  { provider: "fake-c", id: "general", reasoning: false },
];

function config(mode = "v1") {
  return {
    ...(mode === "v2" ? { schemaVersion: 2 } : {}),
    enabled: true,
    default: "quick",
    strategy: "first",
    categoryStrategies: { quick: "first", general: "first" },
    classifier: { enabled: false },
    models: { quick: ["fake-a/credits-exhausted", "fake-a/sibling", "fake-b/alternate"], general: ["fake-c/general"] },
    reliability: {
      enabled: true,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
      allowanceCooldownScope: "provider",
      ...(mode === "v2" ? { stateVersion: 2 } : {}),
    },
  };
}

function countSince(stats, before, provider, model) {
  return stats.stats.slice(before.stats.length).filter((request) => request.provider === provider
    && request.model === model && request.kind === "generation").length;
}

describe("release acceptance against pinned Pi", { timeout: 300_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
    fakePort = server.port;
  });
  after(async () => { if (server?.child) await stopChild(server.child); });

  it("saves first-use project config when the global config is an empty object", async () => {
    const { home, work } = freshDirs();
    try {
      writeModels(home, [{ id: "healthy", reasoning: false }]);
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "bifrost.json"), "{}\n");
      const result = await runPi({ home, work, model: "fake/healthy", messages: ["describe one useful code review check"] });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /healthy/u);
      assert.match(result.stderr, /saved the detected starter pools to project config/u);
      const configPath = join(work, ".pi", "bifrost.json");
      const ownershipPath = join(work, ".pi", "bifrost-reconcile-ownership.json");
      await waitForFile(configPath);
      await waitForFile(ownershipPath);
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(saved.models.quick, ["fake/healthy"]);
      assert.equal(readFileSync(join(home, ".pi", "agent", "bifrost.json"), "utf8"), "{}\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  for (const mode of ["v1", "v2"]) {
    it(`keeps a physical 402 provider pause across restart before ${mode} Auto routing`, async () => {
      const { home, work } = freshDirs();
      try {
        writeModels(home, configuredModels);
        writeConfig(work, config("v1"));
        const beforePhysical = await fakeStats();
        const physical = await runPi({ home, work, model: "fake-a/credits-exhausted", messages: ["trigger a provider billing denial"] });
        assert.notEqual(physical.code, 0, `physical model did not fail as expected: ${physical.stderr}\n${physical.stdout}`);
        assert.equal(countSince(await fakeStats(), beforePhysical, "fake-a", "credits-exhausted"), 1,
          `physical 402 request missing: ${physical.stderr}\n${physical.stdout}`);
        const providerStatePath = join(work, ".pi", "bifrost-provider-reliability.json");
        assert.equal(existsSync(providerStatePath), true, "the provider pause is persisted before Pi exits");
        const providerState = JSON.parse(readFileSync(providerStatePath, "utf8"));
        assert.ok(Object.keys(providerState.scopes ?? {}).some((key) => key.includes("bifrost-provider-usage/fake-a")));

        const beforeNormalPhysical = await fakeStats();
        const normalPhysical = await runPi({ home, work, model: "fake-a/sibling", messages: ["normal follow-up after the physical 402"] });
        const afterNormalPhysical = await fakeStats();
        assert.equal(normalPhysical.code, 0, normalPhysical.stderr);
        assert.equal(countSince(afterNormalPhysical, beforeNormalPhysical, "fake-a", "credits-exhausted"), 0);
        assert.equal(countSince(afterNormalPhysical, beforeNormalPhysical, "fake-a", "sibling"), 0,
          "a normal follow-up cannot reach a sibling under the paused provider");
        assert.equal(countSince(afterNormalPhysical, beforeNormalPhysical, "fake-b", "alternate"), 1,
          "the normal physical selection remains routable through another provider");

        const beforePhysicalFollowUp = await fakeStats();
        const physicalFollowUp = await runPi({ home, work, model: "fake-a/sibling", messages: [
          "/bifrost pin",
          "do not send this pinned physical turn on the paused provider",
        ] });
        const afterPhysicalFollowUp = await fakeStats();
        assert.equal(countSince(afterPhysicalFollowUp, beforePhysicalFollowUp, "fake-a", "credits-exhausted"), 0);
        assert.equal(countSince(afterPhysicalFollowUp, beforePhysicalFollowUp, "fake-a", "sibling"), 0,
          "the restarted pinned physical model is blocked before generation");
        assert.match(physicalFollowUp.stderr, /provider fake-a is paused|pinned model was not dispatched/u);

        writeConfig(work, config(mode));
        const beforeFollowUp = await fakeStats();
        const messages = [...(mode === "v2" ? ["/bifrost reliability migrate"] : []), "use the next eligible model"];
        const followUp = await runPi({ home, work, messages });
        const afterFollowUp = await fakeStats();
        assert.equal(followUp.code, 0, followUp.stderr);
        assert.equal(countSince(afterFollowUp, beforeFollowUp, "fake-a", "sibling"), 0, "restart does not route to a sibling under the paused provider");
        assert.equal(countSince(afterFollowUp, beforeFollowUp, "fake-b", "alternate"), 1, "another provider remains eligible");
        assert.equal(countSince(afterFollowUp, beforeFollowUp, "fake-c", "general"), 0, "the retry remains inside the selected quick tier");
        assert.match(followUp.stderr, /Bifrost auto: quick → fake-b\/alternate/u);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`uses one same-tier alternate after an Auto 402 in ${mode}`, async () => {
      const { home, work } = freshDirs();
      try {
        writeModels(home, configuredModels);
        writeConfig(work, config(mode));
        const before = await fakeStats();
        const messages = [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "quick summarize the change"];
        const result = await runPi({ home, work, messages });
        const after = await fakeStats();
        assert.equal(result.code, 0, result.stderr);
        assert.equal(countSince(after, before, "fake-a", "credits-exhausted"), 1,
          `the initial 402 request happens once: ${result.stderr}\n${result.stdout}\n${JSON.stringify(after.stats.slice(before.stats.length))}`);
        assert.equal(countSince(after, before, "fake-a", "sibling"), 0, "the provider-wide pause excludes its sibling");
        assert.equal(countSince(after, before, "fake-b", "alternate"), 1, "one alternate completes the same user turn");
        assert.equal(countSince(after, before, "fake-c", "general"), 0, "the quick-tier boundary does not widen");
        assert.match(result.stderr, /retrying once with fake-b\/alternate \(quick\)/u);
        const providerStatePath = join(work, ".pi", "bifrost-provider-reliability.json");
        assert.equal(existsSync(providerStatePath), true);
        assert.ok(readFileSync(providerStatePath, "utf8").includes("fake-a"));
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
