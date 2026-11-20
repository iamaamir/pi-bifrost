#!/usr/bin/env node
/**
 * Deterministic repository toolbox.
 *
 * One entry point for architecture, dead-code, structural, security, and
 * workflow checks. Every check has a fixed command line, a structured result,
 * and an explicit "tool unavailable" status so a missing binary never looks
 * like a pass.
 *
 * Usage:
 *   node scripts/toolbox.mjs <check> [--json] [--root <path>]
 *   node scripts/toolbox.mjs doctor [--json]
 *
 * `--root` measures another tree with the same tool binaries, which is how the
 * fault-control tests drive a real gate against a fixture.
 *
 * Exit codes: 0 clean, 1 findings, 2 unavailable tool or invalid invocation.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return { root: ROOT };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return { error: "--root requires a path" };
  const root = resolve(value);
  if (!existsSync(root) || !statSync(root).isDirectory()) return { error: `--root is not a directory: ${value}` };
  return { root };
}
const STDERR_TAIL_BYTES = 4096;

const TOOLS = {
  depcruise: {
    package: "dependency-cruiser",
    install: "npm install (declared devDependency)",
    versionArgs: ["--version"],
  },
  knip: { package: "knip", install: "npm install (declared devDependency)", versionArgs: ["--version"] },
  "ast-grep": { package: "@ast-grep/cli", install: "npm install (declared devDependency)", versionArgs: ["--version"] },
  jscpd: { package: "jscpd", install: "npm install (declared devDependency)", versionArgs: ["--version"] },
  actionlint: {
    install: "go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12",
    versionArgs: ["-version"],
  },
  semgrep: { install: "uv tool install semgrep==1.182.0", versionArgs: ["--version"] },
  gitleaks: {
    install: "brew install gitleaks (8.x) or download the pinned release binary",
    versionArgs: ["version"],
  },
  "osv-scanner": {
    install: "go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.7.0",
    versionArgs: ["--version"],
  },
  zizmor: { install: "uv tool install zizmor==1.31.1", versionArgs: ["--version"] },
  hyperfine: { install: "brew install hyperfine", versionArgs: ["--version"] },
  difft: { install: "brew install difftastic", versionArgs: ["--version"] },
  rg: { install: "brew install ripgrep", versionArgs: ["--version"] },
  gh: { install: "brew install gh", versionArgs: ["--version"] },
};

function tail(text, limit = STDERR_TAIL_BYTES) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(-limit) : value;
}

function binEnv(extraEnv) {
  const separator = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${join(ROOT, "node_modules", ".bin")}${separator}${process.env.PATH ?? ""}`,
    ...extraEnv,
  };
}

export function toolExecutable(command, platform = process.platform) {
  if (platform !== "win32") return command;
  return TOOLS[command]?.package ? `${command}.cmd` : `${command}.exe`;
}

function spawnCapture(command, args, { cwd = ROOT, env } = {}) {
  const executable = toolExecutable(command);
  const result = spawnSync(executable, args, {
    cwd,
    env: binEnv(env),
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: process.platform === "win32",
  });
  if (result.error?.code === "ENOENT") return { missing: true, stdout: "", stderr: "" };
  return {
    missing: false,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: tail(result.stderr ?? ""),
    error: result.error,
  };
}

export function parseDependencyCruiser(stdout) {
  const data = JSON.parse(stdout);
  return (data.summary?.violations ?? []).map((violation) => ({
    rule: violation.rule?.name ?? "unknown",
    file: String(violation.from ?? "(unknown)"),
    line: null,
    message: `${violation.from} -> ${violation.to}`,
  }));
}

const KNIP_ISSUE_KINDS = new Set([
  "files",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "binaries",
  "unresolved",
  "exports",
  "types",
  "duplicates",
  "enumMembers",
  "namespaceMembers",
  "catalog",
  "catalogReferences",
]);

export function parseKnip(stdout) {
  const data = JSON.parse(stdout);
  const findings = [];
  for (const issue of data.issues ?? []) {
    for (const [kind, entries] of Object.entries(issue)) {
      if (!KNIP_ISSUE_KINDS.has(kind) || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        findings.push({
          rule: kind,
          file: issue.file ?? "(unknown)",
          line: typeof entry.line === "number" ? entry.line : null,
          message: entry.name ?? entry.file ?? JSON.stringify(entry),
        });
      }
    }
  }
  return findings;
}

export function parseAstGrep(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  return JSON.parse(trimmed).map((match) => ({
    rule: match.ruleId ?? "unknown",
    file: match.file ?? "(unknown)",
    line: (match.range?.start?.line ?? 0) + 1,
    message: match.message ?? match.lines ?? "",
  }));
}

// Minimal reader for the `files:`/`ignores:` lists in rules/*.yml. The rule
// files use plain block or inline string lists, so a YAML dependency is not
// worth it here.
export function parseRuleGlobs(text) {
  const globs = { files: [], ignores: [] };
  let key = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const inline = /^(files|ignores):\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      globs[inline[1]] = inline[2]
        .split(",")
        .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      key = null;
      continue;
    }
    const block = /^(files|ignores):\s*$/.exec(line);
    if (block) {
      key = block[1];
      continue;
    }
    if (key && line.startsWith("- ")) {
      globs[key].push(line.slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (line && !line.startsWith("#")) key = null;
  }
  return globs;
}

// ast-grep's `files`/`ignores` use globset defaults, where `*` matches across
// directory separators. Node's matchesGlob stops at a separator, so using it
// here would call a rule scoped to nothing while the scanner still matches a
// nested file. Knip keeps its own glob semantics; this matcher is for ast-grep.
export function fileMatchesGlob(file, glob) {
  let pattern = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") i += 1;
      if (glob[i + 1] === "/") i += 1;
      pattern += ".*";
    } else if (char === "?") {
      pattern += ".";
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`, "u").test(file);
}

export function ruleScopeFindings(rules, files) {
  // An empty or unavailable file list proves nothing about any rule's scope.
  // Skipping the guard here would recreate the silent pass it exists to remove.
  if (!files || files.length === 0) {
    return [
      {
        rule: "ast-grep-scope-unverified",
        file: "rules",
        line: null,
        message: files
          ? "no tracked files found; rule scope is unverified"
          : "could not list tracked files (git ls-files failed); rule scope is unverified",
      },
    ];
  }
  return rules.flatMap(({ id, files: include, ignores }) => {
    const patterns = include.length > 0 ? include : ["**"];
    const eligible = files.some(
      (file) =>
        patterns.some((glob) => fileMatchesGlob(file, glob)) &&
        !ignores.some((glob) => fileMatchesGlob(file, glob)),
    );
    if (eligible) return [];
    return [
      {
        rule: "ast-grep-empty-scope",
        file: `rules/${id}.yml`,
        line: null,
        message: `rule ${id} matches no repository files (files: ${patterns.join(", ")})`,
      },
    ];
  });
}

export function parseActionlint(stdout) {
  const findings = [];
  for (const line of String(stdout).split("\n")) {
    const match = /^(.+?):(\d+):(\d+): (.+?)(?: \[(.+?)\])?$/.exec(line.trim());
    if (!match) continue;
    findings.push({
      rule: match[5] ?? "actionlint",
      file: match[1],
      line: Number(match[2]),
      message: match[4],
    });
  }
  return findings;
}

export function parseSemgrep(stdout) {
  const data = JSON.parse(stdout);
  return (data.results ?? []).map((result) => ({
    rule: result.check_id ?? "unknown",
    file: result.path ?? "(unknown)",
    line: result.start?.line ?? null,
    message: result.extra?.message ?? "",
  }));
}

export function parseGitleaks(reportJson) {
  const data = JSON.parse(reportJson);
  if (!Array.isArray(data)) return [];
  // Never project Secret, Match, or surrounding lines: the report is not a
  // place to reintroduce the credential the scan just found.
  return data.map((finding) => ({
    rule: finding.RuleID ?? "unknown",
    file: finding.File ?? "(unknown)",
    line: finding.StartLine ?? null,
    message: finding.Description ?? "possible secret",
  }));
}

export function parseOsv(stdout) {
  const data = JSON.parse(stdout);
  const findings = [];
  for (const result of data.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vulnerability of pkg.vulnerabilities ?? []) {
        findings.push({
          rule: vulnerability.id ?? "unknown",
          file: result.source?.path ?? "(unknown)",
          line: null,
          message: `${pkg.package?.name ?? "package"}@${pkg.package?.version ?? "?"}: ${vulnerability.summary ?? ""}`.trim(),
        });
      }
    }
  }
  return findings;
}

function duplicationThreshold(root = ROOT) {
  return JSON.parse(readFileSync(join(root, ".jscpd.json"), "utf8")).threshold;
}

const DUPLICATION_THRESHOLD = duplicationThreshold();

export function parseJscpd(reportJson, threshold = DUPLICATION_THRESHOLD) {
  const data = JSON.parse(reportJson);
  const total = data.statistics?.total ?? {};
  const percentage = Number(total.percentage ?? 0);
  if (percentage > threshold) {
    return [
      {
        rule: "duplication-threshold",
        file: ".jscpd.json",
        line: null,
        message: `${percentage.toFixed(2)}% duplicated lines (${total.duplicatedLines ?? 0}/${total.lines ?? 0}) over ${threshold}% threshold; clones=${total.clones ?? 0}`,
      },
    ];
  }
  return [];
}

function workflowFiles(root = ROOT) {
  const directory = join(root, ".github", "workflows");
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map((name) => join(".github", "workflows", name));
  } catch {
    return [];
  }
}

function gitleaksCommand(history) {
  return (temp) => {
    const report = join(temp, "gitleaks.json");
    return {
      args: [
        history ? "git" : "dir",
        "--redact",
        "--no-banner",
        "--config",
        ".gitleaks.toml",
        "--report-format",
        "json",
        "--report-path",
        report,
        "--exit-code",
        "1",
        ".",
      ],
      read: () => readFileSync(report, "utf8"),
    };
  };
}

function loadRuleScopes(root = ROOT) {
  const dir = join(root, "rules");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => ({ id: file.replace(/\.yml$/, ""), ...parseRuleGlobs(readFileSync(join(dir, file), "utf8")) }));
}

function trackedFiles(root = ROOT) {
  const result = spawnCapture("git", ["ls-files"], { cwd: root });
  if (result.missing || result.status !== 0) return null;
  return result.stdout.split("\n").filter(Boolean);
}

export function runAstGrep(runTool, { rules = loadRuleScopes(), files = trackedFiles() } = {}) {
  const tests = runTool("ast-grep", ["test", "--skip-snapshot-tests"]);
  if (tests.missing) return tests;
  const scan = runTool("ast-grep", ["scan", "--config", "sgconfig.yml", "--json"]);
  if (scan.missing) return scan;
  const findings = parseAstGrep(scan.stdout);
  findings.push(...ruleScopeFindings(rules, files));
  if (tests.status !== 0) {
    findings.push({ rule: "ast-grep-rule-tests", file: "rule-tests", line: null, message: tail(tests.stdout || tests.stderr, 2000) });
  }
  return {
    ...scan,
    status: tests.status !== 0 || scan.status !== 0 || findings.length > 0 ? 1 : 0,
    findings,
    stderr: `${tests.stderr ?? ""}${scan.stderr ?? ""}`,
  };
}

export const CHECKS = {
  arch: {
    tool: "depcruise",
    summary: "Architecture boundaries (dependency-cruiser)",
    command: () => ({ args: ["--config", ".dependency-cruiser.cjs", "--output-type", "json", "*.ts"] }),
    parse: parseDependencyCruiser,
  },
  "dead-code": {
    tool: "knip",
    summary: "Unused files, exports, and dependencies (Knip)",
    command: () => ({ args: ["--config", "knip.jsonc", "--reporter", "json"] }),
    parse: parseKnip,
  },
  ast: {
    tool: "ast-grep",
    summary: "Structural rules and rule self-tests (ast-grep)",
    run: (runTool, root = ROOT) => runAstGrep(runTool, { rules: loadRuleScopes(root), files: trackedFiles(root) }),
  },
  actions: {
    tool: "actionlint",
    summary: "GitHub Actions syntax and expression checks (actionlint)",
    run: (runTool, root = ROOT) => {
      const files = workflowFiles(root);
      if (files.length === 0) return { status: 1, findings: [{ rule: "actionlint", file: ".github/workflows", line: null, message: "no workflow files found" }] };
      const result = runTool("actionlint", ["-no-color", "-oneline", ...files]);
      if (result.missing) return result;
      return { ...result, findings: parseActionlint(result.stdout) };
    },
  },
  sast: {
    tool: "semgrep",
    summary: "Repository security rules (Semgrep)",
    command: () => ({
      args: ["scan", "--config", "semgrep/", "--json", "--quiet", "--metrics=off", "--disable-version-check", "."],
    }),
    parse: parseSemgrep,
  },
  secrets: {
    tool: "gitleaks",
    summary: "Working-tree secret detection (Gitleaks)",
    command: gitleaksCommand(false),
    fileReport: true,
    parse: parseGitleaks,
  },
  "secrets-history": {
    tool: "gitleaks",
    summary: "Full-history secret detection (Gitleaks)",
    command: gitleaksCommand(true),
    fileReport: true,
    parse: parseGitleaks,
  },
  deps: {
    tool: "osv-scanner",
    summary: "Dependency vulnerabilities from the lockfile (OSV-Scanner)",
    command: () => ({
      args: ["scan", "source", "--lockfile", "package-lock.json", "--format", "json", "--verbosity", "error"],
    }),
    parse: parseOsv,
  },
  duplication: {
    tool: "jscpd",
    summary: "Copy-paste detection with a ratcheted threshold (jscpd)",
    command: (temp) => {
      const report = join(temp, "jscpd-report.json");
      return {
        args: [".", "--config", ".jscpd.json", "--reporters", "json", "--output", temp],
        read: () => readFileSync(report, "utf8"),
      };
    },
    fileReport: true,
    parse: (raw, root = ROOT) => parseJscpd(raw, duplicationThreshold(root)),
  },
};

export function summarizeFindings(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([rule, count]) => `${rule} (${count})`)
    .join(", ");
}

function executeCheck(name, definition, root = ROOT) {
  const started = Date.now();
  const temp = mkdtempSync(join(tmpdir(), "bifrost-toolbox-"));
  try {
    if (definition.run) {
      const result = definition.run((command, args) => spawnCapture(command, args, { cwd: root }), root);
      if (result.missing) return unavailable(name, definition);
      const findings = result.findings ?? [];
      return envelope(name, definition, result.status, findings, started, result.stderr);
    }
    const plan = definition.command(temp, root);
    const result = spawnCapture(definition.tool, plan.args, { cwd: root });
    if (result.missing) return unavailable(name, definition);
    let raw = result.stdout;
    if (definition.fileReport) {
      try {
        raw = plan.read();
      } catch {
        raw = "[]";
      }
    }
    let findings;
    try {
      findings = definition.parse(raw, root);
    } catch (error) {
      return {
        check: name,
        tool: definition.tool,
        status: "failed",
        exitCode: 1,
        findings: [],
        error: `could not parse ${definition.tool} output: ${error.message}`,
        stderr: tail(result.stderr),
        durationMs: Date.now() - started,
      };
    }
    return envelope(name, definition, result.status, findings, started, result.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function envelope(name, definition, status, findings, started, stderr = "") {
  const failed = findings.length > 0 || status !== 0;
  return {
    check: name,
    tool: definition.tool,
    status: failed ? "failed" : "passed",
    exitCode: failed ? 1 : 0,
    findings,
    ...(stderr ? { stderr: tail(stderr) } : {}),
    durationMs: Date.now() - started,
  };
}

function unavailable(name, definition) {
  const tool = TOOLS[definition.tool] ?? {};
  return {
    check: name,
    tool: definition.tool,
    status: "unavailable",
    exitCode: 2,
    findings: [],
    error: `${definition.tool} is not installed. Install it with: ${tool.install ?? `install ${definition.tool}`}`,
    durationMs: 0,
  };
}

function doctor() {
  const rows = [];
  for (const [name, tool] of Object.entries(TOOLS)) {
    const result = spawnCapture(name, tool.versionArgs ?? ["--version"]);
    rows.push({
      tool: name,
      status: result.missing ? "missing" : "available",
      version: result.missing ? null : (result.stdout.trim().split("\n")[0] || result.stderr.trim().split("\n")[0] || null),
      install: tool.install,
    });
  }
  return rows;
}

function printResult(result) {
  if (result.status === "passed") {
    console.log(`PASS ${result.check}: ${result.tool} (${result.durationMs} ms)`);
    return;
  }
  if (result.status === "unavailable") {
    console.error(`UNAVAILABLE ${result.check}: ${result.error}`);
    return;
  }
  const summary = summarizeFindings(result.findings);
  console.error(`FAIL ${result.check}: ${result.findings.length} finding(s)${summary ? ` — ${summary}` : ""}`);
  for (const finding of result.findings.slice(0, 25)) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${finding.rule}  ${location}  ${finding.message}`);
  }
  if (result.findings.length > 25) console.error(`  ... ${result.findings.length - 25} more`);
  if (result.error) console.error(`  ${result.error}`);
  const stderr = result.stderr ?? "";
  if (stderr.trim() !== "" && result.findings.length === 0) console.error(stderr);
}

function usage() {
  return [
    "Usage: node scripts/toolbox.mjs <check> [--json] [--root <path>]",
    "",
    "Checks:",
    ...Object.entries(CHECKS).map(([name, definition]) => `  ${name.padEnd(16)} ${definition.summary}`),
    "  doctor           Report tool availability and install hints",
    "",
    "Exit codes: 0 clean, 1 findings, 2 unavailable tool or invalid invocation.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const parsedRoot = parseRoot(argv);
  if (parsedRoot.error) {
    console.error(parsedRoot.error);
    return 2;
  }
  const rootIndex = argv.indexOf("--root");
  const rest = argv.filter((argument, index) => argument !== "--json"
    && argument !== "--root"
    && (rootIndex === -1 || index !== rootIndex + 1));
  const name = rest[0];
  if (!name || name === "--help" || name === "-h") {
    console.log(usage());
    return name ? 0 : 2;
  }
  if (name === "doctor") {
    const rows = doctor();
    if (json) {
      console.log(JSON.stringify({ check: "doctor", status: "passed", exitCode: 0, tools: rows }, null, 2));
    } else {
      for (const row of rows) {
        console.log(`${row.status === "available" ? "OK  " : "MISS"} ${row.tool.padEnd(14)} ${row.version ?? `install: ${row.install}`}`);
      }
    }
    return 0;
  }
  const definition = CHECKS[name];
  if (!definition) {
    console.error(`Unknown check: ${name}\n\n${usage()}`);
    return 2;
  }
  const result = executeCheck(name, definition, parsedRoot.root);
  if (json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
