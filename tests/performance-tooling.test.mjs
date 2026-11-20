import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { benchPlan, parseArgs, parseHyperfine } from "../scripts/bench.mjs";
import { profilePlan } from "../scripts/profile.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scripts = packageManifest.scripts;
const knipConfig = readFileSync(join(root, "knip.jsonc"), "utf8");
const gitleaksConfig = readFileSync(join(root, ".gitleaks.toml"), "utf8");
const guide = readFileSync(join(root, "docs", "dev-tooling.md"), "utf8");
const trackerGuide = readFileSync(join(root, "docs", "tracker-workflow.md"), "utf8");
const workflowDirectory = join(root, ".github", "workflows");
const workflowSources = readdirSync(workflowDirectory)
  .filter((name) => name.endsWith(".yml"))
  .sort()
  .map((name) => readFileSync(join(workflowDirectory, name), "utf8"))
  .join("\n");

function workload(iterations) {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    join(root, "scripts", "perf-workload.mjs"),
    "--iterations", String(iterations),
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the deterministic routing workload reports a stable checksum", () => {
  const first = workload(20);
  const second = workload(20);
  assert.equal(first.workload, "resolve-only");
  assert.equal(first.iterations, 20);
  assert.equal(first.selected, "example/model-0");
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.checksum, 2320);
  assert.equal(Number.isFinite(first.elapsedMs), true);
});

test("the deterministic routing workload rejects an unexpected model selection", () => {
  const source = readFileSync(join(root, "scripts", "perf-workload.mjs"), "utf8");
  const anchor = "models: { quick: models.map((model) => `${model.provider}/${model.id}`) },";
  assert.equal(source.split(anchor).length, 2, "workload model-pool anchor must be unique");
  const copy = join(root, "scripts", `.perf-workload-fault-${process.pid}-${Date.now()}.mjs`);
  try {
    writeFileSync(copy, source.replace(anchor, "models: { quick: [...models].reverse().map((model) => `${model.provider}/${model.id}`) },"));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", copy, "--iterations", "1"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected selected model: example\/model-9/u);
  } finally {
    rmSync(copy, { force: true });
  }
});

function assertHyperfinePlans(buildPlan) {
  const route = buildPlan("route", { runs: 4, warmup: 2, stamp: "stamp" });
  assert.equal(route.artifact.endsWith(join("reports", "bench", "route-stamp.json")), true);
  assert.equal(route.hyperfineArgs.includes("--export-json"), true);
  assert.equal(route.hyperfineArgs.includes("4"), true);
  assert.match(route.hyperfineArgs.at(-1), /perf-workload\.mjs --iterations 200000/u,
    "route plan must use committed deterministic workload");
  const projection = buildPlan("projection", { runs: 2, warmup: 1, stamp: "stamp" });
  assert.equal(projection.artifact.endsWith(join("reports", "bench", "projection-stamp.json")), true);
  assert.match(projection.hyperfineArgs.at(-1), /provider-projection-benchmark\.mjs/u);
  assert.match(projection.hyperfineArgs.at(-1), /reports[/\\]bench[/\\]projection-details-stamp\.json/u);
}

test("builds Hyperfine plans for allowlisted workloads", () => {
  assertHyperfinePlans(benchPlan);
});

test("RED-proves the Hyperfine workload allowlist implementation fault in an isolated source copy", async () => {
  const source = readFileSync(join(root, "scripts", "bench.mjs"), "utf8");
  const anchor = 'script: "scripts/perf-workload.mjs",';
  assert.equal(source.split(anchor).length, 2, "workload allowlist anchor must be unique");
  const directory = mkdtempSync(join(tmpdir(), "bifrost-bench-fault-"));
  const copy = join(directory, "bench.mjs");
  try {
    assertHyperfinePlans(benchPlan);
    const mutant = source.replace(anchor, 'script: "scripts/not-allowlisted-workload.mjs",');
    writeFileSync(copy, mutant);
    const broken = await import(pathToFileURL(copy).href);
    assert.throws(() => assertHyperfinePlans(broken.benchPlan), (error) => error?.name === "AssertionError"
      && /route plan must use committed deterministic workload/u.test(error.message),
    "mutated implementation must turn named workload assertion RED");

    writeFileSync(copy, source);
    const restored = await import(`${pathToFileURL(copy).href}?restored`);
    assertHyperfinePlans(restored.benchPlan);
    assert.equal(readFileSync(copy, "utf8"), source, "source copy must restore byte-for-byte");
    assert.equal(readFileSync(join(root, "scripts", "bench.mjs"), "utf8"), source,
      "committed benchmark implementation must remain untouched");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parses Hyperfine 2 summary and legacy sample counts", () => {
  const modern = parseHyperfine(JSON.stringify({
    results: [{
      command: "node workload",
      summary: { time_wall_clock: { unit: "second", count: 5, mean: 1.25, stddev: 0.1, min: 1.1, max: 1.4 } },
    }],
  }));
  assert.deepEqual(modern, { command: "node workload", runs: 5, meanMs: 1250, stddevMs: 100, minMs: 1100, maxMs: 1400 });
  const legacy = parseHyperfine(JSON.stringify({
    results: [{ command: "node workload", mean: 0.5, stddev: 0.05, min: 0.45, max: 0.6, times: [0.45, 0.5, 0.55] }],
  }));
  assert.equal(legacy.runs, 3);
  assert.equal(legacy.meanMs, 500);
  assert.equal(legacy.minMs, 450);
});

test("rejects missing benchmark option values", () => {
  assert.throws(() => parseArgs(["--runs"]), /--runs requires a positive integer/u);
  assert.throws(() => parseArgs(["--warmup"]), /--warmup requires a positive integer/u);
});

test("rejects malformed Hyperfine reports", () => {
  assert.throws(() => parseHyperfine(JSON.stringify({ results: [] })), /expected one hyperfine result/);
  assert.throws(() => parseHyperfine(JSON.stringify({ results: [{ command: "x" }] })), /no wall-clock mean/);
});

test("builds CPU and heap profile plans with a relative artifact name", () => {
  const cpu = profilePlan("cpu", "route", join(root, "reports", "profiles", "run"));
  assert.equal(cpu.artifact.endsWith("route-cpu.cpuprofile"), true);
  assert.equal(cpu.args.includes("--cpu-prof"), true);
  assert.equal(cpu.args.includes(join(root, "reports", "profiles", "run")), true);
  assert.equal(cpu.args[cpu.args.indexOf("--cpu-prof-name") + 1], "route-cpu.cpuprofile");
  const heap = profilePlan("heap", "route", join(root, "reports", "profiles", "run"));
  assert.equal(heap.artifact.endsWith("route-heap.heapprofile"), true);
  assert.equal(heap.args.includes("--heap-prof"), true);
});

test("rejects unknown benchmark and profile targets", () => {
  assert.throws(() => benchPlan("unknown", { runs: 1, warmup: 1, stamp: "x" }), /Unknown bench target/);
  assert.throws(() => profilePlan("analysis", "route", "x"), /Unknown profile mode/);
  assert.throws(() => profilePlan("cpu", "unknown", "x"), /Unknown profile target/);
});

test("reports a missing Hyperfine binary as unavailable", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "bench.mjs"), "route", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: join(tmpdir(), "bifrost-empty-path") },
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "unavailable");
  assert.match(report.error, /brew install hyperfine/);
});

function npmScriptsIn(markdown) {
  return [...new Set([...markdown.matchAll(/npm run ([a-z0-9:-]+)/gu)].map((match) => match[1]))];
}

function missingScripts(markdown, available) {
  return npmScriptsIn(markdown).filter((name) => !Object.hasOwn(available, name));
}

test("every npm script named in the developer guide exists", () => {
  const named = npmScriptsIn(guide);
  assert.equal(named.length > 5, true);
  assert.deepEqual(missingScripts(guide, scripts), []);
});

test("the command drift check reports an unknown npm script", () => {
  assert.deepEqual(npmScriptsIn("Run `npm run check:arch` and `npm run not-a-script`."), ["check:arch", "not-a-script"]);
  assert.deepEqual(missingScripts("Run `npm run not-a-script`.", scripts), ["not-a-script"]);
});

function checkScripts(all) {
  return Object.keys(all).filter((name) => name.startsWith("check:")).sort();
}

function workflowCommands(sources) {
  return new Set([...sources.matchAll(/npm run (check:[a-z0-9:-]+)/gu)].map((match) => match[1]));
}

// A gate counts as CI-covered when a workflow names it, or when a workflow runs
// a pinned equivalent directly. The equivalent carries its own evidence pattern
// so deleting that workflow step makes the gate uncovered again instead of
// leaving a comment that silently vouches for nothing.
const CI_EQUIVALENTS = {
  "check:sast": {
    why: "static-analysis.yml runs the pinned Semgrep rules with a baseline diff instead of this wrapper",
    evidence: /semgrep scan --config semgrep\//u,
  },
  "check:secrets": {
    why: "static-analysis.yml runs the Gitleaks action and the pull-request history scanner with .gitleaks.toml",
    evidence: /gitleaks-action@|scan-gitleaks-pr-history\.sh/u,
  },
  "check:deps": {
    why: "static-analysis.yml uses the pinned OSV-Scanner reusable pull-request workflow",
    evidence: /osv-scanner-reusable-pr\.yml@[a-f0-9]{40}/u,
  },
};

// Needs a live tracker and issue numbers, so it cannot run against a candidate
// tree. It is documented for on-demand use rather than executed by CI.
const ON_DEMAND_CHECKS = {
  "check:issue-refs": {
    why: "checks repository paths cited in tracker issues; needs a live issue and gh",
    evidence: /node scripts\/check-issue-refs\.mjs/u,
  },
};

function uncoveredGates(names, commands, equivalents, onDemand = {}) {
  return names.filter((name) => !commands.has(name)
    && !Object.hasOwn(equivalents, name)
    && !Object.hasOwn(onDemand, name));
}

function staleEvidence(map, sources) {
  return Object.entries(map)
    .filter(([, { evidence }]) => !evidence.test(sources))
    .map(([name]) => name);
}

function gatesMissingFromGuide(names, markdown) {
  return names.filter((name) => !markdown.includes(`npm run ${name}`));
}

function unknownWorkflowCommands(sources, available) {
  return [...workflowCommands(sources)].filter((name) => !Object.hasOwn(available, name)).sort();
}

test("every check: script is covered by CI or by asserted exception evidence", () => {
  const gates = checkScripts(scripts);
  assert.equal(gates.length >= 10, true, `expected the gate inventory, found ${gates.join(", ")}`);
  assert.deepEqual(uncoveredGates(gates, workflowCommands(workflowSources), CI_EQUIVALENTS, ON_DEMAND_CHECKS), []);
  assert.deepEqual(staleEvidence(CI_EQUIVALENTS, workflowSources), []);
  assert.deepEqual(staleEvidence(ON_DEMAND_CHECKS, trackerGuide), []);
});

test("every check: script appears in the developer guide", () => {
  assert.deepEqual(gatesMissingFromGuide(checkScripts(scripts), guide), []);
});

test("every check: command named in a workflow exists as an npm script", () => {
  assert.equal(workflowCommands(workflowSources).size >= 8, true);
  assert.deepEqual(unknownWorkflowCommands(workflowSources, scripts), []);
});

test("fault control: the gate inventory reports an unregistered gate, stale evidence, and a missing guide row", () => {
  const commands = workflowCommands(workflowSources);
  assert.deepEqual(uncoveredGates([...checkScripts(scripts), "check:new-gate"], commands, CI_EQUIVALENTS, ON_DEMAND_CHECKS), ["check:new-gate"]);
  assert.deepEqual(uncoveredGates(["check:sast"], new Set(), {}, {}), ["check:sast"],
    "an equivalent must be registered, not assumed");

  const withoutSemgrep = workflowSources.replace(/semgrep scan --config semgrep\//gu, "semgrep scan");
  assert.notEqual(withoutSemgrep, workflowSources, "the Semgrep step removal must apply");
  assert.deepEqual(staleEvidence(CI_EQUIVALENTS, withoutSemgrep), ["check:sast"],
    "deleting the CI step must invalidate its exception, not preserve the claim");

  const missingRow = guide.replace("`npm run check:complexity`", "`run the complexity gate`");
  assert.notEqual(missingRow, guide, "the guide-row mutation must apply");
  assert.deepEqual(gatesMissingFromGuide(checkScripts(scripts), missingRow), ["check:complexity"]);

  const typoWorkflow = `${workflowSources}\n      - run: npm run check:archt\n`;
  assert.deepEqual(unknownWorkflowCommands(typoWorkflow, scripts), ["check:archt"]);
});

test("package scripts expose on-demand performance entry points", () => {
  assert.deepEqual(Object.fromEntries(["bench", "bench:projection", "profile:cpu", "profile:heap"]
    .map((name) => [name, scripts[name]])), {
    bench: "node scripts/bench.mjs route",
    "bench:projection": "node scripts/bench.mjs projection",
    "profile:cpu": "node scripts/profile.mjs cpu",
    "profile:heap": "node scripts/profile.mjs heap",
  });
});

test("Knip treats Hyperfine as an optional host binary", () => {
  assert.equal(Object.hasOwn(packageManifest.devDependencies, "hyperfine"), false);
  assert.match(knipConfig, /"ignoreBinaries"\s*:\s*\[[\s\S]*?"hyperfine"/u);
});

function assertScopedGitleaksGuidance(text) {
  assert.match(text, /two exact synthetic canary values used by redaction fixtures\s+regardless of file path/u);
  assert.match(text, /additional reviewed fixture values only when their exact test-file paths also match/u);
  assert.match(text, /It does not allowlist whole files or other rules\./u);
}

test("the developer guide describes scoped Gitleaks fixture exceptions", () => {
  assert.match(gitleaksConfig, /id = "generic-api-key"/u);
  assert.match(gitleaksConfig, /condition = "AND"[\s\S]*?regexTarget = "secret"[\s\S]*?paths = /u);
  assertScopedGitleaksGuidance(guide);
});

test("fault control: outdated Gitleaks guidance fails the scoped policy assertion", () => {
  const mutant = guide.replace("additional reviewed fixture values only when their exact test-file paths also match", "other fixture values regardless of file path");
  assert.notEqual(mutant, guide);
  assert.throws(() => assertScopedGitleaksGuidance(mutant), { code: "ERR_ASSERTION" });
  const missingGlobal = guide.replace("two exact synthetic canary values used by redaction fixtures regardless of file path", "some fixture values");
  assert.notEqual(missingGlobal, guide, "the global-canary mutation must apply");
  assert.throws(() => assertScopedGitleaksGuidance(missingGlobal), { code: "ERR_ASSERTION" });
});

test("the developer guide names the committed tool configuration files", () => {
  const paths = [".dependency-cruiser.cjs", "knip.jsonc", "sgconfig.yml", "semgrep/", ".gitleaks.toml", "renovate.json", ".github/workflows/static-analysis.yml"];
  for (const path of paths) {
    assert.equal(guide.includes(path), true, `guide must mention ${path}`);
    assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
  }
});

test("the developer guide describes the full security audit as dispatch-only", () => {
  assert.match(guide, /\[`security-audit\.yml`\]\(\.\.\/\.github\/workflows\/security-audit\.yml\) \| Manual dispatch \|/u);
  assert.match(guide, /The dispatch-only workflow scans\s+everything/u);
  assert.doesNotMatch(guide, /weekly full-history|full scan weekly|Weekly schedule/u);
});

test("the agent guide links to the developer tooling guide", () => {
  const agentGuide = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(agentGuide, /docs\/dev-tooling\.md/u);
  assert.match(agentGuide, /toolbox:doctor/u);
});
