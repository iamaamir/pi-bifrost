import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS } from "../scripts/toolbox.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const knipSource = readFileSync(join(root, "knip.jsonc"), "utf8");
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const workflowDirectory = join(root, ".github", "workflows");
const workflows = readdirSync(workflowDirectory)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(workflowDirectory, name), "utf8") }));

function stepBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let current = null;
  let indent = 0;
  for (const line of lines) {
    const match = /^(\s*)- (.+)$/.exec(line);
    if (match && (current === null || match[1].length <= indent)) {
      if (current) blocks.push(current);
      indent = match[1].length;
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function unpinnedActions(source) {
  const findings = [];
  for (const line of source.split("\n")) {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#.*)?\s*$/.exec(line);
    if (!match) continue;
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    const at = reference.lastIndexOf("@");
    const ref = at === -1 ? "" : reference.slice(at + 1);
    if (!/^[a-f0-9]{40}$/.test(ref)) findings.push(reference);
  }
  return findings;
}

function checkoutsWithoutCredentialIsolation(source) {
  return stepBlocks(source)
    .filter((block) => block.some((line) => /uses:\s*actions\/checkout@/.test(line)))
    .filter((block) => !block.some((line) => /^\s*persist-credentials:\s*false\s*$/.test(line)))
    .map((block) => block.find((line) => /uses:\s*actions\/checkout@/.test(line)).trim());
}

test("pins every external action reference to a full commit SHA", () => {
  const findings = workflows.flatMap((workflow) => unpinnedActions(workflow.source).map((reference) => `${workflow.name}: ${reference}`));
  assert.deepEqual(findings, []);
});

test("the pin check reports an unpinned action reference", () => {
  assert.deepEqual(unpinnedActions("      - uses: actions/checkout@v4\n"), ["actions/checkout@v4"]);
  assert.deepEqual(unpinnedActions("      - uses: actions/checkout@v4 # comment\n"), ["actions/checkout@v4"]);
  assert.deepEqual(unpinnedActions("      - uses: ./local-action\n"), []);
});

test("every checkout disables credential persistence", () => {
  const findings = workflows.flatMap((workflow) => checkoutsWithoutCredentialIsolation(workflow.source).map((line) => `${workflow.name}: ${line}`));
  assert.deepEqual(findings, []);
});

test("the credential-persistence check rejects a checkout that omits the setting", () => {
  const source = "steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n    with:\n      fetch-depth: 0\n  - run: npm test\n";
  assert.equal(checkoutsWithoutCredentialIsolation(source).length, 1);
  const compliant = "steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n    with:\n      fetch-depth: 0\n      persist-credentials: false\n  - run: npm test\n";
  assert.deepEqual(checkoutsWithoutCredentialIsolation(compliant), []);
});

test("every workflow declares explicit permissions", () => {
  for (const workflow of workflows) {
    assert.match(workflow.source, /^permissions:/m, `${workflow.name} must declare top-level permissions`);
  }
});

function semgrepRuleIds() {
  const directory = join(root, "semgrep");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const source = readFileSync(join(directory, name), "utf8");
      const id = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(source)?.[1];
      assert.ok(id, `${name} must declare exactly one rule id`);
      return { file: name, id, source };
    });
}

function semgrepFixtureProblems(rules, targets) {
  const problems = [];
  const expected = rules.map((rule) => `${rule.id}.js`).sort();
  const actual = [...targets.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`targets ${actual} do not match rules ${expected}`);
  for (const rule of rules) {
    const fixture = targets.get(`${rule.id}.js`);
    if (!fixture) { problems.push(`${rule.id} has no fixture`); continue; }
    if (!fixture.includes(`ruleid: ${rule.id}`)) problems.push(`${rule.id} has no invalid example`);
    if (!fixture.includes(`ok: ${rule.id}`)) problems.push(`${rule.id} has no valid example`);
  }
  return problems;
}

test("the committed Semgrep rules and fixtures share exact rule identifiers and file names", () => {
  const rules = semgrepRuleIds();
  assert.ok(rules.length > 0);
  const targets = new Map(readdirSync(join(root, "tests", "semgrep", "targets"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, readFileSync(join(root, "tests", "semgrep", "targets", name), "utf8")]));
  assert.deepEqual(semgrepFixtureProblems(rules, targets), []);
});

test("the Semgrep fixture check rejects a renamed rule without a matching fixture", () => {
  const targets = new Map([["bifrost-no-eval.js", "// ruleid: bifrost-no-eval\neval('x');\n// ok: bifrost-no-eval\nconst x = 1;\n"]]);
  assert.deepEqual(semgrepFixtureProblems([{ id: "bifrost-no-eval" }], targets), []);
  assert.equal(semgrepFixtureProblems([{ id: "bifrost-renamed" }], targets).length, 2);
});

function gitleaksScopeProblems(config) {
  const problems = [];
  if (!/useDefault = true/.test(config)) problems.push("must extend the default ruleset");
  if (/^\s*\[allowlist\]\s*$/m.test(config)) problems.push("a top-level allowlist would suppress every rule");
  if (!/^\s*\[\[rules\]\]\s*$/m.test(config)) problems.push("no rule-scoped allowlist");
  if (!/^\s*id = "generic-api-key"\s*$/m.test(config)) problems.push("allowlist must target generic-api-key");
  if (!/regexes = \[\s*'''\^sk-live-should-never-print\$'''/.test(config)) problems.push("allowlist must contain the exact synthetic canary");
  const allowlists = config.split(/^\s*\[\[rules\.allowlists\]\]\s*$/m).slice(1);
  for (const allowlist of allowlists.slice(1)) {
    if (!/^condition\s*=\s*"AND"\s*$/m.test(allowlist)
      || !/^regexTarget\s*=\s*"secret"\s*$/m.test(allowlist)
      || !/^paths\s*=\s*\['''\^tests\/[a-zA-Z0-9_/-]+(?:\\\.[a-zA-Z0-9_-]+)+\$'''\]\s*$/m.test(allowlist)
      || !/^regexes\s*=\s*\['''\^(?:\\[\\.^$*+?()[\]{}|]|[^'\\\n.^$*+?()[\]{}|])+\$'''\]\s*$/m.test(allowlist)) {
      problems.push("fixture allowlists must require an exact test path and exact secret");
    }
  }
  return problems;
}

test("the secret allowlist is scoped to the generic API key rule and exact values", () => {
  assert.deepEqual(gitleaksScopeProblems(readFileSync(join(root, ".gitleaks.toml"), "utf8")), []);
});

test("the secret allowlist check rejects a broad top-level allowlist", () => {
  const broad = "[extend]\nuseDefault = true\n\n[allowlist]\npaths = ['''tests/''']\n";
  assert.equal(gitleaksScopeProblems(broad).includes("a top-level allowlist would suppress every rule"), true);
});

test("the secret allowlist check rejects weakening fixture path and value matching", () => {
  const config = readFileSync(join(root, ".gitleaks.toml"), "utf8");
  assert.ok(gitleaksScopeProblems(config.replace('condition = "AND"', 'condition = "OR"')).length > 0);
  assert.ok(gitleaksScopeProblems(config.replace("^tests/", "^tests/.*")).length > 0);
  assert.ok(gitleaksScopeProblems(config.replace(/^paths\s*=.*\n/m, "")).length > 0);
  const wildcard = config.replace("^fixture/anchor$", "^fixture/anch.r$");
  assert.notEqual(wildcard, config, "the secret-pattern mutation must apply");
  assert.ok(gitleaksScopeProblems(wildcard).length > 0);
  const escapedDot = config.replace("^fixture/anchor$", "^fixture/anch\\.r$");
  assert.notEqual(escapedDot, config, "the escaped-punctuation control must apply");
  assert.deepEqual(gitleaksScopeProblems(escapedDot), []);
});

function knipConfigFrom(source) {
  // knip.jsonc allows full-line comments; the schema URL keeps its own `//`.
  return JSON.parse(source.replace(/^\s*\/\/.*$/gmu, ""));
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean);
}

// Knip cannot report on an entry or project glob that matches nothing, and it
// cannot warn about an ignore that hides no file. These exceptions carry their
// reason here so a silent no-op ignore cannot accumulate.
const KNIP_DEPENDENCY_EXCEPTIONS = {
  "@stryker-mutator/command-runner": "bundled with @stryker-mutator/core and resolved by name from testRunner: command",
  "@stryker-mutator/bun-runner": "name Knip infers from testRunner: bun; the community runner above is used instead",
};

const KNIP_BINARY_EXCEPTIONS = {
  hyperfine: "optional host benchmark tool documented in docs/dev-tooling.md",
  stryker: "binary provided by @stryker-mutator/core, which the mutation runner invokes",
  bun: "host test runner for the default mutation runner, documented in docs/mutation-testing.md",
};

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function knipScopeProblems({ config, files, manifest, gitignoreText, dependencyExceptions, binaryExceptions }) {
  const problems = [];
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const field of ["entry", "project"]) {
    if (!Array.isArray(config[field]) || config[field].length === 0) {
      problems.push(`missing ${field} globs`);
      continue;
    }
    for (const glob of config[field]) {
      if (!files.some((file) => matchesGlob(file, glob))) problems.push(`${field} glob ${glob} matches no tracked file`);
    }
  }
  for (const pattern of config.ignore ?? []) {
    const prefix = pattern.replace(/\/\*\*$/u, "");
    const matchesTracked = files.some((file) => matchesGlob(file, pattern) || file.startsWith(`${prefix}/`));
    const matchesGenerated = new RegExp(`^${escapeRegExp(prefix)}/?$`, "mu").test(gitignoreText);
    if (!matchesTracked && !matchesGenerated) problems.push(`ignore ${pattern} matches neither a tracked file nor a gitignored artifact`);
  }
  for (const [field, exceptions] of [
    ["ignoreDependencies", dependencyExceptions],
    ["ignoreBinaries", binaryExceptions],
  ]) {
    const ignored = config[field] ?? [];
    for (const name of ignored) {
      const isDeclared = field === "ignoreDependencies" && declared.has(name);
      if (!isDeclared && !Object.hasOwn(exceptions, name)) problems.push(`${field} ${name} is neither declared nor a documented exception`);
    }
    for (const name of Object.keys(exceptions)) {
      if (!ignored.includes(name)) problems.push(`documented ${field} exception ${name} is not configured`);
    }
  }
  return problems;
}

test("Knip entry, ignore, and exception scopes match the tree", () => {
  const problems = knipScopeProblems({
    config: knipConfigFrom(knipSource),
    files: trackedFiles(),
    manifest: packageManifest,
    gitignoreText: gitignore,
    dependencyExceptions: KNIP_DEPENDENCY_EXCEPTIONS,
    binaryExceptions: KNIP_BINARY_EXCEPTIONS,
  });
  assert.deepEqual(problems, []);
});

test("the Knip scope audit reports dead globs, undeclared ignores, and stale exceptions", () => {
  const config = knipConfigFrom(knipSource);
  const base = {
    files: trackedFiles(),
    manifest: packageManifest,
    gitignoreText: gitignore,
    dependencyExceptions: KNIP_DEPENDENCY_EXCEPTIONS,
    binaryExceptions: KNIP_BINARY_EXCEPTIONS,
  };
  const problemsFor = (mutate) => knipScopeProblems({ ...base, config: mutate(structuredClone(config)) });

  assert.equal(problemsFor((copy) => { copy.project = ["*.nope"]; return copy; })
    .includes("project glob *.nope matches no tracked file"), true);
  assert.equal(problemsFor((copy) => { copy.ignore = ["src/**"]; return copy; })
    .includes("ignore src/** matches neither a tracked file nor a gitignored artifact"), true);
  assert.equal(problemsFor((copy) => { copy.ignoreDependencies.push("left-pad"); return copy; })
    .includes("ignoreDependencies left-pad is neither declared nor a documented exception"), true);
  const withoutException = structuredClone(config);
  withoutException.ignoreDependencies = withoutException.ignoreDependencies.filter((name) => name !== "@stryker-mutator/bun-runner");
  assert.equal(knipScopeProblems({ ...base, config: withoutException })
    .includes("documented ignoreDependencies exception @stryker-mutator/bun-runner is not configured"), true,
  "a stale exception must be removed, not left behind");
  assert.equal(problemsFor((copy) => { copy.ignoreBinaries = ["hyperfine", "stryker"]; return copy; })
    .includes("documented ignoreBinaries exception bun is not configured"), true);
});

test("Renovate pins action digests and requires approval for major upgrades", () => {
  const config = JSON.parse(readFileSync(join(root, "renovate.json"), "utf8"));
  assert.equal(config.pinDigests, true);
  assert.equal(config.extends.includes("config:recommended"), true);
  assert.equal(config.packageRules.some((rule) => rule.matchUpdateTypes?.includes("major") && rule.dependencyDashboardApproval === true), true);
});

test("the dispatch-only security audit runs history secrets, full SAST, dependencies, and workflow audits", () => {
  const workflow = readFileSync(join(workflowDirectory, "security-audit.yml"), "utf8");
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /check:secrets:history/);
  assert.match(workflow, /semgrep scan --config semgrep\//);
  assert.match(workflow, /osv-scanner-reusable\.yml@[a-f0-9]{40}/);
  assert.match(workflow, /zizmor --format plain/);
});

test("the toolbox constructs pinned-tool commands for security checks", () => {
  const sast = CHECKS.sast.command("/tmp");
  assert.deepEqual(sast.args.slice(0, 3), ["scan", "--config", "semgrep/"]);
  assert.equal(sast.args.includes("."), true);
  const secrets = CHECKS.secrets.command("/tmp");
  assert.equal(secrets.args[0], "dir");
  assert.equal(secrets.args.includes(".gitleaks.toml"), true);
  assert.equal(CHECKS["secrets-history"].command("/tmp").args[0], "git");
  assert.equal(CHECKS.deps.command("/tmp").args.includes("package-lock.json"), true);
});
