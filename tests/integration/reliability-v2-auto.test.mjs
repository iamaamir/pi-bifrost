import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reliabilitySourceFencePath } from "../../reliability-v1-fence.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const MAX_CAPTURE_CHARS = 64 * 1024;
let fakePort;

function appendBounded(current, chunk) {
  return current.length >= MAX_CAPTURE_CHARS ? current : current + chunk.slice(0, MAX_CAPTURE_CHARS - current.length);
}

function stopChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("close", () => { clearTimeout(kill); resolve(); });
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
      output = appendBounded(output, chunk);
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

function writeFixture({ home, work, port, models, bifrost, retry = { enabled: false } }) {
  const agent = join(home, ".pi", "agent");
  // Most pre-existing integration cases assert the original per-model policy.
  // New provider-scope cases opt in explicitly below.
  const configuredBifrost = {
    ...bifrost,
    reliability: {
      ...bifrost.reliability,
      allowanceCooldownScope: bifrost.reliability?.allowanceCooldownScope ?? "model",
    },
  };
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  const modelsByProvider = new Map();
  for (const { provider = "fake", ...model } of models) {
    const providerModels = modelsByProvider.get(provider) ?? [];
    providerModels.push(model);
    modelsByProvider.set(provider, providerModels);
  }
  const providers = Object.fromEntries([...modelsByProvider].map(([provider, providerModels]) => [provider, {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey: provider === "fake" ? "fixture-only" : `fixture-${provider}`,
    models: providerModels,
  }]));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify(configuredBifrost));
}

function writeOutcomeObserver(work) {
  const extension = join(work, "allowance-outcome-observer.mjs");
  const output = join(work, "allowance-outcome-observer.json");
  writeFileSync(extension, `import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("session_shutdown", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const messages = branch.filter((entry) => entry.type === "message");
    const users = messages.filter((entry) => entry.message.role === "user").map((entry) => ({ id: entry.id }));
    const assistants = messages.filter((entry) => entry.message.role === "assistant").map((entry) => ({
      id: entry.id, parentId: entry.parentId, provider: entry.message.provider, model: entry.message.model,
      stopReason: entry.message.stopReason,
      contentLength: Array.isArray(entry.message.content) ? entry.message.content.length : -1,
    }));
    const contextEdits = branch.filter((entry) => entry.type === "context_edit").map((entry) => ({
      targetId: entry.targetId, isNull: entry.replacement === null,
    }));
    const entries = branch.map((entry) => ({ type: entry.type, id: entry.id, parentId: entry.parentId, targetId: entry.targetId }));
    writeFileSync(${JSON.stringify(output)}, JSON.stringify({ userCount: users.length, users, assistants, contextEdits, entries }));
  });
}`);
  return { extension, output };
}

function runPi({ home, work, model = "bifrost/auto", messages, extraExtensions = [] }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const extensionArgs = extraExtensions.flatMap((extension) => ["-e", extension]);
    const child = spawn(PI, ["-e", EXTENSION, ...extensionArgs, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env: {
        ...env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        PI_SKIP_VERSION_CHECK: "1",
        PI_OFFLINE: "1",
        NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
        BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
        BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKill;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 90_000);
    child.on("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      await stopChild(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      try {
        const violations = readFileSync(join(home, "test-network-violations.log"), "utf8");
        assert.equal(violations, "", "test network guard recorded a blocked external request");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function fakeStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function v2Config({ classifier = { enabled: false } } = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier,
    models: { quick: ["fake/healthy"] },
    reliability: { stateVersion: 2, failureThreshold: 1, windowMinutes: 10, cooldownMinutes: 1 },
  };
}

function seedExpiredV1Circuit(work, model = "fake/healthy") {
  const now = Date.now();
  writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
    version: 1,
    models: { [model]: { failures: [now - 60_000], openUntil: now - 1_000, trialActive: false } },
  }));
}

async function prepareV2AndRun({ home, work, port, models, config = v2Config(), messages, retry }) {
  writeFixture({ home, work, port, models, bifrost: config, retry });
  seedExpiredV1Circuit(work, config.models.quick[0]);
  return runPi({ home, work, messages: ["/bifrost reliability migrate", ...messages] });
}

describe("pinned Pi reliability v2 Auto path", { timeout: 360_000, concurrency: 1 }, () => {
  let server;
  before(async () => { server = await startFakeServer(); fakePort = server.port; });
  after(async () => { if (server?.child) await stopChild(server.child); });

  for (const mode of ["v1", "v2"]) {
    for (const { name, quickModels, shouldRecover } of [
      {
        name: "eligible same-tier alternate",
        quickModels: ["fake-a/subscription-required", "fake-a/sibling", "fake-b/quick"],
        shouldRecover: true,
      },
      {
        name: "exhausted quick pool despite a general model",
        quickModels: ["fake-a/subscription-required", "fake-a/sibling"],
        shouldRecover: false,
      },
    ]) {
      it(`recovers a quick-prefixed subscription 403 once in ${mode} Auto only with ${name}`, async () => {
        const home = mkdtempSync(join(tmpdir(), `bifrost-subscription-prefix-${mode}-home-`));
        const work = mkdtempSync(join(tmpdir(), `bifrost-subscription-prefix-${mode}-work-`));
        try {
          const models = [
            { provider: "fake-a", id: "subscription-required", reasoning: false },
            { provider: "fake-a", id: "sibling", reasoning: false },
            { provider: "fake-b", id: "quick", reasoning: false },
            { provider: "fake-c", id: "general", reasoning: false },
          ];
          writeFixture({
            home,
            work,
            port: server.port,
            models,
            bifrost: {
              ...(mode === "v2" ? { schemaVersion: 2 } : {}),
              enabled: true,
              default: "quick",
              strategy: "first",
              categoryStrategies: { quick: "first", general: "first" },
              classifier: { enabled: false },
              models: { quick: quickModels, general: ["fake-c/general"] },
              reliability: {
                enabled: true,
                failureThreshold: 3,
                windowMinutes: 5,
                cooldownMinutes: 60,
                allowanceCooldownScope: "provider",
                ...(mode === "v2" ? { stateVersion: 2 } : {}),
              },
              debug: { enabled: true },
            },
          });
          const observer = writeOutcomeObserver(work);
          const before = await fakeStats(server.port);
          const result = await runPi({
            home,
            work,
            extraExtensions: [observer.extension],
            messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "quick summary"],
          });
          const after = await fakeStats(server.port);
          const delta = (model) => (after.attempts[model] ?? 0) - (before.attempts[model] ?? 0);

          assert.equal(result.timedOut, false, result.stderr);
          assert.equal(delta("subscription-required"), 1, result.stderr);
          assert.equal(delta("sibling"), 0, `${result.stderr}\nthe failed provider sibling is never retried`);
          assert.equal(delta("general"), 0, "the explicit quick prefix never widens to general");
          if (shouldRecover) {
            assert.equal(result.code, 0, result.stderr);
            assert.equal(delta("quick"), 1, "one eligible other-provider quick model is dispatched");
            assert.match(result.stderr, /Bifrost: billing was denied for fake-a\/subscription-required; retrying once with fake-b\/quick \(quick\)/);
            const outcome = JSON.parse(readFileSync(observer.output, "utf8"));
            assert.equal(outcome.userCount, 1, "the failed request is not re-enqueued");
            assert.equal(outcome.assistants.length, 2, "there is one failed generation and one bounded alternate");
            const failed = outcome.assistants.find((entry) => entry.provider === "fake-a" && entry.model === "subscription-required");
            const succeeded = outcome.assistants.find((entry) => entry.provider === "fake-b" && entry.model === "quick" && entry.stopReason === "stop");
            assert.ok(failed, "the original provider denial remains in the transcript");
            assert.ok(succeeded, "the alternate succeeds on the same turn");
            assert.equal(failed.contentLength, 0, "recovery requires an empty failed response");
            assert.equal(outcome.users[0].id, failed.parentId, `the failed generation belongs to the original user boundary: ${JSON.stringify(outcome)}`);
            const ancestors = new Set();
            let currentId = succeeded.id;
            while (currentId && !ancestors.has(currentId)) {
              ancestors.add(currentId);
              currentId = outcome.entries.find((entry) => entry.id === currentId)?.parentId;
            }
            assert.ok(ancestors.has(outcome.users[0].id), `the alternate remains under the original user boundary: ${JSON.stringify(outcome)}`);
            assert.ok(outcome.contextEdits.some((entry) => entry.targetId === failed.id && entry.isNull),
              "Pi records a null projection edit for the empty failed response");
          } else {
            assert.notEqual(result.code, 0, result.stderr);
            assert.equal(delta("quick"), 0, "provider pause exhausts quick and recovery stops");
            assert.match(result.stderr, /billing was denied for fake-a\/subscription-required\. No eligible configured alternative is available for quick; no retry was sent/);
          }
        } finally {
          rmSync(home, { recursive: true, force: true });
          rmSync(work, { recursive: true, force: true });
        }
      });
    }
  }

  it("retains the successful Auto model across native turns while prefixes use the random strategy", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-affinity-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-affinity-auto-work-"));
    const baselineHome = mkdtempSync(join(tmpdir(), "bifrost-affinity-baseline-home-"));
    const baselineWork = mkdtempSync(join(tmpdir(), "bifrost-affinity-baseline-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "allowed", reasoning: false }, { id: "alternate", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "random", classifier: { enabled: false },
          models: { quick: ["fake/allowed", "fake/alternate"] },
          reliability: { stateVersion: 1 },
          debug: { enabled: true },
        },
      });
      const rngExtension = join(work, "affinity-rng-extension.mjs");
      writeFileSync(rngExtension, `
        import { writeFileSync } from "node:fs";
        let inputIndex = 0;
        let active = false;
        let draws = 0;
        const records = [];
        const values = [0.05, 0.95, 0.95];
        Math.random = () => {
          if (active) draws += 1;
          return values[Math.min(inputIndex - 1, values.length - 1)] ?? 0.5;
        };
        export default function(pi) {
          pi.on("before_agent_start", () => {
            inputIndex += 1;
            draws = 0;
            active = true;
          });
          pi.on("turn_end", () => {
            if (active) {
              records.push({ input: inputIndex, draws });
              active = false;
            }
          });
          pi.on("session_shutdown", () => {
            if (active) records.push({ input: inputIndex, draws });
            writeFileSync("affinity-rng-records.json", JSON.stringify(records));
          });
        }
      `);

      const before = await fakeStats(server.port);
      const result = await runPi({
        home,
        work,
        extraExtensions: [rngExtension],
        messages: ["first same-tier turn", "second same-tier turn", "quick explicit tier turn"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, "pinned Pi must finish within the bounded test window");
      assert.equal(result.code, 0, result.stderr);

      const attempts = Object.fromEntries(Object.entries(after.attempts)
        .map(([model, count]) => [model, count - (before.attempts[model] ?? 0)])
        .filter(([, count]) => count !== 0));
      assert.deepEqual(attempts, { allowed: 2, alternate: 1 }, "three user turns generate exactly three fake-provider requests, with no classifier calls");
      assert.match(result.stderr, /Bifrost auto: quick → fake\/allowed/);
      assert.match(result.stderr, /Bifrost auto: quick → fake\/alternate/);

      const debug = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const decisions = debug.filter((entry) => entry.event === "route_decision").map((entry) => entry.decision);
      assert.equal(decisions.length, 3, "one route decision per native user turn");
      assert.deepEqual(decisions.slice(0, 2).map((decision) => decision.affinity.strategyWinner), ["fake/allowed", "fake/alternate"],
        "the controlled random strategy alternates its base winner across the automatic turns");
      assert.deepEqual(decisions.map((decision) => decision.selected), ["fake/allowed", "fake/allowed", "fake/alternate"],
        "the second automatic turn retains its proven anchor; the explicit prefix uses the strategy winner");
      assert.equal(decisions[1].affinity.selection, "retained_anchor");
      assert.equal(decisions[2].selectedStrategy, "random");
      assert.equal(decisions[2].affinity.selection, "not_applicable", "an explicit prefix bypasses retention policy");

      const rngRecords = JSON.parse(readFileSync(join(work, "affinity-rng-records.json"), "utf8"));
      assert.equal(rngRecords.length, 3);

      writeFixture({
        home: baselineHome, work: baselineWork, port: server.port,
        models: [{ id: "allowed", reasoning: false }, { id: "alternate", reasoning: false }],
        bifrost: {
          schemaVersion: 2,
          enabled: true, default: "quick", strategy: "random", classifier: { enabled: false },
          models: { quick: ["fake/allowed", "fake/alternate"] },
          affinity: { mode: "off" },
          reliability: { stateVersion: 1 },
          debug: { enabled: true },
        },
      });
      const baselineRngExtension = join(baselineWork, "affinity-rng-extension.mjs");
      writeFileSync(baselineRngExtension, readFileSync(rngExtension, "utf8"));
      const baselineBefore = await fakeStats(server.port);
      const baseline = await runPi({
        home: baselineHome,
        work: baselineWork,
        extraExtensions: [baselineRngExtension],
        messages: ["first same-tier turn", "second same-tier turn", "quick explicit tier turn"],
      });
      const baselineAfter = await fakeStats(server.port);
      assert.equal(baseline.timedOut, false, "baseline Pi must finish within the bounded test window");
      assert.equal(baseline.code, 0, baseline.stderr);
      assert.deepEqual(
        Object.fromEntries(Object.entries(baselineAfter.attempts)
          .map(([model, count]) => [model, count - (baselineBefore.attempts[model] ?? 0)])
          .filter(([, count]) => count !== 0)),
        { allowed: 1, alternate: 2 },
        "the explicit-off baseline also makes exactly one provider request per turn",
      );
      const baselineDebug = readFileSync(join(baselineWork, ".pi", "bifrost-debug.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const baselineDecisions = baselineDebug.filter((entry) => entry.event === "route_decision").map((entry) => entry.decision);
      assert.deepEqual(baselineDecisions.map((decision) => decision.selected), ["fake/allowed", "fake/alternate", "fake/alternate"]);
      const baselineRngRecords = JSON.parse(readFileSync(join(baselineWork, "affinity-rng-records.json"), "utf8"));
      assert.deepEqual(rngRecords.map((record) => record.draws), baselineRngRecords.map((record) => record.draws),
        "Auto retention performs zero extra random draws compared with the configured off baseline");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(baselineHome, { recursive: true, force: true });
      rmSync(baselineWork, { recursive: true, force: true });
    }
  });

  for (const mode of ["v1", "v2"]) {
    it(`retries one zero-effect allowance failure with a configured alternate in ${mode} Auto`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-retry-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-retry-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
          debug: { enabled: true },
        };
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
          bifrost,
        });
        const before = await fakeStats(server.port);
        const userPrompt = "respond with one word";
        const observer = writeOutcomeObserver(work);
        const result = await runPi({ home, work, extraExtensions: [observer.extension], messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), userPrompt] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false, result.stderr);
        assert.equal(result.code, 0, result.stderr);
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1, result.stderr);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
          `${result.stderr}\n${readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8")}`);
        assert.match(result.stderr, /usage limit reached for fake\/usage-exhausted; retrying once with fake\/healthy/);
        assert.match(result.stderr, /Bifrost auto: quick → fake\/healthy \(allowance recovery/);
        const trace = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8");
        assert.match(trace, /"event":"allowance_retry_prepared"/);
        assert.match(trace, /"event":"allowance_retry_consumed"/);
        assert.equal(trace.includes("respond with one word"), false, "debug trace must not retain prompt text");
        const outcome = JSON.parse(readFileSync(observer.output, "utf8"));
        assert.equal(outcome.userCount, 1, "the failed user request is never re-enqueued");
        const failed = outcome.assistants.filter((entry) => entry.provider === "fake" && entry.model === "usage-exhausted");
        const succeeded = outcome.assistants.filter((entry) => entry.provider === "fake" && entry.model === "healthy" && entry.stopReason === "stop");
        assert.equal(failed.length, 1, "the empty failed assistant remains in the raw transcript");
        assert.equal(failed[0].contentLength, 0);
        assert.equal(succeeded.length, 1, "the alternate result is attached to the same user turn");
        assert.ok(outcome.contextEdits.some((entry) => entry.targetId === failed[0].id && entry.isNull),
          "Pi records the exact null omission for the failed response projection");
        if (mode === "v2") {
          const state = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "utf8"));
          const receipts = Object.values(state.dispatches);
          assert.equal(receipts.length, 2, "failed and alternate generations own distinct receipts");
          assert.equal(new Set(receipts.map((receipt) => receipt.dispatchId)).size, 2);
          assert.deepEqual(receipts.map((receipt) => receipt.settledKind).sort(), ["failure", "success"]);
          assert.ok(receipts.every((receipt) => receipt.settledAt && receipt.scopes.every((scope) => !scope.leaseId)),
            "both receipts settle and release all owned leases");
          assert.ok(state.scopes["model:20:fake/usage-exhausted"]?.openUntil, "the failed model remains cooled");
          assert.equal(state.scopes["model:12:fake/healthy"]?.failures.length, 0,
            "the successful alternate has no failure evidence");
          assert.ok(Object.values(state.scopes).every((scope) => scope.lease === undefined), "no circuit lease remains wedged");
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`does not retry an allowance failure when ${mode} Auto recovery is disabled`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-off-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-off-${mode}-work-`));
      try {
      const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            retryOnAllowanceExhausted: false,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
        };
        writeFixture({ home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }], bifrost });
        const before = await fakeStats(server.port);
        const observer = writeOutcomeObserver(work);
        const result = await runPi({ home, work, extraExtensions: [observer.extension], messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "respond with one word"] });
        const after = await fakeStats(server.port);
        assert.notEqual(result.code, 0, "the usage-limited provider ends the turn when automatic recovery is disabled");
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0);
        assert.match(result.stderr, /Automatic retry is off/);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`explains when ${mode} Auto has no configured allowance alternative`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-noalt-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-noalt-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
        };
        writeFixture({ home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }], bifrost });
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work, messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "respond with one word"] });
        const after = await fakeStats(server.port);
        assert.notEqual(result.code, 0, "the usage-limited provider ends the turn when no alternative is configured");
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
        assert.match(result.stderr, /No eligible configured alternative/);
        assert.match(result.stderr, /no retry was sent/);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`stops after the single alternate allowance attempt in ${mode} Auto`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-once-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-once-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted", "fake/usage-exhausted-alternate", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
        };
        writeFixture({ home, work, port: server.port,
          models: ["usage-exhausted", "usage-exhausted-alternate", "healthy"].map((id) => ({ id, reasoning: false })), bifrost });
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work, messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "respond with one word"] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false);
        assert.notEqual(result.code, 0, "the alternate also returns an explicit usage limit");
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
        assert.equal((after.attempts["usage-exhausted-alternate"] ?? 0) - (before.attempts["usage-exhausted-alternate"] ?? 0), 1);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "Bifrost must stop after one alternate, without trying a third model");
        assert.match(result.stderr, /retrying once with fake\/usage-exhausted-alternate/);
        assert.doesNotMatch(result.stderr, /retrying once with fake\/healthy/);
        assert.match(result.stderr, /The alternate also returned a usage limit\. Automatic retry limit reached\./);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`allows one Bifrost alternate after Pi's empty native retry in ${mode} Auto`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-host-retry-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-host-retry-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
        };
        writeFixture({ home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }], bifrost,
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } });
        const before = await fakeStats(server.port);
        const observer = writeOutcomeObserver(work);
        const result = await runPi({ home, work, extraExtensions: [observer.extension], messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "respond with one word"] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false);
        assert.equal(result.code, 0, result.stderr);
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 2,
          "Pi makes its one host-owned retry before Bifrost considers the boundary");
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
          "Bifrost may make one alternate attempt after two proven empty errors from the same model");
        assert.match(result.stderr, /retrying once with fake\/healthy/);
        const outcome = JSON.parse(readFileSync(observer.output, "utf8"));
        assert.equal(outcome.userCount, 1, "Pi's two native retries and Bifrost recovery stay inside one original user boundary");
        const failed = outcome.assistants.filter((entry) => entry.provider === "fake" && entry.model === "usage-exhausted");
        assert.equal(failed.length, 2);
        assert.ok(failed.every((entry) => entry.contentLength === 0 && entry.stopReason === "error"));
        assert.ok(failed.every((entry) => outcome.contextEdits.some((edit) => edit.targetId === entry.id && edit.isNull)),
          "Pi's exact null context edits omit both empty native failures");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`cools only an explicitly exhausted model before the next fresh ${mode} Auto turn`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-allowance-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-allowance-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          categoryStrategies: { quick: "first" },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            retryOnAllowanceExhausted: false,
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
          debug: { enabled: true },
        };
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
          bifrost,
        });
        const before = await fakeStats(server.port);
        const messages = ["first request gets an explicit usage limit", "fresh follow-up request"];
        const result = await runPi({ home, work, messages: mode === "v2" ? ["/bifrost reliability migrate --fresh", ...messages] : messages });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false, "pinned Pi must finish within the bounded test window");
        assert.equal(result.code, 0, result.stderr);
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
          "the failed prompt is sent once and never replayed");
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
          "the next fresh user turn selects the other configured eligible model");
        assert.match(result.stderr, /Bifrost auto: quick → fake\/usage-exhausted/);
        assert.match(result.stderr, /hit a billing or usage limit; paused until/);
        assert.match(result.stderr, /Automatic retry is off/);
        assert.match(result.stderr, /Bifrost auto: quick → fake\/healthy/);

        const statePath = mode === "v2" ? ".pi/bifrost-reliability-v2.json" : ".pi/bifrost-reliability.json";
        const state = JSON.parse(readFileSync(join(work, statePath), "utf8"));
        const record = mode === "v2" ? state.scopes["model:20:fake/usage-exhausted"] : state.models["fake/usage-exhausted"];
        assert.ok(record.openUntil > Date.now() + 59 * 60_000, "default cooldown remains active for the next turn");
        if (mode === "v1") {
          assert.equal(record.lastFailureReason, "allowance_exhausted:text_heuristic:model-only");
        } else {
          assert.equal(Object.values(state.settledOutcomes).some((outcome) => outcome.observation !== undefined), false,
            "v2 enforces the typed evidence without enabling optional observation persistence");
        }
        const events = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.ok(events.some((event) => mode === "v1"
          ? event.event === "legacy_outcome_observed" && event.category === "allowance_exhausted"
          : event.event === "receipt_settled" && event.category === "allowance_exhausted"));
        assert.equal(JSON.stringify(events).includes("The usage limit has been reached"), false,
          "the content-free trace does not retain the provider error text");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`does not retry or select a same-provider sibling after a ${mode} Auto credit pause`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-provider-pause-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-provider-pause-${mode}-work-`));
      try {
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          categoryStrategies: { quick: "first" },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            allowanceCooldownScope: "provider",
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
        };
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
          bifrost,
        });
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work,
          messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "respond with one word"] });
        const after = await fakeStats(server.port);
        assert.notEqual(result.code, 0, result.stderr);
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
          "the original empty failure is attempted once");
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "the shared provider pause excludes its sibling before bounded retry selection");
        assert.match(result.stderr, /provider fake is paused|No eligible configured alternative/);
        assert.match(result.stderr, /no retry was sent|no automatic retry was sent/);
        assert.equal(readFileSync(join(work, ".pi", "bifrost-provider-reliability.json"), "utf8").includes("fake"), true,
          "the provider pause is persisted in the shared sidecar");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });

    it(`imports an active legacy model-only allowance pause into provider scope in ${mode}`, async () => {
      const home = mkdtempSync(join(tmpdir(), `bifrost-provider-upgrade-${mode}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-provider-upgrade-${mode}-work-`));
      try {
        const openUntil = Date.now() + 60 * 60 * 1000;
        const bifrost = {
          ...(mode === "v2" ? { schemaVersion: 2 } : {}),
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          categoryStrategies: { quick: "first" },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: {
            enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60,
            allowanceCooldownScope: "provider",
            ...(mode === "v2" ? { stateVersion: 2 } : {}),
          },
        };
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
          bifrost,
        });
        writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
          version: 1,
          models: {
            "fake/usage-exhausted": {
              failures: [Date.now() - 1], openUntil,
              lastFailureAt: Date.now() - 1,
              lastFailureReason: "allowance_exhausted:structured:model-only",
            },
          },
        }));
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work,
          messages: [...(mode === "v2" ? ["/bifrost reliability migrate --fresh"] : []), "respond with one word"] });
        const after = await fakeStats(server.port);
        assert.notEqual(result.code, 0, result.stderr);
        assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 0,
          "the legacy allowance marker is imported before routing");
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "provider scope blocks the same-provider sibling");
        const providerState = JSON.parse(readFileSync(join(work, ".pi", "bifrost-provider-reliability.json"), "utf8"));
        const usageKey = Object.keys(providerState.scopes).find((key) => key.endsWith(":bifrost-provider-usage/fake"));
        assert.ok(usageKey, "the old marker creates a shared provider pause");
        assert.equal(providerState.scopes[usageKey].openUntil, openUntil,
          "migration preserves the original remaining cooldown");
        assert.ok(Object.keys(providerState.scopes).some((key) => key.includes("bifrost-provider-import/")),
          "the import watermark is persisted to prevent reset from resurrecting the old pause");
        if (mode === "v1") {
          const resetBefore = await fakeStats(server.port);
          const resetResult = await runPi({ home, work, messages: ["/bifrost reliability reset --provider fake", "respond with one word"] });
          const resetAfter = await fakeStats(server.port);
          assert.equal((resetAfter.attempts["usage-exhausted"] ?? 0) - (resetBefore.attempts["usage-exhausted"] ?? 0), 1,
            `after explicit reset and restart, the same historical marker does not block the model again: ${resetResult.stderr}`);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it("does not dispatch the alternate when a v1 reliability source lock blocks cooldown persistence", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-save-fail-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-save-fail-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted", "fake/healthy"] },
          reliability: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 },
        },
      });
      const lockPath = reliabilitySourceFencePath(join(work, ".pi", "bifrost-reliability.json"));
      writeFileSync(lockPath, "held by deterministic test");
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["respond with one word"] });
      const after = await fakeStats(server.port);
      assert.notEqual(result.code, 0);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0);
      assert.match(result.stderr, /cooldown could not be confirmed as saved, so no retry was sent/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("honors an exhausted explicit v2 fallback boundary during allowance recovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-strict-fallback-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-strict-fallback-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
        bifrost: {
          schemaVersion: 2, enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" }, classifier: { enabled: false },
          models: { quick: ["fake/usage-exhausted"], general: ["fake/healthy"] }, tierPolicies: { quick: { fallbackTiers: [] } },
          reliability: { enabled: true, stateVersion: 2, failureThreshold: 3, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["/bifrost reliability migrate --fresh", "respond with one word"] });
      const after = await fakeStats(server.port);
      assert.notEqual(result.code, 0);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
        "an explicit empty fallback list prevents searching another configured tier");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("uses the default configured tier after a legacy general-tier allowance failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-legacy-tier-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-legacy-tier-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }, { id: "classifier", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first", general: "first" },
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { quick: ["fake/healthy"], general: ["fake/usage-exhausted"] },
          reliability: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["implement a normal feature"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts.classifier ?? 0) - (before.attempts.classifier ?? 0), 1,
        "classification selects general once for the original user boundary");
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "without explicit fallback policy, recovery searches the configured default tier");
      assert.match(result.stderr, /allowance recovery/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not degrade a fresh v1 Auto turn to a singleton model on allowance cooldown", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-single-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-single-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: false }, models: { quick: ["fake/usage-exhausted"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["trigger explicit usage exhaustion", "fresh request must not reuse blocked model"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
        "the first error is not replayed and the second fresh turn does not hit the blocked singleton");
      assert.match(result.stderr, /Bifrost: the last dispatched model is on an active model-only allowance cooldown/);
      assert.doesNotMatch(result.stderr, /Bifrost: keeping fake\/usage-exhausted/,
        "the legacy last-dispatched-model degrade path must not override a typed allowance cooldown");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not generate on an allowance-cooled physical model when no alternative resolves", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-physical-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-physical-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: false }, models: { quick: ["fake/usage-exhausted"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const result = await runPi({
        home, work, model: "fake/usage-exhausted",
        messages: ["trigger explicit usage exhaustion", "fresh physical request must not reach the cooled model"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 1, "the first provider error remains the command failure; the second turn is handled locally");
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1,
        "the follow-up physical input is handled before generation on the active cooled model");
      assert.match(result.stderr, /active physical model is on an active model-only allowance cooldown/);
      assert.match(result.stderr, /the turn was not sent/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("guards the last dispatched allowance-blocked model in a mixed hard/ordinary open pool", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-mixed-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-mixed-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "ordinary-open", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: false }, models: { quick: ["fake/usage-exhausted", "fake/ordinary-open"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const now = Date.now();
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/ordinary-open": { failures: [now], openUntil: now + 60 * 60_000, lastFailureReason: "provider request failed" } },
      }));
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["trigger explicit usage exhaustion", "fresh request must not reuse blocked model"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 1);
      assert.equal((after.attempts["ordinary-open"] ?? 0) - (before.attempts["ordinary-open"] ?? 0), 0);
      assert.match(result.stderr, /last dispatched model is on an active model-only allowance cooldown/);
      assert.doesNotMatch(result.stderr, /Bifrost: keeping fake\/usage-exhausted/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("skips a prompt-classifier model with a proven active v1 allowance cooldown", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-allowance-classifier-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-allowance-classifier-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", categoryStrategies: { quick: "first" },
          classifier: { enabled: true, backend: "prompt", model: "fake/usage-exhausted" },
          models: { quick: ["fake/healthy"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
          debug: { enabled: true },
        },
      });
      const now = Date.now();
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/usage-exhausted": {
          failures: [now], openUntil: now + 60 * 60_000,
          lastFailureReason: "allowance_exhausted:text_heuristic:model-only",
        } },
      }));
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["classify then route without the blocked classifier"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 0,
        "the known active model is skipped before classifier transport or generation");
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "default-tier routing continues without a provider-backed classifier call");
      const events = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.module === "classifier" && event.event === "allowance_cooldown_skip"
        && event.model === "fake/usage-exhausted" && event.scope === "model-only"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not invoke a registered v2 prompt classifier while its generation circuit is open", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-classifier-circuit-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-classifier-circuit-work-"));
    try {
      const config = v2Config({ classifier: { enabled: true, backend: "prompt", model: "fake/usage-exhausted" } });
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "usage-exhausted", reasoning: false }, { id: "healthy", reasoning: false }],
        bifrost: { ...config, models: { quick: ["fake/healthy"] }, debug: { enabled: true } },
      });
      const now = Date.now();
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/usage-exhausted": { failures: [now], openUntil: now + 60 * 60_000, trialActive: false } },
      }));
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, messages: ["/bifrost reliability migrate", "classify locally because classifier model is circuit-open"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts["usage-exhausted"] ?? 0) - (before.attempts["usage-exhausted"] ?? 0), 0,
        "the same registered model is not called as a classifier while its v2 generation circuit is open");
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "classification falls through to the configured default route");
      assert.match(result.stderr, /Bifrost auto: quick → fake\/healthy/);
      const events = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.module === "classifier" && event.event === "generation_circuit_unavailable_skip"
        && event.model === "fake/usage-exhausted" && event.scope === "model-only"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("closes the exact initialized v2 half-open lease after a successful pinned-Pi turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-e2e-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-e2e-work-"));
    try {
      const before = await fakeStats(server.port);
      const result = await prepareV2AndRun({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        messages: ["hello half-open"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, "pinned Pi must finish within the bounded test window");
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "the successful half-open user turn produces exactly one provider generation request");
      assert.match(result.stderr, /Reliability v2 sidecar initialized/);

      const state = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "utf8"));
      const dispatches = Object.values(state.dispatches);
      assert.equal(dispatches.length, 1, "one fresh Auto user turn owns one persisted dispatch receipt");
      const [receipt] = dispatches;
      assert.equal(receipt.settledKind, "success");
      assert.equal(receipt.scopes.length, 1);
      assert.equal(receipt.scopes[0].modelKey, "fake/healthy");
      assert.equal(typeof receipt.scopes[0].leaseId, "string", "the persisted receipt must identify the exact half-open lease it closed");
      const scope = state.scopes[receipt.scopes[0].scopeKey];
      assert.equal(scope.lease, undefined, "the exact half-open lease must be closed");
      assert.equal(scope.openUntil, undefined);
      assert.deepEqual(scope.failures, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reuses one v2 receipt and model across a Pi-owned error retry, without Bifrost replay", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-retry-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-retry-work-"));
    try {
      const before = await fakeStats(server.port);
      const result = await prepareV2AndRun({
        home, work, port: server.port,
        models: [{ id: "fail-then-ok", reasoning: false }],
        config: { ...v2Config({ classifier: { enabled: false } }), models: { quick: ["fake/fail-then-ok"] }, debug: { enabled: true } },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
        messages: ["secret-lifecycle-prompt-sentinel"],
      });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false, "the deterministic Pi retry must complete within the bounded test window");
      assert.equal(result.code, 0, result.stderr);
      assert.equal((after.attempts["fail-then-ok"] ?? 0) - (before.attempts["fail-then-ok"] ?? 0), 2,
        "one provider error followed by one host-owned retry must account for exactly two attempts");

      const state = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "utf8"));
      const dispatches = Object.values(state.dispatches);
      assert.equal(dispatches.length, 1, "retry remains part of its original logical dispatch, not a Bifrost replay");
      const [receipt] = dispatches;
      assert.equal(receipt.settledKind, "success", "the host retry's successful final result settles the original receipt");
      assert.equal(receipt.scopes.length, 1);
      assert.equal(receipt.scopes[0].modelKey, "fake/fail-then-ok", "retry must retain the originally admitted model");
      assert.equal(typeof receipt.scopes[0].leaseId, "string", "host retry must reuse the original half-open lease");
      const scope = state.scopes[receipt.scopes[0].scopeKey];
      assert.equal(scope.lease, undefined);
      assert.deepEqual(scope.failures, [], "the transient failed attempt is not settled as a separate Bifrost outcome");

      const traceText = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8");
      const trace = traceText.trim().split("\n").map((line) => JSON.parse(line));
      const userRequest = trace.find((row) => row.module === "virtual" && row.event === "request" && row.reason === "user");
      const retryRequest = trace.find((row) => row.module === "virtual" && row.event === "request" && row.reason === "retry");
      assert.ok(userRequest?.turn_correlation_id && retryRequest?.turn_correlation_id,
        "normal Pi shutdown must flush correlated Auto request records");
      assert.equal(userRequest.turn_correlation_id, retryRequest.turn_correlation_id,
        "Pi's retry belongs to the same proven user turn");
      assert.notEqual(userRequest.request_correlation_id, retryRequest.request_correlation_id,
        "the initial request and host retry have distinct log-only request IDs");
      assert.equal(userRequest.session_correlation_id, retryRequest.session_correlation_id);
      const retryTurn = userRequest.turn_correlation_id;
      assert.ok(trace.some((row) => row.event === "selected" && row.turn_correlation_id === retryTurn && row.model === "fake/fail-then-ok"));
      assert.ok(trace.some((row) => row.event === "admitted" && row.turn_correlation_id === retryTurn && row.status === "admitted"));
      assert.ok(trace.some((row) => row.event === "outcome_observed" && row.turn_correlation_id === retryTurn && row.outcome === "failure"));
      assert.ok(trace.some((row) => row.event === "outcome_observed" && row.turn_correlation_id === retryTurn && row.outcome === "success"));
      assert.ok(trace.some((row) => row.event === "receipt_settled" && row.turn_correlation_id === retryTurn && row.status === "confirmed"));
      assert.equal(traceText.includes("secret-lifecycle-prompt-sentinel"), false);
      assert.equal(traceText.includes("ownerToken"), false);
      assert.equal(traceText.includes(Object.keys(state.dispatches)[0]), false, "internal receipt IDs stay out of the log");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  for (const corrupt of [false, true]) {
    it(`blocks Auto before classifier or generation requests when the v2 sidecar is ${corrupt ? "corrupt" : "missing"}`, async () => {
      const home = mkdtempSync(join(tmpdir(), "bifrost-v2-unready-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-v2-unready-work-"));
      try {
        const config = v2Config({ classifier: { enabled: true, backend: "prompt", model: "fake/classifier" } });
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "healthy", reasoning: false }, { id: "classifier", reasoning: false }],
          bifrost: config,
        });
        if (corrupt) writeFileSync(join(work, ".pi", "bifrost-reliability-v2.json"), "{ not-json");
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work, messages: ["hello must not send"] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "uninitialized v2 must stop before final generation");
        assert.equal((after.attempts.classifier ?? 0) - (before.attempts.classifier ?? 0), 0,
          "uninitialized v2 must stop before the external prompt classifier too");
        assert.match(result.stderr, /reliability v2 state is missing or unavailable/i);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it("blocks physical generation under v2 while leaving the explicitly selected physical model untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-v2-physical-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-v2-physical-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: v2Config(),
      });
      const before = await fakeStats(server.port);
      const result = await runPi({ home, work, model: "fake/healthy", messages: ["hello physical unsupported"] });
      const after = await fakeStats(server.port);
      assert.equal(result.timedOut, false);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
        "physical routing cannot bypass the v2 receipt-owned Auto boundary");
      assert.match(`${result.stdout}\n${result.stderr}`, /supports Auto turns only; select bifrost\/auto or use reliability stateVersion 1/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  for (const command of ["off", "pin"]) {
    it(`keeps explicit /bifrost ${command} usable when the v2 sidecar is missing`, async () => {
      const home = mkdtempSync(join(tmpdir(), "bifrost-v2-manual-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-v2-manual-work-"));
      try {
        writeFixture({
          home, work, port: server.port,
          models: [{ id: "healthy", reasoning: false }],
          bifrost: v2Config(),
        });
        const before = await fakeStats(server.port);
        const result = await runPi({ home, work, messages: [`/bifrost ${command}`] });
        const after = await fakeStats(server.port);
        assert.equal(result.timedOut, false);
        assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 0,
          "manual exit selects a physical model but must not start generation");
        assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`Bifrost ${command === "off" ? "disabled" : "pinned"}`, "i"));
        assert.doesNotMatch(result.stderr, /reliability v2 state is missing or unavailable/i,
          "manual controls do not require the receipt sidecar to change the selected mode");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
