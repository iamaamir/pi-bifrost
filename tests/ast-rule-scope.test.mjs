import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { fileMatchesGlob, ruleScopeFindings } from "../scripts/toolbox.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// ast-grep reports native separators; assertions compare repository-relative
// forward slashes, so the helper the scan test uses is normalized here.
const toPosix = (file) => file.replaceAll("\\", "/");
const binary = join(root, "node_modules", ".bin", process.platform === "win32" ? "ast-grep.cmd" : "ast-grep");

function ruleDirectories(config) {
  // `testConfigs` entries are `key: value`, so only bare list values are dirs.
  return [...config.matchAll(/^\s*-\s+([A-Za-z0-9_./-]+)\s*$/gmu)].map((match) => match[1]);
}

// A rule directory that is missing or empty disables every rule in it while
// leaving `ast-grep test` and the scope guard with nothing to complain about.
function ruleDirectoryProblems(config, baseDirectory) {
  const problems = [];
  for (const directory of ruleDirectories(config)) {
    const absolute = join(baseDirectory, directory);
    if (!existsSync(absolute)) {
      problems.push(`${directory} is missing`);
      continue;
    }
    if (!readdirSync(absolute).some((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
      problems.push(`${directory} holds no rules`);
    }
  }
  return problems;
}

// ast-grep's globset lets `*` cross directory separators; Node's matchesGlob
// does not. The guard must follow the scanner, or a nested-only tree reports an
// empty scope for a rule the scanner still applies.
test("the scope guard follows the scanner's glob semantics for nested files", () => {
  assert.equal(fileMatchesGlob("probe.ts", "*.ts"), true);
  assert.equal(fileMatchesGlob("src/probe.ts", "*.ts"), true);
  assert.equal(fileMatchesGlob("ui/panel.ts", "ui/**"), true);
  assert.equal(fileMatchesGlob("ui/panel.ts", "tests/**"), false);

  assert.deepEqual(ruleScopeFindings([{ id: "nested", files: ["*.ts"], ignores: [] }], ["src/probe.ts"]), []);
  assert.deepEqual(
    ruleScopeFindings([{ id: "nested", files: ["*.ts"], ignores: ["src/**"] }], ["src/probe.ts"]).map((finding) => finding.rule),
    ["ast-grep-empty-scope"],
  );
});

test("every configured ast-grep rule directory exists and holds rules", () => {
  const config = readFileSync(join(root, "sgconfig.yml"), "utf8");
  assert.equal(ruleDirectories(config).includes("rules"), true, "sgconfig must configure the rules dir");
  assert.deepEqual(ruleDirectoryProblems(config, root), []);
});

test("the rule-directory check reports a missing or empty configured directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-rule-dirs-"));
  try {
    mkdirSync(join(directory, "empty"));
    assert.deepEqual(ruleDirectories("ruleDirs:\n  - rules\ntestConfigs:\n  - testDir: rule-tests\n"), ["rules"],
      "testConfigs values must not be read as rule directories");
    assert.deepEqual(ruleDirectoryProblems("ruleDirs:\n  - empty\n  - missing\n", directory), ["empty holds no rules", "missing is missing"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("committed rule scopes separate module source from module-local tests", () => {
  const read = (name) => readFileSync(join(root, "rules", name), "utf8");
  const production = [
    "no-as-any-in-extension.yml", "no-debugger-in-extension.yml",
    "no-console-log-in-extension.yml", "no-process-exit-in-extension.yml",
  ];
  for (const name of production) {
    const source = read(name);
    assert.match(source, /^\s+- "modules\/\*\*\/tests\/\*\*"$/mu, `${name} must exclude module tests`);
  }
  assert.match(read("no-focused-or-skipped-test-typescript.yml"), /^\s+- "modules\/\*\*\/tests\/\*\.ts"$/mu);
  assert.match(read("no-focused-or-skipped-test-javascript.yml"), /^\s+- "modules\/\*\*\/tests\/\*\.mjs"$/mu);
});

// Best effort without a Windows host: run the exact helper the scan assertion
// uses, over paths built with the Windows separator. Only a real Windows CI leg
// can also prove ast-grep's own output shape there.
test("scanner paths normalize to forward slashes on Windows", () => {
  assert.equal(toPosix(win32.join("src", "probe.ts")), "src/probe.ts");
  assert.equal(toPosix(win32.join("tests", "nested", "probe.test.mjs")), "tests/nested/probe.test.mjs");
});

// self-tests cannot catch an inert scope. Only a real scan can.
test("committed ast-grep rules match their intended scope through the real scanner", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-ast-scope-"));
  try {
    cpSync(join(root, "rules"), join(dir, "rules"), { recursive: true });
    cpSync(join(root, "sgconfig.yml"), join(dir, "sgconfig.yml"));
    writeFileSync(
      join(dir, "probe.ts"),
      'export const bad = value as any;\ndebugger;\nconsole.log("x");\nprocess.exit(1);\n',
    );
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "probe.test.mjs"), 'test.skip("x", () => {});\n');
    writeFileSync(join(dir, "tests", "probe.test.ts"), 'test.skip("x", () => {});\n');
    mkdirSync(join(dir, "ui"));
    writeFileSync(join(dir, "ui", "probe.ts"), "export const bad = value as any;\n");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "probe.mjs"), 'console.log("x");\n');
    // Adopted capability fixtures: production source is scanned by production
    // rules; direct tests are scanned by test rules only; a nested fixture is
    // deliberately not an executable test.
    mkdirSync(join(dir, "modules", "alpha", "tests"), { recursive: true });
    writeFileSync(
      join(dir, "modules", "alpha", "widget.ts"),
      'export const bad = value as any;\ndebugger;\nconsole.log("x");\nprocess.exit(1);\n',
    );
    writeFileSync(join(dir, "modules", "alpha", "tests", "widget.test.ts"), 'export const bad = value as any;\ntest.skip("x", () => {});\n');
    mkdirSync(join(dir, "modules", "beta", "tests", "fixtures"), { recursive: true });
    writeFileSync(join(dir, "modules", "beta", "tests", "probe.test.mjs"), 'test.skip("x", () => {});\n');
    writeFileSync(join(dir, "modules", "beta", "tests", "fixtures", "helper.test.mjs"), 'test.skip("x", () => {});\n');

    const result = spawnSync(binary, ["scan", "--config", "sgconfig.yml", "--json"], {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const matches = JSON.parse(result.stdout);
    // ast-grep returns native separators on Windows; the assertions below are
    // repository-relative with forward slashes.
    const filesFor = (ruleId) =>
      matches
        .filter((match) => match.ruleId === ruleId)
        .map((match) => toPosix(match.file))
        .sort();

    for (const ruleId of [
      "no-as-any-in-extension",
      "no-debugger-in-extension",
      "no-console-log-in-extension",
      "no-process-exit-in-extension",
    ]) {
      assert.deepEqual(filesFor(ruleId), ["modules/alpha/widget.ts", "probe.ts"], `${ruleId} must scan root and module sources only`);
    }
    assert.deepEqual(filesFor("no-focused-or-skipped-test-typescript"), ["modules/alpha/tests/widget.test.ts", "tests/probe.test.ts"],
      "the TypeScript skipped-test rule must reach module-local tests and not nested fixtures");
    assert.deepEqual(filesFor("no-focused-or-skipped-test-javascript"), [
      "modules/beta/tests/fixtures/helper.test.mjs", "modules/beta/tests/probe.test.mjs", "tests/probe.test.mjs",
    ], "the JavaScript skipped-test rule must reach module-local test-suffix files; misplacement is rejected by the focused discovery test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
