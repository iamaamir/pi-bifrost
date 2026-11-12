import { after, before, describe, it } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_PATH = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("fake provider did not start")); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        if (ready.port) { clearTimeout(timer); resolve({ child, port: ready.port }); }
      } catch { /* wait for the ready JSON line */ }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function fixture({ home, work, port, models = [
  { id: "auto-selection-held-general", reasoning: false, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
  { id: "frontier-healthy", reasoning: false, cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } },
] }) {
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
    fake: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "fixture-only",
      models,
    },
  } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    retry: { enabled: false },
    enabledModels: ["fake/*"],
  }));
  return {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
      BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
    },
  };
}

async function stats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

async function probeGate(port, action, model = "auto-selection-held-general") {
  const response = await fetch(`http://127.0.0.1:${port}/_probe-gate/${action}?model=${encodeURIComponent(model)}`, { method: "POST" });
  assert.equal(response.ok, true);
}

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function startRpc({ home, work, model = "fake/auto-selection-held-general", models }) {
  const paths = fixture({ home, work, port: server.port, models });
  const child = spawn("pi", ["-e", EXTENSION_PATH, "--approve", "--mode", "rpc", "--no-session", "--no-tools", "--model", model], {
    cwd: paths.cwd,
    env: paths.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  let partial = "";
  let stderr = "";
  let wake;
  let closeInfo;
  let spawnError;
  const closed = new Promise((resolve) => child.once("close", (code) => { closeInfo = { code }; wake?.(); resolve(closeInfo); }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${partial}${chunk}`.split("\n");
    partial = lines.pop();
    for (const line of lines) { try { records.push(JSON.parse(line)); } catch { /* unexpected RPC output is captured by timeout */ } }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });
  const wait = (deadline) => new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    wake = finish;
  });
  async function request(message) {
    const id = `bootstrap-selection-${Date.now()}-${records.length}`;
    const start = records.length;
    const deadline = Date.now() + 30_000;
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return record;
        }
      }
      assert.ifError(spawnError);
      assert.equal(closeInfo, undefined, `Pi RPC exited before ${message.type}`);
      await wait(deadline);
    }
    throw new Error(`Pi RPC timed out waiting for ${message.type}\n${stderr}`);
  }
  async function userTurn(message) {
    const id = `bootstrap-selection-turn-${Date.now()}-${records.length}`;
    const start = records.length;
    const deadline = Date.now() + 30_000;
    child.stdin.write(`${JSON.stringify({ type: "prompt", id, message })}\n`);
    let index = start;
    let started = false;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          started = record.data?.disposition === "started";
          if (!started) return records.slice(start);
        }
        if (started && record.type === "agent_settled") return records.slice(start);
      }
      assert.ifError(spawnError);
      assert.equal(closeInfo, undefined, `Pi RPC exited before settling: ${message}`);
      await wait(deadline);
    }
    throw new Error(`Pi RPC timed out: ${message}\n${stderr}`);
  }
  async function close() {
    child.stdin.end();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!closeInfo) { child.kill("SIGKILL"); await closed; }
    assert.equal(closeInfo.code, 0, stderr);
    const violations = join(home, "network-violations.log");
    if (existsSync(violations)) assert.equal(readFileSync(violations, "utf8"), "");
  }
  return { request, userTurn, close, get records() { return records; }, get stderr() { return stderr; } };
}

let server;
describe("Auto selection during first-use verification", { timeout: 120_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeServer(); });
  after(() => server?.child.kill());

  it("keeps the first turn usable during a held probe, then transfers the same save to Auto", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-select-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-select-work-"));
    const configPath = join(work, ".pi", "bifrost.json");
    const ownershipPath = join(work, ".pi", "bifrost-reconcile-ownership.json");
    try {
      const heldModel = "auto-selection-held-general";
      await probeGate(server.port, "hold");
      await probeGate(server.port, "hold", "frontier-healthy");
      const before = await stats(server.port);
      const rpc = startRpc({ home, work });
      try {
        await waitFor("the held first-use probe", async () => {
          const current = await stats(server.port);
          return current.stats.find((item) => item.kind === "probe" && item.model === heldModel && !item.completed);
        });
        await rpc.userTurn("synthetic first-use request");
        const firstTurn = await stats(server.port);
        assert.ok(firstTurn.stats.some((item) => item.kind === "generation" && item.completed),
          "the first real Pi turn must finish while the deliberate probe gate remains held");
        assert.ok(firstTurn.stats.some((item) => item.kind === "generation" && item.model === heldModel && item.completed),
          "when every probe is pending, the first turn still uses a provisional model without waiting");
        assert.ok(firstTurn.stats.some((item) => item.kind === "probe" && item.model === heldModel && !item.completed),
          "the first turn must not wait for the held verification request");
        assert.equal(existsSync(configPath), false, "the unresolved probe cannot save a partial pool");
        if (process.env.BIFROST_ACCEPTANCE_EVENTS) {
          appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify({
            event: "first_turn_while_probe_pending",
            provider: "fake",
            model: heldModel,
            generationCompleted: true,
            probePending: true,
            savedConfig: false,
          })}\n`);
        }
        await rpc.request({ type: "set_model", provider: "bifrost", modelId: "auto" });
        assert.equal(existsSync(configPath), false, "partial probe results cannot be saved");
        await probeGate(server.port, "release");
        await probeGate(server.port, "release", "frontier-healthy");
        await waitFor("the verified config and ownership save", () => existsSync(configPath) && existsSync(ownershipPath));

        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        assert.deepEqual(saved.models, {
          quick: [],
          general: [`fake/${heldModel}`],
          frontier: ["fake/frontier-healthy"],
        });
        assert.ok(saved.models[saved.default]?.length > 0, "the saved default must name a nonempty verified pool");
        const probeReport = JSON.parse(readFileSync(join(work, ".pi", "bifrost-probe.json"), "utf8"));
        assert.deepEqual(probeReport.map((result) => result.status), ["ok", "ok"]);
        const afterProbes = await stats(server.port);
        const observedRequests = afterProbes.stats.slice(before.stats.length);
        for (const model of [heldModel, "frontier-healthy"]) {
          const observed = observedRequests.filter((item) => item.model === model && item.kind === "probe").length;
          if (process.env.BIFROST_ACCEPTANCE_EVENTS) {
            appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify({
              event: "request_counts",
              provider: "fake",
              model,
              probe: observed,
              generation: observedRequests.filter((item) => item.model === model && item.kind === "generation").length,
              classifier: observedRequests.filter((item) => item.model === model && item.kind === "classifier").length,
            })}\n`);
          }
          assert.equal(observed, 1,
            `${model} must receive exactly one probe request across the Auto selection`);
        }

        const beforeTurn = afterProbes;
        await rpc.userTurn("frontier say ready");
        const afterTurn = await stats(server.port);
        assert.ok((afterTurn.attempts["frontier-healthy"] ?? 0) > (beforeTurn.attempts["frontier-healthy"] ?? 0),
          "the next Auto input must route through the saved healthy frontier pool");
        await rpc.close();

        const beforeRestart = await stats(server.port);
        const restarted = startRpc({ home, work, model: "bifrost/auto" });
        try {
          await restarted.userTurn("frontier say after restart");
        } finally { await restarted.close(); }
        const afterRestart = await stats(server.port);
        assert.ok(afterRestart.stats.slice(beforeRestart.stats.length).some((item) => item.kind === "generation" && item.model === "frontier-healthy"),
          "a normal prompt after restart must route from the saved verified pool");
        assert.equal(afterRestart.stats.slice(beforeRestart.stats.length).filter((item) => item.kind === "probe").length, 0,
          "a populated saved config must not start first-use verification again");
      } finally { await rpc.close(); }
    } finally {
      await probeGate(server.port, "release");
      await probeGate(server.port, "release", "frontier-healthy");
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }

    const manualHome = mkdtempSync(join(tmpdir(), "bifrost-physical-select-home-"));
    const manualWork = mkdtempSync(join(tmpdir(), "bifrost-physical-select-work-"));
    const manualConfig = join(manualWork, ".pi", "bifrost.json");
    const manualOwnership = join(manualWork, ".pi", "bifrost-reconcile-ownership.json");
    try {
      await probeGate(server.port, "hold");
      const beforeManual = await stats(server.port);
      const rpc = startRpc({ home: manualHome, work: manualWork });
      try {
        await waitFor("the held probe before a physical pin", async () => {
          const current = await stats(server.port);
          return current.stats.find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && !item.completed);
        });
        await rpc.request({ type: "set_model", provider: "fake", modelId: "frontier-healthy" });
        await waitFor("the physical pin to abort its held probe", async () => {
          const current = await stats(server.port);
          return current.stats.slice(beforeManual.stats.length)
            .find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && item.clientClosed);
        });
        await probeGate(server.port, "release");
        await waitFor("the fake provider to release the cancelled probe", async () => {
          const current = await stats(server.port);
          return current.stats.slice(beforeManual.stats.length)
            .find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && item.gateReleased);
        });
        await rpc.userTurn("ordinary say ready");
        assert.equal(existsSync(manualConfig), false, "a physical pin must cancel automatic persistence");
        assert.equal(existsSync(manualOwnership), false, "cancellation must not leave an orphan ownership receipt");
      } finally { await rpc.close(); }
    } finally {
      await probeGate(server.port, "release");
      rmSync(manualHome, { recursive: true, force: true });
      rmSync(manualWork, { recursive: true, force: true });
    }
  });

  it("routes the first prompt to an already verified sibling without replay", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-inaccessible-first-use-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-inaccessible-first-use-work-"));
    const inaccessible = "registered-inaccessible";
    const healthy = "frontier-healthy";
    const models = [
      { id: inaccessible, reasoning: false, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { id: healthy, reasoning: false, cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ];
    const configPath = join(work, ".pi", "bifrost.json");
    try {
      await probeGate(server.port, "hold", inaccessible);
      const before = await stats(server.port);
      const rpc = startRpc({ home, work, model: `fake/${inaccessible}`, models });
      try {
        await waitFor("the selected inaccessible model's pending health probe", async () => {
          const current = await stats(server.port);
          return current.stats.find((item) => item.kind === "probe" && item.model === inaccessible && !item.completed);
        });
        await waitFor("the healthy sibling's successful health probe", async () => {
          const current = await stats(server.port);
          return current.stats.find((item) => item.kind === "probe" && item.model === healthy && item.completed);
        });
        const firstTurn = await rpc.userTurn("synthetic first-use request to unavailable model");
        assert.ok(firstTurn.some((record) => record.type === "message_end" && record.message?.role === "assistant"
          && record.message.stopReason === "stop" && record.message.content?.some((item) => item.type === "text" && item.text?.includes("healthy"))),
        "the first prompt must succeed through the already verified sibling");
        let afterFailure = await stats(server.port);
        const firstTurnRequests = afterFailure.stats.slice(before.stats.length);
        assert.equal(firstTurnRequests.filter((item) => item.kind === "generation" && item.model === inaccessible).length, 0,
          "the unchecked selected model must not receive a generation request");
        assert.equal(firstTurnRequests.filter((item) => item.kind === "generation" && item.model === healthy).length, 1,
          "the original prompt must be dispatched once to the verified sibling");
        assert.ok(firstTurnRequests.some((item) => item.kind === "probe" && item.model === healthy && item.completed),
          "the alternative model was already proven accessible by its health probe");
        assert.ok(firstTurnRequests.some((item) => item.kind === "probe" && item.model === inaccessible && !item.completed),
          "the selected model's verification must remain pending while the first prompt succeeds");

        assert.equal(existsSync(configPath), false, "a pending probe cannot save partial pools");
        await probeGate(server.port, "release", inaccessible);
        await waitFor("the completed first-use health check", () => existsSync(configPath));
        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        assert.deepEqual(saved.models, { quick: [], general: [], frontier: [`fake/${healthy}`] },
          "the completed setup saves only the verified sibling");
        const nextTurn = await rpc.userTurn("synthetic independent request after verification");
        assert.ok(nextTurn.some((record) => record.type === "message_end" && record.message?.role === "assistant"
          && record.message.stopReason === "stop" && record.message.content?.some((item) => item.type === "text" && item.text?.includes("healthy"))),
        "a new, distinct prompt must use the saved healthy model");
        afterFailure = await stats(server.port);
        const allRequests = afterFailure.stats.slice(before.stats.length);
        assert.equal(allRequests.filter((item) => item.kind === "generation" && item.model === inaccessible).length, 0);
        assert.equal(allRequests.filter((item) => item.kind === "generation" && item.model === healthy).length, 2,
          "the first prompt and distinct prompt after verification each generate once");
        if (process.env.BIFROST_ACCEPTANCE_EVENTS) {
          appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify({
            event: "first_turn_verified_sibling",
            selectedModel: healthy,
            assistantStopReason: "stop",
            probeWasPending: true,
            healthySiblingProbePassed: true,
            automaticReplayCount: 0,
            uncheckedModelGenerationCount: allRequests.filter((item) => item.kind === "generation" && item.model === inaccessible).length,
            firstTurnHealthyGenerationCount: 1,
            nextTurnHealthyGenerationCount: 1,
            savedPartialConfig: false,
          })}\n`);
        }
      } finally { await rpc.close(); }
    } finally {
      await probeGate(server.port, "release", inaccessible);
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps routing available and preserves the empty config when first-use probe save fails", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX directory permission failure is not available on Windows");
      return;
    }
    if (process.getuid?.() === 0) {
      t.skip("unsupported: UID 0 can bypass directory permission bits, so this fixture cannot prove a real save failure");
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "bifrost-bootstrap-save-failure-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-bootstrap-save-failure-work-"));
    const piDirectory = join(work, ".pi");
    const configPath = join(piDirectory, "bifrost.json");
    const ownershipPath = join(piDirectory, "bifrost-reconcile-ownership.json");
    const journalPath = join(piDirectory, "bifrost-reconcile.journal");
    const probePath = join(piDirectory, "acceptance-write-permission-check");
    const originalConfigBytes = Buffer.from("{}\n");
    mkdirSync(piDirectory, { recursive: true });
    writeFileSync(configPath, originalConfigBytes);
    const originalDirectoryMode = statSync(piDirectory).mode & 0o777;
    let rpc;
    let readOnlyDenied = false;
    let warningObserved = false;
    let routingAfterSaveFailure = false;
    let beforeStats;
    let afterStats;
    let modeRestored = false;
    let failureBoundary;
    try {
      await probeGate(server.port, "hold");
      beforeStats = await stats(server.port);
      rpc = startRpc({ home, work });
      await waitFor("the held first-use probe before save-failure setup", async () => {
        const current = await stats(server.port);
        return current.stats.find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && !item.completed);
      });
      await rpc.userTurn("synthetic first-use save failure request");
      const whileHeld = await stats(server.port);
      assert.ok(whileHeld.stats.slice(beforeStats.stats.length).some((item) => item.kind === "generation"
        && item.model === "frontier-healthy" && item.completed),
      "the initial physical prompt should complete while verification is held");
      assert.equal(readFileSync(configPath, "utf8"), originalConfigBytes.toString("utf8"));
      assert.equal(existsSync(ownershipPath), false);

      await rpc.request({ type: "set_model", provider: "bifrost", modelId: "auto" });
      chmodSync(piDirectory, 0o500);
      let permissionError;
      try { writeFileSync(probePath, "write must be denied", { flag: "wx" }); }
      catch (error) { permissionError = error; }
      if (!permissionError) {
        rmSync(probePath, { force: true });
        t.skip("unsupported: this filesystem allows writes to a mode-0500 directory for the current user");
        return;
      }
      assert.ok(["EACCES", "EPERM", "EROFS"].includes(permissionError.code),
        `the read-only preflight failed for an unexpected reason: ${permissionError.code}`);
      readOnlyDenied = true;

      await probeGate(server.port, "release");
      const saveWarning = "Bifrost could not safely save the detected pools to project config; routing continues with in-memory pools.";
      await waitFor("the user-visible background-save warning", () => rpc.records.find((record) => record.type === "extension_ui_request"
        && record.method === "notify" && typeof record.message === "string" && record.message.includes(saveWarning)));
      warningObserved = true;
      await waitFor("both background health probes to finish", async () => {
        const current = await stats(server.port);
        const observed = current.stats.slice(beforeStats.stats.length).filter((item) => item.kind === "probe");
        return observed.length === 2 && observed.every((item) => item.completed);
      });

      const failedBoundaryStats = await stats(server.port);
      const failedBoundaryRequests = failedBoundaryStats.stats.slice(beforeStats.stats.length);
      assert.equal(readFileSync(configPath, "utf8"), originalConfigBytes.toString("utf8"), "the existing empty config must not be clobbered at the failed-save boundary");
      assert.equal(existsSync(ownershipPath), false, "a failed save must not create the generated-membership ownership receipt");
      assert.equal(existsSync(journalPath), false, "a failed save must not leave a reconciliation journal");
      for (const model of ["auto-selection-held-general", "frontier-healthy"]) {
        assert.equal(failedBoundaryRequests.filter((item) => item.kind === "probe" && item.model === model).length, 1,
          `${model} must receive exactly one background probe`);
      }
      assert.equal(failedBoundaryRequests.filter((item) => item.kind === "generation").length, 1,
        "only the original physical prompt should have generated at the failed-save boundary");
      failureBoundary = {
        probes: { heldGeneral: 1, frontierHealthy: 1 },
        generations: { heldGeneral: 0, frontierHealthy: 1 },
        preservedEmptyConfig: true,
        configSha256: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
        ownershipReceiptCreated: existsSync(ownershipPath),
        reconciliationJournalCreated: existsSync(journalPath),
      };

      chmodSync(piDirectory, originalDirectoryMode);
      modeRestored = true;
      await rpc.userTurn("frontier say after save failure");
      afterStats = await stats(server.port);
      routingAfterSaveFailure = afterStats.stats.slice(beforeStats.stats.length)
        .some((item) => item.kind === "generation" && item.model === "frontier-healthy" && item.completed);
      assert.equal(routingAfterSaveFailure, true, "the still-valid in-memory policy should route a later Auto prompt after permissions are restored");
      assert.equal(afterStats.stats.slice(beforeStats.stats.length).filter((item) => item.kind === "generation" && item.model === "auto-selection-held-general").length, 0,
        "the unchecked held model must not receive either prompt");
      assert.equal(afterStats.stats.slice(beforeStats.stats.length).filter((item) => item.kind === "generation" && item.model === "frontier-healthy").length, 2,
        "the original and later Auto prompts each generate once on the verified frontier model");

      if (process.env.BIFROST_ACCEPTANCE_EVENTS) {
        appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify({
          event: "bootstrap_save_failure_readonly",
          outcome: "observed",
          warningObserved,
          readOnlyDenied,
          failureBoundary,
          configSha256AfterPermissionRestore: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
          configExistsAfterPermissionRestore: existsSync(configPath),
          routingAfterSaveFailure,
        })}\n`);
      }
    } finally {
      await probeGate(server.port, "release");
      if (!modeRestored) chmodSync(piDirectory, originalDirectoryMode);
      if (rpc) await rpc.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps bootstrap pools stable across registry order, availability, and price metadata", async () => {
    const registry = [
      { id: "candidate-general", reasoning: false, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { id: "missing-price-metadata", reasoning: false },
      { id: "quick-named-expensive-metadata", reasoning: false, cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } },
      { id: "registered-inaccessible", reasoning: false, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
    ];
    const expected = {
      quick: ["fake/missing-price-metadata"],
      general: ["fake/candidate-general"],
      frontier: ["fake/quick-named-expensive-metadata"],
    };
    const observations = [];
    for (const [variant, models] of [["registry-forward", registry], ["registry-reversed", [...registry].reverse()]]) {
      const home = mkdtempSync(join(tmpdir(), `bifrost-${variant}-home-`));
      const work = mkdtempSync(join(tmpdir(), `bifrost-${variant}-work-`));
      const startStats = await stats(server.port);
      const rpc = startRpc({ home, work, model: "bifrost/auto", models });
      try {
        await rpc.userTurn("synthetic candidate order request");
        await waitFor(`${variant} verified bootstrap config`, () => existsSync(join(work, ".pi", "bifrost.json")));
        const saved = JSON.parse(readFileSync(join(work, ".pi", "bifrost.json"), "utf8"));
        assert.deepEqual(saved.models, expected, `${variant}: sorted catalog membership should be independent of registry order`);
        assert.equal(saved.default, "general", `${variant}: default should prefer the general pool when available`);
        assert.ok(saved.models[saved.default].length > 0);
        const report = JSON.parse(readFileSync(join(work, ".pi", "bifrost-probe.json"), "utf8"));
        assert.deepEqual(report.map(({ model, status }) => [model, status]).sort(([left], [right]) => left.localeCompare(right)), [
          ["candidate-general", "ok"],
          ["missing-price-metadata", "ok"],
          ["quick-named-expensive-metadata", "ok"],
          ["registered-inaccessible", "error"],
        ].sort(([left], [right]) => left.localeCompare(right)));
        const afterCold = await stats(server.port);
        const requests = afterCold.stats.slice(startStats.stats.length);
        assert.equal(requests.filter((item) => item.kind === "probe").length, 4,
          `${variant}: probe every registered accessible candidate exactly once, including the rejected one`);
        assert.equal(requests.filter((item) => item.model === "registered-inaccessible" && item.kind === "probe").length, 1);
        const snapshotBytes = readFileSync(join(work, ".pi", "bifrost.json"));
        const event = {
          event: "bootstrap_matrix_cold",
          variant,
          savedModels: saved.models,
          default: saved.default,
          probeCounts: Object.fromEntries([...new Set(requests.filter((item) => item.kind === "probe").map((item) => item.model))]
            .map((model) => [model, requests.filter((item) => item.kind === "probe" && item.model === model).length])),
          savedSha256: await import("node:crypto").then(({ createHash }) => createHash("sha256").update(snapshotBytes).digest("hex")),
          tierBasis: "observed cost metadata only; no model capability is inferred",
        };
        if (process.env.BIFROST_ACCEPTANCE_EVENTS) appendFileSync(process.env.BIFROST_ACCEPTANCE_EVENTS, `${JSON.stringify(event)}\n`);
        await rpc.close();

        const beforeWarm = await stats(server.port);
        const warm = startRpc({ home, work, model: "bifrost/auto", models });
        try { await warm.userTurn("synthetic warm restart request"); }
        finally { await warm.close(); }
        const afterWarm = await stats(server.port);
        const warmRequests = afterWarm.stats.slice(beforeWarm.stats.length);
        assert.deepEqual(warmRequests.filter((item) => item.kind === "probe"), [], `${variant}: a saved pool must not be re-probed on warm restart`);
        assert.deepEqual(readFileSync(join(work, ".pi", "bifrost.json")), snapshotBytes,
          `${variant}: warm restart must preserve the exact saved bytes`);
        assert.ok(warmRequests.some((item) => item.kind === "generation" && item.model === "candidate-general"),
          `${variant}: warm prompt must use the saved general default`);
        observations.push(event);
      } finally {
        await rpc.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
    assert.deepEqual(observations.map(({ savedModels, default: tier }) => ({ savedModels, default: tier })), [
      { savedModels: expected, default: "general" },
      { savedModels: expected, default: "general" },
    ], "cold registry order variants must produce identical saved pools and general-first selection");
  });
});
