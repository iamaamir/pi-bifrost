// Issue #351: prove the real unit entrypoints execute module-owned tests, not
// just that their configuration strings mention a module glob. The tree below
// is a throwaway package with two fictitious capabilities; nothing is added to
// the checkout and no existing test is moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NAMED = ["root unit case", "alpha module case", "beta module case"];

function fixtureTree(rootCount = 90) {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-module-gates-"));
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
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, skipLibCheck: true, types: ["node"] },
    include: ["*.ts", "tests/**/*.ts", "modules/**/*.ts"],
  }));
  mkdirSync(join(dir, "tests"), { recursive: true });
  // The quick canary requires at least 90 root test files; keep them trivial.
  for (let i = 0; i < rootCount; i += 1) {
    writeFileSync(join(dir, "tests", `root-${i}.test.mjs`), 'import { test } from "node:test"; test("filler", () => {});\n');
  }
  writeFileSync(join(dir, "tests", "named.test.mjs"), `import { test } from "node:test"; test("${NAMED[0]}", () => {});\n`);
  for (const [capability, suffix, name] of [["alpha", "mjs", NAMED[1]], ["beta", "ts", NAMED[2]]]) {
    const testsDir = join(dir, "modules", capability, "tests");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(testsDir, `case.test.${suffix}`), `import { test } from "node:test"; test("${name}", () => {});\n`);
  }
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
  return execFileSync(command, args, { cwd: dir, encoding: "utf8", timeout: 120_000, stdio: "pipe", env });
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

    // Execute the gate paths actually configured in scripts/acceptance.mjs.
    const source = readFileSync(join(ROOT, "scripts", "acceptance.mjs"), "utf8");
    const gate = source.match(/\["test", \{ paths: \[([\s\S]*?)\] \}\]/u);
    assert.ok(gate, "the acceptance unit gate must exist");
    const paths = [...gate[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    assertNamedOnce(run(dir, process.execPath, ["--test", "--experimental-strip-types", ...paths]), "acceptance unit gate paths");
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
