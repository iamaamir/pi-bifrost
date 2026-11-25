// Issue #351: nested capability tests must join every unit gate without moving
// root tests or inventing a registry. The fixtures below are throwaway trees;
// no production capability is added to the checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const MODULE_HELPER = new URL("../scripts/module-tests.mjs", import.meta.url);
const moduleHelper = await import(MODULE_HELPER.href);

function fixture(build) {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-module-discovery-"));
  try {
    build(dir);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function put(dir, rel, body = "// fixture\n") {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

/** Load a copy of the discovery helper with one source fault applied. */
async function faultyHelper(dir, fault) {
  const source = readFileSync(MODULE_HELPER, "utf8");
  const changed = fault(source);
  assert.notEqual(changed, source, "the source fault must actually change the helper");
  const copy = join(dir, "scripts", "module-tests.mjs");
  mkdirSync(join(copy, ".."), { recursive: true });
  writeFileSync(copy, changed);
  return import(pathToFileURL(copy).href);
}

test("moduleTestFiles discovers two fictitious capabilities by path, not by name", async () => {
  const { moduleTestFiles } = await import(MODULE_HELPER.href);
  const dir = fixture((root) => {
    put(root, "modules/alpha/tests/checks.test.mjs");
    put(root, "modules/beta/tests/cases.test.ts");
    // A second file proves both suffixes join; a directory that merely looks
    // like a test is not executable; nested helpers must not execute as tests.
    put(root, "modules/alpha/tests/more.test.ts");
    put(root, "modules/beta/tests/helpers/helper.test.mjs");
    mkdirSync(join(root, "modules/gamma/tests/widget.test.ts"), { recursive: true });
    put(root, "modules/beta/README.md");
  });
  try {
    assert.deepEqual(moduleTestFiles(dir), [
      "modules/alpha/tests/checks.test.mjs",
      "modules/alpha/tests/more.test.ts",
      "modules/beta/tests/cases.test.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moduleTestFiles returns nothing when modules/ is absent", async () => {
  const { moduleTestFiles } = await import(MODULE_HELPER.href);
  const dir = fixture(() => {});
  try {
    assert.deepEqual(moduleTestFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fault control: dropping the tests-directory walk loses every module test", async () => {
  const dir = fixture((root) => {
    put(root, "modules/alpha/tests/checks.test.mjs");
    put(root, "modules/beta/tests/cases.test.ts");
  });
  try {
    const { moduleTestFiles } = await faultyHelper(dir, (source) =>
      source.replace('const testsDir = join(root, "modules", capability.name, "tests");', 'const testsDir = join(root, "modules", capability.name, "not-tests");'));
    assert.deepEqual(moduleTestFiles(dir), [], "the faulted helper must stop discovering module tests");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moduleSourceFiles excludes misplaced test-suffix files and every tests subtree", () => {
  const { moduleSourceFiles } = moduleHelper;
  const dir = fixture((root) => {
    put(root, "modules/alpha/widget.ts");
    put(root, "modules/alpha/types.d.ts");
    put(root, "modules/alpha/widget.test.ts");
    put(root, "modules/alpha/internal/tests/helper.ts");
    put(root, "modules/alpha/tests/case.test.mjs");
    put(root, "modules/beta/thing.ts");
  });
  try {
    assert.deepEqual(moduleSourceFiles(dir), ["modules/alpha/widget.ts", "modules/beta/thing.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("misplaced test-suffix paths are rejected while legitimate locations are accepted", async () => {
  const { isExecutableTest } = await import(MODULE_HELPER.href);
  for (const path of [
    "tests/routing.test.ts",
    "tests/acceptance-runner.test.mjs",
    "tests/integration/native-classifier.test.mjs",
    "modules/alpha/tests/checks.test.mjs",
    "modules/beta/tests/cases.test.ts",
  ]) {
    assert.equal(isExecutableTest(path), true, `${path} is an executable unit test`);
  }
  for (const path of [
    "modules/alpha/widget.test.ts",
    "modules/alpha/tests/helpers/helper.test.mjs",
    "modules/alpha/tests/fixtures/deep/case.test.ts",
    "modules/alpha/tests/README.md",
    "rules/test.yml",
  ]) {
    assert.equal(isExecutableTest(path), false, `${path} is misplaced or not a test`);
  }
  assert.equal(isExecutableTest("modules\\alpha\\tests\\checks.test.mjs"), true, "Windows separators normalize");
});

test("executable-test classification matches what the gate globs actually run", async () => {
  const { moduleTestFiles, isExecutableTest, misplacedTestFiles } = moduleHelper;
  const dir = fixture((root) => {
    put(root, "modules/alpha/tests/checks.test.mjs");
    // The gate globs skip dot-prefixed path segments, so neither of these runs.
    put(root, "modules/.experimental/tests/case.test.mjs");
    put(root, "modules/alpha/tests/.dot.test.mjs");
  });
  try {
    assert.deepEqual(moduleTestFiles(dir), ["modules/alpha/tests/checks.test.mjs"],
      "discovery must not advertise a file the gate globs cannot reach");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const unrunnable = ["modules/.experimental/tests/case.test.mjs", "modules/alpha/tests/.dot.test.mjs"];
  for (const path of unrunnable) {
    assert.equal(isExecutableTest(path), false, `${path} is not reachable by any reserved gate glob`);
  }
  assert.deepEqual(misplacedTestFiles(unrunnable), unrunnable, "a test that cannot run must be rejected, not accepted");
});

test("every test-suffix file in the repository inventory sits in a reserved location", () => {
  const { misplacedTestFiles } = moduleHelper;
  // The real inventory, not a path example: an untracked file must fail locally
  // before review, and a tracked one must fail CI.
  const inventory = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT, encoding: "utf8",
  }).split("\0").filter(Boolean);
  const tests = inventory.filter((path) => /\.test\.(?:ts|mjs)$/u.test(path));
  assert.ok(tests.length > 100, `the inventory must enumerate the existing suite, found ${tests.length}`);
  assert.deepEqual(misplacedTestFiles(tests), [], "every test-suffix file must be runnable by a reserved gate glob");
  assert.deepEqual(misplacedTestFiles([
    "tests/routing.test.ts",
    "modules/alpha/tests/case.test.ts",
    "modules/alpha/widget.test.ts",
    "modules/alpha/tests/fixtures/deep/case.test.ts",
  ]), ["modules/alpha/widget.test.ts", "modules/alpha/tests/fixtures/deep/case.test.ts"],
  "the same rejection must go red for a misplaced inventory entry");
});

test("full, coverage, quick, and acceptance unit gates all include module tests", async () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  for (const script of ["test", "test:coverage"]) {
    assert.match(pkg.scripts[script], /modules\/\*\/tests\/\*\.test\.ts/u, `${script} must include TS module tests`);
    assert.match(pkg.scripts[script], /modules\/\*\/tests\/\*\.test\.mjs/u, `${script} must include MJS module tests`);
  }
  assert.match(pkg.scripts["test:integration"], /^node --test --experimental-strip-types tests\/integration\/\*\.test\.mjs$/u,
    "integration selection stays separate");

  const quick = readFileSync(new URL("scripts/test-quick.mjs", ROOT), "utf8");
  assert.match(quick, /moduleTestFiles/u, "quick tier must enumerate module tests");
  assert.match(quick, /rootFiles\.length < 90/u, "the root-only canary must remain");
  assert.match(quick, /const HEAVY = new Set\(\[/u, "heavy root exclusions must remain");

  // Assert the executor's real gate definition rather than scraping its source;
  // tests/module-gates-execution.test.mjs then runs the identical argv.
  const { NODE_TEST_GATES } = await import(new URL("scripts/acceptance.mjs", ROOT).href);
  const unit = NODE_TEST_GATES.get("test");
  assert.ok(unit, "the acceptance unit gate must exist");
  assert.ok(unit.paths.includes("modules/*/tests/*.test.ts"));
  assert.ok(unit.paths.includes("modules/*/tests/*.test.mjs"));
  assert.deepEqual(NODE_TEST_GATES.get("test:integration").paths, ["tests/integration/*.test.mjs"],
    "the integration gate must stay separate");
});
