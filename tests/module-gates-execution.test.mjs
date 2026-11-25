// Issue #351: prove the real unit entrypoints execute module-owned tests, not
// just that their configuration strings mention a module glob. The tree below
// is a throwaway package with two fictitious capabilities; nothing is added to
// the checkout and no existing test is moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { collectFunctions, coverageFor, targetFiles } from "../scripts/crap-report.mjs";
import { NODE_TEST_GATES, nodeTestArgs } from "../scripts/acceptance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NAMED = ["root unit case", "alpha module case", "beta module case"];
const MODULES = [
  { capability: "alpha", suffix: "mjs", name: NAMED[1], factory: "alphaWidget" },
  { capability: "beta", suffix: "ts", name: NAMED[2], factory: "betaWidget" },
];

function fixtureTree(rootCount = 90) {
  // Canonicalize: the reporter and c8 both resolve tmpdir symlinks, so an
  // uncanonicalized root would make real file attribution look mismatched.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bifrost-module-gates-")));
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "module-gates-fixture", version: "1.0.0", type: "module", private: true,
    scripts: Object.fromEntries(["test", "test:coverage", "test:quick", "typecheck"]
      .map((name) => [name, manifest.scripts[name]])),
  }, null, 2));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const script of ["test-quick.mjs", "module-tests.mjs"]) {
    copyFileSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
  }
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, skipLibCheck: true, types: ["node"], allowImportingTsExtensions: true },
    include: ["*.ts", "tests/**/*.ts", "modules/**/*.ts"],
  }));
  mkdirSync(join(dir, "tests"), { recursive: true });
  // The quick canary requires at least 90 root test files; keep them trivial.
  for (let i = 0; i < rootCount; i += 1) {
    writeFileSync(join(dir, "tests", `root-${i}.test.mjs`), 'import { test } from "node:test"; test("filler", () => {});\n');
  }
  writeFileSync(join(dir, "tests", "named.test.mjs"), `import { test } from "node:test"; test("${NAMED[0]}", () => {});\n`);
  for (const { capability, suffix, name, factory } of MODULES) {
    const testsDir = join(dir, "modules", capability, "tests");
    mkdirSync(testsDir, { recursive: true });
    // Runtime source is imported by its module test, so c8 and CRAP must
    // attribute real coverage to the nested path.
    writeFileSync(join(dir, "modules", capability, "widget.ts"), `export function ${factory}(): number { return 1; }\n`);
    writeFileSync(join(testsDir, `case.test.${suffix}`), [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      `import { ${factory} } from "../widget.ts";`,
      `test("${name}", () => { assert.equal(${factory}(), 1); });`,
      "",
    ].join("\n"));
  }
  // An unimported sibling is still measured-tree inventory, but has no runtime
  // coverage: CRAP must score it as unmeasured rather than quietly crediting it.
  writeFileSync(join(dir, "modules", "alpha", "untested.ts"), "export function untested(): number { return 0; }\n");
  return dir;
}

function childEnv() {
  // Node skips test files when NODE_TEST_CONTEXT is inherited from an outer
  // `node --test`; the fixture must exercise the entrypoint as a standalone run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function run(dir, command, args) {
  const env = childEnv();
  // c8 defaults its temp directory to NODE_V8_COVERAGE. Point the fixture at
  // its own path so a child c8 cannot race the outer coverage run's temp dir.
  env.NODE_V8_COVERAGE = join(dir, "v8-coverage");
  return execFileSync(command, args, {
    cwd: dir, encoding: "utf8", timeout: 120_000, stdio: "pipe", env,
    // npm is npm.cmd on Windows; Node refuses .cmd without a shell. Args are
    // constants, so the shell adds no injection surface.
    shell: command === "npm" && process.platform === "win32",
  });
}

function assertNamedOnce(output, label) {
  for (const name of NAMED) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const matches = [...output.matchAll(new RegExp(`^✔\\s+[^\\n]*${escaped}`, "gmu"))];
    assert.equal(matches.length, 1, `${label}: ${name} must execute exactly once\n${output.slice(0, 2000)}`);
  }
}

test("full, coverage, quick and acceptance unit gates execute module tests exactly once", () => {
  const dir = fixtureTree();
  try {
    assertNamedOnce(run(dir, "npm", ["test", "--silent"]), "npm test");
    assertNamedOnce(run(dir, "npm", ["run", "test:coverage", "--silent"]), "npm run test:coverage");
    assert.ok(readFileSync(join(dir, "coverage", "coverage-final.json"), "utf8"), "c8 must write its JSON report");
    assertNamedOnce(run(dir, "npm", ["run", "test:quick", "--silent"]), "npm run test:quick");

    // Run the acceptance executor's real unit-gate argv and its real structured
    // reporter, not a copy of the configured paths.
    const reporterPath = join(ROOT, "scripts", "acceptance", "test-event-reporter.mjs");
    const gate = NODE_TEST_GATES.get("test");
    assert.ok(gate, "the acceptance unit gate must exist");
    const events = run(dir, process.execPath, nodeTestArgs({ gate, reporterPath }))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const expectedFiles = new Map([
      [NAMED[0], join(dir, "tests", "named.test.mjs")],
      ...MODULES.map(({ name, capability, suffix }) => [name, join(dir, "modules", capability, "tests", `case.test.${suffix}`)]),
    ]);
    for (const [name, file] of expectedFiles) {
      const completed = events.filter((event) => event.type === "test:complete" && event.name === name);
      assert.equal(completed.length, 1, `reporter: ${name} must complete exactly once`);
      assert.equal(completed[0].passed, true, `reporter: ${name} must pass`);
      assert.equal(completed[0].file, file, `reporter: ${name} must be attributed to its real file`);
    }

    // c8 must attribute the imported nested runtime, and CRAP must credit it
    // while treating the unimported sibling as unmeasured.
    const coverage = JSON.parse(readFileSync(join(dir, "coverage", "coverage-final.json"), "utf8"));
    for (const { capability } of MODULES) {
      const runtime = join(dir, "modules", capability, "widget.ts");
      const entry = coverage[runtime];
      assert.ok(entry, `c8 must record nested runtime coverage for ${capability}`);
      const [fn] = collectFunctions(readFileSync(runtime, "utf8"), runtime);
      assert.equal(coverageFor(entry, fn), 100, `CRAP must credit ${capability} runtime coverage`);
    }
    const unmeasured = join(dir, "modules", "alpha", "untested.ts");
    assert.ok(targetFiles([], dir).includes(unmeasured), "CRAP inventory must still measure the unimported sibling");
    assert.equal(coverage[unmeasured], undefined, "an unimported module file must not gain coverage");
    assert.equal(coverageFor(undefined, collectFunctions(readFileSync(unmeasured, "utf8"), unmeasured)[0]), null,
      "CRAP must treat an unmeasured nested file as unmeasured, not covered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the quick canary stays root-only when module files could compensate", () => {
  const dir = fixtureTree(5);
  try {
    const result = spawnSync("npm", ["run", "test:quick", "--silent"], { cwd: dir, encoding: "utf8", env: childEnv(), timeout: 120_000 });
    assert.notEqual(result.status, 0, "a deficient root tier must refuse to run");
    assert.match(result.stderr, /expected ~100 root test files, found 6/u,
      "the canary must count root files only, not root plus module files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
