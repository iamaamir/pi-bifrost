import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const fixtures = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createReleaseFixture(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "bifrost-release-cli-"));
  fixtures.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  mkdirSync(scripts);
  mkdirSync(bin);
  mkdirSync(join(root, ".git"));
  copyFileSync(new URL("../scripts/release.mjs", import.meta.url), join(scripts, "release.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.2.3" }, null, 2) + "\n");

  for (const tool of ["git", "npm"]) {
    const stub = join(bin, tool);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s %s\\n' '${tool}' "$*" >> "$RECORD_LOG"\nif [ '${tool}' = npm ] && [ "$*" = "$FAIL_NPM_COMMAND" ]; then exit 1; fi\n`);
    chmodSync(stub, 0o755);
  }
  const log = join(root, "commands.log");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECORD_LOG: log, ...extraEnv };
  const runAt = (script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });
  const run = (...args) => runAt(join(scripts, "release.mjs"), ...args);
  return {
    root,
    log,
    run,
    runAt,
    packageText: () => readFileSync(join(root, "package.json"), "utf8"),
    commands: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe("release CLI side effects", () => {
  it("rejects unknown options before invoking Git or npm", () => {
    const fixture = createReleaseFixture();
    const before = fixture.packageText();
    const result = fixture.run("--dry-run", "--surprise");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown argument: --surprise/);
    assert.equal(fixture.packageText(), before);
    assert.throws(() => readFileSync(fixture.log, "utf8"), { code: "ENOENT" });
  });

  it("supports bare --dry-run without changing files or recording release writes", () => {
    const fixture = createReleaseFixture();
    const before = fixture.packageText();
    const result = fixture.run("--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.packageText(), before);
    assert.deepEqual(fixture.commands(), [
      "git status --porcelain",
      "npm test",
      "npm run typecheck",
      "npm run test:integration",
    ]);
  });

  it("rejects a missing or option-looking version before release commands", () => {
    for (const args of [
      ["--version"],
      ["--version", "--dry-run"],
      ["--version", "invalid"],
      ["--version", "01.2.3"],
      ["--publish", "--version", "--dry-run"],
    ]) {
      const fixture = createReleaseFixture();
      const before = fixture.packageText();
      const result = fixture.run(...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /--version requires/);
      assert.equal(fixture.packageText(), before);
      assert.throws(() => readFileSync(fixture.log, "utf8"), { code: "ENOENT" });
    }
  });

  it("validates all arguments before honoring help", () => {
    for (const args of [["--help", "--surprise"], ["--help", "--version"]]) {
      const fixture = createReleaseFixture();
      const result = fixture.run(...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.throws(() => readFileSync(fixture.log, "utf8"), { code: "ENOENT" });
    }
  });

  it("dry-runs with --publish in either option order without release writes", () => {
    for (const args of [
      ["--version", "1.2.4", "--dry-run", "--publish"],
      ["--dry-run", "--publish", "--version", "1.2.4"],
      ["--publish", "--version", "1.2.4", "--dry-run"],
    ]) {
      const fixture = createReleaseFixture();
      const before = fixture.packageText();
      const result = fixture.run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Dry run: would update package.json/);
      assert.equal(fixture.packageText(), before);
      assert.deepEqual(fixture.commands(), [
        "git status --porcelain",
        "npm test",
        "npm run typecheck",
        "npm run test:integration",
      ]);
    }
  });

  it("runs the dry-run entry point through a symlink and records no release writes", () => {
    const fixture = createReleaseFixture();
    const before = fixture.packageText();
    const alias = join(fixture.root, "release-link.mjs");
    symlinkSync(join(fixture.root, "scripts", "release.mjs"), alias);
    const result = fixture.runAt(alias, "--dry-run", "--publish");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: would update package.json/);
    assert.equal(fixture.packageText(), before);
    assert.deepEqual(fixture.commands(), [
      "git status --porcelain",
      "npm test",
      "npm run typecheck",
      "npm run test:integration",
    ]);
  });

  it("keeps the normal publish path intact under recording stubs", () => {
    const fixture = createReleaseFixture();
    const result = fixture.run("--version", "1.2.4", "--publish");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fixture.packageText()).version, "1.2.4");
    assert.deepEqual(fixture.commands(), [
      "git status --porcelain",
      "npm test",
      "npm run typecheck",
      "npm run test:integration",
      "git add package.json",
      "git commit -m chore: release v1.2.4",
      "git tag -a v1.2.4 -m Release v1.2.4",
      "git push origin HEAD",
      "git push origin v1.2.4",
      "npm publish",
    ]);
  });

  it("stops after a failed check before version or release writes", () => {
    const fixture = createReleaseFixture({ FAIL_NPM_COMMAND: "test" });
    const before = fixture.packageText();
    const result = fixture.run("--dry-run");
    assert.notEqual(result.status, 0);
    assert.equal(fixture.packageText(), before);
    assert.deepEqual(fixture.commands(), ["git status --porcelain", "npm test"]);
  });
});
