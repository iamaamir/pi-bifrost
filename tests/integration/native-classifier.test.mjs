import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-classifier-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return null;
  } catch (error) {
    return error;
  }
}

async function waitForGroupTermination(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error("owned process group did not terminate: " + pid);
}

let cleanupSafeForCaller = true;
function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = childProcess.pid;
    let stdout = "";
    let stderr = "";
    if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
    if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
    if (childProcess.stdout) childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    if (childProcess.stderr) childProcess.stderr.on("data", (chunk) => { stderr += chunk; });

    let closed = false;
    let exitCode = null;
    let exitSignal = null;
    const closePromise = new Promise((resolveClose) => {
      childProcess.once("close", (code, signal) => {
        closed = true;
        exitCode = code;
        exitSignal = signal;
        resolveClose();
      });
    });

    const timeoutMs = options.timeoutMs || 90000;
    let escalationTimer = null;
    let settled = false;

    function succeed() {
      if (settled) return;
      settled = true;
      if (escalationTimer) clearTimeout(escalationTimer);
      try { childProcess.stdout?.destroy(); } catch {}
      try { childProcess.stderr?.destroy(); } catch {}
      try { childProcess.unref(); } catch {}
      cleanupSafeForCaller = true;
      resolve({ status: exitCode, signal: exitSignal, stdout, stderr, closeObserved: closed, groupTerminated: true });
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      if (escalationTimer) clearTimeout(escalationTimer);
      try { childProcess.stdout?.destroy(); } catch {}
      try { childProcess.stderr?.destroy(); } catch {}
      try { childProcess.unref(); } catch {}
      cleanupSafeForCaller = false;
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    childProcess.once("error", (error) => fail(error));

    escalationTimer = setTimeout(async () => {
      const termError = killProcessGroup(pid, "SIGTERM");
      if (termError && termError.code !== "ESRCH") {
        fail(new Error("SIGTERM failed for owned process group " + pid + ": " + termError.message + "\n" + stdout + "\n" + stderr));
        return;
      }
      await delay(2000);
      const killError = killProcessGroup(pid, "SIGKILL");
      if (killError && killError.code !== "ESRCH") {
        fail(new Error("SIGKILL failed for owned process group " + pid + ": " + killError.message + "\n" + stdout + "\n" + stderr));
        return;
      }
      const closedInTime = await Promise.race([
        closePromise.then(() => true),
        delay(2000).then(() => false),
      ]);
      if (!closedInTime) {
        fail(new Error("owned child did not close after escalation\n" + stdout + "\n" + stderr));
        return;
      }
      try {
        await waitForGroupTermination(pid, 1000);
      } catch (error) {
        fail(error);
        return;
      }
      succeed();
    }, timeoutMs);

    closePromise.then(async () => {
      if (settled) return;
      clearTimeout(escalationTimer);
      escalationTimer = null;
      try {
        await waitForGroupTermination(pid, 200);
      } catch {
        const killError = killProcessGroup(pid, "SIGKILL");
        if (killError && killError.code !== "ESRCH") {
          fail(new Error("SIGKILL failed for owned process group " + pid + ": " + killError.message + "\n" + stdout + "\n" + stderr));
          return;
        }
        try {
          await waitForGroupTermination(pid, 1000);
        } catch (error) {
          fail(error);
          return;
        }
      }
      succeed();
    });
  });
}

it("routes real AgentSession through Pi-native classifier behind a proven deny-all fence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-classifier-"));
  const violations = join(scratch, "network-violations.log");
  const server = createServer((_request, response) => response.end("allowed loopback fixture"));
  writeFileSync(violations, "");
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  let cleanupVerified = false;
  let cleanupSafe = true;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const forbiddenPort = port === 65535 ? 65534 : port + 1;
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const isolatedEnv = {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      BIFROST_NATIVE_CLASSIFIER_SCRATCH: scratch,
      NODE_OPTIONS: `--require=${guard}`,
    };
    const childEnv = { ...isolatedEnv };
    delete childEnv.BIFROST_TEST_ALLOWED_ORIGIN;
    childEnv.BIFROST_TEST_DENY_ALL = "1";
    for (const name of credentials) assert.equal(isolatedEnv[name], undefined, `${name} must not enter child env`);

    cleanupSafe = false;
    const probe = await runNode(["-e", `
      const net = require("node:net");
      const tls = require("node:tls");
      const dgram = require("node:dgram");
      (async () => {
        const allowed = await fetch("http://127.0.0.1:${port}");
        if (await allowed.text() !== "allowed loopback fixture") process.exitCode = 8;
        for (const attempt of [
          () => fetch("https://127.0.0.1:${forbiddenPort}"),
          () => fetch("http://127.0.0.1:${forbiddenPort}"),
        ]) { try { await attempt(); } catch {} }
        try {
          const socket = new net.Socket();
          socket.on("error", () => {});
          socket.connect({ port: ${forbiddenPort}, host: "127.0.0.1" });
          socket.destroy();
        } catch {}
        try {
          const tlsSocket = tls.connect({ port: ${forbiddenPort}, host: "127.0.0.1" });
          tlsSocket.on("error", () => {});
          tlsSocket.destroy();
        } catch {}
        try {
          const udp = dgram.createSocket("udp4");
          udp.on("error", () => {});
          udp.send(Buffer.from("fixture"), ${forbiddenPort}, "127.0.0.1", () => { try { udp.close(); } catch {} });
        } catch {}
        if (${JSON.stringify(credentials)}.some((name) => process.env[name] !== undefined)) process.exitCode = 9;
      })();
    `], { cwd: root, env: isolatedEnv });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    cleanupSafe = probe.groupTerminated === true;
    const attempts = readFileSync(violations, "utf8");
    assert.match(attempts, /blocked fetch to https:\/\/127\.0\.0\.1:/);
    assert.match(attempts, /blocked fetch to http:\/\/127\.0\.0\.1:/);
    assert.match(attempts, /blocked socket connection to 127\.0\.0\.1:/);
    assert.match(attempts, /blocked UDP datagram to 127\.0\.0\.1/);

    writeFileSync(violations, "");
    cleanupSafe = false;
    const denyAllProbe = await runNode(["-e", `
      const net = require("node:net");
      const dgram = require("node:dgram");
      (async () => {
        let allowedOriginReached = false;
        try {
          await fetch("http://127.0.0.1:${port}");
          allowedOriginReached = true;
        } catch {}
        try {
          const socket = new net.Socket();
          socket.on("error", () => {});
          socket.connect({ port: ${port}, host: "127.0.0.1" });
          socket.destroy();
        } catch {}
        try {
          const udp = dgram.createSocket("udp4");
          udp.on("error", () => {});
          udp.send(Buffer.from("fixture"), ${port}, "127.0.0.1", () => { try { udp.close(); } catch {} });
        } catch {}
        if (allowedOriginReached) process.exitCode = 10;
      })();
    `], { cwd: root, env: childEnv });
    cleanupSafe = denyAllProbe.groupTerminated === true;
    assert.equal(denyAllProbe.status, 0, `${denyAllProbe.stdout}\n${denyAllProbe.stderr}`);
    const denyAllAttempts = readFileSync(violations, "utf8");
    assert.match(denyAllAttempts, new RegExp(`blocked fetch to http://127\\.0\\.0\\.1:${port}`));
    assert.match(denyAllAttempts, new RegExp(`blocked socket connection to 127\\.0\\.0\\.1:${port}`));
    assert.match(denyAllAttempts, /blocked UDP datagram to 127\.0\.0\.1/);

    let runCounter = 0;
    async function runChild(extraEnv) {
      runCounter += 1;
      const runScratch = join(scratch, `run-${runCounter}`);
      mkdirSync(runScratch, { recursive: true });
      writeFileSync(violations, "");
      cleanupSafe = false;
      const result = await runNode(["--test", "--experimental-strip-types", child], { cwd: root, env: { ...childEnv, BIFROST_NATIVE_CLASSIFIER_SCRATCH: runScratch, ...extraEnv }, timeoutMs: 90000 });
      cleanupSafe = result.groupTerminated === true;
      return result;
    }

    const green = await runChild({});
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "native classifier AgentSession made blocked outbound attempt");

    for (const fault of ["wrong-tier", "disabled", "no-extension"]) {
      const red = await runChild({ BIFROST_NATIVE_CLASSIFIER_FAULT: fault });
      assert.notEqual(red.status, 0, `fault ${fault} must turn the dispatch assertions RED`);
    }

    writeFileSync(violations, "");
    const restored = await runChild({});
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "restored run made blocked outbound attempt");
    cleanupVerified = true;
    void cleanupVerified;
  } catch (error) {
    cleanupSafe = cleanupSafe || cleanupSafeForCaller;
    throw error;
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    if (cleanupSafe) rmSync(scratch, { recursive: true, force: true });
  }
});
