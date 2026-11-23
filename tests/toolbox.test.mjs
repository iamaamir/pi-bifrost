import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKS,
  parseActionlint,
  parseAstGrep,
  parseDependencyCruiser,
  parseGitleaks,
  parseJscpd,
  parseKnip,
  parseOsv,
  parseRuleGlobs,
  parseTrackedFiles,
  parseSemgrep,
  ruleScopeFindings,
  runAstGrep,
  summarizeFindings,
  toolExecutable,
} from "../scripts/toolbox.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("projects dependency-cruiser violations with rule and edge", () => {
  const findings = parseDependencyCruiser(JSON.stringify({
    summary: { violations: [{ rule: { name: "no-circular" }, from: "routing.ts", to: "cache.ts" }] },
  }));
  assert.deepEqual(findings, [{ rule: "no-circular", file: "routing.ts", line: null, message: "routing.ts -> cache.ts" }]);
});

test("parses every Knip issue kind into one flat finding list", () => {
  const findings = parseKnip(JSON.stringify({
    issues: [{
      file: "package.json",
      devDependencies: [{ name: "left-pad", line: 4 }],
      unlisted: [{ name: "typebox", line: 47 }],
      files: [{ name: "unused.mjs" }],
      unresolved: [{ name: "missing-package" }],
      exports: [{ name: "internal" }],
    }],
  }));
  assert.deepEqual(findings.map((finding) => finding.rule).sort(), [
    "devDependencies",
    "exports",
    "files",
    "unlisted",
    "unresolved",
  ]);
  assert.equal(findings.find((finding) => finding.rule === "unlisted").message, "typebox");
});

test("never projects secret material from a Gitleaks report", () => {
  const secrets = ["sk-live-should-never-print", "eyJhbGciOiJIUzI1NiJ9.payload.signature"];
  const findings = parseGitleaks(JSON.stringify([{
    RuleID: "generic-api-key",
    File: "tests/fixture.ts",
    StartLine: 7,
    Description: "Generic API Key",
    Secret: secrets[0],
    Match: `token = "${secrets[1]}"`,
  }]));
  const serialized = JSON.stringify(findings);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(findings, [{
    rule: "generic-api-key",
    file: "tests/fixture.ts",
    line: 7,
    message: "Generic API Key",
  }]);
});

test("parses ast-grep, Semgrep, actionlint, and OSV output shapes", () => {
  assert.deepEqual(parseAstGrep(JSON.stringify([{
    ruleId: "no-console-log-in-extension",
    file: "index.ts",
    range: { start: { line: 9 } },
    message: "no console.log",
  }])), [{ rule: "no-console-log-in-extension", file: "index.ts", line: 10, message: "no console.log" }]);
  assert.deepEqual(parseSemgrep(JSON.stringify({
    results: [{ check_id: "bifrost-no-eval", path: "router.ts", start: { line: 3 }, extra: { message: "eval" } }],
  })), [{ rule: "bifrost-no-eval", file: "router.ts", line: 3, message: "eval" }]);
  assert.deepEqual(parseActionlint("verification.yml:12:9: property \"nope\" is not defined [syntax-check]"), [
    { rule: "syntax-check", file: "verification.yml", line: 12, message: "property \"nope\" is not defined" },
  ]);
  assert.deepEqual(parseOsv(JSON.stringify({
    results: [{ source: { path: "package-lock.json" }, packages: [{ package: { name: "pkg", version: "1.0.0" }, vulnerabilities: [{ id: "GHSA-1" }] }] }],
  })), [{ rule: "GHSA-1", file: "package-lock.json", line: null, message: "pkg@1.0.0:" }]);
});

test("parses rule file globs from block and inline lists", () => {
  assert.deepEqual(parseRuleGlobs('files:\n  - "*.ts"\nignores:\n  - "tests/**"\n'), {
    files: ["*.ts"],
    ignores: ["tests/**"],
  });
  assert.deepEqual(parseRuleGlobs("files: ['tests/**/*.mjs', 'tests/**/*.js']\n"), {
    files: ["tests/**/*.mjs", "tests/**/*.js"],
    ignores: [],
  });
  assert.deepEqual(
    parseRuleGlobs("ignores: ['tests/**']\n"),
    { files: null, ignores: ["tests/**"] },
    "an absent files key must stay distinct from an empty list",
  );
  assert.deepEqual(parseRuleGlobs("files: []\n"), { files: [], ignores: [] });
});

test("fails closed on rule scope shapes the reader cannot trust or honour", () => {
  const files = ["a.ts", "src/b.ts", "tests/a.test.mjs"];
  const forms = [
    ["anchor", "files: *ext\n", "unrecognized files:/ignores: shape"],
    ["flow-comment", 'files: ["tests/**"] # comment\n', "unrecognized files:/ignores: shape"],
    ["scalar", 'files: "*.ts"\n', "unrecognized files:/ignores: shape"],
    ["nested", 'files:\n  - "*.ts"\nrule:\n  files:\n    - "*.js"\n', "nested files:/ignores: key"],
    ["item-comment", 'files:\n  - "*.ts" # comment\n', "trailing comment on scope item"],
    ["brace", 'files: ["{src,tests}/**"]\n', "brace or character-class glob"],
    ["character-class", 'files: ["[ab].ts"]\n', "brace or character-class glob"],
    ["ignore-mapping", 'ignores:\n  - glob: "**"\n', "mapping item in scope list"],
    ["space-before-colon", "files : []\n", "unrecognized files:/ignores: key representation"],
    ["quoted-key", '"files": []\n', "unrecognized files:/ignores: key representation"],
  ];
  for (const [id, source, reason] of forms) {
    const parsed = parseRuleGlobs(source);
    assert.ok(parsed.unverified, `${id} must be marked unverifiable`);
    const findings = ruleScopeFindings([{ id, ...parsed }], files);
    assert.deepEqual(findings.map((finding) => finding.rule), ["ast-grep-scope-unverified"], id);
    assert.equal(findings[0].file, `rules/${id}.yml`);
    assert.ok(findings[0].message.includes(reason), `${id}: ${findings[0].message}`);
  }

  const readable = parseRuleGlobs('files: ["*.ts"]\n');
  assert.equal(readable.unverified, undefined);
  assert.deepEqual(ruleScopeFindings([{ id: "readable", ...readable }], files), []);
});

test("reads NUL-separated tracked file names without git quoting", () => {
  assert.deepEqual(parseTrackedFiles("caf\u00e9.ts\0docs/a b.md\0"), ["caf\u00e9.ts", "docs/a b.md"]);
  assert.deepEqual(parseTrackedFiles(""), []);
});

test("flags ast-grep rules whose scope matches no repository file", () => {
  const files = ["index.ts", "tests/a.test.mjs", "ui/panel.ts", "scripts/tool.mjs"];
  const rules = [
    { id: "root-only", files: ["*.ts"], ignores: ["tests/**", "ui/**", "scripts/**"] },
    { id: "tests-only", files: ["tests/**/*.mjs"], ignores: [] },
    { id: "no-files-key", files: null, ignores: [] },
    { id: "empty-files", files: [], ignores: [] },
    { id: "inert", files: ["/*.ts"], ignores: [] },
  ];
  const findings = ruleScopeFindings(rules, files);
  assert.deepEqual(
    findings.map((finding) => finding.file),
    ["rules/empty-files.yml", "rules/inert.yml"],
    "an absent files key is unrestricted; an empty one matches nothing",
  );
  assert.ok(findings.every((finding) => finding.rule === "ast-grep-empty-scope"));
  assert.match(findings[1].message, /matches no repository files/);
});

test("fails ast checks when the tracked file list cannot verify rule scope", () => {
  const rules = [{ id: "root-only", files: ["*.ts"], ignores: ["tests/**"] }];
  assert.equal(ruleScopeFindings(rules, [])[0].rule, "ast-grep-scope-unverified");
  assert.equal(ruleScopeFindings(rules, null)[0].rule, "ast-grep-scope-unverified");
  assert.match(ruleScopeFindings(rules, null)[0].message, /git ls-files failed/);

  const result = runAstGrep(
    () => ({ missing: false, status: 0, stdout: "", stderr: "" }),
    { rules, files: [] },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.findings.map((f) => f.rule), ["ast-grep-scope-unverified"]);
});

test("fails ast checks when scan exits without findings", () => {
  let calls = 0;
  const result = runAstGrep(() => {
    calls += 1;
    return calls === 1
      ? { missing: false, status: 0, stdout: "", stderr: "" }
      : { missing: false, status: 1, stdout: "", stderr: "scan crashed" };
  });
  assert.equal(result.status, 1);
  assert.deepEqual(result.findings, []);
  assert.match(result.stderr, /scan crashed/);
});

test("parses jscpd reports and enforces the ratcheted duplication threshold", () => {
  // The threshold is explicit: this test covers the parser, not the committed
  // budget, so a budget change must not require editing it. The committed value
  // is asserted in tests/duplication-audit.test.mjs.
  const budget = 5.5;
  const below = JSON.stringify({ statistics: { total: { percentage: 5.49, duplicatedLines: 100, lines: 1669, clones: 10 } } });
  const at = JSON.stringify({ statistics: { total: { percentage: 5.5, duplicatedLines: 102, lines: 1700, clones: 11 } } });
  const above = JSON.stringify({ statistics: { total: { percentage: 5.51, duplicatedLines: 103, lines: 1713, clones: 12 } } });
  assert.deepEqual(parseJscpd(below, budget), []);
  assert.deepEqual(parseJscpd(at, budget), []);
  const findings = parseJscpd(above, budget);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "duplication-threshold");
  assert.equal(findings[0].file, ".jscpd.json");
  assert.equal(findings[0].line, null);
  assert.match(findings[0].message, /5\.51% duplicated lines \(103\/1713\) over 5\.5% threshold; clones=12/);
});

test("wires the duplication check to a deterministic jscpd report path and failure result", () => {
  const temp = join(tmpdir(), "bifrost-jscpd-contract");
  const plan = CHECKS.duplication.command(temp);
  assert.deepEqual(plan.args, [".", "--config", ".jscpd.json", "--reporters", "json", "--output", temp]);
  assert.equal(CHECKS.duplication.fileReport, true);

  const reportPath = join(temp, "jscpd-report.json");
  mkdirSync(temp, { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ statistics: { total: { percentage: 7.25, duplicatedLines: 29, lines: 400, clones: 3 } } }));
  // Pin the threshold in the fixture root instead of inheriting the committed
  // one: a legal budget change must not break this wiring test, which asserts
  // that the report is read from the planned path and turned into a finding.
  writeFileSync(join(temp, ".jscpd.json"), JSON.stringify({ threshold: 5.5 }));
  const findings = CHECKS.duplication.parse(plan.read(), temp);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "duplication-threshold");
  assert.match(findings[0].message, /7\.25%/);
});

test("the committed ast-grep rules pass their own valid and invalid fixtures", () => {
  const binary = join(root, "node_modules", ".bin", process.platform === "win32" ? "ast-grep.cmd" : "ast-grep");
  const result = spawnSync(binary, ["test", "--skip-snapshot-tests"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\d+ passed; 0 failed/);
});

test("uses npm command shims and native executables on Windows", () => {
  assert.equal(toolExecutable("knip", "win32"), "knip.cmd");
  assert.equal(toolExecutable("actionlint", "win32"), "actionlint.exe");
  assert.equal(toolExecutable("knip", "linux"), "knip");
});

test("summarizes findings by descending count then rule name", () => {
  assert.equal(summarizeFindings([
    { rule: "b", file: "x" },
    { rule: "a", file: "x" },
    { rule: "b", file: "y" },
  ]), "b (2), a (1)");
});

function cruiseFixture(files, { mutateConfig } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-arch-fixture-"));
  mkdirSync(join(directory, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
  writeFileSync(join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "1.0.1",
    type: "module",
    main: "index.js",
  }));
  writeFileSync(join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "index.js"), "export const marker = 1;\n");
  for (const dependency of ["typescript", "dependency-cruiser"]) {
    symlinkSync(join(root, "node_modules", dependency), join(directory, "node_modules", dependency), "dir");
  }
  // package.json classifies resolved packages as production or dev, which the
  // production-no-dev-dependency rule depends on.
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "bifrost-arch-fixture",
    version: "0.0.0",
    type: "module",
    dependencies: {},
    devDependencies: { typescript: "*", "dependency-cruiser": "*" },
  }));
  for (const [name, source] of Object.entries(files)) {
    const target = join(directory, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  const config = readFileSync(join(root, ".dependency-cruiser.cjs"), "utf8");
  const source = mutateConfig ? mutateConfig(config) : config;
  writeFileSync(join(directory, "depcruise.cjs"), source);
  const result = spawnSync(process.execPath, [
    join(root, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs"),
    "--config", join(directory, "depcruise.cjs"),
    "--output-type", "json",
    ...Object.keys(files),
  ], { cwd: directory, encoding: "utf8" });
  const stdout = result.stdout.trim();
  assert.notEqual(stdout, "", `dependency-cruiser produced no JSON: ${result.stderr}`);
  return parseDependencyCruiser(stdout);
}

test("rejects a runtime host-SDK import in the resolve-only router and accepts the type-only form", () => {
  const runtime = cruiseFixture({ "router.ts": 'import { marker } from "@earendil-works/pi-coding-agent";\nexport const value = marker;\n' });
  assert.deepEqual(runtime.map((finding) => finding.rule), ["router-no-runtime-host-sdk"]);

  const typeOnly = cruiseFixture({ "router.ts": 'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\nexport type Context = ExtensionContext;\n' });
  assert.deepEqual(typeOnly, []);
});

// Each committed rule must reject a minimal fixture on its own. A rule whose
// patterns stop matching the tree would otherwise pass CI while enforcing
// nothing, which is the inertness this issue exists to remove.
test("every committed boundary rule fires on a minimal violating fixture", () => {
  const cases = [
    ["no-circular", {
      "a.ts": 'import { b } from "./b";\nexport const a = b;\n',
      "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
    }],
    ["router-no-runtime-host-sdk", {
      "router.ts": 'import { marker } from "@earendil-works/pi-coding-agent";\nexport const value = marker;\n',
    }],
    ["router-no-host-adapters", {
      "router.ts": 'import { cost } from "./ui/cost-view";\nexport const value = cost;\n',
      "ui/cost-view.ts": "export const cost = 1;\n",
    }],
    ["host-ui-imports-only-from-adapter-entry", {
      "policy.ts": 'import { status } from "./ux-status";\nexport const value = status;\n',
      "ux-status.ts": "export const status = 1;\n",
    }],
    ["production-no-dev-dependency", {
      "router.ts": 'import { version } from "typescript";\nexport const value = version;\n',
    }],
    ["production-no-repository-tooling", {
      "router.ts": 'import { probe } from "./scripts/probe.mjs";\nexport const value = probe;\n',
      "scripts/probe.mjs": "export const probe = 1;\n",
    }],
    ["no-unresolvable", {
      "router.ts": 'import { missing } from "./missing";\nexport const value = missing;\n',
    }],
  ];
  const fired = [];
  for (const [rule, files] of cases) {
    const names = [...new Set(cruiseFixture(files).map((finding) => finding.rule))];
    assert.deepEqual(names, [rule], `${rule} must fire alone on its fixture`);
    fired.push(rule);
  }

  const config = readFileSync(join(root, ".dependency-cruiser.cjs"), "utf8");
  const configured = [...config.matchAll(/^\s*name:\s*"([a-z-]+)",$/gmu)].map((match) => match[1]);
  assert.deepEqual(fired.sort(), configured.sort(),
    "every configured rule needs a firing fixture, and every fixture needs a configured rule");
});

test("the type-only allowance is load-bearing: removing it turns the passing fixture red", () => {
  const mutated = cruiseFixture(
    { "router.ts": 'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\nexport type Context = ExtensionContext;\n' },
    {
      mutateConfig: (config) => {
        const anchor = 'dependencyTypesNot: ["type-only"],';
        assert.equal(config.split(anchor).length, 2, "fault anchor must be unique");
        return config.replace(anchor, "");
      },
    },
  );
  assert.deepEqual(mutated.map((finding) => finding.rule), ["router-no-runtime-host-sdk"]);
});

test("reports unavailable tools with install hints instead of a false pass", () => {
  const env = { PATH: join(tmpdir(), "bifrost-empty-path") };
  const doctorRun = spawnSync(process.execPath, [join(root, "scripts", "toolbox.mjs"), "doctor", "--json"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(doctorRun.status, 0, doctorRun.stderr);
  const report = JSON.parse(doctorRun.stdout);
  assert.equal(report.tools.length > 5, true);
  for (const tool of report.tools) {
    assert.equal(["available", "missing"].includes(tool.status), true);
    assert.equal(typeof tool.install, "string");
    assert.equal(tool.install.length > 0, true);
  }

  const unavailable = spawnSync(process.execPath, [join(root, "scripts", "toolbox.mjs"), "actions"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(unavailable.status, 2);
  assert.match(unavailable.stderr, /UNAVAILABLE actions: actionlint is not installed/);
  assert.match(unavailable.stderr, /go install github\.com\/rhysd\/actionlint/);

  const unknown = spawnSync(process.execPath, [join(root, "scripts", "toolbox.mjs"), "not-a-check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown check: not-a-check/);
});
