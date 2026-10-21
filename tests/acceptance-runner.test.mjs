import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { gateDirectory, gitTruth, installedToolVersions, matchNamedTestEvent, parseArgs, sourceFingerprint, summarizeCases } from "../scripts/acceptance/core.mjs";
import { buildGateEvidenceCases, manifestEvidenceGate, registerTerminationHandlers, runChild, supportingTestCase, terminateProcessGroup, verificationGateEnvironment, writeNodeTestEventsArtifact } from "../scripts/acceptance.mjs";

const temporary = [];
after(() => temporary.forEach((path) => rmSync(path, { recursive: true, force: true })));

// ── acceptance-artifact privacy projection ──────────────────────
//
// The real acceptance artifact boundary is the Node test event reporter +
// writeNodeTestEventsArtifact: the reporter projects each Node test event onto a
// declared, structural field set, and the artifact writer serializes the same
// projection to `gates/node-test-events.jsonl`. That projection is deliberately
// NOT a content-free redaction layer:
//   * `name`, `file`, and `line` are intentional SOURCE fields (which test ran),
//   * `failure.code/failureType/message/stack/cause` are intentional bounded
//     DIAGNOSTIC fields, sanitized only for secret-shaped tokens.
// This suite therefore asserts the scoped structural allowlist plus an
// off-channel canary exclusion. It does not assert the artifact is content-free,
// which would invent a policy this boundary does not have.
const PROJECTED_TEST_EVENT_KEYS = new Set(["type", "name", "file", "line", "passed", "skipped", "todo", "durationMs", "failure"]);
const PROJECTED_FAILURE_KEYS = new Set(["code", "failureType", "message", "stack", "cause"]);
const OFFCHANNEL_CANARY = "CANARY_OFFCHANNEL_diagnostic_9a4f";
const DIAGNOSTIC_CANARY = "CANARY_DIAGNOSTIC_2c7b";
const SECRET_CANARY = "sk-CANARY_ACCEPTANCE_7d1e";
const OVERSIZE_TAIL_SENTINEL = "TAIL_SENTINEL_NEVER_PROJECTED_6f2a";

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Scoped structural allowlist for one projected Node test event. The exact key
 * set is asserted (an undeclared field fails) and the failure cause chain must
 * stay inside the declared diagnostic keys and bounded depth; nothing here
 * asserts the *values* are privacy-free, because source/diagnostic values are
 * intentionally carried.
 */
function assertProjectedTestEvent(event, label) {
  for (const key of Object.keys(event)) {
    assert.equal(PROJECTED_TEST_EVENT_KEYS.has(key), true, `${label}: key outside the declared acceptance projection: ${key}`);
  }
  assert.equal(event.type, "test:complete", `${label}: must be a terminal test event`);
  assert.equal(typeof event.name, "string", `${label}: must carry the source test name`);
  assert.equal(typeof event.file, "string", `${label}: must carry the source file`);
  assert.equal(typeof event.passed, "boolean", `${label}: must carry the pass/fail result`);
  let depth = 0;
  for (let failure = event.failure; failure !== undefined; failure = failure.cause) {
    assert.ok(depth <= 2, `${label}: failure cause depth must stay bounded`);
    for (const key of Object.keys(failure)) {
      assert.equal(PROJECTED_FAILURE_KEYS.has(key), true, `${label}: failure key outside the declared acceptance projection: ${key}`);
    }
    depth += 1;
  }
}

/** Run a real node:test process through a real reporter and parse its JSONL. */
function runRealReporter({ reporterPath, testFile }) {
  const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporterPath}`, testFile], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tmpdir() },
  });
  const events = (result.stdout ?? "").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  return { status: result.status, stderr: result.stderr ?? "", events };
}

/** Write the same real fixture used by both the contract and its fault control. */
function writeProjectionFixture(directory) {
  const testFile = join(directory, "projection.test.mjs");
  writeFileSync(testFile, [
    'import { it } from "node:test";',
    'it("drops an off-channel diagnostic canary", (t) => {',
    `  t.diagnostic("${OFFCHANNEL_CANARY} must never reach the projection");`,
    "});",
    'it("carries a bounded diagnostic failure", () => {',
    `  const cause = new Error(\`route failed for ${DIAGNOSTIC_CANARY}\`);`,
    '  cause.code = "E_SYNTHETIC_CAUSE";',
    `  const error = new Error(\`upstream rejected \${"${SECRET_CANARY}"}\`);`,
    '  error.code = "E_SYNTHETIC_ROUTE";',
    "  error.cause = cause;",
    "  throw error;",
    "});",
    'it("bounds an oversized diagnostic message", () => {',
    `  throw new Error("A".repeat(8192) + "${OVERSIZE_TAIL_SENTINEL}");`,
    "});",
  ].join("\n") + "\n");
  return testFile;
}

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
      const { env, violationPath } = verificationGateEnvironment({ root: process.cwd(), artifactDir: directory, script: "test:integration", sourceEnv: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: "/fixture/push.json", GITHUB_TOKEN: "ambient-token-fixture" } });
      assert.equal(env.GITHUB_EVENT_NAME, "push");
      assert.equal(env.GITHUB_EVENT_PATH, "/fixture/push.json");
      assert.equal(env.GITHUB_TOKEN, undefined);
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
    assert.equal(matchNamedTestEvent(events, { file: "tests/routing.test.ts", name: "defaults to random" }, "/repo"), undefined);
    assert.equal(matchNamedTestEvent(events, { file: "tests/routing.test.ts", name: "defaults to first" }, "/repo").passed, true);
  });

  for (const ambiguous of [false, true]) {
    it(`blocks ${ambiguous ? "ambiguous" : "missing"} required results at the acceptance report boundary`, () => {
      const target = { id: "support:required-report", requirement: "R16", file: "tests/required-report.test.mjs", name: "required witness", boundary: "required acceptance report" };
      const event = { type: "test:complete", file: join(process.cwd(), target.file), name: target.name, passed: true };
      const result = supportingTestCase({ target, testEvents: ambiguous ? [event, event] : [], artifactDir: tmpdir(), root: process.cwd(), eventPath: "events.jsonl" });
      assert.equal(result.status, "blocked", `${ambiguous ? "ambiguous" : "missing"} required result must block the report case`);
      assert.equal(result.id, target.id);
      assert.equal(result.required, true);
      assert.equal(result.detail, `The pinned test runner did not emit the exact required test result: ${target.file} — ${target.name}`);
    });
  }

  for (const fault of [
    { label: "missing-result", anchor: '!result ? "blocked"', replacement: '!result ? "passed"' },
    { label: "missing-artifact", anchor: '!hasCaseArtifact ? "blocked"', replacement: '!hasCaseArtifact ? "passed"' },
  ]) {
    it(`fault control: the ${fault.label} guard is required by the acceptance report`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-report-guard-"));
      const sourceUrl = new URL("../scripts/acceptance.mjs", import.meta.url);
      const source = readFileSync(sourceUrl, "utf8");
      const copy = source.replace(/from "(\.\/[^"]+)"/gu, (_, specifier) => `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`);
      assert.equal(copy.split(fault.anchor).length, 2, "report guard fault anchor must be unique");
      const file = join(directory, "acceptance.mjs");
      const target = { id: "support:required-report", requirement: "R16", file: "tests/required-report.test.mjs", name: "required witness", boundary: "required acceptance report", ...(fault.label === "missing-artifact" ? { caseArtifact: "absent.json" } : {}) };
      const testEvents = fault.label === "missing-artifact" ? [{ type: "test:complete", file: join(process.cwd(), target.file), name: target.name, passed: true }] : [];
      const requireBlocked = (consumer) => assert.equal(consumer({ target, testEvents, artifactDir: directory, root: process.cwd(), eventPath: "events.jsonl" }).status, "blocked", `a ${fault.label} report case must stay blocked`);
      try {
        writeFileSync(file, copy);
        requireBlocked((await import(pathToFileURL(file).href)).supportingTestCase);
        writeFileSync(file, copy.replace(fault.anchor, fault.replacement));
        const mutant = await import(pathToFileURL(file).href + "?fault");
        assert.throws(() => requireBlocked(mutant.supportingTestCase), { code: "ERR_ASSERTION", message: new RegExp(`a ${fault.label} report case must stay blocked`) });
        writeFileSync(file, copy);
        requireBlocked((await import(pathToFileURL(file).href + "?restored")).supportingTestCase);
        assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), createHash("sha256").update(copy).digest("hex"), "report source copy must be restored byte-for-byte");
        assert.equal(readFileSync(sourceUrl, "utf8"), source, "submitted report source must remain untouched");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("rejects ambiguous duplicate exact test events instead of accepting the first pass", () => {
    const events = [
      { file: "/repo/tests/routing.test.ts", name: "defaults to first", passed: true },
      { file: "/repo/tests/routing.test.ts", name: "defaults to first", passed: false, skipped: true },
    ];
    assert.equal(matchNamedTestEvent(events, { file: "tests/routing.test.ts", name: "defaults to first" }, "/repo"), undefined);
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
    for (const event of [skipped, todo]) {
      assert.equal(typeof event.file, "string", "the real reporter must identify its skipped/TODO witness");
      const result = supportingTestCase({ target: { id: "support:nonpassing", requirement: "R16", file: event.file, name: event.name, boundary: "real reporter result" }, testEvents: events, artifactDir: directory, root: directory, eventPath: "events.jsonl" });
      assert.equal(result.status, "failed", "real skip/TODO events must fail the required report case");
    }
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
      testEvents: [{ file: join(directory, "tests/example.test.mjs"), name: target.name, passed: true }],
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

  it("projects real Node test events into a declared allowlist without leaking off-channel diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-projection-"));
    temporary.push(directory);
    const reporterPath = fileURLToPath(new URL("../scripts/acceptance/test-event-reporter.mjs", import.meta.url));
    const testFile = writeProjectionFixture(directory);

    const { status, events } = runRealReporter({ reporterPath, testFile });
    assert.equal(status, 1, "the fixture intentionally fails; the reporter still projects every event");

    // Scoped structural allowlist over the projection that was actually generated.
    for (const event of events) assertProjectedTestEvent(event, "projected event");

    // Nonempty witnesses: a pass, a diagnostic failure, and a bounded failure.
    const passed = events.find((event) => event.name === "drops an off-channel diagnostic canary");
    const failed = events.find((event) => event.name === "carries a bounded diagnostic failure");
    const oversized = events.find((event) => event.name === "bounds an oversized diagnostic message");
    assert.equal(passed?.passed, true, "the passing fixture test must project as passed");
    assert.equal(failed?.passed, false, "the failing fixture test must project as failed");
    assert.ok(failed?.failure, "a failing event must carry its bounded diagnostic");
    assert.ok(oversized?.failure, "the oversized fixture test must project as failed");

    // Source fields are intentional and carried verbatim (node:test reports the
    // canonical realpath, so compare the resolved source identity).
    assert.equal(realpathSync(failed.file), realpathSync(testFile), "projected file must be the real source file");
    assert.equal(realpathSync(passed.file), realpathSync(testFile), "projected file must be the real source file");

    // Off-channel diagnostics never reach the projection; the declared diagnostic
    // channel does, and secret-shaped tokens are redacted by the real bounded
    // policy. Off-channel is what a leak would look like; the diagnostic channel
    // is explicitly outside the privacy projection.
    const artifactText = events.map((event) => JSON.stringify(event)).join("\n");
    assert.equal(artifactText.includes(OFFCHANNEL_CANARY), false, "an off-channel t.diagnostic canary must never be projected");
    assert.equal(artifactText.includes(DIAGNOSTIC_CANARY), true, "the declared diagnostic channel is intentionally outside the privacy projection");
    assert.equal(artifactText.includes(SECRET_CANARY), false, "secret-shaped tokens must be redacted inside the diagnostic channel");
    assert.equal(artifactText.includes(OVERSIZE_TAIL_SENTINEL), false, "an oversized diagnostic must be truncated before its tail");
    assert.ok(failed.failure.message.length < 4096, "diagnostic messages must stay bounded");

    // The real artifact writer preserves the same projection on disk.
    const evidencePath = writeNodeTestEventsArtifact({ root: directory, artifactDir: join(directory, "evidence"), testEvents: events });
    const fileText = readFileSync(evidencePath, "utf8");
    const fileEvents = fileText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(fileEvents.length, events.length, "the artifact must serialize every projected event");
    for (const event of fileEvents) assertProjectedTestEvent(event, "written artifact event");
    assert.equal(fileText.includes(OFFCHANNEL_CANARY), false, "the written artifact must not carry an off-channel canary");
    assert.equal(fileText.includes(SECRET_CANARY), false, "the written artifact must not carry a secret-shaped token");
  });

  it("fault control: an undeclared acceptance projection key turns the named allowlist assertion RED", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-acceptance-projection-fault-"));
    temporary.push(directory);
    const reporterPath = fileURLToPath(new URL("../scripts/acceptance/test-event-reporter.mjs", import.meta.url));
    const original = readFileSync(reporterPath, "utf8");
    const originalHash = sha256Text(original);
    const testFile = writeProjectionFixture(directory);

    // Pristine GREEN: the real reporter stays inside the declared projection.
    for (const event of runRealReporter({ reporterPath, testFile }).events) {
      assertProjectedTestEvent(event, "pristine projection");
    }

    const anchor = "      this.push(JSON.stringify({";
    assert.ok(original.includes(anchor), "reporter projection anchor must exist");
    const mutated = original.replace(anchor, "      this.push(JSON.stringify({\n        leakedOffChannel: data?.name,");
    assert.notEqual(mutated, original, "reporter mutation must apply");
    assert.notEqual(sha256Text(mutated), originalHash, "mutation must be a real source change");
    const mutatedPath = join(directory, "mutated-reporter.mjs");
    writeFileSync(mutatedPath, mutated);

    // RED: a private mutated reporter copy must fail the named allowlist assertion.
    let redError;
    try {
      for (const event of runRealReporter({ reporterPath: mutatedPath, testFile }).events) {
        assertProjectedTestEvent(event, "mutated projection");
      }
    } catch (error) {
      redError = error;
    }
    assert.ok(redError, "an undeclared projection key must fail the allowlist assertion");
    assert.equal(redError.name, "AssertionError", "the mutation must fail by assertion, not by a spawn or parse error");
    assert.match(String(redError.message), /key outside the declared acceptance projection/u, "the mutation must fail the named projection assertion");
    assert.equal(sha256Text(readFileSync(mutatedPath, "utf8")), sha256Text(mutated), "the mutated copy must stay mutated");

    // Restore: the shared committed reporter is untouched and GREEN again.
    assert.equal(sha256Text(readFileSync(reporterPath, "utf8")), originalHash, "the shared reporter must be unchanged after the proof");
    for (const event of runRealReporter({ reporterPath, testFile }).events) {
      assertProjectedTestEvent(event, "restored projection");
    }
  });

  // Hosted runner performance varies widely between moments (the same green
  // caller run measured 58s, 92s, and over 110s across consecutive CI runs).
  // Phase caps are ceilings, so they carry ~2.5x headroom over the slowest
  // observed run instead of tracking the fast-runner case; the deadline stays
  // well above a slow but healthy proof and below the outer test timeout.
  const CALLER_PHASE_BUDGET_MS = 300_000;
  const CALLER_PROOF_DEADLINE_MS = 660_000;
  async function exerciseWorkflowCaller({ t, topology }) {
    const root = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "bifrost-merged-push-caller-"));
    let completed = false;
    let cleanupVerified = true;
    const deadline = Date.now() + CALLER_PROOF_DEADLINE_MS;
    try {
    const checkout = join(directory, "checkout");
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, checkout]);
    const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    git("checkout", "--quiet", "--detach", head);
    // Include the current worktree's fixes while keeping all mutations private.
    for (const file of ["scripts/merge-controller.mjs", "scripts/acceptance.mjs", "scripts/acceptance/core.mjs", "tests/integration/fake-provider-ownership.test.mjs", "tests/merge-controller.test.mjs", "tests/acceptance-runner.test.mjs", "change-evidence.json"]) {
      cpSync(join(root, file), join(checkout, file));
    }
    symlinkSync(realpathSync(join(root, "node_modules")), join(checkout, "node_modules"), "dir");
    const predecessor = JSON.parse(readFileSync(join(checkout, "change-evidence.json"), "utf8")).base;
    git("add", "--", "scripts/merge-controller.mjs", "scripts/acceptance.mjs", "scripts/acceptance/core.mjs", "tests/integration/fake-provider-ownership.test.mjs", "tests/merge-controller.test.mjs", "tests/acceptance-runner.test.mjs", "change-evidence.json");
    const merged = execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", git("write-tree"), "-p", predecessor, ...(topology === "multi" ? ["-p", head] : [])], {
      cwd: checkout, input: "synthetic merged push\n", encoding: "utf8",
    }).trim();
    git("checkout", "--quiet", "--detach", merged);
    git("update-ref", "refs/remotes/origin/v2", merged);
    assert.equal(git("merge-base", "origin/v2", "HEAD"), merged);
    assert.notEqual(merged, predecessor, "the current delivery tip is not the historic push predecessor");
    const ancestry = git("rev-list", "--ancestry-path", `${predecessor}..${merged}`).split("\n");
    if (topology === "multi") {
      assert.ok(head !== predecessor && ancestry.includes(head), "the owned merged-push fixture must exercise a real intermediate commit");
    } else {
      assert.deepEqual(ancestry, [merged], "the owned single-commit fixture must not contain an intermediate commit");
    }
    const eventPath = join(directory, "push.json");
    writeFileSync(eventPath, JSON.stringify({ before: predecessor, after: merged, ref: "refs/heads/v2" }));
    const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath };
    delete env.NODE_TEST_CONTEXT;
    const launcher = join(directory, "gate-launcher.mjs");
    writeFileSync(launcher, [
      'import { spawnSync } from "node:child_process";',
      `import { verificationGateEnvironment } from ${JSON.stringify(pathToFileURL(join(checkout, "scripts/acceptance/core.mjs")).href)};`,
      `const { env } = verificationGateEnvironment({ root: ${JSON.stringify(checkout)}, artifactDir: ${JSON.stringify(join(directory, "gate-artifacts"))}, script: "test" });`,
      'const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=workflow acceptance CLI records actual-predecessor change evidence with bounded gates", "tests/acceptance-runner.test.mjs"], { env, stdio: "inherit", timeout: ' + JSON.stringify(CALLER_PHASE_BUDGET_MS) + ' });',
      'process.exit(result.status ?? 1);',
    ].join("\n"));
    // The submitted gate environment, not a direct synthetic child environment,
    // must carry the push payload into the real unit caller.
    const runCallerTest = async () => {
      try {
        const remainingMs = deadline - Date.now();
        assert.ok(remainingMs > 0, "actual caller proof must stay inside its overall deadline");
        const result = await runChild(process.execPath, [launcher], {
          cwd: checkout, env, timeoutMs: Math.min(CALLER_PHASE_BUDGET_MS + 5_000, remainingMs),
        });
        cleanupVerified = cleanupVerified && result.processCleanupFailed === false;
        assert.equal(result.processCleanupFailed, false, "actual caller owned cleanup must be proven before source-copy reclaim");
        assert.ok([0, 1].includes(result.status), "timeout or signal is not valid caller fault evidence");
        return result;
      } catch (error) {
        cleanupVerified = false;
        throw error;
      }
    };
    const result = await runCallerTest();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /workflow acceptance CLI records actual-predecessor change evidence with bounded gates/);
    assert.match(result.stdout, /pass 1/);

    const corePath = join(checkout, "scripts/acceptance/core.mjs");
    const coreSource = readFileSync(corePath, "utf8");
    const contextKeys = ', "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH"';
    assert.equal(coreSource.split(contextKeys).length, 2);
    writeFileSync(corePath, coreSource.replace(contextKeys, ""));
    const contextRed = await runCallerTest();
    assert.notEqual(contextRed.status, 0, contextRed.stdout + contextRed.stderr);
    assert.match(contextRed.stdout, /the declaration base must be the actual merge predecessor/);
    writeFileSync(corePath, coreSource);
    assert.equal(readFileSync(corePath, "utf8"), coreSource);

    const acceptancePath = join(checkout, "scripts/acceptance.mjs");
    const acceptanceSource = readFileSync(acceptancePath, "utf8");
    const declarationSelection = '  return { paths: [...paths], pattern: patterns.join("|") };';
    assert.equal(acceptanceSource.split(declarationSelection).length, 2);
    writeFileSync(acceptancePath, acceptanceSource.replace(declarationSelection,
      '  return NODE_TEST_GATES.get("test:manifest-evidence");'));
    const declarationRed = await runCallerTest();
    assert.notEqual(declarationRed.status, 0, declarationRed.stdout + declarationRed.stderr);
    assert.match(declarationRed.stdout, /boundaryTest did not complete uniquely and successfully/);
    writeFileSync(acceptancePath, acceptanceSource);
    assert.equal(readFileSync(acceptancePath, "utf8"), acceptanceSource);

    const testPath = join(checkout, "tests/acceptance-runner.test.mjs");
    const source = readFileSync(testPath, "utf8");
    const anchor = '? JSON.parse(readFileSync(' + 'process.env.GITHUB_EVENT_PATH, "utf8")).before';
    assert.equal(source.split(anchor).length, 2);
    const mutant = source.replace(anchor, '? git("merge-base", "origin/v2", "HEAD")');
    writeFileSync(testPath, mutant);
    assert.equal(readFileSync(testPath, "utf8"), mutant);
    const red = await runCallerTest();
    assert.notEqual(red.status, 0, red.stdout + red.stderr);
    assert.match(red.stdout, /the declaration base must be the actual merge predecessor/);
    writeFileSync(testPath, source);
    assert.equal(readFileSync(testPath, "utf8"), source);
    const restored = await runCallerTest();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /pass 1/);
    assert.equal(readFileSync(join(root, "tests/acceptance-runner.test.mjs"), "utf8"), source);
    t.diagnostic(JSON.stringify({ topology, predecessor, merged, green: result.status, contextRed: contextRed.status, declarationRed: declarationRed.status, red: red.status, restored: restored.status }));
    completed = true;
    } finally {
      if (completed && cleanupVerified) rmSync(directory, { recursive: true, force: true });
      else process.stderr.write(`Retained actual caller source copy: ${directory}\n`);
    }
  }

  it("merged-push checkout runs the actual workflow caller with event.before", { timeout: 720_000 }, (t) =>
    exerciseWorkflowCaller({ t, topology: "multi" }));

  it("single-commit checkout runs the actual workflow caller without inventing an intermediate", { timeout: 720_000 }, (t) =>
    exerciseWorkflowCaller({ t, topology: "single" }));

  it("selects exact bounded declaration witnesses and rejects unsafe test paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-manifest-selection-"));
    temporary.push(directory);
    const witness = { file: "tests/fixture.test.mjs", name: "literal a+(b)" };
    const contract = { boundaryTest: witness, invariant: witness, fault: witness };
    const declaration = { contracts: [contract] };
    writeFileSync(join(directory, "change-evidence.json"), JSON.stringify(declaration));
    const selected = manifestEvidenceGate(directory);
    assert.ok(selected.paths.includes(witness.file), "declared test file must enter the bounded gate");
    assert.equal(new RegExp(selected.pattern).test(witness.name), true);
    assert.equal(new RegExp(selected.pattern).test("literal aaab"), false, "test names must be escaped, not interpreted as regex");
    for (const file of ["../escape.test.mjs", "tests/../escape.test.mjs", "tests//fixture.test.mjs", "--import=outside.mjs"]) {
      declaration.contracts[0].fault = { ...witness, file };
      writeFileSync(join(directory, "change-evidence.json"), JSON.stringify(declaration));
      assert.throws(() => manifestEvidenceGate(directory), /witness is malformed/);
    }
  });

  it("fault control: dropping declaration witnesses fails the named bounded selection assertion", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-manifest-selection-fault-"));
    temporary.push(directory);
    cpSync(join(process.cwd(), "scripts"), join(directory, "scripts"), { recursive: true });
    symlinkSync(realpathSync(join(process.cwd(), "node_modules")), join(directory, "node_modules"), "dir");
    const target = join(directory, "scripts", "acceptance.mjs");
    const source = readFileSync(target, "utf8");
    const anchor = '  return { paths: [...paths], pattern: patterns.join("|") };';
    assert.equal(source.split(anchor).length, 2);
    const mutant = source.replace(anchor, '  return NODE_TEST_GATES.get("test:manifest-evidence");');
    const witness = { file: "tests/fixture.test.mjs", name: "unique declared selection witness" };
    writeFileSync(join(directory, "change-evidence.json"), JSON.stringify({ contracts: [{ boundaryTest: witness, invariant: witness, fault: witness }] }));
    const assertSelected = async (phase) => {
      const { manifestEvidenceGate: select } = await import(pathToFileURL(target).href + "?phase=" + phase);
      assert.ok(select(directory).paths.includes(witness.file), "declared test file must enter the bounded gate");
    };
    await assertSelected("green");
    try {
      writeFileSync(target, mutant);
      await assert.rejects(assertSelected("red"), (error) => error.name === "AssertionError" && error.message.includes("declared test file must enter the bounded gate"));
    } finally { writeFileSync(target, source); }
    assert.equal(readFileSync(target, "utf8"), source);
    await assertSelected("restored");
    assert.equal(readFileSync(join(process.cwd(), "scripts", "acceptance.mjs"), "utf8"), source);
    t.diagnostic(JSON.stringify({ sourceSha256: sha256Text(source), faultSha256: sha256Text(mutant), restoredSha256: sha256Text(readFileSync(target, "utf8")), phases: ["GREEN", "named selection AssertionError RED", "restored GREEN"] }));
  });

  it("workflow acceptance CLI records actual-predecessor change evidence with bounded gates", { timeout: CALLER_PHASE_BUDGET_MS }, (t) => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, "change-evidence.json"), "utf8"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    // On a merged push checkout origin/v2 may already equal HEAD. Only the
    // real push payload records the historic predecessor; local PR proof uses
    // the current delivery merge base instead.
    const predecessor = process.env.GITHUB_EVENT_NAME === "push"
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).before
      : git("merge-base", "origin/v2", "HEAD");
    assert.equal(predecessor, manifest.base, "the declaration base must be the actual merge predecessor");
    const head = git("rev-parse", "HEAD");
    const fixture = mkdtempSync(join(tmpdir(), "bifrost-acceptance-push-caller-"));
    temporary.push(fixture);
    const eventPath = join(fixture, "event.json");
    writeFileSync(eventPath, JSON.stringify({ before: predecessor, after: head, ref: "refs/heads/v2" }));
    writeFileSync(join(fixture, "loader.mjs"), [
      'import { register } from "node:module";',
      'register(new URL("./hooks.mjs", import.meta.url));',
    ].join("\n") + "\n");
    writeFileSync(join(fixture, "hooks.mjs"), [
      "export async function resolve(specifier, context, nextResolve) {",
      '  if (context.parentURL?.endsWith("/scripts/acceptance.mjs")) {',
      '    if (specifier === "./verify-release.mjs") return { url: new URL("./verify-stub.mjs", import.meta.url).href, shortCircuit: true };',
      '    if (specifier === "./acceptance/journeys.mjs") return { url: new URL("./journeys-stub.mjs", import.meta.url).href, shortCircuit: true };',
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
    ].join("\n") + "\n");
    // Only the unrelated release gates and journeys are bounded. The real
    // acceptance CLI, profile, event environment, manifest, focused test
    // runner, and change-evidence validator all execute.
    writeFileSync(join(fixture, "verify-stub.mjs"), [
      "export async function runVerification({ execute }) {",
      '  const outcome = await execute({ script: "test:manifest-evidence", index: 0 });',
      '  if (outcome.status !== 0) throw new Error("focused manifest evidence test failed: " + outcome.stdout + outcome.stderr);',
      "  return { gates: [] };",
      "}",
    ].join("\n") + "\n");
    writeFileSync(join(fixture, "journeys-stub.mjs"), "export async function runJourneys() { return { cases: [] }; }\n");
    const script = fileURLToPath(new URL("../scripts/acceptance.mjs", import.meta.url));
    const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath };
    delete env.BIFROST_EVIDENCE_BASE;
    delete env.BIFROST_CI_REPORT;
    const runCaller = (before, expectedStatus, competingBase) => {
      writeFileSync(eventPath, JSON.stringify({ before, after: head, ref: "refs/heads/v2" }));
      if (competingBase) env.BIFROST_EVIDENCE_BASE = competingBase;
      else delete env.BIFROST_EVIDENCE_BASE;
      const result = spawnSync(process.execPath, ["--import", join(fixture, "loader.mjs"), script, "--profile", "deterministic"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 110_000,
      });
      const evidenceLine = (result.stdout ?? "").match(/^Evidence: (.+)$/m)?.[1];
      assert.ok(evidenceLine, result.stderr + result.stdout);
      const evidencePath = join(root, evidenceLine);
      try {
        const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        const changeEvidence = evidence.cases.find((item) => item.id === "change-evidence");
        assert.equal(changeEvidence?.status, expectedStatus, changeEvidence?.detail ?? JSON.stringify(evidence.cases));
        if (expectedStatus === "failed") {
          assert.match(changeEvidence.detail, /missing, unsupported or stale declaration/);
          assert.notEqual(result.status, 0, "a stale event base must fail the actual CLI");
        } else {
          assert.equal(JSON.parse(changeEvidence.detail).base, predecessor, "CLI evidence must bind the expected event.before");
        }
        t.diagnostic(JSON.stringify({ before, competingBase, expectedStatus, actualStatus: changeEvidence.status, cliStatus: result.status }));
        const eventsPath = join(dirname(evidencePath), "gates", "node-test-events.jsonl");
        const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
        for (const name of [
          "multi-commit push validates full event.before diff and rejects intermediate base",
          "event-driven push and pull request bases fail closed despite competing env",
          "a real stale ancestor base fails declaration equality with named detail",
          "fault control: selecting HEAD parent instead of event.before turns push base RED",
        ]) {
          assert.ok(events.some((event) => event.name === name && event.passed === true), `missing completed caller control: ${name}`);
        }
      } finally {
        rmSync(dirname(evidencePath), { recursive: true, force: true });
      }
    };
    runCaller(predecessor, "passed", head);
    const intermediate = git("rev-list", "--ancestry-path", `${predecessor}..HEAD`).split("\n").find((sha) => sha !== head);
    // A candidate can be a single commit. The owned merged-push fixture above
    // guarantees a real intermediate witness; the direct single-commit caller
    // instead proves that HEAD itself cannot replace the event predecessor.
    const wrongBase = intermediate ?? head;
    assert.notEqual(wrongBase, predecessor, "negative base must differ from event.before");
    runCaller(wrongBase, "failed", predecessor);
    runCaller(predecessor, "passed", wrongBase);
  });
});
