import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createOwnedRunner } from "../fixtures/owned-process.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-classifier-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

const { state: runnerState, runNode } = createOwnedRunner({ defaultTimeoutMs: 90000 });

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
    async function runChild(extraEnv, childPath = child) {
      runCounter += 1;
      const runScratch = join(scratch, `run-${runCounter}`);
      mkdirSync(runScratch, { recursive: true });
      writeFileSync(violations, "");
      cleanupSafe = false;
      const result = await runNode(["--test", "--experimental-strip-types", childPath], { cwd: root, env: { ...childEnv, BIFROST_NATIVE_CLASSIFIER_SCRATCH: runScratch, ...extraEnv }, timeoutMs: 90000 });
      cleanupSafe = result.groupTerminated === true;
      return result;
    }

    const green = await runChild({});
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "native classifier AgentSession made blocked outbound attempt");

    const precedence = await runChild({ BIFROST_NATIVE_CLASSIFIER_SCENARIO: "backend-precedence" });
    assert.equal(precedence.status, 0, `${precedence.stdout}\n${precedence.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "backend precedence scenario made blocked outbound attempt");

    const deadline = await runChild({ BIFROST_NATIVE_CLASSIFIER_SCENARIO: "deadline-late" });
    assert.equal(deadline.status, 0, `${deadline.stdout}\n${deadline.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "deadline scenario made blocked outbound attempt");

    // The only case that observes a command's visible output through a real
    // AgentSession: `preview` is dispatched by Pi, not by a handler mock.
    const preview = await runChild({ BIFROST_NATIVE_CLASSIFIER_SCENARIO: "preview-command" });
    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
    assert.match(preview.stdout, /ℹ pass 1\b/u, "preview command scenario must run its single assertion group");
    assert.match(preview.stdout, /ℹ fail 0\b/u, "preview command scenario must not report a failure");
    assert.equal(readFileSync(violations, "utf8"), "", "preview command scenario made blocked outbound attempt");

    const faultRoot = join(scratch, "late-result-fault-source");
    cpSync(root, faultRoot, { recursive: true, filter: (source) => !source.includes("/.git") && !source.includes("/node_modules") && !source.includes("/coverage") });
    symlinkSync(join(root, "node_modules"), join(faultRoot, "node_modules"));
    const pipelinePath = join(faultRoot, "classification-pipeline.ts");
    const nativePath = join(faultRoot, "classifier-pi-native.ts");
    const originalPipeline = readFileSync(pipelinePath, "utf8");
    const originalNative = readFileSync(nativePath, "utf8");
    const indexPath = join(faultRoot, "index.ts");
    const originalIndex = readFileSync(indexPath, "utf8");
    const faultyPipeline = originalPipeline
      .replace("const abort = () => finish({ status: \"aborted\" });", "const abort = () => {};" )
      .replace("if (classificationOutcome === \"deadline\" || (deadlineAt !== undefined && performance.now() >= deadlineAt)) {", "if (false) {")
      .replace("      }\n      if (signal?.aborted) return stop(\"aborted\");\n    }\n\n    // Existing prompt classifier", "      }\n    }\n\n    // Existing prompt classifier");
    const faultyNative = originalNative
      .replace("result = await abortableResult(options.registry.classify(resolved.model, context, { signal: controller.signal }), controller.signal);", "result = await options.registry.classify(resolved.model, context, { signal: controller.signal });")
      .replace("        if (signal?.aborted) return finish(\"aborted\");\n        if (controller.signal.aborted) {\n          recordFailure(\"timeout\");\n          return finish(\"timeout\");\n        }\n\n        if (result?.stopReason === \"aborted\")", "        if (result?.stopReason === \"aborted\")");
    assert.notEqual(faultyPipeline, originalPipeline, "controlled late-result fault must mutate pipeline deadline guards");
    assert.notEqual(faultyNative, originalNative, "controlled late-result fault must bypass native abort guards");
    writeFileSync(pipelinePath, faultyPipeline);
    writeFileSync(nativePath, faultyNative);
    const lateFault = await runChild({ BIFROST_NATIVE_CLASSIFIER_SCENARIO: "deadline-late" }, join(faultRoot, "tests/fixtures/native-classifier-child.mjs"));
    assert.notEqual(lateFault.status, 0, `late-result mutant must fail Pi dispatch assertions\n${lateFault.stdout}\n${lateFault.stderr}`);
    assert.match(`${lateFault.stdout}\n${lateFault.stderr}`, /deadline fallback dispatches configured default tier/, "mutant must fail intended dispatch assertion, not startup");

    writeFileSync(nativePath, originalNative);
    const nativeMissMutant = originalNative.replace(
      "const judgment = decodePiNativeJudgment(result, request.tiers, 0, resolved.id);",
      "const judgment = undefined;",
    );
    assert.notEqual(nativeMissMutant, originalNative, "precedence mutant must force native classification miss");
    writeFileSync(nativePath, nativeMissMutant);
    const precedenceFault = await runChild(
      { BIFROST_NATIVE_CLASSIFIER_SCENARIO: "backend-precedence-mutant" },
      join(faultRoot, "tests/fixtures/native-classifier-child.mjs"),
    );
    assert.equal(precedenceFault.status, 0, `${precedenceFault.stdout}\n${precedenceFault.stderr}`);
    assert.match(precedenceFault.stdout, /pass 1/, "native-miss mutant must prove prompt-decoy fallback assertions");

    // Both earlier faults are still on disk; a preview fault control must vary
    // exactly one file or it proves nothing.
    writeFileSync(nativePath, originalNative);
    writeFileSync(pipelinePath, originalPipeline);
    const confidenceMutant = originalIndex.replace("        ...(confidence !== undefined ? { confidence } : {}),\n", "");
    assert.notEqual(confidenceMutant, originalIndex, "confidence mutant must remove the propagation line");
    writeFileSync(indexPath, confidenceMutant);
    const previewFault = await runChild(
      { BIFROST_NATIVE_CLASSIFIER_SCENARIO: "preview-command" },
      join(faultRoot, "tests/fixtures/native-classifier-child.mjs"),
    );
    assert.notEqual(previewFault.status, 0, `confidence mutant must fail the preview command assertions\n${previewFault.stdout}\n${previewFault.stderr}`);
    assert.match(
      `${previewFault.stdout}\n${previewFault.stderr}`,
      /exact rejected confidence must survive the real command path/,
      "mutant must fail the intended confidence assertion, not startup",
    );
    writeFileSync(indexPath, originalIndex);

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
    cleanupSafe = cleanupSafe || runnerState.cleanupSafeForCaller;
    throw error;
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    if (cleanupSafe) rmSync(scratch, { recursive: true, force: true });
  }
});
