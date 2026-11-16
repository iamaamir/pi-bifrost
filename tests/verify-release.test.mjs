import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkReplayBaseline, runVerification } from "../scripts/verify-release.mjs";
import { fixtureGitEnv, withFixtureEnv } from "./fixtures/git-env.mjs";

const scripts = { test: "true", typecheck: "true", "build:router": "true", "test:integration": "true", "test:ui": "true", "test:ui:reliability": "true" };

function repository(packageScripts = scripts) {
  const root = mkdtempSync(join(tmpdir(), "bifrost-verify-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, ".gitignore"), "screenshots/\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: packageScripts }));
  writeFileSync(join(root, "scripts", "source.js"), "original\n");
  execFileSync("git", ["init", "-q"], { cwd: root, env: fixtureGitEnv() });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "."], { cwd: root, env: fixtureGitEnv() });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root, env: fixtureGitEnv() });
  return root;
}

function passingGates() {
  return async () => ({ status: 0, stdout: "ok", stderr: "" });
}

async function verify(root, options = {}) {
  return withFixtureEnv(() => runVerification({ root, checkPreflight: () => "fixture preflight passed", execute: passingGates(), ...options }));
}

test("a failed gate fails the result without source drift", async () => {
  const root = repository();
  try {
    const result = await verify(root, { execute: async ({ index }) => ({ status: index === 0 ? 3 : 0, stdout: "", stderr: "" }) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates[1].exitCode, 3);
    assert.equal(result.sourceChangedDuringRun, false);
    assert.equal(result.revisionChangedDuringRun, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source drift alone fails an otherwise passing verification", async () => {
  const root = repository();
  try {
    const result = await verify(root, { execute: async ({ index }) => {
      if (index === 0) writeFileSync(join(root, "scripts", "source.js"), "changed\n");
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates.every(({ exitCode }) => exitCode === 0), true);
    assert.equal(result.sourceChangedDuringRun, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("executable-bit drift fails an otherwise passing verification", async () => {
  const root = repository();
  try {
    const source = join(root, "scripts", "source.js");
    chmodSync(source, 0o644);
    const result = await verify(root, { execute: async ({ index }) => {
      if (index === 0) chmodSync(source, 0o755);
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates.every(({ exitCode }) => exitCode === 0), true);
    assert.equal(result.sourceChangedDuringRun, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clean passing verification records a successful candidate", async () => {
  const root = repository();
  try {
    const result = await verify(root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.workingTreeCleanAtStart, true);
    assert.equal(result.workingTreeCleanAtEnd, true);
    assert.equal(result.sourceHashAtStart, result.sourceHashAtEnd);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pre-existing dirty source cannot pass a revision-bound release gate", async () => {
  const root = repository();
  try {
    writeFileSync(join(root, "scripts", "source.js"), "local candidate\n");
    const result = await verify(root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.workingTreeCleanAtStart, false);
    assert.equal(result.workingTreeCleanAtEnd, false);
    assert.equal(result.sourceChangedDuringRun, false);
    assert.equal(result.sourceHashAtStart, result.sourceHashAtEnd);
    assert.doesNotMatch(readFileSync(join(root, result.manifestPath), "utf8"), /source\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("untracked source drift fails and the manifest records dirty state without paths", async () => {
  const root = repository();
  try {
    const result = await verify(root, { execute: async ({ index }) => {
      if (index === 0) writeFileSync(join(root, "new-source.js"), "new\n");
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.sourceChangedDuringRun, true);
    assert.equal(result.workingTreeCleanAtStart, true);
    assert.equal(result.workingTreeCleanAtEnd, false);
    const manifest = readFileSync(join(root, result.manifestPath), "utf8");
    assert.doesNotMatch(manifest, /new-source\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a HEAD-only change fails even when the source tree stays identical", async () => {
  const root = repository();
  try {
    const result = await verify(root, { execute: async ({ index }) => {
      if (index === 0) execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "empty"], { cwd: root, env: fixtureGitEnv() });
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.sourceChangedDuringRun, false);
    assert.equal(result.revisionChangedDuringRun, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight failure is recorded with its actionable reason", async () => {
  const root = repository();
  try {
    const result = await withFixtureEnv(() => runVerification({ root, checkPreflight: () => { throw new Error("Pillow is missing"); } }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates[0].id, "preflight");
    assert.equal(result.gates[0].exitCode, 1);
    assert.match(readFileSync(join(root, result.gates[0].logPath), "utf8"), /Pillow is missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("symlink target changes are source drift even when both targets contain the same bytes", async () => {
  const root = repository();
  try {
    writeFileSync(join(root, "target-a"), "same bytes\n");
    writeFileSync(join(root, "target-b"), "same bytes\n");
    symlinkSync("target-a", join(root, "source-link"));
    const result = await verify(root, { execute: async ({ index }) => {
      if (index === 0) {
        rmSync(join(root, "source-link"));
        symlinkSync("target-b", join(root, "source-link"));
      }
      return { status: 0, stdout: "ok", stderr: "" };
    } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.sourceChangedDuringRun, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large spawned gate output stays bounded and preserves its failure tail", async () => {
  const root = repository({ ...scripts, test: "node scripts/large-output.mjs" });
  const marker = "UNIQUE_FAILTAIL_RELEASE_GATE";
  try {
    writeFileSync(join(root, "scripts", "large-output.mjs"), `process.stdout.write("x".repeat(1200000)); process.stderr.write("y".repeat(1200000) + "${marker}"); process.exitCode = 7;`);
    const result = await withFixtureEnv(() => runVerification({ root, checkPreflight: () => "fixture preflight passed" }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates[1].exitCode, 7);
    const log = readFileSync(join(root, result.gates[1].logPath), "utf8");
    assert.match(log, new RegExp(marker));
    assert.ok(Buffer.byteLength(log) < 300_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification rejects a package missing any required gate", async () => {
  const root = repository({ test: "true", typecheck: "true" });
  try {
    const result = await withFixtureEnv(() => runVerification({ root, execute: async () => assert.fail("must not run gates") }));
    assert.equal(result.exitCode, 1);
    assert.match(result.error, /build:router/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const REPO_INDEX = fileURLToPath(new URL("../index.ts", import.meta.url));

function writeIndex(root, source = readFileSync(REPO_INDEX, "utf8")) {
  writeFileSync(join(root, "index.ts"), source);
}

test("release preflight accepts an index.ts that matches the pinned replay baseline", () => {
  const root = repository();
  try {
    writeIndex(root);
    assert.match(checkReplayBaseline(root), /G03 replay fault-proof baseline matches index\.ts \(sha256 [0-9a-f]{12}, 3 guards\)/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale replay baseline fails the preflight before any gate and names the fixture to update", async () => {
  const root = repository();
  try {
    // The PR #193 failure shape: one unrelated line added to index.ts.
    writeIndex(root, `${readFileSync(REPO_INDEX, "utf8")}\n// changed startup message\n`);
    const result = await withFixtureEnv(() => runVerification({
      root,
      checkPreflight: () => `tools available. ${checkReplayBaseline(root)}`,
      execute: async () => assert.fail("release gates must not run after a stale replay baseline"),
    }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates.length, 1, "only the preflight is recorded when the baseline is stale");
    assert.equal(result.gates[0].id, "preflight");
    assert.equal(result.gates[0].exitCode, 1);
    const log = readFileSync(join(root, result.gates[0].logPath), "utf8");
    assert.match(log, /G03 replay fault-proof baseline is stale: index\.ts sha256=[0-9a-f]{64}/u);
    assert.match(log, /tests\/fixtures\/replay-fault-control\.mjs/u);
    assert.match(log, /REPLAY_GUARD_BASELINE_SHA256/u);
    assert.match(log, /Release preflight never rewrites the pin/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production preflight validates the replay baseline before host tooling and before any gate", async () => {
  const root = repository();
  try {
    writeIndex(root, `${readFileSync(REPO_INDEX, "utf8")}\n// changed startup message\n`);
    const sourceBefore = readFileSync(join(root, "index.ts"), "utf8");
    // No checkPreflight override: this is the real preflight(). The fixture root
    // has no node_modules, so reaching the installed-tool checks would fail with
    // a different message; the baseline error proves the production wiring ran.
    const result = await withFixtureEnv(() => runVerification({
      root,
      execute: async () => assert.fail("release gates must not run after a stale replay baseline"),
    }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.gates.length, 1, "only the preflight is recorded when the baseline is stale");
    assert.equal(result.gates[0].id, "preflight");
    assert.equal(result.gates[0].exitCode, 1);
    const log = readFileSync(join(root, result.gates[0].logPath), "utf8");
    assert.match(log, /G03 replay fault-proof baseline is stale/u);
    assert.doesNotMatch(log, /agent-tui is missing|Pinned Pi is missing/u);
    assert.equal(readFileSync(join(root, "index.ts"), "utf8"), sourceBefore, "the baseline check must not rewrite the source");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the replay baseline check fails closed when index.ts cannot be read", () => {
  const root = repository();
  try {
    assert.throws(() => checkReplayBaseline(root), /G03 replay fault-proof baseline check cannot read index\.ts: ENOENT\./u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
