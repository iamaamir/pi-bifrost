import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS } from "../scripts/toolbox.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
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
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)\s*$/.exec(line);
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
  if (!/paths = \[\s*'''\^tests\/'''\s*\]/.test(config)) problems.push("allowlist must be scoped to tests");
  return problems;
}

test("the secret allowlist is scoped to the generic API key rule under tests", () => {
  assert.deepEqual(gitleaksScopeProblems(readFileSync(join(root, ".gitleaks.toml"), "utf8")), []);
});

test("the secret allowlist check rejects a broad top-level allowlist", () => {
  const broad = "[extend]\nuseDefault = true\n\n[allowlist]\npaths = ['''tests/''']\n";
  assert.equal(gitleaksScopeProblems(broad).includes("a top-level allowlist would suppress every rule"), true);
});

test("Renovate pins action digests and requires approval for major upgrades", () => {
  const config = JSON.parse(readFileSync(join(root, "renovate.json"), "utf8"));
  assert.equal(config.pinDigests, true);
  assert.equal(config.extends.includes("config:recommended"), true);
  assert.equal(config.packageRules.some((rule) => rule.matchUpdateTypes?.includes("major") && rule.dependencyDashboardApproval === true), true);
});

test("the scheduled security audit runs history secrets, full SAST, dependencies, and workflow audits", () => {
  const workflow = readFileSync(join(workflowDirectory, "security-audit.yml"), "utf8");
  assert.match(workflow, /cron:/);
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
