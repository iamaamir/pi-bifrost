import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { gateDirectory, gitTruth, installedToolVersions, matchNamedTestEvent, parseArgs, sourceFingerprint, summarizeCases } from "../scripts/acceptance/core.mjs";
import { buildGateEvidenceCases, registerTerminationHandlers, runChild, supportingTestCase, terminateProcessGroup, verificationGateEnvironment, writeNodeTestEventsArtifact } from "../scripts/acceptance.mjs";

const temporary = [];
after(() => temporary.forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("acceptance runner boundary", () => {
  it("defaults to deterministic and rejects unknown flags before profile loading", () => {
    assert.equal(parseArgs([]).profile, "deterministic");
    assert.throws(() => parseArgs(["--profil", "live"]), /Unknown acceptance flag/);
  });

  it("rejects unknown CLI flags without starting a profile", () => {
    const script = new URL("../scripts/acceptance.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [script.pathname, "--not-a-real-flag"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown acceptance flag/);
    assert.doesNotMatch(result.stdout, /Acceptance deterministic:/);
  });

  it("runs the real contract CLI to final stable-fingerprint evidence", { timeout: 240_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-acceptance-cli-home-"));
    temporary.push(home);
    const sparseBin = join(home, "bin");
    mkdirSync(sparseBin);
    symlinkSync(process.execPath, join(sparseBin, "node"));
    for (const binary of ["npm", "git", "python3"]) {
      const source = process.env.PATH?.split(delimiter).map((directory) => join(directory, binary)).find(existsSync);
      if (source) symlinkSync(source, join(sparseBin, binary));
    }
    const sparsePath = [join(process.cwd(), "node_modules", ".bin"), sparseBin].join(delimiter);
    const resolvedPi = sparsePath.split(delimiter).map((directory) => join(directory, "pi")).find(existsSync);
    assert.equal(resolvedPi, join(process.cwd(), "node_modules", ".bin", "pi"));
    const script = fileURLToPath(new URL("../scripts/acceptance.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--profile", "contract"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 220_000,
      env: { PATH: sparsePath, HOME: home, CI: "1" },
    });
    const evidenceLine = (result.stdout ?? "").match(/^Evidence: (.+)$/m)?.[1];
    const evidencePath = evidenceLine ? join(process.cwd(), evidenceLine) : undefined;
    let succeeded = false;
    try {
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Acceptance contract: passed/);
      assert.ok(evidencePath, result.stdout);
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      assert.equal(evidence.profile, "contract");
      assert.equal(evidence.exitCode, 0);
      assert.equal(evidence.source.changedDuringRun, false);
      assert.equal(evidence.source.fingerprintAtStart, evidence.source.fingerprintAtEnd);
      assert.equal(evidence.cases.find((item) => item.id === "candidate-stable")?.status, "passed");
      const faultCaseDir = join(dirname(evidencePath), "cases", "native-codex-temperature-fault-red");
      assert.ok(existsSync(join(faultCaseDir, "fault-injected-probe.ts")));
      assert.equal(existsSync(join(faultCaseDir, "fault-fixture")), false);
      succeeded = true;
    } finally {
      if (succeeded && evidencePath) rmSync(join(evidencePath, ".."), { recursive: true, force: true });
    }
  });

  it("resolves a normal child close after checking the detached process group", async () => {
    const result = await runChild(process.execPath, ["-e", "process.stdout.write('complete')"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "complete");
  });

  it("requires explicit bounded live opt-in and exact model allowlists", () => {
    assert.throws(() => parseArgs(["--profile", "live"]), /--allow-live/);
    assert.throws(() => parseArgs(["--profile", "live", "--allow-live"]), /exact --allow-model/);
    assert.throws(() => parseArgs(["--profile", "live", "--allow-live", "--allow-model", "provider"]), /exact --allow-model/);
    assert.throws(() => parseArgs(["--profile", "live", "--allow-live", "--allow-model", "p/m", "--allow-model", "q/n"]), /exactly one/);
    assert.throws(() => parseArgs(["--profile", "live", "--allow-live", "--allow-model", "p/*"]), /exact --allow-model/);
    assert.throws(() => parseArgs(["--profile", "live", "--allow-live", "--allow-model", "p/m", "--max-requests-per-model", "5"]), /may not exceed 4/);
    const parsed = parseArgs(["--profile=live", "--allow-live", "--allow-model", "p/m", "--deadline-seconds=30"]);
    assert.deepEqual(parsed.allowModels, ["p/m"]);
    assert.equal(parsed.deadlineSeconds, 30);
    assert.equal(parsed.maxRequestsPerModel, 4);
  });

  it("fails required blocked or missing cases while allowing optional deferred rows", () => {
    const summary = summarizeCases([
      { status: "passed" },
      { status: "blocked" },
      { status: "blocked", required: false },
      { status: "missing" },
      { status: "deferred", required: false },
    ]);
    assert.deepEqual(summary, { required: 3, passed: 1, failed: 0, blocked: 2, missing: 1, deferred: 1, exitCode: 1 });
    assert.equal(summarizeCases([{ status: "passed" }, { status: "deferred", required: false }]).exitCode, 0);
  });

  it("records installed package versions separately from declared ranges", () => {
    const versions = installedToolVersions(new URL("..", import.meta.url).pathname);
    const installedTypeScript = JSON.parse(readFileSync(new URL("../node_modules/typescript/package.json", import.meta.url), "utf8")).version;
    const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).devDependencies;
    assert.equal(versions.installed.typescript, installedTypeScript);
    assert.equal(versions.declared.typescript, declared.typescript);
    assert.match(versions.installed.agentTui, /\d+\.\d+\.\d+/);
    assert.equal(versions.installed.agentTuiNative.package, `agent-tui-${process.platform}-${process.arch}`);
    assert.equal(versions.installed.agentTuiNative.platformArch, `${process.platform}-${process.arch}`);
    assert.match(versions.installed.agentTuiNative.executableVersion, /^agent-tui \d+\.\d+\.\d+$/);
    assert.equal(versions.installed.agentTuiNative.executableVersion, `agent-tui ${versions.installed.agentTuiNative.version}`);
    assert.match(versions.installed.agentTuiNative.binarySha256, /^[a-f0-9]{64}$/);
    assert.equal(versions.declared.agentTui, declared["agent-tui"]);
    assert.notEqual(versions.installed.agentTui, versions.declared.agentTui);
  });

  it("builds a sanitized, isolated gate environment with the loopback network fence", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-secret-fixture";
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-env-"));
    temporary.push(directory);
    try {
      const { env, violationPath } = verificationGateEnvironment({ root: process.cwd(), artifactDir: directory, script: "test:integration" });
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.HOME, join(directory, "gates", "test-integration", "home"));
      assert.equal(env.PI_CODING_AGENT_DIR, join(env.HOME, ".pi", "agent"));
      assert.equal(env.PATH.split(delimiter)[0], join(process.cwd(), "node_modules", ".bin"));
      assert.equal(env.BIFROST_TEST_ALLOW_LOOPBACK, "1");
      assert.equal(env.BIFROST_TEST_NETWORK_VIOLATIONS, violationPath);
      assert.equal(env.NODE_OPTIONS, `--require=${join(process.cwd(), "scripts", "test-outbound-guard.cjs")}`);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("allows only loopback requests and records an attempted external request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-fence-"));
    temporary.push(directory);
    const server = createServer((_request, response) => { response.end("ok"); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const violationPath = join(directory, "violations.log");
    const guardPath = fileURLToPath(new URL("../scripts/test-outbound-guard.cjs", import.meta.url));
    const script = `import dgram from 'node:dgram';const response=await fetch('http://127.0.0.1:${port}');if(!response.ok)process.exit(2);try{await fetch('https://example.invalid')}catch{};const udp=dgram.createSocket('udp4');try{udp.send(Buffer.from('fixture'),53,'8.8.8.8',()=>{})}catch{}`;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script], { env: {
          PATH: process.env.PATH,
          HOME: directory,
          BIFROST_TEST_ALLOW_LOOPBACK: "1",
          BIFROST_TEST_NETWORK_VIOLATIONS: violationPath,
          NODE_OPTIONS: `--require=${guardPath}`,
        }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
      });
      assert.equal(result.status, 0, result.stderr);
      const violations = readFileSync(violationPath, "utf8");
      assert.match(violations, /blocked fetch to https:\/\/example\.invalid/);
      assert.match(violations, /blocked UDP datagram to 8\.8\.8\.8/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("blocks when an expected exact Node test event has no matching completed test", () => {
    const events = [
      { file: "/repo/tests/routing.test.ts", name: "defaults to first", passed: true },
      { file: "/repo/tests/routing.test.ts", name: "file:///repo/tests/routing.test.ts", passed: true },
    ];
    assert.equal(matchNamedTestEvent(events, { file: "tests/routing.test.ts", name: "defaults to random" }), undefined);
    assert.equal(matchNamedTestEvent(events, { file: "tests/routing.test.ts", name: "defaults to first" }).passed, true);
  });

  it("rejects ambiguous duplicate exact test events instead of accepting the first pass", () => {
    const events = [
      { file: "/repo/tests/routing.test.ts", name: "defaults to first", passed: true },
      { file: "/repo/tests/routing.test.ts", name: "defaults to first", passed: false, skipped: true },
    ];
    assert.equal(matchNamedTestEvent(events, { file: "tests/routing.test.ts", name: "defaults to first" }), undefined);
  });

  it("reports real Node skip and TODO results as non-passing required events", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-reporter-"));
    temporary.push(directory);
    const testFile = join(directory, "skipped.test.mjs");
    writeFileSync(testFile, "import { it } from 'node:test';\nit.skip('required skipped case', () => {});\nit.todo('required todo case', () => {});\n");
    const reporterPath = fileURLToPath(new URL("../scripts/acceptance/test-event-reporter.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporterPath}`, testFile], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmpdir() },
    });
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const skipped = events.find((event) => event.name === "required skipped case");
    const todo = events.find((event) => event.name === "required todo case");
    assert.deepEqual({ passed: skipped.passed, skipped: skipped.skipped, todo: skipped.todo }, { passed: false, skipped: true, todo: false });
    assert.deepEqual({ passed: todo.passed, skipped: todo.skipped, todo: todo.todo }, { passed: false, skipped: false, todo: true });
  });

  it("keeps bounded actionable failure diagnostics while redacting secrets in real Node events", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-reporter-failure-"));
    temporary.push(directory);
    const testFile = join(directory, "failure.test.mjs");
    writeFileSync(testFile, `import { it } from 'node:test';\nit('synthetic routed failure', () => { const cause = new Error('upstream returned 429\\nAuthorization: Bearer sk-live-sentinel-123456789\\nCookie: sid=sentinel-cookie\\nJWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW50aW5lbCJ9.signature'); cause.code = 'E_SYNTHETIC_UPSTREAM'; const error = new Error('fallback route was not attempted'); error.cause = cause; throw error; });\n`);
    const reporterPath = fileURLToPath(new URL("../scripts/acceptance/test-event-reporter.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporterPath}`, testFile], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmpdir() },
    });
    assert.equal(result.status, 1, result.stderr);
    const events = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    const failure = events.find((event) => event.name === "synthetic routed failure");
    assert.equal(failure.passed, false);
    assert.match(failure.failure.message, /fallback route was not attempted/);
    assert.equal(failure.failure.cause.cause.code, "E_SYNTHETIC_UPSTREAM");
    assert.match(failure.failure.cause.cause.message, /upstream returned 429/);
    const serialized = JSON.stringify(failure.failure);
    assert.doesNotMatch(serialized, /sk-live-sentinel-123456789|sentinel-cookie|eyJhbGciOiJIUzI1NiJ9/);
    assert.ok(serialized.length < 20_000, "diagnostic fields should remain bounded");
    assert.equal(Object.hasOwn(failure.failure.cause.cause, "actual"), false);
    assert.equal(Object.hasOwn(failure.failure.cause.cause, "expected"), false);

    const evidencePath = writeNodeTestEventsArtifact({ root: directory, artifactDir: join(directory, "evidence"), testEvents: events });
    const evidenceText = readFileSync(evidencePath, "utf8");
    assert.doesNotMatch(evidenceText, /sk-live-sentinel-123456789|sentinel-cookie|eyJhbGciOiJIUzI1NiJ9/);
    assert.match(evidenceText, /fallback route was not attempted/);
  });

  it("assembles release gate evidence including its recorded network guard artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-gate-evidence-"));
    temporary.push(directory);
    const artifactDir = join(directory, "acceptance");
    const gateLog = join(directory, "verify.log");
    writeFileSync(gateLog, "gate completed\n");
    const networkLog = join(gateDirectory(artifactDir, "test:integration"), "network-violations.log");
    mkdirSync(join(networkLog, ".."), { recursive: true });
    writeFileSync(networkLog, "");
    const cases = buildGateEvidenceCases({
      verification: { gates: [{ id: "integration", script: "test:integration", exitCode: 0, logPath: "verify.log", startedAt: "start", endedAt: "end" }] },
      root: directory,
      artifactDir,
    });
    assert.deepEqual(cases[0].artifacts, ["acceptance/gates/integration.log", "acceptance/gates/test-integration/network-violations.log"]);
  });

  it("checks required case artifacts and blocks when the real artifact is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-artifact-"));
    temporary.push(directory);
    const target = {
      id: "artifact-case",
      requirement: "R01",
      file: "tests/example.test.mjs",
      name: "writes structured artifact",
      boundary: "fixture test boundary",
      caseArtifact: "cases/artifact-case/result.json",
    };
    const artifactDir = join(directory, "run");
    const artifact = join(artifactDir, target.caseArtifact);
    mkdirSync(join(artifactDir, "cases", "artifact-case"), { recursive: true });
    writeFileSync(artifact, "{}\n");
    const input = {
      target,
      testEvents: [{ file: "/repo/tests/example.test.mjs", name: target.name, passed: true }],
      artifactDir,
      root: directory,
      eventPath: "events.jsonl",
    };
    assert.equal(supportingTestCase(input).status, "passed");
    rmSync(artifact);
    assert.equal(supportingTestCase(input).status, "blocked");
  });

  it("bounds captured output while preserving every structured reporter event", async () => {
    const events = [];
    const output = await runChild(process.execPath, ["-e", "for (let id = 1; id <= 3; id++) process.stdout.write(JSON.stringify({ id, payload: 'x'.repeat(4096) }) + '\\n')"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      captureLimit: 128,
      onStdoutLine: (line) => events.push(JSON.parse(line)),
    });
    assert.equal(output.status, 0);
    assert.equal(output.outputTruncated, true);
    assert.match(output.stdout, /stream output truncated/);
    assert.deepEqual(events.map(({ id }) => id), [1, 2, 3]);
  });

  it("fails if a JSON reporter record exceeds its line bound", async () => {
    const output = await runChild(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ payload: 'x'.repeat(1100000) }) + '\\n')"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      captureLimit: 128,
      onStdoutLine: () => assert.fail("oversized structured events must not be parsed"),
    });
    assert.equal(output.status, 1);
    assert.equal(output.reporterLineTooLarge, true);
    assert.equal(output.outputTruncated, true);
  });

  it("fails explicitly when structured reporter events exceed the total capture budget", async () => {
    const events = [];
    const output = await runChild(process.execPath, ["-e", "for (let id = 1; id <= 3; id++) process.stdout.write(JSON.stringify({ id }) + '\\n')"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      onStdoutLine: (line) => events.push(JSON.parse(line)),
      reporterMaxEvents: 2,
    });
    assert.equal(output.status, 1);
    assert.equal(output.reporterEventOverflowed, true);
    assert.deepEqual(events.map(({ id }) => id), [1, 2]);
  });

  it("terminates and awaits an active detached gate process group on SIGTERM", () => {
    const acceptanceUrl = new URL("../scripts/acceptance.mjs", import.meta.url).href;
    const script = `const {registerTerminationHandlers,runChild}=await import(${JSON.stringify(acceptanceUrl)});const remove=registerTerminationHandlers();setTimeout(()=>process.kill(process.pid,'SIGTERM'),100);const result=await runChild(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:{PATH:process.env.PATH}});const signal=remove();const next=await runChild(process.execPath,['-e',\"process.stdout.write('unexpected launch')\"],{cwd:process.cwd(),env:{PATH:process.env.PATH}});process.stdout.write(JSON.stringify({status:result.status,signal,nextStatus:next.status,nextStdout:next.stdout}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 143, signal: "SIGTERM", nextStatus: 143, nextStdout: "" });
  });

  it("kills and awaits a SIGTERM-ignoring grandchild after its gate parent exits", () => {
    const acceptanceUrl = new URL("../scripts/acceptance.mjs", import.meta.url).href;
    const directory = mkdtempSync(join(tmpdir(), "bifrost-grandchild-cleanup-"));
    temporary.push(directory);
    const heartbeat = join(directory, "heartbeat");
    const grandchildCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(heartbeat)},'ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),10);`;
    const childCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'ignore'});process.stdout.write(String(process.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const script = `const fs=await import('node:fs');const {registerTerminationHandlers,runChild,processGroupExists}=await import(${JSON.stringify(acceptanceUrl)});const remove=registerTerminationHandlers();let ready=false;const deadline=Date.now()+5000;const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(heartbeat)})){ready=true;clearInterval(poll);process.kill(process.pid,'SIGTERM')}else if(Date.now()>deadline){clearInterval(poll);process.kill(process.pid,'SIGTERM')}},10);const result=await runChild(process.execPath,['-e',${JSON.stringify(childCode)}],{cwd:process.cwd(),env:{PATH:process.env.PATH}});clearInterval(poll);const signal=remove();const before=ready?fs.readFileSync(${JSON.stringify(heartbeat)},'utf8'):'';await new Promise(resolve=>setTimeout(resolve,150));const after=ready?fs.readFileSync(${JSON.stringify(heartbeat)},'utf8'):'';const groupId=Number(result.stdout);process.stdout.write(JSON.stringify({status:result.status,signal,ready,stopped:before===after,groupGone:groupId>0&&!processGroupExists(groupId),cleanupFailed:result.processCleanupFailed}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 143, signal: "SIGTERM", ready: true, stopped: true, groupGone: true, cleanupFailed: false });
  });

  it("reports process-group cleanup failure after its bounded deadline", async () => {
    const signals = [];
    const clean = await terminateProcessGroup({ pid: 123 }, {
      graceMs: 0,
      cleanupTimeoutMs: 1,
      groupExists: () => true,
      signalGroup: (_groupId, signal) => signals.push(signal),
      wait: async () => {},
    });
    assert.equal(clean, false);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });

  it("fingerprints tracked source bytes and retains dirty Git paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-runner-"));
    temporary.push(directory);
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(join(directory, "source.txt"), "before");
    execFileSync("git", ["add", "source.txt"], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Acceptance Test", "-c", "user.email=acceptance@example.invalid", "commit", "-qm", "fixture"], { cwd: directory });
    const before = sourceFingerprint(directory);
    writeFileSync(join(directory, "source.txt"), "after");
    writeFileSync(join(directory, "fresh.txt"), "new");
    assert.notEqual(sourceFingerprint(directory), before);
    const dirty = gitTruth(directory).sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(dirty, [
      { index: "??", path: "fresh.txt" },
      { index: " M", path: "source.txt" },
    ]);
  });
});
