import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseActionlint,
  parseAstGrep,
  parseDependencyCruiser,
  parseGitleaks,
  parseKnip,
  parseOsv,
  parseSemgrep,
  summarizeFindings,
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

test("the committed ast-grep rules pass their own valid and invalid fixtures", () => {
  const binary = join(root, "node_modules", ".bin", process.platform === "win32" ? "ast-grep.cmd" : "ast-grep");
  const result = spawnSync(binary, ["test", "--skip-snapshot-tests"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /4 passed; 0 failed/);
});

test("summarizes findings by descending count then rule name", () => {
  assert.equal(summarizeFindings([
    { rule: "b", file: "x" },
    { rule: "a", file: "x" },
    { rule: "b", file: "y" },
  ]), "b (2), a (1)");
});

function cruiseFixture(routerSource, { mutateConfig } = {}) {
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
  writeFileSync(join(directory, "router.ts"), routerSource);
  const config = readFileSync(join(root, ".dependency-cruiser.cjs"), "utf8");
  const source = mutateConfig ? mutateConfig(config) : config;
  writeFileSync(join(directory, "depcruise.cjs"), source);
  const result = spawnSync(process.execPath, [
    join(root, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs"),
    "--config", join(directory, "depcruise.cjs"),
    "--output-type", "json",
    "router.ts",
  ], { cwd: directory, encoding: "utf8" });
  const stdout = result.stdout.trim();
  assert.notEqual(stdout, "", `dependency-cruiser produced no JSON: ${result.stderr}`);
  return parseDependencyCruiser(stdout);
}

test("rejects a runtime host-SDK import in the resolve-only router and accepts the type-only form", () => {
  const runtime = cruiseFixture('import { marker } from "@earendil-works/pi-coding-agent";\nexport const value = marker;\n');
  assert.deepEqual(runtime.map((finding) => finding.rule), ["router-no-runtime-host-sdk"]);

  const typeOnly = cruiseFixture('import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\nexport type Context = ExtensionContext;\n');
  assert.deepEqual(typeOnly, []);
});

test("the type-only allowance is load-bearing: removing it turns the passing fixture red", () => {
  const mutated = cruiseFixture(
    'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\nexport type Context = ExtensionContext;\n',
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
