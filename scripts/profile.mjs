#!/usr/bin/env node
/**
 * On-demand CPU and heap profiler.
 *
 * Runs an allowlisted workload under Node's built-in profiler and writes the
 * artifact under the gitignored reports/profiles directory. Open .cpuprofile or
 * .heapprofile files in Chrome DevTools (Performance / Memory profiles).
 *
 * Usage: node scripts/profile.mjs <cpu|heap> [--target route] [--json]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PROFILE_TARGETS = {
  route: {
    description: "Resolve-only router hot loop",
    script: "scripts/perf-workload.mjs",
    args: ["--iterations", "200000"],
    nodeFlags: ["--experimental-strip-types"],
  },
};

const MODES = {
  cpu: { flag: "--cpu-prof", directoryFlag: "--cpu-prof-dir", nameFlag: "--cpu-prof-name", extension: "cpuprofile" },
  heap: { flag: "--heap-prof", directoryFlag: "--heap-prof-dir", nameFlag: "--heap-prof-name", extension: "heapprofile" },
};

export function profilePlan(mode, target, directory) {
  const definition = MODES[mode];
  if (!definition) throw new Error(`Unknown profile mode: ${mode} (expected cpu or heap)`);
  const workload = PROFILE_TARGETS[target];
  if (!workload) throw new Error(`Unknown profile target: ${target}`);
  const name = `${target}-${mode}.${definition.extension}`;
  const artifact = join(directory, name);
  return {
    artifact,
    args: [
      ...workload.nodeFlags,
      definition.flag,
      definition.directoryFlag, directory,
      definition.nameFlag, basename(name),
      join(ROOT, workload.script),
      ...workload.args,
    ],
  };
}

function parseArgs(argv) {
  const options = { mode: undefined, target: "route", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--target") options.target = argv[++index] ?? "";
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown profile flag: ${argument}`);
    else if (options.mode === undefined) options.mode = argument;
    else throw new Error(`Unknown profile argument: ${argument}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/profile.mjs <cpu|heap> [--target route] [--json]",
    "",
    ...Object.entries(PROFILE_TARGETS).map(([name, target]) => `  ${name.padEnd(10)} ${target.description}`),
    "",
    "Artifacts go to reports/profiles/. Open them in Chrome DevTools.",
  ].join("\n");
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    if (!options.mode) {
      console.error(usage());
      return 2;
    }
    if (!Object.hasOwn(MODES, options.mode)) throw new Error(`Unknown profile mode: ${options.mode} (expected cpu or heap)`);
    if (!Object.hasOwn(PROFILE_TARGETS, options.target)) throw new Error(`Unknown profile target: ${options.target}`);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const directory = join(ROOT, "reports", "profiles", `${stamp}-${options.mode}`);
  const plan = profilePlan(options.mode, options.target, directory);
  mkdirSync(directory, { recursive: true });
  const started = Date.now();
  const result = spawnSync(process.execPath, plan.args, { cwd: ROOT, encoding: "utf8" });
  const durationMs = Date.now() - started;
  if (result.status !== 0 || !existsSync(plan.artifact)) {
    const detail = (result.stderr || result.stdout || "").trim().slice(-2000);
    const message = `profiling failed (exit ${result.status ?? 1})${detail ? `\n${detail}` : ""}`;
    if (options.json) console.log(JSON.stringify({ mode: options.mode, target: options.target, status: "failed", exitCode: 1, error: message }));
    else console.error(message);
    return 1;
  }
  const report = {
    mode: options.mode,
    target: options.target,
    status: "captured",
    artifact: plan.artifact,
    durationMs,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${options.mode} profile captured in ${durationMs} ms`);
    console.log(`artifact: ${report.artifact}`);
    console.log("Open it in Chrome DevTools (Performance or Memory profile).");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
