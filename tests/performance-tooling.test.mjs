import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { benchPlan, parseHyperfine } from "../scripts/bench.mjs";
import { profilePlan } from "../scripts/profile.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const guide = readFileSync(join(root, "docs", "dev-tooling.md"), "utf8");

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

test("builds Hyperfine plans for allowlisted workloads", () => {
  const route = benchPlan("route", { runs: 4, warmup: 2, stamp: "stamp" });
  assert.equal(route.artifact.endsWith(join("reports", "bench", "route-stamp.json")), true);
  assert.equal(route.hyperfineArgs.includes("--export-json"), true);
  assert.equal(route.hyperfineArgs.includes("4"), true);
  assert.match(route.hyperfineArgs.at(-1), /perf-workload\.mjs --iterations 200000/u);
  const projection = benchPlan("projection", { runs: 2, warmup: 1, stamp: "stamp" });
  assert.match(projection.hyperfineArgs.at(-1), /provider-projection-benchmark\.mjs/u);
  assert.match(projection.hyperfineArgs.at(-1), /reports[/\\]bench[/\\]projection-stamp\.json/u);
});

test("parses Hyperfine 2 summary and legacy flat reports", () => {
  const modern = parseHyperfine(JSON.stringify({
    results: [{
      command: "node workload",
      summary: { time_wall_clock: { unit: "second", count: 5, mean: 1.25, stddev: 0.1, min: 1.1, max: 1.4 } },
    }],
  }));
  assert.deepEqual(modern, { command: "node workload", runs: 5, meanMs: 1250, stddevMs: 100, minMs: 1100, maxMs: 1400 });
  const legacy = parseHyperfine(JSON.stringify({
    results: [{ command: "node workload", mean: 0.5, stddev: 0.05, min: 0.45, max: 0.6 }],
  }));
  assert.equal(legacy.meanMs, 500);
  assert.equal(legacy.minMs, 450);
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

test("the developer guide names the committed tool configuration files", () => {
  const paths = [".dependency-cruiser.cjs", "knip.jsonc", "sgconfig.yml", "semgrep/", ".gitleaks.toml", "renovate.json", ".github/workflows/static-analysis.yml"];
  for (const path of paths) {
    assert.equal(guide.includes(path), true, `guide must mention ${path}`);
    assert.equal(existsSync(join(root, path)), true, `${path} must exist`);
  }
});

test("the agent guide links to the developer tooling guide", () => {
  const agentGuide = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(agentGuide, /docs\/dev-tooling\.md/u);
  assert.match(agentGuide, /toolbox:doctor/u);
});
