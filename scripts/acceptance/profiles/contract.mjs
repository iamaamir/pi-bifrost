import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAcceptanceTest, runJourneyChild } from "../journeys.mjs";
import { verificationGateEnvironment } from "../core.mjs";

const codexTemperatureCase = {
  id: "native-codex-temperature-current-green",
  testFile: "tests/probe.test.ts",
  title: "omits unsupported temperature from the native Codex health request",
  requirements: ["R15"],
  boundary: "runProbe with pinned @earendil-works/pi-ai Codex Responses request builder and a synthetic local fetch transport; not Pi E2E",
};

const openAiPiCase = {
  id: "native-openai-completions-pi-probe",
  testFile: "tests/integration/auto-virtual.test.mjs",
  title: "pauses a quota-exhausted background provider before dispatching queued sibling probes",
  requirements: ["R08", "R15"],
  boundary: "real pinned Pi, its OpenAI-completions request builder, synthetic registry and isolated local fake provider",
};

function redact(text) {
  return text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, "[REDACTED]");
}

function exactTapResult(output, title) {
  return output.split(/\r?\n/u).map((line) => line.trimStart()).flatMap((line) => {
    const match = /^(ok|not ok) \d+ - (.*)$/u.exec(line);
    return match?.[2] === title ? [{ result: match[1], title: match[2] }] : [];
  });
}

async function runFaultInjection({ root, artifactDir }) {
  const id = "native-codex-temperature-fault-red";
  const caseDir = join(artifactDir, "cases", id);
  const fixtureDir = join(caseDir, "fault-fixture");
  const testDir = join(fixtureDir, "tests");
  mkdirSync(testDir, { recursive: true });
  try {
    for (const entry of readdirSync(root)) {
      if ([".git", "node_modules", "tests", "probe.ts", ".bifrost-acceptance"].includes(entry)) continue;
      symlinkSync(join(root, entry), join(fixtureDir, entry));
    }
    symlinkSync(join(root, "node_modules"), join(fixtureDir, "node_modules"));
    for (const entry of readdirSync(join(root, "tests"))) {
      if (entry === "probe.test.ts") continue;
      symlinkSync(join(root, "tests", entry), join(testDir, entry));
    }
    const original = await import("node:fs/promises").then((fs) => fs.readFile(join(root, "probe.ts"), "utf8"));
    const marker = "maxTokens: PROBE_MAX_TOKENS,\n          signal: controller.signal,";
    if (!original.includes(marker)) {
      return {
        id,
        requirements: codexTemperatureCase.requirements,
        boundary: "isolated fault-injection copy of the pinned SDK adapter test; not Pi E2E",
        status: "blocked",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        attempts: [],
        exclusions: ["Live providers and real credentials are excluded."],
        artifacts: [],
        detail: "Could not find the probe option builder marker; fault injection did not run.",
      };
    }
    const injected = original.replace(marker, `${marker.replace("\n          signal", "\n          temperature: 0,\n          signal")}`);
    writeFileSync(join(fixtureDir, "probe.ts"), injected);
    copyFileSync(join(fixtureDir, "probe.ts"), join(caseDir, "fault-injected-probe.ts"));
    copyFileSync(join(root, "tests", "probe.test.ts"), join(testDir, "probe.test.ts"));
    const startedAt = new Date().toISOString();
    const gate = verificationGateEnvironment({ root, artifactDir: caseDir, script: id });
    const controller = new AbortController();
    let interruptedBy;
    const interrupt = (signal) => {
      interruptedBy = signal;
      controller.abort(signal);
    };
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    let run;
    try {
      run = await runJourneyChild({
        command: process.execPath,
        args: ["--test", "--experimental-strip-types", "--test-reporter=tap", `--test-name-pattern=${escapeRegExp(codexTemperatureCase.title)}`, "tests/probe.test.ts"],
        cwd: fixtureDir,
        env: gate.env,
        timeoutMs: 120_000,
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    }
    const safeOutput = redact(run.text);
    const logPath = join(caseDir, "fault-red.tap.txt");
    writeFileSync(logPath, safeOutput);
    const networkViolations = readFileSync(gate.violationPath, "utf8");
    const exactResults = exactTapResult(safeOutput, codexTemperatureCase.title);
    const expectedRed = run.exitCode !== 0 && exactResults.length === 1 && exactResults[0].result === "not ok";
    let status = expectedRed && !run.outputOverflow && !run.cleanupFailed && !run.interrupted && !interruptedBy && networkViolations.length === 0
      ? "passed"
      : run.interrupted || interruptedBy ? "blocked" : "failed";
    let detail;
    if (run.outputOverflow) detail = "Fault-injection output exceeded the bounded evidence limit.";
    else if (run.cleanupFailed) detail = "Fault-injection process group did not terminate cleanly.";
    else if (run.interrupted || interruptedBy) detail = `Fault injection was interrupted${interruptedBy ? ` by ${interruptedBy}` : ""}.`;
    else if (networkViolations.length) detail = "The contract fault-injection test attempted outbound network access outside loopback.";
    else if (!expectedRed) detail = "The exact required native Codex request test did not report the expected red failure.";
    const row = {
      id,
      requirements: codexTemperatureCase.requirements,
      boundary: "isolated copy of runProbe with pinned @earendil-works/pi-ai Codex Responses request builder and synthetic fetch transport; not Pi E2E",
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      attempts: exactResults.map((result) => ({ expected: 1, testName: result.title, result: result.result, note: "The synthetic transport rejects the injected unsupported field; the exact test must detect the regression." })),
      exclusions: ["Only a disposable source copy is faulted. Live providers and real credentials are excluded."],
      artifacts: [logPath, join(caseDir, "fault-injected-probe.ts"), gate.violationPath],
      ...(detail ? { detail } : {}),
    };
    writeFileSync(join(caseDir, "result.jsonl"), `${JSON.stringify(row)}\n`);
    return row;
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function runProfile({ root, artifactDir, options: _options }) {
  const cases = [await runFaultInjection({ root, artifactDir })];
  cases.push(await runAcceptanceTest({ root, artifactDir, journey: codexTemperatureCase }));
  cases.push(await runAcceptanceTest({ root, artifactDir, journey: openAiPiCase }));
  return { cases };
}
