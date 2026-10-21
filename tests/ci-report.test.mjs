import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportCiReportIfConfigured } from "../scripts/ci-report.mjs";
import { makeReportData, renderCiReport, runReportCli, validateReportData, writeCiReport } from "../scripts/ci-report.mjs";

const temporary = [];
after(() => temporary.forEach((path) => rmSync(path, { recursive: true, force: true })));

const fixturePath = fileURLToPath(new URL("./fixtures/ci-report/real-53-pass-1-block.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const expectedSha = fixture.evidence.source.revisionAtStart;
const trustedContext = {
  trusted: true,
  sha: expectedSha,
  runId: "23900123456",
  attempt: "2",
  repository: "example/pi-bifrost",
  serverUrl: "https://github.com",
  conclusion: "success",
};

describe("CI report", () => {
  it("renders a real 53-pass, 1-blocked run without turning partial coverage green", () => {
    const rendered = renderCiReport(fixture, trustedContext);
    assert.equal(rendered.confidence.state, "BLOCKED");
    assert.deepEqual(rendered.counts, { passed: 53, failed: 0, blocked: 1, missing: 0, deferred: 1 });
    assert.match(rendered.markdown, /PR confidence: 🔴 BLOCKED/);
    assert.match(rendered.markdown, /PR confidence: 🔴 BLOCKED \(required checks only\)[^\n]*\n> \*\*Scope: Pi \+ fake providers; live providers not tested; PRD coverage partial\.\*\*/);
    assert.match(renderCiReport(fixture, { ...trustedContext, conclusion: "failure" }).markdown, /Workflow result: 🔴 FAIL/);
    assert.match(rendered.markdown, /deferred:r13:stable-versioned-api/);
    assert.match(rendered.markdown, /not establish support for every provider or a flake-free rate/);
    assert.match(rendered.markdown, /https:\/\/github\.com\/example\/pi-bifrost\/actions\/runs\/23900123456#artifacts/);
    assert.doesNotMatch(rendered.markdown, /All PRD requirements passed|all providers|flake-free behavior/);
  });

  it("reports verified checks only when deterministic required evidence is complete and current", () => {
    const passing = structuredClone(fixture);
    passing.evidence.exitCode = 0;
    passing.evidence.source.dirtyPathsAtStart = [];
    passing.evidence.source.dirtyPathsAtEnd = [];
    const productGap = passing.evidence.cases.find((item) => item.id === "first-use-unverified-route-product-gap");
    productGap.status = "passed";
    productGap.detail = "Synthetic green fixture only.";
    const rendered = renderCiReport(passing, trustedContext);
    assert.equal(rendered.confidence.state, "VERIFIED CHECKS");
    assert.match(rendered.markdown, /PR confidence: 🟢 VERIFIED CHECKS/);
    assert.match(rendered.markdown, /Workflow result: 🟢 PASS/);
    assert.match(rendered.markdown, /PR controls the workflow producer and test code/u);

    const wrongSha = renderCiReport(passing, { ...trustedContext, sha: "a".repeat(40) });
    assert.equal(wrongSha.confidence.state, "BLOCKED");
    assert.match(wrongSha.confidence.reasons.join(" "), /stale/);

    const drift = structuredClone(passing);
    drift.evidence.source.changedDuringRun = true;
    assert.equal(renderCiReport(drift, trustedContext).confidence.state, "BLOCKED");

    const dirty = structuredClone(passing);
    dirty.evidence.source.dirtyPathsAtStart = [{ index: " M", path: "index.ts" }];
    assert.equal(renderCiReport(dirty, trustedContext).confidence.state, "BLOCKED");

    const unknownCleanliness = structuredClone(passing);
    delete unknownCleanliness.evidence.source.dirtyPathsAtStart;
    assert.equal(renderCiReport(unknownCleanliness, trustedContext).confidence.state, "INCOMPLETE");
  });

  it("reports actual fingerprint comparison and profile scope", () => {
    const different = structuredClone(fixture);
    different.evidence.source.changedDuringRun = false;
    different.evidence.source.fingerprintAtEnd = `${different.evidence.source.fingerprintAtStart}-different`;
    assert.match(renderCiReport(different, trustedContext).markdown, /Fingerprints: differ/);

    const unknown = structuredClone(fixture);
    delete unknown.evidence.source.fingerprintAtStart;
    assert.match(renderCiReport(unknown, trustedContext).markdown, /Fingerprints: unknown/);

    const live = structuredClone(fixture);
    live.evidence.profile = "live";
    const liveReport = renderCiReport(live, trustedContext).markdown;
    assert.match(liveReport, /Scope: Live profile; one approved model allowlisted; provider requests may be blocked/);
    assert.doesNotMatch(liveReport.split("<details>")[0], /live providers not tested/);
  });

  it("blocks hard failures and missing required release gates", () => {
    const failed = structuredClone(fixture);
    failed.evidence.exitCode = 1;
    failed.evidence.cases.find((item) => item.id === "gate:unit").status = "failed";
    const failedReport = renderCiReport(failed, trustedContext);
    assert.equal(failedReport.confidence.state, "BLOCKED");
    assert.match(failedReport.markdown, /gate:unit/);

    const missing = structuredClone(fixture);
    missing.evidence.exitCode = 0;
    missing.evidence.source.dirtyPathsAtStart = [];
    missing.evidence.source.dirtyPathsAtEnd = [];
    missing.evidence.cases = missing.evidence.cases.filter((item) => item.id !== "gate:unit");
    const missingReport = renderCiReport(missing, trustedContext);
    assert.equal(missingReport.confidence.state, "BLOCKED");
    assert.match(missingReport.confidence.reasons.join(" "), /unit/);

    const truncated = { ...fixture, evidence: { ...fixture.evidence, cases: fixture.evidence.cases.slice(0, 49) } };
    const duplicate = structuredClone(truncated);
    duplicate.evidence.exitCode = 0;
    duplicate.evidence.source.dirtyPathsAtStart = [];
    duplicate.evidence.source.dirtyPathsAtEnd = [];
    duplicate.evidence.cases.push(structuredClone(duplicate.evidence.cases[0]));
    assert.match(renderCiReport(duplicate, trustedContext).confidence.reasons.join(" "), /Duplicate case identifiers/);

    const deferred = structuredClone(fixture);
    deferred.evidence.exitCode = 0;
    deferred.evidence.cases.find((item) => item.id === "first-use-unverified-route-product-gap").status = "passed";
    deferred.evidence.cases.find((item) => item.id === "deferred:r13:stable-versioned-api").required = true;
    assert.equal(renderCiReport(deferred, trustedContext).confidence.state, "BLOCKED");
  });

  it("distinguishes cancelled, missing, malformed, and limited-profile evidence", () => {
    assert.equal(renderCiReport(fixture, { ...trustedContext, conclusion: "cancelled" }).confidence.state, "BLOCKED");
    assert.equal(renderCiReport(null, trustedContext).confidence.state, "INCOMPLETE");
    const pending = renderCiReport(null, { ...trustedContext, conclusion: "in_progress" });
    assert.equal(pending.confidence.state, "INCOMPLETE");
    assert.match(pending.markdown, /Result: ⏳ PENDING/);
    assert.match(renderCiReport({ schemaVersion: 99, cases: [] }, trustedContext).markdown, /MISSING/);
    const complete = structuredClone(fixture);
    complete.evidence.exitCode = 0;
    complete.evidence.source.dirtyPathsAtStart = [];
    complete.evidence.source.dirtyPathsAtEnd = [];
    complete.evidence.cases.find((item) => item.id === "first-use-unverified-route-product-gap").status = "passed";
    assert.equal(renderCiReport(complete, { ...trustedContext, conclusion: undefined }).confidence.state, "INCOMPLETE");
    assert.throws(() => makeReportData({ schemaVersion: 2, cases: [] }), /Unsupported acceptance evidence schema/);

    const contract = structuredClone(fixture);
    contract.evidence.profile = "contract";
    contract.evidence.exitCode = 0;
    contract.evidence.source.dirtyPathsAtStart = [];
    contract.evidence.source.dirtyPathsAtEnd = [];
    contract.evidence.cases.find((item) => item.id === "first-use-unverified-route-product-gap").status = "passed";
    const limited = renderCiReport(contract, trustedContext);
    assert.equal(limited.confidence.state, "LIMITED");
  });  it("keeps hostile Markdown and untrusted artifact URLs inert", () => {
    const hostile = structuredClone(fixture);
    const issue = hostile.evidence.cases.find((item) => item.id === "gate:pinned-pi-reliability-ui");
    issue.status = "blocked";
    issue.id = "broken | [inject](javascript:alert(1))\n| forged row";
    issue.detail = "<script>alert('x')</script> notify @danger\n| injected | passed |";
    issue.artifacts = ["https://evil.example/steal.md](javascript:alert(2)", "file:///secret"];
    const report = renderCiReport(hostile, {
      sha: "a".repeat(40), runId: "123", attempt: "1",
      repository: "example/repo](javascript:alert(3)", serverUrl: "javascript:alert(4)",
    }).markdown;
    assert.doesNotMatch(report, /\]\(javascript:|<script>|\n\| injected \|/);
    assert.doesNotMatch(report, /@danger/);
    assert.match(report, /&#64;danger/);
    assert.match(report, /&lt;script&gt;/);
    assert.match(report, /`https:\/\/evil\.example/);
    assert.doesNotMatch(report, /\]\(https:\/\/evil\.example/);
  });

  it("redacts credential-shaped failure text before exporting report data", () => {
    const sensitive = structuredClone(fixture.evidence);
    const issue = sensitive.cases.find((item) => item.id === "gate:pinned-pi-reliability-ui");
    issue.detail = "Authorization: Bearer sk-live-report-sentinel-123456789\nCookie: session=report-cookie-sentinel";
    const output = JSON.stringify(makeReportData(sensitive));
    assert.doesNotMatch(output, /sk-live-report-sentinel-123456789|report-cookie-sentinel/);
    assert.match(output, /REDACTED/);
  });

  it("normalizes number, string, and structured attempt records", () => {
    const normalized = validateReportData({
      schemaVersion: 1,
      cases: [{
        id: "attempt-shapes",
        attempts: [1, "retry 2", { durationMs: 12, result: "failed", testFile: "tests/example.mjs", testName: "synthetic case", failure: { code: "E_SYNTHETIC", message: "test failure", cause: { message: "nested cause" } } }],
      }],
    }).evidence.cases[0].attempts;
    assert.equal(normalized[0], 1);
    assert.equal(normalized[1], "retry 2");
    assert.deepEqual(normalized[2], {
      durationMs: 12,
      result: "failed",
      testFile: "tests/example.mjs",
      testName: "synthetic case",
      failure: { code: "E_SYNTHETIC", message: "test failure", cause: { message: "nested cause" } },
    });
  });

  it("writes only the canonical evidence export and a concise Markdown preview", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-ci-report-cli-"));
    temporary.push(directory);
    const outputDir = join(directory, "out");
    const outputs = writeCiReport({ evidence: fixture.evidence, outputDir, context: trustedContext });
    const data = JSON.parse(readFileSync(outputs.dataPath, "utf8"));
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.evidence.profile, "deterministic");
    assert.equal(Object.hasOwn(data, "sha"), false);
    assert.equal(Object.hasOwn(data.evidence, "summary"), false);
    assert.equal(existsSync(outputs.markdownPath), true);

    const evidencePath = join(directory, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(fixture.evidence));
    const script = fileURLToPath(new URL("../scripts/ci-report.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--evidence", evidencePath, "--output-dir", join(directory, "cli"), "--sha", expectedSha, "--run-id", "23900123456", "--attempt", "2", "--repository", "example/pi-bifrost", "--server-url", "https://github.com", "--conclusion", "success"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CI report:/);
    assert.ok(existsSync(join(directory, "cli", "report-data.json")));
    assert.ok(existsSync(join(directory, "cli", "ci-report.md")));
  });

  it("rejects malformed CLI input without writing a report", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-ci-report-bad-cli-"));
    temporary.push(directory);
    const evidencePath = join(directory, "bad.json");
    writeFileSync(evidencePath, "{not-json");
    const script = fileURLToPath(new URL("../scripts/ci-report.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--evidence", evidencePath, "--output-dir", join(directory, "out")], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(existsSync(join(directory, "out", "report-data.json")), false);
  });

  it("exports reports only from the configured top-level deterministic run", () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-ci-report-hook-"));
    temporary.push(directory);
    const outputFile = join(directory, "github-output.txt");
    const summaryFile = join(directory, "github-summary.md");
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");
    const env = {
      GITHUB_ACTIONS: "true",
      BIFROST_CI_REPORT: "1",
      BIFROST_CI_REPORT_SHA: expectedSha,
      BIFROST_CI_REPORT_RUN_ID: "23900123456",
      BIFROST_CI_REPORT_RUN_ATTEMPT: "2",
      BIFROST_CI_REPORT_REPOSITORY: "example/pi-bifrost",
      BIFROST_CI_REPORT_SERVER_URL: "https://github.com",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    };
    assert.equal(exportCiReportIfConfigured({ isMain: false, profile: "deterministic", evidence: fixture.evidence, artifactDir: directory, env }), undefined);
    assert.deepEqual(exportCiReportIfConfigured({ isMain: true, profile: "contract", evidence: fixture.evidence, artifactDir: directory, env }), undefined);
    const outputs = exportCiReportIfConfigured({ isMain: true, profile: "deterministic", evidence: fixture.evidence, artifactDir: directory, env });
    assert.ok(outputs);
    assert.ok(existsSync(join(directory, "report-data.json")));
    assert.ok(existsSync(join(directory, "ci-report.md")));
    const githubOutputs = readFileSync(outputFile, "utf8");
    assert.match(githubOutputs, new RegExp(`^report-markdown=${join(directory, "ci-report.md")}\\n`, "u"));
    assert.match(githubOutputs, new RegExp(`report-data=${join(directory, "report-data.json")}\\n`, "u"));
    assert.equal(readFileSync(summaryFile, "utf8"), "", "the final CI job owns the workflow summary");
  });
});
