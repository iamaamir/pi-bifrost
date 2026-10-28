import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { changeEvidenceCase, validateChangeEvidence } from "../scripts/acceptance/change-evidence.mjs";

const base = "a".repeat(40);
const ref = { file: "tests/route.test.ts", name: "observes dispatch" };
function input() {
  return { root: "/repo", base, changedFiles: ["routing.ts", "change-evidence.json"],
    manifest: { schemaVersion: 1, base, contracts: [{ id: "routing", requirement: "R01", files: ["routing.ts"],
      boundary: "real Pi with fake HTTP", assertions: "requested model is invoked; decoys are not",
      boundaryTest: { ...ref }, invariant: { ...ref }, fault: { ...ref } }] },
    testEvents: [{ type: "test:complete", ...ref, passed: true }] };
}

test("ignores a symlinked node_modules path without hiding other untracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-node-modules-ignore-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), readFileSync(join(process.cwd(), ".gitignore"), "utf8"));
    mkdirSync(join(root, "dependency-target"));
    symlinkSync(join(root, "dependency-target"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "source.ts"), "source");

    const ignoredStatus = git("status", "--porcelain=v1", "--untracked-files=all");
    assert.doesNotMatch(ignoredStatus, /node_modules/);
    assert.match(ignoredStatus, /source\.ts/);
    assert.match(git("check-ignore", "-v", "--", "node_modules"), /\.gitignore:1:node_modules/);

    writeFileSync(join(root, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8").replace("node_modules\n", "node_modules/\n"));
    assert.match(git("status", "--porcelain=v1", "--untracked-files=all"), /node_modules/,
      "the old directory-only pattern must expose a symlink as untracked source noise");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepts executed contract evidence and explicit dimension exceptions", () => {
  const data = input();
  assert.equal(validateChangeEvidence(data), data.manifest);
  data.manifest.contracts[0].invariant = { exception: "Static docs-only example; no state transitions." };
  assert.equal(validateChangeEvidence(data), data.manifest);
});

test("rejects stale declarations and unmapped or fabricated changed files", () => {
  for (const mutate of [
    (d) => { d.manifest.base = "b".repeat(40); },
    (d) => { d.manifest.schemaVersion = 2; },
    (d) => { d.changedFiles.push("commands.ts"); },
    (d) => { d.manifest.contracts[0].files.push("untouched.ts"); },
    (d) => { d.manifest.contracts = []; },
    (d) => { d.manifest.contracts.push(structuredClone(d.manifest.contracts[0])); },
  ]) {
    const data = input(); mutate(data);
    assert.throws(() => validateChangeEvidence(data), /Change evidence/);
  }
});

test("rejects missing ambiguous failed skipped TODO and nonterminal evidence", () => {
  for (const events of [[], [input().testEvents[0], input().testEvents[0]],
    ...[{ passed: false }, { skipped: true }, { todo: true }, { type: "test:pass" },
      { file: "other/tests/route.test.ts" }, { name: "another test" }].map((patch) => [{ ...input().testEvents[0], ...patch }])]) {
    assert.throws(() => validateChangeEvidence({ ...input(), testEvents: events }), /did not complete/);
  }
});

test("rejects missing dimensions empty rationales and path aliases", () => {
  for (const evidence of [undefined, {}, { exception: " " }, { ...ref, exception: "skip" },
    { ...ref, file: "tests/../route.test.ts" }, { ...ref, file: "/tests/route.test.ts" }]) {
    const data = input(); data.manifest.contracts[0].fault = evidence;
    assert.throws(() => validateChangeEvidence(data), /Change evidence/);
  }
});

test("checks real git diff and fails closed for missing PR metadata or declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "old"); git("add", "."); git("commit", "-qm", "base");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "routing.ts"), "new");
    const data = input(); data.manifest.base = revision;
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(data.manifest));
    git("add", "."); git("commit", "-qm", "candidate");
    const options = { root, testEvents: data.testEvents, env: { BIFROST_EVIDENCE_BASE: revision } };
    assert.equal(changeEvidenceCase(options).status, "passed");
    assert.equal(changeEvidenceCase({ ...options, testEvents: [] }).status, "failed");
    assert.equal(changeEvidenceCase({ ...options, env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(root, "missing") } }).status, "failed");
    rmSync(join(root, "change-evidence.json"));
    assert.equal(changeEvidenceCase(options).status, "failed");
    assert.equal(changeEvidenceCase({ ...options, env: {} }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects a test event whose path only suffix-matches the declared file", () => {
  for (const file of ["/other/tests/route.test.ts", "vendor/tests/route.test.ts", "other/repo/tests/route.test.ts"]) {
    const data = input();
    data.testEvents = [{ type: "test:complete", file, name: ref.name, passed: true }];
    assert.throws(() => validateChangeEvidence(data), /did not complete/);
  }
});

test("accepts exact normalized event paths including CI fetch-depth checkout layouts", () => {
  for (const file of ["tests/route.test.ts", "./tests/route.test.ts", "/repo/tests/route.test.ts"]) {
    const data = input();
    data.testEvents = [{ type: "test:complete", file, name: ref.name, passed: true }];
    assert.equal(validateChangeEvidence(data), data.manifest);
  }
  const ci = { ...input(), root: "/home/runner/work/bifrost/bifrost" };
  ci.testEvents = [{ type: "test:complete", file: "/home/runner/work/bifrost/bifrost/tests/route.test.ts", name: ref.name, passed: true }];
  assert.equal(validateChangeEvidence(ci), ci.manifest);
});

test("rejects a changed file covered by more than one contract with a named error", () => {
  const data = input();
  data.manifest.contracts.push({ id: "routing-copy", requirement: "R02", files: ["routing.ts"],
    boundary: "duplicate boundary", assertions: "duplicate assertions",
    boundaryTest: { ...ref }, invariant: { ...ref }, fault: { ...ref } });
  assert.throws(() => validateChangeEvidence(data), /duplicate file coverage: routing\.ts declared by routing and routing-copy/);
});

test("keeps previously passing declarations passing", () => {
  const data = input();
  assert.equal(validateChangeEvidence(data), data.manifest);
  data.manifest.contracts[0].invariant = { exception: "Static docs-only example; no state transitions." };
  assert.equal(validateChangeEvidence(data), data.manifest);
  data.changedFiles.push("other.ts");
  data.manifest.contracts.push({ id: "other", requirement: "R02", files: ["other.ts"],
    boundary: "second boundary", assertions: "second assertions",
    boundaryTest: { exception: "no state" }, invariant: { exception: "no state" }, fault: { exception: "no state" } });
  assert.equal(validateChangeEvidence(data), data.manifest);
});

test("push events use the predecessor base and reject stale or wrong bases", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-push-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const eventPath = join(root, "push-event.json");
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "old"); git("add", "."); git("commit", "-qm", "base");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "routing.ts"), "new");
    const data = input(); data.manifest.base = revision;
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(data.manifest));
    git("add", "."); git("commit", "-qm", "candidate");
    const payload = { before: revision, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" };
    writeFileSync(eventPath, JSON.stringify(payload));
    const options = { root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } };
    assert.equal(changeEvidenceCase(options).status, "passed");

    const wrong = "b".repeat(40);
    writeFileSync(eventPath, JSON.stringify({ ...payload, before: wrong }));
    assert.equal(changeEvidenceCase({ ...options, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } }).status, "failed");

    writeFileSync(eventPath, JSON.stringify({ after: payload.after, ref: payload.ref }));
    assert.equal(changeEvidenceCase({ ...options, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } }).status, "failed");

    assert.equal(changeEvidenceCase({ ...options, env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(root, "missing") } }).status, "failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the missing-case assertion detects a disabled execution guard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-fault-"));
  const source = readFileSync(new URL("../scripts/acceptance/change-evidence.mjs", import.meta.url), "utf8");
  const guard = 'result?.type === "test:complete" && result.passed === true && !result.skipped && !result.todo';
  assert.equal(source.split(guard).length, 2, "fault anchor must be unique");
  const broken = { ...input(), testEvents: [] };
  const requireRejection = (validate) => assert.throws(() => validate(broken), /did not complete/);
  requireRejection(validateChangeEvidence);
  try {
    const copy = source.replace('"./core.mjs"', JSON.stringify(new URL("../scripts/acceptance/core.mjs", import.meta.url).href)).replace(guard, "true");
    const file = join(directory, "fault.mjs"); writeFileSync(file, copy);
    const mutant = await import(pathToFileURL(file).href);
    assert.throws(() => requireRejection(mutant.validateChangeEvidence), { code: "ERR_ASSERTION", message: /Missing expected exception/ });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.equal(readFileSync(new URL("../scripts/acceptance/change-evidence.mjs", import.meta.url), "utf8"), source);
  requireRejection(validateChangeEvidence);
});

test("event-driven push and pull request bases fail closed despite competing env", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-event-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const eventPath = join(root, "event.json");
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "old"); git("add", "."); git("commit", "-qm", "base");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "routing.ts"), "new");
    const data = input(); data.manifest.base = revision;
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(data.manifest));
    git("add", "."); git("commit", "-qm", "candidate");
    const competingEnv = { BIFROST_EVIDENCE_BASE: revision };

    writeFileSync(eventPath, JSON.stringify({ after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    assert.equal(changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, ...competingEnv } }).status, "failed");

    writeFileSync(eventPath, JSON.stringify({ before: null, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    assert.equal(changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, ...competingEnv } }).status, "failed");

    writeFileSync(eventPath, JSON.stringify({ before: "0".repeat(40), after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    assert.equal(changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, ...competingEnv } }).status, "failed");

    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: null } } }));
    assert.equal(changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, ...competingEnv } }).status, "failed");

    writeFileSync(eventPath, JSON.stringify({ pull_request: {} }));
    assert.equal(changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, ...competingEnv } }).status, "failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a real stale ancestor base fails declaration equality with named detail", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-stale-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const eventPath = join(root, "event.json");
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "v0"); git("add", "."); git("commit", "-qm", "base");
    const baseRevision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "notes.txt"), "note"); git("add", "."); git("commit", "-qm", "intermediate");
    const intermediateRevision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "routing.ts"), "v1"); git("add", "."); git("commit", "-qm", "candidate");

    const data = input(); data.manifest.base = baseRevision;
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(data.manifest));
    git("add", "change-evidence.json"); git("commit", "--amend", "-qm", "candidate");

    writeFileSync(eventPath, JSON.stringify({ before: intermediateRevision, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    const result = changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } });
    assert.equal(result.status, "failed");
    assert.match(result.detail, /missing, unsupported or stale declaration/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multi-commit push validates full event.before diff and rejects intermediate base", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-multi-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const eventPath = join(root, "event.json");
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "v0"); git("add", "."); git("commit", "-qm", "base");
    const baseRevision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "notes.txt"), "note"); git("add", "."); git("commit", "-qm", "intermediate");
    const intermediateRevision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "routing.ts"), "v1"); git("add", "."); git("commit", "-qm", "candidate");

    const manifest = {
      schemaVersion: 1,
      base: baseRevision,
      contracts: [
        { id: "routing", requirement: "R01", files: ["routing.ts", "notes.txt"],
          boundary: "real Pi with fake HTTP", assertions: "requested model is invoked; decoys are not",
          boundaryTest: { ...{ file: "tests/route.test.ts", name: "observes dispatch" } },
          invariant: { ...{ file: "tests/route.test.ts", name: "observes dispatch" } },
          fault: { ...{ file: "tests/route.test.ts", name: "observes dispatch" } } },
      ],
    };
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(manifest));
    git("add", "change-evidence.json"); git("commit", "--amend", "-qm", "candidate");

    const testEvents = [{ type: "test:complete", file: "tests/route.test.ts", name: "observes dispatch", passed: true }];

    writeFileSync(eventPath, JSON.stringify({ before: baseRevision, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    const passResult = changeEvidenceCase({ root, testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } });
    assert.equal(passResult.status, "passed");

    writeFileSync(eventPath, JSON.stringify({ before: intermediateRevision, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    const failResult = changeEvidenceCase({ root, testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } });
    assert.equal(failResult.status, "failed");
    assert.match(failResult.detail, /missing, unsupported or stale declaration/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow-derived push invocation succeeds without BIFROST_EVIDENCE_BASE", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-workflow-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const eventPath = join(root, "event.json");
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "old"); git("add", "."); git("commit", "-qm", "base");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "routing.ts"), "new");
    const data = input(); data.manifest.base = revision;
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(data.manifest));
    git("add", "."); git("commit", "-qm", "candidate");
    writeFileSync(eventPath, JSON.stringify({ before: revision, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));
    const result = changeEvidenceCase({ root, testEvents: data.testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } });
    assert.equal(result.status, "passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fault control: selecting HEAD parent instead of event.before turns push base RED", async () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-fault-push-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const eventPath = join(root, "event.json");
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "routing.ts"), "v0"); git("add", "."); git("commit", "-qm", "base");
    const baseRevision = git("rev-parse", "HEAD");
    writeFileSync(join(root, "notes.txt"), "note"); git("add", "."); git("commit", "-qm", "intermediate");
    writeFileSync(join(root, "routing.ts"), "v1"); git("add", "."); git("commit", "-qm", "candidate");

    const manifest = {
      schemaVersion: 1,
      base: baseRevision,
      contracts: [
        { id: "routing", requirement: "R01", files: ["routing.ts", "notes.txt"],
          boundary: "real Pi with fake HTTP", assertions: "requested model is invoked; decoys are not",
          boundaryTest: { file: "tests/route.test.ts", name: "observes dispatch" },
          invariant: { file: "tests/route.test.ts", name: "observes dispatch" },
          fault: { file: "tests/route.test.ts", name: "observes dispatch" } },
      ],
    };
    writeFileSync(join(root, "change-evidence.json"), JSON.stringify(manifest));
    git("add", "change-evidence.json"); git("commit", "--amend", "-qm", "candidate");

    const testEvents = [{ type: "test:complete", file: "tests/route.test.ts", name: "observes dispatch", passed: true }];
    writeFileSync(eventPath, JSON.stringify({ before: baseRevision, after: git("rev-parse", "HEAD"), ref: "refs/heads/v2" }));

    const options = { root, testEvents, env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath } };
    assert.equal(changeEvidenceCase(options).status, "passed");

    const source = readFileSync(new URL("../scripts/acceptance/change-evidence.mjs", import.meta.url), "utf8");
    const anchor = "event?.before";
    assert.equal(source.split(anchor).length, 2, "fault anchor must be unique");
    const directory = mkdtempSync(join(tmpdir(), "bifrost-change-evidence-fault-push-"));
    try {
      const copy = source.replace('"./core.mjs"', JSON.stringify(new URL("../scripts/acceptance/core.mjs", import.meta.url).href)).replace(anchor, 'git(root, ["rev-parse", "HEAD^"])');
      const file = join(directory, "fault-push.mjs"); writeFileSync(file, copy);
      const mutant = await import(pathToFileURL(file).href);
      const mutantResult = mutant.changeEvidenceCase(options);
      assert.equal(mutantResult.status, "failed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
    assert.equal(readFileSync(new URL("../scripts/acceptance/change-evidence.mjs", import.meta.url), "utf8"), source);
    assert.equal(changeEvidenceCase(options).status, "passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
