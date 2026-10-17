import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionActiveInListing, runJourneyChild, runJourneys, stripTuiControlSequences, summarizeJourney, summarizeTuiEvidence } from "../scripts/acceptance/journeys.mjs";

describe("acceptance journey result classification", () => {
  const title = "the required real Pi journey";

  it("passes only a reported passing required journey", () => {
    assert.deepEqual(summarizeJourney({ exitCode: 0, output: `ok 1 - ${title}\n`, title }), { status: "passed" });
  });

  it("fails a reported regression even if another process returns zero", () => {
    assert.deepEqual(summarizeJourney({ exitCode: 0, output: `not ok 1 - ${title}\n`, title }), {
      status: "failed", detail: `Pi journey failed: ${title}`,
    });
  });

  it("blocks when only a parameterized sibling title is reported", () => {
    assert.deepEqual(summarizeJourney({ exitCode: 0, output: `    ok 1 - ${title} with synthetic case\n`, title }), {
      status: "blocked", detail: `Required Pi journey did not report a result: ${title}`,
    });
  });

  it("uses only the exact required variant when a sibling variant fails", () => {
    const required = `${title} in v1`;
    const output = `ok 1 - ${required}\nnot ok 2 - ${title} in v2\n`;
    assert.deepEqual(summarizeJourney({ exitCode: 0, output, title: required }), { status: "passed" });
    assert.deepEqual(summarizeJourney({ exitCode: 0, output, title: `${title} in v2` }), {
      status: "failed", detail: `Pi journey failed: ${title} in v2`,
    });
  });

  it("blocks when the required journey did not run", () => {
    assert.deepEqual(summarizeJourney({ exitCode: 0, output: "1..0\n", title }), {
      status: "blocked", detail: `Required Pi journey did not report a result: ${title}`,
    });
  });

  it("blocks when the required journey was skipped", () => {
    assert.deepEqual(summarizeJourney({ exitCode: 0, output: `ok 1 - ${title} # SKIP unavailable\n`, title }), {
      status: "blocked", detail: `Required Pi journey did not report a result: ${title}`,
    });
  });

  it("fails rather than trusting a TAP line when captured output overflowed", () => {
    assert.equal(summarizeJourney({ exitCode: 0, output: `ok 1 - ${title}`, title, outputOverflow: true }).status, "failed");
  });

  it("strips ANSI controls before checking rendered TUI status captions", () => {
    const rendered = "\u001b[31mBifrost · \u001b[32mon\u001b[0m\n\u001b[36mChecking models: 0/2\u001b[0m";
    const semantic = stripTuiControlSequences(rendered);
    assert.match(semantic, /Bifrost · on/u);
    assert.match(semantic, /Checking models: 0\/2/u);
  });

  it("requires observed TUI shutdown evidence instead of a completion marker alone", () => {
    assert.deepEqual(summarizeTuiEvidence({ exitCode: 0, output: "ACCEPTANCE_TUI_PASS", events: [] }), {
      status: "blocked", detail: "The TUI journey passed without shutdown evidence.",
    });
  });

  it("records only observable shutdown facts and marks post-exit UI state as unobserved", () => {
    assert.deepEqual(summarizeTuiEvidence({ exitCode: 0, output: "ACCEPTANCE_TUI_PASS", events: [{
      event: "shutdown_cancelled_pending_probe",
      gracefulExitObserved: true,
      sessionAbsentFromActiveList: true,
      probeClientClosed: true,
      lateSave: false,
      staleUiCallbacks: "not_observed_after_session_exit",
    }] }), { status: "passed" });
    assert.equal(summarizeTuiEvidence({ exitCode: 0, output: "ACCEPTANCE_TUI_PASS", events: [{
      event: "shutdown_cancelled_pending_probe",
      gracefulExitObserved: true,
      sessionAbsentFromActiveList: true,
      probeClientClosed: true,
      lateSave: false,
      staleUiCallbacks: false,
    }] }).status, "failed");
    assert.equal(summarizeTuiEvidence({ exitCode: 0, output: "ACCEPTANCE_TUI_PASS", events: [{
      event: "shutdown_cancelled_pending_probe",
      gracefulExitObserved: false,
      sessionAbsentFromActiveList: true,
      probeClientClosed: true,
      lateSave: false,
      staleUiCallbacks: "not_observed_after_session_exit",
    }] }).status, "failed");
  });

  it("checks active TUI session records by structure and fails closed on an unknown matching status", () => {
    assert.equal(isSessionActiveInListing({ sessions: [{ id: "s1", status: "running" }] }, "s1"), true);
    assert.equal(isSessionActiveInListing({ sessions: [{ id: "s1", running: true }] }, "s1"), true);
    assert.equal(isSessionActiveInListing({ sessions: [{ id: "s1", running: false }] }, "s1"), false);
    assert.equal(isSessionActiveInListing({ sessions: [{ id: "old", status: "exited" }] }, "s1"), false);
    assert.throws(() => isSessionActiveInListing({ sessions: [{ id: "s1" }] }, "s1"), /structured active\/exited state/u);
    assert.throws(() => isSessionActiveInListing({ activeSessions: [] }, "s1"), /sessions array/u);
  });

  it("fails TUI acceptance when bounded output overflows even if the completion marker remains", () => {
    assert.equal(summarizeTuiEvidence({ exitCode: 0, output: "ACCEPTANCE_TUI_PASS", outputOverflow: true, events: [] }).status, "failed");
  });

  it("kills and awaits the whole detached child group when the journey is aborted", { timeout: 10_000 }, async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "bifrost-journey-signal-"));
    const readyPath = join(directory, "ready");
    const stoppedPath = join(directory, "descendant-stopped");
    const childCode = `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(${JSON.stringify(stoppedPath)},"stopped");process.exit(0)});require("node:fs").writeFileSync(${JSON.stringify(readyPath)},"ready");setInterval(()=>{},1000)`;
    const parentCode = `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(childCode)}]);setInterval(()=>{},1000)`;
    const controller = new AbortController();
    try {
      const childRun = runJourneyChild({
        command: process.execPath,
        args: ["-e", parentCode],
        cwd: directory,
        env: { PATH: process.env.PATH },
        timeoutMs: 8_000,
        signal: controller.signal,
      });
      const readyDeadline = Date.now() + 4_000;
      while (!existsSync(readyPath) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(existsSync(readyPath), true, "the child group should report its descendant before abort");
      controller.abort();
      const result = await childRun;
      assert.equal(result.interrupted, true);
      const stoppedDeadline = Date.now() + 2_000;
      while (!existsSync(stoppedPath) && Date.now() < stoppedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(readFileSync(stoppedPath, "utf8"), "stopped", "SIGTERM must reach the descendant process group");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("kills descendants left running after the journey child exits normally", { timeout: 10_000, skip: process.platform === "win32" }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-journey-close-"));
    const readyPath = join(directory, "ready");
    const stoppedPath = join(directory, "descendant-stopped");
    const childCode = `const fs=require("node:fs");process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(stoppedPath)},"stopped");process.exit(0)});fs.writeFileSync(${JSON.stringify(readyPath)},"ready");setInterval(()=>{},1000);setTimeout(()=>process.exit(0),5000)`;
    const parentCode = `const {spawn}=require("node:child_process");const fs=require("node:fs");spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});const deadline=Date.now()+3000;const wait=()=>fs.existsSync(${JSON.stringify(readyPath)})?process.exit(0):Date.now()<deadline?setTimeout(wait,10):process.exit(2);wait()`;
    try {
      const result = await runJourneyChild({
        command: process.execPath,
        args: ["-e", parentCode],
        cwd: directory,
        env: { PATH: process.env.PATH },
        timeoutMs: 8_000,
      });
      assert.equal(result.exitCode, 0, result.text);
      assert.equal(result.cleanupFailed, false, result.text);
      assert.equal(readFileSync(stoppedPath, "utf8"), "stopped", "normal child exit must not leave its descendant running");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });


  it("blocks every remaining required row without starting a child after cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-journey-cancelled-"));
    try {
      const result = await runJourneys({ root: directory, artifactDir: join(directory, "artifacts"), options: { shouldStop: () => true } });
      assert.ok(result.cases.length > 1);
      assert.ok(result.cases.every((row) => row.status === "blocked"));
      assert.equal(existsSync(join(directory, "artifacts")), false, "cancellation before the first row must not create or spawn a journey");
      assert.ok(result.cases.some((row) => row.id === "first-use-prefers-verified-sibling"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds child output and exposes overflow to the caller", async () => {
    const result = await runJourneyChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1000));process.stdout.write('ACCEPTANCE_TUI_PASS')"],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      captureLimit: 64,
    });
    assert.equal(result.outputOverflow, true);
    assert.match(result.text, /stream output truncated/);
    assert.equal(summarizeTuiEvidence({ ...result, events: [] }).status, "failed");
  });

  it("bounds stderr independently so a retained stdout pass marker cannot hide overflow", async () => {
    const result = await runJourneyChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ACCEPTANCE_TUI_PASS');process.stderr.write('x'.repeat(1000))"],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      captureLimit: 64,
    });
    assert.equal(result.outputOverflow, true);
    assert.equal(summarizeTuiEvidence({ ...result, events: [] }).status, "failed");
  });
});
